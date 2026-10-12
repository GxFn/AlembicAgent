import { isPersistedSubmission, readToolObservation } from '../utils/toolOutcomes.js';
/**
 * AgentRuntime — 统一 Agent 执行引擎 (The Brain)
 *
 * 核心思想: 不存在类型分野，只有 ONE Runtime。
 * 只有 ONE Runtime，由 Capability + Strategy + Policy 配置驱动。
 *
 * AgentRuntime 是:
 *   - ReAct 循环的宿主 (Thought → Action → Observation)
 *   - Capability 的组合容器 (加载哪些技能)
 *   - Policy 的执行者 (遵守哪些约束)
 *   - Strategy 的被委托者 (Strategy 调用 runtime.reactLoop())
 *
 * 认知架构 (CoALA):
 *   Perception → Working Memory → Reasoning → Action → Reflection
 *   │             │                │           │         │
 *   AgentMessage   history+memory   LLM call    Tools    Policy.validateAfter
 *
 * 引擎级能力:
 *   - ContextWindow: 三级递进压缩，动态 token 预算 (可选注入)
 *   - ExplorationTracker: 阶段状态机 + 信号收集 + Nudge + Graceful exit (可选注入)
 *   - AI 错误恢复: consecutiveAiErrors 2-strike → context reset → forced summary
 *   - 空响应重试: consecutiveEmptyResponses + rollback (system 场景)
 *   - 熔断器感知: gateway ReliabilityController 熔断 → chatWithTools 抛 CIRCUIT_OPEN → 合成摘要兜底
 *   - 工具调用数量限制: MAX_TOOL_CALLS_PER_ITER = 8
 *   - 提交去重: submittedTitles / submittedPatterns
 *   - cleanFinalAnswer: 去除 nudge 噪声
 *
 * @module AgentRuntime
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Logger from '@alembic/core/logging';
import type { ModelDef } from '#ai/registry/ModelDefs.js';
import {
  isTextCompatToolCallId,
  NATIVE_TOOL_CALL_SOURCE,
  TEXT_COMPAT_CALL_SOURCE,
} from '#ai/registry/ModelQuirks.js';
import { getModelRegistry } from '#ai/registry/ModelRegistry.js';
import { observeSafely } from '#shared/observers.js';
import { runOperation } from '#shared/operation.js';
import { queryToolSchemas } from '#tools/catalog/schemaQuery.js';
import type { ToolRuntimeCallContext } from '#tools/kernel/context.js';
import type { ToolScopeRelease } from '#tools/kernel/index.js';
import type { ToolActionAllowlist, ToolSchemaQueryResult } from '#tools/kernel/toolSchema.js';
import { snapshotToolActionAllowlist } from '#tools/kernel/toolSelection.js';
import {
  applyDimensionSubmitSchemaVariant,
  DEPTH_SLOT_PROPS,
} from '../../tools/runtime/registry.js';
import { Capability } from '../../tools/runtime/toolsets/Capability.js';
import { CapabilityRegistry } from '../../tools/runtime/toolsets/CapabilityRegistry.js';
import { openLoopEvidence } from '../evidence/loopLedger.js';
import { PolicyEngine } from '../policies/index.js';
import { redactDeveloperText } from '../utils/Redaction.js';
import { AgentEventBus, AgentEvents } from './AgentEventBus.js';
import {
  bindRuntimeFailureSnapshot,
  createOwnedExecutionTimeoutError,
  isAgentExecutionTimeoutError,
  readOwnedExecutionTimeoutSnapshot,
} from './AgentExecutionTimeoutError.js';
import type { AgentMessage } from './AgentMessage.js';
import {
  type AgentProgressProcessEvent,
  type AgentResult,
  type AiError,
  type FileCacheEntry,
  type GroundingEnforcement,
  type LLMResult,
  MAX_TOOL_CALLS_PER_ITER,
  type ReactLoopOpts,
  type RuntimeConfig,
  type ToolCallEntry,
  type ToolCallHook,
  type ToolMetadata,
} from './AgentRuntimeTypes.js';
import { AgentPhase, AgentState } from './AgentState.js';
import { evaluateAnalyzeTextGroundingGate } from './AnalyzeGroundingGuard.js';
import { BudgetController } from './BudgetController.js';
import { DiagnosticsCollector } from './DiagnosticsCollector.js';
import {
  createExitController,
  readPolicyTimeoutMs,
  resolveEffectiveTimeoutMs,
} from './ExitController.js';
import { cleanFinalAnswer } from './finalAnswer.js';
import {
  describeDeclaredMode,
  type ForcedSummaryMode,
  isForcedSummaryMode,
  produceForcedSummary,
} from './forcedSummary.js';
import { HookSystem, registerDefaultHooks } from './HookSystem.js';
import { buildLlmInputAssembly, resolveLlmInputStageProfile } from './LLMInputAssembly.js';
import { measureLlmInputAssembly } from './LLMInputMeasurement.js';
import { continueResult, LLMResultType } from './LLMResultType.js';
import { LoopContext } from './LoopContext.js';
import {
  LLM_INPUT_TOO_LARGE_CODE,
  type ProviderInputLimitResolution,
  resolveProviderInputBudget,
  resolveProviderInputLimit,
  selectLlmInputTools,
  validateLlmInputSize,
} from './llmInput.js';
import { createMessageAdapter } from './MessageAdapter.js';
import {
  buildPcvNodeEvidenceProcessMetadata,
  recordPcvInputAssembly,
  recordPcvLlmOutput,
  recordPcvToolResult,
  recordPcvToolRoundOutcome,
} from './PcvNodeEvidenceRecorder.js';
import { allowsToolCallsUnderForcedNone } from './ProviderToolChoicePolicy.js';
import {
  createAgentProcessEvent,
  isDeveloperVisibleReflectionNudge,
  type ProcessEventInput,
  projectLlmInputEvent,
  projectLlmOutput,
  projectSemanticNudgeEvent,
  projectToolEndEvent,
  projectToolStartEvent,
} from './processEvents.js';
import { SystemPromptBuilder } from './SystemPromptBuilder.js';
import { createToolPipeline } from './ToolExecutionPipeline.js';
import {
  isRecordOnlyStage,
  resolveRecordOnlyStageTrigger,
} from './toolPipeline/callNormalization.js';
import { takeToolPipelineFailure } from './toolPipeline/engine.js';
import {
  createToolReceipt,
  projectToolReceipt,
  TOOL_ENVELOPE_SHAPE_REJECTED,
} from './toolReceipt.js';

// ── Re-exports for backward compatibility ──
export type {
  AgentDiagnostics,
  AgentDiagnosticWarning,
  AgentProgressProcessEvent,
  AgentProgressProcessEventContent,
  AgentProgressProcessEventContentRole,
  AgentProgressProcessEventDisplayPolicy,
  AgentProgressProcessEventKind,
  AgentProgressProcessEventRetention,
  AgentProgressProcessEventSeverity,
  AgentProgressProcessEventSourceClass,
  AgentResult,
  AiError,
  FileCacheEntry,
  FunctionCall,
  LLMResult,
  ProgressEvent,
  ReactLoopOpts,
  RuntimeConfig,
  ToolCallEntry,
  ToolCallHook,
  ToolMetadata,
} from './AgentRuntimeTypes.js';
export { MAX_TOOL_CALLS_PER_ITER } from './AgentRuntimeTypes.js';

interface RuntimeToolContract {
  actions: ToolActionAllowlist;
  ids: string[];
}

/** 本地装配完成、即将发给 provider 的输入（I08：装配与 provider 调用分属两个异常边界）。 */
interface LlmDispatchInput {
  effectiveToolChoice: string;
  messages: ReturnType<typeof buildLlmInputAssembly>['providerMessages'];
  /** observe-only 的 provider tool-choice mode，供工具抑制判定使用。 */
  providerToolChoiceMode: string | null;
  tools: ReturnType<typeof selectLlmInputTools>['tools'];
}

/** I08：本地输入装配失败的诊断码；与 provider 的 ai_error 区分，宿主据此判断是运行缺陷而非上游故障。 */
const LLM_INPUT_ASSEMBLY_FAILED_CODE = 'llm_input_assembly_failed';
/** I08：本地运行缺陷终止的 cancelReason；不与 provider_error / provider_circuit_open 混用。 */
const RUNTIME_DEFECT_CANCEL_REASON = 'runtime_defect';

// 单个模块级 ALS 随 runtime 模块存活，避免每个短命 Agent 实例创建需 disable 的 ALS。
// owner 校验使嵌套的另一个 runtime 有自己的 run，不会误继承父 runtime 的工具会话。
const toolResourceRun = new AsyncLocalStorage<{
  owner: AgentRuntime;
  runId: string;
  closed: boolean;
}>();

export class AgentRuntime {
  onToolCall: ToolCallHook | null;
  id;
  presetName;
  state;
  bus;
  aiProvider;
  toolRegistry;
  toolRouter;
  container;
  capabilities;
  strategy;
  policies;
  persona;
  memoryConfig;
  onProgress;
  lang;
  logger: Pick<Console, 'info' | 'warn'>;
  #projectRoot;
  #dataRoot;
  /** 证据台账目录键（Wave A E2）：宿主 jobId 或按实例生成的稳定回退 `run-<runtime id>`；同实例多次 reactLoop 共享 */
  #evidenceJobId: string;
  /** 证据台账目录键是否来自 runtime 回退（宿主未传 jobId）；只用于回退路径诊断。 */
  #evidenceJobIdIsFallback: boolean;
  /** 文件缓存 (bootstrap 场景注入) */
  #fileCache: FileCacheEntry[] | null = null;
  /** 额外工具白名单 (调用方按需注入，不经 Capability) */
  #additionalTools: string[] = [];
  #toolPipeline;
  #promptBuilder;
  /** 模型引用（provider:model），用于日志 / trace / 工具裁剪等运行期判断 */
  #modelRef: string;
  /** grounding enforcement 全局默认（来自 RuntimeConfig，AP-3；默认 `'off'`=PCV observe-only）。 */
  #groundingEnforcementDefault: GroundingEnforcement;
  /** 本次运行 effective grounding enforcement（execute() 解析 per-run override ?? 全局默认）。 */
  #groundingEnforcement: GroundingEnforcement;
  /** 统一事件钩子系统 */
  #hookSystem: HookSystem;
  /**
   * 每个 loop 的输入上限解析结果（I14 来源诊断）。按 LoopContext 弱引用保存：同一 runtime 可能
   * 并发跑多个 reactLoop，不能用单个实例字段；也不往公开的 budget/LoopContext 上加字段。
   */
  #providerInputLimits = new WeakMap<LoopContext, ProviderInputLimitResolution>();
  #executionAbortController: AbortController | null = null;
  #abortEventPublished = false;

  // ── 执行统计 ──
  iterationCount = 0;
  toolCallHistory: ToolCallEntry[] = [];
  tokenUsage = { input: 0, output: 0, reasoning: 0, cacheHit: 0 };
  startTime = 0;

  constructor(config: RuntimeConfig) {
    this.id = config.id || `runtime_${randomUUID().slice(0, 8)}`;
    this.presetName = config.presetName || 'custom';
    this.aiProvider = config.aiProvider;
    this.toolRegistry = config.toolRegistry;
    const toolRouter =
      config.toolRouter ||
      config.toolRegistry.getRouter?.() ||
      ((config.container as { get?: (name: string) => unknown } | null)?.get?.('toolRouter') as
        | RuntimeConfig['toolRouter']
        | undefined) ||
      null;
    if (!toolRouter) {
      throw new Error(
        'AgentRuntime requires ToolRouter. Runtime tool execution must use the unified router path.'
      );
    }
    this.toolRouter = toolRouter;
    this.container = config.container || null;
    this.capabilities = config.capabilities || [];
    this.strategy = config.strategy;
    this.policies = config.policies || new PolicyEngine([]);
    this.persona = config.persona || {};
    this.memoryConfig = config.memory || {};
    this.onProgress = config.onProgress || null;
    this.onToolCall = config.onToolCall || null;
    this.lang = config.lang || null;
    this.logger = Logger.getInstance();
    this.bus = AgentEventBus.getInstance();
    this.#projectRoot = config.projectRoot || process.cwd();
    this.#dataRoot = config.dataRoot || this.#projectRoot;
    // 回退 jobId 绑定 runtime 实例 id（默认含随机 UUID 片段），而不是毫秒时间戳：
    // 同一毫秒并发构建的两个 runtime 不会落进同一个 <dataRoot>/.asd/evidence-ledger/<jobId>/ 目录；
    // 同一实例多次 reactLoop 仍共享同一回退目录。宿主 jobId 与 sharedState._bootstrapSessionId 优先。
    this.#evidenceJobIdIsFallback = !config.jobId;
    this.#evidenceJobId = config.jobId || `run-${this.id}`;
    this.#additionalTools = config.additionalTools || [];
    this.#modelRef =
      config.modelRef ||
      `${config.aiProvider.name}:${(config.aiProvider as { model?: string }).model || 'unknown'}`;
    // AP-3：grounding enforcement 全局默认 off（PCV observe-only）；per-run 可在 execute()/reactLoop() 覆盖。
    this.#groundingEnforcementDefault = config.groundingEnforcement ?? 'off';
    this.#groundingEnforcement = this.#groundingEnforcementDefault;
    this.#toolPipeline = createToolPipeline();
    // HookSystem 由 runtime 自有：RuntimeConfig 从未声明 hookSystem，旧实现经强转读取的注入口
    // 在 src、测试与宿主仓库中均无调用方（2026-10 扫描），已移除；外部订阅统一经 `runtime.hookSystem` getter。
    this.#hookSystem = new HookSystem();
    registerDefaultHooks(this.#hookSystem, this.id, this.bus);
    this.#promptBuilder = new SystemPromptBuilder({
      persona: this.persona,
      fileCache: this.#fileCache,
      lang: this.lang,
      memoryConfig: this.memoryConfig,
    });

    this.state = this.#createInitialState();

