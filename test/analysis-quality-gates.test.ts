/**
 * summary_rewrite — 写作类失败按短板分流(2026-07-02 用户决策)。
 *
 * 背景：真机 ts-js-module 案例 depth/breadth/evidence 全 100、22 条 findings 已在 memory，
 * 唯 coherence=27.84(analyze 超时打断总结，文本仅 98 字符)——旧口径 analysis_retry 整段
 * 带工具重挖(最贵)，且 retry 又被 session 输入预算压制直接失败。新口径：findings 充足的
 * 写作类失败走 summary_rewrite(零工具单调用重组文本)；findings 不足才回 analyze 重挖。
 */
import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAnalysisArtifact,
  buildAnalysisReport,
} from '../src/agent/evaluation/analysisArtifact.js';
import {
  applyModuleCoverageGate,
  insightGateEvaluator,
} from '../src/agent/evaluation/gateEvaluators.js';
import {
  analysisQualityGate,
  applyDepthRetryGate,
  DEPTH_GAP_REASON,
  GENERIC_DEPTH_GAP_HINT,
} from '../src/agent/evaluation/qualityGates.js';
import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';
import {
  buildRecordRepairPrompt,
  buildRetryPrompt,
  buildSummaryRewritePrompt,
} from '../src/agent/prompts/insightGate.js';
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
                // 真实 batch 成员的展示态每行都带 `N|` 前缀（L7-P13：无前缀文本不再被当成源码片段）。
                { path: 'src/good.ts', content: '1|const ready = true;' },
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
  it('维度名分支(作者本就用小节组织) → 列出缺口维度并指向深度槽，明确禁止凭空补写', () => {
    const prompt = buildRetryPrompt(`${DEPTH_GAP_REASON}: 失败模式 / 权衡`);
    expect(prompt).toContain('以下深度维度缺少真实代码接地：失败模式 / 权衡');
    expect(prompt).toContain('不要凭空补写');
    expect(prompt).toContain('note_finding');
    expect(prompt).toContain('designIntent/boundaries/failureModes/tradeoffs');
    expect(prompt).toContain('file:line');
  });
});

describe('buildRetryPrompt (C55) — 通用深度缺口不把自由叙述推回四槽模板', () => {
  function expectGenericDepthRetry(prompt: string) {
    // 通用指令不是维度名：不得被当作「以下深度维度」列出，也不得要求回到四个深度槽逐槽记录。
    expect(prompt).not.toContain('以下深度维度');
    expect(prompt).not.toContain('designIntent/boundaries/failureModes/tradeoffs');
    expect(prompt).not.toContain(GENERIC_DEPTH_GAP_HINT);
    // 引导回代码、在正文里补写带真实来源的深度断言，并保留防编造约束。
    expect(prompt).toContain('code({ action: "read" })');
    expect(prompt).toContain('因果/代价/例外/对照');
    expect(prompt).toContain('(来源: file:line)');
    expect(prompt).toContain('不要凭空补写');
    expect(prompt).toContain('读不到真实证据就不写');
  }

  it('门控通用缺口 → 同一常量路由到正文补写接地断言的分支(门控到提示端到端)', () => {
    // 自由叙述作者尝试了深度，但引用的文件都不在接地集里 → groundedCore=0 → 门控报通用指令。
    const artifact = {
      analysisText: '## 设计意图\n见 src/x.ts:5。\n## 权衡\n见 src/y.ts:9。',
      findings: [],
      referencedFiles: ['src/other.ts'],
      metadata: { memoryFindingCount: 1 },
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate).toMatchObject({ pass: false, action: 'analysis_retry' });
    expect(gate.reason).toBe(`${DEPTH_GAP_REASON}: ${GENERIC_DEPTH_GAP_HINT}`);
    expectGenericDepthRetry(buildRetryPrompt(gate.reason ?? ''));
  });

  it('缺口为空 → 同样走通用分支，不渲染空的维度清单', () => {
    expectGenericDepthRetry(buildRetryPrompt(DEPTH_GAP_REASON));
    expectGenericDepthRetry(buildRetryPrompt(`${DEPTH_GAP_REASON}:  `));
  });
});

