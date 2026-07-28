import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createDurableSemanticReviewRuntime,
  createFrozenEvidenceProjection,
  DurableSemanticReviewRuntimeError,
  IndependentValueReviewer,
  InvestigatedEmptyReviewer,
} from '@alembic/agent/evaluation';
import {
  createProductionEvidenceLedgerAuthority,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictAnalysisGateOutcomeV1,
  createStrictHypothesisExpressionSetReceiptV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  validateStrictAnalysisEpochTransitionV1,
  validateStrictAnalystEpochV1,
} from '@alembic/agent/production';
import { runStrictPlanAgent } from '@alembic/agent/runs';
import {
  assertSemanticDispositionReviewDurableAttestationV3,
  buildFactQueryCatalogSnapshot,
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAgentSemanticDispositionReviewRequestV1,
  createAnalysisReviewContextHashV1,
  createConfigFactQueryBackendV1,
  createConfigFactQueryFamilyV1,
  createKnowledgeDispositionReviewV1,
  createProductionActorIdentityV1,
  createStrictAcceptedCorpusInspectionV1,
  createStrictAdmissionReceiptV1,
  createStrictFactBackendRegistryV1,
  createStrictFactDirectWitnessBindingV1,
  createStrictFactSubjectBindingV1,
  createStrictFactWitnessAuthorityV1,
  createStrictG1ReceiptV1,
  createStrictG2ReceiptV1,
  executeStrictFactScheduleV1,
  hashKnowledgeClusterV1,
  hashKnowledgeDispositionProposalV1,
  STRICT_G1_HARD_AXES_V1,
  STRICT_G2_HARD_AXES_V1,
} from '@alembic/core/production';
import {
  buildProjectContextRequestMatrixV2,
  buildProjectScopeManifestV1,
  CERTIFIED_PROJECT_FACTS_CONSUMERS,
  captureCertifiedProjectFactsV2,
  createProjectContextFileRef,
  createProjectContextRequestAuditPlansV2,
  hashCanonicalJson,
  readCertifiedProjectFactsFrozenFile,
} from '@alembic/core/project-context-foundation';

const runId = 'run:agent-public-connected-probe';
const privateCorpusRevision = 'revision:agent-public-connected-probe';
const controlRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-agent-public-connected-probe-'))
);

try {
  await runProbe(controlRoot);
} finally {
  fs.rmSync(controlRoot, { force: true, recursive: true });
}

async function runProbe(root) {
  const surface = await verifyPublicSurface();
  const real = await createRealExecutorFixture(root);
  const semantic = createAgentSemanticFixture(real);
  const producer = createAgentProducerFixture(real, semantic);
  const durableReview = await createDurableReviewProbe(real, semantic, producer);
  const orphanReview = createOrphanReviewFixture(real, semantic);
  const reboundReview = createReboundReviewFixture(real, semantic);
  const faults = await runFaultMatrix(real, semantic, producer, orphanReview, reboundReview);
  writeReport({ surface, real, semantic, producer, durableReview, faults });
}

async function verifyPublicSurface() {
  const bindings = {
    runStrictPlanAgent,
    createStrictAnalysisContextProjectionV1,
    createProductionEvidenceLedgerAuthority,
    createStrictAnalysisEpochSnapshotV1,
    createStrictAnalysisExpansionPortV1,
    createStrictAnalysisGateOutcomeV1,
    createStrictHypothesisExpressionSetReceiptV1,
    validateStrictAnalysisEpochTransitionV1,
    validateStrictAnalystEpochV1,
    createStrictAnalysisFixpointV1,
    createStrictProducerLineageReceiptV1,
    createStrictProducerExpressionSetV1,
    createFrozenEvidenceProjection,
    createDurableSemanticReviewRuntime,
    DurableSemanticReviewRuntimeError,
    IndependentValueReviewer,
    InvestigatedEmptyReviewer,
  };
  for (const [name, value] of Object.entries(bindings)) {
    if (typeof value !== 'function') {
      throw new Error(`STRICT_PUBLIC_BINDING_INVALID:${name}:${typeof value}`);
    }
  }

  for (const specifier of [
    '@alembic/agent',
    '@alembic/agent/service',
    '@alembic/agent/runtime',
    '@alembic/agent/prompts',
  ]) {
    const imported = await import(specifier);
    if (!imported || typeof imported !== 'object') {
      throw new Error(`LEGACY_PUBLIC_IMPORT_INVALID:${specifier}`);
    }
  }

  const forbidden = [
    '@alembic/agent/src/index.js',
    '@alembic/agent/dist/index.js',
    '@alembic/agent/runs/plan/PlanAgentRun.js',
    '@alembic/agent/production/StrictProductionPipeline.js',
    '@alembic/agent/production/internal/escape.js',
    '@alembic/agent/evaluation/MiningJudge.js',
    '@alembic/agent/evaluation/StrictProductionFixtureEvaluation.js',
  ];
  for (const specifier of forbidden) {
    try {
      await import(specifier);
      throw new Error(`FORBIDDEN_IMPORT_SUCCEEDED:${specifier}`);
    } catch (err) {
      if (
        !(err instanceof Error) ||
        !('code' in err) ||
        err.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      ) {
        throw err;
      }
    }
  }
  return {
    runtimeBindingCount: Object.keys(bindings).length,
    forbiddenCount: forbidden.length,
  };
}

async function createDurableReviewProbe(real, semantic, producer) {
  const executionReceipt = real.executionReceipt;
  const fileExecution = executionReceipt.fileExecutions[0];
  const witnessBinding = real.witness.bindings[0];
  const induction = semantic.epoch.inductions[0];
  const falsification = semantic.epoch.falsifications[0];
  if (!fileExecution || !witnessBinding || !induction || !falsification) {
    throw new Error('STRICT_AGENT_PUBLIC_DURABLE_REVIEW_INPUT_INCOMPLETE');
  }
  const reviewerModelLoadReceipt = createPublicReviewerModelLoadReceipt();
  const semanticRequest = createDurableSemanticReviewRequest({
    real,
    semantic,
    producer,
    executionReceipt,
    fileExecution,
    witnessBinding,
    induction,
    falsification,
    reviewerModelLoadReceipt,
  });
  return executeDurableReviewRuntimeProbe({
    real,
    semanticRequest,
    witnessBinding,
    reviewerModelLoadReceipt,
  });
}

function createPublicReviewerModelLoadReceipt() {
  const semantic = {
    schemaVersion: 1,
    providerId: 'provider:agent-public-independent-reviewer',
    modelId: 'model:agent-public-independent-reviewer',
    modelVersion: '2026-07-28',
    methodId: 'semantic-disposition-review',
    methodVersion: 'v3',
    runtimeConfigHash: hashCanonicalJson({ runtime: 'agent-public-durable-review' }),
    credentialLocationSymbol: 'runtime-config:agent-public-reviewer',
  };
  return {
    ...semantic,
    loadReceiptHash: hashCanonicalJson(semantic),
  };
}

