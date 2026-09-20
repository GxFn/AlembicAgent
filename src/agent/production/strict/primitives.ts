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

export function hashCoreCanonical(value: unknown): string {
  return `sha256:${hashCanonical(value)}`;
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
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
