import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { createLimit } from '../../shared/concurrency.js';
import type {
  AgentConcurrencyPlan,
  AgentProfileOverride,
  AgentProfileRef,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  CompiledAgentProfile,
} from '../service/AgentRunContracts.js';

type ChildRunner = (input: AgentRunInput) => Promise<AgentRunResult>;
type Partitioner = (input: AgentRunInput, profile: CompiledAgentProfile) => AgentRunInput[];
type Merger = (
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile
) => AgentRunResult;
type ChildRunRecord = { childInput: AgentRunInput; result: AgentRunResult };

/**
 * 停止事实的来源。tier 整批取消与 child 跳过都要带上它，宿主才能区分：
 * - abortSignal / shouldAbort：用户或宿主主动取消，属于正常收尾；
 * - prior-failure：兄弟 child 的回调（检查点等）或取消探针已失败，后续不再派发；
 * - shouldAbort-error：tier 级取消探针自身抛错，按失败处理并整批取消。
 */
type CoordinationStopReason = 'abortSignal' | 'shouldAbort' | 'prior-failure' | 'shouldAbort-error';

/**
 * 生效并发度及其来源。env 非法时静默回退 default 曾经没有任何痕迹（I21），
 * 这里把“来源 + 回退原因 + 原始值”一起带出来供日志使用；返回的 value 与旧逻辑完全一致。
 */
type ConcurrencyResolution = {
  value: number;
  source: 'number' | 'env' | 'default';
  env?: string;
  rawValue?: string;
  fallbackReason?: 'env-unset' | 'env-invalid' | 'plan-unset';
};

const LOG_PREFIX = '[AgentRunCoordinator]';
/** env 原始值只用于诊断，截断避免把异常长的配置串整段写进日志。 */
const MAX_LOGGED_ENV_VALUE_LENGTH = 32;

export class AgentRunCoordinator {
  #partitioners = new Map<string, Partitioner>();
  #mergers = new Map<string, Merger>();

  constructor() {
    this.registerPartitioner('generateSessionDimensions', partitionBootstrapSessionDimensions);
    this.registerMerger('generateSessionResults', mergeBootstrapSessionResults);
    this.registerPartitioner('projectContextModules', partitionProjectIndexScopedModules);
    this.registerMerger('moduleMiningResults', mergeProjectIndexScopedModuleResults);
  }

  registerPartitioner(name: string, partitioner: Partitioner) {
    this.#partitioners.set(name, partitioner);
    return this;
  }

  registerMerger(name: string, merger: Merger) {
    this.#mergers.set(name, merger);
    return this;
  }

  canCoordinate(profile: CompiledAgentProfile) {
    return !!profile.concurrency && profile.concurrency.mode !== 'none';
  }

  async run(input: AgentRunInput, profile: CompiledAgentProfile, runChild: ChildRunner) {
    if (!profile.concurrency || profile.concurrency.mode === 'none') {
      return null;
    }
    const partitionerName = profile.concurrency.partitioner;
    if (!partitionerName) {
      throw new Error(`Agent profile "${profile.id}" concurrency plan requires partitioner`);
    }
    const partitioner = this.#partitioners.get(partitionerName);
    if (!partitioner) {
      throw new Error(`Unknown agent run partitioner: "${partitionerName}"`);
    }
    const mergeName = profile.concurrency.merge;
    const merger = mergeName ? this.#mergers.get(mergeName) : null;
    if (mergeName && !merger) {
      throw new Error(`Unknown agent run merger: "${mergeName}"`);
    }
    const childInputs = partitioner(input, profile);
    const childResults = await runChildren(
      childInputs,
      profile.concurrency,
      runChild,
      input,
      profile
    );

    return merger ? merger(childResults, input, profile) : defaultMerge(childResults, profile);
  }
}

