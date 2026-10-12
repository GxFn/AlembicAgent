import { Policy, type PolicyDuringDecision, type StepState } from './Policy.js';

/**
 * BudgetPolicy.validateDuring 拒绝时附带的结构化 code（I03）。
 *
 * ExitController 按这些 code 分类：会话 token 两项走 token_budget_exhausted（含一次 grace），
 * budget_timeout 归为 stage_timeout，budget_max_iterations 是普通 policy_stop。
 * 只有 budget_session_input_tokens 可能被阶段预算接管（阶段未声明 maxSessionInputTokens 时屏蔽），
 * 判定在 createExitController，不在本策略里。本常量不进入 policies 公开入口。
 */
export const BUDGET_POLICY_CODES = {
  maxIterations: 'budget_max_iterations',
  timeout: 'budget_timeout',
  sessionTokens: 'budget_session_tokens',
  sessionInputTokens: 'budget_session_input_tokens',
} as const;

export interface BudgetPolicyConfig {
  maxIterations?: number;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /**
   * 运行级累计 token 上限（input + output），按整次运行累计判定；undefined = 不限制。
   * 会话预算的归属是阶段预算与 BudgetController；本字段待公开面收窄（事项②）时删除，
   * 在此之前声明式 profile 编译会告警（AgentProfileCompiler）。BudgetController 不执行该上限，
   * 所以 ExitController 不屏蔽它的拒绝（budget_session_tokens），配置后照常生效。
   */
  maxSessionTokens?: number;
  /**
   * 运行级累计 input token 上限；undefined = 不限制。同样待事项②删除、编译期告警。
   * 阶段预算未声明 maxSessionInputTokens 的循环里，ExitController 会屏蔽它的拒绝
   * （budget_session_input_tokens）并写 policy_session_limit_bypassed 诊断。
   */
  maxSessionInputTokens?: number;
}

export class BudgetPolicy extends Policy {
  #maxIterations;
  #maxTokens;
  #timeoutMs;
  #temperature;
  #maxSessionTokens;
  #maxSessionInputTokens;

  constructor({
    maxIterations = 20,
    maxTokens = 4096,
    timeoutMs = 300_000,
    temperature = 0.7,
    maxSessionTokens,
    maxSessionInputTokens,
  }: BudgetPolicyConfig = {}) {
    super();
    this.#maxIterations = maxIterations;
    this.#maxTokens = maxTokens;
    this.#timeoutMs = timeoutMs;
    this.#temperature = temperature;
    this.#maxSessionTokens = maxSessionTokens;
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

  get maxSessionTokens() {
    return this.#maxSessionTokens;
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

    const totalTokens = stepState.totalTokens as number | undefined;
    if (this.#maxSessionTokens && totalTokens && totalTokens >= this.#maxSessionTokens) {
      return {
        ok: false,
        action: 'stop',
        reason: `Budget: session token limit (${this.#maxSessionTokens}) reached — used ${totalTokens}`,
        code: BUDGET_POLICY_CODES.sessionTokens,
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

  applyToConfig(config: Record<string, unknown>) {
    return {
      ...config,
      budget: {
        maxIterations: this.#maxIterations,
        maxTokens: this.#maxTokens,
        timeoutMs: this.#timeoutMs,
        temperature: this.#temperature,
        maxSessionTokens: this.#maxSessionTokens,
        maxSessionInputTokens: this.#maxSessionInputTokens,
      },
    };
  }
}
