import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import { CapabilityCatalog } from '../src/tools/catalog/CapabilityCatalog.js';
import { queryToolSchemas } from '../src/tools/catalog/schemaQuery.js';
import {
  type ToolDefinition,
  UnifiedToolCatalog,
} from '../src/tools/catalog/UnifiedToolCatalog.js';
import type { ToolAvailabilitySnapshot } from '../src/tools/kernel/availability.js';
import type { ToolRuntimeCallContext } from '../src/tools/kernel/context.js';
import type { ToolCallRequest } from '../src/tools/kernel/request.js';
import type {
  ToolActionAllowlist,
  ToolSchemaQuery,
  ToolSelection,
} from '../src/tools/kernel/toolSchema.js';
import { intersectToolActions, isToolActionAllowed } from '../src/tools/kernel/toolSelection.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { getActionNames } from '../src/tools/runtime/index.js';
import { generateLightweightSchemas, TOOL_REGISTRY } from '../src/tools/runtime/registry.js';
import { ToolRouter } from '../src/tools/runtime/router.js';
import { createToolRegistryView } from '../src/tools/runtime/selection.js';
import { Capability } from '../src/tools/runtime/toolsets/Capability.js';

function actionsOf(schemas: ReturnType<typeof generateLightweightSchemas>) {
  return schemas.map((schema) => ({
    tool: schema.name,
    actions: (schema.parameters.properties as { action: { enum: string[] } }).action.enum,
  }));
}

describe('tool schema selection', () => {
  const allTools = ['code', 'terminal', 'knowledge', 'graph', 'memory', 'meta', 'evidence'];
  it.each<{ label: string; selection: ToolSelection; tools: string[] }>([
    { label: 'missing', selection: undefined, tools: allTools },
    { label: 'null', selection: null, tools: allTools },
    { label: 'empty ids', selection: [], tools: [] },
    { label: 'empty map', selection: {}, tools: [] },
    { label: 'listed tool', selection: ['code'], tools: ['code'] },
    { label: 'null actions', selection: { code: null }, tools: ['code'] },
    { label: 'undefined actions', selection: { code: undefined }, tools: ['code'] },
  ])('preserves legacy selection semantics: $label', ({ selection, tools }) => {
    const catalog = new RuntimeCapabilityCatalog();
    const result = catalog.querySchemas({ selection });
    expect(Object.keys(result.allowedTools)).toEqual(tools);
    expect(result.schemas.map(({ name }) => name)).toEqual(tools);
    expect(catalog.toToolSchemas(selection)).toEqual(result.schemas);
    expect(catalog.toToolSchemasForModel(selection, 'fixture-model')).toEqual(result.schemas);
    expect(catalog.toMixedSchemas(selection, 'fixture-model', false)).toEqual(result.schemas);
  });

  it('intersects complete action sets without granting absent or empty tool keys', () => {
    const result = intersectToolActions(
      { code: null, knowledge: ['search', 'manage'], none: [] },
      { code: ['read'], knowledge: ['manage', 'detail'], other: null }
    );
    expect(result).toEqual({ code: ['read'], knowledge: ['manage'] });
    expect(isToolActionAllowed(result, 'code', 'read')).toBe(true);
    expect(isToolActionAllowed(result, 'code', 'write')).toBe(false);
    expect(isToolActionAllowed(result, 'toString')).toBe(false);
    expect(isToolActionAllowed({ code: undefined }, 'code', 'read')).toBe(true);
    expect(isToolActionAllowed({ code: [] }, 'code')).toBe(false);
  });

  it.each([
    { selection: { code: [] }, expected: [] },
    { selection: { code: ['missing'] }, expected: [] },
    {
      selection: { code: ['read', 'read', 'missing'] },
      expected: [{ tool: 'code', actions: ['read'] }],
    },
  ])('normalizes direct registry projection and catalog consistently: $selection', ({
    selection,
    expected,
  }) => {
    expect(actionsOf(generateLightweightSchemas(selection))).toEqual(expected);
    expect(actionsOf(new RuntimeCapabilityCatalog().toToolSchemasForActions(selection))).toEqual(
      expected
    );
  });

  it('ignores inherited object names when selecting registered tools', () => {
    const catalog = new RuntimeCapabilityCatalog();
    expect(catalog.toToolSchemas(['constructor', 'toString', '__proto__'])).toEqual([]);
    expect(catalog.toToolSchemasForActions({ toString: null })).toEqual([]);
    expect(getActionNames('code')).toEqual(['search', 'read', 'outline', 'structure', 'write']);
    for (const name of ['constructor', 'toString', '__proto__', 'unknown-tool']) {
      expect(getActionNames(name)).toEqual([]);
    }
  });
});

