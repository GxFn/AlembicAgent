/**
 * BudgetController — 预算决策 + 压缩触发 + 遥测
 *
 * 从 AgentRuntime 抽离的独立模块，职责:
 *   1. Session token 预算预检 (checkBeforeLLMCall)
 *   2. 压缩触发 (runCompactionCycle / executeL4IfPending)
 *   3. Token 追踪 (recordLLMUsage / cumulativeUsage)
 *   4. 工具预算分摊 (getToolBudget / recordToolCharsUsed)
 *   5. TurnTelemetry 遥测 (emitTurnTelemetry)
 *
 * 生命周期: 每次 reactLoop 创建一个，绑定到 LoopContext。
 * 跨 stage 共享: cumulativeUsage 使用 AgentRuntime.tokenUsage 引用。
 *
 * @module BudgetController
 */

import type { ContextWindow } from '../context/ContextWindow.js';
import type { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { L4MemoryPackageInput } from '../context/l4MemoryPackage.js';

/* ── Types ─────────────────────────────────────────────── */

/** 可变引用 — BudgetController 直接读写此对象，跨 pipeline stage 共享 */
export interface TokenUsageAccumulator {
  input: number;
  output: number;
  reasoning: number;
  cacheHit: number;
}

export interface BudgetControllerConfig {
  /** Session 级 input token 总限额 (0 = 不限制，退化为 no-op) */
  maxSessionInputTokens: number;
  /** Session 级 total token 总限额 (input + output) */
  maxSessionTokens?: number;
  /**
   * AgentRuntime.tokenUsage 的引用（非拷贝！）。
   * 跨 pipeline stage 共享：analyze 写入的值，produce 可读到。
   */
  cumulativeUsage: TokenUsageAccumulator;
  /** ContextWindow 引用 (Per-call 压缩) */
  contextWindow: ContextWindow | null;
  /** ExplorationTracker 引用 (forceTerminal) */
  tracker: ExplorationTracker | null;
  /** 基础系统提示词长度（用于 ContextWindow 估算） */
  baseSystemPromptLength: number;
  /** 工具 schema 数量（用于 ContextWindow 估算） */
  toolSchemaCount: number;
  /** Logger 实例 */
  logger: BudgetLogger;
  /** Structured package source for L4 memory compaction */
  l4MemoryPackageProvider?: () => L4MemoryPackageInput;
  /** 临时止血开关：L4 仍保留实现，但默认不在运行中自动触发。 */
  enableL4Compaction?: boolean;
  /** Abort signal used to discard in-flight L4 compaction results */
  abortSignal?: AbortSignal | null;
}

export interface BudgetLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface PreLLMCheckResult {
  action: 'normal' | 'compress';
  estimatedNextCallTokens: number;
  sessionUsageRatio: number;
  compaction: CompactionResult;
}

export interface CompactionResult {
  level: number;
  removed: number;
  failed?: boolean;
  cancelled?: boolean;
  hardStop?: boolean;
  reason?: string;
}

export interface ToolBudget {
  roundMaxChars: number;
  perToolMaxChars: number;
  perToolMaxMatches: number;
}

export interface LLMUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
}

export interface SessionBudgetSummary {
  totalIterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  avgCacheHitRate: number;
  peakSessionUsageRatio: number;
  maxCompactionLevel: number;
  totalCompactedItems: number;
  forcedSummarize: boolean;
}

/* ── Constants ─────────────────────────────────────────── */

const COMPRESS_THRESHOLD = 0.75;
const AGGRESSIVE_COMPRESS_THRESHOLD = 0.9;
const DEFAULT_ESTIMATE = 8000;
const MIN_TOOL_CHARS = 400;
const L4_HARD_STOP_RATIO = 1.3;
const L4_REPEAT_FAILURE_HARD_STOP_RATIO = 1.0;

/* ── BudgetController ──────────────────────────────────── */

export class BudgetController {
  readonly #maxSessionInputTokens: number;
  readonly #cumulativeUsage: TokenUsageAccumulator;
  readonly #contextWindow: ContextWindow | null;
  readonly #tracker: ExplorationTracker | null;
  readonly #baseSystemPromptLength: number;
  readonly #toolSchemaCount: number;
  readonly #logger: BudgetLogger;
  readonly #l4MemoryPackageProvider: (() => L4MemoryPackageInput) | null;
  readonly #enableL4Compaction: boolean;
  readonly #abortSignal: AbortSignal | null;

