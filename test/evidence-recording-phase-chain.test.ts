import { createCanonicalSourceIdentity } from '@alembic/core';
import { describe, expect, it, vi } from 'vitest';
import {
  analysisQualityGate,
  buildAnalysisArtifact,
  insightGateEvaluator,
} from '../src/agent/evaluation/index.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { ANALYST_SYSTEM_PROMPT } from '../src/agent/prompts/insightAnalyst.js';
import { buildRecordRepairPrompt } from '../src/agent/prompts/insightGate.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import {
  AgentRuntime,
  buildLlmInputAssembly,
  buildPcvQualityGateEvidence,
  createMessageAdapter,
  createToolPipeline,
  DiagnosticsCollector,
  LoopContext,
} from '../src/agent/runtime/index.js';
import {
  buildPcvNodeEvidenceProcessMetadata,
  buildPcvNodeEvidenceSummary,
  recordPcvInputAssembly,
  recordPcvToolResult,
} from '../src/agent/runtime/PcvNodeEvidenceRecorder.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';
import { createTempProject } from './helpers/tempProject.js';

const MISSING_FINDINGS = 'Required note_finding calls are missing';
const INSUFFICIENT_FINDINGS = 'At least 3 note_finding calls are required';

it('advertises the live finding reference contract and real snippet coordinates', () => {
  const prompt = buildRecordRepairPrompt({
    artifact: {
      evidenceMap: new Map([['src/a.ts', { codeSnippets: [{ startLine: 10, endLine: 12 }] }]]),
    },
  });
  expect(prompt).toContain('src/a.ts:10-12');
  expect(prompt).toContain('evidenceRefs');
  expect(ANALYST_SYSTEM_PROMPT).not.toContain('finding, evidence, importance');
});

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

function recordedFindingFixture(count: number) {
  const findings = [
    {
      finding: 'NetworkError 统一网络错误枚举',
      evidence: 'Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift:12',
      importance: 9,
    },
    {
      finding: 'ResponseDecoder 容错解析链路',
      evidence: 'Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/ResponseDecoder.swift:44',
      importance: 8,
    },
    {
      finding: '中间件错误恢复',
      evidence: 'Sources/Infrastructure/Networking/Client/NetworkError+App.swift:8',
      importance: 8,
    },
  ];
  const reply = `
## NetworkError 统一网络错误枚举
核心错误模型落在 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/NetworkError.swift，并通过 Sources/Infrastructure/Networking/Client/NetworkError+App.swift 转换成业务可读错误。
## ResponseDecoder 容错解析链路
响应解析由 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Core/ResponseDecoder.swift 承担，业务扩展位于 Sources/Infrastructure/Networking/Client/ResponseDecoder+App.swift。
## 中间件错误恢复
请求链路中的 Sources/Infrastructure/Networking/Middleware/AuthMiddleware.swift 和 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Middleware/CacheMiddleware.swift 提供认证恢复与缓存降级。
`;
  return {
    source: {
      reply,
      toolCalls: findings.map((finding) => ({
        tool: 'code',
        args: { action: 'read', path: finding.evidence.split(':')[0] },
        // 真实 code.read 展示态每一行都带连续 `N|` 前缀（L7-P13：残缺展示不再进入源码片段）。
        result: '12|public enum NetworkError: Error {\n13| case invalidURL(String)\n14|}',
      })),
    },
    activeContext: {
      distill: () => ({ keyFindings: findings.slice(0, count), toolCallSummary: [] }),
    },
  };
}

