/** Producer证据/假设血缘与有界因果修复；消费已验证的Analyst回执。 */

import { createHash } from 'node:crypto';
import type { AnalysisFixpointReceiptV1 } from '@alembic/core/production';
import {
  assertStrictContextIntegrity,
  type StrictAnalysisContextProjectionV1,
} from './analysisLoop.js';
import {
  assertAnalysisFixpointIntegrity,
  assertStrictAnalystEpochIntegrity,
  type ProducerEligibleHypothesisV1,
  type StrictAnalystEpochV1,
} from './analyst.js';
import {
  assertContainsIds,
  assertSameIds,
  fail,
  freeze,
  hashCanonical,
  normalizeIds,
  requireText,
} from './primitives.js';

export interface StrictProducerEvidenceProjectionV1 {
  readonly schemaVersion: 1;
  readonly sourceRevisionVectorHash: string;
  readonly entries: readonly {
    readonly evidenceEntryId: string;
    readonly relativePath: string;
    readonly blobHash: string;
    readonly contentHash: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
  }[];
  readonly projectionHash: string;
}

/**
 * Producer 的输入不是一组可由调用者重填的字符串，而是从已验证 epoch、Core fixpoint 和
 * 冻结证据投影派生的不可变 receipt。后续表达修复只能复用同一 receipt。
 */
export interface StrictProducerLineageReceiptV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly planCognitionHash: string;
  readonly sourceRevisionVectorHash: string;
  readonly epochHash: string;
  readonly populationHash: string;
  readonly clusterSetHash: string;
  readonly clusterId: string;
  readonly inductionReceiptHash: string;
  readonly falsificationReceiptHash: string;
  readonly dispositionReviewReceiptId: string;
  readonly hypothesis: ProducerEligibleHypothesisV1;
  readonly hypothesisHash: string;
  readonly analysisFixpointHash: string;
  readonly evidenceProjectionHash: string;
  readonly evidenceEntryIds: readonly string[];
  readonly knowledgeRootId: string;
  readonly lineageHash: string;
}

export interface CreateStrictProducerLineageReceiptInputV1 {
  readonly context: StrictAnalysisContextProjectionV1;
  readonly epoch: StrictAnalystEpochV1;
  readonly analysisFixpoint: AnalysisFixpointReceiptV1;
  readonly hypothesisId: string;
  readonly evidence: StrictProducerEvidenceProjectionV1;
}

