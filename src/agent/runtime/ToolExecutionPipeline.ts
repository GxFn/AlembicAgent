/**
 * ToolExecutionPipeline — 工具执行的中间件管道
 *
 * 将 reactLoop 中 ~120 行的工具执行逻辑拆分为独立中间件:
 *   before → execute → after
 *
 * 每个中间件负责一个横切关注点:
 *   1. EventBusPublisher — 事件发布
 *   2. ProgressEmitter — 进度回调
 *   3. AllowlistGate — 当前 capability 白名单拦截
 *   4. EvolutionDecisionGate — Evolution retry 仅允许 knowledge.manage 决策
 *   5. ObservationRecord — 记忆记录
 *   6. TrackerSignal — ExplorationTracker 信号收集
 *   7. TraceRecord — ActiveContext 推理链记录
 *   8. SubmitTracker — 提交成功后登记会话状态
 *
 * @module core/ToolExecutionPipeline
 */

import type { ToolCapabilityManifest } from '#tools/catalog/CapabilityManifest.js';
import {
  projectToolResultOrdinaryOutput,
  type ToolCallRequest,
  type ToolResultEnvelope,
  type ToolResultStatus,
} from '#tools/runtime/ToolRuntimeBridge.js';
import { SafetyPolicy } from '../policies/index.js';
import type { AgentRuntime } from './AgentRuntime.js';
import type { LoopContext } from './LoopContext.js';

/** 工具调用描述 */
interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** 工具执行上下文 */
interface ToolExecContext {
  runtime: AgentRuntime;
  loopCtx: LoopContext;
  iteration: number;
}

/** 工具执行元数据 */
interface ToolMetadata {
  cacheHit: boolean;
  blocked: boolean;
  isNew: boolean;
  durationMs: number;
  dedupMessage?: string;
  isSubmit?: boolean;
  envelope?: ToolResultEnvelope;
  duplicateShortCircuit?: boolean;
  cacheEligible?: boolean;
  cacheMiss?: boolean;
  cacheKey?: string;
}

/** before 钩子返回值 */
interface BeforeVerdict {
  blocked?: boolean;
  result?: unknown;
}

function diagnosticReason(result: unknown) {
  if (result && typeof result === 'object' && 'error' in result) {
    return String((result as { error?: unknown }).error || 'blocked');
  }
  return 'blocked';
}

function projectPipelineToolResult(envelope: ToolResultEnvelope): unknown {
  if (envelope.structuredContent !== undefined) {
    return envelope.structuredContent;
  }
  return projectToolResultOrdinaryOutput(envelope);
}

function isDirectNoteFindingCall(call: ToolCall) {
  return call.name === 'note_finding';
}

function toExecutableToolCall(call: ToolCall): ToolCall {
  if (!isDirectNoteFindingCall(call)) {
    return call;
  }
  return {
    ...call,
    name: 'memory',
    args: {
      action: 'note_finding',
      params: {
        finding: call.args.finding,
        evidence: call.args.evidence,
        importance: call.args.importance,
      },
    },
  };
}

/** 工具中间件 */
interface ToolMiddleware {
  name: string;
  before?: (
    call: ToolCall,
    ctx: ToolExecContext,
    metadata: ToolMetadata
  ) => BeforeVerdict | undefined | Promise<BeforeVerdict | undefined>;
  after?: (
    call: ToolCall,
    result: unknown,
    ctx: ToolExecContext,
    metadata: ToolMetadata
  ) => void | Promise<void>;
}

interface CachedToolResult {
  result: unknown;
  envelope?: ToolResultEnvelope;
}

interface ToolPipelineResultState {
  result: unknown;
  hasResult: boolean;
}

interface ToolEfficiencySharedState {
  _toolEfficiencyCache?: Map<string, CachedToolResult>;
  _producerSubmitLedger?: ProducerSubmitLedger;
  _projectSnapshotId?: unknown;
  _projectRevision?: unknown;
  _workspaceRevision?: unknown;
  _dimensionScopeId?: unknown;
}

interface ProducerSubmitLedgerEntry {
  id?: string;
  payloadStored: boolean;
  requiredFieldsComplete: boolean;
  sourceCount: number;
  status: string;
  title: string;
  trigger?: string;
}

