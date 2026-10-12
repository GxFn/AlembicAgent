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

/** 行号类违规：违规对象带 sourceRef，指向门禁判定为不可用的那一条引用。 */
const REF_LEVEL_HINT_CODES = new Set(['SOURCE_REF_LINE_OUT_OF_RANGE', 'SOURCE_REF_LINE_MISSING']);

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
 * 描述一条行号类违规引用：只给路径与文件实际行数，不展示任何代码（越界/缺行号的引用本身
 * 没有可展示的真实范围，换展示别的引用会诱导模型粘贴无关片段）。
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
  if (!range.ok && range.reason === 'line-out-of-range' && range.lineCount !== undefined) {
    return `${ref} 超出文件范围（${range.relative ?? ref} 实际 ${range.lineCount} 行）`;
  }
  // 门禁判越界、此处却读到或因别的原因读不到：文件在两次读取之间变化，只报告当前读取结论。
  return range.ok
    ? `${ref} 行号范围在门禁判定后已变化（${range.relative} 当前 ${range.lineCount} 行）`
    : `${ref} 无法读取（${range.reason}）`;
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
 *   - SOURCE_REF_LINE_OUT_OF_RANGE / SOURCE_REF_LINE_MISSING：只列违规引用本身与文件实际行数，
 *     不展示其它引用的代码；
 *   - SNIPPET_MISMATCH：门禁拿片段与所有已声明的有效范围比对，故从候选（sourceRefs ∪
 *     reasoning.sources，由 collectSnippetHintCandidates 收集）中取第一个可读范围展示真实代码。
 * violations 缺省表示调用方没有违规列表，按 SNIPPET_MISMATCH 语义只展示首个可读范围。
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
  const wantsSnippet =
    violations === undefined || violations.some((v) => v.code === 'SNIPPET_MISMATCH');
  const violatingRefs = (violations ?? []).filter(
    (v) => REF_LEVEL_HINT_CODES.has(v.code) && Boolean(v.sourceRef ?? v.path)
  );
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
    hint += ` 📎 修复提示：以下引用未通过行号接地：${notes.join('；')}。请先 code.read 确认真实行号，再改写为 path:start-end 重提。`;
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
