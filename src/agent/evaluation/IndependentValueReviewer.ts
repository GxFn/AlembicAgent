import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { FullAuthoredProjectionV1 } from '../production/StrictProductionPipeline.js';
import {
  canonicalizeStrictEvidenceProjection,
  type StrictEvidenceProjectionErrorCodesV1,
} from '../production/strict/lineage.js';

export type { JudgeCalibrationRecordV1 } from './MiningJudge.js';
export { computeJudgeCalibration } from './MiningJudge.js';

// 与 gateEvaluators 相同的惰性 logger：Core logger 单例在首次拒绝时才物化，模块导入无副作用。
const logger = () => Logger.getInstance();

/** 拒绝诊断统一消息；测试与宿主日志过滤都以这条消息定位独立评审的拒绝事件。 */
const REJECT_LOG_MESSAGE = '[IndependentValueReviewer] independent review rejected';

/**
 * 独立性不可比诊断统一消息，与拒绝日志分开过滤：它不是拒绝，verdict 不受影响。
 * 诊断 reasonCode 固定为 `reviewer-independence-uncomparable`，coordinateIssue 说明不可比的形状。
 */
const INDEPENDENCE_UNCOMPARABLE_LOG_MESSAGE =
  '[IndependentValueReviewer] reviewer independence uncomparable';

/**
 * 摘要形状的身份段：可选算法标签加 40–128 位十六进制（sha1/sha256/sha384/sha512），
 * 覆盖宿主 StrictAuthorization 校验的 `sha256:<64hex>` modelHash。这样的段标识模型内容哈希，
 * 不是 provider/model 字面坐标，无法与 reviewer 的 `${provider}/${model}` 比较。
 */
const DIGEST_SEGMENT_PATTERN = /^(?:[a-z0-9-]+:)?[0-9a-f]{40,128}$/iu;

/**
 * producerIdentity 与 reviewer 坐标不可比的原因：
 * - `model-hash-coordinate`：某一段是摘要（宿主生产格式 `producer/sha256:<64hex>`）；
 * - `provider-model-shape-missing`：缺少 `<provider>/<model>` 两段（空串、无分隔符、某段为空）。
 */
type ProducerCoordinateIssueV1 = 'model-hash-coordinate' | 'provider-model-shape-missing';

