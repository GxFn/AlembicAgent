import type { ToolAvailabilitySnapshot } from '#tools/kernel/availability.js';
import type { ToolAction, ToolRegistry } from '#tools/kernel/registry.js';
import type { ToolSelection } from '#tools/kernel/toolSchema.js';
import { isToolActionAllowed, normalizeToolActions } from '#tools/kernel/toolSelection.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function freezeSchema(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeSchema(child);
    }
    Object.freeze(value);
  }
}

function projectAction(
  tool: string,
  name: string,
  action: ToolAction,
  constraints?: Readonly<Record<string, readonly string[]>>
): ToolAction | null {
  // 只复制 JSON schema；真实 handler 函数既不克隆也不冻结。
  const params = JSON.parse(JSON.stringify(action.params)) as Record<string, unknown>;
  const properties = record(params.properties);
  const descriptions: string[] = [];
  for (const [parameter, requested] of Object.entries(constraints || {})) {
    if (requested.length === 0) {
      return null;
    }
    if (!properties || !Object.hasOwn(properties, parameter)) {
      continue;
    }
    const property = record(properties[parameter]);
    if (!property) {
      continue;
    }
    const declared = Array.isArray(property.enum) ? property.enum : null;
    const values = [...new Set(requested)].filter((value) => !declared || declared.includes(value));
    if (values.length === 0) {
      return null;
    }
    descriptions.push(`${parameter}: ${values.join(', ')}`);
    const projectedProperty: Record<string, unknown> = { ...property, enum: values };
    if (Object.hasOwn(property, 'default') && !values.includes(String(property.default))) {
      // 宿主不支持默认分支时必须显式选择；多动作schema通过逐动作required说明保留该约束。
      delete projectedProperty.default;
      projectedProperty.description = `Choose one of ${values.join(', ')} explicitly; the default branch is unavailable from this host.`;
      const required = Array.isArray(params.required) ? params.required : [];
      params.required = [...new Set([...required, parameter])];
    }
    properties[parameter] = projectedProperty;
  }
  freezeSchema(params);
  const summary =
    descriptions.length > 0 ? `${tool}.${name} — ${descriptions.join('; ')}` : action.summary;
  return Object.freeze({
    ...action,
    params,
    summary,
    ...(descriptions.length > 0
      ? { description: `${summary}. Only the listed branches are available from this host.` }
      : {}),
  });
}

/**
 * 注册表的不可变调用视图：选择是完整授权集，availability.actions 是稀疏附加约束。
 * 视图保留 handler 引用；宿主分支只缩窄参数枚举，不修改全局规格或复制业务规则。
 */
export function createToolRegistryView(
  registry: ToolRegistry,
  selection?: ToolSelection,
  availability?: ToolAvailabilitySnapshot
): ToolRegistry {
  const selected = normalizeToolActions(
    selection,
    Object.fromEntries(
      Object.entries(registry).map(([tool, spec]) => [tool, Object.keys(spec.actions)])
    )
  );
  const entries: Array<[string, ToolRegistry[string]]> = [];
  for (const [tool, names] of Object.entries(selected)) {
    const spec = registry[tool];
    const actionEntries: Array<[string, ToolAction]> = [];
    let narrowedParameters = false;
    for (const name of names) {
      if (
        availability &&
        Object.hasOwn(availability.actions, tool) &&
        !isToolActionAllowed(availability.actions, tool, name)
      ) {
        continue;
      }
      const projected = projectAction(
        tool,
        name,
        spec.actions[name],
        availability?.parameters?.[tool]?.[name]
      );
      if (projected) {
        actionEntries.push([name, projected]);
        narrowedParameters ||= projected.description !== spec.actions[name].description;
      }
    }
    if (actionEntries.length === 0) {
      continue;
    }
    const actions = Object.freeze(Object.fromEntries(actionEntries));
    const restricted =
      actionEntries.length !== Object.keys(spec.actions).length || narrowedParameters;
    entries.push([
      tool,
      Object.freeze({
        ...spec,
        actions,
        ...(restricted
          ? {
              description: `${spec.name} actions: ${actionEntries.map(([name, action]) => `${name}: ${action.summary}`).join('; ')}`,
            }
          : {}),
      }),
    ]);
  }
  return Object.freeze(Object.fromEntries(entries));
}
