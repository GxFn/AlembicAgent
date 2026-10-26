/**
 * SessionStore — Bootstrap 会话级存储 (源自 EpisodicMemory)
 *
 * 内部子系统: DimensionReports — 跨维度分析报告 + 结构化证据 + 交叉引用 + Tier 反思。
 *
 * 只读工具结果缓存已删除（W1-04，审阅包 L6-P26 / C64，按决定①的 2026-10-20 答复）：它在生产中
 * 没有写入者也没有读取者，重复调用去重由 Agent 工具管道的 duplicateCache 承担。缓存 Map、
 * get/set 别名、TTL、显式清理定时器（cleanupIntervalMs/ttlMs）随之删除；getStats().cache 在过渡期
 * 固定为全零对象（见 getStats）。
 *
 * 替代关系:
 *   EpisodicMemory.js → 全部维度报告/证据/反思逻辑
 *
 * 新增能力 (vs 原模块):
 *   - buildContextForDimension 增强: 消费 workingMemoryDistilled (B1 fix, 已在 EpisodicMemory 修复)
 *   - 统一的 getStats(): 维度统计 (+ 过渡期全零的 cache 子对象)
 *
 * 生命周期: 与 Bootstrap 会话一致；不注册任何后台定时器，宿主在会话结束时调用 dispose() 释放数据。
 * 持久化: 只提供 toJSON() / fromJSON() 快照；宿主断点续跑自行保存快照并经 fromJSON() 恢复。
 *   原先写入项目 .asd 目录的检查点文件链（saveCheckpoint / loadCheckpoint 及其原子写）
 *   与无生产调用的 addEvidence / getEvidenceForFile / buildContextSnapshot / getDistilledForProducer
 *   已随 W2a-10（审阅包 L6-P25）删除。
 *
 * @module SessionStore
 */

import type { Disposable } from '@alembic/core/events';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { estimateTokens, truncateToTokenBudget } from '#shared/tokenUtils.js';
import type { SessionStoreNormalization, SessionStoreSerialized } from './SessionStoreSchema.js';
import {
  normalizeDimensionDigest,
  normalizeTierReflection,
  validateSessionStoreShape,
} from './SessionStoreSchema.js';

/** getStats().cache 的形状；字段名沿用已删除的只读工具缓存统计，宿主按这些名字打印日志。 */
interface SessionStoreCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  hitRate: string;
  searchCacheSize: number;
  fileCacheSize: number;
}

/**
 * 随只读工具缓存删除（W1-04）而失效的构造参数键；传入时每次构造只记一条 debug 日志，不再有任何效果。
 *
 * 兼容分支登记（工作区“临时兼容代码须写明消费者、原因、删除条件、清理触发与负责人”）：
 * 消费者：经 SessionStoreConfig 的索引签名（或 JS）仍传 ttlMs / cleanupIntervalMs 的旧调用方。
 *   2026-10-23 复核：宿主 Alembic 的 RuntimeInitializer.createBootstrapSessionStore 不传这两个键，
 *   Plugin、Dashboard 没有构造点；仓内只有专门验证“旧键被忽略”的测试仍传入。
 * 原因：缓存删除前这两个键会注册清理定时器。索引签名会静默收下任何键，若不留痕迹，旧调用方看不出
 *   键已失效，所以只记一条 debug 指出被忽略的键（不注册定时器、不进入 projectContext）。
 * 删除条件：工作区扫描确认没有调用方再传这两个键，且 SessionStoreConfig 的索引签名已收窄、旧键在
 *   编译期即被拒绝；届时删除本常量、构造函数里的检测分支与对应测试。
 * 清理触发：SessionStoreConfig 公开构造选项收窄的那一次改动（与 getStats().cache 的删除同属
 *   SessionStore 公开形状收窄，见 RETIRED_TOOL_CACHE_STATS）。
 * 负责人：AlembicAgent 窗口。
 */
