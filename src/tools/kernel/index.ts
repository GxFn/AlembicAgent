/**
 * @module tools/kernel
 *
 * Canonical tool-system contract — the single source of truth for the tool
 * result envelope, decision, request, router contract, call context, handler,
 * and registry types. This replaced the former dual V1 (src/tools/core) and
 * V2 (src/tools/v2/types) contract split; every consumer imports from here and
 * there are no version labels left in the tool system.
 */

export type {
  ToolAvailabilityContext,
  ToolAvailabilitySnapshot,
  ToolUnavailableReason,
} from './availability.js';
export * from './context.js';
export * from './decision.js';
export * from './handler.js';
export type * from './manifest.js';
export * from './presenter.js';
export * from './registry.js';
export * from './request.js';
export * from './result.js';
// 包内专用（L3-P07）：result.ts 的 default（规范化函数，其上挂 D23 清理入口
// redactPrivateFields）不被上面的 `export *` 转发；runtimeBridge 受文件边界约束只能从本桶
// 导入，所以在这里具名转发。本桶不在任何公开出口链上（tools/index.ts 与包入口逐文件再导出
// kernel，不经过本文件），不改变公开绑定。
export { default as toolResultInternals } from './result.js';
export * from './routing.js';
export type {
  ToolActionAllowlist,
  ToolSchemaProjection,
  ToolSchemaQuery,
  ToolSchemaQueryPort,
  ToolSchemaQueryResult,
  ToolSelection,
} from './toolSchema.js';
