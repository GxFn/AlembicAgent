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

type StrictEvidenceProjectionEntryV1 = StrictProducerEvidenceProjectionV1['entries'][number];

/**
 * 证据投影规范化的错误码表。评审侧（evaluation 的 createFrozenEvidenceProjection，创建并冻结
 * 投影）与 lineage 侧（assertEvidenceProjectionIntegrity，跨进程复核投影）共用同一份规范化与
 * 哈希，但各自保留既有错误码：宿主和测试靠错误码区分“创建时拒绝”还是“复核时拒绝”。
 */
export interface StrictEvidenceProjectionErrorCodesV1 {
  /** 必填文本字段缺失时的前缀，后接大写字段名与 `_REQUIRED`（例如 `EVIDENCEENTRYID_REQUIRED`）。 */
  readonly fieldRequiredPrefix: string;
  /** 行号不是安全整数、起始行小于 1 或结束行早于起始行。 */
  readonly rangeInvalid: string;
  /** content 不是字符串或其 sha256 与 contentHash 不一致。 */
  readonly contentHashMismatch: string;
  /** content 的行数与 [startLine, endLine] 覆盖的行数不一致。 */
  readonly rangeContentMismatch: string;
  /** 规范化后 evidenceEntryId 重复。 */
  readonly idDuplicate: string;
}

/**
 * 冻结证据投影的唯一规范化与哈希实现（评审创建与 lineage 复核共用，避免两份实现各自调整
 * 排序或字段后让宿主产出的 projectionHash 在 lineage 复核失败）。
 *
 * - 先按输入顺序逐条校验，再排序：排序前保证 evidenceEntryId 是非空字符串，畸形条目得到带码
 *   错误而不是比较器里的 TypeError。
 * - 条目按 evidenceEntryId 以固定的 en 排序规则排列：hashCanonical 不排数组，元素顺序直接进入
 *   projectionHash；en/zh 环境下 ASCII 标识符顺序与历史结果逐字节一致，同时不再随进程默认
 *   区域（da/hu/lt 等）变化。码元序迁移不在本次范围内。
 * - 条目做浅拷贝后进入哈希，额外字段保持历史行为（一并进入哈希）。
 * - 是否允许空 entries 由调用方决定：评审侧拒绝空投影（STRICT_REVIEW_EVIDENCE_REQUIRED），
 *   lineage 侧目前接受（见 assertEvidenceProjectionIntegrity 的说明），本函数不替两侧统一口径。
 */
export function canonicalizeStrictEvidenceProjection(
  input: {
    readonly sourceRevisionVectorHash: string;
    readonly entries: readonly StrictEvidenceProjectionEntryV1[];
  },
  codes: StrictEvidenceProjectionErrorCodesV1
): {
  readonly semantic: {
    readonly schemaVersion: 1;
    readonly sourceRevisionVectorHash: string;
    readonly entries: StrictEvidenceProjectionEntryV1[];
  };
  readonly projectionHash: string;
} {
  const entries = input.entries
    .map((entry) => {
      for (const [field, value] of Object.entries({
        evidenceEntryId: entry.evidenceEntryId,
        relativePath: entry.relativePath,
        blobHash: entry.blobHash,
        contentHash: entry.contentHash,
      })) {
        requireText(value, `${codes.fieldRequiredPrefix}${field.toUpperCase()}_REQUIRED`);
      }
      if (
        !Number.isSafeInteger(entry.startLine) ||
        !Number.isSafeInteger(entry.endLine) ||
        entry.startLine < 1 ||
        entry.endLine < entry.startLine
      ) {
        fail(codes.rangeInvalid, entry.evidenceEntryId);
      }
      // 非字符串 content 无法复现 contentHash，按内容哈希不一致带码拒绝，而不是让 createHash 抛无码 TypeError。
      if (
        typeof entry.content !== 'string' ||
        createHash('sha256').update(entry.content).digest('hex') !== entry.contentHash
      ) {
        fail(codes.contentHashMismatch, entry.evidenceEntryId);
      }
      if (entry.content.split('\n').length !== entry.endLine - entry.startLine + 1) {
        fail(codes.rangeContentMismatch, entry.evidenceEntryId);
      }
      return { ...entry };
    })
    .sort((left, right) => left.evidenceEntryId.localeCompare(right.evidenceEntryId, 'en'));
  if (new Set(entries.map((entry) => entry.evidenceEntryId)).size !== entries.length) {
    fail(codes.idDuplicate);
  }
  const semantic = {
    schemaVersion: 1 as const,
    sourceRevisionVectorHash: input.sourceRevisionVectorHash,
    entries,
  };
  return { semantic, projectionHash: hashCanonical(semantic) };
}

/** lineage 复核侧的既有错误码；行范围与内容行数不一致历来共用 RANGE_INVALID。 */
const LINEAGE_EVIDENCE_PROJECTION_CODES: StrictEvidenceProjectionErrorCodesV1 = {
  fieldRequiredPrefix: 'STRICT_PRODUCER_LINEAGE_EVIDENCE_',
  rangeInvalid: 'STRICT_PRODUCER_LINEAGE_EVIDENCE_RANGE_INVALID',
  contentHashMismatch: 'STRICT_PRODUCER_LINEAGE_EVIDENCE_CONTENT_HASH_MISMATCH',
  rangeContentMismatch: 'STRICT_PRODUCER_LINEAGE_EVIDENCE_RANGE_INVALID',
  idDuplicate: 'STRICT_PRODUCER_LINEAGE_EVIDENCE_ID_DUPLICATE',
};

