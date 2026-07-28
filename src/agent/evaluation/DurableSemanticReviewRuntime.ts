import { type KeyObject, randomUUID } from 'node:crypto';
import {
  createAgentSemanticDispositionReviewDurableGatewayV5,
  createStrictEvidenceLedgerSnapshotV1,
  type SemanticDispositionReviewAgentReviewerHostAdapterV5,
  type SemanticDispositionReviewDurableGatewayV5,
  type SemanticDispositionReviewEvidenceStoreLoadCallV5,
  type StrictEvidenceLedgerSnapshotV1,
  type StrictFactDirectWitnessBindingV1,
} from '@alembic/core/host-agent-workflows';
import type { EvidenceEntry } from '@alembic/core/knowledge';
import {
  assertSemanticDispositionReviewRequestV1,
  type FactQueryExecutionReceiptV1,
  type SemanticDispositionReviewDurableAttestationV5,
  type SemanticDispositionReviewEvidenceV1,
  type SemanticDispositionReviewExecutionReceiptBindingV3,
  type SemanticDispositionReviewerModelLoadReceiptV1,
  type SemanticDispositionReviewHarvestGroupV4,
  type SemanticDispositionReviewRequestV1,
  type SemanticDispositionReviewTrustPolicyV3,
} from '@alembic/core/production';
import type { AiProvider, ChatWithToolsResult } from '../../ai/AiProvider.js';
import {
  type ProductionEvidenceLedgerReadFacetV1,
  resolveProductionEvidenceLedgerReadBinding,
} from '../evidence/ProductionEvidenceLedgerAuthority.js';
import type { DiagnosticsCollector } from '../runtime/DiagnosticsCollector.js';

const RUNTIME_STAGE = 'durable-semantic-review';
const EXECUTE_INPUT_FIELDS = new Set(['abortSignal', 'semanticRequest']);

export type DurableSemanticReviewRuntimeErrorCode =
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_BOOTSTRAP_INVALID'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_SIGNING_KEY_FAILED'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_FIELDS_INVALID'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_INVALID'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_CONCURRENT'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_REVIEWER_LOAD_MISMATCH'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_NOT_FOUND'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_SNAPSHOT_INVALID'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_EXECUTION_MISMATCH'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_PROVIDER_FAILED'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_PERMISSION_DENIED'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_OUTPUT_INVALID'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_NOT_INDEPENDENT'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_EXECUTION_REUSED'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_CANCELLED'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_TIMEOUT'
  | 'ALEMBIC_AGENT_SEMANTIC_REVIEW_FAILED';

export class DurableSemanticReviewRuntimeError extends Error {
  readonly code: DurableSemanticReviewRuntimeErrorCode;
  override readonly cause?: unknown;

  constructor(
    code: DurableSemanticReviewRuntimeErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {}
  ) {
    super(`${code}: ${message}`);
    this.name = 'DurableSemanticReviewRuntimeError';
    this.code = code;
    this.cause = options.cause;
  }
}

export interface SemanticReviewSigningKeyProviderV1 {
  readonly trustRootId: string;
  readonly keyId: string;
  loadPrivateKey(): Promise<KeyObject>;
}

export type SemanticReviewProviderV1 = Pick<AiProvider, 'name' | 'model' | 'chatWithTools'>;

/**
 * Durable review 只消费 Agent production factory 生成的不可伪造只读 facet。
 *
 * EvidenceLedgerStore 仍是私有实现；调用方不能以结构相同的 adapter 替换真实持久化
 * authority，也不能自行指定 Core trust policy 中的 store id/config hash。
 */
export interface SemanticReviewWitnessAuthorityLookupV1 {
  readonly evidenceEntryId: string;
  readonly evidenceSessionId: string;
  readonly expectedHarvestGroups: readonly SemanticDispositionReviewHarvestGroupV4[];
  readonly witnessBindingHash: string;
  readonly projectContextRefId: string;
  readonly sourceRevisionVectorHash: string;
  readonly canonicalSubjectRef: string;
  readonly relativePath: string;
  readonly blobHash: string;
  readonly abortSignal: AbortSignal;
}

export interface SemanticReviewWitnessAuthorityBundleV1 {
  readonly evidenceLedgerSnapshot: StrictEvidenceLedgerSnapshotV1;
  readonly witnessBinding: StrictFactDirectWitnessBindingV1;
}

export interface SemanticReviewWitnessAuthorityPortV1 {
  resolve(
    input: SemanticReviewWitnessAuthorityLookupV1
  ): Promise<SemanticReviewWitnessAuthorityBundleV1 | null>;
}

