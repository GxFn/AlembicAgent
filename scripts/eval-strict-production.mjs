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
const loadedCoreModulePath = fileURLToPath(
  import.meta.resolve('@alembic/core/host-agent-workflows')
);
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
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  validateStrictAnalystEpochV1,
} = await import(path.join(root, 'dist/agent/production/StrictProductionPipeline.js'));
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
      'createStrictProducerExpressionSetV1',
      'IndependentValueReviewer',
      'InvestigatedEmptyReviewer',
    ],
    coreModule: '@alembic/core/host-agent-workflows',
    coreContractConsumption: [
      'AnalysisScheduleExpansionReceiptV1',
      'ObservationPopulationV1',
      'KnowledgeClusterSetV1',
      'InductionReceiptV1',
      'FalsificationReceiptV1',
      'AnalysisFixpointReceiptV1',
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

  const port = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: `baseline-${fixture.id}`,
    baselineObligationIds: ['base-1'],
    knownFactFamilies: [
      {
        id: 'syntax-patterns',
        capabilityId: 'facts.syntax',
        supportedScales: ['file'],
      },
    ],
    knownSubjectRefs: ['file:a', 'file:b'],
    obligationCap: config.obligationCap,
  });
  if (fixture.expectedProposalCardinality > 0) {
    port.enroll({
      obligationId: 'counter-1',
      purpose: 'counterexample',
      factFamilyId: 'syntax-patterns',
      capabilityId: 'facts.syntax',
      canonicalSubjectRef: 'file:b',
      analysisScale: 'file',
      reasonCode: 'falsify-recurring-claim',
    });
    port.assertExecutionAllowed('counter-1');
  }

  const epoch =
    fixture.expectedProposalCardinality > 0
      ? normalEpoch(fixture, port)
      : emptyEpoch(fixture, port);
  const finalSchedule = port.seal();
  const fixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule: finalSchedule,
    terminalObligations: finalSchedule.obligationIds.map((obligationId) => ({
      obligationId,
      disposition:
        obligationId === 'base-1' && fixture.expectedProposalCardinality > 0
          ? 'matched'
          : 'inspected-no-pattern',
      terminalReceiptId: `terminal-${fixture.id}-${obligationId}`,
    })),
    epochs: [epoch],
  });

  const producer =
    fixture.expectedProposalCardinality > 0
      ? produceNormal(fixture, epoch, fixpoint)
      : {
          cardinality: 0,
          setHash: null,
          disposition: 'investigated-empty',
        };
  const reviewer =
    fixture.expectedProposalCardinality > 0
      ? await reviewNormal(fixture, producer)
      : new InvestigatedEmptyReviewer({ identity: reviewerIdentity }).review({
          sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
          finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
          expectedObligationIds: finalSchedule.obligationIds,
          terminalObligations: finalSchedule.obligationIds.map((obligationId) => ({
            obligationId,
            disposition: 'inspected-no-pattern',
            terminalReceiptId: `terminal-${fixture.id}-${obligationId}`,
          })),
          unresolvedHypothesisIds: [],
          suppressedExpressionIds: [],
          evidenceEntryIds: [`evidence-${fixture.id}`],
        });

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

function normalEpoch(fixture, port) {
  return validateStrictAnalystEpochV1({
    knownFactIds: ['fact-a', 'fact-b'],
    enrolledObligationIds: port.seal().obligationIds,
    population: {
      populationId: `population-${fixture.id}`,
      revision: 1,
      parentPopulationHash: null,
      sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
      denominator: {
        kind: 'frozen-complete-subjects',
        expectedObservationIds: ['obs-a', 'obs-b'],
      },
      observations: [
        {
          observationId: 'obs-a',
          factIds: ['fact-a'],
          mechanismKey: 'project-boundary',
          canonicalSubjectRefs: ['file:a'],
        },
        {
          observationId: 'obs-b',
          factIds: ['fact-b'],
          mechanismKey: 'project-boundary',
          canonicalSubjectRefs: ['file:b'],
        },
      ],
      duplicateObservations: [],
      excludedObservations: [],
      errorObservations: [],
    },
    clusterInputs: [
      {
        mechanismKey: 'project-boundary',
        observationIds: ['obs-a', 'obs-b'],
        anatomyLensIds: ['structure-and-boundary'],
      },
    ],
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
        enrolledCounterqueryIds: ['counter-1'],
        executions: [
          {
            counterqueryId: 'counter-1',
            backendStatus: 'complete',
            denominatorComplete: true,
            truncated: false,
            counterexampleFactIds: [],
          },
        ],
        counterqueryApplicability: {
          status: 'required',
          reasonCode: 'recurring-claim-counterexample',
          reviewerReceiptId: null,
        },
      },
    ],
    hypothesisDispositions: [
      {
        hypothesisId: `hypothesis-${fixture.id}`,
        status: 'survived',
        reviewerReceiptId: `hypothesis-review-${fixture.id}`,
      },
    ],
  });
}

function emptyEpoch(fixture, port) {
  return validateStrictAnalystEpochV1({
    knownFactIds: ['fact-empty'],
    enrolledObligationIds: port.seal().obligationIds,
    population: {
      populationId: `population-${fixture.id}`,
      revision: 1,
      parentPopulationHash: null,
      sourceRevisionVectorHash: fixture.sourceRevisionVectorHash,
      denominator: {
        kind: 'frozen-complete-subjects',
        expectedObservationIds: ['obs-empty'],
      },
      observations: [
        {
          observationId: 'obs-empty',
          factIds: ['fact-empty'],
          mechanismKey: 'isolated-observation',
          canonicalSubjectRefs: ['file:a'],
        },
      ],
      duplicateObservations: [],
      excludedObservations: [],
      errorObservations: [],
    },
    clusterInputs: [
      {
        mechanismKey: 'isolated-observation',
        observationIds: ['obs-empty'],
        anatomyLensIds: ['structure-and-boundary'],
      },
    ],
    nonClusteredDispositions: [],
    inductionInputs: [
      {
        mechanismKey: 'isolated-observation',
        mode: 'bounded-singleton',
        hypotheses: [],
        zeroHypothesisReason: 'insufficient-evidence',
        zeroHypothesisReviewReceiptId: `zero-review-${fixture.id}`,
      },
    ],
    falsificationInputs: [],
    hypothesisDispositions: [],
  });
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
    dispositionReviewIds: epoch.hypothesisDispositions.map((row) => row.reviewerReceiptId),
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
  return { ...expressionSet, expressionSet, evidence };
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