describe('evidence recording quality gate actions', () => {
  it.each([0, 1, 3])('keeps derived markdown separate from %s recorded findings', (count) => {
    const { source, activeContext } = recordedFindingFixture(count);
    const artifact = buildAnalysisArtifact(source, 'error-resilience', null, activeContext);
    expect(artifact.metadata).toMatchObject({
      memoryFindingCount: count,
      derivedFindingCount: count === 0 ? 3 : 0,
    });
    expect(artifact.findings).toHaveLength(count || 3);
    if (count === 0) {
      expect(artifact.findings[0].evidence).toContain('NetworkError.swift');
      expect(artifact.qualityReport.scores.evidenceScore).toBeGreaterThanOrEqual(50);
      expect(artifact.qualityReport.suggestions).toContain(MISSING_FINDINGS);
      expect(analysisQualityGate(artifact, { outputType: 'candidate' })).toMatchObject({
        pass: false,
        action: 'record_repair',
        reason: MISSING_FINDINGS,
      });
    } else if (count === 1) {
      expect(artifact.qualityReport.suggestions).toContain(INSUFFICIENT_FINDINGS);
      expect(analysisQualityGate(artifact, { outputType: 'candidate' }).pass).toBe(false);
    } else {
      expect(artifact.qualityReport.suggestions).not.toContain(MISSING_FINDINGS);
      expect(artifact.qualityReport.suggestions).not.toContain(INSUFFICIENT_FINDINGS);
    }
  });

  it('requires recorded findings when needsCandidates overrides analysis-only output', () => {
    const { source, activeContext } = recordedFindingFixture(0);
    expect(
      insightGateEvaluator(
        source,
        {},
        { activeContext, dimId: 'error-resilience', outputType: 'analysis', needsCandidates: true }
      )
    ).toMatchObject({ action: 'record_repair', reason: MISSING_FINDINGS });
  });

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
            content: '10|export function runtimeBoundary() { return true; }',
            startLine: 10,
          },
        },
        {
          tool: 'code',
          args: { action: 'read', params: { path: 'src/bar.ts' } },
          result: {
            path: 'src/bar.ts',
            content: '20|export function producerBoundary() { return true; }',
            startLine: 20,
          },
        },
        {
          tool: 'code',
          args: { action: 'read', params: { path: 'src/baz.ts' } },
          result: {
            path: 'src/baz.ts',
            content: '30|export function dashboardBoundary() { return true; }',
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
          expect(opts.additionalToolsOverride).toEqual(['memory', 'evidence']);
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
});

function createLoop() {
  const messages = createMessageAdapter(null);
  messages.appendUserMessage('review code');
  return new LoopContext({
    messages,
    capabilities: [],
    baseSystemPrompt: 'review',
    allowedToolIds: ['memory'],
    toolSchemas: [],
    source: 'system',
    budget: { maxIterations: 1 },
    prompt: 'review code',
    context: { pipelinePhase: 'analyze', dimensionId: 'probe' },
  });
}
function recordInput(ctx: LoopContext) {
  const assembly = buildLlmInputAssembly({
    ctx,
    dynamicContext: null,
    effectiveToolChoice: 'auto',
    messages: ctx.messages.toMessages(),
    modelRef: 'unit:model',
    requestedToolChoice: 'auto',
    systemPrompt: 'review',
    tools: [{ name: 'memory', description: 'memory' }],
  });
  recordPcvInputAssembly(ctx.pcvNodeEvidence, assembly, { iteration: 1, modelRef: 'unit:model' });
}

