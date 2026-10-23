/**
 * Tool decision contract — allow/deny verdict produced by the router's explain
 * stage. Canonical home (formerly src/tools/core/ToolDecision.ts).
 *
 * 只有类型（W2a-02 / L3-P10）：原来的 allowToolDecision/denyToolDecision 辅助函数没有生产调用方
 * （router.ts 与 ToolRouterAdapter 都直接构造 ToolDecision 字面量），已随事项②删除。
 */

export type ToolDecisionStage = 'discover' | 'plan' | 'approve' | 'execute';
export type ToolDecisionResultStatus = 'blocked' | 'aborted' | 'timeout' | 'needs-confirmation';

export interface ToolExecutionPreview {
  kind: string;
  summary: string;
  risk?: 'low' | 'medium' | 'high';
  details: Record<string, unknown>;
}

export interface ToolDecision {
  allowed: boolean;
  stage: ToolDecisionStage;
  reason?: string;
  resultStatus?: ToolDecisionResultStatus;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
  requestId?: string;
  policyProfile?: string;
  auditLevel?: string;
  preview?: ToolExecutionPreview;
}
