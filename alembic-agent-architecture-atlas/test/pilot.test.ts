/** 图谱样板：只在临时目录执行产品源码；模型是脚本，Service/Builder/Runtime/Router/handler 均是真实现。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LLMResult } from '../../src/agent/runtime/AgentRuntimeTypes.js';
import type { AgentRunInput, AgentRunResult } from '../../src/agent/service/AgentRunContracts.js';
import { AgentRuntimeBuilder } from '../../src/agent/service/AgentRuntimeBuilder.js';
import { AgentService } from '../../src/agent/service/AgentService.js';
import type { ToolCallRequest } from '../../src/tools/kernel/request.js';
import { RuntimeCapabilityCatalog } from '../../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { TOOL_REGISTRY } from '../../src/tools/runtime/registry.js';
// 该辅助模块同时服务 CLI；Vitest 在 Node 中加载，不进入浏览器包。
// @ts-expect-error CLI helper has no ambient declaration.
import { fingerprint, gitInfo, hash } from '../scripts/atlas-lib.mjs';

const atlasRoot = resolve(import.meta.dirname, '..');
const productRoot = resolve(atlasRoot, '..');
const roots: string[] = [];
const observations: Array<Record<string, unknown>> = [];
const sourcePatterns = ['src/**/*.ts', 'package.json', 'tsconfig.json'];
const inputFingerprint = fingerprint(productRoot, sourcePatterns).digest;
const testFingerprint = hash(readFileSync(join(atlasRoot, 'test/pilot.test.ts')));
const harnessPatterns = [
  'test/pilot.test.ts',
  'vitest.config.ts',
  'package.json',
  'package-lock.json',
  'scripts/atlas-lib.mjs',
  'scripts/snapshot-store.mjs',
  'scripts/maintenance.mjs',
  'scripts/evidence.mjs',
  'scripts/relations.mjs',
  'scripts/public-entrypoints.mjs',
  'scripts/render-contract.mjs',
  'scripts/render-state.mjs',
  'metadata.schema.json',
];
const harnessFingerprint = fingerprint(atlasRoot, harnessPatterns).digest;
const usage = { inputTokens: 13, outputTokens: 5 };
const finish: LLMResult = { text: '已核对工具回执。', functionCalls: [], usage };

function readReply(paths = ['sample.ts']): LLMResult {
  return {
    text: null,
    functionCalls: [
      {
        id: 'pilot-read',
        name: 'code',
        args: {
          action: 'read',
          params: { filePaths: paths },
        },
      },
    ],
    usage,
  };
}

function assemble(provider: { chatWithTools: (...args: unknown[]) => Promise<LLMResult> }) {
  const root = mkdtempSync(join(tmpdir(), 'agent-atlas-pilot-'));
  roots.push(root);
  writeFileSync(join(root, 'sample.ts'), 'export const answer = 42;\n');
  const catalog = new RuntimeCapabilityCatalog();
  const contextFactory = {
    create: vi.fn((request: ToolCallRequest) => ({
      projectRoot: root,
      tokenBudget: 8_000,
      runtime: request.runtime,
      abortSignal: request.abortSignal,
    })),
  };
  const router = new ToolRouterAdapter({ contextFactory });
  // spy 只观察，保留真实调用；没有替换 Builder、Runtime 或 Router 的实现。
  const dispatch = vi.spyOn(router, 'execute');
  const builder = new AgentRuntimeBuilder({
    container: { get: (name: string) => (name === 'capabilityCatalog' ? catalog : undefined) },
    aiProvider: { name: 'scripted-fixture', model: 'no-network', ...provider },
    // 当前合同把目录与执行端口分开；旧 getRouter 兜底已退役。
    toolRegistry: { has: (id: string) => Boolean(TOOL_REGISTRY[id]), getManifest: () => null },
    toolRouter: router,
    projectRoot: root,
    dataRoot: root,
  });
  const build = vi.spyOn(builder, 'build');
  const service = new AgentService({ runtimeBuilder: builder });
  const input: AgentRunInput = {
    profile: {
      basePreset: 'chat',
      skills: [],
      strategy: { type: 'single' },
      actionSpace: { mode: 'listed', toolIds: ['code'] },
      params: { maxIterations: 4 },
    },
    message: { content: '读取 sample.ts 并确认工具结果。' },
    context: { source: 'http-chat' },
    execution: { timeoutMs: 3_000 },
  };
  return { service, input, dispatch, build, contextFactory };
}

