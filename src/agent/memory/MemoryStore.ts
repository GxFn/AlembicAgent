/**
 * MemoryStore — 持久化记忆 SQLite 存储层
 *
 * 从 PersistentMemory.js 提取的 CRUD + SQL 基础设施。
 * 负责:
 *   - 基本 CRUD: add, update, delete, get
 *   - 批量查询: getAllActive, size, getStats
 *   - 访问计数: touchAccess
 *   - 容量控制: enforceCapacity
 *   - 维护: compact
 *   - 统计: getStats, clearBootstrapMemories
 *
 * 设计原则:
 *   - Core facade 负责语义记忆表结构创建
 *   - Agent 保留同步 raw SQLite adapter，兼容现有调用方
 *   - embedding 已迁移至 MemoryEmbeddingStore (JSON sidecar)
 *   - 数据序列化/反序列化统一在此层处理
 *
 * 边界说明（2026-06-11）:
 *   - `semantic_memories` 表的 schema 所有权在 Core（`@alembic/core/memory`）：
 *     schema.ts 定义表结构，migration 001 负责建表，MemoryRepository.ts 是 Core 侧
 *     仓储实现。本文件只通过 ensureSemanticMemorySchema 消费该 schema，
 *     不得在 Agent 侧另行定义或迁移该表结构。
 *   - 本 raw-SQL 同步 adapter 的长期归属（留在 Agent 还是下沉 Core）待 RC6 SD-4
 *     决策（demand 序列 `alembic-redundancy-stale-logic-cleanup`）；
 *     SD-4 决策落地前不做任何代码搬移。
 *
 * @module MemoryStore
 */

import { randomUUID } from 'node:crypto';
import {
  ensureSemanticMemorySchema,
  type SemanticMemorySqliteDatabase,
} from '@alembic/core/memory';
import { jaccardSimilarity, tokenizeForSimilarity } from '@alembic/core/search';

// ─── 类型定义 ──────────────────────────────────────────

/** better-sqlite3 Database 结构接口 */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
}

/** better-sqlite3 Statement 结构接口 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** 数据库行 (raw row from SQLite — 保持向后兼容) */
export interface MemoryRow {
  id: string;
  type: string;
  content: string;
  source: string;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  related_entities: string;
  related_memories: string;
  source_dimension: string | null;
  source_evidence: string | null;
  bootstrap_session: string | null;
  tags: string;
  /** findSimilar 附加字段 */
  similarity?: number;
  related_memories_raw?: string;
}

export const MEMORY_STORE_SEMANTIC_TABLE = 'semantic_memories';

export const MEMORY_STORE_REQUIRED_COLUMNS = Object.freeze([
  'id',
  'type',
  'content',
  'source',
  'importance',
  'access_count',
  'last_accessed_at',
  'created_at',
  'updated_at',
  'expires_at',
  'related_entities',
  'related_memories',
  'source_dimension',
  'source_evidence',
  'bootstrap_session',
  'tags',
] as const satisfies readonly (keyof MemoryRow)[]);

/** 反序列化后的记忆对象 */
export interface DeserializedMemory {
  id: string;
  type: string;
  content: string;
  source: string;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  relatedEntities: string[];
  relatedMemories: string[];
  sourceDimension: string | null;
  sourceEvidence: string | null;
  bootstrapSession: string | null;
  tags: string[];
}

/** 添加记忆时的输入 */
export interface MemoryInput {
  type?: string;
  content: string;
  source?: string;
  importance?: number;
  ttlDays?: number | null;
  relatedEntities?: string[];
  sourceDimension?: string | null;
  sourceEvidence?: string | null;
  bootstrapSession?: string | null;
  tags?: string[];
}

/** 更新记忆时的字段 */
export interface MemoryUpdates {
  content?: string;
  importance?: number;
  accessCount?: number;
  relatedEntities?: string[];
  relatedMemories?: string[];
  tags?: string[];
}

