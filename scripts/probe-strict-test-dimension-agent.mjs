#!/usr/bin/env node

process.env.ALEMBIC_LOG_LEVEL = 'silent';

const {
  buildFactQueryCatalogSnapshot,
  createStrictTestAutomaticSelectionReceiptV1,
  createStrictTestDimensionExecutionProjectionV1,
  validateStrictTestPreflightV1,
} = await import('@alembic/core/production');
const {
  buildAnatomyLensCatalogSnapshot,
  buildDimensionCatalogSnapshot,
  buildRequiredFactApplicabilityUniverseV1,
} = await import('@alembic/core/plans');
const { hashCanonicalJson } = await import('@alembic/core/project-context-foundation');
const {
  bindStrictTestDimensionProductionRuntimePortV1,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  createStrictTestDimensionAgentAuthorityV1,
  createStrictTestDimensionAgentExecutionReceiptV1,
} = await import('../dist/production.js');
const { AgentService } = await import('../dist/agent/service/AgentService.js');
const { PipelineStrategy } = await import('../dist/agent/strategies/PipelineStrategy.js');

const SOURCE_REVISION = `sha256:${'1'.repeat(64)}`;
const modules = ['module-a', 'module-b'].map((moduleId) => ({
  moduleId,
  scopeId: `repo:${moduleId}`,
  relativePath: `src/${moduleId}`,
  moduleClass: 'production-library',
  ownedProductionFileCount: 12,
  languages: ['typescript'],
  frameworks: [],
  roles: ['library'],
  entrypointRefs: [`ref:${moduleId}:index`],
  publicSurfaceRefs: [`ref:${moduleId}:exports`],
  crossRepoEdgeRefs: [],
  boundaryRefs: [`ref:${moduleId}:boundary`],
  ownership: {
    origin: 'project-context',
    confidence: 1,
    evidenceRefs: [`ref:${moduleId}`],
  },
}));
const factFamilies = [
  family('syntax-idiom', 'tree-sitter-query'),
  family('architecture-dependency', 'certified-project-context'),
  family('api-protocol', 'accepted-semantic-relations'),
  family('lifecycle-error-invariant', 'accepted-static-invariants'),
  family('config-build-test-migration', 'frozen-config-parsers'),
  family('history-fix-pattern', 'accepted-frozen-history'),
  family('synthesis-cross-cutting', 'accepted-observation-aggregation'),
];
const factQueryCatalog = buildFactQueryCatalogSnapshot(factFamilies);

const compiledPlan = createCompiledPlan();
const currentBindings = createBindings();
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
const cells = authority.selectedCellIds.map((cellId) => {
  const [moduleId, dimensionId] = cellId.split('::');
  return { cellId, moduleId, dimensionId };
});
const boundPort = bindStrictTestDimensionProductionRuntimePortV1({
  authority,
  runtimePort: strictRuntimePort(authority),
  eligibleCells: cells,
});

const validModelCalls = [];
const valid = await agentService(validModelCalls).run(agentInput(boundPort));

const forgedSemantic = { ...authority, demandKey: 'forged-demand' };
delete forgedSemantic.authorityHash;
const forgedAuthority = {
  ...forgedSemantic,
  authorityHash: hashCanonicalJson(forgedSemantic),
};
const invalidModelCalls = [];
const invalid = await agentService(invalidModelCalls).run(
  agentInput({
    ...strictRuntimePort(authority),
    strictTestAuthority: forgedAuthority,
    eligibleCells: cells,
  })
);

const factExecution = emptyFactExecution(authority);
const executionReceipt = createStrictTestDimensionAgentExecutionReceiptV1({
  authority,
  factExecution,
  analysis: null,
  cellDispositions: authority.selectedCellIds.map((cellId) => ({
    cellId,
    disposition: 'failed',
    expressionSetReceipts: [],
    semanticReviewAttestations: [],
    dispositionReviewAttestations: [],
    reasonCode: 'probe-controlled-failure',
    evidenceRefs: [`probe:${cellId}`],
  })),
  expectedTrustPolicies: [],
  completedAt: '2026-07-30T06:03:00.000Z',
});