describe('runtime schema query', () => {
  it('creates an immutable view while preserving the actual handler and global schema', () => {
    const original = TOOL_REGISTRY.knowledge.actions.manage;
    const view = createToolRegistryView(
      TOOL_REGISTRY,
      { knowledge: ['manage'] },
      {
        actions: {},
        parameters: { knowledge: { manage: { operation: ['update'] } } },
      }
    );
    const projected = view.knowledge.actions.manage;
    expect(projected.handler).toBe(original.handler);
    expect(Object.isFrozen(projected.handler)).toBe(false);
    expect(projected.params).not.toBe(original.params);
    expect(Object.isFrozen(projected.params.properties)).toBe(true);
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      projected.summary = 'mutated';
    }).toThrow(TypeError);
    expect(original.summary).not.toBe('mutated');
    expect(Object.keys(TOOL_REGISTRY.knowledge.actions)).toContain('search');
  });

  it('returns one effective action set and narrows available management branches', () => {
    const runtime = { agentId: 'schema-fixture' };
    let observedRuntime: ToolRuntimeCallContext | undefined;
    const snapshot: ToolAvailabilitySnapshot = {
      actions: { graph: [] },
      parameters: { knowledge: { manage: { operation: ['update', 'update', 'unknown'] } } },
      unavailable: [{ tool: 'graph', reason: 'Graph ports not bound' }],
    };
    const catalog = new RuntimeCapabilityCatalog({
      availability: (context?: ToolRuntimeCallContext) => {
        observedRuntime = context;
        return snapshot;
      },
    });
    const result = catalog.querySchemas({
      selection: { code: ['read'], knowledge: ['manage'], graph: null },
      runtime,
    });
    expect(observedRuntime).toBe(runtime);
    expect(result.allowedTools).toEqual({ code: ['read'], knowledge: ['manage'] });
    expect(result.unavailable).toEqual(snapshot.unavailable);
    expect(result.schemas.find((schema) => schema.name === 'knowledge')?.parameters).toMatchObject({
      required: ['action', 'params'],
      properties: {
        action: { enum: ['manage'] },
        params: { properties: { operation: { enum: ['update'] } }, required: ['operation'] },
      },
    });
    expect(TOOL_REGISTRY.knowledge.actions.manage.params.properties).toHaveProperty(
      'operation.enum'
    );
    const original = (
      TOOL_REGISTRY.knowledge.actions.manage.params.properties as Record<
        string,
        { enum?: string[] }
      >
    ).operation.enum;
    expect(original).toContain('publish');
    expect(Object.isFrozen(result.allowedTools)).toBe(true);
  });

  it('keeps unrelated sparse actions and scopes optional branch properties in a multi-action envelope', () => {
    const catalog = new RuntimeCapabilityCatalog({
      availability: () => ({
        actions: {},
        parameters: { graph: { query: { type: ['class'] } } },
      }),
    });
    const result = catalog.querySchemas({ selection: { graph: null, code: ['read'] } });
    expect(result.allowedTools).toEqual({ code: ['read'], graph: ['overview', 'query'] });
    const graph = result.schemas.find((schema) => schema.name === 'graph');
    expect(graph?.parameters).toMatchObject({
      required: ['action', 'params'],
      properties: { params: { type: 'object', properties: { type: { enum: ['class'] } } } },
    });
    const params = (graph?.parameters.properties as Record<string, Record<string, unknown>>).params;
    expect(params).not.toHaveProperty('required');
    expect(graph?.description).not.toContain('callers');
  });

  it('removes an action when a required host branch enum becomes empty', () => {
    const catalog = new RuntimeCapabilityCatalog({
      availability: () => ({
        actions: {},
        parameters: { knowledge: { manage: { operation: [] } } },
      }),
    });
    const result = catalog.querySchemas({ selection: { knowledge: ['manage', 'search'] } });
    expect(result.allowedTools).toEqual({ knowledge: ['search'] });
    expect(actionsOf(result.schemas)).toEqual([{ tool: 'knowledge', actions: ['search'] }]);
  });
});

