import { randomUUID } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { AgentRunCoordinator } from '../coordination/AgentRunCoordinator.js';
import { AgentProfileCompiler } from '../profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../profiles/AgentStageFactoryRegistry.js';
import { AgentMessage, Channel } from '../runtime/AgentMessage.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunStatus,
  AgentRuntimeBuildOptions,
  AgentRuntimeLike,
  AgentRuntimeRunOptions,
  AgentRuntimeSource,
  CompiledAgentProfile,
} from './AgentRunContracts.js';
import type { AgentRuntimeBuilder } from './AgentRuntimeBuilder.js';

interface AgentRuntimeBuilderLike {
  build(
    profile: AgentRunInput['profile'] | CompiledAgentProfile,
    options?: AgentRuntimeBuildOptions
  ): AgentRuntimeLike;
}

export interface AgentServiceOptions {
  runtimeBuilder: AgentRuntimeBuilder | AgentRuntimeBuilderLike;
  profileCompiler?: AgentProfileCompiler;
  runCoordinator?: AgentRunCoordinator;
}

export class AgentService {
  #runtimeBuilder: AgentRuntimeBuilderLike;
  #profileCompiler: AgentProfileCompiler;
  #runCoordinator: AgentRunCoordinator;
  #logger = Logger.getInstance();

  constructor({ runtimeBuilder, profileCompiler, runCoordinator }: AgentServiceOptions) {
    this.#runtimeBuilder = runtimeBuilder;
    this.#profileCompiler = profileCompiler || createDefaultProfileCompiler();
    this.#runCoordinator = runCoordinator || new AgentRunCoordinator();
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    validateRunInput(input);
    const compiledProfile = this.#profileCompiler.compile(input.profile, {
      params: input.params,
      context: input.context,
    });
    const trace = describeRun(input, compiledProfile.id);
    const startedAt = Date.now();
    this.#logger.info(`[AgentService] run start ${formatRunTrace(trace)}`, trace);
    if (this.#runCoordinator.canCoordinate(compiledProfile)) {
      try {
        this.#logger.info(`[AgentService] coordinated run start ${formatRunTrace(trace)}`, {
          ...trace,
          concurrencyMode: compiledProfile.concurrency?.mode || null,
        });
        const coordinated = await this.#runCoordinator.run(input, compiledProfile, (childInput) =>
          this.run(childInput)
        );
        if (coordinated) {
          this.#logger.info(`[AgentService] coordinated run complete ${formatRunTrace(trace)}`, {
            ...trace,
            durationMs: Date.now() - startedAt,
            status: coordinated.status,
            toolCallCount: coordinated.toolCalls.length,
          });
          return coordinated;
        }
      } catch (err: unknown) {
        this.#logger.warn(`[AgentService] coordinated run failed ${formatRunTrace(trace)}`, {
          ...trace,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
    const runtime = this.#runtimeBuilder.build(compiledProfile, {
      lang: input.context.lang || null,
      onProgress: input.execution?.onProgress || null,
      onToolCall: input.execution?.onToolCall || null,
    });
    if (input.context.fileCache !== undefined) {
      runtime.setFileCache?.(input.context.fileCache);
    }
    const message = buildAgentMessage(input);
    try {
      // 冷启动监控依赖这里把“维度 child run 已进入 AgentRuntime”明确打出来。
      // 仅靠 GenerateTaskManager 的 filling 状态看不出是在排队、模型请求中还是已失败待收口。
      this.#logger.info(`[AgentService] runtime execute start ${formatRunTrace(trace)}`, {
        ...trace,
        runtimeSource: input.context.runtimeSource || runtimeSourceFor(input.context.source),
      });
      const result = await runtime.execute(message, buildRuntimeOptions(input));
      const status = inferRunStatus(result.reply || '');
      this.#logger.info(`[AgentService] runtime execute complete ${formatRunTrace(trace)}`, {
        ...trace,
        durationMs: Date.now() - startedAt,
        status,
        iterations: result.iterations || 0,
        toolCallCount: result.toolCalls?.length || 0,
        cancelReason: getDiagnosticsCancelReason(result.diagnostics),
        aiErrorCount: getDiagnosticsAiErrorCount(result.diagnostics),
      });
      return {
        runId: runtime.id || randomUUID(),
        profileId: compiledProfile.id,
        reply: result.reply || '',
        status,
        phases: result.phases,
        toolCalls: result.toolCalls || [],
        usage: {
          inputTokens: result.tokenUsage?.input || 0,
          outputTokens: result.tokenUsage?.output || 0,
          iterations: result.iterations || 0,
          durationMs: result.durationMs || 0,
        },
        diagnostics: result.diagnostics || null,
      };
    } catch (err: unknown) {
      this.#logger.warn(`[AgentService] runtime execute failed ${formatRunTrace(trace)}`, {
        ...trace,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        status: inferErrorStatus(err),
      });
      return {
        runId: runtime.id || randomUUID(),
        profileId: compiledProfile.id,
        reply: err instanceof Error ? err.message : String(err),
        status: inferErrorStatus(err),
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
  }
}

