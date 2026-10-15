/**
 * I43(L5-P44)：运行级质量告警收敛。
 *
 * 1. AgentRuntime 在取消(运行边界 abort、策略/阶段回执自报 aborted、管线结局 aborted)或超时
 *    (策略结果自报 timedOut)时跳过 Policy.validateAfter，并记录 quality_check_skipped 诊断与日志，
 *    不再对取消占位文案或截断回执产生误导性的 quality_warning。
 * 2. insight 预设不再挂运行级 QualityGatePolicy：管线内 quality_gate 是唯一质量门；
 *    QualityGatePolicy 类本身仍保留导出，可由调用方显式注入。
 *
 * 只替换 strategy(外部执行体)，真实 AgentRuntime 的 execute 边界、状态机与诊断收集保持接线。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetPolicy,
  type Policy,
  PolicyEngine,
  QualityGatePolicy,
} from '../src/agent/policies/index.js';
import { getPreset } from '../src/agent/profiles/presets/index.js';
import { INSIGHT_PRESET } from '../src/agent/profiles/presets/insightPreset.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { AgentDiagnosticWarning } from '../src/agent/runtime/AgentRuntimeTypes.js';

afterEach(() => vi.restoreAllMocks());

type StrategyExecute = (
  runtime: unknown,
  message: unknown,
  opts: { abortSignal?: AbortSignal }
) => Promise<unknown>;

/** 严格阈值的运行级质量策略：任何短回复都会被判质量不足，便于观察是否被调用。 */
function strictQualityPolicy() {
  const policy = new QualityGatePolicy({ minEvidenceLength: 500, minFileRefs: 3, minToolCalls: 2 });
  const validateAfter = vi.spyOn(policy, 'validateAfter');
  return { policy, validateAfter };
}

function runtimeWith(execute: StrategyExecute, policies: Policy[]) {
  const runtime = new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools: vi.fn() } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    strategy: { name: 'quality-skip-fixture', execute } as never,
    policies: new PolicyEngine([
      new BudgetPolicy({ maxIterations: 2, timeoutMs: 1000 }),
      ...policies,
    ]),
    capabilities: [],
  });
  const info = vi.fn();
  const warn = vi.fn();
  runtime.logger = { info, warn, debug: vi.fn(), error: vi.fn() } as never;
  return { runtime, info, warn };
}

function codes(warnings: AgentDiagnosticWarning[] | undefined) {
  return (warnings ?? []).map((warning) => warning.code);
}

function skipWarnings(warnings: AgentDiagnosticWarning[] | undefined) {
  return (warnings ?? []).filter((warning) => warning.code === 'quality_check_skipped');
}

const partialResult = (extra: Record<string, unknown> = {}) => ({
  reply: 'partial',
  toolCalls: [],
  tokenUsage: { input: 1, output: 1 },
  iterations: 1,
  ...extra,
});

