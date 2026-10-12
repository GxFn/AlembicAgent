import type { ToolDiagnosticsRecorder, ToolResultEnvelope } from '#tools/kernel/index.js';
import type {
  AgentDiagnostics,
  AgentDiagnosticWarning,
  AgentEfficiencySummary,
  StageToolsetDiagnostic,
  ToolCallDiagnostic,
} from './AgentRuntimeTypes.js';

function emptyEfficiency(): AgentEfficiencySummary {
  return {
    toolCalls: 0,
    duplicateToolCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    tokenUsage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheHit: 0,
    },
    maxCompactionLevel: 0,
    totalCompactedItems: 0,
    nudgeCount: 0,
    replanCount: 0,
    emptyRetries: 0,
    forcedSummary: false,
  };
}

function emptyDiagnostics(): AgentDiagnostics {
  return {
    degraded: false,
    fallbackUsed: false,
    warnings: [],
    timedOutStages: [],
    blockedTools: [],
    truncatedToolCalls: 0,
    emptyResponses: 0,
    aiErrorCount: 0,
    gateFailures: [],
    efficiency: emptyEfficiency(),
  };
}

function isDiagnostics(value: unknown): value is Partial<AgentDiagnostics> {
  return !!value && typeof value === 'object';
}

/**
 * degrade 类门动作的单一谓词：`degrade` 与所有 `degraded_*`（degraded_no_findings、
 * degraded_budget_exhausted 及后续新增）都是终态降级。DiagnosticsCollector.recordGateFailure
 * 与 PipelineStrategy.#storeGateResult 共用它，避免两处集合漂移（此前 recordGateFailure
 * 漏掉 degraded_budget_exhausted，只靠策略显式 markDegraded 兜底）。
 */
export function isDegradeGateAction(action: string): boolean {
  return action === 'degrade' || action.startsWith('degraded_');
}

