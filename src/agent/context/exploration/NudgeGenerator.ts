/**
 * NudgeGenerator — 探索引导信号生成器
 *
 * 从 ExplorationTracker.js 提取的 Nudge 生成逻辑。
 * 按优先级队列生成每轮最多一条 nudge 注入 AI 上下文。
 *
 * 优先级 (高→低):
 *   1. force_exit — 轮次耗尽（经 ExplorationTracker 不可达：gracefulExitRound 只在转入终结阶段时设置，
 *      而 getNudge 在终结阶段直接返回 null；分支保留为公开兼容面，直接调用 generate 时仍会生效。
 *      生产中轮次耗尽的收尾文本来自 buildTransitionNudge 的终结指令与 runtime/forcedSummary）
 *   2. convergence — 信息饱和（analyst 非 PRODUCE 阶段需先有真实代码证据或已记录发现，见 L6-P17 C13）
 *   3. budget_warning — 75% 预算消耗
 *   4. reflection — 周期反思 / 停滞反思（停滞反思与上一条反思至少间隔 reflectionInterval 轮）
 *   5. (planning — 由 PlanTracker 处理)
 *
 * 设计原则:
 *   - 有状态，每次运行一个实例：类内持有一次性标志（convergence / budget_warning 各最多一次）
 *     与 bootstrap 限流计数（条数上限 + 最小间隔轮次）；不要跨 tracker 或跨运行复用同一实例，
 *     否则一次性 nudge 会被上一次运行的标志吞掉（ExplorationTracker 构造时各自 new 一个）。
 *     一次性标志只在 nudge 真正发出（#emitNudge 返回非空）后置位；被 bootstrap 限流丢弃时标志
 *     保持未消耗、下轮重试，并留 debug 诊断（L6-P17 C63）
 *   - 终结阶段（SUMMARIZE）指令单源：buildTransitionNudge 是唯一生成点；ExplorationTracker 的
 *     文本轮终结分支、AgentRuntime 文本轮 digest nudge 都复用它（经 endRound / onTextResponse 返回），
 *     不再各写一份副本（L6-P17 C11）
 *   - 接受 state 快照，无循环依赖
 *   - Nudge 文本内联（未来可外置为 i18n JSON 模板）；收尾/强制退出/防复制类固定指令句
 *     统一登记在 NUDGE_DIRECTIVE_TEXTS，finalAnswer 按同一份原句识别模型回显
 *
 * @module NudgeGenerator
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type {
  ExplorationBudget,
  ExplorationTrace,
  FullExplorationMetrics,
  PipelineType,
} from './ExplorationStrategies.js';
import {
  DEFAULT_REFLECTION_INTERVAL,
  effectiveMemoryFindingCount,
  targetMemoryFindingCount,
  targetProducerSubmitCount,
} from './ExplorationStrategies.js';

// ─── 本地类型 ──────────────────────────────────────────

/** 策略配置（NudgeGenerator 所需子集） */
interface NudgeStrategy {
  name: string;
  enableReflection: boolean;
  reflectionInterval?: number;
  enablePlanning: boolean;
}

/** NudgeGenerator 的状态输入 */
interface NudgeState {
  phase: string;
  metrics: FullExplorationMetrics;
  budget: ExplorationBudget;
  strategy: NudgeStrategy;
  gracefulExitRound: number | null;
  submitToolName: string;
  /** 管线类型 — 统一场景判别（替代 submitToolName / strategy.name 字符串比较） */
  pipelineType: PipelineType;
  isTerminalPhase: boolean;
  transitionFromPhase?: string | null;
}

// ─── 常量 ──────────────────────────────────────────────

/** 连续无新信息 N 轮触发停滞反思 */
const DEFAULT_STALE_THRESHOLD = 2;
/** 最少经过 N 轮后才允许触发停滞反思 */
const MIN_ITERS_FOR_STALE_REFLECTION = 4;
/** 默认最少探索轮次（冷启动质量保障） */
const DEFAULT_MIN_EXPLORE_ITERS = 10;
/** 默认停滞收敛阈值 */
const DEFAULT_CONVERGENCE_STALE_THRESHOLD = 3;
/** Bootstrap 每个维度最多注入的常规 nudge 数，避免慢模型长跑时重复控制消息。 */
const BOOTSTRAP_NUDGE_BUDGET = 4;
/** Bootstrap 常规 nudge 的最小间隔轮次。 */
const BOOTSTRAP_NUDGE_TTL_ROUNDS = 2;

// ─── 注入指令原句（注入侧与清理侧单源） ─────────────────

