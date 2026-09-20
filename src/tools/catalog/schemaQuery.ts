/** 新查询端口的唯一消费入口；旧方法探测保留在这一处兼容，不散落在 Runtime。 */
import type {
  ToolActionAllowlist,
  ToolSchemaProjection,
  ToolSchemaQuery,
  ToolSchemaQueryResult,
} from '#tools/kernel/toolSchema.js';
import {
  intersectToolActions,
  isToolActionAllowlist,
  selectToolActions,
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchemas(value: unknown): value is ToolSchemaProjection[] {
  return (
    Array.isArray(value) &&
    value.every(
      (schema) => record(schema) && typeof schema.name === 'string' && record(schema.parameters)
    )
  );
}

function narrowSchemas(
  schemas: ToolSchemaProjection[],
  actions: ToolActionAllowlist
): ToolSchemaProjection[] {
  return schemas
    .filter((schema) => Object.hasOwn(actions, schema.name))
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

export function queryToolSchemas(
  catalog: unknown,
  query: ToolSchemaQuery,
  onLegacy: (method: string) => void
): ToolSchemaQueryResult {
  if (!record(catalog)) {
    return { schemas: [], allowedTools: {} };
  }
  if (typeof catalog.querySchemas === 'function') {
    const result: unknown = catalog.querySchemas(query);
    if (
      !record(result) ||
      !isSchemas(result.schemas) ||
      !isToolActionAllowlist(result.allowedTools)
    ) {
      throw new Error('Invalid ToolSchemaQueryPort result');
    }
    if (
      result.unavailable !== undefined &&
      (!Array.isArray(result.unavailable) ||
        !result.unavailable.every(
          (entry) =>
            record(entry) &&
            typeof entry.tool === 'string' &&
            typeof entry.reason === 'string' &&
            (entry.action === undefined || typeof entry.action === 'string') &&
            (entry.operation === undefined || typeof entry.operation === 'string')
        ))
    ) {
      throw new Error('Invalid ToolSchemaQueryPort unavailable reasons');
    }
    const requested = selectToolActions(
      query.selection,
      result.schemas.map((schema) => schema.name)
    );
    const allowedTools = intersectToolActions(requested, result.allowedTools);
    const schemas = narrowSchemas(result.schemas, allowedTools);
    return {
      schemas,
      allowedTools: selectToolActions(
        allowedTools,
        schemas.map((schema) => schema.name)
      ),
      ...(Array.isArray(result.unavailable)
        ? { unavailable: result.unavailable as ToolSchemaQueryResult['unavailable'] }
        : {}),
    };
  }

  const legacy = catalog as LegacySchemaCatalog;
  const actions =
    query.selection && !Array.isArray(query.selection)
      ? (query.selection as ToolActionAllowlist)
      : undefined;
  const ids = Array.isArray(query.selection)
    ? query.selection
    : actions
      ? Object.keys(actions).filter((id) => actions[id] == null || (actions[id]?.length ?? 0) > 0)
      : null;
  let schemas: ToolSchemaProjection[];
  let method: string;
  if (typeof legacy.toMixedSchemasForActions === 'function' && actions) {
    method = 'toMixedSchemasForActions';
    schemas = legacy.toMixedSchemasForActions(actions, query.model, query.firstRound);
  } else if (typeof legacy.toToolSchemasForActions === 'function' && actions) {
    method = 'toToolSchemasForActions';
    schemas = legacy.toToolSchemasForActions(actions, query.model);
  } else if (typeof legacy.toMixedSchemas === 'function') {
    method = 'toMixedSchemas';
    schemas = legacy.toMixedSchemas(ids, query.model, query.firstRound);
  } else if (query.model && typeof legacy.toToolSchemasForModel === 'function') {
    method = 'toToolSchemasForModel';
    schemas = legacy.toToolSchemasForModel(ids, query.model);
  } else if (typeof legacy.toToolSchemas === 'function') {
    method = 'toToolSchemas';
    schemas = legacy.toToolSchemas(ids);
  } else {
    return { schemas: [], allowedTools: {} };
  }
  onLegacy(method);
  if (!isSchemas(schemas)) {
    throw new Error(`Invalid legacy schema result from ${method}`);
  }
  const allowedTools = selectToolActions(
    query.selection,
    schemas.map((schema) => schema.name)
  );
  const narrowed = narrowSchemas(schemas, allowedTools);
  return {
    schemas: narrowed,
    allowedTools: selectToolActions(
      allowedTools,
      narrowed.map((schema) => schema.name)
    ),
  };
}
