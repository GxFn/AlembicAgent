/** 物理存储层：保留原始字节；schema、来源及行为证据仍由原快照校验器解释。 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const FORMAT = 'alembic-atlas-byte-chunks';
const MANIFEST = 'snapshot.store.json';
const MAX_SNAPSHOT = 128 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_MANIFEST = 128 * 1024;
const MAX_CHUNKS = 256;
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digestValid = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const sizeValid = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;

function identity(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,60}$/u.test(id) || id === 'objects') {
    throw new Error('Invalid snapshot identity');
  }
  return id;
}
function stat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
function storageRoot(root) {
  const base = path.resolve(root);
  const info = stat(base);
  if (info?.isSymbolicLink()) {
    throw new Error('Symlink snapshot storage root rejected');
  }
  if (!info?.isDirectory()) {
    throw new Error('Snapshot storage root must be an existing directory');
  }
  return base;
}
function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** root 是调用方提供的可信根；根以下所有路径段都拒绝 symlink，不接受用户路径拼接。 */
function localTarget(root, relative, createParents = false) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid local storage path');
  }
  const base = storageRoot(root);
  let current = base;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info = stat(current);
    const parent = index < parts.length - 1;
    if (!info && parent && createParents) {
      try {
        fs.mkdirSync(current);
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }
      info = stat(current);
      syncDirectory(path.dirname(current));
    }
    if (info?.isSymbolicLink()) {
      throw new Error(`Symlink in snapshot storage: ${relative}`);
    }
    if (info && (parent ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Invalid snapshot storage file type: ${relative}`);
    }
  }
  return current;
}

export function readConfinedFile(root, relative, { maxBytes = MAX_SNAPSHOT } = {}) {
  const file = localTarget(root, relative);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || !sizeValid(info.size, maxBytes)) {
      throw new Error(`Snapshot file size limit or empty file: ${relative}`);
    }
    // 按已核对长度读取，多读一字节检测在途增长；不让 readFile 随文件增长无界分配。
    const buffer = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = fs.readSync(descriptor, buffer, count, buffer.length - count, count);
      if (!n) {
        break;
      }
      count += n;
    }
    if (count !== info.size) {
      throw new Error(`Snapshot file length changed during read: ${relative}`);
    }
    return buffer.subarray(0, count);
  } catch (error) {
    const failure = new Error(
      `Cannot read snapshot file ${relative}: ${error?.code ?? 'size/read error'}`,
      { cause: error },
    );
    if (error?.code) {
      failure.code = error.code;
    }
    throw failure;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

/** 完整临时文件经同目录 hard-link 发布；目标已存在时绝不 rename 覆盖。 */
export function writeImmutableFile(root, relative, bytes, { reuse = false } = {}) {
  const file = localTarget(root, relative, true);
  if (stat(file)) {
    if (
      reuse &&
      readConfinedFile(root, relative, { maxBytes: Math.max(bytes.length, 1) }).equals(bytes)
    ) {
      syncDirectory(path.dirname(file));
      return;
    }
    throw new Error(`Immutable file already exists: ${relative}`);
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temp, 'wx');
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temp, file);
      syncDirectory(path.dirname(file));
    } catch (error) {
      if (
        error?.code === 'EEXIST' &&
        reuse &&
        readConfinedFile(root, relative, { maxBytes: Math.max(bytes.length, 1) }).equals(bytes)
      ) {
        syncDirectory(path.dirname(file));
        return;
      }
      throw new Error(
        `Cannot publish immutable file ${relative}: ${error?.code ?? 'write error'}`,
        { cause: error },
      );
    }
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (stat(temp)) {
      fs.unlinkSync(temp);
    }
  }
}
function present(root, relative) {
  return stat(localTarget(root, relative)) !== null;
}
function decode(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('Expected a JSON object');
    }
    return value;
  } catch (error) {
    throw new Error('Invalid snapshot JSON object or UTF-8', { cause: error });
  }
}

export function snapshotExists(root, id) {
  identity(id);
  const info = stat(path.join(storageRoot(root), id));
  if (info?.isSymbolicLink()) {
    throw new Error(`Symlink snapshot identity rejected: ${id}`);
  }
  if (info && !info.isDirectory()) {
    throw new Error(`Snapshot identity must be a directory: ${id}`);
  }
  // 损坏/丢失正文不释放历史身份，不能把它当成允许覆盖的“新版本”。
  return info !== null;
}
export function snapshotIds(root) {
  storageRoot(root);
  const ids = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlink in snapshot inventory: ${entry.name}`);
    }
    if (entry.name === 'objects') {
      if (!entry.isDirectory()) {
        throw new Error('Snapshot objects must be a directory');
      }
    } else if (entry.isDirectory()) {
      // 空版本目录也必须交给 reader 诊断，不能把清单丢失解释成“没有这个版本”。
      ids.push(identity(entry.name));
    } else if (/^[a-z0-9][a-z0-9-]{2,60}$/u.test(entry.name)) {
      throw new Error(`Snapshot identity must be a directory: ${entry.name}`);
    }
  }
  return ids.sort((a, b) => a.localeCompare(b, 'en'));
}

