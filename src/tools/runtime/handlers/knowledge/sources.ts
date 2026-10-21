/** 已声明来源的范围投影与 Agent authoring adapter；Core 门禁保留裁决权。 */

import path from 'node:path';
import type { RecipeAuthoringViolation } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import type { ToolContext } from '#tools/kernel/registry.js';
import { runInProcessRecipeAuthoringGate } from '../recipeAuthoringGate.js';
import type { prepareRecipeProductionItem } from '../recipeProductionAdapter.js';
import { readBoundedSourceRange, readProjectSourceFile } from './sourceRange.js';

/** F4b 反馈里附带的已声明 bounded range 行数上限。只提示，不改写候选。 */
const SNIPPET_REPAIR_MAX_LINES = 12;

/** F4b 只关心违规码与定位字段；与 Core RecipeAuthoringViolation 结构兼容。 */
export type SnippetHintViolation = Pick<RecipeAuthoringViolation, 'code' | 'sourceRef' | 'path'>;

/**
 * 引用级违规：违规对象带 sourceRef/path，指向门禁判定为不可用的那一条引用——行号类（越界、缺行号）
 * 与路径类（文件不存在、根外或非法路径）。这些引用都不进门禁的有效范围集合，SNIPPET_MISMATCH 与
 * 它们同时出现时片段很可能就来自这条引用（多仓前缀陷阱、../ 兄弟仓路径是现实来源），不能借用别的
 * 引用的代码（L4-P22 / U18-F7；路径类两码由 L4-P22br4 补入）。
 */
const REF_LEVEL_HINT_CODES = new Set([
  'SOURCE_REF_LINE_OUT_OF_RANGE',
  'SOURCE_REF_LINE_MISSING',
  'SOURCE_REF_NOT_FOUND',
  'SOURCE_REF_INVALID',
]);

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * F4b 候选引用集合：sourceRefs ∪ reasoning.sources（去重，保持声明顺序）。门禁同样从这两处
 * 收集来源，只看 sourceRefs 会漏掉仅写在 reasoning.sources 里的可读范围。
 */
export function collectSnippetHintCandidates(item: Record<string, unknown>): string[] {
  const reasoning =
    item.reasoning && typeof item.reasoning === 'object' && !Array.isArray(item.reasoning)
      ? (item.reasoning as Record<string, unknown>)
      : null;
  return [...new Set([...stringList(item.sourceRefs), ...stringList(reasoning?.sources)])];
}

/**
 * 严格读取候选中第一个可读的声明范围（经 sourceRange 单源：越界不 clamp、裸路径不猜范围、
 * `path:N` 只取第 N 行），超过 12 行时截断展示。仅用于拒绝提示，production adapter 另行决定
 * coreCode 是否可保留。每个被跳过的候选留一条带原因的 debug 诊断（不含文件内容）。
 */
function readFirstHintRange(
  candidates: readonly string[],
  projectRoot: string
): { code: string; refText: string } | null {
  for (const ref of candidates) {
    const range = readBoundedSourceRange(projectRoot, ref);
    if (!range.ok) {
      // 跳过不改变提示结果（宁缺毋错），但留痕：ref 文本 + 拒绝原因 + 细节（如 Access denied、EACCES）。
      Logger.getInstance().debug(
        `[knowledge.submit] snippet repair hint skipped unreadable source ref "${ref}": ${range.reason} (${range.detail})`
      );
      continue;
    }
    const end = Math.min(range.end, range.start + SNIPPET_REPAIR_MAX_LINES - 1);
    const code = range.lines.slice(0, end - range.start + 1).join('\n');
    if (!code.trim()) {
      Logger.getInstance().debug(
        `[knowledge.submit] snippet repair hint skipped source ref "${ref}": empty-range (lines ${range.start}-${end} contain only whitespace)`
      );
      continue;
    }
    return { code, refText: `${range.relative}:${range.start}-${end}` };
  }
  return null;
}

/**
 * 描述一条引用级违规引用：只给路径、拒绝原因与文件实际行数，不展示任何代码（越界/缺行号/不存在/
 * 根外的引用本身没有可展示的真实范围，换展示别的引用会诱导模型粘贴无关片段）。按当前重新读取的
 * 结论描述而不是复述门禁违规码：文件若在门禁判定后变化，只报告当前读取结论。
 */