describe('runtime evidence facts and snapshots', () => {
  it('preserves real ledger source links on modern note_finding', async () => {
    const dataRoot = createTempProject('runtime-evidence-');
    const ledger = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'job',
      sessionId: 'session',
      dimensionId: 'probe',
    });
    ledger.append({
      tool: 'code.read',
      callId: 'read',
      file: 'src/widget.ts',
      range: { start: 10, end: 12 },
      content: 'a\nb\nc',
    });
    const memory = new MemoryCoordinator({ mode: 'bootstrap' });
    const active = memory.createDimensionScope('probe');
    const args = {
      action: 'note_finding',
      params: {
        finding: 'The handler owns the boundary',
        evidenceRefs: ['E-1@11-12'],
        importance: 8,
      },
    };
    const result = await handleMemory('note_finding', args.params, {
      runtime: { evidenceLedger: ledger, dimensionScopeId: 'probe' },
      memoryCoordinator: memory,
    } as never);
    expect(result.ok).toBe(true);
    expect(active.distill().keyFindings[0].evidence).toContain('src/widget.ts:11-12');
    const ctx = createLoop();
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      { id: 'note', name: 'memory', args },
      result.data,
      undefined,
      { toolSucceeded: result.ok, evidenceLedger: ledger }
    );
    expect(ctx.pcvNodeEvidence.findingRefs.accepted[0].sourceRefs).toContain('src/widget.ts:11-12');
  });

  it('returns owned PCV snapshots', () => {
    const ctx = createLoop();
    recordInput(ctx);
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      {
        id: 'note',
        name: 'note_finding',
        args: { finding: 'boundary', evidence: 'src/widget.ts:11', importance: 8 },
      },
      { recorded: true, target: 'activeContext' },
      undefined,
      { toolSucceeded: true }
    );
    const expected = structuredClone(ctx.pcvNodeEvidence);
    const result = ctx.buildResult();
    if (!result.pcvNodeEvidence.inputAssembly) {
      throw new Error('Fixture must record input assembly');
    }
    result.pcvNodeEvidence.inputAssembly.toolSchemaNames.push('invented');
    result.pcvNodeEvidence.findingRefs.accepted[0].evidence.push('invented source');
    expect(ctx.pcvNodeEvidence).toEqual(expected);
  });

  it('recomputes missing links after real quality artifact supplied findings', () => {
    const ctx = createLoop();
    const initial = ctx.buildResult();
    expect(initial.pcvNodeEvidence.missingLinkReasons).toContain('missing-finding-refs');
    const quality = buildPcvQualityGateEvidence({
      source: initial,
      artifact: {
        findings: [{ finding: 'bounded owner', evidence: 'src/widget.ts:11', importance: 8 }],
        referencedFiles: ['src/widget.ts:11'],
      },
      gate: { pass: true, action: 'pass' },
    });
    expect(quality.missingLinkReasons).not.toContain('missing-finding-refs');
    expect(quality.missingLinkReasons).not.toContain('missing-source-refs');
  });

  it('does not call a blocked tool evidence-produced', async () => {
    const chatWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [
          { id: 'read', name: 'code', args: { action: 'read', params: { path: 'src/widget.ts' } } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockResolvedValue({
        text: 'done',
        functionCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    const execute = vi.fn(async () => ({
      ok: false,
      toolId: 'code',
      callId: 'read',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: 'blocked',
      text: 'read denied',
      structuredContent: { error: 'read denied' },
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
    }));
    const runtime = new AgentRuntime({
      aiProvider: { name: 'unit', model: 'model', chatWithTools },
      toolRegistry: { getManifest: () => null },
      toolRouter: { execute },
      container: {
        get: (name: string) =>
          name === 'capabilityCatalog'
            ? {
                toToolSchemas: () => [
                  { name: 'code', description: 'source', parameters: { type: 'object' } },
                ],
              }
            : undefined,
      },
      capabilities: [],
      additionalTools: ['code'],
      strategy: { name: 'unused', execute: vi.fn() },
      logger: { info: () => {}, warn: () => {} },
    } as never);
    const result = await runtime.reactLoop('read bounded source', {
      source: 'system',
      context: { pipelinePhase: 'analyze' },
      toolChoiceOverride: 'auto',
      budgetOverride: { maxIterations: 1, timeoutMs: 1000 },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.toolCalls[0].envelope.status).toBe('blocked');
    expect(result.pcvNodeEvidence.groundingLedger[0].classification).not.toBe('evidence-produced');
  });
});

// I28：PCV 节点证据细节修正。节点 sourceRefs 只收成功调用触及的来源；质量门对形状不合格的
// source 证据退回 fallback 并留下持久原因；ledgerRefs 不再携带循环开始时的陈旧 stats 快照。
describe('PCV evidence detail corrections (I28)', () => {
  function createTracedLoop(
    trace: Record<string, unknown>,
    diagnostics = new DiagnosticsCollector()
  ) {
    const messages = createMessageAdapter(null);
    messages.appendUserMessage('review code');
    return new LoopContext({
      messages,
      capabilities: [],
      baseSystemPrompt: 'review',
      allowedToolIds: ['code', 'memory'],
      toolSchemas: [],
      source: 'system',
      budget: { maxIterations: 1 },
      prompt: 'review code',
      context: { pipelinePhase: 'analyze', dimensionId: 'probe' },
      trace,
      diagnostics,
    });
  }

  const blockedRead = {
    id: 'read-secret',
    name: 'code',
    args: { action: 'read', params: { path: 'src/secret/a.ts' } },
  };

  it('keeps a blocked code.read path out of node sourceRefs and still reports missing-source-refs', () => {
    const ctx = createLoop();
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      blockedRead,
      { error: 'Tool call blocked by hook' },
      undefined,
      { toolSucceeded: false }
    );
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.sourceRefs).not.toContain('src/secret/a.ts');
    expect(summary.missingLinkReasons).toContain('missing-source-refs');
    // 跳过的引用经现有 sourceRefDiagnostics 留审计记录，但不冒充“缺失链接”。
    expect(summary.sourceRefDiagnostics).toEqual([
      { input: 'src/secret/a.ts', reason: 'failed-tool-call', status: 'missing' },
    ]);
    expect(summary.missingLinkReasons).not.toContain('missing-source-ref:src/secret/a.ts');
    expect(buildPcvNodeEvidenceProcessMetadata(ctx.pcvNodeEvidence).sourceRefs).toEqual([]);
  });

  it('derives failure from the envelope or result error when toolSucceeded is omitted', () => {
    const viaEnvelope = createLoop();
    recordPcvToolResult(viaEnvelope.pcvNodeEvidence, blockedRead, { error: 'read denied' }, {
      ok: false,
      status: 'blocked',
      text: 'read denied for src/secret/b.ts',
    } as never);
    expect(viaEnvelope.pcvNodeEvidence.sourceRefs).toEqual([]);

    const viaResult = createLoop();
    recordPcvToolResult(viaResult.pcvNodeEvidence, blockedRead, {
      error: 'ENOENT src/secret/a.ts',
    });
    expect(viaResult.pcvNodeEvidence.sourceRefs).toEqual([]);
  });

  it('still links paths touched by a successful read', () => {
    const ctx = createLoop();
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      { id: 'read-ok', name: 'code', args: { action: 'read', params: { path: 'src/widget.ts' } } },
      { path: 'src/widget.ts', content: 'export const widget = 1;' },
      undefined,
      { toolSucceeded: true }
    );
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.sourceRefs).toEqual(['src/widget.ts']);
    expect(summary.missingLinkReasons).not.toContain('missing-source-refs');
    expect(summary.sourceRefDiagnostics).toEqual([]);
  });

  it('keeps a failed note_finding reference on the rejected finding only', () => {
    const ctx = createLoop();
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      {
        id: 'note',
        name: 'note_finding',
        args: { finding: 'claimed boundary', evidence: 'src/claimed.ts:4', importance: 7 },
      },
      { error: 'note_finding rejected: evidence was never read' },
      undefined,
      { toolSucceeded: false }
    );
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.findingRefs.rejected).toEqual([
      expect.objectContaining({ sourceRefs: ['src/claimed.ts:4'] }),
    ]);
    expect(summary.sourceRefs).toEqual([]);
    expect(summary.missingLinkReasons).toContain('missing-source-refs');
  });

  it('falls back instead of throwing when process-event metadata is passed as source evidence', () => {
    const ctx = createLoop();
    recordInput(ctx);
    const metadata = buildPcvNodeEvidenceProcessMetadata(ctx.pcvNodeEvidence);
    const build = () =>
      buildPcvQualityGateEvidence({
        source: { pcvNodeEvidence: metadata },
        artifact: {
          findings: [{ finding: 'bounded owner', evidence: 'src/widget.ts:11', importance: 8 }],
          referencedFiles: ['src/widget.ts:11'],
        },
        dimId: 'probe',
        gate: { pass: true, action: 'pass' },
      });
    expect(build).not.toThrow();
    const quality = build();
    expect(quality.nodeId).toBe('agent:quality_gate:probe');
    expect(quality.groundingEnforcement).toBe('off');
    expect(quality.missingLinkReasons).toContain('invalid-source-pcv-evidence');
    expect(quality.sourceRefs).toContain('src/widget.ts:11');
  });

  it('does not flag a quality gate without source evidence as invalid', () => {
    const quality = buildPcvQualityGateEvidence({
      source: {},
      artifact: { referencedFiles: ['src/widget.ts'] },
      dimId: 'probe',
      gate: { pass: true, action: 'pass' },
    });
    expect(quality.missingLinkReasons).not.toContain('invalid-source-pcv-evidence');
  });

  it('defaults a missing groundingEnforcement to observe-only off and keeps guard', () => {
    const ctx = createLoop();
    const { groundingEnforcement: _omitted, ...legacy } = ctx.buildResult().pcvNodeEvidence;
    const legacyQuality = buildPcvQualityGateEvidence({
      source: { pcvNodeEvidence: legacy },
      artifact: { referencedFiles: ['src/widget.ts'] },
      gate: { pass: true, action: 'pass' },
    });
    expect(legacyQuality.groundingEnforcement).toBe('off');
    expect(legacyQuality.missingLinkReasons).not.toContain('invalid-source-pcv-evidence');

    const guarded = buildPcvQualityGateEvidence({
      source: { pcvNodeEvidence: { ...legacy, groundingEnforcement: 'guard' } },
      artifact: { referencedFiles: ['src/widget.ts'] },
      gate: { pass: true, action: 'pass' },
    });
    expect(guarded.groundingEnforcement).toBe('guard');
  });

  it('does not carry a stale observation-ledger stats snapshot', () => {
    let rounds = 0;
    const ctx = createTracedLoop({ getStats: () => ({ totalRounds: rounds, totalActions: 0 }) });
    rounds = 12;
    const result = ctx.buildResult();
    expect(result.pcvNodeEvidence.ledgerRefs).toEqual([
      { kind: 'observation-ledger', ref: 'active-context:probe', source: 'ActiveContext' },
    ]);
    expect(result.pcvNodeEvidence.missingLinkReasons).not.toContain(
      'observation-ledger-stats-unavailable'
    );

    const quality = buildPcvQualityGateEvidence({
      source: {
        pcvNodeEvidence: {
          ...result.pcvNodeEvidence,
          ledgerRefs: [
            {
              kind: 'observation-ledger',
              ref: 'active-context:probe',
              source: 'ActiveContext',
              stats: { totalRounds: 0 },
            },
          ],
        },
      },
      artifact: { referencedFiles: ['src/widget.ts'] },
      gate: { pass: true, action: 'pass' },
    });
    expect(quality.ledgerRefs).toEqual([
      { kind: 'observation-ledger', ref: 'active-context:probe', source: 'ActiveContext' },
    ]);
  });

  it('reports an unreadable observation ledger instead of swallowing the error', () => {
    const diagnostics = new DiagnosticsCollector();
    const ctx = createTracedLoop(
      {
        getStats: () => {
          throw new Error('ledger closed');
        },
      },
      diagnostics
    );
    const summary = ctx.buildResult().pcvNodeEvidence;
    expect(summary.ledgerRefs).toEqual([
      { kind: 'observation-ledger', ref: 'active-context:probe', source: 'ActiveContext' },
    ]);
    expect(summary.missingLinkReasons).toContain('observation-ledger-stats-unavailable');
    expect(diagnostics.toJSON().warnings).toEqual([
      expect.objectContaining({
        code: 'pcv_observation_ledger_stats_unavailable',
        message: expect.stringContaining('ledger closed'),
      }),
    ]);
  });
});