interface ProducerSubmitLedger {
  createdCount: number;
  entries: ProducerSubmitLedgerEntry[];
  targetSubmits?: number;
}

const READ_LIKE_ACTIONS = new Set([
  'detail',
  'get_previous_evidence',
  'inspect',
  'list',
  'outline',
  'overview',
  'query',
  'read',
  'recall',
  'review',
  'search',
  'structure',
  'tools',
]);

const SIDE_EFFECT_ACTIONS = new Set([
  'approve',
  'create',
  'delete',
  'deprecate',
  'evolve',
  'manage',
  'mutate',
  'note_finding',
  'publish',
  'reject',
  'run',
  'save',
  'score',
  'script',
  'shell',
  'skip_evolution',
  'submit',
  'update',
  'validate',
  'write',
]);

const BLOCKING_ENVELOPE_STATUSES = new Set<ToolResultStatus>([
  'blocked',
  'needs-confirmation',
  'aborted',
  'timeout',
]);
const MAX_TOOL_ARG_BYTES = 256_000;
const TOOL_ARGS_INVALID_CODE = 'TOOL_ARGS_INVALID';
const TOOL_ARGS_TOO_LARGE_CODE = 'TOOL_ARGS_TOO_LARGE';

function getToolAction(call: ToolCall): string {
  const params =
    call.args?.params && typeof call.args.params === 'object'
      ? (call.args.params as Record<string, unknown>)
      : {};
  const action = call.args?.action ?? params.action ?? params.operation ?? '';
  return String(action);
}

function getToolManifest(runtime: AgentRuntime, toolId: string): ToolCapabilityManifest | null {
  const registry = runtime.toolRegistry as {
    getManifest?: (id: string) => ToolCapabilityManifest | null | undefined;
  };
  return registry.getManifest?.(toolId) ?? null;
}

function isReadLikeManifest(manifest: ToolCapabilityManifest | null): boolean {
  if (!manifest) {
    return false;
  }
  return (
    !manifest.risk.sideEffect &&
    manifest.risk.writeScope === 'none' &&
    manifest.risk.network === 'none' &&
    manifest.risk.credentialAccess === 'none' &&
    manifest.governance.policyProfile !== 'write' &&
    manifest.governance.policyProfile !== 'admin'
  );
}

function isDeterministicDuplicateCandidate(call: ToolCall, ctx: ToolExecContext): boolean {
  const action = getToolAction(call);
  if (SIDE_EFFECT_ACTIONS.has(action)) {
    return false;
  }
  const manifest = getToolManifest(ctx.runtime, call.name);
  if (manifest && manifest.execution.concurrency === 'exclusive') {
    return false;
  }
  if (READ_LIKE_ACTIONS.has(action)) {
    return true;
  }
  return isReadLikeManifest(manifest);
}

function getEfficiencyCache(ctx: ToolExecContext): Map<string, CachedToolResult> {
  const shared = (ctx.loopCtx.sharedState ??= {}) as ToolEfficiencySharedState;
  shared._toolEfficiencyCache ??= new Map<string, CachedToolResult>();
  return shared._toolEfficiencyCache;
}

function cloneCacheValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value instanceof Set) {
    return stableStringify([...value].sort());
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right))
    );
    return stableStringify(entries);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function measureToolArgBytes(call: ToolCall): { ok: true; bytes: number } | { ok: false } {
  try {
    const serialized = String(stableStringify(call.args) ?? '');
    return { ok: true, bytes: new TextEncoder().encode(serialized).length };
  } catch {
    return { ok: false };
  }
}

function resolveProjectSnapshotId(ctx: ToolExecContext): string {
  const shared = (ctx.loopCtx.sharedState || {}) as ToolEfficiencySharedState;
  const context = ctx.loopCtx.context || {};
  const explicit =
    context.projectSnapshotId ??
    context.snapshotId ??
    context.projectRevision ??
    context.workspaceRevision ??
    shared._projectSnapshotId ??
    shared._projectRevision ??
    shared._workspaceRevision ??
    shared._dimensionScopeId;
  if (explicit) {
    return String(explicit);
  }
  if (Array.isArray(ctx.runtime.fileCache)) {
    const paths = ctx.runtime.fileCache
      .map((file) => `${file.relativePath}:${file.content?.length ?? 0}`)
      .sort()
      .join('|');
    return `file-cache:${ctx.runtime.fileCache.length}:${paths}`;
  }
  return 'session';
}

