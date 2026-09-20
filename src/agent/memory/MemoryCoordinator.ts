/**
 * MemoryCoordinator — 记忆系统统一协调器
 *
 * 设计原则 (CoALA / MemGPT / Generative Agents / Mem0):
 *   - Single Coordinator: 所有记忆操作通过此模块路由
 *   - Budget-Aware Injection: 记忆注入受统一 token 预算管控
 *   - Extract-Update Write Path: 写入经去重/合并/冲突解决
 *   - Graceful Degradation: 任意子系统故障不影响核心执行
 *
 * 生命周期:
 *   - Bootstrap 模式: 会话级 (orchestrator 创建, 贯穿所有维度)
 *   - User Chat 模式: 实例级 (AgentRuntime 创建)
 *
 * @module MemoryCoordinator
 */

import Logger from '@alembic/core/logging';
import { estimateTokens, truncateToTokenBudget } from '#shared/tokenUtils.js';
import { ActiveContext } from './ActiveContext.js';
import {
  allocateMemoryBudget,
  DEFAULT_MEMORY_BUDGET,
  type MemoryBudgetAllocation,
  type MemoryMode,
  type MemoryPromptPort,
  projectMemorySection,
  readPersistentMemorySection,
} from './MemoryPrompt.js';
import { type MemoryReadOptions, reportMemoryRead } from './MemoryReadPolicy.js';
import type { DimensionReportInput, SessionStore } from './SessionStore.js';

// ── 类型定义 ──

/** PersistentMemory 接口 (声明式) */
interface PersistentMemoryLike extends MemoryPromptPort {
  append(entry: { type: string; content: string; source: string; importance: number }): void;
}

/** ConversationStore 接口 (声明式) */
interface ConversationStoreLike {
  load(conversationId: string, opts?: { tokenBudget?: number }): unknown[];
  summarize(conversationId: string, opts?: { aiProvider?: unknown }): Promise<unknown>;
}

/** AiProvider 接口 (声明式) */
interface AiProviderLike {
  [key: string]: unknown;
}

/** 预算分配结构 */
type BudgetAllocation = MemoryBudgetAllocation;
interface MemoryPromptSnapshot {
  mode: MemoryMode;
  allocation: BudgetAllocation;
  surplus: number;
}

/** MemoryCoordinator 构造选项 */
export interface MemoryCoordinatorConfig {
  persistentMemory?: PersistentMemoryLike | null;
  sessionStore?: SessionStore | null;
  conversationLog?: ConversationStoreLike | null;
  mode?: 'user' | 'bootstrap';
  totalMemoryBudget?: number;
}

/** 静态记忆 Prompt 选项 */
export interface StaticMemoryOptions extends MemoryReadOptions {
  mode?: 'user' | 'analyst' | 'producer';
  taskContext?: string;
  currentDimId?: string;
  focusKeywords?: string[];
  scopeId?: string;
}

/** 维度 scope 配置 */
export interface DimensionScopeConfig {
  lightweight?: boolean;
  maxRecentRounds?: number;
}

export interface MemoryNoteFindingResult {
  recorded: boolean;
  target: 'activeContext' | 'missing-active-context' | 'error';
  importance: number;
  message: string;
  scratchpadSize?: number;
  scopeId?: string;
}

export interface MemoryEvidenceSearchHit {
  filePath: string;
  evidence: { dimId?: string; importance?: number; finding: string };
}

export interface MemoryEvidenceSearchDiagnostic {
  code: 'MEMORY_EVIDENCE_STORE_MISSING' | 'MEMORY_EVIDENCE_SEARCH_FAILED';
  reason: 'session-store-missing' | 'memory-evidence-search-failed';
  message: string;
  query: string;
  dimId?: string;
}

export interface MemoryEvidenceSearchResult {
  ok: boolean;
  degraded: boolean;
  reason: 'session-store-missing' | 'memory-evidence-search-failed' | null;
  results: MemoryEvidenceSearchHit[];
  diagnostics: MemoryEvidenceSearchDiagnostic[];
}

export interface MemoryWriteFailureDiagnostic {
  code: 'MEMORY_STORE_WRITE_FAILED' | 'MEMORY_COORDINATOR_WRITE_FAILED';
  message: string;
  operation: 'persistentMemory.append';
}

// ── 预算分配策略 (§4.1) ──

// ── 写入路由: 规则匹配模式 ──

