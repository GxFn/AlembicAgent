#!/usr/bin/env node

process.env.ALEMBIC_LOG_LEVEL = 'silent';

const {
  assertFactQueryExecutionReceiptV1,
  buildFactQueryCatalogSnapshot,
  createAnalysisFixpointReceiptV1,
  createFinalExpandedMiningScheduleReceiptV1,
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
  createStrictTestDimensionAgentCellAnalysisEvidenceV1,
  createStrictTestDimensionAgentCellStageEvidenceV1,
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

const executionReceipts = createSameRunExecutionReceipts();
const compiledPlan = createCompiledPlan(executionReceipts);
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
  runtimePort: strictSameRunRuntimePort(authority, executionReceipts),
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
const reorderedModelCalls = [];
const reordered = await agentService(reorderedModelCalls).run(
  agentInput(
    bindStrictTestDimensionProductionRuntimePortV1({
      authority,
      runtimePort: strictSameRunRuntimePort(authority, executionReceipts, (artifact) =>
        rehashReviewArtifact({
          ...artifact,
          cellDispositions: [...artifact.cellDispositions].reverse(),
        })
      ),
      eligibleCells: cells,
    })
  )
);
const executionReceipt = valid.strictTestExecutionReceipt;
const phases = valid.phases ?? {};
const analysisGate = phases.analyst_fixpoint_gate?.artifact?.resultArtifact;
const reviewGate = phases.independent_review_gate?.artifact;

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
    runId: valid.runId,
    modelCallCount: validModelCalls.length,
    analystScopeBound: validModelCalls[0]?.includes(authority.authorityHash) === true,
    producerScopeBound: validModelCalls[1]?.includes(authority.authorityHash) === true,
    receiptReturned: Boolean(executionReceipt),
  },
  failClosedRoute: {
    status: invalid.status,
    modelCallCount: invalidModelCalls.length,
    errorCode: invalid.reply,
  },
  cellConservationFailClosed: {
    status: reordered.status,
    modelCallCount: reorderedModelCalls.length,
    errorCode: reordered.reply,
    receiptReturned: Boolean(reordered.strictTestExecutionReceipt),
  },
  receipt: executionReceipt
    ? {
        runId: executionReceipt.runId,
        authorityHash: executionReceipt.authorityHash,
        selectedCellIds: executionReceipt.selectedCellIds,
        selectedCellSetHash: executionReceipt.selectedCellSetHash,
        attemptedCount: executionReceipt.attemptedCount,
        acceptedCount: executionReceipt.acceptedCount,
        rejectedCount: executionReceipt.rejectedCount,
        investigatedEmptyCount: executionReceipt.investigatedEmptyCount,
        failedCount: executionReceipt.failedCount,
        segmentStatus: executionReceipt.segmentStatus,
        productionFinalized: executionReceipt.productionFinalized,
        publicRouteChanged: executionReceipt.publicRouteChanged,
        receiptHash: executionReceipt.receiptHash,
        pipelineExecution: executionReceipt.pipelineExecution
          ? {
              pipelineExecutionHash: executionReceipt.pipelineExecution.pipelineExecutionHash,
              analystStageResultHash:
                executionReceipt.pipelineExecution.analysisStageEvidence.analystStageResultHash,
              analysisStageEvidenceHash:
                executionReceipt.pipelineExecution.analysisStageEvidence.analysisStageEvidenceHash,
              producerStageResultHash:
                executionReceipt.pipelineExecution.reviewStageEvidence.producerStageResultHash,
              reviewStageEvidenceHash:
                executionReceipt.pipelineExecution.reviewStageEvidence.reviewStageEvidenceHash,
              cellStageEvidence:
                executionReceipt.pipelineExecution.reviewStageEvidence.cellDispositions.map(
                  (row) => ({
                    cellId: row.cellId,
                    cellStageEvidenceHash: row.stageEvidence.cellStageEvidenceHash,
                  })
                ),
            }
          : null,
        actualStageHashesMatch:
          executionReceipt.pipelineExecution?.analysisStageEvidence.analystStageResultHash ===
            stageResultHash(phases.analyze) &&
          executionReceipt.pipelineExecution?.analysisStageEvidence.analysisStageEvidenceHash ===
            analysisGate?.analysisStageEvidenceHash &&
          executionReceipt.pipelineExecution?.reviewStageEvidence.producerStageResultHash ===
            stageResultHash(phases.produce) &&
          executionReceipt.pipelineExecution?.reviewStageEvidence.reviewStageEvidenceHash ===
            reviewGate?.reviewStageEvidenceHash,
      }
    : null,
};

