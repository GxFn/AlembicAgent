import { isPersistedSubmission, readToolObservation } from '../utils/toolOutcomes.js';
/**
 * ExplorationTracker — 统一的 AI 探索生命周期控制器
 *
 * 合并了三个原本各自为政的系统:
 *   1. PhaseRouter (ContextWindow.js) — 阶段状态机
 *   2. 探索进度追踪 (原内联逻辑) — 信息增量检测
 *   3. ReasoningLayer 行为控制部分 — 反思/规划/停滞 nudge
 *
 * 职责（拆分后的编排层）:
 *   - 阶段状态机: phase 持有 + 转换规则
 *   - 信号收集: 委托 SignalDetector
 *   - Nudge 生成: 委托 NudgeGenerator
 *   - 计划跟踪: 委托 PlanTracker
 *   - Graceful exit: 管理轮次耗尽后的优雅退出流程
 *
 * 不拥有的职责:
 *   - 推理链数据收集 → ReasoningTrace (纯数据，不影响行为)
 *   - 上下文压缩 → ContextWindow
 *   - 工具注册与执行 → ToolRegistry
 *   - 跨对话记忆 → Memory / WorkingMemory
 *
 * @module ExplorationTracker
 */

import type { SignalBus } from '@alembic/core/events';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { DEPTH_SLOT_KEYS } from '../../tools/runtime/registry.js';
import type {
  ExplorationBudget,
  ExplorationPhase,
  ExplorationStrategy,
  ExplorationTrace,
  FullExplorationMetrics,
  PipelineType,
} from './exploration/ExplorationStrategies.js';
import {
  createGenerateStrategy,
  effectiveMemoryFindingCount,
  STRATEGY_ANALYST,
  STRATEGY_PRODUCER,
  targetMemoryFindingCount,
  targetProducerSubmitCount,
} from './exploration/ExplorationStrategies.js';
import { NudgeGenerator } from './exploration/NudgeGenerator.js';
import { PlanTracker } from './exploration/PlanTracker.js';
import { isSearchAction, SignalDetector } from './exploration/SignalDetector.js';

// ─── 本地类型 ──────────────────────────────────────────

/** resolve() 选项 */
interface ResolveOptions {
  source?: unknown;
  strategy?: unknown;
  dimensionMeta?: { outputType?: string };
}

/** 预算输入（带默认值） */
interface BudgetInput extends Partial<ExplorationBudget> {
  submitToolName?: string;
  pipelineType?: PipelineType;
  /**
   * 可选信号总线：阶段切换与退出时发 'exploration' 信号，仅作观测，不参与阶段路由。
   * @deprecated src、宿主与测试构造 ExplorationTracker / 调用 resolve 时都不传，信号分支无人接线也无人验证；
   *   BudgetInput 是公开类的构造参数类型，删除本字段随待决事项②“公开面收窄”处理，删除前须附 src、测试、
   *   宿主生产与宿主测试的零引用扫描。
   */
  signalBus?: SignalBus | null;
}

// ─── ExplorationTracker 主类 ─────────────────────────────

export class ExplorationTracker {
  /** 策略配置 */
  #strategy: ExplorationStrategy;
  /** 预算配置 */
  #budget: ExplorationBudget;
  /** 当前阶段 */
  #phase: string;
  /** 日志器 */
  #logger;
  /** 信号总线（可选） */
  #signalBus: SignalBus | null;

  // ── 子模块 ──
  #signalDetector;
  #nudgeGenerator;
  #planTracker;

