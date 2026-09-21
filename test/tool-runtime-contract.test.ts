import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { readToolObservation } from '../src/agent/utils/toolOutcomes.js';
import type { ToolContext } from '../src/tools/runtime/index.js';
import {
  DeltaCache,
  Evolution,
  RuntimeCapabilityCatalog,
  SearchCache,
  ToolRouter,
  ToolRouterAdapter,
} from '../src/tools/runtime/index.js';
import { TOOL_REGISTRY } from '../src/tools/runtime/registry.js';

let baseRoot: string;
beforeAll(async () => {
  baseRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-tool-contract-')));
});
afterAll(async () => {
  await rm(baseRoot, { recursive: true, force: true });
});

function baseToolContext(): ToolContext {
  return {
    projectRoot: baseRoot,
    tokenBudget: 4000,
  };
}

describe('Tool adapter receipt ownership', () => {
  it.each([
    'success',
    'error',
    'blocked',
    'degraded',
  ])('isolates diagnostics and trust before a later %s call', async (branch) => {
    const adapter = new ToolRouterAdapter({
      capability: {
        name: 'receipt-owner',
        description: 'receipt fixture',
        allowedTools: { knowledge: ['detail', 'prime'] },
      },
      contextFactory: {
        create: () => ({
          ...baseToolContext(),
          searchEngine: {
            search: async () => [
              {
                id: branch === 'degraded' ? 'fail-enrichment' : 'receipt-fixture',
                title: 'Recipe',
                score: 1,
              },
            ],
          },
          knowledgeRead: {
            getById: async (id) => {
              if (id === 'fail-enrichment') {
                throw new Error('synthetic enrichment failure');
              }
              return { id };
            },
          },
        }),
      },
    });
    const request = {
      toolId: 'knowledge',
      args: { action: 'detail', params: { id: 'receipt-fixture' } },
      surface: 'runtime' as const,
      actor: { role: 'agent' },
      source: { kind: 'runtime' as const },
    };
    const first = await adapter.execute(request);
    const later =
      branch === 'error'
        ? { ...request, args: { action: 'unknown', params: {} } }
        : branch === 'blocked'
          ? { ...request, args: { action: 'search', params: { query: 'recipe' } } }
          : branch === 'degraded'
            ? { ...request, args: { action: 'prime', params: { taskGoal: 'Read recipe' } } }
            : request;
    first.diagnostics.warnings.push({ code: 'FIRST_CALL_ONLY', message: 'Fixture annotation' });
    first.diagnostics.timedOutStages.push('first-call');
    first.diagnostics.gateFailures.push({ stage: 'fixture', action: 'first-only' });
    first.trust.containsSecrets = true;
    try {
      const second = await adapter.execute(later);
      expect(second.diagnostics).not.toBe(first.diagnostics);
      expect(second.trust).not.toBe(first.trust);
      expect(second.diagnostics.warnings.map((warning) => warning.code)).not.toContain(
        'FIRST_CALL_ONLY'
      );
      expect(second.diagnostics.timedOutStages).toEqual([]);
      expect(second.diagnostics.gateFailures).toEqual([]);
      expect(second.trust.containsSecrets).toBe(false);
      expect(second.diagnostics.degraded).toBe(branch === 'degraded');
    } finally {
      // RED 阶段旧实现共用模块对象，清理 fixture 修改，避免污染同文件后续验证。
      first.diagnostics.warnings.length = 0;
      first.diagnostics.timedOutStages.length = 0;
      first.diagnostics.gateFailures.length = 0;
      first.trust.containsSecrets = false;
    }
  });

  it('keeps an explicit failed timeout receipt ahead of a concurrently aborted signal', async () => {
    const abortController = new AbortController();
    const router = new ToolRouter();
    const execute = vi.spyOn(router, 'execute').mockImplementation(async () => {
      abortController.abort();
      return {
        ok: false,
        data: { retained: 'partial readback' },
        error: 'Fixture timeout',
        _meta: { cached: false, tokensEstimate: 0, durationMs: 0, resultStatus: 'timeout' },
      };
    });
    try {
      const adapter = new ToolRouterAdapter({
        router,
        contextFactory: { create: () => baseToolContext() },
      });
      const envelope = await adapter.execute({
        toolId: 'meta',
        args: { action: 'tools', params: {} },
        surface: 'runtime',
        actor: { role: 'agent' },
        source: { kind: 'runtime' },
        abortSignal: abortController.signal,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(envelope).toMatchObject({
        ok: false,
        status: 'timeout',
        structuredContent: { retained: 'partial readback' },
      });
    } finally {
      execute.mockRestore();
    }
  });
});

describe('ToolRouter scheduling and cancellation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { tool: 'meta', action: 'plan', params: { steps: [42], strategy: 'fixture' } },
    {
      tool: 'meta',
      action: 'plan',
      params: { steps: [{ id: 'wrong', action: 12 }], strategy: 'fixture' },
    },
    {
      tool: 'memory',
      action: 'save',
      params: { key: 'fixture', content: 'fixture', tags: ['valid', 123] },
    },
    {
      tool: 'memory',
      action: 'note_finding',
      params: { finding: 'fixture', evidenceRefs: ['E-fixture', 123] },
    },
  ])('rejects nested parameter shapes before native $tool.$action writes', async ({
    tool,
    action,
    params,
  }) => {
    const save = vi.fn();
    const noteFinding = vi.fn(() => 'fixture recorded');
    const create = vi.fn(() => ({
      ...baseToolContext(),
      sessionStore: { save },
      memoryCoordinator: { noteFinding },
    }));
    const adapter = new ToolRouterAdapter({ contextFactory: { create } });
    const result = await adapter.execute({
      toolId: tool,
      args: { action, params },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime' },
    });
    expect(result).toMatchObject({
      ok: false,
      structuredContent: { code: 'TOOL_CALL_INVALID', writeState: 'not-started' },
    });
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(noteFinding).not.toHaveBeenCalled();
  });

  it('keeps schema-permitted extra params without coercing or deleting them', async () => {
    const save = vi.fn();
    const router = new ToolRouter();
    const steps = [{ id: 1, action: 'read', extra: 'retained' }];
    const result = await router.execute(
      { tool: 'meta', action: 'plan', params: { steps, strategy: 'fixture', extra: 'permitted' } },
      { ...baseToolContext(), sessionStore: { save } }
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(save.mock.calls[0][1])).toEqual({ steps, strategy: 'fixture' });
    expect(steps[0].extra).toBe('retained');
  });

  it('refreshes validation when a public schema changes in place and isolates reused schema ids', async () => {
    const saveAction = TOOL_REGISTRY.memory.actions.save;
    const planAction = TOOL_REGISTRY.meta.actions.plan;
    const originalSave = saveAction.params;
    const originalPlan = planAction.params;
    const save = vi.fn();
    const router = new ToolRouter();
    const context = { ...baseToolContext(), sessionStore: { save } };
    const call = { tool: 'memory', action: 'save', params: { key: 'k', content: 'finding' } };
    try {
      // 两个独立action可合法使用同一个$id；验证缓存不能成为全局schema注册表。
      saveAction.params = { ...structuredClone(originalSave), $id: 'urn:fixture:tool-params' };
      planAction.params = { ...structuredClone(originalPlan), $id: 'urn:fixture:tool-params' };
      expect((await router.execute(call, context)).ok).toBe(true);
      expect(
        (
          await router.execute(
            { tool: 'meta', action: 'plan', params: { steps: [], strategy: 'fixture' } },
            context
          )
        ).ok
      ).toBe(true);
      const properties = saveAction.params.properties as Record<string, Record<string, unknown>>;
      properties.key.minLength = 2;
      expect(await router.execute(call, context)).toMatchObject({
        ok: false,
        data: { code: 'TOOL_CALL_INVALID' },
      });
      expect(save).toHaveBeenCalledTimes(2);
      delete properties.key.minLength;
      expect((await router.execute(call, context)).ok).toBe(true);
      expect(save).toHaveBeenCalledTimes(3);
    } finally {
      saveAction.params = originalSave;
      planAction.params = originalPlan;
    }
  });

  it('keeps the captured write target tied to live permissions after scheduling', async () => {
    const save = vi.fn();
    const recall = vi.fn(() => []);
    const capability = {
      name: 'fixture',
      description: 'fixture',
      allowedTools: { memory: ['save', 'recall'] },
    };
    const router = new ToolRouter({ capability });
    const call = { tool: 'memory', action: 'save', params: { key: 'fixture', content: 'finding' } };
    const pending = router.execute(call, { ...baseToolContext(), sessionStore: { save, recall } });
    // Router 已在准入后等待 slot；改写调用对象不能使 save handler 获得 recall 的授权。
    call.action = 'recall';
    capability.allowedTools.memory = ['recall'];
    expect(await pending).toMatchObject({
      ok: false,
      data: { code: 'TOOL_ACTION_DENIED', action: 'save', writeState: 'not-started' },
    });
    expect(save).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
  });

  it('owns nested params while the native single-action handler waits for its slot', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = vi.fn(async (id: string) => {
      if (id === 'first') {
        entered();
        await held;
      }
      return { id };
    });
    const router = new ToolRouter();
    const context = { ...baseToolContext(), knowledgeManagement: { update } };
    const first = router.execute(
      {
        tool: 'knowledge',
        action: 'manage',
        params: { operation: 'update', id: 'first', data: { title: 'first' } },
      },
      context
    );
    await started;
    const call = {
      tool: 'knowledge',
      action: 'manage',
      params: {
        operation: 'update',
        id: 'second',
        data: { title: 'original', tags: ['original'] },
      },
    };
    const second = router.execute(call, context);
    call.params.id = 'changed';
    call.params.data.title = 'changed';
    call.params.data.tags.push('changed');
    release();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(update).toHaveBeenLastCalledWith('second', { title: 'original', tags: ['original'] });
    expect(call.params.data.tags).toEqual(['original', 'changed']);
  });

  it.each([
    {
      label: 'object',
      tool: 'code',
      raw: { action: 'search', params: { patterns: ['TODO'] } },
      action: 'search',
      params: { patterns: ['TODO'] },
    },
    {
      label: 'JSON',
      tool: 'terminal',
      raw: JSON.stringify({ action: 'exec', params: { command: 'fixture' } }),
      action: 'exec',
      params: { command: 'fixture' },
    },
    {
      label: 'omitted params',
      tool: 'graph',
      raw: { action: 'overview' },
      action: 'overview',
      params: {},
    },
  ])('normalizes tool arguments from $label without executing a handler', ({
    tool,
    raw,
    action,
    params,
  }) => {
    expect(new ToolRouter().parseToolCall(tool, raw)).toEqual({ tool, action, params });
  });

  it.each([
    { label: 'missing action', raw: { params: { path: 'fixture.ts' } } },
    { label: 'malformed JSON', raw: '{invalid json}' },
  ])('rejects $label before execution', ({ raw }) => {
    expect(new ToolRouter().parseToolCall('code', raw)).toHaveProperty('error');
  });

  it.each([
    { tool: 'unknown-tool', action: 'read' },
    { tool: 'code', action: 'unknown-action' },
  ])('rejects unknown execution target $tool.$action', async ({ tool, action }) => {
    const result = await new ToolRouter().execute({ tool, action, params: {} }, baseToolContext());
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Invalid call') });
  });

  it('passes an immutable registry view with the actual handler and preserves execution errors', async () => {
    const handler = vi
      .spyOn(TOOL_REGISTRY.meta.actions.review, 'handler')
      .mockResolvedValue({ ok: true, data: { found: true } });
    const router = new ToolRouter();
    const call = { tool: 'meta', action: 'review', params: {} };
    expect(await router.execute(call, baseToolContext())).toMatchObject({
      ok: true,
      data: { found: true },
    });
    expect(handler).toHaveBeenCalledOnce();
    const [params, context] = handler.mock.calls[0];
    expect(params).toEqual({});
    expect(context.projectRoot).toBe(baseRoot);
    expect(context.toolRegistry).not.toBe(TOOL_REGISTRY);
    expect(Object.isFrozen(context.toolRegistry)).toBe(true);
    expect(context.toolRegistry?.meta.actions.review.handler).toBe(handler);
    handler.mockRejectedValueOnce(new Error('fixture handler failed'));
    expect(await router.execute(call, baseToolContext())).toMatchObject({
      ok: false,
      error: expect.stringContaining('fixture handler failed'),
    });
  });

  it.each([123, [], {}])('rejects an invalid memory key before storing it: %j', async (key) => {
    const handler = vi
      .spyOn(TOOL_REGISTRY.memory.actions.save, 'handler')
      .mockResolvedValue({ ok: true, data: 'should not run' });
    const result = await new ToolRouter().execute(
      { tool: 'memory', action: 'save', params: { key, content: 'finding' } },
      baseToolContext()
    );
    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['write', 'read'],
    ['read', 'write'],
    ['write', 'write'],
  ] as const)('keeps exclusive calls isolated: %s then %s', async (firstAction, secondAction) => {
    const router = new ToolRouter();
    const entered: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstEntered!: () => void;
    const started = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    for (const action of new Set([firstAction, secondAction])) {
      vi.spyOn(TOOL_REGISTRY.code.actions[action], 'handler').mockImplementation(async (params) => {
        const name = String(params.path);
        entered.push(name);
        if (name === 'first') {
          firstEntered();
          await held;
        }
        return { ok: true, data: name };
      });
    }
    const first = router.execute(
      { tool: 'code', action: firstAction, params: { path: 'first', content: '' } },
      baseToolContext()
    );
    await started;
    const second = router.execute(
      { tool: 'code', action: secondAction, params: { path: 'second', content: '' } },
      baseToolContext()
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const whileHeld = [...entered];
    release();
    await Promise.all([first, second]);
    expect(whileHeld).toEqual(['first']);
    expect(entered).toEqual(['first', 'second']);
  });

  it('does not execute a queued mutation after cancellation', async () => {
    const router = new ToolRouter();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi
      .spyOn(TOOL_REGISTRY.code.actions.write, 'handler')
      .mockImplementation(async () => {
        await held;
        return { ok: true, data: 'done' };
      });
    const call = { tool: 'code', action: 'write', params: { path: 'file.ts', content: '' } };
    const first = router.execute(call, baseToolContext());
    const controller = new AbortController();
    const second = router.execute(call, { ...baseToolContext(), abortSignal: controller.signal });
    controller.abort();
    release();
    const [, cancelled] = await Promise.all([first, second]);
    expect(cancelled.ok).toBe(false);
    expect(cancelled.error).toMatch(/abort/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('tool runtime adapters and public contracts', () => {
  it.each(
    (['execute', 'executeChildCall'] as const).flatMap((entry) =>
      ['success', 'blocked', 'invalid', 'pre-aborted', 'host-error', 'timeout'].map((outcome) => ({
        entry,
        outcome,
      }))
    )
  )('preserves parent identity through $entry returning $outcome', async ({ entry, outcome }) => {
    const abort = new AbortController();
    if (outcome === 'pre-aborted') {
      abort.abort('fixture cancellation');
    }
    const save = vi.fn();
    const adapter = new ToolRouterAdapter({
      ...(outcome === 'blocked'
        ? { capability: { name: 'fixture', description: 'fixture', allowedTools: {} } }
        : {}),
      contextFactory: {
        create: (request) => {
          expect(request.parentCallId).toBe('fixture-parent');
          if (outcome === 'host-error') {
            throw new Error('fixture host allocation failed');
          }
          return {
            ...baseToolContext(),
            sessionStore: { save },
            sandboxExecutor: {
              exec: async () => {
                abort.abort(new DOMException('fixture deadline', 'TimeoutError'));
                return { stdout: 'partial output', stderr: '', exitCode: 137 };
              },
            },
          };
        },
      },
    });
    const result = await adapter[entry]({
      toolId:
        outcome === 'invalid' ? 'fixture-unknown' : outcome === 'timeout' ? 'terminal' : 'memory',
      args:
        outcome === 'timeout'
          ? { action: 'exec', params: { command: 'fixture' } }
          : { action: 'save', params: { key: 'fixture', content: 'finding' } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime' },
      parentCallId: 'fixture-parent',
      abortSignal: abort.signal,
    });
    expect(result.parentCallId).toBe('fixture-parent');
    expect(result.callId).toEqual(expect.any(String));
    expect(result.callId).not.toBe(result.parentCallId);
    expect(result.status).toBe(
      outcome === 'invalid' || outcome === 'host-error'
        ? 'error'
        : outcome === 'pre-aborted'
          ? 'aborted'
          : outcome
    );
    expect(save).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    if (outcome === 'timeout') {
      expect(result.structuredContent).toContain('partial output');
    }
  });

  it('preserves an aborted status through the host adapter before execution', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new ToolRouterAdapter({ contextFactory: { create: () => baseToolContext() } });
    const result = await adapter.execute({
      toolId: 'meta',
      args: { action: 'tools', params: {} },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'test' },
      abortSignal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('aborted');
  });
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

  it('projects Evolution terminal access with a read-only command allowlist', () => {
    const capability = new Evolution().toDef();
    const router = new ToolRouter({ capability });
    const schemas = router.getSchemas();
    const terminal = schemas.find((schema) => schema.name === 'terminal');
    const terminalParams = terminal?.parameters as {
      properties?: { action?: { enum?: string[] } };
    };

    expect(capability.allowedTools.terminal).toEqual(['exec']);
    expect(capability.commandAllowlist?.bins).toContain('git');
    expect(capability.commandAllowlist?.bins).toContain('grep');
    expect(capability.commandAllowlist?.bins).toContain('npm');
    expect(capability.commandAllowlist?.bins).not.toContain('rm');
    expect(capability.commandAllowlist?.intent).toEqual({
      network: 'none',
      filesystem: 'read-only',
    });
    expect(terminalParams.properties?.action?.enum).toEqual(['exec']);
    expect(capability.promptFragment).toContain('git log');
    expect(capability.promptFragment).toContain('grep');
    expect(capability.promptFragment).toContain('npm test');
    expect(capability.promptFragment).toContain('不提交新知识');
    expect(capability.promptFragment).not.toContain('不使用终端工具');
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

  it('routes tool calls through generic router and adapter contracts', async () => {
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

  it('binds terminal exec calls to the injected sandbox executor', async () => {
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

  it('serializes concurrent single-concurrency tool calls via the per-tool lock', async () => {
    const router = new ToolRouter();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const sandboxExecutor = {
      exec: async (command: string) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`enter:${command}`);
        // Hold the lock across an await — an unserialized second caller would overlap here.
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`exit:${command}`);
        active--;
        return { stdout: command, stderr: '', exitCode: 0 };
      },
    };

    const run = (command: string) => {
      const parsed = router.parseToolCall('terminal', { action: 'exec', params: { command } });
      if ('error' in parsed) {
        throw new Error(parsed.error);
      }
      return router.execute(parsed, { ...baseToolContext(), sandboxExecutor });
    };

    await Promise.all([run('a'), run('b')]);

    // terminal.exec is concurrency:'single' — the per-tool lock must prevent any
    // overlap inside the handler, so at most one call is ever active.
    expect(maxActive).toBe(1);
    // Each command's enter is immediately followed by its own exit (no interleave).
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(`exit:${order[0].slice('enter:'.length)}`);
    expect(order[3]).toBe(`exit:${order[2].slice('enter:'.length)}`);
  });

  it.each([
    { label: 'confirmed cancellation', reason: () => new Error('fixture stop'), status: 'aborted' },
    {
      label: 'confirmed deadline',
      reason: () => new DOMException('fixture deadline', 'TimeoutError'),
      status: 'timeout',
    },
    { label: 'unknown SIGKILL cause', reason: () => undefined, status: 'error' },
  ])('retains terminal partial output and $label through the real adapter', async ({
    reason,
    status,
  }) => {
    const abortController = new AbortController();
    const compress = vi.fn(async (output: string) => output);
    const exec = vi.fn(async (_command: string, opts: { signal?: AbortSignal }) => {
      expect(opts.signal).toBe(abortController.signal);
      expect(opts.signal?.aborted).toBe(false);
      const abortReason = reason();
      if (abortReason !== undefined) {
        abortController.abort(abortReason);
      }
      return { stdout: 'partial output\n', stderr: '', exitCode: 137 };
    });
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          ...baseToolContext(),
          sandboxExecutor: { exec },
          compressor: { compress },
        }),
      },
    });

    const envelope = await adapter.execute({
      toolId: 'terminal',
      args: { action: 'exec', params: { command: 'sleep 99' } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'vitest' },
      abortSignal: abortController.signal,
    });

    expect(exec).toHaveBeenCalledOnce();
    expect(compress).not.toHaveBeenCalled();
    // 旧 ok:true 表示调用返回了可用输出；明确终态必须阻止下游把中止当作命令成功。
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe(status);
    expect(envelope.text).toContain('partial output');
    expect(envelope.structuredContent).toContain('partial output');
    expect(envelope.diagnostics?.degraded).toBe(true);
    expect(envelope.diagnostics?.fallbackUsed).toBe(false);
    expect(envelope.diagnostics.warnings).toContainEqual(
      expect.objectContaining({ code: 'terminal_execution_interrupted' })
    );
    expect(readToolObservation({ tool: 'terminal', args: { action: 'exec' }, envelope }).ok).toBe(
      false
    );
  });

  it('reports clean diagnostics for a normal handler result', async () => {
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          ...baseToolContext(),
          sandboxExecutor: {
            exec: async () => ({ stdout: 'v22.0.0', stderr: '', exitCode: 0 }),
          },
        }),
      },
    });

    const envelope = await adapter.execute({
      toolId: 'terminal',
      args: { action: 'exec', params: { command: 'node -v' } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'vitest' },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.diagnostics?.degraded).toBe(false);
    expect(envelope.diagnostics?.fallbackUsed).toBe(false);
  });

  it.each([
    { evidenceMode: 'static sources', scope: undefined },
    { evidenceMode: 'ledger refs', scope: 'narrow' },
    { evidenceMode: 'ledger inferred sources', scope: 'narrow' },
    { evidenceMode: 'ledger unmatched sources', scope: 'narrow' },
    { evidenceMode: 'ledger empty refs', scope: 'narrow' },
    { evidenceMode: 'ledger refs', scope: 'file-local' },
    { evidenceMode: 'ledger refs', scope: 'single-file' },
    { evidenceMode: 'ledger refs', scope: 'local-only' },
    { evidenceMode: 'ledger refs', scope: 'fixture-unknown-scope', coreError: 'SNIPPET_MISMATCH' },
  ])('preserves actual knowledge submission validation with $evidenceMode / $scope', async ({
    evidenceMode,
    scope,
    coreError,
  }) => {
    const router = new ToolRouter();
    const ledger =
      evidenceMode === 'static sources'
        ? undefined
        : new EvidenceLedgerStore({
            dataRoot: baseRoot,
            jobId: 'parameter-contract',
            sessionId: 'fixture-session',
            dimensionId: `${evidenceMode.replaceAll(' ', '-')}-${scope}`,
          });
    const entry = ledger?.append({
      tool: 'code.read',
      callId: 'fixture-read',
      file: 'package.json',
      range: { start: 1, end: 3 },
      content: (await readFile(join(process.cwd(), 'package.json'), 'utf8'))
        .split('\n')
        .slice(0, 3)
        .join('\n'),
    });
    const evidenceRefs = entry ? [entry.id] : [];
    const reasoning =
      evidenceMode === 'ledger refs'
        ? { evidenceRefs, confidence: 0.9 }
        : evidenceMode === 'ledger empty refs'
          ? { evidenceRefs: [], confidence: 0.9 }
          : {
              sources: [
                evidenceMode === 'ledger unmatched sources' ? 'README.md:1-3' : 'package.json:1-3',
              ],
              confidence: 0.9,
            };
    const createRequests: Array<{
      input: { items: Record<string, unknown>[]; options?: Record<string, unknown> };
      context: { source: string; userId: string; capability: string };
    }> = [];
    // P1.4b：in-process 提交现在过权威 validateAgainst（opportunistic）门禁，候选必须 gate-clean
    // （祈使 doClause/dontClause、✅❌ 对比、可解析的 source-ref）。projectRoot 指向真实仓库根，
    // 引用真实文件 package.json:1-3 以通过廉价 fs 来源接地；本用例验证的是 source 缺省，不是门禁。
    const parsed = router.parseToolCall('knowledge', {
      action: 'submit',
      params: {
        title: 'Tool V2 source boundary',
        description: 'Records the Agent runtime as the default source for new knowledge writes.',
        content: {
          markdown: [
            '## Tool V2 source boundary',
            'The Agent runtime keeps alembic-agent as the default source for new knowledge writes,',
            'separate from legacy ide-agent compatibility inputs (来源: package.json:1).',
            '✅ Record alembic-agent as the source for Agent runtime writes.',
            '❌ Do not reuse the legacy ide-agent source for new candidates.',
          ].join('\n'),
          rationale:
            'The source value must distinguish Alembic Agent owned writes from legacy IDE agent compatibility inputs.',
          ...(coreError ? { pattern: 'export const notInSources = true;' } : {}),
        },
        kind: 'pattern',
        trigger: 'Tool V2 source boundary',
        whenClause: 'When the Agent runtime submits a new knowledge candidate through Tool V2.',
        doClause: 'Record alembic-agent as the default source for the submitted candidate.',
        dontClause: 'Do not reuse the legacy ide-agent source for new Agent writes.',
        reasoning,
        ...(scope ? { scope } : {}),
      },
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const context: ToolContext = {
      ...baseToolContext(),
      projectRoot: process.cwd(),
      ...(ledger ? { runtime: { evidenceLedger: ledger } } : {}),
      recipeGateway: {
        createOrStage: async (
          input: { items: Record<string, unknown>[]; options?: Record<string, unknown> },
          context: { source: string; userId: string; capability: string }
        ) => {
          createRequests.push({ input, context });
          return {
            created: [
              {
                id: 'candidate-1',
                title: 'Tool V2 source boundary',
                lifecycle: 'pending',
                raw: input.items[0],
              },
            ],
            rejected: [],
            duplicates: [],
            merged: [],
            blocked: [],
            supersedeProposal: null,
            production: { capability: 'knowledge-submit', source: 'alembic-agent' },
          };
        },
        evaluateReadiness: async () => ({
          ready: false,
          schemaVersion: '1',
          profileHash: null,
          documentSetHash: null,
          violations: [{ code: 'retrieval.profile.missing', message: 'profile missing' }],
          warnings: [],
        }),
      },
    };
    const adapter = new ToolRouterAdapter({ router, contextFactory: { create: () => context } });
    const result = await adapter.execute({
      toolId: parsed.tool,
      args: { action: parsed.action, params: parsed.params },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime' },
      runtime: context.runtime,
    });

    if (coreError) {
      expect(result.ok).toBe(false);
      expect(result.text).toContain(coreError);
      expect(createRequests).toEqual([]);
      return;
    }
    if (evidenceMode === 'ledger unmatched sources' || evidenceMode === 'ledger empty refs') {
      expect(result.ok).toBe(false);
      expect(createRequests).toEqual([]);
      return;
    }
    expect(result.ok, result.text).toBe(true);
    expect(createRequests[0]?.context).toEqual({
      source: 'alembic-agent',
      userId: 'alembic-agent',
      capability: 'knowledge-submit',
    });
    expect(createRequests[0]?.input.items[0]?.source).toBe('alembic-agent');
    expect(createRequests[0]?.input.items[0]?.reasoning).toMatchObject({
      sources: ['package.json:1-3'],
    });
    if (ledger) {
      expect(createRequests[0]?.input.items[0]?.reasoning).toMatchObject({
        evidenceRefs,
      });
      expect(createRequests[0]?.input.items[0]?.scope).toBe(scope);
    }
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
          proposalGateway: {
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

// ─── B-1 写前新鲜度门（read-before-write / TOCTOU），§8 Phase 3 ──────────────────
// 复用 llm-input-correctness.test.ts:49 的 toolContext(root, deltaCache?) 模式构造共享同一
// deltaCache 实例的 ctx；驱动用 router.execute({tool:'code',action:'read'|'write'}, ctx)（真路由
// 路径，非直调 handleWrite）；mkdtemp 离线。注：case 7 的"共享实例守卫"只证门逻辑，
// 不替代 §真跑 instanceId HARD GATE —— 生产宿主工厂是否在 run 级共享 deltaCache 须真 run 证明。
function freshnessCtx(root: string, deltaCache?: DeltaCache): ToolContext {
  return {
    projectRoot: root,
    tokenBudget: 4000,
    ...(deltaCache ? { deltaCache } : {}),
  };
}

async function withWriteFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-b1-freshness-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf-8');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('B-1 write-freshness gate (read-before-write / TOCTOU)', () => {
  it('does not reuse a narrower search result for an expanded request', async () => {
    await withWriteFixture(async (root) => {
      await writeFile(
        join(root, 'src/a.ts'),
        'match one\nmatch two\nmatch three\nmatch four\nmatch five\nmatch six\n'
      );
      const router = new ToolRouter();
      const ctx = { ...freshnessCtx(root), searchCache: new SearchCache() };
      const narrow = await router.execute(
        {
          tool: 'code',
          action: 'search',
          params: { patterns: ['match'], maxResults: 1, contextLines: 0 },
        },
        ctx
      );
      expect(narrow.ok).toBe(true);
      const call = {
        tool: 'code',
        action: 'search',
        params: { patterns: ['match'], maxResults: 6, contextLines: 1 },
      };
      const expanded = await router.execute(call, ctx);
      const fresh = await router.execute(call, {
        ...freshnessCtx(root),
        searchCache: new SearchCache(),
      });
      expect(expanded.ok).toBe(true);
      expect((expanded.data as { matches: unknown[] }).matches).toHaveLength(6);
      expect(expanded.data).toEqual(fresh.data);
    });
  });
  it('keeps structure paths relative to a symlinked checkout', async () => {
    await withWriteFixture(async (outer) => {
      await symlink(join(outer, 'src'), join(outer, 'checkout'));
      const result = await new ToolRouter().execute(
        { tool: 'code', action: 'structure', params: {} },
        freshnessCtx(join(outer, 'checkout'))
      );
      expect(String(result.data).split('\n')[0]).toBe('./');
    });
  });
  it.each([
    20, 600,
  ])('serves requested ranges after a cached read of %i lines', async (lineCount) => {
    await withWriteFixture(async (root) => {
      await writeFile(
        join(root, 'src/a.ts'),
        Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join('\n')
      );
      const router = new ToolRouter();
      const ctx = freshnessCtx(root, new DeltaCache(50));
      await router.execute({ tool: 'code', action: 'read', params: { path: 'src/a.ts' } }, ctx);
      for (const startLine of [5, 10]) {
        const result = await router.execute(
          {
            tool: 'code',
            action: 'read',
            params: { path: 'src/a.ts', startLine, endLine: startLine + 1 },
          },
          ctx
        );
        expect(result.ok).toBe(true);
        expect(result.data).toContain(`${startLine}|line ${startLine}`);
      }
    });
  });

  it.each([
    'read',
    'write',
  ])('rejects code.%s through a symlink outside the project', async (action) => {
    await withWriteFixture(async (outer) => {
      const root = join(outer, 'project');
      await mkdir(root);
      await symlink(join(outer, 'src'), join(root, 'linked'));
      const result = await new ToolRouter().execute(
        { tool: 'code', action, params: { path: 'linked/a.ts', content: 'overwritten' } },
        freshnessCtx(root)
      );
      expect(result.ok).toBe(false);
      expect(await readFile(join(outer, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    });
  });

  it('rejects creating a new file through a symlink outside the project', async () => {
    await withWriteFixture(async (outer) => {
      const root = join(outer, 'project');
      await mkdir(root);
      await symlink(join(outer, 'src'), join(root, 'linked'));
      const result = await new ToolRouter().execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'linked/new/a.ts', content: 'new', createDirectories: true },
        },
        freshnessCtx(root)
      );
      expect(result.ok).toBe(false);
      await expect(readFile(join(outer, 'src/new/a.ts'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('applies protected paths to symlink targets inside the project', async () => {
    await withWriteFixture(async (root) => {
      await mkdir(join(root, '.git'));
      await writeFile(join(root, '.git/config'), 'protected');
      await symlink(join(root, '.git/config'), join(root, 'alias'));
      const result = await new ToolRouter().execute(
        { tool: 'code', action: 'write', params: { path: 'alias', content: 'overwritten' } },
        freshnessCtx(root)
      );
      expect(result.ok).toBe(false);
      expect(await readFile(join(root, '.git/config'), 'utf8')).toBe('protected');
    });
  });

  it('state 4: writes a brand-new (disk-absent) file without requiring a prior read', async () => {
    await withWriteFixture(async (root) => {
      const router = new ToolRouter();
      const ctx = freshnessCtx(root, new DeltaCache(50));
      const res = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/new.ts', content: 'export const n = 1;\n' },
        },
        ctx
      );
      expect(res.ok).toBe(true);
      expect((res.data as { written?: string }).written).toBe('src/new.ts');
      expect(await readFile(join(root, 'src/new.ts'), 'utf-8')).toBe('export const n = 1;\n');
    });
  });

  it('state 1: rejects a write to a disk-existing file that was NOT read this run', async () => {
    await withWriteFixture(async (root) => {
      const router = new ToolRouter();
      const ctx = freshnessCtx(root, new DeltaCache(50));
      // 预置磁盘文件，但不经 code.read（cache 无指纹）。
      await writeFile(join(root, 'src/unread.ts'), 'export const u = 1;\n', 'utf-8');
      const res = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/unread.ts', content: 'export const u = 2;\n' },
        },
        ctx
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain('exists on disk but was not read');
      expect(res.error).toContain('Re-read the file with code.read');
      // 与态 4 区分：磁盘内容未被覆盖。
      expect(await readFile(join(root, 'src/unread.ts'), 'utf-8')).toBe('export const u = 1;\n');
    });
  });

  it('state 3: allows a write after a consistent read (same ctx, disk unchanged)', async () => {
    await withWriteFixture(async (root) => {
      const router = new ToolRouter();
      const ctx = freshnessCtx(root, new DeltaCache(50));
      const read = await router.execute(
        { tool: 'code', action: 'read', params: { path: 'src/a.ts' } },
        ctx
      );
      expect(read.ok).toBe(true);
      const res = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/a.ts', content: 'export const a = 99;\n' },
        },
        ctx
      );
      expect(res.ok).toBe(true);
      expect(await readFile(join(root, 'src/a.ts'), 'utf-8')).toBe('export const a = 99;\n');
    });
  });

  it('state 2 (CG-3): rejects a write when the file changed externally since last read', async () => {
    await withWriteFixture(async (root) => {
      const router = new ToolRouter();
      const ctx = freshnessCtx(root, new DeltaCache(50));
      await router.execute({ tool: 'code', action: 'read', params: { path: 'src/a.ts' } }, ctx);
      // 带外修改磁盘（模拟并发 host rescan/job 或上一轮产物）。
      await writeFile(join(root, 'src/a.ts'), 'export const a = 7;\n// external edit\n', 'utf-8');
      const res = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/a.ts', content: 'export const a = 99;\n' },
        },
        ctx
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain('changed externally since last read');
      expect(res.error).toContain('Re-read the file with code.read');
      // 硬拒：磁盘仍是带外内容，未被静默覆盖。
      expect(await readFile(join(root, 'src/a.ts'), 'utf-8')).toBe(
        'export const a = 7;\n// external edit\n'
      );
    });
  });

  it('state 3 + baseline update: an immediate same-ctx re-write is allowed (set() updated fingerprint)', async () => {
    await withWriteFixture(async (root) => {
      const router = new ToolRouter();
      const ctx = freshnessCtx(root, new DeltaCache(50));
      await router.execute({ tool: 'code', action: 'read', params: { path: 'src/a.ts' } }, ctx);
      const first = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/a.ts', content: 'export const a = 2;\n' },
        },
        ctx
      );
      expect(first.ok).toBe(true);
      // 无带外改，立即再写：写后若未更新基线指纹会被误判态 2，故此处证 set() 生效。
      const second = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/a.ts', content: 'export const a = 3;\n' },
        },
        ctx
      );
      expect(second.ok).toBe(true);
      expect(await readFile(join(root, 'src/a.ts'), 'utf-8')).toBe('export const a = 3;\n');
    });
  });

  it('passthrough: with no deltaCache injected the gate does not false-reject a disk-existing write', async () => {
    await withWriteFixture(async (root) => {
      const router = new ToolRouter();
      const ctx = freshnessCtx(root); // no deltaCache
      const res = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/a.ts', content: 'export const a = 5;\n' },
        },
        ctx
      );
      expect(res.ok).toBe(true);
      expect(await readFile(join(root, 'src/a.ts'), 'utf-8')).toBe('export const a = 5;\n');
    });
  });

  it('shared-instance contract guard (logic-only — NOT a substitute for the real-run instanceId HARD GATE)', async () => {
    await withWriteFixture(async (root) => {
      const router = new ToolRouter();
      const shared = new DeltaCache(50);
      // 同一 deltaCache 跨 read/write → 命中态 3 放行。
      await router.execute(
        { tool: 'code', action: 'read', params: { path: 'src/a.ts' } },
        freshnessCtx(root, shared)
      );
      const allowed = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/a.ts', content: 'export const a = 8;\n' },
        },
        freshnessCtx(root, shared)
      );
      expect(allowed.ok).toBe(true);

      // 换全新 deltaCache 传给 write（模拟工厂 per-create 新建、未 run 级共享）→ 命中态 1 被拒。
      // 这正是真跑 instanceId HARD GATE 要排除的失败模式：宿主工厂不共享 → 合法重写被误拒。
      const fresh = new DeltaCache(50);
      const rejected = await router.execute(
        {
          tool: 'code',
          action: 'write',
          params: { path: 'src/a.ts', content: 'export const a = 9;\n' },
        },
        freshnessCtx(root, fresh)
      );
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toContain('exists on disk but was not read');
    });
  });
});
