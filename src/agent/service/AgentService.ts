import { randomUUID } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { runOperation } from '#shared/operation.js';
import { AgentRunCoordinator } from '../coordination/AgentRunCoordinator.js';
import {
  type AgentProfileCompiler,
  createDefaultProfileCompiler,
} from '../profiles/AgentProfileCompiler.js';
import {
  isAgentExecutionTimeoutError,
  readRuntimeFailureSnapshot,
} from '../runtime/AgentExecutionTimeoutError.js';
import { AgentMessage, Channel } from '../runtime/AgentMessage.js';
import { DiagnosticsCollector } from '../runtime/DiagnosticsCollector.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunStatus,
  AgentRuntimeBuildOptions,
  AgentRuntimeLike,
  AgentRuntimeRunOptions,
  AgentRuntimeSource,
  CompiledAgentProfile,
} from './AgentRunContracts.js';
import type { AgentRuntimeBuilder } from './AgentRuntimeBuilder.js';

interface AgentRuntimeBuilderLike {
  build(
    profile: AgentRunInput['profile'] | CompiledAgentProfile,
    options?: AgentRuntimeBuildOptions
  ): AgentRuntimeLike;
}

export interface AgentServiceOptions {
  runtimeBuilder: AgentRuntimeBuilder | AgentRuntimeBuilderLike;
  profileCompiler?: AgentProfileCompiler;
  runCoordinator?: AgentRunCoordinator;
}

export class AgentService {
  #runtimeBuilder: AgentRuntimeBuilderLike;
  #profileCompiler: AgentProfileCompiler;
  #runCoordinator: AgentRunCoordinator;
  #logger = Logger.getInstance();