export interface FrozenEvidenceEntryV1 {
  readonly evidenceEntryId: string;
  readonly relativePath: string;
  readonly blobHash: string;
  readonly contentHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export interface FrozenEvidenceProjectionV1 {
  readonly schemaVersion: 1;
  readonly sourceRevisionVectorHash: string;
  readonly entries: readonly FrozenEvidenceEntryV1[];
  readonly projectionHash: string;
}

export interface ReviewerIdentityV1 {
  readonly provider: string;
  readonly model: string;
  readonly method: string;
}

export interface IndependentReviewAxisV1 {
  readonly axis:
    | 'entailment'
    | 'contradiction-free'
    | 'project-specificity'
    | 'actionability'
    | 'scope-correctness'
    | 'retrieval-fitness';
  readonly verdict: 'pass' | 'narrow' | 'fail';
  readonly score: 0 | 1 | 2;
  readonly reasonCode: string;
  readonly evidenceEntryIds: readonly string[];
}

export interface IndependentReviewDecisionV1 {
  readonly schemaVersion: 1;
  readonly verdict: 'pass' | 'narrow' | 'reject';
  readonly reasonCode: string;
  readonly reviewerIdentity: ReviewerIdentityV1;
  readonly admissionReceiptId: string;
  readonly calibrationReceiptHash: string;
  readonly sourceRevisionVectorHash: string;
  /**
   * 模型评审后的六轴裁决。七种整体拒绝（repair limit、source drift、reviewer 不独立、authored
   * 证据缺失、输出/citation/rubric 无效）固定为空数组且 citedLines 为空：这些拒绝没有发生过逐轴
   * 评分，不伪造六轴 fail/0。Core createStrictG2ReceiptV1 要求恰好六行，宿主遇 verdict=reject 且
   * axes 为空时必须在构造 G2 之前直接终结并带上 reasonCode（P20 方案 A）；契约由
   * test/independent-value-reviewer-core-g2-contract.test.ts 记录。
   */
  readonly axes: readonly IndependentReviewAxisV1[];
  readonly noveltyDecision: 'novel-project-specific' | 'known-general' | 'not-novel';
  readonly duplicateDecision: 'no-match' | 'merge' | 'duplicate';
  readonly citedLines: readonly string[];
  readonly decisionHash: string;
}

export interface IndependentValueReviewerOptionsV1 {
  readonly identity: ReviewerIdentityV1;
  readonly chat: (prompt: string) => Promise<string>;
}

export interface IndependentValueReviewInputV1 {
  readonly authored: FullAuthoredProjectionV1;
  readonly evidence: FrozenEvidenceProjectionV1;
  readonly expectedSourceRevisionVectorHash: string;
  readonly producerIdentity: string;
  readonly admissionReceiptId: string;
  readonly calibrationReceiptHash: string;
  readonly repairAttempt: number;
}

const REQUIRED_AXES: readonly IndependentReviewAxisV1['axis'][] = [
  'actionability',
  'contradiction-free',
  'entailment',
  'project-specificity',
  'retrieval-fitness',
  'scope-correctness',
];

const AXIS_VERDICTS: readonly IndependentReviewAxisV1['verdict'][] = ['pass', 'narrow', 'fail'];
const AXIS_SCORES: readonly IndependentReviewAxisV1['score'][] = [0, 1, 2];

/**
 * 轴 verdict 与 score 的唯一合法配对：pass↔2、narrow↔1、fail↔0。
 * 该规则与 Core `strictG2ScoreMatchesVerdict`（pass↔2、revise↔1、fail↔0，宿主把 narrow
 * 映射为 revise）一致；不配对的轴若进入 decision，宿主构造 G2 回执时会抛
 * STRICT_G2_AXIS_SET_INVALID 并中止整批运行。因此解析阶段不再对不配对的轴做任何兜底
 * 推断（例如不再把 score=1 当作 narrow），整份输出按 review-output-invalid 拒绝。
 */
const AXIS_SCORE_BY_VERDICT: Readonly<
  Record<IndependentReviewAxisV1['verdict'], IndependentReviewAxisV1['score']>
> = { pass: 2, narrow: 1, fail: 0 };

/**
 * 评审侧冻结证据投影的既有错误码。规范化本身由 strict lineage 的
 * canonicalizeStrictEvidenceProjection 单源实现，这里只保留评审侧的错误码口径。
 */
const REVIEW_EVIDENCE_PROJECTION_CODES: StrictEvidenceProjectionErrorCodesV1 = {
  fieldRequiredPrefix: 'STRICT_REVIEW_',
  rangeInvalid: 'STRICT_REVIEW_EVIDENCE_RANGE_INVALID',
  contentHashMismatch: 'STRICT_REVIEW_EVIDENCE_CONTENT_HASH_MISMATCH',
  rangeContentMismatch: 'STRICT_REVIEW_EVIDENCE_RANGE_CONTENT_MISMATCH',
  idDuplicate: 'STRICT_REVIEW_EVIDENCE_ID_DUPLICATE',
};

export function createFrozenEvidenceProjection(input: {
  readonly sourceRevisionVectorHash: string;
  readonly entries: readonly Omit<FrozenEvidenceEntryV1, never>[];
}): FrozenEvidenceProjectionV1 {
  requireText(input.sourceRevisionVectorHash, 'STRICT_REVIEW_SOURCE_VECTOR_REQUIRED');
  // 评审侧拒绝空投影；lineage 复核侧目前接受空投影，口径差异是登记的开放问题，不在此统一。
  if (input.entries.length === 0) {
    fail('STRICT_REVIEW_EVIDENCE_REQUIRED');
  }
  // 规范化、en 固定排序与哈希和 Producer lineage 复核共用同一实现，保证这里冻结的
  // projectionHash 在 createStrictProducerLineageReceiptV1 中逐字节复核通过。
  const { semantic, projectionHash } = canonicalizeStrictEvidenceProjection(
    input,
    REVIEW_EVIDENCE_PROJECTION_CODES
  );
  return freeze({ ...semantic, projectionHash });
}

/**
 * Reviewer 只看完整 authoring projection 与冻结证据，不接收 Producer 轨迹、提示、
 * 隐藏推理或实时文件，避免同源上下文污染独立裁决。
 */
export function buildIndependentReviewPrompt(input: {
  readonly authored: FullAuthoredProjectionV1;
  readonly evidence: FrozenEvidenceProjectionV1;
}): string {
  const authored = JSON.stringify(input.authored, null, 2);
  const evidence = input.evidence.entries
    .map(
      (entry) =>
        `--- ${entry.evidenceEntryId} ${entry.relativePath}:${entry.startLine}-${entry.endLine} ` +
        `blob=${entry.blobHash} content=${entry.contentHash} ---\n${entry.content}`
    )
    .join('\n\n');
  return [
    'You are the independent production value reviewer.',
    'Use only the immutable evidence projection below. Refute first and fail closed on uncertainty.',
    'Review the COMPLETE authored projection: title, kind, doClause, dontClause, markdown, usageGuide, retrievalProfile, negativeIntent, scope, and evidenceEntryIds.',
    `Return JSON with exactly six axes (${REQUIRED_AXES.join(', ')}). Each axis has axis, verdict(pass|narrow|fail), score(0|1|2), reasonCode, evidenceEntryIds.`,
    'verdict and score must pair exactly: pass=2, narrow=1, fail=0. Any other pairing invalidates the whole review.',
    'Also return noveltyDecision(novel-project-specific|known-general|not-novel), duplicateDecision(no-match|merge|duplicate), and citedLines(path:line or path:start-end).',
    '',
    '=== COMPLETE AUTHORED PROJECTION ===',
    authored,
    '',
    `=== FROZEN EVIDENCE sourceRevisionVectorHash=${input.evidence.sourceRevisionVectorHash} projectionHash=${input.evidence.projectionHash} ===`,
    evidence,
  ].join('\n');
}

export class IndependentValueReviewer {
  readonly #identity: ReviewerIdentityV1;
  readonly #chat: IndependentValueReviewerOptionsV1['chat'];

