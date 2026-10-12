/**
 * ExitController 有效超时的运行时链路（L5-P8 / I03）。
 *
 * 场景：宿主显式传入比策略超时更长的 execution.timeoutMs，阶段 budgetOverride 的超时（600s）
 * 远大于 BudgetPolicy.timeoutMs（50ms）。修复前策略超时只能在 P5 经 validateDuring 命中，
 * 被归为 policy_stop + needsSummary：不记 cancelReason/timedOutStages，finalize 还会再发一次
 * 强制摘要，宿主把它判为正常完成。修复后有效超时取两者较小正值，命中 stage_timeout 分支。
 */
import { describe, expect, it, vi } from 'vitest';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';

function toolEnvelope() {
  return {
    ok: true,
    toolId: 'demo_tool',
    callId: 'c',
    startedAt: new Date().toISOString(),
    durationMs: 1,
    status: 'success',
    text: 'r',
    structuredContent: { ok: true },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

/** mock provider：每轮延迟 delayMs 后返回一个工具调用，不依赖真实 API key。 */
function buildRuntime({ policyTimeoutMs, delayMs }: { policyTimeoutMs: number; delayMs: number }) {
  let n = 0;
  const chatWithTools = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    n += 1;
    return {
      text: '',
      functionCalls: [{ id: `c${n}`, name: 'demo_tool', args: { q: String(n) } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const runtime = new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn(async () => toolEnvelope()) } as never,
    container: {
      get: (name: string) =>
        name === 'capabilityCatalog'
          ? {
              toToolSchemas: () => [
                { name: 'demo_tool', description: 'Demo', parameters: { type: 'object' } },
              ],
            }
          : undefined,
    } as never,
    capabilities: [],
    additionalTools: ['demo_tool'],
    strategy: new SingleStrategy() as never,
    policies: new PolicyEngine([
      new BudgetPolicy({ maxIterations: 100, timeoutMs: policyTimeoutMs }),
    ]),
  });
  return { runtime, chatWithTools };
}

interface DiagnosticsView {
  timedOutStages?: string[];
  warnings?: Array<{ code: string }>;
  efficiency?: { cancelReason?: string; forcedSummary?: boolean };
}

describe('策略超时短于阶段超时：按 stage_timeout 收口', () => {
  it('策略超时 50ms、阶段 600s：退出原因为 stage_timeout，timedOutStages 非空，不再发强制摘要', async () => {
    const { runtime } = buildRuntime({ policyTimeoutMs: 50, delayMs: 30 });

    const result = await runtime.execute(AgentMessage.internal('go'), {
      timeoutMs: 10_000,
      budgetOverride: { maxIterations: 100, timeoutMs: 600_000 },
    });

    const diagnostics = result.diagnostics as DiagnosticsView;
    const warningCodes = (diagnostics.warnings ?? []).map((warning) => warning.code);
    expect(diagnostics.efficiency?.cancelReason).toBe('stage_timeout');
    expect(diagnostics.timedOutStages?.length ?? 0).toBeGreaterThan(0);
    expect(warningCodes).toContain('stage_timeout');
    expect(warningCodes).toContain('forced_summary_suppressed');
    expect(warningCodes).not.toContain('policy_stop');
    expect(diagnostics.efficiency?.forcedSummary).toBe(false);
    expect((result as { timedOut?: boolean }).timedOut).toBe(true);
  });

  it('其它原因退出时策略超时已过：强制摘要抑制使用同一有效超时', async () => {
    // maxIterations=1：首轮工具调用后 checkAfterToolCalls 以 iteration_exhausted 退出；
    // 此时已超过 50ms 策略超时但远未到 600s 阶段超时。
    // AgentRuntime.#getForcedSummarySuppression 与 createExitController 共用同一有效超时
    // （resolveEffectiveTimeoutMs + readPolicyTimeoutMs），因此这里不再多发一次强制摘要请求。
    const { runtime, chatWithTools } = buildRuntime({ policyTimeoutMs: 50, delayMs: 120 });

    const result = await runtime.execute(AgentMessage.internal('go'), {
      timeoutMs: 10_000,
      budgetOverride: { maxIterations: 1, timeoutMs: 600_000 },
    });

    const diagnostics = result.diagnostics as DiagnosticsView;
    const warningCodes = (diagnostics.warnings ?? []).map((warning) => warning.code);
    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(warningCodes).toContain('forced_summary_suppressed');
    expect(diagnostics.efficiency?.cancelReason).toBe('stage_timeout');
    expect(diagnostics.efficiency?.forcedSummary).toBe(false);
  });

  it('策略超时远大于实际耗时：照常完成，不误判超时', async () => {
    const { runtime } = buildRuntime({ policyTimeoutMs: 600_000, delayMs: 5 });

    const result = await runtime.execute(AgentMessage.internal('go'), {
      timeoutMs: 10_000,
      budgetOverride: { maxIterations: 2, timeoutMs: 600_000 },
    });

    const diagnostics = result.diagnostics as DiagnosticsView;
    expect(diagnostics.efficiency?.cancelReason).toBeUndefined();
    expect(diagnostics.timedOutStages ?? []).toHaveLength(0);
    expect((result as { timedOut?: boolean }).timedOut).toBeUndefined();
  });
});
