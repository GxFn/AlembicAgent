import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Logger from '@alembic/core/logging';
import { hashStrictPlanIntentV1 } from '@alembic/core/plans';
import {
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAnalysisReviewContextHashV1,
  createFinalExpandedMiningScheduleReceiptV1,
  hashKnowledgeClusterV1,
} from '@alembic/core/production';
import { canonicalJsonStringify } from '@alembic/core/project-context-foundation';
import { describe, expect, it, vi } from 'vitest';
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
    let count = 0;
    const agentService = {
      run: async (_input: AgentRunInput) => {
        count++;
        return result(JSON.stringify(strictIntent));
      },
    };
    // L8-C06：只有白名单内、模型改写能影响的 cognition 校验码才消耗修复预算；这里用白名单码
    // 稳定拒绝，确认初始调用 + 两次修复后显式以 PLAN_SEMANTIC_REPAIR_LIMIT 终止并保留原码。
    await expect(
      runStrictPlanAgent({
        agentService,
        contextProjection: planContext(),
        validateReceipt: () => {
          throw new Error('PLAN_QUESTION_INCOMPLETE: q-root');
        },
      })
    ).rejects.toThrow(/^PLAN_SEMANTIC_REPAIR_LIMIT: PLAN_QUESTION_INCOMPLETE: q-root$/u);
    expect(count).toBe(3);
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

    // 与宿主 buildPopulation 同口径：population 覆盖完整扩展日程的全部执行回执，包括已登记的反查；
    // 反查回执是 Analyst 绑定 executions[].executionReceipt 的唯一权威（C028）。
    const executedReceipts = [receiptA, receiptB, outlierReceipt, counterReceipt];
    const populationInput = {
      populationId: 'population-1',
      revision: 1,
      parentPopulationHash: null,
      sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
      denominator: {
        kind: 'frozen-complete-subjects' as const,
        expectedObservationIds: ['obs-a', 'obs-b', 'obs-outlier', 'obs-counter-no-pattern'],
        expectedObligationIds: executedReceipts.map((receipt) => receipt.obligationId),
        executionReceiptHashes: executedReceipts.map((receipt) => receipt.receiptHash),
        outputHashes: executedReceipts.map((receipt) => receipt.outputHash),
        denominatorHashes: executedReceipts.map((receipt) => receipt.denominatorHash),
        complete: true,
        truncated: false,
        continuation: null,
        omittedObservationIds: [],
      },
      executionReceipts: executedReceipts,
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
      inspectedNoPatternObservations: [
        {
          observationId: 'obs-counter-no-pattern',
          obligationId: counterReceipt.obligationId,
          canonicalSubjectRef: counterReceipt.canonicalSubjectRef,
          parentSubjectRefs: ['repo:repo'],
          executionReceiptHash: counterReceipt.receiptHash,
          outputHash: counterReceipt.outputHash,
          denominatorHash: counterReceipt.denominatorHash,
        },
      ],
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
      raw: 4,
      accepted: 3,
      duplicate: 0,
      excluded: 0,
      error: 0,
      inspectedNoPattern: 1,
      omitted: 0,
    });
    expect(epoch.falsifications[0]?.executions[0]?.executionReceipt).toEqual(counterReceipt);
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

  async function executeReviewResult(review: unknown) {
    const runtimePort = { ...strictRuntimePort(), reviewProducerResult: () => review };
    const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
      params: { needsCandidates: true },
      context: { strategyContext: { strictProduction: runtimePort } },
    });
    return new PipelineStrategy({ stages }).execute(
      {
        id: 'strict-review-result',
        reactLoop: async () => ({
          reply: 'strict stage output',
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        }),
      },
      message,
      { strategyContext: { strictProduction: runtimePort } }
    );
  }

  it('accepts the Main host continue/true review through the real strict stage factory', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    try {
      const output = await executeReviewResult({
        action: 'continue',
        pass: true,
        artifact: { expressionSets: [] },
      });
      expect(output.outcome).toBe('completed');
      expect(output.phases.independent_review_gate).toMatchObject({
        action: 'pass',
        pass: true,
        artifact: { expressionSets: [] },
      });
      expect(output.phases._strictGateReturns).toContainEqual(
        expect.objectContaining({ gate: 'G2', verdict: 'pass' })
      );
      const translation = info.mock.calls.find(
        ([message]) => message === '[StrictProductionStages] G2 reviewer compatibility translation'
      );
      expect(translation?.[1]).toEqual({
        gate: 'G2',
        originalAction: 'continue',
        selectedAction: 'pass',
        reason: 'main-review-compatibility',
      });
    } finally {
      info.mockRestore();
    }
  });

  it.each([
    { label: 'contradictory pass', value: { action: 'pass', pass: false } },
    { label: 'truthy string', value: { pass: 'false' } },
    { label: 'unknown action', value: { action: 'unexpected', pass: true } },
    { label: 'null action', value: { action: null, pass: true } },
    { label: 'contradictory continue', value: { action: 'continue', pass: false } },
    { label: 'null', value: null },
  ])('rejects an invalid strict reviewer result: $label', async ({ value }) => {
    const output = await executeReviewResult(value);
    expect(output.outcome).toBe('failed');
    expect(output.phases.independent_review_gate).toMatchObject({
      action: 'reject',
      pass: false,
      reason: expect.stringContaining('STRICT_PRODUCTION_GATE_RESULT_INVALID'),
      // C19：宿主回执形状非法是 Reviewer 侧语义拒绝，与端口接线/I-O 故障（infrastructure）区分。
      artifact: {
        kind: 'StrictProductionGateExceptionV1',
        gate: 'G2',
        classification: 'semantic-reject',
        errorCode: 'STRICT_PRODUCTION_GATE_RESULT_INVALID',
      },
    });
    expect(output.phases._strictGateReturns).toContainEqual(
      expect.objectContaining({ gate: 'G2', verdict: 'failed', owner: 'independent-reviewer' })
    );
  });

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

  it.each([
    'malformed-score',
    'mixed-evidence-id',
    'mixed-citation',
  ])('fails closed on independent review %s', async (mutation) => {
    const reviewer = new IndependentValueReviewer({
      identity: { provider: 'reviewer', model: 'independent', method: 'review' },
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
            score: mutation === 'malformed-score' ? [2] : 2,
            reasonCode: 'supported',
            evidenceEntryIds:
              mutation === 'mixed-evidence-id' ? ['E-1', { missing: true }] : ['E-1'],
          })),
          noveltyDecision: 'novel-project-specific',
          duplicateDecision: 'no-match',
          citedLines:
            mutation === 'mixed-citation' ? ['src/handler.ts:1', 99] : ['src/handler.ts:1'],
        }),
    });
    const result = await reviewer.review({
      authored,
      evidence,
      expectedSourceRevisionVectorHash: 'vector-1',
      producerIdentity: 'producer/different',
      admissionReceiptId: 'admission-1',
      calibrationReceiptHash: 'calibration-1',
      repairAttempt: 0,
    });
    expect(result.verdict).toBe('reject');
  });

  it('reviews the complete authored projection from frozen evidence and fails closed on drift', async () => {
    const prompt = buildIndependentReviewPrompt({ authored, evidence });
    expect(prompt).toContain('usageGuide');
    expect(prompt).toContain('negativeIntent');
    expect(prompt).toContain('src/handler.ts:1-3');
    // P21：提示词写明轴 verdict/score 配对规则，parseReview 对不配对的轴整份拒绝。
    expect(prompt).toContain('pass=2, narrow=1, fail=0');

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

describe('R07 strict gate actual logger observer boundary', () => {
  it('retains a confirmed Main G2 pass when the real Winston data observer throws', async () => {
    const prior = Logger.instance;
    Logger.instance = null;
    const logger = Logger.getInstance({ console: false });
    let observed = 0;
    const callback = (info: { message?: unknown }) => {
      if (info.message === '[StrictProductionStages] G2 reviewer compatibility translation') {
        observed++;
        throw new Error('observer fixture failure');
      }
    };
    logger.on('data', callback);
    try {
      const artifact = { expressionSets: [], receipt: 'confirmed-review' };
      const port = {
        ...strictRuntimePort(),
        reviewProducerResult: () => ({ action: 'continue', pass: true, artifact }),
      };
      const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
        params: { needsCandidates: true },
        context: { strategyContext: { strictProduction: port } },
      });
      const output = await new PipelineStrategy({ stages }).execute(
        {
          id: 'log-observer-probe',
          reactLoop: async () => ({
            reply: 'strict stage output',
            toolCalls: [],
            tokenUsage: { input: 1, output: 1 },
            iterations: 1,
          }),
        },
        { role: 'internal', content: 'strict boundary probe', metadata: {} } as AgentMessage,
        { strategyContext: { strictProduction: port } }
      );
      expect(observed).toBe(1);
      expect(output.outcome).toBe('completed');
      expect(output.phases.independent_review_gate).toMatchObject({
        action: 'pass',
        pass: true,
        artifact,
      });
    } finally {
      logger.removeListener('data', callback);
      logger.destroy();
      Logger.instance = prior;
    }
  });
});

