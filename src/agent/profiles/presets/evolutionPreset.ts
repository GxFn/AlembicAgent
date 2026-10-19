/**
 * evolution preset —— 衰退 Recipe 进化决策的运行时基块(W6-e 自 presets.ts 拆出,内容原样)。
 */
import { EVOLUTION_GATE_STAGE, evolutionGateEvaluator } from '../../evaluation/gateEvaluators.js';
import { BudgetPolicy } from '../../policies/index.js';
import {
  buildEvolverPrompt,
  EVOLVER_BUDGET,
  EVOLVER_SYSTEM_PROMPT,
  type EvolutionContext,
} from '../../prompts/insightEvolver.js';
import type { PolicyFactoryConfig } from './types.js';

function buildEvolutionRetryPrompt(
  retryCtx: { reason?: string; artifact?: unknown },
  _origPrompt: string,
  prev: Record<string, unknown>
) {
  const artifact = (retryCtx.artifact || {}) as {
    processed?: number;
    totalRecipes?: number;
    pendingIds?: string[];
  };
  const pendingIds = Array.isArray(artifact.pendingIds) ? artifact.pendingIds : [];
  const prevReply = (prev.evolve as { reply?: string } | undefined)?.reply || '';
  const pendingList = pendingIds.length
    ? pendingIds.map((id) => `- ${id}`).join('\n')
    : '- （无法从 gate artifact 解析，按原始 Recipe 清单逐条补齐）';

  return `⚠️ Evolution Gate 未通过: ${retryCtx.reason || '存在未提交决策的 Recipe'}

你上一轮可能已经完成了阅读和分析，但没有为所有 Recipe 调用 \`knowledge.manage\`。现在进入决策补写阶段：

- 当前回复必须只调用 \`knowledge({ action: "manage", params: ... })\`，不要先输出自然语言
- 禁止继续调用 \`knowledge.search\`、\`knowledge.detail\`、\`code\`、\`graph\` 或其他探索工具；待处理 ID 不是搜索词
- 不要输出 Markdown 报告来替代工具调用；输出正文会被视为未完成
- Recipe 标识字段必须是 \`id\`，禁止使用 \`recipeId\`
- 对每个待处理 Recipe 必须调用以下三种之一:
  - \`knowledge({ action: "manage", params: { "operation": "skip_evolution", "id": "...", "reason": "验证有效: ..." } })\`
  - \`knowledge({ action: "manage", params: { "operation": "evolve", "id": "...", "reason": "...", "data": { "description": "...", "evidence": { "currentCode": "..." }, "confidence": 0.85 } } })\`
  - \`knowledge({ action: "manage", params: { "operation": "deprecate", "id": "...", "reason": "...", "data": { "confidence": 0.7 } } })\`
- 如果证据不足，也必须立刻用 \`skip_evolution\` 显式记录“信息不足”，不能留空

待补决策 Recipe ID:
${pendingList}

上一轮分析摘要（仅供你决定，不可当作最终结果）:
${prevReply.slice(0, 3000)}`;
}

export const EVOLUTION_PRESET = {
  name: '进化',
  description: '审查衰退 Recipe，决定进化（supersede）、废弃或跳过。Evolve→EvolutionGate。',
  capabilities: ['evolution_analysis'],
  strategy: {
    type: 'pipeline',
    maxRetries: 1,
    stages: [
      // ── Phase 1: Evolver ──
      // 本阶段预算是 generateDimensionPipeline（冷启动/重扫维度前置进化）复用的原值，不随 recipe 数伸缩；
      // evolution-audit 由 evolutionAuditPipeline 在装配副本上改写 maxIterations / timeoutMs
      // （见 definitions/evolution.profile.ts 的 resolveEvolutionAuditScaleBudget，L8-P03），这里不要
      // 为全量审计放大，否则会同时放大维度管线的进化预算。
      {
        name: 'evolve',
        capabilities: ['evolution_analysis'],
        budget: {
          ...EVOLVER_BUDGET,
          temperature: 0.3,
          timeoutMs: 180_000,
        },
        systemPrompt: EVOLVER_SYSTEM_PROMPT,
        promptBuilder: (ctx: Record<string, unknown>) =>
          buildEvolverPrompt(null, null, ctx as unknown as EvolutionContext),
        retryPromptBuilder: buildEvolutionRetryPrompt,
        decisionOnlyOnRetry: true,
      },
      // ── Phase 2: Evolution Gate ──
      {
        name: EVOLUTION_GATE_STAGE,
        gate: {
          evaluator: evolutionGateEvaluator,
          useCumulativeToolCalls: true,
          // generateDimensionPipeline 复用的原值；evolution-audit 的门由 evolutionAuditPipeline 下调为 2 次，
          // 并让整次期限覆盖 1 + 2 次 evolve 窗口（L8-P03）。
          maxRetries: 8,
        },
      },
    ],
  },
  policies: [
    (config?: PolicyFactoryConfig) =>
      new BudgetPolicy({
        maxIterations: config?.maxIterations ?? 16,
        maxTokens: config?.maxTokens ?? 4096,
        temperature: config?.temperature ?? 0.3,
        timeoutMs: config?.timeoutMs ?? 180_000,
      }),
  ],
  // persona 与 profile/override 浅合并；运行时只读 description（系统提示“# 角色”段）。
  persona: {
    role: 'analyst',
    description: '知识进化专家',
  },
  // 描述性声明（L8-C11）：enabled 没有读取者，不会关闭记忆注入；记忆是否参与由运行上下文的
  // memoryCoordinator 决定。去留待事项②。
  memory: {
    enabled: false,
  },
};
