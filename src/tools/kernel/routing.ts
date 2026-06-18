/**
 * Tool routing service helpers — wrap/resolve a ToolRouterContract through the
 * service-contract seam. Canonical home (formerly
 * src/tools/core/ToolRoutingServices.ts).
 */

import type { ToolCallContext, ToolRoutingServiceContract } from './context.js';
import type { ToolRouterContract } from './request.js';

export function createToolRoutingServiceContract(
  toolRouter: ToolRouterContract | null | undefined
): ToolRoutingServiceContract {
  return {
    toolRouter: toolRouter || null,
  };
}

export function resolveToolRouterFromContext(context: ToolCallContext): ToolRouterContract | null {
  const routed = context.serviceContracts?.toolRouting?.toolRouter;
  if (isToolRouterContract(routed)) {
    return routed;
  }
  return null;
}

function isToolRouterContract(value: unknown): value is ToolRouterContract {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ToolRouterContract).execute === 'function' &&
    typeof (value as ToolRouterContract).executeChildCall === 'function' &&
    typeof (value as ToolRouterContract).explain === 'function'
  );
}
