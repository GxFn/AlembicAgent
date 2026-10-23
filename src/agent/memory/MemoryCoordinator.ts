/**
 * MemoryCoordinator — 记忆系统统一协调器
 *
 * 设计原则 (CoALA / MemGPT / Generative Agents / Mem0):
 *   - 协调而非唯一入口: 本类装配运行时记忆 prompt、管理维度 scope 并代理 SessionStore 证据检索；
 *     并非所有记忆读写都经此路由（例如 insightAnalyst 直接经 readPersistentMemorySection
 *     读取 PersistentMemory，持久记忆的去重/合并/冲突解决在 MemoryConsolidator 内完成）
 *   - Budget-Aware Injection: 记忆注入受统一 token 预算管控
 *   - Graceful Degradation: 任意子系统故障不影响核心执行
 *
 * 生命周期:
 *   - Bootstrap 模式: 会话级 (orchestrator 创建, 贯穿所有维度)
 *   - User Chat 模式: 实例级 (AgentRuntime 创建)
 *
 * @module MemoryCoordinator
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
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
  /**
   * 对话日志端口，只供 onConversationUpdated 自动摘要使用。
   * @deprecated src 与宿主构造 MemoryCoordinator 时都不注入；自动摘要端口无生产消费者，
   *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
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
  /**
   * 轻量模式：透传给 ActiveContext（跳过观察滑动窗口与 buildContext 输出）。
   * @deprecated src 与宿主调用 createDimensionScope 都不传，生产恒为 false；
   *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
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

/** catch (err: unknown) 的日志文本：非 Error 的抛出值也要留下可读内容，而不是 "undefined"。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MemoryCoordinator {
  /**
   * 最近一次静态装配（buildStaticMemoryPrompt / buildMemoryPrompt）剩余的预算，仅作观测。
   * @deprecated 无生产读取方，也不决定任何 scope 的配额（配额以各 scope 的预算快照为准）；
   *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
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
  #writeFailures: MemoryWriteFailureDiagnostic[] = [];
  /** session-store-missing 降级每个 coordinator 只 warn 一次，之后记 debug（scan 每次调用都会命中）。 */
  #evidenceStoreMissingWarned = false;

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
   * 按模型总上下文配置记忆总预算（约 12.5%）；model 参数未被使用。
   * @param options.totalContextBudget 模型总上下文 token 数
   * @deprecated AgentRuntime 与宿主都不调用（记忆预算来自构造参数 totalMemoryBudget 与 allocateBudget）；
   *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
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

  /**
   * 当前记忆 section 的 token 总预算。
   * @deprecated 无生产调用方；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  getTotalBudget() {
    return this.#totalBudget;
  }

  /**
   * 当前各层记忆的预算分配副本。
   * @deprecated 无生产调用方；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  getBudgetAllocation() {
    return { ...this.#budgetAllocation };
  }

  /**
   * 获取消息缓冲区可用预算 (F2)
   * @param totalContextBudget 模型总上下文 token
   * @deprecated 无生产调用方（消息预算由 BudgetController 管理）；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
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
   * 构建静态记忆 prompt
   * 包含: PersistentMemory + SessionStore 上下文。不读取 ConversationLog：
   * 分配给 conversationLog 的份额只计入静态预算，未用部分作为 surplus 转给同 mode 的
   * 动态（工作记忆）prompt。
   *
   * @param [options.mode] 'user' | 'analyst' | 'producer'
   * @param [options.taskContext] 当前任务描述 (用于 relevance 打分)
   * @param [options.currentDimId] 当前维度 (用于 SessionStore 过滤)
   * @param [options.focusKeywords] 聚焦关键词
   * @deprecated AgentRuntime 只调用 buildDynamicMemoryPrompt，src 与宿主都不调用本方法
   *   （持久记忆由 insightAnalyst 经 readPersistentMemorySection 直接读取）；
   *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
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
   * 包含: ActiveContext / WorkingMemory 上下文。scopeId 缺省且多 scope 并存时返回 '' 并 warn，
   * 不注入别的维度的工作记忆。
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

      const { ac } = this.#resolveScopedContext(options.scopeId, 'buildDynamicMemoryPrompt');
      if (!ac) {
        return '';
      }

      return projectMemorySection('working', ac.buildContext(acBudget) || '', acBudget, options)
        .content;
    } catch (err: unknown) {
      this.#log('warn', `[MemoryCoordinator] buildDynamicMemoryPrompt error: ${errorMessage(err)}`);
      return '';
    }
  }

  /**
   * 合并构建完整记忆 prompt (便捷方法)
   * @deprecated 无生产调用方；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
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
   * 记录关键发现 (从 note_finding handler 调用)
   * @param importance 1-10
   * @param [scopeId] 显式指定 scope (并行安全)；缺省时只有单 scope 才回退到当前 scope，
   *   多 scope 并存时拒绝写入（recorded=false、target='missing-active-context'）并 warn
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
      const { ac, ambiguousScopes } = this.#resolveScopedContext(scopeId, 'noteFinding');
      if (ambiguousScopes > 0) {
        // 多 scope 并存且未指定 scopeId：拒绝写入（不回退到“最近创建的 scope”），以免发现记进其它维度。
        return {
          recorded: false,
          target: 'missing-active-context',
          importance,
          message: `当前有 ${ambiguousScopes} 个工作记忆 scope 并存且未指定 scopeId，note_finding 拒绝写入以免记进其它维度`,
        };
      }
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
      const message = errorMessage(err);
      this.#log('warn', `[MemoryCoordinator] noteFinding error: ${message}`);
      return {
        recorded: false,
        target: 'error',
        importance,
        message: `记录发现失败: ${message}`,
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
   * @deprecated src 与宿主都不调用（对话记忆不经此写入 PersistentMemory）；
   *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
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

  // 工具结果缓存代理与 recordObservation 已删除（W1-04，审阅包 L6-P26 / C64，决定①）：SessionStore
  // 只读工具缓存在生产中从无写入者，重复调用去重由 Agent 工具管道的 duplicateCache 承担。

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
    // 先由 ActiveContext 校验配置，再替换 scope；拒绝非法配置不能丢掉现有工作记忆。
    const ac = new ActiveContext({
      lightweight: config.lightweight || false,
      maxRecentRounds: config.maxRecentRounds,
    });
    this.#promptBudgets.delete(scopeId);
    this.#currentScopeId = scopeId;
    this.#activeContexts.set(scopeId, ac);
    this.#log('debug', `[MemoryCoordinator] scope created: ${scopeId} (ActiveContext)`);
    return ac;
  }

  /**
   * 完成维度: 蒸馏 + 存储到 SessionStore
   * @param [report] 附加报告数据
   * @deprecated 无生产调用方：宿主每个维度只调用 createDimensionScope，维度报告由宿主直接写入
   *   SessionStore，scope 从不在此释放。删除还是改由宿主接线释放 scope，随待决事项②决定；
   *   删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
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

      // 切换当前 scope 到下一个或清空
      if (this.#currentScopeId === scopeId) {
        this.#currentScopeId = null;
      }
      this.#log('debug', `[MemoryCoordinator] scope completed: ${scopeId}`);
    } catch (err: unknown) {
      this.#log('warn', `[MemoryCoordinator] completeDimension error: ${errorMessage(err)}`);
    }
  }

  /**
   * 完成会话：只清空当前 scope 指针，不删除已建 scope，也不触发 Consolidator 固化
   * （固化由宿主另行调用 EpisodicConsolidator）。
   * @returns 恒为 { consolidated: 0 }；内部异常时返回 null 并记 warn
   * @deprecated 无生产调用方；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  async completeSession(): Promise<{ consolidated: number } | null> {
    try {
      this.#currentScopeId = null;
      this.#log('info', '[MemoryCoordinator] session completed');
      return { consolidated: 0 };
    } catch (err: unknown) {
      this.#log('warn', `[MemoryCoordinator] completeSession error: ${errorMessage(err)}`);
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

  /**
   * 检索前序维度的代码证据 — memory.get_previous_evidence 的旧接口；
   * handler 优先调用 searchEvidenceWithDiagnostics，只有替身/旧宿主才走这里。
   */
  searchEvidence(query: string, dimId?: string): MemoryEvidenceSearchHit[] {
    return this.searchEvidenceWithDiagnostics(query, dimId).results;
  }

  /** 检索前序维度代码证据，并在读路径降级时返回稳定诊断。 */
  searchEvidenceWithDiagnostics(query: string, dimId?: string): MemoryEvidenceSearchResult {
    if (!this.#sessionStore) {
      // scan 链路的 coordinator 不带 SessionStore，每次 get_previous_evidence 都走这里：首次 warn 让运维
      // 能定位“能力缺失而非真的没有证据”，之后记 debug，避免同一会话刷屏。结果诊断照常返回给 handler。
      const level = this.#evidenceStoreMissingWarned ? 'debug' : 'warn';
      this.#evidenceStoreMissingWarned = true;
      this.#log(
        level,
        `[MemoryCoordinator] searchEvidence degraded (MEMORY_EVIDENCE_STORE_MISSING): SessionStore is not configured; path=session-store-missing; query="${query}"; dimId=${dimId ?? '*'}`
      );
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
      const message = errorMessage(err);
      this.#log(
        'warn',
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

  /**
   * 获取 PersistentMemory
   * @deprecated 无生产调用方；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  getPersistentMemory() {
    return this.#persistentMemory || null;
  }

  /**
   * 获取 ConversationLog / ConversationStore
   * @deprecated conversationLog 端口从未被注入，恒返回 null；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  getConversationLog() {
    return this.#conversationLog || null;
  }

  getDiagnostics(): { writeFailures: MemoryWriteFailureDiagnostic[] } {
    return { writeFailures: this.#writeFailures.map((entry) => ({ ...entry })) };
  }

  // ═══════════════════════════════════════════════════════════
  // 自动摘要 (F23)
  // ═══════════════════════════════════════════════════════════

  /**
   * 对话更新后触发自动摘要（≥12 条时调用 conversationLog.summarize）
   * @deprecated 无调用方且 conversationLog 端口从未被注入；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  async onConversationUpdated(conversationId: string, aiProvider: AiProviderLike | null) {
    if (!this.#conversationLog || !aiProvider) {
      return;
    }
    try {
      const messages = this.#conversationLog.load(conversationId, { tokenBudget: Infinity });
      if (messages.length >= 12) {
        await this.#conversationLog.summarize(conversationId, { aiProvider });
      }
    } catch (err: unknown) {
      // 摘要是旁路：失败时跳过本次摘要、不影响主流程，下次对话更新会再尝试；只告警并带上对话 id。
      this.#log(
        'warn',
        `[MemoryCoordinator] onConversationUpdated summary skipped: conversation=${conversationId}; ${errorMessage(err)}`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 断点续传
  // ═══════════════════════════════════════════════════════════

  /**
   * 保存 checkpoint（委托 SessionStore.saveCheckpoint，不传 WriteZone）
   * @deprecated 无生产调用方（宿主断点续跑用自己的维度 checkpoint）；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  async checkpoint(projectRoot: string) {
    try {
      if (this.#sessionStore?.saveCheckpoint) {
        await this.#sessionStore.saveCheckpoint(projectRoot);
      }
    } catch (err: unknown) {
      this.#log('warn', `[MemoryCoordinator] checkpoint error: ${errorMessage(err)}`);
    }
  }

  /**
   * 恢复 checkpoint（委托 SessionStore.loadCheckpoint）
   * @deprecated 无生产调用方；随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  async restore(projectRoot: string): Promise<boolean> {
    try {
      if (this.#sessionStore?.loadCheckpoint) {
        return await this.#sessionStore.loadCheckpoint(projectRoot);
      }
      return false;
    } catch (err: unknown) {
      this.#log('warn', `[MemoryCoordinator] restore error: ${errorMessage(err)}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 清理
  // ═══════════════════════════════════════════════════════════

  /**
   * 释放全部 scope 与 SessionStore 引用。
   * @deprecated 无生产调用方：宿主从不调用 dispose，会话级 coordinator 随运行结束被回收。
   *   删除还是改由宿主在会话结束时接线调用，随待决事项②决定；删除前须附 src、测试、宿主生产与
   *   宿主测试的零引用扫描。
   */
  dispose() {
    this.#promptBudgets.clear();
    this._lastSurplus = 0;
    for (const [scopeId, ac] of this.#activeContexts) {
      try {
        ac.clear();
      } catch (err: unknown) {
        // 清理失败不阻断释放：下面仍会丢弃整张 scope 表，这里只告警说明哪个 scope 未能先行清空。
        this.#log(
          'warn',
          `[MemoryCoordinator] dispose: clearing scope ${scopeId} failed, scope dropped anyway; ${errorMessage(err)}`
        );
      }
    }
    this.#activeContexts.clear();
    this.#sessionStore = null;
    this.#currentScopeId = null;
  }

  // ═══════════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════════

  /**
   * 内部调用点（noteFinding、动态记忆 prompt）的 scope 守卫。
   * 会话级 coordinator 由多个维度共享，#currentScopeId 只是“最近创建的 scope”，并行维度下回退到它
   * 会把发现或工作记忆写进/读自别的维度。分叉：
   * - 显式 scopeId → 直接取该 scope（不存在则 ac=null，由调用方按“未初始化”处理）；
   * - 未指定且多个 scope 并存 → 不回退，ac=null、ambiguousScopes=并存数，并 warn（含 scope 数）；
   * - 未指定且至多一个 scope → 保留回退到当前 scope 的旧行为，命中时记 debug 'implicit-current-scope'。
   * 公开 getActiveContext() 无参语义保持不变，守卫只加在内部调用点。
   */
  #resolveScopedContext(
    scopeId: string | undefined,
    operation: string
  ): { ac: ActiveContext | null; ambiguousScopes: number } {
    if (scopeId) {
      return { ac: this.getActiveContext(scopeId), ambiguousScopes: 0 };
    }
    const scopeCount = this.#activeContexts.size;
    if (scopeCount > 1) {
      this.#log(
        'warn',
        `[MemoryCoordinator] ${operation} rejected: scopeId required when multiple scopes are active (scopes=${scopeCount}; current=${this.#currentScopeId ?? 'none'}; path=ambiguous-implicit-scope)`
      );
      return { ac: null, ambiguousScopes: scopeCount };
    }
    const ac = this.getActiveContext();
    if (ac) {
      this.#log(
        'debug',
        `[MemoryCoordinator] ${operation} implicit-current-scope: scopeId omitted, using the only active scope ${this.#currentScopeId}`
      );
    }
    return { ac, ambiguousScopes: 0 };
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
    this.#log(
      'warn',
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
  /** 诊断是旁路，不能让已创建/已完成的 memory scope 失去回执。 */
  #log(level: 'info' | 'warn' | 'debug', message: string): void {
    observeSafely(
      () => this.#logger[level](message),
      () => undefined
    );
  }
}

export default MemoryCoordinator;
