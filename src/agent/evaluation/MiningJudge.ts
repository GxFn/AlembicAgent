import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveProjectPath } from '../../shared/projectPath.js';
import { hashCanonical } from '../production/strict/primitives.js';

export interface MiningJudgeEvidenceSliceV1 {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

export interface MiningJudgeVerdictV1 {
  readonly entailment: string;
  readonly trivial: boolean;
  readonly actionable: boolean;
  readonly scopeCorrect: boolean;
  readonly verdict: 'uphold' | 'narrow' | 'trivial' | 'reject';
  readonly citedLines: readonly string[];
  readonly reason: string;
  readonly invalidCitation?: true;
}

/**
 * judge 切片跳过原因码（离线评估诊断面，L7-P24 / C44）：
 * - FORMAT：不是字符串、不是 file:N / file:start-end、或行号区间非法（start<1、end<start）；
 * - ABSOLUTE：绝对路径来源，judge 只接受相对项目根的路径；
 * - OUT_OF_RANGE：起始行超出文件行数；
 * - READ_DENIED：项目根边界拒绝（越界、根外 symlink）或操作系统读权限拒绝；
 * - READ_FAILED：文件缺失、是目录等其余读取失败；
 * - LIMIT：已切满 maxSlices（后续来源不再读取），或切片预算本身非法（全部来源短路）。
 */
export type MiningJudgeSliceSkipReasonV1 =
  | 'FORMAT'
  | 'ABSOLUTE'
  | 'OUT_OF_RANGE'
  | 'READ_DENIED'
  | 'READ_FAILED'
  | 'LIMIT';

/** judge 回复解析失败原因码：JSON 缺失/截断、四轴字段缺失或非法、uphold 与四轴自相矛盾。 */
export type MiningJudgeVerdictParseFailureV1 =
  | 'JSON_PARSE'
  | 'FIELD_MISSING'
  | 'VERDICT_AXIS_CONFLICT';

/**
 * judgeCandidate 的可选诊断事件。只供离线评估脚本打印，不进入裁决或校准口径；
 * 'no-readable-slices' 用来把“没有可读证据导致的 reject”与“证据确实被驳倒的 reject”区分开。
 */
export type MiningJudgeDiagnosticV1 =
  | {
      readonly kind: 'slice-skipped';
      readonly source: string;
      readonly reasonCode: MiningJudgeSliceSkipReasonV1;
      readonly detail: string;
    }
  | { readonly kind: 'no-readable-slices'; readonly sourceCount: number }
  | {
      readonly kind: 'verdict-parse-failed';
      readonly reasonCode: MiningJudgeVerdictParseFailureV1;
      readonly detail: string;
    };

export interface JudgeCalibrationRecordV1 {
  readonly humanDecision: 'uphold' | 'narrow' | 'trivial' | 'reject';
  readonly judgeVerdict:
    | (Pick<MiningJudgeVerdictV1, 'verdict'> & { readonly invalidCitation?: boolean })
    | null;
  readonly overgeneralized?: boolean;
}

export interface FrozenJudgeModelLoadReceiptInputV1 {
  readonly selectionMode: 'explicit' | 'producer-reuse' | 'auto-detected' | 'fixture';
  readonly requestedProvider?: string | null;
  readonly requestedModel?: string | null;
  readonly resolvedProvider: string;
  readonly resolvedModel: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly implementationModuleSha256: string;
}

export interface FrozenJudgeModelLoadReceiptV1 {
  readonly kind: 'FrozenJudgeModelLoadReceiptV1';
  readonly schemaVersion: 1;
  readonly selectionMode: FrozenJudgeModelLoadReceiptInputV1['selectionMode'];
  readonly requestedProvider: string | null;
  readonly requestedModel: string | null;
  readonly resolvedProvider: string;
  readonly resolvedModel: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly implementationModuleSha256: string;
  readonly receiptHash: string;
}

/** legacy mining surface: re-slice only the candidate's declared source ranges. */
export function sliceEvidenceForJudge(
  candidate: unknown,
  projectRoot: string,
  options: {
    readonly maxSlices?: number;
    readonly maxLines?: number;
    /** 每个未切出片段的来源回调一次；只做诊断，不改变切片结果。 */
    readonly onSkip?: (
      source: unknown,
      reasonCode: MiningJudgeSliceSkipReasonV1,
      detail: string
    ) => void;
  } = {}
): MiningJudgeEvidenceSliceV1[] {
  const maxSlices = options.maxSlices ?? 6;
  const maxLines = options.maxLines ?? 60;
  if (
    !Number.isSafeInteger(maxSlices) ||
    maxSlices < 1 ||
    !Number.isSafeInteger(maxLines) ||
    maxLines < 1
  ) {
    // 非法切片预算时整体短路为空切片；逐条按 LIMIT 上报，让“预算配置错误”与“来源本身不可用”可区分。
    for (const source of readDeclaredSources(candidate)) {
      options.onSkip?.(
        source,
        'LIMIT',
        `invalid slice budget maxSlices=${maxSlices} maxLines=${maxLines}`
      );
    }
    return [];
  }
  const slices: MiningJudgeEvidenceSliceV1[] = [];
  for (const source of readDeclaredSources(candidate)) {
    // 先过滤后截断：只有真正切出的片段占用 maxSlices 名额，格式错、越界或读不到的来源
    // 不再挤掉后面的合法来源；切满之后的来源按 LIMIT 上报，不再读取文件。
    if (slices.length >= maxSlices) {
      options.onSkip?.(source, 'LIMIT', `slice budget maxSlices=${maxSlices} reached`);
      continue;
    }
    // 读取与分类在 readSourceSlice 内完成，回调放在其 try 之外：调用方回调抛错不会被误归类为读失败。
    const outcome = readSourceSlice(source, projectRoot, maxLines);
    if (outcome.ok) {
      slices.push(outcome.slice);
    } else {
      // Missing evidence remains absent; the refute-first reviewer then fails closed.
      options.onSkip?.(source, outcome.reasonCode, outcome.detail);
    }
  }
  return slices;
}

type SourceSliceOutcome =
  | { readonly ok: true; readonly slice: MiningJudgeEvidenceSliceV1 }
  | {
      readonly ok: false;
      readonly reasonCode: Exclude<MiningJudgeSliceSkipReasonV1, 'LIMIT'>;
      readonly detail: string;
    };

function readSourceSlice(
  source: unknown,
  projectRoot: string,
  maxLines: number
): SourceSliceOutcome {
  if (typeof source !== 'string') {
    return { ok: false, reasonCode: 'FORMAT', detail: `source is ${describeValueType(source)}` };
  }
  // 与 Core SOURCE_REF_RE、recipeProductionAdapter、knowledge sources 解析和 verifyJudgeCitations 同口径：
  // file:N 单行来源合法，缺 end 时按 start 取单行（C17）。scripts/lib/mining-eval-runtime.mjs 的
  // collectSourceFileReceipts 使用同一正则，修改时两处同步。
  const match = /^(.+?):(\d+)(?:-(\d+))?$/u.exec(source.trim());
  if (!match) {
    return { ok: false, reasonCode: 'FORMAT', detail: 'expected file:line or file:start-end' };
  }
  const [, file, startRaw, endRaw] = match;
  const start = Number(startRaw);
  const requestedEnd = endRaw === undefined ? start : Number(endRaw);
  if (
    !file ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 1 ||
    requestedEnd < start
  ) {
    return {
      ok: false,
      reasonCode: 'FORMAT',
      detail: `invalid line range ${start}-${requestedEnd}`,
    };
  }
  if (isAbsolute(file)) {
    return { ok: false, reasonCode: 'ABSOLUTE', detail: 'absolute paths are not project-relative' };
  }
  let lines: string[];
  try {
    const resolved = resolveProjectPath(projectRoot, file);
    lines = readFileSync(resolved.absolute, 'utf8').split('\n');
  } catch (err: unknown) {
    if (!(err instanceof Error)) {
      // 文件端口只应抛 Error；非 Error 视为不变量破坏，保留原值作 cause 后中止本候选的裁决。
      throw new Error('MINING_JUDGE_EVIDENCE_READ_FAILED', { cause: err });
    }
    return { ok: false, reasonCode: classifyReadError(err), detail: describeReadError(err) };
  }
  if (start > lines.length) {
    return {
      ok: false,
      reasonCode: 'OUT_OF_RANGE',
      detail: `start line ${start} exceeds ${lines.length} lines`,
    };
  }
  const boundedEnd = Math.min(requestedEnd, start + maxLines - 1, lines.length);
  const body = lines
    .slice(start - 1, boundedEnd)
    .map((line, offset) => `${start + offset}|${line}`)
    .join('\n');
  return { ok: true, slice: { file, start, end: boundedEnd, body } };
}

/**
 * resolveProjectPath 的根目录边界拒绝（越界、根外 symlink、悬空 symlink）统一以 'Access denied'
 * 开头且不带 fs code；EACCES/EPERM 是操作系统层面的读权限拒绝。两者归为 READ_DENIED，
 * 其余（ENOENT、EISDIR 等）归为 READ_FAILED。
 */
function classifyReadError(err: Error): 'READ_DENIED' | 'READ_FAILED' {
  const code = readErrorCode(err);
  if (code === 'EACCES' || code === 'EPERM' || err.message.startsWith('Access denied')) {
    return 'READ_DENIED';
  }
  return 'READ_FAILED';
}

/** fs 错误的 message 带本机绝对路径，诊断只回报错误码；边界拒绝的 message 本身不含路径。 */
function describeReadError(err: Error): string {
  return readErrorCode(err) ?? err.message;
}

function readErrorCode(err: Error): string | null {
  return 'code' in err && typeof err.code === 'string' ? err.code : null;
}

function readDeclaredSources(candidate: unknown): readonly unknown[] {
  const reasoning = readRecord(readRecord(candidate).reasoning);
  return Array.isArray(reasoning.sources) ? reasoning.sources : [];
}

function describeValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/** Context-isolated four-axis prompt retained for the existing mining evaluator. */
export function buildJudgePrompt(
  candidate: unknown,
  slices: readonly MiningJudgeEvidenceSliceV1[]
): string {
  const record = readRecord(candidate);
  const content = readRecord(record.content);
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
    `title: ${String(record.title ?? '')}`,
    `kind: ${String(record.kind ?? '')}`,
    `doClause: ${String(record.doClause ?? '')}`,
    `dontClause: ${String(record.dontClause ?? '')}`,
    `claim body:\n${String(content.markdown ?? '').slice(0, 2400)}`,
    '',
    '=== VERBATIM SOURCE SLICES ===',
    sliceBlocks || '(no readable slices — treat as insufficient evidence)',
  ].join('\n');
}