function buildCacheKey(call: ToolCall, ctx: ToolExecContext): string {
  const strategyParts = {
    source: ctx.loopCtx.source,
    pipelinePhase: ctx.loopCtx.context?.pipelinePhase,
    pipelineType: ctx.loopCtx.tracker?.pipelineType,
    preset: ctx.runtime.presetName,
  };
  return stableStringify({
    tool: call.name,
    action: getToolAction(call),
    args: call.args,
    snapshot: resolveProjectSnapshotId(ctx),
    strategy: strategyParts,
  });
}

async function runBeforeMiddlewares(
  middlewares: readonly ToolMiddleware[],
  call: ToolCall,
  context: ToolExecContext,
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

async function executeRuntimeToolCall(
  call: ToolCall,
  context: ToolExecContext,
  metadata: ToolMetadata
): Promise<unknown> {
  const t0 = Date.now();
  try {
    const envelope = await context.runtime.toolRouter.execute(
      buildRuntimeToolCallRequest(call, context)
    );
    recordExecutedEnvelope(call, context, metadata, envelope);
    return projectPipelineToolResult(envelope);
  } catch (err: unknown) {
    return { error: (err as Error).message };
  } finally {
    metadata.durationMs = Date.now() - t0;
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
      agentId: runtime.id,
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

function resolveProjectLanguage(loopCtx: LoopContext): string | null {
  const language = loopCtx.sharedState?._projectLanguage;
  return typeof language === 'string' ? language : null;
}

function resolveDimensionScopeId(loopCtx: LoopContext): string | null {
  const scopeId = loopCtx.sharedState?._dimensionScopeId;
  return typeof scopeId === 'string' ? scopeId : null;
}

function projectSessionToolCalls(
  loopCtx: LoopContext
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

async function runAfterMiddlewares(
  middlewares: readonly ToolMiddleware[],
  call: ToolCall,
  result: unknown,
  context: ToolExecContext,
  metadata: ToolMetadata
): Promise<void> {
  for (const mw of middlewares) {
    if (mw.after) {
      await mw.after(call, result, context, metadata);
    }
  }
}

export class ToolExecutionPipeline {
  #middlewares: ToolMiddleware[] = [];

  /** 注册中间件 */
  use(middleware: ToolMiddleware) {
    this.#middlewares.push(middleware);
    return this;
  }

  /**
   * 执行单个工具调用
   *
   * 执行流:
   *   1. 依次调用 before 钩子 — 任一返回 blocked/result 则短路
   *   2. 实际执行工具 (ToolRouter only)
   *   3. 依次调用 after 钩子
   *
   * @param call { name, args, id }
   * @param context { runtime, loopCtx, iteration }
   * @returns >}
   */
  async execute(call: ToolCall, context: ToolExecContext) {
    const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };

    const beforeState = await runBeforeMiddlewares(this.#middlewares, call, context, metadata);
    const toolResult = beforeState.hasResult
      ? beforeState.result
      : await executeRuntimeToolCall(call, context, metadata);

    await runAfterMiddlewares(this.#middlewares, call, toolResult, context, metadata);

    context.loopCtx.diagnostics?.recordEfficiencyToolCall({
      cacheHit: metadata.cacheHit,
      cacheMiss: metadata.cacheMiss,
      duplicateShortCircuit: metadata.duplicateShortCircuit,
    });

    return { result: toolResult, metadata };
  }
}

// ─────────────────────────────────────────────
//  预置中间件
// ─────────────────────────────────────────────

/**
 * AllowlistGate — 工具白名单守卫
 *
 * 防止 LLM hallucinate 不在当前 capability 允许列表中的工具调用。
 * 从 LoopContext.allowedToolIds 中提取允许的工具名列表，
 * 拒绝不在列表中的调用（返回 error 提示）。空数组表示严格禁用所有 capability 工具。
 *
 * before: 如果工具不在白名单中则短路返回 error
 */
export const allowlistGate = {
  name: 'allowlistGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const allowedNames = new Set(ctx.loopCtx?.allowedToolIds || []);
    if (isDirectNoteFindingCall(call) && isActionAllowed(ctx.loopCtx, 'memory', 'note_finding')) {
      return undefined;
    }
    if (!allowedNames.has(call.name)) {
      ctx.runtime.logger.warn(
        `[ToolPipeline] ⛔ Tool "${call.name}" not in allowlist — blocked (hallucinated call)`
      );
      const availableTools = [...allowedNames].slice(0, 5).join(', ');
      return {
        blocked: true,
        result: {
          error:
            allowedNames.size === 0
              ? `工具 "${call.name}" 不可用。当前阶段未开放任何工具。`
              : `工具 "${call.name}" 不可用。当前可用工具: ${availableTools}${allowedNames.size > 5 ? '...' : ''}`,
        },
      };
    }
    const action = getToolAction(call);
    if (action && !isActionAllowed(ctx.loopCtx, call.name, action)) {
      const allowedActions = ctx.loopCtx.allowedToolActions?.[call.name] || [];
      return {
        blocked: true,
        result: {
          error: `Action "${call.name}.${action}" is not available in the current stage. Allowed actions for "${call.name}": ${allowedActions.join(', ')}`,
        },
      };
    }
    return undefined;
  },
};

/** ToolArgumentBoundsGate — reject oversized or unserializable model-provided tool args. */
export const toolArgumentBoundsGate = {
  name: 'toolArgumentBoundsGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const measurement = measureToolArgBytes(call);
    if (!measurement.ok) {
      ctx.loopCtx.diagnostics?.warn({
        code: TOOL_ARGS_INVALID_CODE,
        message: `Tool ${call.name} arguments could not be serialized for validation`,
      });
      return {
        blocked: true,
        result: {
          error: 'Tool arguments could not be serialized',
          code: TOOL_ARGS_INVALID_CODE,
          maxBytes: MAX_TOOL_ARG_BYTES,
        },
      };
    }
    if (measurement.bytes <= MAX_TOOL_ARG_BYTES) {
      return undefined;
    }
    ctx.loopCtx.diagnostics?.warn({
      code: TOOL_ARGS_TOO_LARGE_CODE,
      message: `Tool ${call.name} arguments exceed ${MAX_TOOL_ARG_BYTES} bytes`,
    });
    return {
      blocked: true,
      result: {
        error: `Tool arguments exceed ${MAX_TOOL_ARG_BYTES} bytes`,
        code: TOOL_ARGS_TOO_LARGE_CODE,
        sizeBytes: measurement.bytes,
        maxBytes: MAX_TOOL_ARG_BYTES,
      },
    };
  },
};

function isActionAllowed(loopCtx: LoopContext, toolName: string, actionName: string): boolean {
  const allowedNames = new Set(loopCtx?.allowedToolIds || []);
  if (!allowedNames.has(toolName)) {
    return false;
  }
  const allowedActions = loopCtx.allowedToolActions?.[toolName];
  return !allowedActions || allowedActions.includes(actionName);
}

/**
 * EvolutionDecisionGate — Evolution retry 决策补写阶段的动作级守卫。
 *
 * allowlist 只能限制到工具名（knowledge），但 retry 阶段需要更硬的约束：
 * 只允许 knowledge.manage(evolve/deprecate/skip_evolution)，禁止继续 search/detail/read。
 */
export const evolutionDecisionGate = {
  name: 'evolutionDecisionGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (ctx.loopCtx.sharedState?._evolutionDecisionOnly !== true) {
      return undefined;
    }

    const params = (call.args?.params as Record<string, unknown> | undefined) ?? call.args ?? {};
    const action = String(call.args?.action || '');
    const operation = String(params.operation || '');
    const allowedOperation =
      operation === 'evolve' || operation === 'deprecate' || operation === 'skip_evolution';

    if (call.name === 'knowledge' && action === 'manage' && allowedOperation && params.id) {
      return undefined;
    }

    return {
      blocked: true,
      result: {
        error:
          'Evolution retry is decision-only. Call knowledge({ action: "manage", params: { operation: "evolve|deprecate|skip_evolution", id, reason, data? } }) for each pending Recipe; search/detail/code/graph are disabled.',
      },
    };
  },
};

const RECORD_REPAIR_MEMORY_ACTIONS = new Set(['note_finding', 'recall', 'get_previous_evidence']);
const ANALYST_VERIFY_CODE_ACTIONS = new Set(['read', 'outline']);
const ANALYST_VERIFY_MEMORY_ACTIONS = new Set(['note_finding', 'recall', 'get_previous_evidence']);
const ANALYST_VERIFY_GRAPH_QUERY_TYPES = new Set([
  'class',
  'protocol',
  'hierarchy',
  'callers',
  'callees',
  'overrides',
  'extensions',
  'impact',
]);
const PRODUCER_CODE_ACTIONS = new Set(['read']);
const PRODUCER_KNOWLEDGE_ACTIONS = new Set(['submit']);
const PRODUCER_MEMORY_ACTIONS = new Set(['recall']);
const PRODUCER_META_ACTIONS = new Set(['review']);

function getToolParams(call: ToolCall): Record<string, unknown> {
  return call.args?.params && typeof call.args.params === 'object'
    ? (call.args.params as Record<string, unknown>)
    : {};
}

/**
 * RecordRepairOnlyGate — QualityGate record_repair 阶段的动作级守卫。
 *
 * record_repair 只能把既有分析证据补写进 memory，不允许继续探索、
 * 运行终端、提交知识或写入普通 memory.save。
 */
export const recordRepairOnlyGate = {
  name: 'recordRepairOnlyGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (ctx.loopCtx.sharedState?._recordRepairOnly !== true) {
      return undefined;
    }

    const action = getToolAction(call);
    if (
      isDirectNoteFindingCall(call) ||
      (call.name === 'memory' && RECORD_REPAIR_MEMORY_ACTIONS.has(action))
    ) {
      return undefined;
    }

    return {
      blocked: true,
      result: {
        error:
          'Record repair is note_finding-only. Use note_finding({ finding, evidence, importance }) to record verified findings; code/graph/terminal/knowledge and memory.save are disabled.',
      },
    };
  },
};

