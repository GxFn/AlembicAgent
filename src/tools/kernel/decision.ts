/**
 * Tool decision contract — allow/deny verdict produced by the router's explain
 * stage. Canonical home (formerly src/tools/core/ToolDecision.ts).
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

export function allowToolDecision(stage: ToolDecisionStage, extras: Partial<ToolDecision> = {}) {
  // 显式裁决参数是事实；extras只补诊断/确认元数据，不能反转权限或替换执行阶段。
  return { ...extras, allowed: true, stage };
}

export function denyToolDecision(
  stage: ToolDecisionStage,
  reason: string,
  extras: Partial<ToolDecision> = {}
) {
  return { ...extras, allowed: false, stage, reason };
}