const JUDGE_VERDICTS = ['uphold', 'narrow', 'trivial', 'reject'] as const;
const JUDGE_ENTAILMENTS = ['entailed', 'partial', 'not_entailed'] as const;

export function parseJudgeVerdict(
  text: unknown,
  options: {
    /** 解析失败时回调一次原因码；只做诊断，返回值仍是保守的 null。 */
    readonly onFailure?: (reasonCode: MiningJudgeVerdictParseFailureV1, detail: string) => void;
  } = {}
): MiningJudgeVerdictV1 | null {
  const rejectVerdict = (reasonCode: MiningJudgeVerdictParseFailureV1, detail: string): null => {
    options.onFailure?.(reasonCode, detail.slice(0, 200));
    return null;
  };
  if (typeof text !== 'string') {
    return rejectVerdict('JSON_PARSE', `response is ${describeValueType(text)}, not text`);
  }
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) {
    return rejectVerdict('JSON_PARSE', 'no JSON object in response');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch (err: unknown) {
    // 截断或夹杂非 JSON 文本：保留解析器消息，便于区分输出截断与格式漂移。
    return rejectVerdict('JSON_PARSE', err instanceof Error ? err.message : String(err));
  }
  const parsed = readRecord(raw);
  // 四轴是既有输出合同，不用类型转换/过滤把不完整裁决“修成”有效结果。
  const verdict = JUDGE_VERDICTS.find((value) => value === parsed.verdict);
  const entailment = JUDGE_ENTAILMENTS.find((value) => value === parsed.entailment);
  const trivial = typeof parsed.trivial === 'boolean' ? parsed.trivial : undefined;
  const actionable = typeof parsed.actionable === 'boolean' ? parsed.actionable : undefined;
  const scopeCorrect = typeof parsed.scopeCorrect === 'boolean' ? parsed.scopeCorrect : undefined;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
  const rawCitedLines: unknown = parsed.citedLines;
  const citedLines =
    Array.isArray(rawCitedLines) &&
    rawCitedLines.every((line): line is string => typeof line === 'string' && line.trim() !== '')
      ? rawCitedLines
      : undefined;
  if (
    verdict === undefined ||
    entailment === undefined ||
    trivial === undefined ||
    actionable === undefined ||
    scopeCorrect === undefined ||
    reason === undefined ||
    citedLines === undefined
  ) {
    const invalidFields = Object.entries({
      verdict,
      entailment,
      trivial,
      actionable,
      scopeCorrect,
      citedLines,
      reason,
    })
      .filter(([, value]) => value === undefined)
      .map(([field]) => field);
    return rejectVerdict('FIELD_MISSING', `missing or invalid: ${invalidFields.join(', ')}`);
  }
  if (
    verdict === 'uphold' &&
    (entailment !== 'entailed' || trivial || !actionable || !scopeCorrect)
  ) {
    return rejectVerdict(
      'VERDICT_AXIS_CONFLICT',
      `uphold contradicts axes: entailment=${entailment} trivial=${trivial} actionable=${actionable} scopeCorrect=${scopeCorrect}`
    );
  }
  return { entailment, trivial, actionable, scopeCorrect, verdict, citedLines, reason };
}

