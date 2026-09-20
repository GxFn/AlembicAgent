import { describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '../src/agent/policies/PolicyEngine.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { SystemRunContext } from '../src/agent/runtime/SystemRunContext.js';
import type { AgentRunContext } from '../src/agent/service/AgentRunContracts.js';
import { AgentService } from '../src/agent/service/AgentService.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

function resources(scope: string) {
  return {
    contextWindow: { resetForNewStage: vi.fn(), tokenCount: 0 },
    trace: { scope },
    memoryCoordinator: { scope },
    sharedState: {
      _dimensionScopeId: scope,
      submittedTitles: new Set<string>(),
      evidenceLedger: { entries: new Map<string, string>() },
      _sessionCounters: { observedStages: 0 },
    },
    source: scope,
  };
}

function systemContext(scope: string): SystemRunContext {
  const refs = resources(scope);
  // 本回归只观察资源投影；ReAct 接缝替代模型/工具执行，不伪造真实 memory 的行为。
  return { ...refs, scopeId: scope, activeContext: refs.trace } as unknown as SystemRunContext;
}

async function runContext(context: Omit<AgentRunContext, 'source'>, secondStage = false) {
  const prepared: Record<string, unknown>[] = [];
  const strategy = new PipelineStrategy({
    stages: [
      { name: 'analyze', disableTracker: true },
      ...(secondStage ? [{ name: 'produce', disableTracker: true, recordRepairOnly: true }] : []),
    ].map((stage) => ({
      ...stage,
      promptBuilder: (input: Record<string, unknown>) => {
        prepared.push(input);
        return stage.name;
      },
    })),
  });
  const runtime = new AgentRuntime({
    aiProvider: { name: 'context-fixture', model: 'fixture', chatWithTools: vi.fn() } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    policies: new PolicyEngine([]),
    capabilities: [],
    strategy,
  });
  const reactLoop = vi.spyOn(runtime, 'reactLoop').mockResolvedValue({
    reply: 'stage complete',
    toolCalls: [],
    iterations: 1,
    tokenUsage: { input: 1, output: 1 },
  } as Awaited<ReturnType<AgentRuntime['reactLoop']>>);
  const service = new AgentService({ runtimeBuilder: { build: () => runtime } });
  const result = await service.run({
    profile: { preset: 'chat' },
    message: { content: 'check resource projection' },
    context: { ...context, source: 'internal' },
    execution: { budgetOverride: { maxIterations: 7 }, toolChoiceOverride: 'required' },
  });
  expect(result.status).toBe('success');
  return { prepared, loopOptions: reactLoop.mock.calls.map(([, options]) => options ?? {}) };
}

describe('AgentService pipeline context projection', () => {
  it('forwards flat resources once and keeps shared references across stage copies', async () => {
    const flat = resources('flat');
    const { prepared, loopOptions } = await runContext({ ...flat, runtimeSource: 'analyst' }, true);

    expect(loopOptions).toHaveLength(2);
    for (const options of [...prepared, ...loopOptions]) {
      expect(options.contextWindow).toBe(flat.contextWindow);
      expect(options.memoryCoordinator).toBe(flat.memoryCoordinator);
      expect(options.trace).toBe(flat.trace);
      expect(options.source).toBe('analyst');
      const shared = options.sharedState as typeof flat.sharedState;
      expect(shared.submittedTitles).toBe(flat.sharedState.submittedTitles);
      expect(shared.evidenceLedger).toBe(flat.sharedState.evidenceLedger);
      expect(shared._sessionCounters).toBe(flat.sharedState._sessionCounters);
    }
    expect(loopOptions[0].sharedState).toBe(flat.sharedState);
    expect(loopOptions[1].sharedState).not.toBe(flat.sharedState);
    expect(loopOptions[1].sharedState).toHaveProperty('_recordRepairOnly', true);
    expect(flat.sharedState).not.toHaveProperty('_recordRepairOnly');
    expect(flat.contextWindow.resetForNewStage).toHaveBeenCalledOnce();
    for (const context of prepared) {
      expect(context).not.toHaveProperty('budgetOverride');
      expect(context).not.toHaveProperty('toolChoiceOverride');
    }
  });

  it('keeps an effective systemRunContext above flat defaults', async () => {
    const flat = resources('flat');
    const system = systemContext('system');
    const { prepared, loopOptions } = await runContext({ ...flat, systemRunContext: system });
    for (const options of [...prepared, ...loopOptions]) {
      expect(options.contextWindow).toBe(system.contextWindow);
      expect(options.memoryCoordinator).toBe(system.memoryCoordinator);
      expect(options.trace).toBe(system.trace);
      expect(options.source).toBe(system.source);
      expect(options.sharedState).toBe(system.sharedState);
    }
  });

  it('keeps explicit strategy resources above nested and outer system context', async () => {
    const flat = resources('flat');
    const outer = systemContext('outer');
    const nested = systemContext('nested');
    nested.sharedState.inheritedFromNested = true;
    const explicit = resources('explicit');
    const { prepared, loopOptions } = await runContext({
      ...flat,
      systemRunContext: outer,
      strategyContext: { ...explicit, systemRunContext: nested },
    });
    expect(prepared[0].systemRunContext).toBe(nested);
    for (const options of [...prepared, ...loopOptions]) {
      expect(options.contextWindow).toBe(explicit.contextWindow);
      expect(options.memoryCoordinator).toBe(explicit.memoryCoordinator);
      expect(options.trace).toBe(explicit.trace);
      expect(options.source).toBe(explicit.source);
      expect(options.sharedState).toMatchObject({ inheritedFromNested: true });
      const shared = options.sharedState as typeof explicit.sharedState;
      expect(shared.submittedTitles).toBe(explicit.sharedState.submittedTitles);
      expect(shared.evidenceLedger).toBe(explicit.sharedState.evidenceLedger);
      expect(shared._sessionCounters).toBe(explicit.sharedState._sessionCounters);
    }
  });
});
