/**
 * LLMTransport — 纯协议转换层抽象
 *
 * Transport 只负责：
 *   1. 将统一的 TransportRequest 转换为厂商 API 的 HTTP 请求体
 *   2. 发送 HTTP 请求（含认证、超时、重试后中止）
 *   3. 将厂商 API 响应解析为统一的 TransportResponse
 *
 * Transport 不负责：
 *   - 参数校验/过滤 → ParameterGuard (Gateway 层)
 *   - 模型能力查询 → ModelRegistry (Gateway 层)
 *   - 业务逻辑 (上下文窗口管理、工具路由等) → AgentRuntime
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '../../shared/observers.js';
import { runOperation } from '../../shared/operation.js';
import { providerKeyEnv, type ResolvedConnection, resolveConnection } from '../configuration.js';
import type {
  ChatWithToolsResult,
  FunctionCallResult,
  LlmCallOptions,
  TokenUsage,
  ToolSchema,
  UnifiedMessage,
} from '../contracts.js';
import {
  createLlmAbortError,
  createLlmHttpError,
  createMissingApiKeyError,
  throwIfLlmCancelled,
} from '../errors.js';
import type { ProviderId } from '../registry/ModelDefs.js';
import { parseSchemaOutput, prepareStructuredValidation } from '../shared/schemaValidation.js';

// ─── 代理 dispatcher 缓存 ────────────────────────────────
//
// undici ProxyAgent 内部维护连接池，必须按 proxyUrl 复用，否则在长驻 daemon 里
// 每次请求都 new 一个会泄漏 socket / 文件句柄，且无 keep-alive 复用。
// entry 统一保存初始化和借用；失败结果为 null，避免重复 import。
interface ProxyDispatcherEntry {
  dispatcher: unknown | null;
  readonly initialization: Promise<unknown | null>;
  readonly owner: Map<string, ProxyDispatcherEntry>;
  borrowers: number;
  retired: boolean;
}

let proxyDispatcherCache: Map<string, ProxyDispatcherEntry> | null = null;
const MAX_PROXY_DISPATCHER_CACHE_SIZE = 8;

function currentProxyCache(): Map<string, ProxyDispatcherEntry> {
  proxyDispatcherCache ??= new Map();
  return proxyDispatcherCache;
}

function closeProxyDispatcher(dispatcher: unknown | null): void {
  if (!dispatcher || typeof dispatcher !== 'object') {
    return;
  }
  const disposable = dispatcher as { close?: () => unknown; destroy?: () => unknown };
  // undici 的关闭方法返回 Promise；清理失败只影响资源诊断，不能逃逸为未处理拒绝。
  // 诊断只记录错误类名：代理 URL 可能内嵌凭据，关闭错误 message 也可能回显代理地址。
  observeSafely(
    () => (typeof disposable.close === 'function' ? disposable.close() : disposable.destroy?.()),
    (err: unknown) =>
      Logger.getInstance().debug(
        `[LLMTransport] proxy_dispatcher_close_failed reason=${err instanceof Error ? err.name : 'unknown'}; pooled proxy connections may not have been released`
      )
  );
}

function closeRetiredProxyEntry(entry: ProxyDispatcherEntry): void {
  if (entry.retired && entry.borrowers === 0) {
    const dispatcher = entry.dispatcher;
    entry.dispatcher = null;
    closeProxyDispatcher(dispatcher);
  }
}

function retireProxyEntry(entry: ProxyDispatcherEntry): void {
  entry.retired = true;
  closeRetiredProxyEntry(entry);
}

function createProxyEntry(
  initialization: Promise<unknown | null>,
  dispatcher: unknown | null = null,
  borrowers = 0
): ProxyDispatcherEntry {
  return {
    initialization,
    dispatcher,
    borrowers,
    owner: currentProxyCache(),
    retired: false,
  };
}

function cacheProxyEntry(proxyUrl: string, entry: ProxyDispatcherEntry): void {
  const cache = entry.owner;
  const previous = cache.get(proxyUrl);
  cache.delete(proxyUrl);
  cache.set(proxyUrl, entry);
  if (previous) {
    retireProxyEntry(previous);
  }
  while (cache.size > MAX_PROXY_DISPATCHER_CACHE_SIZE) {
    const oldest = cache.entries().next().value;
    if (!oldest) {
      break;
    }
    cache.delete(oldest[0]);
    retireProxyEntry(oldest[1]);
  }
}

export const __testingProxyDispatcherCache = {
  maxSize: MAX_PROXY_DISPATCHER_CACHE_SIZE,
  clear(): void {
    // 原有托管缓存的身份就是生命周期边界；先解绑，再清空并释放旧缓存快照。
    const cache = proxyDispatcherCache;
    proxyDispatcherCache = null;
    const entries = [...(cache?.values() ?? [])];
    cache?.clear();
    for (const entry of entries) {
      retireProxyEntry(entry);
    }
  },
  keys(): string[] {
    return [...(proxyDispatcherCache?.keys() ?? [])];
  },
  set(proxyUrl: string, dispatcher: unknown | null): void {
    cacheProxyEntry(proxyUrl, createProxyEntry(Promise.resolve(dispatcher), dispatcher));
  },
  size(): number {
    return proxyDispatcherCache?.size ?? 0;
  },
};

/**
 * 同步取得借用，再异步初始化；驱逐不能关闭尚在 import→fetch 交接中的 dispatcher。
 * undici 不可用或构造失败时返回 null（缓存，后续直连）。
 */
