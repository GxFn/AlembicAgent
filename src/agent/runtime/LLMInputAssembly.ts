import type { ToolSchema, UnifiedMessage } from '#ai/AiProvider.js';
import type { AgentDiagnosticWarning } from './AgentRuntimeTypes.js';
import { buildAnalyzeGroundingPolicy } from './AnalyzeGroundingGuard.js';
import type { LoopContext } from './LoopContext.js';
import { extractSourceRefsFromValue } from './PcvNodeEvidenceRecorder.js';

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

/**
 * evidenceContext 内的低优先级遥测行。预算不足时按此顺序（越靠前越先）整行丢弃，
 * 之后才会动台账 / policy / 证据 ref 等权威事实行。
 */
const EVIDENCE_TELEMETRY_DROP_ORDER = [
  'traceStats',
  'planProgress',
  'trackerMetrics',
  'toolCallsSoFar',
] as const;
type EvidenceTelemetryKey = (typeof EVIDENCE_TELEMETRY_DROP_ORDER)[number];

/**
 * 装配内部使用的章节草稿。lowPriorityLines 只服务预算决策（完整行文本 → 遥测键），
 * compactInputLayerSections 返回前会剥掉它，不进入公开的 LLMInputSection 形状。
 */
interface DraftInputLayerSection extends LLMInputSection {
  lowPriorityLines?: ReadonlyMap<string, EvidenceTelemetryKey>;
}

/** 单个章节的预算截断记录；随 metadata.inputCompaction.budgetedSections 进入 llm.input 过程事件。 */
interface LLMInputSectionBudgetRecord {
  sectionId: LLMInputSectionId;
  maxChars: number;
  /** 章节原始字符数（去重与预算之前）。 */
  originalChars: number;
  /** 最终发给 provider 的字符数（含截断标记）。 */
  keptChars: number;
  /** 被预算整行丢弃的行数（低优先级遥测行 + 尾部截掉的行；不含被截成半行的那一行）。 */
  droppedLines: number;
  droppedLowPriorityLines: EvidenceTelemetryKey[];
  /** 是否有一行因为单行超出剩余预算而被截成前缀。 */
  partialLine: boolean;
}

interface LLMInputCompactionResult {
  budgetedSectionIds: LLMInputSectionId[];
  budgetedSections: LLMInputSectionBudgetRecord[];
  dedupedLineCounts: Partial<Record<LLMInputSectionId, number>>;
  dedupedSectionIds: LLMInputSectionId[];
  sections: LLMInputSection[];
}

/** 台账投影结果：记录按预算保留了多少条，供 metadata 与诊断使用。 */
interface ProducerSubmitLedgerProjection {
  budgetChars: number;
  entriesOmitted: number;
  shownEntries: number;
  totalEntries: number;
}

/**
 * deterministicEvidenceRefs 的章节投影（I10）：按条目边界装入 evidenceContext 预算后“计划展示”的前缀。
 * 最终是否真的对 provider 可见，以章节压缩之后的文本为准（见 resolveDeterministicEvidenceRefVisibility）。
 */
interface DeterministicEvidenceRefProjection {
  budgetChars: number;
  plannedVisibleRefs: string[];
  totalRefs: number;
}

/** 本轮 provider 实际可见的 deterministicEvidenceRefs；写入 metadata 与 PCV grounding 台账的只增字段。 */
interface DeterministicEvidenceRefVisibility {
  omittedCount: number;
  visibleRefs: string[];
}

interface EvidenceContextBuild {
  deterministicRefs: DeterministicEvidenceRefProjection | null;
  ledger: ProducerSubmitLedgerProjection | null;
  omittedEmptyTelemetry: EvidenceTelemetryKey[];
  section: DraftInputLayerSection;
}

/** 截断标记预留字符数（含换行）；实际标记形如 `...(truncated: 12 line(s) omitted and 1 line cut by 1400-char section budget)`。 */
const TRUNCATION_MARKER_RESERVE = 80;
/** 剩余预算至少这么多时，才把放不下的那一行截成前缀；否则整行丢弃，避免留下无意义的碎片。 */
const MIN_PARTIAL_LINE_CHARS = 120;
/** 台账最多展示的条目数（即使预算还够），与旧实现的 20 条上限一致。 */
const MAX_PRODUCER_LEDGER_ENTRIES = 20;
/** 单条台账标题的展示上限，防止一条超长标题吃掉整个章节预算。 */
const MAX_PRODUCER_LEDGER_TITLE_CHARS = 120;
const PRODUCER_SUBMIT_LEDGER_POLICY =
  'producerSubmitLedgerPolicy: treat payloadStored and requiredFieldsComplete as authoritative runtime facts; do not infer missing fields from compacted provider history.';
