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
  /**
   * 来源维度。undefined 表示不改；null 或空串清空该列。
   * 固化的矛盾替换会把它同步为新陈述的来源，否则行内容与来源维度错配（C27）。
   */
  sourceDimension?: string | null;
  /** 来源证据（文件:行）。语义同 sourceDimension：undefined 不改，null 或空串清空。 */
  sourceEvidence?: string | null;
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
    // 来源列与 add 的写法一致：空串归一为 NULL，避免出现“有值但为空”的第三种状态。
    if (updates.sourceDimension !== undefined) {
      setClauses.push('source_dimension = ?');
      params.push(updates.sourceDimension || null);
    }
    if (updates.sourceEvidence !== undefined) {
      setClauses.push('source_evidence = ?');
      params.push(updates.sourceEvidence || null);
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
   * @param options.tokenCache 调用方持有的分词缓存（key 为小写正文，值为 Core 分词结果）。一次 consolidate 内
   *   每条候选都要与最多 MEMORY_STORE_MAX_MEMORIES 行比较，缓存避免同一正文被反复分词；
   *   key 是正文本身，行被 UPDATE / MERGE 改写后自然换 key，不会读到旧分词。
   *   Core 覆盖范围外文字的补充 token 结果以这里存的 Core 分词 Set 为键弱引用挂载（见 scriptProfilesByCoreTokens），
   *   不改变这里的值语义；调用方 clear() / delete() 丢掉 Set 后，伴随结果随之失效并可回收，
   *   长期复用并定期 clear 同一个 Map 的调用方不会积累旧条目。
   * @returns 带 similarity 和 related_memories_raw 字段的 raw rows
   */
  findSimilar(
    content: string,
    type: string | null,
    limit: number,
    options: { candidateWindow?: number; tokenCache?: Map<string, Set<string>> } = {}
  ): MemoryRow[] {
    const { candidateWindow } = options;
    // 未传缓存时用只活在本次查询内的临时缓存：查询文本的分词与补充 token 只算一次，而不是每个候选行各算一次。
    const tokenCache = options.tokenCache ?? new Map<string, Set<string>>();
    const candidates = this.getCandidates(type, candidateWindow);
    const lowerContent = content.toLowerCase();
    const contentTokens = MemoryStore.#tokensFor(lowerContent, tokenCache);

    let exactFallbacks = 0;
    let exactMatches = 0;
    let supplementedComparisons = 0;
    let wordLevelLowered = 0;
    let coreDisjointCapped = 0;
    const scored = candidates
      .map((row) => {
        const lowerRow = (row.content || '').toLowerCase();
        const outcome = MemoryStore.#scoreSimilarity(
          contentTokens,
          lowerContent,
          MemoryStore.#tokensFor(lowerRow, tokenCache),
          lowerRow
        );
        if (outcome.exactFallback) {
          exactFallbacks++;
          if (outcome.score > 0) {
            exactMatches++;
          }
        }
        if (outcome.supplemented) {
          supplementedComparisons++;
        }
        if (outcome.wordLevelLowered) {
          wordLevelLowered++;
        }
        if (outcome.coreDisjointCapped) {
          coreDisjointCapped++;
        }
        return { ...row, similarity: outcome.score, related_memories_raw: row.related_memories };
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
    if (supplementedComparisons > 0) {
      // 同样一次查询汇总一条，只记比较次数与 type，不记正文。
      logMemoryStore(
        'debug',
        `[MemoryStore] findSimilar scored ${supplementedComparisons}/${candidates.length} candidates with script-supplement tokens: text outside Core tokenizer coverage was added to Jaccard (type=${type ?? '*'})`
      );
    }
    if (wordLevelLowered > 0) {
      // 补充 token 路径里字符 bigram 分值被整词 Jaccard 压低的次数；只记计数与 type，不记正文。
      logMemoryStore(
        'debug',
        `[MemoryStore] findSimilar lowered ${wordLevelLowered}/${candidates.length} candidates to their whole-word Jaccard: character bigrams of shared identifiers outweighed differing words (type=${type ?? '*'})`
      );
    }
    if (coreDisjointCapped > 0) {
      // 与查询没有任何共同 Core 词、分值被封顶的候选数；只记计数、上限与 type，不记正文。
      logMemoryStore(
        'debug',
        `[MemoryStore] findSimilar capped ${coreDisjointCapped}/${candidates.length} candidates at ${DISJOINT_CORE_WORDS_SCORE_CAP}: no Core word (Latin identifier, number or CJK run) is shared with the query, so script-supplement tokens alone cannot mark a duplicate (type=${type ?? '*'})`
      );
    }

    return scored.slice(0, limit);
  }

  /**
   * 计算两段文本的相似度 (Jaccard + 子串匹配)
   * @param tokensA lowerA 的 Core 分词结果（tokenizeForSimilarity）
   * @param lowerA 已小写的文本 A
   * @returns 0.0-1.0
   */
  static computeSimilarity(tokensA: Set<string>, lowerA: string, contentB: string): number {
    const lowerB = (contentB || '').toLowerCase();
    const outcome = MemoryStore.#scoreSimilarity(
      tokensA,
      lowerA,
      tokenizeForSimilarity(lowerB),
      lowerB
    );
    const { score } = outcome;
    if (outcome.exactFallback) {
      logMemoryStore(
        'debug',
        `[MemoryStore] computeSimilarity exact-match fallback: neither side has comparable tokens (score=${score})`
      );
    }
    if (outcome.supplemented) {
      logMemoryStore(
        'debug',
        `[MemoryStore] computeSimilarity scored with script-supplement tokens: text outside Core tokenizer coverage was added to Jaccard (score=${score})`
      );
    }
    if (outcome.wordLevelLowered) {
      logMemoryStore(
        'debug',
        `[MemoryStore] computeSimilarity lowered the score to the whole-word Jaccard: character bigrams of shared identifiers outweighed differing words (score=${score})`
      );
    }
    if (outcome.coreDisjointCapped) {
      logMemoryStore(
        'debug',
        `[MemoryStore] computeSimilarity capped the score at ${DISJOINT_CORE_WORDS_SCORE_CAP}: no Core word (Latin identifier, number or CJK run) is shared, so script-supplement tokens alone cannot mark a duplicate (score=${score})`
      );
    }
    return score;
  }

  /**
   * 相似度打分核心。exactFallback 标记“双方都没有可比 token、退化为精确比较”的分支；
   * supplemented 标记 Jaccard 分支用到了 Core 覆盖范围外文字的补充 token；
   * wordLevelLowered / coreDisjointCapped 标记补充 token 路径里的两道限制是否生效（见下）。
   * 四者都由调用方决定如何记诊断（单次调用记一条，批量查询汇总记一条）。
   *
   * 分支判定（是否精确比较、是否一侧为空）只看 Core 分词，与 C30 修复时的语义一致；
   * 补充 token 只进入双方都有 Core token 时的 Jaccard 计算。
   */
  static #scoreSimilarity(
    tokensA: Set<string>,
    lowerA: string,
    tokensB: Set<string>,
    lowerB: string
  ): SimilarityOutcome {
    if (tokensA.size === 0 && tokensB.size === 0) {
      // Core 分词只保留拉丁字母、数字与 CJK 字符，西里尔文、韩文、假名、纯符号文本两侧都没有 token，
      // Jaccard 无从计算。旧实现在这里返回 1.0，任意两段此类文本都被判为重复，新记忆被静默丢弃（C30）。
      // 现在退化为归一化（NFC、合并空白、去首尾空白；调用方已小写）后的精确比较：
      // 完全相同仍判为重复，其余一律视为不相似。
      const exact =
        MemoryStore.#normalizeForExactMatch(lowerA) === MemoryStore.#normalizeForExactMatch(lowerB);
      return {
        score: exact ? 1 : 0,
        exactFallback: true,
        supplemented: false,
        wordLevelLowered: false,
        coreDisjointCapped: false,
      };
    }
    if (tokensA.size === 0 || tokensB.size === 0) {
      return {
        score: 0,
        exactFallback: false,
        supplemented: false,
        wordLevelLowered: false,
        coreDisjointCapped: false,
      };
    }

    // 双方都有 Core token 时，Core token 可能只是共同的拉丁标识符或数字（如两段无关俄文都提到 Zustand、80），
    // 只用它们算 Jaccard 会得到 1.0 并把新记忆当作 UPDATE 丢弃（C30 第三轮审计 C008）。
    // 这里把 Core 丢掉的文字补回 token 集合再算；纯 a-z/0-9/CJK 文本补充集为空，得分与修复前完全一致。
    const profileA = MemoryStore.#scriptProfileFor(lowerA, tokensA);
    const profileB = MemoryStore.#scriptProfileFor(lowerB, tokensB);
    const supplemented = profileA.supplemented || profileB.supplemented;
    let jaccard = jaccardSimilarity(profileA.augmented, profileB.augmented);
    let wordLevelLowered = false;
    if (supplemented) {
      // 第四轮审计（C30 / C008 补修）：补充 token 路径里，共同的长拉丁标识符贡献 word + bigram 共十几个 token，
      // 而一个只差的词（韩文单音节否定词 안、俄文一个词）只占一两个 token，字符层 Jaccard 仍 ≥ 0.85。
      // 所以再按整词算一次 Jaccard，取两者较小值：两句只有在字符层和词层都接近时才算重复。
      // 只在双方都能切出至少两个词时生效——无空格书写系统（日文、泰文）整句就是一个词，整词 Jaccard 没有意义，
      // 继续只用字符层分值。英文 / CJK 文本不进入补充 token 路径，分值与此前完全一致。
      const wordsA = wholeWordsOf(profileA);
      const wordsB = wholeWordsOf(profileB);
      if (wordsA.size >= 2 && wordsB.size >= 2) {
        const wordJaccard = jaccardSimilarity(wordsA, wordsB);
        if (wordJaccard < jaccard) {
          jaccard = wordJaccard;
          wordLevelLowered = true;
        }
      }
    }
    const containsBonus = lowerA.includes(lowerB) || lowerB.includes(lowerA) ? 0.3 : 0;
    let score = Math.min(1.0, jaccard + containsBonus);
    let coreDisjointCapped = false;
    if (
      supplemented &&
      score > DISJOINT_CORE_WORDS_SCORE_CAP &&
      !setsIntersect(coreWordsOf(profileA), coreWordsOf(profileB))
    ) {
      // 用户决定（2026-10-21）：核心标识符不同就不算重复。两句只在拉丁标识符或数字上不同的非拉丁文本
      // （俄文 Zustand / Redux、端口 8080 / 3000、Vitest / Jest）补充 token 后非拉丁部分完全重合，
      // 分值会升到 0.78–0.91，第二条被当作 UPDATE 丢弃或被 MERGE 拼成一行。
      // 双方没有任何共同的 Core 词时，把分值封顶在 MERGE 门槛之下，两条记忆都保留；
      // Core 词有交集（同一标识符的复述、加长、NFD 形式）时不封顶，仍按上面的分值判重。
      score = DISJOINT_CORE_WORDS_SCORE_CAP;
      coreDisjointCapped = true;
    }
    return { score, exactFallback: false, supplemented, wordLevelLowered, coreDisjointCapped };
  }

  /**
   * 一段正文在补充 token 路径里需要的全部派生数据，以它的 Core 分词 Set 为键弱引用记忆（见 scriptProfilesByCoreTokens）。
   * 命中条件是同一个 Set 对象且正文相同：调用方缓存 clear() / delete() 后 #tokensFor 会生成新 Set，自然重算；
   * 同一个 Set 被错误地配给另一段正文时也会重算，而不是复用错的结果。
   * 文本没有 Core 覆盖范围外的字母或数字时 augmented 就是 coreTokens 本身（不复制）。
   */
  static #scriptProfileFor(lower: string, coreTokens: Set<string>): ScriptTokenProfile {
    const memoized = scriptProfilesByCoreTokens.get(coreTokens);
    if (memoized && memoized.lower === lower) {
      return memoized;
    }
    const normalized = lower.toLowerCase().normalize('NFC');
    const supplement = uncoveredScriptTokens(normalized);
    let augmented = coreTokens;
    if (supplement.size > 0) {
      augmented = new Set(coreTokens);
      for (const token of supplement) {
        augmented.add(token);
      }
    }
    const profile: ScriptTokenProfile = {
      lower,
      normalized,
      augmented,
      supplemented: supplement.size > 0,
      words: null,
      coreWords: null,
    };
    scriptProfilesByCoreTokens.set(coreTokens, profile);
    return profile;
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
 * Core tokenizeForSimilarity 只保留 a-z、0-9 与 CJK 统一表意字符（\u4e00-\u9fff、\u3400-\u4dbf），
 * 其余字母和数字（西里尔文、韩文、假名、阿拉伯文、天城文、带变音符的拉丁字母、非 ASCII 数字等）都被当作分隔符丢掉。
 * 这个模式匹配“Core 覆盖范围外的字母或数字”：第一段是不属于 a-z / CJK 的 \p{L}，第二段是不属于 0-9 的 \p{N}。
 * 覆盖范围必须与 Core 分词保持一致；若 Core 将来扩大覆盖，这里只会多补一些重复 token，不影响正确性。
 */
