import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as loopLedger from '../src/agent/evidence/loopLedger.js';
import {
  createProductionEvidenceLedgerAuthority,
  resolveProductionEvidenceLedgerStore,
} from '../src/agent/evidence/ProductionEvidenceLedgerAuthority.js';
import { getPreset, resolveStrategy } from '../src/agent/profiles/presets/index.js';
import {
  AgentRuntime,
  DiagnosticsCollector,
  HookSystem,
  type RuntimeConfig,
} from '../src/agent/runtime/index.js';
import { ContextWindowAdapter, SimpleArrayAdapter } from '../src/agent/runtime/MessageAdapter.js';
import { SystemPromptBuilder } from '../src/agent/runtime/SystemPromptBuilder.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import * as strategiesBarrel from '../src/agent/strategies/index.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import { AiProvider } from '../src/ai/AiProvider.js';
import { UnifiedToolCatalog } from '../src/tools/catalog/UnifiedToolCatalog.js';
import type { ToolCallRequest } from '../src/tools/kernel/request.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/result.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { handle as handleEvidence } from '../src/tools/runtime/handlers/evidence.js';
import { Capability } from '../src/tools/runtime/toolsets/Capability.js';

/**
 * I48（L5-P2）非公开死代码与重复类型清理的守护用例。
 *
 * 背景：AgentRuntime 每轮为每个能力复制整份消息历史只为调用空的 Capability 步骤钩子；
 * 证据台账回退 jobId 用 `run-${Date.now()}`，同毫秒构建的两个 runtime 会写进同一目录；
 * hookSystem 通过未声明字段强转读取；strategies barrel 残留无人默认导入的默认导出对象；
 * PipelineRuntime.logger 无读取者；'off' | 'guard' 在多处重写而已有 GroundingEnforcement。
 *
 * L5-P2r3 补修：回退 jobId 在宿主固定公开 RuntimeConfig.id 时也必须按实例唯一（C056）；
 * Capability 公开基类与生命周期文档要写明步骤钩子不由运行循环驱动（C024）；
 * 守护用例的断言与标题一致，源码守护按 TypeScript 语法树判断而不是按文本正则（C057）。
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

/**
 * 统计源码里“恰好重写了 GroundingEnforcement 字面量联合”的类型节点数。
 *
 * 按 TypeScript 语法树判断而不是文本正则：注释、字符串和更大的无关联合（如 'off' | 'guard' | 'strict'）
 * 都不算；别名、属性、参数里的二元联合都算，额外的 undefined / null 成员也视为同一重写。
 */
function countGroundingLiteralUnions(fileName: string, text: string): number {
  // 廉价预筛：两个字面量都不出现的文件不可能命中，省去解析整个 src 的开销。
  if (!text.includes('off') || !text.includes('guard')) {
    return 0;
  }
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isUnionTypeNode(node)) {
      const literals = new Set<string>();
      let onlyLiteralsAndNullish = true;
      for (const member of node.types) {
        if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
          literals.add(member.literal.text);
        } else if (
          member.kind !== ts.SyntaxKind.UndefinedKeyword &&
          !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)
        ) {
          onlyLiteralsAndNullish = false;
        }
      }
      if (
        onlyLiteralsAndNullish &&
        literals.size === 2 &&
        literals.has('off') &&
        literals.has('guard')
      ) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

/**
 * PipelineRuntime 接口是否声明了 logger 成员。按语法树读成员名：readonly、可选、方法写法都算，
 * 注释和其他接口里的同名成员不算。
 */
