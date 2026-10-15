export { ContextWindow, limitToolResult } from './ContextWindow.js';
export { ConversationStore } from './ConversationStore.js';
export { ExplorationTracker } from './ExplorationTracker.js';
export * from './exploration/ExplorationStrategies.js';
// L6-P25 / 待决事项②④：bootstrap 生成策略在生产中不可达（src 与宿主都显式用 'analyst' / 'producer'），
// 只在公开入口上标废弃——ExplorationTracker 对未知策略名的内部回退仍直接从源文件导入，不受影响。
// 显式按名转出会覆盖上面 `export *` 中的同名绑定，运行时名字与种类不变。
export {
  /**
   * @deprecated bootstrap 生成策略无生产消费者；去留随待决事项②“公开面收窄”与④（insight/strict 链收敛）
   *   决定，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  createGenerateStrategy,
} from './exploration/ExplorationStrategies.js';
export { NudgeGenerator } from './exploration/NudgeGenerator.js';
export { PlanTracker } from './exploration/PlanTracker.js';
export {
  isSearchAction,
  /**
   * @deprecated 无任何消费者（搜索轮次判定用 isSearchAction）；随待决事项②“公开面收窄”删除，
   *   删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  SEARCH_TOOLS,
  SignalDetector,
} from './exploration/SignalDetector.js';
export {
  buildL4MemoryPackage,
  formatL4MemorySummary,
  type L4MemoryPackage,
  type L4MemoryPackageInput,
  renderL4MemoryPackage,
  validateL4Summary,
} from './l4MemoryPackage.js';
