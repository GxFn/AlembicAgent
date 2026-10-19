import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { resolveModelQuirks } from '#ai/registry/ModelQuirks.js';
import type { ToolResultEnvelope } from '#tools/kernel/index.js';
import type { EvidenceLedgerStore } from '../evidence/EvidenceLedgerStore.js';
import {
  failedReadPaths,
  readToolObservation,
  successfulReadPaths,
} from '../utils/toolOutcomes.js';
import type { GroundingEnforcement } from './AgentRuntimeTypes.js';
import type { LLMInputAssembly } from './LLMInputAssembly.js';
import type { LoopContext } from './LoopContext.js';

type JsonRecord = Record<string, unknown>;

export interface PcvNodeStageIdentity {
  dimensionId: string | null;
  nodeKind: 'agent-runtime-node';
  pipelinePhase: string | null;
  pipelineType: string | null;
  stageProfile: string | null;
  targetName: string | null;
  trackerPhase: string | null;
}

export interface PcvStageNodeIdentity {
  chainNodeId?: string | null;
  nodeId?: string | null;
  pcvNodeId?: string | null;
  stageNodeId?: string | null;
}

export type PcvStageNodeMap = Record<string, PcvStageNodeIdentity | string | null | undefined>;

export interface ResolvedPcvStageNodeIdentity {
  chainNodeId: string;
  nodeId: string;
}

export interface PcvNodeInputAssemblyEvidence {
  effectiveToolChoice: string | null;
  inputLayerAppended: boolean;
  inputSectionIds: string[];
  messageCount: number;
  modelRef: string | null;
  providerMessageCount: number;
  providerVisibleSectionIds: string[];
  ref: string;
  requestedToolChoice: string | null;
  stageProfile: string;
  staticSectionIds: string[];
  toolSchemaNames: string[];
}

export type PcvBurnGroundingClassification =
  | 'deterministic-evidence-consumed'
  | 'evidence-produced'
  | 'verification-only'
  | 'record-only'
  | 'planning-only'
  | 'invalid-no-evidence'
  | 'summary-only';

export interface PcvBurnGroundingLedgerEntry {
  acceptedFindingDelta: number;
  classification: PcvBurnGroundingClassification;
  consumedEvidenceRefs: string[];
  deepseekV4ToolChoiceMode?: string | null; // provider-name-ok: recorded evidence field key
  deterministicEvidenceRefs: string[];
  effectiveToolChoice: string | null;
  evidenceStarterRefs: string[];
  evidenceToolCallDelta: number;
  functionCallNames: string[];
  iteration: number;
  /**
   * I10 只增字段：被 evidenceContext 预算省略、模型本轮看不到的 deterministicEvidenceRefs 条数。
   * 与 visibleDeterministicEvidenceRefs 成对出现；装配未提供时缺省（表示“未知”，不是“全部可见”）。
   */
  omittedDeterministicEvidenceRefCount?: number;
  outputSourceRefs: string[];
  pipelineType: string | null;
  reasoningTokens: number;
  ref: string;
  rejectedFindingDelta: number;
  requestedToolChoice: string | null;
  stageProfile: string;
  textOutputChars: number;
  toolCallDelta: number;
  toolChoiceSent?: boolean;
  toolChoiceSupported?: boolean;
  toolSchemaNames: string[];
  toolSchemasVisible?: boolean;
  trackerPhase: string | null;
  /**
   * I10 只增字段：本轮 provider 实际可见的 deterministicEvidenceRefs（按条目边界截断后的前缀）。
   * deterministicEvidenceRefs 原字段仍记录完整注入候选列表，含义不变；审计“模型见过哪些 ref”应读本字段。
   */
  visibleDeterministicEvidenceRefs?: string[];
}

/**
 * 观察台账引用：只指向 ActiveContext（权威台账本身），不携带计数快照。
 * I28：旧的 stats 字段只在循环开始时取一次、之后从不刷新，buildResult 返回的永远是开局计数，
 * 且宿主不读它，因此删除；需要计数时直接读 ActiveContext。
 */
export interface PcvNodeLedgerRef {
  kind: 'observation-ledger';
  ref: string;
  source: 'ActiveContext';
}

export interface PcvNodeAcceptedFindingRef {
  callId?: string | null;
  evidence: string[];
  findingSummary: string;
  importance?: number | null;
  origin: 'note_finding' | 'quality_artifact';
  ref: string;
  sourceRefs: string[];
  toolName: string;
}

export interface PcvNodeRejectedFindingRef {
  callId?: string | null;
  evidence?: string[];
  findingSummary?: string;
  origin: 'note_finding';
  reason: string;
  ref: string;
  sourceRefs?: string[];
  toolName: string;
}

export interface PcvSourceRefDiagnostic {
  input: string;
  reason: string;
  status: 'ambiguous' | 'missing';
}

export interface PcvNodeQualityGateEvidence {
  action: string;
  derivedFindingCount?: number;
  findingCount: number;
  memoryFindingCount?: number;
  pass: boolean;
  reason: string | null;
  referencedFileCount: number;
  scores?: Record<string, number>;
  stage: 'quality_gate';
  status: string;
  suggestions?: string[];
  totalScore?: number;
}

export interface PcvNodeRepairEvidence {
  attempted: boolean;
  evidencePaths: string[];
  reason: string | null;
  status: string | null;
}

export interface PcvNodeEvidenceSummary {
  chainNodeId: string;
  correlation: {
    dimensionId: string | null;
    dimensionScopeId: string | null;
    iteration: number;
    modelRef: string | null;
    runId: string | null;
    source: string;
    targetName: string | null;
  };
  findingRefs: {
    accepted: PcvNodeAcceptedFindingRef[];
    rejected: PcvNodeRejectedFindingRef[];
  };
  /**
   * AP-4 additive enforcement-mode 标记：本次运行的 grounding enforcement 有效值（`'off'`=PCV observe-only，
   * `'guard'`=AnalyzeGroundingGuard 生效）。**纯观察、不驱动控流**——供消费方（主体 ai-execution / PCVM）把
   * groundingLedger（classification 等）解读为审计材料而非质量判定：observe-only 下增多的 invalid-no-evidence
   * 是预期、不应误判为回归（R6）。纯 additive：老消费者忽略此字段不受影响（schemaVersion 不变）。
   */
  groundingEnforcement: GroundingEnforcement;
  groundingLedger: PcvBurnGroundingLedgerEntry[];
  inputAssembly: PcvNodeInputAssemblyEvidence | null;
  ledgerRefs: PcvNodeLedgerRef[];
  missingLinkReasons: string[];
  nodeId: string;
  qualityGate: PcvNodeQualityGateEvidence | null;
  repair: PcvNodeRepairEvidence;
  schemaVersion: 1;
  sourceRefDiagnostics: PcvSourceRefDiagnostic[];
  sourceRefs: string[];
  stageIdentity: PcvNodeStageIdentity;
}

export interface PcvNodeEvidenceProcessMetadata {
  acceptedFindingRefs: string[];
  chainNodeId: string;
  correlation: PcvNodeEvidenceSummary['correlation'];
  inputAssemblyRef: string | null;
  groundingLedger: PcvBurnGroundingLedgerEntry[];
  ledgerRefs: string[];
  missingLinkReasons: string[];
  nodeId: string;
  qualityGate: Pick<PcvNodeQualityGateEvidence, 'action' | 'pass' | 'reason' | 'status'> | null;
  rejectedFindingRefs: string[];
  repair: PcvNodeRepairEvidence;
  schemaVersion: 1;
  sourceRefDiagnostics: PcvSourceRefDiagnostic[];
  sourceRefs: string[];
  stageIdentity: PcvNodeStageIdentity;
}

interface FunctionCallLike {
  args?: JsonRecord;
  id?: string;
  name?: string;
}

interface GateLike {
  action?: string;
  pass?: boolean;
  reason?: string;
}

interface QualityReportLike {
  scores?: Record<string, unknown>;
  suggestions?: unknown;
  totalScore?: unknown;
}

interface PcvCanonicalSourceIdentity {
  absolutePath: string | null;
  folderDisplayName: string | null;
  folderId: string | null;
  folderPath: string | null;
  folderRelativeRoot: string | null;
  projectScopeId: string | null;
  qualifiedPath: string;
  relativePath: string | null;
}

interface PcvProjectScopeSourceRefIndex {
  ambiguousBasenames: ReadonlySet<string>;
  byBasename: ReadonlyMap<string, PcvCanonicalSourceIdentity>;
  byQualifiedPath: ReadonlyMap<string, PcvCanonicalSourceIdentity>;
}

interface PcvNormalizedProjectScopeSourceRef {
  normalizedRef: string | null;
  reason: 'ambiguous-basename' | 'not-found' | 'qualified-path' | 'unique-basename';
  status: 'active' | 'ambiguous' | 'missing';
}

const FILE_REF_RE =
  /[\w/.-]+\.(?:go|mod|sum|py|pyi|java|kt|kts|js|jsx|ts|tsx|mjs|cjs|swift|m|h|c|cpp|cc|hpp|cs|rb|rs|sql|json|yaml|yml|toml|xml|html|css|scss|less|sh|md|txt|gradle|properties|proto|vue|svelte|graphql|cfg|conf|ini|env|lock|rst)(?::\d+(?:-\d+)?)?\b/gi;

const MAX_SOURCE_REFS = 80;
const MAX_EVENT_SOURCE_REFS = 24;
const MAX_GROUNDING_LEDGER = 32;
const MAX_EVENT_GROUNDING_LEDGER = 8;
/**
 * I27：sourceRefDiagnostics 的条数上限。长分析运行里每次 code.read 的 import 路径、配置文件名都可能未命中
 * 来源身份索引；不设上限时诊断随运行线性增长，每个进程事件都要全量克隆、规范化并序列化（探针 1200 条约 120KB）。
 * 超出上限的不同诊断只计数，计数以 `dropped-source-ref-diagnostics:<n>` 写进 missingLinkReasons（见下方常量）。
 */
const MAX_SOURCE_REF_DIAGNOSTICS = 64;
/** 进程事件只带摘要诊断的前若干条（与 sourceRefs 80→24 同一思路）；完整的有界列表留在运行结果的摘要里。 */
const MAX_EVENT_SOURCE_REF_DIAGNOSTICS = 16;
/** I27 聚合原因：存在未能解析到项目范围来源身份的引用（逐条明细见 sourceRefDiagnostics）。 */
const UNRESOLVED_SOURCE_REFS_REASON = 'unresolved-source-refs';
/** I27 聚合原因：存在按 basename 无法唯一定位的歧义引用。 */
const AMBIGUOUS_SOURCE_REFS_REASON = 'ambiguous-source-refs';
/**
 * I27 截断计数原因的前缀，后接因上限被丢弃的不同诊断条数。PcvNodeEvidenceSummary 是公开导出类型，
 * 本包不新增公开字段，因此丢弃计数借既有的 missingLinkReasons 承载；每个节点至多一条，随计数原位替换，
 * 也让计数能随摘要序列化保留（反序列化后由 readDroppedSourceRefDiagnosticCount 恢复）。
 */