export function verifyJudgeCitations(
  verdict: Pick<MiningJudgeVerdictV1, 'citedLines'> | null,
  slices: readonly MiningJudgeEvidenceSliceV1[]
): boolean {
  if (!verdict || verdict.citedLines.length === 0) {
    return false;
  }
  return verdict.citedLines.every((cited) => {
    const match = /^(.+?):(\d+)(?:-(\d+))?$/u.exec(cited.trim());
    if (!match) {
      return false;
    }
    const [, file, startRaw, endRaw] = match;
    const start = Number(startRaw);
    const end = endRaw ? Number(endRaw) : start;
    if (!file || end < start) {
      return false;
    }
    return slices.some((slice) => slice.file === file && start >= slice.start && end <= slice.end);
  });
}

export async function judgeCandidate(input: {
  readonly candidate: unknown;
  readonly projectRoot: string;
  readonly chat: (prompt: string) => Promise<string>;
  /** 可选诊断回调：被跳过的来源、无可读切片、裁决解析失败逐条上报，不改变裁决结果。 */
  readonly onDiagnostic?: (diagnostic: MiningJudgeDiagnosticV1) => void;
}): Promise<MiningJudgeVerdictV1 | null> {
  const report = input.onDiagnostic;
  const slices = sliceEvidenceForJudge(input.candidate, input.projectRoot, {
    onSkip: (source, reasonCode, detail) =>
      report?.(
        freeze({ kind: 'slice-skipped', source: describeSource(source), reasonCode, detail })
      ),
  });
  if (slices.length === 0) {
    // 提示里会写“no readable slices”，judge 按规则倾向 reject；单独上报，
    // 让报告能把“缺证据的 reject”与“证据被驳倒的 reject”分开。
    report?.(
      freeze({
        kind: 'no-readable-slices',
        sourceCount: readDeclaredSources(input.candidate).length,
      })
    );
  }
  const prompt = buildJudgePrompt(input.candidate, slices);
  const verdict = parseJudgeVerdict(await input.chat(prompt), {
    onFailure: (reasonCode, detail) =>
      report?.(freeze({ kind: 'verdict-parse-failed', reasonCode, detail })),
  });
  if (!verdict) {
    return null;
  }
  return verifyJudgeCitations(verdict, slices)
    ? verdict
    : freeze({ ...verdict, invalidCitation: true as const });
}

