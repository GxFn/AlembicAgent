import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReliabilityController } from '../src/ai/shared/reliability.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function serviceFailure(status = 503) {
  return Object.assign(new Error('fixture service failure'), { status });
}

describe('ReliabilityController admission and recovery', () => {
  it('rechecks the circuit after a queued request receives its slot', async () => {
    const controller = new ReliabilityController({
      maxConcurrency: 1,
      maxRetries: 0,
      circuitThreshold: 1,
    });
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<string>();
    const firstResult = controller
      .run(() => {
        started.resolve();
        return first.promise;
      })
      .catch((error) => error);
    await started.promise;
    const execute = vi.fn(async () => 'must not run');
    const queued = controller.run(execute).catch((error) => error);
    first.reject(serviceFailure());
    await firstResult;
    expect(await queued).toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(execute).not.toHaveBeenCalled();
    expect(controller.activeRequests).toBe(0);
  });

  it('applies a rate limit published while the next request was queued', async () => {
    vi.useFakeTimers();
    const controller = new ReliabilityController({
      maxConcurrency: 1,
      maxRetries: 0,
      circuitThreshold: 5,
    });
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<string>();
    const firstResult = controller
      .run(
        () => {
          started.resolve();
          return first.promise;
        },
        0,
        1
      )
      .catch((error) => error);
    await started.promise;
    const execute = vi.fn(async () => 'next');
    const queued = controller.run(execute);
    await vi.advanceTimersByTimeAsync(0);
    first.reject(Object.assign(serviceFailure(429), { retryAfterMs: 10_000 }));
    await firstResult;
    await vi.advanceTimersByTimeAsync(9999);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await queued).toBe('next');
    expect(controller.activeRequests).toBe(0);
  });

  it('honors an extension to an already active rate-limit wait', async () => {
    vi.useFakeTimers();
    const controller = new ReliabilityController({ maxRetries: 0 });
    controller.setRateLimitWindow(100);
    const execute = vi.fn(async () => 'ready');
    const pending = controller.run(execute);
    await vi.advanceTimersByTimeAsync(50);
    controller.setRateLimitWindow(200);
    await vi.advanceTimersByTimeAsync(199);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('ready');
  });

  it('releases the HTTP slot during retry backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const controller = new ReliabilityController({ maxConcurrency: 1, maxRetries: 1 });
    const order: string[] = [];
    const operation = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push('first');
        throw serviceFailure();
      })
      .mockImplementationOnce(async () => {
        order.push('retry');
        return 'retried';
      });
    const pending = controller.run(operation, 1, 100);
    await vi.advanceTimersByTimeAsync(0);
    const other = controller.run(async () => {
      order.push('other');
      return 'other';
    }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['first', 'other']);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe('retried');
    expect(await other).toBe('other');
    expect(order).toEqual(['first', 'other', 'retry']);
    expect(controller.activeRequests).toBe(0);
  });

  it('admits one recovery probe after the logged cooldown and doubles only the next window', async () => {
    vi.useFakeTimers();
    const controller = new ReliabilityController({
      maxConcurrency: 2,
      maxRetries: 0,
      circuitThreshold: 1,
    });
    await expect(
      controller.run(async () => {
        throw serviceFailure();
      })
    ).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(30_000);
    const probe = Promise.withResolvers<string>();
    const execute = vi.fn(() => probe.promise);
    const pending = controller.run(execute).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    const competing = vi.fn(async () => 'must not probe concurrently');
    await expect(controller.run(competing)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(competing).not.toHaveBeenCalled();
    probe.reject(serviceFailure());
    expect(await pending).toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(controller.run(competing)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    await vi.advanceTimersByTimeAsync(1);
    await expect(controller.run(async () => 'recovered')).resolves.toBe('recovered');
    expect(controller.circuitState).toBe('CLOSED');
    expect(controller.circuitFailures).toBe(0);
  });

  it('does not let an older successful request close a circuit opened by another request', async () => {
    const controller = new ReliabilityController({
      maxConcurrency: 2,
      maxRetries: 0,
      circuitThreshold: 1,
    });
    const slow = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const pending = controller.run(() => {
      started.resolve();
      return slow.promise;
    });
    await started.promise;
    await expect(
      controller.run(async () => {
        throw serviceFailure();
      })
    ).rejects.toMatchObject({ status: 503 });
    slow.resolve('valid older response');
    expect(await pending).toBe('valid older response');
    expect(controller.circuitState).toBe('OPEN');
  });

  it('gives cancellation priority over an open circuit', async () => {
    const controller = new ReliabilityController({ maxRetries: 0, circuitThreshold: 1 });
    await expect(
      controller.run(async () => {
        throw serviceFailure();
      })
    ).rejects.toMatchObject({ status: 503 });
    const cancelled = new AbortController();
    cancelled.abort();
    const execute = vi.fn(async () => 'must not run');
    await expect(
      controller.run(execute, 0, 1, { abortSignal: cancelled.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(controller.circuitFailures).toBe(1);
  });

  it('does not dispatch after cancellation wins the queued-slot handoff', async () => {
    vi.useFakeTimers();
    const controller = new ReliabilityController({ maxConcurrency: 1, maxRetries: 0 });
    const cancelled = new AbortController();
    await controller.acquireSlot();
    const execute = vi.fn(async () => 'must not run');
    const pending = controller
      .run(execute, 0, 1, { abortSignal: cancelled.signal })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.releaseSlot();
    cancelled.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(controller.activeRequests).toBe(0);
  });

  it.each([
    503, 429,
  ])('keeps admission valid through dispatch when a peer returns %s', async (status) => {
    vi.useFakeTimers();
    const controller = new ReliabilityController({
      maxConcurrency: 2,
      maxRetries: 0,
      circuitThreshold: status === 503 ? 1 : 5,
    });
    const first = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const firstResult = controller
      .run(
        () => {
          started.resolve();
          return first.promise;
        },
        0,
        1
      )
      .catch((error) => error);
    await started.promise;
    const observations: { circuit: string; cooling: boolean }[] = [];
    const pending = controller
      .run(async () => {
        observations.push({
          circuit: controller.circuitState,
          cooling: controller.rateLimitedUntil > Date.now(),
        });
        return 'next';
      })
      .catch((error) => error);
    // 在 B 的准入 await 与真正调用之间发布 A 的失败，捕获微任务交接的竞态。
    queueMicrotask(() =>
      first.reject(Object.assign(serviceFailure(status), { retryAfterMs: 10_000 }))
    );
    await firstResult;
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    for (const observation of observations) {
      expect(observation).toEqual({ circuit: 'CLOSED', cooling: false });
    }
    if (observations.length === 0) {
      expect(result).toMatchObject({ code: 'CIRCUIT_OPEN' });
    } else {
      expect(result).toBe('next');
    }
    expect(controller.activeRequests).toBe(0);
  });

  it('honors cancellation from the half-open observer and returns the probe permit', async () => {
    vi.useFakeTimers();
    const cancelled = new AbortController();
    const controller = new ReliabilityController({
      maxRetries: 0,
      circuitThreshold: 1,
      onLog: (_level, message) => {
        if (message.includes('HALF_OPEN')) {
          cancelled.abort('stop before dispatch');
        }
      },
    });
    await expect(
      controller.run(async () => {
        throw serviceFailure();
      })
    ).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(30_000);
    const execute = vi.fn(async () => 'must not run');
    await expect(
      controller.run(execute, 0, 1, { abortSignal: cancelled.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(controller.activeRequests).toBe(0);
    await expect(controller.run(async () => 'next probe')).resolves.toBe('next probe');
    expect(controller.circuitState).toBe('CLOSED');
  });

  it('reserves the half-open probe across retry backoff and releases it on cancellation', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const controller = new ReliabilityController({ maxConcurrency: 2, circuitThreshold: 1 });
    await expect(
      controller.run(async () => {
        throw serviceFailure();
      }, 0)
    ).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(30_000);
    const cancelled = new AbortController();
    const execute = vi.fn().mockRejectedValue(serviceFailure());
    const probe = controller
      .run(execute, 1, 100, { abortSignal: cancelled.signal })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.activeRequests).toBe(0);
    const other = vi.fn(async () => 'must not take the probe');
    await expect(controller.run(other)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(other).not.toHaveBeenCalled();
    cancelled.abort('cancel retry');
    expect(await probe).toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledOnce();
    await expect(controller.run(async () => 'next probe')).resolves.toBe('next probe');
    expect(controller.circuitState).toBe('CLOSED');
  });

  it.each([
    'sync',
    'async',
  ])('isolates %s log failures from results and slot ownership', async (mode) => {
    vi.useFakeTimers();
    const controller = new ReliabilityController({
      maxRetries: 0,
      circuitThreshold: 1,
      onLog: () => {
        if (mode === 'async') {
          return Promise.reject(new Error('observer unavailable'));
        }
        throw new Error('observer unavailable');
      },
    });
    const failure = serviceFailure();
    await expect(
      controller.run(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(controller.activeRequests).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(controller.run(async () => 'recovered')).resolves.toBe('recovered');
    expect(controller.activeRequests).toBe(0);
    expect(controller.circuitState).toBe('CLOSED');
  });

  it('keeps a Retry-After beyond the Node timer limit cancellable without early dispatch', async () => {
    vi.useFakeTimers();
    const controller = new ReliabilityController({ maxRetries: 0 });
    const cancelled = new AbortController();
    controller.setRateLimitWindow(2_147_483_647 + 1000);
    const execute = vi.fn(async () => 'must not run early');
    const pending = controller
      .run(execute, 0, 1, { abortSignal: cancelled.signal })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(execute).not.toHaveBeenCalled();
    cancelled.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(controller.activeRequests).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ReliabilityController retry & circuit breaker', () => {
  it.each([
    400, 503, 429,
  ])('classifies a structured %s rejection before wrapping it as Error', async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const controller = new ReliabilityController({ maxRetries: 1, circuitThreshold: 1 });
    const original = { status, retryAfterMs: 10_000, message: 'fixture failure' };
    const execute = vi.fn().mockRejectedValueOnce(original).mockResolvedValue('recovered');
    const pending = controller.run(execute, 1, 100).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    if (status === 400) {
      const result = await pending;
      expect(result).toBeInstanceOf(Error);
      expect(result.cause).toBe(original);
    } else {
      await vi.advanceTimersByTimeAsync(status === 429 ? 9999 : 99);
      expect(execute).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe('recovered');
      expect(execute).toHaveBeenCalledTimes(2);
    }
    expect(controller.circuitState).toBe('CLOSED');
    expect(controller.circuitFailures).toBe(0);
    expect(controller.activeRequests).toBe(0);
  });

  it('does not trip the circuit for non-retryable client errors', async () => {
    const c = new ReliabilityController({ maxRetries: 0, circuitThreshold: 1 });
    const clientError = Object.assign(new Error('bad request'), { status: 400 });
    await expect(c.run(() => Promise.reject(clientError), 0, 1)).rejects.toMatchObject({
      status: 400,
    });
    expect(c.circuitFailures).toBe(0);
    expect(c.circuitState).toBe('CLOSED');
  });

  it('does not trip the circuit for programmer errors (code bugs, no status)', async () => {
    const c = new ReliabilityController({ maxRetries: 0, circuitThreshold: 1 });
    // A TypeError is a deterministic bug, not a service outage; it must not count
    // toward the breaker even though it carries no HTTP status.
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    await expect(c.run(() => Promise.reject(bug), 0, 1)).rejects.toBeInstanceOf(TypeError);
    expect(c.circuitFailures).toBe(0);
    expect(c.circuitState).toBe('CLOSED');
  });

  it('classifies timeout as retryable and opens the circuit', async () => {
    const c = new ReliabilityController({ maxRetries: 0, circuitThreshold: 1 });
    const timeoutError = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    await expect(c.run(() => Promise.reject(timeoutError), 0, 1)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(c.circuitFailures).toBe(1);
    expect(c.circuitState).toBe('OPEN');
    await expect(c.run(() => Promise.resolve('ok'), 0, 1)).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
    });
  });

  it('opens the circuit once when concurrent failures cross the threshold', async () => {
    const c = new ReliabilityController({
      maxConcurrency: 2,
      maxRetries: 0,
      circuitThreshold: 1,
    });
    const timeoutError = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });

    await Promise.allSettled([
      c.run(() => Promise.reject(timeoutError()), 0, 1),
      c.run(() => Promise.reject(timeoutError()), 0, 1),
    ]);

    expect(c.circuitState).toBe('OPEN');
    expect(c.circuitCooldownMs).toBe(60_000);
  });

  it('treats AbortError as non-retryable without circuit changes', async () => {
    const c = new ReliabilityController({ maxRetries: 2, circuitThreshold: 1 });
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    let attempts = 0;
    await expect(
      c.run(
        () => {
          attempts += 1;
          return Promise.reject(abortError);
        },
        2,
        1
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toBe(1);
    expect(c.circuitFailures).toBe(0);
    expect(c.circuitState).toBe('CLOSED');
  });

  it('retries retryable errors up to the limit then succeeds', async () => {
    const c = new ReliabilityController({ maxRetries: 2, circuitThreshold: 5 });
    let attempts = 0;
    const result = await c.run(
      () => {
        attempts += 1;
        if (attempts < 2) {
          return Promise.reject(Object.assign(new Error('flaky'), { status: 503 }));
        }
        return Promise.resolve('ok');
      },
      2,
      1
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(c.circuitState).toBe('CLOSED');
  });

  it('limits concurrency to maxConcurrency', async () => {
    const c = new ReliabilityController({ maxConcurrency: 2, maxRetries: 0 });
    let active = 0;
    let peak = 0;
    const task = () =>
      c.run(
        () =>
          new Promise<void>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            setTimeout(() => {
              active -= 1;
              resolve();
            }, 10);
          }),
        0,
        1
      );
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('transfers a released slot atomically to the oldest queued request', async () => {
    const c = new ReliabilityController({ maxConcurrency: 1, maxRetries: 0 });

    await c.acquireSlot();
    const queued = c.acquireSlot();

    c.releaseSlot();
    const lateArrival = c.acquireSlot();

    await queued;
    expect(c.activeRequests).toBe(1);

    c.releaseSlot();
    await lateArrival;
    expect(c.activeRequests).toBe(1);

    c.releaseSlot();
    expect(c.activeRequests).toBe(0);
  });

  it('removes aborted queued requests without leaking a concurrency slot', async () => {
    const c = new ReliabilityController({ maxConcurrency: 1, maxRetries: 0 });
    const abortController = new AbortController();

    await c.acquireSlot();
    const queued = c.acquireSlot(abortController.signal);
    abortController.abort('cancel queued request');

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.activeRequests).toBe(1);

    c.releaseSlot();
    expect(c.activeRequests).toBe(0);
  });

  it('keeps an Error cancellation reason out of provider failure accounting', async () => {
    const c = new ReliabilityController({
      maxConcurrency: 1,
      maxRetries: 0,
      circuitThreshold: 1,
    });
    const controller = new AbortController();
    const reason = new Error('caller stopped the run');
    let executions = 0;
    await c.acquireSlot();
    const pending = c
      .run(async () => executions++, 0, 1, { abortSignal: controller.signal })
      .catch((err: unknown) => err);
    // 等待真实 run 进入并发队列，再模拟宿主使用 Error 作为取消原因。
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(reason);
    const error = await pending;
    c.releaseSlot();

    expect(executions).toBe(0);
    expect(error).toMatchObject({ name: 'AbortError', cause: reason });
    expect(c.circuitFailures).toBe(0);
    expect(c.circuitState).toBe('CLOSED');
    expect(c.activeRequests).toBe(0);
    await expect(c.run(async () => 'next caller')).resolves.toBe('next caller');
  });
});
