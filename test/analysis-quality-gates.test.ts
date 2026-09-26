/**
 * summary_rewrite — 写作类失败按短板分流(2026-07-02 用户决策)。
 *
 * 背景：真机 ts-js-module 案例 depth/breadth/evidence 全 100、22 条 findings 已在 memory，
 * 唯 coherence=27.84(analyze 超时打断总结，文本仅 98 字符)——旧口径 analysis_retry 整段
 * 带工具重挖(最贵)，且 retry 又被 session 输入预算压制直接失败。新口径：findings 充足的
 * 写作类失败走 summary_rewrite(零工具单调用重组文本)；findings 不足才回 analyze 重挖。
 */
import { describe, expect, it } from 'vitest';
import {
  buildAnalysisArtifact,
  buildAnalysisReport,
} from '../src/agent/evaluation/analysisArtifact.js';
import {
  applyModuleCoverageGate,
  insightGateEvaluator,
} from '../src/agent/evaluation/gateEvaluators.js';
import { analysisQualityGate, applyDepthRetryGate } from '../src/agent/evaluation/qualityGates.js';
import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';
import { buildRetryPrompt, buildSummaryRewritePrompt } from '../src/agent/prompts/insightGate.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';

const PASS = { pass: true } as const;

function depthMarkdown(dims: Array<[string, string]>): string {
  return dims.map(([label, ref]) => `## ${label}\n见 ${ref}。`).join('\n');
}

describe('analysisQualityGate — coherence 短板分流', () => {
  const coherenceGapReport = (memoryFindingCount: number) => ({
    analysisText: '短文本。',
    referencedFiles: ['src/foo.ts', 'src/bar.ts', 'src/baz.ts'],
    metadata: { memoryFindingCount },
    qualityReport: {
      scores: { depthScore: 100, breadthScore: 100, evidenceScore: 100, coherenceScore: 27 },
      totalScore: 55,
      suggestions: ['Analysis text is too short or unstructured'],
    },
  });

  it('coherence 唯一短板 + findings 充足 → summary_rewrite(不整段重挖)', () => {
    const gate = analysisQualityGate(coherenceGapReport(22), { outputType: 'candidate' });
    expect(gate.pass).toBe(false);
    expect(gate.action).toBe('summary_rewrite');
  });

  it('coherence 短板但 findings 不足 → 仍走 analysis_retry(证据真缺，必须重挖)', () => {
    const gate = analysisQualityGate(coherenceGapReport(1), { outputType: 'candidate' });
    expect(gate.action).toBe('analysis_retry');
  });

  it('evidence 也差时不做 rewrite 分流(写作救不回证据缺口)', () => {
    const report = {
      ...coherenceGapReport(22),
      qualityReport: {
        scores: { depthScore: 100, breadthScore: 100, evidenceScore: 30, coherenceScore: 27 },
        totalScore: 55,
        suggestions: [],
      },
    };
    const gate = analysisQualityGate(report, { outputType: 'candidate' });
    expect(gate.action).toBe('analysis_retry');
  });

  it('V1 短文本 + findings 充足 → summary_rewrite；findings 不足 → analysis_retry', () => {
    const v1Report = (memoryFindingCount: number) => ({
      analysisText: '只有九十八个字符的残缺总结。',
      referencedFiles: ['src/foo.ts', 'src/bar.ts', 'src/baz.ts'],
      metadata: { memoryFindingCount },
    });
    expect(analysisQualityGate(v1Report(22), { outputType: 'candidate' }).action).toBe(
      'summary_rewrite'
    );
    expect(analysisQualityGate(v1Report(0), { outputType: 'candidate' }).action).toBe(
      'analysis_retry'
    );
  });
});

describe('applyDepthRetryGate — 深度断言缺口分流', () => {
  it('深度接地不足 + findings 充足 → summary_rewrite(写作问题：组织已有发现)', () => {
    const artifact = {
      analysisText: depthMarkdown([['设计意图', 'src/a.ts:5']]),
      findings: [],
      referencedFiles: ['src/a.ts'],
      metadata: { memoryFindingCount: 12 },
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate.pass).toBe(false);
    expect(gate.action).toBe('summary_rewrite');
    expect(gate.reason).toContain('Depth dimensions lack grounded evidence');
  });

  it('深度接地不足 + findings 不足 → analysis_retry(证据问题：回炉重挖)', () => {
    const artifact = {
      analysisText: depthMarkdown([['设计意图', 'src/a.ts:5']]),
      findings: [],
      referencedFiles: ['src/a.ts'],
      metadata: { memoryFindingCount: 1 },
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate.action).toBe('analysis_retry');
  });
});

