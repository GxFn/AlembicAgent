import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createStrictEvidenceLedgerSnapshotV1,
  type StrictFactDirectWitnessBindingV1,
} from '@alembic/core/host-agent-workflows';
import {
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  consumeMainSemanticDispositionReviewDurableAttestationV5,
  createAgentSemanticDispositionReviewRequestV1,
  createAnalysisFixpointReceiptV1,
  createAnalysisReviewContextHashV1,
  createFactRecordV1,
  createFinalExpandedMiningScheduleReceiptV1,
  createProductionActorIdentityV1,
  createStrictAcceptedCorpusInspectionV1,
  createStrictAdmissionReceiptV1,
  createStrictG1ReceiptV1,
  hashKnowledgeDispositionProposalV1,
  type KnowledgeClusterSetV1,
  type SemanticDispositionReviewerModelLoadReceiptV1,
  type SemanticDispositionReviewRequestV1,
  STRICT_G1_HARD_AXES_V1,
  validateHypothesisExpressionSetReceiptV1,
} from '@alembic/core/production';
import { createProjectContextFileRef } from '@alembic/core/project-context';

import {
  createStrictAnalysisFixpointV1,
  validateStrictAnalystEpochV1,
} from '../../src/agent/production/StrictProductionPipeline.js';
import type { StrictTestDimensionAgentAuthorityV1 } from '../../src/agent/production/StrictTestDimensionAgentContract.js';
import { DiagnosticsCollector } from '../../src/agent/runtime/DiagnosticsCollector.js';
import {
  createDurableSemanticReviewRuntime,
  type SemanticReviewWitnessAuthorityBundleV1,
} from '../../src/evaluation.js';
import { createProductionEvidenceLedgerAuthority } from '../../src/production.js';
import {
  createExecutionReceipt,
  createReview,
  STRICT_SOURCE_REVISION,
} from './strict-semantic-authority.js';

const REVIEWER_AXES = [
  'empty-population-consistency',
  'fixpoint-population-execution-lineage',
  'frozen-semantic-evidence-grounding',
  'negative-evidence-sufficiency',
  'reviewer-independence',
  'sealed-schedule-terminal-denominator',
  'verdict-sufficiency',
] as const;
const PRODUCER_REVIEWER_AXES = [
  'admission-comparison-completeness',
  'fixpoint-population-execution-lineage',
  'frozen-semantic-evidence-grounding',
  'hypothesis-falsification-context',
  'reviewer-independence',
  'target-disposition-consistency',
  'verdict-sufficiency',
] as const;

export interface PreparedStrictTestDurableEvidence {
  readonly mode: 'accepted' | 'investigated-empty';
  readonly dataRoot: string;
  readonly ledgerAuthority: ReturnType<typeof createProductionEvidenceLedgerAuthority>;
  readonly evidenceEntry: ReturnType<
    ReturnType<typeof createProductionEvidenceLedgerAuthority>['capture']['capture']
  >;
  readonly evidenceLedgerSnapshot: ReturnType<typeof createStrictEvidenceLedgerSnapshotV1>;
  readonly witnessBinding: StrictFactDirectWitnessBindingV1;
  readonly executionReceipt: ReturnType<typeof createExecutionReceipt>;
  readonly facts: readonly ReturnType<typeof createFactRecordV1>[];
  dispose(): void;
}

