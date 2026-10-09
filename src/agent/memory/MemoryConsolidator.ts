/**
 * MemoryConsolidator — 记忆固化与冲突解决
 *
 * 从 PersistentMemory.js 提取的智能固化逻辑。
 * 负责:
 *   - Extract-Update Consolidation (ADD / UPDATE / MERGE / NOOP)
 *   - Mem0 风格冲突解决 (矛盾检测 + 自动替换)
 *   - Legacy JSONL 迁移
 *
 * @module MemoryConsolidator
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WriteZone } from '@alembic/core/io';
import { observeSafely } from '#shared/observers.js';
import { MemoryStore } from './MemoryStore.js';

// ─── 类型定义 ──────────────────────────────────────────

/** 候选记忆 (consolidate 入参) */
export interface CandidateMemory {
  type?: string;
  content: string;
  source?: string;
  importance?: number;
}

/** consolidate 返回统计 */
export interface ConsolidateStats {
  added: number;
  updated: number;
  merged: number;
  skipped: number;
  replaced?: number;
}

/** consolidate 选项 */
export interface ConsolidateOptions {
  bootstrapSession?: string;
  /** 全量 bootstrap 代际替换必须与本次写入共享事务。 */
  clearPreviousBootstrap?: boolean;
}

/** Logger 接口 */
interface MemoryLogger {
  info(msg: string): void;
  warn?(msg: string): void;
  debug?(msg: string): void;
}

// ─── 常量 ──────────────────────────────────────────────

/** 相似度阈值 */
const SIMILARITY_UPDATE = 0.85; // ≥85% 同义 → UPDATE
const SIMILARITY_MERGE = 0.6; // ≥60% 相关 → MERGE

// ─── 矛盾检测模式 (Mem0 风格冲突解决) ─────────────────

/** 中文否定/禁止模式 */
const NEGATION_PATTERNS_ZH = /不(再)?使用|不(再)?用|禁止|废弃|移除|取消|停止|不要|不采用|弃用|淘汰/;

