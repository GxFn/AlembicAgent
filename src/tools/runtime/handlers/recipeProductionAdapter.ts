import path from 'node:path';
import {
  type CreateRecipeItem,
  computeRecipeSourceContentHash,
  RECIPE_RETRIEVAL_PROFILE_SCHEMA_VERSION,
} from '@alembic/core';
import Logger from '@alembic/core/logging';
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
 * profileHash / documentSetHash 依赖这个顺序。排序规则固定为 en，不随进程默认区域变化，
 * 任何区域都得到同一顺序。与固定之前（按进程默认区域排序）的历史顺序相比：
 *   - 英文环境：完全一致；
 *   - 中文环境（zh、zh-CN、zh-Hans-CN、zh-TW）：只对不含汉字的引用（如纯 ASCII 路径与字段名）
 *     一致。引用含汉字时（evidenceRefs 是项目相对路径，目录或文件名可以是中文），zh 把汉字排在
 *     拉丁字母之前且汉字之间按拼音排，en 把汉字排在拉丁字母之后且不按拼音，所以中文默认区域
 *     进程里撰写过这类配方，重新撰写后顺序可能改变，profileHash / documentSetHash 也随之改变；
 *   - 部分区域（如 hu、da、lt）对某些 ASCII 组合（cs/cz、aa/z、y/iz 等）的历史顺序本就与 en
 *     不同，含这些组合的配方重新撰写后同样会改变。
 * 是否改为码元序、以及已持久化哈希如何迁移，属于待决事项⑥；在那之前不改这里的排序规则。
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
 * 由调用方（authoring）按提交语境记录 warn。本函数自己只记一种 debug：coreCode 含 CRLF、
 * 按 LF 归一后再与证据比对的兼容转译。
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
  // 片段比对与 sourceRange.splitLogicalLines 的 /\r?\n/ 切行语义对齐（L4-P22 / I25）：证据行已去掉
  // 行尾 '\r' 并以 '\n' 连接，而 code.read 展示给模型的源码行保留 '\r'，模型照抄的多行 coreCode
  // 会带 CRLF。只归一比对串，写回候选的 coreCode 保持提交原样（Core 门禁按去空白比对，冻结证据
  // 保留原始字节）；行内孤立的 '\r' 不在切行语义内，两侧都原样保留。
  const matchableCoreCode = requestedCoreCode.replace(/\r\n/g, '\n');
  const matchingEvidence = requestedCoreCode
    ? codeEvidence.find((entry) => entry.content.includes(matchableCoreCode))
    : undefined;
  const codeAccepted = !requestedCoreCode || (codeFitsBudget && matchingEvidence !== undefined);
  if (matchableCoreCode !== requestedCoreCode) {
    // 兼容转译留痕：触发条件（coreCode 含 CRLF）、选择路径（按 LF 比对）与比对结论；不含代码内容。
    Logger.getInstance().debug(
      `[knowledge.submit] recipe production adapter normalized CRLF line endings in coreCode for bounded snippet matching for "${text(rawItem.title)}": lines=${splitLogicalLines(requestedCoreCode).length}, result=${codeAccepted ? `bounded-match (${matchingEvidence?.canonicalRef ?? ''})` : 'unbounded-or-unrelated'}; stored coreCode keeps its submitted line endings`
    );
  }
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