export function createStrictProducerLineageReceiptV1(
  input: CreateStrictProducerLineageReceiptInputV1
): StrictProducerLineageReceiptV1 {
  assertStrictContextIntegrity(input.context);
  assertStrictAnalystEpochIntegrity(input.epoch);
  assertAnalysisFixpointIntegrity(input.analysisFixpoint);
  assertEvidenceProjectionIntegrity(input.evidence);
  requireText(input.hypothesisId, 'STRICT_PRODUCER_LINEAGE_HYPOTHESIS_REQUIRED');

  const hypothesis = input.epoch.producerEligibleHypotheses.find(
    (candidate) => candidate.hypothesisId === input.hypothesisId
  );
  if (!hypothesis) {
    fail('STRICT_PRODUCER_LINEAGE_HYPOTHESIS_NOT_ELIGIBLE', input.hypothesisId);
  }
  const matchingInductions = input.epoch.inductions.filter((receipt) =>
    receipt.hypotheses.some((candidate) => candidate.hypothesisId === input.hypothesisId)
  );
  if (matchingInductions.length !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_INDUCTION_AMBIGUOUS', input.hypothesisId);
  }
  const induction = matchingInductions[0];
  const matchingFalsifications = input.epoch.falsifications.filter(
    (receipt) => receipt.hypothesisId === input.hypothesisId
  );
  if (matchingFalsifications.length !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_FALSIFICATION_AMBIGUOUS', input.hypothesisId);
  }
  const falsification = matchingFalsifications[0];
  const cluster = input.epoch.clusterSet.clusters.find(
    (candidate) => candidate.clusterId === induction?.clusterId
  );
  if (!induction || !falsification || !cluster) {
    fail('STRICT_PRODUCER_LINEAGE_CLUSTER_MISSING', input.hypothesisId);
  }
  if (
    !input.analysisFixpoint.clusterSetHashes.includes(input.epoch.clusterSet.clusterSetHash) ||
    !input.analysisFixpoint.inductionReceiptHashes.includes(induction.receiptHash) ||
    !input.analysisFixpoint.falsificationReceiptHashes.includes(falsification.receiptHash) ||
    hypothesis.dispositionReviewReceiptId !== falsification.dispositionReviewReceiptId ||
    induction.currentAnalysisFixpointHash !== input.analysisFixpoint.analysisReviewContextHash ||
    falsification.currentAnalysisFixpointHash !==
      input.analysisFixpoint.analysisReviewContextHash ||
    input.context.analysisFixpointHash !== input.analysisFixpoint.fixpointHash ||
    input.context.sourceRevisionVectorHash !== input.evidence.sourceRevisionVectorHash ||
    input.epoch.population.sourceRevisionVectorHash !== input.evidence.sourceRevisionVectorHash
  ) {
    fail('STRICT_PRODUCER_LINEAGE_FIXPOINT_BINDING_MISMATCH');
  }
  assertSameIds(
    input.context.evidenceEntryIds,
    input.evidence.entries.map((entry) => entry.evidenceEntryId),
    'STRICT_PRODUCER_LINEAGE_EVIDENCE_BINDING_MISMATCH'
  );
  for (const [actual, expected, code] of [
    [input.context.populationHashes, [input.epoch.population.populationHash], 'POPULATION'],
    [input.context.clusterSetHashes, [input.epoch.clusterSet.clusterSetHash], 'CLUSTER_SET'],
    [input.context.inductionReceiptHashes, [induction.receiptHash], 'INDUCTION'],
    [input.context.hypothesisIds, [hypothesis.hypothesisId], 'HYPOTHESIS'],
    [input.context.falsificationReceiptHashes, [falsification.receiptHash], 'FALSIFICATION'],
    [
      input.context.dispositionReviewIds,
      input.epoch.dispositionReviews.map((review) => review.reviewReceiptId),
      'DISPOSITION_REVIEW',
    ],
  ] as const) {
    assertContainsIds(actual, expected, `STRICT_PRODUCER_LINEAGE_${code}_BINDING_MISMATCH`);
  }

  const hypothesisHash = hashCanonical(hypothesis);
  const knowledgeRootId = hashCanonical({
    schemaVersion: 1,
    runId: input.context.runId,
    planCognitionHash: input.context.planCognitionHash,
    sourceRevisionVectorHash: input.context.sourceRevisionVectorHash,
    epochHash: input.epoch.epochHash,
    populationHash: input.epoch.population.populationHash,
    clusterSetHash: input.epoch.clusterSet.clusterSetHash,
    clusterId: cluster.clusterId,
    inductionReceiptHash: induction.receiptHash,
    falsificationReceiptHash: falsification.receiptHash,
    dispositionReviewReceiptId: falsification.dispositionReviewReceiptId,
    hypothesisHash,
    analysisFixpointHash: input.analysisFixpoint.fixpointHash,
    evidenceProjectionHash: input.evidence.projectionHash,
    evidenceEntryIds: normalizeIds(
      input.evidence.entries.map((entry) => entry.evidenceEntryId),
      'producerRootEvidenceEntryIds'
    ),
  });
  const semantic = {
    schemaVersion: 1 as const,
    runId: input.context.runId,
    planCognitionHash: input.context.planCognitionHash,
    sourceRevisionVectorHash: input.context.sourceRevisionVectorHash,
    epochHash: input.epoch.epochHash,
    populationHash: input.epoch.population.populationHash,
    clusterSetHash: input.epoch.clusterSet.clusterSetHash,
    clusterId: cluster.clusterId,
    inductionReceiptHash: induction.receiptHash,
    falsificationReceiptHash: falsification.receiptHash,
    dispositionReviewReceiptId: falsification.dispositionReviewReceiptId,
    hypothesis,
    hypothesisHash,
    analysisFixpointHash: input.analysisFixpoint.fixpointHash,
    evidenceProjectionHash: input.evidence.projectionHash,
    evidenceEntryIds: normalizeIds(
      input.evidence.entries.map((entry) => entry.evidenceEntryId),
      'producerLineageEvidenceEntryIds'
    ),
    knowledgeRootId,
  };
  return freeze({ ...semantic, lineageHash: hashCanonical(semantic) });
}

