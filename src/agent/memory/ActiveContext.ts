/**
 * ActiveContext — 合并 WorkingMemory + ReasoningTrace 为统一的会话工作记忆
 *
 * 三个内部子区:
 *   1. Scratchpad   — Agent 通过 note_finding 主动标记的发现 (不可压缩)
 *   2. ObservationLog — 每轮 ReAct 记录 (合并原 RT.rounds + WM.observations，滑动窗口压缩)
 *   3. Plan          — 从 ReasoningTrace 继承的规划追踪
 *
 * 替代关系:
 *   WorkingMemory.js  → Scratchpad + 工具压缩策略 + buildContext + distill
 *   ReasoningTrace.js → rounds + plan + thoughts + extractAndSetPlan + observations
 *
 * 兼容性:
 *   - 提供所有 ReasoningTrace 和 WorkingMemory 的公共方法
 *   - ExplorationTracker 可直接使用 ActiveContext 作为 trace 参数 (L5 缓解)
 *   - MemoryCoordinator 通过 createDimensionScope 创建实例
 *
 * 生命周期: 单次 execute() 调用 (由 MemoryCoordinator 管理创建/蒸馏/销毁)
 *
 * @module ActiveContext
 */

import Logger from '@alembic/core/logging';
import type { ToolResultEnvelope } from '#tools/kernel/index.js';
import type { DistilledContext } from './MemoryFlushContract.js';

// ═══════════════════════════════════════════════════════════
// §1: 工具压缩策略 (从 WorkingMemory 迁入)
// ═══════════════════════════════════════════════════════════

/** 工具特化压缩策略 — 不同工具返回不同结构，压缩时保留最有价值的部分 */
const TOOL_COMPRESS_STRATEGIES = {
  code(result: unknown) {
    if (typeof result !== 'object' || result === null) {
      return String(result).substring(0, 600);
    }
    const r = result as Record<string, unknown>;
    const matches = (Array.isArray(r.matches) ? r.matches : []) as Array<{
      file: string;
      line: number;
    }>;
    const batchResults = (r.batchResults || {}) as Record<string, Record<string, unknown>>;

    // search action: 有 matches 或 batchResults
    if (matches.length > 0 || Object.keys(batchResults).length > 0) {
      const lines: string[] = [];
      if (matches.length > 0) {
        lines.push(`搜索到 ${matches.length} 个匹配`);
        const fileGroups: Record<string, number[]> = {};
        for (const m of matches) {
          if (!fileGroups[m.file]) {
            fileGroups[m.file] = [];
          }
          fileGroups[m.file].push(m.line);
        }
        for (const [file, lineNums] of Object.entries(fileGroups).slice(0, 8)) {
          lines.push(`  ${file}: L${lineNums.slice(0, 3).join(',')}`);
        }
      }
      for (const [pattern, sub] of Object.entries(batchResults).slice(0, 5)) {
        const subMatches = (Array.isArray(sub.matches) ? sub.matches : []) as Array<{
          file: string;
          line: number;
        }>;
        lines.push(`  [${pattern}] ${subMatches.length} 个匹配`);
        for (const m of subMatches.slice(0, 3)) {
          lines.push(`    ${m.file}:${m.line}`);
        }
      }
      return lines.join('\n');
    }

    // read action: 有 files 数组或 content 字段
    if (Array.isArray(r.files)) {
      const files = r.files as Array<{ content?: string; path?: string }>;
      const lines = [`读取 ${files.length} 个文件`];
      for (const f of files.slice(0, 5)) {
        const totalLines = (f.content || '').split('\n').length;
        lines.push(`  ${f.path} (${totalLines} 行)`);
      }
      return lines.join('\n');
    }
    if (r.content) {
      const content = (r.content as string) || String(result);
      const totalLines = content.split('\n').length;
      return `文件 ${(r.path as string) || '?'} (${totalLines} 行)`;
    }

    // structure/outline action: 有 entries/children
    const entries = r.entries || r.children || [];
    if (Array.isArray(entries) && entries.length > 0) {
      return `目录结构: ${entries.length} 个条目`;
    }

    return defaultCompress(result);
  },

  graph(result: unknown) {
    if (typeof result !== 'object' || result === null) {
      return String(result).substring(0, 600);
    }
    const r = result as Record<string, unknown>;

    // hierarchy query: 有 classes 或 hierarchy 数组
    const classes = r.classes || r.hierarchy;
    if (Array.isArray(classes)) {
      return `类层级: ${classes.length} 个类`;
    }

    // class/protocol query: 有 className 等
    const lines = [`类 ${(r.className as string) || (r.protocolName as string) || '?'}`];
    if (r.superClass) {
      lines.push(`  继承: ${r.superClass}`);
    }
    if (Array.isArray(r.protocols) && r.protocols.length) {
      lines.push(`  协议: ${(r.protocols as string[]).join(', ')}`);
    }
    if (Array.isArray(r.methods) && r.methods.length) {
      lines.push(`  方法数: ${r.methods.length}`);
    }
    if (Array.isArray(r.properties) && r.properties.length) {
      lines.push(`  属性数: ${r.properties.length}`);
    }
    return lines.join('\n');
  },
};

/** 默认压缩 — 截断到 maxChars */
function defaultCompress(result: unknown, maxChars = 600) {
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  if (str.length <= maxChars) {
    return str;
  }
  return `${str.substring(0, maxChars)}…(truncated)`;
}

