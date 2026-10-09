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
          maxIterations: 28,
          maxTokens: 8192,
          temperature: 0.3,
          timeoutMs: 420_000,
        },
      ],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'pipeline', factory: 'relationsPipeline' },
    projection: 'relation-discovery',
  },
];
