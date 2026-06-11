import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

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

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ m1: [0.1, 0.2] });

    writeFileSync(filePath, '{not-json', 'utf-8');
    const recovered = new MemoryEmbeddingStore(root, { filePath });

    expect(recovered.size).toBe(0);
  });
});

describe('ConversationStore', () => {
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
