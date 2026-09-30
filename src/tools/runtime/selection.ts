import type { ToolAvailabilitySnapshot } from '#tools/kernel/availability.js';
import type { ToolAction, ToolRegistry } from '#tools/kernel/registry.js';
import type { ToolSelection } from '#tools/kernel/toolSchema.js';
import {
  isToolActionAllowed,
  isToolStringList,
  normalizeToolActions,
  snapshotToolActionAllowlist,
} from '#tools/kernel/toolSelection.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 每次查询/准入固定当前宿主约束，再校验同一份声明；不跨排队等待缓存授权。
 * 字符串是原有的拒绝原因，undefined 仍表示宿主没有额外约束。
 */
export function readToolAvailability(
  availability: ToolAvailabilitySnapshot | undefined
): ToolAvailabilitySnapshot | string | undefined {
  if (availability === undefined) {
    return undefined;
  }
  const source = record(availability);
  const actions = source ? snapshotToolActionAllowlist(source.actions, 'own') : null;
  if (!source || !actions) {
    return 'Invalid tool availability: expected an action allowlist';
  }
  const declaredParameters = source.parameters;
  const parameters =
    declaredParameters === undefined ? undefined : readParameterEnums(declaredParameters, 2);
  if (parameters === null) {
    return 'Invalid tool availability: expected parameter string enums';
  }
  return {
    actions,
    ...(parameters !== undefined
      ? {
          parameters: parameters as NonNullable<ToolAvailabilitySnapshot['parameters']>,
        }
      : {}),
    // 诊断不参与授权；保持原来仅在消费者需要原因时才读取，不触发无关宿主 getter。
    get unavailable() {
      return availability.unavailable;
    },
  };
}

/** 固定 tool/action/parameter 三层字典；叶子只能是字符串枚举，不接受 null 通配。 */
function readParameterEnums(value: unknown, depth: number): Record<string, unknown> | null {
  const source = record(value);
  if (!source) {
    return null;
  }
  const snapshot: Record<string, unknown> = {};
  for (const [key, enumerable] of parameterKeys(source, depth)) {
    const declared = source[key];
    if (depth === 0) {
      const values = Array.isArray(declared) ? Array.from(declared) : declared;
      if (!isToolStringList(values)) {
        return null;
      }
      Object.defineProperty(snapshot, key, { value: Object.freeze(values), enumerable });
    } else {
      const nested = readParameterEnums(declared, depth - 1);
      if (nested === null) {
        return null;
      }
      Object.defineProperty(snapshot, key, { value: nested, enumerable });
    }
  }
  return Object.freeze(snapshot);
}

/** tool/action 按属性寻址，末层参数按 entries 枚举；保留原可访问限制及枚举性。 */
function parameterKeys(source: Record<string, unknown>, depth: number): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  if (depth === 0) {
    for (const key of Object.keys(source)) {
      keys.set(key, true);
    }
    return keys;
  }
  for (
    let owner: object | null = source;
    owner && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner)
  ) {
    for (const key of Object.getOwnPropertyNames(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      // class 的默认 constructor 不是参数约束；其余可访问的数据仍必须通过枚举合同。
      if (owner !== source && key === 'constructor' && typeof descriptor?.value === 'function') {
        continue;
      }
      if (!keys.has(key)) {
        keys.set(key, descriptor?.enumerable === true);
      }
    }
  }
  return keys;
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
  declaredAvailability?: ToolAvailabilitySnapshot
): ToolRegistry {
  const availability = readToolAvailability(declaredAvailability);
  if (typeof availability === 'string') {
    throw new Error(availability);
  }
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
