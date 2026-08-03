import {
  buildAnatomyLensCatalogSnapshot,
  buildDimensionCatalogSnapshot,
  buildRequiredFactApplicabilityUniverseV1,
  type CompiledColdStartPlanV2,
  type DimensionCatalogSnapshotV1,
  type PlanCellV1,
} from '@alembic/core/plans';
import {
  buildFactQueryCatalogSnapshot,
  createAnalysisFixpointReceiptV1,
  createFinalExpandedMiningScheduleReceiptV1,
  createStrictTestAutomaticSelectionReceiptV1,
  createStrictTestDimensionExecutionProjectionV1,
  type FactQueryCatalogSnapshotV1,
  type FactQueryExecutionReceiptV1,
  type FactQueryFamilyV1,
  type StrictTestPreflightBindingsV1,
  validateStrictTestPreflightV1,
} from '@alembic/core/production';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { describe, expect, it } from 'vitest';

import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import {
  assertStrictTestDimensionAgentExecutionReceiptV1,
  assertStrictTestDimensionProductionRuntimePortBindingV1,
  bindStrictTestDimensionProductionRuntimePortV1,
  createStrictTestDimensionAgentAuthorityV1,
  createStrictTestDimensionAgentCellAnalysisEvidenceV1,
  createStrictTestDimensionAgentCellStageEvidenceV1,
  createStrictTestDimensionAgentExecutionReceiptV1,
  createStrictTestDimensionAgentPipelineExecutionV1,
} from '../src/agent/production/StrictTestDimensionAgentContract.js';
import type {
  AgentRuntimeLike,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { AgentService } from '../src/agent/service/AgentService.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';
import {
  createExecutionReceipt,
  STRICT_SOURCE_REVISION,
} from './fixtures/strict-semantic-authority.js';
import {
  createStrictTestDurableReviewEvidence,
  type PreparedStrictTestDurableEvidence,
  prepareStrictTestDurableEvidence,
} from './fixtures/strict-test-durable-review.js';

const MODULES = [
  {
    moduleId: 'module-a',
    scopeId: 'repo:module-a',
    relativePath: 'src/module-a',
    moduleClass: 'production-library',
    ownedProductionFileCount: 12,
    languages: ['typescript'],
    frameworks: [],
    roles: ['library'],
    entrypointRefs: ['ref:module-a:index'],
    publicSurfaceRefs: ['ref:module-a:exports'],
    crossRepoEdgeRefs: [],
    boundaryRefs: ['ref:module-a:boundary'],
    ownership: {
      origin: 'project-context' as const,
      confidence: 1,
      evidenceRefs: ['ref:module-a'],
    },
  },
  {
    moduleId: 'module-b',
    scopeId: 'repo:module-b',
    relativePath: 'src/module-b',
    moduleClass: 'production-library',
    ownedProductionFileCount: 12,
    languages: ['typescript'],
    frameworks: [],
    roles: ['library'],
    entrypointRefs: ['ref:module-b:index'],
    publicSurfaceRefs: ['ref:module-b:exports'],
    crossRepoEdgeRefs: [],
    boundaryRefs: ['ref:module-b:boundary'],
    ownership: {
      origin: 'project-context' as const,
      confidence: 1,
      evidenceRefs: ['ref:module-b'],
    },
  },
] as const;

const FACT_FAMILIES: readonly FactQueryFamilyV1[] = [
  family('syntax-idiom', 'tree-sitter-query'),
  family('architecture-dependency', 'certified-project-context'),
  family('api-protocol', 'accepted-semantic-relations'),
  family('lifecycle-error-invariant', 'accepted-static-invariants'),
  family('config-build-test-migration', 'frozen-config-parsers'),
  family('history-fix-pattern', 'accepted-frozen-history'),
  family('synthesis-cross-cutting', 'accepted-observation-aggregation'),
];

const FACT_QUERY_CATALOG: FactQueryCatalogSnapshotV1 = buildFactQueryCatalogSnapshot(FACT_FAMILIES);

function strictRuntimePort(
  authority?: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>
) {
  const expansionPort = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: authority?.fullBaselineScheduleHash ?? 'schedule-1',
    baselineObligationIds: authority?.compiledPlan.schedule.factHarvestObligations.map(
      (row) => row.obligationId
    ) ?? ['obligation-1'],
    knownFactFamilies: [],
    knownSubjectRefs: [],
    obligationCap: 1,
  });
  const finalSchedule = expansionPort.seal();
  const context = createStrictAnalysisContextProjectionV1({
    runId: authority?.runId ?? 'strict-test-run',
    journalId: 'strict-test-journal',
    manifestHash: 'manifest-1',
    planCognitionHash: authority?.planCognitionHash ?? 'plan-cognition-1',
    planHash: authority?.compiledPlanHash ?? 'plan-1',
    requiredUniverseHash: authority?.fullApplicabilityUniverseHash ?? 'universe-1',
    baselineScheduleHash: authority?.fullBaselineScheduleHash ?? 'schedule-1',
    expansionHeadHash: null,
    currentExpandedScheduleHash: 'schedule-1',
    finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    analysisFixpointHash: 'fixpoint-1',
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: authority?.compiledPlan.schedule.lensBindingsHash ?? 'lens-1',
    sourceArtifactHash: authority?.certifiedProjectFactsSourceArtifactHash ?? 'artifact-1',
    sourceRevisionVectorHash: authority?.sourceRevisionVectorHash ?? 'vector-1',
    questionIds: ['question-1'],
    factQueryObligationIds: ['obligation-1'],
    analysisUnitIds: ['analysis-unit-1'],
    factIds: [],
    witnessIds: [],
    populationHashes: [],
    clusterSetHashes: [],
    inductionReceiptHashes: [],
    hypothesisIds: [],
    falsificationReceiptHashes: [],
    dispositionReviewIds: [],
    evidenceEntryIds: [],
    derivedFindingCount: 0,
  });
  const epoch = createStrictAnalysisEpochSnapshotV1({
    epoch: 1,
    context,
    populations: [],
    terminalObligationIds: ['obligation-1'],
    outstandingObligationIds: [],
  });
  return {
    enabled: true as const,
    analysisLimits: { maxEpochs: 1, maxObligations: 1 },
    expansionPort,
    readAnalysisEpoch: () => epoch,
    buildProducerInput: () => ({
      analysisFixpointHash: 'fixpoint-1',
      producerEligibleHypothesisIds: [],
    }),
    validateAnalystResult: (_source: unknown, observedEpoch: typeof epoch) =>
      createStrictAnalysisGateOutcomeV1({
        action: 'pass',
        reasonCode: 'strict-analysis-fixpoint-stable',
        observedEpochHash: observedEpoch.snapshotHash,
        artifact: { analysisFixpointHash: 'fixpoint-1' },
      }),
    reviewProducerResult: () => ({
      action: 'pass',
      pass: true,
      artifact: { verdict: 'pass', decisionHash: 'review-decision-1' },
    }),
  };
}

type SameRunReviewArtifact = ReturnType<typeof createSameRunReviewArtifact>;
type SameRunAnalysisArtifact = ReturnType<typeof createSameRunAnalysisArtifact>;

function strictSameRunRuntimePort(
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>,
  executionReceipts: readonly FactQueryExecutionReceiptV1[],
  mutateReviewArtifact: (artifact: SameRunReviewArtifact) => SameRunReviewArtifact = (artifact) =>
    artifact,
  mutateAnalysisArtifact: (artifact: SameRunAnalysisArtifact) => SameRunAnalysisArtifact = (
    artifact
  ) => artifact
) {
  const base = strictRuntimePort(authority);
  const factExecution = factExecutionFor(authority, executionReceipts);
  const analysis = analysisLineageFor(authority, executionReceipts);
  let analysisStageEvidence: ReturnType<typeof createSameRunAnalysisArtifact> | null = null;
  return {
    ...base,
    buildProducerInput: () => ({
      analysisFixpointHash: analysis.analysisFixpoint.fixpointHash,
      producerEligibleHypothesisIds: [],
      analysisStageEvidenceHash: analysisStageEvidence?.analysisStageEvidenceHash ?? null,
    }),
    validateAnalystResult: (
      source: unknown,
      observedEpoch: ReturnType<typeof base.readAnalysisEpoch>
    ) => {
      analysisStageEvidence = mutateAnalysisArtifact(
        createSameRunAnalysisArtifact({
          authority,
          source,
          factExecution,
          analysis,
          executionReceipts,
        })
      );
      return createStrictAnalysisGateOutcomeV1({
        action: 'pass',
        reasonCode: 'strict-analysis-fixpoint-stable',
        observedEpochHash: observedEpoch.snapshotHash,
        artifact: analysisStageEvidence,
      });
    },
    reviewProducerResult: (source: unknown) => {
      if (!analysisStageEvidence) {
        throw new Error('STRICT_TEST_FIXTURE_ANALYSIS_STAGE_REQUIRED');
      }
      return {
        action: 'pass',
        pass: true,
        artifact: mutateReviewArtifact(
          createSameRunReviewArtifact({
            authority,
            source,
            analysisStageEvidence,
            executionReceipts,
          })
        ),
      };
    },
  };
}

