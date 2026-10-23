import { Policy, type PolicyDuringDecision, type StepState } from './Policy.js';

/**
 * BudgetPolicy.validateDuring 拒绝时附带的结构化 code（I03）。
 *
 * ExitController 按这些 code 分类：budget_session_input_tokens 走 token_budget_exhausted（含一次 grace），
 * budget_timeout 归为 stage_timeout，budget_max_iterations 是普通 policy_stop。
 * 只有 budget_session_input_tokens 可能被阶段预算接管（阶段未声明 maxSessionInputTokens 时屏蔽），
 * 判定在 createExitController，不在本策略里。本常量不进入 policies 公开入口。
 *
 * W2a-07（L5-P08，②已答复）：运行级总量上限 maxSessionTokens 与它的 budget_session_tokens code 已删除。
 * 会话预算的归属是阶段预算 + BudgetController（阶段内 input 口径）；仍带 budget_session_tokens 的自定义
 * 决策在 ExitController 按普通 policy_stop 处理。
 */
export const BUDGET_POLICY_CODES = {
  maxIterations: 'budget_max_iterations',
  timeout: 'budget_timeout',
  sessionInputTokens: 'budget_session_input_tokens',
} as const;

export interface BudgetPolicyConfig {
  maxIterations?: number;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /**
   * 运行级累计 input token 上限；undefined = 不限制。按整次运行累计判定（AgentRuntime.#shouldExit 传运行级
   * tokenUsage），与 BudgetController 执行的阶段内口径不同，声明式 profile 编译时会告警说明这一差异。
   * 本字段保留（W2a-07 只删除总量上限 maxSessionTokens）：阶段预算未声明 maxSessionInputTokens 的循环里，
   * ExitController 屏蔽它的拒绝（budget_session_input_tokens）并写 policy_session_limit_bypassed 诊断；
   * 阶段声明了时照常生效。
   */
  maxSessionInputTokens?: number;
}

export class BudgetPolicy extends Policy {
  #maxIterations;
  #maxTokens;
  #timeoutMs;
  #temperature;
  #maxSessionInputTokens;

  // 只解构已声明字段：旧调用方（JS 或强转）仍传入的 maxSessionTokens 不被读取，不再按累计总量停止运行；
  // 声明式 profile 的 budget 声明带它时由 AgentProfileCompiler 编译期告警“已删除、被忽略”。
  constructor({
    maxIterations = 20,
    maxTokens = 4096,
    timeoutMs = 300_000,
    temperature = 0.7,
    maxSessionInputTokens,
  }: BudgetPolicyConfig = {}) {
    super();
    this.#maxIterations = maxIterations;
    this.#maxTokens = maxTokens;
    this.#timeoutMs = timeoutMs;
    this.#temperature = temperature;
    this.#maxSessionInputTokens = maxSessionInputTokens;
  }

  get name() {
    return 'budget';
  }

  get maxIterations() {
    return this.#maxIterations;
  }

  get maxTokens() {
    return this.#maxTokens;
  }

  get timeoutMs() {
    return this.#timeoutMs;
  }

  get temperature() {
    return this.#temperature;
  }

  get maxSessionInputTokens() {
    return this.#maxSessionInputTokens;
  }

  validateDuring(stepState: StepState): PolicyDuringDecision {
    if (stepState.iteration >= this.#maxIterations) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: max iterations (${this.#maxIterations}) reached`,
        code: BUDGET_POLICY_CODES.maxIterations,
      };
    }
    // 运行时 createExitController 已把本超时并入有效超时（取阶段与策略的较小正值），
    // 正常会先在阶段超时分支命中；这里仍保留判定，供直接使用 PolicyEngine 的调用方与同毫秒边界兜底。
    if (Date.now() - stepState.startTime > this.#timeoutMs) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: timeout (${this.#timeoutMs}ms) exceeded`,
        code: BUDGET_POLICY_CODES.timeout,
      };
    }

    const totalInputTokens = stepState.totalInputTokens as number | undefined;
    if (
      this.#maxSessionInputTokens &&
      totalInputTokens &&
      totalInputTokens >= this.#maxSessionInputTokens
    ) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: session input token limit (${this.#maxSessionInputTokens}) reached — used ${totalInputTokens}`,
        code: BUDGET_POLICY_CODES.sessionInputTokens,
      };
    }

    return { ok: true, action: 'continue' };
  }
}
