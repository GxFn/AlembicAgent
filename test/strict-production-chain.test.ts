import { createHash } from 'node:crypto';
import {
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAnalysisReviewContextHashV1,
  createFinalExpandedMiningScheduleReceiptV1,
  hashKnowledgeClusterV1,
} from '@alembic/core/production';
import { describe, expect, it } from 'vitest';
import { buildAnalysisArtifact } from '../src/agent/evaluation/analysisArtifact.js';
import {
  buildIndependentReviewPrompt,
  computeJudgeCalibration,
  createFrozenEvidenceProjection,
  IndependentValueReviewer,
} from '../src/agent/evaluation/IndependentValueReviewer.js';
import { InvestigatedEmptyReviewer } from '../src/agent/evaluation/InvestigatedEmptyReviewer.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictAnalysisGateOutcomeV1,
  validateStrictAnalystEpochV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import {
  buildStrictAnalystPrompt,
  buildStrictProducerPrompt,
} from '../src/agent/production/StrictProductionPrompts.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import {
  type PlanContextProjectionV1,
  runStrictPlanAgent,
} from '../src/agent/runs/plan/PlanAgentRun.js';
import type { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import type { AgentRunInput, AgentRunResult } from '../src/agent/service/AgentRunContracts.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';
import { GenerateProduce } from '../src/tools/runtime/toolsets/GenerateProduce.js';
import { ScanProduce } from '../src/tools/runtime/toolsets/ScanProduce.js';
import {
  createExecutionReceipt,
  createReview,
  STRICT_SOURCE_REVISION,
} from './fixtures/strict-semantic-authority.js';

function result(reply: string): AgentRunResult {
  return {
    runId: 'strict-plan-run',
    profileId: 'plan-selection',
    reply,
    status: 'success',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}

const strictIntent = {
  generationStage: 'coldStart' as const,
  projectProfile: { projectType: 'workspace', moduleCount: 25, fileCount: 25 },
  dimensions: [
    {
      dimensionId: 'architecture',
      priority: 1,
      rationale: 'trace real boundaries',
      targetRecipes: 0,
    },
  ],
  scale: { totalRecipeBudget: 0, depthLevels: ['project'] },
  moduleBindings: [],
  plannedNextActions: [
    {
      tool: 'facts.syntax',
      reason: 'inspect every required scope',
      order: 1,
      questionId: 'q-root',
      anatomyLensIds: ['structure-and-boundary'],
      subjectRefs: ['scope:workspace'],
      analysisScales: ['project'],
      capabilityId: 'facts.syntax',
      queryFamilyId: 'syntax-patterns',
      expectedSupport: ['boundary declarations'],
      expectedCounterevidence: ['unowned entrypoint'],
      synthesisTarget: 'workspace boundaries',
      uncertainty: 'cross-package ownership',
      priority: 'critical',
      stopCondition: 'all required scopes terminal',
      escalationCondition: 'backend unavailable',
      budget: {
        initialBreadth: 1,
        expansionReserve: 1,
        counterqueryReserve: 1,
        starvationGuard: 1,
      },
    },
  ],
  evidenceRefs: [{ kind: 'project-context' as const, ref: 'artifact:pcf' }],
  investigationDecomposition: {
    schemaVersion: 1 as const,
    questions: [
      {
        questionId: 'q-root',
        subquestionIds: [],
        anatomyLensIds: ['structure-and-boundary'],
        subjectRefs: ['scope:workspace'],
        analysisScales: ['project'],
        capabilityIds: ['facts.syntax'],
        queryFamilyIds: ['syntax-patterns'],
        expectedSupport: ['boundary declarations'],
        expectedCounterevidence: ['unowned entrypoint'],
        synthesisTarget: 'workspace boundaries',
        uncertainty: 'cross-package ownership',
        stopCondition: 'all required scopes terminal',
        escalationCondition: 'backend unavailable',
        priority: 'critical' as const,
        budget: {
          initialBreadth: 1,
          expansionReserve: 1,
          counterqueryReserve: 1,
          starvationGuard: 1,
        },
      },
    ],
  },
  budgetStrategy: {
    schemaVersion: 1 as const,
    providerRequests: 3,
    detailRequests: 3,
    tokens: 10_000,
    timeMs: 10_000,
    costMicrousd: 0,
  },
};

function planContext(): PlanContextProjectionV1 {
  return {
    schemaVersion: 1,
    generationStage: 'coldStart',
    factsHash: 'facts-hash',
    catalogHash: 'catalog-hash',
    sourceRevisionVectorHash: 'source-vector',
    sourceArtifactHash: 'artifact-hash',
    modelHash: 'frozen-plan-model',
    promptHash: 'frozen-plan-prompt',
    projectContextFacts: {
      scopes: Array.from({ length: 25 }, (_, index) => ({
        scopeId: `scope:${index === 24 ? 'last-module' : `module-${index}`}`,
        modulePath: `src/module-${index}`,
      })),
    },
    frozenCapabilityIds: ['facts.syntax'],
    frozenQueryFamilyIds: ['syntax-patterns'],
    hardCaps: { semanticRepairLimit: 2 },
  };
}

describe('strict Plan cognition', () => {
  it('uses the existing Plan entry, keeps every scope, and links one causal repair', async () => {
    const calls: AgentRunInput[] = [];
    const agentService = {
      run: async (input: AgentRunInput) => {
        calls.push(input);
        return result(JSON.stringify(strictIntent));
      },
    };
    let validations = 0;
    const receipt = await runStrictPlanAgent({
      agentService,
      contextProjection: planContext(),
      validateReceipt: () => {
        validations += 1;
        if (validations === 1) {
          throw new Error('PLAN_REQUIRED_LENS_UNSCHEDULED: repair with explicit scope binding');
        }
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.message.content).toContain('scope:last-module');
    expect(calls[0]?.execution).toEqual({ toolChoiceOverride: 'none' });
    expect(receipt.lineage.repairs).toHaveLength(1);
    expect(receipt.lineage.repairs[0]?.parentInvocationId).toBe(
      receipt.lineage.initial.invocationId
    );
    expect(receipt.intent.scale.totalRecipeBudget).toBe(0);
  });

  it('rejects a third semantic repair instead of silently retrying', async () => {
    const agentService = {
      run: async (_input: AgentRunInput) => result(JSON.stringify(strictIntent)),
    };
    await expect(
      runStrictPlanAgent({
        agentService,
        contextProjection: planContext(),
        validateReceipt: () => {
          throw new Error('PLAN_REVISE');
        },
      })
    ).rejects.toThrow(/PLAN_SEMANTIC_REPAIR_LIMIT/u);
  });
});

const strictStaticSchedulePort = createStrictAnalysisExpansionPortV1({
  baselineScheduleHash: 'schedule-1',
  baselineObligationIds: ['base-1', 'counter-1'],
  knownFactFamilies: [],
  knownSubjectRefs: [],
  obligationCap: 2,
});
const strictFinalSchedule = strictStaticSchedulePort.seal();

const strictContext = createStrictAnalysisContextProjectionV1({
  runId: 'run-1',
  journalId: 'journal-1',
  manifestHash: 'manifest-1',
  planCognitionHash: 'plan-cognition-1',
  planHash: 'plan-1',
  requiredUniverseHash: 'universe-1',
  baselineScheduleHash: 'schedule-1',
  expansionHeadHash: null,
  currentExpandedScheduleHash: 'schedule-1',
  finalExpandedScheduleHash: strictFinalSchedule.finalExpandedScheduleHash,
  analysisFixpointHash: 'fixpoint-1',
  privateCorpusRevision: null,
  hypothesisExpressionSetHash: null,
  lensBindingsHash: 'lens-1',
  sourceArtifactHash: 'artifact-1',
  sourceRevisionVectorHash: 'vector-1',
  questionIds: ['q-root'],
  factQueryObligationIds: ['base-1', 'counter-1'],
  analysisUnitIds: ['unit-1'],
  factIds: ['fact-a', 'fact-b', 'fact-outlier'],
  witnessIds: ['witness-a', 'witness-b', 'witness-outlier'],
  populationHashes: ['population-1'],
  clusterSetHashes: ['cluster-set-1'],
  inductionReceiptHashes: ['induction-1'],
  hypothesisIds: ['hypothesis-1'],
  falsificationReceiptHashes: ['falsification-1'],
  dispositionReviewIds: ['review-1'],
  evidenceEntryIds: ['E-1', 'E-2'],
  derivedFindingCount: 0,
});

const strictAnalysisEpoch = createStrictAnalysisEpochSnapshotV1({
  epoch: 1,
  context: strictContext,
  populations: [{ populationHash: 'population-1' }],
  terminalObligationIds: strictContext.factQueryObligationIds,
  outstandingObligationIds: [],
});

function strictRuntimePort() {
  return {
    enabled: true as const,
    analysisLimits: {
      maxEpochs: 1,
      maxObligations: strictContext.factQueryObligationIds.length,
    },
    expansionPort: createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: strictContext.baselineScheduleHash,
      baselineObligationIds: strictContext.factQueryObligationIds,
      knownFactFamilies: [],
      knownSubjectRefs: [],
      obligationCap: strictContext.factQueryObligationIds.length,
    }),
    readAnalysisEpoch: () => strictAnalysisEpoch,
    buildProducerInput: () => ({
      analysisFixpointHash: 'fixpoint-1',
      producerEligibleHypothesisIds: ['hypothesis-1'],
    }),
    validateAnalystResult: (_source: unknown, observedEpoch: typeof strictAnalysisEpoch) =>
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

describe('strict context and analysis artifact', () => {
  it('round-trips the entire whitelist and forbids Markdown/live-read derivation', () => {
    const activeContext = new ActiveContext();
    activeContext.bindStrictAnalysisContext(strictContext);
    activeContext.noteKeyFinding('legacy scratchpad must not leak', 'src/live.ts:1', 10);
    const restored = ActiveContext.fromJSON(activeContext.toJSON());
    expect(restored.distill().strictAnalysisContext).toEqual(strictContext);

    const artifact = buildAnalysisArtifact(
      { reply: '## invented\nsource.ts:1', toolCalls: [] },
      'architecture',
      null,
      restored,
      { projectRoot: '/must-not-be-read', strictColdStart: true }
    );
    expect(artifact.findings).toEqual([]);
    expect(artifact.strictAnalysisContext).toEqual(strictContext);
    expect(artifact.metadata.memoryFindingCount).toBe(0);
    expect(artifact.metadata.derivedFindingCount).toBe(0);
    expect(artifact.metadata.postHocLiveReadCount).toBe(0);
  });

  it('drops non-whitelisted context fields instead of serializing a second evidence store', () => {
    const { schemaVersion: _schemaVersion, contextHash: _contextHash, ...input } = strictContext;
    const rebuilt = createStrictAnalysisContextProjectionV1({
      ...input,
      liveSourceText: 'must-not-survive',
    } as Parameters<typeof createStrictAnalysisContextProjectionV1>[0]);
    expect(rebuilt).not.toHaveProperty('liveSourceText');
  });
});

describe('strict Analyst expansion, clustering, induction, and falsification', () => {
  it('enrolls counterqueries before execution and preserves variants/outliers', () => {
    const receiptA = createExecutionReceipt({ name: 'a', emittedFactIds: ['fact-a'] });
    const receiptB = createExecutionReceipt({ name: 'b', emittedFactIds: ['fact-b'] });
    const outlierReceipt = createExecutionReceipt({
      name: 'outlier',
      emittedFactIds: ['fact-outlier'],
    });
    const counterReceipt = createExecutionReceipt({
      name: 'counter',
      emittedFactIds: [],
      disposition: 'inspected-no-pattern',
    });
    const port = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: `sha256:${'a'.repeat(64)}`,
      baselineObligationIds: [
        receiptA.obligationId,
        receiptB.obligationId,
        outlierReceipt.obligationId,
      ],
      knownFactFamilies: [
        { id: 'syntax-patterns', capabilityId: 'facts.syntax', supportedScales: ['file'] },
      ],
      knownSubjectRefs: [
        receiptA.canonicalSubjectRef,
        receiptB.canonicalSubjectRef,
        outlierReceipt.canonicalSubjectRef,
        counterReceipt.canonicalSubjectRef,
      ],
      obligationCap: 4,
    });
    port.enroll({
      obligationId: counterReceipt.obligationId,
      purpose: 'counterexample',
      factFamilyId: 'syntax-patterns',
      capabilityId: 'facts.syntax',
      canonicalSubjectRef: counterReceipt.canonicalSubjectRef,
      analysisScale: 'file',
      reasonCode: 'claim-applicable-counterexample',
    });
    expect(port.assertExecutionAllowed(counterReceipt.obligationId).purpose).toBe('counterexample');
    expect(() => port.assertExecutionAllowed('not-enrolled')).toThrow(
      /STRICT_ANALYSIS_QUERY_UNENROLLED/u
    );
    port.seal();
    expect(() =>
      port.enroll({
        obligationId: 'late-query',
        purpose: 'exploration',
        factFamilyId: 'syntax-patterns',
        capabilityId: 'facts.syntax',
        canonicalSubjectRef: 'file:a',
        analysisScale: 'file',
        reasonCode: 'late-query-forbidden',
      })
    ).toThrow(/STRICT_ANALYSIS_SCHEDULE_ALREADY_FINAL/u);

    const populationInput = {
      populationId: 'population-1',
      revision: 1,
      parentPopulationHash: null,
      sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
      denominator: {
        kind: 'frozen-complete-subjects' as const,
        expectedObservationIds: ['obs-a', 'obs-b', 'obs-outlier'],
        expectedObligationIds: [
          receiptA.obligationId,
          receiptB.obligationId,
          outlierReceipt.obligationId,
        ],
        executionReceiptHashes: [
          receiptA.receiptHash,
          receiptB.receiptHash,
          outlierReceipt.receiptHash,
        ],
        outputHashes: [receiptA.outputHash, receiptB.outputHash, outlierReceipt.outputHash],
        denominatorHashes: [
          receiptA.denominatorHash,
          receiptB.denominatorHash,
          outlierReceipt.denominatorHash,
        ],
        complete: true,
        truncated: false,
        continuation: null,
        omittedObservationIds: [],
      },
      executionReceipts: [receiptA, receiptB, outlierReceipt],
      observations: [
        {
          observationId: 'obs-a',
          factIds: ['fact-a'],
          obligationIds: [receiptA.obligationId],
          mechanismKey: 'wrap-result-envelope',
          canonicalSubjectRefs: [receiptA.canonicalSubjectRef],
          parentSubjectRefs: ['repo:repo'],
          variantKeys: ['async'],
          outlierReasonCodes: [],
          negativeControl: false,
        },
        {
          observationId: 'obs-b',
          factIds: ['fact-b'],
          obligationIds: [receiptB.obligationId],
          mechanismKey: 'wrap-result-envelope',
          canonicalSubjectRefs: [receiptB.canonicalSubjectRef],
          parentSubjectRefs: ['repo:repo'],
          variantKeys: ['sync'],
          outlierReasonCodes: [],
          negativeControl: false,
        },
        {
          observationId: 'obs-outlier',
          factIds: ['fact-outlier'],
          obligationIds: [outlierReceipt.obligationId],
          mechanismKey: 'outlier-preserved',
          canonicalSubjectRefs: [outlierReceipt.canonicalSubjectRef],
          parentSubjectRefs: ['repo:repo'],
          variantKeys: ['outlier'],
          outlierReasonCodes: ['bounded-singleton'],
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
        mechanismKey: 'wrap-result-envelope',
        mechanism: { invariant: 'handlers wrap typed result envelopes' },
        observationIds: ['obs-a', 'obs-b'],
        mechanismEvidenceFactIds: ['fact-a', 'fact-b'],
        anatomyLensIds: ['error-recovery-concurrency'] as const,
      },
      {
        mechanismKey: 'outlier-preserved',
        mechanism: { invariant: 'bounded outliers remain explicit' },
        observationIds: ['obs-outlier'],
        mechanismEvidenceFactIds: ['fact-outlier'],
        anatomyLensIds: ['error-recovery-concurrency'] as const,
      },
    ];
    const population = canonicalizeObservationPopulationV1(populationInput);
    const clusterSet = canonicalizeKnowledgeClustersV1(population, {
      clusters: clusterInputs,
      nonClusteredDispositions: [],
    });
    const terminalObligations = [
      ...[receiptA, receiptB, outlierReceipt, counterReceipt].map((receipt) => ({
        obligationId: receipt.obligationId,
        disposition: receipt.disposition,
        terminalReceiptId: receipt.terminalReceiptId,
      })),
    ];
    const currentAnalysisFixpointHash = createAnalysisReviewContextHashV1({
      finalExpandedScheduleHash: port.seal().finalExpandedScheduleHash,
      terminalObligations,
      populationHashes: [population.populationHash],
      clusterSetHashes: [clusterSet.clusterSetHash],
    });
    const outlierCluster = clusterSet.clusters.find(
      (cluster) => cluster.mechanismKey === 'outlier-preserved'
    );
    if (!outlierCluster) {
      throw new Error('TEST_OUTLIER_CLUSTER_MISSING');
    }
    const zeroReview = createReview({
      reviewKind: 'zero-hypothesis',
      currentAnalysisFixpointHash,
      populationHash: population.populationHash,
      proposal: {
        reviewKind: 'zero-hypothesis',
        populationHash: population.populationHash,
        clusterHash: hashKnowledgeClusterV1(outlierCluster),
        clusterId: outlierCluster.clusterId,
        observationIds: outlierCluster.observationIds,
        mode: 'bounded-singleton',
        zeroHypothesisReason: 'insufficient-evidence',
      },
      executionReceipts: [outlierReceipt],
      finalExpandedSchedule: port.seal(),
      terminalObligations,
    });
    const execution = {
      counterqueryId: counterReceipt.obligationId,
      obligationId: counterReceipt.obligationId,
      executionReceipt: counterReceipt,
      counterexampleFactIds: [],
    };
    const falsificationReview = createReview({
      reviewKind: 'falsification',
      currentAnalysisFixpointHash,
      populationHash: population.populationHash,
      proposal: {
        reviewKind: 'falsification',
        populationHash: population.populationHash,
        hypothesisId: 'hypothesis-1',
        enrolledCounterqueryIds: [counterReceipt.obligationId],
        executions: [
          {
            counterqueryId: counterReceipt.obligationId,
            obligationId: counterReceipt.obligationId,
            executionReceiptHash: counterReceipt.receiptHash,
            executionOutputHash: counterReceipt.outputHash,
            denominatorHash: counterReceipt.denominatorHash,
            counterexampleFactIds: [],
          },
        ],
        counterqueryApplicability: {
          status: 'required',
          reasonCode: 'recurring-claim-requires-counterexample',
        },
      },
      executionReceipts: [counterReceipt],
      finalExpandedSchedule: port.seal(),
      terminalObligations,
    });
    const epoch = validateStrictAnalystEpochV1({
      currentAnalysisFixpointHash,
      knownFactIds: ['fact-a', 'fact-b', 'fact-outlier'],
      enrolledObligationIds: port.seal().obligationIds,
      population: populationInput,
      clusterInputs,
      nonClusteredDispositions: [],
      inductionInputs: [
        {
          mechanismKey: 'wrap-result-envelope',
          mode: 'recurring',
          hypotheses: [
            {
              hypothesisId: 'hypothesis-1',
              statement: 'Handlers return a Result envelope',
              premiseFactIds: ['fact-a', 'fact-b'],
            },
          ],
        },
        {
          mechanismKey: 'outlier-preserved',
          mode: 'bounded-singleton',
          hypotheses: [],
          zeroHypothesisReason: 'insufficient-evidence',
          zeroHypothesisDispositionReview: zeroReview,
        },
      ],
      falsificationInputs: [
        {
          hypothesisId: 'hypothesis-1',
          enrolledCounterqueryIds: [counterReceipt.obligationId],
          executions: [execution],
          counterqueryApplicability: {
            status: 'required',
            reasonCode: 'recurring-claim-requires-counterexample',
          },
          dispositionReview: falsificationReview,
        },
      ],
      hypothesisDispositions: [{ hypothesisId: 'hypothesis-1', status: 'survived' }],
      dispositionReviews: [zeroReview, falsificationReview],
    });

    expect(epoch.population.conservation).toEqual({
      raw: 3,
      accepted: 3,
      duplicate: 0,
      excluded: 0,
      error: 0,
      inspectedNoPattern: 0,
      omitted: 0,
    });
    expect(epoch.clusterSet.clusters).toHaveLength(2);
    expect(epoch.producerEligibleHypotheses.map((row) => row.hypothesisId)).toEqual([
      'hypothesis-1',
    ]);
    const fixpoint = createStrictAnalysisFixpointV1({
      finalExpandedSchedule: port.seal(),
      terminalObligations,
      epochs: [epoch],
    });
    expect(fixpoint.finalExpandedScheduleHash).toBe(port.seal().finalExpandedScheduleHash);
  });
});

const authored = {
  title: 'Preserve Result envelopes at handler boundaries',
  kind: 'rule',
  doClause: 'Return Result<T> from every handler',
  dontClause: 'Do not leak raw exceptions',
  markdown: 'Use the project Result envelope.',
  usageGuide: 'Apply when adding a handler.',
  retrievalProfile: { intents: ['handler error contract'] },
  negativeIntent: ['internal helper'],
  scope: { moduleIds: ['handlers'], dimensionIds: ['error-resilience'] },
  evidenceEntryIds: ['E-1', 'E-2'],
};

describe('strict Producer and causal repair', () => {
  it('keeps strict Producer proposal-only and removes every floor/filler tool path', () => {
    expect(new GenerateProduce({ strictColdStart: true }).allowedTools).toEqual({});
    expect(new ScanProduce({ strictColdStart: true }).allowedTools).toEqual({});
    const expressionSet = {
      hypothesis: { hypothesisId: 'hypothesis-1' },
      proposals: [{ expressionId: 'expression-1', kind: 'draft', authored }],
      zeroDisposition: null,
    };
    expect(buildStrictProducerPrompt(expressionSet)).not.toMatch(
      /knowledge\.submit|targetRecipes|min(?:imum)?\s*3/iu
    );
    expect(
      buildStrictAnalystPrompt({
        epoch: strictAnalysisEpoch,
        limits: { maxEpochs: 1, maxObligations: 2 },
      })
    ).toContain('counterquery');
    const strictPrompts = `${buildStrictProducerPrompt(expressionSet)}\n${buildStrictAnalystPrompt({
      epoch: strictAnalysisEpoch,
      limits: { maxEpochs: 1, maxObligations: 2 },
    })}`;
    expect(strictPrompts).toMatch(/no candidate floor.*filler|do not add filler/isu);
    expect(strictPrompts).not.toMatch(/at least\s+\d+\s+(?:candidate|proposal)|targetRecipes/iu);
  });
});

describe('strict PipelineStrategy', () => {
  const message = {
    role: 'internal',
    content: 'run strict pipeline',
    metadata: {},
  } as AgentMessage;

  it('blocks Producer submit/review/persist tools at the existing production strategy boundary', async () => {
    const strategy = new PipelineStrategy({
      stages: [{ name: 'produce', strictRoleSurface: 'strict-producer-v1' }],
    });
    const runtime = {
      id: 'strict-runtime',
      reactLoop: async () => ({
        reply: '',
        toolCalls: [{ tool: 'knowledge', args: { action: 'submit' } }],
        tokenUsage: { input: 1, output: 1 },
        iterations: 1,
      }),
    };
    await expect(
      strategy.execute(runtime, message, {
        strategyContext: { strictProduction: strictRuntimePort() },
      })
    ).rejects.toThrow(/STRICT_PRODUCER_TOOL_FORBIDDEN/u);
  });

  it('turns a strict non-pass into a typed failed owner/resume return and never degrades to success', async () => {
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze', strictRoleSurface: 'strict-analyst-v1' },
        {
          name: 'quality_gate',
          source: 'analyze',
          gate: {
            evaluator: () => ({ action: 'degrade', pass: false, reason: 'drifted evidence' }),
            strictGate: {
              gate: 'G2',
              reasonCode: 'source-drift',
              owner: 'independent-reviewer',
              resumePoint: 'review-frozen-evidence',
              permittedMutation: 'refresh-evidence-projection',
            },
          },
        },
        { name: 'produce', strictRoleSurface: 'strict-producer-v1' },
      ],
    });
    let calls = 0;
    const runtime = {
      id: 'strict-runtime',
      reactLoop: async () => {
        calls += 1;
        return {
          reply: 'analysis',
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        };
      },
    };
    const output = await strategy.execute(runtime, message, {
      strategyContext: { strictProduction: strictRuntimePort() },
    });
    expect(output.outcome).toBe('failed');
    expect(calls).toBe(1);
    expect(output.phases._strictGateReturns).toEqual([
      expect.objectContaining({ gate: 'G2', verdict: 'failed', owner: 'independent-reviewer' }),
    ]);
  });

  it('rejects an Analyst query that did not pass the expansion enrollment port', async () => {
    const strategy = new PipelineStrategy({
      stages: [{ name: 'analyze', strictRoleSurface: 'strict-analyst-v1' }],
    });
    const runtime = {
      id: 'strict-runtime',
      reactLoop: async () => ({
        reply: '',
        toolCalls: [
          {
            tool: 'evidence',
            args: {
              action: 'execute_counterquery',
              params: { obligationId: 'not-enrolled' },
            },
          },
        ],
        tokenUsage: { input: 1, output: 1 },
        iterations: 1,
      }),
    };
    await expect(
      strategy.execute(runtime, message, {
        strategyContext: { strictProduction: strictRuntimePort() },
      })
    ).rejects.toThrow(/STRICT_ANALYSIS_QUERY_UNENROLLED/u);
  });

  it('fails before any model call when a strict run receives a legacy role stage', async () => {
    let calls = 0;
    const strategy = new PipelineStrategy({ stages: [{ name: 'analyze' }] });
    const runtime = {
      id: 'legacy-runtime',
      reactLoop: async () => {
        calls += 1;
        return {
          reply: 'legacy analyst reply',
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        };
      },
    };
    await expect(
      strategy.execute(runtime, message, {
        strategyContext: { strictProduction: strictRuntimePort() },
      })
    ).rejects.toThrow(/STRICT_PRODUCTION_STAGE_ROUTE_REQUIRED:analyze/u);
    expect(calls).toBe(0);
  });

  it('routes the real generateDimensionPipeline factory through the existing strict stage chain', async () => {
    const prompts: string[] = [];
    const runtimePort = strictRuntimePort();
    const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
      params: { needsCandidates: true },
      context: { strategyContext: { strictProduction: runtimePort } },
    });
    expect(stages.map((stage) => stage.name)).toEqual([
      'analyze',
      'analyst_fixpoint_gate',
      'produce',
      'independent_review_gate',
    ]);
    expect(
      stages.filter((stage) => !stage.gate).every((stage) => stage.capabilities?.length === 0)
    ).toBe(true);
    expect(stages.filter((stage) => !stage.gate).map((stage) => stage.strictRoleSurface)).toEqual([
      'strict-analyst-v1',
      'strict-producer-v1',
    ]);

    const strategy = new PipelineStrategy({ stages });
    const runtime = {
      id: 'strict-runtime',
      reactLoop: async (prompt: string) => {
        prompts.push(prompt);
        return {
          reply: prompts.length === 1 ? 'analyst epoch' : 'producer expression set',
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        };
      },
    };
    const output = await strategy.execute(runtime, message, {
      strategyContext: { strictProduction: runtimePort },
    });
    expect(output.outcome).toBe('completed');
    expect(output.phases._strictGateReturns).toEqual([
      expect.objectContaining({ gate: 'G1', verdict: 'pass' }),
      expect.objectContaining({ gate: 'G2', verdict: 'pass' }),
    ]);
    expect(output.phases._strictRoleRouteReceipt).toEqual({
      kind: 'StrictRoleRouteReceiptV1',
      strictAnalystCalls: 1,
      strictProducerCalls: 1,
      legacyAnalystCalls: 0,
      legacyProducerCalls: 0,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('counterquery');
    expect(prompts[1]).toContain('proposal expressions');
  });
});