  // ── 信号指标 ──
  #metrics: FullExplorationMetrics = {
    uniqueFiles: new Set(),
    uniquePatterns: new Set(),
    uniqueQueries: new Set(),
    totalToolCalls: 0,
    evidenceToolCallCount: 0,
    submitCount: 0,
    memoryFindingCount: 0,
    depthSlottedFindingCount: 0,
    verifiedFindingCount: 0,
    verifiedDepthSlottedFindingCount: 0,
    roundsSinceNewInfo: 0,
    roundsSinceSubmit: 0,
    iteration: 0,
    searchRoundsInPhase: 0,
    phaseRounds: 0,
    consecutiveIdleRounds: 0,
  };

  /**
   * 证据台账统计刷新（Wave A E4）——RECORD 配额钳制的数据源。
   * 由 evidenceCapture 中间件在每次落账后调用；非维度运行（无台账）从不调用，
   * ledgerDistinctFiles 缺席时配额回退原公式（行为等价改造前）。
   */
  noteLedgerStats(stats: { distinctFiles: number }): void {
    this.#metrics.ledgerDistinctFiles = stats.distinctFiles;
  }

  // ── 阶段控制 ──
  /** 是否刚完成阶段转换（用于 pending nudge） */
  #justTransitioned = false;
  /** 转换前的旧阶段 */
  #transitionFromPhase: string | null = null;
  /**
   * 自上次 tick 起（同一轮内）是否已发生阶段转换（L6-P18 C10/C14）。
   *
   * 与 #justTransitioned 分工不同，不能复用：#justTransitioned 是“待生成转换 nudge”的一次性消费标志，
   * endRound / onTextResponse / shouldExit / forceTerminal 转换后都会立即清掉它；本标志只在 #transitionTo
   * 置位、只由 tick 清零，回答“这一轮是否已经转换过”：
   *   - onTextResponse 据此跳过同轮第二次转换（文本轮先 endRound 后 onTextResponse，避免 endRound 刚进
   *     VERIFY 又被文本规则推到 RECORD，VERIFY 零轮被跳过）；
   *   - rollbackTick 据此不再递减已被 #transitionTo 归零的 phaseRounds（否则变成 -1）。
   */
  #transitionedSinceTick = false;

  // ── Graceful exit 控制 ──
  /** 进入 graceful exit 的轮次 */
  #gracefulExitRound: number | null = null;

  /** tick 是否已调用（用于 rollback） */
  #ticked = false;
  /** 当前轮次是否包含搜索操作（由 recordToolCall 标记，endRound 消费并重置） */
  #currentRoundHasSearch = false;
  /** 提交工具名（用于 nudge 文本生成） */
  #submitToolName = 'knowledge';
  /** 管线类型标识 — 统一场景判别（替代 submitToolName / strategy.name 字符串比较） */
  #pipelineType: PipelineType;
  /** 当前阶段开始时间（用于 dwell time 统计） */
  #phaseStartTime = Date.now();

  /**
   * @param strategy 策略配置对象
   * @param budget 预算配置 { maxIterations, searchBudget, ... }
   */
  constructor(strategy: ExplorationStrategy, budget: BudgetInput) {
    this.#strategy = strategy;
    this.#budget = {
      maxIterations: 24,
      searchBudget: 18,
      searchBudgetGrace: 10,
      maxSubmits: 10,
      softSubmitLimit: 8,
      idleRoundsToExit: 3,
      ...budget,
    };
    this.#submitToolName = budget.submitToolName || 'knowledge';
    // pipelineType 显式传入 > 从策略名推断默认值
    this.#pipelineType =
      budget.pipelineType ||
      (strategy.name === 'analyst'
        ? 'analyst'
        : strategy.name === 'producer'
          ? 'producer'
          : 'bootstrap');
    this.#phase = strategy.phases[0];
    this.#logger = Logger.getInstance();
    this.#signalBus = budget.signalBus ?? null;

    // 初始化子模块
    this.#signalDetector = new SignalDetector(this.#metrics);
    this.#nudgeGenerator = new NudgeGenerator();
    this.#planTracker = new PlanTracker();
  }

  // ─── 静态工厂 ─────────────────────────────────────────

  /**
   * 根据调用参数解析应使用的策略
   * @param opts AgentRuntime execute 的选项
   * @param budget 预算配置
   * @returns User 模式返回 null
   */
  static resolve(opts: ResolveOptions, budget: BudgetInput) {
    const { source = 'user', strategy: strategyName, dimensionMeta } = opts;
    const isSystem = source === 'system';

    if (!isSystem) {
      return null;
    }

    let resolvedStrategy: ExplorationStrategy;

    if (strategyName === 'analyst') {
      resolvedStrategy = STRATEGY_ANALYST;
    } else if (strategyName === 'producer') {
      resolvedStrategy = STRATEGY_PRODUCER;
    } else {
      const isSkillOnly = dimensionMeta?.outputType === 'skill';
      resolvedStrategy = createGenerateStrategy(isSkillOnly);
      // L6-P18（C63 本地部分）：未传 strategy 或显式 'bootstrap' 是 bootstrap 生成策略的既定入口；
      // 其他取值（如拼错的 'analyze'、'scan'）同样落到这里，运行时会按 EXPLORE/PRODUCE/SUMMARIZE 走并在
      // 终结阶段要求 dimensionDigest JSON，与调用方预期的 analyst/producer 完全不同。保持回退行为不变，
      // 但留 warn 写明传入值与回退目标，便于定位调用方笔误。
      if (strategyName !== undefined && strategyName !== null && strategyName !== 'bootstrap') {
        Logger.getInstance().warn(
          `[ExplorationTracker] resolve: unknown strategy ${formatStrategyName(strategyName)} — ` +
            `falling back to bootstrap generate strategy (phases=${resolvedStrategy.phases.join('→')}, ` +
            `skillOnly=${isSkillOnly}); known strategies: analyst, producer, bootstrap`
        );
      }
    }

    return new ExplorationTracker(resolvedStrategy, budget);
  }

  // ─── 核心 API：主循环调用点 ────────────────────────────

  /** 每轮迭代开始时调用 — 递增计数 */
  tick() {
    this.#metrics.iteration++;
    this.#metrics.phaseRounds++;
    this.#ticked = true;
    this.#justTransitioned = false;
    this.#transitionedSinceTick = false;
  }

  /** 撤销 tick（AI 调用失败或空响应时，不计入迭代） */
  rollbackTick() {
    if (this.#ticked) {
      this.#metrics.iteration--;
      if (this.#transitionedSinceTick) {
        // L6-P18（C14）：本 tick 内已发生阶段转换（如 shouldExit 因 maxIterations 强制终结、forceTerminal），
        // #transitionTo 已把 phaseRounds 归零、新阶段尚未计过轮；再递减会变成 -1，使终结 grace（>=3）多给一轮
        // 且 getMetrics 对外暴露负数。只撤销迭代计数，阶段转换本身不回退。
        this.#logger.info(
          `[ExplorationTracker] rollbackTick: phase changed within this tick (${this.#transitionFromPhase ?? 'unknown'} → ${this.#phase}), ` +
            `keeping phaseRounds=${this.#metrics.phaseRounds} (iteration rolled back to ${this.#metrics.iteration})`
        );
      } else {
        this.#metrics.phaseRounds--;
      }
      this.#ticked = false;
    }
  }

  /** 提交工具名 */
  get submitToolName() {
    return this.#submitToolName;
  }

  /** 管线类型标识 */
  get pipelineType(): PipelineType {
    return this.#pipelineType;
  }

  /** 是否应退出主循环 */
  shouldExit() {
    // Scan 管线: SUMMARIZE 无消费方，直接退出
    if (this.#isTerminalPhase() && this.#pipelineType === 'scan') {
      this.#emitExitSignal('scan_terminal');
      return true;
    }
    // 终结阶段 + 已给了 3 轮 grace → 退出
    if (this.#isTerminalPhase() && this.#metrics.phaseRounds >= 3) {
      this.#emitExitSignal('grace_exhausted');
      return true;
    }
    // 硬上限兜底
    if (this.#metrics.iteration >= this.#budget.maxIterations + 2) {
      this.#emitExitSignal('hard_limit');
      return true;
    }
    // 达到 maxIterations 但未在终结阶段 → 强制转入终结阶段
    if (this.#metrics.iteration >= this.#budget.maxIterations && !this.#isTerminalPhase()) {
      this.#logger.info(
        `[ExplorationTracker] maxIterations reached (${this.#metrics.iteration}/${this.#budget.maxIterations}), forcing → ${this.#getTerminalPhase()}`
      );
      this.#transitionTo(this.#getTerminalPhase());
      this.#justTransitioned = false;
      this.#gracefulExitRound = this.#metrics.iteration;
      return false;
    }
    return false;
  }

  #emitExitSignal(reason: string): void {
    if (this.#signalBus) {
      this.#signalBus.send('exploration', 'ExplorationTracker.exit', 0, {
        metadata: { totalIterations: this.#metrics.iteration, reason },
      });
    }
  }

  /**
   * 获取本轮的 Nudge（每轮最多一条）
   * @param trace 推理链
   * @returns |null}
   */
  getNudge(trace: ExplorationTrace | null) {
    if (this.#isTerminalPhase()) {
      return null;
    }
    if (this.#phase === 'RECORD') {
      return null;
    }

    // 委托 NudgeGenerator
    const nudge = this.#nudgeGenerator.generate(this.#buildNudgeState(), trace);
    if (nudge) {
      // 日志 (保持原有行为)
      if (nudge.type === 'convergence') {
        this.#logger.info(
          `[ExplorationTracker] 📊 Exploration saturated at iter ${this.#metrics.iteration}/${this.#budget.maxIterations} — ` +
            `files=${this.#metrics.uniqueFiles.size}, patterns=${this.#metrics.uniquePatterns.size}, staleRounds=${this.#metrics.roundsSinceNewInfo}`
        );
      } else if (nudge.type === 'budget_warning') {
        this.#logger.info(
          `[ExplorationTracker] 📌 Budget warning at ${this.#metrics.iteration}/${this.#budget.maxIterations}`
        );
      } else if (nudge.type === 'reflection') {
        this.#logger.info(
          `[ExplorationTracker] 💭 reflection triggered at iteration ${this.#metrics.iteration}`
        );
      }
      return nudge;
    }

    // NudgeGenerator 不处理 planning — 委托 PlanTracker
    if (this.#strategy.enablePlanning) {
      const planningNudge = this.#planTracker.checkPlanning(
        this.#buildNudgeState(),
        trace,
        (suppression) => {
          // replan 触发已成立但被配额/后段/冷却抑制：返回值仍是 null，这里留下短路原因供排查“偏离却未纠偏”。
          observeSafely(
            () =>
              this.#logger.debug(
                `[ExplorationTracker] 📋 planning replan suppressed: reason=${suppression.reason}, ` +
                  `triggers=${suppression.triggers.join('+')}, iteration=${suppression.iteration}, ` +
                  `replanCount=${suppression.replanCount}/${suppression.maxReplans}, ` +
                  `lastReplanIteration=${suppression.lastReplanIteration ?? 'none'}, ` +
                  `consecutiveOffPlan=${suppression.consecutiveOffPlan}, ` +
                  `pipeline=${suppression.pipelineType}, phase=${suppression.phase ?? 'unknown'} — no planning nudge this round`
              ),
            () => undefined
          );
        }
      );
      if (planningNudge) {
        this.#logger.info(
          `[ExplorationTracker] 📋 ${planningNudge.type} triggered at iteration ${this.#metrics.iteration}`
        );
        return planningNudge;
      }
    }

    return null;
  }

  /** 获取当前阶段的上下文状态行（注入 systemPrompt 尾部） */
  getPhaseContext() {
    return this.#nudgeGenerator.getPhaseContext(this.#buildNudgeState());
  }

  /** 获取当前阶段的 toolChoice */
  getToolChoice() {
    if (this.isGracefulExit) {
      return 'none';
    }
    return this.#strategy.getToolChoice(
      this.#phase as ExplorationPhase,
      this.#metrics,
      this.#budget
    );
  }

  /**
   * 记录一次工具调用结果，更新内部指标
   *
   * @returns }
   */
  recordToolCall(toolName: string, args: Record<string, unknown>, result: unknown) {
    this.#metrics.totalToolCalls++;
    const observation = readToolObservation({ tool: toolName, args, result });
    if (!observation.ok) {
      observeSafely(
        () =>
          this.#logger.debug(
            `[ExplorationTracker] failed ${toolName} observation retained as attempt; no evidence or novelty credit`
          ),
        () => undefined
      );
      return { isNew: false };
    }
    if (isEvidenceToolCall(toolName, args)) {
      this.#metrics.evidenceToolCallCount++;
    }
    const isNew = this.#signalDetector.detect(toolName, args, result);

    if (isSearchAction(toolName, args)) {
      this.#currentRoundHasSearch = true;
    }

    if (isPersistedSubmission({ tool: toolName, args, result })) {
      this.#metrics.submitCount++;
      this.#metrics.roundsSinceSubmit = 0;
    }
    const isDirectNoteFinding = toolName === 'note_finding';
    const isMemoryNoteFinding = toolName === 'memory' && args?.action === 'note_finding';
    if (isDirectNoteFinding || isMemoryNoteFinding) {
      const resultObj = observation.result;
      const hasError = resultObj?.error !== undefined;
      const recorded = resultObj?.recorded === true;
      const target = resultObj?.target;
      if (!hasError && recorded && target === 'activeContext') {
        this.#metrics.memoryFindingCount++;
        // M3（VERIFY 机械化）：verified=handler 判定"至少一个引用带文件区间"。
        // verified!==false 计入（true 或 undefined=无台账运行，保持旧行为等价）。
        if (resultObj?.verified !== false) {
          this.#metrics.verifiedFindingCount = (this.#metrics.verifiedFindingCount ?? 0) + 1;
        }
        // M1c（挖掘产出升级）：深度槽计数——带任一非空深度槽的发现享受配额加权（CG-D 1.5）。
        // args 形态：直呼型 note_finding 平铺；memory 工具嵌在 params 内。
        const slotCarrier = observation.params;
        if (
          slotCarrier &&
          DEPTH_SLOT_KEYS.some((key) => {
            const value = slotCarrier[key];
            return typeof value === 'string' && value.trim().length > 0;
          })
        ) {
          this.#metrics.depthSlottedFindingCount =
            (this.#metrics.depthSlottedFindingCount ?? 0) + 1;
          if (resultObj?.verified !== false) {
            this.#metrics.verifiedDepthSlottedFindingCount =
              (this.#metrics.verifiedDepthSlottedFindingCount ?? 0) + 1;
          }
        }
      }
    }

    return { isNew };
  }

  /**
   * 结束本轮迭代 — 更新轮次级指标 + 检查阶段转换
   *
   * @returns |null} 阶段转换 nudge
   */
  endRound({
    hasNewInfo = false,
    submitCount = 0,
    toolNames = [] as string[],
    skipped = false,
  } = {}) {
    this.#ticked = false;

    if (skipped) {
      // L6-P18（C15）：跳过轮不计任何轮次级指标，但 recordToolCall 可能已为本轮置了搜索标记；
      // 早返回前必须同样清掉，否则标记泄漏到下一轮，使 searchRoundsInPhase 多计一次并提前触发
      // searchBudget 相关的阶段转换。
      const discardedSearchFlag = this.#currentRoundHasSearch;
      this.#currentRoundHasSearch = false;
      observeSafely(
        () =>
          this.#logger.debug(
            `[ExplorationTracker] endRound skipped at iteration ${this.#metrics.iteration} (phase=${this.#phase}): ` +
              `round metrics and transitions not evaluated, search flag ${discardedSearchFlag ? 'discarded' : 'was clear'}`
          ),
        () => undefined
      );
      return null;
    }

    // 1. 更新轮次级指标
    if (hasNewInfo) {
      this.#metrics.roundsSinceNewInfo = 0;
    } else {
      this.#metrics.roundsSinceNewInfo++;
    }
    if (submitCount > 0) {
      this.#metrics.roundsSinceSubmit = 0;
    } else {
      this.#metrics.roundsSinceSubmit++;
    }

    // 2. 搜索轮次计数（基于 recordToolCall 中精确的 action 级判定）
    if (this.#currentRoundHasSearch) {
      this.#metrics.searchRoundsInPhase++;
    }
    this.#currentRoundHasSearch = false;

    // 2.5 连续空闲轮次追踪（无任何工具调用 = 真正空转，有工具调用 = 活跃工作）
    if (toolNames.length === 0) {
      this.#metrics.consecutiveIdleRounds++;
    } else {
      this.#metrics.consecutiveIdleRounds = 0;
    }

    // 3. 检查 metrics 驱动的阶段转换
    this.#checkMetricsTransition();

    // 4. 如果发生了转换，生成 nudge
    if (this.#justTransitioned) {
      this.#justTransitioned = false;
      // Scan 管线: skip SUMMARIZE nudge
      if (this.#pipelineType === 'scan' && this.#isTerminalPhase()) {
        this.#logger.info(
          `[ExplorationTracker] scan pipeline: skip SUMMARIZE nudge, will exit on next tick (submits=${this.#metrics.submitCount})`
        );
        return null;
      }
      return {
        type: 'phase_transition',
        text: this.#nudgeGenerator.buildTransitionNudge(this.#buildNudgeState()),
      };
    }

    return null;
  }

  /**
   * 处理 AI 返回纯文本响应（无工具调用）
   * @returns }
   */
  onTextResponse(text = '') {
    let transitioned = false;
    if (this.#transitionedSinceTick) {
      // L6-P18（C10）：一轮最多一次阶段转换。文本轮里 AgentRuntime 先 endRound 再调本方法；endRound 的
      // metrics 规则若刚把阶段推进（如 EXPLORE→VERIFY），这里再按文本规则推进（VERIFY→RECORD）会让新阶段
      // 零轮被跳过、其转换指令也随之作废。跳过本轮文本规则，下一轮再按新阶段的规则判定；endRound 返回的
      // 转换 nudge 由调用方在本方法未给出阶段专属 nudge 时补发。
      this.#logger.info(
        `[ExplorationTracker] text response: phase already transitioned this round ` +
          `(${this.#transitionFromPhase ?? 'unknown'} → ${this.#phase}, iter=${this.#metrics.iteration}) — ` +
          `skipping text-rule transition until next round`
      );
    } else {
      transitioned = this.#checkTextTransition();
    }
    if (transitioned) {
      this.#justTransitioned = false;
    }

    const isTerminal = this.#isTerminalPhase();

    if (isTerminal && !transitioned) {
      return { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null };
    }

    if (isTerminal && transitioned) {
      // Scan 管线: 所有结果在 toolCalls 中，无需文本总结
      if (this.#pipelineType === 'scan') {
        return { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null };
      }

      // L6-P17（C11）：终结指令单源——与 metrics 转换（endRound）同一生成器、同一份按 pipelineType
      // 区分的 SUMMARIZE 指令（analyst 严格版：核心章节只能来自已记录 note_finding；producer 不得从
      // Analyst 摘要新增主题；bootstrap 为 dimensionDigest JSON）。此前这里内联了一份已漂移的弱版副本，
      // 同一阶段因触发路径不同得到不同的产出约束。
      const nudge = this.#nudgeGenerator.buildTransitionNudge(this.#buildNudgeState());
      return {
        isFinalAnswer: false,
        needsDigestNudge: true,
        shouldContinue: true,
        nudge,
      };
    }

    // 非终结阶段收到文本：先按阶段分支取专属 nudge
    const result = this.#textResponseInPhase(text);
    if (transitioned && !result.isFinalAnswer && result.nudge === null) {
      // L6-P18（C10 / U34-F2）：本方法刚按文本规则转入非终结阶段（如 analyst EXPLORE→VERIFY），但新阶段分支
      // 没有专属 nudge（VERIFY 证据已足、EXPLORE 已有证据、scan 的 PRODUCE 等）。转换标记已在上面清掉，
      // 调用方拿不到其它转换指令；回退到与 endRound 同源的 buildTransitionNudge，否则模型收不到
      // “进入证据验证、不要泛搜索、确认后 note_finding”之类的阶段指令。
      const nudge = this.#nudgeGenerator.buildTransitionNudge(this.#buildNudgeState());
      this.#logger.info(
        `[ExplorationTracker] text-triggered transition ${this.#transitionFromPhase ?? 'unknown'} → ${this.#phase} ` +
          `has no phase-specific nudge — falling back to transition nudge (iter=${this.#metrics.iteration}, pipeline=${this.#pipelineType})`
      );
      return { ...result, nudge };
    }
    return result;
  }

  /**
   * 非终结阶段收到文本时按当前阶段给出的处理结果与专属 nudge（无专属 nudge 时 nudge=null）。
   * 由 onTextResponse 调用；文本触发转换后的 nudge 回退在调用方处理。
   */
  #textResponseInPhase(text: string) {
    const m = this.#metrics;
    if (this.#phase === 'EXPLORE' && m.evidenceToolCallCount === 0) {
      return {
        isFinalAnswer: false,
        needsDigestNudge: false,
        shouldContinue: true,
        nudge:
          '当前还没有真实代码证据。不要输出分析正文；请先调用 code({ action: "structure" }) 获取结构，再用 code({ action: "search" }) 或 graph({ action: "query" }) 定位目标，随后用 code({ action: "read" }) 验证至少 3 个文件后再总结。',
      };
    }

    if (this.#phase === 'VERIFY' && m.evidenceToolCallCount < 2 && m.memoryFindingCount === 0) {
      return {
        isFinalAnswer: false,
        needsDigestNudge: false,
        shouldContinue: true,
        nudge:
          '当前证据仍不足。请不要输出最终分析；继续使用 code({ action: "read" }) 或 graph({ action: "query" }) 校验已发现的文件、类和调用关系，确认后立即调用 note_finding({ finding, evidenceRefs, importance })，evidenceRefs 使用工具返回 [evidence] 中的台账 ID。',
      };
    }

    if (this.#phase === 'PRODUCE') {
      if (
        m.submitCount > 0 &&
        !this.#hasRemainingProducerSubmits() &&
        isProducerCompletionText(text || '')
      ) {
        return { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null };
      }
      const nudge =
        this.#pipelineType !== 'scan'
          ? `请继续调用 ${this.#submitToolName} 提交结构化发现对应的知识候选。候选义务只来自 Analyst note_finding 结构化发现；不要从最终 Markdown 摘要里新增候选主题。`
          : null;
      return { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: true, nudge };
    }

    if (this.#phase === 'EXPLORE') {
      return { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: true, nudge: null };
    }

    if (this.#phase === 'RECORD') {
      if (m.phaseRounds >= 2) {
        this.#logger.warn(
          `[ExplorationTracker] RECORD received text without note_finding for ${m.phaseRounds} rounds; yielding to gate/record repair`
        );
        return { isFinalAnswer: true, needsDigestNudge: false, shouldContinue: false, nudge: null };
      }
      return {
        isFinalAnswer: false,
        needsDigestNudge: false,
        shouldContinue: true,
        nudge:
          '当前仍处于 RECORD 结构化记录阶段。不要输出自然语言正文；请只调用 note_finding({ finding, evidenceRefs, importance })，evidenceRefs 使用工具返回 [evidence] 中的台账 ID，直到至少记录 3 条核心发现。note_finding 是 QualityGate 的重要质量依据。',
      };
    }

    return { isFinalAnswer: false, needsDigestNudge: false, shouldContinue: true, nudge: null };
  }

  /** 记录被截断的工具调用数量 */
  recordTruncatedCalls(count: number) {
    if (count > 0) {
      this.#logger.warn(
        `[ExplorationTracker] ${count} tool calls truncated (MAX_TOOL_CALLS_PER_ITER)`
      );
    }
  }

  /**
   * 外部强制转入终结阶段（SUMMARIZE）。
   * 用于 session token 预算即将耗尽时，让 agent 提前输出结论而非等待
   * 下一轮 BudgetPolicy 检查后被硬杀。
   */
  forceTerminal(reason: string) {
    if (this.#isTerminalPhase()) {
      return;
    }
    this.#logger.info(
      `[ExplorationTracker] forceTerminal: ${reason} — ${this.#phase} → ${this.#getTerminalPhase()}`
    );
    this.#transitionTo(this.#getTerminalPhase());
    this.#justTransitioned = false;
    this.#gracefulExitRound = this.#metrics.iteration;
  }

  // ─── 状态查询 ─────────────────────────────────────────

  get isGracefulExit() {
    return this.#gracefulExitRound != null;
  }

  get isHardExit() {
    return (
      this.#gracefulExitRound != null && this.#metrics.iteration >= this.#gracefulExitRound + 2
    );
  }

  get phase() {
    return this.#phase;
  }

  get iteration() {
    return this.#metrics.iteration;
  }

  get totalSubmits() {
    return this.#metrics.submitCount;
  }

  get strategyName() {
    return this.#strategy.name;
  }

  getMetrics() {
    return {
      iteration: this.#metrics.iteration,
      phase: this.#phase,
      phaseRounds: this.#metrics.phaseRounds,
      submitCount: this.#metrics.submitCount,
      memoryFindingCount: this.#metrics.memoryFindingCount,
      depthSlottedFindingCount: this.#metrics.depthSlottedFindingCount,
      verifiedFindingCount: this.#metrics.verifiedFindingCount,
      verifiedDepthSlottedFindingCount: this.#metrics.verifiedDepthSlottedFindingCount,
      evidenceToolCallCount: this.#metrics.evidenceToolCallCount,
      uniqueFiles: this.#metrics.uniqueFiles.size,
      uniquePatterns: this.#metrics.uniquePatterns.size,
      uniqueQueries: this.#metrics.uniqueQueries.size,
      totalToolCalls: this.#metrics.totalToolCalls,
      roundsSinceNewInfo: this.#metrics.roundsSinceNewInfo,
    };
  }

  get metrics() {
    return this.getMetrics();
  }

  getPlanProgress() {
    return this.#planTracker.progress;
  }

  /** 更新计划进度 — 委托 PlanTracker */
  updatePlanProgress(trace: ExplorationTrace | null) {
    if (!this.#strategy.enablePlanning) {
      return;
    }
    const evaluation = this.#planTracker.updatePlanProgress(trace);
    const skipped =
      (evaluation?.skippedFailedActions ?? 0) + (evaluation?.skippedNonExplorationActions ?? 0);
    if (evaluation && skipped > 0) {
      // 失败动作与记录类动作被排除出计划匹配/偏离统计；本轮若无可计动作，偏离连击保持不变。
      observeSafely(
        () =>
          this.#logger.debug(
            `[ExplorationTracker] plan progress skipped ${evaluation.skippedFailedActions} failed and ` +
              `${evaluation.skippedNonExplorationActions} non-exploration action(s) at iteration ${this.#metrics.iteration} ` +
              `(only successful code/graph/terminal exploration counts); counted=${evaluation.countedActions}, ` +
              `matched=${evaluation.matchedActions}, consecutiveOffPlan=${evaluation.consecutiveOffPlan}` +
              (evaluation.streakHeld ? ' (held: no countable action this round)' : '')
          ),
        () => undefined
      );
    }
  }

  /**
   * 推理质量评分 — 委托 PlanTracker
   * @returns PlanTracker.getQualityMetrics 的总分与分项
   * @deprecated src、宿主与测试都不调用（PlanTracker.getQualityMetrics 同步废弃）；
   *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  getQualityMetrics(trace: ExplorationTrace | null) {
    return this.#planTracker.getQualityMetrics(trace);
  }

  // ─── 阶段路由内部方法 ──────────────────────────────────

  #checkMetricsTransition() {
    const transitions = this.#strategy.transitions;
    const nextPhaseIndex = this.#strategy.phases.indexOf(this.#phase) + 1;
    if (nextPhaseIndex >= this.#strategy.phases.length) {
      return;
    }

    const nextPhase = this.#strategy.phases[nextPhaseIndex];
    const transKey = `${this.#phase}→${nextPhase}`;
    const rule = transitions[transKey];
    if (!rule) {
      return;
    }

    const condition = typeof rule === 'function' ? rule : rule.onMetrics;
    if (condition?.(this.#metrics, this.#budget)) {
      this.#transitionTo(nextPhase);
      this.#noteRecordQuotaExit(transKey, 'metrics');
    }
  }

  #checkTextTransition() {
    const transitions = this.#strategy.transitions;
    const nextPhaseIndex = this.#strategy.phases.indexOf(this.#phase) + 1;
    if (nextPhaseIndex >= this.#strategy.phases.length) {
      return false;
    }

    const nextPhase = this.#strategy.phases[nextPhaseIndex];
    const transKey = `${this.#phase}→${nextPhase}`;
    const rule = transitions[transKey];
    if (!rule) {
      return false;
    }

    let shouldTransition = false;
    if (typeof rule === 'object' && rule.onTextResponse !== undefined) {
      if (typeof rule.onTextResponse === 'function') {
        shouldTransition = rule.onTextResponse(this.#metrics, this.#budget);
      } else {
        shouldTransition = !!rule.onTextResponse;
      }
    }

    if (shouldTransition) {
      this.#transitionTo(nextPhase);
      this.#noteRecordQuotaExit(transKey, 'text');
      return true;
    }
    return false;
  }

  /**
   * L6-P17（C12）：RECORD→SUMMARIZE 由规则放行但已核实配额仍未达标，说明走的是“配额不可达”出口
   * （证据台账无文件条目，发现无法核实，见 ExplorationStrategies 的 isRecordQuotaUnreachable）。
   * 这是降级收口：记 warn 留下 target/effective/原始发现数，供排查维度证据为何全部无文件归属。
   * maxIterations / forceTerminal 的强制终结不经过规则，不在此记录。
   */
  #noteRecordQuotaExit(transKey: string, trigger: 'metrics' | 'text') {
    if (transKey !== 'RECORD→SUMMARIZE') {
      return;
    }
    const m = this.#metrics;
    const target = targetMemoryFindingCount(m);
    const effective = effectiveMemoryFindingCount(m);
    if (effective >= target) {
      return;
    }
    this.#logger.warn(
      `[ExplorationTracker] RECORD quota unreachable: ledger has no file entries — RECORD→SUMMARIZE via raw-finding exit ` +
        `(trigger=${trigger}, target=${target}, effective=${effective}, memoryFindingCount=${m.memoryFindingCount}, ` +
        `verified=${m.verifiedFindingCount ?? 0}, ledgerDistinctFiles=${m.ledgerDistinctFiles ?? 'absent'}, iter=${m.iteration})`
    );
  }

  #transitionTo(newPhase: string) {
    const oldPhase = this.#phase;
    const dwellMs = Date.now() - this.#phaseStartTime;
    this.#transitionFromPhase = oldPhase;
    this.#phase = newPhase;
    this.#phaseStartTime = Date.now();
    this.#metrics.phaseRounds = 0;
    this.#metrics.searchRoundsInPhase = 0;
    // 重置停滞计数器 — 防止跨阶段累积导致级联式过早转换
    // (SCAN 阶段的 roundsSinceNewInfo 不应影响 EXPLORE→VERIFY 的判定)
    this.#metrics.roundsSinceNewInfo = 0;
    this.#metrics.roundsSinceSubmit = 0;
    this.#metrics.consecutiveIdleRounds = 0;
    this.#justTransitioned = true;
    this.#transitionedSinceTick = true;
    this.#logger.info(
      `[ExplorationTracker] ${oldPhase} → ${newPhase} (iter=${this.#metrics.iteration}, submits=${this.#metrics.submitCount}, ` +
        `dwellMs=${dwellMs}, files=${this.#metrics.uniqueFiles.size}, patterns=${this.#metrics.uniquePatterns.size}, ` +
        // M1 收尾：深度槽观测面——findings/depthSlotted 是 CG-D 加权调参的唯一测量入口
        `findings=${this.#metrics.memoryFindingCount}, verified=${this.#metrics.verifiedFindingCount ?? 0}, depthSlotted=${this.#metrics.depthSlottedFindingCount ?? 0})`
    );

    // Phase 3: 发射阶段转换信号
    if (this.#signalBus) {
      const terminalPhase = this.#getTerminalPhase();
      const value = newPhase === terminalPhase ? 1.0 : 0.5;
      this.#signalBus.send('exploration', 'ExplorationTracker.phase', value, {
        metadata: { from: oldPhase, to: newPhase, iteration: this.#metrics.iteration },
      });
    }
  }

  #isTerminalPhase() {
    return this.#phase === this.#getTerminalPhase();
  }

  #getTerminalPhase() {
    return this.#strategy.phases[this.#strategy.phases.length - 1];
  }

  #hasRemainingProducerSubmits() {
    if (this.#pipelineType !== 'producer') {
      return false;
    }
    const target = targetProducerSubmitCount(this.#budget);
    return target > 0 && this.#metrics.submitCount < target;
  }

  /** 构建 NudgeState 供 NudgeGenerator / PlanTracker 使用 */
  #buildNudgeState() {
    return {
      phase: this.#phase,
      metrics: this.#metrics,
      budget: this.#budget,
      strategy: this.#strategy,
      gracefulExitRound: this.#gracefulExitRound,
      submitToolName: this.#submitToolName,
      pipelineType: this.#pipelineType,
      isTerminalPhase: this.#isTerminalPhase(),
      transitionFromPhase: this.#transitionFromPhase,
    };
  }
}

