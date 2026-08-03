import type { CompiledColdStartPlanV2, MiningWorkScheduleV1 } from '@alembic/core/plans';
import {
  type AnalysisFixpointReceiptV1,
  type AnalysisScheduleExpansionReceiptV1,
  assertCodeFactGenerationManifestV1,
  assertMiningWorkScheduleV1,
  assertSemanticDispositionReviewDurableAttestationV5,
  assertStrictTestAutomaticSelectionReceiptV1,
  assertStrictTestDimensionExecutionProjectionV1,
  assertStrictTestPreflightCurrentV1,
  assertStrictTestResumeContextV1,
  consumeMainSemanticDispositionReviewDurableAttestationV5,
  createAnalysisFixpointReceiptV1,
  createFinalExpandedMiningScheduleReceiptV1,
  type FinalExpandedMiningScheduleReceiptV1,
  type HypothesisExpressionSetReceiptV1,
  hashStrictTestPreflightBindingsV1,
  type KnowledgeClusterSetV1,
  type SemanticDispositionReviewDurableAttestationV5,
  type SemanticDispositionReviewTrustPolicyV3,
  type StrictFactScheduleExecutionResultV1,
  type StrictTestAutomaticSelectionReceiptV1,
  type StrictTestDimensionExecutionProjectionV1,
  type StrictTestPreflightBindingsV1,
  type StrictTestPreflightReceiptV1,
  validateHypothesisExpressionSetReceiptV1,
  validateStrictTestPreflightV1,
} from '@alembic/core/production';
import {
  type CanonicalSha256,
  canonicalJsonStringify,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';

import { createStrictAnalysisEpochSnapshotV1 } from './StrictProductionPipeline.js';
import type { StrictProductionRuntimePortV1 } from './StrictProductionStages.js';

const AGENT_CONTRACT_VERSION = 'strict-test-dimension-agent-v1' as const;
const STRICT_TEST_PROFILE = 'strict-test-dimension' as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TERMINAL_DISPOSITIONS = new Set<StrictTestDimensionAgentTerminalDispositionV1>([
  'accepted',
  'rejected',
  'investigated-empty',
  'failed',
]);

const AUTHORITY_INPUT_KEYS = [
  'automaticSelection',
  'compiledPlan',
  'currentBindings',
  'preflight',
  'projection',
] as const;

const AUTHORITY_KEYS = [
  'schemaVersion',
  'contractVersion',
  'profile',
  'demandKey',
  'runId',
  'currentBindings',
  'preflight',
  'automaticSelection',
  'projection',
  'compiledPlan',
  'currentBindingsHash',
  'preflightHash',
  'bindingHash',
  'driftInvalidationHash',
  'automaticSelectionHash',
  'projectionHash',
  'compiledPlanHash',
  'planCognitionHash',
  'fullCatalogHash',
  'fullCatalogSourceArtifactHash',
  'fullCellUniverseHash',
  'fullEligibleCellsHash',
  'fullExcludedCellsHash',
  'fullApplicabilityUniverseHash',
  'fullFactQueryCatalogHash',
  'fullBaselineScheduleHash',
  'certifiedProjectFactsArtifactHash',
  'certifiedProjectFactsContentHash',
  'certifiedProjectFactsSourceArtifactHash',
  'certifiedProjectFactsSourceVectorHash',
  'certifiedProjectFactsConsumerReceiptHash',
  'sourceRevisionVectorHash',
  'sourceInventoryHash',
  'selectedDimensionId',
  'selectedCellIds',
  'selectedCellSetHash',
  'selectedAt',
  'projectedAt',
  'productionFinalized',
  'publicRouteChanged',
  'authorityHash',
] as const;

const BINDER_INPUT_KEYS = ['authority', 'eligibleCells', 'runtimePort'] as const;
const EXECUTION_RECEIPT_INPUT_KEYS = [
  'analysis',
  'authority',
  'cellDispositions',
  'completedAt',
  'expectedTrustPolicies',
  'factExecution',
] as const;
const ANALYSIS_LINEAGE_KEYS = [
  'analysisFixpoint',
  'baselineObligationIds',
  'clusterSets',
  'expansionReceipts',
  'finalFactSchedule',
  'finalExpandedSchedule',
] as const;
const CELL_DISPOSITION_INPUT_KEYS = [
  'cellId',
  'disposition',
  'dispositionReviewAttestations',
  'evidenceRefs',
  'expressionSetReceipts',
  'reasonCode',
  'semanticReviewAttestations',
] as const;
const BASE_RUNTIME_PORT_KEYS = [
  'analysisLimits',
  'buildProducerInput',
  'enabled',
  'expansionPort',
  'readAnalysisEpoch',
  'reviewProducerResult',
  'validateAnalystResult',
] as const;
const BOUND_RUNTIME_PORT_KEYS = [
  ...BASE_RUNTIME_PORT_KEYS,
  'eligibleCells',
  'strictTestAuthority',
] as const;

const EXECUTION_RECEIPT_KEYS = [
  'schemaVersion',
  'contractVersion',
  'profile',
  'demandKey',
  'runId',
  'authority',
  'authorityHash',
  'currentBindingsHash',
  'preflightHash',
  'bindingHash',
  'driftInvalidationHash',
  'automaticSelectionHash',
  'projectionHash',
  'compiledPlanHash',
  'planCognitionHash',
  'fullCatalogHash',
  'fullCatalogSourceArtifactHash',
  'fullCellUniverseHash',
  'fullEligibleCellsHash',
  'fullExcludedCellsHash',
  'fullApplicabilityUniverseHash',
  'fullFactQueryCatalogHash',
  'fullBaselineScheduleHash',
  'selectedDimensionId',
  'selectedCellIds',
  'selectedCellSetHash',
  'factExecution',
  'factExecutionManifestHash',
  'factHarvestScheduleHash',
  'analysis',
  'finalExpandedScheduleHash',
  'analysisFixpointHash',
  'producerExpressionSetReceiptHashes',
  'semanticReviewDurableAttestationHashes',
  'dispositionReviewDurableAttestationHashes',
  'semanticReviewTrustPolicyHashes',
  'cellDispositions',
  'attemptedCount',
  'acceptedCount',
  'rejectedCount',
  'investigatedEmptyCount',
  'failedCount',
  'segmentStatus',
  'productionFinalized',
  'publicRouteChanged',
  'completedAt',
  'receiptHash',
] as const;

export interface CreateStrictTestDimensionAgentAuthorityInputV1 {
  readonly currentBindings: StrictTestPreflightBindingsV1;
  readonly preflight: StrictTestPreflightReceiptV1;
  readonly automaticSelection: StrictTestAutomaticSelectionReceiptV1;
  readonly projection: StrictTestDimensionExecutionProjectionV1;
  readonly compiledPlan: CompiledColdStartPlanV2;
}

/**
 * Agent authority keeps the validated Core receipts beside their canonical hashes. The nested
 * receipts are deliberate: the stage boundary can re-run Core validators and reject a caller that
 * merely edits fields and recomputes a public hash.
 */
export interface StrictTestDimensionAgentAuthorityV1 {
  readonly schemaVersion: 1;
  readonly contractVersion: typeof AGENT_CONTRACT_VERSION;
  readonly profile: typeof STRICT_TEST_PROFILE;
  readonly demandKey: string;
  readonly runId: string;
  readonly currentBindings: StrictTestPreflightBindingsV1;
  readonly preflight: StrictTestPreflightReceiptV1;
  readonly automaticSelection: StrictTestAutomaticSelectionReceiptV1;
  readonly projection: StrictTestDimensionExecutionProjectionV1;
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly currentBindingsHash: CanonicalSha256;
  readonly preflightHash: CanonicalSha256;
  readonly bindingHash: CanonicalSha256;
  readonly driftInvalidationHash: CanonicalSha256;
  readonly automaticSelectionHash: CanonicalSha256;
  readonly projectionHash: CanonicalSha256;
  readonly compiledPlanHash: CanonicalSha256;
  readonly planCognitionHash: CanonicalSha256;
  readonly fullCatalogHash: CanonicalSha256;
  readonly fullCatalogSourceArtifactHash: CanonicalSha256;
  readonly fullCellUniverseHash: CanonicalSha256;
  readonly fullEligibleCellsHash: CanonicalSha256;
  readonly fullExcludedCellsHash: CanonicalSha256;
  readonly fullApplicabilityUniverseHash: CanonicalSha256;
  readonly fullFactQueryCatalogHash: CanonicalSha256;
  readonly fullBaselineScheduleHash: CanonicalSha256;
  readonly certifiedProjectFactsArtifactHash: CanonicalSha256;
  readonly certifiedProjectFactsContentHash: CanonicalSha256;
  readonly certifiedProjectFactsSourceArtifactHash: CanonicalSha256;
  readonly certifiedProjectFactsSourceVectorHash: CanonicalSha256;
  readonly certifiedProjectFactsConsumerReceiptHash: CanonicalSha256;
  readonly sourceRevisionVectorHash: CanonicalSha256;
  readonly sourceInventoryHash: CanonicalSha256;
  readonly selectedDimensionId: string;
  readonly selectedCellIds: readonly string[];
  readonly selectedCellSetHash: CanonicalSha256;
  readonly selectedAt: string;
  readonly projectedAt: string;
  readonly productionFinalized: false;
  readonly publicRouteChanged: false;
  readonly authorityHash: CanonicalSha256;
}

export interface StrictTestDimensionEligibleCellV1 {
  readonly cellId: string;
  readonly moduleId: string;
  readonly dimensionId: string;
}

export interface StrictTestDimensionProductionRuntimePortV1 extends StrictProductionRuntimePortV1 {
  readonly strictTestAuthority: StrictTestDimensionAgentAuthorityV1;
  readonly eligibleCells: readonly StrictTestDimensionEligibleCellV1[];
}

export type StrictTestDimensionAgentTerminalDispositionV1 =
  | 'accepted'
  | 'rejected'
  | 'investigated-empty'
  | 'failed';

export interface StrictTestDimensionAgentCellDispositionInputV1 {
  readonly cellId: string;
  readonly disposition: StrictTestDimensionAgentTerminalDispositionV1;
  readonly expressionSetReceipts: readonly HypothesisExpressionSetReceiptV1[];
  readonly semanticReviewAttestations: readonly SemanticDispositionReviewDurableAttestationV5[];
  readonly dispositionReviewAttestations: readonly SemanticDispositionReviewDurableAttestationV5[];
  readonly reasonCode: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface StrictTestDimensionAgentCellDispositionV1
  extends StrictTestDimensionAgentCellDispositionInputV1 {
  readonly expressionSetReceiptHashes: readonly string[];
  readonly semanticReviewDurableAttestationHashes: readonly string[];
  readonly dispositionReviewDurableAttestationHashes: readonly string[];
  readonly cellDispositionHash: CanonicalSha256;
}

export interface StrictTestDimensionAgentAnalysisLineageV1 {
  readonly baselineObligationIds: readonly string[];
  readonly expansionReceipts: readonly AnalysisScheduleExpansionReceiptV1[];
  readonly finalExpandedSchedule: FinalExpandedMiningScheduleReceiptV1;
  readonly finalFactSchedule: MiningWorkScheduleV1;
  readonly analysisFixpoint: AnalysisFixpointReceiptV1;
  readonly clusterSets: readonly KnowledgeClusterSetV1[];
}

export interface CreateStrictTestDimensionAgentExecutionReceiptInputV1 {
  readonly authority: StrictTestDimensionAgentAuthorityV1;
  readonly factExecution: StrictFactScheduleExecutionResultV1;
  readonly analysis: StrictTestDimensionAgentAnalysisLineageV1 | null;
  readonly cellDispositions: readonly StrictTestDimensionAgentCellDispositionInputV1[];
  readonly expectedTrustPolicies: readonly SemanticDispositionReviewTrustPolicyV3[];
  readonly completedAt: string;
}

export interface StrictTestDimensionAgentExecutionReceiptV1 {
  readonly schemaVersion: 1;
  readonly contractVersion: typeof AGENT_CONTRACT_VERSION;
  readonly profile: typeof STRICT_TEST_PROFILE;
  readonly demandKey: string;
  readonly runId: string;
  readonly authority: StrictTestDimensionAgentAuthorityV1;
  readonly authorityHash: CanonicalSha256;
  readonly currentBindingsHash: CanonicalSha256;
  readonly preflightHash: CanonicalSha256;
  readonly bindingHash: CanonicalSha256;
  readonly driftInvalidationHash: CanonicalSha256;
  readonly automaticSelectionHash: CanonicalSha256;
  readonly projectionHash: CanonicalSha256;
  readonly compiledPlanHash: CanonicalSha256;
  readonly planCognitionHash: CanonicalSha256;
  readonly fullCatalogHash: CanonicalSha256;
  readonly fullCatalogSourceArtifactHash: CanonicalSha256;
  readonly fullCellUniverseHash: CanonicalSha256;
  readonly fullEligibleCellsHash: CanonicalSha256;
  readonly fullExcludedCellsHash: CanonicalSha256;
  readonly fullApplicabilityUniverseHash: CanonicalSha256;
  readonly fullFactQueryCatalogHash: CanonicalSha256;
  readonly fullBaselineScheduleHash: CanonicalSha256;
  readonly selectedDimensionId: string;
  readonly selectedCellIds: readonly string[];
  readonly selectedCellSetHash: CanonicalSha256;
  readonly factExecution: StrictFactScheduleExecutionResultV1;
  readonly factExecutionManifestHash: CanonicalSha256;
  readonly factHarvestScheduleHash: CanonicalSha256;
  readonly analysis: StrictTestDimensionAgentAnalysisLineageV1 | null;
  readonly finalExpandedScheduleHash: CanonicalSha256 | null;
  readonly analysisFixpointHash: CanonicalSha256 | null;
  readonly producerExpressionSetReceiptHashes: readonly string[];
  readonly semanticReviewDurableAttestationHashes: readonly string[];
  readonly dispositionReviewDurableAttestationHashes: readonly string[];
  readonly semanticReviewTrustPolicyHashes: readonly string[];
  readonly cellDispositions: readonly StrictTestDimensionAgentCellDispositionV1[];
  readonly attemptedCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly investigatedEmptyCount: number;
  readonly failedCount: number;
  readonly segmentStatus: 'completed' | 'partial' | 'failed';
  readonly productionFinalized: false;
  readonly publicRouteChanged: false;
  readonly completedAt: string;
  readonly receiptHash: CanonicalSha256;
}

export function createStrictTestDimensionAgentAuthorityV1(
  input: CreateStrictTestDimensionAgentAuthorityInputV1
): StrictTestDimensionAgentAuthorityV1 {
  assertExactKeys(
    input,
    AUTHORITY_INPUT_KEYS,
    'STRICT_TEST_DIMENSION_AGENT_AUTHORITY_INPUT_INVALID'
  );
  validateCoreAuthorityChain(input);
  const selectedCellIds = selectedEligibleCellIds(input);
  const semantic = {
    schemaVersion: 1 as const,
    contractVersion: AGENT_CONTRACT_VERSION,
    profile: STRICT_TEST_PROFILE,
    demandKey: input.preflight.demandKey,
    runId: input.preflight.runId,
    currentBindings: input.currentBindings,
    preflight: input.preflight,
    automaticSelection: input.automaticSelection,
    projection: input.projection,
    compiledPlan: input.compiledPlan,
    currentBindingsHash: hashStrictTestPreflightBindingsV1(input.currentBindings),
    preflightHash: input.preflight.preflightHash,
    bindingHash: input.preflight.bindingHash,
    driftInvalidationHash: input.preflight.driftInvalidationHash,
    automaticSelectionHash: input.automaticSelection.automaticSelectionHash,
    projectionHash: input.projection.projectionHash,
    compiledPlanHash: input.compiledPlan.canonicalPlanHash,
    planCognitionHash: input.compiledPlan.execution.planCognitionHash,
    fullCatalogHash: input.projection.fullCatalogHash,
    fullCatalogSourceArtifactHash: input.projection.fullCatalogSourceArtifactHash,
    fullCellUniverseHash: input.projection.fullCellUniverseHash,
    fullEligibleCellsHash: input.projection.fullEligibleCellsHash,
    fullExcludedCellsHash: input.projection.fullExcludedCellsHash,
    fullApplicabilityUniverseHash: input.projection.fullApplicabilityUniverseHash,
    fullFactQueryCatalogHash: input.projection.fullFactQueryCatalogHash,
    fullBaselineScheduleHash: input.projection.fullBaselineScheduleHash,
    certifiedProjectFactsArtifactHash: input.preflight.certifiedProjectFactsArtifactHash,
    certifiedProjectFactsContentHash: input.preflight.certifiedProjectFactsContentHash,
    certifiedProjectFactsSourceArtifactHash:
      input.preflight.certifiedProjectFactsSourceArtifactHash,
    certifiedProjectFactsSourceVectorHash: input.preflight.certifiedProjectFactsSourceVectorHash,
    certifiedProjectFactsConsumerReceiptHash:
      input.preflight.certifiedProjectFactsConsumerReceiptHash,
    sourceRevisionVectorHash: input.projection.sourceRevisionVectorHash,
    sourceInventoryHash: input.projection.sourceInventoryHash,
    selectedDimensionId: input.projection.selectedDimensionId,
    selectedCellIds,
    selectedCellSetHash: hashCanonicalJson(selectedCellIds),
    selectedAt: input.automaticSelection.selectedAt,
    projectedAt: input.projection.projectedAt,
    productionFinalized: false as const,
    publicRouteChanged: false as const,
  };
  return freezeDeep({ ...semantic, authorityHash: hashCanonicalJson(semantic) });
}

export function assertStrictTestDimensionAgentAuthorityV1(
  authority: StrictTestDimensionAgentAuthorityV1
): void {
  assertExactKeys(
    authority,
    AUTHORITY_KEYS,
    'STRICT_TEST_DIMENSION_AGENT_AUTHORITY_FIELDS_INVALID'
  );
  if (
    authority.schemaVersion !== 1 ||
    authority.contractVersion !== AGENT_CONTRACT_VERSION ||
    authority.profile !== STRICT_TEST_PROFILE ||
    authority.productionFinalized !== false ||
    authority.publicRouteChanged !== false
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_AUTHORITY_VERSION_INVALID');
  }
  requireText(authority.demandKey, 'STRICT_TEST_DIMENSION_AGENT_AUTHORITY_IDENTITY_INVALID');
  requireText(authority.runId, 'STRICT_TEST_DIMENSION_AGENT_AUTHORITY_IDENTITY_INVALID');
  requireTimestamp(authority.selectedAt, 'STRICT_TEST_DIMENSION_AGENT_AUTHORITY_TIME_INVALID');
  requireTimestamp(authority.projectedAt, 'STRICT_TEST_DIMENSION_AGENT_AUTHORITY_TIME_INVALID');
  if (Date.parse(authority.projectedAt) < Date.parse(authority.selectedAt)) {
    fail('STRICT_TEST_DIMENSION_AGENT_AUTHORITY_TIME_INVALID');
  }
  for (const hash of authorityHashes(authority)) {
    requireSha256(hash, 'STRICT_TEST_DIMENSION_AGENT_AUTHORITY_HASH_INVALID');
  }
  const recreated = createStrictTestDimensionAgentAuthorityV1({
    currentBindings: authority.currentBindings,
    preflight: authority.preflight,
    automaticSelection: authority.automaticSelection,
    projection: authority.projection,
    compiledPlan: authority.compiledPlan,
  });
  if (canonicalJsonStringify(recreated) !== canonicalJsonStringify(authority)) {
    fail('STRICT_TEST_DIMENSION_AGENT_AUTHORITY_LINEAGE_MISMATCH');
  }
}

export function bindStrictTestDimensionProductionRuntimePortV1(input: {
  readonly authority: StrictTestDimensionAgentAuthorityV1;
  readonly runtimePort: StrictProductionRuntimePortV1;
  readonly eligibleCells: readonly StrictTestDimensionEligibleCellV1[];
}): StrictTestDimensionProductionRuntimePortV1 {
  assertExactKeys(input, BINDER_INPUT_KEYS, 'STRICT_TEST_DIMENSION_RUNTIME_BINDING_INPUT_INVALID');
  assertStrictTestDimensionAgentAuthorityV1(input.authority);
  assertBaseRuntimePort(input.runtimePort);
  const existing = input.runtimePort as StrictProductionRuntimePortV1 & {
    readonly strictTestAuthority?: unknown;
    readonly eligibleCells?: unknown;
  };
  if (Object.hasOwn(existing, 'strictTestAuthority') || Object.hasOwn(existing, 'eligibleCells')) {
    fail('STRICT_TEST_DIMENSION_RUNTIME_REBIND_FORBIDDEN');
  }
  assertExactKeys(
    input.runtimePort,
    BASE_RUNTIME_PORT_KEYS,
    'STRICT_TEST_DIMENSION_RUNTIME_BASE_PORT_FIELDS_INVALID'
  );
  assertRuntimeAuthorityLineage(input.authority, input.runtimePort);
  const eligibleCells = normalizeRuntimeCells(input.authority, input.eligibleCells);
  return Object.freeze({
    ...input.runtimePort,
    strictTestAuthority: input.authority,
    eligibleCells,
  });
}

export function assertStrictTestDimensionProductionRuntimePortBindingV1(
  port: StrictTestDimensionProductionRuntimePortV1
): void {
  assertExactKeys(
    port,
    BOUND_RUNTIME_PORT_KEYS,
    'STRICT_TEST_DIMENSION_RUNTIME_BOUND_PORT_FIELDS_INVALID'
  );
  assertBaseRuntimePort(port);
  assertStrictTestDimensionAgentAuthorityV1(port.strictTestAuthority);
  assertRuntimeAuthorityLineage(port.strictTestAuthority, port);
  normalizeRuntimeCells(port.strictTestAuthority, port.eligibleCells);
}

export function createStrictTestDimensionAgentExecutionReceiptV1(
  input: CreateStrictTestDimensionAgentExecutionReceiptInputV1
): StrictTestDimensionAgentExecutionReceiptV1 {
  assertExactKeys(
    input,
    EXECUTION_RECEIPT_INPUT_KEYS,
    'STRICT_TEST_DIMENSION_AGENT_EXECUTION_INPUT_INVALID'
  );
  assertStrictTestDimensionAgentAuthorityV1(input.authority);
  requireTimestamp(input.completedAt, 'STRICT_TEST_DIMENSION_AGENT_EXECUTION_TIME_INVALID');
  if (Date.parse(input.completedAt) < Date.parse(input.authority.projectedAt)) {
    fail('STRICT_TEST_DIMENSION_AGENT_EXECUTION_TIME_INVALID');
  }
  validateFactExecutionLineage(input.authority, input.factExecution);
  const analysis = validateAnalysisLineage(input.authority, input.factExecution, input.analysis);
  const cellDispositions = normalizeCellDispositions(
    input.authority,
    input.factExecution,
    analysis,
    input.expectedTrustPolicies,
    input.cellDispositions
  );
  const counts = countCellDispositions(cellDispositions);
  const segmentStatus =
    counts.failedCount === 0
      ? ('completed' as const)
      : counts.failedCount === cellDispositions.length
        ? ('failed' as const)
        : ('partial' as const);
  if (
    segmentStatus === 'completed' &&
    (input.factExecution.manifest.verdict !== 'passed' || analysis === null)
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_COMPLETED_STAGE_RECEIPTS_REQUIRED');
  }
  const semantic = {
    schemaVersion: 1 as const,
    contractVersion: AGENT_CONTRACT_VERSION,
    profile: STRICT_TEST_PROFILE,
    demandKey: input.authority.demandKey,
    runId: input.authority.runId,
    authority: input.authority,
    authorityHash: input.authority.authorityHash,
    currentBindingsHash: input.authority.currentBindingsHash,
    preflightHash: input.authority.preflightHash,
    bindingHash: input.authority.bindingHash,
    driftInvalidationHash: input.authority.driftInvalidationHash,
    automaticSelectionHash: input.authority.automaticSelectionHash,
    projectionHash: input.authority.projectionHash,
    compiledPlanHash: input.authority.compiledPlanHash,
    planCognitionHash: input.authority.planCognitionHash,
    fullCatalogHash: input.authority.fullCatalogHash,
    fullCatalogSourceArtifactHash: input.authority.fullCatalogSourceArtifactHash,
    fullCellUniverseHash: input.authority.fullCellUniverseHash,
    fullEligibleCellsHash: input.authority.fullEligibleCellsHash,
    fullExcludedCellsHash: input.authority.fullExcludedCellsHash,
    fullApplicabilityUniverseHash: input.authority.fullApplicabilityUniverseHash,
    fullFactQueryCatalogHash: input.authority.fullFactQueryCatalogHash,
    fullBaselineScheduleHash: input.authority.fullBaselineScheduleHash,
    selectedDimensionId: input.authority.selectedDimensionId,
    selectedCellIds: input.authority.selectedCellIds,
    selectedCellSetHash: input.authority.selectedCellSetHash,
    factExecution: input.factExecution,
    factExecutionManifestHash: input.factExecution.manifest.manifestHash as CanonicalSha256,
    factHarvestScheduleHash: input.factExecution.manifest
      .factHarvestScheduleHash as CanonicalSha256,
    analysis,
    finalExpandedScheduleHash:
      (analysis?.finalExpandedSchedule.finalExpandedScheduleHash as CanonicalSha256 | undefined) ??
      null,
    analysisFixpointHash:
      (analysis?.analysisFixpoint.fixpointHash as CanonicalSha256 | undefined) ?? null,
    producerExpressionSetReceiptHashes: uniqueSorted(
      cellDispositions.flatMap((row) => row.expressionSetReceiptHashes)
    ),
    semanticReviewDurableAttestationHashes: uniqueSorted(
      cellDispositions.flatMap((row) => row.semanticReviewDurableAttestationHashes)
    ),
    dispositionReviewDurableAttestationHashes: uniqueSorted(
      cellDispositions.flatMap((row) => row.dispositionReviewDurableAttestationHashes)
    ),
    semanticReviewTrustPolicyHashes: uniqueSorted(
      cellDispositions
        .flatMap((row) => [...row.semanticReviewAttestations, ...row.dispositionReviewAttestations])
        .map((attestation) => attestation.trustPolicyHash)
    ),
    cellDispositions,
    attemptedCount: cellDispositions.length,
    ...counts,
    segmentStatus,
    productionFinalized: false as const,
    publicRouteChanged: false as const,
    completedAt: input.completedAt,
  };
  return freezeDeep({ ...semantic, receiptHash: hashCanonicalJson(semantic) });
}

export function assertStrictTestDimensionAgentExecutionReceiptV1(
  receipt: StrictTestDimensionAgentExecutionReceiptV1,
  expectedTrustPolicies: readonly SemanticDispositionReviewTrustPolicyV3[]
): void {
  assertExactKeys(
    receipt,
    EXECUTION_RECEIPT_KEYS,
    'STRICT_TEST_DIMENSION_AGENT_EXECUTION_FIELDS_INVALID'
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.contractVersion !== AGENT_CONTRACT_VERSION ||
    receipt.profile !== STRICT_TEST_PROFILE ||
    receipt.productionFinalized !== false ||
    receipt.publicRouteChanged !== false
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_EXECUTION_VERSION_INVALID');
  }
  const recreated = createStrictTestDimensionAgentExecutionReceiptV1({
    authority: receipt.authority,
    factExecution: receipt.factExecution,
    analysis: receipt.analysis,
    expectedTrustPolicies,
    cellDispositions: receipt.cellDispositions.map((row) => ({
      cellId: row.cellId,
      disposition: row.disposition,
      expressionSetReceipts: row.expressionSetReceipts,
      semanticReviewAttestations: row.semanticReviewAttestations,
      dispositionReviewAttestations: row.dispositionReviewAttestations,
      reasonCode: row.reasonCode,
      evidenceRefs: row.evidenceRefs,
    })),
    completedAt: receipt.completedAt,
  });
  if (canonicalJsonStringify(recreated) !== canonicalJsonStringify(receipt)) {
    fail('STRICT_TEST_DIMENSION_AGENT_EXECUTION_LINEAGE_MISMATCH');
  }
}

function validateFactExecutionLineage(
  authority: StrictTestDimensionAgentAuthorityV1,
  factExecution: StrictFactScheduleExecutionResultV1
): void {
  assertCodeFactGenerationManifestV1(factExecution);
  const manifest = factExecution.manifest;
  const invalid =
    manifest.sourceRevisionVectorHash !== authority.sourceRevisionVectorHash ||
    manifest.factQueryCatalogHash !== authority.fullFactQueryCatalogHash ||
    factExecution.receipts.some(
      (receipt) => receipt.sourceRevisionVectorHash !== authority.sourceRevisionVectorHash
    );
  if (invalid) {
    fail('STRICT_TEST_DIMENSION_AGENT_FACT_EXECUTION_LINEAGE_MISMATCH');
  }
}

function validateAnalysisLineage(
  authority: StrictTestDimensionAgentAuthorityV1,
  factExecution: StrictFactScheduleExecutionResultV1,
  analysis: StrictTestDimensionAgentAnalysisLineageV1 | null
): StrictTestDimensionAgentAnalysisLineageV1 | null {
  if (analysis === null) {
    const baselineIds = authority.compiledPlan.schedule.factHarvestObligations.map(
      (row) => row.obligationId
    );
    const executedIds = factExecution.receipts.map((receipt) => receipt.obligationId);
    if (
      factExecution.manifest.factHarvestScheduleHash !==
        authority.compiledPlan.schedule.factHarvestScheduleHash ||
      !sameStringSet(baselineIds, executedIds)
    ) {
      fail('STRICT_TEST_DIMENSION_AGENT_SCHEDULE_LINEAGE_REQUIRED');
    }
    return null;
  }
  assertExactKeys(
    analysis,
    ANALYSIS_LINEAGE_KEYS,
    'STRICT_TEST_DIMENSION_AGENT_ANALYSIS_FIELDS_INVALID'
  );
  assertMiningWorkScheduleV1(authority.compiledPlan.schedule);
  assertMiningWorkScheduleV1(analysis.finalFactSchedule);
  const baselineObligationIds = authority.compiledPlan.schedule.factHarvestObligations.map(
    (row) => row.obligationId
  );
  if (!sameOrderedStrings(analysis.baselineObligationIds, baselineObligationIds)) {
    fail('STRICT_TEST_DIMENSION_AGENT_ANALYSIS_BASELINE_MISMATCH');
  }
  const rebuiltFinalSchedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: authority.compiledPlan.schedule.baselineScheduleHash,
    baselineObligationIds,
    expansionReceipts: analysis.expansionReceipts,
  });
  if (
    canonicalJsonStringify(rebuiltFinalSchedule) !==
    canonicalJsonStringify(analysis.finalExpandedSchedule)
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_FINAL_SCHEDULE_INVALID');
  }
  assertFinalFactScheduleLineage(authority, factExecution, analysis);
  const rebuiltFixpoint = createAnalysisFixpointReceiptV1({
    finalExpandedSchedule: analysis.finalExpandedSchedule,
    terminalObligations: analysis.analysisFixpoint.terminalObligations,
    populationHashes: analysis.analysisFixpoint.populationHashes,
    clusterSets: analysis.clusterSets,
    inductionReceiptHashes: analysis.analysisFixpoint.inductionReceiptHashes,
    falsificationReceiptHashes: analysis.analysisFixpoint.falsificationReceiptHashes,
  });
  if (
    canonicalJsonStringify(rebuiltFixpoint) !== canonicalJsonStringify(analysis.analysisFixpoint) ||
    !sameTerminalObligations(
      analysis.analysisFixpoint.terminalObligations,
      factExecution.receipts.map((receipt) => ({
        obligationId: receipt.obligationId,
        disposition: receipt.disposition,
        terminalReceiptId: receipt.terminalReceiptId,
      }))
    )
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_ANALYSIS_FIXPOINT_INVALID');
  }
  return freezeDeep({
    baselineObligationIds: [...analysis.baselineObligationIds],
    expansionReceipts: [...analysis.expansionReceipts],
    finalExpandedSchedule: analysis.finalExpandedSchedule,
    finalFactSchedule: analysis.finalFactSchedule,
    analysisFixpoint: analysis.analysisFixpoint,
    clusterSets: [...analysis.clusterSets],
  });
}

