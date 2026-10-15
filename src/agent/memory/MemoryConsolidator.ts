/**
 * MemoryConsolidator — 记忆固化与冲突解决
 *
 * 从 PersistentMemory.js 提取的智能固化逻辑。
 * 负责:
 *   - Extract-Update Consolidation (ADD / UPDATE / MERGE / NOOP)
 *   - Mem0 风格冲突解决 (矛盾检测 + 自动替换；同批不同维度的“矛盾”各自保留)
 *   - 写入路径上的来源元数据合并 (tags / relatedEntities / sourceDimension / sourceEvidence)
 *   - Legacy JSONL 迁移
 *
 * @module MemoryConsolidator
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WriteZone } from '@alembic/core/io';
import { observeSafely } from '#shared/observers.js';
import type { DeserializedMemory, MemoryRow, MemoryUpdates } from './MemoryStore.js';
import { MEMORY_STORE_MAX_MEMORIES, MemoryStore } from './MemoryStore.js';

// ─── 类型定义 ──────────────────────────────────────────

/**
 * 候选记忆 (consolidate 入参)
 *
 * 来源字段在各写入路径上的语义（C28）：
 *   - ADD：原样写入新行；
 *   - UPDATE / MERGE：tags、relatedEntities 与已有行取并集；sourceDimension、sourceEvidence
 *     是单值列，已有值保留、为空时才用候选补上（后到维度经 tags 并集仍可追溯）；
 *   - 矛盾替换：行内容换成候选，sourceDimension / sourceEvidence 随之改为候选的值（缺省即清空），
 *     tags、relatedEntities 取并集。
 * type 缺省或为空串时一律按 'fact' 处理，矛盾检测、相似检索与写入三处共用同一归一化结果。
 */
