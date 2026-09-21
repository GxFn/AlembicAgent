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
    if (action === 'degrade' || action === 'degraded_no_findings') {
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
    for (const warning of input.warnings || []) {
      this.warn(warning);
    }
    for (const stage of input.timedOutStages || []) {
      this.recordTimedOutStage(stage);
    }
    for (const blockedTool of input.blockedTools || []) {
      this.recordBlockedTool(blockedTool.tool, blockedTool.reason);
    }
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
    for (const gateFailure of input.gateFailures || []) {
      this.recordGateFailure(gateFailure.stage, gateFailure.action, gateFailure.reason);
    }
    for (const toolCall of input.toolCalls || []) {
      const calls = (this.#diagnostics.toolCalls ??= []);
      if (!calls.some((call) => call.callId === toolCall.callId)) {
        calls.push({ ...toolCall });
      }
    }
    for (const toolset of input.stageToolsets || []) {
      this.recordStageToolset(toolset);
    }
    if (input.efficiency) {
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
      if (input.efficiency.cancelReason) {
        target.cancelReason = input.efficiency.cancelReason;
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
