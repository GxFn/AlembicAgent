import type { ToolSchema, UnifiedMessage } from '#ai/AiProvider.js';
import type { LoopContext } from './LoopContext.js';

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

export interface BuildLlmInputAssemblyOptions {
  ctx: LoopContext;
  dynamicContext: string | null;
  effectiveToolChoice: string;
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
  messages,
  modelRef,
  requestedToolChoice,
  systemPrompt,
  tools,
}: BuildLlmInputAssemblyOptions): LLMInputAssembly {
  const stageProfile = resolveLlmInputStageProfile(ctx, requestedToolChoice, effectiveToolChoice);
  const inputLayerSections = [
    buildStagePolicySection(stageProfile, ctx),
    buildToolContractSection(stageProfile, requestedToolChoice, effectiveToolChoice, tools),
    buildTaskContextSection(ctx, modelRef),
    buildEvidenceContextSection(ctx),
    buildDynamicContextSection(dynamicContext),
  ].filter((section): section is LLMInputSection => Boolean(section?.content.trim()));

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
    messages,
    metadata: {
      inputSectionIds: sections.map((section) => section.id),
      inputStageProfile: stageProfile,
      inputLayerAppended: Boolean(inputLayerMessage),
      staticSectionIds: sections
        .filter((section) => section.staticCacheable)
        .map((section) => section.id),
      providerVisibleSectionIds: sections
        .filter((section) => section.providerVisible)
        .map((section) => section.id),
    },
    providerMessages: inputLayerMessage ? [...messages, inputLayerMessage] : messages,
    sections,
    stageProfile,
    systemPrompt,
    tools,
  };
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
      'Analyze real project evidence. Use discovery tools only to gather or verify facts, then record confirmed findings with note_finding before the final report.',
    record:
      'Record-only phase. Do not perform additional exploration or emit prose. Use note_finding for already verified findings, one finding per call.',
    summarize:
      'Summary-only phase. Stop tool use and produce the final answer from existing evidence, recorded findings, and prior messages.',
    produce:
      'Producer phase. Transform verified analysis into knowledge submissions. Do not start new exploration; only read Analyst-referenced files when a submission needs an exact snippet.',
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
      'Use submission tools for candidate creation. code.read is limited to cited files from the Analyst input; search, graph, terminal, and broad exploration are out of scope.',
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

function buildTaskContextSection(ctx: LoopContext, modelRef: string): LLMInputSection {
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
    'prompt:',
    limitText(ctx.prompt, 1600),
  ];

  return {
    id: 'taskContext',
    title: 'Task context',
    content: contextLines.filter(Boolean).join('\n'),
    providerVisible: true,
    staticCacheable: false,
  };
}

function buildEvidenceContextSection(ctx: LoopContext): LLMInputSection {
  const lines: string[] = [];
  const metrics = safeCall<Record<string, unknown>>(() => ctx.tracker?.getMetrics?.());
  const traceStats = safeCall<Record<string, unknown>>(() => ctx.trace?.getStats?.());
  const planProgress = safeCall<Record<string, unknown>>(() => ctx.tracker?.getPlanProgress?.());
  const evidencePaths = Array.isArray(ctx.context?.recordRepairEvidencePaths)
    ? ctx.context.recordRepairEvidencePaths
    : Array.isArray(ctx.sharedState?._recordRepairEvidencePaths)
      ? ctx.sharedState._recordRepairEvidencePaths
      : null;

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

  return {
    id: 'evidenceContext',
    title: 'Evidence context',
    content: lines.join('\n'),
    providerVisible: true,
    staticCacheable: false,
  };
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function lowerString(value: unknown): string {
  return stringValue(value)?.toLowerCase() || '';
}

function upperString(value: unknown): string {
  return stringValue(value)?.toUpperCase() || '';
}