function isProducerCompletionText(text: string) {
  const normalized = text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }
  const hasCompletion =
    /已完成|完成转化|生产总结|提交总结|提交完成报告|已提交候选|已成功提交|提交完毕|全部\s*\d+\s*个候选|所有\s*\d+\s*个知识候选|所有\s*\d+\s*个结构化发现.*(提交|覆盖)|所有\s*\d+\s*个.*结构化发现.*(提交|覆盖)|所有\s*\d+\s*条.*已提交|候选生产总结|totalSubmitted\s*["']?\s*[:：]\s*\d+|successfully submitted|all\s+\d+\s+structured\s+analyst\s+findings|all\s+\d+.*findings.*submitted|提交候选数\s*[:：]?\s*\d+\s*\/\s*\d+|no unsubmitted/i.test(
      normalized
    );
  const hasNoRemaining =
    /无未提交|没有未提交|未提交\s*[:：]?\s*(0|零|无)|未提交原因\s*[:：]?\s*无|阻塞项\s*[:：]?\s*无|无遗漏|无阻断|无阻塞|无需继续|无需追加|无需使用|不需要\s*Analyst|无需\s*Analyst|不需要.*补充|无需.*补充|blockers\s*["']?\s*[:：]\s*\[\s*\]|unsubmittedFindings\s*["']?\s*[:：]\s*\[\s*\]|no remaining|no blockers|0\s+unsubmitted|unsubmitted\s*[:：]?\s*0/i.test(
      normalized
    );
  return hasCompletion && hasNoRemaining;
}

/** 未知 strategy 名的日志表示：字符串带引号（能看出空串与空白），其它类型标明类型。 */
function formatStrategyName(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return `${String(value)} (${typeof value})`;
}

function isEvidenceToolCall(toolName: string, args: Record<string, unknown>): boolean {
  const action = typeof args?.action === 'string' ? args.action : '';
  if (toolName === 'code') {
    return ['structure', 'search', 'read', 'outline'].includes(action);
  }
  if (toolName === 'graph') {
    return action === 'overview' || action === 'query';
  }
  if (toolName === 'terminal') {
    return action === 'exec';
  }
  return false;
}

export default ExplorationTracker;
