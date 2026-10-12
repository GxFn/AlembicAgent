import { buildCanonicalCoverageLedgerModuleId } from '@alembic/core/host-agent-workflows';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PROFILES } from '../src/agent/profiles/definitions/index.js';
import { SCOPED_MODULE_MINING_PROFILES } from '../src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.js';
import { runModuleMining as runModuleMiningFromIndex } from '../src/agent/runs/index.js';
import {
  runModuleMining,
  runScopedModuleMining,
} from '../src/agent/runs/module-mining/ScopedModuleMiningAgentRun.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeBuildOptions,
  AgentRuntimeLike,
  AgentRuntimeRunOptions,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { AgentService } from '../src/agent/service/AgentService.js';

type RuntimeExecution = {
  profileId: string;
  content: string;
  metadata: Record<string, unknown>;
  options?: AgentRuntimeRunOptions;
};

describe('module mining profiles', () => {
  it('keeps the module-mining run export wired through runs/index (W6-b: compat shims removed)', () => {
    expect(runModuleMiningFromIndex).toBe(runScopedModuleMining);
    expect(runModuleMining).toBe(runScopedModuleMining);
    expect(SCOPED_MODULE_MINING_PROFILES.length).toBeGreaterThan(0);
  });

  it('registers fanout session and child profiles with module partitioning', () => {
    const session = BUILTIN_PROFILES.find((profile) => profile.id === 'module-mining-session');
    const child = BUILTIN_PROFILES.find((profile) => profile.id === 'module-mining-dimension');

    expect(session).toMatchObject({
      strategy: {
        type: 'fanout',
        childProfile: 'module-mining-dimension',
        partitioner: 'projectContextModules',
        merge: 'moduleMiningResults',
      },
      concurrency: {
        mode: 'tiered',
        partitioner: 'projectContextModules',
        childProfile: 'module-mining-dimension',
        merge: 'moduleMiningResults',
      },
      projection: 'agent-result',
    });
    expect(session?.concurrency?.concurrency).toEqual({
      env: 'ALEMBIC_MODULE_MINING_CONCURRENCY',
      default: 2,
    });
    expect(child).toMatchObject({
      strategy: { type: 'pipeline', factory: 'generateDimensionPipeline' },
      projection: 'agent-result',
    });
  });
});