function borrowProxyDispatcher(proxyUrl: string): ProxyDispatcherEntry {
  const cache = currentProxyCache();
  const cached = cache.get(proxyUrl);
  if (cached) {
    cached.borrowers++;
    cache.delete(proxyUrl);
    cache.set(proxyUrl, cached);
    return cached;
  }
  // 宿主可能以较早的 TS lib 检查公开源码；使用标准 Promise 构造，不要求 ES2024 类型库。
  let resolveInitialization!: (dispatcher: unknown | null) => void;
  let rejectInitialization!: (error: unknown) => void;
  const initialization = new Promise<unknown | null>((resolve, reject) => {
    resolveInitialization = resolve;
    rejectInitialization = reject;
  });
  const entry = createProxyEntry(initialization, null, 1);
  // 借用和共享 entry 必须在首次 await/import 前保留；LRU 只移除缓存拥有权。
  cacheProxyEntry(proxyUrl, entry);
  void (async () => {
    try {
      const undici = await import('undici');
      if (entry.owner !== proxyDispatcherCache) {
        throw createLlmAbortError('Proxy dispatcher cache was cleared during initialization');
      }
      entry.dispatcher = new undici.ProxyAgent(proxyUrl);
      if (entry.owner !== proxyDispatcherCache) {
        throw createLlmAbortError('Proxy dispatcher cache was cleared during initialization');
      }
      return entry.dispatcher;
    } catch (err: unknown) {
      if (entry.owner !== proxyDispatcherCache) {
        // 缓存失效是资源取消，不得以 null 让旧请求绕过配置的代理直连。
        throw createLlmAbortError('Proxy dispatcher cache was cleared during initialization');
      }
      observeSafely(
        () =>
          Logger.getInstance().warn(
            '[LLMTransport] proxy initialization failed; direct fetch fallback',
            {
              reason: err instanceof Error ? err.name : 'unknown',
            }
          ),
        () => undefined
      );
      if (entry.owner !== proxyDispatcherCache) {
        throw createLlmAbortError('Proxy dispatcher cache was cleared during initialization');
      }
      return null;
    }
  })().then(resolveInitialization, rejectInitialization);
  return entry;
}

// ─── NO_PROXY 与 provider 级直连 ─────────────────────────
//
// 代理来源（provider 专属变量、ALEMBIC_AI_PROXY、HTTPS_PROXY 等）只决定“用哪个代理”；
// 是否对某个目标绕过代理由 NO_PROXY/no_proxy 统一决定，对所有代理来源一致生效。
// 匹配语义对齐 undici EnvHttpProxyAgent（Node 全局 fetch 的同源实现），让用户沿用 curl/undici
// 的既有配置习惯：逗号或空白分隔；`*` 表示全部直连；`.example.com` 与 `*.example.com`
// 都匹配 example.com 本身及其子域；`host:port` 只匹配该端口（未写端口的目标按 scheme 默认端口
// 80/443 计）；IP 字面量按字面相等；全部不区分大小写。
// 与 undici 的两处超集差异（只放宽、不收紧）：`*` 作为列表中任一项都视为通配（undici 只认整串为 `*`）；
// 裸 IPv6（如 `::1`）按主机处理并补齐方括号（undici 会把它误拆成 host=`:`、port=1，永不命中）。