    this.bus.publish(
      AgentEvents.AGENT_CREATED,
      {
        agentId: this.id,
        preset: this.presetName,
        capabilities: this.capabilities.map((c: Capability) => c.name),
        strategy: this.strategy?.name,
      },
      { source: this.id }
    );
  }

  // ─── 公共 API ─────────────────────────────────

  /**
   * 执行 Agent — 入口
   *
   * @param message 统一消息
   * @param [opts] 策略特定选项 (如 FanOut 的 items)
   */
  async execute(message: AgentMessage, opts: Record<string, unknown> = {}): Promise<AgentResult> {
    return this.#withToolResourceRun(() => this.#executeRun(message, opts));
  }

  async #withToolResourceRun<T>(operation: () => Promise<T>): Promise<T> {
    const runId = randomUUID();
    const scope = { owner: this, runId, closed: false };
    try {
      return await toolResourceRun.run(scope, operation);
    } finally {
      scope.closed = true;
      await this.#releaseToolScope({ runId });
    }
  }

  async #releaseToolScope(scope: ToolScopeRelease): Promise<void> {
    try {
      await this.toolRouter.releaseScope?.(scope);
    } catch (err: unknown) {
      // 清理失败可观测，但不能把已经确认的工具写入改成业务失败或覆盖原始异常。
      observeSafely(
        () =>
          this.logger.warn('[AgentRuntime] tool scope cleanup failed', {
            ...scope,
            error: err instanceof Error ? err.message : String(err),
          }),
        () => undefined
      );
    }
  }

  async #executeRun(message: AgentMessage, opts: Record<string, unknown>): Promise<AgentResult> {
    this.#abortEventPublished = false;
    // I39：状态机与计数器同为 per-run 状态，复用实例时先复位，避免上一次终态吞掉本次 start/finish。
    this.#resetStateForRun();
    this.startTime = Date.now();
    this.iterationCount = 0;
    this.toolCallHistory = [];
    this.tokenUsage = { input: 0, output: 0, reasoning: 0, cacheHit: 0 };
    // AP-3：解析本次运行 effective grounding enforcement = per-run override（AgentRunExecutionOptions
    // → buildRuntimeOptions → execute opts）?? 全局默认。PipelineStrategy 不透传任意 opts 到 reactLoop，
    // 故经实例字段桥接到 #initLoop（与 startTime/tokenUsage 等 per-run 实例状态同模式）。每次 execute 重置。
    this.#groundingEnforcement =
      opts.groundingEnforcement === 'guard'
        ? 'guard'
        : opts.groundingEnforcement === 'off'
          ? 'off'
          : this.#groundingEnforcementDefault;

    const diagnostics = DiagnosticsCollector.from(opts.diagnostics);

    // ── Policy: 执行前校验 ──
    const beforeCheck = this.policies.validateBefore({ message, capabilities: this.capabilities });
    if (!beforeCheck.ok) {
      this.logger.warn(`[AgentRuntime] Policy rejected: ${beforeCheck.reason}`);
      diagnostics.warn({
        code: 'policy_rejected',
        message: beforeCheck.reason || 'Policy rejected the request',
      });
      return {
        reply: `⚠️ ${beforeCheck.reason}`,
        toolCalls: [],
        tokenUsage: { input: 0, output: 0 },
        iterations: 0,
        durationMs: 0,
        diagnostics: diagnostics.toJSON(),
        state: this.state.toJSON(),
      };
    }

    // ── 单次执行边界：与阶段/transport 共用期限和取消终态，不再维护第二套 race ──
    const budget = this.policies.getBudget();
    const timeoutMs = readPositiveBudgetNumber(opts.timeoutMs) ?? budget?.timeoutMs ?? 300_000;
    const abortController = new AbortController();
    this.#executionAbortController = abortController;
    const parentAbortSignal =
      opts.abortSignal && typeof (opts.abortSignal as AbortSignal).aborted === 'boolean'
        ? (opts.abortSignal as AbortSignal)
        : null;
    const abortSignal = parentAbortSignal
      ? AbortSignal.any([parentAbortSignal, abortController.signal])
      : abortController.signal;
    let completedResult: AgentResult | undefined;
    const snapshot = (): AgentResult => ({
      reply: '',
      toolCalls: [...this.toolCallHistory],
      tokenUsage: { ...this.tokenUsage },
      iterations: this.iterationCount,
      durationMs: Date.now() - this.startTime,
      state: this.state.toJSON(),
      diagnostics: diagnostics.toJSON(),
    });

    try {
      // ── 委托给 Strategy ──
      const outcome = await runOperation(
        (signal) =>
          this.strategy.execute(this, message, { ...opts, abortSignal: signal, diagnostics }),
        { abortSignal, timeoutMs }
      );
      if (this.#executionAbortController === abortController) {
        this.#executionAbortController = null;
      }
      if (outcome.status === 'timeout') {
        diagnostics.warn({
          code: 'runtime_timeout',
          message:
            'Execution deadline reached; confirmed receipts retained and in-flight operations may require readback',
        });
        // 经唯一入口创建：登记 owner=this，catch 与 AgentService 只采用本 Runtime 自己抛出的超时快照。
        throw createOwnedExecutionTimeoutError(this, timeoutMs, snapshot());
      }
      if (outcome.status === 'error') {
        throw outcome.error instanceof Error
          ? outcome.error
          : new Error('Agent execution failed', { cause: outcome.error });
      }
      const cancelled = outcome.status === 'aborted' || abortSignal.aborted;
      // 不合作的策略可能仍在执行；只返回本边界已知事实，不等待/接纳它的迟到成功。
      // Strategy 保留既有宽 tool DTO；Runtime 在下方补齐公开结果的 state/duration。
      const result = (outcome.status === 'ok' ? outcome.value : snapshot()) as AgentResult;
      if (diagnostics.isEmpty()) {
        diagnostics.merge(result.diagnostics);
      }
      if (cancelled) {
        diagnostics.recordCancelReason('abort_signal');
        diagnostics.warn({
          code: 'runtime_aborted',
          message:
            'Execution boundary stopped waiting after cancellation; late strategy output is ignored',
        });
        result.reply = '[run stopped: abort_signal] Execution was cancelled.';
        const pipelineOutcome = result.phases?._pipelineOutcome;
        if (result.phases && pipelineOutcome && typeof pipelineOutcome === 'object') {
          result.phases._pipelineOutcome = { ...pipelineOutcome, outcome: 'aborted' };
        }
      }

      completedResult = result;
      // ── Policy: 执行后校验 ──
      const afterCheck = this.policies.validateAfter(
        result as import('../policies/index.js').PolicyResult
      );
      if (!afterCheck.ok) {
        this.logger.warn(`[AgentRuntime] Quality check: ${afterCheck.reason}`);
        result.qualityWarning = afterCheck.reason;
        diagnostics.warn({
          code: 'quality_warning',
          message: afterCheck.reason || 'Policy quality check failed',
        });
      }

      // 状态完成
      this.#safeTransition(cancelled ? 'abort' : 'finish', {
        reply: result.reply?.slice(0, 100),
      });

      // 回复给原始渠道
      if (message.replyFn && result.reply) {
        await message.reply(result.reply);
      }

      result.state = this.state.toJSON();
      result.durationMs = Date.now() - this.startTime;
      if (result.degraded) {
        diagnostics.markDegraded();
      }
      result.diagnostics = diagnostics.toJSON();

      if (!cancelled || !this.#abortEventPublished) {
        if (cancelled) {
          // 父 signal 取消与公开 abort() 共用一次事件；发布前标记，防止观察者重入。
          this.#abortEventPublished = true;
        }
        this.bus.publish(
          cancelled ? AgentEvents.AGENT_ABORTED : AgentEvents.AGENT_COMPLETED,
          {
            agentId: this.id,
            preset: this.presetName,
            iterations: result.iterations,
            durationMs: result.durationMs,
          },
          { source: this.id }
        );
      }

      return result;
    } catch (err: unknown) {
      const error =
        err instanceof Error ? err : new Error('Agent execution failed', { cause: err });
      this.#safeTransition('error', { error: error.message });
      // 只采用本 Runtime 抛出的硬超时快照；嵌套 Runtime 冒上来的超时错误按普通失败处理，
      // 用本边界自己的快照，既不把子运行的工具调用/用量当作自己的，也不原地改写子运行快照。
      const ownTimeoutSnapshot = readOwnedExecutionTimeoutSnapshot(this, error);
      if (!ownTimeoutSnapshot && isAgentExecutionTimeoutError(error)) {
        observeSafely(
          () =>
            this.logger.warn(
              '[AgentRuntime] foreign execution timeout snapshot not adopted; using this runtime snapshot',
              {
                runtimeId: this.id,
                errorName: error.name,
                errorCode: error.code,
                path: completedResult ? 'completed-result' : 'runtime-snapshot',
              }
            ),
          () => undefined
        );
      }
      const partial = ownTimeoutSnapshot ?? completedResult ?? snapshot();
      partial.state = this.state.toJSON();
      partial.durationMs = Date.now() - this.startTime;
      partial.diagnostics = diagnostics.toJSON();
      bindRuntimeFailureSnapshot(this, error, partial);
      this.bus.publish(
        AgentEvents.AGENT_FAILED,
        {
          agentId: this.id,
          error: error.message,
        },
        { source: this.id }
      );
      throw error;
    } finally {
      if (this.#executionAbortController === abortController) {
        this.#executionAbortController = null;
      }
    }
  }

  // ─── ReAct Loop — 供 Strategy 调用 ──────────

  /**
   * 核心 ReAct 循环。Strategy 调用此方法执行实际的 LLM + Tool 交互。
   *
   * 引擎级能力通过可选参数注入:
   *   - contextWindow → 三级递进压缩 + 动态工具结果限额
   *   - tracker → ExplorationTracker 阶段管理 + Nudge + Graceful exit
   *   - trace → ActiveContext 推理链记录
   *   - memoryCoordinator → 缓存/动态提示/观察记录
   *   - sharedState → 提交去重 { submittedTitles, submittedPatterns }
   *   - source → 'user' | 'system' (影响错误恢复 + 强制摘要行为)
   *
   * 向后兼容: 以上参数均为可选。不提供时退化为原始裸循环。
   *
   * @param prompt 用户/系统提示
   * @param [opts.history] 对话历史
   * @param [opts.context] 额外上下文
   * @param [opts.capabilityOverride] 临时覆盖 capability (Pipeline 阶段用)
   * @param [opts.budgetOverride] 临时覆盖 budget
   * @param [opts.systemPromptOverride] 完全覆盖系统提示词 (Bootstrap 阶段专用)
   * @param [opts.onToolCall] 本轮独立的工具调用钩子，优先于 runtime 级
   * @param [opts.contextWindow] 上下文窗口管理器
   * @param [opts.tracker] ExplorationTracker 实例
   * @param [opts.trace] ActiveContext 实例
   * @param [opts.memoryCoordinator] MemoryCoordinator 实例
   * @param [opts.sharedState] 共享状态 { submittedTitles, submittedPatterns }
   * @param [opts.source] 'user' | 'system'
   * @param [opts.toolChoiceOverride] 首轮 toolChoice 覆盖 ('required'/'auto'/'none')
   *   首轮强制 LLM 生成 tool call（LLM 自行决定调哪个工具、传什么参数）。
   *   这不是替 LLM 做决定，而是告诉 LLM "你必须调用某个工具"。
   *   仅在第一轮生效，后续轮次恢复正常 toolChoice 逻辑。
   */
  async reactLoop(prompt: string, opts: ReactLoopOpts = {}) {
    const scope = toolResourceRun.getStore();
    if (scope?.owner === this) {
      if (scope.closed) {
        this.logger.warn('[AgentRuntime] late loop rejected: tool resource run already closed');
        throw new Error('Cannot start a loop after its tool resource run has closed');
      }
      return this.#runReactLoop(prompt, opts);
    }
    return this.#withToolResourceRun(() => this.#runReactLoop(prompt, opts));
  }

  async #runReactLoop(prompt: string, opts: ReactLoopOpts) {
    const ctx = this.#initLoop(prompt, opts);
    try {
      return await this.#performReactLoop(ctx);
    } finally {
      const scope = ctx.resourceScope;
      if (scope) {
        await this.#releaseToolScope({ runId: scope.runId, viewId: scope.viewId });
      }
    }
  }

  async #performReactLoop(ctx: LoopContext) {
    // ─── ReAct 主循环 (编排骨架) ─────
    while (true) {
      ctx.iteration++;
      this.iterationCount++;

      let roundOpen = false;
      const closeRound = () => {
        if (!roundOpen) {
          return;
        }
        // 先标记，避免自定义 trace 抛错后被 finally 再次调用。
        roundOpen = false;
        ctx.trace?.endRound?.();
      };
      try {
        ctx.trace?.startRound(ctx.iteration);
        roundOpen = Boolean(ctx.trace);

        // 所有钩子分发都带上本 loop 的诊断落点：钩子失败额外写入 AgentDiagnostics.warnings
        // （hook_handler_failed）。按分发传入而非挂在 HookSystem 实例上，并发 loop 互不串记。
        this.#hookSystem.emitSync(
          'agent:iteration:before',
          {
            iteration: ctx.iteration,
            phase: ctx.tracker?.phase,
          },
          { diagnostics: ctx.diagnostics }
        );

        // 退出判定 (tracker + policy)
        if (this.#shouldExit(ctx)) {
          break;
        }

        // 迭代准备 (hooks + nudge + compact + toolChoice + prompt)
        const { toolChoice, toolSchemas, effectiveSystemPrompt, dynamicContext, compactResult } =
          this.#prepareIteration(ctx);

        // LLM 调用 (含错误恢复 + 空响应重试)
        const llmResult = await this.#callLLM(
          ctx,
          toolChoice,
          toolSchemas,
          effectiveSystemPrompt,
          dynamicContext,
          compactResult
        );
        if (!llmResult) {
          break;
        }
        if (llmResult.type === LLMResultType.CONTINUE) {
          continue;
        }

        // ActiveContext: 记录 AI 的推理文本 + 提取/更新计划
        if (ctx.trace && llmResult.text) {
          ctx.trace.setThought(llmResult.text);
          ctx.trace.extractAndSetPlan?.(llmResult.text, ctx.iteration);
        }

        // 分支: 有 Tool Call
        if ((llmResult.functionCalls?.length ?? 0) > 0) {
          // I38：工具轮是非阻断轮（grounding gate 只评估文本轮），清零连续 grounding 阻断计数，
          // 让之后的无证据文本轮重新获得完整阻断额度。
          ctx.consecutiveGroundingBlocks = 0;
          const exitAfterTools = await this.#processToolCalls(ctx, llmResult, closeRound);
          this.#hookSystem.emitSync(
            'agent:iteration:after',
            {
              iteration: ctx.iteration,
              hadToolCalls: true,
              hadText: !!llmResult.text,
            },
            { diagnostics: ctx.diagnostics }
          );
          if (exitAfterTools) {
            break;
          }
          continue;
        }

        // 分支: 纯文本回复
        this.#hookSystem.emitSync(
          'agent:iteration:after',
          {
            iteration: ctx.iteration,
            hadToolCalls: false,
            hadText: true,
          },
          { diagnostics: ctx.diagnostics }
        );
        if (this.#processTextResponse(ctx, llmResult, closeRound)) {
          break;
        }
      } finally {
        // 正常分支仍在原位置关闭；提前退出/重试/异常只补关闭 trace，不推进 tracker 或补发成功 Hook。
        // 清理观察失败不能覆盖 provider/tool 的原始错误或取消终态。
        if (roundOpen) {
          observeSafely(closeRound, () =>
            this.logger.warn('[AgentRuntime] trace round cleanup failed; loop outcome retained', {
              agentId: this.id,
              iteration: ctx.iteration,
            })
          );
        }
      }
    }

    return this.#finalize(ctx);
  }

  // ─── 提取方法: reactLoop 内部阶段 ────────────

  /** 按调用顺序装配循环资源；共享引用与控制器的状态所有权在这里保持可见。 */
  #initLoop(prompt: string, opts: ReactLoopOpts) {
    const {
      history = [],
      context = {},
      capabilityOverride,
      additionalToolsOverride,
      budgetOverride,
      systemPromptOverride,
      onToolCall,
      contextWindow,
      tracker,
      trace,
      memoryCoordinator,
      sharedState,
      source,
      toolChoiceOverride,
      groundingEnforcement,
      abortSignal,
      diagnostics,
    } = opts;
    const diagnosticsCollector = DiagnosticsCollector.from(diagnostics);

    // 解析 capabilities
    const caps = capabilityOverride
      ? this.#resolveCapabilities(capabilityOverride)
      : this.capabilities;

    // 收集工具 (空列表是明确无工具，不再隐式展开为全量工具)
    const toolContract = this.#collectToolContract(caps, additionalToolsOverride);
    // 构建基础系统提示词 (委托 SystemPromptBuilder)
    let baseSystemPrompt = systemPromptOverride || this.#promptBuilder.build(caps, context);

    // 创建统一消息适配器 (消除 useCtxWin 双模式)
    const messages = createMessageAdapter(contextWindow);

    // 加载历史 + 用户 prompt
    for (const h of history) {
      if (h.role === 'assistant') {
        messages.appendAssistantText(h.content);
      } else {
        messages.appendUserMessage(h.content);
      }
    }
    messages.appendUserMessage(prompt);

    // 预算
    const baseBudget = budgetOverride ||
      this.policies.getBudget() || {
        maxIterations: 20,
        maxTokens: 4096,
        temperature: 0.7,
      };
    // 输入长度上限（I14）：显式 maxProviderInputTokens 优先，其次模型注册表 contextWindow 减输出预留，
    // 都没有时保留 128k 默认。注册表来源写进本 loop 的预算副本（不改调用方传入的 budgetOverride
    // 或策略返回的对象），输入长度守卫因此按模型真实窗口拒绝，而不是让小窗口模型在 provider 侧失败。
    // 输出预留与 #callLLM 的实际请求同口径：budget.maxTokens ?? (system ? 8192 : 4096)。
    const providerInputLimit = resolveProviderInputLimit({
      budget: baseBudget,
      registeredModel: lookupRegisteredModelDef(this.#modelRef),
      defaultMaxOutputTokens: source === 'system' ? 8192 : 4096,
    });
    const budget =
      providerInputLimit.source === 'model-registry'
        ? { ...baseBudget, maxProviderInputTokens: providerInputLimit.maxTokens }
        : baseBudget;
    this.#logProviderInputLimit(providerInputLimit);

    // 系统源: 注入轮次预算 (委托 SystemPromptBuilder)
    baseSystemPrompt = SystemPromptBuilder.injectBudget(baseSystemPrompt, {
      source,
      tracker,
      budget,
    });

    // 状态转移
    this.#safeTransition('start', { prompt: prompt.slice(0, 100) });
    this.#safeTransition('plan_ready');

    this.bus.publish(
      AgentEvents.AGENT_STARTED,
      {
        agentId: this.id,
        prompt: prompt.slice(0, 100),
        capabilities: caps.map((c: Capability) => c.name),
      },
      { source: this.id }
    );

    // 先按宿主 job/维度打开唯一生产台账，再由 catalog 根据真实资源裁剪 schema。
    const evidenceLedger = openLoopEvidence({
      dataRoot: this.#dataRoot,
      defaultJobId: this.#evidenceJobId,
      sessionId: this.id,
      sharedState: sharedState ?? null,
      logger: this.logger,
    });
    // 回退路径诊断：宿主未传 jobId，且台账实际落在 runtime 回退目录（即 sharedState 也未给
    // _bootstrapSessionId）时记录一次。直接比对打开结果的 job 目录，不复制 openLoopEvidence 的选择逻辑。
    if (
      evidenceLedger &&
      this.#evidenceJobIdIsFallback &&
      basename(dirname(evidenceLedger.filePath)) === this.#evidenceJobId
    ) {
      const ledgerFile = evidenceLedger.filePath;
      observeSafely(
        () =>
          this.logger.info(
            '[AgentRuntime] evidence ledger opened under runtime-scoped fallback job id',
            {
              jobId: this.#evidenceJobId,
              runtimeId: this.id,
              dimensionId: basename(ledgerFile, '.jsonl'),
              reason: 'no host jobId and no sharedState._bootstrapSessionId',
            }
          ),
        () => undefined
      );
    }

    // 当前运行资源准备后再查询。schema 与执行动作消费同一快照；无资源的静态目录不能代替此判断。
    const projection = this.#queryToolSchemas(toolContract, this.#modelRef, {
      agentId: this.id,
      sharedState: sharedState || null,
      memoryCoordinator: memoryCoordinator || null,
      evidenceLedger,
    });
    const toolSchemas = projection.schemas;
    const allowedToolIds = toolContract.ids.filter((id) =>
      Object.hasOwn(projection.allowedTools, id)
    );
    const allowedToolActions = Object.fromEntries(
      Object.entries(projection.allowedTools)
        .filter(([, actions]) => actions != null)
        .map(([tool, actions]) => [tool, [...(actions ?? [])]])
    );
    diagnosticsCollector.recordStageToolset({
      stage: typeof context.pipelinePhase === 'string' ? context.pipelinePhase : 'react_loop',
      capabilities: caps.map((c: Capability) => c.name),
      allowedToolIds,
      allowedToolActions,
      toolSchemaCount: toolSchemas.length,
      ...(source ? { source } : {}),
    });
    for (const unavailable of projection.unavailable ?? []) {
      diagnosticsCollector.warn({
        code: 'tool_host_unavailable',
        tool: unavailable.tool,
        message: unavailable.reason,
      });
    }
    // 提示与 schema 读同一份可用性事实：阶段请求了但宿主没接线的工具，在系统提示末尾明说。
    const availabilityAwarePrompt = SystemPromptBuilder.injectToolAvailability(
      baseSystemPrompt,
      projection
    );
    if (availabilityAwarePrompt !== baseSystemPrompt) {
      this.logger.info(
        `[AgentRuntime] system prompt notes host-unavailable tools: ${[
          ...new Set((projection.unavailable ?? []).map((entry) => entry.tool)),
        ].join(', ')}`
      );
      baseSystemPrompt = availabilityAwarePrompt;
    }
    if (
      caps.length > 0 &&
      toolContract.ids.length > 0 &&
      toolSchemas.length === 0 &&
      !projection.unavailable?.length
    ) {
      this.logger.warn(
        '[AgentRuntime] tool schema projection is EMPTY while capabilities resolved tool ids; capabilityCatalog may be missing or miswired',
        {
          capabilities: caps.map((cap: Capability) => cap.name),
          allowedToolIds: toolContract.ids,
        }
      );
      diagnosticsCollector.warn({
        code: 'tool_schema_projection_empty',
        message:
          'capabilities resolved tool ids but schema projection is empty (container capabilityCatalog missing/miswired?)',
      });
    }

    const ctx = new LoopContext({
      resourceRunId: toolResourceRun.getStore()?.runId,
      messages,
      tracker: tracker || null,
      trace: trace || null,
      memoryCoordinator: memoryCoordinator || null,
      sharedState: sharedState || null,
      evidenceLedger,
      source: source || 'user',
      budget,
      capabilities: caps,
      baseSystemPrompt,
      allowedToolIds,
      allowedToolActions,
      toolSchemas,
      prompt,
      onToolCall: onToolCall || null,
      context: context || {},
      contextWindow: contextWindow || null,
      toolChoiceOverride: toolChoiceOverride || null,
      // AP-3：reactLoop 直调 opts 覆盖优先，否则回退本次运行 effective（execute 解析）/全局默认。
      groundingEnforcement: groundingEnforcement ?? this.#groundingEnforcement,
      abortSignal: (abortSignal as AbortSignal) || null,
      diagnostics: diagnosticsCollector,
    });
    this.#providerInputLimits.set(ctx, providerInputLimit);

    ctx.exitController = createExitController(ctx, this.policies);

    // 阶段会话预算口径（I02 方案 A）：budget.maxSessionInputTokens 是本 loop（一次阶段执行）内的
    // input 预算。BudgetController 在这里构造时把运行级 this.tokenUsage 的当前值记为基线，
    // 比值/压力/遥测只看本 loop 的增量；消耗仍写回 this.tokenUsage，运行级总账不变。
    // createExitController 的 session 屏蔽只看“阶段是否声明了 maxSessionInputTokens”，
    // 与 BudgetController.hasSessionBudget 读同一字段，口径一致，不受基线影响。
    ctx.budgetController = new BudgetController({
      maxSessionInputTokens: (budget.maxSessionInputTokens as number) || 0,
      maxSessionTokens: budget.maxSessionTokens as number | undefined,
      cumulativeUsage: this.tokenUsage,
      contextWindow: contextWindow || null,
      tracker: (tracker || null) as
        | import('../context/ExplorationTracker.js').ExplorationTracker
        | null,
      baseSystemPromptLength: baseSystemPrompt.length,
      toolSchemaCount: toolSchemas.length,
      logger: this.logger,
      abortSignal: ctx.abortSignal,
      l4MemoryPackageProvider: () => ({
        goal: ctx.prompt,
        phase: ctx.tracker?.phase || ctx.context?.pipelinePhase || 'react_loop',
        stageStatus: ctx.tracker?.isHardExit
          ? 'hard_exit'
          : ctx.tracker?.isGracefulExit
            ? 'graceful_exit'
            : 'running',
        activeContext: ctx.trace,
        diagnostics: ctx.diagnostics?.toJSON(),
        recentMessages:
          ctx.messages.toProjectedMessages() as import('../context/l4MemoryPackage.js').L4MemoryPackageInput['recentMessages'],
        toolCalls: ctx.toolCalls,
      }),
    });

    return ctx;
  }

  /**
   * 退出判定 — 委托 ExitController，保留 Capability 前置钩子
   * @returns true = 应退出循环
   */
  #shouldExit(ctx: LoopContext): boolean {
    const ec = ctx.exitController;
    if (ec) {
      // Policy（BudgetPolicy）的 session 上限是 profile 级配置，按整次运行累计判定，故传运行级
      // this.tokenUsage；阶段会话预算（阶段内口径）由 BudgetController 预检负责，不经这里。
      const signal = ec.checkBeforeIteration(ctx, this.tokenUsage);
      // checkBeforeIteration 只返回 exit / continue；'graceful_exit' 只由未接线的 checkAfterTextResponse
      // 产生（I34），这里按 exit 处理只是防御性分支，不代表存在优雅退出路径。
      if (signal.action === 'exit' || signal.action === 'graceful_exit') {
        this.logger.info(
          `[AgentRuntime] ExitController: ${signal.reason} — ${signal.detail || ''}`
        );
        if (signal.reason === 'abort_signal') {
          ctx.diagnostics?.recordCancelReason('abort_signal');
          recordAbortRecoveryDiagnostic(
            ctx,
            signal.detail || 'ExitController observed abort signal'
          );
        }
        if (signal.reason === 'stage_timeout') {
          ctx.diagnostics?.recordCancelReason('stage_timeout');
          ctx.diagnostics?.recordTimedOutStage(
            typeof ctx.context?.pipelinePhase === 'string'
              ? ctx.context.pipelinePhase
              : ctx.tracker?.phase || 'react_loop'
          );
        }
        ctx.diagnostics?.warn({
          code: signal.reason || 'exit',
          message: signal.detail || signal.reason || 'ExitController stopped the run',
        });
        return true;
      }
      if (signal.action === 'continue' && signal.reason) {
        this.logger.info(
          `[AgentRuntime] ExitController: ${signal.reason} (graceful) — ${signal.detail || ''}`
        );
      }
    }

    // 运行循环不驱动 Capability.onBeforeStep/onAfterStep：两个钩子在全仓没有任何覆盖实现，
    // 旧调用每轮为每个能力复制整份消息历史只为传给空函数，且未经 observeSafely 隔离。
    // 基类空方法属于 tools 公开面，保留不动；若将来出现真实消费者，应按能力是否覆盖惰性构造参数并隔离异常。
    return false;
  }

  /**
   * 迭代准备 — 合并 nudge/压缩/提示词增强/toolChoice
   *
   * 包含 session token 预算预检: 在 LLM 调用前估算 input token。预检只返回 normal|compress，
   * 只触发额外压缩与 L4 挂起（BudgetController.checkBeforeLLMCall），不做终止或 SUMMARIZE 决策；
   * 终止由 ExitController 与 policy 负责。
   *
   * @returns }
   */
  #prepareIteration(ctx: LoopContext) {
    const { tracker, trace, capabilities: _capabilities, messages } = ctx;
    const maxIterations = ctx.maxIterations;

    this.#emitProgress('thinking', { iteration: ctx.iteration, maxIterations });

    // Nudge 注入 (ExplorationTracker)
    if (tracker) {
      const nudge = tracker.getNudge(trace);
      if (nudge) {
        messages.appendUserNudge(nudge.text);
        ctx.diagnostics?.recordNudge({
          type: nudge.type,
          isReplan: nudge.type === 'planning' && ctx.iteration > 1,
        });
        if (isDeveloperVisibleReflectionNudge(nudge.type)) {
          this.#emitProcessProgress(buildSemanticNudgeProcessEvent(ctx, nudge));
        }
        this.logger.info(`[AgentRuntime] 💬 injected ${nudge.type} nudge at iter ${ctx.iteration}`);
        const _dim = ctx.sharedState?._dimensionMeta?.id || '';
        if (process.env.ALEMBIC_MCP_MODE !== '1') {
          process.stderr.write(
            `\n\x1b[36m━━━ Nudge [${nudge.type}] iter=${ctx.iteration}${_dim ? ` dim=${_dim}` : ''} ━━━\x1b[0m\n`
          );
          // 终端也是开发者观察副本；模型消息已在上方按原文入列，不能反向改写。
          process.stderr.write(`\x1b[33m${redactDeveloperText(nudge.text)}\x1b[0m\n\n`);
        }
      }
    }

    // 压缩检查 — 委托 BudgetController
    const budgetCtrl = requireBudgetController(ctx);
    const compactResult = budgetCtrl.runCompactionCycle();
    if (compactResult.level > 0) {
      this.logger.info(
        `[AgentRuntime] context compacted: L${compactResult.level}, removed ${compactResult.removed} items`
      );
    }

    // ── Session token 预算预检 ──
    const preLLMCheck = budgetCtrl.checkBeforeLLMCall(ctx.iteration);

    // 动态 toolChoice
    const forceSummaryAt = Math.max(2, Math.ceil(maxIterations * 0.8));
    const forceSummaryReached = !tracker && ctx.iteration >= forceSummaryAt;
    // I06：record-only 阶段（tracker=null 时只可能是 record_repair 微阶段）不进入强制摘要轮。
    // 该阶段 maxIterations 很小（默认 3），80% 阈值正好落在最后一轮：强制 'none' 会让本轮 note_finding
    // 被当作 tool_choice_violation 丢弃，可记录轮次从 3 降到 2。其终止已由 ExitController 的
    // checkAfterToolCalls（iteration>=max）与 checkBeforeLLM（iteration>max）保证，末轮保留 record-only 工具面。
    const recordOnlyTrigger = forceSummaryReached ? resolveRecordOnlyStageTrigger(ctx) : null;
    const forceSummary = forceSummaryReached && !recordOnlyTrigger;
    let toolChoice: string;
    if (ctx.toolChoiceOverride && ctx.iteration === 1) {
      toolChoice = ctx.toolChoiceOverride;
    } else if (tracker) {
      toolChoice = tracker.getToolChoice();
    } else {
      toolChoice = ctx.toolSchemas.length > 0 ? (forceSummary ? 'none' : 'auto') : 'none';
    }
    if (recordOnlyTrigger) {
      this.logger.info(
        `[AgentRuntime] force-summary skipped for record-only stage (trigger=${recordOnlyTrigger}) at iter ${ctx.iteration}/${maxIterations}; forceSummaryAt=${forceSummaryAt}, toolChoice=${toolChoice}, toolSchemas=${ctx.toolSchemas.length}; loop end stays with ExitController maxIterations`
      );
    }

    const toolSchemas = this.#getIterationToolSchemas(ctx, toolChoice);

    // ── System prompt 保持静态（最大化 prefix cache 命中） ──
    // 动态内容（phase context, 进度, memory prompt）分离到 dynamicContext，
    // 在 #callLLM 中作为 ephemeral user message 注入，不存储到 ContextWindow。
    const effectiveSystemPrompt = ctx.baseSystemPrompt;

    const dynamicParts: string[] = [];
    if (tracker) {
      const phaseCtx = tracker.getPhaseContext();
      if (phaseCtx) {
        dynamicParts.push(phaseCtx);
      }
    } else if (ctx.isSystem) {
      const remaining = maxIterations - ctx.iteration;
      dynamicParts.push(
        `## 当前进度\n第 ${ctx.iteration}/${maxIterations} 轮 | 剩余 ${remaining} 轮`
      );
    }
    if (ctx.isSystem && ctx.memoryCoordinator) {
      const wmContext = ctx.memoryCoordinator.buildDynamicMemoryPrompt?.({
        mode:
          ctx.context?.pipelinePhase === 'produce' || tracker?.pipelineType === 'producer'
            ? 'producer'
            : 'analyst',
        scopeId: (ctx.context?.dimensionScopeId as string) || undefined,
      });
      if (wmContext) {
        dynamicParts.push(wmContext);
      }
    }
    if (forceSummary) {
      // I06：强制摘要轮的 toolChoice 恒为 'none'（见上方分支），且 tracker=null 时不存在 provider 的
      // “none 下保留工具可见”例外（ProviderToolChoicePolicy 只对 SCAN/EXPLORE 首轮生效），
      // 本轮返回的任何工具调用都会按 tool_choice_violation 丢弃。提示因此不能再要求“只允许使用 note_finding”，
      // 只要求直接输出总结；需要补记录的 record-only 阶段已在上方豁免强制摘要。
      dynamicParts.push(
        '[系统提示] 已进入最后阶段，本轮不接受任何工具调用（包括 note_finding），请基于已有信息直接输出总结。'
      );
    }
    const dynamicContext = dynamicParts.length > 0 ? dynamicParts.join('\n\n') : null;

    // 合并常规压缩 + session budget 二次压缩
    const mergedCompact = {
      level: Math.max(compactResult.level, preLLMCheck.compaction.level),
      removed: compactResult.removed + preLLMCheck.compaction.removed,
    };
    if (mergedCompact.level > 0 || mergedCompact.removed > 0) {
      ctx.diagnostics?.recordCompaction(mergedCompact);
    }

    return {
      toolChoice,
      toolSchemas,
      effectiveSystemPrompt,
      dynamicContext,
      compactResult: mergedCompact,
    };
  }

  #getIterationToolSchemas(ctx: LoopContext, toolChoice: string): Array<Record<string, unknown>> {
    // I06：record-only 判定与 recordRepairOnlyGate 执行门共用 isRecordOnlyStage，
    // 广告面收窄到 note_finding + evidence 的轮次，执行门也按同一结论阻断越界调用。
    if (toolChoice !== 'none' && isRecordOnlyStage(ctx)) {
      if (
        !ctx.toolSchemas.some((schema) => schema.name === 'memory') ||
        !canUseDirectNoteFinding(ctx)
      ) {
        return [];
      }
      return [
        buildDirectNoteFindingSchema(true),
        ...ctx.toolSchemas.filter((schema) => schema.name === 'evidence'),
      ];
    }
    // M1a：维度运行（证据台账在场）时对 knowledge.submit 施加契约面变体——
    // evidenceRefs 必填、sources 降述、scope 自声明；广告面与运行时闸一致（E4/run-6 双教训钉）。
    // I37：knowledgeType 可选 enum 取当前维度的允许列表；runtimeBridge 把同一 _dimensionMeta
    // 交给工具运行时，提交归一化据此采用列表内的模型值或回落列表第一个。
    const base = ctx.evidenceLedger
      ? applyDimensionSubmitSchemaVariant(ctx.toolSchemas, {
          allowedKnowledgeTypes: ctx.sharedState?._dimensionMeta?.allowedKnowledgeTypes,
        })
      : ctx.toolSchemas;
    return withDirectNoteFindingSchema(base, canUseDirectNoteFinding(ctx));
  }

  /**
   * LLM 调用 — 含错误恢复 + 空响应重试 + TurnTelemetry
   *
   * @param dynamicContext 每轮动态上下文（phase/progress/memory），作为 ephemeral user message 注入
   * @param compactResult 本轮压缩结果（用于 telemetry）
   * @returns llmResult 或 null (表示应退出)
   */
  async #callLLM(
    ctx: LoopContext,
    toolChoice: string,
    toolSchemas: Array<Record<string, unknown>>,
    effectiveSystemPrompt: string,
    dynamicContext: string | null,
    compactResult?: { level: number; removed: number }
  ): Promise<LLMResult | null> {
    // L4 compaction: session 预算压力下执行 LLM-based 摘要压缩
    const budgetCtrl = requireBudgetController(ctx);
    if (budgetCtrl.pendingL4) {
      const l4Result = await budgetCtrl.executeL4IfPending(
        this.aiProvider as unknown as Parameters<typeof budgetCtrl.executeL4IfPending>[0],
        (u) => {
          ctx.addTokenUsage(u);
          // L4 摘要是一次独立的 provider 调用，用量也要进入运行诊断，
          // 否则 diagnostics.efficiency.tokenUsage 会比 loop 实际消耗偏低。
          ctx.diagnostics?.recordTokenUsage(u);
        }
      );
      // L4 真正替换了历史时计入压缩统计（maxCompactionLevel / totalCompactedItems），
      // 否则诊断里看不出 L4 是否发生过；失败或取消时 removed=0，不记。
      if (l4Result.removed > 0) {
        ctx.diagnostics?.recordCompaction({ level: l4Result.level, removed: l4Result.removed });
      }
      if (l4Result.cancelled || ctx.abortSignal?.aborted) {
        ctx.diagnostics?.recordCancelReason('abort_signal');
        ctx.diagnostics?.warn({
          code: 'l4_compaction_cancelled',
          message: 'L4 compaction result was discarded because the run was aborted',
        });
        return null;
      }
      if (l4Result.hardStop) {
        const reason = l4Result.reason || 'l4_compaction_failed_budget_exhausted';
        ctx.diagnostics?.markDegraded();
        ctx.diagnostics?.recordCancelReason(reason);
        ctx.diagnostics?.recordGateFailure('l4_compaction', 'degrade', reason);
        ctx.diagnostics?.warn({
          code: reason,
          message:
            'L4 compaction failed while session budget was already over the hard-stop threshold',
        });
        ctx.lastReply = `[run stopped: ${reason}] L4 compaction failed while the session budget was already over the safe limit; current dimension was stopped to avoid further token waste.`;
        return null;
      }
    }

    const llmTrace = describeLoopCall(ctx, this.#modelRef);
    const llmStartedAt = Date.now();
    if (ctx.abortSignal?.aborted) {
      this.logger.info(`[AgentRuntime] LLM call skipped ${formatLoopTrace(llmTrace)}`, {
        ...llmTrace,
        abortReason: stringifyAbortReason(ctx.abortSignal.reason),
      });
      ctx.diagnostics?.recordCancelReason('abort_signal');
      recordAbortRecoveryDiagnostic(ctx, 'AbortSignal was already aborted');
      return null;
    }

    // I08：异常边界按来源拆成两段。输入装配是纯本地确定性步骤，异常只可能是运行时缺陷，
    // 用同一输入重试必然再失败；它不能进入 provider 的 2-strike / 熔断 / 重试恢复链路。
    let dispatchInput: LlmDispatchInput | null;
    try {
      dispatchInput = this.#assembleLlmInput(
        ctx,
        toolChoice,
        toolSchemas,
        effectiveSystemPrompt,
        dynamicContext,
        llmTrace
      );
    } catch (assemblyErr: unknown) {
      return this.#handleLlmInputAssemblyFailure(ctx, assemblyErr, llmTrace, llmStartedAt);
    }
    if (!dispatchInput) {
      // 输入超限已在装配阶段写入诊断与回复，这里只结束本轮。
      return null;
    }
    const { effectiveToolChoice, messages: unifiedMessages, tools: unifiedTools } = dispatchInput;
    // provider tool-choice mode（observe-only）：装配阶段随 effectiveToolChoice 计算一次，
    // 携带到工具抑制判定，替代「写入 PCV burn 再读回」的 R4 往返。
    const providerToolChoiceMode = dispatchInput.providerToolChoiceMode;

    // 方案①：统一经 aiProvider.chatWithTools 调用；provider 内部已委托 LLMGateway + Transport，
    // 不再保留 runtime 级 gateway/provider 双分支（横切能力由 provider 背后的 gateway 统一承担）。
    // Hook、进度和日志都是可执行的宿主回调；最后一个观察点之后再次确认取消，
    // 不能依赖默认gateway替任意注入provider阻止已经取消的调用。
    if (ctx.abortSignal?.aborted) {
      ctx.diagnostics?.recordCancelReason('abort_signal');
      recordAbortRecoveryDiagnostic(ctx, 'AbortSignal was aborted before provider dispatch');
      this.logger.info(`[AgentRuntime] LLM dispatch cancelled ${formatLoopTrace(llmTrace)}`, {
        ...llmTrace,
        abortReason: stringifyAbortReason(ctx.abortSignal.reason),
      });
      return null;
    }

    // provider 错误边界只包住真正的 provider 调用（含成功后清零连续错误计数）：
    // 只有这里的异常才计入 consecutiveAiErrors、记 ai_error 并走重试 / 熔断恢复。
    let llmResult: LLMResult;
    try {
      llmResult = (await this.aiProvider.chatWithTools(ctx.prompt, {
        messages: unifiedMessages,
        toolSchemas: unifiedTools,
        toolChoice: unifiedTools ? effectiveToolChoice : undefined,
        systemPrompt: effectiveSystemPrompt,
        temperature: ctx.budget.temperature ?? (ctx.isSystem ? 0.3 : 0.7),
        maxTokens: ctx.budget.maxTokens ?? (ctx.isSystem ? 8192 : 4096),
        abortSignal: ctx.abortSignal ?? undefined,
      })) as LLMResult;
      ctx.consecutiveAiErrors = 0;
    } catch (aiErr: unknown) {
      const normalized = normalizeAiError(aiErr);
      this.logger.warn(`[AgentRuntime] LLM call failed ${formatLoopTrace(llmTrace)}`, {
        ...llmTrace,
        durationMs: Date.now() - llmStartedAt,
        error: normalized.message,
        errorCode: normalized.code ?? null,
        nonErrorRejection: !(aiErr instanceof Error),
        abortSignal: ctx.abortSignal?.aborted === true,
        abortReason: stringifyAbortReason(ctx.abortSignal?.reason),
      });
      return this.#handleAiError(ctx, aiErr);
    }

    // 累计 Token (BudgetController 管理 runtime 级, LoopContext 管理 loop 级)
    if (llmResult.usage) {
      budgetCtrl.recordLLMUsage(llmResult.usage);
      ctx.addTokenUsage(llmResult.usage);
      ctx.diagnostics?.recordTokenUsage(llmResult.usage);
    }
    if (ctx.abortSignal?.aborted) {
      ctx.diagnostics?.recordCancelReason('abort_signal');
      ctx.diagnostics?.warn({
        code: 'late_llm_response_discarded',
        message: 'Provider response arrived after cancellation and was discarded',
      });
      return null;
    }
    recordPcvLlmOutput(ctx.pcvNodeEvidence, {
      functionCalls: llmResult.functionCalls || [],
      reasoningTokens: llmResult.usage?.reasoningTokens || 0,
      text: llmResult.text || '',
    });

    // ── TurnTelemetry ──
    if (llmResult.usage && ctx.isSystem) {
      budgetCtrl.emitTurnTelemetry({
        iteration: ctx.iteration,
        currentUsage: llmResult.usage,
        compaction: compactResult ?? { level: 0, removed: 0 },
      });
    }

    const outputProjection = projectLlmOutput(llmResult);
    const llmOutputCompleteness = outputProjection.completeness;
    const llmOutputProcessEvent = buildAgentProcessEvent(ctx, {
      ...outputProjection.event,
      metadata: {
        ...llmTrace,
        durationMs: Date.now() - llmStartedAt,
        ...llmOutputCompleteness,
      },
    });
    this.#hookSystem.emitSync(
      'llm:call:after',
      {
        iteration: ctx.iteration,
        hasToolCalls: !!llmResult.functionCalls?.length,
        hasText: !!llmResult.text,
        inputTokens: llmResult.usage?.inputTokens,
        outputTokens: llmResult.usage?.outputTokens,
        processEvent: llmOutputProcessEvent,
      },
      { diagnostics: ctx.diagnostics }
    );
    this.#emitProcessProgress(llmOutputProcessEvent);
    this.logger.info(`[AgentRuntime] LLM call complete ${formatLoopTrace(llmTrace)}`, {
      ...llmTrace,
      durationMs: Date.now() - llmStartedAt,
      ...llmOutputCompleteness,
    });

    // 空响应重试
    if (!llmResult.text && !llmResult.functionCalls?.length) {
      ctx.diagnostics?.recordEmptyResponse();
      const decision = ctx.exitController?.checkAfterLLM(llmResult, ctx);
      if (decision?.action === 'retry') {
        ctx.consecutiveEmptyResponses++;
        ctx.diagnostics?.recordEmptyRetry();
        // SUMMARIZE 的 grace 由阶段轮数推进；普通空响应才回退 tracker 轮数。
        if (decision.reason !== 'empty_response_terminal') {
          ctx.tracker?.rollbackTick?.();
        }
        this.logger.warn(`[AgentRuntime] empty response — ${decision.detail}`);
        return (await this.#waitForRetry(ctx, 1500)) ? (continueResult() as LLMResult) : null;
      }
      this.logger.warn(`[AgentRuntime] empty response — ${decision?.detail || 'retry exhausted'}`);
      return null;
    }

    if (llmResult.text || llmResult.functionCalls?.length) {
      ctx.consecutiveEmptyResponses = 0;
    }

    // Graceful exit 保护 — toolChoice=none 或 gracefulExit 状态下，
    // 部分 LLM (DeepSeek 等) 可能仍然返回 tool calls，需要忽略。
    // Analyst 的 RECORD 阶段会暴露 note_finding-only 补记录窗口，不能在这里丢弃。
    // 这里是 toolChoice 违规的唯一生效判定（I34）：ExitController.checkToolChoiceViolation 是未接线的
    // 平行方法，条件不同（只看 tracker 的 graceful/SUMMARIZE，不看 toolChoice 与 provider 例外），
    // 不能替换成它；改这里的条件时同步更新它的 @deprecated 差异说明。
    const isTerminalPhase = ctx.tracker?.phase === 'SUMMARIZE';
    const allowToolCallsUnderForcedNone = allowsToolCallsUnderForcedNone(providerToolChoiceMode);
    if (
      (ctx.tracker?.isGracefulExit || (toolChoice === 'none' && !allowToolCallsUnderForcedNone)) &&
      llmResult.functionCalls?.length &&
      llmResult.functionCalls.length > 0
    ) {
      const violationReason = ctx.tracker?.isGracefulExit ? 'graceful exit' : 'toolChoice=none';
      this.logger.warn(
        `[AgentRuntime] ⚠ AI returned ${llmResult.functionCalls.length} tool calls during ${violationReason}${isTerminalPhase ? ' (terminal phase)' : ''} — ignoring`
      );
      ctx.diagnostics?.warn({
        code: 'tool_choice_violation',
        message: `AI returned ${llmResult.functionCalls.length} tool calls during ${violationReason}`,
      });
      if (llmResult.text) {
        ctx.lastReply = cleanFinalAnswer(llmResult.text);
        return null; // 退出
      }
      return continueResult() as LLMResult;
    }

    return llmResult;
  }

  /**
   * LLM 输入装配（I08 本地边界）— 工具可见性、provider 输入预算投影、消息装配、PCV 输入记录、
   * 测量与上限校验，以及发出前的 Hook / 进度 / 启动日志观察点。全程不触达 provider：
   * 这里抛出的任何异常都是本地运行时缺陷，由 #callLLM 交给 #handleLlmInputAssemblyFailure，
   * 不能计入 provider 错误。
   *
   * @returns 发送给 provider 的输入；输入超限时返回 null（诊断与回复已写入）
   */
  #assembleLlmInput(
    ctx: LoopContext,
    toolChoice: string,
    toolSchemas: Array<Record<string, unknown>>,
    effectiveSystemPrompt: string,
    dynamicContext: string | null,
    llmTrace: Record<string, unknown>
  ): LlmDispatchInput | null {
    const inputTools = selectLlmInputTools(
      { tracker: ctx.tracker, context: ctx.context },
      this.#modelRef,
      toolChoice,
      toolSchemas
    );
    const { tools: unifiedTools, effectiveToolChoice, providerDecisionMode } = inputTools;
    const providerToolChoiceMode = inputTools.observedToolChoiceMode;

    const inputStageProfile = resolveLlmInputStageProfile(ctx, toolChoice, effectiveToolChoice);
    const providerInputBudget = resolveProviderInputBudget(inputStageProfile);
    const inputProjection = providerInputBudget
      ? ctx.messages.compactForProviderInputBudget({
          ...providerInputBudget,
          stageProfile: inputStageProfile,
        })
      : null;

    // 构建 LLM 输入消息 — projected messages + ephemeral runtime input layer
    const projected =
      ctx.messages.toProjectedMessages() as import('#ai/AiProvider.js').UnifiedMessage[];
    const llmInputAssembly = buildLlmInputAssembly({
      ctx,
      dynamicContext,
      effectiveToolChoice,
      inputProjection: inputProjection ? { ...inputProjection } : null,
      messages: projected,
      modelRef: this.#modelRef,
      requestedToolChoice: toolChoice,
      systemPrompt: effectiveSystemPrompt,
      tools: unifiedTools,
    });
    recordPcvInputAssembly(ctx.pcvNodeEvidence, llmInputAssembly, {
      deepseekV4ToolChoiceMode: providerToolChoiceMode, // provider-name-ok: recorded evidence field key
      effectiveToolChoice,
      iteration: ctx.iteration,
      modelRef: this.#modelRef,
      requestedToolChoice: toolChoice,
    });
    const llmInputMeasurement = measureLlmInputAssembly(llmInputAssembly);
    // 上限来源随 loop 在 #initLoop 解析；诊断消息与日志都带 limitSource，宿主能区分
    // “模型窗口偏小”（model-registry）、“显式覆盖”（explicit）与“未登记模型的 128k 默认”（default）。
    const providerInputLimit = this.#providerInputLimits.get(ctx);
    const llmInputValidation = validateLlmInputSize(
      ctx.budget,
      llmInputMeasurement,
      providerInputLimit?.source
    );
    if (!llmInputValidation.ok) {
      ctx.diagnostics?.warn({
        code: llmInputValidation.code,
        message: llmInputValidation.message,
      });
      this.logger.warn(
        `[AgentRuntime] LLM input rejected ${formatLoopTrace(llmTrace)}: ${llmInputValidation.message}`,
        {
          ...llmTrace,
          code: llmInputValidation.code,
          estimatedTokens: llmInputValidation.estimatedTokens,
          maxTokens: llmInputValidation.maxTokens,
          limitSource: llmInputValidation.limitSource,
          registryModelId: providerInputLimit?.registryModelId ?? null,
          contextWindow: providerInputLimit?.contextWindow ?? null,
          outputReserveTokens: providerInputLimit?.outputReserveTokens ?? null,
        }
      );
      if (!ctx.isSystem) {
        ctx.lastReply = `抱歉，当前请求输入过长（${llmInputValidation.estimatedTokens}/${llmInputValidation.maxTokens} tokens）。请缩短输入后重试。`;
      }
      return null;
    }
    const unifiedMessages = llmInputAssembly.providerMessages;
    const llmInputProcessEvent = buildAgentProcessEvent(
      ctx,
      projectLlmInputEvent(llmInputAssembly, llmInputMeasurement, {
        trace: llmTrace,
        modelRef: this.#modelRef,
        dynamicContext,
        requestedToolChoice: toolChoice,
        effectiveToolChoice,
      })
    );
    this.#hookSystem.emitSync(
      'llm:call:before',
      {
        iteration: ctx.iteration,
        toolChoice: effectiveToolChoice,
        processEvent: llmInputProcessEvent,
      },
      { diagnostics: ctx.diagnostics }
    );
    this.#emitProcessProgress(llmInputProcessEvent);

    // 冷启动链路里第一轮经常最慢；必须先打印“请求已发出”的结构化日志，
    // 否则 Dashboard 只能看到 filling，不知道是在等模型、走重试还是已经被 abort。
    this.logger.info(`[AgentRuntime] LLM call start ${formatLoopTrace(llmTrace)}`, {
      ...llmTrace,
      messageCount: unifiedMessages.length,
      hasDynamicContext: Boolean(dynamicContext),
      deepseekV4ToolChoiceMode: providerDecisionMode, // provider-name-ok: recorded evidence field key
      requestedToolChoice: toolChoice,
      effectiveToolChoice,
      toolSchemaCount: unifiedTools?.length || 0,
      timeoutMs: ctx.budget.timeoutMs || null,
      maxTokens: ctx.budget.maxTokens ?? (ctx.isSystem ? 8192 : 4096),
    });

    return {
      effectiveToolChoice,
      messages: unifiedMessages,
      providerToolChoiceMode,
      tools: unifiedTools,
    };
  }

  /**
   * 本地输入装配失败（I08）— 按运行缺陷终止本次循环：
   *   - 不计入 consecutiveAiErrors、不记 ai_error、不重试（同一输入必然再失败）、不触发熔断语义；
   *   - 诊断记 llm_input_assembly_failed + cancelReason=runtime_defect 并标记 degraded，
   *     #finalize 据 runtime_defect 抑制强制摘要，provider 一次都不会被调用；
   *   - 日志带错误名与堆栈，宿主能直接定位本地缺陷，而不是误判为上游 AI 服务故障。
   * 诊断先于日志写入：即使宿主 logger 本身抛错，终态归类也已落盘。
   */
  #handleLlmInputAssemblyFailure(
    ctx: LoopContext,
    assemblyErr: unknown,
    llmTrace: Record<string, unknown>,
    llmStartedAt: number
  ): null {
    const normalized = normalizeAiError(assemblyErr);
    const errorName = assemblyErr instanceof Error ? assemblyErr.name : typeof assemblyErr;
    const summary = `${errorName}: ${normalized.message}`;
    ctx.diagnostics?.warn({
      code: LLM_INPUT_ASSEMBLY_FAILED_CODE,
      message: `LLM input assembly failed before provider dispatch (${summary}); run terminated as ${RUNTIME_DEFECT_CANCEL_REASON} without provider retry`,
    });
    ctx.diagnostics?.recordCancelReason(RUNTIME_DEFECT_CANCEL_REASON);
    ctx.diagnostics?.markDegraded();
    this.logger.warn(
      `[AgentRuntime] LLM input assembly failed — runtime defect, provider not called, no retry ${formatLoopTrace(llmTrace)}: ${summary}`,
      {
        ...llmTrace,
        code: LLM_INPUT_ASSEMBLY_FAILED_CODE,
        cancelReason: RUNTIME_DEFECT_CANCEL_REASON,
        durationMs: Date.now() - llmStartedAt,
        errorName,
        error: normalized.message,
        stack: assemblyErr instanceof Error ? (assemblyErr.stack ?? null) : null,
        consecutiveAiErrors: ctx.consecutiveAiErrors,
      }
    );
    if (!ctx.isSystem) {
      ctx.lastReply = `抱歉，运行时在组装模型请求时发生内部错误（${summary}），本次请求已终止且未发送给 AI 服务。请反馈该问题。`;
    }
    return null;
  }

  /**
   * AI 错误处理 — 熔断器感知 + 2-strike 策略
   *
   * 只接收 provider 调用（chatWithTools）抛出的异常；本地输入装配缺陷由
   * #handleLlmInputAssemblyFailure 单独归类。provider 可能 reject 任意值（字符串、普通对象），
   * 入口先归一为 { message, code }，避免把 'undefined' 写进 ai_error 诊断或让熔断码判断失效。
   *
   * 本方法是 AI 错误退出的唯一生效判定（I34）：ExitController.checkAfterAiError 是未接线的平行方法，
   * 不递增 consecutiveAiErrors，也没有这里的 cancelReason / resetToPromptOnly / lastReply 副作用；
   * 改这里的语义时同步更新它的 @deprecated 差异说明。
   * @returns continueResult() 或 null (退出)
   */
  async #handleAiError(ctx: LoopContext, rawError: unknown): Promise<LLMResult | null> {
    const aiErr = normalizeAiError(rawError);
    const trace = describeLoopCall(ctx, this.#modelRef);
    // AbortError — 外部中止信号已触发，不计入错误计数，立即退出
    if (ctx.abortSignal?.aborted) {
      this.logger.info(
        `[AgentRuntime] ⛔ abortSignal fired during LLM call — exiting ${formatLoopTrace(trace)}`,
        {
          ...trace,
          abortReason: stringifyAbortReason(ctx.abortSignal.reason),
        }
      );
      ctx.diagnostics?.recordCancelReason('abort_signal');
      recordAbortRecoveryDiagnostic(ctx, 'AbortSignal fired during LLM call');
      return null;
    }

    ctx.consecutiveAiErrors++;
    ctx.diagnostics?.recordAiError(aiErr.message);
    this.logger.warn(
      `[AgentRuntime] AI call failed (attempt ${ctx.consecutiveAiErrors}) ${formatLoopTrace(trace)}: ${aiErr.message}`
    );

    ctx.tracker?.rollbackTick?.();

    // 熔断器感知
    if (aiErr.code === 'CIRCUIT_OPEN') {
      ctx.diagnostics?.recordCancelReason('provider_circuit_open');
      this.logger.warn(
        `[AgentRuntime] 🛑 circuit breaker OPEN — breaking to summary ${formatLoopTrace(trace)}`
      );
      if (!ctx.isSystem) {
        ctx.lastReply = `抱歉，AI 服务暂时不可用（${aiErr.message}）。请稍后重试，或检查 API 配置。`;
      }
      return null;
    }

    // 2-strike 策略
    if (ctx.consecutiveAiErrors >= 2) {
      ctx.diagnostics?.recordCancelReason('provider_error');
      this.logger.warn(
        `[AgentRuntime] 🛑 2 consecutive AI errors — breaking to summary ${formatLoopTrace(trace)}`
      );
      ctx.messages.resetToPromptOnly();
      if (!ctx.isSystem) {
        ctx.lastReply = `抱歉，AI 服务暂时不可用（${aiErr.message}）。请稍后重试，或检查 API 配置。`;
      }
      return null;
    }

    return (await this.#waitForRetry(ctx, 2000)) ? (continueResult() as LLMResult) : null;
  }

  /** 等待属于本次循环，取消后不再占用重试期限，也不启动下一次模型请求。 */
  async #waitForRetry(ctx: LoopContext, milliseconds: number): Promise<boolean> {
    try {
      await delay(milliseconds, undefined, { signal: ctx.abortSignal ?? undefined });
      return true;
    } catch (err: unknown) {
      if (!ctx.abortSignal?.aborted) {
        throw err instanceof Error ? err : new Error('Retry delay failed', { cause: err });
      }
      ctx.diagnostics?.recordCancelReason('abort_signal');
      this.logger.info('[AgentRuntime] retry delay cancelled; no further model call');
      return false;
    }
  }

  /**
   * 工具调用处理 — 执行 + 记录 + 去重 + 阶段转换
   *
   * @returns true = 应退出循环
   */
  async #processToolCalls(ctx: LoopContext, llmResult: LLMResult, closeRound: () => void) {
    const { tracker, trace, messages } = ctx;

    // 工具调用数量限制
    let activeCalls = llmResult.functionCalls || [];
    let truncatedCalls: typeof activeCalls = [];
    if (activeCalls.length > MAX_TOOL_CALLS_PER_ITER) {
      this.logger.warn(
        `[AgentRuntime] ⚠ ${activeCalls.length} tool calls, capping to ${MAX_TOOL_CALLS_PER_ITER}`
      );
      tracker?.recordTruncatedCalls?.(activeCalls.length - MAX_TOOL_CALLS_PER_ITER);
      ctx.diagnostics?.recordTruncatedToolCalls(activeCalls.length - MAX_TOOL_CALLS_PER_ITER);
      truncatedCalls = activeCalls.slice(MAX_TOOL_CALLS_PER_ITER);
      activeCalls = activeCalls.slice(0, MAX_TOOL_CALLS_PER_ITER);
    }

    if (activeCalls.length > 0) {
      this.logger.info(
        `[AgentRuntime] tool calls received ${formatLoopTrace(describeLoopCall(ctx, this.#modelRef))}`,
        {
          ...describeLoopCall(ctx, this.#modelRef),
          count: activeCalls.length,
          names: activeCalls.map((call) => call.name).slice(0, 16),
          sources: summarizeFunctionCallSources(activeCalls),
        }
      );
    }

    for (const fc of activeCalls) {
      if (isNoteFindingFunctionCall(fc)) {
        this.logger.info(
          `[AgentRuntime] note_finding call received — source=${inferFunctionCallSource(fc)}, ` +
            `tool=${fc.name}, callId=${fc.id}, phase=${tracker?.phase || 'unknown'}`
        );
      }
    }

    // 追加 assistant 消息（含 DeepSeek V4 reasoningContent 透传）
    let historyCalls = activeCalls.map((call) => ({ ...call, args: { ...call.args } }));
    let historyContinuation = llmResult.continuation;
    if (truncatedCalls.length > 0 && llmResult.continuation) {
      // 跨层契约：续接按 Transport 捕获时的完整调用集合绑定投影；截断后历史里少了调用，回放必判
      // tool_projection_changed，且该消息常驻历史，会在之后每次请求重复告警并丢掉同轮推理。
      // 截断方负责续接：两种消息适配器都不再收到续接，保留 reasoningContent（DeepSeek 推理未签名，
      // 可独立回传），并剥离 Gemini thoughtSignature（签名绑定截断前的整轮投影，被拒时本来也不发送）。
      const dropped = llmResult.continuation;
      historyContinuation = undefined;
      historyCalls = historyCalls.map(({ thoughtSignature: _signature, ...call }) => call);
      // 一次性诊断：只在追加历史时记录一次；不含推理正文、参数或签名，callIds 为未执行的调用（封顶 8 个）。
      const droppedIds = truncatedCalls.slice(0, 8).map((call) => call.id);
      if (truncatedCalls.length > 8) {
        droppedIds.push(`+${truncatedCalls.length - 8}`);
      }
      this.logger.info(
        `[AgentRuntime] continuation_dropped reason=truncated_calls provider=${dropped.provider} model=${dropped.model} kind=${dropped.kind} kept=${activeCalls.length} truncated=${truncatedCalls.length} callIds=${droppedIds.join(',')}; tool calls truncated before history, native continuation discarded, reasoningContent retained, thought signatures omitted`
      );
    }
    messages.appendAssistantWithToolCalls(
      llmResult.text || null,
      historyCalls,
      llmResult.reasoningContent,
      historyContinuation
    );

    let roundSubmitCount = 0;
    let roundHasNewInfo = false;
    const roundToolNames: string[] = [];
    const pcvBefore = {
      acceptedFindingCount: ctx.pcvNodeEvidence.findingRefs.accepted.length,
      rejectedFindingCount: ctx.pcvNodeEvidence.findingRefs.rejected.length,
    };

    // 并行工具调用共享 token 预算 — 委托 BudgetController
    const budgetCtrl = requireBudgetController(ctx);
    const toolBudget = budgetCtrl.getToolBudget(activeCalls.length);

    // 执行每个工具
    for (const fc of activeCalls) {
      if (ctx.abortSignal?.aborted) {
        ctx.diagnostics?.recordCancelReason('abort_signal');
        recordAbortRecoveryDiagnostic(ctx, 'AbortSignal fired before tool execution');
        this.logger.info('[AgentRuntime] ⛔ abortSignal fired before tool execution — exiting');
        return true;
      }

      const toolStartProcessEvent = buildAgentProcessEvent(
        ctx,
        projectToolStartEvent(fc, inferFunctionCallSource(fc))
      );
      this.#emitProgress('tool_call', {
        tool: fc.name,
        args: fc.args,
        processEvent: toolStartProcessEvent,
      });

      this.bus.publish(
        AgentEvents.TOOL_CALL_START,
        {
          agentId: this.id,
          tool: fc.name,
          processEvent: toolStartProcessEvent,
        },
        { source: this.id }
      );

      // HookSystem: tool:execute:before
      // 顺序说明（L5-P41 / I30）：tool_call 进度与 TOOL_CALL_START 已在上面发出，钩子失败写进
      // processEvent.metadata.hookErrors 时宿主记录器已看过该事件；因此失败另经运行期诊断
      // （hook_handler_failed）可靠上报。调整“先钩子后事件”会改变宿主可见事件顺序，需另行确认。
      const hookAllowed = await this.#hookSystem.emit(
        'tool:execute:before',
        {
          toolId: fc.name,
          args: fc.args,
          callId: fc.id,
          processEvent: toolStartProcessEvent,
        },
        { diagnostics: ctx.diagnostics }
      );
      if (ctx.abortSignal?.aborted) {
        ctx.diagnostics?.recordCancelReason('abort_signal');
        return true;
      }

      // 通过 Pipeline 执行 (safety → cache → execute → observe → track → trace → dedup)
      if (!hookAllowed) {
        ctx.diagnostics?.recordBlockedTool(fc.name, 'tool:execute:before hook rejected the call');
        this.logger.warn(`[AgentRuntime] tool blocked by hook: ${fc.name}`);
      }
      const pipelineContext = { runtime: this, loopCtx: ctx, iteration: ctx.iteration };
      let execution: { result: unknown; metadata: ToolMetadata };
      if (hookAllowed) {
        try {
          execution = await this.#toolPipeline.execute(fc, pipelineContext);
        } catch (err: unknown) {
          const failed = takeToolPipelineFailure(err, pipelineContext, fc);
          if (failed) {
            // 只有本次管道确认的回执可进入partial历史；不重跑after、不通知成功或伪造轮次完成。
            const entry = createToolReceipt(fc, failed.result, failed.metadata);
            ctx.toolCalls.push(entry);
            this.toolCallHistory.push(entry);
            observeSafely(
              () =>
                ctx.diagnostics?.warn({
                  code: 'TOOL_POSTPROCESSING_FAILED',
                  tool: fc.name,
                  message:
                    'Tool returned a receipt, but postprocessing failed; receipt retained and run stopped.',
                }),
              () =>
                this.logger.warn(
                  '[AgentRuntime] postprocessing diagnostic failed; confirmed receipt retained'
                )
            );
          }
          throw err instanceof Error ? err : new Error(String(err), { cause: err });
        }
      } else {
        execution = {
          result: { error: 'Tool call blocked by hook' },
          metadata: { cacheHit: false, blocked: true, isNew: false, durationMs: 0 },
        };
      }
      const { result: toolResult, metadata } = execution;

      const durationMs = metadata.durationMs;
      const envelope = metadata.envelope;
      const toolEntry = createToolReceipt(fc, toolResult, metadata);
      (ctx.toolCalls as ToolCallEntry[]).push(toolEntry);
      this.toolCallHistory.push(toolEntry);

      if (metadata.isNew) {
        roundHasNewInfo = true;
      }
      roundToolNames.push(fc.name);

      // onToolCall 通知
      const effectiveHook = ctx.onToolCall || this.onToolCall;
      if (effectiveHook) {
        observeSafely(
          () => effectiveHook(fc.name, fc.args, toolResult, ctx.iteration),
          () =>
            this.logger.warn('[AgentRuntime] tool observer failed; tool result retained', {
              tool: fc.name,
              agentId: this.id,
              iteration: ctx.iteration,
            })
        );
      }

      const toolResultObj = toolResult as Record<string, unknown> | null;
      const toolSucceeded = readToolObservation(toolEntry).ok;
      recordPcvToolResult(ctx.pcvNodeEvidence, fc, toolResult, envelope, {
        toolSucceeded,
        evidenceLedger: ctx.evidenceLedger,
      });
      // 每条回执立即入账；后续工具取消/失败不能使本轮已确认的证据消失。
      recordPcvToolRoundOutcome(ctx.pcvNodeEvidence, {
        acceptedFindingDelta:
          ctx.pcvNodeEvidence.findingRefs.accepted.length - pcvBefore.acceptedFindingCount,
        rejectedFindingDelta:
          ctx.pcvNodeEvidence.findingRefs.rejected.length - pcvBefore.rejectedFindingCount,
        evidenceToolCallDelta:
          toolSucceeded && isEvidenceGroundingToolCall(fc.name, fc.args) ? 1 : 0,
        toolCallDelta: 1,
      });
      pcvBefore.acceptedFindingCount = ctx.pcvNodeEvidence.findingRefs.accepted.length;
      pcvBefore.rejectedFindingCount = ctx.pcvNodeEvidence.findingRefs.rejected.length;

      if (isNoteFindingFunctionCall(fc)) {
        const recorded = toolResultObj?.recorded === true;
        const target = String(toolResultObj?.target || 'unknown');
        this.logger.info(
          `[AgentRuntime] note_finding call completed — source=${inferFunctionCallSource(fc)}, ` +
            `tool=${fc.name}, callId=${fc.id}, phase=${tracker?.phase || 'unknown'}, ` +
            `ok=${toolSucceeded}, recorded=${recorded}, target=${target}`
        );
      }

      // 工具结果格式化 — 使用 BudgetController 分摊配额
      const remaining = budgetCtrl.getRemainingToolBudget();
      const toolQuota = {
        maxChars: Math.min(toolBudget.perToolMaxChars, remaining.maxChars),
        maxMatches: toolBudget.perToolMaxMatches,
      };
      const projection = projectToolReceipt(toolEntry, toolQuota);
      let resultStr = projection.text;
      if (projection.envelopeShapeRejected) {
        // 信封未通过严格守卫（如 durationMs 非法）：模型只拿到 envelope.text（或旧原值投影），
        // 这里留下可定位诊断；只记工具名，不记信封正文。
        ctx.diagnostics?.warn({
          code: TOOL_ENVELOPE_SHAPE_REJECTED,
          tool: fc.name,
          message:
            'Tool result envelope failed the strict shape guard; its own text field (when present) was projected instead of the whole envelope.',
        });
      }
      if (projection.invalidatesReadView) {
        messages.invalidateReadView();
        ctx.diagnostics?.warn({
          code: 'tool_read_view_invalidated',
          tool: 'code',
          message:
            'Read output was limited before entering model history; the next read must establish a new full-content baseline.',
        });
      }
      budgetCtrl.recordToolCharsUsed(resultStr.length);

      // 提交去重: pipeline 中间件已标记 metadata
      const dedupMessage = metadata.dedupMessage;
      if (dedupMessage) {
        resultStr = dedupMessage;
      } else if (metadata.isSubmit) {
        roundSubmitCount++;
      }

      const toolEndProcessEvent = buildAgentProcessEvent(
        ctx,
        projectToolEndEvent(
          fc,
          { durationMs, cacheHit: metadata.cacheHit, cacheMiss: metadata.cacheMiss },
          resultStr,
          toolSucceeded,
          inferFunctionCallSource(fc)
        )
      );

      // 进度回调 (tool_end 需要 resultStr.length)
      this.#emitProgress('tool_end', {
        tool: fc.name,
        duration: durationMs,
        status: toolSucceeded ? 'ok' : 'error',
        error:
          envelope && !envelope.ok
            ? envelope.text
            : (toolResultObj?.error as string | undefined) || undefined,
        resultSize: resultStr.length,
        processEvent: toolEndProcessEvent,
      });

      this.bus.publish(
        AgentEvents.TOOL_CALL_END,
        {
          agentId: this.id,
          tool: fc.name,
          durationMs,
          success: toolSucceeded,
          processEvent: toolEndProcessEvent,
        },
        { source: this.id }
      );

      // HookSystem: tool:execute:after
      this.#hookSystem.emitSync(
        'tool:execute:after',
        {
          toolId: fc.name,
          ok: toolSucceeded,
          durationMs,
          callId: fc.id,
          processEvent: toolEndProcessEvent,
        },
        { diagnostics: ctx.diagnostics }
      );

      // 追加 tool result
      messages.appendToolResult(fc.id, fc.name, resultStr, {
        persistedSubmission: isPersistedSubmission(toolEntry),
      });
    }

    if (truncatedCalls.length > 0) {
      const truncatedNames = truncatedCalls
        .map((call) => call.name)
        .slice(0, 5)
        .join(', ');
      messages.appendUserNudge(
        `工具调用数量超限：本轮只执行前 ${MAX_TOOL_CALLS_PER_ITER} 个工具调用，另有 ${truncatedCalls.length} 个未执行${truncatedNames ? `（${truncatedNames}${truncatedCalls.length > 5 ? '...' : ''}）` : ''}。请基于已返回结果继续，必要时分批重新请求未执行的工具。`
      );
    }

    // 不再把本轮用过的工具写回 container 的 capabilityCatalog（markExpanded）。
    // 该目录是进程级单例、展开状态从不重置，而 schema 每个循环（每次运行、每个 pipeline 阶段）
    // 只在 #initLoop 查询一次：
    // 运行内写入不会生效，跨运行却会让下一次运行中未用过的工具丢失参数 schema。
    // 原因与替代行为见 #queryToolSchemas 的 firstRound 注释。

    // ExplorationTracker: endRound → 检查阶段转换
    if (tracker) {
      tracker.updatePlanProgress?.(trace);
      const transitionNudge = tracker.endRound({
        hasNewInfo: roundHasNewInfo,
        submitCount: roundSubmitCount,
        toolNames: roundToolNames,
      });
      if (transitionNudge) {
        messages.appendUserNudge(transitionNudge.text);
        ctx.diagnostics?.recordNudge({ type: transitionNudge.type });
        this.logger.info(
          `[AgentRuntime] 📝 injected ${transitionNudge.type} nudge (${tracker.phase})`
        );
        this.#emitProcessProgress(
          buildSemanticNudgeProcessEvent(ctx, transitionNudge, {
            phase: tracker.phase,
            semanticKind: 'transition-nudge',
          })
        );
        const _dimT = ctx.sharedState?._dimensionMeta?.id || '';
        if (process.env.ALEMBIC_MCP_MODE !== '1') {
          process.stderr.write(
            `\n\x1b[35m━━━ Transition Nudge [${transitionNudge.type}] phase=${tracker.phase}${_dimT ? ` dim=${_dimT}` : ''} ━━━\x1b[0m\n`
          );
          process.stderr.write(`\x1b[33m${redactDeveloperText(transitionNudge.text)}\x1b[0m\n\n`);
        }
      }
    }

    // ActiveContext: 关闭轮次
    if (trace) {
      trace.setRoundSummary?.({
        newInfoCount: roundHasNewInfo ? 1 : 0,
        totalCalls: activeCalls.length,
        submits: roundSubmitCount,
        cumulativeFiles: tracker?.getMetrics?.()?.uniqueFiles || 0,
        cumulativePatterns: tracker?.getMetrics?.()?.uniquePatterns || 0,
      });
      closeRound();
    }

    // 本轮工具步骤摘要只交给状态机（Capability.onAfterStep 不再由运行循环驱动，见 #shouldExit 说明）。
    const stepToolEntries = ctx.toolCalls.slice(-activeCalls.length);
    const stepResult = {
      type: 'tool_calls',
      toolCalls: stepToolEntries,
      iteration: ctx.iteration,
    };

    this.#safeTransition('step_done', stepResult);

    // 所有强制摘要统一在 finalize 生成；此处只结束工具轮。
    // 摘要失败/空响应不能让已确认回执丢失，也不能触发第二次摘要请求。
    if (ctx.exitController?.checkAfterToolCalls(ctx).action === 'exit') {
      return true;
    }

    this.#safeTransition('continue');
    return false; // 继续循环
  }

  /**
   * 文本响应处理 — tracker 阶段路由 + 非 tracker 直接终止
   *
   * 本方法是文本轮退出的唯一生效判定（I34）：ExitController.checkAfterTextResponse 是未接线的平行方法，
   * 不区分管线（这里只对 analyst 注入 digest nudge）、不建模 grounding guard；
   * 改这里的语义时同步更新它的 @deprecated 差异说明。
   *
   * @returns true = 应退出循环
   */
  #processTextResponse(ctx: LoopContext, llmResult: LLMResult, closeRound: () => void) {
    const { tracker, messages } = ctx;

    if (tracker) {
      // AP-3：CP4 analyze 文本轮阻断仅在 grounding enforcement = 'guard' 时生效（调用点短路）。
      // 默认 'off' 下不调用 guard、不读决策、不阻断/不 nudge/不 rollback（PCV observe-only）；guard 内部逻辑不变。
      const groundingGate =
        ctx.groundingEnforcement === 'guard'
          ? evaluateAnalyzeTextGroundingGate(ctx, this.#modelRef)
          : null;
      if (groundingGate?.block) {
        // I38：只有真正阻断（nudge + rollbackTick）才累加连续阻断计数；gate 据此在达到上限后放行。
        ctx.consecutiveGroundingBlocks++;
        messages.appendAssistantText(
          llmResult.text || '',
          llmResult.reasoningContent,
          llmResult.continuation
        );
        messages.appendUserNudge(groundingGate.nudge);
        tracker.rollbackTick?.();
        ctx.diagnostics?.warn({
          code: 'invalid_no_evidence_burn',
          message: groundingGate.reason,
          stage: ctx.context?.pipelinePhase as string | undefined,
        });
        this.logger.warn(
          `[AgentRuntime] invalid-no-evidence analyze burn blocked (${ctx.consecutiveGroundingBlocks}/${groundingGate.blockLimit}): ${groundingGate.reason}`
        );
        this.#emitProcessProgress(
          buildSemanticNudgeProcessEvent(
            ctx,
            { type: 'evidence_grounding', text: groundingGate.nudge },
            {
              phase: tracker.phase,
              semanticKind: 'evidence-grounding-nudge',
            }
          )
        );
        closeRound();
        return false;
      }
      if (groundingGate?.limitReached) {
        // I38 降级放行：本轮仍是 invalid-no-evidence，但同一连续段内已阻断到上限。继续阻断只会反复
        // rollbackTick、让 tracker 轮次停在原地（循环只能靠超时 / token 预算 / abort 结束），因此不再
        // nudge / rollback，记诊断后按普通文本轮走下面的 endRound/onTextResponse。
        // 计数不清零：同一连续段内后续的无证据文本轮继续放行，直到出现非阻断轮才重新开放阻断额度。
        const limitDetail =
          `consecutiveBlocks=${groundingGate.consecutiveBlocks} limit=${groundingGate.blockLimit} ` +
          `phase=${tracker.phase} iteration=${ctx.iteration} modelRef=${this.#modelRef}`;
        ctx.diagnostics?.warn({
          code: 'grounding_block_limit_reached',
          message: `Analyze grounding guard released an invalid-no-evidence text burn after reaching the consecutive block limit (${limitDetail}).`,
          stage: ctx.context?.pipelinePhase as string | undefined,
        });
        this.logger.warn(
          `[AgentRuntime] grounding block limit reached — releasing invalid-no-evidence analyze burn as a normal text round (${limitDetail})`
        );
      } else {
        // 非阻断轮（gate 未判 invalid-no-evidence、guard 不适格或 enforcement=off）：清零连续阻断计数。
        ctx.consecutiveGroundingBlocks = 0;
      }
      // 文本轮次也需要更新 tracker 指标 — 否则 roundsSinceNewInfo / consecutiveIdleRounds
      // 不递增，metrics 驱动的阶段转换永远不触发（根因: 工具路径 endRound 被调用但文本路径被跳过）
      const phaseBefore = tracker.phase;
      tracker.endRound({
        hasNewInfo: false,
        submitCount: 0,
        toolNames: [],
      });
      const metricsTransitionedToTerminal =
        phaseBefore !== tracker.phase && tracker.phase === 'SUMMARIZE';

      const textResult = tracker.onTextResponse(llmResult.text || '');

      // 如果 endRound 的 metrics 转换刚推进到终结阶段，则强制走 needsDigestNudge 路径，
      // 给 Agent 一轮机会输出完整总结，而不是把当前文本当作最终回复
      if (metricsTransitionedToTerminal && textResult.isFinalAnswer) {
        const digestNudge =
          tracker.pipelineType === 'analyst'
            ? `请**停止调用工具**，直接输出你的完整分析报告。用 Markdown 格式；核心已确认章节只能来自已记录的 note_finding，未调用 note_finding 的信号只能放入「待探索」或「未结构化记录」。\n\n` +
              `**现在开始输出你的分析报告。**\n` +
              `⚠️ 严禁在回复中复制本条指令文字，只输出你自己的分析。`
            : null;
        if (digestNudge) {
          messages.appendAssistantText(
            llmResult.text || '',
            llmResult.reasoningContent,
            llmResult.continuation
          );
          messages.appendUserNudge(digestNudge);
          ctx.diagnostics?.recordNudge({ type: 'digest' });
          this.#emitProcessProgress(
            buildSemanticNudgeProcessEvent(ctx, { type: 'digest', text: digestNudge })
          );
          this.logger.info(
            '[AgentRuntime] 📝 metrics-transition to terminal — injecting digest nudge'
          );
          closeRound();
          return false; // continue — let agent produce a full summary
        }
      }

      if (textResult.isFinalAnswer) {
        ctx.lastReply = cleanFinalAnswer(llmResult.text || '');
        this.logger.info(
          `[AgentRuntime] ✅ final answer — ${ctx.lastReply.length} chars, ${tracker.iteration} iters, ${ctx.toolCalls.length} tool calls`
        );
        closeRound();
        return true;
      }

      if (textResult.needsDigestNudge) {
        messages.appendAssistantText(
          llmResult.text || '',
          llmResult.reasoningContent,
          llmResult.continuation
        );
        if (textResult.nudge) {
          messages.appendUserNudge(textResult.nudge);
          ctx.diagnostics?.recordNudge({ type: 'digest' });
          this.#emitProcessProgress(
            buildSemanticNudgeProcessEvent(ctx, {
              type: 'digest',
              text: textResult.nudge,
            })
          );
        }
        this.logger.info('[AgentRuntime] 📝 injected SUMMARIZE nudge (text-triggered transition)');
        const _dimD = ctx.sharedState?._dimensionMeta?.id || '';
        if (textResult.nudge && process.env.ALEMBIC_MCP_MODE !== '1') {
          process.stderr.write(
            `\n\x1b[34m━━━ Digest Nudge [SUMMARIZE]${_dimD ? ` dim=${_dimD}` : ''} ━━━\x1b[0m\n`
          );
          process.stderr.write(`\x1b[33m${redactDeveloperText(textResult.nudge)}\x1b[0m\n\n`);
        }
        closeRound();
        return false; // continue
      }

      if (textResult.shouldContinue) {
        messages.appendAssistantText(
          llmResult.text || '',
          llmResult.reasoningContent,
          llmResult.continuation
        );
        if (textResult.nudge) {
          messages.appendUserNudge(textResult.nudge);
          ctx.diagnostics?.recordNudge({ type: 'continue' });
          this.#emitProcessProgress(
            buildSemanticNudgeProcessEvent(ctx, {
              type: 'continue',
              text: textResult.nudge,
            })
          );
          const _dimC = ctx.sharedState?._dimensionMeta?.id || '';
          if (process.env.ALEMBIC_MCP_MODE !== '1') {
            process.stderr.write(
              `\n\x1b[32m━━━ Continue Nudge${_dimC ? ` dim=${_dimC}` : ''} ━━━\x1b[0m\n`
            );
            process.stderr.write(`\x1b[33m${redactDeveloperText(textResult.nudge)}\x1b[0m\n\n`);
          }
        }
        closeRound();
        return false; // continue
      }
    }

    // 非 tracker 模式: 文字回答即最终回答
    ctx.lastReply = cleanFinalAnswer(llmResult.text || '');
    closeRound();
    return true;
  }

  #getForcedSummarySuppression(ctx: LoopContext): { code: string; message: string } | null {
    const diagnostics = ctx.diagnostics?.toJSON();
    const cancelReason = diagnostics?.efficiency?.cancelReason;

    if (ctx.abortSignal?.aborted || cancelReason === 'abort_signal') {
      return {
        code: 'abort_signal',
        message: 'Run was aborted before a normal summary could be produced',
      };
    }

    // I08：本地输入装配缺陷终止的运行不再发强制摘要（摘要请求同样不会修复本地缺陷）；
    // 放在超时判定之前，避免超时分支把 runtime_defect 改写成 stage_timeout。
    if (cancelReason === RUNTIME_DEFECT_CANCEL_REASON) {
      return {
        code: RUNTIME_DEFECT_CANCEL_REASON,
        message:
          'LLM input assembly failed locally before provider dispatch; summary request suppressed',
      };
    }

    // 与 createExitController 的 P2 判定用同一个有效超时（阶段超时与策略超时的较小正值，I03）：
    // 其它原因退出时若已超过更短的策略超时，同样按 stage_timeout 抑制强制摘要，
    // 不再出现“ExitController 视为已超时、这里却只看阶段超时而多发一次摘要请求”的口径分裂。
    const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
      ctx.budget.timeoutMs,
      readPolicyTimeoutMs(this.policies)
    );
    if (
      cancelReason === 'stage_timeout' ||
      (diagnostics?.timedOutStages?.length ?? 0) > 0 ||
      (effectiveTimeoutMs > 0 && Date.now() - ctx.loopStartTime >= effectiveTimeoutMs)
    ) {
      ctx.diagnostics?.recordCancelReason('stage_timeout');
      return {
        code: 'stage_timeout',
        message: 'Run reached a stage timeout before a normal summary could be produced',
      };
    }

    if (diagnostics?.warnings.some((warning) => warning.code === LLM_INPUT_TOO_LARGE_CODE)) {
      return {
        code: LLM_INPUT_TOO_LARGE_CODE,
        message: 'Provider input budget exceeded; summary request suppressed',
      };
    }

    const noFindingsGate = diagnostics?.gateFailures?.find(
      (gate) => gate.action === 'degraded_no_findings'
    );
    if (noFindingsGate) {
      return {
        code: 'degraded_no_findings',
        message:
          noFindingsGate.reason ||
          'Quality gate degraded because required evidence findings were not recorded',
      };
    }

    const budgetExhaustedGate = diagnostics?.gateFailures?.find(
      (gate) => gate.action === 'degraded_budget_exhausted'
    );
    if (budgetExhaustedGate) {
      return {
        code: 'degraded_budget_exhausted',
        message:
          budgetExhaustedGate.reason ||
          'Quality gate degraded because retry would exceed the session token budget',
      };
    }

    if (
      (ctx.sharedState?._recordRepairOnly === true || ctx.context?.recordRepairOnly === true) &&
      diagnostics?.degraded
    ) {
      return {
        code: 'record_repair_incomplete',
        message: 'Record repair ended degraded before enough validated findings were recorded',
      };
    }

    return null;
  }

  #buildSuppressedSummaryReply(suppression: { code: string; message: string }) {
    return `[run stopped: ${suppression.code}] ${suppression.message}`;
  }

  /**
   * 强制摘要契约选择（I11 / L5-P26）。优先级：
   *   1. 调用方显式声明 context.summaryMode（PipelineStrategy 只为自身构造的 summary_rewrite /
   *      record_repair 微阶段传 'none'；待决事项④的阶段策略对象落地后由它提供）——非法值记 warn 后忽略；
   *   2. 非 system 源 → user（旧推断不变）；
   *   3. 有 tracker → 按 tracker.pipelineType：analyst → analyst-report、producer → producer-summary、
   *      其余（bootstrap）→ dimension-digest（scan 在 #finalize 中先行短路）；
   *   4. 无 tracker 的 record_repair 微阶段标记（recordRepairOnly）→ none：该微阶段由门内联调用，
   *      只负责 note_finding 补写，正文不进入管线最终 reply；
   *   5. 其余无 tracker 的 system 源保持旧推断 dimension-digest（严格链、进化首轮与补写轮等待④统一）。
   *      进化补写轮（sharedState._evolutionDecisionOnly）刻意不映射为 none：它是进化管线最后一个主阶段，
   *      reply 就是管线最终 reply，AgentService.inferRunStatus 以空 reply 判 error，必须产出非空摘要。
   * trigger 只用于日志与诊断，说明选择依据。
   */
  #resolveForcedSummaryMode(ctx: LoopContext): { mode: ForcedSummaryMode; trigger: string } {
    const declared = ctx.context?.summaryMode;
    if (declared !== undefined) {
      if (isForcedSummaryMode(declared)) {
        return { mode: declared, trigger: 'context.summaryMode' };
      }
      this.logger.warn(
        `[AgentRuntime] finalize: ignoring invalid context.summaryMode=${describeDeclaredMode(declared)} — selecting by tracker/stage markers`
      );
    }
    if (!ctx.isSystem) {
      return { mode: 'user', trigger: `source=${ctx.source || 'user'}` };
    }
    const tracker = ctx.tracker;
    if (tracker) {
      const pipelineType = tracker.pipelineType;
      if (pipelineType === 'analyst') {
        return { mode: 'analyst-report', trigger: 'tracker.pipelineType=analyst' };
      }
      if (pipelineType === 'producer') {
        return { mode: 'producer-summary', trigger: 'tracker.pipelineType=producer' };
      }
      return {
        mode: 'dimension-digest',
        trigger: `tracker.pipelineType=${pipelineType || 'unknown'}`,
      };
    }
    if (ctx.sharedState?._recordRepairOnly === true) {
      return { mode: 'none', trigger: 'sharedState._recordRepairOnly' };
    }
    if (ctx.context?.recordRepairOnly === true) {
      return { mode: 'none', trigger: 'context.recordRepairOnly' };
    }
    if (ctx.sharedState?._evolutionDecisionOnly === true) {
      // 进化补写轮走原推断（见上方第 5 条）；trigger 单独标出，日志里能区分补写轮与普通系统源。
      return {
        mode: 'dimension-digest',
        trigger:
          'legacy-default(system, no tracker; evolution decision-only retry keeps inference)',
      };
    }
    return { mode: 'dimension-digest', trigger: 'legacy-default(system, no tracker)' };
  }

  /** 循环退出后处理 — 强制摘要 + 构建返回值 */
  async #finalize(ctx: LoopContext) {
    // 强制摘要 — 循环结束后无文本回复时，生成摘要
    // 覆盖所有场景: 系统管线、tracker 管线、用户对话(有/无工具调用)
    if (!ctx.lastReply) {
      // 抑制判定先于模式选择执行：它会登记 stage_timeout 等停止原因，result.timedOut 依赖这一副作用。
      const suppression = this.#getForcedSummarySuppression(ctx);
      const summaryMode = this.#resolveForcedSummaryMode(ctx);
      if (summaryMode.mode === 'none') {
        // I11：无 tracker 的系统微阶段（只有 summary_rewrite / record_repair）不产出摘要，
        // 任何无文本退出（含被抑制的停止）都返回空 reply——PipelineStrategy 据此走
        // “重写无可用文本 → analysis_retry”，不会把兜底 JSON 或停止文案当作分析正文写回。
        // 停止原因保留在诊断里，不进入 reply。
        ctx.lastReply = '';
        const stopDetail = suppression ? `; stop=${suppression.code}: ${suppression.message}` : '';
        this.logger.info(
          `[AgentRuntime] finalize: forced summary suppressed — summaryMode=none (trigger=${summaryMode.trigger}), empty reply returned (iter=${ctx.iteration}, toolCalls=${ctx.toolCalls.length}${stopDetail})`
        );
        ctx.diagnostics?.warn({
          code: 'forced_summary_suppressed',
          message: `Stage declares summaryMode=none (trigger=${summaryMode.trigger}); no forced summary requested and the reply is left empty${stopDetail}`,
        });
      } else if (suppression) {
        ctx.lastReply = this.#buildSuppressedSummaryReply(suppression);
        ctx.diagnostics?.warn({
          code: 'forced_summary_suppressed',
          message: suppression.message,
        });
      } else if (ctx.tracker?.pipelineType === 'scan') {
        // 先判定真实停止原因。正常 Scan 的产物已在回执中，继续跳过额外摘要调用。
        const recipeCount = ctx.toolCalls.filter(isPersistedSubmission).length;
        ctx.lastReply = `[scan complete: ${recipeCount} recipes collected]`;
      } else if (ctx.toolCalls.length > 0 || ctx.tracker || ctx.isSystem) {
        this.logger.info(
          `[AgentRuntime] finalize: forced summary mode=${summaryMode.mode} (trigger=${summaryMode.trigger})`
        );
        const forcedResult = await produceForcedSummary({
          aiProvider: this.aiProvider,
          source: ctx.source,
          toolCalls: ctx.toolCalls,
          tracker: ctx.tracker ?? undefined,
          contextWindow: ctx.contextWindow,
          prompt: ctx.prompt,
          tokenUsage: this.tokenUsage,
          systemPrompt: ctx.baseSystemPrompt,
          maxTokens: ctx.budget.maxTokens,
          temperature: ctx.budget.temperature,
          abortSignal: ctx.abortSignal ?? undefined,
          summaryMode: summaryMode.mode,
        });
        ctx.lastReply = forcedResult.reply;
        ctx.diagnostics?.recordForcedSummary();
        if (forcedResult.tokenUsage) {
          const usage = {
            inputTokens: forcedResult.tokenUsage.input,
            outputTokens: forcedResult.tokenUsage.output,
            reasoningTokens: forcedResult.tokenUsage.reasoning,
            cacheHitTokens: forcedResult.tokenUsage.cacheHit,
          };
          requireBudgetController(ctx).recordLLMUsage(usage);
          ctx.addTokenUsage(usage);
          ctx.diagnostics?.recordTokenUsage(usage);
        }
        if (forcedResult.degraded) {
          ctx.diagnostics?.markDegraded();
          ctx.diagnostics?.markFallbackUsed();
          ctx.diagnostics?.warn({
            code: 'forced_summary_degraded',
            message: 'Summary unavailable; confirmed tool observations retained',
          });
        }
        if (ctx.abortSignal?.aborted) {
          ctx.diagnostics?.recordCancelReason('abort_signal');
        }
      } else {
        // 兜底: 既无工具调用也无文本回复
        ctx.lastReply = '抱歉，AI 未能生成有效回复。请重试或换个问题。';
        this.logger.warn(
          `[AgentRuntime] ⚠ finalize: no reply, no tool calls (iter=${ctx.iteration}) — fallback message`
        );
        ctx.diagnostics?.markFallbackUsed();
        ctx.diagnostics?.warn({
          code: 'fallback_reply',
          message: 'Finalized with fallback message because no reply or tool calls were produced',
        });
      }
    }

    this.#hookSystem.emitSync(
      'agent:finalize',
      {
        reply: ctx.lastReply,
        iterations: ctx.iteration,
        toolCallCount: ctx.toolCalls.length,
      },
      { diagnostics: ctx.diagnostics }
    );

    const result = ctx.buildResult();
    const cancelReason = result.diagnostics?.efficiency?.cancelReason;
    // 复用阶段既有终态合同。非空停止文案不是成功，也不能被 Pipeline 当作已恢复超时。
    return {
      ...result,
      ...(ctx.abortSignal?.aborted || cancelReason === 'abort_signal' ? { aborted: true } : {}),
      ...(cancelReason === 'stage_timeout' ? { timedOut: true } : {}),
    };
  }

  // ─── 公共工具方法 ────────────────────────────

  /**
   * 中止执行。
   *
   * 只取消当前 execute() 的执行边界。没有活动执行时（尚未运行、已经结束，或只直接调用了
   * reactLoop 而未经 execute）没有可取消的对象：旧实现仍把状态机转到 aborted 并发布
   * AGENT_ABORTED，导致同一实例下一次成功执行的 start/finish 全被丢弃、结果报告 aborted（I39）。
   * 现在这种调用只记日志，不转移状态、不发布事件。
   */
  abort(reason = 'User aborted') {
    const controller = this.#executionAbortController;
    if (!controller) {
      const phase = this.state.phase;
      const abortEventPublished = this.#abortEventPublished;
      observeSafely(
        () =>
          this.logger.info('[AgentRuntime] abort ignored: no active execution', {
            runtimeId: this.id,
            reason,
            phase,
            abortEventPublished,
          }),
        () => undefined
      );
      return;
    }
    controller.abort(new Error(reason));
    if (this.#abortEventPublished) {
      return;
    }
    this.#abortEventPublished = true;
    this.#safeTransition('abort', { reason });
    this.bus.publish(
      AgentEvents.AGENT_ABORTED,
      {
        agentId: this.id,
        reason,
      },
      { source: this.id }
    );
  }

  /**
   * 注入内存文件缓存（bootstrap 场景: allFiles 已在内存中，避免重复磁盘读取）
   * @param files [{ relativePath, content, name }]
   */
  setFileCache(files: FileCacheEntry[] | null) {
    this.#fileCache = files;
    this.#promptBuilder.setFileCache(files);
  }

  /** HookSystem 实例（供外部桥接 AgentEventBus / SignalBus） */
  get hookSystem(): HookSystem {
    return this.#hookSystem;
  }

  /** 项目根目录 (供 ToolExecutionPipeline 等访问) */
  get projectRoot() {
    return this.#projectRoot;
  }

  /** 数据根目录 (Ghost 模式下指向外置工作区) */
  get dataRoot() {
    return this.#dataRoot;
  }

  /** 文件缓存 (供 ToolExecutionPipeline 等访问) */
  get fileCache() {
    return this.#fileCache;
  }

  /** 发送进度事件 (公开方法，供 ToolExecutionPipeline 中间件调用) */
  emitProgress(type: string, data: Record<string, unknown> = {}) {
    this.#emitProgress(type, data);
  }

  // ─── 私有方法 ────────────────────────────────

  /** 构造 runtime 自有的状态机；初始数据只含实例身份，不带任何一次运行的 payload。 */
  #createInitialState(): AgentState {
    return new AgentState({
      initialData: { runtimeId: this.id, preset: this.presetName },
    });
  }

  /**
   * 每次 execute() 开始时把状态机复位到 idle（I39）。
   *
   * 状态机只在构造时创建，而默认转移图没有回到 idle 的边：复用同一实例时，上一次的终态
   * （completed/failed/aborted）或直接 reactLoop 留下的 executing/reflecting 会让本次的
   * 'start'/'finish' 全部成为非法转移，result.state 报告上一次的阶段。AgentState 不提供
   * reset，所以新建实例；新实例只保留构造时的初始数据，上一次的 prompt/reply/error 不混入本次结果。
   *
   * `runtime.state` 是公开字段，调用方可能已订阅 'transition'/'phase:*'：把旧实例上的监听器按
   * 原顺序迁到新实例，once 订阅仍以 once 注册，避免复位后订阅被静默丢弃。
   * phase 仍为 idle 说明从未发生转移（默认转移图回不到 idle），直接短路不做任何事。
   * 已知边界：调用方若把 `state` 换成带自定义转移的 AgentState，复位后只保留默认转移图。
   */
  #resetStateForRun() {
    const previous = this.state;
    if (previous.phase === AgentPhase.IDLE) {
      return;
    }
    const next = this.#createInitialState();
    next.setMaxListeners(previous.getMaxListeners());
    let migratedListeners = 0;
    for (const eventName of previous.eventNames()) {
      for (const raw of previous.rawListeners(eventName)) {
        // rawListeners 对 once 订阅返回 Node 的包装函数（带 .listener 指向原函数）；
        // 包装函数绑定旧实例，直接迁移会在新实例上留下失效包装，因此取原函数重新 once 注册。
        const original: unknown = Reflect.get(raw, 'listener');
        if (typeof original === 'function') {
          next.once(eventName, original as (...args: unknown[]) => void);
        } else {
          next.on(eventName, raw as (...args: unknown[]) => void);
        }
        migratedListeners++;
      }
    }
    previous.removeAllListeners();
    this.state = next;
    const previousPhase = previous.phase;
    observeSafely(
      () =>
        this.logger.info('[AgentRuntime] state reset to idle before execute', {
          runtimeId: this.id,
          previousPhase,
          migratedListeners,
        }),
      () => undefined
    );
  }

  /**
   * 安全状态转移 — 状态机只是执行过程的可观测投影，任何转移结果都不能中断执行。
   *
   * AgentState.send 遇到没有匹配的转移或 guard 拒绝时返回 false，并不抛错。Pipeline/FanOut
   * 场景下 reactLoop() 被多次调用，第 2+ 个阶段的 'start'/'plan_ready' 从 executing/reflecting
   * 出发就是这种预期的非法转移：按 debug 记录事件名与当前阶段后跳过，保证多阶段执行不中断。
   *
   * send 真正会抛出的是转移 action 或 'transition'/'phase:*' 观察者的异常：此时阶段已经切换，
   * 记 warn（只记错误类型，不记观察者的错误内容）后继续执行，保持“观察者失败不影响业务结果”。
   */
  #safeTransition(event: string, payload: Record<string, unknown> = {}) {
    const fromPhase = this.state.phase;
    let transitioned: boolean;
    try {
      transitioned = this.state.send(event, payload);
    } catch (err: unknown) {
      const toPhase = this.state.phase;
      const errorType = err instanceof Error ? err.name : typeof err;
      observeSafely(
        () =>
          this.logger.warn('[AgentRuntime] state transition observer failed; execution continues', {
            runtimeId: this.id,
            event,
            fromPhase,
            toPhase,
            errorType,
          }),
        () => undefined
      );
      return;
    }
    if (!transitioned) {
      this.#logDebug('[AgentRuntime] state transition skipped: not allowed from current phase', {
        runtimeId: this.id,
        event,
        phase: fromPhase,
        availableEvents: this.state.availableEvents(),
      });
    }
  }

  /**
   * debug 级诊断。`runtime.logger` 的公开类型只承诺 info/warn（测试与宿主可注入只有这两个方法的对象）：
   * 注入对象提供 debug 时用它；否则退回 Core 全局 Logger 的 debug（受 ALEMBIC_LOG_LEVEL 过滤）。
   * 诊断通道失败不能影响执行，统一经 observeSafely 隔离。
   */
  #logDebug(message: string, meta: Record<string, unknown>) {
    const logger: Pick<Console, 'info' | 'warn'> & Partial<Pick<Console, 'debug'>> = this.logger;
    observeSafely(
      () => {
        if (typeof logger.debug === 'function') {
          logger.debug(message, meta);
          return;
        }
        Logger.getInstance().debug(message, meta);
      },
      () => undefined
    );
  }

  /**
   * 记录本 loop 输入上限的来源（I14）。每个 loop 一条 info，写清选择路径与关键输入；
   * 两个降级分支额外 warn：显式值非法被忽略、输出预留吃掉整个窗口而跳过预留。
   * default 来源说明 modelRef 未在注册表登记（或 provider 未知），守卫保留与模型无关的 128k。
   */
  #logProviderInputLimit(limit: ProviderInputLimitResolution) {
    if (limit.invalidExplicitValue !== undefined) {
      this.logger.warn(
        '[AgentRuntime] explicit maxProviderInputTokens ignored: not a positive finite number',
        {
          modelRef: this.#modelRef,
          invalidExplicitValue: limit.invalidExplicitValue,
          fallbackSource: limit.source,
        }
      );
    }
    if (limit.outputReserveSkipped) {
      this.logger.warn(
        '[AgentRuntime] provider input limit skipped output reserve: reserve >= model context window',
        {
          modelRef: this.#modelRef,
          registryModelId: limit.registryModelId ?? null,
          contextWindow: limit.contextWindow ?? null,
          maxProviderInputTokens: limit.maxTokens,
        }
      );
    }
    this.logger.info('[AgentRuntime] provider input limit resolved', {
      modelRef: this.#modelRef,
      source: limit.source,
      maxProviderInputTokens: limit.maxTokens,
      registryModelId: limit.registryModelId ?? null,
      contextWindow: limit.contextWindow ?? null,
      outputReserveTokens: limit.outputReserveTokens ?? null,
    });
  }

  /**
   * 收集所有 Agent Skill 的工具白名单。
   * 空 tools 表示该技能不开放工具；全量工具必须通过显式 action space 表达。
   */
  #collectToolContract(
    caps: Capability[],
    additionalToolsOverride?: string[]
  ): RuntimeToolContract {
    const actionMap = new Map<string, Set<string> | null>();
    const allowAllActions = (tool: string) => {
      actionMap.set(tool, null);
    };
    const allowActions = (tool: string, actions: readonly string[]) => {
      if (actionMap.get(tool) === null) {
        return;
      }
      const set = actionMap.get(tool) ?? new Set<string>();
      for (const action of actions) {
        if (action) {
          set.add(action);
        }
      }
      actionMap.set(tool, set);
    };

    for (const cap of caps) {
      const allowedTools = (cap as { allowedTools?: unknown }).allowedTools;
      if (allowedTools !== undefined) {
        const snapshot = snapshotToolActionAllowlist(allowedTools);
        if (!snapshot) {
          throw new Error(`Invalid capability action allowlist: ${cap.name}`);
        }
        for (const [tool, actions] of Object.entries(snapshot)) {
          if (actions == null) {
            allowAllActions(tool);
          } else {
            allowActions(tool, actions);
          }
        }
        continue;
      }

      for (const tool of cap.tools || []) {
        allowAllActions(String(tool));
      }
    }
    // 合并调用方按需注入的额外工具 (不经 Capability，避免污染共享能力)
    for (const t of this.#additionalTools) {
      allowAllActions(String(t));
    }
    for (const t of additionalToolsOverride || []) {
      allowAllActions(String(t));
    }

    const ids = [...actionMap.entries()]
      .filter(([, set]) => set === null || set.size > 0)
      .map(([tool]) => tool);
    const actions = Object.fromEntries(
      ids.map((tool) => {
        const set = actionMap.get(tool);
        return [tool, set ? [...set] : null];
      })
    );
    return { actions, ids };
  }

  #queryToolSchemas(
    toolContract: RuntimeToolContract,
    model: string,
    runtime: ToolRuntimeCallContext
  ): ToolSchemaQueryResult {
    const catalog = (this.container as { get?: (name: string) => unknown } | null)?.get?.(
      'capabilityCatalog'
    );
    return queryToolSchemas(
      catalog,
      {
        selection: toolContract.actions,
        model,
        // 这里的 model 来自明确的 modelRef（provider:model）；API id 可继续包含冒号。
        // catalog 的旧直接调用只拿到裸字符串，不能在那里猜测 provider 身份。
        apiModelId: model.slice(model.indexOf(':') + 1),
        mode: 'mixed',
        // 固定 firstRound:true，不再用目录单例的 expandedCount 推导：
        // 1) schema 每次运行只查询一次并在全部轮次复用，运行内的 lazy 展开本来就不会生效；
        // 2) capabilityCatalog 是跨运行共享的进程级实例，其展开状态从不重置，按它推导会让
        //    后续运行中未用过的工具被投影成空参数 schema（必填参数丢失且没有诊断）。
        // 因此每次运行都向目录要完整 schema，与实际的运行内行为一致。
        // RuntimeCapabilityCatalog 本就忽略 firstRound；UnifiedToolCatalog 的 lazy 公开方法语义不变，
        // 只是运行时不再读写它的实例级展开状态（是否改造成运行作用域属于待决事项）。
        // 这里刻意保留 mode:'mixed' 而不改成 mode:'full'（两种写法都能拿到完整 schema）：
        // queryLegacySchemas 在 full 下会让同时提供两类方法的旧宿主改选 toToolSchemas*，
        // 旧端口的选择顺序随之变化；mixed + firstRound:true 保持 toMixedSchemas* 优先的既有顺序，
        // 新端口（CapabilityCatalog/UnifiedToolCatalog）在 firstRound:true 下同样给完整投影。
        // “每次运行”也包括 pipeline 各阶段：每个阶段在同一 runtime 上各跑一次 reactLoop，
        // 各自经 #initLoop 查询一次，前一阶段用过哪些工具不影响后一阶段的 schema。
        // 回归见 test/tool-schema-projection.test.ts 的 runtime lazy schema state across runs。
        firstRound: true,
        runtime,
      },
      (method) => {
        this.logger.info(
          `[AgentRuntime] legacy schema query adapter: ${method}; stage action constraints retained`
        );
      }
    );
  }

  /** 解析 capability 名称为实例 (Pipeline 阶段覆盖时调用) */
  #resolveCapabilities(capNames: string[] | null) {
    if (capNames == null) {
      return this.capabilities;
    }
    if (capNames.length === 0) {
      return []; // explicit empty = no tools
    }
    return capNames.map((name: string | Capability) => {
      if (typeof name === 'object' && name instanceof Capability) {
        return name;
      }
      // 先在已加载的 capabilities 中查找
      const existing = this.capabilities.find((c: Capability) => c.name === name);
      if (existing) {
        return existing;
      }
      // 否则从注册表创建
      return CapabilityRegistry.create(name as string);
    });
  }

  /** 发送进度事件 */
  #emitProgress(type: string, data: Record<string, unknown> = {}) {
    const event = {
      type,
      agentId: this.id,
      preset: this.presetName,
      ...data,
      timestamp: Date.now(),
    };
    observeSafely(
      () => this.onProgress?.(event),
      () =>
        this.logger.warn('[AgentRuntime] progress observer failed; execution continues', {
          eventType: type,
          agentId: this.id,
        })
    );
    this.bus.publish(AgentEvents.PROGRESS, event, { source: this.id });
  }

  /** 发送可被 Alembic recorder 消费的 developer-safe 过程事件。 */
  #emitProcessProgress(processEvent: AgentProgressProcessEvent) {
    this.#emitProgress('agent_process_event', { processEvent });
  }
}

