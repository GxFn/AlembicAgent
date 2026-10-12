/**
 * @module tools/runtime/handlers/submitEvidenceExpansion
 *
 * 提交侧证据展开与新鲜度终检（Wave A E5）。
 *
 * producer 以 `reasoning.evidenceRefs`（台账条目 id）提交时：
 * - sources / sourceRefs 由程序从台账条目机械展开为 `file:start-end`（模型不再手写引用）；
 * - coreCode 永不从台账机械回填；production adapter 只验证模型显式提交的 bounded snippet；
 * - 新鲜度终检：带 file+range 的条目按「同区间重切+同截断+同脱敏」重算哈希与采集时比对，
 *   run 中途文件变更 → 拒并提示 evidence.search/code.read 重采（EVIDENCE_STALE）。
 *
 * 全部发生在权威门禁（runInProcessRecipeAuthoringGate）之前的 Agent 层；
 * Core gateRules 与九拒因语义不动，host-agent 路径零回归。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { type OperationOptions, runOperation } from '#shared/operation.js';
import { resolveProjectPath } from '#shared/projectPath.js';
import { extractJSON } from '#shared/structuredOutput.js';
import type { EvidenceLedgerLike } from '#tools/kernel/context.js';
import { classifyUnresolvedEvidenceRef } from './evidence.js';

export type SubmitExpansionResult =
  // resolvedRefs=成功解析的台账引用数（含无 file 的 search/structure/terminal 条目）；
  // expandedSources 只含带区间条目产出的 file:start-end 标签。二者分离是 EVIDENCE_REFS_REQUIRED
  // 判定的关键：引用了真实台账证据但全为无标签条目 ≠ 没给证据（run-6 误杀教训）。
  | { ok: true; item: Record<string, unknown>; expandedSources: string[]; resolvedRefs: number }
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

/** 唯一会把内容 `NN:` 前缀当作文件行号的采集来源（EvidenceCapture 按文件分组的命中行）。 */
const LINE_PREFIXED_SEARCH_TOOL = 'code.search';

/**
 * file-有-range-无 条目的 source 标签（I34）。
 *
 * - code.search 分组条目（M2/P1b）：content 每行 "NN: text" 是采集真值——机械派生首 K=2 个
 *   命中行为 file:NN-NN 标签，search 证据升为一等公民（可直接过 LINE 门）；没有行号前缀时
 *   退回裸文件标签。
 * - 其余 file-only 条目（terminal.exec 输出归属到命令里的仓内路径、code.read 的
 *   outline/delta/unchanged 降级视图）以及不提供 tool 的台账实现：内容里的 `NN:` 不是
 *   文件行号（例如 `cat openapi.yaml` 的 `404:` 数字键），派生会伪造 file:404-404，
 *   导致 SOURCE_REF_LINE_OUT_OF_RANGE 误拒或持久化错误行号——只给裸文件标签交下游门禁裁决。
 *   代价：`grep -n` 单文件终端输出也不再自动得到行号标签（与 producer 提示词
 *   「search/terminal 类条目需手填 file:line」一致）。
 */
