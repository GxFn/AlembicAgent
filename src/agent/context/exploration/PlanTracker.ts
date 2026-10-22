import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
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
 *     note_finding/knowledge 等记录类动作与失败动作既不完成步骤，也不算偏离；
 *   - 计划外只指“既不能完成未完成步骤、也不是续做已完成步骤”的探索动作；未完成的只剩总结类
 *     步骤（工具动作按设计不能完成）时，未命中的探索动作不算偏离，连击保持不变（L6-P16r3 C015）；
 *     这条保持只在还有未完成步骤时成立——计划全部完成后不能续做的探索动作仍是计划外，偏差 replan
 *     照常触发（L6-P16r4）；
 *   - terminal.exec 的语义回退不能完成、也不能续做带明确文件目标的步骤（文件目标口径与 read/outline 的
 *     硬门槛相同；“运行/执行”直接带出的被执行脚本是执行对象，不算）。这类步骤只能由读/看该文件、
 *     参数以路径边界点名该文件、或参数含步骤显式关键词的动作命中，无关终端命令（ls、git status）
 *     一律计入计划外（L6-P16r6）。
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
  /** 参与匹配与偏离统计的成功探索动作数（= matchedActions + unplannedActions） */
  countedActions: number;
  /** 落在计划内的探索动作：完成了未完成步骤，或续做已完成步骤（后者不再改变步骤状态） */
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

/** 步骤描述里形如 a/b.ext 或 name.ext 的候选文件目标（再经 extractFileTargets 过滤技术名与缩写） */
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

/**
 * 不带路径时视作技术名而非文件的 X.js：首字母大写（技术名的惯用写法），且按小写比较在本清单内。
 * 只看“首字母大写 + .js”的形状会把 React 组件 App.js / Header.js 也当技术名，read 的文件目标硬门槛
 * 随之失效（L6-P16r3 C016），因此改为显式清单；小写 node.js 这类写法维持原口径仍当文件目标。
 * 只收录不太可能同时是同名源码文件的框架/运行时名；Chart.js、Video.js 这类也常见于组件文件名的歧义名
 * 不收录——误当文件只会让步骤更难被自动完成，误当技术名则会让读无关文件完成该步骤。
 */
const JS_TECH_NAMES: ReadonlySet<string> = new Set([
  'node.js',
  'vue.js',
  'react.js',
  'angular.js',
  'express.js',
  'next.js',
  'nuxt.js',
  'nest.js',
  'ember.js',
  'backbone.js',
  'knockout.js',
  'meteor.js',
  'three.js',
  'd3.js',
  'koa.js',
  'hapi.js',
  'preact.js',
  'alpine.js',
]);

/**
 * 总结/汇报类步骤：由 SUMMARIZE 阶段的文本产出完成，语义回退不允许任何工具动作替它打勾
 * （否则示例计划的“总结分析发现”会被第三次 code.search 完成）。
 */
const SUMMARY_STEP_RE = /总结|汇总|归纳|报告|\bsummar(?:y|ies|ize|ise|izing|ising)\b|\breport\b/;

/**
 * “运行/执行”后不带参数也算命令宾语的 CLI 名（小写比较）：在中文计划措辞里几乎只当命令出现，
 * 如“运行 pytest 确认”“执行 make”。
 */
const STANDALONE_COMMAND_NAMES = [
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'bunx',
  'tsc',
  'ts-node',
  'vitest',
  'jest',
  'mocha',
  'pytest',
  'eslint',
  'biome',
  'prettier',
  'cargo',
  'mvn',
  'gradle',
  'gradlew',
  'xcodebuild',
  'xcrun',
  'kubectl',
  'dotnet',
  'make',
  'cmake',
  'pip',
  'pip3',
  'ls',
  'pwd',
  'grep',
  'rg',
  'curl',
  'wget',
];