/** provider 专属代理变量的显式直连值，取自 PAC 的 DIRECT 关键字；比较时去空白、不区分大小写。 */
const PROVIDER_DIRECT_PROXY_VALUE = 'direct';

const DEFAULT_PORT_BY_PROTOCOL: Readonly<Record<string, number>> = {
  'http:': 80,
  'https:': 443,
};

interface NoProxyEntry {
  /** 已去掉前导 `.`/`*.` 并转小写；IPv6 保持方括号形式，与 URL.host 对齐。 */
  readonly hostname: string;
  /** 0 表示任意端口。 */
  readonly port: number;
}

interface NoProxyRules {
  readonly matchAll: boolean;
  readonly entries: readonly NoProxyEntry[];
}

/** 小写变量优先（与 curl/undici 一致）；空串视为未设置，与本文件其他代理变量的 `||` 约定一致。 */
function readNoProxyRules(): NoProxyRules {
  const raw = process.env.no_proxy || process.env.NO_PROXY || '';
  const entries: NoProxyEntry[] = [];
  let matchAll = false;
  for (const token of raw.split(/[,\s]/)) {
    if (!token) {
      continue;
    }
    if (token === '*') {
      matchAll = true;
      continue;
    }
    entries.push(parseNoProxyEntry(token));
  }
  return { matchAll, entries };
}

function parseNoProxyEntry(token: string): NoProxyEntry {
  // 含两个以上冒号且不带方括号的是裸 IPv6 字面量，不能按 host:port 拆分。
  const colonCount = token.split(':').length - 1;
  if (colonCount >= 2 && !token.startsWith('[')) {
    return { hostname: `[${token.toLowerCase()}]`, port: 0 };
  }
  const parsed = /^(.+):(\d+)$/.exec(token);
  const host = parsed ? parsed[1] : token;
  return {
    hostname: host.replace(/^\*?\./, '').toLowerCase(),
    port: parsed ? Number.parseInt(parsed[2], 10) : 0,
  };
}

interface ProxyTarget {
  readonly hostname: string;
  readonly port: number;
}

/** 解析失败返回 null；调用方保持原代理路由并记录诊断，不在这里吞掉判断。 */
function proxyTargetOf(url: string | URL | Request): ProxyTarget | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url instanceof URL ? url : new URL(url.url);
  } catch (err: unknown) {
    // 相对或非法 URL 无法确定目标主机；错误对象可能回显 URL，因此不透传。
    void err;
    return null;
  }
  // 用 host 去端口而不是 hostname，保证 IPv6 方括号与 undici 的比较形式一致。
  const hostname = parsed.host.replace(/:\d*$/, '').toLowerCase();
  const port = Number.parseInt(parsed.port, 10) || DEFAULT_PORT_BY_PROTOCOL[parsed.protocol] || 0;
  return { hostname, port };
}

function matchesNoProxy(rules: NoProxyRules, target: ProxyTarget): boolean {
  for (const entry of rules.entries) {
    if (entry.port && entry.port !== target.port) {
      continue;
    }
    if (target.hostname === entry.hostname || target.hostname.endsWith(`.${entry.hostname}`)) {
      return true;
    }
  }
  return false;
}

/** 代理路由诊断：只记录 provider、目标主机与原因，绝不记录代理 URL（可能内嵌凭据）或请求路径。 */
function logProxyRouting(message: string): void {
  observeSafely(
    () => Logger.getInstance().debug(`[LLMTransport] ${message}`),
    () => undefined
  );
}

