import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildBrowserAssets } from '../scripts/browser-data.mjs';
import { readSnapshotHistory } from '../scripts/evidence.mjs';
import { sealSnapshot } from '../scripts/maintenance.mjs';
import { storeSnapshot } from '../scripts/snapshot-store.mjs';

const source = (id) => ({
  schemaVersion: 1,
  id,
  capturedAt: '2026-10-22T00:00:00Z',
  baselineCommit: 'a'.repeat(40),
  sourceFiles: 0,
  sourceFingerprint: 'sha256:fixture',
  documents: [],
  readings: [],
  inventory: {
    fingerprint: 'sha256:fixture',
    files: [],
    edges: [],
    externalEdges: [],
    unresolved: [],
  },
});
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-snapshot-history-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('history consumers report missing or malformed packed versions while preserving other versions', () =>
  fixture((root) => {
    storeSnapshot(root, Buffer.from(JSON.stringify(source('old-one'))));
    fs.mkdirSync(path.join(root, 'old-two'));
    fs.writeFileSync(path.join(root, 'old-two/snapshot.json'), JSON.stringify(source('old-two')));
    assert.deepEqual(
      readSnapshotHistory(root).history.map((s) => s.id),
      ['old-one', 'old-two'],
    );
    const file = path.join(root, 'old-one/snapshot.store.json');
    fs.unlinkSync(file);
    let result = readSnapshotHistory(root);
    assert.deepEqual(
      result.history.map((s) => s.id),
      ['old-two'],
    );
    assert.ok(result.errors.some((s) => s.includes('old-one') && /missing/i.test(s)));
    fs.writeFileSync(file, '{bad');
    result = readSnapshotHistory(root);
    assert.deepEqual(
      result.history.map((s) => s.id),
      ['old-two'],
    );
    assert.ok(result.errors.some((s) => s.includes('old-one') && /JSON/i.test(s)));
  }));

test('packed history preserves old schema/integrity and generates byte-identical browser assets', () =>
  fixture((root) => {
    const snapshots = [source('old-one'), sealSnapshot({ ...source('old-two'), schemaVersion: 2 })];
    const catalog = { ...source('current-one'), history: snapshots };
    const before = buildBrowserAssets(catalog);
    for (const snapshot of snapshots) {
      storeSnapshot(root, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`));
    }
    const loaded = readSnapshotHistory(root);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.history, snapshots);
    const after = buildBrowserAssets({ ...catalog, history: loaded.history });
    assert.deepEqual(after.bootstrap.history, before.bootstrap.history);
    for (const ref of after.bootstrap.history) {
      assert.equal(after.assets.get(ref.asset.url), before.assets.get(ref.asset.url));
    }
    assert.equal(loaded.history[0].integrity, undefined);
    assert.deepEqual(loaded.history[1].integrity, snapshots[1].integrity);
  }));
