import { createHash } from 'node:crypto';
import {
  type AnalysisFixpointReceiptV1,
  type AnalysisScheduleExpansionRowV1,
  assertKnowledgeDispositionReviewV1,
  type CounterqueryExecutionV1,
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAnalysisFixpointReceiptV1,
  createFalsificationReceiptV1,
  createFinalExpandedMiningScheduleReceiptV1,
  createInductionReceiptV1,
  createTypedGateReturnV1,
  type FactQueryExecutionReceiptV1,
  type FalsificationReceiptV1,
  type FinalExpandedMiningScheduleReceiptV1,
  type HypothesisExpressionRowV1,
  type HypothesisExpressionSetReceiptV1,
  type HypothesisV1,
  hashKnowledgeClusterV1,
  hashKnowledgeDispositionProposalV1,
  type InductionReceiptV1,
  type KnowledgeClusterInputV1,
  type KnowledgeClusterSetV1,
  type KnowledgeDispositionReviewV1,
  type ObservationPopulationInputV1,
  type ObservationPopulationV1,
  type TypedGateReturnInputV1,
  type TypedGateReturnV1,
  validateAnalysisScheduleExpansionV1,
  validateHypothesisExpressionSetReceiptV1,
} from '@alembic/core/production';

/**
 * 严格 Agent 阶段只携带 Core 产生的不可变 ID 与 hash。该投影是上下文白名单，不是第二证据库。
 */
export interface StrictAnalysisContextProjectionV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly journalId: string;
  readonly manifestHash: string;
  readonly planCognitionHash: string;
  readonly planHash: string;
  readonly requiredUniverseHash: string;
  readonly baselineScheduleHash: string;
  readonly expansionHeadHash: string | null;
  readonly currentExpandedScheduleHash: string;
  readonly finalExpandedScheduleHash: string | null;
  readonly analysisFixpointHash: string | null;
  readonly privateCorpusRevision: string | null;
  readonly hypothesisExpressionSetHash: string | null;
  readonly lensBindingsHash: string;
  readonly sourceArtifactHash: string;
  readonly sourceRevisionVectorHash: string;
  readonly questionIds: readonly string[];
  readonly factQueryObligationIds: readonly string[];
  readonly analysisUnitIds: readonly string[];
  readonly factIds: readonly string[];
  readonly witnessIds: readonly string[];
  readonly populationHashes: readonly string[];
  readonly clusterSetHashes: readonly string[];
  readonly inductionReceiptHashes: readonly string[];
  readonly hypothesisIds: readonly string[];
  readonly falsificationReceiptHashes: readonly string[];
  readonly dispositionReviewIds: readonly string[];
  readonly evidenceEntryIds: readonly string[];
  readonly derivedFindingCount: 0;
  readonly contextHash: string;
}

export type StrictAnalysisContextInputV1 = Omit<
  StrictAnalysisContextProjectionV1,
  'schemaVersion' | 'contextHash'
>;

const REQUIRED_CONTEXT_TEXT_FIELDS = [
  'runId',
  'journalId',
  'manifestHash',
  'planCognitionHash',
  'planHash',
  'requiredUniverseHash',
  'baselineScheduleHash',
  'currentExpandedScheduleHash',
  'lensBindingsHash',
  'sourceArtifactHash',
  'sourceRevisionVectorHash',
] as const;

const CONTEXT_ARRAY_FIELDS = [
  'questionIds',
  'factQueryObligationIds',
  'analysisUnitIds',
  'factIds',
  'witnessIds',
  'populationHashes',
  'clusterSetHashes',
  'inductionReceiptHashes',
  'hypothesisIds',
  'falsificationReceiptHashes',
  'dispositionReviewIds',
  'evidenceEntryIds',
] as const;

export function createStrictAnalysisContextProjectionV1(
  input: StrictAnalysisContextInputV1
): StrictAnalysisContextProjectionV1 {
  for (const field of REQUIRED_CONTEXT_TEXT_FIELDS) {
    requireText(input[field], `STRICT_CONTEXT_${field.toUpperCase()}_REQUIRED`);
  }
  if (input.derivedFindingCount !== 0) {
    fail('STRICT_CONTEXT_DERIVED_FINDING_FORBIDDEN');
  }
  const normalizedArrays = CONTEXT_ARRAY_FIELDS.reduce(
    (result, field) => {
      result[field] = normalizeIds(input[field], field);
      return result;
    },
    {} as Record<(typeof CONTEXT_ARRAY_FIELDS)[number], readonly string[]>
  );
  const semantic = {
    schemaVersion: 1 as const,
    runId: input.runId,
    journalId: input.journalId,
    manifestHash: input.manifestHash,
    planCognitionHash: input.planCognitionHash,
    planHash: input.planHash,
    requiredUniverseHash: input.requiredUniverseHash,
    baselineScheduleHash: input.baselineScheduleHash,
    expansionHeadHash: input.expansionHeadHash,
    currentExpandedScheduleHash: input.currentExpandedScheduleHash,
    finalExpandedScheduleHash: input.finalExpandedScheduleHash,
    analysisFixpointHash: input.analysisFixpointHash,
    privateCorpusRevision: input.privateCorpusRevision,
    hypothesisExpressionSetHash: input.hypothesisExpressionSetHash,
    lensBindingsHash: input.lensBindingsHash,
    sourceArtifactHash: input.sourceArtifactHash,
    sourceRevisionVectorHash: input.sourceRevisionVectorHash,
    ...normalizedArrays,
    derivedFindingCount: 0 as const,
  };
  return freeze({ ...semantic, contextHash: hashCanonical(semantic) });
}

export interface StrictAnalysisLoopLimitsV1 {
  readonly maxEpochs: number;
  readonly maxObligations: number;
}

export interface StrictAnalysisEpochSnapshotInputV1 {
  readonly epoch: number;
  readonly context: StrictAnalysisContextProjectionV1;
  readonly populations: readonly unknown[];
  readonly terminalObligationIds: readonly string[];
  readonly outstandingObligationIds: readonly string[];
}

/**
 * 每次 Analyst 调用只观察一个不可变 epoch 快照。population payload 会进入 snapshot hash，
 * 而事实/日程 authority 仍来自经过 hash 校验的 StrictAnalysisContextProjectionV1。
 */
export interface StrictAnalysisEpochSnapshotV1 extends StrictAnalysisEpochSnapshotInputV1 {
  readonly schemaVersion: 1;
  readonly snapshotHash: string;
}

export function createStrictAnalysisEpochSnapshotV1(
  input: StrictAnalysisEpochSnapshotInputV1
): StrictAnalysisEpochSnapshotV1 {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
    fail('STRICT_ANALYSIS_EPOCH_INVALID');
  }
  assertStrictContextIntegrity(input.context);
  const terminalObligationIds = normalizeIds(input.terminalObligationIds, 'terminalObligationIds');
  const outstandingObligationIds = normalizeIds(
    input.outstandingObligationIds,
    'outstandingObligationIds'
  );
  if (terminalObligationIds.some((id) => outstandingObligationIds.includes(id))) {
    fail('STRICT_ANALYSIS_OBLIGATION_STATE_CONFLICT');
  }
  assertSameIds(
    [...terminalObligationIds, ...outstandingObligationIds],
    input.context.factQueryObligationIds,
    'STRICT_ANALYSIS_OBLIGATION_STATE_CONSERVATION'
  );
  const semantic = {
    schemaVersion: 1 as const,
    epoch: input.epoch,
    context: input.context,
    populations: [...input.populations],
    terminalObligationIds,
    outstandingObligationIds,
  };
  return freeze({ ...semantic, snapshotHash: hashCanonical(semantic) });
}

export interface StrictAnalysisGateOutcomeInputV1 {
  readonly action: 'pass' | 'analysis_retry' | 'reject';
  readonly reasonCode: string;
  readonly observedEpochHash: string;
  readonly enrolledObligationIds?: readonly string[];
  readonly executedObligationIds?: readonly string[];
  readonly artifact?: unknown;
}

