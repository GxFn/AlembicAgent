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
import {
  intersectToolActions,
  isToolActionAllowed,
  normalizeToolActions,
} from '../src/tools/kernel/toolSelection.js';
import { getActionNames, RuntimeCapabilityCatalog } from '../src/tools/runtime/index.js';
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

  // 非法 selection 的直接断言：快照边界必须抛错，不能静默退化为“不限制”或空授权。
  function invalidSelections(): Array<{ label: string; selection: unknown }> {
    const sparse: string[] = ['code'];
    // 稀疏数组的 hole 在 Array.from 后是 undefined，必须被视为非法成员而不是被 every 跳过。
    sparse.length = 2;
    return [
      { label: 'non-string id', selection: ['code', 1] },
      { label: 'string action value', selection: { code: 'all' } },
      { label: 'sparse ids', selection: sparse },
    ];
  }

  it.each(
    invalidSelections()
  )('rejects an invalid $label selection before invoking any schema port', ({ selection }) => {
    const modern = { querySchemas: vi.fn(() => ({ schemas: [], allowedTools: {} })) };
    const legacy = { toToolSchemas: vi.fn(() => []) };
    const diagnostic = vi.fn();
    for (const catalog of [modern, legacy]) {
      expect(() =>
        queryToolSchemas(catalog, { selection: selection as ToolSelection }, diagnostic)
      ).toThrow('Invalid tool selection');
    }
    expect(modern.querySchemas).toHaveBeenCalledTimes(0);
    expect(legacy.toToolSchemas).toHaveBeenCalledTimes(0);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it.each(
    invalidSelections()
  )('rejects an invalid $label selection in the runtime catalog query and projections', ({
    selection,
  }) => {
    const availability = vi.fn(() => undefined);
    const catalog = new RuntimeCapabilityCatalog({ availability });
    expect(() => catalog.querySchemas({ selection: selection as ToolSelection })).toThrow(
      'Invalid tool selection'
    );
    expect(() => catalog.toToolSchemas(selection as ToolSelection)).toThrow(
      'Invalid tool selection'
    );
  });

  it.each<{ label: string; left: unknown; right: unknown }>([
    { label: 'string right actions', left: { code: ['read'] }, right: { code: 'read' } },
    { label: 'array right', left: { code: ['read'] }, right: ['code'] },
    { label: 'null right', left: { code: ['read'] }, right: null },
    { label: 'non-string right action', left: { code: ['read'] }, right: { code: ['read', 1] } },
    { label: 'string left actions', left: { code: 'read' }, right: { code: ['read'] } },
  ])('rejects an invalid allowlist when intersecting: $label', ({ left, right }) => {
    expect(() => intersectToolActions(left as never, right as never)).toThrow(
      'Invalid tool action allowlist'
    );
  });

  it('never emits normalized entries for tools whose registered or selected actions are empty', () => {
    const available = { code: ['read', 'write'], empty: [] as string[] };
    for (const selection of [undefined, null, ['code', 'empty'], { code: null, empty: null }]) {
      const result = normalizeToolActions(selection, available);
      expect(Object.keys(result)).toEqual(['code']);
      expect(result.code).toEqual(['read', 'write']);
      expect(Object.hasOwn(result, 'empty')).toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
    }
    expect(normalizeToolActions({ code: [], empty: ['read'] }, available)).toEqual({});
    expect(normalizeToolActions({ code: ['missing'] }, available)).toEqual({});
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
  it('exports capability catalog projections from the runtime registry', () => {
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
  it('keeps an initially empty tool slot when another capability grants its action', async () => {
    class FirstCapability extends ReadCapability {
      override get allowedTools(): unknown {
        return { code: [], graph: ['overview'] };
      }
    }
    class SecondCapability extends ReadCapability {
      override get allowedTools(): unknown {
        return { code: ['read'] };
      }
    }
    const native = new RuntimeCapabilityCatalog();
    const querySchemas = vi.fn((query: ToolSchemaQuery) => native.querySchemas(query));
    const { runtime, execute } = runtimeWith({ querySchemas }, new FirstCapability());
    runtime.capabilities.push(new SecondCapability());
    await runtime.reactLoop('combine capability grants');
    expect(Object.keys(querySchemas.mock.calls[0][0].selection ?? {})).toEqual(['code', 'graph']);
    expect(querySchemas.mock.calls[0][0].selection).toEqual({
      code: ['read'],
      graph: ['overview'],
    });
    expect(execute.mock.calls.map(([call]) => `${call.toolId}.${call.args.action}`)).toEqual([
      'graph.overview',
      'code.read',
    ]);
  });

  it.each([
    'empty-to-wildcard',
    'read-to-write',
    'invalid-first',
  ] as const)('consumes one validated capability declaration for %s', async (mode) => {
    let reads = 0;
    const actions: unknown[] = [];
    Object.defineProperty(actions, '0', {
      enumerable: true,
      get: () => {
        reads++;
        return reads === 1 ? (mode === 'invalid-first' ? 42 : 'read') : 'write';
      },
    });
    const declaration =
      mode === 'empty-to-wildcard'
        ? {
            get code() {
              reads++;
              return reads === 1 ? [] : null;
            },
          }
        : { code: actions };
    class SnapshotCapability extends ReadCapability {
      override get allowedTools(): unknown {
        return declaration;
      }
    }
    const { runtime, execute, chatWithTools } = runtimeWith(
      new RuntimeCapabilityCatalog(),
      new SnapshotCapability()
    );
    if (mode === 'invalid-first') {
      await expect(runtime.reactLoop('reject invalid capability')).rejects.toThrow(
        'Invalid capability action allowlist'
      );
      expect(chatWithTools).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } else {
      await runtime.reactLoop('honor first capability snapshot');
      expect(execute.mock.calls.map(([call]) => call.args.action)).toEqual(
        mode === 'empty-to-wildcard' ? [] : ['read']
      );
    }
    expect(reads).toBe(1);
  });

  it.each([
    'ids',
    'actions',
  ] as const)('snapshots query selection %s before validation consumes it', (mode) => {
    let reads = 0;
    const ids: string[] = [];
    Object.defineProperty(ids, '0', {
      enumerable: true,
      get: () => {
        reads++;
        return reads === 1 ? 'code' : 'graph';
      },
    });
    const selection =
      mode === 'ids'
        ? ids
        : {
            get code() {
              reads++;
              return reads === 1 ? [] : null;
            },
          };
    const result = queryToolSchemas(new RuntimeCapabilityCatalog(), { selection }, () => undefined);
    expect(result.schemas.map(({ name }) => name)).toEqual(mode === 'ids' ? ['code'] : []);
    expect(reads).toBe(1);
  });

  it.each([
    { port: 'modern', field: 'description' },
    { port: 'legacy', field: 'description' },
    { port: 'modern', field: 'extension' },
    { port: 'legacy', field: 'extension' },
  ])('does not read an unselected $port schema $field getter', ({ port, field }) => {
    const extension = () => 'live metadata';
    const code = { name: 'code', parameters: { type: 'object' }, extension };
    const graph = { name: 'graph', parameters: { type: 'object' } };
    const unavailableField = vi.fn(() => {
      throw new Error('Unselected projection accessed');
    });
    Object.defineProperty(graph, field, { enumerable: true, get: unavailableField });
    const schemas = [code, graph];
    const catalog =
      port === 'modern'
        ? { querySchemas: () => ({ schemas, allowedTools: { code: null } }) }
        : { toToolSchemas: () => schemas };
    const result = queryToolSchemas(catalog, { selection: ['code'] }, () => undefined);
    expect(unavailableField).not.toHaveBeenCalled();
    expect(result.schemas).toEqual([code]);
    expect(result.schemas[0].extension).toBe(extension);
    expect(result.schemas[0]).not.toHaveProperty('description');
  });

  it.each([
    false,
    true,
  ])('rejects malformed unavailable reasons including sparse=%s before dispatch', async (sparse) => {
    const unavailable: unknown[] = [{ tool: 'graph', reason: 'Port is missing' }];
    if (sparse) {
      unavailable.length = 2;
    } else {
      unavailable.push(undefined);
    }
    const { runtime, execute, chatWithTools } = runtimeWith({
      querySchemas: () => ({
        schemas: [{ name: 'code', parameters: { type: 'object' } }],
        allowedTools: { code: ['read'] },
        unavailable,
      }),
    });
    await expect(runtime.reactLoop('invalid unavailable entries')).rejects.toThrow(
      'Invalid ToolSchemaQueryPort unavailable reasons'
    );
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { port: 'modern', prefix: 'Invalid ToolSchemaQueryPort result' },
    { port: 'toToolSchemas', prefix: 'Invalid legacy schema result from toToolSchemas' },
    { port: 'toMixedSchemas', prefix: 'Invalid legacy schema result from toMixedSchemas' },
  ] as const)('rejects duplicate schema names from the $port port before dispatch', async ({
    port,
    prefix,
  }) => {
    // 两条同名声明的动作枚举互相矛盾；provider 只能拒绝整次请求或让模型看到两套合同。
    const schemas = [
      { name: 'code', parameters: { type: 'object', properties: { action: { enum: ['read'] } } } },
      {
        name: 'code',
        parameters: { type: 'object', properties: { action: { enum: ['write'] } } },
      },
    ];
    const catalog =
      port === 'modern'
        ? { querySchemas: () => ({ schemas, allowedTools: { code: null } }) }
        : { [port]: () => schemas };
    expect(() =>
      queryToolSchemas(catalog, { selection: { code: ['read'] } }, () => undefined)
    ).toThrow(`${prefix}: duplicate tool schema 'code'`);
    const { runtime, execute, chatWithTools } = runtimeWith(catalog);
    await expect(runtime.reactLoop('reject duplicate schema names')).rejects.toThrow(
      "duplicate tool schema 'code'"
    );
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a duplicate host schema name even when the stage did not select that tool', () => {
    const graph = { name: 'graph', parameters: { type: 'object' } };
    const catalog = {
      querySchemas: () => ({
        schemas: [{ name: 'code', parameters: { type: 'object' } }, graph, { ...graph }],
        allowedTools: { code: null, graph: null },
      }),
    };
    // 宿主整份结果已违约；与畸形条目一致按 fail-closed 拒绝，而不是只信任被选中的那一部分。
    expect(() => queryToolSchemas(catalog, { selection: ['code'] }, () => undefined)).toThrow(
      "Invalid ToolSchemaQueryPort result: duplicate tool schema 'graph'"
    );
  });

  it.each<{ label: string; selection: ToolSelection; kept: string[] }>([
    { label: 'action allowlist', selection: { code: ['read'] }, kept: ['code', 'code.read'] },
    { label: 'tool ids', selection: ['code'], kept: ['code', 'code.read', 'code.write'] },
    { label: 'disabled tool', selection: { code: [], memory: null }, kept: ['memory'] },
    {
      label: 'unrestricted',
      selection: null,
      kept: ['memory', 'code', 'code.read', 'code.write'],
    },
  ])('scopes modern unavailable reasons to the caller $label selection', ({ selection, kept }) => {
    const unavailable = [
      { tool: 'memory', reason: 'store missing' },
      { tool: 'code', reason: 'workspace detached' },
      { tool: 'code', action: 'read', reason: 'reader missing', hint: 'extension' },
      { tool: 'code', action: 'write', reason: 'writer missing' },
    ];
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    try {
      const result = queryToolSchemas(
        {
          querySchemas: () => ({
            schemas: [{ name: 'code', parameters: { type: 'object' } }],
            allowedTools: { code: null, memory: null },
            unavailable,
          }),
        },
        { selection },
        () => undefined
      );
      expect(
        result.unavailable?.map(({ tool, action }) => (action ? `${tool}.${action}` : tool))
      ).toEqual(kept);
      if (kept.includes('code.read')) {
        // 保留的条目仍携带宿主扩展字段，过滤不改写条目内容。
        expect(result.unavailable).toContainEqual(unavailable[2]);
      }
      const dropped = unavailable.length - kept.length;
      if (dropped > 0) {
        expect(info).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledWith(
          expect.stringContaining('unavailable_out_of_selection_filtered')
        );
        expect(info).toHaveBeenCalledWith(expect.stringContaining(`dropped=${dropped}`));
      } else {
        expect(info).not.toHaveBeenCalled();
      }
    } finally {
      info.mockRestore();
    }
  });

  it('keeps the filtered unavailable result when the scope log itself throws', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => {
      throw new Error('synthetic logger unavailable');
    });
    try {
      const result = queryToolSchemas(
        {
          querySchemas: () => ({
            schemas: [{ name: 'code', parameters: { type: 'object' } }],
            allowedTools: { code: null },
            unavailable: [
              { tool: 'memory', reason: 'store missing' },
              { tool: 'code', action: 'write', reason: 'writer missing' },
            ],
          }),
        },
        { selection: { code: ['read'] } },
        () => undefined
      );
      expect(result.unavailable).toEqual([]);
      expect(result.allowedTools).toEqual({ code: ['read'] });
      expect(info).toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it.each([
    { port: 'modern', sparse: false },
    { port: 'modern', sparse: true },
    { port: 'legacy', sparse: false },
    { port: 'legacy', sparse: true },
  ])('rejects malformed $port schema entries including sparse=$sparse before dispatch', async ({
    port,
    sparse,
  }) => {
    const schemas: unknown[] = [{ name: 'code', parameters: { type: 'object' } }];
    if (sparse) {
      schemas.length = 2;
    } else {
      schemas.push(undefined);
    }
    const catalog =
      port === 'modern'
        ? { querySchemas: () => ({ schemas, allowedTools: { code: ['read'] } }) }
        : { toToolSchemas: () => schemas };
    const { runtime, execute, chatWithTools } = runtimeWith(catalog);
    await expect(runtime.reactLoop('reject malformed schema list')).rejects.toThrow(
      port === 'modern' ? 'Invalid ToolSchemaQueryPort result' : 'Invalid legacy schema result'
    );
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    'schemas',
    'name',
    'parameters',
    'allowed-actions',
  ] as const)('validates and consumes one snapshot of the modern %s field', async (field) => {
    const parameters = { type: 'object', properties: { action: { enum: ['read'] } } };
    const schema = { name: 'code', description: 'read fixture', parameters };
    let reads = 0;
    const result: Record<string, unknown> = { schemas: [schema], allowedTools: { code: ['read'] } };
    if (field === 'schemas') {
      Object.defineProperty(result, 'schemas', {
        enumerable: true,
        get: () => {
          reads++;
          return reads === 1 ? [schema] : [{ ...schema, parameters: 'invalid-after-validation' }];
        },
      });
    } else if (field === 'allowed-actions') {
      result.allowedTools = {
        get code() {
          reads++;
          return reads === 1 ? [] : null;
        },
      };
    } else {
      Object.defineProperty(schema, field, {
        enumerable: true,
        get: () => {
          reads++;
          return reads === 1
            ? field === 'name'
              ? 'code'
              : parameters
            : field === 'name'
              ? 'graph'
              : 'invalid-after-validation';
        },
      });
    }
    const { runtime, execute, chatWithTools } = runtimeWith({ querySchemas: () => result });
    if (field !== 'allowed-actions') {
      chatWithTools.mockReset().mockResolvedValue({ text: 'done' });
    }
    await runtime.reactLoop('stable validated tool projection');
    expect(reads).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    if (field === 'allowed-actions') {
      // Runtime 省略无工具请求的字段；首次空动作快照必须保持禁用。
      expect(chatWithTools.mock.calls[0]?.[1].toolSchemas).toBeUndefined();
    } else {
      expect(chatWithTools.mock.calls[0]?.[1].toolSchemas).toEqual([
        { name: 'code', description: 'read fixture', parameters },
      ]);
    }
  });

  it.each<{
    selection: ToolSelection;
    model?: string;
    fullActions: boolean;
    method: string;
  }>([
    {
      selection: { code: ['read'] },
      model: 'fixture',
      fullActions: true,
      method: 'toToolSchemasForActions',
    },
    { selection: ['code'], model: 'fixture', fullActions: true, method: 'toToolSchemasForModel' },
    { selection: ['code'], fullActions: true, method: 'toToolSchemas' },
    {
      selection: { code: ['read'] },
      model: 'fixture',
      fullActions: false,
      method: 'toToolSchemasForModel',
    },
  ])('honors explicit full projection via legacy $method', ({
    selection,
    model,
    fullActions,
    method,
  }) => {
    const full = [
      {
        name: 'code',
        description: 'full',
        parameters: {
          type: 'object',
          properties: { action: { enum: ['read', 'write'] } },
        },
      },
    ];
    const mixed = [{ name: 'code', description: 'mixed', parameters: { type: 'object' } }];
    const catalog = {
      toMixedSchemasForActions: () => mixed,
      toMixedSchemas: () => mixed,
      ...(fullActions ? { toToolSchemasForActions: () => full } : {}),
      toToolSchemasForModel: () => full,
      toToolSchemas: () => full,
    };
    const diagnostic = vi.fn();
    const result = queryToolSchemas(catalog, { selection, model, mode: 'full' }, diagnostic);
    expect(result.schemas[0].description).toBe('full');
    expect(diagnostic).toHaveBeenCalledWith(method);
    if (!Array.isArray(selection)) {
      expect(result.allowedTools).toEqual({ code: ['read'] });
      expect(actionsOf(result.schemas)).toEqual([{ tool: 'code', actions: ['read'] }]);
    }
    expect(full[0].parameters.properties.action.enum).toEqual(['read', 'write']);
  });

  it.each([
    false,
    true,
  ])('reports full-to-mixed fallback without losing authorization when logging throws=%s', (throws) => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
      if (throws) {
        throw new Error('synthetic logger unavailable');
      }
    });
    try {
      const catalog = {
        toMixedSchemas: () => [
          {
            name: 'code',
            parameters: {
              type: 'object',
              properties: { action: { enum: ['read', 'write'] } },
            },
          },
        ],
      };
      const diagnostic = vi.fn();
      const result = queryToolSchemas(
        catalog,
        { selection: { code: ['read'] }, mode: 'full' },
        diagnostic
      );
      expect(actionsOf(result.schemas)).toEqual([{ tool: 'code', actions: ['read'] }]);
      expect(result.allowedTools).toEqual({ code: ['read'] });
      expect(diagnostic).toHaveBeenCalledWith('toMixedSchemas');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy_mode_degraded'));
    } finally {
      warn.mockRestore();
    }
  });

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

describe('runtime lazy schema state across runs', () => {
  // 两个都带必填参数 q 的通用工具：用来观察“未用过的工具”在第 2 次运行中是否丢失参数 schema。
  function requiredQueryDefinition(id: string): ToolDefinition {
    return {
      ...genericDefinition(),
      id,
      title: id,
      description: `${id} tool`,
      inputSchema: {
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string' } },
      },
      modelOverrides: {},
    };
  }

  class PairCapability extends ReadCapability {
    override get tools() {
      return ['tool_a', 'tool_b'];
    }
    override get allowedTools(): unknown {
      return { tool_a: ['invoke'], tool_b: ['invoke'] };
    }
  }

  const fullSchemas = [
    {
      name: 'tool_a',
      description: 'tool_a tool',
      parameters: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
    },
    {
      name: 'tool_b',
      description: 'tool_b tool',
      parameters: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
    },
  ];

  it('keeps complete schemas for unused tools when one catalog serves two runs', async () => {
    const catalog = new UnifiedToolCatalog([
      requiredQueryDefinition('tool_a'),
      requiredQueryDefinition('tool_b'),
    ]);
    const query = vi.spyOn(catalog, 'querySchemas');

    const first = runtimeWith(catalog, new PairCapability());
    first.chatWithTools
      .mockReset()
      .mockResolvedValueOnce({
        functionCalls: [{ id: 'use-a', name: 'tool_a', args: { q: 'x' } }],
      })
      .mockResolvedValue({ text: 'done' });
    await first.runtime.reactLoop('first run');
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(first.chatWithTools.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of first.chatWithTools.mock.calls) {
      expect(call[1].toolSchemas).toEqual(fullSchemas);
    }

    const second = runtimeWith(catalog, new PairCapability());
    second.chatWithTools.mockReset().mockResolvedValue({ text: 'done' });
    await second.runtime.reactLoop('second run');
    // 第 2 次运行里 tool_b 从未被调用过，仍须保留必填参数 q，而不是降级为空对象 schema。
    expect(second.chatWithTools.mock.calls[0]?.[1].toolSchemas).toEqual(fullSchemas);
    expect(query.mock.calls.map(([request]) => request.firstRound)).toEqual([true, true]);
    // 运行时不再把运行内用过的工具写回进程级目录单例。
    expect(catalog.expandedCount).toBe(0);
  });

  it('requests complete schemas even when a host already marked catalog tools as expanded', async () => {
    const catalog = new UnifiedToolCatalog([
      requiredQueryDefinition('tool_a'),
      requiredQueryDefinition('tool_b'),
    ]);
    // 宿主或其他调用方直接操作公开的 lazy 方法时，运行时也不能据此把未展开工具降级。
    catalog.markExpanded('tool_a');
    const query = vi.spyOn(catalog, 'querySchemas');
    const { runtime, chatWithTools } = runtimeWith(catalog, new PairCapability());
    chatWithTools.mockReset().mockResolvedValue({ text: 'done' });
    await runtime.reactLoop('pre-expanded catalog');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatchObject({ mode: 'mixed', firstRound: true });
    expect(chatWithTools.mock.calls[0]?.[1].toolSchemas).toEqual(fullSchemas);
    // 类方法语义不变：运行时没有重置或改写宿主自己登记的展开状态。
    expect(catalog.expandedCount).toBe(1);
  });

  // 以下用例对应 L5 审阅 I15：pipeline 每个阶段在同一个 runtime 上各跑一次 reactLoop，
  // 每个循环只在 #initLoop 查询一次 schema；前一阶段用过的工具不能让后一阶段降级未用工具。
  it('keeps complete schemas in a later stage loop of the same runtime after an earlier loop used a tool', async () => {
    const catalog = new UnifiedToolCatalog([
      requiredQueryDefinition('tool_a'),
      requiredQueryDefinition('tool_b'),
    ]);
    const query = vi.spyOn(catalog, 'querySchemas');
    const { runtime, execute, chatWithTools } = runtimeWith(catalog, new PairCapability());
    chatWithTools
      .mockReset()
      .mockResolvedValueOnce({
        functionCalls: [{ id: 'stage-1-a', name: 'tool_a', args: { q: 'x' } }],
      })
      .mockResolvedValue({ text: 'done' });
    await runtime.reactLoop('stage 1 loop');
    expect(execute).toHaveBeenCalledTimes(1);
    const secondLoopStart = chatWithTools.mock.calls.length;

    await runtime.reactLoop('stage 2 loop');
    // 第 2 个循环首轮：tool_b 从未被调用，也必须带着必填参数 q 发给 provider。
    expect(chatWithTools.mock.calls[secondLoopStart]?.[1].toolSchemas).toEqual(fullSchemas);
    // 每个循环恰好查询一次，且都要完整 schema；运行时不向目录写展开状态。
    expect(query.mock.calls.map(([request]) => [request.mode, request.firstRound])).toEqual([
      ['mixed', true],
      ['mixed', true],
    ]);
    expect(catalog.expandedCount).toBe(0);
  });

  it('leaves the production RuntimeCapabilityCatalog expansion state untouched and its output unchanged', async () => {
    // 生产宿主把 RuntimeCapabilityCatalog 注册为 capabilityCatalog；它忽略 mode/firstRound，
    // 修复后运行时既不再读取也不再累积它的 expandedCount（此前每次运行都会往单例里加工具名）。
    const catalog = new RuntimeCapabilityCatalog();
    const query = vi.spyOn(catalog, 'querySchemas');
    const first = runtimeWith(catalog);
    await first.runtime.reactLoop('production catalog first run');
    // 无可用性限制时 graph.overview 与 code.read 都会执行；两者此前都会被写进展开集合。
    expect(first.execute.mock.calls.map(([call]) => call.toolId)).toEqual(['graph', 'code']);
    expect(catalog.expandedCount).toBe(0);

    const second = runtimeWith(catalog);
    await second.runtime.reactLoop('production catalog second run');
    expect(catalog.expandedCount).toBe(0);
    expect(query.mock.calls.map(([request]) => request?.firstRound)).toEqual([true, true]);
    // 生产输出不随运行次数变化：两次运行发给 provider 的首轮 schema 完全一致。
    const firstSchemas = first.chatWithTools.mock.calls[0]?.[1].toolSchemas;
    expect(firstSchemas?.map((schema: { name: string }) => schema.name)).toEqual(['code', 'graph']);
    expect(second.chatWithTools.mock.calls[0]?.[1].toolSchemas).toEqual(firstSchemas);
  });

  it('keeps the legacy mixed-first selection order and forwards firstRound=true on every run', async () => {
    // 旧 mixed 宿主：同时提供 mixed 与完整端口，并自带实例级展开状态（与旧目录形状一致）。
    // firstRound=false 时它只给空参数 schema，用来暴露“按展开状态推导 firstRound”的回归。
    const expanded = new Set<string>();
    const pick = (actions: ToolActionAllowlist) =>
      fullSchemas.filter((schema) => Object.hasOwn(actions, schema.name));
    const legacy = {
      toMixedSchemasForActions: vi.fn(
        (actions: ToolActionAllowlist, _model?: string, firstRound?: boolean) =>
          pick(actions).map((schema) =>
            firstRound || expanded.has(schema.name)
              ? schema
              : {
                  name: schema.name,
                  description: schema.description,
                  parameters: { type: 'object', properties: {} },
                }
          )
      ),
      toToolSchemasForActions: vi.fn((actions: ToolActionAllowlist) => pick(actions)),
      markExpanded: vi.fn((id: string) => {
        expanded.add(id);
      }),
      get expandedCount() {
        return expanded.size;
      },
    };
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    try {
      const first = runtimeWith(legacy, new PairCapability());
      first.chatWithTools
        .mockReset()
        .mockResolvedValueOnce({
          functionCalls: [{ id: 'legacy-a', name: 'tool_a', args: { q: 'x' } }],
        })
        .mockResolvedValue({ text: 'done' });
      await first.runtime.reactLoop('legacy first run');
      expect(first.execute).toHaveBeenCalledTimes(1);

      const second = runtimeWith(legacy, new PairCapability());
      second.chatWithTools.mockReset().mockResolvedValue({ text: 'done' });
      await second.runtime.reactLoop('legacy second run');

      expect(second.chatWithTools.mock.calls[0]?.[1].toolSchemas).toEqual(fullSchemas);
      // 运行时保持 mode:'mixed'：旧宿主仍按 mixed 优先的既有顺序选中 toMixedSchemasForActions，
      // 第三个参数 firstRound 每次都是 true，不会退到完整端口，也不报告 full→mixed 降级。
      expect(legacy.toMixedSchemasForActions.mock.calls.map((call) => call[2])).toEqual([
        true,
        true,
      ]);
      expect(legacy.toToolSchemasForActions).not.toHaveBeenCalled();
      expect(legacy.markExpanded).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('legacy_mode_degraded'));

      // 对照：若运行时改成 mode:'full'，同一个旧宿主会改选完整端口，选择顺序随之变化；
      // 这是运行时固定 firstRound:true 而不切换 mode 的原因（两者给出的 schema 相同）。
      const diagnostic = vi.fn();
      const full = queryToolSchemas(
        legacy,
        { selection: { tool_a: ['invoke'], tool_b: ['invoke'] }, mode: 'full' },
        diagnostic
      );
      expect(diagnostic).toHaveBeenCalledWith('toToolSchemasForActions');
      expect(full.schemas).toEqual(fullSchemas);
    } finally {
      warn.mockRestore();
    }
  });
});
