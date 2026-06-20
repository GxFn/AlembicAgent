import type { ToolSchema, UnifiedMessage } from '#ai/AiProvider.js';
import { buildAnalyzeGroundingPolicy } from './AnalyzeGroundingGuard.js';
import type { LoopContext } from './LoopContext.js';
import { extractSourceRefsFromValue } from './PcvNodeEvidence.js';

export type LLMInputSectionId =
  | 'identity'
  | 'stagePolicy'
  | 'toolContract'
  | 'taskContext'
  | 'evidenceContext'
  | 'dynamicContext';

export type LLMInputStageProfile = 'analyze' | 'record' | 'summarize' | 'produce' | 'generic';

export interface LLMInputSection {
  id: LLMInputSectionId;
  title: string;
  content: string;
  providerVisible: boolean;
  staticCacheable: boolean;
}

export interface LLMInputAssembly {
  dynamicContext: string | null;
  inputLayerMessage: UnifiedMessage | null;
  messages: UnifiedMessage[];
  metadata: Record<string, unknown>;
  providerMessages: UnifiedMessage[];
  sections: LLMInputSection[];
  stageProfile: LLMInputStageProfile;
  systemPrompt: string;
  tools?: ToolSchema[];
}

interface LLMInputCompactionResult {
  budgetedSectionIds: LLMInputSectionId[];
  dedupedSectionIds: LLMInputSectionId[];
  sections: LLMInputSection[];
}

export interface BuildLlmInputAssemblyOptions {
  ctx: LoopContext;
  dynamicContext: string | null;
  effectiveToolChoice: string;
  inputProjection?: Record<string, unknown> | null;
  messages: UnifiedMessage[];
  modelRef: string;
  requestedToolChoice: string;
  systemPrompt: string;
  tools?: ToolSchema[];
}

export function buildLlmInputAssembly({
  ctx,
  dynamicContext,
  effectiveToolChoice,
  inputProjection,
  messages,
  modelRef,
  requestedToolChoice,
  systemPrompt,
  tools,
}: BuildLlmInputAssemblyOptions): LLMInputAssembly {
  const stageProfile = resolveLlmInputStageProfile(ctx, requestedToolChoice, effectiveToolChoice);
  const providerHistoryMessages = projectMessagesForStage(messages, stageProfile);
  const groundingContext = buildGroundingContext(ctx, modelRef);
  const rawInputLayerSections = [
    buildStagePolicySection(stageProfile, ctx),
    buildToolContractSection(stageProfile, requestedToolChoice, effectiveToolChoice, tools),
    buildTaskContextSection(ctx, modelRef, providerHistoryMessages),
    buildEvidenceContextSection(ctx, groundingContext),
    buildDynamicContextSection(dynamicContext),
  ].filter((section): section is LLMInputSection => Boolean(section?.content.trim()));
  const inputCompaction = compactInputLayerSections(rawInputLayerSections, stageProfile);
  const inputLayerSections = inputCompaction.sections;

  const sections: LLMInputSection[] = [
    {
      id: 'identity',
      title: 'Identity',
      content: systemPrompt,
      providerVisible: true,
      staticCacheable: true,
    },
    ...inputLayerSections,
  ];

  const inputLayerContent = formatProviderInputLayer(inputLayerSections);
  const inputLayerMessage: UnifiedMessage | null = inputLayerContent
    ? { role: 'user', content: inputLayerContent }
    : null;

  return {
    dynamicContext,
    inputLayerMessage,
    messages: providerHistoryMessages,
    metadata: {
      inputSectionIds: sections.map((section) => section.id),
      inputStageProfile: stageProfile,
      inputLayerAppended: Boolean(inputLayerMessage),
      deterministicEvidenceRefs: groundingContext.deterministicEvidenceRefs,
      evidenceStarterRefs: groundingContext.evidenceStarterRefs,
      groundingPolicy: groundingContext.policy,
      staticSectionIds: sections
        .filter((section) => section.staticCacheable)
        .map((section) => section.id),
      providerVisibleSectionIds: sections
        .filter((section) => section.providerVisible)
        .map((section) => section.id),
      trackerPhase: stringValue(valueAt(ctx.tracker, 'phase')),
      pipelineType: stringValue(valueAt(ctx.tracker, 'pipelineType')),
      inputCompaction: {
        budgetedSectionIds: inputCompaction.budgetedSectionIds,
        dedupedSectionIds: inputCompaction.dedupedSectionIds,
      },
      inputProjection: inputProjection || null,
    },
    providerMessages: inputLayerMessage
      ? [...providerHistoryMessages, inputLayerMessage]
      : providerHistoryMessages,
    sections,
    stageProfile,
    systemPrompt,
    tools,
  };
}

