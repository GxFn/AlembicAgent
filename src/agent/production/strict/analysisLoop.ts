/** 严格分析上下文、epoch推进与扩展日程；保持现有hash格式和Core日程裁决。 */
import {
  type AnalysisScheduleExpansionRowV1,
  createFinalExpandedMiningScheduleReceiptV1,
  type FinalExpandedMiningScheduleReceiptV1,
  validateAnalysisScheduleExpansionV1,
} from '@alembic/core/production';
import {
  assertSameIds,
  fail,
  freeze,
  hashCanonical,
  normalizeIds,
  requireText,
} from './primitives.js';

/**
 * 严格 Agent 阶段只携带 Core 产生的不可变 ID 与 hash。该投影是上下文白名单，不是第二证据库。
 */
export interface StrictAnalysisContextProjectionV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly journalId: string;
  readonly manifestHash: string;
  readonly planCognitionHash: string;
  readonly planHash: string;
  readonly requiredUniverseHash: string;
  readonly baselineScheduleHash: string;
  readonly expansionHeadHash: string | null;
  readonly currentExpandedScheduleHash: string;
  readonly finalExpandedScheduleHash: string | null;
  readonly analysisFixpointHash: string | null;
  readonly privateCorpusRevision: string | null;
  readonly hypothesisExpressionSetHash: string | null;
  readonly lensBindingsHash: string;
  readonly sourceArtifactHash: string;
  readonly sourceRevisionVectorHash: string;
  readonly questionIds: readonly string[];
  readonly factQueryObligationIds: readonly string[];
  readonly analysisUnitIds: readonly string[];
  readonly factIds: readonly string[];
  readonly witnessIds: readonly string[];
  readonly populationHashes: readonly string[];
  readonly clusterSetHashes: readonly string[];
  readonly inductionReceiptHashes: readonly string[];
  readonly hypothesisIds: readonly string[];
  readonly falsificationReceiptHashes: readonly string[];
  readonly dispositionReviewIds: readonly string[];
  readonly evidenceEntryIds: readonly string[];
  readonly derivedFindingCount: 0;
  readonly contextHash: string;
}

export type StrictAnalysisContextInputV1 = Omit<
  StrictAnalysisContextProjectionV1,
  'schemaVersion' | 'contextHash'
>;

const REQUIRED_CONTEXT_TEXT_FIELDS = [
  'runId',
  'journalId',
  'manifestHash',
  'planCognitionHash',
  'planHash',
  'requiredUniverseHash',
  'baselineScheduleHash',
  'currentExpandedScheduleHash',
  'lensBindingsHash',
  'sourceArtifactHash',
  'sourceRevisionVectorHash',
] as const;

const CONTEXT_ARRAY_FIELDS = [
  'questionIds',
  'factQueryObligationIds',
  'analysisUnitIds',
  'factIds',
  'witnessIds',
  'populationHashes',
  'clusterSetHashes',
  'inductionReceiptHashes',
  'hypothesisIds',
  'falsificationReceiptHashes',
  'dispositionReviewIds',
  'evidenceEntryIds',
] as const;

