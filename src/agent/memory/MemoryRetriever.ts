/**
 * MemoryRetriever — 记忆检索与 Prompt 生成
 *
 * 从 PersistentMemory.js 提取的检索逻辑。
 * 负责:
 *   - 三维打分检索 (Generative Agents: recency × importance × relevance)
 *   - 简单文本搜索
 *   - Prompt section 生成 (预算感知)
 *   - Memory.js 兼容层: load(), append()
 *
 * @module MemoryRetriever
 */

import { cosineSimilarity } from '@alembic/core/search';
import { estimateTokens } from '#shared/tokenUtils.js';
import type { MemoryEmbeddingStore } from './MemoryEmbeddingStore.js';
import type { MemoryPromptOptions } from './MemoryPrompt.js';
import {
  isMemoryVector,
  type MemoryReadOptions,
  memoryReadDeadline,
  readMemoryValue,
  reportMemoryRead,
} from './MemoryReadPolicy.js';
import type { DeserializedMemory, MemoryRow } from './MemoryStore.js';
import { MEMORY_STORE_MAX_MEMORIES, MemoryStore } from './MemoryStore.js';

// ─── 常量 (Generative Agents 三维打分) ────────────────

/** 检索打分权重 */
const WEIGHT_RECENCY = 0.2;
const WEIGHT_IMPORTANCE = 0.3;
const WEIGHT_RELEVANCE = 0.5;

/** Recency 半衰期 (天) — 7 天未访问的记忆分数下降一半 */
const RECENCY_HALF_LIFE_DAYS = 7;

/**
 * 无 query 渲染的排序：重要性主导，访问热度只做有界加成。
 * 热度按 log1p(access_count) 归一化并在 HEAT_SATURATION_ACCESS_COUNT 次访问处封顶；
 * 重要性按 importance/10 计（一档 = 0.1），热度最大加成 0.05 只相当于半档重要性，
 * 因此热度只在同档重要性内决定先后，翻转不了整档差距：被反复注入的 importance=5
 * 记忆（写入默认值）压不住新加入的 importance=7 记忆（固化对跨维度发现、决策的常用值）。
 */
const NO_QUERY_HEAT_MAX_BONUS = 0.05;
const HEAT_SATURATION_ACCESS_COUNT = 15;

/** 相似度阈值 (用于 append 去重) */
const SIMILARITY_UPDATE = 0.85;

/** 召回记忆陈旧度阈值（天）。CG-1：>7 天加软前缀；≤7 天不加任何前缀（零噪声）。 */
const STALE_MEMORY_DAYS = 7;
/** 陈旧软提示前缀（render-only，不改任何持久化字段/Core schema），作确定性验收 grep marker。 */
const STALE_MEMORY_PREFIX = '⏳[可能陈旧] ';

/** 带评分的记忆检索结果 */
export interface ScoredMemory extends DeserializedMemory {
  _score: number;
  _recency: number;
  _relevance: number;
}

/** 检索选项 */
export interface RetrieveOptions extends MemoryReadOptions {
  limit?: number;
  source?: string;
  type?: string;
}

/** Prompt section 生成选项 */
export type PromptSectionOptions = MemoryPromptOptions;

/** Memory.load 兼容选项 */
export interface LoadOptions {
  source?: string;
}

/** Memory.append 兼容入口 */
export interface AppendEntry {
  importance?: number;
  type?: string;
  content: string;
  source?: string;
  ttl?: number | null;
}

/** 嵌入函数签名 — 异步向量嵌入 (返回 float[] 向量) */
export type EmbeddingFn = (
  text: string,
  options?: { abortSignal?: AbortSignal; inputKind?: 'query' | 'document' }
) => Promise<number[]>;

export class MemoryRetriever {
  #store: MemoryStore;

  /** 向量嵌入函数 */
  #embeddingFn: EmbeddingFn | null;

  /** 向量嵌入存储 (JSON sidecar) */
  #embeddingStore: MemoryEmbeddingStore | null;

  /** @param [opts.embeddingFn] 向量嵌入函数 (异步) */
  constructor(
    store: MemoryStore,
    opts: { embeddingFn?: EmbeddingFn; embeddingStore?: MemoryEmbeddingStore } = {}
  ) {
    this.#store = store;
    this.#embeddingFn = typeof opts.embeddingFn === 'function' ? opts.embeddingFn : null;
    this.#embeddingStore = opts.embeddingStore ?? null;
  }

