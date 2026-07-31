import { createHash } from 'node:crypto';
import {
  assertFactQueryExecutionReceiptV1,
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAnalysisReviewContextHashV1,
  createFinalExpandedMiningScheduleReceiptV1,
  createKnowledgeDispositionReviewV1,
  createProductionActorIdentityV1,
  type FactQueryExecutionReceiptV1,
  hashKnowledgeDispositionProposalV1,
  type KnowledgeDispositionProposalV1,
} from '@alembic/core/production';
import type { StrictAnalystEpochInputV1 } from '../../src/agent/production/StrictProductionPipeline.js';

export const STRICT_SOURCE_REVISION = `sha256:${'1'.repeat(64)}`;

export function createExecutionReceipt(input: {
  readonly name: string;
  readonly emittedFactIds: readonly string[];
  readonly canonicalSubjectRef?: string;
  readonly disposition?: FactQueryExecutionReceiptV1['disposition'];
  readonly relativePath?: string;
  readonly blobHash?: string;
  readonly evidenceEntryId?: string;
  readonly projectContextRefId?: string;
  readonly witnessBindingHash?: string;
  readonly backendProducer?: string;
  readonly analysisScale?: FactQueryExecutionReceiptV1['analysisScale'];
  readonly harvestKey?: string;
  readonly harvestReceiptHash?: string;
}): FactQueryExecutionReceiptV1 {
  const disposition = input.disposition ?? 'matched';
  const relativePath = input.relativePath ?? `src/${input.name}.ts`;
  const blobHash = input.blobHash ?? `sha256:${'9'.repeat(64)}`;
  const canonicalSubjectRef = input.canonicalSubjectRef ?? `file:repo:${relativePath}`;
  const evidenceEntryId = input.evidenceEntryId ?? `E-${input.name}`;
  const projectContextRefId = input.projectContextRefId ?? canonicalSubjectRef;
  const witnessBindingHash = input.witnessBindingHash ?? `sha256:${'0'.repeat(64)}`;
  const obligationSemantic = {
    factFamilyId: 'syntax-idiom',
    capabilityId: 'tree-sitter-query',
    canonicalSubjectRef,
    analysisScale: input.analysisScale ?? ('file' as const),
    denominator: 'complete-frozen-subject' as const,
  };
  const obligationId = `fact:${hashCanonical(obligationSemantic).slice(7, 31)}`;
  const denominatorFileIds = [`repo:${relativePath}@${blobHash}`];
  const fileExecutionSemantic = {
    repoId: 'repo',
    relativePath,
    blobHash,
    status: 'complete' as const,
    reasonCode: 'COMPLETE',
    truncated: false,
    continuation: null,
    witnessBindingHash,
    evidenceEntryId,
    projectContextRefId,
    stagedFactIds: [...input.emittedFactIds].sort(),
    discardedFactIds: [] as string[],
    emittedFactIds: [...input.emittedFactIds].sort(),
  };
  const fileExecution = {
    ...fileExecutionSemantic,
    executionHash: hashCanonical(fileExecutionSemantic),
  };
  const outputSemantic = {
    obligationId,
    denominatorHash: hashCanonical(denominatorFileIds),
    fileExecutionHashes: [fileExecution.executionHash],
    derivedFactIds: [] as string[],
    emittedFactIds: [...input.emittedFactIds].sort(),
    disposition,
    truncated: false,
    continuation: null,
  };
  const outputHash = hashCanonical(outputSemantic);
  const semantic = {
    schemaVersion: 1 as const,
    obligationId,
    ...obligationSemantic,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    backendProducer: input.backendProducer ?? 'loaded:test',
    backendManifestHash: `sha256:${'b'.repeat(64)}`,
    backendLoadReceiptHash: `sha256:${'c'.repeat(64)}`,
    queryPackHash: `sha256:${'d'.repeat(64)}`,
    harvestKey: input.harvestKey ?? `sha256:${'e'.repeat(64)}`,
    harvestReceiptHash: input.harvestReceiptHash ?? `sha256:${'f'.repeat(64)}`,
    expectedFileCount: 1,
    inspectedFileCount: 1,
    denominatorFileIds,
    denominatorHash: hashCanonical(denominatorFileIds),
    witnessBindingHash: hashCanonical([witnessBindingHash]),
    fileExecutions: [fileExecution],
    derivedFactIds: [] as string[],
    emittedFactIds: [...input.emittedFactIds].sort(),
    disposition,
    reasonCode: 'COMPLETE_FROZEN_SUBJECT_INSPECTED',
    truncated: false,
    continuation: null,
    outputHash,
  };
  const receiptHash = hashCanonical(semantic);
  const receipt: FactQueryExecutionReceiptV1 = {
    ...semantic,
    terminalReceiptId: `fact-execution:${receiptHash.slice(7, 31)}`,
    receiptHash,
  };
  assertFactQueryExecutionReceiptV1(receipt);
  return receipt;
}

