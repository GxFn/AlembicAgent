/**
 * Memory Module — 统一导出
 *
 * Phase 2: MemoryCoordinator + legacy module re-exports
 * Phase 3: ActiveContext (合并 WorkingMemory + ReasoningTrace)
 * Phase 4: SessionStore (源自 EpisodicMemory；原合并的 ToolResultCache 只读工具缓存已随 W1-04 删除)
 * Phase 5: PersistentMemory (统一的持久化语义记忆)
 * Phase 6: MemoryStore / MemoryRetriever / MemoryConsolidator (PersistentMemory 子模块拆分)
 */

export { ActiveContext } from './ActiveContext.js';
export { MemoryConsolidator } from './MemoryConsolidator.js';
export type {
  MemoryEvidenceSearchDiagnostic,
  MemoryEvidenceSearchHit,
  MemoryEvidenceSearchResult,
  MemoryWriteFailureDiagnostic,
} from './MemoryCoordinator.js';
export { MemoryCoordinator } from './MemoryCoordinator.js';
export { MemoryEmbeddingStore } from './MemoryEmbeddingStore.js';
// W2a-09 / L6-P25：DimensionFlushManifest 与 extractHighPriorityFindings 无消费者，已删除；只保留 distill 的返回类型。
export type { DistilledContext } from './MemoryFlushContract.js';
export { MemoryRetriever } from './MemoryRetriever.js';
// PersistentMemory 子模块 — 内部拆分后的独立组件
export {
  assertMemoryStoreSchemaShape,
  MEMORY_STORE_REQUIRED_COLUMNS,
  MEMORY_STORE_SEMANTIC_TABLE,
  MemoryStore,
  MemoryStoreWriteError,
} from './MemoryStore.js';
export { PersistentMemory } from './PersistentMemory.js';
// L6-P25 / C66：SessionStore 写入方法的数据类型，纯类型导出（不增加运行时绑定，签名快照不变）；
// 宿主可直接用它们代替 `Parameters<typeof sessionStore.addDimensionDigest>[1]` 一类强转。
export type {
  DimensionDigest,
  DimensionReportInput,
  Finding,
  TierReflection,
} from './SessionStore.js';
export { SessionStore } from './SessionStore.js';
export type { SessionStoreSerialized } from './SessionStoreSchema.js';
export { validateSessionStoreShape } from './SessionStoreSchema.js';
