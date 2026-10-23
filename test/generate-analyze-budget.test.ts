import { describe, expect, it, vi } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
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
    const stages = registry.build('generateDimensionPipeline', {
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
    // W2a-07（L5-P08）：会话总量上限已删除，computedBudget 里残留的 maxSessionTokens 不再并入阶段预算。
    expect(analyze?.budget && 'maxSessionTokens' in analyze.budget).toBe(false);
    expect(analyze?.budget?.maxSessionInputTokens).toBe(576_000);
    // searchBudget 是 tracker 语义不属于 stage budget，不应被合并进来。
    expect(analyze?.budget?.searchBudget).toBeUndefined();
  });

  it('keeps the static preset budget when _computedBudget is absent or invalid', () => {
    const registry = new AgentStageFactoryRegistry();
    const buildWith = (strategyContext: Record<string, unknown> | undefined) =>
      (
        registry.build('generateDimensionPipeline', {
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
    const stages = registry.build('generateDimensionPipeline', {
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

/**
 * L8-C14：produce 阶段的 promptBuilder 不得改写会话共享的 MemoryCoordinator。
 *
 * 背景：宿主一次会话只建一个 coordinator，并行维度各自用 createDimensionScope 拿自己的 scope。
 * 旧实现在 produce.promptBuilder 里调用 allocateBudget('producer')：它改写实例级分配模式，并清空
 * 所有 scope 的静态预算快照(含 surplus)。AgentRuntime 构建动态记忆时总按 pipelinePhase 显式传
 * mode，所以模式切换本身无效；但快照被清空后，另一个仍在 analyze 的维度会丢掉 surplus，工作记忆
 * 配额从 activeContext+surplus 缩回 activeContext。本用例按真实装配路径(编译器把 run context
 * 原样交给工厂，context.memoryCoordinator 即共享实例)观察两个 scope 的动态预算前后不变。
 */
describe('generateDimensionPipeline produce stage and the shared MemoryCoordinator (L8-C14)', () => {
  const TOTAL_MEMORY_BUDGET = 1000;
  const SCOPE_A = 'dimA:analyst';
  const SCOPE_B = 'dimB:producer';

  it('keeps every scope budget snapshot and surplus when another dimension builds its produce prompt', async () => {
    const coordinator = new MemoryCoordinator({ totalMemoryBudget: TOTAL_MEMORY_BUDGET });
    const scopeA = coordinator.createDimensionScope(SCOPE_A);
    const scopeB = coordinator.createDimensionScope(SCOPE_B);
    // buildContext 收到的参数就是该 scope 的工作记忆配额(activeContext + 同 mode 的 surplus)。
    const buildA = vi.spyOn(scopeA, 'buildContext').mockReturnValue('');
    const buildB = vi.spyOn(scopeB, 'buildContext').mockReturnValue('');
    const lastBudget = (spy: typeof buildA) => spy.mock.calls.at(-1)?.[0];

    try {
      // A 仍在 analyze：先记录静态快照。没有持久/会话记忆时静态部分为空，静态份额全部成为 surplus。
      await coordinator.buildStaticMemoryPrompt({ scopeId: SCOPE_A, mode: 'analyst' });
      coordinator.buildDynamicMemoryPrompt({ scopeId: SCOPE_A, mode: 'analyst' });
      const budgetABefore = lastBudget(buildA);
      // analyst 分配下 activeContext=450，surplus=550；两者之和才是 A 应得的配额。
      expect(budgetABefore).toBe(TOTAL_MEMORY_BUDGET);

      // B 已进入 produce：同样持有自己的 producer 快照(activeContext=250，surplus=750)。
      await coordinator.buildStaticMemoryPrompt({ scopeId: SCOPE_B, mode: 'producer' });
      coordinator.buildDynamicMemoryPrompt({ scopeId: SCOPE_B, mode: 'producer' });
      const budgetBBefore = lastBudget(buildB);
      expect(budgetBBefore).toBe(TOTAL_MEMORY_BUDGET);

      const allocateBudget = vi.spyOn(coordinator, 'allocateBudget');
      const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
        params: { needsCandidates: true },
        context: { memoryCoordinator: coordinator },
      }) as Array<{ name: string; promptBuilder?: (ctx: Record<string, unknown>) => unknown }>;
      const produce = stages.find((stage) => stage.name === 'produce');
      expect(typeof produce?.promptBuilder).toBe('function');

      // B 以完整的 quality_gate 交接构建 produce 提示：提示必须真实生成，而不是在前置校验处抛错。
      const prompt = produce?.promptBuilder?.({
        gateArtifact: {
          analysisText: 'L8-C14 producer handoff marker',
          findings: [],
          referencedFiles: ['src/a.ts'],
          negativeSignals: [],
        },
        dimConfig: { id: 'dimB', label: 'Dimension B' },
        projectInfo: { name: 'fixture' },
      });
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('L8-C14 producer handoff marker');

      // A 的快照与 surplus 未被清空：配额仍是 activeContext + surplus，而不是退回 analyst 的 450。
      coordinator.buildDynamicMemoryPrompt({ scopeId: SCOPE_A, mode: 'analyst' });
      expect(lastBudget(buildA)).toBe(budgetABefore);
      // B 自己的 producer 快照同样保持不变(退回时只剩 activeContext=250)。
      coordinator.buildDynamicMemoryPrompt({ scopeId: SCOPE_B, mode: 'producer' });
      expect(lastBudget(buildB)).toBe(budgetBBefore);
      // 行为断言之外再钉住根因：produce 装配路径不再触碰共享 coordinator 的全局分配。
      expect(allocateBudget).not.toHaveBeenCalled();
    } finally {
      coordinator.dispose();
    }
  });
});
