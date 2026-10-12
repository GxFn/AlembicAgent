import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EvidenceCollector } from '../src/agent/evidence/EvidenceCollector.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import type { SessionStore } from '../src/agent/memory/SessionStore.js';
import { readToolObservation } from '../src/agent/utils/toolOutcomes.js';
import { estimateTokens as estimateSharedTokens } from '../src/shared/tokenUtils.js';
import type { EvidenceLedgerLike, ToolCallRequest } from '../src/tools/kernel/index.js';
import { buildSnippetRepairHint } from '../src/tools/runtime/handlers/knowledge/sources.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';
import type {
  DeltaCacheLike,
  MemoryCoordinatorLike,
  ToolContext,
  ToolContextFactoryContract,
  ToolResult,
} from '../src/tools/runtime/index.js';
import {
  DeltaCache,
  Evolution,
  estimateTokens as estimateToolTokens,
  fail as failToolResult,
  ok as okToolResult,
  SearchCache,
  ToolRouter,
  ToolRouterAdapter,
} from '../src/tools/runtime/index.js';
import { toolParameterSchemaError } from '../src/tools/runtime/parameters.js';
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
    // L4-P06：delta 不小于全文时回退 full，两行文件改一行（2 行 delta 对 2 行全文）不再是 delta；
    // 用 4 行文件钉住公开 delta 模式仍可达。
    const first = deltaCache.check('a.ts', 'one\ntwo\nthree\nfour');
    const unchanged = deltaCache.check('a.ts', 'one\ntwo\nthree\nfour');
    const changed = deltaCache.check('a.ts', 'one\nTWO\nthree\nfour');

    expect(first.mode).toBe('full');
    expect(unchanged.mode).toBe('unchanged');
    expect(changed.mode).toBe('delta');

    const searchCache = new SearchCache(1);
    const key = SearchCache.makeKey('AgentRuntime', '*.ts');
    searchCache.set(key, { matches: 1 });

    expect(searchCache.get(key)).toEqual({ matches: 1 });
    expect(searchCache.size).toBe(1);
  });

  it.each([
    { name: 'search', Cache: SearchCache },
    { name: 'delta', Cache: DeltaCache },
  ])('rejects invalid $name capacity at the public construction boundary', ({ Cache }) => {
    for (const capacity of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new Cache(capacity), `capacity=${capacity}`).toThrow(RangeError);
    }
  });

  it('keeps zero-capacity caches disabled while returning full read observations', () => {
    const search = new SearchCache(0);
    search.set('key', { matches: 1 });
    expect(search.get('key')).toBeUndefined();
    expect(search.size).toBe(0);
    const delta = new DeltaCache(0);
    expect(delta.check('source.ts', 'first').mode).toBe('full');
    expect(delta.check('source.ts', 'first').mode).toBe('full');
    expect(delta.size).toBe(0);
  });

  it('keeps search key components distinct even when pattern or glob contains a delimiter', () => {
    const cache = new SearchCache();
    const first = SearchCache.makeKey('a|b', 'c');
    const second = SearchCache.makeKey('a', 'b|c');
    cache.set(first, { source: 'first' });
    expect(cache.get(second)).toBeUndefined();
    expect(cache.get(first)).toEqual({ source: 'first' });
    expect(SearchCache.makeKey('x')).toBe(SearchCache.makeKey('x', '', false));
    expect(SearchCache.makeKey('x', '', true)).not.toBe(SearchCache.makeKey('x'));
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

// ─── L4-P06 DeltaCache 增量回退、不可见条目瘦身与指纹单源 ─────────────────────────────
// 来源：module-review-2026-10-01 I04（U12-F1 / U12-F3 / U12-F8）。逐位置比较的 diff 在文件头插入
// 一行后把其后每一行都输出成 -/+，delta 约为全文两倍并被 code.read 动作配额截断；仅指纹的不可见
// 条目也保存整文件内容；指纹由 DeltaCache 与 code.ts 各实现一份。钉住：行级 LCS 给出紧凑 hunk；
// delta 不小于全文时回退 full 并刷新可见基线（带诊断日志）；不可见条目 content 为 ''；指纹只在
// DeltaCache 内计算（与旧 md5 结果一致），写前门经 isFresh 判定，旧式缓存缺 isFresh 时降级为全文比对。
describe('L4-P06 DeltaCache delta fallback, fingerprint-only entries and fingerprint source', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const md5 = (content: string): string => createHash('md5').update(content).digest('hex');
  const sourceLines = (count: number, name = 'value'): string[] =>
    Array.from(
      { length: count },
      (_, index) => `export const ${name}${index} = 'padding text for line ${index}';`
    );
  const taggedLogs = (spy: { mock: { calls: unknown[][] } }, tag: string): string[] =>
    spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(tag));
  const readA = { tool: 'code', action: 'read', params: { path: 'src/a.ts' } };
  const writeA = (content: string) => ({
    tool: 'code',
    action: 'write',
    params: { path: 'src/a.ts', content },
  });

  it('returns a compact hunk after a first-line insertion instead of re-pairing every line', () => {
    const cache = new DeltaCache();
    const lines = sourceLines(100);
    cache.check('a.ts', lines.join('\n'));
    const inserted = ["import { x } from './x.js';", ...lines].join('\n');
    expect(cache.check('a.ts', inserted)).toEqual({
      mode: 'delta',
      content: "[delta: 1 hunk(s)]\n@@ line 1 @@\n+ import { x } from './x.js';",
      lineCount: 101,
    });
    expect(cache.check('a.ts', inserted).mode).toBe('unchanged');
  });

  it('keeps compact deltas for a middle-line edit and a single-line deletion', () => {
    const cache = new DeltaCache();
    const lines = sourceLines(100);
    cache.check('a.ts', lines.join('\n'));
    const edited = [...lines];
    edited[50] = 'export const value50 = 0;';
    expect(cache.check('a.ts', edited.join('\n')).content).toBe(
      `[delta: 1 hunk(s)]\n@@ line 51 @@\n- ${lines[50]}\n+ export const value50 = 0;`
    );
    const removed = edited.filter((_, index) => index !== 10);
    expect(cache.check('a.ts', removed.join('\n'))).toEqual({
      mode: 'delta',
      content: `[delta: 1 hunk(s)]\n@@ line 11 @@\n- ${lines[10]}`,
      lineCount: 99,
    });
  });

  it('falls back to a refreshed full baseline with a diagnostic when the delta is not smaller', () => {
    const logger = Logger.getInstance();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const cache = new DeltaCache();
    cache.check('a.ts', sourceLines(40).join('\n'));
    const rewritten = sourceLines(40, 'renamed').join('\n');
    expect(cache.check('a.ts', rewritten)).toEqual({
      mode: 'full',
      content: rewritten,
      lineCount: 40,
    });
    expect(cache.get('a.ts')).toMatchObject({
      hash: md5(rewritten),
      content: rewritten,
      lineCount: 40,
      visible: true,
    });
    expect(cache.check('a.ts', rewritten).mode).toBe('unchanged');
    const logs = taggedLogs(info, '[DeltaCache]');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('path=a.ts');
    expect(logs[0]).toContain('selected=full');
    expect(logs[0]).toContain('reason=delta_not_smaller');
    expect(logs[0]).toContain('changedLines=80');
    expect(logs[0]).toContain('fullLines=40');
    // 诊断只记录计数，不记录文件内容。
    expect(logs[0]).not.toContain('padding text');
  });

  it('pairs oversized middles positionally and still falls back when that delta would be larger', () => {
    const logger = Logger.getInstance();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const cache = new DeltaCache();
    const lines = sourceLines(600);
    cache.check('big.ts', lines.join('\n'));
    const edged = ['// head', ...lines.slice(1, -1), '// tail'];
    expect(cache.check('big.ts', edged.join('\n'))).toEqual({
      mode: 'delta',
      content: `[delta: 2 hunk(s)]\n@@ line 1 @@\n- ${lines[0]}\n+ // head\n\n@@ line 600 @@\n- ${lines[599]}\n+ // tail`,
      lineCount: 600,
    });
    const shifted = ['// inserted', ...edged.slice(0, -1), '// tail changed'].join('\n');
    expect(cache.check('big.ts', shifted)).toEqual({
      mode: 'full',
      content: shifted,
      lineCount: 601,
    });
    const logs = taggedLogs(info, '[DeltaCache]');
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('selected=delta');
    expect(logs[0]).toContain('diff=positional');
    expect(logs[0]).toContain('reason=lcs_budget_exceeded');
    expect(logs[1]).toContain('selected=full');
    expect(logs[1]).toContain('diff=positional');
    expect(logs[1]).toContain('reason=delta_not_smaller');
  });

  it('keeps a code.read re-read after a first-line insertion inside the action limit', async () => {
    await withWriteFixture(async (root) => {
      const lines = sourceLines(300);
      await writeFile(join(root, 'src/a.ts'), lines.join('\n'), 'utf-8');
      const cache = new DeltaCache(50);
      const ctx = freshnessCtx(root, cache);
      const router = new ToolRouter();
      const first = await router.execute(readA, ctx);
      expect(first.ok).toBe(true);
      expect(first._meta?.diagnosticWarnings ?? []).toEqual([]);
      expect(cache.get('src/a.ts')).toMatchObject({ visible: true });
      await writeFile(
        join(root, 'src/a.ts'),
        ["import { x } from './x.js';", ...lines].join('\n'),
        'utf-8'
      );
      const again = await router.execute(readA, ctx);
      expect(again.ok).toBe(true);
      expect(again.data).toBe("[delta: 1 hunk(s)]\n@@ line 1 @@\n+ import { x } from './x.js';");
      expect(again._meta?.diagnosticWarnings ?? []).toEqual([]);
      expect(cache.get('src/a.ts')).toMatchObject({ visible: true });
    });
  });

  it('stores fingerprint-only entries without content and gates writes through isFresh', async () => {
    await withWriteFixture(async (root) => {
      const disk = sourceLines(20).join('\n');
      await writeFile(join(root, 'src/a.ts'), disk, 'utf-8');
      const cache = new DeltaCache(50);
      const ctx = freshnessCtx(root, cache);
      const router = new ToolRouter();
      const range = await router.execute(
        { tool: 'code', action: 'read', params: { path: 'src/a.ts', startLine: 2, endLine: 3 } },
        ctx
      );
      expect(range.ok).toBe(true);
      // 指纹与旧 code.ts freshnessFingerprint（md5 hex）结果一致；不可见条目不再保存整文件。
      expect(cache.get('src/a.ts')).toMatchObject({
        hash: md5(disk),
        content: '',
        lineCount: 20,
        visible: false,
      });
      expect(cache.isFresh('src/a.ts', disk)).toBe(true);
      expect(cache.isFresh('src/a.ts', `${disk}\n`)).toBe(false);
      expect(cache.isFresh('src/other.ts', disk)).toBe(false);
      const write = await router.execute(writeA('export const a = 2;\n'), ctx);
      expect(write.ok).toBe(true);
      expect(cache.get('src/a.ts')).toMatchObject({
        hash: md5('export const a = 2;\n'),
        content: '',
        lineCount: 2,
        visible: false,
      });
      expect(cache.isFresh('src/a.ts', 'export const a = 2;\n')).toBe(true);
    });
  });

  it('computes the fingerprint when set() omits the hash and keeps the line count on demotion', () => {
    const cache = new DeltaCache();
    cache.set('a.ts', undefined, 'one\ntwo\nthree');
    expect(cache.get('a.ts')).toMatchObject({
      hash: md5('one\ntwo\nthree'),
      content: '',
      lineCount: 3,
      visible: false,
    });
    // 只带指纹降级（content 为空、指纹不变）沿用已知行数，不能把行数记成 1。
    cache.set('a.ts', md5('one\ntwo\nthree'), '');
    expect(cache.get('a.ts')).toMatchObject({ hash: md5('one\ntwo\nthree'), lineCount: 3 });
    cache.check('b.ts', 'x\ny');
    const visible = cache.get('b.ts');
    expect(visible).toMatchObject({ content: 'x\ny', visible: true });
    cache.set('b.ts', visible?.hash, visible?.content ?? '');
    expect(cache.get('b.ts')).toMatchObject({
      hash: md5('x\ny'),
      content: '',
      lineCount: 2,
      visible: false,
    });
    expect(cache.check('b.ts', 'x\ny').mode).toBe('full');
  });

  it('degrades the write gate to an exact content comparison for a cache without isFresh', async () => {
    await withWriteFixture(async (root) => {
      const logger = Logger.getInstance();
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const entries = new Map<string, { hash: string; content: string }>();
      // 旧式宿主实现：自带非 md5 指纹、没有 isFresh；写入路径不再替它计算指纹。
      const legacy: DeltaCacheLike = {
        get: (key) => entries.get(key),
        set: (key, hash, content) => {
          entries.set(key, { hash: hash ?? `legacy:${content.length}`, content });
        },
        check: (key, content) => {
          entries.set(key, { hash: `legacy:${content.length}`, content });
          return { mode: 'full', content, lineCount: content.split('\n').length };
        },
      };
      const ctx: ToolContext = { projectRoot: root, tokenBudget: 4000, deltaCache: legacy };
      const router = new ToolRouter();
      expect((await router.execute(readA, ctx)).ok).toBe(true);
      const allowed = await router.execute(writeA('export const a = 2;\n'), ctx);
      expect(allowed.ok).toBe(true);
      await writeFile(join(root, 'src/a.ts'), 'export const a = 3; // external\n', 'utf-8');
      const rejected = await router.execute(writeA('export const a = 4;\n'), ctx);
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toContain('changed externally since last read');
      expect(await readFile(join(root, 'src/a.ts'), 'utf-8')).toBe(
        'export const a = 3; // external\n'
      );
      const logs = taggedLogs(warn, '[code.write]');
      expect(logs).toHaveLength(2);
      for (const line of logs) {
        expect(line).toContain('path=src/a.ts');
        expect(line).toContain('freshness=content-compare');
        expect(line).toContain('reason=delta_cache_without_isFresh');
        expect(line).not.toContain('export const a');
      }
      expect(logs[0]).toContain('result=fresh');
      expect(logs[1]).toContain('result=stale');
    });
  });
});

