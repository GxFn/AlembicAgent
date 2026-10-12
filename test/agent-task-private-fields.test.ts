/**
 * L3-C02 回归（任务出口）：AgentTaskHandlers.projectTaskToolEnvelope 在带 structuredContent
 * 时原样返回宿主路由结果，D23 秘密/私有字段因此进入任务输出、AI 提示和错误消息。
 * invokeToolEnvelope 由宿主注入（真实宿主即 /api/v1/ai/agent/task 的路由），这里用它的
 * 信封形状做夹具；任务处理器本身走真实代码。
 */
import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  type TaskContext,
  taskCheckAndSubmit,
  taskGuardFullScan,
} from '../src/agent/tasks/index.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';

const SECRET_VALUES = [
  'fixture-api-key-value',
  'fixture-thread-id-value',
  'fixture-reasoning-value',
] as const;

function envelope(
  structuredContent: unknown,
  overrides: Partial<ToolResultEnvelope> = {}
): ToolResultEnvelope {
  return {
    ok: true,
    status: 'success',
    toolId: 'task-tool',
    callId: 'task-tool-call',
    startedAt: '2026-10-11T00:00:00.000Z',
    durationMs: 1,
    text:
      structuredContent === undefined ? 'host summary' : JSON.stringify(structuredContent, null, 2),
    structuredContent,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
    ...overrides,
  };
}

function taskContext(result: ToolResultEnvelope) {
  const warn = vi.fn();
  const chat = vi.fn(async () => 'UNIQUE');
  const chatWithStructuredOutput = vi.fn(async () => []);
  const context: TaskContext = {
    invokeToolEnvelope: vi.fn(async () => result),
    aiProvider: { chat, chatWithStructuredOutput },
    container: { get: () => undefined },
    logger: { warn },
  };
  return { context, warn, chat, chatWithStructuredOutput };
}

function expectNoSecretValues(serialized: string) {
  for (const secret of SECRET_VALUES) {
    expect(serialized).not.toContain(secret);
  }
}

describe('agent task D23 private fields', () => {
  it('removes private fields from a structured guard result and keeps violation messages', async () => {
    const result = envelope({
      violationCount: 1,
      reasoningContent: 'fixture-reasoning-value',
      violations: [
        {
          severity: 'error',
          message: 'kept violation message',
          line: 3,
          threadId: 'fixture-thread-id-value',
          meta: { 'api-key': 'fixture-api-key-value' },
        },
      ],
    });
    const { context, warn, chatWithStructuredOutput } = taskContext(result);

    const output = await taskGuardFullScan(context, { code: 'const value = 1;' });

    expectNoSecretValues(JSON.stringify(output));
    expect(output).toMatchObject({
      violationCount: 1,
      violations: [{ severity: 'error', message: 'kept violation message', line: 3, meta: {} }],
    });
    expectNoSecretValues(JSON.stringify(chatWithStructuredOutput.mock.calls));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('TOOL_RESULT_PRIVATE_FIELDS_REDACTED');
    expect(logged).toContain('guard_check_code');
    expectNoSecretValues(logged);
    // 宿主原信封不被改写。
    expect(JSON.stringify(result.structuredContent)).toContain('fixture-api-key-value');
  });

  it('keeps private values out of the invalid-result error and its cause', async () => {
    const result = envelope({ similar: 'not-an-array', apiKey: 'fixture-api-key-value' });
    const { context } = taskContext(result);

    const failure = await taskCheckAndSubmit(context, { candidate: { title: 'Candidate' } }).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('check_duplicate');
    expectNoSecretValues((failure as Error).message);
    expectNoSecretValues(JSON.stringify((failure as Error).cause));
    expect((failure as Error).cause).toMatchObject({ ok: true, status: 'success' });
  });

  it('keeps private values out of a failed envelope error but keeps its nested error.message', async () => {
    const result = envelope(undefined, {
      ok: false,
      status: 'error',
      text: JSON.stringify({
        error: { code: 403, message: 'permission denied', threadId: 'fixture-thread-id-value' },
      }),
    });
    const { context } = taskContext(result);

    const failure = await taskGuardFullScan(context, { code: 'const value = 1;' }).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('permission denied');
    expectNoSecretValues((failure as Error).message);
    expectNoSecretValues(JSON.stringify((failure as Error).cause));
  });

  it('removes a private field spelled as a nested object path from the task output', async () => {
    const result = envelope({
      violationCount: 0,
      violations: [],
      session: { thread: { id: 'fixture-thread-id-value', label: 'kept label' } },
      provider: { api: { key: 'fixture-api-key-value' } },
    });
    const { context, warn } = taskContext(result);

    const output = await taskGuardFullScan(context, { code: 'const value = 1;' });

    expectNoSecretValues(JSON.stringify(output));
    expect(output).toMatchObject({ violationCount: 0, violations: [] });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('session.thread.id');
    expect(logged).toContain('provider.api.key');
    expectNoSecretValues(logged);
  });

  it('falls back to the shared Core logger when the host injects no usable logger', async () => {
    const result = envelope({ violationCount: 0, violations: [], apiKey: 'fixture-api-key-value' });
    const { context } = taskContext(result);
    context.logger = { info: () => undefined };
    const coreWarn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const output = await taskGuardFullScan(context, { code: 'const value = 1;' });

      expectNoSecretValues(JSON.stringify(output));
      expect(coreWarn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(coreWarn.mock.calls);
      expect(logged).toContain('TOOL_RESULT_PRIVATE_FIELDS_REDACTED');
      expectNoSecretValues(logged);
    } finally {
      coreWarn.mockRestore();
    }
  });

  it('keeps the task result and reports through Core when the host logger throws', async () => {
    const result = envelope({
      violationCount: 0,
      violations: [],
      threadId: 'fixture-thread-id-value',
    });
    const { context } = taskContext(result);
    context.logger = {
      warn: () => {
        throw new Error('logger unavailable');
      },
    };
    const coreWarn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const output = await taskGuardFullScan(context, { code: 'const value = 1;' });

      expectNoSecretValues(JSON.stringify(output));
      expect(output).toMatchObject({ violationCount: 0, violations: [] });
      expect(coreWarn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(coreWarn.mock.calls);
      expect(logged).toContain('host logger failed');
      expect(logged).not.toContain('logger unavailable');
      expectNoSecretValues(logged);
    } finally {
      coreWarn.mockRestore();
    }
  });

  it('keeps the host envelope identity and stays silent when nothing is private', async () => {
    const result = envelope({ violationCount: 0, violations: [] }, { status: 'partial' });
    const { context, warn } = taskContext(result);

    const failure = await taskGuardFullScan(context, { code: 'const value = 1;' }).then(
      () => null,
      (err: unknown) => err
    );

    expect((failure as Error).cause).toBe(result);
    expect(warn).not.toHaveBeenCalled();
  });
});
