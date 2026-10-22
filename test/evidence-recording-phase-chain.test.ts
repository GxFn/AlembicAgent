import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanonicalSourceIdentity } from '@alembic/core';
import Logger from '@alembic/core/logging';
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
  resolvePcvStageNodeIdentity,
} from '../src/agent/runtime/index.js';
import {
  buildPcvNodeEvidenceProcessMetadata,
  buildPcvNodeEvidenceSummary,
  recordPcvInputAssembly,
  recordPcvToolResult,
} from '../src/agent/runtime/PcvNodeEvidenceRecorder.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import { createToolReceipt } from '../src/agent/runtime/toolReceipt.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';
import { readToolObservation } from '../src/agent/utils/toolOutcomes.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { DeltaCache } from '../src/tools/runtime/cache/DeltaCache.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';
import { createTempProject } from './helpers/tempProject.js';

const MISSING_FINDINGS = 'Required note_finding calls are missing';
const INSUFFICIENT_FINDINGS = 'At least 3 note_finding calls are required';

/**
 * 宿主真实注入形状：宿主 ProjectScopeAnalysis.buildProjectScopeSourceIdentityMap 的产物
 * （ProjectScopeSourceIdentityMap v1）。L5-P28 之后 PCV 记录器只认这一形状，旧别名键不再生效。
 */
