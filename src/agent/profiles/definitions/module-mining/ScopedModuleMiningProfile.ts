import type { AgentProfileDefinition } from '../../../service/AgentRunContracts.js';

// 字段语义（L8-C09 / L8-C11）：
//   - serviceKind / lifecycle / projection 只是描述性元数据，运行时不消费；
//   - memory: { enabled: false } 是描述性声明，没有读取者，不会关闭记忆注入（记忆是否参与由运行上下文
//     的 memoryCoordinator 决定，scan/insight 的 note_finding 依赖它，不能借此字段去掉）；
//   - 不声明 persona：此前的 persona.system 没有任何读取者（SystemPromptBuilder 只读 description），
//     不会进入模型输入，且 child 的“不得写 repository”与 produce 阶段提交候选的实际行为相矛盾，已删除。
//     模块边界由协调器的 partitioner 写进 child 的 promptContext（moduleId / moduleName / ownedFiles），
//     合并后的 persona 仍取 insight preset 原值，无 systemPrompt 阶段的“# 角色”提示不变。
//     不要把这段文案改写成 description，那会改变提示。
//   - fanout 模板只是标记，编排只读 concurrency 计划，模板三字段须与计划一致（编译期校验）。
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
    },
    strategy: { type: 'pipeline', factory: 'generateDimensionPipeline' },
    projection: 'agent-result',
  },
];
