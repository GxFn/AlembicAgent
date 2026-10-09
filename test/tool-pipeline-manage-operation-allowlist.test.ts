/**
 * L4-P29 回归（生产路径）：宿主构造 ToolRouterAdapter 时不传 capability，只靠 router 挡不住；
 * runtimeSafetyGate 必须按 loopCtx.capabilities 对 knowledge.manage 的 operation 执行同一张
 * 内部 allowlist，拒绝时留下含 capability/operation/id 的日志与诊断，且端口零调用。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import type { LoopContext } from '../src/agent/runtime/LoopContext.js';
import { createToolPipeline } from '../src/agent/runtime/ToolExecutionPipeline.js';
import { runtimeSafetyGate } from '../src/agent/runtime/toolPipeline/accessGates.js';
import type { ToolPipelineContext } from '../src/agent/runtime/toolPipeline/contracts.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import type { ToolContext } from '../src/tools/runtime/index.js';
import { Evolution } from '../src/tools/runtime/index.js';

const DENIED_OPERATIONS = [
  'approve',
  'publish',
  'update',
  'reject',
  'score',
  'validate',
  'review',
  'review-queue',
] as const;

const ALLOWED_OPERATIONS = ['evolve', 'deprecate', 'skip_evolution'] as const;

function manageParams(operation: string): Record<string, unknown> {
  switch (operation) {
    case 'review-queue':
      return { operation, limit: 5 };
    case 'review':
      return { operation, id: 'staging-1', outcome: 'pass' };
    case 'update':
      return { operation, id: 'active-1', data: { description: 'rewritten by model' } };
    case 'score':
      return { operation, id: 'active-1', data: { score: 1 } };
    default:
      return { operation, id: 'pending-1' };
  }
}

function manageCall(operation: string) {
  return {
    id: `call-${operation}`,
    name: 'knowledge',
    args: { action: 'manage', params: manageParams(operation) },
  };
}

function gateContext(capabilities: unknown[]) {
  const warn = vi.fn();
  const diagnostics = new DiagnosticsCollector();
  const ctx = {
    runtime: {
      logger: { warn, info: vi.fn() },
      policies: {},
      projectRoot: process.cwd(),
    },
    loopCtx: {
      capabilities,
      diagnostics,
      allowedToolIds: ['knowledge'],
      allowedToolActions: { knowledge: ['search', 'detail', 'manage'] },
    },
    iteration: 1,
  } as unknown as ToolPipelineContext;
  return { ctx, warn, diagnostics };
}

describe('runtimeSafetyGate capability parameter allowlist (L4-P29)', () => {
  it.each(
    DENIED_OPERATIONS
  )('blocks knowledge.manage(%s) when the loop carries evolution_analysis', async (operation) => {
    const { ctx, warn, diagnostics } = gateContext([new Evolution()]);
    const params = manageParams(operation);

    const verdict = await runtimeSafetyGate.before?.(manageCall(operation), ctx, {
      cacheHit: false,
      blocked: false,
      isNew: false,
      durationMs: 0,
    });

    expect(verdict?.blocked).toBe(true);
    const result = verdict?.result as Record<string, unknown>;
    expect(result).toMatchObject({
      code: 'TOOL_PARAMETER_DENIED',
      status: 'blocked',
      capability: 'evolution_analysis',
      tool: 'knowledge',
      action: 'manage',
      parameter: 'operation',
      value: operation,
    });
    expect(String(result.error)).toContain('evolution_analysis');
    expect(String(result.error)).toContain(`operation="${operation}"`);

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain('evolution_analysis');
    expect(logged).toContain(`operation="${operation}"`);
    if (typeof params.id === 'string') {
      expect(logged).toContain(`id=${params.id}`);
    }

    const warnings = diagnostics.toJSON().warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'TOOL_PARAMETER_DENIED', tool: 'knowledge' });
    expect(warnings[0]?.message).toContain(`operation="${operation}"`);
  });

  it.each(
    ALLOWED_OPERATIONS
  )('admits knowledge.manage(%s) under evolution_analysis', async (operation) => {
    const { ctx, warn, diagnostics } = gateContext([new Evolution()]);
    const verdict = await runtimeSafetyGate.before?.(manageCall(operation), ctx, {
      cacheHit: false,
      blocked: false,
      isNew: false,
      durationMs: 0,
    });
    expect(verdict).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(diagnostics.toJSON().warnings).toHaveLength(0);
  });

  it('does not gate loops without evolution_analysis or other knowledge actions', async () => {
    const metadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
    const noCapabilities = gateContext([]);
    expect(
      await runtimeSafetyGate.before?.(manageCall('approve'), noCapabilities.ctx, metadata)
    ).toBeUndefined();

    const otherCapability = gateContext([{ name: 'conversation' }]);
    expect(
      await runtimeSafetyGate.before?.(manageCall('approve'), otherCapability.ctx, metadata)
    ).toBeUndefined();

    const evolution = gateContext([new Evolution()]);
    expect(
      await runtimeSafetyGate.before?.(
        { id: 'detail', name: 'knowledge', args: { action: 'detail', params: { id: 'r1' } } },
        evolution.ctx,
        metadata
      )
    ).toBeUndefined();
    expect(evolution.warn).not.toHaveBeenCalled();
  });
});

function makePorts() {
  return {
    recipeGateway: {
      evaluateReadiness: vi.fn(async () => ({ ready: true })),
      publish: vi.fn(async (id: string) => ({ id, lifecycle: 'active' })),
    },
    knowledgeManagement: {
      update: vi.fn(async () => ({})),
      reject: vi.fn(async () => ({})),
      score: vi.fn(async () => ({})),
      validate: vi.fn(async () => ({ valid: true })),
    },
    stagingManager: {
      listReviewQueue: vi.fn(async () => []),
      recordReview: vi.fn(async () => true),
    },
    proposalGateway: {
      submit: vi.fn(async () => ({ outcome: 'proposal-created', proposalId: 'proposal-1' })),
    },
  };
}

type Ports = ReturnType<typeof makePorts>;

/** 与宿主 AgentModule 一致：Adapter 不带 capability，只有 loopCtx.capabilities 知道当前能力。 */
function makeProductionLikeRun(ports: Ports) {
  const toolContext: ToolContext = {
    projectRoot: process.cwd(),
    tokenBudget: 8000,
    ...ports,
  };
  const adapter = new ToolRouterAdapter({ contextFactory: { create: () => toolContext } });
  const warn = vi.fn();
  const diagnostics = new DiagnosticsCollector();
  const runtime = {
    id: 'evolution-audit-runtime',
    presetName: 'evolution',
    container: null,
    projectRoot: process.cwd(),
    dataRoot: join(tmpdir(), 'alembic-agent-l4-p29'),
    fileCache: null,
    lang: null,
    logger: { info: vi.fn(), warn },
    aiProvider: null,
    policies: { get: () => null },
    toolRegistry: { getManifest: () => null },
    toolRouter: adapter,
    emitProgress: vi.fn(),
    bus: { publish: vi.fn() },
  } as unknown as AgentRuntime;
  const loopCtx = {
    allowedToolIds: ['code', 'terminal', 'knowledge', 'graph'],
    allowedToolActions: {
      code: ['search', 'read'],
      terminal: ['exec'],
      knowledge: ['search', 'detail', 'manage'],
      graph: ['query'],
    },
    capabilities: [new Evolution()],
    abortSignal: null,
    budget: {},
    context: { pipelinePhase: 'evolve' },
    diagnostics,
    evidenceLedger: null,
    iteration: 1,
    memoryCoordinator: null,
    sharedState: { evolutionProposalSource: 'rescan-evolution' },
    source: 'system',
    toolCalls: [],
    tracker: null,
    trace: null,
  } as unknown as LoopContext;
  return { runtime, loopCtx, warn, diagnostics };
}

