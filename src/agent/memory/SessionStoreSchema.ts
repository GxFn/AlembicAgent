/**
 * SessionStore 序列化校验
 *
 * `SessionStore.fromJSON()` 的反序列化入口，对边界数据做轻量类型校验。
 *
 * @module agent/memory/SessionStoreSchema
 */

import type {
  CandidateSummary,
  CrossReference,
  DimensionDigest,
  DimensionReport,
  Finding,
  TierReflection,
  WorkingMemoryDistilled,
} from './SessionStore.js';

// ── Serialized Shape ─────────────────────────────────────────

export interface SessionStoreSerialized {
  dimensionReports: Record<string, DimensionReport>;
  crossReferences: CrossReference[];
  tierReflections: TierReflection[];
  submittedCandidates: Record<string, CandidateSummary[]>;
  projectContext: Record<string, unknown>;
  workingMemory?: WorkingMemoryDistilled;
  evidenceStore?: Record<string, Finding[]>;
}

// ── Helpers ──────────────────────────────────────────────────

function isRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

// ── Public API ───────────────────────────────────────────────

/**
 * 校验反序列化数据的关键字段类型，返回类型安全的结构。
 */
export function validateSessionStoreShape(raw: Record<string, unknown>): SessionStoreSerialized {
  if (!isRecord(raw)) {
    throw new Error('SessionStore schema: snapshot must be an object');
  }
  if (raw.dimensionReports !== undefined && !isRecord(raw.dimensionReports)) {
    throw new Error('SessionStore schema: dimensionReports must be a Record');
  }
  if (raw.crossReferences !== undefined && !Array.isArray(raw.crossReferences)) {
    throw new Error('SessionStore schema: crossReferences must be an array');
  }
  if (raw.tierReflections !== undefined && !Array.isArray(raw.tierReflections)) {
    throw new Error('SessionStore schema: tierReflections must be an array');
  }
  if (raw.submittedCandidates !== undefined && !isRecord(raw.submittedCandidates)) {
    throw new Error('SessionStore schema: submittedCandidates must be a Record');
  }
  const reports: Record<string, DimensionReport> = Object.create(null);
  for (const [id, value] of Object.entries(raw.dimensionReports ?? {})) {
    if (!isRecord(value)) {
      throw new Error(`SessionStore schema: invalid dimension report ${id}`);
    }
    const findings = validateFindings(
      value.findings === undefined ? [] : value.findings,
      `dimensionReports.${id}.findings`
    );
    const referencedFiles = value.referencedFiles === undefined ? [] : value.referencedFiles;
    if (
      !Array.isArray(referencedFiles) ||
      !referencedFiles.every((file) => typeof file === 'string')
    ) {
      throw new Error(`SessionStore schema: invalid referencedFiles for ${id}`);
    }
    reports[id] = {
      ...value,
      dimId: typeof value.dimId === 'string' ? value.dimId : id,
      completedAt: typeof value.completedAt === 'number' ? value.completedAt : 0,
      analysisText: typeof value.analysisText === 'string' ? value.analysisText : '',
      findings,
      referencedFiles,
      candidatesSummary: validateCandidates(
        value.candidatesSummary ?? [],
        `dimensionReports.${id}.candidatesSummary`
      ),
      workingMemoryDistilled: validateWorkingMemory(value.workingMemoryDistilled) ?? null,
      digest: validateDigest(value.digest),
    } as DimensionReport;
  }
  const submittedCandidates: Record<string, CandidateSummary[]> = Object.create(null);
  for (const [id, value] of Object.entries(raw.submittedCandidates ?? {})) {
    submittedCandidates[id] = validateCandidates(value, `submittedCandidates.${id}`);
  }
  let evidenceStore: Record<string, Finding[]> | undefined;
  if (raw.evidenceStore !== undefined) {
    if (!isRecord(raw.evidenceStore)) {
      throw new Error('SessionStore schema: evidenceStore must be a Record');
    }
    evidenceStore = Object.create(null) as Record<string, Finding[]>;
    for (const [file, value] of Object.entries(raw.evidenceStore)) {
      evidenceStore[file] = validateFindings(value, `evidenceStore.${file}`);
    }
  }
  return structuredClone({
    dimensionReports: reports,
    crossReferences: validateRecords(raw.crossReferences ?? [], 'crossReferences').map((value) => {
      validateStringFields(value, ['from', 'to', 'relation', 'detail'], 'crossReferences');
      return { from: '', to: '', relation: '', detail: '', ...value } as CrossReference;
    }),
    tierReflections: validateRecords(raw.tierReflections ?? [], 'tierReflections').map((value) => {
      validateNumberFields(value, ['tierIndex'], 'tierReflections');
      return {
        ...value,
        tierIndex: value.tierIndex ?? 0,
        completedDimensions: validateStrings(
          value.completedDimensions ?? [],
          'completedDimensions'
        ),
        topFindings: validateFindings(value.topFindings ?? [], 'tierReflections.topFindings'),
        crossDimensionPatterns: validateStrings(
          value.crossDimensionPatterns ?? [],
          'crossDimensionPatterns'
        ),
        suggestionsForNextTier: validateStrings(
          value.suggestionsForNextTier ?? [],
          'suggestionsForNextTier'
        ),
      } as TierReflection;
    }),
    submittedCandidates,
    ...(evidenceStore !== undefined ? { evidenceStore } : {}),
    projectContext: isRecord(raw.projectContext)
      ? (raw.projectContext as Record<string, unknown>)
      : {},
    workingMemory: validateWorkingMemory(raw.workingMemory),
  });
}

function validateRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`SessionStore schema: ${label} must contain objects`);
  }
  return value;
}

function validateFindings(value: unknown, label: string): Finding[] {
  return validateRecords(value, label).map((finding) => {
    validateStringFields(finding, ['dimId'], label);
    validateNumberFields(finding, ['timestamp'], label);
    if (
      typeof finding.finding !== 'string' ||
      (finding.evidence !== undefined && typeof finding.evidence !== 'string') ||
      (finding.importance !== undefined &&
        (typeof finding.importance !== 'number' || !Number.isFinite(finding.importance)))
    ) {
      throw new Error(`SessionStore schema: invalid finding in ${label}`);
    }
    return { ...finding, importance: finding.importance ?? 5 } as Finding;
  });
}

function validateStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`SessionStore schema: ${label} must contain strings`);
  }
  return value;
}

function validateStringFields(value: Record<string, unknown>, keys: string[], label: string) {
  if (keys.some((key) => value[key] !== undefined && typeof value[key] !== 'string')) {
    throw new Error(`SessionStore schema: invalid string in ${label}`);
  }
}

function validateNumberFields(value: Record<string, unknown>, keys: string[], label: string) {
  if (
    keys.some(
      (key) =>
        value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
    )
  ) {
    throw new Error(`SessionStore schema: invalid number in ${label}`);
  }
}

function validateCandidates(value: unknown, label: string): CandidateSummary[] {
  return validateRecords(value, label).map((item) => {
    validateStringFields(item, ['dimId', 'title', 'subTopic', 'summary'], label);
    return { dimId: '', title: '', subTopic: '', summary: '', ...item } as CandidateSummary;
  });
}

function validateWorkingMemory(value: unknown): WorkingMemoryDistilled | undefined {
  if (value == null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('SessionStore schema: workingMemory must be an object');
  }
  const result = { ...value };
  if (value.keyFindings !== undefined) {
    result.keyFindings = validateFindings(value.keyFindings, 'workingMemory.keyFindings');
  }
  if (value.toolCallSummary !== undefined) {
    if (
      !Array.isArray(value.toolCallSummary) ||
      !value.toolCallSummary.every(
        (item) =>
          typeof item === 'string' ||
          (isRecord(item) && typeof item.tool === 'string' && typeof item.summary === 'string')
      )
    ) {
      throw new Error('SessionStore schema: invalid workingMemory.toolCallSummary');
    }
  }
  if (value.plan != null && !isRecord(value.plan)) {
    throw new Error('SessionStore schema: invalid workingMemory.plan');
  }
  if (value.stats !== undefined) {
    if (!isRecord(value.stats)) {
      throw new Error('SessionStore schema: invalid workingMemory.stats');
    }
    validateNumberFields(value.stats, Object.keys(value.stats), 'workingMemory.stats');
  }
  validateNumberFields(value, ['totalObservations', 'compressedCount'], 'workingMemory');
  return result as WorkingMemoryDistilled;
}

function validateDigest(value: unknown): DimensionDigest | null {
  if (value == null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('SessionStore schema: digest must be an object');
  }
  validateStringFields(value, ['summary'], 'digest');
  validateNumberFields(value, ['candidateCount'], 'digest');
  const result = { ...value };
  if (value.keyFindings !== undefined) {
    if (!Array.isArray(value.keyFindings)) {
      throw new Error('SessionStore schema: invalid digest.keyFindings');
    }
    result.keyFindings = value.keyFindings.map((item) =>
      typeof item === 'string' ? item : validateFindings([item], 'digest.keyFindings')[0]
    );
  }
  if (value.gaps !== undefined) {
    result.gaps = validateStrings(value.gaps, 'digest.gaps');
  }
  if (value.crossRefs !== undefined) {
    if (!isRecord(value.crossRefs)) {
      throw new Error('SessionStore schema: invalid digest.crossRefs');
    }
    validateStringFields(value.crossRefs, Object.keys(value.crossRefs), 'digest.crossRefs');
  }
  return result as DimensionDigest;
}
