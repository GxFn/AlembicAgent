import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import {
  createAnalysisReviewContextHashV1,
  createFinalExpandedMiningScheduleReceiptV1,
  hashKnowledgeClusterV1,
} from '@alembic/core/production';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrozenEvidenceProjection } from '../src/agent/evaluation/IndependentValueReviewer.js';
import {
  type CausalRepairNodeV1,
  type CreateStrictProducerExpressionSetInputV1,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisFixpointV1,
  createStrictHypothesisExpressionSetReceiptV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalystEpochInputV1,
  type StrictAnalystEpochV1,
  type StrictProducerExpressionSetV1,
  type StrictProducerLineageReceiptV1,
  validateStrictAnalystEpochV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import { assertStrictAnalystEpochIntegrity } from '../src/agent/production/strict/analyst.js';
import { assertCausalRepairNodeIntegrity } from '../src/agent/production/strict/lineage.js';
import { hashCanonical } from '../src/agent/production/strict/primitives.js';
import {
  createExecutionReceipt,
  createReview,
  createSingleHypothesisEpochFixture,
  STRICT_SOURCE_REVISION,
} from './fixtures/strict-semantic-authority.js';

const authored = {
  title: 'Preserve typed Result envelopes',
  kind: 'rule',
  doClause: 'Return the typed Result envelope',
  dontClause: 'Do not leak raw exceptions',
  markdown: 'Handlers preserve the project Result contract.',
  usageGuide: 'Apply at every handler boundary.',
  retrievalProfile: { intents: ['handler result contract'] },
  negativeIntent: ['internal helper'],
  scope: { moduleIds: ['handlers'], dimensionIds: ['error-resilience'] },
  evidenceEntryIds: ['E-1'],
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const HANDLER_CONTENT = 'export function handle(): Result<void> { return Result.ok(); }';

function evidenceEntry(evidenceEntryId: string, content = HANDLER_CONTENT, startLine = 1) {
  return {
    evidenceEntryId,
    relativePath: 'src/handler.ts',
    blobHash: 'blob-handler',
    contentHash: sha256(content),
    startLine,
    endLine: startLine + content.split('\n').length - 1,
    content,
  };
}

function createLineageFixture(evidenceEntries = [evidenceEntry('E-1')]) {
  const semantic = createSingleHypothesisEpochFixture();
  const epoch = validateStrictAnalystEpochV1(semantic.epochInput);
  const analysisFixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule: semantic.finalExpandedSchedule,
    terminalObligations: semantic.terminalObligations,
    epochs: [epoch],
  });
  const context = createStrictAnalysisContextProjectionV1({
    runId: 'run-1',
    journalId: 'journal-1',
    manifestHash: 'manifest-1',
    planCognitionHash: 'plan-cognition-1',
    planHash: 'plan-1',
    requiredUniverseHash: 'universe-1',
    baselineScheduleHash: semantic.finalExpandedSchedule.baselineScheduleHash,
    expansionHeadHash: null,
    currentExpandedScheduleHash: semantic.finalExpandedSchedule.finalExpandedScheduleHash,
    finalExpandedScheduleHash: semantic.finalExpandedSchedule.finalExpandedScheduleHash,
    analysisFixpointHash: analysisFixpoint.fixpointHash,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: 'lens-1',
    sourceArtifactHash: 'artifact-1',
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    questionIds: ['question-1'],
    factQueryObligationIds: [semantic.executionReceipt.obligationId],
    analysisUnitIds: ['unit-1'],
    factIds: ['fact-handler'],
    witnessIds: ['witness-handler'],
    populationHashes: [epoch.population.populationHash],
    clusterSetHashes: [epoch.clusterSet.clusterSetHash],
    inductionReceiptHashes: epoch.inductions.map((receipt) => receipt.receiptHash),
    hypothesisIds: ['hypothesis-handler'],
    falsificationReceiptHashes: epoch.falsifications.map((receipt) => receipt.receiptHash),
    dispositionReviewIds: [semantic.dispositionReview.reviewReceiptId],
    evidenceEntryIds: evidenceEntries.map((entry) => entry.evidenceEntryId),
    derivedFindingCount: 0,
  });
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    entries: evidenceEntries,
  });
  const lineageInput = {
    context,
    epoch,
    analysisFixpoint,
    hypothesisId: 'hypothesis-handler',
    evidence,
  };
  const lineage = createStrictProducerLineageReceiptV1(lineageInput);
  return { analysisFixpoint, lineage, lineageInput, semantic, context };
}

function createSet(
  lineage: StrictProducerLineageReceiptV1,
  parentSet: ReturnType<typeof createStrictProducerExpressionSetV1> | null,
  suffix: string
) {
  return createStrictProducerExpressionSetV1({
    lineage,
    parentSet,
    proposals: [
      {
        expressionId: `expression-${suffix}`,
        kind: 'draft',
        authored: { ...authored, title: `${authored.title} ${suffix}` },
      },
    ],
    zeroDisposition: null,
    modelHash: 'producer-model-v1',
    reasonHash: `reason-${suffix}`,
  });
}

