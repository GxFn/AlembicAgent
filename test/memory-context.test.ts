import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { pathGuard, WriteZone } from '@alembic/core/io';
import Logger from '@alembic/core/logging';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EpisodicConsolidator } from '../src/agent/memory/EpisodicConsolidator.js';
import { MemoryConsolidator } from '../src/agent/memory/MemoryConsolidator.js';
import { readPersistentMemorySection } from '../src/agent/memory/MemoryPrompt.js';
// MemoryRetriever 未从 src/index.ts barrel 导出 → 必须走直接路径（barrel 路径会编译失败）。
import { MemoryRetriever } from '../src/agent/memory/MemoryRetriever.js';
import { PersistentMemory } from '../src/agent/memory/PersistentMemory.js';
import type {
  DimensionDigest,
  DimensionReportInput,
  TierReflection,
} from '../src/agent/memory/SessionStore.js';
import {
  ConversationStore,
  MEMORY_STORE_REQUIRED_COLUMNS,
  MEMORY_STORE_SEMANTIC_TABLE,
  MemoryCoordinator,
  MemoryEmbeddingStore,
  MemoryStore,
  MemoryStoreWriteError,
  SessionStore,
} from '../src/index.js';
import { estimateTokens } from '../src/shared/tokenUtils.js';

const tempRoots: string[] = [];