function pipelineRuntimeDeclaresLogger(text: string): boolean {
  const sourceFile = ts.createSourceFile('contracts.ts', text, ts.ScriptTarget.Latest, true);
  const runtimeInterface = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'PipelineRuntime'
  );
  if (!runtimeInterface) {
    throw new Error('PipelineRuntime interface not found');
  }
  return runtimeInterface.members.some(
    (member) =>
      member.name !== undefined &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === 'logger'
  );
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
      expect(jobIds).toHaveLength(2);
      // 回退 jobId 以 runtime id 为前缀（日志可定位），后缀是按实例生成的随机片段。
      expect(jobIds[0]?.startsWith(`run-${first.id}-`)).toBe(true);
      expect(jobIds[1]?.startsWith(`run-${second.id}-`)).toBe(true);
      expect(new Set(jobIds).size).toBe(2);
      // 回退路径必须可定位：日志写明回退 jobId、runtime 与维度。
      const fallbackLogs = info.mock.calls
        .map((call) => call.map((part) => JSON.stringify(part)).join(' '))
        .filter((line) => line.includes('runtime-scoped fallback job id'));
      expect(fallbackLogs).toHaveLength(2);
      expect(fallbackLogs[0]).toContain(String(jobIds[0]));
      expect(fallbackLogs[0]).toContain('fallback-dimension');
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('gives each runtime its own fallback ledger even when the host passes the same stable id', async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-agent-runtime-stable-id-'));
    try {
      const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
      // 公开 RuntimeConfig.id 允许宿主传固定值；只传 id、不传 jobId 与 _bootstrapSessionId 时，
      // 两次独立运行既不能落进同一台账目录，也不能 hydrate 上一次运行写下的证据。
      const first = new AgentRuntime(minimalRuntimeConfig({ dataRoot, id: 'host-agent' }));
      await first.reactLoop('open ledger', {
        source: 'system',
        sharedState: { _dimensionMeta: { id: 'dim-a' } },
        budgetOverride: { maxIterations: 1, timeoutMs: 1_000 },
      });
      const firstStore = vi.mocked(loopLedger.openLoopEvidence).mock.results[0]?.value as
        | ReturnType<typeof loopLedger.openLoopEvidence>
        | undefined;
      expect(firstStore).toBeTruthy();
      firstStore?.append({
        tool: 'code.read',
        callId: 'c1',
        file: 'a.ts',
        content: 'export const a = 1;',
      });
      expect(firstStore?.stats().entries).toBe(1);

      const second = new AgentRuntime(minimalRuntimeConfig({ dataRoot, id: 'host-agent' }));
      await second.reactLoop('open ledger', {
        source: 'system',
        sharedState: { _dimensionMeta: { id: 'dim-a' } },
        budgetOverride: { maxIterations: 1, timeoutMs: 1_000 },
      });
      const secondStore = vi.mocked(loopLedger.openLoopEvidence).mock.results[1]?.value as
        | ReturnType<typeof loopLedger.openLoopEvidence>
        | undefined;

      const jobIds = vi
        .mocked(loopLedger.openLoopEvidence)
        .mock.calls.map(([options]) => options.defaultJobId);
      expect(first.id).toBe('host-agent');
      expect(second.id).toBe('host-agent');
      // 关键断言在前：第二次运行看不到第一次运行的证据，且台账目录不同。
      expect(secondStore?.stats().entries).toBe(0);
      expect(secondStore?.filePath).not.toBe(firstStore?.filePath);
      expect(jobIds[0]).not.toBe(jobIds[1]);
      expect(jobIds[0]?.startsWith('run-host-agent-')).toBe(true);
      expect(jobIds[1]?.startsWith('run-host-agent-')).toBe(true);
      // 两次回退各记一次日志，分别写明自己的回退 jobId。
      const fallbackLogs = info.mock.calls
        .map((call) => call.map((part) => JSON.stringify(part)).join(' '))
        .filter((line) => line.includes('runtime-scoped fallback job id'));
      expect(fallbackLogs).toHaveLength(2);
      expect(fallbackLogs[1]).toContain(String(jobIds[1]));
      expect(fallbackLogs[1]).toContain('host-agent');
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

/**
 * RED-P2b（第四轮审计 RED-P2 确认项）：原文摘要 freshness 跨 reactLoop 生效。
 *
 * #initLoop 每次 reactLoop 都经 openLoopEvidence 新建 store；HMAC 密钥与摘要表若仍是 store 实例状态，
 * 第二个 reactLoop 的 store 对第一轮入账的条目没有摘要，退回脱敏哈希，被脱敏遮住的改动（P3 样本
 * `def strip`→`def strap`）判 fresh，evidence.get 把改动后的原文当成已核实证据回读。修复后摘要表由
 * AgentRuntime 实例持有并交给每次新建的 store；跨 runtime 实例仍按脱敏哈希比对并记诊断。
 */
describe('agent runtime evidence source digests across reactLoops (RED-P2b)', () => {
  const PEM_FILE = 'tools/pem.py';
  const PEM_BEFORE =
    '# Strip the -----BEGIN PRIVATE KEY----- header\ndef strip(pem):\n    return pem\n';
  const PEM_AFTER = PEM_BEFORE.replace('def strip', 'def strap');
  const DIMENSION = { _dimensionMeta: { id: 'digest-dimension' } };

  interface EvidenceReadback {
    readonly verbatim?: boolean;
    readonly content: string;
  }

  function sourceLines(text: string): string[] {
    const lines = text.split('\n');
    if (lines.length > 1 && text.endsWith('\n')) {
      lines.pop();
    }
    return lines;
  }

  function envelopeFor(
    toolId: string,
    text: string,
    structuredContent?: Record<string, unknown>
  ): ToolResultEnvelope {
    return {
      ...successEnvelope(),
      toolId,
      text,
      ...(structuredContent ? { structuredContent } : {}),
    };
  }

  /**
   * 真实 runtime 循环夹具：模型第一轮调用 code.read（证据经 evidenceCapture 管线入账），之后以文本收尾；
   * evidence.get 走真实 handler，台账取自路由请求里 runtime 交出的本轮 evidenceLedger。
   */
  function buildDigestRuntime(projectRoot: string, config: Partial<RuntimeConfig> = {}) {
    const catalog = new RuntimeCapabilityCatalog();
    const readbacks: EvidenceReadback[] = [];
    const execute = vi.fn(async (request: ToolCallRequest): Promise<ToolResultEnvelope> => {
      const params = ((request.args as { params?: unknown }).params ?? {}) as Record<
        string,
        unknown
      >;
      if (request.toolId === 'code') {
        const text = readFileSync(path.join(projectRoot, PEM_FILE), 'utf8');
        const lines = sourceLines(text);
        return envelopeFor('code', 'batch read', {
          mode: 'batch',
          files: [
            {
              ok: true,
              path: PEM_FILE,
              content: lines.map((line, index) => `${index + 1}|${line}`).join('\n'),
              lineCount: lines.length,
              mode: 'full',
            },
          ],
        });
      }
      if (request.toolId === 'evidence') {
        const result = await handleEvidence('get', params, {
          projectRoot,
          runtime: request.runtime,
        } as unknown as Parameters<typeof handleEvidence>[2]);
        expect(result.ok, String(result.error)).toBe(true);
        readbacks.push(result.data as EvidenceReadback);
        return envelopeFor('evidence', JSON.stringify(result.data));
      }
      throw new Error(`unexpected tool ${request.toolId}`);
    });
    const provider = new AiProvider({ model: 'fixture' });
    const chat = vi.spyOn(provider, 'chatWithTools');
    const runtime = new AgentRuntime({
      aiProvider: provider,
      toolRegistry: new UnifiedToolCatalog(),
      container: { get: () => catalog },
      additionalTools: ['code', 'evidence'],
      capabilities: [],
      toolRouter: {
        execute,
        executeChildCall: execute,
        explain: async () => ({ allowed: true, stage: 'execute' }),
      },
      strategy: new SingleStrategy(),
      projectRoot,
      dataRoot: projectRoot,
      ...config,
    });
    /** 一次 reactLoop：模型先发一个工具调用，再以文本收尾。 */
    const loopWith = async (call: { id: string; name: string; args: Record<string, unknown> }) => {
      chat
        .mockResolvedValueOnce({ text: null, functionCalls: [call] })
        .mockResolvedValueOnce({ text: 'done', functionCalls: [] });
      const result = await runtime.reactLoop('fixture', {
        source: 'system',
        sharedState: { ...DIMENSION },
        budgetOverride: { maxIterations: 3, timeoutMs: 5_000 },
      });
      expect(result.reply).toBe('done');
    };
    return {
      runtime,
      readbacks,
      readPem: () =>
        loopWith({
          id: 'read-pem',
          name: 'code',
          args: { action: 'read', params: { filePaths: [PEM_FILE] } },
        }),
      getEvidence: (ref: string) =>
        loopWith({ id: `get-${ref}`, name: 'evidence', args: { action: 'get', params: { ref } } }),
    };
  }

  function openedStores() {
    return vi
      .mocked(loopLedger.openLoopEvidence)
      .mock.results.map(
        (result) => result.value as NonNullable<ReturnType<typeof loopLedger.openLoopEvidence>>
      );
  }

  function freshnessLogs(debug: { mock: { calls: unknown[][] } }): string[] {
    return debug.mock.calls
      .map((call) => JSON.stringify(call))
      .filter((line) => line.includes('[EvidenceLedger] freshness checked via'));
  }

  it('judges a masked edit stale when a later reactLoop of the same runtime reads the entry back', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'alembic-agent-runtime-digest-'));
    try {
      mkdirSync(path.join(root, 'tools'), { recursive: true });
      writeFileSync(path.join(root, PEM_FILE), PEM_BEFORE, 'utf8');
      const fixture = buildDigestRuntime(root, { jobId: 'job-digest' });

      // 第一轮 reactLoop：code.read 经 evidenceCapture 管线入账为带 range 的 E-1。
      await fixture.readPem();
      const [firstStore] = openedStores();
      const entry = firstStore?.get('E-1');
      expect(entry?.tool).toBe('code.read');
      expect(entry?.range).toEqual({ start: 1, end: 3 });
      // 前提：样本确实被脱敏改写过，`def strip` 落在被遮区间里（P3 假 fresh 的来源）。
      expect(entry?.content).not.toContain('def strip');

      // 两轮之间，只改被遮区间里的字节。
      writeFileSync(path.join(root, PEM_FILE), PEM_AFTER, 'utf8');
      const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);

      // 第二轮 reactLoop：#initLoop 新建了另一个 store，evidence.get 必须判 stale，不回读改动后的原文。
      await fixture.getEvidence('E-1');
      const stores = openedStores();
      expect(stores).toHaveLength(2);
      expect(stores[1]).not.toBe(stores[0]);
      expect(stores[1]?.filePath).toBe(stores[0]?.filePath);
      expect(fixture.readbacks).toHaveLength(1);
      expect(fixture.readbacks[0]?.verbatim).toBe(false);
      expect(fixture.readbacks[0]?.content).toBe(entry?.content);
      expect(fixture.readbacks[0]?.content).not.toContain('def strap');
      expect(stores[1]?.checkFreshness('E-1', PEM_AFTER)).toBe('stale');
      expect(stores[1]?.checkFreshness('E-1', PEM_BEFORE)).toBe('fresh');
      // 判定依据是原文摘要（runtime 共享），诊断不含正文。
      const logs = freshnessLogs(debug);
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(line).toContain('source-digest');
        expect(line).not.toContain('redacted-hash');
        expect(line).not.toContain('def str');
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('keeps the redacted-hash comparison across runtime instances and logs why', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'alembic-agent-runtime-digest-cross-'));
    try {
      mkdirSync(path.join(root, 'tools'), { recursive: true });
      writeFileSync(path.join(root, PEM_FILE), PEM_BEFORE, 'utf8');
      // 两个 runtime 用同一 id 与 jobId：第二个实例 hydrate 第一个实例写下的台账（跨实例/跨进程续跑视角）。
      const shared = { jobId: 'job-digest-cross', id: 'host-agent' };
      const writer = buildDigestRuntime(root, shared);
      await writer.readPem();
      writeFileSync(path.join(root, PEM_FILE), PEM_AFTER, 'utf8');

      // 独立 oracle：公开工厂打开的 store 不持有任何摘要，只能按脱敏哈希比对（现状，含已知盲区）。
      const oracle = resolveProductionEvidenceLedgerStore(
        createProductionEvidenceLedgerAuthority({
          dataRoot: root,
          jobId: shared.jobId,
          sessionId: shared.id,
          dimensionId: DIMENSION._dimensionMeta.id,
        })
      );
      const expected = oracle.checkFreshness('E-1', PEM_AFTER);

      const reader = buildDigestRuntime(root, shared);
      const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
      await reader.getEvidence('E-1');
      const readerStore = openedStores()[1];
      expect(readerStore?.stats().entries).toBe(1);
      expect(readerStore?.checkFreshness('E-1', PEM_AFTER)).toBe(expected);
      expect(reader.readbacks[0]?.verbatim).toBe(expected === 'fresh');
      const logs = freshnessLogs(debug);
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(line).toContain('redacted-hash');
        expect(line).toContain('no-source-digest');
        expect(line).not.toContain('def str');
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

/** 一次真实工具轮（meta 工具）后以文本收尾的 runtime 夹具；capabilities 由用例决定。 */
function buildToolRoundRuntime(capabilities: Capability[]) {
  const catalog = new RuntimeCapabilityCatalog();
  const execute = vi.fn(async (): Promise<ToolResultEnvelope> => successEnvelope());
  const provider = new AiProvider({ model: 'fixture' });
  vi.spyOn(provider, 'chatWithTools')
    .mockResolvedValueOnce({
      text: null,
      functionCalls: [{ id: 'call', name: 'meta', args: { action: 'tools', params: {} } }],
    })
    .mockResolvedValue({ text: 'done', functionCalls: [] });
  const runtime = new AgentRuntime({
    aiProvider: provider,
    toolRegistry: new UnifiedToolCatalog(),
    container: { get: () => catalog },
    additionalTools: ['meta'],
    capabilities,
    toolRouter: {
      execute,
      executeChildCall: execute,
      explain: async () => ({ allowed: true, stage: 'execute' }),
    },
    strategy: new SingleStrategy(),
  });
  return { runtime, execute };
}

/** 读取类成员上方 JSDoc 的原文；没有 JSDoc 时返回空串。 */
function memberJsDoc(sourceFile: ts.SourceFile, className: string, memberName: string): string {
  const owner = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  const member = owner?.members.find(
    (candidate) =>
      ts.isMethodDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === memberName
  );
  if (!member) {
    throw new Error(`${className}.${memberName} not found`);
  }
  return ts
    .getJSDocCommentsAndTags(member)
    .map((node) => node.getText(sourceFile))
    .join('\n');
}

describe('agent runtime capability step hooks', () => {
  it('does not drive the empty Capability step hooks across a tool round', async () => {
    const probe = new StepHookProbe();
    const { runtime, execute } = buildToolRoundRuntime([probe]);

    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 3, timeoutMs: 1_000 },
    });

    // 工具轮真实发生（前置与后置钩子的旧调用点都会被经过），但运行循环不再驱动步骤钩子。
    expect(execute).toHaveBeenCalledOnce();
    expect(result.reply).toBe('done');
    expect(probe.before).not.toHaveBeenCalled();
    expect(probe.after).not.toHaveBeenCalled();
  });

  it('does not copy message history per capability across a tool round', async () => {
    // 旧实现每轮为每个能力调用 ctx.messages.toMessages() 复制整份历史。对照同一夹具在
    // capabilities=[] 与 [probe] 下的历史快照次数：只要按能力复制历史（即使不再调用钩子），两者就不相等。
    const countHistoryCopies = async (capabilities: Capability[]) => {
      const simple = vi.spyOn(SimpleArrayAdapter.prototype, 'toMessages');
      const windowed = vi.spyOn(ContextWindowAdapter.prototype, 'toMessages');
      try {
        const { runtime, execute } = buildToolRoundRuntime(capabilities);
        const result = await runtime.reactLoop('fixture', {
          budgetOverride: { maxIterations: 3, timeoutMs: 1_000 },
        });
        expect(execute).toHaveBeenCalledOnce();
        expect(result.reply).toBe('done');
        return simple.mock.calls.length + windowed.mock.calls.length;
      } finally {
        simple.mockRestore();
        windowed.mockRestore();
      }
    };

    const baseline = await countHistoryCopies([]);
    const withProbes = await countHistoryCopies([new StepHookProbe(), new StepHookProbe()]);

    // baseline > 0 证明 spy 挂在本次运行实际使用的消息适配器上，而不是空转。
    expect(baseline).toBeGreaterThan(0);
    expect(withProbes).toBe(baseline);
  });

  it('documents on the public Capability base class that the run loop never calls the step hooks', () => {
    const file = path.join(srcRoot, 'tools', 'runtime', 'toolsets', 'Capability.ts');
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    for (const hook of ['onBeforeStep', 'onAfterStep']) {
      const doc = memberJsDoc(sourceFile, 'Capability', hook);
      // Capability 是公开导出：覆盖钩子的宿主子类必须能从基类契约上看到“不会被调用”，并拿到替代入口。
      expect({ hook, notCalled: doc.includes('运行循环不调用此钩子') }).toEqual({
        hook,
        notCalled: true,
      });
      expect({ hook, replacement: doc.includes('agent:iteration:') }).toEqual({
        hook,
        replacement: true,
      });
    }
  });

  it('does not describe the step hooks as driven by the run loop in the lifecycle docs', () => {
    const doc = readFileSync(path.join(process.cwd(), 'docs', 'execution-lifecycle.md'), 'utf8');
    expect(doc).not.toContain('Capability `onAfterStep` 前关闭');
    expect(doc).toContain('步骤钩子不由运行循环驱动');
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
    // W2a-06（L5-P39）：FanOutStrategy 已删除，内部 barrel 不再导出它。
    expect(Object.keys(strategiesBarrel).sort()).toEqual(['SingleStrategy', 'Strategy']);
  });

  it('does not declare an unread logger on the PipelineRuntime contract', () => {
    const contracts = readFileSync(
      path.join(srcRoot, 'agent', 'strategies', 'pipeline', 'contracts.ts'),
      'utf8'
    );
    expect(pipelineRuntimeDeclaresLogger(contracts)).toBe(false);
  });

  it('detects a logger member on PipelineRuntime in any declaration form', () => {
    // 守护的判定本身也要可信：readonly、可选与方法写法都算声明；同名注释或其他接口不算。
    const cases: Array<[string, boolean]> = [
      ['export interface PipelineRuntime {\n  id: string;\n  logger?: unknown;\n}\n', true],
      [
        'export interface PipelineRuntime {\n  id: string;\n  readonly logger?: unknown;\n}\n',
        true,
      ],
      ['export interface PipelineRuntime {\n  id: string;\n  logger(): void;\n}\n', true],
      [
        'export interface PipelineRuntime {\n  id: string;\n  // logger: removed\n}\nexport interface Other {\n  logger: unknown;\n}\n',
        false,
      ],
    ];
    for (const [text, declared] of cases) {
      expect({ text, declared: pipelineRuntimeDeclaresLogger(text) }).toEqual({ text, declared });
    }
  });

  it('declares the grounding enforcement literal union only once', () => {
    const declarations = walkSource(srcRoot)
      .map((filePath) => ({
        file: path.relative(process.cwd(), filePath).split(path.sep).join('/'),
        count: countGroundingLiteralUnions(filePath, readFileSync(filePath, 'utf8')),
      }))
      .filter(({ count }) => count > 0);

    expect(declarations).toEqual([{ file: 'src/agent/runtime/AgentRuntimeTypes.ts', count: 1 }]);
  });

  it('counts only exact off/guard literal unions as grounding enforcement re-declarations', () => {
    // 更大的无关联合、注释与字符串里的同样字面量不算重写；属性、参数、别名里的二元联合都算。
    const cases: Array<[string, number]> = [
      ["export type UnrelatedMode = 'off' | 'guard' | 'strict';\n", 0],
      ["// mode: 'off' | 'guard'\n/** 'guard' | 'off' */\nconst note = \"'off' | 'guard'\";\n", 0],
      ["type X = 'guard' | 'off';\n", 1],
      ["interface Y {\n  groundingEnforcement?: 'off' | 'guard';\n}\n", 1],
      ["function f(mode: 'off' | 'guard' | undefined) {\n  return mode;\n}\n", 1],
    ];
    for (const [text, count] of cases) {
      expect({ text, count: countGroundingLiteralUnions('fixture.ts', text) }).toEqual({
        text,
        count,
      });
    }
  });
});