export class MemoryStoreWriteError extends Error {
  readonly code = 'MEMORY_STORE_WRITE_FAILED';
  readonly operation: 'add';
  readonly cause: unknown;

  constructor(operation: 'add', cause: unknown) {
    const message =
      cause instanceof Error && cause.message
        ? `MemoryStore ${operation} failed: ${cause.message}`
        : `MemoryStore ${operation} failed`;
    super(message);
    this.name = 'MemoryStoreWriteError';
    this.operation = operation;
    this.cause = cause;
  }
}

// ─── 常量 ──────────────────────────────────────────────

/** 最大记忆条数 (防止无限膨胀) */
const MAX_MEMORIES = 500;

/** 自然遗忘阈值 */
const ARCHIVE_DAYS = 30;
const FORGET_DAYS = 90;

export class MemoryStore {
  #db: SqliteDatabase;

  /** @param db better-sqlite3 实例 (raw) */
  constructor(db: SqliteDatabase) {
    this.#db = db;
    if (hasMemoryStoreSemanticTable(db)) {
      assertMemoryStoreSchemaShape(db);
    }
    ensureSemanticMemorySchema(db as unknown as SemanticMemorySqliteDatabase);
    assertMemoryStoreSchemaShape(db);
  }

  /** 获取原始 db 引用 (for transaction) */
  get db() {
    return this.#db;
  }

  // ═══════════════════════════════════════════════════════════
  // 基本 CRUD
  // ═══════════════════════════════════════════════════════════

  /**
   * 添加一条记忆
   * @returns }
   */
  add(memory: MemoryInput) {
    const id = `smem_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const now = new Date().toISOString();
    const content = (memory.content || '').trim().substring(0, 500);
    const importance = Math.max(1, Math.min(10, memory.importance || 5));
    const expiresAt = memory.ttlDays
      ? new Date(Date.now() + memory.ttlDays * 86400_000).toISOString()
      : null;

    try {
      this.#db
        .prepare(`
          INSERT INTO semantic_memories (
            id,
            type,
            content,
            source,
            importance,
            access_count,
            last_accessed_at,
            created_at,
            updated_at,
            expires_at,
            related_entities,
            related_memories,
            source_dimension,
            source_evidence,
            bootstrap_session,
            tags
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          memory.type || 'fact',
          content,
          memory.source || 'bootstrap',
          importance,
          0,
          now,
          now,
          now,
          expiresAt,
          JSON.stringify(memory.relatedEntities || []),
          JSON.stringify([]),
          memory.sourceDimension || null,
          memory.sourceEvidence || null,
          memory.bootstrapSession || null,
          JSON.stringify(memory.tags || [])
        );
    } catch (err: unknown) {
      throw new MemoryStoreWriteError('add', err);
    }