const report = {
  schemaVersion: 1,
  probe: 'strict-test-dimension-agent-automatic-selection',
  selectedDimensionId: authority.selectedDimensionId,
  selectedCellIds: authority.selectedCellIds,
  selectedCellSetHash: authority.selectedCellSetHash,
  fullCatalogHash: authority.fullCatalogHash,
  fullCellUniverseHash: authority.fullCellUniverseHash,
  fullEligibleCellsHash: authority.fullEligibleCellsHash,
  fullExcludedCellsHash: authority.fullExcludedCellsHash,
  fullApplicabilityUniverseHash: authority.fullApplicabilityUniverseHash,
  fullFactQueryCatalogHash: authority.fullFactQueryCatalogHash,
  fullBaselineScheduleHash: authority.fullBaselineScheduleHash,
  dimensionStateCount: projection.dimensionStates.length,
  validRoute: {
    status: valid.status,
    modelCallCount: validModelCalls.length,
    analystScopeBound: validModelCalls[0]?.includes(authority.authorityHash) === true,
    producerScopeBound: validModelCalls[1]?.includes(authority.authorityHash) === true,
  },
  failClosedRoute: {
    status: invalid.status,
    modelCallCount: invalidModelCalls.length,
    errorCode: invalid.reply,
  },
  receipt: {
    attemptedCount: executionReceipt.attemptedCount,
    acceptedCount: executionReceipt.acceptedCount,
    rejectedCount: executionReceipt.rejectedCount,
    investigatedEmptyCount: executionReceipt.investigatedEmptyCount,
    failedCount: executionReceipt.failedCount,
    segmentStatus: executionReceipt.segmentStatus,
    productionFinalized: executionReceipt.productionFinalized,
    publicRouteChanged: executionReceipt.publicRouteChanged,
    receiptHash: executionReceipt.receiptHash,
  },
};

if (
  report.selectedDimensionId !== 'architecture' ||
  report.selectedCellIds.length !== 2 ||
  report.dimensionStateCount !== 26 ||
  report.validRoute.status !== 'success' ||
  report.validRoute.modelCallCount !== 2 ||
  !report.validRoute.analystScopeBound ||
  !report.validRoute.producerScopeBound ||
  report.failClosedRoute.status !== 'error' ||
  report.failClosedRoute.modelCallCount !== 0 ||
  report.receipt.segmentStatus !== 'failed' ||
  report.receipt.failedCount !== 2 ||
  report.receipt.productionFinalized ||
  report.receipt.publicRouteChanged
) {
  throw new Error('STRICT_TEST_DIMENSION_AGENT_PROBE_INVALID');
}

process.stdout.write(`${JSON.stringify(report)}\n`);

function strictRuntimePort(agentAuthority) {
  const expansionPort = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: agentAuthority.fullBaselineScheduleHash,
    baselineObligationIds: [],
    knownFactFamilies: [],
    knownSubjectRefs: [],
    obligationCap: 1,
  });
  const finalSchedule = expansionPort.seal();
  const context = createStrictAnalysisContextProjectionV1({
    runId: agentAuthority.runId,
    journalId: 'strict-test-probe-journal',
    manifestHash: 'strict-test-probe-manifest',
    planCognitionHash: agentAuthority.planCognitionHash,
    planHash: agentAuthority.compiledPlanHash,
    requiredUniverseHash: agentAuthority.fullApplicabilityUniverseHash,
    baselineScheduleHash: agentAuthority.fullBaselineScheduleHash,
    expansionHeadHash: null,
    currentExpandedScheduleHash: agentAuthority.fullBaselineScheduleHash,
    finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
    analysisFixpointHash: sha('probe-fixpoint'),
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: agentAuthority.compiledPlan.schedule.lensBindingsHash,
    sourceArtifactHash: agentAuthority.certifiedProjectFactsSourceArtifactHash,
    sourceRevisionVectorHash: agentAuthority.sourceRevisionVectorHash,
    questionIds: ['question:probe'],
    factQueryObligationIds: [],
    analysisUnitIds: ['analysis-unit:probe'],
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
    terminalObligationIds: [],
    outstandingObligationIds: [],
  });
  return {
    enabled: true,
    analysisLimits: { maxEpochs: 1, maxObligations: 1 },
    expansionPort,
    readAnalysisEpoch: () => epoch,
    buildProducerInput: () => ({
      analysisFixpointHash: context.analysisFixpointHash,
      producerEligibleHypothesisIds: [],
    }),
    validateAnalystResult: (_source, observedEpoch) =>
      createStrictAnalysisGateOutcomeV1({
        action: 'pass',
        reasonCode: 'strict-analysis-fixpoint-stable',
        observedEpochHash: observedEpoch.snapshotHash,
        artifact: { analysisFixpointHash: context.analysisFixpointHash },
      }),
    reviewProducerResult: () => ({
      action: 'pass',
      pass: true,
      artifact: { verdict: 'pass', decisionHash: sha('probe-review') },
    }),
  };
}

