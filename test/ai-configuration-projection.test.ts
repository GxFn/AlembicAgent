import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAiConfigInfo } from '../src/ai/AiFactory.js';
import { aiConfigInfo } from '../src/ai/configuration.js';

// 只隔离 AI 相关环境变量，不读取/打印本机凭据。
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^ALEMBIC_(AI_|EMBED_|OPENAI_|GOOGLE_|GEMINI_|CLAUDE_|DEEPSEEK_|OLLAMA_)/.test(key)) {
      vi.stubEnv(key, undefined);
    }
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// L2-I12：aiConfigInfo 是声明投影，不是就绪判定。这里把投影语义钉住，
// 说明宿主为什么不能用 `provider && provider !== 'none'` 推断“AI 已配置”：
// provider 在未声明时恒为 'auto'，不存在 'none' 值；就绪应由 Core isAiEnvReady
// 或宿主 AiRuntimeStatus 判定。该测试只做特征锁定，不改变任何行为。
describe('aiConfigInfo declaration projection (not readiness)', () => {
  it('reports provider "auto" with no key at all, so a non-empty provider never implies readiness', () => {
    const info = aiConfigInfo({});
    expect(info.provider).toBe('auto');
    expect(info.provider).not.toBe('none');
    expect(info.hasKey).toBe(false);
    expect(info.keys).toEqual({ google: false, openai: false, claude: false, deepseek: false });
  });

  it('echoes a declared key-based provider even when its key is missing', () => {
    const info = aiConfigInfo({ ALEMBIC_AI_PROVIDER: 'google' });
    expect(info.provider).toBe('google');
    expect(info.keys.google).toBe(false);
    expect(info.hasKey).toBe(false);
  });

  it('does not reflect keyless providers such as ollama in hasKey', () => {
    // ollama 无需 key 即可就绪，但投影的 hasKey 只统计四个 key 型 provider，
    // 因此 hasKey 也不能当作就绪信号。
    const info = aiConfigInfo({ ALEMBIC_AI_PROVIDER: 'ollama' });
    expect(info.provider).toBe('ollama');
    expect(info.hasKey).toBe(false);
  });

  it('only exposes key presence booleans, never credential values', () => {
    const info = aiConfigInfo({
      ALEMBIC_AI_PROVIDER: 'openai',
      ALEMBIC_OPENAI_API_KEY: 'fixture-projection-key',
    });
    expect(info.keys.openai).toBe(true);
    expect(info.hasKey).toBe(true);
    expect(JSON.stringify(info)).not.toContain('fixture-projection-key');
  });

  it('host facade getAiConfigInfo returns the same projection from process.env', () => {
    expect(getAiConfigInfo()).toEqual(aiConfigInfo({}));
    expect(getAiConfigInfo().provider).toBe('auto');
  });
});
