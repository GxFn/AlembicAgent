/**
 * mining Judge(P0-3 挖掘质量升级)：独立 critic，对候选做"声明↔证据蕴含"判定。
 *
 * D1 决策(无多余 key)：judge 与 producer 同 key(DeepSeek)+ 三层独立性缓解——
 *   ① 上下文隔离：judge 只见候选字段 + 按 sources 从真实文件重切的逐字切片；不见挖掘轨迹、
 *      不见产出者身份；每候选独立会话(单次 chat 调用)。
 *   ② 反驳框架(refute-first)：prompt 要求先尝试反驳，无法反驳且切片支撑才 entailed——
 *      对冲同源放行偏置(adversarial-verify 模式)。
 *   ③ judge 自身受机械引用管辖：verdict.citedLines 必须落在提供切片的行区间内(下方
 *      verifyJudgeCitations 区间校验)，越界即 invalidCitation → 裁决按无效处理(保守)。
 * 校准兼自偏检测(需求 §P0-3)：judge-人工一致率 ≥80% 才允许 P2 critic 进管线；
 * "过度泛化子集"一致率单列为自偏签名——由 eval-judge-calibration 脚本消费本模块。
 *
 * chat 依赖注入(async (prompt) => text)：单测不触网；真实运行由 eval-mining 传 provider。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 从候选 reasoning.sources('path:start-end')在 projectRoot 下重切逐字切片。 */
export function sliceEvidenceForJudge(
  candidate,
  projectRoot,
  { maxSlices = 6, maxLines = 60 } = {}
) {
  const reasoning =
    candidate?.reasoning && typeof candidate.reasoning === 'object' ? candidate.reasoning : {};
  const sources = Array.isArray(reasoning.sources) ? reasoning.sources : [];
  const slices = [];
  for (const source of sources.slice(0, maxSlices)) {
    if (typeof source !== 'string') {
      continue;
    }
    const match = /^(.+?):(\d+)-(\d+)$/.exec(source.trim());
    if (!match) {
      continue;
    }
    const [, file, startRaw, endRaw] = match;
    const start = Number(startRaw);
    const end = Math.min(Number(endRaw), start + maxLines - 1);
    try {
      const lines = readFileSync(join(projectRoot, file), 'utf8').split('\n');
      if (start < 1 || start > lines.length) {
        continue;
      }
      const body = lines
        .slice(start - 1, Math.min(end, lines.length))
        .map((line, offset) => `${start + offset}|${line}`)
        .join('\n');
      slices.push({ file, start, end: Math.min(end, lines.length), body });
    } catch {
      // 文件不可读→该 source 无切片；judge 面对证据缺失自然趋向 not_entailed(保守方向)。
    }
  }
  return slices;
}

/** refute-first prompt：只含候选与切片，零轨迹零身份(上下文隔离)。 */
export function buildJudgePrompt(candidate, slices) {
  const content =
    candidate?.content && typeof candidate.content === 'object' ? candidate.content : {};
  const sliceBlocks = slices
    .map((slice) => `--- ${slice.file}:${slice.start}-${slice.end} ---\n${slice.body}`)
    .join('\n\n');
  return [
    'You are an independent evidence auditor for mined code knowledge. You see ONLY the candidate and verbatim source slices below — nothing else exists.',
    '',
    'TASK (refute-first): actively try to REFUTE the candidate claim using only the slices. Only if you cannot refute it AND the slices affirmatively support it, is it entailed. When uncertain, lean AGAINST the candidate.',
    '',
    'Judge four dimensions:',
    '1. entailment — do the slices entail the claim as scoped? (entailed / partial / not_entailed; "all X do Y" needs evidence breadth, not one example)',
    '2. trivial — would a competent developer know this without being told (restating imports/filenames/syntax)? (true/false)',
    '3. actionable — does it change what a developer writes or decides? (true/false)',
    '4. scopeCorrect — does the claimed scope match what the evidence shows? (true/false)',
    '',
    'Final verdict: uphold (entailed + non-trivial + actionable) / narrow (true but over-scoped) / trivial / reject.',
    '',
    'You MUST cite the slice lines that ground your verdict as "file:line" or "file:start-end" entries in citedLines — every cited line must fall inside the provided slices; citations outside them invalidate your verdict.',
    '',
    'Respond with ONLY a JSON object: {"entailment":"entailed|partial|not_entailed","trivial":bool,"actionable":bool,"scopeCorrect":bool,"verdict":"uphold|narrow|trivial|reject","citedLines":["file:line" | "file:start-end"],"reason":"<=60 words"}',
    '',
    '=== CANDIDATE ===',
    `title: ${String(candidate?.title ?? '')}`,
    `kind: ${String(candidate?.kind ?? '')}`,
    `doClause: ${String(candidate?.doClause ?? '')}`,
    `dontClause: ${String(candidate?.dontClause ?? '')}`,
    `claim body:\n${String(content.markdown ?? '').slice(0, 2400)}`,
    '',
    '=== VERBATIM SOURCE SLICES ===',
    sliceBlocks || '(no readable slices — treat as insufficient evidence)',
  ].join('\n');
}

