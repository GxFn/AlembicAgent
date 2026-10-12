/**
 * Core 提交回执到工具结果的集中映射：按 Core 去向键穷举分派，created 之后的只读 readiness 与
 * 会话投影也在这里；附加失败不能抹掉持久化回执。
 */
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { runOperation } from '#shared/operation.js';
import {
  fail,
  ok,
  type ToolContext,
  type ToolDiagnosticWarning,
  type ToolResult,
} from '#tools/kernel/registry.js';
import type { PreparedRecipeProductionItem } from '../recipeProductionAdapter.js';
import type { RecipeGatewayLike } from './contracts.js';
import { sessionCounterBox } from './sessionState.js';

type ProductionResult = Awaited<ReturnType<RecipeGatewayLike['createOrStage']>>;

/**
 * Core 结果中表示“候选去向”的列表键：created/duplicates/merged/rejected/blocked。
 * pendingSemanticReview 是附注不是去向；supersedeProposal/production 不是列表。
 */
type ProductionOutcomeKey = Exclude<
  {
    [K in keyof ProductionResult]-?: NonNullable<ProductionResult[K]> extends readonly unknown[]
      ? K
      : never;
  }[keyof ProductionResult],
  'pendingSemanticReview'
>;

/**
 * 去向判定优先级（数值小者先判），以 Core 去向键做穷举映射：Core 新增去向列表而这里没登记时
 * `satisfies` 让类型检查失败，handleSubmit 的 switch 也会缺分支，迫使映射同步，而不是让新去向
 * 悄悄落入兜底。单条提交时各去向本应互斥；created 最先，Core 已确认的持久化回执不能被同批
 * 附带的拒绝（如 relation_resolution_failed）遮住。
 */
const OUTCOME_PRECEDENCE = {
  created: 0,
  duplicates: 1,
  merged: 2,
  rejected: 3,
  blocked: 4,
} as const satisfies Record<ProductionOutcomeKey, number>;

const OUTCOME_ORDER = (Object.keys(OUTCOME_PRECEDENCE) as ProductionOutcomeKey[]).sort(
  (left, right) => OUTCOME_PRECEDENCE[left] - OUTCOME_PRECEDENCE[right]
);

/** 宿主端口的去向列表先归一：非数组视为缺席（契约漂移），交给兜底留痕而不是抛 TypeError。 */
function outcomeList(
  result: ProductionResult,
  key: ProductionOutcomeKey
): readonly unknown[] | null {
  const value: unknown = result[key];
  return Array.isArray(value) ? value : null;
}

/** 返回第一个非空的 Core 去向；全部为空或缺席时返回 null，由调用方走降级兜底。 */
export function classifyProductionOutcome(result: ProductionResult): ProductionOutcomeKey | null {
  for (const key of OUTCOME_ORDER) {
    if ((outcomeList(result, key)?.length ?? 0) > 0) {
      return key;
    }
  }
  return null;
}

/** 映射所需的提交上下文：日志定位（标题、维度）与随回执返回的代码证据。 */
export interface SubmissionTrace {
  title: string;
  dimensionId: string;
  codeEvidence: PreparedRecipeProductionItem['codeEvidence'];
}

/**
 * Core Layer 1.5 的语义复核附注：非空时记 info 日志并原样附到回执上，让模型和复盘看到
 * “与某条已有 Recipe 中度重叠、需人工判定”的事实。它不是失败也不是降级。
 */
export function pendingSemanticReviewOf(
  result: ProductionResult,
  trace: SubmissionTrace
): ProductionResult['pendingSemanticReview'] {
  const reviews = Array.isArray(result.pendingSemanticReview) ? result.pendingSemanticReview : [];
  if (reviews.length === 0) {
    return undefined;
  }
  const related = reviews
    .slice(0, 3)
    .map(
      (review) =>
        `"${String(review.relatedRecipe?.title ?? review.title ?? '')}" (${String(review.relatedRecipe?.similarity ?? 'n/a')}): ${String(review.reason ?? '')}`
    )
    .join('; ');
  observeSafely(
    () =>
      Logger.getInstance().info(
        `[knowledge.submit] Core flagged semantic review for "${trace.title}" (dim=${trace.dimensionId}): ${related}`
      ),
    () => undefined
  );
  return [...reviews];
}

/**
 * Core 在 createOrStage 等待期间被取消后仍确认了写入时，由调用方（持有 operation.ts 边界）
 * 传入的 KNOWLEDGE_MUTATION_COMPLETED_AFTER_ABORT 诊断；未取消时为空。
 */
type MutationAbortWarnings = readonly ToolDiagnosticWarning[] | undefined;