const CORE_UNCOVERED_LETTER_OR_NUMBER = /[^\P{L}a-z\u3400-\u4dbf\u4e00-\u9fff]|[^\P{N}0-9]/u;

/** 补充分词的“词”：字母、组合附加符（天城文元音符号、NFD 残留的变音符）与数字的连续片段。 */
const SUPPLEMENT_WORD = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * Core 分词会作为整词保留的片段：a-z、0-9 与 CJK 字符的连续段，且至少 2 个字符
 * （单字符片段在 Core 里既不成词也不产生 bigram）。字符类必须与 CORE_UNCOVERED_LETTER_OR_NUMBER 互补、
 * 与 Core tokenizeForSimilarity 保持一致。
 */
const CORE_WORD = /[a-z0-9\u3400-\u4dbf\u4e00-\u9fff]{2,}/gu;

/**
 * 双方没有任何共同 Core 词时，补充 token 路径能给出的相似度上限（用户决定 2026-10-21：核心标识符不同就不算重复）。
 * 必须低于 MemoryConsolidator 的 SIMILARITY_MERGE（0.6）与 MemoryConsolidator / MemoryRetriever 的
 * SIMILARITY_UPDATE（0.85）：只差拉丁标识符或数字的非拉丁句子既不能被 UPDATE 吞掉，也不能被 MERGE 拼成一行；
 * 同时高于 findSimilar 的 0.1 过滤线，检索仍把它们当作相关候选返回。只对补充 token 路径生效。
 */