/** 诊断里的来源统一成可打印字符串；非字符串来源用 JSON 表示，便于在日志里定位原值。 */
function describeSource(source: unknown): string {
  if (typeof source === 'string') {
    return source;
  }
  try {
    return JSON.stringify(source) ?? String(source);
  } catch (err: unknown) {
    // BigInt、循环引用等无法 JSON 化的来源只记录类型：诊断本身不能让裁决中断。
    const errorName = err instanceof Error ? err.name : 'unknown error';
    return `<unserializable ${describeValueType(source)}: ${errorName}>`;
  }
}

/** 人工复核结论的合法取值（与 JudgeCalibrationRecordV1.humanDecision 类型一致）。 */
const JUDGE_CALIBRATION_HUMAN_DECISIONS: ReadonlySet<unknown> = new Set([
  'uphold',
  'narrow',
  'trivial',
  'reject',
]);

/**
 * 晋级门的覆盖率下限（L7-P25 / C16，默认 0.9）：
 * - 有效裁决覆盖率 = 有效裁决数 / 全部样本数；
 * - 负例有效覆盖率 = 有效裁决的人工负例数 / 全部人工负例数（人工负例 = humanDecision !== 'uphold'，
 *   含 judge 解析失败返回 null 与 invalidCitation 的记录）。
 * 无效裁决仍不进入一致率、kappa、负类召回的分母（既有口径），但无效集中出现时
 * （尤其集中在负例、掩盖 judge 错放负例）由这两道门挡住，不能靠剔除难例晋级。
 * 门限暂为模块内常量；返回 coverage 字段与 options 可配置项待决策确认后再开放到公开面。
 */
