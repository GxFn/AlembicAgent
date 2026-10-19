/**
 * P0-2/P0-3(挖掘质量升级)：eval harness 确定性核心 + Judge 机械面的单测。
 * LLM 调用不在此测(judge.chat 注入 fake)；真实 Tier-B 由 `npm run eval:mining` 手动跑。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — .mjs 脚本库无类型声明；单测直测其运行时行为。
import {
  candidateCitedFiles,
  collectRunObservations,
  matchesExpected,
  matchesNotExpected,
  renderReportMarkdown,
  scoreFixture,
} from '../scripts/lib/mining-eval-core.mjs';
import {
  collectSourceFileReceipts,
  createEvaluationRecipeGateway,
  formatJudgeDiagnostic,
} from '../scripts/lib/mining-eval-runtime.mjs';
import {
  assertFrozenJudgeModelLoadReceiptV1,
  buildJudgePrompt,
  computeJudgeCalibration,
  createFrozenJudgeModelLoadReceiptV1,
  judgeCandidate,
  parseJudgeVerdict,
  sliceEvidenceForJudge,
  verifyJudgeCitations,
} from '../src/agent/evaluation/MiningJudge.js';
import {
  assertStrictFixtureGoldenProviderV1,
  createStrictProductionSourceFixtureRuntimeV1,
  FrozenStrictProductionEvaluationProviderV1,
} from '../src/agent/evaluation/StrictProductionFixtureEvaluation.js';

const tempRoots: string[] = [];

it.each([
  {},
  7,
  'bad',
  null,
])('retains calibration reports with malformed sources: %j', (sources) => {
  expect(
    collectSourceFileReceipts([{ candidate: { reasoning: { sources } } }], '/unused/input.json')
  ).toEqual([]);
});

it('records missing calibration evidence instead of losing the complete report', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-missing-source-'));
  tempRoots.push(root);
  const rows = collectSourceFileReceipts(
    [{ candidate: { reasoning: { sources: ['missing.ts:1-2'] } } }],
    join(root, 'samples.json')
  );
  expect(rows).toEqual([
    { projectRoot: '.', relativePath: 'missing.ts', sha256: null, error: 'ENOENT' },
  ]);
});

it('provides the current createOrStage/readiness port for isolated mining evaluation', async () => {
  const created: Record<string, unknown>[] = [];
  const gateway = createEvaluationRecipeGateway(created, 'fixture');
  const result = await gateway.createOrStage({ items: [{ title: 'candidate' }] });
  expect(created).toEqual([{ title: 'candidate' }]);
  expect(result.created[0]).toMatchObject({ id: expect.any(String), lifecycle: 'pending' });
  expect(await gateway.evaluateReadiness(result.created[0].id)).toMatchObject({ ready: false });
});
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

  it.each(['parent', 'absolute', 'symlink'])('rejects %s evidence outside the project', (kind) => {
    const outer = makeProject();
    const root = join(outer, 'project');
    mkdirSync(root);
    symlinkSync(join(outer, 'file.ts'), join(root, 'linked.ts'));
    const file =
      kind === 'parent' ? '../file.ts' : kind === 'absolute' ? join(outer, 'file.ts') : 'linked.ts';
    expect(sliceEvidenceForJudge({ reasoning: { sources: [`${file}:1-2`] } }, root)).toEqual([]);
  });

  it.each(['file.ts:0-2', 'file.ts:4-2'])('rejects invalid evidence range %s', (source) => {
    expect(sliceEvidenceForJudge({ reasoning: { sources: [source] } }, makeProject())).toEqual([]);
  });

  it('does not count an incomplete judge response as a valid uphold verdict', async () => {
    const root = makeProject();
    const verdict = await judgeCandidate({
      candidate: { reasoning: { sources: ['file.ts:2-4'] } },
      projectRoot: root,
      chat: async () => JSON.stringify({ verdict: 'uphold', citedLines: ['file.ts:2'] }),
    });
    expect(verdict).toBeNull();
  });

  it('does not uphold a verdict contradicted by its own required axes', async () => {
    const root = makeProject();
    const verdict = await judgeCandidate({
      candidate: { reasoning: { sources: ['file.ts:2-4'] } },
      projectRoot: root,
      chat: async () =>
        JSON.stringify({
          entailment: 'not_entailed',
          trivial: true,
          actionable: false,
          scopeCorrect: false,
          verdict: 'uphold',
          citedLines: ['file.ts:2'],
          reason: 'not supported',
        }),
    });
    expect(verdict?.verdict).not.toBe('uphold');
  });

  it('rejects nonpositive generation budgets before minting a model receipt', () => {
    expect(() =>
      createFrozenJudgeModelLoadReceiptV1({
        selectionMode: 'fixture',
        requestedProvider: 'fixture',
        requestedModel: 'fixture-model',
        resolvedProvider: 'fixture',
        resolvedModel: 'fixture-model',
        temperature: 0,
        maxTokens: 0,
        implementationModuleSha256: 'a'.repeat(64),
      })
    ).toThrow();
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

  it('computeJudgeCalibration：无效裁决集中在人工负例时覆盖率门拦截晋级(L7-P25 / C16)', () => {
    const uphold = { verdict: 'uphold' };
    const reject = { verdict: 'reject' };
    // 核实探针原样：25 uphold/uphold + 5 reject/reject 有效；30 条人工 reject 但 judge 解析失败(null)，
    // 10 条人工 reject 而 judge 错放 uphold 却因引用越界被剔除。有效子集各比例满分，
    // 但 40 个负例里 judge 一个有效裁决都没给出——不能据此晋级。
    const records = [
      ...Array.from({ length: 25 }, () => ({ humanDecision: 'uphold', judgeVerdict: uphold })),
      ...Array.from({ length: 5 }, () => ({ humanDecision: 'reject', judgeVerdict: reject })),
      ...Array.from({ length: 30 }, () => ({ humanDecision: 'reject', judgeVerdict: null })),
      ...Array.from({ length: 10 }, () => ({
        humanDecision: 'reject',
        judgeVerdict: { verdict: 'uphold', invalidCitation: true },
      })),
    ];
    const calibration = computeJudgeCalibration(records);
    // 无效裁决仍不进入一致率分母(既有口径保持)。
    expect(calibration).toMatchObject({ total: 70, judged: 30, agreementRate: 1 });
    expect(calibration.negativeSubset).toMatchObject({ total: 5, caught: 5, recall: 1 });
    expect(calibration.promotionEligible).toBe(false);
  });

  it('computeJudgeCalibration：整体覆盖率达标但负例有效覆盖率 <90% 仍不得晋级', () => {
    const uphold = { verdict: 'uphold' };
    const reject = { verdict: 'reject' };
    // 整体覆盖 300/312≈96% 过门；人工负例 42 条只有 30 条有效(≈71%)——无效集中在负例。
    const records = [
      ...Array.from({ length: 270 }, () => ({ humanDecision: 'uphold', judgeVerdict: uphold })),
      ...Array.from({ length: 30 }, () => ({ humanDecision: 'reject', judgeVerdict: reject })),
      ...Array.from({ length: 12 }, () => ({ humanDecision: 'narrow', judgeVerdict: null })),
    ];
    const calibration = computeJudgeCalibration(records);
    expect(calibration).toMatchObject({ total: 312, judged: 300, agreementRate: 1, kappa: 1 });
    expect(calibration.promotionEligible).toBe(false);
  });

  it('computeJudgeCalibration：覆盖率与负例覆盖率恰为 90% 可晋级，低于 90% 不可晋级', () => {
    const uphold = { verdict: 'uphold' };
    const reject = { verdict: 'reject' };
    // 40 条：36 有效(覆盖 90%)；人工负例 10 条中 9 条有效(负例覆盖 90%)。
    const atFloor = [
      ...Array.from({ length: 27 }, () => ({ humanDecision: 'uphold', judgeVerdict: uphold })),
      ...Array.from({ length: 3 }, () => ({ humanDecision: 'uphold', judgeVerdict: null })),
      ...Array.from({ length: 9 }, () => ({ humanDecision: 'reject', judgeVerdict: reject })),
      { humanDecision: 'trivial', judgeVerdict: { verdict: 'reject', invalidCitation: true } },
    ];
    expect(computeJudgeCalibration(atFloor)).toMatchObject({
      total: 40,
      judged: 36,
      promotionEligible: true,
    });
    // 再多 1 条正例无效 → 覆盖 36/41≈87.8% <90%。
    expect(
      computeJudgeCalibration([...atFloor, { humanDecision: 'uphold', judgeVerdict: null }])
        .promotionEligible
    ).toBe(false);
    // 再多 1 条负例无效 → 整体 36/41 与负例 9/11 同时跌破门限。
    expect(
      computeJudgeCalibration([...atFloor, { humanDecision: 'reject', judgeVerdict: null }])
        .promotionEligible
    ).toBe(false);
  });

  it('computeJudgeCalibration：拼错或缺失的 humanDecision 立即抛错并附索引，而不是静默计为负例', () => {
    const uphold = { verdict: 'uphold' };
    // 四个合法标签都应被接受(不抛错)。
    expect(() =>
      computeJudgeCalibration(
        ['uphold', 'narrow', 'trivial', 'reject'].map((humanDecision) => ({
          humanDecision,
          judgeVerdict: uphold,
        })) as Parameters<typeof computeJudgeCalibration>[0]
      )
    ).not.toThrow();
    const dirty = [
      { humanDecision: 'uphold', judgeVerdict: uphold },
      { humanDecision: 'reject', judgeVerdict: uphold },
      { humanDecision: 'upheld', judgeVerdict: uphold },
      { humanDecision: 'uphold', judgeVerdict: null },
      { humanDecision: 'Reject', judgeVerdict: uphold },
      { humanDecision: '', judgeVerdict: uphold },
      { judgeVerdict: uphold },
    ] as unknown as Parameters<typeof computeJudgeCalibration>[0];
    let thrown: unknown;
    try {
      computeJudgeCalibration(dirty);
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toMatch(/^JUDGE_CALIBRATION_HUMAN_DECISION_INVALID:/);
    // 一次列出全部非法记录的索引与原值，便于一次修完导出数据。
    expect(message).toContain('count=4');
    expect(message).toContain('records[2]="upheld"');
    expect(message).toContain('records[4]="Reject"');
    expect(message).toContain('records[5]=""');
    expect(message).toContain('records[6]=undefined');
    expect(message).not.toContain('records[0]');
    expect(message).not.toContain('records[1]');
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

  it('freezes and verifies an explicit judge model load receipt', () => {
    const input = {
      selectionMode: 'explicit' as const,
      requestedProvider: 'frozen-provider',
      requestedModel: 'frozen-judge-v1',
      resolvedProvider: 'frozen-provider',
      resolvedModel: 'frozen-judge-v1',
      temperature: 0,
      maxTokens: 800,
      implementationModuleSha256: 'a'.repeat(64),
    };
    const receipt = createFrozenJudgeModelLoadReceiptV1(input);
    expect(receipt.receiptHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(createFrozenJudgeModelLoadReceiptV1(input)).toEqual(receipt);
    expect(() =>
      assertFrozenJudgeModelLoadReceiptV1(receipt, {
        resolvedProvider: 'frozen-provider',
        resolvedModel: 'drifted-model',
      })
    ).toThrow(/JUDGE_MODEL_SELECTION_DRIFT/u);
    expect(() =>
      createFrozenJudgeModelLoadReceiptV1({
        ...input,
        requestedModel: 'requested-model',
      })
    ).toThrow(/JUDGE_MODEL_EXPLICIT_RESOLUTION_MISMATCH/u);
  });

  it('routes both evaluator scripts through the built production judge module', () => {
    for (const relativePath of ['scripts/eval-mining.mjs', 'scripts/eval-judge-calibration.mjs']) {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
      expect(source).toContain('dist/agent/evaluation/MiningJudge.js');
      expect(source).not.toContain("from './lib/mining-judge.mjs'");
    }
    expect(
      readFileSync(join(process.cwd(), 'scripts/eval-judge-calibration.mjs'), 'utf8')
    ).toContain("args['judge-model']");
  });

  it('hash-verifies executable source fixtures before the frozen strict runtime can emit', async () => {
    const fixtureRoot = join(
      process.cwd(),
      'test/fixtures/strict-production/projects/alembic-workspace-single-file'
    );
    const fixture = {
      id: 'single-file-value',
      project: 'AlembicWorkspace',
      expectedDisposition: 'single-file-value' as const,
      sourceFiles: [
        {
          path: 'src/agent/production/StrictProductionStages.ts',
          originRelativePath: 'AlembicAgent/src/agent/production/StrictProductionStages.ts',
          sha256: '49c91bb161198c850d45a166680a83d92b6280962ab20cbe43c0e6ad1e2fcfd1',
        },
      ],
    };
    const provider = new FrozenStrictProductionEvaluationProviderV1();
    const evaluation = createStrictProductionSourceFixtureRuntimeV1({
      fixture,
      projectRoot: fixtureRoot,
      provider,
    });
    const analyst = await provider.chatWithTools(
      `strict cold-start Analyst\n${readFileSync(join(fixtureRoot, fixture.sourceFiles[0].path), 'utf8')}`
    );
    evaluation.runtimePort.validateAnalystResult(
      { reply: analyst.text },
      evaluation.runtimePort.readAnalysisEpoch()
    );
    const producer = await provider.chatWithTools(
      'strict cold-start Producer\n{"disposition":"single-file-value"}'
    );
    evaluation.runtimePort.reviewProducerResult({ reply: producer.text });
    expect(evaluation.capturedCandidates).toHaveLength(1);
    expect(evaluation.loadedSources[0]?.sha256).toBe(fixture.sourceFiles[0]?.sha256);
    expect(provider.networkRequestCount).toBe(0);
    expect(provider.apiKeyReadCount).toBe(0);

    expect(() =>
      createStrictProductionSourceFixtureRuntimeV1({
        fixture: {
          ...fixture,
          sourceFiles: [{ ...fixture.sourceFiles[0], sha256: '0'.repeat(64) }],
        },
        projectRoot: fixtureRoot,
        provider,
      })
    ).toThrow(/STRICT_FIXTURE_SOURCE_HASH_MISMATCH/u);
  });
});

/* ── L7-P24：离线 judge 单行来源与诊断（C17 / C44） ─────────────────────────────────────────
 * C17：生产门禁（Core SOURCE_REF_RE、recipeProductionAdapter、verifyJudgeCitations）都接受 file:N，
 * judge 切片与校准收据也必须接受，否则单行来源被静默丢弃、judge 被迫按“无证据”判 reject；
 * 先过滤后截断，无效来源不能占用 maxSlices 名额。
 * C44：被跳过的来源、无可读切片、裁决解析失败都要带原因码上报，脚本逐条打印。 */