export function createStrictAnalysisContextProjectionV1(
  input: StrictAnalysisContextInputV1
): StrictAnalysisContextProjectionV1 {
  for (const field of REQUIRED_CONTEXT_TEXT_FIELDS) {
    requireText(input[field], `STRICT_CONTEXT_${field.toUpperCase()}_REQUIRED`);
  }
  if (input.derivedFindingCount !== 0) {
    fail('STRICT_CONTEXT_DERIVED_FINDING_FORBIDDEN');
  }
  const normalizedArrays = CONTEXT_ARRAY_FIELDS.reduce(
    (result, field) => {
      result[field] = normalizeIds(input[field], field);
      return result;
    },
    {} as Record<(typeof CONTEXT_ARRAY_FIELDS)[number], readonly string[]>
  );
  const semantic = {
    schemaVersion: 1 as const,
    runId: input.runId,
    journalId: input.journalId,
    manifestHash: input.manifestHash,
    planCognitionHash: input.planCognitionHash,
    planHash: input.planHash,
    requiredUniverseHash: input.requiredUniverseHash,
    baselineScheduleHash: input.baselineScheduleHash,
    expansionHeadHash: input.expansionHeadHash,
    currentExpandedScheduleHash: input.currentExpandedScheduleHash,
    finalExpandedScheduleHash: input.finalExpandedScheduleHash,
    analysisFixpointHash: input.analysisFixpointHash,
    privateCorpusRevision: input.privateCorpusRevision,
    hypothesisExpressionSetHash: input.hypothesisExpressionSetHash,
    lensBindingsHash: input.lensBindingsHash,
    sourceArtifactHash: input.sourceArtifactHash,
    sourceRevisionVectorHash: input.sourceRevisionVectorHash,
    ...normalizedArrays,
    derivedFindingCount: 0 as const,
  };
  return freeze({ ...semantic, contextHash: hashCanonical(semantic) });
}

export interface StrictAnalysisLoopLimitsV1 {
  readonly maxEpochs: number;
  readonly maxObligations: number;
}

export interface StrictAnalysisEpochSnapshotInputV1 {
  readonly epoch: number;
  readonly context: StrictAnalysisContextProjectionV1;
  readonly populations: readonly unknown[];
  readonly terminalObligationIds: readonly string[];
  readonly outstandingObligationIds: readonly string[];
}

/**
 * 每次 Analyst 调用只观察一个不可变 epoch 快照。population payload 会进入 snapshot hash，
 * 而事实/日程 authority 仍来自经过 hash 校验的 StrictAnalysisContextProjectionV1。
 */
export interface StrictAnalysisEpochSnapshotV1 extends StrictAnalysisEpochSnapshotInputV1 {
  readonly schemaVersion: 1;
  readonly snapshotHash: string;
}

export function createStrictAnalysisEpochSnapshotV1(
  input: StrictAnalysisEpochSnapshotInputV1
): StrictAnalysisEpochSnapshotV1 {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
    fail('STRICT_ANALYSIS_EPOCH_INVALID');
  }
  assertStrictContextIntegrity(input.context);
  const terminalObligationIds = normalizeIds(input.terminalObligationIds, 'terminalObligationIds');
  const outstandingObligationIds = normalizeIds(
    input.outstandingObligationIds,
    'outstandingObligationIds'
  );
  if (terminalObligationIds.some((id) => outstandingObligationIds.includes(id))) {
    fail('STRICT_ANALYSIS_OBLIGATION_STATE_CONFLICT');
  }
  assertSameIds(
    [...terminalObligationIds, ...outstandingObligationIds],
    input.context.factQueryObligationIds,
    'STRICT_ANALYSIS_OBLIGATION_STATE_CONSERVATION'
  );
  const semantic = {
    schemaVersion: 1 as const,
    epoch: input.epoch,
    context: input.context,
    populations: [...input.populations],
    terminalObligationIds,
    outstandingObligationIds,
  };
  return freeze({ ...semantic, snapshotHash: hashCanonical(semantic) });
}

export interface StrictAnalysisGateOutcomeInputV1 {
  readonly action: 'pass' | 'analysis_retry' | 'reject';
  readonly reasonCode: string;
  readonly observedEpochHash: string;
  readonly enrolledObligationIds?: readonly string[];
  readonly executedObligationIds?: readonly string[];
  readonly artifact?: unknown;
}

/**
 * strict fixpoint gate 只接受这一种判定形状。analysis_retry 不是 legacy 分数重试：
 * 它必须同时列出新登记且已执行的 obligation，随后由 epoch transition 再验 append-only 进展。
 */
