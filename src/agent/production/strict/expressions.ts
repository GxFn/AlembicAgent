/** Producer表达集、前驱绑定与终态回执封印；不授予持久化权限。 */
import {
  assertKnowledgeDispositionReviewV1,
  type HypothesisExpressionRowV1,
  type HypothesisExpressionSetReceiptV1,
  hashKnowledgeDispositionProposalV1,
  type KnowledgeDispositionReviewV1,
  validateHypothesisExpressionSetReceiptV1,
} from '@alembic/core/production';
import type { ProducerEligibleHypothesisV1 } from './analyst.js';
import {
  assertCausalRepairNodeIntegrity,
  assertStrictProducerLineageIntegrity,
  type CausalRepairNodeV1,
  createCausalRepairNodeV1,
  type StrictProducerLineageReceiptV1,
} from './lineage.js';
import {
  fail,
  freeze,
  hashCanonical,
  hashCoreCanonical,
  normalizeIds,
  requireText,
} from './primitives.js';

export interface FullAuthoredProjectionV1 {
  readonly title: string;
  readonly kind: string;
  readonly doClause: string;
  readonly dontClause: string;
  readonly markdown: string;
  readonly usageGuide: string;
  readonly retrievalProfile: Readonly<Record<string, unknown>>;
  readonly negativeIntent: readonly string[];
  readonly scope: {
    readonly moduleIds: readonly string[];
    readonly dimensionIds: readonly string[];
  };
  readonly evidenceEntryIds: readonly string[];
}

export interface StrictProducerProposalInputV1 {
  readonly expressionId: string;
  readonly kind: 'draft' | 'merge' | 'duplicate';
  readonly authored: FullAuthoredProjectionV1;
  readonly matchingRepresentativeId?: string;
}

export interface StrictProducerProposalV1 extends StrictProducerProposalInputV1 {
  /** Agent 从完整 authored projection 派生，供 Core terminal receipt/Main attempt 对账。 */
  readonly authoredFingerprint: string;
}

export interface StrictProducerZeroDispositionV1 {
  readonly reasonCode: string;
  readonly authored: FullAuthoredProjectionV1;
  readonly reviewerReceiptId: string;
  readonly dispositionReview: KnowledgeDispositionReviewV1;
  readonly terminalFate: 'reviewed-non-draft';
}

export interface StrictProducerExpressionSetV1 {
  readonly schemaVersion: 1;
  readonly setId: string;
  readonly lineage: StrictProducerLineageReceiptV1;
  readonly hypothesis: ProducerEligibleHypothesisV1;
  readonly analysisFixpointHash: string;
  readonly version: number;
  readonly parentSetId: string | null;
  readonly proposals: readonly StrictProducerProposalV1[];
  readonly zeroDisposition: StrictProducerZeroDispositionV1 | null;
  readonly cardinality: number;
  readonly authoredFingerprintHash: string;
  readonly repairNode: CausalRepairNodeV1;
  readonly setHash: string;
}

export interface CreateStrictProducerExpressionSetInputV1 {
  readonly lineage: StrictProducerLineageReceiptV1;
  readonly parentSet: StrictProducerExpressionSetV1 | null;
  readonly proposals: readonly StrictProducerProposalInputV1[];
  readonly zeroDisposition: {
    readonly reasonCode: string;
    readonly authored: FullAuthoredProjectionV1;
    readonly dispositionReview: KnowledgeDispositionReviewV1;
  } | null;
  readonly modelHash: string;
  readonly reasonHash: string;
}