const SECTION_BUDGET_DIAGNOSTIC_CODE = 'llm_input_section_budgeted';
/** evidenceContext 中 ref 列表行的固定前缀；可见性解析与宿主按文本查找都依赖它，不要改名。 */
const DETERMINISTIC_REFS_LINE_PREFIX = 'deterministicEvidenceRefs: ';
const DETERMINISTIC_REFS_SEPARATOR = ', ';

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
  // 阶段画像在本次装配中只解析一次（带 toolChoice），grounding 判定与章节预算都复用它，
  // 避免无 toolChoice 的二次解析把 summary-only 阶段误判成 analyze 并注入 grounding 政策。
  const stageProfile = resolveLlmInputStageProfile(ctx, requestedToolChoice, effectiveToolChoice);
  const providerHistoryMessages = projectMessagesForStage(messages, stageProfile);
  const groundingContext = buildGroundingContext(ctx, modelRef, stageProfile);
  // 两个可见章节共享实际Scan补证权限，避免阶段说明允许读、工具说明却随后禁止。
  const scanReadAllowed =
    stringValue(valueAt(ctx.tracker, 'pipelineType')) === 'scan' &&
    ctx.allowedToolIds?.includes('code') &&
    (!ctx.allowedToolActions?.code || ctx.allowedToolActions.code.includes('read'));
  const evidenceContext = buildEvidenceContextSection(ctx, groundingContext, stageProfile);
  const rawInputLayerSections = [
    buildStagePolicySection(stageProfile, ctx, scanReadAllowed, groundingContext.policy),
    buildToolContractSection(
      stageProfile,
      requestedToolChoice,
      effectiveToolChoice,
      tools,
      scanReadAllowed
    ),
    buildTaskContextSection(ctx, modelRef, providerHistoryMessages),
    evidenceContext.section,
    buildDynamicContextSection(dynamicContext),
  ].filter((section): section is DraftInputLayerSection => Boolean(section?.content.trim()));
  const inputCompaction = compactInputLayerSections(
    rawInputLayerSections,
    stageProfile,
    ctx.diagnostics
  );
  const inputLayerSections = inputCompaction.sections;
  // 可见 ref 以压缩后的最终章节文本为准：metadata / PCV 台账只能记录模型真正看到的条目。
  const deterministicRefVisibility = resolveDeterministicEvidenceRefVisibility(
    evidenceContext.deterministicRefs,
    inputLayerSections.find((section) => section.id === 'evidenceContext')?.content ?? '',
    stageProfile,
    ctx.diagnostics
  );
  if (evidenceContext.ledger && evidenceContext.ledger.entriesOmitted > 0) {
    // 台账按“最新优先”只保留预算内的条目；被省略的条数已写进 provider 文本（entriesOmitted=N），
    // 这里再留一条运行级诊断，便于排查模型为何看不到较早的提交。
    const ledger = evidenceContext.ledger;
    warnSectionBudgetOnce(ctx.diagnostics, `${stageProfile}:evidenceContext:ledger`, {
      code: SECTION_BUDGET_DIAGNOSTIC_CODE,
      message:
        `Producer submit ledger kept the newest ${ledger.shownEntries} of ${ledger.totalEntries} entries ` +
        `(entriesOmitted=${ledger.entriesOmitted}) to fit the ${ledger.budgetChars}-char ${stageProfile} evidenceContext budget ` +
        `and the ${MAX_PRODUCER_LEDGER_ENTRIES}-entry cap. ` +
        'Later rounds are recorded in llm.input metadata.inputCompaction.producerSubmitLedger.',
      stage: stageProfile,
    });
  }

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
      // deterministicEvidenceRefs / evidenceStarterRefs 保持“注入候选的完整列表”原含义（宿主按名消费）；
      // 以下两个只增字段记录 provider 实际可见的前缀与被预算省略的条数（I10）。
      deterministicEvidenceRefs: groundingContext.deterministicEvidenceRefs,
      evidenceStarterRefs: groundingContext.evidenceStarterRefs,
      visibleDeterministicEvidenceRefs: deterministicRefVisibility.visibleRefs,
      omittedDeterministicEvidenceRefCount: deterministicRefVisibility.omittedCount,
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
        // 以下为只增字段：区分“去重删行”与“预算截断”，并记录台账保留口径。
        budgetedSections: inputCompaction.budgetedSections,
        dedupedLineCounts: inputCompaction.dedupedLineCounts,
        ...(evidenceContext.ledger ? { producerSubmitLedger: evidenceContext.ledger } : {}),
        ...(evidenceContext.omittedEmptyTelemetry.length > 0
          ? { omittedEmptyTelemetry: evidenceContext.omittedEmptyTelemetry }
          : {}),
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
  const summaries = new Set<UnifiedMessage>();
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

      // 每个请求 id 必须恰好有一条回执；重复 A 不能替代缺失的 B。
      const resultIds = new Set(toolResults.map((result) => result.toolCallId));
      if (
        submitCalls.every((call) => typeof call.id === 'string' && call.id.trim().length > 0) &&
        toolCallIds.size === submitCalls.length &&
        resultIds.size === submitCalls.length &&
        toolResults.length === submitCalls.length
      ) {
        const summary: UnifiedMessage = {
          role: 'user',
          content: formatProducerSubmitHistorySummary(submitCalls, toolResults),
        };
        summaries.add(summary);
        projected.push(summary);
        i = next;
        continue;
      }
    }

    projected.push(message);
    i++;
  }
  return mergeAdjacentProducerSubmitSummaries(projected, summaries);
}