  constructor(options: IndependentValueReviewerOptionsV1) {
    validateIdentity(options.identity);
    this.#identity = freeze({ ...options.identity });
    this.#chat = options.chat;
  }

  async review(input: IndependentValueReviewInputV1): Promise<IndependentReviewDecisionV1> {
    requireText(input.admissionReceiptId, 'STRICT_REVIEW_ADMISSION_REQUIRED');
    requireText(input.calibrationReceiptHash, 'STRICT_REVIEW_CALIBRATION_REQUIRED');
    if (!Number.isSafeInteger(input.repairAttempt) || input.repairAttempt < 0) {
      fail('STRICT_REVIEW_REPAIR_ATTEMPT_INVALID');
    }
    if (input.repairAttempt > 2) {
      return this.#reject(input, 'semantic-repair-limit', { repairAttemptLimit: 2 });
    }
    if (input.expectedSourceRevisionVectorHash !== input.evidence.sourceRevisionVectorHash) {
      return this.#reject(input, 'source-drift', {
        expectedSourceRevisionVectorHash: input.expectedSourceRevisionVectorHash,
        evidenceSourceRevisionVectorHash: input.evidence.sourceRevisionVectorHash,
      });
    }
    const reviewerIdentity = `${this.#identity.provider}/${this.#identity.model}`;
    if (input.producerIdentity === reviewerIdentity) {
      return this.#reject(input, 'reviewer-not-independent', {
        producerIdentity: input.producerIdentity,
      });
    }
    // 过渡期诊断（P20/C05）：上面的全等比较只对同一坐标系的 `<provider>/<model>` 有意义。
    // 唯一生产宿主传入的是 `producer/${planning.modelHash}`（模型内容哈希），与 reviewer 坐标
    // 没有规范化映射，比较必然不相等、独立性守卫形同虚设。这里只识别“比较无意义”的形状并
    // 记录诊断，verdict 与 decision 均不变；结构化身份与双方共用的规范化函数属于跨仓决定②⑤。
    const coordinateIssue = classifyProducerCoordinate(input.producerIdentity);
    if (coordinateIssue !== null) {
      observeSafely(
        () =>
          logger().warn(INDEPENDENCE_UNCOMPARABLE_LOG_MESSAGE, {
            reasonCode: 'reviewer-independence-uncomparable',
            coordinateIssue,
            producerIdentity: input.producerIdentity,
            reviewerIdentity,
            admissionReceiptId: input.admissionReceiptId,
            repairAttempt: input.repairAttempt,
            sourceRevisionVectorHash: input.evidence.sourceRevisionVectorHash,
            verdictEffect: 'none',
          }),
        () => undefined
      );
    }
    const authoredEvidenceIds = new Set(input.authored.evidenceEntryIds);
    const suppliedEvidenceIds = new Set(
      input.evidence.entries.map((entry) => entry.evidenceEntryId)
    );
    const missingAuthoredEvidenceIds = [...authoredEvidenceIds].filter(
      (entryId) => !suppliedEvidenceIds.has(entryId)
    );
    if (authoredEvidenceIds.size === 0 || missingAuthoredEvidenceIds.length > 0) {
      return this.#reject(input, 'authored-evidence-missing', {
        authoredEvidenceCount: authoredEvidenceIds.size,
        missingAuthoredEvidenceIds,
      });
    }

    const raw = await this.#chat(
      buildIndependentReviewPrompt({ authored: input.authored, evidence: input.evidence })
    );
    // chat 之后的拒绝都带 raw 的 sha256 与长度：能把拒绝对应回宿主侧保存的原始输出，
    // 又不把可能含证据原文的模型输出写进日志。
    const rawDigest = describeRawOutput(raw);
    const parsed = parseReview(raw);
    if (!parsed.ok) {
      return this.#reject(input, 'review-output-invalid', {
        ...rawDigest,
        parseFailure: parsed.reason,
        parseFailureDetail: parsed.detail ?? null,
        failedAxis: parsed.axis ?? null,
      });
    }
    const invalidCitations = findInvalidReviewCitations(
      parsed.review.citedLines,
      input.evidence.entries
    );
    if (parsed.review.citedLines.length === 0 || invalidCitations.length > 0) {
      return this.#reject(input, 'review-citation-invalid', {
        ...rawDigest,
        citedLineCount: parsed.review.citedLines.length,
        invalidCitations,
      });
    }
    const axesByName = new Map(parsed.review.axes.map((axis) => [axis.axis, axis]));
    const axes = REQUIRED_AXES.map((axis) => axesByName.get(axis)).filter(
      (axis): axis is IndependentReviewAxisV1 => Boolean(axis)
    );
    // parseReview 已保证轴名合法且不重复，所以“轴数不足六个”等价于“缺少某些必需轴”。
    const missingAxes = REQUIRED_AXES.filter((axis) => !axesByName.has(axis));
    const unknownEvidenceEntryIds = axes.flatMap((axis) =>
      axis.evidenceEntryIds
        .filter((entryId) => !suppliedEvidenceIds.has(entryId))
        .map((entryId) => `${axis.axis}:${entryId}`)
    );
    if (missingAxes.length > 0 || unknownEvidenceEntryIds.length > 0) {
      return this.#reject(input, 'review-rubric-incomplete', {
        ...rawDigest,
        missingAxes,
        unknownEvidenceEntryIds,
      });
    }
    // 裁决顺序刻意保持原样（narrow 先于 novelty/duplicate、merge 归 narrow）：按 Core 顺序
    // 重写属于 P21 的 verdict 部分，需与 P20 宿主改动同批落地，本批不改。parseReview 已保证
    // verdict/score 配对，下面的 `|| axis.score === 0/1` 兜底此时恒与 verdict 判断等价。
    // 现状（narrow×not-novel/known-general、pass×merge 经宿主映射后 Core 抛
    // STRICT_G2_REPAIR_FIELDS_INVALID；duplicate 被宿主硬编码 no-match）由
    // test/independent-value-reviewer-core-g2-contract.test.ts 以 it.fails 记录，待 P20 跨仓决定
    //（Core 导出单一 G2 verdict 纯函数，Agent 与宿主同批接入）落地后翻回 it。
    const verdict = axes.some((axis) => axis.verdict === 'fail' || axis.score === 0)
      ? 'reject'
      : axes.some((axis) => axis.verdict === 'narrow' || axis.score === 1) ||
          parsed.review.duplicateDecision === 'merge'
        ? 'narrow'
        : parsed.review.noveltyDecision === 'novel-project-specific' &&
            parsed.review.duplicateDecision === 'no-match'
          ? 'pass'
          : 'reject';
    const reasonCode = verdict === 'pass' ? 'all-value-axes-pass' : `independent-${verdict}`;
    return this.#decision(input, {
      verdict,
      reasonCode,
      axes,
      noveltyDecision: parsed.review.noveltyDecision,
      duplicateDecision: parsed.review.duplicateDecision,
      citedLines: parsed.review.citedLines,
    });
  }

  /**
   * 七种整体拒绝的唯一出口。拒绝分类、admissionReceiptId、repairAttempt 与各分支的定位
   * 信息（缺失轴、越界证据引用、越界 citation、raw 摘要等）只进入 Core Logger，
   * 不写入 decision：decision 的字段集合与 decisionHash 与此前逐字节一致，宿主回放与
   * 历史回执不受影响。日志观察者自身失败只做吞咽（observeSafely），不改变拒绝裁决。
   */
  #reject(
    input: IndependentValueReviewInputV1,
    reasonCode: string,
    diagnostics: Record<string, unknown> = {}
  ): IndependentReviewDecisionV1 {
    observeSafely(
      () =>
        logger().warn(REJECT_LOG_MESSAGE, {
          reasonCode,
          admissionReceiptId: input.admissionReceiptId,
          repairAttempt: input.repairAttempt,
          reviewerIdentity: `${this.#identity.provider}/${this.#identity.model}`,
          sourceRevisionVectorHash: input.evidence.sourceRevisionVectorHash,
          ...diagnostics,
        }),
      () => undefined
    );
    return this.#decision(input, {
      verdict: 'reject',
      reasonCode,
      axes: [],
      noveltyDecision: 'not-novel',
      duplicateDecision: 'no-match',
      citedLines: [],
    });
  }

  #decision(
    input: IndependentValueReviewInputV1,
    result: Pick<
      IndependentReviewDecisionV1,
      'verdict' | 'reasonCode' | 'axes' | 'noveltyDecision' | 'duplicateDecision' | 'citedLines'
    >
  ): IndependentReviewDecisionV1 {
    const semantic = {
      schemaVersion: 1 as const,
      ...result,
      reviewerIdentity: this.#identity,
      admissionReceiptId: input.admissionReceiptId,
      calibrationReceiptHash: input.calibrationReceiptHash,
      sourceRevisionVectorHash: input.evidence.sourceRevisionVectorHash,
    };
    return freeze({ ...semantic, decisionHash: hashCanonical(semantic) });
  }
}

