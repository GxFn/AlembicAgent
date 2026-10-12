/**
 * I14：LLM 输入长度守卫按模型上下文窗口取上限。
 *
 * 优先级：显式 budget.maxProviderInputTokens → 模型注册表 contextWindow 减输出预留 → 128k 默认。
 * 小上下文模型（ollama:llama3，8k）超长输入必须在 Runtime 侧得到 LLM_INPUT_TOO_LARGE，
 * 而不是发给 provider 后走 AI 错误/重试路径；未登记模型保持 128k，并在诊断中标注来源。
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { LLMInputAssemblyMeasurement } from '../src/agent/runtime/LLMInputMeasurement.js';
import { resolveProviderInputLimit, validateLlmInputSize } from '../src/agent/runtime/llmInput.js';
import { getModelRegistry } from '../src/ai/registry/ModelRegistry.js';

const LIMIT_LOG = '[AgentRuntime] provider input limit resolved';

function createRuntime(provider: { name: string; model: string }, modelRef?: string) {
  const chatWithTools = vi.fn(async () => ({
    text: 'provider reply',
    functionCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const runtime = new AgentRuntime({
    aiProvider: { ...provider, chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
    ...(modelRef ? { modelRef } : {}),
  });
  const info = vi.fn();
  const warn = vi.fn();
  runtime.logger = { info, warn };
  return { runtime, chatWithTools, info, warn };
}

/** ASCII 字符按 0.25 token 估算（shared/tokenUtils.estimateTokens），这里按 token 数反推字符数。 */
function promptOfTokens(tokens: number): string {
  return 'a'.repeat(tokens * 4);
}

function findLimitLog(info: ReturnType<typeof vi.fn>) {
  const call = info.mock.calls.find(([message]) => message === LIMIT_LOG);
  return call?.[1] as Record<string, unknown> | undefined;
}

function measurementOf(estimatedTokens: number): LLMInputAssemblyMeasurement {
  return { estimatedTokens } as LLMInputAssemblyMeasurement;
}

