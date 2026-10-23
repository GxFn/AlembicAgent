/**
 * SessionStore 生命周期：显式清理定时器随缓存层一起删除（W1-04：审阅包 L6-P26；历史见 L6-P7 / C41）。
 *
 * 背景：构造函数曾向 Core 全局 timerRegistry 注册 'SessionStore/cleanup' interval（闭包持有 this），
 * 宿主（长驻 daemon / api-server）每次 generate 新建 SessionStore 却从不 dispose，导致泄漏；a705a2f 起
 * 默认不注册，只有显式 cleanupIntervalMs>0 才注册。该 timer 只服务于只读工具缓存的 TTL 清扫，而缓存在
 * 生产中从无写入者（C64），按决定①删除缓存时 ttlMs/cleanupIntervalMs 与 timer 一并删除：
 *   - 任何构造参数（含旧键 cleanupIntervalMs/ttlMs）都不再注册 timer；
 *   - getStats().cache 过渡期固定为全零对象（宿主 SessionResultConsumer 仍读取它打印统计）；
 *   - dispose() 与 implements Disposable 保留，宿主在会话结束时调用（L6-P28）。
 *
 * 本文件只依赖 SessionStore、MemoryCoordinator 与 Core timerRegistry，不依赖 better-sqlite3。
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { timerRegistry } from '@alembic/core/events';
import { describe, expect, it } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { SessionStore } from '../src/agent/memory/SessionStore.js';

const CLEANUP_LABEL = 'SessionStore/cleanup';

/** 过渡期 getStats().cache 的固定形状（字段名与旧统计一致，宿主按 hitRate/searchCacheSize/fileCacheSize 打印）。 */
const ZERO_CACHE_STATS = {
  hits: 0,
  misses: 0,
  evictions: 0,
  hitRate: '0%',
  searchCacheSize: 0,
  fileCacheSize: 0,
};

// 与审阅探针相同的 GC 技术：运行期打开 --expose-gc，再从新 context 取 gc 函数。
v8.setFlagsFromString('--expose-gc');
const forceGcOnce = vm.runInNewContext('gc') as () => void;

/** 与宿主 RuntimeInitializer.createBootstrapSessionStore 相同形状的构造参数。 */
const hostShapedConfig = { projectName: 'p', primaryLang: 'ts', fileCount: 1, modules: ['a'] };

function cleanupTimerCount(): number {
  return timerRegistry.diagnostics().timers.filter((t) => t.label === CLEANUP_LABEL).length;
}

async function forceGc(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    forceGcOnce();
    // WeakRef 目标在创建它的 job 结束前保持存活，必须让出宏任务后再 GC 才有意义。
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('SessionStore lifecycle without the cleanup timer', () => {
  it('registers no global cleanup interval under default construction (host shape and fromJSON)', () => {
    const before = cleanupTimerCount();
    const stores = [
      new SessionStore(),
      new SessionStore(hostShapedConfig),
      SessionStore.fromJSON(new SessionStore().toJSON()),
    ];
    try {
      expect(cleanupTimerCount()).toBe(before);
    } finally {
      for (const store of stores) {
        store.dispose();
      }
    }
    expect(cleanupTimerCount()).toBe(before);
  });

  it('ignores the retired cleanupIntervalMs/ttlMs keys instead of registering a timer', () => {
    const before = cleanupTimerCount();
    // 旧调用方（JS 或经索引签名传入）仍可能传这两个键；它们不再有任何效果。
    const stores = [
      new SessionStore({ cleanupIntervalMs: 60_000 }),
      new SessionStore({ ttlMs: 1_000, cleanupIntervalMs: 20 }),
    ];
    try {
      expect(cleanupTimerCount()).toBe(before);
    } finally {
      for (const store of stores) {
        store.dispose();
        // dispose 幂等：第二次调用不得抛错或触碰注册表。
        store.dispose();
      }
    }
    expect(cleanupTimerCount()).toBe(before);
  });

  it('reports the fixed all-zero cache stats, also after fromJSON and dispose', () => {
    const store = new SessionStore(hostShapedConfig);
    try {
      store.storeDimensionReport('dim', {
        analysisText: 'analysis',
        referencedFiles: ['src/a.ts'],
      });
      const stats = store.getStats();
      expect(stats.cache).toEqual(ZERO_CACHE_STATS);
      expect(stats).toMatchObject({ completedDimensions: 1, referencedFiles: 1 });
      // 每次返回独立对象：调用方改写返回值不会污染下一次统计。
      stats.cache.hits = 99;
      expect(store.getStats().cache).toEqual(ZERO_CACHE_STATS);

      const restored = SessionStore.fromJSON(store.toJSON());
      try {
        expect(restored.getStats().cache).toEqual(ZERO_CACHE_STATS);
        expect(restored.getStats().completedDimensions).toBe(1);
      } finally {
        restored.dispose();
      }
    } finally {
      store.dispose();
    }
    expect(store.getStats().cache).toEqual(ZERO_CACHE_STATS);
  });

  it('lets a never-disposed store be collected even when the retired timer key is passed', async () => {
    const before = cleanupTimerCount();
    const ref = (() => {
      const store = new SessionStore({ cleanupIntervalMs: 20 });
      store.storeDimensionReport('dim', { analysisText: 'x'.repeat(1_000) });
      return new WeakRef(store);
    })();
    expect(cleanupTimerCount()).toBe(before);

    await forceGc();
    // 宿主丢弃引用且从不 dispose：没有任何 timer 闭包持有实例，实例可被 GC。
    expect(ref.deref()).toBeUndefined();
    expect(cleanupTimerCount()).toBe(before);
  });

  it('leaves an injected SessionStore to its host owner now that MemoryCoordinator has no dispose', () => {
    const store = new SessionStore();
    const coordinator = new MemoryCoordinator({ sessionStore: store });
    try {
      store.storeDimensionReport('dim', { analysisText: 'owned by host' });
      // MemoryCoordinator.dispose 已随 W2a-10 删除（总控裁定：宿主会话结束时只 dispose SessionStore，
      // L6-P28）。coordinator 只按引用持有注入的 SessionStore，从不替宿主释放它。
      expect('dispose' in coordinator).toBe(false);
      expect(coordinator.getSessionStore()).toBe(store);
      expect(store.getDimensionReport('dim')?.analysisText).toBe('owned by host');
    } finally {
      store.dispose();
    }
    // 释放只经宿主持有的 SessionStore：coordinator 看到的是同一个已清空的实例。
    expect(coordinator.getSessionStore()?.getCompletedDimensions()).toEqual([]);
  });
});
