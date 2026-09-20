/** 知识生命周期管理与 evolution proposal 适配；激活仍由 Core publish 再验证。 */
import type {
  EvolutionDecision,
  EvolutionResult,
  ProposalGateway,
  StagingManager,
} from '@alembic/core/sustain';
import { runOperation } from '#shared/operation.js';
import { fail, ok, type ToolContext, type ToolResult } from '#tools/kernel/registry.js';
import {
  AGENT_RUNTIME_SOURCE,
  LEGACY_IDE_AGENT_SOURCE,
  type RecipeGatewayLike,
} from './contracts.js';
import {
  numberValue,
  pickString,
  recordValue,
  stringValue,
  validateManagementInput,
} from './input.js';
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

type EvolutionProposalSource = EvolutionDecision['source'];
type EvolutionAction = EvolutionDecision['action'];
type ProposalGatewayLike = Pick<ProposalGateway, 'submit'>;
type StagingReviewPort = Pick<StagingManager, 'listReviewQueue' | 'recordReview'>;

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

function unavailableManagementPort(
  operation: string,
  port:
    | 'knowledgeManagement'
    | 'knowledgeRepo'
    | 'recipeGateway'
    | 'stagingManager'
    | 'proposalGateway',
  method: string,
  id?: string
): ToolResult {
  const labels = {
    knowledgeManagement: 'Knowledge management port',
    knowledgeRepo: 'Knowledge repository',
    recipeGateway: 'Recipe production port',
    stagingManager: 'Staging manager',
    proposalGateway: 'Evolution gateway',
  };
  return {
    ok: false,
    data: {
      operation,
      ...(id ? { id } : {}),
      status: 'port-unavailable',
      code: 'KNOWLEDGE_MANAGEMENT_PORT_UNAVAILABLE',
      port,
      method,
    },
    error: `${labels[port]} not available for ${operation} (${method})`,
  };
}

/** 只投影 Core 已给出的写入事实；异常不等于回滚，原始 details 留给宿主读回/修复。 */
function managementFailure(
  operation: string,
  id: string | undefined,
  err: unknown,
  writeStarted: boolean
): ToolResult {
  const errorRecord = recordValue(err);
  const details = recordValue(errorRecord?.details);
  const code =
    typeof errorRecord?.code === 'string' ? errorRecord.code : 'KNOWLEDGE_MANAGEMENT_FAILED';
  const partial = code === 'STATE_DIVERGENCE' || (numberValue(details?.fileOpsCompleted) ?? 0) > 0;
  const readiness = recordValue(details?.readiness);
  const readinessBlocked = !partial && readiness?.ready === false;
  const requiresReadback = partial || (writeStarted && !readinessBlocked);
  const activeTransition = operation === 'approve' || operation === 'publish';
  const message = err instanceof Error ? err.message : String(err);
  const data = {
    operation,
    ...(id ? { id } : {}),
    status: activeTransition
      ? readinessBlocked
        ? 'readiness-blocked'
        : 'publish-failed'
      : 'failed',
    code,
    message,
    writeState: partial ? 'partial' : requiresReadback ? 'unknown' : 'not-started',
    requiresReadback,
    ...(activeTransition
      ? {
          lifecycle: requiresReadback ? 'unknown' : 'unchanged',
          reason: readinessBlocked ? 'core-readiness-blocked' : 'core-publish-failed',
        }
      : {}),
    ...(details ? { details } : {}),
    ...(readiness ? { readiness } : {}),
  };
  return {
    ...ok(
      data,
      requiresReadback
        ? {
            degraded: true,
            diagnosticWarnings: [
              { code, message, stage: `knowledge.manage(${operation})`, tool: 'knowledge' },
            ],
          }
        : undefined
    ),
    ok: false,
    error: `Manage(${operation}) failed${activeTransition ? ' through Core production port' : ''}: ${message}`,
  };
}

async function handleActiveTransition(
  operation: 'approve' | 'publish',
  id: string,
  ctx: ToolContext
): Promise<ToolResult> {
  const gateway = ctx.recipeGateway as RecipeGatewayLike | undefined;
  if (typeof gateway?.evaluateReadiness !== 'function') {
    return unavailableManagementPort(operation, 'recipeGateway', 'evaluateReadiness', id);
  }
  if (typeof gateway.publish !== 'function') {
    return unavailableManagementPort(operation, 'recipeGateway', 'publish', id);
  }

  let writeStarted = false;
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

    writeStarted = true;
    const published = await gateway.publish(id, {
      userId: pickString(ctx.runtime?.agentId) ?? AGENT_RUNTIME_SOURCE,
    });
    if (published === null) {
      // Core 允许写后读回为空；写入已经发出，缺回执不能推断未写，也不能自动重试。
      throw Object.assign(
        new Error(
          'Core publish returned no confirmation receipt; read back the write outcome before retrying'
        ),
        {
          code: 'KNOWLEDGE_WRITE_RECEIPT_UNAVAILABLE',
          details: {
            operation,
            id,
            coreReceipt: null,
            writeState: 'unknown',
            requiresReadback: true,
            retryable: false,
          },
        }
      );
    }
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
    return managementFailure(operation, id, err, writeStarted);
  }
}

