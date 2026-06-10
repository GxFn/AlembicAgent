import { createCanonicalSourceIdentity } from '@alembic/core';
import { describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { analysisQualityGate, insightGateEvaluator } from '../src/agent/prompts/insight-gate.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime as AgentRuntimeImpl } from '../src/agent/runtime/AgentRuntime.js';
import type { AgentRuntime, LoopContext } from '../src/agent/runtime/index.js';
import {
  buildPcvQualityGateEvidence,
  createToolPipeline,
  DiagnosticsCollector,
} from '../src/agent/runtime/index.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

const MISSING_FINDINGS = 'Required note_finding calls are missing';
const INSUFFICIENT_FINDINGS = 'At least 3 note_finding calls are required';

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
      return {
        recorded: true,
        target: 'activeContext',
        importance,
        scratchpadSize: findings.length,
      };
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

function createRuntimeForReactLoop() {
  const chatWithTools = vi.fn(async () => ({
    text: 'forced summary should not be called',
    functionCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const toolRouter = { execute: vi.fn() };
  const runtime = new AgentRuntimeImpl({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: toolRouter as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
  });
  return { runtime, chatWithTools };
}

function createExitingTracker() {
  return {
    phase: 'SUMMARIZE',
    pipelineType: 'analyst',
    isGracefulExit: false,
    isHardExit: true,
    iteration: 1,
    totalSubmits: 0,
    tick: vi.fn(),
    shouldExit: vi.fn(() => true),
  };
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

  it('attaches PCVM N9 quality evidence with canonical quality gate node identity', () => {
    const source = {
      reply:
        '## Runtime boundary\nsrc/foo.ts:10 proves the runtime path.\n\n## Producer boundary\nsrc/bar.ts:20 validates the producer handoff.\n\n## Dashboard boundary\nsrc/baz.ts:30 keeps UI consumption separate.',
      toolCalls: [
        {
          tool: 'code',
          args: { action: 'read', params: { path: 'src/foo.ts' } },
          result: {
            path: 'src/foo.ts',
            content: 'export function runtimeBoundary() { return true; }',
            startLine: 10,
          },
        },
        {
          tool: 'code',
          args: { action: 'read', params: { path: 'src/bar.ts' } },
          result: {
            path: 'src/bar.ts',
            content: 'export function producerBoundary() { return true; }',
            startLine: 20,
          },
        },
        {
          tool: 'code',
          args: { action: 'read', params: { path: 'src/baz.ts' } },
          result: {
            path: 'src/baz.ts',
            content: 'export function dashboardBoundary() { return true; }',
            startLine: 30,
          },
        },
      ],
      tokenUsage: { input: 1, output: 1 },
      pcvNodeEvidence: {
        chainNodeId: 'agent:analyze:dim-agent',
        correlation: {
          dimensionId: 'architecture',
          dimensionScopeId: 'dim-agent',
          iteration: 1,
          modelRef: 'unit:model',
          runId: 'job-1',
          source: 'system',
          targetName: 'Architecture',
        },
        findingRefs: {
          accepted: [
            {
              callId: 'call-1',
              evidence: ['src/foo.ts:10'],
              findingSummary: 'Runtime boundary was recorded',
              importance: 8,
              origin: 'note_finding',
              ref: 'finding:runtime',
              sourceRefs: ['src/foo.ts:10'],
              toolName: 'note_finding',
            },
          ],
          rejected: [],
        },
        inputAssembly: {
          effectiveToolChoice: 'auto',
          inputLayerAppended: true,
          inputSectionIds: ['identity', 'stagePolicy', 'toolContract'],
          messageCount: 1,
          modelRef: 'unit:model',
          providerMessageCount: 2,
          providerVisibleSectionIds: ['identity', 'stagePolicy', 'toolContract'],
          ref: 'llm-input:test',
          requestedToolChoice: 'auto',
          stageProfile: 'analyze',
          staticSectionIds: ['identity'],
          toolSchemaNames: ['code', 'note_finding'],
        },
        ledgerRefs: [
          {
            kind: 'observation-ledger',
            ref: 'active-context:dim-agent',
            source: 'ActiveContext',
            stats: { rounds: 1 },
          },
        ],
        missingLinkReasons: [],
        nodeId: 'agent:analyze:dim-agent',
        qualityGate: null,
        repair: { attempted: false, evidencePaths: [], reason: null, status: null },
        schemaVersion: 1,
        sourceRefs: ['src/foo.ts:10'],
        stageIdentity: {
          dimensionId: 'architecture',
          nodeKind: 'agent-runtime-node',
          pipelinePhase: 'analyze',
          pipelineType: 'analyst',
          stageProfile: 'analyze',
          targetName: 'Architecture',
          trackerPhase: 'SCAN',
        },
      },
    };
    const activeContext = {
      distill: () => ({
        keyFindings: [
          { finding: 'Runtime boundary verified', evidence: 'src/foo.ts:10', importance: 8 },
          { finding: 'Producer boundary verified', evidence: 'src/bar.ts:20', importance: 8 },
          { finding: 'Dashboard boundary verified', evidence: 'src/baz.ts:30', importance: 7 },
        ],
        toolCallSummary: [],
      }),
    };

    const result = insightGateEvaluator(
      source,
      {},
      {
        activeContext,
        dimId: 'architecture',
        needsCandidates: true,
        pcvStageNodeMap: {
          quality_gate: {
            chainNodeId: 'pcvm:cold-start:n9:quality',
            pcvNodeId: 'pcvm:n9:quality_gate',
          },
        },
      }
    );
    const artifact = result.artifact as Record<string, unknown>;
    const pcvEvidence = artifact.pcvNodeEvidence as Record<string, unknown>;
    const findingRefs = pcvEvidence.findingRefs as {
      accepted: Array<Record<string, unknown>>;
      rejected: Array<Record<string, unknown>>;
    };

    expect(pcvEvidence).toMatchObject({
      inputAssembly: { ref: 'llm-input:test', stageProfile: 'analyze' },
      ledgerRefs: [{ ref: 'active-context:dim-agent' }],
      chainNodeId: 'pcvm:cold-start:n9:quality',
      nodeId: 'pcvm:n9:quality_gate',
      qualityGate: {
        pass: true,
        stage: 'quality_gate',
        status: 'pass',
      },
    });
    expect(findingRefs.accepted.map((finding) => finding.ref)).toEqual(
      expect.arrayContaining(['finding:runtime'])
    );
    expect(findingRefs.accepted.some((finding) => finding.origin === 'quality_artifact')).toBe(
      true
    );
    expect(pcvEvidence.sourceRefs).toEqual(
      expect.arrayContaining(['src/foo.ts:10', 'src/bar.ts:20', 'src/baz.ts:30'])
    );
    expect(pcvEvidence.missingLinkReasons).not.toContain('missing-quality-gate-status');
    expect(artifact.metadata).toMatchObject({
      pcvNodeEvidenceRef: 'pcvm:n9:quality_gate',
      pcvQualityGateStatus: 'pass',
    });
  });

  it('normalizes quality gate source refs and records ambiguous refs as diagnostics', () => {
    const sourceIdentities = [
      createCanonicalSourceIdentity({
        folderDisplayName: 'Alembic',
        projectScopeId: 'workspace',
        sourcePath: 'lib/bootstrap.ts',
      }),
      createCanonicalSourceIdentity({
        folderDisplayName: 'AlembicCore',
        projectScopeId: 'workspace',
        sourcePath: 'index.ts',
      }),
      createCanonicalSourceIdentity({
        folderDisplayName: 'AlembicPlugin',
        projectScopeId: 'workspace',
        sourcePath: 'index.ts',
      }),
    ];
    const evidence = buildPcvQualityGateEvidence({
      artifact: {
        findings: [
          {
            evidence:
              'Alembic/lib/bootstrap.ts:12 verifies bootstrap while index.ts:4 is ambiguous.',
            finding: 'Bootstrap source identity verified',
            importance: 8,
          },
        ],
        metadata: { memoryFindingCount: 1 },
        referencedFiles: ['Alembic/lib/bootstrap.ts', 'index.ts'],
      },
      dimId: 'architecture',
      gate: { action: 'pass', pass: true },
      sharedState: { _sourceIdentities: sourceIdentities },
      source: {},
      stageNodeContext: {
        pcvStageNodeMap: {
          quality_gate: {
            chainNodeId: 'pcvm:cold-start:n9:quality',
            pcvNodeId: 'pcvm:n9:quality_gate',
          },
        },
      },
    });

    expect(evidence.sourceRefs).toEqual(
      expect.arrayContaining(['Alembic/lib/bootstrap.ts', 'Alembic/lib/bootstrap.ts:12'])
    );
    expect(evidence.sourceRefs).not.toContain('index.ts');
    expect(evidence.findingRefs.accepted[0]?.sourceRefs).toEqual(['Alembic/lib/bootstrap.ts:12']);
    expect(evidence.sourceRefDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: 'index.ts', status: 'ambiguous' }),
        expect.objectContaining({ input: 'index.ts:4', status: 'ambiguous' }),
      ])
    );
    expect(evidence.missingLinkReasons).toEqual(
      expect.arrayContaining(['ambiguous-source-ref:index.ts'])
    );
  });
});

