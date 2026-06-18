/**
 * Tool request + router contract — the call request, execution request, and the
 * ToolRouterContract implemented by both the Agent tool router and the
 * host-surface router. Canonical home (formerly src/tools/core/ToolContracts.ts).
 */

import type { CapabilityKind, ToolCapabilityManifest } from '../catalog/CapabilityManifest.js';
import type {
  ToolActor,
  ToolCallContext,
  ToolCallSource,
  ToolRuntimeCallContext,
  ToolSurface,
} from './context.js';
import type { ToolDecision, ToolExecutionPreview } from './decision.js';
import type { ToolResultEnvelope } from './result.js';

export interface ToolCallRequest {
  toolId: string;
  args: Record<string, unknown>;
  surface: ToolSurface;
  actor: ToolActor;
  source: ToolCallSource;
  parentCallId?: string;
  abortSignal?: AbortSignal | null;
  runtime?: ToolRuntimeCallContext;
  governance?: {
    gatewayAction?: string | null;
    gatewayResource?: string;
    gatewayData?: Record<string, unknown>;
  };
}

export interface ToolExecutionRequest {
  manifest: ToolCapabilityManifest;
  args: Record<string, unknown>;
  context: ToolCallContext;
  decision: ToolDecision;
}

export interface ToolExecutionPreviewRequest {
  manifest: ToolCapabilityManifest;
  args: Record<string, unknown>;
  projectRoot: string;
}

export interface ToolExecutionAdapter {
  readonly kind: CapabilityKind;
  preview?(request: ToolExecutionPreviewRequest): ToolExecutionPreview | null;
  execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope>;
}

export interface ToolRouterContract {
  execute(request: ToolCallRequest): Promise<ToolResultEnvelope>;
  executeChildCall(
    request: ToolCallRequest & { parentCallId: string }
  ): Promise<ToolResultEnvelope>;
  explain(request: ToolCallRequest): Promise<ToolDecision>;
}
