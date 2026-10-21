/**
 * L6-P3r4：findSimilar 的调用方分词缓存（options.tokenCache）与补充 token 伴随结果的生命周期。
 *
 * 第三轮修复把补充 token 结果存在以调用方 Map 为键的 WeakMap 伴随缓存里：调用方 clear() 之后伴随缓存不释放，
 * 且纯 ASCII 文本会因为引用比较失配被错误地记成 script-supplement 诊断。
 * 需要 better-sqlite3 原生模块能在当前 Node 下加载。
 */
import Logger from '@alembic/core/logging';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/agent/memory/MemoryStore.js';

const SUPPLEMENT_LOG = 'script-supplement tokens';

afterEach(() => {
  vi.restoreAllMocks();
});

function supplementLogs(debug: ReturnType<typeof vi.spyOn>): string[] {
  return debug.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes(SUPPLEMENT_LOG));
}

describe('MemoryStore.findSimilar token cache lifecycle (L6-P3r4)', () => {
  it('does not report script-supplement scoring for ASCII text after the caller clears its cache', () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      store.add({ type: 'fact', content: 'use tabs instead of spaces' });
      const cache = new Map<string, Set<string>>();
      const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);

      const first = store.findSimilar('use tabs not spaces', 'fact', 5, { tokenCache: cache });
      expect(first).toHaveLength(1);
      const score = first[0].similarity ?? 0;
      expect(score).toBeGreaterThan(0.1);
      expect(supplementLogs(debug)).toEqual([]);

      cache.clear();
      debug.mockClear();
      const second = store.findSimilar('use tabs not spaces', 'fact', 5, { tokenCache: cache });
      expect(second[0].similarity).toBe(score);
      expect(supplementLogs(debug)).toEqual([]);

      // 之后不再 clear 的查询同样不能被误标。
      debug.mockClear();
      store.findSimilar('use tabs not spaces', 'fact', 5, { tokenCache: cache });
      expect(supplementLogs(debug)).toEqual([]);

      // 对照：真正含 Core 覆盖范围外文字的查询仍记一条汇总诊断。
      debug.mockClear();
      store.findSimilar('используй tabs вместо spaces', 'fact', 5, { tokenCache: cache });
      expect(supplementLogs(debug)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('keeps scores identical across cache reuse, cache.delete and a fresh cache', () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      store.add({ type: 'fact', content: 'используй Zustand для глобального состояния' });
      store.add({ type: 'fact', content: 'use tabs instead of spaces' });
      const query = 'никогда не храни токены в Zustand';
      const cache = new Map<string, Set<string>>();
      const fresh = store.findSimilar(query, 'fact', 5).map((row) => row.similarity);
      const cached = store.findSimilar(query, 'fact', 5, { tokenCache: cache });
      expect(cached.map((row) => row.similarity)).toEqual(fresh);
      cache.delete(query.toLowerCase());
      expect(
        store.findSimilar(query, 'fact', 5, { tokenCache: cache }).map((row) => row.similarity)
      ).toEqual(fresh);
      cache.clear();
      expect(
        store.findSimilar(query, 'fact', 5, { tokenCache: cache }).map((row) => row.similarity)
      ).toEqual(fresh);
    } finally {
      db.close();
    }
  });

  /**
   * 在独立函数里填充缓存并只带 WeakRef 回来：测试函数自己的栈帧不能持有任何 Core 分词 Set，
   * 否则回收断言测的是测试代码而不是 MemoryStore。
   */
  function fillCache(
    store: MemoryStore,
    cache: Map<string, Set<string>>,
    queries: string[]
  ): WeakRef<Set<string>>[] {
    const refs: WeakRef<Set<string>>[] = [];
    for (const query of queries) {
      store.findSimilar(query, 'fact', 5, { tokenCache: cache });
      const tokens = cache.get(query.toLowerCase());
      if (!(tokens instanceof Set)) {
        throw new Error(`token cache has no entry for query #${refs.length}`);
      }
      refs.push(new WeakRef(tokens));
    }
    return refs;
  }

  const gc = (globalThis as { gc?: () => void }).gc;
  it.skipIf(typeof gc !== 'function')(
    'releases supplement results together with the caller cache entries they belong to (needs --expose-gc)',
    async () => {
      const db = new Database(':memory:');
      try {
        const store = new MemoryStore(db);
        store.add({ type: 'fact', content: 'use tabs instead of spaces' });
        store.add({ type: 'fact', content: 'используй Zustand для глобального состояния' });
        const cache = new Map<string, Set<string>>();
        // 一条纯 ASCII 查询（补充集为空，伴随结果就是 Core Set 本身）与一条含西里尔文的查询（伴随结果是新 Set）。
        const refs = fillCache(store, cache, [
          'use tabs not spaces',
          'никогда не храни токены в Zustand',
        ]);
        expect(refs).toHaveLength(2);

        // 调用方清空自己的缓存后，Core 分词 Set 与挂在它上面的补充 token 结果都必须可回收。
        cache.clear();
        for (let round = 0; round < 3; round++) {
          gc?.();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(refs.map((ref) => ref.deref())).toEqual([undefined, undefined]);
      } finally {
        db.close();
      }
    }
  );
});