/**
 * AnalystVerifyOnlyGate — analyst VERIFY 阶段的动作级守卫。
 *
 * VERIFY 只确认已发现证据的路径/行号/符号/调用关系，不允许重新打开
 * 泛搜索、终端执行或知识提交面。
 */
export const analystVerifyOnlyGate = {
  name: 'analystVerifyOnlyGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (
      ctx.loopCtx.tracker?.pipelineType !== 'analyst' ||
      ctx.loopCtx.tracker?.phase !== 'VERIFY'
    ) {
      return undefined;
    }

    const action = getToolAction(call);
    const params = getToolParams(call);

    if (call.name === 'code' && ANALYST_VERIFY_CODE_ACTIONS.has(action)) {
      return undefined;
    }

    if (
      isDirectNoteFindingCall(call) ||
      (call.name === 'memory' && ANALYST_VERIFY_MEMORY_ACTIONS.has(action))
    ) {
      return undefined;
    }

    if (call.name === 'graph' && action === 'query') {
      const queryType = String(params.type ?? call.args?.type ?? '');
      const hasFocusedEntity = Boolean(
        params.entity || params.symbol || params.name || params.path || call.args?.entity
      );
      if (ANALYST_VERIFY_GRAPH_QUERY_TYPES.has(queryType) && hasFocusedEntity) {
        return undefined;
      }
    }

    return {
      blocked: true,
      result: {
        error:
          'Analyst VERIFY is evidence-only. Use code.read/code.outline, focused graph.query(class|protocol|hierarchy|callers|callees|overrides|extensions|impact with entity/path), or note_finding / memory.recall / memory.get_previous_evidence; broad search, terminal, knowledge, and unrelated writes are disabled.',
      },
    };
  },
};