function mergeAdjacentProducerSubmitSummaries(
  messages: UnifiedMessage[],
  summaries: Set<UnifiedMessage>
): UnifiedMessage[] {
  const merged: UnifiedMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      previous?.role === 'user' &&
      message.role === 'user' &&
      // 只合并本次生成的摘要，用户粘贴相同标记仍是原始输入，不能识别成内部可写对象。
      summaries.has(previous) &&
      summaries.has(message)
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
    pipelinePhase.includes('summarize') ||
    // 只有“阶段名含 summary 且本轮禁止工具”才额外视为 summarize；trackerPhase 已由第一项覆盖。
    (effectiveToolChoice === 'none' && pipelinePhase.includes('summary'))
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
  ctx: LoopContext,
  scanReadAllowed: boolean,
  groundingPolicy: string | null
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

  const producerEvidencePolicy = scanReadAllowed
    ? 'Only code.read of already referenced files may supplement evidence; do not start new search, graph, or terminal exploration.'
    : 'Do not start new exploration or read source files; use Analyst evidence/snippets as the source of truth.';
  const bodyByProfile: Record<LLMInputStageProfile, string> = {
    analyze:
      'Analyze real project evidence with discovery tools, then record confirmed findings with note_finding. Final text must summarize recorded note_finding items only: verified finding ids or next evidence action; do not introduce Markdown-only candidate themes, source context, code, or injected evidence.',
    record:
      'Record-only phase. Do not perform additional exploration or emit prose. Use note_finding for already verified findings, one finding per call, citing evidenceRefs from [evidence] annotations. Read-only evidence.get/search may be used to re-check captured evidence before recording.',
    summarize:
      'Summary-only phase. Stop tool use and produce a concise final answer from recorded note_finding items only for confirmed/core sections. Prior messages may provide wording and evidence context, but unrecorded signals must be downgraded to unstructured/pending notes; do not replay full evidence text or introduce Markdown-only candidate themes.',
    produce: `Producer phase. Transform structured Analyst findings into knowledge submissions. Structured findings are the only candidate obligations; do not mine final Markdown for new themes. ${producerEvidencePolicy} Final text: submit counts and blockers only; do not restate submitted candidate content.`,
    generic: 'Follow the current task prompt and runtime tool contract.',
  };

  // CP1 grounding 政策（仅 analyze + guard 时非空）放在 stagePolicy 章节，而不是 evidenceContext：
  // evidenceContext 受 1400 字符预算约束，政策行曾被 ref 列表挤出预算，导致 guard 模式下模型看不到规则、
  // CP4 却照常按规则阻断（I10）。stagePolicy 内容很短、远低于其章节预算，从结构上保证政策对 provider 可见。
  const groundingPolicyLine = groundingPolicy
    ? `evidenceGroundingPolicy: ${groundingPolicy}`
    : null;

  return {
    id: 'stagePolicy',
    title: 'Stage policy',
    content: [profileLine, bodyByProfile[stageProfile], groundingPolicyLine]
      .filter(Boolean)
      .join('\n'),
    providerVisible: true,
    staticCacheable: false,
  };
}