const DROPPED_SOURCE_REF_DIAGNOSTICS_REASON_PREFIX = 'dropped-source-ref-diagnostics:';
const PCV_SOURCE_REF_INDEX = new WeakMap<PcvNodeEvidenceSummary, PcvProjectScopeSourceRefIndex>();

/** 运行诊断出口：只取 LoopContext.diagnostics 的 warn，避免记录器依赖完整的 DiagnosticsCollector。 */
type PcvDiagnosticSink = Pick<NonNullable<LoopContext['diagnostics']>, 'warn'>;

/**
 * I27：sourceRefDiagnostics 的侧表状态，不进入证据对象本身（证据是公开、可序列化的快照形状）。
 * - keys：见过的诊断键，含已存入和因上限丢弃的，O(1) 去重，并让丢弃计数只统计不同条目；
 * - dropped：因上限丢弃的不同诊断条数；
 * - sink：只有 createPcvNodeEvidence 创建的运行期证据持有运行诊断出口；摘要克隆、质量门证据为 null，退回 Core Logger；
 * - truncationReported / eventTruncationReported：两类截断各只上报一次，避免每个进程事件刷屏。
 */
interface PcvSourceRefDiagnosticState {
  dropped: number;
  eventTruncationReported: boolean;
  keys: Set<string>;
  sink: PcvDiagnosticSink | null;
  truncationReported: boolean;
}

const PCV_SOURCE_REF_DIAGNOSTIC_STATE = new WeakMap<
  PcvNodeEvidenceSummary,
  PcvSourceRefDiagnosticState
>();

export function createPcvNodeEvidence(ctx: LoopContext): PcvNodeEvidenceSummary {
  const dimensionMeta = asRecord(ctx.sharedState?._dimensionMeta);
  const dimensionId = firstStringValue(
    dimensionMeta.id,
    ctx.context?.dimensionId,
    ctx.context?.dimId
  );
  const targetName = firstStringValue(
    dimensionMeta.label,
    dimensionMeta.targetName,
    ctx.context?.targetName
  );
  const dimensionScopeId = firstStringValue(
    ctx.context?.dimensionScopeId,
    ctx.sharedState?._dimensionScopeId,
    dimensionId
  );
  const pipelinePhase = stringValue(ctx.context?.pipelinePhase) || null;
  const trackerPhase = typeof ctx.tracker?.phase === 'string' ? ctx.tracker.phase : null;
  const pipelineType = stringValue(valueAt(ctx.tracker, 'pipelineType')) || null;
  const runId = firstStringValue(ctx.context?.runId, ctx.context?.jobId, ctx.context?.sessionId);
  const mappedIdentity = resolvePcvStageNodeIdentity({
    context: ctx.context,
    pipelinePhase,
    pipelineType,
    sharedState: ctx.sharedState,
    stageProfile: null,
    trackerPhase,
  });
  const stageSlug = pipelinePhase || trackerPhase || 'runtime';
  const scopeSlug = dimensionScopeId || dimensionId || targetName || 'unknown';
  const nodeId =
    firstStringValue(
      mappedIdentity?.nodeId,
      ctx.context?.pcvNodeId,
      ctx.context?.nodeId,
      ctx.context?.stageNodeId
    ) || `agent:${stageSlug}:${scopeSlug}`;
  const chainNodeId =
    firstStringValue(mappedIdentity?.chainNodeId, ctx.context?.chainNodeId) || nodeId;
  const rawRepairEvidencePaths = extractSourceRefsFromValue([
    ctx.context?.recordRepairEvidencePaths,
    ctx.sharedState?._recordRepairEvidencePaths,
  ]);
  const repairAttempted = isPcvRepairAttempted(ctx, pipelinePhase);

  const evidence: PcvNodeEvidenceSummary = {
    chainNodeId,
    correlation: {
      dimensionId,
      dimensionScopeId,
      iteration: ctx.iteration,
      modelRef: null,
      runId,
      source: ctx.source,
      targetName,
    },
    findingRefs: {
      accepted: [],
      rejected: [],
    },
    // AP-4：记录本次运行 grounding enforcement 有效值（AP-3 已解析并挂 LoopContext）作 observe-only 审计标记。
    groundingEnforcement: ctx.groundingEnforcement,
    groundingLedger: [],
    inputAssembly: null,
    ledgerRefs: buildLedgerRefs(ctx, dimensionScopeId),
    missingLinkReasons: [],
    nodeId,
    qualityGate: null,
    repair: {
      attempted: repairAttempted,
      evidencePaths: [],
      reason: stringValue(ctx.context?.recordRepairReason) || null,
      status: repairAttempted ? 'pending' : null,
    },
    schemaVersion: 1,
    sourceRefDiagnostics: [],
    sourceRefs: [],
    stageIdentity: {
      dimensionId,
      nodeKind: 'agent-runtime-node',
      pipelinePhase,
      pipelineType,
      stageProfile: null,
      targetName,
      trackerPhase,
    },
  };
  // 运行期证据持有本次运行的诊断出口，诊断截断可直接进入运行诊断（LoopContext 先设 diagnostics 再建证据）。
  PCV_SOURCE_REF_DIAGNOSTIC_STATE.set(evidence, {
    dropped: 0,
    eventTruncationReported: false,
    keys: new Set<string>(),
    sink: ctx.diagnostics ?? null,
    truncationReported: false,
  });
  attachPcvSourceRefIndex(evidence, ctx.context, ctx.sharedState);
  evidence.repair.evidencePaths = normalizeSourceRefsForEvidence(evidence, rawRepairEvidencePaths);
  probeObservationLedger(ctx, evidence);
  return evidence;
}

function isPcvRepairAttempted(ctx: LoopContext, pipelinePhase: string | null): boolean {
  return (
    ctx.sharedState?._recordRepairOnly === true ||
    ctx.context?.recordRepairOnly === true ||
    Boolean(pipelinePhase?.includes('record_repair'))
  );
}

export function recordPcvInputAssembly(
  evidence: PcvNodeEvidenceSummary,
  assembly: LLMInputAssembly,
  options: {
    deepseekV4ToolChoiceMode?: string | null; // provider-name-ok: recorded evidence field key
    effectiveToolChoice?: string | null;
    iteration?: number;
    modelRef?: string | null;
    requestedToolChoice?: string | null;
  } = {}
): void {
  const toolSchemaNames = (assembly.tools || [])
    .map((schema) => stringValue(schema.name))
    .filter((name): name is string => Boolean(name));
  const inputSectionIds = stringArray(assembly.metadata.inputSectionIds);
  const providerVisibleSectionIds = stringArray(assembly.metadata.providerVisibleSectionIds);
  const staticSectionIds = stringArray(assembly.metadata.staticSectionIds);
  const deterministicEvidenceRefs = stringArray(assembly.metadata.deterministicEvidenceRefs);
  const evidenceStarterRefs = stringArray(assembly.metadata.evidenceStarterRefs);
  // I10：buildLlmInputAssembly 总会给出 provider 实际可见的 ref 与省略数；手工构造或旧形状的装配不带这两个字段，
  // 此时台账不写它们（缺省 = 未知），绝不拿完整列表冒充“可见”。
  const visibleRefsValue = assembly.metadata.visibleDeterministicEvidenceRefs;
  const omittedRefCountValue = assembly.metadata.omittedDeterministicEvidenceRefCount;
  const deterministicRefVisibility: Pick<
    PcvBurnGroundingLedgerEntry,
    'omittedDeterministicEvidenceRefCount' | 'visibleDeterministicEvidenceRefs'
  > =
    Array.isArray(visibleRefsValue) &&
    typeof omittedRefCountValue === 'number' &&
    Number.isFinite(omittedRefCountValue)
      ? {
          omittedDeterministicEvidenceRefCount: Math.max(0, omittedRefCountValue),
          visibleDeterministicEvidenceRefs: stringArray(visibleRefsValue),
        }
      : {};
  const trackerPhase = stringValue(assembly.metadata.trackerPhase);
  const pipelineType = stringValue(assembly.metadata.pipelineType);
  const modelRef = options.modelRef || null;
  const ref = `llm-input:${shortHash({
    chainNodeId: evidence.chainNodeId,
    effectiveToolChoice: options.effectiveToolChoice,
    inputSectionIds,
    iteration: options.iteration ?? evidence.correlation.iteration,
    modelRef,
    providerMessageCount: assembly.providerMessages.length,
    requestedToolChoice: options.requestedToolChoice,
    stageProfile: assembly.stageProfile,
    toolSchemaNames,
  })}`;

  evidence.stageIdentity.stageProfile = assembly.stageProfile;
  evidence.correlation.iteration = options.iteration ?? evidence.correlation.iteration;
  evidence.correlation.modelRef = modelRef;
  evidence.inputAssembly = {
    effectiveToolChoice: options.effectiveToolChoice || null,
    inputLayerAppended: Boolean(assembly.inputLayerMessage),
    inputSectionIds,
    messageCount: assembly.messages.length,
    modelRef,
    providerMessageCount: assembly.providerMessages.length,
    providerVisibleSectionIds,
    ref,
    requestedToolChoice: options.requestedToolChoice || null,
    stageProfile: assembly.stageProfile,
    staticSectionIds,
    toolSchemaNames,
  };
  // P1-B-3：provider 判定收敛到 ModelQuirks；记录字段名 deepseekV4ToolChoiceMode 是既有
  // 证据形状(下游投影按名消费),保名不改。 provider-name-ok: recorded evidence shape
  const forcedToolChoiceQuirk = resolveModelQuirks(modelRef).forcedToolChoiceUnsupported;
  upsertGroundingLedgerEntry(evidence, {
    acceptedFindingDelta: 0,
    classification: assembly.stageProfile === 'summarize' ? 'summary-only' : 'planning-only',
    consumedEvidenceRefs: [],
    // observe-only：mode 由 ProviderToolChoicePolicy 计算并传入，证据层只记录其结果（AP-1 消除 R4 往返）。
    deepseekV4ToolChoiceMode: options.deepseekV4ToolChoiceMode ?? null, // provider-name-ok: recorded evidence field key
    deterministicEvidenceRefs,
    effectiveToolChoice: options.effectiveToolChoice || null,
    evidenceStarterRefs,
    evidenceToolCallDelta: 0,
    functionCallNames: [],
    iteration: options.iteration ?? evidence.correlation.iteration,
    outputSourceRefs: [],
    pipelineType,
    reasoningTokens: 0,
    ref,
    rejectedFindingDelta: 0,
    requestedToolChoice: options.requestedToolChoice || null,
    stageProfile: assembly.stageProfile,
    textOutputChars: 0,
    toolCallDelta: 0,
    toolChoiceSent: forcedToolChoiceQuirk ? false : Boolean(options.effectiveToolChoice),
    toolChoiceSupported: forcedToolChoiceQuirk ? false : undefined,
    toolSchemaNames,
    toolSchemasVisible: forcedToolChoiceQuirk ? toolSchemaNames.length > 0 : undefined,
    trackerPhase,
    ...deterministicRefVisibility,
  });
}

