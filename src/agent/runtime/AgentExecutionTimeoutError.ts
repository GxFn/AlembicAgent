import type { AgentResult } from './AgentRuntimeTypes.js';

/** 硬超时仍抛 Error；已确认的工具/用量快照不能在 Service 转换错误时丢失。 */
export class AgentExecutionTimeoutError extends Error {
  readonly code = 'AGENT_EXECUTION_TIMEOUT';

  constructor(
    timeoutMs: number,
    readonly partialResult: AgentResult
  ) {
    super(`Agent timeout after ${timeoutMs}ms`);
  }
}

// 相同 provider/policy Error 可以被多个 Runtime 复用；owner 隔离回执且不强持有历史Runtime。
const runtimeFailureSnapshots = new WeakMap<Error, WeakMap<object, AgentResult>>();

/** 只接收 Runtime 执行边界生成的已确认快照，不采信 provider Error 自带的 partialResult。 */
export function bindRuntimeFailureSnapshot(
  owner: object,
  error: Error,
  partial: AgentResult
): void {
  const snapshots = runtimeFailureSnapshots.get(error) ?? new WeakMap<object, AgentResult>();
  snapshots.set(owner, partial);
  runtimeFailureSnapshots.set(error, snapshots);
}

export function readRuntimeFailureSnapshot(owner: object, error: unknown): AgentResult | null {
  return error instanceof Error
    ? (runtimeFailureSnapshots.get(error)?.get(owner) ??
        (error instanceof AgentExecutionTimeoutError ? error.partialResult : null))
    : null;
}
