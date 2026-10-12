/**
 * L5-P3 / I47 回归：降级与异常路径必须留下可定位的诊断。
 *
 * 覆盖面：
 * - LLMInputAssembly：tracker/trace 探针抛错或指标无法序列化时，evidenceContext 省略该行并发
 *   llm_input_context_probe_failed（带来源与原因）；
 * - ProviderToolChoicePolicy：tracker.getMetrics 抛错时 V4 analyze 首轮判为不适格（不再按零证据放行）并 warn；
 * - duplicateCache：结果无法 structuredClone 时不入缓存、记 TOOL_CACHE_CLONE_FAILED；缓存条目复制失败时按未命中处理；
 * - accessGates：参数无法序列化时诊断附带原因；
 * - processEvents：开发者数据序列化失败时文本注明原因，而不是只有 [object Object]；
 * - BudgetController：compactL4 抛异常与返回 failed 共用 hardStop 判定，并计入压缩统计；
 * - AgentRuntime：L4 成功压缩与 L4 调用用量进入运行诊断；
 * - runtimeBridge：请求装配失败与宿主执行失败分开归类，诊断附带错误原文。
 */
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import {
  AgentRuntime,
  BudgetController,
  buildLlmInputAssembly,
  createMessageAdapter,
  DiagnosticsCollector,
  LoopContext,
} from '../src/agent/runtime/index.js';
import {
  isAnalyzeFirstBurnGuardEligible,
  resolveProviderToolChoice,
} from '../src/agent/runtime/ProviderToolChoicePolicy.js';
import { projectToolStartEvent } from '../src/agent/runtime/processEvents.js';
import { toolArgumentBoundsGate } from '../src/agent/runtime/toolPipeline/accessGates.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { deterministicDuplicateGuard } from '../src/agent/runtime/toolPipeline/duplicateCache.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import type { ToolCallRequest, ToolResultEnvelope } from '../src/tools/kernel/index.js';
import type { ToolCapabilityManifest } from '../src/tools/kernel/manifest.js';

afterEach(() => vi.restoreAllMocks());

const V4_MODEL_REF = 'deepseek:deepseek-v4-flash';