function validateRunInput(input: AgentRunInput) {
  if (!input.profile) {
    throw new Error('AgentRunInput.profile is required');
  }
  if (!input.message?.content) {
    throw new Error('AgentRunInput.message.content is required');
  }
  if (!input.context?.source) {
    throw new Error('AgentRunInput.context.source is required');
  }
}

function buildAgentMessage(input: AgentRunInput) {
  const metadataContext = getRecord(input.message.metadata?.context);
  const promptContext = {
    ...metadataContext,
    ...(input.context.promptContext || {}),
  };
  return new AgentMessage({
    content: input.message.content,
    channel: toChannel(input.context.source),
    session: {
      id: input.message.sessionId || input.context.actor?.sessionId || randomUUID(),
      history: input.message.history || [],
    },
    sender: {
      id: input.context.actor?.user || 'agent-runner',
      type:
        input.message.role === 'system' || input.message.role === 'internal' ? 'system' : 'user',
    },
    metadata: stripProfileSelectionMetadata({
      ...(input.message.metadata || {}),
      ...(Object.keys(promptContext).length > 0 ? { context: promptContext } : {}),
      source: input.context.source,
      stream: input.presentation?.stream || false,
    }),
  });
}

function buildRuntimeOptions(input: AgentRunInput): AgentRuntimeRunOptions {
  const systemRunContext = input.context.systemRunContext;
  const projectedScopeId =
    systemRunContext?.scopeId ||
    (typeof input.context.sharedState?._dimensionScopeId === 'string'
      ? input.context.sharedState._dimensionScopeId
      : undefined);
  return {
    abortSignal: input.execution?.abortSignal,
    diagnostics: input.execution?.diagnostics,
    strategyContext: input.context.strategyContext,
    systemRunContext: input.context.systemRunContext,
    budgetOverride: input.execution?.budgetOverride,
    toolChoiceOverride: input.execution?.toolChoiceOverride,
    groundingEnforcement: input.execution?.groundingEnforcement,
    contextWindow: input.context.contextWindow,
    trace: input.context.trace,
    memoryCoordinator: input.context.memoryCoordinator,
    sharedState: input.context.sharedState,
    context: {
      ...(input.context.promptContext || {}),
      ...(projectedScopeId ? { dimensionScopeId: projectedScopeId } : {}),
    },
    source: input.context.runtimeSource || runtimeSourceFor(input.context.source),
  };
}

function runtimeSourceFor(source: AgentRunInput['context']['source']): AgentRuntimeSource {
  if (source === 'http-chat' || source === 'http-stream') {
    return 'user';
  }
  if (source === 'mcp' || source === 'bootstrap' || source === 'system-workflow') {
    return 'system';
  }
  return 'system';
}

function stripProfileSelectionMetadata(metadata: Record<string, unknown>) {
  const { mode: _mode, preset: _preset, profile: _profile, ...rest } = metadata;
  return rest;
}

function toChannel(source: AgentRunInput['context']['source']) {
  if (source === 'mcp') {
    return Channel.MCP;
  }
  if (source === 'internal' || source === 'system-workflow' || source === 'bootstrap') {
    return Channel.INTERNAL;
  }
  return Channel.HTTP;
}

function inferRunStatus(reply: string): AgentRunStatus {
  return reply ? 'success' : 'error';
}

function inferErrorStatus(err: unknown): AgentRunStatus {
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout/i.test(message)) {
    return 'timeout';
  }
  if (/abort/i.test(message)) {
    return 'aborted';
  }
  if (/forbidden|blocked|denied/i.test(message)) {
    return 'blocked';
  }
  return 'error';
}

function createDefaultProfileCompiler() {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry(),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}

function describeRun(input: AgentRunInput, profileId: string): Record<string, unknown> {
  const promptContext = getRecord(input.context.promptContext);
  const sharedState = getRecord(input.context.sharedState);
  const dimensionMeta = getRecord(sharedState._dimensionMeta);
  return {
    profileId,
    source: input.context.source,
    runtimeSource: input.context.runtimeSource || null,
    sessionId:
      stringValue(input.message.sessionId) ||
      stringValue(input.message.metadata?.sessionId) ||
      stringValue(input.context.actor?.sessionId) ||
      null,
    dimension:
      stringValue(input.params?.dimId) ||
      stringValue(input.message.metadata?.dimension) ||
      stringValue(promptContext.dimensionId) ||
      stringValue(promptContext.dimId) ||
      stringValue(dimensionMeta.id) ||
      null,
    phase: stringValue(input.message.metadata?.phase) || null,
  };
}

function formatRunTrace(trace: Record<string, unknown>): string {
  const parts = [
    `profile=${trace.profileId || 'unknown'}`,
    trace.dimension ? `dim=${trace.dimension}` : '',
    trace.sessionId ? `session=${trace.sessionId}` : '',
    trace.phase ? `phase=${trace.phase}` : '',
    trace.source ? `source=${trace.source}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

function getDiagnosticsCancelReason(diagnostics: unknown): string | null {
  const efficiency = getRecord(getRecord(diagnostics).efficiency);
  return stringValue(efficiency.cancelReason) || null;
}

function getDiagnosticsAiErrorCount(diagnostics: unknown): number | null {
  const value = getRecord(diagnostics).aiErrorCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export default AgentService;
