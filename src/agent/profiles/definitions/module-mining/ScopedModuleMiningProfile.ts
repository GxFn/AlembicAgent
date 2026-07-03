import type { AgentProfileDefinition } from '../../../service/AgentRunContracts.js';

export const SCOPED_MODULE_MINING_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'module-mining-session',
    title: 'Project Index Scoped Module Mining Session',
    serviceKind: 'system-analysis',
    lifecycle: 'experimental',
    basePreset: 'insight',
    defaults: {
      actionSpace: { mode: 'none' },
      memory: { enabled: false },
      persona: {
        system:
          '你负责按 ProjectIndex scoped modules 做模块级知识挖掘。fan-out 单元只能来自 params.modules，每个 child 只分析自己的 moduleId/moduleName/ownedFiles，不从 dimension 或 moduleSeeds 推导模块。',
      },
    },
    strategy: {
      type: 'fanout',
      childProfile: 'module-mining-dimension',
      partitioner: 'projectContextModules',
      merge: 'moduleMiningResults',
    },
    concurrency: {
      mode: 'tiered',
      concurrency: { env: 'ALEMBIC_MODULE_MINING_CONCURRENCY', default: 2 },
      partitioner: 'projectContextModules',
      childProfile: 'module-mining-dimension',
      merge: 'moduleMiningResults',
      abortPolicy: 'finish-tier',
    },
    projection: 'agent-result',
  },
  {
    id: 'module-mining-dimension',
    title: 'Project Index Scoped Module Mining Dimension',
    serviceKind: 'system-analysis',
    lifecycle: 'experimental',
    basePreset: 'insight',
    defaults: {
      actionSpace: { mode: 'none' },
      memory: { enabled: false },
      persona: {
        system:
          '你是单模块分析 child。只使用 promptContext.moduleId/moduleName/ownedFiles 与 projectFacts，产出该 ProjectIndex scoped module 的候选 recipe 证据；不得写 repository、ledger 或共享状态。',
      },
    },
    strategy: { type: 'pipeline', factory: 'generateDimensionPipeline' },
    projection: 'agent-result',
  },
];
