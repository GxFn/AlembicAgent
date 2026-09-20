/** Analyst语义回执、重建验证与fixpoint；外层hash相同不替代Core事实再验证。 */
import {
  type AnalysisFixpointReceiptV1,
  assertKnowledgeDispositionReviewV1,
  type CounterqueryExecutionV1,
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAnalysisFixpointReceiptV1,
  createFalsificationReceiptV1,
  createInductionReceiptV1,
  type FactQueryExecutionReceiptV1,
  type FalsificationReceiptV1,
  type FinalExpandedMiningScheduleReceiptV1,
  type HypothesisV1,
  hashKnowledgeClusterV1,
  type InductionReceiptV1,
  type KnowledgeClusterInputV1,
  type KnowledgeClusterSetV1,
  type KnowledgeDispositionReviewV1,
  type ObservationPopulationInputV1,
  type ObservationPopulationV1,
} from '@alembic/core/production';
import {
  assertSameIds,
  fail,
  freeze,
  hashCanonical,
  hashCoreCanonical,
  normalizeIds,
  requireCoreHash,
} from './primitives.js';

export interface StrictInductionInputV1 {
  readonly mechanismKey: string;
  readonly mode: 'recurring' | 'bounded-singleton';
  readonly hypotheses: readonly HypothesisV1[];
  readonly zeroHypothesisReason?: InductionReceiptV1['zeroHypothesisReason'];
  readonly zeroHypothesisDispositionReview?: KnowledgeDispositionReviewV1;
}

export interface StrictHypothesisDispositionV1 {
  readonly hypothesisId: string;
  readonly status: 'survived' | 'narrowed' | 'refuted' | 'unknown';
  readonly causalParentHypothesisId?: string;
}

export interface StrictFalsificationInputV1 {
  readonly hypothesisId: string;
  readonly enrolledCounterqueryIds: readonly string[];
  readonly executions: readonly CounterqueryExecutionV1[];
  readonly counterqueryApplicability: Omit<
    FalsificationReceiptV1['counterqueryApplicability'],
    'reviewerReceiptId'
  >;
  readonly dispositionReview: KnowledgeDispositionReviewV1;
}

export interface StrictAnalystEpochInputV1 {
  /**
   * 这是 Core 的 analysis review context，不是最终 fixpoint receipt hash。调用者可以预先计算，
   * 但 createStrictAnalysisFixpointV1 会用完整 schedule/population/cluster 集重新计算并对账。
   */
  readonly currentAnalysisFixpointHash: string;
  readonly knownFactIds: readonly string[];
  readonly enrolledObligationIds: readonly string[];
  readonly population: ObservationPopulationInputV1;
  readonly clusterInputs: readonly KnowledgeClusterInputV1[];
  readonly nonClusteredDispositions: readonly {
    readonly observationId: string;
    readonly status: 'discarded' | 'unresolved';
    readonly reasonCode: string;
    readonly dispositionReview?: KnowledgeDispositionReviewV1;
    readonly owner?: string;
    readonly resumePoint?: string;
  }[];
  readonly inductionInputs: readonly StrictInductionInputV1[];
  readonly falsificationInputs: readonly StrictFalsificationInputV1[];
  readonly hypothesisDispositions: readonly StrictHypothesisDispositionV1[];
  /** 精确 review ledger；必须与上述 consumer 实际嵌入的 review 一一相等，额外行即 orphan。 */
  readonly dispositionReviews: readonly KnowledgeDispositionReviewV1[];
}

export interface ProducerEligibleHypothesisV1 extends HypothesisV1 {
  readonly status: 'survived' | 'narrowed';
  readonly dispositionReviewReceiptId: string;
  readonly causalParentHypothesisId?: string;
}

