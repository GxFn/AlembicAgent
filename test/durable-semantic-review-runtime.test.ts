import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createStrictEvidenceLedgerSnapshotV1,
  type StrictFactDirectWitnessBindingV1,
} from '@alembic/core/host-agent-workflows';
import type { EvidenceEntry } from '@alembic/core/knowledge';
import {
  assertSemanticDispositionReviewDurableAttestationV4,
  canonicalizeObservationPopulationV1,
  consumeMainSemanticDispositionReviewDurableAttestationV4,
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
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import {
  createDurableSemanticReviewRuntime,
  type DurableSemanticReviewExecuteInputV1,
  type SemanticReviewWitnessAuthorityBundleV1,
  type SemanticReviewWitnessAuthorityLookupV1,
} from '../src/evaluation.js';
import {
  createProductionEvidenceLedgerAuthority,
  type ProductionEvidenceLedgerAuthorityV1,
} from '../src/production.js';
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
  it('loads the authoritative Agent ledger, invokes the provider with Core prompt, and emits a fresh-process V4 durable attestation', async () => {
    const fixture = createFixture();
    fixture.ledgerAuthority.capture.capture({
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
        ledger: fixture.ledgerAuthority.read,
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
          "import { assertSemanticDispositionReviewDurableAttestationV4 } from '@alembic/core/production';",
          "const input = JSON.parse(readFileSync(process.env.ALEMBIC_DURABLE_REVIEW_FIXTURE, 'utf8'));",
          'assertSemanticDispositionReviewDurableAttestationV4(input);',
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
      blobHash: REVIEW_BLOB_HASH,
    });
    expect(attestation.evidenceLoadReceipts[0]?.executionReceiptBindings).toEqual([
      expect.objectContaining({
        executionReceiptHash: fixture.executionReceipt.receiptHash,
        fileExecutionHash: fixture.executionReceipt.fileExecutions[0]?.executionHash,
      }),
    ]);
    expect(() =>
      assertSemanticDispositionReviewDurableAttestationV4({
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

  it('loads one production evidence authority for the exact Core V4 shared-harvest binding set', async () => {
    const fixture = createFixture({
      sharedHarvestAnalysisScales: ['file', 'repository'],
    });
    const invoke = vi.fn(async (prompt: string) => passingDecisionFromCompiledPrompt(prompt));
    const resolve = vi.fn(async () => authorityBundleFor(fixture, fixture.evidenceEntry.id));
    const runtime = await createRuntime(fixture, { invoke, resolve });

    const attestation = await runtime.execute({ semanticRequest: fixture.semanticRequest });
    const expectedReceiptHashes = fixture.executionReceipts
      .map((receipt) => receipt.receiptHash)
      .sort();
    const loadReceipt = requireAt(
      attestation.evidenceLoadReceipts,
      0,
      'shared-harvest evidence load receipt'
    ) as (typeof attestation.evidenceLoadReceipts)[number] & {
      readonly executionReceiptBindings: readonly {
        readonly executionReceiptHash: string;
      }[];
    };
    const lookup = requireAt(resolve.mock.calls, 0, 'shared-harvest witness lookup')[0] as
      | (SemanticReviewWitnessAuthorityLookupV1 & {
          readonly expectedExecutionReceiptBindings: readonly {
            readonly executionReceiptHash: string;
          }[];
        })
      | undefined;
    if (!lookup) {
      throw new Error('TEST_FIXTURE_MISSING:shared-harvest witness lookup');
    }

    expect(new Set(fixture.executionReceipts.map((receipt) => receipt.obligationId)).size).toBe(2);
    expect(new Set(fixture.executionReceipts.map((receipt) => receipt.receiptHash)).size).toBe(2);
    expect(new Set(fixture.executionReceipts.map((receipt) => receipt.harvestKey)).size).toBe(1);
    expect(
      new Set(fixture.executionReceipts.map((receipt) => receipt.harvestReceiptHash)).size
    ).toBe(1);
    expect(
      new Set(
        fixture.executionReceipts.flatMap((receipt) =>
          receipt.fileExecutions.map((execution) => execution.executionHash)
        )
      ).size
    ).toBe(1);
    expect(attestation.schemaVersion).toBe(4);
    expect(attestation.evidenceLoadReceipts).toHaveLength(1);
    expect(
      loadReceipt.executionReceiptBindings.map((binding) => binding.executionReceiptHash).sort()
    ).toEqual(expectedReceiptHashes);
    expect(
      lookup.expectedExecutionReceiptBindings.map((binding) => binding.executionReceiptHash).sort()
    ).toEqual(expectedReceiptHashes);
    expect(resolve).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();

    const verificationRoot = mkdtempSync(
      path.join(tmpdir(), 'alembic-agent-shared-harvest-v4-verification-')
    );
    temporaryRoots.add(verificationRoot);
    const verificationInputPath = path.join(verificationRoot, 'attestation.json');
    writeFileSync(
      verificationInputPath,
      JSON.stringify({
        attestation: JSON.parse(JSON.stringify(attestation)),
        expectedSemanticRequest: JSON.parse(JSON.stringify(fixture.semanticRequest)),
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
          "import { assertSemanticDispositionReviewDurableAttestationV4, consumeMainSemanticDispositionReviewDurableAttestationV4 } from '@alembic/core/production';",
          "const input = JSON.parse(readFileSync(process.env.ALEMBIC_SHARED_HARVEST_V4_FIXTURE, 'utf8'));",
          'assertSemanticDispositionReviewDurableAttestationV4(input);',
          'consumeMainSemanticDispositionReviewDurableAttestationV4(input);',
          "process.stdout.write('fresh-process-v4-verified');",
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          ALEMBIC_SHARED_HARVEST_V4_FIXTURE: verificationInputPath,
        },
      }
    );
    expect(verifierOutput).toBe('fresh-process-v4-verified');
    expect(() =>
      assertSemanticDispositionReviewDurableAttestationV4({
        attestation: JSON.parse(JSON.stringify(attestation)),
        expectedTrustPolicy: JSON.parse(JSON.stringify(runtime.trustPolicy)),
      })
    ).not.toThrow();
    expect(() =>
      consumeMainSemanticDispositionReviewDurableAttestationV4({
        attestation: JSON.parse(JSON.stringify(attestation)),
        expectedSemanticRequest: JSON.parse(JSON.stringify(fixture.semanticRequest)),
        expectedTrustPolicy: JSON.parse(JSON.stringify(runtime.trustPolicy)),
      })
    ).not.toThrow();
  });

  it('rejects caller attempts to remove, add, duplicate, reorder, or truncate the Core binding universe', async () => {
    const fixture = createFixture({
      sharedHarvestAnalysisScales: ['file', 'repository'],
    });
    const invoke = vi.fn(async (prompt: string) => passingDecisionFromCompiledPrompt(prompt));
    const resolve = vi.fn(async () => authorityBundleFor(fixture, fixture.evidenceEntry.id));
    const runtime = await createRuntime(fixture, { invoke, resolve });
    const snapshotBefore = fixture.ledgerAuthority.read.strictSnapshot();
    const attempts: readonly {
      readonly name: string;
      readonly mutate: (request: MutableJson<SemanticDispositionReviewRequestV1>) => void;
    }[] = [
      {
        name: 'missing',
        mutate: (request) => {
          request.executionReceipts.pop();
        },
      },
      {
        name: 'extra',
        mutate: (request) => {
          request.executionReceipts.push({ ...requireAt(request.executionReceipts, 0, 'receipt') });
        },
      },
      {
        name: 'duplicate',
        mutate: (request) => {
          request.executionReceipts[1] = {
            ...requireAt(request.executionReceipts, 0, 'receipt'),
          };
        },
      },
      {
        name: 'reordered',
        mutate: (request) => {
          request.executionReceipts.reverse();
        },
      },
      {
        name: 'partial',
        mutate: (request) => {
          requireAt(
            requireAt(request.executionReceipts, 0, 'receipt').fileExecutions,
            0,
            'file execution'
          ).status = 'partial' as never;
        },
      },
      {
        name: 'truncated',
        mutate: (request) => {
          requireAt(
            requireAt(request.executionReceipts, 0, 'receipt').fileExecutions,
            0,
            'file execution'
          ).truncated = true as never;
        },
      },
    ];

    for (const attempt of attempts) {
      const semanticRequest = JSON.parse(
        JSON.stringify(fixture.semanticRequest)
      ) as MutableJson<SemanticDispositionReviewRequestV1>;
      attempt.mutate(semanticRequest);
      await expect(
        runtime.execute({ semanticRequest } as DurableSemanticReviewExecuteInputV1)
      ).rejects.toMatchObject({
        code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_INVALID',
      });
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(fixture.ledgerAuthority.read.strictSnapshot()).toEqual(snapshotBefore);
  });

  it('rejects serialized V4 binding, harvest, file, witness, blob, source and ledger rebound', async () => {
    const fixture = createFixture({
      sharedHarvestAnalysisScales: ['file', 'repository'],
    });
    const runtime = await createRuntime(fixture, {});
    const snapshotBefore = fixture.ledgerAuthority.read.strictSnapshot();
    const attestation = await runtime.execute({ semanticRequest: fixture.semanticRequest });
    const tamperCases: readonly {
      readonly name: string;
      readonly mutate: (candidate: MutableJson<typeof attestation>) => void;
    }[] = [
      {
        name: 'missing binding',
        mutate: (candidate) => {
          requireAt(
            candidate.evidenceLoadReceipts,
            0,
            'load receipt'
          ).executionReceiptBindings.pop();
        },
      },
      {
        name: 'extra duplicate binding',
        mutate: (candidate) => {
          const bindings = requireAt(
            candidate.evidenceLoadReceipts,
            0,
            'load receipt'
          ).executionReceiptBindings;
          bindings.push({ ...requireAt(bindings, 0, 'binding') });
        },
      },
      {
        name: 'reordered bindings',
        mutate: (candidate) => {
          requireAt(
            candidate.evidenceLoadReceipts,
            0,
            'load receipt'
          ).executionReceiptBindings.reverse();
        },
      },
      {
        name: 'mixed harvest',
        mutate: (candidate) => {
          requireAt(
            requireAt(candidate.evidenceLoadReceipts, 0, 'load receipt').executionReceiptBindings,
            1,
            'binding'
          ).harvestKey = shaText('rebound-harvest');
        },
      },
      {
        name: 'mixed file execution',
        mutate: (candidate) => {
          requireAt(
            requireAt(candidate.evidenceLoadReceipts, 0, 'load receipt').executionReceiptBindings,
            1,
            'binding'
          ).fileExecutionHash = shaText('rebound-file-execution');
        },
      },
      {
        name: 'mixed source revision',
        mutate: (candidate) => {
          requireAt(
            requireAt(candidate.evidenceLoadReceipts, 0, 'load receipt').executionReceiptBindings,
            1,
            'binding'
          ).sourceRevisionVectorHash = shaText('rebound-source-revision');
        },
      },
      {
        name: 'witness rebound',
        mutate: (candidate) => {
          requireAt(candidate.evidenceLoadReceipts, 0, 'load receipt').witnessBindingHash =
            shaText('rebound-witness');
        },
      },
      {
        name: 'blob rebound',
        mutate: (candidate) => {
          requireAt(candidate.evidenceLoadReceipts, 0, 'load receipt').blobHash =
            shaText('rebound-blob');
        },
      },
      {
        name: 'ledger snapshot rebound',
        mutate: (candidate) => {
          requireAt(candidate.evidenceLoadReceipts, 0, 'load receipt').evidenceLedgerSnapshotHash =
            shaText('rebound-ledger-snapshot');
        },
      },
      {
        name: 'ledger entry rebound',
        mutate: (candidate) => {
          requireAt(candidate.evidenceLoadReceipts, 0, 'load receipt').evidenceEntryHash =
            shaText('rebound-ledger-entry');
        },
      },
    ];

    for (const tamperCase of tamperCases) {
      const candidate = JSON.parse(JSON.stringify(attestation)) as MutableJson<typeof attestation>;
      tamperCase.mutate(candidate);
      expect(() =>
        assertSemanticDispositionReviewDurableAttestationV4({
          attestation: candidate,
          expectedTrustPolicy: runtime.trustPolicy,
        })
      ).toThrow();
      expect(() =>
        consumeMainSemanticDispositionReviewDurableAttestationV4({
          attestation: candidate,
          expectedSemanticRequest: fixture.semanticRequest,
          expectedTrustPolicy: runtime.trustPolicy,
        })
      ).toThrow();
    }
    expect(fixture.ledgerAuthority.read.strictSnapshot()).toEqual(snapshotBefore);
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
        dataRoot: '/caller/store',
        jobId: 'job:caller',
        sessionId: 'session:caller',
        dimensionId: 'dimension:caller',
        evidenceStoreId: 'evidence-store:caller',
        evaluatorRunId: 'caller-evaluator',
        attestation: {},
      } as never)
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_FIELDS_INVALID',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a caller-provided structural replacement for the production read facet', async () => {
    const fixture = createFixture();
    const fakeLedger = {
      identity: fixture.ledgerAuthority.identity,
      get: fixture.ledgerAuthority.read.get,
      strictSnapshot: fixture.ledgerAuthority.read.strictSnapshot,
    };

    await expect(createRuntime(fixture, { ledger: fakeLedger })).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_BOOTSTRAP_INVALID',
    });
    await expect(
      createRuntime(fixture, {
        evidenceExtras: {
          evidenceStoreId: 'evidence-store:caller',
          evidenceStoreConfigHash: shaText('caller-config'),
        },
      })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_BOOTSTRAP_INVALID',
    });
  });

  it.each([
    {
      name: 'missing authoritative evidence',
      setup: (fixture: Fixture) => {
        const unrelatedAuthority = createLedgerAuthority();
        unrelatedAuthority.capture.capture({
          tool: 'code.read',
          callId: 'call:unrelated-evidence',
          file: 'src/unrelated.ts',
          content: 'export const unrelated = true;',
        });
        return createRuntime({ ...fixture, ledgerAuthority: unrelatedAuthority }, {});
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
    const snapshotBefore = fixture.ledgerAuthority.read.strictSnapshot();
    const runtime = await setup(fixture);

    await expect(
      runtime.execute({ semanticRequest: fixture.semanticRequest })
    ).rejects.toMatchObject({
      code: expected,
    });
    expect(fixture.ledgerAuthority.read.strictSnapshot()).toEqual(snapshotBefore);
  });

  it('rejects wrong session, caller-built evidence and partial evidence load', async () => {
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
    const cancelledSnapshot = cancelledFixture.ledgerAuthority.read.strictSnapshot();
    const cancelledController = new AbortController();
    cancelledController.abort(new Error('cancel requested'));
    const cancelledRuntime = await createRuntime(cancelledFixture, {});

    await expect(
      cancelledRuntime.execute({
        semanticRequest: cancelledFixture.semanticRequest,
        abortSignal: cancelledController.signal,
      })
    ).rejects.toMatchObject({ code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_CANCELLED' });
    expect(cancelledFixture.ledgerAuthority.read.strictSnapshot()).toEqual(cancelledSnapshot);

    const timedFixture = createFixture();
    const timedSnapshot = timedFixture.ledgerAuthority.read.strictSnapshot();
    const timedRuntime = await createRuntime(timedFixture, {
      timeoutMs: 5,
      invoke: () => new Promise<string>(() => undefined),
    });
    await expect(
      timedRuntime.execute({ semanticRequest: timedFixture.semanticRequest })
    ).rejects.toMatchObject({ code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_TIMEOUT' });
    expect(timedFixture.diagnostics.toJSON().timedOutStages).toContain('durable-semantic-review');
    expect(timedFixture.ledgerAuthority.read.strictSnapshot()).toEqual(timedSnapshot);
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
      assertSemanticDispositionReviewDurableAttestationV4({
        attestation: JSON.parse(JSON.stringify(alternateAttestation)),
        expectedTrustPolicy: JSON.parse(JSON.stringify(pinnedRuntime.trustPolicy)),
      })
    ).toThrow();
  });

  it('rejects reused reviewer invocation/output on the same trusted runtime', async () => {
    const fixture = createFixture();
    const snapshotBefore = fixture.ledgerAuthority.read.strictSnapshot();
    const runtime = await createRuntime(fixture, {
      createInvocationId: () => 'reviewer-invocation:reused',
    });

    await runtime.execute({ semanticRequest: fixture.semanticRequest });
    await expect(
      runtime.execute({ semanticRequest: fixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EXECUTION_REUSED',
    });
    expect(fixture.ledgerAuthority.read.strictSnapshot()).toEqual(snapshotBefore);
  });

  it('rejects a concurrent execution of the same request without a second authority load', async () => {
    const fixture = createFixture();
    const snapshotBefore = fixture.ledgerAuthority.read.strictSnapshot();
    let releaseReviewer: (() => void) | undefined;
    const invoke = vi.fn(
      (prompt: string) =>
        new Promise<string>((resolve) => {
          releaseReviewer = () => resolve(passingDecisionFromCompiledPrompt(prompt));
        })
    );
    const resolve = vi.fn(async () => authorityBundleFor(fixture, fixture.evidenceEntry.id));
    const runtime = await createRuntime(fixture, { invoke, resolve });

    const activeExecution = runtime.execute({ semanticRequest: fixture.semanticRequest });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    await expect(
      runtime.execute({ semanticRequest: fixture.semanticRequest })
    ).rejects.toMatchObject({
      code: 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_CONCURRENT',
    });
    releaseReviewer?.();
    await activeExecution;

    expect(resolve).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(fixture.ledgerAuthority.read.strictSnapshot()).toEqual(snapshotBefore);
  });
});

type MutableJson<T> = T extends readonly (infer Item)[]
  ? MutableJson<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: MutableJson<T[Key]> }
    : T;

interface Fixture {
  readonly ledgerAuthority: ProductionEvidenceLedgerAuthorityV1;
  readonly evidenceEntries: readonly EvidenceEntry[];
  readonly evidenceEntry: EvidenceEntry;
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
  ledgerAuthority: ProductionEvidenceLedgerAuthorityV1,
  subjects: readonly FixtureSubject[],
  sharedHarvestAnalysisScales?: readonly ReturnType<
    typeof createExecutionReceipt
  >['analysisScale'][]
) {
  const evidenceEntries = subjects.map((subject, index) =>
    ledgerAuthority.capture.capture({
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
  const receiptSubjects = sharedHarvestAnalysisScales
    ? sharedHarvestAnalysisScales.map((analysisScale) => ({
        analysisScale,
        subject: requireAt(subjects, 0, 'shared-harvest subject'),
        subjectIndex: 0,
      }))
    : subjects.map((subject, subjectIndex) => ({
        analysisScale: 'file' as const,
        subject,
        subjectIndex,
      }));
  const executionReceipts = receiptSubjects
    .map(({ analysisScale, subject, subjectIndex }) =>
      createExecutionReceipt({
        name: `${subject.name}:${analysisScale}`,
        emittedFactIds: [],
        disposition: 'inspected-no-pattern',
        relativePath: subject.relativePath,
        blobHash: subject.blobHash,
        evidenceEntryId: requireAt(evidenceEntries, subjectIndex, 'evidence entry').id,
        projectContextRefId: requireAt(projectContextRefs, subjectIndex, 'ProjectContext ref').id,
        witnessBindingHash: requireAt(witnessBindings, subjectIndex, 'witness binding').bindingHash,
        analysisScale,
      })
    )
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  return {
    evidenceEntries,
    evidenceLedgerSnapshot,
    witnessBindings,
    executionReceipts,
  };
}

function createInvestigatedEmptyLineage(
  executionReceipts: readonly ReturnType<typeof createExecutionReceipt>[],
  evidenceEntries: readonly EvidenceEntry[]
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
      denominatorHashes: [...new Set(executionReceipts.map((receipt) => receipt.denominatorHash))],
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
    readonly sharedHarvestAnalysisScales?: readonly ReturnType<
      typeof createExecutionReceipt
    >['analysisScale'][];
  } = {}
): Fixture {
  const ledgerAuthority = createLedgerAuthority();
  const subjects = createFixtureSubjects(input.includeSecondEvidence ?? false);
  const {
    evidenceEntries,
    evidenceLedgerSnapshot,
    witnessBindings,
    executionReceipts: authorityExecutionReceipts,
  } = createFixtureEvidenceAuthority(ledgerAuthority, subjects, input.sharedHarvestAnalysisScales);
  const executionReceipts = authorityExecutionReceipts;
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
    ledgerAuthority,
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

function createLedgerAuthority(): ProductionEvidenceLedgerAuthorityV1 {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-agent-durable-review-'));
  temporaryRoots.add(dataRoot);
  return createProductionEvidenceLedgerAuthority({
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
    readonly ledger?: unknown;
    readonly evidenceExtras?: Record<string, unknown>;
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
      ledger: (options.ledger ?? fixture.ledgerAuthority.read) as never,
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
      ...options.evidenceExtras,
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
  return {
    evidenceLedgerSnapshot: fixture.evidenceLedgerSnapshot,
    witnessBinding,
  };
}

function passingDecisionFromCompiledPrompt(compiledPrompt: string): string {
  const parsed = JSON.parse(compiledPrompt) as {
    readonly payload: {
      readonly semanticRequest: SemanticDispositionReviewRequestV1;
      readonly evidenceAuthorities: readonly unknown[];
      readonly schemaVersion: 3;
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
    schemaVersion: 3,
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