function fileOnlyEntryLabels(
  entry: { id: string; tool?: string; content: string },
  file: string
): string[] {
  if (entry.tool !== LINE_PREFIXED_SEARCH_TOOL) {
    Logger.getInstance().debug(
      `[knowledge.submit] evidence ref ${entry.id} (tool=${entry.tool ?? 'unknown'}) is file-only without range; line labels are derived only from ${LINE_PREFIXED_SEARCH_TOOL} entries — expanded as bare file label ${file}`
    );
    return [file];
  }
  const hitLines: string[] = [];
  for (const line of entry.content.split('\n')) {
    const hit = /^(\d+):/.exec(line.trim());
    if (hit) {
      hitLines.push(`${file}:${hit[1]}-${hit[1]}`);
      if (hitLines.length >= 2) {
        break;
      }
    }
  }
  if (hitLines.length === 0) {
    Logger.getInstance().debug(
      `[knowledge.submit] evidence ref ${entry.id} (tool=${LINE_PREFIXED_SEARCH_TOOL}) has no "NN:" hit-line prefix — expanded as bare file label ${file}`
    );
    return [file];
  }
  return hitLines;
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
    return { ok: true, item, expandedSources: [], resolvedRefs: 0 };
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
  let resolvedRefs = 0;
  for (const ref of refs) {
    const entry = ledger.get(ref);
    if (!entry) {
      // I21：基础 id 存在但子区间越界/落在截断尾部时给出可用区间，不再误报为 id 不存在
      const failure = classifyUnresolvedEvidenceRef(ledger, ref, 'knowledge.submit');
      if (failure.detail) {
        return { ok: false, error: `Validation failed: reasoning.evidenceRefs ${failure.detail}` };
      }
      const recent = ledger
        .listRecent(3)
        .map((candidate) => (candidate.file ? `${candidate.id}=${candidate.file}` : candidate.id))
        .join('; ');
      return {
        ok: false,
        error: `Validation failed: reasoning.evidenceRefs 无法解析 "${ref}"（只能引用工具返回 [evidence] 标注的台账条目 id）。近期条目: ${recent || '(台账为空——先用 code/graph 工具采集证据)'}`,
      };
    }
    resolvedRefs += 1;
    if (entry.file && entry.range) {
      // 新鲜度终检：文件缺失/不可读与哈希不一致同判 stale——引用的采集内容已不再代表当前源码
      let current: string | null = null;
      try {
        const absolute = resolveProjectPath(options.projectRoot, entry.file).absolute;
        current = readFileSync(absolute, 'utf8');
      } catch {
        current = null;
      }
      const freshness = current === null ? 'stale' : ledger.checkFreshness(ref, current);
      if (freshness === 'stale') {
        return {
          ok: false,
          error: `Validation failed: EVIDENCE_STALE (${entry.file}): 引用条目 ${entry.id} 采集后该文件已变更或不可读——先用 evidence.search/code.read 重采，再以新条目 id 提交。`,
        };
      }
      labels.push(`${entry.file}:${entry.range.start}-${entry.range.end}`);
    } else if (entry.file) {
      labels.push(...fileOnlyEntryLabels(entry, entry.file));
    }
    // 无 file 条目（graph/terminal）：合法引用但不产出 source 标签——门禁的证据下限由带文件条目满足
  }

  const mergedSources = uniqueMerge(reasoning.sources, labels);
  const mergedSourceRefs = uniqueMerge(item.sourceRefs, labels);
  return {
    ok: true,
    expandedSources: labels,
    resolvedRefs,
    item: {
      ...item,
      sourceRefs: mergedSourceRefs,
      reasoning: { ...reasoning, sources: mergedSources },
    },
  };
}

export interface SubmissionSanitizeResult {
  item: Record<string, unknown>;
  corrected: string[];
  /** 真实从候选里移除的坏引用（同列表还有可解析引用时才会丢）；去重。 */
  dropped: string[];
  /**
   * 全丢回退时原样保留、交门禁裁决的无法解析引用（I33）。它们没有被移除，
   * 不能计入 dropped / evidence_sanitized；去重（sources 与 sourceRefs 同一路径只记一次）。
   */
  retainedUnresolved: string[];
  scopedNarrow: boolean;
}

