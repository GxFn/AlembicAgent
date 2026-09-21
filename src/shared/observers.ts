/** 观察者不是业务提交阶段；失败只做诊断，不重放可能已经完成的副作用。 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

export function observeSafely(
  operation: () => unknown,
  onFailure: (error: unknown) => unknown
): void {
  const report = (error: unknown) => {
    try {
      const result = onFailure(error);
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch (err: unknown) {
      // 诊断通道自身失败时不能递归报告，也不能把观察失败升级为业务失败。
      void err;
    }
  };
  try {
    const result = operation();
    if (isThenable(result)) {
      void Promise.resolve(result).catch(report);
    }
  } catch (err: unknown) {
    report(err); // 是否记录错误内容由调用方决定，本层不写入潜在凭据/请求正文。
  }
}