function withDirectNoteFindingSchema(
  schemas: Array<Record<string, unknown>>,
  allowed: boolean
): Array<Record<string, unknown>> {
  if (!allowed) {
    return schemas;
  }
  if (!schemas.some((schema) => schema.name === 'memory')) {
    return schemas;
  }
  if (schemas.some((schema) => schema.name === 'note_finding')) {
    return schemas;
  }
  return [...schemas, buildDirectNoteFindingSchema(false)];
}

function canUseDirectNoteFinding(ctx: LoopContext): boolean {
  if (!ctx.allowedToolIds.includes('memory')) {
    return false;
  }
  const memoryActions = ctx.allowedToolActions.memory;
  return !memoryActions || memoryActions.includes('note_finding');
}

function buildDirectNoteFindingSchema(recordOnly: boolean): Record<string, unknown> {
  return {
    name: 'note_finding',
    description: recordOnly
      ? 'Record one structured, evidence-backed key finding. In RECORD/record-repair phase this is the primary function; call it once per finding and do not output prose.'
      : 'Record one structured, evidence-backed key finding for QualityGate. Call it when a finding is verified; do not wait for the final Markdown report.',
    parameters: {
      type: 'object',
      properties: {
        finding: {
          type: 'string',
          description: 'Concrete, verifiable finding description.',
        },
        // E3/E4（证据保真）：直呼型 schema 与 memory.note_finding 同契约——引用只能是
        // 工具返回尾部 [evidence] 标注的台账条目 id；手写 file:line 会被录入校验拒收。
        evidenceRefs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Evidence ledger entry ids cited from [evidence] annotations in tool results, e.g. ["E-3", "E-7@5-12"]. Hand-written file:line strings are rejected.',
        },
        excerpt: {
          type: 'string',
          description: 'Optional short verbatim excerpt from the cited evidence entries.',
        },
        importance: {
          type: 'number',
          description: 'Importance 1-10.',
          minimum: 1,
          maximum: 10,
        },
        // M1c（挖掘产出升级）：直呼型 schema 补齐深度槽——此前只有 registry 面声明，
        // RECORD 相走本 schema 且 additionalProperties:false，模型物理上无法传槽位（0 使用率根因）。
        ...DEPTH_SLOT_PROPS,
      },
      required: ['finding', 'evidenceRefs', 'importance'],
      additionalProperties: false,
    },
  };
}

