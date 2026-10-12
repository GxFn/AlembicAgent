/**
 * L5-P47 / I45 回归：工具管道死链收窄（只做不依赖待决事项①②的部分）。
 *
 * 1. observationRecord 在生产中是空操作：宿主路由总带信封，中间件以 cacheHit=true 调用
 *    MemoryCoordinator.recordObservation，不会写 SessionStore；无信封路径（门拦截、宿主抛错、
 *    发起前取消）都带 error，SessionStore 拒收。因此默认装配不再包含它；公开导出与
 *    SessionStore 工具缓存的去留等待事项②①，这里只锁定“仍可显式装配”。
 * 2. runtimeBridge 不再投影无人读取的 policyValidator / sessionToolCalls / currentRound，
 *    kernel/handler.ts 的 contextFromToolCall 也不再映射 _sessionToolCalls / _currentRound。
 *    cache 字段依决定①暂留（只加注释），这里断言它仍在请求里。
 *
 * 全部按生产形态构造：真实 createToolPipeline + 不带 capability 的真实 ToolRouterAdapter，
 * 宿主 contextFactory 记录它实际收到的 ToolCallRequest。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import type { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import { createToolPipeline as createToolPipelineFromRuntimeIndex } from '../src/agent/runtime/index.js';
import type { LoopContext } from '../src/agent/runtime/LoopContext.js';
import {
  createToolPipeline,
  observationRecord,
  ToolExecutionPipeline,
} from '../src/agent/runtime/ToolExecutionPipeline.js';
import type { ToolCallContext, ToolCallRequest } from '../src/tools/kernel/index.js';
import { contextFromToolCall } from '../src/tools/kernel/index.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import type { ToolContext } from '../src/tools/runtime/index.js';
import { Evolution } from '../src/tools/runtime/index.js';

/** 默认装配的完整顺序：控制门 → 缓存守卫 → 证据 → tracker → trace → 提交登记。 */
const DEFAULT_PIPELINE_ORDER = [
  'allowlistGate',
  'toolArgumentBoundsGate',
  'runtimeSafetyGate',
  'evolutionDecisionGate',
  'recordRepairOnlyGate',
  'analystVerifyOnlyGate',
  'producerSubmitOnlyGate',
  'deterministicDuplicateGuard',
  'evidenceCapture',
  'trackerSignal',
  'traceRecord',
  'submitDedup',
];

function terminalCall(command: string) {
  return {
    id: `call-${command}`,
    name: 'terminal',
    args: { action: 'exec', params: { command } },
  };
}