function createDurableSemanticReviewRequest({
  real,
  semantic,
  producer,
  executionReceipt,
  fileExecution,
  witnessBinding,
  induction,
  falsification,
  reviewerModelLoadReceipt,
}) {
  const proposal = {
    reviewKind: 'producer-non-draft',
    populationHash: semantic.epoch.population.populationHash,
    hypothesisId: semantic.hypothesisId,
    expression: null,
    zeroDisposition: {
      reasonCode: 'NO_ELIGIBLE_EXPRESSION_AFTER_PRODUCER',
      terminalFate: 'reviewed-non-draft',
    },
  };
  const proposedDispositionHash = hashKnowledgeDispositionProposalV1(proposal);
  return createAgentSemanticDispositionReviewRequestV1({
    strictWorkflowRunId: runId,
    sourceRevisionVectorHash: real.artifact.sourceVectorHash,
    currentAnalysisFixpointHash: semantic.analysisFixpoint.fixpointHash,
    populationHash: semantic.epoch.population.populationHash,
    proposedDispositionHash,
    finalExpandedSchedule: semantic.finalSchedule,
    executionReceipts: [executionReceipt],
    evidence: [
      {
        evidenceEntryId: witnessBinding.evidenceEntryId,
        evidenceSessionId: witnessBinding.evidenceSessionId,
        sourceRevisionVectorHash: real.artifact.sourceVectorHash,
        canonicalSubjectRef: executionReceipt.canonicalSubjectRef,
        relativePath: fileExecution.relativePath,
        blobHash: fileExecution.blobHash,
        content: witnessBinding.evidenceEntry.content,
        contentHash: witnessBinding.evidenceEntry.contentHash,
        semanticRole: 'candidate-admission-target-comparison',
      },
    ],
    calibration: {
      providerId: reviewerModelLoadReceipt.providerId,
      modelId: reviewerModelLoadReceipt.modelId,
      modelVersion: reviewerModelLoadReceipt.modelVersion,
      methodId: reviewerModelLoadReceipt.methodId,
      methodVersion: reviewerModelLoadReceipt.methodVersion,
      reviewerModelLoadReceipt,
      calibrationReceiptHash: hashCanonicalJson({
        kind: 'agent-public-durable-review-calibration',
      }),
      rubricVersion: 'semantic-disposition-rubric-v1',
      axes: [
        'admission-comparison-completeness',
        'fixpoint-population-execution-lineage',
        'frozen-semantic-evidence-grounding',
        'hypothesis-falsification-context',
        'reviewer-independence',
        'target-disposition-consistency',
        'verdict-sufficiency',
      ].map((axisId) => ({
        axisId,
        minimumScore: 0.8,
        calibrationEvidenceHash: hashCanonicalJson({ axisId }),
      })),
    },
    producer: createProductionActorIdentityV1({
      providerId: 'provider:agent-public-producer',
      modelId: 'model:agent-public-producer',
      modelVersion: '2026-07-28',
      promptHash: hashCanonicalJson({ kind: 'agent-public-producer-prompt' }),
      runId,
      invocationId: 'invocation:agent-public-producer',
      loadReceiptHash: hashCanonicalJson({ kind: 'agent-public-producer-load' }),
      outputHash: proposedDispositionHash,
    }),
    context: {
      reviewKind: 'producer-non-draft',
      privateCorpusRevision,
      analysisFixpoint: semantic.analysisFixpoint,
      population: semantic.epoch.population,
      induction,
      falsification,
      proposal,
      expressionSetReceiptId: producer.coreExpressionSet.receiptId,
      g1Receipt: producer.contentReadyTerminal.g1Receipt,
      admissionReceipt: producer.contentReadyTerminal.admissionReceipt,
      target: {
        expressionId: null,
        authoredFingerprint: producer.expressionSet.proposals[0].authoredFingerprint,
        terminalFate: 'reviewed-non-draft',
        targetRecipeId: null,
        targetFingerprint: null,
        targetReadyProofHash: null,
      },
    },
  });
}

async function executeDurableReviewRuntimeProbe({
  real,
  semanticRequest,
  witnessBinding,
  reviewerModelLoadReceipt,
}) {
  let providerCallCount = 0;
  let witnessLoadCount = 0;
  let compiledPrompt = null;
  const { privateKey } = generateKeyPairSync('ed25519');
  const runtime = await createDurableSemanticReviewRuntime({
    signingKey: {
      trustRootId: 'semantic-review-trust:agent-public-probe',
      keyId: 'semantic-review-key:agent-public-probe',
      loadPrivateKey: async () => privateKey,
    },
    reviewer: {
      provider: {
        name: reviewerModelLoadReceipt.providerId,
        model: reviewerModelLoadReceipt.modelId,
        chatWithTools: async (prompt) => {
          providerCallCount += 1;
          compiledPrompt = prompt;
          return {
            text: createPassingDurableReviewDecision(prompt, witnessBinding.evidenceEntryId),
            functionCalls: null,
          };
        },
      },
      modelLoadReceipt: reviewerModelLoadReceipt,
      evaluatorRunId: 'run:agent-public-independent-reviewer',
      createInvocationId: () => 'invocation:agent-public-independent-reviewer',
    },
    evidence: {
      ledger: real.ledgerAuthority.read,
      witnessAuthority: {
        resolve: async (lookup) => {
          witnessLoadCount += 1;
          const witnessBinding =
            real.witness.bindings.find(
              (binding) =>
                binding.bindingHash === lookup.witnessBindingHash &&
                binding.evidenceEntryId === lookup.evidenceEntryId
            ) ?? null;
          const fileExecution = real.executionReceipt.fileExecutions.find(
            (execution) => execution.executionHash === lookup.fileExecutionHash
          );
          if (
            !witnessBinding ||
            !fileExecution ||
            real.executionReceipt.receiptHash !== lookup.executionReceiptHash
          ) {
            return null;
          }
          return {
            evidenceLedgerSnapshot: real.witness.evidenceLedgerSnapshot,
            witnessBinding,
            executionReceipt: real.executionReceipt,
            fileExecutionHash: fileExecution.executionHash,
          };
        },
      },
    },
    timeoutMs: 1_000,
  });
  const attestation = await runtime.execute({ semanticRequest });
  const serializedAttestation = JSON.parse(JSON.stringify(attestation));
  assertSemanticDispositionReviewDurableAttestationV3({
    attestation: serializedAttestation,
    expectedTrustPolicy: JSON.parse(JSON.stringify(runtime.trustPolicy)),
  });
  const freshProcess = verifyFreshProcessLedgerReopen({
    coordinates: real.ledgerCoordinates,
    expectedIdentity: real.ledgerAuthority.identity,
    expectedSnapshotHash: real.witness.evidenceLedgerSnapshot.snapshotHash,
    expectedEvidenceEntryIds: real.witness.bindings.map((binding) => binding.evidenceEntryId),
    attestation: serializedAttestation,
    expectedTrustPolicy: JSON.parse(JSON.stringify(runtime.trustPolicy)),
  });
  if (
    providerCallCount !== 1 ||
    witnessLoadCount !== 1 ||
    compiledPrompt !== attestation.execution.request.compiledPrompt ||
    freshProcess.reopened !== true
  ) {
    throw new Error('STRICT_AGENT_PUBLIC_DURABLE_REVIEW_RUNTIME_MISMATCH');
  }
  return {
    serviceEntrypoint: true,
    providerCallCount,
    witnessLoadCount,
    exactCompiledPrompt: true,
    serializedAttestationVerified: true,
    publicConsumerFreshProcess: true,
    freshProcessReopenVerified: true,
    evidenceStoreId: real.ledgerAuthority.identity.storeId,
    evidenceStoreConfigHash: real.ledgerAuthority.identity.storeConfigHash,
    evidenceLedgerSnapshotHash: real.witness.evidenceLedgerSnapshot.snapshotHash,
    requestHash: semanticRequest.requestHash,
    executionHash: attestation.execution.executionHash,
    attestationHash: attestation.attestationHash,
    trustPolicyHash: runtime.trustPolicy.policyHash,
  };
}

function verifyFreshProcessLedgerReopen(input) {
  const payloadPath = path.join(input.coordinates.dataRoot, 'fresh-ledger-reopen-proof.json');
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({
      expectedIdentity: input.expectedIdentity,
      expectedSnapshotHash: input.expectedSnapshotHash,
      expectedEvidenceEntryIds: input.expectedEvidenceEntryIds,
      attestation: input.attestation,
      expectedTrustPolicy: input.expectedTrustPolicy,
    }),
    'utf8'
  );
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "import fs from 'node:fs';",
        "import { createProductionEvidenceLedgerAuthority } from '@alembic/agent/production';",
        "import { assertSemanticDispositionReviewDurableAttestationV3 } from '@alembic/core/production';",
        "const payload = JSON.parse(fs.readFileSync(process.env.ALEMBIC_LEDGER_REOPEN_PAYLOAD, 'utf8'));",
        'const coordinates = JSON.parse(process.env.ALEMBIC_LEDGER_REOPEN_COORDINATES);',
        'const authority = createProductionEvidenceLedgerAuthority(coordinates);',
        'const snapshot = authority.read.strictSnapshot();',
        "if (JSON.stringify(authority.identity) !== JSON.stringify(payload.expectedIdentity)) throw new Error('FRESH_LEDGER_IDENTITY_MISMATCH');",
        "if (snapshot.snapshotHash !== payload.expectedSnapshotHash) throw new Error('FRESH_LEDGER_SNAPSHOT_MISMATCH');",
        "if (payload.expectedEvidenceEntryIds.some((id) => !authority.read.get(id))) throw new Error('FRESH_LEDGER_EVIDENCE_MISSING');",
        'assertSemanticDispositionReviewDurableAttestationV3({ attestation: payload.attestation, expectedTrustPolicy: payload.expectedTrustPolicy });',
        'process.stdout.write(JSON.stringify({ reopened: true, storeId: authority.identity.storeId, snapshotHash: snapshot.snapshotHash }));',
      ].join('\n'),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ALEMBIC_LEDGER_REOPEN_COORDINATES: JSON.stringify(input.coordinates),
        ALEMBIC_LEDGER_REOPEN_PAYLOAD: payloadPath,
      },
    }
  );
  return JSON.parse(output);
}

