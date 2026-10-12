/**
 * SessionStore 序列化校验与写入口归一化
 *
 * 两类入口共用同一套形状规则，保证“写得进去的状态一定读得回来”：
 *   - 快照入口（`SessionStore.fromJSON()` / `loadCheckpoint()` / `storeDimensionReport()`）走
 *     `validateSessionStoreShape`：字段缺失补默认值（兼容旧快照），字段存在但类型错误一律抛 Error，
 *     不再静默改写成默认值。
 *   - 单项写入口（`addDimensionDigest()` / `addTierReflection()`）的数据来自 AI 回复或宿主未校验的
 *     dimension checkpoint，走 `normalizeDimensionDigest` / `normalizeTierReflection`：可修复的偏离
 *     归一化（丢弃或置默认）并逐项返回降级记录交给调用方告警；无法归一化（整体不是对象）时抛 Error。
 *     归一化结果最后再过一遍快照规则，确保入库状态能通过自身 fromJSON。
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

/**
 * 单项写入口的一次降级记录：字段路径、原始类型和采取的动作。
 * Schema 本身不持有 logger，由 SessionStore 汇总成一条 warn（含 dimId / tier）。
 */
export interface SessionStoreNormalization {
  /** 字段路径，例如 `digest.crossRefs.b`、`tierReflection.topFindings[2]` */
  field: string;
  /** 原始值类型：null / array / typeof 结果 */
  rawType: string;
  /** dropped = 丢弃该键或数组项；defaulted = 整个字段替换为默认值 */
  action: 'dropped' | 'defaulted';
}

// ── Helpers ──────────────────────────────────────────────────

function isRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function isFiniteNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

/** 诊断用的类型描述：区分 null 与 array，其余沿用 typeof。 */
function describeType(val: unknown): string {
  if (val === null) {
    return 'null';
  }
  return Array.isArray(val) ? 'array' : typeof val;
}

function hasOptionalStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'string');
}

function hasOptionalFiniteNumbers(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] === undefined || isFiniteNumber(value[key]));
}

/**
 * 单条 finding 的形状规则。快照校验（validateFindings，不合规即抛错）和 digest/反思归一化
 * （不合规即丢弃并告警）共用这一处，避免两条路径对“合法 finding”的理解漂移。
 */
function isValidFinding(value: unknown): value is Record<string, unknown> & { finding: string } {
  return (
    isRecord(value) &&
    typeof value.finding === 'string' &&
    hasOptionalStrings(value, ['evidence', 'dimId', 'reportDimId']) &&
    hasOptionalFiniteNumbers(value, ['importance', 'timestamp'])
  );
}

// ── Public API ───────────────────────────────────────────────

/**
 * 校验反序列化数据的关键字段类型，返回类型安全的结构。
 *
 * 规则：字段缺失（undefined）补默认值以兼容旧快照；字段存在但类型错误时抛 Error，
 * 不再静默改写（被截断或损坏的快照必须显式失败，而不是“成功”恢复成空报告）。
 * 维度报告的 dimId 必须与所在键一致，否则 getDimensionReport(key) 会返回另一个维度名。
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
  if (raw.projectContext !== undefined && !isRecord(raw.projectContext)) {
    throw new Error('SessionStore schema: projectContext must be a Record');
  }
  const reports: Record<string, DimensionReport> = Object.create(null);
  for (const [id, value] of Object.entries(raw.dimensionReports ?? {})) {
    reports[id] = validateDimensionReport(id, value);
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
    tierReflections: validateRecords(raw.tierReflections ?? [], 'tierReflections').map(
      validateTierReflection
    ),
    submittedCandidates,
    ...(evidenceStore !== undefined ? { evidenceStore } : {}),
    projectContext: isRecord(raw.projectContext) ? raw.projectContext : {},
    workingMemory: validateWorkingMemory(raw.workingMemory),
  });
}

/**
 * 单个维度 digest 的写入口归一化（addDimensionDigest 使用）。
 *
 * digest 来自宿主 parseDimensionDigest 透传的 AI 回复，或宿主未校验的 dimension checkpoint；
 * 偏离格式时按以下规则修复，每次修复都记一条 SessionStoreNormalization：
 *   - summary 非字符串 → ''（defaulted）
 *   - candidateCount 非有限数字 → 删除该键（dropped）
 *   - keyFindings 非数组 → []（defaulted）；数组中既非字符串也非合法 Finding 的项丢弃（dropped）
 *   - gaps 非数组 → []（defaulted）；非字符串项丢弃（dropped）
 *   - crossRefs 非 Record → {}（defaulted）；值非字符串的键丢弃（dropped），避免 prompt 出现 [object Object]
 * 其余扩展字段（如 remainingTasks）原样保留。整体不是对象时无法归一化，抛 Error。
 */