export interface StrictAnalysisGateOutcomeV1 {
  readonly kind: 'StrictAnalysisGateOutcomeV1';
  readonly schemaVersion: 1;
  readonly action: StrictAnalysisGateOutcomeInputV1['action'];
  readonly pass: boolean;
  readonly reasonCode: string;
  readonly observedEpochHash: string;
  readonly enrolledObligationIds: readonly string[];
  readonly executedObligationIds: readonly string[];
  readonly artifact: unknown;
  readonly outcomeHash: string;
}

export function createStrictAnalysisGateOutcomeV1(
  input: StrictAnalysisGateOutcomeInputV1
): StrictAnalysisGateOutcomeV1 {
  requireText(input.reasonCode, 'STRICT_ANALYSIS_GATE_REASON_REQUIRED');
  requireText(input.observedEpochHash, 'STRICT_ANALYSIS_GATE_EPOCH_HASH_REQUIRED');
  const enrolledObligationIds = normalizeIds(
    input.enrolledObligationIds ?? [],
    'enrolledObligationIds'
  );
  const executedObligationIds = normalizeIds(
    input.executedObligationIds ?? [],
    'executedObligationIds'
  );
  if (input.action === 'analysis_retry') {
    if (enrolledObligationIds.length === 0) {
      fail('STRICT_ANALYSIS_RETRY_OBLIGATION_REQUIRED');
    }
    assertSameIds(
      enrolledObligationIds,
      executedObligationIds,
      'STRICT_ANALYSIS_RETRY_EXECUTION_CONSERVATION'
    );
  } else if (enrolledObligationIds.length > 0 || executedObligationIds.length > 0) {
    fail('STRICT_ANALYSIS_NON_RETRY_OBLIGATION_FORBIDDEN');
  }
  const semantic = {
    kind: 'StrictAnalysisGateOutcomeV1' as const,
    schemaVersion: 1 as const,
    action: input.action,
    pass: input.action === 'pass',
    reasonCode: input.reasonCode,
    observedEpochHash: input.observedEpochHash,
    enrolledObligationIds,
    executedObligationIds,
    artifact: input.artifact ?? null,
  };
  return freeze({ ...semantic, outcomeHash: hashCanonical(semantic) });
}

export interface StrictAnalysisEpochTransitionV1 {
  readonly kind: 'StrictAnalysisEpochTransitionV1';
  readonly schemaVersion: 1;
  readonly action: StrictAnalysisGateOutcomeV1['action'];
  readonly reasonCode: string;
  readonly limits: StrictAnalysisLoopLimitsV1;
  readonly before: StrictAnalysisEpochSummaryV1;
  readonly after: StrictAnalysisEpochSummaryV1;
  readonly enrolledObligationIds: readonly string[];
  readonly executedObligationIds: readonly string[];
  readonly resultArtifact: unknown;
  readonly transitionHash: string;
}

interface StrictAnalysisEpochSummaryV1 {
  readonly epoch: number;
  readonly snapshotHash: string;
  readonly contextHash: string;
  readonly currentExpandedScheduleHash: string;
  readonly finalExpandedScheduleHash: string | null;
  readonly analysisFixpointHash: string | null;
  readonly factQueryObligationIds: readonly string[];
  readonly factIds: readonly string[];
  readonly witnessIds: readonly string[];
  readonly populationHashes: readonly string[];
  readonly terminalObligationIds: readonly string[];
  readonly outstandingObligationIds: readonly string[];
}