  // ═══════════════════════════════════════════════════════════
  // 综合检索
  // ═══════════════════════════════════════════════════════════

  /**
   * 综合检索: recency × importance × relevance
   *
   * 借鉴 Generative Agents 的三维打分模型:
   *   score = α * recency + β * importance + γ * relevance
   *
   * @param query 查询文本
   * @returns 按 score 降序排列
   */
  async retrieve(query: string, options: RetrieveOptions = {}): Promise<ScoredMemory[]> {
    const selected = await this.#rank(query, options);
    if (options.abortSignal?.aborted) {
      return [];
    }
    for (const memory of selected) {
      this.#store.touchAccess(memory.id);
    }
    return selected;
  }

  async #rank(query: string, options: RetrieveOptions): Promise<ScoredMemory[]> {
    const { limit = 10, source, type } = options;
    if (options.abortSignal?.aborted || limit <= 0 || Number.isNaN(limit)) {
      return [];
    }
    let all = this.#store.getAllActive({ source, type });
    if (all.length === 0) {
      return [];
    }

    const now = Date.now();
    const lowerQuery = (query || '').toLowerCase();
    const queryTokens = MemoryRetriever.#tokenizeWords(lowerQuery);

    // 向量检索: 嵌入 query，然后与存储的 embedding 做余弦相似度
    let queryVec: number[] | null = null;
    const storedVectorCount = this.#embeddingStore?.size ?? 0;
    if (this.#embeddingFn && storedVectorCount === 0) {
      // 前置判断：sidecar 不存在或一条向量都没有时，query 向量不可能参与打分，
      // 嵌入它只会白占读取 deadline（远程 provider 还要计费）。直接走纯词汇排序，
      // 每次读取报一次跳过原因，区分“未配置 sidecar”与“sidecar 为空（尚未回填）”。
      // sidecar 非空但没有与当前正文匹配的向量时仍按原路径嵌入，避免逐行预检多算一轮 hash。
      reportMemoryRead(options, {
        phase: 'embedding',
        status: 'stale',
        reason: this.#embeddingStore ? 'no-stored-vectors' : 'no-embedding-store',
      });
    } else if (this.#embeddingFn) {
      const embeddingFn = this.#embeddingFn;
      const result = await readMemoryValue(
        (signal) => embeddingFn(query, { abortSignal: signal, inputKind: 'query' }),
        options
      );
      if (result.status === 'ok' && isMemoryVector(result.value)) {
        queryVec = result.value;
      } else {
        reportMemoryRead(options, {
          phase: 'embedding',
          status: result.status === 'ok' ? 'invalid' : result.status,
          reason: 'lexical-fallback',
        });
        if (result.status === 'aborted') {
          return [];
        }
      }
      // embedding 等待期间，原记忆可能被更新、删除或过期；排序使用重新确认的事实。
      all = this.#store.getAllActive({ source, type });
    }

    const scored = all.map((m) => {
      // Recency: 指数衰减 (半衰期 7 天)
      const lastAccess = m.last_accessed_at
        ? new Date(m.last_accessed_at).getTime()
        : new Date(m.updated_at).getTime();
      const daysSinceAccess = (now - lastAccess) / 86400_000;
      const recency = Number.isFinite(daysSinceAccess)
        ? Math.exp((-Math.max(0, daysSinceAccess) * Math.LN2) / RECENCY_HALF_LIFE_DAYS)
        : 0;

      // Importance: 归一化到 0-1
      const importance = (m.importance || 5) / 10;

      // Relevance: 词汇相关性 (lexical)
      const lexicalRelevance = MemoryRetriever.#computeRelevance(
        lowerQuery,
        queryTokens,
        m.content
      );

      // 向量相关性: 从 embeddingStore 查找 embedding 做余弦相似度。
      // 没有 query 向量（未配置、已跳过或嵌入失败）时存储向量无从比较，
      // 不再逐行做正文 sha256 校验，也不产生逐行 content-version-mismatch 噪声。
      const deserialized = MemoryStore.deserialize(m);
      let vectorRelevance = 0;
      const storedEmbedding = queryVec
        ? (this.#embeddingStore?.get(m.id, m.content) ?? null)
        : null;
      const usableVector = queryVec && isMemoryVector(storedEmbedding, queryVec.length);
      if (queryVec && storedEmbedding && !usableVector) {
        reportMemoryRead(options, {
          phase: 'embedding',
          status: 'invalid',
          reason: 'stored-vector-dimension-mismatch',
        });
      }
      if (queryVec && storedEmbedding && usableVector) {
        vectorRelevance = Math.max(0, cosineSimilarity(queryVec, storedEmbedding));
      }

      // 混合相关性: 有向量时 0.6 * vector + 0.4 * lexical，否则纯 lexical
      const relevance = usableVector
        ? 0.6 * vectorRelevance + 0.4 * lexicalRelevance
        : lexicalRelevance;

      const score =
        WEIGHT_RECENCY * recency + WEIGHT_IMPORTANCE * importance + WEIGHT_RELEVANCE * relevance;

      return {
        ...deserialized,
        _score: score,
        _recency: recency,
        _relevance: relevance,
      };
    });

