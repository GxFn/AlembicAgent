/**
 * ToolRouterAdapter — 工具路由器适配到 ToolRouterContract。
 *
 * 职责单一：只处理工具系统的核心 LLM 工具。
 * Dashboard Operations、MCP-like 工具、terminal sandbox 等宿主能力由各宿主注入 context，
 * 不在 AlembicAgent 内提供 concrete adapter；Codex MCP/channel/marketplace 由 Plugin 承载。
 */

import { randomUUID } from 'node:crypto';
import type { ToolAvailabilitySnapshot } from '#tools/kernel/availability.js';
import type {
  ToolCallRequest,
  ToolDecision,
  ToolResultDiagnostics,
  ToolResultEnvelope,
  ToolResultTrust,
  ToolRouterContract,
  ToolRuntimeCallContext,
  ToolScopeRelease,
} from '#tools/kernel/index.js';
import type { CapabilityDef, ToolContext, ToolResult } from '#tools/kernel/registry.js';
import { toolAdmissionFailure } from '../admission.js';
import { ToolRouter } from '../router.js';

export interface ToolContextFactoryContract {
  create(request: ToolCallRequest): ToolContext;
  /** 无副作用的宿主能力快照；查询不能调用 create 或执行工具来探测。 */
  getAvailability?(runtime?: ToolRuntimeCallContext): ToolAvailabilitySnapshot;
  releaseScope?(scope: ToolScopeRelease): void | Promise<void>;
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

/**
 * Lift the handler-set degrade/fallback meta onto the per-call envelope diagnostics.
 * A single ToolResult has no notion of the loop-level fields (blockedTools, gateFailures,
 * …) — those are recorded directly into the DiagnosticsCollector by the pipeline — so only
 * degraded/fallbackUsed can be known here. Returns the shared empty constant for clean calls.
 */
function diagnosticsFromResult(result: ToolResult, toolId: string): ToolResultDiagnostics {
  const degraded = result._meta?.degraded === true;
  const fallbackUsed = result._meta?.fallbackUsed === true;
  const warnings = result._meta?.diagnosticWarnings ?? [];
  const blocked = result._meta?.resultStatus === 'blocked';
  if (!degraded && !fallbackUsed && warnings.length === 0 && !blocked) {
    return EMPTY_DIAGNOSTICS;
  }
  return {
    ...EMPTY_DIAGNOSTICS,
    degraded,
    fallbackUsed,
    warnings,
    ...(blocked
      ? { blockedTools: [{ tool: toolId, reason: result.error || 'Tool call blocked' }] }
      : {}),
  };
}

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

    if (request.abortSignal?.aborted) {
      return {
        ...this.#errorEnvelope(
          request.toolId,
          callId,
          startedAt,
          'Tool call aborted before execution'
        ),
        status: 'aborted',
      };
    }

    try {
      const parsed = this.router.parseToolCall(request.toolId, request.args);
      if ('error' in parsed) {
        return this.#errorEnvelope(request.toolId, callId, startedAt, parsed.error);
      }

      const toolAvailability = this.#contextFactory.getAvailability?.(request.runtime);
      const decision = this.router.explain(parsed, { runtime: request.runtime, toolAvailability });
      if (!decision.allowed) {
        return this.#toEnvelope(
          toolAdmissionFailure(parsed, decision),
          request.toolId,
          callId,
          startedAt,
          Date.now() - t0
        );
      }

      const cacheHint =
        this.router.getToolSpec(parsed.tool)?.actions[parsed.action]?.cache ?? 'none';
      const cachePolicy = cacheHint === 'delta' ? 'session' : cacheHint;

      const ctx = {
        ...this.#contextFactory.create(request),
        ...(request.runtime ? { runtime: request.runtime } : {}),
        ...(toolAvailability ? { toolAvailability } : {}),
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      };
      const getAvailability = this.#contextFactory.getAvailability;
      const result = await this.router.execute(parsed, ctx, {
        ...(getAvailability
          ? { getAvailability: () => getAvailability.call(this.#contextFactory, request.runtime) }
          : {}),
      });
      const durationMs = Date.now() - t0;

      const envelope = this.#toEnvelope(
        result,
        request.toolId,
        callId,
        startedAt,
        durationMs,
        cachePolicy
      );
      if (!result.ok && ctx.abortSignal?.aborted) {
        envelope.status = 'aborted';
      }
      return envelope;
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

  async releaseScope(scope: ToolScopeRelease): Promise<void> {
    await this.#contextFactory.releaseScope?.(scope);
  }

  async explain(request: ToolCallRequest): Promise<ToolDecision> {
    if (request.abortSignal?.aborted) {
      return {
        allowed: false,
        stage: 'execute',
        resultStatus: 'aborted',
        reason: 'Tool call aborted before execution',
      };
    }
    const parsed = this.router.parseToolCall(request.toolId, request.args);
    if ('error' in parsed) {
      return { allowed: false, stage: 'discover', reason: parsed.error };
    }

    try {
      return this.router.explain(parsed, {
        runtime: request.runtime,
        toolAvailability: this.#contextFactory.getAvailability?.(request.runtime),
      });
    } catch (err: unknown) {
      return {
        allowed: false,
        stage: 'discover',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
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
      status: result.ok ? 'success' : (result._meta?.resultStatus ?? 'error'),
      text,
      structuredContent: result.data,
      cache: {
        hit: result._meta?.cached ?? false,
        policy: cachePolicy,
      },
      diagnostics: diagnosticsFromResult(result, toolId),
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