describe('record repair pipeline stage', () => {
  it('runs a note_finding-only repair stage and rechecks the gate from ActiveContext', async () => {
    const { findings, strategyContext } = createPipelineContext([
      { finding: 'Existing runtime finding', evidence: 'src/foo.ts:10', importance: 7 },
      { finding: 'Existing producer finding', evidence: 'src/bar.ts:20', importance: 7 },
    ]);
    const pcvStageNodeMap = {
      analyze: {
        chainNodeId: 'pcvm:cold-start:n9:analyze',
        pcvNodeId: 'pcvm:n9:analyze',
      },
      produce: {
        chainNodeId: 'pcvm:cold-start:n11',
        pcvNodeId: 'pcvm:n11:produce',
      },
      record_repair: {
        chainNodeId: 'pcvm:cold-start:n9:repair',
        pcvNodeId: 'pcvm:n9:record_repair',
      },
    };
    (strategyContext as Record<string, unknown>).pcvStageNodeMap = pcvStageNodeMap;
    (strategyContext.sharedState as Record<string, unknown>)._dimensionMeta = {
      id: 'design-patterns',
      outputType: 'candidate',
    };
    const strategy = createStrategy(3);
    const phases: string[] = [];
    const runtime = {
      id: 'record-repair-runtime',
      logger: { info: () => undefined },
      reactLoop: vi.fn(async (_prompt: string, opts: Record<string, unknown>) => {
        const context = opts.context as Record<string, unknown>;
        const phase = String(context.pipelinePhase);
        phases.push(phase);
        expect(context.pcvStageNodeMap).toBe(pcvStageNodeMap);
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
          const args = {
            finding: 'Repair records the missing verified runtime evidence',
            evidence: 'src/foo.ts:10',
            importance: 8,
          };
          const result = (
            strategyContext.memoryCoordinator as {
              noteFinding: (finding: string, evidence: string, importance: number) => unknown;
            }
          ).noteFinding(args.finding, args.evidence, args.importance);
          return {
            reply: '',
            toolCalls: [{ name: 'note_finding', args, result }],
            tokenUsage: { input: 1, output: 1 },
            iterations: 1,
          };
        }
        if (phase === 'produce') {
          expect(opts.sharedState).not.toHaveProperty('_sourceRefPolicy');
          expect(opts.sharedState).not.toHaveProperty('_canonicalSourceRefIndex');
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
    expect(result.phases?._recordRepairToolWritten).toBe(true);
  });

  it('does not accept JSON text as a note_finding substitute after repair timeout', async () => {
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

  it('suppresses full analysis retry when session input budget is already exhausted', async () => {
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze', capabilities: [], budget: { maxSessionInputTokens: 100 } },
        {
          name: 'quality_gate',
          gate: {
            evaluator: () => ({
              action: 'analysis_retry',
              pass: false,
              reason: MISSING_FINDINGS,
            }),
            maxRetries: 1,
          },
        },
        { name: 'produce', capabilities: [], promptBuilder: () => 'produce' },
      ],
    });
    const phases: string[] = [];
    const runtime = {
      id: 'budget-suppression-runtime',
      logger: { info: () => undefined },
      reactLoop: vi.fn(async (_prompt: string, opts: Record<string, unknown>) => {
        const phase = String((opts.context as Record<string, unknown>).pipelinePhase);
        phases.push(phase);
        return {
          reply: 'Too little useful analysis.',
          toolCalls: [],
          tokenUsage: { input: 95, output: 1 },
          iterations: 1,
        };
      }),
    };

    const result = await strategy.execute(runtime, AgentMessage.internal('analyze then produce'), {
      strategyContext: { diagnostics: new DiagnosticsCollector() },
    });

    expect(phases).toEqual(['analyze']);
    expect(result.degraded).toBe(true);
    expect(result.phases?.quality_gate).toMatchObject({
      action: 'degraded_budget_exhausted',
    });
    expect(result.diagnostics?.gateFailures).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'degraded_budget_exhausted' })])
    );
  });
});

