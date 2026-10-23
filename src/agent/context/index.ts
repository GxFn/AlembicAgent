export { ContextWindow, limitToolResult } from './ContextWindow.js';
export { ConversationStore } from './ConversationStore.js';
export { ExplorationTracker } from './ExplorationTracker.js';
// W2a-09 / L6-P25：探索策略模块按名转出，不再用 `export *`——bootstrap 生成策略 createGenerateStrategy
// 在生产中不可达（src 与宿主都显式用 'analyst' / 'producer'），已撤出公开面；函数本体仍留在源文件，
// 只供 ExplorationTracker.resolve 对未知策略名的 bootstrap 回退直接导入。今后在 ExplorationStrategies
// 新增导出时要在这里显式决定是否公开，避免经 `export *` 静默扩大 `./context` 与根出口的名集。
export {
  DEFAULT_REFLECTION_INTERVAL,
  DEFAULT_REPLAN_INTERVAL,
  type ExplorationBudget,
  type ExplorationMetrics,
  type ExplorationPhase,
  type ExplorationStrategy,
  type ExplorationTrace,
  effectiveMemoryFindingCount,
  type FullExplorationMetrics,
  type PipelineType,
  STRATEGY_ANALYST,
  STRATEGY_PRODUCER,
  type TransitionEntry,
  type TransitionRule,
  targetMemoryFindingCount,
  targetProducerSubmitCount,
} from './exploration/ExplorationStrategies.js';
export { NudgeGenerator } from './exploration/NudgeGenerator.js';
export { PlanTracker } from './exploration/PlanTracker.js';
export { isSearchAction, SignalDetector } from './exploration/SignalDetector.js';
export {
  buildL4MemoryPackage,
  formatL4MemorySummary,
  type L4MemoryPackage,
  type L4MemoryPackageInput,
  renderL4MemoryPackage,
  validateL4Summary,
} from './l4MemoryPackage.js';
