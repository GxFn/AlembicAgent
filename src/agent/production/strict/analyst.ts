/** Analyst语义回执、重建验证与fixpoint；外层hash相同不替代Core事实再验证。 */
import Logger from '@alembic/core/logging';
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
import { observeSafely } from '#shared/observers.js';
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
  /**
   * 宿主经独立语义审查会话生成并注入的 zero-hypothesis 回执，不是模型输出；模型只提交
   * zeroHypothesisReason 提案。缺失或伪造都会在 Core createInductionReceiptV1 失败关闭。
   */
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
  /**
   * 宿主经独立语义审查会话生成并注入的 falsification 回执，不是模型输出；模型只提交 ids、
   * executions 与 counterqueryApplicability 提案，reviewerReceiptId 由此回执派生。
   */
  readonly dispositionReview: KnowledgeDispositionReviewV1;
}

/**
 * 一个 Analyst epoch 的完整校验输入，由三段合并而成：
 * - 模型处置提案：clusterInputs、nonClusteredDispositions、inductionInputs、falsificationInputs、
 *   hypothesisDispositions 中除审查回执以外的字段，形状由 StrictProductionPrompts 的内部输出
 *   契约渲染给模型；
 * - 宿主权威：population、knownFactIds、enrolledObligationIds，宿主用自身记录覆盖模型回传；
 * - 宿主封印：currentAnalysisFixpointHash、各 dispositionReview 与 dispositionReviews，由宿主经
 *   独立语义审查会话生成后注入，模型不能也不得产出。
 * 类型尚未拆成“提案/封印”两段（已批准的跨仓第二步）；在此之前宿主在调用
 * validateStrictAnalystEpochV1 前自行合并，缺少封印段会在此 fail-closed。
 */