/** 按首次出现顺序并入，已存在的值跳过——同一来源常同时出现在 sources 与 sourceRefs。 */
function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
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
 *   无法唯一匹配的坏引用在「仍有其它可解析引用」时丢弃（记 dropped）；否则整列表保留，
 *   交门禁给权威拒绝（记 retainedUnresolved，不算丢弃）。
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
    return { item, corrected: [], dropped: [], retainedUnresolved: [], scopedNarrow: false };
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
  const retainedUnresolved: string[] = [];
  const sanitizeList = (raw: unknown): string[] => {
    const list = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    const kept: string[] = [];
    // 本列表的待丢弃项先记局部：是否真的丢取决于列表里是否还有可解析引用（见下方回退）。
    const droppedHere: string[] = [];
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
        droppedHere.push(source);
      }
    }
    if (kept.length > 0) {
      appendUnique(dropped, droppedHere);
      return kept;
    }
    // 全部无法解析时保留原列表——不能让净化把候选清成零证据（门禁的拒绝信息更权威）。
    // 这些引用一条都没被移除，只记 retainedUnresolved（I33）：计入 dropped 会让日志与
    // evidence_sanitized 统计把「原样交门禁」误报成「净化丢弃了证据」。
    appendUnique(retainedUnresolved, droppedHere);
    return list;
  };

  // 行号机械回填（run-7 M2）：无标签引用（search 类）放行后，手写 source 常缺 :line 触发
  // SOURCE_REF_LINE_MISSING。引用条目里其实有真实行号——ranged 条目同文件用其区间；
  // search 类条目 content 的 `path:NN:` 命中行用首个命中。回填只用被引用条目的采集内容
  // （机械真值，不是模型猜测），无法回填的保持原样交门禁给权威拒绝。
  const refs = Array.isArray(reasoning.evidenceRefs)
    ? (reasoning.evidenceRefs as unknown[]).filter(
        (ref): ref is string => typeof ref === 'string' && ref.trim().length > 0
      )
    : [];
  const backfillLine = (source: string): string => {
    if (/:\d+(?:-\d+)?$/.test(source.trim())) {
      return source;
    }
    const filePart = source.trim();
    for (const ref of refs) {
      const entry = ledger.get(ref);
      if (!entry) {
        continue;
      }
      if (entry.file && entry.range) {
        if (entry.file === filePart || entry.file.endsWith(`/${filePart}`)) {
          corrected.push(`${source}→${entry.file}:${entry.range.start}-${entry.range.end}`);
          return `${entry.file}:${entry.range.start}-${entry.range.end}`;
        }
        continue;
      }
      if (!entry.file) {
        // search 输出形态 `path:NN: text`——按行扫描找该文件的首个命中行，采集路径形态优先
        for (const line of entry.content.split('\n')) {
          const hit = /^(.+?):(\d+):/.exec(line);
          if (!hit) {
            continue;
          }
          const hitPath = hit[1].trim();
          if (hitPath === filePart || hitPath.endsWith(`/${filePart}`)) {
            corrected.push(`${source}→${hitPath}:${hit[2]}-${hit[2]}`);
            return `${hitPath}:${hit[2]}-${hit[2]}`;
          }
        }
      }
    }
    return source;
  };

  const sources = sanitizeList(reasoning.sources).map(backfillLine);
  const sourceRefs = sanitizeList(item.sourceRefs).map(backfillLine);

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
    retainedUnresolved,
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

/** 可由修复子调用处理的纯风格/措辞类拒因（证据类不在内——那是事实问题不是写法问题） */
const REPAIRABLE_STYLE_CODES = new Set([
  'DO_CLAUSE_NON_IMPERATIVE',
  'CONTENT_CONTRAST_MISSING',
  'GRAPH_REF_INVALID',
  'STAGE3_TITLE_TOO_GENERIC',
  'STAGE3_MARKDOWN_TOO_SHORT',
]);

export function isStyleRepairable(violations: Array<{ code: string }>): boolean {
  return violations.length > 0 && violations.every((v) => REPAIRABLE_STYLE_CODES.has(v.code));
}

function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const parsed = extractJSON(text, '{', '}', (level, message) => {
    if (level === 'warn') {
      Logger.getInstance().warn(message);
    }
  });
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * 修复子调用给模型展示的 markdown 窗口（按 UTF-16 code unit 计）。超出部分不进提示——
 * 这是 prompt 预算，不是允许截断正文的许可：未展示尾部必须由程序原样拼回（I32）。
 */
const STYLE_REPAIR_MARKDOWN_WINDOW = 1800;

/** 修复子调用返回 JSON 里程序认识的键；contrastBlock 只是返回契约，不会成为候选字段。 */
type StyleRepairField = 'title' | 'doClause' | 'dontClause' | 'markdown' | 'contrastBlock';
const STYLE_REPAIR_FIELDS: ReadonlySet<string> = new Set<StyleRepairField>([
  'title',
  'doClause',
  'dontClause',
  'markdown',
  'contrastBlock',
]);