describe('strict producer predecessor-bound causal lineage', () => {
  it('freezes nested population payloads behind an already frozen container', () => {
    const { context } = createLineageFixture();
    const nested = { factIds: ['fact-handler'] };
    const population = Object.freeze({ nested });
    const input = {
      epoch: 1,
      context,
      populations: [population],
      terminalObligationIds: context.factQueryObligationIds,
      outstandingObligationIds: [],
    };
    const snapshot = createStrictAnalysisEpochSnapshotV1(input);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.factIds)).toBe(true);
    expect(() => nested.factIds.push('late-fact')).toThrow(TypeError);
    expect(createStrictAnalysisEpochSnapshotV1(input).snapshotHash).toBe(snapshot.snapshotHash);
  });

  it('derives immutable roots from semantic receipts and cannot reset the repair depth', () => {
    const { analysisFixpoint, lineage, semantic } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const repair1 = createSet(lineage, initial, 'repair-1');
    const repair2 = createSet(lineage, repair1, 'repair-2');

    expect(initial).toMatchObject({ version: 1, parentSetId: null });
    expect(repair1).toMatchObject({ version: 2, parentSetId: initial.setId });
    expect(repair2).toMatchObject({ version: 3, parentSetId: repair1.setId });
    expect(initial.repairNode.rootIds).toEqual([lineage.knowledgeRootId]);
    expect(repair2.repairNode.rootIds).toEqual(initial.repairNode.rootIds);
    expect(() => createSet(lineage, repair2, 'repair-3')).toThrow(/STRICT_CAUSAL_REPAIR_LIMIT/u);

    const zeroReview = createReview({
      reviewKind: 'producer-non-draft',
      currentAnalysisFixpointHash: analysisFixpoint.fixpointHash,
      populationHash: semantic.population.populationHash,
      proposal: {
        reviewKind: 'producer-non-draft',
        populationHash: semantic.population.populationHash,
        hypothesisId: 'hypothesis-handler',
        expression: null,
        zeroDisposition: {
          reasonCode: 'not-actionable-as-recipe',
          terminalFate: 'reviewed-non-draft',
        },
      },
      executionReceipts: [semantic.executionReceipt],
      finalExpandedSchedule: semantic.finalExpandedSchedule,
      terminalObligations: semantic.terminalObligations,
    });
    const zero = createStrictProducerExpressionSetV1({
      lineage,
      parentSet: null,
      proposals: [],
      zeroDisposition: {
        reasonCode: 'not-actionable-as-recipe',
        authored,
        dispositionReview: zeroReview,
      },
      modelHash: 'producer-model-v1',
      reasonHash: 'zero-expression',
    });
    const many = createStrictProducerExpressionSetV1({
      lineage,
      parentSet: null,
      proposals: [
        { expressionId: 'expression-a', kind: 'draft', authored },
        {
          expressionId: 'expression-b',
          kind: 'draft',
          authored: { ...authored, title: 'Preserve Result at command boundaries' },
        },
      ],
      zeroDisposition: null,
      modelHash: 'producer-model-v1',
      reasonHash: 'multiple-expressions',
    });
    expect(zero.cardinality).toBe(0);
    expect(many.cardinality).toBe(2);
    expect(
      createStrictHypothesisExpressionSetReceiptV1({
        expressionSet: zero,
        parentReceipt: null,
        privateCorpusRevision: 'revision:producer-zero',
        terminalHead: true,
        terminalResolutions: [],
      })
    ).toMatchObject({
      conservation: { authored: 0, terminal: 0, unresolved: 0 },
      terminalClosure: 'reviewed-non-draft',
    });
    expect(
      createStrictHypothesisExpressionSetReceiptV1({
        expressionSet: initial,
        parentReceipt: null,
        privateCorpusRevision: 'revision:producer-one',
        terminalHead: true,
        terminalResolutions: [
          {
            expressionId: 'expression-initial',
            terminalFate: 'content-ready',
            terminalReceiptId: 'g2:expression-initial',
            terminalReceiptHash: `sha256:${'9'.repeat(64)}`,
          },
        ],
      })
    ).toMatchObject({
      conservation: { authored: 1, terminal: 1, unresolved: 0 },
      terminalClosure: 'expressed',
    });
    expect(
      createStrictHypothesisExpressionSetReceiptV1({
        expressionSet: many,
        parentReceipt: null,
        privateCorpusRevision: 'revision:producer-many',
        terminalHead: true,
        terminalResolutions: many.proposals.map((proposal) => ({
          expressionId: proposal.expressionId,
          terminalFate: 'content-ready' as const,
          terminalReceiptId: `g2:${proposal.expressionId}`,
          terminalReceiptHash: `sha256:${proposal.expressionId.endsWith('a') ? 'a' : 'b'}`.padEnd(
            71,
            proposal.expressionId.endsWith('a') ? 'a' : 'b'
          ),
        })),
      })
    ).toMatchObject({
      conservation: { authored: 2, terminal: 2, unresolved: 0 },
      terminalClosure: 'expressed',
    });
    expect(() =>
      createStrictHypothesisExpressionSetReceiptV1({
        expressionSet: many,
        parentReceipt: null,
        privateCorpusRevision: 'revision:producer-many',
        terminalHead: true,
        terminalResolutions: [],
      })
    ).toThrow(/STRICT_EXPRESSION_TERMINAL_RESOLUTION_CONSERVATION/u);
  });

  it('rejects an invalid hypothesis disposition before an epoch can reach fixpoint', () => {
    const semantic = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1({
        ...semantic.epochInput,
        hypothesisDispositions: [
          // 模拟外部解码输入越过 TS union，不能静默从 Producer 集合丢弃该假设。
          { hypothesisId: 'hypothesis-handler', status: 'not-a-disposition' as never },
        ],
      })
    ).toThrow(/STRICT_ANALYST_HYPOTHESIS_DISPOSITION_INVALID/u);
  });

  it('keeps unknown hypotheses unresolved until the fixpoint gate rejects them', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const enrolledCounterqueryIds = [semantic.executionReceipt.obligationId];
    const counterqueryApplicability = {
      status: 'required' as const,
      reasonCode: 'counterquery-not-yet-executed',
    };
    const review = createReview({
      reviewKind: 'falsification',
      currentAnalysisFixpointHash: semantic.currentAnalysisFixpointHash,
      populationHash: semantic.population.populationHash,
      proposal: {
        reviewKind: 'falsification',
        populationHash: semantic.population.populationHash,
        hypothesisId: 'hypothesis-handler',
        enrolledCounterqueryIds,
        executions: [],
        counterqueryApplicability,
      },
      executionReceipts: [semantic.executionReceipt],
      finalExpandedSchedule: semantic.finalExpandedSchedule,
      terminalObligations: semantic.terminalObligations,
    });
    const epoch = validateStrictAnalystEpochV1({
      ...semantic.epochInput,
      enrolledObligationIds: enrolledCounterqueryIds,
      falsificationInputs: [
        {
          hypothesisId: 'hypothesis-handler',
          enrolledCounterqueryIds,
          executions: [],
          counterqueryApplicability,
          dispositionReview: review,
        },
      ],
      hypothesisDispositions: [{ hypothesisId: 'hypothesis-handler', status: 'unknown' }],
      dispositionReviews: [review],
    });
    expect(epoch.falsifications[0]?.verdict).toBe('unknown');
    expect(epoch.producerEligibleHypotheses).toEqual([]);
    expect(() =>
      createStrictAnalysisFixpointV1({
        finalExpandedSchedule: semantic.finalExpandedSchedule,
        terminalObligations: semantic.terminalObligations,
        epochs: [epoch],
      })
    ).toThrow(/STRICT_ANALYSIS_FIXPOINT_HYPOTHESIS_UNRESOLVED/u);
  });

  it('fails partial populations, string authority, and orphan disposition reviews closed', () => {
    const semantic = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1({
        ...semantic.epochInput,
        population: {
          ...semantic.epochInput.population,
          denominator: {
            ...semantic.epochInput.population.denominator,
            complete: false,
          },
        },
      })
    ).toThrow(/STRICT_ANALYST_POPULATION_INCOMPLETE/u);

    expect(() =>
      validateStrictAnalystEpochV1({
        ...semantic.epochInput,
        hypothesisDispositions: [
          {
            hypothesisId: 'hypothesis-handler',
            status: 'survived',
            reviewerReceiptId: semantic.dispositionReview.reviewReceiptId,
          },
        ],
      } as never)
    ).toThrow(/STRICT_ANALYST_STRING_REVIEW_AUTHORITY_FORBIDDEN/u);

    const orphanReview = createReview({
      reviewKind: 'producer-non-draft',
      currentAnalysisFixpointHash: semantic.currentAnalysisFixpointHash,
      populationHash: semantic.population.populationHash,
      proposal: {
        reviewKind: 'producer-non-draft',
        populationHash: semantic.population.populationHash,
        hypothesisId: 'hypothesis-handler',
        expression: null,
        zeroDisposition: {
          reasonCode: 'orphan-must-not-authorize',
          terminalFate: 'reviewed-non-draft',
        },
      },
      executionReceipts: [semantic.executionReceipt],
      finalExpandedSchedule: semantic.finalExpandedSchedule,
      terminalObligations: semantic.terminalObligations,
    });
    expect(() =>
      validateStrictAnalystEpochV1({
        ...semantic.epochInput,
        dispositionReviews: [semantic.dispositionReview, orphanReview],
      })
    ).toThrow(/STRICT_ANALYST_DISPOSITION_REVIEW_CONSERVATION/u);
  });

  it('uses the exact Core cluster hash and rejects review-context rebound at seal', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const epoch = validateStrictAnalystEpochV1(semantic.epochInput);
    const cluster = epoch.clusterSet.clusters[0];
    const falsificationInput = semantic.epochInput.falsificationInputs[0];
    if (!cluster || !falsificationInput) {
      throw new Error('TEST_STRICT_SEMANTIC_FIXTURE_INCOMPLETE');
    }
    expect(epoch.inductions[0]?.clusterHash).toBe(hashKnowledgeClusterV1(cluster));
    const reboundContextHash = `sha256:${'f'.repeat(64)}`;
    const reboundReview = createReview({
      reviewKind: 'falsification',
      currentAnalysisFixpointHash: reboundContextHash,
      populationHash: semantic.population.populationHash,
      proposal: {
        reviewKind: 'falsification',
        populationHash: semantic.population.populationHash,
        hypothesisId: 'hypothesis-handler',
        enrolledCounterqueryIds: [],
        executions: [],
        counterqueryApplicability: {
          status: 'not-required',
          reasonCode: 'bounded-api-contract',
        },
      },
      executionReceipts: [semantic.executionReceipt],
      finalExpandedSchedule: semantic.finalExpandedSchedule,
      terminalObligations: semantic.terminalObligations,
    });
    const reboundEpoch = validateStrictAnalystEpochV1({
      ...semantic.epochInput,
      currentAnalysisFixpointHash: reboundContextHash,
      falsificationInputs: [
        {
          ...falsificationInput,
          dispositionReview: reboundReview,
        },
      ],
      dispositionReviews: [reboundReview],
    });
    expect(() =>
      createStrictAnalysisFixpointV1({
        finalExpandedSchedule: semantic.finalExpandedSchedule,
        terminalObligations: semantic.terminalObligations,
        epochs: [reboundEpoch],
      })
    ).toThrow(/STRICT_ANALYSIS_FIXPOINT_REVIEW_CONTEXT_MISMATCH/u);
  });

  it.each([
    [
      'cluster id',
      (lineage: StrictProducerLineageReceiptV1) => ({ ...lineage, clusterId: 'cluster-replaced' }),
    ],
    [
      'cluster set',
      (lineage: StrictProducerLineageReceiptV1) => ({
        ...lineage,
        clusterSetHash: 'cluster-set-replaced',
      }),
    ],
    [
      'hypothesis',
      (lineage: StrictProducerLineageReceiptV1) => ({
        ...lineage,
        hypothesis: { ...lineage.hypothesis, hypothesisId: 'hypothesis-replaced' },
      }),
    ],
    [
      'analysis fixpoint',
      (lineage: StrictProducerLineageReceiptV1) => ({
        ...lineage,
        analysisFixpointHash: 'fixpoint-replaced',
      }),
    ],
    [
      'falsification receipt',
      (lineage: StrictProducerLineageReceiptV1) => ({
        ...lineage,
        falsificationReceiptHash: 'falsification-replaced',
      }),
    ],
    [
      'disposition review',
      (lineage: StrictProducerLineageReceiptV1) => ({
        ...lineage,
        dispositionReviewReceiptId: 'review-replaced',
      }),
    ],
    [
      'evidence projection',
      (lineage: StrictProducerLineageReceiptV1) => ({
        ...lineage,
        evidenceProjectionHash: 'evidence-replaced',
      }),
    ],
    [
      'knowledge root',
      (lineage: StrictProducerLineageReceiptV1) => ({
        ...lineage,
        knowledgeRootId: 'caller-controlled-root',
      }),
    ],
  ])('rejects %s substitution even when a caller preserves the old lineage hash', (_label, mutate) => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const forged = mutate(lineage) as StrictProducerLineageReceiptV1;
    expect(() => createSet(forged, initial, 'forged')).toThrow(/STRICT_PRODUCER_LINEAGE_/u);
  });

  it('verifies the complete parent set rather than trusting a caller-supplied parent id', () => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const forgedParent = { ...initial, setId: 'set-from-another-lineage' };
    expect(() => createSet(lineage, forgedParent, 'forged-parent')).toThrow(
      /STRICT_PRODUCER_PARENT_SET_HASH_MISMATCH/u
    );
  });

  it('rejects the former caller-controlled version/depth reset shape', () => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    expect(() =>
      createStrictProducerExpressionSetV1({
        lineage,
        parentSet: null,
        proposals: initial.proposals,
        zeroDisposition: null,
        modelHash: 'producer-model-v1',
        reasonHash: 'attempt-depth-reset',
        version: 2,
        parentSetId: initial.setId,
        repairNode: initial.repairNode,
      } as never)
    ).toThrow(/STRICT_PRODUCER_CALLER_LINEAGE_FIELD_FORBIDDEN/u);
  });
});

