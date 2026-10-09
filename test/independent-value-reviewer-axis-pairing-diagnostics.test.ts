import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIndependentReviewPrompt,
  createFrozenEvidenceProjection,
  type IndependentReviewAxisV1,
  type IndependentReviewDecisionV1,
  IndependentValueReviewer,
  type IndependentValueReviewInputV1,
} from '../src/agent/evaluation/IndependentValueReviewer.js';

// 背景（module-review L7 / P21，问题 C01 轴配对部分与 C15）：parseReview 之前只分别校验
// verdict 与 score 的枚举，不校验配对，{pass,1} 这类轴会原样进入 decision，宿主按
// Core G2 编码时抛错；七种拒绝分类此前没有任何日志，解析错误被无绑定 catch 吞掉，
// 原始输出也被丢弃。本组测试锁定：
//   1. 轴 verdict/score 必须按 pass↔2 / narrow↔1 / fail↔0 配对，不配对整份输出按
//      review-output-invalid 拒绝，失败形态（axes=[]、citedLines=[]）与解析失败一致；
//   2. 每一种拒绝都通过 Core Logger 记录分类、admissionReceiptId、repairAttempt，chat 之后
//      的分支额外记录 raw 的 sha256 与长度（不记全文）、解析失败原因、缺失轴/越界证据
//      引用与越界 citation；
//   3. 诊断不写入 decision，decision 的字段集合与 decisionHash 不受诊断影响。
// verdict 推导顺序（merge/duplicate 一律 reject）不在本组测试范围，等 P20 宿主改动同批。

const REJECT_LOG_MESSAGE = '[IndependentValueReviewer] independent review rejected';
const AXES: readonly IndependentReviewAxisV1['axis'][] = [
  'entailment',
  'contradiction-free',
  'project-specificity',
  'actionability',
  'scope-correctness',
  'retrieval-fitness',
];
const DECISION_KEYS = [
  'admissionReceiptId',
  'axes',
  'calibrationReceiptHash',
  'citedLines',
  'decisionHash',
  'duplicateDecision',
  'noveltyDecision',
  'reasonCode',
  'reviewerIdentity',
  'schemaVersion',
  'sourceRevisionVectorHash',
  'verdict',
];

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
    {
      evidenceEntryId: 'E-2',
      relativePath: 'src/handler-variant.ts',
      blobHash: 'blob-2',
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
  evidenceEntryIds: ['E-1', 'E-2'],
};

interface RawAxisOverride {
  readonly axis: IndependentReviewAxisV1['axis'];
  readonly verdict?: unknown;
  readonly score?: unknown;
  readonly evidenceEntryIds?: readonly unknown[];
}

/** 构造六轴全 pass/2 的合法输出，再按需覆盖单轴或整体字段。 */
function rawReview(
  options: {
    readonly axisOverrides?: readonly RawAxisOverride[];
    readonly omitAxes?: readonly IndependentReviewAxisV1['axis'][];
    readonly noveltyDecision?: string;
    readonly duplicateDecision?: string;
    readonly citedLines?: readonly unknown[];
  } = {}
): string {
  const overrides = new Map((options.axisOverrides ?? []).map((row) => [row.axis, row]));
  const omitted = new Set(options.omitAxes ?? []);
  return JSON.stringify({
    axes: AXES.filter((axis) => !omitted.has(axis)).map((axis) => {
      const override = overrides.get(axis);
      return {
        axis,
        verdict: override?.verdict ?? 'pass',
        score: override?.score ?? 2,
        reasonCode: 'supported',
        evidenceEntryIds: override?.evidenceEntryIds ?? ['E-1'],
      };
    }),
    noveltyDecision: options.noveltyDecision ?? 'novel-project-specific',
    duplicateDecision: options.duplicateDecision ?? 'no-match',
    citedLines: options.citedLines ?? ['src/handler.ts:1'],
  });
}

function createReviewer(chat: (prompt: string) => Promise<string>): IndependentValueReviewer {
  return new IndependentValueReviewer({
    identity: { provider: 'reviewer', model: 'independent', method: 'review' },
    chat,
  });
}

