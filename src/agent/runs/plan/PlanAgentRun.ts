import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import {
  assertPlanSelectionStageRequirements,
  hashStrictPlanIntentV1,
  type PlanCognitionInvocationV1,
  type PlanCognitionReceiptV1,
  type PlanSelection,
  type PlanStageId,
  type StrictPlanIntentV1,
} from '@alembic/core/plans';
import { canonicalJsonStringify } from '@alembic/core/project-context-foundation';
import { observeSafely } from '../../../shared/observers.js';
import { hashCanonical } from '../../production/strict/primitives.js';
import type { AgentRunResult } from '../../service/AgentRunContracts.js';
import type { AgentService } from '../../service/AgentService.js';
import { runFailure } from '../result.js';
import { buildSystemTaskRunInput, type SystemTaskRunSignals } from '../systemTaskRunInput.js';

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

/**
 * 严格 Plan 因果语义修复的硬上限，与 Core coldStartProductionPlan 的字面量 2 对齐（L8-C19）。
 * 宿主传入更大的值时显式拒绝，不再静默截断成 2，避免宿主误以为多给的修复预算生效了。
 */
const STRICT_PLAN_SEMANTIC_REPAIR_CAP = 2;

/**
 * 可由模型改写修复的 PLAN_* 校验码白名单（L8-C06）。
 *
 * 来源：AlembicCore src/service/plan/intent/coldStartProductionPlan.ts 中只取决于模型输出 intent 的
 * cognition 校验码（validateCognition / validateActions / assertAcyclic / buildCellUniverse /
 * buildMiningSchedule / buildExecution），外加本文件本地的 PLAN_UNKNOWN_FROZEN_QUERY。
 * 不在白名单内的 PLAN_* 由宿主事实、配置、策略或 Agent 构造的 receipt/lineage 决定
 * （PLAN_SCALE_UNSUPPORTED、PLAN_FACT_*、PLAN_POLICY_UNSUPPORTED、PLAN_ROLE_VOCABULARY_*、
 * PLAN_COGNITION_*、PLAN_STAGE_UNSUPPORTED、PLAN_LINEAGE_*、PLAN_SEMANTIC_REPAIR_LIMIT、
 * PLAN_CELL_UNIVERSE_CONSERVATION），重新采样只会以同样方式失败，因此原样抛出、不消耗修复预算。
 *
 * 归属：按事项⑤（2026-10-20 已答复）可修复码暂留 Agent；若以后改为 Core 导出，再切换为引用 Core
 * 导出的集合并删除本常量。
 * 漂移守护：test/strict-production-chain.test.ts 读取 Core 实现中的全部 PLAN_* 码并要求逐一分类，
 * Core 新增或改名校验码时先在那里失败。
 */
const STRICT_PLAN_MODEL_REPAIRABLE_CODES: ReadonlySet<string> = new Set([
  'PLAN_ACTION_INCOMPLETE',
  'PLAN_ACTION_SCOPE_MISMATCH',
  'PLAN_ACTION_UNKNOWN_QUESTION',
  'PLAN_BUDGET_OUT_OF_BOUNDS',
  'PLAN_DECOMPOSITION_MISSING',
  'PLAN_QUERY_CAPABILITY_SCALE_MISMATCH',
  'PLAN_QUESTION_CYCLE',
  'PLAN_QUESTION_DUPLICATE',
  'PLAN_QUESTION_INCOMPLETE',
  'PLAN_QUESTION_INVALID',
  'PLAN_QUESTION_UNSCHEDULED',
  'PLAN_REQUIRED_LENS_STARVED',
  'PLAN_REQUIRED_LENS_UNSCHEDULED',
  'PLAN_SYNTHESIS_PREREQUISITES_INVALID',
  'PLAN_UNKNOWN_ANALYSIS_SCALE',
  'PLAN_UNKNOWN_ANATOMY_LENS',
  'PLAN_UNKNOWN_CAPABILITY',
  'PLAN_UNKNOWN_FROZEN_QUERY',
  'PLAN_UNKNOWN_QUERY_FAMILY',
  'PLAN_UNKNOWN_SUBJECT',
  'PLAN_UNKNOWN_SUBQUESTION',
]);

