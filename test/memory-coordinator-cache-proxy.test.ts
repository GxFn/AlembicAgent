/**
 * MemoryCoordinator 工具缓存代理与观察写入的错误诊断（模块审阅 L6-P26 / C64）。
 *
 * 背景：SessionStore 只读工具缓存在生产中没有写入者（observationRecord 已移出默认工具管道，
 * 路由也不读取 ToolRuntimeCallContext.cache），缓存删除还是接线取决于待决事项①。决定之前不改缓存
 * 本体与公开面，只把代理里静默吞错的 catch 改为 catch (err: unknown) + 告警，并保持
 * 「出错返回 null、写入失败不抛」的既有语义。
 *
 * 本文件只依赖 MemoryCoordinator、SessionStore 与 Core Logger，不依赖 better-sqlite3。
 */
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { SessionStore } from '../src/agent/memory/SessionStore.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  const store = new SessionStore();
  const coordinator = new MemoryCoordinator({ sessionStore: store });
  const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
  const warnings = () => warn.mock.calls.map((call) => String(call[0]));
  return { store, coordinator, warnings };
}

describe('MemoryCoordinator cache proxy diagnostics (C64)', () => {
  it('still delegates reads and writes to the SessionStore cache without warnings', () => {
    const { coordinator, warnings } = setup();

    coordinator.cacheToolResult('code', { action: 'read', path: 'src/a.ts' }, { content: 'A' });

    // 读命中返回的是 SessionStore 改写后的形状；去留与形状统一都等待事项①。
    expect(coordinator.getCachedResult('code', { action: 'read', path: 'src/a.ts' })).toEqual({
      content: 'A',
      path: 'src/a.ts',
      cached: true,
    });
    expect(coordinator.getCachedResult('code', { action: 'read', path: 'src/b.ts' })).toBeNull();
    expect(warnings()).toEqual([]);
  });

  it('returns null and warns when the SessionStore read throws', () => {
    const { store, coordinator, warnings } = setup();
    vi.spyOn(store, 'getCachedResult').mockImplementation(() => {
      throw new Error('cache read exploded');
    });

    expect(coordinator.getCachedResult('code', { action: 'read', path: 'src/a.ts' })).toBeNull();

    const messages = warnings().filter((m) => m.includes('getCachedResult'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('tool=code');
    expect(messages[0]).toContain('cache read exploded');
  });

  it('does not throw and warns when the SessionStore write throws', () => {
    const { store, coordinator, warnings } = setup();
    vi.spyOn(store, 'cacheToolResult').mockImplementation(() => {
      throw new Error('cache write exploded');
    });

    expect(() =>
      coordinator.cacheToolResult('code', { action: 'search', pattern: 'x' }, { ok: true })
    ).not.toThrow();

    const messages = warnings().filter((m) => m.includes('cacheToolResult'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('tool=code');
    expect(messages[0]).toContain('cache write exploded');
  });

  it('names the tool in the recordObservation failure warning', () => {
    const { store, coordinator, warnings } = setup();
    vi.spyOn(store, 'cacheToolResult').mockImplementation(() => {
      throw new Error('observation write exploded');
    });

    expect(() =>
      coordinator.recordObservation('code', { action: 'read', path: 'src/a.ts' }, 'A', 1, false)
    ).not.toThrow();

    const messages = warnings().filter((m) => m.includes('recordObservation'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('tool=code');
    expect(messages[0]).toContain('observation write exploded');
  });

  it('skips the cache write when the caller marks the result as a cache hit', () => {
    const { store, coordinator, warnings } = setup();
    const write = vi.spyOn(store, 'cacheToolResult');

    // 旧 observationRecord 有信封时总以 cacheHit=true 调用，这就是生产中缓存从无写入的原因。
    coordinator.recordObservation('code', { action: 'read', path: 'src/a.ts' }, 'A', 1, true);

    expect(write).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });
});