describe('strict Plan local semantic validation', () => {
  it('routes a local PLAN_UNKNOWN_FROZEN_QUERY failure through the existing semantic repair budget', async () => {
    const calls: AgentRunInput[] = [];
    const invalid = {
      ...strictIntent,
      plannedNextActions: strictIntent.plannedNextActions.map((a) => ({
        ...a,
        capabilityId: 'not-in-frozen-catalog',
      })),
    };
    const receipt = await runStrictPlanAgent({
      contextProjection: planContext(),
      agentService: {
        async run(input) {
          calls.push(input);
          return result(JSON.stringify(calls.length === 1 ? invalid : strictIntent));
        },
      },
      validateReceipt: () => undefined,
    });
    expect(calls).toHaveLength(2);
    expect(receipt.lineage.repairs).toHaveLength(1);
    // L8-C06：本地冻结查询拒绝必须定位到违规 action（下标、questionId 与越界的冻结 ID），
    // 修复轮才能定向修改，而不是只拿到一个裸错误码。
    expect(receipt.lineage.repairs[0].reason).toBe(
      'PLAN_UNKNOWN_FROZEN_QUERY: plannedNextActions[0] questionId="q-root" capabilityId="not-in-frozen-catalog" (not frozen) queryFamilyId="syntax-patterns"'
    );
    expect(receipt.lineage.repairs[0].parentInvocationId).toBe(
      receipt.lineage.initial.invocationId
    );
    expect(calls[1]?.message.content).toContain('not-in-frozen-catalog');
  });

  it('locates every action that leaves the frozen query catalog', async () => {
    const baseAction = strictIntent.plannedNextActions[0];
    const invalid = {
      ...strictIntent,
      plannedNextActions: [
        baseAction,
        { ...baseAction, order: 2, queryFamilyId: 'unfrozen-family' },
        { ...baseAction, order: 3, questionId: undefined, capabilityId: undefined },
      ],
    };
    let validations = 0;
    await expect(
      runStrictPlanAgent({
        contextProjection: { ...planContext(), hardCaps: { semanticRepairLimit: 0 } },
        agentService: { run: async () => result(JSON.stringify(invalid)) },
        validateReceipt: () => {
          validations++;
        },
      })
    ).rejects.toThrow(
      'PLAN_SEMANTIC_REPAIR_LIMIT: PLAN_UNKNOWN_FROZEN_QUERY: plannedNextActions[1] questionId="q-root" capabilityId="facts.syntax" queryFamilyId="unfrozen-family" (not frozen); plannedNextActions[2] questionId=null capabilityId=null (not frozen) queryFamilyId="syntax-patterns"'
    );
    // 本地冻结查询校验在宿主校验之前短路，宿主校验器不会收到越界 intent。
    expect(validations).toBe(0);
  });
  it('does not retry a failed provider as semantic plan repair', async () => {
    let count = 0;
    await expect(
      runStrictPlanAgent({
        contextProjection: planContext(),
        agentService: {
          async run() {
            count++;
            return { ...result('provider unavailable'), status: 'error' };
          },
        },
        validateReceipt: () => undefined,
      })
    ).rejects.toThrow('STRICT_PLAN_RUN_FAILED');
    expect(count).toBe(1);
  });
});