interface ParsedReviewV1 {
  readonly axes: readonly IndependentReviewAxisV1[];
  readonly noveltyDecision: IndependentReviewDecisionV1['noveltyDecision'];
  readonly duplicateDecision: IndependentReviewDecisionV1['duplicateDecision'];
  readonly citedLines: readonly string[];
}

/**
 * parseReview 的结果：成功带归一化后的评审；失败带可定位的原因码（以及失败轴名、解析器
 * 细节）。原因只用于诊断日志，调用方对所有失败一律返回 review-output-invalid，
 * 失败形态与此前返回 null 时完全一致。
 */
type ParseReviewOutcomeV1 =
  | { readonly ok: true; readonly review: ParsedReviewV1 }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly axis?: string;
      readonly detail?: string;
    };

function parseReview(text: string): ParseReviewOutcomeV1 {
  const match = typeof text === 'string' ? text.match(/\{[\s\S]*\}/u) : null;
  if (!match) {
    return invalidReview('json-object-missing');
  }
  try {
    const value = readRecord(JSON.parse(match[0]));
    if (!Array.isArray(value.axes)) {
      return invalidReview('axes-not-array');
    }
    const axes: IndependentReviewAxisV1[] = [];
    for (const [index, raw] of value.axes.entries()) {
      const axis = readRecord(raw);
      // 轴名非法时用位置号代替轴名定位，避免把模型随意生成的字符串原样写进日志。
      if (!isAxisName(axis.axis)) {
        return invalidReview('axis-name-invalid', `#${index}`);
      }
      const axisName = axis.axis;
      if (!isAxisVerdict(axis.verdict)) {
        return invalidReview('axis-verdict-invalid', axisName);
      }
      if (!isAxisScore(axis.score)) {
        return invalidReview('axis-score-invalid', axisName);
      }
      // 配对校验：见 AXIS_SCORE_BY_VERDICT。不配对不做兜底推断，整份输出作废。
      if (AXIS_SCORE_BY_VERDICT[axis.verdict] !== axis.score) {
        return invalidReview('axis-verdict-score-unpaired', axisName);
      }
      if (typeof axis.reasonCode !== 'string' || !axis.reasonCode.trim()) {
        return invalidReview('axis-reason-code-invalid', axisName);
      }
      if (!isTextArray(axis.evidenceEntryIds) || axis.evidenceEntryIds.length === 0) {
        return invalidReview('axis-evidence-entry-ids-invalid', axisName);
      }
      axes.push({
        axis: axis.axis,
        verdict: axis.verdict,
        score: axis.score,
        reasonCode: axis.reasonCode,
        evidenceEntryIds: axis.evidenceEntryIds,
      });
    }
    if (new Set(axes.map((axis) => axis.axis)).size !== axes.length) {
      return invalidReview('axis-duplicate');
    }
    const noveltyDecision = value.noveltyDecision;
    const duplicateDecision = value.duplicateDecision;
    if (
      typeof noveltyDecision !== 'string' ||
      !['novel-project-specific', 'known-general', 'not-novel'].includes(noveltyDecision)
    ) {
      return invalidReview('novelty-decision-invalid');
    }
    if (
      typeof duplicateDecision !== 'string' ||
      !['no-match', 'merge', 'duplicate'].includes(duplicateDecision)
    ) {
      return invalidReview('duplicate-decision-invalid');
    }
    if (!isTextArray(value.citedLines)) {
      return invalidReview('cited-lines-invalid');
    }
    return {
      ok: true,
      review: {
        axes,
        noveltyDecision: noveltyDecision as ParsedReviewV1['noveltyDecision'],
        duplicateDecision: duplicateDecision as ParsedReviewV1['duplicateDecision'],
        citedLines: value.citedLines,
      },
    };
  } catch (err: unknown) {
    // try 块内只有 JSON.parse 会抛错；保留解析器的分类与位置信息供诊断，原文片段不进日志。
    return invalidReview('json-parse-error', undefined, describeParseError(err));
  }
}

