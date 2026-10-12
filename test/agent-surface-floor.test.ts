import Logger from '@alembic/core/logging';
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
  runEvolutionAudit,
} from '../src/agent/runs/evolution/EvolutionAgentRun.js';
import {
  projectRelationDiscoveryResult,
  runRelationDiscovery,
} from '../src/agent/runs/relation/RelationAgentRun.js';
import { runScanAgentTask } from '../src/agent/runs/scan/ScanAgentRun.js';
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
import { AgentRunCoordinator, SystemRunContextFactory } from '../src/agent/service/index.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import {
  type TaskContext,
  taskCheckAndSubmit,
  taskDiscoverAllRelations,
  taskGuardFullScan,
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
    // 生产形状：terminal 只有 {action:'exec', params:{command}}；code 的路径已由 runtimeSafetyGate
    // 按项目根解析成绝对路径；审批断言使用真实工具名。
    const engine = new PolicyEngine([
      new SafetyPolicy({ fileScope: projectRoot, requireApprovalFor: ['knowledge'] }),
    ]);

    expect(
      engine.validateToolCall('terminal', {
        action: 'exec',
        params: { command: 'sudo whoami' },
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('命令拦截'),
    });
    expect(
      engine.validateToolCall('code', {
        action: 'read',
        params: { path: `${projectRoot}/src/index.ts` },
      })
    ).toEqual({ ok: true });
    expect(
      engine.validateToolCall('code', { action: 'read', params: { path: '/tmp/outside.ts' } })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('路径拦截'),
    });
    expect(
      engine.validateToolCall('code', {
        action: 'write',
        params: { path: `${projectRoot}-other/file.ts`, content: 'x' },
      }).ok
    ).toBe(false);
    expect(
      engine.validateToolCall('code', {
        action: 'read',
        params: { filePaths: [`${projectRoot}/safe.ts`, `${projectRoot}-other/file.ts`] },
      }).ok
    ).toBe(false);
    // code.structure 的 directory 与其它路径参数同等检查。
    expect(
      engine.validateToolCall('code', {
        action: 'structure',
        params: { directory: `${projectRoot}-other` },
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('SAFETY_FILE_SCOPE_PATH'),
    });
    expect(
      engine.validateToolCall('code', {
        action: 'structure',
        params: { directory: `${projectRoot}/src` },
      })
    ).toEqual({ ok: true });
    // code.search 的搜索根恒为项目根（由 runtimeSafetyGate 放进 params.directory）：
    // 项目根不在 fileScope 内时带规则码拒绝，在 scope 内时放行。
    expect(
      engine.validateToolCall('code', {
        action: 'search',
        params: { patterns: ['token'], directory: '/tmp' },
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('SAFETY_FILE_SCOPE_SEARCH'),
    });
    expect(
      engine.validateToolCall('code', {
        action: 'search',
        params: { patterns: ['token'], directory: projectRoot },
      })
    ).toEqual({ ok: true });
    expect(
      engine.validateToolCall('knowledge', { action: 'submit', params: { title: 'x' } })
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
    expect(engine.validateToolCall('meta', { action: 'tools', params: {} }).ok).toBe(false);
    expect(
      engine.validateToolCall('code', {
        action: 'read',
        params: { path: `${projectRoot}-other/file.ts` },
      }).ok
    ).toBe(false);
    expect(
      engine.validateToolCall('code', {
        action: 'read',
        params: { path: `${projectRoot}/..notes/file.ts` },
      }).ok
    ).toBe(true);
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

  it.each([
    {
      partitioner: 'generateSessionDimensions',
      merge: 'generateSessionResults',
      params: { dimensions: [{ id: 'a' }, { dimId: 'a' }] },
      unitId: 'a',
    },
    {
      partitioner: 'projectContextModules',
      merge: 'moduleMiningResults',
      params: { modules: [{ moduleId: 'utils' }, { modulePath: 'utils' }] },
      unitId: 'utils',
    },
  ])('rejects duplicate fan-out unit ids from $partitioner before any child runs', async (fixture) => {
    const input = baseRunInput([]);
    input.params = fixture.params;
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    await expect(
      new AgentRunCoordinator().run(
        input,
        parallelCoordinationProfile(2, fixture.partitioner, fixture.merge),
        runChild
      )
    ).rejects.toThrow(`duplicate fan-out unit id: ${fixture.unitId}`);
    expect(runChild).not.toHaveBeenCalled();
  });

  it.each([
    {
      partitioner: 'generateSessionDimensions',
      merge: 'generateSessionResults',
      params: { dimensions: [{ id: 'a' }, { id: 'b' }] },
    },
    {
      partitioner: 'projectContextModules',
      merge: 'moduleMiningResults',
      params: { modules: [{ moduleId: 'a' }, { moduleId: 'b' }] },
    },
  ])('does not hand parent coordination hooks to $partitioner children', async (fixture) => {
    const input = baseRunInput([]);
    input.params = fixture.params;
    const parentCallbacks: string[] = [];
    const childOnChildResult = vi.fn();
    input.context.coordination = {
      onChildResult: ({ childInput }) => {
        parentCallbacks.push(String(childInput.params?.dimId ?? childInput.params?.moduleId));
      },
    };
    // 宿主按单元提供的专属 context 也不能把 coordination 回调塞给 child。
    input.context.childContexts = {
      a: { coordination: { onChildResult: childOnChildResult } },
    };
    const childContexts: AgentRunInput['context'][] = [];
    await new AgentRunCoordinator().run(
      input,
      parallelCoordinationProfile(1, fixture.partitioner, fixture.merge),
      async (child) => {
        childContexts.push(child.context);
        return childResult(child);
      }
    );
    expect(childContexts).toHaveLength(2);
    for (const context of childContexts) {
      expect(context.coordination).toBeUndefined();
      expect(Object.hasOwn(context, 'coordination')).toBe(false);
    }
    expect(childOnChildResult).not.toHaveBeenCalled();
    expect(parentCallbacks).toEqual(['a', 'b']);
  });

  it.each([
    { merge: 'generateSessionResults', idKey: 'dimId', resultsKey: 'dimensionResults' },
    { merge: 'moduleMiningResults', idKey: 'moduleId', resultsKey: 'moduleResults' },
  ])('keys $merge results by the partitioned child unit id', async (fixture) => {
    const input: AgentRunInput = {
      profile: { id: 'parent' },
      message: { content: 'review' },
      context: { source: 'internal' },
    };
    const children = ['x', 'y'].map(
      (unitId): AgentRunInput => ({
        ...input,
        params: { [fixture.idKey]: unitId },
      })
    );
    const coordinator = new AgentRunCoordinator().registerPartitioner('explicit', () => children);
    const result = await coordinator.run(
      input,
      parallelCoordinationProfile(1, 'explicit', fixture.merge),
      async (child) => {
        const unitId = String(child.params?.[fixture.idKey]);
        return {
          ...childResult(child),
          runId: `${unitId}:run`,
          phases:
            unitId === 'y'
              ? {
                  _pipelineOutcome: {
                    outcome: 'abandoned',
                    stage: 'quality_gate',
                    action: 'degrade',
                    reason: 'weak evidence',
                  },
                }
              : {},
        };
      }
    );
    const phases = result?.phases as Record<string, unknown>;
    expect(Object.keys(phases[fixture.resultsKey] as Record<string, unknown>)).toEqual(['x', 'y']);
    expect(phases[fixture.resultsKey]).toMatchObject({
      x: { runId: 'x:run' },
      y: { runId: 'y:run' },
    });
    const abandonedKey =
      fixture.resultsKey === 'dimensionResults' ? 'abandonedDimensions' : 'abandonedModules';
    expect(phases[abandonedKey]).toEqual([
      { unitId: 'y', stage: 'quality_gate', action: 'degrade', reason: 'weak evidence' },
    ]);
  });

  it('aggregates abandoned bootstrap dimensions into the parent result', async () => {
    const result = await new AgentRunCoordinator().run(
      baseRunInput([
        { id: 'a', tier: 0 },
        { id: 'b', tier: 0 },
      ]),
      coordinationProfile(),
      async (child) => ({
        ...childResult(child),
        phases:
          child.params?.dimId === 'b'
            ? {
                _pipelineOutcome: {
                  outcome: 'abandoned',
                  stage: 'quality_gate',
                  action: 'degrade',
                  reason: 'weak evidence',
                },
              }
            : {},
      })
    );
    expect(result?.phases?.abandonedDimensions).toEqual([
      { unitId: 'b', stage: 'quality_gate', action: 'degrade', reason: 'weak evidence' },
    ]);
  });
});

function parallelCoordinationProfile(
  concurrency: number,
  partitioner = 'generateSessionDimensions',
  merge = 'generateSessionResults'
): CompiledAgentProfile {
  return {
    ...coordinationProfile(),
    concurrency: {
      mode: 'parallel',
      concurrency,
      partitioner,
      merge,
      childProfile: 'child-profile',
    },
  };
}

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

  it('resolves a lazy child input factory only when that child executes', async () => {
    const input = baseRunInput([
      { id: 'overview', tier: 0 },
      { id: 'api', tier: 1 },
    ]);
    const factory = vi.fn(({ plannedInput }: { plannedInput: AgentRunInput }) => ({
      ...plannedInput,
      context: {
        ...plannedInput.context,
        promptContext: { ...(plannedInput.context.promptContext || {}), createdLazily: true },
      },
    }));
    input.context.childInputFactories = { overview: factory };
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const run = new AgentRunCoordinator().run(input, coordinationProfile(), runChild);
    // 分区阶段只产出计划输入，工厂必须等到该 child 真正拿到额度开工时才调用。
    expect(factory).not.toHaveBeenCalled();
    await run;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0].plannedInput.params?.dimId).toBe('overview');
    expect(runChild.mock.calls[0][0].context.promptContext).toMatchObject({ createdLazily: true });
    expect(runChild.mock.calls[1][0].context.promptContext).not.toHaveProperty('createdLazily');
  });

  it('records an aborted child when cancellation is requested while its factory runs', async () => {
    const input = baseRunInput([{ id: 'overview', tier: 0 }]);
    let lazyResolved = false;
    input.execution = { shouldAbort: () => lazyResolved };
    input.context.childInputFactories = {
      overview: ({ plannedInput }) => {
        lazyResolved = true;
        return plannedInput;
      },
    };
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const result = await new AgentRunCoordinator().run(input, coordinationProfile(), runChild);
    expect(runChild).not.toHaveBeenCalled();
    expect(result?.status).toBe('aborted');
    expect(result?.phases?.dimensionResults).toEqual({
      overview: expect.objectContaining({ runId: 'overview:aborted', status: 'aborted' }),
    });
  });

  it('converts a throwing child input factory into that child error result', async () => {
    const input = baseRunInput([{ id: 'overview', tier: 0 }]);
    const events: string[] = [];
    input.context.childInputFactories = {
      overview: () => {
        throw new Error('scope failed');
      },
    };
    input.context.coordination = {
      onChildResult: ({ childInput, result }) => {
        events.push(`${childInput.params?.dimId}:${result.status}:${result.reply}`);
      },
    };
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const result = await new AgentRunCoordinator().run(input, coordinationProfile(), runChild);
    expect(runChild).not.toHaveBeenCalled();
    expect(events).toEqual(['overview:error:scope failed']);
    expect(result).toMatchObject({
      status: 'error',
      phases: { dimensionResults: { overview: { status: 'error', reply: 'scope failed' } } },
    });
  });

  it('calls the next lazy factory only after the previous child settles at concurrency 1', async () => {
    const input = baseRunInput([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const events: string[] = [];
    input.context.childInputFactories = Object.fromEntries(
      ['a', 'b', 'c'].map((dimId) => [
        dimId,
        ({ plannedInput }: { plannedInput: AgentRunInput }) => {
          events.push(`factory:${dimId}`);
          return plannedInput;
        },
      ])
    );
    input.context.coordination = {
      onChildResult: ({ childInput }) => {
        events.push(`settled:${childInput.params?.dimId}`);
      },
    };
    await new AgentRunCoordinator().run(input, parallelCoordinationProfile(1), async (child) => {
      const dimId = String(child.params?.dimId);
      events.push(`run:${dimId}:start`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      events.push(`run:${dimId}:end`);
      return childResult(child);
    });
    expect(events).toEqual(
      ['a', 'b', 'c'].flatMap((dimId) => [
        `factory:${dimId}`,
        `run:${dimId}:start`,
        `run:${dimId}:end`,
        `settled:${dimId}`,
      ])
    );
  });

  it('settles a malformed factory product as that child error after siblings settle', async () => {
    const input = baseRunInput([{ id: 'a' }, { id: 'b' }]);
    const releaseSibling = coordinationLatch<void>();
    const events: string[] = [];
    input.context.childInputFactories = {
      // 模拟违反 AgentChildInputFactory 类型的 JS 宿主：产物缺 message 与 context。
      a: () => ({ profile: { id: 'c' } }) as unknown as AgentRunInput,
    };
    input.context.coordination = {
      onChildResult: ({ childInput, result }) => {
        events.push(`cb:${childInput.params?.dimId}:${result.status}`);
      },
    };
    const ran: string[] = [];
    const settled = new AgentRunCoordinator()
      .run(input, parallelCoordinationProfile(2), async (child) => {
        // 与 AgentService.validateRunInput 一致：缺 message.content 时 child run 抛错。
        if (!child.message?.content) {
          throw new Error('AgentRunInput.message.content is required');
        }
        const dimId = String(child.params?.dimId);
        ran.push(dimId);
        if (dimId === 'b') {
          await releaseSibling.promise;
          events.push('b-finished');
        }
        return childResult(child);
      })
      .then(
        (value) => {
          events.push('settled');
          return { value, error: undefined };
        },
        (error: unknown) => {
          events.push('rejected');
          return { value: undefined, error };
        }
      );
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSibling.resolve();
    const outcome = await settled;
    expect(outcome.error).toBeUndefined();
    expect(events).toEqual(['cb:a:error', 'b-finished', 'cb:b:success', 'settled']);
    expect(ran).toEqual(['b']);
    expect(outcome.value).toMatchObject({
      status: 'error',
      phases: {
        dimensionResults: {
          a: {
            runId: 'a:error',
            status: 'error',
            reply: expect.stringContaining('childInputFactories[a] returned invalid AgentRunInput'),
          },
          b: { status: 'success' },
        },
      },
    });
  });

  it.each([
    'error',
    'aborted',
  ] as const)('derives the %s receipt identity from the planned child, not the factory product', async (status) => {
    const input = baseRunInput([{ id: 'a' }]);
    let lazyResolved = false;
    input.execution = { shouldAbort: () => status === 'aborted' && lazyResolved };
    input.context.childInputFactories = {
      a: ({ plannedInput }) => {
        lazyResolved = true;
        return {
          ...plannedInput,
          profile: { id: 'renamed-profile' },
          params: { ...plannedInput.params, dimId: 'renamed' },
          message: {
            ...plannedInput.message,
            metadata: { ...plannedInput.message.metadata, dimension: 'renamed' },
          },
        };
      },
    };
    const result = await new AgentRunCoordinator().run(
      input,
      parallelCoordinationProfile(1),
      async () => {
        throw new Error('child exploded');
      }
    );
    expect(result?.status).toBe(status);
    expect(result?.phases?.dimensionResults).toEqual({
      a: expect.objectContaining({
        runId: `a:${status}`,
        profileId: 'child-profile',
        status,
        phases: expect.objectContaining({ dimId: 'a' }),
      }),
    });
  });

  it('reports an unreadable custom-partitioner child as a coordination failure, not a raw TypeError', async () => {
    const input: AgentRunInput = {
      profile: { id: 'parent' },
      message: { content: 'review' },
      context: { source: 'internal' },
    };
    // 自定义 partitioner 产出缺 message 的 child：读取 dimId/tier 的辅助函数都会抛 TypeError。
    const malformed = { profile: { id: 'child' }, context: { source: 'internal' } };
    const coordinator = new AgentRunCoordinator().registerPartitioner(
      'malformed',
      () => [{ ...input, params: { dimId: 'normal' } }, malformed] as AgentRunInput[]
    );
    const profile = {
      id: 'parent',
      concurrency: { mode: 'parallel', concurrency: 2, partitioner: 'malformed' },
    } as CompiledAgentProfile;
    const error = await coordinator
      .run(input, profile, async (child) => childResult(child))
      .then(
        () => null,
        (err: unknown) => err
      );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringContaining('Agent coordination consumption failed'),
      coordinationFailures: [expect.objectContaining({ hook: 'runOneChild' })],
      partialResult: {
        status: 'error',
        phases: {
          childResults: [
            expect.objectContaining({ status: expect.any(String) }),
            expect.objectContaining({ runId: 'child:error', status: 'error' }),
          ],
        },
      },
    });
  });

  it('settles every started sibling before rejecting on an unexpected child settlement error', async () => {
    const input: AgentRunInput = {
      profile: { id: 'parent' },
      message: { content: 'review' },
      context: { source: 'internal' },
    };
    const normal: AgentRunInput = { ...input, params: { dimId: 'normal' } };
    // 模拟派发之后才出现的意外异常：normal 开跑后，hostile 的 params 变得不可读，
    // 让 hostile 在 error 降级的日志定位处抛出 settleChild 之外的异常。
    let armed = false;
    const hostile: AgentRunInput = { ...input };
    Object.defineProperty(hostile, 'params', {
      enumerable: true,
      get() {
        if (armed) {
          throw new Error('hostile params');
        }
        return { dimId: 'hostile' };
      },
    });
    const normalStarted = coordinationLatch<void>();
    const releaseSibling = coordinationLatch<void>();
    const events: string[] = [];
    const coordinator = new AgentRunCoordinator().registerPartitioner('hostile', () => [
      normal,
      hostile,
    ]);
    const profile = {
      id: 'parent',
      concurrency: { mode: 'parallel', concurrency: 2, partitioner: 'hostile' },
    } as CompiledAgentProfile;
    const settled = coordinator
      .run(input, profile, async (child) => {
        if (child === normal) {
          armed = true;
          normalStarted.resolve();
          await releaseSibling.promise;
          events.push('normal-finished');
          return childResult(child);
        }
        await normalStarted.promise;
        throw new Error('hostile run failed');
      })
      .then(
        () => ({ error: undefined }),
        (error: unknown) => {
          events.push('rejected');
          return { error };
        }
      );
    await normalStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSibling.resolve();
    const outcome = await settled;
    expect(events).toEqual(['normal-finished', 'rejected']);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).toMatchObject({
      message: expect.stringContaining('Agent coordination consumption failed: hostile params'),
      coordinationFailures: [expect.objectContaining({ hook: 'runOneChild' })],
      partialResult: {
        status: 'error',
        phases: {
          childResults: [
            expect.objectContaining({ status: 'success' }),
            expect.objectContaining({ status: 'error', reply: 'hostile params' }),
          ],
        },
      },
    });
  });
});

