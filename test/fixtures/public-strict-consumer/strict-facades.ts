import type * as EvaluationFacade from '@alembic/agent/evaluation';
import {
  createFrozenEvidenceProjection,
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
} from '@alembic/agent/evaluation';
import type * as ProductionFacade from '@alembic/agent/production';
import {
  type CausalRepairNodeV1,
  type CreateStrictAnalysisFixpointInputV1,
  type CreateStrictProducerExpressionSetInputV1,
  type CreateStrictProducerLineageReceiptInputV1,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  type FullAuthoredProjectionV1,
  type ProducerEligibleHypothesisV1,
  type StrictAnalysisContextInputV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalysisExpansionPortInputV1,
  type StrictAnalysisExpansionPortV1,
  type StrictAnalystEpochInputV1,
  type StrictAnalystEpochV1,
  type StrictFalsificationInputV1,
  type StrictHypothesisDispositionV1,
  type StrictInductionInputV1,
  type StrictProducerEvidenceProjectionV1,
  type StrictProducerExpressionSetV1,
  type StrictProducerLineageReceiptV1,
  type StrictProducerProposalV1,
  type StrictProductionGateResultV1,
  type StrictProductionRuntimePortV1,
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
}

export const strictRuntimeBindings = {
  runStrictPlanAgent,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisExpansionPortV1,
  validateStrictAnalystEpochV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerLineageReceiptV1,
  createStrictProducerExpressionSetV1,
  createFrozenEvidenceProjection,
  IndependentValueReviewer,
  InvestigatedEmptyReviewer,
};

export interface StrictFacadeConsumerTypes {
  readonly planContext: PlanContextProjectionV1;
  readonly planInput: RunStrictPlanAgentInput;
  readonly analysisContextInput: StrictAnalysisContextInputV1;
  readonly analysisContext: StrictAnalysisContextProjectionV1;
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
  readonly stageGate: StrictProductionGateResultV1;
  readonly runtimePort: StrictProductionRuntimePortV1;
  readonly frozenEvidenceEntry: FrozenEvidenceEntryV1;
  readonly frozenEvidence: FrozenEvidenceProjectionV1;
  readonly reviewerIdentity: ReviewerIdentityV1;
  readonly reviewAxis: IndependentReviewAxisV1;
  readonly reviewerOptions: IndependentValueReviewerOptionsV1;
  readonly reviewInput: IndependentValueReviewInputV1;
  readonly reviewDecision: IndependentReviewDecisionV1;
  readonly emptyInput: InvestigatedEmptyReviewInputV1;
  readonly emptyDecision: InvestigatedEmptyDecisionV1;
}