function createSetWith(proposal: unknown) {
  const { lineage } = createLineageFixture();
  return createStrictProducerExpressionSetV1({
    lineage,
    parentSet: null,
    proposals: [proposal],
    zeroDisposition: null,
    modelHash: 'producer-fixture',
    reasonHash: 'input-shape-boundary',
  } as CreateStrictProducerExpressionSetInputV1);
}
describe('R07 strict Producer actual model input boundary', () => {
  it.each([
    'not-a-kind',
    '',
    undefined,
  ])('rejects a malformed proposal kind=%j before sealing', (kind) => {
    expect(() => createSetWith({ expressionId: 'expression-1', kind, authored })).toThrow();
  });
  it.each([
    ['negativeIntent', { ...authored, negativeIntent: 'not an array' }],
    ['evidenceEntryIds', { ...authored, evidenceEntryIds: 'E-1' }],
    ['blank evidenceEntryIds', { ...authored, evidenceEntryIds: [''] }],
    ['blank negativeIntent', { ...authored, negativeIntent: [' '] }],
    ['retrievalProfile array', { ...authored, retrievalProfile: [] }],
  ] as const)('rejects malformed authored %s before sealing', (_label, badAuthored) => {
    expect(() =>
      createSetWith({ expressionId: 'expression-1', kind: 'draft', authored: badAuthored })
    ).toThrow();
  });
  it('rejects a whitespace-only merge representative ID', () => {
    expect(() =>
      createSetWith({
        expressionId: 'expression-1',
        kind: 'merge',
        matchingRepresentativeId: ' ',
        authored,
      })
    ).toThrow();
  });
  it('retains valid draft and matching representative proposal shapes', () => {
    expect(createSetWith({ expressionId: 'expression-1', kind: 'draft', authored })).toMatchObject({
      cardinality: 1,
      version: 1,
    });
    expect(
      createSetWith({
        expressionId: 'expression-1',
        kind: 'merge',
        matchingRepresentativeId: 'representative-1',
        authored,
      })
    ).toMatchObject({ cardinality: 1, version: 1 });
  });
});

/**
 * C31：评审侧 createFrozenEvidenceProjection 与 lineage 侧完整性复核共用同一份规范化与哈希。
 * 交叉用例保证宿主经评审冻结的投影在 Producer lineage 中逐字节复核通过；两侧仍保留各自的
 * 既有错误码，宿主日志可据此区分“创建时拒绝”和“跨进程复核拒绝”。
 */
describe('frozen evidence projection is canonicalized once for reviewer and Producer lineage', () => {
  type EvidenceEntry = ReturnType<typeof evidenceEntry>;

  function tamperLineageEvidence(mutate: (entries: EvidenceEntry[]) => EvidenceEntry[]) {
    const { lineageInput } = createLineageFixture([evidenceEntry('E-1'), evidenceEntry('E-2')]);
    return () =>
      createStrictProducerLineageReceiptV1({
        ...lineageInput,
        evidence: {
          ...lineageInput.evidence,
          entries: mutate(lineageInput.evidence.entries.map((entry) => ({ ...entry }))),
        },
      });
  }

  function reviewerProjection(entries: readonly EvidenceEntry[]) {
    return () =>
      createFrozenEvidenceProjection({ sourceRevisionVectorHash: STRICT_SOURCE_REVISION, entries });
  }

  it('accepts every reviewer-frozen projection in the Producer lineage regardless of input order', () => {
    const entries = [
      evidenceEntry('E-z', 'const z = 1;', 9),
      evidenceEntry('E-aa', 'const aa = 1;\nconst ab = 2;', 3),
      evidenceEntry('E-1'),
      evidenceEntry('E-b', 'const b = 1;', 5),
    ];
    const forward = createLineageFixture(entries);
    const reversed = createLineageFixture([...entries].reverse());

    expect(forward.lineageInput.evidence.entries.map((entry) => entry.evidenceEntryId)).toEqual([
      'E-1',
      'E-aa',
      'E-b',
      'E-z',
    ]);
    expect(reversed.lineageInput.evidence.projectionHash).toBe(
      forward.lineageInput.evidence.projectionHash
    );
    expect(forward.lineage.evidenceProjectionHash).toBe(
      forward.lineageInput.evidence.projectionHash
    );
    expect(reversed.lineage.lineageHash).toBe(forward.lineage.lineageHash);
  });

  it.each([
    [
      'content that no longer matches its hash',
      (entries: EvidenceEntry[]) => [{ ...entries[0], content: 'tampered' } as EvidenceEntry],
      /^STRICT_REVIEW_EVIDENCE_CONTENT_HASH_MISMATCH: E-1$/u,
      /^STRICT_PRODUCER_LINEAGE_EVIDENCE_CONTENT_HASH_MISMATCH: E-1$/u,
    ],
    [
      'a line range that does not cover the content',
      (entries: EvidenceEntry[]) => [
        { ...evidenceEntry('E-1', 'line 1\nline 2'), endLine: 1 },
        ...entries.slice(1),
      ],
      /^STRICT_REVIEW_EVIDENCE_RANGE_CONTENT_MISMATCH: E-1$/u,
      /^STRICT_PRODUCER_LINEAGE_EVIDENCE_RANGE_INVALID: E-1$/u,
    ],
    [
      'a non-positive start line',
      (entries: EvidenceEntry[]) => [{ ...entries[0], startLine: 0 } as EvidenceEntry],
      /^STRICT_REVIEW_EVIDENCE_RANGE_INVALID: E-1$/u,
      /^STRICT_PRODUCER_LINEAGE_EVIDENCE_RANGE_INVALID: E-1$/u,
    ],
    [
      'a blank relative path',
      (entries: EvidenceEntry[]) => [{ ...entries[0], relativePath: ' ' } as EvidenceEntry],
      /^STRICT_REVIEW_RELATIVEPATH_REQUIRED$/u,
      /^STRICT_PRODUCER_LINEAGE_EVIDENCE_RELATIVEPATH_REQUIRED$/u,
    ],
    [
      'a duplicated evidence id',
      (entries: EvidenceEntry[]) => [evidenceEntry('E-2'), ...entries.slice(1)],
      /^STRICT_REVIEW_EVIDENCE_ID_DUPLICATE$/u,
      /^STRICT_PRODUCER_LINEAGE_EVIDENCE_ID_DUPLICATE$/u,
    ],
    [
      'non-string content',
      (entries: EvidenceEntry[]) => [
        { ...entries[0], content: 42 as unknown as string } as EvidenceEntry,
        ...entries.slice(1),
      ],
      /^STRICT_REVIEW_EVIDENCE_CONTENT_HASH_MISMATCH: E-1$/u,
      /^STRICT_PRODUCER_LINEAGE_EVIDENCE_CONTENT_HASH_MISMATCH: E-1$/u,
    ],
    [
      'a non-string evidence id',
      (entries: EvidenceEntry[]) => [
        ...entries.slice(1),
        { ...entries[0], evidenceEntryId: 7 as unknown as string } as EvidenceEntry,
      ],
      /^STRICT_REVIEW_EVIDENCEENTRYID_REQUIRED$/u,
      /^STRICT_PRODUCER_LINEAGE_EVIDENCE_EVIDENCEENTRYID_REQUIRED$/u,
    ],
  ] as const)('keeps each side error code for %s', (_label, mutate, reviewerCode, lineageCode) => {
    const entries = [evidenceEntry('E-1'), evidenceEntry('E-2')];
    expect(reviewerProjection(mutate(entries.map((entry) => ({ ...entry }))))).toThrow(
      reviewerCode
    );
    expect(tamperLineageEvidence(mutate)).toThrow(lineageCode);
  });

  it('rejects a recomputed projection hash that does not match the canonical entries', () => {
    const { lineageInput } = createLineageFixture([evidenceEntry('E-1'), evidenceEntry('E-2')]);
    expect(() =>
      createStrictProducerLineageReceiptV1({
        ...lineageInput,
        evidence: { ...lineageInput.evidence, projectionHash: 'caller-recomputed' },
      })
    ).toThrow(/^STRICT_PRODUCER_LINEAGE_EVIDENCE_PROJECTION_HASH_MISMATCH$/u);
  });
});

/**
 * C24：模型 JSON 在进入核心校验前先做形状守卫。缺字段或元素为 null 时得到带字段路径的
 * STRICT_*_INPUT_SHAPE_INVALID，而不是无码 TypeError；处置行只投影契约字段，模型附加的
 * 自由文本不再进入 epochHash。
 */
