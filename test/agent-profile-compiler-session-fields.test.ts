/**
 * AgentProfileCompiler 对策略层会话字段的编译期告警（L5-P8 / I03；W2a-07 按②答复收窄）。
 *
 * 会话预算的归属是阶段预算 + BudgetController。W2a-07 删除了策略层运行级总量上限 maxSessionTokens：
 * 声明了也被忽略（不再按累计停止运行），编译期告警写明“已删除、被忽略”。策略层 maxSessionInputTokens
 * 保留，告警只说明它按整次运行累计判定、以及阶段未声明时被屏蔽，不再宣称它待删除。
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

  it('budget 声明带 maxSessionTokens：编译成功、字段被忽略，并告警一次写明已删除', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    const profile = createCompiler().compile({
      id: 'session-cap-profile',
      basePreset: 'chat',
      policies: [{ type: 'budget', maxIterations: 5, maxSessionTokens: 1_000 }],
    });

    const policy = profile.policies?.[0] as BudgetPolicy;
    expect(policy).toBeInstanceOf(BudgetPolicy);
    expect(policy.maxIterations).toBe(5);
    expect('maxSessionTokens' in policy).toBe(false);
    // 累计总量超过旧上限也不再停止运行。
    expect(
      policy.validateDuring({ iteration: 0, startTime: Date.now(), totalTokens: 1_400 })
    ).toEqual({ ok: true, action: 'continue' });
    const messages = sessionFieldWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('maxSessionTokens=1000 has been removed and is ignored');
    expect(messages[0]).toContain('BudgetController');
  });

  it('同时带 maxSessionInputTokens：一条告警分别说明两个字段（input 字段保留且照常生效）', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    createCompiler().compile({
      basePreset: 'chat',
      policies: [{ type: 'budget', maxSessionTokens: 1_000, maxSessionInputTokens: 800 }],
    });

    const messages = sessionFieldWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('maxSessionTokens=1000 has been removed and is ignored');
    expect(messages[0]).toContain('maxSessionInputTokens=800 is checked against run-level');
    expect(messages[0]).toContain('policy_session_limit_bypassed');
    expect(messages[0]).not.toContain('scheduled for removal');
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