export function recordPcvLlmOutput(
  evidence: PcvNodeEvidenceSummary,
  options: {
    functionCalls?: FunctionCallLike[] | null;
    reasoningTokens?: number | null;
    text?: string | null;
  }
): PcvBurnGroundingLedgerEntry | null {
  const entry = getLatestGroundingEntry(evidence);
  if (!entry) {
    return null;
  }
  const text = options.text || '';
  const outputSourceRefs = extractSourceRefsFromValue(text);
  const consumedEvidenceRefs = collectConsumedEvidenceRefs(text, [
    ...entry.deterministicEvidenceRefs,
    ...entry.evidenceStarterRefs,
  ]);
  const functionCalls = options.functionCalls || [];
  const functionCallNames = functionCalls
    .map((call) => stringValue(call.name))
    .filter((name): name is string => Boolean(name));

  entry.textOutputChars = text.length;
  entry.reasoningTokens = Math.max(0, Number(options.reasoningTokens || 0));
  entry.outputSourceRefs = uniqueStrings(
    normalizeSourceRefsForEvidence(evidence, outputSourceRefs)
  ).slice(0, MAX_SOURCE_REFS);
  entry.consumedEvidenceRefs = uniqueStrings(consumedEvidenceRefs).slice(0, MAX_SOURCE_REFS);
  entry.functionCallNames = uniqueStrings(functionCallNames).slice(0, 24);
  // outputSourceRefs 只作为后续审计材料，不作为 grounding 成功指标。
  // 之前 AI 把 sourceRefDelta 当成阶段进展，导致 sourceRef 伪指标反复扩张和重大资源浪费。
  entry.classification = classifyGroundingEntry(entry, {
    hasFunctionCalls: functionCalls.length > 0,
  });
  return entry;
}

export function recordPcvToolRoundOutcome(
  evidence: PcvNodeEvidenceSummary,
  options: {
    acceptedFindingDelta?: number;
    evidenceToolCallDelta?: number;
    rejectedFindingDelta?: number;
    toolCallDelta?: number;
  }
): PcvBurnGroundingLedgerEntry | null {
  const entry = getLatestGroundingEntry(evidence);
  if (!entry) {
    return null;
  }
  entry.toolCallDelta += options.toolCallDelta || 0;
  entry.evidenceToolCallDelta += options.evidenceToolCallDelta || 0;
  entry.acceptedFindingDelta += options.acceptedFindingDelta || 0;
  entry.rejectedFindingDelta += options.rejectedFindingDelta || 0;
  entry.classification = classifyGroundingEntry(entry, {
    hasFunctionCalls: entry.toolCallDelta > 0 || entry.functionCallNames.length > 0,
  });
  return entry;
}

export function getLatestPcvBurnGrounding(
  evidence: PcvNodeEvidenceSummary
): PcvBurnGroundingLedgerEntry | null {
  return getLatestGroundingEntry(evidence);
}

export function recordPcvToolResult(
  evidence: PcvNodeEvidenceSummary,
  call: FunctionCallLike,
  result: unknown,
  envelope: ToolResultEnvelope | undefined,
  options: {
    toolSucceeded?: boolean;
    evidenceLedger?: Pick<EvidenceLedgerStore, 'get'> | null;
  } = {}
): void {
  const toolName = call.name || 'unknown';
  const callId = call.id || null;
  const resultRecord = asRecord(result);
  // 调用方（AgentRuntime）总会传入 readToolObservation 的判定；未传时退回 envelope.ok，
  // 没有 envelope 时以 result.error 是否存在判定，与下方 note_finding 的接受判定共用同一口径。
  const toolSucceeded =
    options.toolSucceeded ?? (envelope ? envelope.ok : resultRecord.error === undefined);
  // C052：批量 code.read 只要有一个成员成功，整体回执就是成功；失败/取消成员仍在 args 与回执文本里
  // （含 ENOENT 报错中的宿主绝对路径）。“读到了什么”与 analysisArtifact / ActiveContext 等共用
  // toolOutcomes 的成员级口径，这里只在确有失败成员时改走成员级记录，其余调用的提取方式不变。
  const readReceipt = { tool: call.name, args: call.args, result, envelope };
  const failedReadMembers = toolSucceeded ? failedReadPaths(readReceipt) : [];
  if (toolSucceeded && failedReadMembers.length > 0) {
    recordPartialReadSourceRefs(evidence, readReceipt, failedReadMembers);
  } else if (toolSucceeded) {
    const sourceRefs = normalizeSourceRefsForEvidence(
      evidence,
      extractSourceRefsFromValue([
        call.args,
        result,
        envelope?.structuredContent,
        envelope?.artifacts,
        envelope?.resources,
        envelope?.text,
      ])
    );
    addSourceRefs(evidence, sourceRefs);
  } else {
    // I28：被 hook / 阶段门阻断或执行失败的调用没有真正读到来源，其参数路径不能计入节点 sourceRefs，
    // 否则一个全部读取失败的节点会被宿主显示为 linked，并掩盖 missing-source-refs。
    // 跳过的只是“尝试过的参数路径”，经 sourceRefDiagnostics 留审计记录；失败回执文本里的路径不记录。
    recordFailedCallSourceRefs(evidence, extractSourceRefsFromValue(call.args));
  }

  if (!isNoteFindingCall(call)) {
    return;
  }

  const params = getNoteFindingParams(call);
  const finding = stringValue(params.finding) || '';
  // 当前工具以 ledger id 传引用；旧文本仅为兼容回执保留，不参与引用校验。
  const refs = stringArray(params.evidenceRefs);
  const evidenceText =
    refs.length > 0
      ? refs
          .map((ref) => {
            const entry = toolSucceeded ? options.evidenceLedger?.get(ref) : null;
            return entry?.file
              ? `${ref}=${entry.file}${entry.range ? `:${entry.range.start}-${entry.range.end}` : ''}`
              : ref;
          })
          .join('; ')
      : stringValue(params.evidence) || '';
  const importance = numberValue(params.importance);
  const recorded = toolSucceeded && resultRecord.recorded === true;
  const target = stringValue(resultRecord.target);
  const accepted = recorded && target === 'activeContext';
  const findingSourceRefs = normalizeSourceRefsForEvidence(
    evidence,
    extractSourceRefsFromValue([evidenceText, params, resultRecord])
  );
  // I28：与上方同一口径——失败的 note_finding 调用，其引用只保留在被拒 finding 记录的 sourceRefs 上供审计，
  // 不并入节点 sourceRefs；调用成功但未进入 ActiveContext 的 finding 仍是一次成功调用，引用照旧并入。
  if (toolSucceeded) {
    addSourceRefs(evidence, findingSourceRefs);
  }

  if (accepted) {
    pushUniqueAcceptedFinding(evidence, {
      callId,
      evidence: evidenceText ? [evidenceText] : [],
      findingSummary: limitText(finding || 'note_finding recorded', 240),
      importance,
      origin: 'note_finding',
      ref: `finding:${shortHash({ callId, evidenceText, finding, toolName })}`,
      sourceRefs: findingSourceRefs,
      toolName,
    });
    if (evidence.repair.attempted) {
      evidence.repair.status = 'finding-recorded';
    }
    return;
  }

  const reason =
    stringValue(resultRecord.message) ||
    stringValue(resultRecord.error) ||
    envelope?.text ||
    'note_finding result was not recorded in ActiveContext';
  pushUniqueRejectedFinding(evidence, {
    callId,
    evidence: evidenceText ? [evidenceText] : [],
    findingSummary: finding ? limitText(finding, 240) : undefined,
    origin: 'note_finding',
    reason: limitText(reason, 320),
    ref: `rejected-finding:${shortHash({ callId, evidenceText, finding, reason, toolName })}`,
    sourceRefs: findingSourceRefs,
    toolName,
  });
  if (evidence.repair.attempted) {
    evidence.repair.status = 'finding-rejected';
    evidence.repair.reason = limitText(reason, 320);
  }
}

export function buildPcvNodeEvidenceSummary(
  evidence: PcvNodeEvidenceSummary,
  options: { requireQualityGate?: boolean } = {}
): PcvNodeEvidenceSummary {
  const summary = cloneEvidence(evidence);
  // 记录路径已按上限写入；这里兜住外部传入（宿主重组或旧形状）的超限摘要，保证输出始终有界。
  enforceSourceRefDiagnosticCap(summary);
  normalizePcvEvidenceSourceRefs(summary);
  summary.sourceRefs = uniqueStrings(summary.sourceRefs).slice(0, MAX_SOURCE_REFS);
  summary.ledgerRefs = dedupeBy(summary.ledgerRefs, (item) => item.ref);
  summary.groundingLedger = dedupeBy(summary.groundingLedger || [], (item) => item.ref).slice(
    -MAX_GROUNDING_LEDGER
  );
  summary.findingRefs.accepted = dedupeBy(summary.findingRefs.accepted, (item) => item.ref);
  summary.findingRefs.rejected = dedupeBy(summary.findingRefs.rejected, (item) => item.ref);
  summary.missingLinkReasons = buildMissingLinkReasons(summary, options);
  return summary;
}

export function buildPcvNodeEvidenceProcessMetadata(
  evidence: PcvNodeEvidenceSummary
): PcvNodeEvidenceProcessMetadata {
  const summary = buildPcvNodeEvidenceSummary(evidence);
  const sourceRefDiagnostics = summary.sourceRefDiagnostics.slice(
    0,
    MAX_EVENT_SOURCE_REF_DIAGNOSTICS
  );
  if (summary.sourceRefDiagnostics.length > sourceRefDiagnostics.length) {
    reportEventSourceRefDiagnosticTruncation(evidence, summary.sourceRefDiagnostics.length);
  }
  return {
    acceptedFindingRefs: summary.findingRefs.accepted.map((finding) => finding.ref),
    chainNodeId: summary.chainNodeId,
    correlation: summary.correlation,
    groundingLedger: summary.groundingLedger.slice(-MAX_EVENT_GROUNDING_LEDGER),
    inputAssemblyRef: summary.inputAssembly?.ref || null,
    ledgerRefs: summary.ledgerRefs.map((ledger) => ledger.ref),
    missingLinkReasons: summary.missingLinkReasons,
    nodeId: summary.nodeId,
    qualityGate: summary.qualityGate
      ? {
          action: summary.qualityGate.action,
          pass: summary.qualityGate.pass,
          reason: summary.qualityGate.reason,
          status: summary.qualityGate.status,
        }
      : null,
    rejectedFindingRefs: summary.findingRefs.rejected.map((finding) => finding.ref),
    repair: summary.repair,
    schemaVersion: 1,
    sourceRefDiagnostics,
    sourceRefs: summary.sourceRefs.slice(0, MAX_EVENT_SOURCE_REFS),
    stageIdentity: summary.stageIdentity,
  };
}

