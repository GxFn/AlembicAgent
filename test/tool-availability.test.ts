import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ToolAvailabilityContext,
  ToolAvailabilitySnapshot,
  ToolUnavailableReason,
} from '../src/tools/kernel/availability.js';
import type { ToolContext } from '../src/tools/kernel/registry.js';
import type { ToolCallRequest } from '../src/tools/kernel/request.js';
import type { ToolActionAllowlist } from '../src/tools/kernel/toolSchema.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { TOOL_REGISTRY } from '../src/tools/runtime/registry.js';
import { ToolRouter } from '../src/tools/runtime/router.js';

function request(
  tool: string,
  action: string,
  params: Record<string, unknown> = {}
): ToolCallRequest {
  return {
    toolId: tool,
    args: { action, params },
    surface: 'runtime',
    actor: { user: 'fixture' },
    source: { kind: 'runtime' },
  };
}

describe('schema, introspection, and static execution admission', () => {
  it('keeps safe-integer admission for the review queue limit before host allocation', async () => {
    const listReviewQueue = vi.fn(async () => []);
    const create = vi.fn(() => ({
      projectRoot: process.cwd(),
      tokenBudget: 4000,
      stagingManager: { listReviewQueue },
    }));
    const adapter = new ToolRouterAdapter({ contextFactory: { create } });
    const invalid = request('knowledge', 'manage', {
      operation: 'review-queue',
      limit: Number.MAX_SAFE_INTEGER + 1,
    });
    expect((await adapter.explain(invalid)).allowed).toBe(false);
    expect(await adapter.execute(invalid)).toMatchObject({
      ok: false,
      structuredContent: { code: 'TOOL_CALL_INVALID', writeState: 'not-started' },
    });
    expect(
      (
        await adapter.explain(
          request('knowledge', 'manage', {
            operation: 'review-queue',
            limit: Number.MAX_SAFE_INTEGER,
          })
        )
      ).allowed
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(listReviewQueue).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])('reports aborted when availability cancels an explanation (throws=%s)', async (throws) => {
    const controller = new AbortController();
    const create = vi.fn(() => ({ projectRoot: process.cwd(), tokenBudget: 4000 }));
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create,
        getAvailability: () => {
          controller.abort('fixture cancellation');
          if (throws) {
            throw new Error('fixture availability failed after cancellation');
          }
          return { actions: { memory: ['save'] } };
        },
      },
    });
    const decision = await adapter.explain({
      ...request('memory', 'save', { key: 'fixture', content: 'fixture' }),
      abortSignal: controller.signal,
    });
    expect(decision).toMatchObject({
      allowed: false,
      stage: 'execute',
      resultStatus: 'aborted',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    'inherited-tool',
    'inherited-action',
    'hidden-tool',
    'hidden-action',
    'hidden-action-mask',
  ])('preserves a denying %s availability declaration', async (kind) => {
    const parameter = { key: ['allowed-key'] };
    const actions =
      kind === 'hidden-action-mask' ? Object.defineProperty({}, 'memory', { value: [] }) : {};
    const parameters =
      kind === 'inherited-tool'
        ? Object.create({ memory: { save: parameter } })
        : kind === 'inherited-action'
          ? { memory: Object.create({ save: parameter }) }
          : kind === 'hidden-tool'
            ? Object.defineProperty({}, 'memory', { value: { save: parameter } })
            : kind === 'hidden-action'
              ? { memory: Object.defineProperty({}, 'save', { value: parameter }) }
              : undefined;
    const save = vi.fn();
    const create = vi.fn(() => ({
      projectRoot: process.cwd(),
      tokenBudget: 4000,
      sessionStore: { save },
    }));
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create,
        getAvailability: () => ({ actions, ...(parameters === undefined ? {} : { parameters }) }),
      },
    });
    const result = await adapter.execute(
      request('memory', 'save', { key: 'fixture', content: 'fixture' })
    );
    expect(result).toMatchObject({ ok: false, status: 'blocked' });
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    'capability',
    'runtime',
    'availability-actions',
    'availability-parameter',
  ] as const)('honors the first denied %s declaration before host allocation', async (source) => {
    const save = vi.fn();
    const create = vi.fn(() => ({
      projectRoot: process.cwd(),
      tokenBudget: 4000,
      sessionStore: { save },
    }));
    const changing = (key: string, later: unknown) => {
      let reads = 0;
      return {
        get [key]() {
          return ++reads === 1 ? [] : later;
        },
      };
    };
    const allowedTools = changing('memory', null) as ToolActionAllowlist;
    const adapter = new ToolRouterAdapter({
      ...(source === 'capability'
        ? { capability: { name: 'fixture', description: 'fixture', allowedTools } }
        : {}),
      contextFactory: {
        create,
        ...(source.startsWith('availability')
          ? {
              getAvailability: () =>
                source === 'availability-actions'
                  ? { actions: changing('memory', null) as ToolActionAllowlist }
                  : {
                      actions: { memory: ['save'] },
                      parameters: {
                        memory: { save: changing('key', ['fixture']) as Record<string, string[]> },
                      },
                    },
            }
          : {}),
      },
    });
    const result = await adapter.execute({
      ...request('memory', 'save', { key: 'fixture', content: 'fixture' }),
      ...(source === 'runtime' ? { runtime: { allowedTools } } : {}),
    });
    expect(result).toMatchObject({ ok: false, status: 'blocked' });
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(
    ['capability', 'runtime', 'availability'].flatMap((source) =>
      [
        { kind: 'string', value: { memory: 'save' } },
        { kind: 'mixed array', value: { memory: ['save', null] } },
        {
          kind: 'sparse array',
          value: { memory: Object.assign(new Array<string>(2), { 0: 'save' }) },
        },
        { kind: 'null contract', value: null },
      ].map((entry) => ({ source, ...entry }))
    )
  )('rejects malformed $source $kind before host allocation or writes', async ({
    source,
    value,
  }) => {
    // 模拟跨宿主边界的不可信声明；显式完整授权合同不能使用 selection 的顶层 null 语义。
    const allowedTools = value as unknown as ToolActionAllowlist;
    const save = vi.fn();
    const create = vi.fn(() => ({
      projectRoot: process.cwd(),
      tokenBudget: 4000,
      sessionStore: { save },
    }));
    const adapter = new ToolRouterAdapter({
      ...(source === 'capability'
        ? { capability: { name: 'fixture', description: 'fixture', allowedTools } }
        : {}),
      contextFactory: {
        create,
        ...(source === 'availability'
          ? { getAvailability: () => ({ actions: allowedTools }) }
          : {}),
      },
    });
    const call = {
      ...request('memory', 'save', { key: 'fixture', content: 'fixture' }),
      ...(source === 'runtime' ? { runtime: { allowedTools } } : {}),
    };
    const result = await adapter.execute(call);
    expect(result).toMatchObject({ ok: false, status: 'blocked' });
    expect((await adapter.explain(call)).allowed).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'string', values: 'update' },
    { kind: 'mixed array', values: ['update', null] },
    { kind: 'sparse array', values: Object.assign(new Array<string>(2), { 0: 'update' }) },
    { kind: 'null enum', values: null },
  ])('rejects a malformed host parameter $kind in both query and execution', async ({ values }) => {
    // 宿主参数约束只允许字符串枚举，不能借用动作 allowlist 的 null 通配语义。
    const availability = {
      actions: { knowledge: ['manage'] },
      parameters: { knowledge: { manage: { operation: values } } },
    } as unknown as ToolAvailabilitySnapshot;
    const update = vi.fn(async () => undefined);
    const create = vi.fn(() => ({
      projectRoot: process.cwd(),
      tokenBudget: 4000,
      knowledgeManagement: { update },
    }));
    const getAvailability = () => availability;
    const adapter = new ToolRouterAdapter({ contextFactory: { create, getAvailability } });
    const result = await adapter.execute(
      request('knowledge', 'manage', {
        operation: 'update',
        id: 'fixture',
        data: { title: 'fixture' },
      })
    );
    expect(result).toMatchObject({ ok: false, status: 'blocked' });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const catalog = new RuntimeCapabilityCatalog({ availability: getAvailability });
    expect(() => catalog.querySchemas({ selection: { knowledge: ['manage'] } })).toThrow(
      'Invalid tool availability'
    );
  });

  it.each([
    { phase: 'preflight availability', abortAtRead: 1, abortAtCreate: false, allocations: 0 },
    { phase: 'context allocation', abortAtRead: 0, abortAtCreate: true, allocations: 1 },
    { phase: 'slot availability', abortAtRead: 2, abortAtCreate: false, allocations: 1 },
  ])('does not proceed after cancellation inside $phase', async ({
    abortAtRead,
    abortAtCreate,
    allocations,
  }) => {
    const controller = new AbortController();
    const save = vi.fn();
    let reads = 0;
    const create = vi.fn(() => {
      if (abortAtCreate) {
        controller.abort('fixture cancellation');
      }
      return { projectRoot: process.cwd(), tokenBudget: 4000, sessionStore: { save } };
    });
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create,
        getAvailability: () => {
          if (++reads === abortAtRead) {
            controller.abort('fixture cancellation');
          }
          return { actions: { memory: ['save'] } };
        },
      },
    });
    const result = await adapter.execute({
      ...request('memory', 'save', { key: 'fixture', content: 'fixture' }),
      abortSignal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, status: 'aborted' });
    expect(create).toHaveBeenCalledTimes(allocations);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    'capability',
    'runtime',
    'availability',
  ])('preserves wildcard, empty, and own-key semantics for valid %s contracts', async (source) => {
    const cases: Array<{ allowedTools: ToolActionAllowlist; permitted: boolean }> = [
      { allowedTools: { memory: null }, permitted: true },
      { allowedTools: { memory: undefined }, permitted: true },
      { allowedTools: { memory: [] }, permitted: false },
      { allowedTools: {}, permitted: source === 'availability' },
      {
        allowedTools: Object.create({ memory: ['save'] }) as ToolActionAllowlist,
        permitted: source === 'availability',
      },
    ];
    for (const { allowedTools, permitted } of cases) {
      const save = vi.fn();
      const adapter = new ToolRouterAdapter({
        ...(source === 'capability'
          ? { capability: { name: 'fixture', description: 'fixture', allowedTools } }
          : {}),
        contextFactory: {
          create: () => ({ projectRoot: process.cwd(), tokenBudget: 4000, sessionStore: { save } }),
          ...(source === 'availability'
            ? { getAvailability: () => ({ actions: allowedTools }) }
            : {}),
        },
      });
      const result = await adapter.execute({
        ...request('memory', 'save', { key: 'fixture', content: 'fixture' }),
        ...(source === 'runtime' ? { runtime: { allowedTools } } : {}),
      });
      expect(result.ok).toBe(permitted);
      expect(save).toHaveBeenCalledTimes(permitted ? 1 : 0);
    }
  });

  it.each([
    'capability',
    'runtime',
  ])('rechecks changed %s action permissions when a queued writer gains its slot', async (source) => {
    let finishUpdate!: () => void;
    let updateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    const updateGate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    const reject = vi.fn(async () => undefined);
    const allowedTools = { knowledge: ['manage'] };
    const runtime = source === 'runtime' ? { allowedTools } : undefined;
    const adapter = new ToolRouterAdapter({
      ...(source === 'capability'
        ? { capability: { name: 'fixture', description: 'fixture', allowedTools } }
        : {}),
      contextFactory: {
        create: () => ({
          projectRoot: process.cwd(),
          tokenBudget: 4000,
          knowledgeManagement: {
            update: async () => {
              updateStarted();
              await updateGate;
            },
            reject,
          },
        }),
      },
    });
    const first = adapter.execute({
      ...request('knowledge', 'manage', {
        operation: 'update',
        id: 'fixture',
        data: { title: 'next' },
      }),
      runtime,
    });
    await started;
    const second = adapter.execute({
      ...request('knowledge', 'manage', { operation: 'reject', id: 'fixture' }),
      runtime,
    });
    allowedTools.knowledge = [];
    finishUpdate();
    expect((await first).ok).toBe(true);
    expect(await second).toMatchObject({ ok: false, status: 'blocked' });
    expect(reject).not.toHaveBeenCalled();
  });

  it.each([
    { tool: 'terminal', action: 'exec', params: { command: 'fixture' } },
    { tool: 'code', action: 'write', params: { path: 'fixture.ts', content: 'fixture' } },
  ])('rejects a disallowed tool or action $tool.$action before host allocation', async ({
    tool,
    action,
    params,
  }) => {
    const create = vi.fn(() => ({ projectRoot: process.cwd(), tokenBudget: 4000 }));
    const adapter = new ToolRouterAdapter({
      capability: { name: 'read-only', description: 'fixture', allowedTools: { code: ['read'] } },
      contextFactory: { create },
    });
    const result = await adapter.execute(request(tool, action, params));
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining('Permission denied') });
    expect(create).not.toHaveBeenCalled();
  });

  it('checks an omitted filter against its real default before executing', async () => {
    const search = vi.fn(async () => []);
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: process.cwd(), tokenBudget: 4000, searchEngine: { search } }),
        getAvailability: () => ({
          actions: {},
          parameters: { knowledge: { search: { kind: ['recipe'] } } },
        }),
      },
    });
    const call = request('knowledge', 'search', { query: 'fixture' });
    expect((await adapter.explain(call)).allowed).toBe(false);
    expect((await adapter.execute(call)).ok).toBe(false);
    expect(search).not.toHaveBeenCalled();
    expect(
      (await adapter.execute(request('knowledge', 'search', { query: 'fixture', kind: 'recipe' })))
        .ok
    ).toBe(true);
  });

  it('refreshes host availability after a queued call gains its execution slot', async () => {
    let finishUpdate!: () => void;
    let updateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    const updateGate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    const reject = vi.fn(async () => undefined);
    let rejectAvailable = true;
    let secondPreflight!: () => void;
    const queued = new Promise<void>((resolve) => {
      secondPreflight = resolve;
    });
    let inspections = 0;
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          projectRoot: process.cwd(),
          tokenBudget: 4000,
          knowledgeManagement: {
            update: async () => {
              updateStarted();
              await updateGate;
            },
            reject,
          },
        }),
        getAvailability: () => {
          inspections++;
          // 第一个调用会在获得slot后再检查；第二个调用的预检是第三次查询。
          if (inspections >= 2) {
            secondPreflight();
          }
          return {
            actions: {},
            parameters: {
              knowledge: {
                manage: { operation: rejectAvailable ? ['update', 'reject'] : ['update'] },
              },
            },
          };
        },
      },
    });
    const first = adapter.execute(
      request('knowledge', 'manage', {
        operation: 'update',
        id: 'fixture',
        data: { title: 'next' },
      })
    );
    await started;
    const second = adapter.execute(
      request('knowledge', 'manage', { operation: 'reject', id: 'fixture' })
    );
    await queued;
    rejectAvailable = false;
    finishUpdate();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(false);
    expect(reject).not.toHaveBeenCalled();
  });
  it('explains the same capability rejection as execute without allocating a context', async () => {
    const getOverview = vi.fn();
    const create = vi.fn(() => ({
      projectRoot: process.cwd(),
      tokenBudget: 4000,
      projectGraph: { getOverview },
    }));
    const adapter = new ToolRouterAdapter({
      capability: { name: 'read', description: 'read only', allowedTools: { code: ['read'] } },
      contextFactory: { create },
    });
    const call = request('graph', 'overview');
    const decision = await adapter.explain(call);
    expect(decision.allowed).toBe(false);
    const result = await adapter.execute(call);
    expect(result.ok).toBe(false);
    expect(result.text).toBe(decision.reason);
    expect(create).not.toHaveBeenCalled();
    expect(getOverview).not.toHaveBeenCalled();
  });

  it('rechecks host availability after schemas were read and before any tool effect', async () => {
    let available = true;
    const getAvailability = vi.fn(
      (): ToolAvailabilitySnapshot => ({
        actions: { graph: available ? ['overview'] : [] },
        unavailable: available
          ? []
          : [{ tool: 'graph', action: 'overview', reason: 'projectGraph.getOverview missing' }],
      })
    );
    const create = vi.fn(() => ({
      projectRoot: process.cwd(),
      tokenBudget: 4000,
      projectGraph: { getOverview: vi.fn() },
    }));
    const adapter = new ToolRouterAdapter({ contextFactory: { create, getAvailability } });
    const catalog = new RuntimeCapabilityCatalog({ availability: getAvailability });
    expect(catalog.toToolSchemas(['graph'])).toHaveLength(1);
    available = false;
    const call = request('graph', 'overview');
    expect((await adapter.explain(call)).allowed).toBe(false);
    expect((await adapter.execute(call)).ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(catalog.toToolSchemas(['graph'])).toEqual([]);
  });

  it('limits meta.tools by both stage actions and host operation availability', async () => {
    const adapter = new ToolRouterAdapter({
      capability: {
        name: 'inspect',
        description: 'fixture',
        allowedTools: { code: ['read', 'write'], knowledge: ['manage'], meta: ['tools'] },
      },
      contextFactory: {
        create: () => ({ projectRoot: process.cwd(), tokenBudget: 4000 }),
        getAvailability: () => ({
          actions: {},
          parameters: { knowledge: { manage: { operation: ['update'] } } },
        }),
      },
    });
    const runtime = { allowedTools: { code: ['read'], knowledge: ['manage'], meta: ['tools'] } };
    const code = await adapter.execute({ ...request('meta', 'tools', { name: 'code' }), runtime });
    expect(code.ok).toBe(true);
    expect(code.text).toContain('read [read-only]');
    expect(code.text).not.toContain('write [');
    const knowledge = await adapter.execute({
      ...request('meta', 'tools', { name: 'knowledge' }),
      runtime,
    });
    expect(knowledge.text).toContain('operation*: string (update)');
    expect(knowledge.text).not.toContain('update|');
    expect(
      (
        await adapter.execute({
          ...request('code', 'write', { path: 'blocked', content: 'never' }),
          runtime,
        })
      ).ok
    ).toBe(false);
  });

  it('rejects an unavailable management branch but preserves allowed operations and omitted optional filters', async () => {
    const update = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    const search = vi.fn(async () => []);
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          projectRoot: process.cwd(),
          tokenBudget: 4000,
          knowledgeManagement: { update, reject },
          searchEngine: { search },
        }),
        getAvailability: () => ({
          actions: {},
          parameters: {
            knowledge: { manage: { operation: ['update'] }, search: { kind: ['all'] } },
          },
        }),
      },
    });
    const denied = request('knowledge', 'manage', { operation: 'reject', id: 'fixture' });
    expect((await adapter.explain(denied)).allowed).toBe(false);
    expect((await adapter.execute(denied)).ok).toBe(false);
    expect(reject).not.toHaveBeenCalled();
    expect(
      (
        await adapter.execute(
          request('knowledge', 'manage', {
            operation: 'update',
            id: 'fixture',
            data: { title: 'next' },
          })
        )
      ).ok
    ).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect((await adapter.execute(request('knowledge', 'search', { query: 'test' }))).ok).toBe(
      true
    );
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('host service availability description', () => {
  it('describes method facts without executing services and keeps partial knowledge/graph capabilities', () => {
    const service = vi.fn(() => {
      throw new Error('Availability cannot execute a service');
    });
    const snapshot = ToolRouter.describeAvailability({
      searchEngine: { search: service, supportedKinds: ['all'] },
      knowledgeManagement: { update: service },
      stagingManager: { listReviewQueue: service },
      projectGraph: { getClassInfo: service },
      sessionStoreAvailable: true,
    });
    expect(service).not.toHaveBeenCalled();
    expect(snapshot.actions.knowledge).toEqual(
      expect.arrayContaining(['search', 'prime', 'manage'])
    );
    expect(snapshot.actions.knowledge).not.toContain('detail');
    expect(snapshot.actions.knowledge).not.toContain('submit');
    expect(snapshot.parameters?.knowledge?.manage?.operation).toEqual(
      expect.arrayContaining(['update', 'review-queue'])
    );
    expect(snapshot.parameters?.knowledge?.manage?.operation).not.toContain('reject');
    expect(snapshot.parameters?.knowledge?.search?.kind).toEqual(['all']);
    expect(snapshot.actions.graph).toEqual(['query']);
    expect(snapshot.parameters?.graph?.query?.type).toEqual(['class']);
    expect(snapshot.actions.code).not.toContain('outline');
    expect(snapshot.actions.code).toContain('read');
  });

  it('does not fall back from an explicitly incomplete knowledge port to a raw repository', () => {
    const method = vi.fn();
    const snapshot = ToolRouter.describeAvailability({
      knowledgeRead: {} as never,
      knowledgeManagement: {},
      knowledgeRepo: { getById: method, update: method },
      searchEngine: { search: method },
      sessionStoreAvailable: true,
    });
    expect(snapshot.actions.knowledge).toEqual(['search']);
    expect(method).not.toHaveBeenCalled();
  });

  it('distinguishes a known run without ledger/coordinator from a catalog-only query', () => {
    const staticView = ToolRouter.describeAvailability({ sessionStoreAvailable: true });
    const runView = ToolRouter.describeAvailability({ sessionStoreAvailable: true, runtime: {} });
    expect(staticView.actions.evidence).toBeUndefined();
    expect(runView.actions.evidence).toEqual([]);
    expect(runView.actions.memory).not.toContain('note_finding');
    expect(runView.actions.memory).toEqual(
      expect.arrayContaining(['save', 'recall', 'get_previous_evidence'])
    );
  });
});