export interface CandidateMemory {
  type?: string;
  content: string;
  source?: string;
  importance?: number;
  /** 产生该候选的分析维度（EpisodicConsolidator 传 dimId 或 tier 反思标识） */
  sourceDimension?: string | null;
  /** 支撑该候选的证据位置（文件:行） */
  sourceEvidence?: string | null;
  /** 关联实体（类名、文件名） */
  relatedEntities?: string[];
  tags?: string[];
  /** 仅 ADD 路径生效：写入 expires_at */
  ttlDays?: number | null;
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

/** 进入固化循环前归一化后的候选；三条写入路径与矛盾检测只读这一份。 */
interface NormalizedCandidate {
  type: string;
  content: string;
  importance: number | undefined;
  sourceDimension: string | null;
  sourceEvidence: string | null;
  tags: string[];
  relatedEntities: string[];
}

/** 单次 consolidate 内的相似检索范围（候选窗口 + 分词缓存，见 C29） */
interface SimilarityScope {
  candidateWindow: number;
  tokenCache: Map<string, Set<string>>;
}

/** 单次 consolidate 的批上下文：判定“同批”与汇总诊断计数。 */
interface BatchContext {
  bootstrapSession: string | undefined;
  /** 本次固化写过（ADD / UPDATE / MERGE / 替换）的行 id；这些行的内容来自本批候选。 */
  touchedRowIds: Set<string>;
  diagnostics: {
    /** 同批不同维度命中矛盾、改为各自保留的次数 */
    crossDimensionKept: number;
    /** 否定极性相反但未达到矛盾门槛（相似度或主题交集不足）而未替换的行数 */
    belowContradictionGate: number;
    /** MERGE 超长降级为 ADD 的次数 */
    mergeDowngraded: number;
    /** MERGE 超长但候选已被已有行包含、按 UPDATE 计的次数 */
    mergeAbsorbed: number;
  };
}

type ContradictionVerdict = 'same-polarity' | 'below-gate' | 'contradiction';

// ─── 常量 ──────────────────────────────────────────────

/** 相似度阈值 */
const SIMILARITY_UPDATE = 0.85; // ≥85% 同义 → UPDATE
const SIMILARITY_MERGE = 0.6; // ≥60% 相关 → MERGE

/** 记忆正文上限，与 MemoryStore.add / update 的 500 字截断一致。 */
const MAX_CONTENT_LENGTH = 500;

/** MERGE 拼接分隔符 */
const MERGE_SEPARATOR = '; ';

/** UPDATE / MERGE / 替换合并 tags、relatedEntities 后的上限；已有项永不因合并被挤掉。 */
const MAX_MERGED_LIST_ITEMS = 20;

// ─── 矛盾检测模式 (Mem0 风格冲突解决) ─────────────────

/** 中文否定/禁止模式 */
const NEGATION_PATTERNS_ZH = /不(再)?使用|不(再)?用|禁止|废弃|移除|取消|停止|不要|不采用|弃用|淘汰/;

/** 英文否定/禁止模式 */
const NEGATION_PATTERNS_EN =
  /\b(don'?t|do\s+not|never|no\s+longer|removed?|deprecated?|stop|avoid|disable|abandon|drop)\b/i;

/** 计算主题交集前剥离否定词，避免 avoid / 禁止 本身被当作主题词。 */
const NEGATION_STRIP_ZH = new RegExp(NEGATION_PATTERNS_ZH.source, 'g');
const NEGATION_STRIP_EN = new RegExp(NEGATION_PATTERNS_EN.source, 'gi');

/** 共享主题词最少个数 */
const MIN_TOPIC_OVERLAP_WORDS = 2;

/**
 * 去否定词后主题词交集占较短句的最低比例（C27）。
 * 旧判定是“≥2 个共享词 或 ≥30%”的宽松 OR，avoid / deprecated 等普通动词即可把一致的发现判成矛盾；
 * 现在与相似度门槛一起取 SIMILARITY_MERGE，两者都满足才算同一主张的正反说法。
 */
const MIN_CONTRADICTION_TOPIC_RATIO = SIMILARITY_MERGE;

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
   * - 矛盾替换只发生在“否定极性相反 + 相似度 ≥ SIMILARITY_MERGE + 去否定词后主题交集达标”时；
   *   同批（本次固化写过的行，或同一 bootstrapSession 的行）且来源维度不同的“矛盾”不替换，各自保留。
   * - MERGE 拼接后超过 500 字时不截断丢弃新候选：候选已被包含则按 UPDATE 计，否则降级为 ADD。
   *
   * @returns 固化统计 ConsolidateStats：added / updated / merged / skipped 计数；
   *   发生矛盾替换时另带 replaced
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

    // 去重与矛盾检测必须看到容量内的全部活跃行（不是检索默认的最近 50 行，C29）；
    // 分词缓存只活在本次 consolidate 内，每条候选与最多 MEMORY_STORE_MAX_MEMORIES 行比较时复用分词结果。
    const similarityScope: SimilarityScope = {
      candidateWindow: MEMORY_STORE_MAX_MEMORIES,
      tokenCache: new Map<string, Set<string>>(),
    };
    const batch: BatchContext = {
      bootstrapSession,
      touchedRowIds: new Set<string>(),
      diagnostics: {
        crossDimensionKept: 0,
        belowContradictionGate: 0,
        mergeDowngraded: 0,
        mergeAbsorbed: 0,
      },
    };

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
        const normalized = this.#normalizeCandidate(candidate, content);

        // 矛盾检测与 ADD/UPDATE/MERGE 共用同一次同 type 相似检索；前一候选已在同一事务内写入，
        // 冲突判断必须看到它，不能整批预判后再写。
        const similar = this.#store.findSimilar(content, normalized.type, 3, similarityScope);
        const conflict = this.#resolveConflict(normalized, similar, batch);
        if (conflict.replaced) {
          replaced++;
          continue;
        }

        // 被判为“同批不同维度矛盾”而保留的行不能再作为 UPDATE / MERGE 目标，否则正反两句会被拼成一条。
        const remaining = similar.filter((row) => !conflict.keptRowIds.has(row.id));
        if (remaining.length === 0) {
          this.#addCandidate(candidate, normalized, batch);
          stats.added++;
          continue;
        }

        const topMatch = remaining[0];
        const similarity = topMatch.similarity ?? 0;

        if (similarity >= SIMILARITY_UPDATE) {
          // UPDATE: 几乎同义 → 更新重要性、访问计数，并合并来源元数据
          this.#absorbIntoExisting(topMatch, normalized, batch);
          stats.updated++;
          this.#logDebug(
            `UPDATE sim=${similarity.toFixed(2)}: "${content.substring(0, 40)}..." → existing "${topMatch.content.substring(0, 40)}..."`
          );
        } else if (similarity >= SIMILARITY_MERGE) {
          const outcome = this.#mergeOrDowngrade(topMatch, candidate, normalized, batch);
          stats[outcome]++;
        } else {
          this.#addCandidate(candidate, normalized, batch);
          stats.added++;
        }
      }
      this.#store.enforceCapacity();
    });

    runConsolidate();

    // replaced 必须在汇总日志之前写入统计，否则破坏性覆盖在汇总层面不可见（C32）。
    if (replaced > 0) {
      stats.replaced = replaced;
    }

    this.#log(
      `Consolidation: +${stats.added} ADD, ~${stats.updated} UPDATE, ⊕${stats.merged} MERGE, ↺${replaced} REPLACE, =${stats.skipped} SKIP${MemoryConsolidator.#formatDiagnostics(batch)}`
    );

    return stats;
  }

  // ═══════════════════════════════════════════════════════════
  // Legacy Migration
  // ═══════════════════════════════════════════════════════════

  /**
   * 从旧版 Memory.js JSONL 文件迁移数据到 SQLite
   *
   * @returns 迁移结果 { migrated, skipped, error? }：migrated = 新增 + 合并条数；
   *   迁移整体失败时 migrated/skipped 为 0 并带 error
   * @deprecated 唯一调用方 PersistentMemory.migrateFromLegacy 也无人调用（wz 参数从未传入）；
   *   若事项②决定保留，需先补坏行/改名失败的诊断与输入校验。随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
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
   * 发现否定/肯定矛盾时就地改写旧记忆并返回 replaced=true（调用方据此计 replaced 且不再写入）。
   *
   * 判定（C27）：否定极性相反、findSimilar 相似度 ≥ SIMILARITY_MERGE、去否定词后主题词交集
   * ≥ MIN_TOPIC_OVERLAP_WORDS 且占较短句 ≥ MIN_CONTRADICTION_TOPIC_RATIO，三者同时满足。
   * 命中但属于“同批不同维度”的行不替换，放进 keptRowIds，由调用方排除出 UPDATE/MERGE 目标。
   *
   * similar 是同 type、按相似度降序的检索结果（与主路径共用）。写失败先记日志再重抛，由外层事务整体回滚。
   */
  #resolveConflict(
    candidate: NormalizedCandidate,
    similar: MemoryRow[],
    batch: BatchContext
  ): { replaced: boolean; keptRowIds: Set<string> } {
    const keptRowIds = new Set<string>();
    try {
      for (const row of similar) {
        const similarity = row.similarity ?? 0;
        const verdict = MemoryConsolidator.#classifyContradiction(
          row.content,
          candidate.content,
          similarity
        );
        if (verdict === 'same-polarity') {
          continue;
        }
        if (verdict === 'below-gate') {
          // 旧判定下这类“一方含否定词”的相似行会被覆盖；现在只计数进汇总日志，便于回看漏判风险。
          batch.diagnostics.belowContradictionGate++;
          continue;
        }

        const existing = MemoryStore.deserialize(row);
        if (
          MemoryConsolidator.#isSameGeneration(existing, batch) &&
          MemoryConsolidator.#hasDifferentDimension(existing, candidate)
        ) {
          // 同一次 bootstrap 内不同维度的“矛盾”多半是一致的发现各自措辞（如 avoid X 与 use Y for X），
          // 互相覆盖会丢掉一条真实发现并错配来源；改为各自保留，留下带两侧维度的诊断。
          keptRowIds.add(existing.id);
          batch.diagnostics.crossDimensionKept++;
          this.#log(
            `Contradiction kept as a separate memory: same consolidation generation, different dimensions (existing=${existing.sourceDimension}, candidate=${candidate.sourceDimension}, sim=${similarity.toFixed(2)}): "${existing.content.substring(0, 50)}..." vs "${candidate.content.substring(0, 50)}..."`
          );
          continue;
        }

        this.#store.update(existing.id, {
          content: candidate.content.substring(0, MAX_CONTENT_LENGTH),
          importance: Math.max(existing.importance || 5, candidate.importance || 5),
          ...MemoryConsolidator.#replacementSource(existing, candidate),
          ...this.#mergeProvenanceLists(existing, candidate),
        });
        batch.touchedRowIds.add(existing.id);
        this.#log(
          `Conflict replacement staged (sim=${similarity.toFixed(2)}, dimension ${existing.sourceDimension ?? '-'} → ${candidate.sourceDimension ?? '-'}): "${existing.content.substring(0, 50)}..." → "${candidate.content.substring(0, 50)}..."`
        );
        return { replaced: true, keptRowIds };
      }
      return { replaced: false, keptRowIds };
    } catch (err: unknown) {
      this.#log(
        `Conflict resolution failed; consolidation will roll back: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * 判定两段记忆是否构成同一主张的正反说法。
   * similarity 来自 findSimilar（含否定词在内的整句相似度）；主题交集在剥离否定词后计算。
   */
  static #classifyContradiction(
    existingContent: string,
    candidateContent: string,
    similarity: number
  ): ContradictionVerdict {
    if (!existingContent || !candidateContent) {
      return 'same-polarity';
    }

    const existingNegated = MemoryConsolidator.#hasNegation(existingContent);
    const candidateNegated = MemoryConsolidator.#hasNegation(candidateContent);
    if (existingNegated === candidateNegated) {
      return 'same-polarity';
    }
    if (similarity < SIMILARITY_MERGE) {
      return 'below-gate';
    }

    const wordsA = MemoryConsolidator.#extractTopicWords(
      MemoryConsolidator.#stripNegation(existingContent)
    );
    const wordsB = MemoryConsolidator.#extractTopicWords(
      MemoryConsolidator.#stripNegation(candidateContent)
    );
    const minSize = Math.min(wordsA.size, wordsB.size);
    if (minSize === 0) {
      return 'below-gate';
    }

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) {
        overlap++;
      }
    }

    return overlap >= MIN_TOPIC_OVERLAP_WORDS && overlap / minSize >= MIN_CONTRADICTION_TOPIC_RATIO
      ? 'contradiction'
      : 'below-gate';
  }

  static #hasNegation(text: string): boolean {
    return NEGATION_PATTERNS_ZH.test(text) || NEGATION_PATTERNS_EN.test(text);
  }

  static #stripNegation(text: string): string {
    return text.replace(NEGATION_STRIP_ZH, ' ').replace(NEGATION_STRIP_EN, ' ');
  }

  /**
   * “同批”：行由本次固化写过，或与本次属于同一 bootstrapSession。
   * 生产路径 clearPrevious 会先删掉上一代 bootstrap 行，此时矛盾检测几乎只在同批候选之间触发。
   */
  static #isSameGeneration(existing: DeserializedMemory, batch: BatchContext): boolean {
    if (batch.touchedRowIds.has(existing.id)) {
      return true;
    }
    return Boolean(batch.bootstrapSession) && existing.bootstrapSession === batch.bootstrapSession;
  }

  /** 两侧都声明了来源维度且不同才算“不同维度”；任一侧缺失时无法判断，按同维度处理（允许替换）。 */
  static #hasDifferentDimension(
    existing: DeserializedMemory,
    candidate: NormalizedCandidate
  ): boolean {
    return (
      Boolean(existing.sourceDimension) &&
      Boolean(candidate.sourceDimension) &&
      existing.sourceDimension !== candidate.sourceDimension
    );
  }

  // ═══════════════════════════════════════════════════════════
  // Private: 写入路径
  // ═══════════════════════════════════════════════════════════

  /**
   * 候选归一化（C28）：type 缺省或空串统一为 'fact'；来源字段与列表字段只接受字符串，
   * 形状不符时回退为空并记 warn（不记正文）。
   */
  #normalizeCandidate(candidate: CandidateMemory, content: string): NormalizedCandidate {
    return {
      type: candidate.type || 'fact',
      content,
      importance: candidate.importance,
      sourceDimension: this.#normalizeOptionalString(candidate.sourceDimension, 'sourceDimension'),
      sourceEvidence: this.#normalizeOptionalString(candidate.sourceEvidence, 'sourceEvidence'),
      tags: this.#normalizeStringList(candidate.tags, 'tags'),
      relatedEntities: this.#normalizeStringList(candidate.relatedEntities, 'relatedEntities'),
    };
  }

  #normalizeOptionalString(value: unknown, field: string): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      this.#warn(`Candidate ${field} ignored: expected a string, got ${typeof value}`);
      return null;
    }
    return value.length > 0 ? value : null;
  }

  #normalizeStringList(value: unknown, field: string): string[] {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      this.#warn(`Candidate ${field} ignored: expected a string array, got ${typeof value}`);
      return [];
    }
    const strings = value.filter(
      (item): item is string => typeof item === 'string' && item.length > 0
    );
    if (strings.length !== value.length) {
      this.#warn(
        `Candidate ${field} dropped ${value.length - strings.length} non-string or empty item(s)`
      );
    }
    return [...new Set(strings)];
  }

  #addCandidate(candidate: CandidateMemory, normalized: NormalizedCandidate, batch: BatchContext) {
    // 展开保留 source / ttlDays 等 ADD 专属字段；type 与来源字段改用归一化结果，与检索时一致。
    const { id } = this.#store.add({
      ...candidate,
      type: normalized.type,
      sourceDimension: normalized.sourceDimension,
      sourceEvidence: normalized.sourceEvidence,
      tags: normalized.tags,
      relatedEntities: normalized.relatedEntities,
      bootstrapSession: batch.bootstrapSession,
    });
    batch.touchedRowIds.add(id);
  }

  /** UPDATE 语义：重要性取最大、access_count + 1，并按“吸收”规则合并来源元数据。 */
  #absorbIntoExisting(topMatch: MemoryRow, candidate: NormalizedCandidate, batch: BatchContext) {
    const existing = MemoryStore.deserialize(topMatch);
    this.#store.update(topMatch.id, {
      importance: Math.max(topMatch.importance, candidate.importance || 5),
      accessCount: topMatch.access_count + 1,
      ...this.#absorbProvenance(existing, candidate),
    });
    batch.touchedRowIds.add(topMatch.id);
  }

  /**
   * MERGE 分支（C31）：拼接后不超过 500 字才合并；超长时不能截断丢掉新候选——
   * 候选已被已有行包含则按 UPDATE 计（信息已吸收），否则降级为 ADD 新行，都不计 merged。
   * @returns 应计入的统计字段
   */
  #mergeOrDowngrade(
    topMatch: MemoryRow,
    candidate: CandidateMemory,
    normalized: NormalizedCandidate,
    batch: BatchContext
  ): 'merged' | 'updated' | 'added' {
    const similarity = (topMatch.similarity ?? 0).toFixed(2);
    const content = normalized.content;
    const mergedLength = topMatch.content.length + MERGE_SEPARATOR.length + content.length;

    if (mergedLength > MAX_CONTENT_LENGTH) {
      if (topMatch.content.toLowerCase().includes(content.toLowerCase())) {
        this.#absorbIntoExisting(topMatch, normalized, batch);
        batch.diagnostics.mergeAbsorbed++;
        this.#log(
          `MERGE→UPDATE: candidate already contained in existing memory ${topMatch.id} (sim=${similarity}, existing=${topMatch.content.length}, candidate=${content.length}, merged=${mergedLength} > ${MAX_CONTENT_LENGTH})`
        );
        return 'updated';
      }
      this.#addCandidate(candidate, normalized, batch);
      batch.diagnostics.mergeDowngraded++;
      this.#log(
        `MERGE→ADD: merged text would exceed ${MAX_CONTENT_LENGTH} chars, candidate stored as a new memory instead of being truncated into ${topMatch.id} (sim=${similarity}, existing=${topMatch.content.length}, candidate=${content.length}, merged=${mergedLength})`
      );
      return 'added';
    }

    // MERGE: 相关但不同 → 合并信息
    // findSimilar 的 related_memories_raw 与 related_memories 同源；经 deserialize 解析可保证得到
    // string[]（非数组 JSON 回退 [] 并记 warn），否则 '{}' 之类的值在下方展开时会抛错并回滚整批固化。
    const existing = MemoryStore.deserialize(topMatch);
    this.#store.update(topMatch.id, {
      content: `${topMatch.content}${MERGE_SEPARATOR}${content}`,
      importance: Math.max(topMatch.importance, normalized.importance || 5),
      relatedMemories: [...existing.relatedMemories, `merged:${Date.now()}`],
      ...this.#absorbProvenance(existing, normalized),
    });
    batch.touchedRowIds.add(topMatch.id);
    this.#logDebug(
      `MERGE sim=${similarity}: "${content.substring(0, 40)}..." ⊕ "${topMatch.content.substring(0, 40)}..."`
    );
    return 'merged';
  }

  /**
   * UPDATE / MERGE 的来源元数据合并：单值列已有值保留、为空才补；tags、relatedEntities 取并集。
   * 只返回实际变化的字段，未变化时不写列。
   */
  #absorbProvenance(
    existing: DeserializedMemory,
    candidate: NormalizedCandidate
  ): Pick<MemoryUpdates, 'sourceDimension' | 'sourceEvidence' | 'tags' | 'relatedEntities'> {
    const updates: Pick<
      MemoryUpdates,
      'sourceDimension' | 'sourceEvidence' | 'tags' | 'relatedEntities'
    > = { ...this.#mergeProvenanceLists(existing, candidate) };
    if (!existing.sourceDimension && candidate.sourceDimension) {
      updates.sourceDimension = candidate.sourceDimension;
    }
    if (!existing.sourceEvidence && candidate.sourceEvidence) {
      updates.sourceEvidence = candidate.sourceEvidence;
    }
    return updates;
  }

  /**
   * 矛盾替换的单值来源字段：行内容已换成新陈述，sourceDimension / sourceEvidence 随之改为新候选的值
   * （候选缺省即清空），否则证据指向被推翻的旧说法（C27）。只返回与已有值不同的字段。
   */
  static #replacementSource(
    existing: DeserializedMemory,
    candidate: NormalizedCandidate
  ): Pick<MemoryUpdates, 'sourceDimension' | 'sourceEvidence'> {
    const updates: Pick<MemoryUpdates, 'sourceDimension' | 'sourceEvidence'> = {};
    if ((existing.sourceDimension || null) !== candidate.sourceDimension) {
      updates.sourceDimension = candidate.sourceDimension;
    }
    if ((existing.sourceEvidence || null) !== candidate.sourceEvidence) {
      updates.sourceEvidence = candidate.sourceEvidence;
    }
    return updates;
  }

  /** tags、relatedEntities 并集（已有项在前、保持顺序），只返回有新增项的字段。 */
  #mergeProvenanceLists(
    existing: DeserializedMemory,
    candidate: NormalizedCandidate
  ): Pick<MemoryUpdates, 'tags' | 'relatedEntities'> {
    const updates: Pick<MemoryUpdates, 'tags' | 'relatedEntities'> = {};
    const tags = this.#unionList(existing.tags, candidate.tags, 'tags', existing.id);
    if (tags) {
      updates.tags = tags;
    }
    const relatedEntities = this.#unionList(
      existing.relatedEntities,
      candidate.relatedEntities,
      'relatedEntities',
      existing.id
    );
    if (relatedEntities) {
      updates.relatedEntities = relatedEntities;
    }
    return updates;
  }

  /**
   * 列表并集，上限 MAX_MERGED_LIST_ITEMS。已有项永不被挤掉，只截断新增项；截断时记 debug。
   * @returns 合并后的列表；没有任何新增项时返回 null（调用方据此不写该列）
   */
  #unionList(existing: string[], incoming: string[], field: string, id: string): string[] | null {
    const known = new Set(existing);
    const additions = incoming.filter((item) => !known.has(item));
    if (additions.length === 0) {
      return null;
    }
    const room = Math.max(0, MAX_MERGED_LIST_ITEMS - existing.length);
    const accepted = additions.slice(0, room);
    if (accepted.length < additions.length) {
      this.#logDebug(
        `${field} of ${id} reached ${MAX_MERGED_LIST_ITEMS} items; dropped ${additions.length - accepted.length} incoming item(s)`
      );
    }
    return accepted.length > 0 ? [...existing, ...accepted] : null;
  }

  /** 汇总日志附加的诊断计数，只在有非零项时输出。 */
  static #formatDiagnostics(batch: BatchContext): string {
    const { crossDimensionKept, belowContradictionGate, mergeDowngraded, mergeAbsorbed } =
      batch.diagnostics;
    const parts: string[] = [];
    if (crossDimensionKept > 0) {
      parts.push(`contradictions kept across dimensions=${crossDimensionKept}`);
    }
    if (belowContradictionGate > 0) {
      parts.push(`opposite-polarity pairs below contradiction gate=${belowContradictionGate}`);
    }
    if (mergeDowngraded > 0) {
      parts.push(`MERGE→ADD downgrades=${mergeDowngraded}`);
    }
    if (mergeAbsorbed > 0) {
      parts.push(`MERGE→UPDATE absorbed=${mergeAbsorbed}`);
    }
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
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