function baseInput(
  overrides: Partial<IndependentValueReviewInputV1> = {}
): IndependentValueReviewInputV1 {
  return {
    authored,
    evidence,
    expectedSourceRevisionVectorHash: 'vector-1',
    producerIdentity: 'producer/different',
    admissionReceiptId: 'admission-1',
    calibrationReceiptHash: 'calibration-1',
    repairAttempt: 0,
    ...overrides,
  };
}

function spyWarnLog() {
  return vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
}

function rejectLogs(warnLog: ReturnType<typeof spyWarnLog>): Record<string, unknown>[] {
  return warnLog.mock.calls
    .filter((call) => call[0] === REJECT_LOG_MESSAGE)
    .map((call) => call[1] as Record<string, unknown>);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndependentValueReviewer — 轴 verdict/score 配对校验（P21/C01）', () => {
  const pairedCases: readonly [
    IndependentReviewAxisV1['verdict'],
    IndependentReviewAxisV1['score'],
  ][] = [
    ['pass', 2],
    ['narrow', 1],
    ['fail', 0],
  ];
  const unpairedCases: readonly [
    IndependentReviewAxisV1['verdict'],
    IndependentReviewAxisV1['score'],
  ][] = [
    ['pass', 1],
    ['pass', 0],
    ['narrow', 2],
    ['narrow', 0],
    ['fail', 2],
    ['fail', 1],
  ];

  it.each(
    unpairedCases
  )('单轴 {%s,%s} 不配对 → 整份输出按 review-output-invalid 拒绝，失败形态与解析失败一致', async (verdict, score) => {
    spyWarnLog();
    const reviewer = createReviewer(async () =>
      rawReview({ axisOverrides: [{ axis: 'entailment', verdict, score }] })
    );
    const decision = await reviewer.review(baseInput());
    expect(decision).toMatchObject({
      verdict: 'reject',
      reasonCode: 'review-output-invalid',
      axes: [],
      citedLines: [],
      noveltyDecision: 'not-novel',
      duplicateDecision: 'no-match',
    });
  });

  it.each(
    pairedCases
  )('单轴 {%s,%s} 配对 → 不触发 review-output-invalid，轴原样进入 decision', async (verdict, score) => {
    spyWarnLog();
    const reviewer = createReviewer(async () =>
      rawReview({ axisOverrides: [{ axis: 'entailment', verdict, score }] })
    );
    const decision = await reviewer.review(baseInput());
    expect(decision.reasonCode).not.toBe('review-output-invalid');
    expect(decision.axes).toHaveLength(6);
    expect(decision.axes.find((axis) => axis.axis === 'entailment')).toMatchObject({
      verdict,
      score,
    });
    // 配对轴下的裁决与现有推导一致：pass→pass、narrow→narrow、fail→reject。
    expect(decision.verdict).toBe(
      verdict === 'pass' ? 'pass' : verdict === 'narrow' ? 'narrow' : 'reject'
    );
  });

  it('提示词写明配对规则，Reviewer 模型不需要猜 score 与 verdict 的关系', () => {
    const prompt = buildIndependentReviewPrompt({ authored, evidence });
    expect(prompt).toContain('pass=2, narrow=1, fail=0');
  });

  it('不配对的拒绝与解析失败的拒绝共享同一 decisionHash：诊断不进入 decision', async () => {
    spyWarnLog();
    const unpaired = await createReviewer(async () =>
      rawReview({ axisOverrides: [{ axis: 'actionability', verdict: 'pass', score: 1 }] })
    ).review(baseInput());
    const garbage = await createReviewer(async () => 'no json here at all').review(baseInput());
    expect(unpaired.reasonCode).toBe('review-output-invalid');
    expect(garbage.reasonCode).toBe('review-output-invalid');
    expect(Object.keys(unpaired).sort()).toEqual(DECISION_KEYS);
    expect(Object.keys(garbage).sort()).toEqual(DECISION_KEYS);
    expect(unpaired.decisionHash).toBe(garbage.decisionHash);
  });
});