const JUDGE_CALIBRATION_MIN_COVERAGE = 0.9;
const JUDGE_CALIBRATION_MIN_NEGATIVE_COVERAGE = 0.9;
/** 非法标签报错里最多逐条列出的记录数，避免整份脏导出把错误消息撑爆。 */
const JUDGE_CALIBRATION_INVALID_LABEL_LIST_LIMIT = 10;

/**
 * 入口校验人工标签：离线标注错误必须立即修数据，不能被静默当成负例
 * （拼错的 'upheld' 或缺失标签曾被计入负例，既拉低召回也可能虚增负例数凑够 minNegatives）。
 * 一次列出全部非法记录（上限见常量）的索引与原值，便于一次修完导出文件。
 */
function assertJudgeCalibrationHumanDecisions(records: readonly unknown[]): void {
  const invalid: string[] = [];
  for (const [index, record] of records.entries()) {
    const humanDecision = readRecord(record).humanDecision;
    if (!JUDGE_CALIBRATION_HUMAN_DECISIONS.has(humanDecision)) {
      invalid.push(`records[${index}]=${describeHumanDecision(humanDecision)}`);
    }
  }
  if (invalid.length === 0) {
    return;
  }
  const listed = invalid.slice(0, JUDGE_CALIBRATION_INVALID_LABEL_LIST_LIMIT);
  const omitted = invalid.length - listed.length;
  throw new Error(
    `JUDGE_CALIBRATION_HUMAN_DECISION_INVALID:count=${invalid.length};${listed.join(',')}${
      omitted > 0 ? `,...+${omitted} more` : ''
    }`
  );
}