/**
 * 跨进程复核冻结证据投影：用与评审创建侧相同的规范化重算 projectionHash，调用方不能重算外层
 * hash 自证。
 *
 * 开放问题：评审侧拒绝空 entries，这里仍接受空投影（保持现状，未做决定前不收窄）；实际空投影
 * 会在随后的 context evidenceEntryIds 绑定处按 STRICT_PRODUCER_LINEAGE_EVIDENCE_BINDING_MISMATCH
 * 失败，除非 context 也声明了空证据集合。
 */
function assertEvidenceProjectionIntegrity(evidence: StrictProducerEvidenceProjectionV1): void {
  if (evidence.schemaVersion !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_EVIDENCE_VERSION_MISMATCH');
  }
  requireText(
    evidence.sourceRevisionVectorHash,
    'STRICT_PRODUCER_LINEAGE_EVIDENCE_SOURCE_REQUIRED'
  );
  const { projectionHash } = canonicalizeStrictEvidenceProjection(
    evidence,
    LINEAGE_EVIDENCE_PROJECTION_CODES
  );
  if (projectionHash !== evidence.projectionHash) {
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

const CAUSAL_REPAIR_STAGES: ReadonlySet<string> = new Set(['analyst', 'producer', 'reviewer']);

/** createCausalRepairNodeV1 的修复深度上限（超过即 STRICT_CAUSAL_REPAIR_LIMIT）。 */
const MAX_SEMANTIC_REPAIR_DEPTH = 2;

/**
 * 跨进程复核因果修复节点（C32）。nodeHash 只证明“内容与外层 hash 一致”，调用者可以改写字段后
 * 重算 nodeHash 自证；因此还要按 createCausalRepairNodeV1 的派生规则逐项复核：
 * - stage 必须属于公开枚举（analyst/producer/reviewer；后两者当前无产出方，保留为公开类型）；
 * - rootIds 非空，rootIds/parentNodeIds 必须是 normalizeIds 的规范形（创建时就以该形态写入）；
 * - 深度与前驱一致：无前驱即深度 0，有前驱即深度 ≥1，且不超过创建时的修复上限；
 * - 必填 hash 字段与创建时同码校验；
 * - nodeId 由 rootIds/parentNodeIds/stage/lineageHash/inputHash/outputHash 复算，不接受调用者自选。
 * 与父表达集的结构绑定（rootIds 指向 lineage 根、单前驱链）由 expressions.ts 在表达集层复核。
 */
export function assertCausalRepairNodeIntegrity(node: CausalRepairNodeV1): void {
  const { nodeHash, ...semantic } = node;
  if (node.schemaVersion !== 1 || hashCanonical(semantic) !== nodeHash) {
    fail('STRICT_CAUSAL_NODE_HASH_MISMATCH');
  }
  if (!CAUSAL_REPAIR_STAGES.has(node.stage)) {
    fail('STRICT_CAUSAL_STAGE_INVALID');
  }
  const rootIds = normalizeIds(node.rootIds, 'causalRootIds');
  if (rootIds.length === 0 || !sameOrderedIds(rootIds, node.rootIds)) {
    fail('STRICT_CAUSAL_ROOT_IDS_INVALID');
  }
  const parentNodeIds = normalizeIds(node.parentNodeIds, 'causalParentNodeIds');
  if (!sameOrderedIds(parentNodeIds, node.parentNodeIds)) {
    fail('STRICT_CAUSAL_PARENT_NODE_IDS_INVALID');
  }
  if (
    !Number.isSafeInteger(node.semanticRepairDepth) ||
    node.semanticRepairDepth < 0 ||
    node.semanticRepairDepth > MAX_SEMANTIC_REPAIR_DEPTH ||
    (parentNodeIds.length === 0) !== (node.semanticRepairDepth === 0)
  ) {
    fail('STRICT_CAUSAL_REPAIR_DEPTH_INVALID');
  }
  for (const [field, value] of Object.entries({
    inputHash: node.inputHash,
    outputHash: node.outputHash,
    evidenceHash: node.evidenceHash,
    modelHash: node.modelHash,
    reasonHash: node.reasonHash,
  })) {
    requireText(value, `STRICT_CAUSAL_${field.toUpperCase()}_REQUIRED`);
  }
  const expectedNodeId = hashCanonical({
    kind: 'strict-causal-repair-node-v1',
    rootIds: node.rootIds,
    parentNodeIds: node.parentNodeIds,
    stage: node.stage,
    lineageHash: node.lineageHash,
    inputHash: node.inputHash,
    outputHash: node.outputHash,
  });
  if (expectedNodeId !== node.nodeId) {
    fail('STRICT_CAUSAL_NODE_ID_MISMATCH');
  }
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
