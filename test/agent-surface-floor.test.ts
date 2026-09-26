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
  getPreset,
  PRESETS,
} from '../src/agent/profiles/index.js';
import {
  collectEvolutionDecisionIds,
  projectEvolutionAuditResult,
} from '../src/agent/runs/evolution/EvolutionAgentRun.js';
import {
  projectRelationDiscoveryResult,
  runRelationDiscovery,
} from '../src/agent/runs/relation/RelationAgentRun.js';
import { runTranslationJson } from '../src/agent/runs/translation/TranslationAgentRun.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import type { ToolCallEntry } from '../src/agent/runtime/AgentRuntimeTypes.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunStatus,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import type { AgentService } from '../src/agent/service/AgentService.js';
import { AgentRunCoordinator } from '../src/agent/service/index.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';

const projectRoot = '/tmp/alembic-agent-surface-floor';

class BlockingPolicy extends Policy {
  get name() {
    return 'blocking';
  }

  override validateBefore() {
    return { ok: false, reason: 'blocked-before-run' };
  }
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

  it.each(['g', 'y'])('composes every safety policy with stateful pattern %s', (flags) => {
    const pattern = new RegExp('custom-denied', flags);
    pattern.lastIndex = 3;
    const engine = new PolicyEngine([
      new SafetyPolicy(),
      new SafetyPolicy({
        commandBlacklist: [pattern],
        fileScope: projectRoot,
        requireApprovalFor: ['meta'],
      }),
    ]);
    for (let i = 0; i < 3; i++) {
      expect(engine.validateToolCall('terminal', { params: { command: 'custom-denied' } }).ok).toBe(
        false
      );
    }
    expect(pattern.lastIndex).toBe(3);
    expect(engine.validateToolCall('meta', {}).ok).toBe(false);
    expect(engine.validateToolCall('code', { path: `${projectRoot}-other/file.ts` }).ok).toBe(
      false
    );
    expect(engine.validateToolCall('code', { path: `${projectRoot}/..notes/file.ts` }).ok).toBe(
      true
    );
  });