function buildAgentProcessEvent(
  ctx: LoopContext,
  input: ProcessEventInput
): AgentProgressProcessEvent {
  const dimensionMeta = asRecord(ctx.sharedState?._dimensionMeta);
  const phase =
    input.phase ??
    stringValue(ctx.context?.pipelinePhase) ??
    (typeof ctx.tracker?.phase === 'string' ? ctx.tracker.phase : null);
  // 先完成内容投影，再在原发射点取时间和PCV快照；观察模块不接管这些活跃状态。
  return createAgentProcessEvent(
    {
      createdAt: new Date().toISOString(),
      dimensionId:
        stringValue(dimensionMeta.id) ||
        stringValue(ctx.context?.dimensionId) ||
        stringValue(ctx.context?.dimId) ||
        null,
      iteration: ctx.iteration,
      source: ctx.source,
      pcvNodeEvidence: buildPcvNodeEvidenceProcessMetadata(ctx.pcvNodeEvidence),
      phase,
      targetName:
        stringValue(dimensionMeta.label) ||
        stringValue(dimensionMeta.targetName) ||
        stringValue(ctx.context?.targetName) ||
        null,
    },
    input
  );
}

function isEvidenceGroundingToolCall(toolName: string, args: Record<string, unknown>): boolean {
  const action = stringValue(args.action) || stringValue(asRecord(args.params).action);
  if (toolName === 'code') {
    return ['structure', 'search', 'read', 'outline'].includes(action || '');
  }
  if (toolName === 'graph') {
    return ['overview', 'query'].includes(action || '');
  }
  return toolName === 'terminal';
}