describe('tool pipeline with a capability-less host adapter (L4-P29)', () => {
  it.each(
    DENIED_OPERATIONS
  )('blocks knowledge.manage(%s) before host dispatch and records the block', async (operation) => {
    const ports = makePorts();
    const { runtime, loopCtx, warn, diagnostics } = makeProductionLikeRun(ports);

    const outcome = await createToolPipeline().execute(manageCall(operation), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    expect(outcome.metadata.blocked).toBe(true);
    expect(outcome.metadata.envelope).toBeUndefined();
    expect(outcome.result).toMatchObject({
      code: 'TOOL_PARAMETER_DENIED',
      capability: 'evolution_analysis',
      value: operation,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const snapshot = diagnostics.toJSON();
    expect(snapshot.blockedTools).toHaveLength(1);
    expect(snapshot.blockedTools[0]?.tool).toBe('knowledge');
    expect(snapshot.blockedTools[0]?.reason).toContain('evolution_analysis');
    expect(snapshot.warnings.map((warning) => warning.code)).toContain('TOOL_PARAMETER_DENIED');

    expect(ports.recipeGateway.evaluateReadiness).not.toHaveBeenCalled();
    expect(ports.recipeGateway.publish).not.toHaveBeenCalled();
    expect(ports.knowledgeManagement.update).not.toHaveBeenCalled();
    expect(ports.knowledgeManagement.reject).not.toHaveBeenCalled();
    expect(ports.knowledgeManagement.score).not.toHaveBeenCalled();
    expect(ports.knowledgeManagement.validate).not.toHaveBeenCalled();
    expect(ports.stagingManager.listReviewQueue).not.toHaveBeenCalled();
    expect(ports.stagingManager.recordReview).not.toHaveBeenCalled();
    expect(ports.proposalGateway.submit).not.toHaveBeenCalled();
  });

  it.each(
    ALLOWED_OPERATIONS
  )('lets knowledge.manage(%s) reach the proposal gateway through the real adapter', async (operation) => {
    const ports = makePorts();
    const { runtime, loopCtx, warn, diagnostics } = makeProductionLikeRun(ports);

    const outcome = await createToolPipeline().execute(manageCall(operation), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    expect(outcome.metadata.blocked).toBe(false);
    expect(outcome.metadata.envelope?.ok).toBe(true);
    expect(outcome.result).toMatchObject({ operation, id: 'pending-1' });
    expect(ports.proposalGateway.submit).toHaveBeenCalledTimes(1);
    expect(ports.proposalGateway.submit.mock.calls[0]?.[0]).toMatchObject({
      recipeId: 'pending-1',
      source: 'rescan-evolution',
    });
    expect(ports.recipeGateway.publish).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(diagnostics.toJSON().blockedTools).toHaveLength(0);
  });
});