function createSameRunAnalysisArtifact(input: {
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>;
  source: unknown;
  factExecution: ReturnType<typeof factExecutionFor>;
  analysis: ReturnType<typeof analysisLineageFor>;
  executionReceipts: readonly FactQueryExecutionReceiptV1[];
}) {
  const cells = input.authority.selectedCellIds.map((cellId, index) => {
    const receipt = executionReceiptForCell(input.executionReceipts, cellId, index);
    return createStrictTestDimensionAgentCellAnalysisEvidenceV1({
      cellId,
      factReceiptHashes: [receipt.receiptHash],
      analysis: input.analysis,
    });
  });
  const semantic = {
    kind: 'StrictTestDimensionAgentAnalysisStageEvidenceV1' as const,
    schemaVersion: 1 as const,
    runId: input.authority.runId,
    authorityHash: input.authority.authorityHash,
    selectedCellIds: input.authority.selectedCellIds,
    selectedCellSetHash: input.authority.selectedCellSetHash,
    analystStageResultHash: strictStageResultHash(input.source),
    factExecution: input.factExecution,
    analysis: input.analysis,
    cells,
  };
  return { ...semantic, analysisStageEvidenceHash: hashCanonicalJson(semantic) };
}

function createSameRunReviewArtifact(input: {
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>;
  source: unknown;
  analysisStageEvidence: ReturnType<typeof createSameRunAnalysisArtifact>;
  executionReceipts: readonly FactQueryExecutionReceiptV1[];
}) {
  const producerStageResultHash = strictStageResultHash(input.source);
  const cellDispositions = input.authority.selectedCellIds.map((cellId, index) => {
    const analysisCell = requiredTestRow(
      input.analysisStageEvidence.cells,
      index,
      `analysis cell ${cellId}`
    );
    const disposition = {
      cellId,
      disposition: 'rejected' as const,
      expressionSetReceipts: [],
      semanticReviewAttestations: [],
      dispositionReviewAttestations: [],
      reasonCode: 'independent-review-rejected',
      evidenceRefs: [`evidence:${cellId}`],
    };
    return {
      ...disposition,
      stageEvidence: createStrictTestDimensionAgentCellStageEvidenceV1({
        authority: input.authority,
        analysisCellEvidence: analysisCell,
        producerStageResultHash,
        disposition,
      }),
    };
  });
  const semantic = {
    kind: 'StrictTestDimensionAgentReviewStageEvidenceV1' as const,
    schemaVersion: 1 as const,
    runId: input.authority.runId,
    authorityHash: input.authority.authorityHash,
    selectedCellIds: input.authority.selectedCellIds,
    selectedCellSetHash: input.authority.selectedCellSetHash,
    analysisStageEvidenceHash: input.analysisStageEvidence.analysisStageEvidenceHash,
    producerStageResultHash,
    cellDispositions,
    expectedTrustPolicies: [],
    completedAt: '2026-07-30T06:04:00.000Z',
  };
  return { ...semantic, reviewStageEvidenceHash: hashCanonicalJson(semantic) };
}

function rehashReviewArtifact(artifact: SameRunReviewArtifact): SameRunReviewArtifact {
  const { reviewStageEvidenceHash: _reviewStageEvidenceHash, ...semantic } = artifact;
  return { ...semantic, reviewStageEvidenceHash: hashCanonicalJson(semantic) };
}

function rehashAnalysisArtifact(
  artifact: SameRunAnalysisArtifact,
  cells: SameRunAnalysisArtifact['cells']
): SameRunAnalysisArtifact {
  const { analysisStageEvidenceHash: _analysisStageEvidenceHash, ...existing } = artifact;
  const semantic = { ...existing, cells };
  return { ...semantic, analysisStageEvidenceHash: hashCanonicalJson(semantic) };
}

function rehashCellStageEvidence<T extends SameRunReviewArtifact['cellDispositions'][number]>(
  row: T,
  patch: Partial<T['stageEvidence']>
): T['stageEvidence'] {
  const { cellStageEvidenceHash: _cellStageEvidenceHash, ...existing } = row.stageEvidence;
  const semantic = { ...existing, ...patch };
  return { ...semantic, cellStageEvidenceHash: hashCanonicalJson(semantic) };
}

function strictStageResultHash(value: unknown) {
  const result = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const tokenUsage = (
    result.tokenUsage && typeof result.tokenUsage === 'object' ? result.tokenUsage : {}
  ) as Record<string, unknown>;
  return hashCanonicalJson({
    reply: typeof result.reply === 'string' ? result.reply : '',
    toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
    tokenUsage: {
      input: typeof tokenUsage.input === 'number' ? tokenUsage.input : 0,
      output: typeof tokenUsage.output === 'number' ? tokenUsage.output : 0,
    },
    iterations: typeof result.iterations === 'number' ? result.iterations : 0,
    timedOut: result.timedOut === true,
  });
}

function agentService(
  modelCalls: string[],
  chainCalls?: { runtimeBuildCount: number; pipelineExecuteCount: number }
) {
  return new AgentService({
    runtimeBuilder: {
      build(profile, options): AgentRuntimeLike {
        if (chainCalls) {
          chainCalls.runtimeBuildCount += 1;
        }
        const compiled = profile as CompiledAgentProfile;
        const strategyConfig = compiled.runtimeOverrides.strategy as {
          readonly stages: readonly Record<string, unknown>[];
        };
        const strategy = new PipelineStrategy({
          stages: strategyConfig.stages as Record<string, unknown>[],
        });
        const runtimeId = options?.runId ?? 'strict-test-runtime';
        return {
          id: runtimeId,
          execute: async (message, options) => {
            if (chainCalls) {
              chainCalls.pipelineExecuteCount += 1;
            }
            return strategy.execute(
              {
                id: runtimeId,
                reactLoop: async (prompt: string) => {
                  modelCalls.push(prompt);
                  return {
                    reply:
                      modelCalls.length === 1
                        ? 'analyst terminal result'
                        : 'producer terminal result',
                    toolCalls: [],
                    tokenUsage: { input: 1, output: 1 },
                    iterations: 1,
                  };
                },
              },
              message,
              options
            );
          },
        };
      },
    },
  });
}

function automaticSelectionChain(
  executionReceipts: readonly FactQueryExecutionReceiptV1[] = [],
  excludedCellIds: readonly string[] = [],
  moduleScopeOverrides: Readonly<Record<string, string>> = {}
) {
  const compiledPlan = createCompiledPlan(executionReceipts, excludedCellIds, moduleScopeOverrides);
  const currentBindings = createPreflightBindings();
  const preflight = validateStrictTestPreflightV1(compiledPlan, currentBindings);
  const automaticSelection = createStrictTestAutomaticSelectionReceiptV1({
    preflight,
    currentBindings,
    selectedAt: '2026-07-30T06:01:00.000Z',
  });
  const projection = createStrictTestDimensionExecutionProjectionV1({
    preflight,
    automaticSelection,
    currentBindings,
    projectedAt: '2026-07-30T06:02:00.000Z',
  });
  const authority = createStrictTestDimensionAgentAuthorityV1({
    currentBindings,
    preflight,
    automaticSelection,
    projection,
    compiledPlan,
  });
  return { compiledPlan, currentBindings, preflight, automaticSelection, projection, authority };
}

type ExecutionReceiptInput = Parameters<typeof createStrictTestDimensionAgentExecutionReceiptV1>[0];

