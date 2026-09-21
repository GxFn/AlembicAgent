import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/ContextWindow.js';
import { captureEvidenceFromEnvelope } from '../src/agent/evidence/EvidenceCapture.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { RuntimeConfig } from '../src/agent/runtime/AgentRuntimeTypes.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import type { ToolCallRequest } from '../src/tools/kernel/index.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { DeltaCache } from '../src/tools/runtime/cache/DeltaCache.js';
import { SearchCache } from '../src/tools/runtime/cache/SearchCache.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-read-view-'));
  await writeFile(join(root, 'small.ts'), 'one\ntwo\nthree');
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function readRequest(params: Record<string, unknown>): ToolCallRequest {
  return {
    toolId: 'code',
    args: { action: 'read', params },
    surface: 'runtime',
    actor: { user: 'test' },
    source: { kind: 'runtime' },
  };
}

describe('code read observation', () => {
  it.each([
    'throw',
    'reject',
    'pending',
  ] as const)('preserves a confirmed write when optional fingerprint maintenance will %s', async (mode) => {
    const deltaCache = new DeltaCache();
    const searchCache = new SearchCache();
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, deltaCache, searchCache }),
      },
    });
    await router.execute(readRequest({ path: 'small.ts' }));
    const search = {
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['two'] } },
    };
    expect((await router.execute(search)).structuredContent).toMatchObject({ total: 1 });
    let rejectMaintenance: ((reason: Error) => void) | undefined;
    const then = vi.fn((_resolve: unknown, reject: (reason: Error) => void) => {
      rejectMaintenance = reject;
    });
    vi.spyOn(deltaCache, 'set').mockImplementationOnce(() => {
      if (mode === 'throw') {
        throw new Error('fixture cache maintenance failed');
      }
      return { then };
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writes = vi.spyOn(fs, 'writeFile');
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'write', params: { path: 'small.ts', content: 'confirmed new content' } },
    });
    expect(await readFile(join(root, 'small.ts'), 'utf8')).toBe('confirmed new content');
    expect(writes).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      structuredContent: { written: 'small.ts', bytes: 21 },
    });
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({
        code:
          mode === 'throw'
            ? 'code_write_cache_refresh_failed'
            : 'code_write_cache_refresh_unconfirmed',
        message: expect.stringContaining('code.read'),
      })
    );
    if (mode !== 'throw') {
      expect(then).toHaveBeenCalledOnce();
    }
    if (mode === 'reject') {
      const snapshot = JSON.stringify(result);
      rejectMaintenance?.(new Error('fixture late cache rejection'));
      await Promise.resolve();
      await Promise.resolve();
      expect(warning).toHaveBeenCalled();
      expect(JSON.stringify(result)).toBe(snapshot);
    }
    const read = await router.execute(readRequest({ path: 'small.ts' }));
    expect(read.ok).toBe(true);
    expect(read.text).toContain('confirmed new content');
    expect(deltaCache.get('small.ts')?.content).toBe('confirmed new content');
    expect((await router.execute(search)).structuredContent).toMatchObject({ total: 0 });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it.each([
    'aborted',
    'timeout',
  ] as const)('settles rg %s once, retaining observed matches without fallback or cache', async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    });
    // 仅模拟 Node child 事件边界，成功/无匹配/exit2 另有真实 spawn/rg 测试。
    const spawn = vi
      .spyOn(childProcess, 'spawn')
      .mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>);
    syncBuiltinESMExports();
    const controller = new AbortController();
    const searchCache = new SearchCache();
    const set = vi.spyOn(searchCache, 'set');
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 8000, searchCache }) },
    });
    const pending = router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['two'] } },
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const wire = `${JSON.stringify({ type: 'match', data: { path: { text: './small.ts' }, line_number: 2, lines: { text: 'two\n' } } })}\n`;
    child.stdout.emit('data', Buffer.from(wire));
    if (status === 'aborted') {
      controller.abort(new Error('fixture cancelled active rg'));
    } else {
      await vi.advanceTimersByTimeAsync(15000);
    }
    // 旧实现只能等 close；仍发 close 避免 RED 挂住 Vitest 主进程。
    child.emit('close', null, 'SIGKILL');
    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      status,
      structuredContent: {
        total: 1,
        shown: 1,
        incomplete: true,
        matches: [{ file: 'small.ts', line: 2, content: 'two' }],
      },
    });
    expect(result.diagnostics?.fallbackUsed).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
    const before = JSON.stringify(result);
    child.stdout.emit('data', Buffer.from(wire));
    child.emit('close', 0);
    child.emit('error', new Error('late fixture close error'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(JSON.stringify(result)).toBe(before);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])('rejects invalid regex rather than reporting no matches (fallback=%s)', async (fallback) => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    if (fallback) {
      vi.stubEnv('PATH', '');
    }
    const cache = new SearchCache();
    const set = vi.spyOn(cache, 'set');
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, searchCache: cache }),
      },
    });
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['['], regex: true } },
    });
    expect(result).toMatchObject({ ok: false, status: 'error' });
    expect(result.text).toMatch(/regex|regular expression/i);
    expect(set).not.toHaveBeenCalled();
  });

  it('keeps rg exit 1 as an empty successful result without fallback', async () => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 8000 }) },
    });
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['no-fixture-matches'] } },
    });
    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      structuredContent: { matches: [], total: 0, shown: 0 },
    });
    expect(result.diagnostics?.fallbackUsed).toBe(false);
  });

  it('retains rg exit 2 matches as diagnosed partial output and never caches them', async () => {
    const bin = join(root, 'fixture-bin');
    await mkdir(bin);
    const wire = `${JSON.stringify({ type: 'match', data: { path: { text: './small.ts' }, line_number: 2, lines: { text: 'two\n' } } })}\n`;
    // 受控 rg 替身只发协议/错误回执，不执行项目命令；实际 child_process 和 adapter 路径不 mock。
    await writeFile(
      join(bin, 'rg'),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(wire)}); process.stderr.write('fixture permission denied\\n'); process.exitCode = 2;\n`
    );
    await chmod(join(bin, 'rg'), 0o755);
    vi.stubEnv('PATH', bin);
    const cache = new SearchCache();
    const set = vi.spyOn(cache, 'set');
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, searchCache: cache }),
      },
    });
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['two'] } },
    });
    expect(result).toMatchObject({
      ok: true,
      status: 'partial',
      structuredContent: { matches: [{ file: 'small.ts', line: 2, content: 'two' }] },
    });
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({
        code: 'code_search_incomplete',
        message: expect.stringContaining('fixture permission denied'),
      })
    );
    expect(result.diagnostics?.fallbackUsed).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])('returns ordered context separately from exact match evidence (fallback=%s)', async (fallback) => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    await writeFile(join(root, 'small.ts'), ' before  \n needle-first  \nneedle-second\n after\n');
    if (fallback) {
      vi.stubEnv('PATH', '');
    }
    const searchCache = new SearchCache();
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 8000, searchCache }) },
    });
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['needle'], contextLines: 1 } },
    });
    expect(result.structuredContent).toMatchObject({
      total: 2,
      shown: 2,
      matches: [
        {
          file: 'small.ts',
          line: 2,
          content: ' needle-first  ',
          context: [' before  ', 'needle-second'],
        },
        {
          file: 'small.ts',
          line: 3,
          content: 'needle-second',
          context: [' needle-first  ', ' after'],
        },
      ],
    });
    const noContext = await router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['needle'], contextLines: 0 } },
    });
    expect(noContext.structuredContent).toMatchObject({
      matches: [
        { file: 'small.ts', line: 2, content: ' needle-first  ' },
        { file: 'small.ts', line: 3, content: 'needle-second' },
      ],
    });
    expect((noContext.structuredContent as { matches: unknown[] }).matches[0]).not.toHaveProperty(
      'context'
    );
    const ledger = new EvidenceLedgerStore({
      dataRoot: root,
      jobId: 'context',
      sessionId: 'fixture',
      dimensionId: 'code',
    });
    const evidence = captureEvidenceFromEnvelope(
      ledger,
      { name: 'code', args: { action: 'search' }, id: 'context-search' },
      result
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0].content).toBe('2:  needle-first  \n3: needle-second');
    expect(evidence[0].range).toBeUndefined();
  });

  it.each([
    8000, 450,
  ])('bounds structured search at the action/request quota (%i) without inventing source evidence', async (tokenBudget) => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    const largeContent = `needle-${'x'.repeat(60000)}`;
    await writeFile(join(root, 'wide.ts'), largeContent);
    await writeFile(join(root, 'small.ts'), 'needle-short');
    const searchCache = new SearchCache();
    const cacheSet = vi.spyOn(searchCache, 'set');
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget, searchCache }) },
    });
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['needle'], contextLines: 0 } },
    });
    expect(Math.ceil(result.text.length / 4)).toBeLessThanOrEqual(Math.min(tokenBudget, 3000));
    expect(result).toMatchObject({ ok: true, status: 'partial' });
    expect(result.structuredContent).toMatchObject({
      total: 2,
      shown: 1,
      matches: [{ file: 'small.ts', line: 1, content: 'needle-short' }],
      truncated: true,
      omittedCount: 1,
      omittedLocations: [{ file: 'wide.ts', line: 1 }],
    });
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({ code: 'code_search_output_truncated' })
    );
    expect(cacheSet.mock.calls[0]?.[1]).toMatchObject({
      matches: expect.arrayContaining([{ file: 'wide.ts', line: 1, content: largeContent }]),
    });
    const ledger = new EvidenceLedgerStore({
      dataRoot: root,
      jobId: 'quota',
      sessionId: 'fixture',
      dimensionId: 'code',
    });
    const evidence = captureEvidenceFromEnvelope(
      ledger,
      { name: 'code', args: { action: 'search' }, id: 'quota-search' },
      result
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ file: 'small.ts', content: '1: needle-short' });
    expect(evidence[0].range).toBeUndefined();
  });

  it('omits complete search locators when they cannot fit instead of shortening real paths', async () => {
    const directory = 'd'.repeat(200);
    const file = `${'f'.repeat(200)}.ts`;
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, file), `needle-${'x'.repeat(60000)}`);
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 100 }) },
    });
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['needle'], contextLines: 0 } },
    });
    expect(Math.ceil(result.text.length / 4)).toBeLessThanOrEqual(100);
    expect(result.structuredContent).toMatchObject({
      total: 1,
      shown: 0,
      matches: [],
      truncated: true,
      omittedCount: 1,
    });
    expect(result.structuredContent).not.toHaveProperty('omittedLocations');
  });

  it.each([
    { cacheKind: 'native', writeFailure: false },
    { cacheKind: 'legacy', writeFailure: false },
    { cacheKind: 'native', writeFailure: true },
    { cacheKind: 'legacy', writeFailure: true },
  ])('invalidates $cacheKind search results once a write is attempted (failure=$writeFailure)', async ({
    cacheKind,
    writeFailure,
  }) => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    const backing = new SearchCache();
    const searchCache =
      cacheKind === 'native'
        ? backing
        : {
            get: (key: string) => backing.get(key),
            set: (key: string, value: unknown) => backing.set(key, value),
          };
    const deltaCache = new DeltaCache();
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, deltaCache, searchCache }),
      },
    });
    const search = {
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['two'] } },
    };
    expect((await router.execute(search)).structuredContent).toMatchObject({ total: 1 });
    await router.execute(readRequest({ path: 'small.ts' }));
    if (writeFailure) {
      const originalWrite = fs.writeFile;
      vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (file, data, options) => {
        await originalWrite(file, data, options);
        throw new Error('fixture write receipt failed after disk changed');
      });
    }
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'write', params: { path: 'small.ts', content: 'four' } },
    });
    expect(result.ok).toBe(!writeFailure);
    expect(await readFile(join(root, 'small.ts'), 'utf8')).toBe('four');
    const next = await router.execute(search);
    expect(next.structuredContent).toMatchObject({ total: 0, shown: 0, matches: [] });
  });

  it('rejects a freshness read error instead of treating an existing file as new', async () => {
    const deltaCache = new DeltaCache();
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 8000, deltaCache }) },
    });
    // 临时文件真实存在且可写；模拟跨平台一致的读取权限失败，不伪造 ENOENT。
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('fixture EACCES while reading existing file'), { code: 'EACCES' })
    );
    const write = vi.spyOn(fs, 'writeFile');
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'write', params: { path: 'small.ts', content: 'must not overwrite' } },
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('EACCES');
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'small.ts'), 'utf8')).toBe('one\ntwo\nthree');
  });

  it.each([
    'freshness',
    'mkdir',
    'after-write',
  ])('honors the final cancellation boundary at %s without inventing a rollback', async (phase) => {
    const deltaCache = new DeltaCache();
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 8000, deltaCache }) },
    });
    const relative = phase === 'mkdir' ? 'created/new.ts' : 'small.ts';
    const target = join(await fs.realpath(root), relative);
    const controller = new AbortController();
    if (phase !== 'mkdir') {
      await router.execute(readRequest({ path: relative }));
    }
    const originalRead = fs.readFile;
    const originalMkdir = fs.mkdir;
    const originalWrite = fs.writeFile;
    if (phase === 'freshness') {
      vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
        const result = await originalRead(file, options);
        if (String(file) === target) {
          controller.abort(new Error('fixture cancelled after freshness read'));
        }
        return result;
      });
    } else if (phase === 'mkdir') {
      vi.spyOn(fs, 'mkdir').mockImplementation(async (directory, options) => {
        const result = await originalMkdir(directory, options);
        if (String(directory) === join(await fs.realpath(root), 'created')) {
          controller.abort(new Error('fixture cancelled after parent directory creation'));
        }
        return result;
      });
    } else {
      vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
        await originalWrite(file, data, options);
        if (String(file) === target) {
          controller.abort(new Error('fixture cancelled after completed write'));
        }
      });
    }
    const result = await router.execute({
      ...readRequest({}),
      args: {
        action: 'write',
        params: { path: relative, content: 'new content', createDirectories: true },
      },
      abortSignal: controller.signal,
    });
    expect(controller.signal.aborted).toBe(true);
    if (phase === 'after-write') {
      expect(result).toMatchObject({
        ok: true,
        status: 'success',
        structuredContent: { written: relative, bytes: 11 },
      });
      expect(await originalRead(target, 'utf8')).toBe('new content');
    } else {
      expect(result).toMatchObject({ ok: false, status: 'aborted' });
      if (phase === 'mkdir') {
        await expect(originalRead(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(await originalRead(target, 'utf8')).toBe('one\ntwo\nthree');
      }
    }
  });

  it('keeps fallback search inside the project path boundary', async () => {
    const project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'inside.ts'), 'inside-marker');
    await writeFile(join(root, 'outside.ts'), 'outside-marker');
    await symlink(join(root, 'outside.ts'), join(project, 'link.ts'));
    const router = new ToolRouterAdapter({
      contextFactory: { create: () => ({ projectRoot: project, tokenBudget: 8000 }) },
    });
    expect((await router.execute(readRequest({ path: 'link.ts' }))).ok).toBe(false);
    // 仅在隔离目录制造 rg 缺席，真实 fallback/fs 路径仍执行。
    vi.stubEnv('PATH', '');
    const result = await router.execute({
      ...readRequest({}),
      args: { action: 'search', params: { patterns: ['marker'], glob: '*.ts' } },
    });
    expect(result.structuredContent).toMatchObject({
      total: 1,
      shown: 1,
      matches: [{ file: 'inside.ts', content: 'inside-marker' }],
    });
    expect(result.text).not.toContain('outside-marker');
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({
        code: 'code_search_path_rejected',
      })
    );
  });

  it('does not reuse full visibility after the router truncates an oversized single read', async () => {
    await writeFile(join(root, 'wide.ts'), 'x'.repeat(25000));
    const deltaCache = new DeltaCache();
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, deltaCache }),
      },
    });
    const first = await router.execute(readRequest({ path: 'wide.ts' }));
    expect(first.text).toContain('chars truncated');
    const again = await router.execute(readRequest({ path: 'wide.ts' }));
    expect(again.text).not.toContain('unchanged');
    expect(again.text).toContain('chars truncated');
  });
  it('does not present a ranged or outline read as a previously visible full file', async () => {
    const deltaCache = new DeltaCache();
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 1000, deltaCache }),
      },
    });
    await router.execute(readRequest({ path: 'small.ts', startLine: 1, endLine: 1 }));
    expect((await router.execute(readRequest({ path: 'small.ts' }))).text).toContain('3|three');
    expect((await router.execute(readRequest({ path: 'small.ts' }))).text).toContain('unchanged');
    await writeFile(
      join(root, 'large.ts'),
      Array.from({ length: 510 }, (_, i) => `line ${i}`).join('\n')
    );
    await router.execute(readRequest({ path: 'large.ts' }));
    const outline = await router.execute(readRequest({ path: 'large.ts' }));
    expect(outline.text).not.toContain('unchanged');
    expect(outline.text).toContain('510');
  });

  it('does not treat a truncated batch result as full visibility', async () => {
    const content = 'a'.repeat(5000);
    await writeFile(join(root, 'wide.ts'), content);
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 1000, deltaCache }),
      },
    });
    const deltaCache = new DeltaCache();
    const batch = await router.execute(readRequest({ filePaths: ['wide.ts'] }));
    expect(batch.structuredContent).toMatchObject({ files: [{ truncated: true }] });
    expect((await router.execute(readRequest({ path: 'wide.ts' }))).text).toContain(content);
  });
});

function runtimeHarness(
  responses: Array<Record<string, unknown>>,
  strategy: RuntimeConfig['strategy'] = new SingleStrategy()
) {
  const requests: ToolCallRequest[] = [];
  const releaseScope = vi.fn();
  const router = new ToolRouterAdapter({
    contextFactory: {
      create: (request) => {
        requests.push(request);
        return { projectRoot: root, tokenBudget: 8000 };
      },
      releaseScope,
    },
  });
  const runtime = new AgentRuntime({
    aiProvider: {
      name: 'mock',
      chatWithTools: vi.fn(async () => responses.shift() ?? { text: 'done' }),
    } as never,
    toolRegistry: new RuntimeCapabilityCatalog(),
    container: { get: () => new RuntimeCapabilityCatalog() },
    toolRouter: router,
    projectRoot: root,
    additionalTools: ['code'],
    strategy,
    policies: new PolicyEngine([new BudgetPolicy({ maxIterations: 6, timeoutMs: 1000 })]),
  });
  return { runtime, requests, releaseScope };
}

function readCall(id: string) {
  return {
    functionCalls: [{ id, name: 'code', args: { action: 'read', params: { path: 'small.ts' } } }],
  };
}

describe('runtime-owned tool resource lifecycle', () => {
  it('shares the run across stages, assigns distinct views, then releases both views and the run', async () => {
    const strategy: RuntimeConfig['strategy'] = {
      name: 'scope-fixture',
      execute: async (runtime, _message, opts) => {
        await runtime.reactLoop('first stage', opts);
        return runtime.reactLoop('second stage', opts);
      },
    };
    const { runtime, requests, releaseScope } = runtimeHarness(
      [readCall('a'), { text: 'first done' }, readCall('b'), { text: 'second done' }],
      strategy
    );
    await runtime.execute(new AgentMessage({ content: 'task' }));
    expect(requests).toHaveLength(2);
    const scopes = requests.map((request) => request.runtime?.resourceScope);
    expect(scopes[0]?.runId).toEqual(expect.any(String));
    expect(scopes[1]?.runId).toBe(scopes[0]?.runId);
    expect(scopes[1]?.viewId).not.toBe(scopes[0]?.viewId);
    expect(releaseScope.mock.calls.map(([scope]) => scope)).toEqual([
      { runId: scopes[0]?.runId, viewId: scopes[0]?.viewId },
      { runId: scopes[1]?.runId, viewId: scopes[1]?.viewId },
      { runId: scopes[0]?.runId },
    ]);
  });

  it('uses a new run when the same runtime is called directly again', async () => {
    const { runtime, requests, releaseScope } = runtimeHarness([
      readCall('a'),
      { text: 'done' },
      readCall('b'),
      { text: 'done' },
    ]);
    await runtime.reactLoop('first');
    await runtime.reactLoop('second');
    expect(requests[0]?.runtime?.resourceScope?.runId).toEqual(expect.any(String));
    expect(requests[0]?.runtime?.resourceScope?.runId).not.toBe(
      requests[1]?.runtime?.resourceScope?.runId
    );
    expect(releaseScope).toHaveBeenCalledTimes(4);
  });

  it('invalidates the next read view when the model history quota truncates a read result', async () => {
    await writeFile(join(root, 'small.ts'), 'wide source '.repeat(3000));
    const { runtime, requests } = runtimeHarness([readCall('a'), readCall('b'), { text: 'done' }]);
    const result = await runtime.reactLoop('read twice');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.runtime?.resourceScope?.revision).toBeGreaterThan(
      requests[0]?.runtime?.resourceScope?.revision ?? -1
    );
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({
        code: 'tool_read_view_invalidated',
      })
    );
  });

  it.each([
    'failure',
    'cancel',
    'timeout',
  ] as const)('releases run resources after %s', async (mode) => {
    const abort = new AbortController();
    const strategy: RuntimeConfig['strategy'] = {
      name: 'cleanup-fixture',
      execute: async (runtime, _message, opts) => {
        const result = await runtime.reactLoop('stage', opts);
        if (mode === 'failure') {
          throw new Error('fixture failure');
        }
        if (mode === 'timeout') {
          return new Promise(() => {});
        }
        abort.abort();
        return result;
      },
    };
    const { runtime, requests, releaseScope } = runtimeHarness(
      [readCall('a'), { text: 'done' }],
      strategy
    );
    const pending = runtime.execute(new AgentMessage({ content: 'task' }), {
      abortSignal: abort.signal,
      timeoutMs: 150,
    });
    if (mode === 'cancel') {
      expect((await pending).diagnostics?.efficiency?.cancelReason).toBe('abort_signal');
    } else {
      await expect(pending).rejects.toThrow(
        mode === 'failure' ? 'fixture failure' : 'Agent timeout'
      );
    }
    const scope = requests[0]?.runtime?.resourceScope;
    expect(scope?.runId).toEqual(expect.any(String));
    expect(releaseScope).toHaveBeenCalledWith({ runId: scope?.runId });
    expect(releaseScope).toHaveBeenCalledWith({ runId: scope?.runId, viewId: scope?.viewId });
  });

  it('reports cleanup errors without replacing the completed result', async () => {
    const { runtime, releaseScope } = runtimeHarness([readCall('a'), { text: 'done' }]);
    const warn = vi.spyOn(runtime.logger, 'warn').mockImplementation(() => {});
    releaseScope.mockImplementation(() => {
      throw new Error('fixture cleanup failed');
    });
    try {
      expect((await runtime.reactLoop('task')).reply).toBe('done');
      expect(warn).toHaveBeenCalledWith(
        '[AgentRuntime] tool scope cleanup failed',
        expect.objectContaining({ error: 'fixture cleanup failed' })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not resurrect a timed-out run when a legacy strategy starts a late loop without its signal', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let completed!: (error: unknown) => void;
    const lateResult = new Promise<unknown>((resolve) => {
      completed = resolve;
    });
    const strategy: RuntimeConfig['strategy'] = {
      name: 'late-loop-fixture',
      execute: async (runtime) => {
        await gate;
        try {
          const result = await runtime.reactLoop('late');
          completed(null);
          return result;
        } catch (err: unknown) {
          completed(err);
          throw err;
        }
      },
    };
    const { runtime, requests, releaseScope } = runtimeHarness([readCall('late')], strategy);
    await expect(
      runtime.execute(new AgentMessage({ content: 'task' }), { timeoutMs: 10 })
    ).rejects.toThrow('Agent timeout');
    resume();
    expect(await lateResult).toMatchObject({
      message: 'Cannot start a loop after its tool resource run has closed',
    });
    expect(requests).toHaveLength(0);
    expect(releaseScope).toHaveBeenCalledTimes(1);
  });

  it('advances the view when context compression loses tool content', async () => {
    const contextWindow = new ContextWindow(2000);
    const { runtime, requests } = runtimeHarness([readCall('a'), { text: 'done' }]);
    const initial = contextWindow.readViewRevision;
    contextWindow.appendUserMessage('task');
    for (let i = 0; i < 3; i++) {
      contextWindow.appendAssistantWithToolCalls('', [{ id: `old-${i}`, name: 'code', args: {} }]);
      contextWindow.appendToolResult(`old-${i}`, 'code', 'x'.repeat(5000));
    }
    contextWindow.compactIfNeeded();
    expect(contextWindow.readViewRevision).toBeGreaterThan(initial);
    let revisionAtRead = -1;
    runtime.hookSystem.on('tool:execute:before', () => {
      revisionAtRead = contextWindow.readViewRevision;
    });
    await runtime.reactLoop('new tool', { contextWindow });
    expect(requests[0]?.runtime?.resourceScope?.revision).toBe(revisionAtRead);
  });

  it('keeps collapsed tool rounds paired when replacing an earlier nudge', () => {
    const window = new ContextWindow();
    window.appendUserMessage('task');
    window.appendUserNudge('old');
    for (let i = 0; i < 3; i++) {
      window.appendAssistantWithToolCalls('', [{ id: `call-${i}`, name: 'code', args: {} }]);
      window.appendToolResult(`call-${i}`, 'code', `read ${i}`);
    }
    window.compactForProviderInputBudget({ maxProjectedMessages: 1 });
    const callsBefore = window.toProjectedMessages().flatMap((message) => message.toolCalls ?? []);
    window.appendUserNudge('new');
    expect(window.toProjectedMessages().flatMap((message) => message.toolCalls ?? [])).toEqual(
      callsBefore
    );
    expect(callsBefore).toHaveLength(2);
  });

  it('keeps old context windows usable while disabling unsafe delta reuse', async () => {
    const window = new ContextWindow();
    const legacyWindow = new Proxy(window, {
      get: (target, name) => {
        if (name === 'readViewRevision') {
          return undefined;
        }
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { runtime, requests } = runtimeHarness([readCall('a'), readCall('b'), { text: 'done' }]);
    await runtime.reactLoop('legacy', { contextWindow: legacyWindow });
    const scopes = requests.map((request) => request.runtime?.resourceScope);
    expect(scopes).toHaveLength(2);
    expect(Number.isSafeInteger(scopes[0]?.revision)).toBe(true);
    expect(scopes[1]?.revision).toBeGreaterThan(scopes[0]?.revision ?? -1);
  });
});
