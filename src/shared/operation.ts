/** 仅管理一次异步操作的生命周期；默认期限和失败政策由各调用层决定。 */
export interface OperationOptions {
  abortSignal?: AbortSignal | null;
  timeoutMs?: number;
}

export type OperationResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout' | 'aborted' | 'error'; error?: unknown };

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
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  let settled = false;
  const outcome = new Promise<OperationResult<T>>((resolve) => {
    const finish = (result: OperationResult<T>, cancel = false) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      if (cancel) {
        controller.abort();
      }
    };
    abort = () => finish({ status: 'aborted' }, true);
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    if (Number.isFinite(timeout)) {
      timer = setTimeout(() => finish({ status: 'timeout' }, true), timeout);
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
