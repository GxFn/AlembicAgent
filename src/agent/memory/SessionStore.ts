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
 * 缓存过期: 默认惰性清扫 (读取时按 TTL 判定、写入前顺带淘汰)，不注册后台定时器；
 *   只有显式传入 cleanupIntervalMs>0 才注册 'SessionStore/cleanup' interval (见 SessionStoreConfig)。
 * 持久化: 通过 saveCheckpoint / loadCheckpoint 实现断点续传。
 *
 * @module SessionStore
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Disposable } from '@alembic/core/events';
import { timerRegistry } from '@alembic/core/events';
import type { WriteZone } from '@alembic/core/io';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { stableStringify } from '#shared/serialization.js';
import { truncateToTokenBudget } from '#shared/tokenUtils.js';
import type { SessionStoreNormalization, SessionStoreSerialized } from './SessionStoreSchema.js';
import {
  normalizeDimensionDigest,
  normalizeTierReflection,
  validateSessionStoreShape,
} from './SessionStoreSchema.js';

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
  /** 检查点中的派生索引归属；独立 addEvidence 不接受此字段。 */
  reportDimId?: string;
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
  /**
   * 三态语义（见 SessionStore.storeDimensionReport）：
   * 缺省（undefined）= 沿用该维度已有 digest；null = 显式清空；对象 = 整体替换（严格校验）。
   */
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
  /** 只读缓存条目 TTL (毫秒)，<=0 表示永不过期；默认 30 分钟。 */
  ttlMs?: number;
  /**
   * 主动清扫间隔 (毫秒)。默认 (undefined 或 <=0) 不注册任何定时器：过期条目在 getCachedResult
   * 读取时按 TTL 判定、在 cacheToolResult 写入前顺带清扫 (惰性清扫)。
   *
   * 默认惰性的原因 (C41)：Core 全局 timerRegistry 只 unref 不自动移除条目，宿主 (长驻 daemon /
   * api-server) 每次 generate 都新建 SessionStore 却从不 dispose；构造期注册的 interval 闭包会把
   * 每个实例 (含全部维度报告与证据) 永久钉在注册表里，泄漏随作业次数线性增长。
   *
   * 显式传入 >0 才向 timerRegistry 注册 'SessionStore/cleanup' interval；该闭包只经 WeakRef 持有
   * 实例，实例被 GC 后下一次触发即自注销。正常释放路径仍是调用 dispose()。
   */
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
  /** 只读缓存的命中 / 未命中 / 淘汰计数，经 getStats().cache 暴露，clearCache() 归零 */
  #cacheStats = { hits: 0, misses: 0, evictions: 0 };
  #ttlMs;
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;

  #logger: ReturnType<typeof Logger.getInstance>;

  constructor(config: SessionStoreConfig = {}) {
    this.#projectContext = structuredClone({
      ...Object.fromEntries(
        ['projectName', 'primaryLang', 'fileCount', 'modules']
          .filter((key) => config[key] !== undefined)
          .map((key) => [key, config[key]])
      ),
      ...(config.projectContext || {}),
    });
    this.#ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.#logger = Logger.getInstance();

    // 默认惰性清扫，不注册全局定时器 (原因见 SessionStoreConfig.cleanupIntervalMs)。
    // 只有调用方显式开启主动清扫且 TTL 有效时才注册；TTL<=0 时没有可过期条目，timer 无意义。
    const cleanupInterval = config.cleanupIntervalMs ?? 0;
    if (this.#ttlMs > 0 && cleanupInterval > 0) {
      this.#cleanupTimer = this.#registerCleanupTimer(cleanupInterval);
    }
  }

  // ═══════════════════════════════════════════════════════
  // §1: 维度报告 (from EpisodicMemory)
  // ═══════════════════════════════════════════════════════

  /**
   * 维度完成后存储完整报告（整代替换：报告、本维 evidence 索引与 from=dimId 的 crossRefs 一起换代）。
   *
   * digest 三态：
   *   - 缺省（input.digest === undefined）：沿用该维度已有 digest，并按它重建 from=dimId 的 crossRefs；
   *   - 显式 null：清空 digest 及其派生 crossRefs；
   *   - 对象：整体替换，按快照规则严格校验，不合规抛 Error 且不改动现有状态。
   * 缺省沿用的原因：宿主续跑先 addDimensionDigest 恢复 checkpoint digest、再存不带 digest 的报告
   * 恢复 analysisText，首跑顺序则相反；若缺省即清空，续跑会丢失 digest 与前序维度给后续维度的建议，
   * 续跑 prompt 与首跑不一致。
   */
  storeDimensionReport(dimId: string, input: DimensionReportInput) {
    const report = structuredClone(input);
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

    const previousDigest = this.#dimensionReports.get(dimId)?.digest ?? null;
    const digestOmitted = report.digest === undefined;
    // 显式分支保留历史的 `|| null`：非对象的假值（如 ''）仍视为清空，不额外引入新的抛错路径。
    const digest = digestOmitted ? previousDigest : report.digest || null;
    // 记录本次 digest 走了哪条分支，写进存储日志，续跑排查时能看出 digest 是沿用、替换还是被清空。
    let digestAction: 'retained' | 'replaced' | 'cleared' | 'none' = 'none';
    if (digestOmitted) {
      if (previousDigest) {
        digestAction = 'retained';
      }
    } else if (digest) {
      digestAction = 'replaced';
    } else if (previousDigest) {
      digestAction = 'cleared';
    }

    const nextReport = validateSessionStoreShape({
      dimensionReports: {
        [dimId]: {
          dimId,
          completedAt: Date.now(),
          analysisText: report.analysisText || '',
          findings,
          referencedFiles: report.referencedFiles || [],
          candidatesSummary: report.candidatesSummary || [],
          workingMemoryDistilled: report.workingMemoryDistilled || null,
          digest,
        },
      },
    }).dimensionReports[dimId];
    // 校验通过后才开始改状态：坏报告抛错时旧一代报告与索引保持不变。
    // 报告及其派生索引是一代数据；只删本维报告产生的索引，保留独立追加证据。
    for (const [file, entries] of this.#evidenceStore) {
      const kept = entries.filter((entry) => entry.reportDimId !== dimId);
      if (kept.length > 0) {
        this.#evidenceStore.set(file, kept);
      } else {
        this.#evidenceStore.delete(file);
      }
    }
    this.#crossReferences = this.#crossReferences.filter((ref) => ref.from !== dimId);
    this.#dimensionReports.set(dimId, nextReport);

    // 自动提取文件级 Evidence
    for (const f of findings) {
      if (f.evidence) {
        const ev = typeof f.evidence === 'string' ? f.evidence : String(f.evidence);
        for (const filePath of evidenceFilePaths(ev)) {
          const entries = this.#evidenceStore.get(filePath) || [];
          entries.push({
            dimId,
            reportDimId: dimId,
            finding: f.finding,
            importance: f.importance,
            timestamp: Date.now(),
          });
          this.#evidenceStore.set(filePath, entries);
        }
      }
    }

    // 从本代 digest（含缺省沿用的旧 digest）重建 crossRefs；上面已删掉 from=dimId 的旧索引，不会累加。
    this.#pushDigestCrossRefs(dimId, nextReport.digest);

    this.#log(
      'info',
      `[SessionStore] Stored report for "${dimId}": ` +
        `${report.findings?.length || 0} findings, ` +
        `${report.referencedFiles?.length || 0} files, ` +
        `digest=${digestAction}`
    );
  }

  getDimensionReport(dimId: string): DimensionReport | undefined {
    return structuredClone(this.#dimensionReports.get(dimId));
  }

  getCompletedDimensions() {
    return [...this.#dimensionReports.keys()];
  }

  // ═══════════════════════════════════════════════════════
  // §2: Evidence Store
  // ═══════════════════════════════════════════════════════

  addEvidence(filePath: string, evidence: Omit<Finding, 'timestamp' | 'reportDimId'>) {
    let evidenceList = this.#evidenceStore.get(filePath);
    if (!evidenceList) {
      evidenceList = [];
      this.#evidenceStore.set(filePath, evidenceList);
    }
    const owned = structuredClone(evidence) as Finding;
    delete owned.reportDimId;
    evidenceList.push({ ...owned, timestamp: Date.now() });
  }

  getEvidenceForFile(filePath: string): Finding[] {
    return (this.#evidenceStore.get(filePath) || []).map(publicEvidence);
  }

  /**
   * 按文件路径或 finding 文本（不区分大小写的子串匹配）检索证据，可按 dimId 过滤。
   * @returns 命中列表 { filePath, evidence }[]，按 evidence.importance 降序（缺省按 5 计）
   */
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
          results.push({ filePath, evidence: publicEvidence(ev) });
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

  /**
   * 挂载维度 digest：已有报告时只替换其 digest，否则建一份仅含 digest 的报告（续跑恢复路径）。
   *
   * 入口归一化：digest 来自宿主 parseDimensionDigest 透传的 AI 回复或宿主未校验的 dimension
   * checkpoint，可能出现 crossRefs 值为对象、keyFindings 为字符串等偏离。先经
   * normalizeDimensionDigest 修复（逐项 warn，写明 dimId、字段与原始类型），保证 prompt 中不出现
   * `[object Object]`、无报告分支不抛原生 TypeError、入库状态能通过自身 fromJSON。
   * 整体不是对象时无法归一化，抛 Error，且在任何状态改动之前抛出。
   */
  addDimensionDigest(dimId: string, input: DimensionDigest) {
    const { digest, normalizations } = normalizeDimensionDigest(structuredClone(input));
    this.#warnNormalizations(`addDimensionDigest "${dimId}"`, normalizations);
    const existing = this.#dimensionReports.get(dimId);
    const nextReport: DimensionReport = existing
      ? { ...existing, digest }
      : validateSessionStoreShape({
          dimensionReports: {
            [dimId]: {
              dimId,
              completedAt: Date.now(),
              analysisText: digest.summary || '',
              findings: (digest.keyFindings || []).map((f) => ({
                finding: typeof f === 'string' ? f : f.finding,
                evidence: '',
                importance: 5,
              })),
              referencedFiles: [],
              candidatesSummary: [],
              workingMemoryDistilled: null,
              digest,
            },
          },
        }).dimensionReports[dimId];
    // 以上全部成功后才改状态：digest 换代时 from=dimId 的 crossRefs 一起换代。
    this.#crossReferences = this.#crossReferences.filter((ref) => ref.from !== dimId);
    this.#dimensionReports.set(dimId, nextReport);
    this.#pushDigestCrossRefs(dimId, digest);
    this.#log(
      'info',
      `[SessionStore] Digest for "${dimId}": ` +
        `${existing ? 'attached to existing report' : 'created digest-only report'}, ` +
        `${Object.keys(digest.crossRefs ?? {}).length} crossRefs`
    );
  }

  // ═══════════════════════════════════════════════════════
  // §5: Tier Reflection
  // ═══════════════════════════════════════════════════════

  /**
   * 追加一条 Tier 反思。与 digest 一样先经 normalizeTierReflection 归一化（逐项 warn），
   * 保证反思数组始终能通过自身 fromJSON；反思缺 tierIndex 时以参数 tierIndex 补齐。
   * 整体不是对象时抛 Error，反思数组保持不变。
   */
  addTierReflection(tierIndex: number, input: TierReflection) {
    const { reflection, normalizations } = normalizeTierReflection(
      structuredClone(input),
      tierIndex
    );
    this.#warnNormalizations(`addTierReflection tierIndex=${tierIndex}`, normalizations);
    this.#tierReflections.push(reflection);
    this.#log(
      'info',
      `[SessionStore] Tier ${tierIndex + 1} reflection: ` +
        `${reflection.topFindings.length} top findings, ` +
        `${reflection.crossDimensionPatterns.length} patterns`
    );
  }

  /**
   * 获取所有 TierReflection 的深拷贝。EpisodicConsolidator 读取反思时优先调用它
   * （只克隆反思数组），缺失该方法的鸭子类型宿主才回退到 toJSON() 整体快照。
   */
  getTierReflections() {
    return structuredClone(this.#tierReflections);
  }

  /**
   * 把全部 TierReflection 渲染成 Markdown 段落（核心发现、跨维度模式、对后续维度的建议）。
   *
   * 注意：名称里的 "Relevant" 名不副实——当前不做相关性过滤，currentDimId 未被使用，
   * 返回的是所有 tier 的反思；参数仅为保持公开签名而保留。调用方需要自行去重或裁剪。
   * @returns 渲染后的 Markdown；没有任何反思时返回 null
   */
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
    // tokenBudget 来自宿主 opts 且未经校验；NaN 等非法值由 tokenUtils 按 0 处理并经此 logger 报告。
    const result = truncateToTokenBudget(text, tokenBudget, undefined, (level, message) =>
      this.#log(level, `[SessionStore] ${message}`)
    );
    if (result !== text) {
      this.#logger.debug(`[SessionStore] context truncated to ${tokenBudget} estimated tokens`);
    }
    return result;
  }

  /** 兼容 DimensionContext.buildContextForDimension 返回格式 */
  buildContextSnapshot(currentDimId: string) {
    const previousDimensions: Record<string, DimensionDigest> = Object.create(null);
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
    return structuredClone({ previousDimensions, submittedCandidates });
  }

  // ═══════════════════════════════════════════════════════
  // §7: 蒸馏上下文 (for PipelineStrategy produce 阶段)
  // ═══════════════════════════════════════════════════════

  /**
   * 获取维度的蒸馏上下文 (供 Producer 使用)
   * @returns 维度蒸馏上下文 { keyFindings, toolCallSummary, referencedFiles } 的深拷贝；
   *   该维度尚无报告时返回 null
   */
  getDistilledForProducer(dimId: string) {
    const report = this.#dimensionReports.get(dimId);
    if (!report) {
      return null;
    }

    return structuredClone({
      keyFindings: report.workingMemoryDistilled?.keyFindings || [],
      toolCallSummary: report.workingMemoryDistilled?.toolCallSummary || [],
      referencedFiles: report.referencedFiles || [],
    });
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
    // 惰性清扫：没有后台 timer 时过期条目在这里顺带淘汰 (读取路径由 getCachedResult 按 TTL 判定)。
    // 两个缓存上限很小 (200 / 500)，O(n) 扫描成本可忽略；TTL<=0 时 #evictExpired 直接返回。
    this.#evictExpired();
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
    const relative = '.asd/bootstrap-checkpoint/session-store.json';
    const target = wz?.data(relative).absolute ?? path.join(projectRoot, relative);
    const temporaryRelative = `${relative}.${randomUUID()}.tmp`;
    const temporary =
      wz?.data(temporaryRelative).absolute ?? path.join(projectRoot, temporaryRelative);
    try {
      const snapshot = this.toJSON();
      const data = {
        ...snapshot,
        version: 2,
        savedAt: Date.now(),
        dimensionReports: Object.fromEntries(
          Object.entries(snapshot.dimensionReports).map(([id, report]) => [
            id,
            { ...report, analysisText: report.analysisText.substring(0, 500) },
          ])
        ),
        evidenceIndex: Object.keys(snapshot.evidenceStore || {}),
      };
      const content = JSON.stringify(data, null, 2);
      // 同目录临时文件写完才替换；失败不能破坏上一次可恢复检查点。
      if (wz) {
        wz.writeFile(wz.data(temporaryRelative), content);
        wz.rename(wz.data(temporaryRelative), wz.data(relative));
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(temporary, content, 'utf-8');
        fs.renameSync(temporary, target);
      }
      this.#log('info', `[SessionStore] Checkpoint saved: ${this.#dimensionReports.size} reports`);
    } catch (err: unknown) {
      this.#log(
        'warn',
        `[SessionStore] Failed to save checkpoint; previous file retained: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err instanceof Error
        ? err
        : new Error('Session checkpoint write failed', { cause: err });
    } finally {
      try {
        if (wz) {
          if (fs.existsSync(temporary)) {
            wz.remove(wz.data(temporaryRelative));
          }
        } else {
          fs.rmSync(temporary, { force: true });
        }
      } catch (err: unknown) {
        this.#log(
          'warn',
          `[SessionStore] temporary checkpoint cleanup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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
        this.#log('warn', `[SessionStore] Unsupported checkpoint version: ${data.version}`);
        return false;
      }
      if (Date.now() - data.savedAt > 3600_000) {
        this.#log('info', `[SessionStore] Checkpoint expired (>1h), ignoring`);
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

      this.#log('info', `[SessionStore] Checkpoint loaded: ${this.#dimensionReports.size} reports`);
      return true;
    } catch (err: unknown) {
      // 恢复失败（文件读写、JSON 解析或快照校验）一律降级为“无检查点”，由调用方重跑相应维度；
      // 非 Error 抛出值按原值输出，避免日志只剩 undefined。
      this.#log(
        'warn',
        `[SessionStore] Failed to load checkpoint: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §10: 序列化
  // ═══════════════════════════════════════════════════════

  toJSON(): SessionStoreSerialized {
    return structuredClone({
      dimensionReports: Object.fromEntries(this.#dimensionReports),
      crossReferences: this.#crossReferences,
      tierReflections: this.#tierReflections,
      submittedCandidates: Object.fromEntries(this.#submittedCandidates),
      projectContext: this.#projectContext,
      evidenceStore: Object.fromEntries(this.#evidenceStore),
    });
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
    const evidence: Record<string, Finding[]> = Object.assign(
      Object.create(null),
      snapshot.evidenceStore || {}
    );
    if (snapshot.evidenceStore === undefined) {
      for (const [dimId, report] of Object.entries(snapshot.dimensionReports)) {
        for (const finding of report.findings) {
          if (finding.evidence) {
            for (const file of evidenceFilePaths(finding.evidence)) {
              (evidence[file] ??= []).push({
                ...finding,
                dimId,
                reportDimId: dimId,
                timestamp: report.completedAt,
              });
            }
          }
        }
      }
    }
    for (const [dimId, report] of Object.entries(snapshot.dimensionReports)) {
      for (const finding of report.findings) {
        if (!finding.evidence) {
          continue;
        }
        const files = evidenceFilePaths(finding.evidence);
        const oldFile = finding.evidence.split(':')[0];
        // 旧版把 E-id=path 整体当文件键；仅迁移与本报告匹配的那一项，独立证据仍原样保留。
        if (!files.includes(oldFile)) {
          const oldEntries = evidence[oldFile] || [];
          const index = oldEntries.findIndex(
            (entry) =>
              entry.reportDimId === undefined &&
              entry.dimId === dimId &&
              entry.finding === finding.finding &&
              entry.importance === finding.importance
          );
          if (index >= 0) {
            const [legacy] = oldEntries.splice(index, 1);
            if (oldEntries.length === 0) {
              delete evidence[oldFile];
            }
            for (const file of files) {
              (evidence[file] ??= []).push({ ...legacy, reportDimId: dimId });
            }
            this.#log(
              'info',
              '[SessionStore] restored legacy report evidence paths from ledger labels'
            );
          }
        }
        for (const file of files) {
          const candidates = evidence[file] || [];
          if (
            candidates.some(
              (entry) => entry.reportDimId === dimId && entry.finding === finding.finding
            )
          ) {
            continue;
          }
          const legacy = candidates.find(
            (entry) =>
              entry.reportDimId === undefined &&
              entry.dimId === dimId &&
              entry.finding === finding.finding &&
              entry.importance === finding.importance
          );
          if (legacy) {
            legacy.reportDimId = dimId;
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

  #log(level: 'info' | 'warn', message: string): void {
    observeSafely(
      () => this.#logger[level](message),
      () => undefined
    );
  }

  /**
   * 把写入口归一化产生的降级记录汇总成一条 warn：入口 + 维度/层标识 + 每个字段的原始类型与动作。
   * 一次调用只打一行，避免 AI 产出大量坏条目时刷屏，同时仍能逐字段定位。
   */
  #warnNormalizations(entry: string, normalizations: SessionStoreNormalization[]): void {
    if (normalizations.length === 0) {
      return;
    }
    const details = normalizations.map((n) => `${n.field} (${n.rawType} → ${n.action})`).join('; ');
    this.#log(
      'warn',
      `[SessionStore] ${entry}: normalized ${normalizations.length} malformed field(s): ${details}`
    );
  }

  /** digest 派生的 crossRefs 索引；调用方负责先删掉 from=dimId 的旧一代。值已由 schema 保证为字符串，空串跳过。 */
  #pushDigestCrossRefs(dimId: string, digest: DimensionDigest | null): void {
    for (const [targetDim, detail] of Object.entries(digest?.crossRefs ?? {})) {
      if (detail) {
        this.#crossReferences.push({ from: dimId, to: targetDim, relation: 'suggests', detail });
      }
    }
  }

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

  /**
   * 注册显式主动清扫 timer (仅 cleanupIntervalMs>0 时调用)。
   *
   * 闭包只经 WeakRef 持有实例：宿主若从不 dispose，实例仍可被 GC，不会因为 Core timerRegistry
   * 的 interval 闭包而永久存活。实例被回收后，下一次触发发现 deref 失败即自注销并打 debug 诊断，
   * 保证注册表条目不随 generate 次数累积。正常释放路径仍是 dispose() → timerRegistry.clear。
   */
  #registerCleanupTimer(intervalMs: number): ReturnType<typeof setInterval> {
    const ref = new WeakRef(this);
    // logger 是 Core 单例，不是本实例；闭包中不得直接引用 this，否则 WeakRef 失去意义。
    const logger = this.#logger;
    const handle = timerRegistry.setInterval(
      () => {
        const store = ref.deref();
        if (store) {
          store.#evictExpired();
          return;
        }
        // 实例已被回收却无人 dispose：timer 成为孤儿，自行注销并留下可追溯的诊断痕迹。
        timerRegistry.clear(handle);
        logger.debug(
          `[SessionStore] cleanup timer released: store garbage-collected without dispose() (intervalMs=${intervalMs})`
        );
      },
      intervalMs,
      'SessionStore/cleanup'
    );
    logger.debug(
      `[SessionStore] explicit cleanup timer registered (intervalMs=${intervalMs}, ttlMs=${this.#ttlMs})`
    );
    return handle;
  }

  /**
   * 清理过期缓存条目 (F13)。
   * 惰性路径由 cacheToolResult 写入前调用；显式 timer 路径由 #registerCleanupTimer 的闭包调用。
   */
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

/** ledger 引用先展开路径；旧纯 file:line 仍按既有入口接受。 */
function evidenceFilePaths(evidence: string): string[] {
  const labelled = [...evidence.matchAll(/(?:^|;\s*)E-\d+(?:@\d+-\d+)?=([^;\n]+)/g)]
    .map((match) =>
      match[1]
        .split(' — ')[0]
        .split(' [unverified:')[0]
        .replace(/:\d+(?:-\d+)?\b.*$/, '')
        .trim()
    )
    .filter(Boolean);
  return labelled.length ? [...new Set(labelled)] : [evidence.split(':')[0]];
}
function publicEvidence(evidence: Finding): Finding {
  const { reportDimId: _owner, ...finding } = evidence;
  return structuredClone(finding);
}