export function buildPcvQualityGateEvidence({
  artifact,
  dimId,
  gate,
  sharedState,
  source,
  stageNodeContext,
}: {
  artifact: unknown;
  dimId?: string | null;
  gate: GateLike;
  sharedState?: JsonRecord | null;
  source: unknown;
  stageNodeContext?: JsonRecord | null;
}): PcvNodeEvidenceSummary {
  const artifactRecord = asRecord(artifact);
  const evidence = createQualityGateEvidenceBase(artifactRecord, dimId || null, source);
  attachPcvSourceRefIndex(evidence, stageNodeContext, sharedState, artifactRecord, source);
  const qualityGateIdentity = resolvePcvStageNodeIdentity({
    context: stageNodeContext || artifactRecord,
    pipelinePhase: 'quality_gate',
    pipelineType: evidence.stageIdentity.pipelineType,
    sharedState,
    stageProfile: 'analyze',
    trackerPhase: null,
  });
  applyResolvedStageNodeIdentity(evidence, qualityGateIdentity);
  const referencedFiles = recordQualityGateReferencedFiles(evidence, artifactRecord);
  const findings = qualityGateFindings(artifactRecord);
  recordQualityGateFindings(evidence, findings);
  applyQualityGateResult(evidence, {
    artifactRecord,
    findingCount: findings.length,
    gate,
    referencedFileCount: referencedFiles.length,
  });
  updateQualityGateStageIdentity(evidence, artifactRecord, dimId || null);
  updateQualityGateRepairState(evidence);
  return buildPcvNodeEvidenceSummary(evidence, { requireQualityGate: true });
}

function createQualityGateEvidenceBase(
  artifactRecord: JsonRecord,
  dimId: string | null,
  source: unknown
): PcvNodeEvidenceSummary {
  const candidate = asRecord(source).pcvNodeEvidence;
  if (isPcvNodeEvidenceSummary(candidate)) {
    return cloneEvidence(candidate);
  }
  const fallback = createFallbackQualityGateEvidence(artifactRecord, dimId);
  if (candidate !== undefined && candidate !== null) {
    // I28 降级路径：source 带了 pcvNodeEvidence，但形状不是完整摘要（例如误传进程事件元数据
    // PcvNodeEvidenceProcessMetadata，或被宿主重组/截断过的旧摘要）。此时不再克隆它（会抛 TypeError
    // 让整个 quality_gate 阶段失败），改用 fallback 证据，并留下持久原因供审计定位来源证据被丢弃。
    fallback.missingLinkReasons.push('invalid-source-pcv-evidence');
    // C053：持久原因不带失败字段与输入形状，同时写一条降级日志补上触发条件与关键输入。
    reportInvalidSourcePcvEvidence(candidate, dimId, fallback.nodeId);
  }
  return fallback;
}

function recordQualityGateReferencedFiles(
  evidence: PcvNodeEvidenceSummary,
  artifactRecord: JsonRecord
): string[] {
  const referencedFiles = normalizeSourceRefsForEvidence(
    evidence,
    stringArray(artifactRecord.referencedFiles)
  );
  addSourceRefs(evidence, referencedFiles);
  return referencedFiles;
}

function qualityGateFindings(artifactRecord: JsonRecord): unknown[] {
  return Array.isArray(artifactRecord.findings) ? artifactRecord.findings : [];
}

function recordQualityGateFindings(
  evidence: PcvNodeEvidenceSummary,
  findings: readonly unknown[]
): void {
  for (const finding of findings) {
    const findingRecord = asRecord(finding);
    const findingText = stringValue(findingRecord.finding) || '';
    const evidenceText = stringValue(findingRecord.evidence) || '';
    const findingSourceRefs = normalizeSourceRefsForEvidence(
      evidence,
      extractSourceRefsFromValue([evidenceText, findingRecord])
    );
    addSourceRefs(evidence, findingSourceRefs);
    pushUniqueAcceptedFinding(evidence, {
      evidence: evidenceText ? [evidenceText] : [],
      findingSummary: limitText(findingText || 'quality artifact finding', 240),
      importance: numberValue(findingRecord.importance),
      origin: 'quality_artifact',
      ref: `artifact-finding:${shortHash({ evidenceText, findingText })}`,
      sourceRefs: findingSourceRefs,
      toolName: 'quality_gate',
    });
  }
}

function applyQualityGateResult(
  evidence: PcvNodeEvidenceSummary,
  {
    artifactRecord,
    findingCount,
    gate,
    referencedFileCount,
  }: {
    artifactRecord: JsonRecord;
    findingCount: number;
    gate: GateLike;
    referencedFileCount: number;
  }
): void {
  const qualityReport = asQualityReport(artifactRecord.qualityReport);
  const metadata = asRecord(artifactRecord.metadata);
  const pass = gate.pass === true;
  const action = gate.action || (pass ? 'pass' : 'retry');
  const reason = gate.reason || null;
  evidence.qualityGate = {
    action,
    derivedFindingCount: numberValue(metadata.derivedFindingCount) ?? undefined,
    findingCount,
    memoryFindingCount: numberValue(metadata.memoryFindingCount) ?? undefined,
    pass,
    reason,
    referencedFileCount,
    scores: qualityReport?.scores,
    stage: 'quality_gate',
    status: pass ? 'pass' : action,
    suggestions: qualityReport?.suggestions,
    totalScore: qualityReport?.totalScore,
  };
}

function updateQualityGateStageIdentity(
  evidence: PcvNodeEvidenceSummary,
  artifactRecord: JsonRecord,
  dimId: string | null
): void {
  evidence.stageIdentity.pipelinePhase = 'quality_gate';
  evidence.stageIdentity.stageProfile = evidence.stageIdentity.stageProfile || 'analyze';
  evidence.stageIdentity.dimensionId =
    evidence.stageIdentity.dimensionId || stringValue(artifactRecord.dimensionId) || dimId;
  evidence.correlation.dimensionId =
    evidence.correlation.dimensionId || evidence.stageIdentity.dimensionId;
}

function updateQualityGateRepairState(evidence: PcvNodeEvidenceSummary): void {
  const qualityGate = evidence.qualityGate;
  if (!qualityGate || qualityGate.pass) {
    return;
  }

  evidence.repair.reason = qualityGate.reason;
  if (qualityGate.action === 'record_repair') {
    evidence.repair.attempted = true;
    evidence.repair.status = 'required';
  } else if (qualityGate.action === 'analysis_retry') {
    evidence.repair.status = 'analysis-retry-required';
  } else if (qualityGate.action === 'degrade') {
    evidence.repair.status = 'rejected';
  }
}

export function extractSourceRefsFromValue(value: unknown): string[] {
  const refs = new Set<string>();
  collectSourceRefs(value, refs, new WeakSet<object>(), 0);
  return [...refs].slice(0, MAX_SOURCE_REFS);
}

export function resolvePcvStageNodeIdentity({
  context,
  pipelinePhase,
  pipelineType,
  sharedState,
  stageProfile,
  trackerPhase,
}: {
  context?: JsonRecord | null;
  pipelinePhase?: string | null;
  pipelineType?: string | null;
  sharedState?: JsonRecord | null;
  stageProfile?: string | null;
  trackerPhase?: string | null;
}): ResolvedPcvStageNodeIdentity | null {
  const aliases = buildStageNodeAliases({
    pipelinePhase,
    pipelineType,
    stageProfile,
    trackerPhase,
  });
  if (aliases.length === 0) {
    return null;
  }

  // canonical stage identity 由上游编排方注入；Agent 只消费并贯穿，缺失时保留 fallback。
  const mapCandidates = [
    context?.pcvStageNodeMap,
    context?.pcvChainNodes,
    context?.stageNodeMap,
    sharedState?._pcvStageNodeMap,
    sharedState?._pcvChainNodes,
    sharedState?.pcvStageNodeMap,
    sharedState?.pcvChainNodes,
  ];
  for (const mapCandidate of mapCandidates) {
    const mapRecord = asRecord(mapCandidate);
    if (Object.keys(mapRecord).length === 0) {
      continue;
    }
    const normalized = new Map<string, unknown>();
    for (const [key, value] of Object.entries(mapRecord)) {
      normalized.set(normalizeStageKey(key), value);
    }
    for (const alias of aliases) {
      const resolved = normalizePcvStageNodeMapValue(normalized.get(alias));
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function applyResolvedStageNodeIdentity(
  evidence: PcvNodeEvidenceSummary,
  identity: ResolvedPcvStageNodeIdentity | null
): void {
  if (!identity) {
    return;
  }
  evidence.nodeId = identity.nodeId;
  evidence.chainNodeId = identity.chainNodeId;
}

function buildStageNodeAliases({
  pipelinePhase,
  pipelineType,
  stageProfile,
  trackerPhase,
}: {
  pipelinePhase?: string | null;
  pipelineType?: string | null;
  stageProfile?: string | null;
  trackerPhase?: string | null;
}): string[] {
  const rawAliases = [
    pipelinePhase,
    normalizePipelinePhaseAlias(pipelinePhase),
    stageProfile,
    normalizeStageProfileAlias(stageProfile),
    trackerPhase,
    normalizeTrackerPhaseAlias(trackerPhase),
    pipelineType,
  ];
  return uniqueStrings(rawAliases.map((alias) => normalizeStageKey(alias)).filter(Boolean));
}

function normalizePipelinePhaseAlias(value?: string | null): string | null {
  const normalized = normalizeStageKey(value);
  if (!normalized) {
    return null;
  }
  if (normalized.includes('record_repair')) {
    return 'record_repair';
  }
  if (normalized.includes('quality')) {
    return 'quality_gate';
  }
  if (normalized === 'producer') {
    return 'produce';
  }
  return normalized;
}

function normalizeStageProfileAlias(value?: string | null): string | null {
  const normalized = normalizeStageKey(value);
  if (normalized === 'record') {
    return 'record_repair';
  }
  if (normalized === 'producer') {
    return 'produce';
  }
  return normalized || null;
}

function normalizeTrackerPhaseAlias(value?: string | null): string | null {
  const normalized = normalizeStageKey(value);
  if (!normalized) {
    return null;
  }
  if (normalized === 'produce') {
    return 'produce';
  }
  if (normalized === 'record') {
    return 'record';
  }
  if (['scan', 'explore', 'verify', 'summarize'].includes(normalized)) {
    return 'analyze';
  }
  return normalized;
}

function normalizeStageKey(value?: string | null): string {
  const stageKey = stringValue(value);
  if (!stageKey) {
    return '';
  }
  return stageKey
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/^stage_/, '');
}

function normalizePcvStageNodeMapValue(value: unknown): ResolvedPcvStageNodeIdentity | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    const nodeId = value.trim();
    return { chainNodeId: nodeId, nodeId };
  }

  const record = asRecord(value);
  const nodeId =
    stringValue(record.pcvNodeId) ||
    stringValue(record.nodeId) ||
    stringValue(record.stageNodeId) ||
    stringValue(record.canonicalNodeId) ||
    stringValue(record.id);
  if (!nodeId) {
    return null;
  }
  const chainNodeId =
    stringValue(record.chainNodeId) ||
    stringValue(record.canonicalChainNodeId) ||
    stringValue(record.chainId) ||
    nodeId;
  return { chainNodeId, nodeId };
}

