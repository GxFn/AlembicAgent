import { createHash } from 'node:crypto';
import {
  createStrictAcceptedCorpusInspectionV1,
  createStrictAdmissionReceiptV1,
  createStrictG1ReceiptV1,
  createStrictG2ReceiptV1,
  STRICT_G1_HARD_AXES_V1,
  type StrictG2ReceiptV1,
} from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFrozenEvidenceProjection,
  type IndependentReviewAxisV1,
  type IndependentReviewDecisionV1,
  IndependentValueReviewer,
  type IndependentValueReviewInputV1,
} from '../src/agent/evaluation/IndependentValueReviewer.js';

// 背景（module-review L7 / P20，问题 C01 与 C05 的 Core 侧）：Agent 裁决此前没有任何测试把
// IndependentReviewDecisionV1 经 @alembic/core 包子路径喂给 createStrictG2ReceiptV1，于是
// “Agent 裁决合法但 Core G2 拒收”的漂移在单元测试里全绿，只在宿主冷启动时以 STRICT_G2_*
// 异常中止整批运行的形式暴露。本文件按唯一宿主 StrictPrivateCorpusRuntime 的
// createStrictG2FromIndependentReview 逐字段复刻映射（只读追踪，宿主改动同批落地时必须同步
// 更新复刻），锁定三类契约：
//   1. 六轴裁决的可编码对照组（pass/narrow/reject）；
//   2. 七种整体拒绝固定返回 axes=[]：Core 要求恰好六行，直接编码必抛 STRICT_G2_AXIS_SET_INVALID
//      且消息不带 reasonCode —— 这是已批准方案 A（宿主遇 reject 且 axes 为空时不构造 G2，直接
//      recordStrictRejectedTerminal 并带 Agent 的拒绝分类）的 Agent 侧契约，按现状断言记录；
//   3. verdict 推导在 Agent、宿主、Core 三处各自进行导致的不可编码/不一致组合，以 it.fails 记录
//      现状（RED）：待 Core 导出单一 G2 verdict 纯函数且 Agent 与宿主同批接入后翻回 it；
//   4. C05 Core 侧现状：producer/sha256:<hash> 与 provider/model/method 两种坐标在 Core 的
//      identity 全等检查里同样恒不相等，同模型自评可被编码为独立 G2 回执；Agent 过渡期只发诊断。

const UNCOMPARABLE_LOG_MESSAGE = '[IndependentValueReviewer] reviewer independence uncomparable';
const AXES: readonly IndependentReviewAxisV1['axis'][] = [
  'entailment',
  'contradiction-free',
  'project-specificity',
  'actionability',
  'scope-correctness',
  'retrieval-fitness',
];
const REVIEWER_IDENTITY = { provider: 'reviewer', model: 'independent', method: 'review' };
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const PRODUCER_MODEL_HASH = `sha256:${'d'.repeat(64)}`;

const content = '1|export function handler() {\n2|  return wrapResult(run);\n3|}';
const contentHash = createHash('sha256').update(content).digest('hex');
const evidence = createFrozenEvidenceProjection({
  sourceRevisionVectorHash: 'vector-1',
  entries: [
    {
      evidenceEntryId: 'E-1',
      relativePath: 'src/handler.ts',
      blobHash: 'blob-1',
      contentHash,
      startLine: 1,
      endLine: 3,
      content,
    },
  ],
});

const authored = {
  title: 'Preserve Result envelopes at handler boundaries',
  kind: 'rule',
  doClause: 'Return Result<T> from every handler',
  dontClause: 'Do not leak raw exceptions',
  markdown: 'Use the project Result envelope.',
  usageGuide: 'Apply when adding a handler.',
  retrievalProfile: { intents: ['handler error contract'] },
  negativeIntent: ['internal helper'],
  scope: { moduleIds: ['handlers'], dimensionIds: ['error-resilience'] },
  evidenceEntryIds: ['E-1'],
};

interface RawAxisOverride {
  readonly axis: IndependentReviewAxisV1['axis'];
  readonly verdict: IndependentReviewAxisV1['verdict'];
}