  #lastRoundInputTokens = 0;
  #pendingL4 = false;
  #l4RetryCooldownChecks = 0;
  #l4RequestBlockedForCurrentCheck = false;
  #l4FailureCount = 0;
  #l4DisabledLogged = false;
  #lastProjectedSessionUsageRatio = 0;
  #consecutiveZeroCacheHits = 0;

  // telemetry accumulators
  #iterationCount = 0;
  #peakSessionUsageRatio = 0;
  #maxCompactionLevel = 0;
  #totalCompactedItems = 0;
  #forcedSummarize = false;

  // per-round tool budget state
  #roundMaxChars = 0;
  #roundCharsUsed = 0;
  #roundPerToolMaxMatches = 0;

  constructor(config: BudgetControllerConfig) {
    this.#maxSessionInputTokens = config.maxSessionInputTokens;
    this.#cumulativeUsage = config.cumulativeUsage;
    this.#contextWindow = config.contextWindow;
    this.#tracker = config.tracker;
    this.#baseSystemPromptLength = config.baseSystemPromptLength;
    this.#toolSchemaCount = config.toolSchemaCount;
    this.#logger = config.logger;
    this.#l4MemoryPackageProvider = config.l4MemoryPackageProvider ?? null;
    this.#enableL4Compaction =
      config.enableL4Compaction ?? process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION === '1';
    this.#abortSignal = config.abortSignal ?? null;
  }

  /* ═══════════════════════════════════════════════════════
   *  预算决策
   * ═══════════════════════════════════════════════════════ */

  get hasSessionBudget(): boolean {
    return this.#maxSessionInputTokens > 0;
  }

  get sessionUsageRatio(): number {
    if (!this.hasSessionBudget) {
      return 0;
    }
    return this.#cumulativeUsage.input / this.#maxSessionInputTokens;
  }

  /**
   * LLM 调用前的预算预检。
   *
   * 职责链:
   *   1. 估算下一轮 input token
   *   2. 计算 projected session 使用率
   *   3. 同步 sessionPressure 到 ContextWindow
   *   4. 按阈值决定动作 (normal/compress/summarize)
   *   5. 如果 compress: 触发 compaction cycle + 可选 L4 标记
   *   6. 如果 summarize: 触发 forceTerminal
   */
  checkBeforeLLMCall(iteration: number): PreLLMCheckResult {
    const noopResult: PreLLMCheckResult = {
      action: 'normal',
      estimatedNextCallTokens: 0,
      sessionUsageRatio: 0,
      compaction: { level: 0, removed: 0 },
    };

    if (!this.hasSessionBudget) {
      return noopResult;
    }

    this.#l4RequestBlockedForCurrentCheck = false;
    if (this.#l4RetryCooldownChecks > 0) {
      this.#l4RetryCooldownChecks--;
      this.#l4RequestBlockedForCurrentCheck = true;
      this.#logger.warn('[BudgetController] L4 compaction request suppressed during cooldown');
    }

    const usedInputTokens = this.#cumulativeUsage.input;
    const estimated = this.#estimateNextCallTokens(iteration);
    const projected = usedInputTokens + estimated;
    const ratio = projected / this.#maxSessionInputTokens;
    this.#lastProjectedSessionUsageRatio = ratio;

    if (this.#contextWindow) {
      this.#contextWindow.setSessionPressure(usedInputTokens / this.#maxSessionInputTokens);
    }

    if (ratio <= COMPRESS_THRESHOLD) {
      return {
        action: 'normal',
        estimatedNextCallTokens: estimated,
        sessionUsageRatio: ratio,
        compaction: { level: 0, removed: 0 },
      };
    }

    // 75%+: 触发压缩 — session budget 只做压缩触发，不做终止决策
    // 终止由 maxIterations / timeout / ExitController 负责
    const isAggressive = ratio > AGGRESSIVE_COMPRESS_THRESHOLD;
    const label = isAggressive ? '激进压缩' : '压缩';
    this.#logger.info(
      `[BudgetController] ⚠ session 预检: ${usedInputTokens} used + ~${estimated} est = ${projected}/${this.#maxSessionInputTokens} (${(ratio * 100).toFixed(1)}%) → ${label}`
    );

