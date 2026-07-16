import { createHash } from 'node:crypto';
import {
  assertPlanSelectionStageRequirements,
  hashStrictPlanIntentV1,
  type PlanCognitionInvocationV1,
  type PlanCognitionReceiptV1,
  type PlanSelection,
  type PlanStageId,
  type StrictPlanIntentV1,
} from '@alembic/core/plans';
import type { AgentService } from '../../service/AgentService.js';

export interface PlanContextProjectionV1 {
  readonly schemaVersion: 1;
  readonly generationStage: PlanStageId;
  readonly factsHash: string;
  readonly catalogHash: string;
  readonly sourceRevisionVectorHash: string;
  readonly sourceArtifactHash: string;
  readonly modelHash: string;
  readonly promptHash: string;
  readonly projectContextFacts: unknown;
  readonly frozenCapabilityIds: readonly string[];
  readonly frozenQueryFamilyIds: readonly string[];
  readonly hardCaps: {
    readonly semanticRepairLimit: number;
  };
}

export interface RunStrictPlanAgentInput {
  readonly agentService: Pick<AgentService, 'run'>;
  readonly contextProjection: PlanContextProjectionV1;
  readonly validateReceipt: (receipt: PlanCognitionReceiptV1) => void | Promise<void>;
}

/**
 * 复用既有 Plan profile，但严格路径传完整 ProjectContext、禁用工具，并把语义修复记录成
 * 单一因果链。验证失败最多回送两次；第三次必须显式拒绝，不能静默缩小范围。
 */
export async function runStrictPlanAgent({
  agentService,
  contextProjection,
  validateReceipt,
}: RunStrictPlanAgentInput): Promise<PlanCognitionReceiptV1> {
  validateStrictPlanContext(contextProjection);
  const semanticRepairLimit = Math.min(contextProjection.hardCaps.semanticRepairLimit, 2);
  let initial: PlanCognitionInvocationV1 | null = null;
  const repairs: PlanCognitionInvocationV1[] = [];
  let repairReason: string | null = null;

  for (let attempt = 0; attempt <= semanticRepairLimit; attempt += 1) {
    const prompt = buildStrictPlanPrompt(contextProjection, {
      repairReason,
      parentInvocationId: repairs.at(-1)?.invocationId ?? initial?.invocationId ?? null,
    });
    const result = await agentService.run({
      profile: { id: 'plan-selection' },
      params: { generationStage: contextProjection.generationStage },
      message: {
        role: 'internal',
        content: prompt,
        metadata: {
          task: 'strict-plan-cognition',
          generationStage: contextProjection.generationStage,
          semanticRepairAttempt: attempt,
        },
      },
      context: {
        source: 'system-workflow',
        runtimeSource: 'system',
        promptContext: { strictPlanContext: contextProjection },
      },
      execution: { toolChoiceOverride: 'none' },
      presentation: { responseShape: 'system-task-result' },
    });
    if (result.status !== 'success') {
      throw new Error(`STRICT_PLAN_RUN_FAILED: ${result.status}: ${result.reply || 'empty reply'}`);
    }
    if (result.toolCalls.length > 0) {
      throw new Error('PLAN_TOOL_FORBIDDEN');
    }
    const intent = parseStrictPlanIntent(result.reply, contextProjection);
    const outputHash = hashStrictPlanIntentV1(intent);
    const invocationBase = {
      invocationId: `plan-cognition-${attempt}-${hashText(`${result.runId}:${hashText(prompt)}:${outputHash}`).slice(0, 16)}`,
      inputHash: hashText(prompt),
      outputHash,
      modelHash: contextProjection.modelHash,
      promptHash: contextProjection.promptHash,
    };
    if (attempt === 0) {
      initial = invocationBase;
    } else {
      const parentInvocationId = repairs.at(-1)?.invocationId ?? initial?.invocationId;
      if (!parentInvocationId || !repairReason) {
        throw new Error('PLAN_LINEAGE_BROKEN: repair without causal parent');
      }
      repairs.push({ ...invocationBase, parentInvocationId, reason: repairReason });
    }
    if (!initial) {
      throw new Error('PLAN_LINEAGE_BROKEN: initial invocation missing');
    }
    const semantic = {
      schemaVersion: 1 as const,
      factsHash: contextProjection.factsHash,
      catalogHash: contextProjection.catalogHash,
      intent,
      lineage: {
        schemaVersion: 1 as const,
        initial,
        repairs: [...repairs],
        transportRetryCount: 0,
      },
      validatorVerdict: 'accepted' as const,
    };
    const receipt: PlanCognitionReceiptV1 = {
      ...semantic,
      receiptId: `plan-cognition-receipt-${hashCanonical(semantic)}`,
    };
    try {
      await validateReceipt(receipt);
      return receipt;
    } catch (error: unknown) {
      repairReason = error instanceof Error ? error.message : String(error);
      if (!/^PLAN_[A-Z0-9_]+/u.test(repairReason)) {
        throw error;
      }
      if (attempt >= semanticRepairLimit) {
        throw new Error(`PLAN_SEMANTIC_REPAIR_LIMIT: ${repairReason}`);
      }
    }
  }
  throw new Error('PLAN_SEMANTIC_REPAIR_LIMIT');
}

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