function pipelineExecutionFixture(input: {
  readonly authority: ExecutionReceiptInput['authority'];
  readonly factExecution: ExecutionReceiptInput['factExecution'];
  readonly analysis: NonNullable<ExecutionReceiptInput['analysis']>;
  readonly cellDispositions: ExecutionReceiptInput['cellDispositions'];
  readonly expectedTrustPolicies: ExecutionReceiptInput['expectedTrustPolicies'];
}) {
  const analystStageResult = {
    reply: 'fixture analyst result',
    toolCalls: [],
    tokenUsage: { input: 1, output: 1 },
    iterations: 1,
  };
  const producerStageResult = {
    reply: 'fixture producer result',
    toolCalls: [],
    tokenUsage: { input: 1, output: 1 },
    iterations: 1,
  };
  const analysisStageEvidence = createSameRunAnalysisArtifact({
    authority: input.authority,
    source: analystStageResult,
    factExecution: input.factExecution,
    analysis: input.analysis,
    executionReceipts: input.factExecution.receipts,
  });
  const producerStageResultHash = strictStageResultHash(producerStageResult);
  const cellDispositions = input.cellDispositions.map((disposition, index) => {
    const analysisCell = requiredTestRow(
      analysisStageEvidence.cells,
      index,
      `pipeline analysis cell ${disposition.cellId}`
    );
    return {
      ...disposition,
      stageEvidence: createStrictTestDimensionAgentCellStageEvidenceV1({
        authority: input.authority,
        analysisCellEvidence: analysisCell,
        producerStageResultHash,
        disposition,
      }),
    };
  });
  const reviewSemantic = {
    kind: 'StrictTestDimensionAgentReviewStageEvidenceV1' as const,
    schemaVersion: 1 as const,
    runId: input.authority.runId,
    authorityHash: input.authority.authorityHash,
    selectedCellIds: input.authority.selectedCellIds,
    selectedCellSetHash: input.authority.selectedCellSetHash,
    analysisStageEvidenceHash: analysisStageEvidence.analysisStageEvidenceHash,
    producerStageResultHash,
    cellDispositions,
    expectedTrustPolicies: input.expectedTrustPolicies,
    completedAt: '2026-07-30T06:04:00.000Z',
  };
  const reviewStageEvidence = {
    ...reviewSemantic,
    reviewStageEvidenceHash: hashCanonicalJson(reviewSemantic),
  };
  return createStrictTestDimensionAgentPipelineExecutionV1({
    authority: input.authority,
    analystStageResult,
    analysisStageEvidence,
    producerStageResult,
    reviewStageEvidence,
  });
}