describe('production independent reviewers', () => {
  const content = '1|export function handler() {\n2|  return wrapResult(run);\n3|}';
  const contentHash = createHash('sha256').update(content).digest('hex');
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: 'vector-1',
    entries: [
      {
        evidenceEntryId: 'E-1',
        relativePath: 'src/handler.ts',
        blobHash: 'blob-1',
        contentHash,
        startLine: 1,
        endLine: 3,
        content,
      },
      {
        evidenceEntryId: 'E-2',
        relativePath: 'src/handler-variant.ts',
        blobHash: 'blob-2',
        contentHash,
        startLine: 1,
        endLine: 3,
        content,
      },
    ],
  });

  it('reviews the complete authored projection from frozen evidence and fails closed on drift', async () => {
    const prompt = buildIndependentReviewPrompt({ authored, evidence });
    expect(prompt).toContain('usageGuide');
    expect(prompt).toContain('negativeIntent');
    expect(prompt).toContain('src/handler.ts:1-3');

    const reviewer = new IndependentValueReviewer({
      identity: { provider: 'frozen', model: 'reviewer-v1', method: 'independent-value-v1' },
      chat: async () =>
        JSON.stringify({
          axes: [
            'entailment',
            'contradiction-free',
            'project-specificity',
            'actionability',
            'scope-correctness',
            'retrieval-fitness',
          ].map((axis) => ({
            axis,
            verdict: 'pass',
            score: 2,
            reasonCode: 'supported',
            evidenceEntryIds: ['E-1'],
          })),
          noveltyDecision: 'novel-project-specific',
          duplicateDecision: 'no-match',
          citedLines: ['src/handler.ts:2'],
        }),
    });
    const decision = await reviewer.review({
      authored,
      evidence,
      expectedSourceRevisionVectorHash: 'vector-1',
      producerIdentity: 'frozen/producer-v1',
      admissionReceiptId: 'admission-1',
      calibrationReceiptHash: 'calibration-1',
      repairAttempt: 0,
    });
    expect(decision.verdict).toBe('pass');

    const drifted = await reviewer.review({
      authored,
      evidence,
      expectedSourceRevisionVectorHash: 'vector-2',
      producerIdentity: 'frozen/producer-v1',
      admissionReceiptId: 'admission-1',
      calibrationReceiptHash: 'calibration-1',
      repairAttempt: 0,
    });
    expect(drifted).toMatchObject({ verdict: 'reject', reasonCode: 'source-drift' });
  });

  it('keeps investigated-empty on a separate complete-denominator rubric', () => {
    const executionReceipt = createExecutionReceipt({
      name: 'empty',
      emittedFactIds: [],
      disposition: 'inspected-no-pattern',
    });
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
    const currentAnalysisFixpointHash = `sha256:${'2'.repeat(64)}`;
    const populationHash = `sha256:${'3'.repeat(64)}`;
    const proposal = {
      reviewKind: 'investigated-empty' as const,
      populationHash,
      sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
      finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
      currentAnalysisFixpointHash,
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
      evidenceEntryIds: ['E-1'],
    };
    const dispositionReview = createReview({
      reviewKind: 'investigated-empty',
      currentAnalysisFixpointHash,
      populationHash,
      proposal,
      executionReceipts: [executionReceipt],
      finalExpandedSchedule,
      terminalObligations,
    });
    const reviewer = new InvestigatedEmptyReviewer({
      identity: { provider: 'frozen', model: 'empty-reviewer-v1', method: 'investigated-empty-v1' },
    });
    expect(
      reviewer.review({
        sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
        finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
        currentAnalysisFixpointHash,
        expectedObligationIds: [executionReceipt.obligationId],
        executionReceipts: [executionReceipt],
        dispositionReview,
        evidenceEntryIds: ['E-1'],
      })
    ).toMatchObject({ verdict: 'pass' });
    expect(
      reviewer.review({
        sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
        finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
        currentAnalysisFixpointHash,
        expectedObligationIds: [],
        executionReceipts: [],
        dispositionReview,
        evidenceEntryIds: ['E-1'],
      })
    ).toMatchObject({ verdict: 'unknown', reasonCode: 'EMPTY_DENOMINATOR_REQUIRED' });
  });

  it('retains the calibrated agreement/kappa/negative-recall deployment gate', () => {
    const uphold = { verdict: 'uphold' };
    const reject = { verdict: 'reject' };
    const records = [
      ...Array.from({ length: 20 }, () => ({ humanDecision: 'uphold', judgeVerdict: uphold })),
      ...Array.from({ length: 10 }, () => ({ humanDecision: 'reject', judgeVerdict: reject })),
    ];
    expect(computeJudgeCalibration(records)).toMatchObject({
      judged: 30,
      promotionEligible: true,
      negativeSubset: { total: 10, caught: 10, recall: 1 },
    });
  });
});