function buildStrictPlanPrompt(
  context: PlanContextProjectionV1,
  repair: { readonly repairReason: string | null; readonly parentInvocationId: string | null }
): string {
  return [
    `为 generationStage=${context.generationStage} 生成 StrictPlanIntentV1。`,
    '只输出纯 JSON object；不要调用任何工具，不要写状态。',
    '对下面完整、冻结的 ProjectContext 做问题 DAG 分解；严禁 top-N/top-20/固定数量、补数、地板或延后范围。',
    '每个问题与 plannedNextAction 必须携带 anatomyLensIds、subjectRefs、analysisScales、冻结 capabilityId/queryFamilyId、support/counterevidence、priority、stop/escalation 和 cap 内预算。',
    '选择必须可执行；后续 Analyst 只能执行本 Plan 或经登记 expansion port 接纳的查询。',
    `Frozen capability IDs: ${JSON.stringify(context.frozenCapabilityIds)}`,
    `Frozen query family IDs: ${JSON.stringify(context.frozenQueryFamilyIds)}`,
    `Source artifact hash: ${context.sourceArtifactHash}`,
    `Source revision vector hash: ${context.sourceRevisionVectorHash}`,
    ...(repair.repairReason
      ? [
          `这是父调用 ${repair.parentInvocationId ?? '<missing>'} 的因果语义修复。`,
          `验证器拒绝原因：${repair.repairReason}`,
          '保持原始完整范围和冻结 ID，只修复验证器指出的语义缺口。',
        ]
      : []),
    '完整 ProjectContext facts（不得截断）：',
    JSON.stringify(context.projectContextFacts, null, 2),
  ].join('\n');
}

function parseStrictPlanIntent(
  reply: string | null | undefined,
  context: PlanContextProjectionV1
): StrictPlanIntentV1 {
  if (!reply || reply.trim().length === 0) {
    throw new Error('STRICT_PLAN_EMPTY_REPLY');
  }
  const intent = parseJsonObjectFromReply(reply) as StrictPlanIntentV1;
  const record = readRecord(intent);
  if (
    record.generationStage !== context.generationStage ||
    !Array.isArray(record.plannedNextActions) ||
    !Array.isArray(record.dimensions) ||
    !Array.isArray(record.moduleBindings) ||
    !Array.isArray(record.evidenceRefs) ||
    !readRecord(record.investigationDecomposition).questions ||
    !readRecord(record.budgetStrategy).schemaVersion
  ) {
    throw new Error('STRICT_PLAN_INTENT_SHAPE_INVALID');
  }
  const frozenCapabilities = new Set(context.frozenCapabilityIds);
  const frozenFamilies = new Set(context.frozenQueryFamilyIds);
  for (const raw of record.plannedNextActions) {
    const action = readRecord(raw);
    if (
      !frozenCapabilities.has(String(action.capabilityId ?? '')) ||
      !frozenFamilies.has(String(action.queryFamilyId ?? ''))
    ) {
      throw new Error('PLAN_UNKNOWN_FROZEN_QUERY');
    }
  }
  return intent;
}

function validateStrictPlanContext(context: PlanContextProjectionV1): void {
  if (
    context.schemaVersion !== 1 ||
    !context.factsHash.trim() ||
    !context.catalogHash.trim() ||
    !context.sourceArtifactHash.trim() ||
    !context.sourceRevisionVectorHash.trim() ||
    !context.modelHash.trim() ||
    !context.promptHash.trim() ||
    context.frozenCapabilityIds.length === 0 ||
    context.frozenQueryFamilyIds.length === 0 ||
    !Number.isSafeInteger(context.hardCaps.semanticRepairLimit) ||
    context.hardCaps.semanticRepairLimit < 0
  ) {
    throw new Error('STRICT_PLAN_CONTEXT_INVALID');
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value: unknown): string {
  return hashText(JSON.stringify(sortCanonical(value)));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortCanonical(child)])
  );
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