/** 构造六轴全 pass/2 的合法输出，再按需覆盖单轴（verdict/score 自动配对）或整体字段。 */
function rawReview(
  options: {
    readonly axisOverrides?: readonly RawAxisOverride[];
    readonly omitAxes?: readonly IndependentReviewAxisV1['axis'][];
    readonly noveltyDecision?: IndependentReviewDecisionV1['noveltyDecision'];
    readonly duplicateDecision?: IndependentReviewDecisionV1['duplicateDecision'];
    readonly citedLines?: readonly string[];
  } = {}
): string {
  const scoreByVerdict = { pass: 2, narrow: 1, fail: 0 } as const;
  const overrides = new Map((options.axisOverrides ?? []).map((row) => [row.axis, row]));
  const omitted = new Set(options.omitAxes ?? []);
  return JSON.stringify({
    axes: AXES.filter((axis) => !omitted.has(axis)).map((axis) => {
      const verdict = overrides.get(axis)?.verdict ?? 'pass';
      return {
        axis,
        verdict,
        score: scoreByVerdict[verdict],
        reasonCode: 'supported',
        evidenceEntryIds: ['E-1'],
      };
    }),
    noveltyDecision: options.noveltyDecision ?? 'novel-project-specific',
    duplicateDecision: options.duplicateDecision ?? 'no-match',
    citedLines: options.citedLines ?? ['src/handler.ts:1'],
  });
}

function baseInput(
  overrides: Partial<IndependentValueReviewInputV1> = {}
): IndependentValueReviewInputV1 {
  return {
    authored,
    evidence,
    expectedSourceRevisionVectorHash: 'vector-1',
    producerIdentity: `producer/${PRODUCER_MODEL_HASH}`,
    admissionReceiptId: 'admission-1',
    calibrationReceiptHash: 'calibration-1',
    repairAttempt: 0,
    ...overrides,
  };
}

async function review(
  raw: string,
  overrides: Partial<IndependentValueReviewInputV1> = {}
): Promise<IndependentReviewDecisionV1> {
  const reviewer = new IndependentValueReviewer({
    identity: REVIEWER_IDENTITY,
    chat: async () => raw,
  });
  return reviewer.review(baseInput(overrides));
}

// 经 @alembic/core 包子路径（宿主同样从 @alembic/core/knowledge 导入）构造合法的 G1/准入回执，
// 让 createStrictG2ReceiptV1 只因 Agent 裁决本身的可编码性而成功或失败。
const g1Receipt = createStrictG1ReceiptV1({
  candidateFingerprint: FINGERPRINT,
  retrievalReadinessHash: `sha256:${'b'.repeat(64)}`,
  rows: STRICT_G1_HARD_AXES_V1.map((axis) => ({
    axis,
    verdict: 'pass' as const,
    reasonCode: 'supported',
    evidenceRefs: ['E-1'],
  })),
});
const admissionReceipt = createStrictAdmissionReceiptV1({
  g1Receipt,
  corpusInspection: createStrictAcceptedCorpusInspectionV1({
    runId: 'run-1',
    analysisFixpointHash: 'fixpoint-1',
    privateCorpusRevision: 'revision-1',
    revisionRootManifestHash: `sha256:${'c'.repeat(64)}`,
    entries: [],
  }),
  inputFingerprint: FINGERPRINT,
  finalAdmittedFingerprint: FINGERPRINT,
  exactMatches: [],
  semanticMatches: [],
  consolidation: {
    action: 'create',
    reasonCode: 'new-candidate',
    targetRecipeId: null,
    targetFingerprint: null,
  },
  algorithmVersion: 'admission-algo-1',
});

type StrictG2InputV1 = Parameters<typeof createStrictG2ReceiptV1>[0];

const G2_AXIS_NAMES: Record<
  IndependentReviewAxisV1['axis'],
  StrictG2InputV1['rows'][number]['axis']
> = {
  entailment: 'entailment',
  'contradiction-free': 'contradiction-free',
  'project-specificity': 'project-specificity-nontriviality',
  actionability: 'actionability',
  'scope-correctness': 'scope-generalization-correctness',
  'retrieval-fitness': 'retrieval-negative-intent-fitness',
};

/**
 * 宿主 createStrictG2FromIndependentReview 的只读复刻（StrictPrivateCorpusRuntime，2026-10 现状）：
 * narrow→revise/repairable、producer 身份为 `producer/${modelHash}`、reviewer 身份为
 * `provider/model/method`、duplicate 硬编码 no-match、permittedRepairFields 按 Agent verdict 推导。
 * 这些正是 P20 跨仓决定要求宿主改掉的部分；复刻只用于把现状钉在测试里。
 */