export interface DurableSemanticReviewRuntimeBootstrapV1 {
  readonly signingKey: SemanticReviewSigningKeyProviderV1;
  readonly reviewer: {
    readonly provider: SemanticReviewProviderV1;
    readonly modelLoadReceipt: SemanticDispositionReviewerModelLoadReceiptV1;
    readonly evaluatorRunId: string;
    readonly createInvocationId?: () => string;
    readonly maxTokens?: number;
  };
  readonly evidence: {
    readonly ledger: ProductionEvidenceLedgerReadFacetV1;
    readonly witnessAuthority: SemanticReviewWitnessAuthorityPortV1;
  };
  readonly timeoutMs: number;
  readonly diagnostics?: DiagnosticsCollector;
}

export interface DurableSemanticReviewExecuteInputV1 {
  readonly semanticRequest: SemanticDispositionReviewRequestV1;
  readonly abortSignal?: AbortSignal;
}

interface ExecutionContext {
  readonly semanticRequest: SemanticDispositionReviewRequestV1;
  readonly authoritativeLedgerEntries: ReadonlyMap<string, EvidenceEntry>;
  readonly abortSignal: AbortSignal;
  readonly cleanup: () => void;
  loadOrdinal: number;
  termination: 'active' | 'cancelled' | 'timeout';
}

interface RuntimeState {
  readonly contexts: Map<string, ExecutionContext>;
  readonly reviewer: DurableSemanticReviewRuntimeBootstrapV1['reviewer'];
  readonly evidence: DurableSemanticReviewRuntimeBootstrapV1['evidence'];
  readonly diagnostics?: DiagnosticsCollector;
}

export interface DurableSemanticReviewRuntimeV1 {
  readonly trustPolicy: SemanticDispositionReviewTrustPolicyV3;
  execute(
    input: DurableSemanticReviewExecuteInputV1
  ): Promise<SemanticDispositionReviewDurableAttestationV5>;
}

/**
 * 绑定完成后的 private production service。私钥、provider、model-load receipt、ledger 与
 * witness authority 只在 trusted bootstrap factory 出现；公共 facade 只暴露 factory
 * 与只读 runtime contract，不泄露 Core mint gateway 或内部 state 的构造入口。
 */
class DurableSemanticReviewRuntimeService implements DurableSemanticReviewRuntimeV1 {
  readonly trustPolicy: SemanticDispositionReviewTrustPolicyV3;
  readonly #gateway: SemanticDispositionReviewDurableGatewayV5;
  readonly #state: RuntimeState;
  readonly #timeoutMs: number;

  constructor(input: {
    readonly gateway: SemanticDispositionReviewDurableGatewayV5;
    readonly state: RuntimeState;
    readonly timeoutMs: number;
  }) {
    this.#gateway = input.gateway;
    this.#state = input.state;
    this.#timeoutMs = input.timeoutMs;
    this.trustPolicy = input.gateway.trustPolicy;
  }