/**
 * strict fixpoint gate 只接受这一种判定形状。analysis_retry 不是 legacy 分数重试：
 * 它必须同时列出新登记且已执行的 obligation，随后由 epoch transition 再验 append-only 进展。
 */
export interface StrictAnalysisGateOutcomeV1 {
  readonly kind: 'StrictAnalysisGateOutcomeV1';
  readonly schemaVersion: 1;
  readonly action: StrictAnalysisGateOutcomeInputV1['action'];
  readonly pass: boolean;
  readonly reasonCode: string;
  readonly observedEpochHash: string;
  readonly enrolledObligationIds: readonly string[];
  readonly executedObligationIds: readonly string[];
  readonly artifact: unknown;
  readonly outcomeHash: string;
}

export function createStrictAnalysisGateOutcomeV1(
  input: StrictAnalysisGateOutcomeInputV1
): StrictAnalysisGateOutcomeV1 {
  requireText(input.reasonCode, 'STRICT_ANALYSIS_GATE_REASON_REQUIRED');
  requireText(input.observedEpochHash, 'STRICT_ANALYSIS_GATE_EPOCH_HASH_REQUIRED');
  const enrolledObligationIds = normalizeIds(
    input.enrolledObligationIds ?? [],
    'enrolledObligationIds'
  );
  const executedObligationIds = normalizeIds(
    input.executedObligationIds ?? [],
    'executedObligationIds'
  );
  if (input.action === 'analysis_retry') {
    if (enrolledObligationIds.length === 0) {
      fail('STRICT_ANALYSIS_RETRY_OBLIGATION_REQUIRED');
    }
    assertSameIds(
      enrolledObligationIds,
      executedObligationIds,
      'STRICT_ANALYSIS_RETRY_EXECUTION_CONSERVATION'
    );
  } else if (enrolledObligationIds.length > 0 || executedObligationIds.length > 0) {
    fail('STRICT_ANALYSIS_NON_RETRY_OBLIGATION_FORBIDDEN');
  }
  const semantic = {
    kind: 'StrictAnalysisGateOutcomeV1' as const,
    schemaVersion: 1 as const,
    action: input.action,
    pass: input.action === 'pass',
    reasonCode: input.reasonCode,
    observedEpochHash: input.observedEpochHash,
    enrolledObligationIds,
    executedObligationIds,
    artifact: input.artifact ?? null,
  };
  return freeze({ ...semantic, outcomeHash: hashCanonical(semantic) });
}

export interface StrictAnalysisEpochTransitionV1 {
  readonly kind: 'StrictAnalysisEpochTransitionV1';
  readonly schemaVersion: 1;
  readonly action: StrictAnalysisGateOutcomeV1['action'];
  readonly reasonCode: string;
  readonly limits: StrictAnalysisLoopLimitsV1;
  readonly before: StrictAnalysisEpochSummaryV1;
  readonly after: StrictAnalysisEpochSummaryV1;
  readonly enrolledObligationIds: readonly string[];
  readonly executedObligationIds: readonly string[];
  readonly resultArtifact: unknown;
  readonly transitionHash: string;
}

interface StrictAnalysisEpochSummaryV1 {
  readonly epoch: number;
  readonly snapshotHash: string;
  readonly contextHash: string;
  readonly currentExpandedScheduleHash: string;
  readonly finalExpandedScheduleHash: string | null;
  readonly analysisFixpointHash: string | null;
  readonly factQueryObligationIds: readonly string[];
  readonly factIds: readonly string[];
  readonly witnessIds: readonly string[];
  readonly populationHashes: readonly string[];
  readonly terminalObligationIds: readonly string[];
  readonly outstandingObligationIds: readonly string[];
}

export function validateStrictAnalysisEpochTransitionV1(input: {
  readonly before: StrictAnalysisEpochSnapshotV1;
  readonly after: StrictAnalysisEpochSnapshotV1;
  readonly outcome: StrictAnalysisGateOutcomeV1;
  readonly limits: StrictAnalysisLoopLimitsV1;
}): StrictAnalysisEpochTransitionV1 {
  assertStrictAnalysisEpochSnapshotIntegrity(input.before);
  assertStrictAnalysisEpochSnapshotIntegrity(input.after);
  assertStrictAnalysisGateOutcomeIntegrity(input.outcome);
  assertStrictAnalysisLoopLimits(input.limits);
  if (input.outcome.observedEpochHash !== input.before.snapshotHash) {
    fail('STRICT_ANALYSIS_GATE_EPOCH_MISMATCH');
  }
  if (
    input.before.epoch > input.limits.maxEpochs ||
    input.before.context.factQueryObligationIds.length > input.limits.maxObligations
  ) {
    fail('STRICT_ANALYSIS_LOOP_LIMIT_INVALID_AT_ENTRY');
  }
  assertStrictAnalysisIdentityStable(input.before.context, input.after.context);

  if (input.outcome.action === 'analysis_retry') {
    validateStrictAnalysisRetryTransition(input);
  } else if (input.outcome.action === 'pass') {
    validateStrictAnalysisPassTransition(input);
  } else if (input.before.snapshotHash !== input.after.snapshotHash) {
    fail('STRICT_ANALYSIS_REJECT_MUTATED_EPOCH');
  }

  const semantic = {
    kind: 'StrictAnalysisEpochTransitionV1' as const,
    schemaVersion: 1 as const,
    action: input.outcome.action,
    reasonCode: input.outcome.reasonCode,
    limits: { ...input.limits },
    before: summarizeStrictAnalysisEpoch(input.before),
    after: summarizeStrictAnalysisEpoch(input.after),
    enrolledObligationIds: input.outcome.enrolledObligationIds,
    executedObligationIds: input.outcome.executedObligationIds,
    resultArtifact: input.outcome.artifact,
  };
  return freeze({ ...semantic, transitionHash: hashCanonical(semantic) });
}

export interface StrictAnalysisExpansionPortInputV1 {
  readonly baselineScheduleHash: string;
  readonly baselineObligationIds: readonly string[];
  readonly knownFactFamilies: readonly {
    readonly id: string;
    readonly capabilityId: string;
    readonly supportedScales: readonly (
      | 'source-range'
      | 'symbol'
      | 'file'
      | 'module'
      | 'package'
      | 'repository'
      | 'project'
    )[];
  }[];
  readonly knownSubjectRefs: readonly string[];
  readonly obligationCap: number;
}

/**
 * 既有 PipelineStrategy 使用的 append-only 登记端口。执行探索或反例查询之前必须调用
 * assertExecutionAllowed，杜绝未登记查询旁路。
 */
export class StrictAnalysisExpansionPortV1 {
  readonly #input: StrictAnalysisExpansionPortInputV1;
  readonly #receipts: ReturnType<typeof validateAnalysisScheduleExpansionV1>[] = [];
  #finalSchedule: FinalExpandedMiningScheduleReceiptV1 | null = null;