// L8-C19：严格 Plan 的错误载体必须让宿主看得到真实进度并只收到 Error 实例；修复上限越界显式拒绝。
describe('strict Plan error carriers and repair cap', () => {
  it('fails PLAN_TOOL_FORBIDDEN with partialResult and the executed tool names', async () => {
    let count = 0;
    const toolRun: AgentRunResult = {
      ...result(JSON.stringify(strictIntent)),
      toolCalls: [
        { tool: 'write_file', args: { path: 'a.ts' }, result: { ok: true }, durationMs: 3 },
        { tool: 'write_file', args: { path: 'b.ts' }, result: { ok: true }, durationMs: 2 },
        { tool: 'shell.exec', args: { cmd: 'echo' }, result: 'ok', durationMs: 1 },
      ],
    };
    const failure = await runStrictPlanAgent({
      contextProjection: planContext(),
      agentService: {
        async run() {
          count++;
          return toolRun;
        },
      },
      validateReceipt: () => undefined,
    }).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error & { partialResult?: AgentRunResult };
    expect(error.message).toBe('PLAN_TOOL_FORBIDDEN: write_file, shell.exec');
    expect(error.partialResult).toBe(toolRun);
    expect(error.cause).toBe(toolRun);
    // 工具违规不是语义缺口，不能消耗因果修复预算重试。
    expect(count).toBe(1);
  });

  it('normalizes a non-Error host validator rejection into an Error instance without repair', async () => {
    const warn = vi.fn();
    const getInstance = vi.spyOn(Logger, 'getInstance').mockReturnValue({ warn } as never);
    let count = 0;
    try {
      const failure = await runStrictPlanAgent({
        contextProjection: planContext(),
        agentService: {
          async run() {
            count++;
            return result(JSON.stringify(strictIntent));
          },
        },
        validateReceipt: () => {
          // 宿主校验器违反约定抛出字符串；调用方仍必须收到 Error 实例。
          // biome-ignore lint/style/useThrowOnlyError: 故意抛出非 Error 值，覆盖宿主校验器违约时包成 Error 的分支。
          throw 'host validator exploded';
        },
      }).then(
        () => null,
        (err: unknown) => err
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('host validator exploded');
      expect((failure as Error).cause).toBe('host validator exploded');
      expect(count).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        reasonCode: 'strict-plan-non-error-rejection-normalized',
        rejectionType: 'string',
        semanticRepairAttempt: 0,
        resolution: 'rethrow-as-error',
      });
    } finally {
      getInstance.mockRestore();
    }
  });

  it('keeps rethrowing a non-PLAN host Error instance unchanged', async () => {
    const hostError = new Error('host compile failure');
    await expect(
      runStrictPlanAgent({
        contextProjection: planContext(),
        agentService: { run: async () => result(JSON.stringify(strictIntent)) },
        validateReceipt: () => {
          throw hostError;
        },
      })
    ).rejects.toBe(hostError);
  });

  it('rejects semanticRepairLimit above the strict cap of 2 before any model call', async () => {
    let count = 0;
    const context = planContext();
    await expect(
      runStrictPlanAgent({
        contextProjection: { ...context, hardCaps: { semanticRepairLimit: 3 } },
        agentService: {
          async run() {
            count++;
            return result(JSON.stringify(strictIntent));
          },
        },
        validateReceipt: () => undefined,
      })
    ).rejects.toThrow(/^STRICT_PLAN_CONTEXT_INVALID: semanticRepairLimit=3 exceeds strict cap 2$/u);
    expect(count).toBe(0);
  });

  it('still honours a semanticRepairLimit below the cap', async () => {
    let count = 0;
    await expect(
      runStrictPlanAgent({
        contextProjection: { ...planContext(), hardCaps: { semanticRepairLimit: 0 } },
        agentService: {
          async run() {
            count++;
            return result(JSON.stringify(strictIntent));
          },
        },
        validateReceipt: () => {
          throw new Error('PLAN_ACTION_SCOPE_MISMATCH: q-root');
        },
      })
    ).rejects.toThrow('PLAN_SEMANTIC_REPAIR_LIMIT: PLAN_ACTION_SCOPE_MISMATCH: q-root');
    expect(count).toBe(1);
  });
});

