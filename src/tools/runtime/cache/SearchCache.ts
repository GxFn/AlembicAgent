/**
 * @module tools/runtime/cache/SearchCache
 *
 * 搜索结果 LRU 缓存。避免同一会话中重复搜索相同 pattern。
 */

export interface SearchCacheEntry {
  result: unknown;
  createdAt: number;
}

export class SearchCache {
  readonly #cache = new Map<string, SearchCacheEntry>();
  readonly #maxEntries: number;

  constructor(maxEntries = 100) {
    // 0显式禁用缓存；非法容量在构造边界拒绝，避免NaN/Infinity变成无界保留。
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError('SearchCache maxEntries must be a non-negative safe integer');
    }
    this.#maxEntries = maxEntries;
  }

  /** 实例内的不透明键；独立编码各分量，pattern/glob中的分隔符不能串成同一个搜索。 */
  static makeKey(pattern: string, glob?: string, regex?: boolean): string {
    return JSON.stringify([pattern, glob ?? '', Boolean(regex)]);
  }

  get(key: string): unknown | undefined {
    const entry = this.#cache.get(key);
    if (!entry) {
      return undefined;
    }
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.result;
  }

  set(key: string, result: unknown): void {
    this.#cache.delete(key);
    this.#cache.set(key, { result, createdAt: Date.now() });
    if (this.#cache.size > this.#maxEntries) {
      const firstKey = this.#cache.keys().next().value;
      if (firstKey !== undefined) {
        this.#cache.delete(firstKey);
      }
    }
  }

  has(key: string): boolean {
    return this.#cache.has(key);
  }

  clear(): void {
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }
}
