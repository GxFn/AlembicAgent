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

  applyToConfig(config: Record<string, unknown>): Record<string, unknown> {
    return config;
  }
}
