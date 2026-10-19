/**
 * Preset 共享类型 —— W6-e(A2 方案甲)自 presets.ts 拆出。
 * Preset 是「profile 的运行时默认块(base runtime block)」:Capability+Strategy+Policy
 * 的命名组合,含工厂函数与闭包,受 AgentProfileRegistry 的声明快照校验
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

/**
 * Declarative strategy configuration (resolved by resolveStrategy)
 *
 * type 只认运行时词汇 'single' / 'pipeline' / 'fan_out'（其余抛 Unknown strategy type）；profile 声明层的
 * 'fanout' / 'preset' 模板词汇由 AgentProfileCompiler 先编译掉，不会走到这里（L8-C09）。
 */
export interface StrategyConfig {
  type: string;
  stages?: MinimalStage[];
  maxRetries?: number;
  itemStrategy?: StrategyConfig;
  tiers?: Record<string, { concurrency: number }>;
  merge?: (...args: unknown[]) => StrategyMergeResult;
  /**
   * single / pipeline / fanOut 三个字段没有读取者（L8-C09）：resolveStrategy 只按 type 分派，
   * fan_out 的子策略读 itemStrategy。仅为公开类型兼容保留，删除属于待决的公开面收窄（事项②）。
   */
  single?: StrategyConfig;
  pipeline?: StrategyConfig;
  fanOut?: StrategyConfig;
}