function assertFinalFactScheduleLineage(
  authority: StrictTestDimensionAgentAuthorityV1,
  factExecution: StrictFactScheduleExecutionResultV1,
  analysis: StrictTestDimensionAgentAnalysisLineageV1
): void {
  const baselineById = new Map(
    authority.compiledPlan.schedule.factHarvestObligations.map((row) => [row.obligationId, row])
  );
  const expansionById = new Map(
    analysis.expansionReceipts.flatMap((receipt) =>
      receipt.rows.map((row) => [row.obligationId, row] as const)
    )
  );
  const scheduleIds = analysis.finalFactSchedule.factHarvestObligations.map(
    (row) => row.obligationId
  );
  const executionIds = factExecution.receipts.map((receipt) => receipt.obligationId);
  const scheduleRowsMismatch = analysis.finalFactSchedule.factHarvestObligations.some((row) => {
    const baseline = baselineById.get(row.obligationId);
    if (baseline) {
      return canonicalJsonStringify(baseline) !== canonicalJsonStringify(row);
    }
    const expansion = expansionById.get(row.obligationId);
    return (
      !expansion ||
      row.factFamilyId !== expansion.factFamilyId ||
      row.capabilityId !== expansion.capabilityId ||
      row.canonicalSubjectRef !== expansion.canonicalSubjectRef ||
      row.analysisScale !== expansion.analysisScale ||
      row.denominator !== 'complete-frozen-subject' ||
      row.source !== 'accepted-plan-addition'
    );
  });
  if (
    analysis.finalExpandedSchedule.baselineScheduleHash !== authority.fullBaselineScheduleHash ||
    !sameStringSet(analysis.finalExpandedSchedule.obligationIds, scheduleIds) ||
    !sameStringSet(scheduleIds, executionIds) ||
    analysis.finalFactSchedule.factHarvestScheduleHash !==
      factExecution.manifest.factHarvestScheduleHash ||
    analysis.finalFactSchedule.lensBindingsHash !==
      authority.compiledPlan.schedule.lensBindingsHash ||
    canonicalJsonStringify(analysis.finalFactSchedule.lensBindings) !==
      canonicalJsonStringify(authority.compiledPlan.schedule.lensBindings) ||
    scheduleRowsMismatch
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_FINAL_FACT_SCHEDULE_MISMATCH');
  }
}

