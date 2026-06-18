import { describe, expect, it } from 'vitest';
import { BudgetPolicy, Policy, PolicyEngine, SafetyPolicy } from '../src/agent/policies/index.js';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentStageFactoryRegistry,
} from '../src/agent/profiles/index.js';
import type {
  AgentRunInput,
  AgentRunResult,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import { AgentRunCoordinator } from '../src/agent/service/index.js';
import {
  type TaskContext,
  taskCheckAndSubmit,
  taskFullEnrich,
  taskGuardFullScan,
  taskQualityAudit,
} from '../src/agent/tasks/index.js';
import type { ToolResultEnvelope } from '../src/tools/runtime/ToolRuntimeBridge.js';

const projectRoot = '/tmp/alembic-agent-surface-floor';

class BlockingPolicy extends Policy {
  get name() {
    return 'blocking';
  }

  override validateBefore() {
    return { ok: false, reason: 'blocked-before-run' };
  }
}

function toolEnvelope(structuredContent: unknown): ToolResultEnvelope {
  return {
    ok: true,
    toolId: 'task-tool',
    callId: 'task-call',
    startedAt: '2026-06-12T00:00:00.000Z',
    durationMs: 1,
    status: 'success',
    text: JSON.stringify(structuredContent),
    structuredContent,
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

function createTaskContext(
  responses: Record<string, unknown>,
  services: Record<string, unknown> = {}
): TaskContext & { calls: Array<{ toolName: string; params: Record<string, unknown> }> } {
  const calls: Array<{ toolName: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    async invokeToolEnvelope(toolName, params) {
      calls.push({ toolName, params });
      return toolEnvelope(responses[toolName] ?? {});
    },
    container: {
      get(name: string) {
        const service = services[name];
        if (!service) {
          throw new Error(`missing service: ${name}`);
        }
        return service;
      },
    },
  };
}

function baseRunInput(dimensions: unknown[]): AgentRunInput {
  return {
    profile: { id: 'parent-profile' },
    params: { dimensions },
    message: {
      role: 'user',
      content: 'coordinate bootstrap dimensions',
      metadata: { requestId: 'surface-floor' },
    },
    context: {
      source: 'internal',
    },
  };
}

function childResult(input: AgentRunInput): AgentRunResult {
  const dimension = String(input.params?.dimId ?? 'unknown');
  return {
    runId: `${dimension}:success`,
    profileId: input.profile.id ?? 'child-profile',
    reply: `done:${dimension}`,
    status: 'success',
    phases: { dimension },
    toolCalls: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      iterations: 1,
      durationMs: 1,
    },
    diagnostics: null,
  };
}

describe('task handler public contracts', () => {
  it('checks duplicate candidates and keeps AI verdict optional', async () => {
    const context = createTaskContext({
      check_duplicate: {
        similar: [
          { title: 'same recipe', similarity: 0.82 },
          { title: 'near recipe', similarity: 0.63 },
        ],
      },
    });
    context.aiProvider = {
      chat: async () => 'SIMILAR because the evidence differs',
      chatWithStructuredOutput: async () => ({}),
    };

    await expect(
      taskCheckAndSubmit(context, {
        candidate: { title: 'candidate', code: 'export const answer = 42;' },
        projectRoot,
      })
    ).resolves.toMatchObject({
      duplicates: [
        { title: 'same recipe', similarity: 0.82 },
        { title: 'near recipe', similarity: 0.63 },
      ],
      highSimilarity: [{ title: 'same recipe', similarity: 0.82 }],
      aiVerdict: 'SIMILAR',
      recommendation: 'review_suggested',
    });
    expect(context.calls[0]).toMatchObject({
      toolName: 'check_duplicate',
      params: { projectRoot, threshold: 0.5 },
    });
  });

  it('enriches only candidates missing required metadata', async () => {
    const knowledgeService = {
      list: async () => ({
        items: [
          { id: 'needs-rationale', metadata: { knowledgeType: 'pattern', complexity: 'low' } },
          {
            id: 'complete',
            metadata: { rationale: 'why', knowledgeType: 'fact', complexity: 'low' },
          },
          { id: 'needs-complexity', metadata: { rationale: 'why', knowledgeType: 'rule' } },
        ],
      }),
    };
    const context = createTaskContext(
      {
        enrich_candidate: { enriched: 2 },
      },
      { knowledgeService }
    );

    await expect(taskFullEnrich(context, { maxCount: 10 })).resolves.toEqual({ enriched: 2 });
    expect(context.calls[0]).toEqual({
      toolName: 'enrich_candidate',
      params: { candidateIds: ['needs-rationale', 'needs-complexity'] },
    });
  });

  it('audits recipe quality and sorts low-quality records by score', async () => {
    const knowledgeService = {
      list: async () => ({
        data: [
          { id: 'b', title: 'borderline' },
          { id: 'a', title: 'weak' },
          { id: 'c', title: 'strong' },
        ],
      }),
    };
    const scores: Record<string, unknown> = {
      b: { score: 0.5, grade: 'D', dimensions: { evidence: 0.4 } },
      a: { score: 0.2, grade: 'F', dimensions: { evidence: 0.1 } },
      c: { score: 0.95, grade: 'A', dimensions: { evidence: 1 } },
    };
    const context = createTaskContext({}, { knowledgeService });
    context.invokeToolEnvelope = async (_toolName, params) => {
      const recipe = params.recipe as { id: string };
      return toolEnvelope(scores[recipe.id]);
    };

    await expect(taskQualityAudit(context, { threshold: 0.6 })).resolves.toMatchObject({
      total: 3,
      lowQualityCount: 2,
      lowQuality: [
        { id: 'a', score: 0.2, grade: 'F' },
        { id: 'b', score: 0.5, grade: 'D' },
      ],
      gradeDistribution: { A: 1, B: 0, C: 0, D: 1, F: 1 },
    });
  });

  it('runs guard scans with structured AI suggestions only after violations exist', async () => {
    const context = createTaskContext({
      guard_check_code: {
        violationCount: 1,
        violations: [{ severity: 'error', message: 'no any', line: 3 }],
      },
    });
    context.aiProvider = {
      chat: async () => 'unused',
      chatWithStructuredOutput: async () => [{ violation: 'no any', suggestion: 'use unknown' }],
    };

    await expect(
      taskGuardFullScan(context, {
        code: 'const value: any = input;',
        language: 'ts',
        filePath: 'src/example.ts',
      })
    ).resolves.toMatchObject({
      filePath: 'src/example.ts',
      language: 'ts',
      violationCount: 1,
      suggestions: [{ violation: 'no any', suggestion: 'use unknown' }],
    });
  });
});

describe('policy public contracts', () => {
  it('short-circuits policy validation and exposes budget configuration', () => {
    const engine = new PolicyEngine([
      new BudgetPolicy({ maxIterations: 2, maxTokens: 100, timeoutMs: 1000 }),
      new BlockingPolicy(),
    ]);

    expect(engine.validateBefore({ message: { sender: { id: 'user-1' } } })).toEqual({
      ok: false,
      reason: 'blocked-before-run',
    });
    expect(engine.getBudget()).toMatchObject({ maxIterations: 2, maxTokens: 100 });
    expect(engine.validateDuring({ iteration: 2, startTime: Date.now() })).toMatchObject({
      ok: false,
      action: 'stop',
      reason: 'Budget: max iterations (2) reached',
    });
  });

  it('applies safety policy to terminal commands, code paths, and approval-only tools', () => {
    const engine = new PolicyEngine([
      new SafetyPolicy({ fileScope: projectRoot, requireApprovalFor: ['write_project_file'] }),
    ]);

    expect(engine.validateToolCall('terminal', { bin: 'sudo', args: ['whoami'] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('命令拦截'),
    });
    expect(
      engine.validateToolCall('code', { params: { path: `${projectRoot}/src/index.ts` } })
    ).toEqual({ ok: true });
    expect(engine.validateToolCall('code', { params: { path: '/tmp/outside.ts' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('路径拦截'),
    });
    expect(
      engine.validateToolCall('write_project_file', { filePath: `${projectRoot}/a.ts` })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('需要人工确认'),
    });
  });
});

describe('profile public contracts', () => {
  it('registers serializable profile definitions and rejects runtime closures', () => {
    const registry = new AgentProfileRegistry([]);

    expect(() =>
      registry.register({
        id: 'fixture-profile',
        title: 'Fixture Profile',
        serviceKind: 'system-analysis',
        lifecycle: 'active',
        defaults: { actionSpace: { mode: 'listed', toolIds: ['code'] } },
      })
    ).not.toThrow();
    expect(registry.require('fixture-profile')).toMatchObject({ title: 'Fixture Profile' });
    expect(() =>
      registry.register({
        id: 'bad-profile',
        title: 'Bad Profile',
        serviceKind: 'system-analysis',
        lifecycle: 'active',
        defaults: { persona: { render: () => 'not serializable' } },
      })
    ).toThrow('must not contain functions');
  });

  it('compiles definitions through stage factories, policies, and action-space projections', () => {
    const profileRegistry = new AgentProfileRegistry([
      {
        id: 'floor-profile',
        title: 'Floor Profile',
        serviceKind: 'system-analysis',
        lifecycle: 'active',
        defaults: {
          actionSpace: { mode: 'listed', toolIds: ['code', 'terminal'] },
          policies: [{ type: 'budget', maxIterations: 3, maxTokens: 512 }],
        },
        strategy: { type: 'pipeline', factory: 'floorPipeline' },
      },
    ]);
    const stageFactoryRegistry = new AgentStageFactoryRegistry();
    stageFactoryRegistry.register('floorPipeline', ({ params }) => [
      { name: 'scan', limit: params.limit ?? 1 },
    ]);
    const compiler = new AgentProfileCompiler({ profileRegistry, stageFactoryRegistry });

    const compiled = compiler.compile({ id: 'floor-profile', params: { limit: 7 } });
    expect(compiled).toMatchObject({
      id: 'floor-profile',
      additionalTools: ['code', 'terminal'],
      strategy: { type: 'pipeline', stages: [{ name: 'scan', limit: 7 }] },
    });
    expect(compiled.policies?.[0]).toBeInstanceOf(BudgetPolicy);
  });
});

describe('coordination public contracts', () => {
  it('partitions bootstrap dimensions by tier and merges child results deterministically', async () => {
    const coordinator = new AgentRunCoordinator();
    const tierEvents: number[] = [];
    const input = baseRunInput([
      { id: 'scan', tier: 0, prompt: 'scan project' },
      { id: 'produce', tier: 1, prompt: 'produce records' },
    ]);
    input.context.coordination = {
      onTierComplete: async (event) => {
        tierEvents.push(event.tierIndex);
      },
    };
    const profile: CompiledAgentProfile = {
      kind: 'compiled-agent-profile',
      id: 'parent-profile',
      title: 'Parent Profile',
      serviceKind: 'system-analysis',
      lifecycle: 'active',
      basePreset: 'chat',
      actionSpace: { mode: 'listed', toolIds: [] },
      additionalTools: [],
      params: {},
      runtimeOverrides: {},
      concurrency: {
        mode: 'tiered',
        concurrency: 1,
        partitioner: 'bootstrapSessionDimensions',
        merge: 'bootstrapSessionResults',
        childProfile: 'child-profile',
      },
    };

    await expect(
      coordinator.run(input, profile, async (child) => childResult(child))
    ).resolves.toMatchObject({
      status: 'success',
      phases: {
        dimensionResults: {
          scan: { reply: 'done:scan' },
          produce: { reply: 'done:produce' },
        },
      },
    });
    expect(tierEvents).toEqual([0, 1]);
  });

  it('records aborted child results when a later tier is cancelled before dispatch', async () => {
    const coordinator = new AgentRunCoordinator();
    let shouldAbort = false;
    const input = baseRunInput([
      { id: 'scan', tier: 0, prompt: 'scan project' },
      { id: 'produce', tier: 1, prompt: 'produce records' },
    ]);
    input.execution = {
      shouldAbort: async () => shouldAbort,
    };
    input.context.coordination = {
      onTierComplete: async () => {
        shouldAbort = true;
      },
    };
    const profile: CompiledAgentProfile = {
      kind: 'compiled-agent-profile',
      id: 'parent-profile',
      title: 'Parent Profile',
      serviceKind: 'system-analysis',
      lifecycle: 'active',
      basePreset: 'chat',
      actionSpace: { mode: 'listed', toolIds: [] },
      additionalTools: [],
      params: {},
      runtimeOverrides: {},
      concurrency: {
        mode: 'tiered',
        concurrency: 1,
        partitioner: 'bootstrapSessionDimensions',
        merge: 'bootstrapSessionResults',
        childProfile: 'child-profile',
      },
    };

    await expect(
      coordinator.run(input, profile, async (child) => childResult(child))
    ).resolves.toMatchObject({
      status: 'aborted',
      phases: {
        dimensionResults: {
          scan: { status: 'success' },
          produce: { status: 'aborted', reply: 'child-run-aborted' },
        },
      },
    });
  });
});
