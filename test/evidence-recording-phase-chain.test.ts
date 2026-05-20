import { describe, expect, it, vi } from 'vitest';
import { analysisQualityGate } from '../src/agent/prompts/insight-gate.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import type { AgentRuntime, LoopContext } from '../src/agent/runtime/index.js';
import { createToolPipeline, DiagnosticsCollector } from '../src/agent/runtime/index.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

const MISSING_FINDINGS = 'Required memory action note_finding calls are missing';
const INSUFFICIENT_FINDINGS = 'At least 3 memory action note_finding calls are required';

function gateableReport(suggestions: string[], scores = {}) {
  return {
    analysisText:
      '## Finding\nsrc/foo.ts:10 shows the verified implementation detail and src/bar.ts:20 confirms it.',
    referencedFiles: ['src/foo.ts', 'src/bar.ts', 'src/baz.ts'],
    qualityReport: {
      scores: {
        depthScore: 70,
        breadthScore: 60,
        evidenceScore: 40,
        coherenceScore: 70,
        ...scores,
      },
      totalScore: 58,
      suggestions,
    },
  };
}

function createPipelineContext(initialFindings: Array<Record<string, unknown>> = []) {
  const findings = [...initialFindings];
  const activeContext = {
    distill: () => ({ keyFindings: findings, toolCallSummary: [] }),
    noteKeyFinding: (finding: string, evidence: string, importance: number) => {
      findings.push({ finding, evidence, importance });
    },
  };
  const memoryCoordinator = {
    noteFinding: (finding: string, evidence: string, importance: number) => {
      findings.push({ finding, evidence, importance });
      return 'ok';
    },
  };

  return {
    findings,
    strategyContext: {
      activeContext,
      memoryCoordinator,
      sharedState: { _dimensionScopeId: 'dim-agent' },
      source: 'system',
      diagnostics: new DiagnosticsCollector(),
    },
  };
}

function createRecordRepairGate(minFindings = 3) {
  return {
    evaluator: (
      _source: unknown,
      _phaseResults: Record<string, unknown>,
      ctx: Record<string, unknown>
    ) => {
      const activeContext = ctx.activeContext as { distill: () => { keyFindings: unknown[] } };
      const count = activeContext.distill().keyFindings.length;
      const artifact = {
        analysisText:
          '## Runtime boundary\nsrc/foo.ts:10 proves the runtime path and src/bar.ts:20 validates the consumer.',
        referencedFiles: ['src/foo.ts', 'src/bar.ts'],
        findings: activeContext.distill().keyFindings,
        metadata: { memoryFindingCount: count },
      };
      if (count >= minFindings) {
        return { action: 'pass', pass: true, artifact };
      }
      return {
        action: 'record_repair',
        pass: false,
        reason: count === 0 ? MISSING_FINDINGS : INSUFFICIENT_FINDINGS,
        artifact,
      };
    },
    maxRecordRepairRetries: 1,
    recordRepairMinFindings: minFindings,
  };
}

function createStrategy(minFindings = 3) {
  return new PipelineStrategy({
    stages: [
      { name: 'analyze', capabilities: [] },
      { name: 'quality_gate', gate: createRecordRepairGate(minFindings) },
      { name: 'produce', capabilities: [], promptBuilder: () => 'produce' },
    ],
  });
}

describe('evidence recording quality gate actions', () => {
  it('routes adequate analysis with missing note_finding records to record_repair', () => {
    const gate = analysisQualityGate(gateableReport([MISSING_FINDINGS]), {
      outputType: 'candidate',
    });

    expect(gate).toMatchObject({
      pass: false,
      action: 'record_repair',
      reason: MISSING_FINDINGS,
    });
  });

  it('keeps poor analysis on analysis_retry instead of record repair', () => {
    const gate = analysisQualityGate(
      gateableReport([MISSING_FINDINGS], {
        depthScore: 15,
        breadthScore: 10,
        coherenceScore: 30,
      }),
      { outputType: 'candidate' }
    );

    expect(gate).toMatchObject({
      pass: false,
      action: 'analysis_retry',
      reason: MISSING_FINDINGS,
    });
  });
});