function buildToolContractSection(
  stageProfile: LLMInputStageProfile,
  requestedToolChoice: string,
  effectiveToolChoice: string,
  tools: ToolSchema[] | undefined,
  scanReadAllowed: boolean
): LLMInputSection {
  // tools 必须是本轮实际发给 provider 的工具（selectLlmInputTools 已按 Gateway 的 none 契约剔除），
  // 因此 availableTools 与下面的 summarize 文案只描述真正发出的 schema。
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
      'Only note_finding and read-only evidence.get/search are valid in this stage. If no note_finding schema is available, explain that structured recording is blocked.',
    // 正常 summarize（toolChoice=none）本轮不发送任何 schema；只有 tracker 在 SUMMARIZE 仍放开工具时
    // 才会有 schema 随调用发出，此时明确要求忽略它们，而不是暗示存在“保留下来的” schema。
    summarize: toolNames.length
      ? 'No tool calls are valid. Ignore the tool schemas exposed in this call and return text only.'
      : 'No tool calls are valid and no tool schemas are sent in this call. Return text only.',
    produce: scanReadAllowed
      ? 'Use submission tools for candidate creation. Only code.read of already referenced files may supplement evidence; do not start new search, graph, or terminal exploration.'
      : 'Use submission tools for candidate creation. code.read, search, graph, terminal, and broad exploration are out of scope for Producer.',
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

/**
 * evidenceContext 的行顺序就是预算优先级：
 * 1. 权威事实在前——Producer 台账政策行（先于台账本身）、台账、record-repair 路径、证据 ref；
 * 2. 运行遥测在后——toolCallsSoFar / trackerMetrics / traceStats / planProgress，预算不足时最先整行丢弃。
 * 台账与证据 ref 都按本章节剩余预算在条目边界上装入（台账最新优先、ref 保持原顺序），
 * 保证它们不会被章节截断拦腰切开。grounding 政策不在本章节，见 buildStagePolicySection。
 */
function buildEvidenceContextSection(
  ctx: LoopContext,
  groundingContext: GroundingContext,
  stageProfile: LLMInputStageProfile
): EvidenceContextBuild {
  const lines: string[] = [];
  const lowPriorityLines = new Map<string, EvidenceTelemetryKey>();
  const omittedEmptyTelemetry: EvidenceTelemetryKey[] = [];
  const sectionBudget = sectionBudgetFor(stageProfile, 'evidenceContext');
  // tracker / trace 可能是宿主注入的鸭子类型对象：探针抛错时省略对应遥测行，并经诊断报告来源与原因。
  const probe = { diagnostics: ctx.diagnostics, stageProfile };
  const metrics = safeCall<Record<string, unknown>>(
    () => ctx.tracker?.getMetrics?.(),
    probe,
    'tracker.getMetrics',
    'trackerMetrics'
  );
  const traceStats = safeCall<Record<string, unknown>>(
    () => ctx.trace?.getStats?.(),
    probe,
    'trace.getStats',
    'traceStats'
  );
  const planProgress = safeCall<Record<string, unknown>>(
    () => ctx.tracker?.getPlanProgress?.(),
    probe,
    'tracker.getPlanProgress',
    'planProgress'
  );
  const evidencePaths = Array.isArray(ctx.context?.recordRepairEvidencePaths)
    ? ctx.context.recordRepairEvidencePaths
    : Array.isArray(ctx.sharedState?._recordRepairEvidencePaths)
      ? ctx.sharedState._recordRepairEvidencePaths
      : null;

  const ledger = projectProducerSubmitLedger(
    ctx.sharedState?._producerSubmitLedger,
    // 台账可用预算 = 章节预算 - 已在其前面的权威行 - 截断标记预留；遥测行排在后面，可被整行丢弃。
    sectionBudget - linesFootprint(lines) - TRUNCATION_MARKER_RESERVE,
    sectionBudget
  );
  if (ledger) {
    lines.push(PRODUCER_SUBMIT_LEDGER_POLICY, ...ledger.lines);
  }
  if (evidencePaths?.length) {
    lines.push(`recordRepairEvidencePaths: ${evidencePaths.map(String).join(', ')}`);
  }
  // ref 可用预算 = 章节预算 - 已在其前面的权威行；遥测行排在后面，超预算时先被整行丢弃，
  // 因此装入预算内的 ref 行不会再被尾部截断切开。
  const deterministicRefs = projectDeterministicEvidenceRefs(
    groundingContext,
    sectionBudget - linesFootprint(lines),
    sectionBudget
  );
  if (deterministicRefs) {
    lines.push(...deterministicRefs.lines);
  }

  const pushTelemetry = (key: EvidenceTelemetryKey, text: string) => {
    lines.push(text);
    lowPriorityLines.set(text, key);
  };
  pushTelemetry('toolCallsSoFar', `toolCallsSoFar: ${ctx.toolCalls.length}`);
  if (metrics) {
    pushTelemetry(
      'trackerMetrics',
      `trackerMetrics: ${safeJson(metrics, probe, 'trackerMetrics')}`
    );
  }
  if (traceStats) {
    pushTelemetry('traceStats', `traceStats: ${safeJson(traceStats, probe, 'traceStats')}`);
  }
  if (planProgress) {
    // produce/summarize 不做规划，全零的 planProgress 只占预算不含信息；省略情况记入 metadata。
    if (
      (stageProfile === 'produce' || stageProfile === 'summarize') &&
      isEmptyTelemetryRecord(planProgress)
    ) {
      omittedEmptyTelemetry.push('planProgress');
    } else {
      pushTelemetry(
        'planProgress',
        `planProgress: ${safeJson(planProgress, probe, 'planProgress')}`
      );
    }
  }

  return {
    deterministicRefs: deterministicRefs?.projection ?? null,
    ledger: ledger?.projection ?? null,
    omittedEmptyTelemetry,
    section: {
      id: 'evidenceContext',
      title: 'Evidence context',
      content: lines.join('\n'),
      providerVisible: true,
      staticCacheable: false,
      lowPriorityLines,
    },
  };
}

function isEmptyTelemetryRecord(value: Record<string, unknown>): boolean {
  return Object.values(value).every(
    (item) =>
      item === null ||
      item === undefined ||
      item === 0 ||
      item === false ||
      item === '' ||
      (Array.isArray(item) && item.length === 0)
  );
}

/**
 * 把 sharedState._producerSubmitLedger 投影成每条一行的紧凑文本（最新优先）。
 * 只保留模型判断“哪些候选已创建、字段是否完整”所需的字段，去掉 uuid id 等噪声；
 * 标题经 JSON 转义保证单行。条目按可用预算贪心装入，放不下的较早条目以 entriesOmitted=N 明示。
 */
function projectProducerSubmitLedger(
  value: unknown,
  availableChars: number,
  sectionBudget: number
): { lines: string[]; projection: ProducerSubmitLedgerProjection } | null {
  if (!isRecord(value)) {
    return null;
  }
  const entries = Array.isArray(value.entries) ? value.entries.filter(isRecord) : [];
  if (entries.length === 0) {
    return null;
  }
  const totalEntries = entries.length;
  const headerFor = (omitted: number) =>
    [
      'producerSubmitLedger:',
      typeof value.createdCount === 'number' ? `createdCount=${value.createdCount}` : null,
      typeof value.targetSubmits === 'number' ? `targetSubmits=${value.targetSubmits}` : null,
      `entries=${totalEntries}`,
      'order=newest-first',
      omitted > 0 ? `entriesOmitted=${omitted} (older entries not shown)` : null,
    ]
      .filter(Boolean)
      .join(' ');
  // 用“全部省略”时的表头长度做上界估算，表头数字位数变化不会让最终文本超出预算。
  let remaining =
    availableChars -
    (PRODUCER_SUBMIT_LEDGER_POLICY.length + 1) -
    (headerFor(totalEntries).length + 1);
  const entryLines: string[] = [];
  // 台账按提交顺序追加（同名替换保留原位），所以从数组尾部开始取就是最新优先。
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entryLines.length >= MAX_PRODUCER_LEDGER_ENTRIES) {
      break;
    }
    const line = formatProducerLedgerEntry(entries[index]);
    if (line.length + 1 > remaining) {
      break;
    }
    entryLines.push(line);
    remaining -= line.length + 1;
  }
  const entriesOmitted = totalEntries - entryLines.length;
  return {
    lines: [headerFor(entriesOmitted), ...entryLines],
    projection: {
      budgetChars: sectionBudget,
      entriesOmitted,
      shownEntries: entryLines.length,
      totalEntries,
    },
  };
}

