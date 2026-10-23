import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { AiProvider } from '../src/ai/AiProvider.js';

/**
 * W2a-11r1：只实现 chat()、没有覆写 chatWithTools 的 provider 是永久性集成缺陷。
 *
 * AiProvider 基类对它抛带 code=PROVIDER_CONTRACT_VIOLATION 的错误；AgentRuntime 必须按 code
 * 把它归为运行时缺陷（参照本地输入装配缺陷 I08 的处理）：不进入 2-strike 重试、不等待 2000ms、
 * 不计入连续 AI 错误、cancelReason=runtime_defect、记诊断、回复写明是 provider 集成缺陷，
 * 并抑制强制摘要（摘要同样要调用 chatWithTools，必然再失败）。
 *
 * 假时钟：AgentRuntime 的重试等待来自 node:timers/promises（vi 假计时器接管不了），
 * 这里把它替换为“记录请求的毫秒数、立即结算”的替身，既证明没有 2000ms 等待，也不让对照用例真实等待。
 */
const clock = vi.hoisted(() => ({ delays: [] as number[] }));

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: async <T>(ms?: number, value?: T, options?: { signal?: AbortSignal }) => {
      clock.delays.push(Number(ms));
      if (options?.signal?.aborted) {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      return value as T;
    },
  };
});

/** 只实现 chat() 的仓外式子类：chatWithTools 落到基类拒绝路径。 */
class ChatOnlyProvider extends AiProvider {
  readonly chatCalls: string[] = [];

  constructor() {
    super({ model: 'chat-only-model' });
    this.name = 'chat-only';
  }

  async chat(prompt: string): Promise<string> {
    this.chatCalls.push(prompt);
    return 'plain text reply';
  }
}

function createRuntime(provider: AiProvider) {
  const runtime = new AgentRuntime({
    aiProvider: provider as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
  });
  const info = vi.fn();
  const warn = vi.fn();
  runtime.logger = { info, warn };
  return { runtime, info, warn };
}

beforeEach(() => {
  // 每条用例从空的假时钟记录开始；provider.logger 在各用例里替换为桩，吸收基类的 not_overridden 诊断。
  clock.delays.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AiProvider base chatWithTools contract violation code', () => {
  it('rejects with code PROVIDER_CONTRACT_VIOLATION and keeps the must-override message', async () => {
    const provider = new ChatOnlyProvider();
    provider.logger = { warn: vi.fn() };
    const failure = await provider.chatWithTools('inspect').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: 'PROVIDER_CONTRACT_VIOLATION',
      message: 'chat-only must override chatWithTools',
    });
    expect(provider.chatCalls).toEqual([]);
  });
});