/** 某个 tool/action 在快照里的全部不可用条目（含 operation 级分支条目）。 */
function reasonsFor(
  snapshot: ToolAvailabilitySnapshot,
  tool: string,
  action: string
): ToolUnavailableReason[] {
  return (snapshot.unavailable ?? []).filter(
    (entry) => entry.tool === tool && entry.action === action
  );
}

/** 生产宿主的 SandboxExecutorBridge 是类实例，exec 在原型上；快照必须按方法事实识别它。 */
class PrototypeSandboxExecutor {
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

describe('availability snapshot matches handler rejection conditions', () => {
  it.each([
    { kind: 'no executor', context: {} },
    { kind: 'executor without exec', context: { sandboxExecutor: {} } },
    { kind: 'non-function exec', context: { sandboxExecutor: { exec: 'not-callable' } } },
    {
      kind: 'truthy non-boolean permit',
      context: { allowUnsandboxedTerminal: 'yes' as unknown as boolean },
    },
  ])('hides terminal.exec when the handler would block it ($kind)', ({ context }) => {
    const snapshot = ToolRouter.describeAvailability({ sessionStoreAvailable: true, ...context });
    expect(snapshot.actions.terminal).toEqual([]);
    expect(reasonsFor(snapshot, 'terminal', 'exec')).toEqual([
      {
        tool: 'terminal',
        action: 'exec',
        reason: 'sandboxExecutor.exec is unavailable and allowUnsandboxedTerminal is not true',
      },
    ]);
  });

  it.each([
    { kind: 'plain executor', context: { sandboxExecutor: { exec: vi.fn() } } },
    { kind: 'class executor', context: { sandboxExecutor: new PrototypeSandboxExecutor() } },
    { kind: 'explicit permit', context: { allowUnsandboxedTerminal: true } },
    {
      kind: 'explicit permit with malformed executor',
      context: { sandboxExecutor: {}, allowUnsandboxedTerminal: true },
    },
  ])('keeps terminal.exec when the handler would run it ($kind)', ({ context }) => {
    const snapshot = ToolRouter.describeAvailability({ sessionStoreAvailable: true, ...context });
    expect(snapshot.actions.terminal).toEqual(['exec']);
    expect(reasonsFor(snapshot, 'terminal', 'exec')).toEqual([]);
  });

  it.each([
    { kind: 'no session store', context: {} },
    { kind: 'declared unavailable', context: { sessionStoreAvailable: false } },
    {
      kind: 'store without recall',
      context: { sessionStore: { save: vi.fn() } as unknown as ToolContext['sessionStore'] },
    },
  ])('hides meta.review when submissions cannot be recalled ($kind)', ({ context }) => {
    const snapshot = ToolRouter.describeAvailability(context);
    expect(snapshot.actions.meta).toEqual(['tools', 'plan']);
    expect(reasonsFor(snapshot, 'meta', 'review')).toEqual([
      { tool: 'meta', action: 'review', reason: 'sessionStore.recall is unavailable' },
    ]);
  });

  it.each([
    { kind: 'declared available', context: { sessionStoreAvailable: true } },
    {
      kind: 'bound store',
      context: { sessionStore: { save: vi.fn(), recall: vi.fn(() => []) } },
    },
  ])('keeps meta.review when submissions can be recalled ($kind)', ({ context }) => {
    const snapshot = ToolRouter.describeAvailability(context);
    expect(snapshot.actions.meta).toEqual(['tools', 'plan', 'review']);
    expect(reasonsFor(snapshot, 'meta', 'review')).toEqual([]);
  });

  it('reports every knowledge.search kind the production search engine drops', () => {
    const search = vi.fn();
    const snapshot = ToolRouter.describeAvailability({
      searchEngine: { search, supportedKinds: ['all'] },
      sessionStoreAvailable: true,
    });
    expect(search).not.toHaveBeenCalled();
    expect(snapshot.actions.knowledge).toContain('search');
    expect(snapshot.actions.knowledge).toContain('prime');
    expect(snapshot.parameters?.knowledge?.search?.kind).toEqual(['all']);
    expect(reasonsFor(snapshot, 'knowledge', 'search')).toEqual([
      {
        tool: 'knowledge',
        action: 'search',
        operation: 'recipe',
        reason: 'knowledge.search kind=recipe is not in searchEngine.supportedKinds',
      },
      {
        tool: 'knowledge',
        action: 'search',
        operation: 'candidate',
        reason: 'knowledge.search kind=candidate is not in searchEngine.supportedKinds',
      },
    ]);
  });

  it('does not report kinds when the search engine declares no supportedKinds', () => {
    const snapshot = ToolRouter.describeAvailability({
      searchEngine: { search: vi.fn() },
      sessionStoreAvailable: true,
    });
    expect(snapshot.actions.knowledge).toContain('search');
    expect(snapshot.parameters?.knowledge?.search).toBeUndefined();
    expect(reasonsFor(snapshot, 'knowledge', 'search')).toEqual([]);
  });

  it('separates a disjoint supportedKinds declaration from a missing search method', () => {
    const disjoint = ToolRouter.describeAvailability({
      searchEngine: { search: vi.fn(), supportedKinds: ['vector'] },
      sessionStoreAvailable: true,
    });
    expect(disjoint.actions.knowledge).not.toContain('search');
    const disjointReasons = reasonsFor(disjoint, 'knowledge', 'search');
    const actionLevel = disjointReasons.filter((entry) => entry.operation === undefined);
    expect(actionLevel).toHaveLength(1);
    expect(actionLevel[0]?.reason).not.toBe('searchEngine.search is unavailable');
    expect(actionLevel[0]?.reason).toBe(
      'searchEngine.supportedKinds does not intersect knowledge.search kind (recipe, candidate, all)'
    );
    expect(
      disjointReasons.filter((entry) => entry.operation !== undefined).map((e) => e.operation)
    ).toEqual(['recipe', 'candidate', 'all']);

    const noMethod = ToolRouter.describeAvailability({
      searchEngine: { supportedKinds: ['all'] },
      sessionStoreAvailable: true,
    });
    expect(noMethod.actions.knowledge).not.toContain('search');
    expect(reasonsFor(noMethod, 'knowledge', 'search')).toEqual([
      { tool: 'knowledge', action: 'search', reason: 'searchEngine.search is unavailable' },
    ]);
  });
});

/** 全部宿主方法都已接线的上下文；新增 check 时这里必须同步补上对应方法，否则守护用例变红。 */
function fullyWiredContext(): ToolAvailabilityContext {
  const method = vi.fn();
  return {
    astAnalyzer: { analyzeFile: method },
    projectGraph: {
      getOverview: method,
      getClassInfo: method,
      getProtocolInfo: method,
      getClassHierarchy: method,
      getCallers: method,
      getCallees: method,
      getMethodOverrides: method,
      getCategoryMap: method,
      searchEntities: method,
    },
    codeEntityGraph: {
      queryEntity: method,
      queryCallGraph: method,
      impactAnalysis: method,
      search: method,
    },
    knowledgeRead: { getById: method } as unknown as ToolContext['knowledgeRead'],
    knowledgeManagement: { update: method, reject: method, score: method, validate: method },
    searchEngine: { search: method },
    recipeGateway: { createOrStage: method, evaluateReadiness: method, publish: method },
    stagingManager: { recordReview: method, listReviewQueue: method },
    proposalGateway: { submit: method },
    sessionStoreAvailable: true,
    sandboxExecutor: { exec: method },
    memoryCoordinator: { noteFinding: method } as unknown as ToolContext['memoryCoordinator'],
    runtime: { evidenceLedger: { get: method, listRecent: method, search: method } },
  } as ToolAvailabilityContext;
}

describe('availability snapshot stays inside the tool registry', () => {
  /** 每个 tool/action/parameter/branch 名都必须来自 TOOL_REGISTRY，硬编码拼错不能静默漏检。 */
  function expectRegistered(snapshot: ToolAvailabilitySnapshot) {
    for (const [tool, actions] of Object.entries(snapshot.actions)) {
      expect(Object.hasOwn(TOOL_REGISTRY, tool), `actions.${tool}`).toBe(true);
      for (const action of actions ?? []) {
        expect(Object.hasOwn(TOOL_REGISTRY[tool].actions, action), `${tool}.${action}`).toBe(true);
      }
    }
    for (const [tool, byAction] of Object.entries(snapshot.parameters ?? {})) {
      for (const [action, byParameter] of Object.entries(byAction)) {
        const properties = TOOL_REGISTRY[tool]?.actions[action]?.params.properties as
          | Record<string, { enum?: unknown }>
          | undefined;
        for (const [parameter, values] of Object.entries(byParameter)) {
          const declared = properties?.[parameter]?.enum;
          expect(Array.isArray(declared), `${tool}.${action}.${parameter}`).toBe(true);
          for (const value of values) {
            expect(declared, `${tool}.${action}.${parameter}=${value}`).toContain(value);
          }
        }
      }
    }
    for (const entry of snapshot.unavailable ?? []) {
      expect(Object.hasOwn(TOOL_REGISTRY, entry.tool), `unavailable ${entry.tool}`).toBe(true);
      const action = entry.action ?? '';
      expect(
        Object.hasOwn(TOOL_REGISTRY[entry.tool].actions, action),
        `unavailable ${entry.tool}.${action}`
      ).toBe(true);
      if (entry.operation !== undefined) {
        const properties = Object.values(
          TOOL_REGISTRY[entry.tool].actions[action].params.properties as Record<
            string,
            { enum?: unknown }
          >
        );
        expect(
          properties.some(
            (property) => Array.isArray(property.enum) && property.enum.includes(entry.operation)
          ),
          `unavailable ${entry.tool}.${action} operation=${entry.operation}`
        ).toBe(true);
      }
      if (entry.operation === undefined) {
        // 动作级不可用条目必须真的把该动作从快照里移除，否则提示与 schema 会再次漂移。
        expect(snapshot.actions[entry.tool] ?? [], `${entry.tool}.${action} removed`).not.toContain(
          action
        );
      }
    }
  }

  it.each([
    { kind: 'catalog-only, nothing wired', context: {} },
    { kind: 'known run, nothing wired', context: { runtime: {} } },
    {
      kind: 'known run, disjoint search kinds',
      context: { runtime: {}, searchEngine: { search: vi.fn(), supportedKinds: ['vector'] } },
    },
    { kind: 'fully wired', context: fullyWiredContext() },
  ])('names only registered tools, actions, parameters and branches ($kind)', ({ context }) => {
    expectRegistered(ToolRouter.describeAvailability(context as ToolAvailabilityContext));
  });

  it('reports nothing unavailable and keeps every registered action when the host is fully wired', () => {
    const snapshot = ToolRouter.describeAvailability(fullyWiredContext());
    expect(snapshot.unavailable).toEqual([]);
    for (const [tool, actions] of Object.entries(snapshot.actions)) {
      expect(actions, tool).toEqual(Object.keys(TOOL_REGISTRY[tool].actions));
    }
    // 每个被 check 过的工具都必须出现在快照里，保证上面的逐项断言真的覆盖了 terminal/meta。
    expect(Object.keys(snapshot.actions)).toEqual(
      expect.arrayContaining([
        'code',
        'graph',
        'knowledge',
        'memory',
        'evidence',
        'meta',
        'terminal',
      ])
    );
  });
});

describe('handlers report the unavailability the snapshot hides', () => {
  function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agent-availability-')));
    return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
  }

  async function execute(
    tool: string,
    action: string,
    params: Record<string, unknown>,
    ctx: ToolContext
  ) {
    const router = new ToolRouter();
    const parsed = router.parseToolCall(tool, { action, params });
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }
    return router.execute(parsed, ctx);
  }