function createPassingDurableReviewDecision(compiledPrompt, evidenceEntryId) {
  const parsed = JSON.parse(compiledPrompt);
  const compiledPromptHash = `sha256:${sha256(compiledPrompt)}`;
  const requestHash = hashCanonicalJson({
    ...parsed.payload,
    compiledPrompt,
    compiledPromptHash,
  });
  const semanticRequest = parsed.payload.semanticRequest;
  return JSON.stringify({
    schemaVersion: 2,
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
        finding: 'The frozen evidence and disposition lineage are complete.',
        supportsVerdict: true,
      },
    ],
  });
}

async function createRealExecutorFixture(root) {
  const ledgerCoordinates = Object.freeze({
    dataRoot: root,
    jobId: 'job:agent-public-connected-probe',
    sessionId: 'session:agent-public-connected-probe',
    dimensionId: 'dimension:strict-fact-execution',
  });
  const ledgerAuthority = createProductionEvidenceLedgerAuthority(ledgerCoordinates);
  const captureValidationBefore = provePublicCaptureValidation(ledgerAuthority, ledgerCoordinates);
  const artifact = await createStrictArtifact(root);
  const planningFacts = createPlanningFacts(artifact);
  const family = createConfigFactQueryFamilyV1({
    familyId: 'config-declaration',
    supportedScales: ['file'],
    parser: 'nx-project-json',
  });
  const catalog = buildFactQueryCatalogSnapshot([family]);
  const subjectBinding = createStrictFactSubjectBindingV1({
    artifact,
    planningFacts,
    selector: { kind: 'repository', repoId: 'core' },
  });
  const witness = createWitnessMaterial(artifact, ledgerAuthority);
  const nextValidEvidenceEntryId = witness.bindings[0]?.evidenceEntryId ?? null;
  if (nextValidEvidenceEntryId !== 'E-1') {
    throw new Error(
      `STRICT_AGENT_PUBLIC_CAPTURE_SEQUENCE_CONSUMED:${nextValidEvidenceEntryId ?? 'missing'}`
    );
  }
  const captureValidation = Object.freeze({
    ...captureValidationBefore,
    nextValidEvidenceEntryId,
    unconsumedSequencePreserved: true,
  });
  const registry = createStrictFactBackendRegistryV1([
    createConfigFactQueryBackendV1({ family, parser: 'nx-project-json' }),
  ]);
  const schedule = createSchedule(family, subjectBinding.canonicalSubjectRef);
  const factExecution = await executeStrictFactScheduleV1({
    artifact,
    planningFacts,
    catalog,
    schedule,
    subjectBindings: [subjectBinding],
    witnessBindings: witness.bindings,
    witnessAuthority: witness.authority,
    registry,
  });
  const executionReceipt = factExecution.receipts[0];
  if (
    factExecution.manifest.verdict !== 'passed' ||
    factExecution.facts.length === 0 ||
    !executionReceipt ||
    executionReceipt.disposition !== 'matched' ||
    executionReceipt.expectedFileCount !== 1 ||
    executionReceipt.inspectedFileCount !== 1
  ) {
    throw new Error('STRICT_AGENT_PUBLIC_REAL_EXECUTOR_FAILED');
  }
  return {
    ledgerAuthority,
    ledgerCoordinates,
    captureValidation,
    artifact,
    family,
    catalog,
    subjectBinding,
    witness,
    registry,
    schedule,
    factExecution,
    executionReceipt,
  };
}

function provePublicCaptureValidation(authority, coordinates) {
  const filePath = path.join(
    coordinates.dataRoot,
    '.asd',
    'evidence-ledger',
    coordinates.jobId,
    `${coordinates.dimensionId}.jsonl`
  );
  const invalidDrafts = [
    ['unknown-tool', { tool: 'caller.fake', callId: 'call:invalid', content: 'invalid' }],
    ['null-draft', null],
    ['array-draft', []],
    ['missing-tool', { callId: 'call:invalid', content: 'invalid' }],
    ['missing-call-id', { tool: 'code.read', content: 'invalid' }],
    ['missing-content', { tool: 'code.read', callId: 'call:invalid' }],
    [
      'extra-top-level-field',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        content: 'invalid',
        callerTruth: true,
      },
    ],
    ['non-string-tool', { tool: 7, callId: 'call:invalid', content: 'invalid' }],
    ['non-string-call-id', { tool: 'code.read', callId: 7, content: 'invalid' }],
    ['non-string-content', { tool: 'code.read', callId: 'call:invalid', content: 7 }],
    ['non-string-file', { tool: 'code.read', callId: 'call:invalid', file: 7, content: 'invalid' }],
    ['empty-file', { tool: 'code.read', callId: 'call:invalid', file: '', content: 'invalid' }],
    [
      'present-undefined-file',
      { tool: 'code.read', callId: 'call:invalid', file: undefined, content: 'invalid' },
    ],
    ['null-range', { tool: 'code.read', callId: 'call:invalid', range: null, content: 'invalid' }],
    [
      'present-undefined-range',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: undefined,
        content: 'invalid',
      },
    ],
    [
      'array-range',
      { tool: 'code.read', callId: 'call:invalid', range: [1, 2], content: 'invalid' },
    ],
    [
      'missing-range-start',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { end: 2 },
        content: 'invalid',
      },
    ],
    [
      'missing-range-end',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: 1 },
        content: 'invalid',
      },
    ],
    [
      'extra-range-field',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: 1, end: 2, zeroBased: true },
        content: 'invalid',
      },
    ],
    [
      'zero-range-start',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: 0, end: 1 },
        content: 'invalid',
      },
    ],
    [
      'negative-range-end',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: 1, end: -1 },
        content: 'invalid',
      },
    ],
    [
      'descending-range',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: 2, end: 1 },
        content: 'invalid',
      },
    ],
    [
      'fractional-range',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: 1.5, end: 2 },
        content: 'invalid',
      },
    ],
    [
      'nan-range',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: Number.NaN, end: 2 },
        content: 'invalid',
      },
    ],
    [
      'infinite-range',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: 1, end: Number.POSITIVE_INFINITY },
        content: 'invalid',
      },
    ],
    [
      'string-range',
      {
        tool: 'code.read',
        callId: 'call:invalid',
        range: { start: '1', end: '2' },
        content: 'invalid',
      },
    ],
  ];

  const cases = invalidDrafts.map(([mutation, draft]) => {
    const fileExistedBefore = fs.existsSync(filePath);
    const bytesBefore = fileExistedBefore ? fs.readFileSync(filePath) : null;
    const snapshotBefore = captureLedgerSnapshotState(authority);
    let error = null;
    try {
      authority.capture.capture(draft);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const fileExistsAfter = fs.existsSync(filePath);
    const bytesAfter = fileExistsAfter ? fs.readFileSync(filePath) : null;
    const snapshotAfter = captureLedgerSnapshotState(authority);
    const fileUnchanged =
      fileExistedBefore === fileExistsAfter &&
      (bytesBefore === null ? bytesAfter === null : bytesBefore.equals(bytesAfter));
    const snapshotUnchanged = JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter);
    if (
      !error?.startsWith('ALEMBIC_AGENT_EVIDENCE_LEDGER_CAPTURE_INVALID:') ||
      !fileUnchanged ||
      !snapshotUnchanged
    ) {
      throw new Error(
        `STRICT_AGENT_PUBLIC_CAPTURE_VALIDATION_FAILED:${mutation}:${error ?? 'no-error'}`
      );
    }
    return {
      mutation,
      error,
      rejected: true,
      fileUnchanged,
      snapshotUnchanged,
    };
  });

  if (fs.existsSync(filePath)) {
    throw new Error('STRICT_AGENT_PUBLIC_CAPTURE_REJECTION_CREATED_LEDGER');
  }
  return Object.freeze({
    publicPackageEntrypoint: true,
    invalidCaseCount: cases.length,
    rejectedWithoutMutation: cases.every(
      (item) => item.rejected && item.fileUnchanged && item.snapshotUnchanged
    ),
    ledgerFileAbsentAfterRejections: true,
    cases: Object.freeze(cases),
  });
}