function writeReceiptMeta(warnings: readonly ToolDiagnosticWarning[]) {
  return warnings.length > 0 ? { degraded: true, diagnosticWarnings: [...warnings] } : undefined;
}

export function duplicateBlockedResult(
  duplicates: ProductionResult['duplicates'],
  trace: SubmissionTrace
): ToolResult {
  Logger.getInstance().warn(
    `[knowledge.submit] gateway duplicate for "${trace.title}" (dim=${trace.dimensionId}): similar to ${duplicates
      .map((d) => `"${d.title}"`)
      .slice(0, 3)
      .join(', ')}`
  );
  return ok({
    status: 'duplicate_blocked',
    codeEvidence: trace.codeEvidence,
    similar: duplicates.map((d) => ({
      title: d.title,
      similarity: d.similarTo?.[0]?.similarity ?? 0,
      similarTo: d.similarTo ?? [],
    })),
  });
}

/**
 * Core 把候选转成了对已有 Recipe 的整合提案（merge/reorganize 等）：候选本身没有新建，
 * 但已由 Core 处理完毕。返回独立的 merged_into_proposal 状态（不计入已持久化提交），
 * 提示模型跳到下一个 finding，不要改写重提。
 */
export function mergedIntoProposalResult(
  merged: ProductionResult['merged'][number],
  trace: SubmissionTrace,
  pendingSemanticReview: ProductionResult['pendingSemanticReview'],
  mutationAbortWarnings: MutationAbortWarnings
): ToolResult {
  // Core 已写入提案：日志只是观察者，日志通道失败不能把结果翻成 fail 而诱导重提。
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[knowledge.submit] gateway merged "${trace.title}" (dim=${trace.dimensionId}) into ${String(merged.type)} proposal ${String(merged.proposalId)} for recipe ${String(merged.targetRecipeId)} ("${String(merged.targetTitle)}")`
      ),
    () => undefined
  );
  return ok(
    {
      status: 'merged_into_proposal',
      proposalId: merged.proposalId,
      proposalType: merged.type,
      targetRecipeId: merged.targetRecipeId,
      targetTitle: merged.targetTitle,
      message: merged.message,
      codeEvidence: trace.codeEvidence,
      ...(pendingSemanticReview ? { pendingSemanticReview } : {}),
    },
    writeReceiptMeta(mutationAbortWarnings ?? [])
  );
}

export function gatewayRejectedResult(
  rejected: ProductionResult['rejected'][number],
  trace: SubmissionTrace
): ToolResult {
  const firstErrors = Array.isArray(rejected.errors) ? rejected.errors.slice(0, 2) : [];
  Logger.getInstance().warn(
    `[knowledge.submit] gateway rejected "${trace.title}" (dim=${trace.dimensionId}): ${String(rejected.reason ?? '')}${firstErrors.length > 0 ? ` — ${firstErrors.join(' | ').slice(0, 220)}` : ''}`
  );
  const details = [
    `Rejected: ${rejected.reason}`,
    ...(Array.isArray(rejected.errors) ? rejected.errors : []),
    ...(Array.isArray(rejected.warnings)
      ? rejected.warnings.map((warning) => `warning: ${warning}`)
      : []),
  ].join('\n');
  return trace.codeEvidence.accepted
    ? fail(details)
    : {
        ok: false,
        data: {
          status: 'rejected',
          reason: 'unsafe-core-code-removed',
          message: details,
          codeEvidence: trace.codeEvidence,
        },
        error: details,
      };
}

export function consolidationBlockedResult(
  blocked: ProductionResult['blocked'][number],
  trace: SubmissionTrace
): ToolResult {
  Logger.getInstance().warn(
    `[knowledge.submit] gateway blocked by consolidation "${trace.title}" (dim=${trace.dimensionId})`
  );
  const message = `Blocked by consolidation: ${(blocked as { title?: string }).title ?? 'unknown'}`;
  return trace.codeEvidence.accepted
    ? fail(message)
    : {
        ok: false,
        data: {
          status: 'consolidation-blocked',
          reason: 'unsafe-core-code-removed',
          message,
          codeEvidence: trace.codeEvidence,
        },
        error: message,
      };
}

/**
 * 兜底：Core 没有返回任何可识别去向（全空或列表缺席）。Core 可能已经写入，所以不改为 fail
 * 以免诱导重复提交；但必须 warn 留痕、标 degraded，并在回执里明确“不要重提”。是否真的写入
 * 无法确认，因此不附加 KNOWLEDGE_MUTATION_COMPLETED_AFTER_ABORT。
 */
export function unrecognizedOutcomeResult(
  result: ProductionResult,
  trace: SubmissionTrace
): ToolResult {
  const shape = OUTCOME_ORDER.map((key) => {
    const list = outcomeList(result, key);
    return `${key}=${list ? list.length : 'absent'}`;
  }).join(' ');
  const message = `Core returned no recognizable outcome for this candidate (${shape}); it may already be persisted, so do not resubmit it and move on to the next finding`;
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[knowledge.submit] unrecognized gateway outcome for "${trace.title}" (dim=${trace.dimensionId}): ${shape}`
      ),
    () => undefined
  );
  return ok(
    { status: 'processed', result, codeEvidence: trace.codeEvidence, message },
    {
      degraded: true,
      diagnosticWarnings: [
        {
          code: 'KNOWLEDGE_SUBMIT_OUTCOME_UNRECOGNIZED',
          message,
          stage: 'knowledge.submit',
          tool: 'knowledge',
        },
      ],
    }
  );
}