describe('strict-test automatic-selection Agent contract', () => {
  it('binds authority runId through the production AgentRuntimeBuilder', () => {
    const unusedToolRoute = async () => {
      throw new Error('STRICT_TEST_BUILDER_PROBE_TOOL_ROUTE_UNUSED');
    };
    const runtime = new AgentRuntimeBuilder({
      container: {},
      toolRegistry: {
        getRouter: () => ({
          execute: unusedToolRoute,
          executeChildCall: unusedToolRoute,
          explain: unusedToolRoute,
        }),
      },
      aiProvider: {},
    }).build({ id: 'chat' }, { runId: 'strict-test-builder-run' });

    expect(runtime.id).toBe('strict-test-builder-run');
  });

  it('returns one same-run canonical receipt from the existing multi-module AgentService chain', async () => {
    const executionReceipts = sameRunExecutionReceipts();
    const chain = automaticSelectionChain(executionReceipts);
    const modelCalls: string[] = [];
    const chainCalls = { runtimeBuildCount: 0, pipelineExecuteCount: 0 };
    const runtimePort = bindStrictTestDimensionProductionRuntimePortV1({
      authority: chain.authority,
      runtimePort: strictSameRunRuntimePort(chain.authority, executionReceipts),
      eligibleCells: chain.authority.selectedCellIds.map((cellId) => {
        const [moduleId, dimensionId] = cellId.split('::');
        return { cellId, moduleId: moduleId ?? '', dimensionId: dimensionId ?? '' };
      }),
    });
    const result = await agentService(modelCalls, chainCalls).run({
      profile: { id: 'generate-dimension' },
      params: { needsCandidates: true },
      message: {
        role: 'internal',
        content: 'Run the automatically selected strict-test dimension.',
      },
      context: {
        source: 'system-workflow',
        strategyContext: { strictProduction: runtimePort },
      },
    });

    expect(result.status).toBe('success');
    expect(result.runId).toBe(chain.authority.runId);
    expect(chainCalls).toEqual({ runtimeBuildCount: 1, pipelineExecuteCount: 1 });
    expect(modelCalls).toHaveLength(2);
    expect(chain.authority.selectedDimensionId).toBe('architecture');
    expect(chain.authority.selectedCellIds).toEqual([
      'module-a::architecture',
      'module-b::architecture',
    ]);
    expect(chain.projection.dimensionStates).toHaveLength(26);
    expect(chain.authority.fullCellUniverseHash).toBe(chain.compiledPlan.universe.cellUniverseHash);
    expect(chain.authority.productionFinalized).toBe(false);
    expect(chain.authority.publicRouteChanged).toBe(false);
    expect(modelCalls.every((prompt) => prompt.includes(chain.authority.authorityHash))).toBe(true);
    expect(modelCalls.every((prompt) => prompt.includes('module-b::architecture'))).toBe(true);
    expect(Object.keys(result.phases ?? {})).toEqual([
      '_strictRoleRouteReceipt',
      'analyze',
      'analyst_fixpoint_gate',
      '_strictAnalysisLoopReceipt',
      '_strictGateReturns',
      'produce',
      'independent_review_gate',
      '_pipelineOutcome',
    ]);
    expect(result.phases?._strictRoleRouteReceipt).toEqual({
      kind: 'StrictRoleRouteReceiptV1',
      strictAnalystCalls: 1,
      strictProducerCalls: 1,
      legacyAnalystCalls: 0,
      legacyProducerCalls: 0,
    });

    const receipt = (
      result as typeof result & {
        readonly strictTestExecutionReceipt?: ReturnType<
          typeof createStrictTestDimensionAgentExecutionReceiptV1
        >;
      }
    ).strictTestExecutionReceipt;
    expect(receipt).toBeDefined();
    expect(receipt).toMatchObject({
      runId: result.runId,
      authorityHash: chain.authority.authorityHash,
      selectedCellIds: chain.authority.selectedCellIds,
      selectedCellSetHash: chain.authority.selectedCellSetHash,
      attemptedCount: 2,
      rejectedCount: 2,
      segmentStatus: 'completed',
    });
    const analyze = result.phases?.analyze as Record<string, unknown>;
    const analysisGate = result.phases?.analyst_fixpoint_gate as {
      artifact?: { resultArtifact?: { analysisStageEvidenceHash?: string } };
    };
    const produce = result.phases?.produce as Record<string, unknown>;
    const reviewGate = result.phases?.independent_review_gate as {
      artifact?: {
        reviewStageEvidenceHash?: string;
        cellDispositions?: SameRunReviewArtifact['cellDispositions'];
      };
    };
    expect(receipt?.pipelineExecution).toMatchObject({
      kind: 'StrictTestDimensionAgentPipelineExecutionV1',
      runId: result.runId,
      authorityHash: chain.authority.authorityHash,
      selectedCellSetHash: chain.authority.selectedCellSetHash,
      analysisStageEvidence: {
        analystStageResultHash: strictStageResultHash(analyze),
        analysisStageEvidenceHash: analysisGate.artifact?.resultArtifact?.analysisStageEvidenceHash,
      },
      reviewStageEvidence: {
        producerStageResultHash: strictStageResultHash(produce),
        reviewStageEvidenceHash: reviewGate.artifact?.reviewStageEvidenceHash,
        cellDispositions: reviewGate.artifact?.cellDispositions,
      },
    });
  });

  it.each([
    {
      name: 'missing terminal cell',
      expectedError: 'STRICT_TEST_DIMENSION_AGENT_REVIEW_CELL_SET_MISMATCH',
      mutate: (artifact: SameRunReviewArtifact) =>
        rehashReviewArtifact({
          ...artifact,
          cellDispositions: artifact.cellDispositions.slice(0, 1),
        }),
    },
    {
      name: 'extra unselected terminal cell',
      expectedError: 'STRICT_TEST_DIMENSION_AGENT_REVIEW_CELL_SET_MISMATCH',
      mutate: (artifact: SameRunReviewArtifact) => {
        const first = requiredTestRow(artifact.cellDispositions, 0, 'extra terminal cell');
        return rehashReviewArtifact({
          ...artifact,
          cellDispositions: [
            ...artifact.cellDispositions,
            {
              ...first,
              cellId: 'module-a::api-protocol',
              stageEvidence: rehashCellStageEvidence(first, {
                cellId: 'module-a::api-protocol',
              }),
            },
          ],
        });
      },
    },
    {
      name: 'duplicate terminal cell',
      expectedError: 'STRICT_TEST_DIMENSION_AGENT_REVIEW_CELL_SET_MISMATCH',
      mutate: (artifact: SameRunReviewArtifact) => {
        const first = requiredTestRow(artifact.cellDispositions, 0, 'duplicate terminal cell');
        return rehashReviewArtifact({ ...artifact, cellDispositions: [first, first] });
      },
    },
    {
      name: 'reordered terminal cells',
      expectedError: 'STRICT_TEST_DIMENSION_AGENT_REVIEW_CELL_SET_MISMATCH',
      mutate: (artifact: SameRunReviewArtifact) =>
        rehashReviewArtifact({
          ...artifact,
          cellDispositions: [...artifact.cellDispositions].reverse(),
        }),
    },
    {
      name: 'cross-run terminal artifact',
      expectedError: 'STRICT_TEST_DIMENSION_AGENT_REVIEW_STAGE_LINEAGE_MISMATCH',
      mutate: (artifact: SameRunReviewArtifact) =>
        rehashReviewArtifact({ ...artifact, runId: 'another-run' }),
    },
    {
      name: 'unselected terminal cell replacement',
      expectedError: 'STRICT_TEST_DIMENSION_AGENT_REVIEW_CELL_SET_MISMATCH',
      mutate: (artifact: SameRunReviewArtifact) => {
        const first = requiredTestRow(artifact.cellDispositions, 0, 'selected terminal cell');
        const second = requiredTestRow(artifact.cellDispositions, 1, 'unselected replacement');
        return rehashReviewArtifact({
          ...artifact,
          cellDispositions: [
            first,
            {
              ...second,
              cellId: 'module-b::api-protocol',
              stageEvidence: rehashCellStageEvidence(second, {
                cellId: 'module-b::api-protocol',
              }),
            },
          ],
        });
      },
    },
    {
      name: 'cross-cell stage evidence swap',
      expectedError: 'STRICT_TEST_DIMENSION_AGENT_CELL_STAGE_LINEAGE_MISMATCH',
      mutate: (artifact: SameRunReviewArtifact) => {
        const first = requiredTestRow(artifact.cellDispositions, 0, 'first stage evidence');
        const second = requiredTestRow(artifact.cellDispositions, 1, 'second stage evidence');
        return rehashReviewArtifact({
          ...artifact,
          cellDispositions: [
            { ...first, stageEvidence: second.stageEvidence },
            { ...second, stageEvidence: first.stageEvidence },
          ],
        });
      },
    },
  ])('rejects $name before terminal success', async ({ mutate, expectedError }) => {
    const executionReceipts = sameRunExecutionReceipts();
    const chain = automaticSelectionChain(executionReceipts);
    const modelCalls: string[] = [];
    const runtimePort = bindStrictTestDimensionProductionRuntimePortV1({
      authority: chain.authority,
      runtimePort: strictSameRunRuntimePort(chain.authority, executionReceipts, mutate),
      eligibleCells: runtimeCells(chain.authority),
    });

    const result = await runStrictAgent(modelCalls, runtimePort);

    expect(modelCalls).toHaveLength(2);
    expect(result.status).toBe('error');
    expect(result.reply).toBe(expectedError);
    expect(
      (
        result as typeof result & {
          readonly strictTestExecutionReceipt?: unknown;
        }
      ).strictTestExecutionReceipt
    ).toBeUndefined();
  });

  it('rejects coherently rehashed arbitrary per-cell producer and review evidence', async () => {
    const executionReceipts = sameRunExecutionReceipts();
    const chain = automaticSelectionChain(executionReceipts);
    const modelCalls: string[] = [];
    const runtimePort = bindStrictTestDimensionProductionRuntimePortV1({
      authority: chain.authority,
      runtimePort: strictSameRunRuntimePort(chain.authority, executionReceipts, (artifact) =>
        rehashReviewArtifact({
          ...artifact,
          cellDispositions: artifact.cellDispositions.map((row) => {
            const stageEvidence = rehashCellStageEvidence(row, {
              producerEvidenceHash: sha(`arbitrary-producer:${row.cellId}`),
              reviewEvidenceHash: sha(`arbitrary-review:${row.cellId}`),
            });
            return { ...row, stageEvidence };
          }),
        })
      ),
      eligibleCells: runtimeCells(chain.authority),
    });

    const result = await runStrictAgent(modelCalls, runtimePort);

    expect(modelCalls).toHaveLength(2);
    expect(result.status).toBe('error');
    expect(result.reply).toBe('STRICT_TEST_DIMENSION_AGENT_CELL_STAGE_OUTPUT_MISMATCH');
    expect(result.strictTestExecutionReceipt).toBeUndefined();
  });

  it('rejects a coherently rehashed cross-cell fact assignment', async () => {
    const executionReceipts = sameRunExecutionReceipts();
    const chain = automaticSelectionChain(executionReceipts);
    const modelCalls: string[] = [];
    const runtimePort = bindStrictTestDimensionProductionRuntimePortV1({
      authority: chain.authority,
      runtimePort: strictSameRunRuntimePort(
        chain.authority,
        executionReceipts,
        (artifact) => artifact,
        (artifact) => {
          const reversed = [...artifact.cells].reverse();
          const cells = artifact.cells.map((row, index) =>
            createStrictTestDimensionAgentCellAnalysisEvidenceV1({
              cellId: row.cellId,
              factReceiptHashes: requiredTestRow(
                reversed,
                index,
                `coherent cross-cell fact assignment ${row.cellId}`
              ).factReceiptHashes,
              analysis: artifact.analysis,
            })
          );
          return rehashAnalysisArtifact(artifact, cells);
        }
      ),
      eligibleCells: runtimeCells(chain.authority),
    });

    const result = await runStrictAgent(modelCalls, runtimePort);

    expect(modelCalls).toHaveLength(2);
    expect(result.status).toBe('error');
    expect(result.reply).toBe('STRICT_TEST_DIMENSION_AGENT_ANALYSIS_CELL_FACT_SCOPE_MISMATCH');
    expect(result.strictTestExecutionReceipt).toBeUndefined();
  });

  it('rejects a forged automatic-selection authority before the first model call', async () => {
    const modelCalls: string[] = [];
    const result = await agentService(modelCalls).run({
      profile: { id: 'generate-dimension' },
      params: { needsCandidates: true },
      message: {
        role: 'internal',
        content: 'Run the automatically selected strict-test dimension.',
      },
      context: {
        source: 'system-workflow',
        strategyContext: {
          strictProduction: {
            ...strictRuntimePort(),
            strictTestAuthority: {
              schemaVersion: 1,
              profile: 'strict-test-dimension',
              automaticSelectionHash: `sha256:${'0'.repeat(64)}`,
              authorityHash: `sha256:${'f'.repeat(64)}`,
            },
            eligibleCells: [
              {
                cellId: 'module-a::architecture',
                moduleId: 'module-a',
                dimensionId: 'architecture',
              },
            ],
          },
        },
      },
    });

    expect(result.status).toBe('error');
    expect(result.reply).toMatch(/STRICT_TEST_DIMENSION_AGENT_AUTHORITY/u);
    expect(modelCalls).toHaveLength(0);
  });

  it.each([
    {
      name: 'missing cell',
      mutate: (rows: ReturnType<typeof runtimeCells>) => rows.slice(0, 1),
    },
    {
      name: 'extra cell',
      mutate: (rows: ReturnType<typeof runtimeCells>) => [
        ...rows,
        {
          cellId: 'module-a::api-protocol',
          moduleId: 'module-a',
          dimensionId: 'api-protocol',
        },
      ],
    },
    {
      name: 'duplicate cell',
      mutate: (rows: ReturnType<typeof runtimeCells>) => {
        const first = requiredTestRow(rows, 0, 'duplicate cell');
        return [first, first];
      },
    },
    {
      name: 'reordered cells',
      mutate: (rows: ReturnType<typeof runtimeCells>) => [...rows].reverse(),
    },
    {
      name: 'wrong dimension',
      mutate: (rows: ReturnType<typeof runtimeCells>) => {
        const first = requiredTestRow(rows, 0, 'wrong-dimension first cell');
        return [
          first,
          {
            cellId: 'module-b::api-protocol',
            moduleId: 'module-b',
            dimensionId: 'api-protocol',
          },
        ];
      },
    },
  ])('rejects $name before the first model call', async ({ mutate }) => {
    const chain = automaticSelectionChain();
    const validPort = bindStrictTestDimensionProductionRuntimePortV1({
      authority: chain.authority,
      runtimePort: strictRuntimePort(chain.authority),
      eligibleCells: runtimeCells(chain.authority),
    });
    const modelCalls: string[] = [];
    const result = await runStrictAgent(modelCalls, {
      ...validPort,
      eligibleCells: mutate(runtimeCells(chain.authority)),
    });

    expect(result.status).toBe('error');
    expect(modelCalls).toHaveLength(0);
  });

  it.each([
    ['cross-demand', { demandKey: 'another-demand' }],
    ['cross-run', { runId: 'another-run' }],
    ['rehashed selection', { selectedDimensionId: 'api-protocol' }],
  ])('rejects a %s authority before the first model call', async (_name, patch) => {
    const chain = automaticSelectionChain();
    const candidate = rehashAuthority({ ...chain.authority, ...patch });
    const modelCalls: string[] = [];
    const result = await runStrictAgent(modelCalls, {
      ...strictRuntimePort(chain.authority),
      strictTestAuthority: candidate,
      eligibleCells: runtimeCells(chain.authority),
    });

    expect(result.status).toBe('error');
    expect(modelCalls).toHaveLength(0);
  });

  it('rejects runtime lineage drift before the first model call', async () => {
    const chain = automaticSelectionChain();
    const modelCalls: string[] = [];
    const result = await runStrictAgent(modelCalls, {
      ...strictRuntimePort(),
      strictTestAuthority: chain.authority,
      eligibleCells: runtimeCells(chain.authority),
    });

    expect(result.status).toBe('error');
    expect(result.reply).toMatch(/RUNTIME_AUTHORITY_LINEAGE_MISMATCH/u);
    expect(modelCalls).toHaveLength(0);
  });

  it('rejects extra fields added after a valid runtime binding', () => {
    const chain = automaticSelectionChain();
    const validPort = bindStrictTestDimensionProductionRuntimePortV1({
      authority: chain.authority,
      runtimePort: strictRuntimePort(chain.authority),
      eligibleCells: runtimeCells(chain.authority),
    });

    expect(() =>
      assertStrictTestDimensionProductionRuntimePortBindingV1({
        ...validPort,
        strictTest: true,
      } as typeof validPort)
    ).toThrow(/BOUND_PORT_FIELDS_INVALID/u);
  });

  it('rejects an excluded cell before the first model call', async () => {
    const chain = automaticSelectionChain([], ['module-b::architecture']);
    const modelCalls: string[] = [];
    const result = await runStrictAgent(modelCalls, {
      ...strictRuntimePort(chain.authority),
      strictTestAuthority: chain.authority,
      eligibleCells: [
        ...runtimeCells(chain.authority),
        {
          cellId: 'module-b::architecture',
          moduleId: 'module-b',
          dimensionId: 'architecture',
        },
      ],
    });

    expect(result.status).toBe('error');
    expect(modelCalls).toHaveLength(0);
  });

  it('rejects stale nested bindings and Certified Project Facts rebound', async () => {
    const chain = automaticSelectionChain();
    for (const candidate of [
      rehashAuthority({
        ...chain.authority,
        currentBindings: {
          ...chain.authority.currentBindings,
          validUntil: '2026-07-30T05:59:59.000Z',
        },
      }),
      rehashAuthority({
        ...chain.authority,
        certifiedProjectFactsArtifactHash: sha('other-facts-artifact'),
      }),
      rehashAuthority({
        ...chain.authority,
        certifiedProjectFactsConsumerReceiptHash: sha('other-facts-consumer'),
      }),
    ]) {
      const modelCalls: string[] = [];
      const result = await runStrictAgent(modelCalls, {
        ...strictRuntimePort(chain.authority),
        strictTestAuthority: candidate,
        eligibleCells: runtimeCells(chain.authority),
      });
      expect(result.status).toBe('error');
      expect(modelCalls).toHaveLength(0);
    }
  });

  it('rejects incomplete own properties even when their values are undefined', async () => {
    const modelCalls: string[] = [];
    const result = await runStrictAgent(modelCalls, {
      ...strictRuntimePort(),
      strictTestAuthority: undefined,
    });

    expect(result.status).toBe('error');
    expect(result.reply).toMatch(/RUNTIME_BINDING_INCOMPLETE/u);
    expect(modelCalls).toHaveLength(0);
  });

  it('rejects a non-enumerable authority override while legacy hints alone stay inert', async () => {
    const chain = automaticSelectionChain();
    const forged = { ...chain.authority };
    Object.defineProperty(forged, 'confirmationHash', {
      value: sha('manual-confirmation'),
      enumerable: false,
    });
    const forgedCalls: string[] = [];
    const forgedResult = await runStrictAgent(forgedCalls, {
      ...strictRuntimePort(chain.authority),
      strictTestAuthority: forged,
      eligibleCells: runtimeCells(chain.authority),
    });
    expect(forgedResult.status).toBe('error');
    expect(forgedCalls).toHaveLength(0);

    const ordinaryCalls: string[] = [];
    const ordinaryResult = await runStrictAgent(ordinaryCalls, {
      ...strictRuntimePort(),
      confirmation: { selectedDimensionId: 'api-protocol' },
      dimensions: ['api-protocol'],
      strictTest: true,
      testMode: true,
    });
    expect(ordinaryResult.status).toBe('success');
    expect(ordinaryCalls).toHaveLength(2);
    expect(ordinaryCalls.every((prompt) => !prompt.includes('automatic execution scope'))).toBe(
      true
    );
    expect(() =>
      bindStrictTestDimensionProductionRuntimePortV1({
        authority: chain.authority,
        runtimePort: {
          ...strictRuntimePort(chain.authority),
          confirmation: { selectedDimensionId: 'architecture' },
        },
        eligibleCells: runtimeCells(chain.authority),
      })
    ).toThrow(/BASE_PORT_FIELDS_INVALID/u);
  });

  it('derives completed, partial, and failed receipt counts without caller-supplied status', () => {
    const executionReceipts = sameRunExecutionReceipts();
    const chain = automaticSelectionChain(executionReceipts);
    const factExecution = factExecutionFor(chain.authority, executionReceipts);
    const analysis = analysisLineageFor(chain.authority, executionReceipts);
    const rejectedRows = chain.authority.selectedCellIds.map((cellId, index) => ({
      cellId,
      disposition: 'rejected' as const,
      expressionSetReceipts: [],
      semanticReviewAttestations: [],
      dispositionReviewAttestations: [],
      reasonCode: `g2-rejected-${index + 1}`,
      evidenceRefs: [`evidence:${cellId}`],
    }));
    expect(() =>
      createStrictTestDimensionAgentExecutionReceiptV1({
        authority: chain.authority,
        factExecution,
        analysis,
        pipelineExecution: null,
        cellDispositions: rejectedRows,
        expectedTrustPolicies: [],
        completedAt: '2026-07-30T06:03:00.000Z',
      })
    ).toThrow(/COMPLETED_STAGE_RECEIPTS_REQUIRED/u);
    const completed = createStrictTestDimensionAgentExecutionReceiptV1({
      authority: chain.authority,
      factExecution,
      analysis,
      pipelineExecution: pipelineExecutionFixture({
        authority: chain.authority,
        factExecution,
        analysis,
        cellDispositions: rejectedRows,
        expectedTrustPolicies: [],
      }),
      cellDispositions: rejectedRows,
      expectedTrustPolicies: [],
      completedAt: '2026-07-30T06:03:00.000Z',
    });
    expect(completed).toMatchObject({
      attemptedCount: 2,
      acceptedCount: 0,
      rejectedCount: 2,
      investigatedEmptyCount: 0,
      failedCount: 0,
      segmentStatus: 'completed',
      productionFinalized: false,
      publicRouteChanged: false,
    });
    expect(() => assertStrictTestDimensionAgentExecutionReceiptV1(completed, [])).not.toThrow();

    const partial = createStrictTestDimensionAgentExecutionReceiptV1({
      authority: chain.authority,
      factExecution,
      analysis: null,
      pipelineExecution: null,
      cellDispositions: [
        requiredTestRow(rejectedRows, 0, 'partial rejected row'),
        {
          ...requiredTestRow(rejectedRows, 1, 'partial failed row'),
          disposition: 'failed',
          reasonCode: 'producer-timeout',
        },
      ],
      expectedTrustPolicies: [],
      completedAt: '2026-07-30T06:04:00.000Z',
    });
    expect(partial).toMatchObject({
      rejectedCount: 1,
      failedCount: 1,
      segmentStatus: 'partial',
    });

    const failed = createStrictTestDimensionAgentExecutionReceiptV1({
      authority: chain.authority,
      factExecution,
      analysis: null,
      pipelineExecution: null,
      cellDispositions: rejectedRows.map((row) => ({
        ...row,
        disposition: 'failed' as const,
        reasonCode: 'analyst-failed',
      })),
      expectedTrustPolicies: [],
      completedAt: '2026-07-30T06:05:00.000Z',
    });
    expect(failed).toMatchObject({ failedCount: 2, segmentStatus: 'failed' });
  });

  it('rejects invalid per-cell evidence and receipt count tampering', () => {
    const chain = automaticSelectionChain();
    const factExecution = emptyFactExecution(chain.authority);
    expect(() =>
      createStrictTestDimensionAgentExecutionReceiptV1({
        authority: chain.authority,
        factExecution,
        analysis: emptyAnalysisLineage(chain.authority),
        pipelineExecution: null,
        cellDispositions: chain.authority.selectedCellIds.map((cellId) => ({
          cellId,
          disposition: 'accepted' as const,
          expressionSetReceipts: [],
          semanticReviewAttestations: [],
          dispositionReviewAttestations: [],
          reasonCode: null,
          evidenceRefs: [],
        })),
        expectedTrustPolicies: [],
        completedAt: '2026-07-30T06:03:00.000Z',
      })
    ).toThrow(/ACCEPTED_EVIDENCE_REQUIRED/u);

    const receipt = createStrictTestDimensionAgentExecutionReceiptV1({
      authority: chain.authority,
      factExecution,
      analysis: null,
      pipelineExecution: null,
      cellDispositions: chain.authority.selectedCellIds.map((cellId) => ({
        cellId,
        disposition: 'failed' as const,
        expressionSetReceipts: [],
        semanticReviewAttestations: [],
        dispositionReviewAttestations: [],
        reasonCode: 'analyst-failed',
        evidenceRefs: [`evidence:${cellId}`],
      })),
      expectedTrustPolicies: [],
      completedAt: '2026-07-30T06:03:00.000Z',
    });
    expect(() =>
      assertStrictTestDimensionAgentExecutionReceiptV1({ ...receipt, failedCount: 1 }, [])
    ).toThrow(/EXECUTION_LINEAGE_MISMATCH/u);
  });

  it('binds a genuine producer non-draft V5 attestation into an accepted cell', async () => {
    const prepared = prepareStrictTestDurableEvidence('accepted');
    try {
      const chain = automaticSelectionChain(
        [prepared.executionReceipt],
        ['module-b::architecture'],
        { 'module-a': prepared.executionReceipt.canonicalSubjectRef }
      );
      const durable = await createStrictTestDurableReviewEvidence(prepared, chain.authority);
      if (!durable.expressionSet) {
        throw new Error('STRICT_TEST_ACCEPTED_EXPRESSION_FIXTURE_REQUIRED');
      }
      const factExecution = durableFactExecution(prepared, chain.authority);
      const analysis = durableAnalysisLineage(chain.authority, durable);
      const cellDispositions = [
        {
          cellId: 'module-a::architecture',
          disposition: 'accepted' as const,
          expressionSetReceipts: [durable.expressionSet],
          semanticReviewAttestations: [durable.attestation],
          dispositionReviewAttestations: [],
          reasonCode: null,
          evidenceRefs: [prepared.evidenceEntry.id],
        },
      ];
      const receipt = createStrictTestDimensionAgentExecutionReceiptV1({
        authority: chain.authority,
        factExecution,
        analysis,
        pipelineExecution: pipelineExecutionFixture({
          authority: chain.authority,
          factExecution,
          analysis,
          cellDispositions,
          expectedTrustPolicies: [durable.trustPolicy],
        }),
        cellDispositions,
        expectedTrustPolicies: [durable.trustPolicy],
        completedAt: '2026-07-30T06:04:00.000Z',
      });

      expect(receipt).toMatchObject({
        attemptedCount: 1,
        acceptedCount: 1,
        segmentStatus: 'completed',
        semanticReviewTrustPolicyHashes: [durable.trustPolicy.policyHash],
      });
      expect(receipt.producerExpressionSetReceiptHashes).toEqual([
        durable.expressionSet.receiptHash,
      ]);
      expect(() =>
        assertStrictTestDimensionAgentExecutionReceiptV1(receipt, [durable.trustPolicy])
      ).not.toThrow();
      expect(() => assertStrictTestDimensionAgentExecutionReceiptV1(receipt, [])).toThrow(
        /ATTESTATION_TRUST_REQUIRED/u
      );
    } finally {
      prepared.dispose();
    }
  });

  it('binds a genuine investigated-empty V5 attestation into a completed cell', async () => {
    const prepared = prepareStrictTestDurableEvidence('investigated-empty');
    try {
      const chain = automaticSelectionChain(
        [prepared.executionReceipt],
        ['module-b::architecture'],
        { 'module-a': prepared.executionReceipt.canonicalSubjectRef }
      );
      const durable = await createStrictTestDurableReviewEvidence(prepared, chain.authority);
      const factExecution = durableFactExecution(prepared, chain.authority);
      const analysis = durableAnalysisLineage(chain.authority, durable);
      const cellDispositions = [
        {
          cellId: 'module-a::architecture',
          disposition: 'investigated-empty' as const,
          expressionSetReceipts: [],
          semanticReviewAttestations: [],
          dispositionReviewAttestations: [durable.attestation],
          reasonCode: null,
          evidenceRefs: [prepared.evidenceEntry.id],
        },
      ];
      const receipt = createStrictTestDimensionAgentExecutionReceiptV1({
        authority: chain.authority,
        factExecution,
        analysis,
        pipelineExecution: pipelineExecutionFixture({
          authority: chain.authority,
          factExecution,
          analysis,
          cellDispositions,
          expectedTrustPolicies: [durable.trustPolicy],
        }),
        cellDispositions,
        expectedTrustPolicies: [durable.trustPolicy],
        completedAt: '2026-07-30T06:04:00.000Z',
      });

      expect(receipt).toMatchObject({
        attemptedCount: 1,
        investigatedEmptyCount: 1,
        segmentStatus: 'completed',
      });
      expect(receipt.dispositionReviewDurableAttestationHashes).toEqual([
        durable.attestation.attestationHash,
      ]);
      expect(() =>
        assertStrictTestDimensionAgentExecutionReceiptV1(receipt, [durable.trustPolicy])
      ).not.toThrow();
    } finally {
      prepared.dispose();
    }
  });
});

