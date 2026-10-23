export interface PolicyContext {
  message?: {
    sender?: {
      id?: string;
    };
  };
  [key: string]: unknown;
}

export interface StepState {
  iteration: number;
  startTime: number;
  [key: string]: unknown;
}

/**
 * validateDuring 的决策（I03）。
 *
 * code 是可选的结构化分类：带 code 时 ExitController 只按 code 区分 token 预算、超时与普通停止，
 * 并且只按 code 判定哪些拒绝可由阶段预算接管（屏蔽）；此时 reason 只用于日志与诊断展示。
 * 未带 code 的拒绝走 ExitController 的兼容回退：按改造前的 reason 判定分类（含 "token" 视为
 * token 预算，否则 policy_stop），并发出 policy_decision_without_code 诊断；该回退待事项②落地、
 * 宿主迁移后删除，新策略应始终返回 code。
 * 内置 code 见 BudgetPolicy 的 BUDGET_POLICY_CODES；自定义策略可以返回自己的 code。
 */
export interface PolicyDuringDecision {
  ok: boolean;
  action?: string;
  reason?: string;
  code?: string;
}

export interface PolicyResult {
  reply?: string;
  toolCalls?: unknown[];
  [key: string]: unknown;
}

/**
 * 运行策略基类：只经 validateBefore / validateDuring / validateAfter 三个校验钩子参与运行。
 *
 * W2a-07（L5-P44，②已答复）：旧的 applyToConfig 配置改写链（Policy、子类与 PolicyEngine 各一处）已删除。
 * 它在 src 与宿主中都没有调用方，SafetyPolicy 的实现还会把策略实例本身塞进配置，序列化后约束静默丢失。
 * 需要预算数值的调用方读 PolicyEngine.getBudget()。
 */
export class Policy {
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  validateBefore(_context: PolicyContext): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  validateDuring(_stepState: StepState): PolicyDuringDecision {
    return { ok: true, action: 'continue' };
  }

  validateAfter(_result: PolicyResult): { ok: boolean; reason?: string } {
    return { ok: true };
  }
}
