// L8-P16：./tasks 子路径整体退役中（用户已批准）。全部导出在 AgentTaskHandlers.ts 的声明处带废弃标注，
// 写明退役原因与替代入口（关系发现改用 @alembic/agent/service 的 runRelationDiscovery，其余 4 个任务
// 依赖的工具不存在、没有替代）。宿主 lib/http/routes/ai.ts 仍按名导入 5 个任务函数，所以在宿主移除
// DAG 条目、capabilities 广告与对应单测之前，这里不删除导出、不改名字与运行时种类。
export type {
  CandidateInput,
  DuplicateEntry,
  GuardViolation,
  KnowledgeItem,
  KnowledgeServiceLike,
  TaskAiProvider,
  TaskContext,
} from './AgentTaskHandlers.js';
export {
  taskCheckAndSubmit,
  taskDiscoverAllRelations,
  taskFullEnrich,
  taskGuardFullScan,
  taskQualityAudit,
} from './AgentTaskHandlers.js';
