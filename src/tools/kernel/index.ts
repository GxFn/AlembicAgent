/**
 * @module tools/kernel
 *
 * Canonical tool-system contract — the single source of truth for the tool
 * result envelope, decision, request, router contract, call context, handler,
 * and registry types. This replaced the former dual V1 (src/tools/core) and
 * V2 (src/tools/v2/types) contract split; every consumer imports from here and
 * there are no version labels left in the tool system.
 */

export type {
  ToolAvailabilityContext,
  ToolAvailabilitySnapshot,
  ToolUnavailableReason,
} from './availability.js';
export * from './context.js';
export * from './decision.js';
export * from './handler.js';
export type * from './manifest.js';
export * from './presenter.js';
export * from './registry.js';
export * from './request.js';
export * from './result.js';
export * from './routing.js';
export type {
  ToolActionAllowlist,
  ToolSchemaProjection,
  ToolSchemaQuery,
  ToolSchemaQueryPort,
  ToolSchemaQueryResult,
  ToolSelection,
} from './toolSchema.js';