function validManifest(value, id) {
  if (
    !value ||
    value.storageVersion !== 1 ||
    value.format !== FORMAT ||
    value.id !== id ||
    !sizeValid(value.bytes, MAX_SNAPSHOT) ||
    !digestValid(value.sha256) ||
    !Array.isArray(value.chunks) ||
    !value.chunks.length ||
    value.chunks.length > MAX_CHUNKS ||
    value.chunks.some((c) => !c || !sizeValid(c.bytes, MAX_CHUNK) || !digestValid(c.sha256)) ||
    value.chunks.reduce((n, c) => n + c.bytes, 0) !== value.bytes
  ) {
    throw new Error(`Invalid snapshot storage manifest: ${id}`);
  }
}
function chunkName(ref) {
  return `objects/${ref.sha256.slice(7)}.json.gz`;
}
function readChunk(root, ref) {
  let raw;
  try {
    const packed = readConfinedFile(root, chunkName(ref), { maxBytes: MAX_CHUNK + 65536 });
    raw = gunzipSync(packed, { maxOutputLength: ref.bytes });
  } catch (error) {
    const reason = /symlink/iu.test(error?.message ?? '')
      ? 'symlink rejected'
      : (error?.code ?? 'read/decompression/size error');
    throw new Error(`Snapshot chunk failure: ${ref.sha256} (${reason})`, { cause: error });
  }
  if (raw.length !== ref.bytes || sha(raw) !== ref.sha256) {
    throw new Error(`Snapshot chunk length/digest mismatch: ${ref.sha256}`);
  }
  return raw;
}

export function readSnapshotBytes(root, id) {
  identity(id);
  const legacy = present(root, `${id}/snapshot.json`);
  const packed = present(root, `${id}/${MANIFEST}`);
  if (!legacy && !packed) {
    throw new Error(`Missing snapshot manifest and legacy file: ${id}`);
  }
  let raw;
  if (packed) {
    const manifest = decode(
      readConfinedFile(root, `${id}/${MANIFEST}`, { maxBytes: MAX_MANIFEST }),
    );
    validManifest(manifest, id);
    raw = Buffer.concat(
      manifest.chunks.map((ref) => readChunk(root, ref)),
      manifest.bytes,
    );
    if (raw.length !== manifest.bytes || sha(raw) !== manifest.sha256) {
      throw new Error(`Snapshot whole-file length/digest mismatch: ${id}`);
    }
    if (legacy && !readConfinedFile(root, `${id}/snapshot.json`).equals(raw)) {
      throw new Error(`Conflicting packed and legacy snapshot: ${id}`);
    }
  } else {
    raw = readConfinedFile(root, `${id}/snapshot.json`);
  }
  if (decode(raw).id !== id) {
    throw new Error(`Snapshot content identity mismatch: ${id}`);
  }
  return raw;
}
export function readSnapshot(root, id) {
  // 不缓存共享可变对象；调用方修改本次解析结果不会污染其他历史版本。
  return decode(readSnapshotBytes(root, id));
}

