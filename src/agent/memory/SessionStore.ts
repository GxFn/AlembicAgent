/**
 * SessionStore — Bootstrap 会话级存储 (合并 EpisodicMemory + ToolResultCache)
 *
 * 内部子系统:
 *   1. DimensionReports — 跨维度分析报告 + 结构化证据 + 交叉引用 (from EpisodicMemory)
 *   2. ReadOnlyCache — 只读工具结果缓存 (from ToolResultCache, 排除副作用工具 B3 fix)
 *
 * 替代关系:
 *   EpisodicMemory.js → 全部维度报告/证据/反思逻辑
 *   ToolResultCache.js → LRU 缓存逻辑 (仅只读工具)
 *
 * 新增能力 (vs 原模块):
 *   - getDistilledForProducer(dimId): Producer 专用蒸馏上下文 (B2 fix)
 *   - 仅缓存 code.read/search，副作用工具不能进入缓存 (B3 fix)
 *   - buildContextForDimension 增强: 消费 workingMemoryDistilled (B1 fix, 已在 EpisodicMemory 修复)
 *   - 统一的 getStats(): 合并维度 + 缓存统计
 *
 * 生命周期: 与 Bootstrap 会话一致。
 * 持久化: 通过 saveCheckpoint / loadCheckpoint 实现断点续传。
 *
 * @module SessionStore
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Disposable } from '@alembic/core/events';
import { timerRegistry } from '@alembic/core/events';
import type { WriteZone } from '@alembic/core/io';
import Logger from '@alembic/core/logging';
import { stableStringify } from '#shared/serialization.js';
import { truncateToTokenBudget } from '#shared/tokenUtils.js';
import type { SessionStoreSerialized } from './SessionStoreSchema.js';
import { validateSessionStoreShape } from './SessionStoreSchema.js';

// ── 类型定义 ──

/** 缓存上限：Agent runtime 自有策略，避免消费 Core shared/constants 内部路径。 */
const SESSION_CACHE_DEFAULTS = Object.freeze({
  maxFileEntries: 200,
  maxSearchEntries: 500,
  defaultTtlMs: 30 * 60 * 1000,
});

const MAX_FILE_CACHE = SESSION_CACHE_DEFAULTS.maxFileEntries;
const MAX_SEARCH_CACHE = SESSION_CACHE_DEFAULTS.maxSearchEntries;
const DEFAULT_TTL_MS = SESSION_CACHE_DEFAULTS.defaultTtlMs;

// ── 类型定义 ──

/** Finding 结构 */
export interface Finding {
  finding: string;
  evidence?: string;
  importance: number;
  dimId?: string;
  timestamp?: number;
}

/** 候选摘要 */
export interface CandidateSummary {
  dimId: string;
  title: string;
  subTopic: string;
  summary: string;
}

/** 跨维度引用 */
export interface CrossReference {
  from: string;
  to: string;
  relation: string;
  detail: string;
}

/** 层反思 */
export interface TierReflection {
  tierIndex: number;
  completedDimensions: string[];
  topFindings: Finding[];
  crossDimensionPatterns: string[];
  suggestionsForNextTier: string[];
}

/** WorkingMemory 蒸馏内容 */
export interface WorkingMemoryDistilled {
  keyFindings?: Finding[];
  toolCallSummary?: Array<string | { tool: string; summary: string }>;
  stats?: Record<string, number>;
  plan?: Record<string, unknown> | null;
  totalObservations?: number;
  compressedCount?: number;
}

/** 维度摘要 */
export interface DimensionDigest {
  summary?: string;
  candidateCount?: number;
  keyFindings?: Array<string | Finding>;
  crossRefs?: Record<string, string>;
  gaps?: string[];
  [key: string]: unknown;
}

/** 维度报告 */
export interface DimensionReport {
  dimId: string;
  completedAt: number;
  analysisText: string;
  findings: Finding[];
  referencedFiles: string[];
  candidatesSummary: CandidateSummary[];
  workingMemoryDistilled: WorkingMemoryDistilled | null;
  digest: DimensionDigest | null;
}

