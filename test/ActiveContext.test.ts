import { describe, expect, it } from 'vitest';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';

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

describe('ActiveContext observation ledger', () => {
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