function invalidReview(reason: string, axis?: string, detail?: string): ParseReviewOutcomeV1 {
  return { ok: false, reason, ...(axis ? { axis } : {}), ...(detail ? { detail } : {}) };
}

/**
 * V8 的 JSON SyntaxError 会把原始输入片段放在双引号里（`Unexpected token 'x', "..." is not
 * valid JSON`）。诊断只保留引号之前的错误类别与位置信息，不记录模型输出原文。
 */
function describeParseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const quoteIndex = message.indexOf('"');
  const trimmed = (quoteIndex >= 0 ? message.slice(0, quoteIndex) : message).replace(
    /[,\s]+$/u,
    ''
  );
  return trimmed || (err instanceof Error ? err.name : 'unknown-parse-error');
}

/** raw 只以 sha256 与长度进入诊断；非字符串（违反 chat contract）时记录实际类型。 */
function describeRawOutput(raw: unknown): {
  readonly rawSha256: string | null;
  readonly rawLength: number | null;
  readonly rawType: string;
} {
  if (typeof raw !== 'string') {
    return { rawSha256: null, rawLength: null, rawType: typeof raw };
  }
  return { rawSha256: sha256(raw), rawLength: raw.length, rawType: 'string' };
}

/**
 * 判断 producerIdentity 能否与 reviewer 坐标比较；返回 null 表示形状可比（字符串全等有意义）。
 *
 * 两种坐标的来源：
 * - reviewer：`ReviewerIdentityV1.provider/model`，宿主取自授权回执 `planning.reviewer.identity`
 *   的自由符号，比较串为 `${provider}/${model}`（Core G2 actor 再追加 `/${method}`）；
 * - producer：`IndependentValueReviewInputV1.producerIdentity` 自由字符串。唯一生产宿主
 *   StrictPrivateCorpusRuntime 传入 `producer/${planning.modelHash}`，modelHash 是
 *   StrictAuthorization 校验为 `sha256:<64hex>` 的模型内容哈希，不含 provider/model 字面值。
 *
 * 因此只有 reviewer.provider 字面量为 'producer' 且 model 恰为该哈希的人为配置才会全等命中，
 * 生产中独立性检查实际是死分支；Core createStrictG2ReceiptV1 的 identity 全等检查同样如此。
 * 本函数只按形状判断（摘要段、缺段），不猜测 provider 名称的合法集合：形如 `producer/different`
 * 这类字面 `<provider>/<model>` 仍视为可比。
 */