function buildSemanticNudgeProcessEvent(
  ctx: LoopContext,
  nudge: { type: string; text: string },
  options: {
    phase?: string | null;
    semanticKind?: string;
  } = {}
): AgentProgressProcessEvent {
  const dimensionMeta = asRecord(ctx.sharedState?._dimensionMeta);
  const dimensionId =
    stringValue(dimensionMeta.id) ||
    stringValue(ctx.context?.dimensionId) ||
    stringValue(ctx.context?.dimId) ||
    null;
  const targetName =
    stringValue(dimensionMeta.label) ||
    stringValue(dimensionMeta.targetName) ||
    stringValue(ctx.context?.targetName) ||
    null;
  const trackerPhase = typeof ctx.tracker?.phase === 'string' ? ctx.tracker.phase : null;
  const phase = options.phase ?? stringValue(ctx.context?.pipelinePhase) ?? trackerPhase ?? null;
  const pipelineType =
    typeof ctx.tracker?.pipelineType === 'string' ? ctx.tracker.pipelineType : null;
  return buildAgentProcessEvent(
    ctx,
    projectSemanticNudgeEvent(
      nudge,
      {
        dimensionId,
        phase,
        pipelineType,
        source: ctx.source,
        targetName,
      },
      options.semanticKind
    )
  );
}