/**
 * ProducerSubmitOnlyGate — Producer 阶段只允许推进候选覆盖率的动作。
 *
 * Package Q 暴露了一个失败路径：成功提交 1 个候选后，模型继续调用
 * knowledge.detail / meta.tools 消耗轮次，触发 idle 退出并丢失剩余结构化发现。
 */
export const producerSubmitOnlyGate = {
  name: 'producerSubmitOnlyGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (ctx.loopCtx.tracker?.pipelineType !== 'producer') {
      return undefined;
    }

    const phase = ctx.loopCtx.tracker?.phase;
    const action = getToolAction(call);

    if (phase === 'SUMMARIZE') {
      return {
        blocked: true,
        result: {
          error:
            'Producer is already in SUMMARIZE. Tool calls are disabled; output the production summary only.',
        },
      };
    }

    if (phase !== 'PRODUCE') {
      return undefined;
    }

    if (call.name === 'knowledge' && PRODUCER_KNOWLEDGE_ACTIONS.has(action)) {
      return undefined;
    }
    if (call.name === 'code' && PRODUCER_CODE_ACTIONS.has(action)) {
      return undefined;
    }
    if (call.name === 'memory' && PRODUCER_MEMORY_ACTIONS.has(action)) {
      return undefined;
    }
    if (call.name === 'meta' && PRODUCER_META_ACTIONS.has(action)) {
      return undefined;
    }

    return {
      blocked: true,
      result: {
        error:
          'Producer phase is submit-first. Allowed actions: knowledge.submit, code.read for missing short snippets, memory.recall, and meta.review. Do not call knowledge.detail, meta.tools, meta.plan, search, graph, terminal, or broad exploration; continue submitting remaining structured findings.',
      },
    };
  },
};