/**
 * 修复种类：semantic = 白名单 PLAN_* 语义拒绝；structural = 回复为空、JSON 非法或 intent 形状非法。
 * 两者共用 hardCaps.semanticRepairLimit 这一个预算（总计最多 STRICT_PLAN_SEMANTIC_REPAIR_CAP 次）。
 */
type StrictPlanRepairKind = 'semantic' | 'structural';

/** 被拒的父调用：修复轮必须携带它的输出，要求模型在此基础上最小修改，而不是重新采样。 */
interface StrictPlanRepairRequest {
  readonly kind: StrictPlanRepairKind;
  readonly reason: string;
  readonly parentInvocationId: string;
  readonly parentOutputHash: string;
  /** semantic：父 intent 的 Core 规范化 JSON；structural：父调用原始回复全文（无法解析）。 */
  readonly parentOutput: string;
}

/**
 * 解析结果：ok 时同时带出 Core 规范化哈希与规范化 JSON。两者都在解析阶段算出，任何让 Core
 * 规范化抛出的 intent 都在这里归为结构拒绝，而不是在主循环里以裸 TypeError 逃逸（L8-C06）。
 */
type StrictPlanParseOutcome =
  | {
      readonly ok: true;
      readonly intent: StrictPlanIntentV1;
      /** hashStrictPlanIntentV1(intent)，即该调用在 lineage 中的 outputHash。 */
      readonly outputHash: string;
      /** canonicalJsonStringify(intent)，语义修复轮作为父输出原样附上。 */
      readonly canonicalIntent: string;
    }
  | { readonly ok: false; readonly error: Error };

/** 一次形状拒绝最多列出的问题数；其余汇总为计数，避免畸形大回复把修复 prompt 撑爆。 */
const STRICT_PLAN_SHAPE_PROBLEM_LIMIT = 20;

/** 问题上 Core normalizeStrictPlanIntent 无条件 normalizeStrings 的必填字符串数组字段。 */
const STRICT_PLAN_QUESTION_STRING_ARRAY_FIELDS = [
  'subquestionIds',
  'anatomyLensIds',
  'subjectRefs',
  'analysisScales',
  'capabilityIds',
  'queryFamilyIds',
  'expectedSupport',
  'expectedCounterevidence',
] as const;

/** action 上 Core 仅在真值时 normalizeStrings 的可选字符串数组字段。 */
const STRICT_PLAN_ACTION_OPTIONAL_STRING_ARRAY_FIELDS = [
  'dimensionIds',
  'modulePaths',
  'anatomyLensIds',
  'subjectRefs',
  'analysisScales',
  'expectedSupport',
  'expectedCounterevidence',
] as const;

/** projectProfile 上 Core 仅在真值时 normalizeStrings 的可选字符串数组字段。 */
const STRICT_PLAN_PROFILE_OPTIONAL_STRING_ARRAY_FIELDS = [
  'secondaryLanguages',
  'frameworks',
  'architectureHints',
] as const;

/**
 * abortSignal / shouldAbort / timeoutMs：宿主可选的取消与期限信号（L8-C01）。每次认知调用（含因果
 * 语义修复）都携带同一组信号；中止后的调用状态不是 success，按 STRICT_PLAN_RUN_FAILED 抛出，不进入修复。
 */
export interface RunStrictPlanAgentInput extends SystemTaskRunSignals {
  readonly agentService: Pick<AgentService, 'run'>;
  readonly contextProjection: PlanContextProjectionV1;
  readonly validateReceipt: (receipt: PlanCognitionReceiptV1) => void | Promise<void>;
}

/**
 * 复用既有 Plan profile，但严格路径传完整 ProjectContext、禁用工具，并把修复记录成单一因果链。
 * 白名单 PLAN_* 语义拒绝与结构非法输出共用同一修复预算，最多回送两次；修复轮携带父输出并要求
 * 最小修改。预算耗尽必须显式拒绝，不能静默缩小范围；非白名单拒绝原样抛出、不重试。
 */