/**
 * Core coldStartProductionPlan.ts 中全部 PLAN_* 码的分类（L8-C06 漂移守护）。
 * 可修复：只取决于模型输出 intent 的 cognition 校验码，重采样有机会修好。
 * 确定性：取决于宿主事实、配置、策略或 Agent 构造的 receipt/lineage，重试只会以同样方式失败。
 * Core 新增或改名 PLAN_* 码时，下方守护用例先失败，迫使同步更新 PlanAgentRun 的白名单。
 */
const CORE_MODEL_REPAIRABLE_PLAN_CODES = [
  'PLAN_ACTION_INCOMPLETE',
  'PLAN_ACTION_SCOPE_MISMATCH',
  'PLAN_ACTION_UNKNOWN_QUESTION',
  'PLAN_BUDGET_OUT_OF_BOUNDS',
  'PLAN_DECOMPOSITION_MISSING',
  'PLAN_QUERY_CAPABILITY_SCALE_MISMATCH',
  'PLAN_QUESTION_CYCLE',
  'PLAN_QUESTION_DUPLICATE',
  'PLAN_QUESTION_INCOMPLETE',
  'PLAN_QUESTION_INVALID',
  'PLAN_QUESTION_UNSCHEDULED',
  'PLAN_REQUIRED_LENS_STARVED',
  'PLAN_REQUIRED_LENS_UNSCHEDULED',
  'PLAN_SYNTHESIS_PREREQUISITES_INVALID',
  'PLAN_UNKNOWN_ANALYSIS_SCALE',
  'PLAN_UNKNOWN_ANATOMY_LENS',
  'PLAN_UNKNOWN_CAPABILITY',
  'PLAN_UNKNOWN_QUERY_FAMILY',
  'PLAN_UNKNOWN_SUBJECT',
  'PLAN_UNKNOWN_SUBQUESTION',
];
const CORE_DETERMINISTIC_PLAN_CODES = [
  'PLAN_CELL_UNIVERSE_CONSERVATION',
  'PLAN_COGNITION_INVALID',
  'PLAN_COGNITION_NOT_ACCEPTED',
  'PLAN_COGNITION_STALE',
  'PLAN_FACT_DUPLICATE',
  'PLAN_FACT_MISSING',
  'PLAN_LINEAGE_BROKEN',
  'PLAN_LINEAGE_OUTPUT_MISMATCH',
  'PLAN_POLICY_UNSUPPORTED',
  'PLAN_ROLE_VOCABULARY_INVALID',
  'PLAN_ROLE_VOCABULARY_MISSING',
  'PLAN_SCALE_UNSUPPORTED',
  'PLAN_SEMANTIC_REPAIR_LIMIT',
  'PLAN_STAGE_UNSUPPORTED',
];

function sha256Prefixed(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function mockStrictPlanLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const getInstance = vi.spyOn(Logger, 'getInstance').mockReturnValue({ info, warn } as never);
  return { info, warn, restore: () => getInstance.mockRestore() };
}

