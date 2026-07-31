import { randomUUID } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { AgentRunCoordinator } from '../coordination/AgentRunCoordinator.js';
import {
  assertStrictTestDimensionAgentExecutionReceiptV1,
  assertStrictTestDimensionProductionRuntimePortBindingV1,
  type StrictTestDimensionAgentExecutionReceiptV1,
  type StrictTestDimensionProductionRuntimePortV1,
} from '../production/StrictTestDimensionAgentContract.js';
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
    let strictTestBinding: StrictTestDimensionProductionRuntimePortV1 | null;
    try {
      strictTestBinding = readStrictTestBinding(input, compiledProfile);
    } catch (err: unknown) {
      this.#logger.warn(`[AgentService] strict-test binding rejected ${formatRunTrace(trace)}`, {
        ...trace,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return failedRunResult(compiledProfile.id, readStrictTestRunIdCandidate(input), err);
    }
    const strictTestRunId = strictTestBinding?.strictTestAuthority.runId;
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
      ...(strictTestRunId ? { runId: strictTestRunId } : {}),
      lang: input.context.lang || null,
      onProgress: input.execution?.onProgress || null,
      onToolCall: input.execution?.onToolCall || null,
    });
    if (input.context.fileCache !== undefined) {
      runtime.setFileCache?.(input.context.fileCache);
    }
    const message = buildAgentMessage(input);
    try {
      if (strictTestRunId && runtime.id !== strictTestRunId) {
        throw new Error('STRICT_TEST_DIMENSION_AGENT_RUNTIME_RUN_MISMATCH');
      }
      // 冷启动监控依赖这里把“维度 child run 已进入 AgentRuntime”明确打出来。
      // 仅靠 GenerateTaskManager 的 filling 状态看不出是在排队、模型请求中还是已失败待收口。
      this.#logger.info(`[AgentService] runtime execute start ${formatRunTrace(trace)}`, {
        ...trace,
        runtimeSource: input.context.runtimeSource || runtimeSourceFor(input.context.source),
      });
      const result = await runtime.execute(message, buildRuntimeOptions(input));
      const strictTestExecutionReceipt = strictTestBinding
        ? assertStrictTestSuccessfulResult(strictTestBinding, runtime, result)
        : result.strictTestExecutionReceipt;
      const status = strictTestBinding
        ? ('success' as const)
        : inferRunStatus(result.reply || '', result.outcome);
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
        ...(strictTestExecutionReceipt ? { strictTestExecutionReceipt } : {}),
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

type AgentRuntimeExecutionResult = Awaited<ReturnType<AgentRuntimeLike['execute']>>;

/**
 * 完整 strict-test binding 是 AgentService 的成功判定边界；普通 strictProduction hints
 * 保持既有语义，不会被误提升成 automatic-selection authority。
 */
function readStrictTestBinding(
  input: AgentRunInput,
  compiledProfile: CompiledAgentProfile
): StrictTestDimensionProductionRuntimePortV1 | null {
  const strictProductionValue = input.context.strategyContext?.strictProduction;
  if (
    !strictProductionValue ||
    typeof strictProductionValue !== 'object' ||
    Array.isArray(strictProductionValue)
  ) {
    return null;
  }
  const strictProduction = strictProductionValue as Record<string, unknown>;
  const hasAuthority = Object.hasOwn(strictProduction, 'strictTestAuthority');
  const hasEligibleCells = Object.hasOwn(strictProduction, 'eligibleCells');
  if (!hasAuthority && !hasEligibleCells) {
    return null;
  }
  if (!hasAuthority || !hasEligibleCells) {
    throw new Error('STRICT_TEST_DIMENSION_RUNTIME_BINDING_INCOMPLETE');
  }
  assertStrictTestDimensionProductionRuntimePortBindingV1(
    strictProduction as unknown as StrictTestDimensionProductionRuntimePortV1
  );
  assertStrictTestCompiledProfile(compiledProfile);
  return strictProduction as unknown as StrictTestDimensionProductionRuntimePortV1;
}