export function validateStrictAnalysisEpochTransitionV1(input: {
  readonly before: StrictAnalysisEpochSnapshotV1;
  readonly after: StrictAnalysisEpochSnapshotV1;
  readonly outcome: StrictAnalysisGateOutcomeV1;
  readonly limits: StrictAnalysisLoopLimitsV1;
}): StrictAnalysisEpochTransitionV1 {
  assertStrictAnalysisEpochSnapshotIntegrity(input.before);
  assertStrictAnalysisEpochSnapshotIntegrity(input.after);
  assertStrictAnalysisGateOutcomeIntegrity(input.outcome);
  assertStrictAnalysisLoopLimits(input.limits);
  if (input.outcome.observedEpochHash !== input.before.snapshotHash) {
    fail('STRICT_ANALYSIS_GATE_EPOCH_MISMATCH');
  }
  if (
    input.before.epoch > input.limits.maxEpochs ||
    input.before.context.factQueryObligationIds.length > input.limits.maxObligations
  ) {
    fail('STRICT_ANALYSIS_LOOP_LIMIT_INVALID_AT_ENTRY');
  }
  assertStrictAnalysisIdentityStable(input.before.context, input.after.context);

  if (input.outcome.action === 'analysis_retry') {
    validateStrictAnalysisRetryTransition(input);
  } else if (input.outcome.action === 'pass') {
    validateStrictAnalysisPassTransition(input);
  } else if (input.before.snapshotHash !== input.after.snapshotHash) {
    fail('STRICT_ANALYSIS_REJECT_MUTATED_EPOCH');
  }

  const semantic = {
    kind: 'StrictAnalysisEpochTransitionV1' as const,
    schemaVersion: 1 as const,
    action: input.outcome.action,
    reasonCode: input.outcome.reasonCode,
    limits: { ...input.limits },
    before: summarizeStrictAnalysisEpoch(input.before),
    after: summarizeStrictAnalysisEpoch(input.after),
    enrolledObligationIds: input.outcome.enrolledObligationIds,
    executedObligationIds: input.outcome.executedObligationIds,
    resultArtifact: input.outcome.artifact,
  };
  return freeze({ ...semantic, transitionHash: hashCanonical(semantic) });
}

export interface StrictAnalysisExpansionPortInputV1 {
  readonly baselineScheduleHash: string;
  readonly baselineObligationIds: readonly string[];
  readonly knownFactFamilies: readonly {
    readonly id: string;
    readonly capabilityId: string;
    readonly supportedScales: readonly (
      | 'source-range'
      | 'symbol'
      | 'file'
      | 'module'
      | 'package'
      | 'repository'
      | 'project'
    )[];
  }[];
  readonly knownSubjectRefs: readonly string[];
  readonly obligationCap: number;
}

/**
 * 既有 PipelineStrategy 使用的 append-only 登记端口。执行探索或反例查询之前必须调用
 * assertExecutionAllowed，杜绝未登记查询旁路。
 */
export class StrictAnalysisExpansionPortV1 {
  readonly #input: StrictAnalysisExpansionPortInputV1;
  readonly #receipts: ReturnType<typeof validateAnalysisScheduleExpansionV1>[] = [];
  #finalSchedule: FinalExpandedMiningScheduleReceiptV1 | null = null;

