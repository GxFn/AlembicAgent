import {
  buildGenerateTerminalPolicyHints,
  getGenerateStageTerminalTools,
  resolveGenerateTerminalToolset,
} from '@alembic/core/host-agent-workflows';
import { EVOLUTION_GATE_STAGE } from '../evaluation/gateEvaluators.js';
// W6-d(A1):两个 stage builder 已从 prompts/scanPrompts 迁往 evaluation/stageBuilders
import {
  buildRelationsPipelineStages,
  buildScanPipelineStages,
} from '../evaluation/stageBuilders.js';
import { buildStrictProductionPipelineStagesV1 } from '../production/StrictProductionStages.js';
import { cloneRuntimeConfig, PRESETS } from '../profiles/presets/index.js';
import { SCAN_TASK_CONFIGS } from '../prompts/scanPrompts.js';

export type AgentStageFactoryInput = {
  params: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type AgentStageFactory = (input: AgentStageFactoryInput) => Record<string, unknown>[];

/**
 * 按阶段名取 preset 阶段。preset 数组的下标顺序不是契约：在 preset 里调整顺序或插入阶段
 * 不会让工厂把门当成执行阶段；缺少必需阶段时在装配期立即失败，而不是带着错位的管线运行。
 */
function requirePresetStage<T extends { name: string }>(
  stages: readonly T[],
  presetName: string,
  stageName: string
): T {
  const stage = stages.find((candidate) => candidate.name === stageName);
  if (!stage) {
    throw new Error(`Preset "${presetName}" has no stage named "${stageName}"`);
  }
  return stage;
}

export class AgentStageFactoryRegistry {
  #factories = new Map<string, AgentStageFactory>();

  constructor() {
    this.registerDefaults();
  }

  register(name: string, factory: AgentStageFactory) {
    if (!name) {
      throw new Error('Agent stage factory name is required');
    }
    this.#factories.set(name, factory);
    return this;
  }

  resolve(name: string) {
    const factory = this.#factories.get(name);
    if (!factory) {
      throw new Error(`Unknown agent stage factory: "${name}"`);
    }
    return factory;
  }

  build(name: string, input: AgentStageFactoryInput) {
    return cloneRuntimeConfig(this.resolve(name)(input));
  }

  list() {
    return [...this.#factories.keys()];
  }

  private registerDefaults() {
    this.register('scanPipeline', ({ params }) => {
      const task = params.task === 'summarize' ? 'summarize' : 'extract';
      const taskConfig = SCAN_TASK_CONFIGS[task];
      const files = Array.isArray(params.files)
        ? (params.files as Array<{ name?: string; relativePath?: string; content?: string }>)
        : undefined;
      return buildScanPipelineStages({
        task,
        producePrompt: taskConfig.producePrompt,
        analyzeCaps: ['code_analysis'],
        produceCaps: ['scan_production'],
        files,
        analyzeMaxIter: task === 'summarize' ? 12 : 24,
      }) as Record<string, unknown>[];
    });

    this.register('relationsPipeline', () => buildRelationsPipelineStages());
    this.register('generateDimensionPipeline', ({ params, context }) => {
      const strategyContext = context?.strategyContext as Record<string, unknown> | undefined;
      const strictProduction = strategyContext?.strictProduction;
      if (
        strictProduction &&
        typeof strictProduction === 'object' &&
        !Array.isArray(strictProduction) &&
        (strictProduction as Record<string, unknown>).enabled === true
      ) {
        return buildStrictProductionPipelineStagesV1() as Record<string, unknown>[];
      }
      const insightStages = PRESETS.insight.strategy.stages;
      const presetAnalyze = requirePresetStage(insightStages, 'insight', 'analyze');
      const needsCandidates = params.needsCandidates !== false;
      const hasExistingRecipes = params.hasExistingRecipes === true;
      const prescreenDone = params.prescreenDone === true;
      const terminalCapability = resolveGenerateTerminalToolset();
      const terminalPolicyHints = buildGenerateTerminalPolicyHints(terminalCapability);
      const memoryCoordinator = context?.memoryCoordinator as
        | { allocateBudget?: (role: string) => void }
        | undefined;
      const rescanContext = strategyContext?.rescanContext as
        | { gap?: number; createBudget?: number }
        | null
        | undefined;
      const rescanGap =
        typeof rescanContext?.gap === 'number' && Number.isFinite(rescanContext.gap)
          ? Math.max(0, Math.floor(rescanContext.gap))
          : null;
      const rescanCreateBudget =
        typeof rescanContext?.createBudget === 'number' &&
        Number.isFinite(rescanContext.createBudget)
          ? Math.max(0, Math.floor(rescanContext.createBudget))
          : rescanGap;

      const withTerminalPromptContext = (ctx: Record<string, unknown>) => ({
        ...ctx,
        toolPolicyHints: terminalPolicyHints,
      });

      // 动态 Analyst 预算接线：宿主用 computeAnalystBudget(fileCount, contextWindowBudget)
      // 算出的规模化预算放在 strategyContext._computedBudget。此前 PipelineStrategy 的
      // 回退顺序是 stage.budget || computedBudget——insight preset 的 analyze stage 自带
      // 静态兜底 budget(24 轮/480s/345.6k input)，动态值被永久遮蔽；大项目(如 2000+ 文件、
      // plan 给高候选预算)在 analyze 阶段撞 stage_timeout 且 retry 被输入预算压制。
      // 这里按 preset 注释声明的原始意图，把动态字段显式合并覆盖静态兜底(仅 analyze 阶段；
      // produce/gate 各有自己的预算语义，不受影响)。
      const computedBudget = (context?.strategyContext as Record<string, unknown> | undefined)
        ?._computedBudget as Record<string, unknown> | null | undefined;
      const dynamicAnalyzeBudget: Record<string, unknown> = {};
      for (const key of [
        'maxIterations',
        'timeoutMs',
        'maxSessionTokens',
        'maxSessionInputTokens',
      ]) {
        const value = computedBudget?.[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          dynamicAnalyzeBudget[key] = value;
        }
      }

      const analyzeStage = {
        ...presetAnalyze,
        ...(Object.keys(dynamicAnalyzeBudget).length > 0
          ? {
              budget: {
                ...((presetAnalyze.budget as Record<string, unknown> | undefined) || {}),
                ...dynamicAnalyzeBudget,
              },
            }
          : {}),
        additionalTools: getGenerateStageTerminalTools('analyze', terminalCapability),
        promptBuilder: (ctx: Record<string, unknown>) =>
          presetAnalyze.promptBuilder?.(withTerminalPromptContext(ctx)),
      };
      if (!needsCandidates) {
        return [analyzeStage] as Record<string, unknown>[];
      }

      const presetQualityGate = requirePresetStage(insightStages, 'insight', 'quality_gate');
      const presetProduce = requirePresetStage(insightStages, 'insight', 'produce');
      const presetRejectionGate = requirePresetStage(insightStages, 'insight', 'rejection_gate');
      const produceStage = {
        ...presetProduce,
        ...(rescanCreateBudget != null && rescanCreateBudget > 0
          ? {
              budget: {
                ...((presetProduce.budget as Record<string, unknown> | undefined) || {}),
                maxSubmits: rescanCreateBudget,
                softSubmitLimit: rescanCreateBudget,
              },
            }
          : {}),
        promptBuilder: (ctx: Record<string, unknown>) => {
          memoryCoordinator?.allocateBudget?.('producer');
          return presetProduce.promptBuilder?.(withTerminalPromptContext(ctx));
        },
      };

      if (hasExistingRecipes && !prescreenDone) {
        const evolutionStages = PRESETS.evolution.strategy.stages;
        const presetEvolve = requirePresetStage(evolutionStages, 'evolution', 'evolve');
        const presetEvolutionGate = requirePresetStage(
          evolutionStages,
          'evolution',
          EVOLUTION_GATE_STAGE
        );
        return [
          {
            ...presetEvolve,
            additionalTools: getGenerateStageTerminalTools(presetEvolve.name, terminalCapability),
            promptBuilder: (ctx: Record<string, unknown>) =>
              presetEvolve.promptBuilder?.(withTerminalPromptContext(ctx)),
          },
          presetEvolutionGate,
          analyzeStage,
          presetQualityGate,
          produceStage,
          presetRejectionGate,
        ] as Record<string, unknown>[];
      }

      return [analyzeStage, presetQualityGate, produceStage, presetRejectionGate] as Record<
        string,
        unknown
      >[];
    });
  }
}

export default AgentStageFactoryRegistry;