/** 字符串标签加引号显示（区分空串与缺失），其余值沿用来源诊断的可打印化，并截断过长原值。 */
function describeHumanDecision(value: unknown): string {
  const described = typeof value === 'string' ? JSON.stringify(value) : describeSource(value);
  return described.length > 80 ? `${described.slice(0, 77)}...` : described;
}

/** One production-owned implementation for both strict evaluation and legacy mining scripts. */
export function computeJudgeCalibration(
  records: readonly JudgeCalibrationRecordV1[],
  options: {
    readonly promotionFloor?: number;
    readonly kappaFloor?: number;
    readonly negativeRecallFloor?: number;
    readonly minNegatives?: number;
  } = {}
) {
  // 先校验标签再计算：非法标签抛 JUDGE_CALIBRATION_HUMAN_DECISION_INVALID，不做静默降级。
  assertJudgeCalibrationHumanDecisions(records);
  const promotionFloor = options.promotionFloor ?? 0.8;
  const kappaFloor = options.kappaFloor ?? 0.6;
  const negativeRecallFloor = options.negativeRecallFloor ?? 0.6;
  const minNegatives = options.minNegatives ?? 5;
  const judged = records.filter(
    (record) => record.judgeVerdict?.verdict && !record.judgeVerdict.invalidCitation
  ) as readonly (JudgeCalibrationRecordV1 & {
    judgeVerdict: NonNullable<JudgeCalibrationRecordV1['judgeVerdict']>;
  })[];
  const humanKeep = (record: JudgeCalibrationRecordV1) => record.humanDecision === 'uphold';
  const judgeKeep = (record: (typeof judged)[number]) => record.judgeVerdict.verdict === 'uphold';
  const agreed = judged.filter((record) => humanKeep(record) === judgeKeep(record));
  const exact = judged.filter((record) => record.humanDecision === record.judgeVerdict.verdict);
  const overgen = judged.filter((record) => record.overgeneralized === true);
  const overgenAgreed = overgen.filter((record) => !judgeKeep(record));
  const agreementRate = judged.length > 0 ? agreed.length / judged.length : null;
  const overgenRate = overgen.length > 0 ? overgenAgreed.length / overgen.length : null;
  let kappa: number | null = null;
  if (agreementRate !== null) {
    const pKeepHuman = judged.filter(humanKeep).length / judged.length;
    const pKeepJudge = judged.filter(judgeKeep).length / judged.length;
    const chance = pKeepHuman * pKeepJudge + (1 - pKeepHuman) * (1 - pKeepJudge);
    kappa = chance === 1 ? null : (agreementRate - chance) / (1 - chance);
  }
  const negatives = judged.filter((record) => !humanKeep(record));
  const negativesCaught = negatives.filter((record) => !judgeKeep(record));
  const negativeRecall = negatives.length > 0 ? negativesCaught.length / negatives.length : null;
  // 覆盖率只参与晋级判定，不改变上面各比例的分母；全部样本/全部人工负例为 0 时记为 null（不过门）。
  const coverage = records.length > 0 ? judged.length / records.length : null;
  const humanNegativeTotal = records.filter((record) => !humanKeep(record)).length;
  const negativeCoverage = humanNegativeTotal > 0 ? negatives.length / humanNegativeTotal : null;
  const coverageSufficient =
    coverage !== null &&
    coverage >= JUDGE_CALIBRATION_MIN_COVERAGE &&
    negativeCoverage !== null &&
    negativeCoverage >= JUDGE_CALIBRATION_MIN_NEGATIVE_COVERAGE;
  return freeze({
    total: records.length,
    judged: judged.length,
    agreementRate,
    kappa,
    negativeSubset: {
      total: negatives.length,
      caught: negativesCaught.length,
      recall: negativeRecall,
    },
    exactRate: judged.length > 0 ? exact.length / judged.length : null,
    overgenSubset: { total: overgen.length, agreed: overgenAgreed.length, rate: overgenRate },
    selfBiasSignal: overgenRate !== null && overgenRate < promotionFloor,
    promotionEligible:
      agreementRate !== null &&
      agreementRate >= promotionFloor &&
      judged.length >= 30 &&
      kappa !== null &&
      kappa >= kappaFloor &&
      negatives.length >= minNegatives &&
      negativeRecall !== null &&
      negativeRecall >= negativeRecallFloor &&
      coverageSufficient &&
      !(overgenRate !== null && overgenRate < promotionFloor),
  });
}

