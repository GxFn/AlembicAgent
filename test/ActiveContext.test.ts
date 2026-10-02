import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, test, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { readPersistentMemorySection } from '../src/agent/memory/MemoryPrompt.js';
import { SessionStore } from '../src/agent/memory/SessionStore.js';
import { estimateTokens } from '../src/shared/tokenUtils.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';
import type { ToolContext } from '../src/tools/kernel/registry.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';
import { createTempProject } from './helpers/tempProject.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function envelope(
  overrides: Partial<ToolResultEnvelope> & {
    structuredContent?: unknown;
    text?: string;
  }
): ToolResultEnvelope {
  const ok = overrides.ok ?? true;
  return {
    ok,
    toolId: overrides.toolId || 'code',
    callId: overrides.callId || 'ledger-call-1',
    startedAt: overrides.startedAt || '2026-05-25T00:00:00.000Z',
    durationMs: overrides.durationMs ?? 12,
    status: overrides.status || (ok ? 'success' : 'error'),
    text: overrides.text || 'ok',
    structuredContent: overrides.structuredContent,
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
    ...(overrides.nextActionHint ? { nextActionHint: overrides.nextActionHint } : {}),
  };
}

describe('ActiveContext observation retention configuration', () => {
  it.each([
    -1,
    -Infinity,
    Infinity,
    Number.NaN,
    1.5,
  ])('rejects invalid maxRecentRounds=%s before recording any observations', (maxRecentRounds) => {
    expect(() => new ActiveContext({ maxRecentRounds })).toThrow(RangeError);
  });

  it('rejects an invalid scope without replacing the current active context', () => {
    const coordinator = new MemoryCoordinator();
    const current = coordinator.createDimensionScope('current');
    expect(() => coordinator.createDimensionScope('invalid', { maxRecentRounds: -1 })).toThrow(
      RangeError
    );
    expect(coordinator.getActiveContext()).toBe(current);
    expect(coordinator.getActiveContext('invalid')).toBeNull();
  });

  it.each([
    { maxRecentRounds: undefined, compressedCount: 1 },
    { maxRecentRounds: 0, compressedCount: 4 },
    { maxRecentRounds: 2, compressedCount: 2 },
  ])('preserves direct and scoped maxRecentRounds=$maxRecentRounds behavior', ({
    maxRecentRounds,
    compressedCount,
  }) => {
    const coordinator = new MemoryCoordinator();
    for (const context of [
      new ActiveContext({ maxRecentRounds }),
      coordinator.createDimensionScope('scope', { maxRecentRounds }),
    ]) {
      for (let round = 1; round <= 4; round++) {
        context.observe('code', { path: 'src/fixture.ts', content: 'fixture' }, round);
      }
      expect(context.distill()).toMatchObject({ totalObservations: 4, compressedCount });
    }
  });
});