function recordAbortRecoveryDiagnostic(ctx: LoopContext, message: string): void {
  ctx.diagnostics?.warn({
    code: 'ABORT_RECOVERY_RECORDED',
    message,
  });
}

/**
 * 按 modelRef 查模型注册表，供输入长度上限（I14）使用，口径与 LLMGateway / ContextWindow 一致：
 * - 'provider:apiModelId' 只经 registry.resolve：provider 先归一别名；未知 provider（含部署选择 auto）
 *   返回 undefined，不跨 provider 猜测，也不用 resolveOrCreate 的动态 128k 定义冒充“可信注册值”；
 * - 无 provider 前缀的裸 apiModelId 用 findByApiModelId（内置表保证 apiModelId 全局唯一）。
 * 查不到时由 resolveProviderInputLimit 保留 128k 默认，#logProviderInputLimit 记录 source=default。
 */
function lookupRegisteredModelDef(modelRef: string): ModelDef | undefined {
  if (!modelRef) {
    return undefined;
  }
  const registry = getModelRegistry();
  const separator = modelRef.indexOf(':');
  if (separator > 0) {
    return registry.resolve(modelRef.slice(0, separator), modelRef.slice(separator + 1));
  }
  return registry.findByApiModelId(modelRef);
}

function readPositiveBudgetNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