export interface CausalRepairNodeV1 {
  readonly schemaVersion: 1;
  readonly nodeId: string;
  readonly rootIds: readonly string[];
  readonly parentNodeIds: readonly string[];
  readonly stage: 'analyst' | 'producer' | 'reviewer';
  readonly lineageHash: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly evidenceHash: string;
  readonly modelHash: string;
  readonly reasonHash: string;
  readonly semanticRepairDepth: number;
  readonly nodeHash: string;
}

export interface CreateCausalRepairNodeInputV1 {
  readonly lineage: StrictProducerLineageReceiptV1;
  readonly parents: readonly CausalRepairNodeV1[];
  readonly stage: CausalRepairNodeV1['stage'];
  readonly inputHash: string;
  readonly outputHash: string;
  readonly evidenceHash: string;
  readonly modelHash: string;
  readonly reasonHash: string;
}

export function createCausalRepairNodeV1(input: CreateCausalRepairNodeInputV1): CausalRepairNodeV1 {
  assertStrictProducerLineageIntegrity(input.lineage);
  for (const parent of input.parents) {
    assertCausalRepairNodeIntegrity(parent);
  }
  for (const [field, value] of Object.entries({
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    evidenceHash: input.evidenceHash,
    modelHash: input.modelHash,
    reasonHash: input.reasonHash,
  })) {
    requireText(value, `STRICT_CAUSAL_${field.toUpperCase()}_REQUIRED`);
  }
  const rootIds =
    input.parents.length === 0
      ? [input.lineage.knowledgeRootId]
      : normalizeIds(
          input.parents.flatMap((parent) => parent.rootIds),
          'parentRootIds'
        );
  const semanticRepairDepth =
    input.parents.length === 0
      ? 0
      : 1 + Math.max(...input.parents.map((parent) => parent.semanticRepairDepth));
  if (semanticRepairDepth > 2) {
    fail('STRICT_CAUSAL_REPAIR_LIMIT');
  }
  const parentNodeIds = normalizeIds(
    input.parents.map((parent) => parent.nodeId),
    'parentNodeIds'
  );
  const nodeId = hashCanonical({
    kind: 'strict-causal-repair-node-v1',
    rootIds,
    parentNodeIds,
    stage: input.stage,
    lineageHash: input.lineage.lineageHash,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
  });
  const semantic = {
    schemaVersion: 1 as const,
    nodeId,
    rootIds,
    parentNodeIds,
    stage: input.stage,
    lineageHash: input.lineage.lineageHash,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    evidenceHash: input.evidenceHash,
    modelHash: input.modelHash,
    reasonHash: input.reasonHash,
    semanticRepairDepth,
  };
  return freeze({ ...semantic, nodeHash: hashCanonical(semantic) });
}

function assertEvidenceProjectionIntegrity(evidence: StrictProducerEvidenceProjectionV1): void {
  if (evidence.schemaVersion !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_VERSION_MISMATCH');
  }
  requireText(
    evidence.sourceRevisionVectorHash,
    'STRICT_PRODUCER_LINEAGE_EVIDENCE_SOURCE_REQUIRED'
  );
  const entries = [...evidence.entries].sort((left, right) =>
    left.evidenceEntryId.localeCompare(right.evidenceEntryId)
  );
  for (const entry of entries) {
    for (const [field, value] of Object.entries({
      evidenceEntryId: entry.evidenceEntryId,
      relativePath: entry.relativePath,
      blobHash: entry.blobHash,
      contentHash: entry.contentHash,
    })) {
      requireText(value, `STRICT_PRODUCER_LINEAGE_EVIDENCE_${field.toUpperCase()}_REQUIRED`);
    }
    const contentHash = createHash('sha256').update(entry.content).digest('hex');
    if (contentHash !== entry.contentHash) {
      fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_CONTENT_HASH_MISMATCH', entry.evidenceEntryId);
    }
    if (
      !Number.isSafeInteger(entry.startLine) ||
      !Number.isSafeInteger(entry.endLine) ||
      entry.startLine < 1 ||
      entry.endLine < entry.startLine ||
      entry.content.split('\n').length !== entry.endLine - entry.startLine + 1
    ) {
      fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_RANGE_INVALID', entry.evidenceEntryId);
    }
  }
  if (new Set(entries.map((entry) => entry.evidenceEntryId)).size !== entries.length) {
    fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_ID_DUPLICATE');
  }
  const semantic = {
    schemaVersion: 1 as const,
    sourceRevisionVectorHash: evidence.sourceRevisionVectorHash,
    entries,
  };
  if (hashCanonical(semantic) !== evidence.projectionHash) {
    fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_PROJECTION_HASH_MISMATCH');
  }
}