export interface StrictAnalystEpochV1 {
  readonly schemaVersion: 1;
  readonly currentAnalysisFixpointHash: string;
  /** population complete authority 的真实 Core execution receipts；不允许仅保留平行 hash 数组。 */
  readonly executionReceipts: readonly FactQueryExecutionReceiptV1[];
  readonly population: ObservationPopulationV1;
  readonly clusterSet: KnowledgeClusterSetV1;
  readonly inductions: readonly InductionReceiptV1[];
  readonly falsifications: readonly FalsificationReceiptV1[];
  readonly dispositionReviews: readonly KnowledgeDispositionReviewV1[];
  readonly hypothesisDispositions: readonly StrictHypothesisDispositionV1[];
  readonly producerEligibleHypotheses: readonly ProducerEligibleHypothesisV1[];
  readonly epochHash: string;
}

export function validateStrictAnalystEpochV1(
  input: StrictAnalystEpochInputV1
): StrictAnalystEpochV1 {
  requireCoreHash(input.currentAnalysisFixpointHash, 'STRICT_ANALYST_REVIEW_CONTEXT_HASH_INVALID');
  rejectLegacySemanticAuthority(input);
  const { executionReceipts, knownFactIds, population } = validateStrictPopulationAuthority(input);
  const clusterSet = createStrictClusterSet(input, population);
  const inductions = createStrictInductions(input, population, clusterSet, knownFactIds);
  const hypotheses = indexStrictHypotheses(inductions);
  const falsifications = createStrictFalsifications(input, hypotheses, knownFactIds);
  const dispositionReviews = validateDispositionReviewConservation(
    input,
    population.populationHash
  );
  const { dispositions, producerEligibleHypotheses } = resolveStrictHypothesisDispositions(
    input,
    hypotheses,
    falsifications
  );
  const semantic = {
    schemaVersion: 1 as const,
    currentAnalysisFixpointHash: input.currentAnalysisFixpointHash,
    executionReceipts,
    population,
    clusterSet,
    inductions,
    falsifications,
    dispositionReviews,
    hypothesisDispositions: dispositions,
    producerEligibleHypotheses,
  };
  return freeze({ ...semantic, epochHash: hashCanonical(semantic) });
}

function validateStrictPopulationAuthority(input: StrictAnalystEpochInputV1): {
  readonly knownFactIds: ReadonlySet<string>;
  readonly population: ObservationPopulationV1;
  readonly executionReceipts: readonly FactQueryExecutionReceiptV1[];
} {
  const knownFactIds = new Set(normalizeIds(input.knownFactIds, 'knownFactIds'));
  for (const observation of input.population.observations) {
    if (
      observation.factIds.length === 0 ||
      observation.factIds.some((factId) => !knownFactIds.has(factId))
    ) {
      fail('STRICT_ANALYST_FACT_INVENTED', observation.observationId);
    }
  }
  const dispositionObservations = [
    ...input.population.duplicateObservations,
    ...input.population.excludedObservations,
    ...input.population.errorObservations,
  ];
  for (const observation of dispositionObservations) {
    if (observation.factIds.some((factId) => !knownFactIds.has(factId))) {
      fail('STRICT_ANALYST_FACT_INVENTED', observation.observationId);
    }
  }
  const population = canonicalizeObservationPopulationV1(input.population);
  if (population.completion !== 'complete') {
    fail('STRICT_ANALYST_POPULATION_INCOMPLETE');
  }
  const executionReceipts = [...(input.population.executionReceipts ?? [])].sort((left, right) =>
    left.obligationId.localeCompare(right.obligationId)
  );
  if (executionReceipts.length === 0) {
    fail('STRICT_ANALYST_EXECUTION_RECEIPTS_REQUIRED');
  }
  return { executionReceipts, knownFactIds, population };
}

function createStrictClusterSet(
  input: StrictAnalystEpochInputV1,
  population: ObservationPopulationV1
): KnowledgeClusterSetV1 {
  return canonicalizeKnowledgeClustersV1(population, {
    clusters: input.clusterInputs,
    nonClusteredDispositions: input.nonClusteredDispositions,
  });
}

