import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDiagnosticWarning } from '../src/agent/runtime/AgentRuntimeTypes.js';
import { AgentRuntime, DiagnosticsCollector, HookSystem } from '../src/agent/runtime/index.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import { AiProvider } from '../src/ai/AiProvider.js';
import { UnifiedToolCatalog } from '../src/tools/catalog/UnifiedToolCatalog.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/result.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';

afterEach(() => vi.restoreAllMocks());

// 合成标记，仅用于验证脱敏；不是任何真实凭据。
const marker = 'SYNTHETIC_HOOK_MARKER_NOT_A_SECRET';

function toolRuntime() {
  const catalog = new RuntimeCapabilityCatalog();
  const execute = vi.fn(
    async (): Promise<ToolResultEnvelope> => ({
      ok: true,
      status: 'success' as const,
      toolId: 'meta',
      callId: 'fixture',
      startedAt: 'fixture',
      durationMs: 0,
      text: 'fixture',
      diagnostics: new DiagnosticsCollector().toJSON(),
      trust: {
        source: 'internal',
        sanitized: true,
        containsUntrustedText: false,
        containsSecrets: false,
      },
    })
  );
  const provider = new AiProvider({ model: 'fixture' });
  vi.spyOn(provider, 'chatWithTools')
    .mockResolvedValueOnce({
      text: null,
      functionCalls: [{ id: 'call', name: 'meta', args: { action: 'tools', params: {} } }],
    })
    .mockResolvedValue({ text: 'done', functionCalls: [] });
  // 只替代外部 provider/router；真实 runtime、HookSystem 和工具执行链保持接线。
  const runtime = new AgentRuntime({
    aiProvider: provider,
    toolRegistry: new UnifiedToolCatalog(),
    container: { get: () => catalog },
    additionalTools: ['meta'],
    toolRouter: {
      execute,
      executeChildCall: execute,
      explain: async () => ({ allowed: true, stage: 'execute' }),
    },
    strategy: new SingleStrategy(),
  });
  return { runtime, execute };
}

function hookWarnings(warnings: AgentDiagnosticWarning[] | undefined) {
  return (warnings ?? []).filter((warning) => warning.code === 'hook_handler_failed');
}

describe('hook handler failures reach the run AgentDiagnostics', () => {
  it('records a throwing tool:execute:before hook as a hook_handler_failed warning without blocking the tool', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const { runtime, execute } = toolRuntime();
    runtime.hookSystem.on('tool:execute:before', () => {
      throw new Error(`password=${marker} tool observer failed`);
    });

    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    // 观察钩子抛错只隔离，不等于阻断；工具仍执行，失败进入本次运行诊断。
    expect(execute).toHaveBeenCalledOnce();
    expect(result.reply).toBe('done');
    const warnings = hookWarnings(result.diagnostics?.warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'hook_handler_failed',
      tool: 'meta',
      message: expect.stringContaining('tool:execute:before'),
    });
    expect(warnings[0].message).toContain('password=[redacted] tool observer failed');
    expect(JSON.stringify(result.diagnostics)).not.toContain(marker);
  });

  it('records an asynchronous tool:execute:after rejection from synchronous dispatch', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const { runtime } = toolRuntime();
    runtime.hookSystem.on('tool:execute:after', async () => {
      throw new Error('after observer rejected');
    });

    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(hookWarnings(result.diagnostics?.warnings)).toEqual([
      expect.objectContaining({
        code: 'hook_handler_failed',
        tool: 'meta',
        message: expect.stringContaining('tool:execute:after'),
      }),
    ]);
  });

  it('records non-tool loop hooks (llm and iteration) without a tool field', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const { runtime } = toolRuntime();
    runtime.hookSystem.on(
      'llm:call:before',
      () => {
        throw new Error('llm observer failed');
      },
      { once: true }
    );
    runtime.hookSystem.on(
      'agent:iteration:before',
      () => {
        throw new Error('iteration observer failed');
      },
      { once: true }
    );

    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    const warnings = hookWarnings(result.diagnostics?.warnings);
    expect(warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining('agent:iteration:before'),
      expect.stringContaining('llm:call:before'),
    ]);
    expect(warnings.every((warning) => warning.tool === undefined)).toBe(true);
  });

  it('keeps a healthy run free of hook_handler_failed warnings', async () => {
    const { runtime } = toolRuntime();
    runtime.hookSystem.on('tool:execute:before', () => true);
    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });
    expect(hookWarnings(result.diagnostics?.warnings)).toEqual([]);
  });
});

describe('HookSystem per-dispatch diagnostics sink', () => {
  it('writes each failure only to the sink of the dispatch that observed it', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const hooks = new HookSystem();
    hooks.on('tool:execute:before', (payload) => {
      if (payload.toolId === 'broken') {
        throw new Error('broken observer');
      }
      return true;
    });
    const first = new DiagnosticsCollector();
    const second = new DiagnosticsCollector();

    // 同一 runtime 可能并发跑多个 loop：诊断必须按分发绑定，不能写进“当前运行”之类的共享字段。
    await expect(
      hooks.emit(
        'tool:execute:before',
        { toolId: 'broken', args: {}, callId: 'a' },
        { diagnostics: first }
      )
    ).resolves.toBe(true);
    await hooks.emit(
      'tool:execute:before',
      { toolId: 'healthy', args: {}, callId: 'b' },
      { diagnostics: second }
    );

    expect(hookWarnings(first.toJSON().warnings)).toEqual([
      expect.objectContaining({ code: 'hook_handler_failed', tool: 'broken' }),
    ]);
    expect(second.toJSON().warnings).toEqual([]);
    // 运行期诊断是额外落点，HookSystem 自身的诊断与日志保持不变。
    expect(hooks.getDiagnostics().hookErrors).toEqual([
      expect.objectContaining({ code: 'HOOK_HANDLER_FAILED', event: 'tool:execute:before' }),
    ]);
  });

  it('isolates a failing diagnostics sink and still logs and continues later hooks', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const hooks = new HookSystem();
    const later = vi.fn();
    hooks.on('agent:finalize', () => {
      throw new Error('finalize observer failed');
    });
    hooks.on('agent:finalize', later);
    const sink = {
      warn: vi.fn(() => {
        throw new Error('sink failed');
      }),
    };

    expect(() =>
      hooks.emitSync(
        'agent:finalize',
        { reply: 'done', iterations: 1, toolCallCount: 0 },
        { diagnostics: sink }
      )
    ).not.toThrow();

    expect(sink.warn).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('finalize observer failed'));
    expect(hooks.getDiagnostics().hookErrors).toHaveLength(1);
  });

  it('keeps the dispatch without a sink unchanged', () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const hooks = new HookSystem();
    hooks.on('agent:iteration:before', () => {
      throw new Error('no sink observer failed');
    });
    expect(() => hooks.emitSync('agent:iteration:before', { iteration: 1 })).not.toThrow();
    expect(hooks.getDiagnostics().hookErrors).toEqual([
      expect.objectContaining({ code: 'HOOK_HANDLER_FAILED', mode: 'sync' }),
    ]);
  });
});