// ═══════════════════════════════════════════════════════════
// §2: 类型定义 + ActiveContext 类
// ═══════════════════════════════════════════════════════════

interface ActiveContextOptions {
  maxRecentRounds?: number;
  lightweight?: boolean;
}

interface ScratchpadEntry {
  finding: string;
  evidence: string;
  importance: number;
  round: number;
}

interface RoundAction {
  tool: string;
  params: Record<string, unknown>;
}

interface RoundObservation {
  tool: string;
  gotNewInfo?: boolean;
  resultType?: string;
  keyFacts?: string[];
  resultSize?: number;
  [key: string]: unknown;
}

interface RoundSummary {
  newInfoCount?: number;
  totalCalls?: number;
  submits?: number;
  cumulativeFiles?: number;
  cumulativePatterns?: number;
  [key: string]: unknown;
}

interface Round {
  iteration: number;
  thought: string | null;
  actions: RoundAction[];
  observations: RoundObservation[];
  reflection: string | null;
  roundSummary: RoundSummary | null;
  startTime: number;
  endTime: number | null;
}

interface PlanStep {
  description: string;
  status: string;
  keywords: string[];
}

interface Plan {
  text: string;
  steps: PlanStep[];
  createdAtIteration: number;
  lastUpdatedAtIteration: number;
}

interface Observation {
  toolName: string;
  args?: Record<string, unknown>;
  result: unknown;
  round: number;
  timestamp: number;
}

type ObservationLedgerCategory = 'evidence' | 'readSet' | 'searchSet' | 'failureSet' | 'nextHints';

interface ObservationLedgerItem {
  category: ObservationLedgerCategory;
  key: string;
  text: string;
  round: number;
  toolName: string;
}

interface CompressedObservation {
  toolName: string;
  round: number;
  summary: string;
  ledgerItems: ObservationLedgerItem[];
}

interface ActiveContextJSON {
  rounds?: Round[];
  scratchpad?: ScratchpadEntry[];
  totalObservations?: number;
  plan?: Plan;
}

const OBSERVATION_LEDGER_CATEGORIES: ObservationLedgerCategory[] = [
  'evidence',
  'readSet',
  'searchSet',
  'failureSet',
  'nextHints',
];

const OBSERVATION_LEDGER_LIMITS: Record<ObservationLedgerCategory, number> = {
  evidence: 8,
  readSet: 10,
  searchSet: 8,
  failureSet: 6,
  nextHints: 6,
};

const PROVIDER_DEBUG_KEYS = new Set([
  'callId',
  'parentCallId',
  'startedAt',
  'durationMs',
  'timestamp',
  'diagnostics',
  'structuredContent',
  '_meta',
]);

export class ActiveContext {
  // ── 子区 1: Scratchpad (从 WorkingMemory 继承, 不可压缩) ──
  #scratchpad: ScratchpadEntry[] = [];

  // ── 子区 2: ObservationLog (合并 RT.rounds + WM.observations) ──
  #rounds: Round[] = [];
  #currentRound: Round | null = null;

  // ── WM 滑动窗口 (保留最近 N 轮原始结果，旧的压缩) ──
  #recentObservations: Observation[] = [];
  #compressedObservations: CompressedObservation[] = [];

  // ── 子区 3: Plan (从 ReasoningTrace 继承) ──
  #plan: Plan | null = null;
  #planHistory: Plan[] = [];
  /** 是否期待下一次响应包含计划 (由 ExplorationTracker 设置) */
  #expectingPlan = false;

  // ── 配置 ──
  /** 保留最近 N 轮原始观察 */
  #maxRecentRounds: number;
  /** 轻量模式 (User Chat: 仅 RT 功能，禁用 WM 压缩/Scratchpad) */
  #lightweight: boolean;
  /** 总观察计数 */
  #totalObservations = 0;

  #logger: ReturnType<typeof Logger.getInstance>;

  /**
   * @param [options.maxRecentRounds=3] 保留最近 N 轮原始结果 (WM 滑动窗口)
   * @param [options.lightweight=false] 轻量模式: 跳过 WM 的压缩/Scratchpad 逻辑 (D5)
   */
  constructor(options: ActiveContextOptions = {}) {
    this.#maxRecentRounds = options.maxRecentRounds ?? 3;
    this.#lightweight = options.lightweight ?? false;
    this.#logger = Logger.getInstance();
  }

  // ═══════════════════════════════════════════════════════
  // §2.1: 轮次管理 (合并 RT.startRound/endRound)
  // ═══════════════════════════════════════════════════════