  constructor({ runtimeBuilder, profileCompiler, runCoordinator }: AgentServiceOptions) {
    this.#runtimeBuilder = runtimeBuilder;
    this.#profileCompiler = profileCompiler || createDefaultProfileCompiler();
    this.#runCoordinator = runCoordinator || new AgentRunCoordinator();
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    validateRunInput(input);
    const compiledProfile = this.#profileCompiler.compile(input.profile, {
      params: input.params,
      context: input.context,
    });
    const trace = describeRun(input, compiledProfile.id);
    const startedAt = Date.now();
    this.#log('info', `[AgentService] run start ${formatRunTrace(trace)}`, trace);
    if (this.#runCoordinator.canCoordinate(compiledProfile)) {
      try {
        this.#log('info', `[AgentService] coordinated run start ${formatRunTrace(trace)}`, {
          ...trace,
          concurrencyMode: compiledProfile.concurrency?.mode || null,
        });
        const coordinated = await this.#runCoordinator.run(input, compiledProfile, (childInput) =>
          this.run(childInput)
        );
        if (coordinated) {
          this.#log('info', `[AgentService] coordinated run complete ${formatRunTrace(trace)}`, {
            ...trace,
            durationMs: Date.now() - startedAt,
            status: coordinated.status,
            toolCallCount: coordinated.toolCalls.length,
          });
          return coordinated;
        }
      } catch (err: unknown) {
        this.#log('warn', `[AgentService] coordinated run failed ${formatRunTrace(trace)}`, {
          ...trace,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    let preflightStatus: 'aborted' | 'timeout' | null = input.execution?.abortSignal?.aborted
      ? 'aborted'
      : null;
    const shouldAbort = input.execution?.shouldAbort;
    if (!preflightStatus && shouldAbort) {
      const timeout = input.execution?.timeoutMs;
      // 开工检查可以异步，但等待也必须响应本次signal和显式期限；不增加运行中轮询。
      const check = await runOperation(() => shouldAbort(), {
        abortSignal: input.execution?.abortSignal,
        timeoutMs:
          typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
            ? timeout
            : undefined,
      });
      if (check.status === 'error') {
        const error =
          check.error instanceof Error
            ? check.error
            : new Error('Agent cancellation check failed', { cause: check.error });
        this.#log('warn', `[AgentService] cancellation check failed ${formatRunTrace(trace)}`, {
          ...trace,
          error: error.message,
        });
        throw error;
      }
      if (check.status === 'timeout') {
        preflightStatus = 'timeout';
      } else if (
        check.status === 'aborted' ||
        (check.status === 'ok' && check.value === true) ||
        input.execution?.abortSignal?.aborted
      ) {
        preflightStatus = 'aborted';
      }
    }
    if (preflightStatus) {
      const diagnostics = DiagnosticsCollector.from(input.execution?.diagnostics);
      diagnostics.recordCancelReason(
        preflightStatus === 'timeout' ? 'stage_timeout' : 'abort_signal'
      );
      if (preflightStatus === 'timeout') {
        diagnostics.recordTimedOutStage('service-preflight');
      }
      diagnostics.warn({
        code: `run_${preflightStatus}_before_execution`,
        message: `AgentService did not start runtime work after preflight ${preflightStatus}`,
      });
      this.#log(
        'info',
        `[AgentService] run ${preflightStatus} before execution ${formatRunTrace(trace)}`,
        trace
      );
      return {
        runId: randomUUID(),
        profileId: compiledProfile.id,
        reply: `Agent run ${preflightStatus} before execution`,
        status: preflightStatus,
        toolCalls: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          iterations: 0,
          durationMs: Date.now() - startedAt,
        },
        diagnostics: diagnostics.toJSON(),
      };
    }
    const runtime = this.#runtimeBuilder.build(compiledProfile, {
      lang: input.context.lang || null,
      onProgress: input.execution?.onProgress || null,
      onToolCall: input.execution?.onToolCall || null,
    });
    if (input.context.fileCache !== undefined) {
      runtime.setFileCache?.(input.context.fileCache);
    }
    const message = buildAgentMessage(input);
    try {
      // 冷启动监控依赖这里把“维度 child run 已进入 AgentRuntime”明确打出来。
      // 仅靠 GenerateTaskManager 的 filling 状态看不出是在排队、模型请求中还是已失败待收口。
      this.#log('info', `[AgentService] runtime execute start ${formatRunTrace(trace)}`, {
        ...trace,
        runtimeSource: input.context.runtimeSource || runtimeSourceFor(input.context.source),
      });
      const result = await runtime.execute(message, buildRuntimeOptions(input));
      const status = inferRunStatus(result);
      this.#log('info', `[AgentService] runtime execute complete ${formatRunTrace(trace)}`, {
        ...trace,
        durationMs: Date.now() - startedAt,
        status,
        iterations: result.iterations || 0,
        toolCallCount: result.toolCalls?.length || 0,
        cancelReason: getDiagnosticsCancelReason(result.diagnostics),
        aiErrorCount: getDiagnosticsAiErrorCount(result.diagnostics),
      });
      return {
        runId: runtime.id || randomUUID(),
        profileId: compiledProfile.id,
        reply: result.reply || '',
        status,
        phases: result.phases,
        toolCalls: result.toolCalls || [],
        usage: {
          inputTokens: result.tokenUsage?.input || 0,
          outputTokens: result.tokenUsage?.output || 0,
          iterations: result.iterations || 0,
          durationMs: result.durationMs || 0,
        },
        diagnostics: result.diagnostics || null,
      };
    } catch (err: unknown) {
      // 快照只按 owner 读取：注入的包装 AgentRuntimeLike 不是登记者时读不到（failureSnapshot='none'）。
      const partial = readRuntimeFailureSnapshot(runtime, err);
      const classified = classifyRunError(err);
      this.#log('warn', `[AgentService] runtime execute failed ${formatRunTrace(trace)}`, {
        ...trace,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        status: classified.status,
        errorClassification: classified.basis,
        errorName: err instanceof Error ? err.name : typeof err,
        errorCode: readErrorCode(err),
        failureSnapshot: partial ? 'owner-bound' : 'none',
      });
      return {
        runId: runtime.id || randomUUID(),
        profileId: compiledProfile.id,
        reply: err instanceof Error ? err.message : String(err),
        status: classified.status,
        phases: partial?.phases,
        toolCalls: partial?.toolCalls || [],
        usage: {
          inputTokens: partial?.tokenUsage.input || 0,
          outputTokens: partial?.tokenUsage.output || 0,
          iterations: partial?.iterations || 0,
          durationMs: partial?.durationMs || 0,
        },
        diagnostics: partial?.diagnostics || null,
      };
    }
  }

  #log(level: 'info' | 'warn', message: string, metadata: Record<string, unknown>): void {
    observeSafely(
      () => this.#logger[level](message, metadata),
      () => undefined
    );
  }
}