describe('AgentRuntime post-run quality check skip (I43 / L5-P44)', () => {
  it('a cancelled run skips validateAfter and produces no quality_warning', async () => {
    const parent = new AbortController();
    const { policy, validateAfter } = strictQualityPolicy();
    const { runtime, info } = runtimeWith(
      vi.fn(async () => {
        // 运行中途被宿主取消：边界会把 reply 改写为取消占位文案。
        parent.abort();
        return partialResult({ reply: 'late output' });
      }),
      [policy]
    );

    const result = await runtime.execute(new AgentMessage({ content: 'task' }), {
      abortSignal: parent.signal,
    });

    expect(result.reply).toContain('[run stopped: abort_signal]');
    expect(validateAfter).not.toHaveBeenCalled();
    expect(result.qualityWarning).toBeUndefined();
    expect(codes(result.diagnostics?.warnings)).not.toContain('quality_warning');
    expect(codes(result.diagnostics?.warnings)).toContain('runtime_aborted');
    const skips = skipWarnings(result.diagnostics?.warnings);
    expect(skips).toHaveLength(1);
    expect(skips[0].message).toContain('cancelled');
    expect(skips[0].message).toContain('runtime_abort_signal');
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('post-run quality check skipped'),
      expect.objectContaining({ reason: 'cancelled', trigger: 'runtime_abort_signal' })
    );
  });

  it('a run whose final stage receipt timed out skips validateAfter', async () => {
    const { policy, validateAfter } = strictQualityPolicy();
    const { runtime, info } = runtimeWith(
      vi.fn(async () => partialResult({ timedOut: true })),
      [policy]
    );

    const result = await runtime.execute(new AgentMessage({ content: 'task' }));

    // 超时不是取消：回复保持策略原样，只是不再对截断回执做质量判定。
    expect(result.reply).toBe('partial');
    expect(validateAfter).not.toHaveBeenCalled();
    expect(result.qualityWarning).toBeUndefined();
    expect(codes(result.diagnostics?.warnings)).not.toContain('quality_warning');
    const skips = skipWarnings(result.diagnostics?.warnings);
    expect(skips).toHaveLength(1);
    expect(skips[0].message).toContain('timed_out');
    expect(skips[0].message).toContain('result.timedOut');
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('post-run quality check skipped'),
      expect.objectContaining({ reason: 'timed_out', trigger: 'result.timedOut' })
    );
  });

  it.each([
    ['result.aborted', { aborted: true }],
    ['result.outcome', { outcome: 'aborted' }],
    ['phases._pipelineOutcome', { phases: { _pipelineOutcome: { outcome: 'aborted' } } }],
  ] as const)('a strategy-reported cancellation via %s skips validateAfter', async (trigger, extra) => {
    const { policy, validateAfter } = strictQualityPolicy();
    const { runtime } = runtimeWith(
      vi.fn(async () => partialResult(extra)),
      [policy]
    );

    const result = await runtime.execute(new AgentMessage({ content: 'task' }));

    expect(validateAfter).not.toHaveBeenCalled();
    expect(result.qualityWarning).toBeUndefined();
    expect(codes(result.diagnostics?.warnings)).not.toContain('quality_warning');
    const skips = skipWarnings(result.diagnostics?.warnings);
    expect(skips).toHaveLength(1);
    expect(skips[0].message).toContain('cancelled');
    expect(skips[0].message).toContain(trigger);
  });

  it('a completed run still evaluates validateAfter and reports quality_warning', async () => {
    const { policy, validateAfter } = strictQualityPolicy();
    const { runtime, warn } = runtimeWith(
      vi.fn(async () => partialResult({ phases: { _pipelineOutcome: { outcome: 'completed' } } })),
      [policy]
    );

    const result = await runtime.execute(new AgentMessage({ content: 'task' }));

    expect(validateAfter).toHaveBeenCalledOnce();
    expect(result.qualityWarning).toContain('分析长度不足');
    expect(codes(result.diagnostics?.warnings)).toContain('quality_warning');
    expect(skipWarnings(result.diagnostics?.warnings)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Quality check'));
  });
});

describe('insight preset run-level quality policy removal (I43 / L5-P44)', () => {
  /** 与 AgentRuntimeBuilder 同口径：preset.policies 中的工厂以 runtimeOverrides 调用，实例原样保留。 */
  function resolvePolicies(overrides: Record<string, unknown> = {}) {
    const preset = getPreset('insight', overrides);
    return (
      (preset.policies || []) as Array<Policy | ((input: Record<string, unknown>) => Policy)>
    ).map((policyOrFactory) =>
      typeof policyOrFactory === 'function' ? policyOrFactory(overrides) : policyOrFactory
    );
  }

  it('does not install a run-level QualityGatePolicy; the pipeline quality_gate is the only quality gate', () => {
    const policies = resolvePolicies();
    expect(policies.some((policy) => policy instanceof QualityGatePolicy)).toBe(false);
    const engine = new PolicyEngine(policies);
    expect(engine.get(QualityGatePolicy)).toBeNull();
    // produce 阶段的提交汇报(短、无文件引用)不再被运行级策略判为“分析长度不足”。
    expect(engine.validateAfter({ reply: '已提交 2 条知识候选。', toolCalls: [] })).toEqual({
      ok: true,
    });
    // 管线内质量门仍在。
    const stages = INSIGHT_PRESET.strategy.stages as Array<{ name: string; gate?: unknown }>;
    expect(stages.find((stage) => stage.name === 'quality_gate')?.gate).toBeTruthy();
  });

  it('keeps the budget policy and its runtime overrides', () => {
    const engine = new PolicyEngine(resolvePolicies({ maxIterations: 7, timeoutMs: 1234 }));
    expect(engine.get(BudgetPolicy)).toBeInstanceOf(BudgetPolicy);
    expect(engine.getBudget()).toMatchObject({ maxIterations: 7, timeoutMs: 1234 });
  });
});
