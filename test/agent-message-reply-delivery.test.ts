import { readFileSync } from 'node:fs';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentEvents } from '../src/agent/runtime/AgentEventBus.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { AgentDiagnosticWarning } from '../src/agent/runtime/AgentRuntimeTypes.js';

afterEach(() => vi.restoreAllMocks());

// 合成标记，仅用于验证诊断脱敏；不是任何真实凭据。
const marker = 'SYNTHETIC_REPLY_MARKER_NOT_A_SECRET';

/**
 * 只替换 strategy（外部执行体），真实 AgentRuntime 的 execute 边界、状态机、事件总线和诊断收集保持接线，
 * 以验证 replyFn 回写失败被隔离在运行结论之外。
 */
function runtimeWithStrategy(execute: (...args: never[]) => Promise<unknown>) {
  return new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools: vi.fn() } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    strategy: { name: 'reply-fixture', execute } as never,
    policies: new PolicyEngine([new BudgetPolicy({ maxIterations: 2, timeoutMs: 1000 })]),
    capabilities: [],
  });
}

function completedStrategy(reply = 'final answer') {
  return vi.fn(async () => ({
    reply,
    toolCalls: [],
    tokenUsage: { input: 1, output: 1 },
    iterations: 1,
  }));
}

function replyWarnings(warnings: AgentDiagnosticWarning[] | undefined) {
  return (warnings ?? []).filter((warning) => warning.code === 'reply_delivery_failed');
}

function observeTerminalEvents(runtime: AgentRuntime) {
  const completed = vi.fn();
  const failed = vi.fn();
  const aborted = vi.fn();
  runtime.bus.on(AgentEvents.AGENT_COMPLETED, completed);
  runtime.bus.on(AgentEvents.AGENT_FAILED, failed);
  runtime.bus.on(AgentEvents.AGENT_ABORTED, aborted);
  return { completed, failed, aborted };
}

describe('AgentRuntime replyFn delivery failure isolation', () => {
  it('keeps a completed run completed when replyFn throws and records reply_delivery_failed', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const runtime = runtimeWithStrategy(completedStrategy());
    const events = observeTerminalEvents(runtime);
    const replyFn = vi.fn(async () => {
      throw new Error(`password=${marker} transport closed`);
    });

    const result = await runtime.execute(new AgentMessage({ content: 'task', replyFn }));

    // 回写失败只影响投递，不改判已完成的运行结论。
    expect(replyFn).toHaveBeenCalledWith('final answer');
    expect(result.reply).toBe('final answer');
    // stub strategy 不走 reactLoop，阶段停在 idle；关键是没有被回写失败推进到 failed。
    expect(runtime.state.phase).not.toBe('failed');
    expect(result.state).toMatchObject({ phase: runtime.state.phase });
    expect(events.completed).toHaveBeenCalledOnce();
    expect(events.failed).not.toHaveBeenCalled();
    const warnings = replyWarnings(result.diagnostics?.warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('transport closed');
    expect(warnings[0].message).toContain('password=[redacted]');
    expect(JSON.stringify(result.diagnostics)).not.toContain(marker);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('reply delivery failed'),
      expect.objectContaining({ outcome: 'finish', channel: 'http' })
    );
  });

  it('classifies a non-Error rejection from replyFn without failing the run', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const runtime = runtimeWithStrategy(completedStrategy());
    const events = observeTerminalEvents(runtime);
    const replyFn = vi.fn(() => Promise.reject('socket hang up'));

    const result = await runtime.execute(new AgentMessage({ content: 'task', replyFn }));

    expect(result.reply).toBe('final answer');
    expect(events.failed).not.toHaveBeenCalled();
    expect(replyWarnings(result.diagnostics?.warnings)).toEqual([
      expect.objectContaining({
        code: 'reply_delivery_failed',
        message: expect.stringContaining('socket hang up'),
      }),
    ]);
  });

  it('keeps a cancelled run aborted when replyFn throws during the cancellation reply', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const parent = new AbortController();
    const runtime = runtimeWithStrategy(
      vi.fn(async () => {
        parent.abort();
        return { reply: 'late', toolCalls: [], tokenUsage: { input: 0, output: 0 }, iterations: 1 };
      })
    );
    const events = observeTerminalEvents(runtime);
    const replyFn = vi.fn(async () => {
      throw new Error('stream already closed');
    });

    const result = await runtime.execute(new AgentMessage({ content: 'task', replyFn }), {
      abortSignal: parent.signal,
    });

    expect(result.reply).toContain('[run stopped: abort_signal]');
    expect(events.aborted).toHaveBeenCalledOnce();
    expect(events.failed).not.toHaveBeenCalled();
    expect(replyWarnings(result.diagnostics?.warnings)).toHaveLength(1);
    expect(result.diagnostics?.warnings?.map((warning) => warning.code)).toContain(
      'runtime_aborted'
    );
  });

  it('delivers the reply once without a diagnostic when replyFn succeeds', async () => {
    const runtime = runtimeWithStrategy(completedStrategy('ok reply'));
    const events = observeTerminalEvents(runtime);
    const replyFn = vi.fn(async () => undefined);

    const result = await runtime.execute(new AgentMessage({ content: 'task', replyFn }));

    expect(replyFn).toHaveBeenCalledOnce();
    expect(replyFn).toHaveBeenCalledWith('ok reply');
    expect(events.completed).toHaveBeenCalledOnce();
    expect(replyWarnings(result.diagnostics?.warnings)).toHaveLength(0);
  });

  it('skips delivery when the message carries no replyFn', async () => {
    const runtime = runtimeWithStrategy(completedStrategy());

    const result = await runtime.execute(new AgentMessage({ content: 'task' }));

    expect(result.reply).toBe('final answer');
    expect(replyWarnings(result.diagnostics?.warnings)).toHaveLength(0);
  });
});

describe('AgentMessage transport factories pending decision', () => {
  const source = readFileSync(
    new URL('../src/agent/runtime/AgentMessage.ts', import.meta.url),
    'utf8'
  );

  it.each([
    'fromHttp',
    'fromCli',
    'fromMcp',
  ])('keeps %s callable but marks it @deprecated with the identity risk', (factory) => {
    // 删除路线依赖全局事项②；在决定前保留工厂，只用 JSDoc 标注弃用与身份风险。
    expect(typeof AgentMessage[factory as 'fromHttp' | 'fromCli' | 'fromMcp']).toBe('function');
    const signature = source.indexOf(`static ${factory}(`);
    expect(signature).toBeGreaterThan(-1);
    const docStart = source.lastIndexOf('/**', signature);
    const doc = source.slice(docStart, signature);
    expect(doc).toContain('@deprecated');
    expect(doc).toContain('身份');
  });
});