function validateRunInput(input: AgentRunInput) {
  if (!input.profile) {
    throw new Error('AgentRunInput.profile is required');
  }
  if (!input.message?.content) {
    throw new Error('AgentRunInput.message.content is required');
  }
  if (!input.context?.source) {
    throw new Error('AgentRunInput.context.source is required');
  }
}

function buildAgentMessage(input: AgentRunInput) {
  const promptContext = promptContextFor(input);
  return new AgentMessage({
    content: input.message.content,
    channel: toChannel(input.context.source),
    session: {
      id: input.message.sessionId || input.context.actor?.sessionId || randomUUID(),
      history: input.message.history || [],
    },
    sender: {
      id: input.context.actor?.user || 'agent-runner',
      type:
        input.message.role === 'system' || input.message.role === 'internal' ? 'system' : 'user',
    },
    metadata: stripProfileSelectionMetadata({
      ...(input.message.metadata || {}),
      ...(Object.keys(promptContext).length > 0 ? { context: promptContext } : {}),
      source: input.context.source,
      stream: input.presentation?.stream || false,
    }),
  });
}

function buildRuntimeOptions(input: AgentRunInput): AgentRuntimeRunOptions {
  const systemRunContext = input.context.systemRunContext;
  const projectedScopeId =
    systemRunContext?.scopeId ||
    (typeof input.context.sharedState?._dimensionScopeId === 'string'
      ? input.context.sharedState._dimensionScopeId
      : undefined);
  return {
    timeoutMs: input.execution?.timeoutMs,
    abortSignal: input.execution?.abortSignal,
    diagnostics: input.execution?.diagnostics,
    strategyContext: input.context.strategyContext,
    systemRunContext: input.context.systemRunContext,
    budgetOverride: input.execution?.budgetOverride,
    toolChoiceOverride: input.execution?.toolChoiceOverride,
    groundingEnforcement: input.execution?.groundingEnforcement,
    contextWindow: input.context.contextWindow,
    trace: input.context.trace,
    memoryCoordinator: input.context.memoryCoordinator,
    sharedState: input.context.sharedState,
    context: {
      ...promptContextFor(input),
      ...(projectedScopeId ? { dimensionScopeId: projectedScopeId } : {}),
    },
    source: input.context.runtimeSource || runtimeSourceFor(input.context.source),
  };
}

function runtimeSourceFor(source: AgentRunInput['context']['source']): AgentRuntimeSource {
  if (source === 'http-chat' || source === 'http-stream') {
    return 'user';
  }
  if (source === 'mcp' || source === 'bootstrap' || source === 'system-workflow') {
    return 'system';
  }
  return 'system';
}

function stripProfileSelectionMetadata(metadata: Record<string, unknown>) {
  const { mode: _mode, preset: _preset, profile: _profile, ...rest } = metadata;
  return rest;
}

function toChannel(source: AgentRunInput['context']['source']) {
  if (source === 'mcp') {
    return Channel.MCP;
  }
  if (source === 'internal' || source === 'system-workflow' || source === 'bootstrap') {
    return Channel.INTERNAL;
  }
  return Channel.HTTP;
}

function inferRunStatus(result: Awaited<ReturnType<AgentRuntimeLike['execute']>>): AgentRunStatus {
  const cancellation = getDiagnosticsCancelReason(result.diagnostics);
  const outcome = getRecord(result.phases?._pipelineOutcome).outcome;
  if (outcome === 'aborted') {
    return 'aborted';
  }
  const timedOutStages = result.diagnostics?.timedOutStages || [];
  // timedOutStages 是历史尝试记录。只有每个超时阶段都有明确的最终成功输出，
  // 且管线正常完成，才把旧超时及其派生 abort 当成已恢复；审计历史继续保留。
  const recoveredTimeouts =
    outcome === 'completed' &&
    timedOutStages.length > 0 &&
    timedOutStages.every((stage) => {
      const finalStage = getRecord(result.phases?.[stage]);
      return finalStage.timedOut !== true && Boolean(stringValue(finalStage.reply)?.trim());
    });
  const terminalCancellation =
    recoveredTimeouts && ['stage_timeout', 'abort_signal'].includes(cancellation || '')
      ? null
      : cancellation;
  if (
    terminalCancellation === 'stage_timeout' ||
    (timedOutStages.length > 0 && !recoveredTimeouts)
  ) {
    return 'timeout';
  }
  if (terminalCancellation === 'abort_signal') {
    return 'aborted';
  }
  if (result.diagnostics?.warnings?.some((warning) => warning.code === 'policy_rejected')) {
    return 'blocked';
  }
  if (
    outcome === 'failed' ||
    terminalCancellation ||
    result.diagnostics?.warnings?.some((warning) => warning.code === 'fallback_reply')
  ) {
    return 'error';
  }
  return result.reply?.trim() ? 'success' : 'error';
}