/**
 * F4b 修复提示的 ref 读取失败可观测性钉子（I46 / P31）。
 *
 * 读取失败仍然跳到下一个 ref（宁缺毋错，不改变提示结果），但不再静默：每个被跳过的
 * ref 都有一条 debug 诊断，带 ref 文本与错误类别，不带文件内容。
 */
describe('snippet repair hint ref read failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a debug diagnostic for a ref that escapes the project root and moves on', async () => {
    const root = await mkdtemp(join(baseRoot, 'snippet-hint-'));
    const outside = await mkdtemp(join(baseRoot, 'snippet-outside-'));
    await writeFile(join(outside, 'secret.ts'), 'export const secret = 1;\n');
    await symlink(join(outside, 'secret.ts'), join(root, 'escape.ts'));
    await writeFile(join(root, 'ok.ts'), 'export const ok = 1;\nexport const ok2 = 2;\n');
    const logger = Logger.getInstance();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);

    const hint = buildSnippetRepairHint(['escape.ts:1-1', 'ok.ts:1-2'], root);

    expect(hint).toContain('ok.ts:1-2');
    expect(hint).not.toContain('secret');
    const messages = debug.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes('[knowledge.submit]'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('escape.ts:1-1');
    expect(messages[0]).toContain('Access denied');
  });
});

// ─── L4-P13 code.search 多 pattern 完整性与计数语义 ───────────────────────────────
// 来源：module-review-2026-10-01 I13。rg 输出超限曾与 timeout/aborted 共用中断通道：第一个常见词
// pattern 超过 2MB 就终止整个循环，后续 pattern 不执行且诊断不点名；合并又按 pattern 顺序拼接后
// slice(0, maxResults)，靠后 pattern 的命中被静默挤掉。这里用真实 rg + 合成项目钉住用户可见行为，
// 用受控 rg 替身（只发 --json 协议回执，不执行项目命令）钉住 spawn 边界：超限、收满、计数、中断。
interface SearchData {
  total: number;
  shown: number;
  matches: Array<{ file: string; line: number; content: string }>;
  incomplete?: true;
}

function searchRequest(
  params: Record<string, unknown>,
  abortSignal?: AbortSignal
): ToolCallRequest {
  return {
    toolId: 'code',
    args: { action: 'search', params },
    surface: 'runtime',
    actor: { user: 'test' },
    source: { kind: 'runtime' },
    ...(abortSignal ? { abortSignal } : {}),
  };
}

/** 1500 个文件各 20 行 import（rg --json 总输出远超 2MB）+ 一个只含 UniqueTargetSymbol 的文件。 */
async function makeImportHeavyProject(): Promise<string> {
  const root = await mkdtemp(join(baseRoot, 'p13-synthetic-'));
  const pad = 'x'.repeat(120);
  const body = Array.from({ length: 20 }, (_, i) => `import a${i} from 'mod${i}'; // ${pad}`).join(
    '\n'
  );
  await Promise.all(
    Array.from({ length: 1500 }, (_, i) => writeFile(join(root, `f${i}.ts`), `${body}\n`))
  );
  await writeFile(join(root, 'target.ts'), 'export const UniqueTargetSymbol = 1;\n');
  return root;
}

/** 受控 rg 替身：按 pattern（argv 倒数第二个）回放固定的 --json 事件流。 */
const FAKE_RG_SCRIPT = `#!${process.execPath}
const pattern = process.argv[process.argv.length - 2];
const event = (type, file, line, text) =>
  JSON.stringify({ type, data: { path: { text: './' + file }, line_number: line, lines: { text: text + '\\n' } } }) + '\\n';
const end = (file) => JSON.stringify({ type: 'end', data: { path: { text: './' + file } } }) + '\\n';
const summary = (matches, matchedLines) =>
  JSON.stringify({ type: 'summary', data: { stats: { matches, matched_lines: matchedLines } } }) + '\\n';
switch (pattern) {
  case 'overflow-short': {
    // 3 hits, then > 2MB of context: the output limit is reached before maxResults hits exist.
    const parts = [
      event('match', 'a.ts', 1, 'overflow-short one'),
      event('match', 'a.ts', 5, 'overflow-short two'),
      event('match', 'a.ts', 9, 'overflow-short three'),
    ];
    const filler = event('context', 'a.ts', 100, 'x'.repeat(240));
    for (let i = 0; i < 12000; i++) parts.push(filler);
    process.stdout.write(parts.join(''));
    break;
  }
  case 'tail-hit':
    process.stdout.write(event('match', 'b.ts', 2, 'tail-hit here') + end('b.ts') + summary(7, 1));
    break;
  case 'summary-counts':
    process.stdout.write(
      event('match', 'c.ts', 1, 'summary-counts a') +
        event('match', 'c.ts', 4, 'summary-counts b') +
        end('c.ts') +
        summary(9, 2)
    );
    break;
  case 'satisfied-hang': {
    // maxResults hits + file end, then the process stays alive: only an early finish returns quickly.
    const parts = [];
    for (let i = 1; i <= 10; i++) parts.push(event('match', 'd.ts', i, 'satisfied-hang ' + i));
    parts.push(end('d.ts'));
    process.stdout.write(parts.join(''));
    setTimeout(() => {}, 20000);
    break;
  }
  case 'hang-after-hit':
    process.stdout.write(event('match', 'e.ts', 3, 'hang-after-hit'));
    require('node:fs').writeFileSync(process.env.P13_MARKER, 'printed');
    setTimeout(() => {}, 20000);
    break;
  default:
    process.exitCode = 1;
}
`;

async function installFakeRg(): Promise<string> {
  const bin = await mkdtemp(join(baseRoot, 'p13-fake-rg-'));
  await writeFile(join(bin, 'rg'), FAKE_RG_SCRIPT);
  await chmod(join(bin, 'rg'), 0o755);
  vi.stubEnv('PATH', bin);
  return bin;
}