/** 与宿主 AgentModule 一致：Adapter 不带 capability，宿主 contextFactory 收到完整请求。 */
function makeProductionLikeRun(options: { memoryCoordinator?: MemoryCoordinator | null } = {}) {
  const requests: ToolCallRequest[] = [];
  const exec = vi.fn(async () => ({ stdout: 'clean\n', stderr: '', exitCode: 0 }));
  const toolContext: ToolContext = {
    projectRoot: process.cwd(),
    tokenBudget: 8000,
    sandboxExecutor: { exec },
  };
  const adapter = new ToolRouterAdapter({
    contextFactory: {
      create: (request: ToolCallRequest) => {
        requests.push(request);
        return toolContext;
      },
    },
  });
  const diagnostics = new DiagnosticsCollector();
  const runtime = {
    id: 'dead-link-runtime',
    presetName: 'evolution',
    container: null,
    projectRoot: process.cwd(),
    dataRoot: join(tmpdir(), 'alembic-agent-l5-p47'),
    fileCache: null,
    lang: null,
    logger: { info: vi.fn(), warn: vi.fn() },
    aiProvider: null,
    policies: { get: () => null },
    toolRegistry: { getManifest: () => null },
    toolRouter: adapter,
  } as unknown as AgentRuntime;
  // 历史调用记录：旧投影每次调用都会对它做一次 O(n) map。
  const toolCalls = [
    { tool: 'code', args: { action: 'search', params: { query: 'x' } } },
    { tool: 'terminal', args: { action: 'exec', params: { command: 'ls' } } },
  ];
  const trace = { recordToolCall: vi.fn() };
  const tracker = {
    recordToolCall: vi.fn(() => ({ isNew: true })),
    noteLedgerStats: vi.fn(),
  };
  const loopCtx = {
    allowedToolIds: ['code', 'terminal'],
    allowedToolActions: { code: ['search', 'read'], terminal: ['exec'] },
    capabilities: [new Evolution()],
    abortSignal: null,
    budget: {},
    context: { pipelinePhase: 'evolve' },
    diagnostics,
    evidenceLedger: null,
    iteration: 3,
    memoryCoordinator: options.memoryCoordinator ?? null,
    sharedState: {},
    source: 'system',
    toolCalls,
    tracker,
    trace,
  } as unknown as LoopContext;
  return { runtime, loopCtx, requests, exec, toolCalls, trace, tracker, diagnostics };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('default tool pipeline assembly (L5-P47 / I45)', () => {
  it('assembles the documented order without the no-op observationRecord', () => {
    const use = vi.spyOn(ToolExecutionPipeline.prototype, 'use');
    createToolPipeline();
    const names = use.mock.calls.map(([middleware]) => middleware.name);
    expect(names).toEqual(DEFAULT_PIPELINE_ORDER);
    expect(names).not.toContain('observationRecord');
  });

  it('keeps the runtime subpath factory identical to the facade factory', () => {
    // 公开面收窄（事项②）未决：runtime 子路径仍只建议使用 createToolPipeline 组装同等安全的管道。
    expect(createToolPipelineFromRuntimeIndex).toBe(createToolPipeline);
  });

  it('no longer reports tool observations to MemoryCoordinator from the default pipeline', async () => {
    const memory = new MemoryCoordinator();
    const recordObservation = vi.spyOn(memory, 'recordObservation');
    try {
      const { runtime, loopCtx, exec, trace, tracker } = makeProductionLikeRun({
        memoryCoordinator: memory,
      });
      const outcome = await createToolPipeline().execute(terminalCall('git status'), {
        runtime,
        loopCtx,
        iteration: 3,
      });
      expect(outcome.metadata.envelope?.ok).toBe(true);
      expect(exec).toHaveBeenCalledOnce();
      expect(recordObservation).not.toHaveBeenCalled();
      // 其余观察者仍消费同一个信封。
      expect(tracker.recordToolCall).toHaveBeenCalledOnce();
      expect(trace.recordToolCall).toHaveBeenCalledWith(
        'terminal',
        expect.anything(),
        outcome.metadata.envelope,
        true
      );
    } finally {
      memory.dispose();
    }
  });

  it('still runs observationRecord when a caller assembles it explicitly (export kept until decision ②)', async () => {
    const memory = new MemoryCoordinator();
    const recordObservation = vi.spyOn(memory, 'recordObservation');
    try {
      const { runtime, loopCtx } = makeProductionLikeRun({ memoryCoordinator: memory });
      const outcome = await new ToolExecutionPipeline()
        .use(observationRecord)
        .execute(terminalCall('git status'), { runtime, loopCtx, iteration: 3 });
      // 带信封时以 cacheHit=true 调用：这正是它在生产中不写 SessionStore 的原因。
      expect(recordObservation).toHaveBeenCalledWith(
        'terminal',
        expect.anything(),
        outcome.metadata.envelope,
        3,
        true
      );
    } finally {
      memory.dispose();
    }
  });
});

describe('runtime bridge request projection (L5-P47 / I45)', () => {
  it('does not project unread policyValidator, sessionToolCalls or currentRound to the host', async () => {
    const memory = new MemoryCoordinator();
    try {
      const { runtime, loopCtx, requests, toolCalls, diagnostics } = makeProductionLikeRun({
        memoryCoordinator: memory,
      });
      const map = vi.spyOn(toolCalls, 'map');
      const outcome = await createToolPipeline().execute(terminalCall('git status'), {
        runtime,
        loopCtx,
        iteration: 3,
      });

      expect(outcome.metadata.envelope?.ok).toBe(true);
      expect(requests).toHaveLength(1);
      const projected = requests[0]?.runtime ?? {};
      expect('policyValidator' in projected).toBe(false);
      expect('sessionToolCalls' in projected).toBe(false);
      expect('currentRound' in projected).toBe(false);
      // 历史调用不再在每次工具调用时被整体重映射。
      expect(map).not.toHaveBeenCalled();
      // 仍在使用的字段保持原样；cache 依决定①暂留（当前无消费者，只加注释）。
      expect(projected.iteration).toBe(3);
      expect(projected.memoryCoordinator).toBe(memory);
      expect(projected.cache).toBe(memory);
      expect(projected.diagnostics).toBe(diagnostics);
    } finally {
      memory.dispose();
    }
  });
});

describe('legacy handler context mapping (L5-P47 / I45)', () => {
  function callContext(runtime: ToolCallContext['runtime']): ToolCallContext {
    return {
      callId: 'call-dead-link',
      toolId: 'demo.echo',
      surface: 'runtime',
      actor: { role: 'developer', user: 'dead-link-user' },
      source: { kind: 'runtime', name: 'dead-link-source' },
      projectRoot: 'fixture-project-root',
      services: { get: () => undefined as never },
      runtime,
    };
  }

  it('drops the unread _sessionToolCalls and _currentRound mappings but keeps live fields', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const coordinator = { id: 'memory-port' };
    const context = contextFromToolCall(
      callContext({
        // 外部宿主仍可能按旧形状传入这两个字段；它们没有读取者，不再映射。
        sessionToolCalls: [{ tool: 'code', params: { action: 'search' } }],
        currentRound: 4,
        memoryCoordinator: coordinator,
        dimensionScopeId: 'scope-a',
        projectLanguage: 'typescript',
      })
    );
    expect('_sessionToolCalls' in context).toBe(false);
    expect('_currentRound' in context).toBe(false);
    expect(context._memoryCoordinator).toBe(coordinator);
    expect(context._dimensionScopeId).toBe('scope-a');
    expect(context._projectLanguage).toBe('typescript');
    expect(warn).not.toHaveBeenCalled();
  });
});
