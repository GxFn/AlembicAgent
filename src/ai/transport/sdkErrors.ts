import {
  AISDKError,
  APICallError,
  InvalidArgumentError,
  InvalidPromptError,
  LoadAPIKeyError,
  LoadSettingError,
  NoSuchModelError,
  TooManyEmbeddingValuesForCallError,
  UnsupportedFunctionalityError,
} from '@ai-sdk/provider';

/** SDK 错误只在 adapter 边界转换；可靠性控制器继续消费本仓 status/retryAfterMs。 */
export function normalizeSdkError(err: unknown, provider: string): Error {
  if (
    InvalidArgumentError.isInstance(err) ||
    InvalidPromptError.isInstance(err) ||
    LoadAPIKeyError.isInstance(err) ||
    LoadSettingError.isInstance(err) ||
    NoSuchModelError.isInstance(err) ||
    TooManyEmbeddingValuesForCallError.isInstance(err) ||
    UnsupportedFunctionalityError.isInstance(err)
  ) {
    // 本地 SDK 拒绝尚未发生 HTTP 请求，不能伪造状态码或计为上游服务故障。
    return Object.assign(new Error(`${provider} SDK request rejected (${err.name})`), {
      code: 'LLM_INVALID_REQUEST',
    });
  }
  if (!APICallError.isInstance(err)) {
    if (AISDKError.isInstance(err)) {
      return Object.assign(new Error(`${provider} SDK response rejected (${err.name})`), {
        code: 'LLM_INVALID_RESPONSE',
      });
    }
    return err instanceof Error ? err : new Error('LLM adapter failed', { cause: err });
  }
  if (err.statusCode !== undefined && err.statusCode >= 200 && err.statusCode < 300) {
    // HTTP 成功与模型协议有效是两回事；不能把坏 body 归成空文本成功。
    return Object.assign(
      new Error(`${provider} SDK response validation failed (HTTP ${err.statusCode})`),
      {
        code: 'LLM_INVALID_RESPONSE',
      }
    );
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
