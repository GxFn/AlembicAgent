/**
 * L3-C03 回归：工具信封 durationMs 必须来自单调时钟，墙钟回拨不能产生被严格守卫拒绝的信封；
 * 消费端遇到守卫失败的信封时只把 envelope.text 交给模型，并留下可定位诊断。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { limitToolResult } from '../src/agent/context/ContextWindow.js';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { SimpleArrayAdapter } from '../src/agent/runtime/MessageAdapter.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import { projectToolReceipt, readRejectedEnvelopeText } from '../src/agent/runtime/toolReceipt.js';
import {
  isToolResultEnvelope,
  type ToolCallRequest,
  type ToolResultEnvelope,
} from '../src/tools/kernel/index.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import type { ToolContext } from '../src/tools/runtime/index.js';

const QUOTA = { maxChars: 4000, maxMatches: 10 };

afterEach(() => {
  vi.restoreAllMocks();
});

/** 第一次读取作为 t0，之后墙钟回拨 37ms，模拟 NTP step / 手动改时间。 */
function rewindWallClockAfterFirstRead() {
  let calls = 0;
  const base = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? base : base - 37));
}

function knowledgeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    toolId: 'knowledge',
    args: { action: 'detail', params: { id: 'duration-fixture' } },
    surface: 'runtime',
    actor: { role: 'developer', user: 'duration-test' },
    source: { kind: 'runtime', name: 'duration-test' },
    ...overrides,
  };
}

function adapterWith(create: () => ToolContext, getAvailability?: () => undefined) {
  return new ToolRouterAdapter({
    contextFactory: { create, ...(getAvailability ? { getAvailability } : {}) },
  });
}

const knowledgeContext = (): ToolContext => ({
  projectRoot: process.cwd(),
  tokenBudget: 4000,
  knowledgeRead: { getById: async () => ({ id: 'duration-fixture', title: 'Fixture' }) },
});

/** 用真实信封做底，再注入非法 durationMs，模拟守卫失败的生产信封。 */
async function negativeDurationEnvelope(): Promise<ToolResultEnvelope> {
  const envelope = await adapterWith(knowledgeContext).execute(knowledgeRequest());
  expect(isToolResultEnvelope(envelope)).toBe(true);
  return { ...envelope, durationMs: -37 };
}

describe('ToolRouterAdapter durationMs under a rewinding wall clock', () => {
  it.each([
    'success',
    'admission-denied',
    'availability-aborted',
    'thrown',
  ] as const)('produces a non-negative, guard-valid envelope on the %s path', async (path) => {
    const controller = new AbortController();
    const adapter =
      path === 'thrown'
        ? adapterWith(() => {
            throw new Error('fixture context failure');
          })
        : path === 'availability-aborted'
          ? adapterWith(knowledgeContext, () => {
              controller.abort();
              return undefined;
            })
          : adapterWith(knowledgeContext);
    const request = knowledgeRequest({
      ...(path === 'admission-denied'
        ? { runtime: { allowedTools: { code: null } } as ToolCallRequest['runtime'] }
        : {}),
      ...(path === 'availability-aborted' ? { abortSignal: controller.signal } : {}),
    });

    rewindWallClockAfterFirstRead();
    const envelope = await adapter.execute(request);
    vi.restoreAllMocks();

    const expectedStatus = {
      success: 'success',
      'admission-denied': 'blocked',
      'availability-aborted': 'aborted',
      thrown: 'error',
    }[path];
    expect(envelope.status).toBe(expectedStatus);
    expect(envelope.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(envelope.durationMs)).toBe(true);
    expect(isToolResultEnvelope(envelope)).toBe(true);
  });
});

describe('runtime bridge metadata.durationMs', () => {
  it('stays non-negative when the wall clock steps back during host dispatch', async () => {
    const envelope = await adapterWith(knowledgeContext).execute(knowledgeRequest());
    const context = {
      runtime: {
        id: 'duration-runtime',
        presetName: 'duration-preset',
        policies: {},
        toolRouter: { execute: async () => envelope },
      },
      loopCtx: { allowedToolIds: ['knowledge'], allowedToolActions: {}, iteration: 0 },
      iteration: 0,
    } as unknown as ToolPipelineContext;
    const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };

    rewindWallClockAfterFirstRead();
    await executeRuntimeToolCall(
      { id: 'call-1', name: 'knowledge', args: { action: 'detail', params: { id: 'x' } } },
      context,
      metadata
    );
    vi.restoreAllMocks();

    expect(metadata.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(metadata.durationMs)).toBe(true);
  });
});