  async execute(
    input: DurableSemanticReviewExecuteInputV1
  ): Promise<SemanticDispositionReviewDurableAttestationV5> {
    assertExecuteInput(input);
    try {
      assertSemanticDispositionReviewRequestV1(input.semanticRequest);
    } catch (err: unknown) {
      throw runtimeError(
        'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_INVALID',
        'Core rejected the semantic review request.',
        err
      );
    }
    assertReviewerLoadBinding(input.semanticRequest, this.#state.reviewer);
    if (this.#state.contexts.has(input.semanticRequest.requestHash)) {
      throw runtimeError(
        'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_CONCURRENT',
        `request ${input.semanticRequest.requestId} is already executing`
      );
    }

    const cancellation = createCancellation(input.abortSignal, this.#timeoutMs);
    let authoritativeLedgerEntries: ReadonlyMap<string, EvidenceEntry>;
    try {
      const currentSnapshot = this.#state.evidence.ledger.strictSnapshot();
      const rebuiltSnapshot = createStrictEvidenceLedgerSnapshotV1(currentSnapshot.entries);
      if (
        currentSnapshot.complete !== true ||
        currentSnapshot.truncated !== false ||
        currentSnapshot.continuation !== null ||
        currentSnapshot.snapshotHash !== rebuiltSnapshot.snapshotHash
      ) {
        throw new Error('ALEMBIC_AGENT_EVIDENCE_LEDGER_SNAPSHOT_REBOUND');
      }
      authoritativeLedgerEntries = new Map(
        currentSnapshot.entries.map((entry) => [evidenceKey(entry), entry])
      );
    } catch (err: unknown) {
      cancellation.cleanup();
      throw runtimeError(
        'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_SNAPSHOT_INVALID',
        'The production Evidence Ledger authority cannot produce a complete strict snapshot.',
        err
      );
    }
    const context: ExecutionContext = {
      semanticRequest: input.semanticRequest,
      authoritativeLedgerEntries,
      abortSignal: cancellation.abortSignal,
      cleanup: cancellation.cleanup,
      loadOrdinal: 0,
      termination: cancellation.termination(),
    };
    cancellation.onTermination((termination) => {
      context.termination = termination;
    });
    this.#state.contexts.set(input.semanticRequest.requestHash, context);

    try {
      throwIfAborted(context);
      return await raceWithAbort(this.#gateway.execute(input.semanticRequest), context.abortSignal);
    } catch (err: unknown) {
      throw classifyRuntimeFailure(err, context, this.#state.diagnostics);
    } finally {
      this.#state.contexts.delete(input.semanticRequest.requestHash);
      context.cleanup();
    }
  }
}

export async function createDurableSemanticReviewRuntime(
  input: DurableSemanticReviewRuntimeBootstrapV1
): Promise<DurableSemanticReviewRuntimeV1> {
  validateBootstrap(input);
  const ledgerBinding = resolveProductionEvidenceLedgerReadBinding(input.evidence.ledger);
  if (!ledgerBinding) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_BOOTSTRAP_INVALID',
      'Evidence Ledger read authority was not created by the Agent production factory.'
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = await input.signingKey.loadPrivateKey();
  } catch (err: unknown) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_SIGNING_KEY_FAILED',
      'Trusted key custody failed to load the Ed25519 private key.',
      err
    );
  }

  const state: RuntimeState = {
    contexts: new Map(),
    reviewer: {
      ...input.reviewer,
      createInvocationId: input.reviewer.createInvocationId ?? (() => randomUUID()),
    },
    evidence: input.evidence,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  };
  let gateway: SemanticDispositionReviewDurableGatewayV5;
  try {
    gateway = createAgentSemanticDispositionReviewDurableGatewayV5({
      trustRootId: input.signingKey.trustRootId,
      keyId: input.signingKey.keyId,
      privateKey,
      reviewerHost: {
        reviewerModelLoadReceipt: input.reviewer.modelLoadReceipt,
        invoke: async (call) => invokeReviewer(state, call),
      },
      evidenceStore: {
        evidenceStoreId: ledgerBinding.identity.storeId,
        evidenceStoreConfigHash: ledgerBinding.identity.storeConfigHash,
        load: async (call) => loadEvidenceAuthority(state, call),
      },
    });
  } catch (err: unknown) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_BOOTSTRAP_INVALID',
      'Core rejected the trusted durable semantic-review bootstrap.',
      err
    );
  }
  return new DurableSemanticReviewRuntimeService({
    gateway,
    state,
    timeoutMs: input.timeoutMs,
  });
}

async function invokeReviewer(
  state: RuntimeState,
  call: Parameters<SemanticDispositionReviewAgentReviewerHostAdapterV5['invoke']>[0]
) {
  const context = requireExecutionContext(state, call.request.semanticRequest);
  throwIfAborted(context);
  let result: ChatWithToolsResult;
  try {
    result = await raceWithAbort(
      state.reviewer.provider.chatWithTools(call.compiledPrompt, {
        toolSchemas: [],
        toolChoice: 'none',
        temperature: 0,
        maxTokens: state.reviewer.maxTokens ?? 8_192,
        abortSignal: context.abortSignal,
      }),
      context.abortSignal
    );
  } catch (err: unknown) {
    if (context.abortSignal.aborted) {
      throw err;
    }
    const code = isPermissionFailure(err)
      ? 'ALEMBIC_AGENT_SEMANTIC_REVIEW_PERMISSION_DENIED'
      : 'ALEMBIC_AGENT_SEMANTIC_REVIEW_PROVIDER_FAILED';
    state.diagnostics?.recordAiError(errorMessage(err));
    throw runtimeError(code, 'Independent reviewer provider invocation failed.', err);
  }
  if (
    !result ||
    typeof result !== 'object' ||
    typeof result.text !== 'string' ||
    result.text.trim().length === 0 ||
    (result.functionCalls?.length ?? 0) > 0 ||
    isPartialFinishReason(result.finishReason)
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_OUTPUT_INVALID',
      'Reviewer returned an empty, tool-bearing, or partial response.'
    );
  }
  return {
    evaluatorRunId: state.reviewer.evaluatorRunId,
    invocationId: state.reviewer.createInvocationId?.() ?? randomUUID(),
    responseOutput: result.text,
    status: 'success' as const,
    toolCallCount: 0 as const,
  };
}

