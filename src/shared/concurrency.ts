export type LimitFunction = <T>(task: () => T | Promise<T>) => Promise<T>;

export function createLimit(concurrency: number): LimitFunction {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a finite number >= 1, got ${concurrency}`);
  }

  let activeCount = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    activeCount -= 1;
    const next = queue.shift();
    if (next) {
      next();
    }
  };

  return function limit<T>(task: () => T | Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        activeCount += 1;
        Promise.resolve().then(task).then(resolve, reject).finally(runNext);
      };

      if (activeCount < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}