function freshMetadata(): ToolMetadata {
  return { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
}

function warningsOf(diagnostics: DiagnosticsCollector) {
  return diagnostics.toJSON().warnings;
}

// ─── LLMInputAssembly ─────────────────────────────────────────

function createAnalyzeLoopContext(
  tracker: Record<string, unknown>,
  diagnostics: DiagnosticsCollector
): LoopContext {
  const messages = createMessageAdapter(null);
  messages.appendUserMessage('Analyze architecture for the design-patterns dimension.');
  return new LoopContext({
    allowedToolIds: ['code'],
    baseSystemPrompt: 'Analyst identity prompt',
    budget: { maxIterations: 1 },
    capabilities: [],
    context: { dimensionId: 'design-patterns', pipelinePhase: 'analyze', targetName: 'Demo' },
    diagnostics,
    messages,
    prompt: 'Analyze the design patterns.',
    source: 'system',
    toolSchemas: [{ name: 'code', description: 'Read source files' }],
    tracker: tracker as never,
  });
}

function assembleEvidenceContext(ctx: LoopContext) {
  const assembly = buildLlmInputAssembly({
    ctx,
    dynamicContext: null,
    effectiveToolChoice: 'auto',
    messages: ctx.messages.toMessages(),
    modelRef: 'unit-model',
    requestedToolChoice: 'auto',
    systemPrompt: 'Analyst identity prompt',
    tools: [{ name: 'code', description: 'Read source files' }],
  });
  return assembly.sections.find((section) => section.id === 'evidenceContext')?.content ?? '';
}

describe('LLMInputAssembly evidenceContext probes', () => {
  it('reports a throwing tracker.getMetrics probe instead of silently dropping the line', () => {
    const diagnostics = new DiagnosticsCollector();
    const ctx = createAnalyzeLoopContext(
      {
        phase: 'SCAN',
        pipelineType: 'analyst',
        getMetrics: () => {
          throw new Error('metrics store corrupted');
        },
        getPlanProgress: () => ({ coveredSteps: 1, totalSteps: 3 }),
      },
      diagnostics
    );

    const evidenceContext = assembleEvidenceContext(ctx);

    expect(evidenceContext).not.toContain('trackerMetrics:');
    expect(evidenceContext).toContain('planProgress:');
    const probeWarnings = warningsOf(diagnostics).filter(
      (warning) => warning.code === 'llm_input_context_probe_failed'
    );
    expect(probeWarnings).toHaveLength(1);
    expect(probeWarnings[0].message).toContain('tracker.getMetrics');
    expect(probeWarnings[0].message).toContain('metrics store corrupted');
    expect(probeWarnings[0].stage).toBe('analyze');
  });

  it('reports unserializable telemetry and keeps the placeholder text', () => {
    const diagnostics = new DiagnosticsCollector();
    const ctx = createAnalyzeLoopContext(
      {
        phase: 'SCAN',
        pipelineType: 'analyst',
        getMetrics: () => ({ evidenceToolCallCount: 2 }),
        getPlanProgress: () => ({ coveredSteps: 1n }),
      },
      diagnostics
    );

    const evidenceContext = assembleEvidenceContext(ctx);

    expect(evidenceContext).toContain('planProgress: "[unserializable]"');
    const probeWarnings = warningsOf(diagnostics).filter(
      (warning) => warning.code === 'llm_input_context_probe_failed'
    );
    expect(probeWarnings).toHaveLength(1);
    expect(probeWarnings[0].message).toContain('planProgress');
    expect(probeWarnings[0].message).toMatch(/BigInt/);
  });
});

// ─── ProviderToolChoicePolicy ─────────────────────────────────

describe('ProviderToolChoicePolicy tracker probe failure', () => {
  const throwingTracker = {
    phase: 'EXPLORE',
    pipelineType: 'analyst',
    getMetrics: () => {
      throw new Error('metrics store corrupted');
    },
  };

  it('keeps the zero-evidence EXPLORE first burn eligible when metrics are readable', () => {
    const ctx = {
      tracker: {
        phase: 'EXPLORE',
        pipelineType: 'analyst',
        getMetrics: () => ({ evidenceToolCallCount: 0, memoryFindingCount: 0 }),
      },
    };
    expect(isAnalyzeFirstBurnGuardEligible(ctx, V4_MODEL_REF)).toBe(true);
  });

  it('treats a throwing getMetrics as ineligible and warns with modelRef and trackerPhase', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    expect(isAnalyzeFirstBurnGuardEligible({ tracker: throwingTracker }, V4_MODEL_REF)).toBe(false);
    const decision = resolveProviderToolChoice({ tracker: throwingTracker }, V4_MODEL_REF, 'none');
    expect(decision).toEqual({ keepToolSchemasVisible: false, mode: null });

    const probeWarns = warn.mock.calls.filter(([message]) =>
      String(message).includes('ProviderToolChoicePolicy')
    );
    expect(probeWarns.length).toBeGreaterThanOrEqual(1);
    expect(probeWarns[0][1]).toMatchObject({
      modelRef: V4_MODEL_REF,
      trackerPhase: 'EXPLORE',
      error: 'metrics store corrupted',
    });
  });
});

// ─── duplicateCache ───────────────────────────────────────────

