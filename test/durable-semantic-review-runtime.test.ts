import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createStrictEvidenceLedgerSnapshotV1,
  type StrictFactDirectWitnessBindingV1,
} from '@alembic/core/host-agent-workflows';
import {
  assertSemanticDispositionReviewDurableAttestationV3,
  canonicalizeObservationPopulationV1,
  createAgentSemanticDispositionReviewRequestV1,
  createAnalysisFixpointReceiptV1,
  createFinalExpandedMiningScheduleReceiptV1,
  createProductionActorIdentityV1,
  hashKnowledgeDispositionProposalV1,
  type SemanticDispositionReviewerModelLoadReceiptV1,
  type SemanticDispositionReviewRequestV1,
} from '@alembic/core/production';
import { createProjectContextFileRef } from '@alembic/core/project-context-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDurableSemanticReviewRuntime,
  type SemanticReviewWitnessAuthorityBundleV1,
  type SemanticReviewWitnessAuthorityLookupV1,
} from '../src/agent/evaluation/DurableSemanticReviewRuntime.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import {
  createExecutionReceipt,
  STRICT_SOURCE_REVISION,
} from './fixtures/strict-semantic-authority.js';

const REVIEWER_AXES = [
  'empty-population-consistency',
  'fixpoint-population-execution-lineage',
  'frozen-semantic-evidence-grounding',
  'negative-evidence-sufficiency',
  'reviewer-independence',
  'sealed-schedule-terminal-denominator',
  'verdict-sufficiency',
] as const;
const REVIEW_CONTENT =
  'Frozen evidence: the complete source subject was inspected without an eligible mechanism.';
const REVIEW_BLOB_HASH = shaText('durable-semantic-review-source');
const EVIDENCE_STORE_CONFIG_HASH = shaText('agent-evidence-ledger-store-config');
const REVIEWER_RUNTIME_CONFIG_HASH = shaText('reviewer-runtime-config');
const WORKFLOW_RUN_ID = 'strict-workflow:agent-durable-semantic-review';
const EVALUATOR_RUN_ID = 'agent-evaluator:durable-semantic-review';

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  temporaryRoots.clear();
});

