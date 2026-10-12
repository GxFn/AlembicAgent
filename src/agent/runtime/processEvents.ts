/**
 * 开发者过程事件的纯投影：内容格式、隐藏推理省略、脱敏与完整度字段在同一处维护。
 * 只接收本次普通数据快照；时钟、PCV读取/写入、Hook、发送通道和业务状态仍归Runtime。
 * 返回对象保持可写，HookSystem可以继续在发送前附加hookErrors，不能冻结为新协议。
 */
import { redactDeveloperText } from '../utils/Redaction.js';
import type {
  AgentProgressProcessEvent,
  FunctionCall,
  LLMResult,
  ToolMetadata,
} from './AgentRuntimeTypes.js';
import type { LLMInputAssembly } from './LLMInputAssembly.js';
import type { LLMInputAssemblyMeasurement } from './LLMInputMeasurement.js';

export interface ProcessEventOrigin {
  readonly createdAt: string;
  readonly iteration: number;
  readonly source: string;
  readonly phase: string | null;
  readonly dimensionId: string | null;
  readonly targetName: string | null;
  readonly pcvNodeEvidence: unknown;
}

export type ProcessEventInput = {
  kind: AgentProgressProcessEvent['kind'];
  title: string;
  summary?: string | null;
  content?: AgentProgressProcessEvent['content'];
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
  phase?: string | null;
  retention?: AgentProgressProcessEvent['retention'];
  severity?: AgentProgressProcessEvent['severity'];
  sourceClass?: AgentProgressProcessEvent['sourceClass'];
  displayPolicy?: AgentProgressProcessEvent['displayPolicy'];
};

export function createAgentProcessEvent(
  origin: ProcessEventOrigin,
  input: ProcessEventInput
): AgentProgressProcessEvent {
  return {
    content: input.content ?? null,
    correlationId: input.correlationId ?? null,
    createdAt: origin.createdAt,
    dimensionId: origin.dimensionId,
    displayPolicy: input.displayPolicy ?? 'full',
    kind: input.kind,
    metadata: sanitizeDeveloperData({
      iteration: origin.iteration,
      source: origin.source,
      pcvNodeEvidence: origin.pcvNodeEvidence,
      ...(input.metadata || {}),
    }) as Record<string, unknown>,
    phase: origin.phase,
    retention: input.retention ?? 'job-retained',
    severity: input.severity ?? 'info',
    sourceClass: input.sourceClass ?? 'developer-facing',
    summary: input.summary ?? null,
    targetName: origin.targetName,
    title: input.title,
  };
}

/** 工具事件只投影已经确定的调用/显示数据，调用和发送顺序仍由Runtime控制。 */
export function projectToolStartEvent(call: FunctionCall, source: string): ProcessEventInput {
  return {
    kind: 'tool',
    title: `Tool call started: ${call.name}`,
    summary: `Calling tool ${call.name}`,
    content: { role: 'developer', text: formatToolCallForDeveloperContent(call.name, call.args) },
    correlationId: call.id,
    metadata: { toolName: call.name, callId: call.id, source, status: 'started' },
  };
}

export function projectToolEndEvent(
  call: FunctionCall,
  metadata: Pick<ToolMetadata, 'durationMs' | 'cacheHit' | 'cacheMiss'>,
  resultText: string,
  succeeded: boolean,
  source: string
): ProcessEventInput {
  return {
    kind: 'tool',
    title: `Tool call ${succeeded ? 'completed' : 'failed'}: ${call.name}`,
    summary: `${call.name} ${succeeded ? 'completed' : 'failed'} in ${metadata.durationMs}ms`,
    content: { role: 'tool', text: redactDeveloperText(resultText) },
    correlationId: call.id,
    severity: succeeded ? 'success' : 'error',
    metadata: {
      toolName: call.name,
      callId: call.id,
      status: succeeded ? 'ok' : 'error',
      durationMs: metadata.durationMs,
      resultSize: resultText.length,
      cacheHit: metadata.cacheHit,
      cacheMiss: metadata.cacheMiss === true,
      source,
    },
  };
}