/**
 * DeterministicDuplicateGuard — session-level short-circuit for read-like tools.
 *
 * The guard only reuses calls that are safe to replay within the same project snapshot and
 * execution strategy. Submit/mutate/side-effect tools never pass the eligibility check.
 */
export const deterministicDuplicateGuard = {
  name: 'deterministicDuplicateGuard',
  before(call: ToolCall, ctx: ToolExecContext, meta: ToolMetadata): BeforeVerdict | undefined {
    if (!isDeterministicDuplicateCandidate(call, ctx)) {
      return undefined;
    }
    meta.cacheEligible = true;
    const key = buildCacheKey(call, ctx);
    meta.cacheKey = key;
    const cached = getEfficiencyCache(ctx).get(key);
    if (!cached) {
      return undefined;
    }
    meta.cacheHit = true;
    meta.duplicateShortCircuit = true;
    if (cached.envelope) {
      meta.envelope = {
        ...cloneCacheValue(cached.envelope),
        durationMs: 0,
        cache: { hit: true, policy: 'session' },
      };
    }
    return { result: cloneCacheValue(cached.result) };
  },
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (!meta.cacheEligible || !meta.cacheKey || meta.blocked || meta.duplicateShortCircuit) {
      return;
    }
    const envelopeOk = meta.envelope ? meta.envelope.ok : true;
    if (!envelopeOk) {
      return;
    }
    getEfficiencyCache(ctx).set(meta.cacheKey, {
      result: cloneCacheValue(result),
      ...(meta.envelope ? { envelope: cloneCacheValue(meta.envelope) } : {}),
    });
    if (!meta.cacheHit) {
      meta.cacheMiss = true;
    }
  },
};

/**
 * ObservationRecord — MemoryCoordinator 观察记录
 *
 * after: 记录工具执行观察
 */
export const observationRecord = {
  name: 'observationRecord',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    ctx.loopCtx.memoryCoordinator?.recordObservation?.(
      call.name,
      call.args,
      meta.envelope || result,
      ctx.iteration,
      meta.envelope ? true : meta.cacheHit
    );
  },
};

/**
 * TrackerSignal — ExplorationTracker 信号收集
 *
 * after: 记录工具调用信号，更新 isNew 标记
 */
export const trackerSignal = {
  name: 'trackerSignal',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (ctx.loopCtx.tracker) {
      const r = ctx.loopCtx.tracker.recordToolCall(call.name, call.args, result);
      meta.isNew = r.isNew;
    }
  },
};

/**
 * TraceRecord — ActiveContext 推理链记录
 *
 * after: 记录 Action + Observation 到推理链
 */
export const traceRecord = {
  name: 'traceRecord',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    ctx.loopCtx.trace?.recordToolCall(call.name, call.args, meta.envelope || result, meta.isNew);
  },
};