describe('ActiveContext observation ledger', () => {
  it('keeps a high-priority finding when a lower-priority finding exceeds the budget', () => {
    const ctx = new ActiveContext();
    ctx.noteKeyFinding('Critical boundary', 'src/a.ts:1', 9);
    ctx.noteKeyFinding('background '.repeat(500), 'src/b.ts:1', 2);
    expect(ctx.buildContext(100)).toContain('Critical boundary');
    expect(ctx.buildContext(100)).not.toContain('background '.repeat(500));
  });
  it('renders a structured ledger instead of raw compressed observation dumps', () => {
    const ctx = new ActiveContext({ maxRecentRounds: 0 });
    ctx.startRound(1);
    ctx.recordToolCall(
      'code',
      { action: 'read', filePaths: ['src/a.ts', 'src/a.ts', 'src/b.ts'] },
      envelope({
        structuredContent: {
          mode: 'batch',
          files: [
            { ok: true, path: 'src/a.ts', content: 'export const a = 1;' },
            { ok: true, path: 'src/b.ts', content: 'export const b = 1;' },
          ],
        },
      }),
      true
    );
    ctx.recordToolCall(
      'code',
      { action: 'search', patterns: ['ActiveContext', 'ActiveContext'], glob: 'src/**' },
      envelope({
        text: '2 matches (showing 2)\n\nsrc/a.ts:1: ActiveContext\nsrc/b.ts:2: ActiveContext',
      }),
      true
    );
    ctx.recordToolCall(
      'code',
      { action: 'read', path: 'src/missing.ts' },
      envelope({
        ok: false,
        status: 'error',
        text: '{"callId":"raw-1","startedAt":"2026-05-25","durationMs":7,"message":"Cannot read file"}',
        nextActionHint: 'Read src/a.ts or src/b.ts before retrying missing evidence.',
      }),
      true
    );

    const rendered = ctx.buildContext(4000);

    expect(rendered).toContain('## Observation Ledger');
    expect(rendered).toContain('### evidence');
    expect(rendered).toContain('### readSet');
    expect(rendered).toContain('### searchSet');
    expect(rendered).toContain('### failureSet');
    expect(rendered).toContain('### nextHints');
    expect(rendered).not.toContain('之前的探索摘要');
    expect(rendered).not.toContain('callId');
    expect(rendered).not.toContain('startedAt');
    expect(rendered).not.toContain('durationMs');
    expect(rendered).not.toContain('timestamp');
    expect(rendered).not.toContain('{"');
    expect(rendered.match(/src\/a\.ts/g)).toHaveLength(3);
    expect(rendered.match(/ActiveContext in src\/\*\*/g)).toHaveLength(2);
  });

  it('keeps scratchpad findings ahead of the observation ledger', () => {
    const ctx = new ActiveContext({ maxRecentRounds: 0 });
    ctx.noteKeyFinding(
      'Confirmed provider input boundary',
      'src/agent/runtime/AgentRuntime.ts:852',
      9
    );
    ctx.recordToolCall(
      'code',
      { action: 'read', path: 'src/agent/runtime/AgentRuntime.ts' },
      envelope({
        structuredContent: {
          path: 'src/agent/runtime/AgentRuntime.ts',
          content: 'dynamic context',
        },
      }),
      true
    );

    const rendered = ctx.buildContext(4000);

    expect(rendered).toContain('## 📌 已确认的关键发现');
    expect(rendered).toContain('Confirmed provider input boundary');
    expect(rendered.indexOf('## 📌 已确认的关键发现')).toBeLessThan(
      rendered.indexOf('## Observation Ledger')
    );
  });
});

function createBaseContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: '/tmp/alembic-agent-test',
    tokenBudget: 1000,
    ...overrides,
  };
}

describe('memory.note_finding ActiveContext contract', () => {
  it('does not fall back to sessionStore for structured findings', async () => {
    const sessionStore = {
      save: vi.fn(),
      recall: vi.fn(() => []),
    };

    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidenceRefs: ['E-1'], importance: 8 },
      createBaseContext({ sessionStore })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('active MemoryCoordinator');
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it('passes the dimension scope and returns success only after ActiveContext writes', async () => {
    const noteFinding = vi.fn(() => ({
      recorded: true,
      target: 'activeContext' as const,
      importance: 8,
      message: 'recorded',
      scratchpadSize: 1,
      scopeId: 'architecture:analyst',
    }));

    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidenceRefs: ['E-1'], importance: 8, round: 3 },
      createBaseContext({
        memoryCoordinator: { noteFinding },
        runtime: { dimensionScopeId: 'architecture:analyst' } as never,
      })
    );

    expect(result.ok).toBe(true);
    // E3：无台账 ctx 走降级直存分支（unverified 标注），refs 作第 6 参透传
    expect(noteFinding).toHaveBeenCalledWith(
      'Verified boundary',
      'E-1 (unverified: no evidence ledger in this run)',
      8,
      3,
      'architecture:analyst',
      ['E-1']
    );
    expect(result.data).toMatchObject({
      recorded: true,
      target: 'activeContext',
      scratchpadSize: 1,
    });
  });

  it('reports missing ActiveContext as a failed tool call', async () => {
    const coordinator = new MemoryCoordinator();

    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidenceRefs: ['E-1'], importance: 8 },
      createBaseContext({ memoryCoordinator: coordinator })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('未写入 ActiveContext');
  });

  it('writes through MemoryCoordinator when the scope exists', async () => {
    const coordinator = new MemoryCoordinator();
    coordinator.createDimensionScope('architecture:analyst');

    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidenceRefs: ['E-1'], importance: 8, round: 2 },
      createBaseContext({
        memoryCoordinator: coordinator,
        runtime: { dimensionScopeId: 'architecture:analyst' } as never,
      })
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      recorded: true,
      target: 'activeContext',
      scratchpadSize: 1,
      scopeId: 'architecture:analyst',
    });
  });
});

