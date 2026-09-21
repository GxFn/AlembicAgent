import type { ToolActionAllowlist, ToolSelection } from './toolSchema.js';

/** 动作和参数枚举共用字符串列表校验；Array.from 保留 holes 的非法 undefined 事实。 */
export function isToolStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && Array.from(value).every((item) => typeof item === 'string');
}

/** 仅验证显式动作合同；非法声明不能回落旧 tools 列表扩大权限。 */
export function isToolActionAllowlist(value: unknown): value is ToolActionAllowlist {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((actions) => actions == null || isToolStringList(actions))
  );
}

/**
 * 在调用宿主查询前固定授权事实；只复制声明，不克隆 runtime 资源。
 * 顶层 null/undefined 是 selection 的不限制语义，不能用于验证完整 allowlist 合同。
 */
export function snapshotToolSelection(selection: ToolSelection): ToolSelection {
  if (selection == null) {
    return selection;
  }
  if (isToolStringList(selection)) {
    return Object.freeze([...selection]);
  }
  if (!isToolActionAllowlist(selection)) {
    throw new Error('Invalid tool selection: expected tool ids or an action allowlist');
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(selection).map(([tool, actions]) => [
        tool,
        actions == null ? actions : Object.freeze([...actions]),
      ])
    )
  );
}

/** 泛型工具只按注册 id 选择，不为其 flat schema 臆造动作词汇。 */
export function selectToolActions(
  selection: ToolSelection,
  registeredTools: readonly string[]
): ToolActionAllowlist {
  const snapshot = snapshotToolSelection(selection);
  const ids = Array.isArray(snapshot) ? new Set(snapshot) : null;
  const selected = snapshot as ToolActionAllowlist | null | undefined;
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
  if (!isToolActionAllowlist(allowlist) || !Object.hasOwn(allowlist, tool)) {
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
  if (!isToolActionAllowlist(left) || !isToolActionAllowlist(right)) {
    throw new Error('Invalid tool action allowlist');
  }
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