export function projectLlmInputEvent(
  assembly: LLMInputAssembly,
  measurement: LLMInputAssemblyMeasurement,
  options: {
    trace: Readonly<Record<string, unknown>>;
    modelRef: string;
    dynamicContext: string | null;
    requestedToolChoice: string;
    effectiveToolChoice: string;
  }
): ProcessEventInput {
  return {
    kind: 'llm.input',
    title: 'LLM input prepared',
    summary: `Sending ${assembly.providerMessages.length} message(s) to ${options.modelRef}`,
    content: { role: 'developer', text: formatDeveloperVisibleLlmInput(assembly) },
    metadata: {
      ...options.trace,
      messageCount: assembly.providerMessages.length,
      hasDynamicContext: Boolean(options.dynamicContext),
      requestedToolChoice: options.requestedToolChoice,
      effectiveToolChoice: options.effectiveToolChoice,
      inputSizeEstimate: {
        inputLayer: measurement.inputLayerEstimatedTokens,
        providerHistory: measurement.providerHistoryEstimatedTokens,
        providerMessages: measurement.providerMessageEstimatedTokens,
        systemPrompt: measurement.systemPromptEstimatedTokens,
        toolSchemas: measurement.toolSchemaEstimatedTokens,
      },
      toolSchemaNames: (assembly.tools || []).map((schema) => schema.name),
      ...assembly.metadata,
    },
  };
}

export function projectLlmOutput(result: LLMResult): {
  event: ProcessEventInput;
  completeness: LlmOutputCompletenessMetadata;
} {
  const text = redactDeveloperText(
    result.text || formatFunctionCallsForDeveloperContent(result.functionCalls || [])
  );
  const completeness = buildLlmOutputCompletenessMetadata(result, text);
  return {
    completeness,
    event: {
      kind: 'llm.output',
      title: 'LLM output received',
      summary: formatLlmOutputSummary(result, completeness),
      content: { role: 'assistant', text },
    },
  };
}

export function projectSemanticNudgeEvent(
  nudge: { type: string; text: string },
  origin: Readonly<
    Pick<ProcessEventOrigin, 'dimensionId' | 'targetName' | 'source' | 'phase'> & {
      pipelineType: string | null;
    }
  >,
  requestedSemanticKind?: string
): ProcessEventInput {
  const semanticKind = requestedSemanticKind ?? classifySemanticNudgeKind(nudge.type);
  return {
    kind: 'llm.reflection',
    title: formatSemanticNudgeTitle(nudge, semanticKind, origin.phase),
    summary: formatSemanticNudgeSummary(nudge, semanticKind, origin.phase),
    phase: origin.phase,
    content: { role: 'developer', text: redactDeveloperText(nudge.text) },
    metadata: {
      dimensionId: origin.dimensionId,
      nudgeType: nudge.type,
      phase: origin.phase,
      pipelineType: origin.pipelineType,
      semanticKind,
      source: origin.source,
      targetName: origin.targetName,
    },
  };
}

type LlmOutputCompletenessStatus =
  | 'visible_text_complete'
  | 'provider_truncated'
  | 'tool_call_only'
  | 'empty';

interface LlmOutputCompletenessMetadata extends Record<string, unknown> {
  agentOutputTruncated: false;
  developerContentChars: number;
  finishReason: string | null;
  functionCallCount: number;
  functionCallNames: string[];
  hasHiddenReasoningContent: boolean;
  hasText: boolean;
  outputCompleteness: LlmOutputCompletenessStatus;
  providerOutputTruncated: boolean;
  reasoningContentChars: number;
  reasoningContentOmitted: boolean;
  reasoningTokens: number;
  textChars: number;
  usage: LLMResult['usage'] | null;
  visibleTextChars: number;
}

