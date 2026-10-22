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
  /**
   * narrowed 必填、survived 禁止携带；给出时必须是本 epoch 内另一个非 refuted/unknown 假设的
   * 原样 ID（C23，校验见 assertStrictCausalParent）。
   */
  readonly causalParentHypothesisId?: string;
}

export interface StrictFalsificationInputV1 {
  readonly hypothesisId: string;
  readonly enrolledCounterqueryIds: readonly string[];
  /**
   * 模型只提交 counterqueryId（必须等于 obligationId）、obligationId 与 counterexampleFactIds；
   * executionReceipt 是宿主执行权威，validateStrictAnalystEpochV1 按 obligationId 从宿主覆盖过的
   * population.executionReceipts 绑定，调用方传入的值一律丢弃（C028）。公开类型仍要求该字段，
   * 拆成可选属于跨仓第二步的输入类型拆分。
   */
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
 *   falsificationInputs[].executions[].executionReceipt 由 validateStrictAnalystEpochV1 从
 *   population.executionReceipts 按 obligationId 绑定；
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
  /**
   * 宿主权威：已执行的全部 factId，覆盖模型回传的同名字段。population 事实必须是它的子集；
   * 假设 premiseFactIds 与反查 counterexampleFactIds 还必须落在 population 事实内（C22），
   * 这样 epoch 不携带本集合也能在重建时按同一口径复核。
   */
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
  return validateStrictAnalystEpochWithAuthority(input, 'host-known-fact-ids');
}

/**
 * 首次校验与重建（rebuildStrictAnalystEpoch）共用的校验管线。factAuthoritySource 只标记事实权威的
 * 来源，供 assertFactsWithinPopulation 在重建的 *_FACT_OUTSIDE_POPULATION 失败关闭处记录归类诊断；
 * 它不改变任何校验规则、顺序或错误码，两条路径对同一输入的结果与 epochHash 完全相同。
 */
