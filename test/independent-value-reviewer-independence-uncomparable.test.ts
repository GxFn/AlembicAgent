import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFrozenEvidenceProjection,
  type IndependentReviewAxisV1,
  IndependentValueReviewer,
  type IndependentValueReviewInputV1,
} from '../src/agent/evaluation/IndependentValueReviewer.js';

// 背景（module-review L7 / P20，问题 C05）：review() 用 `${provider}/${model}` 与自由字符串
// producerIdentity 做全等比较；唯一生产宿主（StrictPrivateCorpusRuntime）传入
// `producer/${planning.modelHash}`，modelHash 是 `sha256:<64hex>` 的模型内容哈希，两种坐标
// 没有任何规范化映射，独立性检查在生产中永远不会命中。结构化 {provider, model} 身份与双方共用
// 的规范化函数属于跨仓决定②⑤，落地前本组测试锁定过渡期行为：
//   1. producerIdentity 与 reviewer 坐标不可比时发出 reviewer-independence-uncomparable 诊断，
//      记录不可比原因、两侧坐标与定位字段，并明确 verdict 不受影响；
//   2. 诊断不改变 verdict、不进入 decision、不影响 decisionHash；
//   3. 可比的 provider/model 坐标不发诊断；全等仍按 reviewer-not-independent 拒绝且不发诊断；
//   4. 诊断只在独立性比较实际执行时发出：更早的拒绝分支不发，比较之后的拒绝照发。

const REJECT_LOG_MESSAGE = '[IndependentValueReviewer] independent review rejected';
const UNCOMPARABLE_LOG_MESSAGE = '[IndependentValueReviewer] reviewer independence uncomparable';
const HEX64 = 'a1b2c3d4'.repeat(8);
const HEX40 = 'f0e1d2c3'.repeat(5);
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

const passingReview = JSON.stringify({
  axes: AXES.map((axis) => ({
    axis,
    verdict: 'pass',
    score: 2,
    reasonCode: 'supported',
    evidenceEntryIds: ['E-1'],
  })),
  noveltyDecision: 'novel-project-specific',
  duplicateDecision: 'no-match',
  citedLines: ['src/handler.ts:1'],
});

function createReviewer(
  chat: (prompt: string) => Promise<string> = async () => passingReview
): IndependentValueReviewer {
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
  // winston 的 warn 返回 Logger 本身；mock 返回同一实例以满足签名，不触发真实输出。
  return vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => Logger.getInstance());
}