function genericDefinition(): ToolDefinition {
  return {
    id: 'demo.echo',
    title: 'Echo',
    description: 'Echo value\nDetailed contract',
    kind: 'internal-tool',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    handler: async (args) => ({ echoed: args.value }),
    risk: {
      sideEffect: false,
      dataAccess: 'none',
      writeScope: 'none',
      network: 'none',
      credentialAccess: 'none',
      requiresHumanConfirmation: 'never',
      owaspTags: [],
    },
    governance: {
      auditLevel: 'none',
      policyProfile: 'read',
      approvalPolicy: 'auto',
      allowedRoles: [],
      allowInComposer: false,
      allowInRemoteMcp: false,
      allowInNonInteractive: true,
    },
    execution: {
      adapter: 'internal',
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      abortMode: 'none',
      cachePolicy: 'none',
      concurrency: 'parallel-safe',
      artifactMode: 'inline',
    },
    modelOverrides: {
      'fixture-*': {
        description: 'Model-specific echo',
        inputSchema: { type: 'object', properties: { compact: { type: 'boolean' } } },
      },
    },
  };
}

describe('generic schema query compatibility', () => {
  it('keeps a legacy bare model ID containing a colon intact', () => {
    const definition = genericDefinition();
    definition.modelOverrides = {
      latest: { description: 'unrelated suffix model' },
      'qwen2:latest': { description: 'complete bare API model ID' },
    };
    const catalog = new UnifiedToolCatalog([definition]);
    expect(catalog.toToolSchemasForModel(['demo.echo'], 'qwen2:latest')[0].description).toBe(
      'complete bare API model ID'
    );
    expect(catalog.toMixedSchemas(['demo.echo'], 'qwen2:latest', true)[0].description).toBe(
      'complete bare API model ID'
    );
  });

  it.each([
    'base',
    'model-override',
  ])('owns nested JSON schema data returned by a %s projection', (kind) => {
    const definition = genericDefinition();
    const schema = {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'string', enum: ['original'] } },
    };
    definition.inputSchema = schema;
    definition.modelOverrides = { 'fixture-*': { inputSchema: schema } };
    const unified = new UnifiedToolCatalog([definition]);
    const catalog =
      kind === 'base'
        ? new CapabilityCatalog([
            {
              ...definition,
              owner: 'fixture',
              lifecycle: 'active',
              surfaces: ['runtime'],
              evals: { required: false, cases: [] },
            },
          ])
        : unified;
    const query = {
      selection: ['demo.echo'],
      model: kind === 'model-override' ? 'fixture-model' : undefined,
    };
    const expected = structuredClone(schema);
    const first = queryToolSchemas(catalog, query, () => {}).schemas[0].parameters as typeof schema;
    first.required.push('injected');
    first.properties.value.enum.push('injected');
    expect(queryToolSchemas(catalog, query, () => {}).schemas[0].parameters).toEqual(expected);
    expect(schema).toEqual(expected);
    expect(unified.getDefinition('demo.echo')).toBe(definition);
    expect(unified.getHandler('demo.echo')).toBe(definition.handler);
  });

  it.each([
    { provider: 'openai', model: 'gpt-4o', pattern: 'gpt-*' },
    { provider: 'openai', model: 'gpt-4o', pattern: 'openai:gpt-*' },
    { provider: 'ollama', model: 'qwen2:latest', pattern: 'qwen2:latest' },
    { provider: 'ollama', model: 'qwen2:latest', pattern: 'ollama:qwen2:*' },
  ])('applies $pattern through the real Runtime model reference', async ({
    provider,
    model,
    pattern,
  }) => {
    const definition = genericDefinition();
    definition.modelOverrides = {
      [pattern]: {
        description: 'matched override',
        inputSchema: {
          type: 'object',
          required: ['compact'],
          properties: { compact: { type: 'boolean' } },
        },
      },
      '*': { description: 'later fallback must not hide the first match' },
    };
    class FlatCapability extends ReadCapability {
      get allowedTools(): unknown {
        return { 'demo.echo': ['invoke'] };
      }
      get tools() {
        return ['demo.echo'];
      }
    }
    const { runtime, chatWithTools } = runtimeWith(
      new UnifiedToolCatalog([definition]),
      new FlatCapability(),
      { name: provider, model }
    );
    chatWithTools.mockReset().mockResolvedValue({ text: 'done' });
    await runtime.reactLoop('model override fixture');
    expect(chatWithTools.mock.calls[0]?.[1].toolSchemas).toEqual([
      {
        name: 'demo.echo',
        description: 'matched override',
        parameters: {
          type: 'object',
          required: ['compact'],
          properties: { compact: { type: 'boolean' } },
        },
      },
    ]);
  });

  it('keeps flat schemas and selected action words without inventing a builtin action envelope', () => {
    const definition = genericDefinition();
    const catalog = new CapabilityCatalog([
      {
        ...definition,
        owner: 'fixture',
        lifecycle: 'active',
        surfaces: ['runtime'],
        evals: { required: false, cases: [] },
      },
    ]);
    const result = catalog.querySchemas({
      selection: { 'demo.echo': ['custom', 'custom'], unknown: null },
    });
    expect(result.allowedTools).toEqual({ 'demo.echo': ['custom'] });
    expect(result.schemas[0].parameters).toEqual(definition.inputSchema);
    expect(catalog.querySchemas({ selection: [] }).schemas).toEqual([]);
    expect(catalog.querySchemas({ selection: { 'demo.echo': [] } }).allowedTools).toEqual({});
    expect(catalog.querySchemas({ selection: ['constructor'] }).schemas).toEqual([]);
  });

  it('retains model override and first-round versus expanded lazy behavior', () => {
    const catalog = new UnifiedToolCatalog([genericDefinition()]);
    const query = { selection: ['demo.echo'], model: 'fixture-model', mode: 'mixed' as const };
    expect(catalog.querySchemas({ ...query, firstRound: true }).schemas[0]).toMatchObject({
      description: 'Model-specific echo',
      parameters: { properties: { compact: { type: 'boolean' } } },
    });
    expect(catalog.querySchemas(query).schemas[0]).toEqual({
      name: 'demo.echo',
      description: 'Echo value',
      parameters: { type: 'object', properties: {} },
    });
    catalog.markExpanded('demo.echo');
    expect(catalog.querySchemas(query).schemas).toEqual(
      catalog.toMixedSchemas(['demo.echo'], 'fixture-model', false)
    );
    expect(catalog.querySchemas({ ...query, mode: 'full' }).schemas).toEqual(
      catalog.toToolSchemasForModel(['demo.echo'], 'fixture-model')
    );
    expect(catalog.querySchemas({ ...query, mode: 'lightweight' }).schemas).toEqual(
      catalog.toLightweightSchemas(['demo.echo'])
    );
    expect(catalog.querySchemas({ selection: {} }).schemas).toEqual([]);
  });
});