function classifyProducerCoordinate(producerIdentity: unknown): ProducerCoordinateIssueV1 | null {
  // 非字符串违反类型契约，同样无法比较；按缺段归类而不抛错，保持 review() 的原有失败形态。
  if (typeof producerIdentity !== 'string') {
    return 'provider-model-shape-missing';
  }
  const trimmed = producerIdentity.trim();
  const separator = trimmed.indexOf('/');
  if (separator <= 0 || separator === trimmed.length - 1) {
    return DIGEST_SEGMENT_PATTERN.test(trimmed)
      ? 'model-hash-coordinate'
      : 'provider-model-shape-missing';
  }
  const provider = trimmed.slice(0, separator);
  // model 段允许再含 '/'（例如 openrouter/meta/llama-3），只按首个分隔符切分。
  const model = trimmed.slice(separator + 1);
  if (DIGEST_SEGMENT_PATTERN.test(provider) || DIGEST_SEGMENT_PATTERN.test(model)) {
    return 'model-hash-coordinate';
  }
  return null;
}

/**
 * 返回越界或格式非法的 citation（原样字符串，供诊断定位）。空列表表示全部 citation 都落在
 * 冻结证据的 path:line 范围内；citedLines 本身为空的情况由调用方单独判定。
 */
function findInvalidReviewCitations(
  citations: readonly string[],
  evidence: readonly FrozenEvidenceEntryV1[]
): string[] {
  return citations.filter((citation) => {
    const match = /^(.+?):(\d+)(?:-(\d+))?$/u.exec(citation.trim());
    if (!match) {
      return true;
    }
    const [, relativePath, startRaw, endRaw] = match;
    const start = Number(startRaw);
    const end = endRaw ? Number(endRaw) : start;
    return !evidence.some(
      (entry) =>
        entry.relativePath === relativePath &&
        start >= entry.startLine &&
        end >= start &&
        end <= entry.endLine
    );
  });
}