function captureLedgerSnapshotState(authority) {
  try {
    const snapshot = authority.read.strictSnapshot();
    return {
      status: 'snapshot',
      snapshotHash: snapshot.snapshotHash,
      evidenceEntryIds: snapshot.entries.map((entry) => entry.id),
    };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function createAgentSemanticFixture(real) {
  const population = createPopulationPreview(real);
  const review = createAnalysisReviewFixture(real, population);
  const epochInput = createAgentEpochInput(real, population, review);
  const epoch = validateStrictAnalystEpochV1(epochInput);
  const analysisFixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule: review.finalSchedule,
    terminalObligations: review.terminalObligations,
    epochs: [epoch],
  });
  return {
    ...population,
    ...review,
    epochInput,
    epoch,
    analysisFixpoint,
  };
}

function createPopulationPreview(real) {
  const { artifact, factExecution, executionReceipt } = real;
  const observationId = 'observation:agent-public-config';
  const populationInput = {
    populationId: 'population:agent-public-connected-probe',
    revision: 1,
    parentPopulationHash: null,
    sourceRevisionVectorHash: artifact.sourceVectorHash,
    denominator: {
      kind: 'frozen-complete-subjects',
      expectedObservationIds: [observationId],
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
        observationId,
        factIds: factExecution.facts.map((fact) => fact.factId),
        obligationIds: [executionReceipt.obligationId],
        canonicalSubjectRefs: [executionReceipt.canonicalSubjectRef],
        parentSubjectRefs: ['repo:core'],
        variantKeys: ['nx-project-json'],
        outlierReasonCodes: [],
        negativeControl: false,
      },
    ],
    duplicateObservations: [],
    excludedObservations: [],
    errorObservations: [],
    inspectedNoPatternObservations: [],
  };
  const clusterInputs = [
    {
      mechanismKey: 'mechanism:agent-public-config-declaration',
      mechanism: {
        backend: 'strict-config-fact-backend-v1',
        invariant: 'frozen config declarations are parser-derived',
      },
      observationIds: [observationId],
      mechanismEvidenceFactIds: factExecution.facts.map((fact) => fact.factId),
      anatomyLensIds: ['entrypoint-and-contract'],
    },
  ];
  // Review context 必须先由 Core canonical preview 得到，再由 Agent 重新消费同一输入。
  // 这一步只解决 contract 的无环构造顺序，不把 preview 当作 Agent 链的验收结果。
  const previewPopulation = canonicalizeObservationPopulationV1(populationInput);
  const previewClusterSet = canonicalizeKnowledgeClustersV1(previewPopulation, {
    clusters: clusterInputs,
    nonClusteredDispositions: [],
  });
  return {
    populationInput,
    clusterInputs,
    previewPopulation,
    previewClusterSet,
  };
}

function createAnalysisReviewFixture(real, population) {
  const { family, executionReceipt, schedule, catalog, registry } = real;
  const { previewPopulation, previewClusterSet } = population;
  const expansionPort = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: schedule.baselineScheduleHash,
    baselineObligationIds: [executionReceipt.obligationId],
    knownFactFamilies: [
      {
        id: family.id,
        capabilityId: family.capabilityId,
        supportedScales: family.supportedScales,
      },
    ],
    knownSubjectRefs: [executionReceipt.canonicalSubjectRef],
    obligationCap: 1,
  });
  const finalSchedule = expansionPort.seal();
  const terminalObligations = [
    {
      obligationId: executionReceipt.obligationId,
      disposition: executionReceipt.disposition,
      terminalReceiptId: executionReceipt.terminalReceiptId,
    },
  ];
  const analysisReviewContextHash = createAnalysisReviewContextHashV1({
    finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    terminalObligations,
    populationHashes: [previewPopulation.populationHash],
    clusterSetHashes: [previewClusterSet.clusterSetHash],
  });
  const hypothesisId = 'hypothesis:agent-public-config-declaration';
  const applicability = {
    status: 'not-required',
    reasonCode: 'single-frozen-config-contract',
  };
  const proposalHash = hashKnowledgeDispositionProposalV1({
    reviewKind: 'falsification',
    populationHash: previewPopulation.populationHash,
    hypothesisId,
    enrolledCounterqueryIds: [],
    executions: [],
    counterqueryApplicability: applicability,
  });
  const calibrationReceiptHash = hashCanonicalJson({
    catalogHash: catalog.catalogHash,
    registryHash: registry.registryHash,
  });
  const actors = createActors(real, proposalHash, {
    reviewKind: 'falsification',
    calibrationReceiptHash,
    verdict: 'pass',
    reasonCode: 'real-executor-evidence-reviewed',
  });
  const dispositionReview = createKnowledgeDispositionReviewV1({
    reviewKind: 'falsification',
    currentAnalysisFixpointHash: analysisReviewContextHash,
    populationHash: previewPopulation.populationHash,
    proposedDispositionHash: proposalHash,
    executionReceipts: [executionReceipt],
    finalExpandedSchedule: finalSchedule,
    terminalObligations,
    producer: actors.producer,
    reviewer: actors.reviewer,
    calibrationReceiptHash,
    verdict: 'pass',
    reasonCode: 'real-executor-evidence-reviewed',
  });
  return {
    finalSchedule,
    terminalObligations,
    analysisReviewContextHash,
    hypothesisId,
    applicability,
    proposalHash,
    actors,
    dispositionReview,
  };
}

function createAgentEpochInput(real, population, review) {
  const { factExecution } = real;
  const { populationInput, clusterInputs } = population;
  const {
    analysisReviewContextHash,
    finalSchedule,
    hypothesisId,
    applicability,
    dispositionReview,
  } = review;
  const epochInput = {
    currentAnalysisFixpointHash: analysisReviewContextHash,
    knownFactIds: factExecution.facts.map((fact) => fact.factId),
    enrolledObligationIds: finalSchedule.obligationIds,
    population: populationInput,
    clusterInputs,
    nonClusteredDispositions: [],
    inductionInputs: [
      {
        mechanismKey: clusterInputs[0].mechanismKey,
        mode: 'bounded-singleton',
        hypotheses: [
          {
            hypothesisId,
            statement: 'The frozen config parser produces a deterministic declaration fact.',
            premiseFactIds: factExecution.facts.map((fact) => fact.factId),
          },
        ],
      },
    ],
    falsificationInputs: [
      {
        hypothesisId,
        enrolledCounterqueryIds: [],
        executions: [],
        counterqueryApplicability: applicability,
        dispositionReview,
      },
    ],
    hypothesisDispositions: [{ hypothesisId, status: 'survived' }],
    dispositionReviews: [dispositionReview],
  };
  return epochInput;
}

function createAgentProducerFixture(real, semantic) {
  const { epoch, analysisFixpoint, hypothesisId } = semantic;
  const evidence = createProducerEvidence(real);
  const context = createProducerContext(real, semantic, evidence);
  const lineage = createStrictProducerLineageReceiptV1({
    context,
    epoch,
    analysisFixpoint,
    hypothesisId,
    evidence,
  });
  const expressionId = 'expression:agent-public-config-declaration';
  const expressionSet = createStrictProducerExpressionSetV1({
    lineage,
    parentSet: null,
    proposals: [
      {
        expressionId,
        kind: 'draft',
        authored: createAuthoredProjection(evidence),
      },
    ],
    zeroDisposition: null,
    modelHash: hashCanonicalJson({ model: 'deterministic-no-llm-probe' }),
    reasonHash: hashCanonicalJson({ reason: 'real-executor-connected-lineage' }),
  });
  const contentReadyTerminal = createContentReadyTerminalEvidence({
    analysisFixpointHash: analysisFixpoint.fixpointHash,
    authoredFingerprint: expressionSet.proposals[0].authoredFingerprint,
  });
  const terminalResolutions = [
    {
      expressionId,
      terminalFate: 'content-ready',
      terminalReceiptId: contentReadyTerminal.terminalReceiptId,
      terminalReceiptHash: contentReadyTerminal.terminalReceiptHash,
    },
  ];
  const coreExpressionSet = createStrictHypothesisExpressionSetReceiptV1({
    expressionSet,
    parentReceipt: null,
    privateCorpusRevision,
    terminalHead: true,
    terminalResolutions,
  });
  if (coreExpressionSet.terminalClosure !== 'expressed') {
    throw new Error('STRICT_AGENT_PUBLIC_TERMINAL_CLOSURE_FAILED');
  }
  return {
    evidence,
    context,
    lineage,
    expressionId,
    expressionSet,
    contentReadyTerminal,
    terminalResolutions,
    coreExpressionSet,
  };
}