function runtimeCells(authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>) {
  return authority.selectedCellIds.map((cellId) => {
    const [moduleId, dimensionId] = cellId.split('::');
    return { cellId, moduleId: moduleId ?? '', dimensionId: dimensionId ?? '' };
  });
}

async function runStrictAgent(modelCalls: string[], strictProduction: Record<string, unknown>) {
  return agentService(modelCalls).run({
    profile: { id: 'generate-dimension' },
    params: { needsCandidates: true },
    message: {
      role: 'internal',
      content: 'Run the strict production dimension.',
    },
    context: {
      source: 'system-workflow',
      strategyContext: { strictProduction },
    },
  });
}

function rehashAuthority(
  authority: Record<string, unknown>
): ReturnType<typeof createStrictTestDimensionAgentAuthorityV1> {
  const { authorityHash: _authorityHash, ...semantic } = authority;
  return {
    ...semantic,
    authorityHash: hashCanonicalJson(semantic),
  } as unknown as ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>;
}

function sameRunExecutionReceipts(): readonly FactQueryExecutionReceiptV1[] {
  return ['module-a', 'module-b']
    .map((moduleId) =>
      createExecutionReceipt({
        name: `strict-test-${moduleId}`,
        emittedFactIds: [],
        canonicalSubjectRef: `repo:${moduleId}`,
        disposition: 'inspected-no-pattern',
        relativePath: `src/${moduleId}/index.ts`,
        blobHash: sha(`blob:${moduleId}`),
        evidenceEntryId: `evidence:${moduleId}:fact`,
        projectContextRefId: `file:repo:src/${moduleId}/index.ts`,
        witnessBindingHash: sha(`witness:${moduleId}`),
        harvestKey: sha(`harvest-key:${moduleId}`),
        harvestReceiptHash: sha(`harvest-receipt:${moduleId}`),
      })
    )
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
}

