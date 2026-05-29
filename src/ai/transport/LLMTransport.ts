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

import {
  createMissingApiKeyError,
  type TokenUsage,
  type ToolSchema,
  type UnifiedMessage,
} from '../AiProvider.js';
import type { ProviderId } from '../registry/model-defs.js';

// ─── 代理 dispatcher 缓存 ────────────────────────────────
//
// undici ProxyAgent 内部维护连接池，必须按 proxyUrl 复用，否则在长驻 daemon 里
// 每次请求都 new 一个会泄漏 socket / 文件句柄，且无 keep-alive 复用。
// 用 null 缓存“已尝试但 undici 不可用 / 代理初始化失败”的结果，避免重复 import。
const proxyDispatcherCache = new Map<string, unknown | null>();

/**
 * 解析（并缓存）指定 proxyUrl 对应的 undici ProxyAgent dispatcher。
 * undici 不可用或构造失败时返回 null（缓存，后续直连）。
 */
async function getProxyDispatcher(proxyUrl: string): Promise<unknown | null> {
  if (proxyDispatcherCache.has(proxyUrl)) {
    return proxyDispatcherCache.get(proxyUrl) ?? null;
  }
  try {
    const undici = await import('undici');
    const dispatcher = new undici.ProxyAgent(proxyUrl);
    proxyDispatcherCache.set(proxyUrl, dispatcher);
    return dispatcher;
  } catch {
    proxyDispatcherCache.set(proxyUrl, null);
    return null;
  }
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

export interface TransportFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface TransportResponse {
  text: string | null;
  functionCalls: TransportFunctionCall[] | null;
  usage: TokenUsage | null;
  reasoningContent?: string | null;
  /** Provider stop reason，例如 Chat Completions choice.finish_reason */
  finishReason?: string | null;
}

// ─── Transport Config ───────────────────────────────────

export interface TransportConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  /** Provider-specific extensions (e.g. DeepSeek reasoningEffort default) */
  [key: string]: unknown;
}

// ─── Abstract Transport ─────────────────────────────────

export abstract class LLMTransport {
  readonly providerId: ProviderId;
  protected apiKey: string;
  protected baseUrl: string;
  protected timeout: number;

  constructor(providerId: ProviderId, config: TransportConfig) {
    this.providerId = providerId;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || '';
    this.timeout = config.timeout ?? 120_000;
  }

  abstract chatWithTools(request: TransportRequest): Promise<TransportResponse>;

  abstract chat(request: TransportRequest): Promise<string>;

  /** embed 能力，不支持的 Transport 返回空数组 */
  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  }

  /** 带 JSON 格式约束的 chat */
  async chatStructured(request: TransportRequest): Promise<unknown> {
    const text = await this.chat({ ...request, responseFormat: 'json' });
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.text();
          const parsed = JSON.parse(errBody);
          detail = parsed?.error?.message || errBody.slice(0, 300);
        } catch {
          /* best effort */
        }
        const err = Object.assign(
          new Error(`${this.providerId} API error: ${res.status}${detail ? ` — ${detail}` : ''}`),
          { status: res.status }
        );
        throw err;
      }

      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * 代理感知的 fetch — 检测到代理时通过 dispatcher 走 undici ProxyAgent，否则直连。
   *
   * 关键点：始终调用全局 `fetch`（Node >=22 的全局 fetch 即 undici 实现，
   * 原生支持 `dispatcher` 选项）。这样既能让代理生效，又不会绕过测试里
   * `vi.stubGlobal('fetch')` 的桩——避免“环境带 HTTPS_PROXY 时单测被绕过”的回归。
   * ProxyAgent 按 proxyUrl 缓存复用，避免每请求新建导致的 socket 泄漏。
   */
  async #fetch(url: string, options: Record<string, unknown> = {}): Promise<Response> {
    const proxyUrl = this.resolveProxyUrl();
    if (proxyUrl) {
      const dispatcher = await getProxyDispatcher(proxyUrl);
      if (dispatcher) {
        // dispatcher 不在标准 RequestInit 类型里，但全局 fetch（undici）运行时识别。
        return fetch(url, { ...options, dispatcher } as RequestInit);
      }
    }
    return fetch(url, options as RequestInit);
  }

  protected requireApiKey(label: string): void {
    if (!this.apiKey) {
      throw createMissingApiKeyError(label, providerEnvVar(this.providerId), this.providerId);
    }
  }
}

function providerEnvVar(providerId: ProviderId): string {
  switch (providerId) {
    case 'openai':
      return 'ALEMBIC_OPENAI_API_KEY';
    case 'deepseek':
      return 'ALEMBIC_DEEPSEEK_API_KEY';
    case 'claude':
      return 'ALEMBIC_CLAUDE_API_KEY';
    case 'google':
      return 'ALEMBIC_GOOGLE_API_KEY';
    case 'ollama':
      return 'ALEMBIC_OLLAMA_API_KEY';
  }
}
