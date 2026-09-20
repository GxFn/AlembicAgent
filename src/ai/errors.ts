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
