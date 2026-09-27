/** 正序 before/execute/after 执行器；执行端口由入口注入，不能反向导入默认工厂或业务中间件。 */
import type {
  ToolCall,
  ToolExecutor,
  ToolMetadata,
  ToolMiddleware,
  ToolPipelineContext,
} from './contracts.js';

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
      return { result: verdict.result, hasResult: true };
    }
    if (verdict?.result !== undefined) {
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
