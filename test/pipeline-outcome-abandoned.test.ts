/**
 * P0-4(挖掘质量升级)：degrade 一等化 — 管线结局 outcome + abandonedModules 聚合。
 *
 * 背景：弱维度被质量门 degrade 后此前静默产 0 候选(只留日志)，父 run/评估 harness 拿不到
 * "哪个单元、哪个门、什么原因被放弃"。本测试锁定三段新契约：
 *   1) PipelineStrategy 在 phases._pipelineOutcome 投影 {outcome, stage, action, reason}；
 *   2) sharedState._sessionCounters 盒里的 submit 修复层计数随 outcome 投影(submitRepairs)——
 *      宿主必须是 sharedState 嵌套盒而非 runtime：handler 拿到的 ctx.runtime 是
 *      ToolExecutionPipeline 每次调用现造的一次性投影(门0 真跑实测假零的根因)；
 *   3) fan-out merger 把 abandoned child 聚合为父结果 phases.abandonedModules(一等字段)。
 */
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { runModuleMining } from '../src/agent/runs/module-mining/ScopedModuleMiningAgentRun.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
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
  it('returns the latest main-stage reply after rewrite falls back to analysis retry', async () => {
    const { runtime } = createFakeRuntime([
      'initial analysis',
      'old rewritten analysis',
      'fresh analysis',
    ]);
    const evaluator = vi
      .fn()
      .mockReturnValueOnce({
        action: 'summary_rewrite',
        pass: false,
        artifact: { findings: [], referencedFiles: [] },
      })
      .mockReturnValueOnce({ action: 'analysis_retry', pass: false })
      .mockReturnValue({ action: 'pass', pass: true });
    const result = await new PipelineStrategy({
      stages: [{ name: 'analyze' }, { name: 'quality_gate', gate: { evaluator, maxRetries: 1 } }],
    }).execute(runtime, new AgentMessage({ content: 'analyze' }));
    expect(evaluator).toHaveBeenCalledTimes(3);
    expect(result.phases.analyze).toMatchObject({ reply: 'fresh analysis' });
    expect(result.reply).toBe('fresh analysis');
  });
  it('counts the cost of a returned timed-out attempt before successful fast retry', async () => {
    const { runtime } = createFakeRuntime();
    runtime.reactLoop = vi
      .fn()
      .mockResolvedValueOnce({
        reply: '',
        toolCalls: [],
        tokenUsage: { input: 50, output: 10 },
        iterations: 2,
        timedOut: true,
      })
      .mockResolvedValue({
        reply: 'recovered',
        toolCalls: [],
        tokenUsage: { input: 7, output: 3 },
        iterations: 1,
      });
    const result = await new PipelineStrategy({
      stages: [{ name: 'analyze', retryBudget: { maxIterations: 1 } }],
    }).execute(runtime, new AgentMessage({ content: 'analyze' }));
    expect(runtime.reactLoop).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe('recovered');
    expect(result.iterations).toBe(3);
    expect(result.tokenUsage).toEqual({ input: 57, output: 13 });
  });
  it.each([
    'before',
    'during',
  ])('stops stages and gates when aborted %s execution', async (when) => {
    const controller = new AbortController();
    const { runtime, calls } = createFakeRuntime();
    const original = runtime.reactLoop;
    runtime.reactLoop = async (prompt) => {
      const result = await original(prompt);
      controller.abort();
      return result;
    };
    let gateCalls = 0;
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          gate: {
            evaluator: () => {
              gateCalls++;
              return { action: 'pass', pass: true };
            },
          },
        },
        { name: 'produce' },
      ],
    });
    if (when === 'before') {
      controller.abort();
    }
    const result = await strategy.execute(
      runtime,
      new AgentMessage({ content: 'cancelled work' }),
      { abortSignal: controller.signal }
    );
    expect(calls).toHaveLength(when === 'before' ? 0 : 1);
    expect(gateCalls).toBe(0);
    expect(result.outcome).toBe('aborted');
    expect(result.diagnostics.efficiency?.cancelReason).toBe('abort_signal');
  });
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

  it('degrade 是终态：后续阶段无论带什么标记都不再执行', async () => {
    const { runtime, calls } = createFakeRuntime();
    const laterGate = vi.fn(() => ({ action: 'pass', pass: true }));
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          gate: { evaluator: () => ({ action: 'degrade', pass: false, reason: 'too weak' }) },
        },
        // 降级后管线直接结束，后续执行阶段与门都不再运行；这里钉住这一终态语义。
        { name: 'produce' },
        { name: 'rejection_gate', gate: { evaluator: laterGate } },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine module' }));

    expect(result.outcome).toBe('abandoned');
    expect(calls).toHaveLength(1);
    expect(laterGate).not.toHaveBeenCalled();
    expect(result.phases.produce).toBeUndefined();
    expect(result.phases.rejection_gate).toBeUndefined();
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

  it('sharedState._sessionCounters 盒里的修复计数投影为 submitRepairs(repair-hit-rate 观测面)', async () => {
    const { runtime } = createFakeRuntime();
    const sharedState: Record<string, unknown> = {
      _sessionCounters: {
        submitRepairStats: {
          core_code_backfilled: 2,
          style_waiver: 1,
          // 形状防御：非正数不投影。
          bogus: 0,
        },
      },
    };
    const strategy = new PipelineStrategy({ stages: [{ name: 'produce' }] });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'submit' }), {
      strategyContext: { sharedState },
    });

    expect(pipelineOutcome(result)).toEqual({
      outcome: 'completed',
      submitRepairs: { core_code_backfilled: 2, style_waiver: 1 },
    });
  });

  it('execute 入口预建计数盒；运行中经"每调用一次性 runtime 投影"写入的计数被收尾投影读到', async () => {
    // 模拟 handler 真实数据流：ToolExecutionPipeline 每次工具调用现造投影对象
    // {sharedState: loopCtx.sharedState}——写在投影对象自身的字段即弃，写进
    // sharedState._sessionCounters 嵌套盒才跨调用存活(本测试锁定该契约)。
    const sharedState: Record<string, unknown> = {};
    const runtime = {
      id: 'fake-runtime',
      async reactLoop() {
        const perCallProjection: Record<string, unknown> = { sharedState };
        const shared = perCallProjection.sharedState as Record<string, unknown>;
        const box = shared._sessionCounters as Record<string, unknown>;
        const stats = (box.submitRepairStats as Record<string, number> | undefined) ?? {};
        stats.evidence_sanitized = (Number(stats.evidence_sanitized) || 0) + 1;
        box.submitRepairStats = stats;
        return {
          reply: 'stage output long enough to be a reply',
          toolCalls: [],
          tokenUsage: { input: 10, output: 10 },
          iterations: 1,
        };
      },
    };
    const strategy = new PipelineStrategy({ stages: [{ name: 'analyze' }, { name: 'produce' }] });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'submit' }), {
      strategyContext: { sharedState },
    });

    // 两个阶段各 bump 一次 → 累计 2(跨调用单调累计,不是每调用归零)。
    expect(pipelineOutcome(result)).toEqual({
      outcome: 'completed',
      submitRepairs: { evidence_sanitized: 2 },
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

// ─── P1-A F2：第三种静默归零形态 retry_exhausted 一等化 ───
describe('PipelineStrategy — retry 耗尽的一等结局(F2)', () => {
  it('analysis_retry 耗尽 → outcome=abandoned(action=retry_exhausted)，degraded 保持 false', async () => {
    const { runtime } = createFakeRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          gate: {
            evaluator: () => ({
              action: 'analysis_retry',
              pass: false,
              reason: 'score below threshold',
            }),
            maxRetries: 1,
          },
        },
        { name: 'produce' },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine module' }));

    // degraded 布尔语义不变(retry 耗尽不算降级)，但结局如实为放弃。
    expect(result.degraded).toBe(false);
    expect(result.outcome).toBe('abandoned');
    expect(pipelineOutcome(result)).toMatchObject({
      outcome: 'abandoned',
      stage: 'quality_gate',
      action: 'retry_exhausted',
      reason: 'score below threshold',
    });
  });
});

// ─── I35(L5-P32)：门耗尽、未知动作终止下游、评估器异常的可定位诊断 ───
// 背景：#processGate 的重试耗尽分支与非通过兜底分支此前只写 ctx.retryExhausted/abandonInfo
// 后 'break'，没有日志、diagnostics.warn 或事件；评估器抛错/返回非对象时直接 throw，
// 不带门名与源阶段。宿主只读 diagnostics/phases 时看不到"为什么 analyze/produce 没跑"。
// 本组测试锁定三类 warn 诊断 + warn 日志，同时钉住 gateFailures 语义不变(不复用
// recordGateFailure，宿主与 l4MemoryPackage 都读它的条数)。
describe('PipelineStrategy — 门耗尽 / 未知动作 / 评估异常的诊断(I35)', () => {
  type Warning = { code: string; stage?: string; message: string };

  function warningsOf(diagnostics: { warnings?: unknown[] } | undefined): Warning[] {
    return (diagnostics?.warnings ?? []) as Warning[];
  }

  function spyWarnLog() {
    return vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('进化门 8 次重试后仍有待决 → warnings 含 pipeline_gate_retry_exhausted(stage、次数)，gateFailures 语义不变', async () => {
    const warnLog = spyWarnLog();
    const { runtime, calls } = createFakeRuntime(['no decisions submitted']);
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'evolve' },
        {
          name: 'evolution_gate',
          gate: {
            // 模拟 evolutionGateEvaluator：仍有未决 Recipe 时一直返回 'retry'。
            evaluator: () => ({ action: 'retry', pass: false, reason: 'pending recipes remain' }),
            maxRetries: 8,
          },
        },
        { name: 'analyze' },
        { name: 'produce' },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'evolve' }));

    // 既有语义不动：1 次首跑 + 8 次重试 = 9 次 evolve；下游 analyze/produce 被跳过。
    expect(calls).toHaveLength(9);
    expect(result.phases.analyze).toBeUndefined();
    expect(result.phases.produce).toBeUndefined();
    expect(result.outcome).toBe('abandoned');
    expect(result.degraded).toBe(false);
    expect(pipelineOutcome(result)).toMatchObject({
      stage: 'evolution_gate',
      action: 'retry_exhausted',
    });
    // gateFailures 仍是 9 条原始 'retry'：不新增 retry_exhausted 条目(宿主读取面不变)。
    expect(result.diagnostics.gateFailures).toHaveLength(9);
    expect(result.diagnostics.gateFailures.every((g) => g.action === 'retry')).toBe(true);

    // 新增：耗尽事实进入 warnings，并带阶段、次数、上限与是否跳过下游。
    const exhausted = warningsOf(result.diagnostics).filter(
      (w) => w.code === 'pipeline_gate_retry_exhausted'
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].stage).toBe('evolution_gate');
    expect(exhausted[0].message).toContain('attempts=9');
    expect(exhausted[0].message).toContain('maxRetries=8');
    expect(exhausted[0].message).toMatch(/downstream[^;]*skipped/);
    expect(exhausted[0].message).toContain('pending recipes remain');
    // warn 日志同样可定位(含门名与耗尽字样)。
    expect(
      warnLog.mock.calls.some(
        (c) => /retry.*exhausted/i.test(String(c[0])) && String(c[0]).includes('evolution_gate')
      )
    ).toBe(true);
  });

  it('retry 耗尽但 skipOnFail=false → 仍写 pipeline_gate_retry_exhausted，message 说明下游继续执行', async () => {
    spyWarnLog();
    const { runtime, calls } = createFakeRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          gate: {
            evaluator: () => ({ action: 'analysis_retry', pass: false, reason: 'weak' }),
            maxRetries: 1,
          },
          skipOnFail: false,
        },
        { name: 'produce' },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine' }));

    // analyze ×2(首跑+1 次重试) + produce ×1：显式 skipOnFail=false 时下游继续。
    expect(calls).toHaveLength(3);
    expect(result.phases.produce).toBeDefined();
    expect(result.outcome).toBe('abandoned');
    const exhausted = warningsOf(result.diagnostics).filter(
      (w) => w.code === 'pipeline_gate_retry_exhausted'
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].stage).toBe('quality_gate');
    expect(exhausted[0].message).toContain('attempts=2');
    expect(exhausted[0].message).toContain('maxRetries=1');
    expect(exhausted[0].message).toMatch(/downstream[^;]*continue/);
    expect(exhausted[0].message).toContain('skipOnFail=false');
  });

  it('自定义门返回拼错动作 "analysis-retry" → 下游被终止且 warnings 含 pipeline_gate_non_pass_terminated', async () => {
    const warnLog = spyWarnLog();
    const { runtime, calls } = createFakeRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'g',
          gate: {
            evaluator: () => ({ action: 'analysis-retry', pass: false, reason: 'typo' }),
          },
        },
        { name: 'produce' },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'x' }));

    // 既有语义不动：原始动作连同 reason 仍只在 gateFailures 里记 1 条，produce 被跳过。
    expect(calls).toHaveLength(1);
    expect(result.phases.produce).toBeUndefined();
    expect(result.diagnostics.gateFailures).toEqual([
      { stage: 'g', action: 'analysis-retry', reason: 'typo' },
    ]);
    expect(pipelineOutcome(result)).toMatchObject({
      outcome: 'abandoned',
      stage: 'g',
      action: 'analysis-retry',
    });

    // 新增：「已终止下游」这一事实进入 warnings 并打 warn 日志。
    const terminated = warningsOf(result.diagnostics).filter(
      (w) => w.code === 'pipeline_gate_non_pass_terminated'
    );
    expect(terminated).toHaveLength(1);
    expect(terminated[0].stage).toBe('g');
    expect(terminated[0].message).toContain('"analysis-retry"');
    expect(terminated[0].message).toMatch(/downstream[^;]*skipped/);
    expect(terminated[0].message).toContain('typo');
    expect(
      warnLog.mock.calls.some(
        (c) => String(c[0]).includes('"analysis-retry"') && String(c[0]).includes('"g"')
      )
    ).toBe(true);
  });

  it('非通过动作但 skipOnFail=false → warnings 仍含 pipeline_gate_non_pass_terminated，message 说明下游继续', async () => {
    spyWarnLog();
    const { runtime, calls } = createFakeRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'rejection_gate',
          gate: { evaluator: () => ({ action: 'reject', pass: false, reason: 'rejected' }) },
          skipOnFail: false,
        },
        { name: 'cleanup' },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'x' }));

    expect(calls).toHaveLength(2);
    expect(result.phases.cleanup).toBeDefined();
    const terminated = warningsOf(result.diagnostics).filter(
      (w) => w.code === 'pipeline_gate_non_pass_terminated'
    );
    expect(terminated).toHaveLength(1);
    expect(terminated[0].stage).toBe('rejection_gate');
    expect(terminated[0].message).toContain('"reject"');
    expect(terminated[0].message).toMatch(/downstream[^;]*continue/);
    expect(terminated[0].message).toContain('skipOnFail=false');
  });

  it('评估器抛错 → 抛出前写 pipeline_gate_evaluation_failed(门名、源阶段)，原错误仍原样抛出', async () => {
    const warnLog = spyWarnLog();
    const { runtime } = createFakeRuntime();
    const diagnostics = new DiagnosticsCollector();
    const boom = new Error('deep review crashed');
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          gate: {
            evaluator: () => {
              throw boom;
            },
          },
        },
        { name: 'produce' },
      ],
    });

    // 错误仍然抛出(同一实例，宿主的 instanceof/name/message 归类不受影响)。
    await expect(
      strategy.execute(runtime, new AgentMessage({ content: 'x' }), { diagnostics })
    ).rejects.toBe(boom);

    // 共享的 collector 在抛出前已拿到门级诊断：门名 + 源阶段 + 原始错误信息。
    const failed = warningsOf(diagnostics.toJSON()).filter(
      (w) => w.code === 'pipeline_gate_evaluation_failed'
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].stage).toBe('quality_gate');
    expect(failed[0].message).toContain('"analyze"');
    expect(failed[0].message).toContain('deep review crashed');
    // 不复用 recordGateFailure：gateFailures 不因评估异常新增条目。
    expect(diagnostics.toJSON().gateFailures).toEqual([]);
    expect(
      warnLog.mock.calls.some(
        (c) => String(c[0]).includes('"quality_gate"') && String(c[0]).includes('"analyze"')
      )
    ).toBe(true);
  });

  it('评估器返回非对象 → 同样写 pipeline_gate_evaluation_failed 并抛出 Error', async () => {
    spyWarnLog();
    const { runtime } = createFakeRuntime();
    const diagnostics = new DiagnosticsCollector();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          gate: {
            // 故意返回 null：评估器契约要求对象，这里走"无决策"分支。
            evaluator: () => null as unknown as { action: string; pass: boolean },
          },
        },
      ],
    });

    await expect(
      strategy.execute(runtime, new AgentMessage({ content: 'x' }), { diagnostics })
    ).rejects.toThrow(/no decision/);

    const failed = warningsOf(diagnostics.toJSON()).filter(
      (w) => w.code === 'pipeline_gate_evaluation_failed'
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].stage).toBe('quality_gate');
    expect(failed[0].message).toContain('"analyze"');
    expect(failed[0].message).toMatch(/no decision/);
  });
});

