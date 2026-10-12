/**
 * Agent 记忆向量 sidecar。SQLite 仍是记忆事实源；此处只保存可重建的向量缓存。
 * v2 在向量旁记录正文 hash，旧 id→vector JSON 可读，但参与正文召回前须重新生成。
 * profile 绑定是双向的：带 profileId 的实例不读其他 profile 的文件；未绑定实例不读、
 * 也不覆盖已绑定的文件（无法证明处于同一向量空间，覆盖还会抹掉文件的 profileId）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WriteZone } from '@alembic/core/io';
import { isMemoryVector, type MemoryReadOptions, reportMemoryRead } from './MemoryReadPolicy.js';

const FLUSH_DELAY_MS = 2000;
const SIDECAR_PATH = 'context/memory_embeddings.json';
interface EmbeddingEntry {
  vector: number[];
  contentHash?: string;
}
interface EmbeddingInput {
  id: string;
  embedding: number[];
  content?: string;
}
interface EmbeddingStoreOptions {
  /** 独立 embedding 的模型空间身份；不依赖当前生成模型或连接凭据。 */
  profileId?: string;
  filePath?: string;
  wz?: WriteZone;
  onDiagnostic?: MemoryReadOptions['onDiagnostic'];
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class MemoryEmbeddingStore {
  #cache = new Map<string, EmbeddingEntry>();
  #filePath: string;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;
  #disposed = false;
  readonly #wz: WriteZone | null;
  readonly #diagnostics: MemoryReadOptions;
  readonly #profileId: string | undefined;

  constructor(projectRoot: string, opts: EmbeddingStoreOptions = {}) {
    if (
      opts.profileId !== undefined &&
      (typeof opts.profileId !== 'string' || !opts.profileId.trim())
    ) {
      throw new Error('Embedding profileId must be a non-empty string');
    }
    this.#profileId = opts.profileId;
    this.#wz = opts.wz ?? null;
    // 注入 WriteZone 时读写使用同一目标；filePath 仅覆盖直接文件系统模式。
    this.#filePath =
      this.#wz?.runtime(SIDECAR_PATH).absolute ??
      opts.filePath ??
      join(projectRoot, '.asd', SIDECAR_PATH);
    this.#diagnostics = { onDiagnostic: opts.onDiagnostic };
    this.#load();
  }

  /** 不传 content 保留旧读取接口；实际召回必须绑定当前正文。返回副本避免绕过 dirty 状态。 */
  get(id: string, content?: string): number[] | null {
    const entry = this.#cache.get(id);
    if (!entry) {
      return null;
    }
    if (content !== undefined && entry.contentHash !== contentHash(content)) {
      reportMemoryRead(this.#diagnostics, {
        phase: 'embedding',
        status: 'stale',
        reason: 'content-version-mismatch',
      });
      return null;
    }
    return [...entry.vector];
  }

  set(id: string, embedding: number[], content?: string): void {
    this.batchSet([{ id, embedding, content }]);
  }

  batchSet(entries: EmbeddingInput[]): number {
    this.#assertOpen();
    let count = 0;
    for (const { id, embedding, content } of entries) {
      if (!id || !isMemoryVector(embedding)) {
        reportMemoryRead(this.#diagnostics, {
          phase: 'backfill',
          status: 'invalid',
          reason: 'invalid-vector',
        });
        continue;
      }
      this.#cache.set(id, {
        vector: [...embedding],
        ...(content !== undefined ? { contentHash: contentHash(content) } : {}),
      });
      count++;
    }
    if (count > 0) {
      this.#scheduleDirtyFlush();
    }
    return count;
  }

  delete(id: string): boolean {
    this.#assertOpen();
    const existed = this.#cache.delete(id);
    if (existed) {
      this.#scheduleDirtyFlush();
    }
    return existed;
  }

  /**
   * 只判断缓存里是否存在该 id 的条目，不代表向量可用：旧版无正文 hash 的条目、
   * 正文已改动的条目同样返回 true。需要“与当前正文匹配”的判断请用 get(id, content)。
   */
  has(id: string): boolean {
    return this.#cache.has(id);
  }
  /**
   * 只按 id 判断缺失，与 has 语义一致；正文已改动或旧版条目不会被列为缺失。
   * 决定哪些记忆需要重新 embed 时应逐条用 get(id, content) 判断（embedAllMemories 即如此）。
   */
  getMissingIds(candidateIds: string[]): string[] {
    return candidateIds.filter((id) => !this.#cache.has(id));
  }
  get size(): number {
    return this.#cache.size;
  }

  clear(): void {
    this.#assertOpen();
    this.#cache.clear();
    this.#scheduleDirtyFlush();
  }

  /** 写成功才清 dirty；失败可再次显式 flush，或由后续写入触发重试。 */
  flushSync(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#dirty && this.#writeFile()) {
      this.#dirty = false;
    }
  }

  /** 释放自己拥有的 timer；失败保留内存中的 dirty 状态，仍允许显式 flush 重试。 */
  dispose(): void {
    this.flushSync();
    this.#disposed = true;
  }

  gc(activeIds: Set<string>): number {
    this.#assertOpen();
    let removed = 0;
    for (const id of this.#cache.keys()) {
      if (!activeIds.has(id)) {
        this.#cache.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      this.#scheduleDirtyFlush();
    }
    return removed;
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new Error('MemoryEmbeddingStore is disposed');
    }
  }

  #load(): void {
    try {
      if (!existsSync(this.#filePath)) {
        return;
      }
      const data: unknown = JSON.parse(readFileSync(this.#filePath, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid embedding sidecar');
      }
      const object = data as Record<string, unknown>;
      if (this.#profileId === undefined && typeof object.profileId === 'string') {
        // 未绑定实例无法确认自己与文件处于同一向量空间：跳过加载，避免拿其他模型的向量算余弦。
        // 写盘时 #writeFile 会再次核对磁盘绑定并拒绝覆盖，所以这里不需要额外状态。
        reportMemoryRead(this.#diagnostics, {
          phase: 'embedding',
          status: 'stale',
          reason: 'embedding-profile-unbound',
        });
        return;
      }
      if (this.#profileId !== undefined && object.profileId !== this.#profileId) {
        // 维度相同不等于向量空间相同；旧缓存只跳过读取，不在构造时删除或重写。
        reportMemoryRead(this.#diagnostics, {
          phase: 'embedding',
          status: 'stale',
          reason: 'embedding-profile-mismatch',
        });
        return;
      }
      const versioned = object.schemaVersion !== undefined;
      if (
        versioned &&
        (object.schemaVersion !== 2 ||
          !object.embeddings ||
          typeof object.embeddings !== 'object' ||
          Array.isArray(object.embeddings))
      ) {
        throw new Error('Unsupported embedding sidecar');
      }
      const entries = versioned ? (object.embeddings as Record<string, unknown>) : object;
      let rejected = false;
      for (const [id, raw] of Object.entries(entries)) {
        const entry =
          versioned && raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null;
        const vector = versioned ? entry?.vector : raw;
        const hash = entry?.contentHash;
        if (
          !isMemoryVector(vector) ||
          (hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))
        ) {
          rejected = true;
          continue;
        }
        this.#cache.set(id, {
          vector: [...vector],
          ...(typeof hash === 'string' ? { contentHash: hash } : {}),
        });
      }
      if (rejected) {
        reportMemoryRead(this.#diagnostics, {
          phase: 'embedding',
          status: 'invalid',
          reason: 'invalid-sidecar-entries-skipped',
        });
      }
    } catch (err: unknown) {
      reportMemoryRead(this.#diagnostics, {
        phase: 'embedding',
        status: 'error',
        reason: err instanceof SyntaxError ? 'sidecar-invalid-json' : 'sidecar-unreadable',
      });
    }
  }

  #writeFile(): boolean {
    // 未绑定实例写盘前核对磁盘现状（文件可能在构造后才被带 profile 的实例写入）：
    // 已绑定的文件只能由同 profile 实例改写，这里拒绝覆盖并按失败处理，dirty 保留，
    // 文件被移除或解除绑定后仍可再次 flush。带 profile 的实例沿用原有覆盖语义。
    if (this.#profileId === undefined && this.#boundProfileOnDisk() !== undefined) {
      reportMemoryRead(this.#diagnostics, {
        phase: 'backfill',
        status: 'invalid',
        reason: 'sidecar-write-skipped:embedding-profile-unbound',
      });
      return false;
    }
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    const staged = this.#wz?.runtime(`context/.memory_embeddings.${randomUUID()}.tmp`);
    try {
      const content = JSON.stringify({
        schemaVersion: 2,
        ...(this.#profileId !== undefined ? { profileId: this.#profileId } : {}),
        embeddings: Object.fromEntries(this.#cache),
      });
      if (this.#wz && staged) {
        this.#wz.writeFile(staged, content);
        this.#wz.rename(staged, this.#wz.runtime(SIDECAR_PATH));
      } else {
        mkdirSync(dirname(this.#filePath), { recursive: true });
        writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
        renameSync(temporary, this.#filePath);
      }
      return true;
    } catch (err: unknown) {
      reportMemoryRead(this.#diagnostics, {
        phase: 'backfill',
        status: 'error',
        reason: `sidecar-write-failed:${err instanceof Error ? err.name : 'unknown'}`,
      });
      return false;
    } finally {
      try {
        if (this.#wz && staged) {
          this.#wz.remove(staged);
        } else {
          rmSync(temporary, { force: true });
        }
      } catch (err: unknown) {
        reportMemoryRead(this.#diagnostics, {
          phase: 'backfill',
          status: 'error',
          reason: `sidecar-temp-cleanup-failed:${err instanceof Error ? err.name : 'unknown'}`,
        });
      }
    }
  }

  /** 读取磁盘上 sidecar 绑定的 profileId；不存在、无绑定或无法解析时返回 undefined。 */
  #boundProfileOnDisk(): string | undefined {
    try {
      if (!existsSync(this.#filePath)) {
        return undefined;
      }
      const data: unknown = JSON.parse(readFileSync(this.#filePath, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return undefined;
      }
      const profileId = (data as Record<string, unknown>).profileId;
      return typeof profileId === 'string' ? profileId : undefined;
    } catch (err: unknown) {
      // 损坏或读不到的文件无法证明已绑定：保持原有写路径（覆盖损坏文件），但留下诊断。
      reportMemoryRead(this.#diagnostics, {
        phase: 'backfill',
        status: 'stale',
        reason: `sidecar-binding-check-failed:${err instanceof SyntaxError ? 'invalid-json' : err instanceof Error ? err.name : 'unknown'}`,
      });
      return undefined;
    }
  }

  #scheduleDirtyFlush(): void {
    this.#dirty = true;
    if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        this.flushSync();
      }, FLUSH_DELAY_MS);
      this.#flushTimer.unref?.();
    }
  }
}