export function assertStrictProducerLineageIntegrity(
  lineage: StrictProducerLineageReceiptV1
): void {
  if (lineage.schemaVersion !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_VERSION_MISMATCH');
  }
  for (const [field, value] of Object.entries({
    runId: lineage.runId,
    planCognitionHash: lineage.planCognitionHash,
    sourceRevisionVectorHash: lineage.sourceRevisionVectorHash,
    epochHash: lineage.epochHash,
    populationHash: lineage.populationHash,
    clusterSetHash: lineage.clusterSetHash,
    clusterId: lineage.clusterId,
    inductionReceiptHash: lineage.inductionReceiptHash,
    falsificationReceiptHash: lineage.falsificationReceiptHash,
    dispositionReviewReceiptId: lineage.dispositionReviewReceiptId,
    hypothesisHash: lineage.hypothesisHash,
    analysisFixpointHash: lineage.analysisFixpointHash,
    evidenceProjectionHash: lineage.evidenceProjectionHash,
    knowledgeRootId: lineage.knowledgeRootId,
    lineageHash: lineage.lineageHash,
  })) {
    requireText(value, `STRICT_PRODUCER_LINEAGE_${field.toUpperCase()}_REQUIRED`);
  }
  if (hashCanonical(lineage.hypothesis) !== lineage.hypothesisHash) {
    fail('STRICT_PRODUCER_LINEAGE_HYPOTHESIS_HASH_MISMATCH');
  }
  const expectedRootId = hashCanonical({
    schemaVersion: 1,
    runId: lineage.runId,
    planCognitionHash: lineage.planCognitionHash,
    sourceRevisionVectorHash: lineage.sourceRevisionVectorHash,
    epochHash: lineage.epochHash,
    populationHash: lineage.populationHash,
    clusterSetHash: lineage.clusterSetHash,
    clusterId: lineage.clusterId,
    inductionReceiptHash: lineage.inductionReceiptHash,
    falsificationReceiptHash: lineage.falsificationReceiptHash,
    dispositionReviewReceiptId: lineage.dispositionReviewReceiptId,
    hypothesisHash: lineage.hypothesisHash,
    analysisFixpointHash: lineage.analysisFixpointHash,
    evidenceProjectionHash: lineage.evidenceProjectionHash,
    evidenceEntryIds: normalizeIds(lineage.evidenceEntryIds, 'producerRootEvidenceEntryIds'),
  });
  if (expectedRootId !== lineage.knowledgeRootId) {
    fail('STRICT_PRODUCER_LINEAGE_KNOWLEDGE_ROOT_MISMATCH');
  }
  const { lineageHash, ...semantic } = lineage;
  if (hashCanonical(semantic) !== lineageHash) {
    fail('STRICT_PRODUCER_LINEAGE_HASH_MISMATCH');
  }
}

export function assertCausalRepairNodeIntegrity(node: CausalRepairNodeV1): void {
  const { nodeHash, ...semantic } = node;
  if (node.schemaVersion !== 1 || hashCanonical(semantic) !== nodeHash) {
    fail('STRICT_CAUSAL_NODE_HASH_MISMATCH');
  }
  normalizeIds(node.rootIds, 'causalRootIds');
  normalizeIds(node.parentNodeIds, 'causalParentNodeIds');
  if (!Number.isSafeInteger(node.semanticRepairDepth) || node.semanticRepairDepth < 0) {
    fail('STRICT_CAUSAL_REPAIR_DEPTH_INVALID');
  }
}
