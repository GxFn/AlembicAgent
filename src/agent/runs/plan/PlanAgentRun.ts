import {
  assertPlanSelectionStageRequirements,
  type PlanSelection,
  type PlanStageId,
} from '@alembic/core/plans';
import type { AgentService } from '../../service/AgentService.js';

export interface RunPlanAgentInput {
  agentService: Pick<AgentService, 'run'>;
  generationStage: PlanStageId;
  projectContextFacts: unknown;
}

export async function runPlanAgent({
  agentService,
  generationStage,
  projectContextFacts,
}: RunPlanAgentInput): Promise<PlanSelection> {
  const result = await agentService.run({
    profile: { id: 'plan-selection' },
    params: { generationStage, projectContextFacts },
    message: {
      role: 'internal',
      content: buildPlanSelectionPrompt({ generationStage, projectContextFacts }),
      metadata: { task: 'plan-selection', generationStage },
    },
    context: {
      source: 'system-workflow',
      runtimeSource: 'system',
      promptContext: { generationStage, projectContextFacts },
    },
    execution: { toolChoiceOverride: 'none' },
    presentation: { responseShape: 'system-task-result' },
  });

  if (result.status !== 'success') {
    throw new Error(
      `Plan agent failed with status ${result.status}: ${result.reply || 'empty reply'}`
    );
  }

  return parsePlanSelection(result.reply, { expectedStage: generationStage });
}

function buildPlanSelectionPrompt({
  generationStage,
  projectContextFacts,
}: {
  generationStage: PlanStageId;
  projectContextFacts: unknown;
}): string {
  const moduleCandidates = selectProjectContextModuleCandidates(projectContextFacts);
  const stageRequiresModuleTargets =
    generationStage === 'deepMining' || generationStage === 'moduleMining';
  const moduleGuidance =
    moduleCandidates.length > 0
      ? [
          'ProjectContext module candidates available for moduleBindings:',
          JSON.stringify(moduleCandidates, null, 2),
        ]
      : [
          'ProjectContext module candidates: []',
          '如果 deepMining/moduleMining 没有任何 ProjectContext module/modulePath 候选，不要编造 moduleBindings；输出会被阶段校验拒绝。',
        ];
  const stageGuidance = stageRequiresModuleTargets
    ? [
        `${generationStage} 阶段要求 moduleBindings 非空，并且必须能形成 module×dimension targets。`,
        '- moduleBinding.modulePath 必须来自上方 ProjectContext module candidates 或原始 ProjectContext facts 中的真实 modulePath/ownedFiles/ref.scope.filePath。',
        '- moduleBinding.dimensions 必须是本次 dimensions 中已选择的维度子集，且非空。',
        '- moduleBinding.targetRecipes 必须是正数；priority 也必须是正数。',
        '- 不要从 moduleSeeds、dimensions 名称、ledger 或想象路径推导不存在的模块。',
      ]
    : [
        'coldStart 阶段保持兼容：moduleBindings 可以为空；若 ProjectContext facts 已有真实模块候选，也可以给出真实 bindings。',
      ];

  return [
    `为 generationStage=${generationStage} 选择本轮 PlanSelection。`,
    '只能输出纯 JSON object，字段必须匹配 @alembic/core/plans 的 PlanSelection。',
    '不要调用工具，不要写入状态，不要回退到全量作为失败掩盖。',
    ...stageGuidance,
    ...moduleGuidance,
    'ProjectContext facts:',
    JSON.stringify(projectContextFacts, null, 2),
  ].join('\n');
}

export interface ParsePlanSelectionOptions {
  expectedStage?: PlanStageId;
}

export function parsePlanSelection(
  reply: string | null | undefined,
  options: ParsePlanSelectionOptions = {}
): PlanSelection {
  if (!reply || reply.trim().length === 0) {
    throw new Error('Plan agent returned an empty reply');
  }
  const selection = parseJsonObjectFromReply(reply);
  assertPlanSelectionStageRequirements(
    selection,
    options.expectedStage ? { expectedStage: options.expectedStage } : {}
  );
  return selection;
}