describe('L4-P13 code.search multi-pattern completeness and count semantics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps a later pattern visible and undegraded when an earlier common pattern floods rg output', async () => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    const root = await makeImportHeavyProject();
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 100_000 }) },
    });
    const forward = await router.execute(
      searchRequest({ patterns: ['import', 'UniqueTargetSymbol'], contextLines: 0 })
    );
    const reversed = await router.execute(
      searchRequest({ patterns: ['UniqueTargetSymbol', 'import'], contextLines: 0 })
    );
    for (const result of [forward, reversed]) {
      expect(result.ok).toBe(true);
      expect(result.status).toBe('success');
      expect(result.diagnostics?.degraded).toBe(false);
      expect(result.diagnostics?.warnings ?? []).not.toContainEqual(
        expect.objectContaining({ code: 'code_search_incomplete' })
      );
      const data = result.structuredContent as SearchData;
      expect(data.incomplete).toBeUndefined();
      expect(data.shown).toBe(10);
      // 轮转取名额：常见词只占 9 个名额，目标符号一定出现；两种顺序的名额分配一致。
      expect(data.matches.filter((m) => m.file === 'target.ts')).toHaveLength(1);
      expect(data.matches.filter((m) => m.content.includes('import '))).toHaveLength(9);
      // import 收满 10 条即收尾（观察下界 10），目标符号 1 条。
      expect(data.total).toBe(11);
    }
    const solo = await router.execute(searchRequest({ patterns: ['import'], contextLines: 0 }));
    expect(solo.status).toBe('success');
    expect(solo.diagnostics?.degraded).toBe(false);
    expect(solo.structuredContent).toMatchObject({ total: 10, shown: 10 });
  });

  it('continues past a pattern whose output overflowed before enough hits and names it in the warning', async () => {
    await installFakeRg();
    const root = await mkdtemp(join(baseRoot, 'p13-overflow-'));
    const cache = new SearchCache();
    const set = vi.spyOn(cache, 'set');
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, searchCache: cache }),
      },
    });
    const result = await router.execute(
      searchRequest({ patterns: ['overflow-short', 'tail-hit'], contextLines: 0 })
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.diagnostics?.degraded).toBe(true);
    const data = result.structuredContent as SearchData;
    expect(data.incomplete).toBe(true);
    expect(data.matches).toEqual([
      { file: 'a.ts', line: 1, content: 'overflow-short one' },
      { file: 'b.ts', line: 2, content: 'tail-hit here' },
      { file: 'a.ts', line: 5, content: 'overflow-short two' },
      { file: 'a.ts', line: 9, content: 'overflow-short three' },
    ]);
    // 3 条观察到的命中 + tail-hit 的 matched_lines(1)，而不是子匹配计数 matches(7)。
    expect(data).toMatchObject({ total: 4, shown: 4 });
    const warning = (result.diagnostics?.warnings ?? []).find(
      (w) => w.code === 'code_search_incomplete'
    );
    expect(warning?.message).toContain('"overflow-short"');
    expect(warning?.message).toMatch(/exceeded/);
    expect(warning?.message).not.toContain('"tail-hit"');
    // 超限的 partial pattern 不进缓存；完整的 tail-hit 照常缓存。
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1]).toMatchObject({ total: 1 });
  });

  it('counts rg matched_lines rather than sub-match totals', async () => {
    await installFakeRg();
    const root = await mkdtemp(join(baseRoot, 'p13-counts-'));
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 8000 }) },
    });
    const result = await router.execute(
      searchRequest({ patterns: ['summary-counts'], contextLines: 0 })
    );
    expect(result.status).toBe('success');
    expect(result.structuredContent).toMatchObject({ total: 2, shown: 2 });
  });

  it('finishes as satisfied once maxResults hits are collected without waiting for rg to exit', async () => {
    await installFakeRg();
    const root = await mkdtemp(join(baseRoot, 'p13-satisfied-'));
    const cache = new SearchCache();
    const set = vi.spyOn(cache, 'set');
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, searchCache: cache }),
      },
    });
    const started = Date.now();
    const result = await router.execute(
      searchRequest({ patterns: ['satisfied-hang'], maxResults: 10, contextLines: 0 })
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.diagnostics?.degraded).toBe(false);
    const data = result.structuredContent as SearchData;
    expect(data.incomplete).toBeUndefined();
    expect(data).toMatchObject({ total: 10, shown: 10 });
    expect(data.matches.map((m) => m.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 请求已满足的结果与普通成功同样确定，可以缓存。
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('stops only for cancellation and lists the patterns it never searched', async () => {
    await installFakeRg();
    const root = await mkdtemp(join(baseRoot, 'p13-abort-'));
    const marker = join(root, 'printed.marker');
    vi.stubEnv('P13_MARKER', marker);
    const cache = new SearchCache();
    const set = vi.spyOn(cache, 'set');
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, searchCache: cache }),
      },
    });
    const controller = new AbortController();
    const pending = router.execute(
      searchRequest(
        { patterns: ['hang-after-hit', 'never-run', 'never-run-either'], contextLines: 0 },
        controller.signal
      )
    );
    // 替身进程启动后才写 marker；放宽等待上限，避免负载高时误判为未启动。
    await vi.waitFor(
      async () => {
        await stat(marker);
      },
      { timeout: 5000, interval: 25 }
    );
    controller.abort(new Error('fixture cancelled active rg'));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.status).toBe('aborted');
    const data = result.structuredContent as SearchData;
    expect(data.incomplete).toBe(true);
    expect(data.matches).toEqual([{ file: 'e.ts', line: 3, content: 'hang-after-hit' }]);
    const warning = (result.diagnostics?.warnings ?? []).find(
      (w) => w.code === 'code_search_incomplete'
    );
    expect(warning?.message).toContain('"hang-after-hit"');
    expect(warning?.message).toContain('"never-run"');
    expect(warning?.message).toContain('"never-run-either"');
    expect(set).not.toHaveBeenCalled();
  });
});

// ─── L4-P14 无 rg 时 code.search fallback 与 rg 语义对齐 ─────────────────────────────
// 来源：module-review-2026-10-01 I14（U14-F5）。fallback 曾把 glob 当扩展名列表（'src/**/*.ts' 变成
// 'src//.ts' 后只比文件名），路径型 glob 静默 0 命中且被当作完整结果；5000 文件上限只退出当前递归层
// 且不标 incomplete；子目录 readdir 失败让整个 fallback 失败、读文件失败静默跳过；忽略集与 rg 的
// --glob 不同（多跳过 Packages）且不读 .gitignore。这里用 PATH='' 制造 rg 缺席走真实 fallback/fs 路径，
// 同一夹具再交给真实 rg 对照，钉住宿主可见的命中集合、partial 状态与诊断。
type SearchEnvelope = Awaited<ReturnType<ToolRouterAdapter['execute']>>;