describe('record repair pipeline stage', () => {
  it('runs a memory-only repair stage, validates fallback JSON, and rechecks the gate', async () => {
    const { findings, strategyContext } = createPipelineContext([
      { finding: 'Existing runtime finding', evidence: 'src/foo.ts:10', importance: 7 },
      { finding: 'Existing producer finding', evidence: 'src/bar.ts:20', importance: 7 },
    ]);
    const strategy = createStrategy(3);
    const phases: string[] = [];
    const runtime = {
      id: 'record-repair-runtime',
      logger: { info: () => undefined },
      reactLoop: vi.fn(async (_prompt: string, opts: Record<string, unknown>) => {
        const context = opts.context as Record<string, unknown>;
        const phase = String(context.pipelinePhase);
        phases.push(phase);
        if (phase === 'analyze') {
          return {
            reply: 'Analysis references src/foo.ts:10 and src/bar.ts:20.',
            toolCalls: [],
            tokenUsage: { input: 1, output: 1 },
            iterations: 1,
          };
        }
        if (phase === 'quality_gate_record_repair') {
          expect(opts.capabilityOverride).toEqual([]);
          expect(opts.additionalToolsOverride).toEqual(['memory']);
          expect((opts.sharedState as Record<string, unknown>)._recordRepairOnly).toBe(true);
          expect(opts.toolChoiceOverride).toBe('auto');
          return {
            reply: JSON.stringify({
              noteFindings: [
                {
                  finding: 'Repair records the missing verified runtime evidence',
                  evidence: 'src/foo.ts:10',
                  importance: 8,
                },
                {
                  finding: 'Repair rejects evidence outside the analysis artifact',
                  evidence: 'src/outside.ts:1',
                  importance: 8,
                },
              ],
            }),
            toolCalls: [],
            tokenUsage: { input: 1, output: 1 },
            iterations: 1,
          };
        }
        return {
          reply: 'produced',
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        };
      }),
    };

    const result = await strategy.execute(runtime, AgentMessage.internal('analyze then produce'), {
      strategyContext,
    });

    expect(phases).toEqual(['analyze', 'quality_gate_record_repair', 'produce']);
    expect(findings).toHaveLength(3);
    expect(findings[2]).toMatchObject({
      finding: 'Repair records the missing verified runtime evidence',
      evidence: 'src/foo.ts:10',
    });
    expect(result.degraded).toBe(false);
    expect(result.phases?._recordRepairFallback).toMatchObject({ accepted: 1, rejected: 0 });
  });

  it('does not write fallback findings or continue to produce after repair timeout', async () => {
    const { findings, strategyContext } = createPipelineContext();
    const strategy = createStrategy(1);
    const phases: string[] = [];
    const runtime = {
      id: 'record-repair-timeout-runtime',
      logger: { info: () => undefined },
      reactLoop: vi.fn(async (_prompt: string, opts: Record<string, unknown>) => {
        const phase = String((opts.context as Record<string, unknown>).pipelinePhase);
        phases.push(phase);
        if (phase === 'quality_gate_record_repair') {
          return {
            reply:
              '{"noteFindings":[{"finding":"Would be valid but timed out","evidence":"src/foo.ts:10","importance":8}]}',
            toolCalls: [],
            tokenUsage: { input: 0, output: 0 },
            iterations: 0,
            timedOut: true,
          };
        }
        return {
          reply: 'Analysis references src/foo.ts:10.',
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        };
      }),
    };

    const result = await strategy.execute(runtime, AgentMessage.internal('analyze then produce'), {
      strategyContext,
    });

    expect(phases).toEqual(['analyze', 'quality_gate_record_repair']);
    expect(findings).toHaveLength(0);
    expect(result.degraded).toBe(true);
    expect(result.phases?.quality_gate).toMatchObject({ action: 'degraded_no_findings' });
  });
});

describe('record repair tool guard', () => {
  it('blocks exploration and non-finding memory writes during record repair', async () => {
    const diagnostics = new DiagnosticsCollector();
    let executeCount = 0;
    const runtime = {
      id: 'record-repair-tool-guard-runtime',
      presetName: 'test',
      container: null,
      dataRoot: '/tmp/alembic-agent-test',
      fileCache: null,
      lang: null,
      logger: { info: () => undefined, warn: () => undefined },
      aiProvider: null,
      policies: { get: () => null },
      toolRegistry: { getManifest: () => null },
      toolRouter: {
        execute: async () => {
          executeCount++;
          return {
            ok: true,
            status: 'success',
            text: 'ok',
            structuredContent: { ok: true },
            durationMs: 1,
            startedAt: new Date().toISOString(),
            toolId: 'memory',
            callId: `call-${executeCount}`,
          };
        },
      },
    } as unknown as AgentRuntime;
    const loopCtx = {
      allowedToolIds: ['memory', 'code', 'terminal'],
      abortSignal: null,
      context: { pipelinePhase: 'quality_gate_record_repair' },
      diagnostics,
      iteration: 1,
      memoryCoordinator: null,
      sharedState: { _recordRepairOnly: true },
      source: 'system',
      toolCalls: [],
      tracker: null,
      trace: null,
    } as unknown as LoopContext;
    const pipeline = createToolPipeline();

    const blockedCode = await pipeline.execute(
      { id: 'code-1', name: 'code', args: { action: 'read', params: { path: 'src/foo.ts' } } },
      { runtime, loopCtx, iteration: 1 }
    );
    const blockedSave = await pipeline.execute(
      {
        id: 'memory-1',
        name: 'memory',
        args: { action: 'save', params: { key: 'x', content: 'y' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const allowedFinding = await pipeline.execute(
      {
        id: 'memory-2',
        name: 'memory',
        args: {
          action: 'note_finding',
          params: { finding: 'Verified finding', evidence: 'src/foo.ts:10', importance: 8 },
        },
      },
      { runtime, loopCtx, iteration: 1 }
    );

    expect(blockedCode.metadata.blocked).toBe(true);
    expect(blockedSave.metadata.blocked).toBe(true);
    expect(allowedFinding.metadata.blocked).toBe(false);
    expect(executeCount).toBe(1);
  });
});
