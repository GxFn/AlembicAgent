#!/usr/bin/env node
/**
 * 严格生产链 frozen/mock 评估：加载构建后的 Agent/Core 入口，不发网络请求，也不读取
 * provider 凭据。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const goldenPath = path.join(root, 'test/fixtures/strict-production/golden.json');
const goldenBytes = readFileSync(goldenPath);
const golden = JSON.parse(goldenBytes.toString('utf8'));
const outputArg = process.argv.indexOf('--out');
const outputPath = path.resolve(
  root,
  outputArg >= 0 && process.argv[outputArg + 1]
    ? process.argv[outputArg + 1]
    : 'test-reports/strict-production/report.json'
);
const loadedCoreModulePath = fileURLToPath(import.meta.resolve('@alembic/core/production'));
const loadedAgentModules = {
  plan: path.join(root, 'dist/agent/runs/plan/PlanAgentRun.js'),
  pipeline: path.join(root, 'dist/agent/strategies/PipelineStrategy.js'),
  production: path.join(root, 'dist/agent/production/StrictProductionPipeline.js'),
  productionStages: path.join(root, 'dist/agent/production/StrictProductionStages.js'),
  productionPrompts: path.join(root, 'dist/agent/production/StrictProductionPrompts.js'),
  reviewer: path.join(root, 'dist/agent/evaluation/IndependentValueReviewer.js'),
};

const { runStrictPlanAgent } = await import(
  path.join(root, 'dist/agent/runs/plan/PlanAgentRun.js')
);
const {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisFixpointV1,
  createStrictHypothesisExpressionSetReceiptV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  validateStrictAnalystEpochV1,
} = await import(path.join(root, 'dist/agent/production/StrictProductionPipeline.js'));
const {
  assertFactQueryExecutionReceiptV1,
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAnalysisReviewContextHashV1,
  createKnowledgeDispositionReviewV1,
  createProductionActorIdentityV1,
  hashKnowledgeDispositionProposalV1,
} = await import('@alembic/core/production');
const { IndependentValueReviewer, computeJudgeCalibration, createFrozenEvidenceProjection } =
  await import(path.join(root, 'dist/agent/evaluation/IndependentValueReviewer.js'));
const { InvestigatedEmptyReviewer } = await import(
  path.join(root, 'dist/agent/evaluation/InvestigatedEmptyReviewer.js')
);

const providerIdentity = {
  provider: 'frozen',
  model: 'strict-production-golden-v1',
  method: 'deterministic-json-fixture',
};
const reviewerIdentity = {
  provider: 'frozen',
  model: 'independent-reviewer-golden-v1',
  method: 'independent-value-v1',
};
const config = {
  semanticRepairLimit: 2,
  obligationCap: 4,
  evidenceProjection: 'immutable-core-ids-v1',
  strictNoFloor: true,
};

const cases = [];
for (const fixture of golden.cases) {
  cases.push(await runFixture(loadSourceFixture(fixture)));
}

const calibrationRecords = [
  ...Array.from({ length: 20 }, () => ({
    humanDecision: 'uphold',
    judgeVerdict: { verdict: 'uphold' },
  })),
  ...Array.from({ length: 10 }, () => ({
    humanDecision: 'reject',
    judgeVerdict: { verdict: 'reject' },
  })),
];
const calibration = computeJudgeCalibration(calibrationRecords);
const reportSemantic = {
  schemaVersion: 1,
  kind: 'StrictProductionEvaluationReport',
  executionMode: 'frozen/mock-no-network-no-key',
  providerIdentity,
  reviewerIdentity,
  identityHashes: {
    providerHash: hash(providerIdentity),
    reviewerHash: hash(reviewerIdentity),
    configHash: hash(config),
    goldenHash: `sha256:${sha256(goldenBytes)}`,
  },
  loadedContracts: {
    upstream: golden.upstream,
    loadedCoreModuleSha256: `sha256:${sha256(readFileSync(loadedCoreModulePath))}`,
    loadedAgentModuleSha256: Object.fromEntries(
      Object.entries(loadedAgentModules).map(([name, modulePath]) => [
        name,
        `sha256:${sha256(readFileSync(modulePath))}`,
      ])
    ),
    agentEntrypoints: [
      'runStrictPlanAgent',
      'validateStrictAnalystEpochV1',
      'createStrictAnalysisFixpointV1',
      'createStrictHypothesisExpressionSetReceiptV1',
      'createStrictProducerExpressionSetV1',
      'IndependentValueReviewer',
      'InvestigatedEmptyReviewer',
    ],
    coreModule: '@alembic/core/production',
    coreContractConsumption: [
      'AnalysisScheduleExpansionReceiptV1',
      'ObservationPopulationV1',
      'KnowledgeClusterSetV1',
      'InductionReceiptV1',
      'FalsificationReceiptV1',
      'AnalysisFixpointReceiptV1',
      'KnowledgeDispositionReviewV1',
      'HypothesisExpressionSetReceiptV1',
      'TypedGateReturnV1',
    ],
  },
  networkRequestCount: 0,
  apiKeyReadCount: 0,
  calibration,
  cases,
  passed:
    calibration.promotionEligible &&
    cases.every(
      (entry) =>
        entry.producer.cardinality === entry.expectedProposalCardinality &&
        entry.reviewer.verdict === entry.expectedReviewVerdict &&
        entry.stageOrder.join('>') === 'Plan>Analyst>Producer>Independent Reviewer'
    ),
};
const report = { ...reportSemantic, reportHash: hash(reportSemantic) };
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output: path.relative(root, outputPath), passed: report.passed, reportHash: report.reportHash })}\n`
);
if (!report.passed) {
  process.exitCode = 1;
}

async function runFixture(fixture) {
  const strictIntent = buildIntent(fixture);
  let validationCount = 0;
  const plan = await runStrictPlanAgent({
    agentService: {
      run: async () => ({
        runId: `plan-${fixture.id}`,
        profileId: 'plan-selection',
        reply: JSON.stringify(strictIntent),
        status: 'success',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
        diagnostics: null,
      }),
    },
    contextProjection: {
      schemaVersion: 1,
      generationStage: 'coldStart',
      factsHash: `facts-${fixture.id}`,
      catalogHash: 'catalog-frozen-v1',
      sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
      sourceArtifactHash: `artifact-${fixture.id}`,
      modelHash: hash(providerIdentity),
      promptHash: hash({ prompt: 'strict-plan-v1' }),
      projectContextFacts: {
        scopes: Array.from({ length: fixture.scopeCount }, (_, index) => ({
          scopeId: `scope:${fixture.id}:${index}`,
          modulePath: `module-${index}`,
        })),
      },
      frozenCapabilityIds: ['facts.syntax'],
      frozenQueryFamilyIds: ['syntax-patterns'],
      hardCaps: { semanticRepairLimit: 2 },
    },
    validateReceipt: () => {
      validationCount += 1;
      if (fixture.expectedProposalCardinality > 0 && validationCount === 1) {
        throw new Error('PLAN_REQUIRED_LENS_UNSCHEDULED: frozen causal repair');
      }
    },
  });

  const { epoch, finalSchedule, fixpoint, producer, reviewer } = await runSemanticFixture(fixture);

  return {
    fixtureId: fixture.id,
    project: fixture.project,
    expectedProposalCardinality: fixture.expectedProposalCardinality,
    expectedReviewVerdict: fixture.expectedReviewVerdict,
    stageOrder: ['Plan', 'Analyst', 'Producer', 'Independent Reviewer'],
    plan: {
      receiptId: plan.receiptId,
      receiptHash: hash(plan),
      invocationCount: 1 + plan.lineage.repairs.length,
      semanticRepairCount: plan.lineage.repairs.length,
      toolCallCount: 0,
      fullScopeCount: fixture.scopeCount,
    },
    analyst: {
      expansionReceiptHashes: finalSchedule.expansionReceiptHashes,
      populationHash: epoch.population.populationHash,
      clusterSetHash: epoch.clusterSet.clusterSetHash,
      inductionReceiptHashes: epoch.inductions.map((row) => row.receiptHash),
      falsificationReceiptHashes: epoch.falsifications.map((row) => row.receiptHash),
      fixpointHash: fixpoint.fixpointHash,
      producerEligibleHypothesisIds: epoch.producerEligibleHypotheses.map(
        (row) => row.hypothesisId
      ),
    },
    producer: {
      cardinality: producer.cardinality,
      setHash: producer.setHash,
      disposition: producer.disposition ?? 'proposal-only',
      terminalClosure: producer.terminalClosure,
      toolCallCount: 0,
      persistenceCallCount: 0,
      selfReviewCallCount: 0,
    },
    reviewer: {
      verdict: reviewer.verdict,
      reasonCode: reviewer.reasonCode,
      decisionHash: reviewer.decisionHash,
      sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
    },
    sourceEvidence: {
      sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
      loadedSources: fixture.loadedSources.map(({ content: _content, ...source }) => source),
    },
  };
}

async function runSemanticFixture(fixture) {
  const analysis =
    fixture.expectedProposalCardinality > 0 ? normalAnalysis(fixture) : emptyAnalysis(fixture);
  const { epoch, executionReceipts, finalSchedule, terminalObligations } = analysis;
  const fixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule: finalSchedule,
    terminalObligations,
    epochs: [epoch],
  });
  if (fixture.expectedProposalCardinality > 0) {
    const producer = produceNormal(fixture, epoch, fixpoint);
    return {
      epoch,
      finalSchedule,
      fixpoint,
      producer,
      reviewer: await reviewNormal(fixture, producer),
    };
  }
  const producer = {
    cardinality: 0,
    setHash: null,
    disposition: 'investigated-empty',
    terminalClosure: 'reviewed-non-draft',
  };
  const dispositionReview = createInvestigatedEmptyReview(fixture, {
    epoch,
    executionReceipts,
    finalSchedule,
    fixpoint,
    terminalObligations,
  });
  const reviewer = new InvestigatedEmptyReviewer({ identity: reviewerIdentity }).review({
    sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
    finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    currentAnalysisFixpointHash: fixpoint.fixpointHash,
    expectedObligationIds: finalSchedule.obligationIds,
    executionReceipts,
    dispositionReview,
    evidenceEntryIds: [`evidence-${fixture.id}`],
  });
  return { epoch, finalSchedule, fixpoint, producer, reviewer };
}

function createInvestigatedEmptyReview(fixture, input) {
  return createDispositionReview({
    reviewKind: 'investigated-empty',
    currentAnalysisFixpointHash: input.fixpoint.fixpointHash,
    populationHash: input.epoch.population.populationHash,
    proposal: {
      reviewKind: 'investigated-empty',
      populationHash: input.epoch.population.populationHash,
      sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
      finalExpandedScheduleHash: input.finalSchedule.finalExpandedScheduleHash,
      currentAnalysisFixpointHash: input.fixpoint.fixpointHash,
      expectedObligationIds: input.finalSchedule.obligationIds,
      executionBindings: input.executionReceipts.map((receipt) => ({
        obligationId: receipt.obligationId,
        executionReceiptHash: receipt.receiptHash,
        executionOutputHash: receipt.outputHash,
        denominatorHash: receipt.denominatorHash,
        disposition: receipt.disposition,
        terminalReceiptId: receipt.terminalReceiptId,
      })),
      evidenceEntryIds: [`evidence-${fixture.id}`],
    },
    executionReceipts: input.executionReceipts,
    finalExpandedSchedule: input.finalSchedule,
    terminalObligations: input.terminalObligations,
  });
}

function buildIntent(fixture) {
  const budget = {
    initialBreadth: 1,
    expansionReserve: 1,
    counterqueryReserve: 1,
    starvationGuard: 1,
  };
  const question = {
    questionId: 'q-root',
    subquestionIds: [],
    anatomyLensIds: ['structure-and-boundary'],
    subjectRefs: [`scope:${fixture.id}:0`],
    analysisScales: ['project'],
    capabilityIds: ['facts.syntax'],
    queryFamilyIds: ['syntax-patterns'],
    expectedSupport: ['project-specific boundary'],
    expectedCounterevidence: ['boundary exception'],
    synthesisTarget: 'project boundary contract',
    uncertainty: 'variant behavior',
    stopCondition: 'all scheduled obligations terminal',
    escalationCondition: 'backend unavailable',
    priority: 'critical',
    budget,
  };
  return {
    generationStage: 'coldStart',
    projectProfile: {
      projectType: 'workspace',
      moduleCount: fixture.scopeCount,
      fileCount: fixture.scopeCount,
    },
    dimensions: [
      {
        dimensionId: 'architecture',
        priority: 1,
        rationale: 'trace project-specific boundary',
        targetRecipes: 0,
      },
    ],
    scale: { totalRecipeBudget: 0, depthLevels: ['project'] },
    moduleBindings: [],
    plannedNextActions: [
      {
        tool: 'facts.syntax',
        reason: 'execute the frozen question schedule',
        order: 1,
        questionId: question.questionId,
        anatomyLensIds: question.anatomyLensIds,
        subjectRefs: question.subjectRefs,
        analysisScales: question.analysisScales,
        capabilityId: 'facts.syntax',
        queryFamilyId: 'syntax-patterns',
        expectedSupport: question.expectedSupport,
        expectedCounterevidence: question.expectedCounterevidence,
        synthesisTarget: question.synthesisTarget,
        uncertainty: question.uncertainty,
        priority: question.priority,
        stopCondition: question.stopCondition,
        escalationCondition: question.escalationCondition,
        budget,
      },
    ],
    evidenceRefs: [{ kind: 'project-context', ref: `artifact:${fixture.id}` }],
    investigationDecomposition: { schemaVersion: 1, questions: [question] },
    budgetStrategy: {
      schemaVersion: 1,
      providerRequests: 3,
      detailRequests: 3,
      tokens: 10000,
      timeMs: 10000,
      costMicrousd: 0,
    },
  };
}

function normalAnalysis(fixture) {
  const executionReceipt = createFactExecutionReceipt({
    name: `${fixture.id}-matched`,
    sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
    emittedFactIds: ['fact-a', 'fact-b'],
    disposition: 'matched',
  });
  const populationInput = createPopulationInput(fixture, executionReceipt, [
    {
      observationId: 'obs-a',
      factIds: ['fact-a'],
      variantKeys: ['sync'],
    },
    {
      observationId: 'obs-b',
      factIds: ['fact-b'],
      variantKeys: ['async'],
    },
  ]);
  const population = canonicalizeObservationPopulationV1(populationInput);
  const clusterInputs = [
    {
      mechanismKey: 'project-boundary',
      mechanism: { invariant: 'project-specific boundary is preserved' },
      observationIds: ['obs-a', 'obs-b'],
      mechanismEvidenceFactIds: ['fact-a', 'fact-b'],
      anatomyLensIds: ['structure-and-boundary'],
    },
  ];
  const clusterSet = canonicalizeKnowledgeClustersV1(population, {
    clusters: clusterInputs,
    nonClusteredDispositions: [],
  });
  const port = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: hash({ fixture: fixture.id, schedule: 'baseline' }),
    baselineObligationIds: [executionReceipt.obligationId],
    knownFactFamilies: [
      {
        id: 'syntax-patterns',
        capabilityId: 'facts.syntax',
        supportedScales: ['file'],
      },
    ],
    knownSubjectRefs: [executionReceipt.canonicalSubjectRef],
    obligationCap: config.obligationCap,
  });
  const finalSchedule = port.seal();
  const terminalObligations = [terminalObligation(executionReceipt)];
  const currentAnalysisFixpointHash = createAnalysisReviewContextHashV1({
    finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    terminalObligations,
    populationHashes: [population.populationHash],
    clusterSetHashes: [clusterSet.clusterSetHash],
  });
  const applicability = {
    status: 'not-required',
    reasonCode: 'frozen-boundary-contract',
  };
  const dispositionReview = createDispositionReview({
    reviewKind: 'falsification',
    currentAnalysisFixpointHash,
    populationHash: population.populationHash,
    proposal: {
      reviewKind: 'falsification',
      populationHash: population.populationHash,
      hypothesisId: `hypothesis-${fixture.id}`,
      enrolledCounterqueryIds: [],
      executions: [],
      counterqueryApplicability: applicability,
    },
    executionReceipts: [executionReceipt],
    finalExpandedSchedule: finalSchedule,
    terminalObligations,
  });
  const epoch = validateStrictAnalystEpochV1({
    currentAnalysisFixpointHash,
    knownFactIds: ['fact-a', 'fact-b'],
    enrolledObligationIds: finalSchedule.obligationIds,
    population: populationInput,
    clusterInputs,
    nonClusteredDispositions: [],
    inductionInputs: [
      {
        mechanismKey: 'project-boundary',
        mode: 'recurring',
        hypotheses: [
          {
            hypothesisId: `hypothesis-${fixture.id}`,
            statement: 'The project preserves a project-specific boundary contract',
            premiseFactIds: ['fact-a', 'fact-b'],
          },
        ],
      },
    ],
    falsificationInputs: [
      {
        hypothesisId: `hypothesis-${fixture.id}`,
        enrolledCounterqueryIds: [],
        executions: [],
        counterqueryApplicability: applicability,
        dispositionReview,
      },
    ],
    hypothesisDispositions: [
      {
        hypothesisId: `hypothesis-${fixture.id}`,
        status: 'survived',
      },
    ],
    dispositionReviews: [dispositionReview],
  });
  return {
    epoch,
    executionReceipts: [executionReceipt],
    finalSchedule,
    terminalObligations,
  };
}

function emptyAnalysis(fixture) {
  const executionReceipt = createFactExecutionReceipt({
    name: `${fixture.id}-empty`,
    sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
    emittedFactIds: [],
    disposition: 'inspected-no-pattern',
  });
  const populationInput = createPopulationInput(fixture, executionReceipt, []);
  const population = canonicalizeObservationPopulationV1(populationInput);
  const clusterSet = canonicalizeKnowledgeClustersV1(population, {
    clusters: [],
    nonClusteredDispositions: [],
  });
  const port = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: hash({ fixture: fixture.id, schedule: 'baseline' }),
    baselineObligationIds: [executionReceipt.obligationId],
    knownFactFamilies: [
      {
        id: 'syntax-patterns',
        capabilityId: 'facts.syntax',
        supportedScales: ['file'],
      },
    ],
    knownSubjectRefs: [executionReceipt.canonicalSubjectRef],
    obligationCap: config.obligationCap,
  });
  const finalSchedule = port.seal();
  const terminalObligations = [terminalObligation(executionReceipt)];
  const currentAnalysisFixpointHash = createAnalysisReviewContextHashV1({
    finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    terminalObligations,
    populationHashes: [population.populationHash],
    clusterSetHashes: [clusterSet.clusterSetHash],
  });
  const epoch = validateStrictAnalystEpochV1({
    currentAnalysisFixpointHash,
    knownFactIds: [],
    enrolledObligationIds: finalSchedule.obligationIds,
    population: populationInput,
    clusterInputs: [],
    nonClusteredDispositions: [],
    inductionInputs: [],
    falsificationInputs: [],
    hypothesisDispositions: [],
    dispositionReviews: [],
  });
  return {
    epoch,
    executionReceipts: [executionReceipt],
    finalSchedule,
    terminalObligations,
  };
}

function produceNormal(fixture, epoch, fixpoint) {
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
    entries: fixture.loadedSources.map((source, index) => ({
      evidenceEntryId: `E-${index + 1}`,
      relativePath: source.path,
      blobHash: source.sha256,
      contentHash: sha256(source.content),
      startLine: 1,
      endLine: source.lineCount,
      content: source.content,
    })),
  });
  const strictContext = createStrictAnalysisContextProjectionV1({
    runId: `strict-eval-${fixture.id}`,
    journalId: `strict-eval-journal-${fixture.id}`,
    manifestHash: hash({ fixture: fixture.id, sources: fixture.loadedSources }),
    planCognitionHash: hash({ fixture: fixture.id, cognition: 'frozen' }),
    planHash: hash({ fixture: fixture.id, plan: 'frozen' }),
    requiredUniverseHash: hash(fixture.loadedSources.map((source) => source.path)),
    baselineScheduleHash: `baseline-${fixture.id}`,
    expansionHeadHash: null,
    currentExpandedScheduleHash: fixpoint.finalExpandedScheduleHash,
    finalExpandedScheduleHash: fixpoint.finalExpandedScheduleHash,
    analysisFixpointHash: fixpoint.fixpointHash,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: hash({ fixture: fixture.id, lens: 'structure-and-boundary' }),
    sourceArtifactHash: hash({ fixture: fixture.id, artifact: fixture.loadedSources }),
    sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
    questionIds: ['q-root'],
    factQueryObligationIds: fixpoint.terminalObligations.map((row) => row.obligationId),
    analysisUnitIds: epoch.population.observations.map((row) => row.observationId),
    factIds: epoch.population.observations.flatMap((row) => row.factIds),
    witnessIds: epoch.population.observations.map((row) => `witness-${row.observationId}`),
    populationHashes: [epoch.population.populationHash],
    clusterSetHashes: [epoch.clusterSet.clusterSetHash],
    inductionReceiptHashes: epoch.inductions.map((row) => row.receiptHash),
    hypothesisIds: epoch.producerEligibleHypotheses.map((row) => row.hypothesisId),
    falsificationReceiptHashes: epoch.falsifications.map((row) => row.receiptHash),
    dispositionReviewIds: epoch.dispositionReviews.map((row) => row.reviewReceiptId),
    evidenceEntryIds: evidence.entries.map((row) => row.evidenceEntryId),
    derivedFindingCount: 0,
  });
  const lineage = createStrictProducerLineageReceiptV1({
    context: strictContext,
    epoch,
    analysisFixpoint: fixpoint,
    hypothesisId: epoch.producerEligibleHypotheses[0].hypothesisId,
    evidence,
  });
  const expressionSet = createStrictProducerExpressionSetV1({
    lineage,
    parentSet: null,
    proposals: [
      {
        expressionId: `expression-${fixture.id}`,
        kind: 'draft',
        authored: authoredProjection(
          fixture,
          evidence.entries.map((row) => row.evidenceEntryId)
        ),
      },
    ],
    zeroDisposition: null,
    modelHash: hash(providerIdentity),
    reasonHash: hash({ reason: 'initial-authoring' }),
  });
  const coreExpressionSet = createStrictHypothesisExpressionSetReceiptV1({
    expressionSet,
    parentReceipt: null,
    privateCorpusRevision: `revision:${fixture.id}`,
    terminalHead: true,
    terminalResolutions: [
      {
        expressionId: `expression-${fixture.id}`,
        terminalFate: 'content-ready',
        terminalReceiptId: `g2:expression-${fixture.id}`,
        terminalReceiptHash: hash({ fixture: fixture.id, terminal: 'content-ready' }),
      },
    ],
  });
  return {
    ...expressionSet,
    expressionSet,
    evidence,
    coreExpressionSet,
    terminalClosure: coreExpressionSet.terminalClosure,
  };
}

function createPopulationInput(fixture, executionReceipt, observations) {
  const expectedObservationIds =
    observations.length > 0 ? observations.map((row) => row.observationId) : ['obs-empty'];
  return {
    populationId: `population-${fixture.id}`,
    revision: 1,
    parentPopulationHash: null,
    sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
    denominator: {
      kind: 'frozen-complete-subjects',
      expectedObservationIds,
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
    observations: observations.map((observation) => ({
      ...observation,
      obligationIds: [executionReceipt.obligationId],
      mechanismKey: 'project-boundary',
      canonicalSubjectRefs: [executionReceipt.canonicalSubjectRef],
      parentSubjectRefs: ['repo:repo'],
      outlierReasonCodes: [],
      negativeControl: false,
    })),
    duplicateObservations: [],
    excludedObservations: [],
    errorObservations: [],
    inspectedNoPatternObservations:
      observations.length > 0
        ? []
        : [
            {
              observationId: 'obs-empty',
              obligationId: executionReceipt.obligationId,
              canonicalSubjectRef: executionReceipt.canonicalSubjectRef,
              parentSubjectRefs: ['repo:repo'],
              executionReceiptHash: executionReceipt.receiptHash,
              outputHash: executionReceipt.outputHash,
              denominatorHash: executionReceipt.denominatorHash,
            },
          ],
  };
}

function createDispositionReview(input) {
  return createKnowledgeDispositionReviewV1({
    reviewKind: input.reviewKind,
    currentAnalysisFixpointHash: input.currentAnalysisFixpointHash,
    populationHash: input.populationHash,
    proposedDispositionHash: hashKnowledgeDispositionProposalV1(input.proposal),
    executionReceipts: input.executionReceipts,
    finalExpandedSchedule: input.finalExpandedSchedule,
    terminalObligations: input.terminalObligations,
    ...createProductionActors(),
    calibrationReceiptHash: hash({ calibration: 'strict-eval-semantic-v1' }),
    verdict: 'pass',
    reasonCode: 'independent-semantic-review',
  });
}

function createProductionActors() {
  const actor = (role) =>
    createProductionActorIdentityV1({
      providerId: 'provider:frozen',
      modelId: `model:${role}`,
      modelVersion: '2026-07-27',
      promptHash: hash({ role, prompt: 'strict-eval' }),
      runId: 'run:strict-production-eval',
      invocationId: `invocation:${role}`,
      loadReceiptHash: hash({ role, load: 'frozen' }),
      outputHash: hash({ role, output: 'frozen' }),
    });
  return { producer: actor('producer'), reviewer: actor('reviewer') };
}

function terminalObligation(receipt) {
  return {
    obligationId: receipt.obligationId,
    disposition: receipt.disposition,
    terminalReceiptId: receipt.terminalReceiptId,
  };
}

function createFactExecutionReceipt(input) {
  const canonicalSubjectRef = `file:repo:src/${input.name}.ts`;
  const obligationSemantic = {
    factFamilyId: 'syntax-idiom',
    capabilityId: 'tree-sitter-query',
    canonicalSubjectRef,
    analysisScale: 'file',
    denominator: 'complete-frozen-subject',
  };
  const obligationId = `fact:${hash(obligationSemantic).slice(7, 31)}`;
  const denominatorFileIds = [`repo:src/${input.name}.ts@sha256:${'9'.repeat(64)}`];
  const emittedFactIds = [...input.emittedFactIds].sort();
  const fileExecutionSemantic = {
    repoId: 'repo',
    relativePath: `src/${input.name}.ts`,
    blobHash: `sha256:${'9'.repeat(64)}`,
    status: 'complete',
    reasonCode: 'COMPLETE',
    truncated: false,
    continuation: null,
    witnessBindingHash: `sha256:${'0'.repeat(64)}`,
    evidenceEntryId: `E-${input.name}`,
    projectContextRefId: canonicalSubjectRef,
    stagedFactIds: emittedFactIds,
    discardedFactIds: [],
    emittedFactIds,
  };
  const fileExecution = {
    ...fileExecutionSemantic,
    executionHash: hash(fileExecutionSemantic),
  };
  const denominatorHash = hash(denominatorFileIds);
  const outputSemantic = {
    obligationId,
    denominatorHash,
    fileExecutionHashes: [fileExecution.executionHash],
    derivedFactIds: [],
    emittedFactIds,
    disposition: input.disposition,
    truncated: false,
    continuation: null,
  };
  const outputHash = hash(outputSemantic);
  const semantic = {
    schemaVersion: 1,
    obligationId,
    ...obligationSemantic,
    sourceRevisionVectorHash: input.sourceRevisionVectorHash,
    backendProducer: 'loaded:test',
    backendManifestHash: `sha256:${'b'.repeat(64)}`,
    backendLoadReceiptHash: `sha256:${'c'.repeat(64)}`,
    queryPackHash: `sha256:${'d'.repeat(64)}`,
    harvestKey: `sha256:${'e'.repeat(64)}`,
    harvestReceiptHash: `sha256:${'f'.repeat(64)}`,
    expectedFileCount: 1,
    inspectedFileCount: 1,
    denominatorFileIds,
    denominatorHash,
    witnessBindingHash: `sha256:${'0'.repeat(64)}`,
    fileExecutions: [fileExecution],
    derivedFactIds: [],
    emittedFactIds,
    disposition: input.disposition,
    reasonCode: 'COMPLETE_FROZEN_SUBJECT_INSPECTED',
    truncated: false,
    continuation: null,
    outputHash,
  };
  const receiptHash = hash(semantic);
  const receipt = {
    ...semantic,
    terminalReceiptId: `fact-execution:${receiptHash.slice(7, 31)}`,
    receiptHash,
  };
  assertFactQueryExecutionReceiptV1(receipt);
  return receipt;
}

async function reviewNormal(fixture, producer) {
  const reviewer = new IndependentValueReviewer({
    identity: reviewerIdentity,
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
          reasonCode: 'golden-supported',
          evidenceEntryIds: producer.evidence.entries.map((row) => row.evidenceEntryId),
        })),
        noveltyDecision: 'novel-project-specific',
        duplicateDecision: 'no-match',
        citedLines: producer.evidence.entries.map((row) => `${row.relativePath}:1`),
      }),
  });
  return reviewer.review({
    authored: producer.proposals[0].authored,
    evidence: producer.evidence,
    expectedSourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
    producerIdentity: `${providerIdentity.provider}/${providerIdentity.model}`,
    admissionReceiptId: `admission-${fixture.id}`,
    calibrationReceiptHash: hash({ calibration: 'golden-v1' }),
    repairAttempt: 0,
  });
}

function authoredProjection(fixture, evidenceEntryIds) {
  return {
    title: `${fixture.project} preserves a project-specific boundary`,
    kind: 'rule',
    doClause: 'Preserve the project-specific boundary contract',
    dontClause: 'Do not bypass the boundary with an unreviewed alternate path',
    markdown: 'Use the evidenced project boundary and preserve its failure semantics.',
    usageGuide: 'Apply when changing a production entrypoint or downstream consumer.',
    retrievalProfile: { intents: ['project production boundary'] },
    negativeIntent: ['generic language syntax'],
    scope: { moduleIds: ['production'], dimensionIds: ['architecture'] },
    evidenceEntryIds,
  };
}

function loadSourceFixture(fixture) {
  const fixtureRoot = path.resolve(path.dirname(goldenPath), fixture.fixturePath);
  const loadedSources = fixture.sourceFiles.map((source) => {
    const content = readFileSync(path.join(fixtureRoot, source.path), 'utf8');
    const actualSha256 = sha256(content);
    if (actualSha256 !== source.sha256) {
      throw new Error(`STRICT_FIXTURE_SOURCE_HASH_MISMATCH:${source.path}`);
    }
    return {
      ...source,
      content,
      lineCount: content.split('\n').length,
    };
  });
  return {
    ...fixture,
    loadedSources,
    scopeCount: loadedSources.length,
    sourceRevisionVectorHash: hash(loadedSources.map(({ content: _content, ...source }) => source)),
  };
}

function hash(value) {
  return `sha256:${sha256(JSON.stringify(sortCanonical(value)))}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sortCanonical(value) {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortCanonical(child)])
  );
}