async function runChildren(
  childInputs: AgentRunInput[],
  concurrencyPlan: AgentConcurrencyPlan,
  runChild: ChildRunner,
  parentInput: AgentRunInput,
  profile: CompiledAgentProfile
) {
  const startedAt = Date.now();
  const tiered = concurrencyPlan.mode === 'tiered';
  const concurrency = resolveConcurrency(concurrencyPlan.concurrency);
  if (concurrency.fallbackReason === 'env-invalid') {
    // env 存在但不是正整数：沿用旧行为回退 default，但必须留下 warn，否则宿主日志里的并发度与实际不符。
    logCoordination(
      'warn',
      `concurrency env invalid, falling back to default profile=${profile.id} env=${concurrency.env} fallback=${concurrency.value}`,
      {
        profileId: profile.id,
        env: concurrency.env,
        rawValue: concurrency.rawValue,
        fallback: concurrency.value,
      }
    );
  }
  const limit = createLimit(concurrency.value);
  const tiers = tiered ? groupByTier(childInputs) : [childInputs.map((_, index) => index)];
  // child → tierIndex 只用于日志定位；parallel 模式没有 tier 语义，不记录 tierIndex。
  const tierIndexByChild = new Map<number, number>();
  if (tiered) {
    for (const [tierIndex, tier] of tiers.entries()) {
      for (const index of tier) {
        tierIndexByChild.set(index, tierIndex);
      }
    }
  }
  const describeChild = (input: AgentRunInput, index: number) => {
    const dimId = resolveDimensionId(input);
    const tierIndex = tierIndexByChild.get(index);
    return {
      childIndex: index,
      childId: resolveChildLogId(input, index),
      ...(dimId ? { dimId } : {}),
      ...(tierIndex !== undefined ? { tierIndex } : {}),
    };
  };
  logCoordination(
    'info',
    `coordination start profile=${profile.id} mode=${concurrencyPlan.mode} children=${childInputs.length} concurrency=${concurrency.value}(${concurrency.source})`,
    {
      profileId: profile.id,
      mode: concurrencyPlan.mode,
      partitioner: concurrencyPlan.partitioner || null,
      merge: concurrencyPlan.merge || null,
      childCount: childInputs.length,
      concurrency: concurrency.value,
      concurrencySource: concurrency.source,
      ...(concurrency.env ? { concurrencyEnv: concurrency.env } : {}),
      ...(concurrency.rawValue !== undefined ? { concurrencyEnvValue: concurrency.rawValue } : {}),
      ...(concurrency.fallbackReason
        ? { concurrencyFallbackReason: concurrency.fallbackReason }
        : {}),
      ...(tiered
        ? {
            tierCount: tiers.length,
            tierSizes: tiers.map((tier) => ({
              tier: resolveTier(childInputs[tier[0]]),
              childCount: tier.length,
            })),
          }
        : {}),
    }
  );
  const records: ChildRunRecord[] = [];
  const failures: Array<{ hook: string; childId?: string; tierIndex?: number; message: string }> =
    [];
  // 被跳过（未派发）的 child 下标，只用于最终汇总日志；按下标排序输出，避免并发时序导致日志顺序不稳定。
  const skippedChildren = new Set<number>();
  let firstError: unknown;
  const fail = (
    hook: string,
    err: unknown,
    details: { childId?: string; tierIndex?: number } = {},
    logContext: Record<string, unknown> = {}
  ) => {
    if (failures.length === 0) {
      firstError = err;
    }
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ hook, ...details, message });
    // 回调/取消探针失败会让后续 child 全部按 prior-failure 跳过；这里是整条连带取消的根因，必须 warn。
    // coordinationFailures 的 childId 只认 dimId（契约不变）；日志标识优先用 logContext（含 moduleId/下标回退）。
    const childLabel =
      typeof logContext.childId === 'string' ? logContext.childId : details.childId;
    logCoordination(
      'warn',
      `coordination hook failed profile=${profile.id} hook=${hook}${childLabel ? ` child=${childLabel}` : ''}${details.tierIndex !== undefined ? ` tier=${details.tierIndex}` : ''}`,
      {
        profileId: profile.id,
        hook,
        ...logContext,
        ...stripUndefined(details),
        error: message,
      }
    );
  };
  const logChildSkipped = (input: AgentRunInput, index: number, reason: CoordinationStopReason) => {
    skippedChildren.add(index);
    const child = describeChild(input, index);
    logCoordination(
      isFailureStopReason(reason) ? 'warn' : 'info',
      `child skipped profile=${profile.id} child=${child.childId} reason=${reason}`,
      { profileId: profile.id, ...child, reason }
    );
  };
  const runOneChild = async (
    index: number,
    forcedStop?: CoordinationStopReason
  ): Promise<ChildRunRecord> => {
    const planned = childInputs[index];
    let childInput = planned;
    let result: AgentRunResult;
    let started = false;
    // 回调可能保存检查点，失败后不能重试它或继续派发尚未开始的子任务。
    if (forcedStop || failures.length > 0) {
      result = createChildAbortedResult(childInput);
      logChildSkipped(childInput, index, forcedStop ?? 'prior-failure');
    } else {
      try {
        const preStop =
          (await resolveAbortReason(parentInput)) ?? (failures.length > 0 ? 'prior-failure' : null);
        if (preStop) {
          result = createChildAbortedResult(childInput);
          logChildSkipped(childInput, index, preStop);
        } else {
          childInput = await resolveLazyChildInput(planned, parentInput);
          // shouldAbort/懒构造均可挂起；恢复后必须重新读取停止事实，不能用 await 前的值。
          const stop =
            (await resolveAbortReason(parentInput)) ??
            (failures.length > 0 ? 'prior-failure' : null);
          if (stop) {
            result = createChildAbortedResult(childInput);
            logChildSkipped(childInput, index, stop);
          } else {
            started = true;
            result = await runChild(childInput);
          }
        }
      } catch (err: unknown) {
        result = createChildErrorResult(childInput, err);
        // pre-dispatch：取消探针或懒构造抛错，child 从未运行；run：child 执行本身抛错。两者都降级为 error 结果。
        logCoordination(
          'warn',
          `child degraded to error result profile=${profile.id} child=${resolveChildLogId(childInput, index)} stage=${started ? 'run' : 'pre-dispatch'}`,
          {
            profileId: profile.id,
            ...describeChild(childInput, index),
            stage: started ? 'run' : 'pre-dispatch',
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }
    const record = { childInput, result };
    records[index] = record;
    if (failures.length === 0 || started) {
      try {
        await parentInput.context.coordination?.onChildResult?.({ childInput, result, profile });
      } catch (err: unknown) {
        fail(
          'onChildResult',
          err,
          { childId: resolveDimensionId(childInput) || undefined },
          describeChild(childInput, index)
        );
      }
    } else if (parentInput.context.coordination?.onChildResult) {
      // 已有失败且该 child 未启动：不再通知宿主（避免在失败后继续写检查点），但要留下跳过痕迹。
      logCoordination(
        'warn',
        `coordination hook skipped profile=${profile.id} hook=onChildResult child=${resolveChildLogId(childInput, index)} reason=prior-failure`,
        {
          profileId: profile.id,
          hook: 'onChildResult',
          ...describeChild(childInput, index),
          reason: 'prior-failure',
        }
      );
    }
    return record;
  };
  for (const [tierIndex, tier] of tiers.entries()) {
    if (tiered) {
      let stopReason: CoordinationStopReason | null = failures.length > 0 ? 'prior-failure' : null;
      if (!stopReason) {
        try {
          stopReason = await resolveAbortReason(parentInput);
        } catch (err: unknown) {
          fail('shouldAbort', err, { tierIndex });
          stopReason = 'shouldAbort-error';
        }
      }
      if (stopReason) {
        const reason = stopReason;
        const remaining = tiers.slice(tierIndex).flat();
        logCoordination(
          isFailureStopReason(reason) ? 'warn' : 'info',
          `tier cancelled profile=${profile.id} tier=${tierIndex} reason=${reason} remainingChildren=${remaining.length}`,
          {
            profileId: profile.id,
            tierIndex,
            reason,
            remainingTierCount: tiers.length - tierIndex,
            remainingChildCount: remaining.length,
            childIds: remaining.map((index) => resolveChildLogId(childInputs[index], index)),
          }
        );
        await Promise.all(remaining.map((index) => runOneChild(index, reason)));
        break;
      }
      logCoordination(
        'info',
        `tier start profile=${profile.id} tier=${tierIndex} children=${tier.length}`,
        {
          profileId: profile.id,
          tierIndex,
          tier: resolveTier(childInputs[tier[0]]),
          childCount: tier.length,
          childIds: tier.map((index) => resolveChildLogId(childInputs[index], index)),
        }
      );
    }
    const tierStartedAt = Date.now();
    // 单个 callback 的拒绝不会让 Promise.all 早退；已开始的 child 仍需结算真实回执。
    const runs = await Promise.all(tier.map((child) => limit(() => runOneChild(child))));
    if (tiered) {
      if (failures.length === 0) {
        try {
          await parentInput.context.coordination?.onTierComplete?.({
            tierIndex,
            childInputs: runs.map((run) => run.childInput),
            results: runs.map((run) => run.result),
            profile,
          });
        } catch (err: unknown) {
          fail('onTierComplete', err, { tierIndex });
        }
      } else if (parentInput.context.coordination?.onTierComplete) {
        // tier 内已有失败：不宣告该 tier 完成（宿主据此推进阶段），只记录跳过原因。
        logCoordination(
          'warn',
          `coordination hook skipped profile=${profile.id} hook=onTierComplete tier=${tierIndex} reason=prior-failure`,
          { profileId: profile.id, hook: 'onTierComplete', tierIndex, reason: 'prior-failure' }
        );
      }
      logCoordination(
        'info',
        `tier complete profile=${profile.id} tier=${tierIndex} children=${runs.length}`,
        {
          profileId: profile.id,
          tierIndex,
          childCount: runs.length,
          durationMs: Date.now() - tierStartedAt,
          statusCounts: countStatuses(runs.map((run) => run.result)),
          failureCount: failures.length,
        }
      );
    }
  }
  const results = childInputs.map((_, index) => {
    const record = records[index];
    if (!record) {
      throw new Error('Coordinated child result is missing');
    }
    return record.result;
  });
  const skippedChildIds = [...skippedChildren]
    .sort((left, right) => left - right)
    .map((index) => resolveChildLogId(childInputs[index], index));
  if (failures.length > 0) {
    // 宿主只记录 err.message；这里把全部失败 hook 与被跳过的 child 汇总成一条 warn，便于定位缺失维度。
    logCoordination(
      'warn',
      `coordination failed profile=${profile.id} failures=${failures.length} skipped=${skippedChildIds.length}`,
      {
        profileId: profile.id,
        mode: concurrencyPlan.mode,
        durationMs: Date.now() - startedAt,
        failures: failures.map((failure) => ({ ...failure })),
        skippedChildIds,
        statusCounts: countStatuses(results),
      }
    );
    // 保持父 run 抛错（宿主据此停止 finalize）；附带原始 child 状态供恢复/读回，不能冒充成功。
    const partialResult = { ...defaultMerge(results, profile), status: 'error' as const };
    throw Object.assign(
      new Error(`Agent coordination consumption failed: ${failures[0].message}`, {
        cause: firstError,
      }),
      {
        partialResult,
        coordinationFailures: failures,
      }
    );
  }
  logCoordination(
    'info',
    `coordination complete profile=${profile.id} status=${aggregateStatus(results)} children=${results.length}`,
    {
      profileId: profile.id,
      mode: concurrencyPlan.mode,
      status: aggregateStatus(results),
      childCount: results.length,
      statusCounts: countStatuses(results),
      skippedChildIds,
      durationMs: Date.now() - startedAt,
    }
  );
  return results;
}

/**
 * 读取停止事实并给出来源；返回 null 表示继续。语义与旧的布尔版 shouldAbort 相同：
 * 先看 abortSignal，再询问宿主 shouldAbort，并在 await 之后重新读取 abortSignal。
 * shouldAbort 抛错原样上抛，由调用方决定按 child 降级（error 结果）还是 tier 级失败。
 */
async function resolveAbortReason(
  input: AgentRunInput
): Promise<'abortSignal' | 'shouldAbort' | null> {
  if (input.execution?.abortSignal?.aborted) {
    return 'abortSignal';
  }
  const requested = await input.execution?.shouldAbort?.();
  if (requested === true) {
    return 'shouldAbort';
  }
  if (input.execution?.abortSignal?.aborted === true) {
    return 'abortSignal';
  }
  return null;
}

function isFailureStopReason(reason: CoordinationStopReason) {
  return reason === 'prior-failure' || reason === 'shouldAbort-error';
}

/** 日志通道失败不能改变调度结果：observeSafely 吞掉同步异常与 rejected promise。 */
function logCoordination(level: 'info' | 'warn', event: string, metadata: Record<string, unknown>) {
  observeSafely(
    () => Logger.getInstance()[level](`${LOG_PREFIX} ${event}`, metadata),
    () => undefined
  );
}

/**
 * 日志用的 child 标识：bootstrap 维度用 dimId，module-mining 用 moduleId，都没有时退回下标。
 * 绝对路径形态的 moduleId 不写入日志（避免泄露本机路径），同样退回下标。
 */
function resolveChildLogId(input: AgentRunInput, index: number) {
  const dimId = resolveDimensionId(input);
  if (dimId) {
    return dimId;
  }
  const moduleId = stringValue(input.params?.moduleId);
  if (moduleId && !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(moduleId)) {
    return moduleId;
  }
  return `child-${index}`;
}

function countStatuses(results: AgentRunResult[]) {
  const counts: Partial<Record<AgentRunResult['status'], number>> = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return counts;
}

function createChildErrorResult(input: AgentRunInput, err: unknown): AgentRunResult {
  const message = err instanceof Error ? err.message : String(err);
  const dimId = resolveDimensionId(input);
  return {
    runId: `${dimId || 'child'}:error`,
    profileId: profileIdForResult(input),
    reply: message,
    status: 'error',
    phases: {
      error: message,
      ...(dimId ? { dimId } : {}),
    },
    toolCalls: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      iterations: 0,
      durationMs: 0,
    },
    diagnostics: null,
  };
}

function createChildAbortedResult(input: AgentRunInput): AgentRunResult {
  const dimId = resolveDimensionId(input);
  return {
    runId: `${dimId || 'child'}:aborted`,
    profileId: profileIdForResult(input),
    reply: 'child-run-aborted',
    status: 'aborted',
    phases: {
      aborted: true,
      ...(dimId ? { dimId } : {}),
    },
    toolCalls: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      iterations: 0,
      durationMs: 0,
    },
    diagnostics: null,
  };
}

