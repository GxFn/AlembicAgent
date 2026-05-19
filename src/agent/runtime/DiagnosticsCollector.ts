import type { ToolDiagnosticsRecorder } from '#tools/core/ToolCallContext.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
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

  markDegraded() {
    this.#diagnostics.degraded = true;
  }

  markFallbackUsed() {
    this.#diagnostics.fallbackUsed = true;
  }

  warn(warning: AgentDiagnosticWarning) {
    this.#diagnostics.warnings.push(warning);
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
    if (count > 0) {
      this.#diagnostics.truncatedToolCalls += count;
    }
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
    if (action === 'degrade') {
      this.markDegraded();
    }
  }

  recordStageToolset(toolset: StageToolsetDiagnostic) {
    const entries = (this.#diagnostics.stageToolsets ??= []);
    entries.push({
      stage: toolset.stage,
      capabilities: [...toolset.capabilities],
      allowedToolIds: [...toolset.allowedToolIds],
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
    this.#diagnostics.efficiency ??= emptyEfficiency();
    this.#diagnostics.efficiency.tokenUsage.input += usage.inputTokens || 0;
    this.#diagnostics.efficiency.tokenUsage.output += usage.outputTokens || 0;
    this.#diagnostics.efficiency.tokenUsage.reasoning += usage.reasoningTokens || 0;
    this.#diagnostics.efficiency.tokenUsage.cacheHit += usage.cacheHitTokens || 0;
  }

  recordCompaction(result: { level?: number; removed?: number }) {
    this.#diagnostics.efficiency ??= emptyEfficiency();
    const level = result.level || 0;
    if (level > this.#diagnostics.efficiency.maxCompactionLevel) {
      this.#diagnostics.efficiency.maxCompactionLevel = level;
    }
    this.#diagnostics.efficiency.totalCompactedItems += result.removed || 0;
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
    this.recordTruncatedToolCalls(input.truncatedToolCalls || 0);
    for (let index = 0; index < (input.emptyResponses || 0); index++) {
      this.recordEmptyResponse();
    }
    for (let index = 0; index < (input.aiErrorCount || 0); index++) {
      this.#diagnostics.aiErrorCount++;
    }
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
      target.toolCalls += input.efficiency.toolCalls || 0;
      target.duplicateToolCalls += input.efficiency.duplicateToolCalls || 0;
      target.cacheHits += input.efficiency.cacheHits || 0;
      target.cacheMisses += input.efficiency.cacheMisses || 0;
      target.tokenUsage.input += input.efficiency.tokenUsage?.input || 0;
      target.tokenUsage.output += input.efficiency.tokenUsage?.output || 0;
      target.tokenUsage.reasoning += input.efficiency.tokenUsage?.reasoning || 0;
      target.tokenUsage.cacheHit += input.efficiency.tokenUsage?.cacheHit || 0;
      target.maxCompactionLevel = Math.max(
        target.maxCompactionLevel,
        input.efficiency.maxCompactionLevel || 0
      );
      target.totalCompactedItems += input.efficiency.totalCompactedItems || 0;
      target.nudgeCount += input.efficiency.nudgeCount || 0;
      target.replanCount += input.efficiency.replanCount || 0;
      target.emptyRetries += input.efficiency.emptyRetries || 0;
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
      warnings: [...this.#diagnostics.warnings],
      timedOutStages: [...this.#diagnostics.timedOutStages],
      blockedTools: [...this.#diagnostics.blockedTools],
      truncatedToolCalls: this.#diagnostics.truncatedToolCalls,
      emptyResponses: this.#diagnostics.emptyResponses,
      aiErrorCount: this.#diagnostics.aiErrorCount,
      gateFailures: [...this.#diagnostics.gateFailures],
      ...(this.#diagnostics.toolCalls
        ? { toolCalls: this.#diagnostics.toolCalls.map((call) => ({ ...call })) }
        : {}),
      ...(this.#diagnostics.stageToolsets
        ? {
            stageToolsets: this.#diagnostics.stageToolsets.map((toolset) => ({
              ...toolset,
              capabilities: [...toolset.capabilities],
              allowedToolIds: [...toolset.allowedToolIds],
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
