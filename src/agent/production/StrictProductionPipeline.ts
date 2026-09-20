/** Strict生产兼容入口。各能力按职责分层；原公开名称和Core裁决链保持。 */
export {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  type StrictAnalysisContextInputV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalysisEpochSnapshotInputV1,
  type StrictAnalysisEpochSnapshotV1,
  type StrictAnalysisEpochTransitionV1,
  type StrictAnalysisExpansionPortInputV1,
  StrictAnalysisExpansionPortV1,
  type StrictAnalysisGateOutcomeInputV1,
  type StrictAnalysisGateOutcomeV1,
  type StrictAnalysisLoopLimitsV1,
  validateStrictAnalysisEpochTransitionV1,
} from './strict/analysisLoop.js';
export {
  type CreateStrictAnalysisFixpointInputV1,
  createStrictAnalysisFixpointV1,
  type ProducerEligibleHypothesisV1,
  type StrictAnalystEpochInputV1,
  type StrictAnalystEpochV1,
  type StrictFalsificationInputV1,
  type StrictHypothesisDispositionV1,
  type StrictInductionInputV1,
  validateStrictAnalystEpochV1,
} from './strict/analyst.js';
export {
  type CreateStrictHypothesisExpressionSetReceiptInputV1,
  type CreateStrictProducerExpressionSetInputV1,
  createStrictHypothesisExpressionSetReceiptV1,
  createStrictProducerExpressionSetV1,
  type FullAuthoredProjectionV1,
  type StrictExpressionTerminalResolutionV1,
  type StrictProducerExpressionSetV1,
  type StrictProducerProposalInputV1,
  type StrictProducerProposalV1,
  type StrictProducerZeroDispositionV1,
} from './strict/expressions.js';
export { createStrictTypedGateReturnV1, validateStrictStageToolCallsV1 } from './strict/gates.js';
export {
  type CausalRepairNodeV1,
  type CreateCausalRepairNodeInputV1,
  type CreateStrictProducerLineageReceiptInputV1,
  createCausalRepairNodeV1,
  createStrictProducerLineageReceiptV1,
  type StrictProducerEvidenceProjectionV1,
  type StrictProducerLineageReceiptV1,
} from './strict/lineage.js';
