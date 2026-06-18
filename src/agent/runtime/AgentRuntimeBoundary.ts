import type { AgentRuntimeResponsibilityManifest } from './AgentRuntimeResponsibility.js';
import { ALEMBIC_AGENT_RUNTIME_RESPONSIBILITY } from './AgentRuntimeResponsibility.js';

export type AgentRuntimeBoundaryArea =
  | 'ai-provider'
  | 'tool-execution'
  | 'terminal-sandbox'
  | 'context-memory'
  | 'prompt-runtime'
  | 'tool-v2'
  | 'host-agent-route';

export type AgentRuntimeBoundaryOwner = 'agent' | 'host' | 'core';

export interface AgentRuntimeBoundaryEntry {
  readonly area: AgentRuntimeBoundaryArea;
  readonly owner: AgentRuntimeBoundaryOwner;
  readonly publicSubpath: string | null;
  readonly summary: string;
  readonly agentOwns: readonly string[];
  readonly hostOwns: readonly string[];
  readonly coreContracts?: readonly string[];
}

export interface AgentRuntimeBoundaryManifest {
  readonly packageName: '@alembic/agent';
  readonly runtimeLine: 'alembic-api-ai';
  readonly hostAgentRouteSupported: false;
  readonly entries: readonly AgentRuntimeBoundaryEntry[];
  readonly responsibility: AgentRuntimeResponsibilityManifest;
  readonly unsupportedHostRoutes: readonly string[];
}

const BOUNDARY_ENTRIES = [
  {
    area: 'ai-provider',
    owner: 'agent',
    publicSubpath: '@alembic/agent/ai',
    summary: 'AI provider adapters, model registry, transports, parameter guards, and LLM gateway.',
    agentOwns: ['provider adapters', 'model registry', 'transport contracts', 'provider errors'],
    hostOwns: ['credential retrieval', 'network permission', 'provider enablement UI'],
  },
  {
    area: 'tool-execution',
    owner: 'agent',
    // Train B IC3 retired the ./tools aggregate subpath; generic tool contracts
    // stay public through the root facade, which re-exports the tools barrel.
    publicSubpath: '@alembic/agent',
    summary: 'Generic tool call contracts, routing envelopes, decisions, and workflow registry.',
    agentOwns: ['tool routing contracts', 'tool result envelopes', 'tool decision contracts'],
    hostOwns: ['concrete service injection', 'approval UI', 'process lifecycle'],
  },
  {
    area: 'terminal-sandbox',
    owner: 'agent',
    publicSubpath: '@alembic/agent/tools/terminal',
    summary:
      'Terminal capability manifests, policy input builders, policy evaluators, and sessions.',
    agentOwns: ['terminal capability manifests', 'policy evaluators', 'session plan contracts'],
    hostOwns: ['real process or PTY execution', 'sandbox enforcement', 'terminal persistence'],
    coreContracts: ['@alembic/core/host-agent-workflows'],
  },
  {
    area: 'context-memory',
    owner: 'agent',
    publicSubpath: '@alembic/agent/context',
    summary:
      'Context window, conversation store, exploration tracking, and memory handoff contracts.',
    agentOwns: ['context assembly', 'exploration tracking', 'memory coordination handoff'],
    hostOwns: ['conversation transport', 'durable storage placement', 'product account boundary'],
  },
  {
    area: 'prompt-runtime',
    owner: 'agent',
    publicSubpath: '@alembic/agent/prompts',
    summary: 'Prompt builders, prompt budgets, and Agent run prompt stages.',
    agentOwns: ['prompt templates', 'budget helpers', 'stage prompt builders'],
    hostOwns: ['user-facing invocation', 'product-specific prompt routing', 'model selection UI'],
  },
  {
    area: 'tool-v2',
    owner: 'agent',
    publicSubpath: '@alembic/agent/tools/runtime',
    summary: 'Tool V2 router, capability catalog, cache, compressor, adapter, and handlers.',
    agentOwns: ['ToolRouter', 'ToolRouterAdapter', 'tool cache and compressor contracts'],
    hostOwns: ['ToolContextFactory inputs', 'external executor wiring', 'UI or daemon surfaces'],
  },
  {
    area: 'host-agent-route',
    owner: 'host',
    publicSubpath: null,
    summary:
      'Codex MCP server, marketplace, channel packaging, and host-agent route remain Plugin-owned; AlembicAgent only exposes internal runtime contracts.',
    agentOwns: [],
    hostOwns: [
      'Codex MCP server',
      'marketplace packaging',
      'channel delivery',
      'host-agent route policy',
    ],
  },
] as const satisfies readonly AgentRuntimeBoundaryEntry[];

export const ALEMBIC_AGENT_RUNTIME_BOUNDARY = Object.freeze({
  packageName: '@alembic/agent',
  runtimeLine: 'alembic-api-ai',
  hostAgentRouteSupported: false,
  entries: BOUNDARY_ENTRIES,
  responsibility: ALEMBIC_AGENT_RUNTIME_RESPONSIBILITY,
  unsupportedHostRoutes: ['codex-mcp', 'codex-marketplace', 'plugin-host-agent-route'],
}) satisfies AgentRuntimeBoundaryManifest;

export function getAgentRuntimeBoundaryEntry(
  area: AgentRuntimeBoundaryArea
): AgentRuntimeBoundaryEntry | null {
  return ALEMBIC_AGENT_RUNTIME_BOUNDARY.entries.find((entry) => entry.area === area) ?? null;
}

export function supportsAgentRuntimeRoute(route: string): boolean {
  return route === ALEMBIC_AGENT_RUNTIME_BOUNDARY.runtimeLine;
}