// L8-C06：严格 Plan 修复链只对白名单 PLAN_* 与结构非法输出重试（同一预算），修复轮携带父输出。
describe('strict Plan repair eligibility and parent output', () => {
  const validReply = JSON.stringify(strictIntent);
  const truncatedReply = validReply.slice(0, Math.floor(validReply.length / 2));

  function scriptedService(replies: readonly string[], calls: AgentRunInput[]) {
    return {
      async run(input: AgentRunInput) {
        calls.push(input);
        return result(replies[Math.min(calls.length, replies.length) - 1] ?? '');
      },
    };
  }

  it('rethrows a deterministic PLAN_SCALE_UNSUPPORTED rejection after one call without relabeling', async () => {
    const logger = mockStrictPlanLogger();
    const calls: AgentRunInput[] = [];
    const scaleError = new Error(
      'PLAN_SCALE_UNSUPPORTED: complete module/cell universe exceeds strict-v2 wire'
    );
    try {
      await expect(
        runStrictPlanAgent({
          contextProjection: planContext(),
          agentService: scriptedService([validReply], calls),
          validateReceipt: () => {
            throw scaleError;
          },
        })
      ).rejects.toBe(scaleError);
      expect(calls).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({
        reasonCode: 'strict-plan-repair-ineligible',
        failureCode: 'PLAN_SCALE_UNSUPPORTED',
        semanticRepairAttempt: 0,
        resolution: 'rethrow-original',
      });
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      logger.restore();
    }
  });

  it('treats a truncated JSON reply as a structural repair inside the same budget', async () => {
    const logger = mockStrictPlanLogger();
    const calls: AgentRunInput[] = [];
    try {
      const receipt = await runStrictPlanAgent({
        contextProjection: planContext(),
        agentService: scriptedService([truncatedReply, validReply], calls),
        validateReceipt: () => undefined,
      });
      expect(calls).toHaveLength(2);
      expect(receipt.lineage.repairs).toHaveLength(1);
      const [repair] = receipt.lineage.repairs;
      expect(repair?.reason).toMatch(/^STRICT_PLAN_INTENT_JSON_INVALID: /u);
      expect(repair?.parentInvocationId).toBe(receipt.lineage.initial.invocationId);
      // 结构非法的父调用没有 intent：outputHash 记录原始回复字节，最终输出仍绑定 intent 哈希。
      expect(receipt.lineage.initial.outputHash).toBe(sha256Prefixed(truncatedReply));
      expect(repair?.outputHash).toBe(hashStrictPlanIntentV1(receipt.intent));
      expect(repair?.inputHash).toBe(
        createHash('sha256')
          .update(calls[1]?.message.content ?? '')
          .digest('hex')
      );
      const repairPrompt = calls[1]?.message.content ?? '';
      expect(repairPrompt).toContain('因果结构修复');
      expect(repairPrompt).toContain(truncatedReply);
      expect(repairPrompt).toContain(receipt.lineage.initial.outputHash);
      expect(calls[1]?.message.metadata).toMatchObject({ semanticRepairAttempt: 1 });
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info.mock.calls[0]?.[1]).toMatchObject({
        reasonCode: 'strict-plan-repair-scheduled',
        repairKind: 'structural',
        failureCode: 'STRICT_PLAN_INTENT_JSON_INVALID',
        semanticRepairAttempt: 0,
        remainingRepairs: 1,
      });
    } finally {
      logger.restore();
    }
  });

  it('names the failing field when the intent shape is invalid and repairs it', async () => {
    const calls: AgentRunInput[] = [];
    const { budgetStrategy: _omitted, ...withoutBudget } = strictIntent;
    const receipt = await runStrictPlanAgent({
      contextProjection: planContext(),
      agentService: scriptedService([JSON.stringify(withoutBudget), validReply], calls),
      validateReceipt: () => undefined,
    });
    expect(calls).toHaveLength(2);
    expect(receipt.lineage.repairs[0]?.reason).toBe(
      'STRICT_PLAN_INTENT_SHAPE_INVALID: budgetStrategy.schemaVersion missing'
    );
  });

  it('carries the rejected parent intent as canonical JSON into the semantic repair prompt', async () => {
    const calls: AgentRunInput[] = [];
    const marker = 'UNIQUE_PARENT_OUTPUT_MARKER_L8_C06';
    const parentIntent = {
      ...strictIntent,
      plannedNextActions: strictIntent.plannedNextActions.map((action) => ({
        ...action,
        reason: marker,
      })),
    };
    let validations = 0;
    const receipt = await runStrictPlanAgent({
      contextProjection: planContext(),
      agentService: scriptedService([JSON.stringify(parentIntent), validReply], calls),
      validateReceipt: () => {
        validations++;
        if (validations === 1) {
          throw new Error('PLAN_REQUIRED_LENS_UNSCHEDULED: scope:workspace/structure-and-boundary');
        }
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.message.content).not.toContain(marker);
    const repairPrompt = calls[1]?.message.content ?? '';
    expect(repairPrompt).toContain('因果语义修复');
    expect(repairPrompt).toContain(canonicalJsonStringify(parentIntent));
    expect(repairPrompt).toContain(receipt.lineage.initial.outputHash);
    expect(repairPrompt).toContain('最小修改');
    expect(receipt.lineage.initial.outputHash).toBe(hashStrictPlanIntentV1(parentIntent));
    expect(receipt.lineage.repairs[0]?.reason).toBe(
      'PLAN_REQUIRED_LENS_UNSCHEDULED: scope:workspace/structure-and-boundary'
    );
  });

  it('chains a structural repair and a semantic repair into one causal lineage', async () => {
    const calls: AgentRunInput[] = [];
    let validations = 0;
    const receipt = await runStrictPlanAgent({
      contextProjection: planContext(),
      agentService: scriptedService([truncatedReply, validReply, validReply], calls),
      validateReceipt: () => {
        validations++;
        if (validations === 1) {
          throw new Error('PLAN_QUESTION_INCOMPLETE: q-root');
        }
      },
    });
    expect(calls).toHaveLength(3);
    const [structural, semantic] = receipt.lineage.repairs;
    expect(structural?.parentInvocationId).toBe(receipt.lineage.initial.invocationId);
    expect(structural?.reason).toMatch(/^STRICT_PLAN_INTENT_JSON_INVALID: /u);
    expect(semantic?.parentInvocationId).toBe(structural?.invocationId);
    expect(semantic?.reason).toBe('PLAN_QUESTION_INCOMPLETE: q-root');
    // 第二轮修复的父输出是第一次修复产出的合法 intent，而不是最初被截断的回复。
    expect(calls[2]?.message.content).toContain(canonicalJsonStringify(strictIntent));
    expect(calls[2]?.message.content).not.toContain(truncatedReply);
  });

  it('still caps structural plus semantic repairs at two in total', async () => {
    const logger = mockStrictPlanLogger();
    const calls: AgentRunInput[] = [];
    try {
      const failure = await runStrictPlanAgent({
        contextProjection: planContext(),
        agentService: scriptedService([truncatedReply, validReply, truncatedReply], calls),
        validateReceipt: () => {
          throw new Error('PLAN_QUESTION_INCOMPLETE: q-root');
        },
      }).then(
        () => null,
        (err: unknown) => err
      );
      expect(calls).toHaveLength(3);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /^PLAN_SEMANTIC_REPAIR_LIMIT: STRICT_PLAN_INTENT_JSON_INVALID: /u
      );
      expect((failure as Error).cause).toBeInstanceOf(Error);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({
        reasonCode: 'strict-plan-repair-exhausted',
        repairKind: 'structural',
        failureCode: 'STRICT_PLAN_INTENT_JSON_INVALID',
        semanticRepairAttempt: 2,
        semanticRepairLimit: 2,
      });
    } finally {
      logger.restore();
    }
  });

  it('fails a structural rejection immediately when the repair budget is zero', async () => {
    const calls: AgentRunInput[] = [];
    await expect(
      runStrictPlanAgent({
        contextProjection: { ...planContext(), hardCaps: { semanticRepairLimit: 0 } },
        agentService: scriptedService([''], calls),
        validateReceipt: () => undefined,
      })
    ).rejects.toThrow(/^PLAN_SEMANTIC_REPAIR_LIMIT: STRICT_PLAN_EMPTY_REPLY$/u);
    expect(calls).toHaveLength(1);
  });

  // L8-C06 返工：Core hashStrictPlanIntentV1 → normalizeStrictPlanIntent 会深读 projectProfile、scale、
  // 每个问题的字符串数组、action.tool 等字段。这些形状错误以前以裸 TypeError 在第一次调用后直接失败
  // （无错误码、无 lineage、无诊断），现在必须归为 STRICT_PLAN_INTENT_SHAPE_INVALID，进入同一修复预算。
  const [baseAction] = strictIntent.plannedNextActions;
  const [baseQuestion] = strictIntent.investigationDecomposition.questions;
  const { projectProfile: _omittedProfile, ...withoutProjectProfile } = strictIntent;
  const { scale: _omittedScale, ...withoutScale } = strictIntent;
  const { subquestionIds: _omittedSubquestions, ...questionWithoutSubquestions } = baseQuestion;
  const { tool: _omittedTool, ...actionWithoutTool } = baseAction;
  const deepShapeCases = [
    {
      name: 'missing projectProfile',
      reply: JSON.stringify(withoutProjectProfile),
      detail: 'projectProfile must be an object',
    },
    {
      name: 'missing scale',
      reply: JSON.stringify(withoutScale),
      detail: 'scale must be an object',
    },
    {
      name: 'question without subquestionIds',
      reply: JSON.stringify({
        ...strictIntent,
        investigationDecomposition: {
          ...strictIntent.investigationDecomposition,
          questions: [questionWithoutSubquestions],
        },
      }),
      detail: 'investigationDecomposition.questions[0].subquestionIds must be an array of strings',
    },
    {
      name: 'questions given as an object',
      reply: JSON.stringify({
        ...strictIntent,
        investigationDecomposition: {
          ...strictIntent.investigationDecomposition,
          questions: { 'q-root': baseQuestion },
        },
      }),
      detail: 'investigationDecomposition.questions must be an array',
    },
    {
      name: 'second action without tool',
      reply: JSON.stringify({
        ...strictIntent,
        plannedNextActions: [baseAction, { ...actionWithoutTool }],
      }),
      detail: 'plannedNextActions[1].tool must be a string',
    },
    {
      name: 'non-finite number',
      reply: validReply.replace('"totalRecipeBudget":0', '"totalRecipeBudget":1e999'),
      detail: 'scale.totalRecipeBudget',
    },
  ];

  it.each(
    deepShapeCases
  )('repairs a deep shape error ($name) as STRICT_PLAN_INTENT_SHAPE_INVALID inside the same budget', async ({
    reply,
    detail,
  }) => {
    expect(reply).not.toBe(validReply);
    const logger = mockStrictPlanLogger();
    const calls: AgentRunInput[] = [];
    let validations = 0;
    try {
      const receipt = await runStrictPlanAgent({
        contextProjection: planContext(),
        agentService: scriptedService([reply, validReply], calls),
        validateReceipt: () => {
          validations++;
        },
      });
      expect(calls).toHaveLength(2);
      // 形状非法的 intent 不进入宿主校验器，只有修复后的合法 intent 被校验一次。
      expect(validations).toBe(1);
      expect(receipt.lineage.repairs).toHaveLength(1);
      const [repair] = receipt.lineage.repairs;
      expect(repair?.reason).toMatch(/^STRICT_PLAN_INTENT_SHAPE_INVALID: /u);
      expect(repair?.reason).toContain(detail);
      expect(repair?.parentInvocationId).toBe(receipt.lineage.initial.invocationId);
      // 形状非法的父调用 outputHash 取自原始回复；最终调用仍绑定最终 intent 的 Core 哈希。
      expect(receipt.lineage.initial.outputHash).toBe(sha256Prefixed(reply));
      expect(repair?.outputHash).toBe(hashStrictPlanIntentV1(receipt.intent));
      const repairPrompt = calls[1]?.message.content ?? '';
      expect(repairPrompt).toContain('因果结构修复');
      expect(repairPrompt).toContain(reply);
      const scheduled = logger.info.mock.calls
        .map((call) => call[1] as Record<string, unknown> | undefined)
        .filter((data) => data?.reasonCode === 'strict-plan-repair-scheduled');
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({
        repairKind: 'structural',
        failureCode: 'STRICT_PLAN_INTENT_SHAPE_INVALID',
        semanticRepairAttempt: 0,
        remainingRepairs: 1,
      });
    } finally {
      logger.restore();
    }
  });

  it('keeps the Core canonicalization exception as the cause of a non-finite shape rejection', async () => {
    const logger = mockStrictPlanLogger();
    const calls: AgentRunInput[] = [];
    const reply = validReply.replace('"totalRecipeBudget":0', '"totalRecipeBudget":1e999');
    try {
      const failure = await runStrictPlanAgent({
        contextProjection: { ...planContext(), hardCaps: { semanticRepairLimit: 0 } },
        agentService: scriptedService([reply], calls),
        validateReceipt: () => undefined,
      }).then(
        () => null,
        (err: unknown) => err
      );
      expect(calls).toHaveLength(1);
      expect(failure).toBeInstanceOf(Error);
      const limit = failure as Error;
      expect(limit.message).toBe(
        'PLAN_SEMANTIC_REPAIR_LIMIT: STRICT_PLAN_INTENT_SHAPE_INVALID: intent is not canonical JSON (Canonical JSON does not accept non-finite numbers.); non-finite numbers at scale.totalRecipeBudget'
      );
      const shape = limit.cause as Error;
      expect(shape).toBeInstanceOf(Error);
      expect(shape.message).toMatch(/^STRICT_PLAN_INTENT_SHAPE_INVALID: /u);
      // 原始 Core 异常保留为 cause，便于区分形状缺口与 Core 规范化规则变化。
      expect(shape.cause).toBeInstanceOf(TypeError);
      const canonicalizationLog = logger.warn.mock.calls
        .map((call) => call[1] as Record<string, unknown> | undefined)
        .find((data) => data?.reasonCode === 'strict-plan-intent-canonicalization-failed');
      expect(canonicalizationLog).toMatchObject({
        resolution: 'structural-rejection',
        nonFinitePaths: ['scale.totalRecipeBudget'],
      });
      expect(
        logger.warn.mock.calls.some(
          (call) =>
            (call[1] as Record<string, unknown> | undefined)?.reasonCode ===
            'strict-plan-repair-exhausted'
        )
      ).toBe(true);
    } finally {
      logger.restore();
    }
  });

  it('exhausts the shared budget when every reply keeps the same deep shape error', async () => {
    const calls: AgentRunInput[] = [];
    const reply = JSON.stringify(withoutProjectProfile);
    await expect(
      runStrictPlanAgent({
        contextProjection: planContext(),
        agentService: scriptedService([reply], calls),
        validateReceipt: () => undefined,
      })
    ).rejects.toThrow(
      /^PLAN_SEMANTIC_REPAIR_LIMIT: STRICT_PLAN_INTENT_SHAPE_INVALID: projectProfile must be an object$/u
    );
    expect(calls).toHaveLength(3);
  });

  it('lists every deep shape problem in one rejection, capped for prompt size', async () => {
    const calls: AgentRunInput[] = [];
    const brokenQuestions = Array.from({ length: 30 }, (_, index) => ({
      ...questionWithoutSubquestions,
      questionId: `q-${index}`,
    }));
    const reply = JSON.stringify({
      ...withoutScale,
      investigationDecomposition: {
        ...strictIntent.investigationDecomposition,
        questions: brokenQuestions,
      },
    });
    const failure = await runStrictPlanAgent({
      contextProjection: { ...planContext(), hardCaps: { semanticRepairLimit: 0 } },
      agentService: scriptedService([reply], calls),
      validateReceipt: () => undefined,
    }).then(
      () => null,
      (err: unknown) => err
    );
    expect(calls).toHaveLength(1);
    const message = (failure as Error).message;
    expect(message).toMatch(
      /^PLAN_SEMANTIC_REPAIR_LIMIT: STRICT_PLAN_INTENT_SHAPE_INVALID: scale must be an object; investigationDecomposition\.questions\[0\]\.subquestionIds must be an array of strings; /u
    );
    // 31 个问题（scale + 30 个缺失 subquestionIds 的问题）只列前 20 个，其余汇总为计数。
    expect(message).toContain('investigationDecomposition.questions[18].subquestionIds');
    expect(message).not.toContain('investigationDecomposition.questions[19].subquestionIds');
    expect(message).toMatch(/; \(\+11 more\)$/u);
  });

  it('never lets a wrong-typed intent field escape Core canonicalization as a raw TypeError', async () => {
    // 守护本地形状检查与 Core normalizeStrictPlanIntent 的同步：对基准 intent 的每个字段路径逐一
    // 删除或替换成错误类型，结果只能是成功，或带 STRICT_PLAN_* / PLAN_* 码的显式拒绝。
    // 基准里每类数组放两项且排序键相同，确保 Core 排序比较器（tool/questionId/modulePath 等）被执行。
    const secondQuestion = { ...baseQuestion, questionId: 'q-leaf' };
    const fuzzBase = {
      ...strictIntent,
      projectProfile: {
        ...strictIntent.projectProfile,
        secondaryLanguages: ['ts'],
        frameworks: ['node'],
        architectureHints: ['monorepo'],
      },
      dimensions: [...strictIntent.dimensions, { ...strictIntent.dimensions[0] }],
      moduleBindings: [
        {
          modulePath: 'src/a',
          moduleId: 'a',
          dimensions: ['architecture'],
          targetRecipes: 1,
          priority: 1,
        },
        {
          modulePath: 'src/a',
          moduleId: 'a',
          dimensions: ['architecture'],
          targetRecipes: 1,
          priority: 1,
        },
      ],
      plannedNextActions: [baseAction, { ...baseAction, reason: 'second pass' }],
      evidenceRefs: [
        ...strictIntent.evidenceRefs,
        { kind: 'project-context' as const, ref: 'artifact:pcf', detail: 'dup' },
      ],
      investigationDecomposition: {
        ...strictIntent.investigationDecomposition,
        questions: [baseQuestion, secondQuestion],
      },
      synthesisPrerequisiteCellIds: { 'a::architecture': ['a::x', 'a::y'] },
    };
    const wrongValues: readonly unknown[] = [undefined, null, 7, 'x', { k: 1 }, [1]];
    const paths: (string | number)[][] = [];
    const walk = (value: unknown, path: (string | number)[]) => {
      if (path.length > 0) {
        paths.push(path);
      }
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          walk(item, [...path, index]);
        }
      } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          walk(item, [...path, key]);
        }
      }
    };
    walk(fuzzBase, []);
    expect(paths.length).toBeGreaterThan(100);

    const logger = mockStrictPlanLogger();
    const escaped: string[] = [];
    try {
      for (const path of paths) {
        for (const wrong of wrongValues) {
          const mutated = structuredClone(fuzzBase) as Record<string | number, unknown>;
          let parent = mutated;
          for (const key of path.slice(0, -1)) {
            parent = parent[key] as Record<string | number, unknown>;
          }
          const leaf = path[path.length - 1];
          if (wrong === undefined) {
            delete parent[leaf];
          } else {
            parent[leaf] = wrong;
          }
          const outcome = await runStrictPlanAgent({
            contextProjection: { ...planContext(), hardCaps: { semanticRepairLimit: 0 } },
            agentService: { run: async () => result(JSON.stringify(mutated)) },
            validateReceipt: () => undefined,
          }).then(
            () => null,
            (err: unknown) => err
          );
          if (outcome === null) {
            continue;
          }
          const message = outcome instanceof Error ? outcome.message : String(outcome);
          if (
            outcome instanceof TypeError ||
            !/^PLAN_SEMANTIC_REPAIR_LIMIT: (STRICT_PLAN_|PLAN_)[A-Z_]+/u.test(message)
          ) {
            escaped.push(`${path.join('.')}=${JSON.stringify(wrong) ?? 'deleted'}: ${message}`);
          }
        }
      }
      // 扫描不注入非有限数字，所以 Core 规范化兜底分支一次都不应触发：触发说明 Core 新读取了
      // 本地形状检查没覆盖的字段，需要补齐检查（兜底只保证不逃逸，不提供定位信息）。
      const backstopHits = logger.warn.mock.calls.filter(
        (call) =>
          (call[1] as Record<string, unknown> | undefined)?.reasonCode ===
          'strict-plan-intent-canonicalization-failed'
      );
      expect(backstopHits.map((call) => call[0])).toEqual([]);
    } finally {
      logger.restore();
    }
    expect(escaped).toEqual([]);
  });

  it('classifies every Core PLAN_* code and repairs only the model-fixable ones', async () => {
    const coreSource = readFileSync(
      new URL(
        '../node_modules/@alembic/core/dist/service/plan/intent/coldStartProductionPlan.js',
        import.meta.url
      ),
      'utf8'
    );
    const coreCodes = [
      ...new Set([...coreSource.matchAll(/['"](PLAN_[A-Z0-9_]+)['"]/gu)].map((match) => match[1])),
    ].sort();
    expect(coreCodes).toEqual(
      [...CORE_MODEL_REPAIRABLE_PLAN_CODES, ...CORE_DETERMINISTIC_PLAN_CODES].sort()
    );
    const logger = mockStrictPlanLogger();
    try {
      for (const code of coreCodes) {
        const calls: AgentRunInput[] = [];
        const rejection = new Error(`${code}: drift-guard`);
        let validations = 0;
        const outcome = await runStrictPlanAgent({
          contextProjection: planContext(),
          agentService: scriptedService([validReply], calls),
          validateReceipt: () => {
            validations++;
            if (validations === 1) {
              throw rejection;
            }
          },
        }).then(
          (receipt) => ({ receipt, error: null }),
          (err: unknown) => ({ receipt: null, error: err })
        );
        if (CORE_MODEL_REPAIRABLE_PLAN_CODES.includes(code)) {
          expect({ code, calls: calls.length, repaired: outcome.receipt !== null }).toEqual({
            code,
            calls: 2,
            repaired: true,
          });
        } else {
          expect({ code, calls: calls.length, sameError: outcome.error === rejection }).toEqual({
            code,
            calls: 1,
            sameError: true,
          });
        }
      }
    } finally {
      logger.restore();
    }
  });
});