  constructor(input: StrictAnalysisExpansionPortInputV1) {
    requireText(input.baselineScheduleHash, 'STRICT_ANALYSIS_BASELINE_SCHEDULE_REQUIRED');
    if (!Number.isSafeInteger(input.obligationCap) || input.obligationCap < 1) {
      fail('STRICT_ANALYSIS_OBLIGATION_CAP_INVALID');
    }
    this.#input = freeze({
      ...input,
      baselineObligationIds: normalizeIds(input.baselineObligationIds, 'baselineObligationIds'),
      knownSubjectRefs: normalizeIds(input.knownSubjectRefs, 'knownSubjectRefs'),
      knownFactFamilies: input.knownFactFamilies.map((family) => ({
        ...family,
        supportedScales: [...family.supportedScales],
      })),
    });
  }

  enroll(row: AnalysisScheduleExpansionRowV1) {
    if (this.#finalSchedule) {
      fail('STRICT_ANALYSIS_SCHEDULE_ALREADY_FINAL');
    }
    const existingExpansionObligationIds = this.#receipts.flatMap((receipt) =>
      receipt.rows.map((candidate) => candidate.obligationId)
    );
    const receipt = validateAnalysisScheduleExpansionV1({
      previousExpansionHeadHash: this.#receipts.at(-1)?.receiptHash ?? null,
      baselineObligationIds: this.#input.baselineObligationIds,
      existingExpansionObligationIds,
      rows: [row],
      knownFactFamilies: this.#input.knownFactFamilies,
      knownSubjectRefs: this.#input.knownSubjectRefs,
      obligationCap: this.#input.obligationCap,
    });
    this.#receipts.push(receipt);
    return receipt;
  }

  assertExecutionAllowed(obligationId: string): AnalysisScheduleExpansionRowV1 {
    const row = this.#receipts
      .flatMap((receipt) => receipt.rows)
      .find((candidate) => candidate.obligationId === obligationId);
    if (!row) {
      fail('STRICT_ANALYSIS_QUERY_UNENROLLED', obligationId);
    }
    return row;
  }

  /** Core 生成并校验回执后，先核对调用者的预期再提交状态；无参调用保持兼容。 */
  seal(expectedFinalScheduleHash?: string) {
    const schedule =
      this.#finalSchedule ??
      createFinalExpandedMiningScheduleReceiptV1({
        baselineScheduleHash: this.#input.baselineScheduleHash,
        baselineObligationIds: this.#input.baselineObligationIds,
        expansionReceipts: this.#receipts,
      });
    if (
      expectedFinalScheduleHash !== undefined &&
      schedule.finalExpandedScheduleHash !== expectedFinalScheduleHash
    ) {
      fail('STRICT_ANALYSIS_FIXPOINT_SCHEDULE_MISMATCH');
    }
    this.#finalSchedule = schedule;
    return schedule;
  }

  get receipts() {
    return [...this.#receipts];
  }

  get obligationCap() {
    return this.#input.obligationCap;
  }

  get enrolledObligationIds() {
    return this.#receipts.flatMap((receipt) =>
      receipt.rows.map((candidate) => candidate.obligationId)
    );
  }

  get finalSchedule() {
    return this.#finalSchedule;
  }
}

export function createStrictAnalysisExpansionPortV1(
  input: StrictAnalysisExpansionPortInputV1
): StrictAnalysisExpansionPortV1 {
  return new StrictAnalysisExpansionPortV1(input);
}

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

export interface StrictProducerEvidenceProjectionV1 {
  readonly schemaVersion: 1;
  readonly sourceRevisionVectorHash: string;
  readonly entries: readonly {
    readonly evidenceEntryId: string;
    readonly relativePath: string;
    readonly blobHash: string;
    readonly contentHash: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
  }[];
  readonly projectionHash: string;
}

/**
 * Producer 的输入不是一组可由调用者重填的字符串，而是从已验证 epoch、Core fixpoint 和
 * 冻结证据投影派生的不可变 receipt。后续表达修复只能复用同一 receipt。
 */
export interface StrictProducerLineageReceiptV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly planCognitionHash: string;
  readonly sourceRevisionVectorHash: string;
  readonly epochHash: string;
  readonly populationHash: string;
  readonly clusterSetHash: string;
  readonly clusterId: string;
  readonly inductionReceiptHash: string;
  readonly falsificationReceiptHash: string;
  readonly dispositionReviewReceiptId: string;
  readonly hypothesis: ProducerEligibleHypothesisV1;
  readonly hypothesisHash: string;
  readonly analysisFixpointHash: string;
  readonly evidenceProjectionHash: string;
  readonly evidenceEntryIds: readonly string[];
  readonly knowledgeRootId: string;
  readonly lineageHash: string;
}

export interface CreateStrictProducerLineageReceiptInputV1 {
  readonly context: StrictAnalysisContextProjectionV1;
  readonly epoch: StrictAnalystEpochV1;
  readonly analysisFixpoint: AnalysisFixpointReceiptV1;
  readonly hypothesisId: string;
  readonly evidence: StrictProducerEvidenceProjectionV1;
}

export function createStrictProducerLineageReceiptV1(
  input: CreateStrictProducerLineageReceiptInputV1
): StrictProducerLineageReceiptV1 {
  assertStrictContextIntegrity(input.context);
  assertStrictAnalystEpochIntegrity(input.epoch);
  assertAnalysisFixpointIntegrity(input.analysisFixpoint);
  assertEvidenceProjectionIntegrity(input.evidence);
  requireText(input.hypothesisId, 'STRICT_PRODUCER_LINEAGE_HYPOTHESIS_REQUIRED');

  const hypothesis = input.epoch.producerEligibleHypotheses.find(
    (candidate) => candidate.hypothesisId === input.hypothesisId
  );
  if (!hypothesis) {
    fail('STRICT_PRODUCER_LINEAGE_HYPOTHESIS_NOT_ELIGIBLE', input.hypothesisId);
  }
  const matchingInductions = input.epoch.inductions.filter((receipt) =>
    receipt.hypotheses.some((candidate) => candidate.hypothesisId === input.hypothesisId)
  );
  if (matchingInductions.length !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_INDUCTION_AMBIGUOUS', input.hypothesisId);
  }
  const induction = matchingInductions[0];
  const matchingFalsifications = input.epoch.falsifications.filter(
    (receipt) => receipt.hypothesisId === input.hypothesisId
  );
  if (matchingFalsifications.length !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_FALSIFICATION_AMBIGUOUS', input.hypothesisId);
  }
  const falsification = matchingFalsifications[0];
  const cluster = input.epoch.clusterSet.clusters.find(
    (candidate) => candidate.clusterId === induction?.clusterId
  );
  if (!induction || !falsification || !cluster) {
    fail('STRICT_PRODUCER_LINEAGE_CLUSTER_MISSING', input.hypothesisId);
  }
  if (
    !input.analysisFixpoint.clusterSetHashes.includes(input.epoch.clusterSet.clusterSetHash) ||
    !input.analysisFixpoint.inductionReceiptHashes.includes(induction.receiptHash) ||
    !input.analysisFixpoint.falsificationReceiptHashes.includes(falsification.receiptHash) ||
    hypothesis.dispositionReviewReceiptId !== falsification.dispositionReviewReceiptId ||
    induction.currentAnalysisFixpointHash !== input.analysisFixpoint.analysisReviewContextHash ||
    falsification.currentAnalysisFixpointHash !==
      input.analysisFixpoint.analysisReviewContextHash ||
    input.context.analysisFixpointHash !== input.analysisFixpoint.fixpointHash ||
    input.context.sourceRevisionVectorHash !== input.evidence.sourceRevisionVectorHash ||
    input.epoch.population.sourceRevisionVectorHash !== input.evidence.sourceRevisionVectorHash
  ) {
    fail('STRICT_PRODUCER_LINEAGE_FIXPOINT_BINDING_MISMATCH');
  }
  assertSameIds(
    input.context.evidenceEntryIds,
    input.evidence.entries.map((entry) => entry.evidenceEntryId),
    'STRICT_PRODUCER_LINEAGE_EVIDENCE_BINDING_MISMATCH'
  );
  for (const [actual, expected, code] of [
    [input.context.populationHashes, [input.epoch.population.populationHash], 'POPULATION'],
    [input.context.clusterSetHashes, [input.epoch.clusterSet.clusterSetHash], 'CLUSTER_SET'],
    [input.context.inductionReceiptHashes, [induction.receiptHash], 'INDUCTION'],
    [input.context.hypothesisIds, [hypothesis.hypothesisId], 'HYPOTHESIS'],
    [input.context.falsificationReceiptHashes, [falsification.receiptHash], 'FALSIFICATION'],
    [
      input.context.dispositionReviewIds,
      input.epoch.dispositionReviews.map((review) => review.reviewReceiptId),
      'DISPOSITION_REVIEW',
    ],
  ] as const) {
    assertContainsIds(actual, expected, `STRICT_PRODUCER_LINEAGE_${code}_BINDING_MISMATCH`);
  }

  const hypothesisHash = hashCanonical(hypothesis);
  const knowledgeRootId = hashCanonical({
    schemaVersion: 1,
    runId: input.context.runId,
    planCognitionHash: input.context.planCognitionHash,
    sourceRevisionVectorHash: input.context.sourceRevisionVectorHash,
    epochHash: input.epoch.epochHash,
    populationHash: input.epoch.population.populationHash,
    clusterSetHash: input.epoch.clusterSet.clusterSetHash,
    clusterId: cluster.clusterId,
    inductionReceiptHash: induction.receiptHash,
    falsificationReceiptHash: falsification.receiptHash,
    dispositionReviewReceiptId: falsification.dispositionReviewReceiptId,
    hypothesisHash,
    analysisFixpointHash: input.analysisFixpoint.fixpointHash,
    evidenceProjectionHash: input.evidence.projectionHash,
    evidenceEntryIds: normalizeIds(
      input.evidence.entries.map((entry) => entry.evidenceEntryId),
      'producerRootEvidenceEntryIds'
    ),
  });
  const semantic = {
    schemaVersion: 1 as const,
    runId: input.context.runId,
    planCognitionHash: input.context.planCognitionHash,
    sourceRevisionVectorHash: input.context.sourceRevisionVectorHash,
    epochHash: input.epoch.epochHash,
    populationHash: input.epoch.population.populationHash,
    clusterSetHash: input.epoch.clusterSet.clusterSetHash,
    clusterId: cluster.clusterId,
    inductionReceiptHash: induction.receiptHash,
    falsificationReceiptHash: falsification.receiptHash,
    dispositionReviewReceiptId: falsification.dispositionReviewReceiptId,
    hypothesis,
    hypothesisHash,
    analysisFixpointHash: input.analysisFixpoint.fixpointHash,
    evidenceProjectionHash: input.evidence.projectionHash,
    evidenceEntryIds: normalizeIds(
      input.evidence.entries.map((entry) => entry.evidenceEntryId),
      'producerLineageEvidenceEntryIds'
    ),
    knowledgeRootId,
  };
  return freeze({ ...semantic, lineageHash: hashCanonical(semantic) });
}