describe('IndependentValueReviewer — 拒绝诊断（P21/C15）', () => {
  function expectRejectLog(
    warnLog: ReturnType<typeof spyWarnLog>,
    decision: IndependentReviewDecisionV1,
    input: IndependentValueReviewInputV1
  ): Record<string, unknown> {
    const logs = rejectLogs(warnLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      reasonCode: decision.reasonCode,
      admissionReceiptId: input.admissionReceiptId,
      repairAttempt: input.repairAttempt,
    });
    return logs[0];
  }

  it('semantic-repair-limit：不调用模型即拒绝，并记录分类与 repairAttempt', async () => {
    const warnLog = spyWarnLog();
    const chat = vi.fn(async () => rawReview());
    const input = baseInput({ repairAttempt: 3 });
    const decision = await createReviewer(chat).review(input);
    expect(decision).toMatchObject({ verdict: 'reject', reasonCode: 'semantic-repair-limit' });
    expect(chat).not.toHaveBeenCalled();
    expectRejectLog(warnLog, decision, input);
  });

  it('source-drift：记录期望与证据两侧的 sourceRevisionVectorHash', async () => {
    const warnLog = spyWarnLog();
    const input = baseInput({ expectedSourceRevisionVectorHash: 'vector-2' });
    const decision = await createReviewer(async () => rawReview()).review(input);
    expect(decision.reasonCode).toBe('source-drift');
    expect(expectRejectLog(warnLog, decision, input)).toMatchObject({
      expectedSourceRevisionVectorHash: 'vector-2',
      evidenceSourceRevisionVectorHash: 'vector-1',
    });
  });

  it('reviewer-not-independent：记录同源的 producerIdentity', async () => {
    const warnLog = spyWarnLog();
    const input = baseInput({ producerIdentity: 'reviewer/independent' });
    const decision = await createReviewer(async () => rawReview()).review(input);
    expect(decision.reasonCode).toBe('reviewer-not-independent');
    expect(expectRejectLog(warnLog, decision, input)).toMatchObject({
      producerIdentity: 'reviewer/independent',
    });
  });

  it('authored-evidence-missing：记录 authored 引用但冻结证据里没有的 evidenceEntryId', async () => {
    const warnLog = spyWarnLog();
    const input = baseInput({ authored: { ...authored, evidenceEntryIds: ['E-1', 'E-9'] } });
    const decision = await createReviewer(async () => rawReview()).review(input);
    expect(decision.reasonCode).toBe('authored-evidence-missing');
    expect(expectRejectLog(warnLog, decision, input)).toMatchObject({
      missingAuthoredEvidenceIds: ['E-9'],
    });
  });

  it('review-output-invalid（无 JSON 对象）：记录 raw 的 sha256 与长度，不记录全文', async () => {
    const warnLog = spyWarnLog();
    const raw = 'SENTINEL-DO-NOT-LOG plain text without any object';
    const input = baseInput();
    const decision = await createReviewer(async () => raw).review(input);
    expect(decision.reasonCode).toBe('review-output-invalid');
    const log = expectRejectLog(warnLog, decision, input);
    expect(log).toMatchObject({
      rawSha256: sha256(raw),
      rawLength: raw.length,
      parseFailure: 'json-object-missing',
    });
    expect(JSON.stringify(log)).not.toContain('SENTINEL-DO-NOT-LOG');
  });

  it('review-output-invalid（JSON 语法错误）：catch (err: unknown) 保留解析器分类，不带原文片段', async () => {
    const warnLog = spyWarnLog();
    const raw = '{"axes": [{"axis": "entailment", "verdict": SENTINEL-DO-NOT-LOG}]}';
    const input = baseInput();
    const decision = await createReviewer(async () => raw).review(input);
    expect(decision.reasonCode).toBe('review-output-invalid');
    const log = expectRejectLog(warnLog, decision, input);
    expect(log).toMatchObject({ rawSha256: sha256(raw), rawLength: raw.length });
    expect(log.parseFailure).toBe('json-parse-error');
    expect(typeof log.parseFailureDetail).toBe('string');
    expect(log.parseFailureDetail).not.toBe('');
    expect(JSON.stringify(log)).not.toContain('SENTINEL-DO-NOT-LOG');
  });

  it('review-output-invalid（轴不配对）：记录失败原因与失败轴名', async () => {
    const warnLog = spyWarnLog();
    const input = baseInput();
    const decision = await createReviewer(async () =>
      rawReview({ axisOverrides: [{ axis: 'scope-correctness', verdict: 'fail', score: 2 }] })
    ).review(input);
    expect(decision.reasonCode).toBe('review-output-invalid');
    expect(expectRejectLog(warnLog, decision, input)).toMatchObject({
      parseFailure: 'axis-verdict-score-unpaired',
      failedAxis: 'scope-correctness',
    });
  });

  it('review-output-invalid（轴枚举非法）：记录失败原因与失败轴名', async () => {
    const warnLog = spyWarnLog();
    const input = baseInput();
    const decision = await createReviewer(async () =>
      rawReview({ axisOverrides: [{ axis: 'actionability', verdict: 'maybe', score: 2 }] })
    ).review(input);
    expect(decision.reasonCode).toBe('review-output-invalid');
    expect(expectRejectLog(warnLog, decision, input)).toMatchObject({
      parseFailure: 'axis-verdict-invalid',
      failedAxis: 'actionability',
    });
  });

  it('review-citation-invalid：记录越界或格式非法的 citation，合法的不记录', async () => {
    const warnLog = spyWarnLog();
    const input = baseInput();
    const decision = await createReviewer(async () =>
      rawReview({
        citedLines: ['src/handler.ts:1', 'src/other.ts:7', 'src/handler.ts:9', 'garbage'],
      })
    ).review(input);
    expect(decision.reasonCode).toBe('review-citation-invalid');
    expect(expectRejectLog(warnLog, decision, input)).toMatchObject({
      invalidCitations: ['src/other.ts:7', 'src/handler.ts:9', 'garbage'],
    });
  });

  it('review-rubric-incomplete（缺轴）：记录缺失的轴名', async () => {
    const warnLog = spyWarnLog();
    const input = baseInput();
    const decision = await createReviewer(async () =>
      rawReview({ omitAxes: ['retrieval-fitness', 'contradiction-free'] })
    ).review(input);
    expect(decision.reasonCode).toBe('review-rubric-incomplete');
    expect(expectRejectLog(warnLog, decision, input)).toMatchObject({
      missingAxes: ['contradiction-free', 'retrieval-fitness'],
      unknownEvidenceEntryIds: [],
    });
  });

  it('review-rubric-incomplete（轴引用越界证据）：记录 轴名:证据id', async () => {
    const warnLog = spyWarnLog();
    const input = baseInput();
    const decision = await createReviewer(async () =>
      rawReview({
        axisOverrides: [{ axis: 'entailment', evidenceEntryIds: ['E-1', 'E-9'] }],
      })
    ).review(input);
    expect(decision.reasonCode).toBe('review-rubric-incomplete');
    expect(expectRejectLog(warnLog, decision, input)).toMatchObject({
      missingAxes: [],
      unknownEvidenceEntryIds: ['entailment:E-9'],
    });
  });

  it('通过路径不产生拒绝日志', async () => {
    const warnLog = spyWarnLog();
    const decision = await createReviewer(async () => rawReview()).review(baseInput());
    expect(decision.verdict).toBe('pass');
    expect(rejectLogs(warnLog)).toHaveLength(0);
  });

  it('日志观察者抛错不影响拒绝裁决本身', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
      throw new Error('logger fixture failure');
    });
    const decision = await createReviewer(async () => 'not json').review(baseInput());
    expect(decision).toMatchObject({ verdict: 'reject', reasonCode: 'review-output-invalid' });
  });
});