function hostSourceIdentityMap(identities: ReadonlyArray<Record<string, unknown>>) {
  return {
    contract: 'ProjectScopeSourceIdentityMap',
    contractVersion: 1,
    entries: identities.map((identity) => ({ ...identity })),
    preferredRef: 'qualifiedPath',
    rejectPolicy: { missingPath: 'reject' },
    sourceCount: identities.length,
  };
}

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
    // L7-P16(C07)：派生只认派生前接地集合(真实读取并留下片段的文件)。fixture 只读了 3 个文件，
    // 第三个小节只提及未读的 AuthMiddleware/CacheMiddleware，不再派生；剩下 2 条派生 findings。
    expect(artifact.metadata).toMatchObject({
      memoryFindingCount: count,
      derivedFindingCount: count === 0 ? 2 : 0,
    });
    expect(artifact.findings).toHaveLength(count || 2);
    if (count === 0) {
      const groundedFiles = new Set(artifact.groundedFiles);
      expect(artifact.findings[0].evidence).toContain('NetworkError.swift');
      for (const finding of artifact.findings) {
        for (const ref of finding.evidence.split(', ')) {
          expect(groundedFiles.has(ref), ref).toBe(true);
        }
      }
      expect(artifact.findings.map((finding) => finding.finding)).not.toContain('中间件错误恢复');
      // 纯派生 findings 不计入 evidence 加分：沿用无 note_finding 时的 40 分上限。
      expect(artifact.qualityReport.scores.evidenceScore).toBeLessThanOrEqual(40);
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
      sharedState: { _projectScopeSourceIdentityMap: hostSourceIdentityMap(sourceIdentities) },
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
    // I27：缺失原因只保留聚合原因；逐路径明细留在 sourceRefDiagnostics，不再镜像进 missingLinkReasons。
    expect(evidence.missingLinkReasons).toEqual(expect.arrayContaining(['ambiguous-source-refs']));
    expect(
      evidence.missingLinkReasons.some((reason) => reason.startsWith('ambiguous-source-ref:'))
    ).toBe(false);
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

  /**
   * C052：经真实路由（ToolRouterAdapter + executeRuntimeToolCall）产出信封与返回值，再按 AgentRuntime
   * 的同一口径（createToolReceipt → readToolObservation(receipt).ok）得到 toolSucceeded 并记录 PCV 证据。
   */
  async function recordRoutedRead(
    root: string,
    params: Record<string, unknown>,
    options: { abortSignal?: AbortSignal; deltaCache?: DeltaCache } = {}
  ) {
    const ctx = createLoop();
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          projectRoot: root,
          tokenBudget: 8000,
          ...(options.deltaCache ? { deltaCache: options.deltaCache } : {}),
        }),
      },
    });
    const pipelineContext = {
      runtime: {
        id: 'pcv-read-runtime',
        presetName: 'pcv-read',
        policies: {},
        toolRouter: adapter,
      },
      loopCtx: {
        allowedToolIds: ['code'],
        allowedToolActions: {},
        iteration: 1,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      },
      iteration: 1,
    } as unknown as ToolPipelineContext;
    const call = { id: 'read-batch', name: 'code', args: { action: 'read', params } };
    const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
    const result = await executeRuntimeToolCall(call, pipelineContext, metadata);
    const toolSucceeded = readToolObservation(createToolReceipt(call, result, metadata)).ok;
    recordPcvToolResult(ctx.pcvNodeEvidence, call, result, metadata.envelope, { toolSucceeded });
    return { toolSucceeded, summary: buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence) };
  }

  it('links only the members a partially failed code.read batch really read (C052)', async () => {
    const root = createTempProject('pcv-partial-read-');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'real.ts'), 'export const real = 1;');

    const { toolSucceeded, summary } = await recordRoutedRead(root, {
      filePaths: ['src/real.ts', 'src/ghost.ts'],
    });

    // 批量读取至少一个成员成功时整体回执仍是成功；失败成员不能借整体成功混进节点 sourceRefs。
    expect(toolSucceeded).toBe(true);
    expect(summary.sourceRefs).toEqual(['src/real.ts']);
    expect(summary.sourceRefs.some((ref) => path.isAbsolute(ref))).toBe(false);
    expect(summary.sourceRefDiagnostics).toEqual([
      { input: 'src/ghost.ts', reason: 'failed-tool-call', status: 'missing' },
    ]);
    expect(summary.missingLinkReasons).not.toContain('missing-source-refs');
  });

  it('keeps aborted and failed batch members out of sourceRefs even when the call is reported successful', () => {
    // 被审提交上的取消形状：批量回执整体 ok，未读成员写成 Read aborted；外部调用方也可能只按整体成功传入。
    const ctx = createLoop();
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      {
        id: 'read-cancelled',
        name: 'code',
        args: { action: 'read', params: { filePaths: ['src/one.ts', 'src/two.ts'] } },
      },
      {
        mode: 'batch',
        files: [
          { ok: true, path: 'src/one.ts', content: "import { two } from './lib/two-helper.ts';" },
          { ok: false, path: 'src/two.ts', error: 'Read aborted' },
        ],
      },
      undefined,
      { toolSucceeded: true }
    );
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    // 成功成员正文里的引用照常链接（与单文件读取同一口径），未读成员只留 failed-tool-call 审计诊断。
    expect(summary.sourceRefs).toEqual(['src/one.ts', './lib/two-helper.ts']);
    expect(summary.sourceRefDiagnostics).toEqual([
      { input: 'src/two.ts', reason: 'failed-tool-call', status: 'missing' },
    ]);

    const legacy = createLoop();
    recordPcvToolResult(
      legacy.pcvNodeEvidence,
      {
        id: 'read-legacy-batch',
        name: 'code',
        args: { action: 'read', params: { filePaths: ['src/one.ts', 'src/gone.ts'] } },
      },
      {
        batchResults: {
          'src/one.ts': { ok: true, content: 'export const one = 1;' },
          // 报错文本里的路径（真实运行中是宿主绝对路径）不能被提取进 sourceRefs。
          'src/gone.ts': { ok: false, error: 'Cannot read file: ENOENT open lib/gone-copy.ts' },
        },
      },
      undefined,
      { toolSucceeded: true }
    );
    const legacySummary = buildPcvNodeEvidenceSummary(legacy.pcvNodeEvidence);
    expect(legacySummary.sourceRefs).toEqual(['src/one.ts']);
    expect(legacySummary.sourceRefDiagnostics).toEqual([
      { input: 'src/gone.ts', reason: 'failed-tool-call', status: 'missing' },
    ]);
  });

  it('keeps a batch cancelled mid-read failed and out of sourceRefs (C052 cancel regression)', async () => {
    const root = createTempProject('pcv-cancel-read-');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'one.ts'), 'export const one = 1;');
    writeFileSync(path.join(root, 'src', 'two.ts'), 'export const two = 2;');
    const controller = new AbortController();
    // 第一个成员读完（指纹比较）后立即取消：第二个成员不会被读取。
    class AbortAfterFirstRead extends DeltaCache {
      override check(filePath: string, content: string) {
        const checked = super.check(filePath, content);
        controller.abort();
        return checked;
      }
    }

    const { toolSucceeded, summary } = await recordRoutedRead(
      root,
      { filePaths: ['src/one.ts', 'src/two.ts'] },
      { abortSignal: controller.signal, deltaCache: new AbortAfterFirstRead() }
    );

    expect(toolSucceeded).toBe(false);
    expect(summary.sourceRefs).toEqual([]);
    expect(summary.missingLinkReasons).toContain('missing-source-refs');
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

  /** C053：只看本记录器的两条降级/兼容日志，其它模块的日志不影响断言。 */
  function pcvLogCalls(spy: { mock: { calls: unknown[][] } }, code: string): string[] {
    return spy.mock.calls
      .map((args) => args[0])
      .filter(
        (message): message is string =>
          typeof message === 'string' && message.startsWith(`[PcvNodeEvidence] ${code}`)
      );
  }

  it('logs the failed check and input shape when source evidence falls back (C053)', () => {
    const warn = vi
      .spyOn(Logger.getInstance(), 'warn')
      .mockImplementation(() => Logger.getInstance());
    try {
      const quality = buildPcvQualityGateEvidence({
        source: { pcvNodeEvidence: { schemaVersion: 1, nodeId: 'x', ledgerRefs: 'oops' } },
        artifact: { referencedFiles: ['src/widget.ts'] },
        dimId: 'probe',
        gate: { pass: true, action: 'pass' },
      });
      expect(quality.missingLinkReasons).toContain('invalid-source-pcv-evidence');
      const messages = pcvLogCalls(warn, 'pcv_quality_gate_invalid_source_evidence');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('dimId=probe');
      // 首个未通过的检查项：schemaVersion/nodeId 合法，chainNodeId 缺失。
      expect(messages[0]).toContain('failedCheck=chainNodeId');
      expect(messages[0]).toContain('inputType=object');
      expect(messages[0]).toContain('keys=[schemaVersion,nodeId,ledgerRefs]');
      expect(messages[0]).toContain('schemaVersion=1');
      expect(messages[0]).toContain('nodeId=x');

      warn.mockClear();
      const ctx = createLoop();
      buildPcvQualityGateEvidence({
        source: { pcvNodeEvidence: { ...ctx.buildResult().pcvNodeEvidence, ledgerRefs: 'oops' } },
        artifact: { referencedFiles: ['src/widget.ts'] },
        dimId: 'probe',
        gate: { pass: true, action: 'pass' },
      });
      const fieldMessages = pcvLogCalls(warn, 'pcv_quality_gate_invalid_source_evidence');
      expect(fieldMessages).toHaveLength(1);
      expect(fieldMessages[0]).toContain('failedCheck=ledgerRefs');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the legacy groundingEnforcement default and keeps off (C053)', () => {
    const info = vi
      .spyOn(Logger.getInstance(), 'info')
      .mockImplementation(() => Logger.getInstance());
    try {
      const ctx = createLoop();
      const { groundingEnforcement: _omitted, ...legacy } = ctx.buildResult().pcvNodeEvidence;
      const quality = buildPcvQualityGateEvidence({
        source: { pcvNodeEvidence: legacy },
        artifact: { referencedFiles: ['src/widget.ts'] },
        gate: { pass: true, action: 'pass' },
      });
      expect(quality.groundingEnforcement).toBe('off');
      const messages = pcvLogCalls(info, 'pcv_legacy_summary_grounding_enforcement_defaulted');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(`nodeId=${legacy.nodeId}`);
      expect(messages[0]).toContain('defaulted=off');
    } finally {
      info.mockRestore();
    }
  });

  it('does not log either C053 path for absent or complete source evidence', () => {
    const warn = vi
      .spyOn(Logger.getInstance(), 'warn')
      .mockImplementation(() => Logger.getInstance());
    const info = vi
      .spyOn(Logger.getInstance(), 'info')
      .mockImplementation(() => Logger.getInstance());
    try {
      const ctx = createLoop();
      for (const source of [{}, { pcvNodeEvidence: ctx.buildResult().pcvNodeEvidence }]) {
        buildPcvQualityGateEvidence({
          source,
          artifact: { referencedFiles: ['src/widget.ts'] },
          dimId: 'probe',
          gate: { pass: true, action: 'pass' },
        });
      }
      for (const spy of [warn, info]) {
        expect(pcvLogCalls(spy, 'pcv_quality_gate_invalid_source_evidence')).toEqual([]);
        expect(pcvLogCalls(spy, 'pcv_legacy_summary_grounding_enforcement_defaulted')).toEqual([]);
      }
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
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

// I27：PCV 来源诊断上限。L5-P28 起身份索引只经宿主真实形状 ProjectScopeSourceIdentityMap v1 注入
// （运行期经 context.projectScopeSourceIdentityMap，质量门经 sharedState._projectScopeSourceIdentityMap），
// 这里验证诊断上限、去重计数、原因聚合与进程事件截断。
describe('PCV source ref diagnostics cap (I27)', () => {
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
  const sourceIdentityMap = hostSourceIdentityMap(sourceIdentities);

  function createIndexedLoop(diagnostics = new DiagnosticsCollector()) {
    const messages = createMessageAdapter(null);
    messages.appendUserMessage('review code');
    return new LoopContext({
      messages,
      capabilities: [],
      baseSystemPrompt: 'review',
      allowedToolIds: ['code'],
      toolSchemas: [],
      source: 'system',
      budget: { maxIterations: 1 },
      prompt: 'review code',
      context: {
        pipelinePhase: 'analyze',
        dimensionId: 'probe',
        projectScopeSourceIdentityMap: sourceIdentityMap,
      },
      diagnostics,
    });
  }

  /** 每轮一次成功的 code.read：参数路径可解析，回执正文带 perRound 个项目范围外（不可解析）的路径。 */
  function recordUnresolvedReads(ctx: LoopContext, rounds: number, perRound: number) {
    for (let round = 0; round < rounds; round++) {
      const paths = Array.from(
        { length: perRound },
        (_, index) => `vendor/missing/r${round}/file${index}.ts`
      );
      recordPcvToolResult(
        ctx.pcvNodeEvidence,
        {
          id: `read-${round}`,
          name: 'code',
          args: { action: 'read', params: { path: 'Alembic/lib/bootstrap.ts' } },
        },
        { content: paths.join('\n') },
        undefined,
        { toolSucceeded: true }
      );
    }
  }

  function warningCount(diagnostics: DiagnosticsCollector, code: string): number {
    return diagnostics.toJSON().warnings.filter((warning) => warning.code === code).length;
  }

  it('caps stored diagnostics at 64, counts distinct drops and aggregates missing link reasons', () => {
    const diagnostics = new DiagnosticsCollector();
    const ctx = createIndexedLoop(diagnostics);
    recordUnresolvedReads(ctx, 20, 60);
    // 重放前两轮同一批未命中引用：Set 去重覆盖已丢弃的条目，丢弃计数不得再增长。
    recordUnresolvedReads(ctx, 2, 60);

    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.sourceRefs).toEqual(['Alembic/lib/bootstrap.ts']);
    expect(summary.sourceRefDiagnostics).toHaveLength(64);
    expect(summary.sourceRefDiagnostics[0]).toEqual({
      input: 'vendor/missing/r0/file0.ts',
      reason: 'not-found',
      status: 'missing',
    });
    expect(summary.missingLinkReasons).toContain('unresolved-source-refs');
    expect(summary.missingLinkReasons).toContain('dropped-source-ref-diagnostics:1136');
    expect(
      summary.missingLinkReasons.filter((reason) => reason.startsWith('dropped-source-ref-'))
    ).toHaveLength(1);
    expect(
      summary.missingLinkReasons.some((reason) => reason.startsWith('missing-source-ref:'))
    ).toBe(false);
    expect(summary.missingLinkReasons.length).toBeLessThanOrEqual(8);

    const metadata = buildPcvNodeEvidenceProcessMetadata(ctx.pcvNodeEvidence);
    expect(metadata.sourceRefDiagnostics.length).toBeLessThanOrEqual(64);
    expect(metadata.sourceRefDiagnostics).toEqual(summary.sourceRefDiagnostics.slice(0, 16));
    expect(metadata.missingLinkReasons).toEqual(summary.missingLinkReasons);
    expect(JSON.stringify(metadata).length).toBeLessThan(8_000);

    // 每个进程事件都会重建元数据；两类截断诊断对同一节点证据各只报一次。
    buildPcvNodeEvidenceProcessMetadata(ctx.pcvNodeEvidence);
    expect(warningCount(diagnostics, 'pcv_source_ref_diagnostics_truncated')).toBe(1);
    expect(warningCount(diagnostics, 'pcv_process_event_source_ref_diagnostics_truncated')).toBe(1);
    expect(
      diagnostics
        .toJSON()
        .warnings.find((warning) => warning.code === 'pcv_source_ref_diagnostics_truncated')
        ?.message
    ).toContain('vendor/missing/r1/file4.ts');
  });

  it('keeps the ambiguous aggregate when the ambiguous diagnostic itself is dropped', () => {
    const ctx = createIndexedLoop();
    recordUnresolvedReads(ctx, 2, 40);
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      {
        id: 'read-ambiguous',
        name: 'code',
        args: { action: 'read', params: { path: 'index.ts:9' } },
      },
      { content: 'export {};' },
      undefined,
      { toolSucceeded: true }
    );

    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.sourceRefDiagnostics).toHaveLength(64);
    expect(summary.sourceRefDiagnostics.some((item) => item.input === 'index.ts:9')).toBe(false);
    expect(summary.missingLinkReasons).toEqual(
      expect.arrayContaining([
        'ambiguous-source-refs',
        'unresolved-source-refs',
        'dropped-source-ref-diagnostics:17',
      ])
    );
  });

  it('records failed-call diagnostics without the unresolved aggregate (I28 semantics kept)', () => {
    const ctx = createIndexedLoop();
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      { id: 'read-blocked', name: 'code', args: { action: 'read', params: { path: 'src/x.ts' } } },
      { error: 'Tool call blocked by hook' },
      undefined,
      { toolSucceeded: false }
    );
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.sourceRefDiagnostics).toEqual([
      { input: 'src/x.ts', reason: 'failed-tool-call', status: 'missing' },
    ]);
    expect(summary.missingLinkReasons).not.toContain('unresolved-source-refs');
    expect(summary.missingLinkReasons).toContain('missing-source-refs');
  });

  it('keeps the cap and restores the dropped count when a serialized summary feeds the gate', () => {
    const ctx = createIndexedLoop();
    recordUnresolvedReads(ctx, 2, 40);
    const serialized = JSON.parse(JSON.stringify(ctx.buildResult().pcvNodeEvidence));
    expect(serialized.missingLinkReasons).toContain('dropped-source-ref-diagnostics:16');

    const quality = buildPcvQualityGateEvidence({
      source: { pcvNodeEvidence: serialized },
      artifact: {
        referencedFiles: ['Alembic/lib/bootstrap.ts', 'vendor/extra/a.ts', 'vendor/extra/b.ts'],
      },
      dimId: 'probe',
      gate: { pass: true, action: 'pass' },
      sharedState: { _projectScopeSourceIdentityMap: sourceIdentityMap },
    });
    expect(quality.sourceRefDiagnostics).toHaveLength(64);
    expect(quality.missingLinkReasons).toContain('dropped-source-ref-diagnostics:18');
    expect(
      quality.missingLinkReasons.filter((reason) => reason.startsWith('dropped-source-ref-'))
    ).toHaveLength(1);
  });

  it('trims an over-cap source summary and counts the trimmed diagnostics', () => {
    const ctx = createIndexedLoop();
    const overCap = {
      ...ctx.buildResult().pcvNodeEvidence,
      sourceRefDiagnostics: Array.from({ length: 100 }, (_, index) => ({
        input: `external/${index}.ts`,
        reason: 'not-found',
        status: 'missing' as const,
      })),
    };
    const quality = buildPcvQualityGateEvidence({
      source: { pcvNodeEvidence: overCap },
      artifact: { referencedFiles: ['Alembic/lib/bootstrap.ts'] },
      dimId: 'probe',
      gate: { pass: true, action: 'pass' },
      sharedState: { _projectScopeSourceIdentityMap: sourceIdentityMap },
    });
    expect(quality.sourceRefDiagnostics).toHaveLength(64);
    expect(quality.sourceRefDiagnostics[63]?.input).toBe('external/63.ts');
    expect(quality.missingLinkReasons).toContain('dropped-source-ref-diagnostics:36');
  });

  it('tolerates malformed reasons and diagnostic entries in an over-cap source summary', () => {
    const ctx = createIndexedLoop();
    const base = ctx.buildResult().pcvNodeEvidence;
    // 结构守卫只校验这两个字段是数组；条目本身可能是宿主重组后的任意值，截断与计数不能因此抛错。
    const malformed: Record<string, unknown> = {
      ...base,
      missingLinkReasons: [...base.missingLinkReasons, 42],
      sourceRefDiagnostics: [
        null,
        ...Array.from({ length: 70 }, (_, index) => ({
          input: `external/${index}.ts`,
          reason: 'not-found',
          status: 'missing',
        })),
      ],
    };
    const build = () =>
      buildPcvQualityGateEvidence({
        source: { pcvNodeEvidence: malformed },
        artifact: { referencedFiles: ['Alembic/lib/bootstrap.ts'] },
        dimId: 'probe',
        gate: { pass: true, action: 'pass' },
        sharedState: { _projectScopeSourceIdentityMap: sourceIdentityMap },
      });
    expect(build).not.toThrow();
    const quality = build();
    expect(quality.missingLinkReasons).not.toContain('invalid-source-pcv-evidence');
    expect(quality.sourceRefDiagnostics).toHaveLength(64);
    expect(quality.missingLinkReasons).toContain('dropped-source-ref-diagnostics:7');
    expect(quality.missingLinkReasons.every((reason) => typeof reason === 'string')).toBe(true);
  });
});