function isAxisName(value: unknown): value is IndependentReviewAxisV1['axis'] {
  return typeof value === 'string' && (REQUIRED_AXES as readonly string[]).includes(value);
}

function isAxisVerdict(value: unknown): value is IndependentReviewAxisV1['verdict'] {
  return typeof value === 'string' && (AXIS_VERDICTS as readonly string[]).includes(value);
}

function isAxisScore(value: unknown): value is IndependentReviewAxisV1['score'] {
  return typeof value === 'number' && (AXIS_SCORES as readonly number[]).includes(value);
}

function validateIdentity(identity: ReviewerIdentityV1): void {
  requireText(identity.provider, 'STRICT_REVIEW_PROVIDER_REQUIRED');
  requireText(identity.model, 'STRICT_REVIEW_MODEL_REQUIRED');
  requireText(identity.method, 'STRICT_REVIEW_METHOD_REQUIRED');
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireText(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(code);
  }
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value: unknown): string {
  return sha256(JSON.stringify(sortCanonical(value)));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      // 固定 en 排序规则：与历史哈希逐字节一致，且不随进程默认区域变化。
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, sortCanonical(child)])
  );
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freeze(child);
    }
  }
  return value;
}

/** 输出 schema 全量验证，不能过滤掉非法成员后把剩余数据升级为有效裁决。 */
function isTextArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}