describe('ExplorationTracker note_finding metrics', () => {
  it('counts only successful ActiveContext note_finding writes', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 12, searchBudget: 8 }
    );
    expect(tracker).not.toBeNull();

    tracker?.recordToolCall(
      'memory',
      { action: 'note_finding' },
      { recorded: true, target: 'sessionStore' }
    );
    tracker?.recordToolCall(
      'memory',
      { action: 'note_finding' },
      { error: 'missing active context' }
    );
    expect(tracker?.metrics.memoryFindingCount).toBe(0);

    tracker?.recordToolCall(
      'memory',
      { action: 'note_finding' },
      { recorded: true, target: 'activeContext' }
    );
    expect(tracker?.metrics.memoryFindingCount).toBe(1);

    tracker?.recordToolCall(
      'note_finding',
      { finding: 'direct call', evidence: 'src/foo.ts:1', importance: 8 },
      { recorded: true, target: 'activeContext' }
    );
    expect(tracker?.metrics.memoryFindingCount).toBe(2);
  });
});

describe('working memory ownership and read budgets', () => {
  it('returns a created scope even when the diagnostic sink rejects the notification', () => {
    const coordinator = new MemoryCoordinator();
    vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => {
      throw new Error('diagnostic sink failed');
    });
    const active = coordinator.createDimensionScope('created-scope');
    expect(coordinator.getActiveContext('created-scope')).toBe(active);
  });
  it('returns a bounded memory section even when a diagnostic logger fails', async () => {
    vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => {
      throw new Error('diagnostic sink failed');
    });
    await expect(
      readPersistentMemorySection(
        { toPromptSection: () => 'memory '.repeat(100) },
        { tokenBudget: 30 }
      )
    ).resolves.toMatchObject({ budget: 30 });
  });

  it('logs and empties a session context built with a NaN host budget instead of throwing', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const store = new SessionStore({ cleanupIntervalMs: 0 });
    try {
      store.storeDimensionReport('previous', { analysisText: 'prior analysis '.repeat(40) });
      expect(store.buildContextForDimension('next', { tokenBudget: Number.NaN })).toBe('');
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes('reason=invalid_budget'))).toBe(true);
      expect(messages.join('\n')).not.toContain('prior analysis');
    } finally {
      store.dispose();
    }
  });

  it('keeps a legal CJK scratchpad prompt within its token budget', () => {
    const context = new ActiveContext();
    context.noteKeyFinding('知识'.repeat(90), 'E-1=src/a.ts:1-2', 9);
    expect(estimateTokens(context.buildContext(100))).toBeLessThanOrEqual(100);
  });

  it('preserves the final observed tools when a dimension is distilled', () => {
    const context = new ActiveContext();
    context.startRound(1);
    for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      context.recordToolCall(
        'code',
        { action: 'read', path },
        { path, content: 'actual source' },
        true
      );
    }
    context.endRound();
    const distilled = context.distill();
    expect(distilled.totalObservations).toBe(3);
    expect(distilled.toolCallSummary).toHaveLength(3);
  });

  it('does not let a toJSON observer replace authoritative finding references', () => {
    const context = new ActiveContext();
    context.noteKeyFinding('Verified result', 'E-1=src/a.ts', 9, 1, ['E-1']);
    const snapshot = context.toJSON();
    snapshot.scratchpad[0].evidenceRefs?.splice(0, 1, 'E-forged');
    expect(context.distill().keyFindings[0].evidenceRefs).toEqual(['E-1']);
  });

  it('does not let getPlan observers alter keywords consumed by exploration tracking', () => {
    const context = new ActiveContext();
    context.setPlan('1. Read AlphaBeta module\n2. Inspect DeltaGamma calls', 1);
    const plan = context.getPlan();
    plan?.steps[0].keywords.push('observer-mutation');
    expect(context.getPlanStepsMutable()[0].keywords).not.toContain('observer-mutation');
  });

  it('owns restored snapshots after caller input is mutated', () => {
    const original = new ActiveContext();
    original.noteKeyFinding('Verified result', 'E-1=src/a.ts', 9, 1, ['E-1']);
    const input = structuredClone(original.toJSON());
    const restored = ActiveContext.fromJSON(input);
    input.scratchpad[0].evidenceRefs?.splice(0, 1, 'E-forged');
    expect(restored.distill().keyFindings[0].evidenceRefs).toEqual(['E-1']);
  });

  it('preserves the real note_finding receipt if a logging observer fails after mutation', async () => {
    const coordinator = new MemoryCoordinator();
    const context = coordinator.createDimensionScope('scope');
    vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => {
      throw new Error('diagnostic sink failed');
    });
    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidenceRefs: ['E-1'], importance: 8 },
      {
        projectRoot: '/tmp/alembic-memory-review',
        tokenBudget: 1000,
        memoryCoordinator: coordinator,
        runtime: { dimensionScopeId: 'scope' },
      } as Parameters<typeof handleMemory>[2]
    );
    expect(context.scratchpadSize).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ recorded: true, target: 'activeContext' });
  });
});

