import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import { NudgeGenerator, PlanTracker } from '../src/agent/context/index.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { PolicyEngine, SafetyPolicy } from '../src/agent/policies/index.js';
import type { AgentRuntime, LoopContext } from '../src/agent/runtime/index.js';
import {
  createToolPipeline,
  DiagnosticsCollector,
  ToolExecutionPipeline,
} from '../src/agent/runtime/index.js';
import {
  eventBusPublisher,
  progressEmitter,
  submitDedup,
  trackerSignal,
} from '../src/agent/runtime/ToolExecutionPipeline.js';
import type { ToolCallRequest, ToolCapabilityManifest, ToolResultEnvelope } from '../src/index.js';
import { Evolution } from '../src/tools/runtime/toolsets/Evolution.js';
import { createTempProject } from './helpers/tempProject.js';

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

describe('tool pipeline lifecycle', () => {
  it.each([
    { label: 'success', status: 'success', ok: true, success: true },
    { label: 'usable partial', status: 'partial', ok: true, success: true },
    { label: 'blocked', status: 'blocked', ok: false, success: false },
    { label: 'aborted', status: 'aborted', ok: false, success: false },
    { label: 'timeout', status: 'timeout', ok: false, success: false },
    { label: 'error', status: 'error', ok: false, success: false },
    { label: 'needs confirmation', status: 'needs-confirmation', ok: false, success: false },
    { label: 'timeout despite ok flag', status: 'timeout', ok: true, success: false },
  ] as const)('reports $label consistently to optional observers without losing the payload', async ({
    status,
    ok,
    success,
  }) => {
    const payload = { output: 'available readback' };
    const emitProgress = vi.fn();
    const publish = vi.fn();
    const runtime = createRuntime(createManifest(), async (request) => ({
      ...createEnvelope(request, 1),
      ok,
      status,
      text: 'host result details',
      structuredContent: payload,
    }));
    // 只替代通知端口；真实 pipeline/bridge 负责 envelope 和 metadata 的投影。
    Object.assign(runtime, { emitProgress, bus: { publish } });
    const result = await new ToolExecutionPipeline()
      .use(progressEmitter)
      .use(eventBusPublisher)
      .execute(
        { id: 'read', name: 'code', args: { action: 'read' } },
        { runtime, loopCtx: createLoopContext(new DiagnosticsCollector()), iteration: 1 }
      );

    expect(result.result).toBe(payload);
    expect(result.metadata.envelope).toMatchObject({ ok, status, structuredContent: payload });
    expect(emitProgress).toHaveBeenCalledWith('tool_end', {
      tool: 'code',
      duration: result.metadata.durationMs,
      status: success ? 'ok' : 'error',
      error: success ? undefined : 'host result details',
    });
    expect(publish).toHaveBeenCalledWith(
      'tool:call:end',
      { agentId: runtime.id, tool: 'code', durationMs: result.metadata.durationMs, success },
      { source: runtime.id }
    );
  });

  it('reports a metadata-only blocked verdict as failure to optional observers', async () => {
    const execute = vi.fn();
    const emitProgress = vi.fn();
    const publish = vi.fn();
    const payload = { retained: 'readback instruction' };
    const runtime = createRuntime(createManifest(), execute);
    Object.assign(runtime, { emitProgress, bus: { publish } });
    const result = await new ToolExecutionPipeline()
      .use({ name: 'blocked', before: () => ({ blocked: true, result: payload }) })
      .use(progressEmitter)
      .use(eventBusPublisher)
      .execute(
        { id: 'read', name: 'code', args: { action: 'read' } },
        { runtime, loopCtx: createLoopContext(new DiagnosticsCollector()), iteration: 1 }
      );

    expect(execute).not.toHaveBeenCalled();
    expect(result.result).toBe(payload);
    expect(emitProgress).toHaveBeenCalledWith(
      'tool_end',
      expect.objectContaining({ status: 'error' })
    );
    expect(publish).toHaveBeenCalledWith(
      'tool:call:end',
      expect.objectContaining({ success: false }),
      { source: runtime.id }
    );
  });

  it('captures evidence before memory, tracker and trace consume the same envelope', async () => {
    const order: string[] = [];
    const ledger = new EvidenceLedgerStore({
      dataRoot: createTempProject('pipeline-order-'),
      jobId: 'job',
      sessionId: 'session',
      dimensionId: 'dimension',
    });
    const runtime = createRuntime(createManifest(), async (request) => ({
      ...createEnvelope(request, 1),
      text: 'export const value = 1;',
      structuredContent: { files: [{ path: 'src/a.ts', content: 'export const value = 1;' }] },
    }));
    const loopCtx = createLoopContext(new DiagnosticsCollector());
    loopCtx.evidenceLedger = ledger;
    // 这些观察端口只替代外部消费者；台账、默认工厂与 envelope 流转使用真实实现。
    loopCtx.memoryCoordinator = {
      recordObservation: (_name: string, _args: unknown, envelope: ToolResultEnvelope) => {
        expect(envelope.text).toContain('[evidence]');
        order.push('memory');
      },
    } as never;
    loopCtx.tracker = {
      noteLedgerStats: () => {
        order.push('ledger');
      },
      recordToolCall: () => {
        order.push('tracker');
        return { isNew: true };
      },
    } as never;
    loopCtx.trace = {
      recordToolCall: (
        _name: string,
        _args: unknown,
        envelope: ToolResultEnvelope,
        isNew: boolean
      ) => {
        expect(envelope.text).toContain('[evidence]');
        expect(isNew).toBe(true);
        order.push('trace');
      },
    } as never;
    const result = await createToolPipeline().execute(
      { id: 'read', name: 'code', args: { action: 'read', params: { path: 'src/a.ts' } } },
      { runtime, loopCtx, iteration: 1 }
    );
    expect(result.metadata.envelope?.text).toContain('[evidence]');
    expect(order).toEqual(['ledger', 'memory', 'tracker', 'trace']);
  });
  it('awaits before hooks and invokes after hooks in registration order', async () => {
    const events: string[] = [];
    const runtime = createRuntime(createManifest(), async (request) => {
      events.push('execute');
      return createEnvelope(request, 1);
    });
    const pipeline = new ToolExecutionPipeline()
      .use({
        name: 'first',
        before: async () => {
          events.push('before:first');
          await Promise.resolve();
          events.push('before:first:awaited');
        },
        after: () => {
          events.push('after:first');
        },
      })
      .use({
        name: 'second',
        before: () => {
          events.push('before:second');
        },
        after: () => {
          events.push('after:second');
        },
      });
    const result = await pipeline.execute(
      { id: 'read', name: 'code', args: { action: 'read' } },
      { runtime, loopCtx: createLoopContext(new DiagnosticsCollector()), iteration: 1 }
    );
    expect(result.result).toEqual({ executeCount: 1 });
    expect(events).toEqual([
      'before:first',
      'before:first:awaited',
      'before:second',
      'execute',
      'after:first',
      'after:second',
    ]);
  });
  it.each([
    { label: 'null', verdict: { result: null }, blocked: false },
    { label: 'zero', verdict: { result: 0 }, blocked: false },
    { label: 'false', verdict: { result: false }, blocked: false },
    { label: 'empty string', verdict: { result: '' }, blocked: false },
    { label: 'blocked without result', verdict: { blocked: true }, blocked: true },
  ])('short-circuits a $label verdict but still runs all after hooks', async ({
    verdict,
    blocked,
  }) => {
    const execute = vi.fn();
    const after = vi.fn();
    const laterBefore = vi.fn();
    const runtime = createRuntime(createManifest(), execute);
    const pipeline = new ToolExecutionPipeline()
      .use({ name: 'stop', before: () => verdict, after })
      .use({ name: 'later', before: laterBefore, after });
    const result = await pipeline.execute(
      { id: 'read', name: 'code', args: {} },
      { runtime, loopCtx: createLoopContext(new DiagnosticsCollector()), iteration: 1 }
    );
    expect(execute).not.toHaveBeenCalled();
    expect(laterBefore).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(2);
    expect(result.result).toBe('result' in verdict ? verdict.result : undefined);
    expect(result.metadata).toMatchObject({ blocked, cacheHit: !blocked });
  });
  it.each([
    'before',
    'after',
  ])('propagates a custom %s hook failure without silently continuing', async (phase) => {
    const execute = vi.fn(async (request: ToolCallRequest) => createEnvelope(request, 1));
    const laterAfter = vi.fn();
    const fail = async () => {
      throw new Error('custom middleware failed');
    };
    const pipeline = new ToolExecutionPipeline()
      .use({ name: 'failing', [phase]: fail })
      .use({ name: 'later', after: laterAfter });
    const runtime = createRuntime(createManifest(), execute);
    await expect(
      pipeline.execute(
        { id: 'read', name: 'code', args: {} },
        { runtime, loopCtx: createLoopContext(new DiagnosticsCollector()), iteration: 1 }
      )
    ).rejects.toThrow('custom middleware failed');
    expect(execute).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
    expect(laterAfter).not.toHaveBeenCalled();
  });
});

