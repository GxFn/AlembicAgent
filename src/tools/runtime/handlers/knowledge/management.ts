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
  REVIEW_QUEUE_DEFAULT_LIMIT,
  REVIEW_QUEUE_MAX_LIMIT,
  type ReviewQueueLimitPlan,
  recordValue,
  resolveReviewQueueLimit,
  stringValue,
  validateManagementInput,
} from './input.js';
import {
  abortedKnowledgeResult,
  completedMutationMeta,
  logKnowledgeFallback,
} from './operation.js';

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

/**
 * 缺省/超上限路径的本地排序（L3-P6e，第五轮审计补修）。
 * Core 无界读（findAllByLifecycles 未传 limit）不带 ORDER BY，返回 SQLite 物理行序（rowid）；新库经
 * KnowledgeSyncService 重建时 rowid 跟文件 readdir 顺序走，与时间无关，直接切片会漏掉最先到期的条目。
 * 队列项（Core StagingReviewQueueItem）不含 createdAt，只带 stagingDeadline，所以按它升序排：
 * 复核结论缺失的条目到期照常晋级，最先到期的条目最该先交给宿主复核。
 * deadline 缺失（Core 记 0）或非法的条目排最后——checkAndPromote 对 deadline=0 永远 waiting，不会自动晋级。
 * 同 deadline 按 id 字典序（不用 localeCompare，避免随运行环境 locale 变化），结果不随物理行序抖动。
 * 返回新数组，不改 Core 端口返回的原数组。
 */
function orderByStagingDeadline<T>(queue: readonly T[]): { ordered: T[]; undated: number } {
  let undated = 0;
  const keyed = queue.map((item) => {
    const record = recordValue(item);
    const raw = numberValue(record?.stagingDeadline);
    const dated = raw !== undefined && raw > 0;
    if (!dated) {
      undated += 1;
    }
    return {
      item,
      deadline: dated ? raw : Number.POSITIVE_INFINITY,
      id: typeof record?.id === 'string' ? record.id : '',
    };
  });
  keyed.sort((left, right) => {
    // 两个 Infinity 相减是 NaN，所以逐级比较而不是做减法。
    if (left.deadline !== right.deadline) {
      return left.deadline < right.deadline ? -1 : 1;
    }
    if (left.id !== right.id) {
      return left.id < right.id ? -1 : 1;
    }
    return 0;
  });
  return { ordered: keyed.map((entry) => entry.item), undated };
}

/**
 * review-queue 结果投影（L3-P6d，L3-P6e 修正排序与提示）：显式 limit 在上限内时结构与顺序都与之前一致
 * （{ queue, count }，Core 原样返回）；缺省或超上限时 Core 已做无界读，这里先按 stagingDeadline 排序再按
 * plan.cap 切片。只有真的切掉了条目才新增带内字段（total/truncated/limit/requestedLimit/message），
 * 没切时仍是旧结构，调用方按 truncated 判断即可。
 * status 一律保持 success（截断是契约内行为，不 degraded、不抬升 diagnosticWarnings）；
 * 诊断只走日志：缺省截断记 debug（常规路径），超上限记 warn（调用方输入越过契约上限）。
 * 带内提示只推荐「写回复核结论后再取」：已复核条目在 grace 期内仍留在 staging，但下一次无界读就会被
 * 剔除，所以这条路一定能拿到下一批；显式 limit 由 Core 先取后剔除，可能少返回且不带 total，不作为取更多的做法。
 */