describe('buildSummaryRewritePrompt — 纯写作重组、防编造', () => {
  it('注入已验证发现与文件，明确禁止新引用与探索', () => {
    const prompt = buildSummaryRewritePrompt({
      reason: 'Analysis too short',
      artifact: {
        analysisText: '残缺总结。',
        findings: [
          {
            finding: 'ServiceContainer 单例约束',
            evidence: 'lib/injection/ServiceContainer.ts:40',
            importance: 9,
          },
        ],
        referencedFiles: ['lib/injection/ServiceContainer.ts'],
      },
    });
    expect(prompt).toContain('ServiceContainer 单例约束');
    expect(prompt).toContain('lib/injection/ServiceContainer.ts');
    expect(prompt).toContain('禁止引入任何新文件');
    expect(prompt).toContain('纯写作重组');
  });
});

describe('analysis evidence provenance at real gate boundaries', () => {
  it('keeps mentioned paths separate from grounded files through artifact and depth gate', () => {
    const artifact = buildAnalysisArtifact(
      {
        reply: depthMarkdown([
          ['设计意图', 'src/ghost.ts:5'],
          ['边界与前置条件', 'src/ghost.ts:9'],
        ]),
        toolCalls: [
          {
            tool: 'code',
            args: { action: 'read', path: 'src/ghost.ts' },
            result: { ok: false, status: 'error', error: 'permission denied' },
          },
        ],
      },
      'architecture'
    );
    expect(artifact.referencedFiles).toContain('src/ghost.ts');
    expect(artifact.groundedFiles).toEqual([]);
    expect(applyDepthRetryGate(PASS, artifact, true).pass).toBe(false);
  });

  it('only grounds the successful member of a batch and excludes unexecuted requests', () => {
    const report = buildAnalysisReport(
      {
        reply: 'src/mentioned.ts',
        toolCalls: [
          {
            tool: 'code',
            args: { action: 'read', params: { filePaths: ['src/good.ts', 'src/denied.ts'] } },
            result: {
              files: [
                { path: 'src/good.ts', content: 'const ready = true;' },
                { path: 'src/denied.ts', error: 'denied' },
              ],
            },
          },
          { tool: 'code', args: { action: 'read', params: { path: 'src/never.ts' } } },
        ],
      },
      'architecture'
    );
    expect(report.groundedFiles).toEqual(['src/good.ts']);
    expect(report.referencedFiles).not.toContain('src/denied.ts');
    expect(report.referencedFiles).not.toContain('src/never.ts');
  });

  it('does not satisfy module coverage from mentioned paths when actual grounding is empty', () => {
    const ownedFiles = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const artifact = buildAnalysisArtifact({ reply: ownedFiles.join(' ') }, 'architecture');
    expect(
      applyModuleCoverageGate(PASS, artifact, { moduleContext: { ownedFiles } })
    ).toMatchObject({ pass: false, action: 'analysis_retry' });
  });

  it.each([
    undefined,
    { reply: 'A new analysis with no graph or file results', toolCalls: [] },
  ])('replaces stale producer reference projections on every evaluation (%s)', (source) => {
    const sharedState = {
      _analystGraphEvidence: ['old-graph'],
      _analystGroundedRanges: { 'src/old.ts': [{ start: 1, end: 3 }] },
    };
    insightGateEvaluator(source, {}, { sharedState });
    expect(sharedState._analystGraphEvidence).toEqual([]);
    expect(sharedState._analystGroundedRanges).toEqual({});
  });

  it('uses confirmed submit receipts and the live ledger contract in scan retries', () => {
    const stages = buildScanPipelineStages({
      task: 'extract',
      producePrompt: 'produce',
      analyzeCaps: [],
      produceCaps: [],
    });
    const produce = stages.find((stage) => stage.name === 'produce') as {
      retryPromptBuilder: (reason: object, input: string, previous: object) => string;
    };
    const prompt = produce.retryPromptBuilder({ reason: '2 rejections vs 1 successes' }, '', {
      produce: {
        toolCalls: [
          { tool: 'knowledge', args: { action: 'search' }, result: { status: 'error' } },
          {
            tool: 'knowledge',
            args: { action: 'submit' },
            result: {
              status: 'created',
              id: 'saved',
              lifecycle: 'pending',
              text: 'error recovery',
            },
          },
          { tool: 'knowledge', args: { action: 'submit' }, result: { status: 'rejected' } },
          {
            tool: 'knowledge',
            args: { action: 'submit' },
            envelope: { ok: false, text: 'denied' },
          },
        ],
      },
    });
    expect(prompt).toContain('你的 2 个提交');
    expect(prompt).toContain('reasoning.evidenceRefs');
    expect(prompt).toContain('无台账');
    expect(prompt).not.toContain('reasoning.sources 必须是非空数组');
  });
});

