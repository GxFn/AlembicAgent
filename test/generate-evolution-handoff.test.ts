import { describe, expect, it, vi } from 'vitest';
import { evolutionGateEvaluator } from '../src/agent/evaluation/gateEvaluators.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

/**
 * 进化阶段 → 分析阶段的结果交接钉子。
 *
 * 背景：generateDimensionPipeline 在维度已有 Recipe 时前置 evolve + evolution_gate。
 * 分析提示里的「Evolution 结果」小节原先读的是「最近一个门产物」，而进化门产物的字段是
 * processed/totalRecipes/pendingIds，与提示期望的 evolved/deprecated/skipped 对不上——
 * 结果是总数正确、三类计数恒为 0，Analyst 被告知「什么都没处理」。
 * 现在三类计数由进化门从累计工具回执推导，分析提示按阶段名读取进化门产物。
 */

const RECIPE_IDS = ['recipe-1', 'recipe-2', 'recipe-3'];

const manage = (id: string, operation: string, result: unknown) => ({
  tool: 'knowledge',
  args: { action: 'manage', params: { id, operation } },
  result,
  durationMs: 0,
});

const strategyContext = () => ({
  dimConfig: { id: 'architecture', label: 'Architecture' },
  projectInfo: { name: 'FixtureProject', lang: 'typescript', fileCount: 2 },
  existingRecipes: RECIPE_IDS.map((id) => ({ id, title: `Recipe ${id}`, trigger: `@${id}` })),
  dimensionId: 'architecture',
  dimensionLabel: 'Architecture',
  projectOverview: { primaryLang: 'typescript', fileCount: 2, modules: [] },
});

function evolutionStages() {
  return new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
    params: { needsCandidates: true, hasExistingRecipes: true, prescreenDone: false },
    context: {},
  });
}

/** 只替代模型循环：每次调用按顺序返回一段阶段结果，并记录收到的阶段提示。 */
async function runPipeline(stageResults: Array<{ reply: string; toolCalls: unknown[] }>) {
  const prompts: string[] = [];
  const reactLoop = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    const next = stageResults[prompts.length - 1] ?? { reply: '', toolCalls: [] };
    return { ...next, tokenUsage: { input: 1, output: 1 }, iterations: 1 };
  });
  const strategy = new PipelineStrategy({
    stages: evolutionStages() as ConstructorParameters<typeof PipelineStrategy>[0]['stages'],
  });
  const runtime = {
    id: 'evolution-handoff-fixture',
    logger: { info: vi.fn() },
    reactLoop,
  } as unknown as Parameters<PipelineStrategy['execute']>[0];
  const result = await strategy.execute(runtime, new AgentMessage({ content: 'generate' }), {
    strategyContext: strategyContext(),
  });
  return { prompts, result };
}