function createStrictInductions(
  input: StrictAnalystEpochInputV1,
  population: ObservationPopulationV1,
  clusterSet: KnowledgeClusterSetV1,
  knownFactIds: ReadonlySet<string>
): InductionReceiptV1[] {
  const clustersByMechanism = new Map<string, KnowledgeClusterSetV1['clusters'][number]>();
  for (const cluster of clusterSet.clusters) {
    if (clustersByMechanism.has(cluster.mechanismKey)) {
      fail('STRICT_ANALYST_CLUSTER_MECHANISM_DUPLICATE', cluster.mechanismKey);
    }
    clustersByMechanism.set(cluster.mechanismKey, cluster);
  }
  const receipts = input.inductionInputs.map((induction) => {
    const cluster = clustersByMechanism.get(induction.mechanismKey);
    if (!cluster) {
      fail('STRICT_ANALYST_INDUCTION_CLUSTER_UNKNOWN', induction.mechanismKey);
    }
    for (const hypothesis of induction.hypotheses) {
      if (hypothesis.premiseFactIds.some((factId) => !knownFactIds.has(factId))) {
        fail('STRICT_ANALYST_HYPOTHESIS_FACT_INVENTED', hypothesis.hypothesisId);
      }
    }
    return createInductionReceiptV1({
      populationHash: population.populationHash,
      clusterHash: hashKnowledgeClusterV1(cluster),
      clusterId: cluster.clusterId,
      observationIds: cluster.observationIds,
      mode: induction.mode,
      hypotheses: induction.hypotheses,
      currentAnalysisFixpointHash: input.currentAnalysisFixpointHash,
      ...(induction.zeroHypothesisReason
        ? { zeroHypothesisReason: induction.zeroHypothesisReason }
        : {}),
      ...(induction.zeroHypothesisDispositionReview
        ? { zeroHypothesisDispositionReview: induction.zeroHypothesisDispositionReview }
        : {}),
    });
  });
  assertSameIds(
    receipts.map((receipt) => receipt.clusterId),
    clusterSet.clusters.map((cluster) => cluster.clusterId),
    'STRICT_ANALYST_INDUCTION_CLUSTER_CONSERVATION'
  );
  return receipts;
}

function indexStrictHypotheses(
  inductions: readonly InductionReceiptV1[]
): Map<string, HypothesisV1> {
  const hypotheses = new Map(
    inductions.flatMap((induction) =>
      induction.hypotheses.map((hypothesis) => [hypothesis.hypothesisId, hypothesis] as const)
    )
  );
  if (
    hypotheses.size !==
    inductions.reduce((count, induction) => count + induction.hypotheses.length, 0)
  ) {
    fail('STRICT_ANALYST_HYPOTHESIS_DUPLICATE');
  }
  return hypotheses;
}

function createStrictFalsifications(
  input: StrictAnalystEpochInputV1,
  hypotheses: ReadonlyMap<string, HypothesisV1>,
  knownFactIds: ReadonlySet<string>
): FalsificationReceiptV1[] {
  const externallyEnrolled = new Set(
    normalizeIds(input.enrolledObligationIds, 'enrolledObligationIds')
  );
  const receipts = input.falsificationInputs.map((candidate) => {
    if (!hypotheses.has(candidate.hypothesisId)) {
      fail('STRICT_ANALYST_FALSIFICATION_HYPOTHESIS_UNKNOWN', candidate.hypothesisId);
    }
    if (candidate.enrolledCounterqueryIds.some((id) => !externallyEnrolled.has(id))) {
      fail('STRICT_ANALYSIS_QUERY_UNENROLLED', candidate.hypothesisId);
    }
    if (
      candidate.executions.some((execution) =>
        execution.counterexampleFactIds.some((factId) => !knownFactIds.has(factId))
      )
    ) {
      fail('STRICT_ANALYST_COUNTEREXAMPLE_FACT_INVENTED', candidate.hypothesisId);
    }
    return createFalsificationReceiptV1({
      ...candidate,
      counterqueryApplicability: {
        ...candidate.counterqueryApplicability,
        reviewerReceiptId: candidate.dispositionReview.reviewReceiptId,
      },
      currentAnalysisFixpointHash: input.currentAnalysisFixpointHash,
    });
  });
  assertSameIds(
    receipts.map((receipt) => receipt.hypothesisId),
    [...hypotheses.keys()],
    'STRICT_ANALYST_FALSIFICATION_CONSERVATION'
  );
  return receipts;
}

