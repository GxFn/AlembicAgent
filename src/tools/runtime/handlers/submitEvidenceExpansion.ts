/**
 * @module tools/runtime/handlers/submitEvidenceExpansion
 *
 * 提交侧证据展开与新鲜度终检（Wave A E5）。
 *
 * producer 以 `reasoning.evidenceRefs`（台账条目 id）提交时：
 * - sources / sourceRefs 由程序从台账条目机械展开为 `file:start-end`（模型不再手写引用）；
 * - coreCode 为空时以首个带区间条目的 verbatim 内容回填（非空时不覆盖——形式不一致仍由
 *   既有 F4c 对齐管线消化）；
 * - 新鲜度终检：带 file+range 的条目按「同区间重切+同截断+同脱敏」重算哈希与采集时比对，
 *   run 中途文件变更 → 拒并提示 evidence.search/code.read 重采（EVIDENCE_STALE）。
 *
 * 全部发生在权威门禁（runInProcessRecipeAuthoringGate）之前的 Agent 层；
 * Core gateRules 与九拒因语义不动，host-agent 路径零回归。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceLedgerLike } from '#tools/kernel/context.js';

export type SubmitExpansionResult =
  | { ok: true; item: Record<string, unknown>; expandedSources: string[] }
  | { ok: false; error: string };

function uniqueMerge(base: unknown, extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim() && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  };
  if (Array.isArray(base)) {
    for (const value of base) {
      push(value);
    }
  }
  for (const value of extra) {
    push(value);
  }
  return out;
}

export function expandEvidenceRefsForSubmit(
  item: Record<string, unknown>,
  options: { ledger: EvidenceLedgerLike | null | undefined; projectRoot: string }
): SubmitExpansionResult {
  const reasoning = (item.reasoning ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(reasoning.evidenceRefs)
    ? (reasoning.evidenceRefs as unknown[]).filter(
        (ref): ref is string => typeof ref === 'string' && ref.trim().length > 0
      )
    : [];
  if (refs.length === 0) {
    // 未用新契约提交：路径完全不变（additive——手填 reasoning.sources 仍由门禁 fs 校验兜底）
    return { ok: true, item, expandedSources: [] };
  }
  const ledger = options.ledger;
  if (!ledger) {
    return {
      ok: false,
      error:
        'Validation failed: reasoning.evidenceRefs 需要证据台账在场（维度运行）；非维度提交请直接填 reasoning.sources',
    };
  }

  const labels: string[] = [];
  let firstRangedContent: string | null = null;
  for (const ref of refs) {
    const entry = ledger.get(ref);
    if (!entry) {
      const recent = ledger
        .listRecent(3)
        .map((candidate) => (candidate.file ? `${candidate.id}=${candidate.file}` : candidate.id))
        .join('; ');
      return {
        ok: false,
        error: `Validation failed: reasoning.evidenceRefs 无法解析 "${ref}"（只能引用工具返回 [evidence] 标注的台账条目 id）。近期条目: ${recent || '(台账为空——先用 code/graph 工具采集证据)'}`,
      };
    }
    if (entry.file && entry.range) {
      // 新鲜度终检：文件缺失/不可读与哈希不一致同判 stale——引用的采集内容已不再代表当前源码
      const absolute = join(options.projectRoot, entry.file);
      let current: string | null = null;
      if (existsSync(absolute)) {
        try {
          current = readFileSync(absolute, 'utf8');
        } catch {
          current = null;
        }
      }
      const freshness = current === null ? 'stale' : ledger.checkFreshness(ref, current);
      if (freshness === 'stale') {
        return {
          ok: false,
          error: `Validation failed: EVIDENCE_STALE (${entry.file}): 引用条目 ${entry.id} 采集后该文件已变更或不可读——先用 evidence.search/code.read 重采，再以新条目 id 提交。`,
        };
      }
      if (firstRangedContent === null) {
        firstRangedContent = entry.content;
      }
      labels.push(`${entry.file}:${entry.range.start}-${entry.range.end}`);
    } else if (entry.file) {
      labels.push(entry.file);
    }
    // 无 file 条目（graph/terminal）：合法引用但不产出 source 标签——门禁的证据下限由带文件条目满足
  }

  const mergedSources = uniqueMerge(reasoning.sources, labels);
  const mergedSourceRefs = uniqueMerge(item.sourceRefs, labels);
  const coreCode =
    typeof item.coreCode === 'string' && item.coreCode.trim()
      ? item.coreCode
      : (firstRangedContent ?? item.coreCode);

  return {
    ok: true,
    expandedSources: labels,
    item: {
      ...item,
      coreCode,
      sourceRefs: mergedSourceRefs,
      reasoning: { ...reasoning, sources: mergedSources },
    },
  };
}

/**
 * INSUFFICIENT_EVIDENCE 拒绝反馈增强（E5）：告诉模型台账里真实可引用的 distinct 文件
 * （此前只说 "add 3 distinct files" 不说去哪找——修不动的拒绝即无效拒绝）。
 */
export function buildEvidenceCandidatesHint(ledger: EvidenceLedgerLike | null | undefined): string {
  if (!ledger) {
    return '';
  }
  const stats = ledger.stats();
  if (stats.distinctFiles === 0) {
    return '';
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ledger.listRecent(50)) {
    if (candidate.file && !seen.has(candidate.file)) {
      seen.add(candidate.file);
      files.push(candidate.file);
      if (files.length >= 5) {
        break;
      }
    }
  }
  if (files.length === 0) {
    return '';
  }
  return ` 📎 台账内可引用的 distinct 文件(共 ${stats.distinctFiles} 个): ${files.join(', ')} —— 用 evidence.search 查条目 id 并以 reasoning.evidenceRefs 引用（多仓工作区路径必须含仓库前缀，台账条目已是正确形态，引用 id 最稳，不要凭记忆手写路径）。`;
}
