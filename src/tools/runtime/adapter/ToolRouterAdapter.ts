/**
 * ToolRouterAdapter — 工具路由器适配到 ToolRouterContract。
 *
 * 职责单一：只处理工具系统的核心 LLM 工具。
 * Dashboard Operations、MCP-like 工具、terminal sandbox 等宿主能力由各宿主注入 context，
 * 不在 AlembicAgent 内提供 concrete adapter；Codex MCP/channel/marketplace 由 Plugin 承载。
 */

import { randomUUID } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
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
// default 导出不经 kernel/tools 的 `export *` 进入公开出口；本 adapter 只用它做 JSON 安全化，
// 它上面的 D23 私有字段清理入口由 runtimeBridge/AgentTaskHandlers 经 kernel 桶的包内转发使用。
import normalizeToolResultContent from '#tools/kernel/result.js';
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

/**
 * 信封 durationMs 只取单调时钟差值。Date.now() 是墙钟，NTP step / 手动改时间会让差值为负，
 * 而 presenter.isToolResultEnvelope 要求 durationMs 非负；负值会让消费端整份信封被拒。
 * performance.now() 单调不减，取整保持历史上的整数毫秒形状。
 */
function elapsedMs(monotonicStart: number): number {
  return Math.round(performance.now() - monotonicStart);
}

/**
 * 规范化警告文案（L3-P06）。旧文案对所有警告码都写“display was normalized; the confirmed
 * execution outcome is retained”，在内容被截断时会让读者以为结构化数据完好。新文案只陈述
 * 事实：status 仍是 handler 的执行真值，而 structuredContent 在带内标记处被改写或不完整。
 * 规范化不再施加节点预算，所以 TOOL_RESULT_DISPLAY_LIMIT 在这里只可能来自嵌套深度护栏。
 */
const NORMALIZATION_WARNING_MESSAGES: Readonly<Record<string, string>> = {
  TOOL_RESULT_DISPLAY_LIMIT:
    'Tool result nesting exceeded the depth limit; deeper values were replaced in place with "[unavailable: display limit]", so structuredContent is incomplete at those markers. Status still reports the handler outcome.',
  TOOL_RESULT_DISPLAY_CYCLE:
    'Circular references in the tool result were replaced in place with "[unavailable: circular reference]". Status still reports the handler outcome.',
  TOOL_RESULT_DISPLAY_UNSUPPORTED:
    'Non-JSON values in the tool result (for example BigInt, non-finite numbers, symbols, functions, accessors, toJSON hooks or unreadable objects) were replaced with "[unavailable: ...]" markers or dropped. Status still reports the handler outcome.',
  TOOL_RESULT_DISPLAY_NORMALIZED:
    'Tool result objects with a custom prototype or Date toJSON were converted to plain JSON (own enumerable fields and native Date ISO strings kept). Status still reports the handler outcome.',
};

const NORMALIZATION_WARNING_FALLBACK_MESSAGE =
  'Tool result structuredContent was rewritten for JSON safety; see the in-band "[unavailable: ...]" markers. Status still reports the handler outcome.';

/**
 * execute 抛错时所处的阶段（L4-P04 / I02）：
 * - context：宿主 contextFactory.create 分配上下文/资源时抛错；
 * - availability：宿主 getAvailability 能力快照查询抛错；
 * - adapter：解析、准入或信封组装等适配层自身步骤抛错。
 * 前两者是宿主接线失败（tool_host_context_failed），与 handler 崩溃、业务失败分开归类。
 */
type AdapterFailurePhase = 'context' | 'availability' | 'adapter';

type DiagnosticWarning = ToolResultDiagnostics['warnings'][number];

