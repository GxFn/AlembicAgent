import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyLlmError } from '../src/ai/shared/errorClassify.js';
import { extractJSON, repairTruncatedArray } from '../src/ai/shared/structuredOutput.js';
import { createLimit } from '../src/shared/concurrency.js';
import { isThenable, observeSafely } from '../src/shared/observers.js';
import { runOperation } from '../src/shared/operation.js';
import { resolveProjectPath } from '../src/shared/projectPath.js';
import { stableStringify } from '../src/shared/serialization.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// 等待一个宏任务：Node 在微任务队列清空后才派发 unhandledRejection，
// 所以断言“没有逃逸的拒绝”前必须越过至少一个宏任务边界。
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// 统计测试窗口内逃逸到进程层的未处理拒绝；返回值在 finally 中解除监听。
function trackUnhandledRejections(): { readonly reasons: unknown[]; dispose: () => void } {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', listener);
  return {
    reasons,
    dispose: () => {
      process.off('unhandledRejection', listener);
    },
  };
}

// then 访问器本身抛错的“伪 thenable”：用于锁定 isThenable / observeSafely 对恶意返回值的处理。
function thenGetterThatThrows(error: Error): object {
  return Object.defineProperty({}, 'then', {
    get() {
      throw error;
    },
  });
}

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

// 特征测试：锁定 createLimit 当前的调度契约（峰值、FIFO、失败释放槽位），
// 防止 FanOut 等依赖方在任务失败后因槽位泄漏而挂起。
describe('shared/concurrency scheduling contract', () => {
  it('never runs more tasks at once than the limit', async () => {
    const limit = createLimit(2);
    const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    let active = 0;
    let peak = 0;
    const results = gates.map((gate, index) =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return index;
      })
    );

    await flushMacrotask();
    expect(active).toBe(2);
    for (const gate of gates) {
      gate.resolve();
      await flushMacrotask();
      expect(active).toBeLessThanOrEqual(2);
    }
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('starts queued tasks in submission order', async () => {
    const limit = createLimit(1);
    const blocker = Promise.withResolvers<void>();
    const started: string[] = [];
    const record = (label: string) => () => {
      started.push(label);
      return label;
    };
    const first = limit(async () => {
      started.push('first');
      await blocker.promise;
      return 'first';
    });
    const queued = ['a', 'b', 'c'].map((label) => limit(record(label)));

    await flushMacrotask();
    expect(started).toEqual(['first']);
    blocker.resolve();
    expect(await Promise.all([first, ...queued])).toEqual(['first', 'a', 'b', 'c']);
    expect(started).toEqual(['first', 'a', 'b', 'c']);
  });

  it('turns a synchronous task throw into a rejection and releases the slot', async () => {
    const limit = createLimit(1);
    const error = new Error('sync task failure');
    let failing: Promise<never> | undefined;
    // 同步抛错不会从 limit() 直接抛出，而是变成返回 Promise 的拒绝。
    expect(() => {
      failing = limit(() => {
        throw error;
      });
    }).not.toThrow();
    const next = limit(() => 'after sync failure');

    await expect(failing).rejects.toBe(error);
    await expect(next).resolves.toBe('after sync failure');
  });

  it('releases the slot after an asynchronous rejection so the queue keeps draining', async () => {
    const limit = createLimit(1);
    const error = new Error('async task failure');
    const failing = limit(() => Promise.reject(error));
    const queued = [limit(() => 'second'), limit(async () => 'third')];

    await expect(failing).rejects.toBe(error);
    expect(await Promise.all(queued)).toEqual(['second', 'third']);
  });
});

