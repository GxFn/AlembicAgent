import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoDetectProvider } from '../src/ai/AiFactory.js';
import { aiConfigInfo } from '../src/ai/configuration.js';

/**
 * L2-P23c（L2-I12 审计补修）：aiConfigInfo / getAiConfigInfo 的“就绪”指引必须与运行时同源。
 *
 * - 运行时（宿主容器初始化）经 autoDetectProvider → detectProvider 选择 provider；null 或抛错即不可用。
 *   这里先用真实函数钉住这条运行时口径，证明投影里的 provider 字段与它在多种输入上结论相反。
 * - 注释曾把 Core isAiEnvReady(collectAiEnv(env)) 推荐为宿主就绪依据，但它与 autoDetectProvider
 *   结论不等价（auto/none/gemini 无 key 报就绪、只设 key 报未就绪）；本文件不 import Core，
 *   只要求注释里凡提到 isAiEnvReady 的句子都是否定式，避免把错误指引再写回来。
 * - 宿主只能经 @alembic/agent/ai 拿到 getAiConfigInfo（aiConfigInfo 不在任何导出子路径上），
 *   所以说明必须出现在 getAiConfigInfo 的 JSDoc 上，tsc 才会把它带进 d.ts。
 * 只钉住已核实的事实与关键符号，不约束其余措辞。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** 取紧贴在锚点之前的 JSDoc 块正文（两者之间只能有空白），去掉注释定界符与行首星号。 */
function jsDocTextBefore(relativePath: string, anchor: string): string {
  const source = readSource(relativePath);
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const head = source.slice(0, anchorIndex);
  const end = head.lastIndexOf('*/');
  expect(end, `no JSDoc before ${anchor}`).toBeGreaterThanOrEqual(0);
  expect(head.slice(end + 2).trim(), `JSDoc not adjacent to ${anchor}`).toBe('');
  const start = head.lastIndexOf('/**', end);
  expect(start, `no JSDoc opener before ${anchor}`).toBeGreaterThanOrEqual(0);
  return head
    .slice(start + 3, end)
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .join('');
}

/** 按中文句读切句，供“提到某符号的句子必须是否定式”这类检查使用。 */
function sentencesMentioning(text: string, token: string): string[] {
  return text
    .split(/[。；]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.includes(token));
}

const AIFACTORY = 'src/ai/AiFactory.ts';
const CONFIGURATION = 'src/ai/configuration.ts';
const GET_AI_CONFIG_INFO = 'export function getAiConfigInfo(';
const AI_CONFIG_INFO = 'export function aiConfigInfo(';

/** 宿主 bin 曾用的投影谓词；这里只用于对照，证明它不是就绪信号。 */
function hostProjectionPredicate(provider: string): boolean {
  return !!(provider && provider !== 'none');
}

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

