import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, test, vi } from 'vitest';
import {
  type RunScanAgentTaskOptions,
  runScanAgentTask,
  toScanFileCache,
} from '../src/agent/runs/scan/ScanAgentRun.js';
import { projectScanRunResult } from '../src/agent/runs/scan/ScanRunProjection.js';
import type { ToolCallEntry } from '../src/agent/runtime/AgentRuntimeTypes.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunStatus,
} from '../src/agent/service/AgentRunContracts.js';
import type { AgentService } from '../src/agent/service/AgentService.js';
import { SystemRunContextFactory } from '../src/agent/service/SystemRunContextFactory.js';

function knowledgeCall(result: unknown): ToolCallEntry {
  return {
    tool: 'knowledge',
    args: { action: 'submit', params: {} },
    result,
    durationMs: 1,
  };
}

function runResult(toolCalls: ToolCallEntry[]): AgentRunResult {
  return {
    runId: 'scan-run-1',
    profileId: 'scan-extract',
    reply: '{"recipes":[]}',
    status: 'success',
    toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}

describe('ScanRunProjection persisted Recipe identity', () => {
  test('projects a knowledge.submit created envelope as an existing staging Recipe', () => {
    const readiness = {
      ready: false,
      schemaVersion: 'recipe-retrieval-readiness-v1',
      profileHash: 'profile-hash',
      documentSetHash: 'document-set-hash',
      violations: [{ code: 'retrieval.profile.fact-ungrounded' }],
      warnings: [],
    };

    const projection = projectScanRunResult({
      label: 'RecipeModule',
      task: 'extract',
      result: runResult([
        knowledgeCall({
          status: 'created',
          id: 'recipe-persisted-1',
          title: 'Persisted module Recipe',
          lifecycle: 'staging',
          readiness,
        }),
      ]),
      fallback: (label) => ({ targetName: label, recipes: [] }),
    });

    expect(projection).toMatchObject({
      targetName: 'RecipeModule',
      extracted: 1,
      recipes: [
        {
          status: 'created',
          id: 'recipe-persisted-1',
          candidateId: 'recipe-persisted-1',
          title: 'Persisted module Recipe',
          lifecycle: 'staging',
          readiness,
        },
      ],
    });
  });

  test('keeps only persisted pending or staging created envelopes from a mixed batch', () => {
    const projection = projectScanRunResult({
      label: 'MixedModule',
      task: 'extract',
      result: runResult([
        knowledgeCall({ status: 'rejected', id: 'rejected-id', lifecycle: 'pending' }),
        knowledgeCall({ status: 'failed', id: 'failed-id', lifecycle: 'pending' }),
        knowledgeCall({ status: 'duplicate_blocked', id: 'duplicate-id', lifecycle: 'pending' }),
        knowledgeCall({ error: 'gateway failed before persistence' }),
        knowledgeCall({ status: 'collected', recipe: { id: 'legacy-fake-id' } }),
        knowledgeCall({ status: 'created', id: 'active-id', lifecycle: 'active' }),
        knowledgeCall({ status: 'created', id: '', lifecycle: 'pending' }),
        knowledgeCall({
          status: 'created',
          id: 'pending-id',
          candidateId: 'provider-spoofed-id',
          title: 'Pending persisted Recipe',
          lifecycle: 'pending',
          readiness: { ready: false, violations: [], warnings: [] },
        }),
        knowledgeCall({
          status: 'created',
          id: 'staging-id',
          title: 'Staging persisted Recipe',
          lifecycle: 'staging',
          readiness: { ready: true, violations: [], warnings: [] },
        }),
      ]),
      fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
    });

    expect(projection).toMatchObject({
      extracted: 2,
      recipes: [
        { id: 'pending-id', candidateId: 'pending-id', lifecycle: 'pending' },
        { id: 'staging-id', candidateId: 'staging-id', lifecycle: 'staging' },
      ],
    });
  });

  test('returns no Recipes when the production scan never submits provider output', () => {
    const result = runResult([]);
    result.reply = JSON.stringify({
      targetName: 'UnpersistedModule',
      extracted: 1,
      recipes: [{ title: 'Provider-only candidate without a persisted ID' }],
    });

    const projection = projectScanRunResult({
      label: 'UnpersistedModule',
      task: 'extract',
      result,
      fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
    });

    expect(projection).toMatchObject({
      targetName: 'UnpersistedModule',
      extracted: 0,
      recipes: [],
      diagnostics: {
        persistenceOutcome: 'no-submit-attempt',
        projectionAuthority: 'persisted-knowledge-submit-results-only',
        knowledgeSubmitCallCount: 0,
        ignoredUnpersistedOutput: true,
        usedFallback: true,
      },
    });
  });

  test('does not manufacture a Recipe from provider text after rejected or failed submits', () => {
    const result = runResult([
      knowledgeCall({ status: 'rejected', reason: 'invalid profile' }),
      knowledgeCall({ error: 'gateway unavailable' }),
    ]);
    result.reply = JSON.stringify({
      targetName: 'RejectedModule',
      extracted: 1,
      recipes: [{ id: 'provider-invented-id', lifecycle: 'staging' }],
    });

    const projection = projectScanRunResult({
      label: 'RejectedModule',
      task: 'extract',
      result,
      fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
    });

    expect(projection).toMatchObject({
      targetName: 'RejectedModule',
      extracted: 0,
      recipes: [],
      diagnostics: {
        persistenceOutcome: 'submit-without-created-recipe',
        projectionAuthority: 'persisted-knowledge-submit-results-only',
        knowledgeSubmitCallCount: 2,
        ignoredUnpersistedOutput: true,
        usedFallback: true,
      },
    });
  });

  test('summarize projection retains the persisted Recipe identity and readiness', () => {
    const projection = projectScanRunResult({
      label: 'SummaryModule',
      task: 'summarize',
      result: runResult([
        knowledgeCall({
          status: 'created',
          id: 'summary-recipe-id',
          title: 'Summary persisted Recipe',
          lifecycle: 'pending',
          readiness: {
            ready: false,
            violations: [{ code: 'retrieval.profile.missing' }],
            warnings: [],
          },
        }),
      ]),
      fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
    });

    expect(projection).toMatchObject({
      status: 'created',
      id: 'summary-recipe-id',
      candidateId: 'summary-recipe-id',
      lifecycle: 'pending',
      readiness: {
        ready: false,
        violations: [{ code: 'retrieval.profile.missing' }],
      },
      recipes: [{ id: 'summary-recipe-id', candidateId: 'summary-recipe-id' }],
      extracted: 1,
    });
  });
});

describe('scan observation truth and partial failures', () => {
  function runResult(
    toolCalls: ToolCallEntry[] = [],
    status: AgentRunStatus = 'success'
  ): AgentRunResult {
    return {
      runId: 'fixture',
      profileId: 'scan-extract',
      reply: 'finished',
      status,
      toolCalls,
      usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
      diagnostics: null,
    };
  }
  function submitted(result: unknown, envelope?: unknown): ToolCallEntry {
    return {
      tool: 'knowledge',
      args: { action: 'submit', params: { title: 'Verified', supersedes: 'old-recipe' } },
      result,
      durationMs: 1,
      ...(envelope ? { envelope: envelope as ToolCallEntry['envelope'] } : {}),
    };
  }
  const created = { status: 'created', id: 'real-recipe', lifecycle: 'pending' };
  const fallback = (label: string) => ({ targetName: label, extracted: 0, recipes: [] });

  it('never projects a created payload inside an explicitly failed receipt', () => {
    const result = projectScanRunResult({
      label: 'fixture',
      task: 'extract',
      result: runResult([submitted(created, { ok: false, status: 'blocked', text: 'denied' })]),
      fallback,
    });
    expect(result.recipes).toEqual([]);
  });
  it('keeps created results wrapped in a successful host envelope', () => {
    const payload = { ok: true, data: created };
    const result = projectScanRunResult({
      label: 'fixture',
      task: 'extract',
      result: runResult([
        submitted(payload, {
          ok: true,
          status: 'success',
          text: 'confirmed',
          structuredContent: payload,
        }),
      ]),
      fallback,
    });
    expect(result.extracted).toBe(1);
  });
  it.each([
    false,
    true,
  ])('does not hide scan timeout while preserving confirmed partial receipts=%s', (withCreated) => {
    const result = projectScanRunResult({
      label: 'fixture',
      task: 'extract',
      result: runResult(withCreated ? [submitted(created)] : [], 'timeout'),
      fallback,
    });
    expect(result.error).toBeTruthy();
    expect(result.extracted).toBe(withCreated ? 1 : 0);
  });
});

it.each([
  '__proto__',
  'constructor',
  'toString',
])('rejects inherited scan task %s before creating a run', async (task) => {
  const run = vi.fn(async () => {
    throw new Error('must not start a provider run');
  });
  await expect(
    runScanAgentTask({
      agentService: { run } as unknown as AgentService,
      systemRunContextFactory: new SystemRunContextFactory(),
      task: task as RunScanAgentTaskOptions['task'],
    })
  ).rejects.toThrow('Unknown scan task');
  expect(run).not.toHaveBeenCalled();
});

// L8-P11 / L8-C08：扫描入口契约字段。
// - 回退分支（0 次 submit、submit 未产出 created 回执）经 observeSafely 通知 onParseError，并记一条 warn；
//   有 created 回执时不通知；观察者或日志抛错都不能把回退升级为 reject。
// - toScanFileCache 透传 per-file language，缺省时不新增键（形状与旧版一致）。
// - 诊断用 knowledgeCallCount 统计全部 knowledge 调用；旧键 collectScanRecipeCallCount 过渡保留；
//   恒为 null 的 parseError 已删除。
describe('scan entry contract fields (L8-C08)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function scanResult(
    toolCalls: ToolCallEntry[] = [],
    status: AgentRunStatus = 'success'
  ): AgentRunResult {
    return {
      runId: 'scan-contract',
      profileId: 'scan-extract',
      reply: '{"recipes":[{"title":"provider only"}]}',
      status,
      toolCalls,
      usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
      diagnostics: null,
    };
  }
  function knowledge(action: string, result: unknown): ToolCallEntry {
    return { tool: 'knowledge', args: { action, params: {} }, result, durationMs: 1 };
  }
  const fallback = (label: string) => ({ targetName: label, extracted: 0, recipes: [] });

  it.each([
    {
      name: 'no submit attempt',
      toolCalls: [] as ToolCallEntry[],
      status: 'success' as AgentRunStatus,
      task: 'extract' as const,
      persistenceOutcome: 'no-submit-attempt',
    },
    {
      name: 'rejected submit',
      toolCalls: [knowledge('submit', { status: 'rejected', reason: 'invalid profile' })],
      status: 'success' as AgentRunStatus,
      task: 'summarize' as const,
      persistenceOutcome: 'submit-without-created-recipe',
    },
    {
      name: 'timeout without receipt',
      toolCalls: [] as ToolCallEntry[],
      status: 'timeout' as AgentRunStatus,
      task: 'extract' as const,
      persistenceOutcome: 'no-submit-attempt',
    },
  ])('notifies onParseError once and warns for the $name fallback', ({
    toolCalls,
    status,
    task,
    persistenceOutcome,
  }) => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const onParseError = vi.fn();

    const projection = projectScanRunResult({
      label: 'FallbackModule',
      task,
      result: scanResult(toolCalls, status),
      fallback,
      onParseError,
    });

    expect(projection).toMatchObject({
      targetName: 'FallbackModule',
      extracted: 0,
      recipes: [],
      diagnostics: { usedFallback: true, persistenceOutcome, runStatus: status, task },
    });
    expect(onParseError).toHaveBeenCalledTimes(1);
    const err = onParseError.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('label=FallbackModule');
    expect(message).toContain(`task=${task}`);
    expect(message).toContain(`runStatus=${status}`);
    expect(message).toContain(`persistenceOutcome=${persistenceOutcome}`);
    // 诊断不能带出 provider 回复正文。
    expect(message).not.toContain('provider only');

    expect(warn).toHaveBeenCalledTimes(1);
    const [warnMessage, warnMeta] = warn.mock.calls[0] ?? [];
    expect(String(warnMessage)).toContain('[ScanRun]');
    expect(String(warnMessage)).not.toContain('provider only');
    expect(warnMeta).toMatchObject({
      reasonCode: 'scan-unpersisted-fallback',
      label: 'FallbackModule',
      task,
      runStatus: status,
      persistenceOutcome,
      resolution: 'task-fallback',
    });
  });

  it('does not notify onParseError or warn when a created receipt is persisted', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const onParseError = vi.fn();

    const projection = projectScanRunResult({
      label: 'PersistedModule',
      task: 'extract',
      result: scanResult([
        knowledge('submit', { status: 'created', id: 'persisted-id', lifecycle: 'pending' }),
      ]),
      fallback,
      onParseError,
    });

    expect(projection.extracted).toBe(1);
    expect(onParseError).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('still returns the fallback when the observer or the logger throws', () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
      throw new Error('logger failed');
    });

    const projection = projectScanRunResult({
      label: 'ThrowingObserver',
      task: 'extract',
      result: scanResult(),
      fallback,
      onParseError: () => {
        throw new Error('observer failed');
      },
    });

    expect(projection).toMatchObject({
      targetName: 'ThrowingObserver',
      extracted: 0,
      recipes: [],
      diagnostics: { usedFallback: true, persistenceOutcome: 'no-submit-attempt' },
    });
  });

  it('runScanAgentTask forwards onParseError to the fallback branch', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const onParseError = vi.fn();
    const run = vi.fn(async () => scanResult([], 'success'));

    const projection = await runScanAgentTask({
      agentService: { run } as unknown as AgentService,
      systemRunContextFactory: new SystemRunContextFactory(),
      label: 'HostSummarize',
      task: 'summarize',
      files: [{ name: 'code', content: 'let a = 1' }],
      onParseError,
    });

    expect(projection).toMatchObject({ diagnostics: { usedFallback: true } });
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect((onParseError.mock.calls[0]?.[0] as Error).message).toContain('task=summarize');
  });

  it('keeps per-file language in the scan file cache and omits it when absent', () => {
    expect(
      toScanFileCache([
        { name: 'code', content: 'let a = 1', language: 'swift' },
        { relativePath: 'src/a.ts', content: 'export const a = 1;' },
      ])
    ).toStrictEqual([
      { relativePath: 'code', name: 'code', content: 'let a = 1', language: 'swift' },
      { relativePath: 'src/a.ts', name: 'src/a.ts', content: 'export const a = 1;' },
    ]);
  });

  it('runScanAgentTask passes per-file language into the run file cache', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const inputs: AgentRunInput[] = [];
    const run = vi.fn(async (input: AgentRunInput) => {
      inputs.push(input);
      return scanResult();
    });

    await runScanAgentTask({
      agentService: { run } as unknown as AgentService,
      systemRunContextFactory: new SystemRunContextFactory(),
      label: 'LanguageModule',
      files: [{ name: 'code', content: 'fn main() {}', language: 'rust' }],
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.context.fileCache).toStrictEqual([
      { relativePath: 'code', name: 'code', content: 'fn main() {}', language: 'rust' },
    ]);
  });

  it('reports knowledgeCallCount, keeps the deprecated alias and drops parseError', () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const projection = projectScanRunResult({
      label: 'CountModule',
      task: 'extract',
      result: scanResult([
        knowledge('search', { items: [] }),
        knowledge('get', { id: 'x' }),
        knowledge('submit', { status: 'rejected' }),
        { tool: 'code', args: { action: 'read' }, result: 'source', durationMs: 1 },
      ]),
      fallback,
    });

    const diagnostics = projection.diagnostics as Record<string, unknown>;
    expect(diagnostics).toMatchObject({
      toolCallCount: 4,
      knowledgeCallCount: 3,
      collectScanRecipeCallCount: 3,
      knowledgeSubmitCallCount: 1,
    });
    expect(diagnostics).not.toHaveProperty('parseError');
  });
});