/**
 * 已解析出代理时判断本次目标是否按 NO_PROXY 直连。
 * 模块私有函数而非类成员：LLMTransport 是公开导出类，不扩展其 protected/私有声明面。
 * 未配置 NO_PROXY 时静默返回 false（原有代理路径，不逐请求刷日志）。
 */
function bypassesProxyForTarget(providerId: string, url: string | URL | Request): boolean {
  const rules = readNoProxyRules();
  if (rules.matchAll) {
    // `*` 不依赖目标解析，相对 URL 也直连；仍记录可解析出的主机便于定位。
    const target = proxyTargetOf(url);
    logProxyRouting(
      `proxy_bypassed provider=${providerId} host=${target?.hostname ?? 'unparsed'} reason=no_proxy match=*`
    );
    return true;
  }
  if (rules.entries.length === 0) {
    return false;
  }
  const target = proxyTargetOf(url);
  if (!target) {
    // 无法确定目标主机时保持原代理路由（与修复前一致），只记录原因而不记录 URL。
    logProxyRouting(
      `proxy_not_bypassed provider=${providerId} reason=unparsed_target; NO_PROXY not evaluated, proxy kept`
    );
    return false;
  }
  if (matchesNoProxy(rules, target)) {
    logProxyRouting(
      `proxy_bypassed provider=${providerId} host=${target.hostname} reason=no_proxy port=${target.port}; direct fetch without proxy dispatcher`
    );
    return true;
  }
  logProxyRouting(
    `proxy_not_bypassed provider=${providerId} host=${target.hostname} reason=no_proxy_miss port=${target.port} entries=${rules.entries.length}; proxy kept`
  );
  return false;
}

/**
 * 2xx 坏正文与 SDK 路径（sdkErrors 的 2xx 分支）同语义：code=LLM_INVALID_RESPONSE、不带 status，
 * 因而计入熔断但不重试。错误消息和诊断都不拼接正文或 URL，只记录 provider、状态码、content-type 与失败类别。
 * 模块私有函数而非类成员：LLMTransport 是公开导出类，不扩展其 protected 面。
 */
