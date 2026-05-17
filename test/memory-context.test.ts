import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ConversationStore,
  MemoryEmbeddingStore,
  MemoryStore,
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
  it('persists semantic memories in SQLite and deserializes structured fields', () => {
    const db = new Database(':memory:');
    try {
      const store = new MemoryStore(db);
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
