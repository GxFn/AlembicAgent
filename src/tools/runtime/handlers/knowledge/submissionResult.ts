/** Core 确认创建后的只读 readiness 与会话投影；附加失败不能抹掉持久化回执。 */
import Logger from '@alembic/core/logging';
import { runOperation } from '#shared/operation.js';
import {
  ok,
  type ToolContext,
  type ToolDiagnosticWarning,
  type ToolResult,
} from '#tools/kernel/registry.js';
import type { PreparedRecipeProductionItem } from '../recipeProductionAdapter.js';
import type { RecipeGatewayLike } from './contracts.js';
import { sessionCounterBox } from './sessionState.js';

type ProductionResult = Awaited<ReturnType<RecipeGatewayLike['createOrStage']>>;
interface CreatedSubmission {
  created: ProductionResult['created'][number];
  production: ProductionResult['production'];
  codeEvidence: PreparedRecipeProductionItem['codeEvidence'];
  item: Readonly<{ title: string; kind: string }>;
}

/** 这里只接收已确认的回执与 readiness 读口，没有创建或发布候选的权限。 */
export async function completeCreatedSubmission(
  { created, production, codeEvidence, item }: CreatedSubmission,
  gateway: Pick<RecipeGatewayLike, 'evaluateReadiness'>,
  ctx: Pick<ToolContext, 'abortSignal' | 'runtime' | 'sessionStore'>
): Promise<ToolResult> {
  // Core 已确认持久化：后续读取/会话记录失败只能降级诊断，不能抹掉身份或诱发再次 create。
  const diagnosticWarnings: ToolDiagnosticWarning[] = [];
  const recordPostCommitWarning = (code: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    diagnosticWarnings.push({ code, message, stage: 'knowledge.submit', tool: 'knowledge' });
    Logger.getInstance().warn(`[knowledge.submit] persisted ${created.id}; ${code}: ${message}`);
  };
  let readiness: Awaited<ReturnType<RecipeGatewayLike['evaluateReadiness']>> | undefined;
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
        Logger.getInstance().warn(
          `[knowledge.submit] candidate persisted as ${created.lifecycle} with Core readiness violations for "${String(item.title ?? '')}": ${readiness.violations.map((violation) => violation.code).join(', ')}`
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
  const persistedReview = created.raw == null ? {} : projectPersistedRecipeReview(created.raw);
  if (created.raw == null) {
    recordPostCommitWarning(
      'KNOWLEDGE_CREATED_DETAILS_UNAVAILABLE',
      new Error(
        'Core confirmed the created identity but returned no persisted details; keep the identity and read back details without creating again'
      )
    );
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