describe('receipt projection of a guard-rejected envelope', () => {
  it('feeds envelope.text to the model and flags the rejection', async () => {
    const envelope = await negativeDurationEnvelope();
    expect(isToolResultEnvelope(envelope)).toBe(false);
    for (const tool of ['knowledge', 'graph']) {
      const projection = projectToolReceipt(
        {
          tool,
          args: { action: 'detail' },
          result: envelope.structuredContent,
          envelope,
          durationMs: 0,
        },
        QUOTA
      );
      expect(projection.text).toBe(limitToolResult(tool, envelope.text, QUOTA));
      expect(projection.text).not.toContain('"callId"');
      expect(projection.text).not.toContain('"trust"');
      expect(projection.envelopeShapeRejected).toBe(true);
    }
  });

  it('does not flag a guard-valid envelope', async () => {
    const envelope = await adapterWith(knowledgeContext).execute(knowledgeRequest());
    const projection = projectToolReceipt(
      { tool: 'knowledge', args: {}, result: envelope.structuredContent, envelope, durationMs: 0 },
      QUOTA
    );
    expect(projection.text).toBe(limitToolResult('knowledge', envelope.text, QUOTA));
    expect(projection.envelopeShapeRejected).toBe(false);
  });

  it('reads the fallback text only from an own string data property, never an accessor', async () => {
    const envelope = await negativeDurationEnvelope();
    const getter = vi.fn(() => 'accessor text');
    const hostile = Object.defineProperty({ ...envelope }, 'text', { get: getter });
    expect(readRejectedEnvelopeText(hostile)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(readRejectedEnvelopeText({ ...envelope, text: 42 })).toBeUndefined();
    expect(readRejectedEnvelopeText(Object.create(envelope))).toBeUndefined();
    expect(readRejectedEnvelopeText(envelope)).toBe(envelope.text);
  });
});

describe('MessageAdapter.formatToolResult with a guard-rejected envelope', () => {
  it('formats envelope.text and logs a TOOL_ENVELOPE_SHAPE_REJECTED warning', async () => {
    const envelope = await negativeDurationEnvelope();
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const adapter = new SimpleArrayAdapter();
    const text = adapter.formatToolResult('knowledge', envelope);
    expect(text).toBe(limitToolResult('knowledge', envelope.text, adapter.getToolResultQuota()));
    expect(text).not.toContain('"callId"');
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('TOOL_ENVELOPE_SHAPE_REJECTED'))).toBe(true);
    expect(messages.some((message) => message.includes('knowledge'))).toBe(true);
  });

  it('leaves ordinary tool results untouched and silent', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const adapter = new SimpleArrayAdapter();
    const result = { matches: [], total: 0 };
    expect(adapter.formatToolResult('graph', result)).toBe(
      limitToolResult('graph', result, adapter.getToolResultQuota())
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('AgentRuntime receipt diagnostics', () => {
  it('records TOOL_ENVELOPE_SHAPE_REJECTED and keeps envelope internals out of model history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-envelope-duration-'));
    try {
      await writeFile(join(root, 'small.ts'), 'export const marker = 1;\n');
      class NegativeDurationRouter extends ToolRouterAdapter {
        override async execute(request: ToolCallRequest): Promise<ToolResultEnvelope> {
          return { ...(await super.execute(request)), durationMs: -37 };
        }
      }
      const router = new NegativeDurationRouter({
        contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 8000 }) },
      });
      const responses: Array<Record<string, unknown>> = [
        {
          functionCalls: [
            { id: 'a', name: 'code', args: { action: 'read', params: { path: 'small.ts' } } },
          ],
        },
        { text: 'done' },
      ];
      const chatWithTools = vi.fn(async () => responses.shift() ?? { text: 'done' });
      const runtime = new AgentRuntime({
        aiProvider: { name: 'mock', chatWithTools } as never,
        toolRegistry: new RuntimeCapabilityCatalog(),
        container: { get: () => new RuntimeCapabilityCatalog() },
        toolRouter: router,
        projectRoot: root,
        additionalTools: ['code'],
        policies: new PolicyEngine([new BudgetPolicy({ maxIterations: 4, timeoutMs: 5000 })]),
      });
      const result = await runtime.reactLoop('read once');
      expect(result.diagnostics?.warnings).toContainEqual(
        expect.objectContaining({ code: 'TOOL_ENVELOPE_SHAPE_REJECTED', tool: 'code' })
      );
      const secondCall = JSON.stringify(chatWithTools.mock.calls[1] ?? []);
      expect(secondCall).toContain('marker');
      expect(secondCall).not.toContain('\\"containsUntrustedText\\"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