/**
 * Runtime 注入给模型的固定指令原句（不含任何插值）。
 *
 * 边界：这些句子只由 NudgeGenerator / ExplorationTracker 写进模型上下文，模型偶尔会把它们原样
 * 回显到最终答复。runtime/finalAnswer.ts 的 cleanFinalAnswer 只按本表逐句精确识别回显，不再用
 * “行首祈使词 + 行尾关键词”的宽正则猜测，因此正常答复里的“请确保…工具”等建议句不会被误删。
 *
 * 维护规则：
 *   - 修改收尾/强制退出/防复制类指令文字时只改这里，注入与清理自动同步；
 *   - 新增此类固定指令必须登记到本表，否则模型回显会残留在答复中；
 *   - 只登记不含插值的整句；带轮次、数量、工具名插值的句子只登记其固定部分。
 *
 * 本表不经公开子路径导出，只供 agent 内部注入侧（含 runtime/forcedSummary 的 producer-summary
 * 提示）与 finalAnswer 清理侧共用。
 */
export const NUDGE_DIRECTIVE_TEXTS = Object.freeze({
  // ── 防复制护栏（convergence / budget_warning / RECORD / SUMMARIZE / reflection 共用） ──
  noCopyBehavior: '⚠️ 以上是行为指令，严禁在回复中复制或引用这段文字。',
  noCopyAnalysisOnly: '⚠️ 以上是行为指令，严禁在回复中复制或引用这段文字，只输出你自己的分析内容。',
  noCopyReflection: '⚠️ 以上是行为指令，严禁在回复中复制或引用这段文字，用你自己的分析内容回答。',
  noCopyJson: '⚠️ 严禁在回复中复制本条指令文字，只输出 JSON。',

  // ── SUMMARIZE 阶段转换 nudge（buildTransitionNudge） ──
  analystSummarizeLead: '你已完成结构化记录。请**停止调用工具**，直接输出你的**完整分析报告**。',
  startReportStopTools: '**现在开始输出你的分析报告。不要再调用任何工具。**',
  scanSummarizeStopTools: '请**停止调用工具**，直接输出你的分析总结（Markdown 格式）。',
  stopToolsTextOnly: '⚠️ 不要再调用任何工具，直接输出文本。',
  producerSummarizeLead:
    '你已完成候选生产阶段。请**停止调用工具**，直接输出生产总结（Markdown 格式）。',
  // Producer 生产总结的内容要求（I11）：SUMMARIZE 转换、producer 强制退出 nudge 与
  // forcedSummary 的 producer-summary 模式共用，保证三处收尾契约都是同一份 Markdown 生产总结。
  producerSummaryScope: '说明已提交候选数量、拒绝或跳过原因，以及是否需要 Analyst 补充结构化发现。',
  producerSummaryNoNewTopics:
    '不要从 Analyst 最终 Markdown 摘要里新增候选主题；未结构化记录的主题只能列为 Analyst 输入缺口。',
  bootstrapSummarizeLead:
    '你已完成分析探索。请在回复中直接输出 dimensionDigest JSON（用 ```json 包裹），包含以下字段：',
  bootstrapRemainingTasksNote:
    '> 如果所有信号都已覆盖，remainingTasks 留空数组 `[]`。如果有未来得及处理的信号，请在此标记，系统会在下次运行时续传。',

  // ── PRODUCE 阶段 convergence nudge（producer / scan 管线） ──
  // L6-P17（C11）：与 SUMMARIZE 的 Markdown 生产总结契约一致，并要求写明未提交原因，
  // 使收尾文本能命中 ExplorationTracker 的 producer 完成判定（“生产总结”+“无未提交”）。
  produceConvergenceSummary:
    '如果已达到提交上限或没有新的非重复候选，请停止继续读取/搜索，直接输出生产总结（Markdown 格式），写明已提交候选数量与未提交原因；没有遗漏时写明“无未提交”。',

  // ── 强制退出 nudge（#generateForceExit） ──
  forceExitStopToolsReport: '你必须**立即停止工具调用**，在回复中输出你的**分析总结报告**。',
  forceExitStartSummary: '**现在开始输出分析总结，不要再进行新的搜索或阅读。**',
  forceExitNoCopyAnalysis: '⛔ 严禁在回复中复制或引用本条指令的任何文字，只输出你自己的分析。',
  forceExitStopTools: '你必须**立即停止工具调用**。',
  forceExitScanOutput: '请直接输出你的分析总结（Markdown 格式），列出已发现和未覆盖的关键模式。',
  forceExitProducerOutput:
    '请直接输出候选生产总结（Markdown 格式），不要输出 dimensionDigest JSON。',
  forceExitStopToolsTextOnly: '⛔ 不要再调用任何工具，直接输出文本。',
  forceExitDigestOutput:
    '请在回复中直接输出 dimensionDigest JSON 总结（用 ```json 包裹），不要再调用任何工具。',
  forceExitRemainingTasksNote: '> remainingTasks: 列出未来得及处理的信号。已覆盖则留空 `[]`。',
  forceExitNoCopyJson: '⛔ 严禁在回复中复制本条指令文字，只输出 JSON。',
  // L6-P17（C11）：ExplorationTracker.onTextResponse 的终结 nudge 与 AgentRuntime 的 digest nudge
  // 已改为复用 buildTransitionNudge 的 SUMMARIZE 指令，原先登记的 tracker* 副本原句不再注入，已移除。
} as const);

