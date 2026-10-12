import { afterEach, describe, expect, it, vi } from 'vitest';

import { LlmResponseError } from '../src/ai/errors.js';
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

  it('does not trip the circuit when the model output is rejected', async () => {
    const logs: string[] = [];
    const c = new ReliabilityController({
      maxRetries: 0,
      circuitThreshold: 1,
      label: 'fixture',
      onLog: (_level, message) => logs.push(message),
    });
    // 服务已正常应答，只是模型给出的工具参数不可执行：这是模型行为，不是服务中断。
    // 计入熔断会让一个模型的坏输出把同 provider 的其他并发请求一起挡掉。
    const rejected = new LlmResponseError('Invalid tool arguments from fixture', null);
    await expect(c.run(() => Promise.reject(rejected), 0, 1)).rejects.toBe(rejected);
    expect(c.circuitFailures).toBe(0);
    expect(c.circuitState).toBe('CLOSED');
    expect(c.activeRequests).toBe(0);
    expect(logs.some((line) => line.includes('LLM_INVALID_TOOL_CALL'))).toBe(true);
    // 模型输出被拒只写一条终态诊断，并标明未计入熔断。
    const terminal = logs.filter((line) => line.includes('[reliability] fixture terminal'));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toContain('counted=false');
    expect(terminal[0]).toContain('model output rejected');
    await expect(c.run(() => Promise.resolve('ok'), 0, 1)).resolves.toBe('ok');
  });

  it('still counts a protocol-invalid provider response as a service failure', async () => {
    const c = new ReliabilityController({ maxRetries: 0, circuitThreshold: 1 });
    // HTTP 成功但响应体不符合协议，属于上游/代理故障信号，仍计入熔断。
    const badBody = Object.assign(new Error('fixture SDK response validation failed'), {
      code: 'LLM_INVALID_RESPONSE',
    });
    await expect(c.run(() => Promise.reject(badBody), 0, 1)).rejects.toBe(badBody);
    expect(c.circuitFailures).toBe(1);
    expect(c.circuitState).toBe('OPEN');
  });

  it('keeps a half-open probe pending when the probe ends in rejected model output', async () => {
    vi.useFakeTimers();
    const c = new ReliabilityController({ maxRetries: 0, circuitThreshold: 1 });
    await expect(c.run(() => Promise.reject(serviceFailure()), 0, 1)).rejects.toMatchObject({
      status: 503,
    });
    expect(c.circuitState).toBe('OPEN');
    await vi.advanceTimersByTimeAsync(30_000);

    // 探活请求拿到了应答但模型输出被拒：既不能据此重新打开，也不能据此宣布恢复。
    const rejected = new LlmResponseError('Invalid tool proposal from fixture', null);
    await expect(c.run(() => Promise.reject(rejected), 0, 1)).rejects.toBe(rejected);
    expect(c.circuitState).toBe('HALF_OPEN');
    expect(c.circuitCooldownMs).toBe(60_000);

    // 探活许可已归还：下一个请求继续核验服务，成功后闭合。
    await expect(c.run(() => Promise.resolve('ok'), 0, 1)).resolves.toBe('ok');
    expect(c.circuitState).toBe('CLOSED');
    expect(c.circuitFailures).toBe(0);
  });

  it('logs a structured terminal diagnostic when a counted 503 ends the request', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const c = new ReliabilityController({
      maxRetries: 0,
      circuitThreshold: 5,
      label: 'fixture',
      onLog: (level, message) => logs.push({ level, message }),
    });
    // Claude 默认 maxRetries=0：首个 503 直接进入终态，必须留下可定位的诊断。
    await expect(c.run(() => Promise.reject(serviceFailure(503)), 0, 1)).rejects.toMatchObject({
      status: 503,
    });
    const terminal = logs.filter((entry) =>
      entry.message.includes('[reliability] fixture terminal')
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.level).toBe('warn');
    expect(terminal[0]?.message).toContain('reason=retries-exhausted');
    expect(terminal[0]?.message).toContain('status=503');
    expect(terminal[0]?.message).toContain('retryable=true');
    expect(terminal[0]?.message).toContain('counted=true');
    expect(terminal[0]?.message).toContain('circuitState=CLOSED');
    expect(terminal[0]?.message).toContain('attempts=1');
    expect(terminal[0]?.message).toContain('retries=0');
    // 只记录结构化元数据，不写错误 message 正文。
    expect(logs.some((entry) => entry.message.includes('fixture service failure'))).toBe(false);
  });

  it('logs uncounted client errors at info level without the message body', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const c = new ReliabilityController({
      maxRetries: 2,
      circuitThreshold: 1,
      label: 'fixture',
      onLog: (level, message) => logs.push({ level, message }),
    });
    const clientError = Object.assign(new Error('secret prompt body'), {
      status: 400,
      code: 'LLM_API_ERROR',
    });
    await expect(c.run(() => Promise.reject(clientError), 2, 1)).rejects.toBe(clientError);
    const terminal = logs.filter((entry) =>
      entry.message.includes('[reliability] fixture terminal')
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.level).toBe('info');
    expect(terminal[0]?.message).toContain('reason=non-retryable');
    expect(terminal[0]?.message).toContain('status=400');
    expect(terminal[0]?.message).toContain('code=LLM_API_ERROR');
    expect(terminal[0]?.message).toContain('retryable=false');
    expect(terminal[0]?.message).toContain('counted=false');
    expect(terminal[0]?.message).not.toContain('probe released without verdict');
    expect(logs.some((entry) => entry.message.includes('secret prompt body'))).toBe(false);
  });

  it('logs a half-open probe released without verdict when it ends in a 400', async () => {
    vi.useFakeTimers();
    const logs: Array<{ level: string; message: string }> = [];
    const c = new ReliabilityController({
      maxRetries: 0,
      circuitThreshold: 1,
      label: 'fixture',
      onLog: (level, message) => logs.push({ level, message }),
    });
    await expect(c.run(() => Promise.reject(serviceFailure()), 0, 1)).rejects.toMatchObject({
      status: 503,
    });
    expect(c.circuitState).toBe('OPEN');
    await vi.advanceTimersByTimeAsync(30_000);
    logs.length = 0;

    const clientError = Object.assign(new Error('bad request'), { status: 400 });
    await expect(c.run(() => Promise.reject(clientError), 0, 1)).rejects.toBe(clientError);
    // 4xx 既不计数也不闭合：熔断停在 HALF_OPEN，日志要说明探活无结论地释放。
    expect(c.circuitState).toBe('HALF_OPEN');
    const terminal = logs.filter((entry) =>
      entry.message.includes('[reliability] fixture terminal')
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.level).toBe('info');
    expect(terminal[0]?.message).toContain('counted=false');
    expect(terminal[0]?.message).toContain('circuitState=HALF_OPEN');
    expect(terminal[0]?.message).toContain('probe released without verdict');
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

describe('ReliabilityController configuration validation', () => {
  function captureLogs() {
    const logs: Array<{ level: string; message: string }> = [];
    const onLog = (level: string, message: string) => {
      logs.push({ level, message });
    };
    return { logs, onLog };
  }

  // U06-F1 探针 (a)(b)：maxRetries=1.5 曾把真实 503 换成 “unexpected retry exhaustion”，
  // NaN 曾让 fn 一次都不执行；现在构造时就以 LLM_INVALID_REQUEST 拒绝。
  it.each([
    1.5,
    Number.NaN,
    -1,
    Number.POSITIVE_INFINITY,
  ])('rejects maxRetries=%s at construction with a value-free warning', (maxRetries) => {
    const { logs, onLog } = captureLogs();
    expect(() => new ReliabilityController({ maxRetries, label: 'fixture', onLog })).toThrow(
      expect.objectContaining({
        code: 'LLM_INVALID_REQUEST',
        message: 'maxRetries must be a non-negative safe integer',
      })
    );
    // 只记字段名与来源，不记原值（配置可能被误填成敏感信息）。
    expect(logs).toEqual([
      {
        level: 'warn',
        message:
          '[reliability] fixture invalid_option field=maxRetries source=config; rejected before dispatch',
      },
    ]);
  });

  // U06-F1 探针 (c)(d)：circuitThreshold=NaN 曾让熔断永不打开，0 曾让首次失败即熔断。
  it.each([
    Number.NaN,
    0,
    1.5,
    -1,
  ])('rejects circuitThreshold=%s at construction with a value-free warning', (circuitThreshold) => {
    const { logs, onLog } = captureLogs();
    expect(() => new ReliabilityController({ circuitThreshold, label: 'fixture', onLog })).toThrow(
      expect.objectContaining({
        code: 'LLM_INVALID_REQUEST',
        message: 'circuitThreshold must be a positive safe integer',
      })
    );
    expect(logs).toEqual([
      {
        level: 'warn',
        message:
          '[reliability] fixture invalid_option field=circuitThreshold source=config; rejected before dispatch',
      },
    ]);
  });

  it('keeps defaults and the inclusive boundaries of valid reliability options', () => {
    const defaults = new ReliabilityController();
    expect(defaults.maxRetries).toBe(3);
    expect(defaults.circuitThreshold).toBe(5);
    const boundary = new ReliabilityController({ maxRetries: 0, circuitThreshold: 1 });
    expect(boundary.maxRetries).toBe(0);
    expect(boundary.circuitThreshold).toBe(1);
  });

  it('surfaces the real 503 after the configured integer retries are exhausted', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const c = new ReliabilityController({ maxRetries: 1, circuitThreshold: 5 });
    const execute = vi.fn(async () => {
      throw serviceFailure(503);
    });
    const pending = c.run(execute, undefined, 1).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toMatchObject({ status: 503, message: 'fixture service failure' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(c.circuitFailures).toBe(1);
    expect(c.activeRequests).toBe(0);
  });

  it.each([
    { retries: 1.5, baseDelay: 1, field: 'retries' },
    { retries: Number.NaN, baseDelay: 1, field: 'retries' },
    { retries: -1, baseDelay: 1, field: 'retries' },
    { retries: 0, baseDelay: Number.NaN, field: 'baseDelay' },
    { retries: 0, baseDelay: -1, field: 'baseDelay' },
    { retries: 0, baseDelay: Number.POSITIVE_INFINITY, field: 'baseDelay' },
  ])('rejects run(retries=$retries, baseDelay=$baseDelay) before dispatch', async ({
    retries,
    baseDelay,
    field,
  }) => {
    const { logs, onLog } = captureLogs();
    const c = new ReliabilityController({ maxRetries: 0, label: 'fixture', onLog });
    const execute = vi.fn(async () => 'must not run');
    await expect(c.run(execute, retries, baseDelay)).rejects.toMatchObject({
      code: 'LLM_INVALID_REQUEST',
      message: expect.stringContaining(field),
    });
    // 入参非法是调用方错误：不取槽、不调用 fn、不计熔断。
    expect(execute).not.toHaveBeenCalled();
    expect(c.activeRequests).toBe(0);
    expect(c.circuitFailures).toBe(0);
    expect(logs).toEqual([
      {
        level: 'warn',
        message: `[reliability] fixture invalid_option field=${field} source=run-argument; rejected before dispatch`,
      },
    ]);
  });

  it('accepts zero retries and a zero backoff base as explicit run arguments', async () => {
    const c = new ReliabilityController({ maxRetries: 3 });
    const execute = vi.fn(async () => {
      throw serviceFailure(503);
    });
    await expect(c.run(execute, 0, 0)).rejects.toMatchObject({ status: 503 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('caps the exponential retry backoff at 60 seconds and logs the cap', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { logs, onLog } = captureLogs();
    const c = new ReliabilityController({
      maxRetries: 2,
      circuitThreshold: 5,
      label: 'fixture',
      onLog,
    });
    const execute = vi
      .fn()
      .mockRejectedValueOnce(serviceFailure(503))
      .mockRejectedValueOnce(serviceFailure(503))
      .mockResolvedValue('recovered');
    const pending = c.run(execute, 2, 40_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    // 第 1 次退避：40s（未触顶）。
    await vi.advanceTimersByTimeAsync(40_000);
    expect(execute).toHaveBeenCalledTimes(2);
    // 第 2 次退避：min(80s, 60s) = 60s。
    await vi.advanceTimersByTimeAsync(59_999);
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(await pending).toBe('recovered');
    const capped = logs.filter((entry) => entry.message.includes('backoff capped at 60s'));
    expect(capped).toHaveLength(1);
    expect(capped[0]?.message).toContain('attempt 2 failed');
  });

  it('caps the locally computed 429 cooldown at 60 seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { logs, onLog } = captureLogs();
    const c = new ReliabilityController({
      maxRetries: 1,
      circuitThreshold: 5,
      label: 'fixture',
      onLog,
    });
    const execute = vi
      .fn()
      .mockRejectedValueOnce(serviceFailure(429))
      .mockResolvedValue('recovered');
    // 本地自适应冷却 = min(50s × 1.5, 60s) = 60s；没有 Retry-After 时不再放大到 75s。
    const pending = c.run(execute, 1, 50_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await pending).toBe('recovered');
    expect(
      logs.some((entry) => entry.message.includes('[RateLimit] fixture adaptive cooldown capped'))
    ).toBe(true);
  });
});