describe('strict Analyst and Producer model input shape guards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ANALYST_ARRAY_FIELDS = [
    'clusterInputs',
    'nonClusteredDispositions',
    'inductionInputs',
    'falsificationInputs',
    'hypothesisDispositions',
    'dispositionReviews',
  ] as const;

  it.each(ANALYST_ARRAY_FIELDS)('rejects a missing %s array with a coded shape error', (field) => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    const { [field]: _omitted, ...input } = epochInput;
    expect(() => validateStrictAnalystEpochV1(input as never)).toThrow(
      new RegExp(`^STRICT_ANALYST_INPUT_SHAPE_INVALID: ${field}$`, 'u')
    );
  });

  it.each(ANALYST_ARRAY_FIELDS)('rejects a null %s element with a coded shape error', (field) => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    expect(() => validateStrictAnalystEpochV1({ ...epochInput, [field]: [null] } as never)).toThrow(
      new RegExp(`^STRICT_ANALYST_INPUT_SHAPE_INVALID: ${field}\\[0\\]$`, 'u')
    );
  });

  it('rejects a non-object Analyst input root', () => {
    expect(() => validateStrictAnalystEpochV1(null as never)).toThrow(
      /^STRICT_ANALYST_INPUT_SHAPE_INVALID: input$/u
    );
  });

  it.each([
    [
      'a falsification without counterqueryApplicability',
      'falsificationInputs[0].counterqueryApplicability',
      (row: Record<string, unknown>) => {
        const { counterqueryApplicability: _omitted, ...rest } = row;
        return rest;
      },
    ],
    [
      'a falsification whose executions is not an array',
      'falsificationInputs[0].executions',
      (row: Record<string, unknown>) => ({ ...row, executions: 'none' }),
    ],
    [
      'a falsification whose enrolled counterqueries is not an array',
      'falsificationInputs[0].enrolledCounterqueryIds',
      (row: Record<string, unknown>) => ({ ...row, enrolledCounterqueryIds: null }),
    ],
    [
      'a falsification execution without counterexample facts',
      'falsificationInputs[0].executions[0].counterexampleFactIds',
      (row: Record<string, unknown>) => ({ ...row, executions: [{ obligationId: 'q-1' }] }),
    ],
    [
      'a falsification without its host-sealed review',
      'falsificationInputs[0].dispositionReview',
      (row: Record<string, unknown>) => {
        const { dispositionReview: _omitted, ...rest } = row;
        return rest;
      },
    ],
  ] as const)('rejects %s', (_label, path, mutate) => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    const [falsification] = epochInput.falsificationInputs;
    expect(() =>
      validateStrictAnalystEpochV1({
        ...epochInput,
        falsificationInputs: [mutate({ ...falsification } as Record<string, unknown>)],
      } as never)
    ).toThrow(new RegExp(`^STRICT_ANALYST_INPUT_SHAPE_INVALID: ${escapeRegExp(path)}$`, 'u'));
  });

  it.each([
    [
      'an induction without hypotheses',
      'inductionInputs[0].hypotheses',
      (row: Record<string, unknown>) => {
        const { hypotheses: _omitted, ...rest } = row;
        return rest;
      },
    ],
    [
      'a null hypothesis',
      'inductionInputs[0].hypotheses[0]',
      (row: Record<string, unknown>) => ({ ...row, hypotheses: [null] }),
    ],
    [
      'a hypothesis without premise facts',
      'inductionInputs[0].hypotheses[0].premiseFactIds',
      (row: Record<string, unknown>) => ({
        ...row,
        hypotheses: [{ hypothesisId: 'hypothesis-handler', statement: 'no premises' }],
      }),
    ],
  ] as const)('rejects %s', (_label, path, mutate) => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    const [induction] = epochInput.inductionInputs;
    expect(() =>
      validateStrictAnalystEpochV1({
        ...epochInput,
        inductionInputs: [mutate({ ...induction } as Record<string, unknown>)],
      } as never)
    ).toThrow(new RegExp(`^STRICT_ANALYST_INPUT_SHAPE_INVALID: ${escapeRegExp(path)}$`, 'u'));
  });

  it.each([
    ['hypothesisId', { hypothesisId: 7, status: 'survived' }],
    ['hypothesisId', { hypothesisId: ' ', status: 'survived' }],
    [
      'causalParentHypothesisId',
      { hypothesisId: 'hypothesis-handler', status: 'survived', causalParentHypothesisId: 42 },
    ],
  ] as const)('rejects a disposition row whose %s has the wrong shape', (field, row) => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1({ ...epochInput, hypothesisDispositions: [row] } as never)
    ).toThrow(
      new RegExp(
        `^STRICT_ANALYST_INPUT_SHAPE_INVALID: hypothesisDispositions\\[0\\]\\.${field}$`,
        'u'
      )
    );
  });

  it('projects disposition rows to contract fields so model extras do not change epochHash', () => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    const baseline = validateStrictAnalystEpochV1(epochInput);
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const withNotes = validateStrictAnalystEpochV1({
      ...epochInput,
      hypothesisDispositions: [
        { hypothesisId: 'hypothesis-handler', status: 'survived', notes: 'model commentary' },
      ],
    } as never);
    expect(withNotes.epochHash).toBe(baseline.epochHash);
    expect(withNotes.hypothesisDispositions).toEqual([
      { hypothesisId: 'hypothesis-handler', status: 'survived' },
    ]);
    expect(() => assertStrictAnalystEpochIntegrity(withNotes)).not.toThrow();
    expect(info).toHaveBeenCalledWith(
      '[StrictAnalyst] hypothesis dispositions projected to contract fields',
      expect.objectContaining({
        droppedFields: ['notes'],
        nullParentHypothesisIds: [],
        selectedPath: 'project-contract-fields',
      })
    );
  });

  it('treats an explicit null causal parent as omitted and logs the normalization', () => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    const baseline = validateStrictAnalystEpochV1(epochInput);
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const withNullParent = validateStrictAnalystEpochV1({
      ...epochInput,
      hypothesisDispositions: [
        { hypothesisId: 'hypothesis-handler', status: 'survived', causalParentHypothesisId: null },
      ],
    } as never);
    expect(withNullParent.epochHash).toBe(baseline.epochHash);
    expect(withNullParent.hypothesisDispositions).toEqual([
      { hypothesisId: 'hypothesis-handler', status: 'survived' },
    ]);
    expect(info).toHaveBeenCalledWith(
      '[StrictAnalyst] hypothesis dispositions projected to contract fields',
      expect.objectContaining({
        droppedFields: [],
        nullParentHypothesisIds: ['hypothesis-handler'],
      })
    );
  });

  it('keeps contract-shaped dispositions untouched and does not log', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const info = vi.spyOn(Logger.getInstance(), 'info');
    // narrowed 的父假设必须是本 epoch 内真实存在且仍成立的假设（C23），这里用同 cluster 的 survived 根假设。
    const epoch = validateStrictAnalystEpochV1(
      createMultiHypothesisEpochInput(
        semantic,
        [
          { hypothesisId: 'hypothesis-handler', outcome: 'not-required' },
          { hypothesisId: 'hypothesis-root', outcome: 'not-required' },
        ],
        [
          {
            hypothesisId: 'hypothesis-handler',
            status: 'narrowed',
            causalParentHypothesisId: 'hypothesis-root',
          },
          { hypothesisId: 'hypothesis-root', status: 'survived' },
        ]
      )
    );
    expect(epoch.hypothesisDispositions).toEqual([
      {
        hypothesisId: 'hypothesis-handler',
        status: 'narrowed',
        causalParentHypothesisId: 'hypothesis-root',
      },
      { hypothesisId: 'hypothesis-root', status: 'survived' },
    ]);
    expect(epoch.producerEligibleHypotheses[0]).toMatchObject({
      status: 'narrowed',
      causalParentHypothesisId: 'hypothesis-root',
    });
    expect(info).not.toHaveBeenCalledWith(
      '[StrictAnalyst] hypothesis dispositions projected to contract fields',
      expect.anything()
    );
  });

  it.each([
    ['a null proposal', null],
    ['an array proposal', []],
    ['a string proposal', 'expression-1'],
  ])('rejects %s with a coded Producer shape error', (_label, proposal) => {
    expect(() => createSetWith(proposal)).toThrow(
      /^STRICT_PRODUCER_INPUT_SHAPE_INVALID: proposals\[0\]$/u
    );
  });

  it('rejects a non-object zero disposition and a non-object Producer input root', () => {
    const { lineage } = createLineageFixture();
    expect(() =>
      createStrictProducerExpressionSetV1({
        lineage,
        parentSet: null,
        proposals: [],
        zeroDisposition: 'not-an-object',
        modelHash: 'producer-fixture',
        reasonHash: 'zero-shape',
      } as never)
    ).toThrow(/^STRICT_PRODUCER_INPUT_SHAPE_INVALID: zeroDisposition$/u);
    expect(() => createStrictProducerExpressionSetV1(null as never)).toThrow(
      /^STRICT_PRODUCER_INPUT_SHAPE_INVALID: input$/u
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function createSetWithProposals(proposals: readonly unknown[]) {
  const { lineage } = createLineageFixture();
  return createStrictProducerExpressionSetV1({
    lineage,
    parentSet: null,
    proposals,
    zeroDisposition: null,
    modelHash: 'producer-fixture',
    reasonHash: 'expression-identity',
  } as CreateStrictProducerExpressionSetInputV1);
}

/**
 * C33：expressionId 以原值判重并原样进入 setHash 与终态收据，所以不静默 trim，而是拒绝首尾
 * 空白；重复 ID 得到专用码而不是通用的 STRICT_ID_SET_INVALID。
 */
describe('strict Producer expression identity', () => {
  it('rejects duplicate expression ids with the dedicated duplicate code', () => {
    expect(() =>
      createSetWithProposals([
        { expressionId: 'expression-1', kind: 'draft', authored },
        {
          expressionId: 'expression-1',
          kind: 'draft',
          authored: { ...authored, title: 'Another title' },
        },
      ])
    ).toThrow(/^STRICT_PRODUCER_EXPRESSION_DUPLICATE: expression-1$/u);
  });

  it.each([
    ' expression-1',
    'expression-1 ',
    '',
    '   ',
    42,
    undefined,
  ])('rejects expressionId %j instead of trimming it into a different identity', (expressionId) => {
    expect(() => createSetWithProposals([{ expressionId, kind: 'draft', authored }])).toThrow(
      /^STRICT_PRODUCER_EXPRESSION_ID_INVALID: proposals\[0\]$/u
    );
  });

  it('rejects a padded id that would collide with a clean id after trimming', () => {
    expect(() =>
      createSetWithProposals([
        { expressionId: 'expression-1', kind: 'draft', authored },
        { expressionId: ' expression-1', kind: 'draft', authored: { ...authored, title: 'B' } },
      ])
    ).toThrow(/^STRICT_PRODUCER_EXPRESSION_ID_INVALID: proposals\[1\]$/u);
  });

  it('keeps clean expression ids verbatim in the sealed set', () => {
    const set = createSetWithProposals([
      { expressionId: 'expression-b', kind: 'draft', authored },
      { expressionId: 'expression-a', kind: 'draft', authored: { ...authored, title: 'A' } },
    ]);
    expect(set.proposals.map((proposal) => proposal.expressionId)).toEqual([
      'expression-a',
      'expression-b',
    ]);
  });
});

/**
 * C32：因果修复节点按 createCausalRepairNodeV1 的派生规则复核身份，表达集复核节点与 lineage
 * 的结构绑定；跨进程改写 nodeId/rootIds/stage 并重算外层 hash 都不能自证。
 */
describe('causal repair node integrity re-derives node identity and set structure', () => {
  function deriveNodeId(node: Omit<CausalRepairNodeV1, 'nodeHash'>): string {
    return hashCanonical({
      kind: 'strict-causal-repair-node-v1',
      rootIds: node.rootIds,
      parentNodeIds: node.parentNodeIds,
      stage: node.stage,
      lineageHash: node.lineageHash,
      inputHash: node.inputHash,
      outputHash: node.outputHash,
    });
  }

  function resealNode(
    node: CausalRepairNodeV1,
    overrides: Record<string, unknown>,
    recomputeNodeId = true
  ): CausalRepairNodeV1 {
    const { nodeHash: _hash, ...semantic } = { ...node, ...overrides } as CausalRepairNodeV1;
    const withId = recomputeNodeId ? { ...semantic, nodeId: deriveNodeId(semantic) } : semantic;
    return { ...withId, nodeHash: hashCanonical(withId) } as CausalRepairNodeV1;
  }

  function resealSet(
    set: StrictProducerExpressionSetV1,
    repairNode: CausalRepairNodeV1
  ): StrictProducerExpressionSetV1 {
    const { setHash: _hash, ...semantic } = { ...set, repairNode };
    return { ...semantic, setHash: hashCanonical(semantic) } as StrictProducerExpressionSetV1;
  }

  function sealReceipt(set: StrictProducerExpressionSetV1) {
    return () =>
      createStrictHypothesisExpressionSetReceiptV1({
        expressionSet: set,
        parentReceipt: null,
        privateCorpusRevision: 'revision:repair-node',
        terminalHead: true,
        terminalResolutions: set.proposals.map((proposal) => ({
          expressionId: proposal.expressionId,
          terminalFate: 'content-ready' as const,
          terminalReceiptId: `g2:${proposal.expressionId}`,
          terminalReceiptHash: `sha256:${'9'.repeat(64)}`,
        })),
      });
  }

  it('accepts nodes produced by createCausalRepairNodeV1', () => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const repair1 = createSet(lineage, initial, 'repair-1');
    expect(() => assertCausalRepairNodeIntegrity(initial.repairNode)).not.toThrow();
    expect(() => assertCausalRepairNodeIntegrity(repair1.repairNode)).not.toThrow();
    expect(repair1.repairNode.parentNodeIds).toEqual([initial.repairNode.nodeId]);
    expect(sealReceipt(initial)).not.toThrow();
  });

  it('rejects a parent set whose rootIds were rewritten with only nodeHash and setHash recomputed', () => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const forgedNode = resealNode(initial.repairNode, { rootIds: ['forged-root'] }, false);
    expect(() => assertCausalRepairNodeIntegrity(forgedNode)).toThrow(
      /^STRICT_CAUSAL_NODE_ID_MISMATCH$/u
    );
    expect(() =>
      createSet(lineage, resealSet(initial, forgedNode), 'child-of-forged-root')
    ).toThrow(/^STRICT_CAUSAL_NODE_ID_MISMATCH$/u);
  });

  it('rejects a caller-chosen nodeId even when nodeHash is recomputed', () => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    expect(() =>
      assertCausalRepairNodeIntegrity(
        resealNode(initial.repairNode, { nodeId: 'caller-chosen-node' }, false)
      )
    ).toThrow(/^STRICT_CAUSAL_NODE_ID_MISMATCH$/u);
  });

  it.each([
    ['an unknown stage', { stage: 'planner' }, /^STRICT_CAUSAL_STAGE_INVALID$/u],
    ['empty rootIds', { rootIds: [] }, /^STRICT_CAUSAL_ROOT_IDS_INVALID$/u],
    ['padded rootIds', { rootIds: [' padded-root'] }, /^STRICT_CAUSAL_ROOT_IDS_INVALID$/u],
    [
      'unsorted parentNodeIds',
      { parentNodeIds: ['node-b', 'node-a'], semanticRepairDepth: 1 },
      /^STRICT_CAUSAL_PARENT_NODE_IDS_INVALID$/u,
    ],
    [
      'a root node that claims parents',
      { parentNodeIds: ['ghost-parent'] },
      /^STRICT_CAUSAL_REPAIR_DEPTH_INVALID$/u,
    ],
    [
      'a child depth without parents',
      { semanticRepairDepth: 1 },
      /^STRICT_CAUSAL_REPAIR_DEPTH_INVALID$/u,
    ],
    [
      'a depth beyond the repair limit',
      { parentNodeIds: ['ghost-parent'], semanticRepairDepth: 3 },
      /^STRICT_CAUSAL_REPAIR_DEPTH_INVALID$/u,
    ],
    ['a blank model hash', { modelHash: ' ' }, /^STRICT_CAUSAL_MODELHASH_REQUIRED$/u],
  ] as const)('rejects a fully resealed node with %s', (_label, overrides, code) => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    expect(() =>
      assertCausalRepairNodeIntegrity(resealNode(initial.repairNode, overrides))
    ).toThrow(code);
  });

  it.each([
    ['rootIds detached from the lineage root', { rootIds: ['forged-root'] }],
    ['a non-producer stage', { stage: 'analyst' }],
  ] as const)('rejects a fully resealed version-1 set with %s', (_label, overrides) => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const forged = resealSet(initial, resealNode(initial.repairNode, overrides));
    expect(() => assertCausalRepairNodeIntegrity(forged.repairNode)).not.toThrow();
    expect(sealReceipt(forged)).toThrow(/^STRICT_PRODUCER_PARENT_SET_REPAIR_STRUCTURE_MISMATCH$/u);
    expect(() => createSet(lineage, forged, 'child-of-forged')).toThrow(
      /^STRICT_PRODUCER_PARENT_SET_REPAIR_STRUCTURE_MISMATCH$/u
    );
  });

  it('rejects a fully resealed repair set that claims more than its single predecessor', () => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const repair1 = createSet(lineage, initial, 'repair-1');
    const forged = resealSet(
      repair1,
      resealNode(repair1.repairNode, {
        parentNodeIds: [...repair1.repairNode.parentNodeIds, 'ghost-parent'].sort(),
      })
    );
    expect(() => assertCausalRepairNodeIntegrity(forged.repairNode)).not.toThrow();
    expect(() => createSet(lineage, forged, 'child-of-forged')).toThrow(
      /^STRICT_PRODUCER_PARENT_SET_REPAIR_STRUCTURE_MISMATCH$/u
    );
  });
});

