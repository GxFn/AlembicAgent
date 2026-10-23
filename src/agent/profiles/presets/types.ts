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

/**
 * Declarative strategy configuration (resolved by resolveStrategy)
 *
 * type 只认运行时词汇 'single' / 'pipeline'（其余抛 Unknown strategy type）；profile 声明层的
 * 'fanout' / 'preset' 模板词汇由 AgentProfileCompiler 先编译掉，不会走到这里（L8-C09）。
 * 'fan_out' 及其 itemStrategy / tiers / merge、从未被读取的 single / pipeline / fanOut 字段与
 * StrategyMergeResult 已随 FanOutStrategy 删除（W2a-06 / L5-P39、L8-P17）。
 */
export interface StrategyConfig {
  type: string;
  stages?: MinimalStage[];
  maxRetries?: number;
}
