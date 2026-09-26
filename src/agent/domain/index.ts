// 兼容公开入口：证据实现由 evidence/ 负责，记忆固化由 memory/ 负责。
// Main 的完成阶段仍从 @alembic/agent/domain 动态载入；此处只重导出，不复制实现。

export type {
  CodeSnippet,
  EvidenceCollectorResult,
  EvidenceEntry,
  ExplorationEntry,
  NegativeSignal,
  ToolCall,
} from '../evidence/EvidenceCollector.js';
export { EvidenceCollector } from '../evidence/EvidenceCollector.js';
export { EpisodicConsolidator } from '../memory/EpisodicConsolidator.js';