async function loadEvidenceAuthority(
  state: RuntimeState,
  call: SemanticDispositionReviewEvidenceStoreLoadCallV5
) {
  const context = requireExecutionContext(state, call.semanticRequest);
  throwIfAborted(context);
  const evidenceEntry = state.evidence.ledger.get(call.evidence.evidenceEntryId);
  if (!evidenceEntry || !evidenceEntryMatches(evidenceEntry, call.evidence)) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_NOT_FOUND',
      `Production Evidence Ledger does not contain exact ${call.evidence.evidenceSessionId}/${call.evidence.evidenceEntryId}.`
    );
  }
  const bindingSet = validateExpectedHarvestGroups(call);
  const witnessBindingHash = bindingSet.witnessBindingHash;
  const projectContextRefId = bindingSet.projectContextRefId;
  if (!witnessBindingHash || !projectContextRefId) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_EXECUTION_MISMATCH',
      'Selected file execution is missing witness or ProjectContext authority.'
    );
  }
  let witnessAuthority: SemanticReviewWitnessAuthorityBundleV1 | null;
  try {
    witnessAuthority = await raceWithAbort(
      state.evidence.witnessAuthority.resolve({
        evidenceEntryId: evidenceEntry.id,
        evidenceSessionId: evidenceEntry.sessionId,
        expectedHarvestGroups: call.expectedHarvestGroups,
        witnessBindingHash,
        projectContextRefId,
        sourceRevisionVectorHash: bindingSet.sourceRevisionVectorHash,
        canonicalSubjectRef: bindingSet.canonicalSubjectRef,
        relativePath: bindingSet.relativePath,
        blobHash: bindingSet.blobHash,
        abortSignal: context.abortSignal,
      }),
      context.abortSignal
    );
  } catch (err: unknown) {
    if (context.abortSignal.aborted) {
      throw err;
    }
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
      'Trusted witness authority lookup failed.',
      err
    );
  }
  if (!witnessAuthority) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
      'Trusted witness authority did not return an exact snapshot/binding/receipt bundle.'
    );
  }
  const evidenceLedgerSnapshot = validateWitnessAuthorityBundle(
    witnessAuthority,
    context.authoritativeLedgerEntries,
    evidenceEntry,
    bindingSet
  );
  const witnessBinding = witnessAuthority.witnessBinding;
  if (
    witnessBinding.bindingHash !== witnessBindingHash ||
    witnessBinding.evidenceEntryId !== evidenceEntry.id ||
    witnessBinding.evidenceSessionId !== evidenceEntry.sessionId ||
    witnessBinding.evidenceLedgerSnapshotHash !== evidenceLedgerSnapshot.snapshotHash ||
    witnessBinding.projectContextRefId !== projectContextRefId ||
    witnessBinding.sourceRevisionVectorHash !== bindingSet.sourceRevisionVectorHash ||
    witnessBinding.relativePath !== bindingSet.relativePath ||
    witnessBinding.blobHash !== bindingSet.blobHash
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
      'Trusted witness binding does not match the selected ledger/execution coordinates.'
    );
  }
  context.loadOrdinal += 1;
  return {
    loadOperationId: `${state.reviewer.evaluatorRunId}:evidence-load:${call.semanticRequest.requestId}:${context.loadOrdinal}`,
    evidenceEntry,
    evidenceLedgerSnapshot,
    witnessBinding,
    semanticRole: call.evidence.semanticRole,
  };
}

function validateWitnessAuthorityBundle(
  bundle: SemanticReviewWitnessAuthorityBundleV1,
  authoritativeLedgerEntries: ReadonlyMap<string, EvidenceEntry>,
  evidenceEntry: EvidenceEntry,
  bindingSet: {
    readonly relativePath: string;
    readonly blobHash: string;
    readonly sourceRevisionVectorHash: string;
  }
): StrictEvidenceLedgerSnapshotV1 {
  const untrustedBundle = bundle as Partial<SemanticReviewWitnessAuthorityBundleV1>;
  if (!untrustedBundle.evidenceLedgerSnapshot || !untrustedBundle.witnessBinding) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
      'Trusted witness authority returned an incomplete authority bundle.'
    );
  }
  let rebuiltSnapshot: StrictEvidenceLedgerSnapshotV1;
  try {
    rebuiltSnapshot = createStrictEvidenceLedgerSnapshotV1(bundle.evidenceLedgerSnapshot.entries);
  } catch (err: unknown) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
      'Trusted witness authority returned an invalid frozen ledger snapshot.',
      err
    );
  }
  if (
    bundle.evidenceLedgerSnapshot.complete !== true ||
    bundle.evidenceLedgerSnapshot.truncated !== false ||
    bundle.evidenceLedgerSnapshot.continuation !== null ||
    rebuiltSnapshot.snapshotHash !== bundle.evidenceLedgerSnapshot.snapshotHash ||
    rebuiltSnapshot.entries.some((entry) => {
      const current = authoritativeLedgerEntries.get(evidenceKey(entry));
      return !current || !sameEvidenceEntry(current, entry);
    }) ||
    !rebuiltSnapshot.entries.some((entry) => sameEvidenceEntry(entry, evidenceEntry)) ||
    bundle.witnessBinding.sourceRevisionVectorHash !== bindingSet.sourceRevisionVectorHash ||
    bundle.witnessBinding.relativePath !== bindingSet.relativePath ||
    bundle.witnessBinding.blobHash !== bindingSet.blobHash
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
      'Frozen witness snapshot is not an exact historical subset of the authoritative ledger.'
    );
  }
  return rebuiltSnapshot;
}

