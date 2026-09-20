import Logger from '@alembic/core/logging';

/** 只描述一次读取，不把 session、持久记忆和工作记忆强行合成同一存储接口。 */
export interface MemoryReadOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** 绝对截止时间，嵌套或批量读取共享同一个时间边界。 */
  deadlineAt?: number;
  onDiagnostic?: (diagnostic: MemoryReadDiagnostic) => void;
}

export interface MemoryReadDiagnostic {
  phase: 'embedding' | 'persistent' | 'session' | 'working' | 'backfill' | 'policy';
  status: 'timeout' | 'aborted' | 'error' | 'invalid' | 'truncated' | 'stale';
  reason: string;
  budget?: number;
}

export type MemoryReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout' | 'aborted' | 'error'; error?: unknown };

export const DEFAULT_MEMORY_READ_TIMEOUT_MS = 5000;

/** 一次请求只形成一个绝对 deadline，所有嵌套读取使用剩余时长。 */
export function memoryReadDeadline(options: MemoryReadOptions = {}): number {
  let timeout = options.timeoutMs ?? DEFAULT_MEMORY_READ_TIMEOUT_MS;
  if (typeof timeout !== 'number' || Number.isNaN(timeout)) {
    timeout = DEFAULT_MEMORY_READ_TIMEOUT_MS;
    reportMemoryRead(options, {
      phase: 'policy',
      status: 'invalid',
      reason: 'invalid-timeout-using-default',
    });
  }
  let deadline = options.deadlineAt ?? Infinity;
  if (typeof deadline !== 'number' || Number.isNaN(deadline)) {
    deadline = Infinity;
    reportMemoryRead(options, {
      phase: 'policy',
      status: 'invalid',
      reason: 'invalid-deadline-using-timeout',
    });
  }
  return Math.min(deadline, Date.now() + Math.max(0, timeout));
}

/**
 * 同时限制等待与传播取消。旧宿主可能忽略 signal，但迟到结果不会重新进入消费路径。
 * 只管理本次调用的 timer/listener，不增加常驻调度器或全局状态。
 */
export async function readMemoryValue<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
  options: MemoryReadOptions = {}
): Promise<MemoryReadResult<T>> {
  if (options.abortSignal?.aborted) {
    return { status: 'aborted' };
  }
  const timeoutMs = Math.max(0, memoryReadDeadline(options) - Date.now());
  if (timeoutMs === 0) {
    return { status: 'timeout' };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<MemoryReadResult<T>>((resolve) => {
    abort = () => {
      resolve({ status: 'aborted' });
      controller.abort();
    };
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        resolve({ status: 'timeout' });
        controller.abort();
      }, timeoutMs);
    }
  });
  try {
    const operationResult = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          return { status: 'aborted' } as const;
        }
        return Promise.resolve(operation(controller.signal)).then(
          (value): MemoryReadResult<T> => ({ status: 'ok', value }),
          (error: unknown): MemoryReadResult<T> => ({ status: 'error', error })
        );
      })
      .catch((error: unknown): MemoryReadResult<T> => ({ status: 'error', error }));
    const result = await Promise.race([operationResult, interrupted]);
    return options.abortSignal?.aborted ? { status: 'aborted' } : result;
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener('abort', abort);
  }
}

export function reportMemoryRead(
  options: MemoryReadOptions,
  diagnostic: MemoryReadDiagnostic
): void {
  // 诊断不包含查询、记忆正文或 provider 原始异常，避免观测链泄漏持久记忆。
  const message = `[MemoryRead] ${diagnostic.phase}: ${diagnostic.status} (${diagnostic.reason})`;
  const logger = Logger.getInstance();
  if (['error', 'timeout', 'invalid'].includes(diagnostic.status)) {
    logger.warn(message);
  } else {
    logger.debug(message);
  }
  try {
    options.onDiagnostic?.(diagnostic);
  } catch (err: unknown) {
    Logger.getInstance().warn(
      `[MemoryRead] diagnostic observer failed: ${err instanceof Error ? err.name : 'unknown'}`
    );
  }
}

export function isMemoryVector(value: unknown, dimensions?: number): value is number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    (dimensions !== undefined && value.length !== dimensions)
  ) {
    return false;
  }
  let norm = 0;
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return false;
    }
    norm += entry * entry;
  }
  return norm > 0 && Number.isFinite(norm);
}