if (
  report.selectedDimensionId !== 'architecture' ||
  report.selectedCellIds.length !== 2 ||
  report.dimensionStateCount !== 26 ||
  report.validRoute.status !== 'success' ||
  report.validRoute.runId !== authority.runId ||
  report.validRoute.modelCallCount !== 2 ||
  !report.validRoute.analystScopeBound ||
  !report.validRoute.producerScopeBound ||
  !report.validRoute.receiptReturned ||
  report.failClosedRoute.status !== 'error' ||
  report.failClosedRoute.modelCallCount !== 0 ||
  report.cellConservationFailClosed.status !== 'error' ||
  report.cellConservationFailClosed.modelCallCount !== 2 ||
  report.cellConservationFailClosed.receiptReturned ||
  report.receipt?.runId !== authority.runId ||
  report.receipt?.authorityHash !== authority.authorityHash ||
  report.receipt?.selectedCellSetHash !== authority.selectedCellSetHash ||
  report.receipt?.segmentStatus !== 'completed' ||
  report.receipt?.attemptedCount !== 2 ||
  report.receipt?.rejectedCount !== 2 ||
  !report.receipt.actualStageHashesMatch ||
  report.receipt.productionFinalized ||
  report.receipt.publicRouteChanged
) {
  throw new Error(`STRICT_TEST_DIMENSION_AGENT_PROBE_INVALID:${JSON.stringify(report)}`);
}

process.stdout.write(`${JSON.stringify(report)}\n`);