function executionReceiptForCell(
  receipts: readonly FactQueryExecutionReceiptV1[],
  cellId: string,
  expectedIndex?: number
): FactQueryExecutionReceiptV1 {
  const moduleId = cellId.split('::')[0];
  const receipt = receipts.find((candidate) =>
    candidate.fileExecutions.some((row) => row.relativePath.includes(`/${moduleId}/`))
  );
  if (receipt) {
    return receipt;
  }
  if (expectedIndex !== undefined && receipts.length > expectedIndex) {
    return requiredTestRow(receipts, expectedIndex, `fallback fact receipt ${cellId}`);
  }
  throw new Error(`STRICT_TEST_FIXTURE_CELL_FACT_RECEIPT_REQUIRED:${cellId}`);
}

function factExecutionFor(
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>,
  receipts: readonly FactQueryExecutionReceiptV1[]
) {
  const terminalReceiptIds = receipts.map((receipt) => receipt.terminalReceiptId);
  const terminalReceiptHashes = receipts.map((receipt) => receipt.receiptHash);
  const harvestReceiptHashes = [
    ...new Set(receipts.map((receipt) => receipt.harvestReceiptHash)),
  ].sort();
  const denominatorHashes = [...new Set(receipts.map((receipt) => receipt.denominatorHash))].sort();
  const manifestSemantic = {
    schemaVersion: 1 as const,
    sourceArtifactId: 'artifact:strict-test-same-run',
    sourceRevisionVectorHash: authority.sourceRevisionVectorHash,
    factQueryCatalogHash: authority.fullFactQueryCatalogHash,
    factHarvestScheduleHash: authority.compiledPlan.schedule.factHarvestScheduleHash,
    backendRegistryHash: sha('same-run-backend-registry'),
    obligationCount: receipts.length,
    terminalReceiptIds,
    terminalReceiptHashes,
    terminalReceiptSetHash: hashCanonicalJson(terminalReceiptHashes),
    harvestReceiptHashes,
    harvestCount: harvestReceiptHashes.length,
    denominatorHashes,
    witnessBindingSetHash: hashCanonicalJson(
      receipts.map((receipt) => receipt.witnessBindingHash).sort()
    ),
    factIds: [] as string[],
    factCount: 0,
    unexecutableCatalogFamilyIds: [] as string[],
    unregisteredBackendFamilyIds: [] as string[],
    failedObligationIds: [] as string[],
    unknownObligationIds: [] as string[],
    verdict: 'passed' as const,
  };
  return {
    facts: [],
    receipts,
    manifest: {
      ...manifestSemantic,
      manifestHash: hashCanonicalJson(manifestSemantic),
    },
  };
}

