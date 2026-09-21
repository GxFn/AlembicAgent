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
