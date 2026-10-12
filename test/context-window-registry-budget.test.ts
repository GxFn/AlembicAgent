import Logger from '@alembic/core/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/ContextWindow.js';
import { SystemRunContextFactory } from '../src/agent/service/SystemRunContextFactory.js';
import type { ModelDef } from '../src/ai/registry/ModelDefs.js';
import { getModelRegistry } from '../src/ai/registry/ModelRegistry.js';

const MODEL = 'gemini-3-flash-preview';
const MODEL_ID = `google:${MODEL}`;
// ContextWindow 自有正则表把 gemini-3 记为 1_048_576（system 预算 48k / 普通 36k）。夹具把注册表
// 声明临时改为 100k（system 预算 24k / 普通 20k），预算是否取自注册表由此可观察。
const REGISTRY_CONTEXT = 100_000;
const REGISTRY_SYSTEM_BUDGET = 24_000;
const REGISTRY_RUN_BUDGET = 20_000;
const REGEX_SYSTEM_BUDGET = 48_000;

let original: ModelDef;
let debug: ReturnType<typeof vi.spyOn>;

function budgetDiagnostics(): string[] {
  return debug.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('token_budget_source'));
}

beforeEach(() => {
  vi.stubEnv('ALEMBIC_AI_PROVIDER', undefined);
  const registry = getModelRegistry();
  const def = registry.get(MODEL_ID);
  if (!def) {
    throw new Error(`fixture model ${MODEL_ID} missing from registry`);
  }
  original = def;
  registry.register({ ...def, contextWindow: REGISTRY_CONTEXT });
  debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  // 注册表是进程内单例：恢复原声明，避免夹具泄漏到同文件的其他用例。
  getModelRegistry().register(original);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ContextWindow.resolveTokenBudget registry lookup', () => {
  it('uses the registry contextWindow when ALEMBIC_AI_PROVIDER=auto', () => {
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'auto');
    expect(ContextWindow.resolveTokenBudget(MODEL, { isSystem: true })).toBe(
      REGISTRY_SYSTEM_BUDGET
    );
    expect(ContextWindow.resolveTokenBudget(MODEL)).toBe(REGISTRY_RUN_BUDGET);
    const [diagnostic] = budgetDiagnostics();
    expect(diagnostic).toContain('source=registry');
    expect(diagnostic).toContain('lookup=apiModelId');
    expect(diagnostic).toContain(`contextWindow=${REGISTRY_CONTEXT}`);
  });

  it('uses the registry contextWindow when no provider hint is available', () => {
    expect(ContextWindow.resolveTokenBudget(MODEL, { isSystem: true })).toBe(
      REGISTRY_SYSTEM_BUDGET
    );
    expect(budgetDiagnostics()[0]).toContain('lookup=apiModelId');
  });

  it('normalizes provider aliases before the provider-scoped registry lookup', () => {
    expect(ContextWindow.resolveTokenBudget(MODEL, { isSystem: true, provider: 'gemini' })).toBe(
      REGISTRY_SYSTEM_BUDGET
    );
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'Google');
    expect(ContextWindow.resolveTokenBudget(MODEL, { isSystem: true })).toBe(
      REGISTRY_SYSTEM_BUDGET
    );
    for (const diagnostic of budgetDiagnostics()) {
      expect(diagnostic).toContain('source=registry');
      expect(diagnostic).toContain('lookup=provider');
    }
  });

  it('keeps an explicit provider authoritative and logs the regex fallback when it misses', () => {
    // 显式 provider 与模型不匹配时不跨 provider 猜测，按正则表兜底并留下诊断。
    expect(ContextWindow.resolveTokenBudget(MODEL, { isSystem: true, provider: 'openai' })).toBe(
      REGEX_SYSTEM_BUDGET
    );
    const [diagnostic] = budgetDiagnostics();
    expect(diagnostic).toContain('source=regex');
    expect(diagnostic).toContain('lookup=provider');
  });

  it('falls back to the regex table for unregistered models under auto and says so', () => {
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'auto');
    // gpt-4-0613 未登记：正则表 8_192 → 微窗口按 0.75 取整。
    expect(ContextWindow.resolveTokenBudget('gpt-4-0613', { isSystem: true })).toBe(6_144);
    const [diagnostic] = budgetDiagnostics();
    expect(diagnostic).toContain('source=regex');
    expect(diagnostic).toContain('contextWindow=8192');
  });

  it('keeps the conservative default for an empty model name', () => {
    expect(ContextWindow.resolveTokenBudget('', { isSystem: true })).toBe(14_000);
    expect(budgetDiagnostics()[0]).toContain('source=default');
  });
});

describe('SystemRunContextFactory provider hint', () => {
  it('passes AiProvider.name so a mismatched ALEMBIC_AI_PROVIDER does not bypass the registry', () => {
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'openai');
    // 宿主注入的是完整 AiProvider 实例（name 恒在），公开选项类型仍只声明 model。
    const aiProvider = { name: 'google', model: MODEL };
    const factory = new SystemRunContextFactory({ aiProvider });
    expect(factory.createContextWindow({ isSystem: true }).tokenBudget).toBe(
      REGISTRY_SYSTEM_BUDGET
    );
  });

  it('still resolves the registry budget for host providers typed as { model } under auto', () => {
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'auto');
    const factory = new SystemRunContextFactory({ aiProvider: { model: MODEL } });
    expect(factory.createContextWindow({ isSystem: true }).tokenBudget).toBe(
      REGISTRY_SYSTEM_BUDGET
    );
    expect(factory.createContextWindow().tokenBudget).toBe(REGISTRY_RUN_BUDGET);
  });
});
