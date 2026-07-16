import { createHash } from 'node:crypto';
import type { FullAuthoredProjectionV1 } from '../production/StrictProductionPipeline.js';

export type { JudgeCalibrationRecordV1 } from './MiningJudge.js';
export { computeJudgeCalibration } from './MiningJudge.js';

export interface FrozenEvidenceEntryV1 {
  readonly evidenceEntryId: string;
  readonly relativePath: string;
  readonly blobHash: string;
  readonly contentHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export interface FrozenEvidenceProjectionV1 {
  readonly schemaVersion: 1;
  readonly sourceRevisionVectorHash: string;
  readonly entries: readonly FrozenEvidenceEntryV1[];
  readonly projectionHash: string;
}

export interface ReviewerIdentityV1 {
  readonly provider: string;
  readonly model: string;
  readonly method: string;
}

export interface IndependentReviewAxisV1 {
  readonly axis:
    | 'entailment'
    | 'contradiction-free'
    | 'project-specificity'
    | 'actionability'
    | 'scope-correctness'
    | 'retrieval-fitness';
  readonly verdict: 'pass' | 'narrow' | 'fail';
  readonly score: 0 | 1 | 2;
  readonly reasonCode: string;
  readonly evidenceEntryIds: readonly string[];
}

export interface IndependentReviewDecisionV1 {
  readonly schemaVersion: 1;
  readonly verdict: 'pass' | 'narrow' | 'reject';
  readonly reasonCode: string;
  readonly reviewerIdentity: ReviewerIdentityV1;
  readonly admissionReceiptId: string;
  readonly calibrationReceiptHash: string;
  readonly sourceRevisionVectorHash: string;
  readonly axes: readonly IndependentReviewAxisV1[];
  readonly noveltyDecision: 'novel-project-specific' | 'known-general' | 'not-novel';
  readonly duplicateDecision: 'no-match' | 'merge' | 'duplicate';
  readonly citedLines: readonly string[];
  readonly decisionHash: string;
}

export interface IndependentValueReviewerOptionsV1 {
  readonly identity: ReviewerIdentityV1;
  readonly chat: (prompt: string) => Promise<string>;
}

export interface IndependentValueReviewInputV1 {
  readonly authored: FullAuthoredProjectionV1;
  readonly evidence: FrozenEvidenceProjectionV1;
  readonly expectedSourceRevisionVectorHash: string;
  readonly producerIdentity: string;
  readonly admissionReceiptId: string;
  readonly calibrationReceiptHash: string;
  readonly repairAttempt: number;
}

const REQUIRED_AXES: readonly IndependentReviewAxisV1['axis'][] = [
  'actionability',
  'contradiction-free',
  'entailment',
  'project-specificity',
  'retrieval-fitness',
  'scope-correctness',
];

export function createFrozenEvidenceProjection(input: {
  readonly sourceRevisionVectorHash: string;
  readonly entries: readonly Omit<FrozenEvidenceEntryV1, never>[];
}): FrozenEvidenceProjectionV1 {
  requireText(input.sourceRevisionVectorHash, 'STRICT_REVIEW_SOURCE_VECTOR_REQUIRED');
  if (input.entries.length === 0) {
    fail('STRICT_REVIEW_EVIDENCE_REQUIRED');
  }
  const entries = [...input.entries]
    .map((entry) => {
      for (const [field, value] of Object.entries({
        evidenceEntryId: entry.evidenceEntryId,
        relativePath: entry.relativePath,
        blobHash: entry.blobHash,
        contentHash: entry.contentHash,
      })) {
        requireText(value, `STRICT_REVIEW_${field.toUpperCase()}_REQUIRED`);
      }
      if (
        !Number.isSafeInteger(entry.startLine) ||
        !Number.isSafeInteger(entry.endLine) ||
        entry.startLine < 1 ||
        entry.endLine < entry.startLine
      ) {
        fail('STRICT_REVIEW_EVIDENCE_RANGE_INVALID', entry.evidenceEntryId);
      }
      if (sha256(entry.content) !== entry.contentHash) {
        fail('STRICT_REVIEW_EVIDENCE_CONTENT_HASH_MISMATCH', entry.evidenceEntryId);
      }
      if (entry.content.split('\n').length !== entry.endLine - entry.startLine + 1) {
        fail('STRICT_REVIEW_EVIDENCE_RANGE_CONTENT_MISMATCH', entry.evidenceEntryId);
      }
      return { ...entry };
    })
    .sort((left, right) => left.evidenceEntryId.localeCompare(right.evidenceEntryId));
  if (new Set(entries.map((entry) => entry.evidenceEntryId)).size !== entries.length) {
    fail('STRICT_REVIEW_EVIDENCE_ID_DUPLICATE');
  }
  const semantic = {
    schemaVersion: 1 as const,
    sourceRevisionVectorHash: input.sourceRevisionVectorHash,
    entries,
  };
  return freeze({ ...semantic, projectionHash: hashCanonical(semantic) });
}

/**
 * Reviewer 只看完整 authoring projection 与冻结证据，不接收 Producer 轨迹、提示、
 * 隐藏推理或实时文件，避免同源上下文污染独立裁决。
 */
export function buildIndependentReviewPrompt(input: {
  readonly authored: FullAuthoredProjectionV1;
  readonly evidence: FrozenEvidenceProjectionV1;
}): string {
  const authored = JSON.stringify(input.authored, null, 2);
  const evidence = input.evidence.entries
    .map(
      (entry) =>
        `--- ${entry.evidenceEntryId} ${entry.relativePath}:${entry.startLine}-${entry.endLine} ` +
        `blob=${entry.blobHash} content=${entry.contentHash} ---\n${entry.content}`
    )
    .join('\n\n');
  return [
    'You are the independent production value reviewer.',
    'Use only the immutable evidence projection below. Refute first and fail closed on uncertainty.',
    'Review the COMPLETE authored projection: title, kind, doClause, dontClause, markdown, usageGuide, retrievalProfile, negativeIntent, scope, and evidenceEntryIds.',
    `Return JSON with exactly six axes (${REQUIRED_AXES.join(', ')}). Each axis has axis, verdict(pass|narrow|fail), score(0|1|2), reasonCode, evidenceEntryIds.`,
    'Also return noveltyDecision(novel-project-specific|known-general|not-novel), duplicateDecision(no-match|merge|duplicate), and citedLines(path:line or path:start-end).',
    '',
    '=== COMPLETE AUTHORED PROJECTION ===',
    authored,
    '',
    `=== FROZEN EVIDENCE sourceRevisionVectorHash=${input.evidence.sourceRevisionVectorHash} projectionHash=${input.evidence.projectionHash} ===`,
    evidence,
  ].join('\n');
}

export class IndependentValueReviewer {
  readonly #identity: ReviewerIdentityV1;
  readonly #chat: IndependentValueReviewerOptionsV1['chat'];