function describeViolatingRef(violation: SnippetHintViolation, projectRoot: string): string {
  const ref = violation.sourceRef ?? violation.path ?? '';
  if (violation.code === 'SOURCE_REF_LINE_MISSING') {
    const file = readProjectSourceFile(projectRoot, ref);
    return file.ok
      ? `${ref} 缺少行号（${file.relative} 实际 ${file.fileLines.length} 行，请写成 path:start-end）`
      : `${ref} 缺少行号且文件不可读（${file.reason}）`;
  }
  const range = readBoundedSourceRange(projectRoot, ref);
  if (range.ok) {
    // 门禁判不可用、此处却读到：文件在两次读取之间变化（或路径在门禁判定后才出现），只报告当前结论。
    return `${ref} 行号范围在门禁判定后已变化（${range.relative} 当前 ${range.lineCount} 行）`;
  }
  switch (range.reason) {
    case 'line-out-of-range':
      return range.lineCount !== undefined
        ? `${ref} 超出文件范围（${range.relative ?? ref} 实际 ${range.lineCount} 行）`
        : `${ref} 超出文件范围（${range.detail}）`;
    case 'not-found':
      // 多仓前缀陷阱：路径写成了别的仓库或子包的相对路径，本项目内不存在。
      return `${ref} 文件不存在（请核对本项目的仓库相对路径；多仓前缀与 ../ 兄弟仓路径都不在本项目内）`;
    case 'path-invalid':
    case 'outside-root':
    case 'symlink-escape':
      return `${ref} 不在项目根内（${range.reason}），只能引用本项目内的仓库相对路径`;
    case 'format':
      return `${ref} 不是 path:N 或 path:N-M 形式`;
    default:
      // read-error（EACCES、竞态删除）等：只报原因，不猜范围。
      return `${ref} 无法读取（${range.reason}）`;
  }
}

/**
 * F4f：裸路径 sourceRefs（无 `:行号`）用 Analyst 接地范围规范化为 `path:start-end`。
 * 范围投影经 sharedState._analystGroundedRanges 注入（insightGateEvaluator 写入），来自
 * evidenceMap 真实片段——裸路径候选由此获得 F4b/F4d 可用的行号锚，非任意指派。
 * 返回 changed 供调用方计入修复层计量（I39：此前只打 info，repair-hit-rate 中 F4f 恒为 0，
 * 会被误判为死枝）；未改写时原样返回同一 item 引用。
 */
export function normalizeBareSourceRefs(
  item: Record<string, unknown>,
  sharedState: Record<string, unknown> | null
): { item: Record<string, unknown>; changed: boolean } {
  const ranges = sharedState?._analystGroundedRanges as
    | Record<string, Array<{ start: number; end: number }>>
    | undefined;
  if (!Array.isArray(item.sourceRefs)) {
    return { item, changed: false };
  }
  let changed = false;
  const normalizeRef = (ref: unknown): unknown => {
    if (typeof ref !== 'string' || /:\d+/.test(ref)) {
      return ref;
    }
    const filePath = path.posix.normalize(ref.replaceAll('\\', '/'));
    const fileRanges = ranges?.[filePath];
    if (fileRanges?.[0]) {
      changed = true;
      return `${filePath}:${fileRanges[0].start}-${fileRanges[0].end}`;
    }
    return ref;
  };
  const sourceRefs = (item.sourceRefs as unknown[]).map(normalizeRef);
  const reasoning = (item.reasoning ?? {}) as Record<string, unknown>;
  const sources = Array.isArray(reasoning.sources)
    ? (reasoning.sources as unknown[]).map(normalizeRef)
    : reasoning.sources;
  if (!changed) {
    return { item, changed: false };
  }
  Logger.getInstance().info(
    `[knowledge.submit] bare source refs normalized from analyst grounded ranges for "${String(item.title ?? '')}"`
  );
  return { item: { ...item, sourceRefs, reasoning: { ...reasoning, sources } }, changed: true };
}