/**
 * SubmitTracker — 提交状态登记
 *
 * 不在 Runtime 层提前拦截 knowledge.submit。所有字段校验、唯一性检查、
 * 相似度检测和融合决策都必须进入 RecipeProductionGateway 统一处理。
 *
 * after: 仅在提交真正创建后登记标题/trigger/指纹，供后续 Gateway 校验使用。
 */
export const submitDedup = {
  name: 'submitDedup',

  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (call.name !== 'knowledge') {
      return;
    }
    const action = String(call.args?.action || '');
    if (action !== 'submit') {
      return;
    }

    const resultObj = result as Record<string, unknown> | null;
    const status = typeof result === 'object' ? String(resultObj?.status || '') : '';
    if (status !== 'created') {
      return;
    }

    // V2 args structure: { action: "submit", params: { title, ... } }
    const params = (call.args?.params as Record<string, unknown>) ?? call.args ?? {};
    const title = String(params.title || params.category || '');
    const normalizedTitle = title.toLowerCase().trim();
    if (!normalizedTitle) {
      return;
    }
    recordProducerSubmitLedger(call, resultObj || {}, ctx);
    const { sharedState } = ctx.loopCtx;
    if (!sharedState?.submittedTitles) {
      meta.isSubmit = true;
      return;
    }

    // 提交成功 — 注册标题/trigger/指纹以防后续重复
    sharedState.submittedTitles.add(normalizedTitle);

    const trigger = String(params.trigger || '')
      .toLowerCase()
      .trim();
    if (trigger && sharedState.submittedTriggers) {
      sharedState.submittedTriggers.add(trigger);
    }

    const contentObj = params.content as Record<string, unknown> | undefined;
    const pattern = String(contentObj?.pattern || '');
    if (pattern.length >= 30 && sharedState.submittedPatterns) {
      const fp = pattern
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/[\s]+/g, '')
        .toLowerCase()
        .slice(0, 200);
      if (fp.length >= 20) {
        sharedState.submittedPatterns.add(fp);
      }
    }
    meta.isSubmit = true;
  },
};

function recordProducerSubmitLedger(
  call: ToolCall,
  result: Record<string, unknown>,
  ctx: ToolExecContext
) {
  if (!isProducerLoop(ctx.loopCtx)) {
    return;
  }
  const shared = (ctx.loopCtx.sharedState ??= {}) as ToolEfficiencySharedState;
  const targetSubmits = numberValue(ctx.loopCtx.budget?.targetSubmits);
  const ledger = (shared._producerSubmitLedger ??= {
    createdCount: 0,
    entries: [] as ProducerSubmitLedgerEntry[],
    ...(targetSubmits != null ? { targetSubmits } : {}),
  });
  const params = (call.args?.params as Record<string, unknown>) ?? call.args ?? {};
  const title = String(result.title || params.title || params.category || '').trim();
  if (!title) {
    return;
  }
  const entry: ProducerSubmitLedgerEntry = {
    ...(typeof result.id === 'string' ? { id: result.id } : {}),
    payloadStored: true,
    requiredFieldsComplete: hasCompleteSubmitPayload(params),
    sourceCount: submitSourceCount(params),
    status: String(result.status || 'created'),
    title,
    ...(typeof params.trigger === 'string' && params.trigger.trim()
      ? { trigger: params.trigger.trim() }
      : {}),
  };
  const existingIndex = ledger.entries.findIndex(
    (item) => item.title.toLowerCase().trim() === title.toLowerCase()
  );
  if (existingIndex >= 0) {
    ledger.entries[existingIndex] = entry;
  } else {
    ledger.entries.push(entry);
  }
  ledger.createdCount = ledger.entries.filter((entry) => entry.status === 'created').length;
}

function isProducerLoop(loopCtx: LoopContext): boolean {
  return (
    loopCtx.tracker?.pipelineType === 'producer' ||
    loopCtx.context?.pipelinePhase === 'produce' ||
    loopCtx.context?.pipelinePhase === 'producer'
  );
}

