import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const RELATION_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'relation-discovery',
    title: 'Relation Discovery',
    serviceKind: 'knowledge-production',
    lifecycle: 'active',
    basePreset: 'insight',
    defaults: {
      // 与 buildRelationsPipelineStages 默认 exploreCaps 同一集合：只读探索，不含
      // knowledge.submit / terminal.exec / memory 写入（L7-P19 / C04）。运行时级能力实例
      // 由此创建，explore 阶段的 capabilityOverride 按名复用同一实例。
      skills: ['relation_exploration'],
      policies: [
        {
          type: 'budget',
          // 迭代上限由阶段预算决定：relationsPipeline 的 explore（20 轮）与 synthesize（4 轮）
          // 都声明了 maxIterations，阶段预算作为 budgetOverride 完全替代 policy 预算，所以这里
          // 不再声明 maxIterations（原来的 28 从不生效，L8-P02 / C03）。BudgetPolicy 缺省 20 轮，
          // 不低于任何阶段上限，阶段自己的上限先命中；阶段上限若要超过 20，需要在这里显式放宽。
          maxTokens: 8192,
          temperature: 0.3,
          // 整次期限由阶段窗口推导：PipelineStrategy 给每次阶段尝试 stage.timeoutMs + 60s
          // forced-summary 缓冲，explore (300+60)s + synthesize (60+60)s = 480s，再留 60s
          // 余量 = 540s。原来的 420s 小于 480s，explore 在窗口内偏晚正常结束时 synthesize 会被
          // 整次期限截断成 timeout（L8-P02 / C03）。调整阶段预算时必须同步本值，
          // test/agent-surface-floor.test.ts 断言 timeoutMs ≥ Σ(stage.timeoutMs + 60s)。
          timeoutMs: 540_000,
        },
      ],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'pipeline', factory: 'relationsPipeline' },
    projection: 'relation-discovery',
  },
];
