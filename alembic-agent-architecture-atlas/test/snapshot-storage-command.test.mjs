import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runSnapshotStorage } from '../scripts/snapshot-storage.mjs';
import { readSnapshotBytes, storeSnapshot } from '../scripts/snapshot-store.mjs';

function fixture(run) {
  const atlas = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-storage-command-'));
  fs.mkdirSync(path.join(atlas, 'evidence/snapshots'), { recursive: true });
  const current = Buffer.from('{ "id": "old-two", "note": "unchanged" }\n');
  fs.writeFileSync(path.join(atlas, 'evidence/current.json'), current);
  try {
    return run(atlas, path.join(atlas, 'evidence/snapshots'), current);
  } finally {
    fs.rmSync(atlas, { recursive: true, force: true });
  }
}
function bytes(id) {
  return Buffer.from(
    ` \r\n${JSON.stringify(
      {
        schemaVersion: 1,
        id,
        capturedAt: '2026-10-23T00:00:00.000Z',
        baselineCommit: 'fixture',
        documents: [],
        inventory: {
          files: [],
          edges: [],
          externalEdges: [],
          unresolved: [],
          note: '中文 🌿, { } [ ] \\" '.repeat(100),
        },
      },
      null,
      2,
    )}\r\n`,
  );
}
function legacy(root, id, raw = bytes(id)) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'snapshot.json'), raw);
}

test('verify reports raw identity, actual storage and shared objects for mixed formats', () =>
  fixture((atlas, root, current) => {
    legacy(root, 'old-one');
    storeSnapshot(root, bytes('old-two'));
    storeSnapshot(root, bytes('old-three'));
    const report = runSnapshotStorage(['verify'], atlas);
    assert.equal(report.command, 'verify');
    assert.equal(report.snapshots.length, 3);
    assert.deepEqual(
      report.snapshots.map((s) => s.storage),
      ['legacy', 'packed', 'packed'],
    );
    assert.ok(report.snapshots.every((s) => s.schemaVersion === 1));
    assert.ok(report.snapshots.every((s) => /^sha256:[a-f0-9]{64}$/u.test(s.rawSha256)));
    assert.equal(
      report.totals.rawBytes,
      bytes('old-one').length + bytes('old-two').length + bytes('old-three').length,
    );
    assert.ok(report.totals.objectReferences > report.totals.uniqueObjects);
    assert.equal(
      report.totals.reusedObjectReferences,
      report.totals.objectReferences - report.totals.uniqueObjects,
    );
    assert.equal(
      report.totals.activeBytes,
      report.totals.legacyBytes + report.totals.manifestBytes + report.totals.objectBytes,
    );
    assert.deepEqual(fs.readFileSync(path.join(atlas, 'evidence/current.json')), current);
    assert.equal(fs.existsSync(path.join(atlas, '.cache')), false);
  }));

test('migration preflights every snapshot before writing backups or replacing any original', () =>
  fixture((atlas, root, current) => {
    legacy(root, 'old-one');
    legacy(root, 'old-two', Buffer.from('{"id":"old-two","schemaVersion":1}'));
    assert.throws(() => runSnapshotStorage(['migrate'], atlas), /old-two|shape/i);
    assert.deepEqual(fs.readFileSync(path.join(root, 'old-one/snapshot.json')), bytes('old-one'));
    assert.equal(fs.existsSync(path.join(root, 'old-one/snapshot.store.json')), false);
    assert.equal(fs.existsSync(path.join(atlas, '.cache')), false);
    assert.deepEqual(fs.readFileSync(path.join(atlas, 'evidence/current.json')), current);
  }));

test('a publication interruption leaves recoverable originals and a repeat migration completes safely', () =>
  fixture((atlas, root, current) => {
    legacy(root, 'old-one');
    legacy(root, 'old-two');
    const link = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (to.endsWith('old-two/snapshot.store.json')) {
        throw new Error('injected publication interruption');
      }
      return link(from, to);
    };
    try {
      assert.throws(() => runSnapshotStorage(['migrate'], atlas), /publish|write|interruption/i);
    } finally {
      fs.linkSync = link;
    }
    assert.equal(fs.existsSync(path.join(root, 'old-one/snapshot.json')), false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'old-two/snapshot.json')), bytes('old-two'));
    for (const id of ['old-one', 'old-two']) {
      assert.deepEqual(readSnapshotBytes(root, id), bytes(id));
      assert.deepEqual(
        fs.readFileSync(
          path.join(
            atlas,
            '.cache/snapshot-storage-migration/originals/evidence/snapshots',
            id,
            'snapshot.json',
          ),
        ),
        bytes(id),
      );
    }
    const report = runSnapshotStorage(['migrate'], atlas);
    assert.ok(report.snapshots.every((s) => s.storage === 'packed'));
    assert.deepEqual(runSnapshotStorage(['migrate'], atlas), report);
    assert.deepEqual(fs.readFileSync(path.join(atlas, 'evidence/current.json')), current);
  }));

