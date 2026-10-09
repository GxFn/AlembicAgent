/**
 * 0 候选保护与端口精简回归（L6-P5：C26 / C33 / C35）
 *
 * 这些用例刻意不依赖 better-sqlite3：
 *   - PersistentMemory 用内存假实现替代，只模拟“代际替换 + 写入”的事务语义；
 *   - MemoryStore 用只实现固化路径所触及成员的假对象替代；
 *   - SessionStore 使用真实类（纯内存，不触库）。
 * 真实 SQLite 链路（MemoryStore.clearBootstrapMemories 的 DELETE）由 test/memory-context.test.ts
 * 的既有用例覆盖，需要 better-sqlite3 ABI 匹配的 Node 环境。
 */
import { describe, expect, it, vi } from 'vitest';
import { EpisodicConsolidator } from '../src/agent/memory/EpisodicConsolidator.js';
import { MemoryConsolidator } from '../src/agent/memory/MemoryConsolidator.js';
import type { MemoryRow, MemoryStore } from '../src/agent/memory/MemoryStore.js';
import { SessionStore } from '../src/agent/memory/SessionStore.js';

interface FakeRow {
  content: string;
  source: string;
}

interface CandidateSnapshot {
  type: string;
  content: string;
  importance: number;
  tags: string[];
}

interface ConsolidateCall {
  candidates: CandidateSnapshot[];
  opts: { bootstrapSession?: string; clearPreviousBootstrap?: boolean } | undefined;
}

interface LogLine {
  level: 'info' | 'warn' | 'debug';
  message: string;
}

function makeLogger() {
  const lines: LogLine[] = [];
  const logger = {
    info: (message: string) => {
      lines.push({ level: 'info', message });
    },
    warn: (message: string) => {
      lines.push({ level: 'warn', message });
    },
    debug: (message: string) => {
      lines.push({ level: 'debug', message });
    },
  };
  return { logger, lines };
}

/**
 * 内存版 PersistentMemory：一条上一代 bootstrap 记忆 + 一条 user 记忆。
 * consolidate 模拟真实事务语义：带 clearPreviousBootstrap 时先删掉全部 bootstrap 行，再写入候选。
 * 故意不提供 clearBootstrapMemories——EpisodicConsolidator 从不调用它，端口不应再要求它（C33）。
 */
function makeSemanticMemory() {
  const rows: FakeRow[] = [
    {
      content: 'Original bootstrap fact from the previous successful generation',
      source: 'bootstrap',
    },
    { content: 'User pinned preference that must survive', source: 'user' },
  ];
  const calls: string[] = [];
  const consolidateCalls: ConsolidateCall[] = [];
  const memory = {
    compact() {
      calls.push('compact');
    },
    consolidate(
      candidates: Array<{
        type: string;
        content: string;
        source: string;
        importance: number;
        tags: string[];
      }>,
      opts?: { bootstrapSession?: string; clearPreviousBootstrap?: boolean }
    ) {
      calls.push('consolidate');
      consolidateCalls.push({
        candidates: candidates.map((c) => ({
          type: c.type,
          content: c.content,
          importance: c.importance,
          tags: [...c.tags],
        })),
        opts,
      });
      if (opts?.clearPreviousBootstrap) {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].source === 'bootstrap') {
            rows.splice(i, 1);
          }
        }
      }
      for (const c of candidates) {
        rows.push({ content: c.content, source: c.source });
      }
      return { added: candidates.length, updated: 0, merged: 0, skipped: 0 };
    },
  };
  return { memory, rows, calls, consolidateCalls };
}

const SKIP_WARNING =
  '[Consolidator] clearPrevious skipped: 0 candidates extracted, previous bootstrap generation retained';

const REFLECTIONS = [
  {
    tierIndex: 0,
    completedDimensions: ['architecture', 'runtime'],
    topFindings: [
      {
        finding: 'EventBus dispatches every domain event synchronously',
        importance: 8,
        dimId: 'runtime',
        evidence: 'src/EventBus.ts:12',
      },
      { finding: 'minor helper naming drifts across modules', importance: 5 },
    ],
    crossDimensionPatterns: ['Architecture and runtime both route through EventBus'],
    suggestionsForNextTier: ['Inspect EventBus listeners for ordering assumptions'],
  },
];