  constructor(input: StrictAnalysisExpansionPortInputV1) {
    requireText(input.baselineScheduleHash, 'STRICT_ANALYSIS_BASELINE_SCHEDULE_REQUIRED');
    if (!Number.isSafeInteger(input.obligationCap) || input.obligationCap < 1) {
      fail('STRICT_ANALYSIS_OBLIGATION_CAP_INVALID');
    }
    this.#input = freeze({
      ...input,
      baselineObligationIds: normalizeIds(input.baselineObligationIds, 'baselineObligationIds'),
      knownSubjectRefs: normalizeIds(input.knownSubjectRefs, 'knownSubjectRefs'),
      knownFactFamilies: input.knownFactFamilies.map((family) => ({
        ...family,
        supportedScales: [...family.supportedScales],
      })),
    });
  }

  enroll(row: AnalysisScheduleExpansionRowV1) {
    if (this.#finalSchedule) {
      fail('STRICT_ANALYSIS_SCHEDULE_ALREADY_FINAL');
    }
    const existingExpansionObligationIds = this.#receipts.flatMap((receipt) =>
      receipt.rows.map((candidate) => candidate.obligationId)
    );
    const receipt = validateAnalysisScheduleExpansionV1({
      previousExpansionHeadHash: this.#receipts.at(-1)?.receiptHash ?? null,
      baselineObligationIds: this.#input.baselineObligationIds,
      existingExpansionObligationIds,
      rows: [row],
      knownFactFamilies: this.#input.knownFactFamilies,
      knownSubjectRefs: this.#input.knownSubjectRefs,
      obligationCap: this.#input.obligationCap,
    });
    this.#receipts.push(receipt);
    return receipt;
  }

  assertExecutionAllowed(obligationId: string): AnalysisScheduleExpansionRowV1 {
    const row = this.#receipts
      .flatMap((receipt) => receipt.rows)
      .find((candidate) => candidate.obligationId === obligationId);
    if (!row) {
      fail('STRICT_ANALYSIS_QUERY_UNENROLLED', obligationId);
    }
    return row;
  }

  /** Core 生成并校验回执后，先核对调用者的预期再提交状态；无参调用保持兼容。 */
  seal(expectedFinalScheduleHash?: string) {
    const schedule =
      this.#finalSchedule ??
      createFinalExpandedMiningScheduleReceiptV1({
        baselineScheduleHash: this.#input.baselineScheduleHash,
        baselineObligationIds: this.#input.baselineObligationIds,
        expansionReceipts: this.#receipts,
      });
    if (
      expectedFinalScheduleHash !== undefined &&
      schedule.finalExpandedScheduleHash !== expectedFinalScheduleHash
    ) {
      fail('STRICT_ANALYSIS_FIXPOINT_SCHEDULE_MISMATCH');
    }
    this.#finalSchedule = schedule;
    return schedule;
  }

  get receipts() {
    return [...this.#receipts];
  }

  get obligationCap() {
    return this.#input.obligationCap;
  }

  get enrolledObligationIds() {
    return this.#receipts.flatMap((receipt) =>
      receipt.rows.map((candidate) => candidate.obligationId)
    );
  }

  get finalSchedule() {
    return this.#finalSchedule;
  }
}

export function createStrictAnalysisExpansionPortV1(
  input: StrictAnalysisExpansionPortInputV1
): StrictAnalysisExpansionPortV1 {
  return new StrictAnalysisExpansionPortV1(input);
}

function assertStrictAnalysisEpochSnapshotIntegrity(snapshot: StrictAnalysisEpochSnapshotV1): void {
  const { schemaVersion, snapshotHash, ...input } = snapshot;
  if (schemaVersion !== 1) {
    fail('STRICT_ANALYSIS_EPOCH_VERSION_MISMATCH');
  }
  const rebuilt = createStrictAnalysisEpochSnapshotV1(input);
  if (rebuilt.snapshotHash !== snapshotHash) {
    fail('STRICT_ANALYSIS_EPOCH_HASH_MISMATCH');
  }
}

function assertStrictAnalysisGateOutcomeIntegrity(outcome: StrictAnalysisGateOutcomeV1): void {
  if (outcome.kind !== 'StrictAnalysisGateOutcomeV1' || outcome.schemaVersion !== 1) {
    fail('STRICT_ANALYSIS_GATE_OUTCOME_UNTYPED');
  }
  const { kind: _kind, schemaVersion: _schemaVersion, outcomeHash, pass, ...input } = outcome;
  const rebuilt = createStrictAnalysisGateOutcomeV1(input);
  if (rebuilt.outcomeHash !== outcomeHash || rebuilt.pass !== pass) {
    fail('STRICT_ANALYSIS_GATE_OUTCOME_HASH_MISMATCH');
  }
}

function assertStrictAnalysisLoopLimits(limits: StrictAnalysisLoopLimitsV1): void {
  if (!Number.isSafeInteger(limits.maxEpochs) || limits.maxEpochs < 1) {
    fail('STRICT_ANALYSIS_MAX_EPOCHS_INVALID');
  }
  if (!Number.isSafeInteger(limits.maxObligations) || limits.maxObligations < 1) {
    fail('STRICT_ANALYSIS_MAX_OBLIGATIONS_INVALID');
  }
}