  it('keeps reasonless and empty-reply quality failures visible', () => {
    const custom = new QualityGatePolicy({
      minEvidenceLength: 0,
      minFileRefs: 0,
      minToolCalls: 0,
      customValidator: () => ({ ok: false }),
    });
    expect(custom.validateAfter({ reply: 'done' })).toMatchObject({
      ok: false,
      reason: expect.any(String),
    });
    const required = new QualityGatePolicy({
      minEvidenceLength: 5,
      minFileRefs: 1,
      minToolCalls: 0,
    });
    expect(required.validateAfter({ reply: '' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('分析长度不足'),
    });
    expect(required.validateAfter({})).toMatchObject({
      ok: false,
      reason: expect.stringContaining('文件引用不足'),
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
      custom: expect.any(Function),
    });
    expect(policy.toGateConfig().custom?.({ reply: 'deny src/file.ts' })).toMatchObject({
      pass: false,
      reason: 'custom rejection',
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

describe('pipeline quality decision adapters', () => {
  it('maps the quality policy validator to the pipeline pass contract', async () => {
    const gate = new QualityGatePolicy({
      minEvidenceLength: 0,
      minFileRefs: 0,
      minToolCalls: 0,
      customValidator: () => ({ ok: true }),
    }).toGateConfig();
    const result = await new PipelineStrategy({
      maxRetries: 0,
      stages: [{ name: 'analyze' }, { name: 'quality', gate }],
    }).execute(
      {
        id: 'pipeline',
        reactLoop: async () => ({
          reply: 'analysis',
          toolCalls: [],
          tokenUsage: { input: 0, output: 0 },
          iterations: 1,
        }),
      },
      new AgentMessage({ content: 'analyze' })
    );
    expect(result.outcome).toBe('completed');
  });
  it.each([
    { action: 'reject', pass: false },
    { action: 'pass', pass: false },
    { action: 'unknown', pass: false },
  ])('does not promote a negative gate $action to completed', async (decision) => {
    const loop = vi.fn(async () => ({
      reply: 'analysis',
      toolCalls: [],
      tokenUsage: { input: 0, output: 0 },
      iterations: 1,
    }));
    const result = await new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        { name: 'quality', gate: { evaluator: () => decision } },
        { name: 'produce' },
      ],
    }).execute({ id: 'pipeline', reactLoop: loop }, new AgentMessage({ content: 'analyze' }));
    expect(result.outcome).not.toBe('completed');
    expect(loop).toHaveBeenCalledOnce();
  });
});

describe('coordination public contracts', () => {
  it('rejects an unknown merger before child execution', async () => {
    const profile = coordinationProfile();
    if (!profile.concurrency) {
      throw new Error('Fixture requires concurrency');
    }
    profile.concurrency.merge = 'missing';
    const runChild = vi.fn(async (input: AgentRunInput) => childResult(input));
    await expect(
      new AgentRunCoordinator().run(baseRunInput([{ id: 'a', tier: 0 }]), profile, runChild)
    ).rejects.toThrow('Unknown agent run merger');
    expect(runChild).not.toHaveBeenCalled();
  });

  it.each([
    'child',
    'tier',
  ])('keeps confirmed receipts on %s consumption failure and stops pending work', async (kind) => {
    const input = baseRunInput([
      { id: 'a', tier: 0 },
      { id: 'b', tier: kind === 'tier' ? 1 : 0 },
    ]);
    input.context.coordination =
      kind === 'child'
        ? {
            onChildResult: async () => {
              throw new Error('persist child failed');
            },
          }
        : {
            onTierComplete: async () => {
              throw new Error('persist tier failed');
            },
          };
    const ran: string[] = [];
    const run = new AgentRunCoordinator().run(input, coordinationProfile(), async (child) => {
      ran.push(String(child.params?.dimId));
      return {
        ...childResult(child),
        toolCalls: [{ tool: 'knowledge', result: { id: 'confirmed' } }],
      };
    });
    const error = await run.then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      partialResult: { status: 'error', toolCalls: [{ result: { id: 'confirmed' } }] },
      coordinationFailures: [
        expect.objectContaining({ hook: kind === 'child' ? 'onChildResult' : 'onTierComplete' }),
      ],
    });
    expect(ran).toEqual(['a']);
  });

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

function coordinationLatch<T>() {
  return Promise.withResolvers<T>();
}

describe('coordination asynchronous admission', () => {
  it('does not start a pending child after sibling consumption fails during async abort check', async () => {
    const secondPreflight = coordinationLatch<boolean>();
    const failureObserved = coordinationLatch<void>();
    let checks = 0;
    const input: AgentRunInput = {
      profile: { id: 'parent' },
      message: { content: 'review' },
      params: { dimensions: [{ id: 'a' }, { id: 'b' }] },
      context: {
        source: 'internal',
        coordination: {
          onChildResult: async ({ childInput }) => {
            if (childInput.params?.dimId === 'a') {
              failureObserved.resolve();
              throw new Error('controlled consumer failure');
            }
          },
        },
      },
      execution: {
        shouldAbort: async () => {
          checks++;
          return checks === 4 ? secondPreflight.promise : false;
        },
      },
    };
    const profile: CompiledAgentProfile = {
      kind: 'compiled-agent-profile',
      id: 'parent',
      title: 'review',
      serviceKind: 'system-analysis',
      lifecycle: 'active',
      basePreset: 'chat',
      actionSpace: { mode: 'listed', toolIds: [] },
      additionalTools: [],
      params: {},
      runtimeOverrides: {},
      concurrency: {
        mode: 'parallel',
        concurrency: 2,
        partitioner: 'generateSessionDimensions',
        merge: 'generateSessionResults',
        childProfile: 'child',
      },
    };
    const ran: string[] = [];
    const resultPromise = new AgentRunCoordinator()
      .run(input, profile, async (child): Promise<AgentRunResult> => {
        ran.push(String(child.params?.dimId));
        return {
          runId: String(child.params?.dimId),
          profileId: 'child',
          reply: 'confirmed',
          status: 'success',
          toolCalls: [{ tool: 'knowledge', result: { id: String(child.params?.dimId) } }],
          usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
          diagnostics: null,
        };
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
    await failureObserved.promise;
    // 先让协调器观察回调拒绝，再解除 sibling 的异步 preflight。
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondPreflight.resolve(false);
    await resultPromise;
    expect(ran).toEqual(['a']);
  });
  it('rechecks an external AbortSignal after an async cancellation hook returns false', async () => {
    const controller = new AbortController();
    const entered = coordinationLatch<void>();
    const release = coordinationLatch<boolean>();
    let checks = 0;
    const input: AgentRunInput = {
      profile: { id: 'parent' },
      message: { content: 'review' },
      context: { source: 'internal' },
      params: { dimensions: [{ id: 'a' }] },
      execution: {
        abortSignal: controller.signal,
        shouldAbort: async () => {
          checks++;
          if (checks === 2) {
            entered.resolve();
            return release.promise;
          }
          return false;
        },
      },
    };
    const profile = {
      id: 'parent',
      concurrency: { mode: 'parallel', concurrency: 1, partitioner: 'generateSessionDimensions' },
    } as CompiledAgentProfile;
    let started = 0;
    const run = new AgentRunCoordinator().run(input, profile, async () => {
      started++;
      return {
        runId: 'unexpected',
        profileId: 'child',
        reply: 'ran',
        status: 'success',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, iterations: 0, durationMs: 0 },
        diagnostics: null,
      };
    });
    await entered.promise;
    controller.abort();
    release.resolve(false);
    await run;
    expect(started).toBe(0);
  });
  it('keeps each execution receipt when a public partitioner reuses an input object', async () => {
    const input: AgentRunInput = {
      profile: { id: 'parent' },
      message: { content: 'review' },
      context: { source: 'internal' },
    };
    const profile = {
      id: 'parent',
      concurrency: { mode: 'parallel', concurrency: 1, partitioner: 'repeat' },
    } as CompiledAgentProfile;
    let index = 0;
    const coordinator = new AgentRunCoordinator().registerPartitioner('repeat', () => [
      input,
      input,
    ]);
    const result = await coordinator.run(input, profile, async () => {
      index++;
      return {
        runId: String(index),
        profileId: 'child',
        reply: `receipt ${index}`,
        status: 'success',
        toolCalls: [{ tool: 'knowledge', result: { id: `confirmed-${index}` } }],
        usage: { inputTokens: index, outputTokens: 0, iterations: 1, durationMs: 0 },
        diagnostics: null,
      };
    });
    expect(index).toBe(2);
    expect(result?.toolCalls).toEqual([
      { tool: 'knowledge', result: { id: 'confirmed-1' } },
      { tool: 'knowledge', result: { id: 'confirmed-2' } },
    ]);
  });
});

describe('profile ownership and preset selection', () => {
  it.each(['__proto__', 'constructor', 'toString'])('rejects inherited preset name %s', (name) => {
    expect(() => getPreset(name)).toThrow('Unknown preset');
  });

  it('owns registered declarations and returns independent get/list snapshots', () => {
    const definition = {
      id: 'owned',
      title: 'Owned',
      serviceKind: 'system-analysis' as const,
      lifecycle: 'active' as const,
      basePreset: 'chat',
      defaults: {
        skills: ['conversation'],
        actionSpace: { mode: 'listed' as const, toolIds: ['memory'] },
      },
      strategy: { type: 'single' as const },
    };
    const registry = new AgentProfileRegistry([definition]);
    definition.defaults.skills.push('system_interaction');
    const first = registry.require('owned');
    first.defaults?.actionSpace?.mode === 'listed' &&
      first.defaults.actionSpace.toolIds.push('terminal');
    registry.list()[0].defaults?.skills?.push('code_analysis');
    expect(registry.require('owned').defaults).toEqual({
      skills: ['conversation'],
      actionSpace: { mode: 'listed', toolIds: ['memory'] },
    });
  });

  it('does not let a compiled profile mutate the next compilation', () => {
    const registry = new AgentProfileRegistry();
    const compiler = new AgentProfileCompiler({
      profileRegistry: registry,
      stageFactoryRegistry: new AgentStageFactoryRegistry(),
    });
    const first = compiler.compile({ id: 'scan-extract' });
    first.skills?.push('system_interaction');
    expect(compiler.compile({ id: 'scan-summarize' }).skills).toEqual(['code_analysis']);
  });

  it('owns the preset runtime configuration while retaining function and policy ports', () => {
    const before = [...PRESETS.chat.capabilities];
    const preset = getPreset('chat');
    try {
      (preset.capabilities as string[]).push('system_interaction');
      expect(getPreset('chat').capabilities).toEqual(before);
      expect((getPreset('chat').policies as unknown[])[0]).toBe(PRESETS.chat.policies[0]);
    } finally {
      PRESETS.chat.capabilities.splice(0, PRESETS.chat.capabilities.length, ...before);
    }
  });

  it('isolates mutable stage budgets and gates across factory calls', () => {
    const factories = new AgentStageFactoryRegistry();
    const first = factories.build('generateDimensionPipeline', { params: {} });
    const gate = first.find((stage) => stage.name === 'quality_gate')?.gate as {
      maxRetries: number;
    };
    const before = gate.maxRetries;
    try {
      gate.maxRetries = 99;
      const next = factories.build('generateDimensionPipeline', { params: {} });
      expect(
        (next.find((stage) => stage.name === 'quality_gate')?.gate as { maxRetries: number })
          .maxRetries
      ).toBe(before);
    } finally {
      PRESETS.insight.strategy.stages[1].gate.maxRetries = before;
    }
  });

  it('uses the same confirmed submission and evidence contract for insight and scan retries', () => {
    const previous = {
      produce: {
        toolCalls: [
          { tool: 'knowledge', args: { action: 'search' }, result: { status: 'error' } },
          { tool: 'knowledge', args: { action: 'submit' }, result: { status: 'rejected' } },
          {
            tool: 'knowledge',
            args: { action: 'submit' },
            envelope: { ok: false, text: 'blocked' },
          },
          {
            tool: 'knowledge',
            args: { action: 'submit' },
            result: { status: 'created', id: 'saved', lifecycle: 'pending' },
          },
        ],
      },
    };
    const factories = new AgentStageFactoryRegistry();
    for (const [name, params] of [
      ['generateDimensionPipeline', {}],
      ['scanPipeline', { task: 'extract' }],
    ] as const) {
      const stages = factories.build(name, { params });
      const stage = stages.find((value) => value.name === 'produce') as {
        retryPromptBuilder: (reason: object, input: string, prev: object) => string;
      };
      const prompt = stage.retryPromptBuilder({ reason: 'retry' }, '', previous);
      expect(prompt).toContain('你的 2 个提交');
      expect(prompt).toContain('reasoning.evidenceRefs');
      expect(prompt).toContain('无台账');
    }
  });
});

describe('run projection outcomes', () => {
  function runResult(
    toolCalls: ToolCallEntry[] = [],
    status: AgentRunStatus = 'success'
  ): AgentRunResult {
    return {
      runId: 'fixture',
      profileId: 'scan-extract',
      reply: 'finished',
      status,
      toolCalls,
      usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
      diagnostics: null,
    };
  }
  function submitted(result: unknown, envelope?: unknown): ToolCallEntry {
    return {
      tool: 'knowledge',
      args: { action: 'submit', params: { title: 'Verified', supersedes: 'old-recipe' } },
      result,
      durationMs: 1,
      ...(envelope ? { envelope: envelope as ToolCallEntry['envelope'] } : {}),
    };
  }
  const created = { status: 'created', id: 'real-recipe', lifecycle: 'pending' };

  it.each([
    'aborted',
    'timeout',
    'blocked',
    'error',
  ] as const)('does not emit writable relations from a %s run', async (status) => {
    const result = {
      ...runResult([], status),
      reply: JSON.stringify({
        analyzed: 2,
        relations: [{ from: 'one', to: 'two', type: 'depends_on' }],
      }),
    };
    const service = { run: vi.fn(async () => result) } as unknown as AgentService;
    await expect(runRelationDiscovery({ agentService: service })).rejects.toMatchObject({
      cause: result,
    });
  });
  it('counts a persisted superseding recipe as a proposed evolution outcome', () => {
    expect(
      projectEvolutionAuditResult({ reply: 'done', toolCalls: [submitted(created)], iterations: 1 })
        .proposed
    ).toBe(1);
  });
  it('retains translation fallback when the optional parse observer throws', async () => {
    const service = {
      run: vi.fn(async () => ({ ...runResult(), reply: 'not-json' })),
    } as unknown as AgentService;
    await expect(
      runTranslationJson({
        agentService: service,
        summary: '原文',
        usageGuide: '用法',
        onParseError: () => {
          throw new Error('observer failed');
        },
      })
    ).resolves.toEqual({ summaryEn: '原文', usageGuideEn: '用法' });
  });
});

it('keeps the preset strategy when an optional override is explicitly undefined', () => {
  expect(getPreset('insight', { strategy: undefined }).strategyInstance.name).toBe('pipeline');
});