export async function runStrictPlanAgent({
  agentService,
  contextProjection,
  validateReceipt,
  abortSignal,
  shouldAbort,
  timeoutMs,
}: RunStrictPlanAgentInput): Promise<PlanCognitionReceiptV1> {
  validateStrictPlanContext(contextProjection);
  // 上限已在 validateStrictPlanContext 中校验为 0..STRICT_PLAN_SEMANTIC_REPAIR_CAP，这里直接使用宿主值。
  const semanticRepairLimit = contextProjection.hardCaps.semanticRepairLimit;
  let initial: PlanCognitionInvocationV1 | null = null;
  const repairs: PlanCognitionInvocationV1[] = [];
  let pendingRepair: StrictPlanRepairRequest | null = null;

  for (let attempt = 0; attempt <= semanticRepairLimit; attempt += 1) {
    // inputHash 按含父输出的完整 prompt 计算；冻结的 promptHash 仍是宿主授权的模板/配置版本标识，不重算。
    const prompt = buildStrictPlanPrompt(contextProjection, pendingRepair);
    const result = await agentService.run(
      buildSystemTaskRunInput({
        profileId: 'plan-selection',
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
        signals: { abortSignal, shouldAbort, timeoutMs },
      })
    );
    if (result.status !== 'success') {
      throw runFailure(
        result,
        `STRICT_PLAN_RUN_FAILED: ${result.status}: ${result.reply || 'empty reply'}`
      );
    }
    if (result.toolCalls.length > 0) {
      // provider 无视 toolChoice=none 执行了工具：这是违规而非语义缺口，不进入修复预算；
      // 用 runFailure 携带 partialResult/cause，让宿主能检查哪些（可能有副作用的）工具已执行。
      throw runFailure(result, `PLAN_TOOL_FORBIDDEN: ${describeToolCallNames(result.toolCalls)}`);
    }
    // 防御宿主替身缺失 reply：按空回复处理，归入结构修复而不是抛出 TypeError。
    const rawReply = result.reply ?? '';
    const parsed = parseStrictPlanIntent(rawReply, contextProjection);
    // 结构非法的调用没有 intent：outputHash 记录原始回复字节（Core sha256: 前缀形态），使它仍能作为
    // 因果父节点进入 lineage；Core 只要求最终调用的 outputHash 等于最终 intent 的哈希。
    // 合法 intent 的哈希已在解析阶段算出（规范化失败已归为结构拒绝），这里不会再抛出。
    const outputHash = parsed.ok ? parsed.outputHash : `sha256:${hashText(rawReply)}`;
    const inputHash = hashText(prompt);
    const invocationBase = {
      invocationId: `plan-cognition-${attempt}-${hashText(`${result.runId}:${inputHash}:${outputHash}`).slice(0, 16)}`,
      inputHash,
      outputHash,
      modelHash: contextProjection.modelHash,
      promptHash: contextProjection.promptHash,
    };
    if (attempt === 0) {
      initial = invocationBase;
    } else {
      if (!pendingRepair) {
        throw new Error('PLAN_LINEAGE_BROKEN: repair without causal parent');
      }
      repairs.push({
        ...invocationBase,
        parentInvocationId: pendingRepair.parentInvocationId,
        reason: pendingRepair.reason,
      });
    }
    if (!initial) {
      throw new Error('PLAN_LINEAGE_BROKEN: initial invocation missing');
    }

    let rejection: { readonly kind: StrictPlanRepairKind; readonly error: Error };
    if (!parsed.ok) {
      rejection = { kind: 'structural', error: parsed.error };
    } else {
      const intent = parsed.intent;
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
      // receiptId = `plan-cognition-receipt-` + 仓内唯一规范哈希的裸 hex（primitives.hashCanonical）。
      // 原先本文件有一份私有副本，W1-10 按事项⑥（只收敛副本、不改排序）收敛；逐字节等价由
      // test/strict-canonical-golden.test.ts 钉住。
      const receipt: PlanCognitionReceiptV1 = {
        ...semantic,
        receiptId: `plan-cognition-receipt-${hashCanonical(semantic)}`,
      };
      try {
        // 冻结 query 是语义校验；与 Core 拒绝共用既有因果修复预算，不绕过父 invocation。
        validateFrozenPlanQueries(intent, contextProjection);
        await validateReceipt(receipt);
        return receipt;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const failureCode = readPlanFailureCode(message);
        if (!failureCode) {
          // 非 PLAN_ 拒绝不是可修复的语义缺口，直接交还宿主；宿主校验器抛出非 Error 值时
          // 归一化成 Error（保留原值为 cause），保证调用方只收到 Error 实例。
          throw normalizeHostRejection(error, attempt);
        }
        if (!STRICT_PLAN_MODEL_REPAIRABLE_CODES.has(failureCode)) {
          // 确定性 PLAN_*：重采样无法修复，原样抛出原错误码，不改标为 REPAIR_LIMIT、不消耗预算。
          reportStrictPlanRepairDecision(
            'warn',
            `[StrictPlan] ${failureCode} is not model-repairable; rethrowing without repair (attempt=${attempt})`,
            {
              reasonCode: 'strict-plan-repair-ineligible',
              failureCode,
              semanticRepairAttempt: attempt,
              resolution: 'rethrow-original',
            }
          );
          throw normalizeHostRejection(error, attempt);
        }
        rejection = {
          kind: 'semantic',
          error: error instanceof Error ? error : new Error(message, { cause: error }),
        };
      }
    }

    const reason = rejection.error.message;
    const failureCode = readFailureCode(reason);
    if (attempt >= semanticRepairLimit) {
      reportStrictPlanRepairDecision(
        'warn',
        `[StrictPlan] repair budget exhausted on ${rejection.kind} rejection ${failureCode} (attempt=${attempt}, limit=${semanticRepairLimit})`,
        {
          reasonCode: 'strict-plan-repair-exhausted',
          repairKind: rejection.kind,
          failureCode,
          semanticRepairAttempt: attempt,
          semanticRepairLimit,
          resolution: 'throw-repair-limit',
        }
      );
      throw new Error(`PLAN_SEMANTIC_REPAIR_LIMIT: ${reason}`, { cause: rejection.error });
    }
    reportStrictPlanRepairDecision(
      'info',
      `[StrictPlan] scheduling ${rejection.kind} repair for ${failureCode} (attempt=${attempt}, remainingAfter=${semanticRepairLimit - attempt - 1})`,
      {
        reasonCode: 'strict-plan-repair-scheduled',
        repairKind: rejection.kind,
        failureCode,
        semanticRepairAttempt: attempt,
        // 本次修复之后仍剩余的修复次数。
        remainingRepairs: semanticRepairLimit - attempt - 1,
        parentInvocationId: invocationBase.invocationId,
      }
    );
    pendingRepair = {
      kind: rejection.kind,
      reason,
      parentInvocationId: invocationBase.invocationId,
      parentOutputHash: outputHash,
      parentOutput: parsed.ok ? parsed.canonicalIntent : rawReply,
    };
  }
  throw new Error('PLAN_SEMANTIC_REPAIR_LIMIT');
}