function deferred<T>() {
  return Promise.withResolvers<T>();
}
describe('memory budgets and snapshot regression controls', () => {
  it('counts complete CJK/emoji ledger headers and sections at every small budget', () => {
    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.noteKeyFinding('关键结论😀边界', 'E-1=src/中文.ts:1-4', 9);
    context.noteKeyFinding('小结论', '', 8);
    context.startRound(1);
    context.recordToolCall(
      'code',
      { action: 'read', path: 'src/中文.ts' },
      { path: 'src/中文.ts', content: 'export const value=1' },
      true
    );
    context.recordToolCall(
      'code',
      { action: 'search', pattern: '中文😀', glob: 'src/**' },
      { total: 1, matches: [{ file: 'src/中文.ts', line: 1 }] },
      true
    );
    context.recordToolCall('terminal', { command: 'pwd' }, 'project', true);
    for (let budget = 0; budget <= 260; budget++) {
      const output = context.buildContext(budget);
      expect(estimateTokens(output), `budget=${budget}`).toBeLessThanOrEqual(budget);
      expect(output).not.toContain('truncated due to budget');
    }
  });

  it.each([
    0, 1, 3, 4, 8,
  ])('distills all %i observations without advancing retention state', (count) => {
    const context = new ActiveContext();
    context.startRound(1);
    for (let i = 0; i < count; i++) {
      context.recordToolCall(
        'code',
        { action: 'read', path: `src/${i}.ts` },
        { path: `src/${i}.ts`, content: `line${i}` },
        true
      );
    }
    context.endRound();
    const before = context.toJSON();
    const once = context.distill();
    expect(once.toolCallSummary).toHaveLength(count);
    expect(context.distill()).toEqual(once);
    expect(context.toJSON()).toEqual(before);
  });

  it('keeps nested action and plan history snapshots independent while mutable plan port remains intentional', () => {
    const context = new ActiveContext();
    context.setPlan('1. Read AlphaBeta module\n2. Inspect DeltaGamma calls', 1);
    context.updatePlan('1. Read NewModule scope\n2. Inspect OtherModule calls', 2);
    const history = context.getPlanHistory();
    history[0].steps[0].keywords.push('untrusted');
    expect(context.getPlanHistory()[0].steps[0].keywords).not.toContain('untrusted');
    context.startRound(2);
    context.addAction('code', { action: 'read', params: { path: 'src/a.ts' } });
    const actions = context.getCurrentRoundActions();
    (actions[0].params.params as { path: string }).path = 'src/changed.ts';
    expect(context.getCurrentRoundActions()[0].params.params).toEqual({ path: 'src/a.ts' });
    context.getPlanStepsMutable()[0].status = 'done';
    expect(context.getPlan()?.steps[0].status).toBe('done');
  });

  it('observes rejected asynchronous diagnostics without changing bounded read output', async () => {
    const callback = vi.fn(async () => {
      throw new Error('observer failed');
    });
    const value = await readPersistentMemorySection(
      { toPromptSection: () => 'content '.repeat(100) },
      { tokenBudget: 40, onDiagnostic: callback }
    );
    await Promise.resolve();
    expect(estimateTokens(value.content)).toBeLessThanOrEqual(40);
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each(['abort', 'timeout'])('discards late persistent reads after %s', async (end) => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const reply = deferred<string>();
    const signal = new AbortController();
    const callback = vi.fn();
    let providerSignal: AbortSignal | undefined;
    const pending = readPersistentMemorySection(
      {
        toPromptSection: (options) => {
          providerSignal = options.abortSignal;
          started.resolve();
          return reply.promise;
        },
      },
      { tokenBudget: 40, abortSignal: signal.signal, timeoutMs: 20, onDiagnostic: callback }
    );
    await started.promise;
    if (end === 'abort') {
      signal.abort();
    } else {
      await vi.advanceTimersByTimeAsync(21);
    }
    const value = await pending;
    expect(value.content).toBe('');
    expect(providerSignal?.aborted).toBe(true);
    const count = callback.mock.calls.length;
    reply.resolve('LATE_FACT');
    await Promise.resolve();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });
});

type MemoryHandlerCtx = Parameters<typeof handleMemory>[2];

function makeLedger() {
  const dataRoot = createTempProject('evidence-refs-');
  return new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_1',
    sessionId: 'sess_1',
    dimensionId: 'ts-js-module',
  });
}

