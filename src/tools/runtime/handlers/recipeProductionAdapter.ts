import path from 'node:path';
import {
  type CreateRecipeItem,
  computeRecipeSourceContentHash,
  RECIPE_RETRIEVAL_PROFILE_SCHEMA_VERSION,
} from '@alembic/core';
import {
  parseBoundedSourceRef,
  readSourceRange,
  type SourceRangeFailureReason,
  splitLogicalLines,
} from './knowledge/sourceRange.js';

type RecipeRetrievalProfile = NonNullable<CreateRecipeItem['retrievalProfile']>;

const PROFILE_GENERATOR = 'alembic-agent-recipe-profile-v1';
const MAX_CORE_CODE_LINES = 120;
const MAX_CORE_CODE_CHARS = 12_000;
/**
 * adapter 自有策略：单条 profile 证据最多 160 行（与 RECIPE_PRODUCTION_PROFILE_PROMPT 的提示一致）。
 * 门禁对同一引用没有行数上限，因此超限引用能过门禁却会被这里排除——排除原因随
 * profileEvidence.rejected 返回，由 authoring 记 warn。
 */
const MAX_EVIDENCE_RANGE_LINES = 160;
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);
const DOCUMENT_DIRECTORIES = new Set(['design', 'docs', 'wakeflow-ledger']);

interface ProjectSourceEvidence {
  /**
   * 声明原文（trim 后）：写入 provenance.evidenceRefs。事实的 provenanceRefs 原样透传，Core readiness
   * 按精确字符串集合判接地，所以这里必须保留 `path:N`、`./` 前缀与反斜杠等原写法（I24）。
   */
  declaredRef: string;
  /** 规范形式 `relative:start-end`：只用于路径安全校验之后的 codeEvidence.provenanceRef。 */
  canonicalRef: string;
  content: string;
  documentation: boolean;
  wholeFile: boolean;
}

/**
 * profile 证据被排除的原因：共享读取模块 sourceRange 的拒绝原因，加上 adapter 自有的两条策略
 * （range-too-long：超过 160 行；empty-range：范围内只有空白）。
 */
export type ProfileEvidenceRejectReason =
  | SourceRangeFailureReason
  | 'range-too-long'
  | 'empty-range';

export interface RejectedProfileEvidence {
  /** 声明原文。 */
  ref: string;
  reason: ProfileEvidenceRejectReason;
  /** 人可读细节（含 fs 错误码、真实行数或上限），不含文件内容。 */
  detail: string;
}

export interface PreparedRecipeProductionItem {
  item: CreateRecipeItem;
  codeEvidence: {
    accepted: boolean;
    reason: 'absent' | 'bounded-match' | 'unbounded-or-unrelated';
    provenanceRef?: string;
  };
  /**
   * profile 证据读取诊断（内部接口，不写入候选）：rejected 列出被排除出 provenance.evidenceRefs
   * 与 coreCode 判定的声明引用及原因，供 authoring 记录 warn。
   */
  profileEvidence: {
    rejected: RejectedProfileEvidence[];
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(text)
    .filter(Boolean);
}

/**
 * 去重后排序的结果写进 retrievalProfile.provenance（evidenceRefs / sourceFieldRefs），Core 的
 * profileHash / documentSetHash 依赖这个顺序。排序规则固定为 en，不随进程默认区域变化：
 * 英文、中文环境下与历史顺序一致，其他区域（如 hu、da、sv）也得到同一顺序。是否改为码元序
 * 及已持久化哈希的迁移另行决定。
 */
function distinctSorted(values: string[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, 'en')
  );
}

function sourceRefsFromItem(item: CreateRecipeItem): string[] {
  const reasoning = record(item.reasoning);
  return distinctSorted([...stringArray(item.sourceRefs), ...stringArray(reasoning?.sources)]);
}

function isDocumentationPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  return (
    DOCUMENT_EXTENSIONS.has(path.posix.extname(normalized)) ||
    segments.some((segment) => DOCUMENT_DIRECTORIES.has(segment))
  );
}

type ProfileEvidenceResult =
  | { ok: true; evidence: ProjectSourceEvidence }
  | { ok: false; rejected: RejectedProfileEvidence };

/**
 * 读取一条声明的 profile 证据。路径解析、符号链接越界与切行全部委托共享模块 sourceRange
 * （与门禁 resolver 同一结论）；本函数只叠加 adapter 策略：160 行上限（读文件前先判，避免为
 * 注定被拒的引用读大文件）与空白范围拒绝。任何拒绝都带原因返回，不再静默 return null。
 */
function readProjectSourceEvidence(
  declaredRef: string,
  projectRoot: string
): ProfileEvidenceResult {
  const reject = (
    reason: ProfileEvidenceRejectReason,
    detail: string
  ): { ok: false; rejected: RejectedProfileEvidence } => ({
    ok: false,
    rejected: { ref: declaredRef, reason, detail },
  });
  const parsed = parseBoundedSourceRef(declaredRef);
  if (!parsed) {
    return reject('format', 'ref must be path:N or path:N-M');
  }
  const requestedLines = parsed.end - parsed.start + 1;
  if (
    parsed.start >= 1 &&
    parsed.end >= parsed.start &&
    requestedLines > MAX_EVIDENCE_RANGE_LINES
  ) {
    return reject(
      'range-too-long',
      `range spans ${requestedLines} lines; profile evidence is limited to ${MAX_EVIDENCE_RANGE_LINES} lines per ref`
    );
  }
  const range = readSourceRange(projectRoot, parsed);
  if (!range.ok) {
    return reject(range.reason, range.detail);
  }
  const content = range.lines.join('\n');
  if (!content.trim()) {
    return reject('empty-range', `lines ${range.start}-${range.end} contain only whitespace`);
  }
  return {
    ok: true,
    evidence: {
      declaredRef,
      canonicalRef: `${range.relative}:${range.start}-${range.end}`,
      content,
      // 分类依据受控解析后的真实来源；src 下的符号链接不能把文档提升为代码证据。
      // declaredRef 仍保留调用方声明的有界引用，便于沿原引用追溯。
      documentation: isDocumentationPath(range.realRelative),
      wholeFile: range.start === 1 && range.end === range.lineCount,
    },
  };
}

