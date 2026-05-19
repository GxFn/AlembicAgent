import { describe, expect, it } from 'vitest';
import { NudgeGenerator, PlanTracker } from '../src/agent/context/index.js';
import type { AgentRuntime, LoopContext } from '../src/agent/runtime/index.js';
import { createToolPipeline, DiagnosticsCollector } from '../src/agent/runtime/index.js';
import type { ToolCallRequest, ToolCapabilityManifest, ToolResultEnvelope } from '../src/index.js';

function createManifest(overrides: Partial<ToolCapabilityManifest> = {}): ToolCapabilityManifest {
  const manifest: ToolCapabilityManifest = {
    id: 'code',
    title: 'Code',
    kind: 'internal-tool',
    description: 'Read project code',
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
  };

  return {
    ...manifest,
    ...overrides,
    risk: { ...manifest.risk, ...overrides.risk },
    execution: { ...manifest.execution, ...overrides.execution },
    governance: { ...manifest.governance, ...overrides.governance },
    evals: { ...manifest.evals, ...overrides.evals },
  };
}

function createEnvelope(
  request: ToolCallRequest,
  executeCount: number,
  cacheHit = false
): ToolResultEnvelope<{ executeCount: number }> {
  return {
    ok: true,
    toolId: request.toolId,
    callId: `call-${executeCount}`,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    status: 'success',
    text: `result ${executeCount}`,
    structuredContent: { executeCount },
    cache: { hit: cacheHit, policy: 'session' },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

function createRuntime(
  manifest: ToolCapabilityManifest,
  execute: (request: ToolCallRequest) => Promise<ToolResultEnvelope>
): AgentRuntime {
  return {
    id: 'runtime-efficiency-test',
    presetName: 'bootstrap',
    container: null,
    dataRoot: '/tmp/data',
    fileCache: null,
    lang: null,
    logger: { info: () => undefined, warn: () => undefined },
    aiProvider: null,
    policies: { get: () => null },
    toolRegistry: {
      getManifest: (id: string) => (id === manifest.id ? manifest : null),
    },
    toolRouter: { execute },
  } as unknown as AgentRuntime;
}

function createLoopContext(diagnostics: DiagnosticsCollector): LoopContext {
  return {
    allowedToolIds: ['code', 'knowledge'],
    abortSignal: null,
    context: { pipelinePhase: 'bootstrap' },
    diagnostics,
    iteration: 1,
    memoryCoordinator: null,
    sharedState: { _projectSnapshotId: 'snapshot-1' },
    source: 'system',
    toolCalls: [],
    tracker: null,
    trace: null,
  } as unknown as LoopContext;
}

describe('runtime efficiency diagnostics', () => {
  it('short-circuits duplicate deterministic tool calls within a session snapshot', async () => {
    const diagnostics = new DiagnosticsCollector();
    const manifest = createManifest({ id: 'code' });
    let executeCount = 0;
    const runtime = createRuntime(manifest, async (request) => {
      executeCount++;
      return createEnvelope(request, executeCount);
    });
    const loopCtx = createLoopContext(diagnostics);
    const pipeline = createToolPipeline();
    const call = {
      id: 'tool-1',
      name: 'code',
      args: { action: 'search', params: { patterns: ['AgentRuntime'] } },
    };

    const first = await pipeline.execute(call, { runtime, loopCtx, iteration: 1 });
    const second = await pipeline.execute(
      { ...call, id: 'tool-2' },
      { runtime, loopCtx, iteration: 2 }
    );

    expect(executeCount).toBe(1);
    expect(first.result).toEqual({ executeCount: 1 });
    expect(second.result).toEqual({ executeCount: 1 });
    expect(second.metadata.duplicateShortCircuit).toBe(true);
    expect(diagnostics.toJSON().efficiency).toMatchObject({
      toolCalls: 2,
      duplicateToolCalls: 1,
      cacheHits: 1,
      cacheMisses: 1,
    });
  });

  it('does not short-circuit submit or side-effect tools', async () => {
    const diagnostics = new DiagnosticsCollector();
    const manifest = createManifest({
      id: 'knowledge',
      risk: { sideEffect: true, writeScope: 'project' },
      execution: { cachePolicy: 'none', concurrency: 'single' },
      governance: { policyProfile: 'write' },
    });
    let executeCount = 0;
    const runtime = createRuntime(manifest, async (request) => {
      executeCount++;
      return createEnvelope(request, executeCount);
    });
    const loopCtx = createLoopContext(diagnostics);
    const pipeline = createToolPipeline();
    const call = {
      id: 'submit-1',
      name: 'knowledge',
      args: {
        action: 'submit',
        params: { title: 'Real candidate', content: { markdown: 'body' } },
      },
    };

    await pipeline.execute(call, { runtime, loopCtx, iteration: 1 });
    await pipeline.execute({ ...call, id: 'submit-2' }, { runtime, loopCtx, iteration: 2 });

    expect(executeCount).toBe(2);
    expect(diagnostics.toJSON().efficiency).toMatchObject({
      toolCalls: 2,
      duplicateToolCalls: 0,
      cacheHits: 0,
    });
  });

  it('tracks token, compaction, nudge, retry, forced-summary, and cancel metrics', () => {
    const diagnostics = new DiagnosticsCollector();

    diagnostics.recordTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheHitTokens: 40,
    });
    diagnostics.recordCompaction({ level: 2, removed: 3 });
    diagnostics.recordNudge({ type: 'planning', isReplan: true });
    diagnostics.recordEmptyRetry();
    diagnostics.recordForcedSummary();
    diagnostics.recordCancelReason('abort_signal');

    expect(diagnostics.toJSON().efficiency).toEqual({
      toolCalls: 0,
      duplicateToolCalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
      tokenUsage: { input: 100, output: 20, reasoning: 5, cacheHit: 40 },
      maxCompactionLevel: 2,
      totalCompactedItems: 3,
      nudgeCount: 1,
      replanCount: 1,
      emptyRetries: 1,
      forcedSummary: true,
      cancelReason: 'abort_signal',
    });
  });
});

