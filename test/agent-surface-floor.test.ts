import { describe, expect, it, vi } from 'vitest';
import {
  evolutionGateEvaluator,
  producerRejectionGateEvaluator,
} from '../src/agent/evaluation/gateEvaluators.js';
import {
  BudgetPolicy,
  Policy,
  PolicyEngine,
  QualityGatePolicy,
  SafetyPolicy,
} from '../src/agent/policies/index.js';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentStageFactoryRegistry,
} from '../src/agent/profiles/index.js';
import { collectEvolutionDecisionIds } from '../src/agent/runs/evolution/EvolutionAgentRun.js';
import { projectRelationDiscoveryResult } from '../src/agent/runs/relation/RelationAgentRun.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import type {
  AgentRunInput,
  AgentRunResult,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import { AgentRunCoordinator } from '../src/agent/service/index.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import {
  type TaskContext,
  taskCheckAndSubmit,
  taskFullEnrich,
  taskGuardFullScan,
  taskQualityAudit,
} from '../src/agent/tasks/index.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';

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
  it('does not count rejected replacements or skipped proposals as completed evolution decisions', () => {
    const calls = [
      {
        tool: 'knowledge',
        args: { action: 'submit', params: { supersedes: 'old' } },
        result: { status: 'duplicate_blocked' },
        durationMs: 0,
      },
      {
        tool: 'knowledge',
        args: { action: 'manage', params: { operation: 'evolve', id: 'old' } },
        result: { status: 'evolution_proposed', outcome: 'skipped' },
        durationMs: 0,
      },
    ];
    expect(collectEvolutionDecisionIds(calls)).toEqual(new Set());
    expect(
      evolutionGateEvaluator({ toolCalls: calls }, {}, { existingRecipes: [{ id: 'old' }] }).action
    ).toBe('retry');
  });

  it('does not let successful knowledge queries hide rejected submissions', () => {
    const toolCalls = [
      ...Array.from({ length: 3 }, () => ({
        tool: 'knowledge',
        args: { action: 'search' },
        result: { status: 'success' },
      })),
      ...Array.from({ length: 2 }, () => ({
        tool: 'knowledge',
        args: { action: 'submit' },
        result: { status: 'rejected' },
      })),
    ];
    expect(producerRejectionGateEvaluator({ toolCalls }, {}).action).toBe('retry');
  });
  it.each([
    'null',
    '[]',
    '{"analyzed":-1,"relations":[null,{"from":3}]}',
  ])('normalizes malformed relation output: %s', (reply) => {
    expect(
      projectRelationDiscoveryResult({ ...childResult(baseRunInput([])), reply })
    ).toMatchObject({ analyzed: 0, relations: [] });
  });
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
  it('forwards a single-stage message and explicit run options to the runtime', async () => {
    const context = { scope: 'fixture' };
    const message = new AgentMessage({
      content: 'inspect the fixture',
      session: { id: 'fixture', history: [{ role: 'user', content: 'earlier' }] },
      metadata: { context },
    });
    const output = {
      reply: 'done',
      toolCalls: [],
      tokenUsage: { input: 1, output: 2 },
      iterations: 1,
    };
    const reactLoop = vi.fn(async () => output);
    expect(
      await new SingleStrategy().execute({ id: 'fixture', reactLoop }, message, {
        maxIterations: 7,
      })
    ).toEqual(output);
    expect(reactLoop).toHaveBeenCalledWith(message.content, {
      history: message.history,
      context,
      maxIterations: 7,
    });
  });

  it('short-circuits policy validation and exposes budget configuration', () => {
    expect(new BudgetPolicy()).toMatchObject({
      maxIterations: 20,
      maxTokens: 4096,
      timeoutMs: 300_000,
      temperature: 0.7,
    });
    expect(
      new BudgetPolicy({ maxIterations: 5, maxTokens: 2048, timeoutMs: 60_000, temperature: 0.3 })
    ).toMatchObject({ maxIterations: 5, maxTokens: 2048, timeoutMs: 60_000, temperature: 0.3 });
    const engine = new PolicyEngine([
      new BudgetPolicy({ maxIterations: 2, maxTokens: 100, timeoutMs: 1000 }),
      new BlockingPolicy(),
    ]);

    expect(engine.validateBefore({ message: { sender: { id: 'user-1' } } })).toEqual({
      ok: false,
      reason: 'blocked-before-run',
    });
    expect(engine.getBudget()).toMatchObject({ maxIterations: 2, maxTokens: 100 });
    expect(engine.validateDuring({ iteration: 1, startTime: Date.now() }).ok).toBe(true);
    expect(engine.validateDuring({ iteration: 0, startTime: Date.now() - 2000 })).toMatchObject({
      ok: false,
      action: 'stop',
    });
    expect(engine.validateDuring({ iteration: 2, startTime: Date.now() })).toMatchObject({
      ok: false,
      action: 'stop',
      reason: 'Budget: max iterations (2) reached',
    });
  });

  it('applies safety policy to terminal commands, code paths, and approval-only tools', () => {
    const restricted = new SafetyPolicy({ allowedSenders: ['allowed'] });
    expect(restricted.validateBefore({ message: { sender: { id: 'allowed' } } }).ok).toBe(true);
    expect(restricted.validateBefore({ message: { sender: { id: 'denied' } } }).ok).toBe(false);
    expect(new SafetyPolicy().validateBefore({ message: { sender: { id: 'anyone' } } }).ok).toBe(
      true
    );
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
    expect(engine.validateToolCall('code', { path: `${projectRoot}-other/file.ts` }).ok).toBe(
      false
    );
    expect(
      engine.validateToolCall('code', {
        filePaths: [`${projectRoot}/safe.ts`, `${projectRoot}-other/file.ts`],
      }).ok
    ).toBe(false);
    expect(
      engine.validateToolCall('write_project_file', { filePath: `${projectRoot}/a.ts` })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('需要人工确认'),
    });
  });

  it.each([
    'tool',
    'name',
  ] as const)('bypasses file-reference checks only for a persisted submission (%s identity)', (field) => {
    const policy = new QualityGatePolicy({ minEvidenceLength: 0, minFileRefs: 3, minToolCalls: 0 });
    const receipt = { status: 'created', id: 'candidate-fixture', lifecycle: 'pending' };
    const submission = { [field]: 'knowledge', args: { action: 'submit' }, result: receipt };
    expect(policy.validateAfter({ reply: 'No file references', toolCalls: [submission] }).ok).toBe(
      true
    );
    expect(
      policy.validateAfter({ reply: 'No file references', toolCalls: [{ [field]: 'knowledge' }] })
        .ok
    ).toBe(false);
  });

  it.each([
    { label: 'missing receipt', action: 'submit', result: undefined },
    { label: 'query success', action: 'search', result: { status: 'success' } },
    { label: 'rejected submission', action: 'submit', result: { status: 'rejected' } },
    {
      label: 'missing candidate id',
      action: 'submit',
      result: { status: 'created', lifecycle: 'pending' },
    },
    {
      label: 'non-staging lifecycle',
      action: 'submit',
      result: { status: 'created', id: 'candidate', lifecycle: 'active' },
    },
  ])('keeps quality checks for $label', ({ action, result }) => {
    const policy = new QualityGatePolicy({ minEvidenceLength: 0, minFileRefs: 3, minToolCalls: 0 });
    expect(
      policy.validateAfter({
        reply: 'No file references',
        toolCalls: [{ tool: 'knowledge', args: { action }, result }],
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('文件引用不足') });
  });

  it('combines evidence, call-count and custom quality requirements', () => {
    const custom = (result: { reply?: string }) =>
      result.reply?.includes('deny') ? { ok: false, reason: 'custom rejection' } : { ok: true };
    const policy = new QualityGatePolicy({
      minEvidenceLength: 5,
      minFileRefs: 1,
      minToolCalls: 2,
      customValidator: custom,
    });
    const poor = policy.validateAfter({ reply: 'x', toolCalls: [] });
    expect(poor.reason).toContain('分析长度不足');
    expect(poor.reason).toContain('文件引用不足');
    expect(poor.reason).toContain('工具调用不足');
    expect(policy.validateAfter({ reply: 'Inspect src/file.ts', toolCalls: [{}, {}] }).ok).toBe(
      true
    );
    expect(policy.validateAfter({ reply: 'deny src/file.ts', toolCalls: [{}, {}] })).toMatchObject({
      ok: false,
      reason: 'custom rejection',
    });
    expect(policy.toGateConfig()).toMatchObject({
      minEvidenceLength: 5,
      minFileRefs: 1,
      minToolCalls: 2,
      custom,
    });
  });
});