export function prepareStrictTestDurableEvidence(
  mode: PreparedStrictTestDurableEvidence['mode']
): PreparedStrictTestDurableEvidence {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-agent-strict-test-review-'));
  const ledgerAuthority = createProductionEvidenceLedgerAuthority({
    dataRoot,
    jobId: 'job:strict-test-review',
    sessionId: 'session:strict-test-review',
    dimensionId: 'architecture',
  });
  const relativePath = 'src/strict-test-review.ts';
  const blobHash = sha('strict-test-review-source');
  const content =
    mode === 'accepted'
      ? 'export function preserveTypedResult() { return { ok: true }; }'
      : 'export const noEligibleMechanism = true;';
  const evidenceEntry = ledgerAuthority.capture.capture({
    tool: 'code.read',
    callId: `call:strict-test-review:${mode}`,
    file: relativePath,
    content,
  });
  const evidenceLedgerSnapshot = createStrictEvidenceLedgerSnapshotV1([evidenceEntry]);
  const projectContextRef = createProjectContextFileRef({
    projectRoot: '/frozen/project',
    repoId: 'repo',
    filePath: relativePath,
    hash: blobHash,
  });
  const witnessSemantic = {
    schemaVersion: 1 as const,
    sourceArtifactId: 'artifact:strict-test-review',
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    repoId: 'repo',
    relativePath,
    blobHash,
    evidenceEntryId: evidenceEntry.id,
    evidenceSessionId: evidenceEntry.sessionId,
    evidenceContentHash: evidenceEntry.contentHash,
    evidenceEntryHash: hash(evidenceEntry),
    evidenceEntry,
    evidenceLedgerSnapshotHash: evidenceLedgerSnapshot.snapshotHash,
    projectContextRefId: projectContextRef.id,
    projectContextRefHash: hash(projectContextRef),
    projectContextRef,
  };
  const witnessBinding: StrictFactDirectWitnessBindingV1 = {
    ...witnessSemantic,
    bindingHash: hash(witnessSemantic),
  };
  const facts =
    mode === 'accepted'
      ? [
          createFactRecordV1({
            factFamilyId: 'syntax-idiom',
            canonicalSubjectRef: projectContextRef.id,
            primaryScale: 'file',
            sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
            value: { mechanism: 'typed-result-envelope' },
            witnesses: [
              {
                kind: 'direct',
                evidenceEntryId: evidenceEntry.id,
                evidenceSessionId: evidenceEntry.sessionId,
                evidenceContentHash: evidenceEntry.contentHash,
                sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
                projectContextRefId: projectContextRef.id,
                projectContextRefHash: hash(projectContextRef),
                canonicalSubjectRef: projectContextRef.id,
                anchor: { relativePath, blobHash },
              },
            ],
          }),
        ]
      : [];
  const executionReceipt = createExecutionReceipt({
    name: `strict-test-review:${mode}`,
    emittedFactIds: facts.map((fact) => fact.factId),
    disposition: mode === 'accepted' ? 'matched' : 'inspected-no-pattern',
    relativePath,
    blobHash,
    evidenceEntryId: evidenceEntry.id,
    projectContextRefId: projectContextRef.id,
    witnessBindingHash: witnessBinding.bindingHash,
  });
  return {
    mode,
    dataRoot,
    ledgerAuthority,
    evidenceEntry,
    evidenceLedgerSnapshot,
    witnessBinding,
    executionReceipt,
    facts,
    dispose: () => rmSync(dataRoot, { force: true, recursive: true }),
  };
}

export async function createStrictTestDurableReviewEvidence(
  prepared: PreparedStrictTestDurableEvidence,
  authority: StrictTestDimensionAgentAuthorityV1
) {
  if (
    authority.sourceRevisionVectorHash !== STRICT_SOURCE_REVISION ||
    !authority.compiledPlan.schedule.factHarvestObligations.some(
      (row) => row.obligationId === prepared.executionReceipt.obligationId
    )
  ) {
    throw new Error('STRICT_TEST_DURABLE_FIXTURE_AUTHORITY_MISMATCH');
  }
  return prepared.mode === 'accepted'
    ? createAcceptedEvidence(prepared, authority)
    : createInvestigatedEmptyEvidence(prepared, authority);
}