function buildLedgerRefs(ctx: LoopContext, dimensionScopeId: string | null): PcvNodeLedgerRef[] {
  // 引用只在注入了观察台账（trace = ActiveContext）时存在；不再附带 stats 快照（见 PcvNodeLedgerRef）。
  if (!ctx.trace) {
    return [];
  }
  return [
    {
      kind: 'observation-ledger',
      ref: `active-context:${dimensionScopeId || 'session'}`,
      source: 'ActiveContext',
    },
  ];
}

/**
 * 观察台账可读性探针：节点创建时读一次 trace.getStats，只用来确认台账可读，不保留计数。
 * trace 可能是宿主注入的鸭子类型对象，读取抛错时：引用照常保留（台账对象确实存在），
 * 但在 missingLinkReasons 写入 observation-ledger-stats-unavailable，并经运行诊断报告错误原文，
 * 取代原来裸 catch 静默吞错。没有 trace 或没有 getStats 方法不算失败。
 */
function probeObservationLedger(ctx: LoopContext, evidence: PcvNodeEvidenceSummary): void {
  const trace = ctx.trace;
  if (!trace || typeof trace.getStats !== 'function') {
    return;
  }
  try {
    trace.getStats();
  } catch (err: unknown) {
    // 非 Error 抛出值不走 String(err)：其 toString 可能再次抛错，让 LoopContext 构造失败。
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : Object.prototype.toString.call(err);
    evidence.missingLinkReasons = uniqueStrings([
      ...evidence.missingLinkReasons,
      'observation-ledger-stats-unavailable',
    ]);
    ctx.diagnostics?.warn({
      code: 'pcv_observation_ledger_stats_unavailable',
      message: limitText(
        `trace.getStats threw while probing the observation ledger for PCV node ${evidence.nodeId}; ` +
          `ledger ref kept, missingLinkReasons marked observation-ledger-stats-unavailable: ${message}`,
        400
      ),
      stage: evidence.stageIdentity.pipelinePhase ?? undefined,
    });
  }
}

function createFallbackQualityGateEvidence(
  artifact: JsonRecord,
  dimId: string | null
): PcvNodeEvidenceSummary {
  const dimensionId = stringValue(artifact.dimensionId) || dimId;
  const nodeId = `agent:quality_gate:${dimensionId || 'unknown'}`;
  return {
    chainNodeId: nodeId,
    correlation: {
      dimensionId,
      dimensionScopeId: dimensionId,
      iteration: 0,
      modelRef: null,
      runId: null,
      source: 'system',
      targetName: null,
    },
    findingRefs: { accepted: [], rejected: [] },
    // AP-4：质量门 fallback 证据非 guard 运行，标记 observe-only。
    groundingEnforcement: 'off',
    groundingLedger: [],
    inputAssembly: null,
    ledgerRefs: [],
    missingLinkReasons: [],
    nodeId,
    qualityGate: null,
    repair: { attempted: false, evidencePaths: [], reason: null, status: null },
    schemaVersion: 1,
    sourceRefDiagnostics: [],
    sourceRefs: [],
    stageIdentity: {
      dimensionId,
      nodeKind: 'agent-runtime-node',
      pipelinePhase: 'quality_gate',
      pipelineType: null,
      stageProfile: 'analyze',
      targetName: null,
      trackerPhase: null,
    },
  };
}

/**
 * I28 结构守卫：只查 schemaVersion/nodeId 时，进程事件元数据（PcvNodeEvidenceProcessMetadata，
 * 同样带 schemaVersion:1 与 nodeId，但没有 findingRefs/ledgerRefs 对象数组）也能通过，随后 cloneEvidence
 * 无保护地解引用这些字段并抛 TypeError。这里按 cloneEvidence 与摘要构建实际解引用的字段逐项校验；
 * 被 `|| []` 兜底的可选数组允许缺省（null/undefined），但出现时必须是数组。
 * groundingEnforcement 缺省视为 AP-4 之前的旧摘要（clone 时补 'off'），出现时必须是合法取值。
 */
function isPcvNodeEvidenceSummary(value: unknown): value is PcvNodeEvidenceSummary {
  return findPcvNodeEvidenceSummaryDefect(value) === null;
}

/**
 * C053：结构守卫的逐项检查，按固定顺序返回首个未通过的检查项名（全部通过返回 null）。
 * isPcvNodeEvidenceSummary 是它的布尔包装；invalid-source 降级日志用它点名失败字段。仅模块内使用。
 */
function findPcvNodeEvidenceSummaryDefect(value: unknown): string | null {
  if (!isJsonRecord(value)) {
    return 'not-an-object';
  }
  const record = value;
  const checks: ReadonlyArray<readonly [string, () => boolean]> = [
    ['schemaVersion', () => record.schemaVersion === 1],
    ['nodeId', () => typeof record.nodeId === 'string'],
    ['chainNodeId', () => typeof record.chainNodeId === 'string'],
    ['correlation', () => isJsonRecord(record.correlation)],
    ['stageIdentity', () => isJsonRecord(record.stageIdentity)],
    ['sourceRefs', () => Array.isArray(record.sourceRefs)],
    ['missingLinkReasons', () => isOptionalArray(record.missingLinkReasons)],
    ['sourceRefDiagnostics', () => isOptionalArray(record.sourceRefDiagnostics)],
    [
      'groundingEnforcement',
      () =>
        record.groundingEnforcement === undefined ||
        isGroundingEnforcement(record.groundingEnforcement),
    ],
    ['findingRefs', () => hasValidFindingRefs(record.findingRefs)],
    ['ledgerRefs', () => hasValidLedgerRefs(record.ledgerRefs)],
    ['repair', () => hasValidRepair(record.repair)],
    ['groundingLedger', () => hasValidGroundingLedger(record.groundingLedger)],
    ['inputAssembly', () => hasValidInputAssembly(record.inputAssembly)],
    ['qualityGate', () => hasValidQualityGate(record.qualityGate)],
  ];
  return checks.find(([, check]) => !check())?.[0] ?? null;
}

/** invalid-source 降级日志最多列出的候选顶层键数、单个键名与标识取值的展示长度；只记形状，不记证据正文。 */
const MAX_REPORTED_INVALID_SOURCE_KEYS = 12;
const MAX_REPORTED_INVALID_SOURCE_KEY_CHARS = 40;
const MAX_REPORTED_INVALID_SOURCE_VALUE_CHARS = 80;

/**
 * C053：质量门 source 证据未通过结构守卫、降级为 fallback 证据时的日志。missingLinkReasons 里的
 * invalid-source-pcv-evidence 只说明“发生了降级”；这里补上触发条件（首个未通过的检查项）与关键输入
 * （类型、顶层键、schemaVersion、nodeId），以及选择的路径（fallback 节点）。质量门没有运行诊断出口，
 * 与截断诊断的退路一致，直接写 Core Logger。
 */
function reportInvalidSourcePcvEvidence(
  candidate: unknown,
  dimId: string | null,
  fallbackNodeId: string
): void {
  const failedCheck = findPcvNodeEvidenceSummaryDefect(candidate) ?? 'unknown';
  const inputType = Array.isArray(candidate) ? 'array' : typeof candidate;
  const record = isJsonRecord(candidate) ? candidate : null;
  const keys = record ? Object.keys(record) : [];
  const reportedKeys = keys
    .slice(0, MAX_REPORTED_INVALID_SOURCE_KEYS)
    .map((key) => limitText(key, MAX_REPORTED_INVALID_SOURCE_KEY_CHARS));
  const omittedKeyCount = keys.length - reportedKeys.length;
  const keyList = `[${reportedKeys.join(',')}${omittedKeyCount > 0 ? `,+${omittedKeyCount} more` : ''}]`;
  const schemaVersion = describeReportedSourceValue(record?.schemaVersion);
  const nodeId = describeReportedSourceValue(record?.nodeId);
  Logger.getInstance().warn(
    `[PcvNodeEvidence] pcv_quality_gate_invalid_source_evidence: source.pcvNodeEvidence failed the ` +
      `summary shape guard (dimId=${dimId ?? 'none'} failedCheck=${failedCheck} inputType=${inputType} ` +
      `keys=${keyList} schemaVersion=${schemaVersion} nodeId=${nodeId}); quality gate continues with ` +
      `fallback node ${fallbackNodeId} and missingLinkReasons invalid-source-pcv-evidence`,
    {
      path: 'invalid-source-pcv-evidence',
      dimId,
      failedCheck,
      inputType,
      inputKeys: reportedKeys,
      inputKeyCount: keys.length,
      schemaVersion,
      nodeId,
      fallbackNodeId,
    }
  );
}

/** 日志里的标识取值：缺省记 missing，标量按值截断，其它只记类型。 */
function describeReportedSourceValue(value: unknown): string {
  if (value === undefined) {
    return 'missing';
  }
  if (typeof value === 'string') {
    return limitText(value, MAX_REPORTED_INVALID_SOURCE_VALUE_CHARS);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return `<${Array.isArray(value) ? 'array' : typeof value}>`;
}

function hasValidFindingRefs(value: unknown): boolean {
  if (!isJsonRecord(value) || !Array.isArray(value.accepted) || !Array.isArray(value.rejected)) {
    return false;
  }
  return (
    value.accepted.every((finding) => hasArrayFields(finding, ['evidence', 'sourceRefs'])) &&
    value.rejected.every(
      (finding) =>
        isJsonRecord(finding) &&
        isOptionalArray(finding.evidence) &&
        isOptionalArray(finding.sourceRefs)
    )
  );
}

function hasValidLedgerRefs(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((ledger) => isJsonRecord(ledger) && typeof ledger.ref === 'string')
  );
}

function hasValidRepair(value: unknown): boolean {
  return hasArrayFields(value, ['evidencePaths']);
}

function hasValidGroundingLedger(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        hasArrayFields(entry, [
          'consumedEvidenceRefs',
          'deterministicEvidenceRefs',
          'evidenceStarterRefs',
          'functionCallNames',
          'outputSourceRefs',
          'toolSchemaNames',
        ]) && isOptionalArray(entry.visibleDeterministicEvidenceRefs)
    )
  );
}

function hasValidInputAssembly(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return hasArrayFields(value, [
    'inputSectionIds',
    'providerVisibleSectionIds',
    'staticSectionIds',
    'toolSchemaNames',
  ]);
}

function hasValidQualityGate(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return isJsonRecord(value) && isOptionalArray(value.suggestions);
}

function hasArrayFields(value: unknown, keys: readonly string[]): value is JsonRecord {
  if (!isJsonRecord(value)) {
    return false;
  }
  return keys.every((key) => Array.isArray(value[key]));
}

function isOptionalArray(value: unknown): boolean {
  return value === undefined || value === null || Array.isArray(value);
}

