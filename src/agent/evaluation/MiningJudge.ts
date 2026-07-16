import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  options: { readonly maxSlices?: number; readonly maxLines?: number } = {}
): MiningJudgeEvidenceSliceV1[] {
  const maxSlices = options.maxSlices ?? 6;
  const maxLines = options.maxLines ?? 60;
  const reasoning = readRecord(readRecord(candidate).reasoning);
  const sources = Array.isArray(reasoning.sources) ? reasoning.sources : [];
  const slices: MiningJudgeEvidenceSliceV1[] = [];
  for (const source of sources.slice(0, maxSlices)) {
    if (typeof source !== 'string') {
      continue;
    }
    const match = /^(.+?):(\d+)-(\d+)$/u.exec(source.trim());
    if (!match) {
      continue;
    }
    const [, file, startRaw, endRaw] = match;
    const start = Number(startRaw);
    const requestedEnd = Number(endRaw);
    if (!file || !Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) {
      continue;
    }
    const end = Math.min(requestedEnd, start + maxLines - 1);
    try {
      const lines = readFileSync(join(projectRoot, file), 'utf8').split('\n');
      if (start < 1 || start > lines.length) {
        continue;
      }
      const boundedEnd = Math.min(end, lines.length);
      const body = lines
        .slice(start - 1, boundedEnd)
        .map((line, offset) => `${start + offset}|${line}`)
        .join('\n');
      slices.push({ file, start, end: boundedEnd, body });
    } catch (err: unknown) {
      // Missing evidence remains absent; the refute-first reviewer then fails closed.
      if (!(err instanceof Error)) {
        throw new Error('MINING_JUDGE_EVIDENCE_READ_FAILED');
      }
    }
  }
  return slices;
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

export function parseJudgeVerdict(text: unknown): MiningJudgeVerdictV1 | null {
  if (typeof text !== 'string') {
    return null;
  }
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) {
    return null;
  }
  try {
    const parsed = readRecord(JSON.parse(match[0]));
    const verdict = String(parsed.verdict ?? '');
    if (!['uphold', 'narrow', 'trivial', 'reject'].includes(verdict)) {
      return null;
    }
    return {
      entailment: String(parsed.entailment ?? ''),
      trivial: parsed.trivial === true,
      actionable: parsed.actionable === true,
      scopeCorrect: parsed.scopeCorrect === true,
      verdict: verdict as MiningJudgeVerdictV1['verdict'],
      citedLines: Array.isArray(parsed.citedLines)
        ? parsed.citedLines.filter((line): line is string => typeof line === 'string')
        : [],
      reason: String(parsed.reason ?? ''),
    };
  } catch {
    return null;
  }
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
}): Promise<MiningJudgeVerdictV1 | null> {
  const slices = sliceEvidenceForJudge(input.candidate, input.projectRoot);
  const prompt = buildJudgePrompt(input.candidate, slices);
  const verdict = parseJudgeVerdict(await input.chat(prompt));
  if (!verdict) {
    return null;
  }
  return verifyJudgeCitations(verdict, slices)
    ? verdict
    : freeze({ ...verdict, invalidCitation: true as const });
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
  if (!Number.isFinite(input.temperature) || !Number.isSafeInteger(input.maxTokens)) {
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

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortCanonical(value)))
    .digest('hex');
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
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
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
