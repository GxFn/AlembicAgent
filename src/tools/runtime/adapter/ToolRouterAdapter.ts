/**
 * ToolRouterAdapter — 工具路由器适配到 ToolRouterContract。
 *
 * 职责单一：只处理工具系统的核心 LLM 工具。
 * Dashboard Operations、MCP-like 工具、terminal sandbox 等宿主能力由各宿主注入 context，
 * 不在 AlembicAgent 内提供 concrete adapter；Codex MCP/channel/marketplace 由 Plugin 承载。
 */

import { randomUUID } from 'node:crypto';
import type {
  ToolCallRequest,
  ToolDecision,
  ToolResultDiagnostics,
  ToolResultEnvelope,
  ToolResultTrust,
  ToolRouterContract,
} from '#tools/kernel/index.js';
import type { CapabilityDef, ToolContext, ToolResult } from '#tools/kernel/registry.js';
import { ToolRouter } from '../router.js';

export interface ToolContextFactoryContract {
  create(request: ToolCallRequest): ToolContext;
}

export type ToolContextProviderContract = ToolContextFactoryContract;

const EMPTY_DIAGNOSTICS: ToolResultDiagnostics = {
  degraded: false,
  fallbackUsed: false,
  warnings: [],
  timedOutStages: [],
  blockedTools: [],
  truncatedToolCalls: 0,
  emptyResponses: 0,
  aiErrorCount: 0,
  gateFailures: [],
};

const DEFAULT_TRUST: ToolResultTrust = {
  source: 'internal',
  sanitized: true,
  containsUntrustedText: false,
  containsSecrets: false,
};

export class ToolRouterAdapter implements ToolRouterContract {
  readonly router: ToolRouter;
  readonly #contextFactory: ToolContextFactoryContract;

  constructor(opts: {
    capability?: CapabilityDef;
    contextFactory: ToolContextFactoryContract;
    router?: ToolRouter;
  }) {
    this.router = opts.router ?? new ToolRouter({ capability: opts.capability });
    this.#contextFactory = opts.contextFactory;
  }

  async execute(request: ToolCallRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date().toISOString();
    const callId = randomUUID();
    const t0 = Date.now();

    try {
      const parsed = this.router.parseToolCall(request.toolId, request.args);
      if ('error' in parsed) {
        return this.#errorEnvelope(request.toolId, callId, startedAt, parsed.error);
      }

      const cacheHint =
        this.router.getToolSpec(parsed.tool)?.actions[parsed.action]?.cache ?? 'none';
      const cachePolicy = cacheHint === 'delta' ? 'session' : cacheHint;

      const ctx = this.#contextFactory.create(request);
      const result = await this.router.execute(parsed, ctx);
      const durationMs = Date.now() - t0;

      return this.#toEnvelope(result, request.toolId, callId, startedAt, durationMs, cachePolicy);
    } catch (err: unknown) {
      const durationMs = Date.now() - t0;
      return this.#errorEnvelope(
        request.toolId,
        callId,
        startedAt,
        err instanceof Error ? err.message : String(err),
        durationMs
      );
    }
  }

  async executeChildCall(
    request: ToolCallRequest & { parentCallId: string }
  ): Promise<ToolResultEnvelope> {
    return this.execute(request);
  }

  async explain(request: ToolCallRequest): Promise<ToolDecision> {
    const parsed = this.router.parseToolCall(request.toolId, request.args);
    if ('error' in parsed) {
      return { allowed: false, stage: 'discover', reason: parsed.error };
    }

    const spec = this.router.getToolSpec(parsed.tool);
    if (!spec) {
      return { allowed: false, stage: 'discover', reason: `Unknown tool: ${parsed.tool}` };
    }
    if (!spec.actions[parsed.action]) {
      return {
        allowed: false,
        stage: 'discover',
        reason: `Unknown action: ${parsed.tool}.${parsed.action}`,
      };
    }

    return { allowed: true, stage: 'execute' };
  }

  #toEnvelope(
    result: ToolResult,
    toolId: string,
    callId: string,
    startedAt: string,
    durationMs: number,
    cachePolicy: 'none' | 'session' | 'scope' | 'persistent' = 'none'
  ): ToolResultEnvelope {
    const text = result.ok
      ? typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data, null, 2)
      : result.error || 'Unknown error';

    return {
      ok: result.ok,
      toolId,
      callId,
      startedAt,
      durationMs,
      status: result.ok ? 'success' : 'error',
      text,
      structuredContent: result.data,
      cache: {
        hit: result._meta?.cached ?? false,
        policy: cachePolicy,
      },
      diagnostics: EMPTY_DIAGNOSTICS,
      trust: result.ok ? DEFAULT_TRUST : { ...DEFAULT_TRUST, containsUntrustedText: true },
    };
  }

  #errorEnvelope(
    toolId: string,
    callId: string,
    startedAt: string,
    error: string,
    durationMs = 0
  ): ToolResultEnvelope {
    return {
      ok: false,
      toolId,
      callId,
      startedAt,
      durationMs,
      status: 'error',
      text: error,
      diagnostics: EMPTY_DIAGNOSTICS,
      trust: DEFAULT_TRUST,
    };
  }
}