function buildLlmOutputCompletenessMetadata(
  result: LLMResult,
  developerContentText: string
): LlmOutputCompletenessMetadata {
  const visibleTextChars = result.text?.length || 0;
  const functionCalls = result.functionCalls || [];
  const functionCallCount = functionCalls.length;
  const reasoningContentChars = result.reasoningContent?.length || 0;
  const reasoningTokens = result.usage?.reasoningTokens || 0;
  const finishReason = normalizeFinishReason(result.finishReason);
  const providerOutputTruncated = isProviderOutputTruncated(finishReason);
  const reasoningContentOmitted =
    reasoningContentChars > 0 || reasoningTokens > 0 || Boolean(result.continuation);

  return {
    agentOutputTruncated: false,
    developerContentChars: developerContentText.length,
    finishReason,
    functionCallCount,
    functionCallNames: functionCalls.map((call) => call.name).slice(0, 12),
    hasHiddenReasoningContent: reasoningContentOmitted,
    hasText: visibleTextChars > 0,
    outputCompleteness: providerOutputTruncated
      ? 'provider_truncated'
      : visibleTextChars > 0
        ? 'visible_text_complete'
        : functionCallCount > 0
          ? 'tool_call_only'
          : 'empty',
    providerOutputTruncated,
    reasoningContentChars,
    reasoningContentOmitted,
    reasoningTokens,
    textChars: visibleTextChars,
    usage: result.usage || null,
    visibleTextChars,
  };
}

function formatLlmOutputSummary(
  result: LLMResult,
  metadata: LlmOutputCompletenessMetadata
): string {
  if (metadata.visibleTextChars > 0) {
    const suffixes: string[] = [];
    if (metadata.providerOutputTruncated) {
      suffixes.push(`provider stopped with finishReason=${metadata.finishReason}`);
    }
    if (metadata.reasoningContentOmitted) {
      suffixes.push('hidden reasoning omitted');
    }
    return [`Received ${metadata.visibleTextChars} visible character(s)`, ...suffixes].join('; ');
  }
  if (metadata.functionCallCount > 0) {
    return `Received ${metadata.functionCallCount} tool call(s) without visible text`;
  }
  if (metadata.providerOutputTruncated) {
    return `Received empty LLM output; provider stopped with finishReason=${metadata.finishReason}`;
  }
  return `Received empty LLM output from provider${result.finishReason ? ` (finishReason=${result.finishReason})` : ''}`;
}

function normalizeFinishReason(finishReason: string | null | undefined): string | null {
  const normalized = finishReason?.trim();
  return normalized ? normalized : null;
}

function isProviderOutputTruncated(finishReason: string | null): boolean {
  if (!finishReason) {
    return false;
  }
  return new Set(['length', 'max_tokens', 'max_output_tokens']).has(finishReason.toLowerCase());
}

function classifySemanticNudgeKind(type: string): string {
  switch (type) {
    case 'transition':
      return 'transition-nudge';
    case 'digest':
      return 'digest-nudge';
    case 'continue':
      return 'continue-nudge';
    case 'planning':
    case 'replan':
      return 'planning-nudge';
    case 'convergence':
      return 'convergence-nudge';
    case 'evidence_grounding':
      // AgentRuntime 发射证据门事件时会显式传 semanticKind；这里补齐同一映射，
      // 让未显式传 kind 的调用不会把证据门拦截误归为普通反思。
      return 'evidence-grounding-nudge';
    default:
      return 'reflection-nudge';
  }
}

function formatSemanticNudgeTitle(
  nudge: { type: string; text: string },
  semanticKind: string,
  phase: string | null
): string {
  if (semanticKind === 'transition-nudge') {
    return phase ? `Agent 阶段转换 Nudge: ${phase}` : 'Agent 阶段转换 Nudge';
  }
  if (semanticKind === 'digest-nudge') {
    return 'Agent 总结 Nudge';
  }
  if (semanticKind === 'continue-nudge') {
    return 'Agent 继续执行 Nudge';
  }
  if (semanticKind === 'planning-nudge') {
    return isReplanNudge(nudge) ? 'Agent 重新计划 Nudge' : 'Agent 计划检查 Nudge';
  }
  if (semanticKind === 'convergence-nudge') {
    return 'Agent 收敛检查 Nudge';
  }
  if (semanticKind === 'evidence-grounding-nudge') {
    return 'Agent 证据门 Nudge';
  }
  if (nudge.text.includes('停滞反思')) {
    return 'Agent 停滞反思';
  }
  if (nudge.text.includes('中期反思')) {
    return 'Agent 中期反思';
  }
  return 'Agent 反思 Nudge';
}