// 特征测试：锁定观察者隔离原语。观察/诊断通道的任何失败都不能升级为业务失败，
// 也不能以未处理拒绝的形式逃逸到进程层。
describe('shared/observers isolation contract', () => {
  it('recognizes promises, thenable objects and thenable functions only', () => {
    // 用 defineProperty 构造 then 属性，避免对象字面量直接声明 then。
    const withThen = <T extends object>(target: T, then: unknown): T =>
      Object.defineProperty(target, 'then', { value: then, enumerable: true });
    expect(isThenable(Promise.resolve())).toBe(true);
    expect(isThenable(withThen({}, () => undefined))).toBe(true);
    const thenableFunction = withThen(
      () => undefined,
      () => undefined
    );
    expect(isThenable(thenableFunction)).toBe(true);
    for (const value of [null, undefined, 0, 'then', true, {}, withThen({}, 'not callable')]) {
      expect(isThenable(value)).toBe(false);
    }
  });

  it('propagates a throwing then getter from isThenable so observeSafely can contain it', () => {
    const error = new Error('then getter failure');
    // 当前契约：isThenable 不吞 getter 异常，由 observeSafely 的 try 边界负责收敛。
    expect(() => isThenable(thenGetterThatThrows(error))).toThrow(error);
  });

  it('does not report a successful synchronous or asynchronous operation', async () => {
    const onFailure = vi.fn();
    observeSafely(() => 'done', onFailure);
    observeSafely(() => Promise.resolve('done'), onFailure);
    await flushMacrotask();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports a synchronous operation throw to onFailure without rethrowing', () => {
    const error = new Error('observer threw');
    const onFailure = vi.fn();
    expect(() =>
      observeSafely(() => {
        throw error;
      }, onFailure)
    ).not.toThrow();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('reports an asynchronous operation rejection after the call returns', async () => {
    const error = new Error('observer rejected');
    const onFailure = vi.fn();
    observeSafely(() => Promise.reject(error), onFailure);
    expect(onFailure).not.toHaveBeenCalled();
    await flushMacrotask();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('reports a throwing then getter on the operation result synchronously', () => {
    const error = new Error('result then getter failure');
    const onFailure = vi.fn();
    expect(() => observeSafely(() => thenGetterThatThrows(error), onFailure)).not.toThrow();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('swallows onFailure failures of every shape without unhandled rejections', async () => {
    const tracker = trackUnhandledRejections();
    try {
      const failingOperation = () => {
        throw new Error('operation failure');
      };
      const rejectedOperation = () => Promise.reject(new Error('operation rejection'));
      const onFailureShapes: Array<() => unknown> = [
        () => {
          throw new Error('onFailure sync throw');
        },
        () => Promise.reject(new Error('onFailure async rejection')),
        () => thenGetterThatThrows(new Error('onFailure then getter failure')),
      ];
      for (const onFailureShape of onFailureShapes) {
        // 不用 vi.fn 包装：vitest 的 mock 会给返回的 Promise 挂结算记录处理器，
        // 从而“消费”拒绝，掩盖 observeSafely 本应自行吞掉的未处理拒绝。
        let calls = 0;
        const onFailure = () => {
          calls += 1;
          return onFailureShape();
        };
        expect(() => observeSafely(failingOperation, onFailure)).not.toThrow();
        expect(() => observeSafely(rejectedOperation, onFailure)).not.toThrow();
        await flushMacrotask();
        // 诊断通道自身失败不会被递归上报：每次 observeSafely 只调用一次 onFailure。
        expect(calls).toBe(2);
      }
      await flushMacrotask();
      expect(tracker.reasons).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });
});

// 特征测试：锁定会话缓存稳定键的语义（对象键序无关、数组保序）。
describe('shared/serialization stableStringify', () => {
  it('produces the same key regardless of object key insertion order at any depth', () => {
    const left = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } };
    const right = { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(stableStringify(left)).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
  });

  it('preserves array order', () => {
    expect(stableStringify([2, 1, 3])).toBe('[2,1,3]');
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('matches JSON.stringify for primitives and null', () => {
    for (const value of [null, 0, -1.5, 'text', 'quote "inside"', true, false]) {
      expect(stableStringify(value)).toBe(JSON.stringify(value));
    }
  });

  it('serializes Set members and Map entries in sorted order', () => {
    expect(stableStringify(new Set(['b', 'a']))).toBe(stableStringify(new Set(['a', 'b'])));
    expect(stableStringify(new Set(['b', 'a']))).toBe('["a","b"]');
    const forward = new Map<string, number>([
      ['b', 2],
      ['a', 1],
    ]);
    const reverse = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    expect(stableStringify(forward)).toBe(stableStringify(reverse));
    expect(stableStringify(forward)).toBe('[["a",1],["b",2]]');
  });
});

// 特征测试：锁定悬空 symlink 分支。allowMissing 只放行真正不存在的新路径，
// 悬空 symlink 不得被当作可创建的新文件，否则写入可能落到项目根之外。
describe.skipIf(process.platform === 'win32')('shared/projectPath dangling symlink', () => {
  function createProjectRoot(): string {
    // macOS 的 tmpdir 位于 /var -> /private/var 符号链接之下；取 realpath 避免根本身是 symlink。
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'alembic-project-path-')));
    temporaryRoots.push(root);
    return root;
  }

  it('rejects a dangling symlink even when missing paths are allowed', () => {
    const root = createProjectRoot();
    symlinkSync(path.join(root, 'missing-target'), path.join(root, 'dangling'));

    expect(() => resolveProjectPath(root, 'dangling', true)).toThrow(
      'Access denied: unresolved symbolic link'
    );
    expect(() => resolveProjectPath(root, 'dangling/child.txt', true)).toThrow(
      'Access denied: unresolved symbolic link'
    );
  });

  it('surfaces the ENOENT error for a dangling symlink when missing paths are not allowed', () => {
    const root = createProjectRoot();
    symlinkSync(path.join(root, 'missing-target'), path.join(root, 'dangling'));

    expect(() => resolveProjectPath(root, 'dangling')).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
  });

  it('allows a genuinely missing path under the nearest existing ancestor', () => {
    const root = createProjectRoot();
    mkdirSync(path.join(root, 'existing'));

    expect(resolveProjectPath(root, 'existing/new-dir/file.txt', true)).toEqual({
      absolute: path.join(root, 'existing', 'new-dir', 'file.txt'),
      relative: path.join('existing', 'new-dir', 'file.txt'),
    });
    expect(() => resolveProjectPath(root, 'existing/new-dir/file.txt')).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
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

  it('separates rejected model output from service failures', () => {
    // 模型输出不可执行：服务已应答，不重试、不计入熔断。
    const rejected = classifyLlmError(
      Object.assign(new Error('Invalid tool arguments'), {
        name: 'LlmResponseError',
        code: 'LLM_INVALID_TOOL_CALL',
      })
    );
    expect(rejected.isModelOutputError).toBe(true);
    expect(rejected.isRetryable).toBe(false);
    expect(rejected.isServerError).toBe(false);

    // 响应体不符合协议：仍按服务端故障兜底计数。
    const badBody = classifyLlmError({ message: 'bad body', code: 'LLM_INVALID_RESPONSE' });
    expect(badBody.isModelOutputError).toBe(false);
    expect(badBody.isServerError).toBe(true);

    // 带 HTTP 状态的错误不受该分类影响。
    expect(classifyLlmError({ status: 503 }).isModelOutputError).toBe(false);
  });

  it('reads cause.code for network classification', () => {
    const c = classifyLlmError({ message: 'fetch failed', cause: { code: 'ECONNRESET' } });
    expect(c.isNetworkError).toBe(true);
  });
});
