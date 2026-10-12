import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/ContextWindow.js';
import { captureEvidenceFromEnvelope } from '../src/agent/evidence/EvidenceCapture.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { RuntimeConfig } from '../src/agent/runtime/AgentRuntimeTypes.js';
import { resolveProviderInputBudget } from '../src/agent/runtime/llmInput.js';
import {
  ContextWindowAdapter,
  createMessageAdapter,
  type MessageAdapter,
  SimpleArrayAdapter,
} from '../src/agent/runtime/MessageAdapter.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import type { LlmContinuation } from '../src/ai/contracts.js';
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
    // 验证真实文件IO的资源身份/释放；不让并行机器负载先耗尽1000ms安全预算。
    vi.useFakeTimers();
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
    // 先完成真实工具调用，再显式触发预期终态；150ms期限与错误/回执断言保持不变。
    vi.useFakeTimers();
    const stageCompleted = Promise.withResolvers<void>();
    const abort = new AbortController();
    const strategy: RuntimeConfig['strategy'] = {
      name: 'cleanup-fixture',
      execute: async (runtime, _message, opts) => {
        const result = await runtime.reactLoop('stage', opts);
        stageCompleted.resolve();
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
    // 提前订阅失败，避免推进虚拟时间时出现未处理拒绝。
    const settled =
      mode === 'cancel'
        ? pending.then((result) => {
            expect(result.diagnostics?.efficiency?.cancelReason).toBe('abort_signal');
          })
        : expect(pending).rejects.toThrow(mode === 'failure' ? 'fixture failure' : 'Agent timeout');
    if (mode === 'timeout') {
      await stageCompleted.promise;
      await vi.advanceTimersByTimeAsync(150);
    }
    await settled;
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

/**
 * I16：SimpleArrayAdapter（无 contextWindow 的对话/严格阶段）与 ContextWindowAdapter 必须给模型同样的
 * 消息语义——只保留最新 runtime nudge、knowledge submit 参数按 provider 历史压缩、工具结果元数据只留
 * 布尔 persistedSubmission、toMessages 返回快照；Simple 不压缩，但预算投影必须如实测量并在超限时告警。
 */
describe('message adapter semantic parity', () => {
  const adapters = (): Array<[string, () => MessageAdapter]> => [
    ['simple', () => createMessageAdapter(null)],
    ['context-window', () => createMessageAdapter(new ContextWindow(100_000))],
  ];
  const submitCall = (id: string) => ({
    id,
    name: 'knowledge',
    args: {
      action: 'submit',
      params: {
        title: 'Coordinator owns feature flags',
        kind: 'rule',
        content: { markdown: 'large candidate body '.repeat(200) },
      },
    },
  });
  const continuationFor = (callId: string): LlmContinuation => ({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    connection: 'fixture-connection',
    kind: 'content-replay-v1',
    parts: [
      { type: 'reasoning', text: 'native reasoning' },
      { type: 'tool-call', id: callId },
    ],
    projectionHash: 'captured-before-compaction',
  });
  const logLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(([entry]) => String(entry));
  const projectedShape = (adapter: MessageAdapter) =>
    (adapter.toProjectedMessages() as Array<{ role: string; content?: string | null }>).map(
      ({ role, content }) => ({ role, content })
    );

  it('createMessageAdapter selects the adapter by contextWindow presence', () => {
    expect(createMessageAdapter(null)).toBeInstanceOf(SimpleArrayAdapter);
    expect(createMessageAdapter(new ContextWindow())).toBeInstanceOf(ContextWindowAdapter);
  });

  it.each(
    adapters()
  )('%s keeps only the latest runtime nudge after consecutive nudges', (_label, make) => {
    const adapter = make();
    adapter.appendUserMessage('task');
    adapter.appendUserNudge('nudge-1');
    adapter.appendAssistantText('working');
    adapter.appendUserNudge('nudge-2');
    adapter.appendUserNudge('nudge-3');
    expect(projectedShape(adapter)).toEqual([
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'nudge-3' },
    ]);
  });

  it('gives both adapters the same projected history for an identical nudge sequence', () => {
    const [simple, windowed] = adapters().map(([, make]) => make());
    for (const adapter of [simple, windowed]) {
      adapter.appendUserMessage('task');
      adapter.appendUserNudge('stage nudge');
      adapter.appendAssistantWithToolCalls(null, [
        { id: 'c1', name: 'code', args: { action: 'read' } },
      ]);
      adapter.appendToolResult('c1', 'code', 'source');
      adapter.appendUserNudge('grounding nudge');
    }
    expect(projectedShape(simple)).toEqual(projectedShape(windowed));
    expect(projectedShape(simple).filter((message) => message.content?.endsWith('nudge'))).toEqual([
      { role: 'user', content: 'grounding nudge' },
    ]);
  });

  it('compacts knowledge submit args identically in both adapters and drops the stale continuation', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const stored = adapters().map(([, make]) => {
      const adapter = make();
      adapter.appendUserMessage('submit');
      adapter.appendAssistantWithToolCalls(
        null,
        [{ ...submitCall('submit-1'), thoughtSignature: 'sig_call' } as never],
        'kept reasoning',
        continuationFor('submit-1')
      );
      return (
        adapter.toMessages() as Array<{
          continuation?: unknown;
          reasoningContent?: string | null;
          toolCalls?: Array<{ args?: Record<string, unknown> }>;
        }>
      )[1];
    });
    const [simple, windowed] = stored;
    expect(simple?.toolCalls).toEqual(windowed?.toolCalls);
    expect(simple?.toolCalls?.[0]?.args).toMatchObject({
      action: 'submit',
      providerHistoryCompacted: true,
      params: { title: 'Coordinator owns feature flags', kind: 'rule' },
    });
    expect(JSON.stringify(simple?.toolCalls)).not.toContain('large candidate body');
    expect(JSON.stringify(simple?.toolCalls)).not.toContain('sig_call');
    // 参数改写后续接的投影摘要必然失配：两种适配器都不保存续接，只保留 reasoningContent。
    expect(simple?.continuation).toBeUndefined();
    expect(simple?.reasoningContent).toBe('kept reasoning');
    const dropped = logLines(info).filter((line) => line.includes('continuation_dropped'));
    expect(dropped).toHaveLength(2);
    expect(dropped.some((line) => line.startsWith('[MessageAdapter]'))).toBe(true);
    expect(dropped.every((line) => line.includes('reason=compacted_args'))).toBe(true);
  });

  it('keeps non-submit tool calls and their continuation untouched in the simple adapter', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const adapter = createMessageAdapter(null);
    const call = { id: 'read-1', name: 'code', args: { action: 'read', params: { path: 'a.ts' } } };
    adapter.appendUserMessage('read');
    adapter.appendAssistantWithToolCalls(null, [call], 'reasoning', continuationFor('read-1'));
    const stored = (
      adapter.toMessages() as Array<{ continuation?: unknown; toolCalls?: unknown[] }>
    )[1];
    expect(stored?.toolCalls).toEqual([call]);
    expect(stored?.continuation).toMatchObject({ kind: 'content-replay-v1' });
    expect(logLines(info).join('\n')).not.toContain('continuation_dropped');
  });

  it('keeps only boolean persistedSubmission tool-result metadata in both adapters', () => {
    const results = adapters().map(([, make]) => {
      const adapter = make();
      adapter.appendUserMessage('task');
      adapter.appendAssistantWithToolCalls(null, [submitCall('s1'), submitCall('s2')]);
      adapter.appendToolResult('s1', 'knowledge', 'ok', {
        persistedSubmission: true,
        leaked: 'extra',
      } as never);
      adapter.appendToolResult('s2', 'knowledge', 'ok', {
        persistedSubmission: 'yes',
      } as never);
      return (adapter.toMessages() as Array<{ metadata?: unknown }>)
        .slice(2)
        .map((message) => message.metadata);
    });
    expect(results[0]).toEqual([{ persistedSubmission: true }, undefined]);
    expect(results[0]).toEqual(results[1]);
  });

  it.each(
    adapters()
  )('%s toMessages returns a snapshot that callers cannot use to rewrite history', (_label, make) => {
    const adapter = make();
    adapter.appendUserMessage('task');
    adapter.appendAssistantText('answer');
    const snapshot = adapter.toMessages();
    snapshot.push({ role: 'user', content: 'injected' });
    snapshot.splice(0, 1);
    expect(projectedShape(adapter)).toEqual([
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(adapter.toMessages()).toHaveLength(2);
  });

  it('measures the simple projection truthfully and warns when a stage budget cannot be enforced', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const budget = resolveProviderInputBudget('produce');
    expect(budget).not.toBeNull();
    const simple = createMessageAdapter(null);
    const reference = new ContextWindow(1_000_000);
    for (const sink of [simple, reference]) {
      sink.appendUserMessage(`strict produce input ${'x'.repeat(200_000)}`);
    }
    const expectedTokens = reference.estimateProjectedTokens();
    expect(expectedTokens).toBeGreaterThan(budget?.maxProjectedTokens ?? 0);

    const projection = simple.compactForProviderInputBudget({ ...budget, stageProfile: 'produce' });
    expect(projection).toEqual({
      afterMessageCount: 1,
      afterProjectedTokens: expectedTokens,
      beforeMessageCount: 1,
      beforeProjectedTokens: expectedTokens,
      level: 0,
      reason: 'adapter-without-compaction:produce',
      removed: 0,
    });
    const warned = logLines(warn).filter((line) => line.includes('adapter-without-compaction'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('stageProfile=produce');
    expect(warned[0]).toContain(`tokens≈${expectedTokens}/${budget?.maxProjectedTokens}`);
    expect(warned[0]).toContain(`messages=1/${budget?.maxProjectedMessages}`);
    expect(warned[0]).not.toContain('xxxx');
  });

  it('reports real tokens without a warning when the simple projection is within budget', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const simple = createMessageAdapter(null);
    const reference = new ContextWindow(100_000);
    for (const sink of [simple, reference]) {
      sink.appendUserMessage('short analyze prompt');
      sink.appendAssistantWithToolCalls('looking', [{ id: 'c1', name: 'code', args: { q: 1 } }]);
      sink.appendToolResult('c1', 'code', 'result');
    }
    const projection = simple.compactForProviderInputBudget({
      ...resolveProviderInputBudget('analyze'),
      stageProfile: 'analyze',
    });
    expect(projection).toMatchObject({
      afterProjectedTokens: reference.estimateProjectedTokens(),
      beforeProjectedTokens: reference.estimateProjectedTokens(),
      beforeMessageCount: 3,
      level: 0,
      reason: null,
      removed: 0,
    });
    expect(projection.beforeProjectedTokens).toBeGreaterThan(0);
    expect(logLines(warn).join('\n')).not.toContain('adapter-without-compaction');
  });

  it('keeps the simple adapter usable when the warning sink throws', () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
      throw new Error('log sink failed');
    });
    const simple = createMessageAdapter(null);
    simple.appendUserMessage('y'.repeat(100_000));
    expect(
      simple.compactForProviderInputBudget({
        maxProjectedMessages: 20,
        maxProjectedTokens: 10,
        stageProfile: 'record',
      })
    ).toMatchObject({ level: 0, reason: 'adapter-without-compaction:record' });
  });

  it('logs why the context window leaves an over-budget short history uncompacted', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const window = new ContextWindow(1_000_000);
    window.appendUserMessage(`strict analyze input ${'z'.repeat(200_000)}`);
    const tokens = window.estimateProjectedTokens();
    const projection = window.compactForProviderInputBudget({
      ...resolveProviderInputBudget('analyze'),
      stageProfile: 'analyze',
    });
    // 返回结构不变（level=0、reason=null）；只补一条诊断说明预算为何没有执行。
    expect(projection).toMatchObject({
      beforeProjectedTokens: tokens,
      afterProjectedTokens: tokens,
      level: 0,
      reason: null,
    });
    const skipped = logLines(info).filter((line) => line.includes('provider input budget skipped'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('stageProfile=analyze');
    expect(skipped[0]).toContain(`tokens≈${tokens}/16000`);
    expect(skipped[0]).not.toContain('zzzz');
    info.mockClear();
    const small = new ContextWindow(1_000_000);
    small.appendUserMessage('short');
    small.compactForProviderInputBudget({ maxProjectedMessages: 44, maxProjectedTokens: 16_000 });
    expect(logLines(info).join('\n')).not.toContain('provider input budget skipped');
  });
});
