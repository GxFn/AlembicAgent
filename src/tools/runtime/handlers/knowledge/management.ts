/** 知识生命周期管理与 evolution proposal 适配；激活仍由 Core publish 再验证。 */
import { runOperation } from '#shared/operation.js';
import { fail, ok, type ToolContext, type ToolResult } from '#tools/kernel/registry.js';
import {
  AGENT_RUNTIME_SOURCE,
  type KnowledgeRepoLike,
  LEGACY_IDE_AGENT_SOURCE,
  type RecipeGatewayLike,
} from './contracts.js';
import { numberValue, pickString, recordValue, stringValue } from './input.js';
import { abortedKnowledgeResult, completedMutationMeta } from './operation.js';

/* ================================================================== */
/*  knowledge.manage                                                   */
/* ================================================================== */

type ManageOperation =
  | 'approve'
  | 'reject'
  | 'publish'
  | 'deprecate'
  | 'update'
  | 'score'
  | 'validate'
  | 'evolve'
  | 'skip_evolution'
  | 'review'
  | 'review-queue';

const VALID_OPERATIONS = new Set<ManageOperation>([
  'approve',
  'reject',
  'publish',
  'deprecate',
  'update',
  'score',
  'validate',
  'evolve',
  'skip_evolution',
  'review',
  'review-queue',
]);

type EvolutionProposalSource =
  | typeof AGENT_RUNTIME_SOURCE
  | typeof LEGACY_IDE_AGENT_SOURCE
  | 'metabolism'
  | 'decay-scan'
  | 'consolidation'
  | 'relevance-audit'
  | 'file-change'
  | 'rescan-evolution';

type EvolutionAction = 'update' | 'deprecate' | 'valid';

interface ProposalGatewayLike {
  submit(decision: {
    recipeId: string;
    action: EvolutionAction;
    source: EvolutionProposalSource;
    confidence: number;
    description?: string;
    evidence?: Record<string, unknown>[];
    reason?: string;
    replacedByRecipeId?: string;
  }): Promise<{
    recipeId: string;
    action: EvolutionAction;
    outcome: string;
    proposalId?: string;
    error?: string;
  }>;
}

const EVOLUTION_SOURCES = new Set<EvolutionProposalSource>([
  AGENT_RUNTIME_SOURCE,
  LEGACY_IDE_AGENT_SOURCE,
  'metabolism',
  'decay-scan',
  'consolidation',
  'relevance-audit',
  'file-change',
  'rescan-evolution',
]);

async function handleActiveTransition(
  operation: 'approve' | 'publish',
  id: string,
  ctx: ToolContext
): Promise<ToolResult> {
  const gateway = ctx.recipeGateway as RecipeGatewayLike | undefined;
  if (!gateway) {
    return fail('Recipe production port not available for active transition');
  }

  try {
    // Core readiness is both exposed as structured tool evidence here and rechecked by
    // RecipeProductionPort.publish at the authoritative mutation boundary.
    const read = await runOperation(() => gateway.evaluateReadiness(id), {
      abortSignal: ctx.abortSignal,
    });
    const aborted = abortedKnowledgeResult(ctx, `manage(${operation}) readiness`);
    if (aborted) {
      return aborted;
    }
    if (read.status !== 'ok') {
      throw read.error instanceof Error ? read.error : new Error(`Core readiness ${read.status}`);
    }
    const readiness = read.value;
    if (!readiness.ready) {
      const message = `Core readiness blocked knowledge.manage(${operation})`;
      return {
        ok: false,
        data: {
          operation,
          id,
          status: 'readiness-blocked',
          lifecycle: 'unchanged',
          reason: 'core-readiness-blocked',
          message,
          readiness,
        },
        error: message,
      };
    }

    const published = await gateway.publish(id, {
      userId: pickString(ctx.runtime?.agentId) ?? AGENT_RUNTIME_SOURCE,
    });
    return ok(
      {
        operation,
        id,
        status: operation === 'approve' ? 'approved' : 'published',
        lifecycle: published.lifecycle,
        record: published,
        readiness,
      },
      completedMutationMeta(ctx, `manage(${operation})`)
    );
  } catch (err: unknown) {
    const errorRecord = recordValue(err);
    const details = recordValue(errorRecord?.details);
    const readiness = recordValue(details?.readiness);
    const readinessBlocked = readiness?.ready === false;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      data: {
        operation,
        id,
        status: readinessBlocked ? 'readiness-blocked' : 'publish-failed',
        lifecycle: 'unchanged',
        reason: readinessBlocked ? 'core-readiness-blocked' : 'core-publish-failed',
        message,
        ...(typeof errorRecord?.code === 'string' ? { code: errorRecord.code } : {}),
        ...(readiness ? { readiness } : {}),
      },
      error: `Manage(${operation}) failed through Core production port: ${message}`,
    };
  }
}