/**
 * F4b：代码/引用门禁拒绝时给出诊断提示，按门禁违规挑引用（L4-P22 / U18-F7）：
 *   - 引用级违规（行号类 SOURCE_REF_LINE_OUT_OF_RANGE / SOURCE_REF_LINE_MISSING，路径类
 *     SOURCE_REF_NOT_FOUND / SOURCE_REF_INVALID）：只列违规引用本身、拒绝原因与文件实际行数，
 *     不展示其它引用的代码；
 *   - 仅有 SNIPPET_MISMATCH（没有引用级违规）：门禁拿片段与所有已声明的有效范围比对，故从候选
 *     （sourceRefs ∪ reasoning.sources，由 collectSnippetHintCandidates 收集）中取第一个可读范围
 *     展示真实代码；
 *   - SNIPPET_MISMATCH 与引用级违规同时出现：SNIPPET_MISMATCH 不带 sourceRef，片段很可能来自越界、
 *     缺行号、不存在或根外的那条引用（它不算有效范围），此时首个可读范围与片段来源无关，展示它会
 *     诱导模型粘贴无关代码。违规引用本身没有可读范围，因此不展示任何代码，只列违规路径与原因。
 * violations 缺省表示调用方没有违规列表，按单独 SNIPPET_MISMATCH 语义只展示首个可读范围。
 * 提示不会修改候选，也不把首个来源或整文件视为 coreCode 答案；无可展示内容时返回空串。
 */
export function buildSnippetRepairHint(
  sourceRefs: unknown,
  projectRoot: string | undefined,
  violations?: readonly SnippetHintViolation[]
): string {
  if (!projectRoot) {
    return '';
  }
  const candidates = stringList(sourceRefs);
  const violatingRefs = (violations ?? []).filter(
    (v) => REF_LEVEL_HINT_CODES.has(v.code) && Boolean(v.sourceRef ?? v.path)
  );
  const snippetMismatch =
    violations === undefined || violations.some((v) => v.code === 'SNIPPET_MISMATCH');
  const wantsSnippet = snippetMismatch && violatingRefs.length === 0;
  if (snippetMismatch && !wantsSnippet) {
    // 短路：片段不匹配与引用级违规同时出现时，不借用其它引用的代码（只能从违规引用取范围，而它不可读）。
    Logger.getInstance().debug(
      `[knowledge.submit] snippet repair hint skipped code display: SNIPPET_MISMATCH occurred together with ref-level grounding violation(s) ${violatingRefs.map((v) => `${v.code} on ${v.sourceRef ?? v.path}`).join(', ')}; listing violating ref(s) only`
    );
  }
  let hint = '';
  if (wantsSnippet) {
    const range = readFirstHintRange(candidates, projectRoot);
    if (range) {
      hint += ` 📎 修复提示：引用范围 ${range.refText} 的真实代码如下。仅当它确实是本候选需要表达的 bounded snippet 时，才逐字重提 coreCode；不得把首个来源或整文件当作自动答案。markdown 特写正文与模板代码保持你自己的提炼创作：\n${range.code}`;
    }
  }
  if (violatingRefs.length > 0) {
    const notes = [
      ...new Set(violatingRefs.map((violation) => describeViolatingRef(violation, projectRoot))),
    ];
    if (!hint) {
      // 降级为只列路径：违规引用没有可展示的真实范围，也不借用其它引用的代码凑提示。
      Logger.getInstance().debug(
        `[knowledge.submit] snippet repair hint lists ${notes.length} violating ref(s) without code: ${violatingRefs.map((v) => v.sourceRef ?? v.path).join(', ')}`
      );
    }
    hint += ` 📎 修复提示：以下引用未通过来源接地：${notes.join('；')}。请先 code.read 确认真实路径与行号，再改写为本项目内的 path:start-end 重提。`;
  }
  return hint;
}

/** 初次提交和风格修复采用相同门禁；profile 哈希由最终 authored 字段重算。 */
export function evaluatePreparedItem(
  prepared: ReturnType<typeof prepareRecipeProductionItem>,
  ctx: Pick<ToolContext, 'projectRoot'>,
  dimensionId?: string
) {
  // unsafe coreCode 已在 prepare 中移除；此时剩余违规来自真实保留字段，必须交还 Core 裁决。
  // 不能因曾出现坏片段而过滤 SOURCE_REF_* 或其它片段的 SNIPPET_MISMATCH，否则添加垃圾
  // coreCode 反而会让不存在/越界的来源通过。剥除片段的诊断仍保留在 prepared.codeEvidence。
  return runInProcessRecipeAuthoringGate(prepared.item as Record<string, unknown>, {
    projectRoot: ctx.projectRoot,
    dimensionId,
  });
}