function encodeAsHostG2(
  decision: IndependentReviewDecisionV1,
  producerModelHash = PRODUCER_MODEL_HASH
): StrictG2ReceiptV1 {
  const evidenceRefs = decision.axes.flatMap((row) => row.evidenceEntryIds);
  return createStrictG2ReceiptV1({
    g1Receipt,
    admissionReceipt,
    reviewedFingerprint: FINGERPRINT,
    producer: {
      identity: `producer/${producerModelHash}`,
      method: 'strict-producer-expression-v1',
      modelHash: producerModelHash,
      promptHash: 'reason-hash-1',
    },
    reviewer: {
      identity: `${decision.reviewerIdentity.provider}/${decision.reviewerIdentity.model}/${decision.reviewerIdentity.method}`,
      method: decision.reviewerIdentity.method,
      modelHash: sha256(JSON.stringify(decision.reviewerIdentity)),
      promptHash: decision.calibrationReceiptHash,
    },
    rows: decision.axes.map((row) => ({
      axis: G2_AXIS_NAMES[row.axis],
      axisVerdict: row.verdict === 'pass' ? 'pass' : row.verdict === 'narrow' ? 'revise' : 'fail',
      score: row.score,
      reasonCode: row.reasonCode,
      evidenceRefs: row.evidenceEntryIds,
      repairable: row.verdict === 'narrow',
    })),
    novelty: {
      decision:
        decision.noveltyDecision === 'novel-project-specific'
          ? 'novel-project-specific'
          : decision.noveltyDecision === 'known-general'
            ? 'generic'
            : 'already-covered',
      reasonCode: decision.reasonCode,
      evidenceRefs,
    },
    duplicate: {
      decision: 'no-match',
      reasonCode: 'core-admission-complete-corpus-no-match',
      evidenceRefs,
      admissionAlgorithmVersion: admissionReceipt.algorithmVersion,
      comparedPrivateCorpusRevision: admissionReceipt.privateCorpusRevision,
      matchedRecipeIds: [],
      matchedFingerprints: [],
      targetRecipeId: null,
      consolidationFingerprint: null,
    },
    repairAttempt: 0,
    calibrationReceiptHash: decision.calibrationReceiptHash,
    ruleVersion: 'alembic-main-independent-value-g2-v1',
    permittedRepairFields: decision.verdict === 'narrow' ? ['authored-projection'] : [],
  });
}

function thrownMessage(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndependentValueReviewer × Core createStrictG2ReceiptV1 — 六轴裁决对照组', () => {
  it.each([
    ['六轴 pass + novel + no-match', rawReview(), 'pass', 'pass'],
    [
      '一轴 narrow + novel + no-match',
      rawReview({ axisOverrides: [{ axis: 'entailment', verdict: 'narrow' }] }),
      'narrow',
      'revise',
    ],
    [
      '一轴 fail',
      rawReview({ axisOverrides: [{ axis: 'actionability', verdict: 'fail' }] }),
      'reject',
      'reject',
    ],
    [
      '六轴 pass + known-general',
      rawReview({ noveltyDecision: 'known-general' }),
      'reject',
      'reject',
    ],
    ['六轴 pass + not-novel', rawReview({ noveltyDecision: 'not-novel' }), 'reject', 'reject'],
  ] as const)('%s → Agent %s → Core %s（带六轴，可编码）', async (_label, raw, agentVerdict, coreVerdict) => {
    const decision = await review(raw);
    expect(decision.verdict).toBe(agentVerdict);
    expect(decision.axes).toHaveLength(6);
    const g2 = encodeAsHostG2(decision);
    expect(g2.verdict).toBe(coreVerdict);
    expect(g2.permittedRepairFields).toEqual(
      agentVerdict === 'narrow' ? ['authored-projection'] : []
    );
  });
});