function isGroundingEnforcement(value: unknown): value is GroundingEnforcement {
  return value === 'off' || value === 'guard';
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNoteFindingCall(call: FunctionCallLike): boolean {
  const args = call.args || {};
  const action = stringValue(args.action) || stringValue(asRecord(args.params).action);
  return call.name === 'note_finding' || (call.name === 'memory' && action === 'note_finding');
}

function getNoteFindingParams(call: FunctionCallLike): JsonRecord {
  const args = call.args || {};
  if (call.name === 'note_finding') {
    return args;
  }
  const params = asRecord(args.params);
  return Object.keys(params).length > 0 ? params : args;
}

function buildMissingLinkReasons(
  summary: PcvNodeEvidenceSummary,
  options: { requireQualityGate?: boolean }
): string[] {
  const reasons: string[] = [];
  if (!summary.inputAssembly?.ref) {
    reasons.push('missing-input-assembly-ref');
  }
  if (summary.ledgerRefs.length === 0) {
    reasons.push('missing-observation-ledger-ref');
  }
  if (summary.findingRefs.accepted.length === 0 && summary.findingRefs.rejected.length === 0) {
    reasons.push('missing-finding-refs');
  }
  if (summary.sourceRefs.length === 0) {
    reasons.push('missing-source-refs');
  }
  if (options.requireQualityGate === true && !summary.qualityGate) {
    reasons.push('missing-quality-gate-status');
  }
  // 这些缺失项是当前快照的派生事实；后续 QualityGate 补齐后应消失。
  const derived = new Set([
    'missing-input-assembly-ref',
    'missing-observation-ledger-ref',
    'missing-finding-refs',
    'missing-source-refs',
    'missing-quality-gate-status',
  ]);
  return uniqueStrings([
    ...summary.missingLinkReasons.filter((reason) => !derived.has(reason)),
    ...reasons,
  ]);
}

function pushUniqueAcceptedFinding(
  evidence: PcvNodeEvidenceSummary,
  finding: PcvNodeAcceptedFindingRef
): void {
  if (!evidence.findingRefs.accepted.some((item) => item.ref === finding.ref)) {
    evidence.findingRefs.accepted.push(finding);
  }
}

function pushUniqueRejectedFinding(
  evidence: PcvNodeEvidenceSummary,
  finding: PcvNodeRejectedFindingRef
): void {
  if (!evidence.findingRefs.rejected.some((item) => item.ref === finding.ref)) {
    evidence.findingRefs.rejected.push(finding);
  }
}

/**
 * I28：失败调用的参数路径不进入节点 sourceRefs（见 recordPcvToolResult），在 sourceRefDiagnostics 里记
 * `{ reason: 'failed-tool-call', status: 'missing' }` 留审计。刻意不记聚合原因 unresolved-source-refs：
 * 同一路径之后可能被成功读取并正常链接，记成未解析会与 sourceRefs 自相矛盾；
 * 节点是否缺来源仍由派生原因 missing-source-refs 表达。这些诊断同样受 I27 的条数上限与丢弃计数约束。
 */
function recordFailedCallSourceRefs(
  evidence: PcvNodeEvidenceSummary,
  refs: readonly string[]
): void {
  for (const ref of uniqueStrings([...refs])) {
    pushSourceRefDiagnostic(evidence, {
      input: ref,
      reason: 'failed-tool-call',
      status: 'missing',
    });
  }
}

/**
 * C052：整体成功但含失败/取消成员的批量 code.read。节点 sourceRefs 只并入：
 * - successfulReadPaths 认定真实读到的成员路径（与 analysisArtifact、ActiveContext、SignalDetector 同源）；
 * - 成功成员条目本身（正文里的 import 等引用，与单文件成功读取同一口径）。
 * call.args（含失败成员的请求路径）、envelope.text（渲染了失败成员的报错）与失败成员条目都不提取；
 * 失败成员只以其成员路径记 failed-tool-call 诊断（触发条件与关键输入），报错文本里的路径不记录，
 * 与整体失败调用的处理口径一致。
 */
function recordPartialReadSourceRefs(
  evidence: PcvNodeEvidenceSummary,
  readReceipt: JsonRecord,
  failedMembers: ReadonlyArray<{ path: string; reason: string }>
): void {
  const sourceRefs = normalizeSourceRefsForEvidence(
    evidence,
    extractSourceRefsFromValue([
      successfulReadPaths(readReceipt),
      successfulReadMemberEntries(readReceipt),
    ])
  );
  addSourceRefs(evidence, sourceRefs);
  recordFailedCallSourceRefs(
    evidence,
    extractSourceRefsFromValue(failedMembers.map((member) => member.path))
  );
}

/**
 * 批量 code.read 中成功成员的条目，成员判定与 toolOutcomes.successfulReadPaths 相同
 * （files 数组按成员自身 ok/error/status，旧形状 batchResults 以键为路径）。
 * 不看整体 ok：调用方已按 toolSucceeded 进入本分支，成员级过滤只负责剔除失败成员。
 */
function successfulReadMemberEntries(readReceipt: JsonRecord): unknown[] {
  const payload = readToolObservation(readReceipt).result;
  if (Array.isArray(payload.files)) {
    return payload.files.filter((file) => readToolObservation({ result: file }).ok);
  }
  if (isJsonRecord(payload.batchResults)) {
    return Object.entries(payload.batchResults)
      .filter(([, member]) => readToolObservation({ result: member }).ok)
      .map(([file, member]) => ({ path: file, member }));
  }
  return [];
}

function addSourceRefs(evidence: PcvNodeEvidenceSummary, refs: string[]): void {
  evidence.sourceRefs = uniqueStrings([
    ...evidence.sourceRefs,
    ...normalizeSourceRefsForEvidence(evidence, refs),
  ]).slice(0, MAX_SOURCE_REFS);
}

function attachPcvSourceRefIndex(evidence: PcvNodeEvidenceSummary, ...sources: unknown[]): void {
  if (PCV_SOURCE_REF_INDEX.has(evidence)) {
    return;
  }
  const index = resolvePcvSourceRefIndex(...sources);
  if (index) {
    PCV_SOURCE_REF_INDEX.set(evidence, index);
  }
}

function resolvePcvSourceRefIndex(...sources: unknown[]): PcvProjectScopeSourceRefIndex | null {
  for (const source of sources) {
    const directIndex = findProjectScopeSourceRefIndex(source);
    if (directIndex) {
      return directIndex;
    }
  }

  const identities = sources.flatMap((source) => collectCanonicalSourceIdentities(source));
  return identities.length > 0 ? buildPcvProjectScopeSourceRefIndex(identities) : null;
}

function findProjectScopeSourceRefIndex(source: unknown): PcvProjectScopeSourceRefIndex | null {
  const record = asRecord(source);
  const candidates = [record.sourceRefIndex, record.projectScopeSourceRefIndex];
  return candidates.find(isProjectScopeSourceRefIndex) ?? null;
}

/**
 * I27 已知缺口（待决事项③，本包不接线）：唯一生产宿主只注入 projectScopeSourceIdentityMap /
 * _projectScopeSourceIdentityMap（{contract, contractVersion, entries}），下面这些候选键在生产中没有写入方，
 * 只有测试经 sourceIdentities / _sourceIdentities 注入；因此生产中来源身份索引为空、规范化走无索引分支。
 * 接线宿主真实形状（含相对/绝对路径解析）与删除这些别名随事项③的决定一并处理，决定前保持原样。
 */
function collectCanonicalSourceIdentities(source: unknown): PcvCanonicalSourceIdentity[] {
  const record = asRecord(source);
  const candidates = [
    source,
    record.sourceIdentities,
    record.projectScopeSourceIdentities,
    record.canonicalSourceIdentities,
    record.sourceRefIdentities,
    record._sourceIdentities,
    asRecord(record.projectScope).sourceIdentities,
    asRecord(record.projectScopeAnalysis).sourceIdentities,
    asRecord(record.projectIntelligence).sourceIdentities,
  ];
  return candidates.flatMap((candidate) => {
    if (!Array.isArray(candidate)) {
      const identity = normalizeCanonicalSourceIdentity(candidate);
      return identity ? [identity] : [];
    }
    return candidate
      .map((item) => normalizeCanonicalSourceIdentity(item))
      .filter((item): item is PcvCanonicalSourceIdentity => Boolean(item));
  });
}

function normalizeCanonicalSourceIdentity(value: unknown): PcvCanonicalSourceIdentity | null {
  const record = asRecord(value);
  const identityRecord =
    Object.keys(asRecord(record.sourceIdentity)).length > 0
      ? asRecord(record.sourceIdentity)
      : record;
  const qualifiedPath = stringValue(identityRecord.qualifiedPath);
  if (!qualifiedPath) {
    return null;
  }
  return {
    absolutePath: stringValue(identityRecord.absolutePath),
    folderDisplayName: stringValue(identityRecord.folderDisplayName),
    folderId: stringValue(identityRecord.folderId),
    folderPath: stringValue(identityRecord.folderPath),
    folderRelativeRoot: stringValue(identityRecord.folderRelativeRoot),
    projectScopeId: stringValue(identityRecord.projectScopeId),
    qualifiedPath,
    relativePath: stringValue(identityRecord.relativePath),
  };
}

function buildPcvProjectScopeSourceRefIndex(
  identities: readonly PcvCanonicalSourceIdentity[]
): PcvProjectScopeSourceRefIndex {
  const byQualifiedPath = new Map<string, PcvCanonicalSourceIdentity>();
  const basenameBuckets = new Map<string, PcvCanonicalSourceIdentity[]>();

  for (const identity of identities) {
    byQualifiedPath.set(normalizePcvSourcePath(identity.qualifiedPath), identity);
    const basename = sourceRefBasename(identity.qualifiedPath);
    if (basename) {
      basenameBuckets.set(basename, [...(basenameBuckets.get(basename) ?? []), identity]);
    }
  }

  const byBasename = new Map<string, PcvCanonicalSourceIdentity>();
  const ambiguousBasenames = new Set<string>();
  for (const [basename, entries] of basenameBuckets) {
    const distinctQualifiedPaths = new Set(entries.map((entry) => entry.qualifiedPath));
    if (distinctQualifiedPaths.size === 1 && entries[0]) {
      byBasename.set(basename, entries[0]);
    } else {
      ambiguousBasenames.add(basename);
    }
  }

  return { ambiguousBasenames, byBasename, byQualifiedPath };
}

function normalizePcvProjectScopeSourceRef(
  sourceRef: string,
  index: PcvProjectScopeSourceRefIndex
): PcvNormalizedProjectScopeSourceRef {
  const normalized = normalizePcvSourcePath(sourceRef);
  const qualified = index.byQualifiedPath.get(normalized);
  if (qualified) {
    return {
      normalizedRef: qualified.qualifiedPath,
      reason: 'qualified-path',
      status: 'active',
    };
  }

  if (!normalized.includes('/')) {
    if (index.ambiguousBasenames.has(normalized)) {
      return { normalizedRef: null, reason: 'ambiguous-basename', status: 'ambiguous' };
    }
    const basename = index.byBasename.get(normalized);
    if (basename) {
      return {
        normalizedRef: basename.qualifiedPath,
        reason: 'unique-basename',
        status: 'active',
      };
    }
  }

  return { normalizedRef: null, reason: 'not-found', status: 'missing' };
}

function normalizePcvSourcePath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.\/+/u, '')
    .replace(/\/+/gu, '/');
}

function sourceRefBasename(value: string): string | null {
  const normalized = normalizePcvSourcePath(value);
  const basename = normalized.split('/').filter(Boolean).pop();
  return basename || null;
}

