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
import type { AgentDiagnostics } from '../runtime/AgentRuntimeTypes.js';
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
    const compiledProfile = this.#compileProfile(input);
    const trace = describeRun(input, compiledProfile.id);
    const startedAt = Date.now();
    this.#log('info', `[AgentService] run start ${formatRunTrace(trace)}`, trace);
    if (this.#runCoordinator.canCoordinate(compiledProfile)) {
      let coordinated: AgentRunResult | null | undefined;
      try {
        this.#log('info', `[AgentService] coordinated run start ${formatRunTrace(trace)}`, {
          ...trace,
          concurrencyMode: compiledProfile.concurrency?.mode || null,
        });
        coordinated = await this.#runCoordinator.run(input, compiledProfile, (childInput) =>
          this.run(childInput)
        );
      } catch (err: unknown) {
        this.#log('warn', `[AgentService] coordinated run failed ${formatRunTrace(trace)}`, {
          ...trace,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        throw toError(err);
      }
      if (!coordinated) {
        // 不可达防御（L8-C15）：canCoordinate 与 AgentRunCoordinator.run 返回 null 的条件互补，
        // 内置 merger 也不会返回空值。走到这里说明协调器实现或注入的 merger 违反契约；
        // 不能静默回落到单 runtime（会用父消息再跑一次模型且无 child），按明确错误 reject。
        this.#log(
          'warn',
          `[AgentService] coordinated run returned no result ${formatRunTrace(trace)}`,
          {
            ...trace,
            durationMs: Date.now() - startedAt,
            concurrencyMode: compiledProfile.concurrency?.mode || null,
            coordinatedResult: coordinated === null ? 'null' : typeof coordinated,
            fallback: 'none-rejected',
          }
        );
        throw new Error(`Agent coordinator returned no result for profile "${compiledProfile.id}"`);
      }
      this.#log('info', `[AgentService] coordinated run complete ${formatRunTrace(trace)}`, {
        ...trace,
        durationMs: Date.now() - startedAt,
        status: coordinated.status,
        toolCallCount: coordinated.toolCalls.length,
      });
      return coordinated;
    }
    let preflightStatus: 'aborted' | 'timeout' | null = input.execution?.abortSignal?.aborted
      ? 'aborted'
      : null;
    // 预检归因只用于日志，区分“探针自身超时/被取消/返回 true”与“探针返回后期限已被耗尽”。
    let preflightReason: string | null = preflightStatus ? 'signal-aborted-before-check' : null;
    const requestedTimeoutMs = input.execution?.timeoutMs;
    const deadlineMs = isPositiveFiniteTimeout(requestedTimeoutMs) ? requestedTimeoutMs : undefined;
    // 只有真正执行了 shouldAbort 预检时才计时并扣减期限；没有预检的 run 原样转交调用方期限。
    let preflightMs: number | null = null;
    const shouldAbort = input.execution?.shouldAbort;
    if (!preflightStatus && shouldAbort) {
      const preflightStartedAt = Date.now();
      // 开工检查可以异步，但等待也必须响应本次signal和显式期限；不增加运行中轮询。
      const check = await runOperation(() => shouldAbort(), {
        abortSignal: input.execution?.abortSignal,
        timeoutMs: deadlineMs,
      });
      preflightMs = Math.max(0, Date.now() - preflightStartedAt);
      if (check.status === 'error') {
        const error =
          check.error instanceof Error
            ? check.error
            : new Error('Agent cancellation check failed', { cause: check.error });
        this.#log('warn', `[AgentService] cancellation check failed ${formatRunTrace(trace)}`, {
          ...trace,
          error: error.message,
          preflightMs,
        });
        throw error;
      }
      if (check.status === 'timeout') {
        preflightStatus = 'timeout';
        preflightReason = 'check-timeout';
      } else if (
        check.status === 'aborted' ||
        (check.status === 'ok' && check.value === true) ||
        input.execution?.abortSignal?.aborted
      ) {
        preflightStatus = 'aborted';
        preflightReason = check.status === 'ok' && check.value === true ? 'check-true' : 'aborted';
      } else if (deadlineMs !== undefined && preflightMs >= deadlineMs) {
        // 同步阻塞或计时器来不及触发的探针会以 ok 返回，但调用方声明的期限已经花完：
        // 不再给 runtime 一份新期限（那会让单次 run 接近 2×timeoutMs），按预检超时收口。
        preflightStatus = 'timeout';
        preflightReason = 'deadline-exhausted';
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
        message: `AgentService did not start runtime work after preflight ${preflightStatus} (preflightMs=${preflightMs ?? 0})`,
      });
      this.#log(
        'info',
        `[AgentService] run ${preflightStatus} before execution ${formatRunTrace(trace)}`,
        {
          ...trace,
          preflightReason,
          preflightMs,
          requestedTimeoutMs: requestedTimeoutMs ?? null,
        }
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
    // 传给 runtime 的是剩余预算：预检已花掉的时间从调用方期限中扣除，下限 1ms（耗尽已在上面走超时分支）。
    const runtimeTimeoutMs =
      preflightMs !== null && deadlineMs !== undefined
        ? Math.max(1, deadlineMs - preflightMs)
        : requestedTimeoutMs;
    const { runtime, message } = this.#prepareRuntime(input, compiledProfile, trace, startedAt);
    try {
      // 冷启动监控依赖这里把“维度 child run 已进入 AgentRuntime”明确打出来。
      // 仅靠 GenerateTaskManager 的 filling 状态看不出是在排队、模型请求中还是已失败待收口。
      this.#log('info', `[AgentService] runtime execute start ${formatRunTrace(trace)}`, {
        ...trace,
        runtimeSource: input.context.runtimeSource || runtimeSourceFor(input.context.source),
        preflightMs,
        requestedTimeoutMs: requestedTimeoutMs ?? null,
        runtimeTimeoutMs: runtimeTimeoutMs ?? null,
      });
      const result = await runtime.execute(message, buildRuntimeOptions(input, runtimeTimeoutMs));
      const timeoutRecovery = resolveTimeoutRecovery(result);
      const status = inferRunStatus(result, timeoutRecovery);
      const diagnostics = this.#projectRecoveredTimeouts(result, timeoutRecovery, status, trace);
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
        diagnostics,
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

  /**
   * profile 编译失败此前在 'run start' 之前直接 reject，日志里什么都没有。
   * 这里补一条失败日志（trace 用调用方请求的 profile 标识，因为编译产物不存在），然后原样重抛，
   * 保持 reject 语义不变。
   */
  #compileProfile(input: AgentRunInput): CompiledAgentProfile {
    const compileStartedAt = Date.now();
    try {
      return this.#profileCompiler.compile(input.profile, {
        params: input.params,
        context: input.context,
      });
    } catch (err: unknown) {
      const trace = describeRun(input, requestedProfileId(input.profile));
      this.#log('warn', `[AgentService] profile compile failed ${formatRunTrace(trace)}`, {
        ...trace,
        durationMs: Date.now() - compileStartedAt,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : typeof err,
      });
      throw toError(err);
    }
  }

  /**
   * runtime 构建、fileCache 注入和消息组装位于 execute 的 try 之外：这三步失败属于“运行未能开始”，
   * 沿用既有 reject 语义（不改成 status=error 结果，那是宿主可见变更），但必须留下
   * 'runtime build failed' 日志，否则冷启动监控只看到 'run start' 会把该维度当成仍在运行。
   * buildStep 标出失败发生在哪一步。
   */
  #prepareRuntime(
    input: AgentRunInput,
    compiledProfile: CompiledAgentProfile,
    trace: Record<string, unknown>,
    startedAt: number
  ): { runtime: AgentRuntimeLike; message: AgentMessage } {
    let buildStep: 'build' | 'file-cache' | 'message' = 'build';
    try {
      const runtime = this.#runtimeBuilder.build(compiledProfile, {
        lang: input.context.lang || null,
        onProgress: input.execution?.onProgress || null,
        onToolCall: input.execution?.onToolCall || null,
      });
      if (input.context.fileCache !== undefined) {
        buildStep = 'file-cache';
        runtime.setFileCache?.(input.context.fileCache);
      }
      buildStep = 'message';
      const message = buildAgentMessage(input);
      return { runtime, message };
    } catch (err: unknown) {
      this.#log('warn', `[AgentService] runtime build failed ${formatRunTrace(trace)}`, {
        ...trace,
        buildStep,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : typeof err,
      });
      throw toError(err);
    }
  }

  /**
   * L5-P33r3b（用户决定 2026-10-19，“Agent 出口修”）：已被重跑恢复的超时不再作为宿主判定依据。
   *
   * 背景：attempt.ts、AgentRuntime 的 ExitController 与 DiagnosticsCollector.merge 都只追加
   * timedOutStages / cancelReason='stage_timeout'，没有移除路径；方案 A 下 analysis_retry 整段重跑
   * 成功后 produce 照常持久化候选、inferRunStatus 判 success，但宿主 AgentRunProjections
   * 只要 timedOutStages 非空（或 cancelReason=stage_timeout）就判 timeout，且只在含 'produce' 时
   * 救回，于是计 0 有效候选。只有服务出口能一次覆盖全部追加来源，所以在这里收口。
   *
   * 规则：只在 recoveredTimeouts 成立（与 inferRunStatus 同一判定）时改写返回副本——
   * timedOutStages 清空、原列表移到 recoveredTimedOutStages（保留审计），派生的
   * stage_timeout / abort_signal cancelReason 清除，其他 cancelReason 原样保留。
   * 未恢复的超时（含 producer 最终回执仍超时）原样透传，宿主照旧按 timedOutStages 含 produce 救回。
   * 不回写 runtime 持有的诊断对象。
   */
  #projectRecoveredTimeouts(
    result: Awaited<ReturnType<AgentRuntimeLike['execute']>>,
    recovery: TimeoutRecovery,
    status: AgentRunStatus,
    trace: Record<string, unknown>
  ): AgentDiagnostics | null {
    const diagnostics = result.diagnostics;
    if (!diagnostics || !recovery.recovered) {
      return diagnostics || null;
    }
    const cancelReason = getDiagnosticsCancelReason(diagnostics);
    const clearedCancelReason =
      cancelReason && RECOVERED_TIMEOUT_CANCEL_REASONS.has(cancelReason) ? cancelReason : null;
    // 已有审计记录（例如宿主再包一层 AgentService 的 runtime）与本次恢复的阶段合并去重。
    const recoveredTimedOutStages = [
      ...new Set([
        ...readStringArray(diagnostics.recoveredTimedOutStages),
        ...recovery.timedOutStages,
      ]),
    ];
    const projected: AgentDiagnostics = {
      ...diagnostics,
      timedOutStages: [],
      recoveredTimedOutStages,
    };
    if (clearedCancelReason && diagnostics.efficiency) {
      const { cancelReason: _cleared, ...efficiency } = diagnostics.efficiency;
      projected.efficiency = efficiency;
    }
    this.#log(
      'info',
      `[AgentService] ${TIMEOUT_RECOVERED_BY_RERUN} stages=${recovery.timedOutStages.join(',')} ${formatRunTrace(trace)}`,
      {
        ...trace,
        code: TIMEOUT_RECOVERED_BY_RERUN,
        status,
        recoveredTimedOutStages,
        clearedCancelReason,
        retainedCancelReason: clearedCancelReason ? null : cancelReason,
        finalReceipts: recovery.finalReceipts,
      }
    );
    return projected;
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