/** abortSignal / shouldAbort / timeoutMs：宿主可选的取消与期限信号（L8-C01），与 toolChoiceOverride 一起并入 execution。 */
export interface RunPlanAgentInput extends SystemTaskRunSignals {
  agentService: Pick<AgentService, 'run'>;
  generationStage: PlanStageId;
  projectContextFacts: unknown;
}

export async function runPlanAgent({
  agentService,
  generationStage,
  projectContextFacts,
  abortSignal,
  shouldAbort,
  timeoutMs,
}: RunPlanAgentInput): Promise<PlanSelection> {
  const result = await agentService.run(
    buildSystemTaskRunInput({
      profileId: 'plan-selection',
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
      signals: { abortSignal, shouldAbort, timeoutMs },
    })
  );

  if (result.status !== 'success') {
    throw runFailure(
      result,
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
  repair: StrictPlanRepairRequest | null
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
    ...(repair ? buildStrictPlanRepairSection(repair) : []),
    '完整 ProjectContext facts（不得截断）：',
    JSON.stringify(context.projectContextFacts, null, 2),
  ].join('\n');
}

/**
 * 修复段（L8-C06）：附上被拒父调用的完整输出，要求在其基础上最小修改，使 lineage 中
 * parentInvocationId 声明的因果关系与实际生成过程一致。父输出不截断：截断会让最小修改无从谈起。
 */
function buildStrictPlanRepairSection(repair: StrictPlanRepairRequest): string[] {
  if (repair.kind === 'structural') {
    return [
      `这是父调用 ${repair.parentInvocationId} 的因果结构修复：父输出无法解析为合法的 StrictPlanIntentV1。`,
      `拒绝原因：${repair.reason}`,
      `父调用原始输出开始（outputHash=${repair.parentOutputHash}，原文）：`,
      repair.parentOutput,
      '父调用原始输出结束。',
      '在父输出基础上做最小修改：保留其中已有的问题、动作、预算与冻结 ID，只补全或修正导致解析/形状失败的结构（例如截断、缺失字段），输出完整的 StrictPlanIntentV1 JSON object；不得缩小范围。',
    ];
  }
  return [
    `这是父调用 ${repair.parentInvocationId} 的因果语义修复。`,
    `验证器拒绝原因：${repair.reason}`,
    `父调用输出开始（outputHash=${repair.parentOutputHash}，规范化 JSON）：`,
    repair.parentOutput,
    '父调用输出结束。',
    '在父输出基础上做最小修改：保持原始完整范围和冻结 ID，只修复验证器指出的语义缺口，其余问题、动作与预算保持不变，输出修改后的完整 StrictPlanIntentV1 JSON object。',
  ];
}

/**
 * 解析严格 Plan 回复。失败不抛出而是返回结构拒绝，由调用方计入同一修复预算（L8-C06）：
 * STRICT_PLAN_EMPTY_REPLY / STRICT_PLAN_INTENT_JSON_INVALID / STRICT_PLAN_INTENT_SHAPE_INVALID，
 * 形状拒绝列出不满足的字段（上限 STRICT_PLAN_SHAPE_PROBLEM_LIMIT 条），供结构修复轮定向补全。
 *
 * 形状检查之后立即计算 Core 规范化哈希与规范化 JSON：AI 输出必须先验证再进入核心执行流，
 * 任何让 Core 规范化抛出的 intent（例如 1e999 解析出的 Infinity，或 Core 新增读取的字段）
 * 也归为 STRICT_PLAN_INTENT_SHAPE_INVALID，并以原始异常为 cause。
 */
function parseStrictPlanIntent(
  reply: string,
  context: PlanContextProjectionV1
): StrictPlanParseOutcome {
  if (reply.trim().length === 0) {
    return { ok: false, error: new Error('STRICT_PLAN_EMPTY_REPLY') };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonObjectFromReply(reply);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(`STRICT_PLAN_INTENT_JSON_INVALID: ${detail}`, { cause: err }),
    };
  }
  const problems = collectStrictPlanIntentShapeProblems(parsed, context);
  if (problems.length > 0) {
    return {
      ok: false,
      error: new Error(`STRICT_PLAN_INTENT_SHAPE_INVALID: ${formatShapeProblems(problems)}`),
    };
  }
  // 形状检查已确认 parsed 是对象且带齐 Core 规范化会读取的字段，可按 StrictPlanIntentV1 交给 Core。
  const intent = parsed as StrictPlanIntentV1;
  try {
    const outputHash = hashStrictPlanIntentV1(intent);
    const canonicalIntent = canonicalJsonStringify(intent);
    return { ok: true, intent, outputHash, canonicalIntent };
  } catch (err: unknown) {
    // 兜底分支：本地形状检查之外 Core 规范化仍拒绝了 intent。非有限数字是已知来源；
    // 其余情况说明 Core 新增了读取字段，日志里的 detail 用于回查并补齐本地形状检查。
    const detail = err instanceof Error ? err.message : String(err);
    const nonFinitePaths = collectNonFiniteNumberPaths(intent, '', []);
    reportStrictPlanRepairDecision(
      'warn',
      `[StrictPlan] Core canonicalization rejected a shape-checked intent; classifying as STRICT_PLAN_INTENT_SHAPE_INVALID (${detail})`,
      {
        reasonCode: 'strict-plan-intent-canonicalization-failed',
        detail,
        nonFinitePaths,
        resolution: 'structural-rejection',
      }
    );
    const located =
      nonFinitePaths.length > 0
        ? `; non-finite numbers at ${formatShapeProblems(nonFinitePaths)}`
        : '';
    return {
      ok: false,
      error: new Error(
        `STRICT_PLAN_INTENT_SHAPE_INVALID: intent is not canonical JSON (${detail})${located}`,
        { cause: err }
      ),
    };
  }
}