function resolveStrictHypothesisDispositions(
  input: StrictAnalystEpochInputV1,
  hypotheses: ReadonlyMap<string, HypothesisV1>,
  falsifications: readonly FalsificationReceiptV1[]
): {
  readonly dispositions: readonly StrictHypothesisDispositionV1[];
  readonly producerEligibleHypotheses: readonly ProducerEligibleHypothesisV1[];
} {
  // 外部解码结果不受 TS union 约束；非法标签不能绕过 unknown 的 fixpoint 失败路径。
  for (const disposition of input.hypothesisDispositions) {
    if (!['survived', 'narrowed', 'refuted', 'unknown'].includes(disposition.status)) {
      fail('STRICT_ANALYST_HYPOTHESIS_DISPOSITION_INVALID', disposition.hypothesisId);
    }
  }
  const falsificationByHypothesis = new Map(
    falsifications.map((receipt) => [receipt.hypothesisId, receipt])
  );
  const dispositions = [...input.hypothesisDispositions].sort((left, right) =>
    left.hypothesisId.localeCompare(right.hypothesisId)
  );
  if (
    new Set(dispositions.map((row) => row.hypothesisId)).size !== dispositions.length ||
    dispositions.length !== hypotheses.size ||
    dispositions.some((row) => !hypotheses.has(row.hypothesisId))
  ) {
    fail('STRICT_ANALYST_HYPOTHESIS_DISPOSITION_CONSERVATION');
  }
  const producerEligibleHypotheses: ProducerEligibleHypothesisV1[] = [];
  for (const disposition of dispositions) {
    const hypothesis = hypotheses.get(disposition.hypothesisId);
    const falsification = falsificationByHypothesis.get(disposition.hypothesisId);
    if (!hypothesis || !falsification) {
      fail('STRICT_ANALYST_FALSIFICATION_REQUIRED', disposition.hypothesisId);
    }
    if (disposition.status === 'refuted' && falsification.verdict !== 'refuted') {
      fail('STRICT_ANALYST_REFUTATION_MISMATCH', disposition.hypothesisId);
    }
    if (disposition.status === 'unknown' && falsification.verdict !== 'unknown') {
      fail('STRICT_ANALYST_UNKNOWN_MISMATCH', disposition.hypothesisId);
    }
    if (disposition.status === 'survived' || disposition.status === 'narrowed') {
      if (falsification.verdict !== 'survived' && falsification.verdict !== 'not-required') {
        fail('STRICT_ANALYST_PRODUCER_ELIGIBILITY_INVALID', disposition.hypothesisId);
      }
      if (disposition.status === 'narrowed' && !disposition.causalParentHypothesisId) {
        fail('STRICT_ANALYST_NARROWING_PARENT_REQUIRED', disposition.hypothesisId);
      }
      producerEligibleHypotheses.push({
        ...hypothesis,
        status: disposition.status,
        dispositionReviewReceiptId: falsification.dispositionReviewReceiptId,
        ...(disposition.causalParentHypothesisId
          ? { causalParentHypothesisId: disposition.causalParentHypothesisId }
          : {}),
      });
    }
  }
  return { dispositions, producerEligibleHypotheses };
}

export interface CreateStrictAnalysisFixpointInputV1 {
  readonly finalExpandedSchedule: FinalExpandedMiningScheduleReceiptV1;
  readonly terminalObligations: AnalysisFixpointReceiptV1['terminalObligations'];
  readonly epochs: readonly StrictAnalystEpochV1[];
}

