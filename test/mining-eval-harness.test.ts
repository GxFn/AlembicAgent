/**
 * P0-2/P0-3(挖掘质量升级)：eval harness 确定性核心 + Judge 机械面的单测。
 * LLM 调用不在此测(judge.chat 注入 fake)；真实 Tier-B 由 `npm run eval:mining` 手动跑。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs 脚本库无类型声明；单测直测其运行时行为。
import {
  candidateCitedFiles,
  collectRunObservations,
  matchesExpected,
  matchesNotExpected,
  renderReportMarkdown,
  scoreFixture,
} from '../scripts/lib/mining-eval-core.mjs';
// @ts-expect-error — 同上。
import {
  buildJudgePrompt,
  computeJudgeCalibration,
  judgeCandidate,
  parseJudgeVerdict,
  sliceEvidenceForJudge,
  verifyJudgeCitations,
} from '../scripts/lib/mining-judge.mjs';

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const CANDIDATE = {
  title: 'Wrap handler return values with wrapResult',
  kind: 'rule',
  doClause: 'Use wrapResult from src/shared/result.ts to wrap the handler body',
  content: { markdown: 'All handlers wrap with wrapResult returning Result<T>.', rationale: 'x' },
  reasoning: {
    sources: [
      'src/handlers/user-handler.ts:11-19',
      'src/handlers/order-handler.ts:11-19',
      'src/handlers/billing-handler.ts:13-21',
    ],
  },
};

describe('mining-eval-core — 匹配与指标(确定性)', () => {
  const expected = {
    key: 'wrapresult-envelope-rule',
    keywords: ['wrapResult', 'Result', 'handler'],
    mustCiteFiles: ['src/handlers/user-handler.ts', 'src/handlers/order-handler.ts'],
  };

  it('候选命中 expected：关键词过半 + mustCiteFiles 全被 cited', () => {
    expect(matchesExpected(CANDIDATE, expected)).toBe(true);
    expect(candidateCitedFiles(CANDIDATE).size).toBe(3);
  });

  it('缺 cited 文件 → 不命中(引用覆盖是硬条件)', () => {
    const partial = {
      ...CANDIDATE,
      reasoning: { sources: ['src/handlers/user-handler.ts:11-19'] },
    };
    expect(matchesExpected(partial, expected)).toBe(false);
  });

  it('notExpected 只在 title/doClause 窄面匹配(正文举例不误伤)', () => {
    const trivial = { title: 'Handlers import ../shared/result', doClause: 'import it' };
    expect(matchesNotExpected(trivial, { key: 'x', keywords: ['import'] })).toBe(true);
    expect(matchesNotExpected(CANDIDATE, { key: 'x', keywords: ['import'] })).toBe(false);
  });

  it('scoreFixture：recall/heuristicPrecision/triviality + judge 口径切换', () => {
    const fixture = {
      id: 'fx',
      expected: [expected],
      notExpected: [{ key: 'trivial-import', keywords: ['import'] }],
    };
    const score = scoreFixture({
      fixture,
      candidates: [CANDIDATE, { title: 'Handlers import shared', doClause: 'import ../shared' }],
      judgeVerdicts: [{ verdict: 'uphold' }, { verdict: 'trivial' }],
    });
    expect(score.recall).toBe(1);
    expect(score.heuristicPrecision).toBe(0.5);
    expect(score.judgePrecision).toBe(0.5);
    expect(score.trivialityRate).toBe(0.5);
    // 报告可渲染(不抛、含关键行)。
    const md = renderReportMarkdown({
      kind: 'MiningEvalReport',
      version: 1,
      startedAt: 'T',
      provider: 'p/m',
      judgeProvider: null,
      totals: { candidates: 2, inputTokens: 1, outputTokens: 1, abandoned: 0 },
      fixtures: [
        {
          fixtureId: 'fx',
          score,
          judgeVerdicts: null,
          observations: {
            status: 'success',
            abandonedModules: [],
            submitRepairs: {},
            toolDistribution: {},
            usage: null,
          },
        },
      ],
      notes: [],
    });
    expect(md).toContain('wrapresult-envelope-rule');
  });

  it('collectRunObservations：聚合 abandoned/submitRepairs/工具分布(P0-4 观测面)', () => {
    const observations = collectRunObservations({
      status: 'success',
      usage: { inputTokens: 10, outputTokens: 5, iterations: 3, durationMs: 9 },
      toolCalls: [{ tool: 'code' }, { tool: 'code' }, { tool: 'knowledge' }],
      phases: {
        abandonedModules: [
          { unitId: 'weak', stage: 'quality_gate', action: 'degraded_no_findings', reason: 'r' },
        ],
        moduleResults: {
          ok: {
            phases: {
              _pipelineOutcome: {
                outcome: 'completed',
                submitRepairs: { core_code_backfilled: 2 },
              },
            },
          },
          weak: { phases: { _pipelineOutcome: { outcome: 'abandoned' } } },
        },
      },
    });
    expect(observations.abandonedModules).toHaveLength(1);
    expect(observations.submitRepairs).toEqual({ core_code_backfilled: 2 });
    expect(observations.toolDistribution).toEqual({ code: 2, knowledge: 1 });
  });
});

describe('mining-judge — 切片/解析/引用机械校验(确定性)', () => {
  function makeProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'judge-test-'));
    tempRoots.push(root);
    const dir = join(root, 'src/handlers');
    rmSync(dir, { force: true, recursive: true });
    // 简单两层目录
    writeFileSync(join(root, 'file.ts'), 'l1\nl2\nl3\nl4\nl5\n');
    return root;
  }

  const candidate = {
    title: 't',
    kind: 'rule',
    doClause: 'do',
    content: { markdown: 'claim' },
    reasoning: { sources: ['file.ts:2-4'] },
  };

  it('sliceEvidenceForJudge：按 sources 重切真实文件(带行号)', () => {
    const root = makeProject();
    const slices = sliceEvidenceForJudge(candidate, root);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ file: 'file.ts', start: 2, end: 4 });
    expect(slices[0].body).toBe('2|l2\n3|l3\n4|l4');
    // prompt 含隔离说明与切片
    const prompt = buildJudgePrompt(candidate, slices);
    expect(prompt).toContain('refute');
    expect(prompt).toContain('file.ts:2-4');
  });

  it('parseJudgeVerdict：JSON 提取 + 非法 verdict → null(保守)', () => {
    expect(
      parseJudgeVerdict(
        'noise {"entailment":"entailed","trivial":false,"actionable":true,"scopeCorrect":true,"verdict":"uphold","citedLines":["file.ts:3"],"reason":"ok"} tail'
      )
    ).toMatchObject({ verdict: 'uphold', citedLines: ['file.ts:3'] });
    expect(parseJudgeVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseJudgeVerdict('not json')).toBeNull();
  });

  it('verifyJudgeCitations：引用必须落在切片区间(judge 也不被信任)', () => {
    const slices = [{ file: 'file.ts', start: 2, end: 4, body: '' }];
    expect(verifyJudgeCitations({ citedLines: ['file.ts:3'] }, slices)).toBe(true);
    expect(verifyJudgeCitations({ citedLines: ['file.ts:9'] }, slices)).toBe(false);
    expect(verifyJudgeCitations({ citedLines: ['other.ts:3'] }, slices)).toBe(false);
    expect(verifyJudgeCitations({ citedLines: [] }, slices)).toBe(false);
  });

  it('verifyJudgeCitations：区间引用 "file:start-end"(切片头同款格式,门0 真跑主形态)', () => {
    const slices = [{ file: 'file.ts', start: 2, end: 8, body: '' }];
    // 完整落在切片内 → 有效。
    expect(verifyJudgeCitations({ citedLines: ['file.ts:3-6'] }, slices)).toBe(true);
    expect(verifyJudgeCitations({ citedLines: ['file.ts:2-8'] }, slices)).toBe(true);
    // 跨出切片边界(哪怕部分越界)→ 无效。
    expect(verifyJudgeCitations({ citedLines: ['file.ts:6-12'] }, slices)).toBe(false);
    // 倒置区间/畸形 → 无效。
    expect(verifyJudgeCitations({ citedLines: ['file.ts:6-3'] }, slices)).toBe(false);
    expect(verifyJudgeCitations({ citedLines: ['file.ts:3-'] }, slices)).toBe(false);
    // 混合列表:一条无效即整体无效(every 语义)。
    expect(verifyJudgeCitations({ citedLines: ['file.ts:3-6', 'file.ts:9-12'] }, slices)).toBe(
      false
    );
  });

  it('scoreFixture：invalidCitation 裁决不计入 judgePrecision 分母(与校准同口径)', () => {
    const fixture = { id: 'fx2', expected: [], notExpected: [] };
    // 3 条:有效 uphold + 无效 uphold(void) + 有效 reject → precision = 1/2。
    const score = scoreFixture({
      fixture,
      candidates: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
      judgeVerdicts: [
        { verdict: 'uphold' },
        { verdict: 'uphold', invalidCitation: true },
        { verdict: 'reject' },
      ],
    });
    expect(score.judgePrecision).toBe(0.5);
    // 全部无效 → 无有效裁决,precision=null(而非误导性百分比——门0 真跑 5/5 void 曾算出 40%)。
    const allVoid = scoreFixture({
      fixture,
      candidates: [{ title: 'a' }],
      judgeVerdicts: [{ verdict: 'uphold', invalidCitation: true }],
    });
    expect(allVoid.judgePrecision).toBeNull();
  });

  it('computeJudgeCalibration：一致率/过度泛化子集自偏签名/晋级判定', () => {
    const uphold = { verdict: 'uphold' };
    const reject = { verdict: 'reject' };
    // 32 个有效样本：29 一致(20 uphold/uphold + 8 reject/reject + 1 overgen reject/reject)
    // + 3 不一致(2 narrow-被放行 + 1 uphold/reject) → 90.6%；过度泛化子集 3 中 judge 放行 2 → 自偏签名。
    const records = [
      ...Array.from({ length: 20 }, () => ({ humanDecision: 'uphold', judgeVerdict: uphold })),
      ...Array.from({ length: 8 }, () => ({ humanDecision: 'reject', judgeVerdict: reject })),
      { humanDecision: 'narrow', overgeneralized: true, judgeVerdict: uphold },
      { humanDecision: 'narrow', overgeneralized: true, judgeVerdict: uphold },
      { humanDecision: 'reject', overgeneralized: true, judgeVerdict: reject },
      { humanDecision: 'uphold', judgeVerdict: reject },
      // 无效裁决不计入分母
      { humanDecision: 'uphold', judgeVerdict: { verdict: 'uphold', invalidCitation: true } },
      { humanDecision: 'uphold', judgeVerdict: null },
    ];
    const calibration = computeJudgeCalibration(records);
    expect(calibration.judged).toBe(32);
    expect(calibration.agreementRate).toBeCloseTo(29 / 32, 5);
    expect(calibration.overgenSubset).toMatchObject({ total: 3, agreed: 1 });
    expect(calibration.selfBiasSignal).toBe(true);
    // 一致率 87.5%≥80% 且样本≥30，但自偏签名命中 → 不得晋级
    expect(calibration.promotionEligible).toBe(false);

    // 修正自偏(过度泛化子集全拒)→ 晋级(平衡口径同时达标:kappa≈0.93,负类召回 11/11)
    const fixed = records.map((record) =>
      record.overgeneralized ? { ...record, judgeVerdict: reject } : record
    );
    const calibration2 = computeJudgeCalibration(fixed);
    expect(calibration2.selfBiasSignal).toBe(false);
    expect(calibration2.kappa).toBeGreaterThan(0.9);
    expect(calibration2.negativeSubset).toMatchObject({ total: 11, caught: 11, recall: 1 });
    expect(calibration2.promotionEligible).toBe(true);
  });

  it('computeJudgeCalibration：类不均衡下"全判通过"的 judge 被平衡口径拦截(agreeableness 陷阱)', () => {
    const uphold = { verdict: 'uphold' };
    // 28 人工 uphold + 4 人工 reject,judge 全部放行:
    // 裸一致率 28/32=87.5% ≥80% 且样本 ≥30——旧门会放行;
    // 新门:kappa=0(不高于机会一致)、负类召回 0/4、负例 4<minNegatives → 三重拦截。
    const records = [
      ...Array.from({ length: 28 }, () => ({ humanDecision: 'uphold', judgeVerdict: uphold })),
      ...Array.from({ length: 4 }, () => ({ humanDecision: 'reject', judgeVerdict: uphold })),
    ];
    const calibration = computeJudgeCalibration(records);
    expect(calibration.agreementRate).toBeCloseTo(28 / 32, 5);
    expect(calibration.kappa).toBeCloseTo(0, 5);
    expect(calibration.negativeSubset).toMatchObject({ total: 4, caught: 0, recall: 0 });
    expect(calibration.promotionEligible).toBe(false);
  });

  it('computeJudgeCalibration：全正语料(双方全 uphold)是退化态——kappa=null,不具校准资格', () => {
    const uphold = { verdict: 'uphold' };
    const records = Array.from({ length: 30 }, () => ({
      humanDecision: 'uphold',
      judgeVerdict: uphold,
    }));
    const calibration = computeJudgeCalibration(records);
    expect(calibration.agreementRate).toBe(1);
    expect(calibration.kappa).toBeNull();
    expect(calibration.negativeSubset.total).toBe(0);
    // 语料测不出判别力 → 不是 judge 合格,是语料不合格。
    expect(calibration.promotionEligible).toBe(false);
  });

  it('judgeCandidate：注入 chat；越界引用 → invalidCitation 标记(裁决按无效处理)', async () => {
    const root = makeProject();
    const good = await judgeCandidate({
      candidate,
      projectRoot: root,
      chat: async () =>
        '{"entailment":"entailed","trivial":false,"actionable":true,"scopeCorrect":true,"verdict":"uphold","citedLines":["file.ts:3"],"reason":"supported"}',
    });
    expect(good).toMatchObject({ verdict: 'uphold' });
    expect(good.invalidCitation).toBeUndefined();

    const bad = await judgeCandidate({
      candidate,
      projectRoot: root,
      chat: async () =>
        '{"entailment":"entailed","trivial":false,"actionable":true,"scopeCorrect":true,"verdict":"uphold","citedLines":["file.ts:99"],"reason":"fabricated line"}',
    });
    expect(bad).toMatchObject({ verdict: 'uphold', invalidCitation: true });
  });
});