async function createAcceptedEvidence(
  prepared: PreparedStrictTestDurableEvidence,
  authority: StrictTestDimensionAgentAuthorityV1
) {
  const analysis = createAcceptedAnalysis(prepared, authority);
  const producer = await createAcceptedProducerReview(prepared, authority, analysis);
  return {
    ...producer,
    finalExpandedSchedule: analysis.finalExpandedSchedule,
    analysisFixpoint: analysis.analysisFixpoint,
    clusterSets: [analysis.clusterSet],
  };
}

function createAcceptedPopulation(prepared: PreparedStrictTestDurableEvidence) {
  const fact = requiredAt(prepared.facts, 0, 'accepted fact');
  const executionReceipt = prepared.executionReceipt;
  const populationInput = {
    populationId: 'population:strict-test-accepted',
    revision: 1,
    parentPopulationHash: null,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    denominator: {
      kind: 'frozen-complete-subjects' as const,
      expectedObservationIds: ['observation:strict-test-accepted'],
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
        observationId: 'observation:strict-test-accepted',
        factIds: [fact.factId],
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
      observationIds: ['observation:strict-test-accepted'],
      mechanismEvidenceFactIds: [fact.factId],
      anatomyLensIds: ['error-recovery-concurrency'] as const,
    },
  ];
  const clusterSet = canonicalizeKnowledgeClustersV1(population, {
    clusters: clusterInputs,
    nonClusteredDispositions: [],
  });
  return { clusterInputs, clusterSet, fact, population, populationInput };
}

function createAcceptedAnalysis(
  prepared: PreparedStrictTestDurableEvidence,
  authority: StrictTestDimensionAgentAuthorityV1
) {
  const executionReceipt = prepared.executionReceipt;
  const { clusterInputs, clusterSet, fact, population, populationInput } =
    createAcceptedPopulation(prepared);
  const finalExpandedSchedule = createFinalSchedule(authority, executionReceipt.obligationId);
  const terminalObligations = terminalRows(executionReceipt);
  const analysisReviewContextHash = createAnalysisReviewContextHashV1({
    finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
    terminalObligations,
    populationHashes: [population.populationHash],
    clusterSetHashes: [clusterSet.clusterSetHash],
  });
  const falsificationProposal = {
    reviewKind: 'falsification' as const,
    populationHash: population.populationHash,
    hypothesisId: 'hypothesis:strict-test-accepted',
    enrolledCounterqueryIds: [],
    executions: [],
    counterqueryApplicability: {
      status: 'not-required' as const,
      reasonCode: 'bounded-api-contract',
    },
  };
  const falsificationReview = createReview({
    reviewKind: 'falsification',
    currentAnalysisFixpointHash: analysisReviewContextHash,
    populationHash: population.populationHash,
    proposal: falsificationProposal,
    executionReceipts: [executionReceipt],
    finalExpandedSchedule,
    terminalObligations,
  });
  const epoch = validateStrictAnalystEpochV1({
    currentAnalysisFixpointHash: analysisReviewContextHash,
    knownFactIds: [fact.factId],
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
            hypothesisId: 'hypothesis:strict-test-accepted',
            statement: 'Handlers preserve typed Result envelopes',
            premiseFactIds: [fact.factId],
          },
        ],
      },
    ],
    falsificationInputs: [
      {
        hypothesisId: 'hypothesis:strict-test-accepted',
        enrolledCounterqueryIds: [],
        executions: [],
        counterqueryApplicability: {
          status: 'not-required',
          reasonCode: 'bounded-api-contract',
        },
        dispositionReview: falsificationReview,
      },
    ],
    hypothesisDispositions: [
      { hypothesisId: 'hypothesis:strict-test-accepted', status: 'survived' },
    ],
    dispositionReviews: [falsificationReview],
  });
  const analysisFixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule,
    terminalObligations,
    epochs: [epoch],
  });
  return {
    analysisFixpoint,
    clusterSet,
    epoch,
    finalExpandedSchedule,
    population,
  };
}

