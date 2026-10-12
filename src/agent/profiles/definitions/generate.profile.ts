import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const GENERATE_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'generate-session',
    title: 'Bootstrap Session',
    serviceKind: 'system-analysis',
    lifecycle: 'experimental',
    basePreset: 'insight',
    defaults: {
      actionSpace: { mode: 'none' },
    },
    strategy: {
      type: 'fanout',
      childProfile: 'generate-dimension',
      partitioner: 'generateSessionDimensions',
      merge: 'generateSessionResults',
    },
    concurrency: {
      mode: 'tiered',
      concurrency: { env: 'ALEMBIC_BOOTSTRAP_CONCURRENCY', default: 2 },
      partitioner: 'generateSessionDimensions',
      childProfile: 'generate-dimension',
      merge: 'generateSessionResults',
      // 取消语义如实声明为 stop-new（I20，方案 B）：AgentRunCoordinator 只实现 stop-new——
      // tier 边界与每个 child 派发前检查停止事实，同 tier 中尚在排队的维度直接记 aborted，后续 tier 不再开始。
      // 协调器不会主动打断进行中的 child；内置 partitioner 会把父 execution（含 abortSignal）透传给 child，
      // 由 child 自身运行时按信号收尾。此前声明的 'finish-tier'（当前 tier 跑完再停）从未被实现，
      // 改动前后运行时行为一致；声明其他值时协调器会记 warn 诊断并仍按 stop-new 执行。
      abortPolicy: 'stop-new',
    },
    projection: 'agent-result',
  },
  {
    id: 'generate-dimension',
    title: 'Bootstrap Dimension',
    serviceKind: 'system-analysis',
    lifecycle: 'experimental',
    basePreset: 'insight',
    defaults: {
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'pipeline', factory: 'generateDimensionPipeline' },
    projection: 'agent-result',
  },
];