const DISJOINT_CORE_WORDS_SCORE_CAP = 0.5;

/** #scoreSimilarity 的结果与它走过的分支；诊断由调用方按单次 / 汇总方式记录。 */
interface SimilarityOutcome {
  score: number;
  /** 双方都没有 Core token，退化为归一化后的精确比较。 */
  exactFallback: boolean;
  /** Jaccard 用到了 Core 覆盖范围外文字的补充 token。 */
  supplemented: boolean;
  /** 补充 token 路径里整词 Jaccard 低于字符层 Jaccard，分值被压到整词值。 */
  wordLevelLowered: boolean;
  /** 补充 token 路径里双方没有共同 Core 词，分值被封顶在 DISJOINT_CORE_WORDS_SCORE_CAP。 */
  coreDisjointCapped: boolean;
}

/** 补充 token 路径里一段正文的派生数据；words / coreWords 只在需要时计算一次。 */
interface ScriptTokenProfile {
  /** 命中校验用：与 Core 分词 Set 对应的小写正文。 */
  lower: string;
  /** 再次小写并 NFC 后的正文，补充分词、整词与 Core 词都从它切出。 */
  normalized: string;
  /** Core token ∪ 补充 token；补充集为空时就是 Core 分词 Set 本身。 */
  augmented: Set<string>;
  /** 是否补了 Core 覆盖范围外的 token。 */
  supplemented: boolean;
  /** 整词集合（SUPPLEMENT_WORD 切分，含拉丁 / 数字 / CJK 片段），用于整词 Jaccard。 */
  words: Set<string> | null;
  /** Core 词集合（CORE_WORD），用于判断双方是否共享任何拉丁标识符、数字或 CJK 片段。 */
  coreWords: Set<string> | null;
}

