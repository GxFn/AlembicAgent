/**
 * L5-P18 / I17 回归：SafetyPolicy.fileScope 必须覆盖 code 工具真正会访问的所有路径。
 *
 * - code.structure 的 directory（含缺省 '.'、空串、平铺写法被 router 丢弃后的缺省项目根）；
 * - code.search 没有路径参数，搜索根恒为项目根：fileScope 窄于项目根时按决策直接拒绝，
 *   拒绝原因带规则码 SAFETY_FILE_SCOPE_SEARCH，模型自带的 directory/glob 不能收窄搜索根；
 * - 生产形状的 terminal {action:'exec', params:{command}} 继续被命令黑名单拦截。
 *
 * 门禁层用真实 PolicyEngine + SafetyPolicy 直接调用 runtimeSafetyGate；端到端用真实
 * ToolRouterAdapter + code handler 跑在临时项目上，证明越界调用到不了 handler、scope 内调用正常执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PolicyEngine, SafetyPolicy } from '../src/agent/policies/index.js';
import type { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import type { LoopContext } from '../src/agent/runtime/LoopContext.js';
import { createToolPipeline } from '../src/agent/runtime/ToolExecutionPipeline.js';
import { runtimeSafetyGate } from '../src/agent/runtime/toolPipeline/accessGates.js';
import type { ToolPipelineContext } from '../src/agent/runtime/toolPipeline/contracts.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import type { ToolContext } from '../src/tools/runtime/index.js';

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-l5-p18-'));
fs.mkdirSync(path.join(projectRoot, 'allowed', 'x'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'allowed-other'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'secrets'), { recursive: true });
fs.writeFileSync(
  path.join(projectRoot, 'allowed', 'x', 'inner.ts'),
  'export const inner = "API_KEY_ALLOWED";\n'
);
fs.writeFileSync(path.join(projectRoot, 'secrets', 'key.txt'), 'API_KEY=topsecret\n');
fs.writeFileSync(path.join(projectRoot, 'root.ts'), 'export const root = 1;\n');

const allowedScope = path.join(projectRoot, 'allowed');

afterAll(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const metadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };

function gateContext(fileScope: string) {
  const warn = vi.fn();
  const diagnostics = new DiagnosticsCollector();
  const ctx = {
    runtime: {
      logger: { warn, info: vi.fn() },
      policies: new PolicyEngine([new SafetyPolicy({ fileScope })]),
      projectRoot,
    },
    loopCtx: { capabilities: [], diagnostics },
    iteration: 1,
  } as unknown as ToolPipelineContext;
  return { ctx, warn, diagnostics };
}

async function runGate(args: Record<string, unknown>, fileScope = allowedScope) {
  const { ctx, warn, diagnostics } = gateContext(fileScope);
  const verdict = await runtimeSafetyGate.before?.({ id: 'call', name: 'code', args }, ctx, {
    ...metadata,
  });
  return { verdict, warn, diagnostics };
}

function blockedError(verdict: unknown): string {
  const result = (verdict as { result?: { error?: unknown } } | undefined)?.result;
  return String(result?.error ?? '');
}

describe('runtimeSafetyGate fileScope covers code.structure directory (L5-P18)', () => {
  it.each([
    ['a directory outside the scope', { action: 'structure', params: { directory: 'secrets' } }],
    ['the default project root (empty params)', { action: 'structure', params: {} }],
    ['the default project root (no params at all)', { action: 'structure' }],
    ['an empty directory string', { action: 'structure', params: { directory: '' } }],
    ['the dot directory', { action: 'structure', params: { directory: '.' } }],
    ['the dot-slash directory', { action: 'structure', params: { directory: './' } }],
    [
      'a parent traversal back out of the scope',
      { action: 'structure', params: { directory: 'allowed/../secrets' } },
    ],
    [
      'an absolute path outside the scope',
      { action: 'structure', params: { directory: path.join(projectRoot, 'secrets') } },
    ],
    [
      'a sibling directory sharing the scope prefix',
      { action: 'structure', params: { directory: 'allowed-other' } },
    ],
    [
      'a flat directory the router drops (handler lists the project root)',
      { action: 'structure', directory: 'allowed' },
    ],
    [
      'null params with a flat directory (handler lists the project root)',
      { action: 'structure', params: null, directory: 'allowed' },
    ],
    [
      'an out-of-scope top-level directory beside in-scope params',
      { action: 'structure', directory: 'secrets', params: { directory: 'allowed' } },
    ],
  ])('blocks %s', async (_label, args) => {
    const { verdict, warn, diagnostics } = await runGate(args);

    expect(verdict?.blocked).toBe(true);
    const error = blockedError(verdict);
    expect(error).toContain('路径拦截');
    expect(error).toContain('SAFETY_FILE_SCOPE_PATH');
    expect(error).toContain('directory');
    // 拒绝路径必须留下日志与诊断，能看出工具与规则码。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('SAFETY_FILE_SCOPE_PATH');
    expect(diagnostics.toJSON().warnings).toEqual([
      expect.objectContaining({ code: 'TOOL_POLICY_DENIED', tool: 'code' }),
    ]);
  });

  it.each([
    ['the scope itself', { directory: 'allowed' }],
    ['a nested directory', { directory: 'allowed/x' }],
    ['a dot-prefixed spelling with trailing slash', { directory: './allowed/' }],
    ['an absolute path inside the scope', { directory: path.join(projectRoot, 'allowed', 'x') }],
  ])('admits %s', async (_label, params) => {
    const { verdict, warn, diagnostics } = await runGate({ action: 'structure', params });
    expect(verdict).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(diagnostics.toJSON().warnings).toEqual([]);
  });

  it('admits the default project root when the scope covers the project root', async () => {
    for (const scope of [projectRoot, path.dirname(projectRoot)]) {
      const { verdict } = await runGate({ action: 'structure', params: {} }, scope);
      expect(verdict).toBeUndefined();
    }
  });
});

describe('runtimeSafetyGate rejects code.search under a narrower fileScope (L5-P18)', () => {
  it.each([
    ['plain patterns', { patterns: ['API_KEY'] }],
    ['a model-supplied directory', { patterns: ['API_KEY'], directory: 'allowed' }],
    ['a glob aimed at the scope', { patterns: ['API_KEY'], glob: 'allowed/**' }],
  ])('blocks code.search with %s and names the rule code', async (_label, params) => {
    const { verdict, warn, diagnostics } = await runGate({ action: 'search', params });

    expect(verdict?.blocked).toBe(true);
    const error = blockedError(verdict);
    expect(error).toContain('SAFETY_FILE_SCOPE_SEARCH');
    expect(error).toContain('code.search');
    expect(error).toContain(allowedScope);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('SAFETY_FILE_SCOPE_SEARCH');
    expect(diagnostics.toJSON().warnings).toEqual([
      expect.objectContaining({ code: 'TOOL_POLICY_DENIED', tool: 'code' }),
    ]);
  });

  it('admits code.search when the scope equals or contains the project root', async () => {
    for (const scope of [projectRoot, path.dirname(projectRoot)]) {
      const { verdict } = await runGate(
        { action: 'search', params: { patterns: ['API_KEY'] } },
        scope
      );
      expect(verdict).toBeUndefined();
    }
  });
});

describe('runtimeSafetyGate keeps path checks and production-shaped terminal checks (L5-P18)', () => {
  it('blocks out-of-scope read paths in every spelling and admits in-scope ones', async () => {
    for (const args of [
      { action: 'read', params: { path: 'secrets/key.txt' } },
      { action: 'read', params: { path: 'allowed/../secrets/key.txt' } },
      { action: 'read', params: { filePaths: ['allowed/x/inner.ts', 'secrets/key.txt'] } },
      { action: 'read', path: 'secrets/key.txt', params: { path: 'allowed/x/inner.ts' } },
      { action: 'outline', params: { path: path.join(projectRoot, 'secrets', 'key.txt') } },
      { action: 'write', params: { path: 'secrets/new.ts', content: 'x' } },
    ]) {
      const { verdict } = await runGate(args);
      expect(verdict?.blocked).toBe(true);
      expect(blockedError(verdict)).toContain('路径拦截');
    }
    for (const args of [
      { action: 'read', params: { path: 'allowed/x/inner.ts' } },
      { action: 'read', params: { filePaths: ['allowed/x/inner.ts', './allowed/x/inner.ts'] } },
      { action: 'write', params: { path: 'allowed/new.ts', content: 'x' } },
    ]) {
      expect((await runGate(args)).verdict).toBeUndefined();
    }
  });

  it('blocks a production-shaped terminal command through the gate', async () => {
    const { ctx, warn, diagnostics } = gateContext(allowedScope);
    const verdict = await runtimeSafetyGate.before?.(
      {
        id: 'sudo',
        name: 'terminal',
        args: { action: 'exec', params: { command: 'sudo whoami' } },
      },
      ctx,
      { ...metadata }
    );
    expect(verdict?.blocked).toBe(true);
    expect(blockedError(verdict)).toContain('命令拦截');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(diagnostics.toJSON().warnings).toEqual([
      expect.objectContaining({ code: 'TOOL_POLICY_DENIED', tool: 'terminal' }),
    ]);
  });
});

/** 与宿主 AgentModule 一致：真实 ToolRouterAdapter + 默认 ToolRouter + code handler。 */
function makeProductionLikeRun(fileScope: string) {
  const toolContext: ToolContext = { projectRoot, tokenBudget: 8000 };
  const adapter = new ToolRouterAdapter({ contextFactory: { create: () => toolContext } });
  const execute = vi.spyOn(adapter, 'execute');
  const diagnostics = new DiagnosticsCollector();
  const runtime = {
    id: 'l5-p18-runtime',
    presetName: 'chat',
    container: null,
    projectRoot,
    dataRoot: projectRoot,
    fileCache: null,
    lang: null,
    logger: { info: vi.fn(), warn: vi.fn() },
    aiProvider: null,
    policies: new PolicyEngine([new SafetyPolicy({ fileScope })]),
    toolRegistry: { getManifest: () => null },
    toolRouter: adapter,
    emitProgress: vi.fn(),
    bus: { publish: vi.fn() },
  } as unknown as AgentRuntime;
  const loopCtx = {
    allowedToolIds: ['code'],
    allowedToolActions: { code: ['search', 'read', 'structure'] },
    capabilities: [],
    abortSignal: null,
    budget: {},
    context: { pipelinePhase: 'chat' },
    diagnostics,
    evidenceLedger: null,
    iteration: 1,
    memoryCoordinator: null,
    sharedState: {},
    source: 'system',
    toolCalls: [],
    tracker: null,
    trace: null,
  } as unknown as LoopContext;
  return { runtime, loopCtx, execute };
}