test('restore exports the exact original bytes and never overwrites a conflicting export', () =>
  fixture((atlas, root, current) => {
    legacy(root, 'old-one');
    runSnapshotStorage(['migrate'], atlas);
    const report = runSnapshotStorage(['restore', '--id', 'old-one'], atlas);
    const destination = path.join(atlas, report.destination);
    assert.equal(report.destination, '.cache/snapshot-exports/old-one/snapshot.json');
    assert.deepEqual(fs.readFileSync(destination), bytes('old-one'));
    assert.deepEqual(runSnapshotStorage(['restore', '--id', 'old-one'], atlas), report);
    fs.writeFileSync(destination, 'keep this export');
    assert.throws(
      () => runSnapshotStorage(['restore', '--id', 'old-one'], atlas),
      /immutable|conflict|exist|different/i,
    );
    assert.equal(fs.readFileSync(destination, 'utf8'), 'keep this export');
    assert.deepEqual(readSnapshotBytes(root, 'old-one'), bytes('old-one'));
    assert.deepEqual(fs.readFileSync(path.join(atlas, 'evidence/current.json')), current);
  }));

test('repeated migration rejects a corrupt packed input before changing backups or any other version', () =>
  fixture((atlas, root) => {
    legacy(root, 'old-one');
    legacy(root, 'old-two');
    runSnapshotStorage(['migrate'], atlas);
    const manifest = path.join(root, 'old-two/snapshot.store.json');
    const originalManifest = fs.readFileSync(path.join(root, 'old-one/snapshot.store.json'));
    const backup = path.join(atlas, '.cache/snapshot-storage-migration/originals');
    fs.rmSync(backup, { recursive: true });
    fs.writeFileSync(manifest, '{bad');
    assert.throws(() => runSnapshotStorage(['migrate'], atlas), /manifest|JSON|malformed/i);
    assert.equal(fs.existsSync(backup), false);
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'old-one/snapshot.store.json')),
      originalManifest,
    );
    assert.equal(fs.readFileSync(manifest, 'utf8'), '{bad');
    assert.deepEqual(readSnapshotBytes(root, 'old-one'), bytes('old-one'));
  }));

test('conflicting backups abort before migration and cache symlinks never redirect writes', () =>
  fixture((atlas, root) => {
    legacy(root, 'old-one');
    const backup = path.join(
      atlas,
      '.cache/snapshot-storage-migration/originals/evidence/snapshots/old-one/snapshot.json',
    );
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, 'unrelated backup');
    assert.throws(
      () => runSnapshotStorage(['migrate'], atlas),
      /immutable|conflict|exist|different/i,
    );
    assert.equal(fs.existsSync(path.join(root, 'old-one/snapshot.store.json')), false);
    assert.deepEqual(readSnapshotBytes(root, 'old-one'), bytes('old-one'));
    fs.rmSync(path.join(atlas, '.cache'), { recursive: true });
    fs.mkdirSync(path.join(atlas, 'outside'));
    fs.symlinkSync(path.join(atlas, 'outside'), path.join(atlas, '.cache'), 'dir');
    assert.throws(() => runSnapshotStorage(['migrate'], atlas), /symlink/i);
    assert.throws(() => runSnapshotStorage(['restore', '--id', 'old-one'], atlas), /symlink/i);
    assert.deepEqual(fs.readdirSync(path.join(atlas, 'outside')), []);
  }));

test('unknown commands, missing IDs, traversal and unexpected arguments fail before any writes', () =>
  fixture((atlas, root) => {
    legacy(root, 'old-one');
    for (const args of [
      [],
      ['unknown'],
      ['verify', '--force'],
      ['migrate', '--id', 'old-one'],
      ['restore'],
      ['restore', '--id'],
      ['restore', '--id', '../escape'],
      ['restore', '--id', 'old-one', '--force'],
      ['restore', '--id', 'not-found'],
    ]) {
      assert.throws(
        () => runSnapshotStorage(args, atlas),
        /usage|command|argument|identity|unknown|missing|not found/i,
      );
    }
    assert.equal(fs.existsSync(path.join(atlas, '.cache')), false);
    assert.deepEqual(readSnapshotBytes(root, 'old-one'), bytes('old-one'));
  }));

test('the CLI rejects symlinked evidence ancestors before treating the snapshot root as trusted', () =>
  fixture((atlas, root) => {
    legacy(root, 'old-one');
    fs.renameSync(path.join(atlas, 'evidence'), path.join(atlas, 'outside'));
    fs.symlinkSync(path.join(atlas, 'outside'), path.join(atlas, 'evidence'), 'dir');
    for (const args of [['verify'], ['migrate'], ['restore', '--id', 'old-one']]) {
      assert.throws(() => runSnapshotStorage(args, atlas), /symlink/i);
    }
    assert.equal(fs.existsSync(path.join(atlas, '.cache')), false);
    assert.deepEqual(
      fs.readFileSync(path.join(atlas, 'outside/snapshots/old-one/snapshot.json')),
      bytes('old-one'),
    );
  }));
