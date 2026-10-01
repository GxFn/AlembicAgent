/** Strict V1内部ID、hash、错误和深冻结工具；编码属于既有回执合同，不与相似函数机械互换。 */
import { createHash } from 'node:crypto';

export function assertSameIds(
  actual: readonly string[],
  expected: readonly string[],
  code: string
): void {
  const left = normalizeIds(actual, `${code}:actual`);
  const right = normalizeIds(expected, `${code}:expected`);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(code);
  }
}

export function assertContainsIds(
  actual: readonly string[],
  expected: readonly string[],
  code: string
): void {
  const available = new Set(normalizeIds(actual, `${code}:actual`));
  if (normalizeIds(expected, `${code}:expected`).some((value) => !available.has(value))) {
    fail(code);
  }
}

export function normalizeIds(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    fail('STRICT_ID_SET_INVALID', field);
  }
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  if (normalized.length !== values.length || new Set(normalized).size !== normalized.length) {
    fail('STRICT_ID_SET_INVALID', field);
  }
  return normalized;
}

export function requireText(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(code);
  }
}

export function requireCoreHash(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(code);
  }
}

export function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortCanonical(value)))
    .digest('hex');
}

/**
 * 与 Core `hashCanonicalJson` 逐字节一致的哈希，用于跨仓交叉校验的值
 * （校验 Core 生成的 fixpointHash；生成由 Core 复算的 authoredFingerprint）。
 *
 * 键按 UTF-16 码元序（`Array.prototype.sort` 默认序）排列，与 Core 的
 * `Object.keys().sort()` 相同，不随运行环境的 locale/ICU 变化。不能借用下方仓内
 * `hashCanonical` 的排序规则顺序：两者在 `refs`/`refSet` 这类键对上不同。
 * Core 尚未从公开子路径导出该实现；导出后应改为直接消费，删除这份镜像。
 */
export function hashCoreCanonical(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortCoreCanonical(value)))
    .digest('hex')}`;
}

function sortCoreCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCoreCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  // Object.fromEntries 以自有数据属性写入，`__proto__` 作为普通键保留（与 Core 一致）。
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortCoreCanonical((value as Record<string, unknown>)[key])])
  );
}

/**
 * 仓内自用哈希的键排序。已有持久化的 epoch/lineage/expression 哈希依赖 localeCompare 的
 * 顺序（与码元序不同，例如 `clusters` 排在 `clusterSetHash` 之前），改成码元序会让旧数据
 * 校验失败，需要配套的数据迁移决定，因此顺序保持不变。
 *
 * 排序规则固定为 en：英文、中文环境下与不带参数的历史结果完全相同，同时不再随进程默认
 * 区域变化（匈牙利语、丹麦语等区域对 ASCII 标识符的排序不同）。
 */
function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      // 固定 en 排序规则：与历史哈希逐字节一致，且不随进程默认区域变化。
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, sortCanonical(child)])
  );
}

export function freeze<T>(value: T, visited = new WeakSet<object>()): T {
  // 已冻住容器不代表子记录不可变；独立访问集合也避免共享引用/循环重复遍历。
  if (value && typeof value === 'object' && !visited.has(value)) {
    visited.add(value);
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freeze(child, visited);
    }
  }
  return value;
}