function hasCompleteSubmitPayload(params: Record<string, unknown>): boolean {
  const content = params.content as Record<string, unknown> | undefined;
  const reasoning = params.reasoning as Record<string, unknown> | undefined;
  const sources = Array.isArray(reasoning?.sources) ? reasoning.sources : [];
  return Boolean(
    stringValue(params.title) &&
      stringValue(params.description) &&
      stringValue(params.kind) &&
      stringValue(params.trigger) &&
      stringValue(params.whenClause) &&
      stringValue(params.doClause) &&
      stringValue(content?.markdown) &&
      stringValue(content?.rationale) &&
      sources.some((source) => typeof source === 'string' && source.trim())
  );
}

function submitSourceCount(params: Record<string, unknown>): number {
  const reasoning = params.reasoning as Record<string, unknown> | undefined;
  const sources = Array.isArray(reasoning?.sources) ? reasoning.sources : [];
  return sources.filter((source) => typeof source === 'string' && source.trim()).length;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * ProgressEmitter — 进度回调 (可选，需 runtime.emitProgress 为 public)
 *
 * NOTE: 默认管道不包含此中间件，因为 tool_end 事件需要 resultStr.length，
 * 而 resultStr 在管道外部计算。由 #processToolCalls 直接处理。
 */
export const progressEmitter = {
  name: 'progressEmitter',
  before(call: ToolCall, ctx: ToolExecContext) {
    ctx.runtime.emitProgress?.('tool_call', { tool: call.name, args: call.args });
  },
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    const resultObj = result as Record<string, unknown> | null;
    ctx.runtime.emitProgress?.('tool_end', {
      tool: call.name,
      duration: meta.durationMs,
      status: resultObj?.error ? 'error' : 'ok',
      error: (resultObj?.error as string | undefined) || undefined,
    });
  },
};

/**
 * EventBusPublisher — EventBus 事件发布 (可选)
 *
 * NOTE: 默认管道不包含此中间件。由 #processToolCalls 直接处理，
 * 与原始 reactLoop 保持完全一致的事件顺序。
 */
export const eventBusPublisher = {
  name: 'eventBusPublisher',
  before(call: ToolCall, ctx: ToolExecContext) {
    if (ctx.runtime.bus?.publish) {
      ctx.runtime.bus.publish(
        'tool:call:start',
        {
          agentId: ctx.runtime.id,
          tool: call.name,
        },
        { source: ctx.runtime.id }
      );
    }
  },
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    const resultObj = result as Record<string, unknown> | null;
    if (ctx.runtime.bus?.publish) {
      ctx.runtime.bus.publish(
        'tool:call:end',
        {
          agentId: ctx.runtime.id,
          tool: call.name,
          durationMs: meta.durationMs,
          success: !resultObj?.error,
        },
        { source: ctx.runtime.id }
      );
    }
  },
};

// ─────────────────────────────────────────────
//  Factory helper
// ─────────────────────────────────────────────

/**
 * 创建预配置的工具执行管道
 *
 * 中间件顺序:
 *   1. allowlistGate (当前 capability 白名单 — 可短路)
 *   2. evolutionDecisionGate (Evolution retry 动作级守卫 — 可短路)
 *   3. observationRecord (记忆记录)
 *   4. trackerSignal (信号收集)
 *   5. traceRecord (推理链)
 *   6. submitDedup (提交成功后登记会话状态；不做提前拦截)
 *
 * Runtime SafetyPolicy 已迁入 ToolRouter/GovernanceEngine 的 approve 阶段。
 *
 * NOTE: eventBusPublisher 和 progressEmitter 不在默认管道中，
 * 由 #processToolCalls 直接处理，以保持与原始 reactLoop 完全一致的事件顺序
 * (progress_end 需要 resultStr.length，在管道外计算)。
 */
export function createToolPipeline() {
  return new ToolExecutionPipeline()
    .use(allowlistGate)
    .use(toolArgumentBoundsGate)
    .use(evolutionDecisionGate)
    .use(recordRepairOnlyGate)
    .use(analystVerifyOnlyGate)
    .use(producerSubmitOnlyGate)
    .use(deterministicDuplicateGuard)
    .use(observationRecord)
    .use(trackerSignal)
    .use(traceRecord)
    .use(submitDedup);
}
