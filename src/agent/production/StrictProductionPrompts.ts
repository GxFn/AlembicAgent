import Logger from '@alembic/core/logging';
import type { AnalysisScheduleExpansionRowV1 } from '@alembic/core/production';
import { observeSafely } from '#shared/observers.js';
import type {
  CreateStrictProducerExpressionSetInputV1,
  FullAuthoredProjectionV1,
  StrictAnalysisEpochSnapshotV1,
  StrictAnalysisLoopLimitsV1,
  StrictAnalystEpochInputV1,
  StrictFalsificationInputV1,
  StrictHypothesisDispositionV1,
  StrictInductionInputV1,
  StrictProducerExpressionSetV1,
  StrictProducerProposalInputV1,
} from './StrictProductionPipeline.js';

/**
 * 模型可见输出契约的节点：字符串是取值规则或宿主标记（不是示例数据），数组与对象是模型要
 * 返回的 JSON 骨架。
 */
type ContractNode = string | readonly ContractNode[] | { readonly [key: string]: ContractNode };

const HOST_OWNED_PREFIX = 'HOST-OWNED:';
const HOST_SEALED_PREFIX = 'HOST-SEALED:';

/** 宿主在 Core 校验前用自身权威覆盖的输入键；模型即使回传也会被丢弃，所以提示要求省略。 */
function hostOwned(authority: string): string {
  return `${HOST_OWNED_PREFIX} ${authority} Omit this key; the host overwrites it from its own authority before validation.`;
}

/**
 * 审查回执是宿主经独立语义审查会话生成并封印的 Core KnowledgeDispositionReviewV1，模型只提交
 * 处置提案。伪造的回执会在 Core assertKnowledgeDispositionReviewV1 失败关闭，所以提示要求模型
 * 省略该键，而不是要求模型填写。
 */
function hostSealedReview(reviewKind: string, when: string): string {
  return `${HOST_SEALED_PREFIX} Core KnowledgeDispositionReviewV1 receipt of kind '${reviewKind}' (${when}). The host generates it through its independent semantic review session after reading your proposal and seals it before Core validation. Omit this key; never author, copy, or fabricate it.`;
}

/**
 * 按标记前缀从形状中收集键名。hostOwnedInputKeys/hostSealedKeys 由形状派生而不是另写一份，
 * 这样列表不会与骨架漂移。
 */
function collectMarkedKeys(node: ContractNode, prefix: string): string[] {
  const found = new Set<string>();
  const visit = (candidate: ContractNode): void => {
    if (typeof candidate === 'string') {
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate as readonly ContractNode[]) {
        visit(item);
      }
      return;
    }
    for (const [key, value] of Object.entries(
      candidate as { readonly [key: string]: ContractNode }
    )) {
      if (typeof value === 'string' && value.startsWith(prefix)) {
        found.add(key);
      } else {
        visit(value);
      }
    }
  };
  visit(node);
  return [...found].sort();
}

// ---------------------------------------------------------------------------------------------
// Analyst envelope：宿主 parseAnalystEnvelope 读取 { epoch, expansions }，epoch 经宿主覆盖
// population/knownFactIds/enrolledObligationIds 后送入 validateStrictAnalystEpochV1；expansions
// 每行经宿主 parseExpansion 校验后登记到扩展端口。每个骨架都用 `satisfies` 钉住对应 Agent
// 输入类型的键集合：输入类型增删字段时这里先在 tsc 阶段失败，而不是提示静默漂移。
// ---------------------------------------------------------------------------------------------

const CLUSTER_INPUT_SHAPE = {
  mechanismKey:
    'string; stable mechanism key, unique across clusterInputs and reused verbatim by the matching inductionInputs row',
  mechanism:
    'non-empty JSON value (an object is preferred); the mechanism statement shared by every clustered observation',
  observationIds: [
    'observationId from the current population; every clustered observation belongs to exactly one cluster',
  ],
  mechanismEvidenceFactIds: [
    'exactly the union of the factIds of the observations listed in observationIds: no missing fact, no extra fact',
  ],
  anatomyLensIds: ['non-empty lens id through which the mechanism was read'],
} satisfies Record<keyof StrictAnalystEpochInputV1['clusterInputs'][number], unknown>;