function invalidResponseBodyError(
  providerId: string,
  res: Response,
  reason: 'invalid_json' | 'not_object'
): Error {
  const contentType = (res.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .replace(/[^\w.+/-]+/g, '_')
    .slice(0, 80);
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[LLMTransport] invalid_response_body provider=${providerId} status=${res.status} contentType=${contentType || 'none'} reason=${reason}; body withheld, classified LLM_INVALID_RESPONSE`
      ),
    () => undefined
  );
  return Object.assign(
    new Error(`${providerId} response body is not a JSON object (HTTP ${res.status})`),
    { code: 'LLM_INVALID_RESPONSE' }
  );
}

// ─── Transport Request ──────────────────────────────────

export interface TransportRequest {
  model: string;
  messages: UnifiedMessage[];
  systemPrompt?: string;

  tools?: ToolSchema[];
  toolChoice?: string;

  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;

  responseFormat?: 'text' | 'json';
  /** JSON Schema — 供原生结构化输出（如 Gemini responseSchema）做服务端校验。 */
  schema?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

// ─── Transport Response ─────────────────────────────────

/** 保留公开的 Transport 名称，字段由消息/结果共同使用的 AI 合同定义。 */
export type TransportFunctionCall = FunctionCallResult;

export interface TransportResponse extends ChatWithToolsResult {
  /** Transport 明确报告已知用量或 null；Facade 继续兼容缺省 usage 的旧实现。 */
  usage: TokenUsage | null;
}

// ─── Transport Config ───────────────────────────────────

export interface TransportConfig {
  /** undefined 继承环境，空字符串显式禁止 ambient key 回填。 */
  apiKey?: string;
  baseUrl?: string;
  embedModel?: string;
  apiStyle?: string;
  reasoningEffort?: string;
  timeout?: number;
  /** Provider-specific extensions (e.g. DeepSeek reasoningEffort default) */
  [key: string]: unknown;
}

// ─── Abstract Transport ─────────────────────────────────

export abstract class LLMTransport {
  readonly providerId: ProviderId;
  protected readonly settings: ResolvedConnection;
  protected apiKey: string;
  protected baseUrl: string;
  protected timeout: number;

  constructor(providerId: ProviderId, config: TransportConfig) {
    this.providerId = providerId;
    this.settings = resolveConnection(providerId, config);
    this.apiKey = this.settings.apiKey;
    this.baseUrl = this.settings.baseUrl;
    this.timeout = config.timeout ?? 120_000;
  }

  abstract chatWithTools(request: TransportRequest): Promise<TransportResponse>;

  abstract chat(request: TransportRequest): Promise<string>;

  /** 单次 embedding HTTP 尝试的上限；Gateway 据此把重试限定在未完成批次。 */
  get maxEmbeddingBatchSize(): number {
    return Infinity;
  }

  /** embed 能力，不支持的 Transport 返回空数组 */
  async embed(_texts: string[], opts: LlmCallOptions = {}): Promise<number[][]> {
    throwIfLlmCancelled(opts.abortSignal);
    return [];
  }

  /** 带 JSON 格式约束的 chat */
  async chatStructured(request: TransportRequest): Promise<unknown> {
    throwIfLlmCancelled(request.abortSignal);
    const validate = prepareStructuredValidation(request.schema, (_level, message) =>
      Logger.getInstance().warn(message)
    );
    if (!validate) {
      return null;
    }
    const text = await this.chat({ ...request, responseFormat: 'json' });
    if (!text) {
      return null;
    }
    if (request.schema !== undefined) {
      return parseSchemaOutput(text, validate, (_level, message) =>
        Logger.getInstance().warn(message)
      );
    }
    try {
      const value: unknown = JSON.parse(text);
      return validate(value) ? value : null;
    } catch (err: unknown) {
      Logger.getInstance().warn(
        `[structured-output] parse_failed provider=${this.providerId} kind=${err instanceof SyntaxError ? 'invalid_json' : 'validation_error'}; result rejected`
      );
      return null;
    }
  }

  // ─── Shared HTTP utilities ──────────────────────────────

  /**
   * 解析当前 provider 应使用的代理 URL。
   *
   * 历史背景：薄壳化前，代理感知逻辑位于 `AiProvider._resolveProxyUrl` / `_fetch`；
   * 请求统一改走 Transport 后，必须在此处保留同等的代理解析，否则依赖
   * `HTTPS_PROXY` 等环境变量访问境外 API 的部署会直连失败（功能回归）。
   *
   * 优先级：provider 专属变量（ALEMBIC_<PROVIDER>_PROXY_HTTPS/HTTP）
   *   ＞ 通用 ALEMBIC_AI_PROXY ＞ 标准 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY。
   *
   * providerId 与环境变量 tag 映射：openai→OPENAI、deepseek→DEEPSEEK、
   *   claude→CLAUDE、google→GOOGLE、ollama→OLLAMA。
   *
   * provider 专属变量取值为 `direct`（去空白、不区分大小写）时表示该 provider 显式直连：
   * 返回空串且不再回落到通用代理变量（空串本身仍表示“未设置”，会继续回落）。
   * 目标主机级别的绕过（NO_PROXY）在 fetchWithProxy 中按请求 URL 判断，不在这里处理。
   */
  protected resolveProxyUrl(): string {
    const tag = (this.providerId || '').toUpperCase();
    if (tag) {
      const httpsKey = `ALEMBIC_${tag}_PROXY_HTTPS`;
      const httpKey = `ALEMBIC_${tag}_PROXY_HTTP`;
      const httpsValue = process.env[httpsKey];
      const source = httpsValue ? httpsKey : httpKey;
      const specific = httpsValue || process.env[httpKey];
      if (specific) {
        if (specific.trim().toLowerCase() === PROVIDER_DIRECT_PROXY_VALUE) {
          // 显式直连短路：跳过 ALEMBIC_AI_PROXY 与标准代理变量，只记录来源变量名而不记录取值。
          logProxyRouting(
            `proxy_bypassed provider=${this.providerId} reason=provider_direct source=${source}; generic proxy variables skipped`
          );
          return '';
        }
        return specific;
      }
    }
    return (
      process.env.ALEMBIC_AI_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy ||
      ''
    );
  }

  protected async post(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    externalSignal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.runRequest(async (signal) => {
      const res = await this.fetchWithProxy(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const err = createLlmHttpError(this.providerId, {
          status: res.status,
          responseHeaders: Object.fromEntries(res.headers),
        });
        // HTTP 事实已确认；释放失败响应体，但清理拒绝/悬挂不能覆盖它或泄露正文。
        observeSafely(
          () => res.body?.cancel(),
          () => undefined
        );
        throw err;
      }

      // 先读完正文再单独解析：读流失败（连接中断等）仍按原网络错误上抛并保留其分类，
      // 只有“2xx 但正文不是 JSON 对象”才归为上游坏 body。
      const text = await res.text();
      let parsed: unknown;
      let invalidReason: 'invalid_json' | 'not_object' | undefined;
      try {
        parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          invalidReason = 'not_object';
        }
      } catch (err: unknown) {
        // 任何解析失败都表示正文不是 JSON。原生 SyntaxError 的 message 会带出正文片段，
        // 且按类名会被误判为程序员错误；因此不透传、不记录它，只保留失败类别并在下方打诊断。
        void err;
        invalidReason = 'invalid_json';
      }
      if (invalidReason !== undefined) {
        throw invalidResponseBodyError(this.providerId, res, invalidReason);
      }
      return parsed as Record<string, unknown>;
    }, externalSignal);
  }

  /** 单次 HTTP/SDK 请求的共同期限；取消先确定终态，迟到 body 不得复活调用。 */
  protected async runRequest<T>(
    operation: (signal: AbortSignal) => PromiseLike<T>,
    externalSignal?: AbortSignal
  ): Promise<T> {
    const outcome = await runOperation(operation, {
      abortSignal: externalSignal,
      timeoutMs: this.timeout,
    });
    if (outcome.status === 'ok') {
      return outcome.value;
    }
    if (outcome.status === 'aborted') {
      throw createLlmAbortError(externalSignal?.reason);
    }
    if (outcome.status === 'timeout') {
      throw Object.assign(new Error(`Provider request timed out after ${this.timeout}ms`), {
        code: 'ETIMEDOUT',
      });
    }
    throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
  }

  /**
   * 代理感知的 fetch — 检测到代理时通过 dispatcher 走 undici ProxyAgent，否则直连。
   *
   * 关键点：始终调用全局 `fetch`（Node >=22 的全局 fetch 即 undici 实现，
   * 原生支持 `dispatcher` 选项）。这样既能让代理生效，又不会绕过测试里
   * `vi.stubGlobal('fetch')` 的桩——避免“环境带 HTTPS_PROXY 时单测被绕过”的回归。
   * ProxyAgent 按 proxyUrl 缓存复用，避免每请求新建导致的 socket 泄漏。
   * 解析出代理后先按目标 host/port 匹配 NO_PROXY/no_proxy；命中时直连且不借用 ProxyAgent，
   * 因此缓存、借用与退役逻辑只作用于真正走代理的请求。
   */
  protected async fetchWithProxy(
    url: string | URL | Request,
    options: RequestInit = {}
  ): Promise<Response> {
    throwIfLlmCancelled(options.signal);
    const proxyUrl = this.resolveProxyUrl();
    if (proxyUrl && bypassesProxyForTarget(this.providerId, url)) {
      return fetch(url, options);
    }
    if (proxyUrl) {
      const entry = borrowProxyDispatcher(proxyUrl);
      try {
        const dispatcher = await entry.initialization;
        throwIfLlmCancelled(options.signal);
        if (entry.owner !== proxyDispatcherCache) {
          throw createLlmAbortError('Proxy dispatcher cache was cleared before fetch');
        }
        // 必须 await fetch 后再释放借用；undici.close 对已经 dispatch 的响应体仍是优雅关闭。
        return await fetch(url, dispatcher ? ({ ...options, dispatcher } as RequestInit) : options);
      } finally {
        entry.borrowers--;
        closeRetiredProxyEntry(entry);
      }
    }
    return fetch(url, options);
  }

  protected requireApiKey(label: string): void {
    if (!this.apiKey) {
      throw createMissingApiKeyError(label, providerKeyEnv(this.providerId), this.providerId);
    }
  }
}