/** 通过 Core 的 schedule-conservation fixpoint 门关闭 append-only Analyst epochs。 */
export function createStrictAnalysisFixpointV1(
  input: CreateStrictAnalysisFixpointInputV1
): AnalysisFixpointReceiptV1 {
  if (input.epochs.length === 0) {
    fail('STRICT_ANALYSIS_FIXPOINT_EPOCH_REQUIRED');
  }
  for (const epoch of input.epochs) {
    assertStrictAnalystEpochIntegrity(epoch);
  }
  if (
    input.epochs.some((epoch) =>
      epoch.hypothesisDispositions.some((disposition) => disposition.status === 'unknown')
    )
  ) {
    fail('STRICT_ANALYSIS_FIXPOINT_HYPOTHESIS_UNRESOLVED');
  }
  const fixpoint = createAnalysisFixpointReceiptV1({
    finalExpandedSchedule: input.finalExpandedSchedule,
    terminalObligations: input.terminalObligations,
    populationHashes: input.epochs.map((epoch) => epoch.population.populationHash),
    clusterSets: input.epochs.map((epoch) => epoch.clusterSet),
    inductionReceiptHashes: input.epochs.flatMap((epoch) =>
      epoch.inductions.map((receipt) => receipt.receiptHash)
    ),
    falsificationReceiptHashes: input.epochs.flatMap((epoch) =>
      epoch.falsifications.map((receipt) => receipt.receiptHash)
    ),
  });
  for (const epoch of input.epochs) {
    if (
      epoch.currentAnalysisFixpointHash !== fixpoint.analysisReviewContextHash ||
      epoch.inductions.some(
        (receipt) => receipt.currentAnalysisFixpointHash !== fixpoint.analysisReviewContextHash
      ) ||
      epoch.falsifications.some(
        (receipt) => receipt.currentAnalysisFixpointHash !== fixpoint.analysisReviewContextHash
      ) ||
      epoch.dispositionReviews.some(
        (review) =>
          review.currentAnalysisFixpointHash !== fixpoint.analysisReviewContextHash ||
          review.populationHash !== epoch.population.populationHash
      )
    ) {
      fail('STRICT_ANALYSIS_FIXPOINT_REVIEW_CONTEXT_MISMATCH');
    }
  }
  return fixpoint;
}

export function assertStrictAnalystEpochIntegrity(epoch: StrictAnalystEpochV1): void {
  const rebuilt = rebuildStrictAnalystEpoch(epoch);
  if (epoch.schemaVersion !== 1 || rebuilt.epochHash !== epoch.epochHash) {
    fail('STRICT_PRODUCER_LINEAGE_EPOCH_HASH_MISMATCH');
  }
}

/**
 * epochHash 不是 authority。跨进程收到 epoch 后必须把 population/cluster/induction/
 * falsification/review 全部送回公开 Core constructors，避免调用者重算外层 hash 自证。
 */
function rebuildStrictAnalystEpoch(epoch: StrictAnalystEpochV1): StrictAnalystEpochV1 {
  const knownFactIds = new Set([
    ...epoch.population.observations.flatMap((row) => row.factIds),
    ...epoch.population.duplicateObservations.flatMap((row) => row.factIds),
    ...epoch.population.excludedObservations.flatMap((row) => row.factIds),
    ...epoch.population.errorObservations.flatMap((row) => row.factIds),
    ...epoch.falsifications.flatMap((receipt) =>
      receipt.executions.flatMap((execution) => execution.counterexampleFactIds)
    ),
  ]);
  const enrolledObligationIds = new Set([
    ...epoch.executionReceipts.map((receipt) => receipt.obligationId),
    ...epoch.falsifications.flatMap((receipt) => receipt.enrolledCounterqueryIds),
  ]);
  return validateStrictAnalystEpochV1({
    currentAnalysisFixpointHash: epoch.currentAnalysisFixpointHash,
    knownFactIds: [...knownFactIds],
    enrolledObligationIds: [...enrolledObligationIds],
    population: {
      ...epoch.population,
      executionReceipts: epoch.executionReceipts,
    },
    clusterInputs: rebuildClusterInputs(epoch),
    nonClusteredDispositions: rebuildNonClusteredDispositions(epoch),
    inductionInputs: rebuildInductionInputs(epoch),
    falsificationInputs: rebuildFalsificationInputs(epoch),
    hypothesisDispositions: epoch.hypothesisDispositions,
    dispositionReviews: epoch.dispositionReviews,
  });
}

