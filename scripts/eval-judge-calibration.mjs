#!/usr/bin/env node
/**
 * eval:judge-calibration — Judge 校准(P0-3 晋级门 + 自偏检测)。
 *
 * 口径(需求 §P0-3 / D2+,G-B 修订)：ground truth 复用进化环既有人工标记——staging 复核结论
 * (uphold/narrow/reject/trivial)与 evolution 决策；judge 对同一批候选独立裁决。
 * 晋级门 = 二元保留一致率 ≥0.8 ∧ 样本 ≥30 ∧ Cohen's kappa ≥0.6 ∧ 负类召回 ≥0.6
 * (人工负例 ≥5 条,否则语料不具校准资格) ∧ 有效裁决覆盖率 ≥0.9 ∧ 人工负例有效覆盖率 ≥0.9
 * (L7-P25:judge 解析失败/引用越界的记录不进一致率分母,但不能靠剔除难例或负例晋级)
 * ∧ 无自偏签名。humanDecision 只接受四个合法值,拼错/缺失在调用 judge 前即报错退出。kappa/负类口径防"全判通过"
 * 在类不均衡下靠裸一致率过门(agreeableness 陷阱);"人工因过度泛化收窄/拒绝"子集单列——
 * judge 系统性 uphold 该子集=同源自偏签名(selfBiasSignal)，按 D1 走 Ollama 回退，不得晋级。
 *
 * 输入(--input)：人工标记导出 JSON——
 *   [{ "candidate": {title,kind,doClause,content,reasoning:{sources:[...]}},
 *      "projectRoot": "<切片解析根(绝对或相对导出文件)>",
 *      "humanDecision": "uphold|narrow|trivial|reject",
 *      "overgeneralized": true|false }]
 * 导出来源：staging 复核队列(Core/Agent/主体 HTTP 三读面之一)人工决策 + 快照当时的候选原文。
 *
 * 用法：
 *   npm run build && node scripts/eval-judge-calibration.mjs --input <export.json> [--judge-provider deepseek|ollama --judge-model <model>] [--out <dir>]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSourceFileReceipts, formatJudgeDiagnostic } from './lib/mining-eval-runtime.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error(
    '[judge-calibration] --input <export.json> is required (人工标记导出，格式见脚本头)。'
  );
  process.exit(1);
}
if (typeof args['judge-model'] === 'string' && typeof args['judge-provider'] !== 'string') {
  console.error('[judge-calibration] --judge-model requires an explicit --judge-provider.');
  process.exit(1);
}
for (const required of [
  'dist/ai/AiFactory.js',
  'dist/agent/evaluation/MiningJudge.js',
  'dist/agent/evaluation/StrictProductionFixtureEvaluation.js',
]) {
  try {
    readFileSync(path.join(repoRoot, required));
  } catch {
    console.error(`[judge-calibration] missing ${required} — run \`npm run build\` first.`);
    process.exit(1);
  }
}
const { createProvider, autoDetectProvider } = await import(
  path.join(repoRoot, 'dist/ai/AiFactory.js')
);
const {
  assertFrozenJudgeModelLoadReceiptV1,
  computeJudgeCalibration,
  createFrozenJudgeModelLoadReceiptV1,
  judgeCandidate,
} = await import(path.join(repoRoot, 'dist/agent/evaluation/MiningJudge.js'));
const { FrozenStrictProductionEvaluationProviderV1 } = await import(
  path.join(repoRoot, 'dist/agent/evaluation/StrictProductionFixtureEvaluation.js')
);
const judgeProvider =
  args['judge-provider'] === 'frozen-fixture'
    ? new FrozenStrictProductionEvaluationProviderV1()
    : args['judge-provider']
      ? createProvider({
          provider: args['judge-provider'],
          ...(typeof args['judge-model'] === 'string' ? { model: args['judge-model'] } : {}),
        })
      : autoDetectProvider();
if (!judgeProvider) {
  console.error(
    '[judge-calibration] no judge provider — set ALEMBIC_DEEPSEEK_API_KEY or pass --judge-provider ollama.'
  );
  process.exit(1);
}
const judgeModelLoadReceipt = createFrozenJudgeModelLoadReceiptV1({
  selectionMode:
    typeof args['judge-provider'] === 'string' && typeof args['judge-model'] === 'string'
      ? 'explicit'
      : 'auto-detected',
  requestedProvider: typeof args['judge-provider'] === 'string' ? args['judge-provider'] : null,
  requestedModel: typeof args['judge-model'] === 'string' ? args['judge-model'] : null,
  resolvedProvider: judgeProvider.name,
  resolvedModel: judgeProvider.model,
  temperature: 0,
  maxTokens: 800,
  implementationModuleSha256: createHash('sha256')
    .update(readFileSync(path.join(repoRoot, 'dist/agent/evaluation/MiningJudge.js')))
    .digest('hex'),
});

const inputPath = path.resolve(args.input);
const inputBytes = readFileSync(inputPath);
const exported = JSON.parse(inputBytes.toString('utf8'));
if (!Array.isArray(exported) || exported.length === 0) {
  console.error('[judge-calibration] input 为空或不是数组。');
  process.exit(1);
}
// 人工标签预检(L7-P25 / C16)：在花费任何 judge 调用前,复用 computeJudgeCalibration 的入口校验
// (单源合法值集合)检查全部 humanDecision——judgeVerdict 置 null 只为触发校验,结果丢弃。
// 拼错或缺失的标签立即退出并列出索引,先修导出数据,而不是被静默计为人工负例。
try {
  computeJudgeCalibration(
    exported.map((sample) => ({ humanDecision: sample?.humanDecision, judgeVerdict: null }))
  );
} catch (err) {
  console.error(
    `[judge-calibration] 人工标签非法(合法值 uphold|narrow|trivial|reject),请先修正导出数据：${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}
console.log(
  `[judge-calibration] samples=${exported.length} judge=${judgeProvider.name}/${judgeProvider.model}`
);
console.log(`[judge-calibration] judgeModelLoadReceipt=${judgeModelLoadReceipt.receiptHash}`);

const records = [];
for (const [index, sample] of exported.entries()) {
  const projectRoot = path.resolve(path.dirname(inputPath), sample.projectRoot || '.');
  let judgeVerdict = null;
  try {
    judgeVerdict = await judgeCandidate({
      candidate: sample.candidate,
      projectRoot,
      chat: async (prompt) => {
        const result = await judgeProvider.chatWithTools(prompt, {
          temperature: 0,
          maxTokens: 800,
        });
        return String(result?.text ?? '');
      },
      // 逐条打印被跳过的来源、无可读切片与裁决解析失败：judge=n/a 或缺证据 reject 的样本可复核原因。
      onDiagnostic: (diagnostic) => {
        console.warn(`[judge-calibration] #${index} judge ${formatJudgeDiagnostic(diagnostic)}`);
      },
    });
  } catch (err) {
    console.warn(
      `[judge-calibration] #${index} judge error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  records.push({
    // 原值透传(已通过预检),不再用 String(...) 把缺失标签折成空串。
    humanDecision: sample.humanDecision,
    overgeneralized: sample.overgeneralized === true,
    judgeVerdict,
  });
  console.log(
    `[judge-calibration] #${index} human=${sample.humanDecision} judge=${judgeVerdict?.verdict ?? 'n/a'}${judgeVerdict?.invalidCitation ? '(invalid-citation)' : ''}`
  );
}

const calibration = computeJudgeCalibration(records);
assertFrozenJudgeModelLoadReceiptV1(judgeModelLoadReceipt, {
  resolvedProvider: judgeProvider.name,
  resolvedModel: judgeProvider.model,
});
const startedAt =
  typeof args['frozen-started-at'] === 'string'
    ? args['frozen-started-at']
    : new Date().toISOString();
const outDir = path.resolve(
  repoRoot,
  args.out ||
    path.join('test-reports', 'judge-calibration', startedAt.slice(0, 19).replaceAll(':', '-'))
);
mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, 'calibration.json'),
  `${JSON.stringify(
    {
      kind: 'JudgeCalibrationReport',
      version: 1,
      startedAt,
      judge: `${judgeProvider.name}/${judgeProvider.model}`,
      judgeModelLoadReceipt,
      evaluationReceipts: {
        inputSha256: sha256(inputBytes),
        configSha256: sha256(
          JSON.stringify({
            sampleCount: exported.length,
            startedAt,
            temperature: 0,
            maxTokens: 800,
          })
        ),
        providerSha256: sha256(
          JSON.stringify({ provider: judgeProvider.name, model: judgeProvider.model })
        ),
        sourceFiles: collectSourceFileReceipts(exported, inputPath),
        apiKeyReadCount: Number(judgeProvider.apiKeyReadCount || 0),
        networkRequestCount: Number(judgeProvider.networkRequestCount || 0),
        negativeResults: records
          .map((record, index) => ({ record, index }))
          .filter(({ record }) => record.humanDecision !== 'uphold')
          .map(({ record, index }) => ({
            index,
            humanDecision: record.humanDecision,
            judgeVerdict: record.judgeVerdict?.verdict ?? null,
            passed: record.judgeVerdict?.verdict === record.humanDecision,
          })),
      },
      calibration,
      records: records.map((record) => ({
        humanDecision: record.humanDecision,
        overgeneralized: record.overgeneralized,
        judgeVerdict: record.judgeVerdict?.verdict ?? null,
        invalidCitation: record.judgeVerdict?.invalidCitation === true,
      })),
    },
    null,
    2
  )}\n`
);
const coverageView = describeCoverage(calibration, records);
console.log(
  `[judge-calibration] agreement=${fmt(calibration.agreementRate)} exact=${fmt(calibration.exactRate)} overgen-subset=${fmt(calibration.overgenSubset.rate)}(${calibration.overgenSubset.agreed}/${calibration.overgenSubset.total}) judged=${calibration.judged}/${calibration.total} coverage=${fmt(coverageView.coverage)} negative-coverage=${fmt(coverageView.negativeCoverage)}(${calibration.negativeSubset.total}/${coverageView.humanNegativeTotal})`
);
// 不合格时逐条列出全部未过的门,而不是只报第一条:覆盖率不足时旧文案会误报成"一致率 <80%"。
console.log(
  calibration.promotionEligible
    ? '[judge-calibration] ✅ PROMOTION ELIGIBLE — 一致率/kappa/负类召回/覆盖率达标且无自偏签名(P2 critic 可进管线，observe-first)。'
    : `[judge-calibration] ⛔ NOT eligible — ${describeIneligibility(calibration, coverageView).join('；')}；critic 留在离线，迭代 rubric。`
);
console.log(`[judge-calibration] report → ${path.relative(repoRoot, outDir)}/calibration.json`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

/**
 * 从既有返回字段与 records 推导覆盖率(L7-P25)：computeJudgeCalibration 暂不返回 coverage 字段
 * (公开返回面新增待决策确认),脚本按同一口径自算,只用于打印不合格原因。
 */