// ─── I04(L5-P29)：produce 提交上限——rescan createBudget 是硬上限，gate 重试沿用 retryBudget ───
// 背景：AgentStageFactoryRegistry 在增量重扫时把 produce 的 maxSubmits/softSubmitLimit 写成
// createBudget(Core 简报、insightProducer 文案与宿主 gapLimit 都声明它是硬配额)，但
// PipelineStrategy 的 H3 覆盖率放大不区分来源：createBudget=2、findings=10 时被放大成
// maxSubmits=14/targetSubmits=10，tracker 到第 10 次提交才离开 PRODUCE；rejection_gate 判 retry
// 时声明为"缩减预算"的 retryBudget(300s)同样被放大到 1800s 并注入 targetSubmits。
// 本组测试锁定：Factory 写 hardSubmitCap；放大按 min(findings, cap) 封顶；重试轮不放大；
// bootstrap 冷启动(无 cap)保留放大；每个分叉都有可定位日志。
describe('PipelineStrategy — produce 覆盖率预算：rescan 硬上限与重试预算不放大(I04)', () => {
  type ProduceCapture = {
    budget: Record<string, unknown> | undefined;
    tracker: ExplorationTracker | null;
  };

  /** 捕获每次 produce 阶段 reactLoop 收到的 budgetOverride 与 tracker。 */
  function createCapturingRuntime() {
    const produceCalls: ProduceCapture[] = [];
    const runtime = {
      id: 'capturing-runtime',
      async reactLoop(_prompt: string, opts?: Record<string, unknown>) {
        const phase = (opts?.context as Record<string, unknown> | undefined)?.pipelinePhase;
        if (phase === 'produce') {
          produceCalls.push({
            budget: opts?.budgetOverride as Record<string, unknown> | undefined,
            tracker: (opts?.tracker as ExplorationTracker | null | undefined) ?? null,
          });
        }
        // 带一条工具调用：既不是 timedOut 也不是零工具，避免误入 fast-retry 分支。
        return {
          reply: 'stage output long enough to be a reply',
          toolCalls: [{ tool: 'knowledge' }],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        };
      },
    };
    return { runtime, produceCalls };
  }

  function findingsOf(count: number) {
    return Array.from({ length: count }, (_, i) => ({ finding: `f${i}`, evidenceRefs: [] }));
  }

  function qualityGateWithFindings(count: number) {
    return {
      name: 'quality_gate',
      gate: {
        evaluator: () => ({
          action: 'pass',
          pass: true,
          artifact: { findings: findingsOf(count) },
        }),
      },
    };
  }

  /** 模拟 producer 每轮提交 1 个已持久化候选，返回离开 PRODUCE 的提交序号(或 null)。 */
  function submitUntilLeavingProduce(tracker: ExplorationTracker, maxRounds: number) {
    for (let i = 1; i <= maxRounds; i++) {
      tracker.tick();
      tracker.recordToolCall(
        'knowledge',
        { action: 'submit', title: `candidate-${i}` },
        { status: 'created', id: `cand-${i}`, lifecycle: 'pending' }
      );
      tracker.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });
      if (tracker.phase !== 'PRODUCE') {
        return i;
      }
    }
    return null;
  }

  function spyInfoLog() {
    return vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
  }

  function buildRescanProduceStage(createBudget: number) {
    const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
      params: { needsCandidates: true, hasExistingRecipes: false, prescreenDone: false },
      context: { strategyContext: { rescanContext: { gap: createBudget, createBudget } } },
    }) as Array<Record<string, unknown>>;
    const produce = stages.find((stage) => stage.name === 'produce');
    if (!produce) {
      throw new Error('factory did not emit a produce stage');
    }
    // preset promptBuilder/retryPromptBuilder 依赖 dimConfig/projectInfo 等真机上下文；本测试只关心
    // 预算，不渲染 prompt。
    return {
      ...produce,
      promptBuilder: () => 'produce',
      retryPromptBuilder: () => 'retry produce',
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Factory：rescanContext.createBudget=2 → produce.budget 写入 hardSubmitCap=2(与 maxSubmits/softSubmitLimit 同值)', () => {
    const produce = buildRescanProduceStage(2);
    expect(produce.budget).toMatchObject({ maxSubmits: 2, softSubmitLimit: 2, hardSubmitCap: 2 });
  });

  it('Factory：无 rescanContext(bootstrap 冷启动) → produce.budget 不带 hardSubmitCap', () => {
    const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
      params: { needsCandidates: true, hasExistingRecipes: false, prescreenDone: false },
      context: { strategyContext: {} },
    }) as Array<Record<string, unknown>>;
    const produce = stages.find((stage) => stage.name === 'produce') as Record<string, unknown>;
    expect(produce.budget).toMatchObject({ maxSubmits: 10, softSubmitLimit: 10 });
    expect((produce.budget as Record<string, unknown>).hardSubmitCap).toBeUndefined();
  });

  it('rescan 硬上限：createBudget=2 + 10 条 findings → maxSubmits=2/targetSubmits=2，第 2 次提交后进入 SUMMARIZE 且完成文本被接受', async () => {
    const infoLog = spyInfoLog();
    const { runtime, produceCalls } = createCapturingRuntime();
    const produce = buildRescanProduceStage(2);
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze', promptBuilder: () => 'analyze', budget: { maxIterations: 1 } },
        qualityGateWithFindings(10),
        produce,
      ],
    });
    // 预置一个 analyst tracker：produce 阶段据此按有效预算重建 producer tracker。
    const seedTracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 4 }
    );

    await strategy.execute(runtime, new AgentMessage({ content: 'rescan' }), {
      strategyContext: { tracker: seedTracker, source: 'system' },
    });

    expect(produceCalls).toHaveLength(1);
    const { budget, tracker } = produceCalls[0];
    expect(budget).toMatchObject({
      maxSubmits: 2,
      targetSubmits: 2,
      softSubmitLimit: 2,
      hardSubmitCap: 2,
      // 时间只按封顶后的目标放大：2×90s 不超过原值 900s，保持原值。
      timeoutMs: 900_000,
    });
    expect(tracker).not.toBeNull();
    expect(tracker?.strategyName).toBe('producer');
    // 真实 producer tracker：第 2 次持久化提交后离开 PRODUCE(修复前要到第 10 次)。
    expect(submitUntilLeavingProduce(tracker as ExplorationTracker, 16)).toBe(2);
    // 提交 2 个后回复完成文本必须被接受，而不是继续催促提交。
    const t2 = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { ...budget }
    );
    submitUntilLeavingProduce(t2, 2);
    t2.tick();
    const textAfterTwo = t2.onTextResponse('生产完成，已提交全部候选。');
    expect(textAfterTwo.shouldContinue).toBe(false);
    expect(textAfterTwo.isFinalAnswer).toBe(true);
    // 封顶分叉留痕：日志含 findings、cap 与最终取值。
    const capLog = infoLog.mock.calls.find((c) => /capped by hardSubmitCap/.test(String(c[0])));
    expect(capLog).toBeDefined();
    expect(String(capLog?.[0])).toContain('findings=10');
    expect(String(capLog?.[0])).toContain('hardSubmitCap=2');
    expect(String(capLog?.[0])).toContain('maxSubmits=2');
    expect(String(capLog?.[0])).toContain('targetSubmits=2');
  });

  it('封顶取 min(findings, cap)：cap=3 + 1 条 findings → targetSubmits=1、maxSubmits=3', async () => {
    spyInfoLog();
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        qualityGateWithFindings(1),
        {
          name: 'produce',
          budget: {
            maxIterations: 24,
            maxSubmits: 3,
            softSubmitLimit: 3,
            hardSubmitCap: 3,
            timeoutMs: 900_000,
          },
        },
      ],
    });

    await strategy.execute(runtime, new AgentMessage({ content: 'rescan' }));

    expect(produceCalls).toHaveLength(1);
    expect(produceCalls[0].budget).toMatchObject({
      maxSubmits: 3,
      targetSubmits: 1,
      timeoutMs: 900_000,
    });
  });

  it('bootstrap 冷启动无 cap：24 条 findings 仍放大到 maxSubmits=28/targetSubmits=24，timeoutMs 封顶 1800s(H3 保持)', async () => {
    const infoLog = spyInfoLog();
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        qualityGateWithFindings(24),
        {
          name: 'produce',
          budget: { maxIterations: 24, maxSubmits: 10, softSubmitLimit: 10, timeoutMs: 900_000 },
        },
      ],
    });

    await strategy.execute(runtime, new AgentMessage({ content: 'bootstrap' }));

    expect(produceCalls).toHaveLength(1);
    expect(produceCalls[0].budget).toMatchObject({
      maxSubmits: 28,
      targetSubmits: 24,
      timeoutMs: 1_800_000,
    });
    expect(produceCalls[0].budget?.hardSubmitCap).toBeUndefined();
    const ampLog = infoLog.mock.calls.find((c) => /coverage budget amplified/.test(String(c[0])));
    expect(ampLog).toBeDefined();
    expect(String(ampLog?.[0])).toContain('findings=24');
    expect(String(ampLog?.[0])).toContain('maxSubmits=28');
    expect(String(ampLog?.[0])).toContain('targetSubmits=24');
  });

  it.each([
    ['0', 0],
    ['NaN', Number.NaN],
    ['负数', -2],
    ['字符串', '2'],
  ])('hardSubmitCap 非法(%s) → 忽略 cap 走放大，并打 warn 日志', async (_label, invalidCap) => {
    spyInfoLog();
    const warnLog = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        qualityGateWithFindings(12),
        {
          name: 'produce',
          budget: {
            maxIterations: 24,
            maxSubmits: 10,
            hardSubmitCap: invalidCap,
            timeoutMs: 900_000,
          },
        },
      ],
    });

    await strategy.execute(runtime, new AgentMessage({ content: 'x' }));

    expect(produceCalls).toHaveLength(1);
    expect(produceCalls[0].budget).toMatchObject({ maxSubmits: 16, targetSubmits: 12 });
    expect(
      warnLog.mock.calls.some(
        (c) => /invalid hardSubmitCap/.test(String(c[0])) && String(c[0]).includes('"produce"')
      )
    ).toBe(true);
  });

  it('rejection_gate 判 retry → 第二次 produce 的 budgetOverride 等于声明的 retryBudget(无 targetSubmits)，首轮仍放大', async () => {
    const infoLog = spyInfoLog();
    const { runtime, produceCalls } = createCapturingRuntime();
    const retryBudget = { maxIterations: 5, temperature: 0.3, timeoutMs: 300_000 };
    let rejectionCalls = 0;
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        qualityGateWithFindings(20),
        {
          name: 'produce',
          budget: { maxIterations: 24, maxSubmits: 10, softSubmitLimit: 10, timeoutMs: 900_000 },
          retryBudget,
          retryPromptBuilder: () => 'retry prompt',
        },
        {
          name: 'rejection_gate',
          gate: {
            maxRetries: 1,
            evaluator: () => {
              rejectionCalls++;
              return rejectionCalls === 1
                ? { action: 'retry', pass: false, reason: '3 rejections vs 0 successes' }
                : { action: 'pass', pass: true };
            },
          },
        },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'go' }));

    expect(result.outcome).toBe('completed');
    expect(produceCalls).toHaveLength(2);
    // 首轮：bootstrap 无 cap，H3 放大保持。
    expect(produceCalls[0].budget).toMatchObject({
      maxSubmits: 24,
      targetSubmits: 20,
      timeoutMs: 1_800_000,
    });
    // 重试轮：严格等于声明的 retryBudget——不放大 timeoutMs、不注入 targetSubmits/maxSubmits。
    expect(produceCalls[1].budget).toEqual(retryBudget);
    expect(produceCalls[1].budget?.targetSubmits).toBeUndefined();
    const skipLog = infoLog.mock.calls.find((c) =>
      /coverage amplification skipped/.test(String(c[0]))
    );
    expect(skipLog).toBeDefined();
    expect(String(skipLog?.[0])).toContain('retryBudget');
    expect(String(skipLog?.[0])).toContain('findings=20');
  });

  it('rejection_gate 判 retry 且阶段无 retryBudget → 重试沿用 stage.budget 原值，不注入 targetSubmits', async () => {
    spyInfoLog();
    const { runtime, produceCalls } = createCapturingRuntime();
    const stageBudget = {
      maxIterations: 24,
      maxSubmits: 10,
      softSubmitLimit: 10,
      timeoutMs: 900_000,
    };
    let rejectionCalls = 0;
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        qualityGateWithFindings(20),
        { name: 'produce', budget: stageBudget },
        {
          name: 'rejection_gate',
          gate: {
            maxRetries: 1,
            evaluator: () => {
              rejectionCalls++;
              return rejectionCalls === 1
                ? { action: 'retry', pass: false, reason: 'rejected' }
                : { action: 'pass', pass: true };
            },
          },
        },
      ],
    });

    await strategy.execute(runtime, new AgentMessage({ content: 'go' }));

    expect(produceCalls).toHaveLength(2);
    expect(produceCalls[0].budget).toMatchObject({ maxSubmits: 24, targetSubmits: 20 });
    expect(produceCalls[1].budget).toEqual(stageBudget);
  });

  it('封顶后时间只按 cap 放大：cap=12 + 24 条 findings → maxSubmits=12/targetSubmits=12、timeoutMs=1080s(无 cap 时会放大到 1800s)', async () => {
    const infoLog = spyInfoLog();
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        qualityGateWithFindings(24),
        {
          name: 'produce',
          budget: {
            maxIterations: 24,
            maxSubmits: 12,
            softSubmitLimit: 12,
            hardSubmitCap: 12,
            timeoutMs: 900_000,
          },
        },
      ],
    });

    await strategy.execute(runtime, new AgentMessage({ content: 'rescan' }));

    expect(produceCalls).toHaveLength(1);
    expect(produceCalls[0].budget).toMatchObject({
      maxSubmits: 12,
      targetSubmits: 12,
      // P-5 时间放大按封顶后的 maxSubmits(12×90s=1080s)估算，而不是按 findings+4=28 → 1800s。
      timeoutMs: 1_080_000,
    });
    const capLog = infoLog.mock.calls.find((c) => /capped by hardSubmitCap/.test(String(c[0])));
    expect(String(capLog?.[0])).toContain('hardSubmitCap=12');
    expect(String(capLog?.[0])).toContain('timeoutMs=1080000');
  });

  it('rescan + rejection_gate 判 retry：首轮按 cap=2 封顶，重试轮等于 preset retryBudget(300s/5 轮，无 targetSubmits)，skip 日志报告阶段声明的 cap', async () => {
    const infoLog = spyInfoLog();
    const { runtime, produceCalls } = createCapturingRuntime();
    const produce = buildRescanProduceStage(2);
    let rejectionCalls = 0;
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        qualityGateWithFindings(10),
        produce,
        {
          name: 'rejection_gate',
          gate: {
            maxRetries: 1,
            evaluator: () => {
              rejectionCalls++;
              return rejectionCalls === 1
                ? { action: 'retry', pass: false, reason: 'rejected' }
                : { action: 'pass', pass: true };
            },
          },
        },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'rescan' }));

    expect(result.outcome).toBe('completed');
    expect(produceCalls).toHaveLength(2);
    expect(produceCalls[0].budget).toMatchObject({
      maxSubmits: 2,
      targetSubmits: 2,
      hardSubmitCap: 2,
    });
    // 重试轮严格等于 insight preset 声明的 retryBudget(缩减预算)：不放大、不注入 targetSubmits；
    // 按决策"沿用声明的 retryBudget"，stage.budget 的 hardSubmitCap 也不补进重试预算。
    expect(produceCalls[1].budget).toEqual({
      maxIterations: 5,
      temperature: 0.3,
      timeoutMs: 300_000,
    });
    const skipLog = infoLog.mock.calls.find((c) =>
      /coverage amplification skipped/.test(String(c[0]))
    );
    expect(skipLog).toBeDefined();
    expect(String(skipLog?.[0])).toContain('reuses declared retryBudget');
    expect(String(skipLog?.[0])).toContain('stageHardSubmitCap=2');
    expect(String(skipLog?.[0])).toContain('timeoutMs=300000');
  });
});