describe('evolution gate receipt contracts', () => {
  const expectedIds = ['recipe-1', 'recipe-2', 'recipe-3'];
  const context = { existingRecipes: expectedIds.map((id) => ({ id })) };
  const manage = (id: string, operation: string, result: unknown) => ({
    tool: 'knowledge',
    args: { action: 'manage', params: { id, operation } },
    result,
    durationMs: 0,
  });

  it.each([
    { label: 'proposal', call: manage('recipe-1', 'evolve', { outcome: 'proposal-created' }) },
    {
      label: 'deprecation',
      call: manage('recipe-1', 'deprecate', { outcome: 'immediately-executed' }),
    },
    { label: 'verified skip', call: manage('recipe-1', 'skip_evolution', { outcome: 'verified' }) },
    {
      label: 'legacy proposal',
      call: {
        tool: 'propose_evolution',
        args: { recipeId: 'recipe-1' },
        result: { status: 'evolution_proposed' },
        durationMs: 0,
      },
    },
    {
      label: 'legacy deprecation',
      call: {
        tool: 'confirm_deprecation',
        args: { recipeId: 'recipe-1' },
        result: { status: 'deprecated' },
        durationMs: 0,
      },
    },
    {
      label: 'legacy verified skip',
      call: {
        tool: 'skip_evolution',
        args: { recipeId: 'recipe-1' },
        result: { status: 'evolution_skipped' },
        durationMs: 0,
      },
    },
    {
      label: 'persisted replacement',
      call: {
        tool: 'knowledge',
        args: { action: 'submit', params: { supersedes: 'recipe-1' } },
        result: { status: 'created', id: 'new-candidate', lifecycle: 'staging' },
        durationMs: 0,
      },
    },
  ])('counts a confirmed $label in both run projection and the gate', ({ call }) => {
    expect(collectEvolutionDecisionIds([call], ['recipe-1'])).toEqual(new Set(['recipe-1']));
    expect(
      evolutionGateEvaluator({ toolCalls: [call] }, null, { existingRecipes: [{ id: 'recipe-1' }] })
    ).toMatchObject({
      action: 'pass',
      artifact: { processed: 1, totalRecipes: 1, pendingIds: [] },
    });
  });

  it.each([
    { label: 'missing', result: undefined },
    { label: 'error', result: { error: 'fixture failure' } },
    { label: 'blocked', result: { status: 'blocked' } },
    { label: 'aborted', result: { status: 'aborted' } },
    { label: 'timeout', result: { status: 'timeout' } },
    { label: 'unconfirmed', result: { status: 'needs-confirmation' } },
    {
      label: 'failed outer wrapper',
      result: { ok: false, data: { status: 'evolution_proposed' } },
    },
    {
      label: 'authoritative skipped outcome',
      result: { status: 'evolution_proposed', outcome: 'skipped' },
    },
  ])('does not count a $label receipt', ({ result }) => {
    const calls = [manage('recipe-1', 'evolve', result)];
    expect(collectEvolutionDecisionIds(calls, expectedIds)).toEqual(new Set());
    expect(evolutionGateEvaluator({ toolCalls: calls }, null, context)).toMatchObject({
      action: 'retry',
      artifact: { processed: 0, totalRecipes: 3, pendingIds: expectedIds },
    });
  });

  it('deduplicates cumulative receipts, ignores unrelated ids and requires replacement lineage', () => {
    const calls = [
      manage('recipe-1', 'skip_evolution', { outcome: 'verified' }),
      manage('recipe-1', 'skip_evolution', { outcome: 'verified' }),
      manage('recipe-2', 'deprecate', { status: 'deprecated' }),
      manage('unrelated', 'evolve', { status: 'evolution_proposed' }),
      {
        tool: 'knowledge',
        args: { action: 'submit' },
        result: { status: 'created', id: 'new-candidate', lifecycle: 'pending' },
        durationMs: 0,
      },
    ];
    expect(collectEvolutionDecisionIds(calls, expectedIds)).toEqual(
      new Set(['recipe-1', 'recipe-2'])
    );
    expect(evolutionGateEvaluator({ toolCalls: calls }, null, context)).toMatchObject({
      action: 'retry',
      artifact: { processed: 2, totalRecipes: 3, pendingIds: ['recipe-3'] },
    });
  });

  it('retains legacy recipe context without overriding an explicit current recipe set', () => {
    const toolCalls = [manage('recipe-1', 'skip_evolution', { outcome: 'verified' })];
    expect(
      evolutionGateEvaluator({ toolCalls }, null, { decayedRecipes: [{ id: 'recipe-1' }] }).action
    ).toBe('pass');
    expect(
      evolutionGateEvaluator({ toolCalls }, null, {
        existingRecipes: [],
        decayedRecipes: [{ id: 'recipe-2' }],
      })
    ).toMatchObject({ action: 'pass', artifact: { totalRecipes: 0, pendingIds: [] } });
    expect(evolutionGateEvaluator(null, null)).toMatchObject({
      action: 'pass',
      artifact: { processed: 0, totalRecipes: 0 },
    });
    expect(evolutionGateEvaluator(null, null, context)).toMatchObject({
      action: 'retry',
      artifact: { processed: 0, pendingIds: expectedIds },
    });
  });
});