function projectMessagesForStage(
  messages: UnifiedMessage[],
  stageProfile: LLMInputStageProfile
): UnifiedMessage[] {
  if (stageProfile !== 'produce') {
    return messages;
  }
  return collapseProducerSubmitToolRounds(messages);
}

function collapseProducerSubmitToolRounds(messages: UnifiedMessage[]): UnifiedMessage[] {
  const projected: UnifiedMessage[] = [];
  for (let i = 0; i < messages.length; ) {
    const message = messages[i];
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const submitCalls = toolCalls.filter(isKnowledgeSubmitCall);
    if (
      message.role === 'assistant' &&
      toolCalls.length > 0 &&
      submitCalls.length === toolCalls.length
    ) {
      const toolCallIds = new Set(submitCalls.map((call) => call.id));
      const toolResults: UnifiedMessage[] = [];
      let next = i + 1;
      while (
        next < messages.length &&
        messages[next]?.role === 'tool' &&
        toolCallIds.has(String(messages[next]?.toolCallId || ''))
      ) {
        toolResults.push(messages[next]);
        next++;
      }

      if (toolResults.length === submitCalls.length) {
        projected.push({
          role: 'user',
          content: formatProducerSubmitHistorySummary(submitCalls, toolResults),
        });
        i = next;
        continue;
      }
    }

    projected.push(message);
    i++;
  }
  return mergeAdjacentProducerSubmitSummaries(projected);
}