function agentService(modelCalls) {
  return new AgentService({
    runtimeBuilder: {
      build(profile) {
        const strategy = new PipelineStrategy({
          stages: profile.runtimeOverrides.strategy.stages,
        });
        return {
          id: 'strict-test-probe-runtime',
          execute: async (message, options) =>
            strategy.execute(
              {
                id: 'strict-test-probe-model',
                reactLoop: async (prompt) => {
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
            ),
        };
      },
    },
  });
}

function agentInput(strictProduction) {
  return {
    profile: { id: 'generate-dimension' },
    params: { needsCandidates: true },
    message: {
      role: 'internal',
      content: 'Run the automatically selected strict-test dimension.',
    },
    context: {
      source: 'system-workflow',
      strategyContext: { strictProduction },
    },
  };
}

function emptyFactExecution(agentAuthority) {
  const manifestSemantic = {
    schemaVersion: 1,
    sourceArtifactId: 'artifact:strict-test-probe',
    sourceRevisionVectorHash: agentAuthority.sourceRevisionVectorHash,
    factQueryCatalogHash: agentAuthority.fullFactQueryCatalogHash,
    factHarvestScheduleHash: agentAuthority.compiledPlan.schedule.factHarvestScheduleHash,
    backendRegistryHash: sha('probe-backend-registry'),
    obligationCount: 0,
    terminalReceiptIds: [],
    terminalReceiptHashes: [],
    terminalReceiptSetHash: hashCanonicalJson([]),
    harvestReceiptHashes: [],
    harvestCount: 0,
    denominatorHashes: [],
    witnessBindingSetHash: hashCanonicalJson([]),
    factIds: [],
    factCount: 0,
    unexecutableCatalogFamilyIds: [],
    unregisteredBackendFamilyIds: [],
    failedObligationIds: [],
    unknownObligationIds: [],
    verdict: 'passed',
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

function createCompiledPlan() {
  const catalog = buildDimensionCatalogSnapshot();
  const anatomy = buildAnatomyLensCatalogSnapshot();
  const requiredFactApplicability = buildRequiredFactApplicabilityUniverseV1(
    modules,
    anatomy,
    factQueryCatalog
  );
  const cells = modules.flatMap((module) =>
    catalog.dimensions.map((dimension) => ({
      cellId: `${module.moduleId}::${dimension.id}`,
      moduleId: module.moduleId,
      scopeId: module.scopeId,
      dimensionId: dimension.id,
      criticality: 'standard',
      status: 'eligible',
      evidenceRefs: [`ref:${module.moduleId}`],
      synthesisPrerequisiteCellIds: [],
    }))
  );
  const universe = {
    cells,
    universeCount: cells.length,
    eligibleCount: cells.length,
    excludedCount: 0,
    cellUniverseHash: hashCanonicalJson(cells),
    eligibleCellsHash: hashCanonicalJson(cells),
    excludedCellsHash: hashCanonicalJson([]),
  };
  const schedule = {
    schemaVersion: 1,
    factHarvestObligations: [],
    lensBindings: [],
    factHarvestScheduleHash: hashCanonicalJson([]),
    lensBindingsHash: hashCanonicalJson([]),
    baselineScheduleHash: hashCanonicalJson({
      factHarvestScheduleHash: hashCanonicalJson([]),
      lensBindingsHash: hashCanonicalJson([]),
    }),
  };
  const resourceCaps = {
    providerRequestCap: 100,
    detailRequestCap: 100,
    tokenCap: 1_000_000,
    timeMsCap: 300_000,
    costMicrousdCap: 2_000_000,
    factQueryObligationCap: 1_000,
  };
  const selection = {
    schemaVersion: 2,
    kind: 'cold-start-upper-cap',
    generationStage: 'coldStart',
    moduleIds: modules.map((module) => module.moduleId),
    dimensionIds: catalog.dimensions.map((dimension) => dimension.id),
    eligibleCellIds: cells.map((cell) => cell.cellId),
    excludedCellIds: [],
    candidateAttemptCap: 0,
    maxAuthoredCandidatesPerCellPass: 0,
    semanticRepairLimit: 2,
    batchBarrierVersion: 'candidate-batch-barrier-v1',
    policyVersion: 'coverage-plan-policy-v1',
    policyHash: sha('policy'),
    modulePlanningFactsHash: sha('module-facts'),
    sourceArtifactHash: sha('source-artifact'),
    strictConfigReceiptHash: sha('strict-config'),
    authoringPolicy: {
      policy: 'evidence-bounded-no-floor',
      candidateAttempts: 'upper-bound-only',
      authoredCandidates: 'zero-to-many',
      quantityFloor: null,
      semanticRepairLimit: 2,
      batchFailureMode: 'whole-batch',
    },
    deferredCells: [],
    resourceCaps,
  };
  const execution = {
    schemaVersion: 2,
    factsBindingHash: sha('facts-content'),
    sourceRevisionVectorHash: SOURCE_REVISION,
    planCognitionHash: sha('plan-cognition'),
    orderedDimensionIds: catalog.dimensions.map((dimension) => dimension.id),
    orderedCells: cells.map((cell) => cell.cellId),
    orderedInvestigationActions: [],
    anatomyApplicabilityHash: requiredFactApplicability.universeHash,
    lensBindingsHash: schedule.lensBindingsHash,
    factHarvestScheduleHash: schedule.factHarvestScheduleHash,
    factQueryCatalogHash: factQueryCatalog.catalogHash,
    moduleScope: modules.map((module) => module.moduleId),
    synthesisPrerequisites: {},
    resourceCaps,
  };
  const semantic = {
    schemaVersion: 2,
    compilerVersion: 'cold-start-plan-compiler-v2',
    catalog,
    anatomy,
    requiredFactApplicability,
    factQueryCatalog,
    universe,
    schedule,
    selection,
    execution,
  };
  return { ...semantic, canonicalPlanHash: hashCanonicalJson(semantic) };
}

function createBindings() {
  return {
    schemaVersion: 1,
    profile: 'strict-test-dimension',
    demandKey: 'recipe-coldstart-production-quality-2026-07-15',
    runId: 'strict-workflow:agent-automatic-selection-probe',
    projectRootIdentity: 'project-root:BiliDili',
    controlRootIdentity: 'control-root:AlembicWorkspace',
    sourceRootIdentity: 'source-root:BiliDili',
    canonicalProjectIdentityHash: sha('project-identity'),
    sourceRevisionVectorHash: SOURCE_REVISION,
    sourceInventoryHash: sha('source-inventory'),
    sourceFileCount: 24,
    moduleCount: modules.length,
    languageCount: 1,
    parserCount: 1,
    backendCount: 7,
    certifiedProjectFactsArtifactHash: sha('facts-artifact'),
    certifiedProjectFactsContentHash: sha('facts-content'),
    certifiedProjectFactsSourceArtifactHash: sha('source-artifact'),
    certifiedProjectFactsSourceVectorHash: SOURCE_REVISION,
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

function family(id, capabilityId) {
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

function sha(value) {
  return hashCanonicalJson(value);
}