describe('AgentRuntime treats an un-overridden chatWithTools as a runtime defect (W2a-11r1)', () => {
  it.each([
    'user',
    'system',
  ] as const)('terminates a %s run once, without the 2000ms retry, as runtime_defect', async (source) => {
    const provider = new ChatOnlyProvider();
    provider.logger = { warn: vi.fn() };
    const chatWithTools = vi.spyOn(provider, 'chatWithTools');
    const { runtime, warn } = createRuntime(provider);

    const result = await runtime.reactLoop('hello', {
      source,
      budgetOverride: { maxIterations: 3, timeoutMs: 60_000 },
    });

    // 只调用一次：没有 2-strike 重试，也没有强制摘要再调一次 chatWithTools；chat() 从未被调用。
    expect(chatWithTools).toHaveBeenCalledOnce();
    expect(provider.chatCalls).toEqual([]);
    // 假时钟没有收到任何重试等待（旧路径第一次失败后等 2000ms）。
    expect(clock.delays).not.toContain(2000);
    expect(clock.delays).toEqual([]);

    const diagnostics = result.diagnostics;
    expect(diagnostics?.efficiency?.cancelReason).toBe('runtime_defect');
    expect(diagnostics?.efficiency?.forcedSummary).toBe(false);
    expect(diagnostics?.degraded).toBe(true);
    // 不计入连续 AI 错误，也不记 ai_error（宿主不会把它当作上游暂时故障）。
    expect(diagnostics?.aiErrorCount).toBe(0);
    const codes = (diagnostics?.warnings ?? []).map((warning) => warning.code);
    expect(codes).toContain('provider_contract_violation');
    expect(codes).not.toContain('ai_error');
    expect(diagnostics?.warnings).toContainEqual({
      code: 'provider_contract_violation',
      message: expect.stringContaining('chat-only must override chatWithTools'),
    });

    // 回复写明是 provider 集成缺陷，不再误导为“AI 服务暂时不可用，请稍后重试”。
    expect(result.reply).not.toContain('AI 服务暂时不可用');
    expect(result.reply).not.toContain('稍后重试');
    if (source === 'system') {
      expect(result.reply).toContain('[run stopped: runtime_defect]');
      expect(result.reply).toContain('chatWithTools');
      expect(result.reply).not.toContain('LLM input assembly failed');
    } else {
      expect(result.reply).toContain('集成缺陷');
      expect(result.reply).toContain('chatWithTools');
    }

    // 运行日志按运行缺陷归类，带 provider 错误码；不再记成可重试的 AI 调用失败。
    const defectLog = warn.mock.calls.find(([message]) =>
      String(message).includes('provider contract violation')
    );
    expect(defectLog?.[1]).toMatchObject({
      code: 'provider_contract_violation',
      errorCode: 'PROVIDER_CONTRACT_VIOLATION',
      cancelReason: 'runtime_defect',
      error: 'chat-only must override chatWithTools',
    });
    const loggedMessages = warn.mock.calls.map(([message]) => String(message));
    expect(loggedMessages.some((message) => message.includes('AI call failed'))).toBe(false);
    expect(loggedMessages.some((message) => message.includes('consecutive AI errors'))).toBe(false);
  });

  it('keeps the 2-strike retry for an ordinary provider error', async () => {
    const provider = new ChatOnlyProvider();
    provider.logger = { warn: vi.fn() };
    const chatWithTools = vi
      .spyOn(provider, 'chatWithTools')
      .mockRejectedValue(Object.assign(new Error('upstream overloaded'), { status: 503 }));
    const { runtime } = createRuntime(provider);

    const result = await runtime.reactLoop('hello', {
      budgetOverride: { maxIterations: 3, timeoutMs: 60_000 },
    });

    // 真正的上游错误仍走 2-strike：等一次 2000ms（假时钟立即结算）后重试，第二次失败退出。
    expect(chatWithTools).toHaveBeenCalledTimes(2);
    expect(clock.delays).toEqual([2000]);
    expect(result.diagnostics?.aiErrorCount).toBe(2);
    expect(result.diagnostics?.efficiency?.cancelReason).toBe('provider_error');
    const codes = (result.diagnostics?.warnings ?? []).map((warning) => warning.code);
    expect(codes).not.toContain('provider_contract_violation');
  });

  it('keeps abort precedence when the contract violation races a cancelled run', async () => {
    const provider = new ChatOnlyProvider();
    provider.logger = { warn: vi.fn() };
    const controller = new AbortController();
    const original = provider.chatWithTools.bind(provider);
    // 调用方在 provider 拒绝的同一时刻取消：取消优先，不归为运行缺陷。
    const chatWithTools = vi
      .spyOn(provider, 'chatWithTools')
      .mockImplementation(async (...args) => {
        controller.abort(new Error('caller cancelled'));
        return original(...args);
      });
    const { runtime } = createRuntime(provider);

    const result = await runtime.reactLoop('hello', {
      abortSignal: controller.signal,
      budgetOverride: { maxIterations: 3, timeoutMs: 60_000 },
    });

    expect(chatWithTools).toHaveBeenCalledOnce();
    expect(clock.delays).toEqual([]);
    expect(result.diagnostics?.efficiency?.cancelReason).toBe('abort_signal');
    const codes = (result.diagnostics?.warnings ?? []).map((warning) => warning.code);
    expect(codes).not.toContain('provider_contract_violation');
  });
});
