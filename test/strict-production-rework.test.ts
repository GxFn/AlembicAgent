import { createHash } from 'node:crypto';
import { hashKnowledgeClusterV1 } from '@alembic/core/production';
import { describe, expect, it } from 'vitest';
import { createFrozenEvidenceProjection } from '../src/agent/evaluation/IndependentValueReviewer.js';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisFixpointV1,
  createStrictHypothesisExpressionSetReceiptV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  type StrictProducerLineageReceiptV1,
  validateStrictAnalystEpochV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import {
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

function createLineageFixture() {
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
    evidenceEntryIds: ['E-1'],
    derivedFindingCount: 0,
  });
  const content = 'export function handle(): Result<void> { return Result.ok(); }';
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    entries: [
      {
        evidenceEntryId: 'E-1',
        relativePath: 'src/handler.ts',
        blobHash: 'blob-handler',
        contentHash: sha256(content),
        startLine: 1,
        endLine: 1,
        content,
      },
    ],
  });
  const lineage = createStrictProducerLineageReceiptV1({
    context,
    epoch,
    analysisFixpoint,
    hypothesisId: 'hypothesis-handler',
    evidence,
  });
  return { analysisFixpoint, lineage, semantic };
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