function rebuildClusterInputs(epoch: StrictAnalystEpochV1): KnowledgeClusterInputV1[] {
  return epoch.clusterSet.clusters.map((cluster) => ({
    mechanismKey: cluster.mechanismKey,
    mechanism: cluster.mechanism,
    observationIds: cluster.observationIds,
    mechanismEvidenceFactIds: cluster.mechanismEvidenceFactIds,
    anatomyLensIds: cluster.anatomyLensIds,
  }));
}

function rebuildNonClusteredDispositions(
  epoch: StrictAnalystEpochV1
): StrictAnalystEpochInputV1['nonClusteredDispositions'] {
  return epoch.clusterSet.dispositions
    .filter((row) => row.status !== 'clustered')
    .map((row) => ({
      observationId: row.observationId,
      status: row.status as 'discarded' | 'unresolved',
      reasonCode: row.reasonCode ?? '',
      ...(row.reviewerReceiptId
        ? {
            dispositionReview: findDispositionReview(
              epoch.dispositionReviews,
              row.reviewerReceiptId
            ),
          }
        : {}),
      ...(row.owner ? { owner: row.owner } : {}),
      ...(row.resumePoint ? { resumePoint: row.resumePoint } : {}),
    }));
}

function rebuildInductionInputs(
  epoch: StrictAnalystEpochV1
): StrictAnalystEpochInputV1['inductionInputs'] {
  const clusterById = new Map(
    epoch.clusterSet.clusters.map((cluster) => [cluster.clusterId, cluster])
  );
  return epoch.inductions.map((receipt) => {
    const cluster = clusterById.get(receipt.clusterId);
    if (!cluster) {
      fail('STRICT_PRODUCER_LINEAGE_EPOCH_CLUSTER_MISSING', receipt.clusterId);
    }
    return {
      mechanismKey: cluster.mechanismKey,
      mode: receipt.mode,
      hypotheses: receipt.hypotheses,
      ...(receipt.zeroHypothesisReason
        ? { zeroHypothesisReason: receipt.zeroHypothesisReason }
        : {}),
      ...(receipt.zeroHypothesisReviewReceiptId
        ? {
            zeroHypothesisDispositionReview: findDispositionReview(
              epoch.dispositionReviews,
              receipt.zeroHypothesisReviewReceiptId
            ),
          }
        : {}),
    };
  });
}

function rebuildFalsificationInputs(
  epoch: StrictAnalystEpochV1
): StrictAnalystEpochInputV1['falsificationInputs'] {
  return epoch.falsifications.map((receipt) => {
    const { reviewerReceiptId: _reviewerReceiptId, ...counterqueryApplicability } =
      receipt.counterqueryApplicability;
    return {
      hypothesisId: receipt.hypothesisId,
      enrolledCounterqueryIds: receipt.enrolledCounterqueryIds,
      executions: receipt.executions,
      counterqueryApplicability,
      dispositionReview: findDispositionReview(
        epoch.dispositionReviews,
        receipt.dispositionReviewReceiptId
      ),
    };
  });
}