/**
 * 严格 intent 的形状检查（L8-C06）。覆盖 Core normalizeStrictPlanIntent（hashStrictPlanIntentV1 的
 * 规范化步骤）与严格 cognition 校验会直接读取、类型不对就抛裸 TypeError 的容器和字段：
 * projectProfile、scale.depthLevels、问题的必填字符串数组、排序键（dimensionId、modulePath、tool、
 * questionId）、evidenceRefs 的 kind/ref 等。这些错误模型改写即可修复，因此归为结构拒绝。
 *
 * 只检查类型，不检查取值：ID 是否在冻结目录内、预算是否越界、问题是否完整仍由 Core 以白名单
 * PLAN_* 判定。可选数组按 Core 的真值语义：缺失、null 或其他假值时跳过，只有真值才要求是字符串数组。
 */
function collectStrictPlanIntentShapeProblems(
  parsed: unknown,
  context: PlanContextProjectionV1
): string[] {
  if (!isRecord(parsed)) {
    return [`intent must be a JSON object, got ${describeJsonType(parsed)}`];
  }
  const problems: string[] = [];
  if (parsed.generationStage !== context.generationStage) {
    problems.push(
      `generationStage=${describeValue(parsed.generationStage)} expected "${context.generationStage}"`
    );
  }

  const profile = parsed.projectProfile;
  if (isRecord(profile)) {
    for (const field of STRICT_PLAN_PROFILE_OPTIONAL_STRING_ARRAY_FIELDS) {
      checkOptionalStringArray(profile[field], `projectProfile.${field}`, problems);
    }
  } else {
    problems.push('projectProfile must be an object');
  }

  checkRecordArray(parsed.dimensions, 'dimensions', problems, (dimension, path) => {
    checkString(dimension.dimensionId, `${path}.dimensionId`, problems);
  });

  const scale = parsed.scale;
  if (isRecord(scale)) {
    checkStringArray(scale.depthLevels, 'scale.depthLevels', problems);
  } else {
    problems.push('scale must be an object');
  }

  checkRecordArray(parsed.moduleBindings, 'moduleBindings', problems, (binding, path) => {
    checkString(binding.modulePath, `${path}.modulePath`, problems);
    checkOptionalString(binding.moduleId, `${path}.moduleId`, problems);
    checkStringArray(binding.dimensions, `${path}.dimensions`, problems);
  });

  checkRecordArray(parsed.plannedNextActions, 'plannedNextActions', problems, (action, path) => {
    checkString(action.tool, `${path}.tool`, problems);
    checkOptionalString(action.questionId, `${path}.questionId`, problems);
    for (const field of STRICT_PLAN_ACTION_OPTIONAL_STRING_ARRAY_FIELDS) {
      checkOptionalStringArray(action[field], `${path}.${field}`, problems);
    }
  });

  checkRecordArray(parsed.evidenceRefs, 'evidenceRefs', problems, (reference, path) => {
    checkString(reference.kind, `${path}.kind`, problems);
    checkString(reference.ref, `${path}.ref`, problems);
    checkOptionalString(reference.detail, `${path}.detail`, problems);
  });

  // investigationDecomposition 在严格路径上是必需段（缺失时 Core 报 PLAN_DECOMPOSITION_MISSING，
  // 这里沿用原本地检查，提前作为结构拒绝）。question.budget 会被 Core cognition 校验直接读取字段。
  const decomposition = parsed.investigationDecomposition;
  if (isRecord(decomposition)) {
    checkRecordArray(
      decomposition.questions,
      'investigationDecomposition.questions',
      problems,
      (question, path) => {
        checkString(question.questionId, `${path}.questionId`, problems);
        for (const field of STRICT_PLAN_QUESTION_STRING_ARRAY_FIELDS) {
          checkStringArray(question[field], `${path}.${field}`, problems);
        }
        if (!isRecord(question.budget)) {
          problems.push(`${path}.budget must be an object`);
        }
      }
    );
  } else {
    problems.push('investigationDecomposition must be an object with a questions array');
  }

  if (!readRecord(parsed.budgetStrategy).schemaVersion) {
    problems.push('budgetStrategy.schemaVersion missing');
  }

  // Core 仅在真值时对每个条目 normalizeStrings；它的类型是 cellId → 前置 cellId 列表的映射。
  const prerequisites = parsed.synthesisPrerequisiteCellIds;
  if (prerequisites) {
    if (isRecord(prerequisites)) {
      for (const [cellId, cellPrerequisites] of Object.entries(prerequisites)) {
        checkStringArray(
          cellPrerequisites,
          `synthesisPrerequisiteCellIds[${JSON.stringify(cellId)}]`,
          problems
        );
      }
    } else {
      problems.push('synthesisPrerequisiteCellIds must be an object');
    }
  }
  return problems;
}