function describeCoverage(calibration, calibrationRecords) {
  const humanNegativeTotal = calibrationRecords.filter(
    (record) => record.humanDecision !== 'uphold'
  ).length;
  return {
    coverage: calibration.total > 0 ? calibration.judged / calibration.total : null,
    humanNegativeTotal,
    negativeCoverage:
      humanNegativeTotal > 0 ? calibration.negativeSubset.total / humanNegativeTotal : null,
  };
}

/**
 * 不合格原因清单。门限与 MiningJudge.computeJudgeCalibration 的默认值逐项对应
 * (一致率 0.8、样本 30、kappa 0.6、负例 5、负类召回 0.6、覆盖率/负例覆盖率 0.9);
 * 默认值调整时两处须同步。全部门都显示通过却不可晋级时如实提示核对报告,不编造原因。
 */
function describeIneligibility(calibration, coverageView) {
  const reasons = [];
  if (calibration.selfBiasSignal) {
    reasons.push('自偏签名命中(过度泛化子集被系统性放行)→按 D1 换 Ollama judge 重校准');
  }
  if (calibration.judged < 30) {
    reasons.push(`有效样本 ${calibration.judged}<30`);
  }
  if (coverageView.coverage === null || coverageView.coverage < 0.9) {
    reasons.push(
      `有效裁决覆盖率 ${fmtPrecise(coverageView.coverage)}<90%(judged ${calibration.judged}/${calibration.total},无效或无法解析 ${calibration.total - calibration.judged} 条)`
    );
  }
  if (coverageView.negativeCoverage === null || coverageView.negativeCoverage < 0.9) {
    reasons.push(
      `人工负例有效覆盖率 ${fmtPrecise(coverageView.negativeCoverage)}<90%(${calibration.negativeSubset.total}/${coverageView.humanNegativeTotal},无效裁决集中在负例会掩盖错放)`
    );
  }
  if (calibration.agreementRate === null || calibration.agreementRate < 0.8) {
    reasons.push(`一致率 ${fmtPrecise(calibration.agreementRate)}<80%`);
  }
  if (calibration.kappa === null || calibration.kappa < 0.6) {
    reasons.push(
      `kappa ${calibration.kappa === null ? 'n/a(退化语料)' : calibration.kappa.toFixed(2)}<0.6`
    );
  }
  if (calibration.negativeSubset.total < 5) {
    reasons.push(`有效人工负例 ${calibration.negativeSubset.total}<5`);
  }
  if (calibration.negativeSubset.recall === null || calibration.negativeSubset.recall < 0.6) {
    reasons.push(`负类召回 ${fmtPrecise(calibration.negativeSubset.recall)}<60%`);
  }
  if (reasons.length === 0) {
    reasons.push(
      '未匹配到已知门限(脚本门限可能与 MiningJudge 默认值不同步),请核对 calibration.json'
    );
  }
  return reasons;
}

/** 不合格原因用一位小数,避免 89.6% 被四舍五入成“90%<90%”这类自相矛盾的文案。 */
function fmtPrecise(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
