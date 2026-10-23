/**
 * W1-04 / L3-P09 回归：重复调用缓存（deterministicDuplicateGuard）的准入改读运行时工具注册表。
 *
 * 背景：旧实现经 runtime.toolRegistry.getManifest 取 manifest 判断能否复用，但运行时工具不在
 * 那张目录里注册，生产中恒查不到 manifest，判断形同虚设。改为直接读 TOOL_REGISTRY 的动作声明：
 *   - risk === 'read-only'、concurrency !== 'exclusive'、cache 已声明且不为 'none'；
 *   - 未声明 cache 的动作与 ToolRouterAdapter 同口径按 'none' 处理（meta.tools 因此不可缓存）；
 *   - 未知工具或动作失败关闭；
 *   - 名称排除（code/memory/knowledge/evidence 与 meta.review）、SIDE_EFFECT_ACTIONS 与快照 id 门禁保留。
 * 结果：注册表里只有 graph.overview 与 graph.query 合格，并且仍需真实快照 id。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import type { LoopContext } from '../src/agent/runtime/LoopContext.js';
import { createToolPipeline } from '../src/agent/runtime/ToolExecutionPipeline.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { deterministicDuplicateGuard } from '../src/agent/runtime/toolPipeline/duplicateCache.js';
import type { ToolCallRequest, ToolResultEnvelope } from '../src/tools/kernel/index.js';
import type { ToolCapabilityManifest } from '../src/tools/kernel/manifest.js';
import { TOOL_REGISTRY } from '../src/tools/runtime/registry.js';

/** 一份“什么都允许”的只读 manifest：若实现仍查 getManifest，所有工具都会被误判为可缓存。 */
const PERMISSIVE_MANIFEST = {
  id: 'any',
  title: 'any',
  kind: 'internal-tool',
  description: 'permissive read-only manifest',
  owner: 'agent',
  lifecycle: 'active',
  surfaces: ['runtime'],
  inputSchema: { type: 'object', properties: {} },
  risk: {
    sideEffect: false,
    dataAccess: 'project',
    writeScope: 'none',
    network: 'none',
    credentialAccess: 'none',
    requiresHumanConfirmation: 'never',
    owaspTags: [],
  },
  execution: {
    adapter: 'internal',
    timeoutMs: 1000,
    maxOutputBytes: 4096,
    abortMode: 'cooperative',
    cachePolicy: 'session',
    concurrency: 'parallel-safe',
    artifactMode: 'inline',
  },
  governance: {
    policyProfile: 'read',
    auditLevel: 'checkOnly',
    approvalPolicy: 'auto',
    allowedRoles: ['developer'],
    allowInComposer: true,
    allowInRemoteMcp: false,
    allowInNonInteractive: true,
  },
  evals: { required: false, cases: [] },
} as ToolCapabilityManifest;

function freshMetadata(): ToolMetadata {
  return { cacheHit: false, blocked: false, isNew: false, isSubmit: false, durationMs: 0 };
}

function guardContext(sharedState: Record<string, unknown>) {
  const getManifest = vi.fn(() => PERMISSIVE_MANIFEST);
  const ctx = {
    runtime: { id: 'registry-cache', presetName: 'registry-preset', toolRegistry: { getManifest } },
    loopCtx: {
      source: 'system',
      context: { pipelinePhase: 'analyze' },
      sharedState,
      diagnostics: new DiagnosticsCollector(),
      tracker: null,
    },
    iteration: 1,
  } as unknown as ToolPipelineContext;
  return { ctx, getManifest };
}

function isAdmitted(call: { name: string; args: Record<string, unknown> }, snapshot = true) {
  const { ctx, getManifest } = guardContext(snapshot ? { _projectSnapshotId: 'snap-1' } : {});
  const meta = freshMetadata();
  const verdict = deterministicDuplicateGuard.before({ id: 'call', ...call }, ctx as never, meta);
  return { admitted: meta.cacheEligible === true, verdict, getManifest };
}