/** 数组且每项都是对象；逐项交给 checkItem 检查字段。非数组时只报一条，不再深入。 */
function checkRecordArray(
  value: unknown,
  path: string,
  problems: string[],
  checkItem: (item: Record<string, unknown>, itemPath: string) => void
): void {
  if (!Array.isArray(value)) {
    problems.push(`${path} must be an array`);
    return;
  }
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (isRecord(item)) {
      checkItem(item, itemPath);
    } else {
      problems.push(`${itemPath} must be an object`);
    }
  }
}

function checkString(value: unknown, path: string, problems: string[]): void {
  if (typeof value !== 'string') {
    problems.push(`${path} must be a string`);
  }
}

/** Core 以 `value ?? fallback` 读取的可选字符串：缺失或 null 合法，其余必须是字符串。 */
function checkOptionalString(value: unknown, path: string, problems: string[]): void {
  if (value !== undefined && value !== null) {
    checkString(value, path, problems);
  }
}

/** Core normalizeStrings 逐项调用 trim()：必须是数组且每项都是字符串。 */
function checkStringArray(value: unknown, path: string, problems: string[]): void {
  if (!Array.isArray(value)) {
    problems.push(`${path} must be an array of strings`);
    return;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      problems.push(`${path}[${index}] must be a string`);
    }
  }
}

