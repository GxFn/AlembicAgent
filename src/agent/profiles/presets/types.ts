/**
 * Preset 共享类型 —— W6-e(A2 方案甲)自 presets.ts 拆出。
 * Preset 是「profile 的运行时默认块(base runtime block)」:Capability+Strategy+Policy
 * 的命名组合,含工厂函数与闭包,受 AgentProfileRegistry.assertSerializableProfile
 * 序列化门约束**不可**内联进 profile 定义——这是 preset/profile 双层的设计原因。
 */

/** Policy factory configuration */
export interface PolicyFactoryConfig {
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  minEvidenceLength?: number;
  minFileRefs?: number;
  minToolCalls?: number;
}

/** Tool call record shape used in retry logic */
export interface ToolCallRecord {
  tool?: string;
  name?: string;
  args?: unknown;
  result?: string | { status?: string; reason?: string };
}

/** Minimal pipeline stage shape (compatible with PipelineStrategy's PipelineStage) */
export interface MinimalStage {
  name: string;
  [key: string]: unknown;
}

/** Strategy-level merge result (structurally matches StrategyResult from strategies.ts) */
export interface StrategyMergeResult {
  reply: string;
  toolCalls: Array<Record<string, unknown>>;
  tokenUsage: { input: number; output: number };
  iterations: number;
  [key: string]: unknown;
}

/** Declarative strategy configuration (resolved by resolveStrategy) */
export interface StrategyConfig {
  type: string;
  stages?: MinimalStage[];
  maxRetries?: number;
  itemStrategy?: StrategyConfig;
  tiers?: Record<string, { concurrency: number }>;
  merge?: (...args: unknown[]) => StrategyMergeResult;
  single?: StrategyConfig;
  pipeline?: StrategyConfig;
  fanOut?: StrategyConfig;
}
