import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/tools/runtime/index.js';
import {
  DeltaCache,
  OutputCompressor,
  parseGitStatusOutput,
  RuntimeCapabilityCatalog,
  SearchCache,
  ToolRouter,
  ToolRouterAdapter,
} from '../src/tools/runtime/index.js';

function baseToolContext(): ToolContext {
  return {
    projectRoot: '/tmp/alembic-agent-tool-v2-test',
    tokenBudget: 4000,
  };
}

describe('Tool V2 contract exports', () => {
  it('exports capability catalog projections from the V2 registry', () => {
    const catalog = new RuntimeCapabilityCatalog();
    const schemas = catalog.toToolSchemas(['meta']);

    expect(catalog.has('meta')).toBe(true);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.name).toBe('meta');
    expect(schemas[0]?.parameters).toMatchObject({
      type: 'object',
    });

    catalog.markExpanded('meta');
    expect(catalog.expandedCount).toBe(1);
  });

  it('projects action-level allowlists into provider-visible schemas', () => {
    const catalog = new RuntimeCapabilityCatalog();
    const schemas = catalog.toToolSchemasForActions({
      knowledge: ['submit'],
      meta: ['review'],
    });

    const knowledge = schemas.find((schema) => schema.name === 'knowledge');
    const meta = schemas.find((schema) => schema.name === 'meta');
    const knowledgeParams = knowledge?.parameters as {
      properties?: {
        action?: { enum?: string[] };
        params?: { required?: string[]; properties?: Record<string, unknown> };
      };
    };
    const metaParams = meta?.parameters as {
      properties?: { action?: { enum?: string[] } };
    };

    expect(knowledge?.description).not.toContain('detail');
    expect(knowledge?.description).not.toContain('manage');
    expect(knowledgeParams.properties?.action?.enum).toEqual(['submit']);
    expect(knowledgeParams.properties?.params?.required).toEqual([
      'title',
      'description',
      'content',
      'kind',
      'trigger',
      'whenClause',
      'doClause',
      'reasoning',
    ]);
    expect(knowledgeParams.properties?.params?.properties).toHaveProperty('description');
    expect(knowledgeParams.properties?.params?.properties).toHaveProperty('content');
    expect(knowledgeParams.properties?.params?.properties).toHaveProperty('reasoning');
    expect(metaParams.properties?.action?.enum).toEqual(['review']);
  });

  it('exports generic delta and search cache contracts', () => {
    const deltaCache = new DeltaCache(1);
    const first = deltaCache.check('a.ts', 'one\ntwo');
    const unchanged = deltaCache.check('a.ts', 'one\ntwo');
    const changed = deltaCache.check('a.ts', 'one\nthree');

    expect(first.mode).toBe('full');
    expect(unchanged.mode).toBe('unchanged');
    expect(changed.mode).toBe('delta');

    const searchCache = new SearchCache(1);
    const key = SearchCache.makeKey('AgentRuntime', '*.ts');
    searchCache.set(key, { matches: 1 });

    expect(searchCache.get(key)).toEqual({ matches: 1 });
    expect(searchCache.size).toBe(1);
  });

  it('exports output compressor and parser utilities', async () => {
    const gitStatus = [
      'On branch main',
      'Changes not staged for commit:',
      '  modified:   src/index.ts',
      '',
    ].join('\n');
    const parsed = parseGitStatusOutput(gitStatus);
    const compressed = await new OutputCompressor().compress(gitStatus, {
      command: 'git status',
      tokenBudget: 200,
    });

    expect(parsed).toContain('modified');
    expect(compressed).toContain('modified');
  });

  it('routes V2 calls through generic router and adapter contracts', async () => {
    const router = new ToolRouter();
    const parsed = router.parseToolCall('meta', {
      action: 'tools',
      params: { name: 'meta' },
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, baseToolContext());
    expect(result.ok).toBe(true);
    expect(String(result.data)).toContain('[meta]');

    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => baseToolContext(),
      },
    });
    const envelope = await adapter.execute({
      toolId: 'meta',
      args: { action: 'tools', params: { name: 'meta' } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'vitest' },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.text).toContain('[meta]');
    expect(envelope.cache?.policy).toBe('none');
  });

  it('binds V2 terminal exec calls to the injected sandbox executor', async () => {
    const router = new ToolRouter();
    const parsed = router.parseToolCall('terminal', {
      action: 'exec',
      params: { command: 'node -v', timeout: 1000 },
    });
    const calls: Array<{ command: string; cwd: string; timeout: number }> = [];

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      sandboxExecutor: {
        exec: async (
          command: string,
          opts: { cwd: string; projectRoot: string; timeout: number; signal?: AbortSignal }
        ) => {
          calls.push({ command, cwd: opts.cwd, timeout: opts.timeout });
          return { stdout: 'v22.0.0\n', stderr: '', exitCode: 0 };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data).toBe('v22.0.0');
    expect(calls).toEqual([
      { command: 'node -v', cwd: baseToolContext().projectRoot, timeout: 1000 },
    ]);
  });

  it('routes V2 terminal cancellation as a structured partial timeout result', async () => {
    const router = new ToolRouter();
    const abortController = new AbortController();
    abortController.abort();
    const parsed = router.parseToolCall('terminal', {
      action: 'exec',
      params: { command: 'node -e "setTimeout(() => {}, 1000)"' },
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      abortSignal: abortController.signal,
      sandboxExecutor: {
        exec: async (_command: string, opts: { signal?: AbortSignal }) => {
          expect(opts.signal?.aborted).toBe(true);
          return { stdout: 'partial output\n', stderr: '', exitCode: 137 };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(String(result.data)).toContain('[timeout] partial output');
    expect(String(result.data)).toContain('partial output');
  });

  it('writes new knowledge submissions with the Alembic Agent source by default', async () => {
    const router = new ToolRouter();
    const createRequests: Array<{
      source: string;
      items: Record<string, unknown>[];
      options?: Record<string, unknown>;
    }> = [];
    const parsed = router.parseToolCall('knowledge', {
      action: 'submit',
      params: {
        title: 'Tool V2 source boundary',
        description: 'Records the Agent runtime as the default source for new knowledge writes.',
        content: {
          markdown:
            'This candidate documents the Tool V2 source boundary for Agent runtime writes. '.repeat(
              4
            ),
          rationale:
            'The source value must distinguish Alembic Agent owned writes from legacy IDE agent compatibility inputs.',
        },
        kind: 'pattern',
        trigger: 'Tool V2 source boundary',
        whenClause: 'When the Agent runtime submits a new knowledge candidate through Tool V2.',
        doClause: 'Persist alembic-agent as the default source for the submitted candidate.',
        reasoning: {
          sources: ['src/tools/runtime/handlers/knowledge.ts'],
          confidence: 0.9,
        },
      },
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, {
      ...baseToolContext(),
      recipeGateway: {
        create: async (request: {
          source: string;
          items: Record<string, unknown>[];
          options?: Record<string, unknown>;
        }) => {
          createRequests.push(request);
          return {
            created: [{ id: 'candidate-1', title: 'Tool V2 source boundary' }],
            rejected: [],
            duplicates: [],
            merged: [],
            blocked: [],
          };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(createRequests[0]?.source).toBe('alembic-agent');
    expect(createRequests[0]?.options?.userId).toBe('alembic-agent');
    expect(createRequests[0]?.items[0]?.source).toBe('alembic-agent');
  });

  it('defaults evolution decisions to alembic-agent while preserving legacy and domain sources', async () => {
    const router = new ToolRouter();

    async function captureEvolutionSource(source?: string): Promise<unknown> {
      const submitted: Array<{ source: unknown }> = [];
      const result = await router.execute(
        {
          tool: 'knowledge',
          action: 'manage',
          params: { operation: 'evolve', id: 'recipe-1' },
        },
        {
          ...baseToolContext(),
          runtime: source ? { sharedState: { evolutionProposalSource: source } } : {},
          evolutionGateway: {
            submit: async (decision: {
              recipeId: string;
              action: string;
              source: unknown;
              confidence: number;
            }) => {
              submitted.push(decision);
              return {
                recipeId: decision.recipeId,
                action: decision.action,
                outcome: 'proposal-created',
                proposalId: 'proposal-1',
              };
            },
          },
        }
      );

      expect(result.ok).toBe(true);
      return submitted[0]?.source;
    }

    await expect(captureEvolutionSource()).resolves.toBe('alembic-agent');
    await expect(captureEvolutionSource('ide-agent')).resolves.toBe('ide-agent');
    await expect(captureEvolutionSource('file-change')).resolves.toBe('file-change');
    await expect(captureEvolutionSource('rescan-evolution')).resolves.toBe('rescan-evolution');
  });
});
