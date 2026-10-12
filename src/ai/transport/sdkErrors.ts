import {
  AISDKError,
  APICallError,
  InvalidArgumentError,
  InvalidPromptError,
  LoadAPIKeyError,
  LoadSettingError,
  NoSuchModelError,
  TooManyEmbeddingValuesForCallError,
  TypeValidationError,
  UnsupportedFunctionalityError,
} from '@ai-sdk/provider';
import Logger from '@alembic/core/logging';
import { observeSafely } from '../../shared/observers.js';
import { createLlmHttpError } from '../errors.js';

type SdkErrorKind = 'request_rejected' | 'response_rejected' | 'response_validation_failed';

/**
 * 诊断字段只允许单个安全 token：SDK 的类名、参数名、能力名、字段路径都是 SDK/schema 给出的标识，
 * 但仍可能带空白或换行；统一压成一个 token 并截断，防止日志行被伪造或撑爆。
 */
function diagnosticToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  return value.replace(/[^\w.:/[\]-]+/g, '_').slice(0, 120);
}

/** TypeValidationError 只取字段路径与实体名；value、entityId 与 cause.message 可能含响应正文或 prompt。 */
function validationContextFields(err: unknown): Array<[string, unknown]> {
  if (!TypeValidationError.isInstance(err)) {
    return [];
  }
  return [
    ['field', err.context?.field],
    ['entity', err.context?.entityName],
  ];
}

/**
 * 错误归类分叉的结构化诊断。
 * 归一化后的错误故意不挂原始 SDK 错误为 cause：reliability 首次失败日志会打印 cause.message，
 * 而 InvalidPromptError/TypeValidationError/APICallError 的 message 可能包含 prompt、响应正文或 URL。
 * 因此这里只记录安全标量字段，排障时用它定位是哪个参数、能力或字段触发了拒绝。
 */
function logSdkErrorNormalized(
  provider: string,
  kind: SdkErrorKind,
  code: string,
  err: AISDKError,
  extra: Array<[string, unknown]>
): void {
  const fields: Array<[string, unknown]> = [
    ['provider', provider],
    ['kind', kind],
    ['code', code],
    ['error', err.name],
    ...extra,
  ];
  const rendered = fields
    .map(([key, value]) => {
      const token = typeof value === 'number' ? String(value) : diagnosticToken(value);
      return token === undefined ? '' : `${key}=${token}`;
    })
    .filter(Boolean)
    .join(' ');
  // 诊断通道失败不能覆盖正在归一化的业务错误。
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[ai-sdk] sdk_error_normalized ${rendered}; raw SDK message withheld`
      ),
    () => undefined
  );
}

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
    logSdkErrorNormalized(provider, 'request_rejected', 'LLM_INVALID_REQUEST', err, [
      ['argument', InvalidArgumentError.isInstance(err) ? err.argument : undefined],
      [
        'functionality',
        UnsupportedFunctionalityError.isInstance(err) ? err.functionality : undefined,
      ],
    ]);
    return Object.assign(new Error(`${provider} SDK request rejected (${err.name})`), {
      code: 'LLM_INVALID_REQUEST',
    });
  }
  if (!APICallError.isInstance(err)) {
    if (AISDKError.isInstance(err)) {
      // 响应已到达但 SDK 拒绝解析/校验；按 LLM_INVALID_RESPONSE 计入熔断（与兼容 POST 路径一致）。
      logSdkErrorNormalized(
        provider,
        'response_rejected',
        'LLM_INVALID_RESPONSE',
        err,
        validationContextFields(err)
      );
      return Object.assign(new Error(`${provider} SDK response rejected (${err.name})`), {
        code: 'LLM_INVALID_RESPONSE',
      });
    }
    return err instanceof Error ? err : new Error('LLM adapter failed', { cause: err });
  }
  if (err.statusCode !== undefined && err.statusCode >= 200 && err.statusCode < 300) {
    // HTTP 成功与模型协议有效是两回事；不能把坏 body 归成空文本成功。
    // 嵌套 cause 只取类名（区分 JSON 解析失败与 schema 不符）和校验字段路径，不取 message/value。
    const cause: unknown = err.cause;
    logSdkErrorNormalized(provider, 'response_validation_failed', 'LLM_INVALID_RESPONSE', err, [
      ['status', err.statusCode],
      ['cause', cause instanceof Error ? cause.name : undefined],
      ...validationContextFields(cause),
    ]);
    return Object.assign(
      new Error(`${provider} SDK response validation failed (HTTP ${err.statusCode})`),
      {
        code: 'LLM_INVALID_RESPONSE',
      }
    );
  }
  // 不把包含 URL、凭据或响应 body 的 SDK message 复制进普通日志。
  return createLlmHttpError(provider, {
    status: err.statusCode,
    responseHeaders: err.responseHeaders,
    retryableNetwork: err.isRetryable,
    causeName: err.name,
  });
}
