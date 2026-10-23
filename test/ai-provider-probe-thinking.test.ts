import Logger from '@alembic/core/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviderWithFallback } from '../src/ai/AiFactory.js';
import { ClaudeProvider } from '../src/ai/providers/ClaudeProvider.js';
import { DeepSeekProvider } from '../src/ai/providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from '../src/ai/providers/GoogleGeminiProvider.js';
import { OllamaProvider } from '../src/ai/providers/OllamaProvider.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';
import { jsonResponse } from './helpers/mockFetch.js';

/**
 * W2a-11r1：probe 回答“此刻能否连通并通过鉴权”。
 *
 * thinking/reasoning 模型在 16 token 的探针预算内常常只产出推理、没有可见文本
 * （Gemini finishReason=MAX_TOKENS + thoughtsTokenCount；OpenAI/DeepSeek/Ollama 空 content +
 * reasoning；Claude 只有 thinking 块 + stop_reason=max_tokens）。这些都是一次成功、已计费的
 * API 调用，旧实现按可见文本是否为空判 false，getProviderWithFallback 因此把健康的主 provider
 * 切到 fallback。本文件钉住新口径：成功返回且带应答证据即判可用；真实失败仍抛出。
 */

/** 本组涉及的全部 provider 选择与代理环境变量；每条用例从空环境开始。 */
const ENV_NAMES = [
  'ALEMBIC_AI_PROVIDER',
  'ALEMBIC_AI_MODEL',
  'ALEMBIC_AI_MAX_CONCURRENCY',
  'ALEMBIC_GEMINI_MAX_CONCURRENCY',
  'ALEMBIC_GOOGLE_API_KEY',
  'ALEMBIC_OPENAI_API_KEY',
  'ALEMBIC_DEEPSEEK_API_KEY',
  'ALEMBIC_CLAUDE_API_KEY',
  'ALEMBIC_GOOGLE_MODEL',
  'ALEMBIC_OPENAI_MODEL',
  'ALEMBIC_DEEPSEEK_MODEL',
  'ALEMBIC_CLAUDE_MODEL',
  'ALEMBIC_OLLAMA_MODEL',
  'ALEMBIC_GOOGLE_BASE_URL',
  'ALEMBIC_OPENAI_BASE_URL',
  'ALEMBIC_DEEPSEEK_BASE_URL',
  'ALEMBIC_CLAUDE_BASE_URL',
  'ALEMBIC_OLLAMA_BASE_URL',
  'ALEMBIC_AI_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'ALEMBIC_GOOGLE_PROXY_HTTPS',
  'ALEMBIC_GOOGLE_PROXY_HTTP',
  'ALEMBIC_OPENAI_PROXY_HTTPS',
  'ALEMBIC_OPENAI_PROXY_HTTP',
  'ALEMBIC_DEEPSEEK_PROXY_HTTPS',
  'ALEMBIC_DEEPSEEK_PROXY_HTTP',
  'ALEMBIC_CLAUDE_PROXY_HTTPS',
  'ALEMBIC_CLAUDE_PROXY_HTTP',
  'ALEMBIC_OLLAMA_PROXY_HTTPS',
  'ALEMBIC_OLLAMA_PROXY_HTTP',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of ENV_NAMES) {
    const value = savedEnv.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

type ProviderCase = {
  id: 'google' | 'openai' | 'claude' | 'deepseek' | 'ollama';
  create: () => GoogleGeminiProvider | OpenAiProvider | ClaudeProvider | DeepSeekProvider;
  /** 主 provider 的 key 环境变量（ollama 无 key）。 */
  keyEnv: string | null;
  /** 用作 fallback 的另一个已配置 provider 的 key 环境变量。 */
  fallbackKeyEnv: string;
  fallbackId: string;
  /** 成功、已计费但没有可见文本的厂商应答。 */
  reasoningOnly: () => Record<string, unknown>;
};

/** 各 provider 的“成功调用但无可见文本”应答形态（只含推理计费或推理内容）。 */
const CASES: ProviderCase[] = [
  {
    id: 'google',
    create: () => new GoogleGeminiProvider({ apiKey: 'fixture-key' }),
    keyEnv: 'ALEMBIC_GOOGLE_API_KEY',
    fallbackKeyEnv: 'ALEMBIC_OPENAI_API_KEY',
    fallbackId: 'openai',
    // 默认模型 gemini-3-flash-preview 是 thinking 模型：思考把 16 token 预算用尽，没有候选文本，
    // proto3 JSON 省略了零值 candidatesTokenCount（sdkProtocol.toTokenUsage 记录的真实形态）。
    reasoningOnly: () => ({
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 3, thoughtsTokenCount: 16, totalTokenCount: 19 },
    }),
  },
  {
    id: 'openai',
    create: () => new OpenAiProvider({ apiKey: 'fixture-key' }),
    keyEnv: 'ALEMBIC_OPENAI_API_KEY',
    fallbackKeyEnv: 'ALEMBIC_CLAUDE_API_KEY',
    fallbackId: 'claude',
    // reasoning 模型：content 为空，completion 全部是 reasoning_tokens，因长度截断结束。
    reasoningOnly: () => ({
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-5.5',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 16,
        total_tokens: 24,
        completion_tokens_details: { reasoning_tokens: 16 },
      },
    }),
  },
  {
    id: 'claude',
    create: () => new ClaudeProvider({ apiKey: 'fixture-key' }),
    keyEnv: 'ALEMBIC_CLAUDE_API_KEY',
    fallbackKeyEnv: 'ALEMBIC_OPENAI_API_KEY',
    fallbackId: 'openai',
    // 扩展思考：只有 thinking 块，在 max_tokens 处截断，没有 text 块。
    reasoningOnly: () => ({
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'max_tokens',
      content: [{ type: 'thinking', thinking: 'fixture thinking', signature: 'sig_fixture' }],
      usage: { input_tokens: 8, output_tokens: 16 },
    }),
  },
  {
    id: 'deepseek',
    create: () => new DeepSeekProvider({ apiKey: 'fixture-key' }),
    keyEnv: 'ALEMBIC_DEEPSEEK_API_KEY',
    fallbackKeyEnv: 'ALEMBIC_OPENAI_API_KEY',
    fallbackId: 'openai',
    // reasoner 形态：只有 reasoning_content，content 为空，因长度截断结束。
    reasoningOnly: () => ({
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: 0,
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'fixture reasoning' },
          finish_reason: 'length',
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 16,
        total_tokens: 24,
        completion_tokens_details: { reasoning_tokens: 16 },
      },
    }),
  },
  {
    id: 'ollama',
    create: () => new OllamaProvider({}),
    keyEnv: null,
    fallbackKeyEnv: 'ALEMBIC_OPENAI_API_KEY',
    fallbackId: 'openai',
    // 本地 thinking 模型经 OpenAI 兼容端点：content 为空，推理在 reasoning 字段，长度截断。
    reasoningOnly: () => ({
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: 0,
      model: 'llama3',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', reasoning: 'fixture reasoning' },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24 },
    }),
  },
];