    return { id, action: 'ADD' };
  }

  /**
   * 更新已有记忆
   */
  update(id: string, updates: MemoryUpdates) {
    const existing = this.#db.prepare('SELECT id FROM semantic_memories WHERE id = ?').get(id);

    if (!existing) {
      return false;
    }

    const now = new Date().toISOString();
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      params.push(updates.content.substring(0, 500));
    }
    if (updates.importance !== undefined) {
      setClauses.push('importance = ?');
      params.push(Math.max(1, Math.min(10, updates.importance)));
    }
    if (updates.accessCount !== undefined) {
      setClauses.push('access_count = ?');
      params.push(updates.accessCount);
    }
    if (updates.relatedEntities !== undefined) {
      setClauses.push('related_entities = ?');
      params.push(JSON.stringify(updates.relatedEntities));
    }
    if (updates.relatedMemories !== undefined) {
      setClauses.push('related_memories = ?');
      params.push(JSON.stringify(updates.relatedMemories));
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      params.push(JSON.stringify(updates.tags));
    }

    if (setClauses.length === 0) {
      return false;
    }

    setClauses.push('updated_at = ?');
    params.push(now, id);

    const result = this.#db
      .prepare(`UPDATE semantic_memories SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...params);
    return result.changes > 0;
  }

  /** 删除一条记忆 */
  delete(id: string) {
    const result = this.#db.prepare('DELETE FROM semantic_memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** 按 ID 获取 */
  get(id: string): DeserializedMemory | null {
    const row = this.#db.prepare('SELECT * FROM semantic_memories WHERE id = ?').get(id);
    return row ? MemoryStore.deserialize(MemoryStore.#normalizeRow(row)) : null;
  }

  // ═══════════════════════════════════════════════════════════
  // 批量查询
  // ═══════════════════════════════════════════════════════════

  /**
   * 获取所有活跃记忆 (未过期)
   * @returns raw rows
   */
  getAllActive({ source, type }: { source?: string; type?: string } = {}): MemoryRow[] {
    const now = new Date().toISOString();
    const conditions = ['(expires_at IS NULL OR expires_at > ?)'];
    const params: unknown[] = [now];
    if (source) {
      conditions.push('source = ?');
      params.push(source);
    }
    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    const rows = this.#db
      .prepare(`
        SELECT *
        FROM semantic_memories
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC
      `)
      .all(...params);

    return rows.map(MemoryStore.#normalizeRow);
  }

  /** 获取候选记忆 (用于相似度搜索) */
  getCandidates(type: string | null): MemoryRow[] {
    const now = new Date().toISOString();
    const conditions = ['(expires_at IS NULL OR expires_at > ?)'];
    const params: unknown[] = [now];
    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    const rows = this.#db
      .prepare(`
        SELECT *
        FROM semantic_memories
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT 50
      `)
      .all(...params);

    return rows.map(MemoryStore.#normalizeRow);
  }

  /** 更新访问计数 */
  touchAccess(id: string) {
    try {
      this.#db
        .prepare(`
          UPDATE semantic_memories
          SET access_count = access_count + 1,
              last_accessed_at = ?
          WHERE id = ?
        `)
        .run(new Date().toISOString(), id);
    } catch {
      /* non-critical */
    }
  }

  /** 记忆总数 */
  size({ source }: { source?: string } = {}) {
    const row = source
      ? this.#db
          .prepare('SELECT COUNT(*) AS cnt FROM semantic_memories WHERE source = ?')
          .get(source)
      : this.#db.prepare('SELECT COUNT(*) AS cnt FROM semantic_memories').get();
    return MemoryStore.#countFromRow(row);
  }

  // ═══════════════════════════════════════════════════════════
  // 维护
  // ═══════════════════════════════════════════════════════════

  /**
   * 执行维护: 清理过期记忆 + 容量控制
   * @returns }
   */
  compact() {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const stats = { expired: 0, forgotten: 0, archived: 0, remaining: 0 };

    const runCompaction = this.#db.transaction(() => {
      // 清除已过期
      const expiredResult = this.#db
        .prepare('DELETE FROM semantic_memories WHERE expires_at IS NOT NULL AND expires_at < ?')
        .run(now);
      stats.expired = expiredResult.changes;

      // 遗忘：长期未访问且不重要的
      const forgetThreshold = new Date(nowMs - FORGET_DAYS * 86400_000).toISOString();
      const forgottenResult = this.#db
        .prepare(`
          DELETE FROM semantic_memories
          WHERE last_accessed_at < ?
            AND importance < 7
        `)
        .run(forgetThreshold);
      stats.forgotten = forgottenResult.changes;

      // 归档：降低重要性
      const archiveThreshold = new Date(nowMs - ARCHIVE_DAYS * 86400_000).toISOString();
      const archiveResult = this.#db
        .prepare(`
          UPDATE semantic_memories
          SET importance = MAX(1, importance - 1)
          WHERE last_accessed_at < ?
            AND importance < 3
        `)
        .run(archiveThreshold);
      stats.archived = archiveResult.changes;

      stats.remaining = MemoryStore.#countFromRow(
        this.#db.prepare('SELECT COUNT(*) AS cnt FROM semantic_memories').get()
      );
    });
    runCompaction();

    return stats;
  }

  /** 容量控制 */
  enforceCapacity() {
    const total = MemoryStore.#countFromRow(
      this.#db.prepare('SELECT COUNT(*) AS cnt FROM semantic_memories').get()
    );
    if (total <= MAX_MEMORIES) {
      return;
    }

    const excess = total - MAX_MEMORIES;
    this.#db
      .prepare(`
        DELETE FROM semantic_memories
        WHERE id IN (
          SELECT id
          FROM semantic_memories
          ORDER BY importance ASC, access_count ASC, updated_at ASC
          LIMIT ?
        )
      `)
      .run(excess);
  }

  /** 获取统计信息 */
  getStats() {
    const total = MemoryStore.#countFromRow(
      this.#db.prepare('SELECT COUNT(*) AS cnt FROM semantic_memories').get()
    );
    const byType = this.#db
      .prepare('SELECT type, COUNT(*) AS cnt FROM semantic_memories GROUP BY type')
      .all();
    const bySource = this.#db
      .prepare('SELECT source, COUNT(*) AS cnt FROM semantic_memories GROUP BY source')
      .all();
    const avgRow = this.#db.prepare('SELECT AVG(importance) AS avg FROM semantic_memories').get();
    const avgImportance = MemoryStore.#numberFromField(avgRow, 'avg', 0);

    return {
      total,
      byType: Object.fromEntries(
        byType.map((row) => [
          MemoryStore.#stringFromField(row, 'type', 'unknown'),
          MemoryStore.#numberFromField(row, 'cnt', 0),
        ])
      ),
      bySource: Object.fromEntries(
        bySource.map((row) => [
          MemoryStore.#stringFromField(row, 'source', 'unknown'),
          MemoryStore.#numberFromField(row, 'cnt', 0),
        ])
      ),
      avgImportance: Math.round(avgImportance * 10) / 10,
    };
  }

  /** 清除所有 bootstrap 来源的记忆 */
  clearBootstrapMemories() {
    const result = this.#db
      .prepare('DELETE FROM semantic_memories WHERE source = ?')
      .run('bootstrap');
    return result.changes;
  }

  // ═══════════════════════════════════════════════════════════
  // 相似度搜索
  // ═══════════════════════════════════════════════════════════

  /**
   * 查找相似记忆 (基于 token overlap)
   * @param content 搜索文本
   * @param type 过滤 type (null=全部)
   * @param limit 返回条数
   * @returns 带 similarity 和 related_memories_raw 字段的 raw rows
   */
  findSimilar(content: string, type: string | null, limit: number): MemoryRow[] {
    const candidates = this.getCandidates(type);
    const lowerContent = content.toLowerCase();
    const contentTokens = tokenizeForSimilarity(lowerContent) as Set<string>;

    const scored = candidates
      .map((row) => {
        const similarity = MemoryStore.computeSimilarity(contentTokens, lowerContent, row.content);
        return { ...row, similarity, related_memories_raw: row.related_memories };
      })
      .filter((r) => r.similarity > 0.1)
      .sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, limit);
  }

  /**
   * 计算两段文本的相似度 (Jaccard + 子串匹配)
   * @returns 0.0-1.0
   */
  static computeSimilarity(tokensA: Set<string>, lowerA: string, contentB: string): number {
    const lowerB = (contentB || '').toLowerCase();
    const tokensB = tokenizeForSimilarity(lowerB);

    if (tokensA.size === 0 && tokensB.size === 0) {
      return 1.0;
    }
    if (tokensA.size === 0 || tokensB.size === 0) {
      return 0.0;
    }

    const jaccard = jaccardSimilarity(tokensA, tokensB);
    const containsBonus = lowerA.includes(lowerB) || lowerB.includes(lowerA) ? 0.3 : 0;
    return Math.min(1.0, jaccard + containsBonus);
  }

  /** 创建 transaction wrapper */
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return this.#db.transaction(fn);
  }

  // ═══════════════════════════════════════════════════════════
  // 序列化
  // ═══════════════════════════════════════════════════════════

  /** 反序列化数据库行为域对象 */
  static deserialize(row: MemoryRow): DeserializedMemory {
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      source: row.source,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      relatedEntities: MemoryStore.safeParseJSON(row.related_entities, []),
      relatedMemories: MemoryStore.safeParseJSON(row.related_memories, []),
      sourceDimension: row.source_dimension,
      sourceEvidence: row.source_evidence,
      bootstrapSession: row.bootstrap_session,
      tags: MemoryStore.safeParseJSON(row.tags, []),
    };
  }

  static safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
    try {
      return str ? JSON.parse(str) : fallback;
    } catch {
      return fallback;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Private: raw SQLite row → MemoryRow 映射
  // ═══════════════════════════════════════════════════════════

  /** raw SQLite snake_case row → MemoryRow (保持向后兼容) */
  static #normalizeRow(row: Record<string, unknown>): MemoryRow {
    const normalized: MemoryRow = {
      id: MemoryStore.#stringFromField(row, 'id', ''),
      type: MemoryStore.#stringFromField(row, 'type', 'fact'),
      content: MemoryStore.#stringFromField(row, 'content', ''),
      source: MemoryStore.#stringFromField(row, 'source', 'bootstrap'),
      importance: MemoryStore.#numberFromField(row, 'importance', 5),
      access_count: MemoryStore.#numberFromField(row, 'access_count', 0),
      last_accessed_at: MemoryStore.#nullableStringFromField(row, 'last_accessed_at'),
      created_at: MemoryStore.#stringFromField(row, 'created_at', ''),
      updated_at: MemoryStore.#stringFromField(row, 'updated_at', ''),
      expires_at: MemoryStore.#nullableStringFromField(row, 'expires_at'),
      related_entities: MemoryStore.#stringFromField(row, 'related_entities', '[]'),
      related_memories: MemoryStore.#stringFromField(row, 'related_memories', '[]'),
      source_dimension: MemoryStore.#nullableStringFromField(row, 'source_dimension'),
      source_evidence: MemoryStore.#nullableStringFromField(row, 'source_evidence'),
      bootstrap_session: MemoryStore.#nullableStringFromField(row, 'bootstrap_session'),
      tags: MemoryStore.#stringFromField(row, 'tags', '[]'),
    };

    const similarity = row.similarity;
    if (typeof similarity === 'number') {
      normalized.similarity = similarity;
    }
    const relatedMemoriesRaw = row.related_memories_raw;
    if (typeof relatedMemoriesRaw === 'string') {
      normalized.related_memories_raw = relatedMemoriesRaw;
    }
    return normalized;
  }

  static #countFromRow(row: Record<string, unknown> | undefined): number {
    return MemoryStore.#numberFromField(row, 'cnt', 0);
  }

  static #numberFromField(
    row: Record<string, unknown> | undefined,
    field: string,
    fallback: number
  ): number {
    const value = row?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
  }

  static #stringFromField(row: Record<string, unknown>, field: string, fallback: string): string {
    const value = row[field];
    return typeof value === 'string' ? value : fallback;
  }

  static #nullableStringFromField(row: Record<string, unknown>, field: string): string | null {
    const value = row[field];
    return typeof value === 'string' ? value : null;
  }
}

export function assertMemoryStoreSchemaShape(db: SqliteDatabase): void {
  const rows = db.prepare(`PRAGMA table_info(${MEMORY_STORE_SEMANTIC_TABLE})`).all();
  const columns = new Set(rows.map((row) => String(row.name || '')));
  const missing = MEMORY_STORE_REQUIRED_COLUMNS.filter((column) => !columns.has(column));

  if (missing.length > 0) {
    throw new Error(
      `MemoryStore schema tripwire: ${MEMORY_STORE_SEMANTIC_TABLE} missing columns: ${missing.join(', ')}`
    );
  }
}

function hasMemoryStoreSemanticTable(db: SqliteDatabase): boolean {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MEMORY_STORE_SEMANTIC_TABLE)
  );
}