function readOnlyManifest(id: string): ToolCapabilityManifest {
  return {
    id,
    title: id,
    kind: 'internal-tool',
    description: 'Read-only graph query',
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
}

function cacheContext(diagnostics: DiagnosticsCollector, sharedState: Record<string, unknown>) {
  return {
    runtime: {
      id: 'cache-runtime',
      presetName: 'cache-preset',
      toolRegistry: { getManifest: (id: string) => readOnlyManifest(id) },
    },
    loopCtx: {
      source: 'system',
      context: { projectSnapshotId: 'snap-1', pipelinePhase: 'analyze' },
      sharedState,
      diagnostics,
      tracker: null,
    },
    iteration: 1,
  } as unknown as ToolPipelineContext;
}

describe('deterministicDuplicateGuard clone failures', () => {
  const call = { id: 'call-1', name: 'graph', args: { action: 'query', q: 'deps' } };

  it('does not cache a result that cannot be cloned and records TOOL_CACHE_CLONE_FAILED', () => {
    const diagnostics = new DiagnosticsCollector();
    const sharedState: Record<string, unknown> = {};
    const ctx = cacheContext(diagnostics, sharedState);
    const meta = freshMetadata();

    expect(deterministicDuplicateGuard.before(call, ctx as never, meta)).toBeUndefined();
    expect(meta.cacheEligible).toBe(true);
    const result = { items: ['a'], render: () => 'not cloneable' };
    deterministicDuplicateGuard.after(call, result, ctx as never, meta);

    const cache = sharedState._toolEfficiencyCache as Map<string, unknown>;
    expect(cache.size).toBe(0);
    const warning = warningsOf(diagnostics).find((item) => item.code === 'TOOL_CACHE_CLONE_FAILED');
    expect(warning).toBeDefined();
    expect(warning?.tool).toBe('graph');
    expect(warning?.message).toContain('graph');

    // 第二次相同调用不能命中（也就不会拿到与第一次共享的对象引用）。
    const second = freshMetadata();
    expect(deterministicDuplicateGuard.before(call, ctx as never, second)).toBeUndefined();
    expect(second.cacheHit).toBe(false);
  });

  it('caches cloneable results as before', () => {
    const diagnostics = new DiagnosticsCollector();
    const sharedState: Record<string, unknown> = {};
    const ctx = cacheContext(diagnostics, sharedState);
    const meta = freshMetadata();
    deterministicDuplicateGuard.before(call, ctx as never, meta);
    const result = { items: ['a'] };
    deterministicDuplicateGuard.after(call, result, ctx as never, meta);

    const second = freshMetadata();
    const verdict = deterministicDuplicateGuard.before(call, ctx as never, second);
    expect(second.cacheHit).toBe(true);
    expect(verdict?.result).toEqual(result);
    expect(verdict?.result).not.toBe(result);
    expect(warningsOf(diagnostics)).toEqual([]);
  });

  it('treats a cached entry that cannot be copied as a miss and evicts it', () => {
    const diagnostics = new DiagnosticsCollector();
    const sharedState: Record<string, unknown> = {};
    const ctx = cacheContext(diagnostics, sharedState);
    const probe = freshMetadata();
    deterministicDuplicateGuard.before(call, ctx as never, probe);
    const key = probe.cacheKey as string;
    // 直接写入一个不可复制的条目，模拟旧版本留下的共享引用。
    const cache = new Map<string, unknown>([[key, { result: { render: () => 'x' } }]]);
    sharedState._toolEfficiencyCache = cache;

    const meta = freshMetadata();
    expect(deterministicDuplicateGuard.before(call, ctx as never, meta)).toBeUndefined();
    expect(meta.cacheHit).toBe(false);
    expect(meta.duplicateShortCircuit).toBeFalsy();
    expect(cache.has(key)).toBe(false);
    expect(warningsOf(diagnostics)).toContainEqual(
      expect.objectContaining({ code: 'TOOL_CACHE_CLONE_FAILED', tool: 'graph' })
    );
  });
});

// ─── accessGates ──────────────────────────────────────────────

describe('toolArgumentBoundsGate serialization failure', () => {
  it('blocks unserializable args and includes the serialization error in the diagnostic', () => {
    const diagnostics = new DiagnosticsCollector();
    const ctx = { runtime: {}, loopCtx: { diagnostics }, iteration: 1 } as never;

    const verdict = toolArgumentBoundsGate.before(
      { id: 'call-1', name: 'graph', args: { depth: 1n } },
      ctx
    );

    expect(verdict).toMatchObject({
      blocked: true,
      result: { error: 'Tool arguments could not be serialized', code: 'TOOL_ARGS_INVALID' },
    });
    const warning = warningsOf(diagnostics).find((item) => item.code === 'TOOL_ARGS_INVALID');
    expect(warning?.message).toMatch(/BigInt/);
  });
});

// ─── processEvents ────────────────────────────────────────────

describe('processEvents developer data degrade', () => {
  it('states why developer data could not be serialized', () => {
    const event = projectToolStartEvent(
      { id: 'call-1', name: 'graph', args: { depth: 1n } } as never,
      'system'
    );
    const text = event.content?.text ?? '';
    expect(text).toContain('tool: graph');
    expect(text).toMatch(/not serializable/);
    expect(text).toMatch(/BigInt/);
  });
});

// ─── BudgetController L4 exception path ───────────────────────

function createL4Controller(contextWindow: ContextWindow) {
  const controller = new BudgetController({
    maxSessionInputTokens: 1000,
    cumulativeUsage: { input: 0, output: 0, reasoning: 0, cacheHit: 0 },
    contextWindow,
    tracker: null,
    baseSystemPromptLength: 100,
    toolSchemaCount: 0,
    logger: { info: () => undefined, warn: () => undefined },
    enableL4Compaction: true,
  });
  // 阶段内压力 1.1：处于“连续失败 ≥2 且 ≥1.0”与“≥1.3 立即硬停”之间。
  controller.recordLLMUsage({ inputTokens: 1100 });
  return controller;
}

function createL4Window(): ContextWindow {
  const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
  contextWindow.appendUserMessage('initial prompt');
  contextWindow.appendUserMessage('large message');
  return contextWindow;
}

const unusedProvider = { chatWithTools: vi.fn(async () => ({ text: '' })) };

describe('BudgetController L4 exception path', () => {
  it('hard-stops on the second thrown L4 failure under 1.0–1.3 pressure, like a returned failure', async () => {
    const returnedWindow = createL4Window();
    vi.spyOn(returnedWindow, 'compactL4').mockResolvedValue({
      level: 4,
      removed: 0,
      failed: true,
    });
    const returned = createL4Controller(returnedWindow);
    returned.requestL4Compaction();
    const returnedFirst = await returned.executeL4IfPending(unusedProvider);
    returned.requestL4Compaction();
    const returnedSecond = await returned.executeL4IfPending(unusedProvider);

    const thrownWindow = createL4Window();
    vi.spyOn(thrownWindow, 'compactL4').mockRejectedValue(new Error('l4 transport exploded'));
    const thrown = createL4Controller(thrownWindow);
    thrown.requestL4Compaction();
    const thrownFirst = await thrown.executeL4IfPending(unusedProvider);
    thrown.requestL4Compaction();
    const thrownSecond = await thrown.executeL4IfPending(unusedProvider);

    expect(returnedFirst.hardStop).toBeUndefined();
    expect(thrownFirst.hardStop).toBeUndefined();
    expect(returnedSecond).toMatchObject({
      hardStop: true,
      reason: 'l4_compaction_failed_budget_exhausted',
    });
    expect(thrownSecond).toEqual(returnedSecond);
    expect(thrownFirst).toEqual({ level: 4, removed: 0, failed: true });
    expect(thrown.getSessionSummary().maxCompactionLevel).toBe(4);
  });

  it('logs the thrown L4 error message', async () => {
    const warnLines: string[] = [];
    const contextWindow = createL4Window();
    vi.spyOn(contextWindow, 'compactL4').mockRejectedValue(new Error('l4 transport exploded'));
    const controller = new BudgetController({
      maxSessionInputTokens: 1000,
      cumulativeUsage: { input: 0, output: 0, reasoning: 0, cacheHit: 0 },
      contextWindow,
      tracker: null,
      baseSystemPromptLength: 100,
      toolSchemaCount: 0,
      logger: { info: () => undefined, warn: (msg: string) => warnLines.push(msg) },
      enableL4Compaction: true,
    });
    controller.requestL4Compaction();
    await controller.executeL4IfPending(unusedProvider);
    expect(warnLines.some((line) => line.includes('l4 transport exploded'))).toBe(true);
  });
});

// ─── AgentRuntime L4 diagnostics ──────────────────────────────

describe('AgentRuntime L4 branch diagnostics', () => {
  it('records L4 compaction and L4 token usage in run diagnostics', async () => {
    const originalEnableL4 = process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION;
    process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION = '1';
    const chatWithTools = vi.fn(async () => ({
      text: 'final answer',
      functionCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    try {
      const runtime = new AgentRuntime({
        aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
        toolRegistry: { getManifest: () => null } as never,
        toolRouter: { execute: vi.fn() } as never,
        capabilities: [],
        strategy: { name: 'unused', execute: vi.fn() } as never,
      });
      const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
      contextWindow.appendUserMessage('initial prompt');
      contextWindow.appendUserMessage('oversized context');
      const compactL4 = vi.spyOn(contextWindow, 'compactL4').mockResolvedValue({
        level: 4,
        removed: 3,
        usage: { inputTokens: 40, outputTokens: 9 },
      });

      const result = await runtime.reactLoop('analyze', {
        source: 'system',
        contextWindow,
        budgetOverride: { maxIterations: 1, timeoutMs: 1000, maxSessionInputTokens: 10 },
      });

      expect(compactL4).toHaveBeenCalled();
      const efficiency = result.diagnostics?.efficiency;
      expect(efficiency?.maxCompactionLevel).toBe(4);
      expect(efficiency?.totalCompactedItems).toBeGreaterThanOrEqual(
        3 * compactL4.mock.calls.length
      );
      expect(efficiency?.tokenUsage.input).toBeGreaterThanOrEqual(40 * compactL4.mock.calls.length);
      expect(efficiency?.tokenUsage.output).toBeGreaterThanOrEqual(9 * compactL4.mock.calls.length);
    } finally {
      if (originalEnableL4 === undefined) {
        delete process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION;
      } else {
        process.env.ALEMBIC_AGENT_ENABLE_L4_COMPACTION = originalEnableL4;
      }
    }
  });
});

// ─── runtimeBridge ────────────────────────────────────────────

function bridgeContext(
  execute: (request: ToolCallRequest) => Promise<ToolResultEnvelope>,
  diagnostics: DiagnosticsCollector,
  allowedToolActions: Record<string, unknown> = {}
): ToolPipelineContext {
  return {
    runtime: {
      id: 'bridge-runtime',
      presetName: 'bridge-preset',
      policies: {},
      toolRouter: { execute },
    },
    loopCtx: {
      allowedToolIds: ['meta'],
      allowedToolActions,
      iteration: 1,
      source: 'bridge-source',
      diagnostics,
      abortSignal: null,
    },
    iteration: 1,
  } as unknown as ToolPipelineContext;
}

describe('runtimeBridge failure classification', () => {
  it('classifies request assembly failures separately and keeps the original error text', async () => {
    const diagnostics = new DiagnosticsCollector();
    const execute = vi.fn(async (): Promise<ToolResultEnvelope> => {
      throw new Error('should not be called');
    });
    const metadata = freshMetadata();

    const result = (await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      // 非数组的 action 白名单会让请求装配阶段的展开抛 TypeError。
      bridgeContext(execute, diagnostics, { meta: 7 }),
      metadata
    )) as { error: string };

    expect(execute).not.toHaveBeenCalled();
    expect(Object.keys(result)).toEqual(['error']);
    expect(result.error.length).toBeGreaterThan(0);
    const warnings = warningsOf(diagnostics);
    const assembly = warnings.find((item) => item.code === 'TOOL_REQUEST_ASSEMBLY_FAILED');
    expect(assembly).toBeDefined();
    expect(assembly?.message).toContain(result.error);
    expect(assembly?.tool).toBe('meta');
    expect(warnings.some((item) => item.code === 'TOOL_HOST_EXECUTION_FAILED')).toBe(false);
    expect(metadata.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes the router error text in TOOL_HOST_EXECUTION_FAILED', async () => {
    const diagnostics = new DiagnosticsCollector();

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => {
        throw new Error('router exploded');
      }, diagnostics),
      freshMetadata()
    );

    expect(result).toEqual({ error: 'router exploded' });
    const warning = warningsOf(diagnostics).find(
      (item) => item.code === 'TOOL_HOST_EXECUTION_FAILED'
    );
    expect(warning?.message).toContain('router exploded');
    expect(warning?.tool).toBe('meta');
    expect(
      warningsOf(diagnostics).some((item) => item.code === 'TOOL_REQUEST_ASSEMBLY_FAILED')
    ).toBe(false);
  });

  it('truncates very long error text in the diagnostic but returns it unchanged', async () => {
    const diagnostics = new DiagnosticsCollector();
    const longMessage = `router exploded ${'x'.repeat(2000)}`;

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => {
        throw new Error(longMessage);
      }, diagnostics),
      freshMetadata()
    );

    expect(result).toEqual({ error: longMessage });
    const warning = warningsOf(diagnostics).find(
      (item) => item.code === 'TOOL_HOST_EXECUTION_FAILED'
    );
    expect(warning?.message).toContain('router exploded');
    expect(warning?.message.length).toBeLessThan(longMessage.length);
  });
});