describe('generateDimensionPipeline evolution → analyze handoff', () => {
  it('tells the analyst what the evolution stage actually decided', async () => {
    const { prompts, result } = await runPipeline([
      {
        reply: 'evolution decisions submitted',
        toolCalls: [
          manage('recipe-1', 'evolve', { outcome: 'proposal-created' }),
          manage('recipe-2', 'deprecate', { outcome: 'immediately-executed' }),
          manage('recipe-3', 'skip_evolution', { outcome: 'verified' }),
        ],
      },
      // analyze 返回空回复 → quality_gate 判 degrade，管线在分析提示生成之后收束。
      { reply: '', toolCalls: [] },
    ]);

    expect(result.phases.evolution_gate).toMatchObject({ pass: true, action: 'pass' });
    expect(prompts).toHaveLength(2);
    const analystPrompt = prompts[1];
    expect(analystPrompt).toContain('Evolution Agent 已审查本维度 3 个现有 Recipe');
    expect(analystPrompt).toContain('- 进化: 1 个');
    expect(analystPrompt).toContain('- 废弃: 1 个');
    expect(analystPrompt).toContain('- 跳过: 1 个');
  });

  it('counts decisions across evolve retries, not only the last attempt', async () => {
    const { prompts, result } = await runPipeline([
      // 第一轮只决策了 1 个 → 进化门 retry。
      {
        reply: 'partial',
        toolCalls: [manage('recipe-1', 'evolve', { outcome: 'proposal-created' })],
      },
      // 补写轮决策剩余 2 个；阶段结果只保留最后一次尝试，计数必须来自累计回执。
      {
        reply: 'completed',
        toolCalls: [
          manage('recipe-2', 'skip_evolution', { outcome: 'verified' }),
          manage('recipe-3', 'skip_evolution', { outcome: 'verified' }),
        ],
      },
      { reply: '', toolCalls: [] },
    ]);

    expect(result.phases.evolution_gate).toMatchObject({ pass: true, action: 'pass' });
    expect(prompts).toHaveLength(3);
    // 补写轮走进化阶段自己的 retry 提示，仍能拿到待补 ID。
    expect(prompts[1]).toContain('- recipe-2');
    expect(prompts[1]).toContain('- recipe-3');
    expect(prompts[1]).not.toContain('- recipe-1');
    const analystPrompt = prompts[2];
    expect(analystPrompt).toContain('- 进化: 1 个');
    expect(analystPrompt).toContain('- 废弃: 0 个');
    expect(analystPrompt).toContain('- 跳过: 2 个');
  });

  it('omits the evolution section when no evolution stage ran', async () => {
    const prompts: string[] = [];
    const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
      params: { needsCandidates: true },
      context: {},
    });
    const strategy = new PipelineStrategy({
      stages: stages as ConstructorParameters<typeof PipelineStrategy>[0]['stages'],
    });
    const runtime = {
      id: 'no-evolution-fixture',
      logger: { info: vi.fn() },
      reactLoop: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return { reply: '', toolCalls: [], tokenUsage: { input: 1, output: 1 }, iterations: 1 };
      }),
    } as unknown as Parameters<PipelineStrategy['execute']>[0];
    await strategy.execute(runtime, new AgentMessage({ content: 'generate' }), {
      strategyContext: strategyContext(),
    });

    expect(prompts[0]).not.toContain('Evolution 结果');
  });
});

describe('evolution gate decision breakdown', () => {
  const context = { existingRecipes: RECIPE_IDS.map((id) => ({ id })) };

  it('reports per-recipe outcomes that add up to the processed count', () => {
    const calls = [
      manage('recipe-1', 'evolve', { outcome: 'proposal-created' }),
      manage('recipe-2', 'deprecate', { status: 'deprecated' }),
      manage('recipe-3', 'skip_evolution', { outcome: 'verified' }),
    ];
    expect(evolutionGateEvaluator({ toolCalls: calls }, null, context)).toMatchObject({
      action: 'pass',
      artifact: {
        processed: 3,
        totalRecipes: 3,
        pendingIds: [],
        evolved: 1,
        deprecated: 1,
        skipped: 1,
      },
    });
  });

  it('counts each recipe once and keeps a mutation over a later verification', () => {
    const calls = [
      manage('recipe-1', 'skip_evolution', { outcome: 'verified' }),
      manage('recipe-1', 'skip_evolution', { outcome: 'verified' }),
      // 先提案后又 skip：提案已经落库，不能被后来的「仍然有效」盖掉。
      manage('recipe-2', 'evolve', { outcome: 'proposal-created' }),
      manage('recipe-2', 'skip_evolution', { outcome: 'verified' }),
      manage('unrelated', 'deprecate', { status: 'deprecated' }),
      manage('recipe-3', 'evolve', { error: 'fixture failure' }),
    ];
    expect(evolutionGateEvaluator({ toolCalls: calls }, null, context)).toMatchObject({
      action: 'retry',
      artifact: {
        processed: 2,
        totalRecipes: 3,
        pendingIds: ['recipe-3'],
        evolved: 1,
        deprecated: 0,
        skipped: 1,
      },
    });
  });

  it('counts a persisted superseding submission as an evolved recipe', () => {
    const calls = [
      {
        tool: 'knowledge',
        args: { action: 'submit', params: { supersedes: 'recipe-1' } },
        result: { status: 'created', id: 'new-candidate', lifecycle: 'staging' },
        durationMs: 0,
      },
    ];
    expect(
      evolutionGateEvaluator({ toolCalls: calls }, null, { existingRecipes: [{ id: 'recipe-1' }] })
    ).toMatchObject({
      action: 'pass',
      artifact: { processed: 1, evolved: 1, deprecated: 0, skipped: 0 },
    });
  });
});