export interface CausalRepairNodeV1 {
  readonly schemaVersion: 1;
  readonly nodeId: string;
  readonly rootIds: readonly string[];
  readonly parentNodeIds: readonly string[];
  readonly stage: 'analyst' | 'producer' | 'reviewer';
  readonly lineageHash: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly evidenceHash: string;
  readonly modelHash: string;
  readonly reasonHash: string;
  readonly semanticRepairDepth: number;
  readonly nodeHash: string;
}

export interface CreateCausalRepairNodeInputV1 {
  readonly lineage: StrictProducerLineageReceiptV1;
  readonly parents: readonly CausalRepairNodeV1[];
  readonly stage: CausalRepairNodeV1['stage'];
  readonly inputHash: string;
  readonly outputHash: string;
  readonly evidenceHash: string;
  readonly modelHash: string;
  readonly reasonHash: string;
}

export function createCausalRepairNodeV1(input: CreateCausalRepairNodeInputV1): CausalRepairNodeV1 {
  assertStrictProducerLineageIntegrity(input.lineage);
  for (const parent of input.parents) {
    assertCausalRepairNodeIntegrity(parent);
  }
  for (const [field, value] of Object.entries({
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    evidenceHash: input.evidenceHash,
    modelHash: input.modelHash,
    reasonHash: input.reasonHash,
  })) {
    requireText(value, `STRICT_CAUSAL_${field.toUpperCase()}_REQUIRED`);
  }
  const rootIds =
    input.parents.length === 0
      ? [input.lineage.knowledgeRootId]
      : normalizeIds(
          input.parents.flatMap((parent) => parent.rootIds),
          'parentRootIds'
        );
  const semanticRepairDepth =
    input.parents.length === 0
      ? 0
      : 1 + Math.max(...input.parents.map((parent) => parent.semanticRepairDepth));
  if (semanticRepairDepth > 2) {
    fail('STRICT_CAUSAL_REPAIR_LIMIT');
  }
  const parentNodeIds = normalizeIds(
    input.parents.map((parent) => parent.nodeId),
    'parentNodeIds'
  );
  const nodeId = hashCanonical({
    kind: 'strict-causal-repair-node-v1',
    rootIds,
    parentNodeIds,
    stage: input.stage,
    lineageHash: input.lineage.lineageHash,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
  });
  const semantic = {
    schemaVersion: 1 as const,
    nodeId,
    rootIds,
    parentNodeIds,
    stage: input.stage,
    lineageHash: input.lineage.lineageHash,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    evidenceHash: input.evidenceHash,
    modelHash: input.modelHash,
    reasonHash: input.reasonHash,
    semanticRepairDepth,
  };
  return freeze({ ...semantic, nodeHash: hashCanonical(semantic) });
}

export interface FullAuthoredProjectionV1 {
  readonly title: string;
  readonly kind: string;
  readonly doClause: string;
  readonly dontClause: string;
  readonly markdown: string;
  readonly usageGuide: string;
  readonly retrievalProfile: Readonly<Record<string, unknown>>;
  readonly negativeIntent: readonly string[];
  readonly scope: {
    readonly moduleIds: readonly string[];
    readonly dimensionIds: readonly string[];
  };
  readonly evidenceEntryIds: readonly string[];
}

export interface StrictProducerProposalInputV1 {
  readonly expressionId: string;
  readonly kind: 'draft' | 'merge' | 'duplicate';
  readonly authored: FullAuthoredProjectionV1;
  readonly matchingRepresentativeId?: string;
}

export interface StrictProducerProposalV1 extends StrictProducerProposalInputV1 {
  /** Agent 从完整 authored projection 派生，供 Core terminal receipt/Main attempt 对账。 */
  readonly authoredFingerprint: string;
}

export interface StrictProducerZeroDispositionV1 {
  readonly reasonCode: string;
  readonly authored: FullAuthoredProjectionV1;
  readonly reviewerReceiptId: string;
  readonly dispositionReview: KnowledgeDispositionReviewV1;
  readonly terminalFate: 'reviewed-non-draft';
}

export interface StrictProducerExpressionSetV1 {
  readonly schemaVersion: 1;
  readonly setId: string;
  readonly lineage: StrictProducerLineageReceiptV1;
  readonly hypothesis: ProducerEligibleHypothesisV1;
  readonly analysisFixpointHash: string;
  readonly version: number;
  readonly parentSetId: string | null;
  readonly proposals: readonly StrictProducerProposalV1[];
  readonly zeroDisposition: StrictProducerZeroDispositionV1 | null;
  readonly cardinality: number;
  readonly authoredFingerprintHash: string;
  readonly repairNode: CausalRepairNodeV1;
  readonly setHash: string;
}

export interface CreateStrictProducerExpressionSetInputV1 {
  readonly lineage: StrictProducerLineageReceiptV1;
  readonly parentSet: StrictProducerExpressionSetV1 | null;
  readonly proposals: readonly StrictProducerProposalInputV1[];
  readonly zeroDisposition: {
    readonly reasonCode: string;
    readonly authored: FullAuthoredProjectionV1;
    readonly dispositionReview: KnowledgeDispositionReviewV1;
  } | null;
  readonly modelHash: string;
  readonly reasonHash: string;
}