  /**
   * 开始新一轮推理
   * @param iteration 轮次编号
   */
  startRound(iteration: number) {
    if (this.#currentRound) {
      this.endRound(); // 安全关闭上一轮
    }
    this.#currentRound = {
      iteration,
      thought: null,
      actions: [],
      observations: [],
      reflection: null,
      roundSummary: null,
      startTime: Date.now(),
      endTime: null,
    };
  }

  /** 结束当前轮次 */
  endRound() {
    if (this.#currentRound) {
      this.#currentRound.endTime = Date.now();
      this.#rounds.push(this.#currentRound);
      this.#currentRound = null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §2.2: 记录 (合并 WM.observe + RT.addAction/addObservation)
  // ═══════════════════════════════════════════════════════

  /** 记录 AI 的推理文本（从 aiResult.text 提取） */
  setThought(text: string) {
    if (this.#currentRound && text) {
      this.#currentRound.thought = text;
    }
  }

  /**
   * 统一记录一次工具调用 — 合并原 WM.observe() + RT.addAction() + RT.addObservation()
   *
   * @param toolName 工具名称
   * @param args 工具参数
   * @param result 工具返回的原始结果
   * @param isNew 是否发现新信息 (由 ExplorationTracker.recordToolCall 提供)
   */
  recordToolCall(toolName: string, args: Record<string, unknown>, result: unknown, isNew: boolean) {
    const round = this.#currentRound?.iteration || 0;

    // ── RT 部分: Action + Observation ──
    this.#currentRound?.actions.push({ tool: toolName, params: args });
    const observationMeta = ActiveContext.buildObservationMeta(toolName, args, result, isNew);
    this.#currentRound?.observations.push({ tool: toolName, ...observationMeta });

    // ── WM 部分: 滑动窗口压缩 (非轻量模式) ──
    if (!this.#lightweight) {
      this.#totalObservations++;
      this.#recentObservations.push({
        toolName,
        args,
        result,
        round,
        timestamp: Date.now(),
      });

      while (this.#recentObservations.length > this.#maxRecentRounds) {
        const oldest = this.#recentObservations.shift();
        if (oldest) {
          const summary = this.#compressObservation(oldest);
          this.#compressedObservations.push(summary);
        }
      }
    }
  }

  /** 兼容旧 RT API: 记录一次工具调用 (Action only) */
  addAction(toolName: string, params: Record<string, unknown>) {
    this.#currentRound?.actions.push({ tool: toolName, params });
  }

  /** 兼容旧 RT API: 记录一次工具结果的结构化观察 */
  addObservation(toolName: string, meta: Record<string, unknown>) {
    this.#currentRound?.observations.push({ tool: toolName, ...meta });
  }

  /** 兼容旧 WM API: 记录工具调用结果 (Observe, 仅 WM 滑动窗口) */
  observe(toolName: string, result: unknown, round: number) {
    if (this.#lightweight) {
      return;
    }
    this.#totalObservations++;
    this.#recentObservations.push({ toolName, result, round, timestamp: Date.now() });
    while (this.#recentObservations.length > this.#maxRecentRounds) {
      const oldest = this.#recentObservations.shift();
      if (oldest) {
        const summary = this.#compressObservation(oldest);
        this.#compressedObservations.push(summary);
      }
    }
  }

  /** 记录反思内容 (ExplorationTracker 使用, L5 修复) */
  setReflection(text: string) {
    if (this.#currentRound && text) {
      this.#currentRound.reflection = text;
    }
  }

  /**
   * 记录轮次摘要
   * @param summary { newInfoCount, totalCalls, submits, cumulativeFiles, cumulativePatterns }
   */
  setRoundSummary(summary: RoundSummary) {
    if (this.#currentRound) {
      this.#currentRound.roundSummary = summary;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §2.3: Scratchpad (从 WorkingMemory 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * Agent 主动记录关键发现 (note_finding 工具入口)
   *
   * @param finding 关键发现描述
   * @param [evidence] 证据 (文件路径:行号)
   * @param [importance=5] 重要性 1-10
   * @param [round=0] 当前轮次
   */
  noteKeyFinding(finding: string, evidence: unknown = '', importance = 5, round = 0) {
    // P0 Fix: 防御性保证 evidence 是 string (AI 可能传入 array/object)
    const safeEvidence =
      typeof evidence === 'string'
        ? evidence
        : Array.isArray(evidence)
          ? evidence.join(', ')
          : evidence
            ? String(evidence)
            : '';
    this.#scratchpad.push({
      finding,
      evidence: safeEvidence,
      importance: Math.min(10, Math.max(1, importance)),
      round,
    });

    this.#logger.debug(
      `[ActiveContext] 📌 noted finding (${importance}/10): ${finding.substring(0, 80)}`
    );
  }

  // ═══════════════════════════════════════════════════════
  // §2.4: Plan (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * 从 AI 响应文本中提取计划，自动调用 setPlan/updatePlan
   *
   * 防御措施: 已存在计划时，仅在 #expectingPlan 为 true 时才覆盖。
   * 这防止 reflection 回复中的编号列表（非计划的回应文本）污染已有计划。
   * ExplorationTracker 在发送 plan elicitation / replan 时调用 expectPlan() 授权更新。
   *
   * @param text AI 完整响应文本
   * @param iteration 当前轮次
   * @returns 是否成功提取到计划
   */
  extractAndSetPlan(text: string, iteration: number) {
    const planText = this.#extractPlanFromText(text);
    if (!planText) {
      return false;
    }

    // Guard: 已有计划时，仅在 expectPlan 授权下才覆盖
    // 防止 reflection/convergence 回复中的编号列表被误捕获为 plan
    if (this.#plan && !this.#expectingPlan) {
      return false;
    }

    this.#expectingPlan = false;
    if (this.#plan) {
      this.#updatePlan(planText, iteration);
    } else {
      this.#setPlan(planText, iteration);
    }
    return true;
  }

  /**
   * 标记「下一次响应可能包含计划」— 授权 extractAndSetPlan 覆盖已有计划
   * 由 ExplorationTracker 在发送 plan elicitation / replan nudge 时调用。
   */
  expectPlan() {
    this.#expectingPlan = true;
  }

  /** 直接设置计划 (公开接口，供 ExplorationTracker 和测试使用) */
  setPlan(planText: string, iteration: number) {
    this.#setPlan(planText, iteration);
  }

  /** 更新计划 (保留旧 plan 到 history) */
  updatePlan(replanText: string, iteration: number) {
    this.#updatePlan(replanText, iteration);
  }

  /** 获取当前计划 (只读副本) */
  getPlan() {
    if (!this.#plan) {
      return null;
    }
    return {
      ...this.#plan,
      steps: this.#plan.steps.map((s) => ({ ...s })),
    };
  }

  /** 获取计划步骤的可变引用 (ExplorationTracker.updatePlanProgress 使用) */
  getPlanStepsMutable() {
    return this.#plan?.steps || [];
  }

  /** 获取计划历史 (F7) */
  getPlanHistory() {
    return this.#planHistory.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s })) }));
  }

  /**
   * 获取当前轮次的 actions (ExplorationTracker.updatePlanProgress 使用, L5 修复)
   * @returns >}
   */
  getCurrentRoundActions() {
    return this.#currentRound?.actions || [];
  }

  /** 获取当前轮次的 iteration 编号 (F8) */
  getCurrentIteration() {
    return this.#currentRound?.iteration || null;
  }

  // ═══════════════════════════════════════════════════════
  // §2.5: 上下文构建 (合并 WM.buildContext, 增加预算控制)
  // ═══════════════════════════════════════════════════════

  /**
   * 构建当前工作记忆的上下文快照
   * 用于注入到 system prompt 或 user nudge 中
   *
   * @param [tokenBudget=Infinity] token 预算 (新增: 预算控制)
   * @returns Markdown 格式的上下文块，空字符串表示无内容
   */
  buildContext(tokenBudget = Infinity) {
    if (this.#lightweight) {
      return '';
    }

    const parts: string[] = [];
    let remaining = tokenBudget;

    // §1: Scratchpad (最高优先级 — 不会被压缩)
    if (this.#scratchpad.length > 0) {
      const sorted = [...this.#scratchpad].sort((a, b) => b.importance - a.importance);
      const scratchLines = ['## 📌 已确认的关键发现'];
      for (const f of sorted) {
        const badge = f.importance >= 8 ? '⚠️' : f.importance >= 5 ? '📋' : '💡';
        let line = `- ${badge} [${f.importance}/10] ${f.finding}`;
        if (f.evidence) {
          line += ` (${f.evidence})`;
        }
        scratchLines.push(line);
      }
      const scratchSection = scratchLines.join('\n');
      const scratchTokens = this.#estimateTokens(scratchSection);
      if (scratchTokens <= remaining) {
        parts.push(scratchSection);
        remaining -= scratchTokens;
      }
    }

    // §2: Observation Ledger (中等优先级)
    if (this.#compressedObservations.length > 0 && remaining > 100) {
      const ledgerSection = this.#buildObservationLedgerSection(remaining);
      if (ledgerSection) {
        parts.push(ledgerSection);
      }
    }

    return parts.join('\n');
  }

  // ═══════════════════════════════════════════════════════
  // §2.6: 蒸馏 (合并 WM.distill, 增强版 — 含 plan + stats)
  // ═══════════════════════════════════════════════════════

  /**
   * 蒸馏 ActiveContext 为结构化报告
   * 在 Agent execute 结束时调用，结果写入 SessionStore
   */
  distill(): DistilledContext {
    return {
      keyFindings: this.#scratchpad.map((f) => ({
        finding: f.finding,
        evidence: f.evidence,
        importance: f.importance,
      })),
      toolCallSummary: this.#compressedObservations.map(
        (s) => `[${s.toolName}] ${s.summary.substring(0, 150)}`
      ),
      stats: this.getStats(),
      plan: this.getPlan(),
      totalObservations: this.#totalObservations,
      compressedCount: this.#compressedObservations.length,
    };
  }

  // ═══════════════════════════════════════════════════════
  // §2.7: 分析方法 (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * 获取所有有 Thought 的轮次
   * @returns >}
   */
  getThoughts() {
    return this.#rounds
      .filter((r) => r.thought)
      .map((r) => ({ iteration: r.iteration, thought: r.thought }));
  }

  /**
   * 获取最近 N 轮的紧凑摘要 (ExplorationTracker.#checkReflection 使用)
   * @param [n=3] 回看轮数
   */
  getRecentSummary(n = 3) {
    const recent = this.#rounds.slice(-n);
    if (recent.length === 0) {
      return null;
    }

    const thoughts = recent
      .filter((r): r is Round & { thought: string } => r.thought !== null)
      .map((r) => (r.thought.length > 100 ? `${r.thought.substring(0, 100)}…` : r.thought));

    const tools = recent.flatMap((r) => r.actions.map((a) => a.tool));

    const newInfoCount = recent.reduce(
      (c, r) => c + r.observations.filter((o) => o.gotNewInfo).length,
      0
    );
    const totalObs = recent.reduce((c, r) => c + r.observations.length, 0);

    return {
      roundCount: recent.length,
      thoughts,
      toolCalls: tools,
      newInfoRatio: totalObs > 0 ? newInfoCount / totalObs : 0,
      lastIteration: recent[recent.length - 1].iteration,
    };
  }

  /** 统计指标 (ExplorationTracker.getQualityMetrics 使用) */
  getStats() {
    return {
      totalRounds: this.#rounds.length,
      thoughtCount: this.#rounds.filter((r) => r.thought).length,
      totalActions: this.#rounds.reduce((c, r) => c + r.actions.length, 0),
      totalObservations: this.#rounds.reduce((c, r) => c + r.observations.length, 0),
      reflectionCount: this.#rounds.filter((r) => r.reflection).length,
      totalDurationMs: this.#rounds.reduce(
        (d, r) => d + ((r.endTime || Date.now()) - r.startTime),
        0
      ),
    };
  }

  // ═══════════════════════════════════════════════════════
  // §2.8: Scratchpad 查询 (从 WorkingMemory 继承)
  // ═══════════════════════════════════════════════════════

  /** 获取 scratchpad 中的关键发现数量 */
  get scratchpadSize() {
    return this.#scratchpad.length;
  }

  /** 获取总观察数 */
  get totalObservations() {
    return this.#totalObservations;
  }

  /**
   * 获取 scratchpad 中的高重要性发现
   * @returns >}
   */
  getHighPriorityFindings(minImportance = 7) {
    return this.#scratchpad
      .filter((f) => f.importance >= minImportance)
      .sort((a, b) => b.importance - a.importance);
  }

  // ═══════════════════════════════════════════════════════
  // §2.9: 序列化 (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /** 可序列化输出 */
  toJSON() {
    return {
      rounds: this.#rounds.map((r) => ({ ...r })),
      stats: this.getStats(),
      scratchpad: this.#scratchpad.map((f) => ({ ...f })),
      compressedObservations: this.#compressedObservations.length,
      totalObservations: this.#totalObservations,
      ...(this.#plan
        ? {
            plan: {
              text: this.#plan.text,
              steps: this.#plan.steps.map((s) => ({ ...s })),
              createdAtIteration: this.#plan.createdAtIteration,
              lastUpdatedAtIteration: this.#plan.lastUpdatedAtIteration,
            },
            planHistory: this.#planHistory.length,
          }
        : {}),
    };
  }

  /**
   * 从 JSON 恢复 ActiveContext (断点续传)
   * @param json toJSON() 的输出
   */
  static fromJSON(json: ActiveContextJSON) {
    const ctx = new ActiveContext();
    if (json.rounds) {
      ctx.#rounds = json.rounds.map((r) => ({ ...r }));
    }
    if (json.scratchpad) {
      ctx.#scratchpad = json.scratchpad.map((f) => ({ ...f }));
    }
    if (json.totalObservations) {
      ctx.#totalObservations = json.totalObservations;
    }
    if (json.plan) {
      ctx.#plan = {
        text: json.plan.text,
        steps: json.plan.steps.map((s) => ({ ...s })),
        createdAtIteration: json.plan.createdAtIteration,
        lastUpdatedAtIteration: json.plan.lastUpdatedAtIteration,
      };
    }
    return ctx;
  }

  /** 清空 ActiveContext — 释放内存 */
  clear() {
    this.#scratchpad.length = 0;
    this.#rounds.length = 0;
    this.#currentRound = null;
    this.#recentObservations.length = 0;
    this.#compressedObservations.length = 0;
    this.#plan = null;
    this.#planHistory.length = 0;
    this.#totalObservations = 0;
  }

  // ═══════════════════════════════════════════════════════
  // §2.10: 静态工具 (从 ReasoningTrace 迁入)
  // ═══════════════════════════════════════════════════════

  /**
   * 从工具执行结果构建结构化观察元数据
   * 不改变工具结果传给 AI 的内容，只影响推理链记录
   *
   * @param isNew 由 ExplorationTracker.recordToolCall 提供
   * @returns }
   */
  static buildObservationMeta(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    isNew: boolean
  ) {
    const meta = {
      gotNewInfo: isNew,
      resultType: 'unknown',
      keyFacts: [] as string[],
      resultSize: 0,
    };

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result || '');
    meta.resultSize = resultStr.length;

    const envelope = isToolResultEnvelope(result) ? result : null;

    switch (toolName) {
      case 'code': {
        const action = (args?.action as string) || '';
        if (action === 'search') {
          meta.resultType = 'search';
          // V2 搜索结果为紧凑文本 "N matches (showing M)\n\nfile:line: content"
          const matchCount =
            typeof result === 'string' ? ((result.match(/^(\d+) matches/) ?? [])[1] ?? '?') : '?';
          meta.keyFacts.push(`${matchCount} matches found`);
          if (isNew) {
            meta.keyFacts.push('new files discovered');
          }
        } else if (action === 'read' || action === 'outline') {
          meta.resultType = action === 'read' ? 'file_content' : 'outline';
          const fp = (args?.path as string) || '';
          if (fp) {
            meta.keyFacts.push(`${action} ${fp}`);
          }
        } else if (action === 'write') {
          meta.resultType = 'write';
          const fp = (args?.path as string) || '';
          if (fp) {
            meta.keyFacts.push(`write ${fp}`);
          }
        } else if (action === 'structure') {
          meta.resultType = 'structure';
          meta.keyFacts.push(`list ${(args?.directory as string) || '/'}`);
        } else {
          meta.resultType = action || 'code';
          meta.keyFacts.push(`code.${action}`);
        }
        break;
      }
      case 'knowledge': {
        const action = (args?.action as string) || '';
        if (action === 'submit' || action === 'submit_batch') {
          meta.resultType = 'submit';
          meta.gotNewInfo = true;
          const title = (args?.title as string) || '(untitled)';
          meta.keyFacts.push(`submit "${title}"`);
        } else {
          meta.resultType = 'query';
          meta.keyFacts.push(`knowledge.${action}`);
        }
        break;
      }
      case 'graph': {
        meta.resultType = 'ast_query';
        const action = (args?.action as string) || '';
        const type = (args?.type as string) || '';
        const entity = (args?.entity as string) || '';
        meta.keyFacts.push(`graph.${action}(${type}${entity ? `:${entity}` : ''})`);
        break;
      }
      case 'terminal': {
        meta.resultType = 'terminal';
        const cmd = (args?.command as string) || '';
        meta.keyFacts.push(`exec: ${cmd.substring(0, 60)}`);
        break;
      }
      case 'memory': {
        meta.resultType = 'memory';
        meta.keyFacts.push(`memory.${(args?.action as string) || ''}`);
        break;
      }
      case 'meta': {
        meta.resultType = 'meta';
        meta.keyFacts.push(`meta.${(args?.action as string) || ''}`);
        break;
      }
      default: {
        meta.resultType = 'other';
        meta.keyFacts.push(toolName);
      }
    }

    if (envelope) {
      meta.resultType = envelope.status;
      meta.keyFacts.push(
        envelope.parentCallId
          ? `${toolName} ${envelope.status} (${envelope.callId} child of ${envelope.parentCallId})`
          : `${toolName} ${envelope.status} (${envelope.callId})`
      );
      Object.assign(meta, {
        toolCall: {
          callId: envelope.callId,
          ...(envelope.parentCallId ? { parentCallId: envelope.parentCallId } : {}),
          status: envelope.status,
          ok: envelope.ok,
          durationMs: envelope.durationMs,
        },
      });
    }

    return meta;
  }

  // ═══════════════════════════════════════════════════════
  // §3: 私有方法
  // ═══════════════════════════════════════════════════════

  /**
   * 工具结果压缩 — 使用特化策略 (从 WorkingMemory 迁入)
   * @param observation
   * @returns }
   */
  #compressObservation(observation: Observation): CompressedObservation {
    const strategy = (TOOL_COMPRESS_STRATEGIES as Record<string, (result: unknown) => string>)[
      observation.toolName
    ];
    let summary: string;
    try {
      summary = strategy ? strategy(observation.result) : defaultCompress(observation.result);
    } catch {
      summary = defaultCompress(observation.result);
    }
    return {
      toolName: observation.toolName,
      round: observation.round,
      summary,
      ledgerItems: this.#extractObservationLedgerItems(observation, summary),
    };
  }

  #buildObservationLedgerSection(tokenBudget: number): string | null {
    const ledger = new Map<ObservationLedgerCategory, ObservationLedgerItem[]>();
    for (const observation of this.#compressedObservations) {
      const items =
        observation.ledgerItems.length > 0
          ? observation.ledgerItems
          : [
              {
                category: 'evidence' as const,
                key: `${observation.toolName}:${normalizeLedgerKey(observation.summary)}`,
                text: `${observation.toolName} observed ${sanitizeLedgerText(observation.summary, 180)}`,
                round: observation.round,
                toolName: observation.toolName,
              },
            ];
      for (const item of items) {
        const bucket = ledger.get(item.category) || [];
        if (!bucket.some((existing) => existing.key === item.key)) {
          bucket.push(item);
          ledger.set(item.category, bucket);
        }
      }
    }

    const lines = ['## Observation Ledger'];
    let remaining = tokenBudget - this.#estimateTokens(lines[0]);
    for (const category of OBSERVATION_LEDGER_CATEGORIES) {
      const items = (ledger.get(category) || []).slice(-OBSERVATION_LEDGER_LIMITS[category]);
      if (items.length === 0 || remaining <= 0) {
        continue;
      }
      const categoryLines = [`### ${category}`];
      for (const item of items) {
        const line = `- [R${item.round}|${item.toolName}] ${item.text}`;
        const lineTokens = this.#estimateTokens(line);
        if (lineTokens > remaining) {
          break;
        }
        categoryLines.push(line);
        remaining -= lineTokens;
      }
      if (categoryLines.length > 1) {
        lines.push(categoryLines.join('\n'));
      }
    }

    return lines.length > 1 ? lines.join('\n') : null;
  }

  #extractObservationLedgerItems(
    observation: Observation,
    summary: string
  ): ObservationLedgerItem[] {
    const envelope = isToolResultEnvelope(observation.result) ? observation.result : null;
    const structured = envelope?.structuredContent ?? observation.result;
    const args = observation.args || {};
    const action = stringFrom(args.action);
    const items: ObservationLedgerItem[] = [];
    const ok = envelope ? envelope.ok && envelope.status === 'success' : true;

    if (!ok) {
      const failureText = sanitizeLedgerText(envelope?.text || summary || 'tool call failed', 180);
      items.push(
        this.#ledgerItem(
          'failureSet',
          `${observation.toolName}:${action}:${failureText}`,
          `${formatToolAction(observation.toolName, action)} failed: ${failureText}`,
          observation
        )
      );
    }

    if (envelope?.nextActionHint) {
      items.push(
        this.#ledgerItem(
          'nextHints',
          `${observation.toolName}:${action}:${envelope.nextActionHint}`,
          sanitizeLedgerText(envelope.nextActionHint, 180),
          observation
        )
      );
    } else if (!ok) {
      items.push(
        this.#ledgerItem(
          'nextHints',
          `${observation.toolName}:${action}:retry`,
          `Retry or verify ${formatToolAction(observation.toolName, action)} with narrower inputs.`,
          observation
        )
      );
    }

    if (observation.toolName === 'code') {
      if (action === 'read') {
        const paths = extractReadPaths(args, structured);
        for (const filePath of paths) {
          items.push(
            this.#ledgerItem('readSet', `read:${filePath}`, filePath, observation),
            this.#ledgerItem(
              'evidence',
              `read:${filePath}`,
              `${ok ? 'Read' : 'Attempted read'} ${filePath}`,
              observation
            )
          );
        }
      } else if (action === 'search') {
        const searches = extractSearches(args, structured, envelope?.text);
        for (const search of searches) {
          items.push(
            this.#ledgerItem('searchSet', `search:${search}`, search, observation),
            this.#ledgerItem('evidence', `search:${search}`, `Searched ${search}`, observation)
          );
        }
      } else if (action) {
        const target = sanitizeLedgerText(
          stringFrom(args.path) || stringFrom(args.directory) || action,
          120
        );
        items.push(
          this.#ledgerItem(
            ok ? 'evidence' : 'failureSet',
            `code:${action}:${target}`,
            `${ok ? 'Ran' : 'Failed'} code.${action} ${target}`,
            observation
          )
        );
      }
    } else if (observation.toolName === 'graph') {
      const graphTarget = [
        action || 'query',
        stringFrom(args.type),
        stringFrom(args.entity) || stringFrom(args.className) || stringFrom(args.protocolName),
      ]
        .filter(Boolean)
        .join(':');
      items.push(
        this.#ledgerItem(
          ok ? 'evidence' : 'failureSet',
          `graph:${graphTarget || summary}`,
          `${ok ? 'Queried' : 'Failed'} graph ${sanitizeLedgerText(graphTarget || summary, 160)}`,
          observation
        )
      );
    } else if (observation.toolName === 'terminal') {
      const command = sanitizeLedgerText(stringFrom(args.command) || summary, 160);
      items.push(
        this.#ledgerItem(
          ok ? 'evidence' : 'failureSet',
          `terminal:${command}`,
          `${ok ? 'Ran' : 'Failed'} terminal command: ${command}`,
          observation
        )
      );
    } else if (observation.toolName !== 'memory' && observation.toolName !== 'note_finding') {
      items.push(
        this.#ledgerItem(
          ok ? 'evidence' : 'failureSet',
          `${observation.toolName}:${action}:${summary}`,
          `${ok ? 'Observed' : 'Failed'} ${formatToolAction(observation.toolName, action)}: ${sanitizeLedgerText(summary, 180)}`,
          observation
        )
      );
    }

    return items;
  }

  #ledgerItem(
    category: ObservationLedgerCategory,
    key: string,
    text: string,
    observation: Observation
  ): ObservationLedgerItem {
    return {
      category,
      key: normalizeLedgerKey(key),
      text: sanitizeLedgerText(text, 220),
      round: observation.round,
      toolName: observation.toolName,
    };
  }

  /** 粗糙 token 估算 (1 token ≈ 4 chars) */
  #estimateTokens(text: string) {
    return Math.ceil((text || '').length / 4);
  }

  // ── Plan 内部方法 (从 ReasoningTrace 迁入) ──

  #setPlan(planText: string, iteration: number) {
    this.#plan = {
      text: planText,
      steps: this.#parsePlanSteps(planText),
      createdAtIteration: iteration,
      lastUpdatedAtIteration: iteration,
    };
  }

  #updatePlan(replanText: string, iteration: number) {
    if (!this.#plan) {
      this.#setPlan(replanText, iteration);
      return;
    }
    this.#planHistory.push({ ...this.#plan, steps: this.#plan.steps.map((s) => ({ ...s })) });
    this.#plan.text = replanText;
    this.#plan.steps = this.#parsePlanSteps(replanText);
    this.#plan.lastUpdatedAtIteration = iteration;
  }

  /** 从 AI 文本中解析计划步骤 */
  #parsePlanSteps(text: string): PlanStep[] {
    if (!text) {
      return [];
    }
    const lines = text.split('\n');
    const steps: PlanStep[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*(?:\d+[.)]\s*|[-*]\s+)(.+)/);
      if (m && m[1].trim().length > 5) {
        steps.push({
          description: m[1].trim(),
          status: 'pending',
          keywords: this.#extractKeywords(m[1]),
        });
      }
    }
    return steps;
  }

  /** 从步骤描述中提取关键词 */
  #extractKeywords(text: string): string[] {
    const quoted = [...text.matchAll(/[`"']([A-Za-z_]\w{2,})[`"']/g)].map((m) => m[1]);
    const camelCase = [...text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)].map((m) => m[0]);
    const acronyms = [...text.matchAll(/\b([A-Z]{2,}[a-z]\w+)\b/g)].map((m) => m[0]);
    return [...new Set([...quoted, ...camelCase, ...acronyms])];
  }

  /** 从 AI 响应文本中提取"计划"部分 */
  #extractPlanFromText(text: string): string | null {
    if (!text || text.length < 30) {
      return null;
    }

    const searchArea = text.substring(0, 2000);

    const planMarkers = [
      /(?:探索|分析)?计划[:：\s]/i,
      /(?:my\s+)?plan[:：\s]/i,
      /步骤[:：\s]/i,
      /以下是.*(?:计划|步骤)/i,
    ];

    let planStart = -1;
    for (const marker of planMarkers) {
      const match = searchArea.match(marker);
      if (match && match.index !== undefined) {
        planStart = match.index + match[0].length;
        break;
      }
    }

    if (planStart === -1) {
      const listMatch = searchArea.match(/\n\s*1[.)]\s+/);
      if (listMatch && listMatch.index !== undefined) {
        planStart = listMatch.index;
      }
    }

    if (planStart === -1) {
      return null;
    }

    const remaining = searchArea.substring(planStart);
    const lines = remaining.split('\n');
    const planLines: string[] = [];
    let inList = false;

    for (const line of lines) {
      if (/^\s*(?:\d+[.)]\s+|[-*]\s+)/.test(line)) {
        inList = true;
        planLines.push(line);
      } else if (inList && line.trim() === '') {
        break;
      } else if (inList) {
        break;
      }
    }

    if (planLines.length < 2) {
      return null;
    }

    // 防御: 拒绝 "大部分是疑问句" 的编号列表
    // reflection nudge 的 "请评估: 1. ...是什么？ 2. ...？" 会被 LLM 回显，
    // 不是真正的探索计划，不能捕获为 plan steps
    const questionCount = planLines.filter((l) => /[？?]\s*$/.test(l.trim())).length;
    if (questionCount > planLines.length * 0.5) {
      return null;
    }

    return planLines.join('\n').trim();
  }
}

