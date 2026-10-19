import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { computeModuleAnalystBudget } from '../../prompts/insightAnalyst.js';
import type { AgentRunResult } from '../../service/AgentRunContracts.js';
import type { AgentService } from '../../service/AgentService.js';
import { runFailure } from '../result.js';
import { buildSystemTaskRunInput, type SystemTaskRunSignals } from '../systemTaskRunInput.js';
import {
  buildModuleContextMap,
  type ModuleLikeRecord,
  splitOversizedModule,
} from './ModuleContextAssembler.js';

export interface ScopedMiningModule {
  moduleId?: string;
  id?: string;
  moduleName?: string;
  name?: string;
  ownedFiles?: string[];
  files?: string[];
  [key: string]: unknown;
}

/**
 * abortSignal / shouldAbort / timeoutMs 为宿主可选的取消与期限信号（L8-C01）：原样并入父 run 的
 * execution，coordinator 在每个模块 child 派发前检查、并把同一 execution 交给 child runtime。
 * 未传信号时父 execution 为空对象（宿主 budget 不进入 execution，见 `budget` 字段说明）。
 */
export interface RunScopedModuleMiningInput extends SystemTaskRunSignals {
  agentService: Pick<AgentService, 'run'>;
  modules: ScopedMiningModule[];
  projectFacts: unknown;
  /**
   * 宿主给的挖掘预算提示（如 Plan 的 totalRecipeBudget、rescan 的 contentMaxLines/maxFiles）。
   *
   * 只作为提示字段：原样写入 params.budget 与 context.promptContext.budget，后者经 partitioner 随
   * promptContext 进入每个 child 的运行上下文（context.budget）；目前没有阶段 prompt 构建器读取它。
   * 它**不约束** child 的运行规模（L8-C04，方案 a）。原因：child profile
   * module-mining-dimension 是 pipeline 策略，各阶段实际预算来自阶段自带 budget 与按模块规模算出的
   * strategyContext._computedBudget，runtime 的 budgetOverride 会被阶段预算整体覆盖；旧版把它放进
   * execution.budgetOverride 只是看起来生效。若将来 child 改成 single 策略，它还会整体替换 runtime
   * budget、丢失 maxIterations 等字段，所以不再进入 execution。
   * 传入时每次 run 记一条 `[ModuleMining] host budget not enforced` warn 诊断，列出未执行的字段名。
   * 需要真正约束 child 时须另行立项，把可识别字段映射进各模块的 _computedBudget。
   */
  budget?: Record<string, unknown>;
  scaleCap?: number;
  concurrency?: number;
}

export async function runScopedModuleMining({
  agentService,
  modules,
  projectFacts,
  budget,
  scaleCap,
  concurrency,
  abortSignal,
  shouldAbort,
  timeoutMs,
}: RunScopedModuleMiningInput): Promise<AgentRunResult> {
  const selectedModules = selectScopedIndexModulesForRun(modules, scaleCap);
  reportHostBudgetNotEnforced(budget, selectedModules.length);
  const result = await agentService.run(
    buildSystemTaskRunInput({
      profileId: 'module-mining-session',
      params: stripUndefined({
        modules: selectedModules,
        projectFacts,
        budget,
        scaleCap,
        concurrency,
      }),
      message: {
        role: 'internal',
        content: buildProjectIndexScopedModulePrompt(selectedModules.length),
        metadata: {
          task: 'module-mining',
          generationStage: 'moduleMining',
          moduleCount: selectedModules.length,
        },
      },
      context: {
        source: 'system-workflow',
        runtimeSource: 'system',
        promptContext: stripUndefined({
          generationStage: 'moduleMining',
          projectFacts,
          budget,
          moduleCount: selectedModules.length,
        }),
      },
      // 模块挖掘没有 helper 自有的执行选项：宿主 budget 只走上面的 params / promptContext 提示通道
      // （L8-C04）。保留空 execution 让入参键形状稳定，宿主信号由 buildSystemTaskRunInput 并入。
      execution: {},
      signals: { abortSignal, shouldAbort, timeoutMs },
    })
  );

  if (result.status !== 'success') {
    throw runFailure(
      result,
      `ProjectIndex scoped module mining agent failed with status ${result.status}: ${
        result.reply || 'empty reply'
      }`
    );
  }

  return result;
}

/**
 * 宿主 budget 未执行诊断（L8-C04）：宿主传了 budget 就说明它可能期望限制挖掘规模，但这些字段只作
 * 提示，不约束 child。每次 run 记一条（不按 child 重复），只写字段名与模块数，不写字段值，
 * 保持日志有界；字段名足以让宿主维护者核对哪些期望没有生效。未传 budget 时没有可忽略的字段，不记。
 * 放在模块校验之后：入参被拒的 run 不会派发任何 child，也就谈不上忽略预算。
 */
function reportHostBudgetNotEnforced(
  budget: Record<string, unknown> | undefined,
  moduleCount: number
) {
  if (budget === undefined) {
    return;
  }
  // 运行时防御：类型之外的非对象值同样只作提示，字段名列表为空，但仍记录其类型以便排查。
  const isRecord = budget !== null && typeof budget === 'object';
  const ignoredFields = isRecord ? Object.keys(budget) : [];
  observeSafely(
    () =>
      Logger.getInstance().warn(
        '[ModuleMining] host budget not enforced: passed to children as prompt hint only; child budgets come from pipeline stage budgets and per-module strategyContext._computedBudget',
        {
          ignoredFields,
          valueType: isRecord ? 'object' : budget === null ? 'null' : typeof budget,
          moduleCount,
          hintChannels: ['params.budget', 'promptContext.budget'],
        }
      ),
    () => undefined
  );
}

