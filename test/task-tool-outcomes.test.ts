import { describe, expect, it, vi } from 'vitest';
import {
  type TaskContext,
  taskCheckAndSubmit,
  taskFullEnrich,
  taskGuardFullScan,
  taskQualityAudit,
} from '../src/agent/tasks/index.js';
import type { ToolResultEnvelope, ToolResultStatus } from '../src/tools/kernel/index.js';
import { ToolRouterAdapter } from '../src/tools/runtime/index.js';

/** 真实任务调用真实adapter；未迁移的旧工具名/参数不能被解释成检查通过。 */
function routedTaskContext(services: Record<string, unknown> = {}) {
  const results: ToolResultEnvelope[] = [];
  const create = vi.fn(() => ({ projectRoot: process.cwd(), tokenBudget: 4000 }));
  const adapter = new ToolRouterAdapter({ contextFactory: { create } });
  const chat = vi.fn(async () => 'UNIQUE');
  const context: TaskContext = {
    invokeToolEnvelope: async (toolName, params) => {
      const result = await adapter.execute({
        toolId: toolName,
        args: params,
        surface: 'system',
        actor: { role: 'agent-task', user: 'task-test' },
        source: { kind: 'system', name: 'task-tool-outcomes' },
      });
      results.push(result);
      return result;
    },
    aiProvider: { chat, chatWithStructuredOutput: vi.fn(async () => []) },
    container: { get: (name) => services[name] },
  };
  return { context, results, create, chat };
}

