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

import { randomUUID } from 'node:crypto';
import Logger from '@alembic/core/logging';
import type { ToolSchemaProjection } from '#tools/catalog/CapabilityManifest.js';
import { isToolResultEnvelope } from '#tools/kernel/index.js';
import { Capability, CapabilityRegistry } from '../capabilities/index.js';
import { limitToolResult } from '../context/ContextWindow.js';
import { PolicyEngine } from '../policies/index.js';
import { AgentEventBus, AgentEvents } from './AgentEventBus.js';
import type { AgentMessage } from './AgentMessage.js';
import {
  type AgentProgressProcessEvent,
  type AgentResult,
  type AiError,
  type FileCacheEntry,
  type LLMResult,
  MAX_TOOL_CALLS_PER_ITER,
  type ReactLoopOpts,
  type RuntimeConfig,
  type ToolCallEntry,
  type ToolCallHook,
  type ToolMetadata,
} from './AgentRuntimeTypes.js';
import { AgentState } from './AgentState.js';
import { BudgetController } from './BudgetController.js';
import { DiagnosticsCollector } from './DiagnosticsCollector.js';
import { createExitController } from './ExitController.js';
import { cleanFinalAnswer } from './finalAnswer.js';
import { produceForcedSummary } from './forcedSummary.js';
import { HookSystem, registerDefaultHooks } from './HookSystem.js';
import {
  buildLlmInputAssembly,
  type LLMInputAssembly,
  type LLMInputStageProfile,
  resolveLlmInputStageProfile,
} from './LLMInputAssembly.js';
import {
  type LLMInputAssemblyMeasurement,
  measureLlmInputAssembly,
} from './LLMInputMeasurement.js';
import { continueResult, LLMResultType } from './LLMResultType.js';
import { LoopContext } from './LoopContext.js';
import { createMessageAdapter } from './MessageAdapter.js';
import {
  buildPcvNodeEvidenceProcessMetadata,
  getLatestPcvBurnGrounding,
  recordPcvInputAssembly,
  recordPcvLlmOutput,
  recordPcvToolResult,
  recordPcvToolRoundOutcome,
} from './PcvNodeEvidence.js';
import { SystemPromptBuilder } from './SystemPromptBuilder.js';
import { createToolPipeline } from './ToolExecutionPipeline.js';

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

function resolveProviderInputBudget(stageProfile: LLMInputStageProfile) {
  switch (stageProfile) {
    case 'record':
      return { maxProjectedMessages: 40, maxProjectedTokens: 14_000 };
    case 'produce':
      return { maxProjectedMessages: 20, maxProjectedTokens: 12_000 };
    case 'analyze':
    case 'summarize':
      return { maxProjectedMessages: 44, maxProjectedTokens: 16_000 };
    default:
      return null;
  }
}

type RuntimeToolActionAllowlist = Record<string, string[] | null>;