function projectReviewQueueResult<T>(
  plan: ReviewQueueLimitPlan,
  queue: T[]
): Record<string, unknown> {
  if (plan.mode === 'explicit') {
    return { queue, count: queue.length };
  }
  const { ordered, undated } = orderByStagingDeadline(queue);
  const total = ordered.length;
  const truncated = total > plan.cap;
  const kept = truncated ? ordered.slice(0, plan.cap) : ordered;
  const detail = `${plan.mode === 'clamped' ? `requested=${plan.requestedLimit}` : 'limit omitted'}, default=${REVIEW_QUEUE_DEFAULT_LIMIT}, ceiling=${REVIEW_QUEUE_MAX_LIMIT}, total=${total}, returned=${kept.length}, truncated=${truncated}, order=stagingDeadline asc, undated=${undated}`;
  if (plan.mode === 'clamped') {
    // 超上限是调用方越过契约：无论是否真的切掉条目都告警，便于定位把超大 limit 当"全部"用的宿主。
    logKnowledgeFallback(
      'warn',
      `[knowledge.manage] review-queue limit clamped to the ceiling (${detail}): Core read unbounded, result ordered by stagingDeadline and sliced locally${truncated ? ' and annotated in band (total/truncated/limit/requestedLimit/message)' : '; nothing was cut'}`
    );
  } else if (truncated) {
    logKnowledgeFallback(
      'debug',
      `[knowledge.manage] review-queue default limit truncated the queue (${detail}): Core read unbounded, result ordered by stagingDeadline, sliced locally and annotated in band (total/truncated/limit/message)`
    );
  }
  if (!truncated) {
    return { queue: ordered, count: total };
  }
  const drainHint =
    "Record review outcomes for these entries with operation 'review', then call review-queue again";
  const message =
    plan.mode === 'clamped'
      ? `Review queue truncated: returned the ${kept.length} of ${total} pending entries with the earliest staging deadlines (entries without a deadline sort last) because the requested limit ${plan.requestedLimit} exceeds the ceiling ${REVIEW_QUEUE_MAX_LIMIT}. ${drainHint}: reviewed entries drop out of the queue, so the next call returns the next pending ones.`
      : `Review queue truncated: returned the ${kept.length} of ${total} pending entries with the earliest staging deadlines (default limit ${REVIEW_QUEUE_DEFAULT_LIMIT}; entries without a deadline sort last). ${drainHint} without limit: reviewed entries drop out of the queue, so the next call returns the next pending ones. An explicit limit is not a paging tool: Core applies it before excluding reviewed entries, so it can return fewer and carries no total.`;
  return {
    queue: kept,
    count: kept.length,
    total,
    truncated: true,
    limit: plan.cap,
    ...(plan.mode === 'clamped' ? { requestedLimit: plan.requestedLimit } : {}),
    message,
  };
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
    // limit 已由 validateManagementInput 保证缺省或正安全整数；缺省/超上限的归一化规则见 input.ts。
    const plan = resolveReviewQueueLimit(params.limit as number | undefined);
    try {
      // 这是只读端口；取消可结束等待，迟到数据不能再成为本次工具结果。
      const read = await runOperation(() => stagingManager.listReviewQueue(plan.coreLimit), {
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
      return ok(projectReviewQueueResult(plan, read.value));
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
        // validate 是只读端口；与 update/reject/score 的真实写回执等待分开处理。
        const read = await runOperation(() => method.call(management, id), {
          abortSignal: ctx.abortSignal,
        });
        const aborted = abortedKnowledgeResult(ctx, 'manage(validate)');
        if (aborted) {
          return aborted;
        }
        if (read.status !== 'ok') {
          throw read.error instanceof Error
            ? read.error
            : new Error(String(read.error ?? `Knowledge validation ${read.status}`));
        }
        return ok({ operation, id, status: 'validated', result: read.value });
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

  // confidence 优先级：data > params > 按操作代填。代填值会直接决定 Core EvolutionPolicy 的
  // 初始状态（update ≥0.7 即进入 observing；非 metabolism 的 deprecate ≥0.8 会立即执行），
  // 因此代填必须留日志，并在提案 evidence 中标记 confidenceDefaulted，供审计区分"模型判断"与
  // "Agent 代填"。默认值本身（evolve/skip_evolution 0.9、deprecate 0.7）是产品决策，此处不调整。
  const explicitConfidence = numberValue(data?.confidence) ?? numberValue(params.confidence);
  const confidenceDefaulted = explicitConfidence === undefined;
  const confidence = explicitConfidence ?? (operation === 'deprecate' ? 0.7 : 0.9);
  if (confidenceDefaulted) {
    logKnowledgeFallback(
      'info',
      `[knowledge.manage] evolution confidence defaulted (operation=${operation}, id=${id}, confidence=${confidence}): neither data.confidence nor params.confidence was supplied; proposal evidence marked confidenceDefaulted=true`
    );
  }
  const source = resolveEvolutionSource(ctx, operation, id);
  const description =
    stringValue(data?.description) ??
    stringValue(params.description) ??
    reason ??
    defaultEvolutionDescription(operation);
  const evidence = buildEvolutionEvidence(data, params, confidenceDefaulted);

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

/** 只渲染可安全写入日志的原值：字符串加引号（暴露首尾空白）并截断，对象类只记类型。 */
function describeRawSource(raw: unknown): string {
  if (typeof raw === 'string') {
    return JSON.stringify(raw.length > 80 ? `${raw.slice(0, 80)}...` : raw);
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  return `<${typeof raw}>`;
}

function resolveEvolutionSource(
  ctx: ToolContext,
  operation: 'evolve' | 'deprecate' | 'skip_evolution',
  id: string
): EvolutionProposalSource {
  const raw = ctx.runtime?.sharedState?.evolutionProposalSource;
  if (typeof raw === 'string' && EVOLUTION_SOURCES.has(raw as EvolutionProposalSource)) {
    return raw as EvolutionProposalSource;
  }
  // 未设置（undefined/null）是常规路径：Agent 自身发起的提案默认归属 alembic-agent，不告警。
  // 宿主显式给了非法值（如带空格的 'metabolism '）时回落会丢失该来源在 Core 的专属策略
  // （metabolism 的 deprecate 不立即执行），必须告警；回落值本身保持不变。
  if (raw !== undefined && raw !== null) {
    logKnowledgeFallback(
      'warn',
      `[knowledge.manage] evolution proposal source fallback (operation=${operation}, id=${id}, raw=${describeRawSource(raw)}, fallback=${AGENT_RUNTIME_SOURCE}): sharedState.evolutionProposalSource is not a recognised proposal source`
    );
  }
  return AGENT_RUNTIME_SOURCE;
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
  params: Record<string, unknown>,
  confidenceDefaulted: boolean
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
  // 代填标记并入 Agent 侧 inline 记录，不额外新增一条 evidence；无 inline 字段时它单独成条。
  if (confidenceDefaulted) {
    inline.confidenceDefaulted = true;
  }
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
