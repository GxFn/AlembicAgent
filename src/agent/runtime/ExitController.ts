/**
 * ExitController — ReAct 循环的退出决策
 *
 * AgentRuntime 实际接线的检查点只有三个：
 *   - checkBeforeIteration ← AgentRuntime.#shouldExit（每轮开始：abort → 阶段超时 → tracker
 *     → 无 tracker 时的轮数上限 → policy，见方法内 P1–P5 标注）
 *   - checkAfterLLM        ← AgentRuntime.#callLLM 的空响应分支（SUMMARIZE grace 与 system 场景重试）
 *   - checkAfterToolCalls  ← AgentRuntime.#processToolCalls 末尾（无 tracker 时的轮数上限）
 *
 * 下列退出路径仍由 AgentRuntime 内联处理，不经过本类：
 *   - AI 错误（abort / CIRCUIT_OPEN / 连续两次错误）：AgentRuntime.#handleAiError
 *   - toolChoice=none 或 graceful exit 下仍返回工具调用：AgentRuntime.#callLLM
 *   - 文本终答、digest nudge、继续探索：AgentRuntime.#processTextResponse
 *   checkAfterAiError / checkAfterTextResponse / checkToolChoiceViolation 是与上述内联逻辑平行的
 *   公开方法，目前没有被 AgentRuntime 调用；改退出语义时必须同时改内联路径，只改这里不会生效。
 *
 * 设计原则：
 *   - 每个检查点按固定顺序判定，返回结构化 ExitSignal 而非分散的 boolean/null
 *   - 保留 ExplorationTracker 的 phase/grace 语义（tick / shouldExit / forceTerminal 由本类触发）
 *
 * @module agent/runtime/ExitController
 */