/** 维度报告输入 */
export interface DimensionReportInput {
  analysisText?: string;
  findings?: Array<{
    finding?: string;
    evidence?: string | string[] | unknown;
    importance?: number;
  }>;
  referencedFiles?: string[];
  candidatesSummary?: CandidateSummary[];
  workingMemoryDistilled?: WorkingMemoryDistilled | null;
  digest?: DimensionDigest | null;
}

/** 缓存条目 */
interface SearchCacheEntry {
  result: unknown;
  cachedAt: number;
  hitCount: number;
}

/** SessionStore 构造选项 */
export interface SessionStoreConfig {
  projectContext?: Record<string, unknown>;
  ttlMs?: number;
  cleanupIntervalMs?: number;
  /** 项目名 (便捷传入, 会合并到 projectContext) */
  projectName?: string;
  primaryLang?: string;
  fileCount?: number;
  modules?: string[];
  [key: string]: unknown;
}

/** 工具参数 */
interface ToolArgs {
  pattern?: string;
  filePath?: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════
export class SessionStore implements Disposable {
  // ── 子系统 1: DimensionReports (from EpisodicMemory) ──
  #dimensionReports = new Map<string, DimensionReport>();
  /** filePath → Evidence[] */
  #evidenceStore = new Map<string, Finding[]>();
  #crossReferences: CrossReference[] = [];
  #tierReflections: TierReflection[] = [];
  /** dimId → candidates */
  #submittedCandidates = new Map<string, CandidateSummary[]>();
  #projectContext: Record<string, unknown>;

  // ── 子系统 2: ReadOnlyCache (from ToolResultCache) ──
  #searchCache = new Map<string, SearchCacheEntry>();
  #fileCache = new Map<string, SearchCacheEntry>();
  /** } */
  #cacheStats = { hits: 0, misses: 0, evictions: 0 };
  #ttlMs;
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;

  #logger: ReturnType<typeof Logger.getInstance>;

  constructor(config: SessionStoreConfig = {}) {
    this.#projectContext = config.projectContext || {};
    this.#ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.#logger = Logger.getInstance();

    // 定期清理过期缓存条目
    const cleanupInterval = config.cleanupIntervalMs ?? 5 * 60 * 1000;
    if (this.#ttlMs > 0 && cleanupInterval > 0) {
      this.#cleanupTimer = timerRegistry.setInterval(
        () => this.#evictExpired(),
        cleanupInterval,
        'SessionStore/cleanup'
      );
    }
  }

  // ═══════════════════════════════════════════════════════
  // §1: 维度报告 (from EpisodicMemory)
  // ═══════════════════════════════════════════════════════

