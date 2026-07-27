import type * as EvaluationFacade from '@alembic/agent/evaluation';
import {
  createDurableSemanticReviewRuntime,
  createFrozenEvidenceProjection,
  type DurableSemanticReviewExecuteInputV1,
  type DurableSemanticReviewRuntimeBootstrapV1,
  DurableSemanticReviewRuntimeError,
  type DurableSemanticReviewRuntimeV1,
  type FrozenEvidenceEntryV1,
  type FrozenEvidenceProjectionV1,
  type IndependentReviewAxisV1,
  type IndependentReviewDecisionV1,
  IndependentValueReviewer,
  type IndependentValueReviewerOptionsV1,
  type IndependentValueReviewInputV1,
  type InvestigatedEmptyDecisionV1,
  InvestigatedEmptyReviewer,
  type InvestigatedEmptyReviewInputV1,
  type ReviewerIdentityV1,
  type SemanticReviewProviderV1,
  type SemanticReviewSigningKeyProviderV1,
  type SemanticReviewWitnessAuthorityBundleV1,
  type SemanticReviewWitnessAuthorityLookupV1,
  type SemanticReviewWitnessAuthorityPortV1,
} from '@alembic/agent/evaluation';
import type * as ProductionFacade from '@alembic/agent/production';
import {
  type CausalRepairNodeV1,
  type CreateStrictAnalysisFixpointInputV1,
  type CreateStrictHypothesisExpressionSetReceiptInputV1,
  type CreateStrictProducerExpressionSetInputV1,
  type CreateStrictProducerLineageReceiptInputV1,
  createProductionEvidenceLedgerAuthority,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictAnalysisGateOutcomeV1,
  createStrictHypothesisExpressionSetReceiptV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  type FullAuthoredProjectionV1,
  type ProducerEligibleHypothesisV1,
  type ProductionEvidenceLedgerAuthorityV1,
  type ProductionEvidenceLedgerCoordinatesV1,
  type ProductionEvidenceLedgerReadFacetV1,
  type StrictAnalysisContextInputV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalysisEpochSnapshotInputV1,
  type StrictAnalysisEpochSnapshotV1,
  type StrictAnalysisEpochTransitionV1,
  type StrictAnalysisExpansionPortInputV1,
  type StrictAnalysisExpansionPortV1,
  type StrictAnalysisGateOutcomeInputV1,
  type StrictAnalysisGateOutcomeV1,
  type StrictAnalysisLoopLimitsV1,
  type StrictAnalystEpochInputV1,
  type StrictAnalystEpochV1,
  type StrictExpressionTerminalResolutionV1,
  type StrictFalsificationInputV1,
  type StrictHypothesisDispositionV1,
  type StrictInductionInputV1,
  type StrictProducerEvidenceProjectionV1,
  type StrictProducerExpressionSetV1,
  type StrictProducerLineageReceiptV1,
  type StrictProducerProposalV1,
  type StrictProductionGateResultV1,
  type StrictProductionRuntimePortV1,
  validateStrictAnalysisEpochTransitionV1,
  validateStrictAnalystEpochV1,
} from '@alembic/agent/production';
import type * as RunsFacade from '@alembic/agent/runs';
import {
  type PlanContextProjectionV1,
  type RunStrictPlanAgentInput,
  runStrictPlanAgent,
} from '@alembic/agent/runs';

export interface StrictFacadePrivateSurfaceAssertions {
  // @ts-expect-error Legacy Plan execution is intentionally absent from the strict runs facade.
  readonly legacyPlanRun: typeof RunsFacade.runPlanAgent;
  // @ts-expect-error Main receives repair receipts, not the internal repair-node creator authority.
  readonly repairAuthority: typeof ProductionFacade.createCausalRepairNodeV1;
  // @ts-expect-error Stage construction remains inside Agent's profile registry.
  readonly stageBuilder: typeof ProductionFacade.buildStrictProductionPipelineStagesV1;
  // @ts-expect-error Typed gate construction remains inside PipelineStrategy.
  readonly gateAuthority: typeof ProductionFacade.createStrictTypedGateReturnV1;
  // @ts-expect-error Tool-call enforcement remains inside PipelineStrategy.
  readonly toolAuthority: typeof ProductionFacade.validateStrictStageToolCallsV1;
  // @ts-expect-error Reviewer prompt construction is not a Main consumer contract.
  readonly reviewPrompt: typeof EvaluationFacade.buildIndependentReviewPrompt;
  // @ts-expect-error Judge calibration remains an Agent evaluation implementation detail.
  readonly judgeCalibration: typeof EvaluationFacade.computeJudgeCalibration;
  // @ts-expect-error Frozen fixture providers are test/evaluation internals.
  readonly fixtureProvider: typeof EvaluationFacade.FrozenStrictProductionEvaluationProviderV1;
  // @ts-expect-error Runtime implementation and Core mint gateway stay behind the trusted factory.
  readonly durableRuntimeImplementation: typeof EvaluationFacade.DurableSemanticReviewRuntime;
  // @ts-expect-error 私有 EvidenceLedgerStore 不能从 production facade 导出。
  readonly privateLedgerStore: typeof ProductionFacade.EvidenceLedgerStore;
}