/** judge 输出解析：非 JSON/形状不合法→null(保守，无裁决)。 */
export function parseJudgeVerdict(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const verdict = String(parsed.verdict ?? '');
    if (!['uphold', 'narrow', 'trivial', 'reject'].includes(verdict)) {
      return null;
    }
    return {
      entailment: String(parsed.entailment ?? ''),
      trivial: parsed.trivial === true,
      actionable: parsed.actionable === true,
      scopeCorrect: parsed.scopeCorrect === true,
      verdict,
      citedLines: Array.isArray(parsed.citedLines)
        ? parsed.citedLines.filter((line) => typeof line === 'string')
        : [],
      reason: String(parsed.reason ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * judge 引用机械校验(缓解③)：每条 citedLines("file:line" 或 "file:start-end")必须
 * 完整落在某一提供切片的区间内。与提交侧同一哲学——引用不被信任，被校验。
 * 门0 真跑教训：切片头本身就以 "file:start-end" 展示,judge 自然照抄区间格式——
 * 只认单行的旧正则把 5/5 条实质正确的引用全判无效(校验器与自己的展示格式打架)。
 */
export function verifyJudgeCitations(verdict, slices) {
  if (!verdict) {
    return false;
  }
  if (verdict.citedLines.length === 0) {
    return false;
  }
  return verdict.citedLines.every((cited) => {
    const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(cited.trim());
    if (!match) {
      return false;
    }
    const [, file, startRaw, endRaw] = match;
    const start = Number(startRaw);
    const end = endRaw ? Number(endRaw) : start;
    if (end < start) {
      return false;
    }
    return slices.some((slice) => slice.file === file && start >= slice.start && end <= slice.end);
  });
}

/**
 * 校准计算(P0-3 晋级门)：judge 裁决 vs 人工(staging 复核/evolution 决策)标记。
 * records: [{ humanDecision: 'uphold'|'narrow'|'trivial'|'reject', judgeVerdict: {...}|null,
 *            overgeneralized?: boolean }]
 * - agreementRate：二元保留一致率(双方都 uphold 或都非 uphold)——晋级门 ≥0.8 的口径；
 * - exactRate：四值全等(辅助观察)；
 * - overgenSubset：人工因过度泛化收窄/拒绝的子集——judge 若系统性 uphold 该子集即
 *   同源自偏签名(selfBiasSignal=true → 按 D1 走 Ollama 回退，不得晋级)；
 * - invalidCitation/null 裁决不计入分母(judge 无效裁决=无裁决，保守)。
 */
export function computeJudgeCalibration(records, { promotionFloor = 0.8 } = {}) {
  const judged = records.filter(
    (record) => record.judgeVerdict?.verdict && !record.judgeVerdict.invalidCitation
  );
  const binaryAgree = (record) => {
    const humanKeep = record.humanDecision === 'uphold';
    const judgeKeep = record.judgeVerdict.verdict === 'uphold';
    return humanKeep === judgeKeep;
  };
  const agreed = judged.filter(binaryAgree);
  const exact = judged.filter((record) => record.humanDecision === record.judgeVerdict.verdict);
  const overgen = judged.filter((record) => record.overgeneralized === true);
  const overgenAgreed = overgen.filter((record) => record.judgeVerdict.verdict !== 'uphold');
  const agreementRate = judged.length > 0 ? agreed.length / judged.length : null;
  const overgenRate = overgen.length > 0 ? overgenAgreed.length / overgen.length : null;
  return {
    total: records.length,
    judged: judged.length,
    agreementRate,
    exactRate: judged.length > 0 ? exact.length / judged.length : null,
    overgenSubset: { total: overgen.length, agreed: overgenAgreed.length, rate: overgenRate },
    selfBiasSignal: overgenRate !== null && overgenRate < promotionFloor,
    promotionEligible:
      agreementRate !== null &&
      agreementRate >= promotionFloor &&
      judged.length >= 30 &&
      !(overgenRate !== null && overgenRate < promotionFloor),
  };
}

/**
 * 单候选完整裁决：切片 → prompt → chat → 解析 → 引用校验。
 * 引用校验失败→verdict 保留但打 invalidCitation(消费方按无效裁决处理，不计入 precision)。
 */
export async function judgeCandidate({ candidate, projectRoot, chat }) {
  const slices = sliceEvidenceForJudge(candidate, projectRoot);
  const prompt = buildJudgePrompt(candidate, slices);
  const text = await chat(prompt);
  const verdict = parseJudgeVerdict(text);
  if (!verdict) {
    return null;
  }
  const citationsOk = verifyJudgeCitations(verdict, slices);
  return citationsOk ? verdict : { ...verdict, invalidCitation: true };
}
