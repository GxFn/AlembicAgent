import { describe, expect, it, vi } from 'vitest';
import type { ToolAvailabilitySnapshot } from '../src/tools/kernel/availability.js';
import type { ToolCallRequest } from '../src/tools/kernel/request.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
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