export function createStrictProducerExpressionSetV1(
  input: CreateStrictProducerExpressionSetInputV1
): StrictProducerExpressionSetV1 {
  rejectProducerCallerLineageFields(input);
  assertStrictProducerLineageIntegrity(input.lineage);
  requireText(input.modelHash, 'STRICT_PRODUCER_MODEL_HASH_REQUIRED');
  requireText(input.reasonHash, 'STRICT_PRODUCER_REASON_HASH_REQUIRED');
  const { parentSetId, version } = resolveStrictProducerPredecessor(input);
  validateProducerExpressionCardinality(input);
  const proposals = normalizeStrictProducerProposals(input.proposals);
  const zeroDisposition = createStrictProducerZeroDisposition(input);
  const authoredFingerprintHash = hashCanonical({
    proposals,
    zeroDisposition,
  });
  const repairNode = createCausalRepairNodeV1({
    lineage: input.lineage,
    parents: input.parentSet ? [input.parentSet.repairNode] : [],
    stage: 'producer',
    inputHash: input.lineage.lineageHash,
    outputHash: authoredFingerprintHash,
    evidenceHash: input.lineage.evidenceProjectionHash,
    modelHash: input.modelHash,
    reasonHash: input.reasonHash,
  });
  if (repairNode.semanticRepairDepth !== version - 1) {
    fail('STRICT_PRODUCER_REPAIR_LINEAGE_INVALID');
  }
  const setId = hashCanonical({
    kind: 'strict-producer-expression-set-v1',
    knowledgeRootId: input.lineage.knowledgeRootId,
    version,
    parentSetId,
  });
  const semantic = {
    schemaVersion: 1 as const,
    setId,
    lineage: input.lineage,
    hypothesis: input.lineage.hypothesis,
    analysisFixpointHash: input.lineage.analysisFixpointHash,
    version,
    parentSetId,
    proposals,
    zeroDisposition,
    cardinality: proposals.length,
    authoredFingerprintHash,
    repairNode,
  };
  return freeze({ ...semantic, setHash: hashCanonical(semantic) });
}

function rejectProducerCallerLineageFields(input: CreateStrictProducerExpressionSetInputV1): void {
  for (const forbiddenField of [
    'setId',
    'version',
    'parentSetId',
    'hypothesis',
    'analysisFixpointHash',
    'authoredFingerprintHash',
    'repairNode',
  ]) {
    if (Object.hasOwn(input, forbiddenField)) {
      fail('STRICT_PRODUCER_CALLER_LINEAGE_FIELD_FORBIDDEN', forbiddenField);
    }
  }
}

function resolveStrictProducerPredecessor(input: CreateStrictProducerExpressionSetInputV1): {
  readonly version: number;
  readonly parentSetId: string | null;
} {
  if (input.parentSet) {
    assertStrictProducerExpressionSetIntegrity(input.parentSet);
    if (input.parentSet.lineage.lineageHash !== input.lineage.lineageHash) {
      fail('STRICT_PRODUCER_PREDECESSOR_BINDING_CHANGED');
    }
  }
  const version = (input.parentSet?.version ?? 0) + 1;
  if (version > 3) {
    fail('STRICT_CAUSAL_REPAIR_LIMIT');
  }
  return { parentSetId: input.parentSet?.setId ?? null, version };
}

function validateProducerExpressionCardinality(
  input: CreateStrictProducerExpressionSetInputV1
): void {
  if (input.proposals.length === 0 && !input.zeroDisposition) {
    fail('STRICT_PRODUCER_ZERO_DISPOSITION_REQUIRED');
  }
  if (input.proposals.length > 0 && input.zeroDisposition) {
    fail('STRICT_PRODUCER_ZERO_DISPOSITION_CONFLICT');
  }
}

function normalizeStrictProducerProposals(
  input: readonly StrictProducerProposalInputV1[]
): StrictProducerProposalV1[] {
  const expressionIds = normalizeIds(
    input.map((proposal) => proposal.expressionId),
    'expressionIds'
  );
  if (expressionIds.length !== input.length) {
    fail('STRICT_PRODUCER_EXPRESSION_DUPLICATE');
  }
  for (const proposal of input) {
    validateAuthoredProjection(proposal.authored);
    if (
      (proposal.kind === 'merge' || proposal.kind === 'duplicate') &&
      !proposal.matchingRepresentativeId
    ) {
      fail('STRICT_PRODUCER_REPRESENTATIVE_REQUIRED', proposal.expressionId);
    }
  }
  return [...input]
    .map((proposal) => ({
      expressionId: proposal.expressionId,
      kind: proposal.kind,
      authored: proposal.authored,
      ...(proposal.matchingRepresentativeId
        ? { matchingRepresentativeId: proposal.matchingRepresentativeId }
        : {}),
      authoredFingerprint: hashCoreCanonical({
        schemaVersion: 1,
        authored: proposal.authored,
      }),
    }))
    .sort((left, right) => left.expressionId.localeCompare(right.expressionId));
}

function createStrictProducerZeroDisposition(
  input: CreateStrictProducerExpressionSetInputV1
): StrictProducerZeroDispositionV1 | null {
  if (!input.zeroDisposition) {
    return null;
  }
  requireText(input.zeroDisposition.reasonCode, 'STRICT_PRODUCER_ZERO_REASON_REQUIRED');
  validateAuthoredProjection(input.zeroDisposition.authored);
  assertKnowledgeDispositionReviewV1(input.zeroDisposition.dispositionReview);
  const review = input.zeroDisposition.dispositionReview;
  if (
    review.reviewKind !== 'producer-non-draft' ||
    review.verdict !== 'pass' ||
    review.currentAnalysisFixpointHash !== input.lineage.analysisFixpointHash ||
    review.populationHash !== input.lineage.populationHash ||
    review.proposedDispositionHash !==
      hashKnowledgeDispositionProposalV1({
        reviewKind: 'producer-non-draft',
        populationHash: input.lineage.populationHash,
        hypothesisId: input.lineage.hypothesis.hypothesisId,
        expression: null,
        zeroDisposition: {
          reasonCode: input.zeroDisposition.reasonCode,
          terminalFate: 'reviewed-non-draft',
        },
      })
  ) {
    fail('STRICT_PRODUCER_ZERO_REVIEW_INVALID');
  }
  return {
    reasonCode: input.zeroDisposition.reasonCode,
    authored: input.zeroDisposition.authored,
    reviewerReceiptId: review.reviewReceiptId,
    dispositionReview: review,
    terminalFate: 'reviewed-non-draft',
  };
}

export interface StrictExpressionTerminalResolutionV1
  extends Omit<HypothesisExpressionRowV1, 'authoredFingerprint'> {}

export interface CreateStrictHypothesisExpressionSetReceiptInputV1 {
  readonly expressionSet: StrictProducerExpressionSetV1;
  readonly parentReceipt: HypothesisExpressionSetReceiptV1 | null;
  readonly privateCorpusRevision: string;
  readonly terminalHead: boolean;
  /**
   * Main/后续 gate 只回填 terminal fate 与 Core receipt；expression identity/fingerprint 由
   * Agent proposal 派生，不能被下游换绑。此函数只验证/封印，不授予 persistence/admission。
   */
  readonly terminalResolutions: readonly StrictExpressionTerminalResolutionV1[];
}

/**
 * 将 Agent 0/1/N proposal lineage 封印成 Core HypothesisExpressionSet terminal receipt。
 * Core validator 负责 non-draft review、terminal closure 与 lineage 字段的最终 fail-closed 校验。
 */
