/**
 * L4-P38 / I47 回归（生产路径）：终端隔离意图必须沿生产链路到达宿主执行端口。
 *
 * 生产宿主（Alembic AgentModule）构造 ToolRouterAdapter 时不传 capability，router 不会把
 * capability 的 commandAllowlist 注入 handler ctx；当前能力只在 loopCtx.capabilities 上。
 * 因此 intent 的生产链路是：runtimeBridge 从 loopCtx.capabilities 按最严格取值合并 →
 * ToolCallRequest.runtime.terminalIntent → ToolRouterAdapter 把 runtime 并入 ctx →
 * terminal handler 合并后作为 sandboxExecutor.exec 的 opts.intent 交给宿主。
 * 这里全部按生产形态构造（真实 createToolPipeline + 不带 capability 的真实 adapter），
 * 不走 ToolRouter({ capability }) 或手动注入 commandAllowlist 的路径。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import type { LoopContext } from '../src/agent/runtime/LoopContext.js';
import { createToolPipeline } from '../src/agent/runtime/ToolExecutionPipeline.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import type { ToolCallRequest, ToolResultEnvelope } from '../src/tools/kernel/index.js';
import { mergeTerminalIntents } from '../src/tools/kernel/registry.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import type { ToolContext } from '../src/tools/runtime/index.js';
import { Evolution } from '../src/tools/runtime/index.js';

type ExecOpts = Record<string, unknown> & { intent?: Record<string, unknown> };
type ExecReply = {
  stdout: string;
  stderr: string;
  exitCode: number;
  diagnostics?: { sandboxed?: boolean; fallbackUsed?: boolean; degradeReason?: string };
};

function capturingExecutor(
  reply: (opts: ExecOpts) => ExecReply = () => ({ stdout: 'clean\n', stderr: '', exitCode: 0 })
) {
  const calls: Array<{ command: string; opts: ExecOpts }> = [];
  const exec = vi.fn(async (command: string, opts: ExecOpts) => {
    calls.push({ command, opts });
    return reply(opts);
  });
  return { calls, exec };
}

function terminalCall(command: string) {
  return {
    id: `call-${command}`,
    name: 'terminal',
    args: { action: 'exec', params: { command } },
  };
}

/** 与宿主 AgentModule 一致：Adapter 不带 capability，只有 loopCtx.capabilities 知道当前能力。 */
function makeProductionLikeRun(options: {
  capabilities: unknown[];
  exec: ReturnType<typeof capturingExecutor>['exec'];
  abortSignal?: AbortSignal | null;
}) {
  const toolContext: ToolContext = {
    projectRoot: process.cwd(),
    tokenBudget: 8000,
    sandboxExecutor: { exec: options.exec },
  };
  const adapter = new ToolRouterAdapter({ contextFactory: { create: () => toolContext } });
  const warn = vi.fn();
  const diagnostics = new DiagnosticsCollector();
  const runtime = {
    id: 'evolution-audit-runtime',
    presetName: 'evolution',
    container: null,
    projectRoot: process.cwd(),
    dataRoot: join(tmpdir(), 'alembic-agent-l4-p38'),
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
    capabilities: options.capabilities,
    abortSignal: options.abortSignal ?? null,
    budget: {},
    context: { pipelinePhase: 'evolve' },
    diagnostics,
    evidenceLedger: null,
    iteration: 1,
    memoryCoordinator: null,
    sharedState: {},
    source: 'system',
    toolCalls: [],
    tracker: null,
    trace: null,
  } as unknown as LoopContext;
  return { runtime, loopCtx, warn, diagnostics };
}

/** 只声明 commandAllowlist 的最小能力对象，用来覆盖多能力合并与 JS 接线的异常取值。 */
function capabilityWith(name: string, intent: unknown) {
  return { name, commandAllowlist: { bins: ['git', 'ls'], intent } };
}