  /** 维度完成后存储完整报告 */
  storeDimensionReport(dimId: string, report: DimensionReportInput) {
    // findings 统一形状: { finding: string, evidence: string, importance: number }
    // P0 Fix: evidence 可能是 array/object，强制 string
    const findings: Finding[] = (report.findings || []).map((f) => ({
      finding: f.finding || '',
      evidence:
        typeof f.evidence === 'string'
          ? f.evidence
          : Array.isArray(f.evidence)
            ? f.evidence.join(', ')
            : f.evidence
              ? String(f.evidence)
              : '',
      importance: f.importance || 5,
    }));

    this.#dimensionReports.set(dimId, {
      dimId,
      completedAt: Date.now(),
      analysisText: report.analysisText || '',
      findings,
      referencedFiles: report.referencedFiles || [],
      candidatesSummary: report.candidatesSummary || [],
      workingMemoryDistilled: report.workingMemoryDistilled || null,
      digest: report.digest || null,
    });

    // 自动提取文件级 Evidence
    for (const f of findings) {
      if (f.evidence) {
        const ev = typeof f.evidence === 'string' ? f.evidence : String(f.evidence);
        const filePath = ev.split(':')[0];
        this.addEvidence(filePath, {
          dimId,
          finding: f.finding,
          importance: f.importance,
        });
      }
    }

    // 从 digest 中提取 crossRefs
    if (report.digest?.crossRefs) {
      for (const [targetDim, detail] of Object.entries(report.digest.crossRefs)) {
        if (detail) {
          this.#crossReferences.push({
            from: dimId,
            to: targetDim,
            relation: 'suggests',
            detail: String(detail),
          });
        }
      }
    }

    this.#logger.info(
      `[SessionStore] Stored report for "${dimId}": ` +
        `${report.findings?.length || 0} findings, ` +
        `${report.referencedFiles?.length || 0} files`
    );
  }

  getDimensionReport(dimId: string): DimensionReport | undefined {
    return this.#dimensionReports.get(dimId);
  }

  getCompletedDimensions() {
    return [...this.#dimensionReports.keys()];
  }

  // ═══════════════════════════════════════════════════════
  // §2: Evidence Store
  // ═══════════════════════════════════════════════════════

  addEvidence(filePath: string, evidence: Omit<Finding, 'timestamp'>) {
    let evidenceList = this.#evidenceStore.get(filePath);
    if (!evidenceList) {
      evidenceList = [];
      this.#evidenceStore.set(filePath, evidenceList);
    }
    evidenceList.push({
      ...evidence,
      timestamp: Date.now(),
    });
  }

  getEvidenceForFile(filePath: string): Finding[] {
    return this.#evidenceStore.get(filePath) || [];
  }

  /** @returns >} */
  searchEvidence(query: string, dimId?: string) {
    const results: { filePath: string; evidence: Finding }[] = [];
    const lowerQuery = query.toLowerCase();
    for (const [filePath, evidences] of this.#evidenceStore) {
      for (const ev of evidences) {
        if (dimId && ev.dimId !== dimId) {
          continue;
        }
        const matchesFile = filePath.toLowerCase().includes(lowerQuery);
        const matchesFinding = (ev.finding || '').toLowerCase().includes(lowerQuery);
        if (matchesFile || matchesFinding) {
          results.push({ filePath, evidence: ev });
        }
      }
    }
    return results.sort((a, b) => (b.evidence.importance || 5) - (a.evidence.importance || 5));
  }

  // ═══════════════════════════════════════════════════════
  // §3: 已提交候选
  // ═══════════════════════════════════════════════════════

  addSubmittedCandidate(dimId: string, candidate: Omit<CandidateSummary, 'dimId'>) {
    let candidates = this.#submittedCandidates.get(dimId);
    if (!candidates) {
      candidates = [];
      this.#submittedCandidates.set(dimId, candidates);
    }
    candidates.push({
      dimId,
      title: candidate.title || '',
      subTopic: candidate.subTopic || '',
      summary: candidate.summary || '',
    });
  }

  // ═══════════════════════════════════════════════════════
  // §4: DimensionDigest 兼容层
  // ═══════════════════════════════════════════════════════

  addDimensionDigest(dimId: string, digest: DimensionDigest) {
    const existing = this.#dimensionReports.get(dimId);
    if (existing) {
      existing.digest = digest;
    } else {
      this.#dimensionReports.set(dimId, {
        dimId,
        completedAt: Date.now(),
        analysisText: digest.summary || '',
        findings: (digest.keyFindings || []).map((f) => ({
          finding: typeof f === 'string' ? f : (f as Finding).finding || '',
          evidence: '',
          importance: 5,
        })),
        referencedFiles: [],
        candidatesSummary: [],
        workingMemoryDistilled: null,
        digest,
      });
    }
    // 提取 crossRefs
    if (digest.crossRefs) {
      for (const [targetDim, detail] of Object.entries(digest.crossRefs)) {
        if (detail) {
          const exists = this.#crossReferences.some(
            (cr) => cr.from === dimId && cr.to === targetDim
          );
          if (!exists) {
            this.#crossReferences.push({
              from: dimId,
              to: targetDim,
              relation: 'suggests',
              detail: String(detail),
            });
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // §5: Tier Reflection
  // ═══════════════════════════════════════════════════════

  addTierReflection(tierIndex: number, reflection: TierReflection) {
    this.#tierReflections.push(reflection);
    this.#logger.info(
      `[SessionStore] Tier ${tierIndex + 1} reflection: ` +
        `${reflection.topFindings?.length || 0} top findings, ` +
        `${reflection.crossDimensionPatterns?.length || 0} patterns`
    );
  }

  /** 获取所有 TierReflection (F17: EpisodicConsolidator 需要) */
  getTierReflections() {
    return [...this.#tierReflections];
  }

  getRelevantReflections(currentDimId: string): string | null {
    if (this.#tierReflections.length === 0) {
      return null;
    }
    const parts: string[] = [];
    for (const ref of this.#tierReflections) {
      parts.push(`### Tier ${ref.tierIndex + 1} 综合洞察`);
      if (ref.topFindings?.length > 0) {
        parts.push('**核心发现**:');
        for (const f of ref.topFindings.slice(0, 5)) {
          parts.push(`- [${f.importance || 5}/10] ${f.finding}`);
        }
      }
      if (ref.crossDimensionPatterns?.length > 0) {
        parts.push('**跨维度模式**:');
        for (const p of ref.crossDimensionPatterns) {
          parts.push(`- ${p}`);
        }
      }
      if (ref.suggestionsForNextTier?.length > 0) {
        parts.push('**对后续维度的建议**:');
        for (const s of ref.suggestionsForNextTier) {
          parts.push(`- ${s}`);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  // ═══════════════════════════════════════════════════════
  // §6: 上下文构建 (核心: 替代 DimensionContext)
  // ═══════════════════════════════════════════════════════

  /**
   * 构建给 Analyst 的跨维度上下文
   *
   * @param [focusKeywordsOrOpts] 关键词数组或 options 对象
   */
  buildContextForDimension(
    currentDimId: string,
    focusKeywordsOrOpts: string[] | { focusKeywords?: string[]; tokenBudget?: number } = []
  ) {
    // 兼容两种调用方式: (dimId, keywords[]) 或 (dimId, { focusKeywords, tokenBudget })
    let focusKeywords: string[] = [];
    let tokenBudget = Infinity;
    if (Array.isArray(focusKeywordsOrOpts)) {
      focusKeywords = focusKeywordsOrOpts;
    } else if (typeof focusKeywordsOrOpts === 'object') {
      focusKeywords = focusKeywordsOrOpts.focusKeywords || [];
      tokenBudget = focusKeywordsOrOpts.tokenBudget ?? Infinity;
    }

    const parts: string[] = [];
    const completedDims = [...this.#dimensionReports.entries()].filter(
      ([id]) => id !== currentDimId
    );
    const keywords = focusKeywords.map((word) => word.trim().toLowerCase()).filter(Boolean);
    if (keywords.length > 0) {
      const scores = new Map(
        completedDims.map(([id, report]) => {
          const findings =
            report.findings.length > 0
              ? report.findings
              : report.workingMemoryDistilled?.keyFindings || [];
          const text = [
            id,
            report.digest?.summary,
            report.analysisText,
            ...findings.map((finding) => finding.finding),
            ...report.referencedFiles,
          ]
            .join(' ')
            .toLowerCase();
          return [id, keywords.filter((word) => text.includes(word)).length] as const;
        })
      );
      // 同分保持历史顺序；优先投影当前任务相关维度，再由已有 evidence 工具补细节。
      completedDims.sort(([a], [b]) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
    }

    if (completedDims.length === 0 && this.#tierReflections.length === 0) {
      return '';
    }

    parts.push('## 前序维度分析成果（避免重复探索）');
    if (completedDims.length > 0) {
      parts.push(
        `前序维度索引: ${completedDims
          .slice(0, 5)
          .map(([id]) => id)
          .join(', ')}${completedDims.length > 5 ? ` (+${completedDims.length - 5})` : ''}`
      );
      parts.push('详细来源可用 memory.get_previous_evidence 按关键词检索。');
    }

    // §1: 前序维度的关键发现
    for (const [dimId, report] of completedDims) {
      parts.push(`### ${dimId}`);

      if (report.digest?.summary) {
        parts.push(report.digest.summary);
      } else if (report.analysisText) {
        parts.push(`${report.analysisText.substring(0, 300)}…`);
      }

      let findings: Finding[] | undefined = report.findings;
      if ((!findings || findings.length === 0) && report.workingMemoryDistilled?.keyFindings) {
        findings = report.workingMemoryDistilled.keyFindings.map((f) => ({
          finding: f.finding || '',
          evidence: f.evidence || '',
          importance: f.importance || 5,
        }));
      }

      const relevantFindings = this.#selectRelevantFindings(findings, focusKeywords, 5);
      if (relevantFindings.length > 0) {
        parts.push('**具体发现**:');
        for (const f of relevantFindings) {
          let line = `- [${f.importance}/10] ${f.finding}`;
          if (f.evidence) {
            line += ` _(${f.evidence})_`;
          }
          parts.push(line);
        }
      }

      const candidates = this.#submittedCandidates.get(dimId) || [];
      if (candidates.length > 0) {
        parts.push(
          `已提交 ${candidates.length} 个候选: ${candidates.map((c) => c.title).join(', ')}`
        );
      }
    }

    // §2: 已读文件汇总
    const allReadFiles = this.getAllReferencedFiles();
    if (allReadFiles.size > 0) {
      parts.push(`### 前序维度已扫描的文件 (${allReadFiles.size} 个)`);
      const fileList = [...allReadFiles].slice(0, 30).join(', ');
      parts.push(fileList);
      if (allReadFiles.size > 30) {
        parts.push(`…还有 ${allReadFiles.size - 30} 个文件`);
      }
    }

    // §3: 跨维度引用建议
    const relevantCrossRefs = this.#crossReferences.filter((cr) => cr.to === currentDimId);
    if (relevantCrossRefs.length > 0) {
      parts.push(`### 其他维度对 ${currentDimId} 的建议`);
      for (const cr of relevantCrossRefs) {
        parts.push(`- [来自 ${cr.from}] ${cr.detail}`);
      }
    }

    // §4: Tier Reflection
    const reflections = this.getRelevantReflections(currentDimId);
    if (reflections) {
      parts.push(reflections);
    }

    // Token 预算裁剪
    const text = parts.join('\n');
    const result = truncateToTokenBudget(text, tokenBudget);
    if (result !== text) {
      this.#logger.debug(`[SessionStore] context truncated to ${tokenBudget} estimated tokens`);
    }
    return result;
  }

  /** 兼容 DimensionContext.buildContextForDimension 返回格式 */
  buildContextSnapshot(currentDimId: string) {
    const previousDimensions: Record<string, DimensionDigest> = {};
    for (const [dimId, report] of this.#dimensionReports) {
      if (dimId === currentDimId) {
        continue;
      }
      previousDimensions[dimId] = report.digest || {
        summary: report.analysisText?.substring(0, 300) || '',
        candidateCount: report.candidatesSummary?.length || 0,
        keyFindings: report.findings?.map((f) => f.finding) || [],
        crossRefs: {},
        gaps: [],
      };
    }
    const submittedCandidates: CandidateSummary[] = [];
    for (const [, candidates] of this.#submittedCandidates) {
      submittedCandidates.push(...candidates);
    }
    return { previousDimensions, submittedCandidates };
  }

  // ═══════════════════════════════════════════════════════
  // §7: 蒸馏上下文 (for PipelineStrategy produce 阶段)
  // ═══════════════════════════════════════════════════════

  /**
   * 获取维度的蒸馏上下文 (供 Producer 使用)
   * @returns |null}
   */
  getDistilledForProducer(dimId: string) {
    const report = this.#dimensionReports.get(dimId);
    if (!report) {
      return null;
    }

    return {
      keyFindings: report.workingMemoryDistilled?.keyFindings || [],
      toolCallSummary: report.workingMemoryDistilled?.toolCallSummary || [],
      referencedFiles: report.referencedFiles || [],
    };
  }

  // ═══════════════════════════════════════════════════════
  // §8: 只读缓存 (from ToolResultCache, B3 fix)
  // ═══════════════════════════════════════════════════════

  /** 只复用同一完整请求；路径、范围和搜索选项都参与缓存键。 */
  getCachedResult(toolName: string, args: ToolArgs): unknown | null {
    if (toolName !== 'code') {
      return null;
    }
    const params = normalizeCacheArgs(args);
    const cache =
      toolName === 'code' && params.action === 'search'
        ? this.#searchCache
        : toolName === 'code' && params.action === 'read'
          ? this.#fileCache
          : null;
    const key = stableStringify(params);
    const entry = cache?.get(key);
    if (entry) {
      if (this.#ttlMs > 0 && Date.now() - entry.cachedAt > this.#ttlMs) {
        cache?.delete(key);
        this.#cacheStats.evictions++;
      } else {
        entry.hitCount++;
        this.#cacheStats.hits++;
        cache?.delete(key);
        cache?.set(key, entry);
        return entry.result;
      }
    }
    this.#cacheStats.misses++;
    return null;
  }

  cacheToolResult(toolName: string, args: ToolArgs, result: unknown) {
    if (toolName !== 'code') {
      return;
    }
    const params = normalizeCacheArgs(args);
    const record =
      result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
    if (record?.ok === false || record?.error !== undefined) {
      return;
    }
    let cache: Map<string, SearchCacheEntry>;
    let value: unknown;
    let limit: number;
    if (params.action === 'search') {
      cache = this.#searchCache;
      value = result;
      limit = MAX_SEARCH_CACHE;
    } else if (params.action === 'read' && typeof params.path === 'string') {
      const content = record ? record.content : typeof result === 'string' ? result : null;
      if (typeof content !== 'string') {
        return;
      }
      cache = this.#fileCache;
      value = { content, path: params.path, cached: true };
      limit = MAX_FILE_CACHE;
    } else {
      return;
    }
    const key = stableStringify(params);
    cache.delete(key);
    cache.set(key, { result: value, cachedAt: Date.now(), hitCount: 0 });
    if (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
  }

  /** 兼容 ToolResultCache.get() */
  get(toolName: string, args: ToolArgs): unknown | null {
    return this.getCachedResult(toolName, args);
  }

  /** 兼容 ToolResultCache.set() */
  set(toolName: string, args: ToolArgs, result: unknown) {
    this.cacheToolResult(toolName, args, result);
  }

  // ═══════════════════════════════════════════════════════
  // §9: 持久化 (断点续传)
  // ═══════════════════════════════════════════════════════

  async saveCheckpoint(projectRoot: string, wz?: WriteZone) {
    const checkpointDir = path.join(projectRoot, '.asd', 'bootstrap-checkpoint');
    try {
      const data = {
        ...this.toJSON(),
        version: 2,
        savedAt: Date.now(),
        dimensionReports: Object.fromEntries(
          [...this.#dimensionReports].map(([k, v]) => [
            k,
            {
              ...v,
              analysisText: v.analysisText?.substring(0, 500) || '',
            },
          ])
        ),
        crossReferences: this.#crossReferences,
        tierReflections: this.#tierReflections,
        submittedCandidates: Object.fromEntries(this.#submittedCandidates),
        evidenceIndex: [...this.#evidenceStore.keys()],
      };
      const content = JSON.stringify(data, null, 2);
      if (wz) {
        wz.writeFile(wz.data('.asd/bootstrap-checkpoint/session-store.json'), content);
      } else {
        fs.mkdirSync(checkpointDir, { recursive: true });
        fs.writeFileSync(path.join(checkpointDir, 'session-store.json'), content, 'utf-8');
      }
      this.#logger.info(`[SessionStore] Checkpoint saved: ${this.#dimensionReports.size} reports`);
    } catch (err: unknown) {
      this.#logger.warn(`[SessionStore] Failed to save checkpoint: ${(err as Error).message}`);
    }
  }

  async loadCheckpoint(projectRoot: string) {
    // Try new format first, then legacy
    const newPath = path.join(projectRoot, '.asd', 'bootstrap-checkpoint', 'session-store.json');
    const legacyPath = path.join(
      projectRoot,
      '.asd',
      'bootstrap-checkpoint',
      'episodic-memory.json'
    );
    const checkpointPath = fs.existsSync(newPath) ? newPath : legacyPath;

    try {
      if (!fs.existsSync(checkpointPath)) {
        return false;
      }

      const raw = fs.readFileSync(checkpointPath, 'utf-8');
      const data = JSON.parse(raw);

      if (data.version !== 1 && data.version !== 2) {
        this.#logger.warn(`[SessionStore] Unsupported checkpoint version: ${data.version}`);
        return false;
      }
      if (Date.now() - data.savedAt > 3600_000) {
        this.#logger.info(`[SessionStore] Checkpoint expired (>1h), ignoring`);
        return false;
      }

      if (typeof data.savedAt !== 'number' || !Number.isFinite(data.savedAt)) {
        throw new Error('SessionStore checkpoint savedAt must be finite');
      }
      const validated = validateSessionStoreShape({
        ...data,
        projectContext: data.projectContext ?? this.#projectContext,
      });
      this.#restoreSnapshot(validated);

      this.#logger.info(`[SessionStore] Checkpoint loaded: ${this.#dimensionReports.size} reports`);
      return true;
    } catch (err: unknown) {
      this.#logger.warn(`[SessionStore] Failed to load checkpoint: ${(err as Error).message}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §10: 序列化
  // ═══════════════════════════════════════════════════════

  toJSON(): SessionStoreSerialized {
    return {
      dimensionReports: Object.fromEntries(this.#dimensionReports),
      crossReferences: this.#crossReferences,
      tierReflections: this.#tierReflections,
      submittedCandidates: Object.fromEntries(this.#submittedCandidates),
      projectContext: this.#projectContext,
      evidenceStore: Object.fromEntries(this.#evidenceStore),
    };
  }

  static fromJSON(json: Record<string, unknown>) {
    const validated = validateSessionStoreShape(json);
    const store = new SessionStore({
      projectContext: validated.projectContext,
    });
    store.#restoreSnapshot(validated);
    return store;
  }

  /** 验证/克隆已在外部完成；在任何字段替换前构造所有集合，失败不污染当前会话。 */
  #restoreSnapshot(snapshot: SessionStoreSerialized): void {
    const evidence: Record<string, Finding[]> = snapshot.evidenceStore ?? Object.create(null);
    if (snapshot.evidenceStore === undefined) {
      for (const [dimId, report] of Object.entries(snapshot.dimensionReports)) {
        for (const finding of report.findings) {
          if (finding.evidence) {
            const file = finding.evidence.split(':')[0];
            (evidence[file] ??= []).push({ ...finding, dimId, timestamp: report.completedAt });
          }
        }
      }
    }
    const dimensionReports = new Map(Object.entries(snapshot.dimensionReports));
    const submittedCandidates = new Map(Object.entries(snapshot.submittedCandidates));
    const evidenceStore = new Map<string, Finding[]>(Object.entries(evidence));
    this.#dimensionReports = dimensionReports;
    this.#submittedCandidates = submittedCandidates;
    this.#evidenceStore = evidenceStore;
    this.#crossReferences = snapshot.crossReferences;
    this.#tierReflections = snapshot.tierReflections;
    this.#projectContext = snapshot.projectContext;
    this.#searchCache.clear();
    this.#fileCache.clear();
  }

  // ═══════════════════════════════════════════════════════
  // §11: 统计 + 查询
  // ═══════════════════════════════════════════════════════

  /** 获取所有已引用文件 (去重, F10) */
  getAllReferencedFiles(): Set<string> {
    const files = new Set<string>();
    for (const report of this.#dimensionReports.values()) {
      for (const f of report.referencedFiles) {
        files.add(f);
      }
    }
    return files;
  }

  /** 获取统计数据 (合并维度 + 缓存统计, F12) */
  getStats() {
    const totalFindings = [...this.#dimensionReports.values()].reduce(
      (sum, r) => sum + r.findings.length,
      0
    );
    const totalEvidence = [...this.#evidenceStore.values()].reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    const totalCandidates = [...this.#submittedCandidates.values()].reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    const { hits, misses } = this.#cacheStats;
    return {
      completedDimensions: this.#dimensionReports.size,
      totalFindings,
      totalEvidence,
      totalCandidates,
      crossReferences: this.#crossReferences.length,
      tierReflections: this.#tierReflections.length,
      referencedFiles: this.getAllReferencedFiles().size,
      cache: {
        ...this.#cacheStats,
        hitRate: hits + misses > 0 ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : '0%',
        searchCacheSize: this.#searchCache.size,
        fileCacheSize: this.#fileCache.size,
      },
    };
  }

  // ═══════════════════════════════════════════════════════
  // §12: 清理
  // ═══════════════════════════════════════════════════════

  /** 清空所有缓存 */
  clearCache() {
    this.#searchCache.clear();
    this.#fileCache.clear();
    this.#cacheStats = { hits: 0, misses: 0, evictions: 0 };
  }

  /** 销毁实例，释放定时器 */
  dispose() {
    this.clearCache();
    this.#dimensionReports.clear();
    this.#evidenceStore.clear();
    this.#crossReferences.length = 0;
    this.#tierReflections.length = 0;
    this.#submittedCandidates.clear();
    if (this.#cleanupTimer) {
      timerRegistry.clear(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════

  /** 从 findings 中选择与当前焦点最相关的 */
  #selectRelevantFindings(
    findings: Finding[] | undefined,
    focusKeywords: string[] | undefined,
    limit: number
  ): Finding[] {
    if (!findings || findings.length === 0) {
      return [];
    }

    if (!focusKeywords || focusKeywords.length === 0) {
      return [...findings]
        .sort((a, b) => (b.importance || 5) - (a.importance || 5))
        .slice(0, limit);
    }

    return [...findings]
      .map((f) => {
        const relevance = focusKeywords.some((kw) =>
          (f.finding || '').toLowerCase().includes(kw.toLowerCase())
        )
          ? 1
          : 0;
        return { ...f, _score: relevance * 10 + (f.importance || 5) };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, limit)
      .map(({ _score, ...rest }) => rest);
  }

  /** 清理过期缓存条目 (F13) */
  #evictExpired() {
    if (this.#ttlMs <= 0) {
      return;
    }
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.#searchCache) {
      if (now - entry.cachedAt > this.#ttlMs) {
        this.#searchCache.delete(key);
        evicted++;
      }
    }
    for (const [key, entry] of this.#fileCache) {
      if (now - entry.cachedAt > this.#ttlMs) {
        this.#fileCache.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.#cacheStats.evictions += evicted;
      this.#logger.debug(`[SessionStore] evicted ${evicted} expired cache entries`);
    }
  }
}

export default SessionStore;

function normalizeCacheArgs(args: ToolArgs): Record<string, unknown> {
  const { params, ...outer } = args;
  const normalized = {
    ...outer,
    ...(params && typeof params === 'object' && !Array.isArray(params) ? params : {}),
  } as Record<string, unknown>;
  // 与路由一致：顶层 action 决定操作，参数不能把副作用操作转换成只读缓存。
  if (outer.action !== undefined) {
    normalized.action = outer.action;
  }
  if (normalized.path === undefined && typeof normalized.filePath === 'string') {
    normalized.path = normalized.filePath;
    delete normalized.filePath;
  }
  return normalized;
}
