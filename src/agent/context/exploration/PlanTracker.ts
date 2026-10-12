import { readToolObservation } from '../../utils/toolOutcomes.js';
/**
 * PlanTracker — 探索计划跟踪器
 *
 * 从 ExplorationTracker.js 提取的规划与质量评估逻辑。
 * 管理首轮 plan elicitation、周期性 replan、计划进度匹配和质量评分。
 *
 * 计划进度只是近似、建议性的信号（不作为任何门禁）：
 *   - 偏差 replan 只由“连续 3 轮计划外探索动作”触发；计划未完成度交给周期触发，不再算作偏差；
 *   - deviationScore 是“自上次计划起计划外探索动作占比”的诊断值，不参与触发；
 *   - 只有成功的探索类动作（code/graph/terminal 取证动作）参与匹配与偏离统计，
 *     note_finding/knowledge 等记录类动作与失败动作既不完成步骤，也不算偏离。
 *
 * @module PlanTracker
 */
import {
  DEFAULT_REPLAN_INTERVAL,
  type ExplorationTrace,
  type PipelineType,
} from './ExplorationStrategies.js';

// ─── 类型定义 ──────────────────────────────────────────

/** trace 端口上的计划步骤（getPlanStepsMutable 返回的可变引用，匹配成功时原地标记 done） */
type PlanStep = ReturnType<NonNullable<ExplorationTrace['getPlanStepsMutable']>>[number];

/** trace 端口上的本轮工具动作 */
type RoundAction = ReturnType<NonNullable<ExplorationTrace['getCurrentRoundActions']>>[number];

/** checkPlanning 的状态参数 */
interface PlanCheckState {
  phase?: string;
  metrics: { iteration: number };
  budget: { maxIterations: number };
  strategy: { replanInterval?: number };
  pipelineType?: PipelineType;
  isTerminalPhase?: boolean;
}

/** 计划进度 */
interface PlanProgress {
  coveredSteps: number;
  totalSteps: number;
  /** 诊断值：自上次计划（含 replan）起，可计探索动作中计划外动作的占比；不参与 replan 触发。 */
  deviationScore: number;
  /** 自上次计划起的计划外探索动作数（记录类与失败动作不计）。 */
  unplannedActions: number;
  lastReplanIteration: number | null;
  /** 连续“有可计探索动作但全部未命中计划”的轮数；本轮没有可计动作时保持不变。 */
  consecutiveOffPlan: number;
}

/** replan 触发类型 */
type ReplanTrigger = 'periodic' | 'deviation';

/**
 * replan 触发已成立但被抑制的原因：
 *   - replan_cap: 本管线 replan 配额已用完；
 *   - bootstrap_late: bootstrap 已进入后段（≥65% 迭代），不再重排计划；
 *   - cooldown: 距上次 replan 不足 MIN_REPLAN_GAP 轮。
 */
type ReplanSuppressionReason = 'replan_cap' | 'bootstrap_late' | 'cooldown';

/** checkPlanning 向调用方报告的抑制诊断（返回值仍是 null，语义不变） */
interface ReplanSuppression {
  reason: ReplanSuppressionReason;
  triggers: ReplanTrigger[];
  iteration: number;
  replanCount: number;
  maxReplans: number;
  lastReplanIteration: number | null;
  consecutiveOffPlan: number;
  pipelineType: PipelineType;
  phase: string | null;
}

/** updatePlanProgress 对本轮动作的评估摘要，供调用方记录被跳过动作的诊断 */
interface PlanRoundEvaluation {
  /** 参与匹配与偏离统计的成功探索动作数 */
  countedActions: number;
  matchedActions: number;
  unplannedActions: number;
  /** ok===false 的失败动作：不完成步骤、不算偏离 */
  skippedFailedActions: number;
  /** 记录类/提交类等非探索动作：不完成步骤、不算偏离 */
  skippedNonExplorationActions: number;
  /** 本轮没有可计动作，consecutiveOffPlan 保持上一轮的值 */
  streakHeld: boolean;
  consecutiveOffPlan: number;
}

// ─── 常量 ──────────────────────────────────────────────

