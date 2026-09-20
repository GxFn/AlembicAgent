import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  isToolResultEnvelope,
  presentToolResult,
  projectToolResultOrdinaryOutput,
  TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  type ToolCapabilityManifest,
  type ToolDefinition,
  type ToolResultEnvelope,
  UnifiedToolCatalog,
} from '../src/index.js';
import { type ToolContext, ToolRouterAdapter } from '../src/tools/runtime/index.js';

function walkSource(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSource(filePath, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(filePath);
    }
  }
  return acc;
}

function createManifest(overrides: Partial<ToolCapabilityManifest> = {}): ToolCapabilityManifest {
  const manifest: ToolCapabilityManifest = {
    id: 'demo.echo',
    title: 'Demo Echo',
    kind: 'internal-tool',
    description: 'Echo test input',
    owner: 'agent',
    lifecycle: 'active',
    surfaces: ['runtime'],
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
    risk: {
      sideEffect: false,
      dataAccess: 'none',
      writeScope: 'none',
      network: 'none',
      credentialAccess: 'none',
      requiresHumanConfirmation: 'never',
      owaspTags: [],
    },
    execution: {
      adapter: 'internal',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      abortMode: 'cooperative',
      cachePolicy: 'none',
      concurrency: 'parallel-safe',
      artifactMode: 'inline',
    },
    governance: {
      policyProfile: 'read',
      auditLevel: 'checkOnly',
      approvalPolicy: 'auto',
      allowedRoles: ['developer'],
      allowInComposer: true,
      allowInRemoteMcp: false,
      allowInNonInteractive: true,
    },
    evals: {
      required: false,
      cases: [],
    },
  };

  return {
    ...manifest,
    ...overrides,
    risk: { ...manifest.risk, ...overrides.risk },
    execution: { ...manifest.execution, ...overrides.execution },
    governance: { ...manifest.governance, ...overrides.governance },
    evals: { ...manifest.evals, ...overrides.evals },
  };
}

function collectObjectKeys(value: unknown, prefix: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjectKeys(item, prefix));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...prefix, key];
    return [key, path.join('.'), ...collectObjectKeys(child, path)];
  });
}

