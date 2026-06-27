import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILES } from '../src/agent/profiles/definitions/index.js';
import { runModuleMining } from '../src/agent/runs/module/ModuleMiningAgentRun.js';
import type {
  AgentRuntimeBuildOptions,
  AgentRuntimeLike,
  AgentRuntimeRunOptions,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import { AgentService } from '../src/agent/service/AgentService.js';

type RuntimeExecution = {
  profileId: string;
  content: string;
  metadata: Record<string, unknown>;
  options?: AgentRuntimeRunOptions;
};

describe('module mining profiles', () => {
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
      strategy: { type: 'pipeline', factory: 'bootstrapDimensionPipeline' },
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
