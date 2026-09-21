import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
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
  it.each([
    'throw',
    'reject',
  ])('retains read cancellation when the %s logger fails', async (mode) => {
    const controller = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
      if (mode === 'reject') {
        return Promise.reject(new Error('fixture cancellation logger failure'));
      }
      throw new Error('fixture cancellation logger failure');
    });
    const read = knowledgeAdapter({
      knowledgeRead: {
        getById: async () => {
          enter();
          await pending;
          return null;
        },
      },
    });
    const result = read('detail', { id: 'fixture' }, controller.signal);
    try {
      await entered;
      controller.abort();
      const envelope = await result;
      expect(envelope).toMatchObject({ ok: false, status: 'aborted' });
      expect(envelope.text).toContain('detail aborted');
      expect(envelope.text).not.toContain('fixture cancellation logger failure');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      release();
      await result;
      warn.mockRestore();
    }
  });

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

  it.each([
    'sync',
    'async',
  ])('retains the confirmed update when its %s diagnostic logger fails', async (mode) => {
    const controller = new AbortController();
    const update = vi.fn(async () => {
      controller.abort(new Error('fixture cancelled after write'));
      return { id: 'recipe', confirmed: true };
    });
    const logger = Logger.getInstance();
    const originalWarn = logger.warn;
    let warningCalls = 0;
    // 不用返回 Promise 的 mock spy：mock 框架自身可能订阅 rejection，掩盖漏掉的观察边界。
    logger.warn = () => {
      warningCalls++;
      if (mode === 'async') {
        return Promise.reject(new Error('fixture diagnostic failure'));
      }
      throw new Error('fixture diagnostic failure');
    };
    try {
      const result = await knowledgeAdapter({ knowledgeManagement: { update } })(
        'manage',
        { id: 'recipe', operation: 'update', data: { description: 'Confirmed update' } },
        controller.signal
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(update).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        ok: true,
        status: 'success',
        structuredContent: { id: 'recipe', status: 'updated' },
      });
      expect(result.diagnostics.warnings).toContainEqual(
        expect.objectContaining({ code: 'KNOWLEDGE_MUTATION_COMPLETED_AFTER_ABORT' })
      );
      expect(warningCalls).toBe(1);
    } finally {
      logger.warn = originalWarn;
    }
  });

  it.each([
    'detail',
    'search',
    'prime',
    'validate',
  ])('preserves a non-Error %s port rejection diagnostic', async (action) => {
    const rejectRead = () => Promise.reject('Fixture original read rejection');
    const result = await knowledgeAdapter({
      knowledgeRead: { getById: rejectRead },
      searchEngine: { search: rejectRead },
      knowledgeManagement: { validate: rejectRead },
    })(action === 'validate' ? 'manage' : action, {
      id: 'recipe',
      query: 'recipe',
      taskGoal: 'Read recipe',
      operation: 'validate',
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('Fixture original read rejection');
  });

  it.each([
    'detail',
    'search',
    'prime-search',
    'prime-detail',
    'validate',
  ])('ends a cancelled %s read before its non-cooperative port settles', async (readStage) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    let rejectRead!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve, reject) => {
      release = resolve;
      rejectRead = reject;
    });
    const waitForPort = vi.fn(async () => {
      entered();
      await waiting;
    });
    const getById = vi.fn(async (id: string) => {
      await waitForPort();
      return { id, title: 'Late detail must not replace cancellation' };
    });
    const search = vi.fn(async () => {
      if (readStage !== 'prime-detail') {
        await waitForPort();
      }
      return [
        { id: 'recipe', title: 'First result', score: 1 },
        { id: 'next-recipe', title: 'Must not start another detail read', score: 0.5 },
      ];
    });
    const pending = knowledgeAdapter({
      knowledgeRead: { getById },
      searchEngine: { search },
      knowledgeManagement: { validate: waitForPort },
    })(
      readStage === 'validate' ? 'manage' : readStage.startsWith('prime-') ? 'prime' : readStage,
      { id: 'recipe', operation: 'validate', query: 'recipe', taskGoal: 'Read recipe' },
      controller.signal
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await started;
      controller.abort(new Error('fixture read cancelled'));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      const result = await pending;
      expect(result).toMatchObject({ ok: false, status: 'aborted' });
      expect(result.structuredContent).toBeNull();
      expect(waitForPort).toHaveBeenCalledOnce();
      expect(getById).toHaveBeenCalledTimes(['detail', 'prime-detail'].includes(readStage) ? 1 : 0);
      // 同时覆盖迟到数据与迟到拒绝；已结束的工具不能重放或启动 prime 的下一次详情读取。
      if (readStage === 'validate') {
        rejectRead(new Error('late read failure'));
      } else {
        release();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toBe(result);
      expect(waitForPort).toHaveBeenCalledOnce();
    } finally {
      release();
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
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

describe('graph and plan host outcomes', () => {
  function execute(
    ports: Partial<ToolContext>,
    toolId: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal
  ) {
    return new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: process.cwd(), tokenBudget: 4000, ...ports }),
      },
    }).execute({
      toolId,
      args,
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime' },
      abortSignal,
    });
  }

  it('awaits an async graph overview and preserves the host facts', async () => {
    const overview = { totalFiles: 3, totalClasses: 2, topLevelModules: ['src'] };
    const result = await execute({ projectGraph: { getOverview: async () => overview } }, 'graph', {
      action: 'overview',
    });
    expect(result.ok).toBe(true);
    expect(result.structuredContent).toEqual(overview);
    expect(result.structuredContent).not.toHaveProperty('totalDefinitions');
  });

  it('reports an asynchronous graph failure through the adapter', async () => {
    const pending = Promise.reject(new Error('fixture graph read failed'));
    // RED旧实现会丢掉Promise；测试仍观察其拒绝，避免伪造独立的进程故障。
    void pending.catch(() => undefined);
    const result = await execute({ projectGraph: { getOverview: () => pending } }, 'graph', {
      action: 'overview',
    });
    expect(result).toMatchObject({ ok: false, status: 'error' });
    expect(result.text).toContain('fixture graph read failed');
  });

  it.each([
    'class',
    'callers',
    'callees',
    'search',
  ] as const)('awaits the primary %s query before using its fallback', async (type) => {
    const primaryName = {
      class: 'getClassInfo',
      callers: 'getCallers',
      callees: 'getCallees',
      search: 'searchEntities',
    }[type];
    const secondaryName = {
      class: 'queryEntity',
      callers: 'queryCallGraph',
      callees: 'queryCallGraph',
      search: 'search',
    }[type];
    const fallback = vi.fn(async () => ({ name: 'Fixture', found: true }));
    const result = await execute(
      {
        // search 的历史优先级与 class/call graph 相反：先查实体图，再查项目图。
        projectGraph:
          type === 'search' ? { searchEntities: fallback } : { [primaryName]: async () => null },
        codeEntityGraph:
          type === 'search' ? { search: async () => null } : { [secondaryName]: fallback },
      },
      'graph',
      { action: 'query', params: { type, entity: 'Fixture' } }
    );
    expect(fallback).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      structuredContent: { result: { found: true } },
      diagnostics: { fallbackUsed: true },
    });
  });

  it('distinguishes an unavailable graph method from a valid empty query', async () => {
    const request = { action: 'query', params: { type: 'protocol', entity: 'Fixture' } };
    expect((await execute({ projectGraph: {} }, 'graph', request)).ok).toBe(false);
    expect(
      (await execute({ projectGraph: { getProtocolInfo: () => null } }, 'graph', request)).ok
    ).toBe(true);
  });

  it('finishes a canceled uncooperative read without starting a later fallback', async () => {
    const controller = new AbortController();
    let start!: () => void;
    const entered = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish!: (value: null) => void;
    const pending = new Promise<null>((resolve) => {
      finish = resolve;
    });
    const fallback = vi.fn(() => ({ found: true }));
    const result = execute(
      {
        projectGraph: {
          getClassInfo: () => {
            start();
            return pending;
          },
        },
        codeEntityGraph: { queryEntity: fallback },
      },
      'graph',
      { action: 'query', params: { type: 'class', entity: 'Fixture' } },
      controller.signal
    );
    await entered;
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        result,
        new Promise<'pending'>((resolve) => {
          timer = setTimeout(() => resolve('pending'), 100);
        }),
      ]);
      expect(settled).toMatchObject({ ok: false, status: 'aborted' });
    } finally {
      clearTimeout(timer);
      finish(null);
      await result;
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it('reports whether a plan was actually persisted to its optional session store', async () => {
    const args = {
      action: 'plan',
      params: { steps: [{ id: 1, action: 'Inspect' }], strategy: 'sequential' },
    };
    const absent = await execute({}, 'meta', args);
    expect(absent).toMatchObject({
      ok: true,
      structuredContent: { recorded: false },
      diagnostics: { degraded: true },
    });
    const save = vi.fn();
    const stored = await execute({ sessionStore: { save, recall: () => [] } }, 'meta', args);
    expect(save).toHaveBeenCalledOnce();
    expect(stored.structuredContent).toMatchObject({ recorded: true, steps: 1 });
  });

  it.each([
    { tool: 'memory', args: { action: 'save', params: { key: 'fixture', content: 'value' } } },
    {
      tool: 'meta',
      args: {
        action: 'plan',
        params: { steps: [{ id: 1, action: 'Inspect' }], strategy: 'sequential' },
      },
    },
  ])('waits for $tool session persistence instead of returning early success', async ({
    tool,
    args,
  }) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let written = false;
    const result = execute(
      {
        sessionStore: {
          save: async () => {
            enter();
            await pending;
            written = true;
          },
          recall: () => [],
        },
      },
      tool,
      args
    );
    await entered;
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    expect((await result).ok).toBe(true);
    expect(written).toBe(true);
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

function knowledgeResultBoundary(
  injected: Partial<ToolContext>,
  action = 'detail',
  params: Record<string, unknown> = { id: 'receipt-fixture' }
) {
  return knowledgeAdapter(injected)(action, params);
}

describe('tool result ordinary output', () => {
  it('sanitizes the JSON text projection as well as structuredContent', () => {
    const envelope = createEnvelopeForStatus('success');
    envelope.structuredContent = { apiKey: 'synthetic-sensitive-value', publicValue: 'kept' };
    envelope.text = JSON.stringify(envelope.structuredContent, null, 2);
    const output = projectToolResultOrdinaryOutput(envelope);
    expect(output.structuredContent).toEqual({ publicValue: 'kept' });
    expect(JSON.parse(output.text)).toEqual({ publicValue: 'kept' });
    expect(JSON.stringify(output)).not.toContain('synthetic-sensitive-value');
  });

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

  it.each([
    {
      label: 'null prototype DTO',
      create: () =>
        Object.assign(Object.create(null), {
          id: 'receipt-fixture',
          apiKey: 'synthetic-display-secret',
        }),
    },
    {
      label: 'class DTO',
      create: () =>
        new (class {
          id = 'receipt-fixture';
          apiKey = 'synthetic-display-secret';
        })(),
    },
    {
      label: 'own toJSON',
      create: () => ({
        id: 'receipt-fixture',
        toJSON: () => ({ id: 'receipt-fixture', apiKey: 'synthetic-display-secret' }),
      }),
    },
  ])('sanitizes the real knowledge receipt for $label', async ({ create }) => {
    const dto = create();
    const envelope = await knowledgeResultBoundary({ knowledgeRead: { getById: async () => dto } });
    expect(envelope.ok).toBe(true);
    const projected = projectToolResultOrdinaryOutput(envelope);
    expect(projected.structuredContent).toMatchObject({ id: 'receipt-fixture' });
    expect(JSON.stringify(projected)).not.toContain('synthetic-display-secret');
    expect(presentToolResult(envelope)).not.toContain('synthetic-display-secret');
    expect(projected.structuredContent).not.toBe(dto);
  });

  it('keeps an own __proto__ JSON key as data without changing the projection prototype', async () => {
    const dto = JSON.parse(
      '{"id":"receipt-fixture","__proto__":{"visible":"nested-value"},"publicValue":"kept"}'
    );
    const envelope = await knowledgeResultBoundary({ knowledgeRead: { getById: async () => dto } });
    const projected = projectToolResultOrdinaryOutput(envelope);
    expect(Object.getPrototypeOf(projected.structuredContent)).toBe(Object.prototype);
    expect(Object.hasOwn(projected.structuredContent as object, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(projected.structuredContent))).toEqual(dto);
  });

  it('owns the projected cache and failure taxonomy without changing the original receipt', async () => {
    const envelope = await knowledgeResultBoundary({
      knowledgeRead: { getById: async () => ({ id: 'receipt-fixture' }) },
    });
    const taxonomy = {
      agentBranch: 'host-failure',
      kind: 'host-failure',
      privateDataSafe: true as const,
      problemClass: 'host-problem',
      refPolicy: 'opaque',
      retryPolicy: 'never',
      retryable: false,
      stableId: 'core.failure.host-fixture' as const,
      status: 'error',
    };
    const projected = projectToolResultOrdinaryOutput(envelope, { failureTaxonomy: taxonomy });
    if (!projected.cache || !projected.failureTaxonomy) {
      throw new Error('Expected projected metadata');
    }
    projected.cache.hit = true;
    projected.failureTaxonomy.retryable = true;
    expect(envelope.cache?.hit).toBe(false);
    expect(taxonomy.retryable).toBe(false);
  });

  it.each([
    {
      label: 'cyclic detail',
      detail: () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
      code: 'TOOL_RESULT_DISPLAY_CYCLE',
    },
    {
      label: 'non-JSON bigint',
      detail: () => 1n,
      code: 'TOOL_RESULT_DISPLAY_UNSUPPORTED',
    },
    {
      label: 'throwing toJSON',
      detail: () => ({
        toJSON() {
          throw new Error('synthetic-display-secret');
        },
      }),
      code: 'TOOL_RESULT_DISPLAY_UNSUPPORTED',
    },
    {
      label: 'throwing accessor',
      detail: () =>
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get() {
            throw new Error('synthetic-display-secret');
          },
        }),
      code: 'TOOL_RESULT_DISPLAY_UNSUPPORTED',
    },
    {
      label: 'over-depth detail',
      detail: () => {
        let value: Record<string, unknown> = { leaf: true };
        for (let depth = 0; depth < 1000; depth++) {
          value = { child: value };
        }
        return value;
      },
      code: 'TOOL_RESULT_DISPLAY_LIMIT',
    },
    {
      label: 'over-wide detail',
      detail: () => Array.from({ length: 11000 }, () => 1),
      code: 'TOOL_RESULT_DISPLAY_LIMIT',
    },
  ])('retains a confirmed publish with a bounded safe display for $label', async ({
    detail,
    code,
  }) => {
    // 身份故意排在耗预算详情之后，投影不能依赖宿主 DTO 的属性插入次序。
    const record = { detail: detail(), id: 'receipt-fixture', lifecycle: 'active' };
    const publish = vi.fn(async () => record);
    const envelope = await knowledgeResultBoundary(
      {
        recipeGateway: {
          evaluateReadiness: async () => ({ ready: true, violations: [] }),
          publish,
        },
      },
      'manage',
      { operation: 'publish', id: 'receipt-fixture' }
    );
    expect(publish).toHaveBeenCalledOnce();
    expect(envelope).toMatchObject({
      ok: true,
      status: 'success',
      structuredContent: {
        id: 'receipt-fixture',
        lifecycle: 'active',
        status: 'published',
        record: { id: 'receipt-fixture', lifecycle: 'active' },
      },
      diagnostics: { degraded: true },
    });
    expect(envelope.diagnostics.warnings.map((warning) => warning.code)).toContain(code);
    expect(() => JSON.stringify(envelope)).not.toThrow();
    const serialized = JSON.stringify(projectToolResultOrdinaryOutput(envelope));
    expect(serialized).not.toContain('synthetic-display-secret');
    expect(serialized.length).toBeLessThan(100_000);
    expect(presentToolResult(envelope)).toContain('receipt-fixture');
  });

  it('preserves native Date serialization without running host getters or custom toJSON', async () => {
    const getter = vi.fn(() => 'synthetic-display-secret');
    const toJSON = vi.fn(() => ({ apiKey: 'synthetic-display-secret' }));
    const validation = {
      checkedAt: new Date('2026-09-21T00:00:00.000Z'),
      invalidDate: new Date(Number.NaN),
      custom: { visible: 'kept', toJSON },
      accessor: Object.defineProperty({}, 'secret', { enumerable: true, get: getter }),
    };
    const envelope = await knowledgeResultBoundary(
      { knowledgeManagement: { validate: async () => validation } },
      'manage',
      { operation: 'validate', id: 'receipt-fixture' }
    );
    expect(envelope.ok).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(projectToolResultOrdinaryOutput(envelope).structuredContent).toMatchObject({
      result: {
        checkedAt: '2026-09-21T00:00:00.000Z',
        invalidDate: null,
        custom: { visible: 'kept' },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain('synthetic-display-secret');
  });

  it.each([
    ['ok', undefined],
    ['toolId', 1],
    ['callId', null],
    ['status', 'invented-status'],
    ['text', {}],
    ['startedAt', undefined],
    ['durationMs', Number.NaN],
    ['diagnostics', undefined],
    ['diagnostics', { warnings: [] }],
    ['trust', {}],
    ['cache', { hit: true, policy: 'invented-policy' }],
    ['artifacts', [{ id: 'artifact', kind: 'file' }]],
    ['resources', [{ uri: 123 }]],
  ])('rejects an incomplete or invalid %s field before presentation', async (field, value) => {
    const envelope = await knowledgeResultBoundary({
      knowledgeRead: { getById: async () => ({ id: 'receipt-fixture' }) },
    });
    const malformed = { ...envelope, [field]: value };
    expect(isToolResultEnvelope(malformed)).toBe(false);
  });

  it.each([
    ['status', 'success'],
    ['cache', 'session'],
    ['artifacts', 'file'],
    ['trust', 'internal'],
  ])('rejects an object posing as the %s enum without running its toString', async (field, label) => {
    const envelope = await knowledgeResultBoundary({
      knowledgeRead: { getById: async () => ({ id: 'receipt-fixture' }) },
    });
    const stringifyEnum = vi.fn(() => label);
    const disguised = { toString: stringifyEnum };
    const value =
      field === 'cache'
        ? { hit: false, policy: disguised }
        : field === 'artifacts'
          ? [{ id: 'fixture', kind: disguised, uri: 'memory://fixture' }]
          : field === 'trust'
            ? { ...envelope.trust, source: disguised }
            : disguised;
    expect(isToolResultEnvelope({ ...envelope, [field]: value })).toBe(false);
    expect(stringifyEnum).not.toHaveBeenCalled();
  });

  it('rejects inherited envelope fields and accessors while preserving all seven status shapes', async () => {
    const envelope = await knowledgeResultBoundary({
      knowledgeRead: { getById: async () => ({ id: 'receipt-fixture' }) },
    });
    expect(isToolResultEnvelope(Object.create(envelope))).toBe(false);
    const getter = vi.fn(() => 'untrusted getter');
    expect(
      isToolResultEnvelope(Object.defineProperty({ ...envelope }, 'text', { get: getter }))
    ).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    for (const status of [
      'success',
      'partial',
      'error',
      'blocked',
      'aborted',
      'timeout',
      'needs-confirmation',
    ]) {
      const value = { ...envelope, status };
      expect(isToolResultEnvelope(value)).toBe(true);
      if (isToolResultEnvelope(value)) {
        expect(presentToolResult(value)).toContain('receipt-fixture');
      }
    }
  });

  it('rejects malformed nested diagnostics instead of promising a presentable envelope', async () => {
    const envelope = await knowledgeResultBoundary({
      knowledgeRead: { getById: async () => ({ id: 'receipt-fixture' }) },
    });
    for (const diagnostics of [
      { ...envelope.diagnostics, warnings: [null] },
      { ...envelope.diagnostics, timedOutStages: [1] },
      { ...envelope.diagnostics, blockedTools: [{}] },
      { ...envelope.diagnostics, gateFailures: [{ stage: 'execute' }] },
      { ...envelope.diagnostics, aiErrorCount: Number.POSITIVE_INFINITY },
    ]) {
      expect(isToolResultEnvelope({ ...envelope, diagnostics })).toBe(false);
    }
  });
});
