import type { ToolDecision } from '#tools/kernel/decision.js';
import type { ParsedToolCall, ToolResult } from '#tools/kernel/registry.js';

/** 预检与排队后重检共用拒绝事实：没有进入 handler，写入尚未开始。 */
export function toolAdmissionFailure(call: ParsedToolCall, decision: ToolDecision): ToolResult {
  const reason = decision.reason || 'Tool call not allowed';
  return {
    ok: false,
    error: reason,
    data: {
      code:
        decision.stage === 'approve'
          ? 'TOOL_ACTION_DENIED'
          : decision.stage === 'execute'
            ? 'TOOL_UNAVAILABLE'
            : 'TOOL_CALL_INVALID',
      status: decision.resultStatus ?? 'error',
      tool: call.tool,
      action: call.action,
      reason,
      writeState: 'not-started',
      requiresReadback: false,
    },
    _meta: {
      cached: false,
      durationMs: 0,
      tokensEstimate: 0,
      resultStatus: decision.resultStatus,
      diagnosticWarnings: [{ code: 'tool_preflight_rejected', message: reason, tool: call.tool }],
    },
  };
}
