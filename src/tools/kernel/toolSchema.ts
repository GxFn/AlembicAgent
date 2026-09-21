import type { ToolUnavailableReason } from './availability.js';
import type { ToolRuntimeCallContext } from './context.js';

/** 模型可见的工具输入描述；和查询/执行选择合同使用同一 kernel 入口。 */
export interface ToolSchemaProjection {
  [key: string]: unknown;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 缺少工具键表示未选择；已有键的 null/undefined 表示该工具全部动作，空数组表示禁用。 */
export type ToolActionAllowlist = Readonly<Record<string, readonly string[] | null | undefined>>;

/** 顶层缺省/null 不限制注册工具；显式空数组/对象不选择任何工具。 */
export type ToolSelection = readonly string[] | ToolActionAllowlist | null | undefined;

export interface ToolSchemaQuery {
  selection?: ToolSelection;
  model?: string;
  /** 路由方已解析的 API 模型名；catalog 不把裸模型名中的冒号猜成 provider 分隔符。 */
  apiModelId?: string;
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