function selectScopedIndexModulesForRun(modules: ScopedMiningModule[], scaleCap?: number) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error('runModuleMining requires at least one ProjectContext module');
  }
  const cap =
    typeof scaleCap === 'number' && Number.isFinite(scaleCap)
      ? Math.max(0, Math.floor(scaleCap))
      : modules.length;
  const selected = modules.slice(0, cap);
  if (selected.length === 0) {
    throw new Error('runModuleMining scaleCap selected zero ProjectContext modules');
  }
  const normalized = selected.map((moduleInput, index) =>
    normalizeScopedIndexModule(moduleInput, index)
  );
  // P1-B-2：超大模块按顶层子目录拆分成真实 module 条目——在 run 入口拆(scaleCap 之后)，
  // partitioner/merger 的按下标 1:1 契约零改动。
  // 为真实模块预留身份；派生分组也可能撞上路径中含 # 的合法 Core moduleId。
  const allocatedIds = new Set(normalized.map((module) => String(module.moduleId)));
  const expanded = normalized.flatMap((moduleRecord) => {
    const parts = splitOversizedModule(moduleRecord as ModuleLikeRecord);
    if (parts.length === 1) {
      return parts;
    }
    return parts.map((part) => {
      const proposedId = String(part.moduleId);
      let moduleId = proposedId;
      let suffix = 2;
      while (allocatedIds.has(moduleId)) {
        moduleId = `${proposedId}#part-${suffix++}`;
      }
      allocatedIds.add(moduleId);
      if (moduleId === proposedId) {
        return part;
      }
      observeSafely(
        () =>
          Logger.getInstance().info('[ModuleMining] disambiguated split module identity', {
            sourceModuleId: moduleRecord.moduleId,
            proposedId,
            moduleId,
          }),
        () => undefined
      );
      return { ...part, moduleId, id: moduleId };
    });
  });
  // P1-B-1/2：为每个(拆分后)模块确定性附着——
  //   contextMap：静态模块图谱(coordinator 拼进 dimConfig.guide,Analyst 首轮即见骨架，
  //   不再求 LLM 自觉调 graph 才能定位)；
  //   strategyContext._computedBudget：按模块规模的 Analyst 预算(partitioner 展开
  //   moduleRecord.strategyContext → 工厂既有动态预算合并逻辑直接生效)。
  return expanded.map((moduleRecord) => {
    const record = moduleRecord as ModuleLikeRecord & { strategyContext?: Record<string, unknown> };
    const ownedCount = Array.isArray(record.ownedFiles) ? record.ownedFiles.length : 0;
    const existingStrategyContext =
      record.strategyContext && typeof record.strategyContext === 'object'
        ? record.strategyContext
        : {};
    return {
      ...record,
      contextMap: buildModuleContextMap(record, expanded as ModuleLikeRecord[]),
      strategyContext: {
        ...existingStrategyContext,
        // 宿主显式给过 _computedBudget 则尊重(不覆盖)。
        ...(existingStrategyContext._computedBudget
          ? {}
          : { _computedBudget: computeModuleAnalystBudget(ownedCount) }),
      },
    };
  });
}

function normalizeScopedIndexModule(moduleInput: ScopedMiningModule, index: number) {
  const moduleName =
    readString(moduleInput.moduleName) ||
    readString(moduleInput.name) ||
    readString(moduleInput.modulePath) ||
    readString(moduleInput.id) ||
    readString(moduleInput.moduleId) ||
    `module-${index}`;
  const moduleId =
    readString(moduleInput.moduleId) ||
    readString(moduleInput.id) ||
    readString(moduleInput.modulePath) ||
    moduleName;
  const ownedFiles = readStringArray(moduleInput.ownedFiles) || readStringArray(moduleInput.files);

  return stripUndefined({
    ...moduleInput,
    moduleId,
    id: readString(moduleInput.id) || moduleId,
    moduleName,
    name: moduleName,
    ownedFiles,
    files: readStringArray(moduleInput.files) || ownedFiles,
  });
}

/**
 * 父 run 的 message.content（L8-C18）。module-mining-session 配置了 concurrency，AgentService 总是
 * 把父 run 交给 AgentRunCoordinator 按 params.modules 拆成 per-module child，父 run 自身不进入
 * 模型循环；child 的 content 由 partitioner 另行构造（`Module mining: <moduleName>`），不继承这里
 * 的文本。所以这里只保留简短的任务描述（阶段名 + 模块数）：满足 validateRunInput 的非空要求，
 * 并让日志/trace 读得懂这是哪一类 run。
 * projectFacts 与 budget 不再序列化进 content（旧版对完整 facts 做缩进 JSON，大项目可达数 MB 且
 * 无人消费）；它们照旧经 params / promptContext 传给 partitioner（projectInfo、
 * strategyContext.projectFacts）与 child runtime。budget 只是提示，不进入 execution（L8-C04）。
 */
function buildProjectIndexScopedModulePrompt(moduleCount: number) {
  return [
    '执行 moduleMining fan-out：父 run 只按 params.modules（ProjectIndex scoped modules）拆分 child，自身不调用模型。',
    'fan-out 来源必须是 params.modules / ProjectMap.modules；不要从 moduleSeeds、dimensions 或 ledger 推导模块。',
    'generationStage: moduleMining',
    `Module count: ${moduleCount}`,
  ].join('\n');
}

function stripUndefined<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
}

// W6-b:runs/module shim 与 module.profile shim 已删;runModuleMining 是主体 wire 符号
// (ModuleMiningWorkflow 动态 import+vi.mock 钉名)保留;两 type 别名零消费已清。
export const runModuleMining = runScopedModuleMining;