/**
 * 同时常作语言/运行时/产品名词的命令名：后面紧跟任意 ASCII 词就按参数处理、算命令宾语——不只是子命令、
 * 选项、路径，“执行 git hooks”“运行 Node 18”“运行 docker container”里的名词和版本号也算。这条只滤掉
 * 命令名后不带 ASCII 词的名词用法（“执行 git 操作”“运行 Node 服务”“运行 Swift 并发任务”，L6-P16r5），
 * 并不判定步骤是不是命令步骤；“运行 Python 脚本”这类无参数写法随之不再命中，属保守取舍。
 * 带文件目标的阅读步骤不靠这里的措辞保护，而由 #findMatchingStep 的 terminal 文件目标门槛挡住（L6-P16r6）。
 */
const ARGUMENT_COMMAND_NAMES = [
  'git',
  'gh',
  'node',
  'deno',
  'bun',
  'tsx',
  'python',
  'python3',
  'ruby',
  'gem',
  'bundle',
  'rake',
  'php',
  'composer',
  'java',
  'go',
  'swift',
  'docker',
  'sh',
  'bash',
  'zsh',
  'flutter',
  'dart',
  'uv',
  'poetry',
];

/** 命令名转成正则分支：按长度降序（python3 先于 python），并按字面转义 '-'、'.' 等字符。 */
function commandNameAlternation(names: readonly string[]): string {
  return [...names]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

/**
 * terminal.exec 规则里“运行/执行”后的拉丁宾语（在小写化描述上匹配）。只收四种形状：
 *   - 显式执行路径或变量：./x、../x、~/x、$VAR、${VAR}；
 *   - shell 脚本文件（可带相对目录）：scripts/release.sh、check.sh；
 *   - STANDALONE_COMMAND_NAMES 里的命令名（后面不再接文件名字符；“执行 make 目标”这类名词用法也会命中）；
 *   - ARGUMENT_COMMAND_NAMES 里的命令名且紧跟任意 ASCII 词（git log、node scripts/x.mjs，也包括 git hooks）。
 * r4 的 `[a-z.~$]` 只看首字符，小写后任何拉丁词（sql/http/electron/reducer/pipeline/tool）都当命令名；
 * `\/` 又让“执行/重试流程”这种斜杠并列命中。两者都删掉，不再收裸的 /x 绝对路径（计划步骤几乎不写
 * 绝对路径，误把斜杠并列当路径的代价更大）。
 */
const TERMINAL_LATIN_COMMAND_OBJECT =
  '(?:\\.{1,2}\\/|~\\/)[\\w.-]|\\$\\{?[a-z_]' +
  '|(?:[\\w.-]+\\/)*[\\w.-]+\\.(?:sh|bash|zsh|ps1|bat|cmd)(?![\\w-])' +
  `|(?:${commandNameAlternation(STANDALONE_COMMAND_NAMES)})(?![\\w-]|\\.\\w)` +
  `|(?:${commandNameAlternation(ARGUMENT_COMMAND_NAMES)})[ \\t]+[\\w./~$-]`;

/**
 * 步骤描述里由“运行/执行”（或英文 run/exec 动词）直接带出的“被执行对象”（第 1 捕获组）：宾语必须先满足
 * TERMINAL_LATIN_COMMAND_OBJECT，区段只延伸到该宾语所在的 ASCII token 结束——执行路径/脚本文件本身
 * （./scripts/check.sh、scripts/release.sh），或 ARGUMENT_COMMAND_NAMES 命令名带的第一个参数
 * （node scripts/check.mjs、bash scripts/release.sh 的脚本）。落在区段里的文件目标是步骤要执行的对象，
 * 不是要阅读的目标，terminal 文件目标门槛不把它们算进去。
 * 不再向后吞后续参数：英文散文整段都是 ASCII，“run git hooks in src/hooks/index.ts”若按命令行延伸，
 * 会把真正要读的文件也当成命令参数放行；“执行 git log src/a.ts”里的 src/a.ts 也不是被执行对象，
 * 仍受门槛约束（点名该文件的命令仍可经显式命中完成）。
 * 在原始描述上按 i 标志匹配（不先转小写），保证捕获组下标与 FILE_TARGET_CANDIDATE_RE 的下标对齐。
 */
const EXECUTED_OBJECT_SPAN_RE = new RegExp(
  `(?:(?<!可)(?:运行|执行)|\\b(?:run(?:s|ning)?|exec(?:ut(?:e[sd]?|ing))?)\\b)\\s*[\`'"“「]?\\s*` +
    `((?:${TERMINAL_LATIN_COMMAND_OBJECT})[!-~]*)`,
  'gi'
);

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
  // outline 是单文件取证（文件骨架），与 read 共用阅读类词；不含“结构/概览”，避免完成项目级概览步骤。
  {
    tool: 'code',
    action: 'outline',
    pattern: /大纲|阅读|深入|查看|文件|\b(?:outlines?|read(?:s|ing)?)\b/,
  },
  { tool: 'code', action: 'search', pattern: /搜索|查找|\bsearch(?:es|ing)?\b/ },
  // terminal.exec 的近似规则，只用来识别“运行/执行命令、运行测试、查看 git 状态”类步骤：
  //   - 中文没有词边界：“运行/执行”只有作为动词直接带命令宾语（TERMINAL_LATIN_COMMAND_OBJECT 收的拉丁命令名
  //     或执行路径，或测试、检查（带修饰语）、单测、用例、脚本、构建、编译、打包、安装、命令、示例这类命令对象）
  //     时才命中；“运行时”“执行流程/细节/逻辑”“可执行脚本”（L6-P16r4）、“执行 SQL 查询”这类名单外拉丁宾语
  //     与“执行/重试”斜杠并列（L6-P16r5）不命中；
  //   - git 状态分支只在查看动作（查看/检查/确认/看看、check/show/view）直接带出 git 状态时命中：“查看 git 状态”
  //     “检查 git 仓库状态”“check git status”命中；“理解 git 状态机实现”“分析 git 仓库状态同步流程”“阅读 git 状态
  //     管理逻辑”“Read how the parser handles git status output”这类讲 git 状态实现的步骤不命中（L6-P16r7）；
  //   - 已知仍会过宽命中：白名单命令名 + 任意 ASCII 词（“执行 git hooks”“运行 Node 18”“执行 make 目标”）、
  //     英文分支命中路径片段与散文（src/cli/commands.ts、src/runner/run.ts、“run loop”）、裸“命令/终端”子串
  //     （“命令行解析模块”）、查看动作 + git 状态后接实现类名词（“查看 git 状态机实现”）。
  // r3–r5 每轮收紧这里的措辞，复查都能再举出新的命中写法，所以措辞不再承担保护阅读步骤的职责：带明确文件
  // 目标的步骤由 #findMatchingStep 的 terminal 文件目标门槛挡住，语义回退一律不能完成或续做它（L6-P16r6）。
  // 这条规则的过宽命中因此只会落在没有文件目标的步骤上；计划进度只是建议性信号，不作门禁。
  // 不收单独的“测试/脚本”，避免完成“阅读测试文件”这类阅读步骤；“运行检查”这类无修饰语的宾语不命中，
  // 是宁可少完成也不误完成的保守取舍（未命中只会计入计划外）。
  {
    tool: 'terminal',
    action: 'exec',
    pattern: new RegExp(
      `(?<!可)(?:运行|执行)\\s*[\`'"“「]?\\s*(?:${TERMINAL_LATIN_COMMAND_OBJECT}|` +
        '(?:单元|集成|端到端|回归|冒烟)?测试|(?:类型|静态|代码)检查|单测|用例|脚本|构建|编译|打包|安装|命令|示例|样例)' +
        '|(?:查看|检查|确认|看看|\\b(?:check(?:s|ing)?|show(?:s|ing)?|view(?:s|ing)?)\\s)' +
        '\\s*git\\s*(?:工作区|仓库)?\\s*(?:状态|status\\b)' +
        '|命令|终端|\\b(?:run(?:s|ning)?|exec(?:ut(?:e[sd]?|ing))?|commands?|shell|terminal)\\b'
    ),
  },
];