export interface StrictAnalystEpochInputV1 {
  /**
   * 这是 Core 的 analysis review context hash（createAnalysisReviewContextHashV1），不是最终
   * fixpoint receipt hash。它依赖本 epoch 的 cluster set，由宿主在封印审查时计算并注入，模型
   * 不输出；createStrictAnalysisFixpointV1 会用完整 schedule/population/cluster 集重新计算并对账。
   */
  readonly currentAnalysisFixpointHash: string;
  /** 宿主权威：已执行的全部 factId，覆盖模型回传的同名字段。 */
  readonly knownFactIds: readonly string[];
  /** 宿主权威：已登记的全部 obligationId，覆盖模型回传的同名字段。 */
  readonly enrolledObligationIds: readonly string[];
  /** 宿主权威：canonical population 及其真实 Core execution receipts，覆盖模型回传的同名结构。 */
  readonly population: ObservationPopulationInputV1;
  readonly clusterInputs: readonly KnowledgeClusterInputV1[];
  readonly nonClusteredDispositions: readonly {
    readonly observationId: string;
    readonly status: 'discarded' | 'unresolved';
    readonly reasonCode: string;
    /** 宿主注入的 cluster-discard 回执（discarded 必需），不是模型输出。 */
    readonly dispositionReview?: KnowledgeDispositionReviewV1;
    readonly owner?: string;
    readonly resumePoint?: string;
  }[];
  readonly inductionInputs: readonly StrictInductionInputV1[];
  readonly falsificationInputs: readonly StrictFalsificationInputV1[];
  readonly hypothesisDispositions: readonly StrictHypothesisDispositionV1[];
  /**
   * 精确 review ledger，由宿主从其注入的回执汇总，不是模型输出；必须与上述 consumer 实际嵌入
   * 的 review 一一相等，额外行即 orphan。
   */
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

/** 模型 JSON 形状不合法（缺容器、元素非对象等）的统一错误码，detail 为字段路径。 */
const ANALYST_INPUT_SHAPE_INVALID = 'STRICT_ANALYST_INPUT_SHAPE_INVALID';

export function validateStrictAnalystEpochV1(
  input: StrictAnalystEpochInputV1
): StrictAnalystEpochV1 {
  if (!isPlainRecord(input)) {
    fail(ANALYST_INPUT_SHAPE_INVALID, 'input');
  }
  // 封印段的 review context hash 先于容器形状校验：缺整段宿主封印（跨仓第二步前的纯提案）时，
  // 仍按既有码报告“缺封印”，而不是报告其中某个回执容器缺失。
  requireCoreHash(input.currentAnalysisFixpointHash, 'STRICT_ANALYST_REVIEW_CONTEXT_HASH_INVALID');
  assertStrictAnalystInputShape(input);
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

/**
 * 模型 JSON 进入核心校验前的形状守卫（C24）。宿主 parseAnalystEnvelope 只做类型断言，TS 类型在
 * 运行时约束不到模型输出；这里只核对 Agent 自己会解引用的容器与元素形状，字段语义仍交给后续
 * 校验与 Core 构造器裁决。失败抛 `STRICT_ANALYST_INPUT_SHAPE_INVALID: <字段路径>`，G1 的 reject
 * reason 因此能区分“模型输出格式不合法”与“语义/权威不一致”，而不是一条无码 TypeError。
 * 宿主封印段（dispositionReview、dispositionReviews）一并检查容器形状，回执内容仍由 Core 断言。
 */
function assertStrictAnalystInputShape(input: StrictAnalystEpochInputV1): void {
  requireRecordArray(input.clusterInputs, 'clusterInputs');
  requireRecordArray(input.nonClusteredDispositions, 'nonClusteredDispositions');
  requireRecordArray(input.inductionInputs, 'inductionInputs').forEach((induction, index) => {
    const path = `inductionInputs[${index}]`;
    requireRecordArray(induction.hypotheses, `${path}.hypotheses`).forEach(
      (hypothesis, hypothesisIndex) => {
        requireArray(
          hypothesis.premiseFactIds,
          `${path}.hypotheses[${hypothesisIndex}].premiseFactIds`
        );
      }
    );
  });
  requireRecordArray(input.falsificationInputs, 'falsificationInputs').forEach(
    (falsification, index) => {
      const path = `falsificationInputs[${index}]`;
      // counterqueryApplicability 会被 Object.hasOwn 与展开读取，非对象时 Core 之前就会抛 TypeError。
      if (!isPlainRecord(falsification.counterqueryApplicability)) {
        fail(ANALYST_INPUT_SHAPE_INVALID, `${path}.counterqueryApplicability`);
      }
      requireArray(falsification.enrolledCounterqueryIds, `${path}.enrolledCounterqueryIds`);
      requireRecordArray(falsification.executions, `${path}.executions`).forEach(
        (execution, executionIndex) => {
          requireArray(
            execution.counterexampleFactIds,
            `${path}.executions[${executionIndex}].counterexampleFactIds`
          );
        }
      );
      if (!isPlainRecord(falsification.dispositionReview)) {
        fail(ANALYST_INPUT_SHAPE_INVALID, `${path}.dispositionReview`);
      }
    }
  );
  requireRecordArray(input.hypothesisDispositions, 'hypothesisDispositions').forEach(
    (disposition, index) => {
      const path = `hypothesisDispositions[${index}]`;
      const { hypothesisId, causalParentHypothesisId } = disposition;
      if (typeof hypothesisId !== 'string' || hypothesisId.trim().length === 0) {
        fail(ANALYST_INPUT_SHAPE_INVALID, `${path}.hypothesisId`);
      }
      // 契约是“narrowed 时给出，否则省略”；null 视同省略（投影时归一并记录诊断），其他类型拒绝。
      if (
        causalParentHypothesisId !== undefined &&
        causalParentHypothesisId !== null &&
        typeof causalParentHypothesisId !== 'string'
      ) {
        fail(ANALYST_INPUT_SHAPE_INVALID, `${path}.causalParentHypothesisId`);
      }
    }
  );
  requireRecordArray(input.dispositionReviews, 'dispositionReviews');
}

/** 普通 JSON 对象：非 null、非数组。模型 JSON 解码后只会出现这类对象。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(ANALYST_INPUT_SHAPE_INVALID, path);
  }
  return value;
}

function requireRecordArray(value: unknown, path: string): readonly Record<string, unknown>[] {
  const rows = requireArray(value, path);
  rows.forEach((row, index) => {
    if (!isPlainRecord(row)) {
      fail(ANALYST_INPUT_SHAPE_INVALID, `${path}[${index}]`);
    }
  });
  return rows as readonly Record<string, unknown>[];
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
  // 数组元素顺序直接进入 epochHash（hashCanonical 只排对象键）：与键排序同样固定 en 排序规则，
  // 不随进程默认区域变化；en/zh 环境下与历史顺序一致。
  const executionReceipts = [...(input.population.executionReceipts ?? [])].sort((left, right) =>
    left.obligationId.localeCompare(right.obligationId, 'en')
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
  const projected = projectStrictHypothesisDispositions(input.hypothesisDispositions);
  // 外部解码结果不受 TS union 约束；非法标签不能绕过 unknown 的 fixpoint 失败路径。
  for (const disposition of projected) {
    if (!['survived', 'narrowed', 'refuted', 'unknown'].includes(disposition.status)) {
      fail('STRICT_ANALYST_HYPOTHESIS_DISPOSITION_INVALID', disposition.hypothesisId);
    }
  }
  const falsificationByHypothesis = new Map(
    falsifications.map((receipt) => [receipt.hypothesisId, receipt])
  );
  // 处置顺序决定 hypothesisDispositions 与 producerEligibleHypotheses 的顺序并进入 epochHash，固定 en。
  const dispositions = [...projected].sort((left, right) =>
    left.hypothesisId.localeCompare(right.hypothesisId, 'en')
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

const HYPOTHESIS_DISPOSITION_CONTRACT_FIELDS: ReadonlySet<string> = new Set([
  'hypothesisId',
  'status',
  'causalParentHypothesisId',
]);

/**
 * 处置行只投影契约字段后才进入 epoch 与 epochHash（C24）：模型附加的 notes 等自由文本不改变同一
 * 语义 epoch 的哈希。合法行（只含契约字段）投影前后逐字节相同，哈希不变；显式 null 的
 * causalParentHypothesisId 按“省略”处理（JSON.stringify 原本就丢弃 undefined，null 则会进入哈希）。
 * 发生丢字段或 null 归一时记录诊断，便于追查模型输出偏离契约；诊断不参与裁决。
 * 形状（hypothesisId 为非空字符串、causalParentHypothesisId 为字符串/null/缺省）已由
 * assertStrictAnalystInputShape 在入口保证。
 */
function projectStrictHypothesisDispositions(
  rows: readonly StrictHypothesisDispositionV1[]
): StrictHypothesisDispositionV1[] {
  const droppedFields = new Set<string>();
  const nullParentHypothesisIds: string[] = [];
  const projected = rows.map((row): StrictHypothesisDispositionV1 => {
    for (const key of Object.keys(row)) {
      if (!HYPOTHESIS_DISPOSITION_CONTRACT_FIELDS.has(key)) {
        droppedFields.add(key);
      }
    }
    const parent: unknown = row.causalParentHypothesisId;
    if (parent === null) {
      nullParentHypothesisIds.push(row.hypothesisId);
    }
    return {
      hypothesisId: row.hypothesisId,
      status: row.status,
      ...(typeof parent === 'string' ? { causalParentHypothesisId: parent } : {}),
    };
  });
  if (droppedFields.size > 0 || nullParentHypothesisIds.length > 0) {
    // 诊断只观察不裁决：observeSafely 吞掉日志观察器异常，投影结果不因诊断失败而改变。
    observeSafely(
      () =>
        Logger.getInstance().info(
          '[StrictAnalyst] hypothesis dispositions projected to contract fields',
          {
            component: 'validateStrictAnalystEpochV1',
            reason: 'model-output-outside-disposition-contract',
            selectedPath: 'project-contract-fields',
            droppedFields: [...droppedFields].sort(),
            nullParentHypothesisIds: [...nullParentHypothesisIds].sort(),
            rowCount: rows.length,
            followUpCheck: 'epoch-hash-covers-contract-fields-only',
          }
        ),
      () => undefined
    );
  }
  return projected;
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
  // review ledger 顺序进入 epochHash，固定 en 排序规则，不随进程默认区域变化。
  return [...declared].sort((left, right) =>
    left.reviewReceiptId.localeCompare(right.reviewReceiptId, 'en')
  );
}

export function assertAnalysisFixpointIntegrity(fixpoint: AnalysisFixpointReceiptV1): void {
  const { fixpointHash, ...semantic } = fixpoint;
  if (fixpoint.schemaVersion !== 1 || hashCoreCanonical(semantic) !== fixpointHash) {
    fail('STRICT_PRODUCER_LINEAGE_FIXPOINT_HASH_MISMATCH');
  }
}