/** strict authority 只能走 registry 编译出的 canonical generate-dimension 四段主链。 */
function assertStrictTestCompiledProfile(compiledProfile: CompiledAgentProfile): void {
  const strategy = getRecord(compiledProfile.runtimeOverrides.strategy);
  const stages = Array.isArray(strategy.stages) ? strategy.stages : [];
  const expectedStages = [
    { name: 'analyze', strictRoleSurface: 'strict-analyst-v1', gate: null },
    { name: 'analyst_fixpoint_gate', strictRoleSurface: null, gate: 'G1' },
    { name: 'produce', strictRoleSurface: 'strict-producer-v1', gate: null },
    { name: 'independent_review_gate', strictRoleSurface: null, gate: 'G2' },
  ] as const;
  if (
    compiledProfile.id !== 'generate-dimension' ||
    compiledProfile.basePreset !== 'insight' ||
    compiledProfile.projection !== 'agent-result' ||
    compiledProfile.actionSpace.mode !== 'none' ||
    strategy.type !== 'pipeline' ||
    stages.length !== expectedStages.length
  ) {
    throw new Error('STRICT_TEST_DIMENSION_AGENT_PROFILE_INVALID');
  }
  for (let index = 0; index < expectedStages.length; index += 1) {
    const stage = getRecord(stages[index]);
    const expected = expectedStages[index];
    const gate = getRecord(stage.gate);
    const strictGate = getRecord(gate.strictGate);
    if (
      !expected ||
      stage.name !== expected.name ||
      (expected.strictRoleSurface
        ? stage.strictRoleSurface !== expected.strictRoleSurface || Object.hasOwn(stage, 'gate')
        : typeof gate.evaluator !== 'function' ||
          gate.useCumulativeToolCalls === true ||
          strictGate.gate !== expected.gate)
    ) {
      throw new Error('STRICT_TEST_DIMENSION_AGENT_PROFILE_INVALID');
    }
  }
}

/**
 * strict-test 的非空 reply 不是成功证据。只有同 run completed pipeline 与 canonical receipt
 * 同时满足 request authority 身份，AgentService 才能投影 success。
 */
function assertStrictTestSuccessfulResult(
  binding: StrictTestDimensionProductionRuntimePortV1,
  runtime: AgentRuntimeLike,
  result: AgentRuntimeExecutionResult
): StrictTestDimensionAgentExecutionReceiptV1 {
  const authority = binding.strictTestAuthority;
  const pipelineOutcome = getRecord(result.phases?._pipelineOutcome);
  if (
    runtime.id !== authority.runId ||
    result.outcome !== 'completed' ||
    pipelineOutcome.outcome !== 'completed'
  ) {
    throw new Error('STRICT_TEST_DIMENSION_AGENT_PIPELINE_NOT_COMPLETED');
  }
  const receipt = result.strictTestExecutionReceipt;
  if (!receipt) {
    throw new Error('STRICT_TEST_DIMENSION_AGENT_EXECUTION_RECEIPT_REQUIRED');
  }
  const pipelineExecution = receipt.pipelineExecution;
  if (
    receipt.runId !== authority.runId ||
    receipt.authorityHash !== authority.authorityHash ||
    receipt.selectedCellSetHash !== authority.selectedCellSetHash ||
    !sameStrings(receipt.selectedCellIds, authority.selectedCellIds) ||
    receipt.authority.authorityHash !== authority.authorityHash ||
    pipelineExecution?.runId !== authority.runId ||
    pipelineExecution.authorityHash !== authority.authorityHash ||
    pipelineExecution.selectedCellSetHash !== authority.selectedCellSetHash
  ) {
    throw new Error('STRICT_TEST_DIMENSION_AGENT_EXECUTION_RECEIPT_IDENTITY_MISMATCH');
  }
  if (receipt.segmentStatus !== 'completed') {
    throw new Error('STRICT_TEST_DIMENSION_AGENT_EXECUTION_NOT_COMPLETED');
  }
  assertStrictTestDimensionAgentExecutionReceiptV1(
    receipt,
    pipelineExecution.reviewStageEvidence.expectedTrustPolicies
  );
  return receipt;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function failedRunResult(
  profileId: string,
  runId: string | undefined,
  err: unknown
): AgentRunResult {
  return {
    runId: runId || randomUUID(),
    profileId,
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

function inferRunStatus(reply: string, pipelineOutcome?: string): AgentRunStatus {
  if (pipelineOutcome === 'failed') {
    return 'error';
  }
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

function readStrictTestRunIdCandidate(input: AgentRunInput): string | undefined {
  const strictProduction = getRecord(input.context.strategyContext?.strictProduction);
  const authority = getRecord(strictProduction.strictTestAuthority);
  return stringValue(authority.runId);
}

export default AgentService;
