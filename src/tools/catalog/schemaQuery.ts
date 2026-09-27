/** 新查询端口的唯一消费入口；旧方法探测保留在这一处兼容，不散落在 Runtime。 */
import Logger from '@alembic/core/logging';
import { isThenable, observeSafely } from '#shared/observers.js';
import type {
  ToolActionAllowlist,
  ToolSchemaProjection,
  ToolSchemaQuery,
  ToolSchemaQueryResult,
  ToolSelection,
} from '#tools/kernel/toolSchema.js';
import {
  intersectToolActions,
  isToolActionAllowlist,
  selectToolActions,
  snapshotToolSelection,
} from '#tools/kernel/toolSelection.js';

interface LegacySchemaCatalog {
  toMixedSchemasForActions?(
    actions?: ToolActionAllowlist | null,
    model?: string,
    firstRound?: boolean
  ): ToolSchemaProjection[];
  toToolSchemasForActions?(
    actions?: ToolActionAllowlist | null,
    model?: string
  ): ToolSchemaProjection[];
  toMixedSchemas?(
    ids?: readonly string[] | null,
    model?: string,
    firstRound?: boolean
  ): ToolSchemaProjection[];
  toToolSchemasForModel?(ids?: readonly string[] | null, model?: string): ToolSchemaProjection[];
  toToolSchemas?(ids?: readonly string[] | null): ToolSchemaProjection[];
}