function makeTempRoot(label: string) {
  const root = join(tmpdir(), `alembic-agent-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 预置一条与被测记忆无关的向量，让 sidecar 非空。
 * 检索只有在 sidecar 至少存有一条向量时才会发起 query embedding；需要覆盖 embedding
 * 取消、超时、非法向量与重新确认路径的用例用它打开该分支。直接写文件再加载，不登记 flush timer。
 */
function seededEmbeddingStore(label: string) {
  const root = makeTempRoot(label);
  const filePath = join(root, 'vectors.json');
  writeFileSync(
    filePath,
    JSON.stringify({ schemaVersion: 2, embeddings: { 'unrelated-seed': { vector: [1, 0] } } })
  );
  return new MemoryEmbeddingStore(root, { filePath });
}

describe('MemoryStore', () => {
  it('labels query and document embedding calls while preserving cancellation', async () => {
    const db = new Database(':memory:');
    const embeddings = new MemoryEmbeddingStore(makeTempRoot('embedding-purpose'));
    try {
      const store = new MemoryStore(db);
      store.add({ content: 'fixed vector space' });
      const embeddingFn = vi.fn(async () => [1, 0]);
      const retriever = new MemoryRetriever(store, { embeddingFn, embeddingStore: embeddings });
      const controller = new AbortController();
      await retriever.embedAllMemories(10, { abortSignal: controller.signal });
      await retriever.retrieve('vector', { abortSignal: controller.signal });
      expect(embeddingFn.mock.calls.map((call) => call[1]?.inputKind)).toEqual([
        'document',
        'query',
      ]);
      expect(
        embeddingFn.mock.calls.every((call) => call[1]?.abortSignal instanceof AbortSignal)
      ).toBe(true);
    } finally {
      embeddings.dispose();
      db.close();
    }
  });

  it('does not reuse cached vectors across embedding profiles with the same dimension', () => {
    const root = makeTempRoot('embedding-profile');
    const first = new MemoryEmbeddingStore(root, { profileId: 'profile-one' });
    first.set('memory', [1, 0], 'same content');
    first.dispose();
    const same = new MemoryEmbeddingStore(root, { profileId: 'profile-one' });
    expect(same.get('memory', 'same content')).toEqual([1, 0]);
    same.dispose();
    const changed = new MemoryEmbeddingStore(root, { profileId: 'profile-two' });
    expect(changed.get('memory', 'same content')).toBeNull();
    changed.dispose();
    // 丢弃不兼容缓存读取不等于删除磁盘上的旧缓存。
    expect(
      JSON.parse(readFileSync(join(root, '.asd/context/memory_embeddings.json'), 'utf8')).profileId
    ).toBe('profile-one');
  });

  it('revalidates current memory content after the asynchronous query embedding', async () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      const { id } = store.add({ content: 'obsolete decision' });
      const retriever = new MemoryRetriever(store, {
        embeddingStore: seededEmbeddingStore('embedding-revalidate'),
        embeddingFn: async () => {
          store.update(id, { content: 'current decision' });
          return [1, 0];
        },
      });
      expect((await retriever.retrieve('decision'))[0].content).toBe('current decision');
    } finally {
      db.close();
    }
  });
  it.each([
    { vector: [Number.NaN] },
    { vector: [0, 0] },
    { vector: [1e308, 1e308] },
  ])('keeps lexical scores finite for invalid query vectors $vector', async ({ vector }) => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      store.add({ content: 'transaction boundary' });
      const diagnostics: unknown[] = [];
      const results = await new MemoryRetriever(store, {
        embeddingStore: seededEmbeddingStore('embedding-invalid-query'),
        embeddingFn: async () => vector,
      }).retrieve('transaction', { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
      expect(Number.isFinite(results[0]._score)).toBe(true);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ phase: 'embedding', status: 'invalid' })
      );
    } finally {
      db.close();
    }
  });
  it('does not count memories discarded by the prompt budget as accessed', async () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      const { id } = store.add({ content: 'transaction isolation '.repeat(20), source: 'user' });
      expect(
        await new MemoryRetriever(store).toPromptSection({ query: 'transaction', tokenBudget: 1 })
      ).toBe('');
      expect(store.get(id)?.accessCount).toBe(0);
    } finally {
      db.close();
    }
  });
  it('does not accept late embedding results or touch memories after cancellation', async () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      const { id } = store.add({ content: 'transaction isolation', source: 'user' });
      const controller = new AbortController();
      const embeddingFn = vi.fn(async () => {
        controller.abort();
        return [1, 0];
      });
      const retriever = new MemoryRetriever(store, {
        embeddingFn,
        embeddingStore: seededEmbeddingStore('embedding-late-cancel'),
      });
      expect(await retriever.retrieve('transaction', { abortSignal: controller.signal })).toEqual(
        []
      );
      expect(store.get(id)?.accessCount).toBe(0);
    } finally {
      db.close();
    }
  });
  it('returns lexical candidates by the deadline when embedding does not settle', async () => {
    vi.useFakeTimers();
    const db = new Database(':memory:');
    let release!: (value: number[]) => void;
    try {
      const store = new MemoryStore(db);
      store.add({ content: 'transaction isolation', source: 'user' });
      const diagnostics: unknown[] = [];
      const retriever = new MemoryRetriever(store, {
        embeddingStore: seededEmbeddingStore('embedding-deadline'),
        embeddingFn: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      });
      let completed = false;
      const pending = retriever
        .retrieve('transaction', {
          timeoutMs: 20,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        })
        .then((value) => {
          completed = true;
          return value;
        });
      await vi.advanceTimersByTimeAsync(21);
      expect(completed).toBe(true);
      expect((await pending)[0].content).toBe('transaction isolation');
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ status: 'timeout', phase: 'embedding' })
      );
    } finally {
      release?.([1, 0]);
      vi.useRealTimers();
      db.close();
    }
  });
  it('rolls back conflict replacements when later consolidation writes fail', () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      const original = 'Use a transaction to update persistent memories';
      const { id } = store.add({ type: 'fact', content: original });
      const update = vi.spyOn(store, 'update');
      vi.spyOn(store, 'add').mockImplementation(() => {
        throw new Error('simulated write failure');
      });
      expect(() =>
        new MemoryConsolidator(store).consolidate([
          {
            type: 'fact',
            content: 'Do not use a transaction to update persistent memories',
            importance: 8,
          },
          { type: 'fact', content: 'Quartz geometry defines a blue triangle', importance: 5 },
        ])
      ).toThrow('simulated write failure');
      expect(update).toHaveBeenCalled();
      expect(store.get(id)?.content).toBe(original);
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });
  it('preserves explicit importance when appending and recognizing a duplicate memory', () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      const retriever = new MemoryRetriever(store);
      retriever.append({
        content: 'Preserve the domain ownership decision.',
        type: 'decision',
        importance: 8,
      });
      expect(store.getAllActive()[0].importance).toBe(8);
      retriever.append({
        content: 'Preserve the domain ownership decision.',
        type: 'decision',
        importance: 9,
      });
      expect(store.getAllActive()).toHaveLength(1);
      expect(store.getAllActive()[0].importance).toBe(9);
    } finally {
      db.close();
    }
  });
  it('fails fast when the Core semantic memory schema shape drifts', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE ${MEMORY_STORE_SEMANTIC_TABLE} (id TEXT PRIMARY KEY)`);

      expect(() => new MemoryStore(db)).toThrow(
        'MemoryStore schema tripwire: semantic_memories missing columns: type'
      );
    } finally {
      db.close();
    }
  });

  it('persists semantic memories in SQLite and deserializes structured fields', () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${MEMORY_STORE_SEMANTIC_TABLE})`)
          .all()
          .map((row) => String(row.name || ''))
      );

      expect(MEMORY_STORE_REQUIRED_COLUMNS.every((column) => columns.has(column))).toBe(true);
      const { id } = store.add({
        type: 'insight',
        content: 'Agent memory owns semantic recall and prompt retrieval.',
        source: 'bootstrap',
        importance: 12,
        relatedEntities: ['MemoryStore', 'PersistentMemory'],
        tags: ['agent', 'memory'],
      });

      expect(store.size()).toBe(1);
      expect(store.get(id)).toMatchObject({
        id,
        type: 'insight',
        source: 'bootstrap',
        importance: 10,
        relatedEntities: ['MemoryStore', 'PersistentMemory'],
        tags: ['agent', 'memory'],
      });

      expect(store.update(id, { importance: 3, tags: ['updated'] })).toBe(true);
      expect(store.get(id)).toMatchObject({ importance: 3, tags: ['updated'] });
      expect(store.findSimilar('semantic recall prompt retrieval', 'insight', 3)[0]).toMatchObject({
        id,
      });

      store.add({
        content: 'expired bootstrap note',
        source: 'bootstrap',
        ttlDays: -1,
      });

      expect(store.compact()).toMatchObject({ expired: 1 });
      expect(store.getStats()).toMatchObject({
        total: 1,
        byType: { insight: 1 },
        bySource: { bootstrap: 1 },
      });
    } finally {
      db.close();
    }
  });

  it('wraps SQLite write failures in a typed MemoryStore write error', () => {
    const db = new Database(':memory:');
    const store = new MemoryStore(db);
    db.close();

    expect(() =>
      store.add({
        content: 'write should fail after db close',
        source: 'test',
      })
    ).toThrow(MemoryStoreWriteError);

    try {
      store.add({ content: 'write should fail after db close', source: 'test' });
      throw new Error('expected MemoryStoreWriteError');
    } catch (err: unknown) {
      expect(err).toMatchObject({
        name: 'MemoryStoreWriteError',
        code: 'MEMORY_STORE_WRITE_FAILED',
        operation: 'add',
      });
    }
  });
});

describe('MemoryCoordinator', () => {
  it('keeps the complete request budget stable across concurrent reconfiguration', async () => {
    let release!: (value: string) => void;
    const coordinator = new MemoryCoordinator({
      totalMemoryBudget: 100,
      persistentMemory: {
        toPromptSection: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        append() {},
      },
    });
    const context = coordinator.createDimensionScope('scope');
    vi.spyOn(context, 'buildContext').mockImplementation((budget) => 'x'.repeat((budget ?? 0) * 4));
    const pending = coordinator.buildMemoryPrompt({ scopeId: 'scope' });
    await Promise.resolve();
    coordinator.allocateBudget('analyst', 1000);
    release('retained');
    expect(estimateTokens(await pending)).toBeLessThanOrEqual(100);
    coordinator.dispose();
  });
  it('normalizes invalid time limits without creating an unbounded request', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = readPersistentMemorySection(
        { toPromptSection: () => new Promise(() => {}) },
        { timeoutMs: Number.NaN, deadlineAt: Number.NaN, tokenBudget: 30 }
      ).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(5001);
      expect(settled).toBe(true);
      expect((await pending).content).toBe('');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('forwards task relevance and keeps session context when persistent memory fails', async () => {
    const session = new SessionStore({ cleanupIntervalMs: 0 });
    session.storeDimensionReport('previous', {
      analysisText: 'Session evidence remains available',
    });
    const persistent = {
      toPromptSection: vi.fn(() => {
        throw new Error('offline');
      }),
      append: vi.fn(),
    };
    const coordinator = new MemoryCoordinator({
      persistentMemory: persistent,
      sessionStore: session,
    });
    try {
      const result = await coordinator.buildStaticMemoryPrompt({
        taskContext: 'transaction isolation',
        currentDimId: 'next',
      });
      expect(persistent.toPromptSection).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'transaction isolation' })
      );
      expect(result).toContain('Session evidence remains available');
    } finally {
      session.dispose();
      coordinator.dispose();
    }
  });
  it('isolates per-scope budgets when asynchronous reads finish in reverse order', async () => {
    let release!: (text: string) => void;
    const persistent = {
      toPromptSection: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              release = resolve;
            })
        )
        .mockResolvedValue(''),
      append: vi.fn(),
    };
    const coordinator = new MemoryCoordinator({
      persistentMemory: persistent,
      totalMemoryBudget: 100,
    });
    coordinator.createDimensionScope('a');
    const b = coordinator.createDimensionScope('b');
    const build = vi.spyOn(b, 'buildContext').mockReturnValue('');
    const pendingA = coordinator.buildStaticMemoryPrompt({ scopeId: 'a', mode: 'analyst' });
    await coordinator.buildStaticMemoryPrompt({ scopeId: 'b', mode: 'producer' });
    coordinator.buildDynamicMemoryPrompt({ scopeId: 'b', mode: 'producer' });
    expect(build).toHaveBeenLastCalledWith(100);
    release('x'.repeat(40));
    await pendingA;
    coordinator.buildDynamicMemoryPrompt({ scopeId: 'b', mode: 'producer' });
    expect(build).toHaveBeenLastCalledWith(100);
    coordinator.dispose();
  });
  it.each([
    0, 100,
  ])('enforces a %i token memory budget even for an oversized external port', async (budget) => {
    const persistent = {
      toPromptSection: vi.fn(() => '大量无界历史'.repeat(200)),
      append: vi.fn(),
    };
    const coordinator = new MemoryCoordinator({
      persistentMemory: persistent,
      totalMemoryBudget: budget,
    });
    const result = await coordinator.buildMemoryPrompt();
    expect(estimateTokens(result)).toBeLessThanOrEqual(budget);
    if (budget === 0) {
      expect(persistent.toPromptSection).not.toHaveBeenCalled();
    }
    coordinator.dispose();
  });
  it('passes the allocated budget into persistent and session memory ports', async () => {
    const persistent = { toPromptSection: vi.fn(() => ''), append: vi.fn() };
    const session = { buildContextForDimension: vi.fn(() => '') };
    const coordinator = new MemoryCoordinator({
      persistentMemory: persistent,
      sessionStore: session as unknown as SessionStore,
      totalMemoryBudget: 1000,
    });
    coordinator.allocateBudget('producer');
    await coordinator.buildStaticMemoryPrompt({ currentDimId: 'a', focusKeywords: ['boundary'] });
    expect(persistent.toPromptSection).toHaveBeenCalledWith(
      expect.objectContaining({ tokenBudget: 150 })
    );
    expect(session.buildContextForDimension).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ tokenBudget: 550 })
    );
  });
  it('recomputes the active allocation profile when the total context budget changes', () => {
    const coordinator = new MemoryCoordinator();
    coordinator.allocateBudget('producer');
    coordinator.configure({ totalContextBudget: 8000 });
    expect(coordinator.getTotalBudget()).toBe(1000);
    expect(coordinator.getBudgetAllocation()).toEqual({
      activeContext: 250,
      sessionStore: 550,
      persistentMemory: 150,
      conversationLog: 50,
    });
  });
  it('returns visible degraded diagnostics when evidence search fails', () => {
    const coordinator = new MemoryCoordinator({
      sessionStore: {
        searchEvidence() {
          throw new Error('sqlite disk I/O');
        },
      } as unknown as SessionStore,
    });

    const result = coordinator.searchEvidenceWithDiagnostics('Agent boundary', 'api');

    expect(result).toMatchObject({
      ok: false,
      degraded: true,
      reason: 'memory-evidence-search-failed',
      results: [],
      diagnostics: [
        {
          code: 'MEMORY_EVIDENCE_SEARCH_FAILED',
          reason: 'memory-evidence-search-failed',
          message: 'sqlite disk I/O',
          query: 'Agent boundary',
          dimId: 'api',
        },
      ],
    });
    expect(coordinator.searchEvidence('Agent boundary', 'api')).toEqual([]);
  });

  it('marks missing SessionStore evidence search as degraded instead of silently empty', () => {
    const coordinator = new MemoryCoordinator();
    const result = coordinator.searchEvidenceWithDiagnostics('Agent boundary');

    expect(result).toMatchObject({
      ok: true,
      degraded: true,
      reason: 'session-store-missing',
      results: [],
      diagnostics: [
        {
          code: 'MEMORY_EVIDENCE_STORE_MISSING',
          reason: 'session-store-missing',
          query: 'Agent boundary',
        },
      ],
    });
  });

  it('handles typed persistent memory write failures with coordinator diagnostics', () => {
    const coordinator = new MemoryCoordinator({
      persistentMemory: {
        toPromptSection: () => '',
        append() {
          throw new MemoryStoreWriteError('add', new Error('disk full'));
        },
      },
    });

    coordinator.extractFromConversation('记住以后记录 Agent boundary', '', 'user');

    expect(coordinator.getDiagnostics().writeFailures).toEqual([
      expect.objectContaining({
        code: 'MEMORY_STORE_WRITE_FAILED',
        message: 'MemoryStore add failed: disk full',
        operation: 'persistentMemory.append',
      }),
    ]);
  });
});

describe('SessionStore', () => {
  it('ranks distilled findings using the same projection that is rendered', () => {
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      store.storeDimensionReport('old', { analysisText: 'decorative visual layout '.repeat(40) });
      store.storeDimensionReport('relevant', {
        workingMemoryDistilled: {
          keyFindings: [{ finding: 'Transaction isolation', importance: 8 }],
        },
      });
      expect(
        store.buildContextForDimension('next', { focusKeywords: ['Transaction'], tokenBudget: 100 })
      ).toContain('Transaction isolation');
    } finally {
      store.dispose();
    }
  });
  it('puts relevant dimension summaries before unrelated history within the budget', () => {
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      store.storeDimensionReport('old-unrelated', {
        analysisText: 'decorative visual layout '.repeat(40),
      });
      store.storeDimensionReport('transaction-boundary', {
        analysisText: 'Transaction isolation prevents concurrent write loss.',
        referencedFiles: ['src/transaction.ts'],
      });
      const context = store.buildContextForDimension('next', {
        focusKeywords: ['Transaction'],
        tokenBudget: 100,
      });
      expect(context).toContain('Transaction isolation');
      expect(estimateTokens(context)).toBeLessThanOrEqual(100);
    } finally {
      store.dispose();
    }
  });
  it.each([0, 1, 55])('fits real Chinese session context within %i tokens', (tokenBudget) => {
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      store.storeDimensionReport('previous', {
        analysisText: '上下文预算必须包括裁剪说明。'.repeat(50),
      });
      const output = store.buildContextForDimension('next', { tokenBudget });
      expect(estimateTokens(output)).toBeLessThanOrEqual(tokenBudget);
      if (tokenBudget === 55) {
        expect(output).toContain('truncated');
      }
    } finally {
      store.dispose();
    }
  });
  it.each([
    { dimensionReports: { a: { workingMemoryDistilled: { keyFindings: {} } } } },
    { tierReflections: [{ topFindings: [null] }] },
    { workingMemory: { toolCallSummary: [null] } },
    { dimensionReports: { a: { digest: { summary: {} } } } },
    { submittedCandidates: { a: [{ title: {} }] } },
  ])('rejects malformed nested session data before replacing state: %j', (snapshot) => {
    expect(() => SessionStore.fromJSON(snapshot)).toThrow('SessionStore schema');
  });
  it('never lets nested action turn a write into a cached read', () => {
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      store.cacheToolResult(
        'code',
        { action: 'write', params: { action: 'read', path: 'a.ts' } },
        'write-result'
      );
      expect(store.getCachedResult('code', { action: 'read', path: 'a.ts' })).toBeNull();
    } finally {
      store.dispose();
    }
  });
  it('keys cached reads and searches by the complete normalized request', () => {
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      store.cacheToolResult(
        'code',
        { action: 'search', pattern: 'symbol', glob: 'src/a/**' },
        { matches: ['a'] }
      );
      expect(
        store.getCachedResult('code', { action: 'search', pattern: 'symbol', glob: 'src/b/**' })
      ).toBeNull();
      expect(
        store.getCachedResult('code', {
          action: 'search',
          params: { glob: 'src/a/**', pattern: 'symbol' },
        })
      ).toEqual({ matches: ['a'] });
      store.cacheToolResult(
        'code',
        { action: 'read', filePath: 'src/a.ts', startLine: 1, endLine: 3 },
        { content: 'first' }
      );
      expect(
        store.getCachedResult('code', {
          action: 'read',
          filePath: 'src/a.ts',
          startLine: 10,
          endLine: 12,
        })
      ).toBeNull();
      expect(
        store.getCachedResult('code', {
          action: 'read',
          params: { path: 'src/a.ts', startLine: 1, endLine: 3 },
        })
      ).toEqual({ content: 'first', path: 'src/a.ts', cached: true });
    } finally {
      store.dispose();
    }
  });
  it('rebuilds legacy evidence only when the persisted evidence field is absent', () => {
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    store.storeDimensionReport('a', {
      findings: [{ finding: 'Legacy finding', evidence: 'src/a.ts:2', importance: 8 }],
    });
    const { evidenceStore: _evidence, ...legacy } = store.toJSON();
    const rebuilt = SessionStore.fromJSON(legacy);
    const empty = SessionStore.fromJSON({ ...legacy, evidenceStore: {} });
    try {
      expect(rebuilt.searchEvidence('Legacy')).toHaveLength(1);
      expect(empty.searchEvidence('Legacy')).toEqual([]);
      expect(() =>
        SessionStore.fromJSON({ dimensionReports: { a: { findings: null } } })
      ).toThrow();
    } finally {
      store.dispose();
      rebuilt.dispose();
      empty.dispose();
    }
  });
  it('preserves evidence through JSON and checkpoint round trips without merging old state', async () => {
    const root = makeTempRoot('session-evidence');
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    store.addEvidence('src/a.ts', {
      finding: 'Evidence survives restart',
      importance: 8,
      dimId: 'a',
    });
    const before = store.searchEvidence('survives');
    const restored = SessionStore.fromJSON(store.toJSON());
    try {
      expect(restored.searchEvidence('survives')).toEqual(before);
      await store.saveCheckpoint(root);
      restored.addEvidence('src/stale.ts', { finding: 'Old state', importance: 1, dimId: 'old' });
      expect(await restored.loadCheckpoint(root)).toBe(true);
      expect(restored.searchEvidence('survives')).toEqual(before);
      expect(restored.searchEvidence('Old state')).toEqual([]);
    } finally {
      store.dispose();
      restored.dispose();
    }
  });

  it('rejects malformed checkpoints without partially replacing live state', async () => {
    const root = makeTempRoot('session-invalid');
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    store.addEvidence('src/a.ts', { finding: 'Keep existing evidence', importance: 8 });
    await store.saveCheckpoint(root);
    const before = store.toJSON();
    const checkpoint = join(root, '.asd/bootstrap-checkpoint/session-store.json');
    writeFileSync(
      checkpoint,
      JSON.stringify({
        version: 2,
        savedAt: Date.now(),
        dimensionReports: { invalid: null },
        crossReferences: [],
      })
    );
    expect(await store.loadCheckpoint(root)).toBe(false);
    expect(store.toJSON()).toEqual(before);
    store.dispose();
  });
  it('saves and restores bootstrap checkpoints while validating serialized shape', async () => {
    const root = makeTempRoot('session-store');
    const store = new SessionStore({ cleanupIntervalMs: 0 });

    store.storeDimensionReport('api', {
      analysisText: 'API boundary analysis',
      findings: [
        {
          finding: 'Host adapter owns platform wiring',
          evidence: 'src/host.ts:12',
          importance: 8,
        },
      ],
      referencedFiles: ['src/host.ts'],
      candidatesSummary: [
        {
          dimId: 'api',
          title: 'Host Adapter',
          subTopic: 'boundary',
          summary: 'Keep platform wiring in host.',
        },
      ],
      workingMemoryDistilled: {
        keyFindings: [{ finding: 'Host adapter owns platform wiring', importance: 8 }],
        toolCallSummary: ['code.read src/host.ts'],
      },
      digest: {
        summary: 'API host boundary',
        crossRefs: { memory: 'shares persistence boundary' },
      },
    });

    store.addSubmittedCandidate('api', {
      title: 'Adapter Contract',
      subTopic: 'host',
      summary: 'Host calls agent contract.',
    });
    store.cacheToolResult('code', { action: 'read', filePath: 'src/host.ts' }, { content: 'ok' });

    await store.saveCheckpoint(root);
    const checkpointPath = join(root, '.asd', 'bootstrap-checkpoint', 'session-store.json');

    expect(existsSync(checkpointPath)).toBe(true);
    expect(JSON.parse(readFileSync(checkpointPath, 'utf-8'))).toMatchObject({
      version: 2,
      dimensionReports: {
        api: {
          analysisText: 'API boundary analysis',
          digest: { summary: 'API host boundary' },
        },
      },
    });

    const restored = new SessionStore({ cleanupIntervalMs: 0 });

    expect(await restored.loadCheckpoint(root)).toBe(true);
    expect(restored.getDimensionReport('api')).toMatchObject({
      dimId: 'api',
      analysisText: 'API boundary analysis',
      digest: { summary: 'API host boundary' },
    });
    expect(restored.getStats()).toMatchObject({
      completedDimensions: 1,
      totalFindings: 1,
      totalCandidates: 1,
      crossReferences: 1,
    });
    expect(() => SessionStore.fromJSON({ dimensionReports: [] })).toThrow(
      'SessionStore schema: dimensionReports must be a Record'
    );

    store.dispose();
    restored.dispose();
  });
});

describe('SessionStore dimension write contract', () => {
  /** 截获 SessionStore 打出的 warn，返回拼接后的文本，用于断言降级诊断带有 dimId、字段与原始类型。 */
  function captureWarnings() {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    return () => warn.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('keeps an earlier digest and its crossRefs when a resumed report omits digest', () => {
    const s = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      // 宿主续跑顺序：先从 dimension checkpoint 恢复 digest，再存一份不带 digest 的报告恢复 analysisText。
      s.addDimensionDigest('a', { summary: 'DIGEST-A', crossRefs: { b: 'look at X' } });
      s.storeDimensionReport('a', {
        analysisText: 'restored analysis text',
        findings: [],
        referencedFiles: ['src/a.ts'],
        candidatesSummary: [],
      });
      expect(s.getDimensionReport('a')).toMatchObject({
        analysisText: 'restored analysis text',
        referencedFiles: ['src/a.ts'],
        digest: { summary: 'DIGEST-A', crossRefs: { b: 'look at X' } },
      });
      const context = s.buildContextForDimension('b');
      expect(context).toContain('DIGEST-A');
      expect(context).toContain('- [来自 a] look at X');
      expect(s.buildContextSnapshot('b').previousDimensions.a.crossRefs).toEqual({
        b: 'look at X',
      });
      // 再次省略 digest 仍沿用同一份 digest；派生 crossRefs 按一代重建，不会累加。
      s.storeDimensionReport('a', { analysisText: 'second generation' });
      expect(s.getStats().crossReferences).toBe(1);
      expect(s.getDimensionReport('a')?.digest?.summary).toBe('DIGEST-A');
    } finally {
      s.dispose();
    }
  });

  it('clears the digest and its crossRefs only when a report passes digest: null', () => {
    const s = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      s.addDimensionDigest('a', { summary: 'DIGEST-A', crossRefs: { b: 'look at X' } });
      s.storeDimensionReport('a', { analysisText: 'fresh analysis', digest: null });
      expect(s.getDimensionReport('a')?.digest).toBeNull();
      expect(s.getStats().crossReferences).toBe(0);
      const context = s.buildContextForDimension('b');
      expect(context).not.toContain('DIGEST-A');
      expect(context).not.toContain('look at X');
      expect(context).toContain('fresh analysis');
      // 显式给出新 digest 时整代替换：旧建议不残留，只保留新 digest 派生的 crossRefs。
      s.addDimensionDigest('a', { summary: 'DIGEST-A', crossRefs: { b: 'look at X' } });
      s.storeDimensionReport('a', { digest: { summary: 'NEW', crossRefs: { c: 'see c' } } });
      expect(s.buildContextForDimension('b')).not.toContain('look at X');
      expect(s.buildContextForDimension('c')).toContain('- [来自 a] see c');
      expect(s.getStats().crossReferences).toBe(1);
    } finally {
      s.dispose();
    }
  });

  it('normalizes a malformed AI digest at addDimensionDigest with a located warning', () => {
    const warnings = captureWarnings();
    const s = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      s.storeDimensionReport('a', { analysisText: 'analysis of a' });
      s.addDimensionDigest('a', {
        summary: { text: 'object summary' },
        candidateCount: 'many',
        keyFindings: 'abc',
        crossRefs: { b: { reason: 'object detail' }, c: 'valid reference' },
        gaps: ['missing coverage', 3],
      } as unknown as DimensionDigest);
      expect(s.getDimensionReport('a')?.digest).toEqual({
        summary: '',
        keyFindings: [],
        crossRefs: { c: 'valid reference' },
        gaps: ['missing coverage'],
      });
      expect(s.buildContextForDimension('b')).not.toContain('[object Object]');
      expect(s.buildContextForDimension('c')).toContain('- [来自 a] valid reference');
      expect(() => SessionStore.fromJSON(s.toJSON()).dispose()).not.toThrow();
      const text = warnings();
      expect(text).toContain('addDimensionDigest "a"');
      expect(text).toContain('digest.summary (object');
      expect(text).toContain('digest.candidateCount (string');
      expect(text).toContain('digest.keyFindings (string');
      expect(text).toContain('digest.crossRefs.b (object');
      expect(text).toContain('digest.gaps[1] (number');
    } finally {
      vi.restoreAllMocks();
      s.dispose();
    }
  });

  it('restores a digest for a dimension without a report when keyFindings is not an array', () => {
    const warnings = captureWarnings();
    const s = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      s.addDimensionDigest('fresh', {
        summary: 'S',
        keyFindings: 'abc',
      } as unknown as DimensionDigest);
      expect(s.getDimensionReport('fresh')).toMatchObject({
        dimId: 'fresh',
        analysisText: 'S',
        findings: [],
        digest: { summary: 'S', keyFindings: [] },
      });
      s.addDimensionDigest('mixed', {
        keyFindings: [
          'plain finding',
          { finding: 'structured finding', importance: 7 },
          { finding: 3 },
          null,
        ],
      } as unknown as DimensionDigest);
      expect(s.getDimensionReport('mixed')?.findings.map((f) => f.finding)).toEqual([
        'plain finding',
        'structured finding',
      ]);
      expect(s.getDimensionReport('mixed')?.digest?.keyFindings).toEqual([
        'plain finding',
        { finding: 'structured finding', importance: 7 },
      ]);
      expect(() => SessionStore.fromJSON(s.toJSON()).dispose()).not.toThrow();
      const text = warnings();
      expect(text).toContain('addDimensionDigest "fresh"');
      expect(text).toContain('digest.keyFindings[2] (object');
      expect(text).toContain('digest.keyFindings[3] (null');
    } finally {
      vi.restoreAllMocks();
      s.dispose();
    }
  });

  // 每行包一层数组：it.each 会把数组行展开成参数，裸 ['x'] 会被当成字符串 'x'。
  it.each([
    [null],
    ['summary text'],
    [['x']],
    [42],
  ])('rejects the unnormalizable digest %j with an Error before mutating state', (bad) => {
    const s = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      s.addDimensionDigest('a', { summary: 'kept', crossRefs: { b: 'kept reference' } });
      const before = s.toJSON();
      expect(() => s.addDimensionDigest('a', bad as unknown as DimensionDigest)).toThrow(
        'SessionStore schema: digest must be an object'
      );
      expect(s.toJSON()).toEqual(before);
    } finally {
      s.dispose();
    }
  });

  it('normalizes a malformed tier reflection at addTierReflection and keeps it round-trippable', () => {
    const warnings = captureWarnings();
    const s = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      s.addTierReflection(1, {
        completedDimensions: 'a',
        topFindings: [{ finding: 'kept finding', importance: 8 }, null, { finding: {} }],
        crossDimensionPatterns: ['shared pattern', 1],
        suggestionsForNextTier: null,
      } as unknown as TierReflection);
      expect(s.getTierReflections()).toEqual([
        {
          tierIndex: 1,
          completedDimensions: [],
          topFindings: [{ finding: 'kept finding', importance: 8 }],
          crossDimensionPatterns: ['shared pattern'],
          suggestionsForNextTier: [],
        },
      ]);
      expect(s.getRelevantReflections('next')).toContain('### Tier 2 综合洞察');
      expect(() => SessionStore.fromJSON(s.toJSON()).dispose()).not.toThrow();
      const text = warnings();
      expect(text).toContain('addTierReflection tierIndex=1');
      expect(text).toContain('tierReflection.tierIndex (undefined');
      expect(text).toContain('tierReflection.completedDimensions (string');
      expect(text).toContain('tierReflection.topFindings[1] (null');
      expect(text).toContain('tierReflection.topFindings[2] (object');
      expect(text).toContain('tierReflection.crossDimensionPatterns[1] (number');
      expect(text).toContain('tierReflection.suggestionsForNextTier (null');
      expect(() => s.addTierReflection(2, null as unknown as TierReflection)).toThrow(
        'SessionStore schema: tier reflection must be an object'
      );
      expect(s.getTierReflections()).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      s.dispose();
    }
  });

  it.each([
    { dimensionReports: { a: { completedAt: 'yesterday' } } },
    { dimensionReports: { a: { analysisText: { text: 'object' } } } },
    { dimensionReports: { a: { analysisText: null } } },
    { dimensionReports: { a: { dimId: 42 } } },
    { dimensionReports: { a: { dimId: 'b' } } },
    { projectContext: 'fixture-project' },
  ])('rejects snapshots whose present fields have the wrong type: %j', (snapshot) => {
    expect(() => SessionStore.fromJSON(snapshot)).toThrow('SessionStore schema');
  });

  it('still fills defaults for missing report fields in legacy snapshots', () => {
    const restored = SessionStore.fromJSON({ dimensionReports: { a: {} } });
    try {
      expect(restored.getDimensionReport('a')).toEqual({
        dimId: 'a',
        completedAt: 0,
        analysisText: '',
        findings: [],
        referencedFiles: [],
        candidatesSummary: [],
        workingMemoryDistilled: null,
        digest: null,
      });
    } finally {
      restored.dispose();
    }
  });

  it('refuses a type-corrupted checkpoint and reports non-Error load failures by value', async () => {
    const warnings = captureWarnings();
    const root = makeTempRoot('session-typed-checkpoint');
    const s = new SessionStore({ cleanupIntervalMs: 0 });
    const restored = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      s.storeDimensionReport('a', { analysisText: 'live state' });
      await s.saveCheckpoint(root);
      const checkpoint = join(root, '.asd/bootstrap-checkpoint/session-store.json');
      const data = JSON.parse(readFileSync(checkpoint, 'utf-8'));
      data.dimensionReports.a.completedAt = 'yesterday';
      writeFileSync(checkpoint, JSON.stringify(data));
      expect(await restored.loadCheckpoint(root)).toBe(false);
      expect(restored.getCompletedDimensions()).toEqual([]);
      expect(warnings()).toContain(
        'Failed to load checkpoint: SessionStore schema: invalid completedAt'
      );
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        // biome-ignore lint/style/useThrowOnlyError: 故意抛出非 Error 值，覆盖 loadCheckpoint catch 的类型守卫分支。
        throw 'disk unavailable';
      });
      expect(await restored.loadCheckpoint(root)).toBe(false);
      expect(warnings()).toContain('Failed to load checkpoint: disk unavailable');
    } finally {
      vi.restoreAllMocks();
      s.dispose();
      restored.dispose();
    }
  });
});

describe('MemoryEmbeddingStore', () => {
  it('honors cancellation from a stale-result observer before committing the remaining batch', async () => {
    const db = new Database(':memory:');
    const embeddings = new MemoryEmbeddingStore(makeTempRoot('embedding-callback-cancel'));
    try {
      const store = new MemoryStore(db);
      const stale = store.add({ content: 'will change' });
      store.add({ content: 'still current' });
      const controller = new AbortController();
      const retriever = new MemoryRetriever(store, {
        embeddingStore: embeddings,
        embeddingFn: async () => {
          store.update(stale.id, { content: 'now changed' });
          return [1, 0];
        },
      });
      expect(
        await retriever.embedAllMemories(20, {
          abortSignal: controller.signal,
          onDiagnostic: (diagnostic) => {
            if (diagnostic.status === 'stale') {
              controller.abort();
            }
          },
        })
      ).toBe(0);
      expect(embeddings.size).toBe(0);
    } finally {
      embeddings.dispose();
      db.close();
    }
  });
  it('flushes and releases its own timer on dispose without allowing later mutations', () => {
    vi.useFakeTimers();
    try {
      const root = makeTempRoot('embedding-dispose');
      const store = new MemoryEmbeddingStore(root);
      store.set('m1', [1, 0]);
      expect(vi.getTimerCount()).toBe(1);
      store.dispose();
      expect(vi.getTimerCount()).toBe(0);
      expect(new MemoryEmbeddingStore(root).get('m1')).toEqual([1, 0]);
      expect(() => store.set('m2', [0, 1])).toThrow('disposed');
    } finally {
      vi.useRealTimers();
    }
  });
  it('shares one backfill deadline and keeps only completed valid entries', async () => {
    vi.useFakeTimers();
    const db = new Database(':memory:');
    const embeddings = new MemoryEmbeddingStore(makeTempRoot('embedding-partial'));
    try {
      const store = new MemoryStore(db);
      store.add({ content: 'first entry' });
      store.add({ content: 'second entry' });
      store.add({ content: 'third entry' });
      const embeddingFn = vi
        .fn()
        .mockResolvedValueOnce([1, 0])
        .mockImplementation(() => new Promise(() => {}));
      const retriever = new MemoryRetriever(store, { embeddingStore: embeddings, embeddingFn });
      const pending = retriever.embedAllMemories(20, { timeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(21);
      expect(await pending).toBe(1);
      expect(embeddingFn).toHaveBeenCalledTimes(2);
      expect(embeddings.size).toBe(1);
    } finally {
      embeddings.dispose();
      db.close();
      vi.useRealTimers();
    }
  });
  it('retains failed writes for a later flush and persists content-bound vectors', () => {
    const root = makeTempRoot('embedding-retry');
    const filePath = join(root, 'vectors.json');
    mkdirSync(filePath);
    const store = new MemoryEmbeddingStore(root, { filePath });
    store.set('m1', [1, 0], 'current text');
    store.flushSync();
    rmSync(filePath, { recursive: true });
    store.flushSync();
    const reloaded = new MemoryEmbeddingStore(root, { filePath });
    expect(reloaded.get('m1', 'current text')).toEqual([1, 0]);
    expect(reloaded.get('m1', 'changed text')).toBeNull();
  });
  it('loads legacy vectors for compatibility but requires regeneration for content-aware recall', () => {
    const root = makeTempRoot('embedding-legacy');
    const filePath = join(root, 'vectors.json');
    writeFileSync(filePath, JSON.stringify({ m1: [1, 0] }));
    const store = new MemoryEmbeddingStore(root, { filePath });
    expect(store.get('m1')).toEqual([1, 0]);
    expect(store.get('m1', 'current text')).toBeNull();
    store.set('m1', [0, 1], 'current text');
    store.flushSync();
    expect(new MemoryEmbeddingStore(root, { filePath }).get('m1', 'current text')).toEqual([0, 1]);
  });
  it('does not expose mutable vector arrays and rejects malformed vectors', () => {
    const store = new MemoryEmbeddingStore(makeTempRoot('embedding-valid'));
    const vector = [1, 0];
    store.set('m1', vector);
    vector[0] = 7;
    const value = store.get('m1');
    if (value) {
      value[0] = 9;
    }
    expect(store.get('m1')).toEqual([1, 0]);
    store.set('bad', [Number.NaN, 0]);
    expect(store.get('bad')).toBeNull();
    store.flushSync();
  });
  it('discards backfill results when memory content changes during embedding', async () => {
    const db = new Database(':memory:');
    const embeddings = new MemoryEmbeddingStore(makeTempRoot('embedding-stale'));
    try {
      const store = new MemoryStore(db);
      const { id } = store.add({ content: 'original memory' });
      const retriever = new MemoryRetriever(store, {
        embeddingStore: embeddings,
        embeddingFn: async () => {
          store.update(id, { content: 'changed memory' });
          return [1, 0];
        },
      });
      expect(await retriever.embedAllMemories()).toBe(0);
      expect(embeddings.get(id)).toBeNull();
      retriever.setEmbeddingFunction(async () => [0, 1]);
      expect(await retriever.embedAllMemories()).toBe(1);
      expect(embeddings.get(id, 'changed memory')).toEqual([0, 1]);
    } finally {
      embeddings.flushSync();
      db.close();
    }
  });
  it('persists embeddings to a JSON sidecar and tolerates corrupt files', () => {
    const root = makeTempRoot('embedding-store');
    const filePath = join(root, '.asd', 'context', 'memory_embeddings.json');
    const store = new MemoryEmbeddingStore(root, { filePath });

    store.set('m1', [0.1, 0.2]);
    store.batchSet([{ id: 'm2', embedding: [0.3, 0.4] }]);
    expect(store.getMissingIds(['m1', 'm2', 'm3'])).toEqual(['m3']);
    store.flushSync();

    const reloaded = new MemoryEmbeddingStore(root, { filePath });

    expect(reloaded.get('m1')).toEqual([0.1, 0.2]);
    expect(reloaded.gc(new Set(['m1']))).toBe(1);
    reloaded.flushSync();

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({
      schemaVersion: 2,
      embeddings: { m1: { vector: [0.1, 0.2] } },
    });

    writeFileSync(filePath, '{not-json', 'utf-8');
    const recovered = new MemoryEmbeddingStore(root, { filePath });

    expect(recovered.size).toBe(0);
  });
  it('does not load or overwrite a profile-bound sidecar from an unbound store', () => {
    const root = makeTempRoot('embedding-unbound');
    const sidecar = join(root, '.asd/context/memory_embeddings.json');
    const bound = new MemoryEmbeddingStore(root, { profileId: 'model-a' });
    bound.set('m1', [1, 0], 'c1');
    bound.dispose();

    const diagnostics: unknown[] = [];
    const unbound = new MemoryEmbeddingStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    // 未绑定实例无法证明自己与文件处于同一向量空间：不加载，并给出可观测信号。
    expect(unbound.size).toBe(0);
    expect(unbound.get('m1')).toBeNull();
    expect(diagnostics).toContainEqual({
      phase: 'embedding',
      status: 'stale',
      reason: 'embedding-profile-unbound',
    });

    unbound.set('m2', [0, 1], 'c2');
    unbound.gc(new Set(['m2']));
    unbound.dispose();
    expect(diagnostics).toContainEqual({
      phase: 'backfill',
      status: 'invalid',
      reason: 'sidecar-write-skipped:embedding-profile-unbound',
    });
    const persisted = JSON.parse(readFileSync(sidecar, 'utf8'));
    expect(persisted.profileId).toBe('model-a');
    expect(Object.keys(persisted.embeddings)).toEqual(['m1']);

    const reopened = new MemoryEmbeddingStore(root, { profileId: 'model-a' });
    expect(reopened.get('m1', 'c1')).toEqual([1, 0]);
    reopened.dispose();
  });
  it('rechecks the on-disk profile before an unbound store writes over a sidecar bound later', () => {
    const root = makeTempRoot('embedding-unbound-late');
    const sidecar = join(root, '.asd/context/memory_embeddings.json');
    const diagnostics: unknown[] = [];
    // 构造时文件尚不存在；随后另一个带 profile 的实例先写盘。
    const unbound = new MemoryEmbeddingStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const bound = new MemoryEmbeddingStore(root, { profileId: 'model-a' });
    bound.set('m1', [1, 0], 'c1');
    bound.dispose();

    unbound.set('m2', [0, 1], 'c2');
    unbound.flushSync();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ reason: 'sidecar-write-skipped:embedding-profile-unbound' })
    );
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).profileId).toBe('model-a');
    // 写盘被拒绝不影响进程内缓存的读取；dirty 保留，文件解除绑定后仍可再次 flush。
    expect(unbound.get('m2', 'c2')).toEqual([0, 1]);
    rmSync(sidecar);
    unbound.dispose();
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual({
      schemaVersion: 2,
      embeddings: { m2: { vector: [0, 1], contentHash: expect.any(String) } },
    });
  });
  it('still replaces a corrupt sidecar from an unbound store and reports the failed binding check', () => {
    const root = makeTempRoot('embedding-unbound-corrupt');
    const filePath = join(root, 'vectors.json');
    const diagnostics: unknown[] = [];
    const unbound = new MemoryEmbeddingStore(root, {
      filePath,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    unbound.set('m1', [1, 0], 'c1');
    // 损坏文件无法证明已绑定任何 profile：沿用原有覆盖恢复路径，但留下核对失败的诊断。
    writeFileSync(filePath, '{not-json');
    unbound.dispose();
    expect(diagnostics).toEqual([
      {
        phase: 'backfill',
        status: 'stale',
        reason: 'sidecar-binding-check-failed:invalid-json',
      },
    ]);
    expect(new MemoryEmbeddingStore(root, { filePath }).get('m1', 'c1')).toEqual([1, 0]);
  });
});

describe('MemoryRetriever vector sidecar gate', () => {
  function seedMemories(db: ConstructorParameters<typeof MemoryStore>[0]) {
    const store = new MemoryStore(db);
    const lexical = store.add({ content: 'transaction isolation level', source: 'bootstrap' });
    const semantic = store.add({ content: 'database locking strategy', source: 'bootstrap' });
    return { store, lexical, semantic };
  }

  it('skips the query embedding and reports no-stored-vectors when the sidecar is empty', async () => {
    const db = new Database(':memory:');
    const embeddings = new MemoryEmbeddingStore(makeTempRoot('embedding-empty-gate'), {
      profileId: 'model-a',
    });
    try {
      const { store } = seedMemories(db);
      const embeddingFn = vi.fn(async () => [1, 0]);
      const retriever = new MemoryRetriever(store, { embeddingFn, embeddingStore: embeddings });
      const lexicalOnly = await new MemoryRetriever(store).retrieve('transaction');
      const diagnostics: unknown[] = [];

      const section = await retriever.toPromptSection({
        query: 'transaction',
        source: 'bootstrap',
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      const results = await retriever.retrieve('transaction', {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      expect(embeddings.size).toBe(0);
      expect(embeddingFn).not.toHaveBeenCalled();
      expect(section).toContain('transaction isolation level');
      expect(results.map((m) => [m.id, m._relevance])).toEqual(
        lexicalOnly.map((m) => [m.id, m._relevance])
      );
      // 每次读取只报一次跳过原因，而不是逐行报告。
      expect(diagnostics).toEqual([
        { phase: 'embedding', status: 'stale', reason: 'no-stored-vectors' },
        { phase: 'embedding', status: 'stale', reason: 'no-stored-vectors' },
      ]);
    } finally {
      embeddings.dispose();
      db.close();
    }
  });

  it('skips the query embedding when no embedding store is configured', async () => {
    const db = new Database(':memory:');
    try {
      const { store, lexical } = seedMemories(db);
      const embeddingFn = vi.fn(async () => [1, 0]);
      const diagnostics: unknown[] = [];
      const results = await new MemoryRetriever(store, { embeddingFn }).retrieve('transaction', {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      expect(embeddingFn).not.toHaveBeenCalled();
      expect(results[0].id).toBe(lexical.id);
      expect(diagnostics).toEqual([
        { phase: 'embedding', status: 'stale', reason: 'no-embedding-store' },
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps hybrid vector ranking when the sidecar holds content-bound vectors', async () => {
    const db = new Database(':memory:');
    const embeddings = new MemoryEmbeddingStore(makeTempRoot('embedding-hybrid'), {
      profileId: 'model-a',
    });
    try {
      const { store, lexical, semantic } = seedMemories(db);
      embeddings.set(lexical.id, [0, 1], 'transaction isolation level');
      embeddings.set(semantic.id, [1, 0], 'database locking strategy');
      const embeddingFn = vi.fn(async () => [1, 0]);
      const diagnostics: unknown[] = [];
      const results = await new MemoryRetriever(store, {
        embeddingFn,
        embeddingStore: embeddings,
      }).retrieve('transaction', { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });

      expect(embeddingFn.mock.calls.map((call) => call[1]?.inputKind)).toEqual(['query']);
      // 词汇上不相关、但向量完全匹配的记忆排第一：0.6 * 1 + 0.4 * 0。
      expect(results[0].id).toBe(semantic.id);
      expect(results[0]._relevance).toBeCloseTo(0.6);
      expect(results[1].id).toBe(lexical.id);
      expect(results[1]._relevance).toBeCloseTo(0.4);
      expect(diagnostics).toEqual([]);
    } finally {
      embeddings.dispose();
      db.close();
    }
  });

  it('does not hash rows against the sidecar when no query vector is available', async () => {
    const db = new Database(':memory:');
    try {
      const { store, lexical, semantic } = seedMemories(db);
      const root = makeTempRoot('embedding-no-query-vector');
      const filePath = join(root, 'vectors.json');
      // 旧版（无正文 hash）条目：按正文读取时每行都会判为 content-version-mismatch。
      writeFileSync(filePath, JSON.stringify({ [lexical.id]: [1, 0], [semantic.id]: [0, 1] }));
      const diagnostics: unknown[] = [];
      const onDiagnostic = (diagnostic: unknown) => diagnostics.push(diagnostic);
      // 逐行 get(id, content) 的诊断走 sidecar 自己的观察者，因此两侧都要接上。
      const embeddings = new MemoryEmbeddingStore(root, { filePath, onDiagnostic });
      const results = await new MemoryRetriever(store, { embeddingStore: embeddings }).retrieve(
        'transaction',
        { onDiagnostic }
      );
      expect(results[0].id).toBe(lexical.id);
      expect(diagnostics).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('MemoryRetriever no-query ranking', () => {
  it('lets a new high-importance memory into the top-N after repeated injections', async () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      for (let i = 0; i < 15; i++) {
        store.add({ content: `routine note ${i}`, importance: 5, source: 'user' });
      }
      const retriever = new MemoryRetriever(store);
      // 每次无 query 渲染都会对注入行 touchAccess；访问热度必须有上界，不能自我强化成固定 top-N。
      for (let round = 0; round < 20; round++) {
        await retriever.toPromptSection({ source: 'user' });
      }
      // 热度已饱和的默认重要性记忆不能压住只高两档、从未被注入过的新记忆。
      store.add({ content: 'NEW_PRIORITY_DECISION', importance: 7, source: 'user' });

      const section = await retriever.toPromptSection({ source: 'user' });
      expect(section).toContain('NEW_PRIORITY_DECISION');
      expect(section).toContain('## 项目记忆 (15 条最相关)');
      expect(section.split('\n')[2]).toContain('NEW_PRIORITY_DECISION');
    } finally {
      db.close();
    }
  });

  it('still prefers frequently injected memories among equal importance', async () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      const hot = store.add({ content: 'HOT_NOTE', importance: 5, source: 'user' });
      store.add({ content: 'COLD_NOTE', importance: 5, source: 'user' });
      for (let i = 0; i < 4; i++) {
        store.touchAccess(hot.id);
      }
      const section = await new MemoryRetriever(store).toPromptSection({
        source: 'user',
        limit: 1,
      });
      expect(section).toContain('HOT_NOTE');
      expect(section).not.toContain('COLD_NOTE');
    } finally {
      db.close();
    }
  });
});

describe('ConversationStore', () => {
  it('rejects conversation ids that escape the store for reads, appends and deletes', () => {
    const root = makeTempRoot('conversation-id-boundary');
    const store = new ConversationStore(root);
    store.create();
    const victim = join(root, 'victim.jsonl');
    const original = `${JSON.stringify({ role: 'user', content: 'outside conversation store' })}\n`;
    writeFileSync(victim, original);
    expect(store.load('../../victim')).toEqual([]);
    store.append('../../victim', { role: 'user', content: 'overwritten' });
    store.delete('../../victim');
    expect(readFileSync(victim, 'utf8')).toBe(original);
  });

  it('does not overwrite messages appended while a summary is being generated', async () => {
    const root = makeTempRoot('conversation-summary-race');
    const store = new ConversationStore(root);
    const id = store.create();
    for (let index = 0; index < 6; index++) {
      store.append(id, { role: 'user', content: `message ${index}` });
    }
    const summarized = await store.summarize(id, {
      aiProvider: {
        chat: async () => {
          store.append(id, { role: 'user', content: 'arrived during summary' });
          return 'summary';
        },
      },
    });
    expect(summarized).toBe(false);
    expect(store.load(id)).toHaveLength(7);
    expect(store.load(id).at(-1)?.content).toBe('arrived during summary');
  });

  it('persists conversation index and loads only valid JSONL messages within budget', () => {
    const root = makeTempRoot('conversation-store');
    const store = new ConversationStore(root);
    const conversationId = store.create({ category: 'user' });

    store.append(conversationId, { role: 'user', content: 'remember the host boundary' });
    store.append(conversationId, { role: 'assistant', content: 'recorded' });
    writeFileSync(join(root, '.asd', 'conversations', `${conversationId}.jsonl`), 'not-json\n', {
      flag: 'a',
    });

    expect(store.list({ category: 'user' })[0]).toMatchObject({
      id: conversationId,
      messageCount: 2,
      title: 'remember the host boundary',
    });
    expect(store.load(conversationId)).toEqual([
      { role: 'user', content: 'remember the host boundary' },
      { role: 'assistant', content: 'recorded' },
    ]);

    store.delete(conversationId);

    expect(store.list({ category: 'user' })).toEqual([]);
    expect(store.load(conversationId)).toEqual([]);
  });
});

// ─── A-2 召回记忆陈旧度标注（render-only，§8 Phase 2 / CG-1）────────────────────
// fixture 硬约束：经真 store.add → getAllActive/deserialize 路径构造（不手搓 camelCase 字面量，
// 使大小写漂移直接红）；用 raw-row UPDATE 改 updated_at/last_accessed_at 造"旧"记忆。
describe('MemoryRetriever staleness annotation (A-2)', () => {
  it('fits actual rendered memory text within the supplied token budget', async () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
      store.add({ content: 'long '.repeat(300), importance: 5, source: 'user' });
      store.add({ content: 'Short important decision', importance: 9, source: 'user' });
      const output = await new MemoryRetriever(store).toPromptSection({ tokenBudget: 60 });
      expect(output).toContain('Short important decision');
      expect(estimateTokens(output)).toBeLessThanOrEqual(60);
    } finally {
      db.close();
    }
  });
  function makeRetrieverWith(rows: Array<{ content: string; ageDays: number | null }>) {
    const db = new Database(':memory:');
    const store = new MemoryStore(db);
    for (const r of rows) {
      const { id } = store.add({ content: r.content, source: 'bootstrap', importance: 6 });
      if (r.ageDays === null) {
        db.prepare(
          'UPDATE semantic_memories SET updated_at = ?, last_accessed_at = ? WHERE id = ?'
        ).run('', null, id);
      } else {
        const stamp = new Date(Date.now() - r.ageDays * 86400_000).toISOString();
        db.prepare(
          'UPDATE semantic_memories SET updated_at = ?, last_accessed_at = ? WHERE id = ?'
        ).run(stamp, null, id);
      }
    }
    return { store, db, retriever: new MemoryRetriever(store) };
  }

  it('annotates memories older than 7 days with the stale prefix', async () => {
    const { db, retriever } = makeRetrieverWith([{ content: 'STALE_ITEM', ageDays: 30 }]);
    try {
      const out = await retriever.toPromptSection({ source: 'bootstrap' });
      expect(out).toContain('STALE_ITEM');
      expect(out).toMatch(/⏳\[可能陈旧\] \[.*\] STALE_ITEM/);
    } finally {
      db.close();
    }
  });

  it('does NOT annotate fresh memories (<=7 days)', async () => {
    const { db, retriever } = makeRetrieverWith([{ content: 'FRESH_ITEM', ageDays: 1 }]);
    try {
      const out = await retriever.toPromptSection({ source: 'bootstrap' });
      expect(out).toContain('FRESH_ITEM');
      expect(out).not.toContain('⏳[可能陈旧]');
    } finally {
      db.close();
    }
  });

  it('treats missing/invalid timestamp as unknown-age (NaN guard, no annotation)', async () => {
    const { db, retriever } = makeRetrieverWith([{ content: 'NAN_ITEM', ageDays: null }]);
    try {
      const out = await retriever.toPromptSection({ source: 'bootstrap' });
      expect(out).toContain('NAN_ITEM');
      expect(out).not.toContain('⏳[可能陈旧]');
    } finally {
      db.close();
    }
  });

  it('falls back to lastAccessedAt when updatedAt empty, via real deserialize', async () => {
    const db = new Database(':memory:');
    const store = new MemoryStore(db);
    try {
      const { id } = store.add({ content: 'FALLBACK_ITEM', source: 'bootstrap', importance: 6 });
      const oldStamp = new Date(Date.now() - 30 * 86400_000).toISOString();
      db.prepare(
        'UPDATE semantic_memories SET updated_at = ?, last_accessed_at = ? WHERE id = ?'
      ).run('', oldStamp, id);
      const out = await new MemoryRetriever(store).toPromptSection({ source: 'bootstrap' });
      expect(out).toMatch(/⏳\[可能陈旧\] \[.*\] FALLBACK_ITEM/);
    } finally {
      db.close();
    }
  });
});

const persistenceLogger = { info() {} };
afterEach(() => vi.restoreAllMocks());
it('preserves prior bootstrap memory when a replacement INSERT fails', () => {
  const db = new Database(':memory:');
  const memory = new PersistentMemory(db);
  const store = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    const old = memory.add({
      content: 'Original bootstrap fact from previous successful generation',
      source: 'bootstrap',
    });
    store.storeDimensionReport('runtime', {
      findings: [
        { finding: 'Replacement unique memory about async runtime cancellation', importance: 8 },
      ],
    });
    db.exec(
      "CREATE TRIGGER reject_new_memory BEFORE INSERT ON semantic_memories BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;"
    );
    expect(() =>
      new EpisodicConsolidator(memory, { logger: persistenceLogger }).consolidate(store, {
        clearPrevious: true,
        bootstrapSession: 'new-run',
      })
    ).toThrow('injected write failure');
    expect(memory.get(old.id)?.content).toBe(
      'Original bootstrap fact from previous successful generation'
    );
  } finally {
    store.dispose();
    db.close();
  }
});
it('preserves a committed consolidation receipt if final logger fails', () => {
  const db = new Database(':memory:');
  try {
    const store = new MemoryStore(db);
    const logger = {
      info() {
        throw new Error('logger unavailable');
      },
    };
    let error: unknown;
    let result: unknown;
    try {
      result = new MemoryConsolidator(store, { logger }).consolidate([
        { content: 'New confirmed memory after transaction commit' },
      ]);
    } catch (err: unknown) {
      error = err;
    }
    expect(store.size()).toBe(1);
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ added: 1 });
  } finally {
    db.close();
  }
});
it('replaces old dimension evidence rather than accumulating both generations', () => {
  const store = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    store.storeDimensionReport('runtime', {
      findings: [{ finding: 'old conclusion', evidence: 'old.ts:1', importance: 5 }],
    });
    store.storeDimensionReport('runtime', {
      findings: [{ finding: 'new conclusion', evidence: 'new.ts:2', importance: 8 }],
    });
    expect(store.getDimensionReport('runtime')?.findings.map((x) => x.finding)).toEqual([
      'new conclusion',
    ]);
    expect(store.searchEvidence('', 'runtime').map((x) => x.evidence.finding)).toEqual([
      'new conclusion',
    ]);
  } finally {
    store.dispose();
  }
});
it('snapshot edits do not mutate the current session', () => {
  const store = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    store.storeDimensionReport('runtime', {
      findings: [{ finding: 'confirmed finding', evidence: 'a.ts:1', importance: 8 }],
    });
    const snapshot = store.toJSON();
    snapshot.dimensionReports.runtime.findings[0].finding = 'mutated outside';
    expect(store.getDimensionReport('runtime')?.findings[0].finding).toBe('confirmed finding');
  } finally {
    store.dispose();
  }
});
it('failed checkpoint write leaves the last valid checkpoint readable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-r06-probe-'));
  const store = new SessionStore({ cleanupIntervalMs: 0 });
  const target = path.join(root, '.asd/bootstrap-checkpoint/session-store.json');
  try {
    store.storeDimensionReport('runtime', { analysisText: 'last valid state' });
    await store.saveCheckpoint(root);
    const before = fs.readFileSync(target, 'utf8');
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (String(file).startsWith(target)) {
        write(file, '{partially-written');
        throw new Error('injected ENOSPC');
      }
      return write(file, ...(args as [string, fs.WriteFileOptions]));
    }) as typeof fs.writeFileSync);
    store.storeDimensionReport('runtime', { analysisText: 'next state' });
    await expect(store.saveCheckpoint(root)).rejects.toThrow('injected ENOSPC');
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  } finally {
    vi.restoreAllMocks();
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('resolves contradictory candidates within the same incoming batch', () => {
  const db = new Database(':memory:');
  try {
    const store = new MemoryStore(db);
    new MemoryConsolidator(store).consolidate([
      { content: 'Use a transaction to update persistent memories', type: 'fact' },
      { content: 'Do not use a transaction to update persistent memories', type: 'fact' },
    ]);
    expect(store.getAllActive().map((x) => x.content)).toEqual([
      'Do not use a transaction to update persistent memories',
    ]);
  } finally {
    db.close();
  }
});
it('preserves Main bootstrap constructor metadata in the session snapshot', () => {
  const store = new SessionStore({
    cleanupIntervalMs: 0,
    projectName: 'fixture-project',
    primaryLang: 'TypeScript',
    fileCount: 9,
    modules: ['runtime'],
  });
  try {
    expect(store.toJSON().projectContext).toMatchObject({
      projectName: 'fixture-project',
      primaryLang: 'TypeScript',
      fileCount: 9,
      modules: ['runtime'],
    });
  } finally {
    store.dispose();
  }
});

describe('conversation input and read boundary', () => {
  it('reads from the same injected data zone it writes', () => {
    const projectRoot = makeTempRoot('conversation-project');
    const dataRoot = makeTempRoot('conversation-data');
    const zone = new WriteZone({
      projectRoot,
      dataRoot,
      knowledgeBaseDir: 'Alembic',
      ghost: true,
    } as never);
    const store = new ConversationStore(projectRoot, zone);
    const id = store.create();
    store.append(id, { role: 'user', content: 'data-zone fact' });
    expect(store.list()[0]).toMatchObject({ id, messageCount: 1 });
    expect(store.load(id)).toEqual([{ role: 'user', content: 'data-zone fact' }]);
    expect(existsSync(join(projectRoot, '.asd/conversations'))).toBe(false);
  });
  it('skips malformed JSON message shapes while preserving neighboring valid messages', () => {
    const root = makeTempRoot('conversation-shapes');
    const store = new ConversationStore(root);
    const id = store.create();
    store.append(id, { role: 'user', content: 'valid first' });
    writeFileSync(
      join(root, '.asd/conversations', `${id}.jsonl`),
      '\n{}\n[]\nnull\n{"role":"user","content":42}\n',
      { flag: 'a' }
    );
    store.append(id, { role: 'assistant', content: 'valid last' });
    expect(store.load(id)).toEqual([
      { role: 'user', content: 'valid first' },
      { role: 'assistant', content: 'valid last' },
    ]);
  });
  it('recovers a malformed index shape without throwing from create/list', () => {
    const root = makeTempRoot('conversation-index');
    const store = new ConversationStore(root);
    store.create();
    writeFileSync(join(root, '.asd/conversations/index.json'), '{"unexpected":true}');
    const id = store.create();
    expect(store.list()).toMatchObject([{ id }]);
  });
  it.each([
    0, 1, 20, 60,
  ])('keeps loaded conversation within %i tokens including truncation markers', (budget) => {
    const root = makeTempRoot(`conversation-budget-${budget}`);
    const store = new ConversationStore(root);
    const id = store.create();
    store.append(id, { role: 'system', content: `[对话摘要] ${'旧摘要'.repeat(80)}` });
    store.append(id, { role: 'user', content: 'older user fact' });
    store.append(id, { role: 'assistant', content: `LATEST ${'新回复'.repeat(100)}` });
    const messages = store.load(id, { tokenBudget: budget });
    expect(messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)).toBeLessThanOrEqual(
      budget
    );
    if (budget >= 20) {
      expect(messages.at(-1)?.content).toContain('LATEST');
    }
  });
});

it('migrates legacy ledger-label evidence indexes before replacing a restored report', () => {
  const store = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    store.storeDimensionReport('runtime', {
      findings: [
        { finding: 'old report', evidence: 'E-1=src/a.ts:1-3; E-2=src/b.ts:4-6', importance: 8 },
      ],
    });
    const legacy = store.toJSON();
    legacy.evidenceStore = {
      'E-1=src/a.ts': [{ dimId: 'runtime', finding: 'old report', importance: 8 }],
    };
    const restored = SessionStore.fromJSON(legacy);
    try {
      expect(restored.getEvidenceForFile('src/a.ts')).toHaveLength(1);
      expect(restored.getEvidenceForFile('src/b.ts')).toHaveLength(1);
      restored.storeDimensionReport('runtime', { findings: [] });
      expect(restored.searchEvidence('')).toEqual([]);
    } finally {
      restored.dispose();
    }
  } finally {
    store.dispose();
  }
});

it.each([
  '__proto__',
  'constructor',
])('keeps %s as ordinary restored evidence and dimension keys', (key) => {
  const store = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    store.storeDimensionReport(key, {
      findings: [{ finding: 'confirmed special file', evidence: `E-1=${key}:1-2`, importance: 8 }],
    });
    const legacy = store.toJSON();
    legacy.evidenceStore = Object.fromEntries([
      [`E-1=${key}`, [{ dimId: key, finding: 'confirmed special file', importance: 8 }]],
    ]);
    const restored = SessionStore.fromJSON(legacy);
    try {
      expect(restored.getEvidenceForFile(key)).toHaveLength(1);
      expect(Object.hasOwn(restored.buildContextSnapshot('next').previousDimensions, key)).toBe(
        true
      );
    } finally {
      restored.dispose();
    }
  } finally {
    store.dispose();
  }
});

const recoveryLog = { info() {} };
afterEach(() => {
  vi.restoreAllMocks();
  pathGuard._reset();
});
function fixture() {
  const db = new Database(':memory:');
  const memory = new PersistentMemory(db);
  const session = new SessionStore({ cleanupIntervalMs: 0 });
  memory.add({
    content: 'remember the user preference about monochrome editor appearance',
    source: 'user',
    importance: 9,
  });
  const old = memory.add({
    content: 'old bootstrap generation describes obsolete unique implementation',
    source: 'bootstrap',
  });
  return {
    db,
    memory,
    session,
    old,
    dispose() {
      session.dispose();
      db.close();
    },
  };
}
it('atomically replaces bootstrap facts while preserving user facts', () => {
  const f = fixture();
  try {
    f.session.storeDimensionReport('runtime', {
      findings: [
        {
          finding: 'generated asynchronous scheduling permits reactive queue workers',
          importance: 8,
        },
      ],
    });
    const result = new EpisodicConsolidator(f.memory, { logger: recoveryLog }).consolidate(
      f.session,
      { clearPrevious: true, bootstrapSession: 'new' }
    );
    expect(result.total.added).toBe(1);
    expect(f.memory.get(f.old.id)).toBeNull();
    expect(f.memory.size({ source: 'user' })).toBe(1);
    expect(f.memory.size({ source: 'bootstrap' })).toBe(1);
  } finally {
    f.dispose();
  }
});
it('rolls back bootstrap deletion and an earlier successful replacement insert', () => {
  const f = fixture();
  try {
    f.session.storeDimensionReport('runtime', {
      findings: [
        { finding: 'blue circular container carries quartz stones', importance: 8 },
        { finding: 'red hexagonal river bank shelters finches', importance: 8 },
      ],
    });
    f.db.exec(
      "CREATE TRIGGER fail_second BEFORE INSERT ON semantic_memories WHEN new.content = 'red hexagonal river bank shelters finches' BEGIN SELECT RAISE(ABORT, 'second insert failure'); END;"
    );
    expect(() =>
      new EpisodicConsolidator(f.memory, { logger: recoveryLog }).consolidate(f.session, {
        clearPrevious: true,
      })
    ).toThrow('second insert failure');
    expect(f.memory.get(f.old.id)).not.toBeNull();
    expect(f.memory.size()).toBe(2);
  } finally {
    f.dispose();
  }
});
it('never touches prior memories if extraction fails', () => {
  const f = fixture();
  try {
    vi.spyOn(f.session, 'getDimensionReport').mockImplementation(() => {
      throw new Error('broken report');
    });
    f.session.storeDimensionReport('runtime', { findings: [] });
    expect(() =>
      new EpisodicConsolidator(f.memory, { logger: recoveryLog }).consolidate(f.session, {
        clearPrevious: true,
      })
    ).toThrow('broken report');
    expect(f.memory.get(f.old.id)).not.toBeNull();
    expect(f.memory.size()).toBe(2);
  } finally {
    f.dispose();
  }
});
it('observer rejections after consolidation never erase the actual return', async () => {
  const f = fixture();
  try {
    f.session.storeDimensionReport('runtime', {
      findings: [
        {
          finding: 'generated asynchronous scheduling permits reactive queue workers',
          importance: 8,
        },
      ],
    });
    const observer = { info: () => Promise.reject(new Error('async observer failure')) };
    const result = new EpisodicConsolidator(f.memory, { logger: observer }).consolidate(f.session, {
      clearPrevious: true,
    });
    expect(result.total.added).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    f.dispose();
  }
});
it('bad report replacement must not remove the live report indexes', () => {
  const s = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    s.storeDimensionReport('runtime', {
      findings: [{ finding: 'confirmed current fact', evidence: 'old.ts:1', importance: 8 }],
      digest: { crossRefs: { next: 'keep this confirmed reference' } },
    });
    const before = s.toJSON();
    expect(() =>
      s.storeDimensionReport('runtime', { findings: [null] } as unknown as DimensionReportInput)
    ).toThrow();
    expect(s.toJSON()).toEqual(before);
  } finally {
    s.dispose();
  }
});
it('producer projection cannot alter the owned working-memory report', () => {
  const s = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    s.storeDimensionReport('runtime', {
      referencedFiles: ['a.ts'],
      workingMemoryDistilled: {
        keyFindings: [{ finding: 'confirmed fact', importance: 8 }],
        toolCallSummary: ['read a.ts'],
      },
    });
    const projection = s.getDistilledForProducer('runtime');
    if (!projection) {
      throw new Error('Fixture must provide projection');
    }
    projection.keyFindings[0].finding = 'mutated producer fact';
    projection.referencedFiles.push('rogue.ts');
    expect(s.getDimensionReport('runtime')?.workingMemoryDistilled?.keyFindings?.[0].finding).toBe(
      'confirmed fact'
    );
    expect(s.getAllReferencedFiles()).toEqual(new Set(['a.ts']));
  } finally {
    s.dispose();
  }
});
it('context snapshot cannot alter the stored digest or submitted candidates', () => {
  const s = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    s.storeDimensionReport('runtime', { digest: { summary: 'owned digest' } });
    s.addSubmittedCandidate('runtime', {
      title: 'owned candidate',
      subTopic: 'core',
      summary: 'owned',
    });
    const projection = s.buildContextSnapshot('next');
    projection.previousDimensions.runtime.summary = 'mutated digest';
    projection.submittedCandidates[0].title = 'mutated candidate';
    expect(s.getDimensionReport('runtime')?.digest?.summary).toBe('owned digest');
    expect(s.toJSON().submittedCandidates.runtime[0].title).toBe('owned candidate');
  } finally {
    s.dispose();
  }
});
it('new report generations retain unrelated and independent addEvidence data', () => {
  const s = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    s.addEvidence('independent.ts', {
      dimId: 'runtime',
      finding: 'independent appendix',
      importance: 6,
    });
    s.storeDimensionReport('other', {
      findings: [{ finding: 'other report', evidence: 'other.ts:2', importance: 5 }],
    });
    s.storeDimensionReport('runtime', {
      findings: [{ finding: 'prior report', evidence: 'old.ts:3', importance: 8 }],
    });
    const restored = SessionStore.fromJSON(s.toJSON());
    try {
      restored.storeDimensionReport('runtime', {
        findings: [{ finding: 'new report', evidence: 'new.ts:4', importance: 9 }],
      });
      expect(
        restored
          .searchEvidence('')
          .map((x) => x.evidence.finding)
          .sort()
      ).toEqual(['independent appendix', 'new report', 'other report']);
      expect(restored.getEvidenceForFile('new.ts')[0]).not.toHaveProperty('reportDimId');
    } finally {
      restored.dispose();
    }
  } finally {
    s.dispose();
  }
});
it('legacy snapshots infer report ownership without deleting distinct independent evidence', () => {
  const s = new SessionStore({ cleanupIntervalMs: 0 });
  try {
    s.addEvidence('old.ts', { dimId: 'runtime', finding: 'independent appendix', importance: 6 });
    s.storeDimensionReport('runtime', {
      findings: [{ finding: 'prior report', evidence: 'old.ts:3', importance: 8 }],
    });
    const legacy = s.toJSON();
    for (const entries of Object.values(legacy.evidenceStore || {})) {
      for (const e of entries) {
        delete e.reportDimId;
      }
    }
    const restored = SessionStore.fromJSON(legacy);
    try {
      restored.storeDimensionReport('runtime', { findings: [] });
      expect(restored.searchEvidence('').map((x) => x.evidence.finding)).toEqual([
        'independent appendix',
      ]);
    } finally {
      restored.dispose();
    }
  } finally {
    s.dispose();
  }
});
it.each([
  'fs',
  'write-zone',
] as const)('checkpoint write failure preserves the previous snapshot using %s', async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-r06-cross-'));
  const s = new SessionStore({ cleanupIntervalMs: 0 });
  const target = path.join(root, '.asd/bootstrap-checkpoint/session-store.json');
  try {
    pathGuard.configure({ projectRoot: root, extraAllowPaths: [root] });
    const wz =
      mode === 'write-zone'
        ? new WriteZone(new WorkspaceResolver({ projectRoot: root }))
        : undefined;
    s.storeDimensionReport('runtime', { analysisText: 'old valid state' });
    await s.saveCheckpoint(root, wz);
    const before = fs.readFileSync(target, 'utf8');
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      p: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (String(p).startsWith(`${target}.`)) {
        write(p, 'partial-stage');
        throw new Error('injected stage ENOSPC');
      }
      return write(p, ...(args as [string, fs.WriteFileOptions]));
    }) as typeof fs.writeFileSync);
    s.storeDimensionReport('runtime', { analysisText: 'new state' });
    await expect(s.saveCheckpoint(root, wz)).rejects.toThrow('injected stage ENOSPC');
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['session-store.json']);
  } finally {
    vi.restoreAllMocks();
    s.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('checkpoint rename failure is visible and preserves the previous file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-r06-rename-'));
  const s = new SessionStore({ cleanupIntervalMs: 0 });
  const target = path.join(root, '.asd/bootstrap-checkpoint/session-store.json');
  try {
    s.storeDimensionReport('runtime', { analysisText: 'old' });
    await s.saveCheckpoint(root);
    const before = fs.readFileSync(target, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename denied');
    });
    s.storeDimensionReport('runtime', { analysisText: 'new' });
    await expect(s.saveCheckpoint(root)).rejects.toThrow('rename denied');
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['session-store.json']);
  } finally {
    vi.restoreAllMocks();
    s.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