function evidenceKey(entry: EvidenceEntry): string {
  return `${entry.sessionId}\u0000${entry.id}`;
}

function sameEvidenceEntry(left: EvidenceEntry, right: EvidenceEntry): boolean {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.dimensionId === right.dimensionId &&
    left.tool === right.tool &&
    left.callId === right.callId &&
    left.file === right.file &&
    left.range?.start === right.range?.start &&
    left.range?.end === right.range?.end &&
    left.content === right.content &&
    left.contentHash === right.contentHash &&
    left.capturedAt === right.capturedAt
  );
}

interface ValidatedHarvestGroupSet {
  readonly sourceRevisionVectorHash: string;
  readonly canonicalSubjectRef: string;
  readonly witnessBindingHash: string;
  readonly projectContextRefId: string;
  readonly relativePath: string;
  readonly blobHash: string;
}

interface ResolvedExecutionReceiptBinding {
  readonly group: SemanticDispositionReviewHarvestGroupV4;
  readonly binding: SemanticDispositionReviewExecutionReceiptBindingV3;
  readonly fileExecution: FactQueryExecutionReceiptV1['fileExecutions'][number];
}

function validateExpectedHarvestGroups(
  call: SemanticDispositionReviewEvidenceStoreLoadCallV5
): ValidatedHarvestGroupSet {
  assertCanonicalExpectedHarvestGroupSet(call.expectedHarvestGroups);
  const receiptsByHash = new Map(
    call.semanticRequest.executionReceipts.map((receipt) => [receipt.receiptHash, receipt] as const)
  );
  const resolved = call.expectedHarvestGroups.flatMap((group) =>
    group.executionReceiptBindings.map((binding) =>
      resolveExpectedExecutionReceiptBinding(group, binding, call.evidence, receiptsByHash)
    )
  );
  const reference = requirePhysicalEvidenceAuthority(resolved);
  if (!reference.fileExecution.witnessBindingHash || !reference.fileExecution.projectContextRefId) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_EXECUTION_MISMATCH',
      'Core expected harvest groups contain a file execution without witness authority.'
    );
  }
  return {
    sourceRevisionVectorHash: reference.binding.sourceRevisionVectorHash,
    canonicalSubjectRef: reference.binding.canonicalSubjectRef,
    witnessBindingHash: reference.fileExecution.witnessBindingHash,
    projectContextRefId: reference.fileExecution.projectContextRefId,
    relativePath: reference.fileExecution.relativePath,
    blobHash: reference.fileExecution.blobHash,
  };
}

function assertCanonicalExpectedHarvestGroupSet(
  groups: readonly SemanticDispositionReviewHarvestGroupV4[]
): void {
  const canonicalGroups = [...groups].sort(
    (left, right) =>
      left.harvestKey.localeCompare(right.harvestKey) ||
      left.harvestReceiptHash.localeCompare(right.harvestReceiptHash) ||
      left.fileExecutionHash.localeCompare(right.fileExecutionHash)
  );
  const bindings = groups.flatMap((group) => group.executionReceiptBindings);
  if (
    groups.length === 0 ||
    new Set(groups.map((group) => group.harvestKey)).size !== groups.length ||
    new Set(groups.map((group) => group.harvestReceiptHash)).size !== groups.length ||
    new Set(groups.map((group) => group.groupHash)).size !== groups.length ||
    groups.some((group, index) => group !== canonicalGroups[index]) ||
    new Set(bindings.map((binding) => binding.obligationId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.executionReceiptHash)).size !== bindings.length
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_EXECUTION_MISMATCH',
      'Core supplied empty, duplicate, overlapping, or non-canonical expected harvest groups.'
    );
  }
  for (const group of groups) {
    assertCanonicalExpectedBindingSet(group.executionReceiptBindings);
    if (
      group.schemaVersion !== 4 ||
      group.executionReceiptBindings.some(
        (binding) =>
          binding.harvestKey !== group.harvestKey ||
          binding.harvestReceiptHash !== group.harvestReceiptHash ||
          binding.sourceRevisionVectorHash !== group.sourceRevisionVectorHash ||
          binding.canonicalSubjectRef !== group.canonicalSubjectRef ||
          binding.fileExecutionHash !== group.fileExecutionHash
      )
    ) {
      throw runtimeError(
        'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_EXECUTION_MISMATCH',
        'Core expected harvest-group coordinates do not match their exact receipt bindings.'
      );
    }
  }
}

