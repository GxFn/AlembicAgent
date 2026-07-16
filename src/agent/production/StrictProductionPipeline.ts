import { createHash } from 'node:crypto';
import {
  type AnalysisFixpointReceiptV1,
  type AnalysisScheduleExpansionRowV1,
  type CounterqueryExecutionV1,
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAnalysisFixpointReceiptV1,
  createFalsificationReceiptV1,
  createFinalExpandedMiningScheduleReceiptV1,
  createInductionReceiptV1,
  createTypedGateReturnV1,
  type FalsificationReceiptV1,
  type FinalExpandedMiningScheduleReceiptV1,
  type HypothesisV1,
  type InductionReceiptV1,
  type KnowledgeClusterInputV1,
  type KnowledgeClusterSetV1,
  type ObservationPopulationInputV1,
  type ObservationPopulationV1,
  type TypedGateReturnInputV1,
  type TypedGateReturnV1,
  validateAnalysisScheduleExpansionV1,
} from '@alembic/core/host-agent-workflows';

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

  seal() {
    this.#finalSchedule ??= createFinalExpandedMiningScheduleReceiptV1({
      baselineScheduleHash: this.#input.baselineScheduleHash,
      baselineObligationIds: this.#input.baselineObligationIds,
      expansionReceipts: this.#receipts,
    });
    return this.#finalSchedule;
  }

  get receipts() {
    return [...this.#receipts];
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
  readonly zeroHypothesisReviewReceiptId?: string;
}

export interface StrictHypothesisDispositionV1 {
  readonly hypothesisId: string;
  readonly status: 'survived' | 'narrowed' | 'refuted' | 'unknown';
  readonly reviewerReceiptId: string;
  readonly causalParentHypothesisId?: string;
}

export interface StrictFalsificationInputV1 {
  readonly hypothesisId: string;
  readonly enrolledCounterqueryIds: readonly string[];
  readonly executions: readonly CounterqueryExecutionV1[];
  readonly counterqueryApplicability: FalsificationReceiptV1['counterqueryApplicability'];
}

export interface StrictAnalystEpochInputV1 {
  readonly knownFactIds: readonly string[];
  readonly enrolledObligationIds: readonly string[];
  readonly population: ObservationPopulationInputV1;
  readonly clusterInputs: readonly KnowledgeClusterInputV1[];
  readonly nonClusteredDispositions: readonly {
    readonly observationId: string;
    readonly status: 'discarded' | 'unresolved';
    readonly reasonCode: string;
    readonly reviewerReceiptId?: string;
    readonly owner?: string;
    readonly resumePoint?: string;
  }[];
  readonly inductionInputs: readonly StrictInductionInputV1[];
  readonly falsificationInputs: readonly StrictFalsificationInputV1[];
  readonly hypothesisDispositions: readonly StrictHypothesisDispositionV1[];
}

export interface ProducerEligibleHypothesisV1 extends HypothesisV1 {
  readonly status: 'survived' | 'narrowed';
  readonly reviewerReceiptId: string;
  readonly causalParentHypothesisId?: string;
}

export interface StrictAnalystEpochV1 {
  readonly schemaVersion: 1;
  readonly population: ObservationPopulationV1;
  readonly clusterSet: KnowledgeClusterSetV1;
  readonly inductions: readonly InductionReceiptV1[];
  readonly falsifications: readonly FalsificationReceiptV1[];
  readonly hypothesisDispositions: readonly StrictHypothesisDispositionV1[];
  readonly producerEligibleHypotheses: readonly ProducerEligibleHypothesisV1[];
  readonly epochHash: string;
}

export function validateStrictAnalystEpochV1(
  input: StrictAnalystEpochInputV1
): StrictAnalystEpochV1 {
  const knownFactIds = new Set(normalizeIds(input.knownFactIds, 'knownFactIds'));
  for (const observation of input.population.observations) {
    if (
      observation.factIds.length === 0 ||
      observation.factIds.some((factId) => !knownFactIds.has(factId))
    ) {
      fail('STRICT_ANALYST_FACT_INVENTED', observation.observationId);
    }
  }
  const population = canonicalizeObservationPopulationV1(input.population);
  const clusterSet = canonicalizeKnowledgeClustersV1(population, {
    clusters: input.clusterInputs,
    nonClusteredDispositions: input.nonClusteredDispositions,
  });
  const clustersByMechanism = new Map<string, KnowledgeClusterSetV1['clusters'][number]>();
  for (const cluster of clusterSet.clusters) {
    if (clustersByMechanism.has(cluster.mechanismKey)) {
      fail('STRICT_ANALYST_CLUSTER_MECHANISM_DUPLICATE', cluster.mechanismKey);
    }
    clustersByMechanism.set(cluster.mechanismKey, cluster);
  }
  const inductions = input.inductionInputs.map((induction) => {
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
      clusterHash: clusterSet.clusterSetHash,
      clusterId: cluster.clusterId,
      observationIds: cluster.observationIds,
      mode: induction.mode,
      hypotheses: induction.hypotheses,
      ...(induction.zeroHypothesisReason
        ? { zeroHypothesisReason: induction.zeroHypothesisReason }
        : {}),
      ...(induction.zeroHypothesisReviewReceiptId
        ? { zeroHypothesisReviewReceiptId: induction.zeroHypothesisReviewReceiptId }
        : {}),
    });
  });
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
  const externallyEnrolled = new Set(
    normalizeIds(input.enrolledObligationIds, 'enrolledObligationIds')
  );
  const falsifications = input.falsificationInputs.map((candidate) => {
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
    return createFalsificationReceiptV1(candidate);
  });
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
    requireText(disposition.reviewerReceiptId, 'STRICT_ANALYST_DISPOSITION_REVIEW_REQUIRED');
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
        reviewerReceiptId: disposition.reviewerReceiptId,
        ...(disposition.causalParentHypothesisId
          ? { causalParentHypothesisId: disposition.causalParentHypothesisId }
          : {}),
      });
    }
  }
  const semantic = {
    schemaVersion: 1 as const,
    population,
    clusterSet,
    inductions,
    falsifications,
    hypothesisDispositions: dispositions,
    producerEligibleHypotheses,
  };
  return freeze({ ...semantic, epochHash: hashCanonical(semantic) });
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
  if (
    input.epochs.some((epoch) =>
      epoch.hypothesisDispositions.some((disposition) => disposition.status === 'unknown')
    )
  ) {
    fail('STRICT_ANALYSIS_FIXPOINT_HYPOTHESIS_UNRESOLVED');
  }
  return createAnalysisFixpointReceiptV1({
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
  const cluster = input.epoch.clusterSet.clusters.find(
    (candidate) => candidate.clusterId === induction?.clusterId
  );
  if (!induction || !cluster) {
    fail('STRICT_PRODUCER_LINEAGE_CLUSTER_MISSING', input.hypothesisId);
  }
  if (
    !input.analysisFixpoint.clusterSetHashes.includes(input.epoch.clusterSet.clusterSetHash) ||
    !input.analysisFixpoint.inductionReceiptHashes.includes(induction.receiptHash) ||
    input.context.analysisFixpointHash !== input.analysisFixpoint.fixpointHash ||
    input.context.sourceRevisionVectorHash !== input.evidence.sourceRevisionVectorHash
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

export interface StrictProducerProposalV1 {
  readonly expressionId: string;
  readonly kind: 'draft' | 'merge' | 'duplicate';
  readonly authored: FullAuthoredProjectionV1;
  readonly matchingRepresentativeId?: string;
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
  readonly zeroDisposition: {
    readonly reasonCode: string;
    readonly authored: FullAuthoredProjectionV1;
    readonly reviewerReceiptId: string;
  } | null;
  readonly cardinality: number;
  readonly authoredFingerprintHash: string;
  readonly repairNode: CausalRepairNodeV1;
  readonly setHash: string;
}

export interface CreateStrictProducerExpressionSetInputV1 {
  readonly lineage: StrictProducerLineageReceiptV1;
  readonly parentSet: StrictProducerExpressionSetV1 | null;
  readonly proposals: readonly StrictProducerProposalV1[];
  readonly zeroDisposition: StrictProducerExpressionSetV1['zeroDisposition'];
  readonly modelHash: string;
  readonly reasonHash: string;
}

export function createStrictProducerExpressionSetV1(
  input: CreateStrictProducerExpressionSetInputV1
): StrictProducerExpressionSetV1 {
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
  assertStrictProducerLineageIntegrity(input.lineage);
  requireText(input.modelHash, 'STRICT_PRODUCER_MODEL_HASH_REQUIRED');
  requireText(input.reasonHash, 'STRICT_PRODUCER_REASON_HASH_REQUIRED');
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
  const parentSetId = input.parentSet?.setId ?? null;
  if (input.proposals.length === 0 && !input.zeroDisposition) {
    fail('STRICT_PRODUCER_ZERO_DISPOSITION_REQUIRED');
  }
  if (input.proposals.length > 0 && input.zeroDisposition) {
    fail('STRICT_PRODUCER_ZERO_DISPOSITION_CONFLICT');
  }
  const expressionIds = normalizeIds(
    input.proposals.map((proposal) => proposal.expressionId),
    'expressionIds'
  );
  if (expressionIds.length !== input.proposals.length) {
    fail('STRICT_PRODUCER_EXPRESSION_DUPLICATE');
  }
  for (const proposal of input.proposals) {
    validateAuthoredProjection(proposal.authored);
    if (
      (proposal.kind === 'merge' || proposal.kind === 'duplicate') &&
      !proposal.matchingRepresentativeId
    ) {
      fail('STRICT_PRODUCER_REPRESENTATIVE_REQUIRED', proposal.expressionId);
    }
  }
  if (input.zeroDisposition) {
    requireText(input.zeroDisposition.reasonCode, 'STRICT_PRODUCER_ZERO_REASON_REQUIRED');
    requireText(input.zeroDisposition.reviewerReceiptId, 'STRICT_PRODUCER_ZERO_REVIEW_REQUIRED');
    validateAuthoredProjection(input.zeroDisposition.authored);
  }
  const proposals = [...input.proposals].sort((left, right) =>
    left.expressionId.localeCompare(right.expressionId)
  );
  const authoredFingerprintHash = hashCanonical({
    proposals,
    zeroDisposition: input.zeroDisposition,
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
    zeroDisposition: input.zeroDisposition,
    cardinality: proposals.length,
    authoredFingerprintHash,
    repairNode,
  };
  return freeze({ ...semantic, setHash: hashCanonical(semantic) });
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
  const { epochHash, ...semantic } = epoch;
  if (epoch.schemaVersion !== 1 || hashCanonical(semantic) !== epochHash) {
    fail('STRICT_PRODUCER_LINEAGE_EPOCH_HASH_MISMATCH');
  }
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

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freeze(child);
    }
  }
  return value;
}