async function createAcceptedProducerReview(
  prepared: PreparedStrictTestDurableEvidence,
  authority: StrictTestDimensionAgentAuthorityV1,
  analysis: ReturnType<typeof createAcceptedAnalysis>
) {
  const { analysisFixpoint, epoch, finalExpandedSchedule, population } = analysis;
  const privateCorpusRevision = 'private-corpus:strict-test-review:v1';
  const authoredFingerprint = sha('strict-test-reviewed-non-draft');
  const g1Receipt = createStrictG1ReceiptV1({
    candidateFingerprint: authoredFingerprint,
    retrievalReadinessHash: sha('strict-test-retrieval-readiness'),
    rows: STRICT_G1_HARD_AXES_V1.map((axis) => ({
      axis,
      verdict: 'pass' as const,
      reasonCode: `pass:${axis}`,
      evidenceRefs: [prepared.evidenceEntry.id],
    })),
  });
  const corpusInspection = createStrictAcceptedCorpusInspectionV1({
    runId: authority.runId,
    analysisFixpointHash: analysisFixpoint.fixpointHash,
    privateCorpusRevision,
    revisionRootManifestHash: sha('strict-test-private-revision-root'),
    entries: [],
  });
  const admissionReceipt = createStrictAdmissionReceiptV1({
    g1Receipt,
    corpusInspection,
    inputFingerprint: authoredFingerprint,
    finalAdmittedFingerprint: authoredFingerprint,
    exactMatches: [],
    semanticMatches: [],
    consolidation: {
      action: 'create',
      reasonCode: 'no-existing-representative',
      targetRecipeId: null,
      targetFingerprint: null,
    },
    algorithmVersion: 'strict-test-admission-v1',
  });
  const proposal = {
    reviewKind: 'producer-non-draft' as const,
    populationHash: population.populationHash,
    hypothesisId: 'hypothesis:strict-test-accepted',
    expression: null,
    zeroDisposition: {
      reasonCode: 'not-actionable-as-recipe',
      terminalFate: 'reviewed-non-draft' as const,
    },
  };
  const expressionSetReceiptId = 'expression-set:strict-test-reviewed-non-draft';
  const semanticRequest = createReviewRequest({
    prepared,
    authority,
    finalExpandedSchedule,
    analysisFixpoint,
    population,
    proposedDispositionHash: hashKnowledgeDispositionProposalV1(proposal),
    context: {
      reviewKind: 'producer-non-draft',
      privateCorpusRevision,
      analysisFixpoint,
      population,
      induction: requiredAt(epoch.inductions, 0, 'induction'),
      falsification: requiredAt(epoch.falsifications, 0, 'falsification'),
      proposal,
      expressionSetReceiptId,
      g1Receipt,
      admissionReceipt,
      target: {
        expressionId: null,
        authoredFingerprint,
        terminalFate: 'reviewed-non-draft',
        targetRecipeId: null,
        targetFingerprint: null,
        targetReadyProofHash: null,
      },
    },
  });
  const durable = await executeDurableReview(prepared, semanticRequest);
  const dispositionReview = consumeMainSemanticDispositionReviewDurableAttestationV5({
    attestation: durable.attestation,
    expectedSemanticRequest: semanticRequest,
    expectedTrustPolicy: durable.trustPolicy,
  });
  const expressionSet = validateHypothesisExpressionSetReceiptV1({
    schemaVersion: 1,
    receiptId: expressionSetReceiptId,
    hypothesisId: proposal.hypothesisId,
    analysisFixpointHash: analysisFixpoint.fixpointHash,
    privateCorpusRevision,
    version: 1,
    parentReceiptId: null,
    terminalHead: true,
    expressions: [],
    zeroDisposition: {
      reasonCode: proposal.zeroDisposition.reasonCode,
      reviewerReceiptId: dispositionReview.reviewReceiptId,
      dispositionReview,
      terminalFate: 'reviewed-non-draft',
    },
  });
  return {
    ...durable,
    expressionSet,
  };
}