function formatSemanticNudgeSummary(
  nudge: { type: string; text: string },
  semanticKind: string,
  phase: string | null
): string {
  if (semanticKind === 'transition-nudge') {
    return phase ? `阶段机切换后注入 ${phase} 阶段指令。` : '阶段机切换后注入下一阶段指令。';
  }
  if (semanticKind === 'digest-nudge') {
    return '要求 Agent 停止探索并产出 dimensionDigest 或最终分析摘要。';
  }
  if (semanticKind === 'continue-nudge') {
    return '要求 Agent 基于当前回复继续推进，而不是结束本轮执行。';
  }
  if (semanticKind === 'planning-nudge') {
    return isReplanNudge(nudge)
      ? '计划进度回顾或偏差检查触发重新计划，要求 Agent 根据当前进度更新后续步骤。'
      : '要求 Agent 在开始探索前先用编号列表给出探索计划。';
  }
  if (semanticKind === 'convergence-nudge') {
    return '连续多轮没有新信息或有效新提交，引导 Agent 收敛：停止重复探索，输出总结或只提交剩余候选。';
  }
  if (semanticKind === 'evidence-grounding-nudge') {
    return 'analyze 阶段的结论没有引用证据，已被证据门阻断并回滚本轮，要求 Agent 先取证再下结论。';
  }
  if (nudge.text.includes('停滞反思')) {
    return '检测到连续无新信息，注入停滞反思。';
  }
  if (nudge.text.includes('中期反思')) {
    return '达到中期预算节点，注入阶段性反思。';
  }
  return `Injected ${nudge.type} semantic nudge before the next LLM step.`;
}

/**
 * PlanTracker 的初始计划征集与 replan 都以 type='planning' 发出（DiagnosticsCollector 另按
 * iteration>1 计 replan），投影拿不到 iteration，只能从 nudge 本身区分：显式 type='replan'，
 * 或正文带 PlanTracker replan 文案的固定标记（周期回顾“计划进度回顾”、偏差/bootstrap“计划偏差检查”）。
 * 初始征集文案不含这两个标记。标记与 PlanTracker 文案的耦合由 runtime-efficiency.test.ts
 * 用真实 PlanTracker 输出守护；文案改动后测试会失败，而不是静默把 replan 显示成计划检查。
 */
const REPLAN_TEXT_MARKERS = ['计划进度回顾', '计划偏差检查'] as const;

function isReplanNudge(nudge: { type: string; text: string }): boolean {
  if (nudge.type === 'replan') {
    return true;
  }
  return REPLAN_TEXT_MARKERS.some((marker) => nudge.text.includes(marker));
}

function formatDeveloperVisibleLlmInput(assembly: LLMInputAssembly): string {
  const sections = assembly.sections.map((section) => {
    const suffix = section.staticCacheable ? ' (static)' : '';
    return `## ${section.title}${suffix}\n${redactDeveloperText(section.content)}`;
  });
  sections.push(
    [
      '## Messages',
      ...assembly.messages.map((message, index) => formatDeveloperVisibleMessage(message, index)),
    ].join('\n\n')
  );
  if (assembly.inputLayerMessage) {
    sections.push(
      `## Provider runtime layer\n${redactDeveloperText(assembly.inputLayerMessage.content || '')}`
    );
  }
  if (assembly.tools?.length) {
    sections.push(
      [
        '## Available tools',
        ...assembly.tools.map((tool) =>
          [
            `### ${tool.name}`,
            tool.description ? redactDeveloperText(tool.description) : null,
            tool.parameters ? `parameters:\n${stringifyDeveloperData(tool.parameters)}` : null,
          ]
            .filter(Boolean)
            .join('\n')
        ),
      ].join('\n\n')
    );
  }
  return sections.join('\n\n');
}

