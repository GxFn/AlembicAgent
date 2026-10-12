import type { AgentResult } from './AgentRuntimeTypes.js';

/** 运行级硬超时的稳定错误码；AgentService 按它（而不是 message 文案）把失败归为 'timeout'。 */
export const AGENT_EXECUTION_TIMEOUT_CODE = 'AGENT_EXECUTION_TIMEOUT';

/** 硬超时仍抛 Error；已确认的工具/用量快照不能在 Service 转换错误时丢失。 */
export class AgentExecutionTimeoutError extends Error {
  readonly code = AGENT_EXECUTION_TIMEOUT_CODE;

  constructor(
    timeoutMs: number,
    readonly partialResult: AgentResult
  ) {
    super(`Agent timeout after ${timeoutMs}ms`);
    // 日志与堆栈里要能直接看出这是运行级硬超时，而不是普通 'Error'。
    this.name = 'AgentExecutionTimeoutError';
  }
}

/**
 * 结构化判断“运行级硬超时”：本模块的类实例，或带同一稳定 code 的 Error
 * （兼容同一进程内加载了两份本模块的情况，此时 instanceof 不成立）。
 * 文案里含 timeout 的普通 Error（策略/闸门/宿主锁等）不算运行超时。
 */
export function isAgentExecutionTimeoutError(error: unknown): error is Error & { code: string } {
  if (error instanceof AgentExecutionTimeoutError) {
    return true;
  }
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === AGENT_EXECUTION_TIMEOUT_CODE
  );
}

// 超时错误由哪个 Runtime 抛出：只有抛出者才能采用 error.partialResult。
// 嵌套 Runtime（自定义 Strategy 内 await 另一个 Runtime）时，外层收到的是子运行的超时错误，
// 不能把子运行的工具调用/用量当作自己的，也不能原地改写子运行的快照。WeakMap 不强持有 Runtime。
const executionTimeoutOwners = new WeakMap<AgentExecutionTimeoutError, object>();

/** Runtime 执行边界创建硬超时错误的唯一入口：同时登记 owner。 */
export function createOwnedExecutionTimeoutError(
  owner: object,
  timeoutMs: number,
  partial: AgentResult
): AgentExecutionTimeoutError {
  const error = new AgentExecutionTimeoutError(timeoutMs, partial);
  executionTimeoutOwners.set(error, owner);
  return error;
}

/** 仅当超时错误由 owner 自己抛出时返回其快照；其他 Runtime 的超时错误或未登记的实例返回 null。 */
export function readOwnedExecutionTimeoutSnapshot(
  owner: object,
  error: unknown
): AgentResult | null {
  if (!(error instanceof AgentExecutionTimeoutError)) {
    return null;
  }
  return executionTimeoutOwners.get(error) === owner ? error.partialResult : null;
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

/**
 * 一律只查登记表：owner 不是登记者（例如 AgentService 拿到的是包装 AgentRuntimeLike）时返回 null，
 * 超时错误也不例外——不再回退采用 error.partialResult，避免同类失败因错误类型不同而结果不一致。
 */
export function readRuntimeFailureSnapshot(owner: object, error: unknown): AgentResult | null {
  if (!(error instanceof Error)) {
    return null;
  }
  return runtimeFailureSnapshots.get(error)?.get(owner) ?? null;
}