function analysisLineageFor(
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>,
  receipts: readonly FactQueryExecutionReceiptV1[]
) {
  const baselineObligationIds = authority.compiledPlan.schedule.factHarvestObligations.map(
    (row) => row.obligationId
  );
  const finalExpandedSchedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: authority.fullBaselineScheduleHash,
    baselineObligationIds,
    expansionReceipts: [],
  });
  return {
    baselineObligationIds,
    expansionReceipts: [],
    finalExpandedSchedule,
    finalFactSchedule: authority.compiledPlan.schedule,
    analysisFixpoint: createAnalysisFixpointReceiptV1({
      finalExpandedSchedule,
      terminalObligations: receipts.map((receipt) => ({
        obligationId: receipt.obligationId,
        disposition: receipt.disposition,
        terminalReceiptId: receipt.terminalReceiptId,
      })),
      populationHashes: [],
      clusterSets: [],
      inductionReceiptHashes: [],
      falsificationReceiptHashes: [],
    }),
    clusterSets: [],
  };
}

function emptyFactExecution(
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>
) {
  const manifestSemantic = {
    schemaVersion: 1 as const,
    sourceArtifactId: 'artifact:strict-test-empty',
    sourceRevisionVectorHash: authority.sourceRevisionVectorHash,
    factQueryCatalogHash: authority.fullFactQueryCatalogHash,
    factHarvestScheduleHash: authority.compiledPlan.schedule.factHarvestScheduleHash,
    backendRegistryHash: sha('backend-registry'),
    obligationCount: 0,
    terminalReceiptIds: [] as string[],
    terminalReceiptHashes: [] as string[],
    terminalReceiptSetHash: hashCanonicalJson([]),
    harvestReceiptHashes: [] as string[],
    harvestCount: 0,
    denominatorHashes: [] as string[],
    witnessBindingSetHash: hashCanonicalJson([]),
    factIds: [] as string[],
    factCount: 0,
    unexecutableCatalogFamilyIds: [] as string[],
    unregisteredBackendFamilyIds: [] as string[],
    failedObligationIds: [] as string[],
    unknownObligationIds: [] as string[],
    verdict: 'passed' as const,
  };
  return {
    facts: [],
    receipts: [],
    manifest: {
      ...manifestSemantic,
      manifestHash: hashCanonicalJson(manifestSemantic),
    },
  };
}

function emptyAnalysisLineage(
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>
) {
  const finalExpandedSchedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: authority.fullBaselineScheduleHash,
    baselineObligationIds: [],
    expansionReceipts: [],
  });
  return {
    baselineObligationIds: [],
    expansionReceipts: [],
    finalExpandedSchedule,
    finalFactSchedule: authority.compiledPlan.schedule,
    analysisFixpoint: createAnalysisFixpointReceiptV1({
      finalExpandedSchedule,
      terminalObligations: [],
      populationHashes: [],
      clusterSets: [],
      inductionReceiptHashes: [],
      falsificationReceiptHashes: [],
    }),
    clusterSets: [],
  };
}

function durableFactExecution(
  prepared: PreparedStrictTestDurableEvidence,
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>
) {
  const executionReceipt = prepared.executionReceipt;
  const factIds = prepared.facts.map((fact) => fact.factId);
  const manifestSemantic = {
    schemaVersion: 1 as const,
    sourceArtifactId: 'artifact:strict-test-review',
    sourceRevisionVectorHash: authority.sourceRevisionVectorHash,
    factQueryCatalogHash: authority.fullFactQueryCatalogHash,
    factHarvestScheduleHash: authority.compiledPlan.schedule.factHarvestScheduleHash,
    backendRegistryHash: sha('strict-test-review-backend-registry'),
    obligationCount: 1,
    terminalReceiptIds: [executionReceipt.terminalReceiptId],
    terminalReceiptHashes: [executionReceipt.receiptHash],
    terminalReceiptSetHash: hashCanonicalJson([executionReceipt.receiptHash]),
    harvestReceiptHashes: [executionReceipt.harvestReceiptHash],
    harvestCount: 1,
    denominatorHashes: [executionReceipt.denominatorHash],
    witnessBindingSetHash: hashCanonicalJson([executionReceipt.witnessBindingHash]),
    factIds,
    factCount: factIds.length,
    unexecutableCatalogFamilyIds: [] as string[],
    unregisteredBackendFamilyIds: [] as string[],
    failedObligationIds: [] as string[],
    unknownObligationIds: [] as string[],
    verdict: 'passed' as const,
  };
  return {
    facts: prepared.facts,
    receipts: [executionReceipt],
    manifest: {
      ...manifestSemantic,
      manifestHash: hashCanonicalJson(manifestSemantic),
    },
  };
}

function durableAnalysisLineage(
  authority: ReturnType<typeof createStrictTestDimensionAgentAuthorityV1>,
  durable: Awaited<ReturnType<typeof createStrictTestDurableReviewEvidence>>
) {
  return {
    baselineObligationIds: authority.compiledPlan.schedule.factHarvestObligations.map(
      (row) => row.obligationId
    ),
    expansionReceipts: [],
    finalExpandedSchedule: durable.finalExpandedSchedule,
    finalFactSchedule: authority.compiledPlan.schedule,
    analysisFixpoint: durable.analysisFixpoint,
    clusterSets: durable.clusterSets,
  };
}

function requiredTestRow<T>(rows: readonly T[], index: number, label: string): T {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`STRICT_TEST_FIXTURE_ROW_REQUIRED:${label}`);
  }
  return row;
}

