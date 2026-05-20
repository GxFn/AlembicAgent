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
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
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

interface ToolForgeLike {
  temporaryRegistry?: { isTemporary(name: string): boolean };
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

interface ToolEfficiencySharedState {
  _toolEfficiencyCache?: Map<string, CachedToolResult>;
  _projectSnapshotId?: unknown;
  _projectRevision?: unknown;
  _workspaceRevision?: unknown;
  _dimensionScopeId?: unknown;
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
    let toolResult: unknown = null;
    let hasToolResult = false;
    const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };

    // ── before 阶段 ──
    for (const mw of this.#middlewares) {
      if (mw.before) {
        const verdict = await mw.before(call, context, metadata);
        if (verdict?.blocked) {
          toolResult = verdict.result;
          hasToolResult = true;
          metadata.blocked = true;
          context.loopCtx.diagnostics?.recordBlockedTool(call.name, diagnosticReason(toolResult));
          break;
        }
        if (verdict?.result !== undefined) {
          toolResult = verdict.result;
          hasToolResult = true;
          metadata.cacheHit = true;
          break;
        }
      }
    }

    // ── execute 阶段 ──
    if (!hasToolResult) {
      const t0 = Date.now();
      try {
        const { runtime, loopCtx } = context;
        const safetyPolicy = runtime.policies.get?.(SafetyPolicy) || null;
        const envelope = await runtime.toolRouter.execute({
          toolId: call.name,
          args: call.args,
          surface: 'runtime',
          actor: { role: 'developer', user: runtime.id },
          source: {
            kind: 'runtime',
            name:
              typeof loopCtx.context?.pipelinePhase === 'string'
                ? loopCtx.context.pipelinePhase
                : loopCtx.source || runtime.presetName,
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
            projectLanguage:
              typeof loopCtx.sharedState?._projectLanguage === 'string'
                ? loopCtx.sharedState._projectLanguage
                : null,
            submittedTitles: loopCtx.sharedState?.submittedTitles || null,
            submittedPatterns: loopCtx.sharedState?.submittedPatterns || null,
            submittedTriggers: loopCtx.sharedState?.submittedTriggers || null,
            sessionToolCalls: Array.isArray(loopCtx.toolCalls)
              ? loopCtx.toolCalls.map((entry: { tool?: string; args?: unknown }) => ({
                  tool: String(entry.tool || ''),
                  params:
                    entry.args && typeof entry.args === 'object'
                      ? (entry.args as Record<string, unknown>)
                      : undefined,
                }))
              : null,
            bootstrapDedup: loopCtx.sharedState?._bootstrapDedup || null,
            memoryCoordinator: loopCtx.memoryCoordinator || null,
            dimensionScopeId:
              typeof loopCtx.sharedState?._dimensionScopeId === 'string'
                ? loopCtx.sharedState._dimensionScopeId
                : null,
            currentRound: loopCtx.iteration || 0,
          },
        });
        metadata.envelope = envelope;
        metadata.cacheHit = envelope.cache?.hit === true;
        if (envelope.cache && envelope.cache.policy !== 'none' && envelope.cache.hit !== true) {
          metadata.cacheMiss = true;
        }
        if (
          !envelope.ok &&
          ['blocked', 'needs-confirmation', 'aborted', 'timeout'].includes(envelope.status)
        ) {
          metadata.blocked = true;
          loopCtx.diagnostics?.recordBlockedTool(call.name, envelope.text);
        }
        toolResult = !envelope.ok
          ? { error: envelope.text }
          : envelope.structuredContent !== undefined
            ? envelope.structuredContent
            : { success: true, message: envelope.text };
      } catch (err: unknown) {
        toolResult = { error: (err as Error).message };
      }
      metadata.durationMs = Date.now() - t0;
    }

    // ── after 阶段 ──
    for (const mw of this.#middlewares) {
      if (mw.after) {
        await mw.after(call, toolResult, context, metadata);
      }
    }

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
 * Forge 集成：不在白名单的工具如果已由 ToolForge 锻造（存在于 ToolRegistry），则放行。
 *
 * before: 如果工具不在白名单中且非锻造工具则短路返回 error
 */
export const allowlistGate = {
  name: 'allowlistGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const allowedNames = new Set(ctx.loopCtx?.allowedToolIds || []);
    if (!allowedNames.has(call.name)) {
      const container = ctx.runtime.container as { get?: (name: string) => unknown } | null;
      const toolForge = container?.get?.('toolForge') as ToolForgeLike | undefined;
      const isTemporaryTool = toolForge?.temporaryRegistry?.isTemporary(call.name) === true;
      // Forge fallback: 仅允许确认为 TemporaryToolRegistry 管理的动态工具放行。
      if (isTemporaryTool) {
        ctx.runtime.logger.info(
          `[ToolPipeline] Tool "${call.name}" not in allowlist but is a temporary forged tool — allowed`
        );
        return undefined;
      }

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
    return undefined;
  },
};

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
    if (call.name === 'memory' && RECORD_REPAIR_MEMORY_ACTIONS.has(action)) {
      return undefined;
    }

    return {
      blocked: true,
      result: {
        error:
          'Record repair is memory-only. Use memory({ action: "note_finding", params: { finding, evidence, importance } }) to record verified findings; code/graph/terminal/knowledge and memory.save are disabled.',
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

    if (call.name === 'memory' && ANALYST_VERIFY_MEMORY_ACTIONS.has(action)) {
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
          'Analyst VERIFY is evidence-only. Use code.read/code.outline, focused graph.query(class|protocol|hierarchy|callers|callees|overrides|extensions|impact with entity/path), or memory.note_finding/recall/get_previous_evidence; broad search, terminal, knowledge, and writes are disabled.',
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
    const { sharedState } = ctx.loopCtx;
    if (!sharedState?.submittedTitles) {
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
    .use(evolutionDecisionGate)
    .use(recordRepairOnlyGate)
    .use(analystVerifyOnlyGate)
    .use(deterministicDuplicateGuard)
    .use(observationRecord)
    .use(trackerSignal)
    .use(traceRecord)
    .use(submitDedup);
}
