import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as loopLedger from '../src/agent/evidence/loopLedger.js';
import {
  AgentRuntime,
  DiagnosticsCollector,
  HookSystem,
  type RuntimeConfig,
} from '../src/agent/runtime/index.js';
import * as strategiesBarrel from '../src/agent/strategies/index.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import { AiProvider } from '../src/ai/AiProvider.js';
import { UnifiedToolCatalog } from '../src/tools/catalog/UnifiedToolCatalog.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/result.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { Capability } from '../src/tools/runtime/toolsets/Capability.js';

/**
 * I48（L5-P2）非公开死代码与重复类型清理的守护用例。
 *
 * 背景：AgentRuntime 每轮为每个能力复制整份消息历史只为调用空的 Capability 步骤钩子；
 * 证据台账回退 jobId 用 `run-${Date.now()}`，同毫秒构建的两个 runtime 会写进同一目录；
 * hookSystem 通过未声明字段强转读取；strategies barrel 残留无人默认导入的默认导出对象；
 * PipelineRuntime.logger 无读取者；'off' | 'guard' 在多处重写而已有 GroundingEnforcement。
 */

// 只包一层 spy 记录 AgentRuntime 交给台账打开器的回退 jobId，真实打开逻辑保持接线。
vi.mock('../src/agent/evidence/loopLedger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/evidence/loopLedger.js')>();
  return { ...actual, openLoopEvidence: vi.fn(actual.openLoopEvidence) };
});

const srcRoot = path.join(process.cwd(), 'src');

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

function minimalRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    aiProvider: {
      name: 'unit-test',
      model: 'unit',
      chatWithTools: vi.fn(async () => ({ text: 'done', functionCalls: [] })),
    } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
    ...overrides,
  };
}

