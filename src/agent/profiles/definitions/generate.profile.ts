import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

// 字段语义（L8-C09 / L8-C11 / W2a-06 L8-P17）：serviceKind / lifecycle / projection 只是描述性元数据，
// 运行时不消费；fanout 模板只是标记 { type: 'fanout' }，编排由 AgentRunCoordinator 只读 concurrency 计划
// 完成，child / 分区器 / 合并器只在计划里声明一次（编译期要求计划声明齐全）。
// 取消语义固定为 stop-new：tier 边界与每个 child 派发前检查停止事实，同 tier 中尚在排队的维度直接记
// aborted，后续 tier 不再开始；协调器不打断进行中的 child，内置 partitioner 把父 execution（含
// abortSignal）透传给 child，由 child 自身运行时按信号收尾。计划上已没有 abortPolicy 声明字段。
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
    strategy: { type: 'fanout' },
    concurrency: {
      mode: 'tiered',
      concurrency: { env: 'ALEMBIC_BOOTSTRAP_CONCURRENCY', default: 2 },
      partitioner: 'generateSessionDimensions',
      childProfile: 'generate-dimension',
      merge: 'generateSessionResults',
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