describe('profile public contracts', () => {
  it('preserves declarative safety constraints through profile compilation', () => {
    const compiler = new AgentProfileCompiler({
      profileRegistry: new AgentProfileRegistry([]),
      stageFactoryRegistry: new AgentStageFactoryRegistry(),
    });
    const profile = compiler.compile({
      basePreset: 'chat',
      policies: [
        {
          type: 'safety',
          allowedSenders: ['allowed'],
          fileScope: projectRoot,
          requireApprovalFor: ['publish'],
          commandBlacklist: [/custom-denied/],
        },
      ],
    });
    const policy = profile.policies?.[0] as SafetyPolicy;
    expect(policy.validateBefore({ message: { sender: { id: 'denied' } } } as never).ok).toBe(
      false
    );
    expect(policy.checkFilePath('/outside/file.ts').safe).toBe(false);
    expect(policy.needsApproval('publish')).toBe(true);
    const engine = new PolicyEngine([policy]);
    expect(
      engine.validateToolCall('terminal', {
        action: 'exec',
        params: { command: 'custom-denied arg' },
      }).ok
    ).toBe(false);
  });
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

function coordinationProfile(): CompiledAgentProfile {
  return {
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
      partitioner: 'generateSessionDimensions',
      merge: 'generateSessionResults',
      childProfile: 'child-profile',
    },
  };
}

describe('coordination public contracts', () => {
  it.each([
    'timeout',
    'blocked',
    'aborted',
    'error',
  ] as const)('preserves child %s status in the parent result', async (status) => {
    const result = await new AgentRunCoordinator().run(
      baseRunInput([{ id: 'a', tier: 0 }]),
      coordinationProfile(),
      async (input) => ({ ...childResult(input), status })
    );
    expect(result?.status).toBe(status);
  });
  it('partitions bootstrap dimensions by tier and merges child results deterministically', async () => {
    const coordinator = new AgentRunCoordinator();
    const tierEvents: number[] = [];
    const input = baseRunInput([
      { id: 'produce', tier: 1, prompt: 'produce records' },
      { id: 'scan', tier: 0, prompt: 'scan project' },
    ]);
    input.context.coordination = {
      onTierComplete: async (event) => {
        tierEvents.push(event.tierIndex);
      },
    };
    const profile = coordinationProfile();

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
    const profile = coordinationProfile();

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
