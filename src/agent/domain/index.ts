// W6-a:本体拆归 evidence/(证据供给)与 memory/(记忆固化);本壳保持
// '@alembic/agent/domain' exports 键与名集(EpisodicConsolidator+EvidenceCollector+6 类型)
// 逐名不变——主体 recipe-pipeline/generate/completion/CompletionSteps 动态 import 消费。

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