function formatProducerLedgerEntry(entry: Record<string, unknown>): string {
  const status = (stringValue(entry.status) || 'unknown').replace(/\s+/g, '_').slice(0, 32);
  const rawTitle = stringValue(entry.title) || 'unknown';
  const title =
    rawTitle.length > MAX_PRODUCER_LEDGER_TITLE_CHARS
      ? `${rawTitle.slice(0, MAX_PRODUCER_LEDGER_TITLE_CHARS)}…`
      : rawTitle;
  return [
    `- ${status}`,
    JSON.stringify(title),
    `requiredFieldsComplete=${ledgerFlag(entry.requiredFieldsComplete)}`,
    `payloadStored=${ledgerFlag(entry.payloadStored)}`,
    `sourceCount=${typeof entry.sourceCount === 'number' ? entry.sourceCount : 'unknown'}`,
  ].join(' ');
}

function ledgerFlag(value: unknown): string {
  return typeof value === 'boolean' ? String(value) : 'unknown';
}

/** 一组行在章节里占用的字符数（每行按“行内容 + 换行”计，略保守）。 */
function linesFootprint(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

/**
 * 把 deterministicEvidenceRefs 投影成章节行（I10）：
 * - ref 列表只输出一次。buildGroundingContext 把 starter ref 放在 deterministic 列表最前面
 *   （uniqueStrings 保序，starter 上限 24 < 列表上限 32），starter 列表恒为其前缀，
 *   所以只用一行短标注说明前几条来自 evidence starters，不再重复输出整条 starter 列表。
 * - 放不下全部条目时，按原顺序在条目边界上贪心装入前缀，并用一行 deterministicEvidenceRefsOmitted
 *   明示省略条数，不再让章节截断把某条 ref 切成半截。
 */
function projectDeterministicEvidenceRefs(
  groundingContext: GroundingContext,
  availableChars: number,
  sectionBudget: number
): { lines: string[]; projection: DeterministicEvidenceRefProjection } | null {
  const refs = groundingContext.deterministicEvidenceRefs;
  if (refs.length === 0) {
    return null;
  }
  const starterCount = groundingContext.evidenceStarterRefs.length;
  const starterNote = (count: number): string | null =>
    count > 0
      ? `evidenceStarterRefs: the first ${count} deterministicEvidenceRefs above come from evidence starters (not repeated)`
      : null;
  const omittedNote = (omitted: number): string | null =>
    omitted > 0
      ? `deterministicEvidenceRefsOmitted: ${omitted} of ${refs.length} refs not shown (${sectionBudget}-char evidenceContext budget, cut at entry boundaries)`
      : null;
  const render = (shown: readonly string[]): string[] =>
    [
      shown.length > 0
        ? `${DETERMINISTIC_REFS_LINE_PREFIX}${shown.join(DETERMINISTIC_REFS_SEPARATOR)}`
        : null,
      starterNote(Math.min(starterCount, shown.length)),
      omittedNote(refs.length - shown.length),
    ].filter((line): line is string => Boolean(line));

  let shown: string[] = refs;
  if (linesFootprint(render(refs)) > availableChars) {
    // 按标注行的最长形态预留（条数位数不超过总数 / starter 数的位数），再从头装入完整条目。
    let remaining =
      availableChars -
      (DETERMINISTIC_REFS_LINE_PREFIX.length + 1) -
      linesFootprint(
        [starterNote(starterCount), omittedNote(refs.length)].filter((line): line is string =>
          Boolean(line)
        )
      );
    shown = [];
    for (const ref of refs) {
      const cost = ref.length + (shown.length > 0 ? DETERMINISTIC_REFS_SEPARATOR.length : 0);
      if (cost > remaining) {
        break;
      }
      shown.push(ref);
      remaining -= cost;
    }
  }
  return {
    lines: render(shown),
    projection: {
      budgetChars: sectionBudget,
      plannedVisibleRefs: shown,
      totalRefs: refs.length,
    },
  };
}

/**
 * 以压缩后的最终 evidenceContext 文本为准解析 provider 实际可见的 ref（I10）。
 * 只认 ref 行里与计划条目逐字相同的完整条目；被截成前缀（带 …）或整行被去重 / 截掉的条目都不算可见。
 * 省略时发一次章节预算诊断；计划内条目在压缩中丢失属于异常路径，单独告警便于定位。
 */
function resolveDeterministicEvidenceRefVisibility(
  projection: DeterministicEvidenceRefProjection | null,
  finalEvidenceContext: string,
  stageProfile: LLMInputStageProfile,
  diagnostics: LoopContext['diagnostics'] | undefined
): DeterministicEvidenceRefVisibility {
  if (!projection) {
    return { omittedCount: 0, visibleRefs: [] };
  }
  const planned = new Set(projection.plannedVisibleRefs);
  const refsLine = finalEvidenceContext
    .split('\n')
    .find((line) => line.startsWith(DETERMINISTIC_REFS_LINE_PREFIX));
  const visibleRefs = refsLine
    ? refsLine
        .slice(DETERMINISTIC_REFS_LINE_PREFIX.length)
        .split(DETERMINISTIC_REFS_SEPARATOR)
        .filter((entry) => planned.has(entry))
    : [];
  const omittedCount = projection.totalRefs - visibleRefs.length;
  if (visibleRefs.length < projection.plannedVisibleRefs.length) {
    // 装入预算的 ref 行理论上不会被压缩切掉；出现说明前面的权威行（如超长 recordRepairEvidencePaths）
    // 已超出章节预算，或同一行已在更早章节出现而被去重。
    warnSectionBudgetOnce(
      diagnostics,
      `${stageProfile}:evidenceContext:deterministicEvidenceRefs:compaction`,
      {
        code: SECTION_BUDGET_DIAGNOSTIC_CODE,
        message:
          `deterministicEvidenceRefs planned ${projection.plannedVisibleRefs.length} visible refs but only ` +
          `${visibleRefs.length} survived ${stageProfile} evidenceContext compaction ` +
          `(refs line ${refsLine ? 'cut' : 'dropped or deduplicated'}). ` +
          'The surviving set is recorded in llm.input metadata.visibleDeterministicEvidenceRefs.',
        stage: stageProfile,
      }
    );
  }
  if (omittedCount > 0) {
    warnSectionBudgetOnce(
      diagnostics,
      `${stageProfile}:evidenceContext:deterministicEvidenceRefs`,
      {
        code: SECTION_BUDGET_DIAGNOSTIC_CODE,
        message:
          `deterministicEvidenceRefs showed ${visibleRefs.length} of ${projection.totalRefs} refs ` +
          `(omitted=${omittedCount}) within the ${projection.budgetChars}-char ${stageProfile} evidenceContext budget, ` +
          'cut at entry boundaries. Every round records its visible set in llm.input ' +
          'metadata.visibleDeterministicEvidenceRefs and the PCV grounding ledger.',
        stage: stageProfile,
      }
    );
  }
  return { omittedCount, visibleRefs };
}

interface GroundingContext {
  deterministicEvidenceRefs: string[];
  evidenceStarterRefs: string[];
  policy: string | null;
}

function buildGroundingContext(
  ctx: LoopContext,
  modelRef: string,
  stageProfile: LLMInputStageProfile
): GroundingContext {
  const evidenceStarters = ctx.context?.evidenceStarters;
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
      ctx.sharedState?._recordRepairEvidencePaths,
      ctx.sharedState?.referencedFiles,
    ]),
  ]).slice(0, 32);
  // CP1 grounding-policy 注入仅在 grounding enforcement = 'guard' 时生效（AP-3 切默认）；
  // 默认 'off' 下 analyze 全路径都不注入政策文本（PCV observe-only）。
  // PD5：deterministicEvidenceRefs / evidenceStarterRefs 注入不随此开关，始终保留为默认 analyze 上下文。
  // stageProfile 由 buildLlmInputAssembly 带 toolChoice 解析一次后传入，与 provider 看到的 stagePolicy 一致。
  const policy =
    ctx.groundingEnforcement === 'guard' && stageProfile === 'analyze'
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