/** 连续 N 轮可计探索动作全部偏离计划才触发偏差 replan */
const DEVIATION_OFF_PLAN_ROUNDS = 3;
/** 最少经过 N 轮后才允许再次触发 replan（防止 replan 风暴） */
const MIN_REPLAN_GAP = 3;
/** Bootstrap 维度只允许一次真正 replan，避免慢模型重复消耗控制 token。 */
const MAX_BOOTSTRAP_REPLANS = 1;
/** 其它探索管线的默认 replan 上限。 */
const MAX_DEFAULT_REPLANS = 2;

/**
 * 参与计划匹配与偏离统计的探索类动作。口径与 ExplorationTracker 的 evidence 工具判定一致：
 * code 的 structure/search/read/outline、graph 的 overview/query、terminal 的 exec。
 * note_finding/knowledge/evidence 等记录、提交、台账动作不是“按计划探索”，不计入。
 */
const EXPLORATION_ACTIONS = new Map<string, ReadonlySet<string>>([
  ['code', new Set(['structure', 'search', 'read', 'outline'])],
  ['graph', new Set(['overview', 'query'])],
  ['terminal', new Set(['exec'])],
]);

/** 步骤描述里形如 a/b.ext 或 name.ext 的候选文件目标（再经 isFileTarget 过滤技术名与缩写） */
const FILE_TARGET_CANDIDATE_RE = /[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][\w-]*(?:\.[\w-]+)*/g;

/**
 * 不含 '/' 的候选只有扩展名在源码/配置白名单内才当文件目标，
 * 从而排除 e.g / i.e / socket.io 这类普通 token。
 */
const SOURCE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'swift',
  'm',
  'mm',
  'h',
  'hh',
  'hpp',
  'c',
  'cc',
  'cpp',
  'cxx',
  'py',
  'go',
  'java',
  'kt',
  'kts',
  'rs',
  'rb',
  'php',
  'cs',
  'scala',
  'dart',
  'lua',
  'ex',
  'exs',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'plist',
  'gradle',
  'md',
  'sql',
  'sh',
  'html',
  'css',
  'scss',
  'less',
  'proto',
  'graphql',
  'gql',
]);

/** Node.js / Vue.js / Express.js 这类首字母大写、不带路径的 X.js 是技术名而非文件 */
const TECH_NAME_JS_RE = /^[A-Z][A-Za-z0-9]*\.js$/;

/**
 * 总结/汇报类步骤：由 SUMMARIZE 阶段的文本产出完成，语义回退不允许任何工具动作替它打勾
 * （否则示例计划的“总结分析发现”会被第三次 code.search 完成）。
 */
const SUMMARY_STEP_RE = /总结|汇总|归纳|报告|\bsummar(?:y|ies|ize|ise|izing|ising)\b|\breport\b/;

/**
 * 语义回退：工具类别 → 步骤描述关键词。英文用词边界（避免 thread→read、recall→call、
 * classify→class），中文不用单字“类”（避免“类型”“分类”命中 graph），search 不再含泛化的“分析”。
 */
const SEMANTIC_STEP_RULES: ReadonlyArray<{ tool: string; action?: string; pattern: RegExp }> = [
  { tool: 'code', action: 'structure', pattern: /概览|目录|结构|项目|\b(?:overview|structure)\b/ },
  {
    tool: 'graph',
    pattern:
      /继承|类名|类图|类关系|类层次|子类|父类|基类|图谱|调用|关系|依赖|\b(?:hierarch(?:y|ies)|class(?:es)?|graph|call(?:s|ers?|ees?)?)\b/,
  },
  { tool: 'code', action: 'read', pattern: /阅读|深入|查看|文件|\bread(?:s|ing)?\b/ },
  { tool: 'code', action: 'search', pattern: /搜索|查找|\bsearch(?:es|ing)?\b/ },
];