interface RecordedNote {
  finding: string;
  evidence: string;
  importance: number;
  round: number;
  scopeId?: string;
  evidenceRefs?: string[];
}

function makeCtx(ledger: EvidenceLedgerStore | null) {
  const recorded: RecordedNote[] = [];
  const coordinator = {
    noteFinding(
      finding: string,
      evidence: string,
      importance: number,
      round: number,
      scopeId?: string,
      evidenceRefs?: string[]
    ) {
      recorded.push({ finding, evidence, importance, round, scopeId, evidenceRefs });
      return {
        recorded: true,
        target: 'activeContext' as const,
        importance,
        message: `📌 已记录发现 [${importance}/10]`,
        scratchpadSize: recorded.length,
      };
    },
  };
  // handler 仅消费 memoryCoordinator 与 runtime.evidenceLedger/dimensionScopeId——最小运行时形态经 unknown 收窄
  const ctx = {
    memoryCoordinator: coordinator,
    runtime: {
      evidenceLedger: ledger,
      dimensionScopeId: 'ts-js-module:analyst',
    },
  } as unknown as MemoryHandlerCtx;
  return { ctx, recorded };
}

describe('note_finding evidenceRefs 硬切（E3，E0 钉 1 反转）', () => {
  test('有效引用：台账机械展开为标签，refs 透传 coordinator', async () => {
    const ledger = makeLedger();
    ledger.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'lib/a.ts',
      range: { start: 5, end: 7 },
      content: 'L5\nL6\nL7',
    });
    const { ctx, recorded } = makeCtx(ledger);
    const result = await handleMemory(
      'note_finding',
      {
        finding: '类型导入使用 import type 严格隔离',
        evidenceRefs: ['E-1', 'E-1@6-6'],
        excerpt: 'L6',
        importance: 8,
      },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].evidence).toBe('E-1=lib/a.ts:5-7; E-1=lib/a.ts:6-6 — L6');
    expect(recorded[0].evidenceRefs).toEqual(['E-1', 'E-1@6-6']);
    expect(recorded[0].scopeId).toBe('ts-js-module:analyst');
  });

  test('捏造引用（file:line 形态）整条拒收，附近期真实候选', async () => {
    const ledger = makeLedger();
    ledger.append({ tool: 'code.read', callId: 'c1', file: 'lib/real.ts', content: 'x' });
    const { ctx, recorded } = makeCtx(ledger);
    const result = await handleMemory(
      'note_finding',
      {
        finding: '捏造样本',
        evidenceRefs: ['Alembic/lib/types/agent.ts:1-7'],
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('无法解析');
    expect(String(result.error)).toContain('E-1=lib/real.ts');
    expect(recorded).toHaveLength(0);
  });

  test('旧 evidence 自由文本参数：迁移拒绝并提示已退役', async () => {
    const { ctx, recorded } = makeCtx(makeLedger());
    const result = await handleMemory(
      'note_finding',
      { finding: '旧形态', evidence: 'src/App.tsx:42', importance: 7 },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('evidenceRefs');
    expect(String(result.error)).toContain('已退役');
    expect(recorded).toHaveLength(0);
  });

  test('无台账场景（非维度 run）：降级直存并显式标注 unverified', async () => {
    const { ctx, recorded } = makeCtx(null);
    const result = await handleMemory(
      'note_finding',
      { finding: '降级场景', evidenceRefs: ['E-3'] },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(recorded[0].evidence).toContain('E-3');
    expect(recorded[0].evidence).toContain('unverified: no evidence ledger');
  });

  test('refs 流转：scratchpad 条目与 distill 投影携带 evidenceRefs（防御性拷贝）', () => {
    const ac = new ActiveContext();
    const refs = ['E-9'];
    ac.noteKeyFinding('发现', 'E-9=lib/z.ts', 8, 1, refs);
    refs.push('E-10'); // 外部数组后续变更不得污染已存条目
    const distilled = ac.distill();
    expect(distilled.keyFindings[0].evidenceRefs).toEqual(['E-9']);
    expect(distilled.keyFindings[0].evidence).toBe('E-9=lib/z.ts');
  });
});

it('keeps storage permissive after finding references are validated by the memory handler', () => {
  const context = new ActiveContext();
  context.noteKeyFinding('类型导入保持隔离', 'E-1=lib/types/agent.d.ts:1-7', 8);
  expect(context.scratchpadSize).toBe(1);
});