describe('terminal intent reaches the host executor on the production chain (L4-P38 / I47)', () => {
  it('forwards the Evolution intent from loopCtx.capabilities through a capability-less adapter', async () => {
    const { calls, exec } = capturingExecutor((opts) => {
      // 宿主改动收到的 intent 不能回写 Evolution 的 capability 常量。
      if (opts.intent) {
        opts.intent.filesystem = 'project-write';
      }
      return { stdout: 'clean\n', stderr: '', exitCode: 0 };
    });
    const { runtime, loopCtx, warn, diagnostics } = makeProductionLikeRun({
      capabilities: [new Evolution()],
      exec,
    });

    const outcome = await createToolPipeline().execute(terminalCall('git status'), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    expect(outcome.metadata.blocked).toBe(false);
    expect(outcome.metadata.envelope?.ok).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
    expect(calls[0]?.command).toBe('git status');
    expect(calls[0]?.opts.intent).toEqual({ network: 'none', filesystem: 'project-write' });
    expect(new Evolution().commandAllowlist.intent).toEqual({
      network: 'none',
      filesystem: 'read-only',
    });
    // 宿主在沙箱内执行（未报告降级）时 Agent 无从得知是否采用了 intent，不追加任何诊断。
    expect(outcome.metadata.envelope?.diagnostics.warnings).toEqual([]);
    expect(diagnostics.toJSON().warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('hands the executor exactly the read-only, no-network intent declared by Evolution', async () => {
    const { calls, exec } = capturingExecutor();
    const { runtime, loopCtx } = makeProductionLikeRun({ capabilities: [new Evolution()], exec });

    await createToolPipeline().execute(terminalCall('git status'), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    expect(calls[0]?.opts.intent).toEqual({ network: 'none', filesystem: 'read-only' });
    expect(calls[0]?.opts).toMatchObject({
      cwd: process.cwd(),
      projectRoot: process.cwd(),
    });
  });

  it('keeps the executor opts unchanged when no loop capability declares an intent', async () => {
    const { calls, exec } = capturingExecutor();
    const { runtime, loopCtx } = makeProductionLikeRun({
      capabilities: [capabilityWith('read_only_probe', undefined)],
      exec,
    });

    const outcome = await createToolPipeline().execute(terminalCall('git status'), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    expect(outcome.metadata.envelope?.ok).toBe(true);
    expect(Object.keys(calls[0]?.opts ?? {}).sort()).toEqual(
      ['cwd', 'projectRoot', 'signal', 'timeout'].sort()
    );
    expect('intent' in (calls[0]?.opts ?? {})).toBe(false);
  });

  it('merges several loop capabilities by taking the strictest value per dimension', async () => {
    const { calls, exec } = capturingExecutor();
    const { runtime, loopCtx, warn, diagnostics } = makeProductionLikeRun({
      capabilities: [
        capabilityWith('network_only', { network: 'none' }),
        // JS 接线的能力可能给出类型外的取值：丢弃并告警，不能放宽另一个能力的 network:'none'。
        capabilityWith('loose_probe', { network: 'full', filesystem: 'read-only' }),
        capabilityWith('no_intent', undefined),
      ],
      exec,
    });

    const outcome = await createToolPipeline().execute(terminalCall('git status'), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    expect(outcome.metadata.envelope?.ok).toBe(true);
    expect(calls[0]?.opts.intent).toEqual({ network: 'none', filesystem: 'read-only' });
    const warnings = diagnostics.toJSON().warnings;
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: 'TERMINAL_INTENT_VALUE_IGNORED',
        tool: 'terminal',
        message: expect.stringContaining('capability=loose_probe field=network value="full"'),
      })
    );
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'capability=loose_probe field=network value="full"'
    );
  });

  it('reports the declared intent as not enforced when the host degrades to unsandboxed', async () => {
    const { calls, exec } = capturingExecutor(() => ({
      stdout: 'clean\n',
      stderr: '',
      exitCode: 0,
      diagnostics: { sandboxed: false, fallbackUsed: true, degradeReason: 'seatbelt_unavailable' },
    }));
    const { runtime, loopCtx } = makeProductionLikeRun({ capabilities: [new Evolution()], exec });

    const outcome = await createToolPipeline().execute(terminalCall('git status'), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    expect(calls[0]?.opts.intent).toEqual({ network: 'none', filesystem: 'read-only' });
    expect(outcome.metadata.envelope?.diagnostics.warnings).toContainEqual({
      code: 'terminal_intent_not_enforced',
      message:
        'declared intent network=none filesystem=read-only was not applied: command ran unsandboxed (degradeReason=seatbelt_unavailable)',
      stage: 'terminal.exec',
      tool: 'terminal',
    });
  });

  it('forwards the intent on a forced kill and keeps the partial output', async () => {
    const { calls, exec } = capturingExecutor(() => ({
      stdout: 'partial\n',
      stderr: '',
      exitCode: 137,
    }));
    const { runtime, loopCtx } = makeProductionLikeRun({ capabilities: [new Evolution()], exec });

    const outcome = await createToolPipeline().execute(terminalCall('npm test'), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    // 137 沿用兼容 ok，但终态是 error，部分输出保留。
    expect(outcome.metadata.envelope?.status).toBe('error');
    expect(outcome.metadata.envelope?.text).toContain('partial output');
    expect(calls[0]?.opts.intent).toEqual({ network: 'none', filesystem: 'read-only' });
  });

  it('forwards the intent even when the host executor rejects (for example a host timeout)', async () => {
    const calls: ExecOpts[] = [];
    const exec = vi.fn(async (_command: string, opts: ExecOpts): Promise<ExecReply> => {
      calls.push(opts);
      throw new Error('sandbox exec timed out');
    });
    const { runtime, loopCtx } = makeProductionLikeRun({ capabilities: [new Evolution()], exec });

    const outcome = await createToolPipeline().execute(terminalCall('npm test'), {
      runtime,
      loopCtx,
      iteration: 1,
    });

    // 执行器已被调用后抛错：沿用兼容 ok，终态为 error，诊断带 terminal_execution_failed。
    expect(outcome.metadata.envelope?.status).toBe('error');
    expect(outcome.metadata.envelope?.text).toContain('sandbox exec timed out');
    expect(outcome.metadata.envelope?.diagnostics.warnings).toContainEqual(
      expect.objectContaining({ code: 'terminal_execution_failed' })
    );
    expect(calls[0]?.intent).toEqual({ network: 'none', filesystem: 'read-only' });
  });

  it('never reaches the executor when the capability allowlist denies the command or the loop is cancelled', async () => {
    const { exec } = capturingExecutor();
    const denied = makeProductionLikeRun({ capabilities: [new Evolution()], exec });
    const deniedOutcome = await createToolPipeline().execute(terminalCall('rm -rf build'), {
      runtime: denied.runtime,
      loopCtx: denied.loopCtx,
      iteration: 1,
    });
    expect(deniedOutcome.metadata.blocked).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const cancelled = makeProductionLikeRun({
      capabilities: [new Evolution()],
      exec,
      abortSignal: controller.signal,
    });
    await createToolPipeline().execute(terminalCall('git status'), {
      runtime: cancelled.runtime,
      loopCtx: cancelled.loopCtx,
      iteration: 1,
    });

    expect(exec).not.toHaveBeenCalled();
  });
});

describe('runtime bridge projects the loop terminal intent onto the request (L4-P38)', () => {
  async function captureRequest(capabilities: unknown[], call: ReturnType<typeof terminalCall>) {
    const requests: ToolCallRequest[] = [];
    const toolRouter = {
      execute: vi.fn(async (request: ToolCallRequest): Promise<ToolResultEnvelope> => {
        requests.push(request);
        return {
          ok: true,
          toolId: request.toolId,
          callId: 'c1',
          startedAt: new Date(0).toISOString(),
          durationMs: 0,
          status: 'success',
          text: 'ok',
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
            sanitized: false,
            containsUntrustedText: false,
            containsSecrets: false,
          },
        };
      }),
    };
    const { runtime, loopCtx } = makeProductionLikeRun({
      capabilities,
      exec: capturingExecutor().exec,
    });
    (runtime as unknown as { toolRouter: typeof toolRouter }).toolRouter = toolRouter;
    await executeRuntimeToolCall(
      call,
      { runtime, loopCtx, iteration: 1 },
      { cacheHit: false, blocked: false, isNew: false, durationMs: 0 }
    );
    return requests[0];
  }

  it('sets runtime.terminalIntent for terminal calls as a per-request copy', async () => {
    const evolution = new Evolution();
    const request = await captureRequest([evolution], terminalCall('git status'));
    expect(request?.runtime?.terminalIntent).toEqual({ network: 'none', filesystem: 'read-only' });
    expect(request?.runtime?.terminalIntent).not.toBe(evolution.commandAllowlist.intent);
  });

  it('omits runtime.terminalIntent for other tools and for loops without a declared intent', async () => {
    const codeCall = {
      id: 'code-1',
      name: 'code',
      args: { action: 'search', params: { pattern: 'x' } },
    };
    const forCode = await captureRequest([new Evolution()], codeCall);
    expect(forCode?.runtime && 'terminalIntent' in forCode.runtime).toBe(false);

    const withoutIntent = await captureRequest([], terminalCall('git status'));
    expect(withoutIntent?.runtime && 'terminalIntent' in withoutIntent.runtime).toBe(false);
  });
});

describe('mergeTerminalIntents (L4-P38)', () => {
  it('takes the strictest value per dimension and reports unrecognized values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const merged = mergeTerminalIntents([
      { source: 'a', intent: { network: 'none' } },
      { source: 'b', intent: { filesystem: 'read-only', network: 'host' } },
      { source: 'c', intent: undefined },
      { source: 'd', intent: ['network'] },
      { source: 'e', intent: { network: 10n, filesystem: circular, extra: true } },
    ]);
    expect(merged.intent).toEqual({ network: 'none', filesystem: 'read-only' });
    expect(merged.ignored).toEqual([
      'b field=network value="host"',
      'd intent is array, expected object',
      'e field=network value=10',
      'e field=filesystem value=<object>',
      'e field=extra value=true',
    ]);
  });

  it('returns undefined when no source declares a recognized value and never shares objects', () => {
    expect(mergeTerminalIntents([]).intent).toBeUndefined();
    expect(mergeTerminalIntents([{ source: 'a', intent: { network: 'full' } }]).intent).toBe(
      undefined
    );
    const declared = { network: 'none' as const, filesystem: 'read-only' as const };
    const first = mergeTerminalIntents([{ source: 'a', intent: declared }]).intent;
    expect(first).toEqual(declared);
    expect(first).not.toBe(declared);
  });
});
