import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildBrowserAssets } from '../scripts/browser-data.mjs';

const inventory = {
  fingerprint: 'sha256:source',
  files: [
    {
      path: 'src/index.ts',
      kind: 'source',
      sha256: 'sha256:file',
      lines: 2,
      symbols: ['Entry'],
      references: ['unused-heavy-ast'],
      typeReferences: [],
      testCases: [],
    },
  ],
  edges: [],
  externalEdges: [],
  unresolved: [],
};
const snapshot = {
  id: 'old-view',
  capturedAt: '2026-10-22T00:00:00Z',
  baselineCommit: 'a'.repeat(40),
  sourceFiles: 1,
  sourceFingerprint: inventory.fingerprint,
  inventory,
  documents: [],
  readings: [],
  renderReceipt: null,
  pilot: null,
};
const catalog = {
  schemaVersion: 1,
  checkedAt: '2026-10-22T01:00:00Z',
  git: { commit: 'a'.repeat(40), dirtyPaths: [] },
  config: { topics: [] },
  inventory,
  documents: [],
  readings: [],
  renderReceipt: null,
  pilot: null,
  pilotFreshness: 'unavailable',
  current: null,
  rendererVersion: '12',
  history: [snapshot],
};
test('bootstrap contains references only; current and each history are independently fingerprinted assets', () => {
  const { bootstrap, assets } = buildBrowserAssets(catalog);
  assert.equal(bootstrap.history.length, 1);
  assert.equal(bootstrap.inventory, undefined);
  assert.equal(bootstrap.documents, undefined);
  for (const ref of [bootstrap.currentAsset, bootstrap.history[0].asset]) {
    const text = assets.get(ref.url);
    assert.equal(ref.sha256, `sha256:${createHash('sha256').update(text).digest('hex')}`);
    assert.equal(ref.bytes, Buffer.byteLength(text));
  }
  const current = JSON.parse(assets.get(bootstrap.currentAsset.url));
  assert.equal(current.data.history, undefined);
  assert.equal(current.data.inventory.files[0].references, undefined);
  assert.equal(current.data.inventory.files[0].symbols[0], 'Entry');
  assert.equal(JSON.parse(assets.get(bootstrap.history[0].asset.url)).data.id, 'old-view');
  assert.ok(
    JSON.stringify(catalog).includes('unused-heavy-ast'),
    'canonical evidence must not be mutated',
  );
});
test('snapshot identity collisions and invalid IDs cannot silently select a different history', () => {
  assert.throws(
    () => buildBrowserAssets({ ...catalog, history: [snapshot, snapshot] }),
    /duplicate/i,
  );
  assert.throws(
    () => buildBrowserAssets({ ...catalog, history: [{ ...snapshot, id: '../escape' }] }),
    /identity/i,
  );
});