function normalizeSourceRefsForEvidence(
  evidence: PcvNodeEvidenceSummary,
  refs: readonly string[]
): string[] {
  const index = PCV_SOURCE_REF_INDEX.get(evidence);
  if (!index) {
    return uniqueStrings([...refs]);
  }

  const normalizedRefs: string[] = [];
  for (const ref of refs) {
    const parsed = splitSourceRefLineSuffix(ref);
    if (!parsed.path) {
      continue;
    }
    const normalized = normalizePcvProjectScopeSourceRef(parsed.path, index);
    if (normalized.status === 'active' && normalized.normalizedRef) {
      normalizedRefs.push(`${normalized.normalizedRef}${parsed.lineSuffix}`);
      continue;
    }
    recordSourceRefDiagnostic(evidence, {
      input: ref,
      reason: normalized.reason,
      status: normalized.status === 'ambiguous' ? 'ambiguous' : 'missing',
    });
  }
  return uniqueStrings(normalizedRefs).slice(0, MAX_SOURCE_REFS);
}

function normalizePcvEvidenceSourceRefs(evidence: PcvNodeEvidenceSummary): void {
  evidence.sourceRefs = normalizeSourceRefsForEvidence(evidence, evidence.sourceRefs);
  evidence.repair.evidencePaths = normalizeSourceRefsForEvidence(
    evidence,
    evidence.repair.evidencePaths
  );
  for (const finding of evidence.findingRefs.accepted) {
    finding.sourceRefs = normalizeSourceRefsForEvidence(evidence, finding.sourceRefs);
  }
  for (const finding of evidence.findingRefs.rejected) {
    finding.sourceRefs = normalizeSourceRefsForEvidence(evidence, finding.sourceRefs || []);
  }
  for (const entry of evidence.groundingLedger) {
    entry.outputSourceRefs = normalizeSourceRefsForEvidence(evidence, entry.outputSourceRefs);
  }
}

function splitSourceRefLineSuffix(ref: string): { lineSuffix: string; path: string } {
  const clean = ref.trim();
  const match = clean.match(/^(.*?)(:\d+(?:-\d+)?)?$/u);
  return {
    lineSuffix: match?.[2] ?? '',
    path: (match?.[1] ?? clean).trim(),
  };
}

/**
 * I27：规范化未命中时，逐条明细进有上限的 sourceRefDiagnostics，missingLinkReasons 只记聚合原因
 * （unresolved-source-refs / ambiguous-source-refs）。此前逐路径镜像成 `${status}-source-ref:${input}`，
 * 原因集合随未命中引用线性膨胀，宿主报告按字符串取并集后被逐路径噪声淹没。
 * 聚合原因在诊断因上限被丢弃时照样记录，“存在歧义/未解析引用”这一事实不会随截断丢失。
 */
function recordSourceRefDiagnostic(
  evidence: PcvNodeEvidenceSummary,
  diagnostic: PcvSourceRefDiagnostic
): void {
  pushSourceRefDiagnostic(evidence, diagnostic);
  addMissingLinkReason(
    evidence,
    diagnostic.status === 'ambiguous' ? AMBIGUOUS_SOURCE_REFS_REASON : UNRESOLVED_SOURCE_REFS_REASON
  );
}

function addMissingLinkReason(evidence: PcvNodeEvidenceSummary, reason: string): void {
  if (!evidence.missingLinkReasons.includes(reason)) {
    evidence.missingLinkReasons = [...evidence.missingLinkReasons, reason];
  }
}

/**
 * 按 input/reason/status 去重写入 sourceRefDiagnostics（Set 键，O(1)）。已满 MAX_SOURCE_REF_DIAGNOSTICS 时
 * 不再存入，只把这条不同诊断计入丢弃数；见过的键（含已丢弃的）不会重复计数。
 */
function pushSourceRefDiagnostic(
  evidence: PcvNodeEvidenceSummary,
  diagnostic: PcvSourceRefDiagnostic
): void {
  const state = getSourceRefDiagnosticState(evidence);
  const key = sourceRefDiagnosticKey(diagnostic);
  if (state.keys.has(key)) {
    return;
  }
  state.keys.add(key);
  if (evidence.sourceRefDiagnostics.length >= MAX_SOURCE_REF_DIAGNOSTICS) {
    recordDroppedSourceRefDiagnostics(evidence, state, 1, diagnostic.input);
    return;
  }
  evidence.sourceRefDiagnostics.push(diagnostic);
}

/** 去重键。入参也可能是外部摘要里未经逐项校验的条目，非字符串字段按空串处理，不抛错。 */
function sourceRefDiagnosticKey(
  diagnostic: Partial<Record<keyof PcvSourceRefDiagnostic, unknown>>
): string {
  const part = (value: unknown) => (typeof value === 'string' ? value : '');
  return `${part(diagnostic.status)}\u0000${part(diagnostic.reason)}\u0000${part(diagnostic.input)}`;
}

/**
 * 取证据的诊断侧表状态。没有状态的证据来自反序列化摘要、fallback 或宿主传入的对象：键从已存诊断重建，
 * 丢弃数从持久原因恢复。已丢弃条目的键不随摘要序列化，反序列化后再遇到同一引用会再计一次——只影响计数精度，
 * 不影响上限；这一点在这里显式接受，而不是为精确计数新增公开字段。
 */
function getSourceRefDiagnosticState(
  evidence: PcvNodeEvidenceSummary
): PcvSourceRefDiagnosticState {
  const existing = PCV_SOURCE_REF_DIAGNOSTIC_STATE.get(evidence);
  if (existing) {
    return existing;
  }
  const dropped = readDroppedSourceRefDiagnosticCount(evidence.missingLinkReasons);
  const state: PcvSourceRefDiagnosticState = {
    dropped,
    eventTruncationReported: false,
    keys: new Set(
      (evidence.sourceRefDiagnostics || []).map((item) => sourceRefDiagnosticKey(asRecord(item)))
    ),
    sink: null,
    // 恢复出的计数说明截断已在产生该摘要的运行里上报过，不再重复上报。
    truncationReported: dropped > 0,
  };
  PCV_SOURCE_REF_DIAGNOSTIC_STATE.set(evidence, state);
  return state;
}

function readDroppedSourceRefDiagnosticCount(reasons: readonly string[] | undefined): number {
  for (const reason of reasons || []) {
    if (
      typeof reason !== 'string' ||
      !reason.startsWith(DROPPED_SOURCE_REF_DIAGNOSTICS_REASON_PREFIX)
    ) {
      continue;
    }
    const count = Number(reason.slice(DROPPED_SOURCE_REF_DIAGNOSTICS_REASON_PREFIX.length));
    if (Number.isSafeInteger(count) && count > 0) {
      return count;
    }
  }
  return 0;
}

/**
 * 记一次（或一批）因上限丢弃的诊断：累加计数，原位替换唯一的计数原因，并在首次截断时上报一次诊断。
 * firstDroppedInput 只用于上报文案，帮助定位从哪条引用开始被截断。
 */
function recordDroppedSourceRefDiagnostics(
  evidence: PcvNodeEvidenceSummary,
  state: PcvSourceRefDiagnosticState,
  count: number,
  firstDroppedInput: string | null
): void {
  state.dropped += count;
  // 外部传入的摘要可能夹带非字符串原因（结构守卫只校验是数组）；这里只替换计数原因，其余原样留给
  // buildMissingLinkReasons 的 uniqueStrings 统一过滤，不在此处抛错。
  evidence.missingLinkReasons = [
    ...evidence.missingLinkReasons.filter(
      (reason) =>
        typeof reason !== 'string' ||
        !reason.startsWith(DROPPED_SOURCE_REF_DIAGNOSTICS_REASON_PREFIX)
    ),
    `${DROPPED_SOURCE_REF_DIAGNOSTICS_REASON_PREFIX}${state.dropped}`,
  ];
  if (state.truncationReported) {
    return;
  }
  state.truncationReported = true;
  reportPcvSourceRefDiagnostic(evidence, state, {
    code: 'pcv_source_ref_diagnostics_truncated',
    message: limitText(
      `sourceRefDiagnostics for PCV node ${evidence.nodeId} reached the cap of ${MAX_SOURCE_REF_DIAGNOSTICS}; ` +
        `further distinct diagnostics are counted in missingLinkReasons ` +
        `(${DROPPED_SOURCE_REF_DIAGNOSTICS_REASON_PREFIX}<n>) instead of stored` +
        (firstDroppedInput ? `; first dropped input: ${firstDroppedInput}` : ''),
      400
    ),
  });
}

/** 摘要输出前兜底截断：外部传入的超限诊断列表只保留前 MAX_SOURCE_REF_DIAGNOSTICS 条，其余计入丢弃数。 */
function enforceSourceRefDiagnosticCap(evidence: PcvNodeEvidenceSummary): void {
  const overflow = evidence.sourceRefDiagnostics.length - MAX_SOURCE_REF_DIAGNOSTICS;
  if (overflow <= 0) {
    return;
  }
  // 先建状态（键覆盖截断前的全部条目），被截掉的条目之后再出现也不会重复计数。
  const state = getSourceRefDiagnosticState(evidence);
  const firstDroppedInput =
    evidence.sourceRefDiagnostics[MAX_SOURCE_REF_DIAGNOSTICS]?.input ?? null;
  evidence.sourceRefDiagnostics = evidence.sourceRefDiagnostics.slice(
    0,
    MAX_SOURCE_REF_DIAGNOSTICS
  );
  recordDroppedSourceRefDiagnostics(evidence, state, overflow, firstDroppedInput);
}

/**
 * 进程事件投影只带前 MAX_EVENT_SOURCE_REF_DIAGNOSTICS 条诊断；首次发生时对该节点证据上报一次，
 * 说明完整的有界列表在运行结果的 pcvNodeEvidence 摘要里。状态挂在调用方传入的证据（运行期为 ctx.pcvNodeEvidence）上。
 */
function reportEventSourceRefDiagnosticTruncation(
  evidence: PcvNodeEvidenceSummary,
  total: number
): void {
  const state = getSourceRefDiagnosticState(evidence);
  if (state.eventTruncationReported) {
    return;
  }
  state.eventTruncationReported = true;
  reportPcvSourceRefDiagnostic(evidence, state, {
    code: 'pcv_process_event_source_ref_diagnostics_truncated',
    message:
      `process events for PCV node ${evidence.nodeId} carry the first ${MAX_EVENT_SOURCE_REF_DIAGNOSTICS} ` +
      `of ${total} sourceRefDiagnostics; the full bounded list stays in the run result pcvNodeEvidence summary`,
  });
}

/** 有运行诊断出口时进运行诊断；没有（摘要克隆、质量门证据）时退回 Core Logger，保证截断总有可见记录。 */
function reportPcvSourceRefDiagnostic(
  evidence: PcvNodeEvidenceSummary,
  state: PcvSourceRefDiagnosticState,
  warning: { code: string; message: string }
): void {
  if (state.sink) {
    state.sink.warn({
      ...warning,
      stage: evidence.stageIdentity.pipelinePhase ?? undefined,
    });
    return;
  }
  Logger.getInstance().warn(`[PcvNodeEvidence] ${warning.code}: ${warning.message}`);
}