async function runPipeline(args: Record<string, unknown>, fileScope = allowedScope) {
  const { runtime, loopCtx, execute } = makeProductionLikeRun(fileScope);
  const outcome = await createToolPipeline().execute(
    { id: 'e2e', name: 'code', args },
    { runtime, loopCtx, iteration: 1 }
  );
  return { outcome, execute, serialized: JSON.stringify(outcome.result) };
}

describe('tool pipeline enforces fileScope before the real code handler (L5-P18)', () => {
  it.each([
    ['structure outside the scope', { action: 'structure', params: { directory: 'secrets' } }],
    ['structure of the default project root', { action: 'structure', params: {} }],
    ['structure with a flat directory', { action: 'structure', directory: 'allowed' }],
    ['search from the project root', { action: 'search', params: { patterns: ['API_KEY'] } }],
  ])('never dispatches %s to the host', async (_label, args) => {
    const { outcome, execute, serialized } = await runPipeline(args);
    expect(outcome.metadata.blocked).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(serialized).not.toContain('key.txt');
    expect(serialized).not.toContain('topsecret');
  });

  it('lists an in-scope directory through the real handler', async () => {
    const { outcome, execute, serialized } = await runPipeline({
      action: 'structure',
      params: { directory: 'allowed' },
    });
    expect(outcome.metadata.blocked).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(serialized).toContain('inner.ts');
    expect(serialized).not.toContain('key.txt');
  });

  it('searches normally when the scope equals the project root', async () => {
    const { outcome, execute, serialized } = await runPipeline(
      { action: 'search', params: { patterns: ['API_KEY'] } },
      projectRoot
    );
    expect(outcome.metadata.blocked).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(serialized).toContain('API_KEY');
  });
});