export function createStrictProducerExpressionSetV1(
  input: CreateStrictProducerExpressionSetInputV1
): StrictProducerExpressionSetV1 {
  rejectProducerCallerLineageFields(input);
  assertStrictProducerLineageIntegrity(input.lineage);
  requireText(input.modelHash, 'STRICT_PRODUCER_MODEL_HASH_REQUIRED');
  requireText(input.reasonHash, 'STRICT_PRODUCER_REASON_HASH_REQUIRED');
  const { parentSetId, version } = resolveStrictProducerPredecessor(input);
  validateProducerExpressionCardinality(input);
  const proposals = normalizeStrictProducerProposals(input.proposals);
  const zeroDisposition = createStrictProducerZeroDisposition(input);
  const authoredFingerprintHash = hashCanonical({
    proposals,
    zeroDisposition,
  });
  const repairNode = createCausalRepairNodeV1({
    lineage: input.lineage,
    parents: input.parentSet ? [input.parentSet.repairNode] : [],
    stage: 'producer',
    inputHash: input.lineage.lineageHash,
    outputHash: authoredFingerprintHash,
    evidenceHash: input.lineage.evidenceProjectionHash,
    modelHash: input.modelHash,
    reasonHash: input.reasonHash,
  });
  if (repairNode.semanticRepairDepth !== version - 1) {
    fail('STRICT_PRODUCER_REPAIR_LINEAGE_INVALID');
  }
  const setId = hashCanonical({
    kind: 'strict-producer-expression-set-v1',
    knowledgeRootId: input.lineage.knowledgeRootId,
    version,
    parentSetId,
  });
  const semantic = {
    schemaVersion: 1 as const,
    setId,
    lineage: input.lineage,
    hypothesis: input.lineage.hypothesis,
    analysisFixpointHash: input.lineage.analysisFixpointHash,
    version,
    parentSetId,
    proposals,
    zeroDisposition,
    cardinality: proposals.length,
    authoredFingerprintHash,
    repairNode,
  };
  return freeze({ ...semantic, setHash: hashCanonical(semantic) });
}

function rejectProducerCallerLineageFields(input: CreateStrictProducerExpressionSetInputV1): void {
  for (const forbiddenField of [
    'setId',
    'version',
    'parentSetId',
    'hypothesis',
    'analysisFixpointHash',
    'authoredFingerprintHash',
    'repairNode',
  ]) {
    if (Object.hasOwn(input, forbiddenField)) {
      fail('STRICT_PRODUCER_CALLER_LINEAGE_FIELD_FORBIDDEN', forbiddenField);
    }
  }
}

function resolveStrictProducerPredecessor(input: CreateStrictProducerExpressionSetInputV1): {
  readonly version: number;
  readonly parentSetId: string | null;
} {
  if (input.parentSet) {
    assertStrictProducerExpressionSetIntegrity(input.parentSet);
    if (input.parentSet.lineage.lineageHash !== input.lineage.lineageHash) {
      fail('STRICT_PRODUCER_PREDECESSOR_BINDING_CHANGED');
    }
  }
  const version = (input.parentSet?.version ?? 0) + 1;
  if (version > 3) {
    fail('STRICT_CAUSAL_REPAIR_LIMIT');
  }
  return { parentSetId: input.parentSet?.setId ?? null, version };
}

function validateProducerExpressionCardinality(
  input: CreateStrictProducerExpressionSetInputV1
): void {
  if (input.proposals.length === 0 && !input.zeroDisposition) {
    fail('STRICT_PRODUCER_ZERO_DISPOSITION_REQUIRED');
  }
  if (input.proposals.length > 0 && input.zeroDisposition) {
    fail('STRICT_PRODUCER_ZERO_DISPOSITION_CONFLICT');
  }
}

function normalizeStrictProducerProposals(
  input: readonly StrictProducerProposalInputV1[]
): StrictProducerProposalV1[] {
  const expressionIds = normalizeIds(
    input.map((proposal) => proposal.expressionId),
    'expressionIds'
  );
  if (expressionIds.length !== input.length) {
    fail('STRICT_PRODUCER_EXPRESSION_DUPLICATE');
  }
  for (const proposal of input) {
    validateAuthoredProjection(proposal.authored);
    if (
      (proposal.kind === 'merge' || proposal.kind === 'duplicate') &&
      !proposal.matchingRepresentativeId
    ) {
      fail('STRICT_PRODUCER_REPRESENTATIVE_REQUIRED', proposal.expressionId);
    }
  }
  return [...input]
    .map((proposal) => ({
      expressionId: proposal.expressionId,
      kind: proposal.kind,
      authored: proposal.authored,
      ...(proposal.matchingRepresentativeId
        ? { matchingRepresentativeId: proposal.matchingRepresentativeId }
        : {}),
      authoredFingerprint: hashCoreCanonical({
        schemaVersion: 1,
        authored: proposal.authored,
      }),
    }))
    .sort((left, right) => left.expressionId.localeCompare(right.expressionId));
}