/** 诊断日志统一走 observeSafely：日志通道失败不能升级为计划进度更新失败。 */
function logPlanDiagnostic(message: string) {
  observeSafely(
    () => Logger.getInstance().debug(message),
    () => undefined
  );
}

export class PlanTracker {
  /** 等待 AI 输出 replan */
  #pendingReplan = false;
  #replanCount = 0;
  /** 自上次计划起命中计划的探索动作数（deviationScore 的分母之一；不进入公开 progress 形状） */
  #matchedActions = 0;
  /** 已记录过“技术名被排除出文件目标”诊断的步骤：同一步骤只记一次，避免每轮重复刷日志 */
  #techNameLoggedSteps = new WeakSet<PlanStep>();
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

    let completedThisRound = 0;
    let continuedThisRound = 0;
    let unplannedThisRound = 0;
    let exhaustedHeldThisRound = 0;
    /** 计划全部完成后仍未命中任何步骤的探索动作：计入计划外，单独记诊断以区别于“只剩总结步”的保持 */
    let completedPlanOffPlanThisRound = 0;
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
      // 同一轮内前面的动作可能刚完成步骤，因此每个动作都重新按当前状态划分未完成/已完成步骤。
      const openSteps = steps.filter((step) => step.status !== 'done');
      const matchedStep = this.#findMatchingStep(
        openSteps,
        action,
        observation.params,
        observation.action
      );
      if (matchedStep) {
        matchedStep.status = 'done';
        completedThisRound++;
        continue;
      }
      // 续做：动作按同样规则落在已完成步骤上（如“深入阅读 3-5 个典型实现文件”读第 2、3 个文件），
      // 是在执行计划而不是偏离；不改步骤状态，但和完成步骤一样让偏离连击归零。
      const continuedStep = this.#findMatchingStep(
        steps.filter((step) => step.status === 'done'),
        action,
        observation.params,
        observation.action
      );
      if (continuedStep) {
        continuedThisRound++;
        continue;
      }
      // 计划已耗尽：未完成的只剩总结类步骤（任何工具动作按设计都不能完成），模型在 toolChoice=required
      // 下被迫继续探索不算偏离；与只有记录/失败动作的轮次同口径，不计入统计、连击保持不变。
      // 必须还有未完成步骤：every 对空集恒真，否则计划全部完成后的探索也会被当成耗尽保持，偏差 replan
      // 在该计划的生命周期内永远不再触发（L6-P16r4）。
      if (openSteps.length > 0 && openSteps.every((step) => isSummaryStep(step.description))) {
        exhaustedHeldThisRound++;
        continue;
      }
      if (openSteps.length === 0) {
        // 计划全部完成后既不能完成、也不能续做任何步骤的探索：按文件头的计划外定义计入偏离。
        completedPlanOffPlanThisRound++;
      }
      unplannedThisRound++;
    }

    const matchedThisRound = completedThisRound + continuedThisRound;
    const countedActions = matchedThisRound + unplannedThisRound;
    // 本轮没有任何可计探索动作（只记录发现、只有失败调用，或计划耗尽后只剩总结步时的探索）时
    // 保持连击不变：既不算偏离，也不算回到计划。
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

    if (continuedThisRound > 0 || exhaustedHeldThisRound > 0) {
      // 续做与“计划耗尽只剩总结步”都是不改步骤状态、也不算偏离的分叉路径，记下口径便于回放偏差判断。
      const openSummarySteps = steps
        .filter((step) => step.status !== 'done')
        .map((step) => step.description);
      logPlanDiagnostic(
        `[PlanTracker] plan progress classified on-plan exploration without new step: ` +
          `continued=${continuedThisRound} action(s) on done steps (counted as on-plan, streak reset), ` +
          `exhaustedHeld=${exhaustedHeldThisRound} action(s)` +
          (exhaustedHeldThisRound > 0
            ? ` (plan exhausted except summary step(s) [${openSummarySteps.join(' | ')}]; not counted, streak held)`
            : '') +
          `; completed=${completedThisRound}, unplanned=${unplannedThisRound}, ` +
          `consecutiveOffPlan=${this.#planProgress.consecutiveOffPlan}`
      );
    }
    if (completedPlanOffPlanThisRound > 0) {
      // 计划做完后继续探索不是“耗尽保持”：计入计划外并推进偏离连击，让偏差 replan 把模型引向提交/总结。
      logPlanDiagnostic(
        `[PlanTracker] plan progress counted off-plan exploration after plan completion: ` +
          `all ${steps.length} step(s) done, ${completedPlanOffPlanThisRound} action(s) neither completed ` +
          `nor continued a step; counted as unplanned (streak not held), unplanned=${unplannedThisRound}, ` +
          `consecutiveOffPlan=${this.#planProgress.consecutiveOffPlan}`
      );
    }

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
   * @deprecated 唯一调用方 ExplorationTracker.getQualityMetrics 也无生产调用方；
   *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
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
   * 模糊匹配: 将一次成功的探索动作匹配到给定的一组 plan 步骤（调用方先传未完成步骤，再传已完成步骤判定续做）
   *
   * 匹配顺序：参数（或 read 成功路径）点名了步骤文件目标的步骤优先；随后依次尝试显式关键词、
   * 文件目标命中、工具类别语义回退。read/outline 是单文件取证，文件目标是硬门槛（读或看另一个文件的
   * 大纲不能完成指定文件步骤）；其它工具的文件目标是软信号：不排除步骤，但参数以路径边界点名了步骤
   * 文件目标时直接算命中（L6-P16r3 C017：code.search 限定在该文件上不能被记为计划外）。
   * terminal.exec 例外：步骤有待检视的文件目标时，它的语义回退不生效（L6-P16r6 文件目标门槛），
   * 只能经关键词或点名文件命中。
   * 总结/汇报类步骤只能由显式关键词命中，文件目标命中与语义回退都跳过它。
   */
  #findMatchingStep(
    steps: PlanStep[],
    action: RoundAction,
    params: Record<string, unknown>,
    actionName: string
  ): PlanStep | null {
    if (steps.length === 0) {
      return null;
    }
    const toolName = action.tool;
    const argsStr = JSON.stringify(params).toLowerCase();
    const isRead = toolName === 'code' && actionName === 'read';
    const isFileScoped = isRead || (toolName === 'code' && actionName === 'outline');

    let scopedPaths: string[] = [];
    if (isFileScoped) {
      // read 优先使用回执里真正读到的文件；outline 只有请求参数里的单个 path（失败动作已在调用方跳过）。
      const paths: unknown[] =
        (isRead ? action.successfulReadPaths : undefined) ??
        (Array.isArray(params.filePaths) ? params.filePaths : [params.path ?? params.filePath]);
      scopedPaths = paths
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.replaceAll('\\', '/').replace(/^\.\//, ''));
      // 回执表明一个文件都没读到（整批失败）：不能完成任何步骤。
      if (isRead && action.successfulReadPaths && scopedPaths.length === 0) {
        return null;
      }
    }

    // monorepo 后缀放宽与现有 exact-path 语义冲突，暂不放宽：带 '/' 的目标必须精确相等。
    const targetHit = (target: string) =>
      isFileScoped
        ? scopedPaths.some(
            (file) => file === target || (!target.includes('/') && file.endsWith(`/${target}`))
          )
        : mentionsFileTarget(argsStr, target);

    const candidates = steps.map((step) => {
      const { targets, techNames } = extractFileTargets(step.description);
      this.#noteTechNameExclusion(step, techNames);
      return { step, targets, hit: targets.some(targetHit) };
    });
    // 命中文件目标的步骤优先尝试（稳定排序，保持计划原顺序）。
    const ordered = [
      ...candidates.filter((candidate) => candidate.hit),
      ...candidates.filter((candidate) => !candidate.hit),
    ];

    // 被 terminal 文件目标门槛拦下的语义命中：本次匹配结束时统一记一条诊断（含最终落到哪个步骤）。
    const gated: Array<{ step: PlanStep; targets: string[] }> = [];
    const finish = (matched: PlanStep | null) => {
      if (gated.length > 0) {
        this.#noteTerminalFileTargetGate(`${toolName}.${actionName}`, gated, matched);
      }
      return matched;
    };

    for (const { step, targets, hit } of ordered) {
      if (isFileScoped && targets.length > 0 && !hit) {
        continue;
      }

      // 策略 1: 关键词匹配
      if (step.keywords?.some((kw) => argsStr.includes(kw.toLowerCase()))) {
        return finish(step);
      }

      // 总结/汇报类步骤不参与文件目标命中与语义回退，只能由显式关键词命中。
      if (isSummaryStep(step.description)) {
        continue;
      }

      // 策略 2: 动作点名了步骤的文件目标——显式命中，不再依赖步骤措辞与工具类别是否对得上。
      if (hit) {
        return finish(step);
      }

      // 策略 3: 工具类型 → 步骤描述的语义匹配
      if (matchesStepSemantics(toolName, actionName, step.description.toLowerCase())) {
        // terminal 文件目标门槛（L6-P16r6）：terminal 不是单文件取证动作，措辞再收紧也挡不住“执行 git hooks”
        // “src/cli/commands.ts”这类命中，曾让 ls / git status 把从没读过的文件步骤标成完成，后果链是
        // “计划耗尽”保持吞掉之后的真实偏离、周期回顾把没读过的文件列为已完成。因此步骤有待检视的文件目标时
        // 语义回退一律不算命中（完成与续做同口径），只看下一个步骤；点名该文件的命令已在策略 2 命中。
        const inspectionTargets =
          toolName === 'terminal' ? inspectionFileTargets(step.description) : [];
        if (inspectionTargets.length === 0) {
          if (toolName === 'terminal' && targets.length > 0) {
            // 执行对象豁免：文件目标全部是“运行/执行”被执行的脚本，门槛不作用，语义回退照常完成或续做。
            this.#noteTerminalExecutedObjectExemption(`${toolName}.${actionName}`, step, targets);
          }
          return finish(step);
        }
        gated.push({ step, targets: inspectionTargets });
      }
    }

    return finish(null);
  }

  /** terminal 语义回退被文件目标门槛拦下是改变匹配结果的分叉路径：记 debug 诊断便于回放偏离判断。 */
  #noteTerminalFileTargetGate(
    actionLabel: string,
    gated: Array<{ step: PlanStep; targets: string[] }>,
    matched: PlanStep | null
  ) {
    // 只写工具与动作名，不写原始命令：命令参数可能带凭据或用户路径。
    const blocked = gated
      .map(({ step, targets }) => `"${step.description}" [${targets.join(', ')}] (${step.status})`)
      .join('; ');
    logPlanDiagnostic(
      `[PlanTracker] ${actionLabel} semantic fallback blocked by file-target gate on ` +
        `${gated.length} step(s): ${blocked}; only reading/outlining the file, an action naming it ` +
        `at a path boundary, or an explicit step keyword can complete or continue such a step; ` +
        (matched ? `matched step "${matched.description}" instead` : 'no step matched this action')
    );
  }

  /**
   * terminal 语义回退因“文件目标全部是被执行对象”而豁免门槛、直接完成或续做步骤，是改变匹配结果的分叉路径：
   * 与门槛拦截同口径记 debug 诊断（L6-P16r7），回放偏离判断时能看出步骤是经豁免完成的。
   */
  #noteTerminalExecutedObjectExemption(actionLabel: string, step: PlanStep, targets: string[]) {
    // 只写工具与动作名，不写原始命令：命令参数可能带凭据或用户路径。
    const outcome =
      step.status === 'done' ? 'counted as continuing the done step' : 'completing the step';
    logPlanDiagnostic(
      `[PlanTracker] ${actionLabel} semantic fallback took the executed-object exemption on ` +
        `"${step.description}" [${targets.join(', ')}] (${step.status}): every file target is the ` +
        `object of a run/exec verb, so no file is left to inspect and the terminal gate does not apply; ` +
        outcome
    );
  }

  /** 技术名被排除出文件目标会让 read/outline 的硬门槛不作用于它：每个步骤记一次 debug 诊断。 */
  #noteTechNameExclusion(step: PlanStep, techNames: string[]) {
    if (techNames.length === 0 || this.#techNameLoggedSteps.has(step)) {
      return;
    }
    this.#techNameLoggedSteps.add(step);
    logPlanDiagnostic(
      `[PlanTracker] plan step "${step.description}" excludes technology name(s) ` +
        `${techNames.join(', ')} from file targets; read/outline hard gate does not apply to them`
    );
  }
}