/** 英文否定/禁止模式 */
const NEGATION_PATTERNS_EN =
  /\b(don'?t|do\s+not|never|no\s+longer|removed?|deprecated?|stop|avoid|disable|abandon|drop)\b/i;

/** 共享词语最少匹配数 */
const MIN_TOPIC_OVERLAP_WORDS = 2;

/** 共享词语比例阈值 */
const MIN_TOPIC_OVERLAP_RATIO = 0.3;

export class MemoryConsolidator {
  #store: MemoryStore;

  #logger: MemoryLogger | null;

  constructor(store: MemoryStore, opts: { logger?: MemoryLogger | null } = {}) {
    this.#store = store;
    this.#logger = opts.logger || null;
  }

  // ═══════════════════════════════════════════════════════════
  // 智能固化
  // ═══════════════════════════════════════════════════════════

  /**
   * 智能固化: 先执行冲突检测 (Mem0 风格)，再执行 ADD / UPDATE / MERGE / NOOP
   *
   * @returns }
   */
  consolidate(
    candidateMemories: CandidateMemory[],
    { bootstrapSession, clearPreviousBootstrap = false }: ConsolidateOptions = {}
  ): ConsolidateStats {
    let replaced = 0;
    const stats: ConsolidateStats = { added: 0, updated: 0, merged: 0, skipped: 0 };

    // 双保险（C26）：EpisodicConsolidator 已在 0 候选时不传 clearPreviousBootstrap；直接调用
    // PersistentMemory.consolidate 的调用方若在候选为空时仍要求整代替换，这里同样短路并告警，
    // 避免提交一个"只删不写"的事务抹掉上一代 bootstrap 记忆。判断只看候选条数，不看内容有效性。
    const replacePrevious = clearPreviousBootstrap && candidateMemories.length > 0;
    if (clearPreviousBootstrap && !replacePrevious) {
      this.#warn(
        'Bootstrap replacement skipped: 0 candidates supplied, previous bootstrap generation retained'
      );
    }

    const runConsolidate = this.#store.transaction(() => {
      // 冲突替换、普通合并与容量淘汰属于同一持久化操作，任何写失败都整体回滚。
      if (replacePrevious) {
        const cleared = this.#store.clearBootstrapMemories();
        this.#store.compact();
        // 代际删除是不可逆的数据变更，记 info 并带删除条数，便于事后核对回执。
        this.#log(
          `Bootstrap replacement staged: ${cleared} previous bootstrap memories deleted in this transaction`
        );
      }
      for (const candidate of candidateMemories) {
        const content = (candidate.content || '').trim();
        if (!content || content.length < 5) {
          stats.skipped++;
          continue;
        }

        // 前一候选已在同一事务内写入；冲突判断必须看到它，不能整批预判后再写。
        if (this.#resolveConflict(candidate, content)) {
          replaced++;
          continue;
        }

        // 搜索相似记忆 (同 type 优先)
        const similar = this.#store.findSimilar(content, candidate.type ?? null, 3);

        if (similar.length === 0) {
          this.#store.add({ ...candidate, bootstrapSession });
          stats.added++;
          continue;
        }

        const topMatch = similar[0];

        if ((topMatch.similarity ?? 0) >= SIMILARITY_UPDATE) {
          // UPDATE: 几乎同义 → 更新重要性和时间戳
          this.#store.update(topMatch.id, {
            importance: Math.max(topMatch.importance, candidate.importance || 5),
            accessCount: topMatch.access_count + 1,
          });
          stats.updated++;
          this.#logDebug(
            `UPDATE sim=${(topMatch.similarity ?? 0).toFixed(2)}: "${content.substring(0, 40)}..." → existing "${topMatch.content.substring(0, 40)}..."`
          );
        } else if ((topMatch.similarity ?? 0) >= SIMILARITY_MERGE) {
          // MERGE: 相关但不同 → 合并信息
          const mergedContent = `${topMatch.content}; ${content}`.substring(0, 500);
          const existingRelated = MemoryStore.safeParseJSON(topMatch.related_memories_raw, []);
          this.#store.update(topMatch.id, {
            content: mergedContent,
            importance: Math.max(topMatch.importance, candidate.importance || 5),
            relatedMemories: [...existingRelated, `merged:${Date.now()}`],
          });
          stats.merged++;
          this.#logDebug(
            `MERGE sim=${(topMatch.similarity ?? 0).toFixed(2)}: "${content.substring(0, 40)}..." ⊕ "${topMatch.content.substring(0, 40)}..."`
          );
        } else {
          this.#store.add({ ...candidate, bootstrapSession });
          stats.added++;
        }
      }
      this.#store.enforceCapacity();
    });

    runConsolidate();

    this.#log(
      `Consolidation: +${stats.added} ADD, ~${stats.updated} UPDATE, ⊕${stats.merged} MERGE, =${stats.skipped} SKIP`
    );

    if (replaced > 0) {
      stats.replaced = replaced;
    }

    return stats;
  }

  // ═══════════════════════════════════════════════════════════
  // Legacy Migration
  // ═══════════════════════════════════════════════════════════

  /**
   * 从旧版 Memory.js JSONL 文件迁移数据到 SQLite
   *
   * @returns >}
   */
  async migrateFromLegacy(
    projectRoot: string,
    wz?: WriteZone
  ): Promise<{ migrated: number; skipped: number; error?: string }> {
    const legacyPath = path.join(projectRoot, '.asd', 'memory.jsonl');

    if (!fs.existsSync(legacyPath)) {
      return { migrated: 0, skipped: 0 };
    }

    try {
      const raw = fs.readFileSync(legacyPath, 'utf-8').trim();
      if (!raw) {
        return { migrated: 0, skipped: 0 };
      }

      const lines = raw.split('\n').filter(Boolean);
      const candidates = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .map((m) => ({
          type: MemoryConsolidator.#mapLegacyType(m.type),
          content: (m.content || '').trim(),
          source: m.source || 'user',
          importance: m.type === 'decision' ? 7 : 5,
        }))
        .filter((m) => m.content.length >= 5);

      if (candidates.length === 0) {
        return { migrated: 0, skipped: lines.length };
      }

      const result = this.consolidate(candidates, {
        bootstrapSession: 'legacy-migration',
      });

      try {
        if (wz) {
          wz.rename(wz.data('.asd/memory.jsonl'), wz.data('.asd/memory.jsonl.migrated'));
        } else {
          fs.renameSync(legacyPath, `${legacyPath}.migrated`);
        }
      } catch {
        /* rename failure non-critical */
      }

      const migrated = result.added + result.merged;
      this.#log(
        `Legacy migration: ${migrated} migrated (${result.added} added, ${result.merged} merged), ${result.skipped} skipped from ${legacyPath}`
      );

      return { migrated, skipped: result.skipped };
    } catch (err: unknown) {
      this.#log(`Legacy migration failed: ${(err as Error).message}`);
      return { migrated: 0, skipped: 0, error: (err as Error).message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Private: 冲突预解决 (Mem0 风格)
  // ═══════════════════════════════════════════════════════════

  /**
   * 单候选矛盾解决（Mem0 风格）：在 ADD/UPDATE/MERGE 之前检查同 type 的相似记忆，
   * 发现否定/肯定矛盾时就地改写旧记忆并返回 true（调用方据此计 replaced 且不再写入）。
   *
   * 调用方已保证 content 去空白且 ≥5 字；查询异常会先记日志再重抛，由外层事务整体回滚。
   */
  #resolveConflict(candidate: CandidateMemory, content: string): boolean {
    try {
      const similar = this.#store.findSimilar(content, null, 3);
      for (const row of similar) {
        const existing = MemoryStore.deserialize(row);
        if (existing.type !== (candidate.type || 'fact')) {
          continue;
        }
        if (!MemoryConsolidator.#detectContradiction(existing.content, content)) {
          continue;
        }
        this.#store.update(existing.id, {
          content: content.substring(0, 500),
          importance: Math.max(existing.importance || 5, candidate.importance || 5),
        });
        this.#log(
          `Conflict replacement staged: "${existing.content.substring(0, 50)}..." → "${content.substring(0, 50)}..."`
        );
        return true;
      }
      return false;
    } catch (err: unknown) {
      this.#log(
        `Conflict resolution failed; consolidation will roll back: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** 检测两段记忆内容是否矛盾 */
  static #detectContradiction(contentA: string, contentB: string): boolean {
    if (!contentA || !contentB) {
      return false;
    }

    const aNeg = NEGATION_PATTERNS_ZH.test(contentA) || NEGATION_PATTERNS_EN.test(contentA);
    const bNeg = NEGATION_PATTERNS_ZH.test(contentB) || NEGATION_PATTERNS_EN.test(contentB);

    if (aNeg === bNeg) {
      return false;
    }

    const wordsA = MemoryConsolidator.#extractTopicWords(contentA);
    const wordsB = MemoryConsolidator.#extractTopicWords(contentB);

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) {
        overlap++;
      }
    }

    const minSize = Math.min(wordsA.size, wordsB.size);
    if (minSize === 0) {
      return false;
    }

    return overlap >= MIN_TOPIC_OVERLAP_WORDS || overlap / minSize >= MIN_TOPIC_OVERLAP_RATIO;
  }

  /** 提取主题词 (去停用词 + 短词) */
  static #extractTopicWords(text: string): Set<string> {
    if (!text) {
      return new Set();
    }

    const tokens = text
      .toLowerCase()
      .split(/[\s,;:!?。，；：！？\-_/\\|()[\]{}'"<>·、]+/)
      .filter((t) => t.length >= 2);

    const stopWords = new Set([
      '我们',
      '使用',
      '项目',
      '需要',
      '可以',
      '应该',
      '建议',
      '目前',
      '已经',
      '这个',
      '那个',
      '一个',
      '进行',
      '通过',
      '对于',
      'the',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'shall',
      'can',
      'this',
      'that',
      'these',
      'those',
      'with',
      'from',
      'for',
      'and',
      'but',
      'not',
      'all',
      'any',
      'each',
      'every',
      'some',
    ]);

    return new Set(tokens.filter((t) => !stopWords.has(t)));
  }

  /** Legacy type 映射 */
  static #mapLegacyType(legacyType: string): string {
    switch (legacyType) {
      case 'preference':
        return 'preference';
      default:
        return 'fact';
    }
  }

  #logDebug(msg: string) {
    const formatted = `[MemoryConsolidator] ${msg}`;
    if (this.#logger?.debug) {
      observeSafely(
        () => this.#logger?.debug?.(formatted),
        () => undefined
      );
    } else if (this.#logger?.info) {
      observeSafely(
        () => this.#logger?.info(formatted),
        () => undefined
      );
    }
  }

  #log(msg: string) {
    const formatted = `[MemoryConsolidator] ${msg}`;
    if (this.#logger?.info) {
      observeSafely(
        () => this.#logger?.info(formatted),
        () => undefined
      );
    }
  }

  /** warn 在注入的 logger 上可选；缺失时回退到 info 并加 [warn] 前缀，跳过路径不能静默。 */
  #warn(msg: string) {
    const formatted = `[MemoryConsolidator] ${msg}`;
    if (this.#logger?.warn) {
      observeSafely(
        () => this.#logger?.warn?.(formatted),
        () => undefined
      );
    } else if (this.#logger?.info) {
      observeSafely(
        () => this.#logger?.info(`[warn] ${formatted}`),
        () => undefined
      );
    }
  }
}