const NON_CLUSTERED_DISPOSITION_SHAPE = {
  observationId: 'observationId from the current population that belongs to no cluster',
  status: "'discarded' | 'unresolved'",
  reasonCode: 'string; non-empty',
  dispositionReview: hostSealedReview('cluster-discard', 'required when status is discarded'),
  owner: 'string; required when status is unresolved: who resumes',
  resumePoint: 'string; required when status is unresolved: where to resume',
} satisfies Record<keyof StrictAnalystEpochInputV1['nonClusteredDispositions'][number], unknown>;

const HYPOTHESIS_SHAPE = {
  hypothesisId: 'string; unique across the whole epoch',
  statement: 'string; non-empty',
  premiseFactIds: ['factId from the strict context factIds; one or more'],
} satisfies Record<keyof StrictInductionInputV1['hypotheses'][number], unknown>;

const INDUCTION_INPUT_SHAPE = {
  mechanismKey: 'must equal the mechanismKey of one clusterInputs row; exactly one row per cluster',
  mode: "'recurring' | 'bounded-singleton'",
  hypotheses: [HYPOTHESIS_SHAPE],
  zeroHypothesisReason:
    "'refuted' | 'insufficient-evidence' | 'unknown'; present only when hypotheses is empty",
  zeroHypothesisDispositionReview: hostSealedReview(
    'zero-hypothesis',
    'required when hypotheses is empty'
  ),
} satisfies Record<keyof StrictInductionInputV1, unknown>;

const COUNTERQUERY_EXECUTION_SHAPE = {
  counterqueryId: 'string; the counterquery this execution answers',
  obligationId: 'obligationId of the enrolled counterquery that was executed',
  executionReceipt:
    'the Core FactQueryExecutionReceiptV1 of that obligation, copied verbatim from the current population executionReceipts; never composed or edited',
  counterexampleFactIds: ['factId emitted by that execution; may be empty'],
} satisfies Record<keyof StrictFalsificationInputV1['executions'][number], unknown>;

const FALSIFICATION_INPUT_SHAPE = {
  hypothesisId: 'exactly one row per hypothesis declared in inductionInputs',
  enrolledCounterqueryIds: [
    'obligationId of a counterquery enrolled through the analysis expansion port; empty when none was required',
  ],
  executions: [COUNTERQUERY_EXECUTION_SHAPE],
  counterqueryApplicability: {
    status: "'required' | 'not-required'",
    reasonCode: 'string; non-empty',
  },
  dispositionReview: hostSealedReview('falsification', 'required on every row'),
} satisfies Record<keyof StrictFalsificationInputV1, unknown>;

const HYPOTHESIS_DISPOSITION_SHAPE = {
  hypothesisId: 'exactly one row per hypothesis',
  status: "'survived' | 'narrowed' | 'refuted' | 'unknown'",
  causalParentHypothesisId: 'required when status is narrowed; omit otherwise',
} satisfies Record<keyof StrictHypothesisDispositionV1, unknown>;

const ANALYST_EPOCH_SHAPE = {
  currentAnalysisFixpointHash: `${HOST_SEALED_PREFIX} Core analysis review context hash (createAnalysisReviewContextHashV1 over the sealed schedule, the terminal obligations, the population hashes, and the cluster set built from your clusterInputs). The host computes it when it seals the reviews. Omit this key.`,
  knownFactIds: hostOwned('Every factId the host executed.'),
  enrolledObligationIds: hostOwned('Every obligationId the host enrolled.'),
  population: hostOwned('The canonical population and its Core execution receipts.'),
  clusterInputs: [CLUSTER_INPUT_SHAPE],
  nonClusteredDispositions: [NON_CLUSTERED_DISPOSITION_SHAPE],
  inductionInputs: [INDUCTION_INPUT_SHAPE],
  falsificationInputs: [FALSIFICATION_INPUT_SHAPE],
  hypothesisDispositions: [HYPOTHESIS_DISPOSITION_SHAPE],
  dispositionReviews: `${HOST_SEALED_PREFIX} The exact review ledger: every receipt the host sealed into this epoch and nothing else. Omit this key.`,
} satisfies Record<keyof StrictAnalystEpochInputV1, unknown>;

