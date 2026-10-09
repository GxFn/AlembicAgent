import { describe, expect, it } from 'vitest';
import type { AgentDiagnostics } from '../src/agent/runtime/AgentRuntimeTypes.js';
import {
  DiagnosticsCollector,
  isDegradeGateAction,
} from '../src/agent/runtime/DiagnosticsCollector.js';

// 公开入参 AgentRunExecutionOptions.diagnostics / ReactLoopOpts.diagnostics 都是 unknown，
// merge 是外部边界：畸形数组字段必须降级为 diagnostics_invalid_entry 警告，不能让运行在
// 策略执行前就抛 TypeError，也不能把字符串拆成逐字符条目写进快照。
function invalidEntryWarnings(collector: DiagnosticsCollector) {
  return collector
    .toJSON()
    .warnings.filter((warning) => warning.code === 'diagnostics_invalid_entry');
}

describe('DiagnosticsCollector.merge shape guards', () => {
  it.each([
    { label: 'warnings is a plain object', seed: { warnings: {} }, field: 'warnings' },
    { label: 'blockedTools holds null', seed: { blockedTools: [null] }, field: 'blockedTools' },
    {
      label: 'stageToolsets lacks capability arrays',
      seed: { stageToolsets: [{ stage: 'x' }] },
      field: 'stageToolsets',
    },
  ])('does not throw when $label and records one invalid entry', ({ seed, field }) => {
    let collector: DiagnosticsCollector | undefined;
    expect(() => {
      collector = DiagnosticsCollector.from(seed);
    }).not.toThrow();
    const warnings = invalidEntryWarnings(collector as DiagnosticsCollector);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(field);
    const snapshot = (collector as DiagnosticsCollector).toJSON();
    expect(snapshot.blockedTools).toEqual([]);
    expect(snapshot.stageToolsets).toBeUndefined();
    expect(
      snapshot.warnings.filter((warning) => warning.code !== 'diagnostics_invalid_entry')
    ).toEqual([]);
  });

  it('skips a string warning instead of expanding it into per-character entries', () => {
    const collector = DiagnosticsCollector.from({ warnings: ['oops'] });
    const snapshot = collector.toJSON();
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toMatchObject({ code: 'diagnostics_invalid_entry' });
    expect(snapshot.warnings[0]?.message).toContain('warnings');
    expect(snapshot.warnings[0]?.message).toContain('string');
    expect(Object.keys(snapshot.warnings[0] ?? {})).not.toContain('0');
  });

  it('skips a string timedOutStages field instead of splitting it into characters', () => {
    const collector = DiagnosticsCollector.from({ timedOutStages: 'abc' });
    const snapshot = collector.toJSON();
    expect(snapshot.timedOutStages).toEqual([]);
    const warnings = invalidEntryWarnings(collector);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('timedOutStages');
    expect(warnings[0]?.message).toContain('string');
  });

  it('keeps well-formed elements while skipping malformed siblings in the same array', () => {
    const collector = DiagnosticsCollector.from({
      warnings: [{ code: 'ok', message: 'fine' }, { code: 1, message: 'bad' }, 'oops'],
      timedOutStages: ['analysis', 42, null],
      blockedTools: [{ tool: 'shell', reason: 'policy' }, { tool: 'shell' }, 'shell'],
      gateFailures: [{ stage: 'gate', action: 'repair' }, { stage: 'gate' }, { action: 'skip' }],
      toolCalls: [
        {
          tool: 'read',
          callId: 'call-1',
          status: 'ok',
          ok: true,
          startedAt: '2026-01-01T00:00:00.000Z',
          durationMs: 1,
        },
        { tool: 'read', status: 'ok', ok: true },
        null,
      ],
      stageToolsets: [
        { stage: 'analysis', capabilities: ['read'], allowedToolIds: ['read'], toolSchemaCount: 1 },
        { stage: 'analysis', capabilities: 'read', allowedToolIds: ['read'], toolSchemaCount: 1 },
        {
          stage: 'analysis',
          capabilities: ['read'],
          allowedToolIds: ['read'],
          allowedToolActions: { read: 'open' },
          toolSchemaCount: 1,
        },
      ],
    });
    const snapshot = collector.toJSON();
    expect(snapshot.warnings.filter((warning) => warning.code === 'ok')).toHaveLength(1);
    expect(snapshot.timedOutStages).toEqual(['analysis']);
    expect(snapshot.blockedTools).toEqual([{ tool: 'shell', reason: 'policy' }]);
    expect(snapshot.gateFailures).toEqual([{ stage: 'gate', action: 'repair' }]);
    expect(snapshot.toolCalls?.map((call) => call.callId)).toEqual(['call-1']);
    expect(snapshot.stageToolsets).toHaveLength(1);
    expect(snapshot.stageToolsets?.[0]).toMatchObject({
      stage: 'analysis',
      capabilities: ['read'],
    });
    // 每个被跳过的元素各写一条警告，字段名与 typeof 都能从消息里看出来。
    const invalid = invalidEntryWarnings(collector);
    expect(invalid).toHaveLength(12);
    for (const field of [
      'warnings',
      'timedOutStages',
      'blockedTools',
      'gateFailures',
      'toolCalls',
      'stageToolsets',
    ]) {
      expect(invalid.some((warning) => warning.message.includes(field))).toBe(true);
    }
  });

  it('only accepts a string efficiency.cancelReason', () => {
    const collector = DiagnosticsCollector.from({ efficiency: { cancelReason: { reason: 'x' } } });
    expect(collector.toJSON().efficiency.cancelReason).toBeUndefined();
    const warnings = invalidEntryWarnings(collector);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('efficiency.cancelReason');
  });

  it('leaves a well-formed diagnostics snapshot untouched', () => {
    const seed: AgentDiagnostics = {
      degraded: true,
      fallbackUsed: true,
      warnings: [{ code: 'ai_error', message: 'boom', stage: 'analysis', tool: 'read' }],
      timedOutStages: ['analysis'],
      blockedTools: [{ tool: 'shell', reason: 'policy' }],
      truncatedToolCalls: 2,
      emptyResponses: 1,
      aiErrorCount: 1,
      gateFailures: [{ stage: 'gate', action: 'repair', reason: 'thin' }],
      toolCalls: [
        {
          tool: 'read',
          callId: 'call-1',
          status: 'ok',
          ok: true,
          startedAt: '2026-01-01T00:00:00.000Z',
          durationMs: 3,
        },
      ],
      stageToolsets: [
        {
          stage: 'analysis',
          capabilities: ['read'],
          allowedToolIds: ['read'],
          allowedToolActions: { read: ['open'] },
          toolSchemaCount: 1,
          source: 'profile',
        },
      ],
      efficiency: {
        toolCalls: 1,
        duplicateToolCalls: 0,
        cacheHits: 0,
        cacheMisses: 1,
        tokenUsage: { input: 10, output: 5, reasoning: 0, cacheHit: 0 },
        maxCompactionLevel: 1,
        totalCompactedItems: 2,
        nudgeCount: 1,
        replanCount: 0,
        emptyRetries: 0,
        forcedSummary: true,
        cancelReason: 'abort_signal',
      },
    };
    expect(DiagnosticsCollector.from(seed).toJSON()).toEqual(seed);
  });
});

