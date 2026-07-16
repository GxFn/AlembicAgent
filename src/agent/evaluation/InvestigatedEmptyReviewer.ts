import { createHash } from 'node:crypto';
import type { ReviewerIdentityV1 } from './IndependentValueReviewer.js';

export interface InvestigatedEmptyReviewInputV1 {
  readonly sourceRevisionVectorHash: string;
  readonly finalExpandedScheduleHash: string;
  readonly expectedObligationIds: readonly string[];
  readonly terminalObligations: readonly {
    readonly obligationId: string;
    readonly disposition: 'inspected-no-pattern' | 'matched';
    readonly terminalReceiptId: string;
  }[];
  readonly unresolvedHypothesisIds: readonly string[];
  readonly suppressedExpressionIds: readonly string[];
  readonly evidenceEntryIds: readonly string[];
}

export interface InvestigatedEmptyDecisionV1 {
  readonly schemaVersion: 1;
  readonly verdict: 'pass' | 'reject';
  readonly reasonCode: string;
  readonly reviewerIdentity: ReviewerIdentityV1;
  readonly expectedObligationIds: readonly string[];
  readonly terminalObligationIds: readonly string[];
  readonly decisionHash: string;
}

/** 合法零产出的独立完整分母量规，不复用普通候选价值分数。 */
export class InvestigatedEmptyReviewer {
  readonly #identity: ReviewerIdentityV1;

  constructor(options: { readonly identity: ReviewerIdentityV1 }) {
    for (const value of Object.values(options.identity)) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('STRICT_EMPTY_REVIEW_IDENTITY_INVALID');
      }
    }
    this.#identity = freeze({ ...options.identity });
  }

  review(input: InvestigatedEmptyReviewInputV1): InvestigatedEmptyDecisionV1 {
    const expected = normalizeIds(input.expectedObligationIds);
    const terminal = [...input.terminalObligations].sort((left, right) =>
      left.obligationId.localeCompare(right.obligationId)
    );
    const terminalIds = normalizeIds(terminal.map((row) => row.obligationId));
    const invalidTerminal = terminal.some(
      (row) =>
        !row.terminalReceiptId.trim() ||
        !['inspected-no-pattern', 'matched'].includes(row.disposition)
    );
    let reasonCode = 'complete-denominator-investigated-empty';
    if (!input.sourceRevisionVectorHash.trim() || !input.finalExpandedScheduleHash.trim()) {
      reasonCode = 'empty-review-lineage-missing';
    } else if (JSON.stringify(expected) !== JSON.stringify(terminalIds)) {
      reasonCode = 'empty-review-denominator-incomplete';
    } else if (invalidTerminal) {
      reasonCode = 'empty-review-terminal-invalid';
    } else if (terminal.some((row) => row.disposition === 'matched')) {
      reasonCode = 'empty-review-matched-obligation-present';
    } else if (input.unresolvedHypothesisIds.length > 0) {
      reasonCode = 'empty-review-unresolved-hypothesis';
    } else if (input.suppressedExpressionIds.length > 0) {
      reasonCode = 'empty-review-suppressed-expression';
    } else if (input.evidenceEntryIds.length === 0) {
      reasonCode = 'empty-review-evidence-missing';
    }
    const semantic = {
      schemaVersion: 1 as const,
      verdict: (reasonCode === 'complete-denominator-investigated-empty' ? 'pass' : 'reject') as
        | 'pass'
        | 'reject',
      reasonCode,
      reviewerIdentity: this.#identity,
      expectedObligationIds: expected,
      terminalObligationIds: terminalIds,
    };
    return freeze({ ...semantic, decisionHash: hashCanonical(semantic) });
  }
}

function normalizeIds(values: readonly string[]): string[] {
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  if (normalized.length !== values.length || new Set(normalized).size !== normalized.length) {
    throw new Error('STRICT_EMPTY_REVIEW_ID_SET_INVALID');
  }
  return normalized;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortCanonical(value)))
    .digest('hex');
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