/**
 * C29（U50-F12）：严格链中此前没有精确断言的 fail-closed 分支。每条用例只篡改一处并断言
 * 精确错误码，防止后续重构把这些分支从 fail-closed 改成静默放行。
 */
describe('strict lineage, expression receipt and Analyst disposition fail-closed branches', () => {
  function rebuildContext(
    context: StrictAnalysisContextProjectionV1,
    overrides: Record<string, unknown>
  ): StrictAnalysisContextProjectionV1 {
    const { schemaVersion: _version, contextHash: _hash, ...input } = context;
    return createStrictAnalysisContextProjectionV1({ ...input, ...overrides } as never);
  }

  it('rejects an evidence projection with an unsupported schema version', () => {
    const { lineageInput } = createLineageFixture();
    expect(() =>
      createStrictProducerLineageReceiptV1({
        ...lineageInput,
        evidence: { ...lineageInput.evidence, schemaVersion: 2 as never },
      })
    ).toThrow(/^STRICT_PRODUCER_LINEAGE_EVIDENCE_VERSION_MISMATCH$/u);
  });

  it('rejects an evidence projection without a source revision', () => {
    const { lineageInput } = createLineageFixture();
    expect(() =>
      createStrictProducerLineageReceiptV1({
        ...lineageInput,
        evidence: { ...lineageInput.evidence, sourceRevisionVectorHash: ' ' },
      })
    ).toThrow(/^STRICT_PRODUCER_LINEAGE_EVIDENCE_SOURCE_REQUIRED$/u);
  });

  it('rejects evidence entries that are not the context evidence set', () => {
    const { lineageInput } = createLineageFixture();
    expect(() =>
      createStrictProducerLineageReceiptV1({
        ...lineageInput,
        context: rebuildContext(lineageInput.context, { evidenceEntryIds: ['E-other'] }),
      })
    ).toThrow(/^STRICT_PRODUCER_LINEAGE_EVIDENCE_BINDING_MISMATCH$/u);
  });

  it('rejects a context bound to another analysis fixpoint', () => {
    const { lineageInput } = createLineageFixture();
    expect(() =>
      createStrictProducerLineageReceiptV1({
        ...lineageInput,
        context: rebuildContext(lineageInput.context, {
          analysisFixpointHash: `sha256:${'e'.repeat(64)}`,
        }),
      })
    ).toThrow(/^STRICT_PRODUCER_LINEAGE_FIXPOINT_BINDING_MISMATCH$/u);
  });

  it('rejects evidence frozen under another source revision', () => {
    const { lineageInput } = createLineageFixture();
    expect(() =>
      createStrictProducerLineageReceiptV1({
        ...lineageInput,
        evidence: createFrozenEvidenceProjection({
          sourceRevisionVectorHash: `sha256:${'2'.repeat(64)}`,
          entries: [evidenceEntry('E-1')],
        }),
      })
    ).toThrow(/^STRICT_PRODUCER_LINEAGE_FIXPOINT_BINDING_MISMATCH$/u);
  });

  it.each([
    ['POPULATION', { populationHashes: [`sha256:${'3'.repeat(64)}`] }],
    ['CLUSTER_SET', { clusterSetHashes: ['cluster-set-other'] }],
    ['INDUCTION', { inductionReceiptHashes: ['induction-other'] }],
    ['HYPOTHESIS', { hypothesisIds: ['hypothesis-other'] }],
    ['FALSIFICATION', { falsificationReceiptHashes: ['falsification-other'] }],
    ['DISPOSITION_REVIEW', { dispositionReviewIds: ['review-other'] }],
  ] as const)('rejects a context that does not carry the %s authority', (code, overrides) => {
    const { lineageInput } = createLineageFixture();
    expect(() =>
      createStrictProducerLineageReceiptV1({
        ...lineageInput,
        context: rebuildContext(lineageInput.context, overrides),
      })
    ).toThrow(new RegExp(`^STRICT_PRODUCER_LINEAGE_${code}_BINDING_MISMATCH$`, 'u'));
  });

  it('rejects a terminal receipt whose parent receipt does not match the predecessor set', () => {
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const repair1 = createSet(lineage, initial, 'repair-1');
    const resolutions = (set: StrictProducerExpressionSetV1) =>
      set.proposals.map((proposal) => ({
        expressionId: proposal.expressionId,
        terminalFate: 'content-ready' as const,
        terminalReceiptId: `g2:${proposal.expressionId}`,
        terminalReceiptHash: `sha256:${'9'.repeat(64)}`,
      }));
    const parentReceipt = createStrictHypothesisExpressionSetReceiptV1({
      expressionSet: initial,
      parentReceipt: null,
      privateCorpusRevision: 'revision:chain',
      terminalHead: false,
      terminalResolutions: resolutions(initial),
    });
    const seal = (overrides: {
      readonly expressionSet: StrictProducerExpressionSetV1;
      readonly parentReceipt: typeof parentReceipt | null;
      readonly privateCorpusRevision: string;
    }) =>
      createStrictHypothesisExpressionSetReceiptV1({
        ...overrides,
        terminalHead: true,
        terminalResolutions: resolutions(overrides.expressionSet),
      });
    expect(
      seal({ expressionSet: repair1, parentReceipt, privateCorpusRevision: 'revision:chain' })
    ).toMatchObject({ version: 2, parentReceiptId: parentReceipt.receiptId });
    for (const invalid of [
      { expressionSet: repair1, parentReceipt: null, privateCorpusRevision: 'revision:chain' },
      { expressionSet: repair1, parentReceipt, privateCorpusRevision: 'revision:other' },
      { expressionSet: initial, parentReceipt, privateCorpusRevision: 'revision:chain' },
    ]) {
      expect(() => seal(invalid)).toThrow(/^STRICT_EXPRESSION_PARENT_RECEIPT_MISMATCH$/u);
    }
  });

  it('rejects zero-expression reviews of the wrong kind or for another reason', () => {
    const { analysisFixpoint, lineage, semantic } = createLineageFixture();
    const zeroReview = (input: {
      readonly reviewKind: 'producer-non-draft' | 'falsification';
      readonly reasonCode: string;
    }) =>
      createReview({
        reviewKind: input.reviewKind,
        currentAnalysisFixpointHash: analysisFixpoint.fixpointHash,
        populationHash: semantic.population.populationHash,
        proposal: {
          reviewKind: 'producer-non-draft',
          populationHash: semantic.population.populationHash,
          hypothesisId: 'hypothesis-handler',
          expression: null,
          zeroDisposition: { reasonCode: input.reasonCode, terminalFate: 'reviewed-non-draft' },
        },
        executionReceipts: [semantic.executionReceipt],
        finalExpandedSchedule: semantic.finalExpandedSchedule,
        terminalObligations: semantic.terminalObligations,
      });
    const createZero = (dispositionReview: ReturnType<typeof zeroReview>) => () =>
      createStrictProducerExpressionSetV1({
        lineage,
        parentSet: null,
        proposals: [],
        zeroDisposition: { reasonCode: 'not-actionable-as-recipe', authored, dispositionReview },
        modelHash: 'producer-model-v1',
        reasonHash: 'zero-expression',
      });
    expect(
      createZero(
        zeroReview({ reviewKind: 'producer-non-draft', reasonCode: 'not-actionable-as-recipe' })
      )
    ).not.toThrow();
    expect(
      createZero(
        zeroReview({ reviewKind: 'falsification', reasonCode: 'not-actionable-as-recipe' })
      )
    ).toThrow(/^STRICT_PRODUCER_ZERO_REVIEW_INVALID$/u);
    expect(
      createZero(zeroReview({ reviewKind: 'producer-non-draft', reasonCode: 'another-reason' }))
    ).toThrow(/^STRICT_PRODUCER_ZERO_REVIEW_INVALID$/u);
  });

  it.each([
    ['without a parent', { hypothesisId: 'hypothesis-handler', status: 'narrowed' }],
    [
      'with an explicit null parent',
      { hypothesisId: 'hypothesis-handler', status: 'narrowed', causalParentHypothesisId: null },
    ],
  ] as const)('rejects a narrowed hypothesis %s', (_label, row) => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1({ ...epochInput, hypothesisDispositions: [row] } as never)
    ).toThrow(/^STRICT_ANALYST_NARROWING_PARENT_REQUIRED: hypothesis-handler$/u);
  });

  it('rejects a declared disposition review bound to another analysis context', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const foreignReview = createReview({
      reviewKind: 'falsification',
      currentAnalysisFixpointHash: `sha256:${'f'.repeat(64)}`,
      populationHash: semantic.population.populationHash,
      proposal: {
        reviewKind: 'falsification',
        populationHash: semantic.population.populationHash,
        hypothesisId: 'hypothesis-handler',
        enrolledCounterqueryIds: [],
        executions: [],
        counterqueryApplicability: { status: 'not-required', reasonCode: 'foreign-context' },
      },
      executionReceipts: [semantic.executionReceipt],
      finalExpandedSchedule: semantic.finalExpandedSchedule,
      terminalObligations: semantic.terminalObligations,
    });
    expect(() =>
      validateStrictAnalystEpochV1({
        ...semantic.epochInput,
        dispositionReviews: [semantic.dispositionReview, foreignReview],
      })
    ).toThrow(/^STRICT_ANALYST_DISPOSITION_REVIEW_BINDING_MISMATCH$/u);
  });
});

