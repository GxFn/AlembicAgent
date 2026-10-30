import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  readSnapshot,
  readSnapshotBytes,
  snapshotExists,
  snapshotIds,
  storeSnapshot,
} from '../scripts/snapshot-store.mjs';

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-snapshot-store-'));
  const root = path.join(dir, 'snapshots');
  fs.mkdirSync(root);
  try {
    return run(root, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const bytes = (id = 'old-one') =>
  Buffer.from(
    ` {\r\n "id": ${JSON.stringify(id)},\r\n "shared": ${JSON.stringify({
      text: '中文 🌿, { [ ] } \\" '.repeat(30),
      list: [null, true, { nested: ['a,b', '\\', '"'] }],
    })},\r\n "schemaVersion": 1\r\n } \n`,
  );
function legacy(root, id, raw = bytes(id)) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'snapshot.json'), raw);
}
function manifest(root, id = 'old-one') {
  return JSON.parse(fs.readFileSync(path.join(root, id, 'snapshot.store.json'), 'utf8'));
}
function changeManifest(root, mutate) {
  const value = manifest(root);
  mutate(value);
  fs.writeFileSync(path.join(root, 'old-one/snapshot.store.json'), JSON.stringify(value));
}
function objectPath(root, ref) {
  return path.join(root, 'objects', `${ref.sha256.slice(7)}.json.gz`);
}

test('storage round-trips original UTF-8 bytes and shares top-level fields across independent versions', () =>
  fixture((root) => {
    for (const id of ['old-one', 'old-two']) {
      storeSnapshot(root, bytes(id));
      assert.deepEqual(readSnapshotBytes(root, id), bytes(id));
      assert.equal(readSnapshot(root, id).schemaVersion, 1);
    }
    const one = manifest(root, 'old-one');
    const two = manifest(root, 'old-two');
    assert.ok(one.chunks.some((a) => two.chunks.some((b) => a.sha256 === b.sha256)));
    assert.ok(
      fs.readdirSync(path.join(root, 'objects')).length < one.chunks.length + two.chunks.length,
    );
    assert.deepEqual(snapshotIds(root), ['old-one', 'old-two']);
    fs.rmSync(path.join(root, 'old-one'), { recursive: true });
    assert.deepEqual(readSnapshotBytes(root, 'old-two'), bytes('old-two'));
  }));

test('existing snapshot identities and immutable blocks cannot be overwritten', () =>
  fixture((root) => {
    storeSnapshot(root, bytes());
    const original = fs.readFileSync(path.join(root, 'old-one/snapshot.store.json'));
    assert.throws(() => storeSnapshot(root, bytes()), /exists|immutable/i);
    const block = objectPath(root, manifest(root).chunks[1]);
    fs.writeFileSync(block, 'broken');
    assert.throws(() => storeSnapshot(root, bytes('old-two')), /chunk|gzip|decompress/i);
    assert.deepEqual(fs.readFileSync(path.join(root, 'old-one/snapshot.store.json')), original);
    assert.equal(fs.readFileSync(block, 'utf8'), 'broken');
    assert.equal(snapshotExists(root, 'old-two'), false);
  }));

test('legacy snapshots, staged migration and mixed storage remain readable without changing schema or bytes', () =>
  fixture((root) => {
    legacy(root, 'old-one');
    legacy(root, 'old-two');
    assert.throws(() => storeSnapshot(root, bytes()), /exists|immutable/i);
    storeSnapshot(root, bytes(), { migrate: true });
    assert.deepEqual(readSnapshotBytes(root, 'old-one'), bytes());
    assert.deepEqual(readSnapshotBytes(root, 'old-two'), bytes('old-two'));
    storeSnapshot(root, bytes(), { migrate: true });
    fs.unlinkSync(path.join(root, 'old-one/snapshot.json'));
    storeSnapshot(root, bytes(), { migrate: true });
    assert.deepEqual(snapshotIds(root), ['old-one', 'old-two']);
  }));