export function createActors(runId = 'run:agent-strict-semantic') {
  const create = (role: 'producer' | 'reviewer') =>
    createProductionActorIdentityV1({
      providerId: 'provider:frozen',
      modelId: 'model:strict-v1',
      modelVersion: '2026-07-27',
      promptHash: `sha256:${role === 'producer' ? '3' : '4'}`.padEnd(
        71,
        role === 'producer' ? '3' : '4'
      ),
      runId,
      invocationId: `invocation:${role}`,
      loadReceiptHash: `sha256:${role === 'producer' ? '5' : '6'}`.padEnd(
        71,
        role === 'producer' ? '5' : '6'
      ),
      outputHash: `sha256:${role === 'producer' ? '7' : '8'}`.padEnd(
        71,
        role === 'producer' ? '7' : '8'
      ),
    });
  return { producer: create('producer'), reviewer: create('reviewer') };
}

export function createSingleHypothesisEpochFixture() {
  const executionReceipt = createExecutionReceipt({
    name: 'handler',
    emittedFactIds: ['fact-handler'],
  });
  const { clusterInputs, clusterSet, population, populationInput } =
    createSingleHypothesisPopulation(executionReceipt);
  const {
    applicability,
    currentAnalysisFixpointHash,
    dispositionReview,
    finalExpandedSchedule,
    terminalObligations,
  } = createSingleHypothesisReviewAuthority(executionReceipt, population, clusterSet);
  const epochInput: StrictAnalystEpochInputV1 = {
    currentAnalysisFixpointHash,
    knownFactIds: ['fact-handler'],
    enrolledObligationIds: [executionReceipt.obligationId],
    population: populationInput,
    clusterInputs,
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
        counterqueryApplicability: applicability,
        dispositionReview,
      },
    ],
    hypothesisDispositions: [
      {
        hypothesisId: 'hypothesis-handler',
        status: 'survived',
      },
    ],
    dispositionReviews: [dispositionReview],
  };
  return {
    executionReceipt,
    population,
    clusterSet,
    finalExpandedSchedule,
    terminalObligations,
    currentAnalysisFixpointHash,
    dispositionReview,
    epochInput,
  };
}