function stubFetchWith(body: Record<string, unknown>, status = 200) {
  const fetchMock = vi.fn(async () => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function messagesOf(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([message]) => String(message));
}

describe('AiProvider.probe judges connectivity, not visible text (W2a-11r1)', () => {
  it.each(CASES)('$id probe resolves true for a billed reasoning-only response', async ({
    id,
    create,
    reasoningOnly,
  }) => {
    const fetchMock = stubFetchWith(reasoningOnly());
    const provider = create();
    const info = vi.fn();
    const warn = vi.fn();
    provider.logger = { debug: vi.fn(), info, warn, error: vi.fn() };

    await expect(provider.probe()).resolves.toBe(true);

    // 一次真实请求，不重试、不追加第二次探测。
    expect(fetchMock).toHaveBeenCalledOnce();
    // 判定口径写进诊断：可用但无可见文本，并列出证据来源；诊断不含应答正文。
    const reachable = messagesOf(info).filter((message) =>
      message.includes('probe_reachable_without_visible_text')
    );
    expect(reachable).toHaveLength(1);
    expect(reachable[0]).toContain(`[${id}]`);
    expect(reachable[0]).toMatch(/evidence=\S+/);
    expect(reachable[0]).not.toContain('fixture reasoning');
    expect(reachable[0]).not.toContain('fixture thinking');
    expect(messagesOf(warn).some((message) => message.includes('probe_no_response_evidence'))).toBe(
      false
    );
  });

  it('keeps a probe with visible text as available without the reasoning-only diagnostic', async () => {
    const fetchMock = stubFetchWith({
      choices: [
        { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    });
    const provider = new OpenAiProvider({ apiKey: 'fixture-key', model: 'gpt-4o' });
    const info = vi.fn();
    provider.logger = { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() };

    await expect(provider.probe()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      messagesOf(info).some((message) => message.includes('probe_reachable_without_visible_text'))
    ).toBe(false);
  });

  it('resolves false with a diagnostic when a successful response carries no evidence at all', async () => {
    // 2xx 但没有文本、工具调用、推理、已上报用量，也不是截断结束：无法证明模型真的应答。
    const fetchMock = stubFetchWith({
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    });
    const provider = new OpenAiProvider({ apiKey: 'fixture-key', model: 'gpt-4o' });
    const warn = vi.fn();
    provider.logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    await expect(provider.probe()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    const noEvidence = messagesOf(warn).filter((message) =>
      message.includes('probe_no_response_evidence')
    );
    expect(noEvidence).toHaveLength(1);
    expect(noEvidence[0]).toContain('[openai]');
  });

  it.each([
    { label: 'authentication failure', status: 401 },
    { label: 'permission / region restriction', status: 403 },
  ])('still rejects on $label instead of judging the provider available', async ({ status }) => {
    const fetchMock = stubFetchWith({ error: { message: 'fixture auth failure' } }, status);
    const provider = new OpenAiProvider({ apiKey: 'fixture-key', model: 'gpt-4o' });
    provider.logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(provider.probe()).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('still rejects on a network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiProvider({ apiKey: 'fixture-key', model: 'gpt-4o' });
    provider.logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(provider.probe()).rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('still rejects with PROBE_DEADLINE_EXCEEDED when the deadline fires', async () => {
    // 期限信号由测试手动触发，不依赖真实 30s 等待；请求发出后永不应答。
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        started();
        return new Promise<Response>(() => undefined);
      })
    );
    const provider = new OpenAiProvider({ apiKey: 'fixture-key', model: 'gpt-4o' });
    provider.logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const pending = provider.probe();
    await fetching;
    deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({ code: 'PROBE_DEADLINE_EXCEEDED' });
  });
});

describe('getProviderWithFallback keeps a healthy reasoning-only primary (W2a-11r1)', () => {
  it.each(CASES)('keeps $id when its probe gets a billed reasoning-only response', async ({
    id,
    keyEnv,
    fallbackKeyEnv,
    reasoningOnly,
  }) => {
    process.env.ALEMBIC_AI_PROVIDER = id;
    if (keyEnv) {
      process.env[keyEnv] = 'fixture-primary';
    }
    process.env[fallbackKeyEnv] = 'fixture-fallback';
    const fetchMock = stubFetchWith(reasoningOnly());
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    const info = vi.spyOn(Logger.getInstance(), 'info');

    const provider = await getProviderWithFallback();

    expect(provider?.name).toBe(id);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(messagesOf(warn).some((message) => message.includes('primary_probe_unavailable'))).toBe(
      false
    );
    expect(messagesOf(info).some((message) => message.includes('fallback_selected'))).toBe(false);
  });

  it('still selects the configured fallback when the primary probe gets a provider restriction', async () => {
    process.env.ALEMBIC_AI_PROVIDER = 'google';
    process.env.ALEMBIC_GOOGLE_API_KEY = 'fixture-primary';
    process.env.ALEMBIC_OPENAI_API_KEY = 'fixture-fallback';
    const fetchMock = stubFetchWith(
      { error: { code: 403, message: 'fixture restriction', status: 'PERMISSION_DENIED' } },
      403
    );
    const info = vi.spyOn(Logger.getInstance(), 'info');

    const provider = await getProviderWithFallback();

    expect(provider?.name).toBe('openai');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(messagesOf(info)).toContain(
      '[AiFactory] fallback_selected provider=openai fallbackFrom=google reason=provider_restriction'
    );
  });

  it('still selects the configured fallback when a successful primary probe carries no evidence', async () => {
    process.env.ALEMBIC_AI_PROVIDER = 'openai';
    process.env.ALEMBIC_OPENAI_API_KEY = 'fixture-primary';
    process.env.ALEMBIC_CLAUDE_API_KEY = 'fixture-fallback';
    stubFetchWith({
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    });
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    const info = vi.spyOn(Logger.getInstance(), 'info');

    const provider = await getProviderWithFallback();

    expect(provider?.name).toBe('claude');
    expect(messagesOf(warn)).toContain(
      '[AiFactory] primary_probe_unavailable provider=openai result=false; selecting configured fallback'
    );
    expect(messagesOf(info)).toContain(
      '[AiFactory] fallback_selected provider=claude fallbackFrom=openai reason=probe_unavailable'
    );
  });

  it('warns with a summary when every configured fallback fails to construct and the primary is retained', async () => {
    process.env.ALEMBIC_AI_PROVIDER = 'google';
    process.env.ALEMBIC_GOOGLE_API_KEY = 'fixture-primary';
    process.env.ALEMBIC_OPENAI_API_KEY = 'fixture-fallback';
    process.env.ALEMBIC_CLAUDE_API_KEY = 'fixture-fallback';
    // 主 provider 已构造完成后，让后续构造在并发配置校验处失败（LLM_INVALID_REQUEST），
    // 模拟“所有 fallback 构造失败”；探测本身判为不可用以进入 fallback 链。
    vi.spyOn(GoogleGeminiProvider.prototype, 'probe').mockImplementation(async () => {
      process.env.ALEMBIC_AI_MAX_CONCURRENCY = 'not-a-number';
      return false;
    });
    const warn = vi.spyOn(Logger.getInstance(), 'warn');

    const provider = await getProviderWithFallback();

    expect(provider?.name).toBe('google');
    const perCandidate = messagesOf(warn).filter((message) => message.includes('creation failed'));
    expect(perCandidate).toHaveLength(2);
    const summary = messagesOf(warn).filter((message) => message.includes('fallback_exhausted'));
    expect(summary).toEqual([
      '[AiFactory] fallback_exhausted primary=google reason=probe_unavailable attempted=openai,claude failures=openai:Error,claude:Error; all configured fallbacks failed to construct, retaining primary',
    ]);
  });
});
