/** 只读 snapshot 结果的准入与复用；失败结果、可变状态读取和副作用调用不能进入缓存。 */
import { stableStringify } from '#shared/serialization.js';
import type { ToolResultEnvelope } from '#tools/kernel/index.js';
import type { ToolCapabilityManifest } from '#tools/kernel/manifest.js';
import { readToolObservation } from '../../utils/toolOutcomes.js';
import { getToolAction } from './callNormalization.js';
import type {
  BeforeVerdict,
  ToolCall,
  ToolPipelineContext as ToolExecContext,
  ToolMetadata,
  ToolRuntimePort,
} from './contracts.js';

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

function getToolManifest(runtime: ToolRuntimePort, toolId: string): ToolCapabilityManifest | null {
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
  // 文件/知识/记忆/台账都是运行中可变状态。外层复用会绕过 handler 的新鲜度检查，
  // 因而只缓存显式声明为只读、并绑定真实 snapshot 的其他工具。
  if (
    ['code', 'memory', 'knowledge', 'evidence'].includes(call.name) ||
    (call.name === 'meta' && action === 'review')
  ) {
    return false;
  }
  const manifest = getToolManifest(ctx.runtime, call.name);
  if (
    !manifest ||
    manifest.execution.concurrency === 'exclusive' ||
    manifest.execution.cachePolicy === 'none' ||
    !resolveProjectSnapshotId(ctx)
  ) {
    return false;
  }
  return isReadLikeManifest(manifest);
}

function getEfficiencyCache(ctx: ToolExecContext): Map<string, CachedToolResult> {
  const shared = (ctx.loopCtx.sharedState ??= {}) as ToolEfficiencySharedState;
  shared._toolEfficiencyCache ??= new Map<string, CachedToolResult>();
  return shared._toolEfficiencyCache;
}

const TOOL_CACHE_CLONE_FAILED_CODE = 'TOOL_CACHE_CLONE_FAILED';
/** 诊断里错误原文的展示上限。 */
const MAX_CLONE_ERROR_CHARS = 200;

type CacheCloneOutcome =
  | { ok: true; entry: CachedToolResult }
  | { ok: false; part: 'result' | 'envelope'; reason: string };

/**
 * 缓存条目整体复制。缓存与调用方之间必须是独立副本：evidenceCapture 等后续中间件会就地改写
 * 返回值和 meta.envelope，共享引用会把这些标注写回缓存，命中时出现重复标注。
 * 因此复制失败（函数、Symbol 等不可克隆成员）时不能退回原引用，而是报告失败由调用方跳过缓存。
 */
function cloneCacheEntry(source: CachedToolResult): CacheCloneOutcome {
  let result: unknown;
  try {
    result = structuredClone(source.result);
  } catch (err: unknown) {
    return { ok: false, part: 'result', reason: describeCloneError(err) };
  }
  if (!source.envelope) {
    return { ok: true, entry: { result } };
  }
  try {
    return { ok: true, entry: { result, envelope: structuredClone(source.envelope) } };
  } catch (err: unknown) {
    return { ok: false, part: 'envelope', reason: describeCloneError(err) };
  }
}

function describeCloneError(err: unknown): string {
  let text: string;
  if (err instanceof Error) {
    text = err.message || err.name;
  } else {
    try {
      text = String(err);
    } catch (stringifyErr: unknown) {
      text =
        stringifyErr instanceof Error
          ? `unprintable ${typeof err} (${stringifyErr.message})`
          : `unprintable ${typeof err}`;
    }
  }
  return text.length > MAX_CLONE_ERROR_CHARS ? `${text.slice(0, MAX_CLONE_ERROR_CHARS)}…` : text;
}

function warnCacheCloneFailed(
  call: ToolCall,
  ctx: ToolExecContext,
  failure: { part: 'result' | 'envelope'; reason: string },
  stage: 'store' | 'hit'
): void {
  const action = getToolAction(call);
  const target = action ? `${call.name}.${action}` : call.name;
  const consequence =
    stage === 'store'
      ? 'the result was returned uncached and a repeat call will execute again'
      : 'the cached entry was evicted and the call executes again';
  ctx.loopCtx.diagnostics?.warn({
    code: TOOL_CACHE_CLONE_FAILED_CODE,
    tool: call.name,
    message: `Session cache ${stage === 'store' ? 'store' : 'reuse'} skipped for ${target}: structuredClone of the ${failure.part} failed (${failure.reason}); ${consequence}.`,
  });
}

function resolveProjectSnapshotId(ctx: ToolExecContext): string | null {
  const shared = (ctx.loopCtx.sharedState || {}) as ToolEfficiencySharedState;
  const context = ctx.loopCtx.context || {};
  const explicit =
    context.projectSnapshotId ??
    context.snapshotId ??
    context.projectRevision ??
    context.workspaceRevision ??
    shared._projectSnapshotId ??
    shared._projectRevision ??
    shared._workspaceRevision;
  if (explicit) {
    return String(explicit);
  }
  return null;
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
    const cache = getEfficiencyCache(ctx);
    const cached = cache.get(key);
    if (!cached) {
      return undefined;
    }
    // 先复制再标记命中：复制失败（只可能来自缓存被外部写入了不可克隆条目）时按未命中处理，
    // 剔除该条目并告警，调用照常执行；绝不把缓存内对象的引用交给调用方。
    const copy = cloneCacheEntry(cached);
    if (!copy.ok) {
      cache.delete(key);
      warnCacheCloneFailed(call, ctx, copy, 'hit');
      return undefined;
    }
    meta.cacheHit = true;
    meta.duplicateShortCircuit = true;
    if (copy.entry.envelope) {
      meta.envelope = {
        ...copy.entry.envelope,
        durationMs: 0,
        cache: { hit: true, policy: 'session' },
      };
    }
    return { result: copy.entry.result };
  },
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (!meta.cacheEligible || !meta.cacheKey || meta.blocked || meta.duplicateShortCircuit) {
      return;
    }
    // 宿主抛错时只有归一化 error，没有 envelope。缺少信封不能被提升为可缓存成功。
    if (!readToolObservation({ ...call, result, envelope: meta.envelope }).ok) {
      return;
    }
    const copy = cloneCacheEntry({
      result,
      ...(meta.envelope ? { envelope: meta.envelope } : {}),
    });
    if (copy.ok) {
      getEfficiencyCache(ctx).set(meta.cacheKey, copy.entry);
    } else {
      // 不可克隆的结果不入缓存（旧实现退回共享引用，会被后续中间件就地改写污染）。
      warnCacheCloneFailed(call, ctx, copy, 'store');
    }
    // 本次查找确实未命中；是否成功入缓存不改变 miss 统计口径。
    if (!meta.cacheHit) {
      meta.cacheMiss = true;
    }
  },
};