/**
 * 章节压缩：跨章节逐行去重 + 章节字符预算。顺序与口径：
 * 1. 去重只“判定”不“登记”：与之前章节（或本章节更早的行）逐字相同的长行被删除；
 * 2. 预算在行边界上执行：先按 EVIDENCE_TELEMETRY_DROP_ORDER 整行丢低优先级遥测行，仍超出才从尾部整行截断；
 *    只有剩余预算足够时才把放不下的那一行截成前缀；
 * 3. 只把最终完整保留的行登记进 seenBlocks——被预算截掉的行不会让后续章节里的同一行被误删。
 * dedupedSectionIds 只统计真实删除了重复行的章节；预算截断单独记录在 budgetedSections 并发诊断。
 */
function compactInputLayerSections(
  sections: DraftInputLayerSection[],
  stageProfile: LLMInputStageProfile,
  diagnostics: LoopContext['diagnostics'] | undefined
): LLMInputCompactionResult {
  const seenBlocks = new Set<string>();
  const dedupedSectionIds: LLMInputSectionId[] = [];
  const dedupedLineCounts: Partial<Record<LLMInputSectionId, number>> = {};
  const budgetedSectionIds: LLMInputSectionId[] = [];
  const budgetedSections: LLMInputSectionBudgetRecord[] = [];
  const compacted = sections.map((draft) => {
    const { lowPriorityLines, ...section } = draft;
    const deduped = compactRepeatedBlocks(section.content, seenBlocks);
    if (deduped.droppedLines > 0) {
      dedupedSectionIds.push(section.id);
      dedupedLineCounts[section.id] = deduped.droppedLines;
    }
    const maxChars = sectionBudgetFor(stageProfile, section.id);
    const budgeted = applySectionBudget(deduped.paragraphs, maxChars, lowPriorityLines);
    for (const line of budgeted.keptLines) {
      if (line.key) {
        seenBlocks.add(line.key);
      }
    }
    if (budgeted.record) {
      const record: LLMInputSectionBudgetRecord = {
        sectionId: section.id,
        maxChars,
        originalChars: section.content.length,
        keptChars: budgeted.content.length,
        ...budgeted.record,
      };
      budgetedSectionIds.push(section.id);
      budgetedSections.push(record);
      // 同一诊断收集器（通常即一次 loop）里同阶段同章节只告警一次，避免每轮都刷 warning；
      // 每一轮的截断细节仍完整记录在 llm.input 过程事件的 metadata.inputCompaction.budgetedSections。
      warnSectionBudgetOnce(diagnostics, `${stageProfile}:${section.id}:lines`, {
        code: SECTION_BUDGET_DIAGNOSTIC_CODE,
        message:
          `LLM input section ${section.id} exceeded the ${maxChars}-char ${stageProfile} budget ` +
          `(${record.originalChars} -> ${record.keptChars} chars): dropped low-priority lines ` +
          `[${record.droppedLowPriorityLines.join(', ') || 'none'}], dropped ${record.droppedLines} line(s) in total` +
          `${record.partialLine ? ', cut one line to a prefix' : ''}. ` +
          'Later rounds are recorded in llm.input metadata.inputCompaction.budgetedSections.',
        stage: stageProfile,
      });
    }
    return { ...section, content: budgeted.content };
  });
  return {
    budgetedSectionIds,
    budgetedSections,
    dedupedLineCounts,
    dedupedSectionIds,
    sections: compacted,
  };
}