function validateStrictAnalystEpochWithAuthority(
  input: StrictAnalystEpochInputV1,
  factAuthoritySource: StrictAnalystFactAuthoritySource
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
  const facts: StrictAnalystFactAuthority = {
    source: factAuthoritySource,
    knownFactIds,
    populationFactIds: collectStrictPopulationFactIds(population),
  };
  const clusterSet = createStrictClusterSet(input, population);
  const inductions = createStrictInductions(input, population, clusterSet, facts);
  const hypotheses = indexStrictHypotheses(inductions);
  const falsifications = createStrictFalsifications(input, hypotheses, facts, executionReceipts);
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

/**
 * 事实权威的来源：首次校验是宿主 knownFactIds；重建没有宿主权威，只能从 epoch 自身推导。
 * 仅用于诊断归属，不参与裁决。
 */
type StrictAnalystFactAuthoritySource = 'host-known-fact-ids' | 'epoch-rebuild';

/**
 * 假设前提与反查反例的两层事实口径（C22）：
 * - knownFactIds：首次校验时是宿主权威（已执行的全部 factId），不在其中即模型杜撰，沿用
 *   *_FACT_INVENTED；重建时没有宿主权威，取规范形 population 事实与 epoch 自引规范形事实的并集
 *   （见 rebuildStrictAnalystEpoch），只拦非规范元素；
 * - populationFactIds：canonical population 四类观测的 factId 并集，是 epoch 自身携带、重建时
 *   唯一能复算的事实集合。宿主已知但不在 population 的事实以 *_FACT_OUTSIDE_POPULATION 拒绝，
 *   首次校验与重建同码，不再出现“首次通过、重建才报杜撰”。宿主从未执行的规范形事实两条路径
 *   仍不同码：首次校验先按宿主权威报 *_FACT_INVENTED，重建分不清“从未执行”与“不在 population”，
 *   报 *_FACT_OUTSIDE_POPULATION 并记归类诊断（见 assertFactsWithinPopulation）；两者都失败关闭。
 */
interface StrictAnalystFactAuthority {
  readonly source: StrictAnalystFactAuthoritySource;
  readonly knownFactIds: ReadonlySet<string>;
  readonly populationFactIds: ReadonlySet<string>;
}

/**
 * population 事实全集：accepted/duplicate/excluded/error 四类观测的 factId（inspectedNoPattern
 * 观测不携带事实）。首次校验与重建共用此函数，读取的都是 canonical population（即 epoch.population）。
 */
function collectStrictPopulationFactIds(population: ObservationPopulationV1): ReadonlySet<string> {
  return new Set([
    ...population.observations.flatMap((row) => row.factIds),
    ...population.duplicateObservations.flatMap((row) => row.factIds),
    ...population.excludedObservations.flatMap((row) => row.factIds),
    ...population.errorObservations.flatMap((row) => row.factIds),
  ]);
}

/**
 * 先按宿主权威判“杜撰”，再按 population 判“越出 population”：population 事实已在
 * validateStrictPopulationAuthority 中确认是 knownFactIds 的子集，所以真正未执行的事实仍得到
 * 原有的 *_FACT_INVENTED 码，只有宿主已知但不属于 population 的事实才得到新码。
 * 非字符串元素在两个集合中都查不到，按杜撰拒绝。重建路径的 knownFactIds 已并入 epoch 自引的
 * 规范形事实，invented 分支只剩非规范元素，population 外的事实统一落到 outsidePopulation 分支；
 * 重建在该分支失败关闭前记归类诊断，诊断只在归类真的发生时产生（更早的失败走不到这里）。
 */
function assertFactsWithinPopulation(
  factIds: readonly string[],
  facts: StrictAnalystFactAuthority,
  codes: { readonly invented: string; readonly outsidePopulation: string },
  hypothesisId: string
): void {
  if (factIds.some((factId) => !facts.knownFactIds.has(factId))) {
    fail(codes.invented, hypothesisId);
  }
  const outsidePopulation = factIds.filter((factId) => !facts.populationFactIds.has(factId));
  if (outsidePopulation.length === 0) {
    return;
  }
  if (facts.source === 'epoch-rebuild') {
    logRebuildFactsOutsidePopulation(
      outsidePopulation,
      facts,
      codes.outsidePopulation,
      hypothesisId
    );
  }
  fail(codes.outsidePopulation, hypothesisId);
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
  facts: StrictAnalystFactAuthority
): InductionReceiptV1[] {
  const clustersByMechanism = new Map<string, KnowledgeClusterSetV1['clusters'][number]>();
  for (const cluster of clusterSet.clusters) {
    if (clustersByMechanism.has(cluster.mechanismKey)) {
      fail('STRICT_ANALYST_CLUSTER_MECHANISM_DUPLICATE', cluster.mechanismKey);
    }
    clustersByMechanism.set(cluster.mechanismKey, cluster);
  }
  const projectedHypotheses = projectStrictInductionHypotheses(input.inductionInputs);
  const receipts = input.inductionInputs.map((induction, inductionIndex) => {
    const cluster = clustersByMechanism.get(induction.mechanismKey);
    if (!cluster) {
      fail('STRICT_ANALYST_INDUCTION_CLUSTER_UNKNOWN', induction.mechanismKey);
    }
    const hypotheses = projectedHypotheses[inductionIndex];
    for (const hypothesis of hypotheses) {
      assertFactsWithinPopulation(
        hypothesis.premiseFactIds,
        facts,
        {
          invented: 'STRICT_ANALYST_HYPOTHESIS_FACT_INVENTED',
          outsidePopulation: 'STRICT_ANALYST_HYPOTHESIS_FACT_OUTSIDE_POPULATION',
        },
        hypothesis.hypothesisId
      );
    }
    return createInductionReceiptV1({
      populationHash: population.populationHash,
      clusterHash: hashKnowledgeClusterV1(cluster),
      clusterId: cluster.clusterId,
      observationIds: cluster.observationIds,
      mode: induction.mode,
      hypotheses,
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
  facts: StrictAnalystFactAuthority,
  executionReceipts: readonly FactQueryExecutionReceiptV1[]
): FalsificationReceiptV1[] {
  const externallyEnrolled = new Set(
    normalizeIds(input.enrolledObligationIds, 'enrolledObligationIds')
  );
  const projectedApplicability = projectStrictCounterqueryApplicability(input.falsificationInputs);
  // Core canonicalizeObservationPopulationV1 已保证权威回执按 obligationId 唯一且自洽。
  const receiptsByObligation = new Map(
    executionReceipts.map((receipt) => [receipt.obligationId, receipt] as const)
  );
  const replacedReceipts: StrictReplacedExecutionReceipts = {
    hypothesisIds: new Set(),
    obligationIds: new Set(),
  };
  const receipts = input.falsificationInputs.map((candidate, candidateIndex) => {
    if (!hypotheses.has(candidate.hypothesisId)) {
      fail('STRICT_ANALYST_FALSIFICATION_HYPOTHESIS_UNKNOWN', candidate.hypothesisId);
    }
    if (candidate.enrolledCounterqueryIds.some((id) => !externallyEnrolled.has(id))) {
      fail('STRICT_ANALYSIS_QUERY_UNENROLLED', candidate.hypothesisId);
    }
    assertFactsWithinPopulation(
      candidate.executions.flatMap((execution) => execution.counterexampleFactIds),
      facts,
      {
        invented: 'STRICT_ANALYST_COUNTEREXAMPLE_FACT_INVENTED',
        outsidePopulation: 'STRICT_ANALYST_COUNTEREXAMPLE_FACT_OUTSIDE_POPULATION',
      },
      candidate.hypothesisId
    );
    return createFalsificationReceiptV1({
      ...candidate,
      executions: bindStrictCounterqueryExecutionReceipts(
        candidate,
        receiptsByObligation,
        replacedReceipts
      ),
      counterqueryApplicability: {
        ...projectedApplicability[candidateIndex],
        reviewerReceiptId: candidate.dispositionReview.reviewReceiptId,
      },
      currentAnalysisFixpointHash: input.currentAnalysisFixpointHash,
    });
  });
  logStrictReplacedExecutionReceipts(replacedReceipts);
  assertSameIds(
    receipts.map((receipt) => receipt.hypothesisId),
    [...hypotheses.keys()],
    'STRICT_ANALYST_FALSIFICATION_CONSERVATION'
  );
  return receipts;
}

/** 回传了与权威不同回执的反查行，供一次性汇总诊断；只记 ID，不记回执内容。 */
interface StrictReplacedExecutionReceipts {
  readonly hypothesisIds: Set<string>;
  readonly obligationIds: Set<string>;
}

/**
 * 反查执行回执的权威绑定（C028）。执行回执是宿主执行权威：宿主在调用前用自己的执行记录覆盖
 * population.executionReceipts，而模型可见的 canonical population 不带回执正文，回执又必带
 * neverEmit 的 receiptHash，所以模型只给 counterqueryId/obligationId/counterexampleFactIds，
 * 这里按 obligationId 绑定权威回执：
 * - counterqueryId 必须与 obligationId 原值相等（Core 同样要求），否则以
 *   STRICT_ANALYST_COUNTERQUERY_ID_MISMATCH 提前拒绝，让 G1 归为语义拒绝而不是无前缀 Core 码；
 * - obligationId 在权威回执中不存在：STRICT_ANALYST_COUNTERQUERY_RECEIPT_MISSING，取代 Core 解引用
 *   undefined 回执的无码 TypeError；
 * - 模型回传的 executionReceipt 一律丢弃：与权威规范 JSON 相同（重建路径、合规抄写）时静默，
 *   不同或残缺（如遵守 neverEmit 而缺 receiptHash）时记入 replaced，由调用方汇总记 warn。
 * 合法输入（回执缺省或等于权威）绑定后与原输入逐字节相同，falsification receiptHash 与 epochHash
 * 不变。重建时权威是 epoch.executionReceipts，被改写的回执在这里被换回，重建哈希随之对不上而失败关闭。
 * 行形状（对象、counterexampleFactIds 为数组）已由 assertStrictAnalystInputShape 保证；登记、去重与
 * 反例事实绑定仍由 Core normalizeFalsificationExecutions 裁决。
 */
function bindStrictCounterqueryExecutionReceipts(
  candidate: StrictFalsificationInputV1,
  receiptsByObligation: ReadonlyMap<string, FactQueryExecutionReceiptV1>,
  replaced: StrictReplacedExecutionReceipts
): CounterqueryExecutionV1[] {
  return candidate.executions.map((execution): CounterqueryExecutionV1 => {
    const obligationId: unknown = execution.obligationId;
    if (execution.counterqueryId !== obligationId) {
      fail('STRICT_ANALYST_COUNTERQUERY_ID_MISMATCH', candidate.hypothesisId);
    }
    const receipt =
      typeof obligationId === 'string' ? receiptsByObligation.get(obligationId) : undefined;
    if (!receipt) {
      fail(
        'STRICT_ANALYST_COUNTERQUERY_RECEIPT_MISSING',
        `${candidate.hypothesisId} -> ${typeof obligationId === 'string' ? obligationId : `<${typeof obligationId}>`}`
      );
    }
    const supplied: unknown = execution.executionReceipt;
    if (supplied !== undefined && hashCanonical(supplied) !== hashCanonical(receipt)) {
      replaced.hypothesisIds.add(candidate.hypothesisId);
      replaced.obligationIds.add(receipt.obligationId);
    }
    return { ...execution, executionReceipt: receipt };
  });
}

/** 模型回传的执行回执被权威替换时的汇总诊断；observeSafely 吞掉观察器异常，不影响绑定结果。 */
function logStrictReplacedExecutionReceipts(replaced: StrictReplacedExecutionReceipts): void {
  if (replaced.obligationIds.size === 0) {
    return;
  }
  observeSafely(
    () =>
      Logger.getInstance().warn(
        '[StrictAnalyst] supplied counterquery execution receipts replaced by population authority',
        {
          component: 'validateStrictAnalystEpochV1',
          reason: 'execution-receipt-is-host-owned',
          selectedPath: 'override-with-population-receipt',
          hypothesisIds: [...replaced.hypothesisIds].sort(),
          obligationIds: [...replaced.obligationIds].sort(),
          followUpCheck: 'model-must-omit-executionReceipt-per-output-contract',
        }
      ),
    () => undefined
  );
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
  // 守恒已保证处置行与本 epoch 假设一一对应；父假设的状态取其处置行声明的状态（该状态在本循环
  // 中逐行与 falsification verdict 对账，任一行不一致整个 epoch 都会失败关闭）。
  const statusByHypothesis = new Map(dispositions.map((row) => [row.hypothesisId, row.status]));
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
    const producerEligible = disposition.status === 'survived' || disposition.status === 'narrowed';
    if (
      producerEligible &&
      falsification.verdict !== 'survived' &&
      falsification.verdict !== 'not-required'
    ) {
      fail('STRICT_ANALYST_PRODUCER_ELIGIBILITY_INVALID', disposition.hypothesisId);
    }
    // 父假设校验放在 verdict 对账之后，保持既有错误码的报告顺序（先 eligibility，再父假设）。
    assertStrictCausalParent(disposition, statusByHypothesis);
    if (producerEligible) {
      producerEligibleHypotheses.push({
        ...hypothesis,
        status: disposition.status,
        dispositionReviewReceiptId: falsification.dispositionReviewReceiptId,
        // 走到这里时 survived 必无父 ID、narrowed 必有已校验的父 ID。
        ...(disposition.causalParentHypothesisId !== undefined
          ? { causalParentHypothesisId: disposition.causalParentHypothesisId }
          : {}),
      });
    }
  }
  return { dispositions, producerEligibleHypotheses };
}

/** 被证伪或未决的假设不能作为任何收窄的来源。 */
const CAUSAL_PARENT_INELIGIBLE_STATUSES: ReadonlySet<StrictHypothesisDispositionV1['status']> =
  new Set(['refuted', 'unknown']);

/**
 * 因果父假设校验（C23）。causalParentHypothesisId 是模型输出（宿主 parseAnalystEnvelope 只做类型
 * 断言），会随 producerEligibleHypotheses 进入 Producer 输入、lineage 的 hypothesisHash 与
 * knowledgeRootId，并随 hypothesisDispositions 进入 epochHash 与持久化 epoch，所以封印前必须确认
 * 它指向本 epoch 内真实、仍成立的另一个假设：
 * - 缺省（null 已在投影时归一为缺省）：narrowed 必填，沿用 STRICT_ANALYST_NARROWING_PARENT_REQUIRED；
 * - survived 携带父 ID：契约是“仅 narrowed 时给出”，按 STRICT_ANALYST_SURVIVED_CAUSAL_PARENT_FORBIDDEN
 *   拒绝而不是静默丢弃，让 G1 把这类偏离契约的输出退回模型；
 * - 空串或纯空白：STRICT_ANALYST_CAUSAL_PARENT_BLANK；
 * - 指向自身：STRICT_ANALYST_CAUSAL_PARENT_SELF_REFERENCE；
 * - 不在本 epoch 假设集合内：STRICT_ANALYST_CAUSAL_PARENT_UNKNOWN。按原值精确比较、不 trim，带首尾
 *   空白的 ID 视为不存在。只认本 epoch：跨 epoch 父假设需要调用方传入此前的假设集合，属于公开
 *   输入类型变更，未采纳；
 * - 父假设为 refuted/unknown：STRICT_ANALYST_CAUSAL_PARENT_INELIGIBLE。
 * refuted/unknown 行若携带父 ID，同样按后四条校验（父 ID 同样进入 epochHash）。重建
 * （assertStrictAnalystEpochIntegrity）会重新执行本校验，改写父 ID 后重算 epochHash 无法自证；
 * 只改派生的 producerEligibleHypotheses、不重算 epochHash 时，由同一函数的存储内容哈希复核拦下。
 * 本层只拒绝自引用，不判定多跳环（h1→h2→h1）。
 */
function assertStrictCausalParent(
  disposition: StrictHypothesisDispositionV1,
  statusByHypothesis: ReadonlyMap<string, StrictHypothesisDispositionV1['status']>
): void {
  const { hypothesisId, status, causalParentHypothesisId: parent } = disposition;
  if (parent === undefined) {
    if (status === 'narrowed') {
      fail('STRICT_ANALYST_NARROWING_PARENT_REQUIRED', hypothesisId);
    }
    return;
  }
  if (status === 'survived') {
    fail('STRICT_ANALYST_SURVIVED_CAUSAL_PARENT_FORBIDDEN', hypothesisId);
  }
  if (parent.trim().length === 0) {
    fail('STRICT_ANALYST_CAUSAL_PARENT_BLANK', hypothesisId);
  }
  if (parent === hypothesisId) {
    fail('STRICT_ANALYST_CAUSAL_PARENT_SELF_REFERENCE', hypothesisId);
  }
  const parentStatus = statusByHypothesis.get(parent);
  if (parentStatus === undefined) {
    fail('STRICT_ANALYST_CAUSAL_PARENT_UNKNOWN', hypothesisId);
  }
  if (CAUSAL_PARENT_INELIGIBLE_STATUSES.has(parentStatus)) {
    fail('STRICT_ANALYST_CAUSAL_PARENT_INELIGIBLE', hypothesisId);
  }
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

/** Core HypothesisV1 声明的全部字段；其余键都是模型附加内容。 */
const HYPOTHESIS_CONTRACT_FIELDS: ReadonlySet<string> = new Set([
  'hypothesisId',
  'statement',
  'premiseFactIds',
]);

/**
 * 模型提交的 counterqueryApplicability 提案字段；reviewerReceiptId 由宿主封印回执派生，
 * 模型携带时已在 rejectLegacySemanticAuthority 中失败关闭，走不到投影。
 */
const COUNTERQUERY_APPLICABILITY_CONTRACT_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'reasonCode',
]);

type StrictCounterqueryApplicabilityProposalV1 =
  StrictFalsificationInputV1['counterqueryApplicability'];

/**
 * 假设行只投影 HypothesisV1 契约字段后才交给 Core（C044，与 C24 处置行同根）。Core
 * normalizeInductionHypotheses 用展开保留全部键，未投影时模型附加的 notes 等自由文本会进入
 * induction receiptHash、epochHash，并经 producerEligibleHypotheses 流入 lineage 的
 * hypothesisHash；重建复用回执里的假设，额外键还会被原样带回从而“自证”通过。
 * 合法行（只含契约字段）投影前后逐字节相同，哈希不变；投影在所有 Core 调用之前完成，丢字段时
 * 先记一条 info 诊断（只记键名与假设 ID，不记内容），诊断不参与裁决。
 * 形状（hypotheses 为对象数组、premiseFactIds 为数组）已由 assertStrictAnalystInputShape 保证；
 * 字段值语义仍交给 assertFactsWithinPopulation 与 Core 构造器裁决。
 */
function projectStrictInductionHypotheses(
  inductions: readonly StrictInductionInputV1[]
): HypothesisV1[][] {
  const droppedFields = new Set<string>();
  const affectedHypothesisIds = new Set<string>();
  const projected = inductions.map((induction) =>
    induction.hypotheses.map((hypothesis): HypothesisV1 => {
      if (collectNonContractFields(hypothesis, HYPOTHESIS_CONTRACT_FIELDS, droppedFields)) {
        affectedHypothesisIds.add(String(hypothesis.hypothesisId));
      }
      return {
        hypothesisId: hypothesis.hypothesisId,
        statement: hypothesis.statement,
        premiseFactIds: hypothesis.premiseFactIds,
      };
    })
  );
  logStrictContractProjection(
    '[StrictAnalyst] induction hypotheses projected to contract fields',
    'model-output-outside-hypothesis-contract',
    droppedFields,
    affectedHypothesisIds,
    'epoch-hash-and-lineage-cover-hypothesis-contract-fields-only'
  );
  return projected;
}

/**
 * counterqueryApplicability 只投影 {status, reasonCode} 后再追加宿主派生的 reviewerReceiptId
 * （C044）。Core createFalsificationReceiptV1 展开保留全部键并写进 receiptHash，而审查回执的
 * proposedDispositionHash 只覆盖 status/reasonCode，所以模型附加键既不受审查约束、又会改变
 * epochHash。投影后合法输入逐字节不变；丢字段时记 info 诊断，诊断不参与裁决。
 * 对象形状已由 assertStrictAnalystInputShape 保证；字段值仍由 Core validateFalsificationApplicability 裁决。
 */
function projectStrictCounterqueryApplicability(
  falsifications: readonly StrictFalsificationInputV1[]
): StrictCounterqueryApplicabilityProposalV1[] {
  const droppedFields = new Set<string>();
  const affectedHypothesisIds = new Set<string>();
  const projected = falsifications.map(
    (falsification): StrictCounterqueryApplicabilityProposalV1 => {
      const applicability = falsification.counterqueryApplicability;
      if (
        collectNonContractFields(
          applicability,
          COUNTERQUERY_APPLICABILITY_CONTRACT_FIELDS,
          droppedFields
        )
      ) {
        affectedHypothesisIds.add(String(falsification.hypothesisId));
      }
      return { status: applicability.status, reasonCode: applicability.reasonCode };
    }
  );
  logStrictContractProjection(
    '[StrictAnalyst] counterquery applicability projected to contract fields',
    'model-output-outside-applicability-contract',
    droppedFields,
    affectedHypothesisIds,
    'falsification-receipt-hash-covers-applicability-contract-fields-only'
  );
  return projected;
}

/** 把 row 中不属于契约的键记入 droppedFields；返回该行是否含契约外的键。 */
function collectNonContractFields(
  row: object,
  contractFields: ReadonlySet<string>,
  droppedFields: Set<string>
): boolean {
  let dropped = false;
  for (const key of Object.keys(row)) {
    if (!contractFields.has(key)) {
      droppedFields.add(key);
      dropped = true;
    }
  }
  return dropped;
}

/** 契约字段投影的诊断：只在确有字段被丢弃时记录；observeSafely 吞掉观察器异常，不影响投影结果。 */
function logStrictContractProjection(
  message: string,
  reason: string,
  droppedFields: ReadonlySet<string>,
  affectedHypothesisIds: ReadonlySet<string>,
  followUpCheck: string
): void {
  if (droppedFields.size === 0) {
    return;
  }
  observeSafely(
    () =>
      Logger.getInstance().info(message, {
        component: 'validateStrictAnalystEpochV1',
        reason,
        selectedPath: 'project-contract-fields',
        droppedFields: [...droppedFields].sort(),
        hypothesisIds: [...affectedHypothesisIds].sort(),
        followUpCheck,
      }),
    () => undefined
  );
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

/**
 * epoch 完整性复核：fixpoint 与 Producer lineage 入口都先调用，跨进程收到的 epoch 只有三项全部
 * 成立才放行，三项共用既有错误码，诊断里的 failedChecks 区分具体原因：
 * - schemaVersion 为 1；
 * - 重建 hash 等于存储 epochHash（rebuilt-epoch-hash）：重建只读 population、cluster set、
 *   inductions、falsifications、review ledger 与 hypothesisDispositions，按首次校验的规则重新推导；
 * - 存储内容（去掉 epochHash 后的全部字段）自身哈希到 epochHash（stored-content-hash，C010）。
 *   producerEligibleHypotheses 等派生字段不是重建的输入，只改它们、不重算 epochHash 时上一项仍然
 *   相等；本项把存储内容绑回 epochHash，否则悬空父假设、翻转的 status 或 population 外的前提会经
 *   lineage 进入 hypothesisHash。
 * 两项哈希都等于 epochHash，即存储内容与重建内容的规范 JSON（hashCanonical）一致。这是哈希级绑定，
 * 不逐值比较：非有限数在规范 JSON 里写成 null（差异已在 primitives.ts 的镜像注释登记），所以跨进程
 * JSON 文本在合法值为 null 的位置写入 1e400 之类的数，解析成 Infinity 后可能仍能通过。下面列出已知
 * 能这样通过本复核与 createStrictAnalysisFixpointV1、且 epochHash 与 fixpointHash 不变（假设可进入
 * lineage 时 lineageHash 也不变）的位置。这是按现有测试夹具（单假设的 not-required、带已执行反查
 * 的 survived 与 refuted、未执行反查的 unknown，以及多假设 narrowed；unknown 的 epoch 本身过不了
 * fixpoint，只核对了本复核）逐个替换 null 叶子核对的结果，未穷举证明：没有覆盖 discarded /
 * unresolved 处置行等其他形态，不能据此断言别处都会被拒。
 * - clusterSet.dispositions 里 clustered 行合法为 null 的字段（reasonCode、reviewerReceiptId、owner、
 *   resumePoint）：重建只读非 clustered 行，Core fixpoint 只读 status 与 clusterSetHash。
 * - 带已执行反查（refuted，或 required 且无反例的 survived）的 falsifications[].executions[] 里的
 *   executionReceipt.continuation 与 executionReceipt.fileExecutions[].continuation：重建会读取存储的
 *   executions 行，但 bindStrictCounterqueryExecutionReceipts 用 hashCanonical 比较存储回执与
 *   epoch.executionReceipts 里的权威回执，Infinity 坍缩成 null 后两者相等，不记 replaced 诊断，随后
 *   一律换成权威回执再交给 Core，Core 看不到 Infinity。存储的 verdict 仍是 survived / refuted；其中
 *   executionReceipt.continuation 为 Infinity 时，按 Core isCompleteCounterqueryExecution（要求回执
 *   continuation === null）重判存储的执行行会得到不完整，存储内容自相矛盾却能通过（该谓词不看
 *   fileExecutions[].continuation）。按本仓库 src 内的 grep 核对（宿主仓库不在核对范围内），除上面的
 *   重建绑定外，其余读取方都不读存储执行行里的回执：重建合成已知事实时取 counterexampleFactIds，
 *   createStrictAnalysisFixpointV1 从 falsification 读 receiptHash 与 currentAnalysisFixpointHash，
 *   lineage 读 hypothesisId、receiptHash、dispositionReviewReceiptId 与 currentAnalysisFixpointHash。
 * 同一批夹具里其余合法为 null 的叶子写入 1e400 后都被拒，这是已核对的对照：顶层 executionReceipts
 * 原样交给 Core，其 continuation 与 fileExecutions[].continuation 由 Core 规范 JSON 抛 TypeError；
 * population.parentPopulationHash、population.denominator.continuation 与 inductions[] 的
 * zeroHypothesisReason、zeroHypothesisReviewReceiptId 在重建中失败关闭（其中有 Core 的无前缀错误码
 * 与无码 TypeError）。lineage 读取的 producerEligibleHypotheses 行按类型没有合法为 null 的字段
 * （causalParentHypothesisId 是缺省而不是 null），替换其任一字段都会改变规范 JSON 而被拒。
 * 下游直接读取存储的派生字段，在上述已核对的范围内可信；新的读取方要读存储内容里合法为 null 的
 * 字段，须先核对该位置是否在可通过之列，或自行逐值校验。先重建、后比哈希，保持重建内各结构错误码
 * 的既有报告顺序。
 */
export function assertStrictAnalystEpochIntegrity(epoch: StrictAnalystEpochV1): void {
  const rebuilt = rebuildStrictAnalystEpoch(epoch);
  const { epochHash: storedEpochHash, ...storedSemantic } = epoch;
  const storedContentHash = hashCanonical(storedSemantic);
  const failedChecks = [
    ...(epoch.schemaVersion !== 1 ? ['schema-version'] : []),
    ...(rebuilt.epochHash !== storedEpochHash ? ['rebuilt-epoch-hash'] : []),
    ...(storedContentHash !== storedEpochHash ? ['stored-content-hash'] : []),
  ];
  if (failedChecks.length === 0) {
    return;
  }
  // 诊断只观察不裁决：observeSafely 吞掉日志观察器异常，失败关闭不因诊断失败而改变。
  observeSafely(
    () =>
      Logger.getInstance().warn('[StrictAnalyst] epoch integrity mismatch', {
        component: 'assertStrictAnalystEpochIntegrity',
        reason: 'epoch-content-not-bound-to-epoch-hash',
        selectedPath: 'fail-closed',
        failedChecks,
        storedEpochHash,
        rebuiltEpochHash: rebuilt.epochHash,
        storedContentHash,
        followUpCheck: 're-validate-epoch-from-host-authority-before-lineage',
      }),
    () => undefined
  );
  fail('STRICT_PRODUCER_LINEAGE_EPOCH_HASH_MISMATCH');
}

/**
 * epochHash 不是 authority。跨进程收到 epoch 后把 population/cluster/induction/falsification/
 * review 全部送回公开 Core constructors，并重跑本文件的结构校验（含 C23 父假设校验），只改内容、
 * 重算外层 hash 的 epoch 因此无法自证。
 *
 * 重建复核的范围只有结构一致性与 Core 构造器不变量，不复核宿主的外部权威：epoch 不携带
 * knownFactIds/enrolledObligationIds，只能从 epoch 自身推导——
 * - 已知事实取规范形的 population 事实，并上 epoch 自己引用的规范形前提/反例事实（C042）。重建
 *   拿不到宿主集合，分不清“宿主执行过但不在 population”与“从未执行”，只能判断是否属于
 *   population：并集让规范形事实都越过 invented 判断，population 外的统一报
 *   *_FACT_OUTSIDE_POPULATION（宿主已知的事实与首次校验同码；从未执行的事实首次校验报
 *   *_FACT_INVENTED），并在失败关闭处记归类诊断。非规范元素（非字符串、空串、带首尾空白）宿主权威
 *   经 normalizeIds 后不可能存在，所以一律不并入：population 观测里的非规范元素与首次校验一样在
 *   validateStrictPopulationAuthority 报 STRICT_ANALYST_FACT_INVENTED: <observationId>，前提/反例里的
 *   报 *_FACT_INVENTED。合成的 knownFactIds 因此恒为规范形集合，不会因并集经 trim 后重复而以 epoch
 *   并不携带的 knownFactIds 字段报 STRICT_ID_SET_INVALID。合法 epoch 的事实都是规范形且在
 *   population 内，并集不改变重建结果与 epochHash。
 * - 已登记 obligation 取 executionReceipts 与 falsification 自带的 enrolledCounterqueryIds，
 *   STRICT_ANALYSIS_QUERY_UNENROLLED 在重建中必然通过，反查登记的真实性只由首次校验对宿主集合把关。
 */
function rebuildStrictAnalystEpoch(epoch: StrictAnalystEpochV1): StrictAnalystEpochV1 {
  const knownFactIds = new Set([
    ...[...collectStrictPopulationFactIds(epoch.population)].filter(isCanonicalFactId),
    ...collectStrictEpochClaimedFactIds(epoch),
  ]);
  const enrolledObligationIds = new Set([
    ...epoch.executionReceipts.map((receipt) => receipt.obligationId),
    ...epoch.falsifications.flatMap((receipt) => receipt.enrolledCounterqueryIds),
  ]);
  return validateStrictAnalystEpochWithAuthority(
    {
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
    },
    'epoch-rebuild'
  );
}

/**
 * 规范形事实 ID：非空、无首尾空白的字符串，即宿主 knownFactIds 经 normalizeIds 后可能出现的形态。
 * 重建合成 knownFactIds 时只并入这类值（population 事实与 epoch 自引事实同一口径）。
 */
function isCanonicalFactId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/**
 * epoch 自己引用的前提与反例事实（C042），供重建并入已知事实集。只收规范形 ID
 * （isCanonicalFactId）；其余元素不并入，按首次校验同样的口径报 *_FACT_INVENTED。形状不对的容器
 * 在这里跳过，留给 assertStrictAnalystInputShape 报 STRICT_ANALYST_INPUT_SHAPE_INVALID，避免在
 * 收集阶段抛出无码 TypeError。
 */
function collectStrictEpochClaimedFactIds(epoch: StrictAnalystEpochV1): ReadonlySet<string> {
  const claimed = new Set<string>();
  const collect = (values: unknown): void => {
    if (!Array.isArray(values)) {
      return;
    }
    for (const value of values) {
      if (isCanonicalFactId(value)) {
        claimed.add(value);
      }
    }
  };
  for (const induction of plainRecordsOf(epoch.inductions)) {
    for (const hypothesis of plainRecordsOf(induction.hypotheses)) {
      collect(hypothesis.premiseFactIds);
    }
  }
  for (const falsification of plainRecordsOf(epoch.falsifications)) {
    for (const execution of plainRecordsOf(falsification.executions)) {
      collect(execution.counterexampleFactIds);
    }
  }
  return claimed;
}

function plainRecordsOf(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlainRecord) : [];
}

/**
 * 重建把 population 外的规范形事实归类为 *_FACT_OUTSIDE_POPULATION 时的诊断（C042）。由
 * assertFactsWithinPopulation 在该分支失败关闭前调用，所以只在归类真的发生时记录，并带上实际抛出的
 * 错误码与假设 ID：重建因更早原因（review context hash、population 权威、cluster 等）被拒时不会
 * 记下一条没有发生的归类路径。重建没有宿主权威，诊断写明无法区分“宿主执行过”与“从未执行”，需由
 * 持有宿主 knownFactIds 的首次校验区分；只记事实 ID。合法 epoch 不会触发。
 */
function logRebuildFactsOutsidePopulation(
  outsidePopulation: readonly string[],
  facts: StrictAnalystFactAuthority,
  code: string,
  hypothesisId: string
): void {
  // 诊断只观察不裁决：observeSafely 吞掉日志观察器异常，失败关闭不因诊断失败而改变。
  observeSafely(
    () =>
      Logger.getInstance().warn(
        '[StrictAnalyst] epoch rebuild classifies facts outside the population',
        {
          component: 'assertStrictAnalystEpochIntegrity',
          reason: 'rebuild-without-host-fact-authority',
          selectedPath: 'classify-as-outside-population',
          code,
          hypothesisId,
          factIds: [...new Set(outsidePopulation)].sort(),
          populationFactCount: facts.populationFactIds.size,
          followUpCheck: 'first-validation-with-host-knownFactIds-separates-invented-facts',
        }
      ),
    () => undefined
  );
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