export function createStrictHypothesisExpressionSetReceiptV1(
  input: CreateStrictHypothesisExpressionSetReceiptInputV1
): HypothesisExpressionSetReceiptV1 {
  assertStrictProducerExpressionSetIntegrity(input.expressionSet);
  requireText(input.privateCorpusRevision, 'STRICT_EXPRESSION_PRIVATE_CORPUS_REVISION_REQUIRED');
  const expectedParentReceiptId = input.expressionSet.parentSetId
    ? `expression-set:${input.expressionSet.parentSetId}`
    : null;
  if (
    (input.parentReceipt?.receiptId ?? null) !== expectedParentReceiptId ||
    (input.parentReceipt &&
      (input.parentReceipt.hypothesisId !== input.expressionSet.hypothesis.hypothesisId ||
        input.parentReceipt.analysisFixpointHash !== input.expressionSet.analysisFixpointHash ||
        input.parentReceipt.privateCorpusRevision !== input.privateCorpusRevision ||
        input.parentReceipt.version !== input.expressionSet.version - 1))
  ) {
    fail('STRICT_EXPRESSION_PARENT_RECEIPT_MISMATCH');
  }
  const resolutionsById = new Map(
    input.terminalResolutions.map((resolution) => [resolution.expressionId, resolution])
  );
  if (
    resolutionsById.size !== input.terminalResolutions.length ||
    resolutionsById.size !== input.expressionSet.proposals.length ||
    input.expressionSet.proposals.some((proposal) => !resolutionsById.has(proposal.expressionId))
  ) {
    fail('STRICT_EXPRESSION_TERMINAL_RESOLUTION_CONSERVATION');
  }
  const expressions = input.expressionSet.proposals.map((proposal) => {
    const resolution = resolutionsById.get(proposal.expressionId);
    if (!resolution) {
      fail('STRICT_EXPRESSION_TERMINAL_RESOLUTION_MISSING', proposal.expressionId);
    }
    return {
      expressionId: proposal.expressionId,
      authoredFingerprint: proposal.authoredFingerprint,
      terminalFate: resolution.terminalFate,
      terminalReceiptId: resolution.terminalReceiptId,
      terminalReceiptHash: resolution.terminalReceiptHash,
      ...(resolution.dispositionReview ? { dispositionReview: resolution.dispositionReview } : {}),
      ...(resolution.matchingRepresentativeId
        ? { matchingRepresentativeId: resolution.matchingRepresentativeId }
        : {}),
      ...(resolution.matchingContentReadyRecipeId
        ? { matchingContentReadyRecipeId: resolution.matchingContentReadyRecipeId }
        : {}),
    };
  });
  return validateHypothesisExpressionSetReceiptV1({
    schemaVersion: 1,
    receiptId: `expression-set:${input.expressionSet.setId}`,
    hypothesisId: input.expressionSet.hypothesis.hypothesisId,
    analysisFixpointHash: input.expressionSet.analysisFixpointHash,
    privateCorpusRevision: input.privateCorpusRevision,
    version: input.expressionSet.version,
    parentReceiptId: expectedParentReceiptId,
    terminalHead: input.terminalHead,
    expressions,
    zeroDisposition: input.expressionSet.zeroDisposition
      ? {
          reasonCode: input.expressionSet.zeroDisposition.reasonCode,
          reviewerReceiptId: input.expressionSet.zeroDisposition.reviewerReceiptId,
          dispositionReview: input.expressionSet.zeroDisposition.dispositionReview,
          terminalFate: input.expressionSet.zeroDisposition.terminalFate,
        }
      : null,
  });
}

export function createStrictTypedGateReturnV1(input: TypedGateReturnInputV1): TypedGateReturnV1 {
  return createTypedGateReturnV1(input);
}

export function validateStrictStageToolCallsV1(
  stageName: string,
  toolCalls: readonly Record<string, unknown>[],
  enrolledObligationIds: readonly string[] = []
): void {
  const normalizedStage = stageName.toLowerCase();
  if (normalizedStage === 'produce' || normalizedStage === 'producer') {
    if (toolCalls.length > 0) {
      fail('STRICT_PRODUCER_TOOL_FORBIDDEN', readToolName(toolCalls[0]));
    }
    return;
  }
  const enrolled = new Set(enrolledObligationIds);
  for (const call of toolCalls) {
    const tool = readToolName(call);
    const args = readRecord(call.args ?? call.params);
    const action = String(args.action ?? '');
    if (
      tool === 'knowledge' ||
      action === 'submit' ||
      action === 'persist' ||
      action === 'review'
    ) {
      fail('STRICT_ANALYST_AUTHORITY_FORBIDDEN', `${tool}.${action}`);
    }
    if (action === 'execute_fact_query' || action === 'execute_counterquery') {
      const obligationId = String(readRecord(args.params).obligationId ?? args.obligationId ?? '');
      if (!enrolled.has(obligationId)) {
        fail('STRICT_ANALYSIS_QUERY_UNENROLLED', obligationId || 'missing');
      }
    }
  }
}

function assertStrictAnalysisEpochSnapshotIntegrity(snapshot: StrictAnalysisEpochSnapshotV1): void {
  const { schemaVersion, snapshotHash, ...input } = snapshot;
  if (schemaVersion !== 1) {
    fail('STRICT_ANALYSIS_EPOCH_VERSION_MISMATCH');
  }
  const rebuilt = createStrictAnalysisEpochSnapshotV1(input);
  if (rebuilt.snapshotHash !== snapshotHash) {
    fail('STRICT_ANALYSIS_EPOCH_HASH_MISMATCH');
  }
}

function assertStrictAnalysisGateOutcomeIntegrity(outcome: StrictAnalysisGateOutcomeV1): void {
  if (outcome.kind !== 'StrictAnalysisGateOutcomeV1' || outcome.schemaVersion !== 1) {
    fail('STRICT_ANALYSIS_GATE_OUTCOME_UNTYPED');
  }
  const { kind: _kind, schemaVersion: _schemaVersion, outcomeHash, pass, ...input } = outcome;
  const rebuilt = createStrictAnalysisGateOutcomeV1(input);
  if (rebuilt.outcomeHash !== outcomeHash || rebuilt.pass !== pass) {
    fail('STRICT_ANALYSIS_GATE_OUTCOME_HASH_MISMATCH');
  }
}

function assertStrictAnalysisLoopLimits(limits: StrictAnalysisLoopLimitsV1): void {
  if (!Number.isSafeInteger(limits.maxEpochs) || limits.maxEpochs < 1) {
    fail('STRICT_ANALYSIS_MAX_EPOCHS_INVALID');
  }
  if (!Number.isSafeInteger(limits.maxObligations) || limits.maxObligations < 1) {
    fail('STRICT_ANALYSIS_MAX_OBLIGATIONS_INVALID');
  }
}

function assertStrictAnalysisIdentityStable(
  before: StrictAnalysisContextProjectionV1,
  after: StrictAnalysisContextProjectionV1
): void {
  const identityFields = [
    'runId',
    'journalId',
    'manifestHash',
    'planCognitionHash',
    'planHash',
    'requiredUniverseHash',
    'baselineScheduleHash',
    'lensBindingsHash',
    'sourceArtifactHash',
    'sourceRevisionVectorHash',
    'privateCorpusRevision',
    'hypothesisExpressionSetHash',
    'derivedFindingCount',
  ] as const;
  for (const field of identityFields) {
    if (before[field] !== after[field]) {
      fail('STRICT_ANALYSIS_EPOCH_IDENTITY_DRIFT', field);
    }
  }
  for (const field of CONTEXT_ARRAY_FIELDS) {
    assertAppendOnlyIds(
      before[field],
      after[field],
      `STRICT_ANALYSIS_${field.toUpperCase()}_NOT_APPEND_ONLY`
    );
  }
}

