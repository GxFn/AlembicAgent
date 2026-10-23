/**
 * @module tools/runtime/cache/SearchCache
 *
 * 搜索结果 LRU 缓存。避免同一会话中重复搜索相同 pattern。
 *
 * 公开面只保留构造、get/set、clear 与 size（W2a-03 / L4-P33）：键对缓存不透明，由 code.search
 * 自己按 projectRoot、缓存代数与各搜索参数结构化编码；旧的 makeKey 与真实键维度不一致、has 与
 * 条目上的 createdAt 都没有读取方，已删除。淘汰只按 LRU 顺序与容量，不按时间。
 */

export interface SearchCacheEntry {
  result: unknown;
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
    this.#cache.set(key, { result });
    if (this.#cache.size > this.#maxEntries) {
      const firstKey = this.#cache.keys().next().value;
      if (firstKey !== undefined) {
        this.#cache.delete(firstKey);
      }
    }
  }

  clear(): void {
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }
}