function profileIdForResult(input: AgentRunInput) {
  if (input.profile.id) {
    return input.profile.id;
  }
  if ('preset' in input.profile && input.profile.preset) {
    return input.profile.preset;
  }
  if ('basePreset' in input.profile && input.profile.basePreset) {
    return input.profile.basePreset;
  }
  return 'unknown';
}

async function resolveLazyChildInput(plannedInput: AgentRunInput, parentInput: AgentRunInput) {
  const dimId = resolveDimensionId(plannedInput);
  const factory = dimId ? parentInput.context.childInputFactories?.[dimId] : undefined;
  if (!factory) {
    return plannedInput;
  }
  return factory({ plannedInput, parentInput });
}

function resolveConcurrency(
  concurrency: AgentConcurrencyPlan['concurrency']
): ConcurrencyResolution {
  if (typeof concurrency === 'number') {
    return { value: concurrency, source: 'number' };
  }
  if (concurrency?.env) {
    const raw = process.env[concurrency.env];
    const rawValue = raw ? raw.slice(0, MAX_LOGGED_ENV_VALUE_LENGTH) : undefined;
    const parsed = Number.parseInt(raw || '', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { value: parsed, source: 'env', env: concurrency.env, rawValue };
    }
    // 未设置属于正常默认；设置了却解析不出正整数（如 'abc'、'0'）才是需要 warn 的静默降级。
    return {
      value: concurrency.default,
      source: 'default',
      env: concurrency.env,
      rawValue,
      fallbackReason: raw ? 'env-invalid' : 'env-unset',
    };
  }
  return { value: 1, source: 'default', fallbackReason: 'plan-unset' };
}

