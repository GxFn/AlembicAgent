/**
 * errorClassify — LLM 调用错误分类（纯函数）
 *
 * 背景：重试 / 熔断的决策依赖「这个错误是否可重试」「是否网络级错误」「是否服务端错误」
 * 「是否外部主动 abort」。这套判断历史上内联在 AiProvider._withRetry 里，Gateway 层
 * 想做重试时无从复用，只能重写，必然漂移。
 *
 * 本模块把分类逻辑抽成厂商无关的纯函数，供 Provider 与 Gateway 共用。
 * 行为从 AiProvider._withRetry 逐字迁移，不改变任何判定阈值。
 */

/** LLM 调用错误的通用形状（不同厂商 SDK / fetch 抛出的错误字段并集）。 */
export interface ClassifiableError {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  cause?: { code?: string; message?: string; name?: string };
}

/** 分类结果。 */
export interface ErrorClassification {
  /** 外部主动中止（AbortController），绝不重试。 */
  isAbort: boolean;
  /** 网络级错误：无 HTTP status，底层连接失败。 */
  isNetworkError: boolean;
  /** 是否值得重试：429 / 5xx / 网络错误。 */
  isRetryable: boolean;
  /** 是否服务端错误（用于熔断计数）：网络错误 / 429 / 5xx / 无 status。 */
  isServerError: boolean;
  /** HTTP 状态码（若有）。 */
  status: number;
  /** cause 链上的底层错误码（若有）。 */
  causeCode: string;
}

/** 已知的可重试网络级错误码集合（Node fetch / undici）。 */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNABORTED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * 对 LLM 调用错误做统一分类。
 *
 * @param err 任意抛出的错误对象
 * @returns 结构化分类结果
 */
export function classifyLlmError(err: unknown): ErrorClassification {
  const e = (err ?? {}) as ClassifiableError;
  const status = e.status ?? 0;
  const causeCode = e.cause?.code || '';

  // AbortError — 外部主动中止（如 hard timeout），不重试直接抛出
  const isAbort = e.name === 'AbortError' || e.cause?.name === 'AbortError';

  // 网络级错误：无 HTTP status，底层连接失败
  const isNetworkError =
    !e.status &&
    (e.message === 'fetch failed' ||
      RETRYABLE_NETWORK_CODES.has(e.code || '') ||
      RETRYABLE_NETWORK_CODES.has(causeCode));

  const isRetryable = status === 429 || status >= 500 || isNetworkError;

  // 程序员错误（TypeError/ReferenceError/SyntaxError/RangeError）是代码 bug，不是服务端
  // 故障，绝不能计入熔断 — 否则一个确定性 bug 连续抛出会把熔断器打开、伪装成「AI 服务中断」。
  const isProgrammerError =
    e.name === 'TypeError' ||
    e.name === 'ReferenceError' ||
    e.name === 'SyntaxError' ||
    e.name === 'RangeError';

  // 客户端错误 (4xx 非 429) 不应触发熔断 — 那是请求本身的问题。无 status 的错误默认按服务端
  // 故障兜底（保留对未知网络错误的检测），但排除上面的程序员错误类型。
  const isServerError =
    isNetworkError || status === 429 || status >= 500 || (!e.status && !isProgrammerError);

  return { isAbort, isNetworkError, isRetryable, isServerError, status, causeCode };
}
