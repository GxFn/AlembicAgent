export {
  buildConsolidationGatePrompt,
  CONSOLIDATION_GATE_BUDGET,
  CONSOLIDATION_GATE_SYSTEM_PROMPT,
  CONSOLIDATION_GATE_TOOLS,
} from './consolidationGate.js';
export { EpisodicConsolidator } from './EpisodicConsolidator.js';
export type {
  CodeSnippet,
  EvidenceCollectorResult,
  EvidenceEntry,
  ExplorationEntry,
  NegativeSignal,
  ToolCall,
} from './EvidenceCollector.js';
export { EvidenceCollector } from './EvidenceCollector.js';
