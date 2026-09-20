import { runOperation } from '#shared/operation.js';
import { stableStringify } from '#shared/serialization.js';
import { AgentEvents } from '../../runtime/AgentEventBus.js';
import type { ToolCallHook } from '../../runtime/AgentRuntimeTypes.js';
import { DiagnosticsCollector } from '../../runtime/DiagnosticsCollector.js';
import type { PipelineRuntime, StageResult } from './contracts.js';

export interface StageAttemptScope {
  signal: AbortSignal;
  diagnostics: DiagnosticsCollector;
  runLoop(prompt: string, options: Record<string, unknown>): Promise<StageResult>;
}

interface StageAttemptOptions {
  stage: string;
  abortSignal?: AbortSignal | null;
  timeoutMs?: number;
  diagnostics: DiagnosticsCollector;
  onToolCall?: ToolCallHook;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameObservation(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  diagnostics: DiagnosticsCollector
): boolean {
  if ((left.tool || left.name) !== (right.tool || right.name)) {
    return false;
  }
  const leftId = record(left.envelope)?.callId ?? left.callId;
  const rightId = record(right.envelope)?.callId ?? right.callId;
  if (typeof leftId === 'string' && leftId && typeof rightId === 'string' && rightId) {
    return leftId === rightId;
  }
  if (left.args === right.args && left.result === right.result) {
    return true;
  }
  try {
    return (
      stableStringify({ args: left.args, result: left.result }) ===
      stableStringify({ args: right.args, result: right.result })
    );
  } catch (err: unknown) {
    diagnostics.warn({
      code: 'pipeline_observation_unmatchable',
      message: `Unserializable observation retained separately (${err instanceof Error ? err.name : 'unknown'}).`,
    });
    return false;
  }
}

/**
 * 一个 attempt 覆盖准备与真实 reactLoop。诊断独立收集后只合并一次，终态后关闭观察入口。
 * 向下传播 signal 并不保证外部副作用已回滚；未完成工具通过 partial 明示需要读回。
 */
export async function runStageAttempt(
  runtime: PipelineRuntime,
  options: StageAttemptOptions,
  operation: (scope: StageAttemptScope) => Promise<StageResult>
) {
  const diagnostics = new DiagnosticsCollector();
  const observed: Array<Record<string, unknown>> = [];
  const historyStart = runtime.toolCallHistory?.length ?? 0;
  const iterationStart = runtime.iterationCount ?? 0;
  const nativeObservable = Boolean(runtime.bus && Array.isArray(runtime.toolCallHistory));
  let startedTools = 0;
  let observedIterations = 0;
  let active = true;
  let loopStarted = false;
  let signal: AbortSignal | undefined;
  const onStart = (event: unknown) => {
    if (active && record(record(event)?.payload)?.agentId === runtime.id) {
      startedTools++;
    }
  };
  if (nativeObservable) {
    runtime.bus?.on(AgentEvents.TOOL_CALL_START, onStart);
  }

  const onToolCall: ToolCallHook = (name, args, result, iteration) => {
    if (!active || signal?.aborted) {
      return;
    }
    // Runtime 先写 history 再通知钩子。保留最新匹配项的 envelope，旧宿主回退到实际观察内容。
    const native = runtime.toolCallHistory?.slice(historyStart).findLast((value) => {
      const entry = record(value);
      return (
        (entry?.tool || entry?.name) === name && entry?.args === args && entry?.result === result
      );
    });
    observed.push(native ? { ...record(native) } : { tool: name, args, result });
    if (Number.isFinite(iteration)) {
      observedIterations = Math.max(observedIterations, iteration);
    }
    const notify = options.onToolCall || runtime.onToolCall;
    notify?.(name, args, result, iteration);
  };

  const outcome = await runOperation(
    async (operationSignal) => {
      signal = operationSignal;
      return operation({
        signal: operationSignal,
        diagnostics,
        runLoop: (prompt, input) => {
          loopStarted = true;
          return runtime.reactLoop(prompt, {
            ...input,
            abortSignal: operationSignal,
            diagnostics,
            onToolCall,
          });
        },
      });
    },
    { abortSignal: options.abortSignal, timeoutMs: options.timeoutMs }
  );

  active = false;
  if (nativeObservable) {
    runtime.bus?.off(AgentEvents.TOOL_CALL_START, onStart);
  }
  const returned = outcome.status === 'ok' ? outcome.value : null;
  const tools = [...(returned?.toolCalls || [])];
  const matched = new Set<number>();
  for (const observation of observed) {
    const index = tools.findIndex(
      (entry, position) =>
        !matched.has(position) && sameObservation(entry, observation, diagnostics)
    );
    if (index >= 0) {
      matched.add(index);
      if (!tools[index].envelope && observation.envelope) {
        tools[index] = { ...tools[index], envelope: observation.envelope };
      }
    } else {
      tools.push(observation);
      matched.add(tools.length - 1);
    }
  }
  // 返回结果与 diagnostics 描述同一成本，取已知最大值而不是重复相加。
  const usage = diagnostics.toJSON().efficiency?.tokenUsage;
  const tokenUsage = {
    input: Math.max(returned?.tokenUsage?.input || 0, usage?.input || 0),
    output: Math.max(returned?.tokenUsage?.output || 0, usage?.output || 0),
  };
  diagnostics.recordTokenUsage({
    inputTokens: tokenUsage.input - (usage?.input || 0),
    outputTokens: tokenUsage.output - (usage?.output || 0),
  });
  const timedOut = outcome.status === 'timeout' || returned?.timedOut === true;
  // 宿主可以主动终止自己的阶段，而不取消父 signal；这是控制终态，不能误作正常返回。
  const aborted = outcome.status === 'aborted' || returned?.aborted === true;
  const status = aborted ? 'aborted' : outcome.status;
  const interrupted = status !== 'ok';
  const reportedPartial = returned?.partial;
  // 宿主已报告的计数也是回执证据；缺少对应工具内容不等于计数为零。
  const startedToolCalls =
    reportedPartial?.startedToolCalls === null
      ? null // 宿主明确报未知，不得被本地未收到 start 事件覆盖成已确认零。
      : nativeObservable
        ? Math.max(startedTools, reportedPartial?.startedToolCalls ?? 0)
        : (reportedPartial?.startedToolCalls ?? null);
  const completedToolCalls = Math.max(tools.length, reportedPartial?.completedToolCalls ?? 0);
  const requiresReadback =
    reportedPartial?.requiresReadback === true ||
    (interrupted &&
      loopStarted &&
      (startedToolCalls === null || startedToolCalls > completedToolCalls));
  if (timedOut) {
    diagnostics.recordTimedOutStage(options.stage);
  }
  if (aborted) {
    diagnostics.recordCancelReason(outcome.status === 'aborted' ? 'abort_signal' : 'stage_aborted');
  } else if (timedOut) {
    diagnostics.recordCancelReason('stage_timeout');
  }
  if (interrupted) {
    diagnostics.warn({
      code: 'pipeline_attempt_interrupted',
      stage: options.stage,
      message: `Attempt ${status}; tools started=${startedToolCalls ?? 'unknown'}, completed=${completedToolCalls}; requiresReadback=${requiresReadback}.`,
    });
  }
  const result: StageResult = {
    ...(returned || {}),
    reply: returned?.reply || '',
    toolCalls: tools,
    tokenUsage,
    iterations: Math.max(
      returned?.iterations || 0,
      observedIterations,
      Math.max(0, (runtime.iterationCount ?? iterationStart) - iterationStart)
    ),
    ...(timedOut ? { timedOut: true } : {}),
    ...(aborted ? { aborted: true } : {}),
    ...(interrupted || reportedPartial
      ? {
          partial: {
            ...reportedPartial,
            startedToolCalls,
            completedToolCalls,
            requiresReadback,
          },
        }
      : {}),
  };
  // 关闭活跃标记后快照合并；迟到 provider/observer 只能触及独立 attempt diagnostics。
  options.diagnostics.merge(diagnostics.toJSON());
  return {
    result,
    status,
    error: outcome.status === 'error' ? outcome.error : undefined,
    canFastRetry:
      timedOut &&
      !aborted &&
      !options.abortSignal?.aborted &&
      tools.length === 0 &&
      (!result.partial ||
        (result.partial.startedToolCalls === 0 &&
          result.partial.completedToolCalls === 0 &&
          !result.partial.requiresReadback)) &&
      (outcome.status === 'ok' || (nativeObservable && loopStarted && startedTools === 0)) &&
      (!nativeObservable || startedTools === 0),
  };
}