interface QueriedSchema {
  name: string;
  parameters: Record<string, unknown>;
  source: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSynchronousResult(value: unknown, method: string): void {
  if (!isThenable(value)) {
    return;
  }
  // 下面同步拒绝违约端口；这里只观察 Promise 的迟到失败，不能等待它并开放工具。
  observeSafely(
    () => value,
    () => undefined
  );
  throw new Error(`Schema query method ${method} must return synchronously`);
}

function readSchemas(value: unknown, error: string): QueriedSchema[] {
  if (!Array.isArray(value)) {
    throw new Error(error);
  }
  // Array.from 固定成员并保留 holes 的 undefined 事实，不能用 every 跳过坏条目。
  return Array.from(value, (schema: unknown) => {
    if (!record(schema)) {
      throw new Error(error);
    }
    // JS 宿主可能用 getter 生成字段；后续必须消费已校验值，不能再次读取原条目。
    // 此处只读取既有校验字段；未选工具的 description/metadata getter 不参与查询。
    const { name, parameters } = schema;
    if (typeof name !== 'string' || !record(parameters)) {
      throw new Error(error);
    }
    return { name, parameters, source: schema };
  });
}

function readModernResult(value: unknown): Omit<ToolSchemaQueryResult, 'schemas'> & {
  schemas: QueriedSchema[];
} {
  assertSynchronousResult(value, 'querySchemas');
  if (!record(value)) {
    throw new Error('Invalid ToolSchemaQueryPort result');
  }
  const schemas = readSchemas(value.schemas, 'Invalid ToolSchemaQueryPort result');
  const hostActions = value.allowedTools;
  if (!record(hostActions)) {
    throw new Error('Invalid ToolSchemaQueryPort result');
  }
  // 在类型校验前捕获动作值和数组成员；重复校验原 getter 会把 [] 读成后来的 null 全开放。
  const allowedTools = Object.fromEntries(
    Object.entries(hostActions).map(([tool, actions]) => [
      tool,
      Array.isArray(actions) ? Array.from(actions) : actions,
    ])
  );
  if (!isToolActionAllowlist(allowedTools)) {
    throw new Error('Invalid ToolSchemaQueryPort result');
  }
  const unavailable = value.unavailable;
  if (unavailable === undefined) {
    return { schemas, allowedTools };
  }
  if (!Array.isArray(unavailable)) {
    throw new Error('Invalid ToolSchemaQueryPort unavailable reasons');
  }
  const reasons = Array.from(unavailable, (entry: unknown) => {
    if (!record(entry)) {
      throw new Error('Invalid ToolSchemaQueryPort unavailable reasons');
    }
    const { tool, reason, action, operation, ...extensions } = entry;
    if (
      typeof tool !== 'string' ||
      typeof reason !== 'string' ||
      (action !== undefined && typeof action !== 'string') ||
      (operation !== undefined && typeof operation !== 'string')
    ) {
      throw new Error('Invalid ToolSchemaQueryPort unavailable reasons');
    }
    return {
      ...extensions,
      tool,
      reason,
      ...('action' in entry ? { action } : {}),
      ...('operation' in entry ? { operation } : {}),
    };
  });
  return { schemas, allowedTools, unavailable: reasons };
}

function narrowSchemas(
  schemas: ToolSchemaProjection[],
  actions: ToolActionAllowlist
): ToolSchemaProjection[] {
  return schemas
    .map((schema) => {
      const allowed = actions[schema.name];
      const properties = schema.parameters.properties;
      if (
        allowed == null ||
        !record(properties) ||
        !record(properties.action) ||
        !Array.isArray(properties.action.enum)
      ) {
        return schema;
      }
      // 旧 provider 只有按 id 查询时也不能广告阶段明确禁用的 envelope action；泛型 flat schema 保留。
      const values = properties.action.enum.filter(
        (value) => typeof value === 'string' && allowed.includes(value)
      );
      return {
        ...schema,
        parameters: {
          ...schema.parameters,
          properties: { ...properties, action: { ...properties.action, enum: values } },
        },
      };
    })
    .filter((schema) => {
      const properties = schema.parameters.properties;
      return (
        !record(properties) ||
        !record(properties.action) ||
        !Array.isArray(properties.action.enum) ||
        properties.action.enum.length > 0
      );
    });
}

/** 两类端口共用最终投影；旧端口没有额外有效动作集，仍必须服从调用前的 selection。 */
function projectQueryResult(
  selection: ToolSelection,
  schemas: QueriedSchema[],
  hostActions?: ToolActionAllowlist
): ToolSchemaQueryResult {
  const requested = selectToolActions(
    selection,
    schemas.map((schema) => schema.name)
  );
  const allowedTools = hostActions ? intersectToolActions(requested, hostActions) : requested;
  const selected = schemas
    .filter(({ name }) => Object.hasOwn(allowedTools, name))
    .map(({ name, parameters, source }) => {
      // 只展开实际入选的声明，已校验字段不再触碰原 getter；扩展值保持原引用。
      const projection = Object.fromEntries(
        Object.keys(source)
          .filter((key) => key !== 'name' && key !== 'parameters')
          .map((key) => [key, source[key]])
      );
      if (!Object.hasOwn(projection, 'description') && 'description' in source) {
        projection.description = source.description;
      }
      // 旧宿主允许省略 description；不在本次声明快照中收紧这个兼容合同。
      return { ...projection, name, parameters } as ToolSchemaProjection;
    });
  const narrowed = narrowSchemas(selected, allowedTools);
  return {
    schemas: narrowed,
    allowedTools: selectToolActions(
      allowedTools,
      narrowed.map((schema) => schema.name)
    ),
  };
}

export function queryToolSchemas(
  catalog: unknown,
  query: ToolSchemaQuery,
  onLegacy: (method: string) => void
): ToolSchemaQueryResult {
  // 宿主投影和诊断都可能改写入参；授权只看调用前的自有快照，不重新读取外部 query。
  const selection = snapshotToolSelection(query.selection);
  // 仅复制声明数据；runtime 内的 ledger/coordinator 等活跃资源仍保持原身份。
  const portQuery = { ...query, selection: structuredClone(selection) };
  if (!record(catalog)) {
    return { schemas: [], allowedTools: {} };
  }
  if (typeof catalog.querySchemas === 'function') {
    const result = readModernResult(catalog.querySchemas(portQuery));
    return {
      ...projectQueryResult(selection, result.schemas, result.allowedTools),
      ...(result.unavailable !== undefined ? { unavailable: result.unavailable } : {}),
    };
  }
  const schemas = queryLegacySchemas(catalog, portQuery, onLegacy);
  return schemas === null
    ? { schemas: [], allowedTools: {} }
    : projectQueryResult(selection, schemas);
}

/** 保持旧端口条件优先级与 this；不尝试用另一个旧方法掩盖已选端口的失败。 */
function queryLegacySchemas(
  legacy: LegacySchemaCatalog,
  query: ToolSchemaQuery,
  onLegacy: (method: string) => void
): QueriedSchema[] | null {
  const actions =
    query.selection && !Array.isArray(query.selection)
      ? (query.selection as ToolActionAllowlist)
      : undefined;
  const ids = Array.isArray(query.selection)
    ? query.selection
    : actions
      ? Object.keys(actions).filter((id) => actions[id] == null || (actions[id]?.length ?? 0) > 0)
      : null;
  let value: unknown;
  let method: string;
  // full 是显式投影要求；有可用完整端口时不能因旧方法探测顺序而选中 mixed。
  // 只有 mixed 的旧宿主继续可用，但必须报告降级；默认/mixed 保留原有优先级。
  const fullRequested = query.mode === 'full';
  const preferMixed =
    !fullRequested ||
    !(
      (actions && typeof legacy.toToolSchemasForActions === 'function') ||
      (query.model && typeof legacy.toToolSchemasForModel === 'function') ||
      typeof legacy.toToolSchemas === 'function'
    );
  if (preferMixed && typeof legacy.toMixedSchemasForActions === 'function' && actions) {
    method = 'toMixedSchemasForActions';
    value = legacy.toMixedSchemasForActions(actions, query.model, query.firstRound);
  } else if (typeof legacy.toToolSchemasForActions === 'function' && actions) {
    method = 'toToolSchemasForActions';
    value = legacy.toToolSchemasForActions(actions, query.model);
  } else if (preferMixed && typeof legacy.toMixedSchemas === 'function') {
    method = 'toMixedSchemas';
    value = legacy.toMixedSchemas(ids, query.model, query.firstRound);
  } else if (query.model && typeof legacy.toToolSchemasForModel === 'function') {
    method = 'toToolSchemasForModel';
    value = legacy.toToolSchemasForModel(ids, query.model);
  } else if (typeof legacy.toToolSchemas === 'function') {
    method = 'toToolSchemas';
    value = legacy.toToolSchemas(ids);
  } else {
    return null;
  }
  assertSynchronousResult(value, method);
  // 兼容路径通知只做观察；日志失败不能改变查询结果，也不能逃逸为未处理拒绝。
  observeSafely(
    () => onLegacy(method),
    () =>
      Logger.getInstance().warn(
        '[ToolSchemaQuery] legacy_diagnostic_failed; query result and authorization retained'
      )
  );
  const schemas = readSchemas(value, `Invalid legacy schema result from ${method}`);
  if (fullRequested && method.startsWith('toMixed')) {
    observeSafely(
      () =>
        Logger.getInstance().warn(
          `[ToolSchemaQuery] legacy_mode_degraded; requestedMode=full selectedMode=mixed method=${method}; authorization remains narrowed`
        ),
      () => undefined
    );
  }
  return schemas;
}
