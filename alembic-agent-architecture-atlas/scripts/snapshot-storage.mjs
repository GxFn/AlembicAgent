import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshotShape } from './evidence.mjs';
import {
  readConfinedFile,
  readSnapshotBytes,
  snapshotIds,
  storeSnapshot,
  writeImmutableFile,
} from './snapshot-store.mjs';

const defaultAtlasDirectory = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const maxFileBytes = 256 * 1024 * 1024;
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const usage = 'Usage: snapshot-storage.mjs verify | migrate | restore --id <snapshot-id>';

function parseArguments(args) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error(usage);
  }
  if (args.length === 1 && ['verify', 'migrate'].includes(args[0])) {
    return { command: args[0] };
  }
  if (
    args.length === 3 &&
    args[0] === 'restore' &&
    args[1] === '--id' &&
    /^[a-z0-9][a-z0-9-]{2,60}$/u.test(args[2]) &&
    args[2] !== 'objects'
  ) {
    return { command: 'restore', id: args[2] };
  }
  throw new Error(`Unknown command or argument. ${usage}`);
}

function optionalFile(root, relative) {
  try {
    fs.lstatSync(path.join(root, relative));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return readConfinedFile(root, relative, { maxBytes: maxFileBytes });
}

function validatedSnapshot(root, id) {
  const bytes = readSnapshotBytes(root, id);
  const value = JSON.parse(bytes.toString('utf8'));
  const errors = validateSnapshotShape(value, id);
  if (errors.length) {
    throw new Error(`Invalid snapshot ${id}: ${errors.join('; ')}`);
  }
  return { id, bytes, value };
}

function storageReport(command, root, records) {
  const objectReferences = new Map();
  const snapshots = records.map(({ id, bytes, value }) => {
    const legacy = optionalFile(root, `${id}/snapshot.json`);
    const packed = optionalFile(root, `${id}/snapshot.store.json`);
    const chunks = packed ? JSON.parse(packed.toString('utf8')).chunks : [];
    const unique = new Map();
    for (const chunk of chunks) {
      unique.set(chunk.sha256, chunk.bytes);
      objectReferences.set(chunk.sha256, (objectReferences.get(chunk.sha256) ?? 0) + 1);
    }
    let referencedObjectBytes = 0;
    for (const sha256 of unique.keys()) {
      referencedObjectBytes += readConfinedFile(root, `objects/${sha256.slice(7)}.json.gz`, {
        maxBytes: maxFileBytes,
      }).length;
    }
    return {
      id,
      schemaVersion: value.schemaVersion,
      storage: legacy ? (packed ? 'mixed' : 'legacy') : 'packed',
      rawBytes: bytes.length,
      rawSha256: digest(bytes),
      legacyBytes: legacy?.length ?? 0,
      manifestBytes: packed?.length ?? 0,
      objectReferences: chunks.length,
      uniqueObjects: unique.size,
      referencedObjectBytes,
    };
  });
  let objectBytes = 0;
  let objectFiles = 0;
  let unreferencedObjectBytes = 0;
  let unreferencedObjects = 0;
  let objectDirectory;
  try {
    objectDirectory = fs.lstatSync(path.join(root, 'objects'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (objectDirectory) {
    if (objectDirectory.isSymbolicLink() || !objectDirectory.isDirectory()) {
      throw new Error('Snapshot objects directory must be a directory, not a symlink');
    }
    for (const name of fs.readdirSync(path.join(root, 'objects')).sort()) {
      if (!/^[a-f0-9]{64}\.json\.gz$/u.test(name)) {
        throw new Error(`Unexpected snapshot object file: ${name}`);
      }
      const stored = readConfinedFile(root, `objects/${name}`, { maxBytes: maxFileBytes });
      objectBytes += stored.length;
      objectFiles += 1;
      if (!objectReferences.has(`sha256:${name.slice(0, 64)}`)) {
        unreferencedObjectBytes += stored.length;
        unreferencedObjects += 1;
      }
    }
  }
  const sum = (key) => snapshots.reduce((total, snapshot) => total + snapshot[key], 0);
  const legacyBytes = sum('legacyBytes');
  const manifestBytes = sum('manifestBytes');
  const references = sum('objectReferences');
  return {
    schemaVersion: 1,
    command,
    snapshots,
    totals: {
      snapshots: snapshots.length,
      rawBytes: sum('rawBytes'),
      legacyBytes,
      manifestBytes,
      objectBytes,
      objectFiles,
      uniqueObjects: objectReferences.size,
      objectReferences: references,
      reusedObjectReferences: references - objectReferences.size,
      unreferencedObjects,
      unreferencedObjectBytes,
      activeBytes: legacyBytes + manifestBytes + objectBytes,
    },
  };
}

/** 迁移只改变存储介质；所有原文先复核并备份，任何失败都不能用其他版本代替历史。 */
export function runSnapshotStorage(args, atlasDirectory = defaultAtlasDirectory) {
  const { command, id } = parseArguments(args);
  const atlas = path.resolve(atlasDirectory);
  // storeRoot 的祖先也必须留在 Atlas；不能把 evidence 的 symlink 当作受信任根传入。
  for (const relative of ['', 'evidence', 'evidence/snapshots']) {
    const directory = fs.lstatSync(path.join(atlas, relative));
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error(`Atlas storage directory or symlink rejected: ${relative || 'atlas'}`);
    }
  }
  const root = path.join(atlas, 'evidence/snapshots');
  const ids = snapshotIds(root);
  if (command === 'restore') {
    if (!ids.includes(id)) {
      throw new Error(`Unknown snapshot identity: ${id}`);
    }
    const record = validatedSnapshot(root, id);
    const destination = `.cache/snapshot-exports/${id}/snapshot.json`;
    writeImmutableFile(atlas, destination, record.bytes, { reuse: true });
    const restored = readConfinedFile(atlas, destination, { maxBytes: maxFileBytes });
    if (!restored.equals(record.bytes)) {
      throw new Error(`Snapshot export byte mismatch: ${id}`);
    }
    return {
      schemaVersion: 1,
      command,
      id,
      destination,
      rawBytes: restored.length,
      rawSha256: digest(restored),
    };
  }
  // 必须先完成全量预检；不能迁移了前几份才发现后面的历史或备份已损坏。
  const records = ids.map((snapshotId) => validatedSnapshot(root, snapshotId));
  const before = storageReport(command, root, records);
  if (command === 'verify') {
    return before;
  }
  for (const record of records) {
    record.backup = `.cache/snapshot-storage-migration/originals/evidence/snapshots/${record.id}/snapshot.json`;
    const previous = optionalFile(atlas, record.backup);
    if (previous && !previous.equals(record.bytes)) {
      throw new Error(`Conflicting immutable migration backup: ${record.id}`);
    }
  }
  for (const record of records) {
    writeImmutableFile(atlas, record.backup, record.bytes, { reuse: true });
  }
  for (const record of records) {
    storeSnapshot(root, record.bytes, { migrate: true });
    const restored = readSnapshotBytes(root, record.id);
    if (!restored.equals(record.bytes)) {
      throw new Error(`Migrated snapshot byte mismatch: ${record.id}`);
    }
    const relative = `${record.id}/snapshot.json`;
    const original = optionalFile(root, relative);
    if (original) {
      if (!original.equals(record.bytes)) {
        throw new Error(`Legacy snapshot changed during migration: ${record.id}`);
      }
      // manifest 和共享对象已统一读取并逐字节核对，才移除活动目录内的旧副本。
      fs.unlinkSync(path.join(root, relative));
    }
  }
  return storageReport(command, root, records);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runSnapshotStorage(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Snapshot storage command failed');
    process.exitCode = 1;
  }
}