function findDispositionReview(
  reviews: readonly KnowledgeDispositionReviewV1[],
  reviewReceiptId: string
): KnowledgeDispositionReviewV1 {
  const review = reviews.find((candidate) => candidate.reviewReceiptId === reviewReceiptId);
  if (!review) {
    fail('STRICT_PRODUCER_LINEAGE_EPOCH_REVIEW_MISSING', reviewReceiptId);
  }
  return review;
}

function rejectLegacySemanticAuthority(input: StrictAnalystEpochInputV1): void {
  for (const induction of input.inductionInputs) {
    if (Object.hasOwn(induction, 'zeroHypothesisReviewReceiptId')) {
      fail('STRICT_ANALYST_STRING_REVIEW_AUTHORITY_FORBIDDEN');
    }
  }
  for (const disposition of input.nonClusteredDispositions) {
    if (Object.hasOwn(disposition, 'reviewerReceiptId')) {
      fail('STRICT_ANALYST_STRING_REVIEW_AUTHORITY_FORBIDDEN');
    }
  }
  for (const falsification of input.falsificationInputs) {
    if (Object.hasOwn(falsification.counterqueryApplicability, 'reviewerReceiptId')) {
      fail('STRICT_ANALYST_STRING_REVIEW_AUTHORITY_FORBIDDEN');
    }
  }
  for (const disposition of input.hypothesisDispositions) {
    if (Object.hasOwn(disposition, 'reviewerReceiptId')) {
      fail('STRICT_ANALYST_STRING_REVIEW_AUTHORITY_FORBIDDEN');
    }
  }
}

function validateDispositionReviewConservation(
  input: StrictAnalystEpochInputV1,
  populationHash: string
): KnowledgeDispositionReviewV1[] {
  const consumed = [
    ...input.nonClusteredDispositions.flatMap((row) =>
      row.dispositionReview ? [row.dispositionReview] : []
    ),
    ...input.inductionInputs.flatMap((row) =>
      row.zeroHypothesisDispositionReview ? [row.zeroHypothesisDispositionReview] : []
    ),
    ...input.falsificationInputs.map((row) => row.dispositionReview),
  ];
  const declared = [...input.dispositionReviews];
  for (const review of [...consumed, ...declared]) {
    assertKnowledgeDispositionReviewV1(review);
    if (
      review.populationHash !== populationHash ||
      review.currentAnalysisFixpointHash !== input.currentAnalysisFixpointHash
    ) {
      fail('STRICT_ANALYST_DISPOSITION_REVIEW_BINDING_MISMATCH');
    }
  }
  if (
    new Set(consumed.map((review) => review.reviewReceiptId)).size !== consumed.length ||
    new Set(declared.map((review) => review.reviewReceiptId)).size !== declared.length
  ) {
    fail('STRICT_ANALYST_DISPOSITION_REVIEW_REUSED');
  }
  const consumedById = new Map(consumed.map((review) => [review.reviewReceiptId, review]));
  const declaredById = new Map(declared.map((review) => [review.reviewReceiptId, review]));
  assertSameIds(
    [...declaredById.keys()],
    [...consumedById.keys()],
    'STRICT_ANALYST_DISPOSITION_REVIEW_CONSERVATION'
  );
  for (const [reviewReceiptId, review] of consumedById) {
    if (declaredById.get(reviewReceiptId)?.receiptHash !== review.receiptHash) {
      fail('STRICT_ANALYST_DISPOSITION_REVIEW_REBOUND', reviewReceiptId);
    }
  }
  return [...declared].sort((left, right) =>
    left.reviewReceiptId.localeCompare(right.reviewReceiptId)
  );
}

export function assertAnalysisFixpointIntegrity(fixpoint: AnalysisFixpointReceiptV1): void {
  const { fixpointHash, ...semantic } = fixpoint;
  if (fixpoint.schemaVersion !== 1 || hashCoreCanonical(semantic) !== fixpointHash) {
    fail('STRICT_PRODUCER_LINEAGE_FIXPOINT_HASH_MISMATCH');
  }
}