async function createInvestigatedEmptyEvidence(
  prepared: PreparedStrictTestDurableEvidence,
  authority: StrictTestDimensionAgentAuthorityV1
) {
  const executionReceipt = prepared.executionReceipt;
  const finalExpandedSchedule = createFinalSchedule(authority, executionReceipt.obligationId);
  const population = canonicalizeObservationPopulationV1({
    populationId: 'population:strict-test-investigated-empty',
    revision: 1,
    parentPopulationHash: null,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    denominator: {
      kind: 'frozen-complete-subjects',
      expectedObservationIds: ['observation:strict-test-investigated-empty'],
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
    observations: [],
    duplicateObservations: [],
    excludedObservations: [],
    errorObservations: [],
    inspectedNoPatternObservations: [
      {
        observationId: 'observation:strict-test-investigated-empty',
        obligationId: executionReceipt.obligationId,
        canonicalSubjectRef: executionReceipt.canonicalSubjectRef,
        parentSubjectRefs: [],
        executionReceiptHash: executionReceipt.receiptHash,
        outputHash: executionReceipt.outputHash,
        denominatorHash: executionReceipt.denominatorHash,
      },
    ],
  });
  const terminalObligations = terminalRows(executionReceipt);
  const analysisFixpoint = createAnalysisFixpointReceiptV1({
    finalExpandedSchedule,
    terminalObligations,
    populationHashes: [population.populationHash],
    clusterSets: [],
    inductionReceiptHashes: [],
    falsificationReceiptHashes: [],
  });
  const proposal = {
    reviewKind: 'investigated-empty' as const,
    populationHash: population.populationHash,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
    currentAnalysisFixpointHash: analysisFixpoint.fixpointHash,
    expectedObligationIds: [executionReceipt.obligationId],
    executionBindings: [
      {
        obligationId: executionReceipt.obligationId,
        executionReceiptHash: executionReceipt.receiptHash,
        executionOutputHash: executionReceipt.outputHash,
        denominatorHash: executionReceipt.denominatorHash,
        disposition: executionReceipt.disposition,
        terminalReceiptId: executionReceipt.terminalReceiptId,
      },
    ],
    evidenceEntryIds: [prepared.evidenceEntry.id],
  };
  const semanticRequest = createReviewRequest({
    prepared,
    authority,
    finalExpandedSchedule,
    analysisFixpoint,
    population,
    proposedDispositionHash: hashKnowledgeDispositionProposalV1(proposal),
    context: {
      reviewKind: 'investigated-empty',
      analysisFixpoint,
      population,
      proposal,
      negativeEvidenceSufficiency: {
        claim: 'The sealed denominator was fully inspected without an eligible mechanism.',
        requiredAbsencePredicates: ['no-project-specific-recurring-mechanism'],
        inspectedEvidenceEntryIds: [prepared.evidenceEntry.id],
        reasonCode: 'COMPLETE_NEGATIVE_EVIDENCE',
      },
    },
  });
  const durable = await executeDurableReview(prepared, semanticRequest);
  return {
    ...durable,
    expressionSet: null,
    finalExpandedSchedule,
    analysisFixpoint,
    clusterSets: [] as readonly KnowledgeClusterSetV1[],
  };
}

function createReviewRequest(input: {
  readonly prepared: PreparedStrictTestDurableEvidence;
  readonly authority: StrictTestDimensionAgentAuthorityV1;
  readonly finalExpandedSchedule: ReturnType<typeof createFinalExpandedMiningScheduleReceiptV1>;
  readonly analysisFixpoint: ReturnType<typeof createAnalysisFixpointReceiptV1>;
  readonly population: ReturnType<typeof canonicalizeObservationPopulationV1>;
  readonly proposedDispositionHash: string;
  readonly context: Parameters<typeof createAgentSemanticDispositionReviewRequestV1>[0]['context'];
}) {
  const modelLoadReceipt = createModelLoadReceipt();
  return createAgentSemanticDispositionReviewRequestV1({
    strictWorkflowRunId: input.authority.runId,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    currentAnalysisFixpointHash: input.analysisFixpoint.fixpointHash,
    populationHash: input.population.populationHash,
    proposedDispositionHash: input.proposedDispositionHash,
    finalExpandedSchedule: input.finalExpandedSchedule,
    executionReceipts: [input.prepared.executionReceipt],
    evidence: [
      {
        evidenceEntryId: input.prepared.evidenceEntry.id,
        evidenceSessionId: input.prepared.evidenceEntry.sessionId,
        sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
        canonicalSubjectRef: input.prepared.executionReceipt.canonicalSubjectRef,
        relativePath:
          input.prepared.executionReceipt.fileExecutions[0]?.relativePath ??
          'src/strict-test-review.ts',
        blobHash:
          input.prepared.executionReceipt.fileExecutions[0]?.blobHash ??
          sha('strict-test-review-source'),
        content: input.prepared.evidenceEntry.content,
        contentHash: input.prepared.evidenceEntry.contentHash,
        semanticRole:
          input.context.reviewKind === 'investigated-empty'
            ? 'negative-evidence-complete-denominator'
            : 'producer-lineage-evidence',
      },
    ],
    calibration: {
      providerId: modelLoadReceipt.providerId,
      modelId: modelLoadReceipt.modelId,
      modelVersion: modelLoadReceipt.modelVersion,
      methodId: modelLoadReceipt.methodId,
      methodVersion: modelLoadReceipt.methodVersion,
      reviewerModelLoadReceipt: modelLoadReceipt,
      calibrationReceiptHash: sha('strict-test-review-calibration'),
      rubricVersion: 'semantic-disposition-rubric-v1',
      axes: reviewerAxes(input.context.reviewKind).map((axisId) => ({
        axisId,
        minimumScore: 0.8,
        calibrationEvidenceHash: sha(`calibration:${axisId}`),
      })),
    },
    producer: createProductionActorIdentityV1({
      providerId: 'agent-producer',
      modelId: 'producer-model',
      modelVersion: 'strict-producer-v1',
      promptHash: sha('strict-test-producer-prompt'),
      runId: input.authority.runId,
      invocationId: 'producer-invocation:strict-test-review',
      loadReceiptHash: sha('strict-test-producer-load'),
      outputHash: input.proposedDispositionHash,
    }),
    context: input.context,
  });
}

async function executeDurableReview(
  prepared: PreparedStrictTestDurableEvidence,
  semanticRequest: SemanticDispositionReviewRequestV1
) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const modelLoadReceipt = semanticRequest.calibration.reviewerModelLoadReceipt;
  const runtime = await createDurableSemanticReviewRuntime({
    signingKey: {
      trustRootId: 'semantic-review-trust:strict-test',
      keyId: 'semantic-review-key:strict-test',
      loadPrivateKey: async () => privateKey,
    },
    reviewer: {
      provider: {
        name: modelLoadReceipt.providerId,
        model: modelLoadReceipt.modelId,
        chatWithTools: async (prompt) => ({
          text: passingDecisionFromCompiledPrompt(prompt, prepared.evidenceEntry.id),
          functionCalls: null,
        }),
      },
      modelLoadReceipt,
      evaluatorRunId: 'agent-evaluator:strict-test-review',
      createInvocationId: () => 'reviewer-invocation:strict-test-review:1',
    },
    evidence: {
      ledger: prepared.ledgerAuthority.read,
      witnessAuthority: {
        resolve: async (lookup) =>
          lookup.evidenceEntryId === prepared.evidenceEntry.id ? authorityBundle(prepared) : null,
      },
    },
    timeoutMs: 1_000,
    diagnostics: new DiagnosticsCollector(),
  });
  return {
    attestation: await runtime.execute({ semanticRequest }),
    trustPolicy: runtime.trustPolicy,
  };
}