function groupByTier(childInputs: AgentRunInput[]) {
  const groups = new Map<number, number[]>();
  for (const [index, child] of childInputs.entries()) {
    const tier = resolveTier(child);
    groups.set(tier, [...(groups.get(tier) || []), index]);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([, inputs]) => inputs);
}

function resolveTier(input: AgentRunInput) {
  const paramTier = input.params?.tier;
  if (typeof paramTier === 'number' && Number.isFinite(paramTier)) {
    return paramTier;
  }
  const metadataTier = input.message.metadata?.tier;
  if (typeof metadataTier === 'number' && Number.isFinite(metadataTier)) {
    return metadataTier;
  }
  return 0;
}

function resolveDimensionId(input: AgentRunInput) {
  const paramDimId = input.params?.dimId;
  if (typeof paramDimId === 'string' && paramDimId.trim()) {
    return paramDimId;
  }
  const metadataDimension = input.message.metadata?.dimension;
  if (typeof metadataDimension === 'string' && metadataDimension.trim()) {
    return metadataDimension;
  }
  return undefined;
}

/** 父状态取 child 中最严重的非成功状态；defaultMerge 与完成日志共用同一规则。 */
function aggregateStatus(results: AgentRunResult[]): AgentRunResult['status'] {
  return (
    (['error', 'aborted', 'timeout', 'blocked'] as const).find((candidate) =>
      results.some((result) => result.status === candidate)
    ) ?? 'success'
  );
}

