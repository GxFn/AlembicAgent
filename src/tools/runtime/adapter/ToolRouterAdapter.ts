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
import { projectToolResultOrdinaryOutput } from '#tools/kernel/result.js';
import { toolAdmissionFailure } from '../admission.js';
import { ToolRouter } from '../router.js';

export interface ToolContextFactoryContract {
  create(request: ToolCallRequest): ToolContext;
  /** 无副作用的宿主能力快照；查询不能调用 create 或执行工具来探测。 */
  getAvailability?(runtime?: ToolRuntimeCallContext): ToolAvailabilitySnapshot;
  releaseScope?(scope: ToolScopeRelease): void | Promise<void>;
}

export type ToolContextProviderContract = ToolContextFactoryContract;

function emptyDiagnostics(): ToolResultDiagnostics {
  return {
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
}

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
 * degraded/fallbackUsed can be known here. Every call owns its diagnostic arrays and entries.
 */
function diagnosticsFromResult(result: ToolResult, toolId: string): ToolResultDiagnostics {
  const degraded = result._meta?.degraded === true;
  const fallbackUsed = result._meta?.fallbackUsed === true;
  const warnings = result._meta?.diagnosticWarnings ?? [];
  const blocked = result._meta?.resultStatus === 'blocked';
  return {
    ...emptyDiagnostics(),
    degraded,
    fallbackUsed,
    warnings: warnings.map((warning) => ({ ...warning })),
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
      // 能力查询是宿主同步边界；其中的取消必须先于 context 分配及后续执行生效。
      if (request.abortSignal?.aborted) {
        return {
          ...this.#errorEnvelope(
            request.toolId,
            callId,
            startedAt,
            'Tool call aborted during availability lookup',
            Date.now() - t0
          ),
          status: 'aborted',
        };
      }
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
      if (!result.ok && result._meta?.resultStatus === undefined && ctx.abortSignal?.aborted) {
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
    const envelope: ToolResultEnvelope = {
      ok: result.ok,
      toolId,
      callId,
      startedAt,
      durationMs,
      status: result._meta?.resultStatus ?? (result.ok ? 'success' : 'error'),
      text: result.ok ? '' : result.error || 'Unknown error',
      structuredContent: result.data,
      cache: {
        hit: result._meta?.cached ?? false,
        policy: cachePolicy,
      },
      diagnostics: diagnosticsFromResult(result, toolId),
      trust: { ...DEFAULT_TRUST, containsUntrustedText: !result.ok },
    };
    // 先保留 handler 的执行真值，再单独归一显示数据。宿主已写成功后的循环/BigInt/
    // getter 等不能使 JSON.stringify 抛出并落入 execute 的失败分支，更不能重试写入。
    // 内部信封保留业务字段；普通输出的私有字段规则仍由 presenter 的默认投影执行。
    const display = projectToolResultOrdinaryOutput(envelope, { forbiddenFields: [] });
    envelope.structuredContent = display.structuredContent;
    if (result.ok) {
      envelope.text =
        typeof display.structuredContent === 'string'
          ? display.structuredContent
          : (JSON.stringify(display.structuredContent, null, 2) ?? '[no tool result]');
    }
    const originalCodes = new Set(envelope.diagnostics.warnings.map((warning) => warning.code));
    const displayWarnings = display.diagnosticSummary.warningCodes
      .filter((code) => !originalCodes.has(code))
      .map((code) => ({
        code,
        message: 'Tool result display was normalized; the confirmed execution outcome is retained.',
        stage: 'result-display',
        tool: toolId,
      }));
    if (displayWarnings.length > 0) {
      envelope.diagnostics = {
        ...envelope.diagnostics,
        degraded: true,
        warnings: [...envelope.diagnostics.warnings, ...displayWarnings],
      };
    }
    return envelope;
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
      diagnostics: emptyDiagnostics(),
      trust: { ...DEFAULT_TRUST },
    };
  }
}
