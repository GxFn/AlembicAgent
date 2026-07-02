import { renderPlanPersonaDescription } from '@alembic/core/plans';
import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const PLAN_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'plan-selection',
    title: 'Plan Selection',
    serviceKind: 'system-analysis',
    lifecycle: 'active',
    basePreset: 'chat',
    defaults: {
      skills: [],
      policies: [
        { type: 'budget', maxIterations: 2, maxTokens: 4096, temperature: 0.1, timeoutMs: 120_000 },
      ],
      persona: {
        // P-1(2026-07-02 用户决策)：规模决策重写。旧版输出示例硬编码 totalRecipeBudget=6，
        // 真机 DeepSeek 被示例数字锚定直接照抄(491 文件 5 仓 monorepo 只给 6 条/3 维度，
        // 低于真实证据面 3-4 倍)；且旧版对规模只有「必须大于 0」的合法性约束、没有估算框架。
        // 新版：给按项目规模的估算基准 + 逐维证据面评估要求 + per-dimension 预算输出；
        // 示例数字改为与示例规模自洽的量级，防锚定。
        // S2(2026-07-02 统一重构)：persona 全文改由 Core PlanAuthoringSpec 单源 render——
        // 与宿主 plan-tool 的决策 checklist 共用同一份规模规则数据(PLAN_SCALE_RULES),
        // 改一处规则两宿主同步。切换时与 P-1 手写文本字节等价(Core 测试钉守护)。
        description: renderPlanPersonaDescription(),
      },
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'single' },
    projection: 'json-object',
  },
];
