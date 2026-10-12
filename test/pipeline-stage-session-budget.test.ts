/**
 * I02（L5-P07，方案 A）：阶段会话预算 maxSessionInputTokens 统一按“阶段内消耗”计量。
 *
 * - AgentRuntime：每个 reactLoop 新建的 BudgetController 以构造时的运行级累计为基线，
 *   前序阶段（analyze）用掉的 input 不再把后续带预算阶段（record_repair）的压力推满。
 * - PipelineStrategy：analysis_retry 的预算压制与 BudgetController 同一口径——看重试目标阶段
 *   最近一次执行的阶段内 input，而不是整条管线的累计。
 */
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime, DiagnosticsCollector } from '../src/agent/runtime/index.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

afterEach(() => vi.restoreAllMocks());

describe('AgentRuntime stage session budget baseline (I02)', () => {
  it('does not carry earlier-stage input into a later stage budget on the same run', async () => {
    let nextInputTokens = 300_000;
    const chatWithTools = vi.fn(async () => ({
      text: 'stage answer',
      functionCalls: [],
      usage: { inputTokens: nextInputTokens, outputTokens: 10 },
    }));
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute: vi.fn() } as never,
      capabilities: [],
      strategy: { name: 'unused', execute: vi.fn() } as never,
    });
    const contextWindow = new ContextWindow(24_000);

    // analyze：无会话预算，用掉 30 万 input（写入运行级累计）。
    await runtime.reactLoop('analyze', {
      source: 'system',
      contextWindow,
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000 },
    });
    expect(runtime.tokenUsage.input).toBeGreaterThanOrEqual(300_000);

    // record_repair：微阶段 12k 会话预算，复用同一窗口（PipelineStrategy 会先 resetForNewStage）。
    contextWindow.resetForNewStage();
    nextInputTokens = 1_000;
    const runInputBefore = runtime.tokenUsage.input;
    await runtime.reactLoop('record repair', {
      source: 'system',
      contextWindow,
      budgetOverride: { maxIterations: 1, timeoutMs: 5_000, maxSessionInputTokens: 12_000 },
    });

    // 预检压力只反映本阶段消耗：配额保持 Normal 档，而不是被 300000/12000 钳到 Exhausted(400/2)。
    expect(contextWindow.getToolResultQuota()).toEqual({ maxChars: 6000, maxMatches: 15 });
    // 阶段内消耗仍写回运行级累计。
    expect(runtime.tokenUsage.input).toBeGreaterThan(runInputBefore);
  });
});

type RetryScenario = {
  /** 每个阶段每次执行回执里的 input token（按调用顺序取，缺省取最后一个值）。 */
  inputByStage: Record<string, Array<number | undefined>>;
  /** 门依次返回的动作；用完后返回 pass。 */
  gateActions: string[];
  maxRetries?: number;
  analyzeBudget?: number;
};

async function runRetryScenario(scenario: RetryScenario) {
  const gateActions = [...scenario.gateActions];
  const strategy = new PipelineStrategy({
    stages: [
      { name: 'scan', capabilities: [] },
      {
        name: 'analyze',
        capabilities: [],
        budget: { maxSessionInputTokens: scenario.analyzeBudget ?? 100 },
      },
      {
        name: 'quality_gate',
        gate: {
          evaluator: () => {
            const action = gateActions.shift() ?? 'pass';
            return action === 'pass'
              ? { action: 'pass', pass: true }
              : { action, pass: false, reason: 'analysis too thin' };
          },
          maxRetries: scenario.maxRetries ?? 1,
        },
      },
      { name: 'produce', capabilities: [], promptBuilder: () => 'produce' },
    ],
  });
  const phases: string[] = [];
  const callsByStage: Record<string, number> = {};
  const runtime = {
    id: 'stage-budget-runtime',
    logger: { info: () => undefined },
    reactLoop: vi.fn(async (_prompt: string, opts: Record<string, unknown>) => {
      const phase = String((opts.context as Record<string, unknown>).pipelinePhase);
      phases.push(phase);
      const index = callsByStage[phase] ?? 0;
      callsByStage[phase] = index + 1;
      const inputs = scenario.inputByStage[phase] ?? [1];
      const input = index < inputs.length ? inputs[index] : inputs[inputs.length - 1];
      return {
        reply: `${phase} reply`,
        toolCalls: [],
        ...(input === undefined ? {} : { tokenUsage: { input, output: 1 } }),
        iterations: 1,
      };
    }),
  };
  const result = await strategy.execute(runtime, AgentMessage.internal('scan, analyze, produce'), {
    strategyContext: { diagnostics: new DiagnosticsCollector() },
  });
  return { result, phases };
}