function createStrictProducerZeroDisposition(
  input: CreateStrictProducerExpressionSetInputV1
): StrictProducerZeroDispositionV1 | null {
  if (!input.zeroDisposition) {
    return null;
  }
  requireText(input.zeroDisposition.reasonCode, 'STRICT_PRODUCER_ZERO_REASON_REQUIRED');
  validateAuthoredProjection(input.zeroDisposition.authored);
  assertKnowledgeDispositionReviewV1(input.zeroDisposition.dispositionReview);
  const review = input.zeroDisposition.dispositionReview;
  if (
    review.reviewKind !== 'producer-non-draft' ||
    review.verdict !== 'pass' ||
    review.currentAnalysisFixpointHash !== input.lineage.analysisFixpointHash ||
    review.populationHash !== input.lineage.populationHash ||
    review.proposedDispositionHash !==
      hashKnowledgeDispositionProposalV1({
        reviewKind: 'producer-non-draft',
        populationHash: input.lineage.populationHash,
        hypothesisId: input.lineage.hypothesis.hypothesisId,
        expression: null,
        zeroDisposition: {
          reasonCode: input.zeroDisposition.reasonCode,
          terminalFate: 'reviewed-non-draft',
        },
      })
  ) {
    fail('STRICT_PRODUCER_ZERO_REVIEW_INVALID');
  }
  return {
    reasonCode: input.zeroDisposition.reasonCode,
    authored: input.zeroDisposition.authored,
    reviewerReceiptId: review.reviewReceiptId,
    dispositionReview: review,
    terminalFate: 'reviewed-non-draft',
  };
}

export interface StrictExpressionTerminalResolutionV1
  extends Omit<HypothesisExpressionRowV1, 'authoredFingerprint'> {}

export interface CreateStrictHypothesisExpressionSetReceiptInputV1 {
  readonly expressionSet: StrictProducerExpressionSetV1;
  readonly parentReceipt: HypothesisExpressionSetReceiptV1 | null;
  readonly privateCorpusRevision: string;
  readonly terminalHead: boolean;
  /**
   * Main/后续 gate 只回填 terminal fate 与 Core receipt；expression identity/fingerprint 由
   * Agent proposal 派生，不能被下游换绑。此函数只验证/封印，不授予 persistence/admission。
   */
  readonly terminalResolutions: readonly StrictExpressionTerminalResolutionV1[];
}

/**
 * 将 Agent 0/1/N proposal lineage 封印成 Core HypothesisExpressionSet terminal receipt。
 * Core validator 负责 non-draft review、terminal closure 与 lineage 字段的最终 fail-closed 校验。
 */
export function createStrictHypothesisExpressionSetReceiptV1(
  input: CreateStrictHypothesisExpressionSetReceiptInputV1
): HypothesisExpressionSetReceiptV1 {
  assertStrictProducerExpressionSetIntegrity(input.expressionSet);
  requireText(input.privateCorpusRevision, 'STRICT_EXPRESSION_PRIVATE_CORPUS_REVISION_REQUIRED');
  const expectedParentReceiptId = input.expressionSet.parentSetId
    ? `expression-set:${input.expressionSet.parentSetId}`
    : null;
  if (
    (input.parentReceipt?.receiptId ?? null) !== expectedParentReceiptId ||
    (input.parentReceipt &&
      (input.parentReceipt.hypothesisId !== input.expressionSet.hypothesis.hypothesisId ||
        input.parentReceipt.analysisFixpointHash !== input.expressionSet.analysisFixpointHash ||
        input.parentReceipt.privateCorpusRevision !== input.privateCorpusRevision ||
        input.parentReceipt.version !== input.expressionSet.version - 1))
  ) {
    fail('STRICT_EXPRESSION_PARENT_RECEIPT_MISMATCH');
  }
  const resolutionsById = new Map(
    input.terminalResolutions.map((resolution) => [resolution.expressionId, resolution])
  );
  if (
    resolutionsById.size !== input.terminalResolutions.length ||
    resolutionsById.size !== input.expressionSet.proposals.length ||
    input.expressionSet.proposals.some((proposal) => !resolutionsById.has(proposal.expressionId))
  ) {
    fail('STRICT_EXPRESSION_TERMINAL_RESOLUTION_CONSERVATION');
  }
  const expressions = input.expressionSet.proposals.map((proposal) => {
    const resolution = resolutionsById.get(proposal.expressionId);
    if (!resolution) {
      fail('STRICT_EXPRESSION_TERMINAL_RESOLUTION_MISSING', proposal.expressionId);
    }
    return {
      expressionId: proposal.expressionId,
      authoredFingerprint: proposal.authoredFingerprint,
      terminalFate: resolution.terminalFate,
      terminalReceiptId: resolution.terminalReceiptId,
      terminalReceiptHash: resolution.terminalReceiptHash,
      ...(resolution.dispositionReview ? { dispositionReview: resolution.dispositionReview } : {}),
      ...(resolution.matchingRepresentativeId
        ? { matchingRepresentativeId: resolution.matchingRepresentativeId }
        : {}),
      ...(resolution.matchingContentReadyRecipeId
        ? { matchingContentReadyRecipeId: resolution.matchingContentReadyRecipeId }
        : {}),
    };
  });
  return validateHypothesisExpressionSetReceiptV1({
    schemaVersion: 1,
    receiptId: `expression-set:${input.expressionSet.setId}`,
    hypothesisId: input.expressionSet.hypothesis.hypothesisId,
    analysisFixpointHash: input.expressionSet.analysisFixpointHash,
    privateCorpusRevision: input.privateCorpusRevision,
    version: input.expressionSet.version,
    parentReceiptId: expectedParentReceiptId,
    terminalHead: input.terminalHead,
    expressions,
    zeroDisposition: input.expressionSet.zeroDisposition
      ? {
          reasonCode: input.expressionSet.zeroDisposition.reasonCode,
          reviewerReceiptId: input.expressionSet.zeroDisposition.reviewerReceiptId,
          dispositionReview: input.expressionSet.zeroDisposition.dispositionReview,
          terminalFate: input.expressionSet.zeroDisposition.terminalFate,
        }
      : null,
  });
}