/** runtimeTimeoutMs 是扣除预检耗时后的剩余期限；没有预检时等于调用方原值。 */
function buildRuntimeOptions(
  input: AgentRunInput,
  runtimeTimeoutMs: number | undefined
): AgentRuntimeRunOptions {
  const systemRunContext = input.context.systemRunContext;
  const projectedScopeId =
    systemRunContext?.scopeId ||
    (typeof input.context.sharedState?._dimensionScopeId === 'string'
      ? input.context.sharedState._dimensionScopeId
      : undefined);
  return {
    timeoutMs: runtimeTimeoutMs,
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

/** 只有 HTTP 用户会话算 'user'；mcp、bootstrap、system-workflow、internal 都按系统运行。 */
function runtimeSourceFor(source: AgentRunInput['context']['source']): AgentRuntimeSource {
  if (source === 'http-chat' || source === 'http-stream') {
    return 'user';
  }
  return 'system';
}

function isPositiveFiniteTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 编译失败时没有编译产物，trace 用调用方请求的 id / preset / basePreset 标识。 */
function requestedProfileId(profile: AgentRunInput['profile']): string {
  const record = getRecord(profile);
  return (
    stringValue(record.id) ||
    stringValue(record.preset) ||
    stringValue(record.basePreset) ||
    'unknown'
  );
}

/** Error 实例原样返回（保持调用方可见的错误身份）；非 Error 抛出值包成 Error 并保留 cause。 */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err), { cause: err });
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