function createProducerEvidence(real) {
  const { artifact } = real;
  const sourceFile = artifact.facts.inventory.files[0];
  if (!sourceFile) {
    throw new Error('STRICT_AGENT_PUBLIC_SOURCE_FILE_MISSING');
  }
  const content = Buffer.from(readCertifiedProjectFactsFrozenFile(artifact, sourceFile)).toString(
    'utf8'
  );
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: artifact.sourceVectorHash,
    entries: [
      {
        evidenceEntryId: 'E-agent-public-project-json',
        relativePath: sourceFile.relativePath,
        blobHash: sourceFile.blobSha256,
        contentHash: sha256(content),
        startLine: 1,
        endLine: content.split('\n').length,
        content,
      },
    ],
  });
  return evidence;
}

function createProducerContext(real, semantic, evidence) {
  const { artifact, factExecution, schedule } = real;
  const { epoch, analysisFixpoint, hypothesisId } = semantic;
  return createStrictAnalysisContextProjectionV1({
    runId,
    journalId: 'journal:agent-public-connected-probe',
    manifestHash: factExecution.manifest.manifestHash,
    planCognitionHash: hashCanonicalJson({ kind: 'agent-public-plan-cognition' }),
    planHash: hashCanonicalJson({ kind: 'agent-public-plan' }),
    requiredUniverseHash: real.catalog.catalogHash,
    baselineScheduleHash: schedule.baselineScheduleHash,
    expansionHeadHash: null,
    currentExpandedScheduleHash: analysisFixpoint.finalExpandedScheduleHash,
    finalExpandedScheduleHash: analysisFixpoint.finalExpandedScheduleHash,
    analysisFixpointHash: analysisFixpoint.fixpointHash,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: schedule.lensBindingsHash,
    sourceArtifactHash: artifact.certificationBindingHash,
    sourceRevisionVectorHash: artifact.sourceVectorHash,
    questionIds: ['question:agent-public-config-authority'],
    factQueryObligationIds: analysisFixpoint.terminalObligations.map((row) => row.obligationId),
    analysisUnitIds: epoch.population.observations.map((row) => row.observationId),
    factIds: factExecution.facts.map((fact) => fact.factId),
    witnessIds: real.witness.bindings.map((binding) => binding.evidenceEntryId),
    populationHashes: [epoch.population.populationHash],
    clusterSetHashes: [epoch.clusterSet.clusterSetHash],
    inductionReceiptHashes: epoch.inductions.map((receipt) => receipt.receiptHash),
    hypothesisIds: [hypothesisId],
    falsificationReceiptHashes: epoch.falsifications.map((receipt) => receipt.receiptHash),
    dispositionReviewIds: epoch.dispositionReviews.map((review) => review.reviewReceiptId),
    evidenceEntryIds: evidence.entries.map((entry) => entry.evidenceEntryId),
    derivedFindingCount: 0,
  });
}

function createAuthoredProjection(evidence) {
  return {
    title: 'Preserve real strict fact execution lineage',
    kind: 'rule',
    doClause: 'Consume Core execution receipts through the strict Agent semantic chain.',
    dontClause: 'Do not replace execution authority with caller-authored receipt hashes.',
    markdown: 'Strict semantic evidence keeps the real executor receipt in population lineage.',
    usageGuide: 'Apply when Agent analysis consumes strict Core fact execution.',
    retrievalProfile: { intents: ['strict semantic evidence authority'] },
    negativeIntent: ['manual receipt fixture'],
    scope: {
      moduleIds: ['agent-production'],
      dimensionIds: ['semantic-evidence'],
    },
    evidenceEntryIds: evidence.entries.map((entry) => entry.evidenceEntryId),
  };
}

function createOrphanReviewFixture(real, semantic) {
  const { epoch, analysisReviewContextHash, finalSchedule, terminalObligations } = semantic;
  const cluster = epoch.clusterSet.clusters[0];
  if (!cluster) {
    throw new Error('STRICT_AGENT_PUBLIC_CLUSTER_MISSING');
  }
  const proposalHash = hashKnowledgeDispositionProposalV1({
    reviewKind: 'semantic-merge',
    populationHash: epoch.population.populationHash,
    sourceClusterSetHash: epoch.clusterSet.clusterSetHash,
    targetClusterSetHash: epoch.clusterSet.clusterSetHash,
    sourceClusterIds: [cluster.clusterId],
    targetClusterIds: [cluster.clusterId],
    observationIds: cluster.observationIds,
    reasonCode: 'orphan-review-must-fail',
  });
  const calibrationReceiptHash = hashCanonicalJson({ proposalHash });
  const actors = createActors(real, proposalHash, {
    reviewKind: 'semantic-merge',
    calibrationReceiptHash,
    verdict: 'pass',
    reasonCode: 'orphan-review-must-fail',
  });
  return createKnowledgeDispositionReviewV1({
    reviewKind: 'semantic-merge',
    currentAnalysisFixpointHash: analysisReviewContextHash,
    populationHash: epoch.population.populationHash,
    proposedDispositionHash: proposalHash,
    executionReceipts: [real.executionReceipt],
    finalExpandedSchedule: finalSchedule,
    terminalObligations,
    producer: actors.producer,
    reviewer: actors.reviewer,
    calibrationReceiptHash,
    verdict: 'pass',
    reasonCode: 'orphan-review-must-fail',
  });
}

function createReboundReviewFixture(real, semantic) {
  const reboundContextHash = hashCanonicalJson({
    kind: 'rebound-analysis-review-context',
    original: semantic.analysisReviewContextHash,
  });
  const actors = createActors(real, semantic.proposalHash, {
    reviewKind: 'falsification',
    calibrationReceiptHash: semantic.dispositionReview.calibrationReceiptHash,
    verdict: 'pass',
    reasonCode: 'real-executor-evidence-reviewed',
  });
  return createKnowledgeDispositionReviewV1({
    reviewKind: 'falsification',
    currentAnalysisFixpointHash: reboundContextHash,
    populationHash: semantic.epoch.population.populationHash,
    proposedDispositionHash: semantic.proposalHash,
    executionReceipts: [real.executionReceipt],
    finalExpandedSchedule: semantic.finalSchedule,
    terminalObligations: semantic.terminalObligations,
    producer: actors.producer,
    reviewer: actors.reviewer,
    calibrationReceiptHash: semantic.dispositionReview.calibrationReceiptHash,
    verdict: 'pass',
    reasonCode: 'real-executor-evidence-reviewed',
  });
}

async function runFaultMatrix(real, semantic, producer, orphanReview, reboundReview) {
  return [
    ...(await runPopulationFaults(real, semantic)),
    ...(await runSemanticChainFaults(semantic, producer, orphanReview, reboundReview)),
  ];
}

async function runPopulationFaults(real, semantic) {
  const { epochInput } = semantic;
  const reboundHash = (label, value) => hashCanonicalJson({ label, reboundFrom: value });
  const withPopulation = (mutate) =>
    validateStrictAnalystEpochV1({
      ...epochInput,
      population: mutate(epochInput.population),
    });
  return [
    await faultCard(
      'execution-receipt-rebind',
      'agent-population',
      'POPULATION_EXECUTION_RECEIPT_SET_MISMATCH',
      () =>
        withPopulation((population) => ({
          ...population,
          denominator: {
            ...population.denominator,
            executionReceiptHashes: [
              reboundHash('execution-receipt', real.executionReceipt.receiptHash),
            ],
          },
        }))
    ),
    await faultCard(
      'execution-output-rebind',
      'agent-population',
      'POPULATION_EXECUTION_RECEIPT_SET_MISMATCH',
      () =>
        withPopulation((population) => ({
          ...population,
          denominator: {
            ...population.denominator,
            outputHashes: [reboundHash('execution-output', real.executionReceipt.outputHash)],
          },
        }))
    ),
    await faultCard(
      'execution-denominator-rebind',
      'agent-population',
      'POPULATION_EXECUTION_RECEIPT_SET_MISMATCH',
      () =>
        withPopulation((population) => ({
          ...population,
          denominator: {
            ...population.denominator,
            denominatorHashes: [
              reboundHash('execution-denominator', real.executionReceipt.denominatorHash),
            ],
          },
        }))
    ),
    await faultCard(
      'incomplete-population',
      'agent-population',
      'STRICT_ANALYST_POPULATION_INCOMPLETE',
      () =>
        withPopulation((population) => ({
          ...population,
          denominator: {
            ...population.denominator,
            complete: false,
            truncated: true,
            continuation: 'cursor:probe-incomplete',
          },
        }))
    ),
  ];
}