function assertStrictAnalysisIdentityStable(
  before: StrictAnalysisContextProjectionV1,
  after: StrictAnalysisContextProjectionV1
): void {
  const identityFields = [
    'runId',
    'journalId',
    'manifestHash',
    'planCognitionHash',
    'planHash',
    'requiredUniverseHash',
    'baselineScheduleHash',
    'lensBindingsHash',
    'sourceArtifactHash',
    'sourceRevisionVectorHash',
    'privateCorpusRevision',
    'hypothesisExpressionSetHash',
    'derivedFindingCount',
  ] as const;
  for (const field of identityFields) {
    if (before[field] !== after[field]) {
      fail('STRICT_ANALYSIS_EPOCH_IDENTITY_DRIFT', field);
    }
  }
  for (const field of CONTEXT_ARRAY_FIELDS) {
    assertAppendOnlyIds(
      before[field],
      after[field],
      `STRICT_ANALYSIS_${field.toUpperCase()}_NOT_APPEND_ONLY`
    );
  }
}

function validateStrictAnalysisRetryTransition(input: {
  readonly before: StrictAnalysisEpochSnapshotV1;
  readonly after: StrictAnalysisEpochSnapshotV1;
  readonly outcome: StrictAnalysisGateOutcomeV1;
  readonly limits: StrictAnalysisLoopLimitsV1;
}): void {
  if (input.before.epoch >= input.limits.maxEpochs || input.after.epoch > input.limits.maxEpochs) {
    fail('STRICT_ANALYSIS_EPOCH_LIMIT_EXHAUSTED');
  }
  if (input.after.snapshotHash === input.before.snapshotHash) {
    fail('STRICT_ANALYSIS_RETRY_NON_PROGRESS');
  }
  if (input.after.epoch !== input.before.epoch + 1) {
    fail('STRICT_ANALYSIS_RETRY_EPOCH_SEQUENCE_INVALID');
  }
  if (
    input.before.context.finalExpandedScheduleHash !== null ||
    input.before.context.analysisFixpointHash !== null ||
    input.after.context.finalExpandedScheduleHash !== null ||
    input.after.context.analysisFixpointHash !== null
  ) {
    fail('STRICT_ANALYSIS_RETRY_AFTER_FIXPOINT_FORBIDDEN');
  }
  if (
    input.after.context.currentExpandedScheduleHash ===
      input.before.context.currentExpandedScheduleHash ||
    input.after.context.expansionHeadHash === input.before.context.expansionHeadHash
  ) {
    fail('STRICT_ANALYSIS_RETRY_SCHEDULE_NOT_ADVANCED');
  }
  if (input.after.context.factQueryObligationIds.length > input.limits.maxObligations) {
    fail('STRICT_ANALYSIS_OBLIGATION_LIMIT_EXHAUSTED');
  }
  assertAppendOnlyIds(
    input.before.terminalObligationIds,
    input.after.terminalObligationIds,
    'STRICT_ANALYSIS_TERMINAL_OBLIGATIONS_NOT_APPEND_ONLY'
  );
  assertSameIds(
    getAddedIds(
      input.before.context.factQueryObligationIds,
      input.after.context.factQueryObligationIds
    ),
    input.outcome.enrolledObligationIds,
    'STRICT_ANALYSIS_RETRY_ENROLLMENT_DIFF_MISMATCH'
  );
  assertSameIds(
    getAddedIds(input.before.terminalObligationIds, input.after.terminalObligationIds),
    input.outcome.executedObligationIds,
    'STRICT_ANALYSIS_RETRY_TERMINAL_DIFF_MISMATCH'
  );
  assertSameIds(
    input.before.outstandingObligationIds,
    input.after.outstandingObligationIds,
    'STRICT_ANALYSIS_RETRY_OUTSTANDING_MUTATED'
  );
  for (const obligationId of input.outcome.enrolledObligationIds) {
    if (
      input.before.context.factQueryObligationIds.includes(obligationId) ||
      !input.after.context.factQueryObligationIds.includes(obligationId)
    ) {
      fail('STRICT_ANALYSIS_RETRY_ENROLLMENT_NOT_APPENDED', obligationId);
    }
    if (!input.after.terminalObligationIds.includes(obligationId)) {
      fail('STRICT_ANALYSIS_RETRY_EXECUTION_NOT_TERMINAL', obligationId);
    }
  }
}