  constructor(options: IndependentValueReviewerOptionsV1) {
    validateIdentity(options.identity);
    this.#identity = freeze({ ...options.identity });
    this.#chat = options.chat;
  }

  async review(input: IndependentValueReviewInputV1): Promise<IndependentReviewDecisionV1> {
    requireText(input.admissionReceiptId, 'STRICT_REVIEW_ADMISSION_REQUIRED');
    requireText(input.calibrationReceiptHash, 'STRICT_REVIEW_CALIBRATION_REQUIRED');
    if (!Number.isSafeInteger(input.repairAttempt) || input.repairAttempt < 0) {
      fail('STRICT_REVIEW_REPAIR_ATTEMPT_INVALID');
    }
    if (input.repairAttempt > 2) {
      return this.#reject(input, 'semantic-repair-limit');
    }
    if (input.expectedSourceRevisionVectorHash !== input.evidence.sourceRevisionVectorHash) {
      return this.#reject(input, 'source-drift');
    }
    const reviewerIdentity = `${this.#identity.provider}/${this.#identity.model}`;
    if (input.producerIdentity === reviewerIdentity) {
      return this.#reject(input, 'reviewer-not-independent');
    }
    const authoredEvidenceIds = new Set(input.authored.evidenceEntryIds);
    const suppliedEvidenceIds = new Set(
      input.evidence.entries.map((entry) => entry.evidenceEntryId)
    );
    if (
      authoredEvidenceIds.size === 0 ||
      [...authoredEvidenceIds].some((entryId) => !suppliedEvidenceIds.has(entryId))
    ) {
      return this.#reject(input, 'authored-evidence-missing');
    }

    const raw = await this.#chat(
      buildIndependentReviewPrompt({ authored: input.authored, evidence: input.evidence })
    );
    const parsed = parseReview(raw);
    if (!parsed) {
      return this.#reject(input, 'review-output-invalid');
    }
    if (!verifyReviewCitations(parsed.citedLines, input.evidence.entries)) {
      return this.#reject(input, 'review-citation-invalid');
    }
    const axesByName = new Map(parsed.axes.map((axis) => [axis.axis, axis]));
    const axes = REQUIRED_AXES.map((axis) => axesByName.get(axis)).filter(
      (axis): axis is IndependentReviewAxisV1 => Boolean(axis)
    );
    if (
      axes.length !== REQUIRED_AXES.length ||
      axes.some((axis) =>
        axis.evidenceEntryIds.some((entryId) => !suppliedEvidenceIds.has(entryId))
      )
    ) {
      return this.#reject(input, 'review-rubric-incomplete');
    }
    const verdict = axes.some((axis) => axis.verdict === 'fail' || axis.score === 0)
      ? 'reject'
      : axes.some((axis) => axis.verdict === 'narrow' || axis.score === 1) ||
          parsed.duplicateDecision === 'merge'
        ? 'narrow'
        : parsed.noveltyDecision === 'novel-project-specific' &&
            parsed.duplicateDecision === 'no-match'
          ? 'pass'
          : 'reject';
    const reasonCode = verdict === 'pass' ? 'all-value-axes-pass' : `independent-${verdict}`;
    return this.#decision(input, {
      verdict,
      reasonCode,
      axes,
      noveltyDecision: parsed.noveltyDecision,
      duplicateDecision: parsed.duplicateDecision,
      citedLines: parsed.citedLines,
    });
  }

  #reject(input: IndependentValueReviewInputV1, reasonCode: string): IndependentReviewDecisionV1 {
    return this.#decision(input, {
      verdict: 'reject',
      reasonCode,
      axes: [],
      noveltyDecision: 'not-novel',
      duplicateDecision: 'no-match',
      citedLines: [],
    });
  }

  #decision(
    input: IndependentValueReviewInputV1,
    result: Pick<
      IndependentReviewDecisionV1,
      'verdict' | 'reasonCode' | 'axes' | 'noveltyDecision' | 'duplicateDecision' | 'citedLines'
    >
  ): IndependentReviewDecisionV1 {
    const semantic = {
      schemaVersion: 1 as const,
      ...result,
      reviewerIdentity: this.#identity,
      admissionReceiptId: input.admissionReceiptId,
      calibrationReceiptHash: input.calibrationReceiptHash,
      sourceRevisionVectorHash: input.evidence.sourceRevisionVectorHash,
    };
    return freeze({ ...semantic, decisionHash: hashCanonical(semantic) });
  }
}

