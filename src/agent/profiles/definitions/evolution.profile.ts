import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

/**
 * PipelineStrategy 的 executeAttempt 给每次阶段尝试的期限是 stage.budget.timeoutMs + 60s
 * forced-summary 缓冲；evolution-audit 的整次期限按这个窗口推导。
 */
const STAGE_ATTEMPT_GRACE_MS = 60_000;

/** evolve 阶段每条 recipe 的轮次预算与上限（原编译器公式，L8-P03 沿用）。 */
const ITERATIONS_PER_RECIPE = 4;
const BASE_ITERATIONS = 10;
const MAX_ITERATIONS = 120;

/** evolve 阶段单次尝试期限：preset 原值 180s 起步，每条 recipe 加 10s，封顶 600s。 */
const BASE_STAGE_TIMEOUT_MS = 180_000;
const STAGE_TIMEOUT_PER_RECIPE_MS = 10_000;
const MAX_STAGE_TIMEOUT_MS = 600_000;

/**
 * evolution_gate 判 retry 后回到 evolve 补写决策的次数。preset 声明的 8 次在原 600s 整次期限内
 * 最多只能跑约 2.5 次阶段尝试，是不可达的假声明；evolution-audit 降为 2 次，并让整次期限覆盖
 * 1 + 2 次完整阶段窗口（L8-P03）。generateDimensionPipeline 复用的 preset 门不受影响。
 */
const GATE_MAX_RETRIES = 2;

/** evolution-audit 按 recipe 数推导出的全部预算；阶段工厂与 policy 声明都只从这里取值。 */
export interface EvolutionAuditScaleBudget {
  /** params.recipes 的条数；缺失或不是数组时按 0 条计（由阶段工厂记录诊断日志）。 */
  recipeCount: number;
  /** evolve 阶段的 maxIterations，同时是整次 BudgetPolicy 的 maxIterations。 */
  maxIterations: number;
  /** evolve 阶段每次尝试的 timeoutMs（不含 PipelineStrategy 追加的 60s 缓冲）。 */
  stageTimeoutMs: number;
  /** evolution_gate.gate.maxRetries。 */
  gateMaxRetries: number;
  /** 整次运行期限（BudgetPolicy.timeoutMs → AgentRuntime.execute）。 */
  runTimeoutMs: number;
}

/**
 * evolution-audit 规模预算的单一决定点（L8-P03 / C03）。
 *
 * 背景：此前编译器按 recipe 数算出的 maxIterations（每条 4 轮、上限 120）只写进 BudgetPolicy，
 * 而 PipelineStrategy 先取 stage.budget，evolve 阶段固定 20 轮 / 180s，policy 预算从来进不了
 * 阶段；gate 声明 8 次重试，600s 整次期限只够约 2.5 次尝试。现在：
 *   - maxIterations = min(4 × recipeCount + 10, 120)：0 条 10 轮、5 条 30 轮、≥28 条 120 轮；
 *   - stageTimeoutMs = min(180s + 10s × recipeCount, 600s)；
 *   - gateMaxRetries = 2；
 *   - runTimeoutMs = (1 + gateMaxRetries) × (stageTimeoutMs + 60s)，范围 720s–1980s，保证首轮加
 *     全部 gate 重试的阶段窗口都落在整次期限内。
 * 阶段工厂 evolutionAuditPipeline 把前三项合并进 evolve / evolution_gate，编译器把 maxIterations
 * 与 runTimeoutMs 写进 BudgetPolicy；两处不再各自持有公式。调整任何一项都必须保持
 * runTimeoutMs ≥ (1 + gateMaxRetries) × (stageTimeoutMs + 60s)，
 * test/agent-surface-floor.test.ts 锁定 0 / 5 / 30 / 60 条的取值与该不等式。
 */
export function resolveEvolutionAuditScaleBudget(
  params: Record<string, unknown>
): EvolutionAuditScaleBudget {
  const recipeCount = Array.isArray(params.recipes) ? params.recipes.length : 0;
  const maxIterations = Math.min(
    recipeCount * ITERATIONS_PER_RECIPE + BASE_ITERATIONS,
    MAX_ITERATIONS
  );
  const stageTimeoutMs = Math.min(
    BASE_STAGE_TIMEOUT_MS + STAGE_TIMEOUT_PER_RECIPE_MS * recipeCount,
    MAX_STAGE_TIMEOUT_MS
  );
  const runTimeoutMs = (1 + GATE_MAX_RETRIES) * (stageTimeoutMs + STAGE_ATTEMPT_GRACE_MS);
  return {
    recipeCount,
    maxIterations,
    stageTimeoutMs,
    gateMaxRetries: GATE_MAX_RETRIES,
    runTimeoutMs,
  };
}

/**
 * evolution-audit 的整次 policy 声明：maxIterations 与阶段一致（policy 不会先于阶段截断），
 * timeoutMs 是覆盖全部 gate 重试的整次期限；maxTokens / temperature 沿用原值。
 */
export function evolutionAuditPolicyDeclarations(
  params: Record<string, unknown>
): Array<Record<string, unknown>> {
  const scale = resolveEvolutionAuditScaleBudget(params);
  return [
    {
      type: 'budget',
      maxIterations: scale.maxIterations,
      maxTokens: 8192,
      temperature: 0.3,
      timeoutMs: scale.runTimeoutMs,
    },
  ];
}

export const EVOLUTION_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'evolution-audit',
    title: 'Evolution Audit',
    serviceKind: 'system-analysis',
    lifecycle: 'active',
    basePreset: 'evolution',
    defaults: {
      skills: ['evolution_analysis'],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    // 规模预算必须进入 evolve 阶段，不能再走 { type: 'preset' }（preset 的静态阶段预算会遮蔽
    // policy 预算）；evolutionAuditPipeline 按 resolveEvolutionAuditScaleBudget 装配阶段，
    // 整次期限由编译器经 evolutionAuditPolicyDeclarations 写入同一份推导结果（L8-P03）。
    strategy: { type: 'pipeline', factory: 'evolutionAuditPipeline' },
    projection: 'evolution-audit',
  },
];
