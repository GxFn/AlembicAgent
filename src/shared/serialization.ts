// 会话缓存的稳定键：对象键排序，数组次序保持；不用于 Core 权威收据哈希。
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value instanceof Set) {
    return stableStringify([...value].sort());
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right))
    );
    return stableStringify(entries);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