describe('runModuleMining', () => {
  it('fans out one child per ProjectContext module without dimension cross-talk', async () => {
    const executions: RuntimeExecution[] = [];
    const agentService = createService(executions);
    const budget = { analystTokens: 9000, totalRecipeBudget: 6 };

    const result = await runModuleMining({
      agentService,
      modules: [
        { moduleId: 'core', moduleName: 'Core', ownedFiles: ['src/core.ts'] },
        { moduleId: 'ui', moduleName: 'UI', ownedFiles: ['src/ui.ts'] },
        { moduleId: 'cli', moduleName: 'CLI', ownedFiles: ['src/cli.ts'] },
      ],
      projectFacts: { project: 'demo' },
      budget,
    });

    expect(result).toMatchObject({
      status: 'success',
      phases: {
        moduleResults: {
          core: { reply: 'mined:core' },
          ui: { reply: 'mined:ui' },
          cli: { reply: 'mined:cli' },
        },
      },
    });
    expect(executions).toHaveLength(3);
    expect(executions.map((execution) => execution.profileId)).toEqual([
      'module-mining-dimension',
      'module-mining-dimension',
      'module-mining-dimension',
    ]);
    for (const execution of executions) {
      expect(execution.metadata.phase).toBe('module-mining-child');
      expect(execution.metadata.dimension).toBeUndefined();
      expect(execution.metadata.dimensionId).toBeUndefined();
      expect(execution.metadata.dimId).toBeUndefined();
      expect(execution.metadata.context).toMatchObject({
        budget,
        ownedFiles: expect.any(Array),
      });
      expect(execution.options?.budgetOverride).toBe(budget);
      expect(execution.options?.sharedState).toBeUndefined();
    }
  });

  it('builds real module child pipeline prompts from moduleName-only ProjectContext payloads', async () => {
    const providerPrompts: string[] = [];
    const chatWithTools = vi.fn(async (prompt: string) => {
      providerPrompts.push(prompt);
      return {
        text: 'module analyst summary',
        functionCalls: [],
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    });
    const agentService = new AgentService({
      runtimeBuilder: new AgentRuntimeBuilder({
        aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
        container: {},
        toolRegistry: { getRouter: () => ({ execute: vi.fn() }) as never },
      }),
    });

    const result = await runModuleMining({
      agentService,
      modules: [
        {
          moduleId: 'target:App:Sources/App',
          moduleName: 'App',
          modulePath: 'Sources/App',
          ownedFiles: ['Sources/App/App.swift'],
        },
      ],
      projectFacts: { project: 'BiliDili', fileCount: 42, lang: 'Swift' },
      budget: { totalRecipeBudget: 1 },
      scaleCap: 1,
    });

    expect(result.status).toBe('success');
    expect(chatWithTools).toHaveBeenCalled();
    expect(providerPrompts[0]).toContain('分析项目 BiliDili');
    expect(providerPrompts[0]).toContain('模块 App');
    expect(providerPrompts[0]).toContain('Sources/App/App.swift');
  });

  it('rejects empty module input before silent zero-fanout', async () => {
    const executions: RuntimeExecution[] = [];
    await expect(
      runModuleMining({
        agentService: createService(executions),
        modules: [],
        projectFacts: {},
      })
    ).rejects.toThrow(/at least one ProjectContext module/u);
    expect(executions).toHaveLength(0);
  });

  it('applies scaleCap before child creation while preserving full per-child budget', async () => {
    const executions: RuntimeExecution[] = [];
    const budget = { analystTokens: 12_000, totalRecipeBudget: 8 };

    await runModuleMining({
      agentService: createService(executions),
      modules: Array.from({ length: 8 }, (_, index) => ({
        moduleId: `module-${index}`,
        moduleName: `Module ${index}`,
        ownedFiles: [`src/module-${index}.ts`],
      })),
      projectFacts: { project: 'scale-cap' },
      budget,
      scaleCap: 3,
    });

    expect(executions).toHaveLength(3);
    expect(executions.map((execution) => execution.metadata.moduleId)).toEqual([
      'module-0',
      'module-1',
      'module-2',
    ]);
    expect(executions.map((execution) => execution.options?.budgetOverride)).toEqual([
      budget,
      budget,
      budget,
    ]);
  });
});

function createService(executions: RuntimeExecution[]) {
  return new AgentService({
    runtimeBuilder: {
      build(profile: CompiledAgentProfile, _options?: AgentRuntimeBuildOptions): AgentRuntimeLike {
        return {
          id: `runtime:${profile.id}`,
          async execute(message, options) {
            const moduleId = String(message.metadata?.moduleId ?? 'unknown');
            executions.push({
              profileId: profile.id,
              content: message.content,
              metadata: message.metadata || {},
              options,
            });
            return {
              reply: `mined:${moduleId}`,
              phases: { moduleId },
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

type ChildObservation = { id: string; files: string[] };
function observedModuleService(children: ChildObservation[], failSecond = false) {
  return new AgentService({
    runtimeBuilder: {
      build(profile: CompiledAgentProfile): AgentRuntimeLike {
        return {
          id: `rt:${profile.id}`,
          async execute(message) {
            const id = String(message.metadata?.moduleId);
            const context = (message.metadata?.context || {}) as Record<string, unknown>;
            children.push({ id, files: (context.ownedFiles || []) as string[] });
            const failing = failSecond && id === 'bad';
            return {
              reply: failing ? 'provider unavailable' : `done:${id}`,
              phases: { _pipelineOutcome: { outcome: failing ? 'failed' : 'completed' } },
              toolCalls: failing
                ? []
                : [
                    {
                      tool: 'knowledge',
                      args: { action: 'submit' },
                      result: { id: `receipt:${id}`, status: 'created', lifecycle: 'pending' },
                    },
                  ],
              tokenUsage: { input: 2, output: 1 },
              iterations: 1,
              durationMs: 1,
            } as never;
          },
        };
      },
    },
  });
}

describe('module split identities and partial outcomes', () => {
  it('splits actual project-relative module files by the module internal directories', async () => {
    const children: ChildObservation[] = [];
    const files = [
      ...Array.from({ length: 40 }, (_, i) => `Sources/App/alpha/f${i}.ts`),
      ...Array.from({ length: 30 }, (_, i) => `Sources/App/beta/f${i}.ts`),
    ];
    await runModuleMining({
      agentService: observedModuleService(children),
      modules: [
        { moduleId: 'target:App:Sources/App', modulePath: 'Sources/App', ownedFiles: files },
      ],
      projectFacts: { project: 'fixture' },
      scaleCap: 1,
    });
    expect(children.length).toBeGreaterThan(1);
    expect(children.flatMap((c) => c.files).sort()).toEqual([...files].sort());
  });
  it('keeps distinct group combinations from overwriting a sibling module result', async () => {
    const children: ChildObservation[] = [];
    const files = [
      ...Array.from({ length: 61 }, (_, i) => `alpha+beta/f${i}.ts`),
      ...Array.from({ length: 40 }, (_, i) => `alpha/f${i}.ts`),
      ...Array.from({ length: 20 }, (_, i) => `beta/f${i}.ts`),
    ];
    const output = await runModuleMining({
      agentService: observedModuleService(children),
      modules: [{ moduleId: 'root', ownedFiles: files }],
      projectFacts: { project: 'fixture' },
    });
    expect(children).toHaveLength(2);
    expect(new Set(children.map((c) => c.id)).size).toBe(2);
    expect(Object.keys(output.phases?.moduleResults as object)).toHaveLength(2);
  });
  it('retains confirmed sibling results on a failed module run error', async () => {
    const children: ChildObservation[] = [];
    let failure: unknown;
    try {
      await runModuleMining({
        agentService: observedModuleService(children, true),
        modules: [
          { moduleId: 'good', ownedFiles: ['src/good.ts'] },
          { moduleId: 'bad', ownedFiles: ['src/bad.ts'] },
        ],
        projectFacts: { project: 'fixture' },
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      partialResult: {
        status: 'error',
        toolCalls: [{ result: { id: 'receipt:good', status: 'created' } }],
        phases: { moduleResults: { good: { status: 'success' }, bad: { status: 'error' } } },
      },
    });
  });
});

it('keeps generated split identity distinct from a real existing Core module identity', async () => {
  const children: ChildObservation[] = [];
  const baseId = buildCanonicalCoverageLedgerModuleId({
    moduleName: 'App',
    modulePath: 'Sources/App',
  });
  const existingId = buildCanonicalCoverageLedgerModuleId({
    moduleName: 'App',
    modulePath: 'Sources/App#alpha',
  });
  const files = [
    ...Array.from({ length: 40 }, (_, i) => `Sources/App/alpha/f${i}.ts`),
    ...Array.from({ length: 30 }, (_, i) => `Sources/App/beta/f${i}.ts`),
  ];
  const existingFile = 'Sources/App#alpha/index.ts';
  const result = await runModuleMining({
    agentService: observedModuleService(children),
    modules: [
      { moduleId: baseId, modulePath: 'Sources/App', ownedFiles: files },
      { moduleId: existingId, modulePath: 'Sources/App#alpha', ownedFiles: [existingFile] },
    ],
    projectFacts: { project: 'fixture' },
  });
  expect(children).toHaveLength(3);
  expect(new Set(children.map((c) => c.id)).size).toBe(3);
  expect(Object.keys(result.phases?.moduleResults as object)).toHaveLength(3);
  expect(children.flatMap((c) => c.files).sort()).toEqual([...files, existingFile].sort());
});

// L8-C01：宿主取消/期限信号必须能经 runModuleMining 进入父 execution，由 coordinator 在每个 child
// 派发前、AgentRuntime 在运行中消费；不传信号时父 execution 与旧形状逐字节一致。
describe('runModuleMining cancellation and deadline signals', () => {
  const threeModules = [
    { moduleId: 'core', moduleName: 'Core', ownedFiles: ['src/core.ts'] },
    { moduleId: 'ui', moduleName: 'UI', ownedFiles: ['src/ui.ts'] },
    { moduleId: 'cli', moduleName: 'CLI', ownedFiles: ['src/cli.ts'] },
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts no child and fails with an aborted partial result when the signal is already aborted', async () => {
    const executions: RuntimeExecution[] = [];
    const controller = new AbortController();
    controller.abort(new Error('host cancelled the moduleMining job'));
    let failure: unknown;
    try {
      await runModuleMining({
        agentService: createService(executions),
        modules: threeModules,
        projectFacts: { project: 'cancelled' },
        budget: { totalRecipeBudget: 3 },
        abortSignal: controller.signal,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(executions).toHaveLength(0);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/failed with status aborted/u);
    expect(failure).toMatchObject({
      partialResult: {
        status: 'aborted',
        phases: {
          moduleResults: {
            core: { status: 'aborted', reply: 'child-run-aborted' },
            ui: { status: 'aborted', reply: 'child-run-aborted' },
            cli: { status: 'aborted', reply: 'child-run-aborted' },
          },
        },
      },
    });
  });

  it('stops dispatching later children once shouldAbort turns true after the first child', async () => {
    vi.stubEnv('ALEMBIC_MODULE_MINING_CONCURRENCY', '1');
    const executions: RuntimeExecution[] = [];
    const shouldAbort = vi.fn(() => executions.length >= 1);
    let failure: unknown;
    try {
      await runModuleMining({
        agentService: createService(executions),
        modules: threeModules,
        projectFacts: { project: 'cancel-mid-run' },
        shouldAbort,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(shouldAbort).toHaveBeenCalled();
    expect(executions.map((execution) => execution.metadata.moduleId)).toEqual(['core']);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      partialResult: {
        status: 'aborted',
        phases: {
          moduleResults: {
            core: { status: 'success', reply: 'mined:core' },
            ui: { status: 'aborted', reply: 'child-run-aborted' },
            cli: { status: 'aborted', reply: 'child-run-aborted' },
          },
        },
      },
    });
    expect((failure as { partialResult: { status: string } }).partialResult.status).not.toBe(
      'success'
    );
  });

  it('forwards the abort signal and deadline to child runtimes and stops after a mid-run abort', async () => {
    vi.stubEnv('ALEMBIC_MODULE_MINING_CONCURRENCY', '1');
    const executions: RuntimeExecution[] = [];
    const controller = new AbortController();
    const agentService = new AgentService({
      runtimeBuilder: {
        build(profile: CompiledAgentProfile): AgentRuntimeLike {
          return {
            id: `runtime:${profile.id}`,
            async execute(message, options) {
              executions.push({
                profileId: profile.id,
                content: message.content,
                metadata: message.metadata || {},
                options,
              });
              // 宿主在第一个 child 运行期间取消 job。
              controller.abort(new Error('host cancelled during first child'));
              return {
                reply: `mined:${String(message.metadata?.moduleId)}`,
                tokenUsage: { input: 1, output: 1 },
                iterations: 1,
                durationMs: 1,
              };
            },
          };
        },
      },
    });

    await expect(
      runModuleMining({
        agentService,
        modules: threeModules,
        projectFacts: { project: 'abort-mid-run' },
        abortSignal: controller.signal,
        timeoutMs: 45_000,
      })
    ).rejects.toMatchObject({ partialResult: { status: 'aborted' } });

    expect(executions).toHaveLength(1);
    expect(executions[0]?.options?.abortSignal).toBe(controller.signal);
    expect(executions[0]?.options?.timeoutMs).toBe(45_000);
  });

  it('keeps the parent execution exactly as before when no signal is passed', async () => {
    const budget = { analystTokens: 9000, totalRecipeBudget: 6 };
    const calls: AgentRunInput[] = [];
    const run = vi.fn(async (input: AgentRunInput) => {
      calls.push(input);
      return successRunResult();
    });

    await runModuleMining({
      agentService: { run },
      modules: threeModules,
      projectFacts: { project: 'regression' },
      budget,
    });
    await runModuleMining({
      agentService: { run },
      modules: threeModules,
      projectFacts: { project: 'regression-no-budget' },
    });

    expect(calls[0]?.execution).toEqual({ budgetOverride: budget });
    expect(Object.keys(calls[0]?.execution ?? {})).toEqual(['budgetOverride']);
    expect(calls[1]?.execution).toEqual({});
    expect(Object.keys(calls[0] ?? {})).toEqual([
      'profile',
      'params',
      'message',
      'context',
      'execution',
      'presentation',
    ]);
  });

  it('merges the three signals into the parent execution without leaking them into params', async () => {
    const budget = { totalRecipeBudget: 2 };
    const controller = new AbortController();
    const shouldAbort = () => false;
    const calls: AgentRunInput[] = [];
    const run = vi.fn(async (input: AgentRunInput) => {
      calls.push(input);
      return successRunResult();
    });

    await runModuleMining({
      agentService: { run },
      modules: threeModules,
      projectFacts: { project: 'passthrough' },
      budget,
      abortSignal: controller.signal,
      shouldAbort,
      timeoutMs: 30_000,
    });

    expect(calls[0]?.execution).toEqual({
      budgetOverride: budget,
      abortSignal: controller.signal,
      shouldAbort,
      timeoutMs: 30_000,
    });
    expect(calls[0]?.execution?.abortSignal).toBe(controller.signal);
    expect(calls[0]?.execution?.shouldAbort).toBe(shouldAbort);
    expect(calls[0]?.params).not.toHaveProperty('abortSignal');
    expect(calls[0]?.params).not.toHaveProperty('shouldAbort');
    expect(calls[0]?.params).not.toHaveProperty('timeoutMs');
  });
});

function successRunResult(): AgentRunResult {
  return {
    runId: 'module-mining-parent',
    profileId: 'module-mining-session',
    reply: 'ok',
    status: 'success',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}
