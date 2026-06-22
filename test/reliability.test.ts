import { describe, expect, it } from 'vitest';

import { ReliabilityController } from '../src/ai/shared/reliability.js';

describe('ReliabilityController retry & circuit breaker', () => {
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
});