function validateStrictAnalysisPassTransition(input: {
  readonly before: StrictAnalysisEpochSnapshotV1;
  readonly after: StrictAnalysisEpochSnapshotV1;
}): void {
  if (input.after.epoch !== input.before.epoch) {
    fail('STRICT_ANALYSIS_PASS_EPOCH_CHANGED');
  }
  if (
    input.before.outstandingObligationIds.length > 0 ||
    input.after.outstandingObligationIds.length > 0
  ) {
    fail('STRICT_ANALYSIS_FIXPOINT_OBLIGATION_OUTSTANDING');
  }
  for (const field of [
    'factQueryObligationIds',
    'factIds',
    'witnessIds',
    'populationHashes',
  ] as const) {
    assertSameIds(
      input.before.context[field],
      input.after.context[field],
      `STRICT_ANALYSIS_PASS_${field.toUpperCase()}_MUTATED`
    );
  }
  assertSameIds(
    input.before.terminalObligationIds,
    input.after.terminalObligationIds,
    'STRICT_ANALYSIS_PASS_TERMINAL_OBLIGATIONS_MUTATED'
  );
  if (
    input.before.context.currentExpandedScheduleHash !==
    input.after.context.currentExpandedScheduleHash
  ) {
    fail('STRICT_ANALYSIS_PASS_SCHEDULE_MUTATED');
  }
  if (!input.after.context.finalExpandedScheduleHash || !input.after.context.analysisFixpointHash) {
    fail('STRICT_ANALYSIS_FIXPOINT_SEAL_REQUIRED');
  }
}

function summarizeStrictAnalysisEpoch(
  snapshot: StrictAnalysisEpochSnapshotV1
): StrictAnalysisEpochSummaryV1 {
  return {
    epoch: snapshot.epoch,
    snapshotHash: snapshot.snapshotHash,
    contextHash: snapshot.context.contextHash,
    currentExpandedScheduleHash: snapshot.context.currentExpandedScheduleHash,
    finalExpandedScheduleHash: snapshot.context.finalExpandedScheduleHash,
    analysisFixpointHash: snapshot.context.analysisFixpointHash,
    factQueryObligationIds: snapshot.context.factQueryObligationIds,
    factIds: snapshot.context.factIds,
    witnessIds: snapshot.context.witnessIds,
    populationHashes: snapshot.context.populationHashes,
    terminalObligationIds: snapshot.terminalObligationIds,
    outstandingObligationIds: snapshot.outstandingObligationIds,
  };
}

function assertAppendOnlyIds(
  before: readonly string[],
  after: readonly string[],
  code: string
): void {
  const afterSet = new Set(after);
  if (before.some((value) => !afterSet.has(value))) {
    fail(code);
  }
}

function getAddedIds(before: readonly string[], after: readonly string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((value) => !beforeSet.has(value));
}

export function assertStrictContextIntegrity(context: StrictAnalysisContextProjectionV1): void {
  const { schemaVersion, contextHash, ...input } = context;
  if (schemaVersion !== 1) {
    fail('STRICT_PRODUCER_LINEAGE_CONTEXT_VERSION_MISMATCH');
  }
  const rebuilt = createStrictAnalysisContextProjectionV1(input);
  if (rebuilt.contextHash !== contextHash) {
    fail('STRICT_PRODUCER_LINEAGE_CONTEXT_HASH_MISMATCH');
  }
}