function createSingleHypothesisPopulation(executionReceipt: FactQueryExecutionReceiptV1) {
  const populationInput = {
    populationId: 'population-handler',
    revision: 1,
    parentPopulationHash: null,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    denominator: {
      kind: 'frozen-complete-subjects' as const,
      expectedObservationIds: ['observation-handler'],
      expectedObligationIds: [executionReceipt.obligationId],
      executionReceiptHashes: [executionReceipt.receiptHash],
      outputHashes: [executionReceipt.outputHash],
      denominatorHashes: [executionReceipt.denominatorHash],
      complete: true,
      truncated: false,
      continuation: null,
      omittedObservationIds: [],
    },
    executionReceipts: [executionReceipt],
    observations: [
      {
        observationId: 'observation-handler',
        factIds: ['fact-handler'],
        obligationIds: [executionReceipt.obligationId],
        mechanismKey: 'typed-result-envelope',
        canonicalSubjectRefs: [executionReceipt.canonicalSubjectRef],
        parentSubjectRefs: ['repo:repo'],
        variantKeys: ['typed-result'],
        outlierReasonCodes: [],
        negativeControl: false,
      },
    ],
    duplicateObservations: [],
    excludedObservations: [],
    errorObservations: [],
    inspectedNoPatternObservations: [],
  };
  const population = canonicalizeObservationPopulationV1(populationInput);
  const clusterInputs = [
    {
      mechanismKey: 'typed-result-envelope',
      mechanism: { invariant: 'handlers preserve typed Result envelopes' },
      observationIds: ['observation-handler'],
      mechanismEvidenceFactIds: ['fact-handler'],
      anatomyLensIds: ['error-recovery-concurrency'] as const,
    },
  ];
  const clusterSet = canonicalizeKnowledgeClustersV1(population, {
    clusters: clusterInputs,
    nonClusteredDispositions: [],
  });
  return { clusterInputs, clusterSet, population, populationInput };
}

function createSingleHypothesisReviewAuthority(
  executionReceipt: FactQueryExecutionReceiptV1,
  population: ReturnType<typeof canonicalizeObservationPopulationV1>,
  clusterSet: ReturnType<typeof canonicalizeKnowledgeClustersV1>
) {
  const finalExpandedSchedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: `sha256:${'a'.repeat(64)}`,
    baselineObligationIds: [executionReceipt.obligationId],
    expansionReceipts: [],
  });
  const terminalObligations = [
    {
      obligationId: executionReceipt.obligationId,
      disposition: executionReceipt.disposition,
      terminalReceiptId: executionReceipt.terminalReceiptId,
    },
  ];
  const currentAnalysisFixpointHash = createAnalysisReviewContextHashV1({
    finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
    terminalObligations,
    populationHashes: [population.populationHash],
    clusterSetHashes: [clusterSet.clusterSetHash],
  });
  const applicability = {
    status: 'not-required' as const,
    reasonCode: 'bounded-api-contract',
  };
  const proposal = {
    reviewKind: 'falsification' as const,
    populationHash: population.populationHash,
    hypothesisId: 'hypothesis-handler',
    enrolledCounterqueryIds: [],
    executions: [],
    counterqueryApplicability: applicability,
  };
  const dispositionReview = createReview({
    reviewKind: 'falsification',
    currentAnalysisFixpointHash,
    populationHash: population.populationHash,
    proposal,
    executionReceipts: [executionReceipt],
    finalExpandedSchedule,
    terminalObligations,
  });
  return {
    applicability,
    currentAnalysisFixpointHash,
    dispositionReview,
    finalExpandedSchedule,
    terminalObligations,
  };
}

export function createReview(input: {
  readonly reviewKind: Parameters<typeof createKnowledgeDispositionReviewV1>[0]['reviewKind'];
  readonly currentAnalysisFixpointHash: string;
  readonly populationHash: string;
  readonly proposal: KnowledgeDispositionProposalV1;
  readonly executionReceipts: readonly FactQueryExecutionReceiptV1[];
  readonly finalExpandedSchedule: Parameters<
    typeof createKnowledgeDispositionReviewV1
  >[0]['finalExpandedSchedule'];
  readonly terminalObligations: Parameters<
    typeof createKnowledgeDispositionReviewV1
  >[0]['terminalObligations'];
}) {
  return createKnowledgeDispositionReviewV1({
    reviewKind: input.reviewKind,
    currentAnalysisFixpointHash: input.currentAnalysisFixpointHash,
    populationHash: input.populationHash,
    proposedDispositionHash: hashKnowledgeDispositionProposalV1(input.proposal),
    executionReceipts: input.executionReceipts,
    finalExpandedSchedule: input.finalExpandedSchedule,
    terminalObligations: input.terminalObligations,
    ...createActors(),
    calibrationReceiptHash: `sha256:${'c'.repeat(64)}`,
    verdict: 'pass',
    reasonCode: 'independent-semantic-review',
  });
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortCanonical(value)))
    .digest('hex')}`;
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