async function runSemanticChainFaults(semantic, producer, orphanReview, reboundReview) {
  const { epochInput } = semantic;
  return [
    await faultCard(
      'missing-induction',
      'agent-induction',
      'STRICT_ANALYST_INDUCTION_CLUSTER_CONSERVATION',
      () => validateStrictAnalystEpochV1({ ...epochInput, inductionInputs: [] })
    ),
    await faultCard(
      'missing-falsification',
      'agent-falsification',
      'STRICT_ANALYST_FALSIFICATION_CONSERVATION',
      () => validateStrictAnalystEpochV1({ ...epochInput, falsificationInputs: [] })
    ),
    await faultCard(
      'missing-declared-review',
      'agent-review-ledger',
      'STRICT_ANALYST_DISPOSITION_REVIEW_CONSERVATION',
      () => validateStrictAnalystEpochV1({ ...epochInput, dispositionReviews: [] })
    ),
    await faultCard(
      'orphan-review',
      'agent-review-ledger',
      'STRICT_ANALYST_DISPOSITION_REVIEW_CONSERVATION',
      () =>
        validateStrictAnalystEpochV1({
          ...epochInput,
          dispositionReviews: [...epochInput.dispositionReviews, orphanReview],
        })
    ),
    await faultCard(
      'review-context-rebind',
      'agent-falsification',
      'FALSIFICATION_REVIEW_INVALID',
      () =>
        validateStrictAnalystEpochV1({
          ...epochInput,
          falsificationInputs: [
            {
              ...epochInput.falsificationInputs[0],
              dispositionReview: reboundReview,
            },
          ],
          dispositionReviews: [reboundReview],
        })
    ),
    await faultCard(
      'terminal-resolution-omission',
      'agent-terminal-closure',
      'STRICT_EXPRESSION_TERMINAL_RESOLUTION_CONSERVATION',
      () =>
        createStrictHypothesisExpressionSetReceiptV1({
          expressionSet: producer.expressionSet,
          parentReceipt: null,
          privateCorpusRevision,
          terminalHead: true,
          terminalResolutions: [],
        })
    ),
    await faultCard(
      'string-reviewer-injection',
      'agent-falsification',
      'STRICT_ANALYST_STRING_REVIEW_AUTHORITY_FORBIDDEN',
      () =>
        validateStrictAnalystEpochV1({
          ...epochInput,
          falsificationInputs: [
            {
              ...epochInput.falsificationInputs[0],
              counterqueryApplicability: {
                ...epochInput.falsificationInputs[0].counterqueryApplicability,
                reviewerReceiptId: semantic.dispositionReview.reviewReceiptId,
              },
            },
          ],
        })
    ),
  ];
}

async function faultCard(mutation, stage, expectedCode, action) {
  let actualCode = null;
  try {
    await action();
  } catch (err) {
    actualCode = err instanceof Error ? err.message : String(err);
  }
  if (actualCode !== expectedCode) {
    throw new Error(
      `STRICT_AGENT_PUBLIC_FAULT_PROBE_FAILED:${mutation}:${actualCode ?? 'no-error'}`
    );
  }
  return {
    mutation,
    stage,
    expectedCode,
    actualCode,
    rejected: true,
  };
}

function writeReport({ surface, real, semantic, producer, durableReview, faults }) {
  if (faults.length !== 11 || faults.some((fault) => fault.rejected !== true)) {
    throw new Error('STRICT_AGENT_PUBLIC_FAULT_MATRIX_INCOMPLETE');
  }
  const cluster = semantic.epoch.clusterSet.clusters[0];
  const induction = semantic.epoch.inductions[0];
  const falsification = semantic.epoch.falsifications[0];
  if (!cluster || !induction || !falsification) {
    throw new Error('STRICT_AGENT_PUBLIC_CONNECTED_CHAIN_INCOMPLETE');
  }
  assertConnectedChainBindings({ real, semantic, producer, cluster, induction, falsification });
  const report = {
    schemaVersion: 2,
    probe: 'alembic-agent-strict-public-facade-fresh-process',
    runtimeBindingCount: surface.runtimeBindingCount,
    forbiddenCount: surface.forbiddenCount,
    publicSubpaths: [
      '@alembic/agent/evaluation',
      '@alembic/agent/production',
      '@alembic/core/production',
      '@alembic/core/project-context-foundation',
    ],
    continuityVerified: true,
    captureValidation: real.captureValidation,
    durableSemanticReview: durableReview,
    connectedChain: {
      executor: {
        realExecutor: true,
        sourceArtifactId: real.artifact.artifactId,
        sourceRevisionVectorHash: real.artifact.sourceVectorHash,
        certificationBindingHash: real.artifact.certificationBindingHash,
        catalogHash: real.catalog.catalogHash,
        registryHash: real.registry.registryHash,
        scheduleHash: real.schedule.factHarvestScheduleHash,
        manifestHash: real.factExecution.manifest.manifestHash,
        receiptHash: real.executionReceipt.receiptHash,
        outputHash: real.executionReceipt.outputHash,
        denominatorHash: real.executionReceipt.denominatorHash,
        terminalReceiptId: real.executionReceipt.terminalReceiptId,
        factIds: real.factExecution.facts.map((fact) => fact.factId),
      },
      population: {
        populationHash: semantic.epoch.population.populationHash,
        completion: semantic.epoch.population.completion,
        executionReceiptHashes: semantic.epoch.population.denominator.executionReceiptHashes,
        outputHashes: semantic.epoch.population.denominator.outputHashes,
        denominatorHashes: semantic.epoch.population.denominator.denominatorHashes,
      },
      cluster: {
        populationHash: semantic.epoch.clusterSet.populationHash,
        clusterSetHash: semantic.epoch.clusterSet.clusterSetHash,
        clusterId: cluster.clusterId,
        clusterHash: hashKnowledgeClusterV1(cluster),
      },
      induction: {
        receiptHash: induction.receiptHash,
        populationHash: induction.populationHash,
        clusterId: induction.clusterId,
        clusterHash: induction.clusterHash,
        hypothesisId: semantic.hypothesisId,
        currentAnalysisFixpointHash: induction.currentAnalysisFixpointHash,
      },
      falsification: {
        receiptHash: falsification.receiptHash,
        hypothesisId: falsification.hypothesisId,
        dispositionReviewReceiptId: falsification.dispositionReviewReceiptId,
        dispositionReviewHash: semantic.dispositionReview.receiptHash,
        producerActorHash: semantic.actors.producer.actorHash,
        reviewerActorHash: semantic.actors.reviewer.actorHash,
        currentAnalysisFixpointHash: falsification.currentAnalysisFixpointHash,
      },
      fixpoint: {
        analysisReviewContextHash: semantic.analysisFixpoint.analysisReviewContextHash,
        fixpointHash: semantic.analysisFixpoint.fixpointHash,
        finalExpandedScheduleHash: semantic.analysisFixpoint.finalExpandedScheduleHash,
        populationHashes: semantic.analysisFixpoint.populationHashes,
        clusterSetHashes: semantic.analysisFixpoint.clusterSetHashes,
        inductionReceiptHashes: semantic.analysisFixpoint.inductionReceiptHashes,
        falsificationReceiptHashes: semantic.analysisFixpoint.falsificationReceiptHashes,
      },
      producer: {
        contextHash: producer.context.contextHash,
        evidenceProjectionHash: producer.evidence.projectionHash,
        lineageHash: producer.lineage.lineageHash,
        knowledgeRootId: producer.lineage.knowledgeRootId,
        populationHash: producer.lineage.populationHash,
        clusterSetHash: producer.lineage.clusterSetHash,
        inductionReceiptHash: producer.lineage.inductionReceiptHash,
        falsificationReceiptHash: producer.lineage.falsificationReceiptHash,
        analysisFixpointHash: producer.lineage.analysisFixpointHash,
        expressionSetId: producer.expressionSet.setId,
        expressionSetHash: producer.expressionSet.setHash,
        authoredFingerprintHash: producer.expressionSet.authoredFingerprintHash,
      },
      terminal: {
        receiptId: producer.coreExpressionSet.receiptId,
        receiptHash: producer.coreExpressionSet.receiptHash,
        hypothesisId: producer.coreExpressionSet.hypothesisId,
        analysisFixpointHash: producer.coreExpressionSet.analysisFixpointHash,
        terminalClosure: producer.coreExpressionSet.terminalClosure,
        g1ReceiptHash: producer.contentReadyTerminal.g1Receipt.receiptHash,
        admissionReceiptHash: producer.contentReadyTerminal.admissionReceipt.receiptHash,
        g2ReceiptHash: producer.contentReadyTerminal.g2Receipt.receiptHash,
        resolutionReceiptId: producer.terminalResolutions[0].terminalReceiptId,
        resolutionReceiptHash: producer.terminalResolutions[0].terminalReceiptHash,
      },
    },
    faults,
  };
  process.stdout.write(`${JSON.stringify({ ...report, reportHash: hashCanonicalJson(report) })}\n`);
}

