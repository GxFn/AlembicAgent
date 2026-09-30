import type { ToolActionAllowlist, ToolSelection } from './toolSchema.js';

/** 动作和参数枚举共用字符串列表校验；Array.from 保留 holes 的非法 undefined 事实。 */
export function isToolStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && Array.from(value).every((item) => typeof item === 'string');
}

/**
 * 完整动作声明的单次读取边界；非法形状返回 null，entry 的 null/undefined 通配语义保留。
 * 先复制每个值及数组成员再校验，不能先验证 getter、后消费它变化后的第二个值。
 * 空动作项与原键顺序必须保留，Runtime 的多能力并集仍需要它们的插入位置。
 */
export function snapshotToolActionAllowlist(
  value: unknown,
  keys: 'enumerable' | 'own' = 'enumerable'
): ToolActionAllowlist | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const snapshot: Record<string, readonly string[] | null | undefined> = {};
  const names = keys === 'own' ? Object.getOwnPropertyNames(source) : Object.keys(source);
  for (const tool of names) {
    const declared = source[tool];
    const actions = Array.isArray(declared) ? Array.from(declared) : declared;
    if (actions != null && !isToolStringList(actions)) {
      return null;
    }
    // 准入按 hasOwn 读取隐藏键，目录/能力收集只枚举可见声明；不能把隐藏键改成广告工具。
    Object.defineProperty(snapshot, tool, {
      value: Array.isArray(actions) ? Object.freeze(actions) : actions,
      enumerable: Object.getOwnPropertyDescriptor(source, tool)?.enumerable === true,
    });
  }
  return Object.freeze(snapshot);
}

/**
 * 在调用宿主查询前固定授权事实；只复制声明，不克隆 runtime 资源。
 * 顶层 null/undefined 是 selection 的不限制语义，不能用于验证完整 allowlist 合同。
 */
export function snapshotToolSelection(selection: ToolSelection): ToolSelection {
  if (selection == null) {
    return selection;
  }
  if (Array.isArray(selection)) {
    const ids = Array.from(selection);
    if (isToolStringList(ids)) {
      return Object.freeze(ids);
    }
  } else {
    const actions = snapshotToolActionAllowlist(selection);
    if (actions) {
      return actions;
    }
  }
  throw new Error('Invalid tool selection: expected tool ids or an action allowlist');
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
  const snapshot = snapshotToolActionAllowlist(allowlist, 'own');
  if (!snapshot || !Object.hasOwn(snapshot, tool)) {
    return false;
  }
  const actions = snapshot[tool];
  return (
    actions == null || (actions.length > 0 && (action === undefined || actions.includes(action)))
  );
}

/** 两份完整授权集求交；稀疏宿主约束应先补齐未约束工具，不能把缺键误作允许。 */
export function intersectToolActions(
  left: ToolActionAllowlist,
  right: ToolActionAllowlist
): ToolActionAllowlist {
  const leftSnapshot = snapshotToolActionAllowlist(left);
  if (!leftSnapshot) {
    throw new Error('Invalid tool action allowlist');
  }
  const rightSnapshot = snapshotToolActionAllowlist(right, 'own');
  if (!rightSnapshot) {
    throw new Error('Invalid tool action allowlist');
  }
  const entries: Array<[string, readonly string[] | null]> = [];
  for (const [tool, leftActions] of Object.entries(leftSnapshot)) {
    if (!Object.hasOwn(rightSnapshot, tool)) {
      continue;
    }
    const rightActions = rightSnapshot[tool];
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
