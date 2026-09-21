import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyLlmError } from '../src/ai/shared/errorClassify.js';
import { extractJSON, repairTruncatedArray } from '../src/ai/shared/structuredOutput.js';
import { createLimit } from '../src/shared/concurrency.js';
import { runOperation } from '../src/shared/operation.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared/operation lifecycle', () => {
  it('segments a long deadline without expiring at the Node timer maximum', async () => {
    vi.useFakeTimers();
    const completion = Promise.withResolvers<string>();
    let innerSignal: AbortSignal | undefined;
    let settled = false;
    const pending = runOperation(
      (signal) => {
        innerSignal = signal;
        return completion.promise;
      },
      { timeoutMs: 2_147_483_647 + 1000 }
    );
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(settled).toBe(false);
    expect(innerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ status: 'timeout' });
    expect(innerSignal?.aborted).toBe(true);
    // 超时后的拒绝仍被消费，不重新结算，也不会成为未处理的拒绝。
    completion.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards the parent cancellation reason and clears the pending deadline', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const reason = new Error('host stopped the run');
    const pending = runOperation(
      (signal) => {
        started.resolve(signal);
        return new Promise(() => {});
      },
      { abortSignal: parent.signal, timeoutMs: 1000 }
    );
    const innerSignal = await started.promise;
    parent.abort(reason);
    expect(await pending).toEqual({ status: 'aborted' });
    expect(innerSignal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles timeout before a cooperative abort handler resolves', async () => {
    vi.useFakeTimers();
    const pending = runOperation(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('cooperative late result'), {
            once: true,
          });
        }),
      { timeoutMs: 10 }
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual({ status: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves immediate results and errors without starting pre-cancelled or expired work', async () => {
    expect(await runOperation(() => 'completed')).toEqual({ status: 'ok', value: 'completed' });
    const error = new Error('operation failed');
    expect(
      await runOperation(() => {
        throw error;
      })
    ).toEqual({ status: 'error', error });
    const operation = vi.fn(() => 'must not start');
    const parent = new AbortController();
    parent.abort();
    expect(await runOperation(operation, { abortSignal: parent.signal })).toEqual({
      status: 'aborted',
    });
    expect(await runOperation(operation, { timeoutMs: 0 })).toEqual({ status: 'timeout' });
    expect(operation).not.toHaveBeenCalled();
  });
});

describe('shared/concurrency input boundary', () => {
  it.each([
    0,
    -1,
    Number.NaN,
    Infinity,
    -Infinity,
    1.5,
  ])('rejects a concurrency value that is not a finite positive integer: %s', (concurrency) => {
    expect(() => createLimit(concurrency)).toThrow(RangeError);
  });
});

describe('shared/structuredOutput extractJSON', () => {
  it('parses a clean JSON object', () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it.each([
    'literal,}',
    'literal, ]',
    '```ts\ncode\n```',
    'escaped "quote",}',
  ])('preserves JSON string content: %s', (value) => {
    const item = { value };
    expect(extractJSON(JSON.stringify(item))).toEqual(item);
    expect(extractJSON(`[${JSON.stringify(item)},{"unfinished":`, '[', ']')).toEqual([item]);
  });

  it('strips markdown code fences before parsing', () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('tolerates surrounding prose and trailing commas', () => {
    const text = 'Here is the result: {"a":1, "b":[1,2,],}\nDone.';
    expect(extractJSON(text)).toEqual({ a: 1, b: [1, 2] });
  });

  it('returns null when no opening char is present', () => {
    expect(extractJSON('no json here')).toBeNull();
  });

  it('parses arrays when openChar/closeChar are brackets', () => {
    expect(extractJSON('[{"a":1},{"a":2}]', '[', ']')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('repairs a truncated JSON array by recovering completed objects', () => {
    const truncated = '[{"a":1},{"a":2},{"a":3'; // 第三个对象被截断
    const result = extractJSON(truncated, '[', ']');
    expect(result).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('forwards a log message when repairing truncated arrays', () => {
    const logs: Array<{ level: string; message: string }> = [];
    const truncated = '[{"a":1},{"a":2},{"a":3';
    repairTruncatedArray(truncated, (level, message) => logs.push({ level, message }));
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('Repaired'))).toBe(true);
  });

  it.each([
    { text: '{"a":1,}', open: '{', close: '}', expected: { a: 1 } },
    { text: '[{"a":1},{"unfinished":', open: '[', close: ']', expected: [{ a: 1 }] },
  ])('preserves recovery when a synchronous observer fails: $text', ({
    text,
    open,
    close,
    expected,
  }) => {
    const onLog = vi.fn(() => {
      throw new Error('observer unavailable');
    });
    expect(extractJSON(text, open, close, onLog)).toEqual(expected);
    expect(onLog).toHaveBeenCalledOnce();
  });

  it.each([
    { text: '{"a":1,}', open: '{', close: '}', expected: { a: 1 } },
    { text: '[{"a":1},{"unfinished":', open: '[', close: ']', expected: [{ a: 1 }] },
  ])('consumes asynchronous observer rejection without losing recovery: $text', async ({
    text,
    open,
    close,
    expected,
  }) => {
    const then = vi.fn((_resolve: unknown, reject: (reason: unknown) => void) => {
      reject(new Error('asynchronous observer unavailable'));
    });
    const onLog = vi.fn(() => ({ then }));
    expect(extractJSON(text, open, close, onLog)).toEqual(expected);
    await Promise.resolve();
    await Promise.resolve();
    expect(then).toHaveBeenCalledOnce();
    expect(onLog).toHaveBeenCalledOnce();
  });
});

describe('shared/errorClassify classifyLlmError', () => {
  it('flags AbortError as abort and non-retryable', () => {
    const c = classifyLlmError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(c.isAbort).toBe(true);
    expect(c.isRetryable).toBe(false);
  });

  it('flags AbortError surfaced via cause', () => {
    const c = classifyLlmError({ message: 'x', cause: { name: 'AbortError' } });
    expect(c.isAbort).toBe(true);
  });

  it('treats network error codes as retryable network errors', () => {
    const c = classifyLlmError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    expect(c.isNetworkError).toBe(true);
    expect(c.isRetryable).toBe(true);
    expect(c.isServerError).toBe(true);
  });

  it('treats 429 and 5xx as retryable server errors', () => {
    expect(classifyLlmError({ status: 429 }).isRetryable).toBe(true);
    expect(classifyLlmError({ status: 503 }).isRetryable).toBe(true);
    expect(classifyLlmError({ status: 503 }).isServerError).toBe(true);
  });

  it('does not treat 4xx client errors (non-429) as retryable or server errors', () => {
    const c = classifyLlmError({ status: 400 });
    expect(c.isRetryable).toBe(false);
    expect(c.isServerError).toBe(false);
  });

  it('reads cause.code for network classification', () => {
    const c = classifyLlmError({ message: 'fetch failed', cause: { code: 'ECONNRESET' } });
    expect(c.isNetworkError).toBe(true);
  });
});
