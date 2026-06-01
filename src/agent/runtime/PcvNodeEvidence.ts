import { createHash } from 'node:crypto';
import {
  buildProjectScopeSourceRefIndex,
  type CanonicalSourceIdentity,
  normalizeProjectScopeSourceRef,
  type ProjectScopeSourceRefIndex,
} from '@alembic/core';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
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
  deepseekV4ToolChoiceMode?: string | null;
  deterministicEvidenceRefs: string[];
  effectiveToolChoice: string | null;
  evidenceStarterRefs: string[];
  evidenceToolCallDelta: number;
  functionCallNames: string[];
  iteration: number;
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
}

export interface PcvNodeLedgerRef {
  kind: 'observation-ledger';
  ref: string;
  source: 'ActiveContext';
  stats?: JsonRecord;
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

const FILE_REF_RE =
  /[\w/.-]+\.(?:go|mod|sum|py|pyi|java|kt|kts|js|jsx|ts|tsx|mjs|cjs|swift|m|h|c|cpp|cc|hpp|cs|rb|rs|sql|json|yaml|yml|toml|xml|html|css|scss|less|sh|md|txt|gradle|properties|proto|vue|svelte|graphql|cfg|conf|ini|env|lock|rst)(?::\d+(?:-\d+)?)?\b/gi;

const MAX_SOURCE_REFS = 80;
const MAX_EVENT_SOURCE_REFS = 24;
const MAX_GROUNDING_LEDGER = 32;
const MAX_EVENT_GROUNDING_LEDGER = 8;
const PCV_SOURCE_REF_INDEX = new WeakMap<PcvNodeEvidenceSummary, ProjectScopeSourceRefIndex>();

export function createPcvNodeEvidence(ctx: LoopContext): PcvNodeEvidenceSummary {
  const dimensionMeta = asRecord(ctx.sharedState?._dimensionMeta);
  const dimensionId =
    stringValue(dimensionMeta.id) ||
    stringValue(ctx.context?.dimensionId) ||
    stringValue(ctx.context?.dimId) ||
    null;
  const targetName =
    stringValue(dimensionMeta.label) ||
    stringValue(dimensionMeta.targetName) ||
    stringValue(ctx.context?.targetName) ||
    null;
  const dimensionScopeId =
    stringValue(ctx.context?.dimensionScopeId) ||
    stringValue(ctx.sharedState?._dimensionScopeId) ||
    dimensionId;
  const pipelinePhase = stringValue(ctx.context?.pipelinePhase) || null;
  const trackerPhase = typeof ctx.tracker?.phase === 'string' ? ctx.tracker.phase : null;
  const pipelineType = stringValue(valueAt(ctx.tracker, 'pipelineType')) || null;
  const runId =
    stringValue(ctx.context?.runId) ||
    stringValue(ctx.context?.jobId) ||
    stringValue(ctx.context?.sessionId) ||
    null;
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
    mappedIdentity?.nodeId ||
    stringValue(ctx.context?.pcvNodeId) ||
    stringValue(ctx.context?.nodeId) ||
    stringValue(ctx.context?.stageNodeId) ||
    `agent:${stageSlug}:${scopeSlug}`;
  const chainNodeId =
    mappedIdentity?.chainNodeId || stringValue(ctx.context?.chainNodeId) || nodeId;
  const rawRepairEvidencePaths = extractSourceRefsFromValue([
    ctx.context?.recordRepairEvidencePaths,
    ctx.sharedState?._recordRepairEvidencePaths,
  ]);
  const repairAttempted =
    ctx.sharedState?._recordRepairOnly === true ||
    ctx.context?.recordRepairOnly === true ||
    Boolean(pipelinePhase?.includes('record_repair'));

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
  attachPcvSourceRefIndex(evidence, ctx.context, ctx.sharedState);
  evidence.repair.evidencePaths = normalizeSourceRefsForEvidence(evidence, rawRepairEvidencePaths);
  return evidence;
}

export function recordPcvInputAssembly(
  evidence: PcvNodeEvidenceSummary,
  assembly: LLMInputAssembly,
  options: {
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
  const isDeepSeekV4 = /deepseek.*v4|deepseek-v4/i.test(modelRef || '');
  upsertGroundingLedgerEntry(evidence, {
    acceptedFindingDelta: 0,
    classification: assembly.stageProfile === 'summarize' ? 'summary-only' : 'planning-only',
    consumedEvidenceRefs: [],
    deepseekV4ToolChoiceMode: isDeepSeekV4
      ? buildDeepSeekV4ToolChoiceMode(options.requestedToolChoice, options.effectiveToolChoice)
      : null,
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
    toolChoiceSent: isDeepSeekV4 ? false : Boolean(options.effectiveToolChoice),
    toolChoiceSupported: isDeepSeekV4 ? false : undefined,
    toolSchemaNames,
    toolSchemasVisible: isDeepSeekV4 ? toolSchemaNames.length > 0 : undefined,
    trackerPhase,
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
  const evidenceFunctionCallCount = functionCalls.filter((call) =>
    isEvidenceFunctionCall(call.name || '', call.args || {})
  ).length;

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
    evidenceFunctionCallCount,
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
    evidenceFunctionCallCount: entry.evidenceToolCallDelta,
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
  options: { toolSucceeded?: boolean } = {}
): void {
  const toolName = call.name || 'unknown';
  const callId = call.id || null;
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

  if (!isNoteFindingCall(call)) {
    return;
  }

  const params = getNoteFindingParams(call);
  const finding = stringValue(params.finding) || '';
  const evidenceText = stringValue(params.evidence) || '';
  const importance = numberValue(params.importance);
  const resultRecord = asRecord(result);
  const toolSucceeded =
    options.toolSucceeded ?? (envelope ? envelope.ok : resultRecord.error === undefined);
  const recorded = toolSucceeded && resultRecord.recorded === true;
  const target = stringValue(resultRecord.target);
  const accepted = recorded && target === 'activeContext';
  const findingSourceRefs = normalizeSourceRefsForEvidence(
    evidence,
    extractSourceRefsFromValue([evidenceText, params, resultRecord])
  );
  addSourceRefs(evidence, findingSourceRefs);

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
    sourceRefDiagnostics: summary.sourceRefDiagnostics,
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
  const sourceEvidence = getPcvNodeEvidence(source);
  const evidence = sourceEvidence
    ? cloneEvidence(sourceEvidence)
    : createFallbackQualityGateEvidence(artifactRecord, dimId || null);
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
  const referencedFiles = normalizeSourceRefsForEvidence(
    evidence,
    stringArray(artifactRecord.referencedFiles)
  );
  addSourceRefs(evidence, referencedFiles);
  const findings = Array.isArray(artifactRecord.findings) ? artifactRecord.findings : [];
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

  const qualityReport = asQualityReport(artifactRecord.qualityReport);
  const metadata = asRecord(artifactRecord.metadata);
  const pass = gate.pass === true;
  const action = gate.action || (pass ? 'pass' : 'retry');
  const reason = gate.reason || null;
  evidence.qualityGate = {
    action,
    derivedFindingCount: numberValue(metadata.derivedFindingCount) ?? undefined,
    findingCount: findings.length,
    memoryFindingCount: numberValue(metadata.memoryFindingCount) ?? undefined,
    pass,
    reason,
    referencedFileCount: referencedFiles.length,
    scores: qualityReport?.scores,
    stage: 'quality_gate',
    status: pass ? 'pass' : action,
    suggestions: qualityReport?.suggestions,
    totalScore: qualityReport?.totalScore,
  };
  evidence.stageIdentity.pipelinePhase = 'quality_gate';
  evidence.stageIdentity.stageProfile = evidence.stageIdentity.stageProfile || 'analyze';
  evidence.stageIdentity.dimensionId =
    evidence.stageIdentity.dimensionId || stringValue(artifactRecord.dimensionId) || dimId || null;
  evidence.correlation.dimensionId =
    evidence.correlation.dimensionId || evidence.stageIdentity.dimensionId;
  if (!pass) {
    evidence.repair.reason = reason;
    if (action === 'record_repair') {
      evidence.repair.attempted = true;
      evidence.repair.status = 'required';
    } else if (action === 'analysis_retry') {
      evidence.repair.status = 'analysis-retry-required';
    } else if (action === 'degrade') {
      evidence.repair.status = 'rejected';
    }
  }
  return buildPcvNodeEvidenceSummary(evidence, { requireQualityGate: true });
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
  const stats = safeCall(() => ctx.trace?.getStats?.()) || null;
  if (!ctx.trace && !stats) {
    return [];
  }
  const ref = `active-context:${dimensionScopeId || 'session'}`;
  return [
    {
      kind: 'observation-ledger',
      ref,
      source: 'ActiveContext',
      ...(stats ? { stats: sanitizeStats(stats) } : {}),
    },
  ];
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

function getPcvNodeEvidence(source: unknown): PcvNodeEvidenceSummary | null {
  const record = asRecord(source);
  const candidate = record.pcvNodeEvidence;
  if (!isPcvNodeEvidenceSummary(candidate)) {
    return null;
  }
  return candidate;
}

function isPcvNodeEvidenceSummary(value: unknown): value is PcvNodeEvidenceSummary {
  const record = asRecord(value);
  return record.schemaVersion === 1 && typeof record.nodeId === 'string';
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
  return uniqueStrings([...summary.missingLinkReasons, ...reasons]);
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

function resolvePcvSourceRefIndex(...sources: unknown[]): ProjectScopeSourceRefIndex | null {
  for (const source of sources) {
    const directIndex = findProjectScopeSourceRefIndex(source);
    if (directIndex) {
      return directIndex;
    }
  }

  const identities = sources.flatMap((source) => collectCanonicalSourceIdentities(source));
  return identities.length > 0 ? buildProjectScopeSourceRefIndex(identities) : null;
}

function findProjectScopeSourceRefIndex(source: unknown): ProjectScopeSourceRefIndex | null {
  const record = asRecord(source);
  const candidates = [
    record.sourceRefIndex,
    record.projectScopeSourceRefIndex,
    record._sourceRefIndex,
    record._projectScopeSourceRefIndex,
  ];
  return candidates.find(isProjectScopeSourceRefIndex) ?? null;
}

function collectCanonicalSourceIdentities(source: unknown): CanonicalSourceIdentity[] {
  const record = asRecord(source);
  const candidates = [
    source,
    record.sourceIdentities,
    record.projectScopeSourceIdentities,
    record.canonicalSourceIdentities,
    record.sourceRefIdentities,
    record._sourceIdentities,
    record._projectScopeSourceIdentities,
    record._canonicalSourceIdentities,
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
      .filter((item): item is CanonicalSourceIdentity => Boolean(item));
  });
}

function normalizeCanonicalSourceIdentity(value: unknown): CanonicalSourceIdentity | null {
  const record = asRecord(value);
  const identityRecord =
    Object.keys(asRecord(record.sourceIdentity)).length > 0
      ? asRecord(record.sourceIdentity)
      : record;
  const legacyPath =
    stringValue(identityRecord.legacyPath) || stringValue(identityRecord.relativePath);
  const qualifiedPath = stringValue(identityRecord.qualifiedPath);
  const relativePath = stringValue(identityRecord.relativePath) || legacyPath;
  if (!legacyPath || !qualifiedPath || !relativePath) {
    return null;
  }
  return {
    absolutePath: stringValue(identityRecord.absolutePath),
    folderDisplayName: stringValue(identityRecord.folderDisplayName),
    folderId: stringValue(identityRecord.folderId),
    folderPath: stringValue(identityRecord.folderPath),
    folderRelativeRoot: stringValue(identityRecord.folderRelativeRoot),
    legacyPath,
    projectScopeId: stringValue(identityRecord.projectScopeId),
    qualifiedPath,
    relativePath,
  };
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
    const normalized = normalizeProjectScopeSourceRef(parsed.path, index);
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

function recordSourceRefDiagnostic(
  evidence: PcvNodeEvidenceSummary,
  diagnostic: PcvSourceRefDiagnostic
): void {
  if (
    evidence.sourceRefDiagnostics.some(
      (item) =>
        item.input === diagnostic.input &&
        item.reason === diagnostic.reason &&
        item.status === diagnostic.status
    )
  ) {
    return;
  }
  evidence.sourceRefDiagnostics.push(diagnostic);
  evidence.missingLinkReasons = uniqueStrings([
    ...evidence.missingLinkReasons,
    `${diagnostic.status}-source-ref:${diagnostic.input}`,
  ]);
}

function isProjectScopeSourceRefIndex(value: unknown): value is ProjectScopeSourceRefIndex {
  const record = value as Partial<ProjectScopeSourceRefIndex> | null;
  return (
    Boolean(record) &&
    hasMapGet(record?.byLegacyPath) &&
    hasMapGet(record?.byQualifiedPath) &&
    hasSetHas(record?.ambiguousLegacyPaths)
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

function buildDeepSeekV4ToolChoiceMode(
  requestedToolChoice: string | null | undefined,
  effectiveToolChoice: string | null | undefined
): string {
  if (effectiveToolChoice === 'auto' && requestedToolChoice === 'none') {
    return 'tools-visible-no-forced-tool-choice';
  }
  if (effectiveToolChoice === 'none') {
    return 'schemas-hidden-no-tool-choice';
  }
  return 'tool-choice-filtered-by-provider-guard';
}

function classifyGroundingEntry(
  entry: PcvBurnGroundingLedgerEntry,
  options: { evidenceFunctionCallCount: number; hasFunctionCalls: boolean }
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
  if (
    entry.evidenceToolCallDelta > 0 ||
    options.evidenceFunctionCallCount > 0 ||
    entry.toolCallDelta > 0
  ) {
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
  return options.hasFunctionCalls ? 'evidence-produced' : 'summary-only';
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

function isEvidenceFunctionCall(toolName: string, args: JsonRecord): boolean {
  const action = stringValue(args.action) || stringValue(asRecord(args.params).action);
  if (toolName === 'code') {
    return ['structure', 'search', 'read', 'outline'].includes(action || '');
  }
  if (toolName === 'graph') {
    return ['overview', 'query'].includes(action || '');
  }
  return toolName === 'terminal';
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

function sanitizeStats(value: unknown): JsonRecord {
  const record = asRecord(value);
  const output: JsonRecord = {};
  for (const [key, child] of Object.entries(record)) {
    if (isSecretLikeKey(key)) {
      continue;
    }
    if (
      typeof child === 'string' ||
      typeof child === 'number' ||
      typeof child === 'boolean' ||
      child === null
    ) {
      output[key] = child;
    } else if (Array.isArray(child)) {
      output[key] = child.slice(0, 12).map((item) => simpleValue(item));
    }
  }
  return output;
}

function simpleValue(value: unknown): unknown {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  return String(value);
}

function cloneEvidence(evidence: PcvNodeEvidenceSummary): PcvNodeEvidenceSummary {
  const cloned = {
    ...evidence,
    correlation: { ...evidence.correlation },
    findingRefs: {
      accepted: evidence.findingRefs.accepted.map((finding) => ({ ...finding })),
      rejected: evidence.findingRefs.rejected.map((finding) => ({ ...finding })),
    },
    groundingLedger: (evidence.groundingLedger || []).map((entry) => ({
      ...entry,
      consumedEvidenceRefs: [...entry.consumedEvidenceRefs],
      deterministicEvidenceRefs: [...entry.deterministicEvidenceRefs],
      evidenceStarterRefs: [...entry.evidenceStarterRefs],
      functionCallNames: [...entry.functionCallNames],
      outputSourceRefs: [...entry.outputSourceRefs],
      toolSchemaNames: [...entry.toolSchemaNames],
    })),
    inputAssembly: evidence.inputAssembly ? { ...evidence.inputAssembly } : null,
    ledgerRefs: evidence.ledgerRefs.map((ledger) => ({
      ...ledger,
      ...(ledger.stats ? { stats: { ...ledger.stats } } : {}),
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
    sourceRefDiagnostics: [...(evidence.sourceRefDiagnostics || [])],
    sourceRefs: [...evidence.sourceRefs],
    stageIdentity: { ...evidence.stageIdentity },
  };
  const sourceRefIndex = PCV_SOURCE_REF_INDEX.get(evidence);
  if (sourceRefIndex) {
    PCV_SOURCE_REF_INDEX.set(cloned, sourceRefIndex);
  }
  return cloned;
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

function safeCall<T>(fn: () => T | null | undefined): T | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
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