interface RuntimeToolContract {
  actions: RuntimeToolActionAllowlist;
  ids: string[];
  restrictedActions: Record<string, string[]>;
}

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
  /** 文件缓存 (bootstrap 场景注入) */
  #fileCache: FileCacheEntry[] | null = null;
  /** 额外工具白名单 (调用方按需注入，不经 Capability) */
  #additionalTools: string[] = [];
  #toolPipeline;
  #promptBuilder;
  /** 模型引用（provider:model），用于日志 / trace / 工具裁剪等运行期判断 */
  #modelRef: string;
  /** 统一事件钩子系统 */
  #hookSystem: HookSystem;

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
    this.#additionalTools = config.additionalTools || [];
    this.#modelRef =
      config.modelRef ||
      `${config.aiProvider.name}:${(config.aiProvider as { model?: string }).model || 'unknown'}`;
    this.#toolPipeline = createToolPipeline();
    this.#hookSystem = (config as { hookSystem?: HookSystem }).hookSystem ?? new HookSystem();
    registerDefaultHooks(this.#hookSystem, this.id, this.bus);
    this.#promptBuilder = new SystemPromptBuilder({
      persona: this.persona,
      fileCache: this.#fileCache,
      lang: this.lang,
      memoryConfig: this.memoryConfig,
    });

    this.state = new AgentState({
      initialData: { runtimeId: this.id, preset: this.presetName },
    });

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
    this.startTime = Date.now();
    this.iterationCount = 0;
    this.toolCallHistory = [];
    this.tokenUsage = { input: 0, output: 0, reasoning: 0, cacheHit: 0 };

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

    // ── 超时保护 ──
    const budget = this.policies.getBudget();
    const timeoutMs = budget?.timeoutMs || 300_000;
    const abortController = new AbortController();
    const parentAbortSignal =
      opts.abortSignal && typeof (opts.abortSignal as AbortSignal).aborted === 'boolean'
        ? (opts.abortSignal as AbortSignal)
        : null;
    const onParentAbort = () => abortController.abort();
    if (parentAbortSignal?.aborted) {
      abortController.abort();
    } else {
      parentAbortSignal?.addEventListener('abort', onParentAbort, { once: true });
    }
    const cleanupExecutionGuards = () => {
      clearTimeout(timeoutId);
      parentAbortSignal?.removeEventListener('abort', onParentAbort);
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Agent timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      // ── 委托给 Strategy ──
      const resultPromise = this.strategy.execute(this, message, {
        ...opts,
        abortSignal: abortController.signal,
        diagnostics,
      });
      const result = (await Promise.race([resultPromise, timeoutPromise])) as AgentResult;
      cleanupExecutionGuards();
      if (diagnostics.isEmpty()) {
        diagnostics.merge(result.diagnostics);
      }

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
      this.#safeTransition('finish', { reply: result.reply?.slice(0, 100) });

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

      this.bus.publish(
        AgentEvents.AGENT_COMPLETED,
        {
          agentId: this.id,
          preset: this.presetName,
          iterations: result.iterations,
          durationMs: result.durationMs,
        },
        { source: this.id }
      );

      return result;
    } catch (err: unknown) {
      cleanupExecutionGuards();
      this.state.send('error', { error: (err as Error).message });
      this.bus.publish(
        AgentEvents.AGENT_FAILED,
        {
          agentId: this.id,
          error: (err as Error).message,
        },
        { source: this.id }
      );
      throw err;
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
    const ctx = this.#initLoop(prompt, opts);

    // ─── ReAct 主循环 (编排骨架) ─────
    while (true) {
      ctx.iteration++;
      this.iterationCount++;

      // ActiveContext: 开始新轮次 (必须在 #shouldExit 前, 保证 endRound 有配对)
      ctx.trace?.startRound(ctx.iteration);

      this.#hookSystem.emitSync('agent:iteration:before', {
        iteration: ctx.iteration,
        phase: ctx.tracker?.phase,
      });

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
        const exitAfterTools = await this.#processToolCalls(ctx, llmResult, effectiveSystemPrompt);
        this.#hookSystem.emitSync('agent:iteration:after', {
          iteration: ctx.iteration,
          hadToolCalls: true,
          hadText: !!llmResult.text,
        });
        if (exitAfterTools) {
          break;
        }
        continue;
      }

      // 分支: 纯文本回复
      this.#hookSystem.emitSync('agent:iteration:after', {
        iteration: ctx.iteration,
        hadToolCalls: false,
        hadText: true,
      });
      if (this.#processTextResponse(ctx, llmResult)) {
        break;
      }
    }

    return this.#finalize(ctx);
  }

  // ─── 提取方法: reactLoop 内部阶段 ────────────

  /** 初始化循环上下文 — 封装 reactLoop 前 ~60 行初始化逻辑 */
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
      abortSignal,
      diagnostics,
    } = opts;
    const diagnosticsCollector = DiagnosticsCollector.from(diagnostics);

    // 解析 capabilities
    const caps = capabilityOverride
      ? this.#resolveCapabilities(capabilityOverride)
      : this.capabilities;

    // 构建基础系统提示词 (委托 SystemPromptBuilder)
    let baseSystemPrompt = systemPromptOverride || this.#promptBuilder.build(caps, context);

    // 收集工具 (空列表是明确无工具，不再隐式展开为全量工具)
    const toolContract = this.#collectToolContract(caps, additionalToolsOverride);
    const allowedToolIds = toolContract.ids;
    const toolSchemas = this.#getToolSchemas(toolContract, this.#modelRef);
    diagnosticsCollector.recordStageToolset({
      stage: typeof context.pipelinePhase === 'string' ? context.pipelinePhase : 'react_loop',
      capabilities: caps.map((c: Capability) => c.name),
      allowedToolIds,
      allowedToolActions: toolContract.restrictedActions,
      toolSchemaCount: toolSchemas.length,
      ...(source ? { source } : {}),
    });

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
    const budget = budgetOverride ||
      this.policies.getBudget() || {
        maxIterations: 20,
        maxTokens: 4096,
        temperature: 0.7,
      };

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

    const ctx = new LoopContext({
      messages,
      tracker: tracker || null,
      trace: trace || null,
      memoryCoordinator: memoryCoordinator || null,
      sharedState: sharedState || null,
      source: source || 'user',
      budget,
      capabilities: caps,
      baseSystemPrompt,
      allowedToolIds,
      allowedToolActions: toolContract.restrictedActions,
      toolSchemas,
      prompt,
      onToolCall: onToolCall || null,
      context: context || {},
      contextWindow: contextWindow || null,
      toolChoiceOverride: toolChoiceOverride || null,
      abortSignal: (abortSignal as AbortSignal) || null,
      diagnostics: diagnosticsCollector,
    });

    ctx.exitController = createExitController(ctx, this.policies);

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
      const signal = ec.checkBeforeIteration(ctx, this.tokenUsage);
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
    } else {
      // Legacy fallback (no ExitController — should not happen in normal flow)
      if (ctx.abortSignal?.aborted) {
        return true;
      }
      if (ctx.tracker) {
        ctx.tracker.tick();
        if (ctx.tracker.shouldExit()) {
          return true;
        }
      }
      if (ctx.budget?.timeoutMs && Date.now() - ctx.loopStartTime > ctx.budget.timeoutMs) {
        return true;
      }
      const duringCheck = this.policies.validateDuring({
        iteration: ctx.tracker ? 0 : ctx.iteration,
        startTime: ctx.loopStartTime,
        totalTokens: this.tokenUsage.input + this.tokenUsage.output,
        totalInputTokens: this.tokenUsage.input,
      });
      if (!duringCheck.ok) {
        return true;
      }
    }

    // Capability 前置钩子 (always executed regardless of exit controller)
    for (const cap of ctx.capabilities) {
      cap.onBeforeStep({
        iteration: ctx.iteration,
        messages: ctx.messages.toMessages(),
        prompt: ctx.prompt,
      });
    }

    return false;
  }

  /**
   * 迭代准备 — 合并 nudge/压缩/提示词增强/toolChoice
   *
   * 包含 session token 预算预检: 在 LLM 调用前估算 input token，
   * 如果即将超出 session 级预算，提前触发 SUMMARIZE 而非等到下轮被硬杀。
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
          process.stderr.write(`\x1b[33m${nudge.text}\x1b[0m\n\n`);
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
    const forceSummary = !tracker && ctx.iteration >= forceSummaryAt;
    let toolChoice: string;
    if (ctx.toolChoiceOverride && ctx.iteration === 1) {
      toolChoice = ctx.toolChoiceOverride;
    } else if (tracker) {
      toolChoice = tracker.getToolChoice();
    } else {
      toolChoice = ctx.toolSchemas.length > 0 ? (forceSummary ? 'none' : 'auto') : 'none';
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
        mode: (ctx.source || 'analyst') as 'user' | 'analyst' | 'producer',
        scopeId: (ctx.context?.dimensionScopeId as string) || undefined,
      });
      if (wmContext) {
        dynamicParts.push(wmContext);
      }
    }
    if (forceSummary) {
      dynamicParts.push(
        '[系统提示] 已进入最后阶段，请停止调用探索工具，基于已有信息输出总结。若任务要求结构化记录且尚未记录，只允许使用 note_finding({ finding, evidence, importance }) 补齐核心发现。'
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
    const tracker = ctx.tracker;
    const recordRepairOnly =
      ctx.sharedState?._recordRepairOnly === true || ctx.context?.recordRepairOnly === true;
    if (
      toolChoice !== 'none' &&
      (recordRepairOnly || (tracker?.pipelineType === 'analyst' && tracker.phase === 'RECORD'))
    ) {
      if (
        !ctx.toolSchemas.some((schema) => schema.name === 'memory') ||
        !canUseDirectNoteFinding(ctx)
      ) {
        return [];
      }
      return [buildDirectNoteFindingSchema(true)];
    }
    return withDirectNoteFindingSchema(ctx.toolSchemas, canUseDirectNoteFinding(ctx));
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
        (u) => ctx.addTokenUsage(u)
      );
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

    let llmResult: LLMResult;
    try {
      // toolChoice='none' 时是否保留 tool schemas 取决于供应商:
      //   - 保留: 维持 prefix cache (system prompt + tool schemas 不变 → cache hit)
      //   - 移除: DeepSeek V4 会因 hasTools=true 启用 thinking mode（增加 token 成本）;
      //           Gemini 在禁止调用但看到定义时可能返回空内容
      // 策略: DeepSeek V4 和 Gemini 移除 schemas，其他保留以获得 cache 收益
      const isToolSchemaHarmful =
        /deepseek-v4/i.test(this.#modelRef) || /gemini/i.test(this.#modelRef);
      const deepSeekV4Grounding = buildDeepSeekV4AnalyzeGroundingPolicy(
        ctx,
        this.#modelRef,
        toolChoice
      );
      const effectiveToolSchemas = deepSeekV4Grounding.keepToolSchemasVisible
        ? toolSchemas.length > 0
          ? toolSchemas
          : undefined
        : toolChoice === 'none' && isToolSchemaHarmful
          ? undefined
          : toolSchemas.length > 0
            ? toolSchemas
            : undefined;
      const unifiedTools = effectiveToolSchemas as
        | import('#ai/AiProvider.js').ToolSchema[]
        | undefined;
      const effectiveToolChoice = deepSeekV4Grounding.keepToolSchemasVisible
        ? 'auto'
        : unifiedTools
          ? toolChoice
          : 'none';

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
        effectiveToolChoice,
        iteration: ctx.iteration,
        modelRef: this.#modelRef,
        requestedToolChoice: toolChoice,
      });
      const llmInputMeasurement = measureLlmInputAssembly(llmInputAssembly);
      const llmInputValidation = validateLlmInputSize(ctx, llmInputMeasurement);
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
          }
        );
        if (!ctx.isSystem) {
          ctx.lastReply = `抱歉，当前请求输入过长（${llmInputValidation.estimatedTokens}/${llmInputValidation.maxTokens} tokens）。请缩短输入后重试。`;
        }
        return null;
      }
      const unifiedMessages = llmInputAssembly.providerMessages;
      const llmInputProcessEvent = buildAgentProcessEvent(ctx, {
        kind: 'llm.input',
        title: 'LLM input prepared',
        summary: `Sending ${unifiedMessages.length} message(s) to ${this.#modelRef}`,
        content: {
          role: 'developer',
          text: formatDeveloperVisibleLlmInput(llmInputAssembly),
        },
        metadata: {
          ...llmTrace,
          messageCount: unifiedMessages.length,
          hasDynamicContext: Boolean(dynamicContext),
          requestedToolChoice: toolChoice,
          effectiveToolChoice,
          inputSizeEstimate: {
            inputLayer: llmInputMeasurement.inputLayerEstimatedTokens,
            providerHistory: llmInputMeasurement.providerHistoryEstimatedTokens,
            providerMessages: llmInputMeasurement.providerMessageEstimatedTokens,
            systemPrompt: llmInputMeasurement.systemPromptEstimatedTokens,
            toolSchemas: llmInputMeasurement.toolSchemaEstimatedTokens,
          },
          toolSchemaNames: (unifiedTools || []).map((schema) => schema.name),
          ...llmInputAssembly.metadata,
        },
      });
      this.#hookSystem.emitSync('llm:call:before', {
        iteration: ctx.iteration,
        toolChoice: effectiveToolChoice,
        processEvent: llmInputProcessEvent,
      });
      this.#emitProcessProgress(llmInputProcessEvent);

      // 冷启动链路里第一轮经常最慢；必须先打印“请求已发出”的结构化日志，
      // 否则 Dashboard 只能看到 filling，不知道是在等模型、走重试还是已经被 abort。
      this.logger.info(`[AgentRuntime] LLM call start ${formatLoopTrace(llmTrace)}`, {
        ...llmTrace,
        messageCount: unifiedMessages.length,
        hasDynamicContext: Boolean(dynamicContext),
        deepseekV4ToolChoiceMode: deepSeekV4Grounding.mode,
        requestedToolChoice: toolChoice,
        effectiveToolChoice,
        toolSchemaCount: unifiedTools?.length || 0,
        timeoutMs: ctx.budget.timeoutMs || null,
        maxTokens: ctx.budget.maxTokens ?? (ctx.isSystem ? 8192 : 4096),
      });

      // 方案①：统一经 aiProvider.chatWithTools 调用；provider 内部已委托 LLMGateway + Transport，
      // 不再保留 runtime 级 gateway/provider 双分支（横切能力由 provider 背后的 gateway 统一承担）。
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
      this.logger.warn(`[AgentRuntime] LLM call failed ${formatLoopTrace(llmTrace)}`, {
        ...llmTrace,
        durationMs: Date.now() - llmStartedAt,
        error: aiErr instanceof Error ? aiErr.message : String(aiErr),
        abortSignal: ctx.abortSignal?.aborted === true,
        abortReason: stringifyAbortReason(ctx.abortSignal?.reason),
      });
      return this.#handleAiError(ctx, aiErr as AiError);
    }

    // 累计 Token (BudgetController 管理 runtime 级, LoopContext 管理 loop 级)
    if (llmResult.usage) {
      budgetCtrl.recordLLMUsage(llmResult.usage);
      ctx.addTokenUsage(llmResult.usage);
      ctx.diagnostics?.recordTokenUsage(llmResult.usage);
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

    const llmOutputDeveloperText = redactDeveloperText(
      llmResult.text || formatFunctionCallsForDeveloperContent(llmResult.functionCalls || [])
    );
    const llmOutputCompleteness = buildLlmOutputCompletenessMetadata(
      llmResult,
      llmOutputDeveloperText
    );
    const llmOutputProcessEvent = buildAgentProcessEvent(ctx, {
      kind: 'llm.output',
      title: 'LLM output received',
      summary: formatLlmOutputSummary(llmResult, llmOutputCompleteness),
      content: {
        role: 'assistant',
        text: llmOutputDeveloperText,
      },
      metadata: {
        ...llmTrace,
        durationMs: Date.now() - llmStartedAt,
        ...llmOutputCompleteness,
      },
    });
    this.#hookSystem.emitSync('llm:call:after', {
      iteration: ctx.iteration,
      hasToolCalls: !!llmResult.functionCalls?.length,
      hasText: !!llmResult.text,
      inputTokens: llmResult.usage?.inputTokens,
      outputTokens: llmResult.usage?.outputTokens,
      processEvent: llmOutputProcessEvent,
    });
    this.#emitProcessProgress(llmOutputProcessEvent);
    this.logger.info(`[AgentRuntime] LLM call complete ${formatLoopTrace(llmTrace)}`, {
      ...llmTrace,
      durationMs: Date.now() - llmStartedAt,
      ...llmOutputCompleteness,
    });

    // 空响应重试
    if (!llmResult.text && !llmResult.functionCalls?.length) {
      ctx.diagnostics?.recordEmptyResponse();
      // B4 fix: SUMMARIZE 阶段也允许重试 — force_exit nudge 刚注入时 LLM 可能
      // 需要额外一轮才能生成有效输出。与 ExplorationTracker 的 2 轮 grace 对齐，
      // 避免 grace 机制被架空。重试次数由 tracker.phaseRounds 控制而非独立计数。
      const isTerminal = ctx.tracker && ctx.tracker.phase === 'SUMMARIZE';
      if (isTerminal && ctx.tracker) {
        const phaseRounds = ctx.tracker.metrics?.phaseRounds ?? 0;
        if (phaseRounds < 2) {
          ctx.consecutiveEmptyResponses++;
          ctx.diagnostics?.recordEmptyRetry();
          this.logger.warn(
            `[AgentRuntime] ⚠ empty response in SUMMARIZE — retrying (grace ${phaseRounds + 1}/2)`
          );
          // 不 rollbackTick: 让 tracker 计入 phaseRounds 以便到达 grace 上限退出
          await new Promise((r) => setTimeout(r, 1500));
          return continueResult() as LLMResult;
        }
        this.logger.warn(
          '[AgentRuntime] ⚠ empty response in SUMMARIZE (grace exhausted) — proceeding to forced summary'
        );
        return null;
      }
      if (ctx.isSystem && ctx.consecutiveEmptyResponses < 2) {
        ctx.consecutiveEmptyResponses++;
        ctx.diagnostics?.recordEmptyRetry();
        this.logger.warn(
          `[AgentRuntime] ⚠ empty response — retrying (${ctx.consecutiveEmptyResponses}/2)`
        );
        ctx.tracker?.rollbackTick?.();
        await new Promise((r) => setTimeout(r, 1500));
        // 返回 CONTINUE 信号 — 调用方需重走循环
        return continueResult() as LLMResult;
      }
      return null; // 退出
    }
    if (llmResult.text || llmResult.functionCalls?.length) {
      ctx.consecutiveEmptyResponses = 0;
    }

    // Graceful exit 保护 — toolChoice=none 或 gracefulExit 状态下，
    // 部分 LLM (DeepSeek 等) 可能仍然返回 tool calls，需要忽略。
    // Analyst 的 RECORD 阶段会暴露 note_finding-only 补记录窗口，不能在这里丢弃。
    const isTerminalPhase = ctx.tracker?.phase === 'SUMMARIZE' || ctx.tracker?.phase === 'FINALIZE';
    const groundingBurn = getLatestPcvBurnGrounding(ctx.pcvNodeEvidence);
    const allowDeepSeekV4GroundingToolCalls =
      groundingBurn?.deepseekV4ToolChoiceMode === 'tools-visible-no-forced-tool-choice';
    if (
      (ctx.tracker?.isGracefulExit ||
        (toolChoice === 'none' && !allowDeepSeekV4GroundingToolCalls)) &&
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
   * AI 错误处理 — 熔断器感知 + 2-strike 策略
   * @returns continueResult() 或 null (退出)
   */
  async #handleAiError(ctx: LoopContext, aiErr: AiError): Promise<LLMResult | null> {
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
      this.logger.warn(
        `[AgentRuntime] 🛑 2 consecutive AI errors — breaking to summary ${formatLoopTrace(trace)}`
      );
      ctx.messages.resetToPromptOnly();
      if (!ctx.isSystem) {
        ctx.lastReply = `抱歉，AI 服务暂时不可用（${aiErr.message}）。请稍后重试，或检查 API 配置。`;
      }
      return null;
    }

    await new Promise((r) => setTimeout(r, 2000));
    return continueResult() as LLMResult;
  }

  /**
   * 工具调用处理 — 执行 + 记录 + 去重 + 阶段转换
   *
   * @param effectiveSystemPrompt 用于 budget 耗尽时的摘要调用
   * @returns true = 应退出循环
   */
  async #processToolCalls(ctx: LoopContext, llmResult: LLMResult, effectiveSystemPrompt: string) {
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
    messages.appendAssistantWithToolCalls(
      llmResult.text || null,
      activeCalls.map((call) => ({ ...call, args: { ...call.args } })),
      llmResult.reasoningContent
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

      const toolStartProcessEvent = buildAgentProcessEvent(ctx, {
        kind: 'tool',
        title: `Tool call started: ${fc.name}`,
        summary: `Calling tool ${fc.name}`,
        content: {
          role: 'developer',
          text: formatToolCallForDeveloperContent(fc.name, fc.args),
        },
        correlationId: fc.id,
        metadata: {
          toolName: fc.name,
          callId: fc.id,
          source: inferFunctionCallSource(fc),
          status: 'started',
        },
      });
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
      this.#hookSystem.emitSync('tool:execute:before', {
        toolId: fc.name,
        args: fc.args,
        callId: fc.id,
        processEvent: toolStartProcessEvent,
      });

      // 通过 Pipeline 执行 (safety → cache → execute → observe → track → trace → dedup)
      const { result: toolResult, metadata } = await this.#toolPipeline.execute(fc, {
        runtime: this,
        loopCtx: ctx,
        iteration: ctx.iteration,
      });

      const durationMs = metadata.durationMs;
      const envelope = (metadata as ToolMetadata).envelope;
      const toolEntry: ToolCallEntry = {
        tool: fc.name,
        args: fc.args,
        result: toolResult,
        envelope,
        durationMs,
      };
      (ctx.toolCalls as ToolCallEntry[]).push(toolEntry);
      this.toolCallHistory.push(toolEntry);

      if (metadata.isNew) {
        roundHasNewInfo = true;
      }
      roundToolNames.push(fc.name);

      // onToolCall 通知
      const effectiveHook = ctx.onToolCall || this.onToolCall;
      if (effectiveHook) {
        try {
          effectiveHook(fc.name, fc.args, toolResult, ctx.iteration);
        } catch {
          /* 观察者错误不中断 */
        }
      }

      const toolResultObj = toolResult as Record<string, unknown> | null;
      const toolSucceeded = envelope ? envelope.ok : !toolResultObj?.error;
      recordPcvToolResult(ctx.pcvNodeEvidence, fc, toolResult, envelope, { toolSucceeded });
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
      const rawForLimit = envelope || toolResult;
      let resultStr: string;
      if (isToolResultEnvelope(rawForLimit)) {
        resultStr = limitToolResult(fc.name, (rawForLimit as { text: string }).text, toolQuota);
      } else {
        resultStr = limitToolResult(fc.name, rawForLimit, toolQuota);
      }
      budgetCtrl.recordToolCharsUsed(resultStr.length);

      // 提交去重: pipeline 中间件已标记 metadata
      const dedupMessage = (metadata as ToolMetadata).dedupMessage;
      if (dedupMessage) {
        resultStr = dedupMessage;
      } else if ((metadata as ToolMetadata).isSubmit) {
        roundSubmitCount++;
      }

      const toolEndProcessEvent = buildAgentProcessEvent(ctx, {
        kind: 'tool',
        title: `Tool call ${toolSucceeded ? 'completed' : 'failed'}: ${fc.name}`,
        summary: `${fc.name} ${toolSucceeded ? 'completed' : 'failed'} in ${durationMs}ms`,
        content: {
          role: 'tool',
          text: redactDeveloperText(resultStr),
        },
        correlationId: fc.id,
        severity: toolSucceeded ? 'success' : 'error',
        metadata: {
          toolName: fc.name,
          callId: fc.id,
          status: toolSucceeded ? 'ok' : 'error',
          durationMs,
          resultSize: resultStr.length,
          cacheHit: metadata.cacheHit,
          cacheMiss: (metadata as ToolMetadata).cacheMiss === true,
          source: inferFunctionCallSource(fc),
        },
      });

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
      this.#hookSystem.emitSync('tool:execute:after', {
        toolId: fc.name,
        ok: toolSucceeded,
        durationMs,
        callId: fc.id,
        processEvent: toolEndProcessEvent,
      });

      // 追加 tool result
      messages.appendToolResult(fc.id, fc.name, resultStr);
    }

    recordPcvToolRoundOutcome(ctx.pcvNodeEvidence, {
      acceptedFindingDelta:
        ctx.pcvNodeEvidence.findingRefs.accepted.length - pcvBefore.acceptedFindingCount,
      evidenceToolCallDelta: activeCalls.filter((call) =>
        isEvidenceGroundingToolCall(call.name, call.args)
      ).length,
      rejectedFindingDelta:
        ctx.pcvNodeEvidence.findingRefs.rejected.length - pcvBefore.rejectedFindingCount,
      toolCallDelta: activeCalls.length,
    });

    if (truncatedCalls.length > 0) {
      const truncatedNames = truncatedCalls
        .map((call) => call.name)
        .slice(0, 5)
        .join(', ');
      messages.appendUserNudge(
        `工具调用数量超限：本轮只执行前 ${MAX_TOOL_CALLS_PER_ITER} 个工具调用，另有 ${truncatedCalls.length} 个未执行${truncatedNames ? `（${truncatedNames}${truncatedCalls.length > 5 ? '...' : ''}）` : ''}。请基于已返回结果继续，必要时分批重新请求未执行的工具。`
      );
    }

    // Lazy Loading: mark used tools as expanded for future rounds
    if (roundToolNames.length > 0) {
      this.#markToolsExpanded(roundToolNames);
    }

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
          process.stderr.write(`\x1b[33m${transitionNudge.text}\x1b[0m\n\n`);
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
      trace.endRound?.();
    }

    // Capability 后置钩子
    const stepToolEntries = ctx.toolCalls.slice(-activeCalls.length);
    const stepResult = {
      type: 'tool_calls',
      toolCalls: stepToolEntries,
      iteration: ctx.iteration,
    };
    for (const cap of ctx.capabilities) {
      cap.onAfterStep(stepResult);
    }

    this.#safeTransition('step_done', stepResult);

    // 检查预算 (非 tracker 模式)
    if (!tracker && ctx.iteration >= ctx.maxIterations) {
      const suppression = this.#getForcedSummarySuppression(ctx);
      if (suppression) {
        ctx.lastReply = this.#buildSuppressedSummaryReply(suppression);
        ctx.diagnostics?.warn({
          code: 'forced_summary_suppressed',
          message: suppression.message,
        });
        return true;
      }

      const summaryMessages = messages.toMessages() as import('#ai/AiProvider.js').UnifiedMessage[];
      // 方案①：强制摘要也统一走 aiProvider.chatWithTools（provider 内部委托 gateway）
      const summary: LLMResult = (await this.aiProvider.chatWithTools(ctx.prompt, {
        messages: summaryMessages,
        systemPrompt: effectiveSystemPrompt,
        toolChoice: 'none',
        temperature: ctx.budget.temperature ?? 0.7,
        maxTokens: ctx.budget.maxTokens ?? 4096,
      })) as LLMResult;
      if (summary.usage) {
        this.tokenUsage.input += summary.usage.inputTokens || 0;
        this.tokenUsage.output += summary.usage.outputTokens || 0;
        this.tokenUsage.reasoning += summary.usage.reasoningTokens || 0;
        this.tokenUsage.cacheHit += summary.usage.cacheHitTokens || 0;
        ctx.addTokenUsage(summary.usage);
        ctx.diagnostics?.recordTokenUsage(summary.usage);
      }
      ctx.diagnostics?.recordForcedSummary();
      ctx.lastReply = cleanFinalAnswer(summary.text || '');
      return true; // 退出
    }

    this.#safeTransition('continue');
    return false; // 继续循环
  }

  /**
   * 文本响应处理 — tracker 阶段路由 + 非 tracker 直接终止
   *
   * @returns true = 应退出循环
   */
  #processTextResponse(ctx: LoopContext, llmResult: LLMResult) {
    const { tracker, trace, messages } = ctx;

    if (tracker) {
      const groundingGate = this.#evaluateAnalyzeTextGroundingGate(ctx);
      if (groundingGate.block) {
        messages.appendAssistantText(llmResult.text || '', llmResult.reasoningContent);
        messages.appendUserNudge(groundingGate.nudge);
        tracker.rollbackTick?.();
        ctx.diagnostics?.warn({
          code: 'invalid_no_evidence_burn',
          message: groundingGate.reason,
          stage: ctx.context?.pipelinePhase as string | undefined,
        });
        this.logger.warn(
          `[AgentRuntime] invalid-no-evidence analyze burn blocked: ${groundingGate.reason}`
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
        trace?.endRound?.();
        return false;
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
        phaseBefore !== tracker.phase &&
        (tracker.phase === 'SUMMARIZE' || tracker.phase === 'FINALIZE');

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
          messages.appendAssistantText(llmResult.text || '', llmResult.reasoningContent);
          messages.appendUserNudge(digestNudge);
          ctx.diagnostics?.recordNudge({ type: 'digest' });
          this.#emitProcessProgress(
            buildSemanticNudgeProcessEvent(ctx, { type: 'digest', text: digestNudge })
          );
          this.logger.info(
            '[AgentRuntime] 📝 metrics-transition to terminal — injecting digest nudge'
          );
          trace?.endRound?.();
          return false; // continue — let agent produce a full summary
        }
      }

      if (textResult.isFinalAnswer) {
        ctx.lastReply = cleanFinalAnswer(llmResult.text || '');
        this.logger.info(
          `[AgentRuntime] ✅ final answer — ${ctx.lastReply.length} chars, ${tracker.iteration} iters, ${ctx.toolCalls.length} tool calls`
        );
        trace?.endRound?.();
        return true;
      }

      if (textResult.needsDigestNudge) {
        messages.appendAssistantText(llmResult.text || '', llmResult.reasoningContent);
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
          process.stderr.write(`\x1b[33m${textResult.nudge}\x1b[0m\n\n`);
        }
        trace?.endRound?.();
        return false; // continue
      }

      if (textResult.shouldContinue) {
        messages.appendAssistantText(llmResult.text || '', llmResult.reasoningContent);
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
            process.stderr.write(`\x1b[33m${textResult.nudge}\x1b[0m\n\n`);
          }
        }
        trace?.endRound?.();
        return false; // continue
      }
    }

    // 非 tracker 模式: 文字回答即最终回答
    ctx.lastReply = cleanFinalAnswer(llmResult.text || '');
    trace?.endRound?.();
    return true;
  }

  #evaluateAnalyzeTextGroundingGate(ctx: LoopContext): {
    block: boolean;
    nudge: string;
    reason: string;
  } {
    const burn = getLatestPcvBurnGrounding(ctx.pcvNodeEvidence);
    if (!burn || !isDeepSeekV4AnalyzeFirstGroundingBurn(ctx, this.#modelRef)) {
      return { block: false, nudge: '', reason: '' };
    }
    if (burn.classification !== 'invalid-no-evidence') {
      return { block: false, nudge: '', reason: '' };
    }
    const deterministicRefs = burn.deterministicEvidenceRefs.slice(0, 8);
    const refsHint =
      deterministicRefs.length > 0
        ? `请明确引用并消费这些 deterministicEvidenceRefs 中的相关项：${deterministicRefs.join(', ')}。`
        : '当前没有足够的 deterministicEvidenceRefs；请调用 code / graph / terminal 取得可复核代码证据。';
    return {
      block: true,
      reason:
        'DeepSeek V4 analyze burn returned text without deterministic evidence consumption, evidence tool calls, or finding delta.',
      nudge:
        '本轮 analyze 文本没有可观测证据 grounding，不能推进阶段。' +
        `${refsHint} 如果只是规划下一步，只输出取证计划并绑定 evidence refs；如果要推进事实结论，必须先产生或消费可复核证据。`,
    };
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

    if (cancelReason === 'stage_timeout' || (diagnostics?.timedOutStages?.length ?? 0) > 0) {
      return {
        code: 'stage_timeout',
        message: 'Run reached a stage timeout before a normal summary could be produced',
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

  /** 循环退出后处理 — 强制摘要 + 构建返回值 */
  async #finalize(ctx: LoopContext) {
    // Scan 管线: 所有结果在 toolCalls 中 (knowledge.submit)，不需要文本回复
    // 直接跳过 forced summary，避免浪费一次 LLM 调用
    if (!ctx.lastReply && ctx.tracker?.pipelineType === 'scan') {
      const recipeCount = ctx.toolCalls.filter(
        (tc: ToolCallEntry) => (tc.tool || tc.name) === 'knowledge'
      ).length;
      ctx.lastReply = `[scan complete: ${recipeCount} recipes collected]`;
    }

    // 强制摘要 — 循环结束后无文本回复时，生成摘要
    // 覆盖所有场景: 系统管线、tracker 管线、用户对话(有/无工具调用)
    if (!ctx.lastReply) {
      const suppression = this.#getForcedSummarySuppression(ctx);
      if (suppression) {
        ctx.lastReply = this.#buildSuppressedSummaryReply(suppression);
        ctx.diagnostics?.warn({
          code: 'forced_summary_suppressed',
          message: suppression.message,
        });
      } else if (ctx.toolCalls.length > 0 || ctx.tracker || ctx.isSystem) {
        const forcedResult = await produceForcedSummary({
          aiProvider: this.aiProvider,
          source: ctx.source,
          toolCalls: ctx.toolCalls,
          tracker: ctx.tracker ?? undefined,
          contextWindow: ctx.contextWindow,
          prompt: ctx.prompt,
          tokenUsage: this.tokenUsage,
        });
        ctx.lastReply = forcedResult.reply;
        ctx.diagnostics?.recordForcedSummary();
        if (forcedResult.tokenUsage) {
          this.tokenUsage.input += forcedResult.tokenUsage.input || 0;
          this.tokenUsage.output += forcedResult.tokenUsage.output || 0;
          ctx.addTokenUsage({
            inputTokens: forcedResult.tokenUsage.input || 0,
            outputTokens: forcedResult.tokenUsage.output || 0,
          });
          ctx.diagnostics?.recordTokenUsage({
            inputTokens: forcedResult.tokenUsage.input || 0,
            outputTokens: forcedResult.tokenUsage.output || 0,
          });
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

    this.#hookSystem.emitSync('agent:finalize', {
      reply: ctx.lastReply,
      iterations: ctx.iteration,
      toolCallCount: ctx.toolCalls.length,
    });

    return ctx.buildResult();
  }

  // ─── 公共工具方法 ────────────────────────────

  /** 中止执行 */
  abort(reason = 'User aborted') {
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

  /**
   * 安全状态转移 — 忽略不合法转移而不是抛异常。
   *
   * Pipeline/FanOut 场景下 reactLoop() 被多次调用,
   * 第 2+ 次调用时状态已不在 IDLE，直接 send('start') 会抛错。
   * 此方法在转移不合法时静默跳过，保证多阶段执行不中断。
   */
  #safeTransition(event: string, payload: Record<string, unknown> = {}) {
    try {
      this.state.send(event, payload);
    } catch {
      // 转移不合法 — 在多阶段场景中这是预期行为，静默跳过
    }
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
    const allowActions = (tool: string, actions: string[]) => {
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
      if (isActionAllowlist(allowedTools)) {
        for (const [tool, actions] of Object.entries(allowedTools)) {
          allowActions(tool, actions);
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

    const ids = [...actionMap.keys()];
    const actions: RuntimeToolActionAllowlist = {};
    const restrictedActions: Record<string, string[]> = {};
    for (const [tool, set] of actionMap.entries()) {
      if (set === null) {
        actions[tool] = null;
        continue;
      }
      const values = [...set];
      actions[tool] = values;
      restrictedActions[tool] = values;
    }
    return { actions, ids, restrictedActions };
  }

  #getToolSchemas(toolContract: RuntimeToolContract, model?: string): ToolSchemaProjection[] {
    const ids = toolContract.ids.map(String);
    const catalog = (this.container as { get?: (name: string) => unknown } | null)?.get?.(
      'capabilityCatalog'
    ) as
      | {
          toToolSchemas(ids?: readonly string[] | null): ToolSchemaProjection[];
          toToolSchemasForActions?(
            allowedTools?: RuntimeToolActionAllowlist | null,
            model?: string
          ): ToolSchemaProjection[];
          toToolSchemasForModel?(
            ids?: readonly string[] | null,
            model?: string
          ): ToolSchemaProjection[];
          toMixedSchemas?(
            ids?: readonly string[] | null,
            model?: string,
            firstRound?: boolean
          ): ToolSchemaProjection[];
          toMixedSchemasForActions?(
            allowedTools?: RuntimeToolActionAllowlist | null,
            model?: string,
            firstRound?: boolean
          ): ToolSchemaProjection[];
        }
      | undefined;
    // Lazy Loading: use mixed schemas (lightweight for unused tools)
    // firstRound = true when no tools have been expanded yet (first stage or fresh session)
    if (catalog?.toMixedSchemasForActions) {
      const expandedCount = (catalog as { expandedCount?: number }).expandedCount ?? 0;
      return catalog.toMixedSchemasForActions(toolContract.actions, model, expandedCount === 0);
    }
    if (catalog?.toToolSchemasForActions) {
      return catalog.toToolSchemasForActions(toolContract.actions, model);
    }
    if (catalog?.toMixedSchemas) {
      const expandedCount = (catalog as { expandedCount?: number }).expandedCount ?? 0;
      return catalog.toMixedSchemas(ids, model, expandedCount === 0);
    }
    if (model && catalog?.toToolSchemasForModel) {
      return catalog.toToolSchemasForModel(ids, model);
    }
    if (catalog?.toToolSchemas) {
      return catalog.toToolSchemas(ids);
    }
    return [];
  }

  /** Mark tools as expanded after use (for lazy loading) */
  #markToolsExpanded(toolNames: string[]): void {
    const catalog = (this.container as { get?: (name: string) => unknown } | null)?.get?.(
      'capabilityCatalog'
    ) as { markExpanded?(id: string): void } | undefined;
    if (catalog?.markExpanded) {
      for (const name of toolNames) {
        catalog.markExpanded(name);
      }
    }
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
    if (this.onProgress) {
      this.onProgress(event);
    }
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
      ? 'Record one structured, evidence-backed key finding. In RECORD/record-repair phase this is the only valid function; call it once per finding and do not output prose.'
      : 'Record one structured, evidence-backed key finding for QualityGate. Call it when a finding is verified; do not wait for the final Markdown report.',
    parameters: {
      type: 'object',
      properties: {
        finding: {
          type: 'string',
          description: 'Concrete, verifiable finding description.',
        },
        evidence: {
          type: 'string',
          description: 'Complete relative file path with line number/range, e.g. src/App.ts:42.',
        },
        importance: {
          type: 'number',
          description: 'Importance 1-10.',
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['finding', 'evidence', 'importance'],
      additionalProperties: false,
    },
  };
}

function isActionAllowlist(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (actions) => Array.isArray(actions) && actions.every((action) => typeof action === 'string')
  );
}

function buildAgentProcessEvent(
  ctx: LoopContext,
  input: {
    kind: AgentProgressProcessEvent['kind'];
    title: string;
    summary?: string | null;
    content?: AgentProgressProcessEvent['content'];
    correlationId?: string | null;
    metadata?: Record<string, unknown>;
    phase?: string | null;
    retention?: AgentProgressProcessEvent['retention'];
    severity?: AgentProgressProcessEvent['severity'];
    sourceClass?: AgentProgressProcessEvent['sourceClass'];
    displayPolicy?: AgentProgressProcessEvent['displayPolicy'];
  }
): AgentProgressProcessEvent {
  const dimensionMeta = asRecord(ctx.sharedState?._dimensionMeta);
  const phase =
    input.phase ??
    stringValue(ctx.context?.pipelinePhase) ??
    (typeof ctx.tracker?.phase === 'string' ? ctx.tracker.phase : null);
  return {
    content: input.content ?? null,
    correlationId: input.correlationId ?? null,
    createdAt: new Date().toISOString(),
    dimensionId:
      stringValue(dimensionMeta.id) ||
      stringValue(ctx.context?.dimensionId) ||
      stringValue(ctx.context?.dimId) ||
      null,
    displayPolicy: input.displayPolicy ?? 'full',
    kind: input.kind,
    metadata: sanitizeDeveloperData({
      iteration: ctx.iteration,
      source: ctx.source,
      pcvNodeEvidence: buildPcvNodeEvidenceProcessMetadata(ctx.pcvNodeEvidence),
      ...(input.metadata || {}),
    }) as Record<string, unknown>,
    phase,
    retention: input.retention ?? 'job-retained',
    severity: input.severity ?? 'info',
    sourceClass: input.sourceClass ?? 'developer-facing',
    summary: input.summary ?? null,
    targetName:
      stringValue(dimensionMeta.label) ||
      stringValue(dimensionMeta.targetName) ||
      stringValue(ctx.context?.targetName) ||
      null,
    title: input.title,
  };
}

function buildDeepSeekV4AnalyzeGroundingPolicy(
  ctx: LoopContext,
  modelRef: string,
  requestedToolChoice: string
): { keepToolSchemasVisible: boolean; mode: string | null } {
  if (!isDeepSeekV4AnalyzeFirstGroundingBurn(ctx, modelRef)) {
    return { keepToolSchemasVisible: false, mode: null };
  }
  if (requestedToolChoice !== 'none') {
    return { keepToolSchemasVisible: false, mode: 'tool-choice-filtered-by-provider-guard' };
  }
  return {
    keepToolSchemasVisible: true,
    mode: 'tools-visible-no-forced-tool-choice',
  };
}

function isDeepSeekV4AnalyzeFirstGroundingBurn(ctx: LoopContext, modelRef: string): boolean {
  if (!/deepseek.*v4|deepseek-v4/i.test(modelRef)) {
    return false;
  }
  const trackerPhase = typeof ctx.tracker?.phase === 'string' ? ctx.tracker.phase : '';
  const pipelineType =
    typeof ctx.tracker?.pipelineType === 'string' ? ctx.tracker.pipelineType : '';
  const pipelinePhase = stringValue(ctx.context?.pipelinePhase) || '';
  if (pipelineType !== 'analyst' && pipelinePhase !== 'analyze') {
    return false;
  }
  if (trackerPhase === 'SCAN') {
    return true;
  }
  const metrics = safeCall<Record<string, unknown>>(() => ctx.tracker?.getMetrics?.());
  const evidenceToolCallCount = Number(metrics?.evidenceToolCallCount || 0);
  const memoryFindingCount = Number(metrics?.memoryFindingCount || 0);
  return trackerPhase === 'EXPLORE' && evidenceToolCallCount === 0 && memoryFindingCount === 0;
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

function safeCall<T>(fn: () => T | null | undefined): T | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

type LlmOutputCompletenessStatus =
  | 'visible_text_complete'
  | 'provider_truncated'
  | 'tool_call_only'
  | 'empty';

interface LlmOutputCompletenessMetadata extends Record<string, unknown> {
  agentOutputTruncated: false;
  developerContentChars: number;
  finishReason: string | null;
  functionCallCount: number;
  functionCallNames: string[];
  hasHiddenReasoningContent: boolean;
  hasText: boolean;
  outputCompleteness: LlmOutputCompletenessStatus;
  providerOutputTruncated: boolean;
  reasoningContentChars: number;
  reasoningContentOmitted: boolean;
  reasoningTokens: number;
  textChars: number;
  usage: LLMResult['usage'] | null;
  visibleTextChars: number;
}

function buildLlmOutputCompletenessMetadata(
  result: LLMResult,
  developerContentText: string
): LlmOutputCompletenessMetadata {
  const visibleTextChars = result.text?.length || 0;
  const functionCalls = result.functionCalls || [];
  const functionCallCount = functionCalls.length;
  const reasoningContentChars = result.reasoningContent?.length || 0;
  const reasoningTokens = result.usage?.reasoningTokens || 0;
  const finishReason = normalizeFinishReason(result.finishReason);
  const providerOutputTruncated = isProviderOutputTruncated(finishReason);
  const reasoningContentOmitted = reasoningContentChars > 0 || reasoningTokens > 0;

  return {
    agentOutputTruncated: false,
    developerContentChars: developerContentText.length,
    finishReason,
    functionCallCount,
    functionCallNames: functionCalls.map((call) => call.name).slice(0, 12),
    hasHiddenReasoningContent: reasoningContentOmitted,
    hasText: visibleTextChars > 0,
    outputCompleteness: providerOutputTruncated
      ? 'provider_truncated'
      : visibleTextChars > 0
        ? 'visible_text_complete'
        : functionCallCount > 0
          ? 'tool_call_only'
          : 'empty',
    providerOutputTruncated,
    reasoningContentChars,
    reasoningContentOmitted,
    reasoningTokens,
    textChars: visibleTextChars,
    usage: result.usage || null,
    visibleTextChars,
  };
}

function formatLlmOutputSummary(
  result: LLMResult,
  metadata: LlmOutputCompletenessMetadata
): string {
  if (metadata.visibleTextChars > 0) {
    const suffixes: string[] = [];
    if (metadata.providerOutputTruncated) {
      suffixes.push(`provider stopped with finishReason=${metadata.finishReason}`);
    }
    if (metadata.reasoningContentOmitted) {
      suffixes.push('hidden reasoning omitted');
    }
    return [`Received ${metadata.visibleTextChars} visible character(s)`, ...suffixes].join('; ');
  }
  if (metadata.functionCallCount > 0) {
    return `Received ${metadata.functionCallCount} tool call(s) without visible text`;
  }
  if (metadata.providerOutputTruncated) {
    return `Received empty LLM output; provider stopped with finishReason=${metadata.finishReason}`;
  }
  return `Received empty LLM output from provider${result.finishReason ? ` (finishReason=${result.finishReason})` : ''}`;
}

function normalizeFinishReason(finishReason: string | null | undefined): string | null {
  const normalized = finishReason?.trim();
  return normalized ? normalized : null;
}

function isProviderOutputTruncated(finishReason: string | null): boolean {
  if (!finishReason) {
    return false;
  }
  return new Set(['length', 'max_tokens', 'max_output_tokens']).has(finishReason.toLowerCase());
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
  const semanticKind = options.semanticKind ?? classifySemanticNudgeKind(nudge.type);
  const title = formatSemanticNudgeTitle(nudge, semanticKind, phase);
  return buildAgentProcessEvent(ctx, {
    kind: 'llm.reflection',
    title,
    summary: formatSemanticNudgeSummary(nudge, semanticKind, phase),
    phase,
    content: {
      role: 'developer',
      text: redactDeveloperText(nudge.text),
    },
    metadata: {
      dimensionId,
      nudgeType: nudge.type,
      phase,
      pipelineType,
      semanticKind,
      source: ctx.source,
      targetName,
    },
  });
}

function classifySemanticNudgeKind(type: string): string {
  switch (type) {
    case 'transition':
      return 'transition-nudge';
    case 'digest':
      return 'digest-nudge';
    case 'continue':
      return 'continue-nudge';
    case 'planning':
    case 'replan':
      return 'planning-nudge';
    case 'convergence':
      return 'convergence-nudge';
    default:
      return 'reflection-nudge';
  }
}

function formatSemanticNudgeTitle(
  nudge: { type: string; text: string },
  semanticKind: string,
  phase: string | null
): string {
  if (semanticKind === 'transition-nudge') {
    return phase ? `Agent 阶段转换 Nudge: ${phase}` : 'Agent 阶段转换 Nudge';
  }
  if (semanticKind === 'digest-nudge') {
    return 'Agent 总结 Nudge';
  }
  if (semanticKind === 'continue-nudge') {
    return 'Agent 继续执行 Nudge';
  }
  if (semanticKind === 'planning-nudge') {
    return nudge.type === 'replan' ? 'Agent 重新计划 Nudge' : 'Agent 计划检查 Nudge';
  }
  if (semanticKind === 'convergence-nudge') {
    return 'Agent 收敛检查 Nudge';
  }
  if (nudge.text.includes('停滞反思')) {
    return 'Agent 停滞反思';
  }
  if (nudge.text.includes('中期反思')) {
    return 'Agent 中期反思';
  }
  return 'Agent 反思 Nudge';
}

function formatSemanticNudgeSummary(
  nudge: { type: string; text: string },
  semanticKind: string,
  phase: string | null
): string {
  if (semanticKind === 'transition-nudge') {
    return phase ? `阶段机切换后注入 ${phase} 阶段指令。` : '阶段机切换后注入下一阶段指令。';
  }
  if (semanticKind === 'digest-nudge') {
    return '要求 Agent 停止探索并产出 dimensionDigest 或最终分析摘要。';
  }
  if (semanticKind === 'continue-nudge') {
    return '要求 Agent 基于当前回复继续推进，而不是结束本轮执行。';
  }
  if (nudge.text.includes('停滞反思')) {
    return '检测到连续无新信息，注入停滞反思。';
  }
  if (nudge.text.includes('中期反思')) {
    return '达到中期预算节点，注入阶段性反思。';
  }
  return `Injected ${nudge.type} semantic nudge before the next LLM step.`;
}

const DEFAULT_LLM_INPUT_TOKEN_LIMIT = 128_000;
const LLM_INPUT_TOO_LARGE_CODE = 'LLM_INPUT_TOO_LARGE';

function validateLlmInputSize(
  ctx: LoopContext,
  measurement: LLMInputAssemblyMeasurement
):
  | { ok: true }
  | {
      ok: false;
      code: typeof LLM_INPUT_TOO_LARGE_CODE;
      estimatedTokens: number;
      maxTokens: number;
      message: string;
    } {
  const maxTokens = resolveLlmInputTokenLimit(ctx);
  if (measurement.estimatedTokens <= maxTokens) {
    return { ok: true };
  }
  return {
    ok: false,
    code: LLM_INPUT_TOO_LARGE_CODE,
    estimatedTokens: measurement.estimatedTokens,
    maxTokens,
    message: `LLM input exceeds provider input budget (${measurement.estimatedTokens}/${maxTokens} tokens)`,
  };
}

function resolveLlmInputTokenLimit(ctx: LoopContext): number {
  const budget = ctx.budget || {};
  const explicit = readPositiveBudgetNumber(
    budget.maxProviderInputTokens ?? budget.maxInputTokens ?? budget.contextWindowTokens
  );
  return explicit ?? DEFAULT_LLM_INPUT_TOKEN_LIMIT;
}

function readPositiveBudgetNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

function recordAbortRecoveryDiagnostic(ctx: LoopContext, message: string): void {
  ctx.diagnostics?.warn({
    code: 'ABORT_RECOVERY_RECORDED',
    message,
  });
}

function formatDeveloperVisibleLlmInput(assembly: LLMInputAssembly): string {
  const sections = assembly.sections.map((section) => {
    const suffix = section.staticCacheable ? ' (static)' : '';
    return `## ${section.title}${suffix}\n${redactDeveloperText(section.content)}`;
  });
  sections.push(
    [
      '## Messages',
      ...assembly.messages.map((message, index) => formatDeveloperVisibleMessage(message, index)),
    ].join('\n\n')
  );
  if (assembly.inputLayerMessage) {
    sections.push(
      `## Provider runtime layer\n${redactDeveloperText(assembly.inputLayerMessage.content || '')}`
    );
  }
  if (assembly.tools?.length) {
    sections.push(
      [
        '## Available tools',
        ...assembly.tools.map((tool) =>
          [
            `### ${tool.name}`,
            tool.description ? redactDeveloperText(tool.description) : null,
            tool.parameters ? `parameters:\n${stringifyDeveloperData(tool.parameters)}` : null,
          ]
            .filter(Boolean)
            .join('\n')
        ),
      ].join('\n\n')
    );
  }
  return sections.join('\n\n');
}

function formatDeveloperVisibleMessage(
  message: import('#ai/AiProvider.js').UnifiedMessage,
  index: number
): string {
  const lines = [`### ${index + 1}. ${message.role}${message.name ? ` (${message.name})` : ''}`];
  if (message.content) {
    lines.push(redactDeveloperText(message.content));
  }
  if (message.toolCalls?.length) {
    lines.push(
      [
        'tool calls:',
        ...message.toolCalls.map(
          (call) => `- ${call.name} (${call.id}): ${stringifyDeveloperData(call.args)}`
        ),
      ].join('\n')
    );
  }
  if (message.toolCallId) {
    lines.push(`toolCallId: ${message.toolCallId}`);
  }
  if (message.reasoningContent) {
    lines.push('[hidden reasoning omitted]');
  }
  return lines.join('\n');
}

function formatFunctionCallsForDeveloperContent(
  calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
): string {
  if (calls.length === 0) {
    return '';
  }
  return [
    'LLM requested tool calls:',
    ...calls.map(
      (call) =>
        `- ${call.name || 'unknown'} (${call.id || 'no-id'}): ${stringifyDeveloperData(call.args || {})}`
    ),
  ].join('\n');
}

function formatToolCallForDeveloperContent(toolName: string, args: Record<string, unknown>) {
  return [`tool: ${toolName}`, 'args:', stringifyDeveloperData(args)].join('\n');
}

function isDeveloperVisibleReflectionNudge(type: string): boolean {
  return (
    type === 'reflection' ||
    type === 'planning' ||
    type === 'replan' ||
    type === 'convergence' ||
    type === 'digest' ||
    type === 'continue'
  );
}

function inferFunctionCallSource(call: { id?: string }) {
  // DeepSeek 文本兼容桥会生成 call_deepseek_compat_*。这类调用可以写入
  // ActiveContext，但不能被当作 provider native tool_calls 证据。
  return call.id?.startsWith('call_deepseek_compat_')
    ? 'deepseek_text_compat'
    : 'native_or_provider_tool_call';
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

function stringifyDeveloperData(value: unknown): string {
  try {
    if (value === undefined) {
      return 'undefined';
    }
    return JSON.stringify(sanitizeDeveloperData(value), null, 2);
  } catch {
    return redactDeveloperText(String(value));
  }
}

function sanitizeDeveloperData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactDeveloperText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDeveloperData(item, seen));
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    output[key] =
      isSecretLikeKey(key) && !isSafeNumericTokenMetric(key, child)
        ? '[redacted]'
        : sanitizeDeveloperData(child, seen);
  }
  return output;
}

function redactDeveloperText(text: string): string {
  return text
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-api-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted-token]')
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
      '$1[redacted]'
    );
}

function isSecretLikeKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|authorization|credential/i.test(key);
}

function isSafeNumericTokenMetric(key: string, value: unknown): boolean {
  // token 计数是 developer-safe 观测指标；真实 token / key 字段仍按 isSecretLikeKey 脱敏。
  return (
    typeof value === 'number' &&
    /^(inputTokens|outputTokens|totalTokens|reasoningTokens|cacheHitTokens)$/.test(key)
  );
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