describe('L4-P14 code.search fallback semantics without ripgrep', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** 夹具：每个文件只有一行 needle；被忽略/隐藏/命中的文件分布覆盖 rg 的 override、.gitignore 与隐藏规则。 */
  async function makeGlobProject(options: { gitRepo: boolean }): Promise<string> {
    const root = await mkdtemp(join(baseRoot, 'p14-glob-'));
    if (options.gitRepo) {
      // rg 只在 git 仓库内应用 .gitignore；空的 .git 目录就足以让 rg 与 fallback 都认定为仓库。
      await mkdir(join(root, '.git'));
    }
    await writeFile(join(root, '.gitignore'), 'out/\ngenerated\n*.log\n!keep.log\n');
    const files = [
      'src/top.ts',
      'src/a/mid.ts',
      'src/a/b/deep.ts',
      'src/a/b/deep.js',
      'src/generated/g.ts',
      'lib/src/nested.ts',
      'root.ts',
      'out/gen.ts',
      'trace.log',
      'keep.log',
      'node_modules/x/m.ts',
      'Packages/Local/p.ts',
      '.hidden/h.ts',
    ];
    for (const file of files) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), 'needle\n');
    }
    return root;
  }

  async function searchNeedle(
    root: string,
    params: Record<string, unknown>,
    engine: 'fallback' | 'rg'
  ): Promise<SearchEnvelope> {
    vi.unstubAllEnvs();
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    if (engine === 'fallback') {
      vi.stubEnv('PATH', '');
    }
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 100_000 }) },
    });
    return router.execute(
      searchRequest({ patterns: ['needle'], maxResults: 50, contextLines: 0, ...params })
    );
  }

  function hitFiles(result: SearchEnvelope): string[] {
    const data = result.structuredContent as SearchData | null;
    return [...new Set((data?.matches ?? []).map((match) => match.file))].sort();
  }

  it.each([
    ['src/**/*.ts', ['src/a/b/deep.ts', 'src/a/mid.ts', 'src/top.ts']],
    [
      'src/**',
      ['src/a/b/deep.js', 'src/a/b/deep.ts', 'src/a/mid.ts', 'src/generated/g.ts', 'src/top.ts'],
    ],
    ['src/*.ts', ['src/top.ts']],
    ['/src/*.ts', ['src/top.ts']],
    ['**/src/*.ts', ['lib/src/nested.ts', 'src/top.ts']],
    [
      '*.ts',
      [
        'Packages/Local/p.ts',
        'lib/src/nested.ts',
        'root.ts',
        'src/a/b/deep.ts',
        'src/a/mid.ts',
        'src/top.ts',
      ],
    ],
    ['!*.ts', ['keep.log', 'src/a/b/deep.js']],
    ['*.log', ['keep.log', 'trace.log']],
    [
      undefined,
      [
        'Packages/Local/p.ts',
        'keep.log',
        'lib/src/nested.ts',
        'root.ts',
        'src/a/b/deep.js',
        'src/a/b/deep.ts',
        'src/a/mid.ts',
        'src/top.ts',
      ],
    ],
  ] as Array<
    [string | undefined, string[]]
  >)('matches glob %s like ripgrep when rg is absent', async (glob, expected) => {
    const root = await makeGlobProject({ gitRepo: true });
    const params = glob === undefined ? {} : { glob };
    const fallback = await searchNeedle(root, params, 'fallback');
    expect(fallback.ok).toBe(true);
    expect(fallback.status).toBe('success');
    expect(fallback.diagnostics?.fallbackUsed).toBe(true);
    expect(fallback.diagnostics?.degraded).toBe(false);
    expect(fallback.diagnostics?.warnings ?? []).toContainEqual(
      expect.objectContaining({ code: 'code_search_fallback' })
    );
    expect(hitFiles(fallback)).toEqual(expected);
    expect((fallback.structuredContent as SearchData).incomplete).toBeUndefined();

    // 同一夹具交给真实 rg 对照；环境没有 rg 时上面的显式期望已覆盖语义。
    const rg = await searchNeedle(root, params, 'rg');
    if (rg.diagnostics?.fallbackUsed !== true) {
      expect(hitFiles(rg)).toEqual(hitFiles(fallback));
    }
  });

  it('applies the project-root .gitignore only inside a git repository, as rg does', async () => {
    const outside = await makeGlobProject({ gitRepo: false });
    const fallback = await searchNeedle(outside, {}, 'fallback');
    expect(hitFiles(fallback)).toEqual([
      'Packages/Local/p.ts',
      'keep.log',
      'lib/src/nested.ts',
      'out/gen.ts',
      'root.ts',
      'src/a/b/deep.js',
      'src/a/b/deep.ts',
      'src/a/mid.ts',
      'src/generated/g.ts',
      'src/top.ts',
      'trace.log',
    ]);
    const rg = await searchNeedle(outside, {}, 'rg');
    if (rg.diagnostics?.fallbackUsed !== true) {
      expect(hitFiles(rg)).toEqual(hitFiles(fallback));
    }
    const inside = await makeGlobProject({ gitRepo: true });
    const ignored = hitFiles(await searchNeedle(inside, {}, 'fallback'));
    expect(ignored).not.toContain('out/gen.ts');
    expect(ignored).not.toContain('src/generated/g.ts');
    expect(ignored).not.toContain('trace.log');
    expect(ignored).toContain('keep.log');
  });

  it('stops at the global fallback file cap and reports the unsatisfied pattern as partial', async () => {
    const root = await mkdtemp(join(baseRoot, 'p14-cap-'));
    await writeFile(join(root, 'a-hit.ts'), 'needle first\n');
    await mkdir(join(root, 'bulk'));
    const names = Array.from({ length: 5001 }, (_, i) => `f${String(i).padStart(4, '0')}.ts`);
    for (let start = 0; start < names.length; start += 500) {
      await Promise.all(
        names
          .slice(start, start + 500)
          .map((name) => writeFile(join(root, 'bulk', name), 'filler\n'))
      );
    }
    // 排序遍历下这是最后一个候选文件，落在全局上限之外，不能被搜到。
    await writeFile(join(root, 'bulk', 'f5000.ts'), 'needle beyond the cap\n');
    vi.stubEnv('PATH', '');
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 100_000 }) },
    });

    const result = await router.execute(searchRequest({ patterns: ['needle'], contextLines: 0 }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.diagnostics?.degraded).toBe(true);
    expect(result.diagnostics?.fallbackUsed).toBe(true);
    const data = result.structuredContent as SearchData;
    expect(data.incomplete).toBe(true);
    expect(data.matches).toEqual([{ file: 'a-hit.ts', line: 1, content: 'needle first' }]);
    const warning = (result.diagnostics?.warnings ?? []).find(
      (w) => w.code === 'code_search_incomplete'
    );
    expect(warning?.message).toContain('fallback file cap');
    expect(warning?.message).toContain('"needle"');

    // 收满 maxResults 即请求已满足（与 rg 提前收尾同义）：上限之后的文件本就不会再读，不标 partial。
    const satisfied = await router.execute(
      searchRequest({ patterns: ['needle'], maxResults: 1, contextLines: 0 })
    );
    expect(satisfied.status).toBe('success');
    expect((satisfied.structuredContent as SearchData).incomplete).toBeUndefined();
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)(
    'counts unreadable subdirectories and files in a warning instead of failing or hiding them',
    async () => {
      const root = await mkdtemp(join(baseRoot, 'p14-unreadable-'));
      await mkdir(join(root, 'ok'));
      await mkdir(join(root, 'locked'));
      await writeFile(join(root, 'ok', 'a.ts'), 'needle visible\n');
      await writeFile(join(root, 'ok', 'secret.ts'), 'needle hidden by mode\n');
      await writeFile(join(root, 'locked', 'b.ts'), 'needle locked\n');
      await chmod(join(root, 'locked'), 0o000);
      await chmod(join(root, 'ok', 'secret.ts'), 0o000);
      try {
        vi.stubEnv('PATH', '');
        const router = new ToolRouterAdapter({
          contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 100_000 }) },
        });
        const result = await router.execute(
          searchRequest({ patterns: ['needle'], contextLines: 0 })
        );
        expect(result.ok).toBe(true);
        expect(result.status).toBe('partial');
        expect((result.structuredContent as SearchData).matches).toEqual([
          { file: 'ok/a.ts', line: 1, content: 'needle visible' },
        ]);
        const warnings = result.diagnostics?.warnings ?? [];
        const unreadable = warnings.find((w) => w.code === 'code_search_fallback_unreadable');
        expect(unreadable?.message).toContain('1 directory');
        expect(unreadable?.message).toContain('1 file');
        expect(unreadable?.message).toContain('locked');
        expect(unreadable?.message).toContain('ok/secret.ts');
        expect(warnings).toContainEqual(
          expect.objectContaining({ code: 'code_search_incomplete' })
        );
      } finally {
        await chmod(join(root, 'locked'), 0o755);
        await chmod(join(root, 'ok', 'secret.ts'), 0o644);
      }
    }
  );

  it.each([
    ['aborted', () => new Error('host stopped the fallback scan')],
    ['timeout', () => Object.assign(new Error('fallback deadline'), { name: 'TimeoutError' })],
  ] as Array<
    ['aborted' | 'timeout', () => Error]
  >)('classifies cancellation during the fallback scan as %s and stops walking', async (status, reason) => {
    const root = await mkdtemp(join(baseRoot, `p14-cancel-${status}-`));
    await mkdir(join(root, 'sub', 'deeper'), { recursive: true });
    await writeFile(join(root, 'a.ts'), 'needle a\n');
    await writeFile(join(root, 'sub', 'b.ts'), 'needle b\n');
    await writeFile(join(root, 'sub', 'deeper', 'c.ts'), 'needle c\n');
    const fsPromises = (await import('node:fs/promises')).default;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    const controller = new AbortController();
    const visited: string[] = [];
    // 只在遍历进入 sub 时触发取消，其余照常交给真实 readdir；断言遍历不会再进入更深的目录。
    const readdir = vi.spyOn(fsPromises, 'readdir').mockImplementation(((
      target: Parameters<typeof fsPromises.readdir>[0],
      options?: Parameters<typeof fsPromises.readdir>[1]
    ) => {
      const dir = String(target);
      visited.push(dir.slice(root.length) || '/');
      if (dir.endsWith('/sub')) {
        controller.abort(reason());
      }
      return originalReaddir(target, options);
    }) as typeof fsPromises.readdir);
    try {
      vi.stubEnv('PATH', '');
      const router = new ToolRouterAdapter({
        contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 100_000 }) },
      });
      const result = await router.execute(
        searchRequest({ patterns: ['needle', 'never-run'], contextLines: 0 }, controller.signal)
      );
      expect(result.status).toBe(status);
      expect(result.ok).toBe(false);
      expect(visited).toEqual(['/', '/sub']);
      const warning = (result.diagnostics?.warnings ?? []).find(
        (w) => w.code === 'code_search_incomplete'
      );
      expect(warning?.message).toContain('Search cancelled during the in-process fallback.');
      expect(warning?.message).toContain('"never-run"');
    } finally {
      readdir.mockRestore();
    }
  });

  it('rejects a glob shape the fallback cannot evaluate instead of reporting zero hits', async () => {
    const root = await makeGlobProject({ gitRepo: true });
    const result = await searchNeedle(root, { glob: 'src\\*.ts' }, 'fallback');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.text).toContain('cannot evaluate glob');
    expect(result.diagnostics?.fallbackUsed).toBe(true);
    expect(result.diagnostics?.warnings ?? []).toContainEqual(
      expect.objectContaining({ code: 'code_search_fallback_glob_unsupported' })
    );
  });
});

