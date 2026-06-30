import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/tools/runtime/index.js';
import {
  DeltaCache,
  Evolution,
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

  it('surfaces a degraded handler result on the per-call envelope diagnostics', async () => {
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          ...baseToolContext(),
          sandboxExecutor: {
            exec: async () => ({ stdout: 'half done', stderr: '', exitCode: 137 }),
          },
        }),
      },
    });

    const envelope = await adapter.execute({
      toolId: 'terminal',
      args: { action: 'exec', params: { command: 'sleep 99' } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'vitest' },
    });

    // terminal.exec marks a SIGKILL/timeout partial as degraded; the adapter must
    // lift that onto the envelope diagnostics (which feeds the ordinary-output summary).
    expect(envelope.ok).toBe(true);
    expect(envelope.text).toContain('[timeout] partial output');
    expect(envelope.diagnostics?.degraded).toBe(true);
    expect(envelope.diagnostics?.fallbackUsed).toBe(false);
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

  it('writes new knowledge submissions with the Alembic Agent source by default', async () => {
    const router = new ToolRouter();
    const createRequests: Array<{
      source: string;
      items: Record<string, unknown>[];
      options?: Record<string, unknown>;
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
        },
        kind: 'pattern',
        trigger: 'Tool V2 source boundary',
        whenClause: 'When the Agent runtime submits a new knowledge candidate through Tool V2.',
        doClause: 'Record alembic-agent as the default source for the submitted candidate.',
        dontClause: 'Do not reuse the legacy ide-agent source for new Agent writes.',
        reasoning: {
          sources: ['package.json:1-3'],
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
      projectRoot: process.cwd(),
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