function assertCanonicalExpectedBindingSet(
  bindings: readonly SemanticDispositionReviewExecutionReceiptBindingV3[]
): void {
  const canonicalBindingOrder = [...bindings].sort(
    (left, right) =>
      left.obligationId.localeCompare(right.obligationId) ||
      left.executionReceiptHash.localeCompare(right.executionReceiptHash)
  );
  if (
    bindings.length === 0 ||
    new Set(bindings.map((binding) => binding.obligationId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.executionReceiptHash)).size !== bindings.length ||
    bindings.some((binding, index) => binding !== canonicalBindingOrder[index])
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_EXECUTION_MISMATCH',
      'Core supplied an empty, duplicate, or non-canonical expected receipt-binding set.'
    );
  }
}

function resolveExpectedExecutionReceiptBinding(
  group: SemanticDispositionReviewHarvestGroupV4,
  binding: SemanticDispositionReviewExecutionReceiptBindingV3,
  evidence: SemanticDispositionReviewEvidenceV1,
  receiptsByHash: ReadonlyMap<string, FactQueryExecutionReceiptV1>
): ResolvedExecutionReceiptBinding {
  const executionReceipt = receiptsByHash.get(binding.executionReceiptHash);
  const fileExecutions =
    executionReceipt?.fileExecutions.filter((fileExecution) =>
      fileExecutionMatchesEvidenceBinding(fileExecution, binding, evidence)
    ) ?? [];
  if (
    !executionReceipt ||
    fileExecutions.length !== 1 ||
    !executionReceiptMatchesBinding(executionReceipt, binding, evidence) ||
    group.fileExecutionHash !== fileExecutions[0]?.executionHash ||
    !sameStrings(group.emittedFactIds, [...fileExecutions[0].emittedFactIds].sort())
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_EXECUTION_MISMATCH',
      'Core expected receipt binding does not map to one complete accepted file execution.'
    );
  }
  return { group, binding, fileExecution: fileExecutions[0] };
}

function fileExecutionMatchesEvidenceBinding(
  fileExecution: FactQueryExecutionReceiptV1['fileExecutions'][number],
  binding: SemanticDispositionReviewExecutionReceiptBindingV3,
  evidence: SemanticDispositionReviewEvidenceV1
): boolean {
  return (
    fileExecution.executionHash === binding.fileExecutionHash &&
    fileExecution.evidenceEntryId === evidence.evidenceEntryId &&
    fileExecution.relativePath === evidence.relativePath &&
    fileExecution.blobHash === evidence.blobHash &&
    fileExecution.status === 'complete' &&
    fileExecution.truncated === false &&
    fileExecution.continuation === null
  );
}

function executionReceiptMatchesBinding(
  executionReceipt: FactQueryExecutionReceiptV1,
  binding: SemanticDispositionReviewExecutionReceiptBindingV3,
  evidence: SemanticDispositionReviewEvidenceV1
): boolean {
  return (
    executionReceipt.obligationId === binding.obligationId &&
    executionReceipt.analysisScale === binding.analysisScale &&
    executionReceipt.harvestKey === binding.harvestKey &&
    executionReceipt.harvestReceiptHash === binding.harvestReceiptHash &&
    executionReceipt.sourceRevisionVectorHash === binding.sourceRevisionVectorHash &&
    executionReceipt.canonicalSubjectRef === binding.canonicalSubjectRef &&
    binding.sourceRevisionVectorHash === evidence.sourceRevisionVectorHash &&
    binding.canonicalSubjectRef === evidence.canonicalSubjectRef
  );
}

function requirePhysicalEvidenceAuthority(
  resolved: readonly ResolvedExecutionReceiptBinding[]
): ResolvedExecutionReceiptBinding {
  const reference = resolved[0];
  if (
    !reference ||
    resolved.some(
      ({ binding, fileExecution }) =>
        binding.sourceRevisionVectorHash !== reference.binding.sourceRevisionVectorHash ||
        binding.canonicalSubjectRef !== reference.binding.canonicalSubjectRef ||
        fileExecution.witnessBindingHash !== reference.fileExecution.witnessBindingHash ||
        fileExecution.projectContextRefId !== reference.fileExecution.projectContextRefId ||
        fileExecution.relativePath !== reference.fileExecution.relativePath ||
        fileExecution.blobHash !== reference.fileExecution.blobHash
    )
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_EXECUTION_MISMATCH',
      'Core expected harvest groups do not share one physical ledger/witness authority.'
    );
  }
  return reference;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function evidenceEntryMatches(
  entry: EvidenceEntry,
  evidence: SemanticDispositionReviewEvidenceV1
): boolean {
  return (
    entry.id === evidence.evidenceEntryId &&
    entry.sessionId === evidence.evidenceSessionId &&
    entry.tool === 'code.read' &&
    entry.file === evidence.relativePath &&
    entry.content === evidence.content &&
    entry.contentHash === evidence.contentHash
  );
}