/** 失败归类依据，随 warn 日志输出，便于区分结构化分支与文案兜底。 */
type RunErrorClassificationBasis =
  | 'agent_execution_timeout'
  | 'abort_error'
  | 'blocked_text'
  | 'unclassified';

/**
 * 把 Runtime 抛出的失败归为宿主可见的 AgentRunStatus。
 * - 'timeout' 只认运行级硬超时（AgentExecutionTimeoutError 或其稳定 code）。宿主把 status='timeout'
 *   当作可恢复的生产者超时，文案含 timeout 的普通 Error（策略、闸门、宿主锁等）一律不再算超时。
 * - 'aborted' 只认 name==='AbortError'（与 createLlmAbortError 的取消契约一致：判定只看 name，
 *   DOMException 的 code 是数字 20，不可靠）；文案含 abort 的普通 Error 不再算取消。
 * - 'blocked' 暂保留文案匹配：Runtime 目前没有会抛出的结构化“拒绝”错误
 *   （策略拒绝走 validateBefore 的 policy_rejected 诊断，由 inferRunStatus 归类），本包不改这条口径。
 */
function classifyRunError(err: unknown): {
  status: AgentRunStatus;
  basis: RunErrorClassificationBasis;
} {
  if (isAgentExecutionTimeoutError(err)) {
    return { status: 'timeout', basis: 'agent_execution_timeout' };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { status: 'aborted', basis: 'abort_error' };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/forbidden|blocked|denied/i.test(message)) {
    return { status: 'blocked', basis: 'blocked_text' };
  }
  return { status: 'error', basis: 'unclassified' };
}

function readErrorCode(err: unknown): string | number | null {
  if (!(err instanceof Error)) {
    return null;
  }
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? code : null;
}

function promptContextFor(input: AgentRunInput): Record<string, unknown> {
  return { ...getRecord(input.message.metadata?.context), ...(input.context.promptContext || {}) };
}

function describeRun(input: AgentRunInput, profileId: string): Record<string, unknown> {
  const promptContext = getRecord(input.context.promptContext);
  const sharedState = getRecord(input.context.sharedState);
  const dimensionMeta = getRecord(sharedState._dimensionMeta);
  return {
    profileId,
    source: input.context.source,
    runtimeSource: input.context.runtimeSource || null,
    sessionId:
      stringValue(input.message.sessionId) ||
      stringValue(input.message.metadata?.sessionId) ||
      stringValue(input.context.actor?.sessionId) ||
      null,
    dimension:
      stringValue(input.params?.dimId) ||
      stringValue(input.message.metadata?.dimension) ||
      stringValue(promptContext.dimensionId) ||
      stringValue(promptContext.dimId) ||
      stringValue(dimensionMeta.id) ||
      null,
    phase: stringValue(input.message.metadata?.phase) || null,
  };
}

function formatRunTrace(trace: Record<string, unknown>): string {
  const parts = [
    `profile=${trace.profileId || 'unknown'}`,
    trace.dimension ? `dim=${trace.dimension}` : '',
    trace.sessionId ? `session=${trace.sessionId}` : '',
    trace.phase ? `phase=${trace.phase}` : '',
    trace.source ? `source=${trace.source}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

function getDiagnosticsCancelReason(diagnostics: unknown): string | null {
  const efficiency = getRecord(getRecord(diagnostics).efficiency);
  return stringValue(efficiency.cancelReason) || null;
}

function getDiagnosticsAiErrorCount(diagnostics: unknown): number | null {
  const value = getRecord(diagnostics).aiErrorCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export default AgentService;