/** 出口恢复超时搬移的日志代码（L5-P33r3b）。 */
const TIMEOUT_RECOVERED_BY_RERUN = 'timeout_recovered_by_rerun';

/** 超时派生的 cancelReason：超时全部恢复后它们不再代表终态，出口清除；其他取值原样保留。 */
const RECOVERED_TIMEOUT_CANCEL_REASONS: ReadonlySet<string> = new Set([
  'stage_timeout',
  'abort_signal',
]);

/** 超时恢复判定结果，inferRunStatus 与出口搬移共用，保证两处口径一致。 */
interface TimeoutRecovery {
  /** 运行回执里的超时阶段（历史尝试记录，只追加）。 */
  timedOutStages: string[];
  /** 管线正常完成且每个超时阶段的最终回执都已恢复。 */
  recovered: boolean;
  /** 每个超时阶段最终回执的摘要，仅用于日志留痕。 */
  finalReceipts: Array<{ stage: string; timedOut: boolean; replyChars: number }>;
}

/**
 * timedOutStages 是历史尝试记录。只有每个超时阶段都有明确的最终成功输出（最终回执
 * timedOut!==true 且 reply 非空），且管线 outcome=completed，才算已恢复；最终回执由
 * analysis_retry 整段重跑、fast retry 或拒绝重试覆盖，出口不区分重跑机制。
 */