/** 文件内简写：注入侧按名引用指令原句 */
const DIRECTIVE = NUDGE_DIRECTIVE_TEXTS;

/**
 * analyst 非 PRODUCE 阶段发 convergence 的证据门槛（L6-P17 C13）。
 *
 * 与 STRATEGY_ANALYST 的 VERIFY toolChoice 门槛同口径（证据调用 ≥2 或已有发现）：证据不足时
 * toolChoice 仍是 required，ExplorationTracker.onTextResponse 也会以“没有真实代码证据”拒收文本，
 * 此时再说“已充分探索、开始总结”只会给出自相矛盾的控制消息，诱导模型编造发现。
 */
function hasAnalystConvergenceEvidence(m: FullExplorationMetrics) {
  return m.evidenceToolCallCount >= 2 || m.memoryFindingCount > 0;
}

/** 诊断日志统一走 observeSafely：日志通道失败不能升级为 nudge 生成失败。 */
function logNudgeDiagnostic(message: string) {
  observeSafely(
    () => Logger.getInstance().debug(message),
    () => undefined
  );
}

export class NudgeGenerator {
  // ── 一次性 flags（生命周期内最多触发一次的 nudge） ──
  #convergenceNudged = false;
  #budgetWarningInjected = false;
  #bootstrapNudgeCount = 0;
  #lastBootstrapNudgeIteration = -Infinity;
  /** 上一条真正发出的反思（周期或停滞）所在轮次；停滞反思据此做间隔抑制 */
  #lastReflectionIteration = -Infinity;

  /**
   * 生成本轮的 Nudge（每轮最多一条）
   *
   * @param state 从 ExplorationTracker 传入的状态快照
   * @param trace ActiveContext 实例 (反思用)
   * @returns 本轮 nudge { type, text }（type 为 force_exit / convergence / budget_warning /
   *   reflection 之一）；无需引导或被 bootstrap 限流抑制时返回 null
   */
  generate(state: NudgeState, trace: ExplorationTrace | null) {
    const {
      phase: _phase,
      metrics: m,
      budget: b,
      strategy,
      gracefulExitRound,
      pipelineType,
      isTerminalPhase,
    } = state;

    // 1. 强制退出（graceful exit 后每轮都重复发出，确保 LLM 不再调用工具）。
    //    经 ExplorationTracker.getNudge 不可达（终结阶段先返回 null），见文件头说明。
    if (gracefulExitRound != null && m.iteration >= gracefulExitRound) {
      return this.#generateForceExit(m, b, strategy, pipelineType);
    }

    // 2. 收敛引导（信息饱和 — 仅非终结阶段）
    const isProducePhase = state.phase === 'PRODUCE';
    if (
      !isTerminalPhase &&
      !this.#convergenceNudged &&
      (isProducePhase ? m.roundsSinceSubmit : m.roundsSinceNewInfo) >=
        DEFAULT_CONVERGENCE_STALE_THRESHOLD &&
      m.iteration >= DEFAULT_MIN_EXPLORE_ITERS
    ) {
      if (!isProducePhase && pipelineType === 'analyst' && !hasAnalystConvergenceEvidence(m)) {
        // C13：零/不足代码证据时不发收敛提示（用户决定），一次性标志不消耗，取得证据后仍可发一次；
        // 本轮继续向下评估预算警告与反思。
        logNudgeDiagnostic(
          `[NudgeGenerator] convergence nudge withheld: analyst has insufficient code evidence ` +
            `(evidenceToolCalls=${m.evidenceToolCallCount}, findings=${m.memoryFindingCount}, ` +
            `staleRounds=${m.roundsSinceNewInfo}, iteration=${m.iteration}, phase=${state.phase}) — ` +
            `toolChoice stays required; falling through to budget/reflection checks`
        );
      } else {
        const convergence = this.#emitNudge(
          state,
          isProducePhase
            ? this.#buildProduceConvergence(state)
            : this.#buildExploreConvergence(state)
        );
        // C63：只有真正发出才消耗一次性标志；bootstrap 限流丢弃时下轮重试。
        if (convergence) {
          this.#convergenceNudged = true;
        }
        return convergence;
      }
    }