describe('DurableSemanticReviewRuntime', () => {
  it('loads the authoritative Agent ledger, invokes the provider with Core prompt, and emits a fresh-process durable attestation', async () => {
    const fixture = createFixture();
    fixture.ledger.append({
      tool: 'code.read',
      callId: 'call:post-fact-ledger-append',
      file: 'src/later.ts',
      content: 'export const laterEvidence = true;',
    });
    const invoke = vi.fn(async (prompt: string) => passingDecisionFromCompiledPrompt(prompt));
    const resolve = vi.fn(async () => authorityBundleFor(fixture, fixture.evidenceEntry.id));
    const { privateKey } = generateKeyPairSync('ed25519');
    const runtime = await createDurableSemanticReviewRuntime({
      signingKey: {
        trustRootId: 'semantic-review-trust:agent-runtime',
        keyId: 'semantic-review-key:agent-runtime',
        loadPrivateKey: async () => privateKey,
      },
      reviewer: {
        provider: {
          name: fixture.modelLoadReceipt.providerId,
          model: fixture.modelLoadReceipt.modelId,
          chatWithTools: async (prompt) => ({ text: await invoke(prompt), functionCalls: null }),
        },
        modelLoadReceipt: fixture.modelLoadReceipt,
        evaluatorRunId: EVALUATOR_RUN_ID,
        createInvocationId: () => 'reviewer-invocation:durable-semantic-review:1',
      },
      evidence: {
        ledger: fixture.ledger,
        evidenceStoreId: 'evidence-store:agent-ledger',
        evidenceStoreConfigHash: EVIDENCE_STORE_CONFIG_HASH,
        witnessAuthority: { resolve },
      },
      timeoutMs: 1_000,
      diagnostics: fixture.diagnostics,
    });

    const attestation = await runtime.execute({ semanticRequest: fixture.semanticRequest });
    const rehydrated = JSON.parse(JSON.stringify(attestation)) as typeof attestation;
    const verificationRoot = mkdtempSync(
      path.join(tmpdir(), 'alembic-agent-durable-review-verification-')
    );
    temporaryRoots.add(verificationRoot);
    const verificationInputPath = path.join(verificationRoot, 'attestation.json');
    writeFileSync(
      verificationInputPath,
      JSON.stringify({
        attestation: rehydrated,
        expectedTrustPolicy: JSON.parse(JSON.stringify(runtime.trustPolicy)),
      })
    );
    const verifierOutput = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import { readFileSync } from 'node:fs';",
          "import { assertSemanticDispositionReviewDurableAttestationV3 } from '@alembic/core/production';",
          "const input = JSON.parse(readFileSync(process.env.ALEMBIC_DURABLE_REVIEW_FIXTURE, 'utf8'));",
          'assertSemanticDispositionReviewDurableAttestationV3(input);',
          "process.stdout.write('fresh-process-verified');",
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          ALEMBIC_DURABLE_REVIEW_FIXTURE: verificationInputPath,
        },
      }
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(attestation.execution.request.compiledPrompt);
    expect(resolve).toHaveBeenCalledOnce();
    expect(verifierOutput).toBe('fresh-process-verified');
    expect(attestation.execution.hostExecution.evaluatorRunId).toBe(EVALUATOR_RUN_ID);
    expect(attestation.execution.hostExecution.responseOutput).toBe(
      JSON.stringify(attestation.execution.decision)
    );
    expect(attestation.evidenceLoadReceipts).toHaveLength(1);
    expect(attestation.evidenceLoadReceipts[0]).toMatchObject({
      evidenceEntryId: fixture.evidenceEntry.id,
      evidenceSessionId: fixture.evidenceEntry.sessionId,
      evidenceLedgerSnapshotHash: fixture.evidenceLedgerSnapshot.snapshotHash,
      witnessBindingHash: fixture.witnessBinding.bindingHash,
      executionReceiptHash: fixture.executionReceipt.receiptHash,
      fileExecutionHash: fixture.executionReceipt.fileExecutions[0]?.executionHash,
      blobHash: REVIEW_BLOB_HASH,
    });
    expect(() =>
      assertSemanticDispositionReviewDurableAttestationV3({
        attestation: rehydrated,
        expectedTrustPolicy: JSON.parse(JSON.stringify(runtime.trustPolicy)),
      })
    ).not.toThrow();
    expect(fixture.diagnostics.toJSON()).toMatchObject({
      degraded: false,
      fallbackUsed: false,
      aiErrorCount: 0,
    });
  });

  it('rejects caller injection before evidence or provider execution', async () => {
    const fixture = createFixture();
    const invoke = vi.fn(async (prompt: string) => passingDecisionFromCompiledPrompt(prompt));
    const resolve = vi.fn(async () => authorityBundleFor(fixture, fixture.evidenceEntry.id));
    const runtime = await createRuntime(fixture, { invoke, resolve });

    await expect(
      runtime.execute({
        semanticRequest: fixture.semanticRequest,
        privateKey: 'caller-key',
        trustPolicy: runtime.trustPolicy,
        reviewerHost: { invoke: async () => ({}) },
        evidenceStore: { load: async () => ({}) },
        evaluatorRunId: 'caller-evaluator',
        attestation: {},
      } as never)
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_FIELDS_INVALID',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing authoritative evidence',
      setup: (fixture: Fixture) => {
        const emptyLedger = createLedger();
        emptyLedger.append({
          tool: 'code.read',
          callId: 'call:unrelated-evidence',
          file: 'src/unrelated.ts',
          content: 'export const unrelated = true;',
        });
        return createRuntime({ ...fixture, ledger: emptyLedger }, {});
      },
      expected: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_NOT_FOUND',
    },
    {
      name: 'wrong witness binding',
      setup: (fixture: Fixture) =>
        createRuntime(fixture, {
          resolve: async () =>
            authorityBundleFor(fixture, fixture.evidenceEntry.id, {
              ...fixture.witnessBinding,
              bindingHash: shaText('caller-rebound-binding'),
            }),
        }),
      expected: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
    },
    {
      name: 'wrong witness blob',
      setup: (fixture: Fixture) =>
        createRuntime(fixture, {
          resolve: async () =>
            authorityBundleFor(fixture, fixture.evidenceEntry.id, {
              ...fixture.witnessBinding,
              blobHash: shaText('caller-rebound-blob'),
            }),
        }),
      expected: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
    },
    {
      name: 'wrong ProjectContext ref',
      setup: (fixture: Fixture) =>
        createRuntime(fixture, {
          resolve: async () =>
            authorityBundleFor(fixture, fixture.evidenceEntry.id, {
              ...fixture.witnessBinding,
              projectContextRefId: 'project-context-ref:caller-rebound',
            }),
        }),
      expected: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
    },
    {
      name: 'provider error',
      setup: (fixture: Fixture) =>
        createRuntime(fixture, {
          invoke: async () => {
            throw new Error('provider unavailable');
          },
        }),
      expected: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_PROVIDER_FAILED',
    },
    {
      name: 'permission denial',
      setup: (fixture: Fixture) =>
        createRuntime(fixture, {
          invoke: async () => {
            const error = new Error('permission denied') as Error & { code: string };
            error.code = 'PERMISSION_DENIED';
            throw error;
          },
        }),
      expected: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_PERMISSION_DENIED',
    },
    {
      name: 'malformed response',
      setup: (fixture: Fixture) => createRuntime(fixture, { invoke: async () => '{}' }),
      expected: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_OUTPUT_INVALID',
    },
  ])('fails closed for $name without a fallback review', async ({ setup, expected }) => {
    const fixture = createFixture();
    const runtime = await setup(fixture);

    await expect(
      runtime.execute({ semanticRequest: fixture.semanticRequest })
    ).rejects.toMatchObject({
      code: expected,
    });
  });

  it('rejects wrong session, caller-built evidence, rebound receipt and partial evidence load', async () => {
    const wrongSessionFixture = createFixture({
      requestEvidenceSessionId: 'session:caller-rebound',
    });
    const wrongSessionInvoke = vi.fn(async (prompt: string) =>
      passingDecisionFromCompiledPrompt(prompt)
    );
    const wrongSessionRuntime = await createRuntime(wrongSessionFixture, {
      invoke: wrongSessionInvoke,
    });
    await expect(
      wrongSessionRuntime.execute({ semanticRequest: wrongSessionFixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_NOT_FOUND',
    });
    expect(wrongSessionInvoke).not.toHaveBeenCalled();

    const fixture = createFixture();
    const runtime = await createRuntime(fixture, {});
    for (const semanticRequest of [
      {
        ...fixture.semanticRequest,
        evidence: [
          {
            ...fixture.semanticRequest.evidence[0],
            content: 'caller-authored evidence summary',
          },
        ],
      },
      {
        ...fixture.semanticRequest,
        executionReceipts: [],
      },
    ]) {
      await expect(runtime.execute({ semanticRequest } as never)).rejects.toMatchObject({
        code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_INVALID',
      });
    }

    const reboundFixture = createFixture({ reboundRequestReceipt: true });
    const reboundInvoke = vi.fn(async (prompt: string) =>
      passingDecisionFromCompiledPrompt(prompt)
    );
    const reboundRuntime = await createRuntime(reboundFixture, { invoke: reboundInvoke });
    await expect(
      reboundRuntime.execute({ semanticRequest: reboundFixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
    });
    expect(reboundInvoke).not.toHaveBeenCalled();

    const partialFixture = createFixture({ includeSecondEvidence: true });
    const partialInvoke = vi.fn(async (prompt: string) =>
      passingDecisionFromCompiledPrompt(prompt)
    );
    const partialResolve = vi.fn(
      async (
        lookup: SemanticReviewWitnessAuthorityLookupV1
      ): Promise<SemanticReviewWitnessAuthorityBundleV1 | null> =>
        lookup.evidenceEntryId === partialFixture.evidenceEntry.id
          ? authorityBundleFor(partialFixture, partialFixture.evidenceEntry.id)
          : null
    );
    const partialRuntime = await createRuntime(partialFixture, {
      invoke: partialInvoke,
      resolve: partialResolve,
    });
    await expect(
      partialRuntime.execute({ semanticRequest: partialFixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
    });
    expect(partialResolve).toHaveBeenCalledTimes(2);
    expect(partialInvoke).not.toHaveBeenCalled();
  });

  it('propagates cancellation and timeout without emitting a partial attestation', async () => {
    const cancelledFixture = createFixture();
    const cancelledController = new AbortController();
    cancelledController.abort(new Error('cancel requested'));
    const cancelledRuntime = await createRuntime(cancelledFixture, {});

    await expect(
      cancelledRuntime.execute({
        semanticRequest: cancelledFixture.semanticRequest,
        abortSignal: cancelledController.signal,
      })
    ).rejects.toMatchObject({ code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_CANCELLED' });

    const timedFixture = createFixture();
    const timedRuntime = await createRuntime(timedFixture, {
      timeoutMs: 5,
      invoke: () => new Promise<string>(() => undefined),
    });
    await expect(
      timedRuntime.execute({ semanticRequest: timedFixture.semanticRequest })
    ).rejects.toMatchObject({ code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_TIMEOUT' });
    expect(timedFixture.diagnostics.toJSON().timedOutStages).toContain('durable-semantic-review');
  });

  it('rejects a caller-selected reviewer load and producer self-review', async () => {
    const loadMismatchFixture = createFixture({
      modelLoadReceipt: createModelLoadReceipt({ modelId: 'model:caller-selected' }),
    });
    const trustedRuntime = await createRuntime(loadMismatchFixture, {
      trustedModelLoadReceipt: createModelLoadReceipt(),
    });
    await expect(
      trustedRuntime.execute({ semanticRequest: loadMismatchFixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REVIEWER_LOAD_MISMATCH',
    });

    const selfReviewFixture = createFixture();
    const selfReviewRuntime = await createRuntime(selfReviewFixture, {
      evaluatorRunId: WORKFLOW_RUN_ID,
    });
    await expect(
      selfReviewRuntime.execute({ semanticRequest: selfReviewFixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_NOT_INDEPENDENT',
    });
  });

  it('rejects partial provider output and attestations from an alternate trust policy', async () => {
    const partialFixture = createFixture();
    const partialRuntime = await createRuntime(partialFixture, {
      finishReason: 'length',
    });
    await expect(
      partialRuntime.execute({ semanticRequest: partialFixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_OUTPUT_INVALID',
    });

    const pinnedFixture = createFixture();
    const alternateFixture = createFixture();
    const pinnedRuntime = await createRuntime(pinnedFixture, {
      trustRootId: 'semantic-review-trust:pinned',
      keyId: 'semantic-review-key:pinned',
    });
    const alternateRuntime = await createRuntime(alternateFixture, {
      trustRootId: 'semantic-review-trust:alternate',
      keyId: 'semantic-review-key:alternate',
    });
    const alternateAttestation = await alternateRuntime.execute({
      semanticRequest: alternateFixture.semanticRequest,
    });
    expect(() =>
      assertSemanticDispositionReviewDurableAttestationV3({
        attestation: JSON.parse(JSON.stringify(alternateAttestation)),
        expectedTrustPolicy: JSON.parse(JSON.stringify(pinnedRuntime.trustPolicy)),
      })
    ).toThrow();
  });

  it('rejects reused reviewer invocation/output on the same trusted runtime', async () => {
    const fixture = createFixture();
    const runtime = await createRuntime(fixture, {
      createInvocationId: () => 'reviewer-invocation:reused',
    });

    await runtime.execute({ semanticRequest: fixture.semanticRequest });
    await expect(
      runtime.execute({ semanticRequest: fixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EXECUTION_REUSED',
    });
  });
});

interface Fixture {
  readonly ledger: EvidenceLedgerStore;
  readonly evidenceEntries: readonly NonNullable<ReturnType<EvidenceLedgerStore['get']>>[];
  readonly evidenceEntry: NonNullable<ReturnType<EvidenceLedgerStore['get']>>;
  readonly evidenceLedgerSnapshot: ReturnType<typeof createStrictEvidenceLedgerSnapshotV1>;
  readonly witnessBindings: readonly StrictFactDirectWitnessBindingV1[];
  readonly witnessBinding: StrictFactDirectWitnessBindingV1;
  readonly authorityExecutionReceipts: readonly ReturnType<typeof createExecutionReceipt>[];
  readonly authorityExecutionReceipt: ReturnType<typeof createExecutionReceipt>;
  readonly executionReceipts: readonly ReturnType<typeof createExecutionReceipt>[];
  readonly executionReceipt: ReturnType<typeof createExecutionReceipt>;
  readonly modelLoadReceipt: SemanticDispositionReviewerModelLoadReceiptV1;
  readonly semanticRequest: SemanticDispositionReviewRequestV1;
  readonly diagnostics: DiagnosticsCollector;
}

interface FixtureSubject {
  readonly name: string;
  readonly relativePath: string;
  readonly blobHash: string;
  readonly content: string;
}

function createFixtureSubjects(includeSecondEvidence: boolean): readonly FixtureSubject[] {
  return [
    {
      name: 'durable-review',
      relativePath: 'src/review.ts',
      blobHash: REVIEW_BLOB_HASH,
      content: REVIEW_CONTENT,
    },
    ...(includeSecondEvidence
      ? [
          {
            name: 'durable-review-second',
            relativePath: 'src/review-second.ts',
            blobHash: shaText('durable-semantic-review-source-second'),
            content: `${REVIEW_CONTENT} Second complete subject.`,
          },
        ]
      : []),
  ];
}

function createFixtureEvidenceAuthority(
  ledger: EvidenceLedgerStore,
  subjects: readonly FixtureSubject[]
) {
  const evidenceEntries = subjects.map((subject, index) =>
    ledger.append({
      tool: 'code.read',
      callId: `call:durable-semantic-review-source:${index + 1}`,
      file: subject.relativePath,
      content: subject.content,
    })
  );
  const evidenceLedgerSnapshot = createStrictEvidenceLedgerSnapshotV1(evidenceEntries);
  const projectContextRefs = subjects.map((subject) =>
    createProjectContextFileRef({
      projectRoot: '/frozen/project',
      repoId: 'repo',
      filePath: subject.relativePath,
      hash: subject.blobHash,
    })
  );
  const witnessBindings: readonly StrictFactDirectWitnessBindingV1[] = subjects.map(
    (subject, index) => {
      const evidenceEntry = requireAt(evidenceEntries, index, 'evidence entry');
      const projectContextRef = requireAt(projectContextRefs, index, 'ProjectContext ref');
      const bindingSemantic = {
        schemaVersion: 1 as const,
        sourceArtifactId: 'artifact:durable-semantic-review',
        sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
        repoId: 'repo',
        relativePath: subject.relativePath,
        blobHash: subject.blobHash,
        evidenceEntryId: evidenceEntry.id,
        evidenceSessionId: evidenceEntry.sessionId,
        evidenceContentHash: evidenceEntry.contentHash,
        evidenceEntryHash: hashCanonical(evidenceEntry),
        evidenceEntry,
        evidenceLedgerSnapshotHash: evidenceLedgerSnapshot.snapshotHash,
        projectContextRefId: projectContextRef.id,
        projectContextRefHash: hashCanonical(projectContextRef),
        projectContextRef,
      };
      return {
        ...bindingSemantic,
        bindingHash: hashCanonical(bindingSemantic),
      };
    }
  );
  const executionReceipts = subjects.map((subject, index) =>
    createExecutionReceipt({
      name: subject.name,
      emittedFactIds: [],
      disposition: 'inspected-no-pattern',
      relativePath: subject.relativePath,
      blobHash: subject.blobHash,
      evidenceEntryId: requireAt(evidenceEntries, index, 'evidence entry').id,
      projectContextRefId: requireAt(projectContextRefs, index, 'ProjectContext ref').id,
      witnessBindingHash: requireAt(witnessBindings, index, 'witness binding').bindingHash,
    })
  );
  return {
    evidenceEntries,
    evidenceLedgerSnapshot,
    witnessBindings,
    executionReceipts,
  };
}

function createInvestigatedEmptyLineage(
  executionReceipts: readonly ReturnType<typeof createExecutionReceipt>[],
  evidenceEntries: readonly NonNullable<ReturnType<EvidenceLedgerStore['get']>>[]
) {
  const finalExpandedSchedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: shaText('durable-semantic-review-baseline-schedule'),
    baselineObligationIds: executionReceipts.map((receipt) => receipt.obligationId),
    expansionReceipts: [],
  });
  const observationIds = executionReceipts.map(
    (_, index) => `observation:durable-semantic-review-empty:${index + 1}`
  );
  const population = canonicalizeObservationPopulationV1({
    populationId: 'population:durable-semantic-review-empty',
    revision: 1,
    parentPopulationHash: null,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    denominator: {
      kind: 'frozen-complete-subjects',
      expectedObservationIds: observationIds,
      expectedObligationIds: executionReceipts.map((receipt) => receipt.obligationId),
      executionReceiptHashes: executionReceipts.map((receipt) => receipt.receiptHash),
      outputHashes: executionReceipts.map((receipt) => receipt.outputHash),
      denominatorHashes: executionReceipts.map((receipt) => receipt.denominatorHash),
      complete: true,
      truncated: false,
      continuation: null,
      omittedObservationIds: [],
    },
    executionReceipts,
    observations: [],
    duplicateObservations: [],
    excludedObservations: [],
    errorObservations: [],
    inspectedNoPatternObservations: executionReceipts.map((receipt, index) => ({
      observationId: requireAt(observationIds, index, 'observation id'),
      obligationId: receipt.obligationId,
      canonicalSubjectRef: receipt.canonicalSubjectRef,
      parentSubjectRefs: [],
      executionReceiptHash: receipt.receiptHash,
      outputHash: receipt.outputHash,
      denominatorHash: receipt.denominatorHash,
    })),
  });
  const terminalObligations = executionReceipts.map((receipt) => ({
    obligationId: receipt.obligationId,
    disposition: receipt.disposition,
    terminalReceiptId: receipt.terminalReceiptId,
  }));
  const analysisFixpoint = createAnalysisFixpointReceiptV1({
    finalExpandedSchedule,
    terminalObligations,
    populationHashes: [population.populationHash],
    clusterSets: [],
    inductionReceiptHashes: [],
    falsificationReceiptHashes: [],
  });
  const executionBindings = executionReceipts.map((receipt) => ({
    obligationId: receipt.obligationId,
    executionReceiptHash: receipt.receiptHash,
    executionOutputHash: receipt.outputHash,
    denominatorHash: receipt.denominatorHash,
    disposition: receipt.disposition,
    terminalReceiptId: receipt.terminalReceiptId,
  }));
  const proposal = {
    reviewKind: 'investigated-empty' as const,
    populationHash: population.populationHash,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
    currentAnalysisFixpointHash: analysisFixpoint.fixpointHash,
    expectedObligationIds: executionReceipts.map((receipt) => receipt.obligationId),
    executionBindings,
    evidenceEntryIds: evidenceEntries.map((entry) => entry.id),
  };
  return {
    finalExpandedSchedule,
    population,
    analysisFixpoint,
    proposal,
    proposedDispositionHash: hashKnowledgeDispositionProposalV1(proposal),
  };
}

function createFixture(
  input: {
    readonly modelLoadReceipt?: SemanticDispositionReviewerModelLoadReceiptV1;
    readonly includeSecondEvidence?: boolean;
    readonly requestEvidenceSessionId?: string;
    readonly reboundRequestReceipt?: boolean;
  } = {}
): Fixture {
  const ledger = createLedger();
  const subjects = createFixtureSubjects(input.includeSecondEvidence ?? false);
  const {
    evidenceEntries,
    evidenceLedgerSnapshot,
    witnessBindings,
    executionReceipts: authorityExecutionReceipts,
  } = createFixtureEvidenceAuthority(ledger, subjects);
  const executionReceipts = input.reboundRequestReceipt
    ? subjects.map((subject, index) =>
        createExecutionReceipt({
          name: subject.name,
          emittedFactIds: [],
          disposition: 'inspected-no-pattern',
          relativePath: subject.relativePath,
          blobHash: subject.blobHash,
          evidenceEntryId: requireAt(evidenceEntries, index, 'evidence entry').id,
          projectContextRefId: requireAt(witnessBindings, index, 'witness binding')
            .projectContextRefId,
          witnessBindingHash: requireAt(witnessBindings, index, 'witness binding').bindingHash,
          backendProducer: 'loaded:caller-rebound',
        })
      )
    : authorityExecutionReceipts;
  const evidenceEntry = requireAt(evidenceEntries, 0, 'primary evidence entry');
  const witnessBinding = requireAt(witnessBindings, 0, 'primary witness binding');
  const authorityExecutionReceipt = requireAt(
    authorityExecutionReceipts,
    0,
    'primary authority execution receipt'
  );
  const executionReceipt = requireAt(executionReceipts, 0, 'primary execution receipt');
  const { finalExpandedSchedule, population, analysisFixpoint, proposal, proposedDispositionHash } =
    createInvestigatedEmptyLineage(executionReceipts, evidenceEntries);
  const modelLoadReceipt = input.modelLoadReceipt ?? createModelLoadReceipt();
  const semanticRequest = createAgentSemanticDispositionReviewRequestV1({
    strictWorkflowRunId: WORKFLOW_RUN_ID,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    currentAnalysisFixpointHash: analysisFixpoint.fixpointHash,
    populationHash: population.populationHash,
    proposedDispositionHash,
    finalExpandedSchedule,
    executionReceipts,
    evidence: subjects.map((subject, index) => {
      const entry = requireAt(evidenceEntries, index, 'evidence entry');
      const receipt = requireAt(executionReceipts, index, 'execution receipt');
      return {
        evidenceEntryId: entry.id,
        evidenceSessionId: input.requestEvidenceSessionId ?? entry.sessionId,
        sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
        canonicalSubjectRef: receipt.canonicalSubjectRef,
        relativePath: subject.relativePath,
        blobHash: subject.blobHash,
        content: entry.content,
        contentHash: entry.contentHash,
        semanticRole: 'negative-evidence-complete-denominator' as const,
      };
    }),
    calibration: {
      providerId: modelLoadReceipt.providerId,
      modelId: modelLoadReceipt.modelId,
      modelVersion: modelLoadReceipt.modelVersion,
      methodId: modelLoadReceipt.methodId,
      methodVersion: modelLoadReceipt.methodVersion,
      reviewerModelLoadReceipt: modelLoadReceipt,
      calibrationReceiptHash: shaText('durable-semantic-review-calibration'),
      rubricVersion: 'semantic-disposition-rubric-v1',
      axes: REVIEWER_AXES.map((axisId) => ({
        axisId,
        minimumScore: 0.8,
        calibrationEvidenceHash: shaText(`calibration:${axisId}`),
      })),
    },
    producer: createProductionActorIdentityV1({
      providerId: 'agent-producer',
      modelId: 'producer-model',
      modelVersion: 'strict-producer-v1',
      promptHash: shaText('durable-semantic-review-producer-prompt'),
      runId: WORKFLOW_RUN_ID,
      invocationId: 'producer-invocation:durable-semantic-review',
      loadReceiptHash: shaText('durable-semantic-review-producer-load'),
      outputHash: proposedDispositionHash,
    }),
    context: {
      reviewKind: 'investigated-empty',
      analysisFixpoint,
      population,
      proposal,
      negativeEvidenceSufficiency: {
        claim: 'The sealed denominator was fully inspected without an eligible mechanism.',
        requiredAbsencePredicates: ['no-project-specific-recurring-mechanism'],
        inspectedEvidenceEntryIds: evidenceEntries.map((entry) => entry.id),
        reasonCode: 'COMPLETE_NEGATIVE_EVIDENCE',
      },
    },
  });
  return {
    ledger,
    evidenceEntries,
    evidenceEntry,
    evidenceLedgerSnapshot,
    witnessBindings,
    witnessBinding,
    authorityExecutionReceipts,
    authorityExecutionReceipt,
    executionReceipts,
    executionReceipt,
    modelLoadReceipt,
    semanticRequest,
    diagnostics: new DiagnosticsCollector(),
  };
}

function requireAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`TEST_FIXTURE_MISSING:${label}:${index}`);
  }
  return value;
}

function createLedger(): EvidenceLedgerStore {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-agent-durable-review-'));
  temporaryRoots.add(dataRoot);
  return new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job:durable-semantic-review',
    sessionId: 'session:semantic-review',
    dimensionId: 'dimension:semantic-review',
  });
}

function createModelLoadReceipt(
  input: { readonly modelId?: string } = {}
): SemanticDispositionReviewerModelLoadReceiptV1 {
  const semantic = {
    schemaVersion: 1 as const,
    providerId: 'provider:reviewer',
    modelId: input.modelId ?? 'model:reviewer',
    modelVersion: '2026-07-27',
    methodId: 'semantic-disposition-review',
    methodVersion: 'v3',
    runtimeConfigHash: REVIEWER_RUNTIME_CONFIG_HASH,
    credentialLocationSymbol: 'runtime-config:reviewer-credentials',
  };
  return { ...semantic, loadReceiptHash: hashCanonical(semantic) };
}

async function createRuntime(
  fixture: Fixture,
  options: {
    readonly invoke?: (prompt: string) => Promise<string>;
    readonly resolve?: (
      lookup: SemanticReviewWitnessAuthorityLookupV1
    ) => Promise<SemanticReviewWitnessAuthorityBundleV1 | null>;
    readonly timeoutMs?: number;
    readonly evaluatorRunId?: string;
    readonly createInvocationId?: () => string;
    readonly trustedModelLoadReceipt?: SemanticDispositionReviewerModelLoadReceiptV1;
    readonly finishReason?: string;
    readonly trustRootId?: string;
    readonly keyId?: string;
  }
) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const modelLoadReceipt = options.trustedModelLoadReceipt ?? fixture.modelLoadReceipt;
  return createDurableSemanticReviewRuntime({
    signingKey: {
      trustRootId: options.trustRootId ?? 'semantic-review-trust:agent-runtime',
      keyId: options.keyId ?? 'semantic-review-key:agent-runtime',
      loadPrivateKey: async () => privateKey,
    },
    reviewer: {
      provider: {
        name: modelLoadReceipt.providerId,
        model: modelLoadReceipt.modelId,
        chatWithTools: async (prompt) => ({
          text: await (options.invoke ?? passingDecisionFromCompiledPrompt)(prompt),
          functionCalls: null,
          ...(options.finishReason ? { finishReason: options.finishReason } : {}),
        }),
      },
      modelLoadReceipt,
      evaluatorRunId: options.evaluatorRunId ?? EVALUATOR_RUN_ID,
      createInvocationId:
        options.createInvocationId ?? (() => 'reviewer-invocation:durable-semantic-review:1'),
    },
    evidence: {
      ledger: fixture.ledger,
      evidenceStoreId: 'evidence-store:agent-ledger',
      evidenceStoreConfigHash: EVIDENCE_STORE_CONFIG_HASH,
      witnessAuthority: {
        resolve:
          options.resolve ??
          (async (lookup) =>
            fixture.witnessBindings.find(
              (binding) => binding.evidenceEntryId === lookup.evidenceEntryId
            )
              ? authorityBundleFor(fixture, lookup.evidenceEntryId)
              : null),
      },
    },
    timeoutMs: options.timeoutMs ?? 1_000,
    diagnostics: fixture.diagnostics,
  });
}

function authorityBundleFor(
  fixture: Fixture,
  evidenceEntryId: string,
  witnessOverride?: StrictFactDirectWitnessBindingV1
): SemanticReviewWitnessAuthorityBundleV1 {
  const index = fixture.witnessBindings.findIndex(
    (binding) => binding.evidenceEntryId === evidenceEntryId
  );
  const witnessBinding =
    witnessOverride ?? requireAt(fixture.witnessBindings, index, 'authority witness binding');
  const executionReceipt = requireAt(
    fixture.authorityExecutionReceipts,
    index,
    'authority execution receipt'
  );
  const fileExecution = requireAt(executionReceipt.fileExecutions, 0, 'authority file execution');
  return {
    evidenceLedgerSnapshot: fixture.evidenceLedgerSnapshot,
    witnessBinding,
    executionReceipt,
    fileExecutionHash: fileExecution.executionHash,
  };
}

function passingDecisionFromCompiledPrompt(compiledPrompt: string): string {
  const parsed = JSON.parse(compiledPrompt) as {
    readonly payload: {
      readonly semanticRequest: SemanticDispositionReviewRequestV1;
      readonly evidenceAuthorities: readonly unknown[];
      readonly schemaVersion: 2;
      readonly producerRoute: string;
      readonly consumerRoute: string;
    };
  };
  const compiledPromptHash = shaText(compiledPrompt);
  const requestHash = hashCanonical({
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
    axisDecisions: REVIEWER_AXES.map((axisId) => ({
      axisId,
      verdict: 'pass',
      score: 0.95,
      reasonCode: `PASS:${axisId}`,
      evidenceEntryIds: ['E-1'],
    })),
    evidenceFindings: [
      {
        evidenceEntryId: 'E-1',
        axisIds: REVIEWER_AXES,
        finding: 'The frozen negative-evidence denominator is complete.',
        supportsVerdict: true,
      },
    ],
  });
}

function shaText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function hashCanonical(value: unknown): string {
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