function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ToolResultEnvelope).toolId === 'string' &&
    typeof (value as ToolResultEnvelope).callId === 'string' &&
    typeof (value as ToolResultEnvelope).status === 'string'
  );
}

function extractReadPaths(args: Record<string, unknown>, structured: unknown): string[] {
  const paths = new Set<string>();
  addString(paths, args.path);
  addStringList(paths, args.filePaths);

  const structuredObj = objectFrom(structured);
  addString(paths, structuredObj?.path);
  const files = Array.isArray(structuredObj?.files) ? structuredObj.files : [];
  for (const file of files) {
    const fileObj = objectFrom(file);
    addString(paths, fileObj?.path);
  }

  return [...paths].map((p) => sanitizeLedgerText(p, 180)).filter(Boolean);
}

function extractSearches(
  args: Record<string, unknown>,
  structured: unknown,
  text?: string
): string[] {
  const searches = new Set<string>();
  const glob = stringFrom(args.glob);
  const patterns = stringListFrom(args.patterns);
  const pattern = stringFrom(args.pattern);
  for (const p of patterns.length > 0 ? patterns : [pattern].filter(Boolean)) {
    searches.add(`${p}${glob ? ` in ${glob}` : ''}`);
  }

  const structuredObj = objectFrom(structured);
  const total = typeof structuredObj?.total === 'number' ? structuredObj.total : null;
  const matches = Array.isArray(structuredObj?.matches) ? structuredObj.matches : [];
  for (const match of matches.slice(0, 5)) {
    const matchObj = objectFrom(match);
    const file = stringFrom(matchObj?.file);
    const line = typeof matchObj?.line === 'number' ? matchObj.line : null;
    if (file) {
      searches.add(`${file}${line ? `:${line}` : ''}`);
    }
  }
  if (total === 0 && searches.size > 0) {
    searches.add('no matches returned');
  }

  const firstLine = text?.split('\n').find((line) => line.trim());
  if (firstLine && /^\d+ matches\b/.test(firstLine.trim())) {
    searches.add(firstLine.trim());
  }

  return [...searches].map((entry) => sanitizeLedgerText(entry, 180)).filter(Boolean);
}