function strictRuntimePort(agentAuthority, executionReceipts = []) {
  const baselineObligationIds = agentAuthority.compiledPlan.schedule.factHarvestObligations.map(
    (row) => row.obligationId
  );
  const expansionPort = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: agentAuthority.fullBaselineScheduleHash,
    baselineObligationIds,
    knownFactFamilies: [],
    knownSubjectRefs: [],
    obligationCap: Math.max(1, baselineObligationIds.length),
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
    analysisFixpointHash:
      executionReceipts.length > 0
        ? analysisLineageFor(agentAuthority, executionReceipts).analysisFixpoint.fixpointHash
        : sha('probe-fixpoint'),
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: agentAuthority.compiledPlan.schedule.lensBindingsHash,
    sourceArtifactHash: agentAuthority.certifiedProjectFactsSourceArtifactHash,
    sourceRevisionVectorHash: agentAuthority.sourceRevisionVectorHash,
    questionIds: ['question:probe'],
    factQueryObligationIds: baselineObligationIds,
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
    terminalObligationIds: baselineObligationIds,
    outstandingObligationIds: [],
  });
  return {
    enabled: true,
    analysisLimits: {
      maxEpochs: 1,
      maxObligations: Math.max(1, baselineObligationIds.length),
    },
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

function strictSameRunRuntimePort(
  agentAuthority,
  executionReceipts,
  mutateReview = (value) => value
) {
  const base = strictRuntimePort(agentAuthority, executionReceipts);
  const factExecution = factExecutionFor(agentAuthority, executionReceipts);
  const analysis = analysisLineageFor(agentAuthority, executionReceipts);
  let analysisStageEvidence = null;
  return {
    ...base,
    buildProducerInput: () => ({
      analysisFixpointHash: analysis.analysisFixpoint.fixpointHash,
      producerEligibleHypothesisIds: [],
      analysisStageEvidenceHash: analysisStageEvidence?.analysisStageEvidenceHash ?? null,
    }),
    validateAnalystResult: (source, observedEpoch) => {
      analysisStageEvidence = createAnalysisStageEvidence(
        agentAuthority,
        source,
        factExecution,
        analysis,
        executionReceipts
      );
      return createStrictAnalysisGateOutcomeV1({
        action: 'pass',
        reasonCode: 'strict-analysis-fixpoint-stable',
        observedEpochHash: observedEpoch.snapshotHash,
        artifact: analysisStageEvidence,
      });
    },
    reviewProducerResult: (source) => {
      if (!analysisStageEvidence) {
        throw new Error('STRICT_TEST_DIMENSION_AGENT_PROBE_ANALYSIS_REQUIRED');
      }
      return {
        action: 'pass',
        pass: true,
        artifact: mutateReview(
          createReviewStageEvidence(
            agentAuthority,
            source,
            analysisStageEvidence,
            executionReceipts
          )
        ),
      };
    },
  };
}

function agentService(modelCalls) {
  return new AgentService({
    runtimeBuilder: {
      build(profile, options) {
        const strategy = new PipelineStrategy({
          stages: profile.runtimeOverrides.strategy.stages,
        });
        const runtimeId = options?.runId ?? 'strict-test-probe-runtime';
        return {
          id: runtimeId,
          execute: async (message, options) =>
            strategy.execute(
              {
                id: runtimeId,
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

function createSameRunExecutionReceipts() {
  return ['module-a', 'module-b']
    .map((moduleId) =>
      createExecutionReceipt({
        name: `strict-test-${moduleId}`,
        canonicalSubjectRef: `repo:${moduleId}`,
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

function createExecutionReceipt(input) {
  const canonicalSubjectRef = input.canonicalSubjectRef;
  const obligationSemantic = {
    factFamilyId: 'syntax-idiom',
    capabilityId: 'tree-sitter-query',
    canonicalSubjectRef,
    analysisScale: 'file',
    denominator: 'complete-frozen-subject',
  };
  const obligationId = `fact:${sha(obligationSemantic).slice(7, 31)}`;
  const denominatorFileIds = [`repo:${input.relativePath}@${input.blobHash}`];
  const fileExecutionSemantic = {
    repoId: 'repo',
    relativePath: input.relativePath,
    blobHash: input.blobHash,
    status: 'complete',
    reasonCode: 'COMPLETE',
    truncated: false,
    continuation: null,
    witnessBindingHash: input.witnessBindingHash,
    evidenceEntryId: input.evidenceEntryId,
    projectContextRefId: input.projectContextRefId,
    stagedFactIds: [],
    discardedFactIds: [],
    emittedFactIds: [],
  };
  const fileExecution = {
    ...fileExecutionSemantic,
    executionHash: sha(fileExecutionSemantic),
  };
  const outputSemantic = {
    obligationId,
    denominatorHash: sha(denominatorFileIds),
    fileExecutionHashes: [fileExecution.executionHash],
    derivedFactIds: [],
    emittedFactIds: [],
    disposition: 'inspected-no-pattern',
    truncated: false,
    continuation: null,
  };
  const semantic = {
    schemaVersion: 1,
    obligationId,
    ...obligationSemantic,
    sourceRevisionVectorHash: SOURCE_REVISION,
    backendProducer: 'loaded:tree-sitter-query:probe-v1',
    backendManifestHash: sha(`${input.name}:backend-manifest`),
    backendLoadReceiptHash: sha(`${input.name}:backend-load`),
    queryPackHash: sha(`${input.name}:query-pack`),
    harvestKey: input.harvestKey,
    harvestReceiptHash: input.harvestReceiptHash,
    expectedFileCount: 1,
    inspectedFileCount: 1,
    denominatorFileIds,
    denominatorHash: sha(denominatorFileIds),
    witnessBindingHash: sha([input.witnessBindingHash]),
    fileExecutions: [fileExecution],
    derivedFactIds: [],
    emittedFactIds: [],
    disposition: 'inspected-no-pattern',
    reasonCode: 'COMPLETE_FROZEN_SUBJECT_INSPECTED',
    truncated: false,
    continuation: null,
    outputHash: sha(outputSemantic),
  };
  const receiptHash = sha(semantic);
  const receipt = {
    ...semantic,
    terminalReceiptId: `fact-execution:${receiptHash.slice(7, 31)}`,
    receiptHash,
  };
  assertFactQueryExecutionReceiptV1(receipt);
  return receipt;
}

function factExecutionFor(agentAuthority, receipts) {
  const terminalReceiptIds = receipts.map((receipt) => receipt.terminalReceiptId);
  const terminalReceiptHashes = receipts.map((receipt) => receipt.receiptHash);
  const harvestReceiptHashes = uniqueSorted(receipts.map((receipt) => receipt.harvestReceiptHash));
  const denominatorHashes = uniqueSorted(receipts.map((receipt) => receipt.denominatorHash));
  const manifestSemantic = {
    schemaVersion: 1,
    sourceArtifactId: 'artifact:strict-test-same-run-probe',
    sourceRevisionVectorHash: agentAuthority.sourceRevisionVectorHash,
    factQueryCatalogHash: agentAuthority.fullFactQueryCatalogHash,
    factHarvestScheduleHash: agentAuthority.compiledPlan.schedule.factHarvestScheduleHash,
    backendRegistryHash: sha('probe-backend-registry'),
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
    receipts,
    manifest: {
      ...manifestSemantic,
      manifestHash: hashCanonicalJson(manifestSemantic),
    },
  };
}

function analysisLineageFor(agentAuthority, receipts) {
  const baselineObligationIds = agentAuthority.compiledPlan.schedule.factHarvestObligations.map(
    (row) => row.obligationId
  );
  const finalExpandedSchedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: agentAuthority.fullBaselineScheduleHash,
    baselineObligationIds,
    expansionReceipts: [],
  });
  return {
    baselineObligationIds,
    expansionReceipts: [],
    finalExpandedSchedule,
    finalFactSchedule: agentAuthority.compiledPlan.schedule,
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

function createAnalysisStageEvidence(agentAuthority, source, factExecution, analysis, receipts) {
  const cells = agentAuthority.selectedCellIds.map((cellId) => {
    const receipt = executionReceiptForCell(receipts, cellId);
    return createStrictTestDimensionAgentCellAnalysisEvidenceV1({
      cellId,
      factReceiptHashes: [receipt.receiptHash],
      analysis,
    });
  });
  const semantic = {
    kind: 'StrictTestDimensionAgentAnalysisStageEvidenceV1',
    schemaVersion: 1,
    runId: agentAuthority.runId,
    authorityHash: agentAuthority.authorityHash,
    selectedCellIds: agentAuthority.selectedCellIds,
    selectedCellSetHash: agentAuthority.selectedCellSetHash,
    analystStageResultHash: stageResultHash(source),
    factExecution,
    analysis,
    cells,
  };
  return { ...semantic, analysisStageEvidenceHash: sha(semantic) };
}

function createReviewStageEvidence(agentAuthority, source, analysisStageEvidence, receipts) {
  const producerStageResultHash = stageResultHash(source);
  const cellDispositions = agentAuthority.selectedCellIds.map((cellId, index) => {
    const analysisCell = analysisStageEvidence.cells[index];
    const disposition = {
      cellId,
      disposition: 'rejected',
      expressionSetReceipts: [],
      semanticReviewAttestations: [],
      dispositionReviewAttestations: [],
      reasonCode: 'independent-review-rejected',
      evidenceRefs: [`evidence:${cellId}`],
    };
    return {
      ...disposition,
      stageEvidence: createStrictTestDimensionAgentCellStageEvidenceV1({
        authority: agentAuthority,
        analysisCellEvidence: analysisCell,
        producerStageResultHash,
        disposition,
      }),
    };
  });
  const semantic = {
    kind: 'StrictTestDimensionAgentReviewStageEvidenceV1',
    schemaVersion: 1,
    runId: agentAuthority.runId,
    authorityHash: agentAuthority.authorityHash,
    selectedCellIds: agentAuthority.selectedCellIds,
    selectedCellSetHash: agentAuthority.selectedCellSetHash,
    analysisStageEvidenceHash: analysisStageEvidence.analysisStageEvidenceHash,
    producerStageResultHash,
    cellDispositions,
    expectedTrustPolicies: [],
    completedAt: '2026-07-30T06:04:00.000Z',
  };
  return { ...semantic, reviewStageEvidenceHash: sha(semantic) };
}

function rehashReviewArtifact(artifact) {
  const { reviewStageEvidenceHash: _reviewStageEvidenceHash, ...semantic } = artifact;
  return { ...semantic, reviewStageEvidenceHash: sha(semantic) };
}

function executionReceiptForCell(receipts, cellId) {
  const moduleId = cellId.split('::')[0];
  const receipt = receipts.find((candidate) =>
    candidate.fileExecutions.some((row) => row.relativePath.includes(`/${moduleId}/`))
  );
  if (!receipt) {
    throw new Error(`STRICT_TEST_DIMENSION_AGENT_PROBE_FACT_RECEIPT_REQUIRED:${cellId}`);
  }
  return receipt;
}

function stageResultHash(value) {
  const result = value && typeof value === 'object' ? value : {};
  const tokenUsage =
    result.tokenUsage && typeof result.tokenUsage === 'object' ? result.tokenUsage : {};
  return sha({
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

function createCompiledPlan(executionReceipts = []) {
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
  const factHarvestObligations = executionReceipts
    .map((receipt) => ({
      obligationId: receipt.obligationId,
      factFamilyId: receipt.factFamilyId,
      capabilityId: receipt.capabilityId,
      canonicalSubjectRef: receipt.canonicalSubjectRef,
      analysisScale: receipt.analysisScale,
      denominator: receipt.denominator,
      source: 'required-universe',
    }))
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  const schedule = {
    schemaVersion: 1,
    factHarvestObligations,
    lensBindings: [],
    factHarvestScheduleHash: hashCanonicalJson(factHarvestObligations),
    lensBindingsHash: hashCanonicalJson([]),
    baselineScheduleHash: hashCanonicalJson({
      factHarvestScheduleHash: hashCanonicalJson(factHarvestObligations),
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

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