function normalizeCellDispositions(
  authority: StrictTestDimensionAgentAuthorityV1,
  factExecution: StrictFactScheduleExecutionResultV1,
  analysis: StrictTestDimensionAgentAnalysisLineageV1 | null,
  expectedTrustPolicies: readonly SemanticDispositionReviewTrustPolicyV3[],
  rows: readonly StrictTestDimensionAgentCellDispositionInputV1[]
): readonly StrictTestDimensionAgentCellDispositionV1[] {
  if (
    !Array.isArray(rows) ||
    rows.length !== authority.selectedCellIds.length ||
    !sameOrderedStrings(
      rows.map((row) => row.cellId),
      authority.selectedCellIds
    )
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_CELL_DISPOSITION_SET_MISMATCH');
  }
  const trustPolicies = new Map(expectedTrustPolicies.map((policy) => [policy.policyHash, policy]));
  if (
    trustPolicies.size !== expectedTrustPolicies.length ||
    expectedTrustPolicies.some((policy) => !SHA256_PATTERN.test(policy.policyHash))
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_TRUST_POLICY_SET_INVALID');
  }
  const normalized = rows.map((row) =>
    normalizeCellDisposition(authority, factExecution, analysis, trustPolicies, row)
  );
  const attestationHashes = normalized.flatMap((row) => [
    ...row.semanticReviewDurableAttestationHashes,
    ...row.dispositionReviewDurableAttestationHashes,
  ]);
  if (new Set(attestationHashes).size !== attestationHashes.length) {
    fail('STRICT_TEST_DIMENSION_AGENT_ATTESTATION_REUSED');
  }
  return freezeDeep(normalized);
}