function record(id: string, result: AgentRunResult, dispatches: number, claim: string) {
  observations.push({
    id,
    status: 'pass',
    fullName: expect.getState().currentTestName,
    serviceStatus: result.status,
    toolStatuses: result.toolCalls.map((call) => call.envelope?.status ?? 'pipeline-result'),
    toolReceipts: result.toolCalls.length,
    routerDispatches: dispatches,
    assertion: claim,
  });
}

beforeAll(() => {
  // 开跑就替换当前状态；中断或同字节失败不能继续展示上一次 pass。历史快照保留旧回执。
  writeFileSync(
    join(atlasRoot, 'evidence/pilot.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: 'running',
        checkedAt: new Date().toISOString(),
        sourcePatterns,
        sourceFingerprint: inputFingerprint,
        testFingerprint,
        harnessPatterns,
        harnessFingerprint,
        scenarios: [],
      },
      null,
      2,
    )}\n`,
  );
});

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  const finalFingerprint = fingerprint(productRoot, sourcePatterns).digest;
  const stable =
    inputFingerprint === finalFingerprint &&
    harnessFingerprint === fingerprint(atlasRoot, harnessPatterns).digest;
  const evidence = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    status: observations.length === 6 && stable ? 'pass' : 'fail',
    command: 'npm run test:pilot',
    baselineCommit: gitInfo(productRoot).commit,
    sourcePatterns,
    sourceFingerprint: inputFingerprint,
    testFingerprint,
    harnessPatterns,
    harnessFingerprint,
    inputStableDuringRun: stable,
    executionEnvironment: { node: process.version, platform: process.platform, arch: process.arch },
    real: [
      'AgentService',
      'AgentProfileCompiler',
      'AgentRuntimeBuilder',
      'SingleStrategy',
      'AgentRuntime',
      'ToolExecutionPipeline',
      'ToolRouterAdapter',
      'ToolRouter',
      'code.read',
    ],
    controlled: ['scripted AI provider', 'temporary filesystem', 'host context factory'],
    unverified: [
      'live provider/network',
      'external host entrypoint',
      'Core durable persistence',
      'terminal sandbox',
      'knowledge publication',
      'all product tests',
    ],
    scenarios: observations,
  };
  mkdirSync(join(atlasRoot, 'evidence'), { recursive: true });
  writeFileSync(join(atlasRoot, 'evidence/pilot.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  if (!stable) {
    throw new Error('Pilot source or harness changed during execution');
  }
});

function secondTurnToolText(options: unknown): string {
  if (
    !options ||
    typeof options !== 'object' ||
    !('messages' in options) ||
    !Array.isArray(options.messages)
  ) {
    throw new Error('Expected provider options with messages');
  }
  const message = options.messages.find((m: unknown) =>
    Boolean(
      m &&
        typeof m === 'object' &&
        'role' in m &&
        m.role === 'tool' &&
        'toolCallId' in m &&
        m.toolCallId === 'pilot-read',
    ),
  );
  if (!message || typeof message.content !== 'string') {
    throw new Error('Confirmed tool reply was not found in second turn');
  }
  return message.content;
}

describe('一次请求到工具回执：真实组合样板', () => {
  it('success: receipt is returned to the second model turn and projected by Service', async () => {
    const chatWithTools = vi.fn().mockResolvedValueOnce(readReply()).mockResolvedValueOnce(finish);
    const h = assemble({ chatWithTools });
    const result = await h.service.run(h.input);
    expect(h.build).toHaveBeenCalledOnce();
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.contextFactory.create).toHaveBeenCalledOnce();
    expect(result.status).toBe('success');
    expect(result.reply).toBe(finish.text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].envelope).toMatchObject({
      ok: true,
      status: 'success',
      toolId: 'code',
    });
    expect(secondTurnToolText(chatWithTools.mock.calls[1][1])).toContain('answer = 42');
    expect(result.toolCalls[0].envelope?.trust.containsUntrustedText).toBe(true);
    record(
      'success',
      result,
      h.dispatch.mock.calls.length,
      '真实读取→信封→下一轮模型输入→Service.toolCalls，内容与不可信标记保留。',
    );
  });

  it('denied: an unadvertised tool never reaches the host router', async () => {
    const chatWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [
          {
            id: 'pilot-denied',
            name: 'terminal',
            args: { action: 'exec', params: { command: 'pwd' } },
          },
        ],
        usage,
      })
      .mockResolvedValueOnce(finish);
    const h = assemble({ chatWithTools });
    const result = await h.service.run(h.input);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.contextFactory.create).not.toHaveBeenCalled();
    expect(result.diagnostics?.blockedTools.length).toBeGreaterThan(0);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].result).toMatchObject({
      error: expect.stringContaining('terminal'),
    });
    expect(result.toolCalls[0].envelope).toBeUndefined();
    expect(result.status).toBe('success');
    record(
      'denied',
      result,
      0,
      '不在阶段白名单的 terminal 在管线短路；工具拒绝与整次 Service 状态分别记录。',
    );
  });

  it('cancel-before: preflight cancellation skips builder, model and router', async () => {
    const chatWithTools = vi.fn();
    const h = assemble({ chatWithTools });
    const controller = new AbortController();
    controller.abort();
    h.input.execution = { abortSignal: controller.signal };
    const result = await h.service.run(h.input);
    expect(result.status).toBe('aborted');
    expect(h.build).not.toHaveBeenCalled();
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    record('cancel-before', result, 0, 'Service 预检取消，没有创建 Runtime 或分配宿主工具上下文。');
  });

  it('cancel-after: confirmed receipt survives interruption before the next turn', async () => {
    const controller = new AbortController();
    const chatWithTools = vi.fn().mockResolvedValueOnce(readReply()).mockResolvedValue(finish);
    const h = assemble({ chatWithTools });
    h.input.execution = { abortSignal: controller.signal, onToolCall: () => controller.abort() };
    const result = await h.service.run(h.input);
    expect(result.status).toBe('aborted');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].envelope).toMatchObject({ ok: true, status: 'success' });
    expect(chatWithTools).toHaveBeenCalledOnce();
    expect(h.dispatch).toHaveBeenCalledOnce();
    record(
      'cancel-after',
      result,
      1,
      '回执已确认后取消，保留该回执且不再调用模型；不推导外部副作用回滚。',
    );
  });

  it('timeout: owned deadline returns a timeout without fabricating a receipt', async () => {
    const chatWithTools = vi.fn(() => new Promise<LLMResult>(() => {}));
    const h = assemble({ chatWithTools });
    h.input.execution = { timeoutMs: 120 };
    const result = await h.service.run(h.input);
    expect(result.status).toBe('timeout');
    expect(chatWithTools).toHaveBeenCalledOnce();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(0);
    record('timeout', result, 0, '模型端口挂起时由运行边界截止；返回 timeout，零工具回执。');
  });

  it('partial: one missing file preserves the successful read in a partial envelope', async () => {
    const chatWithTools = vi
      .fn()
      .mockResolvedValueOnce(readReply(['sample.ts', 'missing.ts']))
      .mockResolvedValueOnce(finish);
    const h = assemble({ chatWithTools });
    const result = await h.service.run(h.input);
    expect(result.status).toBe('success');
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].envelope?.status).toBe('partial');
    expect(JSON.stringify(result.toolCalls[0].envelope)).toContain('answer = 42');
    const toolText = secondTurnToolText(chatWithTools.mock.calls[1][1]);
    expect(toolText).toContain('answer = 42');
    expect(toolText).toContain('missing.ts');
    expect(toolText).toMatch(/error|不存在|not found|ENOENT/i);
    record(
      'partial',
      result,
      1,
      '批量读取一成一败保留成功内容与 partial，不把最终模型回复成功解释为所有工具成功。',
    );
  });
});
