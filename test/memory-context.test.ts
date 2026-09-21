import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryConsolidator } from '../src/agent/memory/MemoryConsolidator.js';
import { readPersistentMemorySection } from '../src/agent/memory/MemoryPrompt.js';
// MemoryRetriever 未从 src/index.ts barrel 导出 → 必须走直接路径（barrel 路径会编译失败）。
import { MemoryRetriever } from '../src/agent/memory/MemoryRetriever.js';
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
      const retriever = new MemoryRetriever(store, { embeddingFn });
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