function normalizeCellDisposition(
  authority: StrictTestDimensionAgentAuthorityV1,
  factExecution: StrictFactScheduleExecutionResultV1,
  analysis: StrictTestDimensionAgentAnalysisLineageV1 | null,
  trustPolicies: ReadonlyMap<string, SemanticDispositionReviewTrustPolicyV3>,
  row: StrictTestDimensionAgentCellDispositionInputV1
): StrictTestDimensionAgentCellDispositionV1 {
  assertExactKeys(
    row,
    CELL_DISPOSITION_INPUT_KEYS,
    'STRICT_TEST_DIMENSION_AGENT_CELL_DISPOSITION_FIELDS_INVALID'
  );
  if (!TERMINAL_DISPOSITIONS.has(row.disposition)) {
    fail('STRICT_TEST_DIMENSION_AGENT_CELL_DISPOSITION_INVALID');
  }
  const evidenceRefs = uniqueSorted(row.evidenceRefs);
  if (
    (row.disposition === 'rejected' || row.disposition === 'failed') &&
    (typeof row.reasonCode !== 'string' ||
      row.reasonCode.trim().length === 0 ||
      evidenceRefs.length === 0)
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_CELL_FAILURE_EVIDENCE_REQUIRED');
  }
  if (
    row.reasonCode !== null &&
    (typeof row.reasonCode !== 'string' || row.reasonCode.trim().length === 0)
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_CELL_REASON_INVALID');
  }
  const expressionSetReceipts = validateExpressionSetReceipts(analysis, row.expressionSetReceipts);
  const semanticReviews = validateDurableAttestations(
    authority,
    factExecution,
    analysis,
    trustPolicies,
    row.semanticReviewAttestations,
    'producer-non-draft'
  );
  const dispositionReviews = validateDurableAttestations(
    authority,
    factExecution,
    analysis,
    trustPolicies,
    row.dispositionReviewAttestations,
    'investigated-empty'
  );
  if (row.disposition === 'accepted') {
    assertAcceptedAttestationExpressionLineage(expressionSetReceipts, semanticReviews);
  }
  assertDispositionEvidenceRules(
    row.disposition,
    expressionSetReceipts,
    semanticReviews,
    dispositionReviews
  );
  const semantic = {
    cellId: row.cellId,
    disposition: row.disposition,
    expressionSetReceipts,
    semanticReviewAttestations: semanticReviews.map((item) => item.attestation),
    dispositionReviewAttestations: dispositionReviews.map((item) => item.attestation),
    reasonCode: row.reasonCode,
    evidenceRefs,
    expressionSetReceiptHashes: expressionSetReceipts.map((receipt) => receipt.receiptHash),
    semanticReviewDurableAttestationHashes: semanticReviews.map(
      (item) => item.attestation.attestationHash
    ),
    dispositionReviewDurableAttestationHashes: dispositionReviews.map(
      (item) => item.attestation.attestationHash
    ),
  };
  return freezeDeep({ ...semantic, cellDispositionHash: hashCanonicalJson(semantic) });
}