describe('IndependentValueReviewer × Core createStrictG2ReceiptV1 — 七种整体拒绝（方案 A 契约，现状断言）', () => {
  const wholeRejections: readonly {
    readonly reasonCode: string;
    readonly raw: string;
    readonly overrides?: Partial<IndependentValueReviewInputV1>;
  }[] = [
    { reasonCode: 'semantic-repair-limit', raw: rawReview(), overrides: { repairAttempt: 3 } },
    {
      reasonCode: 'source-drift',
      raw: rawReview(),
      overrides: { expectedSourceRevisionVectorHash: 'vector-2' },
    },
    {
      reasonCode: 'reviewer-not-independent',
      raw: rawReview(),
      overrides: { producerIdentity: 'reviewer/independent' },
    },
    {
      reasonCode: 'authored-evidence-missing',
      raw: rawReview(),
      overrides: { authored: { ...authored, evidenceEntryIds: ['E-1', 'E-9'] } },
    },
    { reasonCode: 'review-output-invalid', raw: `${rawReview()}\nNote: see {details} above.` },
    { reasonCode: 'review-citation-invalid', raw: rawReview({ citedLines: ['src/handler.ts:9'] }) },
    { reasonCode: 'review-rubric-incomplete', raw: rawReview({ omitAxes: ['entailment'] }) },
  ];

  it('覆盖 review() 的全部七个整体拒绝出口', () => {
    expect(wholeRejections.map((row) => row.reasonCode)).toEqual([
      'semantic-repair-limit',
      'source-drift',
      'reviewer-not-independent',
      'authored-evidence-missing',
      'review-output-invalid',
      'review-citation-invalid',
      'review-rubric-incomplete',
    ]);
  });

  it.each(
    wholeRejections.map((row) => [row.reasonCode, row] as const)
  )('%s：reject 且 axes=[]，宿主必须在构造 G2 之前按 verdict/axes 终结（直接编码抛 STRICT_G2_AXIS_SET_INVALID）', async (reasonCode, row) => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => Logger.getInstance());
    const decision = await review(row.raw, row.overrides);
    // 宿主分支依据：整体拒绝的形状固定为 reject + 空轴 + 空 citation，reasonCode 带拒绝分类。
    expect(decision).toMatchObject({
      verdict: 'reject',
      reasonCode,
      axes: [],
      citedLines: [],
      noveltyDecision: 'not-novel',
      duplicateDecision: 'no-match',
    });
    // 现状断言：Core normalizeStrictG2Rows 要求恰好六行，空轴直接编码必抛，且异常不携带
    // Agent 的拒绝分类——这就是方案 A 要求宿主先行终结并自带 reasonCode 的原因。
    const message = thrownMessage(() => encodeAsHostG2(decision));
    expect(message).toBe('STRICT_G2_AXIS_SET_INVALID');
    expect(message).not.toContain(reasonCode);
  });
});

describe('IndependentValueReviewer × Core createStrictG2ReceiptV1 — verdict 三处推导的不可编码组合（C01，RED 现状）', () => {
  // 以下用例断言的是 P20 决定后的目标契约（Agent 裁决经宿主映射后 Core 必可编码且 verdict 一致）。
  // 现状：Agent 先判 narrow 再判 novelty/duplicate、宿主按 Agent verdict 推 permittedRepairFields
  // 且硬编码 duplicate no-match，Core 再独立推导一次。待 Core 导出单一 verdict 纯函数、Agent 与
  // 宿主同批接入并同步更新上面的宿主映射复刻后，把 it.fails 翻回 it。
  it.fails.each([
    [
      '一轴 narrow + not-novel',
      rawReview({
        axisOverrides: [{ axis: 'entailment', verdict: 'narrow' }],
        noveltyDecision: 'not-novel',
      }),
    ],
    [
      '一轴 narrow + known-general',
      rawReview({
        axisOverrides: [{ axis: 'entailment', verdict: 'narrow' }],
        noveltyDecision: 'known-general',
      }),
    ],
    ['六轴 pass + merge', rawReview({ duplicateDecision: 'merge' })],
  ])('%s：目标为 Core 可编码；现状 Agent narrow 带 permittedRepairFields 而 Core 推导非 revise → STRICT_G2_REPAIR_FIELDS_INVALID', async (_label, raw) => {
    const decision = await review(raw);
    expect(decision.axes).toHaveLength(6);
    expect(thrownMessage(() => encodeAsHostG2(decision))).toBeNull();
  });

  it.fails.each([
    ['六轴 pass + duplicate', rawReview({ duplicateDecision: 'duplicate' })],
    [
      '一轴 narrow + duplicate',
      rawReview({
        axisOverrides: [{ axis: 'entailment', verdict: 'narrow' }],
        duplicateDecision: 'duplicate',
      }),
    ],
  ])('%s：目标为 Agent 与 Core 一致判 reject；现状宿主硬编码 no-match 后 Core 给出 pass/revise', async (_label, raw) => {
    const decision = await review(raw);
    expect(decision.axes).toHaveLength(6);
    expect(decision.verdict).toBe('reject');
    expect(encodeAsHostG2(decision).verdict).toBe('reject');
  });
});