export class PlanTracker {
  /** 等待 AI 输出 replan */
  #pendingReplan = false;
  #replanCount = 0;
  /** 自上次计划起命中计划的探索动作数（deviationScore 的分母之一；不进入公开 progress 形状） */
  #matchedActions = 0;
  /** 计划进度 */
  #planProgress: PlanProgress = {
    coveredSteps: 0,
    totalSteps: 0,
    deviationScore: 0,
    unplannedActions: 0,
    lastReplanIteration: null,
    consecutiveOffPlan: 0,
  };

  /** 获取计划进度 */
  get progress() {
    return { ...this.#planProgress };
  }

  /**
   * 检查是否需要触发规划 + 生成规划 nudge
   *
   * @param state 从 ExplorationTracker 传入
   * @param trace ActiveContext 实例
   * @param onSuppressed 触发条件成立但被配额/后段/冷却抑制时回调（返回值仍为 null），供调用方记录诊断
   * @returns 规划 nudge；无需规划或被抑制时为 null
   */
  checkPlanning(
    state: PlanCheckState,
    trace: ExplorationTrace | null,
    onSuppressed?: (suppression: ReplanSuppression) => void
  ) {
    const { metrics, budget: b, strategy } = state;
    const m = metrics;
    const pipelineType = state.pipelineType || 'bootstrap';

    // VERIFY 阶段是否停止 replan 属于阶段策略决定④，此处维持原口径：只有终结/PRODUCE/RECORD 不规划。
    if (state.isTerminalPhase || state.phase === 'PRODUCE' || state.phase === 'RECORD') {
      return null;
    }

    // 第 1 轮: plan elicitation
    if (m.iteration === 1) {
      trace?.expectPlan?.();
      return {
        type: 'planning',
        text:
          pipelineType === 'bootstrap'
            ? this.#buildCompactPlanElicitationPrompt(b.maxIterations || 30)
            : this.#buildPlanElicitationPrompt(b.maxIterations || 30),
      };
    }

    // 有计划时: 检查 replan
    const plan = trace?.getPlan?.();
    if (!plan) {
      return null;
    }

    const progress = this.#planProgress;
    const interval = strategy.replanInterval || DEFAULT_REPLAN_INTERVAL;

    const baseIteration = progress.lastReplanIteration || plan.createdAtIteration;
    const periodicTrigger =
      interval > 0 && m.iteration > 1 && m.iteration - baseIteration >= interval;
    // 偏差只看连续偏离轮数：按计划推进但尚未完成的计划不是偏差（未完成度由周期触发回顾）。
    const deviationTrigger = progress.consecutiveOffPlan >= DEVIATION_OFF_PLAN_ROUNDS;

    const triggers: ReplanTrigger[] = [];
    if (periodicTrigger) {
      triggers.push('periodic');
    }
    if (deviationTrigger) {
      triggers.push('deviation');
    }
    if (triggers.length === 0) {
      return null;
    }

    const maxReplans = pipelineType === 'bootstrap' ? MAX_BOOTSTRAP_REPLANS : MAX_DEFAULT_REPLANS;
    // 触发已成立却不发 nudge 的短路分支：把原因交给调用方记录，返回值保持 null。
    const suppress = (reason: ReplanSuppressionReason) => {
      onSuppressed?.({
        reason,
        triggers,
        iteration: m.iteration,
        replanCount: this.#replanCount,
        maxReplans,
        lastReplanIteration: progress.lastReplanIteration,
        consecutiveOffPlan: progress.consecutiveOffPlan,
        pipelineType,
        phase: state.phase ?? null,
      });
      return null;
    };
    if (this.#replanCount >= maxReplans) {
      return suppress('replan_cap');
    }
    if (
      pipelineType === 'bootstrap' &&
      m.iteration >= Math.max(2, Math.floor(b.maxIterations * 0.65))
    ) {
      return suppress('bootstrap_late');
    }

    // 冷却间隔
    if (
      progress.lastReplanIteration &&
      m.iteration - progress.lastReplanIteration < MIN_REPLAN_GAP
    ) {
      return suppress('cooldown');
    }

    const remaining = b.maxIterations - m.iteration;
    const parts: string[] = [];
    if (pipelineType === 'bootstrap') {
      progress.lastReplanIteration = m.iteration;
      this.#pendingReplan = true;
      this.#replanCount++;
      trace?.expectPlan?.();
      return {
        type: 'planning',
        text:
          `📋 计划偏差检查：剩余 ${remaining} 轮。只保留仍能产出维度候选或 digest 的步骤；` +
          `已进入提交/总结方向时不要重新搜索。请用 1-3 条更新计划并继续执行。`,
      };
    }
    if (deviationTrigger) {
      parts.push(`📋 计划偏差检查 (第 ${m.iteration}/${b.maxIterations} 轮):`);
      parts.push(`你的行为已连续 ${progress.consecutiveOffPlan} 轮偏离原定计划。`);
    } else {
      parts.push(`📋 计划进度回顾 (第 ${m.iteration}/${b.maxIterations} 轮):`);
    }

    const doneSteps = plan.steps.filter((s) => s.status === 'done');
    const pendingSteps = plan.steps.filter((s) => s.status === 'pending');
    if (doneSteps.length > 0) {
      parts.push(`\n✅ 已完成 (${doneSteps.length}/${plan.steps.length}):`);
      for (const s of doneSteps) {
        parts.push(`  - ${s.description}`);
      }
    }
    if (pendingSteps.length > 0) {
      parts.push(`\n⏳ 未完成 (${pendingSteps.length}/${plan.steps.length}):`);
      for (const s of pendingSteps) {
        parts.push(`  - ${s.description}`);
      }
    }
    if (progress.unplannedActions > 0) {
      parts.push(`\n⚡ 计划外行为: ${progress.unplannedActions} 次`);
    }
    parts.push(`\n剩余 ${remaining} 轮。请评估:`);
    parts.push(`1. 未完成的步骤是否仍然相关？`);
    parts.push(`2. 是否需要根据新发现调整后续步骤？`);
    parts.push(`3. 请更新你的探索计划（用编号列表）。`);

    progress.lastReplanIteration = m.iteration;
    this.#pendingReplan = true;
    this.#replanCount++;
    trace?.expectPlan?.();

    return { type: 'planning', text: parts.join('\n') };
  }

  /**
   * 更新计划进度（从 ReasoningLayer 迁入）
   * 将本轮成功的探索类工具调用与 plan 步骤进行模糊匹配
   *
   * @param trace ActiveContext 实例
   * @returns 本轮动作评估摘要；没有计划或本轮没有动作时为 null
   */
  updatePlanProgress(trace: ExplorationTrace | null): PlanRoundEvaluation | null {
    const steps = trace?.getPlanStepsMutable?.() || [];
    if (steps.length === 0) {
      return null;
    }

    // 处理 pending replan：新计划从零起算，旧计划的偏离连击、计划内/外计数与诊断占比都不延续。
    if (this.#pendingReplan) {
      const plan = trace?.getPlan?.();
      if (plan) {
        this.#planProgress.coveredSteps = plan.steps.filter((s) => s.status === 'done').length;
        this.#planProgress.totalSteps = plan.steps.length;
        this.#planProgress.unplannedActions = 0;
        this.#planProgress.consecutiveOffPlan = 0;
        this.#planProgress.deviationScore = 0;
        this.#matchedActions = 0;
        this.#pendingReplan = false;
      }
    }

    const actions = trace?.getCurrentRoundActions?.() || [];
    if (actions.length === 0) {
      return null;
    }

    let matchedThisRound = 0;
    let unplannedThisRound = 0;
    let skippedFailedActions = 0;
    let skippedNonExplorationActions = 0;

    for (const action of actions) {
      // 失败动作没有真实观察结果：不能完成步骤，也不代表模型偏离计划。
      if (action.ok === false) {
        skippedFailedActions++;
        continue;
      }
      const observation = readToolObservation({ tool: action.tool, args: action.params });
      // 记录/提交类动作（note_finding、knowledge 等）不是计划内的探索步骤，不参与匹配与偏离统计。
      if (!isExplorationAction(action.tool, observation.action)) {
        skippedNonExplorationActions++;
        continue;
      }
      const matchedStep = this.#findMatchingStep(
        steps,
        action,
        observation.params,
        observation.action
      );
      if (matchedStep) {
        matchedStep.status = 'done';
        matchedThisRound++;
      } else {
        unplannedThisRound++;
      }
    }

    const countedActions = matchedThisRound + unplannedThisRound;
    // 本轮没有任何可计探索动作（只记录发现或只有失败调用）时保持连击不变：既不算偏离，也不算回到计划。
    const streakHeld = countedActions === 0;
    if (!streakHeld) {
      this.#matchedActions += matchedThisRound;
      this.#planProgress.unplannedActions += unplannedThisRound;
      if (matchedThisRound > 0) {
        this.#planProgress.consecutiveOffPlan = 0;
      } else {
        this.#planProgress.consecutiveOffPlan++;
      }
    }

    this.#planProgress.coveredSteps = steps.filter((s) => s.status === 'done').length;
    this.#planProgress.totalSteps = steps.length;
    const sample = this.#matchedActions + this.#planProgress.unplannedActions;
    // 诊断占比保留两位小数：它会以 planProgress 进入模型输入，过长的浮点只浪费 token。
    this.#planProgress.deviationScore =
      sample > 0 ? Math.round((this.#planProgress.unplannedActions / sample) * 100) / 100 : 0;

    return {
      countedActions,
      matchedActions: matchedThisRound,
      unplannedActions: unplannedThisRound,
      skippedFailedActions,
      skippedNonExplorationActions,
      streakHeld,
      consecutiveOffPlan: this.#planProgress.consecutiveOffPlan,
    };
  }

  /**
   * 推理质量评分
   * @returns 总分与分项
   */
  getQualityMetrics(trace: ExplorationTrace | null) {
    const stats: Record<string, number> = trace?.getStats?.() || {
      totalRounds: 0,
      thoughtCount: 0,
      totalActions: 0,
      totalObservations: 0,
      reflectionCount: 0,
    };
    const totalRounds = stats.totalRounds || 1;

    const thoughtRatio = stats.thoughtCount / totalRounds;
    const reflectionRatio = stats.reflectionCount / totalRounds;
    const actionEfficiency = Math.min(stats.totalActions / totalRounds / 3, 1);
    const observationCoverage = stats.totalObservations > 0 ? 1 : 0;

    const plan = trace?.getPlan?.();
    const hasPlan = plan && plan.steps.length > 0;
    let planScore = 0;
    // completion 看步骤完成度，adherence 看探索动作是否落在计划内（1 - 计划外占比），两者口径独立。
    const completionRate =
      this.#planProgress.totalSteps > 0
        ? this.#planProgress.coveredSteps / this.#planProgress.totalSteps
        : 0;
    const adherenceRate = 1 - (this.#planProgress.deviationScore || 0);
    if (hasPlan) {
      planScore = completionRate * 0.6 + adherenceRate * 0.4;
    }

    const score = hasPlan
      ? Math.round(
          (thoughtRatio * 0.3 +
            reflectionRatio * 0.15 +
            actionEfficiency * 0.15 +
            observationCoverage * 0.15 +
            planScore * 0.25) *
            100
        )
      : Math.round(
          (thoughtRatio * 0.4 +
            reflectionRatio * 0.2 +
            actionEfficiency * 0.2 +
            observationCoverage * 0.2) *
            100
        );

    const breakdown: Record<string, number> = {
      ...stats,
      thoughtRatio: Math.round(thoughtRatio * 100),
      reflectionRatio: Math.round(reflectionRatio * 100),
      actionEfficiency: Math.round(actionEfficiency * 100),
      observationCoverage: Math.round(observationCoverage * 100),
    };

    if (hasPlan) {
      breakdown.planCompletion = Math.round(completionRate * 100);
      breakdown.planAdherence = Math.round(adherenceRate * 100);
      breakdown.planScore = Math.round(planScore * 100);
    }

    return { score, breakdown };
  }

  // ─── 内部方法 ──────────────────────────────────

  #buildPlanElicitationPrompt(maxIter: number) {
    return [
      `📋 在开始探索前，请先制定一个简要的探索计划。`,
      ``,
      `你有 ${maxIter} 轮工具调用机会。请在你的回复中用编号列表简述 3-6 个探索步骤:`,
      `- 每个步骤应描述要搜索/阅读的目标（具体的类名、模式、文件路径）`,
      `- 步骤应从宏观到微观递进（先概览 → 再搜索关键模式 → 再深入关键文件）`,
      `- 最后一步应是"总结分析发现"`,
      ``,
      `例如:`,
      `1. 获取项目概览和目录结构，识别核心模块`,
      `2. 搜索网络请求相关类，分析请求模式`,
      `3. 搜索错误处理和响应解析模式`,
      `4. 深入阅读 3-5 个典型实现文件，确认关键细节`,
      `5. 总结分析发现`,
      ``,
      `制定计划后等待下一轮开始执行第 1 步；如果当前阶段开放工具，再调用对应工具。`,
    ].join('\n');
  }

  #buildCompactPlanElicitationPrompt(maxIter: number) {
    return [
      `📋 请先给出不超过 3 步的维度探索计划（总轮次 ${maxIter}）。`,
      `计划必须直接服务于候选提交或 dimensionDigest 输出；避免列出泛泛扫描项。`,
      `制定计划后等待下一轮执行第 1 步；不要在无工具阶段声称已调用工具。`,
    ].join('\n');
  }

  /**
   * 模糊匹配: 将一次成功的探索动作匹配到 plan 步骤
   *
   * 匹配顺序：参数（或 read 成功路径）点名了步骤文件目标的步骤优先；随后按显式关键词、
   * 工具类别语义回退依次尝试。read 的文件目标是硬门槛（读另一个文件不能完成指定文件步骤），
   * 非 read 工具的文件目标只是软信号（只调整优先级，不点名也不排除）。
   */
  #findMatchingStep(
    steps: PlanStep[],
    action: RoundAction,
    params: Record<string, unknown>,
    actionName: string
  ): PlanStep | null {
    const toolName = action.tool;
    const argsStr = JSON.stringify(params).toLowerCase();
    const isRead = toolName === 'code' && actionName === 'read';

    let readPaths: string[] = [];
    if (isRead) {
      const paths: unknown[] =
        action.successfulReadPaths ??
        (Array.isArray(params.filePaths) ? params.filePaths : [params.path ?? params.filePath]);
      readPaths = paths
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.replaceAll('\\', '/').replace(/^\.\//, ''));
      // 回执表明一个文件都没读到（整批失败）：不能完成任何步骤。
      if (action.successfulReadPaths && readPaths.length === 0) {
        return null;
      }
    }

    // monorepo 后缀放宽与现有 exact-path 语义冲突，暂不放宽：带 '/' 的目标必须精确相等。
    const targetHit = (target: string) =>
      isRead
        ? readPaths.some(
            (file) => file === target || (!target.includes('/') && file.endsWith(`/${target}`))
          )
        : argsStr.includes(target.toLowerCase());

    const candidates = steps
      .filter((step) => step.status !== 'done')
      .map((step) => {
        const targets = extractFileTargets(step.description);
        return { step, targets, hit: targets.some(targetHit) };
      });
    // 命中文件目标的步骤优先尝试（稳定排序，保持计划原顺序）。
    const ordered = [
      ...candidates.filter((candidate) => candidate.hit),
      ...candidates.filter((candidate) => !candidate.hit),
    ];

    for (const { step, targets, hit } of ordered) {
      if (isRead && targets.length > 0 && !hit) {
        continue;
      }

      // 策略 1: 关键词匹配
      if (step.keywords?.some((kw) => argsStr.includes(kw.toLowerCase()))) {
        return step;
      }

      // 总结/汇报类步骤不参与语义回退，只能由显式关键词命中。
      if (isSummaryStep(step.description)) {
        continue;
      }

      // 策略 2: 工具类型 → 步骤描述的语义匹配
      if (matchesStepSemantics(toolName, actionName, step.description.toLowerCase())) {
        return step;
      }
    }

    return null;
  }
}

