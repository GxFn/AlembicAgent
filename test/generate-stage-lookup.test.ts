import { afterEach, describe, expect, it } from 'vitest';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { PRESETS } from '../src/agent/profiles/presets/index.js';

/**
 * generateDimensionPipeline 按阶段名取 preset 阶段的钉子。
 *
 * 背景：阶段工厂原先用 presetStages[0..3] / evolutionPresetStages[0..1] 的下标取阶段，
 * preset 数组的顺序因此成了隐式契约——在 preset 里调整顺序或插入一个阶段，工厂会静默地
 * 把门当成执行阶段、把执行阶段当成门。现在按名取，缺阶段在装配期立即失败。
 */

type NamedStage = { name: string; gate?: unknown; promptBuilder?: unknown };

const insightStages = PRESETS.insight.strategy.stages as NamedStage[];
const evolutionStages = PRESETS.evolution.strategy.stages as NamedStage[];
const originalInsight = [...insightStages];
const originalEvolution = [...evolutionStages];

function build(params: Record<string, unknown>) {
  return new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
    params,
    context: {},
  }) as NamedStage[];
}

function describeStages(stages: NamedStage[]) {
  return stages.map((stage) => ({
    name: stage.name,
    kind: stage.gate ? 'gate' : 'exec',
    hasPrompt: typeof stage.promptBuilder === 'function',
  }));
}

describe('generateDimensionPipeline preset stage lookup', () => {
  afterEach(() => {
    // preset 是模块级共享对象；每个用例结束后恢复原顺序。
    insightStages.splice(0, insightStages.length, ...originalInsight);
    evolutionStages.splice(0, evolutionStages.length, ...originalEvolution);
  });

  it('assembles the same pipeline when preset stages are declared in another order', () => {
    const params = { needsCandidates: true, hasExistingRecipes: true, prescreenDone: false };
    const expected = describeStages(build(params));
    expect(expected).toEqual([
      { name: 'evolve', kind: 'exec', hasPrompt: true },
      { name: 'evolution_gate', kind: 'gate', hasPrompt: false },
      { name: 'analyze', kind: 'exec', hasPrompt: true },
      { name: 'quality_gate', kind: 'gate', hasPrompt: false },
      { name: 'produce', kind: 'exec', hasPrompt: true },
      { name: 'rejection_gate', kind: 'gate', hasPrompt: false },
    ]);

    insightStages.reverse();
    evolutionStages.reverse();

    expect(describeStages(build(params))).toEqual(expected);
    expect(describeStages(build({ needsCandidates: true }))).toEqual(expected.slice(2));
    expect(describeStages(build({ needsCandidates: false }))).toEqual(expected.slice(2, 3));
  });

  it('fails at assembly time when a required preset stage is missing', () => {
    const produceIndex = insightStages.findIndex((stage) => stage.name === 'produce');
    insightStages.splice(produceIndex, 1);

    expect(() => build({ needsCandidates: true })).toThrow(
      'Preset "insight" has no stage named "produce"'
    );
  });
});
