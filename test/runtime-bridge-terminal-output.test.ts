/**
 * L3-P7c 回归（审计补修 c5f0406）：D23 私有字段清理只约束结构化结果的字段，不解析也不改写
 * 不透明内容。真实 terminal 工具的 stdout 是字符串：ToolRouterAdapter 把它同时放进
 * structuredContent 与 text，runtimeBridge 不能把这段字符串当成 JSON 载体解析，否则
 * “键名只是数据”的条目（依赖包名、文件路径、符号名）会被按私有 token 删除，输出被重新
 * 排版，超过嵌套护栏的深层 JSON 即使不含任何私有字段也会被换成占位。
 *
 * 夹具走真实链路：真实 ToolRouterAdapter + 真实 terminal handler（只把宿主 sandboxExecutor
 * 换成返回固定 stdout 的桩）→ executeRuntimeToolCall，读返回值与 metadata.envelope。
 */
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import { ToolRouterAdapter } from '../src/tools/runtime/index.js';

const PRIVATE_FIELD_WARNING_CODES = [
  'TOOL_RESULT_PRIVATE_FIELDS_REDACTED',
  'TOOL_RESULT_PRIVATE_FIELD_SCAN_NORMALIZED',
];

function freshMetadata(): ToolMetadata {
  return { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
}

/** 真实 adapter + 真实 terminal handler；宿主执行端口只返回固定 stdout。 */
function terminalRun(stdout: string) {
  const exec = vi.fn(async () => ({ stdout, stderr: '', exitCode: 0 }));
  const adapter = new ToolRouterAdapter({
    contextFactory: {
      create: () => ({
        projectRoot: process.cwd(),
        tokenBudget: 64000,
        sandboxExecutor: { exec },
      }),
    },
  });
  const diagnostics = new DiagnosticsCollector();
  const warn = vi.fn();
  const context = {
    runtime: {
      id: 'terminal-output-runtime',
      presetName: 'terminal-output-preset',
      policies: {},
      toolRouter: adapter,
      logger: { warn },
    },
    loopCtx: {
      allowedToolIds: ['terminal'],
      allowedToolActions: {},
      iteration: 1,
      source: 'terminal-output-source',
      diagnostics,
    },
    iteration: 1,
  } as unknown as ToolPipelineContext;
  return { context, diagnostics, exec, warn };
}

function terminalCall(command: string) {
  return {
    id: 'terminal-call',
    name: 'terminal',
    args: { action: 'exec', params: { command } },
  };
}

async function runTerminal(stdout: string) {
  const run = terminalRun(stdout);
  const metadata = freshMetadata();
  const result = await executeRuntimeToolCall(
    terminalCall('cat package.json'),
    run.context,
    metadata
  );
  return { ...run, metadata, result };
}

/** 模型与下游读到的三份载体都必须与 stdout 原文全等，且没有私有字段清理诊断。 */
function expectVerbatim(stdout: string, outcome: Awaited<ReturnType<typeof runTerminal>>): void {
  expect(outcome.exec).toHaveBeenCalledOnce();
  expect(outcome.result).toBe(stdout);
  expect(outcome.metadata.envelope?.structuredContent).toBe(stdout);
  expect(outcome.metadata.envelope?.text).toBe(stdout);
  const codes = outcome.diagnostics.toJSON().warnings.map((warning) => warning.code);
  for (const code of PRIVATE_FIELD_WARNING_CODES) {
    expect(codes).not.toContain(code);
  }
  expect(JSON.stringify(outcome.warn.mock.calls)).not.toMatch(/TOOL_RESULT_PRIVATE_FIELD/);
}

describe('runtime bridge keeps terminal stdout opaque (L3-P7c)', () => {
  it('passes JSON-shaped stdout through verbatim, including dependency names that contain a private token', async () => {
    const stdout =
      '{"name":"app","dependencies":{"express-api-key-auth":"^1.0.0","react":"^18.3.1"},"scripts":{"test":"vitest"}}';

    const outcome = await runTerminal(stdout);

    expectVerbatim(stdout, outcome);
    expect(String(outcome.result)).toContain('express-api-key-auth');
  });

  it('keeps keys that are data entries (symbol names, file paths, nested words) in JSON stdout', async () => {
    const stdout = JSON.stringify({
      symbols: { APIKeyManager: 'class', ThreadIdentifier: 'struct' },
      files: { 'Sources/API/KeyStore.swift': 120 },
      thread: { idle: true },
      openapi: { keywords: ['spec'] },
      reasoning: { content: 'parsed from a fixture file' },
      host: { credentialsConfigured: false },
    });

    const outcome = await runTerminal(stdout);

    expectVerbatim(stdout, outcome);
    for (const kept of [
      'APIKeyManager',
      'ThreadIdentifier',
      'Sources/API/KeyStore.swift',
      '"idle"',
      '"keywords"',
      '"content"',
      'credentialsConfigured',
    ]) {
      expect(String(outcome.result)).toContain(kept);
    }
  });

  it('keeps deeply nested JSON stdout without private fields instead of hollowing it', async () => {
    let stdout = JSON.stringify({ leaf: 'ok' });
    for (let depth = 0; depth < 70; depth++) {
      stdout = `{"child":${stdout}}`;
    }

    const outcome = await runTerminal(stdout);

    expectVerbatim(stdout, outcome);
    expect(String(outcome.result)).toContain('"leaf":"ok"');
    expect(String(outcome.result)).not.toContain('[unavailable: display limit]');
  });

  it('keeps pretty-printed stdout byte-for-byte instead of re-serializing it', async () => {
    const stdout = '[\n    {"name": "api-key-rotation", "threadId": "printed by the command"}\n]';

    const outcome = await runTerminal(stdout);

    // 命令输出里的 "threadId" 是不透明文本，不是结构化结果字段；D23 不解析、不改写。
    expectVerbatim(stdout, outcome);
  });
});