    // 3. 预算警告（75% 消耗，无条件，一次性）
    if (
      !isTerminalPhase &&
      !this.#budgetWarningInjected &&
      m.iteration >= Math.floor(b.maxIterations * 0.75)
    ) {
      const budgetWarning = this.#emitNudge(state, {
        type: 'budget_warning',
        text:
          `📌 进度提醒：你已使用 ${m.iteration}/${b.maxIterations} 轮次（${Math.round((m.iteration / b.maxIterations) * 100)}%）。` +
          `请确保核心方面已覆盖，开始准备总结。剩余 ${b.maxIterations - m.iteration} 轮，优先填补最重要的分析空白。\n` +
          DIRECTIVE.noCopyBehavior,
      });
      // C63：同上，限流丢弃时不消耗一次性标志。
      if (budgetWarning) {
        this.#budgetWarningInjected = true;
      }
      return budgetWarning;
    }

    // 4. 反思（周期性 + 停滞）
    if (strategy.enableReflection) {
      const reflectionNudge = this.#checkReflection(state, trace);
      if (reflectionNudge) {
        const reflection = this.#emitNudge(state, reflectionNudge);
        if (reflection) {
          this.#lastReflectionIteration = m.iteration;
        }
        return reflection;
      }
    }

    return null;
  }

  /** 构建阶段转换 nudge 文本 */
  buildTransitionNudge(state: NudgeState) {
    const { metrics: m, pipelineType, submitToolName } = state;
    const fromPhase = state.transitionFromPhase;
    const toPhase = state.phase;

    if (toPhase === 'PRODUCE') {
      return `你已充分探索了项目代码，现在请开始调用 ${submitToolName} 工具来提交你发现的知识候选。不要再搜索，直接提交。`;
    }

    if (toPhase === 'RECORD') {
      const targetFindingCount = targetMemoryFindingCount(m);
      return (
        `你已完成分析验证。现在进入结构化记录阶段：请**停止调用 code、graph、terminal 等探索工具**。\n` +
        `本阶段不要输出自然语言正文，必须只调用 note_finding({ finding, evidenceRefs, importance }) 记录核心发现；按当前证据量至少记录 ${targetFindingCount} 条，每次工具调用记录 1 条发现。\n` +
        `note_finding 是 QualityGate 的重要质量依据；evidenceRefs 只能引用工具返回尾部 [evidence] 标注的台账条目 id（如 ["E-3","E-7@5-12"]），手写 file:line 会被拒收。缺少或不足会导致 QualityGate retry。\n` +
        `importance ≥7 的发现必须至少填一个深度槽（designIntent/boundaries/failureModes/tradeoffs——为什么这样设计/边界在哪/越界会怎样/换来了什么），内容须与引用证据一致；带深度槽的发现按 1.5 条计入配额，读不到真实证据的槽位留空。\n` +
        DIRECTIVE.noCopyBehavior
      );
    }

    if (toPhase === 'SUMMARIZE') {
      const submitCount = m.submitCount;
      // Analyst 管线: 纯文本分析报告
      if (pipelineType === 'analyst') {
        return (
          `${DIRECTIVE.analystSummarizeLead}\n\n` +
          `要求：\n` +
          `- 用 Markdown 格式组织内容（二级/三级标题）\n` +
          `- 核心「已确认」章节只能来自已记录的 note_finding；不要把未调用 note_finding 的模式、信号或候选主题写成核心发现\n` +
          `- 每个核心发现都要对应一条已记录 note_finding，并给出证据（文件路径 + 代码片段或行为描述）\n` +
          `- 如有未结构化记录的信号，只能在末尾用「## 待探索」或「## 未结构化记录」列出，不能混入已确认核心章节\n\n` +
          `${DIRECTIVE.startReportStopTools}\n` +
          DIRECTIVE.noCopyAnalysisOnly
        );
      }
      // Scan 管线: 纯文本总结
      if (pipelineType === 'scan') {
        return (
          `你已通过 knowledge({ action: "submit" }) 提交了 ${submitCount} 个知识候选。` +
          `${DIRECTIVE.scanSummarizeStopTools}\n` +
          DIRECTIVE.stopToolsTextOnly
        );
      }
      // Producer: 候选生产总结，不产出 bootstrap dimensionDigest
      if (pipelineType === 'producer') {
        return (
          `${DIRECTIVE.producerSummarizeLead}\n` +
          `${DIRECTIVE.producerSummaryScope}\n` +
          `${DIRECTIVE.producerSummaryNoNewTopics}\n` +
          DIRECTIVE.stopToolsTextOnly
        );
      }
      // Bootstrap: 使用 dimensionDigest JSON (供维度编排消费)
      return (
        `${DIRECTIVE.bootstrapSummarizeLead}\n` +
        `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结(100-200字)","candidateCount":${submitCount},"keyFindings":["关键发现"],"crossRefs":{},"gaps":["未覆盖方面"],"remainingTasks":[{"signal":"未处理的信号/主题","reason":"未完成原因(如:提交上限已达)","priority":"high|medium|low","searchHints":["建议搜索词"]}]}}\n\`\`\`\n${DIRECTIVE.bootstrapRemainingTasksNote}\n` +
        DIRECTIVE.noCopyJson
      );
    }

    if (toPhase === 'EXPLORE' && fromPhase === 'SCAN') {
      return '轻量计划阶段已完成。现在基于已有项目快照开始定向探索，只搜索当前任务需要验证的关键模式和类。';
    }

    if (toPhase === 'VERIFY') {
      return '搜索阶段信息已饱和。现在进入证据验证阶段——只校验已发现的文件路径、行号、调用关系和 referencedFiles，不要重新进行泛搜索或扩展探索。note_finding 是 QualityGate 的重要质量依据；请在确认每个核心发现后立即调用 note_finding({ finding, evidenceRefs, importance })，evidenceRefs 引用工具返回 [evidence] 标注的条目 id。';
    }

    return `阶段切换: ${fromPhase} → ${toPhase}`;
  }

  /** 获取当前阶段的上下文状态行（注入 systemPrompt 尾部） */
  getPhaseContext(state: NudgeState) {
    const { phase, metrics: m, budget: b, isTerminalPhase } = state;
    const remaining = b.maxIterations - m.iteration;

    // 接近上限时的紧急警告
    if (remaining <= 2 && remaining > 0 && !isTerminalPhase) {
      return `\n\n## 当前状态\n⚠️ 仅剩 ${remaining} 轮次即达上限，请尽快完成当前工作并准备输出总结。`;
    }

    // 阶段特定提示
    const phaseHint = this.#getPhaseHint(state);
    if (phaseHint) {
      return `\n\n## 当前状态\n${phaseHint}`;
    }

    // 通用进度行
    const phaseLabel = NudgeGenerator.#getPhaseLabel(phase);
    return `\n\n## 当前进度\n第 ${m.iteration}/${b.maxIterations} 轮 | ${phaseLabel} | 剩余 ${remaining} 轮`;
  }

  // ─── 内部方法 ──────────────────────────────────

  /**
   * PRODUCE 阶段的 convergence 文本按管线生成（L6-P17 C11）：producer / scan 与 SUMMARIZE 一致要求
   * Markdown 生产总结并写明未提交原因；只有 bootstrap 保留 dimensionDigest JSON 契约。
   */
  #buildProduceConvergence(state: NudgeState) {
    const { metrics: m, pipelineType, submitToolName } = state;
    const lead = `Producer 阶段已连续 ${m.roundsSinceSubmit} 轮没有有效新提交。`;
    const otherwise = `否则只调用 ${submitToolName} 提交尚未提交且不重复的候选。`;
    if (pipelineType === 'bootstrap') {
      return {
        type: 'convergence',
        text:
          `${lead}如果已达到提交上限或没有新的非重复候选，请停止继续读取/搜索，直接输出 dimensionDigest JSON 总结；` +
          `${otherwise}\n${DIRECTIVE.noCopyBehavior}`,
      };
    }
    // 固定指令句独占一行，模型整行回显时 cleanFinalAnswer 能按登记原句识别并清除。
    return {
      type: 'convergence',
      text: `${lead}\n${DIRECTIVE.produceConvergenceSummary}\n${otherwise}\n${DIRECTIVE.noCopyBehavior}`,
    };
  }

  /**
   * 非 PRODUCE 阶段的 convergence 文本（L6-P17 C13）：只有真正读到过文件（uniqueFiles>0）才说
   * “已充分探索”；否则只陈述停滞事实，并要求先核实关键文件再总结。
   */
  #buildExploreConvergence(state: NudgeState) {
    const { metrics: m, budget: b } = state;
    const remaining = b.maxIterations - m.iteration;
    if (m.uniqueFiles.size > 0) {
      return {
        type: 'convergence',
        text:
          `你已经充分探索了项目代码（${m.uniqueFiles.size} 个文件，${m.uniquePatterns.size} 次不同搜索，${m.uniqueQueries.size} 次结构化查询）。` +
          `最近 ${m.roundsSinceNewInfo} 轮没有发现新信息，建议开始撰写分析总结。\n` +
          `如果你确信还有重要方面未覆盖，可以继续探索（剩余 ${remaining} 轮）；否则请直接输出你的分析发现。\n` +
          DIRECTIVE.noCopyBehavior,
      };
    }
    return {
      type: 'convergence',
      text:
        `最近 ${m.roundsSinceNewInfo} 轮没有发现新信息，但目前还没有读取到任何具体文件（${m.uniquePatterns.size} 次不同搜索，${m.uniqueQueries.size} 次结构化查询）。` +
        `请先用 code({ action: "read" }) 核实已有发现所依据的关键文件，核实后再开始撰写分析总结（剩余 ${remaining} 轮）。\n` +
        DIRECTIVE.noCopyBehavior,
    };
  }

  /**
   * bootstrap 常规 nudge 限流（条数上限 + 最小间隔 + PRODUCE 只放行 convergence）。
   * 丢弃时返回 null 并记 debug 诊断；调用方据返回值决定是否消耗一次性标志（L6-P17 C63）。
   */
  #emitNudge<T extends { type: string; text: string }>(state: NudgeState, nudge: T): T | null {
    if (state.pipelineType !== 'bootstrap') {
      return nudge;
    }
    if (nudge.type === 'force_exit') {
      return nudge;
    }
    const iteration = state.metrics.iteration;
    let suppressReason: 'produce' | 'budget' | 'ttl' | null = null;
    if (state.phase === 'PRODUCE' && nudge.type !== 'convergence') {
      suppressReason = 'produce';
    } else if (this.#bootstrapNudgeCount >= BOOTSTRAP_NUDGE_BUDGET) {
      suppressReason = 'budget';
    } else if (iteration - this.#lastBootstrapNudgeIteration < BOOTSTRAP_NUDGE_TTL_ROUNDS) {
      suppressReason = 'ttl';
    }
    if (suppressReason) {
      const lastEmitted = Number.isFinite(this.#lastBootstrapNudgeIteration)
        ? String(this.#lastBootstrapNudgeIteration)
        : 'none';
      logNudgeDiagnostic(
        `[NudgeGenerator] bootstrap nudge suppressed: reason=${suppressReason}, type=${nudge.type}, ` +
          `phase=${state.phase}, iteration=${iteration}, emitted=${this.#bootstrapNudgeCount}/${BOOTSTRAP_NUDGE_BUDGET}, ` +
          `lastEmittedIteration=${lastEmitted}, ttlRounds=${BOOTSTRAP_NUDGE_TTL_ROUNDS} — one-shot flag kept for retry`
      );
      return null;
    }
    this.#bootstrapNudgeCount++;
    this.#lastBootstrapNudgeIteration = iteration;
    return nudge;
  }

  #generateForceExit(
    m: FullExplorationMetrics,
    b: ExplorationBudget,
    strategy: NudgeStrategy,
    pipelineType: PipelineType
  ) {
    const submitCount = m.submitCount;
    // Analyst 管线: 纯文本分析报告
    if (pipelineType === 'analyst') {
      return {
        type: 'force_exit',
        text:
          `⚠️ **轮次耗尽** (${m.iteration}/${b.maxIterations})。${DIRECTIVE.forceExitStopToolsReport}\n\n` +
          `要求：\n` +
          `- 用自然语言 Markdown 格式\n` +
          `- 核心已确认发现只能来自已记录的 note_finding，并包含具体文件路径、类名、代码模式\n` +
          `- 未调用 note_finding 的信号只能在「## 未覆盖」或「## 未结构化记录」章节列出\n\n` +
          `${DIRECTIVE.forceExitStartSummary}\n` +
          DIRECTIVE.forceExitNoCopyAnalysis,
      };
    }
    // Scan 管线: 纯文本总结, 不需要 dimensionDigest
    if (pipelineType === 'scan') {
      return {
        type: 'force_exit',
        text:
          `⚠️ **轮次耗尽** (${m.iteration}/${b.maxIterations})。${DIRECTIVE.forceExitStopTools}\n\n` +
          `已通过 knowledge({ action: "submit" }) 提交了 ${submitCount} 个知识候选。` +
          `${DIRECTIVE.forceExitScanOutput}\n` +
          DIRECTIVE.forceExitStopToolsTextOnly,
      };
    }
    // Producer 管线（I11）：与 SUMMARIZE 转换、tracker 终结 nudge、forcedSummary 的 producer-summary
    // 模式一致，输出 Markdown 生产总结。此前落入下方 bootstrap 分支，强制退出时要求 dimensionDigest
    // JSON，producer 的收尾形状随退出方式而变。
    if (pipelineType === 'producer') {
      return {
        type: 'force_exit',
        text:
          `⚠️ **轮次耗尽** (${m.iteration}/${b.maxIterations})。${DIRECTIVE.forceExitStopTools}\n\n` +
          `已提交 ${submitCount} 个候选。\n` +
          // 固定指令句独占一行，模型整行回显时 cleanFinalAnswer 能按登记原句识别并清除。
          `${DIRECTIVE.forceExitProducerOutput}\n` +
          `${DIRECTIVE.producerSummaryScope}\n` +
          `${DIRECTIVE.producerSummaryNoNewTopics}\n` +
          DIRECTIVE.forceExitStopToolsTextOnly,
      };
    }
    // Bootstrap 策略: 使用 dimensionDigest JSON (供维度编排消费)
    return {
      type: 'force_exit',
      text:
        `⚠️ 你已使用 ${m.iteration}/${b.maxIterations} 轮次，**必须立即结束**。${DIRECTIVE.forceExitDigestOutput}\n` +
        `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结","candidateCount":${submitCount},"keyFindings":["发现"],"crossRefs":{},"gaps":["缺口"],"remainingTasks":[{"signal":"未处理信号","reason":"轮次耗尽","priority":"high","searchHints":["搜索词"]}]}}\n\`\`\`\n${DIRECTIVE.forceExitRemainingTasksNote}\n` +
        DIRECTIVE.forceExitNoCopyJson,
    };
  }

  /**
   * 检查是否需要触发反思 + 生成反思 nudge
   * @returns 反思 nudge { type: 'reflection', text }（同时写入 trace.setReflection）；
   *   终结阶段、未到触发条件或 trace 无近期摘要时返回 null
   */
  #checkReflection(state: NudgeState, trace: ExplorationTrace | null) {
    const { phase, metrics: m, budget: b, strategy, isTerminalPhase, pipelineType } = state;

    // 终结阶段（SUMMARIZE）不应触发反思 — 此时应输出最终结果而非继续探索
    if (isTerminalPhase) {
      return null;
    }
    if (pipelineType === 'bootstrap' && phase !== 'EXPLORE') {
      return null;
    }

    const interval = strategy.reflectionInterval || DEFAULT_REFLECTION_INTERVAL;

    const periodicTrigger = m.iteration > 1 && interval > 0 && m.iteration % interval === 0;
    const staleCondition =
      m.roundsSinceNewInfo >= DEFAULT_STALE_THRESHOLD &&
      m.iteration >= MIN_ITERS_FOR_STALE_REFLECTION;
    // C13：停滞反思与上一条反思至少间隔 interval 轮，否则同一停滞状态会每轮叠加一条反思。
    const roundsSinceReflection = m.iteration - this.#lastReflectionIteration;
    const staleTrigger = staleCondition && roundsSinceReflection >= interval;
    if (staleCondition && !staleTrigger) {
      logNudgeDiagnostic(
        `[NudgeGenerator] stale reflection suppressed: lastReflectionIteration=${this.#lastReflectionIteration}, ` +
          `iteration=${m.iteration}, interval=${interval}, staleRounds=${m.roundsSinceNewInfo}, phase=${phase} — ` +
          (periodicTrigger ? 'periodic reflection fires instead' : 'no reflection this round')
      );
    }

    if (!periodicTrigger && !staleTrigger) {
      return null;
    }

    const summary = trace?.getRecentSummary?.(interval || 3);
    if (!summary) {
      return null;
    }

    const stats = trace?.getStats?.() || {};
    const remaining = b.maxIterations - m.iteration;
    const progressPct = Math.round((m.iteration / b.maxIterations) * 100);

    const parts: string[] = [];
    if (staleTrigger) {
      parts.push(
        `📊 停滞反思 (第 ${m.iteration}/${b.maxIterations} 轮, 连续 ${m.roundsSinceNewInfo} 轮无新信息):`
      );
    } else {
      parts.push(`📊 中期反思 (第 ${m.iteration}/${b.maxIterations} 轮, ${progressPct}% 预算):`);
    }

    if (summary.thoughts?.length > 0) {
      parts.push(
        `\n你最近的思考方向:\n${summary.thoughts.map((t: string, i: number) => `  ${i + 1}. ${t}`).join('\n')}`
      );
    }

    parts.push(
      `\n行动效率: 最近 ${summary.roundCount} 轮中 ${Math.round(summary.newInfoRatio * 100)}% 获取到新信息`
    );
    parts.push(
      `累计: ${m.uniqueFiles.size} 文件, ${m.uniquePatterns.size} 搜索模式, ${stats.totalActions || 0} 次工具调用`
    );

    // Planning 进度附加
    if (strategy.enablePlanning) {
      const plan = trace?.getPlan?.();
      if (plan?.steps && plan.steps.length > 0) {
        const doneCount = plan.steps.filter((s: { status: string }) => s.status === 'done').length;
        parts.push(`\n📋 计划进度: ${doneCount}/${plan.steps.length} 步骤已完成`);
      }
    }

    // 阶段化评估问题
    if (phase === 'EXPLORE' || phase === 'SCAN' || phase === 'VERIFY') {
      parts.push(
        `\n请评估:\n1. 到目前为止最重要的发现是什么？\n2. 还有哪些关键方面未覆盖？\n3. 剩余 ${remaining} 轮，最有价值的下一步是什么？`
      );
    } else if (phase === 'PRODUCE') {
      parts.push(`\n请评估:\n1. 已提交的候选是否覆盖了核心发现？\n2. 是否有高价值知识点被遗漏？`);
    }

    parts.push(`\n${DIRECTIVE.noCopyReflection}`);
    const reflectionText = parts.join('\n');
    trace?.setReflection?.(reflectionText);

    return { type: 'reflection', text: reflectionText };
  }

  /** 获取当前阶段的 hint */
  #getPhaseHint(state: NudgeState) {
    const { phase, metrics: m, budget: b, submitToolName, pipelineType } = state;

    switch (phase) {
      case 'EXPLORE':
        if (m.searchRoundsInPhase >= b.searchBudget - 2) {
          return `搜索预算即将耗尽 (${m.searchRoundsInPhase}/${b.searchBudget})，请准备提交候选或产出摘要。`;
        }
        return null;

      case 'PRODUCE':
        if (m.submitCount === 0 && m.phaseRounds >= 1) {
          return `⚠️ 探索阶段已结束。你已收集了足够的项目信息，请 **立即** 调用 ${submitToolName} 提交候选。不要继续搜索，直接提交。`;
        }
        if (pipelineType === 'producer') {
          const target = targetProducerSubmitCount(b);
          if (target > 0 && m.submitCount > 0 && m.submitCount < target) {
            return `已提交 ${m.submitCount}/${target} 个结构化发现候选。请继续调用 ${submitToolName}({ action: "submit" }) 提交剩余结构化发现；不要调用 detail、tools、plan 或重新探索。`;
          }
        }
        if (m.submitCount >= b.softSubmitLimit && b.softSubmitLimit > 0) {
          const remaining = b.maxSubmits - m.submitCount;
          if (pipelineType === 'scan') {
            return `已提交 ${m.submitCount} 个候选（上限 ${b.maxSubmits}）。${remaining > 0 ? `还可提交 ${remaining} 个。` : ''}如果还有值得记录的发现可以继续提交，否则请输出分析总结。`;
          }
          if (pipelineType === 'producer') {
            return `已提交 ${m.submitCount} 个候选（上限 ${b.maxSubmits}）。如果结构化发现已全部覆盖，请直接输出生产总结；不要从最终 Markdown 摘要里新增候选主题。`;
          }
          return `已提交 ${m.submitCount} 个候选（上限 ${b.maxSubmits}）。${remaining > 0 ? `还可提交 ${remaining} 个。` : ''}如果还有值得记录的发现可以继续提交，否则请产出 dimensionDigest 总结。\n⚠️ 如果还有未处理的信号，请在 dimensionDigest 的 remainingTasks 字段中标记，下次运行时会续传。`;
        }
        return null;

      case 'SCAN':
        return '当前处于轻量计划阶段：基于已注入的项目快照整理分析路线，不要调用工具重复获取项目概览或目录结构。';

      case 'VERIFY': {
        // M3：未核实发现（引用全无文件归属）在本相补采——code.read 关键文件后用带文件的
        // 新 [E-x] 重新 note_finding；未核实线索不计配额、producer 不作"已确认"消费。
        const unverifiedCount =
          m.memoryFindingCount - (m.verifiedFindingCount ?? m.memoryFindingCount);
        const unverifiedHint =
          unverifiedCount > 0
            ? `已有 ${unverifiedCount} 条发现未核实（引用无文件归属）：先 code.read 其声称的关键文件，再用新 [E-x] 重新 note_finding——未核实线索不计配额。`
            : '';
        return `当前处于证据验证阶段：只读取已定位的关键路径，或校验既有符号/调用关系；不要泛搜索、不要重新打开探索面。${unverifiedHint}`;
      }

      case 'RECORD': {
        // C12：同时显示已核实数——配额只认已核实发现，模型需要看出未核实发现不计入进度。
        const verifiedCount = Math.min(
          m.verifiedFindingCount ?? m.memoryFindingCount,
          m.memoryFindingCount
        );
        const target = targetMemoryFindingCount(m);
        // 台账无文件条目时已核实配额不可达，策略按原始发现数收口（见 ExplorationStrategies 的配额出口）。
        const unreachableHint =
          m.ledgerDistinctFiles === 0
            ? `证据台账没有文件条目，发现无法核实：记满 ${target} 条后即进入总结。`
            : '';
        return `当前处于结构化记录阶段：不要输出正文，只调用 note_finding({ finding, evidenceRefs, importance })，evidenceRefs 引用工具返回 [evidence] 标注的条目 id；按当前证据量需记录 ${target} 条核心发现，当前进度 ${effectiveMemoryFindingCount(m)}（已记 ${m.memoryFindingCount} 条，其中已核实 ${verifiedCount} 条——未核实发现不计配额；含深度槽 ${m.depthSlottedFindingCount ?? 0} 条计 1.5）。${unreachableHint}importance ≥7 必须至少填一个深度槽（designIntent/boundaries/failureModes/tradeoffs），内容须与证据一致。`;
      }

      default:
        return null;
    }
  }

  /** 获取用户友好的阶段标签 */
  static #getPhaseLabel(phase: string) {
    switch (phase) {
      case 'SCAN':
        return '扫描阶段';
      case 'EXPLORE':
        return '探索阶段';
      case 'PRODUCE':
        return '提交阶段';
      case 'VERIFY':
        return '验证阶段';
      case 'RECORD':
        return '记录阶段 — 只允许 note_finding 函数';
      case 'SUMMARIZE':
        return '⚠ 总结阶段 — 请停止工具调用，直接输出分析文本';
      default:
        return phase;
    }
  }
}
