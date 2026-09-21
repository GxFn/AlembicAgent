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

function cloneCacheValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
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
    // 宿主抛错时只有归一化 error，没有 envelope。缺少信封不能被提升为可缓存成功。
    if (!readToolObservation({ ...call, result, envelope: meta.envelope }).ok) {
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
