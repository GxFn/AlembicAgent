/** 唯一宿主路由边界：装配请求、保留共享对象身份、归一化 envelope 和异常。 */
import {
  projectToolResultOrdinaryOutput,
  type ToolCallRequest,
  type ToolResultEnvelope,
  type ToolResultStatus,
} from '#tools/kernel/index.js';
import { SafetyPolicy } from '../../policies/index.js';
import { toExecutableToolCall } from './callNormalization.js';
import type {
  ToolCall,
  ToolPipelineContext as ToolExecContext,
  ToolLoopPort,
  ToolMetadata,
} from './contracts.js';

const BLOCKING_ENVELOPE_STATUSES = new Set<ToolResultStatus>([
  'blocked',
  'needs-confirmation',
  'aborted',
  'timeout',
]);

function projectPipelineToolResult(envelope: ToolResultEnvelope): unknown {
  if (envelope.structuredContent !== undefined) {
    return envelope.structuredContent;
  }
  return projectToolResultOrdinaryOutput(envelope);
}

export async function executeRuntimeToolCall(
  call: ToolCall,
  context: ToolExecContext,
  metadata: ToolMetadata
): Promise<unknown> {
  // 单调时钟：墙钟回拨不能让 metadata.durationMs 变负（L3-C03）；取整保持整数毫秒。
  const t0 = performance.now();
  try {
    const request = buildRuntimeToolCallRequest(call, context);
    // SafetyPolicy及请求装配可能执行宿主代码；最后一道取消检查必须位于真实路由入口前。
    if (request.abortSignal?.aborted) {
      metadata.blocked = true;
      context.loopCtx.diagnostics?.recordCancelReason('abort_signal');
      context.loopCtx.diagnostics?.warn({
        code: 'TOOL_HOST_DISPATCH_CANCELLED',
        message: `Host dispatch of ${call.name} was cancelled before execution.`,
      });
      return { status: 'aborted', error: 'Tool call cancelled before host dispatch' };
    }
    const envelope = await context.runtime.toolRouter.execute(request);
    recordExecutedEnvelope(call, context, metadata, envelope);
    return projectPipelineToolResult(envelope);
  } catch (err: unknown) {
    const error =
      err instanceof Error && err.message
        ? err.message
        : typeof err === 'string' && err
          ? err
          : 'Tool execution failed';
    context.loopCtx.diagnostics?.warn({
      code: 'TOOL_HOST_EXECUTION_FAILED',
      message: `Host execution of ${call.name} failed before returning an envelope.`,
    });
    return { error };
  } finally {
    metadata.durationMs = Math.round(performance.now() - t0);
  }
}

function buildRuntimeToolCallRequest(call: ToolCall, context: ToolExecContext): ToolCallRequest {
  const { runtime, loopCtx } = context;
  const executableCall = toExecutableToolCall(call);
  const safetyPolicy = runtime.policies.get?.(SafetyPolicy) || null;

  return {
    toolId: executableCall.name,
    args: executableCall.args,
    surface: 'runtime',
    actor: { role: 'developer', user: runtime.id },
    source: {
      kind: 'runtime',
      name: resolvePipelineSourceName(context),
    },
    abortSignal: loopCtx.abortSignal || null,
    runtime: {
      allowedTools: Object.fromEntries(
        loopCtx.allowedToolIds.map((tool) => [
          tool,
          Object.hasOwn(loopCtx.allowedToolActions ?? {}, tool)
            ? [...loopCtx.allowedToolActions[tool]]
            : null,
        ])
      ),
      agentId: runtime.id,
      resourceScope: loopCtx.resourceScope,
      presetName: runtime.presetName,
      iteration: loopCtx.iteration || 0,
      policyValidator: runtime.policies,
      cache: loopCtx.memoryCoordinator || null,
      diagnostics: loopCtx.diagnostics || null,
      safetyPolicy,
      fileCache: runtime.fileCache,
      dataRoot: runtime.dataRoot,
      lang: runtime.lang,
      logger: runtime.logger || null,
      aiProvider: runtime.aiProvider || null,
      sharedState: loopCtx.sharedState || null,
      dimensionMeta: loopCtx.sharedState?._dimensionMeta || null,
      projectLanguage: resolveProjectLanguage(loopCtx),
      submittedTitles: loopCtx.sharedState?.submittedTitles || null,
      submittedPatterns: loopCtx.sharedState?.submittedPatterns || null,
      submittedTriggers: loopCtx.sharedState?.submittedTriggers || null,
      sessionToolCalls: projectSessionToolCalls(loopCtx),
      bootstrapDedup: loopCtx.sharedState?._bootstrapDedup || null,
      memoryCoordinator: loopCtx.memoryCoordinator || null,
      evidenceLedger: loopCtx.evidenceLedger || null,
      dimensionScopeId: resolveDimensionScopeId(loopCtx),
      currentRound: loopCtx.iteration || 0,
    },
  };
}

function resolvePipelineSourceName({ runtime, loopCtx }: ToolExecContext): string {
  if (typeof loopCtx.context?.pipelinePhase === 'string') {
    return loopCtx.context.pipelinePhase;
  }
  return loopCtx.source || runtime.presetName;
}

function resolveProjectLanguage(loopCtx: ToolLoopPort): string | null {
  const language = loopCtx.sharedState?._projectLanguage;
  return typeof language === 'string' ? language : null;
}

function resolveDimensionScopeId(loopCtx: ToolLoopPort): string | null {
  const scopeId = loopCtx.sharedState?._dimensionScopeId;
  return typeof scopeId === 'string' ? scopeId : null;
}

function projectSessionToolCalls(
  loopCtx: ToolLoopPort
): Array<{ tool: string; params?: Record<string, unknown> }> | null {
  if (!Array.isArray(loopCtx.toolCalls)) {
    return null;
  }

  return loopCtx.toolCalls.map((entry: { tool?: string; args?: unknown }) => ({
    tool: String(entry.tool || ''),
    params:
      entry.args && typeof entry.args === 'object'
        ? (entry.args as Record<string, unknown>)
        : undefined,
  }));
}

function recordExecutedEnvelope(
  call: ToolCall,
  context: ToolExecContext,
  metadata: ToolMetadata,
  envelope: ToolResultEnvelope
): void {
  metadata.envelope = envelope;
  metadata.cacheHit = envelope.cache?.hit === true;
  if (envelope.cache && envelope.cache.policy !== 'none' && envelope.cache.hit !== true) {
    metadata.cacheMiss = true;
  }
  if (!envelope.ok && BLOCKING_ENVELOPE_STATUSES.has(envelope.status)) {
    metadata.blocked = true;
    context.loopCtx.diagnostics?.recordBlockedTool(call.name, envelope.text);
  }
}