describe('runtime efficiency diagnostics', () => {
  it('isolates mutable entries in every public diagnostic snapshot', () => {
    const diagnostics = new DiagnosticsCollector({
      warnings: [{ code: 'known_warning', message: 'original warning' }],
      blockedTools: [{ tool: 'terminal', reason: 'original block' }],
      gateFailures: [{ stage: 'review', action: 'degrade', reason: 'original failure' }],
      toolCalls: [
        {
          tool: 'code',
          callId: 'read',
          status: 'success',
          ok: true,
          startedAt: 'now',
          durationMs: 1,
        },
      ],
      stageToolsets: [
        {
          stage: 'review',
          capabilities: ['read'],
          allowedToolIds: ['code'],
          allowedToolActions: { code: ['read'] },
          toolSchemaCount: 1,
        },
      ],
    });
    diagnostics.recordTokenUsage({ inputTokens: 5 });
    const snapshot = diagnostics.toJSON();
    const expected = structuredClone(snapshot);
    assert(snapshot.toolCalls);
    assert(snapshot.stageToolsets);
    assert(snapshot.stageToolsets[0].allowedToolActions);
    assert(snapshot.efficiency);
    snapshot.warnings[0].message = 'changed warning';
    snapshot.blockedTools[0].reason = 'changed block';
    snapshot.gateFailures[0].reason = 'changed failure';
    snapshot.toolCalls[0].status = 'changed status';
    snapshot.stageToolsets[0].capabilities.push('changed capability');
    snapshot.stageToolsets[0].allowedToolIds.push('terminal');
    snapshot.stageToolsets[0].allowedToolActions.code.push('write');
    snapshot.efficiency.tokenUsage.input = 100;
    expect(diagnostics.toJSON()).toEqual(expected);
  });

  it.each(['seed', 'warn'])('owns warning entries accepted through %s', (entrypoint) => {
    const warning = { code: 'known_warning', message: 'original warning' };
    const diagnostics =
      entrypoint === 'seed'
        ? DiagnosticsCollector.from({ warnings: [warning] })
        : new DiagnosticsCollector();
    if (entrypoint === 'warn') {
      diagnostics.warn(warning);
    }
    warning.message = 'changed by caller';
    expect(diagnostics.toJSON().warnings).toEqual([
      { code: 'known_warning', message: 'original warning' },
    ]);
  });

  it('bounds unknown counters and merges large diagnostic counts without blocking the runtime', () => {
    // 无限循环回归只在可强制终止的子进程运行；转译真实收集器源码，不读取旧 dist。
    const source = fileURLToPath(
      new URL('../src/agent/runtime/DiagnosticsCollector.ts', import.meta.url)
    );
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { readFileSync } from 'node:fs';
          import ts from 'typescript';
          const { outputText } = ts.transpileModule(readFileSync(${JSON.stringify(source)}, 'utf8'), {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
          });
          const { DiagnosticsCollector } = await import(
            'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
          );
          console.log('before: DiagnosticsCollector.from({ emptyResponses: Infinity })');
          const collector = DiagnosticsCollector.from({ emptyResponses: Infinity });
          collector.merge({ aiErrorCount: Infinity, truncatedToolCalls: Infinity });
          const invalid = collector.toJSON();
          collector.merge({ emptyResponses: 1_000_000_000_000, aiErrorCount: 1_000_000_000_000 });
          collector.recordEmptyResponse();
          collector.recordAiError('known failure');
          console.log(JSON.stringify({ invalid, merged: collector.toJSON() }));
        `,
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        timeout: 3000,
        killSignal: 'SIGKILL',
      }
    );
    expect(result.stdout).toContain('before: DiagnosticsCollector.from');
    expect(result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const { invalid, merged } = JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}');
    expect(invalid).toMatchObject({ emptyResponses: 0, aiErrorCount: 0, truncatedToolCalls: 0 });
    expect(invalid.warnings).toHaveLength(3);
    expect(invalid.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'diagnostics_invalid_count',
          message: expect.stringContaining('emptyResponses'),
        }),
        expect.objectContaining({
          code: 'diagnostics_invalid_count',
          message: expect.stringContaining('aiErrorCount'),
        }),
        expect.objectContaining({
          code: 'diagnostics_invalid_count',
          message: expect.stringContaining('truncatedToolCalls'),
        }),
      ])
    );
    expect(merged).toMatchObject({
      emptyResponses: 1_000_000_000_001,
      aiErrorCount: 1_000_000_000_001,
    });
  });

  it.each([
    Number.NaN,
    -1,
    '2',
    null,
  ])('reports invalid diagnostic count %s without coercing it or discarding valid siblings', (invalid) => {
    const diagnostics = DiagnosticsCollector.from({
      emptyResponses: invalid,
      aiErrorCount: 2,
      efficiency: {
        toolCalls: 3,
        cacheHits: invalid,
        tokenUsage: { input: invalid, output: 5 },
        maxCompactionLevel: invalid,
        totalCompactedItems: invalid,
        nudgeCount: invalid,
        replanCount: invalid,
        emptyRetries: invalid,
      },
    });
    const snapshot = diagnostics.toJSON();
    expect(snapshot).toMatchObject({
      emptyResponses: 0,
      aiErrorCount: 2,
      efficiency: {
        toolCalls: 3,
        cacheHits: 0,
        tokenUsage: { input: 0, output: 5 },
        maxCompactionLevel: 0,
        totalCompactedItems: 0,
        nudgeCount: 0,
        replanCount: 0,
        emptyRetries: 0,
      },
    });
    expect(snapshot.warnings).toHaveLength(8);
    expect(snapshot.warnings.every((warning) => warning.code === 'diagnostics_invalid_count')).toBe(
      true
    );
  });

  it('validates direct counters and rejects overflowing additions without inventing infinite totals', () => {
    const diagnostics = new DiagnosticsCollector();
    diagnostics.recordTruncatedToolCalls(Infinity);
    diagnostics.recordTokenUsage({
      inputTokens: Infinity,
      outputTokens: -2,
      reasoningTokens: Number.NaN,
    });
    diagnostics.recordCompaction({ level: Infinity, removed: -1 });
    expect(diagnostics.toJSON()).toMatchObject({
      truncatedToolCalls: 0,
      efficiency: {
        tokenUsage: { input: 0, output: 0, reasoning: 0, cacheHit: 0 },
        maxCompactionLevel: 0,
        totalCompactedItems: 0,
      },
    });
    expect(diagnostics.toJSON().warnings).toHaveLength(6);

    diagnostics.recordTruncatedToolCalls(Number.MAX_VALUE);
    diagnostics.recordTokenUsage({ inputTokens: Number.MAX_VALUE });
    diagnostics.recordCompaction({ level: 2, removed: Number.MAX_VALUE });
    diagnostics.merge({
      truncatedToolCalls: Number.MAX_VALUE,
      efficiency: {
        tokenUsage: { input: Number.MAX_VALUE },
        totalCompactedItems: Number.MAX_VALUE,
      },
    });
    expect(diagnostics.toJSON()).toMatchObject({
      truncatedToolCalls: Number.MAX_VALUE,
      efficiency: {
        tokenUsage: { input: Number.MAX_VALUE },
        maxCompactionLevel: 2,
        totalCompactedItems: Number.MAX_VALUE,
      },
    });
    expect(diagnostics.toJSON().warnings).toHaveLength(9);
  });

  it.each([
    {
      label: 'Error',
      failure: new Error('transient host failure'),
      message: 'transient host failure',
    },
    { label: 'string', failure: 'transient host failure', message: 'transient host failure' },
    { label: 'unknown', failure: null, message: 'Tool execution failed' },
  ])('retries the host after a $label failure instead of caching it', async ({
    failure,
    message,
  }) => {
    let attempts = 0;
    const runtime = createRuntime(createManifest({ id: 'snapshot.lookup' }), async (request) => {
      attempts++;
      // 外部宿主未必遵守只抛 Error 的规则，用拒绝值覆盖真正的输入边界。
      if (attempts === 1) {
        return Promise.reject(failure);
      }
      return createEnvelope(request, attempts);
    });
    const loopCtx = createLoopContext(new DiagnosticsCollector());
    loopCtx.allowedToolIds = ['snapshot.lookup'];
    const call = { id: 'snapshot-lookup', name: 'snapshot.lookup', args: { action: 'read' } };
    const pipeline = createToolPipeline();
    expect((await pipeline.execute(call, { runtime, loopCtx, iteration: 1 })).result).toEqual({
      error: message,
    });
    const recovered = await pipeline.execute(call, { runtime, loopCtx, iteration: 2 });
    expect(recovered.result).toEqual({ executeCount: 2 });
    expect(recovered.metadata.duplicateShortCircuit).not.toBe(true);
    expect(attempts).toBe(2);
    const cached = await pipeline.execute(call, { runtime, loopCtx, iteration: 3 });
    expect(cached.result).toEqual({ executeCount: 2 });
    expect(cached.metadata.duplicateShortCircuit).toBe(true);
    expect(attempts).toBe(2);
  });
  it.each([
    'blocked',
    'timeout',
    'metadata-blocked',
  ])('never counts a %s tool result as a persisted submission', (failure) => {
    const loopCtx = createLoopContext(new DiagnosticsCollector());
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 10 }
    );
    loopCtx.tracker = tracker;
    loopCtx.sharedState = { submittedTitles: new Set() };
    const call = {
      id: 'call',
      name: 'knowledge',
      args: { action: 'submit', params: { title: 'Candidate' } },
    };
    const result = { status: 'created', id: 'candidate', lifecycle: 'pending' };
    const envelope = {
      ok: true,
      status: failure,
      structuredContent: result,
    } as unknown as ToolResultEnvelope;
    const metadata = {
      blocked: failure === 'metadata-blocked',
      cacheHit: false,
      isNew: false,
      isSubmit: false,
      durationMs: 0,
      ...(failure === 'metadata-blocked' ? {} : { envelope }),
    };
    const ctx = { runtime: {} as AgentRuntime, loopCtx, iteration: 1 };
    trackerSignal.after(call, result, ctx, metadata);
    submitDedup.after(call, result, ctx, metadata);
    expect(tracker?.totalSubmits).toBe(0);
    expect(metadata.isSubmit).toBe(false);
    expect(loopCtx.sharedState.submittedTitles).toEqual(new Set());
  });
  it('validates repository-relative code paths against the analyzed project root', async () => {
    let executions = 0;
    const runtime = createRuntime(createManifest(), async (request) =>
      createEnvelope(request, ++executions)
    );
    Object.assign(runtime, { projectRoot: '/tmp/review-other-project' });
    runtime.policies = new PolicyEngine([
      new SafetyPolicy({ fileScope: '/tmp/review-other-project' }),
    ]);
    const result = await createToolPipeline().execute(
      { id: 'read', name: 'code', args: { action: 'read', params: { path: 'src/a.ts' } } },
      { runtime, loopCtx: createLoopContext(new DiagnosticsCollector()), iteration: 1 }
    );
    expect(result.metadata.blocked).toBe(false);
    expect(executions).toBe(1);
  });
  it.each([
    'get',
    'search',
  ])('allows the producer to retrieve existing evidence with %s', async (action) => {
    let executions = 0;
    const runtime = createRuntime(createManifest({ id: 'evidence' }), async (request) =>
      createEnvelope(request, ++executions)
    );
    const loopCtx = createLoopContext(new DiagnosticsCollector());
    loopCtx.allowedToolIds = ['evidence'];
    loopCtx.tracker = {
      pipelineType: 'producer',
      phase: 'PRODUCE',
      recordToolCall: () => ({ isNew: true }),
    } as never;
    const result = await createToolPipeline().execute(
      {
        id: 'evidence-read',
        name: 'evidence',
        args: { action, params: { id: 'E-1', query: 'file.ts' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    expect(result.metadata.blocked).toBe(false);
    expect(executions).toBe(1);
  });
  it('forwards direct finding depth slots through the memory tool bridge', async () => {
    let request: ToolCallRequest | undefined;
    const runtime = createRuntime(createManifest({ id: 'memory' }), async (input) => {
      request = input;
      return createEnvelope(input, 1);
    });
    const loopCtx = createLoopContext(new DiagnosticsCollector());
    loopCtx.allowedToolIds = ['memory'];
    await createToolPipeline().execute(
      {
        id: 'finding',
        name: 'note_finding',
        args: {
          finding: 'boundary',
          evidenceRefs: ['E-1'],
          importance: 8,
          designIntent: 'keep writes in the owner',
          failureModes: ['stale state'],
        },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    expect(request?.args.params).toMatchObject({
      designIntent: 'keep writes in the owner',
      failureModes: ['stale state'],
    });
  });
  it.each([
    'policy',
    'capability',
  ])('enforces %s restrictions before invoking the host router', async (mode) => {
    let executions = 0;
    const runtime = createRuntime(createManifest({ id: 'terminal' }), async (request) =>
      createEnvelope(request, ++executions)
    );
    runtime.policies = new PolicyEngine(
      mode === 'policy' ? [new SafetyPolicy({ commandBlacklist: [/custom-denied/] })] : []
    );
    const loopCtx = createLoopContext(new DiagnosticsCollector());
    loopCtx.allowedToolIds = ['terminal'];
    loopCtx.capabilities = mode === 'capability' ? [new Evolution()] : [];
    const call = {
      id: 'blocked',
      name: 'terminal',
      args: {
        action: 'exec',
        params: { command: mode === 'policy' ? 'custom-denied' : 'git checkout main' },
      },
    };
    const result = await createToolPipeline().execute(call, { runtime, loopCtx, iteration: 1 });
    expect(result.metadata.blocked).toBe(true);
    expect(executions).toBe(0);
  });
  it('blocks oversized tool arguments before execution or cache admission', async () => {
    const manifest = createManifest();
    let executeCount = 0;
    const runtime = createRuntime(manifest, async (request) => {
      executeCount += 1;
      return createEnvelope(request, executeCount);
    });
    const diagnostics = new DiagnosticsCollector();
    const loopCtx = createLoopContext(diagnostics);
    const pipeline = createToolPipeline();

    const result = await pipeline.execute(
      {
        id: 'large-args',
        name: 'code',
        args: { action: 'read', payload: 'x'.repeat(260_000) },
      },
      { runtime, loopCtx, iteration: 1 }
    );

    expect(executeCount).toBe(0);
    expect(result.metadata.blocked).toBe(true);
    expect(result.result).toMatchObject({
      code: 'TOOL_ARGS_TOO_LARGE',
      maxBytes: 256_000,
    });
    expect(diagnostics.toJSON().blockedTools).toEqual([
      { tool: 'code', reason: 'Tool arguments exceed 256000 bytes' },
    ]);
  });

  it('short-circuits duplicate deterministic tool calls within a session snapshot', async () => {
    const diagnostics = new DiagnosticsCollector();
    const manifest = createManifest({ id: 'snapshot.lookup' });
    let executeCount = 0;
    const runtime = createRuntime(manifest, async (request) => {
      executeCount++;
      return createEnvelope(request, executeCount);
    });
    const loopCtx = createLoopContext(diagnostics);
    loopCtx.allowedToolIds = ['snapshot.lookup'];
    const pipeline = createToolPipeline();
    const call = {
      id: 'tool-1',
      name: 'snapshot.lookup',
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

  it.each([
    'code',
    'memory',
    'knowledge',
    'meta',
  ])('does not bypass live %s reads with an old session result', async (tool) => {
    let count = 0;
    const runtime = createRuntime(createManifest({ id: tool }), async (request) =>
      createEnvelope(request, ++count)
    );
    const loopCtx = createLoopContext(new DiagnosticsCollector());
    loopCtx.allowedToolIds = [tool];
    const pipeline = createToolPipeline();
    const call = {
      id: 'read',
      name: tool,
      args: {
        action:
          tool === 'meta'
            ? 'review'
            : tool === 'memory'
              ? 'recall'
              : tool === 'code'
                ? 'read'
                : 'search',
        params: {},
      },
    };
    await pipeline.execute(call, { runtime, loopCtx, iteration: 1 });
    const second = await pipeline.execute(call, { runtime, loopCtx, iteration: 2 });
    expect(count).toBe(2);
    expect(second.result).toEqual({ executeCount: 2 });
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
      evidenceToolCallCount: 0,
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