// ─── 模块内辅助 ────────────────────────────────────────

function isExplorationAction(tool: string, action: string): boolean {
  return EXPLORATION_ACTIONS.get(tool)?.has(action) === true;
}

/**
 * 抽取步骤描述中的明确文件目标：含 '/' 的路径，或扩展名在白名单内且不是 X.js 技术名的文件名；
 * 被当作技术名排除的 token 一并返回，供调用方记录诊断。
 */
function extractFileTargets(description: string): { targets: string[]; techNames: string[] } {
  const targets: string[] = [];
  const techNames: string[] = [];
  for (const token of description.match(FILE_TARGET_CANDIDATE_RE) || []) {
    const kind = classifyFileTargetCandidate(token);
    if (kind === 'file') {
      targets.push(token);
    } else if (kind === 'tech') {
      techNames.push(token);
    }
  }
  return { targets, techNames };
}

/**
 * 候选 token 的归类（extractFileTargets 与 terminal 文件目标门槛共用同一口径）：含 '/' 的路径，或扩展名
 * 在白名单内且不是 X.js 技术名的文件名，是文件目标；X.js 技术名单独归类供诊断；其余不是文件目标。
 */
function classifyFileTargetCandidate(token: string): 'file' | 'tech' | 'other' {
  if (token.includes('/')) {
    return 'file';
  }
  const extension = token.slice(token.lastIndexOf('.') + 1).toLowerCase();
  if (!SOURCE_FILE_EXTENSIONS.has(extension)) {
    return 'other';
  }
  return isJsTechName(token) ? 'tech' : 'file';
}

