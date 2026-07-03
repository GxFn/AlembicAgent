import type { AgentRunResult } from '../../service/AgentRunContracts.js';
import type { AgentService } from '../../service/AgentService.js';

export interface ScopedMiningModule {
  moduleId?: string;
  id?: string;
  moduleName?: string;
  name?: string;
  ownedFiles?: string[];
  files?: string[];
  [key: string]: unknown;
}

export interface RunScopedModuleMiningInput {
  agentService: Pick<AgentService, 'run'>;
  modules: ScopedMiningModule[];
  projectFacts: unknown;
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
}: RunScopedModuleMiningInput): Promise<AgentRunResult> {
  const selectedModules = selectScopedIndexModulesForRun(modules, scaleCap);
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
      content: buildProjectIndexScopedModulePrompt({
        modules: selectedModules,
        projectFacts,
        budget,
      }),
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
      `ProjectIndex scoped module mining agent failed with status ${result.status}: ${
        result.reply || 'empty reply'
      }`
    );
  }

  return result;
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
  return selected.map((moduleInput, index) => normalizeScopedIndexModule(moduleInput, index));
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

function buildProjectIndexScopedModulePrompt({
  modules,
  projectFacts,
  budget,
}: {
  modules: ScopedMiningModule[];
  projectFacts: unknown;
  budget?: Record<string, unknown>;
}) {
  return [
    '执行 moduleMining fan-out。父 run 只负责按 ProjectIndex scoped modules 拆分 child；每个 child 使用完整 analyst budget，不按 module 数拆分。',
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