describe('deterministicDuplicateGuard reads TOOL_REGISTRY (W1-04 / L3-P09)', () => {
  it('short-circuits the second identical graph.query through the default pipeline without consulting getManifest', async () => {
    let executeCount = 0;
    const getManifest = vi.fn(() => null);
    const runtime = {
      id: 'registry-runtime',
      presetName: 'bootstrap',
      container: null,
      dataRoot: '/tmp/data',
      fileCache: null,
      lang: null,
      logger: { info: () => undefined, warn: () => undefined },
      aiProvider: null,
      policies: { get: () => null },
      // 旧实现在这里查 manifest；生产目录对运行时工具恒返回 null。新实现不得再依赖它。
      toolRegistry: { getManifest },
      toolRouter: {
        execute: async (request: ToolCallRequest): Promise<ToolResultEnvelope> => {
          executeCount++;
          return {
            ok: true,
            toolId: request.toolId,
            callId: `call-${executeCount}`,
            startedAt: new Date().toISOString(),
            durationMs: 1,
            status: 'success',
            text: `graph result ${executeCount}`,
            structuredContent: { executeCount },
            cache: { hit: false, policy: 'session' },
          } as ToolResultEnvelope;
        },
      },
    } as unknown as AgentRuntime;
    const diagnostics = new DiagnosticsCollector();
    const loopCtx = {
      allowedToolIds: ['graph'],
      abortSignal: null,
      context: { pipelinePhase: 'analyze' },
      diagnostics,
      iteration: 1,
      memoryCoordinator: null,
      sharedState: { _projectSnapshotId: 'snapshot-1' },
      source: 'system',
      toolCalls: [],
      tracker: null,
      trace: null,
    } as unknown as LoopContext;
    const pipeline = createToolPipeline();
    const call = {
      id: 'graph-1',
      name: 'graph',
      args: { action: 'query', params: { type: 'callers', entity: 'AgentRuntime' } },
    };

    const first = await pipeline.execute(call, { runtime, loopCtx, iteration: 1 });
    const second = await pipeline.execute(
      { ...call, id: 'graph-2' },
      { runtime, loopCtx, iteration: 2 }
    );

    expect(executeCount).toBe(1);
    expect(first.result).toEqual({ executeCount: 1 });
    expect(first.metadata.duplicateShortCircuit).not.toBe(true);
    expect(second.result).toEqual({ executeCount: 1 });
    expect(second.metadata.duplicateShortCircuit).toBe(true);
    expect(second.metadata.cacheHit).toBe(true);
    expect(diagnostics.toJSON().efficiency).toMatchObject({
      toolCalls: 2,
      duplicateToolCalls: 1,
      cacheHits: 1,
    });
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('admits graph.query only when a real project snapshot id is bound', () => {
    const call = { name: 'graph', args: { action: 'query', params: { type: 'class' } } };
    expect(isAdmitted(call).admitted).toBe(true);
    expect(isAdmitted(call, false).admitted).toBe(false);
  });

  it.each([
    { label: 'code.read', call: { name: 'code', args: { action: 'read' } } },
    { label: 'memory.recall', call: { name: 'memory', args: { action: 'recall' } } },
    { label: 'knowledge.search', call: { name: 'knowledge', args: { action: 'search' } } },
    { label: 'evidence.get', call: { name: 'evidence', args: { action: 'get' } } },
    { label: 'meta.review', call: { name: 'meta', args: { action: 'review' } } },
    { label: 'meta.plan', call: { name: 'meta', args: { action: 'plan' } } },
    // meta.tools 未声明 cache：与 ToolRouterAdapter 的 `?? 'none'` 同口径，不因删除缓存层变为可缓存。
    { label: 'meta.tools', call: { name: 'meta', args: { action: 'tools' } } },
    { label: 'terminal.exec', call: { name: 'terminal', args: { action: 'exec' } } },
    { label: 'unknown tool', call: { name: 'snapshot.lookup', args: { action: 'read' } } },
    { label: 'unknown graph action', call: { name: 'graph', args: { action: 'mutate_index' } } },
    { label: 'graph without action', call: { name: 'graph', args: {} } },
  ])('fails closed for $label even when getManifest would allow it', ({ call }) => {
    const { admitted, verdict, getManifest } = isAdmitted(call);
    expect(admitted).toBe(false);
    expect(verdict).toBeUndefined();
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('admits exactly the registry actions declared read-only, non-exclusive and cache-enabled', () => {
    const admitted: string[] = [];
    for (const [tool, spec] of Object.entries(TOOL_REGISTRY)) {
      for (const action of Object.keys(spec.actions)) {
        if (isAdmitted({ name: tool, args: { action } }).admitted) {
          admitted.push(`${tool}.${action}`);
        }
      }
    }
    // 名称排除与 SIDE_EFFECT_ACTIONS 之后，注册表里只剩 graph 的两个 session 级只读动作。
    expect(admitted.sort()).toEqual(['graph.overview', 'graph.query']);
  });
});