function successEnvelope(): ToolResultEnvelope {
  return {
    ok: true,
    status: 'success',
    toolId: 'meta',
    callId: 'fixture',
    startedAt: 'fixture',
    durationMs: 0,
    text: 'fixture',
    diagnostics: new DiagnosticsCollector().toJSON(),
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

/** 覆盖了两个步骤钩子的能力：钩子若被运行循环驱动，spy 会记录到调用。 */
class StepHookProbe extends Capability {
  readonly before = vi.fn();
  readonly after = vi.fn();

  override get name(): string {
    return 'step-hook-probe';
  }

  override get promptFragment(): string {
    return '';
  }

  override onBeforeStep(stepState: unknown) {
    this.before(stepState);
  }

  override onAfterStep(stepResult: unknown) {
    this.after(stepResult);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(loopLedger.openLoopEvidence).mockClear();
});

describe('agent runtime evidence ledger fallback job id', () => {
  it('scopes the fallback job id to the runtime instance even when two runtimes share a millisecond', async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-agent-runtime-fallback-job-'));
    try {
      // 固定 Date.now：旧实现 `run-${Date.now()}` 在此必然让两个实例落到同一台账目录。
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
      const first = new AgentRuntime(minimalRuntimeConfig({ dataRoot }));
      const second = new AgentRuntime(minimalRuntimeConfig({ dataRoot }));
      vi.useRealTimers();
      const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);

      for (const runtime of [first, second]) {
        // 只给维度身份、不给 _bootstrapSessionId：openLoopEvidence 必须使用 runtime 回退 jobId。
        const result = await runtime.reactLoop('open ledger', {
          source: 'system',
          sharedState: { _dimensionMeta: { id: 'fallback-dimension' } },
          budgetOverride: { maxIterations: 1, timeoutMs: 1_000 },
        });
        expect(result.reply).toBe('done');
      }

      const jobIds = vi
        .mocked(loopLedger.openLoopEvidence)
        .mock.calls.map(([options]) => options.defaultJobId);
      expect(jobIds).toEqual([`run-${first.id}`, `run-${second.id}`]);
      expect(new Set(jobIds).size).toBe(2);
      // 回退路径必须可定位：日志写明回退 jobId、runtime 与维度。
      const fallbackLogs = info.mock.calls
        .map((call) => call.map((part) => JSON.stringify(part)).join(' '))
        .filter((line) => line.includes('runtime-scoped fallback job id'));
      expect(fallbackLogs).toHaveLength(2);
      expect(fallbackLogs[0]).toContain(`run-${first.id}`);
      expect(fallbackLogs[0]).toContain('fallback-dimension');
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('keeps the host job id and does not report a fallback when one is supplied', async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-agent-runtime-host-job-'));
    try {
      const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
      const runtime = new AgentRuntime(minimalRuntimeConfig({ dataRoot, jobId: 'job:host' }));
      await runtime.reactLoop('open ledger', {
        source: 'system',
        sharedState: { _dimensionMeta: { id: 'host-dimension' } },
        budgetOverride: { maxIterations: 1, timeoutMs: 1_000 },
      });

      expect(vi.mocked(loopLedger.openLoopEvidence).mock.calls[0]?.[0].defaultJobId).toBe(
        'job:host'
      );
      const fallbackLogs = info.mock.calls.filter((call) =>
        String(call[0]).includes('runtime-scoped fallback job id')
      );
      expect(fallbackLogs).toEqual([]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});

describe('agent runtime capability step hooks', () => {
  it('does not drive the empty Capability step hooks or copy history for them across a tool round', async () => {
    const catalog = new RuntimeCapabilityCatalog();
    const execute = vi.fn(async (): Promise<ToolResultEnvelope> => successEnvelope());
    const provider = new AiProvider({ model: 'fixture' });
    vi.spyOn(provider, 'chatWithTools')
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [{ id: 'call', name: 'meta', args: { action: 'tools', params: {} } }],
      })
      .mockResolvedValue({ text: 'done', functionCalls: [] });
    const probe = new StepHookProbe();
    const runtime = new AgentRuntime({
      aiProvider: provider,
      toolRegistry: new UnifiedToolCatalog(),
      container: { get: () => catalog },
      additionalTools: ['meta'],
      capabilities: [probe],
      toolRouter: {
        execute,
        executeChildCall: execute,
        explain: async () => ({ allowed: true, stage: 'execute' }),
      },
      strategy: new SingleStrategy(),
    });

    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 3, timeoutMs: 1_000 },
    });

    // 工具轮真实发生（前置与后置钩子的旧调用点都会被经过），但运行循环不再驱动步骤钩子。
    expect(execute).toHaveBeenCalledOnce();
    expect(result.reply).toBe('done');
    expect(probe.before).not.toHaveBeenCalled();
    expect(probe.after).not.toHaveBeenCalled();
  });
});

describe('agent runtime hook system ownership', () => {
  it('always owns its HookSystem and ignores an undeclared injected instance', () => {
    const foreign = new HookSystem();
    const runtime = new AgentRuntime({
      ...minimalRuntimeConfig(),
      // RuntimeConfig 从未声明 hookSystem；外部订阅统一经 runtime.hookSystem getter。
      ...({ hookSystem: foreign } as Record<string, unknown>),
    });

    expect(runtime.hookSystem).toBeInstanceOf(HookSystem);
    expect(runtime.hookSystem).not.toBe(foreign);
    // 默认桥接 hook 注册在 runtime 自有实例上，而不是外部实例上。
    expect(runtime.hookSystem.hookCount()).toBeGreaterThan(0);
    expect(foreign.hookCount()).toBe(0);
  });
});

describe('agent strategy and contract hygiene', () => {
  it('exposes only named strategy exports from the strategies barrel', () => {
    expect(Object.keys(strategiesBarrel)).not.toContain('default');
    expect(strategiesBarrel.Strategy).toBeTypeOf('function');
    expect(strategiesBarrel.SingleStrategy).toBeTypeOf('function');
    expect(strategiesBarrel.FanOutStrategy).toBeTypeOf('function');
  });

  it('does not declare an unread logger on the PipelineRuntime contract', () => {
    const contracts = readFileSync(
      path.join(srcRoot, 'agent', 'strategies', 'pipeline', 'contracts.ts'),
      'utf8'
    );
    const runtimeInterface = contracts.match(/export interface PipelineRuntime \{[\s\S]*?\n\}/u);
    expect(runtimeInterface?.[0]).toBeTruthy();
    expect(runtimeInterface?.[0]).not.toMatch(/^\s*logger\??:/mu);
  });

  it('declares the grounding enforcement literal union only once', () => {
    const declarations = walkSource(srcRoot)
      .filter((filePath) =>
        /'off'\s*\|\s*'guard'|'guard'\s*\|\s*'off'/u.test(readFileSync(filePath, 'utf8'))
      )
      .map((filePath) => path.relative(process.cwd(), filePath).split(path.sep).join('/'));

    expect(declarations).toEqual(['src/agent/runtime/AgentRuntimeTypes.ts']);
  });
});