export async function handleManage(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const operation = params.operation as string;
  const id = pickString(params.id);

  if (!operation || !VALID_OPERATIONS.has(operation as ManageOperation)) {
    return fail(`Invalid operation: ${operation}. Valid: ${[...VALID_OPERATIONS].join(', ')}`);
  }
  const validationError = validateManagementInput(params);
  if (validationError) {
    return fail(`Validation failed: ${validationError}`);
  }

  // staging 复核队列（Option A：宿主 LLM 按需复核的只读读面）。列表操作，无需 id——须在下方
  // id 必填校验之前处理。返回 staging 中待复核条目及其「断言 vs 源码」所需内容（断言四要素 +
  // reasoning.sources 引用位置）；宿主据此读源码对比，再经 operation='review' 写回结论。
  if (operation === 'review-queue') {
    const stagingManager = ctx.stagingManager as StagingReviewPort | null;
    if (!stagingManager || typeof stagingManager.listReviewQueue !== 'function') {
      return unavailableManagementPort(operation, 'stagingManager', 'listReviewQueue');
    }
    const limit = params.limit as number | undefined;
    try {
      // 这是只读端口；取消可结束等待，迟到数据不能再成为本次工具结果。
      const read = await runOperation(() => stagingManager.listReviewQueue(limit), {
        abortSignal: ctx.abortSignal,
      });
      const aborted = abortedKnowledgeResult(ctx, 'manage(review-queue)');
      if (aborted) {
        return aborted;
      }
      if (read.status !== 'ok') {
        return managementFailure(
          operation,
          undefined,
          read.error ?? new Error(`Review queue ${read.status}`),
          false
        );
      }
      return ok({ queue: read.value, count: read.value.length });
    } catch (err: unknown) {
      return managementFailure(operation, undefined, err, false);
    }
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
    const stagingManager = ctx.stagingManager as StagingReviewPort | null;
    if (!stagingManager || typeof stagingManager.recordReview !== 'function') {
      return unavailableManagementPort(operation, 'stagingManager', 'recordReview', id);
    }
    const outcome = stringValue(params.outcome);
    if (outcome !== 'pass' && outcome !== 'fail') {
      return fail("knowledge.manage review requires outcome: 'pass' | 'fail'");
    }
    try {
      // 无 signal 的写入一旦启动，继续等待真实回执；取消不能被解释成回滚。
      const recorded = await stagingManager.recordReview(id, {
        outcome,
        reviewer: stringValue(params.reviewer) ?? 'in-process-agent',
        ...(reason ? { notes: reason } : {}),
      });
      if (!recorded) {
        return fail(`Staging review rejected: entry ${id} is not in staging`);
      }
      return ok({ id, outcome, recorded: true }, completedMutationMeta(ctx, 'manage(review)'));
    } catch (err: unknown) {
      return managementFailure(operation, id, err, true);
    }
  }

  if (operation === 'approve' || operation === 'publish') {
    return handleActiveTransition(operation, id, ctx);
  }

  // 显式端口是宿主能力边界。仅未提供时兼容旧字段，缺方法不能回落原始仓储。
  const port = ctx.knowledgeManagement !== undefined ? 'knowledgeManagement' : 'knowledgeRepo';
  const management = ctx[port];
  const method = recordValue(management)?.[operation];
  if (typeof method !== 'function') {
    return unavailableManagementPort(operation, port, operation, id);
  }

  try {
    switch (operation) {
      case 'reject':
        await method.call(management, id, reason ?? 'Rejected by agent');
        return ok(
          { operation, id, status: 'rejected' },
          completedMutationMeta(ctx, 'manage(reject)')
        );

      case 'update':
        if (!data) {
          return fail('knowledge.manage(update) requires data');
        }
        await method.call(management, id, data);
        return ok(
          { operation, id, status: 'updated' },
          completedMutationMeta(ctx, 'manage(update)')
        );

      case 'score': {
        const score = data?.score as number;
        await method.call(management, id, score);
        return ok(
          { operation, id, status: 'scored', score },
          completedMutationMeta(ctx, 'manage(score)')
        );
      }

      case 'validate': {
        const validation = await method.call(management, id);
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
    return managementFailure(operation, id, err, operation !== 'validate');
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
  if (typeof gateway?.submit !== 'function') {
    return unavailableManagementPort(operation, 'proposalGateway', 'submit', id);
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
      return managementFailure(
        operation,
        id,
        new Error(result.error || `Evolution ${operation} failed`),
        true
      );
    }

    return ok(
      {
        operation,
        id,
        status: evolutionStatus(operation, result.outcome),
        outcome: result.outcome,
        proposalId: result.proposalId,
        ...(result.error ? { reason: result.error } : {}),
      },
      completedMutationMeta(ctx, `manage(${operation})`)
    );
  } catch (err: unknown) {
    return managementFailure(operation, id, err, true);
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
  outcome: EvolutionResult['outcome']
): string {
  // skipped 是 Core 确认的无新写入结果；不能靠兼容 status 再提升成 proposal 成功。
  if (outcome === 'skipped') {
    return operation === 'deprecate' ? 'deprecation_skipped' : 'evolution_skipped';
  }
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