function inferFunctionCallSource(call: { id?: string }) {
  // DeepSeek 文本兼容桥会生成 call_deepseek_compat_*。这类调用可以写入
  // ActiveContext，但不能被当作 provider native tool_calls 证据。
  return isTextCompatToolCallId(call.id) ? TEXT_COMPAT_CALL_SOURCE : NATIVE_TOOL_CALL_SOURCE;
}

function isNoteFindingFunctionCall(call: { name?: string; args?: Record<string, unknown> }) {
  return (
    call.name === 'note_finding' || (call.name === 'memory' && call.args?.action === 'note_finding')
  );
}

function requireBudgetController(ctx: LoopContext): BudgetController {
  if (!ctx.budgetController) {
    throw new Error('[AgentRuntime] BudgetController is missing after loop initialization.');
  }
  return ctx.budgetController;
}

function describeLoopCall(ctx: LoopContext, modelRef: string): Record<string, unknown> {
  const dimensionMeta = asRecord(ctx.sharedState?._dimensionMeta);
  return {
    modelRef,
    iteration: ctx.iteration,
    source: ctx.source,
    phase: typeof ctx.tracker?.phase === 'string' ? ctx.tracker.phase : null,
    dimension:
      stringValue(dimensionMeta.id) ||
      stringValue(ctx.context.dimensionId) ||
      stringValue(ctx.context.dimId) ||
      null,
    profile: stringValue(ctx.context.profileId) || null,
  };
}

