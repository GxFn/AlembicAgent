import type { ToolSchemaProjection } from '../catalog/CapabilityManifest.js';
import type { ToolUnavailableReason } from './availability.js';
import type { ToolRuntimeCallContext } from './context.js';

export type { ToolSchemaProjection } from '../catalog/CapabilityManifest.js';

/** 缺少工具键表示未选择；已有键的 null/undefined 表示该工具全部动作，空数组表示禁用。 */
export type ToolActionAllowlist = Readonly<Record<string, readonly string[] | null | undefined>>;

/** 顶层缺省/null 不限制注册工具；显式空数组/对象不选择任何工具。 */
export type ToolSelection = readonly string[] | ToolActionAllowlist | null | undefined;

export interface ToolSchemaQuery {
  selection?: ToolSelection;
  model?: string;
  mode?: 'full' | 'mixed' | 'lightweight';
  firstRound?: boolean;
  runtime?: ToolRuntimeCallContext;
}

export interface ToolSchemaQueryResult {
  schemas: ToolSchemaProjection[];
  allowedTools: ToolActionAllowlist;
  unavailable?: ToolUnavailableReason[];
}

/** schema 与执行方消费同一次投影的有效动作集合；可见性本身不代替执行时检查。 */
export interface ToolSchemaQueryPort {
  querySchemas(query?: ToolSchemaQuery): ToolSchemaQueryResult;
}
