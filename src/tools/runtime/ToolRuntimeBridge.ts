/**
 * ToolRuntimeBridge centralizes the V1/core compatibility seam used by
 * Agent runtime and Tool V2 consumers. New tool-system behavior should be
 * implemented in V2 or higher-level runtime modules, not by adding more
 * direct imports from `src/tools/core`.
 */

export type {
  ForgedInternalToolDefinition,
  ForgedInternalToolStore,
  InternalToolHandler,
  InternalToolHandlerEntry,
  InternalToolHandlerStore,
} from '#tools/core/InternalToolHandler.js';
export type {
  ToolActor,
  ToolCallContext,
  ToolCallSource,
  ToolDiagnosticsRecorder,
  ToolRuntimeCallContext,
  ToolServiceLocator,
  ToolSurface,
} from '#tools/core/ToolCallContext.js';
export type {
  ToolCallRequest,
  ToolExecutionRequest,
  ToolRouterContract,
} from '#tools/core/ToolContracts.js';
export type { ToolDecision } from '#tools/core/ToolDecision.js';
export { allowToolDecision, denyToolDecision } from '#tools/core/ToolDecision.js';
export type {
  ToolArtifactRef,
  ToolResultDiagnosticSummary,
  ToolResultDiagnostics,
  ToolResultEnvelope,
  ToolResultFailureTaxonomy,
  ToolResultStatus,
  ToolResultTrust,
} from '#tools/core/ToolResultEnvelope.js';
export {
  projectToolResultOrdinaryOutput,
  TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
} from '#tools/core/ToolResultEnvelope.js';
export { isToolResultEnvelope } from '#tools/core/ToolResultPresenter.js';
export { resolveToolRouterFromContext } from '#tools/core/ToolRoutingServices.js';
