/**
 * ExitController — ReAct 循环的退出决策
 *
 * AgentRuntime 实际接线的检查点只有三个：
 *   - checkBeforeIteration ← AgentRuntime.#shouldExit（每轮开始：abort → 有效超时 → tracker
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
 *   - 带 code 的策略拒绝只按结构化 code 分类（I03），reason 文本只用于展示：
 *       budget_session_tokens / budget_session_input_tokens → token_budget_exhausted（含一次 grace）
 *       budget_timeout → stage_timeout（与 P2 同语义，不要求摘要）
 *       其它 code → policy_stop
 *   - 无 code 的拒绝走兼容回退（code 是可选字段）：按改造前的 reason 判定（含 "token" →
 *     token_budget_exhausted，否则 policy_stop），每个策略每个 loop 发一次 policy_decision_without_code
 *     诊断（只含策略名与 reason）。兼容回退只恢复分类，不恢复旧的 "session" 子串屏蔽。
 *   - 超时只有一个有效值：createExitController 取阶段超时与策略超时的较小正值
 *     （resolveEffectiveTimeoutMs + readPolicyTimeoutMs），AgentRuntime 的强制摘要抑制复用同一组函数；
 *     策略超时更紧时工厂打 effective_timeout_from_policy 日志。
 *   - 阶段未声明 maxSessionInputTokens 时只屏蔽 budget_session_input_tokens（会话 input 预算归阶段），
 *     屏蔽写 policy_session_limit_bypassed 诊断并继续评估后续策略；其它拒绝一律照常生效。
 *
 * @module agent/runtime/ExitController
 */

import Logger from '@alembic/core/logging';
import type { ExplorationTracker } from '../context/ExplorationTracker.js';
import { BUDGET_POLICY_CODES } from '../policies/BudgetPolicy.js';
import type { Policy, PolicyDuringDecision, StepState } from '../policies/Policy.js';
import { PolicyEngine } from '../policies/PolicyEngine.js';
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
   * 有效超时（0 表示不启用）。createExitController 传入阶段超时（ctx.budget.timeoutMs）与
   * 策略超时（PolicyEngine 中 BudgetPolicy.timeoutMs）的较小正值，两者共用 loopStartTime，
   * 所以策略超时先到时在 P2 命中 stage_timeout，而不是在 P5 被当作 policy_stop。
   */
  effectiveTimeoutMs: number;
  abortSignal?: AbortSignal | null;
  /** Policy validateDuring callback；拒绝按可选结构化 code 分类（见 PolicyDuringDecision）。 */
  validateDuring: (stepState: StepState) => PolicyDuringDecision;
  /** Whether tracker mode should bypass policy iteration check */
  skipPolicyIterCheck: boolean;
  loopStartTime: number;
  maxIterations: number;
}

const CONTINUE: ExitSignal = { action: 'continue' };

/** 会话 token 预算类 code：命中时走 token_budget_exhausted（tracker 未终结时先给一次 grace）。 */
const TOKEN_BUDGET_CODES: ReadonlySet<string> = new Set([
  BUDGET_POLICY_CODES.sessionTokens,
  BUDGET_POLICY_CODES.sessionInputTokens,
]);

/**
 * 由阶段预算接管的策略 code：阶段预算未声明对应上限时，createExitController 屏蔽这类拒绝。
 *
 * 只有会话 input 预算属于阶段一侧（阶段 budget.maxSessionInputTokens 由 BudgetController 执行）。
 * budget_session_tokens 不在其中：BudgetController 不执行 maxSessionTokens，屏蔽它会让该上限
 * 在全链路静默失效，所以策略层配置的总量上限照常生效（字段待事项②删除）。
 */
const STAGE_OWNED_SESSION_CODES: ReadonlySet<string> = new Set([
  BUDGET_POLICY_CODES.sessionInputTokens,
]);

const POLICY_SESSION_LIMIT_BYPASSED = 'policy_session_limit_bypassed';

const POLICY_DECISION_WITHOUT_CODE = 'policy_decision_without_code';

/** 拒绝来源无法归属到具体策略时（直接构造 ExitController、非标准 PolicyEngine 源）使用的策略名。 */
const UNKNOWN_POLICY_NAME = 'unknown';

/**
 * 拒绝决策 → 产生它的策略名。只由 createExitController 的逐条评估包装写入，
 * ExitController 在无 code 兼容回退的诊断里读取；模块私有，不进入任何公开类型（不新增公开字段）。
 * 用 WeakMap 按决策对象归属：决策只在本轮判定中使用，随对象回收，不会累积。
 */
const decisionPolicyNames = new WeakMap<object, string>();