// ─── 模块内辅助 ────────────────────────────────────────

function isExplorationAction(tool: string, action: string): boolean {
  return EXPLORATION_ACTIONS.get(tool)?.has(action) === true;
}

/** 抽取步骤描述中的明确文件目标：含 '/' 的路径，或扩展名在白名单内且不是 X.js 技术名的文件名。 */
function extractFileTargets(description: string): string[] {
  const candidates = description.match(FILE_TARGET_CANDIDATE_RE) || [];
  return candidates.filter(isFileTarget);
}

function isFileTarget(token: string): boolean {
  if (token.includes('/')) {
    return true;
  }
  const extension = token.slice(token.lastIndexOf('.') + 1).toLowerCase();
  if (!SOURCE_FILE_EXTENSIONS.has(extension)) {
    return false;
  }
  return !TECH_NAME_JS_RE.test(token);
}

function isSummaryStep(description: string): boolean {
  // 先剔除文件目标候选，避免 src/report.ts 之类路径把普通阅读步骤误判成总结步骤。
  const prose = description.replace(FILE_TARGET_CANDIDATE_RE, ' ').toLowerCase();
  return SUMMARY_STEP_RE.test(prose);
}

function matchesStepSemantics(toolName: string, actionName: string, desc: string): boolean {
  return SEMANTIC_STEP_RULES.some(
    (rule) =>
      rule.tool === toolName &&
      (rule.action === undefined || rule.action === actionName) &&
      rule.pattern.test(desc)
  );
}