function toolResult(
  structuredContent: unknown,
  status: ToolResultStatus = 'success',
  ok = status === 'success' || status === 'partial'
): ToolResultEnvelope {
  return {
    ok,
    status,
    toolId: 'task-tool',
    callId: 'task-tool-call',
    startedAt: '2026-09-20T00:00:00.000Z',
    durationMs: 1,
    text: `Actual host outcome: ${status}`,
    structuredContent,
    diagnostics: {
      degraded: status !== 'success',
      fallbackUsed: false,
      warnings: [{ code: 'HOST_OUTCOME', message: 'Original host diagnostic' }],
      timedOutStages: status === 'timeout' ? ['host'] : [],
      blockedTools: status === 'blocked' ? [{ tool: 'task-tool', reason: 'Host policy' }] : [],
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
  };
}

describe('task tool outcomes', () => {
  it('rejects a failed duplicate check from the real router instead of recommending submission', async () => {
    const { context, results, create, chat } = routedTaskContext();

    await expect(
      taskCheckAndSubmit(context, { candidate: { title: 'Candidate' } })
    ).rejects.toMatchObject({
      message: expect.stringContaining('check_duplicate'),
      cause: expect.objectContaining({ ok: false, status: 'error', toolId: 'check_duplicate' }),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toContain('Missing "action"');
    expect(create).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it.each([
    'error',
    'blocked',
    'aborted',
    'timeout',
    'partial',
    'needs-confirmation',
  ] as const)('retains the original %s envelope instead of treating its data as a completed check', async (status) => {
    const result = toolResult({ similar: [{ title: 'Existing', similarity: 0.9 }] }, status);
    const { context, chat } = routedTaskContext();
    context.invokeToolEnvelope = vi.fn(async () => result);

    const failure = await taskCheckAndSubmit(context, { candidate: { title: 'Candidate' } }).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(result.text);
    expect((failure as Error).cause).toBe(result);
    expect(chat).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, status: 'success' },
    { ok: true, status: 'error' },
  ] as const)('requires both a successful status and ok=true: $ok/$status', async ({
    ok,
    status,
  }) => {
    const result = toolResult({ similar: [] }, status, ok);
    const { context } = routedTaskContext();
    context.invokeToolEnvelope = vi.fn(async () => result);
    await expect(
      taskCheckAndSubmit(context, { candidate: { title: 'Candidate' } })
    ).rejects.toMatchObject({ cause: result });
  });

  it.each([
    {
      name: 'full enrichment',
      tool: 'enrich_candidate',
      run: (context: TaskContext) => taskFullEnrich(context),
    },
    {
      name: 'quality audit',
      tool: 'quality_score',
      run: (context: TaskContext) => taskQualityAudit(context),
    },
    {
      name: 'guard scan',
      tool: 'guard_check_code',
      run: (context: TaskContext) => taskGuardFullScan(context, { code: 'const value = 1;' }),
    },
  ])('does not project a real router failure as $name output', async ({ tool, run }) => {
    const { context, results, create } = routedTaskContext({
      knowledgeService: { list: async () => ({ items: [{ id: 'one' }, { id: 'two' }] }) },
    });
    await expect(run(context)).rejects.toMatchObject({
      cause: expect.objectContaining({ ok: false, status: 'error', toolId: tool }),
    });
    expect(results).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(context.aiProvider?.chatWithStructuredOutput).not.toHaveBeenCalled();
  });

  it('stops a quality audit at an incomplete score instead of reporting an unscored recipe as passing', async () => {
    const { context } = routedTaskContext({
      knowledgeService: {
        list: async () => ({ items: [{ id: 'scored' }, { id: 'incomplete' }, { id: 'later' }] }),
      },
    });
    const partial = toolResult({ score: 0.95, grade: 'A', dimensions: {} }, 'partial');
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(toolResult({ score: 0.8, grade: 'B', dimensions: {} }))
      .mockResolvedValueOnce(partial)
      .mockResolvedValue(toolResult({ score: 1, grade: 'A', dimensions: {} }));
    context.invokeToolEnvelope = invoke;

    await expect(taskQualityAudit(context)).rejects.toMatchObject({ cause: partial });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: 'missing content', data: undefined },
    { label: 'null content', data: null },
    { label: 'missing similar', data: {} },
    { label: 'null similar', data: { similar: null } },
    { label: 'non-array similar', data: { similar: {} } },
    { label: 'missing similarity', data: { similar: [{ title: 'Unknown score' }] } },
    { label: 'non-finite similarity', data: { similar: [{ similarity: Number.NaN }] } },
  ])('cannot infer a completed duplicate check from $label', async ({ data }) => {
    const result = toolResult(data);
    const { context, chat } = routedTaskContext();
    context.invokeToolEnvelope = vi.fn(async () => result);
    await expect(taskCheckAndSubmit(context, { candidate: {} })).rejects.toMatchObject({
      cause: result,
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing score', data: { grade: 'A' } },
    { label: 'non-finite score', data: { score: Number.NaN, grade: 'A' } },
    { label: 'missing grade', data: { score: 0.9 } },
    { label: 'empty grade', data: { score: 0.9, grade: ' ' } },
  ])('cannot audit quality from $label', async ({ data }) => {
    const result = toolResult(data);
    const { context } = routedTaskContext({
      knowledgeService: { list: async () => ({ items: [{ id: 'recipe' }] }) },
    });
    context.invokeToolEnvelope = vi.fn(async () => result);
    await expect(taskQualityAudit(context)).rejects.toMatchObject({ cause: result });
  });

  it.each([
    { label: 'missing violation count', data: {} },
    { label: 'negative violation count', data: { violationCount: -1 } },
    { label: 'fractional violation count', data: { violationCount: 0.5 } },
    { label: 'malformed violations', data: { violationCount: 1, violations: [null] } },
  ])('cannot report a guard scan from $label', async ({ data }) => {
    const result = toolResult(data);
    const { context } = routedTaskContext();
    context.invokeToolEnvelope = vi.fn(async () => result);
    await expect(taskGuardFullScan(context, { code: 'const value = 1;' })).rejects.toMatchObject({
      cause: result,
    });
    expect(context.aiProvider?.chatWithStructuredOutput).not.toHaveBeenCalled();
  });

  it.each([
    { similar: [], verdict: 'UNIQUE', recommendation: 'safe_to_submit' },
    {
      similar: [{ title: 'Existing', similarity: 0.9 }],
      verdict: 'DUPLICATE',
      recommendation: 'block_duplicate',
    },
    {
      similar: [{ title: 'Existing', similarity: 0.9 }],
      verdict: 'SIMILAR',
      recommendation: 'review_suggested',
    },
  ])('keeps the completed-check recommendation $recommendation compatible', async ({
    similar,
    verdict,
    recommendation,
  }) => {
    const result = toolResult({ similar });
    // 诊断有warning不等于检查未完成；以回执ok/status为准，避免把降级成功误报失败。
    result.diagnostics.degraded = true;
    const { context, chat } = routedTaskContext();
    context.invokeToolEnvelope = vi.fn(async () => result);
    chat.mockResolvedValue(verdict);

    await expect(
      taskCheckAndSubmit(context, { candidate: { title: 'Candidate' } })
    ).resolves.toEqual({
      duplicates: similar,
      highSimilarity: similar,
      aiVerdict: similar.length > 0 ? verdict : null,
      recommendation,
    });
  });
  it('preserves an invocation rejection that occurred before an envelope was returned', async () => {
    const error = new Error('Host disconnected before responding');
    const { context } = routedTaskContext();
    context.invokeToolEnvelope = vi.fn().mockRejectedValue(error);
    await expect(taskCheckAndSubmit(context, { candidate: {} })).rejects.toBe(error);
  });
});