interface CompactionLine {
  /** 去重键；短行（< 48 字符）为 null，不参与去重。 */
  key: string | null;
  text: string;
}

interface SectionBudgetResult {
  content: string;
  /** 最终完整保留的行（被截成前缀的行不算），只有它们会登记进 seenBlocks。 */
  keptLines: CompactionLine[];
  record: Pick<
    LLMInputSectionBudgetRecord,
    'droppedLines' | 'droppedLowPriorityLines' | 'partialLine'
  > | null;
}

function renderParagraphs(paragraphs: CompactionLine[][]): string {
  return paragraphs
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.map((line) => line.text).join('\n'))
    .join('\n\n');
}

function applySectionBudget(
  paragraphs: CompactionLine[][],
  maxChars: number,
  lowPriorityLines: ReadonlyMap<string, EvidenceTelemetryKey> | undefined
): SectionBudgetResult {
  const content = renderParagraphs(paragraphs);
  if (content.length <= maxChars) {
    return { content, keptLines: paragraphs.flat(), record: null };
  }

  // 第一步：整行丢弃低优先级遥测行（按固定顺序，够了就停）。
  let working = paragraphs.map((lines) => [...lines]);
  const droppedLowPriorityLines: EvidenceTelemetryKey[] = [];
  let droppedLines = 0;
  if (lowPriorityLines && lowPriorityLines.size > 0) {
    for (const telemetryKey of EVIDENCE_TELEMETRY_DROP_ORDER) {
      if (renderParagraphs(working).length <= maxChars) {
        break;
      }
      const before = working.reduce((total, lines) => total + lines.length, 0);
      working = working.map((lines) =>
        lines.filter((line) => lowPriorityLines.get(line.text) !== telemetryKey)
      );
      const removed = before - working.reduce((total, lines) => total + lines.length, 0);
      if (removed > 0) {
        droppedLowPriorityLines.push(telemetryKey);
        droppedLines += removed;
      }
    }
  }
  const afterLowPriority = renderParagraphs(working);
  if (afterLowPriority.length <= maxChars) {
    return {
      content: afterLowPriority,
      keptLines: working.flat(),
      record: { droppedLines, droppedLowPriorityLines, partialLine: false },
    };
  }

  // 第二步：仍超出时从尾部按行截断，为截断标记预留空间。
  const limit = Math.max(0, maxChars - TRUNCATION_MARKER_RESERVE);
  const keptParagraphs: CompactionLine[][] = [];
  const keptLines: CompactionLine[] = [];
  let length = 0;
  let hasKeptLine = false;
  let partialLine = false;
  let stopped = false;
  let tailDropped = 0;
  for (const lines of working.filter((paragraphLines) => paragraphLines.length > 0)) {
    if (stopped) {
      tailDropped += lines.length;
      continue;
    }
    const paragraphLines: CompactionLine[] = [];
    for (const line of lines) {
      if (stopped) {
        tailDropped++;
        continue;
      }
      // 行间分隔：段内 '\n'，新段落 '\n\n'，首行无分隔。
      const separator = !hasKeptLine ? 0 : paragraphLines.length > 0 ? 1 : 2;
      if (length + separator + line.text.length <= limit) {
        paragraphLines.push(line);
        keptLines.push(line);
        length += separator + line.text.length;
        hasKeptLine = true;
        continue;
      }
      stopped = true;
      const remaining = limit - length - separator;
      if (remaining >= MIN_PARTIAL_LINE_CHARS) {
        // 单行放不下但剩余预算可观：保留前缀（不登记去重键，完整行在后续章节出现时仍保留）。
        const prefix = cutLineAtSoftBoundary(line.text, remaining);
        paragraphLines.push({ key: null, text: prefix });
        length += separator + prefix.length;
        partialLine = true;
      } else {
        tailDropped++;
      }
    }
    if (paragraphLines.length > 0) {
      keptParagraphs.push(paragraphLines);
    }
  }
  droppedLines += tailDropped;
  const marker = `...(truncated: ${tailDropped} line(s) omitted${partialLine ? ' and 1 line cut' : ''} by ${maxChars}-char section budget)`;
  const kept = renderParagraphs(keptParagraphs);
  return {
    content: kept ? `${kept}\n${marker}` : marker,
    keptLines,
    record: { droppedLines, droppedLowPriorityLines, partialLine },
  };
}

/** 把一行截成不超过 maxChars 的前缀，尽量停在逗号或空格处，并以 … 标明被截断。 */
function cutLineAtSoftBoundary(text: string, maxChars: number): string {
  const hard = text.slice(0, Math.max(0, maxChars - 1));
  const boundary = Math.max(hard.lastIndexOf(', '), hard.lastIndexOf(' '));
  const cut = boundary >= Math.floor(hard.length * 0.6) ? hard.slice(0, boundary) : hard;
  return `${cut.trimEnd()}…`;
}

/** 每个诊断收集器已发出的章节预算告警键；WeakMap 随收集器（即一次 loop）回收。 */
const emittedSectionBudgetWarnings = new WeakMap<object, Set<string>>();

