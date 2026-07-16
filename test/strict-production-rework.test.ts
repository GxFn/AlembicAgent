import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFrozenEvidenceProjection } from '../src/agent/evaluation/IndependentValueReviewer.js';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  type StrictProducerLineageReceiptV1,
  validateStrictAnalystEpochV1,
} from '../src/agent/production/StrictProductionPipeline.js';

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
  const expansion = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: 'schedule-1',
    baselineObligationIds: ['base-1'],
    knownFactFamilies: [
      { id: 'syntax-patterns', capabilityId: 'facts.syntax', supportedScales: ['file'] },
    ],
    knownSubjectRefs: ['file:handler'],
    obligationCap: 2,
  });
  const epoch = validateStrictAnalystEpochV1({
    knownFactIds: ['fact-handler'],
    enrolledObligationIds: expansion.seal().obligationIds,
    population: {
      populationId: 'population-handler',
      revision: 1,
      parentPopulationHash: null,
      sourceRevisionVectorHash: 'vector-1',
      denominator: {
        kind: 'frozen-complete-subjects',
        expectedObservationIds: ['observation-handler'],
      },
      observations: [
        {
          observationId: 'observation-handler',
          factIds: ['fact-handler'],
          mechanismKey: 'typed-result-envelope',
          canonicalSubjectRefs: ['file:handler'],
        },
      ],
      duplicateObservations: [],
      excludedObservations: [],
      errorObservations: [],
    },
    clusterInputs: [
      {
        mechanismKey: 'typed-result-envelope',
        observationIds: ['observation-handler'],
        anatomyLensIds: ['error-recovery-concurrency'],
      },
    ],
    nonClusteredDispositions: [],
    inductionInputs: [
      {
        mechanismKey: 'typed-result-envelope',
        mode: 'bounded-singleton',
        hypotheses: [
          {
            hypothesisId: 'hypothesis-handler',
            statement: 'Handlers preserve the typed Result envelope',
            premiseFactIds: ['fact-handler'],
          },
        ],
      },
    ],
    falsificationInputs: [
      {
        hypothesisId: 'hypothesis-handler',
        enrolledCounterqueryIds: [],
        executions: [],
        counterqueryApplicability: {
          status: 'not-required',
          reasonCode: 'bounded-api-contract',
          reviewerReceiptId: 'counterquery-review-1',
        },
      },
    ],
    hypothesisDispositions: [
      {
        hypothesisId: 'hypothesis-handler',
        status: 'survived',
        reviewerReceiptId: 'hypothesis-review-1',
      },
    ],
  });
  const analysisFixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule: expansion.seal(),
    terminalObligations: [
      { obligationId: 'base-1', disposition: 'matched', terminalReceiptId: 'terminal-base-1' },
    ],
    epochs: [epoch],
  });
  const context = createStrictAnalysisContextProjectionV1({
    runId: 'run-1',
    journalId: 'journal-1',
    manifestHash: 'manifest-1',
    planCognitionHash: 'plan-cognition-1',
    planHash: 'plan-1',
    requiredUniverseHash: 'universe-1',
    baselineScheduleHash: 'schedule-1',
    expansionHeadHash: null,
    currentExpandedScheduleHash: expansion.seal().finalExpandedScheduleHash,
    finalExpandedScheduleHash: expansion.seal().finalExpandedScheduleHash,
    analysisFixpointHash: analysisFixpoint.fixpointHash,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: 'lens-1',
    sourceArtifactHash: 'artifact-1',
    sourceRevisionVectorHash: 'vector-1',
    questionIds: ['question-1'],
    factQueryObligationIds: ['base-1'],
    analysisUnitIds: ['unit-1'],
    factIds: ['fact-handler'],
    witnessIds: ['witness-handler'],
    populationHashes: [epoch.population.populationHash],
    clusterSetHashes: [epoch.clusterSet.clusterSetHash],
    inductionReceiptHashes: epoch.inductions.map((receipt) => receipt.receiptHash),
    hypothesisIds: ['hypothesis-handler'],
    falsificationReceiptHashes: epoch.falsifications.map((receipt) => receipt.receiptHash),
    dispositionReviewIds: ['hypothesis-review-1'],
    evidenceEntryIds: ['E-1'],
    derivedFindingCount: 0,
  });
  const content = 'export function handle(): Result<void> { return Result.ok(); }';
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: 'vector-1',
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
  return { lineage };
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
    const { lineage } = createLineageFixture();
    const initial = createSet(lineage, null, 'initial');
    const repair1 = createSet(lineage, initial, 'repair-1');
    const repair2 = createSet(lineage, repair1, 'repair-2');

    expect(initial).toMatchObject({ version: 1, parentSetId: null });
    expect(repair1).toMatchObject({ version: 2, parentSetId: initial.setId });
    expect(repair2).toMatchObject({ version: 3, parentSetId: repair1.setId });
    expect(initial.repairNode.rootIds).toEqual([lineage.knowledgeRootId]);
    expect(repair2.repairNode.rootIds).toEqual(initial.repairNode.rootIds);
    expect(() => createSet(lineage, repair2, 'repair-3')).toThrow(/STRICT_CAUSAL_REPAIR_LIMIT/u);

    const zero = createStrictProducerExpressionSetV1({
      lineage,
      parentSet: null,
      proposals: [],
      zeroDisposition: {
        reasonCode: 'not-actionable-as-recipe',
        authored,
        reviewerReceiptId: 'zero-review-1',
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