const EXPANSION_ROW_SHAPE = {
  purpose: "'exploration' | 'counterexample'",
  factFamilyId: 'a fact family id registered on the analysis expansion port',
  capabilityId: 'the capability id of that fact family',
  canonicalSubjectRef: 'a subject ref registered on the analysis expansion port',
  analysisScale:
    "'source-range' | 'symbol' | 'file' | 'module' | 'package' | 'repository' | 'project'; a scale that fact family supports",
  reasonCode: 'string; why this obligation is needed',
} satisfies Record<keyof Omit<AnalysisScheduleExpansionRowV1, 'obligationId'>, unknown>;

/** 校验器显式拒绝（STRICT_ANALYST_STRING_REVIEW_AUTHORITY_FORBIDDEN）或由回执派生的字段。 */
const ANALYST_NEVER_EMIT = [
  'reviewerReceiptId',
  'zeroHypothesisReviewReceiptId',
  'reviewReceiptId',
  'receiptHash',
] as const;

// ---------------------------------------------------------------------------------------------
// Producer 输出：宿主 parseProducerOutput 读取 { expressionSets: [{ hypothesisId, proposals,
// zeroDisposition }] }，每行与宿主权威（lineage/parentSet/modelHash/reasonHash）合并后送入
// createStrictProducerExpressionSetV1。
// ---------------------------------------------------------------------------------------------

const AUTHORED_PROJECTION_SHAPE = {
  title: 'string; non-empty',
  kind: 'string; non-empty',
  doClause: 'string; non-empty',
  dontClause: 'string; non-empty',
  markdown: 'string; non-empty',
  usageGuide: 'string; non-empty',
  retrievalProfile: 'object; retrieval intents and query hints',
  negativeIntent: ['string; one or more'],
  scope: {
    moduleIds: ['exactly one eligible moduleId'],
    dimensionIds: ['exactly one eligible dimensionId'],
  },
  evidenceEntryIds: ['evidenceEntryId from the lineage evidence projection; one or more'],
} satisfies Record<keyof FullAuthoredProjectionV1, unknown>;

const PROPOSAL_SHAPE = {
  expressionId: 'string; unique across the row',
  kind: "'draft' | 'merge' | 'duplicate'",
  authored: AUTHORED_PROJECTION_SHAPE,
  matchingRepresentativeId: 'required for merge and duplicate; omit for draft',
} satisfies Record<keyof StrictProducerProposalInputV1, unknown>;

const ZERO_DISPOSITION_SHAPE = {
  reasonCode: 'string; why no durable expression exists for this hypothesis',
  authored: AUTHORED_PROJECTION_SHAPE,
  dispositionReview: hostSealedReview('producer-non-draft', 'required for every zero disposition'),
} satisfies Record<
  keyof NonNullable<CreateStrictProducerExpressionSetInputV1['zeroDisposition']>,
  unknown
>;

const PRODUCER_EXPRESSION_SET_INPUT_SHAPE = {
  lineage: hostOwned('The Core-bound producer lineage receipt of this hypothesis.'),
  parentSet: hostOwned('The previous expression set of this lineage, or null.'),
  proposals: [PROPOSAL_SHAPE],
  zeroDisposition: ZERO_DISPOSITION_SHAPE,
  modelHash: hostOwned('The host model hash.'),
  reasonHash: hostOwned('The host authoring reason hash.'),
} satisfies Record<keyof CreateStrictProducerExpressionSetInputV1, unknown>;

/**
 * createStrictProducerExpressionSetV1 显式拒绝（STRICT_PRODUCER_CALLER_LINEAGE_FIELD_FORBIDDEN）
 * 或由 Agent/Core 派生的封印、指纹与回执字段。
 */
const PRODUCER_NEVER_EMIT = [
  'authoredFingerprint',
  'authoredFingerprintHash',
  'reviewerReceiptId',
  'reviewReceiptId',
  'receiptHash',
  'terminalFate',
  'setId',
  'version',
  'parentSetId',
  'hypothesis',
  'analysisFixpointHash',
  'repairNode',
] as const;

