import type { ToolActionAllowlist, ToolSelection } from './toolSchema.js';

/** 仅验证显式动作合同；非法声明不能回落旧 tools 列表扩大权限。 */
export function isToolActionAllowlist(value: unknown): value is ToolActionAllowlist {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (actions) =>
        actions == null ||
        (Array.isArray(actions) && actions.every((action) => typeof action === 'string'))
    )
  );
}

/** 泛型工具只按注册 id 选择，不为其 flat schema 臆造动作词汇。 */
export function selectToolActions(
  selection: ToolSelection,
  registeredTools: readonly string[]
): ToolActionAllowlist {
  const ids = Array.isArray(selection) ? new Set(selection) : null;
  const selected = selection as ToolActionAllowlist | null | undefined;
  const entries: Array<[string, readonly string[] | null]> = [];
  for (const tool of registeredTools) {
    if (ids ? !ids.has(tool) : selected != null && !Object.hasOwn(selected, tool)) {
      continue;
    }
    const actions = ids || selected == null ? null : selected[tool];
    if (actions == null) {
      entries.push([tool, null]);
    } else if (actions.length > 0) {
      entries.push([tool, Object.freeze([...new Set(actions)])]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** 按真实注册动作归一化；只读快照不借用调用方数组，未知项和空动作集不进入结果。 */
export function normalizeToolActions(
  selection: ToolSelection,
  availableActions: Readonly<Record<string, readonly string[]>>
): Readonly<Record<string, readonly string[]>> {
  const selected = selectToolActions(selection, Object.keys(availableActions));
  const entries: Array<[string, readonly string[]]> = [];
  for (const [tool, requested] of Object.entries(selected)) {
    const registered = availableActions[tool];
    const actions =
      requested == null
        ? [...registered]
        : requested.filter((action) => registered.includes(action));
    if (actions.length > 0) {
      entries.push([tool, Object.freeze([...new Set(actions)])]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** 工具键必须显式存在；缺 action 只询问该工具是否有至少一个可用动作。 */
export function isToolActionAllowed(
  allowlist: ToolActionAllowlist,
  tool: string,
  action?: string
): boolean {
  if (!Object.hasOwn(allowlist, tool)) {
    return false;
  }
  const actions = allowlist[tool];
  return (
    actions == null || (actions.length > 0 && (action === undefined || actions.includes(action)))
  );
}

/** 两份完整授权集求交；稀疏宿主约束应先补齐未约束工具，不能把缺键误作允许。 */
export function intersectToolActions(
  left: ToolActionAllowlist,
  right: ToolActionAllowlist
): ToolActionAllowlist {
  const entries: Array<[string, readonly string[] | null]> = [];
  for (const [tool, leftActions] of Object.entries(left)) {
    if (!Object.hasOwn(right, tool)) {
      continue;
    }
    const rightActions = right[tool];
    const actions =
      leftActions == null
        ? rightActions
        : rightActions == null
          ? leftActions
          : leftActions.filter((action) => rightActions.includes(action));
    if (actions == null) {
      entries.push([tool, null]);
    } else if (actions.length > 0) {
      entries.push([tool, Object.freeze([...new Set(actions)])]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}