describe('EpisodicConsolidator empty-candidate guard (C26)', () => {
  it('retains the previous bootstrap generation and reports clearSkipped when zero candidates are extracted', () => {
    const session = new SessionStore({ cleanupIntervalMs: 0 });
    const f = makeSemanticMemory();
    const { logger, lines } = makeLogger();
    try {
      const result = new EpisodicConsolidator(f.memory, { logger }).consolidate(session, {
        clearPrevious: true,
        bootstrapSession: 'empty-run',
      });
      // 上一代 bootstrap 记忆与 user 记忆都必须原样保留。
      expect(f.rows.map((r) => r.source)).toEqual(['bootstrap', 'user']);
      expect(result.clearSkipped).toBe(true);
      expect(result.total).toEqual({ added: 0, updated: 0, merged: 0, skipped: 0 });
      expect(f.consolidateCalls).toEqual([
        { candidates: [], opts: { bootstrapSession: 'empty-run' } },
      ]);
      // 跳过代际替换后，维护性 compact 仍在事务外执行一次。
      expect(f.calls).toEqual(['compact', 'consolidate']);
      expect(lines.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([SKIP_WARNING]);
    } finally {
      session.dispose();
    }
  });

  it('surfaces the skip warning through info when the host logger has no warn channel', () => {
    const session = new SessionStore({ cleanupIntervalMs: 0 });
    const f = makeSemanticMemory();
    const infoLines: string[] = [];
    try {
      const result = new EpisodicConsolidator(f.memory, {
        logger: {
          info: (message: string) => {
            infoLines.push(message);
          },
        },
      }).consolidate(session, { clearPrevious: true });
      expect(result.clearSkipped).toBe(true);
      expect(infoLines.some((line) => line.includes(SKIP_WARNING))).toBe(true);
      expect(f.rows.map((r) => r.source)).toEqual(['bootstrap', 'user']);
    } finally {
      session.dispose();
    }
  });

  it('still replaces the previous generation inside the transaction when at least one candidate exists', () => {
    const session = new SessionStore({ cleanupIntervalMs: 0 });
    const f = makeSemanticMemory();
    const { logger, lines } = makeLogger();
    try {
      session.storeDimensionReport('runtime', {
        findings: [
          {
            finding: 'generated asynchronous scheduling permits reactive queue workers',
            importance: 8,
          },
        ],
      });
      const result = new EpisodicConsolidator(f.memory, { logger }).consolidate(session, {
        clearPrevious: true,
        bootstrapSession: 'gen-2',
      });
      expect(result.clearSkipped).toBe(false);
      expect(result.total.added).toBe(1);
      expect(f.consolidateCalls[0]?.opts).toEqual({
        bootstrapSession: 'gen-2',
        clearPreviousBootstrap: true,
      });
      // 替换路径的 compact 属于 MemoryConsolidator 的同一事务，事务外不再单独 compact。
      expect(f.calls).toEqual(['consolidate']);
      expect(f.rows.map((r) => r.source)).toEqual(['user', 'bootstrap']);
      expect(f.rows[1].content).toBe(
        'generated asynchronous scheduling permits reactive queue workers'
      );
      expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it('runs compact outside the transaction and never requests replacement when clearPrevious is false', () => {
    const session = new SessionStore({ cleanupIntervalMs: 0 });
    const f = makeSemanticMemory();
    const { logger, lines } = makeLogger();
    try {
      session.storeDimensionReport('runtime', {
        findings: [
          { finding: 'incremental rescan appends to the existing generation', importance: 7 },
        ],
      });
      const result = new EpisodicConsolidator(f.memory, { logger }).consolidate(session, {
        bootstrapSession: 'rescan',
      });
      expect(result.clearSkipped).toBe(false);
      expect(f.calls).toEqual(['compact', 'consolidate']);
      expect(f.consolidateCalls[0]?.opts).toEqual({ bootstrapSession: 'rescan' });
      expect(f.rows.map((r) => r.source)).toEqual(['bootstrap', 'user', 'bootstrap']);
      expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
    } finally {
      session.dispose();
    }
  });
});

describe('EpisodicConsolidator logger isolation on the new log paths', () => {
  // vitest 会把 unhandled rejection 计为运行错误（即使断言全部通过），因此本用例同时锁定
  // "异步 logger 的 rejection 由 observeSafely 兜底" 这一不变量。
  it('isolates async warn and info rejections on the skip path and still returns the receipt', async () => {
    const session = new SessionStore({ cleanupIntervalMs: 0 });
    const f = makeSemanticMemory();
    try {
      const result = new EpisodicConsolidator(f.memory, {
        logger: {
          info: () => Promise.reject(new Error('async info failure')),
          warn: () => Promise.reject(new Error('async warn failure')),
        },
      }).consolidate(session, { clearPrevious: true });
      expect(result.clearSkipped).toBe(true);
      expect(f.rows.map((r) => r.source)).toEqual(['bootstrap', 'user']);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      session.dispose();
    }
  });

  it('isolates a synchronously throwing warn sink on the skip path', () => {
    const session = new SessionStore({ cleanupIntervalMs: 0 });
    const f = makeSemanticMemory();
    try {
      const result = new EpisodicConsolidator(f.memory, {
        logger: {
          info: () => undefined,
          warn: () => {
            throw new Error('warn sink unavailable');
          },
        },
      }).consolidate(session, { clearPrevious: true });
      expect(result.clearSkipped).toBe(true);
    } finally {
      session.dispose();
    }
  });
});

describe('EpisodicConsolidator extraction ports (C33 / C35)', () => {
  it('prefers getTierReflections over the full toJSON snapshot and keeps insight type and importance', () => {
    const f = makeSemanticMemory();
    const { logger, lines } = makeLogger();
    const toJSON = vi.fn(() => ({ tierReflections: [] }));
    const getTierReflections = vi.fn(() => structuredClone(REFLECTIONS));
    const store = {
      getCompletedDimensions: () => [],
      getDimensionReport: () => undefined,
      getTierReflections,
      toJSON,
    };
    const result = new EpisodicConsolidator(f.memory, { logger }).consolidate(store, {});
    expect(getTierReflections).toHaveBeenCalledTimes(1);
    expect(toJSON).not.toHaveBeenCalled();
    // 1 条跨维度模式 insight(7) + 1 条建议 insight(5) + 1 条 ≥7 的 topFinding fact(8)；importance 5 的 topFinding 被过滤。
    expect(result.insights.extracted).toBe(3);
    expect(f.consolidateCalls[0]?.candidates.map((c) => [c.type, c.importance, c.content])).toEqual(
      [
        ['insight', 7, 'Architecture and runtime both route through EventBus'],
        ['insight', 5, 'Inspect EventBus listeners for ordering assumptions'],
        ['fact', 8, 'EventBus dispatches every domain event synchronously'],
      ]
    );
    expect(f.consolidateCalls[0]?.candidates[2]?.tags).toEqual(['runtime', 'tier-reflection']);
    expect(lines.some((l) => l.message.includes('toJSON'))).toBe(false);
  });

  it('falls back to toJSON for duck-typed session stores without getTierReflections and logs the degraded path', () => {
    const f = makeSemanticMemory();
    const { logger, lines } = makeLogger();
    const toJSON = vi.fn(() => ({ tierReflections: structuredClone(REFLECTIONS) }));
    const store = {
      getCompletedDimensions: () => [],
      getDimensionReport: () => undefined,
      toJSON,
    };
    const result = new EpisodicConsolidator(f.memory, { logger }).consolidate(store, {});
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(result.insights.extracted).toBe(3);
    const fallbackLines = lines.filter(
      (l) => l.message.includes('getTierReflections') && l.message.includes('toJSON')
    );
    expect(fallbackLines).toHaveLength(1);
    expect(fallbackLines[0]?.level).toBe('debug');
  });

  it('extracts analysisText facts and insights with the low regex confidence importance', () => {
    const session = new SessionStore({ cleanupIntervalMs: 0 });
    const f = makeSemanticMemory();
    const { logger } = makeLogger();
    try {
      session.storeDimensionReport('architecture', {
        analysisText:
          'The project uses TypeScript with strict mode. We recommend adding integration tests.',
      });
      const result = new EpisodicConsolidator(f.memory, { logger }).consolidate(session, {});
      expect(result.findings.extracted).toBe(0);
      expect(result.textFacts.extracted).toBe(2);
      expect(
        f.consolidateCalls[0]?.candidates.map((c) => [c.type, c.importance, c.content, c.tags])
      ).toEqual([
        [
          'fact',
          4,
          'The project uses TypeScript with strict mode',
          ['architecture', 'text-extracted'],
        ],
        ['insight', 4, 'recommend adding integration tests', ['architecture', 'text-extracted']],
      ]);
    } finally {
      session.dispose();
    }
  });
});

describe('MemoryConsolidator empty-candidate double guard (C26 / C33)', () => {
  function makeStore(opts: { similar?: MemoryRow[]; cleared?: number } = {}) {
    const store = {
      transaction: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
      clearBootstrapMemories: vi.fn(() => opts.cleared ?? 0),
      compact: vi.fn(),
      enforceCapacity: vi.fn(),
      findSimilar: vi.fn(() => opts.similar ?? []),
      add: vi.fn(),
      update: vi.fn(),
    };
    return store;
  }

  /** 假对象只实现固化路径触及的成员；构造参数是 MemoryStore 类，这里经 unknown 过桥（测试边界，非生产代码）。 */
  function asStore(store: ReturnType<typeof makeStore>): MemoryStore {
    return store as unknown as MemoryStore;
  }

  it('short-circuits generation replacement and warns when clearPreviousBootstrap arrives with zero candidates', () => {
    const store = makeStore({ cleared: 3 });
    const { logger, lines } = makeLogger();
    const stats = new MemoryConsolidator(asStore(store), { logger }).consolidate([], {
      clearPreviousBootstrap: true,
      bootstrapSession: 'empty-run',
    });
    expect(stats).toEqual({ added: 0, updated: 0, merged: 0, skipped: 0 });
    expect(store.clearBootstrapMemories).not.toHaveBeenCalled();
    expect(store.compact).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      '[MemoryConsolidator] Bootstrap replacement skipped: 0 candidates supplied, previous bootstrap generation retained',
    ]);
  });

  it('isolates async warn rejections on the short-circuit path and still returns stats', async () => {
    const store = makeStore({ cleared: 3 });
    const stats = new MemoryConsolidator(asStore(store), {
      logger: {
        info: () => undefined,
        warn: () => Promise.reject(new Error('async warn failure')),
      },
    }).consolidate([], { clearPreviousBootstrap: true });
    expect(stats).toEqual({ added: 0, updated: 0, merged: 0, skipped: 0 });
    expect(store.clearBootstrapMemories).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('logs the deleted count at info level when a non-empty batch replaces the previous generation', () => {
    const store = makeStore({ cleared: 3 });
    const { logger, lines } = makeLogger();
    const stats = new MemoryConsolidator(asStore(store), { logger }).consolidate(
      [{ content: 'brand new bootstrap fact for this generation', source: 'bootstrap' }],
      { clearPreviousBootstrap: true, bootstrapSession: 'gen-2' }
    );
    expect(stats).toEqual({ added: 1, updated: 0, merged: 0, skipped: 0 });
    expect(store.clearBootstrapMemories).toHaveBeenCalledTimes(1);
    expect(store.compact).toHaveBeenCalledTimes(1);
    expect(store.add).toHaveBeenCalledWith({
      content: 'brand new bootstrap fact for this generation',
      source: 'bootstrap',
      bootstrapSession: 'gen-2',
    });
    const staged = lines.filter((l) => l.message.includes('Bootstrap replacement staged'));
    expect(staged).toHaveLength(1);
    expect(staged[0]?.level).toBe('info');
    expect(staged[0]?.message).toContain('3');
    expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('replaces a contradicting existing memory through the single-candidate conflict path', () => {
    const existing: MemoryRow = {
      id: 'old-1',
      type: 'fact',
      content: 'project uses yarn for package management',
      source: 'bootstrap',
      importance: 5,
      access_count: 0,
      last_accessed_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
      related_entities: '[]',
      related_memories: '[]',
      source_dimension: null,
      source_evidence: null,
      bootstrap_session: null,
      tags: '[]',
      similarity: 0.9,
      related_memories_raw: '[]',
    };
    const store = makeStore({ similar: [existing] });
    const { logger, lines } = makeLogger();
    const stats = new MemoryConsolidator(asStore(store), { logger }).consolidate([
      { type: 'fact', content: 'project never uses yarn for package management', importance: 6 },
    ]);
    expect(stats).toEqual({ added: 0, updated: 0, merged: 0, skipped: 0, replaced: 1 });
    expect(store.update).toHaveBeenCalledWith('old-1', {
      content: 'project never uses yarn for package management',
      importance: 6,
    });
    expect(store.add).not.toHaveBeenCalled();
    expect(lines.some((l) => l.message.includes('Conflict replacement staged'))).toBe(true);
  });
});