export const strictRuntimeBindings = {
  runStrictPlanAgent,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  createStrictHypothesisExpressionSetReceiptV1,
  validateStrictAnalysisEpochTransitionV1,
  validateStrictAnalystEpochV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerLineageReceiptV1,
  createStrictProducerExpressionSetV1,
  createProductionEvidenceLedgerAuthority,
  createFrozenEvidenceProjection,
  createDurableSemanticReviewRuntime,
  DurableSemanticReviewRuntimeError,
  IndependentValueReviewer,
  InvestigatedEmptyReviewer,
};

export interface StrictFacadeConsumerTypes {
  readonly planContext: PlanContextProjectionV1;
  readonly planInput: RunStrictPlanAgentInput;
  readonly analysisContextInput: StrictAnalysisContextInputV1;
  readonly analysisContext: StrictAnalysisContextProjectionV1;
  readonly analysisLoopLimits: StrictAnalysisLoopLimitsV1;
  readonly epochSnapshotInput: StrictAnalysisEpochSnapshotInputV1;
  readonly epochSnapshot: StrictAnalysisEpochSnapshotV1;
  readonly gateOutcomeInput: StrictAnalysisGateOutcomeInputV1;
  readonly gateOutcome: StrictAnalysisGateOutcomeV1;
  readonly epochTransition: StrictAnalysisEpochTransitionV1;
  readonly expansionInput: StrictAnalysisExpansionPortInputV1;
  readonly expansionPort: StrictAnalysisExpansionPortV1;
  readonly induction: StrictInductionInputV1;
  readonly disposition: StrictHypothesisDispositionV1;
  readonly falsification: StrictFalsificationInputV1;
  readonly epochInput: StrictAnalystEpochInputV1;
  readonly epoch: StrictAnalystEpochV1;
  readonly eligibleHypothesis: ProducerEligibleHypothesisV1;
  readonly fixpointInput: CreateStrictAnalysisFixpointInputV1;
  readonly evidence: StrictProducerEvidenceProjectionV1;
  readonly lineageInput: CreateStrictProducerLineageReceiptInputV1;
  readonly lineage: StrictProducerLineageReceiptV1;
  readonly repair: CausalRepairNodeV1;
  readonly authored: FullAuthoredProjectionV1;
  readonly proposal: StrictProducerProposalV1;
  readonly expressionInput: CreateStrictProducerExpressionSetInputV1;
  readonly expressionSet: StrictProducerExpressionSetV1;
  readonly expressionTerminalResolution: StrictExpressionTerminalResolutionV1;
  readonly coreExpressionInput: CreateStrictHypothesisExpressionSetReceiptInputV1;
  readonly stageGate: StrictProductionGateResultV1;
  readonly runtimePort: StrictProductionRuntimePortV1;
  readonly frozenEvidenceEntry: FrozenEvidenceEntryV1;
  readonly frozenEvidence: FrozenEvidenceProjectionV1;
  readonly durableReviewBootstrap: DurableSemanticReviewRuntimeBootstrapV1;
  readonly durableReviewExecuteInput: DurableSemanticReviewExecuteInputV1;
  readonly durableReviewRuntime: DurableSemanticReviewRuntimeV1;
  readonly productionLedgerCoordinates: ProductionEvidenceLedgerCoordinatesV1;
  readonly productionLedgerAuthority: ProductionEvidenceLedgerAuthorityV1;
  readonly durableReviewLedger: ProductionEvidenceLedgerReadFacetV1;
  readonly durableReviewProvider: SemanticReviewProviderV1;
  readonly durableReviewSigningKey: SemanticReviewSigningKeyProviderV1;
  readonly durableReviewWitnessBundle: SemanticReviewWitnessAuthorityBundleV1;
  readonly durableReviewWitnessLookup: SemanticReviewWitnessAuthorityLookupV1;
  readonly durableReviewWitnessAuthority: SemanticReviewWitnessAuthorityPortV1;
  readonly reviewerIdentity: ReviewerIdentityV1;
  readonly reviewAxis: IndependentReviewAxisV1;
  readonly reviewerOptions: IndependentValueReviewerOptionsV1;
  readonly reviewInput: IndependentValueReviewInputV1;
  readonly reviewDecision: IndependentReviewDecisionV1;
  readonly emptyInput: InvestigatedEmptyReviewInputV1;
  readonly emptyDecision: InvestigatedEmptyDecisionV1;
}