describe('修复类提示只把已读取接地的文件列为可引用来源 (C54)', () => {
  /** 取提示中某个标题行之后、下一个空行之前的段落(清单段)。 */
  function sectionAfter(prompt: string, header: string) {
    const start = prompt.indexOf(`${header}\n`);
    expect(start, `missing section header ${header}`).toBeGreaterThanOrEqual(0);
    const body = prompt.slice(start + header.length + 1);
    const end = body.indexOf('\n\n');
    return end >= 0 ? body.slice(0, end) : body;
  }

  const GROUNDED_HEADER = '已读取接地的文件（可作为来源）:';
  const MENTIONED_HEADER = '仅提及、未读取（禁止作为引用）:';

  // 真实工件边界：src/good.ts 被成功读取(接地)，src/ghost.ts 只在正文中提及。
  const groundedArtifact = () =>
    buildAnalysisReport(
      {
        reply: '结论来自 src/ghost.ts:9 的实现，读取确认见 src/good.ts:1。',
        toolCalls: [
          {
            tool: 'code',
            args: { action: 'read', params: { filePaths: ['src/good.ts'] } },
            result: { files: [{ path: 'src/good.ts', content: '1|const ready = true;' }] },
          },
        ],
      },
      'architecture'
    ) as unknown as Record<string, unknown>;

  const renderBoth = (artifact: Record<string, unknown>) => ({
    rewrite: buildSummaryRewritePrompt({ reason: 'Analysis too short', artifact }),
    repair: buildRecordRepairPrompt({ reason: 'missing', artifact, minFindings: 3 }),
  });

  it('groundedFiles≠referencedFiles 时两份提示只把接地文件列为可引用，提及路径单列为禁止引用', () => {
    const artifact = groundedArtifact();
    expect(artifact.groundedFiles).toEqual(['src/good.ts']);
    expect(artifact.referencedFiles).toContain('src/ghost.ts');

    for (const prompt of Object.values(renderBoth(artifact))) {
      expect(prompt).not.toContain('已验证文件');
      const grounded = sectionAfter(prompt, GROUNDED_HEADER);
      expect(grounded).toContain('- src/good.ts');
      expect(grounded).not.toContain('src/ghost.ts');
      const mentioned = sectionAfter(prompt, MENTIONED_HEADER);
      expect(mentioned).toContain('- src/ghost.ts');
      expect(mentioned).not.toContain('src/good.ts');
    }
  });

  it('两份提示的硬性规则都明确上一稿/仅提及路径不得作为来源', () => {
    const { rewrite, repair } = renderBoth(groundedArtifact());
    expect(rewrite).toContain('只根据下方「已验证发现」和「已读取接地的文件」');
    expect(rewrite).toContain('禁止引入任何新文件');
    expect(rewrite).toContain('不在「已读取接地的文件」清单中的路径不得作为 (来源: …)');
    expect(repair).toContain('「仅提及、未读取」的路径只是正文提及或搜索命中，不是证据');
    // V1 报告无 evidenceMap：不得再让模型「使用分析正文中的文件路径」(正文含仅提及路径)。
    expect(repair).not.toContain('使用分析正文中的文件路径和行号');
    expect(repair).toContain('正文中仅提及的路径不可作为来源');
  });

  it('groundedFiles 为空数组时不静默回退 referencedFiles，只允许引用已有发现/证据', () => {
    const artifact = {
      analysisText: '正文提及 src/ghost.ts:9。',
      findings: [],
      referencedFiles: ['src/ghost.ts'],
      groundedFiles: [],
    };
    for (const prompt of Object.values(renderBoth(artifact))) {
      const grounded = sectionAfter(prompt, GROUNDED_HEADER);
      expect(grounded).not.toContain('src/ghost.ts');
      expect(grounded).toContain('无已读取接地的文件');
      expect(sectionAfter(prompt, MENTIONED_HEADER)).toContain('- src/ghost.ts');
    }
  });

  it('旧工件(无 groundedFiles 字段)兼容回退 referencedFiles，并注明未区分接地', () => {
    const artifact = {
      analysisText: '旧工件正文。',
      findings: [],
      referencedFiles: ['lib/legacy.ts', 42, 'lib/other.ts'],
    };
    const legacyHeader = '引用文件（旧工件未区分接地，仅可引用其中确实读取过的文件）:';
    const prompts = renderBoth(artifact);
    for (const prompt of Object.values(prompts)) {
      expect(prompt).not.toContain('已验证文件');
      expect(prompt).not.toContain(GROUNDED_HEADER);
      expect(prompt).not.toContain(MENTIONED_HEADER);
      const legacy = sectionAfter(prompt, legacyHeader);
      expect(legacy).toBe('- lib/legacy.ts\n- lib/other.ts');
    }
    // 旧工件的规则只引用实际渲染的「引用文件」段，不出现不存在的「仅提及」段规则。
    expect(prompts.rewrite).toContain('只根据下方「已验证发现」和「引用文件」');
    expect(prompts.repair).not.toContain('「仅提及、未读取」的路径');
  });

  it('来源口径分叉(接地/无接地/旧工件回退)与深度缺口分支都留下可追查的观测日志', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    try {
      renderBoth(groundedArtifact());
      renderBoth({ analysisText: '', referencedFiles: ['src/ghost.ts'], groundedFiles: [] });
      renderBoth({ analysisText: '', referencedFiles: ['lib/legacy.ts'] });
      buildRetryPrompt(`${DEPTH_GAP_REASON}: ${GENERIC_DEPTH_GAP_HINT}`);
      buildRetryPrompt(`${DEPTH_GAP_REASON}: 失败模式 / 权衡`);
      const lines = info.mock.calls.map(([message]) => String(message));
      for (const stage of ['record_repair', 'summary_rewrite']) {
        expect(lines).toContainEqual(
          expect.stringMatching(
            new RegExp(`${stage} prompt: .*path=grounded; grounded=1; mentionedOnly=1`)
          )
        );
        expect(lines).toContainEqual(
          expect.stringMatching(new RegExp(`${stage} prompt: .*path=no-grounded; grounded=0`))
        );
        expect(lines).toContainEqual(
          expect.stringMatching(
            new RegExp(`${stage} prompt: .*path=legacy-referenced-files; referenced=1`)
          )
        );
      }
      expect(lines).toContainEqual(expect.stringContaining('depth-gap branch=generic-claims'));
      expect(lines).toContainEqual(expect.stringContaining('depth-gap branch=dimension-names'));
    } finally {
      info.mockRestore();
    }
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
