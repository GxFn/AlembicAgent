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
  observeSafely(
    () => (typeof disposable.close === 'function' ? disposable.close() : disposable.destroy?.()),
    () => undefined
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
   */
  protected resolveProxyUrl(): string {
    const tag = (this.providerId || '').toUpperCase();
    if (tag) {
      const specific =
        process.env[`ALEMBIC_${tag}_PROXY_HTTPS`] || process.env[`ALEMBIC_${tag}_PROXY_HTTP`];
      if (specific) {
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

      return (await res.json()) as Record<string, unknown>;
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
   */
  protected async fetchWithProxy(
    url: string | URL | Request,
    options: RequestInit = {}
  ): Promise<Response> {
    throwIfLlmCancelled(options.signal);
    const proxyUrl = this.resolveProxyUrl();
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