// ── merge 外部边界的形状守卫 ──
// 公开入参 AgentRunExecutionOptions.diagnostics / ReactLoopOpts.diagnostics 类型都是 unknown，
// 自定义策略回执也会经由 merge 进入；这里只校验运行时真正会解引用/展开的字段，
// 合法的 AgentDiagnostics 快照（含 toJSON 产物）全部通过，不改变既有行为。

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDiagnosticWarning(value: unknown): value is AgentDiagnosticWarning {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

function isStage(value: unknown): value is string {
  return typeof value === 'string';
}

function isBlockedTool(value: unknown): value is { tool: string; reason: string } {
  return isRecord(value) && typeof value.tool === 'string' && typeof value.reason === 'string';
}

function isGateFailure(
  value: unknown
): value is { stage: string; action: string; reason?: string } {
  return (
    isRecord(value) &&
    typeof value.stage === 'string' &&
    typeof value.action === 'string' &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}

function isToolCallDiagnostic(value: unknown): value is ToolCallDiagnostic {
  // callId 是去重键，没有它条目既无法合并也无法回放；其余字段按快照原样透传。
  return isRecord(value) && typeof value.callId === 'string';
}

function isStageToolsetDiagnostic(value: unknown): value is StageToolsetDiagnostic {
  if (!isRecord(value) || typeof value.stage !== 'string') {
    return false;
  }
  if (!isStringArray(value.capabilities) || !isStringArray(value.allowedToolIds)) {
    return false;
  }
  if (value.allowedToolActions === undefined) {
    return true;
  }
  // recordStageToolset 会对每个 action 列表做展开，值不是数组就会在复制时抛错。
  return (
    isRecord(value.allowedToolActions) &&
    Object.values(value.allowedToolActions).every((actions) => Array.isArray(actions))
  );
}

function describeReceived(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

export class DiagnosticsCollector implements ToolDiagnosticsRecorder {
  #diagnostics: AgentDiagnostics;

  constructor(seed?: Partial<AgentDiagnostics>) {
    this.#diagnostics = emptyDiagnostics();
    if (seed) {
      this.merge(seed);
    }
  }

  static from(value: unknown) {
    if (value instanceof DiagnosticsCollector) {
      return value;
    }
    return new DiagnosticsCollector(isDiagnostics(value) ? value : undefined);
  }

  #readCount(value: unknown, field: string): number {
    if (value === undefined) {
      return 0;
    }
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
    // opts / strategy 回执属于外部边界；坏计数只降级诊断字段，不中断实际任务。
    const received =
      typeof value === 'number' ? String(value) : value === null ? 'null' : typeof value;
    this.warn({
      code: 'diagnostics_invalid_count',
      message: `Ignored ${field}: expected a finite non-negative number, received ${received}`,
    });
    return 0;
  }

  #addCount(current: number, value: unknown, field: string): number {
    const total = current + this.#readCount(value, field);
    if (Number.isFinite(total)) {
      return total;
    }
    this.warn({
      code: 'diagnostics_invalid_count',
      message: `Ignored ${field}: addition would overflow a finite diagnostic count; previous total retained`,
    });
    return current;
  }

  #warnInvalidEntry(field: string, expected: string, value: unknown) {
    // 与 #readCount 同一原则：畸形诊断只降级为可见警告，不中断实际任务；
    // 消息里带字段名与收到的类型，便于定位是哪一个外部调用方传了坏形状。
    this.warn({
      code: 'diagnostics_invalid_entry',
      message: `Ignored ${field}: expected ${expected}, received ${describeReceived(value)}`,
    });
  }

  #mergeArray<T>(
    value: unknown,
    field: string,
    expected: string,
    guard: (item: unknown) => item is T,
    apply: (item: T) => void
  ) {
    // undefined 表示字段缺省（toJSON 会省略可选数组），静默跳过；其它非数组值一律告警。
    if (value === undefined) {
      return;
    }
    if (!Array.isArray(value)) {
      this.#warnInvalidEntry(field, 'an array', value);
      return;
    }
    value.forEach((item, index) => {
      if (guard(item)) {
        apply(item);
      } else {
        this.#warnInvalidEntry(`${field}[${index}]`, expected, item);
      }
    });
  }

  markDegraded() {
    this.#diagnostics.degraded = true;
  }

  markFallbackUsed() {
    this.#diagnostics.fallbackUsed = true;
  }

  warn(warning: AgentDiagnosticWarning) {
    this.#diagnostics.warnings.push({ ...warning });
  }

  recordTimedOutStage(stage: string) {
    if (!this.#diagnostics.timedOutStages.includes(stage)) {
      this.#diagnostics.timedOutStages.push(stage);
    }
  }

  recordBlockedTool(tool: string, reason: string) {
    this.#diagnostics.blockedTools.push({ tool, reason });
  }

  recordTruncatedToolCalls(count: number) {
    this.#diagnostics.truncatedToolCalls = this.#addCount(
      this.#diagnostics.truncatedToolCalls,
      count,
      'truncatedToolCalls'
    );
  }

  recordEmptyResponse() {
    this.#diagnostics.emptyResponses++;
  }

  recordEmptyRetry() {
    this.#diagnostics.efficiency ??= emptyEfficiency();
    this.#diagnostics.efficiency.emptyRetries++;
  }

  recordAiError(message: string) {
    this.#diagnostics.aiErrorCount++;
    this.warn({ code: 'ai_error', message });
  }

  recordGateFailure(stage: string, action: string, reason?: string) {
    this.#diagnostics.gateFailures.push({ stage, action, ...(reason ? { reason } : {}) });
    if (isDegradeGateAction(action)) {
      this.markDegraded();
    }
  }

  recordStageToolset(toolset: StageToolsetDiagnostic) {
    const entries = (this.#diagnostics.stageToolsets ??= []);
    entries.push({
      stage: toolset.stage,
      capabilities: [...toolset.capabilities],
      allowedToolIds: [...toolset.allowedToolIds],
      ...(toolset.allowedToolActions
        ? {
            allowedToolActions: Object.fromEntries(
              Object.entries(toolset.allowedToolActions).map(([tool, actions]) => [
                tool,
                [...actions],
              ])
            ),
          }
        : {}),
      toolSchemaCount: toolset.toolSchemaCount,
      ...(toolset.source ? { source: toolset.source } : {}),
    });
  }

  /**
   * 逐调用轨迹（AgentDiagnostics.toolCalls）的生产写入方是 runtimeBridge 的 recordExecutedEnvelope：
   * 每个拿到路由信封的 runtime 调用都会经 loopCtx.diagnostics 写入这里，所以它不是空通道
   * （L5-P47 / I45 核对；LightweightRouter 删除后的接线见 runtimeBridge）。ToolDiagnosticsRecorder
   * 端口与 toolCalls 字段是否继续公开，随待决事项②决定。
   */
  recordToolCallEnvelope(
    envelope: ToolResultEnvelope,
    context: {
      kind?: string;
      surface?: string;
      source?: string;
    } = {}
  ) {
    const calls = (this.#diagnostics.toolCalls ??= []);
    const entry: ToolCallDiagnostic = {
      tool: envelope.toolId,
      callId: envelope.callId,
      ...(envelope.parentCallId ? { parentCallId: envelope.parentCallId } : {}),
      status: envelope.status,
      ok: envelope.ok,
      ...(context.surface ? { surface: context.surface } : {}),
      ...(context.source ? { source: context.source } : {}),
      ...(context.kind ? { kind: context.kind } : {}),
      startedAt: envelope.startedAt,
      durationMs: envelope.durationMs,
    };
    const existingIndex = calls.findIndex((call) => call.callId === envelope.callId);
    if (existingIndex >= 0) {
      calls[existingIndex] = entry;
    } else {
      calls.push(entry);
    }
  }

  recordEfficiencyToolCall(
    input: { cacheHit?: boolean; cacheMiss?: boolean; duplicateShortCircuit?: boolean } = {}
  ) {
    this.#diagnostics.efficiency ??= emptyEfficiency();
    this.#diagnostics.efficiency.toolCalls++;
    if (input.duplicateShortCircuit) {
      this.#diagnostics.efficiency.duplicateToolCalls++;
    }
    if (input.cacheHit) {
      this.#diagnostics.efficiency.cacheHits++;
    }
    if (input.cacheMiss) {
      this.#diagnostics.efficiency.cacheMisses++;
    }
  }

  recordTokenUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheHitTokens?: number;
  }) {
    const target = (this.#diagnostics.efficiency ??= emptyEfficiency()).tokenUsage;
    target.input = this.#addCount(target.input, usage.inputTokens, 'efficiency.tokenUsage.input');
    target.output = this.#addCount(
      target.output,
      usage.outputTokens,
      'efficiency.tokenUsage.output'
    );
    target.reasoning = this.#addCount(
      target.reasoning,
      usage.reasoningTokens,
      'efficiency.tokenUsage.reasoning'
    );
    target.cacheHit = this.#addCount(
      target.cacheHit,
      usage.cacheHitTokens,
      'efficiency.tokenUsage.cacheHit'
    );
  }

  recordCompaction(result: { level?: number; removed?: number }) {
    const efficiency = (this.#diagnostics.efficiency ??= emptyEfficiency());
    const level = this.#readCount(result.level, 'efficiency.maxCompactionLevel');
    efficiency.maxCompactionLevel = Math.max(efficiency.maxCompactionLevel, level);
    efficiency.totalCompactedItems = this.#addCount(
      efficiency.totalCompactedItems,
      result.removed,
      'efficiency.totalCompactedItems'
    );
  }

  recordNudge(input: { type?: string; isReplan?: boolean } = {}) {
    this.#diagnostics.efficiency ??= emptyEfficiency();
    this.#diagnostics.efficiency.nudgeCount++;
    if (input.isReplan) {
      this.#diagnostics.efficiency.replanCount++;
    }
  }

  recordForcedSummary() {
    this.#diagnostics.efficiency ??= emptyEfficiency();
    this.#diagnostics.efficiency.forcedSummary = true;
  }

  recordCancelReason(reason: string) {
    this.#diagnostics.efficiency ??= emptyEfficiency();
    this.#diagnostics.efficiency.cancelReason = reason;
  }

  merge(input: unknown) {
    if (!isDiagnostics(input)) {
      return;
    }

    if (input.degraded) {
      this.markDegraded();
    }
    if (input.fallbackUsed) {
      this.markFallbackUsed();
    }
    this.#mergeArray(
      input.warnings,
      'warnings',
      'a warning with string code/message',
      isDiagnosticWarning,
      (warning) => this.warn(warning)
    );
    this.#mergeArray(
      input.timedOutStages,
      'timedOutStages',
      'a stage name string',
      isStage,
      (stage) => this.recordTimedOutStage(stage)
    );
    this.#mergeArray(
      input.blockedTools,
      'blockedTools',
      'an entry with string tool/reason',
      isBlockedTool,
      (blockedTool) => this.recordBlockedTool(blockedTool.tool, blockedTool.reason)
    );
    // 合并聚合计数只做一次加法，耗时不随策略提供的计数值增长。
    this.#diagnostics.truncatedToolCalls = this.#addCount(
      this.#diagnostics.truncatedToolCalls,
      input.truncatedToolCalls,
      'truncatedToolCalls'
    );
    this.#diagnostics.emptyResponses = this.#addCount(
      this.#diagnostics.emptyResponses,
      input.emptyResponses,
      'emptyResponses'
    );
    this.#diagnostics.aiErrorCount = this.#addCount(
      this.#diagnostics.aiErrorCount,
      input.aiErrorCount,
      'aiErrorCount'
    );
    this.#mergeArray(
      input.gateFailures,
      'gateFailures',
      'an entry with string stage/action',
      isGateFailure,
      (gateFailure) =>
        this.recordGateFailure(gateFailure.stage, gateFailure.action, gateFailure.reason)
    );
    this.#mergeArray(
      input.toolCalls,
      'toolCalls',
      'an entry with string callId',
      isToolCallDiagnostic,
      (toolCall) => {
        const calls = (this.#diagnostics.toolCalls ??= []);
        if (!calls.some((call) => call.callId === toolCall.callId)) {
          calls.push({ ...toolCall });
        }
      }
    );
    this.#mergeArray(
      input.stageToolsets,
      'stageToolsets',
      'an entry with string stage and string[] capabilities/allowedToolIds',
      isStageToolsetDiagnostic,
      (toolset) => this.recordStageToolset(toolset)
    );
    if (input.efficiency !== undefined && !isRecord(input.efficiency)) {
      this.#warnInvalidEntry('efficiency', 'an object', input.efficiency);
    } else if (input.efficiency) {
      const target = (this.#diagnostics.efficiency ??= emptyEfficiency());
      for (const field of [
        'toolCalls',
        'duplicateToolCalls',
        'cacheHits',
        'cacheMisses',
        'totalCompactedItems',
        'nudgeCount',
        'replanCount',
        'emptyRetries',
      ] as const) {
        target[field] = this.#addCount(
          target[field],
          input.efficiency[field],
          `efficiency.${field}`
        );
      }
      for (const field of ['input', 'output', 'reasoning', 'cacheHit'] as const) {
        target.tokenUsage[field] = this.#addCount(
          target.tokenUsage[field],
          input.efficiency.tokenUsage?.[field],
          `efficiency.tokenUsage.${field}`
        );
      }
      target.maxCompactionLevel = Math.max(
        target.maxCompactionLevel,
        this.#readCount(input.efficiency.maxCompactionLevel, 'efficiency.maxCompactionLevel')
      );
      target.forcedSummary = target.forcedSummary || input.efficiency.forcedSummary === true;
      // cancelReason 会原样投影到结果与宿主报表，只接受字符串；空串沿用旧行为视为未取消。
      const cancelReason: unknown = input.efficiency.cancelReason;
      if (typeof cancelReason === 'string') {
        if (cancelReason) {
          target.cancelReason = cancelReason;
        }
      } else if (cancelReason !== undefined) {
        this.#warnInvalidEntry('efficiency.cancelReason', 'a string', cancelReason);
      }
    }
  }

  isEmpty() {
    const efficiency = this.#diagnostics.efficiency;
    const efficiencyEmpty =
      !efficiency ||
      (efficiency.toolCalls === 0 &&
        efficiency.duplicateToolCalls === 0 &&
        efficiency.cacheHits === 0 &&
        efficiency.cacheMisses === 0 &&
        efficiency.tokenUsage.input === 0 &&
        efficiency.tokenUsage.output === 0 &&
        efficiency.tokenUsage.reasoning === 0 &&
        efficiency.tokenUsage.cacheHit === 0 &&
        efficiency.maxCompactionLevel === 0 &&
        efficiency.totalCompactedItems === 0 &&
        efficiency.nudgeCount === 0 &&
        efficiency.replanCount === 0 &&
        efficiency.emptyRetries === 0 &&
        !efficiency.forcedSummary &&
        !efficiency.cancelReason);
    return (
      !this.#diagnostics.degraded &&
      !this.#diagnostics.fallbackUsed &&
      this.#diagnostics.warnings.length === 0 &&
      this.#diagnostics.timedOutStages.length === 0 &&
      this.#diagnostics.blockedTools.length === 0 &&
      this.#diagnostics.truncatedToolCalls === 0 &&
      this.#diagnostics.emptyResponses === 0 &&
      this.#diagnostics.aiErrorCount === 0 &&
      this.#diagnostics.gateFailures.length === 0 &&
      (this.#diagnostics.toolCalls?.length || 0) === 0 &&
      (this.#diagnostics.stageToolsets?.length || 0) === 0 &&
      efficiencyEmpty
    );
  }

  toJSON(): AgentDiagnostics {
    const efficiency = this.#diagnostics.efficiency ?? emptyEfficiency();
    return {
      degraded: this.#diagnostics.degraded,
      fallbackUsed: this.#diagnostics.fallbackUsed,
      // 公开快照拥有自己的条目，调用方修改回执不能反写运行中的诊断收集器。
      warnings: this.#diagnostics.warnings.map((warning) => ({ ...warning })),
      timedOutStages: [...this.#diagnostics.timedOutStages],
      blockedTools: this.#diagnostics.blockedTools.map((tool) => ({ ...tool })),
      truncatedToolCalls: this.#diagnostics.truncatedToolCalls,
      emptyResponses: this.#diagnostics.emptyResponses,
      aiErrorCount: this.#diagnostics.aiErrorCount,
      gateFailures: this.#diagnostics.gateFailures.map((failure) => ({ ...failure })),
      ...(this.#diagnostics.toolCalls
        ? { toolCalls: this.#diagnostics.toolCalls.map((call) => ({ ...call })) }
        : {}),
      ...(this.#diagnostics.stageToolsets
        ? {
            stageToolsets: this.#diagnostics.stageToolsets.map((toolset) => ({
              ...toolset,
              capabilities: [...toolset.capabilities],
              allowedToolIds: [...toolset.allowedToolIds],
              ...(toolset.allowedToolActions
                ? {
                    allowedToolActions: Object.fromEntries(
                      Object.entries(toolset.allowedToolActions).map(([tool, actions]) => [
                        tool,
                        [...actions],
                      ])
                    ),
                  }
                : {}),
            })),
          }
        : {}),
      efficiency: {
        toolCalls: efficiency.toolCalls,
        duplicateToolCalls: efficiency.duplicateToolCalls,
        cacheHits: efficiency.cacheHits,
        cacheMisses: efficiency.cacheMisses,
        tokenUsage: { ...efficiency.tokenUsage },
        maxCompactionLevel: efficiency.maxCompactionLevel,
        totalCompactedItems: efficiency.totalCompactedItems,
        nudgeCount: efficiency.nudgeCount,
        replanCount: efficiency.replanCount,
        emptyRetries: efficiency.emptyRetries,
        forcedSummary: efficiency.forcedSummary,
        ...(efficiency.cancelReason ? { cancelReason: efficiency.cancelReason } : {}),
      },
    };
  }
}
