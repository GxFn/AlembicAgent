/**
 * AgentProfileCompiler 对策略层会话字段的编译期告警（L5-P8 / I03）。
 *
 * 会话预算的归属是阶段预算 + BudgetController；策略层 maxSessionTokens / maxSessionInputTokens
 * 按整次运行累计判定，待公开面收窄（事项②）时删除。删除前编译器保留字段与行为，
 * 只在声明式 profile 编译时告警，让调用方看见口径差异，而不是静默接受。
 */
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetPolicy } from '../src/agent/policies/BudgetPolicy.js';
import { AgentProfileCompiler } from '../src/agent/profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../src/agent/profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';

function createCompiler() {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry([]),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}

function sessionFieldWarnings(warn: ReturnType<typeof vi.spyOn>) {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('policy_session_fields_deprecated'));
}

describe('AgentProfileCompiler 策略层会话字段告警', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('budget 声明带 maxSessionTokens：编译成功、字段保留，并告警一次', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    const profile = createCompiler().compile({
      id: 'session-cap-profile',
      basePreset: 'chat',
      policies: [{ type: 'budget', maxIterations: 5, maxSessionTokens: 1_000 }],
    });

    const policy = profile.policies?.[0] as BudgetPolicy;
    expect(policy).toBeInstanceOf(BudgetPolicy);
    expect(policy.maxSessionTokens).toBe(1_000);
    const messages = sessionFieldWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('maxSessionTokens');
    expect(messages[0]).toContain('BudgetController');
  });

  it('同时带 maxSessionInputTokens：告警列出两个字段', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    createCompiler().compile({
      basePreset: 'chat',
      policies: [{ type: 'budget', maxSessionTokens: 1_000, maxSessionInputTokens: 800 }],
    });

    const messages = sessionFieldWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('maxSessionTokens');
    expect(messages[0]).toContain('maxSessionInputTokens');
  });

  it('不带会话字段的 budget 声明不告警', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    createCompiler().compile({
      basePreset: 'chat',
      policies: [{ type: 'budget', maxIterations: 5, timeoutMs: 60_000 }],
    });

    expect(sessionFieldWarnings(warn)).toHaveLength(0);
  });
});