type StrictSemanticFixture = ReturnType<typeof createSingleHypothesisEpochFixture>;
type StrictFalsificationOutcome = 'not-required' | 'refuted' | 'unknown';

/**
 * 在单假设夹具的同一 review context 上为任意假设生成宿主封印的 falsification 输入：
 * - not-required：不登记反查，verdict 为 not-required（与夹具原有假设相同）；
 * - refuted：以 handler 执行收据作反查并命中 population 内的 fact-handler；
 * - unknown：登记 handler 反查但不执行，verdict 为 unknown。
 * cluster set 不随假设数量变化，因此夹具的 currentAnalysisFixpointHash 仍可直接用于 fixpoint。
 */
function createFalsificationFor(
  semantic: StrictSemanticFixture,
  hypothesisId: string,
  outcome: StrictFalsificationOutcome
): StrictAnalystEpochInputV1['falsificationInputs'][number] {
  const receipt = semantic.executionReceipt;
  const enrolledCounterqueryIds = outcome === 'not-required' ? [] : [receipt.obligationId];
  const executions =
    outcome === 'refuted'
      ? [
          {
            counterqueryId: receipt.obligationId,
            obligationId: receipt.obligationId,
            executionReceipt: receipt,
            counterexampleFactIds: ['fact-handler'],
          },
        ]
      : [];
  const counterqueryApplicability =
    outcome === 'not-required'
      ? { status: 'not-required' as const, reasonCode: 'bounded-api-contract' }
      : { status: 'required' as const, reasonCode: `counterquery-${outcome}` };
  const dispositionReview = createReview({
    reviewKind: 'falsification',
    currentAnalysisFixpointHash: semantic.currentAnalysisFixpointHash,
    populationHash: semantic.population.populationHash,
    proposal: {
      reviewKind: 'falsification',
      populationHash: semantic.population.populationHash,
      hypothesisId,
      enrolledCounterqueryIds,
      executions: executions.map((execution) => ({
        counterqueryId: execution.counterqueryId,
        obligationId: execution.obligationId,
        executionReceiptHash: execution.executionReceipt.receiptHash,
        executionOutputHash: execution.executionReceipt.outputHash,
        denominatorHash: execution.executionReceipt.denominatorHash,
        counterexampleFactIds: execution.counterexampleFactIds,
      })),
      counterqueryApplicability,
    },
    executionReceipts: [receipt],
    finalExpandedSchedule: semantic.finalExpandedSchedule,
    terminalObligations: semantic.terminalObligations,
  });
  return {
    hypothesisId,
    enrolledCounterqueryIds,
    executions,
    counterqueryApplicability,
    dispositionReview,
  };
}

