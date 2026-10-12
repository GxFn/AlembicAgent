/**
 * MemoryStore — 持久化记忆 SQLite 存储层
 *
 * 从 PersistentMemory.js 提取的 CRUD + SQL 基础设施。
 * 负责:
 *   - 基本 CRUD: add, update, delete, get
 *   - 批量查询: getAllActive, size, getStats
 *   - 访问计数: touchAccess
 *   - 容量控制: enforceCapacity（由 MemoryConsolidator.consolidate 在事务末尾调用）
 *   - 维护: compact（过期清理 + 遗忘 + 归档，不做容量控制）
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
import Logger from '@alembic/core/logging';
import {
  ensureSemanticMemorySchema,
  type SemanticMemorySqliteDatabase,
} from '@alembic/core/memory';
import { jaccardSimilarity, tokenizeForSimilarity } from '@alembic/core/search';
import { observeSafely } from '#shared/observers.js';

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

/**
 * 最大记忆条数 (防止无限膨胀)。
 *
 * 同时是固化（MemoryConsolidator）与 append 去重的相似候选窗口：去重必须能看到容量内的全部活跃行，
 * 否则一次 bootstrap 写过 50 条后更早的记忆掉出比较范围，重复与矛盾陈述会被直接 ADD（C29）。
 * 只在模块内共享，不经 memory barrel 对外导出。
 */
export const MEMORY_STORE_MAX_MEMORIES = 500;
const MAX_MEMORIES = MEMORY_STORE_MAX_MEMORIES;

/**
 * 相似候选默认窗口：最近更新的 50 行。
 * 检索侧（search 等）保持这一既有行为；需要完整去重的调用方显式传 candidateWindow。
 */