/**
 * 策略展示名：优先 Policy.name；基类 name getter 未被子类实现时会抛错，此时退回构造函数名，
 * 让诊断仍能指出是哪个策略（退回后的名字直接出现在诊断与 warn 日志里，可据此定位）。
 */
function describePolicyName(policy: Policy): string {
  try {
    const declared = policy.name;
    if (typeof declared === 'string' && declared.length > 0) {
      return declared;
    }
  } catch (err: unknown) {
    Logger.getInstance().debug(
      `[ExitController] policy name getter threw (${err instanceof Error ? err.message : String(err)}); ` +
        `falling back to constructor name ${policy.constructor.name || 'Policy'}`
    );
  }
  return policy.constructor.name || 'Policy';
}

function attributeDecision(decision: PolicyDuringDecision, policy: Policy): PolicyDuringDecision {
  if (typeof decision === 'object' && decision !== null) {
    decisionPolicyNames.set(decision, describePolicyName(policy));
  }
  return decision;
}

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

  /** 本 loop 已报告过无 code 决策的策略名：每个策略只发一次诊断，grace 后的再次拒绝不重复刷。 */
  readonly #codelessReported = new Set<string>();

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

    // P2: 有效超时（阶段/策略较小正值，<=0 表示不启用）；先于 tracker.tick，超时轮不计入 tracker 轮次
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

    // P5: policy validation（带 code 按结构化 code 分类，无 code 走兼容回退；token 超限首次只给一轮 grace）
    const duringCheck = this.#validateDuring({
      // Policy 接收已完成的轮数；当前轮在调用前已加一，不能用它提前消耗第一轮预算。
      iteration: this.#skipPolicyIterCheck ? 0 : Math.max(0, ctx.iteration - 1),
      startTime: this.#loopStartTime,
      totalTokens: runtimeTokenUsage.input + runtimeTokenUsage.output,
      totalInputTokens: runtimeTokenUsage.input,
    } as StepState);
    if (!duringCheck.ok) {
      const reasonStr = typeof duringCheck.reason === 'string' ? duringCheck.reason : '';
      // 空串与非字符串都视为“未带 code”，走下方兼容回退。
      const code =
        typeof duringCheck.code === 'string' && duringCheck.code.length > 0
          ? duringCheck.code
          : undefined;

      let isTokenIssue: boolean;
      if (code !== undefined) {
        // 策略超时：工厂已把它并入 P2 的有效超时，正常不会走到这里；P2 与策略各自取一次 Date.now()，
        // 同毫秒边界上可能只有策略先判超时。按 stage_timeout 收口（不要求摘要），与 P2 语义一致，
        // 让 AgentRuntime 记录 cancelReason/timedOutStages 并抑制强制摘要。
        if (code === BUDGET_POLICY_CODES.timeout) {
          return {
            action: 'exit',
            reason: 'stage_timeout',
            needsSummary: false,
            detail: `${reasonStr || 'policy timeout exceeded'} (code=${code})`,
          };
        }
        // 带 code 时只认 code：reason 里出现 "token" 但 code 不是会话 token 预算的拒绝不算预算耗尽。
        isTokenIssue = TOKEN_BUDGET_CODES.has(code);
      } else {
        // 兼容回退（无 code 的拒绝）：按改造前的 reason 判定方式分类——reason 含 "token" 视为 token 预算
        // 耗尽（含一次 grace），否则 policy_stop；不识别超时（改造前同样归 policy_stop）。
        //   消费者：宿主 Alembic 仓库 test/unit/ExitController.test.ts 的策略夹具 policyTokenStop
        //     （{ok:false, action:'stop', reason:'session token budget exceeded'}，不带 code），
        //     以及任何尚未迁移到结构化 code 的第三方/自定义策略。
        //   原因：PolicyDuringDecision.code 是可选字段，未迁移的决策不能因此被改判为 policy_stop。
        //   移除条件：事项②落地且宿主迁移该单测（夹具带上 budget_session_tokens 等 code）后，删除本分支，
        //     无 code 的拒绝统一按 policy_stop 处理。
        //   负责方：AlembicAgent 窗口。
        // 只恢复分类，不恢复旧的 "session" 子串屏蔽：屏蔽仍只按 code（见 createStageOwnedBypassValidate）。
        isTokenIssue = reasonStr.includes('token');
        this.#reportCodelessDecision(ctx, duringCheck, reasonStr, isTokenIssue);
      }

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

  /**
   * 无 code 兼容回退的诊断：每个策略每个 loop 只报一次。
   * 诊断只含策略名与 reason（按总控决定，不带阶段、token 用量等其它内容）；
   * 触发条件、选择的分类路径与分类结果写在 warn 日志里。
   */
  #reportCodelessDecision(
    ctx: LoopContext,
    decision: PolicyDuringDecision,
    reasonStr: string,
    isTokenIssue: boolean
  ) {
    const policyName = decisionPolicyNames.get(decision) ?? UNKNOWN_POLICY_NAME;
    if (this.#codelessReported.has(policyName)) {
      return;
    }
    this.#codelessReported.add(policyName);
    const message = `policy=${policyName}; reason=${reasonStr || '(none)'}`;
    Logger.getInstance().warn(
      `[ExitController] ${POLICY_DECISION_WITHOUT_CODE}: ${message} — rejection carries no structured code; ` +
        `legacy reason classification (reason contains "token" → token budget) → ` +
        `classified=${isTokenIssue ? 'token_budget_exhausted' : 'policy_stop'}`
    );
    ctx.diagnostics?.warn({ code: POLICY_DECISION_WITHOUT_CODE, message });
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

/**
 * 有效超时 = 阶段超时与策略超时中较小的正值；两者都未启用时返回 0（不启用）。
 *
 * createExitController（P2 判定）与 AgentRuntime 的强制摘要抑制共用本函数，保证“是否已超时”
 * 只有一个口径。接受数字或数字字符串（与旧的 Number(ctx.budget.timeoutMs) 读法一致）；
 * 其它类型、NaN、非正值都视为未启用。
 */
export function resolveEffectiveTimeoutMs(
  stageTimeoutMs: unknown,
  policyTimeoutMs: unknown
): number {
  let effective = 0;
  for (const candidate of [stageTimeoutMs, policyTimeoutMs]) {
    const value =
      typeof candidate === 'number'
        ? candidate
        : typeof candidate === 'string'
          ? Number(candidate)
          : Number.NaN;
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    effective = effective > 0 ? Math.min(effective, value) : value;
  }
  return effective;
}

/**
 * 从 validateDuring 源读取策略超时（BudgetPolicy.timeoutMs，经 PolicyEngine.getBudget）。
 *
 * 只有 PolicyEngine 能给出策略超时；其它源（测试替身、宿主自定义对象）返回 undefined，
 * 有效超时退化为阶段超时，它们带 budget_timeout code 的拒绝仍会在 P5 归为 stage_timeout。
 * createExitController 与 AgentRuntime 的强制摘要抑制都经本函数取值，保证两处口径一致。
 */
export function readPolicyTimeoutMs(policies: unknown): number | undefined {
  return policies instanceof PolicyEngine ? policies.getBudget()?.timeoutMs : undefined;
}

export function createExitController(
  ctx: LoopContext,
  policies: {
    validateDuring: (stepState: StepState) => PolicyDuringDecision;
  }
): ExitController {
  const tracker = ctx.tracker;
  // 运行时传入的是 PolicyEngine：从中取策略超时并入有效超时，并逐条评估策略
  // （需要屏蔽时跳过可接管的 code；拒绝归属到具体策略，供无 code 兼容回退的诊断写出策略名）。
  const engine = policies instanceof PolicyEngine ? policies : null;
  const stageTimeoutMs = resolveEffectiveTimeoutMs(ctx.budget?.timeoutMs, undefined);
  const policyTimeoutMs = readPolicyTimeoutMs(policies);
  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(stageTimeoutMs, policyTimeoutMs);
  if (effectiveTimeoutMs > 0 && effectiveTimeoutMs !== stageTimeoutMs) {
    // 分叉日志：策略超时比阶段超时更紧（或阶段未启用超时），本 loop 的 stage_timeout 以策略超时为准。
    // 内置 preset 的阶段超时都不大于策略超时，这条只在调用方下调了策略超时或阶段未声明超时时出现。
    const stage =
      typeof ctx.context?.pipelinePhase === 'string' ? ctx.context.pipelinePhase : undefined;
    Logger.getInstance().info(
      `[ExitController] effective_timeout_from_policy${stage ? ` (stage=${stage})` : ''}: ` +
        `policyTimeoutMs=${policyTimeoutMs} < stageTimeoutMs=${stageTimeoutMs || 'disabled'} → ` +
        `effectiveTimeoutMs=${effectiveTimeoutMs}; exceeding it exits as stage_timeout`
    );
  }

  // 与 AgentRuntime 构造 BudgetController 时读同一字段同一写法，口径与 hasSessionBudget 一致。
  const stageSessionBudget = (ctx.budget?.maxSessionInputTokens as number) || 0;
  const hasStageSessionLimit = stageSessionBudget > 0;

  const boundValidate = policies.validateDuring.bind(policies);
  // 逐条评估只在标准 PolicyEngine 上成立：子类若改写 validateDuring，逐条评估会绕过它的额外逻辑，
  // 此时退回单次调用（拒绝无法归属到具体策略，屏蔽也只能作用于返回的那条拒绝）。
  const policyList =
    engine && engine.validateDuring === PolicyEngine.prototype.validateDuring
      ? engine.policies
      : null;
  const validateDuring = hasStageSessionLimit
    ? createAttributedValidate(policyList, boundValidate)
    : createStageOwnedBypassValidate(ctx, policyList, boundValidate);

  return new ExitController({
    tracker,
    effectiveTimeoutMs,
    abortSignal: ctx.abortSignal,
    validateDuring,
    skipPolicyIterCheck: !!tracker,
    loopStartTime: ctx.loopStartTime,
    maxIterations: ctx.maxIterations,
  });
}

/**
 * 阶段声明了 maxSessionInputTokens 时的 validateDuring：语义与 PolicyEngine.validateDuring 相同
 * （按注册顺序、首个拒绝即返回），只额外把拒绝归属到具体策略，供无 code 兼容回退的诊断写出策略名。
 */
function createAttributedValidate(
  policyList: Policy[] | null,
  boundValidate: (stepState: StepState) => PolicyDuringDecision
): (stepState: StepState) => PolicyDuringDecision {
  if (!policyList) {
    return boundValidate;
  }
  return (stepState: StepState) => {
    for (const policy of policyList) {
      const decision = policy.validateDuring(stepState);
      if (!decision.ok) {
        return attributeDecision(decision, policy);
      }
    }
    return { ok: true, action: 'continue' };
  };
}

function isStageOwnedSessionDecision(decision: PolicyDuringDecision): boolean {
  return (
    !decision.ok &&
    typeof decision.code === 'string' &&
    STAGE_OWNED_SESSION_CODES.has(decision.code)
  );
}

/**
 * 阶段预算未声明 maxSessionInputTokens 时的 validateDuring 包装（I03）。
 *
 * 只屏蔽 STAGE_OWNED_SESSION_CODES 中的 code（按结构化 code，不看 reason 文本，自定义策略的
 * "session expired" 之类拒绝照常生效）。屏蔽后继续评估后续策略，避免被屏蔽的 BudgetPolicy 遮住
 * 排在它后面的策略。每个 (策略, code) 每个 loop 只记一次日志与 policy_session_limit_bypassed 诊断，
 * 避免超限后每轮刷屏。
 */
function createStageOwnedBypassValidate(
  ctx: LoopContext,
  policyList: Policy[] | null,
  boundValidate: (stepState: StepState) => PolicyDuringDecision
): (stepState: StepState) => PolicyDuringDecision {
  const reported = new Set<string>();
  const reportBypass = (
    sourceLabel: string,
    decision: PolicyDuringDecision,
    laterPoliciesEvaluated: boolean
  ) => {
    const key = `${sourceLabel}:${decision.code}`;
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    const message =
      `${sourceLabel} rejection code=${decision.code} bypassed: stage budget declares no maxSessionInputTokens ` +
      '(session input budget belongs to the stage budget executed by BudgetController); ' +
      (laterPoliciesEvaluated
        ? 'later policies are still evaluated'
        : 'later policies could not be evaluated individually (validateDuring source is not a PolicyEngine with the standard evaluation order)') +
      `; reason=${decision.reason ?? '(none)'}`;
    const stage =
      typeof ctx.context?.pipelinePhase === 'string' ? ctx.context.pipelinePhase : undefined;
    Logger.getInstance().warn(
      `[ExitController] ${POLICY_SESSION_LIMIT_BYPASSED}${stage ? ` (stage=${stage})` : ''}: ${message}`
    );
    ctx.diagnostics?.warn({
      code: POLICY_SESSION_LIMIT_BYPASSED,
      message,
      ...(stage ? { stage } : {}),
    });
  };

  // policyList 为 null（非标准 PolicyEngine 源）时退回单次调用，只能屏蔽返回的那条拒绝
  // （诊断里注明后续策略无法逐条评估）。
  if (policyList) {
    return (stepState: StepState) => {
      for (const policy of policyList) {
        const decision = policy.validateDuring(stepState);
        if (decision.ok) {
          continue;
        }
        if (isStageOwnedSessionDecision(decision)) {
          reportBypass(policy.constructor.name || 'Policy', decision, true);
          continue;
        }
        return attributeDecision(decision, policy);
      }
      return { ok: true, action: 'continue' };
    };
  }

  return (stepState: StepState) => {
    const decision = boundValidate(stepState);
    if (isStageOwnedSessionDecision(decision)) {
      reportBypass('validateDuring source', decision, false);
      return { ok: true, action: 'continue' };
    }
    return decision;
  };
}