function assertAcceptedAttestationExpressionLineage(
  expressionSets: readonly HypothesisExpressionSetReceiptV1[],
  semanticReviews: readonly {
    readonly attestation: SemanticDispositionReviewDurableAttestationV5;
  }[]
): void {
  const expressionSetById = new Map(expressionSets.map((receipt) => [receipt.receiptId, receipt]));
  for (const { attestation } of semanticReviews) {
    const request = attestation.execution.request.semanticRequest;
    if (request.context.reviewKind !== 'producer-non-draft') {
      fail('STRICT_TEST_DIMENSION_AGENT_ACCEPTED_REVIEW_KIND_INVALID');
    }
    const expressionSet = expressionSetById.get(request.context.expressionSetReceiptId);
    const nestedReviews = expressionSet
      ? [
          ...(expressionSet.zeroDisposition
            ? [expressionSet.zeroDisposition.dispositionReview]
            : []),
          ...expressionSet.expressions.flatMap((expression) =>
            expression.dispositionReview ? [expression.dispositionReview] : []
          ),
        ]
      : [];
    if (
      !expressionSet ||
      nestedReviews.every(
        (review) => review.semanticExecutionResultHash !== attestation.execution.executionHash
      )
    ) {
      fail('STRICT_TEST_DIMENSION_AGENT_ACCEPTED_EXPRESSION_REVIEW_MISMATCH');
    }
  }
}