// ─── L3-P12 工具输出 token 上限统一为 shared 口径 ─────────────────────────────────
// 来源：module-review-2026-10-01 L3-C12（U09-F4）。kernel 的 estimateTokens 曾按 len/4 估算，
// 对 CJK 低估约一倍：maxOutputTokens=3000 的 action 能放过约 12000 个汉字（shared 口径约 6000
// token），_meta.tokensEstimate 与记忆层估算也对不上。Router 截断又按 UTF-16 码元切分，可能切断
// 代理对，截断说明本身也没有计入预算。这里经真实 ToolRouter.execute 钉住宿主可见行为：
// handler 用 spy 替身返回构造好的文本，只验证路由层的输出上限，不触达文件系统。
describe('L3-P12 tool output limit uses the shared token estimate', () => {
  /** Router 截断说明的固定格式；ActiveContext/EvidenceCollector 依赖同一格式识别截断。 */
  const NOTICE = /\n\n\.\.\. \[(\d+) chars truncated, exceeded (\d+) token limit\] \.\.\.\n\n/;
  /** 非 u 模式按码元匹配：未配对的高位或低位代理即为被切断的字符。 */
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runSearchWithOutput(text: string) {
    vi.spyOn(TOOL_REGISTRY.code.actions.search, 'handler').mockResolvedValue(
      okToolResult(text, { tokensEstimate: estimateToolTokens(text) })
    );
    return new ToolRouter().execute(
      { tool: 'code', action: 'search', params: { patterns: ['fixture'] } },
      baseToolContext()
    );
  }

  /** 拆出截断结果的头、尾和说明，并断言头尾分别是原文按字符的前缀与后缀。 */
  function splitTruncated(original: string, data: unknown) {
    expect(typeof data).toBe('string');
    const output = String(data);
    const match = NOTICE.exec(output);
    expect(match, 'router truncation notice').not.toBeNull();
    const notice = match?.[0] ?? '';
    const head = output.slice(0, match?.index ?? 0);
    const tail = output.slice((match?.index ?? 0) + notice.length);
    expect(original.startsWith(head)).toBe(true);
    expect(original.endsWith(tail)).toBe(true);
    const totalChars = Array.from(original).length;
    const keptChars = Array.from(head).length + Array.from(tail).length;
    return {
      output,
      head,
      tail,
      omitted: Number(match?.[1]),
      limit: Number(match?.[2]),
      totalChars,
      keptChars,
    };
  }

  it('estimates tool tokens with the shared CJK-aware rule', () => {
    const samples = [
      '',
      'plain ascii output',
      '汉'.repeat(12000),
      `mixed 中文 output ${'😀'.repeat(3)}`,
    ];
    for (const sample of samples) {
      expect(estimateToolTokens(sample), JSON.stringify(sample.slice(0, 20))).toBe(
        estimateSharedTokens(sample)
      );
    }
    expect(estimateToolTokens('汉'.repeat(12000))).toBe(6000);
  });

  it('truncates 12000 Chinese characters under code.search maxOutputTokens=3000', async () => {
    expect(TOOL_REGISTRY.code.actions.search.maxOutputTokens).toBe(3000);
    const logger = Logger.getInstance();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const text = '汉'.repeat(12000);
    const result = await runSearchWithOutput(text);
    expect(result.ok).toBe(true);
    const parts = splitTruncated(text, result.data);
    expect(parts.limit).toBe(3000);
    expect(parts.head.length).toBeGreaterThan(0);
    expect(parts.tail.length).toBeGreaterThan(0);
    expect(parts.omitted).toBe(parts.totalChars - parts.keptChars);
    expect(estimateSharedTokens(parts.output)).toBeLessThanOrEqual(3000);
    expect(result._meta?.tokensEstimate).toBe(estimateSharedTokens(parts.output));
    // 常规截断留 debug 诊断：只含计数，不含输出原文。
    const messages = debug.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('[ToolRouter]'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('tool=code.search');
    expect(messages[0]).toContain('reason=output_exceeds_limit');
    expect(messages[0]).toContain('originalTokens=6000');
    expect(messages[0]).toContain(`omittedChars=${parts.omitted}`);
    expect(messages[0]).not.toContain('汉');
  });

  it('never cuts a surrogate pair when an emoji-ending output is truncated', async () => {
    // 单个 ASCII 前缀让 emoji 代理对从奇数码元位置开始，按码元切头部必然留下孤立高位代理。
    const text = `a${'😀'.repeat(8000)}`;
    const result = await runSearchWithOutput(text);
    const parts = splitTruncated(text, result.data);
    expect(LONE_SURROGATE.test(parts.output)).toBe(false);
    expect(parts.output.endsWith('😀')).toBe(true);
    expect(parts.omitted).toBe(parts.totalChars - parts.keptChars);
    expect(estimateSharedTokens(parts.output)).toBeLessThanOrEqual(3000);
    expect(result._meta?.tokensEstimate).toBe(estimateSharedTokens(parts.output));
  });

  it('counts the truncation notice inside a small maxOutputTokens budget', async () => {
    const action = TOOL_REGISTRY.code.actions.search;
    const original = action.maxOutputTokens;
    try {
      // 100 token 时原先 80%/15% 头尾之外的 5% 余量装不下截断说明，说明必须从头尾预算里扣除。
      action.maxOutputTokens = 100;
      const text = 'x'.repeat(1000);
      const result = await runSearchWithOutput(text);
      const parts = splitTruncated(text, result.data);
      expect(parts.limit).toBe(100);
      expect(parts.head.length).toBeGreaterThan(0);
      expect(parts.omitted).toBe(parts.totalChars - parts.keptChars);
      expect(estimateSharedTokens(parts.output)).toBeLessThanOrEqual(100);
    } finally {
      action.maxOutputTokens = original;
    }
  });

  it('keeps the existing head and tail positions for ASCII output', async () => {
    // ASCII 在两种口径下都是每字 0.25 token；统一口径只应让 CJK 输出变短，ASCII 截断位置不变。
    const text = Array.from({ length: 20000 }, (_, index) =>
      String.fromCharCode(97 + (index % 26))
    ).join('');
    const result = await runSearchWithOutput(text);
    const parts = splitTruncated(text, result.data);
    expect(parts.head).toBe(text.slice(0, 9600));
    expect(parts.tail).toBe(text.slice(-1800));
    expect(parts.omitted).toBe(8600);
    expect(estimateSharedTokens(parts.output)).toBeLessThanOrEqual(3000);
  });

  it('reports a warning when the notice alone exceeds the configured limit', async () => {
    const action = TOOL_REGISTRY.code.actions.search;
    const original = action.maxOutputTokens;
    const logger = Logger.getInstance();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      action.maxOutputTokens = 5;
      const text = 'y'.repeat(400);
      const result = await runSearchWithOutput(text);
      const parts = splitTruncated(text, result.data);
      // 说明本身已超限：不再附带任何原文片段，只留可被下游识别的截断说明。
      expect(parts.head).toBe('');
      expect(parts.tail).toBe('');
      expect(parts.omitted).toBe(400);
      expect(result._meta?.tokensEstimate).toBe(estimateSharedTokens(parts.output));
      const messages = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('[ToolRouter]'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('tool=code.search');
      expect(messages[0]).toContain('reason=notice_exceeds_limit');
      expect(messages[0]).toContain('maxOutputTokens=5');
      expect(messages[0]).not.toContain('yyyy');
    } finally {
      action.maxOutputTokens = original;
    }
  });
});

// ─── L3-P12 返工：batch code.read 单文件截断与 shared 口径对齐 ─────────────────────────
// 复查阻塞（L3-C12 返工）：kernel estimateTokens 改为 shared 口径后，clampReadResult 仍按
// 4 字符/token 的 UTF-16 码元切头尾。CJK 文件字符数落在单文件预算 B 的 2B~3.8B 之间时，shared
// 估算超过 B 触发截断，但 floor(3.2B) + floor(0.6B) 码元的头尾超过全文而重叠：省略数为负
// （EvidenceCollector 的 \d+ 标记正则不匹配）、内容反而变长并重复尾部。这里经真实
// ToolRouter.execute + 磁盘夹具钉住：头尾按 Unicode 字符互不重叠、省略数 ≥ 1、说明计入预算、
// 不切断代理对，且证据采集仍只取逐字前缀。
describe('L3-P12 batch code.read clamp uses the shared token estimate', () => {
  /** batch clamp 说明的固定格式；EvidenceCollector 的 READ_CLAMP_MARKER_RE 依赖它识别截断。 */
  const BATCH_NOTICE = /\n\n\.\.\. \[(\d+) chars truncated for batch read budget\] \.\.\.\n\n/;
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  interface BatchFile {
    ok: boolean;
    path: string;
    content?: string;
    tokensEstimate?: number;
    truncated?: boolean;
    originalTokensEstimate?: number;
  }
  interface BatchData {
    mode: 'batch';
    files: BatchFile[];
    summary: { perFileTokenBudget: number };
  }

  /** 两文件 batch：tokenBudget=5000 → 单文件预算 floor((5000-250)/2)=2375。 */
  async function batchRead(name: string, source: string) {
    const root = await mkdtemp(join(baseRoot, `l3p12-batch-${name}-`));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/big.ts'), source);
    await writeFile(join(root, 'src/small.ts'), 'export const small = 1;\n');
    const result = await new ToolRouter().execute(
      { tool: 'code', action: 'read', params: { filePaths: ['src/big.ts', 'src/small.ts'] } },
      { projectRoot: root, tokenBudget: 5000 }
    );
    expect(result.ok).toBe(true);
    const data = result.data as BatchData;
    const big = data.files.find((file) => file.path === 'src/big.ts');
    expect(big?.ok).toBe(true);
    return { result, data, big: big as BatchFile };
  }

  /** code.read 全文模式的展示态：每行带 `N|` 行号前缀。 */
  function numbered(source: string): string {
    return source
      .split('\n')
      .map((line, index) => `${index + 1}|${line}`)
      .join('\n');
  }

  function splitClamped(original: string, content: string) {
    const match = BATCH_NOTICE.exec(content);
    expect(match, 'batch clamp notice with a non-negative omitted count').not.toBeNull();
    const head = content.slice(0, match?.index ?? 0);
    const tail = content.slice((match?.index ?? 0) + (match?.[0].length ?? 0));
    expect(original.startsWith(head)).toBe(true);
    expect(original.endsWith(tail)).toBe(true);
    const totalChars = Array.from(original).length;
    const keptChars = Array.from(head).length + Array.from(tail).length;
    return { head, tail, omitted: Number(match?.[1]), totalChars, keptChars };
  }

  it('clamps a mostly-CJK file between 2B and 3.8B chars without overlapping head and tail', async () => {
    // 100 行 × (3 字符注释头 + 60 汉字)：约 6400 字符、shared 估算约 3100 token，落在
    // 单文件预算 2375 的 2B~3.8B 区间；旧码元切法在这里头尾重叠、说明的省略数为负。
    const source = Array.from({ length: 100 }, () => `// ${'汉字测试'.repeat(15)}`).join('\n');
    const display = numbered(source);
    expect(estimateSharedTokens(display)).toBeGreaterThan(2375);
    expect(Array.from(display).length).toBeLessThan(2375 * 3.8);
    const logger = Logger.getInstance();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    try {
      const { data, big } = await batchRead('cjk', source);
      expect(data.summary.perFileTokenBudget).toBe(2375);
      expect(big.truncated).toBe(true);
      const content = big.content ?? '';
      const parts = splitClamped(display, content);
      expect(parts.omitted).toBeGreaterThanOrEqual(1);
      expect(parts.omitted).toBe(parts.totalChars - parts.keptChars);
      expect(parts.head.length).toBeGreaterThan(0);
      expect(parts.tail.length).toBeGreaterThan(0);
      expect(content.length).toBeLessThan(display.length);
      // 说明计入单文件预算，tokensEstimate 与原始估算都使用 shared 口径。
      expect(estimateSharedTokens(content)).toBeLessThanOrEqual(2375);
      expect(big.tokensEstimate).toBe(estimateSharedTokens(content));
      expect(big.originalTokensEstimate).toBe(estimateSharedTokens(display));
      // 截断诊断只含计数与相对路径，不含原文。
      const messages = debug.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('[code.read]') && message.includes('batch_clamp'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('path=src/big.ts');
      expect(messages[0]).toContain(`omittedChars=${parts.omitted}`);
      expect(messages[0]).not.toContain('汉');

      // 证据采集仍识别截断：只保留源文件逐字前缀，不把说明或不连续的尾部当作源码。
      const collector = new EvidenceCollector();
      collector.processToolCall({
        tool: 'code',
        args: { action: 'read', filePaths: ['src/big.ts', 'src/small.ts'] },
        result: data,
      });
      const snippet = collector.build().evidenceMap.get('src/big.ts')?.codeSnippets[0];
      expect(snippet).toBeDefined();
      expect(snippet?.content).not.toContain('truncated');
      expect(source.startsWith(snippet?.content ?? '__missing__')).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  it('never cuts a surrogate pair when an emoji file is clamped', async () => {
    // 行首 ASCII 让 emoji 代理对落在奇偶交错的码元位置，按码元切头尾必然留下孤立代理。
    const source = Array.from(
      { length: 300 },
      (_, index) => `${'a'.repeat(index % 2)}${'😀'.repeat(60)}`
    ).join('\n');
    const display = numbered(source);
    const { big } = await batchRead('emoji', source);
    expect(big.truncated).toBe(true);
    const content = big.content ?? '';
    const parts = splitClamped(display, content);
    expect(LONE_SURROGATE.test(content)).toBe(false);
    expect(content.endsWith('😀')).toBe(true);
    expect(parts.omitted).toBe(parts.totalChars - parts.keptChars);
    expect(estimateSharedTokens(content)).toBeLessThanOrEqual(2375);
    expect(big.tokensEstimate).toBe(estimateSharedTokens(content));
  });

  it('leaves a CJK file within the per-file budget untouched', async () => {
    // 约 4400 字符、shared 估算约 2100 token：未超单文件预算，不截断、不打截断诊断。
    const source = Array.from({ length: 70 }, () => `// ${'汉字测试'.repeat(15)}`).join('\n');
    const display = numbered(source);
    expect(estimateSharedTokens(display)).toBeLessThanOrEqual(2375);
    const { big } = await batchRead('fits', source);
    expect(big.truncated).toBeUndefined();
    expect(big.content).toBe(display);
    expect(big.tokensEstimate).toBe(estimateSharedTokens(display));
  });
});

// ─── L4-P04 路由与参数层诊断补齐 ─────────────────────────────────────────────────────
// 来源：module-review-2026-10-01 L4 I02（U12-F4、U12-F7、U11-F3）。路由截断、handler 崩溃、
// 宿主上下文失败与参数 schema 编译失败原先在信封上没有诊断码，与完整成功或业务失败无法区分；
// schema 编译失败还被归为模型参数错误（TOOL_CALL_INVALID）。决策 P04：截断标 degraded +
// tool_output_truncated，status 只在 handler 未给 resultStatus 时置 partial；崩溃标
// tool_handler_threw；宿主 create/getAvailability 失败标 tool_host_context_failed(stage)；
// schema 编译失败保留 Ajv 原因、记录一次 tool_parameter_schema_invalid 并映射为 TOOL_UNAVAILABLE。
describe('L4-P04 router and parameter diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runtimeRequest(
    toolId: string,
    action: string,
    params: Record<string, unknown>
  ): ToolCallRequest {
    return {
      toolId,
      args: { action, params },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'vitest' },
    };
  }

  function warningCodes(warnings: ReadonlyArray<{ code: string }> | undefined): string[] {
    return (warnings ?? []).map((warning) => warning.code);
  }

  function loggedLines(spy: { mock: { calls: unknown[][] } }, needle: string): string[] {
    return spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(needle));
  }

  /** 约 4000 token 的 ASCII 输出，超过 code.outline 的 maxOutputTokens=2000。 */
  const OVERSIZED = 'o'.repeat(16000);

  it('marks a router-truncated string result as degraded partial with tool_output_truncated', async () => {
    expect(TOOL_REGISTRY.code.actions.outline.maxOutputTokens).toBe(2000);
    vi.spyOn(TOOL_REGISTRY.code.actions.outline, 'handler').mockResolvedValue(
      okToolResult(OVERSIZED, { tokensEstimate: estimateToolTokens(OVERSIZED) })
    );
    const result = await new ToolRouter().execute(
      { tool: 'code', action: 'outline', params: { path: 'fixture.ts' } },
      baseToolContext()
    );
    expect(result.ok).toBe(true);
    expect(result._meta?.degraded).toBe(true);
    expect(result._meta?.resultStatus).toBe('partial');
    const warnings = result._meta?.diagnosticWarnings ?? [];
    expect(warningCodes(warnings)).toEqual(['tool_output_truncated']);
    expect(warnings[0]).toMatchObject({ stage: 'code.outline', tool: 'code' });
    expect(warnings[0].message).toContain('2000');
    // 诊断只含计数，不复制输出原文。
    expect(warnings[0].message).not.toContain('oooo');
  });

  it('creates result meta for a handler that returned none before truncating', async () => {
    vi.spyOn(TOOL_REGISTRY.code.actions.outline, 'handler').mockResolvedValue({
      ok: true,
      data: OVERSIZED,
    });
    const result = await new ToolRouter().execute(
      { tool: 'code', action: 'outline', params: { path: 'fixture.ts' } },
      baseToolContext()
    );
    expect(result._meta).toMatchObject({
      cached: false,
      degraded: true,
      resultStatus: 'partial',
      durationMs: expect.any(Number),
      tokensEstimate: estimateSharedTokens(String(result.data)),
    });
    expect(warningCodes(result._meta?.diagnosticWarnings)).toEqual(['tool_output_truncated']);
  });

  it('leaves an output within the limit undegraded and warning-free', async () => {
    vi.spyOn(TOOL_REGISTRY.code.actions.outline, 'handler').mockResolvedValue(
      okToolResult('short outline', { tokensEstimate: 4 })
    );
    const result = await new ToolRouter().execute(
      { tool: 'code', action: 'outline', params: { path: 'fixture.ts' } },
      baseToolContext()
    );
    expect(result.data).toBe('short outline');
    expect(result._meta?.degraded).toBeUndefined();
    expect(result._meta?.resultStatus).toBeUndefined();
    expect(result._meta?.diagnosticWarnings).toBeUndefined();
  });

  it('does not repeat the code.read partial-view warning when the router truncates', async () => {
    const partialView = {
      code: 'code_read_partial_view',
      message: 'fixture partial view',
      tool: 'code',
    };
    vi.spyOn(TOOL_REGISTRY.code.actions.read, 'handler').mockResolvedValue(
      okToolResult('r'.repeat(40000), { diagnosticWarnings: [partialView] })
    );
    const result = await new ToolRouter().execute(
      { tool: 'code', action: 'read', params: { path: 'fixture.ts' } },
      baseToolContext()
    );
    expect(result._meta?.degraded).toBe(true);
    expect(result._meta?.resultStatus).toBe('partial');
    expect(warningCodes(result._meta?.diagnosticWarnings)).toEqual(['code_read_partial_view']);
  });

  it.each([
    { exitCode: 0, status: 'partial' },
    { exitCode: 1, status: 'error' },
  ])('flags a truncated terminal exec (exit $exitCode) on the envelope as $status', async ({
    exitCode,
    status,
  }) => {
    // 约 7000 token 的终端输出，超过 terminal.exec 的 maxOutputTokens=4000。
    const stdout = 'line of failing test output\n'.repeat(1000);
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          ...baseToolContext(),
          sandboxExecutor: { exec: async () => ({ stdout, stderr: '', exitCode }) },
        }),
      },
    });
    const envelope = await adapter.execute(
      runtimeRequest('terminal', 'exec', { command: 'npm test' })
    );
    expect(envelope.ok).toBe(true);
    // 非零退出码的 error 不能被截断覆盖成 partial；零退出码未声明状态时才降为 partial。
    expect(envelope.status).toBe(status);
    expect(envelope.diagnostics?.degraded).toBe(true);
    expect(warningCodes(envelope.diagnostics?.warnings)).toContain('tool_output_truncated');
  });

  it('tags a handler crash with tool_handler_threw on the router result and the envelope', async () => {
    const logger = Logger.getInstance();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.spyOn(TOOL_REGISTRY.meta.actions.review, 'handler').mockRejectedValue(
      new TypeError('fixture handler crashed')
    );
    const result = await new ToolRouter().execute(
      { tool: 'meta', action: 'review', params: {} },
      baseToolContext()
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fixture handler crashed');
    expect(result._meta?.diagnosticWarnings).toEqual([
      expect.objectContaining({ code: 'tool_handler_threw', stage: 'meta.review', tool: 'meta' }),
    ]);
    expect(result._meta?.diagnosticWarnings?.[0].message).toContain('TypeError');

    const adapter = new ToolRouterAdapter({ contextFactory: { create: () => baseToolContext() } });
    const envelope = await adapter.execute(runtimeRequest('meta', 'review', {}));
    expect(envelope.status).toBe('error');
    expect(warningCodes(envelope.diagnostics?.warnings)).toEqual(['tool_handler_threw']);
    expect(loggedLines(warn, 'tool_handler_threw')).toHaveLength(2);
  });

  it('keeps a business failure returned by the handler free of crash diagnostics', async () => {
    vi.spyOn(TOOL_REGISTRY.meta.actions.review, 'handler').mockResolvedValue(
      failToolResult('fixture review not found')
    );
    const adapter = new ToolRouterAdapter({ contextFactory: { create: () => baseToolContext() } });
    const envelope = await adapter.execute(runtimeRequest('meta', 'review', {}));
    expect(envelope.status).toBe('error');
    expect(envelope.text).toBe('fixture review not found');
    expect(envelope.diagnostics?.warnings).toEqual([]);
  });

  it.each<{ stage: string; contextFactory: ToolContextFactoryContract }>([
    {
      stage: 'context',
      contextFactory: {
        create: () => {
          throw new Error('fixture scope allocation failed');
        },
      },
    },
    {
      stage: 'availability',
      contextFactory: {
        create: () => baseToolContext(),
        getAvailability: () => {
          throw new Error('fixture availability lookup failed');
        },
      },
    },
  ])('tags a host $stage failure with tool_host_context_failed', async ({
    stage,
    contextFactory,
  }) => {
    const logger = Logger.getInstance();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const handler = vi.spyOn(TOOL_REGISTRY.meta.actions.review, 'handler');
    const envelope = await new ToolRouterAdapter({ contextFactory }).execute(
      runtimeRequest('meta', 'review', {})
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe('error');
    expect(envelope.text).toContain('fixture');
    expect(envelope.diagnostics?.warnings).toEqual([
      expect.objectContaining({ code: 'tool_host_context_failed', stage, tool: 'meta' }),
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(loggedLines(warn, 'tool_host_context_failed')).toHaveLength(1);
  });

  it('tags an availability re-read failure after scheduling as a host context failure', async () => {
    let lookups = 0;
    const handler = vi.spyOn(TOOL_REGISTRY.meta.actions.review, 'handler');
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => baseToolContext(),
        getAvailability: () => {
          lookups += 1;
          // 首次查询（准入）成功；获得 slot 后的重读失败，必须归为宿主上下文失败而非 handler 崩溃。
          if (lookups > 1) {
            throw new Error('fixture availability withdrawn');
          }
          return { actions: {} };
        },
      },
    });
    const envelope = await adapter.execute(runtimeRequest('meta', 'review', {}));
    expect(lookups).toBe(2);
    expect(envelope.status).toBe('error');
    expect(envelope.diagnostics?.warnings).toEqual([
      expect.objectContaining({ code: 'tool_host_context_failed', stage: 'availability' }),
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports an uncompilable parameter schema as TOOL_UNAVAILABLE with the Ajv detail, logged once', async () => {
    const saveAction = TOOL_REGISTRY.memory.actions.save;
    const original = saveAction.params;
    const logger = Logger.getInstance();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const save = vi.fn();
    const handler = vi.spyOn(saveAction, 'handler');
    const params = { key: 'fixture', content: 'finding' };
    try {
      const broken = structuredClone(original);
      (broken.properties as Record<string, Record<string, unknown>>).key.format = 'uri';
      saveAction.params = broken;
      const router = new ToolRouter();
      const call = { tool: 'memory', action: 'save', params };
      expect(router.explain(call)).toMatchObject({
        allowed: false,
        stage: 'execute',
        resultStatus: 'blocked',
      });
      const result = await router.execute(call, { ...baseToolContext(), sessionStore: { save } });
      expect(result).toMatchObject({
        ok: false,
        data: { code: 'TOOL_UNAVAILABLE', status: 'blocked', writeState: 'not-started' },
      });
      expect(result.error).toContain('Invalid tool parameter schema for memory.save');
      expect(result.error).toContain('unknown format "uri"');

      const adapter = new ToolRouterAdapter({
        contextFactory: { create: () => ({ ...baseToolContext(), sessionStore: { save } }) },
      });
      const envelope = await adapter.execute(runtimeRequest('memory', 'save', params));
      expect(envelope.status).toBe('blocked');
      expect(envelope.structuredContent).toMatchObject({ code: 'TOOL_UNAVAILABLE' });
      expect(envelope.diagnostics?.blockedTools).toEqual([
        expect.objectContaining({ tool: 'memory' }),
      ]);
      expect(save).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      // 失败结果进入缓存：同一 schema 的多次准入只编译、只记录一次。
      const logged = loggedLines(warn, 'tool_parameter_schema_invalid');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('memory.save');
      expect(logged[0]).toContain('unknown format "uri"');
    } finally {
      saveAction.params = original;
    }
  });

  it('treats an asynchronous parameter schema as a registry defect rather than a model error', () => {
    const saveAction = TOOL_REGISTRY.memory.actions.save;
    const original = saveAction.params;
    const logger = Logger.getInstance();
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      saveAction.params = { ...structuredClone(original), $async: true };
      expect(
        new ToolRouter().explain({
          tool: 'memory',
          action: 'save',
          params: { key: 'fixture', content: 'finding' },
        })
      ).toMatchObject({
        allowed: false,
        stage: 'execute',
        resultStatus: 'blocked',
        reason: expect.stringContaining('Asynchronous tool parameter schemas are unsupported'),
      });
    } finally {
      saveAction.params = original;
    }
  });

  it('compiles every registered action schema in base and dimension-submit variants', () => {
    const logger = Logger.getInstance();
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const failures: string[] = [];
    let checked = 0;
    for (const [tool, spec] of Object.entries(TOOL_REGISTRY)) {
      for (const [action, definition] of Object.entries(spec.actions)) {
        for (const variant of ['base', 'dimension-submit'] as const) {
          checked += 1;
          const error = toolParameterSchemaError(definition.params, variant);
          if (error !== null) {
            failures.push(`${tool}.${action} [${variant}]: ${error}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(failures).toEqual([]);
    // 守护本身必须能识别坏 schema，否则空失败列表没有意义。
    expect(
      toolParameterSchemaError(
        { type: 'object', properties: { url: { type: 'string', format: 'uri' } } },
        'base'
      )
    ).toContain('unknown format "uri"');
  });
});

describe('memory handler degraded diagnostics and finding rounds (L4-P21)', () => {
  afterEach(() => vi.restoreAllMocks());

  const QUERY = 'AuthService boundary';

  function previousEvidence(memoryCoordinator?: MemoryCoordinatorLike): Promise<ToolResult> {
    return new ToolRouter().execute(
      { tool: 'memory', action: 'get_previous_evidence', params: { query: QUERY, dimId: 'api' } },
      { ...baseToolContext(), ...(memoryCoordinator ? { memoryCoordinator } : {}) }
    );
  }

  function codesOf(result: ToolResult): string[] {
    return (result._meta?.diagnosticWarnings ?? []).map((warning) => warning.code);
  }

  function messageOf(result: ToolResult): string {
    return String((result.data as { message?: unknown }).message);
  }

  function sessionStoreWith(searchEvidence: SessionStore['searchEvidence']): SessionStore {
    // 只替身 searchEvidenceWithDiagnostics 实际读取的方法；其余 SessionStore 能力本用例不触达。
    return { searchEvidence } as unknown as SessionStore;
  }

  function fileLedger(): EvidenceLedgerLike {
    const entry = {
      id: 'E-1',
      file: 'src/auth/AuthService.ts',
      content: 'export class AuthService {}',
    };
    return {
      get: (ref) => (ref === 'E-1' ? entry : null),
      search: () => [entry],
      listRecent: () => [entry],
      stats: () => ({ entries: 1, distinctFiles: 1 }),
      checkFreshness: () => 'unknown',
    };
  }

  function recordingCoordinator() {
    const noteFinding = vi.fn<MemoryCoordinatorLike['noteFinding']>(() => ({
      recorded: true,
      target: 'activeContext',
      importance: 5,
      message: 'recorded',
    }));
    return { noteFinding };
  }

  it('reports a run without a SessionStore as degraded MEMORY_EVIDENCE_STORE_MISSING, not as "no previous evidence"', async () => {
    const result = await previousEvidence(new MemoryCoordinator());

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ count: 0, items: [] });
    expect(result._meta?.degraded).toBe(true);
    expect(codesOf(result)).toEqual(['MEMORY_EVIDENCE_STORE_MISSING']);
    expect(result._meta?.diagnosticWarnings?.[0]).toMatchObject({
      tool: 'memory',
      stage: 'memory.get_previous_evidence',
    });
    expect(messageOf(result)).toContain(QUERY);
    expect(messageOf(result)).toContain('没有前序证据存储');
    expect(messageOf(result)).not.toContain('没有找到');
  });

  it('reports a failing evidence search as degraded MEMORY_EVIDENCE_SEARCH_FAILED with the original detail', async () => {
    const logger = Logger.getInstance();
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const coordinator = new MemoryCoordinator({
      sessionStore: sessionStoreWith(() => {
        throw new Error('fixture evidence index exploded');
      }),
    });

    const result = await previousEvidence(coordinator);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ count: 0, items: [] });
    expect(result._meta?.degraded).toBe(true);
    expect(codesOf(result)).toEqual(['MEMORY_EVIDENCE_SEARCH_FAILED']);
    expect(result._meta?.diagnosticWarnings?.[0]?.message).toContain(
      'fixture evidence index exploded'
    );
    expect(messageOf(result)).toContain('检索失败');
    expect(messageOf(result)).not.toContain('没有找到');
  });

  it.each([
    ['no MemoryCoordinator', undefined],
    ['a MemoryCoordinator without evidence search', recordingCoordinator()],
  ])('reports %s as degraded MEMORY_EVIDENCE_COORDINATOR_MISSING', async (_label, coordinator) => {
    const result = await previousEvidence(coordinator);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ count: 0, items: [] });
    expect(result._meta?.degraded).toBe(true);
    expect(codesOf(result)).toEqual(['MEMORY_EVIDENCE_COORDINATOR_MISSING']);
    expect(messageOf(result)).toContain(QUERY);
    expect(messageOf(result)).not.toContain('没有找到');
  });

  it('keeps a real empty search and real hits undegraded on both coordinator shapes', async () => {
    const hit = {
      filePath: 'src/auth/AuthService.ts',
      evidence: { dimId: 'api', importance: 8, finding: 'AuthService owns the token boundary' },
    };
    const empty = await previousEvidence(
      new MemoryCoordinator({ sessionStore: sessionStoreWith(() => []) })
    );
    expect(empty.ok).toBe(true);
    expect(empty._meta?.degraded).not.toBe(true);
    expect(codesOf(empty)).toEqual([]);
    expect(messageOf(empty)).toContain('没有找到');

    const searchEvidence = vi.fn(() => [hit]);
    const found = await previousEvidence(
      new MemoryCoordinator({ sessionStore: sessionStoreWith(searchEvidence) })
    );
    expect(searchEvidence).toHaveBeenCalledWith(QUERY, 'api');
    expect(found._meta?.degraded).not.toBe(true);
    expect(found.data).toMatchObject({ count: 1 });
    expect(String((found.data as { summary?: unknown }).summary)).toContain(hit.filePath);

    // 只实现旧 searchEvidence 的宿主替身保持原行为：不臆造降级。
    const legacy = await previousEvidence({
      ...recordingCoordinator(),
      searchEvidence: () => [hit],
    });
    expect(legacy._meta?.degraded).not.toBe(true);
    expect(legacy.data).toMatchObject({ count: 1 });
  });

  it('normalizes host-shaped diagnostic searches without hiding degradation', async () => {
    const hit = {
      filePath: 'src/auth/AuthService.ts',
      evidence: { finding: 'AuthService owns the token boundary' },
    };
    const hostCoordinator = (search: () => unknown): MemoryCoordinatorLike => ({
      ...recordingCoordinator(),
      // 宿主返回值未必符合端口类型；这里故意绕过类型来模拟宿主越界输出。
      searchEvidenceWithDiagnostics: search as NonNullable<
        MemoryCoordinatorLike['searchEvidenceWithDiagnostics']
      >,
      // 有诊断版时不得回落旧 searchEvidence；被调用即说明分叉选错。
      searchEvidence: () => {
        throw new Error('legacy searchEvidence must not be used');
      },
    });

    const malformed = await previousEvidence(hostCoordinator(() => ({ ok: true })));
    expect(malformed.ok).toBe(true);
    expect(malformed._meta?.degraded).toBe(true);
    expect(codesOf(malformed)).toEqual(['MEMORY_EVIDENCE_SEARCH_FAILED']);
    expect(malformed._meta?.diagnosticWarnings?.[0]?.message).toContain('malformed');

    const silentStoreMissing = await previousEvidence(
      hostCoordinator(() => ({
        ok: true,
        degraded: true,
        reason: 'session-store-missing',
        results: [],
        diagnostics: [],
      }))
    );
    expect(silentStoreMissing._meta?.degraded).toBe(true);
    expect(codesOf(silentStoreMissing)).toEqual(['MEMORY_EVIDENCE_STORE_MISSING']);
    expect(messageOf(silentStoreMissing)).toContain('没有前序证据存储');

    const partial = await previousEvidence(
      hostCoordinator(() => ({
        ok: false,
        degraded: true,
        reason: 'host-index-partial',
        results: [hit],
        diagnostics: [{ code: 'HOST_EVIDENCE_INDEX_PARTIAL', message: 'shard 2 offline' }],
      }))
    );
    expect(partial.ok).toBe(true);
    expect(partial.data).toMatchObject({ count: 1 });
    expect(String((partial.data as { summary?: unknown }).summary)).toContain(hit.filePath);
    expect(String((partial.data as { summary?: unknown }).summary)).toContain('降级');
    expect(partial._meta?.degraded).toBe(true);
    expect(codesOf(partial)).toEqual(['HOST_EVIDENCE_INDEX_PARTIAL']);
    expect(partial._meta?.diagnosticWarnings?.[0]?.message).toContain('shard 2 offline');
  });

  it('lifts the evidence-store degradation onto the adapter envelope diagnostics', async () => {
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ ...baseToolContext(), memoryCoordinator: new MemoryCoordinator() }),
      },
    });
    const envelope = await adapter.execute({
      toolId: 'memory',
      args: { action: 'get_previous_evidence', params: { query: QUERY } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'vitest' },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.diagnostics?.degraded).toBe(true);
    expect((envelope.diagnostics?.warnings ?? []).map((warning) => warning.code)).toContain(
      'MEMORY_EVIDENCE_STORE_MISSING'
    );
  });

  it('marks note_finding without an evidence ledger as degraded MEMORY_FINDING_UNVERIFIED_NO_LEDGER', async () => {
    const coordinator = recordingCoordinator();
    const params = { finding: 'AuthService owns tokens', evidenceRefs: ['E-1'] };
    const router = new ToolRouter();

    const unledgered = await router.execute(
      { tool: 'memory', action: 'note_finding', params },
      { ...baseToolContext(), memoryCoordinator: coordinator }
    );
    expect(unledgered.ok).toBe(true);
    expect(unledgered.data).toMatchObject({ recorded: true, target: 'activeContext' });
    // 无台账运行保持 verified 缺省（不参与核实判定），降级只出现在诊断上。
    expect(unledgered.data).not.toHaveProperty('verified');
    expect(unledgered._meta?.degraded).toBe(true);
    expect(codesOf(unledgered)).toEqual(['MEMORY_FINDING_UNVERIFIED_NO_LEDGER']);
    expect(unledgered._meta?.diagnosticWarnings?.[0]).toMatchObject({
      tool: 'memory',
      stage: 'memory.note_finding',
    });

    const ledgered = await router.execute(
      { tool: 'memory', action: 'note_finding', params },
      {
        ...baseToolContext(),
        memoryCoordinator: coordinator,
        runtime: { evidenceLedger: fileLedger() },
      }
    );
    expect(ledgered.ok).toBe(true);
    expect(ledgered.data).toMatchObject({ verified: true });
    expect(ledgered._meta?.degraded).not.toBe(true);
    expect(codesOf(ledgered)).toEqual([]);
  });

  it('records the runtime loop iteration as the finding round and ignores a model-supplied round', async () => {
    const coordinator = recordingCoordinator();
    const params = { finding: 'AuthService owns tokens', evidenceRefs: ['E-1'], round: 99 };

    await handleMemory('note_finding', params, {
      ...baseToolContext(),
      memoryCoordinator: coordinator,
      runtime: { iteration: 7, evidenceLedger: fileLedger() },
    });
    expect(coordinator.noteFinding.mock.calls[0]?.[3]).toBe(7);

    // 非 runtime 表面（无 loop 轮次）记 0，模型自填的 round 不再被采信。
    await handleMemory('note_finding', params, {
      ...baseToolContext(),
      memoryCoordinator: coordinator,
    });
    expect(coordinator.noteFinding.mock.calls[1]?.[3]).toBe(0);
  });
});

describe('L4-P16 code.write protected path segments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type ProtectedWriteMeta = {
    resultStatus?: string;
    diagnosticWarnings?: Array<{ code: string; message: string; stage?: string; tool?: string }>;
  };

  const writeCall = (target: string, content = 'overwritten') => ({
    tool: 'code',
    action: 'write',
    params: { path: target, content, createDirectories: true },
  });

  // 任一段（大小写不敏感）命中 .git / node_modules / .env 族都必须拒绝，且拒绝前不写盘。
  it.each([
    { target: '.env', rule: 'env-file' },
    { target: '.env.local', rule: 'env-file' },
    { target: '.ENV.Production.Local', rule: 'env-file' },
    { target: 'packages/x/.env', rule: 'env-file' },
    { target: 'packages/x/node_modules/a.js', rule: 'dependency-directory' },
    { target: 'Node_Modules/pkg/index.js', rule: 'dependency-directory' },
    { target: 'packages/x/.git/HEAD', rule: 'git-metadata' },
    { target: '.GIT/config', rule: 'git-metadata', seed: '.git/config' },
  ])('denies $target by segment rule $rule with a diagnostic', async ({ target, rule, seed }) => {
    await withWriteFixture(async (root) => {
      if (seed) {
        await mkdir(join(root, seed, '..'), { recursive: true });
        await writeFile(join(root, seed), 'protected');
      }
      const logger = Logger.getInstance();
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const result = await new ToolRouter().execute(writeCall(target), freshnessCtx(root));

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Write denied');
      expect(result.error).toContain('protected path');
      expect(result.error).toContain(rule);
      const meta = result._meta as ProtectedWriteMeta | undefined;
      expect(meta?.resultStatus).toBe('blocked');
      expect(meta?.diagnosticWarnings).toHaveLength(1);
      expect(meta?.diagnosticWarnings?.[0]).toMatchObject({
        code: 'code_write_protected_path',
        stage: 'code.write',
        tool: 'code',
      });
      expect(meta?.diagnosticWarnings?.[0]?.message).toContain(`path=${target}`);
      expect(meta?.diagnosticWarnings?.[0]?.message).toContain(`rule=${rule}`);
      const logs = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('[code.write]'));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`path=${target}`);
      expect(logs[0]).toContain(`rule=${rule}`);
      expect(logs[0]).toContain('result=denied');
      // 不记录待写内容。
      expect(logs[0]).not.toContain('overwritten');

      if (seed) {
        // macOS 大小写不敏感：.GIT/config 与 .git/config 是同一文件，原内容必须保持。
        expect(await readFile(join(root, seed), 'utf8')).toBe('protected');
      } else {
        await expect(readFile(join(root, target), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    });
  });

  // 模板名按决定显式放行；只是名字里含 git/env/node_modules 字样的普通源码文件不受影响。
  it.each([
    '.env.example',
    '.env.sample',
    'packages/x/.ENV.Example',
    'src/.gitignore',
    'src/environment.ts',
    'config/env.local.ts',
    'src/node_modules_shim.ts',
  ])('allows writing %s', async (target) => {
    await withWriteFixture(async (root) => {
      const result = await new ToolRouter().execute(
        writeCall(target, 'template = 1\n'),
        freshnessCtx(root)
      );
      expect(result.ok).toBe(true);
      expect(await readFile(join(root, target), 'utf8')).toBe('template = 1\n');
    });
  });

  it('denies a requested .env path even when it is a symlink to an ordinary file', async () => {
    await withWriteFixture(async (root) => {
      await mkdir(join(root, 'config'));
      await writeFile(join(root, 'config/secrets.txt'), 'API_TOKEN=fixture');
      await symlink(join(root, 'config/secrets.txt'), join(root, '.env'));
      const result = await new ToolRouter().execute(writeCall('.env'), freshnessCtx(root));

      expect(result.ok).toBe(false);
      const meta = result._meta as ProtectedWriteMeta | undefined;
      expect(meta?.diagnosticWarnings?.[0]?.message).toContain('view=requested');
      expect(meta?.diagnosticWarnings?.[0]?.message).toContain('rule=env-file');
      expect(await readFile(join(root, 'config/secrets.txt'), 'utf8')).toBe('API_TOKEN=fixture');
    });
  });

  it('denies an ordinary alias whose real target is a nested .env file', async () => {
    await withWriteFixture(async (root) => {
      await mkdir(join(root, 'packages/x'), { recursive: true });
      await writeFile(join(root, 'packages/x/.env.local'), 'SECRET=fixture');
      await symlink(join(root, 'packages/x/.env.local'), join(root, 'settings.txt'));
      const result = await new ToolRouter().execute(writeCall('settings.txt'), freshnessCtx(root));

      expect(result.ok).toBe(false);
      const meta = result._meta as ProtectedWriteMeta | undefined;
      expect(meta?.diagnosticWarnings?.[0]?.message).toContain('view=resolved');
      expect(meta?.diagnosticWarnings?.[0]?.message).toContain('path=packages/x/.env.local');
      expect(await readFile(join(root, 'packages/x/.env.local'), 'utf8')).toBe('SECRET=fixture');
    });
  });

  it('surfaces the denial as a blocked envelope with the diagnostic through the host adapter', async () => {
    await withWriteFixture(async (root) => {
      const logger = Logger.getInstance();
      vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const adapter = new ToolRouterAdapter({
        contextFactory: { create: () => freshnessCtx(root) },
      });
      const envelope = await adapter.execute({
        toolId: 'code',
        args: { action: 'write', params: { path: '.env.local', content: 'SECRET=x' } },
        surface: 'runtime',
        actor: { role: 'agent' },
        source: { kind: 'runtime' },
      });

      expect(envelope.ok).toBe(false);
      expect(envelope.status).toBe('blocked');
      expect(envelope.diagnostics.warnings.map((warning) => warning.code)).toContain(
        'code_write_protected_path'
      );
      expect(envelope.diagnostics.blockedTools).toEqual([
        { tool: 'code', reason: expect.stringContaining('protected path') },
      ]);
      await expect(readFile(join(root, '.env.local'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('describes the segment-based protected path rule in the code.write registry entry', () => {
    const description = TOOL_REGISTRY.code.actions.write.description;
    expect(description).toContain('any path segment');
    expect(description).toContain('case-insensitive');
    expect(description).toContain('.env.*');
    expect(description).toContain('.env.example');
    expect(description).toContain('.env.sample');
  });
});
