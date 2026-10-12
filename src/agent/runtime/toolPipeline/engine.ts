/** 正序 before/execute/after 执行器；执行端口由入口注入，不能反向导入默认工厂或业务中间件。 */
// toolOutcomes 是无依赖的回执语义单源（不是工厂或中间件），blocked 归一必须与 Runtime 用同一判定。
import { readToolObservation } from '../../utils/toolOutcomes.js';
import type {
  ToolCall,
  ToolExecutor,
  ToolMetadata,
  ToolMiddleware,
  ToolPipelineContext,
} from './contracts.js';

/** blocked 结果被包装为失败 payload 时记录的诊断码。 */
const TOOL_BLOCKED_RESULT_NORMALIZED = 'TOOL_BLOCKED_RESULT_NORMALIZED';

interface ToolPipelineResultState {
  result: unknown;
  hasResult: boolean;
}

interface FailedToolReceipt {
  call: ToolCall;
  result: unknown;
  metadata: ToolMetadata;
}
// 后置处理失败不撤销执行回执。每次Runtime调用使用独立context；同一Error跨运行复用时
// 仍按context和call身份隔离，绝不采信外部Error自带的partialResult/receipt字段。
const failedReceipts = new WeakMap<Error, WeakMap<object, FailedToolReceipt>>();

export function takeToolPipelineFailure(
  error: unknown,
  context: ToolPipelineContext,
  call: ToolCall
): FailedToolReceipt | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const byContext = failedReceipts.get(error);
  const receipt = byContext?.get(context);
  if (!receipt || receipt.call !== call) {
    return undefined;
  }
  byContext?.delete(context);
  return receipt;
}

function diagnosticReason(result: unknown) {
  if (result && typeof result === 'object' && 'error' in result) {
    return String((result as { error?: unknown }).error || 'blocked');
  }
  return 'blocked';
}

/** 宿主日志器失败（同步抛错或异步拒绝）不能让已确定的 blocked 结果变成执行失败。 */
function warnSafely(context: ToolPipelineContext, message: string): void {
  try {
    const pending: unknown = context.runtime.logger?.warn(message);
    if (pending && typeof (pending as { then?: unknown }).then === 'function') {
      void Promise.resolve(pending).catch(() => undefined);
    }
  } catch (err: unknown) {
    // 日志只是诊断旁路；吞掉宿主日志器异常，blocked 结果本身已经归一完成。
    void err;
  }
}

/**
 * I44：blocked 的 before 结果必须本身表达失败。metadata.blocked 不进入回执，AgentRuntime、
 * ctx.toolCalls 下游（PCV、证据计数、hasPersistedCandidate）和 onToolCall 观察者只读 payload；
 * 若中间件返回成功形结果或 undefined，就在这里包装为失败 payload，让所有成功判定一致，
 * 也避免回执投影对 undefined 抛 TypeError。已表达失败的结果（内置门都带 error）保持原对象身份。
 */
function normalizeBlockedResult<Context extends ToolPipelineContext>(
  middlewareName: string,
  call: ToolCall,
  result: unknown,
  context: Context,
  metadata: ToolMetadata
): unknown {
  const missing = result === undefined;
  // 与 AgentRuntime 的 readToolObservation(createToolReceipt(...)).ok 使用同一输入形状。
  if (!missing && !readToolObservation({ ...call, result, envelope: metadata.envelope }).ok) {
    return result;
  }
  const reason = diagnosticReason(result);
  // 原结果只作为 data 保留供读回；顶层 error 让 readToolObservation 判失败，
  // status=blocked 让它不再把 data 当作业务 payload 下钻。
  const normalized = missing
    ? { error: reason, status: 'blocked' }
    : { error: reason, status: 'blocked', data: result };
  const warning = {
    code: TOOL_BLOCKED_RESULT_NORMALIZED,
    tool: call.name,
    message:
      `Middleware "${middlewareName}" blocked ${call.name} with ` +
      `${missing ? 'no result' : 'a success-shaped result'}; wrapped it as a failure payload ` +
      `(error="${reason}", status="blocked"${missing ? '' : ', original result kept in data'}) ` +
      'so runtime receipts and pipeline observers both read failure.',
  };
  if (context.loopCtx.diagnostics) {
    context.loopCtx.diagnostics.warn(warning);
  } else {
    warnSafely(context, `[ToolPipeline] ${warning.code}: ${warning.message}`);
  }
  return normalized;
}

async function runBeforeMiddlewares<Context extends ToolPipelineContext>(
  middlewares: readonly ToolMiddleware<Context>[],
  call: ToolCall,
  context: Context,
  metadata: ToolMetadata
): Promise<ToolPipelineResultState> {
  for (const mw of middlewares) {
    if (!mw.before) {
      continue;
    }
    const verdict = await mw.before(call, context, metadata);
    if (verdict?.blocked) {
      metadata.blocked = true;
      context.loopCtx.diagnostics?.recordBlockedTool(call.name, diagnosticReason(verdict.result));
      return {
        result: normalizeBlockedResult(mw.name, call, verdict.result, context, metadata),
        hasResult: true,
      };
    }
    if (verdict?.result !== undefined) {
      // 非 blocked 短路目前仍隐式记为缓存命中（公开语义）；改由短路中间件自行声明依赖待决事项②。
      metadata.cacheHit = true;
      return { result: verdict.result, hasResult: true };
    }
  }

  return { result: null, hasResult: false };
}

async function runAfterMiddlewares<Context extends ToolPipelineContext>(
  middlewares: readonly ToolMiddleware<Context>[],
  call: ToolCall,
  result: unknown,
  context: Context,
  metadata: ToolMetadata
): Promise<void> {
  for (const mw of middlewares) {
    if (mw.after) {
      await mw.after(call, result, context, metadata);
    }
  }
}
/** before 短路仍运行所有 after；自定义 hook 异常沿原契约向上传播。 */
export async function executeToolPipeline<Context extends ToolPipelineContext>(
  middlewares: readonly ToolMiddleware<Context>[],
  call: ToolCall,
  context: Context,
  executor: ToolExecutor<Context>
) {
  const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };

  const beforeState = await runBeforeMiddlewares(middlewares, call, context, metadata);
  const toolResult = beforeState.hasResult
    ? beforeState.result
    : await executor(call, context, metadata);

  try {
    await runAfterMiddlewares(middlewares, call, toolResult, context, metadata);
    context.loopCtx.diagnostics?.recordEfficiencyToolCall({
      cacheHit: metadata.cacheHit,
      cacheMiss: metadata.cacheMiss,
      duplicateShortCircuit: metadata.duplicateShortCircuit,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err), { cause: err });
    const byContext = failedReceipts.get(error) ?? new WeakMap<object, FailedToolReceipt>();
    byContext.set(context, { call, result: toolResult, metadata });
    failedReceipts.set(error, byContext);
    throw error;
  }

  return { result: toolResult, metadata };
}