function createEnvelopeForStatus(status: ToolResultEnvelope['status']): ToolResultEnvelope {
  const ok = status === 'success' || status === 'partial';
  return {
    ok,
    toolId: `demo.${status}`,
    callId: `call-${status}`,
    startedAt: '2026-06-10T00:00:00.000Z',
    durationMs: 3,
    status,
    text: `branch ${status}`,
    structuredContent: {
      branch: status,
      publicValue: 'kept',
      rawProviderResponse: { token: 'hidden' },
      data: { result: { rawProviderRequest: { prompt: 'hidden' } }, kept: true },
      nested: { threadId: 'host-thread', visible: true },
    },
    artifacts: [{ id: `artifact-${status}`, kind: 'log', uri: `memory://artifact/${status}` }],
    resources: [{ uri: `memory://resource/${status}`, title: `${status} resource` }],
    diagnostics: {
      degraded: !ok,
      fallbackUsed: false,
      warnings: [{ code: `${status}-warning`, message: 'raw warning kept out of projection' }],
      timedOutStages: status === 'timeout' ? ['execute'] : [],
      blockedTools: status === 'blocked' ? [{ tool: `demo.${status}`, reason: 'policy' }] : [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: status === 'error' ? 1 : 0,
      gateFailures:
        status === 'needs-confirmation'
          ? [{ stage: 'approve', action: 'needs-confirmation', reason: 'approval' }]
          : [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

it('sanitizes the JSON text projection as well as structuredContent', () => {
  const envelope = createEnvelopeForStatus('success');
  envelope.structuredContent = { apiKey: 'synthetic-sensitive-value', publicValue: 'kept' };
  envelope.text = JSON.stringify(envelope.structuredContent, null, 2);
  const output = projectToolResultOrdinaryOutput(envelope);
  expect(output.structuredContent).toEqual({ publicValue: 'kept' });
  expect(JSON.parse(output.text)).toEqual({ publicValue: 'kept' });
  expect(JSON.stringify(output)).not.toContain('synthetic-sensitive-value');
});

describe('tool kernel contract', () => {
  it('removes the V1 core-contract shims and the runtime bridge from source', () => {
    const removed = [
      'src/tools/core/InternalToolHandler.ts',
      'src/tools/core/ToolCallContext.ts',
      'src/tools/core/ToolContracts.ts',
      'src/tools/core/ToolDecision.ts',
      'src/tools/core/ToolResultEnvelope.ts',
      'src/tools/core/ToolResultPresenter.ts',
      'src/tools/core/ToolRoutingServices.ts',
      'src/tools/runtime/ToolRuntimeBridge.ts',
    ];
    for (const rel of removed) {
      expect(existsSync(path.join(process.cwd(), rel))).toBe(false);
    }

    const stragglers = walkSource(path.join(process.cwd(), 'src'))
      .map((filePath) => ({
        file: path.relative(process.cwd(), filePath),
        text: readFileSync(filePath, 'utf8'),
      }))
      .filter(
        ({ text }) =>
          text.includes('#tools/runtime/ToolRuntimeBridge') ||
          /#tools\/core\/(InternalToolHandler|ToolCallContext|ToolContracts|ToolDecision|ToolResultEnvelope|ToolResultPresenter|ToolRoutingServices)\.js/.test(
            text
          )
      )
      .map(({ file }) => file)
      .sort();

    expect(stragglers).toEqual([]);
  });

  it('re-exports the tool contract from the kernel on the public ./tools surface', () => {
    const toolsIndex = readFileSync(path.join(process.cwd(), 'src/tools/index.ts'), 'utf8');
    const kernelReexports = toolsIndex
      .split('\n')
      .filter((line) => line.startsWith("export * from './kernel/"))
      .map((line) => line.trim())
      .sort();

    expect(kernelReexports).toEqual([
      "export * from './kernel/context.js';",
      "export * from './kernel/decision.js';",
      "export * from './kernel/handler.js';",
      "export * from './kernel/presenter.js';",
      "export * from './kernel/request.js';",
      "export * from './kernel/result.js';",
      "export * from './kernel/routing.js';",
    ]);
    expect(toolsIndex).not.toContain("export * from './core/LightweightRouter.js';");
    expect(toolsIndex).not.toContain("export * from './terminal/index.js';");
  });
});

/** 经真实adapter/router/registry/handler检查接线，不把知识端口测试降成局部选择器。 */
function knowledgeAdapter(ports: Partial<ToolContext>) {
  const adapter = new ToolRouterAdapter({
    contextFactory: {
      create: () => ({ projectRoot: process.cwd(), tokenBudget: 4000, ...ports }),
    },
  });
  return (action: string, params: Record<string, unknown>, abortSignal?: AbortSignal) =>
    adapter.execute({
      toolId: 'knowledge',
      args: { action, params },
      surface: 'runtime',
      actor: { role: 'developer', user: 'port-test-user' },
      source: { kind: 'runtime', name: 'knowledge-port-test' },
      abortSignal,
    });
}

describe('knowledge host ports through ToolRouterAdapter', () => {
  const managementCases = [
    {
      operation: 'update',
      params: { operation: 'update', id: 'recipe', data: { description: 'Updated' } },
      args: ['recipe', { description: 'Updated' }],
      status: 'updated',
    },
    {
      operation: 'reject',
      params: { operation: 'reject', id: 'recipe', reason: 'Review declined' },
      args: ['recipe', 'Review declined'],
      status: 'rejected',
    },
    {
      operation: 'score',
      params: { operation: 'score', id: 'recipe', data: { score: 73 } },
      args: ['recipe', 73],
      status: 'scored',
    },
    {
      operation: 'validate',
      params: { operation: 'validate', id: 'recipe' },
      args: ['recipe'],
      status: 'validated',
    },
  ];

  it('reads from the explicit knowledge port before the legacy repository', async () => {
    const dto = { id: 'recipe', title: 'Explicit read DTO', lifecycle: 'pending' };
    const read = {
      getById: vi.fn(async function (this: unknown, id: string) {
        expect(this).toBe(read);
        expect(id).toBe('recipe');
        return dto;
      }),
    };
    const legacyRead = vi.fn(async () => ({ id: 'recipe', title: 'Legacy repository' }));
    const result = await knowledgeAdapter({
      knowledgeRead: read,
      knowledgeRepo: { getById: legacyRead },
    })('detail', { id: 'recipe' });

    expect(result.ok).toBe(true);
    expect(result.structuredContent).toEqual(dto);
    expect(read.getById).toHaveBeenCalledOnce();
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it.each(managementCases)('routes $operation through the explicit management port', async ({
    params,
    args,
    status,
  }) => {
    const method = vi.fn(async function (this: unknown) {
      expect(this).toBe(management);
      return { checked: true };
    });
    const management = { update: method, reject: method, score: method, validate: method };
    const legacy = vi.fn(async () => undefined);
    const result = await knowledgeAdapter({
      knowledgeManagement: management,
      knowledgeRepo: { update: legacy, reject: legacy, score: legacy, validate: legacy },
    })('manage', params);

    expect(result.ok).toBe(true);
    expect(result.structuredContent).toMatchObject({ id: 'recipe', status });
    if (params.operation === 'validate') {
      expect(result.structuredContent).toMatchObject({ result: { checked: true } });
    }
    expect(method).toHaveBeenCalledExactlyOnceWith(...args);
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each(
    managementCases
  )('does not fall back when the explicit management port lacks $operation', async ({
    operation,
    params,
  }) => {
    const legacy = vi.fn(async () => undefined);
    const result = await knowledgeAdapter({
      knowledgeManagement: {},
      knowledgeRepo: { update: legacy, reject: legacy, score: legacy, validate: legacy },
    })('manage', params);

    expect(result.ok).toBe(false);
    expect(result.structuredContent).toMatchObject({
      status: 'port-unavailable',
      code: 'KNOWLEDGE_MANAGEMENT_PORT_UNAVAILABLE',
      port: 'knowledgeManagement',
      method: operation,
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it('enriches prime results through the explicit read port', async () => {
    const getById = vi.fn(async () => ({
      id: 'recipe',
      doClause: 'Use the controlled read DTO.',
      reasoning: { sources: ['src/a.ts:1-2'] },
    }));
    const legacy = vi.fn(async () => ({ doClause: 'Legacy result' }));
    const result = await knowledgeAdapter({
      searchEngine: { search: async () => [{ id: 'recipe', title: 'Recipe', score: 1 }] },
      knowledgeRead: { getById },
      knowledgeRepo: { getById: legacy },
    })('prime', { taskGoal: 'Edit the module' });

    expect(result.ok).toBe(true);
    expect(result.structuredContent).toMatchObject({
      knowledge: [
        { id: 'recipe', doClause: 'Use the controlled read DTO.', sources: ['src/a.ts:1-2'] },
      ],
    });
    expect(getById).toHaveBeenCalledExactlyOnceWith('recipe');
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each([
    'detail',
    'prime',
  ])('does not fall back from an incomplete explicit read port for %s', async (action) => {
    const legacy = vi.fn(async () => ({ id: 'recipe' }));
    const result = await knowledgeAdapter({
      searchEngine: { search: async () => [{ id: 'recipe', title: 'Recipe', score: 1 }] },
      // 模拟未类型检查的宿主注入；运行时不能把缺能力掩盖成旧仓储成功。
      knowledgeRead: {} as never,
      knowledgeRepo: { getById: legacy },
    })(action, { id: 'recipe', taskGoal: 'Read context' });

    expect(result.ok).toBe(false);
    expect(result.structuredContent).toMatchObject({
      code: 'KNOWLEDGE_READ_PORT_UNAVAILABLE',
      port: 'knowledgeRead',
      method: 'getById',
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it('preserves search-only prime when no knowledge reader was provided', async () => {
    const result = await knowledgeAdapter({
      searchEngine: {
        search: async () => [{ id: 'recipe', title: 'Search-only recipe', score: 1 }],
      },
    })('prime', { taskGoal: 'Read context' });
    expect(result.ok).toBe(true);
    expect(result.structuredContent).toMatchObject({
      knowledge: [{ title: 'Search-only recipe' }],
    });
  });

  it('keeps prime search results while diagnosing a failed detail enrichment', async () => {
    const getById = vi.fn(async () => {
      throw new Error('read port unavailable');
    });
    const result = await knowledgeAdapter({
      searchEngine: { search: async () => [{ id: 'recipe', title: 'Search result', score: 1 }] },
      knowledgeRead: { getById },
    })('prime', { taskGoal: 'Read context' });
    expect(result.ok).toBe(true);
    expect(result.structuredContent).toMatchObject({
      knowledge: [{ id: 'recipe', title: 'Search result' }],
    });
    expect(getById).toHaveBeenCalledOnce();
    expect(result.diagnostics).toMatchObject({
      degraded: true,
      warnings: [expect.objectContaining({ code: 'KNOWLEDGE_PRIME_DETAIL_UNAVAILABLE' })],
    });
  });

  it.each([
    'search',
    'prime',
  ])('checks the search capability before executing %s', async (action) => {
    const result = await knowledgeAdapter({ searchEngine: {} })(action, {
      query: 'recipe',
      taskGoal: 'Read context',
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('Search engine not available');
    expect(result.text).not.toContain('is not a function');
  });

  it('keeps the legacy repository usable when the corresponding explicit port is absent', async () => {
    const getById = vi.fn(async () => ({ id: 'recipe', title: 'Legacy DTO' }));
    const method = vi.fn(async () => ({ checked: true }));
    const call = knowledgeAdapter({
      knowledgeRepo: { getById, update: method, reject: method, score: method, validate: method },
    });
    expect((await call('detail', { id: 'recipe' })).structuredContent).toMatchObject({
      title: 'Legacy DTO',
    });
    for (const { params, args, status } of managementCases) {
      const result = await call('manage', params);
      expect(result.ok).toBe(true);
      expect(result.structuredContent).toMatchObject({ status });
      expect(method).toHaveBeenLastCalledWith(...args);
    }
    expect(getById).toHaveBeenCalledOnce();
    expect(method).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['knowledgeRead', 'detail'],
    ['knowledgeManagement', 'manage'],
  ])('does not treat an explicit null %s as permission to use a raw repository', async (port, action) => {
    const legacy = vi.fn(async () => ({ id: 'recipe' }));
    const result = await knowledgeAdapter({
      [port]: null,
      knowledgeRepo: { getById: legacy, update: legacy },
    })(action, { id: 'recipe', operation: 'update', data: { description: 'Edit' } });
    expect(result.ok).toBe(false);
    expect(result.structuredContent).toMatchObject({ status: 'port-unavailable', port });
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each([
    'failure',
    'not-found',
  ])('does not hide an explicit read %s with a legacy lookup', async (mode) => {
    const getById = vi.fn(async () => {
      if (mode === 'failure') {
        throw new Error('Explicit reader failed');
      }
      return null;
    });
    const legacy = vi.fn(async () => ({ id: 'recipe', title: 'Must not be read' }));
    const result = await knowledgeAdapter({
      knowledgeRead: { getById },
      knowledgeRepo: { getById: legacy },
    })('detail', { id: 'recipe' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain(
      mode === 'failure' ? 'Explicit reader failed' : 'Recipe not found'
    );
    expect(getById).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each([
    'detail',
    'update',
  ])('retains the established cancellation contract for explicit %s', async (operation) => {
    const controller = new AbortController();
    const method = vi.fn(async () => {
      controller.abort();
      return { id: 'recipe', title: 'Confirmed host result' };
    });
    const result = await knowledgeAdapter({
      knowledgeRead: { getById: method },
      knowledgeManagement: { update: method },
    })(
      operation === 'detail' ? 'detail' : 'manage',
      { id: 'recipe', operation, data: { description: 'Edit' } },
      controller.signal
    );
    expect(method).toHaveBeenCalledOnce();
    expect(result.ok).toBe(operation === 'update');
    expect(result.status).toBe(operation === 'update' ? 'success' : 'aborted');
    if (operation === 'update') {
      expect(result.structuredContent).toMatchObject({ status: 'updated' });
      expect(result.diagnostics?.warnings).toContainEqual(
        expect.objectContaining({ code: 'KNOWLEDGE_MUTATION_COMPLETED_AFTER_ABORT' })
      );
    }
  });

  it('preserves partial-write evidence from an explicit management failure', async () => {
    const details = { entryIds: ['recipe'], fileOpsCompleted: 1, reconcileVia: 'read-back' };
    const error = Object.assign(new Error('Core state diverged'), {
      code: 'STATE_DIVERGENCE',
      details,
    });
    const update = vi.fn(async () => {
      throw error;
    });
    const legacy = vi.fn(async () => undefined);
    const result = await knowledgeAdapter({
      knowledgeManagement: { update },
      knowledgeRepo: { update: legacy },
    })('manage', { operation: 'update', id: 'recipe', data: { description: 'Edit' } });
    expect(result.ok).toBe(false);
    expect(result.structuredContent).toMatchObject({
      code: 'STATE_DIVERGENCE',
      details,
      writeState: 'partial',
      requiresReadback: true,
    });
    expect(update).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe('UnifiedToolCatalog', () => {
  it('projects tool schemas and preserves internal handler access', () => {
    const definition: ToolDefinition = {
      id: 'demo.echo',
      title: 'Demo Echo',
      description: 'Full echo schema',
      kind: 'internal-tool',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      handler: async (args) => ({ echoed: args.value }),
      risk: createManifest().risk,
      governance: createManifest().governance,
      execution: createManifest().execution,
      modelOverrides: {
        'gpt-*': {
          description: 'Model-specific echo schema',
          inputSchema: { type: 'object', properties: { compact: { type: 'boolean' } } },
        },
      },
    };
    const catalog = new UnifiedToolCatalog([definition]);

    expect(catalog.getManifest('demo.echo')).toMatchObject({
      id: 'demo.echo',
      kind: 'internal-tool',
    });
    expect(catalog.getInternalTool('demo.echo')).toMatchObject({
      name: 'demo.echo',
      description: 'Full echo schema',
    });
    expect(catalog.toLightweightSchemas()[0]).toMatchObject({
      name: 'demo.echo',
      parameters: { type: 'object', properties: {} },
    });

    catalog.markExpanded('demo.echo');

    expect(catalog.toMixedSchemas(null, 'gpt-5', false)[0]).toMatchObject({
      description: 'Model-specific echo schema',
      parameters: { type: 'object', properties: { compact: { type: 'boolean' } } },
    });

    expect(catalog.unregister('demo.echo')).toBe(true);
    expect(catalog.getHandler('demo.echo')).toBeNull();
    expect(catalog.expandedCount).toBe(0);
    expect(() => catalog.registerDefinition(definition)).not.toThrow();
    catalog.unregister('demo.echo');
    catalog.register(createManifest());
    expect(() => catalog.registerDefinition(definition)).toThrow();
    expect(catalog.getHandler('demo.echo')).toBeNull();
  });
});

describe('tool result ordinary output', () => {
  it('recognizes and presents result envelopes without a retired router dependency', () => {
    const envelope = createEnvelopeForStatus('success');

    expect(isToolResultEnvelope(envelope)).toBe(true);
    expect(presentToolResult(envelope)).toBe('branch success');
  });

  it('projects ordinary result output without diagnostics or forbidden private fields', () => {
    const envelope = createEnvelopeForStatus('success');
    const projected = projectToolResultOrdinaryOutput(envelope);
    const projectedKeys = new Set(collectObjectKeys(projected));

    expect(projected).toMatchObject({
      ok: true,
      status: 'success',
      text: 'branch success',
      structuredContent: {
        branch: 'success',
        publicValue: 'kept',
        data: { kept: true },
        nested: { visible: true },
      },
      artifacts: [{ id: 'artifact-success', kind: 'log', uri: 'memory://artifact/success' }],
      resources: [{ uri: 'memory://resource/success', title: 'success resource' }],
      diagnosticSummary: {
        degraded: false,
        warningCount: 1,
        warningCodes: ['success-warning'],
        redactedFieldCount: 3,
      },
    });
    expect(projected).not.toHaveProperty('diagnostics');
    for (const field of TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS) {
      expect(projectedKeys.has(field)).toBe(false);
    }
  });

  it('projects text-only envelopes as canonical ordinary output', () => {
    const envelope: ToolResultEnvelope = { ...createEnvelopeForStatus('success') };
    delete envelope.structuredContent;

    const projected = projectToolResultOrdinaryOutput(envelope);

    expect(projected).toMatchObject({
      ok: true,
      toolId: 'demo.success',
      callId: 'call-success',
      status: 'success',
      text: 'branch success',
      diagnosticSummary: {
        degraded: false,
        warningCodes: ['success-warning'],
        redactedFieldCount: 0,
      },
    });
    expect(projected).not.toHaveProperty('structuredContent');
    expect(projected).not.toHaveProperty('success');
    expect(projected).not.toHaveProperty('message');
    expect(projected).not.toHaveProperty('error');
    expect(projected).not.toHaveProperty('errorCode');
  });

  it('projects D25 failure taxonomy as stable ordinary output metadata', () => {
    const fixture = ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.find(
      (item) => item.branch === 'provider-error'
    );
    const envelope = createEnvelopeForStatus('error');
    const projected = projectToolResultOrdinaryOutput(envelope, {
      failureTaxonomy: fixture?.failureTaxonomy,
    });
    const projectedKeys = new Set(collectObjectKeys(projected));

    expect(projected.failureTaxonomy).toMatchObject({
      kind: 'provider-error',
      stableId: 'core.failure.provider-error',
      agentBranch: 'provider-error',
      problemClass: 'provider-problem',
      privateDataSafe: true,
    });
    expect(projected).not.toHaveProperty('diagnostics');
    expect(projected.structuredContent).toMatchObject({
      branch: 'error',
      publicValue: 'kept',
    });
    for (const field of TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS) {
      expect(projectedKeys.has(field)).toBe(false);
    }
  });

  it('projects every Agent contract branch without collapsing result status semantics', () => {
    const projectedStatuses = ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.map((fixture) => {
      const status = fixture.toolStatus ?? 'error';
      const projected = projectToolResultOrdinaryOutput(createEnvelopeForStatus(status));
      const projectedKeys = new Set(collectObjectKeys(projected));

      for (const field of TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS) {
        expect(projectedKeys.has(field)).toBe(false);
      }
      expect(projected.diagnosticSummary.warningCodes).toEqual([`${status}-warning`]);
      expect(projected.diagnosticSummary.redactedFieldCount).toBeGreaterThan(0);

      return [fixture.branch, projected.status] as const;
    });

    expect(projectedStatuses).toEqual([
      ['success', 'success'],
      ['failure', 'error'],
      ['cancellation', 'aborted'],
      ['timeout', 'timeout'],
      ['permission-denial', 'blocked'],
      ['needs-confirmation', 'needs-confirmation'],
      ['partial-result', 'partial'],
      ['provider-error', 'error'],
      ['host-failure', 'error'],
      ['host-adapter', 'error'],
    ]);
  });
});