function formatDeveloperVisibleMessage(
  message: import('#ai/AiProvider.js').UnifiedMessage,
  index: number
): string {
  const lines = [`### ${index + 1}. ${message.role}${message.name ? ` (${message.name})` : ''}`];
  if (message.content) {
    lines.push(redactDeveloperText(message.content));
  }
  if (message.toolCalls?.length) {
    lines.push(
      [
        'tool calls:',
        ...message.toolCalls.map(
          (call) => `- ${call.name} (${call.id}): ${stringifyDeveloperData(call.args)}`
        ),
      ].join('\n')
    );
  }
  if (message.toolCallId) {
    lines.push(`toolCallId: ${message.toolCallId}`);
  }
  if (message.reasoningContent || message.continuation) {
    lines.push('[hidden reasoning omitted]');
  }
  return lines.join('\n');
}

function formatFunctionCallsForDeveloperContent(
  calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
): string {
  if (calls.length === 0) {
    return '';
  }
  return [
    'LLM requested tool calls:',
    ...calls.map(
      (call) =>
        `- ${call.name || 'unknown'} (${call.id || 'no-id'}): ${stringifyDeveloperData(call.args || {})}`
    ),
  ].join('\n');
}

function formatToolCallForDeveloperContent(toolName: string, args: Record<string, unknown>) {
  return [`tool: ${toolName}`, 'args:', stringifyDeveloperData(args)].join('\n');
}

export function isDeveloperVisibleReflectionNudge(type: string): boolean {
  return (
    type === 'reflection' ||
    type === 'planning' ||
    type === 'replan' ||
    type === 'convergence' ||
    type === 'digest' ||
    type === 'continue'
  );
}

/** 退化文本中错误原因的展示上限。 */
const MAX_DEVELOPER_DATA_ERROR_CHARS = 160;

function stringifyDeveloperData(value: unknown): string {
  try {
    if (value === undefined) {
      return 'undefined';
    }
    return JSON.stringify(sanitizeDeveloperData(value), null, 2);
  } catch (err: unknown) {
    // 退化路径：BigInt、toJSON 抛错等让 JSON 化失败。本模块是纯投影、不持有日志与诊断通道，
    // 所以把失败原因直接写进开发者可见文本，时间线上能看出为何只剩字符串形式而不是结构化参数。
    return redactDeveloperText(
      `[developer data not serializable: ${describeDeveloperDataError(err)}] ${stringifyFallback(value)}`
    );
  }
}

function describeDeveloperDataError(err: unknown): string {
  let text: string;
  if (err instanceof Error) {
    text = `${err.name}: ${err.message}`;
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
  return text.length > MAX_DEVELOPER_DATA_ERROR_CHARS
    ? `${text.slice(0, MAX_DEVELOPER_DATA_ERROR_CHARS)}…`
    : text;
}

/** 无原型对象等会让 String() 也抛错；此时退回类型描述，保证投影本身绝不抛出。 */
function stringifyFallback(value: unknown): string {
  try {
    return String(value);
  } catch (err: unknown) {
    return `[${typeof value}: ${err instanceof Error ? err.message : 'not printable'}]`;
  }
}

/**
 * 递归脱敏开发者数据。ancestors 是“当前递归路径上的祖先栈”，不是“已访问集合”：
 * 只有对象在自己的子树里再次出现（真循环）才替换为 '[Circular]'；同一对象被多个字段共享
 * （DAG，如 {a: x, b: x}、pcvNodeEvidence 与调用方 metadata 共用子对象）时每处都保留真实内容。
 * 子树处理完（含异常退出）即出栈，保证兄弟分支看到的祖先栈不受影响。
 */
function sanitizeDeveloperData(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactDeveloperText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (ancestors.has(value)) {
    return '[Circular]';
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeDeveloperData(item, ancestors));
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      output[key] =
        isSecretLikeKey(key) && !isSafeNumericTokenMetric(key, child)
          ? '[redacted]'
          : sanitizeDeveloperData(child, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function isSecretLikeKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|authorization|credential/i.test(key);
}

function isSafeNumericTokenMetric(key: string, value: unknown): boolean {
  // token 计数是 developer-safe 观测指标；真实 token / key 字段仍按 isSecretLikeKey 脱敏。
  return (
    typeof value === 'number' &&
    /^(inputTokens|outputTokens|totalTokens|reasoningTokens|cacheHitTokens|cacheWriteTokens)$/.test(
      key
    )
  );
}