function assertStrictProducerExpressionSetIntegrity(set: StrictProducerExpressionSetV1): void {
  const { setHash, ...semantic } = set;
  if (set.schemaVersion !== 1 || hashCanonical(semantic) !== setHash) {
    fail('STRICT_PRODUCER_PARENT_SET_HASH_MISMATCH');
  }
  assertStrictProducerLineageIntegrity(set.lineage);
  assertCausalRepairNodeIntegrity(set.repairNode);
  const authoredFingerprintHash = hashCanonical({
    proposals: set.proposals,
    zeroDisposition: set.zeroDisposition,
  });
  if (
    set.proposals.some(
      (proposal) =>
        proposal.authoredFingerprint !==
        hashCoreCanonical({ schemaVersion: 1, authored: proposal.authored })
    )
  ) {
    fail('STRICT_PRODUCER_PARENT_EXPRESSION_FINGERPRINT_MISMATCH');
  }
  if (
    authoredFingerprintHash !== set.authoredFingerprintHash ||
    set.repairNode.outputHash !== set.authoredFingerprintHash
  ) {
    fail('STRICT_PRODUCER_PARENT_SET_FINGERPRINT_MISMATCH');
  }
  if (
    set.repairNode.lineageHash !== set.lineage.lineageHash ||
    set.repairNode.inputHash !== set.lineage.lineageHash ||
    set.repairNode.evidenceHash !== set.lineage.evidenceProjectionHash ||
    set.analysisFixpointHash !== set.lineage.analysisFixpointHash ||
    hashCanonical(set.hypothesis) !== set.lineage.hypothesisHash
  ) {
    fail('STRICT_PRODUCER_PARENT_SET_LINEAGE_MISMATCH');
  }
  const expectedSetId = hashCanonical({
    kind: 'strict-producer-expression-set-v1',
    knowledgeRootId: set.lineage.knowledgeRootId,
    version: set.version,
    parentSetId: set.parentSetId,
  });
  if (expectedSetId !== set.setId) {
    fail('STRICT_PRODUCER_PARENT_SET_ID_MISMATCH');
  }
  if (
    set.version < 1 ||
    set.version > 3 ||
    set.repairNode.semanticRepairDepth !== set.version - 1 ||
    (set.version === 1) !== (set.parentSetId === null)
  ) {
    fail('STRICT_PRODUCER_PARENT_SET_DEPTH_MISMATCH');
  }
}

function validateAuthoredProjection(authored: FullAuthoredProjectionV1): void {
  for (const [field, value] of Object.entries({
    title: authored.title,
    kind: authored.kind,
    doClause: authored.doClause,
    dontClause: authored.dontClause,
    markdown: authored.markdown,
    usageGuide: authored.usageGuide,
  })) {
    requireText(value, `STRICT_AUTHORED_${field.toUpperCase()}_REQUIRED`);
  }
  if (
    !authored.retrievalProfile ||
    typeof authored.retrievalProfile !== 'object' ||
    authored.negativeIntent.length === 0 ||
    authored.scope.moduleIds.length === 0 ||
    authored.scope.dimensionIds.length === 0 ||
    authored.evidenceEntryIds.length === 0
  ) {
    fail('STRICT_AUTHORED_PROJECTION_INCOMPLETE');
  }
}