function retryBudgetLogs(info: ReturnType<typeof vi.spyOn>): string[] {
  return info.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('retry budget check'));
}

describe('PipelineStrategy analysis retry budget suppression uses the stage-internal scale (I02)', () => {
  it('allows the retry when the target stayed within its own stage budget even if earlier stages used more', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const { result, phases } = await runRetryScenario({
      // scan 用掉 500（是 analyze 预算的 5 倍），analyze 自身只用了 10/100。
      inputByStage: { scan: [500], analyze: [10], produce: [1] },
      gateActions: ['analysis_retry'],
    });

    expect(phases).toEqual(['scan', 'analyze', 'analyze', 'produce']);
    expect(result.degraded).not.toBe(true);
    expect(result.phases?.quality_gate).toMatchObject({ action: 'pass' });
    const logs = retryBudgetLogs(info);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"analyze"');
    expect(logs[0]).toContain('stage input 10');
    expect(logs[0]).toContain('pipeline input total 510');
    expect(logs[0]).toContain('allow');
  });

  it('judges a repeated retry by the latest attempt, not the sum of all attempts', async () => {
    const { result, phases } = await runRetryScenario({
      inputByStage: { scan: [0], analyze: [60, 60, 60], produce: [1] },
      gateActions: ['analysis_retry', 'analysis_retry'],
      maxRetries: 2,
    });

    // 旧口径：第二次重试时管线累计 120/100 → 压制。阶段内口径：每次 60/100 → 允许。
    expect(phases).toEqual(['scan', 'analyze', 'analyze', 'analyze', 'produce']);
    expect(result.phases?.quality_gate).toMatchObject({ action: 'pass' });
  });

  it('still suppresses the retry when the target exhausted its own stage budget on its last run', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const { result, phases } = await runRetryScenario({
      inputByStage: { scan: [0], analyze: [95], produce: [1] },
      gateActions: ['analysis_retry'],
    });

    expect(phases).toEqual(['scan', 'analyze']);
    expect(result.degraded).toBe(true);
    const gate = result.phases?.quality_gate as { action?: string; reason?: string } | undefined;
    expect(gate?.action).toBe('degraded_budget_exhausted');
    expect(gate?.reason).toContain('session input budget is exhausted');
    expect(gate?.reason).toContain('95% of maxSessionInputTokens=100');
    expect(gate?.reason).toContain('stage "analyze" last-run input=95');
    const logs = retryBudgetLogs(info);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('suppress');
  });

  it('counts a retry target whose runtime reported no token usage as zero in-stage input', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const { phases } = await runRetryScenario({
      // runStageAttempt 把缺失的 tokenUsage 归一为 0：阶段内无消耗证据 → 不压制重跑。
      inputByStage: { scan: [500], analyze: [undefined], produce: [1] },
      gateActions: ['analysis_retry'],
    });

    expect(phases).toEqual(['scan', 'analyze', 'analyze', 'produce']);
    const logs = retryBudgetLogs(info);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('stage input 0/100');
    expect(logs[0]).toContain('pipeline input total 500');
    expect(logs[0]).toContain('allow');
  });
});