describe('record repair tool guard', () => {
  it('blocks exploration and non-finding memory writes during record repair', async () => {
    const diagnostics = new DiagnosticsCollector();
    let executeCount = 0;
    const executedToolIds: string[] = [];
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
        execute: async (request: { toolId: string }) => {
          executeCount++;
          executedToolIds.push(request.toolId);
          return {
            ok: true,
            status: 'success',
            text: 'ok',
            structuredContent: { recorded: true, target: 'activeContext' },
            durationMs: 1,
            startedAt: new Date().toISOString(),
            toolId: request.toolId,
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
    const directFindingCall = {
      id: 'memory-3',
      name: 'note_finding',
      args: {
        finding: 'Verified direct finding',
        evidence: 'src/foo.ts:11',
        importance: 8,
      },
    };
    const allowedDirectFinding = await pipeline.execute(directFindingCall, {
      runtime,
      loopCtx,
      iteration: 1,
    });

    expect(blockedCode.metadata.blocked).toBe(true);
    expect(blockedSave.metadata.blocked).toBe(true);
    expect(allowedFinding.metadata.blocked).toBe(false);
    expect(allowedDirectFinding.metadata.blocked).toBe(false);
    expect(directFindingCall.name).toBe('note_finding');
    expect(executedToolIds).toEqual(['memory', 'memory']);
    expect(executeCount).toBe(2);
  });
});

describe('analyst phase-chain state gating', () => {
  it('keeps SCAN as a no-tool briefing phase and immediately moves to EXPLORE', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 12, searchBudget: 8 }
    );

    expect(tracker).not.toBeNull();
    expect(tracker?.phase).toBe('SCAN');
    expect(tracker?.getToolChoice()).toBe('none');

    tracker?.tick();
    const transition = tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });

    expect(tracker?.phase).toBe('EXPLORE');
    expect(transition?.text).toContain('轻量计划阶段已完成');
  });

  it('blocks generalized exploration during analyst VERIFY while allowing focused evidence checks', async () => {
    const diagnostics = new DiagnosticsCollector();
    let executeCount = 0;
    const runtime = {
      id: 'analyst-verify-tool-guard-runtime',
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
        execute: async (request: { toolId: string }) => {
          executeCount++;
          return {
            ok: true,
            status: 'success',
            text: 'ok',
            structuredContent: { ok: true },
            durationMs: 1,
            startedAt: new Date().toISOString(),
            toolId: request.toolId,
            callId: `verify-call-${executeCount}`,
          };
        },
      },
    } as unknown as AgentRuntime;
    const loopCtx = {
      allowedToolIds: ['code', 'graph', 'terminal', 'memory'],
      abortSignal: null,
      context: { pipelinePhase: 'analyze' },
      diagnostics,
      iteration: 1,
      memoryCoordinator: null,
      sharedState: {},
      source: 'system',
      toolCalls: [],
      tracker: {
        pipelineType: 'analyst',
        phase: 'VERIFY',
        recordToolCall: () => ({ isNew: false }),
      },
      trace: null,
    } as unknown as LoopContext;
    const pipeline = createToolPipeline();

    const blockedCodeSearch = await pipeline.execute(
      { id: 'code-search', name: 'code', args: { action: 'search', params: { pattern: 'Agent' } } },
      { runtime, loopCtx, iteration: 1 }
    );
    const blockedGraphSearch = await pipeline.execute(
      {
        id: 'graph-search',
        name: 'graph',
        args: { action: 'query', params: { type: 'search', entity: 'Agent' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const blockedTerminal = await pipeline.execute(
      {
        id: 'terminal-run',
        name: 'terminal',
        args: { action: 'exec', params: { cmd: 'rg Agent' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const allowedRead = await pipeline.execute(
      { id: 'code-read', name: 'code', args: { action: 'read', params: { path: 'src/foo.ts' } } },
      { runtime, loopCtx, iteration: 1 }
    );
    const allowedGraph = await pipeline.execute(
      {
        id: 'graph-callers',
        name: 'graph',
        args: { action: 'query', params: { type: 'callers', entity: 'Foo.run' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const allowedFinding = await pipeline.execute(
      {
        id: 'memory-finding',
        name: 'memory',
        args: {
          action: 'note_finding',
          params: { finding: 'Verified finding', evidence: 'src/foo.ts:10', importance: 8 },
        },
      },
      { runtime, loopCtx, iteration: 1 }
    );

    expect(blockedCodeSearch.metadata.blocked).toBe(true);
    expect(blockedGraphSearch.metadata.blocked).toBe(true);
    expect(blockedTerminal.metadata.blocked).toBe(true);
    expect(allowedRead.metadata.blocked).toBe(false);
    expect(allowedGraph.metadata.blocked).toBe(false);
    expect(allowedFinding.metadata.blocked).toBe(false);
    expect(executeCount).toBe(3);
  });

  it('does not call forced summary after abort or stage timeout exits', async () => {
    const aborted = createRuntimeForReactLoop();
    const abortController = new AbortController();
    abortController.abort();
    const abortResult = await aborted.runtime.reactLoop('analyze', {
      source: 'system',
      abortSignal: abortController.signal,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(aborted.chatWithTools).not.toHaveBeenCalled();
    expect(abortResult.reply).toContain('abort_signal');
    expect(abortResult.diagnostics?.efficiency?.forcedSummary).toBe(false);
    expect(abortResult.diagnostics?.efficiency?.cancelReason).toBe('abort_signal');

    const timedOut = createRuntimeForReactLoop();
    const timeoutDiagnostics = new DiagnosticsCollector();
    timeoutDiagnostics.recordTimedOutStage('analyze');
    timeoutDiagnostics.recordCancelReason('stage_timeout');
    const timeoutResult = await timedOut.runtime.reactLoop('analyze', {
      source: 'system',
      tracker: createExitingTracker() as never,
      diagnostics: timeoutDiagnostics,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(timedOut.chatWithTools).not.toHaveBeenCalled();
    expect(timeoutResult.reply).toContain('stage_timeout');
    expect(timeoutResult.diagnostics?.efficiency?.forcedSummary).toBe(false);
    expect(timeoutResult.diagnostics?.efficiency?.cancelReason).toBe('stage_timeout');
  });

  it('keeps degraded_no_findings out of normal producer and summary completion paths', async () => {
    const { runtime, chatWithTools } = createRuntimeForReactLoop();
    const diagnostics = new DiagnosticsCollector();
    diagnostics.recordGateFailure(
      'quality_gate',
      'degraded_no_findings',
      'Record repair did not produce enough validated note_finding records'
    );

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      tracker: createExitingTracker() as never,
      diagnostics,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('degraded_no_findings');
    expect(result.diagnostics?.degraded).toBe(true);
    expect(result.diagnostics?.efficiency?.forcedSummary).toBe(false);
  });
});