/** Core 以真值判断的可选字符串数组：假值跳过（与 Core 一致，不额外收紧），真值必须是字符串数组。 */
function checkOptionalStringArray(value: unknown, path: string, problems: string[]): void {
  if (value) {
    checkStringArray(value, path, problems);
  }
}

/** 列出 JSON 值中全部非有限数字的路径（JSON.parse 只会因溢出产生 ±Infinity）。 */
function collectNonFiniteNumberPaths(value: unknown, path: string, paths: string[]): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      paths.push(path || '<root>');
    }
    return paths;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectNonFiniteNumberPaths(item, `${path}[${index}]`, paths);
    }
    return paths;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectNonFiniteNumberPaths(item, path ? `${path}.${key}` : key, paths);
    }
  }
  return paths;
}

/** 截断问题列表：保留前 STRICT_PLAN_SHAPE_PROBLEM_LIMIT 条，其余写成 "(+N more)"。 */
function formatShapeProblems(problems: readonly string[]): string {
  if (problems.length <= STRICT_PLAN_SHAPE_PROBLEM_LIMIT) {
    return problems.join('; ');
  }
  const shown = problems.slice(0, STRICT_PLAN_SHAPE_PROBLEM_LIMIT);
  return [...shown, `(+${problems.length - STRICT_PLAN_SHAPE_PROBLEM_LIMIT} more)`].join('; ');
}

/** 形状拒绝里描述根值的 JSON 类型（array/null/number/string/boolean）。 */
function describeJsonType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

/**
 * 本地冻结查询校验：列出每个越出冻结 capability/queryFamily 目录的 action（下标、questionId、
 * 越界的 ID），让修复轮能定向修改而不是只拿到裸错误码（L8-C06）。
 */
