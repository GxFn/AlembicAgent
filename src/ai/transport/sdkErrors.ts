import { AISDKError, APICallError } from '@ai-sdk/provider';

/** SDK 错误只在 adapter 边界转换；可靠性控制器继续消费本仓 status/retryAfterMs。 */
export function normalizeSdkError(err: unknown, provider: string): Error {
  if (!APICallError.isInstance(err)) {
    if (AISDKError.isInstance(err)) {
      return Object.assign(new Error(`${provider} SDK response rejected (${err.name})`), {
        code: 'LLM_INVALID_RESPONSE',
      });
    }
    return err instanceof Error ? err : new Error('LLM adapter failed', { cause: err });
  }
  const headers = err.responseHeaders ?? {};
  let retryAfterMs: number | undefined;
  const milliseconds = Number(headers['retry-after-ms']);
  if (headers['retry-after-ms'] !== undefined && Number.isFinite(milliseconds)) {
    retryAfterMs = Math.max(0, milliseconds);
  } else if (headers['retry-after']) {
    const seconds = Number(headers['retry-after']);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(headers['retry-after']) - Date.now();
    if (Number.isFinite(delay)) {
      retryAfterMs = Math.max(0, delay);
    }
  }
  // 不把包含 URL、凭据或响应 body 的 SDK message 复制进普通日志。
  return Object.assign(
    new Error(
      `${provider} API request failed${err.statusCode ? ` (HTTP ${err.statusCode})` : ''}`,
      { cause: new Error(err.name) }
    ),
    {
      status: err.statusCode,
      retryAfterMs,
      code: err.statusCode === undefined && err.isRetryable ? 'LLM_NETWORK_ERROR' : 'LLM_API_ERROR',
    }
  );
}