interface ParsedReviewV1 {
  readonly axes: readonly IndependentReviewAxisV1[];
  readonly noveltyDecision: IndependentReviewDecisionV1['noveltyDecision'];
  readonly duplicateDecision: IndependentReviewDecisionV1['duplicateDecision'];
  readonly citedLines: readonly string[];
}

function parseReview(text: string): ParsedReviewV1 | null {
  const match = typeof text === 'string' ? text.match(/\{[\s\S]*\}/u) : null;
  if (!match) {
    return null;
  }
  try {
    const value = JSON.parse(match[0]) as Record<string, unknown>;
    if (!Array.isArray(value.axes)) {
      return null;
    }
    const axes: IndependentReviewAxisV1[] = [];
    for (const raw of value.axes) {
      const axis = readRecord(raw);
      if (
        !REQUIRED_AXES.includes(axis.axis as IndependentReviewAxisV1['axis']) ||
        !['pass', 'narrow', 'fail'].includes(String(axis.verdict)) ||
        ![0, 1, 2].includes(Number(axis.score)) ||
        typeof axis.reasonCode !== 'string' ||
        !axis.reasonCode.trim() ||
        !Array.isArray(axis.evidenceEntryIds)
      ) {
        return null;
      }
      axes.push({
        axis: axis.axis as IndependentReviewAxisV1['axis'],
        verdict: axis.verdict as IndependentReviewAxisV1['verdict'],
        score: Number(axis.score) as IndependentReviewAxisV1['score'],
        reasonCode: axis.reasonCode,
        evidenceEntryIds: axis.evidenceEntryIds.filter(
          (entryId): entryId is string => typeof entryId === 'string'
        ),
      });
      if (axes.at(-1)?.evidenceEntryIds.length === 0) {
        return null;
      }
    }
    if (new Set(axes.map((axis) => axis.axis)).size !== axes.length) {
      return null;
    }
    const noveltyDecision = String(value.noveltyDecision);
    const duplicateDecision = String(value.duplicateDecision);
    if (
      !['novel-project-specific', 'known-general', 'not-novel'].includes(noveltyDecision) ||
      !['no-match', 'merge', 'duplicate'].includes(duplicateDecision) ||
      !Array.isArray(value.citedLines)
    ) {
      return null;
    }
    return {
      axes,
      noveltyDecision: noveltyDecision as ParsedReviewV1['noveltyDecision'],
      duplicateDecision: duplicateDecision as ParsedReviewV1['duplicateDecision'],
      citedLines: value.citedLines.filter((line): line is string => typeof line === 'string'),
    };
  } catch {
    return null;
  }
}

function verifyReviewCitations(
  citations: readonly string[],
  evidence: readonly FrozenEvidenceEntryV1[]
): boolean {
  return (
    citations.length > 0 &&
    citations.every((citation) => {
      const match = /^(.+?):(\d+)(?:-(\d+))?$/u.exec(citation.trim());
      if (!match) {
        return false;
      }
      const [, relativePath, startRaw, endRaw] = match;
      const start = Number(startRaw);
      const end = endRaw ? Number(endRaw) : start;
      return evidence.some(
        (entry) =>
          entry.relativePath === relativePath &&
          start >= entry.startLine &&
          end >= start &&
          end <= entry.endLine
      );
    })
  );
}

function validateIdentity(identity: ReviewerIdentityV1): void {
  requireText(identity.provider, 'STRICT_REVIEW_PROVIDER_REQUIRED');
  requireText(identity.model, 'STRICT_REVIEW_MODEL_REQUIRED');
  requireText(identity.method, 'STRICT_REVIEW_METHOD_REQUIRED');
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireText(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(code);
  }
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value: unknown): string {
  return sha256(JSON.stringify(sortCanonical(value)));
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
