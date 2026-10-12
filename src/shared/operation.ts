/** 仅管理一次异步操作的生命周期；默认期限和失败政策由各调用层决定。 */
export interface OperationOptions {
  abortSignal?: AbortSignal | null;
  timeoutMs?: number;
}

export type OperationResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout' | 'aborted' | 'error'; error?: unknown };

const MAX_TIMER_MS = 2_147_483_647;

/**
 * 期限取消原因的名字，与 AbortSignal.timeout 产生的 DOMException 同名。
 * 工具层（terminal、code.search）只按 reason.name 区分“期限到达”和“用户/宿主取消”，
 * 所以本模块的超时分支必须用这个名字中止内层 signal，否则运行/阶段期限会被记成 aborted。
 */
const DEADLINE_ABORT_NAME = 'TimeoutError';

/**
 * 判断 signal 是否因期限而中止：已中止且 reason 是 name 为 TimeoutError 的 Error。
 * 覆盖三种来源：runOperation 自身期限、外层 runOperation 期限经父取消原样透传到内层、
 * 以及宿主传入的 AbortSignal.timeout。Node 中 DOMException instanceof Error 为 true。
 * 未中止、默认 AbortError 或任意其他取消原因都返回 false（按用户/宿主取消处理）。
 * 仅供仓内复用（terminal、code.search），不进入公开子路径。
 */
export function isDeadlineAbort(signal?: AbortSignal | null): boolean {
  if (!signal?.aborted) {
    return false;
  }
  return signal.reason instanceof Error && signal.reason.name === DEADLINE_ABORT_NAME;
}

/**
 * 先确定终态再传播取消，避免 cooperative resolve 覆盖 timeout。
 * 不合作的外部代码可能仍运行，但迟到结果/拒绝不会再次结束本次操作。
 */
export async function runOperation<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
  options: OperationOptions = {}
): Promise<OperationResult<T>> {
  if (options.abortSignal?.aborted) {
    return { status: 'aborted' };
  }
  const timeout = options.timeoutMs ?? Infinity;
  if (typeof timeout !== 'number' || Number.isNaN(timeout)) {
    return { status: 'error', error: new Error('Invalid operation timeout') };
  }
  if (timeout <= 0) {
    return { status: 'timeout' };
  }
  const deadlineAt = Date.now() + timeout;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  let settled = false;
  const outcome = new Promise<OperationResult<T>>((resolve) => {
    const finish = (result: OperationResult<T>, cancel = false, reason?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      if (cancel) {
        controller.abort(reason);
      }
    };
    abort = () => finish({ status: 'aborted' }, true, options.abortSignal?.reason);
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    if (Number.isFinite(timeout)) {
      // Node 会把超出32位上限的timer改成1ms；按剩余期限分段，不提前超时或延长期限。
      const scheduleTimeout = () => {
        if (settled) {
          return;
        }
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          // 期限到达：以 TimeoutError 原因中止内层 signal（与 AbortSignal.timeout 对齐），
          // 让下游工具据 isDeadlineAbort 把回执记为 timeout，而不是不带原因时默认的 AbortError(aborted)。
          // 父取消分支仍原样透传父 reason；外层期限透传到嵌套操作时同样保持 TimeoutError。
          finish(
            { status: 'timeout' },
            true,
            new DOMException('Operation deadline exceeded', DEADLINE_ABORT_NAME)
          );
          return;
        }
        timer = setTimeout(scheduleTimeout, Math.min(remaining, MAX_TIMER_MS));
      };
      scheduleTimeout();
    }
    Promise.resolve()
      .then(() => {
        if (!settled) {
          return operation(controller.signal);
        }
        return undefined;
      })
      .then(
        (value) => {
          if (!settled) {
            finish({ status: 'ok', value: value as T });
          }
        },
        (error: unknown) => finish({ status: 'error', error })
      );
  });
  try {
    return await outcome;
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener('abort', abort);
  }
}