class ReadCapability extends Capability {
  get name() {
    return 'fixture';
  }
  get promptFragment() {
    return '';
  }
  get tools() {
    return ['code', 'graph'];
  }
  get allowedTools(): unknown {
    return { code: ['read'], graph: ['overview'] };
  }
}

function runtimeWith(
  catalog: unknown,
  capability = new ReadCapability(),
  identity?: { name: string; model: string }
) {
  const execute = vi.fn(async (request: ToolCallRequest) => ({
    ok: true,
    status: 'success',
    toolId: request.toolId,
    callId: 'fixture',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    text: 'read result',
    structuredContent: { observed: true },
  }));
  const chatWithTools = vi
    .fn()
    .mockResolvedValueOnce({
      functionCalls: [
        { id: 'unavailable', name: 'graph', args: { action: 'overview', params: {} } },
        {
          id: 'forbidden',
          name: 'code',
          args: { action: 'write', params: { path: 'x', content: 'never' } },
        },
        { id: 'missing-action', name: 'code', args: { params: { path: 'x' } } },
        { id: 'allowed', name: 'code', args: { action: 'read', params: { path: 'x' } } },
      ],
    })
    .mockResolvedValue({ text: 'done' });
  const runtime = new AgentRuntime({
    aiProvider: { name: 'mock', ...identity, chatWithTools } as never,
    container: { get: () => catalog },
    toolRegistry: new RuntimeCapabilityCatalog() as never,
    toolRouter: { execute } as never,
    strategy: new SingleStrategy(),
    capabilities: [capability],
  });
  return { runtime, execute, chatWithTools };
}

