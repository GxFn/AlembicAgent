/**
 * L3-C05 回归：runtimeBridge 每拿到一个路由信封，就把逐调用轨迹写进运行诊断的 toolCalls。
 * 此前 DiagnosticsCollector.recordToolCallEnvelope 没有任何调用点，运行诊断里 toolCalls 始终缺席；
 * 宿主只能从 result.toolCalls[].envelope 反查调用轨迹。
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import type {
  ToolCallRequest,
  ToolResultEnvelope,
  ToolResultStatus,
} from '../src/tools/kernel/index.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';

function createEnvelope(
  toolId: string,
  callId: string,
  status: ToolResultStatus,
  durationMs: number
): ToolResultEnvelope {
  const ok = status === 'success';
  return {
    ok,
    toolId,
    callId,
    startedAt: '2026-10-11T00:00:00.000Z',
    durationMs,
    status,
    text: ok ? `${callId} done` : `${callId} ${status}`,
    structuredContent: { callId },
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

function freshMetadata(): ToolMetadata {
  return { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
}

function bridgeContext(
  execute: (request: ToolCallRequest) => Promise<ToolResultEnvelope>,
  diagnostics: DiagnosticsCollector | null,
  abortSignal: AbortSignal | null = null
): ToolPipelineContext {
  return {
    runtime: {
      id: 'diagnostics-runtime',
      presetName: 'diagnostics-preset',
      policies: {},
      toolRouter: { execute },
    },
    loopCtx: {
      allowedToolIds: ['meta'],
      allowedToolActions: {},
      iteration: 1,
      source: 'diagnostics-source',
      diagnostics,
      abortSignal,
    },
    iteration: 1,
  } as unknown as ToolPipelineContext;
}

describe('run diagnostics record every executed tool call envelope', () => {
  it('lists both tool calls of one run with callId/status/durationMs', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        text: '',
        functionCalls: [
          { id: 'first', name: 'meta', args: { action: 'tools' } },
          { id: 'second', name: 'meta', args: { action: 'tools', params: { name: 'code' } } },
        ],
        usage: { inputTokens: 3, outputTokens: 2 },
      })
      .mockResolvedValue({
        text: 'final answer',
        functionCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    let sequence = 0;
    // 第二个调用返回 error，确认诊断按信封原样记录失败状态，而不是只记成功调用。
    const execute = vi.fn(async (request: ToolCallRequest) => {
      sequence++;
      return createEnvelope(
        request.toolId,
        `router-call-${sequence}`,
        sequence === 1 ? 'success' : 'error',
        sequence === 1 ? 5 : 7
      );
    });
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools: chat } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute } as never,
      container: { get: () => new RuntimeCapabilityCatalog() },
      additionalTools: ['meta'],
      strategy: { name: 'unused', execute: vi.fn() } as never,
    });

    const result = await runtime.reactLoop('inspect tools twice', {
      budgetOverride: { maxIterations: 3 },
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toHaveLength(2);
    const toolCalls = result.diagnostics?.toolCalls;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'meta',
          callId: 'router-call-1',
          status: 'success',
          ok: true,
          durationMs: 5,
          surface: 'runtime',
        }),
        expect.objectContaining({
          tool: 'meta',
          callId: 'router-call-2',
          status: 'error',
          ok: false,
          durationMs: 7,
          surface: 'runtime',
        }),
      ])
    );
  });
});

describe('runtime bridge tool call diagnostics', () => {
  it.each([
    ['success', false],
    ['partial', false],
    ['error', false],
    ['blocked', true],
    ['needs-confirmation', true],
    ['timeout', true],
    ['aborted', true],
  ] as const)('records a %s envelope with runtime surface and pipeline source', async (status, blocking) => {
    const diagnostics = new DiagnosticsCollector();
    const envelope = createEnvelope('meta', `call-${status}`, status, 11);
    const metadata = freshMetadata();

    await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, diagnostics),
      metadata
    );

    const snapshot = diagnostics.toJSON();
    expect(snapshot.toolCalls).toEqual([
      {
        tool: 'meta',
        callId: `call-${status}`,
        status,
        ok: status === 'success',
        surface: 'runtime',
        source: 'diagnostics-source',
        startedAt: '2026-10-11T00:00:00.000Z',
        durationMs: 11,
      },
    ]);
    // 既有阻断记录保持不变：逐调用轨迹是新增，不替代 blockedTools。
    expect(snapshot.blockedTools).toHaveLength(blocking ? 1 : 0);
    expect(metadata.blocked).toBe(blocking);
  });

  it('keeps parentCallId of child envelopes in the run diagnostics', async () => {
    const diagnostics = new DiagnosticsCollector();
    const envelope = { ...createEnvelope('meta', 'child-call', 'success', 2), parentCallId: 'p-1' };

    await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, diagnostics),
      freshMetadata()
    );

    expect(diagnostics.toJSON().toolCalls).toEqual([
      expect.objectContaining({ callId: 'child-call', parentCallId: 'p-1' }),
    ]);
  });

  it('records no tool call entry when the router throws before returning an envelope', async () => {
    const diagnostics = new DiagnosticsCollector();

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => {
        throw new Error('router exploded');
      }, diagnostics),
      freshMetadata()
    );

    expect(result).toEqual({ error: 'router exploded' });
    const snapshot = diagnostics.toJSON();
    // 没有信封就没有 callId，诊断不能捏造条目；失败由既有 warning 定位。
    expect(snapshot.toolCalls).toBeUndefined();
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({ code: 'TOOL_HOST_EXECUTION_FAILED' })
    );
  });

  it('records no tool call entry when cancelled before host dispatch', async () => {
    const diagnostics = new DiagnosticsCollector();
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => createEnvelope('meta', 'never', 'success', 1));

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(execute, diagnostics, controller.signal),
      freshMetadata()
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'aborted',
      error: 'Tool call cancelled before host dispatch',
    });
    const snapshot = diagnostics.toJSON();
    expect(snapshot.toolCalls).toBeUndefined();
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({ code: 'TOOL_HOST_DISPATCH_CANCELLED' })
    );
  });

  it('still returns the tool result when the loop has no diagnostics collector', async () => {
    const envelope = createEnvelope('meta', 'no-diagnostics', 'success', 3);
    const metadata = freshMetadata();

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, null),
      metadata
    );

    expect(result).toEqual({ callId: 'no-diagnostics' });
    expect(metadata.envelope).toBe(envelope);
  });
});