export function normalizeDimensionDigest(value: unknown): {
  digest: DimensionDigest;
  normalizations: SessionStoreNormalization[];
} {
  if (!isRecord(value)) {
    throw new Error(
      `SessionStore schema: digest must be an object (received ${describeType(value)})`
    );
  }
  const normalizations: SessionStoreNormalization[] = [];
  const note = (field: string, raw: unknown, action: SessionStoreNormalization['action']) => {
    normalizations.push({ field, rawType: describeType(raw), action });
  };
  // 对象展开使用 CreateDataProperty，`__proto__` 之类的键只会成为普通自有属性。
  const digest: Record<string, unknown> = { ...value };
  if (value.summary !== undefined && typeof value.summary !== 'string') {
    note('digest.summary', value.summary, 'defaulted');
    digest.summary = '';
  }
  if (value.candidateCount !== undefined && !isFiniteNumber(value.candidateCount)) {
    note('digest.candidateCount', value.candidateCount, 'dropped');
    delete digest.candidateCount;
  }
  if (value.keyFindings !== undefined) {
    if (Array.isArray(value.keyFindings)) {
      digest.keyFindings = value.keyFindings.flatMap((item: unknown, index: number) => {
        if (typeof item === 'string' || isValidFinding(item)) {
          return [item];
        }
        note(`digest.keyFindings[${index}]`, item, 'dropped');
        return [];
      });
    } else {
      note('digest.keyFindings', value.keyFindings, 'defaulted');
      digest.keyFindings = [];
    }
  }
  if (value.gaps !== undefined) {
    digest.gaps = normalizeStrings(value.gaps, 'digest.gaps', note);
  }
  if (value.crossRefs !== undefined) {
    if (isRecord(value.crossRefs)) {
      digest.crossRefs = Object.fromEntries(
        Object.entries(value.crossRefs).filter(([target, detail]) => {
          if (typeof detail === 'string') {
            return true;
          }
          note(`digest.crossRefs.${target}`, detail, 'dropped');
          return false;
        })
      );
    } else {
      note('digest.crossRefs', value.crossRefs, 'defaulted');
      digest.crossRefs = {};
    }
  }
  // 归一化结果再过一遍快照规则：任何遗漏都在写入前暴露为 Error，而不是写出 fromJSON 会拒绝的状态。
  return { digest: validateDigestRecord(digest), normalizations };
}

/**
 * 单条 Tier 反思的写入口归一化（addTierReflection 使用）。
 *
 * 反思通常由宿主规则化聚合生成，但 addTierReflection 是公开写入口，同样不能绕过 schema：
 *   - tierIndex 缺失或非有限数字 → 使用调用方传入的 fallbackTierIndex（defaulted）
 *   - completedDimensions / crossDimensionPatterns / suggestionsForNextTier 非数组 → []（defaulted），
 *     非字符串项丢弃（dropped）
 *   - topFindings 非数组 → []（defaulted），非法 Finding 项丢弃（dropped）
 * 整体不是对象，或 tierIndex 无从得到有限数字时抛 Error。
 */
