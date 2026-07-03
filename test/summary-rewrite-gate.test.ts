/**
 * summary_rewrite — 写作类失败按短板分流(2026-07-02 用户决策)。
 *
 * 背景：真机 ts-js-module 案例 depth/breadth/evidence 全 100、22 条 findings 已在 memory，
 * 唯 coherence=27.84(analyze 超时打断总结，文本仅 98 字符)——旧口径 analysis_retry 整段
 * 带工具重挖(最贵)，且 retry 又被 session 输入预算压制直接失败。新口径：findings 充足的
 * 写作类失败走 summary_rewrite(零工具单调用重组文本)；findings 不足才回 analyze 重挖。
 */
import { describe, expect, it } from 'vitest';

import { analysisQualityGate, applyDepthRetryGate } from '../src/agent/evaluation/qualityGates.js';
import { buildSummaryRewritePrompt } from '../src/agent/prompts/insightGate.js';

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