test('conflicting dual formats and a corrupt packed format never silently fall back to legacy', () =>
  fixture((root) => {
    legacy(root, 'old-one');
    storeSnapshot(root, bytes(), { migrate: true });
    const legacyPath = path.join(root, 'old-one/snapshot.json');
    fs.writeFileSync(legacyPath, Buffer.concat([bytes(), Buffer.from('\n')]));
    assert.throws(() => readSnapshotBytes(root, 'old-one'), /conflict/i);
    fs.writeFileSync(legacyPath, bytes());
    fs.unlinkSync(objectPath(root, manifest(root).chunks[0]));
    assert.throws(() => readSnapshotBytes(root, 'old-one'), /chunk/i);
  }));

test('a publish failure leaves the legacy snapshot readable and can be resumed without changing objects', () =>
  fixture((root) => {
    legacy(root, 'old-one');
    const original = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (to.endsWith('snapshot.store.json')) {
        throw new Error('injected publish failure');
      }
      return original(from, to);
    };
    try {
      assert.throws(() => storeSnapshot(root, bytes(), { migrate: true }), /publish|write/i);
    } finally {
      fs.linkSync = original;
    }
    assert.equal(fs.existsSync(path.join(root, 'old-one/snapshot.store.json')), false);
    assert.deepEqual(readSnapshotBytes(root, 'old-one'), bytes());
    const saved = fs.readdirSync(path.join(root, 'objects'));
    storeSnapshot(root, bytes(), { migrate: true });
    assert.deepEqual(fs.readdirSync(path.join(root, 'objects')), saved);
    assert.deepEqual(readSnapshotBytes(root, 'old-one'), bytes());
  }));

test('reads return independent parsed objects even when snapshots share chunks', () =>
  fixture((root) => {
    storeSnapshot(root, bytes());
    storeSnapshot(root, bytes('old-two'));
    const first = readSnapshot(root, 'old-one');
    first.shared.list.length = 0;
    assert.equal(readSnapshot(root, 'old-one').shared.list.length, 3);
    assert.equal(readSnapshot(root, 'old-two').shared.list.length, 3);
  }));

test('a directory sync failure after claiming a new identity removes only that empty claim and permits retry', () =>
  fixture((root) => {
    const original = fs.fsyncSync;
    let injected = false;
    fs.fsyncSync = (descriptor) => {
      if (!injected && fs.fstatSync(descriptor).isDirectory()) {
        injected = true;
        throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
      }
      return original(descriptor);
    };
    try {
      assert.throws(() => storeSnapshot(root, bytes('new-probe')), /claim|sync/i);
    } finally {
      fs.fsyncSync = original;
    }
    assert.equal(injected, true);
    assert.equal(snapshotExists(root, 'new-probe'), false);
    assert.deepEqual(snapshotIds(root), []);
    storeSnapshot(root, bytes('new-probe'));
    assert.deepEqual(readSnapshotBytes(root, 'new-probe'), bytes('new-probe'));
  }));

test('a competing mkdir winner keeps its empty identity directory when this writer receives EEXIST', () =>
  fixture((root) => {
    const original = fs.mkdirSync;
    const directory = path.join(root, 'other-claim');
    fs.mkdirSync = (target, ...options) => {
      if (target === directory) {
        original(target, ...options);
        throw Object.assign(new Error('another writer claimed the identity'), { code: 'EEXIST' });
      }
      return original(target, ...options);
    };
    try {
      assert.throws(() => storeSnapshot(root, bytes('other-claim')), /exists|claim/i);
    } finally {
      fs.mkdirSync = original;
    }
    assert.equal(fs.lstatSync(directory).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(snapshotExists(root, 'other-claim'), true);
  }));

test('missing, truncated, modified and over-expanding chunks cannot produce a snapshot', () => {
  for (const damage of ['missing', 'truncated', 'modified', 'expanding']) {
    fixture((root) => {
      storeSnapshot(root, bytes());
      const ref = manifest(root).chunks[0];
      const file = objectPath(root, ref);
      if (damage === 'missing') {
        fs.unlinkSync(file);
      } else if (damage === 'truncated') {
        fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 6));
      } else if (damage === 'modified') {
        fs.writeFileSync(file, gzipSync(Buffer.alloc(ref.bytes, 65)));
      } else {
        fs.writeFileSync(file, gzipSync(Buffer.alloc(ref.bytes + 10000, 65)));
      }
      assert.throws(() => readSnapshotBytes(root, 'old-one'), /chunk|gzip|decompress|size|length/i);
    });
  }
});