import type { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { StepState } from '../policies/Policy.js';
import type { LoopContext } from './LoopContext.js';

// ── Public Types ──

export type ExitReason =
  | 'abort_signal'
  | 'tracker_exit'
  | 'stage_timeout'
  | 'policy_stop'
  | 'iteration_exhausted'
  | 'token_budget_exhausted'
  | 'task_complete'
  | 'empty_response'
  | 'empty_response_terminal'
  | 'error_accumulated'
  | 'circuit_open'
  | 'tool_choice_violation';

export interface ExitSignal {
  action: 'continue' | 'exit' | 'graceful_exit' | 'retry';
  reason?: ExitReason;
  /** Whether #finalize should produce a forced summary */
  needsSummary?: boolean;
  /** Text to inject into message stream (digest/phase_transition nudge) */
  nudge?: string | null;
  /** Details for logging/diagnostics */
  detail?: string;
}

export interface ExitControllerConfig {
  tracker?: ExplorationTracker | null;
  /**
   * 阶段超时：工厂只传入 ctx.budget.timeoutMs，0 表示不启用。
   * 策略级超时（BudgetPolicy.timeoutMs）不在这里合并，而是经 validateDuring 在 P5 分支判定。
   */
  effectiveTimeoutMs: number;
  abortSignal?: AbortSignal | null;
  /** Policy validateDuring callback */
  validateDuring: (stepState: StepState) => { ok: boolean; action?: string; reason?: string };
  /** Whether tracker mode should bypass policy iteration check */
  skipPolicyIterCheck: boolean;
  loopStartTime: number;
  maxIterations: number;
}

const CONTINUE: ExitSignal = { action: 'continue' };

/**
 * Centralized exit-decision engine for the ReAct loop.
 *
 * Usage:
 *   const exitCtrl = new ExitController(config);
 *   // beginning of each iteration:
 *   const signal = exitCtrl.checkBeforeIteration(ctx, runtimeTokenUsage);
 *   if (signal.action !== 'continue') break;
 */
export class ExitController {
  readonly #tracker: ExplorationTracker | null;
  readonly #effectiveTimeoutMs: number;
  readonly #abortSignal: AbortSignal | null;
  readonly #validateDuring: ExitControllerConfig['validateDuring'];
  readonly #skipPolicyIterCheck: boolean;
  readonly #loopStartTime: number;
  readonly #maxIterations: number;

  /** token 超限后是否已给过一次 graceful 机会 */
  #tokenGraceFired = false;

  constructor(config: ExitControllerConfig) {
    this.#tracker = config.tracker ?? null;
    this.#effectiveTimeoutMs = config.effectiveTimeoutMs;
    this.#abortSignal = config.abortSignal ?? null;
    this.#validateDuring = config.validateDuring;
    this.#skipPolicyIterCheck = config.skipPolicyIterCheck;
    this.#loopStartTime = config.loopStartTime;
    this.#maxIterations = config.maxIterations;
  }

  #isTrackerTerminal(): boolean {
    if (!this.#tracker) {
      return false;
    }
    return this.#tracker.isGracefulExit || this.#tracker.isHardExit;
  }

  // ── 1. Pre-iteration check (replaces #shouldExit) ──

  checkBeforeIteration(
    ctx: LoopContext,
    runtimeTokenUsage: { input: number; output: number }
  ): ExitSignal {
    // P1: abort signal — 最高优先级，早于一切预算判定
    if (this.#abortSignal?.aborted) {
      return {
        action: 'exit',
        reason: 'abort_signal',
        needsSummary: false,
        detail: 'AbortSignal fired before iteration',
      };
    }

    // P2: 阶段超时（effectiveTimeoutMs<=0 表示不启用）；先于 tracker.tick，超时轮不计入 tracker 轮次
    const elapsed = Date.now() - this.#loopStartTime;
    if (this.#effectiveTimeoutMs > 0 && elapsed > this.#effectiveTimeoutMs) {
      return {
        action: 'exit',
        reason: 'stage_timeout',
        needsSummary: false,
        detail: `${this.#effectiveTimeoutMs}ms exceeded (elapsed: ${elapsed}ms)`,
      };
    }

    // P3: tracker exit（tracker 自管 iteration/grace 逻辑）
    if (this.#tracker) {
      this.#tracker.tick();
      if (this.#tracker.shouldExit()) {
        return {
          action: 'exit',
          reason: 'tracker_exit',
          needsSummary: true,
          detail: `phase=${this.#tracker.phase}, iter=${this.#tracker.iteration}, submits=${this.#tracker.totalSubmits}`,
        };
      }
    }

    // P4: 无 tracker 时也必须执行本 loop 的上限；工具选择违规和重试路径未必经过 post-tool gate。
    if (!this.#tracker && ctx.iteration > this.#maxIterations) {
      return {
        action: 'exit',
        reason: 'iteration_exhausted',
        needsSummary: true,
        detail: `completed ${ctx.iteration - 1} rounds; maxIterations=${this.#maxIterations}`,
      };
    }

    // P5: policy validation（含 token 预算；token 超限首次只给一轮 grace，见下方）
    const duringCheck = this.#validateDuring({
      // Policy 接收已完成的轮数；当前轮在调用前已加一，不能用它提前消耗第一轮预算。
      iteration: this.#skipPolicyIterCheck ? 0 : Math.max(0, ctx.iteration - 1),
      startTime: this.#loopStartTime,
      totalTokens: runtimeTokenUsage.input + runtimeTokenUsage.output,
      totalInputTokens: runtimeTokenUsage.input,
    } as StepState);
    if (!duringCheck.ok) {
      const reasonStr = typeof duringCheck.reason === 'string' ? duringCheck.reason : '';
      const isTokenIssue = reasonStr.includes('token');

      // Token 超限 + 首次触发 + tracker 未在终结阶段 → graceful exit
      // 给 tracker 一次机会完成 SUMMARIZE，避免直接硬杀丢失已有分析
      if (isTokenIssue && !this.#tokenGraceFired && this.#tracker && !this.#isTrackerTerminal()) {
        this.#tokenGraceFired = true;
        this.#tracker.forceTerminal(reasonStr);
        return {
          action: 'continue',
          reason: 'token_budget_exhausted',
          detail: `${reasonStr} — forced SUMMARIZE, allowing one final round`,
        };
      }

      return {
        action: 'exit',
        reason: isTokenIssue ? 'token_budget_exhausted' : 'policy_stop',
        needsSummary: true,
        detail: reasonStr || 'Policy stopped the run',
      };
    }

    return CONTINUE;
  }

  // ── 2. Post-LLM check (replaces null-return paths in #callLLM) ──

  checkAfterLLM(
    llmResult: { text?: string | null; functionCalls?: unknown[] | null } | null,
    ctx: LoopContext
  ): ExitSignal {
    if (!llmResult) {
      return { action: 'exit', reason: 'empty_response', needsSummary: true };
    }

    const hasText = !!llmResult.text;
    const hasCalls = (llmResult.functionCalls?.length ?? 0) > 0;

    if (!hasText && !hasCalls) {
      // SUMMARIZE grace
      const isTerminal = this.#tracker?.phase === 'SUMMARIZE';
      if (isTerminal && this.#tracker) {
        // ExplorationTracker 公开 getter metrics 已含 phaseRounds；直接读取让字段改名在编译期暴露。
        const phaseRounds = this.#tracker.metrics.phaseRounds;
        if (phaseRounds < 2) {
          return {
            action: 'retry',
            reason: 'empty_response_terminal',
            detail: `grace ${phaseRounds + 1}/2`,
          };
        }
        return {
          action: 'exit',
          reason: 'empty_response_terminal',
          needsSummary: true,
          detail: 'grace exhausted',
        };
      }
      if (ctx.isSystem && ctx.consecutiveEmptyResponses < 2) {
        return {
          action: 'retry',
          reason: 'empty_response',
          detail: `retry ${ctx.consecutiveEmptyResponses + 1}/2`,
        };
      }
      return { action: 'exit', reason: 'empty_response', needsSummary: true };
    }

    return CONTINUE;
  }

  // ── 3. AI error check (replaces #handleAiError exit paths) ──

  checkAfterAiError(aiErr: { code?: string; message?: string }, ctx: LoopContext): ExitSignal {
    if (this.#abortSignal?.aborted) {
      return {
        action: 'exit',
        reason: 'abort_signal',
        detail: 'AbortSignal fired during LLM call',
      };
    }

    if (aiErr.code === 'CIRCUIT_OPEN') {
      return { action: 'exit', reason: 'circuit_open', detail: aiErr.message };
    }

    if (ctx.consecutiveAiErrors >= 2) {
      return {
        action: 'exit',
        reason: 'error_accumulated',
        needsSummary: true,
        detail: `${ctx.consecutiveAiErrors} consecutive AI errors`,
      };
    }

    return {
      action: 'retry',
      reason: 'error_accumulated',
      detail: `attempt ${ctx.consecutiveAiErrors}`,
    };
  }

  // ── 4. Post-tool-calls check (replaces #processToolCalls exit path) ──

  checkAfterToolCalls(ctx: LoopContext): ExitSignal {
    if (!this.#tracker && ctx.iteration >= this.#maxIterations) {
      return {
        action: 'exit',
        reason: 'iteration_exhausted',
        needsSummary: true,
        detail: `iteration ${ctx.iteration} >= maxIterations ${this.#maxIterations}`,
      };
    }
    return CONTINUE;
  }

  // ── 5. Post-text check (replaces #processTextResponse exit paths) ──

  checkAfterTextResponse(
    textResult: {
      isFinalAnswer: boolean;
      needsDigestNudge: boolean;
      shouldContinue: boolean;
      nudge: string | null;
    } | null,
    metricsTransitionedToTerminal: boolean,
    _ctx: LoopContext
  ): ExitSignal {
    if (!textResult) {
      return { action: 'exit', reason: 'task_complete' };
    }

    if (metricsTransitionedToTerminal && textResult.isFinalAnswer) {
      return {
        action: 'graceful_exit',
        reason: 'task_complete',
        nudge: null, // caller should generate analyst-specific digest nudge
        detail: 'metrics-transition to terminal — inject digest nudge',
      };
    }

    if (textResult.isFinalAnswer) {
      return { action: 'exit', reason: 'task_complete' };
    }

    if (textResult.needsDigestNudge) {
      return {
        action: 'continue',
        nudge: textResult.nudge,
        detail: 'digest nudge injected',
      };
    }

    if (textResult.shouldContinue) {
      return {
        action: 'continue',
        nudge: textResult.nudge,
      };
    }

    return { action: 'exit', reason: 'task_complete' };
  }

  // ── 6. Graceful exit: toolChoice violation check ──

  checkToolChoiceViolation(llmResult: {
    text?: string | null;
    functionCalls?: unknown[] | null;
  }): ExitSignal {
    const isTerminal = this.#tracker?.phase === 'SUMMARIZE';
    const isGraceful = this.#tracker?.isGracefulExit;

    if (
      (isGraceful || isTerminal) &&
      llmResult.functionCalls?.length &&
      llmResult.functionCalls.length > 0
    ) {
      if (llmResult.text) {
        return {
          action: 'exit',
          reason: 'tool_choice_violation',
          detail: `AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none — using text as final answer`,
        };
      }
      return {
        action: 'retry',
        reason: 'tool_choice_violation',
        detail: `AI returned ${llmResult.functionCalls.length} tool calls despite toolChoice=none — no text, retrying`,
      };
    }

    return CONTINUE;
  }
}

// ── Factory ──

export function createExitController(
  ctx: LoopContext,
  policies: {
    validateDuring: (stepState: StepState) => { ok: boolean; action?: string; reason?: string };
  }
): ExitController {
  const tracker = ctx.tracker;
  const stageTimeoutMs = ctx.budget?.timeoutMs ?? 0;

  const stageSessionBudget = (ctx.budget?.maxSessionInputTokens as number) || 0;
  const hasStageSessionLimit = stageSessionBudget > 0;

  const boundValidate = policies.validateDuring.bind(policies);
  const validateDuring = hasStageSessionLimit
    ? boundValidate
    : (stepState: StepState) => {
        const result = boundValidate(stepState);
        if (!result.ok && typeof result.reason === 'string' && result.reason.includes('session')) {
          return { ok: true, action: 'continue' };
        }
        return result;
      };

  return new ExitController({
    tracker,
    effectiveTimeoutMs: stageTimeoutMs,
    abortSignal: ctx.abortSignal,
    validateDuring,
    skipPolicyIterCheck: !!tracker,
    loopStartTime: ctx.loopStartTime,
    maxIterations: ctx.maxIterations,
  });
}