export async function handleManage(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const operation = params.operation as string;
  const id = params.id as string;

  if (!operation || !VALID_OPERATIONS.has(operation as ManageOperation)) {
    return fail(`Invalid operation: ${operation}. Valid: ${[...VALID_OPERATIONS].join(', ')}`);
  }

  // staging 复核队列（Option A：宿主 LLM 按需复核的只读读面）。列表操作，无需 id——须在下方
  // id 必填校验之前处理。返回 staging 中待复核条目及其「断言 vs 源码」所需内容（断言四要素 +
  // reasoning.sources 引用位置）；宿主据此读源码对比，再经 operation='review' 写回结论。
  if (operation === 'review-queue') {
    const stagingManager = ctx.stagingManager as {
      listReviewQueue?(limit?: number): Promise<
        Array<{
          id: string;
          title: string;
          whenClause: string;
          doClause: string;
          dontClause: string;
          coreCode: string;
          sources: string[];
          stagingDeadline: number;
        }>
      >;
    } | null;
    if (!stagingManager || typeof stagingManager.listReviewQueue !== 'function') {
      return fail('Staging manager not available');
    }
    const limitRaw = params.limit;
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : undefined;
    const queue = await stagingManager.listReviewQueue(limit);
    const aborted = abortedKnowledgeResult(ctx, 'manage(review-queue)');
    if (aborted) {
      return aborted;
    }
    return ok({ queue, count: queue.length });
  }

  if (!id) {
    return fail('knowledge.manage requires id');
  }

  const reason = stringValue(params.reason);
  const data = recordValue(params.data);

  if (operation === 'evolve' || operation === 'deprecate' || operation === 'skip_evolution') {
    return handleEvolutionManage(operation, id, reason, data, params, ctx);
  }

  // staging 复核通道（2026-07-06 复核期落地）：AI/程序化复核者把"断言 vs 源码"
  // 结论写回 StagingManager（fail=到期回滚不晋级；pass/缺失=现状晋级）。
  if (operation === 'review') {
    const stagingManager = ctx.stagingManager as {
      recordReview(
        entryId: string,
        review: { outcome: 'pass' | 'fail'; reviewer?: string; notes?: string }
      ): Promise<boolean>;
    } | null;
    if (!stagingManager || typeof stagingManager.recordReview !== 'function') {
      return fail('Staging manager not available');
    }
    const outcome = stringValue(params.outcome);
    if (outcome !== 'pass' && outcome !== 'fail') {
      return fail("knowledge.manage review requires outcome: 'pass' | 'fail'");
    }
    const recorded = await stagingManager.recordReview(id, {
      outcome,
      reviewer: stringValue(params.reviewer) ?? 'in-process-agent',
      ...(reason ? { notes: reason } : {}),
    });
    if (!recorded) {
      return fail(`Staging review rejected: entry ${id} is not in staging`);
    }
    return ok({ id, outcome, recorded: true }, completedMutationMeta(ctx, 'manage(review)'));
  }

  if (operation === 'approve' || operation === 'publish') {
    return handleActiveTransition(operation, id, ctx);
  }

  const repo = ctx.knowledgeRepo as KnowledgeRepoLike | undefined;
  if (!repo) {
    return fail('Knowledge repository not available');
  }

  try {
    switch (operation) {
      case 'reject':
        await repo.reject(id, reason ?? 'Rejected by agent');
        return ok(
          { operation, id, status: 'rejected' },
          completedMutationMeta(ctx, 'manage(reject)')
        );

      case 'update':
        if (!data) {
          return fail('knowledge.manage(update) requires data');
        }
        await repo.update(id, data);
        return ok(
          { operation, id, status: 'updated' },
          completedMutationMeta(ctx, 'manage(update)')
        );

      case 'score': {
        const score = (data?.score as number) ?? 0;
        await repo.score(id, score);
        return ok(
          { operation, id, status: 'scored', score },
          completedMutationMeta(ctx, 'manage(score)')
        );
      }

      case 'validate': {
        const validation = await repo.validate(id);
        const aborted = abortedKnowledgeResult(ctx, 'manage(validate)');
        if (aborted) {
          return aborted;
        }
        return ok({ operation, id, status: 'validated', result: validation });
      }

      default:
        return fail(`Unhandled operation: ${operation}`);
    }
  } catch (err: unknown) {
    return fail(`Manage(${operation}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleEvolutionManage(
  operation: 'evolve' | 'deprecate' | 'skip_evolution',
  id: string,
  reason: string | undefined,
  data: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const gateway = ctx.proposalGateway as ProposalGatewayLike | undefined;
  if (!gateway?.submit) {
    return fail('Evolution gateway not available');
  }

  const confidence =
    numberValue(data?.confidence) ??
    numberValue(params.confidence) ??
    (operation === 'deprecate' ? 0.7 : 0.9);
  const source = resolveEvolutionSource(ctx);
  const description =
    stringValue(data?.description) ??
    stringValue(params.description) ??
    reason ??
    defaultEvolutionDescription(operation);
  const evidence = buildEvolutionEvidence(data, params);

  const action: EvolutionAction =
    operation === 'evolve' ? 'update' : operation === 'deprecate' ? 'deprecate' : 'valid';

  try {
    const result = await gateway.submit({
      recipeId: id,
      action,
      source,
      confidence,
      description,
      evidence,
      reason,
      replacedByRecipeId:
        stringValue(data?.replacedByRecipeId) ??
        stringValue(params.replacedByRecipeId) ??
        stringValue(data?.supersedes) ??
        stringValue(params.supersedes),
    });

    if (result.outcome === 'error') {
      return fail(result.error || `Evolution ${operation} failed`);
    }

    return ok(
      {
        operation,
        id,
        status: evolutionStatus(operation, result.outcome),
        outcome: result.outcome,
        proposalId: result.proposalId,
      },
      completedMutationMeta(ctx, `manage(${operation})`)
    );
  } catch (err: unknown) {
    return fail(`Manage(${operation}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveEvolutionSource(ctx: ToolContext): EvolutionProposalSource {
  const raw = ctx.runtime?.sharedState?.evolutionProposalSource;
  return typeof raw === 'string' && EVOLUTION_SOURCES.has(raw as EvolutionProposalSource)
    ? (raw as EvolutionProposalSource)
    : AGENT_RUNTIME_SOURCE;
}

function defaultEvolutionDescription(operation: 'evolve' | 'deprecate' | 'skip_evolution') {
  if (operation === 'evolve') {
    return 'Evolution Agent proposed an update based on code verification';
  }
  if (operation === 'deprecate') {
    return 'Evolution Agent confirmed the recipe is outdated';
  }
  return 'Evolution Agent verified the recipe remains valid or needs no change';
}

function evolutionStatus(
  operation: 'evolve' | 'deprecate' | 'skip_evolution',
  outcome: string
): string {
  if (operation === 'skip_evolution') {
    return outcome === 'verified' ? 'evolution_verified' : 'evolution_skipped';
  }
  if (operation === 'deprecate') {
    return outcome === 'immediately-executed' ? 'deprecated' : 'deprecation_proposed';
  }
  return outcome === 'proposal-upgraded' ? 'evolution_proposal_upgraded' : 'evolution_proposed';
}

function buildEvolutionEvidence(
  data: Record<string, unknown> | undefined,
  params: Record<string, unknown>
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const rawEvidence = data?.evidence ?? params.evidence;
  if (Array.isArray(rawEvidence)) {
    for (const item of rawEvidence) {
      const record = recordValue(item);
      if (record) {
        records.push(record);
      }
    }
  } else {
    const record = recordValue(rawEvidence);
    if (record) {
      records.push(record);
    }
  }

  const inline = collectInlineEvidence(data, params);
  if (Object.keys(inline).length > 0) {
    records.push(inline);
  }
  return records;
}

function collectInlineEvidence(
  data: Record<string, unknown> | undefined,
  params: Record<string, unknown>
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of [
    'type',
    'sourceStatus',
    'currentCode',
    'newLocation',
    'suggestedChanges',
    'confidence',
  ]) {
    const value = data?.[key] ?? params[key];
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}