function validateStrictAnalysisRetryTransition(input: {
  readonly before: StrictAnalysisEpochSnapshotV1;
  readonly after: StrictAnalysisEpochSnapshotV1;
  readonly outcome: StrictAnalysisGateOutcomeV1;
  readonly limits: StrictAnalysisLoopLimitsV1;
}): void {
  if (input.before.epoch >= input.limits.maxEpochs || input.after.epoch > input.limits.maxEpochs) {
    fail('STRICT_ANALYSIS_EPOCH_LIMIT_EXHAUSTED');
  }
  if (input.after.snapshotHash === input.before.snapshotHash) {
    fail('STRICT_ANALYSIS_RETRY_NON_PROGRESS');
  }
  if (input.after.epoch !== input.before.epoch + 1) {
    fail('STRICT_ANALYSIS_RETRY_EPOCH_SEQUENCE_INVALID');
  }
  if (
    input.before.context.finalExpandedScheduleHash !== null ||
    input.before.context.analysisFixpointHash !== null ||
    input.after.context.finalExpandedScheduleHash !== null ||
    input.after.context.analysisFixpointHash !== null
  ) {
    fail('STRICT_ANALYSIS_RETRY_AFTER_FIXPOINT_FORBIDDEN');
  }
  if (
    input.after.context.currentExpandedScheduleHash ===
      input.before.context.currentExpandedScheduleHash ||
    input.after.context.expansionHeadHash === input.before.context.expansionHeadHash
  ) {
    fail('STRICT_ANALYSIS_RETRY_SCHEDULE_NOT_ADVANCED');
  }
  if (input.after.context.factQueryObligationIds.length > input.limits.maxObligations) {
    fail('STRICT_ANALYSIS_OBLIGATION_LIMIT_EXHAUSTED');
  }
  assertAppendOnlyIds(
    input.before.terminalObligationIds,
    input.after.terminalObligationIds,
    'STRICT_ANALYSIS_TERMINAL_OBLIGATIONS_NOT_APPEND_ONLY'
  );
  assertSameIds(
    getAddedIds(
      input.before.context.factQueryObligationIds,
      input.after.context.factQueryObligationIds
    ),
    input.outcome.enrolledObligationIds,
    'STRICT_ANALYSIS_RETRY_ENROLLMENT_DIFF_MISMATCH'
  );
  assertSameIds(
    getAddedIds(input.before.terminalObligationIds, input.after.terminalObligationIds),
    input.outcome.executedObligationIds,
    'STRICT_ANALYSIS_RETRY_TERMINAL_DIFF_MISMATCH'
  );
  assertSameIds(
    input.before.outstandingObligationIds,
    input.after.outstandingObligationIds,
    'STRICT_ANALYSIS_RETRY_OUTSTANDING_MUTATED'
  );
  for (const obligationId of input.outcome.enrolledObligationIds) {
    if (
      input.before.context.factQueryObligationIds.includes(obligationId) ||
      !input.after.context.factQueryObligationIds.includes(obligationId)
    ) {
      fail('STRICT_ANALYSIS_RETRY_ENROLLMENT_NOT_APPENDED', obligationId);
    }
    if (!input.after.terminalObligationIds.includes(obligationId)) {
      fail('STRICT_ANALYSIS_RETRY_EXECUTION_NOT_TERMINAL', obligationId);
    }
  }
}

function validateStrictAnalysisPassTransition(input: {
  readonly before: StrictAnalysisEpochSnapshotV1;
  readonly after: StrictAnalysisEpochSnapshotV1;
}): void {
  if (input.after.epoch !== input.before.epoch) {
    fail('STRICT_ANALYSIS_PASS_EPOCH_CHANGED');
  }
  if (
    input.before.outstandingObligationIds.length > 0 ||
    input.after.outstandingObligationIds.length > 0
  ) {
    fail('STRICT_ANALYSIS_FIXPOINT_OBLIGATION_OUTSTANDING');
  }
  for (const field of [
    'factQueryObligationIds',
    'factIds',
    'witnessIds',
    'populationHashes',
  ] as const) {
    assertSameIds(
      input.before.context[field],
      input.after.context[field],
      `STRICT_ANALYSIS_PASS_${field.toUpperCase()}_MUTATED`
    );
  }
  assertSameIds(
    input.before.terminalObligationIds,
    input.after.terminalObligationIds,
    'STRICT_ANALYSIS_PASS_TERMINAL_OBLIGATIONS_MUTATED'
  );
  if (
    input.before.context.currentExpandedScheduleHash !==
    input.after.context.currentExpandedScheduleHash
  ) {
    fail('STRICT_ANALYSIS_PASS_SCHEDULE_MUTATED');
  }
  if (!input.after.context.finalExpandedScheduleHash || !input.after.context.analysisFixpointHash) {
    fail('STRICT_ANALYSIS_FIXPOINT_SEAL_REQUIRED');
  }
}

function summarizeStrictAnalysisEpoch(
  snapshot: StrictAnalysisEpochSnapshotV1
): StrictAnalysisEpochSummaryV1 {
  return {
    epoch: snapshot.epoch,
    snapshotHash: snapshot.snapshotHash,
    contextHash: snapshot.context.contextHash,
    currentExpandedScheduleHash: snapshot.context.currentExpandedScheduleHash,
    finalExpandedScheduleHash: snapshot.context.finalExpandedScheduleHash,
    analysisFixpointHash: snapshot.context.analysisFixpointHash,
    factQueryObligationIds: snapshot.context.factQueryObligationIds,
    factIds: snapshot.context.factIds,
    witnessIds: snapshot.context.witnessIds,
    populationHashes: snapshot.context.populationHashes,
    terminalObligationIds: snapshot.terminalObligationIds,
    outstandingObligationIds: snapshot.outstandingObligationIds,
  };
}

function assertAppendOnlyIds(
  before: readonly string[],
  after: readonly string[],
  code: string
): void {
  const afterSet = new Set(after);
  if (before.some((value) => !afterSet.has(value))) {
    fail(code);
  }
}

function getAddedIds(before: readonly string[], after: readonly string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((value) => !beforeSet.has(value));
}

function assertStrictContextIntegrity(context: StrictAnalysisContextProjectionV1): void {
  const { schemaVersion, contextHash, ...input } = context;
  if (schemaVersion !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_CONTEXT_VERSION_MISMATCH');
  }
  const rebuilt = createStrictAnalysisContextProjectionV1(input);
  if (rebuilt.contextHash !== contextHash) {
    fail('STRICT_PRODUCER_LINEAGE_CONTEXT_HASH_MISMATCH');
  }
}