function parseJsonObjectFromReply(reply: string): unknown {
  const trimmed = reply.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (codeBlockMatch) {
    return parseJson(codeBlockMatch[1].trim());
  }
  try {
    return parseJson(trimmed);
  } catch (err: unknown) {
    const objectMatch = trimmed.match(/(\{[\s\S]*\})/u);
    if (objectMatch) {
      return parseJson(objectMatch[1]);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err: unknown) {
    throw new Error(
      `Plan agent returned invalid JSON: ${err instanceof Error ? err.message : err}`
    );
  }
}

interface ProjectContextModuleCandidate {
  moduleId?: string;
  moduleName?: string;
  modulePath: string;
  ownedFiles?: string[];
  source: string;
}

function selectProjectContextModuleCandidates(
  projectContextFacts: unknown
): ProjectContextModuleCandidate[] {
  const facts = readRecord(projectContextFacts);
  const presenterInput = readRecord(facts.presenterInput);
  const presenterMap = readRecord(presenterInput.map);
  const candidates = [
    // U3：主体 in-process plan gate 现喂 Core 精简投影（buildPlanFactsProjection），模块候选从
    // projectInfoTree.children 读（每个 module node 带 path + children 文件）；下方旧读取器保留，
    // 兼容 host-agent 全量 facts（presenterInput / moduleSeeds / projectMapModules）形态。
    ...readProjectInfoTreeModuleCandidates(
      readArray(readRecord(facts.projectInfoTree).children),
      'projectInfoTree'
    ),
    ...readFlatModuleCandidates(readArray(facts.projectMapModules), 'projectMapModules'),
    ...readFlatModuleCandidates(readArray(facts.moduleSeeds), 'moduleSeeds'),
    ...readPresenterModuleCandidates(readArray(presenterInput.modules), 'presenterInput.modules'),
    ...readFlatModuleCandidates(readArray(presenterMap.modules), 'presenterInput.map.modules'),
  ];

  const seen = new Set<string>();
  const unique: ProjectContextModuleCandidate[] = [];
  for (const candidate of candidates) {
    const key = [candidate.modulePath, candidate.moduleId ?? '', candidate.moduleName ?? ''].join(
      '\u0000'
    );
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique.slice(0, 20);
}

function readFlatModuleCandidates(
  values: readonly unknown[],
  source: string
): ProjectContextModuleCandidate[] {
  return values.flatMap((value) => {
    const record = readRecord(value);
    const moduleId = readString(record.moduleId) ?? readString(record.id);
    const moduleName = readString(record.moduleName) ?? readString(record.name);
    const ownedFiles = readStringArray(record.ownedFiles);
    const modulePath =
      readString(record.modulePath) ??
      readRefFilePath(record.ref) ??
      readString(record.path) ??
      ownedFiles?.[0];
    if (!modulePath) {
      return [];
    }
    return [stripUndefined({ moduleId, moduleName, modulePath, ownedFiles, source })];
  });
}

// U3：从 Core 精简投影的 projectInfoTree.children 读模块候选。每个 ProjectInfoModuleNode 带 path
// 与 children(文件节点)，映射成 { modulePath, ownedFiles }；无 moduleId/moduleName（精简树不带）。
function readProjectInfoTreeModuleCandidates(
  values: readonly unknown[],
  source: string
): ProjectContextModuleCandidate[] {
  return values.flatMap((value) => {
    const record = readRecord(value);
    const modulePath = readString(record.path);
    if (!modulePath) {
      return [];
    }
    const ownedFiles = readArray(record.children).flatMap((child) => {
      const filePath = readString(readRecord(child).path);
      return filePath ? [filePath] : [];
    });
    return [
      stripUndefined({
        modulePath,
        ownedFiles: ownedFiles.length > 0 ? ownedFiles : undefined,
        source,
      }),
    ];
  });
}

function readPresenterModuleCandidates(
  values: readonly unknown[],
  source: string
): ProjectContextModuleCandidate[] {
  return values.flatMap((value) => {
    const record = readRecord(value);
    const moduleRecord = readRecord(record.module);
    const ownedFiles = readStringArray(record.ownedFiles);
    const moduleId = readString(moduleRecord.id) ?? readString(record.moduleId);
    const moduleName = readString(moduleRecord.name) ?? readString(record.moduleName);
    const modulePath =
      readString(record.modulePath) ??
      readRefFilePath(moduleRecord.ref) ??
      readRefFilePath(record.ref) ??
      ownedFiles?.[0];
    if (!modulePath) {
      return [];
    }
    return [stripUndefined({ moduleId, moduleName, modulePath, ownedFiles, source })];
  });
}

function readRefFilePath(value: unknown): string | undefined {
  const ref = readRecord(value);
  const scope = readRecord(ref.scope);
  return readString(scope.filePath);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map((item) => readString(item))
    .filter((item): item is string => item !== undefined);
  return strings.length > 0 ? strings : undefined;
}

function stripUndefined(value: ProjectContextModuleCandidate): ProjectContextModuleCandidate {
  const output: ProjectContextModuleCandidate = {
    modulePath: value.modulePath,
    source: value.source,
  };
  if (value.moduleId) {
    output.moduleId = value.moduleId;
  }
  if (value.moduleName) {
    output.moduleName = value.moduleName;
  }
  if (value.ownedFiles) {
    output.ownedFiles = value.ownedFiles;
  }
  return output;
}