function assertConnectedChainBindings({
  real,
  semantic,
  producer,
  cluster,
  induction,
  falsification,
}) {
  assertExecutorPopulationBindings(real, semantic);
  assertAnalysisBindings(semantic, cluster, induction, falsification);
  assertProducerTerminalBindings(semantic, producer, induction, falsification);
}

function assertExecutorPopulationBindings(real, semantic) {
  const expectedFactIds = real.factExecution.facts.map((fact) => fact.factId).sort();
  const observedFactIds = semantic.epoch.population.observations
    .flatMap((observation) => observation.factIds)
    .sort();
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (
    !equal(semantic.epoch.population.denominator.executionReceiptHashes, [
      real.executionReceipt.receiptHash,
    ]) ||
    !equal(semantic.epoch.population.denominator.outputHashes, [
      real.executionReceipt.outputHash,
    ]) ||
    !equal(semantic.epoch.population.denominator.denominatorHashes, [
      real.executionReceipt.denominatorHash,
    ]) ||
    !equal(observedFactIds, expectedFactIds)
  ) {
    throw new Error('STRICT_AGENT_PUBLIC_EXECUTOR_POPULATION_BINDING_MISMATCH');
  }
}

function assertAnalysisBindings(semantic, cluster, induction, falsification) {
  if (
    semantic.epoch.clusterSet.populationHash !== semantic.epoch.population.populationHash ||
    induction.populationHash !== semantic.epoch.population.populationHash ||
    induction.clusterId !== cluster.clusterId ||
    induction.clusterHash !== hashKnowledgeClusterV1(cluster) ||
    falsification.hypothesisId !== semantic.hypothesisId ||
    falsification.dispositionReviewReceiptId !== semantic.dispositionReview.reviewReceiptId ||
    semantic.analysisFixpoint.analysisReviewContextHash !== semantic.analysisReviewContextHash ||
    !semantic.analysisFixpoint.populationHashes.includes(
      semantic.epoch.population.populationHash
    ) ||
    !semantic.analysisFixpoint.clusterSetHashes.includes(
      semantic.epoch.clusterSet.clusterSetHash
    ) ||
    !semantic.analysisFixpoint.inductionReceiptHashes.includes(induction.receiptHash) ||
    !semantic.analysisFixpoint.falsificationReceiptHashes.includes(falsification.receiptHash)
  ) {
    throw new Error('STRICT_AGENT_PUBLIC_ANALYSIS_BINDING_MISMATCH');
  }
}

function assertProducerTerminalBindings(semantic, producer, induction, falsification) {
  if (
    producer.lineage.populationHash !== semantic.epoch.population.populationHash ||
    producer.lineage.clusterSetHash !== semantic.epoch.clusterSet.clusterSetHash ||
    producer.lineage.inductionReceiptHash !== induction.receiptHash ||
    producer.lineage.falsificationReceiptHash !== falsification.receiptHash ||
    producer.lineage.analysisFixpointHash !== semantic.analysisFixpoint.fixpointHash ||
    producer.coreExpressionSet.analysisFixpointHash !== semantic.analysisFixpoint.fixpointHash ||
    producer.coreExpressionSet.hypothesisId !== semantic.hypothesisId ||
    producer.coreExpressionSet.terminalClosure !== 'expressed'
  ) {
    throw new Error('STRICT_AGENT_PUBLIC_PRODUCER_TERMINAL_BINDING_MISMATCH');
  }
}

function createContentReadyTerminalEvidence({ analysisFixpointHash, authoredFingerprint }) {
  const g1Receipt = createStrictG1ReceiptV1({
    candidateFingerprint: authoredFingerprint,
    retrievalReadinessHash: hashCanonicalJson({
      kind: 'agent-public-retrieval-readiness',
      analysisFixpointHash,
    }),
    rows: STRICT_G1_HARD_AXES_V1.map((axis) => ({
      axis,
      verdict: 'pass',
      reasonCode: 'agent-public-connected-authority-verified',
      evidenceRefs: [`probe:${axis}`],
    })),
  });
  const corpusInspection = createStrictAcceptedCorpusInspectionV1({
    runId,
    analysisFixpointHash,
    privateCorpusRevision,
    revisionRootManifestHash: hashCanonicalJson({
      kind: 'agent-public-private-corpus-root',
      privateCorpusRevision,
    }),
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
      reasonCode: 'agent-public-novel-candidate',
      targetRecipeId: null,
      targetFingerprint: null,
    },
    algorithmVersion: 'agent-public-connected-probe-admission-v1',
  });
  const g2Receipt = createStrictG2ReceiptV1({
    g1Receipt,
    admissionReceipt,
    reviewedFingerprint: authoredFingerprint,
    producer: {
      identity: 'probe-terminal-producer',
      method: 'deterministic-terminal-fixture',
      modelHash: hashCanonicalJson({ actor: 'probe-terminal-producer' }),
      promptHash: hashCanonicalJson({ prompt: 'probe-terminal-producer' }),
    },
    reviewer: {
      identity: 'probe-terminal-independent-reviewer',
      method: 'deterministic-terminal-fixture',
      modelHash: hashCanonicalJson({ actor: 'probe-terminal-independent-reviewer' }),
      promptHash: hashCanonicalJson({ prompt: 'probe-terminal-independent-reviewer' }),
    },
    rows: STRICT_G2_HARD_AXES_V1.map((axis) => ({
      axis,
      axisVerdict: 'pass',
      score: 2,
      reasonCode: 'agent-public-connected-authority-verified',
      evidenceRefs: [`probe:${axis}`],
      repairable: false,
    })),
    novelty: {
      decision: 'novel-project-specific',
      reasonCode: 'agent-public-project-specific',
      evidenceRefs: ['probe:real-executor-fact'],
    },
    duplicate: {
      decision: 'no-match',
      reasonCode: 'agent-public-complete-corpus-no-match',
      evidenceRefs: ['probe:private-corpus-inspection'],
      admissionAlgorithmVersion: admissionReceipt.algorithmVersion,
      comparedPrivateCorpusRevision: admissionReceipt.privateCorpusRevision,
      matchedRecipeIds: [],
      matchedFingerprints: [],
      targetRecipeId: null,
      consolidationFingerprint: null,
    },
    repairAttempt: 0,
    calibrationReceiptHash: hashCanonicalJson({
      kind: 'agent-public-g2-calibration',
      analysisFixpointHash,
    }),
    ruleVersion: 'agent-public-connected-probe-g2-v1',
    permittedRepairFields: [],
  });
  return {
    g1Receipt,
    corpusInspection,
    admissionReceipt,
    g2Receipt,
    terminalReceiptId: `g2:${g2Receipt.receiptHash.slice(7, 31)}`,
    terminalReceiptHash: g2Receipt.receiptHash,
  };
}