  it('blocks terminal.exec before starting a process when the injected executor has no exec method', async () => {
    await withRoot(async (root) => {
      const marker = path.join(root, 'executed.marker');
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
      )}`;
      const result = await execute(
        'terminal',
        'exec',
        { command },
        { projectRoot: root, tokenBudget: 4000, sandboxExecutor: {} }
      );
      expect(existsSync(marker)).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('no sandbox executor');
      expect(result._meta?.resultStatus).toBe('blocked');
      expect(result._meta?.diagnosticWarnings?.[0]).toMatchObject({
        code: 'terminal_sandbox_required',
        message: expect.stringContaining('sandboxExecutor has no exec method'),
        stage: 'terminal.exec',
        tool: 'terminal',
      });
    });
  });

  it('labels the unsandboxed fallback when the host permits it but the injected executor has no exec method', async () => {
    await withRoot(async (root) => {
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "process.stdout.write('ran')"
      )}`;
      const result = await execute(
        'terminal',
        'exec',
        { command },
        {
          projectRoot: root,
          tokenBudget: 4000,
          sandboxExecutor: {},
          allowUnsandboxedTerminal: true,
        }
      );
      expect(result.ok).toBe(true);
      expect(String(result.data)).toContain('ran');
      expect(String(result.data)).toContain('[unsandboxed:sandbox_executor_missing_exec]');
      expect(result._meta?.fallbackUsed).toBe(true);
      expect(result._meta?.diagnosticWarnings?.[0]).toMatchObject({
        code: 'terminal_sandbox_fallback',
        message: 'sandboxed=false fallbackUsed=true degradeReason=sandbox_executor_missing_exec',
      });
    });
  });

  it('marks meta.review degraded with META_REVIEW_STORE_MISSING when no session store is bound', async () => {
    const result = await execute(
      'meta',
      'review',
      {},
      { projectRoot: process.cwd(), tokenBudget: 4000 }
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ count: 0, message: expect.stringContaining('No session store') });
    expect(result._meta?.degraded).toBe(true);
    expect(result._meta?.diagnosticWarnings).toEqual([
      {
        code: 'META_REVIEW_STORE_MISSING',
        message: expect.stringContaining('No session store'),
        stage: 'meta.review',
        tool: 'meta',
      },
    ]);
  });

  it('marks meta.review degraded when the bound session store cannot recall', async () => {
    const result = await execute(
      'meta',
      'review',
      {},
      {
        projectRoot: process.cwd(),
        tokenBudget: 4000,
        sessionStore: { save: vi.fn() } as unknown as ToolContext['sessionStore'],
      }
    );
    expect(result.ok).toBe(true);
    expect(result._meta?.degraded).toBe(true);
    expect(result._meta?.diagnosticWarnings?.[0]?.code).toBe('META_REVIEW_STORE_MISSING');
  });

  it('reviews recalled submissions without degradation when a session store is bound', async () => {
    const recall = vi.fn(() => [{ key: 'submission-1', content: 'candidate body' }]);
    const result = await execute(
      'meta',
      'review',
      {},
      { projectRoot: process.cwd(), tokenBudget: 4000, sessionStore: { save: vi.fn(), recall } }
    );
    expect(recall).toHaveBeenCalledWith(undefined, { tags: ['submission'], limit: 50 });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ count: 1 });
    expect(result._meta?.degraded).toBeUndefined();
  });
});