export function createFrozenJudgeModelLoadReceiptV1(
  input: FrozenJudgeModelLoadReceiptInputV1
): FrozenJudgeModelLoadReceiptV1 {
  const requestedProvider = normalizeOptionalText(input.requestedProvider);
  const requestedModel = normalizeOptionalText(input.requestedModel);
  const resolvedProvider = requireText(input.resolvedProvider, 'JUDGE_MODEL_PROVIDER_REQUIRED');
  const resolvedModel = requireText(input.resolvedModel, 'JUDGE_MODEL_REQUIRED');
  if (
    !Number.isFinite(input.temperature) ||
    !Number.isSafeInteger(input.maxTokens) ||
    input.maxTokens <= 0
  ) {
    fail('JUDGE_MODEL_PARAMETERS_INVALID');
  }
  if (!/^[a-f0-9]{64}$/u.test(input.implementationModuleSha256)) {
    fail('JUDGE_MODEL_IMPLEMENTATION_HASH_INVALID');
  }
  if (input.selectionMode === 'explicit') {
    if (!requestedProvider || !requestedModel) {
      fail('JUDGE_MODEL_EXPLICIT_PAIR_REQUIRED');
    }
    if (requestedProvider !== resolvedProvider || requestedModel !== resolvedModel) {
      fail('JUDGE_MODEL_EXPLICIT_RESOLUTION_MISMATCH');
    }
  }
  if (
    (input.selectionMode === 'producer-reuse' || input.selectionMode === 'fixture') &&
    (requestedProvider !== resolvedProvider || requestedModel !== resolvedModel)
  ) {
    fail('JUDGE_MODEL_REUSED_RESOLUTION_MISMATCH');
  }
  const semantic = {
    kind: 'FrozenJudgeModelLoadReceiptV1' as const,
    schemaVersion: 1 as const,
    selectionMode: input.selectionMode,
    requestedProvider,
    requestedModel,
    resolvedProvider,
    resolvedModel,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    implementationModuleSha256: input.implementationModuleSha256,
  };
  // receiptHash = `sha256:` + 仓内唯一规范哈希的裸 hex（primitives.hashCanonical）。原私有副本在排序前
  // 显式丢弃值为 undefined 的键，共享实现保留该键再由 JSON.stringify 省略，序列化字节相同；W1-10 按
  // 事项⑥（只收敛副本、不改排序）收敛，逐字节等价由 test/strict-canonical-golden.test.ts 钉住。
  return freeze({ ...semantic, receiptHash: `sha256:${hashCanonical(semantic)}` });
}

export function assertFrozenJudgeModelLoadReceiptV1(
  receipt: FrozenJudgeModelLoadReceiptV1,
  current: { readonly resolvedProvider: string; readonly resolvedModel: string }
): void {
  const { kind, schemaVersion, receiptHash, ...input } = receipt;
  if (kind !== 'FrozenJudgeModelLoadReceiptV1' || schemaVersion !== 1) {
    fail('JUDGE_MODEL_RECEIPT_VERSION_MISMATCH');
  }
  const rebuilt = createFrozenJudgeModelLoadReceiptV1(input);
  if (rebuilt.receiptHash !== receiptHash) {
    fail('JUDGE_MODEL_RECEIPT_HASH_MISMATCH');
  }
  if (
    receipt.resolvedProvider !== current.resolvedProvider ||
    receipt.resolvedModel !== current.resolvedModel
  ) {
    fail('JUDGE_MODEL_SELECTION_DRIFT');
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    fail(code);
  }
  return value.trim();
}

function fail(code: string): never {
  throw new Error(code);
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
