import type { AgentEventBus } from '../../runtime/AgentEventBus.js';
import type { ToolCallHook } from '../../runtime/AgentRuntimeTypes.js';

/** 真实 Runtime 已有的可选观测能力；旧宿主只实现 reactLoop 仍可调用 Pipeline。 */
export interface PipelineRuntime {
  id: string;
  reactLoop(prompt: string, opts?: Record<string, unknown>): Promise<StageResult>;
  logger?: { info?: (...args: unknown[]) => void };
  bus?: Pick<AgentEventBus, 'on' | 'off'>;
  toolCallHistory?: readonly unknown[];
  onToolCall?: ToolCallHook | null;
  iterationCount?: number;
}

export interface StageResult {
  reply: string;
  toolCalls: Array<Record<string, unknown>>;
  tokenUsage: { input: number; output: number };
  iterations: number;
  timedOut?: boolean;
  aborted?: boolean;
  partial?: {
    /** null 是明确的未知，不能像缺少 partial 一样回退为零次启动。 */
    startedToolCalls: number | null;
    completedToolCalls: number;
    requiresReadback: boolean;
  };
  [key: string]: unknown;
}
