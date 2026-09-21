/** 观察者不是业务提交阶段；失败只做诊断，不重放可能已经完成的副作用。 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

export function observeSafely(operation: () => unknown, onFailure: () => void): void {
  try {
    const result = operation();
    if (isThenable(result)) {
      void Promise.resolve(result).catch(onFailure);
    }
  } catch (err: unknown) {
    void err; // 不把可能含凭据/请求正文的观察者错误写入诊断。
    onFailure();
  }
}
