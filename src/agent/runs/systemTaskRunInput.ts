import type {
  AgentRunContext,
  AgentRunExecutionOptions,
  AgentRunInput,
  AgentRunMessage,
} from '../service/AgentRunContracts.js';

/**
 * run helper 可选接收的宿主取消/期限信号（L8-C01）。三项都只是原样写入
 * AgentRunInput.execution，由既有消费点处理：
 * - AgentService：非 fan-out run 开工前检查 abortSignal/shouldAbort，命中时返回 aborted/timeout
 *   并记录 `run_*_before_execution` 诊断；
 * - AgentRunCoordinator：fan-out 时父 execution 原样复制给每个 child，并在每个 child 派发前检查
 *   abortSignal/shouldAbort，命中时 child 记为 child-run-aborted；
 * - AgentRuntime：运行中响应 abortSignal，timeoutMs 作为本次 run 的期限。
 * 注意 fan-out 下 timeoutMs 是每个 child run 的期限，不是整个 fan-out 的总期限。
 * helper 不自行判断、不短路，所以这里不会出现新的静默中止分支。
 */
export type SystemTaskRunSignals = Pick<
  AgentRunExecutionOptions,
  'abortSignal' | 'shouldAbort' | 'timeoutMs'
>;

export interface SystemTaskRunInputParts {
  profileId: string;
  params: Record<string, unknown>;
  message: AgentRunMessage;
  context: AgentRunContext;
  /**
   * helper 自有的执行选项（budgetOverride / toolChoiceOverride）。旧版有 execution 键的 helper
   * 继续传入（包括空对象），旧版没有 execution 键的 helper 不传。
   */
  execution?: AgentRunExecutionOptions;
  signals?: SystemTaskRunSignals;
}

/**
 * 统一组装系统任务 run 的 AgentRunInput。兼容性约束：不传任何信号时，返回对象的键、键顺序与
 * 各 helper 旧版字面量逐项一致——旧版带 execution 的仍带同样内容，旧版不带的仍不出现 execution 键；
 * 只有宿主真的传入信号时才把它们并入 execution。
 */
export function buildSystemTaskRunInput({
  profileId,
  params,
  message,
  context,
  execution,
  signals,
}: SystemTaskRunInputParts): AgentRunInput {
  const signalOptions = stripUndefined({
    abortSignal: signals?.abortSignal,
    shouldAbort: signals?.shouldAbort,
    timeoutMs: signals?.timeoutMs,
  });
  const hasSignals = Object.keys(signalOptions).length > 0;
  const mergedExecution: AgentRunExecutionOptions | undefined =
    execution || hasSignals ? { ...(execution ?? {}), ...signalOptions } : undefined;
  return {
    profile: { id: profileId },
    params,
    message,
    context,
    ...(mergedExecution ? { execution: mergedExecution } : {}),
    presentation: { responseShape: 'system-task-result' },
  };
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
