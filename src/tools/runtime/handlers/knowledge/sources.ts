/** 已声明来源的范围投影与 Agent authoring adapter；Core 门禁保留裁决权。 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { resolveProjectPath } from '#shared/projectPath.js';
import type { ToolContext } from '#tools/kernel/registry.js';
import { runInProcessRecipeAuthoringGate } from '../recipeAuthoringGate.js';
import type { prepareRecipeProductionItem } from '../recipeProductionAdapter.js';

/** F4b 反馈里附带的已声明 bounded range 行数上限。只提示，不改写候选。 */
const SNIPPET_REPAIR_MAX_LINES = 12;

/**
 * 严格读取 sourceRefs 中第一个可解析的真实行范围。越界不 clamp、裸路径不猜范围；
 * 仅用于拒绝提示，production adapter 另行决定 coreCode 是否可保留。
 */
function readRefRangeCode(
  sourceRefs: unknown,
  projectRoot: string | undefined
): {
  code: string;
  refText: string;
} | null {
  if (!projectRoot || !Array.isArray(sourceRefs)) {
    return null;
  }
  for (const ref of sourceRefs) {
    if (typeof ref !== 'string') {
      continue;
    }
    const m = ref.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    if (!m?.[1]) {
      continue;
    }
    try {
      const normalized = path.posix.normalize(m[1].replaceAll('\\', '/'));
      if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
        continue;
      }
      const absPath = resolveProjectPath(projectRoot, normalized).absolute;
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        continue;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      const rawStart = Number(m[2]);
      if (!Number.isFinite(rawStart) || rawStart < 1) {
        continue;
      }
      if (rawStart > lines.length) {
        continue;
      }
      const start = rawStart;
      const requestedEnd = m[3] ? Number(m[3]) : start + SNIPPET_REPAIR_MAX_LINES - 1;
      if (!Number.isFinite(requestedEnd) || requestedEnd < start || requestedEnd > lines.length) {
        continue;
      }
      const end = Math.min(requestedEnd, start + SNIPPET_REPAIR_MAX_LINES - 1);
      const code = lines.slice(start - 1, end).join('\n');
      if (!code.trim()) {
        continue;
      }
      return {
        code,
        refText: `${normalized}:${start}-${end}`,
      };
    } catch {
      // 只读失败换下一个 ref：宁缺毋错。
    }
  }
  return null;
}

/**
 * F4f：裸路径 sourceRefs（无 `:行号`）用 Analyst 接地范围规范化为 `path:start-end`。
 * 范围投影经 sharedState._analystGroundedRanges 注入（insightGateEvaluator 写入），来自
 * evidenceMap 真实片段——裸路径候选由此获得 F4b/F4d 可用的行号锚，非任意指派。
 */
export function normalizeBareSourceRefs(
  item: Record<string, unknown>,
  sharedState: Record<string, unknown> | null
): Record<string, unknown> {
  const ranges = sharedState?._analystGroundedRanges as
    | Record<string, Array<{ start: number; end: number }>>
    | undefined;
  if (!Array.isArray(item.sourceRefs)) {
    return item;
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
    return item;
  }
  Logger.getInstance().info(
    `[knowledge.submit] bare source refs normalized from analyst grounded ranges for "${String(item.title ?? '')}"`
  );
  return { ...item, sourceRefs, reasoning: { ...reasoning, sources } };
}

/**
 * F4b：代码/引用门禁拒绝时，读取第一个可解析 sourceRef 的真实 bounded range 作为诊断提示。
 * 该提示不会修改候选，也不把首个来源或整文件视为 coreCode 答案；失败时静默返回空串。
 */
export function buildSnippetRepairHint(
  sourceRefs: unknown,
  projectRoot: string | undefined
): string {
  const range = readRefRangeCode(sourceRefs, projectRoot);
  if (!range) {
    return '';
  }
  return ` 📎 修复提示：引用范围 ${range.refText} 的真实代码如下。仅当它确实是本候选需要表达的 bounded snippet 时，才逐字重提 coreCode；不得把首个来源或整文件当作自动答案。markdown 特写正文与模板代码保持你自己的提炼创作：\n${range.code}`;
}

/** 初次提交和风格修复采用相同门禁；profile 哈希由最终 authored 字段重算。 */
export function evaluatePreparedItem(
  prepared: ReturnType<typeof prepareRecipeProductionItem>,
  ctx: Pick<ToolContext, 'projectRoot'>,
  dimensionId?: string
) {
  const violations = runInProcessRecipeAuthoringGate(prepared.item as Record<string, unknown>, {
    projectRoot: ctx.projectRoot,
    dimensionId,
  });
  if (prepared.codeEvidence.accepted) {
    return violations;
  }
  const pendingCodes = new Set([
    'SNIPPET_MISMATCH',
    'SOURCE_REF_INVALID',
    'SOURCE_REF_LINE_MISSING',
    'SOURCE_REF_LINE_OUT_OF_RANGE',
    'SOURCE_REF_NOT_FOUND',
  ]);
  return violations.filter((violation) => !pendingCodes.has(violation.code));
}