function factProvenanceRefs(profile: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const bucket of ['concepts', 'scenarios', 'exclusions']) {
    const facts = profile[bucket];
    if (!Array.isArray(facts)) {
      continue;
    }
    for (const fact of facts) {
      const factRecord = record(fact);
      refs.push(...stringArray(factRecord?.provenanceRefs));
    }
  }
  return refs;
}

function buildRetrievalProfile(
  authored: Record<string, unknown>,
  item: CreateRecipeItem,
  evidenceRefs: string[]
): RecipeRetrievalProfile {
  const summary = record(authored.summary);
  const authoredProvenance = record(authored.provenance);
  const sourceFieldRefs = distinctSorted([
    ...stringArray(authoredProvenance?.sourceFieldRefs),
    ...factProvenanceRefs(authored).filter((ref) => ref.startsWith('field:')),
  ]);
  const sourceWithoutProfile: CreateRecipeItem = { ...item, retrievalProfile: null };
  return {
    schemaVersion: RECIPE_RETRIEVAL_PROFILE_SCHEMA_VERSION,
    primaryLanguage: text(authored.primaryLanguage),
    summary: {
      primary: text(summary?.primary),
      technicalEnglish: text(summary?.technicalEnglish),
    },
    concepts: (Array.isArray(authored.concepts)
      ? authored.concepts
      : []) as RecipeRetrievalProfile['concepts'],
    scenarios: (Array.isArray(authored.scenarios)
      ? authored.scenarios
      : []) as RecipeRetrievalProfile['scenarios'],
    exclusions: (Array.isArray(authored.exclusions)
      ? authored.exclusions
      : []) as RecipeRetrievalProfile['exclusions'],
    provenance: {
      evidenceRefs,
      sourceFieldRefs,
      sourceContentHash: computeRecipeSourceContentHash(sourceWithoutProfile),
      generator: PROFILE_GENERATOR,
    },
  };
}

/**
 * Convert the Agent-authored profile draft into Core's public wire contract. Profile
 * provenance accepts valid project-local bounded evidence (including documentation)
 * independently from coreCode, while code admission additionally requires a
 * non-document, non-whole-file range containing the submitted snippet. No source
 * snippet is ever copied into the candidate by this adapter.
 *
 * provenance.evidenceRefs 写每条可读引用的声明原文（与事实 provenanceRefs 逐字对齐），
 * codeEvidence.provenanceRef 写规范形式；被排除的引用连同原因进入 profileEvidence.rejected，
 * 本函数不打日志，由调用方（authoring）按提交语境记录。
 */
export function prepareRecipeProductionItem(
  rawItem: Record<string, unknown>,
  projectRoot: string
): PreparedRecipeProductionItem {
  const authoredProfile = record(rawItem.retrievalProfile);
  const requestedCoreCode = text(rawItem.coreCode);
  const profileEvidence: ProjectSourceEvidence[] = [];
  const rejected: RejectedProfileEvidence[] = [];
  for (const ref of sourceRefsFromItem(rawItem as CreateRecipeItem)) {
    const result = readProjectSourceEvidence(ref, projectRoot);
    if (result.ok) {
      profileEvidence.push(result.evidence);
    } else {
      rejected.push(result.rejected);
    }
  }
  const codeEvidence = profileEvidence.filter((entry) => !entry.documentation && !entry.wholeFile);

  // coreCode 预算按同一切行语义计行：CRLF 与末尾换行不影响行数。
  const codeFitsBudget =
    requestedCoreCode.length <= MAX_CORE_CODE_CHARS &&
    splitLogicalLines(requestedCoreCode).length <= MAX_CORE_CODE_LINES;
  const matchingEvidence = requestedCoreCode
    ? codeEvidence.find((entry) => entry.content.includes(requestedCoreCode))
    : undefined;
  const codeAccepted = !requestedCoreCode || (codeFitsBudget && matchingEvidence !== undefined);
  const item: CreateRecipeItem = {
    ...(rawItem as CreateRecipeItem),
    coreCode: codeAccepted ? requestedCoreCode : '',
    retrievalProfile: null,
  };
  if (authoredProfile) {
    item.retrievalProfile = buildRetrievalProfile(
      authoredProfile,
      item,
      distinctSorted(profileEvidence.map((entry) => entry.declaredRef))
    );
  }

  return {
    item,
    codeEvidence: requestedCoreCode
      ? matchingEvidence && codeFitsBudget
        ? {
            accepted: true,
            reason: 'bounded-match',
            provenanceRef: matchingEvidence.canonicalRef,
          }
        : { accepted: false, reason: 'unbounded-or-unrelated' }
      : { accepted: true, reason: 'absent' },
    profileEvidence: { rejected },
  };
}