function splitBytes(raw) {
  const chunks = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const byte = raw[i];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (byte === 92) {
        escaped = true;
      } else if (byte === 34) {
        quoted = false;
      }
    } else if (byte === 34) {
      quoted = true;
    } else if (byte === 123 || byte === 91) {
      depth += 1;
    } else if (byte === 125 || byte === 93) {
      depth -= 1;
    } else if (byte === 44 && depth === 1) {
      chunks.push(raw.subarray(start, i + 1));
      start = i + 1;
    }
  }
  chunks.push(raw.subarray(start));
  return chunks;
}

export function storeSnapshot(root, raw, { migrate = false } = {}) {
  if (!Buffer.isBuffer(raw) || !sizeValid(raw.length, MAX_SNAPSHOT)) {
    throw new Error('Snapshot bytes exceed size limit or are not a Buffer');
  }
  const id = identity(decode(raw).id);
  const exists = snapshotExists(root, id);
  if (exists) {
    if (!migrate) {
      throw new Error(`Immutable snapshot already exists: ${id}`);
    }
    if (!readSnapshotBytes(root, id).equals(raw)) {
      throw new Error(`Migration conflicts with existing snapshot: ${id}`);
    }
    if (present(root, `${id}/${MANIFEST}`)) {
      return decode(readConfinedFile(root, `${id}/${MANIFEST}`, { maxBytes: MAX_MANIFEST }));
    }
  } else if (migrate) {
    throw new Error(`Migration requires an existing snapshot: ${id}`);
  }
  const chunks = splitBytes(raw);
  const manifest = {
    storageVersion: 1,
    format: FORMAT,
    id,
    bytes: raw.length,
    sha256: sha(raw),
    chunks: chunks.map((chunk) => ({ sha256: sha(chunk), bytes: chunk.length })),
  };
  validManifest(manifest, id);
  const directory = path.join(storageRoot(root), id);
  let claimed = false;
  let published = false;
  try {
    if (!exists) {
      try {
        fs.mkdirSync(directory);
        // 只有 mkdir 成功才拥有该目录；后续同步失败也必须进入下方空目录清理。
        claimed = true;
        syncDirectory(path.dirname(directory));
      } catch (error) {
        throw new Error(`Immutable snapshot identity already exists or cannot be claimed: ${id}`, {
          cause: error,
        });
      }
    }
    for (const [index, ref] of manifest.chunks.entries()) {
      if (present(root, chunkName(ref))) {
        readChunk(root, ref);
        continue;
      }
      try {
        writeImmutableFile(root, chunkName(ref), gzipSync(chunks[index], { level: 9 }));
      } catch (error) {
        // 其他写入者可能刚发布同块；只在内容验证通过时复用，不覆盖或忽略损坏。
        if (!present(root, chunkName(ref))) {
          throw error;
        }
        readChunk(root, ref);
      }
    }
    // 发布前按实际落盘对象完整还原，不能把只验证内存 buffer 当成存储验证。
    const recovered = Buffer.concat(
      manifest.chunks.map((ref) => readChunk(root, ref)),
      raw.length,
    );
    if (!recovered.equals(raw)) {
      throw new Error(`Snapshot reconstruction failed before publication: ${id}`);
    }
    writeImmutableFile(
      root,
      `${id}/${MANIFEST}`,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    published = true;
    return manifest;
  } finally {
    // 仅回收本次新建且仍为空的身份目录；从不删除已有历史或其他写入者的文件。
    if (
      claimed &&
      !published &&
      stat(directory)?.isDirectory() &&
      fs.readdirSync(directory).length === 0
    ) {
      fs.rmdirSync(directory);
    }
  }
}