test('manifest identity, format, bounds and whole-file digest are verified before trusting data', () => {
  const mutations = [
    (m) => {
      m.id = 'other-id';
    },
    (m) => {
      m.storageVersion = 99;
    },
    (m) => {
      m.bytes = Number.MAX_SAFE_INTEGER;
    },
    (m) => {
      m.chunks[0].bytes = -1;
    },
    (m) => {
      m.chunks[0].sha256 = '../../escape';
    },
    (m) => {
      m.sha256 = `sha256:${'0'.repeat(64)}`;
    },
    (m) => {
      m.chunks.reverse();
    },
    (m) => {
      m.chunks = [];
    },
  ];
  for (const mutation of mutations) {
    fixture((root) => {
      storeSnapshot(root, bytes());
      changeManifest(root, mutation);
      assert.throws(() => readSnapshotBytes(root, 'old-one'), /manifest|snapshot|digest|identity/i);
    });
  }
});

test('identity escapes and symlinked roots, identity directories, manifests and blocks are rejected', () => {
  fixture((root, dir) => {
    for (const id of ['../escape', '/absolute', 'a\\b', 'objects', '']) {
      assert.throws(() => readSnapshotBytes(root, id), /identity/i);
      assert.throws(() => snapshotExists(root, id), /identity/i);
    }
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(root, alias, 'dir');
    assert.throws(() => snapshotIds(alias), /symlink/i);
  });
  for (const target of ['directory', 'manifest', 'block', 'objects']) {
    fixture((root, dir) => {
      storeSnapshot(root, bytes());
      const file =
        target === 'directory'
          ? path.join(root, 'old-one')
          : target === 'manifest'
            ? path.join(root, 'old-one/snapshot.store.json')
            : target === 'objects'
              ? path.join(root, 'objects')
              : objectPath(root, manifest(root).chunks[0]);
      const outside = path.join(dir, 'moved');
      fs.renameSync(file, outside);
      fs.symlinkSync(outside, file, ['directory', 'objects'].includes(target) ? 'dir' : 'file');
      assert.throws(() => readSnapshotBytes(root, 'old-one'), /symlink/i);
    });
  }
});

test('malformed JSON and ID mismatches cannot be migrated or newly published', () =>
  fixture((root) => {
    for (const raw of [Buffer.from('{bad'), Buffer.from('[]'), Buffer.from('{"id":"../escape"}')]) {
      assert.throws(() => storeSnapshot(root, raw), /JSON|object|identity/i);
    }
    legacy(root, 'old-one', bytes('old-two'));
    assert.throws(() => readSnapshotBytes(root, 'old-one'), /identity/i);
    assert.deepEqual(snapshotIds(root), ['old-one']);
  }));

test('a missing manifest remains an explicit unreadable version, and valid IDs do not collide with probe names', () =>
  fixture((root) => {
    storeSnapshot(root, bytes('root-check'));
    assert.deepEqual(snapshotIds(root), ['root-check']);
    fs.unlinkSync(path.join(root, 'root-check/snapshot.store.json'));
    assert.deepEqual(snapshotIds(root), ['root-check']);
    assert.throws(() => readSnapshot(root, 'root-check'), /missing.*snapshot/i);
    assert.equal(snapshotExists(root, 'root-check'), true);
    assert.throws(
      () => storeSnapshot(root, Buffer.from('{"id":"root-check","changed":true}')),
      /exists|immutable/i,
    );
  }));