function assertExecuteInput(input: DurableSemanticReviewExecuteInputV1): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_FIELDS_INVALID',
      'execute input must be an object'
    );
  }
  const extraFields = Object.keys(input).filter((field) => !EXECUTE_INPUT_FIELDS.has(field));
  if (extraFields.length > 0) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_FIELDS_INVALID',
      `execute input contains forbidden fields: ${extraFields.sort().join(',')}`
    );
  }
  if (
    input.abortSignal !== undefined &&
    (!(input.abortSignal instanceof AbortSignal) || typeof input.abortSignal.aborted !== 'boolean')
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_FIELDS_INVALID',
      'abortSignal is invalid'
    );
  }
}

function assertReviewerLoadBinding(
  request: SemanticDispositionReviewRequestV1,
  reviewer: RuntimeState['reviewer']
): void {
  const requestReceipt = request.calibration.reviewerModelLoadReceipt;
  if (
    reviewer.provider.name !== reviewer.modelLoadReceipt.providerId ||
    reviewer.provider.model !== reviewer.modelLoadReceipt.modelId ||
    !sameReviewerModelLoadReceipt(requestReceipt, reviewer.modelLoadReceipt)
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_REVIEWER_LOAD_MISMATCH',
      'Request/provider reviewer identity does not match the trusted bootstrap load receipt.'
    );
  }
}

function sameReviewerModelLoadReceipt(
  left: SemanticDispositionReviewerModelLoadReceiptV1,
  right: SemanticDispositionReviewerModelLoadReceiptV1
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.modelVersion === right.modelVersion &&
    left.methodId === right.methodId &&
    left.methodVersion === right.methodVersion &&
    left.runtimeConfigHash === right.runtimeConfigHash &&
    left.credentialLocationSymbol === right.credentialLocationSymbol &&
    left.loadReceiptHash === right.loadReceiptHash
  );
}

function validateBootstrap(input: DurableSemanticReviewRuntimeBootstrapV1): void {
  const candidate = input as Partial<DurableSemanticReviewRuntimeBootstrapV1> | null;
  if (
    !candidate ||
    !isValidSigningKeyBootstrap(candidate.signingKey) ||
    !isValidReviewerBootstrap(candidate.reviewer) ||
    !isValidEvidenceBootstrap(candidate.evidence) ||
    !Number.isSafeInteger(candidate.timeoutMs) ||
    (candidate.timeoutMs ?? 0) <= 0
  ) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_BOOTSTRAP_INVALID',
      'Trusted runtime bootstrap is incomplete or invalid.'
    );
  }
}

function isValidSigningKeyBootstrap(
  input: DurableSemanticReviewRuntimeBootstrapV1['signingKey'] | undefined
): boolean {
  return (
    isNonEmptyString(input?.trustRootId) &&
    isNonEmptyString(input?.keyId) &&
    typeof input?.loadPrivateKey === 'function'
  );
}

function isValidReviewerBootstrap(
  input: DurableSemanticReviewRuntimeBootstrapV1['reviewer'] | undefined
): boolean {
  return (
    isNonEmptyString(input?.provider?.name) &&
    isNonEmptyString(input?.provider?.model) &&
    typeof input?.provider?.chatWithTools === 'function' &&
    isNonEmptyString(input?.evaluatorRunId) &&
    (input?.createInvocationId === undefined || typeof input.createInvocationId === 'function') &&
    (input?.maxTokens === undefined ||
      (Number.isSafeInteger(input.maxTokens) && input.maxTokens > 0))
  );
}

function isValidEvidenceBootstrap(
  input: DurableSemanticReviewRuntimeBootstrapV1['evidence'] | undefined
): boolean {
  const binding = resolveProductionEvidenceLedgerReadBinding(input?.ledger);
  return (
    binding !== null &&
    input?.ledger.identity === binding.identity &&
    Object.keys(input).sort().join(',') === 'ledger,witnessAuthority' &&
    typeof input?.witnessAuthority?.resolve === 'function'
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireExecutionContext(
  state: RuntimeState,
  semanticRequest: SemanticDispositionReviewRequestV1
): ExecutionContext {
  const context = state.contexts.get(semanticRequest.requestHash);
  if (!context || context.semanticRequest !== semanticRequest) {
    throw runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_REQUEST_INVALID',
      'Core gateway called an unregistered semantic request.'
    );
  }
  return context;
}

function createCancellation(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): {
  readonly abortSignal: AbortSignal;
  readonly cleanup: () => void;
  readonly termination: () => ExecutionContext['termination'];
  readonly onTermination: (listener: (value: ExecutionContext['termination']) => void) => void;
} {
  const controller = new AbortController();
  let termination: ExecutionContext['termination'] = 'active';
  let listener: ((value: ExecutionContext['termination']) => void) | null = null;
  const update = (value: ExecutionContext['termination'], reason: unknown) => {
    if (termination !== 'active') {
      return;
    }
    termination = value;
    listener?.(value);
    controller.abort(reason);
  };
  const onParentAbort = () =>
    update('cancelled', parentSignal?.reason ?? new Error('semantic review cancelled'));
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => update('timeout', new Error('semantic review timed out')),
    timeoutMs
  );
  return {
    abortSignal: controller.signal,
    termination: () => termination,
    onTermination: (nextListener) => {
      listener = nextListener;
      if (termination !== 'active') {
        listener(termination);
      }
    },
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
      listener = null;
    },
  };
}