/**
 * 补充 token 派生数据以 Core 分词 Set 对象为键弱引用保存。
 * 调用方 tokenCache 里存的就是这些 Set：clear() / delete() 丢掉 Set 后条目随之不可达并被回收，
 * 不会像以调用方 Map 为键的伴随缓存那样在 clear() 后继续持有旧条目、把新 Set 误判为“补了 token”。
 * 调用方缓存本身仍只存 Core 分词结果，公开参数的值语义不变。
 */
const scriptProfilesByCoreTokens = new WeakMap<Set<string>, ScriptTokenProfile>();

/**
 * 为 Core 覆盖范围外的文字补 token（C30 第三轮审计 C008）。
 * 只处理含覆盖范围外字母或数字的词：补词本身和按码点切的字符 bigram。
 * 词本身不设长度下限（第四轮审计）：韩文单音节词在 NFC 下只有 1 个码点（안、못、꼭、씀、써、다 …），
 * 否定词 안 也在其中；若像 Core 对单字符那样丢掉，两条只共享一个拉丁标识符、其余都是单音节词的韩文记忆
 * 仍会得 1.0 并把正反两句判成同一条。
 * 入参须已小写并 NFC，保证同一句话的 NFD / NFC 形式（如西里尔 й、韩文音节）得到相同 token。
 * 纯 a-z/0-9/CJK 文本走快速路径返回空集，相似度与修复前完全一致。
 */