function createActors(real, proposalHash, decision) {
  const create = (role) => {
    const loadReceiptHash = hashCanonicalJson({
      kind: 'deterministic-agent-public-review-actor-load',
      role,
      providerId: 'provider:deterministic-probe-fixture',
      modelId: 'model:strict-probe-no-llm',
      modelVersion: '2026-07-27',
    });
    const promptHash = hashCanonicalJson({
      kind: 'knowledge-disposition-review-prompt',
      role,
      reviewKind: decision.reviewKind,
      familyId: real.family.id,
      queryPackHash: real.family.queryPackHash,
      proposalHash,
    });
    const outputHash =
      role === 'producer'
        ? proposalHash
        : hashCanonicalJson({
            kind: 'knowledge-disposition-review-verdict',
            reviewKind: decision.reviewKind,
            proposalHash,
            manifestHash: real.factExecution.manifest.manifestHash,
            executionReceiptHash: real.executionReceipt.receiptHash,
            verdict: decision.verdict,
            reasonCode: decision.reasonCode,
            calibrationReceiptHash: decision.calibrationReceiptHash,
          });
    return createProductionActorIdentityV1({
      providerId: 'provider:deterministic-probe-fixture',
      modelId: 'model:strict-probe-no-llm',
      modelVersion: '2026-07-27',
      promptHash,
      runId,
      invocationId: `invocation:${role}:${proposalHash.slice(7, 19)}`,
      loadReceiptHash,
      outputHash,
    });
  };
  return { producer: create('producer'), reviewer: create('reviewer') };
}

function createSchedule(family, canonicalSubjectRef) {
  const obligationSemantic = {
    factFamilyId: family.id,
    capabilityId: family.capabilityId,
    canonicalSubjectRef,
    analysisScale: 'file',
    denominator: 'complete-frozen-subject',
  };
  const factHarvestObligations = [
    {
      obligationId: `fact:${hashCanonicalJson(obligationSemantic).slice(7, 31)}`,
      ...obligationSemantic,
      source: 'required-universe',
    },
  ];
  const factHarvestScheduleHash = hashCanonicalJson(factHarvestObligations);
  const lensBindings = [];
  const lensBindingsHash = hashCanonicalJson(lensBindings);
  return {
    schemaVersion: 1,
    factHarvestObligations,
    lensBindings,
    factHarvestScheduleHash,
    lensBindingsHash,
    baselineScheduleHash: hashCanonicalJson({ factHarvestScheduleHash, lensBindingsHash }),
  };
}

function createPlanningFacts(artifact) {
  return {
    schemaVersion: 1,
    factsHash: artifact.factsContentHash,
    sourceRevisionVectorHash: artifact.sourceVectorHash,
    sourceArtifactHash: artifact.certificationBindingHash,
    modules: [
      {
        moduleId: 'core',
        scopeId: 'repo:core',
        relativePath: '.',
        moduleClass: 'production-library',
        ownedProductionFileCount: artifact.facts.inventory.files.length,
        languages: [...new Set(artifact.facts.inventory.files.map((file) => file.language))],
        frameworks: ['nx'],
        roles: ['library'],
        entrypointRefs: [],
        publicSurfaceRefs: [],
        crossRepoEdgeRefs: [],
        boundaryRefs: [],
        ownership: {
          origin: 'certified-project-facts',
          confidence: 1,
          evidenceRefs: ['artifact:inventory'],
        },
      },
    ],
  };
}

function createWitnessMaterial(artifact, ledgerAuthority) {
  const entries = artifact.facts.inventory.files.map((file, index) => {
    const content = Buffer.from(readCertifiedProjectFactsFrozenFile(artifact, file)).toString(
      'utf8'
    );
    return ledgerAuthority.capture.capture({
      tool: 'code.read',
      callId: `call-${index + 1}`,
      file: file.relativePath,
      content,
    });
  });
  const evidenceLedgerSnapshot = ledgerAuthority.read.strictSnapshot();
  const projectContextRefs = artifact.facts.inventory.files.map((file) =>
    createProjectContextFileRef({
      projectRoot: '/certified/agent-public-connected-probe',
      repoId: file.repoId,
      filePath: file.relativePath,
      hash: file.blobSha256,
    })
  );
  const bindings = artifact.facts.inventory.files.map((file, index) =>
    createStrictFactDirectWitnessBindingV1({
      artifact,
      repoId: file.repoId,
      relativePath: file.relativePath,
      evidenceEntry: entries[index],
      evidenceLedgerSnapshot,
      projectContextRef: projectContextRefs[index],
    })
  );
  return {
    evidenceLedgerSnapshot,
    bindings,
    authority: createStrictFactWitnessAuthorityV1({
      artifact,
      evidenceLedgerSnapshot,
      projectContextRefs,
    }),
  };
}

async function createStrictArtifact(root) {
  const fixture = createStrictArtifactFixture(root);
  return captureCertifiedProjectFactsV2(
    fixture.input,
    createStrictArtifactPorts(fixture.sourceFile, fixture.sourceContent)
  );
}

function createStrictArtifactFixture(root) {
  const sourceFile = {
    language: 'json',
    mode: '100644',
    ownerModuleIds: [],
    ownersV2: [],
    relativePath: 'project.json',
  };
  const sourceContent = Buffer.from(
    `${JSON.stringify({
      name: 'agent-public-connected-probe',
      projectType: 'library',
      targets: {
        build: {
          executor: 'nx:run-commands',
          options: { command: 'tsc -p tsconfig.json' },
        },
      },
    })}\n`
  );
  const repository = {
    relativeRoot: '.',
    repoId: 'core',
    scopeId: 'repo:core',
    sourceRoot: root,
  };
  const projectScope = buildProjectScopeManifestV1({
    acceptedScope: {
      projectIdentity: { projectId: 'agent-public-connected-probe', scopeId: 'repo:core' },
      projectMode: 'SINGLE',
      repositories: [{ relativeRoot: '.', repoId: 'core' }],
    },
    controlRoot: root,
    sourceRoots: [{ repoId: 'core', sourceRoot: root }],
  });
  const requestMatrix = buildProjectContextRequestMatrixV2(
    projectScope.manifest,
    createProjectContextRequestAuditPlansV2({
      repository,
      eligibleFiles: [sourceFile],
      projectScopeManifest: projectScope.manifest,
    })
  );
  const input = {
    projectMode: 'SINGLE',
    repositories: [repository],
    inventoryPolicy: {
      excludeDirectories: ['node_modules', '.git'],
      includeExtensions: ['.json'],
      version: 'agent-public-connected-probe-v1',
    },
    detailPolicy: {
      chunkBytes: 256,
      maxPreviewBytes: 256,
      maxSelectedFiles: 1,
    },
    requestPlans: requestMatrix.plans,
    legacyEntries: [],
    projections: Object.fromEntries(
      CERTIFIED_PROJECT_FACTS_CONSUMERS.map((consumer) => [consumer, { consumer }])
    ),
    certification: {
      acceptedConfigHash: hashCanonicalJson({ config: 'probe' }),
      acceptedRuntimeHash: hashCanonicalJson({ runtime: 'probe' }),
      capabilityHash: hashCanonicalJson({ capability: 'config-parser' }),
      parserHash: hashCanonicalJson({ parser: 'nx-project-json' }),
      scopeIdentityHash: projectScope.manifest.canonicalScopeHash,
    },
    projectScope,
    requestMatrix,
  };
  return { sourceFile, sourceContent, input };
}

function createStrictArtifactPorts(sourceFile, sourceContent) {
  return {
    enumerateEligibleFiles: async () => [sourceFile],
    executeRequest: async ({ plan }) => {
      const selector = plan.selector;
      return {
        detectedLanguage: selector.filePath ? 'json' : undefined,
        output: { kind: plan.kind, selector: plan.selector },
        parserRuntime: selector.filePath ? 'ready' : 'not-required',
        queryInitialization: selector.filePath ? 'ready' : 'not-required',
        sourceRanges: selector.filePath
          ? [
              {
                repoId: plan.repoId,
                relativePath: selector.filePath,
                startLine: 1,
                endLine: 1,
              },
            ]
          : [],
        terminalStatus: 'completed',
      };
    },
    observeRevision: async () => ({
      kind: 'git',
      dirty: false,
      commitId: 'a'.repeat(40),
      treeId: 'b'.repeat(40),
    }),
    readFile: async ({ relativePath }) => {
      if (relativePath !== sourceFile.relativePath) {
        throw new Error(`STRICT_AGENT_PUBLIC_PROBE_UNEXPECTED_FILE:${relativePath}`);
      }
      return sourceContent;
    },
    verifySnapshot: async ({ candidate }) => ({
      version: 1,
      verified: true,
      binding: 'git-tree',
      finalRevision: candidate.postRevision,
      eligibleInventoryHash: candidate.eligibleInventoryHash,
      workingTreeContentHash: candidate.workingTreeContentHash,
      treeId:
        candidate.postRevision.kind === 'git'
          ? (candidate.postRevision.treeId ?? undefined)
          : undefined,
      typedReason: 'agent-public-connected-probe-snapshot',
    }),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