const PREFERENCE_PATTERNS = [
  /我们(项目|团队)?(不用|不使用|禁止|避免|偏好|习惯|规范是)/,
  /以后(都|请|要)/,
  /记住/,
  /we\s+(don'?t|never|always|prefer|avoid)\s+use/i,
  /remember\s+(to|that)/i,
  /our\s+(convention|standard|rule)\s+is/i,
];

const DECISION_PATTERNS = [
  /决定(了|用|采用|使用)/,
  /(确认|同意|通过)(了|这个方案|审核)/,
  /就(这样|这么)(做|定|办)/,
  /let'?s\s+(go\s+with|use|adopt)/i,
  /approved|confirmed|decided/i,
];

const MEMORY_TAG_REGEX = /\[MEMORY:(\w+)\]\s*([\s\S]*?)\s*\[\/MEMORY\]/g;

export class MemoryCoordinator {
  _lastSurplus = 0;
  // ── Config ──
  #mode: 'user' | 'bootstrap';
  #allocationMode: 'user' | 'analyst' | 'producer' = 'analyst';
  #totalBudget: number;
  #budgetAllocation: BudgetAllocation;
  /** 每次静态装配持有自己的预算快照；不同 scope 的异步完成不能改写彼此。 */
  #promptBudgets = new Map<string, MemoryPromptSnapshot>();

  // ── Tier 3: Persistent (跨会话) ──
  #persistentMemory: PersistentMemoryLike | null;
  #conversationLog: ConversationStoreLike | null;

  // ── Tier 2: Session (会话级) ──
  #sessionStore: SessionStore | null;

  // ── Tier 1: Dimension (维度级) ──
  #activeContexts: Map<string, ActiveContext>;
  #currentScopeId: string | null;

  #logger: ReturnType<typeof Logger.getInstance>;
  #completedScopes: Set<string>;
  #writeFailures: MemoryWriteFailureDiagnostic[] = [];

  /**
   * @param [config.persistentMemory] PersistentMemory 实例
   * @param [config.sessionStore] SessionStore 实例 (bootstrap 模式)
   * @param [config.conversationLog] ConversationStore 实例
   * @param [config.totalMemoryBudget=4000] 记忆 section 的 token 总预算
   */
  constructor(config: MemoryCoordinatorConfig = {}) {
    this.#persistentMemory = config.persistentMemory || null;
    this.#sessionStore = config.sessionStore || null;
    this.#conversationLog = config.conversationLog || null;
    this.#mode = config.mode || 'bootstrap';
    this.#totalBudget = config.totalMemoryBudget ?? DEFAULT_MEMORY_BUDGET;

    this.#activeContexts = new Map<string, ActiveContext>();
    this.#currentScopeId = null;
    this.#completedScopes = new Set<string>();

    this.#budgetAllocation = {
      activeContext: 0,
      sessionStore: 0,
      persistentMemory: 0,
      conversationLog: 0,
    };
    this.#logger = Logger.getInstance();

    // 应用默认预算
    this.allocateBudget(this.#mode === 'user' ? 'user' : 'analyst');
  }

  // ═══════════════════════════════════════════════════════════
  // 预算管理
  // ═══════════════════════════════════════════════════════════

  /**
   * 配置总预算 (由 AgentRuntime.execute 入口调用)
   * @param options.totalContextBudget 模型总上下文 token 数
   */
  configure({ totalContextBudget, model }: { totalContextBudget?: number; model?: string } = {}) {
    if (totalContextBudget !== undefined) {
      // 记忆 section 约占总上下文的 12.5%
      this.#totalBudget = Math.round(totalContextBudget * 0.125);
      this.allocateBudget(this.#allocationMode);
    }
  }

  /**
   * 按模式分配预算
   * @param [totalTokens] 覆盖总预算
   */
  allocateBudget(mode: 'user' | 'analyst' | 'producer', totalTokens?: number) {
    this.#allocationMode = mode;
    this._lastSurplus = 0;
    if (totalTokens !== undefined) {
      this.#totalBudget = totalTokens;
    }
    this.#budgetAllocation = allocateMemoryBudget(mode, this.#totalBudget);
    this.#totalBudget = Object.values(this.#budgetAllocation).reduce(
      (sum, value) => sum + value,
      0
    );
    this.#promptBudgets.clear();
  }

  getTotalBudget() {
    return this.#totalBudget;
  }

  getBudgetAllocation() {
    return { ...this.#budgetAllocation };
  }

  /**
   * 获取消息缓冲区可用预算 (F2)
   * @param totalContextBudget 模型总上下文 token
   */
  getMessageBudget(
    totalContextBudget: number,
    systemPromptEstimate = 2000,
    toolSchemaEstimate = 3000,
    safetyMargin = 3000
  ) {
    return (
      totalContextBudget -
      this.#totalBudget -
      systemPromptEstimate -
      toolSchemaEstimate -
      safetyMargin
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 读取 (Prompt 构建)
  // ═══════════════════════════════════════════════════════════

  /**
   * 构建静态记忆 prompt (execute 入口调用一次)
   * 包含: PersistentMemory + ConversationLog + SessionStore 上下文
   *
   * @param [options.mode] 'user' | 'analyst' | 'producer'
   * @param [options.taskContext] 当前任务描述 (用于 relevance 打分)
   * @param [options.currentDimId] 当前维度 (用于 SessionStore 过滤)
   * @param [options.focusKeywords] 聚焦关键词
   */
  async buildStaticMemoryPrompt(options: StaticMemoryOptions = {}): Promise<string> {
    return (await this.#assembleStaticPrompt(options, this.#totalBudget)).content;
  }

  async #assembleStaticPrompt(
    options: StaticMemoryOptions,
    totalBudget: number
  ): Promise<{ content: string; snapshot: MemoryPromptSnapshot }> {
    const mode = options.mode ?? this.#allocationMode;
    const allocation = allocateMemoryBudget(mode, totalBudget);
    const snapshot = { mode, allocation, surplus: 0 };
    if (options.abortSignal?.aborted) {
      return { content: '', snapshot };
    }
    const key = options.scopeId ?? '';
    this.#promptBudgets.set(key, snapshot);
    let sessionText = '';
    if (allocation.sessionStore > 0) {
      try {
        sessionText = this.#buildSessionStoreSection(options, allocation.sessionStore);
      } catch (err: unknown) {
        reportMemoryRead(options, {
          phase: 'session',
          status: 'error',
          reason: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
    const session = projectMemorySection('session', sessionText, allocation.sessionStore, options);
    const persistent = await readPersistentMemorySection(this.#persistentMemory, {
      ...options,
      source: 'user',
      query: options.taskContext,
      tokenBudget: allocation.persistentMemory,
    });
    if (options.abortSignal?.aborted) {
      return { content: '', snapshot };
    }
    const text = [persistent.content, session.content].filter(Boolean).join('\n');
    const staticBudget =
      allocation.persistentMemory + allocation.sessionStore + allocation.conversationLog;
    const content = truncateToTokenBudget(text, staticBudget);
    // 分隔符也计入余量；历史 _lastSurplus 仅作为观测兼容面，不再决定其它 scope 的配额。
    snapshot.surplus = Math.max(0, staticBudget - estimateTokens(content));
    if (this.#promptBudgets.get(key) === snapshot) {
      this._lastSurplus = snapshot.surplus;
    }
    return { content, snapshot };
  }

  /**
   * 构建动态记忆 prompt (每轮调用)
   * 包含: ActiveContext / WorkingMemory 上下文
   */
  buildDynamicMemoryPrompt(options: StaticMemoryOptions = {}): string {
    const snapshot = this.#promptBudgets.get(options.scopeId ?? '');
    const mode = options.mode ?? snapshot?.mode ?? this.#allocationMode;
    const sameMode = snapshot?.mode === mode;
    const allocation = sameMode
      ? snapshot.allocation
      : allocateMemoryBudget(mode, this.#totalBudget);
    return this.#dynamicPromptForBudget(
      options,
      allocation.activeContext + (sameMode ? snapshot.surplus : 0)
    );
  }

  #dynamicPromptForBudget(options: StaticMemoryOptions, acBudget: number): string {
    try {
      if (options.abortSignal?.aborted) {
        return '';
      }
      if (acBudget <= 0) {
        return '';
      }

      const ac = options.scopeId
        ? this.getActiveContext(options.scopeId)
        : this.#getCurrentActiveContext();
      if (!ac) {
        return '';
      }

      return projectMemorySection('working', ac.buildContext(acBudget) || '', acBudget, options)
        .content;
    } catch (err: unknown) {
      this.#logger.warn(
        `[MemoryCoordinator] buildDynamicMemoryPrompt error: ${(err as Error).message}`
      );
      return '';
    }
  }

  /** 合并构建完整记忆 prompt (便捷方法) */
  async buildMemoryPrompt(options: StaticMemoryOptions = {}): Promise<string> {
    const totalBudget = this.#totalBudget;
    const { content, snapshot } = await this.#assembleStaticPrompt(options, totalBudget);
    const dynamicPart = this.#dynamicPromptForBudget(
      options,
      snapshot.allocation.activeContext + snapshot.surplus
    );
    return truncateToTokenBudget([content, dynamicPart].filter(Boolean).join('\n'), totalBudget);
  }

  // ═══════════════════════════════════════════════════════════
  // 写入
  // ═══════════════════════════════════════════════════════════

  /**
   * 记录工具调用观察 (合并 WM.observe + TRC.set)
   * @param round 当前迭代轮次
   * @param [cacheHit=false] 本次是否缓存命中
   */
  recordObservation(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    round: number,
    cacheHit = false
  ) {
    try {
      // ActiveContext 的数据记录由 trace.recordToolCall() 处理，
      // 此处只处理缓存写入。

      // 委托给 SessionStore 缓存
      if (!cacheHit && this.#sessionStore) {
        this.#sessionStore.cacheToolResult(toolName, args, result);
      }
    } catch (err: unknown) {
      this.#logger.warn(`[MemoryCoordinator] recordObservation error: ${(err as Error).message}`);
    }
  }

  /**
   * 记录关键发现 (从 note_finding handler 调用)
   * @param importance 1-10
   * @param [scopeId] 显式指定 scope (并行安全)
   * @returns 结构化写入结果；只有 recorded=true 才能被 QualityGate 计入 note_finding
   */
  noteFinding(
    finding: string,
    evidence: string,
    importance: number,
    round: number,
    scopeId?: string,
    evidenceRefs?: string[]
  ): MemoryNoteFindingResult {
    try {
      const ac = scopeId ? this.getActiveContext(scopeId) : this.#getCurrentActiveContext();
      if (ac) {
        ac.noteKeyFinding(finding, evidence, importance, round, evidenceRefs);
        return {
          recorded: true,
          target: 'activeContext',
          importance,
          message: `📌 已记录发现 [${importance}/10]: "${finding.substring(0, 80)}" — 当前共 ${ac.scratchpadSize} 条关键发现`,
          scratchpadSize: ac.scratchpadSize,
          ...(scopeId ? { scopeId } : {}),
        };
      }
      return {
        recorded: false,
        target: 'missing-active-context',
        importance,
        message: '工作记忆未初始化，note_finding 未写入 ActiveContext',
        ...(scopeId ? { scopeId } : {}),
      };
    } catch (err: unknown) {
      this.#logger.warn(`[MemoryCoordinator] noteFinding error: ${(err as Error).message}`);
      return {
        recorded: false,
        target: 'error',
        importance,
        message: `记录发现失败: ${(err as Error).message}`,
        ...(scopeId ? { scopeId } : {}),
      };
    }
  }

  /**
   * 从对话中提取记忆
   *
   * 写入路由 (WriteRouter):
   *   - 规则 1: 只在 user 源触发规则匹配 (B4 fix)
   *   - 规则 2: [MEMORY] 标签提取 (所有源)
   *
   * @param prompt 用户输入
   * @param reply AI 回复
   */
  extractFromConversation(prompt: string, reply: string, source: 'user' | 'system') {
    // §7.6 step 4: 只写 PersistentMemory (不再双写 Memory.js)
    if (!this.#persistentMemory) {
      return;
    }

    try {
      // ── 层 1: 规则快速匹配 (仅 user 源) ──
      if (source === 'user') {
        if (PREFERENCE_PATTERNS.some((p) => p.test(prompt))) {
          this.#persistentMemory.append({
            type: 'preference',
            content: prompt.substring(0, 200),
            source,
            importance: 5,
          });
        }

        if (DECISION_PATTERNS.some((p) => p.test(prompt))) {
          this.#persistentMemory.append({
            type: 'fact',
            content: prompt.substring(0, 200),
            source,
            importance: 7,
          });
        }
      }

      // ── 层 2: [MEMORY] 标签提取 (所有源) ──
      if (reply) {
        const regex = new RegExp(MEMORY_TAG_REGEX.source, MEMORY_TAG_REGEX.flags);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(reply)) !== null) {
          const type = match[1];
          const content = match[2].trim();
          if (content && ['preference', 'decision', 'context'].includes(type)) {
            this.#persistentMemory.append({
              type: type === 'decision' ? 'fact' : type === 'context' ? 'fact' : type,
              content: content.substring(0, 200),
              source,
              importance: type === 'decision' ? 7 : 5,
            });
          }
        }
      }
    } catch (err: unknown) {
      this.#recordMemoryWriteFailure(err, 'persistentMemory.append');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 缓存代理 (委托到 SessionStore / legacy ToolResultCache)
  // ═══════════════════════════════════════════════════════════

  /** 获取缓存的工具结果 */
  getCachedResult(toolName: string, args: Record<string, unknown>): unknown | null {
    try {
      return this.#sessionStore?.getCachedResult(toolName, args) ?? null;
    } catch {
      return null;
    }
  }

  /** 缓存工具结果 */
  cacheToolResult(toolName: string, args: Record<string, unknown>, result: unknown) {
    try {
      this.#sessionStore?.cacheToolResult(toolName, args, result);
    } catch {
      /* non-critical */
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 维度生命周期
  // ═══════════════════════════════════════════════════════════

  /**
   * 创建维度作用域 (D2/D3: 多 scope 支持)
   *
   * @param scopeId 如 'api-patterns:analyst', 'api-patterns:producer'
   * @param [config.lightweight=false] 轻量模式 (User Chat)
   * @returns WorkingMemory (Phase 2) / ActiveContext (Phase 3)
   */
  createDimensionScope(scopeId: string, config: DimensionScopeConfig = {}): ActiveContext {
    this.#promptBudgets.delete(scopeId);
    this.#currentScopeId = scopeId;

    // Phase 3: 创建 ActiveContext 实例
    const ac = new ActiveContext({
      lightweight: config.lightweight || false,
      maxRecentRounds: config.maxRecentRounds || 3,
    });
    this.#activeContexts.set(scopeId, ac);
    this.#logger.debug(`[MemoryCoordinator] scope created: ${scopeId} (ActiveContext)`);
    return ac;
  }

  /**
   * 完成维度: 蒸馏 + 存储到 SessionStore
   * @param [report] 附加报告数据
   */
  completeDimension(scopeId: string, report?: DimensionReportInput) {
    this.#promptBudgets.delete(scopeId);
    try {
      const ac = this.#activeContexts.get(scopeId);
      const distilled = ac ? ac.distill() : null;

      if (distilled && this.#sessionStore && report) {
        this.#sessionStore.storeDimensionReport(scopeId.replace(/:.*$/, ''), {
          ...report,
          workingMemoryDistilled: distilled,
        });
      }

      // 清理 ActiveContext
      if (ac) {
        ac.clear();
        this.#activeContexts.delete(scopeId);
      }
      this.#completedScopes.add(scopeId);

      // 切换当前 scope 到下一个或清空
      if (this.#currentScopeId === scopeId) {
        this.#currentScopeId = null;
      }
      this.#logger.debug(`[MemoryCoordinator] scope completed: ${scopeId}`);
    } catch (err: unknown) {
      this.#logger.warn(`[MemoryCoordinator] completeDimension error: ${(err as Error).message}`);
    }
  }

  /**
   * 完成会话: 触发 Consolidator
   * @returns |null>}
   */
  async completeSession(): Promise<{ consolidated: number } | null> {
    try {
      this.#currentScopeId = null;
      this.#logger.info('[MemoryCoordinator] session completed');
      return { consolidated: 0 };
    } catch (err: unknown) {
      this.#logger.warn(`[MemoryCoordinator] completeSession error: ${(err as Error).message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════════════════════════

  /** 获取当前或指定 scope 的 ActiveContext / WorkingMemory */
  getActiveContext(scopeId?: string): ActiveContext | null {
    const id = scopeId || this.#currentScopeId;
    if (!id) {
      return null;
    }
    return this.#activeContexts.get(id) || null;
  }

  /** 获取 SessionStore */
  getSessionStore() {
    return this.#sessionStore || null;
  }

  /** 检索前序维度的代码证据 — V2 memory.get_previous_evidence 桥接 */
  searchEvidence(query: string, dimId?: string): MemoryEvidenceSearchHit[] {
    return this.searchEvidenceWithDiagnostics(query, dimId).results;
  }

  /** 检索前序维度代码证据，并在读路径降级时返回稳定诊断。 */
  searchEvidenceWithDiagnostics(query: string, dimId?: string): MemoryEvidenceSearchResult {
    if (!this.#sessionStore) {
      return {
        ok: true,
        degraded: true,
        reason: 'session-store-missing',
        results: [],
        diagnostics: [
          {
            code: 'MEMORY_EVIDENCE_STORE_MISSING',
            reason: 'session-store-missing',
            message: 'SessionStore is not configured; previous evidence search is degraded.',
            query,
            ...(dimId ? { dimId } : {}),
          },
        ],
      };
    }
    try {
      return {
        ok: true,
        degraded: false,
        reason: null,
        results: this.#sessionStore.searchEvidence(query, dimId),
        diagnostics: [],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.warn(
        `[MemoryCoordinator] searchEvidence degraded (MEMORY_EVIDENCE_SEARCH_FAILED): ${message}`
      );
      return {
        ok: false,
        degraded: true,
        reason: 'memory-evidence-search-failed',
        results: [],
        diagnostics: [
          {
            code: 'MEMORY_EVIDENCE_SEARCH_FAILED',
            reason: 'memory-evidence-search-failed',
            message,
            query,
            ...(dimId ? { dimId } : {}),
          },
        ],
      };
    }
  }

  /** 获取 PersistentMemory */
  getPersistentMemory() {
    return this.#persistentMemory || null;
  }

  /** 获取 ConversationLog / ConversationStore */
  getConversationLog() {
    return this.#conversationLog || null;
  }

  getDiagnostics(): { writeFailures: MemoryWriteFailureDiagnostic[] } {
    return { writeFailures: this.#writeFailures.map((entry) => ({ ...entry })) };
  }

  // ═══════════════════════════════════════════════════════════
  // 自动摘要 (F23)
  // ═══════════════════════════════════════════════════════════

  /** 对话更新后触发自动摘要 */
  async onConversationUpdated(conversationId: string, aiProvider: AiProviderLike | null) {
    if (!this.#conversationLog || !aiProvider) {
      return;
    }
    try {
      const messages = this.#conversationLog.load(conversationId, { tokenBudget: Infinity });
      if (messages.length >= 12) {
        await this.#conversationLog.summarize(conversationId, { aiProvider });
      }
    } catch {
      // 摘要失败不影响主流程
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 断点续传
  // ═══════════════════════════════════════════════════════════

  /** 保存 checkpoint */
  async checkpoint(projectRoot: string) {
    try {
      if (this.#sessionStore?.saveCheckpoint) {
        await this.#sessionStore.saveCheckpoint(projectRoot);
      }
    } catch (err: unknown) {
      this.#logger.warn(`[MemoryCoordinator] checkpoint error: ${(err as Error).message}`);
    }
  }

  /** 恢复 checkpoint */
  async restore(projectRoot: string): Promise<boolean> {
    try {
      if (this.#sessionStore?.loadCheckpoint) {
        return await this.#sessionStore.loadCheckpoint(projectRoot);
      }
      return false;
    } catch (err: unknown) {
      this.#logger.warn(`[MemoryCoordinator] restore error: ${(err as Error).message}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 清理
  // ═══════════════════════════════════════════════════════════

  dispose() {
    this.#promptBudgets.clear();
    this._lastSurplus = 0;
    for (const ac of this.#activeContexts.values()) {
      try {
        ac.clear();
      } catch {
        /* non-critical */
      }
    }
    this.#activeContexts.clear();
    this.#sessionStore = null;
    this.#currentScopeId = null;
    this.#completedScopes.clear();
  }

  // ═══════════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════════

  /** 获取当前 scope 的 ActiveContext */
  #getCurrentActiveContext() {
    if (!this.#currentScopeId) {
      return null;
    }
    return this.#activeContexts.get(this.#currentScopeId) || null;
  }

  #recordMemoryWriteFailure(err: unknown, operation: 'persistentMemory.append'): void {
    const diagnostic: MemoryWriteFailureDiagnostic = {
      code:
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: unknown }).code === 'MEMORY_STORE_WRITE_FAILED'
          ? 'MEMORY_STORE_WRITE_FAILED'
          : 'MEMORY_COORDINATOR_WRITE_FAILED',
      message: err instanceof Error ? err.message : String(err),
      operation,
    };
    this.#writeFailures.push(diagnostic);
    this.#logger.warn(
      `[MemoryCoordinator] ${operation} failed (${diagnostic.code}): ${diagnostic.message}`
    );
  }

  /** 构建 SessionStore section (legacy: EpisodicMemory) */
  #buildSessionStoreSection(options: StaticMemoryOptions, tokenBudget: number): string {
    const ss = this.#sessionStore;
    if (!ss?.buildContextForDimension) {
      return '';
    }

    const dimId = options.currentDimId;
    if (!dimId) {
      return '';
    }

    return (
      ss.buildContextForDimension(dimId, {
        focusKeywords: options.focusKeywords || [],
        tokenBudget,
      }) || ''
    );
  }
}

export default MemoryCoordinator;