function uncoveredScriptTokens(normalized: string): Set<string> {
  const tokens = new Set<string>();
  if (!CORE_UNCOVERED_LETTER_OR_NUMBER.test(normalized)) {
    return tokens;
  }
  for (const match of normalized.matchAll(SUPPLEMENT_WORD)) {
    const word = match[0];
    if (!CORE_UNCOVERED_LETTER_OR_NUMBER.test(word)) {
      // 纯拉丁 / 数字 / CJK 的词已由 Core 分词覆盖，不重复补。
      continue;
    }
    tokens.add(word);
    // 按码点切分，避免把扩展平面字符（代理对）切成半个字符；单码点词没有 bigram，只有上面的词本身。
    const codePoints = Array.from(word);
    for (let i = 0; i + 1 < codePoints.length; i++) {
      tokens.add(codePoints[i] + codePoints[i + 1]);
    }
  }
  return tokens;
}

/** 整词集合，按需计算并缓存在 profile 上。 */
function wholeWordsOf(profile: ScriptTokenProfile): Set<string> {
  if (!profile.words) {
    const words = new Set<string>();
    for (const match of profile.normalized.matchAll(SUPPLEMENT_WORD)) {
      words.add(match[0]);
    }
    profile.words = words;
  }
  return profile.words;
}

/** Core 词集合，按需计算并缓存在 profile 上。 */
function coreWordsOf(profile: ScriptTokenProfile): Set<string> {
  if (!profile.coreWords) {
    const words = new Set<string>();
    for (const match of profile.normalized.matchAll(CORE_WORD)) {
      words.add(match[0]);
    }
    profile.coreWords = words;
  }
  return profile.coreWords;
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) {
      return true;
    }
  }
  return false;
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
