import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AgentProfileRegistry } from '../src/agent/profiles/AgentProfileRegistry.js';
import { parsePlanSelection, runPlanAgent } from '../src/agent/runs/plan/PlanAgentRun.js';
import type { AgentRunInput, AgentRunResult } from '../src/agent/service/AgentRunContracts.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { AgentService } from '../src/agent/service/AgentService.js';

function agentRunResult(
  reply: string,
  status: AgentRunResult['status'] = 'success'
): AgentRunResult {
  return {
    runId: 'plan-run-test',
    profileId: 'plan-selection',
    reply,
    status,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}

function selectionJson(dimensions: string[]) {
  return JSON.stringify({
    generationStage: 'coldStart',
    dimensions,
    scale: { totalRecipeBudget: 4, maxFiles: 120, contentMaxLines: 80 },
    moduleBindings: [],
  });
}

describe('plan-selection Agent profile', () => {
  it('registers as a single-step no-tool JSON profile', () => {
    const profile = new AgentProfileRegistry().require('plan-selection');

    expect(profile.basePreset).toBe('chat');
    expect(profile.strategy).toEqual({ type: 'single' });
    expect(profile.defaults?.actionSpace).toEqual({ mode: 'none' });
    expect(profile.defaults?.memory).toEqual({ enabled: false });
    expect(profile.defaults?.skills).toEqual([]);
    expect(profile.projection).toBe('json-object');
    expect(profile.defaults?.policies).toContainEqual(
      expect.objectContaining({ type: 'budget', maxIterations: 2 })
    );
  });
});

describe('runPlanAgent', () => {
  it('runs the plan profile exactly once and returns a valid narrow PlanSelection', async () => {
    const calls: AgentRunInput[] = [];
    const agentService = {
      run: async (input: AgentRunInput) => {
        calls.push(input);
        return agentRunResult(selectionJson(['api']));
      },
    };

    await expect(
      runPlanAgent({
        agentService,
        generationStage: 'coldStart',
        projectContextFacts: { project: 'fixture', dimensions: ['api', 'domain'] },
      })
    ).resolves.toMatchObject({
      generationStage: 'coldStart',
      dimensions: ['api'],
      scale: { totalRecipeBudget: 4 },
      moduleBindings: [],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      profile: { id: 'plan-selection' },
      params: {
        generationStage: 'coldStart',
        projectContextFacts: { project: 'fixture', dimensions: ['api', 'domain'] },
      },
      context: {
        source: 'system-workflow',
        runtimeSource: 'system',
      },
      execution: { toolChoiceOverride: 'none' },
      presentation: { responseShape: 'system-task-result' },
    });
    expect(calls[0]?.context).not.toHaveProperty('sharedState');
  });

  it('performs one real no-tool LLM call before returning PlanSelection JSON', async () => {
    const providerCalls: Array<{ prompt: string; opts?: Record<string, unknown> }> = [];
    const chatWithTools = vi.fn(async (prompt: string, opts?: Record<string, unknown>) => {
      providerCalls.push({ prompt, opts });
      return {
        text: selectionJson(['api']),
        functionCalls: [],
        usage: { inputTokens: 12, outputTokens: 8 },
      };
    });
    const agentService = new AgentService({
      runtimeBuilder: new AgentRuntimeBuilder({
        aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
        container: {},
        toolRegistry: { getRouter: () => ({ execute: vi.fn() }) as never },
      }),
    });

    const result = await runPlanAgent({
      agentService,
      generationStage: 'coldStart',
      projectContextFacts: { project: 'fixture', dimensions: ['api', 'domain'] },
    });

    expect(result.dimensions).toEqual(['api']);
    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(providerCalls[0]?.prompt).toContain('generationStage=coldStart');
    expect(providerCalls[0]?.opts?.toolChoice).toBeUndefined();
    expect(providerCalls[0]?.opts?.toolSchemas).toBeUndefined();
  });

  it('throws when the Agent run status is not success', async () => {
    const agentService = {
      run: async (_input: AgentRunInput) => agentRunResult('provider unavailable', 'error'),
    };

    await expect(
      runPlanAgent({
        agentService,
        generationStage: 'coldStart',
        projectContextFacts: {},
      })
    ).rejects.toThrow(/Plan agent failed with status error/u);
  });

  it('throws on invalid JSON and invalid PlanSelection shape', () => {
    expect(() => parsePlanSelection('not json')).toThrow(/invalid JSON/u);
    expect(() => parsePlanSelection('plain text before forced summary')).toThrow(/invalid JSON/u);
    expect(() =>
      parsePlanSelection(
        JSON.stringify({
          generationStage: 'coldStart',
          dimensions: ['api'],
          scale: { totalRecipeBudget: 0 },
          moduleBindings: [],
        })
      )
    ).toThrow(/Invalid PlanSelection/u);
  });

  it('allows one selected dimension and rejects an empty dimension list', () => {
    expect(parsePlanSelection(selectionJson(['api'])).dimensions).toEqual(['api']);
    expect(() => parsePlanSelection(selectionJson([]))).toThrow(/dimensions must be non-empty/u);
  });

  it('does not import persistence or tool-action surfaces', () => {
    const source = readFileSync(
      new URL('../src/agent/runs/plan/PlanAgentRun.ts', import.meta.url),
      'utf8'
    );

    expect(source).not.toMatch(/from ['"].*(repository|ledger|tools)\b/u);
    expect(source).not.toContain('sharedState');
  });
});
