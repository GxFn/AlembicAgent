import type { AgentRunResult } from '../service/AgentRunContracts.js';

/** 任务失败不撤销已经确认的兄弟/工具结果；宿主可通过 cause/partialResult 检查真实进度。 */
export function runFailure(
  result: AgentRunResult,
  message: string
): Error & { partialResult: AgentRunResult } {
  return Object.assign(new Error(message, { cause: result }), { partialResult: result });
}