    scored.sort((a, b) => b._score - a._score);

    return scored.slice(0, Math.floor(limit));
  }

  /** 简单文本搜索 (不打分, 用于去重检查) */
  search(content: string, { limit = 5 } = {}): DeserializedMemory[] {
    const results = this.#store.findSimilar(content, null, limit);
    return results.map((r) => MemoryStore.deserialize(r));
  }

  // ═══════════════════════════════════════════════════════════
  // Prompt 生成 (预算感知)
  // ═══════════════════════════════════════════════════════════

  /**
   * 生成供系统提示词的记忆摘要 (预算感知)
   *
   * @returns Markdown 格式
   */
  async toPromptSection(options: PromptSectionOptions = {}): Promise<string> {
    const { source, query, limit = 15, tokenBudget } = options;
    const budget = tokenBudget ?? Infinity;
    if (budget <= 0 || Number.isNaN(budget) || options.abortSignal?.aborted) {
      return '';
    }

    let memories: DeserializedMemory[];

    if (query) {
      memories = await this.#rank(query, { ...options, limit, source });
    } else {
      // 无 query 时按“重要性为主、有界热度为辅”排序；下方会对实际注入的行 touchAccess，
      // 热度若无上限就会自我强化成固定 top-N，挤掉后加入的高重要性记忆。
      memories = this.#store
        .getAllActive({ source })
        .map((row) => ({ row, score: MemoryRetriever.#noQueryScore(row) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ row }) => MemoryStore.deserialize(row));
    }

    if (memories.length === 0) {
      return '';
    }

    const now = Date.now();
    const lines = memories.map((m) => {
      const badge = m.importance >= 8 ? '⚠️' : m.importance >= 5 ? '📌' : '💡';
      // CG-1：>7 天召回记忆加软前缀，提示对照当前源码核实；新鲜记忆不加噪。
      const stale = MemoryRetriever.#stalenessPrefix(m, now);
      return { id: m.id, text: `- ${badge} ${stale}[${m.type}] ${m.content}` };
    });

    const render = (selected: string[]) =>
      `\n## 项目记忆 (${selected.length} 条最相关)\n${selected.join('\n')}\n`;
    const selected: string[] = [];
    for (const line of lines) {
      if (options.abortSignal?.aborted) {
        return '';
      }
      if (estimateTokens(render([...selected, line.text])) <= budget) {
        selected.push(line.text);
        // 只为实际注入上下文的记忆计访问；召回但被预算丢弃不应人为抬升热度。
        this.#store.touchAccess(line.id);
      }
    }
    return selected.length > 0 ? render(selected) : '';
  }

  // ═══════════════════════════════════════════════════════════
  // Memory.js 兼容层
  // ═══════════════════════════════════════════════════════════

  /** 兼容 Memory.load() — 返回最近 N 条记忆 */
  load(limit = 20, { source }: LoadOptions = {}) {
    const rows = this.#store
      .getAllActive({ source })
      .sort((a, b) => {
        const tA = new Date(a.updated_at).getTime();
        const tB = new Date(b.updated_at).getTime();
        return tB - tA;
      })
      .slice(0, limit);
    return rows.map((r) => ({
      ts: r.updated_at,
      type: r.type,
      content: r.content,
      source: r.source,
      importance: r.importance,
    }));
  }

  /** 兼容 Memory.append() — 添加一条记忆 (自动去重) */
  append(entry: AppendEntry) {
    const content = (entry.content || '').trim().substring(0, 500);
    if (!content) {
      return;
    }

    // 去重: 检查是否已有高相似度记忆。
    // 候选窗口覆盖容量内全部活跃行：默认的“最近 50 行”会让超过 50 条后的旧同义记忆被重复写入（C29）。
    const similar = this.#store.findSimilar(content, entry.type ?? null, 1, {
      candidateWindow: MEMORY_STORE_MAX_MEMORIES,
    });
    if (similar.length > 0 && (similar[0].similarity ?? 0) >= SIMILARITY_UPDATE) {
      if (entry.importance !== undefined && entry.importance > (similar[0].importance ?? 5)) {
        this.#store.update(similar[0].id, { importance: entry.importance });
      }
      this.#store.touchAccess(similar[0].id);
      return;
    }

    this.#store.add({
      type: entry.type || 'context',
      content,
      source: entry.source || 'user',
      importance: entry.importance ?? 5,
      ttlDays: entry.ttl || null,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 向量嵌入接口
  // ═══════════════════════════════════════════════════════════

  /** 设置向量嵌入函数 */
  setEmbeddingFunction(fn: EmbeddingFn | null) {
    this.#embeddingFn = typeof fn === 'function' ? fn : null;
  }

  /** 获取当前嵌入函数 */
  getEmbeddingFunction(): EmbeddingFn | null {
    return this.#embeddingFn;
  }

  /**
   * 为所有缺少 embedding 的记忆批量生成向量嵌入
   * @param batchSize 每批数量 (默认 20)
   * @returns 成功嵌入的记忆数
   */
  async embedAllMemories(batchSize = 20, options: MemoryReadOptions = {}): Promise<number> {
    if (
      !this.#embeddingFn ||
      !this.#embeddingStore ||
      options.abortSignal?.aborted ||
      !Number.isFinite(batchSize) ||
      batchSize <= 0
    ) {
      return 0;
    }

    // 从 MemoryStore 获取所有活跃记忆 ID，找出 embeddingStore 中缺失的
    const allActive = this.#store.getAllActive();
    const missingIds = allActive
      .filter((memory) => !this.#embeddingStore?.get(memory.id, memory.content))
      .map((memory) => memory.id);
    if (missingIds.length === 0) {
      return 0;
    }

    // 取前 batchSize 条
    const batch = missingIds.slice(0, Math.floor(batchSize));
    const contentMap = new Map(allActive.map((m) => [m.id, m.content]));
    const deadlineAt = memoryReadDeadline(options);
    const embeddingFn = this.#embeddingFn;

    const entries: Array<{ id: string; embedding: number[]; content: string }> = [];
    for (const id of batch) {
      const content = contentMap.get(id);
      if (!content) {
        continue;
      }
      const result = await readMemoryValue(
        (signal) => embeddingFn(content, { abortSignal: signal, inputKind: 'document' }),
        { ...options, deadlineAt }
      );
      if (result.status === 'ok' && isMemoryVector(result.value)) {
        entries.push({ id, embedding: result.value, content });
      } else {
        reportMemoryRead(options, {
          phase: 'backfill',
          status: result.status === 'ok' ? 'invalid' : result.status,
          reason: 'embedding-not-written',
        });
        if (result.status === 'aborted') {
          return 0;
        }
        if (result.status === 'timeout') {
          break;
        }
      }
    }

    if (entries.length === 0) {
      return 0;
    }

    if (options.abortSignal?.aborted) {
      return 0;
    }
    // 最后一次 await 后重新核对整个批次；早先成功的内容也可能已被后续操作修改。
    const currentEntries = entries.filter((entry) => {
      const current = this.#store.get(entry.id);
      const valid =
        current?.content === entry.content &&
        (!current.expiresAt || new Date(current.expiresAt).getTime() > Date.now());
      if (!valid) {
        reportMemoryRead(options, {
          phase: 'backfill',
          status: 'stale',
          reason: 'source-changed-before-write',
        });
      }
      return valid;
    });
    if (options.abortSignal?.aborted) {
      return 0;
    }
    return this.#embeddingStore.batchSet(currentEntries);
  }

  /**
   * 使用嵌入函数计算语义相关性 (余弦相似度)
   * @param query 查询文本
   * @param content 记忆内容
   * @returns 相似度分数 或 null
   */
  async computeEmbeddingRelevance(
    query: string,
    content: string,
    options: MemoryReadOptions = {}
  ): Promise<number | null> {
    if (!this.#embeddingFn) {
      return null;
    }
    const embeddingFn = this.#embeddingFn;
    const result = await readMemoryValue(
      (signal) =>
        Promise.all([
          embeddingFn(query, { abortSignal: signal, inputKind: 'query' }),
          embeddingFn(content, { abortSignal: signal, inputKind: 'document' }),
        ]),
      options
    );
    if (
      result.status === 'ok' &&
      isMemoryVector(result.value[0]) &&
      isMemoryVector(result.value[1], result.value[0].length)
    ) {
      return cosineSimilarity(result.value[0], result.value[1]);
    }
    reportMemoryRead(options, {
      phase: 'embedding',
      status: result.status === 'ok' ? 'invalid' : result.status,
      reason: 'similarity-unavailable',
    });
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // Private: 召回记忆陈旧度（render-only，CG-1）
  // ═══════════════════════════════════════════════════════════

  /**
   * 单条召回记忆陈旧软前缀（render-only，CG-1）。
   * 陷阱钉死：age 从 camelCase m.updatedAt（回退 m.lastAccessedAt）算 —— builder 喂入的是
   * DeserializedMemory，绝不能用 raw row snake_case（那会 undefined → NaN）。
   * 无效/缺失时间戳 → 显式 return ''（unknown-age 不标注，不把 NaN 当"很旧"，不抛错）。
   */
  static #stalenessPrefix(m: DeserializedMemory, now: number): string {
    const stamp = m.updatedAt || m.lastAccessedAt; // 优先 updatedAt，空才看 lastAccessedAt
    const ts = stamp ? new Date(stamp).getTime() : Number.NaN;
    if (Number.isNaN(ts)) {
      return ''; // unknown-age：不标注
    }
    const ageDays = (now - ts) / 86400_000;
    return ageDays > STALE_MEMORY_DAYS ? STALE_MEMORY_PREFIX : '';
  }

  // ═══════════════════════════════════════════════════════════
  // Private: 无 query 排序（有界热度）
  // ═══════════════════════════════════════════════════════════

  /** importance 归一化为主项；access_count 经 log1p 压缩并封顶，非法或负值按 0 计。 */
  static #noQueryScore(m: MemoryRow): number {
    const importance = (m.importance || 5) / 10;
    const accessCount =
      typeof m.access_count === 'number' && Number.isFinite(m.access_count)
        ? Math.max(0, m.access_count)
        : 0;
    const heat = Math.min(1, Math.log1p(accessCount) / Math.log1p(HEAT_SATURATION_ACCESS_COUNT));
    return importance + NO_QUERY_HEAT_MAX_BONUS * heat;
  }

  // ═══════════════════════════════════════════════════════════
  // Private: 相关性计算
  // ═══════════════════════════════════════════════════════════

  static #computeRelevance(lowerQuery: string, queryTokens: Set<string>, content: string): number {
    if (!lowerQuery || !content) {
      return 0;
    }

    const lowerContent = content.toLowerCase();
    const contentTokens = MemoryRetriever.#tokenizeWords(lowerContent);
    if (queryTokens.size === 0) {
      return 0;
    }

    let matchCount = 0;
    for (const t of queryTokens) {
      if (contentTokens.has(t)) {
        matchCount++;
      }
    }
    const tokenOverlap = matchCount / queryTokens.size;
    const substringMatch = lowerContent.includes(lowerQuery) ? 0.4 : 0;

    let partialMatch = 0;
    for (const qt of queryTokens) {
      if (qt.length >= 3 && lowerContent.includes(qt)) {
        partialMatch += 0.1;
      }
    }
    partialMatch = Math.min(0.3, partialMatch);

    return Math.min(1.0, tokenOverlap * 0.5 + substringMatch + partialMatch);
  }

  static #tokenizeWords(text: string): Set<string> {
    if (!text) {
      return new Set();
    }
    return new Set(
      text
        .split(/[\s,;:!?。，；：！？\-_/\\|()[\]{}'"<>]+/)
        .filter((t) => t.length >= 2)
        .map((t) => t.toLowerCase())
    );
  }
}
