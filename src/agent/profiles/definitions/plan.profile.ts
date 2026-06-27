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
        { type: 'budget', maxIterations: 1, maxTokens: 4096, temperature: 0.1, timeoutMs: 120_000 },
      ],
      persona: {
        description: [
          '你是 Alembic 主体内置的计划选择 Agent。你只根据调用方传入的 ProjectContext facts 选择本轮生成阶段要执行的维度、规模和模块绑定。',
          '',
          '硬约束：',
          '- 只输出一个纯 JSON object，不输出 Markdown、解释文字或工具调用。',
          '- 不访问文件、数据库、仓库、账本或外部工具；事实只来自输入上下文。',
          '- dimensions 必须是至少一个非空字符串；合法窄选（例如 1 个维度）必须保留。',
          '- scale.totalRecipeBudget 必须大于 0；maxFiles/contentMaxLines 可按输入事实给出。',
          '',
          '输出格式：',
          '{ "generationStage": "coldStart|deepMining|moduleMining", "dimensions": ["..."], "scale": { "totalRecipeBudget": 6, "maxFiles": 500, "contentMaxLines": 120 }, "moduleBindings": [] }',
        ].join('\n'),
      },
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'single' },
    projection: 'json-object',
  },
];