function logsWithMessage(
  warnLog: ReturnType<typeof spyWarnLog>,
  message: string
): Record<string, unknown>[] {
  // 调用记录按 (message, meta) 读取；LeveledLogMethod 的重载元组类型对此不友好，故按 unknown 处理。
  return (warnLog.mock.calls as readonly (readonly unknown[])[])
    .filter((call) => call[0] === message)
    .map((call) => call[1] as Record<string, unknown>);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndependentValueReviewer — producer/reviewer 身份坐标不可比诊断（P20/C05）', () => {
  it('宿主格式 producer/sha256:<64hex>：发出不可比诊断，verdict 不变且仍调用模型', async () => {
    const warnLog = spyWarnLog();
    const chat = vi.fn(async () => passingReview);
    const producerIdentity = `producer/sha256:${HEX64}`;
    const input = baseInput({ producerIdentity });
    const decision = await createReviewer(chat).review(input);
    expect(decision).toMatchObject({ verdict: 'pass', reasonCode: 'all-value-axes-pass' });
    expect(chat).toHaveBeenCalledTimes(1);
    const logs = logsWithMessage(warnLog, UNCOMPARABLE_LOG_MESSAGE);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      reasonCode: 'reviewer-independence-uncomparable',
      coordinateIssue: 'model-hash-coordinate',
      producerIdentity,
      reviewerIdentity: 'reviewer/independent',
      admissionReceiptId: 'admission-1',
      repairAttempt: 0,
      sourceRevisionVectorHash: 'vector-1',
      verdictEffect: 'none',
    });
    expect(logsWithMessage(warnLog, REJECT_LOG_MESSAGE)).toHaveLength(0);
  });

  it('同一模型自评：producer 哈希恰为 reviewer 坐标的 sha256 时仍放行（现状），诊断是唯一信号', async () => {
    const warnLog = spyWarnLog();
    const producerIdentity = `producer/sha256:${sha256('reviewer/independent')}`;
    const decision = await createReviewer().review(baseInput({ producerIdentity }));
    // 现状断言：字符串全等检查对哈希坐标是死分支，同模型自评带着“独立评审”的 reviewerIdentity 通过。
    expect(decision.verdict).toBe('pass');
    expect(logsWithMessage(warnLog, UNCOMPARABLE_LOG_MESSAGE)).toHaveLength(1);
    expect(logsWithMessage(warnLog, UNCOMPARABLE_LOG_MESSAGE)[0]).toMatchObject({
      coordinateIssue: 'model-hash-coordinate',
      producerIdentity,
    });
  });

  it.each([
    [`sha256:${HEX64}`, 'model-hash-coordinate'],
    [HEX64, 'model-hash-coordinate'],
    [`producer/${HEX64}`, 'model-hash-coordinate'],
    [`producer/sha1:${HEX40}`, 'model-hash-coordinate'],
    [`${HEX64}/independent`, 'model-hash-coordinate'],
    ['gpt-4o', 'provider-model-shape-missing'],
    ['', 'provider-model-shape-missing'],
    ['   ', 'provider-model-shape-missing'],
    ['/independent', 'provider-model-shape-missing'],
    ['reviewer/', 'provider-model-shape-missing'],
  ])('不可比形状 %j → coordinateIssue=%s，verdict 不变', async (producerIdentity, issue) => {
    const warnLog = spyWarnLog();
    const decision = await createReviewer().review(baseInput({ producerIdentity }));
    expect(decision.verdict).toBe('pass');
    const logs = logsWithMessage(warnLog, UNCOMPARABLE_LOG_MESSAGE);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      reasonCode: 'reviewer-independence-uncomparable',
      coordinateIssue: issue,
      producerIdentity,
    });
  });

  it.each([
    'producer/different',
    'frozen/producer-v1',
    'openai/gpt-4o',
    'openrouter/meta/llama-3',
  ])('可比的 provider/model 坐标 %s：不发诊断，正常评审', async (producerIdentity) => {
    const warnLog = spyWarnLog();
    const decision = await createReviewer().review(baseInput({ producerIdentity }));
    expect(decision.verdict).toBe('pass');
    expect(logsWithMessage(warnLog, UNCOMPARABLE_LOG_MESSAGE)).toHaveLength(0);
  });

  it('坐标全等：仍按 reviewer-not-independent 拒绝、不调用模型，也不发不可比诊断', async () => {
    const warnLog = spyWarnLog();
    const chat = vi.fn(async () => passingReview);
    const decision = await createReviewer(chat).review(
      baseInput({ producerIdentity: 'reviewer/independent' })
    );
    expect(decision).toMatchObject({ verdict: 'reject', reasonCode: 'reviewer-not-independent' });
    expect(chat).not.toHaveBeenCalled();
    expect(logsWithMessage(warnLog, UNCOMPARABLE_LOG_MESSAGE)).toHaveLength(0);
    expect(logsWithMessage(warnLog, REJECT_LOG_MESSAGE)).toHaveLength(1);
  });

  it('诊断不进入 decision：可比与不可比的 producerIdentity 得到逐字节相同的 decision', async () => {
    spyWarnLog();
    const comparable = await createReviewer().review(baseInput());
    const uncomparable = await createReviewer().review(
      baseInput({ producerIdentity: `producer/sha256:${HEX64}` })
    );
    expect(Object.keys(uncomparable).sort()).toEqual(DECISION_KEYS);
    expect(uncomparable).toEqual(comparable);
    expect(uncomparable.decisionHash).toBe(comparable.decisionHash);
  });

  it.each([
    ['semantic-repair-limit', { repairAttempt: 3 }],
    ['source-drift', { expectedSourceRevisionVectorHash: 'vector-2' }],
  ] as const)('比较之前的拒绝分支 %s：不发不可比诊断（比较未执行）', async (reasonCode, overrides) => {
    const warnLog = spyWarnLog();
    const decision = await createReviewer().review(
      baseInput({ ...overrides, producerIdentity: `producer/sha256:${HEX64}` })
    );
    expect(decision).toMatchObject({ verdict: 'reject', reasonCode });
    expect(logsWithMessage(warnLog, UNCOMPARABLE_LOG_MESSAGE)).toHaveLength(0);
  });

  it('比较之后的拒绝（review-output-invalid）：不可比诊断照发，拒绝日志独立记录', async () => {
    const warnLog = spyWarnLog();
    const decision = await createReviewer(async () => 'not json at all').review(
      baseInput({ producerIdentity: `producer/sha256:${HEX64}` })
    );
    expect(decision).toMatchObject({ verdict: 'reject', reasonCode: 'review-output-invalid' });
    expect(logsWithMessage(warnLog, UNCOMPARABLE_LOG_MESSAGE)).toHaveLength(1);
    expect(logsWithMessage(warnLog, REJECT_LOG_MESSAGE)).toHaveLength(1);
  });

  it('日志观察者抛错不影响评审：诊断失败被吞咽，verdict 照常产出', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
      throw new Error('logger fixture failure');
    });
    const decision = await createReviewer().review(
      baseInput({ producerIdentity: `producer/sha256:${HEX64}` })
    );
    expect(decision).toMatchObject({ verdict: 'pass', reasonCode: 'all-value-axes-pass' });
  });
});