// L5-P28 第二步：PCV 来源身份只读宿主契约 ProjectScopeSourceIdentityMap v1。
// 运行期节点读 context.projectScopeSourceIdentityMap 与 sharedState._projectScopeSourceIdentityMap，
// 质量门读 stageNodeContext（strategyContext）同名键与 sharedState；旧别名键与预建索引不再生效。
describe('PCV ProjectScopeSourceIdentityMap wiring (L5-P28)', () => {
  // 绝对路径按运行时临时目录拼出，不在测试里写死本机路径。
  const scopeRoot = path.join(tmpdir(), 'pcv-project-scope');
  const identities = [
    createCanonicalSourceIdentity({
      folderDisplayName: 'Alembic',
      folderPath: path.join(scopeRoot, 'Alembic'),
      projectScopeId: 'workspace',
      sourcePath: 'lib/bootstrap.ts',
    }),
    createCanonicalSourceIdentity({
      folderDisplayName: 'AlembicCore',
      folderPath: path.join(scopeRoot, 'AlembicCore'),
      projectScopeId: 'workspace',
      sourcePath: 'index.ts',
    }),
    createCanonicalSourceIdentity({
      folderDisplayName: 'AlembicPlugin',
      folderPath: path.join(scopeRoot, 'AlembicPlugin'),
      projectScopeId: 'workspace',
      sourcePath: 'index.ts',
    }),
  ];
  const bootstrapAbsolutePath = path.join(scopeRoot, 'Alembic', 'lib', 'bootstrap.ts');
  const outsideAbsolutePath = path.join(scopeRoot, 'Elsewhere', 'outside.ts');

  function createScopedLoop({
    context = {},
    sharedState = null,
    diagnostics = new DiagnosticsCollector(),
  }: {
    context?: Record<string, unknown>;
    sharedState?: Record<string, unknown> | null;
    diagnostics?: DiagnosticsCollector;
  } = {}) {
    const messages = createMessageAdapter(null);
    messages.appendUserMessage('review code');
    return new LoopContext({
      messages,
      capabilities: [],
      baseSystemPrompt: 'review',
      allowedToolIds: ['code'],
      toolSchemas: [],
      source: 'system',
      budget: { maxIterations: 1 },
      prompt: 'review code',
      context: { pipelinePhase: 'analyze', dimensionId: 'probe', ...context },
      sharedState,
      diagnostics,
    });
  }

  function recordRead(ctx: LoopContext, readPath: string, content: string) {
    recordPcvToolResult(
      ctx.pcvNodeEvidence,
      {
        id: `read-${readPath}`,
        name: 'code',
        args: { action: 'read', params: { path: readPath } },
      },
      { content },
      undefined,
      { toolSucceeded: true }
    );
  }

  const noisyContent =
    'Alembic/lib/bootstrap.ts:12 wires the runtime on Node.js; the Vue.js shell and index.ts:4 are noise.';

  function expectHostNormalization(summary: {
    missingLinkReasons: string[];
    sourceRefDiagnostics: Array<{ input: string; reason: string; status: string }>;
    sourceRefs: string[];
  }) {
    expect([...summary.sourceRefs].sort()).toEqual([
      'Alembic/lib/bootstrap.ts',
      'Alembic/lib/bootstrap.ts:12',
    ]);
    expect(summary.sourceRefDiagnostics).toEqual(
      expect.arrayContaining([
        { input: 'Node.js', reason: 'not-found', status: 'missing' },
        { input: 'Vue.js', reason: 'not-found', status: 'missing' },
        { input: 'index.ts:4', reason: 'ambiguous-basename', status: 'ambiguous' },
      ])
    );
    expect(summary.missingLinkReasons).toEqual(
      expect.arrayContaining(['unresolved-source-refs', 'ambiguous-source-refs'])
    );
    expect(summary.missingLinkReasons).not.toContain('missing-source-refs');
  }

  function pcvWarnings(diagnostics: DiagnosticsCollector, code: string) {
    return diagnostics.toJSON().warnings.filter((warning) => warning.code === code);
  }

  function pcvLoggerCalls(warn: { mock: { calls: unknown[][] } }, code: string): string[] {
    return warn.mock.calls
      .map((args) => args[0])
      .filter(
        (message): message is string =>
          typeof message === 'string' && message.startsWith(`[PcvNodeEvidence] ${code}`)
      );
  }

  it('moves Node.js-style false positives out of sourceRefs when the map arrives on context', () => {
    const ctx = createScopedLoop({
      context: { projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
    });
    recordRead(ctx, 'Alembic/lib/bootstrap.ts', noisyContent);
    expectHostNormalization(buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence));
  });

  it('reads the host sharedState channel _projectScopeSourceIdentityMap', () => {
    const ctx = createScopedLoop({
      sharedState: { _projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
    });
    recordRead(ctx, 'Alembic/lib/bootstrap.ts', noisyContent);
    expectHostNormalization(buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence));
  });

  it('reports missing-source-refs when every reference is unresolved', () => {
    const ctx = createScopedLoop({
      context: { projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
    });
    recordRead(ctx, 'vendor/missing/runtime.ts', 'Runs on Node.js with a Vue.js shell.');
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.sourceRefs).toEqual([]);
    expect(summary.missingLinkReasons).toEqual(
      expect.arrayContaining(['missing-source-refs', 'unresolved-source-refs'])
    );
    expect(summary.sourceRefDiagnostics).toEqual(
      expect.arrayContaining([
        { input: 'vendor/missing/runtime.ts', reason: 'not-found', status: 'missing' },
        { input: 'Node.js', reason: 'not-found', status: 'missing' },
      ])
    );
  });

  it('maps absolute paths to their qualified path and never keeps them verbatim', () => {
    const ctx = createScopedLoop({
      context: { projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
    });
    recordRead(
      ctx,
      bootstrapAbsolutePath,
      `${bootstrapAbsolutePath}:30 calls into ${outsideAbsolutePath}:2`
    );
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect([...summary.sourceRefs].sort()).toEqual([
      'Alembic/lib/bootstrap.ts',
      'Alembic/lib/bootstrap.ts:30',
    ]);
    expect(summary.sourceRefs.some((ref) => ref.startsWith(scopeRoot))).toBe(false);
    expect(summary.sourceRefDiagnostics).toEqual([
      { input: `${outsideAbsolutePath}:2`, reason: 'not-found', status: 'missing' },
    ]);
  });

  it('does not fall back to folder-relative paths (no Core single-folder relative resolution)', () => {
    const ctx = createScopedLoop({
      context: { projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
    });
    recordRead(ctx, 'lib/bootstrap.ts', 'bootstrap.ts:3 is the unique basename');
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    // 带目录的相对路径不在 qualified 索引里，按宿主准入规则记 missing；唯一 basename 匹配保留。
    expect(summary.sourceRefs).toEqual(['Alembic/lib/bootstrap.ts:3']);
    expect(summary.sourceRefDiagnostics).toEqual([
      { input: 'lib/bootstrap.ts', reason: 'not-found', status: 'missing' },
    ]);
  });

  it('normalizes quality gate refs through both strategyContext and sharedState injection', () => {
    const artifact = {
      findings: [
        {
          evidence: 'Alembic/lib/bootstrap.ts:12 is verified; Node.js and index.ts:4 are noise.',
          finding: 'Bootstrap source identity verified',
          importance: 8,
        },
      ],
      metadata: { memoryFindingCount: 1 },
      referencedFiles: ['Alembic/lib/bootstrap.ts', bootstrapAbsolutePath, 'Vue.js', 'index.ts'],
    };
    const viaStrategyContext = buildPcvQualityGateEvidence({
      artifact,
      dimId: 'architecture',
      gate: { action: 'pass', pass: true },
      source: {},
      stageNodeContext: { projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
    });
    const viaSharedState = buildPcvQualityGateEvidence({
      artifact,
      dimId: 'architecture',
      gate: { action: 'pass', pass: true },
      sharedState: { _projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
      source: {},
    });
    for (const evidence of [viaStrategyContext, viaSharedState]) {
      expect([...evidence.sourceRefs].sort()).toEqual([
        'Alembic/lib/bootstrap.ts',
        'Alembic/lib/bootstrap.ts:12',
      ]);
      expect(evidence.findingRefs.accepted[0]?.sourceRefs).toEqual(['Alembic/lib/bootstrap.ts:12']);
      expect(evidence.sourceRefDiagnostics).toEqual(
        expect.arrayContaining([
          { input: 'Node.js', reason: 'not-found', status: 'missing' },
          { input: 'Vue.js', reason: 'not-found', status: 'missing' },
          { input: 'index.ts', reason: 'ambiguous-basename', status: 'ambiguous' },
        ])
      );
      expect(evidence.missingLinkReasons).toEqual(
        expect.arrayContaining(['unresolved-source-refs', 'ambiguous-source-refs'])
      );
      expect(evidence.missingLinkReasons).not.toContain('missing-source-refs');
    }

    const allUnresolved = buildPcvQualityGateEvidence({
      artifact: { referencedFiles: ['Node.js', 'vendor/missing/a.ts'] },
      dimId: 'architecture',
      gate: { action: 'pass', pass: true },
      sharedState: { _projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
      source: {},
    });
    expect(allUnresolved.sourceRefs).toEqual([]);
    expect(allUnresolved.missingLinkReasons).toEqual(
      expect.arrayContaining(['missing-source-refs', 'unresolved-source-refs'])
    );
  });

  it.each([
    ['an unsupported contractVersion', { contractVersion: 2 }],
    ['a different contract name', { contract: 'ProjectScopeSourceIdentityList' }],
    ['non-array entries', { entries: { 'Alembic/lib/bootstrap.ts': true } }],
  ])('builds no index and warns exactly once for %s', (_label, override) => {
    const rejected = { ...hostSourceIdentityMap(identities), ...override };
    const diagnostics = new DiagnosticsCollector();
    // 宿主把同一个对象同时写进 context 与 sharedState；拒绝诊断按一次解析只报一条。
    const ctx = createScopedLoop({
      context: { projectScopeSourceIdentityMap: rejected },
      sharedState: { _projectScopeSourceIdentityMap: rejected },
      diagnostics,
    });
    recordRead(ctx, 'Alembic/lib/bootstrap.ts', noisyContent);
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    // 未建索引：引用按原样保留（与没有 ProjectScope 的运行一致），不产生来源诊断。
    expect(summary.sourceRefs).toEqual(expect.arrayContaining(['Node.js', 'index.ts:4']));
    expect(summary.sourceRefDiagnostics).toEqual([]);
    const warnings = pcvWarnings(diagnostics, 'pcv_source_identity_map_rejected');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('ProjectScopeSourceIdentityMap');

    const warn = vi
      .spyOn(Logger.getInstance(), 'warn')
      .mockImplementation(() => Logger.getInstance());
    try {
      const gate = buildPcvQualityGateEvidence({
        artifact: { referencedFiles: ['Node.js', 'Alembic/lib/bootstrap.ts'] },
        dimId: 'architecture',
        gate: { action: 'pass', pass: true },
        sharedState: { _projectScopeSourceIdentityMap: rejected },
        source: {},
        stageNodeContext: { projectScopeSourceIdentityMap: rejected },
      });
      expect(gate.sourceRefs).toEqual(expect.arrayContaining(['Node.js']));
      expect(pcvLoggerCalls(warn, 'pcv_source_identity_map_rejected')).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores the retired alias keys and pre-built index candidates', () => {
    const aliasPayload = {
      _sourceIdentities: identities,
      canonicalSourceIdentities: identities,
      projectIntelligence: { sourceIdentities: identities },
      projectScope: { sourceIdentities: identities },
      projectScopeAnalysis: { sourceIdentities: identities },
      projectScopeSourceIdentities: identities,
      projectScopeSourceRefIndex: {
        ambiguousBasenames: new Set<string>(),
        byBasename: new Map(),
        byQualifiedPath: new Map(),
      },
      sourceIdentities: identities.map((sourceIdentity) => ({ sourceIdentity })),
      sourceRefIdentities: identities,
      sourceRefIndex: {
        ambiguousBasenames: new Set<string>(),
        byBasename: new Map(),
        byQualifiedPath: new Map(),
      },
    };
    const diagnostics = new DiagnosticsCollector();
    const ctx = createScopedLoop({ context: aliasPayload, sharedState: aliasPayload, diagnostics });
    recordRead(ctx, 'Alembic/lib/bootstrap.ts', noisyContent);
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.sourceRefs).toEqual(expect.arrayContaining(['Node.js', 'Vue.js', 'index.ts:4']));
    expect(summary.sourceRefDiagnostics).toEqual([]);
    expect(diagnostics.toJSON().warnings).toEqual([]);

    const gate = buildPcvQualityGateEvidence({
      artifact: { ...aliasPayload, referencedFiles: ['Node.js', 'Alembic/lib/bootstrap.ts'] },
      dimId: 'architecture',
      gate: { action: 'pass', pass: true },
      sharedState: aliasPayload,
      source: aliasPayload,
      stageNodeContext: aliasPayload,
    });
    expect(gate.sourceRefs).toEqual(expect.arrayContaining(['Node.js']));
    expect(gate.sourceRefDiagnostics).toEqual([]);
  });

  it('falls through to the sharedState map when the context map is rejected and warns once', () => {
    const diagnostics = new DiagnosticsCollector();
    const ctx = createScopedLoop({
      context: {
        projectScopeSourceIdentityMap: { ...hostSourceIdentityMap(identities), contractVersion: 2 },
      },
      sharedState: { _projectScopeSourceIdentityMap: hostSourceIdentityMap(identities) },
      diagnostics,
    });
    recordRead(ctx, 'Alembic/lib/bootstrap.ts', noisyContent);
    expectHostNormalization(buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence));
    const warnings = pcvWarnings(diagnostics, 'pcv_source_identity_map_rejected');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(
      'context.projectScopeSourceIdentityMap: contractVersion=2'
    );
    expect(warnings[0]?.message).toContain(
      'indexed from sharedState._projectScopeSourceIdentityMap'
    );
  });

  it('skips malformed entries, keeps the rest of the index and warns once', () => {
    const diagnostics = new DiagnosticsCollector();
    const map = hostSourceIdentityMap(identities);
    const ctx = createScopedLoop({
      context: {
        projectScopeSourceIdentityMap: {
          ...map,
          entries: [...map.entries, null, { qualifiedPath: 42 }, 'Alembic/lib/other.ts'],
        },
      },
      diagnostics,
    });
    recordRead(ctx, 'Alembic/lib/bootstrap.ts', noisyContent);
    expectHostNormalization(buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence));
    const warnings = pcvWarnings(diagnostics, 'pcv_source_identity_map_entries_skipped');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('skipped 3 entries');
    expect(pcvWarnings(diagnostics, 'pcv_source_identity_map_rejected')).toEqual([]);
  });

  it('records an absolute path registered under two qualified paths as ambiguous', () => {
    const sharedAbsolutePath = path.join(scopeRoot, 'Alembic', 'packages', 'shared', 'index.ts');
    const ctx = createScopedLoop({
      context: {
        projectScopeSourceIdentityMap: hostSourceIdentityMap([
          { absolutePath: sharedAbsolutePath, qualifiedPath: 'Alembic/packages/shared/index.ts' },
          { absolutePath: sharedAbsolutePath, qualifiedPath: 'Shared/index.ts' },
          ...identities,
        ]),
      },
    });
    recordRead(ctx, sharedAbsolutePath, 'export {};');
    const summary = buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence);
    expect(summary.sourceRefs).toEqual([]);
    expect(summary.sourceRefDiagnostics).toEqual([
      { input: sharedAbsolutePath, reason: 'ambiguous-absolute-path', status: 'ambiguous' },
    ]);
    expect(summary.missingLinkReasons).toEqual(
      expect.arrayContaining(['ambiguous-source-refs', 'missing-source-refs'])
    );
  });

  it('indexes one host map object once across node evidences (WeakMap cache)', () => {
    const debug = vi
      .spyOn(Logger.getInstance(), 'debug')
      .mockImplementation(() => Logger.getInstance());
    try {
      const map = hostSourceIdentityMap(identities);
      for (let run = 0; run < 3; run++) {
        const ctx = createScopedLoop({
          context: { projectScopeSourceIdentityMap: map },
          sharedState: { _projectScopeSourceIdentityMap: map },
        });
        recordRead(ctx, 'Alembic/lib/bootstrap.ts', noisyContent);
        expectHostNormalization(buildPcvNodeEvidenceSummary(ctx.pcvNodeEvidence));
      }
      buildPcvQualityGateEvidence({
        artifact: { referencedFiles: ['Alembic/lib/bootstrap.ts'] },
        dimId: 'architecture',
        gate: { action: 'pass', pass: true },
        sharedState: { _projectScopeSourceIdentityMap: map },
        source: {},
        stageNodeContext: { projectScopeSourceIdentityMap: map },
      });
      const indexedLogs = debug.mock.calls
        .map((args) => args[0])
        .filter(
          (message) =>
            typeof message === 'string' &&
            message.startsWith('[PcvNodeEvidence] indexed ProjectScopeSourceIdentityMap')
        );
      expect(indexedLogs).toHaveLength(1);
      expect(indexedLogs[0]).toContain('3 qualified paths');
      expect(indexedLogs[0]).toContain('3 absolute paths');
      expect(indexedLogs[0]).toContain('1 ambiguous basenames');
    } finally {
      debug.mockRestore();
    }
  });

  it('no longer resolves stage node identity from the retired stageNodeMap alias', () => {
    const stageNodeMap = {
      analyze: { chainNodeId: 'pcvm:chain:analyze', pcvNodeId: 'pcvm:analyze' },
    };
    expect(
      resolvePcvStageNodeIdentity({ context: { stageNodeMap }, pipelinePhase: 'analyze' })
    ).toBeNull();
    expect(
      resolvePcvStageNodeIdentity({
        context: { pcvStageNodeMap: stageNodeMap },
        pipelinePhase: 'analyze',
      })
    ).toEqual({ chainNodeId: 'pcvm:chain:analyze', nodeId: 'pcvm:analyze' });
    expect(
      resolvePcvStageNodeIdentity({
        sharedState: { _pcvChainNodes: stageNodeMap },
        pipelinePhase: 'analyze',
      })
    ).toEqual({ chainNodeId: 'pcvm:chain:analyze', nodeId: 'pcvm:analyze' });
  });

  it('PipelineStrategy no longer projects the retired identity and stage-map aliases', async () => {
    const sharedState: Record<string, unknown> = {
      _dimensionScopeId: 'dim-agent',
      sourceIdentities: identities,
      projectScopeSourceIdentities: identities,
      stageNodeMap: { analyze: 'pcvm:analyze' },
    };
    const strategyContext: Record<string, unknown> = {
      source: 'system',
      diagnostics: new DiagnosticsCollector(),
      sharedState,
      sourceIdentities: identities,
      projectScopeSourceIdentities: identities,
      stageNodeMap: { analyze: 'pcvm:analyze' },
    };
    const seen: Array<{ context: Record<string, unknown>; sharedState: unknown }> = [];
    const runtime = {
      id: 'alias-projection-runtime',
      logger: { info: () => undefined },
      reactLoop: vi.fn(async (_prompt: string, opts: Record<string, unknown>) => {
        seen.push({
          context: opts.context as Record<string, unknown>,
          sharedState: opts.sharedState,
        });
        return { reply: 'done', toolCalls: [], tokenUsage: { input: 1, output: 1 }, iterations: 1 };
      }),
    };
    const strategy = new PipelineStrategy({ stages: [{ name: 'analyze', capabilities: [] }] });
    await strategy.execute(runtime, AgentMessage.internal('analyze'), { strategyContext });

    expect(seen).toHaveLength(1);
    const [stage] = seen;
    expect(stage?.context).not.toHaveProperty('sourceIdentities');
    expect(stage?.context).not.toHaveProperty('stageNodeMap');
    // 普通阶段原样传递宿主 sharedState，不再浅拷贝出 _sourceIdentities。
    expect(stage?.sharedState).toBe(sharedState);
    expect(stage?.sharedState).not.toHaveProperty('_sourceIdentities');
  });
});
