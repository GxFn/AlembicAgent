/**
 * P0-4(挖掘质量升级)：degrade 一等化 — 管线结局 outcome + abandonedModules 聚合。
 *
 * 背景：弱维度被质量门 degrade 后此前静默产 0 候选(只留日志)，父 run/评估 harness 拿不到
 * "哪个单元、哪个门、什么原因被放弃"。本测试锁定三段新契约：
 *   1) PipelineStrategy 在 phases._pipelineOutcome 投影 {outcome, stage, action, reason}；
 *   2) runtime 上的 knowledge.submit 修复层计数(_submitRepairStats)随 outcome 投影(submitRepairs)；
 *   3) fan-out merger 把 abandoned child 聚合为父结果 phases.abandonedModules(一等字段)。
 */
import { describe, expect, it } from 'vitest';
import { runModuleMining } from '../src/agent/runs/module-mining/ScopedModuleMiningAgentRun.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import type {
  AgentRuntimeBuildOptions,
  AgentRuntimeLike,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import { AgentService } from '../src/agent/service/AgentService.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

/** 最小 PipelineRuntime：只提供 reactLoop(策略对 runtime 的唯一硬依赖)。 */
function createFakeRuntime(replies: string[] = ['stage output long enough to be a reply']) {
  const calls: string[] = [];
  let cursor = 0;
  return {
    calls,
    runtime: {
      id: 'fake-runtime',
      async reactLoop(prompt: string) {
        calls.push(prompt);
        const reply = replies[Math.min(cursor, replies.length - 1)];
        cursor += 1;
        return {
          reply,
          toolCalls: [],
          tokenUsage: { input: 10, output: 10 },
          iterations: 1,
        };
      },
    },
  };
}

function pipelineOutcome(result: { phases?: Record<string, unknown> }) {
  return (result.phases as Record<string, unknown>)._pipelineOutcome as Record<string, unknown>;
}

describe('PipelineStrategy — 管线结局一等化(_pipelineOutcome)', () => {
  it('gate degrade → outcome=abandoned 携带 stage/action/reason，且下游执行阶段被跳过', async () => {
    const { runtime, calls } = createFakeRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          gate: {
            evaluator: () => ({
              action: 'degrade',
              pass: false,
              reason: 'quality below hard threshold',
            }),
          },
        },
        { name: 'produce' },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine module' }));

    expect(result.degraded).toBe(true);
    expect(result.outcome).toBe('abandoned');
    expect(pipelineOutcome(result)).toMatchObject({
      outcome: 'abandoned',
      stage: 'quality_gate',
      action: 'degrade',
      reason: 'quality below hard threshold',
    });
    // produce 必须被跳过：只有 analyze 一次 reactLoop。
    expect(calls).toHaveLength(1);
  });

  it('record_repair 救不回 → degraded_no_findings 同样进入一等结局(第二个降级点)', async () => {
    const { runtime } = createFakeRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          gate: {
            // 始终判 record_repair：补写一轮后再评仍 record_repair → 策略内部合成 degraded_no_findings。
            evaluator: () => ({
              action: 'record_repair',
              pass: false,
              reason: 'no validated findings',
            }),
            maxRecordRepairRetries: 1,
          },
        },
        { name: 'produce' },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine module' }));

    expect(result.outcome).toBe('abandoned');
    expect(pipelineOutcome(result)).toMatchObject({
      outcome: 'abandoned',
      stage: 'quality_gate',
      action: 'degraded_no_findings',
    });
  });

  it('gate pass → outcome=completed，无 abandon 字段', async () => {
    const { runtime, calls } = createFakeRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        { name: 'quality_gate', gate: { evaluator: () => ({ action: 'pass', pass: true }) } },
        { name: 'produce' },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine module' }));

    expect(result.degraded).toBe(false);
    expect(result.outcome).toBe('completed');
    expect(pipelineOutcome(result)).toEqual({ outcome: 'completed' });
    expect(calls).toHaveLength(2); // analyze + produce
  });

  it('runtime 上的 _submitRepairStats 投影为 submitRepairs(repair-hit-rate 观测面)', async () => {
    const { runtime } = createFakeRuntime();
    (runtime as unknown as Record<string, unknown>)._submitRepairStats = {
      core_code_backfilled: 2,
      style_waiver: 1,
      // 形状防御：非正数不投影。
      bogus: 0,
    };
    const strategy = new PipelineStrategy({ stages: [{ name: 'produce' }] });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'submit' }));

    expect(pipelineOutcome(result)).toEqual({
      outcome: 'completed',
      submitRepairs: { core_code_backfilled: 2, style_waiver: 1 },
    });
  });
});

describe('AgentRunCoordinator merger — abandonedModules 一等聚合', () => {
  type OutcomeByModule = Record<string, Record<string, unknown> | undefined>;

  /** stub runtimeBuilder：child execute 按 moduleId 返回带/不带 _pipelineOutcome 的 phases。 */
  function createService(outcomes: OutcomeByModule) {
    return new AgentService({
      runtimeBuilder: {
        build(
          profile: CompiledAgentProfile,
          _options?: AgentRuntimeBuildOptions
        ): AgentRuntimeLike {
          return {
            id: `runtime:${profile.id}`,
            async execute(message) {
              const moduleId = String(message.metadata?.moduleId ?? 'unknown');
              const outcome = outcomes[moduleId];
              return {
                reply: `mined:${moduleId}`,
                phases: { moduleId, ...(outcome ? { _pipelineOutcome: outcome } : {}) },
                tokenUsage: { input: 1, output: 1 },
                iterations: 1,
                durationMs: 1,
              };
            },
          };
        },
      },
    });
  }

  const modules = [
    { moduleId: 'module-ok', moduleName: 'OK', ownedFiles: ['src/ok.ts'] },
    { moduleId: 'module-weak', moduleName: 'Weak', ownedFiles: ['src/weak.ts'] },
  ];

  it('abandoned child 聚合进父结果 phases.abandonedModules(含 stage/action/reason)', async () => {
    const result = await runModuleMining({
      agentService: createService({
        'module-ok': { outcome: 'completed' },
        'module-weak': {
          outcome: 'abandoned',
          stage: 'quality_gate',
          action: 'degraded_no_findings',
          reason: 'no validated findings',
        },
      }),
      modules,
      projectFacts: { project: 'abandoned-aggregation' },
    });

    const phases = result.phases as Record<string, unknown>;
    expect(phases.abandonedModules).toEqual([
      {
        unitId: 'module-weak',
        stage: 'quality_gate',
        action: 'degraded_no_findings',
        reason: 'no validated findings',
      },
    ]);
  });

  it('无 abandoned child 时不产生 abandonedModules 字段(加性扩展，不噪)', async () => {
    const result = await runModuleMining({
      agentService: createService({
        'module-ok': { outcome: 'completed' },
        'module-weak': { outcome: 'completed' },
      }),
      modules,
      projectFacts: { project: 'all-completed' },
    });

    const phases = result.phases as Record<string, unknown>;
    expect(phases.abandonedModules).toBeUndefined();
    expect(Object.keys(phases.moduleResults as Record<string, unknown>)).toEqual([
      'module-ok',
      'module-weak',
    ]);
  });
});