function authorityBundle(
  prepared: PreparedStrictTestDurableEvidence
): SemanticReviewWitnessAuthorityBundleV1 {
  return {
    evidenceLedgerSnapshot: prepared.evidenceLedgerSnapshot,
    witnessBinding: prepared.witnessBinding,
  };
}

function createFinalSchedule(authority: StrictTestDimensionAgentAuthorityV1, obligationId: string) {
  return createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: authority.fullBaselineScheduleHash,
    baselineObligationIds: [obligationId],
    expansionReceipts: [],
  });
}

function terminalRows(executionReceipt: ReturnType<typeof createExecutionReceipt>) {
  return [
    {
      obligationId: executionReceipt.obligationId,
      disposition: executionReceipt.disposition,
      terminalReceiptId: executionReceipt.terminalReceiptId,
    },
  ];
}

function createModelLoadReceipt(): SemanticDispositionReviewerModelLoadReceiptV1 {
  const semantic = {
    schemaVersion: 1 as const,
    providerId: 'provider:strict-test-reviewer',
    modelId: 'model:strict-test-reviewer',
    modelVersion: '2026-07-30',
    methodId: 'semantic-disposition-review',
    methodVersion: 'v3',
    runtimeConfigHash: sha('strict-test-reviewer-runtime'),
    credentialLocationSymbol: 'runtime-config:strict-test-reviewer-credentials',
  };
  return { ...semantic, loadReceiptHash: hash(semantic) };
}

