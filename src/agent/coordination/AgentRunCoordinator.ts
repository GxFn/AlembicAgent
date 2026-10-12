import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { runOperation } from '#shared/operation.js';
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
/**
 * childInputs 是 partitioner 的计划产物（与 results 按下标一一对应），是单元 id 的唯一来源：
 * 内置 merger 直接读 childInput.params.dimId/moduleId 作为结果键，不再从父 params 重新推导一份。
 * Merger 不是公开导出类型；只接收前三个参数的已注册 merger 仍然兼容。
 */
type Merger = (
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile,
  childInputs: AgentRunInput[]
) => AgentRunResult;
type ChildRunRecord = { childInput: AgentRunInput; result: AgentRunResult };
/** 回执身份（dimId/profileId）只从 partitioner 的计划输入推导，不信任懒构造工厂的产物。 */
type ChildReceiptIdentity = { dimId?: string; profileId: string };

/**
 * 停止事实的来源。tier 整批取消与 child 跳过都要带上它，宿主才能区分：
 * - abortSignal / shouldAbort：用户或宿主主动取消，属于正常收尾；
 * - shouldAbort-timeout：宿主取消探针在单次检查期限（execution.timeoutMs）内没有回答，
 *   按“请求取消”收尾（与 AgentService preflight 一致），不算协调失败，但要 warn；
 * - prior-failure：兄弟 child 的回调（检查点等）或取消探针已失败，后续不再派发；
 * - shouldAbort-error：取消探针自身抛错（tier 级或 child 级），按协调失败处理并停止派发。
 */
type CoordinationStopReason =
  | 'abortSignal'
  | 'shouldAbort'
  | 'shouldAbort-timeout'
  | 'prior-failure'
  | 'shouldAbort-error';

/** resolveAbortReason 能直接给出的停止来源（探针抛错由调用方归类为 shouldAbort-error）。 */
type AbortCheckReason = 'abortSignal' | 'shouldAbort' | 'shouldAbort-timeout';

/**
 * 一次取消检查发生的位置，只用于日志定位：tier 边界检查带 tierIndex，
 * child 检查带 childId（与其余日志同一标识规则）以及是在懒构造之前还是之后。
 */