function isProjectScopeSourceRefIndex(value: unknown): value is PcvProjectScopeSourceRefIndex {
  const record = value as Partial<PcvProjectScopeSourceRefIndex> | null;
  return (
    Boolean(record) &&
    hasMapGet(record?.byQualifiedPath) &&
    hasMapGet(record?.byBasename) &&
    hasSetHas(record?.ambiguousBasenames)
  );
}

function hasMapGet(value: unknown): value is Pick<ReadonlyMap<string, unknown>, 'get'> {
  return typeof (value as { get?: unknown } | null)?.get === 'function';
}

function hasSetHas(value: unknown): value is Pick<ReadonlySet<string>, 'has'> {
  return typeof (value as { has?: unknown } | null)?.has === 'function';
}

function upsertGroundingLedgerEntry(
  evidence: PcvNodeEvidenceSummary,
  entry: PcvBurnGroundingLedgerEntry
): void {
  const index = evidence.groundingLedger.findIndex((item) => item.ref === entry.ref);
  if (index >= 0) {
    evidence.groundingLedger[index] = entry;
  } else {
    evidence.groundingLedger.push(entry);
  }
  if (evidence.groundingLedger.length > MAX_GROUNDING_LEDGER) {
    evidence.groundingLedger.splice(0, evidence.groundingLedger.length - MAX_GROUNDING_LEDGER);
  }
}

function getLatestGroundingEntry(
  evidence: PcvNodeEvidenceSummary
): PcvBurnGroundingLedgerEntry | null {
  return evidence.groundingLedger[evidence.groundingLedger.length - 1] || null;
}

function classifyGroundingEntry(
  entry: PcvBurnGroundingLedgerEntry,
  options: { hasFunctionCalls: boolean }
): PcvBurnGroundingClassification {
  const phase = (entry.trackerPhase || '').toUpperCase();
  if (entry.stageProfile === 'summarize') {
    return 'summary-only';
  }
  if (entry.acceptedFindingDelta > 0 || entry.rejectedFindingDelta > 0 || phase === 'RECORD') {
    return entry.acceptedFindingDelta > 0 || entry.rejectedFindingDelta > 0
      ? 'record-only'
      : 'invalid-no-evidence';
  }
  if (entry.evidenceToolCallDelta > 0) {
    return 'evidence-produced';
  }
  if (entry.consumedEvidenceRefs.length > 0) {
    if (phase === 'SCAN') {
      return 'planning-only';
    }
    if (phase === 'VERIFY') {
      return 'verification-only';
    }
    return 'deterministic-evidence-consumed';
  }
  if (entry.stageProfile === 'analyze') {
    return 'invalid-no-evidence';
  }
  return options.hasFunctionCalls ? 'planning-only' : 'summary-only';
}

function collectConsumedEvidenceRefs(text: string, refs: string[]): string[] {
  if (!text || refs.length === 0) {
    return [];
  }
  const normalizedText = text.toLowerCase();
  return uniqueStrings(refs).filter((ref) => {
    const clean = ref.trim();
    if (!clean) {
      return false;
    }
    const lower = clean.toLowerCase();
    const pathOnly = lower.replace(/:\d+(?:-\d+)?$/u, '');
    return normalizedText.includes(lower) || normalizedText.includes(pathOnly);
  });
}

function collectSourceRefs(
  value: unknown,
  refs: Set<string>,
  seen: WeakSet<object>,
  depth: number
): void {
  if (refs.size >= MAX_SOURCE_REFS || depth > 5 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    const text = value.length > 20_000 ? value.slice(0, 20_000) : value;
    for (const match of text.match(FILE_REF_RE) || []) {
      const clean = match.trim();
      if (clean.length > 2 && clean.length < 180) {
        refs.add(clean);
      }
      if (refs.size >= MAX_SOURCE_REFS) {
        return;
      }
    }
    return;
  }
  if (typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSourceRefs(item, refs, seen, depth + 1);
      if (refs.size >= MAX_SOURCE_REFS) {
        return;
      }
    }
    return;
  }
  const record = value as JsonRecord;
  for (const [key, child] of Object.entries(record)) {
    if (isSecretLikeKey(key)) {
      continue;
    }
    collectSourceRefs(child, refs, seen, depth + 1);
    if (refs.size >= MAX_SOURCE_REFS) {
      return;
    }
  }
}

function asQualityReport(value: unknown): {
  scores?: Record<string, number>;
  suggestions?: string[];
  totalScore?: number;
} | null {
  const report = asRecord(value) as QualityReportLike;
  const scoresRecord = asRecord(report.scores);
  const scores: Record<string, number> = {};
  for (const [key, score] of Object.entries(scoresRecord)) {
    if (typeof score === 'number' && Number.isFinite(score)) {
      scores[key] = score;
    }
  }
  const totalScore = numberValue(report.totalScore);
  const suggestions = stringArray(report.suggestions);
  if (Object.keys(scores).length === 0 && totalScore === null && suggestions.length === 0) {
    return null;
  }
  return {
    ...(Object.keys(scores).length > 0 ? { scores } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
    ...(totalScore !== null ? { totalScore } : {}),
  };
}

function cloneEvidence(evidence: PcvNodeEvidenceSummary): PcvNodeEvidenceSummary {
  if (evidence.groundingEnforcement === undefined) {
    reportLegacyGroundingEnforcementDefault(evidence);
  }
  const cloned = {
    ...evidence,
    correlation: { ...evidence.correlation },
    // I28：AP-4 之前的旧摘要没有 groundingEnforcement；缺省取值与 LoopContext 的默认一致，
    // 即 observe-only 'off'（非法取值已被 isPcvNodeEvidenceSummary 拒绝，走 invalid-source-pcv-evidence）；
    // 补默认值时已由上方 reportLegacyGroundingEnforcementDefault 记录兼容转译（C053）。
    groundingEnforcement: evidence.groundingEnforcement ?? 'off',
    findingRefs: {
      accepted: evidence.findingRefs.accepted.map((finding) => ({
        ...finding,
        evidence: [...finding.evidence],
        sourceRefs: [...finding.sourceRefs],
      })),
      rejected: evidence.findingRefs.rejected.map((finding) => ({
        ...finding,
        ...(finding.evidence ? { evidence: [...finding.evidence] } : {}),
        ...(finding.sourceRefs ? { sourceRefs: [...finding.sourceRefs] } : {}),
      })),
    },
    groundingLedger: (evidence.groundingLedger || []).map((entry) => ({
      ...entry,
      consumedEvidenceRefs: [...entry.consumedEvidenceRefs],
      deterministicEvidenceRefs: [...entry.deterministicEvidenceRefs],
      evidenceStarterRefs: [...entry.evidenceStarterRefs],
      functionCallNames: [...entry.functionCallNames],
      outputSourceRefs: [...entry.outputSourceRefs],
      toolSchemaNames: [...entry.toolSchemaNames],
      ...(entry.visibleDeterministicEvidenceRefs
        ? { visibleDeterministicEvidenceRefs: [...entry.visibleDeterministicEvidenceRefs] }
        : {}),
    })),
    inputAssembly: evidence.inputAssembly
      ? {
          ...evidence.inputAssembly,
          inputSectionIds: [...evidence.inputAssembly.inputSectionIds],
          providerVisibleSectionIds: [...evidence.inputAssembly.providerVisibleSectionIds],
          staticSectionIds: [...evidence.inputAssembly.staticSectionIds],
          toolSchemaNames: [...evidence.inputAssembly.toolSchemaNames],
        }
      : null,
    // I28：只投影 kind/ref/source；旧形状输入里的 stats 快照（开局计数、宿主不读）在此丢弃。
    ledgerRefs: evidence.ledgerRefs.map((ledger) => ({
      kind: ledger.kind,
      ref: ledger.ref,
      source: ledger.source,
    })),
    missingLinkReasons: [...(evidence.missingLinkReasons || [])],
    qualityGate: evidence.qualityGate
      ? {
          ...evidence.qualityGate,
          ...(evidence.qualityGate.scores ? { scores: { ...evidence.qualityGate.scores } } : {}),
          ...(evidence.qualityGate.suggestions
            ? { suggestions: [...evidence.qualityGate.suggestions] }
            : {}),
        }
      : null,
    repair: { ...evidence.repair, evidencePaths: [...evidence.repair.evidencePaths] },
    sourceRefDiagnostics: (evidence.sourceRefDiagnostics || []).map((diagnostic) => ({
      ...diagnostic,
    })),
    sourceRefs: [...evidence.sourceRefs],
    stageIdentity: { ...evidence.stageIdentity },
  };
  const sourceRefIndex = PCV_SOURCE_REF_INDEX.get(evidence);
  if (sourceRefIndex) {
    PCV_SOURCE_REF_INDEX.set(cloned, sourceRefIndex);
  }
  const diagnosticState = PCV_SOURCE_REF_DIAGNOSTIC_STATE.get(evidence);
  if (diagnosticState) {
    // 键集合按值复制：克隆（摘要、质量门基底）后续记录的诊断不能回写原证据的去重状态。
    // 复制成本是 O(不同诊断键数)，只复制引用，不序列化；有界的是对外输出与事件负载。
    // 克隆不持有运行诊断出口，避免同一截断事实被多个副本重复上报。
    PCV_SOURCE_REF_DIAGNOSTIC_STATE.set(cloned, {
      ...diagnosticState,
      keys: new Set(diagnosticState.keys),
      sink: null,
    });
  }
  return cloned;
}

/**
 * C053：AP-4 之前的旧摘要没有 groundingEnforcement，cloneEvidence 按兼容规则补 'off'。这是一次兼容转译，
 * 记录触发条件（字段缺省）、关键输入（nodeId）与结果（补上的取值）。补齐后的克隆带有该字段，
 * 同一条摘要链路的后续克隆不会重复记录；运行期证据总由 LoopContext 赋值，不会走到这里。
 */
function reportLegacyGroundingEnforcementDefault(evidence: PcvNodeEvidenceSummary): void {
  const nodeId = limitText(String(evidence.nodeId), MAX_REPORTED_INVALID_SOURCE_VALUE_CHARS);
  Logger.getInstance().info(
    `[PcvNodeEvidence] pcv_legacy_summary_grounding_enforcement_defaulted: PCV summary has no ` +
      `groundingEnforcement (pre-AP-4 shape); nodeId=${nodeId} defaulted=off (observe-only, same as the ` +
      `LoopContext default)`,
    { path: 'legacy-grounding-enforcement-default', nodeId, defaulted: 'off' }
  );
}

function shortHash(value: unknown): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 12);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as JsonRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const clean = value.trim();
    if (!clean || seen.has(clean)) {
      continue;
    }
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value) : [];
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    const clean = stringValue(value);
    if (clean) {
      return clean;
    }
  }
  return null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function valueAt(value: unknown, key: string): unknown {
  return asRecord(value)[key];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function limitText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function isSecretLikeKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|authorization|credential/i.test(key);
}