interface CreatedSubmission {
  created: ProductionResult['created'][number];
  production: ProductionResult['production'];
  codeEvidence: PreparedRecipeProductionItem['codeEvidence'];
  item: Readonly<{ title: string; kind: string }>;
  /** Core Layer 1.5 的语义复核附注；只原样附在回执上，不改变 created 的持久化事实。 */
  pendingSemanticReview?: ProductionResult['pendingSemanticReview'];
  /** 调用方在 createOrStage 返回时计算的“取消后仍完成写入”诊断（completedMutationMeta）。 */
  mutationAbortWarnings?: MutationAbortWarnings;
}

/** 这里只接收已确认的回执与 readiness 读口，没有创建或发布候选的权限。 */
export async function completeCreatedSubmission(
  {
    created,
    production,
    codeEvidence,
    item,
    pendingSemanticReview,
    mutationAbortWarnings,
  }: CreatedSubmission,
  gateway: Pick<RecipeGatewayLike, 'evaluateReadiness'>,
  ctx: Pick<ToolContext, 'abortSignal' | 'runtime' | 'sessionStore'>
): Promise<ToolResult> {
  // Core 已确认持久化：后续读取/会话记录失败只能降级诊断，不能抹掉身份或诱发再次 create。
  // createOrStage 不接收取消信号：调用方在回执到达时已发现取消，就先带上
  // KNOWLEDGE_MUTATION_COMPLETED_AFTER_ABORT（与 knowledge.manage 同码），用机器可读 code 区分
  // “取消后仍完成的写入”与普通 readiness 读取故障。保存过程中才发生的取消仍由下方 save 之后的
  // 检查标注；两条路径互斥（入口已取消时不会再 save），不会重复同一 code。
  const diagnosticWarnings: ToolDiagnosticWarning[] = [...(mutationAbortWarnings ?? [])];
  const recordPostCommitWarning = (code: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    diagnosticWarnings.push({ code, message, stage: 'knowledge.submit', tool: 'knowledge' });
    // 警告已写入真实回执；日志通道的同步/异步失败不得再进入 submission 的失败分支。
    observeSafely(
      () =>
        Logger.getInstance().warn(
          `[knowledge.submit] persisted ${created.id}; ${code}: ${message}`
        ),
      () => undefined
    );
  };
  const abortedBeforePostCommit = ctx.abortSignal?.aborted === true;
  let readiness: Awaited<ReturnType<RecipeGatewayLike['evaluateReadiness']>> | undefined;
  if (abortedBeforePostCommit) {
    // 已取消就不再发起新的只读 readiness 请求；这是“跳过”而非“读取失败”，单独记码。
    recordPostCommitWarning(
      'KNOWLEDGE_READINESS_SKIPPED_AFTER_ABORT',
      new Error('Readiness check skipped: cancelled before the post-commit read started')
    );
  } else {
    try {
      const read = await runOperation(() => gateway.evaluateReadiness(created.id), {
        abortSignal: ctx.abortSignal,
      });
      if (read.status === 'ok') {
        readiness = read.value;
      } else {
        recordPostCommitWarning(
          'KNOWLEDGE_READINESS_UNAVAILABLE',
          read.error ?? new Error(`Readiness ${read.status} after persistence`)
        );
      }
    } catch (err: unknown) {
      recordPostCommitWarning('KNOWLEDGE_READINESS_UNAVAILABLE', err);
    }
  }
  if (readiness) {
    try {
      const readinessEvidence = {
        id: created.id,
        lifecycle: created.lifecycle,
        ready: readiness.ready,
        violationCodes: readiness.violations.map((violation) => violation.code),
      };
      const readinessBox = sessionCounterBox(ctx.runtime);
      if (readinessBox) {
        const reports = Array.isArray(readinessBox.recipeReadinessReports)
          ? readinessBox.recipeReadinessReports
          : [];
        readinessBox.recipeReadinessReports = [...reports, readinessEvidence];
      }
      if (!readiness.ready) {
        const message = `[knowledge.submit] candidate persisted as ${created.lifecycle} with Core readiness violations for "${String(item.title ?? '')}": ${readiness.violations.map((violation) => violation.code).join(', ')}`;
        observeSafely(
          () => Logger.getInstance().warn(message),
          () => undefined
        );
      }
    } catch (err: unknown) {
      recordPostCommitWarning('KNOWLEDGE_SUBMISSION_RECORD_FAILED', err);
    }
  }
  // 不可用与 Core 明确 ready=false 不同；保留缺席形态，不编造 Core 的判定。
  const readinessData = readiness ? { readiness } : { readinessStatus: 'unavailable' };
  if (ctx.sessionStore && ctx.abortSignal?.aborted) {
    recordPostCommitWarning(
      'KNOWLEDGE_SESSION_SAVE_SKIPPED',
      new Error('Session save aborted before starting')
    );
  } else if (ctx.sessionStore) {
    try {
      await ctx.sessionStore.save(
        `submit:${item.title}`,
        JSON.stringify({
          title: item.title,
          kind: item.kind,
          lifecycle: created.lifecycle,
          production,
          codeEvidence,
          ...readinessData,
        }),
        { tags: ['submission'] }
      );
      if (ctx.abortSignal?.aborted) {
        recordPostCommitWarning(
          'KNOWLEDGE_MUTATION_COMPLETED_AFTER_ABORT',
          new Error('Session save completed after cancellation')
        );
      }
    } catch (err: unknown) {
      recordPostCommitWarning('KNOWLEDGE_SESSION_SAVE_FAILED', err);
    }
  }
  // Core 先确认 created 身份，再补写关系；补写读回可能为空，不能据此抹掉创建事实。
  let persistedReview: Record<string, unknown> = {};
  if (created.raw == null) {
    recordPostCommitWarning(
      'KNOWLEDGE_CREATED_DETAILS_UNAVAILABLE',
      new Error(
        'Core confirmed the created identity but returned no persisted details; keep the identity and read back details without creating again'
      )
    );
  } else {
    try {
      persistedReview = projectPersistedRecipeReview(created.raw);
    } catch (err: unknown) {
      // Core wrapper 已确认身份；实体的可选 getter/详情读取失败只降级详情，不重做 create。
      recordPostCommitWarning('KNOWLEDGE_CREATED_DETAILS_UNAVAILABLE', err);
    }
  }
  return ok(
    {
      ...persistedReview,
      status: 'created',
      id: created.id,
      candidateId: created.id,
      title: created.title,
      lifecycle: created.lifecycle,
      production,
      codeEvidence,
      ...readinessData,
      // 附注不是降级：Core 已完整确认创建，只把需要人工语义复核的事实带给模型与复盘。
      ...(pendingSemanticReview && pendingSemanticReview.length > 0
        ? { pendingSemanticReview: [...pendingSemanticReview] }
        : {}),
    },
    diagnosticWarnings.length > 0 ? { degraded: true, diagnosticWarnings } : undefined
  );
}

/* ================================================================== */
/*  knowledge.submit                                                   */
/* ================================================================== */

const PERSISTED_RECIPE_REVIEW_FIELDS = [
  'description',
  'language',
  'category',
  'tags',
  'kind',
  'knowledgeType',
  'scope',
  'complexity',
  'difficulty',
  'trigger',
  'topicHint',
  'whenClause',
  'doClause',
  'dontClause',
  'coreCode',
  'usageGuide',
  'headers',
  'headerPaths',
  'moduleName',
  'source',
] as const;

// 详情只来自 Core 返回的 raw；创建身份由已确认 wrapper 提供，缺详情不能用模型候选补齐。
// 只投影 reviewer 首屏所需的有界字段，避免为了扫描结果再读库或再次创建。
function projectPersistedRecipeReview(raw: object): Record<string, unknown> {
  const review: Record<string, unknown> = {};
  for (const field of PERSISTED_RECIPE_REVIEW_FIELDS) {
    // Core 的 raw 也可以是实体类；只读取白名单属性，不要求实体伪造字符串索引签名。
    const value: unknown = Reflect.get(raw, field);
    if (value !== undefined) {
      review[field] = Array.isArray(value) ? [...value] : value;
    }
  }
  return review;
}