function resolveTimeoutRecovery(
  result: Awaited<ReturnType<AgentRuntimeLike['execute']>>
): TimeoutRecovery {
  const outcome = getRecord(result.phases?._pipelineOutcome).outcome;
  const timedOutStages = result.diagnostics?.timedOutStages || [];
  // 管线未正常完成或没有超时历史时不读阶段回执（与改动前的短路求值一致；
  // 写成 !(length > 0) 是为了自定义 runtime 回执形状异常时与旧判定同样短路）。
  if (outcome !== 'completed' || !(timedOutStages.length > 0)) {
    return { timedOutStages, recovered: false, finalReceipts: [] };
  }
  const finalReceipts = timedOutStages.map((stage) => {
    const finalStage = getRecord(result.phases?.[stage]);
    return {
      stage,
      timedOut: finalStage.timedOut === true,
      replyChars: stringValue(finalStage.reply)?.trim().length ?? 0,
    };
  });
  const recovered = finalReceipts.every((receipt) => !receipt.timedOut && receipt.replyChars > 0);
  return { timedOutStages, recovered, finalReceipts };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function inferRunStatus(
  result: Awaited<ReturnType<AgentRuntimeLike['execute']>>,
  recovery: TimeoutRecovery
): AgentRunStatus {
  const cancellation = getDiagnosticsCancelReason(result.diagnostics);
  const outcome = getRecord(result.phases?._pipelineOutcome).outcome;
  if (outcome === 'aborted') {
    return 'aborted';
  }
  const { timedOutStages, recovered: recoveredTimeouts } = recovery;
  // 全部超时阶段已恢复时，旧超时及其派生 abort 不再决定状态；审计历史由出口移到
  // recoveredTimedOutStages（见 #projectRecoveredTimeouts）。
  const terminalCancellation =
    recoveredTimeouts && RECOVERED_TIMEOUT_CANCEL_REASONS.has(cancellation || '')
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