function validateFrozenPlanQueries(
  intent: StrictPlanIntentV1,
  context: PlanContextProjectionV1
): void {
  const record = readRecord(intent);
  const frozenCapabilities = new Set(context.frozenCapabilityIds);
  const frozenFamilies = new Set(context.frozenQueryFamilyIds);
  const violations: string[] = [];
  for (const [index, raw] of (record.plannedNextActions as unknown[]).entries()) {
    const action = readRecord(raw);
    const capabilityFrozen = frozenCapabilities.has(String(action.capabilityId ?? ''));
    const familyFrozen = frozenFamilies.has(String(action.queryFamilyId ?? ''));
    if (capabilityFrozen && familyFrozen) {
      continue;
    }
    violations.push(
      [
        `plannedNextActions[${index}]`,
        `questionId=${describeValue(action.questionId)}`,
        `capabilityId=${describeValue(action.capabilityId)}${capabilityFrozen ? '' : ' (not frozen)'}`,
        `queryFamilyId=${describeValue(action.queryFamilyId)}${familyFrozen ? '' : ' (not frozen)'}`,
      ].join(' ')
    );
  }
  if (violations.length > 0) {
    throw new Error(`PLAN_UNKNOWN_FROZEN_QUERY: ${violations.join('; ')}`);
  }
}

/**
 * 诊断消息里的值：缺失写成 null，其余按 JSON 呈现，便于区分空串、缺失与非字符串值。
 * 入参都来自模型回复的 JSON.parse 结果（无循环、无 bigint），JSON.stringify 不会抛出。
 */
function describeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return 'null';
  }
  return JSON.stringify(value) ?? String(value);
}

/** 宿主/本地拒绝消息开头的 PLAN_* 码；不以 PLAN_ 开头时返回 null（交由非 PLAN_ 分支原样交还）。 */
function readPlanFailureCode(message: string): string | null {
  return /^(PLAN_[A-Z0-9_]+)/u.exec(message)?.[1] ?? null;
}

/** 诊断用的失败码：取消息开头的大写错误码，没有时标为 UNCLASSIFIED。 */
function readFailureCode(message: string): string {
  return /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1] ?? 'UNCLASSIFIED';
}

/** 结构拒绝归类、修复资格、调度与耗尽的诊断事件；诊断通道失败不影响严格 Plan 主流程。 */
function reportStrictPlanRepairDecision(
  level: 'info' | 'warn',
  message: string,
  data: Record<string, unknown>
): void {
  observeSafely(
    () => {
      const logger = Logger.getInstance();
      if (level === 'warn') {
        logger.warn(message, data);
      } else {
        logger.info(message, data);
      }
    },
    () => undefined
  );
}

/** 去重后的工具名列表，供 PLAN_TOOL_FORBIDDEN 消息定位违规调用；完整调用仍在 partialResult 中。 */
function describeToolCallNames(toolCalls: AgentRunResult['toolCalls']): string {
  const names = [...new Set(toolCalls.map((call) => call.tool || call.name || '<unnamed>'))];
  return names.join(', ');
}

function normalizeHostRejection(error: unknown, attempt: number): Error {
  if (error instanceof Error) {
    return error;
  }
  const rejectionType = error === null ? 'null' : typeof error;
  // 兼容转译路径：宿主违反“只抛 Error 实例”的约定，记录类型与尝试序号便于回查宿主校验器。
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[StrictPlan] host validateReceipt rejected with a non-Error value; rethrowing as Error (type=${rejectionType}, attempt=${attempt})`,
        {
          reasonCode: 'strict-plan-non-error-rejection-normalized',
          rejectionType,
          semanticRepairAttempt: attempt,
          resolution: 'rethrow-as-error',
        }
      ),
    () => undefined
  );
  return new Error(String(error), { cause: error });
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
  if (context.hardCaps.semanticRepairLimit > STRICT_PLAN_SEMANTIC_REPAIR_CAP) {
    throw new Error(
      `STRICT_PLAN_CONTEXT_INVALID: semanticRepairLimit=${context.hardCaps.semanticRepairLimit} exceeds strict cap ${STRICT_PLAN_SEMANTIC_REPAIR_CAP}`
    );
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
  return isRecord(value) ? value : {};
}

/** 非 null、非数组的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