function defaultMerge(results: AgentRunResult[], profile: CompiledAgentProfile): AgentRunResult {
  const status = aggregateStatus(results);
  return {
    runId: `${profile.id}:parent`,
    profileId: profile.id,
    reply: results
      .map((result) => result.reply)
      .filter(Boolean)
      .join('\n\n'),
    status,
    phases: { childResults: results },
    toolCalls: results.flatMap((result) => result.toolCalls),
    usage: {
      inputTokens: results.reduce((sum, result) => sum + result.usage.inputTokens, 0),
      outputTokens: results.reduce((sum, result) => sum + result.usage.outputTokens, 0),
      iterations: results.reduce((sum, result) => sum + result.usage.iterations, 0),
      durationMs: results.reduce((sum, result) => sum + result.usage.durationMs, 0),
    },
    diagnostics: null,
  };
}

function partitionBootstrapSessionDimensions(
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunInput[] {
  const dimensions = Array.isArray(input.params?.dimensions) ? input.params.dimensions : [];
  const baseParams = omitKeys(input.params || {}, ['dimensions', 'children']);
  const childProfileId = profile.concurrency?.childProfile || 'generate-dimension';
  return dimensions.map((rawDimension, index) => {
    const dimension = toRecord(rawDimension);
    const dimId = stringValue(dimension.dimId) || stringValue(dimension.id) || `dimension-${index}`;
    const label = stringValue(dimension.label) || dimId;
    const childContext = input.context.childContexts?.[dimId] || {};
    const childMessage = toRecord(dimension.message);
    const childMetadata = toRecord(dimension.metadata);
    const childParams = toRecord(dimension.params);
    const tier = numberValue(dimension.tier);
    const profileRef = toProfileRef(dimension.profile) || { id: childProfileId };
    const promptContext = {
      ...(input.context.promptContext || {}),
      ...(childContext.promptContext || {}),
      ...toRecord(dimension.promptContext),
      dimId,
      dimensionId: dimId,
    };
    return {
      profile: profileRef,
      params: stripUndefined({
        ...baseParams,
        ...childParams,
        dimId,
        ...(tier !== undefined ? { tier } : {}),
      }),
      message: {
        role: (childMessage.role as AgentRunInput['message']['role']) || 'internal',
        content:
          stringValue(childMessage.content) ||
          stringValue(dimension.prompt) ||
          `Bootstrap dimension: ${label}`,
        history: Array.isArray(childMessage.history) ? childMessage.history : input.message.history,
        metadata: stripUndefined({
          ...(input.message.metadata || {}),
          ...childMetadata,
          ...(tier !== undefined ? { tier } : {}),
          dimension: dimId,
          phase: 'bootstrap-session-child',
        }),
        sessionId: stringValue(childMessage.sessionId) || input.message.sessionId,
      },
      context: stripUndefined({
        ...input.context,
        ...childContext,
        childContexts: undefined,
        childInputFactories: undefined,
        promptContext,
      }) as unknown as AgentRunContext,
      execution: input.execution,
      presentation: input.presentation,
    };
  });
}

function partitionProjectIndexScopedModules(
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunInput[] {
  const modules = Array.isArray(input.params?.modules) ? input.params.modules : [];
  if (modules.length === 0) {
    throw new Error('moduleMining fan-out requires non-empty params.modules');
  }
  const baseParams = omitKeys(input.params || {}, [
    'modules',
    'dimensions',
    'children',
    'moduleSeeds',
  ]);
  const basePromptContext = omitKeys(input.context.promptContext || {}, [
    'dimensions',
    'dimensionId',
    'dimId',
  ]);
  const baseMetadata = omitKeys(input.message.metadata || {}, [
    'dimension',
    'dimensionId',
    'dimId',
  ]);
  const childProfileId = profile.concurrency?.childProfile || 'module-mining-dimension';
  return modules.map((rawModule, index) => {
    const moduleRecord = toRecord(rawModule);
    const moduleId =
      stringValue(moduleRecord.moduleId) ||
      stringValue(moduleRecord.id) ||
      stringValue(moduleRecord.modulePath) ||
      stringValue(moduleRecord.path) ||
      `module-${index}`;
    const moduleName =
      stringValue(moduleRecord.moduleName) ||
      stringValue(moduleRecord.name) ||
      stringValue(moduleRecord.label) ||
      moduleId;
    const modulePath = stringValue(moduleRecord.modulePath) || stringValue(moduleRecord.path);
    const ownedFiles =
      stringArrayValue(moduleRecord.ownedFiles) ||
      stringArrayValue(moduleRecord.files) ||
      stringArrayValue(moduleRecord.paths) ||
      [];
    const childContext = input.context.childContexts?.[moduleId] || {};
    const childMessage = toRecord(moduleRecord.message);
    const childMetadata = toRecord(moduleRecord.metadata);
    const childParams = toRecord(moduleRecord.params);
    const tier = numberValue(moduleRecord.tier);
    const profileRef = toProfileRef(moduleRecord.profile) || { id: childProfileId };
    const projectInfo = buildProjectIndexModuleInfo(input.params?.projectFacts, ownedFiles);
    const dimConfig = buildScopedIndexModuleDimConfig(moduleRecord, {
      moduleId,
      moduleName,
      modulePath,
      ownedFiles,
    });
    const strategyContext = stripUndefined({
      ...toRecord(input.context.strategyContext),
      ...toRecord(childContext.strategyContext),
      ...toRecord(moduleRecord.strategyContext),
      projectFacts: input.params?.projectFacts,
      projectInfo,
      dimConfig,
      moduleContext: stripUndefined({
        moduleId,
        moduleName,
        modulePath,
        ownedFiles,
        module: moduleRecord,
      }),
    });
    const promptContext = {
      ...basePromptContext,
      ...(childContext.promptContext || {}),
      ...toRecord(moduleRecord.promptContext),
      moduleId,
      moduleName,
      ...(modulePath ? { modulePath } : {}),
      ownedFiles,
      projectInfo,
      dimConfig,
    };
    return {
      profile: profileRef,
      params: stripUndefined({
        ...baseParams,
        ...childParams,
        moduleId,
        moduleName,
        modulePath,
        ownedFiles,
        ...(tier !== undefined ? { tier } : {}),
      }),
      message: {
        role: (childMessage.role as AgentRunInput['message']['role']) || 'internal',
        content:
          stringValue(childMessage.content) ||
          stringValue(moduleRecord.prompt) ||
          `Module mining: ${moduleName}`,
        history: Array.isArray(childMessage.history) ? childMessage.history : input.message.history,
        metadata: stripUndefined({
          ...baseMetadata,
          ...childMetadata,
          ...(tier !== undefined ? { tier } : {}),
          moduleId,
          moduleName,
          phase: 'module-mining-child',
        }),
        sessionId: stringValue(childMessage.sessionId) || input.message.sessionId,
      },
      context: stripUndefined({
        ...input.context,
        ...childContext,
        childContexts: undefined,
        childInputFactories: undefined,
        promptContext,
        strategyContext,
      }) as unknown as AgentRunContext,
      execution: input.execution,
      presentation: input.presentation,
    };
  });
}

/**
 * P0-4(挖掘质量升级)：从 child 结果里收集被质量门放弃(degrade)的单元。
 * 读取面是 PipelineStrategy 投影的 phases._pipelineOutcome(outcome==='abandoned')——
 * 此前弱维度 degrade 后静默产 0 候选、只留日志；聚合成一等字段后，父 run 的消费方
 * (module-mining 回填、评估 harness 的 abandonment rate)能直接看到"哪个单元、哪个门、
 * 什么原因被放弃"。error/aborted 不在此列(它们已由 child status 表达)。
 */
function collectAbandonedUnits(
  results: AgentRunResult[],
  unitIds: string[]
): Array<{ unitId: string; stage: string; action: string; reason: string }> {
  const abandoned: Array<{ unitId: string; stage: string; action: string; reason: string }> = [];
  results.forEach((result, index) => {
    const outcome = toRecord(toRecord(result.phases)._pipelineOutcome);
    if (stringValue(outcome.outcome) !== 'abandoned') {
      return;
    }
    abandoned.push({
      unitId: unitIds[index] || `unit-${index}`,
      stage: stringValue(outcome.stage) || 'unknown',
      action: stringValue(outcome.action) || 'degrade',
      reason: stringValue(outcome.reason) || '',
    });
  });
  return abandoned;
}

function mergeBootstrapSessionResults(
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunResult {
  const dimensions = Array.isArray(input.params?.dimensions) ? input.params.dimensions : [];
  const dimensionIds = dimensions.map((dimension, index) => {
    const record = toRecord(dimension);
    return stringValue(record.dimId) || stringValue(record.id) || `dimension-${index}`;
  });
  const abandonedDimensions = collectAbandonedUnits(results, dimensionIds);
  return {
    ...defaultMerge(results, profile),
    phases: {
      childResults: results,
      dimensionResults: Object.fromEntries(
        results.map((result, index) => [dimensionIds[index] || `dimension-${index}`, result])
      ),
      ...(abandonedDimensions.length > 0 ? { abandonedDimensions } : {}),
    },
  };
}

function mergeProjectIndexScopedModuleResults(
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunResult {
  const modules = Array.isArray(input.params?.modules) ? input.params.modules : [];
  const moduleIds = modules.map((moduleInput, index) => {
    const moduleRecord = toRecord(moduleInput);
    return (
      stringValue(moduleRecord.moduleId) ||
      stringValue(moduleRecord.id) ||
      stringValue(moduleRecord.modulePath) ||
      stringValue(moduleRecord.path) ||
      `module-${index}`
    );
  });
  const abandonedModules = collectAbandonedUnits(results, moduleIds);
  return {
    ...defaultMerge(results, profile),
    phases: {
      childResults: results,
      moduleResults: Object.fromEntries(
        results.map((result, index) => [moduleIds[index] || `module-${index}`, result])
      ),
      ...(abandonedModules.length > 0 ? { abandonedModules } : {}),
    },
  };
}

function buildProjectIndexModuleInfo(projectFacts: unknown, ownedFiles: string[]) {
  const facts = toRecord(projectFacts);
  const explicitProjectInfo = toRecord(facts.projectInfo);
  const name =
    stringValue(explicitProjectInfo.name) ||
    stringValue(facts.project) ||
    stringValue(facts.name) ||
    stringValue(facts.projectName) ||
    'ProjectContext';
  const lang =
    stringValue(explicitProjectInfo.lang) ||
    stringValue(explicitProjectInfo.language) ||
    stringValue(facts.lang) ||
    stringValue(facts.language) ||
    'unknown';
  const fileCount =
    numberValue(explicitProjectInfo.fileCount) ?? numberValue(facts.fileCount) ?? ownedFiles.length;

  return {
    ...explicitProjectInfo,
    name,
    lang,
    fileCount,
  };
}

function buildScopedIndexModuleDimConfig(
  moduleRecord: Record<string, unknown>,
  {
    moduleId,
    moduleName,
    modulePath,
    ownedFiles,
  }: {
    moduleId: string;
    moduleName: string;
    modulePath?: string;
    ownedFiles: string[];
  }
) {
  const dimensions =
    stringArrayValue(moduleRecord.dimensions) || stringArrayValue(moduleRecord.dimensionIds) || [];
  const id =
    stringValue(moduleRecord.dimensionId) ||
    stringValue(moduleRecord.dimId) ||
    dimensions[0] ||
    `module:${moduleId}`;
  const focusKeywords = [moduleName, modulePath, ...dimensions, ...ownedFiles.slice(0, 8)].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  const guideParts = [
    `只分析 ProjectContext module "${moduleName}"。`,
    `moduleId: ${moduleId}`,
    modulePath ? `modulePath: ${modulePath}` : '',
    ownedFiles.length > 0 ? `ownedFiles:\n${ownedFiles.map((file) => `- ${file}`).join('\n')}` : '',
    // P1-B-1：run 入口静态装配的模块图谱(ModuleContextAssembler)——Analyst 首轮即见
    // 目录骨架/兄弟模块/可选依赖,graph 调用退为精化手段(不再是骨架的唯一来源)。
    stringValue(moduleRecord.contextMap) || '',
  ].filter(Boolean);

  return stripUndefined({
    id,
    label: `模块 ${moduleName}`,
    guide: guideParts.join('\n'),
    focusKeywords,
    outputType: stringValue(moduleRecord.outputType) || 'dual',
    allowedKnowledgeTypes: stringArrayValue(moduleRecord.allowedKnowledgeTypes) || [
      'rule',
      'pattern',
      'fact',
    ],
  });
}

function toProfileRef(value: unknown): AgentProfileRef | AgentProfileOverride | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id === 'string' ||
    typeof value.preset === 'string' ||
    typeof value.basePreset === 'string'
  ) {
    return value as AgentProfileRef | AgentProfileOverride;
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
}

function omitKeys(input: Record<string, unknown>, keys: string[]) {
  const skipped = new Set(keys);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !skipped.has(key)));
}

function stripUndefined<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export default AgentRunCoordinator;