/** 同一 cluster 上的多假设 epoch 输入：每个假设各有一条 falsification 与对应的封印审查回执。 */
function createMultiHypothesisEpochInput(
  semantic: StrictSemanticFixture,
  rows: readonly { readonly hypothesisId: string; readonly outcome: StrictFalsificationOutcome }[],
  hypothesisDispositions: StrictAnalystEpochInputV1['hypothesisDispositions']
): StrictAnalystEpochInputV1 {
  const [induction] = semantic.epochInput.inductionInputs;
  if (!induction) {
    throw new Error('TEST_STRICT_SEMANTIC_FIXTURE_INCOMPLETE');
  }
  const falsificationInputs = rows.map((row) =>
    createFalsificationFor(semantic, row.hypothesisId, row.outcome)
  );
  return {
    ...semantic.epochInput,
    inductionInputs: [
      {
        ...induction,
        hypotheses: rows.map((row) => ({
          hypothesisId: row.hypothesisId,
          statement: `Handlers preserve the typed Result envelope (${row.hypothesisId})`,
          premiseFactIds: ['fact-handler'],
        })),
      },
    ],
    falsificationInputs,
    hypothesisDispositions,
    dispositionReviews: falsificationInputs.map((row) => row.dispositionReview),
  };
}

/** 改写 epoch 的语义字段后按外层规则重算 epochHash，模拟跨进程收到的“自证”篡改 epoch。 */
function resealEpoch(
  epoch: StrictAnalystEpochV1,
  overrides: Partial<StrictAnalystEpochV1>
): StrictAnalystEpochV1 {
  const { epochHash: _hash, ...semantic } = { ...epoch, ...overrides };
  return { ...semantic, epochHash: hashCanonical(semantic) };
}

describe('strict Analyst premise and counterexample facts stay within the population (C22)', () => {
  function withPremises(
    semantic: StrictSemanticFixture,
    knownFactIds: readonly string[],
    premiseFactIds: readonly string[]
  ): StrictAnalystEpochInputV1 {
    const [induction] = semantic.epochInput.inductionInputs;
    if (!induction) {
      throw new Error('TEST_STRICT_SEMANTIC_FIXTURE_INCOMPLETE');
    }
    return {
      ...semantic.epochInput,
      knownFactIds,
      inductionInputs: [
        {
          ...induction,
          hypotheses: [
            {
              hypothesisId: 'hypothesis-handler',
              statement: 'Handlers preserve the typed Result envelope',
              premiseFactIds,
            },
          ],
        },
      ],
    };
  }

  it('rejects at first validation a premise fact the host knows but the population lacks', () => {
    const semantic = createSingleHypothesisEpochFixture();
    // 修复前：首次校验通过，直到 fixpoint/lineage 重建才误报 STRICT_ANALYST_HYPOTHESIS_FACT_INVENTED。
    expect(() =>
      validateStrictAnalystEpochV1(
        withPremises(semantic, ['fact-handler', 'fact-extra'], ['fact-handler', 'fact-extra'])
      )
    ).toThrow(/^STRICT_ANALYST_HYPOTHESIS_FACT_OUTSIDE_POPULATION: hypothesis-handler$/u);
  });

  it('keeps reporting a premise fact the host never executed as invented', () => {
    const semantic = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1(
        withPremises(semantic, ['fact-handler'], ['fact-handler', 'fact-ghost'])
      )
    ).toThrow(/^STRICT_ANALYST_HYPOTHESIS_FACT_INVENTED: hypothesis-handler$/u);
  });

  it('accepts a wider host fact set whose premises stay in the population and seals it at fixpoint', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const baseline = validateStrictAnalystEpochV1(semantic.epochInput);
    const epoch = validateStrictAnalystEpochV1(
      withPremises(semantic, ['fact-handler', 'fact-extra'], ['fact-handler'])
    );
    expect(epoch.epochHash).toBe(baseline.epochHash);
    expect(() => assertStrictAnalystEpochIntegrity(epoch)).not.toThrow();
    expect(() =>
      createStrictAnalysisFixpointV1({
        finalExpandedSchedule: semantic.finalExpandedSchedule,
        terminalObligations: semantic.terminalObligations,
        epochs: [epoch],
      })
    ).not.toThrow();
  });

  it('rejects at first validation a counterexample fact outside the population', () => {
    const semantic = createSingleHypothesisEpochFixture();
    // 反查是独立登记的 obligation，其收据产出的 fact-counter 宿主已知，但不是 population 观测事实。
    const counterReceipt = createExecutionReceipt({
      name: 'counter',
      emittedFactIds: ['fact-counter'],
    });
    const receipts = [semantic.executionReceipt, counterReceipt];
    const finalExpandedSchedule = createFinalExpandedMiningScheduleReceiptV1({
      baselineScheduleHash: `sha256:${'a'.repeat(64)}`,
      baselineObligationIds: receipts.map((receipt) => receipt.obligationId),
      expansionReceipts: [],
    });
    const terminalObligations = receipts.map((receipt) => ({
      obligationId: receipt.obligationId,
      disposition: receipt.disposition,
      terminalReceiptId: receipt.terminalReceiptId,
    }));
    const currentAnalysisFixpointHash = createAnalysisReviewContextHashV1({
      finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
      terminalObligations,
      populationHashes: [semantic.population.populationHash],
      clusterSetHashes: [semantic.clusterSet.clusterSetHash],
    });
    const enrolledCounterqueryIds = [counterReceipt.obligationId];
    const executions = [
      {
        counterqueryId: counterReceipt.obligationId,
        obligationId: counterReceipt.obligationId,
        executionReceipt: counterReceipt,
        counterexampleFactIds: ['fact-counter'],
      },
    ];
    const counterqueryApplicability = {
      status: 'required' as const,
      reasonCode: 'counterquery-executed',
    };
    const dispositionReview = createReview({
      reviewKind: 'falsification',
      currentAnalysisFixpointHash,
      populationHash: semantic.population.populationHash,
      proposal: {
        reviewKind: 'falsification',
        populationHash: semantic.population.populationHash,
        hypothesisId: 'hypothesis-handler',
        enrolledCounterqueryIds,
        executions: executions.map((execution) => ({
          counterqueryId: execution.counterqueryId,
          obligationId: execution.obligationId,
          executionReceiptHash: counterReceipt.receiptHash,
          executionOutputHash: counterReceipt.outputHash,
          denominatorHash: counterReceipt.denominatorHash,
          counterexampleFactIds: execution.counterexampleFactIds,
        })),
        counterqueryApplicability,
      },
      executionReceipts: [counterReceipt],
      finalExpandedSchedule,
      terminalObligations,
    });
    expect(() =>
      validateStrictAnalystEpochV1({
        ...semantic.epochInput,
        currentAnalysisFixpointHash,
        knownFactIds: ['fact-handler', 'fact-counter'],
        enrolledObligationIds: receipts.map((receipt) => receipt.obligationId),
        falsificationInputs: [
          {
            hypothesisId: 'hypothesis-handler',
            enrolledCounterqueryIds,
            executions,
            counterqueryApplicability,
            dispositionReview,
          },
        ],
        hypothesisDispositions: [{ hypothesisId: 'hypothesis-handler', status: 'refuted' }],
        dispositionReviews: [dispositionReview],
      })
    ).toThrow(/^STRICT_ANALYST_COUNTEREXAMPLE_FACT_OUTSIDE_POPULATION: hypothesis-handler$/u);
  });

  it('accepts a population counterexample and rebuilds the refuted epoch with the same facts', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const epoch = validateStrictAnalystEpochV1(
      createMultiHypothesisEpochInput(
        semantic,
        [{ hypothesisId: 'hypothesis-handler', outcome: 'refuted' }],
        [{ hypothesisId: 'hypothesis-handler', status: 'refuted' }]
      )
    );
    expect(epoch.falsifications[0]?.verdict).toBe('refuted');
    expect(epoch.producerEligibleHypotheses).toEqual([]);
    expect(() => assertStrictAnalystEpochIntegrity(epoch)).not.toThrow();
  });
});