function passingDecisionFromCompiledPrompt(
  compiledPrompt: string,
  evidenceEntryId: string
): string {
  const parsed = JSON.parse(compiledPrompt) as {
    readonly payload: {
      readonly semanticRequest: SemanticDispositionReviewRequestV1;
      readonly evidenceAuthorities: readonly unknown[];
      readonly schemaVersion: 3 | 4;
      readonly producerRoute: string;
      readonly consumerRoute: string;
    };
  };
  const compiledPromptHash = shaText(compiledPrompt);
  const requestHash = hash({
    ...parsed.payload,
    compiledPrompt,
    compiledPromptHash,
  });
  const semanticRequest = parsed.payload.semanticRequest;
  return JSON.stringify({
    schemaVersion: parsed.payload.schemaVersion,
    requestHash,
    compiledPromptHash,
    semanticRequestHash: semanticRequest.requestHash,
    contextHash: semanticRequest.contextHash,
    reviewKind: semanticRequest.reviewKind,
    proposedDispositionHash: semanticRequest.proposedDispositionHash,
    verdict: 'pass',
    reasonCode: 'SEMANTIC_DISPOSITION_CONFIRMED',
    axisDecisions: semanticRequest.calibration.axes.map(({ axisId }) => ({
      axisId,
      verdict: 'pass',
      score: 0.95,
      reasonCode: `PASS:${axisId}`,
      evidenceEntryIds: [evidenceEntryId],
    })),
    evidenceFindings: [
      {
        evidenceEntryId,
        axisIds: semanticRequest.calibration.axes.map(({ axisId }) => axisId),
        finding: 'Frozen strict-test evidence supports the disposition.',
        supportsVerdict: true,
      },
    ],
  });
}

function reviewerAxes(reviewKind: 'producer-non-draft' | 'investigated-empty') {
  return reviewKind === 'producer-non-draft' ? PRODUCER_REVIEWER_AXES : REVIEWER_AXES;
}

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`STRICT_TEST_DURABLE_FIXTURE_MISSING:${label}`);
  }
  return value;
}

function shaText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha(value: string): string {
  return hash(value);
}

function hash(value: unknown): string {
  return shaText(JSON.stringify(sortCanonical(value)));
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