function createCompiledPlan(
  executionReceipts: readonly FactQueryExecutionReceiptV1[] = [],
  excludedCellIds: readonly string[] = [],
  moduleScopeOverrides: Readonly<Record<string, string>> = {}
): CompiledColdStartPlanV2 {
  const catalog = buildDimensionCatalogSnapshot();
  const anatomy = buildAnatomyLensCatalogSnapshot();
  const requiredFactApplicability = buildRequiredFactApplicabilityUniverseV1(
    MODULES,
    anatomy,
    FACT_QUERY_CATALOG
  );
  const cells = fixtureCells(catalog, excludedCellIds, moduleScopeOverrides);
  const eligible = cells.filter((cell) => cell.status === 'eligible');
  const excluded = cells.filter((cell) => cell.status === 'excluded');
  const universe = {
    cells,
    universeCount: cells.length,
    eligibleCount: eligible.length,
    excludedCount: excluded.length,
    cellUniverseHash: hashCanonicalJson(cells),
    eligibleCellsHash: hashCanonicalJson(eligible),
    excludedCellsHash: hashCanonicalJson(excluded),
  };
  const selection = {
    schemaVersion: 2 as const,
    kind: 'cold-start-upper-cap' as const,
    generationStage: 'coldStart' as const,
    moduleIds: MODULES.map((module) => module.moduleId),
    dimensionIds: catalog.dimensions.map((dimension) => dimension.id),
    eligibleCellIds: eligible.map((cell) => cell.cellId),
    excludedCellIds: excluded.map((cell) => cell.cellId),
    candidateAttemptCap: 0,
    maxAuthoredCandidatesPerCellPass: 0,
    semanticRepairLimit: 2 as const,
    batchBarrierVersion: 'candidate-batch-barrier-v1',
    policyVersion: 'coverage-plan-policy-v1',
    policyHash: sha('policy'),
    modulePlanningFactsHash: sha('module-facts'),
    sourceArtifactHash: sha('source-artifact'),
    strictConfigReceiptHash: sha('strict-config'),
    authoringPolicy: {
      policy: 'evidence-bounded-no-floor' as const,
      candidateAttempts: 'upper-bound-only' as const,
      authoredCandidates: 'zero-to-many' as const,
      quantityFloor: null,
      semanticRepairLimit: 2 as const,
      batchFailureMode: 'whole-batch' as const,
    },
    deferredCells: [] as const,
    resourceCaps: {
      providerRequestCap: 100,
      detailRequestCap: 100,
      tokenCap: 1_000_000,
      timeMsCap: 300_000,
      costMicrousdCap: 2_000_000,
      factQueryObligationCap: 1_000,
    },
  };
  const factHarvestObligations = executionReceipts
    .map((receipt) => ({
      obligationId: receipt.obligationId,
      factFamilyId: receipt.factFamilyId,
      capabilityId: receipt.capabilityId,
      canonicalSubjectRef: receipt.canonicalSubjectRef,
      analysisScale: receipt.analysisScale,
      denominator: receipt.denominator,
      source: 'required-universe' as const,
    }))
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  const schedule = {
    schemaVersion: 1 as const,
    factHarvestObligations,
    lensBindings: [],
    factHarvestScheduleHash: hashCanonicalJson(factHarvestObligations),
    lensBindingsHash: hashCanonicalJson([]),
    baselineScheduleHash: hashCanonicalJson({
      factHarvestScheduleHash: hashCanonicalJson(factHarvestObligations),
      lensBindingsHash: hashCanonicalJson([]),
    }),
  };
  const execution = {
    schemaVersion: 2 as const,
    factsBindingHash: sha('facts-content'),
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    planCognitionHash: sha('plan-cognition'),
    orderedDimensionIds: catalog.dimensions.map((dimension) => dimension.id),
    orderedCells: eligible.map((cell) => cell.cellId),
    orderedInvestigationActions: [],
    anatomyApplicabilityHash: requiredFactApplicability.universeHash,
    lensBindingsHash: schedule.lensBindingsHash,
    factHarvestScheduleHash: schedule.factHarvestScheduleHash,
    factQueryCatalogHash: FACT_QUERY_CATALOG.catalogHash,
    moduleScope: MODULES.map((module) => module.moduleId),
    synthesisPrerequisites: {},
    resourceCaps: selection.resourceCaps,
  };
  const semantic = {
    schemaVersion: 2 as const,
    compilerVersion: 'cold-start-plan-compiler-v2' as const,
    catalog,
    anatomy,
    requiredFactApplicability,
    factQueryCatalog: FACT_QUERY_CATALOG,
    universe,
    schedule,
    selection,
    execution,
  };
  return { ...semantic, canonicalPlanHash: hashCanonicalJson(semantic) };
}

function fixtureCells(
  catalog: DimensionCatalogSnapshotV1,
  excludedCellIds: readonly string[],
  moduleScopeOverrides: Readonly<Record<string, string>> = {}
): PlanCellV1[] {
  const excluded = new Set(excludedCellIds);
  return MODULES.flatMap((module) =>
    catalog.dimensions.map((dimension) => {
      const cellId = `${module.moduleId}::${dimension.id}`;
      const isExcluded = excluded.has(cellId);
      return {
        cellId,
        moduleId: module.moduleId,
        scopeId: moduleScopeOverrides[module.moduleId] ?? module.scopeId,
        dimensionId: dimension.id,
        criticality: 'standard' as const,
        status: isExcluded ? ('excluded' as const) : ('eligible' as const),
        ...(isExcluded ? { exclusionReason: 'ROLE_NOT_APPLICABLE' as const } : {}),
        evidenceRefs: [`ref:${module.moduleId}`],
        synthesisPrerequisiteCellIds: [],
      };
    })
  );
}

function createPreflightBindings(): StrictTestPreflightBindingsV1 {
  return {
    schemaVersion: 1,
    profile: 'strict-test-dimension',
    demandKey: 'recipe-coldstart-production-quality-2026-07-15',
    runId: 'strict-test-fixture-1',
    projectRootIdentity: 'project-root:BiliDili',
    controlRootIdentity: 'control-root:AlembicWorkspace',
    sourceRootIdentity: 'source-root:BiliDili',
    canonicalProjectIdentityHash: sha('project-identity'),
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    sourceInventoryHash: sha('source-inventory'),
    sourceFileCount: 24,
    moduleCount: MODULES.length,
    languageCount: 1,
    parserCount: 1,
    backendCount: 7,
    certifiedProjectFactsArtifactHash: sha('facts-artifact'),
    certifiedProjectFactsContentHash: sha('facts-content'),
    certifiedProjectFactsSourceArtifactHash: sha('source-artifact'),
    certifiedProjectFactsSourceVectorHash: STRICT_SOURCE_REVISION,
    certifiedProjectFactsConsumerReceiptHash: sha('facts-consumer'),
    strictConfigReceiptHash: sha('strict-config'),
    providerModelHash: sha('provider-model'),
    promptSopHash: sha('prompt-sop'),
    factQueryBackendHash: sha('fact-query-backend'),
    parserBackendHash: sha('parser-backend'),
    embeddingVectorHash: sha('embedding-vector'),
    runtimeArtifactManifestHash: sha('runtime-manifest'),
    runtimeArtifactBindingHash: sha('runtime-binding'),
    productionBeforeStateHash: sha('production-before'),
    productionAfterReadStateHash: sha('production-before'),
    publicRouteBeforeStateHash: sha('public-route-before'),
    officialRecipeBeforeStateHash: sha('official-recipe-before'),
    privateWorkspacePolicyHash: sha('private-workspace-policy'),
    generatedAt: '2026-07-30T06:00:00.000Z',
    validUntil: '2026-07-30T07:00:00.000Z',
  };
}

function family(id: string, capabilityId: string): FactQueryFamilyV1 {
  return {
    id,
    capabilityId,
    supportedScales: [
      'source-range',
      'symbol',
      'file',
      'module',
      'package',
      'repository',
      'project',
    ],
    queryPackHash: sha(`${id}:query-pack`),
    loadedProducer: `loaded:${capabilityId}:fixture-v1`,
    producerManifestHash: sha(`${id}:producer`),
    loadReceiptHash: sha(`${id}:load`),
    positiveFixtureHash: sha(`${id}:positive`),
    negativeFixtureHash: sha(`${id}:negative`),
    edgeFixtureHash: sha(`${id}:edge`),
  };
}

function sha(value: string) {
  return hashCanonicalJson(value);
}