    const compaction = this.#runExtraCompaction();

    // >90%: 标记 L4 pending 以触发 LLM-based 摘要压缩，释放更多空间
    if (isAggressive && this.#contextWindow && !this.#pendingL4) {
      this.#requestL4IfReady('aggressive session pressure');
    }

    return {
      action: 'compress',
      estimatedNextCallTokens: estimated,
      sessionUsageRatio: ratio,
      compaction,
    };
  }

  /* ═══════════════════════════════════════════════════════
   *  压缩触发
   * ═══════════════════════════════════════════════════════ */

  /**
   * 常规压缩周期 — 委托 ContextWindow.compactIfNeeded()。
   * 由 AgentRuntime 在 #prepareIteration 中调用。
   */
  runCompactionCycle(): CompactionResult {
    if (!this.#contextWindow) {
      return { level: 0, removed: 0 };
    }
    const result = this.#contextWindow.compactIfNeeded();
    this.#trackCompaction(result);
    return result;
  }

  /** 标记需要 L4 compaction (异步 LLM 摘要) */
  requestL4Compaction(): void {
    if (!this.#enableL4Compaction) {
      return;
    }
    this.#requestL4IfReady('explicit request');
  }

  get pendingL4(): boolean {
    return this.#pendingL4;
  }

  /**
   * 执行挂起的 L4 compaction (在 LLM 调用前)。
   * L4 token 消耗直接回写 cumulativeUsage。
   */
  async executeL4IfPending(
    aiProvider: {
      chatWithTools: (
        prompt: string,
        opts: Record<string, unknown>
      ) => Promise<{ text?: string; usage?: Record<string, unknown> }>;
    },
    addLoopTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
  ): Promise<CompactionResult> {
    if (!this.#pendingL4 || !this.#contextWindow) {
      return { level: 0, removed: 0 };
    }
    this.#pendingL4 = false;

    try {
      if (this.#abortSignal?.aborted) {
        return { level: 4, removed: 0, cancelled: true, failed: true, reason: 'abort_signal' };
      }

      const l4Result = await this.#contextWindow.compactL4(
        aiProvider as Parameters<ContextWindow['compactL4']>[0],
        {
          ...(this.#l4MemoryPackageProvider
            ? { memoryPackage: this.#l4MemoryPackageProvider() }
            : {}),
          abortSignal: this.#abortSignal,
        }
      );
      if (l4Result.cancelled) {
        this.#l4RetryCooldownChecks = 1;
      } else if (l4Result.failed) {
        this.#l4FailureCount++;
        this.#l4RetryCooldownChecks = 1;
        this.#logger.warn(
          '[BudgetController] L4 compaction failed; cooling down for one preflight check'
        );
      } else if (l4Result.removed > 0) {
        this.#l4FailureCount = 0;
        this.#logger.info(
          `[BudgetController] L4 compaction executed: removed ${l4Result.removed} messages`
        );
      }
      if (l4Result.usage) {
        const usage = l4Result.usage as Record<string, number>;
        const inputTokens = usage.inputTokens || 0;
        const outputTokens = usage.outputTokens || 0;
        this.#cumulativeUsage.input += inputTokens;
        this.#cumulativeUsage.output += outputTokens;
        addLoopTokenUsage?.({ inputTokens, outputTokens });
      }
      const effectivePressure = Math.max(
        this.sessionUsageRatio,
        this.#lastProjectedSessionUsageRatio
      );
      const hardStop =
        l4Result.failed &&
        !l4Result.cancelled &&
        (effectivePressure >= L4_HARD_STOP_RATIO ||
          (this.#l4FailureCount >= 2 && effectivePressure >= L4_REPEAT_FAILURE_HARD_STOP_RATIO));
      if (hardStop) {
        this.#logger.warn(
          `[BudgetController] L4 failure under runaway session pressure (${(effectivePressure * 100).toFixed(1)}%); hard-stopping current run`
        );
      }
      const result = {
        level: 4,
        removed: l4Result.removed,
        ...(l4Result.failed ? { failed: true } : {}),
        ...(l4Result.cancelled ? { cancelled: true, reason: 'abort_signal' } : {}),
        ...(hardStop ? { hardStop: true, reason: 'l4_compaction_failed_budget_exhausted' } : {}),
      };
      this.#trackCompaction(result);
      return result;
    } catch (err) {
      this.#l4FailureCount++;
      this.#l4RetryCooldownChecks = 1;
      this.#logger.warn(`[BudgetController] L4 compaction failed: ${err}`);
      return {
        level: 0,
        removed: 0,
        failed: true,
        ...(Math.max(this.sessionUsageRatio, this.#lastProjectedSessionUsageRatio) >=
        L4_HARD_STOP_RATIO
          ? { hardStop: true, reason: 'l4_compaction_failed_budget_exhausted' }
          : {}),
      };
    }
  }

  /* ═══════════════════════════════════════════════════════
   *  Token 追踪
   * ═══════════════════════════════════════════════════════ */

  /**
   * 记录本轮 LLM 返回的 token 使用情况。
   * 同时更新 cumulativeUsage（共享引用）和内部 lastRoundInputTokens。
   */
  recordLLMUsage(usage: LLMUsageInput): void {
    const inp = usage.inputTokens || 0;
    const out = usage.outputTokens || 0;
    const reasoning = usage.reasoningTokens || 0;
    const cache = usage.cacheHitTokens || 0;

    this.#cumulativeUsage.input += inp;
    this.#cumulativeUsage.output += out;
    this.#cumulativeUsage.reasoning += reasoning;
    this.#cumulativeUsage.cacheHit += cache;

    this.#lastRoundInputTokens = inp;
    this.#iterationCount++;

    const ratio = this.sessionUsageRatio;
    if (ratio > this.#peakSessionUsageRatio) {
      this.#peakSessionUsageRatio = ratio;
    }
  }

  get cumulativeUsage(): Readonly<TokenUsageAccumulator> {
    return this.#cumulativeUsage;
  }

  /* ═══════════════════════════════════════════════════════
   *  工具预算
   * ═══════════════════════════════════════════════════════ */

  /**
   * 获取本轮工具调用的 token 预算。
   *
   * 并行工具共享 roundMaxChars 预算:
   *   roundMaxChars = baseQuota.maxChars × ceil(parallelCount / 2)
   *   perToolMaxChars = roundMaxChars / parallelCount
   */
  getToolBudget(parallelCount: number): ToolBudget {
    if (!this.#contextWindow) {
      return {
        roundMaxChars: 6000,
        perToolMaxChars: 6000,
        perToolMaxMatches: 15,
      };
    }

    const baseQuota = this.#contextWindow.getToolResultQuota();
    const scaleFactor = Math.ceil(parallelCount / 2);
    const roundMaxChars = baseQuota.maxChars * scaleFactor;
    const perToolMaxChars = Math.max(MIN_TOOL_CHARS, Math.floor(roundMaxChars / parallelCount));
    const perToolMaxMatches = Math.max(
      2,
      Math.floor((baseQuota.maxMatches * scaleFactor) / parallelCount)
    );

    this.#roundMaxChars = roundMaxChars;
    this.#roundCharsUsed = 0;
    this.#roundPerToolMaxMatches = perToolMaxMatches;

    return { roundMaxChars, perToolMaxChars, perToolMaxMatches };
  }

  recordToolCharsUsed(chars: number): void {
    this.#roundCharsUsed += chars;
  }

  getRemainingToolBudget(): { maxChars: number; maxMatches: number } {
    return {
      maxChars: Math.max(MIN_TOOL_CHARS, this.#roundMaxChars - this.#roundCharsUsed),
      maxMatches: this.#roundPerToolMaxMatches,
    };
  }

  /* ═══════════════════════════════════════════════════════
   *  遥测
   * ═══════════════════════════════════════════════════════ */

  /**
   * 输出 TurnTelemetry — 结构化日志。
   * 仅 system 场景输出（由调用方控制）。
   */
  emitTurnTelemetry(params: {
    iteration: number;
    currentUsage: LLMUsageInput;
    compaction: CompactionResult;
  }): void {
    const { iteration, currentUsage, compaction } = params;
    const u = currentUsage;
    const inTok = u.inputTokens || 0;
    const cacheRate = inTok > 0 ? ((u.cacheHitTokens || 0) / inTok) * 100 : 0;
    const sessionBudget = this.#maxSessionInputTokens;
    const sessionPart =
      sessionBudget > 0
        ? `session=${this.#cumulativeUsage.input}/${sessionBudget} (${((this.#cumulativeUsage.input / sessionBudget) * 100).toFixed(1)}%)`
        : `session=${this.#cumulativeUsage.input} (unlimited)`;

    this.#logger.info(
      `[TurnTelemetry] iter=${iteration} | ` +
        `in=${inTok} out=${u.outputTokens || 0} reasoning=${u.reasoningTokens || 0} ` +
        `cache=${u.cacheHitTokens || 0} (${cacheRate.toFixed(0)}% hit) | ` +
        `compact=L${compaction.level} | ` +
        sessionPart
    );

    if ((u.cacheHitTokens || 0) === 0 && inTok > 1024) {
      this.#consecutiveZeroCacheHits++;
      if (this.#consecutiveZeroCacheHits >= 3) {
        this.#logger.warn(
          `[TurnTelemetry] ⚠ ${this.#consecutiveZeroCacheHits} consecutive turns with 0 cache hits — check if system prompt is being modified`
        );
      }
    } else {
      this.#consecutiveZeroCacheHits = 0;
    }
  }

  getSessionSummary(): SessionBudgetSummary {
    const totalInput = this.#cumulativeUsage.input;
    const totalCache = this.#cumulativeUsage.cacheHit;
    return {
      totalIterations: this.#iterationCount,
      totalInputTokens: totalInput,
      totalOutputTokens: this.#cumulativeUsage.output,
      totalReasoningTokens: this.#cumulativeUsage.reasoning,
      avgCacheHitRate: totalInput > 0 ? totalCache / totalInput : 0,
      peakSessionUsageRatio: this.#peakSessionUsageRatio,
      maxCompactionLevel: this.#maxCompactionLevel,
      totalCompactedItems: this.#totalCompactedItems,
      forcedSummarize: this.#forcedSummarize,
    };
  }

  /* ═══════════════════════════════════════════════════════
   *  内部方法
   * ═══════════════════════════════════════════════════════ */

  #estimateNextCallTokens(iteration: number): number {
    if (this.#lastRoundInputTokens > 0) {
      return this.#lastRoundInputTokens;
    }
    if (this.#contextWindow) {
      return this.#contextWindow.estimateFullContextTokens(
        this.#baseSystemPromptLength,
        this.#toolSchemaCount
      );
    }
    if (iteration > 1 && this.#cumulativeUsage.input > 0) {
      return Math.ceil(this.#cumulativeUsage.input / (iteration - 1));
    }
    return DEFAULT_ESTIMATE;
  }

  /** Session budget 压力下的额外压缩 */
  #runExtraCompaction(): CompactionResult {
    if (!this.#contextWindow) {
      return { level: 0, removed: 0 };
    }
    const cw = this.#contextWindow;
    const extraCompact = cw.compactIfNeeded();
    if (extraCompact.level > 0) {
      this.#logger.info(
        `[BudgetController] session budget pressure → extra compact L${extraCompact.level}, removed ${extraCompact.removed}`
      );
    }
    if (cw.needsL4Compaction()) {
      this.#requestL4IfReady('context window threshold');
    }
    this.#trackCompaction(extraCompact);
    return extraCompact;
  }

  #requestL4IfReady(reason: string): void {
    if (!this.#enableL4Compaction) {
      if (!this.#l4DisabledLogged) {
        this.#logger.info(`[BudgetController] L4 compaction disabled; skip request (${reason})`);
        this.#l4DisabledLogged = true;
      }
      return;
    }
    if (this.#pendingL4) {
      return;
    }
    if (this.#l4RequestBlockedForCurrentCheck) {
      this.#logger.warn(`[BudgetController] L4 compaction request skipped (${reason})`);
      return;
    }
    this.#pendingL4 = true;
  }

  #trackCompaction(result: CompactionResult): void {
    if (result.level > this.#maxCompactionLevel) {
      this.#maxCompactionLevel = result.level;
    }
    this.#totalCompactedItems += result.removed;
  }
}