describe('mining-judge — 单行来源与跳过/解析诊断(L7-P24)', () => {
  function makeProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'judge-p24-'));
    tempRoots.push(root);
    writeFileSync(join(root, 'file.ts'), 'l1\nl2\nl3\nl4\nl5\n');
    return root;
  }

  const UPHOLD_CITING_LINE_3 = JSON.stringify({
    entailment: 'entailed',
    trivial: false,
    actionable: true,
    scopeCorrect: true,
    verdict: 'uphold',
    citedLines: ['file.ts:3'],
    reason: 'supported',
  });

  it('slices a single-line file:N source as start=end', () => {
    const root = makeProject();
    expect(sliceEvidenceForJudge({ reasoning: { sources: ['file.ts:3'] } }, root)).toEqual([
      { file: 'file.ts', start: 3, end: 3, body: '3|l3' },
    ]);
  });

  it('keeps a judge verdict citing a single-line source valid', async () => {
    const verdict = await judgeCandidate({
      candidate: { reasoning: { sources: ['file.ts:3'] } },
      projectRoot: makeProject(),
      chat: async () => UPHOLD_CITING_LINE_3,
    });
    expect(verdict).toMatchObject({ verdict: 'uphold' });
    expect(verdict?.invalidCitation).toBeUndefined();
  });

  it('filters unusable sources before applying the slice budget', () => {
    const root = makeProject();
    const skipped: [unknown, string][] = [];
    const slices = sliceEvidenceForJudge(
      { reasoning: { sources: ['nope', 7, 'missing.ts:1-2', 'file.ts:2-3', 'file.ts:4'] } },
      root,
      { maxSlices: 1, onSkip: (source: unknown, reason: string) => skipped.push([source, reason]) }
    );
    expect(slices.map((slice) => `${slice.file}:${slice.start}-${slice.end}`)).toEqual([
      'file.ts:2-3',
    ]);
    expect(skipped).toEqual([
      ['nope', 'FORMAT'],
      [7, 'FORMAT'],
      ['missing.ts:1-2', 'READ_FAILED'],
      ['file.ts:4', 'LIMIT'],
    ]);
  });

  it('reports every source as LIMIT when the slice budget itself is invalid', () => {
    const skipped: [unknown, string, string][] = [];
    const slices = sliceEvidenceForJudge(
      { reasoning: { sources: ['file.ts:1-2', 'file.ts:3'] } },
      makeProject(),
      {
        maxSlices: 0,
        onSkip: (source: unknown, reason: string, detail: string) =>
          skipped.push([source, reason, detail]),
      }
    );
    expect(slices).toEqual([]);
    expect(skipped).toEqual([
      ['file.ts:1-2', 'LIMIT', expect.stringContaining('invalid slice budget')],
      ['file.ts:3', 'LIMIT', expect.stringContaining('invalid slice budget')],
    ]);
  });

  it.each([
    ['file.ts:0-2', 'FORMAT'],
    ['file.ts:4-2', 'FORMAT'],
    ['file.ts', 'FORMAT'],
    ['file.ts:99', 'OUT_OF_RANGE'],
    ['missing.ts:1', 'READ_FAILED'],
    ['../file.ts:1-2', 'READ_DENIED'],
    ['linked.ts:1-2', 'READ_DENIED'],
    ['absolute', 'ABSOLUTE'],
  ])('reports skipped source %s with reason %s', (rawSource, reason) => {
    const outer = makeProject();
    const root = join(outer, 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'file.ts'), 'l1\nl2\nl3\nl4\nl5\n');
    symlinkSync(join(outer, 'file.ts'), join(root, 'linked.ts'));
    const source = rawSource === 'absolute' ? `${join(root, 'file.ts')}:1-2` : rawSource;
    const skipped: { source: unknown; reason: string; detail: string }[] = [];
    const slices = sliceEvidenceForJudge({ reasoning: { sources: [source] } }, root, {
      onSkip: (skippedSource: unknown, skipReason: string, detail: string) =>
        skipped.push({ source: skippedSource, reason: skipReason, detail }),
    });
    expect(slices).toEqual([]);
    expect(skipped).toEqual([{ source, reason, detail: expect.any(String) }]);
    // 诊断细节只给错误码/边界原因，不回显本机绝对路径。
    expect(skipped[0]?.detail).not.toContain(outer);
  });

  it('reports parse failures with JSON_PARSE / FIELD_MISSING / VERDICT_AXIS_CONFLICT', () => {
    const failures: [string, string][] = [];
    const onFailure = (reason: string, detail: string) => failures.push([reason, detail]);
    expect(parseJudgeVerdict('not json', { onFailure })).toBeNull();
    expect(parseJudgeVerdict('{"verdict": "uphold", truncated', { onFailure })).toBeNull();
    expect(parseJudgeVerdict('{"verdict": uphold}', { onFailure })).toBeNull();
    expect(parseJudgeVerdict(42, { onFailure })).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"maybe"}', { onFailure })).toBeNull();
    expect(
      parseJudgeVerdict(
        JSON.stringify({
          entailment: 'not_entailed',
          trivial: true,
          actionable: false,
          scopeCorrect: false,
          verdict: 'uphold',
          citedLines: ['file.ts:2'],
          reason: 'contradiction',
        }),
        { onFailure }
      )
    ).toBeNull();
    expect(failures.map(([reason]) => reason)).toEqual([
      'JSON_PARSE',
      'JSON_PARSE',
      'JSON_PARSE',
      'JSON_PARSE',
      'FIELD_MISSING',
      'VERDICT_AXIS_CONFLICT',
    ]);
    // FIELD_MISSING 点名缺失/非法字段，便于区分截断与模型漏字段。
    expect(failures[4]?.[1]).toContain('verdict');
    expect(failures[4]?.[1]).toContain('citedLines');
    expect(failures[5]?.[1]).toContain('entailment=not_entailed');
    // 合法裁决不触发失败回调。
    const before = failures.length;
    expect(parseJudgeVerdict(UPHOLD_CITING_LINE_3, { onFailure })).toMatchObject({
      verdict: 'uphold',
    });
    expect(failures).toHaveLength(before);
  });

  it('judgeCandidate surfaces skipped sources, no-readable-slices and parse failures', async () => {
    const diagnostics: Record<string, unknown>[] = [];
    const verdict = await judgeCandidate({
      candidate: { reasoning: { sources: ['missing.ts:1-2', 'file.ts:99'] } },
      projectRoot: makeProject(),
      chat: async () => '{"verdict":"reject"}',
      onDiagnostic: (diagnostic: Record<string, unknown>) => diagnostics.push(diagnostic),
    });
    expect(verdict).toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'slice-skipped',
        source: 'missing.ts:1-2',
        reasonCode: 'READ_FAILED',
      }),
      expect.objectContaining({
        kind: 'slice-skipped',
        source: 'file.ts:99',
        reasonCode: 'OUT_OF_RANGE',
      }),
      { kind: 'no-readable-slices', sourceCount: 2 },
      expect.objectContaining({ kind: 'verdict-parse-failed', reasonCode: 'FIELD_MISSING' }),
    ]);
  });

  it('judgeCandidate stays silent when every source slices and the verdict parses', async () => {
    const diagnostics: unknown[] = [];
    const verdict = await judgeCandidate({
      candidate: { reasoning: { sources: ['file.ts:2-4'] } },
      projectRoot: makeProject(),
      chat: async () => UPHOLD_CITING_LINE_3,
      onDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
    });
    expect(verdict).toMatchObject({ verdict: 'uphold' });
    expect(diagnostics).toEqual([]);
  });

  it('collects calibration receipts for single-line sources', () => {
    const root = makeProject();
    const rows = collectSourceFileReceipts(
      [{ candidate: { reasoning: { sources: ['file.ts:3'] } } }],
      join(root, 'samples.json')
    );
    expect(rows).toEqual([
      {
        projectRoot: '.',
        relativePath: 'file.ts',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
  });

  it('renders judge diagnostics as one log line per event for both evaluator scripts', () => {
    expect(
      formatJudgeDiagnostic({
        kind: 'slice-skipped',
        source: 'src/a.ts:3',
        reasonCode: 'OUT_OF_RANGE',
        detail: 'start 3 > 2 lines',
      })
    ).toBe('slice-skipped reason=OUT_OF_RANGE source="src/a.ts:3" detail="start 3 > 2 lines"');
    expect(formatJudgeDiagnostic({ kind: 'no-readable-slices', sourceCount: 2 })).toContain(
      'no-readable-slices declaredSources=2'
    );
    expect(
      formatJudgeDiagnostic({
        kind: 'verdict-parse-failed',
        reasonCode: 'JSON_PARSE',
        detail: 'no JSON object in response',
      })
    ).toBe('verdict-parse-failed reason=JSON_PARSE detail="no JSON object in response"');
    expect(formatJudgeDiagnostic({ kind: 'other' })).toContain('unknown-diagnostic');
    for (const relativePath of ['scripts/eval-mining.mjs', 'scripts/eval-judge-calibration.mjs']) {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
      expect(source).toContain('onDiagnostic');
      expect(source).toContain('formatJudgeDiagnostic(diagnostic)');
    }
  });
});

/* ── L7-P26：冻结 fixture runtime 只接受冻结 provider（C18） ────────────────────────────────
 * 冻结 runtime port 的候选由源码标记预先决定，与模型无关；真实 provider 跑进来时 Analyst 回复不是
 * FrozenStrictStageReplyV1，旧实现以未编码的 SyntaxError 拒绝，负例 fixture 却按 candidateCount=0
 * 记为 passed 并带上真实 provider 身份。这里锁住三道闸：runtime 入口拒绝非冻结 provider；
 * 冻结回复解析失败转成带阶段码的 REPLY_INVALID；eval-mining 在解析真实 provider 之前预检 golden。 */
describe('strict fixture runtime — 冻结 provider 闸(L7-P26)', () => {
  const singleFileRoot = join(
    process.cwd(),
    'test/fixtures/strict-production/projects/alembic-workspace-single-file'
  );
  const singleFileFixture = {
    id: 'single-file-value',
    project: 'AlembicWorkspace',
    expectedDisposition: 'single-file-value' as const,
    sourceFiles: [
      {
        path: 'src/agent/production/StrictProductionStages.ts',
        originRelativePath: 'AlembicAgent/src/agent/production/StrictProductionStages.ts',
        sha256: '49c91bb161198c850d45a166680a83d92b6280962ab20cbe43c0e6ad1e2fcfd1',
      },
    ],
  };

  function frozenRuntime() {
    return createStrictProductionSourceFixtureRuntimeV1({
      fixture: singleFileFixture,
      projectRoot: singleFileRoot,
      provider: new FrozenStrictProductionEvaluationProviderV1(),
    });
  }

  function captureError(run: () => unknown): Error {
    try {
      run();
    } catch (err: unknown) {
      if (err instanceof Error) {
        return err;
      }
      throw new Error(`expected an Error instance, got ${typeof err}`);
    }
    throw new Error('expected the call to throw');
  }

  it('rejects a non-frozen provider at the runtime entry before reading fixture bytes', () => {
    const realProvider = {
      name: 'deepseek',
      model: 'deepseek-chat',
      chatWithTools: async () => ({ text: 'Here is my analysis', functionCalls: [] }),
    } as unknown as FrozenStrictProductionEvaluationProviderV1;
    // projectRoot 不存在：若入口没有先拒绝 provider，这里会先报 ENOENT 而不是 provider 码。
    const error = captureError(() =>
      createStrictProductionSourceFixtureRuntimeV1({
        fixture: singleFileFixture,
        projectRoot: join(tmpdir(), 'strict-fixture-provider-gate-missing-root'),
        provider: realProvider,
      })
    );
    expect(error.message).toMatch(/^STRICT_FIXTURE_PROVIDER_NOT_FROZEN:/u);
    expect(error.message).toContain('provider=deepseek');
    expect(error.message).toContain('model=deepseek-chat');
  });

  it('rejects a duck-typed provider that only impersonates the frozen identity', () => {
    const impersonator = {
      name: 'frozen-fixture',
      model: 'strict-production-fixture-v1',
      networkRequestCount: 0,
      apiKeyReadCount: 0,
      chatWithTools: async () => ({ text: '{}', functionCalls: [] }),
    } as unknown as FrozenStrictProductionEvaluationProviderV1;
    expect(() =>
      createStrictProductionSourceFixtureRuntimeV1({
        fixture: singleFileFixture,
        projectRoot: singleFileRoot,
        provider: impersonator,
      })
    ).toThrow(/^STRICT_FIXTURE_PROVIDER_NOT_FROZEN:/u);
    expect(() =>
      createStrictProductionSourceFixtureRuntimeV1({
        fixture: singleFileFixture,
        projectRoot: singleFileRoot,
        provider: null as unknown as FrozenStrictProductionEvaluationProviderV1,
      })
    ).toThrow(/^STRICT_FIXTURE_PROVIDER_NOT_FROZEN:.*provider=<missing>/u);
  });

  it('codes a non-JSON analyst reply as STRICT_FIXTURE_ANALYST_REPLY_INVALID instead of a raw SyntaxError', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const evaluation = frozenRuntime();
      const error = captureError(() =>
        evaluation.runtimePort.validateAnalystResult(
          { reply: 'Here is my analysis of the strict stage factory.' },
          evaluation.runtimePort.readAnalysisEpoch()
        )
      );
      expect(error).not.toBeInstanceOf(SyntaxError);
      expect(error.message).toMatch(/^STRICT_FIXTURE_ANALYST_REPLY_INVALID:not-json/u);
      expect(error.cause).toBeInstanceOf(SyntaxError);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some(
          (line) =>
            line.includes('[StrictFixtureEvaluation]') &&
            line.includes('phase=analyst') &&
            line.includes('reason=not-json') &&
            line.includes('code=STRICT_FIXTURE_ANALYST_REPLY_INVALID')
        )
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    'null',
    '[1]',
    '"text"',
    '42',
  ])('codes a JSON non-object analyst reply %s as REPLY_INVALID', (reply) => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const evaluation = frozenRuntime();
      expect(() =>
        evaluation.runtimePort.validateAnalystResult(
          { reply },
          evaluation.runtimePort.readAnalysisEpoch()
        )
      ).toThrow(/^STRICT_FIXTURE_ANALYST_REPLY_INVALID:not-object/u);
    } finally {
      warn.mockRestore();
    }
  });

  it('codes a non-JSON producer reply as STRICT_FIXTURE_PRODUCER_REPLY_INVALID and captures no candidate', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const provider = new FrozenStrictProductionEvaluationProviderV1();
      const evaluation = createStrictProductionSourceFixtureRuntimeV1({
        fixture: singleFileFixture,
        projectRoot: singleFileRoot,
        provider,
      });
      const analyst = await provider.chatWithTools(
        `strict cold-start Analyst\n${readFileSync(join(singleFileRoot, singleFileFixture.sourceFiles[0].path), 'utf8')}`
      );
      evaluation.runtimePort.validateAnalystResult(
        { reply: analyst.text },
        evaluation.runtimePort.readAnalysisEpoch()
      );
      const error = captureError(() =>
        evaluation.runtimePort.reviewProducerResult({ reply: 'I produced one rule.' })
      );
      expect(error.message).toMatch(/^STRICT_FIXTURE_PRODUCER_REPLY_INVALID:not-json/u);
      expect(evaluation.capturedCandidates).toHaveLength(0);
      // 形状正确但阶段不符仍走原有 REPLY_INVALID，并带出原因码。
      expect(() => evaluation.runtimePort.reviewProducerResult({ reply: analyst.text })).toThrow(
        /^STRICT_FIXTURE_PRODUCER_REPLY_INVALID:shape-mismatch/u
      );
      expect(evaluation.capturedCandidates).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('requires the frozen provider for every golden that carries expectedDisposition cases', () => {
    const strictGolden = JSON.parse(
      readFileSync(join(process.cwd(), 'test/fixtures/strict-production/golden.json'), 'utf8')
    ) as { cases: unknown[] };
    for (const requestedProvider of [undefined, true, 'deepseek', 'ollama']) {
      const error = captureError(() =>
        assertStrictFixtureGoldenProviderV1({ cases: strictGolden.cases, requestedProvider })
      );
      expect(error.message).toMatch(/^STRICT_FIXTURE_PROVIDER_NOT_FROZEN:/u);
      expect(error.message).toContain('alembic-workspace-single-file-value');
      expect(error.message).toContain('bilidili-three-file-generic');
    }
    expect(() =>
      assertStrictFixtureGoldenProviderV1({
        cases: strictGolden.cases,
        requestedProvider: 'frozen-fixture',
      })
    ).not.toThrow();

    // 普通挖掘 golden 不含 expectedDisposition：真实 provider 仍可评估。
    const miningGolden = JSON.parse(
      readFileSync(join(process.cwd(), 'test/fixtures/mining-eval/golden.json'), 'utf8')
    ) as { fixtures?: unknown[]; cases?: unknown[] };
    expect(() =>
      assertStrictFixtureGoldenProviderV1({
        cases: miningGolden.fixtures ?? miningGolden.cases ?? [],
        requestedProvider: 'deepseek',
      })
    ).not.toThrow();
    expect(() =>
      assertStrictFixtureGoldenProviderV1({ cases: [], requestedProvider: undefined })
    ).not.toThrow();
  });

  it('eval-mining preflights strict golden cases before resolving any real provider or running a fixture', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/eval-mining.mjs'), 'utf8');
    const preflight = source.indexOf('assertStrictFixtureGoldenProviderV1({');
    expect(preflight).toBeGreaterThan(-1);
    expect(source.indexOf('autoDetectProvider()')).toBeGreaterThan(preflight);
    expect(source.indexOf('createProvider({')).toBeGreaterThan(preflight);
    expect(source.indexOf('for (const fixture of goldenCases)')).toBeGreaterThan(preflight);
    const preflightBlock = source.slice(preflight, source.indexOf('autoDetectProvider()'));
    expect(preflightBlock).toContain('process.exit(1)');
    expect(preflightBlock).toContain('--provider frozen-fixture');
  });
});
