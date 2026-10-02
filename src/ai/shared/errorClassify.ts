/**
 * errorClassify — LLM 调用错误分类（纯函数）
 *
 * 重试 / 熔断的决策依赖「这个错误是否可重试」「是否网络级错误」「是否服务端错误」
 * 「是否外部主动 abort」；本模块把这套判断收敛为厂商无关的纯函数，避免各层各自重写后漂移。
 *
 * 当前消费者：
 *   - ReliabilityController.run（shared/reliability.ts）：重试、熔断计数与取消识别。
 *   - AiFactory.isGeoOrProviderError：先排除取消与暂时故障，再判断是否触发 provider fallback。
 *
 * 分类阈值是当前的权威口径，可以随错误语义演进修正（修改时同步更新 reliability / AiFactory 测试）。
 * 各「排除类」的理由见 classifyLlmError 内注释：本地输入错误（LLM_INVALID_REQUEST /
 * API_KEY_MISSING）不重试也不熔断；模型输出错误（LLM_INVALID_TOOL_CALL）不熔断；
 * 程序员错误（TypeError 等）不计入熔断；4xx（非 429）是请求本身问题，不熔断。
 */

/** LLM 调用错误的通用形状（不同厂商 SDK / fetch 抛出的错误字段并集）。 */
export interface ClassifiableError {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
  /**
   * 仅作为错误形状说明：classifyLlmError 不读取此字段，
   * 由 ReliabilityController 直接从原始错误读取并计算重试等待。
   */
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
  /** 服务已应答但模型输出不可执行（如工具参数非法）；不重试，也不计入熔断。 */
  isModelOutputError: boolean;
  /** HTTP 状态码（若有）。 */
  status: number;
  /** cause 链上的底层错误码（若有）。 */
  causeCode: string;
}

/** 已知的可重试网络级错误码集合（Node fetch / undici）。 */
const RETRYABLE_NETWORK_CODES = new Set([
  'LLM_NETWORK_ERROR',
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

  const isLocalInputError = e.code === 'LLM_INVALID_REQUEST' || e.code === 'API_KEY_MISSING';
  const isRetryable = !isLocalInputError && (status === 429 || status >= 500 || isNetworkError);

  // 模型输出被本地拒绝（LlmResponseError）：请求已被服务正常处理，坏的是模型给出的内容。
  // 它是模型行为而不是服务可用性信号——计入熔断会让一个模型的坏输出把同 provider 的其他
  // 并发请求一起挡掉。注意与 LLM_INVALID_RESPONSE 区分：后者是响应体不符合协议（上游或
  // 代理返回了坏 body），仍按服务端故障兜底计数。
  const isModelOutputError = !e.status && e.code === 'LLM_INVALID_TOOL_CALL';

  // 程序员错误（TypeError/ReferenceError/SyntaxError/RangeError）是代码 bug，不是服务端
  // 故障，绝不能计入熔断 — 否则一个确定性 bug 连续抛出会把熔断器打开、伪装成「AI 服务中断」。
  const isProgrammerError =
    e.name === 'TypeError' ||
    e.name === 'ReferenceError' ||
    e.name === 'SyntaxError' ||
    e.name === 'RangeError';

  // 客户端错误 (4xx 非 429) 不应触发熔断 — 那是请求本身的问题。无 status 的错误默认按服务端
  // 故障兜底（保留对未知网络错误的检测），但排除上面的程序员错误与模型输出错误。
  const isServerError =
    !isLocalInputError &&
    !isModelOutputError &&
    (isNetworkError || status === 429 || status >= 500 || (!e.status && !isProgrammerError));

  return {
    isAbort,
    isNetworkError,
    isRetryable,
    isServerError,
    isModelOutputError,
    status,
    causeCode,
  };
}