const DEFAULT_SIMILARITY_CANDIDATE_WINDOW = 50;

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

  /**
   * 获取候选记忆 (用于相似度搜索)
   *
   * @param type 过滤 type (null=全部)
   * @param candidateWindow 按 updated_at 倒序最多取多少行；默认 50 保持检索侧既有行为，
   *   固化与 append 去重传 MEMORY_STORE_MAX_MEMORIES 以覆盖容量内全部活跃行（C29）。
   *   非正数 / 非有限值回退到默认窗口并记 warn。
   */
  getCandidates(
    type: string | null,
    candidateWindow: number = DEFAULT_SIMILARITY_CANDIDATE_WINDOW
  ): MemoryRow[] {
    const window = MemoryStore.#normalizeCandidateWindow(candidateWindow);
    const now = new Date().toISOString();
    const conditions = ['(expires_at IS NULL OR expires_at > ?)'];
    const params: unknown[] = [now];
    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    // 多取一行只为判断窗口是否截断；截断意味着更早的活跃行不参与相似度比较，必须留诊断。
    const rows = this.#db
      .prepare(`
        SELECT *
        FROM semantic_memories
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(...params, window + 1);

    if (rows.length > window) {
      logMemoryStore(
        'debug',
        `[MemoryStore] similarity candidate window truncated: compared the ${window} most recently updated active rows (type=${type ?? '*'}); older active rows were not compared`
      );
      return rows.slice(0, window).map(MemoryStore.#normalizeRow);
    }
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
    } catch (err: unknown) {
      // 访问计数是检索 / prompt 注入的副作用，失败不打断主流程；但 access_count 与
      // last_accessed_at 不再前进会让 compact 把仍在使用的记忆按“90 天未访问”遗忘，
      // 因此必须留 warn。只记 id 与错误类别，不记正文。
      logMemoryStore(
        'warn',
        `[MemoryStore] touchAccess skipped for ${id}: access statistics not updated (${describeError(err)})`
      );
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
   * 执行维护: 清理过期 + 遗忘 + 归档。
   * 容量控制不在这里，由 MemoryConsolidator.consolidate 事务末尾的 enforceCapacity 负责。
   * @returns { expired, forgotten, archived, remaining }
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

      // 归档：降低重要性。
      // importance 已在下限 1 的行 MAX(1, importance - 1) 后值不变，但 SQLite changes 仍会计入，
      // 导致每次 compact 都把同一批行重复报告为 archived；只匹配真正会下降的行（C34）。
      const archiveThreshold = new Date(nowMs - ARCHIVE_DAYS * 86400_000).toISOString();
      const archiveResult = this.#db
        .prepare(`
          UPDATE semantic_memories
          SET importance = MAX(1, importance - 1)
          WHERE last_accessed_at < ?
            AND importance < 3
            AND importance > 1
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
   * @param options.candidateWindow 参与比较的最近更新行数，默认 50（见 getCandidates）
   * @param options.tokenCache 调用方持有的分词缓存（key 为小写正文）。一次 consolidate 内
   *   每条候选都要与最多 MEMORY_STORE_MAX_MEMORIES 行比较，缓存避免同一正文被反复分词；
   *   key 是正文本身，行被 UPDATE / MERGE 改写后自然换 key，不会读到旧分词。
   * @returns 带 similarity 和 related_memories_raw 字段的 raw rows
   */
  findSimilar(
    content: string,
    type: string | null,
    limit: number,
    options: { candidateWindow?: number; tokenCache?: Map<string, Set<string>> } = {}
  ): MemoryRow[] {
    const { candidateWindow, tokenCache } = options;
    const candidates = this.getCandidates(type, candidateWindow);
    const lowerContent = content.toLowerCase();
    const contentTokens = MemoryStore.#tokensFor(lowerContent, tokenCache);

    let exactFallbacks = 0;
    let exactMatches = 0;
    const scored = candidates
      .map((row) => {
        const lowerRow = (row.content || '').toLowerCase();
        const { score, exactFallback } = MemoryStore.#scoreSimilarity(
          contentTokens,
          lowerContent,
          MemoryStore.#tokensFor(lowerRow, tokenCache),
          lowerRow
        );
        if (exactFallback) {
          exactFallbacks++;
          if (score > 0) {
            exactMatches++;
          }
        }
        return { ...row, similarity: score, related_memories_raw: row.related_memories };
      })
      .filter((r) => r.similarity > 0.1)
      .sort((a, b) => b.similarity - a.similarity);

    if (exactFallbacks > 0) {
      // 一次查询只汇总记一条，避免非拉丁文字项目里逐行刷日志；不记正文。
      logMemoryStore(
        'debug',
        `[MemoryStore] findSimilar exact-match fallback: ${exactFallbacks}/${candidates.length} candidates had no comparable tokens on either side (matched=${exactMatches}, type=${type ?? '*'})`
      );
    }

    return scored.slice(0, limit);
  }

  /**
   * 计算两段文本的相似度 (Jaccard + 子串匹配)
   * @returns 0.0-1.0
   */
  static computeSimilarity(tokensA: Set<string>, lowerA: string, contentB: string): number {
    const lowerB = (contentB || '').toLowerCase();
    const { score, exactFallback } = MemoryStore.#scoreSimilarity(
      tokensA,
      lowerA,
      tokenizeForSimilarity(lowerB),
      lowerB
    );
    if (exactFallback) {
      logMemoryStore(
        'debug',
        `[MemoryStore] computeSimilarity exact-match fallback: neither side has comparable tokens (score=${score})`
      );
    }
    return score;
  }

  /**
   * 相似度打分核心。exactFallback 标记“双方都没有可比 token、退化为精确比较”的分支，
   * 由调用方决定如何记诊断（单次调用记一条，批量查询汇总记一条）。
   */
  static #scoreSimilarity(
    tokensA: Set<string>,
    lowerA: string,
    tokensB: Set<string>,
    lowerB: string
  ): { score: number; exactFallback: boolean } {
    if (tokensA.size === 0 && tokensB.size === 0) {
      // Core 分词只保留拉丁字母、数字与 CJK 字符，西里尔文、韩文、假名、纯符号文本两侧都没有 token，
      // Jaccard 无从计算。旧实现在这里返回 1.0，任意两段此类文本都被判为重复，新记忆被静默丢弃（C30）。
      // 现在退化为归一化（NFC、合并空白、去首尾空白；调用方已小写）后的精确比较：
      // 完全相同仍判为重复，其余一律视为不相似。
      const exact =
        MemoryStore.#normalizeForExactMatch(lowerA) === MemoryStore.#normalizeForExactMatch(lowerB);
      return { score: exact ? 1 : 0, exactFallback: true };
    }
    if (tokensA.size === 0 || tokensB.size === 0) {
      return { score: 0, exactFallback: false };
    }

    const jaccard = jaccardSimilarity(tokensA, tokensB);
    const containsBonus = lowerA.includes(lowerB) || lowerB.includes(lowerA) ? 0.3 : 0;
    return { score: Math.min(1.0, jaccard + containsBonus), exactFallback: false };
  }

  static #normalizeForExactMatch(lower: string): string {
    return lower.normalize('NFC').replace(/\s+/g, ' ').trim();
  }

  /** 分词；传入缓存时按小写正文复用结果。 */
  static #tokensFor(lower: string, cache: Map<string, Set<string>> | undefined): Set<string> {
    if (!cache) {
      return tokenizeForSimilarity(lower);
    }
    const cached = cache.get(lower);
    if (cached) {
      return cached;
    }
    const tokens = tokenizeForSimilarity(lower);
    cache.set(lower, tokens);
    return tokens;
  }

  /** 候选窗口归一化：非有限或小于 1 的值回退默认窗口并记 warn，避免 LIMIT 收到 NaN / 负数。 */
  static #normalizeCandidateWindow(candidateWindow: number): number {
    if (Number.isFinite(candidateWindow) && candidateWindow >= 1) {
      return Math.floor(candidateWindow);
    }
    logMemoryStore(
      'warn',
      `[MemoryStore] invalid similarity candidate window ${String(candidateWindow)}; using default ${DEFAULT_SIMILARITY_CANDIDATE_WINDOW}`
    );
    return DEFAULT_SIMILARITY_CANDIDATE_WINDOW;
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
      relatedEntities: MemoryStore.#parseStringArray(
        row.related_entities,
        'relatedEntities',
        row.id
      ),
      relatedMemories: MemoryStore.#parseStringArray(
        row.related_memories,
        'relatedMemories',
        row.id
      ),
      sourceDimension: row.source_dimension,
      sourceEvidence: row.source_evidence,
      bootstrapSession: row.bootstrap_session,
      tags: MemoryStore.#parseStringArray(row.tags, 'tags', row.id),
    };
  }

  static safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
    if (!str) {
      return fallback;
    }
    try {
      return JSON.parse(str);
    } catch (err: unknown) {
      // 调用方不知道字段名与行 id，这里只记错误类别与输入长度，不记原文（可能含记忆正文）。
      logMemoryStore(
        'warn',
        `[MemoryStore] safeParseJSON fell back to the default value: ${describeError(err)} (input length=${str.length})`
      );
      return fallback;
    }
  }

  /**
   * 解析 JSON 字符串数组字段（related_entities / related_memories / tags）。
   * 解析失败或形状不是数组时回退 []，数组中的非字符串元素被丢弃；两种情况都记 warn（带字段与行 id，不带正文），
   * 防止 '{}' 之类的合法 JSON 以非数组形态流出，破坏 string[] 契约或让 MERGE 的展开写回直接抛错。
   */
  static #parseStringArray(raw: string | null | undefined, field: string, id: string): string[] {
    if (!raw) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      logMemoryStore(
        'warn',
        `[MemoryStore] ${field} of ${id} is not valid JSON; using [] (${describeError(err)})`
      );
      return [];
    }
    if (!Array.isArray(parsed)) {
      logMemoryStore(
        'warn',
        `[MemoryStore] ${field} of ${id} is not a JSON array (got ${parsed === null ? 'null' : typeof parsed}); using []`
      );
      return [];
    }
    const strings = parsed.filter((item): item is string => typeof item === 'string');
    if (strings.length !== parsed.length) {
      logMemoryStore(
        'warn',
        `[MemoryStore] ${field} of ${id} dropped ${parsed.length - strings.length} non-string item(s)`
      );
    }
    return strings;
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

/**
 * MemoryStore 没有注入 logger（构造签名保持不变），诊断统一走 Core Logger。
 * 日志通道自身失败不能升级为存储失败，所以经 observeSafely 隔离。
 */
function logMemoryStore(level: 'warn' | 'debug', message: string): void {
  observeSafely(
    () => {
      const logger = Logger.getInstance();
      if (level === 'warn') {
        logger.warn(message);
      } else {
        logger.debug(message);
      }
    },
    () => undefined
  );
}

/** 只取错误类别（name 与 SQLite code），不取 message，避免把 SQL 参数或正文带进日志。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return 'code' in err && typeof err.code === 'string' ? `${err.name}/${err.code}` : err.name;
  }
  return typeof err;
}

function hasMemoryStoreSemanticTable(db: SqliteDatabase): boolean {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MEMORY_STORE_SEMANTIC_TABLE)
  );
}