function mergeAdjacentProducerSubmitSummaries(messages: UnifiedMessage[]): UnifiedMessage[] {
  const merged: UnifiedMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      previous?.role === 'user' &&
      message.role === 'user' &&
      String(previous.content || '').startsWith('[[Producer submit history]]') &&
      String(message.content || '').startsWith('[[Producer submit history]]')
    ) {
      previous.content = `${previous.content}\n${String(message.content || '')
        .split('\n')
        .slice(2)
        .join('\n')}`;
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function isKnowledgeSubmitCall(call: { name?: string; args?: Record<string, unknown> }): boolean {
  const args = isRecord(call.args) ? call.args : {};
  return call.name === 'knowledge' && stringValue(args.action) === 'submit';
}

function formatProducerSubmitHistorySummary(
  toolCalls: Array<{ id: string; args?: Record<string, unknown> }>,
  toolResults: UnifiedMessage[]
): string {
  const lines = [
    '[[Producer submit history]]',
    'Historical knowledge.submit tool rounds are summarized here. This is not a valid knowledge.submit payload; never copy compacted params. New submit calls must include the full required params from the current tool schema.',
  ];

  for (const call of toolCalls) {
    const args = isRecord(call.args) ? call.args : {};
    const params = isRecord(args.params) ? args.params : args;
    const summary = isRecord(args.payloadSummary) ? args.payloadSummary : {};
    const result = toolResults.find((item) => item.toolCallId === call.id);
    const resultText = String(result?.content || '').trim();
    const status = /"status"\s*:\s*"created"/.test(resultText)
      ? 'created'
      : /Missing required param/i.test(resultText)
        ? 'rejected'
        : resultText
          ? 'result'
          : 'unknown';
    lines.push(
      `- ${status}: title=${JSON.stringify(stringValue(params.title) || 'unknown')}` +
        `${stringValue(params.trigger) ? ` trigger=${JSON.stringify(stringValue(params.trigger))}` : ''}` +
        ` requiredFieldsComplete=${String(valueAt(summary, 'requiredFieldsComplete') ?? 'unknown')}` +
        ` sourceCount=${String(valueAt(summary, 'sourceCount') ?? 'unknown')}` +
        `${resultText ? ` result=${JSON.stringify(limitText(resultText, 160))}` : ''}`
    );
  }

  return lines.join('\n');
}

export function resolveLlmInputStageProfile(
  ctx: LoopContext,
  requestedToolChoice = '',
  effectiveToolChoice = requestedToolChoice
): LLMInputStageProfile {
  const trackerPhase = upperString(valueAt(ctx.tracker, 'phase'));
  const pipelineType = lowerString(valueAt(ctx.tracker, 'pipelineType'));
  const pipelinePhase = lowerString(ctx.context?.pipelinePhase);
  const recordRepairOnly =
    ctx.sharedState?._recordRepairOnly === true || ctx.context?.recordRepairOnly === true;

  if (recordRepairOnly || trackerPhase === 'RECORD' || pipelinePhase.includes('record_repair')) {
    return 'record';
  }
  if (
    trackerPhase === 'SUMMARIZE' ||
    trackerPhase === 'FINALIZE' ||
    pipelinePhase.includes('summarize') ||
    (effectiveToolChoice === 'none' &&
      (trackerPhase === 'SUMMARIZE' || pipelinePhase.includes('summary')))
  ) {
    return 'summarize';
  }
  if (
    trackerPhase === 'PRODUCE' ||
    pipelineType === 'producer' ||
    pipelinePhase === 'produce' ||
    pipelinePhase === 'producer'
  ) {
    return 'produce';
  }
  if (
    pipelineType === 'analyst' ||
    pipelineType === 'bootstrap' ||
    pipelineType === 'scan' ||
    pipelinePhase === 'analyze' ||
    trackerPhase === 'SCAN' ||
    trackerPhase === 'EXPLORE' ||
    trackerPhase === 'VERIFY'
  ) {
    return 'analyze';
  }
  return 'generic';
}

function buildStagePolicySection(
  stageProfile: LLMInputStageProfile,
  ctx: LoopContext
): LLMInputSection {
  const phase =
    stringValue(valueAt(ctx.tracker, 'phase')) || stringValue(ctx.context?.pipelinePhase);
  const pipelineType = stringValue(valueAt(ctx.tracker, 'pipelineType'));
  const profileLine = [
    `stageProfile: ${stageProfile}`,
    phase ? `phase: ${phase}` : null,
    pipelineType ? `pipelineType: ${pipelineType}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const bodyByProfile: Record<LLMInputStageProfile, string> = {
    analyze:
      'Analyze real project evidence with discovery tools, then record confirmed findings with note_finding. Final text must summarize recorded note_finding items only: verified finding ids or next evidence action; do not introduce Markdown-only candidate themes, source context, code, or injected evidence.',
    record:
      'Record-only phase. Do not perform additional exploration or emit prose. Use note_finding for already verified findings, one finding per call.',
    summarize:
      'Summary-only phase. Stop tool use and produce a concise final answer from recorded note_finding items only for confirmed/core sections. Prior messages may provide wording and evidence context, but unrecorded signals must be downgraded to unstructured/pending notes; do not replay full evidence text or introduce Markdown-only candidate themes.',
    produce:
      'Producer phase. Transform structured Analyst findings into knowledge submissions. Structured findings are the only candidate obligations; do not mine final Markdown for new themes. Do not start new exploration or read source files; use Analyst evidence/snippets as the source of truth. Final text: submit counts and blockers only; do not restate submitted candidate content.',
    generic: 'Follow the current task prompt and runtime tool contract.',
  };

  return {
    id: 'stagePolicy',
    title: 'Stage policy',
    content: [profileLine, bodyByProfile[stageProfile]].filter(Boolean).join('\n'),
    providerVisible: true,
    staticCacheable: false,
  };
}

function buildToolContractSection(
  stageProfile: LLMInputStageProfile,
  requestedToolChoice: string,
  effectiveToolChoice: string,
  tools?: ToolSchema[]
): LLMInputSection {
  const toolNames = (tools || []).map((tool) => tool.name).filter(Boolean);
  const base = [
    `requestedToolChoice: ${requestedToolChoice || 'unspecified'}`,
    `effectiveToolChoice: ${effectiveToolChoice || 'unspecified'}`,
    `availableTools: ${toolNames.length ? toolNames.join(', ') : '(none)'}`,
  ];

  const contractByProfile: Record<LLMInputStageProfile, string> = {
    analyze:
      'Allowed tools must support evidence gathering, verification, or structured finding capture. Avoid repeated searches and prefer batch reads for known files.',
    record:
      'Only note_finding is valid in this stage. If no note_finding schema is available, explain that structured recording is blocked.',
    summarize: 'No tool calls are valid. Ignore any retained tool schemas and return text only.',
    produce:
      'Use submission tools for candidate creation. code.read, search, graph, terminal, and broad exploration are out of scope for Producer.',
    generic: 'Use only the tools exposed in this call.',
  };

  return {
    id: 'toolContract',
    title: 'Tool contract',
    content: [...base, contractByProfile[stageProfile]].join('\n'),
    providerVisible: true,
    staticCacheable: false,
  };
}

function buildTaskContextSection(
  ctx: LoopContext,
  modelRef: string,
  messages: UnifiedMessage[]
): LLMInputSection {
  const promptInHistory = hasPromptInMessageHistory(ctx.prompt, messages);
  const contextLines = [
    `modelRef: ${modelRef}`,
    `source: ${ctx.source}`,
    `iteration: ${ctx.iteration}`,
    `maxIterations: ${ctx.maxIterations}`,
    stringValue(ctx.context?.pipelinePhase)
      ? `pipelinePhase: ${stringValue(ctx.context.pipelinePhase)}`
      : null,
    stringValue(ctx.context?.dimensionId)
      ? `dimensionId: ${stringValue(ctx.context.dimensionId)}`
      : null,
    stringValue(ctx.context?.targetName)
      ? `targetName: ${stringValue(ctx.context.targetName)}`
      : null,
    promptInHistory ? 'promptRef: initial-user-message' : 'prompt:',
    promptInHistory ? null : limitText(ctx.prompt, 1600),
  ];

  return {
    id: 'taskContext',
    title: 'Task context',
    content: contextLines.filter(Boolean).join('\n'),
    providerVisible: true,
    staticCacheable: false,
  };
}

function hasPromptInMessageHistory(prompt: string, messages: UnifiedMessage[]): boolean {
  const normalizedPrompt = normalizePromptPresence(prompt);
  if (!normalizedPrompt) {
    return false;
  }
  return messages.some((message) => {
    if (message.role !== 'user' || !message.content) {
      return false;
    }
    const normalizedContent = normalizePromptPresence(message.content);
    return normalizedContent.includes(normalizedPrompt);
  });
}

function normalizePromptPresence(text: string | null | undefined): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildEvidenceContextSection(
  ctx: LoopContext,
  groundingContext: GroundingContext
): LLMInputSection {
  const lines: string[] = [];
  const metrics = safeCall<Record<string, unknown>>(() => ctx.tracker?.getMetrics?.());
  const traceStats = safeCall<Record<string, unknown>>(() => ctx.trace?.getStats?.());
  const planProgress = safeCall<Record<string, unknown>>(() => ctx.tracker?.getPlanProgress?.());
  const evidencePaths = Array.isArray(ctx.context?.recordRepairEvidencePaths)
    ? ctx.context.recordRepairEvidencePaths
    : Array.isArray(ctx.sharedState?._recordRepairEvidencePaths)
      ? ctx.sharedState._recordRepairEvidencePaths
      : null;
  const producerSubmitLedger = compactProducerSubmitLedger(ctx.sharedState?._producerSubmitLedger);

  lines.push(`toolCallsSoFar: ${ctx.toolCalls.length}`);
  if (metrics) {
    lines.push(`trackerMetrics: ${safeJson(metrics)}`);
  }
  if (traceStats) {
    lines.push(`traceStats: ${safeJson(traceStats)}`);
  }
  if (planProgress) {
    lines.push(`planProgress: ${safeJson(planProgress)}`);
  }
  if (evidencePaths?.length) {
    lines.push(`recordRepairEvidencePaths: ${evidencePaths.map(String).join(', ')}`);
  }
  if (groundingContext.deterministicEvidenceRefs.length > 0) {
    lines.push(
      `deterministicEvidenceRefs: ${groundingContext.deterministicEvidenceRefs.join(', ')}`
    );
  }
  if (groundingContext.evidenceStarterRefs.length > 0) {
    lines.push(`evidenceStarterRefs: ${groundingContext.evidenceStarterRefs.join(', ')}`);
  }
  if (groundingContext.policy) {
    lines.push(`evidenceGroundingPolicy: ${groundingContext.policy}`);
  }
  if (producerSubmitLedger) {
    lines.push(`producerSubmitLedger: ${safeJson(producerSubmitLedger)}`);
    lines.push(
      'producerSubmitLedgerPolicy: treat payloadStored and requiredFieldsComplete as authoritative runtime facts; do not infer missing fields from compacted provider history.'
    );
  }

  return {
    id: 'evidenceContext',
    title: 'Evidence context',
    content: lines.join('\n'),
    providerVisible: true,
    staticCacheable: false,
  };
}

function compactProducerSubmitLedger(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const ledger = value as {
    createdCount?: unknown;
    entries?: unknown;
    targetSubmits?: unknown;
  };
  const entries = Array.isArray(ledger.entries)
    ? ledger.entries
        .filter(
          (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
        )
        .slice(0, 20)
        .map((entry) =>
          pickDefined({
            id: entry.id,
            payloadStored: entry.payloadStored,
            requiredFieldsComplete: entry.requiredFieldsComplete,
            sourceCount: entry.sourceCount,
            status: entry.status,
            title: entry.title,
            trigger: entry.trigger,
          })
        )
    : [];
  if (entries.length === 0) {
    return null;
  }
  return pickDefined({
    createdCount: ledger.createdCount,
    entries,
    targetSubmits: ledger.targetSubmits,
  });
}

interface GroundingContext {
  deterministicEvidenceRefs: string[];
  evidenceStarterRefs: string[];
  policy: string | null;
}

function buildGroundingContext(ctx: LoopContext, modelRef: string): GroundingContext {
  const evidenceStarters = ctx.context?.evidenceStarters ?? ctx.sharedState?._evidenceStarters;
  const evidenceStarterRefs = uniqueStrings(extractSourceRefsFromValue(evidenceStarters)).slice(
    0,
    24
  );
  // 这里故意只保留“证据已存在”提示，不再注入 sourceRef strict policy。
  // 之前 AI 把 sourceRef 错误扩成 canonical index/分类/强校验，导致重大资源浪费；不要在输入层复活。
  const deterministicEvidenceRefs = uniqueStrings([
    ...evidenceStarterRefs,
    ...extractSourceRefsFromValue([
      ctx.context?.deterministicEvidenceRefs,
      ctx.context?.referencedFiles,
      ctx.context?.recordRepairEvidencePaths,
      ctx.sharedState?._deterministicEvidenceRefs,
      ctx.sharedState?._referencedFiles,
      ctx.sharedState?._producerReferencedFiles,
      ctx.sharedState?._recordRepairEvidencePaths,
      ctx.sharedState?.referencedFiles,
    ]),
  ]).slice(0, 32);
  const policy =
    resolveLlmInputStageProfile(ctx) === 'analyze'
      ? buildAnalyzeGroundingPolicy(modelRef, deterministicEvidenceRefs.length)
      : null;
  return { deterministicEvidenceRefs, evidenceStarterRefs, policy };
}

function buildDynamicContextSection(dynamicContext: string | null): LLMInputSection | null {
  if (!dynamicContext) {
    return null;
  }
  return {
    id: 'dynamicContext',
    title: 'Dynamic context',
    content: dynamicContext,
    providerVisible: true,
    staticCacheable: false,
  };
}

function compactInputLayerSections(
  sections: LLMInputSection[],
  stageProfile: LLMInputStageProfile
): LLMInputCompactionResult {
  const seenBlocks = new Set<string>();
  const dedupedSectionIds: LLMInputSectionId[] = [];
  const budgetedSectionIds: LLMInputSectionId[] = [];
  const compacted = sections.map((section) => {
    const content = compactRepeatedBlocks(section.content, seenBlocks);
    let nextContent = content;
    const maxChars = sectionBudgetFor(stageProfile, section.id);
    if (nextContent.length > maxChars) {
      nextContent = limitText(nextContent, maxChars);
      budgetedSectionIds.push(section.id);
    }
    if (nextContent !== section.content) {
      dedupedSectionIds.push(section.id);
    }
    return { ...section, content: nextContent };
  });
  return { budgetedSectionIds, dedupedSectionIds, sections: compacted };
}

function sectionBudgetFor(
  stageProfile: LLMInputStageProfile,
  sectionId: LLMInputSectionId
): number {
  const defaultBudgets: Partial<Record<LLMInputSectionId, number>> = {
    dynamicContext: 1600,
    evidenceContext: 1400,
    taskContext: 1400,
  };
  if (stageProfile === 'produce') {
    const produceBudgets: Partial<Record<LLMInputSectionId, number>> = {
      dynamicContext: 1000,
      evidenceContext: 1000,
      taskContext: 1100,
    };
    return produceBudgets[sectionId] ?? 2400;
  }
  return defaultBudgets[sectionId] ?? 2400;
}

function compactRepeatedBlocks(text: string, seenBlocks: Set<string>): string {
  const paragraphs = text.split(/\n{2,}/);
  const compactedParagraphs: string[] = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n');
    const compactedLines: string[] = [];
    let paragraphDropped = false;
    for (const line of lines) {
      const key = normalizeCompactionBlock(line);
      if (key && hasSeenCompactionBlock(key, seenBlocks)) {
        paragraphDropped = lines.length === 1;
        continue;
      }
      compactedLines.push(line);
      if (key) {
        seenBlocks.add(key);
      }
    }
    if (!paragraphDropped && compactedLines.join('\n').trim()) {
      compactedParagraphs.push(compactedLines.join('\n'));
    }
  }
  return compactedParagraphs.join('\n\n');
}

function hasSeenCompactionBlock(key: string, seenBlocks: Set<string>): boolean {
  if (seenBlocks.has(key)) {
    return true;
  }
  for (const seen of seenBlocks) {
    if (key.includes(seen) || seen.includes(key)) {
      return true;
    }
  }
  return false;
}

function normalizeCompactionBlock(text: string): string | null {
  const normalized = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim()
    .toLowerCase();
  return normalized.length >= 48 ? normalized : null;
}

function formatProviderInputLayer(sections: LLMInputSection[]): string | null {
  if (sections.length === 0) {
    return null;
  }
  return [
    '# LLM input runtime layer',
    'This ephemeral message is assembled by AlembicAgent for the current LLM call. It contains dynamic policy and context only; the static identity remains in the system prompt.',
    ...sections.map((section) => `## ${section.title}\n${section.content}`),
  ].join('\n\n');
}

function safeCall<T>(fn: () => T | null | undefined): T | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function pickDefined(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      result[key] = value;
    }
  }
  return result;
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...(truncated)`;
}

function valueAt(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return (value as Record<string, unknown>)[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function lowerString(value: unknown): string {
  return stringValue(value)?.toLowerCase() || '';
}

function upperString(value: unknown): string {
  return stringValue(value)?.toUpperCase() || '';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