/**
 * 违规码 → 修复子调用可采纳的返回字段（I32）。模型只被允许改「被拒字段」：
 * - DO_CLAUSE_* / DONT_CLAUSE_*（祈使/英文措辞）→ doClause / dontClause；
 * - STAGE3_TITLE_TOO_GENERIC → title；
 * - CONTENT_CONTRAST_MISSING → contrastBlock（只返回要追加的对比块，程序拼到完整原文末尾）；
 *   兼容模型仍回传整段 markdown 的旧形态，但必须过 mergeRepairedMarkdown 的保真校验；
 * - STAGE3_MARKDOWN_TOO_SHORT → markdown（正文 <200 字必然整段可见，整体替换安全）；
 * - GRAPH_REF_INVALID → markdown / doClause / dontClause（调用链断言可能落在正文或条款）。
 * 映射之外的返回键一律丢弃并留痕——此前只报 DO_CLAUSE 时模型顺带回显的（截断）markdown
 * 也会整体覆盖原文。
 */
function repairableFieldsFor(violations: Array<{ code: string }>): Set<StyleRepairField> {
  const fields = new Set<StyleRepairField>();
  for (const violation of violations) {
    const code = violation.code;
    if (code.startsWith('DO_CLAUSE_') || code.startsWith('DONT_CLAUSE_')) {
      fields.add('doClause');
      fields.add('dontClause');
    } else if (code === 'STAGE3_TITLE_TOO_GENERIC') {
      fields.add('title');
    } else if (code === 'CONTENT_CONTRAST_MISSING') {
      fields.add('contrastBlock');
      fields.add('markdown');
    } else if (code === 'STAGE3_MARKDOWN_TOO_SHORT') {
      fields.add('markdown');
    } else if (code === 'GRAPH_REF_INVALID') {
      fields.add('markdown');
      fields.add('doClause');
      fields.add('dontClause');
    }
  }
  return fields;
}

/** 在完整正文末尾追加一段块（保证块从新行开始，原文一字不改）。 */
function appendMarkdownBlock(base: string, block: string): string {
  const separator = base.endsWith('\n') || block.startsWith('\n') ? '' : '\n';
  return `${base}${separator}${block}`;
}

type MarkdownMerge =
  | { markdown: string; mode: 'full-view' | 'complete' | 'appended' }
  | { markdown: null; reason: string };

/**
 * 把模型返回的 markdown 合并回完整原文（I32 保真规则）。模型只看到前 WINDOW 字符：
 * - 原文未超窗：模型看过全文，整体替换照常采纳（门禁重验兜底）；
 * - 原文超窗且返回值以展示前缀原样开头（忽略前缀末尾空白——模型常 trim 后再追加）：
 *   · 前缀之后紧接原文剩余部分 → 返回值已含全文，原样采纳；
 *   · 否则把前缀之后的部分视为「追加块」，拼到完整原文末尾（未展示尾部一字不丢）；
 * - 原文超窗且返回值不以展示前缀开头：无法判断哪些原文被改写或丢弃，整个字段丢弃
 *   （调用方回落到既有拒绝/advisory 路径——比把截断正文入库安全）。
 */
function mergeRepairedMarkdown(original: string, returned: string): MarkdownMerge {
  if (original.length <= STYLE_REPAIR_MARKDOWN_WINDOW) {
    return { markdown: returned, mode: 'full-view' };
  }
  const shownPrefix = original.slice(0, STYLE_REPAIR_MARKDOWN_WINDOW).trimEnd();
  if (shownPrefix.length === 0 || !returned.startsWith(shownPrefix)) {
    return {
      markdown: null,
      reason: `original exceeds the ${STYLE_REPAIR_MARKDOWN_WINDOW}-char window (${original.length} chars) and the reply (${returned.length} chars) does not start with the shown prefix`,
    };
  }
  const rest = returned.slice(shownPrefix.length);
  const hiddenRemainder = original.slice(shownPrefix.length);
  if (rest.startsWith(hiddenRemainder)) {
    return { markdown: returned, mode: 'complete' };
  }
  return { markdown: appendMarkdownBlock(original, rest), mode: 'appended' };
}

/**
 * E7-R 修复子调用（接受率 100% 的最后一级）：纯风格类拒绝时发起一次 schema 收窄的 LLM
 * 修复——只返回需要修改的字段 JSON，其余字段程序保留原值，修复后由调用方重跑权威门禁。
 * E6 三跑证明拒绝反馈+模板都无法稳定驱动 DeepSeek 自修（DO_CLAUSE 连续三跑最高频）；
 * 把「重写整个候选」压缩为「填 2 个字段」后服从面大幅收窄。任何失败返回 null（绝不阻断原拒绝路径）。
 *
 * I32 字段契约：返回键按违规码限定（repairableFieldsFor），越界键丢弃并 warn；
 * markdown 经 mergeRepairedMarkdown 保真合并，contrastBlock 由程序追加到完整原文末尾——
 * 修复子调用不得让入库正文比不修更短。
 */