describe('degrade gate action predicate', () => {
  it.each([
    ['degrade', true],
    ['degraded_no_findings', true],
    ['degraded_budget_exhausted', true],
    ['pass', false],
    ['repair', false],
    ['skip', false],
    ['degradex', false],
  ])('classifies %s as degrade=%s', (action, expected) => {
    expect(isDegradeGateAction(action)).toBe(expected);
  });

  it('marks the run degraded when recordGateFailure receives degraded_budget_exhausted', () => {
    const collector = new DiagnosticsCollector();
    collector.recordGateFailure('analysis', 'degraded_budget_exhausted', 'session budget');
    expect(collector.toJSON().degraded).toBe(true);
    expect(collector.toJSON().gateFailures).toEqual([
      { stage: 'analysis', action: 'degraded_budget_exhausted', reason: 'session budget' },
    ]);
  });

  it('marks the run degraded when a merged gate failure carries degraded_budget_exhausted', () => {
    const collector = DiagnosticsCollector.from({
      gateFailures: [{ stage: 'analysis', action: 'degraded_budget_exhausted' }],
    });
    expect(collector.toJSON().degraded).toBe(true);
  });

  it('does not mark non-degrade gate failures as degraded', () => {
    const collector = new DiagnosticsCollector();
    collector.recordGateFailure('analysis', 'repair');
    collector.recordGateFailure('analysis', 'skip');
    expect(collector.toJSON().degraded).toBe(false);
  });
});