type CancellationCheckScope = {
  profileId: string;
  checkpoint: 'tier' | 'child-pre-dispatch' | 'child-post-lazy';
  tierIndex?: number;
  childIndex?: number;
  childId?: string;
};

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

    return merger
      ? merger(childResults, input, profile, childInputs)
      : defaultMerge(childResults, profile);
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
  logUnimplementedAbortPolicy(concurrencyPlan, profile);
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
      stopReasonLogLevel(reason),
      `child skipped profile=${profile.id} child=${child.childId} reason=${reason}`,
      { profileId: profile.id, ...child, reason }
    );
  };
  const settleChild = async (
    index: number,
    forcedStop?: CoordinationStopReason
  ): Promise<ChildRunRecord> => {
    const planned = childInputs[index];
    // 身份、日志定位与 error/aborted 回执一律从计划输入推导：工厂产物可能畸形或改写 dimId，
    // 用它推导会让回执键与 merger/宿主回调的单元 id 对不上，畸形时还会在 catch 里二次抛 TypeError。
    const identity = plannedChildIdentity(planned);
    let childInput = planned;
    let result: AgentRunResult;
    let started = false;
    // 该 child 自身的停止来源；只用于 onChildResult 跳过日志区分“自身探针故障”与“兄弟先失败”。
    let childStop: CoordinationStopReason | null = null;
    /**
     * child 级取消检查。探针抛错不是该 child 的执行失败：单独捕获并 fail('shouldAbort')，
     * 该 child 写 aborted 回执，后续 child 因 failures>0 按 prior-failure 跳过、不再调用坏 hook，
     * 父 run 与 tier 级检查、AgentService preflight 一致地抛协调错误（附 partialResult）。
     * 懒构造与 runChild 的异常不经过这里，仍由外层 catch 归为该 child 的 error 结果。
     */
    const checkChildStop = async (
      checkpoint: 'child-pre-dispatch' | 'child-post-lazy'
    ): Promise<CoordinationStopReason | null> => {
      try {
        // 定位信息惰性求值且只在日志通道内读取：读计划输入失败不能被误记成探针故障。
        const reason = await resolveAbortReason(parentInput, () => ({
          profileId: profile.id,
          checkpoint,
          childIndex: index,
          childId: resolveChildLogId(planned, index),
          ...(tierIndexByChild.has(index) ? { tierIndex: tierIndexByChild.get(index) } : {}),
        }));
        return reason ?? (failures.length > 0 ? 'prior-failure' : null);
      } catch (err: unknown) {
        fail(
          'shouldAbort',
          err,
          { childId: identity.dimId || undefined },
          { ...describeChild(planned, index), checkpoint }
        );
        return 'shouldAbort-error';
      }
    };
    // 回调可能保存检查点，失败后不能重试它或继续派发尚未开始的子任务。
    if (forcedStop || failures.length > 0) {
      result = createChildAbortedResult(identity);
      childStop = forcedStop ?? 'prior-failure';
      logChildSkipped(planned, index, childStop);
    } else {
      try {
        const preStop = await checkChildStop('child-pre-dispatch');
        if (preStop) {
          result = createChildAbortedResult(identity);
          childStop = preStop;
          logChildSkipped(planned, index, preStop);
        } else {
          childInput = await resolveLazyChildInput(identity.dimId, planned, parentInput);
          // shouldAbort/懒构造均可挂起；恢复后必须重新读取停止事实，不能用 await 前的值。
          const stop = await checkChildStop('child-post-lazy');
          if (stop) {
            result = createChildAbortedResult(identity);
            childStop = stop;
            logChildSkipped(planned, index, stop);
          } else {
            started = true;
            result = await runChild(childInput);
          }
        }
      } catch (err: unknown) {
        result = createChildErrorResult(identity, err);
        // pre-dispatch：懒构造抛错（含工厂产物校验失败），child 从未运行；run：child 执行本身抛错。
        // 两者都降级为 error 结果；取消探针抛错已在 checkChildStop 中归为协调失败，不会走到这里。
        logCoordination(
          'warn',
          `child degraded to error result profile=${profile.id} child=${resolveChildLogId(planned, index)} stage=${started ? 'run' : 'pre-dispatch'}`,
          {
            profileId: profile.id,
            ...describeChild(planned, index),
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
          { childId: identity.dimId || undefined },
          describeChild(planned, index)
        );
      }
    } else if (parentInput.context.coordination?.onChildResult) {
      // 已有失败且该 child 未启动：不再通知宿主（避免在失败后继续写检查点），但要留下跳过痕迹。
      // 若失败正是该 child 自己的取消探针抛错，原因写 shouldAbort-error，便于和兄弟连带跳过区分。
      const skipReason = childStop === 'shouldAbort-error' ? 'shouldAbort-error' : 'prior-failure';
      logCoordination(
        'warn',
        `coordination hook skipped profile=${profile.id} hook=onChildResult child=${resolveChildLogId(planned, index)} reason=${skipReason}`,
        {
          profileId: profile.id,
          hook: 'onChildResult',
          ...describeChild(planned, index),
          reason: skipReason,
        }
      );
    }
    return record;
  };
  /**
   * runOneChild 永不 reject：Promise.all 一旦因某个 child 早退，父 run 会先于仍在运行的兄弟 child settle，
   * 兄弟随后才写检查点（宿主此时已进入失败收口）。settleChild 之外的意外异常（如自定义 partitioner
   * 产出无法读取的输入）记为 runOneChild 协调失败：后续未开工的 child 按 prior-failure 跳过，
   * 父 run 在全部已开工 child 结算后抛带 partialResult 的协调错误。
   */
  const runOneChild = async (
    index: number,
    forcedStop?: CoordinationStopReason
  ): Promise<ChildRunRecord> => {
    try {
      return await settleChild(index, forcedStop);
    } catch (err: unknown) {
      fail('runOneChild', err, {}, { childIndex: index });
      const existing = records[index];
      if (existing) {
        return existing;
      }
      // 计划输入本身不可读，回执身份不能再从它推导，只能给出不带 dimId 的兜底 error 回执。
      const record = {
        childInput: childInputs[index],
        result: createChildErrorResult({ profileId: 'unknown' }, err),
      };
      records[index] = record;
      return record;
    }
  };
  for (const [tierIndex, tier] of tiers.entries()) {
    if (tiered) {
      let stopReason: CoordinationStopReason | null = failures.length > 0 ? 'prior-failure' : null;
      if (!stopReason) {
        try {
          stopReason = await resolveAbortReason(parentInput, () => ({
            profileId: profile.id,
            checkpoint: 'tier',
            tierIndex,
          }));
        } catch (err: unknown) {
          fail('shouldAbort', err, { tierIndex });
          stopReason = 'shouldAbort-error';
        }
      }
      if (stopReason) {
        const reason = stopReason;
        const remaining = tiers.slice(tierIndex).flat();
        logCoordination(
          stopReasonLogLevel(reason),
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
 * 读取停止事实并给出来源；返回 null 表示继续。先看 abortSignal，再询问宿主 shouldAbort，
 * 并在探针结束后重新读取 abortSignal。
 *
 * 可协调 profile 在 AgentService 中不经过 runOperation preflight，协调器是这条路径上唯一的取消闸门，
 * 所以宿主探针必须与 AgentService preflight 用同一套 runOperation 语义竞速：
 * - abortSignal 在探针挂起期间触发 → 立即按 abortSignal 停止，不再等待宿主 promise；
 * - execution.timeoutMs（有限正数）作为单次检查期限，到期 → shouldAbort-timeout（按请求取消收尾）；
 * - 探针抛错/拒绝 → 归一为 Error 上抛，由调用方统一记为 shouldAbort 协调失败。
 * 不合作的宿主 promise 可能仍在后台挂着，但它迟到的结果不会再影响本次协调。
 */
async function resolveAbortReason(
  input: AgentRunInput,
  describeScope: () => CancellationCheckScope
): Promise<AbortCheckReason | null> {
  const execution = input.execution;
  if (execution?.abortSignal?.aborted) {
    return 'abortSignal';
  }
  const hook = execution?.shouldAbort;
  if (!hook) {
    return null;
  }
  const timeoutMs = resolveCheckTimeoutMs(execution.timeoutMs);
  // 不把 runOperation 的内部 signal 传给宿主 hook：公开契约是无参 () => boolean | Promise<boolean>。
  const check = await runOperation(() => hook(), {
    abortSignal: execution.abortSignal,
    timeoutMs,
  });
  if (check.status === 'error') {
    throw check.error instanceof Error
      ? check.error
      : new Error('Agent cancellation check failed', { cause: check.error });
  }
  if (check.status === 'aborted') {
    // 探针挂起期间父 signal 触发：竞速胜出，按 abortSignal 停止（正常取消，info）。
    logCancellationCheck('info', 'cancellation check interrupted by abortSignal', describeScope, {
      outcome: 'aborted',
    });
    return 'abortSignal';
  }
  if (check.status === 'timeout') {
    // 宿主探针在单次检查期限内没有回答：按请求取消收尾，避免父 run 永久挂起；探针异常慢需要 warn。
    logCancellationCheck('warn', 'cancellation check timed out', describeScope, {
      outcome: 'timeout',
      timeoutMs,
    });
    return 'shouldAbort-timeout';
  }
  if (check.status === 'ok' && check.value === true) {
    return 'shouldAbort';
  }
  if (execution.abortSignal?.aborted === true) {
    return 'abortSignal';
  }
  return null;
}

/**
 * 协调器唯一实现的取消策略是 stop-new（I20）：tier 边界与每个 child 派发前（含懒构造之后）检查停止事实，
 * 已开始的 child 不由协调器打断，尚未派发的 child（含同 tier 中排队的）写 aborted 回执。
 * 声明 'cancel-running'（打断运行中 child）或 'finish-tier'（当前 tier 跑完再停）时，
 * 调度逻辑不据此分叉、仍按 stop-new 执行——这是一条降级路径，不能静默：每次协调记一条 warn，
 * 写明声明值与实际生效值，宿主据此发现 profile 声明与实际取消语义不符。
 * 只记诊断、不改调度，也不抛错：抛错会让已声明这些值的外部 profile 直接失败，属于行为变化。
 */
function logUnimplementedAbortPolicy(
  concurrencyPlan: AgentConcurrencyPlan,
  profile: CompiledAgentProfile
) {
  // 运行时可能拿到 JSON 等非类型化来源的值，这里按 unknown 处理，任何非 stop-new 的声明都算未实现。
  const declared: unknown = concurrencyPlan.abortPolicy;
  if (declared === undefined || declared === 'stop-new') {
    return;
  }
  const effective = 'stop-new';
  logCoordination(
    'warn',
    `abortPolicy not implemented, scheduling as stop-new profile=${profile.id} declared=${String(declared)} effective=${effective}`,
    {
      profileId: profile.id,
      mode: concurrencyPlan.mode,
      declaredAbortPolicy: declared,
      effectiveAbortPolicy: effective,
    }
  );
}

/** 与 AgentService preflight 相同的期限归一：只有有限正数才构成检查期限，否则不限时（只与 signal 竞速）。 */
function resolveCheckTimeoutMs(timeout: unknown): number | undefined {
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
}

/**
 * 取消检查结局的日志。定位信息（describeScope）在 observeSafely 内求值：
 * 即使读取 child 计划输入抛错，也只丢失这条日志，不改变检查结果与调度。
 */
function logCancellationCheck(
  level: 'info' | 'warn',
  event: string,
  describeScope: () => CancellationCheckScope,
  extra: { outcome: 'aborted' | 'timeout'; timeoutMs?: number }
) {
  observeSafely(
    () => {
      const scope = describeScope();
      const location = [
        `profile=${scope.profileId}`,
        `checkpoint=${scope.checkpoint}`,
        scope.childId ? `child=${scope.childId}` : '',
        scope.tierIndex !== undefined ? `tier=${scope.tierIndex}` : '',
        extra.timeoutMs !== undefined ? `timeoutMs=${extra.timeoutMs}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return Logger.getInstance()[level](`${LOG_PREFIX} ${event} ${location}`, {
        ...stripUndefined(scope),
        ...stripUndefined(extra),
      });
    },
    () => undefined
  );
}

function isFailureStopReason(reason: CoordinationStopReason) {
  return reason === 'prior-failure' || reason === 'shouldAbort-error';
}

/** 失败类停止与探针超时都要 warn；用户/宿主正常取消只记 info。 */
function stopReasonLogLevel(reason: CoordinationStopReason): 'info' | 'warn' {
  return isFailureStopReason(reason) || reason === 'shouldAbort-timeout' ? 'warn' : 'info';
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

function plannedChildIdentity(planned: AgentRunInput): ChildReceiptIdentity {
  return { dimId: resolveDimensionId(planned), profileId: profileIdForResult(planned) };
}

function createChildErrorResult(
  { dimId, profileId }: ChildReceiptIdentity,
  err: unknown
): AgentRunResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    runId: `${dimId || 'child'}:error`,
    profileId,
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

function createChildAbortedResult({ dimId, profileId }: ChildReceiptIdentity): AgentRunResult {
  return {
    runId: `${dimId || 'child'}:aborted`,
    profileId,
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

async function resolveLazyChildInput(
  dimId: string | undefined,
  plannedInput: AgentRunInput,
  parentInput: AgentRunInput
) {
  const factories = parentInput.context.childInputFactories;
  // 只认宿主自有键：dimId 为 'constructor'/'toString' 时不能误取到 Object.prototype 上的函数当工厂。
  const factory =
    dimId && factories && Object.hasOwn(factories, dimId) ? factories[dimId] : undefined;
  if (!factory) {
    return plannedInput;
  }
  if (typeof factory !== 'function') {
    throw new Error(`childInputFactories[${dimId}] is not a function`);
  }
  const produced = await factory({ plannedInput, parentInput });
  // 工厂产物是宿主输入，进入执行前先校验（与 AgentService.validateRunInput 的必填项对齐）。
  // 不合格时抛错落入 runOneChild 的 catch，成为该 child 的 error 回执，而不是带着畸形输入去执行。
  const missing = describeMissingRunInputFields(produced);
  if (missing.length > 0) {
    throw new Error(
      `childInputFactories[${dimId}] returned invalid AgentRunInput: missing ${missing.join(', ')}`
    );
  }
  return produced;
}

/** 返回 AgentRunInput 缺失的必填项；参数按 unknown 处理，因为 JS 宿主可以绕过类型约束。 */
function describeMissingRunInputFields(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['input object'];
  }
  const missing: string[] = [];
  if (!isRecord(value.profile)) {
    missing.push('profile');
  }
  if (!isRecord(value.message) || !stringValue(value.message.content)) {
    missing.push('message.content');
  }
  if (!isRecord(value.context) || !stringValue(value.context.source)) {
    missing.push('context.source');
  }
  return missing;
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
  const dimensionRecords = dimensions.map((rawDimension) => toRecord(rawDimension));
  const unitIds = dimensionRecords.map(
    (dimension, index) =>
      stringValue(dimension.dimId) || stringValue(dimension.id) || `dimension-${index}`
  );
  assertUniqueFanOutUnitIds('generateSessionDimensions', unitIds, profile);
  return dimensionRecords.map((dimension, index) => {
    const dimId = unitIds[index];
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
        // coordination 回调只属于父级协调层（宿主用它写父 run 的检查点）；child 若再 fan-out，
        // 孙级结算会以孙级 id 调用父级回调，造成错写或重复写，所以 child context 一律不继承。
        coordination: undefined,
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
  const moduleRecords = modules.map((rawModule) => toRecord(rawModule));
  const unitIds = moduleRecords.map(
    (moduleRecord, index) =>
      stringValue(moduleRecord.moduleId) ||
      stringValue(moduleRecord.id) ||
      stringValue(moduleRecord.modulePath) ||
      stringValue(moduleRecord.path) ||
      `module-${index}`
  );
  assertUniqueFanOutUnitIds('projectContextModules', unitIds, profile);
  return moduleRecords.map((moduleRecord, index) => {
    const moduleId = unitIds[index];
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
        // 同 bootstrap 分区：父级 coordination 回调不下发给 child，避免嵌套 fan-out 时孙级写父级检查点。
        coordination: undefined,
        promptContext,
        strategyContext,
      }) as unknown as AgentRunContext,
      execution: input.execution,
      presentation: input.presentation,
    };
  });
}

/**
 * 单元 id 是 fan-out 的主键：childContexts/childInputFactories 按它取值，merger 按它建
 * dimensionResults/moduleResults，宿主 onChildResult 按它写检查点。重复 id 会让 Object.fromEntries
 * 后写覆盖前写，失败单元从宿主 failedDimensionIds 中消失，两个 child 还会共享同一份专属 context 与工厂。
 * 因此在派发任何 child 之前直接拒绝；不自动加后缀，因为后缀 id 宿主无法按原 id 回读。
 */
function assertUniqueFanOutUnitIds(
  partitioner: string,
  unitIds: string[],
  profile: CompiledAgentProfile
) {
  const firstIndexById = new Map<string, number>();
  for (const [index, unitId] of unitIds.entries()) {
    const firstIndex = firstIndexById.get(unitId);
    if (firstIndex === undefined) {
      firstIndexById.set(unitId, index);
      continue;
    }
    logCoordination(
      'warn',
      `fan-out rejected profile=${profile.id} partitioner=${partitioner} reason=duplicate-unit-id`,
      {
        profileId: profile.id,
        partitioner,
        reason: 'duplicate-unit-id',
        unitId,
        firstIndex,
        duplicateIndex: index,
        unitCount: unitIds.length,
      }
    );
    throw new Error(
      `duplicate fan-out unit id: ${unitId} (${partitioner} entries ${firstIndex} and ${index})`
    );
  }
}

/**
 * merger 的结果键直接读 partitioner 写进 childInput.params 的单元 id（单一来源）；
 * 自定义 partitioner 未写该键时退回按下标命名，与旧的缺省命名一致。
 */
function readFanOutUnitIds(
  childInputs: AgentRunInput[],
  key: 'dimId' | 'moduleId',
  fallbackPrefix: 'dimension' | 'module'
) {
  return childInputs.map(
    (childInput, index) => stringValue(childInput.params?.[key]) || `${fallbackPrefix}-${index}`
  );
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
  _input: AgentRunInput,
  profile: CompiledAgentProfile,
  childInputs: AgentRunInput[]
): AgentRunResult {
  const dimensionIds = readFanOutUnitIds(childInputs, 'dimId', 'dimension');
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
  _input: AgentRunInput,
  profile: CompiledAgentProfile,
  childInputs: AgentRunInput[]
): AgentRunResult {
  const moduleIds = readFanOutUnitIds(childInputs, 'moduleId', 'module');
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