test('a version replaced by a regular file is diagnosed instead of disappearing from history', () =>
  fixture((root) => {
    fs.writeFileSync(path.join(root, 'old-one'), 'not a directory');
    assert.throws(() => snapshotIds(root), /directory|identity/i);
    assert.throws(() => snapshotExists(root, 'old-one'), /directory|identity/i);
  }));

test('scalar values, escaped keys and empty nested values preserve every original byte', () =>
  fixture((root) => {
    const raw = Buffer.from(
      ' {"id":"edge-case","n":1e+3,"b":true,"x":null,"empty":{},"list":[],"key\\"":{"x":"\\u4e2d \\\\ /,{}[]"}} \r\n',
    );
    storeSnapshot(root, raw);
    assert.deepEqual(readSnapshotBytes(root, 'edge-case'), raw);
  }));

test('manifest sums, reference counts and physical reads have bounded sizes', () => {
  for (const mutate of [
    (m) => {
      m.chunks[0].bytes += 1;
    },
    (m) => {
      m.chunks = Array(257).fill(m.chunks[0]);
      m.bytes = m.chunks[0].bytes * 257;
    },
  ]) {
    fixture((root) => {
      storeSnapshot(root, bytes());
      changeManifest(root, mutate);
      assert.throws(() => readSnapshotBytes(root, 'old-one'), /manifest/i);
    });
  }
  for (const target of ['manifest', 'object']) {
    fixture((root) => {
      storeSnapshot(root, bytes());
      const file =
        target === 'manifest'
          ? path.join(root, 'old-one/snapshot.store.json')
          : objectPath(root, manifest(root).chunks[0]);
      fs.truncateSync(file, target === 'manifest' ? 129 * 1024 : 65 * 1024 * 1024);
      assert.throws(() => readSnapshotBytes(root, 'old-one'), /size|limit|chunk/i);
    });
  }
});

test('concurrent processes cannot overwrite one ID and can safely reuse blocks for different IDs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-snapshot-race-'));
  const storeModule = new URL('../scripts/snapshot-store.mjs', import.meta.url).href;
  try {
    for (const ids of [
      ['same-id', 'same-id'],
      ['first-id', 'other-id'],
    ]) {
      const root = fs.mkdtempSync(path.join(dir, 'store-'));
      const children = ids.map((id, index) => {
        const code = `import fs from 'node:fs'; import {storeSnapshot} from ${JSON.stringify(storeModule)};
          const [root,id,n]=process.argv.slice(1);
          fs.writeFileSync(root+'/ready-'+n,'ready');
          const wait=new Int32Array(new SharedArrayBuffer(4));
          while(!fs.existsSync(root+'/start')){Atomics.wait(wait,0,0,10);}
          storeSnapshot(root,Buffer.from(JSON.stringify({id,shared:'a'.repeat(10000),schemaVersion:1})));`;
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', code, root, id, String(index)],
          { stdio: 'ignore' },
        );
        return {
          child,
          result: new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve({ code, signal }));
          }),
        };
      });
      try {
        const deadline = Date.now() + 10000;
        while (!ids.every((_, i) => fs.existsSync(path.join(root, `ready-${i}`)))) {
          assert.ok(Date.now() < deadline, 'both writers must reach the start barrier');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        fs.writeFileSync(path.join(root, 'start'), 'go');
        const exits = await Promise.all(children.map((c) => c.result));
        assert.equal(exits.filter((r) => r.code === 0).length, new Set(ids).size);
        for (const id of ids) {
          assert.equal(readSnapshot(root, id).shared, 'a'.repeat(10000));
        }
      } finally {
        for (const { child } of children) {
          if (child.exitCode === null) {
            child.kill();
          }
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