function throwIfAborted(context: ExecutionContext): void {
  if (context.abortSignal.aborted) {
    throw context.abortSignal.reason ?? new Error('semantic review aborted');
  }
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw signal.reason ?? new Error('semantic review aborted');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('semantic review aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function classifyRuntimeFailure(
  err: unknown,
  context: ExecutionContext,
  diagnostics?: DiagnosticsCollector
): DurableSemanticReviewRuntimeError {
  if (context.termination === 'timeout') {
    diagnostics?.recordTimedOutStage(RUNTIME_STAGE);
    diagnostics?.recordCancelReason('durable-semantic-review-timeout');
    return runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_TIMEOUT',
      'Durable semantic review exceeded its trusted timeout.',
      err
    );
  }
  if (context.termination === 'cancelled') {
    diagnostics?.recordCancelReason('durable-semantic-review-cancelled');
    return runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_CANCELLED',
      'Durable semantic review was cancelled.',
      err
    );
  }
  if (err instanceof DurableSemanticReviewRuntimeError) {
    return err;
  }
  const message = errorMessage(err);
  if (message.includes('SEMANTIC_DISPOSITION_REVIEW_HOST_LOAD_MISMATCH')) {
    return runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_REVIEWER_LOAD_MISMATCH',
      'Core rejected the trusted reviewer load lineage.',
      err
    );
  }
  if (message.includes('KNOWLEDGE_DISPOSITION_REVIEW_NOT_INDEPENDENT')) {
    return runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_NOT_INDEPENDENT',
      'Core rejected producer self-review.',
      err
    );
  }
  if (message.includes('SEMANTIC_DISPOSITION_REVIEW_HOST_EXECUTION_REUSED')) {
    return runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EXECUTION_REUSED',
      'Core rejected a reused reviewer invocation or output.',
      err
    );
  }
  if (
    message.includes('SEMANTIC_DISPOSITION_REVIEW_OUTPUT_') ||
    message.includes('SEMANTIC_DISPOSITION_REVIEW_HOST_RESULT_INVALID') ||
    message.includes('SEMANTIC_DISPOSITION_REVIEW_DECISION_') ||
    message.includes('SEMANTIC_DISPOSITION_REVIEW_RESULT_SEMANTICS_REQUIRED')
  ) {
    return runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_OUTPUT_INVALID',
      'Core rejected the raw reviewer response.',
      err
    );
  }
  if (
    message.includes('SEMANTIC_DISPOSITION_REVIEW_EVIDENCE_') ||
    message.includes('STRICT_FACT_EVIDENCE_LEDGER_') ||
    message.includes('FACT_QUERY_EXECUTION_') ||
    message.includes('KNOWLEDGE_DISPOSITION_EXECUTION_NONTERMINAL')
  ) {
    return runtimeError(
      'ALEMBIC_AGENT_SEMANTIC_REVIEW_EVIDENCE_AUTHORITY_INVALID',
      'Core rejected the frozen Evidence Ledger authority.',
      err
    );
  }
  return runtimeError(
    'ALEMBIC_AGENT_SEMANTIC_REVIEW_FAILED',
    'Durable semantic review failed closed.',
    err
  );
}

function runtimeError(
  code: DurableSemanticReviewRuntimeErrorCode,
  message: string,
  cause?: unknown
): DurableSemanticReviewRuntimeError {
  return new DurableSemanticReviewRuntimeError(code, message, { cause });
}

function isPermissionFailure(err: unknown): boolean {
  const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : ({} as const);
  const code = String(record.code ?? record.status ?? '');
  const message = errorMessage(err);
  return (
    ['401', '403', 'API_KEY_MISSING', 'PERMISSION_DENIED'].includes(code) ||
    /permission denied|forbidden|unauthorized/iu.test(message)
  );
}

function isPartialFinishReason(reason: string | null | undefined): boolean {
  if (!reason) {
    return false;
  }
  return !['stop', 'stop_sequence', 'end_turn'].includes(reason.toLowerCase());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