const RETIRED_CONFIG_KEYS = ['ttlMs', 'cleanupIntervalMs'] as const;

/**
 * getStats().cache 的过渡期固定值（W1-04 删除只读工具缓存后保留的返回形状）。
 *
 * 消费者：宿主 Alembic lib/recipe-pipeline/generate/execution/consumers/SessionResultConsumer.ts:78
 *   以 `if (emStats.cache)` 判空后打印 hitRate/searchCacheSize/fileCacheSize。缓存删除前这些值在生产中
 *   本来就恒为零（缓存从无写入者），所以固定全零不改变宿主日志内容。
 * 删除触发条件：派发行 D11 的宿主提交（删除 SessionResultConsumer 的 cache 统计分支）验收落地后，
 *   删除 getStats().cache 字段与本常量（公开返回形状收窄，归 W2c）。
 * 负责人：AlembicAgent 窗口。
 */
const RETIRED_TOOL_CACHE_STATS: Readonly<SessionStoreCacheStats> = Object.freeze({
  hits: 0,
  misses: 0,
  evictions: 0,
  hitRate: '0%',
  searchCacheSize: 0,
  fileCacheSize: 0,
});

// ── 类型定义 ──

/** Finding 结构 */
export interface Finding {
  finding: string;
  evidence?: string;
  importance: number;
  dimId?: string;
  timestamp?: number;
  /**
   * 快照中的派生索引归属（由 storeDimensionReport 写入）；对外的证据查询会剥离此字段。
   * 缺少该字段的条目是旧快照恢复出的独立证据，换代时不随报告删除。
   */
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

/**
 * SessionStore 构造选项。
 *
 * 旧的 ttlMs / cleanupIntervalMs 已随只读工具缓存删除（W1-04）：本类不再注册任何定时器，
 * 旧调用方若仍经索引签名传入这两个键，构造时被忽略（不进入 projectContext，也没有任何效果）。
 */
export interface SessionStoreConfig {
  projectContext?: Record<string, unknown>;
  /** 项目名 (便捷传入, 会合并到 projectContext) */
  projectName?: string;
  primaryLang?: string;
  fileCount?: number;
  modules?: string[];
  [key: string]: unknown;
}

/** buildContextForDimension 的段落类别；拼接顺序即截断优先级（见该方法注释）。 */
type SessionContextBlockKind = 'header' | 'crossRefs' | 'reflections' | 'dimensions' | 'files';

/** 会话上下文中可整体判定保留与否的一段文本，仅用于截断诊断。 */
interface SessionContextBlock {
  kind: SessionContextBlockKind;
  text: string;
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
    this.#logger = Logger.getInstance();

    // 旧调用方仍可能经索引签名传入已删除的缓存键（兼容登记见 RETIRED_CONFIG_KEYS）：不注册定时器、
    // 不进入 projectContext，只留一条 debug 日志说明被忽略的键与原因，便于定位尚未迁移的调用点。
    const retiredKeys = RETIRED_CONFIG_KEYS.filter((key) => config[key] !== undefined);
    if (retiredKeys.length > 0) {
      this.#log(
        'debug',
        `[SessionStore] ignored retired config key(s) ${retiredKeys.join(', ')}: ` +
          'the read-only tool cache and its cleanup timer were removed (W1-04); no timer registered'
      );
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
    // 报告及其派生索引是一代数据；只删本维报告产生的索引，保留其它报告与旧快照恢复的独立证据。
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
   * 段落按模型价值优先级装配，再整体按 tokenBudget 尾部截断（C44）：
   *   1. 索引头：前序维度索引与证据检索提示（短）；
   *   2. 其他维度写给当前维度的建议（§3 crossRefs）与 Tier 反思（§4，含 suggestionsForNextTier）——
   *      前序维度专门写给本维度、或对后续维度的综合结论，相关度最高；
   *   3. 前序维度发现（§1，已按 focusKeywords 命中数排序，同分保持历史顺序）；
   *   4. 已读文件清单（§2）——可经 memory.get_previous_evidence 按需检索，价值最低。
   * 旧顺序把 §3/§4 放在维度循环与文件清单之后，前序维度达到 8 个左右时会被 analyst 默认
   * 1400 token 的会话预算整段裁掉。顺序不区分是否传入预算：无预算时内容不变，只是段落顺序一致。
   *
   * @param [focusKeywordsOrOpts] 关键词数组或 options 对象；数组形式等价于不限预算
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

