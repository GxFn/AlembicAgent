#!/usr/bin/env node
/**
 * eval:judge-calibration — Judge 校准(P0-3 晋级门 + 自偏检测)。
 *
 * 口径(需求 §P0-3 / D2+,G-B 修订)：ground truth 复用进化环既有人工标记——staging 复核结论
 * (uphold/narrow/reject/trivial)与 evolution 决策；judge 对同一批候选独立裁决。
 * 晋级门 = 二元保留一致率 ≥0.8 ∧ 样本 ≥30 ∧ Cohen's kappa ≥0.6 ∧ 负类召回 ≥0.6
 * (人工负例 ≥5 条,否则语料不具校准资格) ∧ 无自偏签名。kappa/负类口径防"全判通过"
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
    });
  } catch (err) {
    console.warn(
      `[judge-calibration] #${index} judge error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  records.push({
    humanDecision: String(sample.humanDecision ?? ''),
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
console.log(
  `[judge-calibration] agreement=${fmt(calibration.agreementRate)} exact=${fmt(calibration.exactRate)} overgen-subset=${fmt(calibration.overgenSubset.rate)}(${calibration.overgenSubset.agreed}/${calibration.overgenSubset.total}) judged=${calibration.judged}/${calibration.total}`
);
console.log(
  calibration.promotionEligible
    ? '[judge-calibration] ✅ PROMOTION ELIGIBLE — 一致率达标且无自偏签名(P2 critic 可进管线，observe-first)。'
    : `[judge-calibration] ⛔ NOT eligible — ${calibration.selfBiasSignal ? '自偏签名命中(过度泛化子集被系统性放行)→按 D1 换 Ollama judge 重校准' : calibration.judged < 30 ? '有效样本 <30' : '一致率 <80%'}；critic 留在离线，迭代 rubric。`
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

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}

function collectSourceFileReceipts(samples, sourceInputPath) {
  const rows = new Map();
  for (const sample of samples) {
    const projectRoot = path.resolve(path.dirname(sourceInputPath), sample.projectRoot || '.');
    const sources = Array.isArray(sample.candidate?.reasoning?.sources)
      ? sample.candidate.reasoning.sources
      : [];
    for (const source of sources) {
      const match = /^(.+?):\d+-\d+$/u.exec(String(source));
      if (!match) {
        continue;
      }
      const relativePath = match[1];
      const absolutePath = path.resolve(projectRoot, relativePath);
      rows.set(`${sample.projectRoot || '.'}/${relativePath}`, {
        projectRoot: sample.projectRoot || '.',
        relativePath,
        sha256: sha256(readFileSync(absolutePath)),
      });
    }
  }
  return [...rows.values()].sort((left, right) =>
    `${left.projectRoot}/${left.relativePath}`.localeCompare(
      `${right.projectRoot}/${right.relativePath}`
    )
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
