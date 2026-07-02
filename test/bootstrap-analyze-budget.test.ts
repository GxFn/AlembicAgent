import { describe, expect, it } from 'vitest';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';

/**
 * analyze 阶段动态预算接线钉子。
 *
 * 背景(2026-07-02 真机冷启动失败)：宿主用 computeAnalystBudget(fileCount, contextWindowBudget)
 * 算出的规模化预算放在 strategyContext._computedBudget，但 PipelineStrategy 的回退顺序是
 * stage.budget || computedBudget——insight preset 的 analyze stage 自带静态兜底(24 轮/480s/
 * 345.6k input)，动态值被永久遮蔽。2000+ 文件项目在 plan 给出高候选预算后，analyze 阶段
 * 撞 stage_timeout(480s)且 analysis_retry 被输入预算(127%)压制，维度直接失败。
 * bootstrapDimensionPipeline 现在把 _computedBudget 的数值字段显式合并进 analyze budget。
 */
describe('bootstrapDimensionPipeline analyze budget wiring', () => {
  it('merges strategyContext._computedBudget over the static analyze preset budget', () => {
    const registry = new AgentStageFactoryRegistry();
    const stages = registry.build('bootstrapDimensionPipeline', {
      params: { needsCandidates: true },
      context: {
        strategyContext: {
          _computedBudget: {
            maxIterations: 40,
            searchBudget: 30,
            timeoutMs: 800_000,
            maxSessionTokens: 777_600,
            maxSessionInputTokens: 576_000,
          },
        },
      },
    }) as Array<{ name: string; budget?: Record<string, unknown> }>;

    const analyze = stages.find((stage) => stage.name === 'analyze');
    expect(analyze).toBeDefined();
    expect(analyze?.budget?.maxIterations).toBe(40);
    expect(analyze?.budget?.timeoutMs).toBe(800_000);
    expect(analyze?.budget?.maxSessionTokens).toBe(777_600);
    expect(analyze?.budget?.maxSessionInputTokens).toBe(576_000);
    // searchBudget 是 tracker 语义不属于 stage budget，不应被合并进来。
    expect(analyze?.budget?.searchBudget).toBeUndefined();
  });

  it('keeps the static preset budget when _computedBudget is absent or invalid', () => {
    const registry = new AgentStageFactoryRegistry();
    const buildWith = (strategyContext: Record<string, unknown> | undefined) =>
      (
        registry.build('bootstrapDimensionPipeline', {
          params: { needsCandidates: true },
          context: strategyContext ? { strategyContext } : {},
        }) as Array<{ name: string; budget?: Record<string, unknown> }>
      ).find((stage) => stage.name === 'analyze');

    const noContext = buildWith(undefined);
    expect(noContext?.budget?.timeoutMs).toBe(480_000);

    const invalid = buildWith({
      _computedBudget: { maxIterations: 0, timeoutMs: Number.NaN, maxSessionInputTokens: -5 },
    });
    expect(invalid?.budget?.timeoutMs).toBe(480_000);
    expect(invalid?.budget?.maxSessionInputTokens).toBeGreaterThan(0);
  });

  it('does not leak the analyze dynamic budget into the produce stage', () => {
    const registry = new AgentStageFactoryRegistry();
    const stages = registry.build('bootstrapDimensionPipeline', {
      params: { needsCandidates: true },
      context: {
        strategyContext: {
          _computedBudget: { maxIterations: 40, timeoutMs: 800_000 },
        },
      },
    }) as Array<{ name: string; budget?: Record<string, unknown> }>;

    const produce = stages.find((stage) => stage.name === 'produce');
    expect(produce).toBeDefined();
    // produce 阶段预算语义独立(maxSubmits/coverage 放大在 runtime 侧)，不吃 Analyst 预算。
    expect(produce?.budget?.timeoutMs).not.toBe(800_000);
    expect(produce?.budget?.maxIterations).not.toBe(40);
  });
});
