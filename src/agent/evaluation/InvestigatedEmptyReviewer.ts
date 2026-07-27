import {
  type InvestigatedEmptyDecisionV1 as CoreInvestigatedEmptyDecisionV1,
  createInvestigatedEmptyDecisionV1,
  type FactQueryExecutionReceiptV1,
  type KnowledgeDispositionReviewV1,
} from '@alembic/core/production';
import type { ReviewerIdentityV1 } from './IndependentValueReviewer.js';

/**
 * investigated-empty 的 Agent 输入直接采用 Core consumer contract。特别地，终态授权来自
 * 完整 execution receipts 与独立 KnowledgeDispositionReviewV1，而不是结构行或 reviewer 字符串。
 */
export interface InvestigatedEmptyReviewInputV1 {
  readonly sourceRevisionVectorHash: string;
  readonly finalExpandedScheduleHash: string;
  readonly currentAnalysisFixpointHash: string;
  readonly expectedObligationIds: readonly string[];
  readonly executionReceipts: readonly FactQueryExecutionReceiptV1[];
  readonly dispositionReview: KnowledgeDispositionReviewV1;
  readonly evidenceEntryIds: readonly string[];
}

export type InvestigatedEmptyDecisionV1 = CoreInvestigatedEmptyDecisionV1;

/**
 * 保留 class 入口以兼容既有 Agent evaluation host；构造参数不参与 authority。
 * Core receipt 内的 producer/reviewer actor identity 才是可回放的独立评审身份。
 */
export class InvestigatedEmptyReviewer {
  constructor(options?: { readonly identity?: ReviewerIdentityV1 }) {
    if (
      options?.identity &&
      Object.values(options.identity).some(
        (value) => typeof value !== 'string' || value.trim().length === 0
      )
    ) {
      throw new Error('STRICT_EMPTY_REVIEW_COMPATIBILITY_IDENTITY_INVALID');
    }
  }

  review(input: InvestigatedEmptyReviewInputV1): InvestigatedEmptyDecisionV1 {
    return createInvestigatedEmptyDecisionV1(input);
  }
}
