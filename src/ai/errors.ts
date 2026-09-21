/** AI 边界错误：不装配 provider、不读取凭据，供各层统一识别。 */

import type { TokenUsage } from './contracts.js';

/** 模型已完成请求但输出不可执行；保留已知用量，禁止把坏参数编造成空对象。 */
export class LlmResponseError extends Error {
  readonly code = 'LLM_INVALID_TOOL_CALL';
  constructor(
    message: string,
    readonly usage: TokenUsage | null = null
  ) {
    super(message);
    this.name = 'LlmResponseError';
  }
}

/** Provider 缺 key 统一错误；只给 host-neutral 元数据，具体 UI 指引由宿主渲染。 */
export interface MissingApiKeyError extends Error {
  code: 'API_KEY_MISSING';
  provider: string;
  envVar: string;
  hostAction: 'configure-provider-credential';
}

export function createMissingApiKeyError(
  label: string,
  envVar: string,
  provider: string
): MissingApiKeyError {
  const err = new Error(
    `${label} API Key 未配置。请在宿主环境或 Alembic 运行配置中设置 ${envVar}。`
  ) as MissingApiKeyError;
  err.code = 'API_KEY_MISSING';
  err.provider = provider;
  err.envVar = envVar;
  err.hostAction = 'configure-provider-credential';
  return err;
}

/** HTTP 事实的安全投影：只保留状态/退避信息，不携带 URL、凭据或响应正文。 */
export function createLlmHttpError(
  provider: string,
  {
    status,
    responseHeaders = {},
    retryableNetwork = false,
    causeName,
  }: {
    status?: number;
    responseHeaders?: Readonly<Record<string, string>>;
    retryableNetwork?: boolean;
    causeName?: string;
  }
) {
  let retryAfterMs: number | undefined;
  const milliseconds = Number(responseHeaders['retry-after-ms']);
  if (responseHeaders['retry-after-ms'] !== undefined && Number.isFinite(milliseconds)) {
    retryAfterMs = Math.max(0, milliseconds);
  } else if (responseHeaders['retry-after']) {
    const seconds = Number(responseHeaders['retry-after']);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(responseHeaders['retry-after']) - Date.now();
    if (Number.isFinite(delay)) {
      retryAfterMs = Math.max(0, delay);
    }
  }
  return Object.assign(
    new Error(
      `${provider} API request failed${status ? ` (HTTP ${status})` : ''}`,
      causeName ? { cause: new Error(causeName) } : undefined
    ),
    {
      status,
      retryAfterMs,
      code: status === undefined && retryableNetwork ? 'LLM_NETWORK_ERROR' : 'LLM_API_ERROR',
    }
  );
}

export function createLlmAbortError(reason?: unknown): Error & { code?: string } {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason;
  }
  // 宿主可以用任意 Error 取消；保留 cause，而不能把其原 name 当作服务端故障。
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Operation aborted';
  const err = new Error(message, { cause: reason }) as Error & { code?: string };
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

/** 取消必须穿过兼容降级边界，不能被转成空向量或探活失败。 */
export function throwIfLlmCancelled(signal?: AbortSignal | null, err?: unknown): void {
  if (signal?.aborted) {
    throw createLlmAbortError(signal.reason);
  }
  if (
    err instanceof Error &&
    (err.name === 'AbortError' || (err.cause instanceof Error && err.cause.name === 'AbortError'))
  ) {
    throw createLlmAbortError(err);
  }
}
