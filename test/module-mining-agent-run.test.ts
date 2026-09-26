import { buildCanonicalCoverageLedgerModuleId } from '@alembic/core/host-agent-workflows';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_PROFILES } from '../src/agent/profiles/definitions/index.js';
import { SCOPED_MODULE_MINING_PROFILES } from '../src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.js';
import { runModuleMining as runModuleMiningFromIndex } from '../src/agent/runs/index.js';
import {
  runModuleMining,
  runScopedModuleMining,
} from '../src/agent/runs/module-mining/ScopedModuleMiningAgentRun.js';
import type {
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
