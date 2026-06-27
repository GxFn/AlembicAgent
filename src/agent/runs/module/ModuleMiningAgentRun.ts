import type { AgentRunResult } from '../../service/AgentRunContracts.js';
import type { AgentService } from '../../service/AgentService.js';

export interface ModuleMiningModule {
  moduleId?: string;
  id?: string;
  moduleName?: string;
  name?: string;
  ownedFiles?: string[];
  files?: string[];
  [key: string]: unknown;
}

export interface RunModuleMiningInput {
  agentService: Pick<AgentService, 'run'>;
  modules: ModuleMiningModule[];
  projectFacts: unknown;
  budget?: Record<string, unknown>;
  scaleCap?: number;
  concurrency?: number;
}

export async function runModuleMining({
  agentService,
  modules,
  projectFacts,
  budget,
  scaleCap,
  concurrency,
}: RunModuleMiningInput): Promise<AgentRunResult> {
  const selectedModules = selectModulesForRun(modules, scaleCap);
  const result = await agentService.run({
    profile: { id: 'module-mining-session' },
    params: stripUndefined({
      modules: selectedModules,
      projectFacts,
      budget,
      scaleCap,
      concurrency,
    }),
    message: {
      role: 'internal',
      content: buildModuleMiningPrompt({ modules: selectedModules, projectFacts, budget }),
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
    execution: stripUndefined({
      budgetOverride: budget,
    }),
    presentation: { responseShape: 'system-task-result' },
  });

  if (result.status !== 'success') {
    throw new Error(
      `Module mining agent failed with status ${result.status}: ${result.reply || 'empty reply'}`
    );
  }

  return result;
}

function selectModulesForRun(modules: ModuleMiningModule[], scaleCap?: number) {
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
  return selected;
}

function buildModuleMiningPrompt({
  modules,
  projectFacts,
  budget,
}: {
  modules: ModuleMiningModule[];
  projectFacts: unknown;
  budget?: Record<string, unknown>;
}) {
  return [
    '执行 moduleMining fan-out。父 run 只负责按 ProjectContext modules 拆分 child；每个 child 使用完整 analyst budget，不按 module 数拆分。',
    'fan-out 来源必须是 params.modules / ProjectMap.modules；不要从 moduleSeeds、dimensions 或 ledger 推导模块。',
    `Module count: ${modules.length}`,
    'Budget:',
    JSON.stringify(budget ?? {}, null, 2),
    'Project facts:',
    JSON.stringify(projectFacts, null, 2),
  ].join('\n');
}

function stripUndefined<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