function assertStrictAnalystEpochIntegrity(epoch: StrictAnalystEpochV1): void {
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

function assertAnalysisFixpointIntegrity(fixpoint: AnalysisFixpointReceiptV1): void {
  const { fixpointHash, ...semantic } = fixpoint;
  if (fixpoint.schemaVersion !== 1 || hashCoreCanonical(semantic) !== fixpointHash) {
    fail('STRICT_PRODUCER_LINEAGE_FIXPOINT_HASH_MISMATCH');
  }
}

function assertEvidenceProjectionIntegrity(evidence: StrictProducerEvidenceProjectionV1): void {
  if (evidence.schemaVersion !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_VERSION_MISMATCH');
  }
  requireText(
    evidence.sourceRevisionVectorHash,
    'STRICT_PRODUCER_LINEAGE_EVIDENCE_SOURCE_REQUIRED'
  );
  const entries = [...evidence.entries].sort((left, right) =>
    left.evidenceEntryId.localeCompare(right.evidenceEntryId)
  );
  for (const entry of entries) {
    for (const [field, value] of Object.entries({
      evidenceEntryId: entry.evidenceEntryId,
      relativePath: entry.relativePath,
      blobHash: entry.blobHash,
      contentHash: entry.contentHash,
    })) {
      requireText(value, `STRICT_PRODUCER_LINEAGE_EVIDENCE_${field.toUpperCase()}_REQUIRED`);
    }
    const contentHash = createHash('sha256').update(entry.content).digest('hex');
    if (contentHash !== entry.contentHash) {
      fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_CONTENT_HASH_MISMATCH', entry.evidenceEntryId);
    }
    if (
      !Number.isSafeInteger(entry.startLine) ||
      !Number.isSafeInteger(entry.endLine) ||
      entry.startLine < 1 ||
      entry.endLine < entry.startLine ||
      entry.content.split('\n').length !== entry.endLine - entry.startLine + 1
    ) {
      fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_RANGE_INVALID', entry.evidenceEntryId);
    }
  }
  if (new Set(entries.map((entry) => entry.evidenceEntryId)).size !== entries.length) {
    fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_ID_DUPLICATE');
  }
  const semantic = {
    schemaVersion: 1 as const,
    sourceRevisionVectorHash: evidence.sourceRevisionVectorHash,
    entries,
  };
  if (hashCanonical(semantic) !== evidence.projectionHash) {
    fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_PROJECTION_HASH_MISMATCH');
  }
}

function assertStrictProducerLineageIntegrity(lineage: StrictProducerLineageReceiptV1): void {
  if (lineage.schemaVersion !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_VERSION_MISMATCH');
  }
  for (const [field, value] of Object.entries({
    runId: lineage.runId,
    planCognitionHash: lineage.planCognitionHash,
    sourceRevisionVectorHash: lineage.sourceRevisionVectorHash,
    epochHash: lineage.epochHash,
    populationHash: lineage.populationHash,
    clusterSetHash: lineage.clusterSetHash,
    clusterId: lineage.clusterId,
    inductionReceiptHash: lineage.inductionReceiptHash,
    falsificationReceiptHash: lineage.falsificationReceiptHash,
    dispositionReviewReceiptId: lineage.dispositionReviewReceiptId,
    hypothesisHash: lineage.hypothesisHash,
    analysisFixpointHash: lineage.analysisFixpointHash,
    evidenceProjectionHash: lineage.evidenceProjectionHash,
    knowledgeRootId: lineage.knowledgeRootId,
    lineageHash: lineage.lineageHash,
  })) {
    requireText(value, `STRICT_PRODUCER_LINEAGE_${field.toUpperCase()}_REQUIRED`);
  }
  if (hashCanonical(lineage.hypothesis) !== lineage.hypothesisHash) {
    fail('STRICT_PRODUCER_LINEAGE_HYPOTHESIS_HASH_MISMATCH');
  }
  const expectedRootId = hashCanonical({
    schemaVersion: 1,
    runId: lineage.runId,
    planCognitionHash: lineage.planCognitionHash,
    sourceRevisionVectorHash: lineage.sourceRevisionVectorHash,
    epochHash: lineage.epochHash,
    populationHash: lineage.populationHash,
    clusterSetHash: lineage.clusterSetHash,
    clusterId: lineage.clusterId,
    inductionReceiptHash: lineage.inductionReceiptHash,
    falsificationReceiptHash: lineage.falsificationReceiptHash,
    dispositionReviewReceiptId: lineage.dispositionReviewReceiptId,
    hypothesisHash: lineage.hypothesisHash,
    analysisFixpointHash: lineage.analysisFixpointHash,
    evidenceProjectionHash: lineage.evidenceProjectionHash,
    evidenceEntryIds: normalizeIds(lineage.evidenceEntryIds, 'producerRootEvidenceEntryIds'),
  });
  if (expectedRootId !== lineage.knowledgeRootId) {
    fail('STRICT_PRODUCER_LINEAGE_KNOWLEDGE_ROOT_MISMATCH');
  }
  const { lineageHash, ...semantic } = lineage;
  if (hashCanonical(semantic) !== lineageHash) {
    fail('STRICT_PRODUCER_LINEAGE_HASH_MISMATCH');
  }
}

function assertCausalRepairNodeIntegrity(node: CausalRepairNodeV1): void {
  const { nodeHash, ...semantic } = node;
  if (node.schemaVersion !== 1 || hashCanonical(semantic) !== nodeHash) {
    fail('STRICT_CAUSAL_NODE_HASH_MISMATCH');
  }
  normalizeIds(node.rootIds, 'causalRootIds');
  normalizeIds(node.parentNodeIds, 'causalParentNodeIds');
  if (!Number.isSafeInteger(node.semanticRepairDepth) || node.semanticRepairDepth < 0) {
    fail('STRICT_CAUSAL_REPAIR_DEPTH_INVALID');
  }
}

function assertStrictProducerExpressionSetIntegrity(set: StrictProducerExpressionSetV1): void {
  const { setHash, ...semantic } = set;
  if (set.schemaVersion !== 1 || hashCanonical(semantic) !== setHash) {
    fail('STRICT_PRODUCER_PARENT_SET_HASH_MISMATCH');
  }
  assertStrictProducerLineageIntegrity(set.lineage);
  assertCausalRepairNodeIntegrity(set.repairNode);
  const authoredFingerprintHash = hashCanonical({
    proposals: set.proposals,
    zeroDisposition: set.zeroDisposition,
  });
  if (
    set.proposals.some(
      (proposal) =>
        proposal.authoredFingerprint !==
        hashCoreCanonical({ schemaVersion: 1, authored: proposal.authored })
    )
  ) {
    fail('STRICT_PRODUCER_PARENT_EXPRESSION_FINGERPRINT_MISMATCH');
  }
  if (
    authoredFingerprintHash !== set.authoredFingerprintHash ||
    set.repairNode.outputHash !== set.authoredFingerprintHash
  ) {
    fail('STRICT_PRODUCER_PARENT_SET_FINGERPRINT_MISMATCH');
  }
  if (
    set.repairNode.lineageHash !== set.lineage.lineageHash ||
    set.repairNode.inputHash !== set.lineage.lineageHash ||
    set.repairNode.evidenceHash !== set.lineage.evidenceProjectionHash ||
    set.analysisFixpointHash !== set.lineage.analysisFixpointHash ||
    hashCanonical(set.hypothesis) !== set.lineage.hypothesisHash
  ) {
    fail('STRICT_PRODUCER_PARENT_SET_LINEAGE_MISMATCH');
  }
  const expectedSetId = hashCanonical({
    kind: 'strict-producer-expression-set-v1',
    knowledgeRootId: set.lineage.knowledgeRootId,
    version: set.version,
    parentSetId: set.parentSetId,
  });
  if (expectedSetId !== set.setId) {
    fail('STRICT_PRODUCER_PARENT_SET_ID_MISMATCH');
  }
  if (
    set.version < 1 ||
    set.version > 3 ||
    set.repairNode.semanticRepairDepth !== set.version - 1 ||
    (set.version === 1) !== (set.parentSetId === null)
  ) {
    fail('STRICT_PRODUCER_PARENT_SET_DEPTH_MISMATCH');
  }
}

function assertSameIds(actual: readonly string[], expected: readonly string[], code: string): void {
  const left = normalizeIds(actual, `${code}:actual`);
  const right = normalizeIds(expected, `${code}:expected`);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(code);
  }
}

function assertContainsIds(
  actual: readonly string[],
  expected: readonly string[],
  code: string
): void {
  const available = new Set(normalizeIds(actual, `${code}:actual`));
  if (normalizeIds(expected, `${code}:expected`).some((value) => !available.has(value))) {
    fail(code);
  }
}

function validateAuthoredProjection(authored: FullAuthoredProjectionV1): void {
  for (const [field, value] of Object.entries({
    title: authored.title,
    kind: authored.kind,
    doClause: authored.doClause,
    dontClause: authored.dontClause,
    markdown: authored.markdown,
    usageGuide: authored.usageGuide,
  })) {
    requireText(value, `STRICT_AUTHORED_${field.toUpperCase()}_REQUIRED`);
  }
  if (
    !authored.retrievalProfile ||
    typeof authored.retrievalProfile !== 'object' ||
    authored.negativeIntent.length === 0 ||
    authored.scope.moduleIds.length === 0 ||
    authored.scope.dimensionIds.length === 0 ||
    authored.evidenceEntryIds.length === 0
  ) {
    fail('STRICT_AUTHORED_PROJECTION_INCOMPLETE');
  }
}

function readToolName(call: Record<string, unknown>): string {
  return String(call.tool ?? call.name ?? 'unknown');
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeIds(values: readonly string[], field: string): string[] {
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  if (normalized.length !== values.length || new Set(normalized).size !== normalized.length) {
    fail('STRICT_ID_SET_INVALID', field);
  }
  return normalized;
}

function requireText(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(code);
  }
}

function requireCoreHash(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(code);
  }
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortCanonical(value)))
    .digest('hex');
}

function hashCoreCanonical(value: unknown): string {
  return `sha256:${hashCanonical(value)}`;
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortCanonical(child)])
  );
}

function freeze<T>(value: T, visited = new WeakSet<object>()): T {
  // 已冻住容器不代表子记录不可变；独立访问集合也避免共享引用/循环重复遍历。
  if (value && typeof value === 'object' && !visited.has(value)) {
    visited.add(value);
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freeze(child, visited);
    }
  }
  return value;
}