describe('IndependentValueReviewer × Core createStrictG2ReceiptV1 — 独立性身份坐标（C05 Core 侧现状）', () => {
  it('同格式坐标全等时 Core 守卫有效：producer.identity === reviewer.identity → STRICT_G2_REVIEWER_NOT_INDEPENDENT', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => Logger.getInstance());
    const decision = await review(rawReview());
    const message = thrownMessage(() =>
      createStrictG2ReceiptV1({
        g1Receipt,
        admissionReceipt,
        reviewedFingerprint: FINGERPRINT,
        producer: {
          identity: 'reviewer/independent/review',
          method: 'strict-producer-expression-v1',
          modelHash: PRODUCER_MODEL_HASH,
          promptHash: 'reason-hash-1',
        },
        reviewer: {
          identity: 'reviewer/independent/review',
          method: 'review',
          modelHash: sha256(JSON.stringify(decision.reviewerIdentity)),
          promptHash: decision.calibrationReceiptHash,
        },
        rows: decision.axes.map((row) => ({
          axis: G2_AXIS_NAMES[row.axis],
          axisVerdict: 'pass',
          score: 2,
          reasonCode: row.reasonCode,
          evidenceRefs: row.evidenceEntryIds,
          repairable: false,
        })),
        novelty: {
          decision: 'novel-project-specific',
          reasonCode: 'supported',
          evidenceRefs: ['E-1'],
        },
        duplicate: {
          decision: 'no-match',
          reasonCode: 'core-admission-complete-corpus-no-match',
          evidenceRefs: ['E-1'],
          admissionAlgorithmVersion: admissionReceipt.algorithmVersion,
          comparedPrivateCorpusRevision: admissionReceipt.privateCorpusRevision,
          matchedRecipeIds: [],
          matchedFingerprints: [],
          targetRecipeId: null,
          consolidationFingerprint: null,
        },
        repairAttempt: 0,
        calibrationReceiptHash: decision.calibrationReceiptHash,
        ruleVersion: 'alembic-main-independent-value-g2-v1',
        permittedRepairFields: [],
      })
    );
    expect(message).toBe('STRICT_G2_REVIEWER_NOT_INDEPENDENT');
  });

  it('宿主格式下同模型自评：Agent 只发不可比诊断（verdict 不变），Core 的 identity 全等检查同样放行并产出 pass 回执（现状）', async () => {
    const warnLog = vi
      .spyOn(Logger.getInstance(), 'warn')
      .mockImplementation(() => Logger.getInstance());
    // producerModelHash 取 reviewer 坐标自身的 sha256：语义上就是同一模型，但 `producer/sha256:…`
    // 与 `reviewer/independent/review` 两种坐标在 Agent 与 Core 的字符串全等里都恒不相等。
    const producerModelHash = `sha256:${sha256('reviewer/independent')}`;
    const decision = await review(rawReview(), {
      producerIdentity: `producer/${producerModelHash}`,
    });
    expect(decision.verdict).toBe('pass');
    const diagnostics = (warnLog.mock.calls as readonly (readonly unknown[])[])
      .filter((call) => call[0] === UNCOMPARABLE_LOG_MESSAGE)
      .map((call) => call[1] as Record<string, unknown>);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      reasonCode: 'reviewer-independence-uncomparable',
      coordinateIssue: 'model-hash-coordinate',
      verdictEffect: 'none',
    });
    // 现状断言（待跨仓结构化身份与共用规范化函数落地后改为期望 STRICT_G2_REVIEWER_NOT_INDEPENDENT）。
    const g2 = encodeAsHostG2(decision, producerModelHash);
    expect(g2.verdict).toBe('pass');
    expect(g2.producer.identity).not.toBe(g2.reviewer.identity);
  });
});