function formatLoopTrace(trace: Record<string, unknown>): string {
  const parts = [
    `model=${trace.modelRef || 'unknown'}`,
    `iter=${trace.iteration ?? '?'}`,
    trace.dimension ? `dim=${trace.dimension}` : '',
    trace.phase ? `phase=${trace.phase}` : '',
    trace.source ? `source=${trace.source}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

function summarizeFunctionCallSources(calls: Array<{ id?: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    const source = inferFunctionCallSource(call);
    counts[source] = (counts[source] || 0) + 1;
  }
  return counts;
}

/**
 * 异常归一（I08）：provider 可能 reject 任意值，本地缺陷也可能抛非 Error。
 * - Error：取 message；code 只接受字符串（如 gateway 的 CIRCUIT_OPEN）。
 * - 普通对象：兼容带字符串 message / code 的错误形状（旧实现靠 `as AiError` 隐式读取，这里显式保留，
 *   熔断码判断不因 provider 抛普通对象而失效）。
 * - 其他值：String(value)，不再把 'undefined' 写进诊断。
 */
function normalizeAiError(error: unknown): Pick<AiError, 'message' | 'code'> {
  const record =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const code = typeof record?.code === 'string' ? record.code : undefined;
  if (error instanceof Error) {
    return { message: error.message, code };
  }
  if (typeof record?.message === 'string') {
    return { message: record.message, code };
  }
  return { message: describeNonErrorValue(error), code };
}

/** String() 对无原型对象等值会抛错；归一路径本身不能再抛，否则错误恢复链路会被打断。 */
function describeNonErrorValue(value: unknown): string {
  try {
    return String(value);
  } catch (stringifyErr: unknown) {
    return `[unprintable ${typeof value}: ${stringifyErr instanceof Error ? stringifyErr.message : 'String() failed'}]`;
  }
}

function stringifyAbortReason(reason: unknown): string | null {
  if (typeof reason === 'string') {
    return reason;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  if (reason === undefined || reason === null) {
    return null;
  }
  return String(reason);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export default AgentRuntime;