describe('runtime schema query port', () => {
  it.each([
    'sync',
    'async',
  ])('isolates a %s legacy diagnostic observer without changing the query authorization', async (mode) => {
    const native = new RuntimeCapabilityCatalog();
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const result = queryToolSchemas(
        { toToolSchemas: () => native.toToolSchemas(['code', 'graph']) },
        { selection: { code: ['read'] } },
        () => {
          const error = new Error('fixture-private-diagnostic-detail');
          if (mode === 'async') {
            return Promise.reject(error);
          }
          throw error;
        }
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(result.allowedTools).toEqual({ code: ['read'] });
      expect(actionsOf(result.schemas)).toEqual([{ tool: 'code', actions: ['read'] }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy_diagnostic_failed'));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-private-diagnostic-detail');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    { port: 'modern', rejects: false },
    { port: 'modern', rejects: true },
    { port: 'legacy', rejects: false },
    { port: 'legacy', rejects: true },
  ])('rejects the asynchronous $port contract (rejects=$rejects) without running the model or host', async ({
    port,
    rejects,
  }) => {
    const value = () =>
      rejects
        ? Promise.reject(new Error('fixture asynchronous schema rejection'))
        : Promise.resolve(port === 'modern' ? { schemas: [], allowedTools: {} } : []);
    const catalog = port === 'modern' ? { querySchemas: value } : { toToolSchemas: value };
    const { runtime, execute, chatWithTools } = runtimeWith(catalog);
    await expect(runtime.reactLoop('invalid async port')).rejects.toThrow(/synchronous/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    'modern',
    'legacy',
    'diagnostic',
  ])('keeps the original stage mask when the %s boundary changes its query input', async (boundary) => {
    const native = new RuntimeCapabilityCatalog();
    let observedActions: ToolActionAllowlist | undefined;
    const catalog =
      boundary === 'modern'
        ? {
            querySchemas(query: ToolSchemaQuery) {
              query.selection = { code: null };
              return native.querySchemas(query);
            },
          }
        : {
            toMixedSchemasForActions(actions: ToolActionAllowlist) {
              observedActions = actions;
              if (boundary === 'legacy') {
                // JS 宿主可能原地归一化入参；不能因此改变调用者的授权快照。
                (actions as Record<string, null>).code = null;
              }
              return native.toToolSchemasForActions(actions);
            },
          };
    class OnlyReadCapability extends ReadCapability {
      get allowedTools(): unknown {
        return { code: ['read'] };
      }
    }
    const { runtime, execute, chatWithTools } = runtimeWith(catalog, new OnlyReadCapability());
    const info = vi.spyOn(runtime.logger, 'info').mockImplementation((message: string) => {
      if (
        boundary === 'diagnostic' &&
        message.includes('legacy schema query adapter') &&
        observedActions
      ) {
        (observedActions as Record<string, null>).code = null;
      }
    });
    try {
      await runtime.reactLoop('read-only fixture');
    } finally {
      info.mockRestore();
    }
    expect(execute.mock.calls.map(([call]) => call.args.action)).toEqual(['read']);
    expect(execute.mock.calls[0]?.[0].runtime?.allowedTools).toEqual({ code: ['read'] });
    expect(actionsOf(chatWithTools.mock.calls[0]?.[1].toolSchemas ?? [])).toEqual([
      { tool: 'code', actions: ['read'] },
    ]);
  });

  it.each([
    'modern',
    'legacy',
    'diagnostic',
  ])('isolates tool IDs before invoking a %s schema boundary', (boundary) => {
    const native = new RuntimeCapabilityCatalog();
    const selected = ['code'];
    const catalog =
      boundary === 'modern'
        ? {
            querySchemas(query: ToolSchemaQuery) {
              (query.selection as string[]).push('graph');
              return native.querySchemas(query);
            },
          }
        : {
            toToolSchemas(ids: string[]) {
              if (boundary === 'legacy') {
                ids.push('graph');
              }
              return native.toToolSchemas(['code', 'graph']);
            },
          };
    const result = queryToolSchemas(catalog, { selection: selected }, () => {
      if (boundary === 'diagnostic') {
        selected.push('graph');
      }
    });
    expect(result.schemas.map(({ name }) => name)).toEqual(['code']);
    expect(Object.keys(result.allowedTools)).toEqual(['code']);
    if (boundary !== 'diagnostic') {
      expect(selected).toEqual(['code']);
    }
  });

  it('keeps generic flat tools callable without inventing an action argument', async () => {
    const catalog = new CapabilityCatalog([
      {
        id: 'flat',
        title: 'Flat',
        description: 'fixture',
        lifecycle: 'active',
        inputSchema: {
          type: 'object',
          required: ['input'],
          properties: { input: { type: 'string' } },
        },
      } as never,
    ]);
    class FlatCapability extends ReadCapability {
      get allowedTools(): unknown {
        return { flat: ['invoke'] };
      }
      get tools() {
        return ['flat'];
      }
    }
    const { runtime, execute, chatWithTools } = runtimeWith(catalog, new FlatCapability());
    chatWithTools
      .mockReset()
      .mockResolvedValueOnce({
        functionCalls: [{ id: 'flat', name: 'flat', args: { input: 'value' } }],
      })
      .mockResolvedValue({ text: 'done' });
    await runtime.reactLoop('flat tool');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].args).toEqual({ input: 'value' });
  });
  it('uses querySchemas directly and enforces its effective actions before calling an external host', async () => {
    const catalog = new RuntimeCapabilityCatalog({
      availability: (runtime) =>
        ToolRouter.describeAvailability({ sessionStoreAvailable: true, runtime }),
    });
    const query = vi.spyOn(catalog, 'querySchemas');
    const legacy = vi.spyOn(catalog, 'toMixedSchemasForActions');
    const { runtime, execute, chatWithTools } = runtimeWith(catalog);
    const sharedState = { submittedTitles: new Set<string>() };
    const result = await runtime.reactLoop('task', { sharedState });
    expect(legacy).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]?.runtime?.sharedState).toBe(sharedState);
    expect(query.mock.calls[0]?.[0]?.runtime?.evidenceLedger).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      toolId: 'code',
      args: { action: 'read' },
      runtime: { allowedTools: { code: ['read'] } },
    });
    expect(result.diagnostics?.blockedTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'graph' }),
        expect.objectContaining({ tool: 'code' }),
      ])
    );
    const options = chatWithTools.mock.calls[0]?.[1];
    expect(options.toolSchemas?.map((schema: { name: string }) => schema.name)).toEqual(['code']);
  });

  it('retains legacy schema providers without relaxing stage actions', async () => {
    const native = new RuntimeCapabilityCatalog();
    const oldProvider = {
      toToolSchemas: vi.fn((ids?: readonly string[] | null) => native.toToolSchemas(ids)),
    };
    const { runtime, execute } = runtimeWith(oldProvider);
    await runtime.reactLoop('legacy');
    expect(oldProvider.toToolSchemas).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map(([call]) => call.args.action)).toEqual(['overview', 'read']);
    expect(
      execute.mock.calls.every(
        ([call]) => call.runtime?.allowedTools?.code?.includes('write') !== true
      )
    ).toBe(true);
  });

  it('rejects an invalid explicit action contract instead of widening through legacy tools', async () => {
    class InvalidCapability extends ReadCapability {
      get allowedTools(): unknown {
        return { code: 'read' };
      }
    }
    const { runtime, chatWithTools, execute } = runtimeWith(
      new RuntimeCapabilityCatalog(),
      new InvalidCapability()
    );
    await expect(runtime.reactLoop('invalid')).rejects.toThrow(
      'Invalid capability action allowlist'
    );
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