    // 每个 block 是一段可整体判定“保留 / 部分保留 / 丢弃”的文本，只用于截断诊断；拼接顺序即优先级。
    const blocks: SessionContextBlock[] = [];
    const headerLines = ['## 前序维度分析成果（避免重复探索）'];
    if (completedDims.length > 0) {
      headerLines.push(
        `前序维度索引: ${completedDims
          .slice(0, 5)
          .map(([id]) => id)
          .join(', ')}${completedDims.length > 5 ? ` (+${completedDims.length - 5})` : ''}`
      );
      headerLines.push('详细来源可用 memory.get_previous_evidence 按关键词检索。');
    }
    blocks.push({ kind: 'header', text: headerLines.join('\n') });

    // §3: 跨维度引用建议（优先级最高：其他维度专门写给当前维度的结论）
    const relevantCrossRefs = this.#crossReferences.filter((cr) => cr.to === currentDimId);
    if (relevantCrossRefs.length > 0) {
      blocks.push({
        kind: 'crossRefs',
        text: [
          `### 其他维度对 ${currentDimId} 的建议`,
          ...relevantCrossRefs.map((cr) => `- [来自 ${cr.from}] ${cr.detail}`),
        ].join('\n'),
      });
    }

    // §4: Tier Reflection（与 crossRefs 同级，紧随其后；文本与 getRelevantReflections 完全一致，
    // 调用方据此做“是否已注入”的去重判定）
    const reflections = this.getRelevantReflections(currentDimId);
    if (reflections) {
      blocks.push({ kind: 'reflections', text: reflections });
    }

    // §1: 前序维度的关键发现（completedDims 已按关键词相关度排序）
    for (const [dimId, report] of completedDims) {
      const lines = [`### ${dimId}`];

      if (report.digest?.summary) {
        lines.push(report.digest.summary);
      } else if (report.analysisText) {
        lines.push(`${report.analysisText.substring(0, 300)}…`);
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
        lines.push('**具体发现**:');
        for (const f of relevantFindings) {
          let line = `- [${f.importance}/10] ${f.finding}`;
          if (f.evidence) {
            line += ` _(${f.evidence})_`;
          }
          lines.push(line);
        }
      }

      const candidates = this.#submittedCandidates.get(dimId) || [];
      if (candidates.length > 0) {
        lines.push(
          `已提交 ${candidates.length} 个候选: ${candidates.map((c) => c.title).join(', ')}`
        );
      }
      blocks.push({ kind: 'dimensions', text: lines.join('\n') });
    }

    // §2: 已读文件汇总（优先级最低，放在最后，预算不足时最先被裁掉）
    const allReadFiles = this.getAllReferencedFiles();
    if (allReadFiles.size > 0) {
      const lines = [
        `### 前序维度已扫描的文件 (${allReadFiles.size} 个)`,
        [...allReadFiles].slice(0, 30).join(', '),
      ];
      if (allReadFiles.size > 30) {
        lines.push(`…还有 ${allReadFiles.size - 30} 个文件`);
      }
      blocks.push({ kind: 'files', text: lines.join('\n') });
    }

