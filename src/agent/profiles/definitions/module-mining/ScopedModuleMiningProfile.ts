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
      // 取消语义如实声明为 stop-new（I20，方案 B）：AgentRunCoordinator 只实现 stop-new——
      // tier 边界与每个模块 child 派发前检查停止事实，同 tier 中尚在排队的模块直接记 aborted，后续 tier 不再开始。
      // 协调器不会主动打断进行中的 child；partitioner 会把父 execution（含 abortSignal）透传给 child，
      // 由 child 自身运行时按信号收尾。此前声明的 'finish-tier'（当前 tier 跑完再停）从未被实现，
      // 改动前后运行时行为一致；声明其他值时协调器会记 warn 诊断并仍按 stop-new 执行。
      abortPolicy: 'stop-new',
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