function validateExpressionSetReceipts(
  analysis: StrictTestDimensionAgentAnalysisLineageV1 | null,
  receipts: readonly HypothesisExpressionSetReceiptV1[]
): readonly HypothesisExpressionSetReceiptV1[] {
  const normalized = receipts.map((receipt) => {
    const {
      conservation: _conservation,
      terminalClosure: _terminalClosure,
      receiptHash,
      ...input
    } = receipt;
    const rebuilt = validateHypothesisExpressionSetReceiptV1(input);
    if (
      canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(receipt) ||
      !analysis ||
      rebuilt.analysisFixpointHash !== analysis.analysisFixpoint.fixpointHash ||
      rebuilt.terminalHead !== true ||
      rebuilt.conservation.unresolved !== 0 ||
      receiptHash !== rebuilt.receiptHash
    ) {
      fail('STRICT_TEST_DIMENSION_AGENT_EXPRESSION_RECEIPT_INVALID');
    }
    return receipt;
  });
  const hashes = normalized.map((receipt) => receipt.receiptHash);
  if (new Set(hashes).size !== hashes.length) {
    fail('STRICT_TEST_DIMENSION_AGENT_EXPRESSION_RECEIPT_DUPLICATE');
  }
  return freezeDeep(normalized);
}

function validateDurableAttestations(
  authority: StrictTestDimensionAgentAuthorityV1,
  factExecution: StrictFactScheduleExecutionResultV1,
  analysis: StrictTestDimensionAgentAnalysisLineageV1 | null,
  trustPolicies: ReadonlyMap<string, SemanticDispositionReviewTrustPolicyV3>,
  attestations: readonly SemanticDispositionReviewDurableAttestationV5[],
  expectedReviewKind: 'producer-non-draft' | 'investigated-empty'
): readonly {
  readonly attestation: SemanticDispositionReviewDurableAttestationV5;
  readonly verdict: 'pass' | 'revise' | 'reject';
}[] {
  const factReceiptHashes = new Set(factExecution.receipts.map((receipt) => receipt.receiptHash));
  const validated = attestations.map((attestation) => {
    const expectedTrustPolicy = trustPolicies.get(attestation.trustPolicyHash);
    if (!expectedTrustPolicy || !analysis) {
      fail('STRICT_TEST_DIMENSION_AGENT_ATTESTATION_TRUST_REQUIRED');
    }
    assertSemanticDispositionReviewDurableAttestationV5({
      attestation,
      expectedTrustPolicy,
    });
    const request = attestation.execution.request.semanticRequest;
    const review = consumeMainSemanticDispositionReviewDurableAttestationV5({
      attestation,
      expectedSemanticRequest: request,
      expectedTrustPolicy,
    });
    const requestReceiptHashes = request.executionReceipts.map((receipt) => receipt.receiptHash);
    const invalid =
      request.reviewKind !== expectedReviewKind ||
      request.strictWorkflowRunId !== authority.runId ||
      request.sourceRevisionVectorHash !== authority.sourceRevisionVectorHash ||
      request.currentAnalysisFixpointHash !== analysis.analysisFixpoint.fixpointHash ||
      canonicalJsonStringify(request.finalExpandedSchedule) !==
        canonicalJsonStringify(analysis.finalExpandedSchedule) ||
      requestReceiptHashes.length === 0 ||
      requestReceiptHashes.some((hash) => !factReceiptHashes.has(hash)) ||
      request.context.analysisFixpoint.fixpointHash !== analysis.analysisFixpoint.fixpointHash ||
      !analysis.analysisFixpoint.populationHashes.includes(request.populationHash);
    if (invalid) {
      fail('STRICT_TEST_DIMENSION_AGENT_ATTESTATION_LINEAGE_MISMATCH');
    }
    return { attestation, verdict: review.verdict };
  });
  const hashes = validated.map((item) => item.attestation.attestationHash);
  if (new Set(hashes).size !== hashes.length) {
    fail('STRICT_TEST_DIMENSION_AGENT_ATTESTATION_DUPLICATE');
  }
  return freezeDeep(validated);
}