describe('runtime readiness comes from autoDetectProvider, not the declaration projection', () => {
  /** 运行时口径：autoDetectProvider 返回实例即就绪；null 或抛错都算未就绪（宿主容器同样 catch 成 null）。 */
  function runtimeReadiness(): { ready: boolean; provider: string | null; errorCode?: unknown } {
    try {
      const provider = autoDetectProvider();
      return { ready: provider !== null, provider: provider?.name ?? null };
    } catch (err: unknown) {
      const code = err && typeof err === 'object' ? Reflect.get(err, 'code') : undefined;
      return { ready: false, provider: null, errorCode: code };
    }
  }

  const cases: Array<{
    name: string;
    env: Record<string, string>;
    ready: boolean;
    provider: string | null;
    errorCode?: string;
  }> = [
    { name: 'nothing declared', env: {}, ready: false, provider: null },
    {
      name: 'explicit auto without any key',
      env: { ALEMBIC_AI_PROVIDER: 'auto' },
      ready: false,
      provider: null,
    },
    {
      name: 'only an openai key, no provider declared',
      env: { ALEMBIC_OPENAI_API_KEY: 'fixture-readiness-key' },
      ready: true,
      provider: 'openai',
    },
    {
      name: 'gemini alias without its key',
      env: { ALEMBIC_AI_PROVIDER: 'gemini' },
      ready: false,
      provider: null,
    },
    {
      name: 'google with a whitespace-only key',
      env: { ALEMBIC_AI_PROVIDER: 'google', ALEMBIC_GOOGLE_API_KEY: '   ' },
      ready: false,
      provider: null,
    },
    {
      name: 'literal none is not a provider identity',
      env: { ALEMBIC_AI_PROVIDER: 'none' },
      ready: false,
      provider: null,
      errorCode: 'LLM_INVALID_REQUEST',
    },
    {
      name: 'keyless ollama',
      env: { ALEMBIC_AI_PROVIDER: 'ollama' },
      ready: true,
      provider: 'ollama',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: runtime ready=${testCase.ready}`, () => {
      for (const [key, value] of Object.entries(testCase.env)) {
        vi.stubEnv(key, value);
      }
      const result = runtimeReadiness();
      expect(result.ready).toBe(testCase.ready);
      expect(result.provider).toBe(testCase.provider);
      if (testCase.errorCode) {
        expect(result.errorCode).toBe(testCase.errorCode);
      }
    });
  }

  it('the projection predicate disagrees with runtime readiness on auto, aliases and blank keys', () => {
    // 投影 provider 原样回显声明值，谓词在这些输入上为真，但运行时不可用。
    for (const env of [
      {},
      { ALEMBIC_AI_PROVIDER: 'auto' },
      { ALEMBIC_AI_PROVIDER: 'gemini' },
      { ALEMBIC_AI_PROVIDER: 'google', ALEMBIC_GOOGLE_API_KEY: '   ' },
    ]) {
      expect(hostProjectionPredicate(aiConfigInfo(env).provider)).toBe(true);
    }
  });

  it('a literal ALEMBIC_AI_PROVIDER=none is echoed, so the projection predicate is false there', () => {
    const info = aiConfigInfo({ ALEMBIC_AI_PROVIDER: 'none' });
    expect(info.provider).toBe('none');
    expect(hostProjectionPredicate(info.provider)).toBe(false);
    // 空串仍按未声明处理为 'auto'；大小写不同的 'NONE' 原样回显，谓词为真。
    expect(aiConfigInfo({ ALEMBIC_AI_PROVIDER: '' }).provider).toBe('auto');
    expect(hostProjectionPredicate(aiConfigInfo({ ALEMBIC_AI_PROVIDER: 'NONE' }).provider)).toBe(
      true
    );
  });
});

describe('readiness guidance in the projection docs', () => {
  // aiConfigInfo 是实现处；getAiConfigInfo 是宿主经 @alembic/agent/ai 唯一能看到（含 d.ts）的入口。
  const locations = [
    { where: 'aiConfigInfo', file: CONFIGURATION, anchor: AI_CONFIG_INFO },
    { where: 'getAiConfigInfo', file: AIFACTORY, anchor: GET_AI_CONFIG_INFO },
  ];

  for (const { where, file, anchor } of locations) {
    it(`${where}: never recommends Core isAiEnvReady as the readiness basis`, () => {
      const text = jsDocTextBefore(file, anchor);
      for (const sentence of sentencesMentioning(text, 'isAiEnvReady')) {
        expect(sentence, 'isAiEnvReady must only appear as a warning').toMatch(/不要|不能|不等价/);
      }
    });

    it(`${where}: points readiness at autoDetectProvider and getAiRuntimeStatus`, () => {
      const text = jsDocTextBefore(file, anchor);
      expect(text, 'must say the projection is not readiness').toContain('不代表就绪');
      expect(text, 'must name autoDetectProvider').toContain('autoDetectProvider');
      expect(text, 'must name getAiRuntimeStatus').toContain('getAiRuntimeStatus');
    });

    it(`${where}: does not overstate the projection predicate as always true`, () => {
      const text = jsDocTextBefore(file, anchor);
      expect(text, 'the predicate is false for a literal none').not.toContain('恒为真');
      expect(text, 'must name the literal none exception').toContain('ALEMBIC_AI_PROVIDER=none');
    });
  }
});
