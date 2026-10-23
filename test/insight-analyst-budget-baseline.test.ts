import { describe, expect, it } from 'vitest';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { ANALYST_BUDGET, computeAnalystBudget } from '../src/agent/prompts/index.js';

// module-review L6 C57（审阅包 L6-P25，用户已批准统一口径）：静态 ANALYST_BUDGET 曾按
// 24 × 24000 × 0.6（345.6k input）估算，而 computeAnalystBudget 对同一 24 轮基线在未传
// contextWindowBudget 时按 24 × 15000 × 0.6（216k input）估算，两处注释互相矛盾。
// 统一后静态兜底与动态计算同源：insightPreset 的 analyze 阶段在没有 _computedBudget 时
// 使用的会话预算，与宿主未提供上下文窗口时 computeAnalystBudget(≤40 文件) 的结果一致。
// W2a-07（L5-P08，②已答复）：会话总量上限 maxSessionTokens（input × 1.35）已删除，键集合少一项；
// 阶段会话 input 上限的数值与公式不变。

describe('ANALYST_BUDGET static baseline (C57)', () => {
  it('derives the session input cap from the same 24-round estimate as computeAnalystBudget', () => {
    const dynamicBaseline = computeAnalystBudget(0);
    expect(dynamicBaseline.maxIterations).toBe(ANALYST_BUDGET.maxIterations);
    expect(ANALYST_BUDGET.maxSessionInputTokens).toBe(dynamicBaseline.maxSessionInputTokens);
    // 24 轮 × ceil(15000 × 0.6) = 216k input。
    expect(ANALYST_BUDGET.maxSessionInputTokens).toBe(216_000);
    expect('maxSessionTokens' in ANALYST_BUDGET).toBe(false);
    expect('maxSessionTokens' in dynamicBaseline).toBe(false);
  });

  it('keeps the non-session fields and their names unchanged', () => {
    expect(Object.keys(ANALYST_BUDGET)).toEqual([
      'maxIterations',
      'searchBudget',
      'searchBudgetGrace',
      'maxSubmits',
      'softSubmitLimit',
      'idleRoundsToExit',
      'maxSessionInputTokens',
    ]);
    expect(ANALYST_BUDGET).toMatchObject({
      maxIterations: 24,
      searchBudget: 18,
      searchBudgetGrace: 10,
      maxSubmits: 0,
      softSubmitLimit: 0,
      idleRoundsToExit: 2,
    });
  });

  it('still scales the session input cap with an explicit context window budget', () => {
    const scaled = computeAnalystBudget(0, 24_000);
    expect(scaled.maxSessionInputTokens).toBe(24 * Math.ceil(24_000 * 0.6));
    expect('maxSessionTokens' in scaled).toBe(false);
  });

  it('uses the unified static caps as the insight analyze stage fallback without _computedBudget', () => {
    const registry = new AgentStageFactoryRegistry();
    const stages = registry.build('generateDimensionPipeline', {
      params: { needsCandidates: true },
      context: {},
    }) as Array<{ name: string; budget?: Record<string, unknown> }>;
    const analyze = stages.find((stage) => stage.name === 'analyze');
    expect(analyze?.budget?.maxSessionInputTokens).toBe(216_000);
    expect(analyze?.budget && 'maxSessionTokens' in analyze.budget).toBe(false);
  });
});