function assertDispositionEvidenceRules(
  disposition: StrictTestDimensionAgentTerminalDispositionV1,
  expressionSets: readonly HypothesisExpressionSetReceiptV1[],
  semanticReviews: readonly { readonly verdict: 'pass' | 'revise' | 'reject' }[],
  dispositionReviews: readonly { readonly verdict: 'pass' | 'revise' | 'reject' }[]
): void {
  if (
    disposition === 'accepted' &&
    (expressionSets.length === 0 ||
      semanticReviews.length === 0 ||
      semanticReviews.some((review) => review.verdict !== 'pass') ||
      dispositionReviews.length !== 0)
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_ACCEPTED_EVIDENCE_REQUIRED');
  }
  if (
    disposition === 'investigated-empty' &&
    (expressionSets.length !== 0 ||
      semanticReviews.length !== 0 ||
      dispositionReviews.length === 0 ||
      dispositionReviews.some((review) => review.verdict !== 'pass'))
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_INVESTIGATED_EMPTY_EVIDENCE_REQUIRED');
  }
  if (
    disposition === 'failed' &&
    (expressionSets.length !== 0 || semanticReviews.length !== 0 || dispositionReviews.length !== 0)
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_FAILED_SUCCESS_EVIDENCE_FORBIDDEN');
  }
  if (
    disposition === 'rejected' &&
    [...semanticReviews, ...dispositionReviews].some((review) => review.verdict === 'pass')
  ) {
    fail('STRICT_TEST_DIMENSION_AGENT_REJECTED_SUCCESS_EVIDENCE_FORBIDDEN');
  }
}

function countCellDispositions(rows: readonly StrictTestDimensionAgentCellDispositionV1[]): {
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly investigatedEmptyCount: number;
  readonly failedCount: number;
} {
  return {
    acceptedCount: rows.filter((row) => row.disposition === 'accepted').length,
    rejectedCount: rows.filter((row) => row.disposition === 'rejected').length,
    investigatedEmptyCount: rows.filter((row) => row.disposition === 'investigated-empty').length,
    failedCount: rows.filter((row) => row.disposition === 'failed').length,
  };
}

function validateCoreAuthorityChain(input: CreateStrictTestDimensionAgentAuthorityInputV1): void {
  assertStrictTestPreflightCurrentV1(
    input.preflight,
    input.currentBindings,
    input.automaticSelection.selectedAt
  );
  assertStrictTestAutomaticSelectionReceiptV1(input.automaticSelection, input.preflight);
  assertStrictTestDimensionExecutionProjectionV1(
    input.projection,
    input.preflight,
    input.automaticSelection
  );
  assertStrictTestResumeContextV1({
    preflight: input.preflight,
    automaticSelection: input.automaticSelection,
    projection: input.projection,
    currentBindings: input.currentBindings,
    privateWorkspacePolicyHash: input.currentBindings.privateWorkspacePolicyHash,
  });
  const rebuiltPreflight = validateStrictTestPreflightV1(input.compiledPlan, input.currentBindings);
  if (canonicalJsonStringify(rebuiltPreflight) !== canonicalJsonStringify(input.preflight)) {
    fail('STRICT_TEST_DIMENSION_AGENT_PREFLIGHT_PLAN_MISMATCH');
  }
  assertFullUniverseLineage(input);
}

function assertFullUniverseLineage(input: CreateStrictTestDimensionAgentAuthorityInputV1): void {
  const plan = input.compiledPlan;
  const preflight = input.preflight;
  const automaticSelection = input.automaticSelection;
  const projection = input.projection;
  const selectedCellIds = selectedEligibleCellIds(input);
  const invalid =
    plan.canonicalPlanHash !== preflight.compiledPlanHash ||
    plan.catalog.catalogHash !== projection.fullCatalogHash ||
    plan.catalog.sourceArtifactHash !== projection.fullCatalogSourceArtifactHash ||
    plan.universe.cellUniverseHash !== projection.fullCellUniverseHash ||
    plan.universe.eligibleCellsHash !== projection.fullEligibleCellsHash ||
    plan.universe.excludedCellsHash !== projection.fullExcludedCellsHash ||
    plan.requiredFactApplicability.universeHash !== projection.fullApplicabilityUniverseHash ||
    plan.factQueryCatalog.catalogHash !== projection.fullFactQueryCatalogHash ||
    plan.schedule.baselineScheduleHash !== projection.fullBaselineScheduleHash ||
    plan.execution.factsBindingHash !== projection.certifiedProjectFactsContentHash ||
    plan.execution.sourceRevisionVectorHash !== projection.sourceRevisionVectorHash ||
    preflight.sourceInventoryHash !== projection.sourceInventoryHash ||
    automaticSelection.selectedDimensionId !== projection.selectedDimensionId ||
    !sameOrderedStrings(automaticSelection.selectedEligibleCellIds, selectedCellIds) ||
    !sameOrderedStrings(projection.executionCellIds, selectedCellIds) ||
    automaticSelection.selectedEligibleCellsHash !== hashCanonicalJson(selectedCellIds) ||
    projection.executionCellSetHash !== hashCanonicalJson(selectedCellIds) ||
    plan.selection.deferredCells.length !== 0;
  if (invalid) {
    fail('STRICT_TEST_DIMENSION_AGENT_FULL_UNIVERSE_MISMATCH');
  }
}

function selectedEligibleCellIds(input: CreateStrictTestDimensionAgentAuthorityInputV1): string[] {
  const selected = input.compiledPlan.universe.cells
    .filter(
      (cell) =>
        cell.dimensionId === input.projection.selectedDimensionId && cell.status === 'eligible'
    )
    .map((cell) => cell.cellId);
  if (selected.length < 1 || new Set(selected).size !== selected.length) {
    fail('STRICT_TEST_DIMENSION_AGENT_SELECTED_CELL_ORDER_INVALID');
  }
  return selected;
}