/**
 * W2a-06（审阅包 L5-P39 / L8-P17）：运行时策略与记忆声明的空传递收口。
 *
 * - FanOutStrategy 没有生产调用方，随 resolveStrategy 的 'fan_out' 分支一并删除；跨维度扇出只由 profile 的
 *   concurrency 计划经 AgentRunCoordinator 执行。'fan_out' 现在与任何未知词汇一样在构建时抛错。
 * - preset/profile 的 memory 声明此前经 RuntimeConfig.memory → AgentRuntime#memoryConfig →
 *   SystemPromptBuilder → buildContext({ memoryMode }) 一路传下去，但没有任何能力读取 memoryMode。
 *   这条空传递删除后系统提示必须逐字节不变；记忆是否参与仍由运行上下文的 memoryCoordinator 决定。
 */
describe('runtime strategy and memory pass-through retirement (W2a-06)', () => {
  /** 删除前在 HEAD 录制的三个 preset 基础系统提示 sha256（lang 未设、无项目概况、无文件缓存）。 */
  const PRESET_PROMPT_SHA256: Record<string, string> = {
    chat: '0e6b532e0bb6b992f9ccbd1100d9c3955d5a2c49229f35bafeac4af42d6511e9',
    insight: '0cc4776dcc2acf674cb87776f02f314946e177da51ae55cd35344a8c3a8641b4',
    evolution: '9c2bc80817a6c3ae4256d24f96c13dfc9fb4a1163de7a44ff8d261d442c07533',
  };

  /** 经 AgentRuntimeBuilder 按 preset 构建真实 runtime，跑一轮直接以文本收尾的 reactLoop。 */
  async function capturePresetPrompt(preset: string) {
    const catalog = new RuntimeCapabilityCatalog();
    const provider = new AiProvider({ model: 'fixture' });
    vi.spyOn(provider, 'chatWithTools').mockResolvedValue({ text: 'done', functionCalls: [] });
    const build = vi.spyOn(SystemPromptBuilder.prototype, 'build');
    const runtime = new AgentRuntimeBuilder({
      container: { get: () => catalog },
      toolRegistry: new UnifiedToolCatalog(),
      toolRouter: {
        execute: vi.fn(),
        explain: async () => ({ allowed: true, stage: 'execute' }),
      },
      aiProvider: provider,
    }).build({ preset });
    const buildContext = (runtime.capabilities as Capability[]).map((capability) =>
      vi.spyOn(capability, 'buildContext')
    );
    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 1, timeoutMs: 1_000 },
    });
    expect(result.reply).toBe('done');
    expect(build).toHaveBeenCalledOnce();
    const prompt = String(build.mock.results[0]?.value);
    return {
      runtime,
      prompt,
      sha256: createHash('sha256').update(prompt).digest('hex'),
      contextArgs: buildContext.flatMap((spy) => spy.mock.calls.map(([context]) => context)),
    };
  }

  it('deletes FanOutStrategy and rejects the fan_out runtime vocabulary at build time', () => {
    expect(existsSync(path.join(srcRoot, 'agent', 'strategies', 'FanOutStrategy.ts'))).toBe(false);
    expect(() => resolveStrategy({ type: 'fan_out' })).toThrow('Unknown strategy type: fan_out');
    expect(() => getPreset('chat', { strategy: { type: 'fan_out' } })).toThrow(
      'Unknown strategy type: fan_out'
    );
    // 保留的运行时词汇照常解析。
    expect(resolveStrategy({ type: 'single' }).name).toBe('single');
    expect(resolveStrategy({ type: 'pipeline', stages: [] }).name).toBe('pipeline');
    expect(resolveStrategy(undefined).name).toBe('single');
  });

  it('does not keep a memoryConfig on the runtime', () => {
    const runtime = new AgentRuntime(minimalRuntimeConfig());
    expect('memoryConfig' in runtime).toBe(false);
  });

  it.each([
    'chat',
    'insight',
    'evolution',
  ])('builds the %s preset system prompt byte-identically without passing memoryMode to capabilities', async (preset) => {
    const { runtime, sha256, contextArgs } = await capturePresetPrompt(preset);
    expect('memoryConfig' in runtime).toBe(false);
    // 每个能力的 buildContext 都被调用过（chat 有 conversation 能力，其余 preset 的能力列表可能为空）。
    expect(contextArgs).toHaveLength((runtime.capabilities as Capability[]).length);
    for (const context of contextArgs) {
      // 用键集合判断：旧实现即使 preset 没有 mode 也会写入值为 undefined 的 memoryMode 键。
      expect(Object.keys(context as Record<string, unknown>).sort()).toEqual(['lang']);
    }
    expect({ preset, sha256 }).toEqual({ preset, sha256: PRESET_PROMPT_SHA256[preset] });
  });
});
