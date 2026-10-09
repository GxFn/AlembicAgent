/**
 * SessionStore 清理定时器生命周期（模块审阅 L6-P7 / C41）。
 *
 * 背景：构造函数曾在默认配置下无条件向 Core 全局 timerRegistry 注册 'SessionStore/cleanup'
 * interval，闭包持有 this；宿主（长驻 daemon / api-server）每次 generate 新建 SessionStore
 * 却从不 dispose，于是每次运行永久泄漏一个完整会话存储并累积注册表条目。
 *
 * 本文件只依赖 SessionStore、MemoryCoordinator 与 Core timerRegistry，不依赖 better-sqlite3。
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { timerRegistry } from '@alembic/core/events';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { SessionStore } from '../src/agent/memory/SessionStore.js';

const CLEANUP_LABEL = 'SessionStore/cleanup';

// 与审阅探针相同的 GC 技术：运行期打开 --expose-gc，再从新 context 取 gc 函数。
v8.setFlagsFromString('--expose-gc');
const forceGcOnce = vm.runInNewContext('gc') as () => void;

/** 与宿主 RuntimeInitializer.createBootstrapSessionStore 相同形状的构造参数（不传 cleanupIntervalMs/ttlMs）。 */
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

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionStore cleanup timer lifecycle', () => {
  it('registers no global cleanup interval under default construction (host shape and fromJSON)', () => {
    const before = cleanupTimerCount();
    const stores = [
      new SessionStore(),
      new SessionStore(hostShapedConfig),
      SessionStore.fromJSON(new SessionStore({ ttlMs: 0, cleanupIntervalMs: 0 }).toJSON()),
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

  it('adds no registry entries when many default stores are created and never disposed', () => {
    const before = cleanupTimerCount();
    const stores: SessionStore[] = [];
    for (let i = 0; i < 25; i++) {
      stores.push(new SessionStore({ projectName: `generate-${i}` }));
    }
    try {
      expect(cleanupTimerCount()).toBe(before);
    } finally {
      for (const store of stores) {
        store.dispose();
      }
    }
  });

  it('still registers exactly one timer for an explicit cleanupIntervalMs and dispose releases it', () => {
    const before = cleanupTimerCount();
    const store = new SessionStore({ cleanupIntervalMs: 60_000 });
    expect(cleanupTimerCount()).toBe(before + 1);
    store.dispose();
    expect(cleanupTimerCount()).toBe(before);
    // dispose 幂等：第二次调用不得再触碰注册表。
    store.dispose();
    expect(cleanupTimerCount()).toBe(before);
  });

  it('skips the timer when TTL is disabled even if cleanupIntervalMs is explicit', () => {
    const before = cleanupTimerCount();
    const store = new SessionStore({ ttlMs: 0, cleanupIntervalMs: 60_000 });
    try {
      expect(cleanupTimerCount()).toBe(before);
    } finally {
      store.dispose();
    }
  });

  it('evicts expired cache entries lazily on the next write without any timer', () => {
    vi.useFakeTimers();
    const start = new Date('2026-10-09T00:00:00Z');
    vi.setSystemTime(start);
    const store = new SessionStore({ ttlMs: 1_000, cleanupIntervalMs: 0 });
    try {
      store.cacheToolResult(
        'code',
        { action: 'search', pattern: 'foo' },
        { ok: true, matches: [] }
      );
      store.cacheToolResult(
        'code',
        { action: 'read', path: 'src/a.ts' },
        { ok: true, content: 'a' }
      );
      expect(store.getStats().cache).toMatchObject({
        searchCacheSize: 1,
        fileCacheSize: 1,
        evictions: 0,
      });

      vi.setSystemTime(start.getTime() + 1_001);
      // 过期后的下一次写入必须顺带清扫两个过期条目，而不是等待一个不存在的后台 timer。
      store.cacheToolResult(
        'code',
        { action: 'read', path: 'src/b.ts' },
        { ok: true, content: 'b' }
      );
      expect(store.getStats().cache).toMatchObject({
        searchCacheSize: 0,
        fileCacheSize: 1,
        evictions: 2,
      });
      expect(store.getCachedResult('code', { action: 'read', path: 'src/b.ts' })).toMatchObject({
        content: 'b',
        cached: true,
      });
      expect(store.getCachedResult('code', { action: 'search', pattern: 'foo' })).toBeNull();
    } finally {
      store.dispose();
    }
  });

  it('does not pin the store through an explicit cleanup timer when the host never disposes', async () => {
    const before = cleanupTimerCount();
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const ref = (() => {
      const store = new SessionStore({ cleanupIntervalMs: 20 });
      store.storeDimensionReport('dim', { analysisText: 'x'.repeat(1_000) });
      return new WeakRef(store);
    })();
    expect(cleanupTimerCount()).toBe(before + 1);

    await forceGc();
    // 宿主丢弃引用且从不 dispose：实例必须仍可被 GC（timer 闭包不得强持有 this）。
    expect(ref.deref()).toBeUndefined();

    // 孤儿 timer 在下一次触发时自注销，并留下可追溯的诊断日志；注册表不再累积条目。
    expect(await waitUntil(() => cleanupTimerCount() === before, 2_000)).toBe(true);
    expect(
      debug.mock.calls.some((call) =>
        String(call[0]).includes('[SessionStore] cleanup timer released')
      )
    ).toBe(true);
  });

  it('MemoryCoordinator.dispose leaves an injected SessionStore to its host owner', () => {
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      store.storeDimensionReport('dim', { analysisText: 'owned by host' });
      const coordinator = new MemoryCoordinator({ sessionStore: store });
      expect(coordinator.getSessionStore()).toBe(store);
      coordinator.dispose();
      // 拥有关系属宿主：coordinator 只断开引用，宿主仍可读取报告。
      expect(coordinator.getSessionStore()).toBeNull();
      expect(store.getDimensionReport('dim')?.analysisText).toBe('owned by host');
    } finally {
      store.dispose();
    }
  });
});