describe('bootstrap nudge and replan efficiency', () => {
  it('suppresses verbose bootstrap nudges after entering PRODUCE', () => {
    const generator = new NudgeGenerator();
    const metrics = {
      uniqueFiles: new Set<string>(),
      uniquePatterns: new Set<string>(),
      uniqueQueries: new Set<string>(),
      totalToolCalls: 0,
      submitCount: 0,
      memoryFindingCount: 0,
      roundsSinceNewInfo: 0,
      roundsSinceSubmit: 0,
      iteration: 9,
      searchRoundsInPhase: 0,
      phaseRounds: 0,
      consecutiveIdleRounds: 0,
    };

    const nudge = generator.generate(
      {
        phase: 'PRODUCE',
        metrics,
        budget: {
          maxIterations: 12,
          searchBudget: 8,
          searchBudgetGrace: 3,
          maxSubmits: 4,
          softSubmitLimit: 3,
          idleRoundsToExit: 2,
        },
        strategy: {
          name: 'bootstrap',
          enableReflection: true,
          reflectionInterval: 3,
          enablePlanning: true,
        },
        gracefulExitRound: null,
        submitToolName: 'knowledge',
        pipelineType: 'bootstrap',
        isTerminalPhase: false,
      },
      null
    );

    expect(nudge).toBeNull();
  });

  it('limits bootstrap replans outside terminal and produce phases', () => {
    const tracker = new PlanTracker();
    const trace = {
      expectPlan: () => undefined,
      getPlan: () => ({
        createdAtIteration: 1,
        steps: [{ description: 'Read runtime', status: 'pending' as const }],
      }),
    };

    const produceNudge = tracker.checkPlanning(
      {
        phase: 'PRODUCE',
        metrics: { iteration: 4 },
        budget: { maxIterations: 10 },
        strategy: { replanInterval: 1 },
        pipelineType: 'bootstrap',
        isTerminalPhase: false,
      },
      trace
    );

    expect(produceNudge).toBeNull();
  });
});
