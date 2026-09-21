import { describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';
import type { ToolContext } from '../src/tools/kernel/registry.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';

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