/**
 * terminal 文件目标门槛要看的“待检视文件目标”：extractFileTargets 口径的文件目标里，去掉落在
 * “运行/执行”被执行对象区段（EXECUTED_OBJECT_SPAN_RE）内的出现——那是步骤要执行的脚本，不是要阅读的文件。
 * 按出现位置判断：同一文件只要有一次出现在区段外（如“阅读 src/cli.ts 后执行 node src/cli.ts”），
 * 仍算待检视目标，宁可少完成也不让无关命令完成阅读步骤。
 */
function inspectionFileTargets(description: string): string[] {
  const spans = [...description.matchAll(EXECUTED_OBJECT_SPAN_RE)].map((match) => {
    const executed = match[1] ?? '';
    const start = (match.index ?? 0) + match[0].length - executed.length;
    return { start, end: start + executed.length };
  });
  const targets: string[] = [];
  for (const match of description.matchAll(FILE_TARGET_CANDIDATE_RE)) {
    if (classifyFileTargetCandidate(match[0]) !== 'file') {
      continue;
    }
    const index = match.index ?? 0;
    if (spans.some((span) => index >= span.start && index < span.end)) {
      continue;
    }
    targets.push(match[0]);
  }
  return targets;
}

function isJsTechName(token: string): boolean {
  return /^[A-Z]/.test(token) && JS_TECH_NAMES.has(token.toLowerCase());
}

/**
 * 非单文件动作的文件目标命中：目标须以路径边界出现在参数文本里（前面不是文件名字符，后面不再接
 * 文件名字符或扩展名），避免 src/oauth.ts 命中 auth.ts、auth.tsx 命中 auth.ts。
 */
function mentionsFileTarget(argsStr: string, target: string): boolean {
  const needle = target.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w@.-])${needle}(?![\\w@-]|\\.\\w)`).test(argsStr);
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