function warnSectionBudgetOnce(
  diagnostics: LoopContext['diagnostics'] | undefined,
  key: string,
  warning: AgentDiagnosticWarning
): void {
  // 鸭子类型 ctx（测试或宿主注入）可能没有诊断收集器；此时截断信息只保留在 metadata 中。
  if (!diagnostics || typeof diagnostics.warn !== 'function') {
    return;
  }
  let emitted = emittedSectionBudgetWarnings.get(diagnostics);
  if (!emitted) {
    emitted = new Set<string>();
    emittedSectionBudgetWarnings.set(diagnostics, emitted);
  }
  if (emitted.has(key)) {
    return;
  }
  emitted.add(key);
  diagnostics.warn(warning);
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

/**
 * 跨章节逐行去重：只读判定 seenBlocks（之前章节最终保留的行），本章节内的重复用局部集合判定。
 * 这里不登记 seenBlocks——要等预算决定哪些行最终保留后，由 compactInputLayerSections 登记。
 * droppedLines 只统计真实删除的重复行；空段落 / 多余空行的规整不计入去重口径。
 */
function compactRepeatedBlocks(
  text: string,
  seenBlocks: ReadonlySet<string>
): { droppedLines: number; paragraphs: CompactionLine[][] } {
  const localBlocks = new Set<string>();
  const paragraphs: CompactionLine[][] = [];
  let droppedLines = 0;
  for (const paragraph of text.split(/\n{2,}/)) {
    const compactedLines: CompactionLine[] = [];
    for (const line of paragraph.split('\n')) {
      const key = normalizeCompactionBlock(line);
      if (key && (seenBlocks.has(key) || localBlocks.has(key))) {
        droppedLines++;
        continue;
      }
      compactedLines.push({ key, text: line });
      if (key) {
        localBlocks.add(key);
      }
    }
    if (
      compactedLines
        .map((line) => line.text)
        .join('\n')
        .trim()
    ) {
      paragraphs.push(compactedLines);
    }
  }
  return { droppedLines, paragraphs };
}

function normalizeCompactionBlock(text: string): string | null {
  // 代码/路径的大小写、缩进和后续限定语都可能改变语义；仅去除逐字重复的完整行。
  return text.trim().length >= 48 ? text : null;
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

const CONTEXT_PROBE_FAILED_CODE = 'llm_input_context_probe_failed';
/** 诊断里错误原文的展示上限；完整堆栈不进入运行诊断。 */
const MAX_PROBE_ERROR_CHARS = 200;

/** evidenceContext 遥测探针的诊断上下文；diagnostics 缺省（鸭子类型 ctx）时只降级、不报告。 */
interface EvidenceContextProbe {
  diagnostics: LoopContext['diagnostics'] | undefined;
  stageProfile: LLMInputStageProfile;
}

/** 每个诊断收集器已报告过的探针失败键；同一 loop 内重复失败只报一次，避免每轮刷屏。 */
const emittedContextProbeWarnings = new WeakMap<object, Set<string>>();

/**
 * 读取 tracker / trace 遥测。宿主注入的鸭子类型对象可能在读取时抛错：
 * 此时降级为“省略该遥测行”（返回 null），并发 llm_input_context_probe_failed，
 * 消息里写明探针来源、被省略的行和错误原文，排查时能看出模型为何缺少阶段进度信息。
 */
function safeCall<T>(
  fn: () => T | null | undefined,
  probe: EvidenceContextProbe,
  source: string,
  telemetryKey: EvidenceTelemetryKey
): T | null {
  try {
    return fn() ?? null;
  } catch (err: unknown) {
    warnContextProbeFailed(
      probe,
      source,
      `${source} threw; the ${telemetryKey} line was omitted from the ${probe.stageProfile} evidenceContext`,
      err
    );
    return null;
  }
}

/**
 * 遥测 JSON 化。指标里含 BigInt、toJSON 抛错等不可序列化成员时，仍保留旧的占位文本
 * （provider 输入形状不变），同时发诊断说明是哪一行、因何退化。
 */
function safeJson(
  value: unknown,
  probe: EvidenceContextProbe,
  telemetryKey: EvidenceTelemetryKey
): string {
  try {
    return JSON.stringify(value);
  } catch (err: unknown) {
    warnContextProbeFailed(
      probe,
      `serialize:${telemetryKey}`,
      `${telemetryKey} could not be serialized; the line was replaced with "[unserializable]" in the ${probe.stageProfile} evidenceContext`,
      err
    );
    return '"[unserializable]"';
  }
}

function warnContextProbeFailed(
  probe: EvidenceContextProbe,
  source: string,
  detail: string,
  err: unknown
): void {
  const { diagnostics, stageProfile } = probe;
  if (!diagnostics || typeof diagnostics.warn !== 'function') {
    return;
  }
  let emitted = emittedContextProbeWarnings.get(diagnostics);
  if (!emitted) {
    emitted = new Set<string>();
    emittedContextProbeWarnings.set(diagnostics, emitted);
  }
  const key = `${stageProfile}:${source}`;
  if (emitted.has(key)) {
    return;
  }
  emitted.add(key);
  diagnostics.warn({
    code: CONTEXT_PROBE_FAILED_CODE,
    message:
      `LLM input evidenceContext probe failed (${source}): ${detail}. ` +
      `Error: ${describeProbeError(err)}. Reported once per diagnostics collector and stage.`,
    stage: stageProfile,
  });
}

/** 非 Error 的抛出值也可能 String() 失败，此时给固定描述；结果截断到展示上限。 */
function describeProbeError(err: unknown): string {
  let text: string;
  if (err instanceof Error) {
    text = err.message || err.name;
  } else {
    try {
      text = String(err);
    } catch (stringifyErr: unknown) {
      text =
        stringifyErr instanceof Error
          ? `unprintable ${typeof err} (${stringifyErr.message})`
          : `unprintable ${typeof err}`;
    }
  }
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > MAX_PROBE_ERROR_CHARS
    ? `${singleLine.slice(0, MAX_PROBE_ERROR_CHARS)}…`
    : singleLine;
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