describe('applyDepthRetryGate (C9) — 深度接地 retry 口径', () => {
  it('非候选生成 → 原样放行(不介入纯分析)', () => {
    const gate = applyDepthRetryGate(
      PASS,
      { analysisText: '', findings: [], referencedFiles: [] },
      false
    );
    expect(gate).toEqual(PASS);
  });

  it('基础门未过 → 原样放行(不在失败分析上叠加)', () => {
    const base = { pass: false, action: 'analysis_retry' as const, reason: 'too short' };
    const gate = applyDepthRetryGate(
      base,
      { analysisText: '', findings: [], referencedFiles: [] },
      true
    );
    expect(gate).toEqual(base);
  });

  it('没尝试深度(无深度分节) → 放行，不制造回归', () => {
    const gate = applyDepthRetryGate(
      PASS,
      {
        analysisText: '普通分析，无深度分节。见 src/a.ts:1。',
        findings: [],
        referencedFiles: ['src/a.ts'],
      },
      true
    );
    expect(gate.pass).toBe(true);
  });

  it('尝试了深度但接地不足(<2 维) → analysis_retry，reason 带缺口维度', () => {
    // 只有「设计意图」挂在真读过的文件上；其余维度缺失。
    const artifact = {
      analysisText: depthMarkdown([['设计意图', 'src/a.ts:5']]),
      findings: [],
      referencedFiles: ['src/a.ts'],
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate.pass).toBe(false);
    expect(gate.action).toBe('analysis_retry');
    expect(gate.reason).toContain('Depth dimensions lack grounded evidence');
  });

  it('防编造：深度分节塞了引用但文件没被真读过 → 不算接地 → retry', () => {
    const artifact = {
      analysisText: depthMarkdown([
        ['设计意图', 'src/ghost.ts:5'],
        ['边界与前置条件', 'src/ghost.ts:9'],
      ]),
      findings: [],
      referencedFiles: [], // 没读过任何文件 → 引用无法接地
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate.pass).toBe(false);
    expect(gate.action).toBe('analysis_retry');
  });

  it('接地 ≥2 个深度维度 → 放行', () => {
    const artifact = {
      analysisText: depthMarkdown([
        ['设计意图', 'src/a.ts:5'],
        ['边界与前置条件', 'src/b.ts:3'],
      ]),
      findings: [],
      referencedFiles: ['src/a.ts', 'src/b.ts'],
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate.pass).toBe(true);
  });
});

describe('buildRetryPrompt (C9) — 深度缺口分支只叫「回代码重挖」，不诱导编造', () => {
  it('深度缺口 reason → 回 Analyst 段重挖，明确禁止凭空补写', () => {
    const prompt = buildRetryPrompt('Depth dimensions lack grounded evidence: 失败模式 / 权衡');
    expect(prompt).toContain('失败模式 / 权衡');
    expect(prompt).toContain('不要凭空补写');
    expect(prompt).toContain('note_finding');
    expect(prompt).toContain('file:line');
  });
});

describe('note_finding 深度槽序列化 (C10)', () => {
  it('填了深度槽 → 序列化成 `## <label>` 分节并入 evidence(即 reviewRecipeDepth 输入格式)', async () => {
    let capturedEvidence = '';
    const ctx = {
      memoryCoordinator: {
        noteFinding: (_finding: string, evidence: string) => {
          capturedEvidence = evidence;
          return { recorded: true, target: 'activeContext', importance: 8, scratchpadSize: 1 };
        },
      },
      runtime: {},
    } as unknown as Parameters<typeof handleMemory>[2];

    await handleMemory(
      'note_finding',
      {
        finding: 'UserService 用 @Injectable',
        evidenceRefs: ['E-5'],
        importance: 8,
        designIntent: '显式标注而非扫描，见 src/services/UserService.ts:5。',
        failureModes: '缺失即启动期抛错，见 src/services/UserService.ts:5。',
      },
      ctx
    );

    expect(capturedEvidence).toContain('src/services/UserService.ts:5');
    expect(capturedEvidence).toContain('## 设计意图');
    expect(capturedEvidence).toContain('## 失败模式');
  });
});

it('does not ground an outline display or failed plain-text read as source evidence', () => {
  const artifact = buildAnalysisArtifact(
    {
      reply: 'src/outline.ts and src/failed.ts',
      toolCalls: [
        {
          tool: 'code',
          args: { action: 'read', path: 'src/outline.ts' },
          result: {
            files: [{ path: 'src/outline.ts', mode: 'outline', content: 'function names only' }],
          },
        },
        {
          tool: 'code',
          args: { action: 'read', path: 'src/failed.ts' },
          result: 'code.read failed: permission denied',
        },
      ],
    },
    'architecture'
  );
  expect(artifact.groundedFiles).toEqual([]);
});

it('V1 gate uses explicit grounding while preserving the legacy report contract', () => {
  const report = buildAnalysisReport(
    { reply: `## Scope\n${'Detailed code analysis. '.repeat(25)} src/a.ts src/b.ts src/c.ts` },
    'architecture'
  );
  expect(analysisQualityGate(report, { outputType: 'candidate' })).toMatchObject({
    pass: false,
    action: 'analysis_retry',
  });
  const { groundedFiles: _grounded, ...legacy } = report;
  expect(analysisQualityGate(legacy, { outputType: 'candidate' }).pass).toBe(true);
});