    // Token 预算裁剪
    const text = blocks.map((block) => block.text).join('\n');
    // tokenBudget 来自宿主 opts 且未经校验；NaN 等非法值由 tokenUtils 按 0 处理并经此 logger 报告。
    const result = truncateToTokenBudget(text, tokenBudget, undefined, (level, message) =>
      this.#log(level, `[SessionStore] ${message}`)
    );
    if (result !== text) {
      this.#logContextTruncation(currentDimId, tokenBudget, text, result, blocks);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════
  // §9: 序列化
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

  /**
   * 验证/克隆已在外部完成；在任何字段替换前构造所有集合，失败不污染当前会话。
   * 唯一调用方是 fromJSON（作用于新建实例）；原先在已有实例上恢复的 loadCheckpoint 已随 W2a-10 删除。
   */
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
  }

  // ═══════════════════════════════════════════════════════
  // §10: 统计 + 查询
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

  /**
   * 获取统计数据 (维度统计, F12)。
   * cache 子对象是只读工具缓存删除后的过渡形状，固定为全零（消费者、删除触发条件与负责人见
   * RETIRED_TOOL_CACHE_STATS）；每次返回新副本，调用方改写不影响下一次统计。
   */
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
    return {
      completedDimensions: this.#dimensionReports.size,
      totalFindings,
      totalEvidence,
      totalCandidates,
      crossReferences: this.#crossReferences.length,
      tierReflections: this.#tierReflections.length,
      referencedFiles: this.getAllReferencedFiles().size,
      cache: { ...RETIRED_TOOL_CACHE_STATS },
    };
  }

  // ═══════════════════════════════════════════════════════
  // §11: 清理
  // ═══════════════════════════════════════════════════════

  /**
   * 销毁实例：清空维度报告、证据、交叉引用、反思与已提交候选。幂等。
   * 宿主在会话结束时调用（L6-P28），实现 Core Disposable；本类不持有定时器或其它外部资源。
   */
  dispose() {
    this.#dimensionReports.clear();
    this.#evidenceStore.clear();
    this.#crossReferences.length = 0;
    this.#tierReflections.length = 0;
    this.#submittedCandidates.clear();
  }

  // ═══════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════

  #log(level: 'info' | 'warn' | 'debug', message: string): void {
    observeSafely(
      () => this.#logger[level](message),
      () => undefined
    );
  }

  /**
   * 会话上下文被预算截断时，按段落类别报告保留情况（kept/total，部分保留单列），
   * 让诊断能看出丢掉的是低优先级的文件清单/维度发现，还是连跨维度建议与反思都没放下。
   * 只记录类别计数、预算与估算 token，不含记忆正文。
   */
  #logContextTruncation(
    currentDimId: string,
    tokenBudget: number,
    text: string,
    result: string,
    blocks: SessionContextBlock[]
  ): void {
    // 截断结果 = 原文前缀 + 截断标记；取公共前缀长度作为保留字符数（标记首字符偶与原文重合只影响边界判定）。
    let kept = 0;
    while (kept < result.length && kept < text.length && result[kept] === text[kept]) {
      kept++;
    }
    const tally = new Map<
      SessionContextBlockKind,
      { total: number; kept: number; partial: number }
    >();
    let offset = 0;
    for (const block of blocks) {
      const end = offset + block.text.length;
      const entry = tally.get(block.kind) ?? { total: 0, kept: 0, partial: 0 };
      entry.total++;
      if (end <= kept) {
        entry.kept++;
      } else if (offset < kept) {
        entry.partial++;
      }
      tally.set(block.kind, entry);
      offset = end + 1; // join('\n') 的分隔符
    }
    const summary = [...tally.entries()]
      .map(
        ([kind, entry]) =>
          `${kind}=${entry.kept}/${entry.total}${entry.partial > 0 ? ` (+${entry.partial} partial)` : ''}`
      )
      .join(' ');
    this.#log(
      'debug',
      `[SessionStore] context for "${currentDimId}" truncated to ${tokenBudget} estimated tokens ` +
        `(raw ${estimateTokens(text)}); kept by priority: ${summary}`
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
}

export default SessionStore;

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