export async function repairStyleViolations(
  item: Record<string, unknown>,
  violations: Array<{ code: string; message?: string }>,
  provider: unknown,
  allowlist: { positive: string[]; negative: string[] },
  options: OperationOptions = {}
): Promise<Record<string, unknown> | null> {
  const providerLike = provider as {
    chat?: (prompt: string, context?: Record<string, unknown>) => Promise<string>;
  } | null;
  if (typeof providerLike?.chat !== 'function') {
    // 降级必须可观测：provider 缺 chat 面时修复层等于不存在
    Logger.getInstance().warn('[style-repair] skipped: provider has no chat() surface');
    return null;
  }
  // 必须 bind——解引用后裸调用会丢 this，provider 实现内部一用 this 即抛 TypeError（run-4 零触发根因）
  const chat = providerLike.chat.bind(providerLike);
  const content = (item.content ?? {}) as Record<string, unknown>;
  const markdown = typeof content.markdown === 'string' ? content.markdown : '';
  const titleForLog = String(item.title ?? '');
  const codes = violations.map((v) => v.code);
  const allowed = repairableFieldsFor(violations);
  const markdownTruncated = markdown.length > STYLE_REPAIR_MARKDOWN_WINDOW;
  const prompt = [
    '你是候选修复器。以下知识候选被写作风格门禁拒绝，修复它——只改被拒字段，保留全部事实与引用。',
    `违规: ${violations.map((v) => `${v.code}${v.message ? `(${v.message.slice(0, 80)})` : ''}`).join('; ')}`,
    `候选字段: ${JSON.stringify(
      {
        title: item.title,
        doClause: item.doClause,
        dontClause: item.dontClause,
        markdown: markdown.slice(0, STYLE_REPAIR_MARKDOWN_WINDOW),
        ...(markdownTruncated ? { markdownTruncated: true } : {}),
      },
      null,
      0
    )}`,
    `修复要求: doClause 必须以下列动词之一开头(${allowlist.positive.slice(0, 12).join('/')}；否定式 ${allowlist.negative.slice(0, 6).join('/')})；`,
    'CONTENT_CONTRAST_MISSING→只返回 contrastBlock 键（不要回传 markdown）：内容为"✅ 正确：<真实做法> (来源: 沿用原文引用)\\n❌ 错误：<反例>\\n违反后果：<一句>"，程序会把它追加到完整正文末尾；',
    'GRAPH_REF_INVALID→把调用链断言(callers/invokes/调用链)改写为静态描述(导入/依赖/组合)或删除该句；',
    ...(markdownTruncated
      ? [
          `注意: markdown 只展示了前 ${STYLE_REPAIR_MARKDOWN_WINDOW} 字符(markdownTruncated=true)，未展示部分会由程序原样保留；如返回 markdown，必须以展示内容原样开头、只在其后追加，否则该键会被丢弃；`,
        ]
      : []),
    `只返回一个 JSON 对象，仅含需要修改的字段(本次可用键: ${[...allowed].join(', ')})，不要任何其它文字。`,
  ].join('\n');
  try {
    // 修复是可选子调用，期限属于此调用层；取消等待后不再消费不合作 provider 的迟到响应。
    const outcome = await runOperation(
      (abortSignal) => chat(prompt, { maxTokens: 1600, temperature: 0, abortSignal }),
      { abortSignal: options.abortSignal, timeoutMs: options.timeoutMs ?? 30_000 }
    );
    if (outcome.status !== 'ok') {
      const detail =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? '');
      Logger.getInstance().warn(`[style-repair] ${outcome.status}${detail ? `: ${detail}` : ''}`);
      return null;
    }
    const raw = outcome.value;
    const fixed = extractFirstJsonObject(String(raw ?? ''));
    if (!fixed) {
      Logger.getInstance().warn(
        `[style-repair] unparseable response head: ${String(raw ?? '').slice(0, 120)}`
      );
      return null;
    }
    const pick = (key: string): string | null =>
      typeof fixed[key] === 'string' && (fixed[key] as string).trim()
        ? (fixed[key] as string)
        : null;
    // 越界键（映射外或未知）：丢弃并集中留痕——这是「只改被拒字段」契约的程序侧执行。
    const dropped: string[] = [];
    const takeField = (key: StyleRepairField): string | null => {
      const value = pick(key);
      if (value === null) {
        return null;
      }
      if (!allowed.has(key)) {
        dropped.push(key);
        return null;
      }
      return value;
    };
    for (const key of Object.keys(fixed)) {
      if (!STYLE_REPAIR_FIELDS.has(key)) {
        dropped.push(key);
      }
    }
    const nextTitle = takeField('title');
    const nextDo = takeField('doClause');
    const nextDont = takeField('dontClause');
    let nextMarkdown: string | null = null;
    const returnedMarkdown = takeField('markdown');
    if (returnedMarkdown !== null) {
      const merged = mergeRepairedMarkdown(markdown, returnedMarkdown);
      if (merged.markdown === null) {
        // 降级必须可观测：保真校验不过的正文丢弃，原文原样保留给后续拒绝/advisory 路径
        Logger.getInstance().warn(
          `[style-repair] dropped field markdown for "${titleForLog}": ${merged.reason}`
        );
      } else {
        nextMarkdown = merged.markdown;
        Logger.getInstance().info(
          `[style-repair] markdown merged (${merged.mode}) for "${titleForLog}": ${markdown.length}→${merged.markdown.length} chars`
        );
      }
    }
    const contrastBlock = takeField('contrastBlock');
    if (contrastBlock !== null) {
      if (!contrastBlock.includes('✅') || !contrastBlock.includes('❌')) {
        // 对比块必须同时带 ✅/❌ 标记，否则追加也修不掉 CONTENT_CONTRAST_MISSING——不污染正文
        Logger.getInstance().warn(
          `[style-repair] dropped field contrastBlock for "${titleForLog}": missing ✅/❌ markers`
        );
      } else {
        nextMarkdown = appendMarkdownBlock(nextMarkdown ?? markdown, contrastBlock.trim());
      }
    }
    if (dropped.length > 0) {
      Logger.getInstance().warn(
        `[style-repair] dropped field ${dropped.join(', ')} for "${titleForLog}": not repairable under [${codes.join(', ')}] (allowed: ${[...allowed].join(', ') || 'none'})`
      );
    }
    if (!nextTitle && !nextDo && !nextDont && nextMarkdown === null) {
      Logger.getInstance().warn(
        `[style-repair] no adoptable field in reply for "${titleForLog}" (violations: ${codes.join(', ')})`
      );
      return null;
    }
    return {
      ...item,
      ...(nextTitle ? { title: nextTitle } : {}),
      ...(nextDo ? { doClause: nextDo } : {}),
      ...(nextDont ? { dontClause: nextDont } : {}),
      ...(nextMarkdown !== null ? { content: { ...content, markdown: nextMarkdown } } : {}),
    };
  } catch (err: unknown) {
    // 降级必须可观测：修复子调用失败原样走拒绝路径，但失败原因必须留痕
    Logger.getInstance().warn(
      `[style-repair] chat failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * 拒收治理（2026-07-05 用户裁定"证据足够尽量收"）：refs 缺席但手写 sources 命中台账
 * 同文件条目时，机械回填 evidenceRefs——模型引用了真实采集过的文件却忘（或不会）抄 E-id，
 * 此前直接 EVIDENCE_REFS_REQUIRED 硬拒烧一回合再自救。推断只映射到真实条目
 * （exact file 匹配，每文件一条，上限 5），事实面零发明；回填后仍走展开+新鲜度全链。
 *
 * 条目选择（I33）：searchByFile 是子串匹配，前几条可能全被 app.tsx、其它前缀的同名文件占满，
 * 所以取全量命中后先精确过滤；同文件多条时优先最新的带区间条目（可做新鲜度终检、展开为
 * 真实引用区间——run 中途文件变更后重读的新条目也由此胜出），没有带区间条目才取最新的
 * file-only 条目。
 */
export function inferEvidenceRefsFromSources(
  item: Record<string, unknown>,
  ledger: EvidenceLedgerLike | null | undefined
): string[] {
  if (!ledger?.searchByFile) {
    return [];
  }
  // 扫描上限取台账全量条目数：小上限会让子串干扰项挤掉精确条目（I33）。
  const scanLimit = ledger.stats().entries;
  if (scanLimit === 0) {
    return [];
  }
  const reasoning = (item.reasoning ?? {}) as Record<string, unknown>;
  const sources = Array.isArray(reasoning.sources) ? reasoning.sources : [];
  const inferred: string[] = [];
  const seenFiles = new Set<string>();
  for (const raw of sources) {
    if (typeof raw !== 'string' || !raw.trim()) {
      continue;
    }
    const filePart = (/^(.*?)(?::\d+(?:-\d+)?)?$/.exec(raw.trim())?.[1] ?? '').trim();
    if (!filePart || seenFiles.has(filePart)) {
      continue;
    }
    seenFiles.add(filePart);
    // searchByFile 按采集序（旧→新）返回，findLast 即「最新」。
    const substringHits = ledger.searchByFile(filePart, scanLimit);
    const exact = substringHits.filter((entry) => entry.file === filePart);
    const latestRanged = exact.findLast((entry) => entry.range !== undefined);
    const chosen = latestRanged ?? exact[exact.length - 1];
    if (!chosen) {
      // 跳过留痕：该手写来源没有同路径台账条目（子串命中不算——推断只映射精确文件）。
      Logger.getInstance().debug(
        `[knowledge.submit] evidenceRefs inference skipped ${filePart}: no exact-file ledger entry (${substringHits.length} substring hits ignored)`
      );
      continue;
    }
    if (exact.length > 1 || !latestRanged) {
      // 有取舍才留痕：多条同文件条目里选了哪条、是否退到 file-only 条目。
      Logger.getInstance().debug(
        `[knowledge.submit] evidenceRefs inference for ${filePart}: picked ${chosen.id} (${latestRanged ? 'newest ranged entry' : 'newest file-only entry, no ranged entry captured'}) among ${exact.length} exact-file entries`
      );
    }
    inferred.push(chosen.id);
    if (inferred.length >= 5) {
      break;
    }
  }
  return inferred;
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
  // I33：listRecent 按采集序（旧→新）返回尾部，倒序后从新到旧扫描——同一文件常先被
  // code.search（file-only）再被 code.read（带区间）采集，先到先得会让旧的无区间条目占位。
  const recent = [...ledger.listRecent(50)].reverse();
  // 第一遍：每个文件取最新的带区间条目（可直接照抄 id 且能机械展开出 sources），最多 5 个文件。
  const ranged: string[] = [];
  const shownFiles = new Set<string>();
  for (const candidate of recent) {
    if (ranged.length >= 5) {
      break;
    }
    if (!candidate.file || !candidate.range || shownFiles.has(candidate.file)) {
      continue;
    }
    shownFiles.add(candidate.file);
    ranged.push(
      `${candidate.id}=${candidate.file}:${candidate.range.start}-${candidate.range.end}`
    );
  }
  // 第二遍：其余文件（没有带区间条目，或带区间条目超出展示上限）只补裸文件名兜底，同样新→旧，最多 5 个。
  const files: string[] = [];
  for (const candidate of recent) {
    if (files.length >= 5) {
      break;
    }
    if (!candidate.file || shownFiles.has(candidate.file)) {
      continue;
    }
    shownFiles.add(candidate.file);
    files.push(candidate.file);
  }
  if (ranged.length === 0 && files.length === 0) {
    return '';
  }
  const rangedPart =
    ranged.length > 0 ? ` 可直接引用的带区间条目(最新优先): ${ranged.join('; ')}。` : '';
  const filesPart = files.length > 0 ? ` 其它可引用文件: ${files.join(', ')}。` : '';
  return ` 📎 台账共 ${stats.distinctFiles} 个可引用文件。${rangedPart}${filesPart} 用 memory.recall 查看 findings 携带的 [E-x] 或 evidence.search 查条目 id，以 reasoning.evidenceRefs 引用（优先带文件区间的条目；引用 id 最稳，不要凭记忆手写路径）。`;
}