/**
 * 在给定真实时间内等待 promise 结算；超时返回 settled=false，避免回归时测试整段挂到 testTimeout。
 */
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ settled: true; value?: T; error?: unknown } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ settled: true as const, value }),
        (error: unknown) => ({ settled: true as const, error })
      ),
      guard,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// I19：协调器的取消探针必须与 abortSignal / timeoutMs 竞速，且探针抛错在 parallel、tiered、
// child 级与 tier 级都统一归为协调失败（父 run 抛带 partialResult 的协调错误），不再记成 child error。
describe('coordination cancellation check racing and classification', () => {
  it('ends a parallel run as aborted when abortSignal fires while an async shouldAbort hangs', async () => {
    const controller = new AbortController();
    const entered = coordinationLatch<void>();
    const shouldAbort = vi.fn(() => {
      entered.resolve();
      return new Promise<boolean>(() => {});
    });
    const input = baseRunInput([{ id: 'a' }, { id: 'b' }]);
    input.execution = { abortSignal: controller.signal, shouldAbort };
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const run = new AgentRunCoordinator().run(input, parallelCoordinationProfile(1), runChild);
    await entered.promise;
    controller.abort();
    const outcome = await settleWithin(run, 1000);
    expect(outcome).toMatchObject({ settled: true, value: { status: 'aborted' } });
    expect(runChild).not.toHaveBeenCalled();
    expect(shouldAbort).toHaveBeenCalledTimes(1);
    expect(outcome.settled && outcome.value?.phases?.dimensionResults).toEqual({
      a: expect.objectContaining({ status: 'aborted', reply: 'child-run-aborted' }),
      b: expect.objectContaining({ status: 'aborted', reply: 'child-run-aborted' }),
    });
  });

  it.each([
    'parallel',
    'tiered',
  ] as const)('bounds each hanging %s shouldAbort check by execution.timeoutMs', async (mode) => {
    const shouldAbort = vi.fn(() => new Promise<boolean>(() => {}));
    const input = baseRunInput([{ id: 'a' }, { id: 'b' }]);
    input.execution = { shouldAbort, timeoutMs: 20 };
    const onChildResult = vi.fn();
    input.context.coordination = { onChildResult };
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const profile = mode === 'parallel' ? parallelCoordinationProfile(1) : coordinationProfile();
    const outcome = await settleWithin(
      new AgentRunCoordinator().run(input, profile, runChild),
      1000
    );
    // 超时视为“请求取消”：child 记 aborted 回执并照常通知宿主，不构成协调失败。
    expect(outcome).toMatchObject({ settled: true, value: { status: 'aborted' } });
    expect(outcome.settled && outcome.error).toBeFalsy();
    expect(runChild).not.toHaveBeenCalled();
    expect(onChildResult).toHaveBeenCalledTimes(2);
    // tiered 在 tier 边界检查一次即整批取消；parallel 每个 child 各自一次有界检查。
    expect(shouldAbort).toHaveBeenCalledTimes(mode === 'parallel' ? 2 : 1);
  });

  it.each([
    {
      mode: 'parallel',
      hook: 'sync throw',
      failure: { hook: 'shouldAbort', childId: 'a' },
    },
    {
      mode: 'parallel',
      hook: 'async reject',
      failure: { hook: 'shouldAbort', childId: 'a' },
    },
    {
      mode: 'tiered',
      hook: 'sync throw',
      failure: { hook: 'shouldAbort', tierIndex: 0 },
    },
  ] as const)('raises the coordination error for a $mode predicate $hook and stops calling the hook', async ({
    mode,
    hook,
    failure,
  }) => {
    const shouldAbort = vi.fn((): boolean | Promise<boolean> => {
      if (hook === 'async reject') {
        return Promise.reject(new Error('predicate broken'));
      }
      throw new Error('predicate broken');
    });
    const input = baseRunInput([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    input.execution = { shouldAbort };
    const onChildResult = vi.fn();
    input.context.coordination = { onChildResult };
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const profile = mode === 'parallel' ? parallelCoordinationProfile(1) : coordinationProfile();
    const error = await new AgentRunCoordinator().run(input, profile, runChild).then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Agent coordination consumption failed: predicate broken',
      coordinationFailures: [expect.objectContaining(failure)],
      partialResult: {
        status: 'error',
        phases: {
          childResults: [
            expect.objectContaining({ status: 'aborted', runId: 'a:aborted' }),
            expect.objectContaining({ status: 'aborted', runId: 'b:aborted' }),
            expect.objectContaining({ status: 'aborted', runId: 'c:aborted' }),
          ],
        },
      },
    });
    expect((error as { coordinationFailures: unknown[] }).coordinationFailures).toHaveLength(1);
    expect(shouldAbort).toHaveBeenCalledTimes(1);
    expect(runChild).not.toHaveBeenCalled();
    // 谓词故障不是维度失败：宿主不应收到任何 error 回执（否则会 consumeDimensionError）。
    expect(onChildResult.mock.calls.map(([event]) => event.result.status)).not.toContain('error');
  });

  it('classifies a tiered predicate that starts failing at a child check as a coordination failure', async () => {
    let calls = 0;
    const input = baseRunInput([
      { id: 'a', tier: 0 },
      { id: 'b', tier: 0 },
      { id: 'c', tier: 1 },
    ]);
    input.execution = {
      shouldAbort: () => {
        calls++;
        if (calls >= 2) {
          throw new Error('predicate broken');
        }
        return false;
      },
    };
    const childStatuses: string[] = [];
    input.context.coordination = {
      onChildResult: ({ childInput, result }) => {
        childStatuses.push(`${childInput.params?.dimId}:${result.status}`);
      },
    };
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const error = await new AgentRunCoordinator().run(input, coordinationProfile(), runChild).then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toMatchObject({
      message: 'Agent coordination consumption failed: predicate broken',
      coordinationFailures: [{ hook: 'shouldAbort', childId: 'a', message: 'predicate broken' }],
      partialResult: {
        status: 'error',
        phases: {
          childResults: [
            expect.objectContaining({ status: 'aborted' }),
            expect.objectContaining({ status: 'aborted' }),
            expect.objectContaining({ status: 'aborted' }),
          ],
        },
      },
    });
    // tier 检查 1 次 + child a 检查 1 次；坏 hook 之后不再被调用。
    expect(calls).toBe(2);
    expect(runChild).not.toHaveBeenCalled();
    expect(childStatuses).toEqual([]);
  });

  it('classifies a predicate failing after lazy child construction as a coordination failure', async () => {
    let calls = 0;
    const input = baseRunInput([{ id: 'a' }, { id: 'b' }]);
    input.execution = {
      shouldAbort: async () => {
        calls++;
        if (calls === 2) {
          throw new Error('post-factory predicate broken');
        }
        return false;
      },
    };
    const factory = vi.fn(({ plannedInput }: { plannedInput: AgentRunInput }) => plannedInput);
    input.context.childInputFactories = { a: factory, b: factory };
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const error = await new AgentRunCoordinator()
      .run(input, parallelCoordinationProfile(1), runChild)
      .then(
        () => null,
        (err: unknown) => err
      );
    expect(error).toMatchObject({
      message: 'Agent coordination consumption failed: post-factory predicate broken',
      coordinationFailures: [{ hook: 'shouldAbort', childId: 'a' }],
      partialResult: {
        phases: {
          childResults: [
            expect.objectContaining({ runId: 'a:aborted', status: 'aborted' }),
            expect.objectContaining({ runId: 'b:aborted', status: 'aborted' }),
          ],
        },
      },
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(runChild).not.toHaveBeenCalled();
  });

  it.each([
    'timeout',
    'aborted',
    'error',
  ] as const)('logs a locatable %s cancellation check outcome', async (outcome) => {
    const logs: Array<{ level: string; message: string; meta: Record<string, unknown> }> = [];
    const logger = Logger.getInstance();
    const capture = (level: string) => (message: unknown, meta?: unknown) => {
      logs.push({
        level,
        message: String(message),
        meta: meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {},
      });
    };
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(capture('info'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(capture('warn'));
    try {
      const controller = new AbortController();
      const entered = coordinationLatch<void>();
      const input = baseRunInput([{ id: 'a' }]);
      input.execution = {
        abortSignal: controller.signal,
        timeoutMs: outcome === 'timeout' ? 20 : undefined,
        shouldAbort: () => {
          entered.resolve();
          if (outcome === 'error') {
            throw new Error('predicate broken');
          }
          return new Promise<boolean>(() => {});
        },
      };
      const run = new AgentRunCoordinator()
        .run(input, parallelCoordinationProfile(1), async (child) => childResult(child))
        .catch(() => null);
      await entered.promise;
      if (outcome === 'aborted') {
        controller.abort();
      }
      await settleWithin(run, 1000);
      const coordinatorLogs = logs.filter((log) => log.message.startsWith('[AgentRunCoordinator]'));
      const expected = {
        timeout: {
          level: 'warn',
          message: expect.stringContaining('cancellation check timed out'),
          meta: expect.objectContaining({
            checkpoint: 'child-pre-dispatch',
            childId: 'a',
            outcome: 'timeout',
            timeoutMs: 20,
          }),
        },
        aborted: {
          level: 'info',
          message: expect.stringContaining('cancellation check interrupted by abortSignal'),
          meta: expect.objectContaining({
            checkpoint: 'child-pre-dispatch',
            childId: 'a',
            outcome: 'aborted',
          }),
        },
        error: {
          level: 'warn',
          message: expect.stringContaining('coordination hook failed'),
          meta: expect.objectContaining({
            hook: 'shouldAbort',
            checkpoint: 'child-pre-dispatch',
            childId: 'a',
            error: 'predicate broken',
          }),
        },
      }[outcome];
      expect(coordinatorLogs).toContainEqual(expected);
      const skipReason = {
        timeout: 'shouldAbort-timeout',
        aborted: 'abortSignal',
        error: 'shouldAbort-error',
      }[outcome];
      expect(coordinatorLogs).toContainEqual({
        level: outcome === 'aborted' ? 'info' : 'warn',
        message: expect.stringContaining(`child skipped profile=parent-profile child=a`),
        meta: expect.objectContaining({ reason: skipReason }),
      });
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('wraps a non-Error predicate rejection into an Error before classifying it', async () => {
    const input = baseRunInput([{ id: 'a' }]);
    input.execution = { shouldAbort: () => Promise.reject('raw string failure') };
    const error = await new AgentRunCoordinator()
      .run(input, parallelCoordinationProfile(1), async (child) => childResult(child))
      .then(
        () => null,
        (err: unknown) => err
      );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Agent coordination consumption failed: Agent cancellation check failed',
      coordinationFailures: [{ hook: 'shouldAbort', childId: 'a' }],
    });
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).cause).toBe('raw string failure');
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

// L8-C01：其余 run helper 与 TaskContext 必须把宿主取消/期限信号原样并入 execution（或 AI 直调
// 选项）；不传信号时输入形状与旧版逐字节一致（这些 helper 旧版没有 execution 键）。
describe('run helper and task context cancellation signals', () => {
  function capturedRun(status: AgentRunStatus = 'success', reply = 'finished') {
    const calls: AgentRunInput[] = [];
    const run = vi.fn(async (input: AgentRunInput): Promise<AgentRunResult> => {
      calls.push(input);
      return {
        runId: 'signal-fixture',
        profileId: input.profile.id ?? 'unknown',
        reply,
        status,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
        diagnostics: null,
      };
    });
    return { calls, service: { run } as unknown as AgentService };
  }
  function signals() {
    const controller = new AbortController();
    const shouldAbort = vi.fn(() => false);
    return { controller, shouldAbort, timeoutMs: 12_345 };
  }
  const evolutionRecipe = { id: 'recipe-1', title: 'Recipe', trigger: '@recipe' };
  const overview = { primaryLang: 'ts', fileCount: 1, modules: ['core'] };

  it('forwards signals from runEvolutionAudit and surfaces an aborted run as a failure', async () => {
    const { calls, service } = capturedRun('aborted', 'Agent run aborted before execution');
    const { controller, shouldAbort, timeoutMs } = signals();
    await expect(
      runEvolutionAudit({
        agentService: service,
        recipes: [evolutionRecipe],
        projectOverview: overview,
        abortSignal: controller.signal,
        shouldAbort,
        timeoutMs,
      })
    ).rejects.toMatchObject({ partialResult: { status: 'aborted' } });
    expect(calls[0]?.execution).toEqual({
      abortSignal: controller.signal,
      shouldAbort,
      timeoutMs,
    });
  });

  it('keeps runEvolutionAudit input without an execution key when no signal is passed', async () => {
    const { calls, service } = capturedRun('aborted');
    await expect(
      runEvolutionAudit({
        agentService: service,
        recipes: [evolutionRecipe],
        projectOverview: overview,
      })
    ).rejects.toBeInstanceOf(Error);
    expect(calls[0]).not.toHaveProperty('execution');
    expect(Object.keys(calls[0] ?? {})).toEqual([
      'profile',
      'params',
      'message',
      'context',
      'presentation',
    ]);
  });

  it('forwards signals from runRelationDiscovery and keeps the old shape without them', async () => {
    const withSignals = capturedRun('aborted');
    const { controller, shouldAbort, timeoutMs } = signals();
    await expect(
      runRelationDiscovery({
        agentService: withSignals.service,
        batchSize: 5,
        abortSignal: controller.signal,
        shouldAbort,
        timeoutMs,
      })
    ).rejects.toMatchObject({ partialResult: { status: 'aborted' } });
    expect(withSignals.calls[0]?.execution).toEqual({
      abortSignal: controller.signal,
      shouldAbort,
      timeoutMs,
    });
    expect(withSignals.calls[0]?.params).toEqual({ batchSize: 5 });

    const withoutSignals = capturedRun('success', '{"analyzed":0,"relations":[]}');
    await runRelationDiscovery({ agentService: withoutSignals.service });
    expect(withoutSignals.calls[0]).not.toHaveProperty('execution');
  });

  it('forwards signals from runScanAgentTask without touching the system run context', async () => {
    const withSignals = capturedRun('success', '{}');
    const { controller, shouldAbort, timeoutMs } = signals();
    await runScanAgentTask({
      agentService: withSignals.service,
      systemRunContextFactory: new SystemRunContextFactory(),
      label: 'signals',
      files: [{ name: 'a.ts', content: 'export const a = 1;' }],
      abortSignal: controller.signal,
      shouldAbort,
      timeoutMs,
    });
    expect(withSignals.calls[0]?.execution).toEqual({
      abortSignal: controller.signal,
      shouldAbort,
      timeoutMs,
    });
    expect(withSignals.calls[0]?.context).toMatchObject({
      source: 'system-workflow',
      runtimeSource: 'system',
    });

    const withoutSignals = capturedRun('success', '{}');
    await runScanAgentTask({
      agentService: withoutSignals.service,
      systemRunContextFactory: new SystemRunContextFactory(),
      label: 'no-signals',
    });
    expect(withoutSignals.calls[0]).not.toHaveProperty('execution');
  });

  it('forwards signals from runTranslationJson and keeps the original text on an aborted run', async () => {
    const withSignals = capturedRun('aborted', 'Agent run aborted before execution');
    const { controller, timeoutMs } = signals();
    await expect(
      runTranslationJson({
        agentService: withSignals.service,
        summary: '原文',
        usageGuide: '用法',
        abortSignal: controller.signal,
        timeoutMs,
      })
    ).resolves.toEqual({
      summaryEn: '原文',
      usageGuideEn: '用法',
      error: 'Agent run aborted before execution',
    });
    expect(withSignals.calls[0]?.execution).toEqual({ abortSignal: controller.signal, timeoutMs });

    const withoutSignals = capturedRun('success', '{"summaryEn":"s","usageGuideEn":"u"}');
    await runTranslationJson({ agentService: withoutSignals.service, summary: '原文' });
    expect(withoutSignals.calls[0]).not.toHaveProperty('execution');
  });

  function taskEnvelope(structuredContent: unknown): ToolResultEnvelope {
    return {
      ok: true,
      status: 'success',
      toolId: 'task-tool',
      callId: 'task-tool-call',
      startedAt: '2026-10-11T00:00:00.000Z',
      durationMs: 1,
      text: 'ok',
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
  function taskContext(
    structuredContent: unknown,
    overrides: Partial<TaskContext> = {}
  ): TaskContext & { warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    return {
      invokeToolEnvelope: vi.fn(async () => taskEnvelope(structuredContent)),
      container: { get: () => undefined },
      logger: { warn },
      ...overrides,
      warn,
    };
  }
  const similarCandidates = { similar: [{ title: 'Existing', similarity: 0.92 }] };

  it('forwards the task signal to runRelationDiscovery from taskDiscoverAllRelations', async () => {
    const withSignal = capturedRun('success', '{"analyzed":0,"relations":[]}');
    const controller = new AbortController();
    await taskDiscoverAllRelations(
      taskContext(
        {},
        {
          container: { get: () => withSignal.service },
          signal: controller.signal,
        }
      ),
      { batchSize: 7 }
    );
    expect(withSignal.calls[0]?.execution).toEqual({ abortSignal: controller.signal });
    expect(withSignal.calls[0]?.params).toEqual({ batchSize: 7 });

    const withoutSignal = capturedRun('success', '{"analyzed":0,"relations":[]}');
    await taskDiscoverAllRelations(
      taskContext({}, { container: { get: () => withoutSignal.service } })
    );
    expect(withoutSignal.calls[0]).not.toHaveProperty('execution');
  });

  it('passes the task signal to the duplicate verdict AI call and keeps options unchanged without it', async () => {
    const controller = new AbortController();
    const chat = vi.fn(async () => 'UNIQUE');
    const chatWithStructuredOutput = vi.fn(async () => []);
    await taskCheckAndSubmit(
      taskContext(similarCandidates, {
        aiProvider: { chat, chatWithStructuredOutput },
        signal: controller.signal,
      }),
      { candidate: { title: 'Candidate', code: 'x' } }
    );
    expect(chat).toHaveBeenCalledWith(expect.any(String), {
      temperature: 0,
      maxTokens: 20,
      abortSignal: controller.signal,
    });

    const plainChat = vi.fn(async () => 'UNIQUE');
    await taskCheckAndSubmit(
      taskContext(similarCandidates, {
        aiProvider: { chat: plainChat, chatWithStructuredOutput },
      }),
      { candidate: { title: 'Candidate', code: 'x' } }
    );
    expect(plainChat).toHaveBeenCalledWith(expect.any(String), { temperature: 0, maxTokens: 20 });
  });

  it('fails check_and_submit with a logged abort instead of a degraded recommendation', async () => {
    const controller = new AbortController();
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    const chat = vi.fn(async () => {
      controller.abort(new Error('client disconnected'));
      throw abortError;
    });
    const context = taskContext(similarCandidates, {
      aiProvider: { chat, chatWithStructuredOutput: vi.fn(async () => []) },
      signal: controller.signal,
    });

    await expect(
      taskCheckAndSubmit(context, { candidate: { title: 'Candidate', code: 'x' } })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/check_and_submit aborted/u),
      cause: abortError,
    });
    expect(context.warn).toHaveBeenCalledWith(
      expect.stringContaining('check_and_submit'),
      expect.objectContaining({ code: 'AGENT_TASK_ABORTED', task: 'check_and_submit' })
    );
  });

  it('keeps the optional AI verdict fallback for non-cancellation failures', async () => {
    const chat = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    await expect(
      taskCheckAndSubmit(
        taskContext(similarCandidates, {
          aiProvider: { chat, chatWithStructuredOutput: vi.fn(async () => []) },
        }),
        { candidate: { title: 'Candidate', code: 'x' } }
      )
    ).resolves.toMatchObject({ aiVerdict: null, recommendation: 'review_suggested' });
  });

  it('passes the task signal to guard suggestions and fails the scan when it is cancelled', async () => {
    const violations = { violationCount: 1, violations: [{ severity: 'error', message: 'bad' }] };
    const controller = new AbortController();
    const chatWithStructuredOutput = vi.fn(async () => [{ violation: 'bad', suggestion: 'fix' }]);
    await taskGuardFullScan(
      taskContext(violations, {
        aiProvider: { chat: vi.fn(async () => ''), chatWithStructuredOutput },
        signal: controller.signal,
      }),
      { code: 'const a = 1;', language: 'ts' }
    );
    expect(chatWithStructuredOutput).toHaveBeenCalledWith(expect.any(String), {
      openChar: '[',
      closeChar: ']',
      temperature: 0.3,
      abortSignal: controller.signal,
    });

    const plainStructured = vi.fn(async () => []);
    await taskGuardFullScan(
      taskContext(violations, {
        aiProvider: { chat: vi.fn(async () => ''), chatWithStructuredOutput: plainStructured },
      }),
      { code: 'const a = 1;', language: 'ts' }
    );
    expect(plainStructured).toHaveBeenCalledWith(expect.any(String), {
      openChar: '[',
      closeChar: ']',
      temperature: 0.3,
    });

    const cancelled = new AbortController();
    const cancelledContext = taskContext(violations, {
      aiProvider: {
        chat: vi.fn(async () => ''),
        chatWithStructuredOutput: vi.fn(async () => {
          cancelled.abort();
          throw new Error('aborted');
        }),
      },
      signal: cancelled.signal,
    });
    await expect(
      taskGuardFullScan(cancelledContext, { code: 'const a = 1;', language: 'ts' })
    ).rejects.toThrow(/guard_full_scan aborted/u);
    expect(cancelledContext.warn).toHaveBeenCalledWith(
      expect.stringContaining('guard_full_scan'),
      expect.objectContaining({ code: 'AGENT_TASK_ABORTED', task: 'guard_full_scan' })
    );
  });
});