export function normalizeTierReflection(
  value: unknown,
  fallbackTierIndex: number
): { reflection: TierReflection; normalizations: SessionStoreNormalization[] } {
  if (!isRecord(value)) {
    throw new Error(
      `SessionStore schema: tier reflection must be an object (received ${describeType(value)})`
    );
  }
  const normalizations: SessionStoreNormalization[] = [];
  const note = (field: string, raw: unknown, action: SessionStoreNormalization['action']) => {
    normalizations.push({ field, rawType: describeType(raw), action });
  };
  const reflection: Record<string, unknown> = { ...value };
  if (!isFiniteNumber(value.tierIndex)) {
    if (!isFiniteNumber(fallbackTierIndex)) {
      throw new Error('SessionStore schema: tier reflection requires a finite tierIndex');
    }
    note('tierReflection.tierIndex', value.tierIndex, 'defaulted');
    reflection.tierIndex = fallbackTierIndex;
  }
  for (const key of ['completedDimensions', 'crossDimensionPatterns', 'suggestionsForNextTier']) {
    reflection[key] = normalizeStrings(value[key], `tierReflection.${key}`, note);
  }
  if (Array.isArray(value.topFindings)) {
    reflection.topFindings = value.topFindings.filter((item: unknown, index: number) => {
      if (isValidFinding(item)) {
        return true;
      }
      note(`tierReflection.topFindings[${index}]`, item, 'dropped');
      return false;
    });
  } else {
    note('tierReflection.topFindings', value.topFindings, 'defaulted');
    reflection.topFindings = [];
  }
  return { reflection: validateTierReflection(reflection), normalizations };
}

/**
 * 字符串数组归一化：非数组（含缺失）→ []，非字符串项丢弃。缺失也记录，
 * 因为调用方（反思）的类型要求该字段必填；digest 的可选字段在调用前已按 undefined 跳过。
 */
function normalizeStrings(
  value: unknown,
  label: string,
  note: (field: string, raw: unknown, action: SessionStoreNormalization['action']) => void
): string[] {
  if (!Array.isArray(value)) {
    note(label, value, 'defaulted');
    return [];
  }
  return value.filter((item: unknown, index: number): item is string => {
    if (typeof item === 'string') {
      return true;
    }
    note(`${label}[${index}]`, item, 'dropped');
    return false;
  });
}

function validateDimensionReport(id: string, value: unknown): DimensionReport {
  if (!isRecord(value)) {
    throw new Error(`SessionStore schema: invalid dimension report ${id}`);
  }
  if (value.dimId !== undefined && typeof value.dimId !== 'string') {
    throw new Error(`SessionStore schema: invalid dimId for ${id}`);
  }
  if (value.dimId !== undefined && value.dimId !== id) {
    throw new Error(
      `SessionStore schema: dimension report key ${id} does not match dimId ${String(value.dimId)}`
    );
  }
  if (value.completedAt !== undefined && !isFiniteNumber(value.completedAt)) {
    throw new Error(`SessionStore schema: invalid completedAt for ${id}`);
  }
  if (value.analysisText !== undefined && typeof value.analysisText !== 'string') {
    throw new Error(`SessionStore schema: invalid analysisText for ${id}`);
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
  return {
    ...value,
    // 以上已确认：存在即类型正确且与键一致；只有缺失时才补默认值（兼容旧快照）。
    dimId: id,
    completedAt: value.completedAt ?? 0,
    analysisText: value.analysisText ?? '',
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

function validateTierReflection(value: Record<string, unknown>): TierReflection {
  validateNumberFields(value, ['tierIndex'], 'tierReflections');
  return {
    ...value,
    tierIndex: value.tierIndex ?? 0,
    completedDimensions: validateStrings(value.completedDimensions ?? [], 'completedDimensions'),
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
}

function validateRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`SessionStore schema: ${label} must contain objects`);
  }
  return value;
}

function validateFindings(value: unknown, label: string): Finding[] {
  return validateRecords(value, label).map((finding) => {
    if (!isValidFinding(finding)) {
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
  if (!hasOptionalStrings(value, keys)) {
    throw new Error(`SessionStore schema: invalid string in ${label}`);
  }
}

function validateNumberFields(value: Record<string, unknown>, keys: string[], label: string) {
  if (!hasOptionalFiniteNumbers(value, keys)) {
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
  return validateDigestRecord(value);
}

function validateDigestRecord(value: Record<string, unknown>): DimensionDigest {
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