describe('strict Analyst causal parent hypotheses stay inside the epoch (C23)', () => {
  const ROOT_AND_HANDLER = (rootOutcome: StrictFalsificationOutcome) =>
    [
      { hypothesisId: 'hypothesis-handler', outcome: 'not-required' },
      { hypothesisId: 'hypothesis-root', outcome: rootOutcome },
    ] as const;

  it.each([
    ['an empty', ''],
    ['a whitespace-only', ' '],
    ['a tab-only', '\t'],
  ])('rejects a narrowed hypothesis with %s parent id', (_label, parent) => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1({
        ...epochInput,
        hypothesisDispositions: [
          {
            hypothesisId: 'hypothesis-handler',
            status: 'narrowed',
            causalParentHypothesisId: parent,
          },
        ],
      })
    ).toThrow(/^STRICT_ANALYST_CAUSAL_PARENT_BLANK: hypothesis-handler$/u);
  });

  it('rejects a narrowed hypothesis that names itself as its causal parent', () => {
    const { epochInput } = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1({
        ...epochInput,
        hypothesisDispositions: [
          {
            hypothesisId: 'hypothesis-handler',
            status: 'narrowed',
            causalParentHypothesisId: 'hypothesis-handler',
          },
        ],
      })
    ).toThrow(/^STRICT_ANALYST_CAUSAL_PARENT_SELF_REFERENCE: hypothesis-handler$/u);
  });

  it.each([
    ['a parent outside this epoch', 'ghost-hypothesis'],
    ['a padded parent id that only matches after trimming', ' hypothesis-root '],
  ])('rejects a narrowed hypothesis with %s', (_label, parent) => {
    const semantic = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1(
        createMultiHypothesisEpochInput(semantic, ROOT_AND_HANDLER('not-required'), [
          {
            hypothesisId: 'hypothesis-handler',
            status: 'narrowed',
            causalParentHypothesisId: parent,
          },
          { hypothesisId: 'hypothesis-root', status: 'survived' },
        ])
      )
    ).toThrow(/^STRICT_ANALYST_CAUSAL_PARENT_UNKNOWN: hypothesis-handler$/u);
  });

  it.each([
    'refuted',
    'unknown',
  ] as const)('rejects a narrowed hypothesis whose parent is %s', (parentStatus) => {
    const semantic = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1(
        createMultiHypothesisEpochInput(semantic, ROOT_AND_HANDLER(parentStatus), [
          {
            hypothesisId: 'hypothesis-handler',
            status: 'narrowed',
            causalParentHypothesisId: 'hypothesis-root',
          },
          { hypothesisId: 'hypothesis-root', status: parentStatus },
        ])
      )
    ).toThrow(/^STRICT_ANALYST_CAUSAL_PARENT_INELIGIBLE: hypothesis-handler$/u);
  });

  it.each([
    ['an in-epoch', 'hypothesis-root'],
    ['a dangling', 'ghost-hypothesis'],
  ])('rejects a survived hypothesis that carries %s causal parent', (_label, parent) => {
    const semantic = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1(
        createMultiHypothesisEpochInput(semantic, ROOT_AND_HANDLER('not-required'), [
          {
            hypothesisId: 'hypothesis-handler',
            status: 'survived',
            causalParentHypothesisId: parent,
          },
          { hypothesisId: 'hypothesis-root', status: 'survived' },
        ])
      )
    ).toThrow(/^STRICT_ANALYST_SURVIVED_CAUSAL_PARENT_FORBIDDEN: hypothesis-handler$/u);
  });

  it('validates a causal parent carried by a refuted hypothesis the same way', () => {
    const semantic = createSingleHypothesisEpochFixture();
    expect(() =>
      validateStrictAnalystEpochV1(
        createMultiHypothesisEpochInput(
          semantic,
          [{ hypothesisId: 'hypothesis-handler', outcome: 'refuted' }],
          [
            {
              hypothesisId: 'hypothesis-handler',
              status: 'refuted',
              causalParentHypothesisId: 'ghost-hypothesis',
            },
          ]
        )
      )
    ).toThrow(/^STRICT_ANALYST_CAUSAL_PARENT_UNKNOWN: hypothesis-handler$/u);
  });

  it('accepts a narrowing chain over surviving in-epoch parents and seals it at fixpoint', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const epoch = validateStrictAnalystEpochV1(
      createMultiHypothesisEpochInput(
        semantic,
        [
          { hypothesisId: 'hypothesis-handler', outcome: 'not-required' },
          { hypothesisId: 'hypothesis-middle', outcome: 'not-required' },
          { hypothesisId: 'hypothesis-root', outcome: 'not-required' },
        ],
        [
          {
            hypothesisId: 'hypothesis-handler',
            status: 'narrowed',
            causalParentHypothesisId: 'hypothesis-middle',
          },
          {
            hypothesisId: 'hypothesis-middle',
            status: 'narrowed',
            causalParentHypothesisId: 'hypothesis-root',
          },
          { hypothesisId: 'hypothesis-root', status: 'survived' },
        ]
      )
    );
    expect(
      epoch.producerEligibleHypotheses.map((hypothesis) => [
        hypothesis.hypothesisId,
        hypothesis.status,
        hypothesis.causalParentHypothesisId ?? null,
      ])
    ).toEqual([
      ['hypothesis-handler', 'narrowed', 'hypothesis-middle'],
      ['hypothesis-middle', 'narrowed', 'hypothesis-root'],
      ['hypothesis-root', 'survived', null],
    ]);
    expect(() => assertStrictAnalystEpochIntegrity(epoch)).not.toThrow();
    expect(() =>
      createStrictAnalysisFixpointV1({
        finalExpandedSchedule: semantic.finalExpandedSchedule,
        terminalObligations: semantic.terminalObligations,
        epochs: [epoch],
      })
    ).not.toThrow();
  });

  it('rejects a resealed epoch whose causal parent was rewritten to a dangling id', () => {
    const semantic = createSingleHypothesisEpochFixture();
    const epoch = validateStrictAnalystEpochV1(
      createMultiHypothesisEpochInput(semantic, ROOT_AND_HANDLER('not-required'), [
        {
          hypothesisId: 'hypothesis-handler',
          status: 'narrowed',
          causalParentHypothesisId: 'hypothesis-root',
        },
        { hypothesisId: 'hypothesis-root', status: 'survived' },
      ])
    );
    const dangling = 'ghost-hypothesis';
    const tampered = resealEpoch(epoch, {
      hypothesisDispositions: epoch.hypothesisDispositions.map((row) =>
        row.hypothesisId === 'hypothesis-handler'
          ? { ...row, causalParentHypothesisId: dangling }
          : row
      ),
      producerEligibleHypotheses: epoch.producerEligibleHypotheses.map((row) =>
        row.hypothesisId === 'hypothesis-handler'
          ? { ...row, causalParentHypothesisId: dangling }
          : row
      ),
    });
    // 外层 epochHash 已按篡改内容重算；重建必须重新执行父假设校验，而不是接受自证哈希。
    expect(() => assertStrictAnalystEpochIntegrity(tampered)).toThrow(
      /^STRICT_ANALYST_CAUSAL_PARENT_UNKNOWN: hypothesis-handler$/u
    );
    expect(() =>
      createStrictAnalysisFixpointV1({
        finalExpandedSchedule: semantic.finalExpandedSchedule,
        terminalObligations: semantic.terminalObligations,
        epochs: [tampered],
      })
    ).toThrow(/^STRICT_ANALYST_CAUSAL_PARENT_UNKNOWN: hypothesis-handler$/u);
    // Producer lineage 入口在任何绑定检查之前先做 epoch 完整性重建，悬空父假设到不了 hypothesisHash。
    const { lineageInput } = createLineageFixture();
    expect(() =>
      createStrictProducerLineageReceiptV1({ ...lineageInput, epoch: tampered })
    ).toThrow(/^STRICT_ANALYST_CAUSAL_PARENT_UNKNOWN: hypothesis-handler$/u);
  });
});