describe('provider input limit follows the model context window (I14)', () => {
  it('rejects oversized input for ollama:llama3 (8k window) before calling the provider', async () => {
    const { runtime, chatWithTools, info, warn } = createRuntime({
      name: 'ollama',
      model: 'llama3',
    });

    const result = await runtime.reactLoop(promptOfTokens(6_000), {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('输入过长');
    const warning = result.diagnostics?.warnings.find(
      (entry) => entry.code === 'LLM_INPUT_TOO_LARGE'
    );
    // 8192 窗口减去用户场景默认输出预留 4096（未超过模型 maxOutputTokens 4096）。
    expect(warning?.message).toContain('/4096 tokens');
    expect(warning?.message).toContain('limitSource=model-registry');
    expect(findLimitLog(info)).toMatchObject({
      modelRef: 'ollama:llama3',
      source: 'model-registry',
      maxProviderInputTokens: 4_096,
      contextWindow: 8_192,
      outputReserveTokens: 4_096,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[AgentRuntime] LLM input rejected'),
      expect.objectContaining({ limitSource: 'model-registry', maxTokens: 4_096 })
    );
  });

  it('reserves budget.maxTokens as output and clamps it to the model maxOutputTokens', async () => {
    const reserved = createRuntime({ name: 'ollama', model: 'llama3' });
    await reserved.runtime.reactLoop(promptOfTokens(6_000), {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000, maxTokens: 1_000 },
    });
    // 8192 - 1000 = 7192 > 6000：输入未超限，provider 正常收到请求。
    expect(reserved.chatWithTools).toHaveBeenCalledOnce();
    expect(findLimitLog(reserved.info)).toMatchObject({
      source: 'model-registry',
      maxProviderInputTokens: 7_192,
      outputReserveTokens: 1_000,
    });

    const system = createRuntime({ name: 'ollama', model: 'llama3' });
    await system.runtime.reactLoop('short system prompt', {
      source: 'system',
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000 },
    });
    // system 默认输出 8192 被模型 maxOutputTokens(4096) 截断，预留同样只按 4096 计算。
    expect(findLimitLog(system.info)).toMatchObject({
      source: 'model-registry',
      maxProviderInputTokens: 4_096,
      outputReserveTokens: 4_096,
    });
  });

  it('lets an explicit maxProviderInputTokens override win over the registry window', async () => {
    const { runtime, chatWithTools, info } = createRuntime(
      { name: 'unit-test', model: 'unit' },
      'ollama:llama3'
    );
    const budgetOverride = { maxIterations: 1, timeoutMs: 5_000, maxProviderInputTokens: 200_000 };

    await runtime.reactLoop(promptOfTokens(6_000), { source: 'user', budgetOverride });

    expect(chatWithTools).toHaveBeenCalledOnce();
    expect(findLimitLog(info)).toMatchObject({
      modelRef: 'ollama:llama3',
      source: 'explicit',
      maxProviderInputTokens: 200_000,
    });
    expect(budgetOverride.maxProviderInputTokens).toBe(200_000);
  });

  it('fills the registry limit without mutating the caller budgetOverride', async () => {
    const { runtime } = createRuntime({ name: 'ollama', model: 'llama3' });
    const budgetOverride: Record<string, unknown> = { maxIterations: 1, timeoutMs: 5_000 };

    await runtime.reactLoop('hello', { source: 'user', budgetOverride });

    expect(Object.hasOwn(budgetOverride, 'maxProviderInputTokens')).toBe(false);
  });

  it('ignores an invalid explicit value with a warning and falls back to the registry window', async () => {
    const { runtime, chatWithTools, info, warn } = createRuntime({
      name: 'ollama',
      model: 'llama3',
    });

    const result = await runtime.reactLoop(promptOfTokens(6_000), {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000, maxProviderInputTokens: 0 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({ code: 'LLM_INPUT_TOO_LARGE' })
    );
    expect(findLimitLog(info)).toMatchObject({
      source: 'model-registry',
      maxProviderInputTokens: 4_096,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[AgentRuntime] explicit maxProviderInputTokens ignored'),
      expect.objectContaining({ invalidExplicitValue: '0' })
    );
  });

  it('keeps the 128k default and labels its source when the model is not registered', async () => {
    const accepted = createRuntime({ name: 'unit-test', model: 'unit' });
    await accepted.runtime.reactLoop(promptOfTokens(6_000), {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000 },
    });
    expect(accepted.chatWithTools).toHaveBeenCalledOnce();
    expect(findLimitLog(accepted.info)).toMatchObject({
      modelRef: 'unit-test:unit',
      source: 'default',
      maxProviderInputTokens: 128_000,
    });

    const rejected = createRuntime({ name: 'ollama', model: 'not-registered-model' });
    const result = await rejected.runtime.reactLoop(promptOfTokens(130_000), {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000 },
    });
    expect(rejected.chatWithTools).not.toHaveBeenCalled();
    const warning = result.diagnostics?.warnings.find(
      (entry) => entry.code === 'LLM_INPUT_TOO_LARGE'
    );
    expect(warning?.message).toContain('/128000 tokens');
    expect(warning?.message).toContain('limitSource=default');
  });

  it('no longer reads the unwritten maxInputTokens / contextWindowTokens aliases', () => {
    expect(validateLlmInputSize({ maxInputTokens: 10 }, measurementOf(100))).toEqual({ ok: true });
    expect(validateLlmInputSize({ contextWindowTokens: 10 }, measurementOf(100))).toEqual({
      ok: true,
    });
    expect(validateLlmInputSize({ maxProviderInputTokens: 10 }, measurementOf(100))).toMatchObject({
      ok: false,
      code: 'LLM_INPUT_TOO_LARGE',
      maxTokens: 10,
      limitSource: 'explicit',
    });
    expect(validateLlmInputSize({}, measurementOf(128_001))).toMatchObject({
      ok: false,
      maxTokens: 128_000,
      limitSource: 'default',
    });
  });

  it.each([
    // anthropic → claude 归一后命中 200k 窗口；请求 4096 输出未超过模型 maxOutputTokens。
    ['anthropic:claude-opus-4-5', 'model-registry', 'claude:claude-opus-4-5', 200_000 - 4_096],
    // 无 provider 前缀的裸 apiModelId 按 findByApiModelId 命中。
    ['llama3', 'model-registry', 'ollama:llama3', 4_096],
    // 未知 provider（含部署选择 auto）不跨 provider 猜测，也不用动态 128k 定义冒充注册值。
    ['auto:llama3', 'default', null, 128_000],
  ] as const)('resolves modelRef %s like the gateway does', async (modelRef, source, registryModelId, limit) => {
    const { runtime, info } = createRuntime({ name: 'unit-test', model: 'unit' }, modelRef);

    await runtime.reactLoop('hello', {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000 },
    });

    expect(findLimitLog(info)).toMatchObject({
      modelRef,
      source,
      registryModelId,
      maxProviderInputTokens: limit,
    });
  });

  it('computes the limit purely from the registered model declaration', () => {
    const registeredModel = { id: 'x:model', contextWindow: 10_000, maxOutputTokens: 2_000 };
    // budget.maxTokens 超过模型 maxOutputTokens 时按 ParameterGuard 口径截断后再预留。
    expect(
      resolveProviderInputLimit({
        budget: { maxTokens: 5_000 },
        registeredModel,
        defaultMaxOutputTokens: 4_096,
      })
    ).toEqual({
      maxTokens: 8_000,
      source: 'model-registry',
      registryModelId: 'x:model',
      contextWindow: 10_000,
      outputReserveTokens: 2_000,
    });
    expect(
      resolveProviderInputLimit({
        budget: { maxProviderInputTokens: 'abc' },
        registeredModel: null,
        defaultMaxOutputTokens: 4_096,
      })
    ).toEqual({ maxTokens: 128_000, source: 'default', invalidExplicitValue: 'abc' });
  });

  it('skips the output reserve with a warning when it would consume the whole window', async () => {
    getModelRegistry().register({
      id: 'ollama:i14-tiny-window',
      displayName: 'I14 tiny window fixture',
      provider: 'ollama',
      apiModelId: 'i14-tiny-window',
      contextWindow: 2_048,
      maxOutputTokens: 8_192,
      capabilities: {
        toolCalling: true,
        vision: false,
        embedding: false,
        jsonMode: false,
        streaming: true,
      },
      reasoning: { supported: false },
      parameterConstraints: {
        temperature: { allowed: true, min: 0, max: 2 },
        toolChoice: { allowed: true },
      },
    });
    const { runtime, chatWithTools, info, warn } = createRuntime({
      name: 'ollama',
      model: 'i14-tiny-window',
    });

    const result = await runtime.reactLoop(promptOfTokens(3_000), {
      source: 'user',
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000 },
    });

    // 预留 4096 ≥ 窗口 2048：不能得到 ≤0 的上限去拒绝一切输入，退回整个窗口并 warn。
    expect(findLimitLog(info)).toMatchObject({
      source: 'model-registry',
      maxProviderInputTokens: 2_048,
      outputReserveTokens: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped output reserve'),
      expect.objectContaining({ registryModelId: 'ollama:i14-tiny-window', contextWindow: 2_048 })
    );
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({ code: 'LLM_INPUT_TOO_LARGE' })
    );
  });
});