/** 把适配层异常归一为一条诊断警告，并写一条 warn 日志（不含请求参数，只含阶段与错误文案）。 */
function adapterFailureWarning(
  phase: AdapterFailurePhase,
  toolId: string,
  err: unknown
): DiagnosticWarning {
  const message = err instanceof Error ? err.message : String(err);
  const errorName = err instanceof Error ? err.name : typeof err;
  const warning: DiagnosticWarning =
    phase === 'adapter'
      ? {
          code: 'tool_router_failed',
          message: `Tool adapter step threw ${errorName}: ${message}`,
          stage: 'adapter',
          tool: toolId,
        }
      : {
          code: 'tool_host_context_failed',
          message: `Host ${phase === 'context' ? 'context factory create' : 'availability lookup'} threw ${errorName}: ${message}`,
          stage: phase,
          tool: toolId,
        };
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[ToolRouterAdapter] tool=${toolId}; ${warning.code} stage=${phase} path=error-envelope ` +
          `error=${errorName}: ${message}`
      ),
    () => undefined
  );
  return warning;
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
    // 在最外层一次绑定父调用身份，成功、准入拒绝、取消和异常都不能丢失关联。
    // 只快照身份字段，不冻结宿主持有的 request/runtime 资源。
    const parentCallId = request.parentCallId;
    const envelope = await this.#executeCall(request);
    return parentCallId === undefined ? envelope : { ...envelope, parentCallId };
  }

  async #executeCall(request: ToolCallRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date().toISOString();
    const callId = randomUUID();
    const t0 = performance.now();

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

    // 记录异常发生在哪一段：宿主 create/getAvailability 失败与适配层自身失败分别归类。
    let phase: AdapterFailurePhase = 'adapter';
    try {
      const parsed = this.router.parseToolCall(request.toolId, request.args);
      if ('error' in parsed) {
        return this.#errorEnvelope(request.toolId, callId, startedAt, parsed.error);
      }

      phase = 'availability';
      const toolAvailability = this.#contextFactory.getAvailability?.(request.runtime);
      phase = 'adapter';
      // 能力查询是宿主同步边界；其中的取消必须先于 context 分配及后续执行生效。
      if (request.abortSignal?.aborted) {
        return {
          ...this.#errorEnvelope(
            request.toolId,
            callId,
            startedAt,
            'Tool call aborted during availability lookup',
            elapsedMs(t0)
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
          elapsedMs(t0)
        );
      }

      const cacheHint =
        this.router.getToolSpec(parsed.tool)?.actions[parsed.action]?.cache ?? 'none';
      const cachePolicy = cacheHint === 'delta' ? 'session' : cacheHint;

      phase = 'context';
      const hostContext = this.#contextFactory.create(request);
      phase = 'adapter';
      const ctx = {
        ...hostContext,
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
      const durationMs = elapsedMs(t0);

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
      const durationMs = elapsedMs(t0);
      return this.#errorEnvelope(
        request.toolId,
        callId,
        startedAt,
        err instanceof Error ? err.message : String(err),
        durationMs,
        [adapterFailureWarning(phase, request.toolId, err)]
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
    const abortedDecision: ToolDecision = {
      allowed: false,
      stage: 'execute',
      resultStatus: 'aborted',
      reason: 'Tool call aborted before execution',
    };
    if (request.abortSignal?.aborted) {
      return abortedDecision;
    }
    const parsed = this.router.parseToolCall(request.toolId, request.args);
    if ('error' in parsed) {
      return { allowed: false, stage: 'discover', reason: parsed.error };
    }

    try {
      const toolAvailability = this.#contextFactory.getAvailability?.(request.runtime);
      // explain 同样经过宿主回调；取消后的允许决策不能再向调用方广告可执行性。
      if (request.abortSignal?.aborted) {
        return abortedDecision;
      }
      const decision = this.router.explain(parsed, { runtime: request.runtime, toolAvailability });
      return request.abortSignal?.aborted ? abortedDecision : decision;
    } catch (err: unknown) {
      if (request.abortSignal?.aborted) {
        return abortedDecision;
      }
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
    // 先保留 handler 的执行真值，再单独做 JSON 安全化。宿主已写成功后的循环/BigInt/
    // getter 等不能使 JSON.stringify 抛出并落入 execute 的失败分支，更不能重试写入。
    // 规范化（L3-P06）只处理循环、accessor、toJSON、BigInt、Date、原型，不删除任何字段，
    // 也不施加 4096 显示节点预算：宿主 /agent/tool 拿到的是完整数据，status 仍是 handler
    // 真值（不降为 partial）。显示预算只留给 projectToolResultOrdinaryOutput/presentToolResult，
    // 模型路径另有 limitToolResult 字符配额。
    // D23 普通输出禁用字段不在这里执行（L3-C02 决策）：本信封就是宿主 /agent/tool 的响应体，
    // 宿主 HTTP 出口不执行 D23（cross-repo 决定），所以这里不删除任何字段。D23 的执行点在
    // 下游：秘密/私有字段由 runtimeBridge（模型历史、返回值）与 AgentTaskHandlers（任务输出、
    // AI 提示、错误）在使用前对 structuredContent 与 JSON text 一并清理（任意深度、按规范化
    // 名字），旧信封顶层字段只由普通输出投影 projectToolResultOrdinaryOutput（runtimeBridge 与
    // AgentTaskHandlers 对纯文本信封的投影）在根路径删除；presentToolResult（目前没有生产调用方）
    // 走同一投影。
    const normalized = normalizeToolResultContent(result.data);
    envelope.structuredContent = normalized.value;
    if (result.ok) {
      envelope.text =
        typeof normalized.value === 'string'
          ? normalized.value
          : (JSON.stringify(normalized.value, null, 2) ?? '[no tool result]');
    }
    const originalCodes = new Set(envelope.diagnostics.warnings.map((warning) => warning.code));
    // 每个警告码说明内容在哪里、被改写成了什么；它们就是本降级路径的诊断事件。
    const normalizationWarnings = normalized.warningCodes
      .filter((code) => !originalCodes.has(code))
      .map((code) => ({
        code,
        message: NORMALIZATION_WARNING_MESSAGES[code] ?? NORMALIZATION_WARNING_FALLBACK_MESSAGE,
        stage: 'result-display',
        tool: toolId,
      }));
    if (normalizationWarnings.length > 0) {
      envelope.diagnostics = {
        ...envelope.diagnostics,
        degraded: true,
        warnings: [...envelope.diagnostics.warnings, ...normalizationWarnings],
      };
    }
    return envelope;
  }

  #errorEnvelope(
    toolId: string,
    callId: string,
    startedAt: string,
    error: string,
    durationMs = 0,
    warnings: DiagnosticWarning[] = []
  ): ToolResultEnvelope {
    return {
      ok: false,
      toolId,
      callId,
      startedAt,
      durationMs,
      status: 'error',
      text: error,
      diagnostics: { ...emptyDiagnostics(), warnings },
      trust: { ...DEFAULT_TRUST },
    };
  }
}