/**
 * 严格链模型可见输出契约的单一来源（Agent 内部常量，不公开导出）。
 *
 * 形状按宿主解析器（parseAnalystEnvelope / parseExpansion / parseProducerOutput）与本仓
 * validateStrictAnalystEpochV1 / createStrictProducerExpressionSetV1 的输入类型只读抄录：
 * - `shape` 是模型要返回的 JSON 骨架；字符串值描述取值规则，不是示例数据。
 * - `hostOwnedInputKeys` 由宿主用自身权威覆盖，模型不输出。
 * - `hostSealedKeys` 由宿主经独立语义审查会话生成并在 Core 校验前注入。在第二步跨仓批次
 *   （输入类型拆为“模型处置提案”与“宿主封印审查”、宿主注入真实审查）落地前，宿主仍把模型
 *   JSON 直接送入校验，真实 provider 会在 G1/G2 失败关闭；这是已接受的中间态，不能通过让
 *   模型伪造回执来绕过。
 * - `neverEmit` 是 Agent/Core 派生的封印、回执与 lineage 标识，模型产出即视为伪造。
 * 改动本常量时必须同步 test/strict-production-prompts-output-contract.test.ts；公开导出与
 * 宿主解析器改用本常量属于第二步。
 */
const STRICT_MODEL_OUTPUT_CONTRACT_V1 = Object.freeze({
  analystEnvelope: Object.freeze({
    kind: 'StrictAnalystEnvelopeV1',
    format:
      'Return exactly one JSON object with the top-level keys "epoch" and "expansions". No prose, no markdown fences, no extra top-level keys.',
    shape: { epoch: ANALYST_EPOCH_SHAPE, expansions: [EXPANSION_ROW_SHAPE] },
    hostOwnedInputKeys: collectMarkedKeys(ANALYST_EPOCH_SHAPE, HOST_OWNED_PREFIX),
    hostSealedKeys: collectMarkedKeys(ANALYST_EPOCH_SHAPE, HOST_SEALED_PREFIX),
    neverEmit: ANALYST_NEVER_EMIT,
    epochSemantics:
      'expansions: [] declares this epoch as the fixpoint candidate. A non-empty expansions list requests enrolled exploration or counterqueries; the host executes them and re-invokes you with the next append-only epoch, so cluster and dispose the current population completely in every reply.',
  }),
  producerOutput: Object.freeze({
    kind: 'StrictProducerOutputV1',
    format:
      'Return exactly one JSON object with the top-level key "expressionSets". No prose, no markdown fences, no extra top-level keys.',
    shape: {
      expressionSets: [
        {
          hypothesisId: 'exactly one row per lineage in the expression set input lineages',
          ...PRODUCER_EXPRESSION_SET_INPUT_SHAPE,
        },
      ],
    },
    cardinality:
      'proposals: [] together with a zeroDisposition object, or one or more proposals with zeroDisposition: null; never both, never neither',
    hostOwnedInputKeys: collectMarkedKeys(PRODUCER_EXPRESSION_SET_INPUT_SHAPE, HOST_OWNED_PREFIX),
    hostSealedKeys: collectMarkedKeys(PRODUCER_EXPRESSION_SET_INPUT_SHAPE, HOST_SEALED_PREFIX),
    neverEmit: PRODUCER_NEVER_EMIT,
  }),
});

const OUTPUT_CONTRACT_INSTRUCTION =
  'Reply with exactly one JSON object matching the output contract below. Keys marked HOST-SEALED or HOST-OWNED are omitted from your reply because the host injects or overwrites them. Keys listed under neverEmit are derived by the Agent or Core and must not appear anywhere in your reply.';

/** 历史 population 在 Analyst 提示中只保留的身份字段；缺失或类型不符的字段渲染为 null。 */
interface SupersededPopulationIdentityV1 {
  readonly populationHash: string | null;
  readonly revision: number | null;
  readonly parentPopulationHash: string | null;
  readonly status: 'superseded';
}

interface StrictAnalystPopulationProjectionV1 {
  /** populations 末项原样内联；宿主一份都没给时为 null。 */
  readonly current: unknown;
  readonly superseded: readonly SupersededPopulationIdentityV1[];
}

function isPopulationRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRevision(record: Readonly<Record<string, unknown>>): number | null {
  const value = record.revision;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function toSupersededIdentity(population: unknown): SupersededPopulationIdentityV1 {
  if (!isPopulationRecord(population)) {
    return {
      populationHash: null,
      revision: null,
      parentPopulationHash: null,
      status: 'superseded',
    };
  }
  return {
    populationHash: readNonEmptyString(population, 'populationHash'),
    revision: readRevision(population),
    parentPopulationHash: readNonEmptyString(population, 'parentPopulationHash'),
    status: 'superseded',
  };
}

/**
 * C20：宿主（StrictAnalysisRuntime）对 population 只做 append-only 追加，每份都是对完整扩展
 * 日程重新执行得到的全量观测，所以数组末项就是当前份，而宿主 validateAnalystResult 也只按
 * 当前 state.population 校验。若把所有历史份全量内联，同一 observationId 会重复出现、模型按
 * 全部副本统计分母会被 G1 拒绝，且提示随 epoch（最多 maxEpochs 个）线性膨胀。
 *
 * 这里只是模型可见投影：当前份原样全量内联，历史份只给 populationHash/revision/
 * parentPopulationHash 并标 superseded。快照结构与 snapshotHash 不变，authority 仍是快照本身。
 * 以数组末项识别当前份是已批准的决定，不在快照上新增 currentPopulationHash 字段。
 */
function projectAnalystPopulations(
  epoch: StrictAnalysisEpochSnapshotV1
): StrictAnalystPopulationProjectionV1 {
  const { populations } = epoch;
  if (populations.length === 0) {
    // 降级路径：没有当前份时不抛错（提示构造不是 authority，旧行为渲染 []），显式渲染 null，
    // 是否放行由宿主 Analyst 门按自身 population authority 判定。
    observeSafely(
      () =>
        Logger.getInstance().warn(
          '[StrictProductionPrompts] analyst prompt has no current population',
          {
            epoch: epoch.epoch,
            snapshotHash: epoch.snapshotHash,
            populationCount: 0,
            selectedPath: 'render-null-current-population',
            followUpCheck:
              'host analyst gate must reject an epoch without a current population; check host readAnalysisEpoch',
          }
        ),
      () => undefined
    );
    return { current: null, superseded: [] };
  }
  const current = populations[populations.length - 1];
  const superseded = populations.slice(0, -1).map(toSupersededIdentity);
  // parentPopulationHash 为 null 是首个 revision 的合法取值；只有 hash 或 revision 缺失才算身份不完整。
  const incompleteIndexes = superseded.flatMap((row, index) =>
    row.populationHash === null || row.revision === null ? [index] : []
  );
  if (incompleteIndexes.length > 0) {
    observeSafely(
      () =>
        Logger.getInstance().warn(
          '[StrictProductionPrompts] superseded population identity incomplete',
          {
            epoch: epoch.epoch,
            snapshotHash: epoch.snapshotHash,
            populationCount: populations.length,
            supersededIndexes: incompleteIndexes,
            selectedPath: 'render-null-identity-fields',
            followUpCheck:
              'superseded populations should be canonical Core ObservationPopulationV1 rows carrying populationHash and revision',
          }
        ),
      () => undefined
    );
  }
  if (superseded.length > 0) {
    // 跳过历史份正文是有意的投影选择，记录被省略的身份以便回放时核对提示与快照的对应关系。
    observeSafely(
      () =>
        Logger.getInstance().info(
          '[StrictProductionPrompts] analyst prompt inlines only the current population',
          {
            epoch: epoch.epoch,
            snapshotHash: epoch.snapshotHash,
            populationCount: populations.length,
            currentIndex: populations.length - 1,
            currentPopulationHash: isPopulationRecord(current)
              ? readNonEmptyString(current, 'populationHash')
              : null,
            currentRevision: isPopulationRecord(current) ? readRevision(current) : null,
            supersededPopulationHashes: superseded.map((row) => row.populationHash),
            selectedPath: 'current-inline-superseded-identity-only',
            reason: 'host-append-only-populations',
            followUpCheck:
              'host validateAnalystResult validates against the current population only',
          }
        ),
      () => undefined
    );
  }
  return { current, superseded };
}

/**
 * 严格 Analyst 不接收数量目标；它消费冻结语义投影与当前 population，并通过登记端口扩展。
 * 历史 population 只以身份行出现（见 projectAnalystPopulations）。审查回执由宿主注入，提示只
 * 要求模型输出处置提案与扩展请求。
 */
export function buildStrictAnalystPrompt(input: {
  readonly epoch: StrictAnalysisEpochSnapshotV1;
  readonly limits: StrictAnalysisLoopLimitsV1;
}): string {
  const populations = projectAnalystPopulations(input.epoch);
  return [
    'You are the strict cold-start Analyst operating on immutable Core receipts.',
    'Consume the complete multiscale current observation population and preserve its denominators, variants, and outliers; superseded populations are listed by identity only and never form a second denominator.',
    'Own clustering, induction, falsification, narrowing, and refutation. Never invent a fact or infer one from prose.',
    'Every discard, zero-hypothesis, and falsification disposition is a proposal: give its ids, status, and reasonCode. The matching Core KnowledgeDispositionReview receipt is generated by the host through an independent semantic review session and sealed into the epoch before Core validation; never author, copy, or fabricate a review receipt, reviewReceiptId, or receiptHash, and reviewer strings are not authority.',
    'Exploration and every counterquery must be enrolled through the validated analysis expansion port before execution.',
    'Advance append-only epochs to a fixpoint. At fixpoint every observation and hypothesis needs a terminal disposition with owner/resume data for non-pass gates.',
    'There is no candidate floor, filler, top-N shortcut, fixed count, skip-on-fail, or degrade-to-success path.',
    `Analysis epoch: ${input.epoch.epoch} of ${input.limits.maxEpochs}`,
    `Obligation bound: ${input.epoch.context.factQueryObligationIds.length} of ${input.limits.maxObligations}`,
    `Terminal obligations: ${JSON.stringify(input.epoch.terminalObligationIds)}`,
    `Outstanding obligations: ${JSON.stringify(input.epoch.outstandingObligationIds)}`,
    `Strict context: ${JSON.stringify(input.epoch.context)}`,
    // 标签里不放 { 或 [，回放/测试可以从首个 JSON 定界符起解析。
    `Current population (the last append-only revision; cluster and dispose every observation in it and take every denominator from it alone): ${JSON.stringify(populations.current ?? null)}`,
    `Superseded populations (earlier append-only revisions replaced by the current population; identity only, never cluster, dispose, or count their observations): ${JSON.stringify(populations.superseded)}`,
    OUTPUT_CONTRACT_INSTRUCTION,
    `Output contract: ${JSON.stringify(STRICT_MODEL_OUTPUT_CONTRACT_V1.analystEnvelope)}`,
  ].join('\n');
}

/**
 * 严格 Producer 只起草 typed proposals；持久化与复核属于下游独立阶段。零处置的
 * producer-non-draft 回执由宿主封印，提示只要求模型给出 reasonCode 与完整 authored 投影。
 */
export function buildStrictProducerPrompt(
  expressionSet: StrictProducerExpressionSetV1 | Readonly<Record<string, unknown>>
): string {
  return [
    'You are the strict cold-start Producer.',
    'Author proposal expressions only from the survived or narrowed hypothesis and its immutable analysis fixpoint.',
    'Return the typed expression set exactly as 0, 1, or N evidence-grounded proposals. Per-hypothesis zero is a proposal too: give its reasonCode and the complete authored projection; the Core producer-non-draft review receipt is generated by the host through an independent semantic review session and sealed after your reply, so never author or fabricate that review. Whole-run investigated-empty is a separate Core execution-denominator decision.',
    'The downstream terminal consumer must conserve every expression identity and Agent-derived authored fingerprint into a Core HypothesisExpressionSet receipt.',
    'Do not call tools, execute fact queries, persist data, perform admission, or review your own work.',
    'Do not add filler, quota padding, duplicated wording, or claims outside cited evidence.',
    'Every expression must include the full authoring projection: title, kind, do/dont clauses, markdown, usage guide, retrieval profile, negative intent, scope, and evidence entry IDs.',
    `Expression set input: ${JSON.stringify(expressionSet)}`,
    OUTPUT_CONTRACT_INSTRUCTION,
    `Output contract: ${JSON.stringify(STRICT_MODEL_OUTPUT_CONTRACT_V1.producerOutput)}`,
  ].join('\n');
}