function normalizeRuntimeCells(
  authority: StrictTestDimensionAgentAuthorityV1,
  rows: readonly StrictTestDimensionEligibleCellV1[]
): readonly StrictTestDimensionEligibleCellV1[] {
  if (!Array.isArray(rows) || rows.length !== authority.selectedCellIds.length) {
    fail('STRICT_TEST_DIMENSION_RUNTIME_CELL_SET_MISMATCH');
  }
  const normalized = rows.map((row) => {
    assertExactKeys(
      row,
      ['cellId', 'dimensionId', 'moduleId'],
      'STRICT_TEST_DIMENSION_RUNTIME_CELL_FIELDS_INVALID'
    );
    requireText(row.cellId, 'STRICT_TEST_DIMENSION_RUNTIME_CELL_ID_INVALID');
    requireText(row.moduleId, 'STRICT_TEST_DIMENSION_RUNTIME_CELL_ID_INVALID');
    requireText(row.dimensionId, 'STRICT_TEST_DIMENSION_RUNTIME_CELL_ID_INVALID');
    if (
      row.dimensionId !== authority.selectedDimensionId ||
      row.cellId !== `${row.moduleId}::${row.dimensionId}`
    ) {
      fail('STRICT_TEST_DIMENSION_RUNTIME_CELL_ID_INVALID');
    }
    const planCell = authority.compiledPlan.universe.cells.find(
      (candidate) => candidate.cellId === row.cellId
    );
    if (
      !planCell ||
      planCell.status !== 'eligible' ||
      planCell.moduleId !== row.moduleId ||
      planCell.dimensionId !== row.dimensionId
    ) {
      fail('STRICT_TEST_DIMENSION_RUNTIME_CELL_AUTHORITY_MISMATCH');
    }
    return { cellId: row.cellId, moduleId: row.moduleId, dimensionId: row.dimensionId };
  });
  if (
    new Set(normalized.map((row) => row.cellId)).size !== normalized.length ||
    !sameOrderedStrings(
      normalized.map((row) => row.cellId),
      authority.selectedCellIds
    )
  ) {
    fail('STRICT_TEST_DIMENSION_RUNTIME_CELL_SET_MISMATCH');
  }
  return freezeDeep(normalized);
}

function assertBaseRuntimePort(port: StrictProductionRuntimePortV1): void {
  if (
    !port ||
    typeof port !== 'object' ||
    Array.isArray(port) ||
    port.enabled !== true ||
    !port.analysisLimits ||
    !Number.isSafeInteger(port.analysisLimits.maxEpochs) ||
    port.analysisLimits.maxEpochs < 1 ||
    !Number.isSafeInteger(port.analysisLimits.maxObligations) ||
    port.analysisLimits.maxObligations < 1 ||
    !port.expansionPort ||
    typeof port.expansionPort.assertExecutionAllowed !== 'function' ||
    typeof port.readAnalysisEpoch !== 'function' ||
    typeof port.buildProducerInput !== 'function' ||
    typeof port.validateAnalystResult !== 'function' ||
    typeof port.reviewProducerResult !== 'function'
  ) {
    fail('STRICT_TEST_DIMENSION_RUNTIME_BASE_PORT_INVALID');
  }
}

function assertRuntimeAuthorityLineage(
  authority: StrictTestDimensionAgentAuthorityV1,
  port: StrictProductionRuntimePortV1
): void {
  const snapshot = port.readAnalysisEpoch();
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail('STRICT_TEST_DIMENSION_RUNTIME_EPOCH_REQUIRED');
  }
  const { schemaVersion, snapshotHash, ...snapshotInput } = snapshot;
  if (schemaVersion !== 1) {
    fail('STRICT_TEST_DIMENSION_RUNTIME_EPOCH_INVALID');
  }
  const normalized = createStrictAnalysisEpochSnapshotV1(snapshotInput);
  if (normalized.snapshotHash !== snapshotHash) {
    fail('STRICT_TEST_DIMENSION_RUNTIME_EPOCH_INVALID');
  }
  const context = normalized.context;
  if (
    context.runId !== authority.runId ||
    context.planCognitionHash !== authority.planCognitionHash ||
    context.planHash !== authority.compiledPlanHash ||
    context.requiredUniverseHash !== authority.fullApplicabilityUniverseHash ||
    context.baselineScheduleHash !== authority.fullBaselineScheduleHash ||
    context.lensBindingsHash !== authority.compiledPlan.schedule.lensBindingsHash ||
    context.sourceArtifactHash !== authority.certifiedProjectFactsSourceArtifactHash ||
    context.sourceRevisionVectorHash !== authority.sourceRevisionVectorHash
  ) {
    fail('STRICT_TEST_DIMENSION_RUNTIME_AUTHORITY_LINEAGE_MISMATCH');
  }
}

function authorityHashes(authority: StrictTestDimensionAgentAuthorityV1): CanonicalSha256[] {
  return [
    authority.currentBindingsHash,
    authority.preflightHash,
    authority.bindingHash,
    authority.driftInvalidationHash,
    authority.automaticSelectionHash,
    authority.projectionHash,
    authority.compiledPlanHash,
    authority.planCognitionHash,
    authority.fullCatalogHash,
    authority.fullCatalogSourceArtifactHash,
    authority.fullCellUniverseHash,
    authority.fullEligibleCellsHash,
    authority.fullExcludedCellsHash,
    authority.fullApplicabilityUniverseHash,
    authority.fullFactQueryCatalogHash,
    authority.fullBaselineScheduleHash,
    authority.certifiedProjectFactsArtifactHash,
    authority.certifiedProjectFactsContentHash,
    authority.certifiedProjectFactsSourceArtifactHash,
    authority.certifiedProjectFactsSourceVectorHash,
    authority.certifiedProjectFactsConsumerReceiptHash,
    authority.sourceRevisionVectorHash,
    authority.sourceInventoryHash,
    authority.selectedCellSetHash,
    authority.authorityHash,
  ];
}

function assertExactKeys(value: object, expectedKeys: readonly string[], errorCode: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail(errorCode);
  }
  const actual = (ownKeys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (!sameOrderedStrings(actual, expected)) {
    fail(errorCode);
  }
}

function requireText(value: unknown, errorCode: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(errorCode);
  }
}

function requireTimestamp(value: unknown, errorCode: string): asserts value is string {
  requireText(value, errorCode);
  if (!Number.isFinite(Date.parse(value))) {
    fail(errorCode);
  }
}

function requireSha256(value: unknown, errorCode: string): asserts value is CanonicalSha256 {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(errorCode);
  }
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && sameOrderedStrings(uniqueSorted(left), uniqueSorted(right))
  );
}

function sameTerminalObligations(
  left: AnalysisFixpointReceiptV1['terminalObligations'],
  right: AnalysisFixpointReceiptV1['terminalObligations']
): boolean {
  const sortRows = (rows: AnalysisFixpointReceiptV1['terminalObligations']) =>
    [...rows].sort((first, second) => first.obligationId.localeCompare(second.obligationId));
  return canonicalJsonStringify(sortRows(left)) === canonicalJsonStringify(sortRows(right));
}

function uniqueSorted(values: readonly string[]): string[] {
  const normalized = values.map((value) => {
    requireText(value, 'STRICT_TEST_DIMENSION_AGENT_TEXT_SET_INVALID');
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {
    fail('STRICT_TEST_DIMENSION_AGENT_TEXT_SET_DUPLICATE');
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeDeep(nested);
  }
  return Object.freeze(value);
}

function fail(code: string): never {
  throw new Error(code);
}