function sanitizeLedgerText(value: unknown, maxChars = 220): string {
  const raw = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const jsonLike = compactJsonForLedger(raw);
  if (jsonLike) {
    return limitLedgerText(jsonLike, maxChars);
  }
  const withoutJsonDebugFields = raw.replace(
    /"?(?:callId|parentCallId|startedAt|durationMs|timestamp|diagnostics|structuredContent|_meta)"?\s*:\s*(?:"[^"]*"|[\d.]+|true|false|null|\{[^}]*\}|\[[^\]]*\]),?/gi,
    ''
  );
  const withoutDebugWords = withoutJsonDebugFields.replace(
    /\b(callId|parentCallId|startedAt|durationMs|timestamp|diagnostics|structuredContent|_meta)\b/gi,
    'metadata'
  );
  const compact = withoutDebugWords.replace(/\s+/g, ' ').trim();
  return limitLedgerText(compact, maxChars);
}

function compactJsonForLedger(raw: string): string | null {
  if (!raw.startsWith('{') && !raw.startsWith('[')) {
    return null;
  }
  try {
    return compactLedgerValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function compactLedgerValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .slice(0, 6)
      .map((item) => compactLedgerValue(item))
      .filter(Boolean)
      .join('; ');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PROVIDER_DEBUG_KEYS.has(key))
      .map(([key, item]) => `${key}: ${compactLedgerValue(item)}`)
      .filter((entry) => entry.trim() !== '')
      .join('; ');
  }
  return String(value ?? '').trim();
}

function limitLedgerText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…`;
}

function normalizeLedgerKey(value: unknown): string {
  return sanitizeLedgerText(value, 260).toLowerCase();
}

function formatToolAction(toolName: string, action: string): string {
  return action ? `${toolName}.${action}` : toolName;
}

function objectFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function stringListFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringFrom(item)).filter(Boolean);
}

function addString(target: Set<string>, value: unknown) {
  const text = stringFrom(value);
  if (text) {
    target.add(text);
  }
}

function addStringList(target: Set<string>, value: unknown) {
  for (const item of stringListFrom(value)) {
    target.add(item);
  }
}

export default ActiveContext;
