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

export interface SubmissionSanitizeResult {
  item: Record<string, unknown>;
  corrected: string[];
  dropped: string[];
  scopedNarrow: boolean;
}

function ledgerDistinctFiles(ledger: EvidenceLedgerLike): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of ledger.listRecent(ledger.stats().entries)) {
    if (entry.file && !seen.has(entry.file)) {
      seen.add(entry.file);
      files.push(entry.file);
    }
  }
  return files;
}

function basenameOf(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] ?? filePath;
}

/**
 * E7（接受率治理，2026-07-04 用户目标=100%）：提交前对手写引用做确定性净化 + 证据驱动
 * scope 收窄。E6 真机显示残余拒因全是「模型自由度」失误，非证据缺失：
 * - 路径自动矫正：手写 source 的文件在 projectRoot 解析失败时，用台账 distinct 文件做
 *   basename 唯一匹配改写（多仓前缀陷阱的机械解——台账路径就是采集时的真实形态）；
 *   无法唯一匹配的坏引用在「仍有其它可解析引用」时丢弃（否则保留，交门禁给权威拒绝）。
 * - scope 收窄：rule/pattern 且 distinct 引用文件 <3 且未声明 narrow 时自动 scope='narrow'
 *   ——作用域由证据广度推导，比模型断言的全项目范围更诚实；门禁语义不动
 *   （narrow 本就是 EVIDENCE_FLOOR 的合法通道，gateRules requiresMultiFileEvidence 读 item.scope）。
 */
export function sanitizeSubmissionEvidence(
  item: Record<string, unknown>,
  options: { ledger: EvidenceLedgerLike | null | undefined; projectRoot: string }
): SubmissionSanitizeResult {
  const ledger = options.ledger;
  if (!ledger) {
    return { item, corrected: [], dropped: [], scopedNarrow: false };
  }
  const reasoning = (item.reasoning ?? {}) as Record<string, unknown>;
  const files = ledgerDistinctFiles(ledger);
  const byBasename = new Map<string, string[]>();
  for (const file of files) {
    const key = basenameOf(file).toLowerCase();
    byBasename.set(key, [...(byBasename.get(key) ?? []), file]);
  }

  const corrected: string[] = [];
  const dropped: string[] = [];
  const sanitizeList = (raw: unknown): string[] => {
    const list = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    const kept: string[] = [];
    for (const source of list) {
      const match = /^(.*?)(:\d+(?:-\d+)?)?$/.exec(source.trim());
      const filePart = match?.[1] ?? source;
      const rangePart = match?.[2] ?? '';
      if (!filePart || existsSync(join(options.projectRoot, filePart))) {
        kept.push(source);
        continue;
      }
      const candidates = byBasename.get(basenameOf(filePart).toLowerCase()) ?? [];
      if (candidates.length === 1) {
        // 台账唯一背书：同名不同前缀→改写为台账真实形态；完全同路径→保留
        // （磁盘上暂不可见交由门禁/新鲜度裁决，台账证明它在采集时真实存在）
        kept.push(`${candidates[0]}${rangePart}`);
        if (candidates[0] !== filePart) {
          corrected.push(`${source}→${candidates[0]}${rangePart}`);
        }
      } else {
        dropped.push(source);
      }
    }
    // 全部被丢时保留原列表——不能让净化把候选清成零证据（门禁的拒绝信息更权威）
    return kept.length > 0 ? kept : list;
  };

  const sources = sanitizeList(reasoning.sources);
  const sourceRefs = sanitizeList(item.sourceRefs);

  // 证据驱动 scope 收窄（仅在未显式声明时）
  const kind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
  const distinct = new Set(sources.map((s) => /^(.*?)(?::\d+(?:-\d+)?)?$/.exec(s)?.[1] ?? s));
  const scopeValue = typeof item.scope === 'string' ? item.scope : '';
  const needsNarrow =
    (kind === 'rule' || kind === 'pattern') &&
    distinct.size > 0 &&
    distinct.size < 3 &&
    !/\b(single-file|file-local|local-only|narrow)\b/i.test(scopeValue);

  return {
    corrected,
    dropped,
    scopedNarrow: needsNarrow,
    item: {
      ...item,
      ...(needsNarrow ? { scope: 'narrow' } : {}),
      sourceRefs,
      reasoning: { ...reasoning, sources },
    },
  };
}

/**
 * E7 逐违规修复模板：风格/措辞类拒绝附「照抄即过」的具体形态——E6 二跑显示纯文字指引
 * 不足以驱动 DeepSeek 修复（waiver 采用 0）；模板把修复动作压缩成填空。
 */
export function buildViolationRepairTemplates(
  violations: Array<{ code: string }>,
  allowlist: { positive: string[]; negative: string[] }
): string {
  const codes = new Set(violations.map((v) => v.code));
  const parts: string[] = [];
  if (codes.has('DO_CLAUSE_NON_IMPERATIVE')) {
    parts.push(
      `修复模板[doClause]: 保留原意，改为以下列动词之一开头：${allowlist.positive.slice(0, 12).join('/')}（否定式：${allowlist.negative.slice(0, 6).join('/')}）`
    );
  }
  if (codes.has('CONTENT_CONTRAST_MISSING')) {
    parts.push(
      '修复模板[content.markdown]: 在正文追加对比块——"✅ 正确：<一行真实做法> (来源: 引用文件:行号)\\n❌ 错误：<一行反例做法>\\n违反后果：<一句具体后果>"'
    );
  }
  if (codes.has('GRAPH_REF_INVALID')) {
    parts.push(
      '修复模板[措辞]: 把"调用链/callers/callees/invokes"类断言改写为静态描述（导入/依赖/组合），或删除该句——无 graph 查询证据时不要做调用链断言'
    );
  }
  return parts.length > 0 ? ` 🔧 ${parts.join(' ｜ ')}` : '';
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
