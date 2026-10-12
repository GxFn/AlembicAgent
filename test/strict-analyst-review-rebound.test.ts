import { describe, expect, it, vi } from 'vitest';
import { validateStrictAnalystEpochV1 } from '../src/agent/production/StrictProductionPipeline.js';
import { createSingleHypothesisEpochFixture } from './fixtures/strict-semantic-authority.js';

/**
 * C29（U50-F12）：STRICT_ANALYST_DISPOSITION_REVIEW_REBOUND 是 review ledger 的纵深防线。真实回执的
 * reviewReceiptId 由 receiptHash 派生，Core assertKnowledgeDispositionReviewV1 会先拒绝改写过的
 * ledger 行，所以正常输入到不了这条分支。这里只替换 Agent 侧引用的 Core 断言，模拟“Core 断言
 * 被放宽或绕过”的回归，确认 Agent 自己仍按 receiptHash 拒绝同 ID 换绑；Core 内部构造器
 * （createFalsificationReceiptV1 等）不受影响，消费侧使用的仍是真实合法回执。vi.mock 由 vitest
 * 提升到模块导入之前执行。
 */
vi.mock('@alembic/core/production', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alembic/core/production')>();
  return { ...actual, assertKnowledgeDispositionReviewV1: vi.fn() };
});

describe('strict Analyst disposition review ledger rebound', () => {
  it('accepts the untouched ledger as a control', () => {
    const semantic = createSingleHypothesisEpochFixture();
    expect(validateStrictAnalystEpochV1(semantic.epochInput).dispositionReviews).toHaveLength(1);
  });

  it('rejects a declared ledger row that reuses a consumed review id with another receipt hash', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const rebound = {
      ...semantic.dispositionReview,
      receiptHash: `sha256:${'e'.repeat(64)}`,
    };
    expect(() =>
      validateStrictAnalystEpochV1({
        ...semantic.epochInput,
        dispositionReviews: [rebound],
      })
    ).toThrow(
      new RegExp(
        `^STRICT_ANALYST_DISPOSITION_REVIEW_REBOUND: ${semantic.dispositionReview.reviewReceiptId}$`,
        'u'
      )
    );
  });
});
