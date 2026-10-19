/**
 * @module tools/runtime/handlers/evidence
 *
 * evidence 工具（Wave A E4）——证据台账只读查询。
 * Actions: get, search
 *
 * 查已采证据不是探索：RECORD/VERIFY/produce 相均可用，为引用修正与 verbatim 取回
 * 提供自救通道（真机事故的结构性缺口之一：producer 被拒后无粮草可修）。
 * 只读：从不写台账；台账缺席（非维度运行）时显式失败而非静默空结果。
 *
 * 子区间坐标（I21）：`E-n@start-end` 的行号随条目而定——带 range 的条目（code.read 等
 * 文件区间采集）用文件行号，必须落在 range 内；无 range 的条目（search 分组、terminal 等）
 * 用条目内容内 1 起行号。台账对“id 存在但子区间取不到”和“id 不存在”都返回 null，
 * 这里在失败路径上再做一次归类，避免模型把有效证据当成无效 id 放弃。
 *
 * 原文回读（脱敏阶段 2 方案 C，D4）：台账落盘内容是脱敏后的文本，模型照抄进 coreCode 会过不了
 * fs 逐字校验。对带 range、来源不是 secret-bearing 的 code.read 条目（含 `E-n@a-b` 子区间），
 * get 在项目根内解析路径、只读一次文件缓冲区、在同一份缓冲区上判 freshness：fresh 时返回原文
 * 切片并标 `verbatim: true`；stale、读取失败或不允许回读时返回存储内容，附
 * `redaction: {markers, lines}` 标注与“需要逐字代码请对 file:range 调用 code.read”提示。
 * 回读只发生在读路径上：evidence.get 不是证据工具，结果不会被采集回台账；它的结果进入开发者
 * 事件时仍经 processEvents 脱敏。模型本来就经 code.read 看过同一份原文，没有新增暴露。
 */

import { readFileSync } from 'node:fs';
import { parseEvidenceRef } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { resolveProjectPath } from '#shared/projectPath.js';
import type { EvidenceLedgerLike } from '#tools/kernel/context.js';
import { fail, ok, type ToolContext, type ToolResult } from '#tools/kernel/registry.js';

/** 单次 get 取回的行数预算——超限保头截断并提示用子区间缩小范围 */
export const EVIDENCE_GET_MAX_LINES = 120;

/**
 * 子区间坐标说明单源（模型可见）：evidence.get、note_finding 与 knowledge.submit 的拒绝文案共用，
 * 保证三个入口对同一引用语法给出同一套坐标解释。
 */
export const EVIDENCE_SUBRANGE_COORDINATE_NOTE =
  'range 条目用文件行号，无 range 条目用条目内 1 起行号';

const SEARCH_LIMIT_MAX = 8;

/**
 * 引用解析失败的归类：
 * - unknown-ref：格式不合法（连 `E-n@...` 的基础 id 都提不出）或基础 id 不在台账（调用方沿用各自的
 *   “无法解析”文案与近期条目提示）；
 * - subrange-out-of-range：基础 id 存在，但子区间超出条目的行区间（常见于 range 条目误用相对行号，
 *   以及按 0 起行号书写的 `E-n@0-k`）；
 * - subrange-truncated-tail：子区间在条目行区间内，但落在台账单条上限截断后的不可取尾部；
 * - subrange-malformed：基础 id 存在，但子区间写法不合法（起止颠倒、只写单个行号、数字间含空格）。
 */
export type EvidenceRefFailureKind =
  | 'unknown-ref'
  | 'subrange-out-of-range'
  | 'subrange-truncated-tail'
  | 'subrange-malformed';

export interface EvidenceRefFailure {
  readonly kind: EvidenceRefFailureKind;
  /** 子区间类失败的模型可见说明（不含调用方前缀）；unknown-ref 时为 null */
  readonly detail: string | null;
}

interface LineInterval {
  readonly start: number;
  readonly end: number;
}

/** 条目在子区间坐标系下的行区间事实（只描述，不改变台账行为） */
interface EvidenceLineView {
  readonly id: string;
  readonly file?: string;
  readonly coordinate: 'file' | 'entry';
  /** 条目声明的行区间：range 条目=range；无 range 条目=1..内容行数 */
  readonly declared: LineInterval;
  /** 台账实际可按子区间取回的区间（已扣除截断尾部）；null=没有任何可取的完整行 */
  readonly available: LineInterval | null;
}

type EvidenceEntryLike = NonNullable<ReturnType<EvidenceLedgerLike['get']>>;

function formatInterval(interval: LineInterval | null): string {
  return interval ? `${interval.start}-${interval.end}` : 'none';
}

/**
 * 以台账自身为判据探测可取区间：固定起点 declared.start，二分查找最大可取终点。
 *
 * 为何不在这里复算截断：截断标记与“标记前半行不可取”的规则属于台账实现（agent/evidence），
 * tools 层不能反向依赖；让台账回答“这个子区间能不能取”，保证提示与 get 的真实行为同源。
 * 固定起点后可取性对终点单调（终点越小越可取），二分最多 log2(行数) 次只读 get，
 * 且只发生在失败归类与超预算提示两条路径上。
 */
function probeAvailableInterval(
  ledger: EvidenceLedgerLike,
  id: string,
  declared: LineInterval
): LineInterval | null {
  const reachable = (end: number): boolean => ledger.get(`${id}@${declared.start}-${end}`) !== null;
  if (!reachable(declared.start)) {
    return null;
  }
  if (reachable(declared.end)) {
    return { start: declared.start, end: declared.end };
  }
  // 不变式：low 可取、high 不可取
  let low = declared.start;
  let high = declared.end;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (reachable(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return { start: declared.start, end: low };
}

function resolveLineView(ledger: EvidenceLedgerLike, base: EvidenceEntryLike): EvidenceLineView {
  const declared: LineInterval = base.range
    ? { start: base.range.start, end: base.range.end }
    : { start: 1, end: base.content.split('\n').length };
  return {
    id: base.id,
    ...(base.file ? { file: base.file } : {}),
    coordinate: base.range ? 'file' : 'entry',
    declared,
    available: probeAvailableInterval(ledger, base.id, declared),
  };
}

/** 可用区间的模型可见说明：区间 + 坐标系 + 截断尾部（如有） */
function describeAvailability(view: EvidenceLineView): string {
  const coordinate =
    view.coordinate === 'file'
      ? `${view.file ? `${view.file} 的` : ''}文件行号`
      : '条目内 1 起行号';
  if (!view.available) {
    // EvidenceLedgerStore 只在“截断标记前不剩完整行”时走到这里；其它台账实现原因未知，不断言成因
    return `无（条目 ${view.id} 没有可按子区间取回的完整行，通常是内容在台账单条上限处被截断；请改用整条 "${view.id}"）`;
  }
  const tail =
    view.available.end < view.declared.end
      ? `；${view.available.end + 1}-${view.declared.end} 位于截断尾部，不可取`
      : '';
  return `${formatInterval(view.available)}（${coordinate}${tail}）`;
}

function logRefClassification(fields: {
  surface: string;
  ref: string;
  kind: EvidenceRefFailureKind;
  reason: string;
  view?: EvidenceLineView;
}): void {
  const viewPart = fields.view
    ? ` id=${fields.view.id} coordinate=${fields.view.coordinate} declared=${formatInterval(fields.view.declared)} available=${formatInterval(fields.view.available)}`
    : '';
  const message = `[evidence] unresolved ref classified surface=${fields.surface} ref=${JSON.stringify(fields.ref)} kind=${fields.kind} reason=${fields.reason}${viewPart}`;
  observeSafely(
    () => Logger.getInstance().info(message),
    () => undefined
  );
}

function outOfRangeDetail(
  ref: string,
  view: EvidenceLineView,
  availability: string,
  startNote = ''
): string {
  return `子区间越界: "${ref}" 超出条目 ${view.id} 的行区间 ${formatInterval(view.declared)}${startNote}。可用区间 ${availability}。子区间坐标: ${EVIDENCE_SUBRANGE_COORDINATE_NOTE}。`;
}

/**
 * 宽松提取 `E-n@start[-end]` 的基础 id 与数字（容忍空格、缺终点）。只在 Core parseEvidenceRef
 * 已判非法时使用，目的仅是“用基础 id 再查台账”，不放宽台账自身的取回语法。
 */
const LENIENT_SUBRANGE_REF_RE = /^\s*(E-\d+)\s*@\s*(\d+)(?:\s*-\s*(\d+))?\s*$/;

/**
 * Core parseEvidenceRef 判非法的引用（C059）：Core 对 start<1、end<start 直接返回 null，台账因此连基础 id
 * 都不查。若宽松提取出的基础 id 在台账里，就不能再报“无法解析 / 不在证据台账”——模型会把有效证据当
 * 无效 id 放弃（I21 原症状）。归类规则：
 * - 起点 0（start<1 且起止不颠倒）：两种坐标系下都落在行区间外，按子区间越界报，并注明行号从 1 起；
 * - 含空格、只写单个行号、起止颠倒：语法错误，单独一类文案，写明合法写法；
 * 两类都附可用区间。提不出基础 id 或基础 id 不在台账时仍返回 unknown-ref。
 */
function classifyMalformedRef(
  ledger: EvidenceLedgerLike,
  ref: string,
  surface: string
): EvidenceRefFailure {
  const match = LENIENT_SUBRANGE_REF_RE.exec(ref);
  const baseId = match?.[1];
  if (!match || !baseId || match[2] === undefined) {
    logRefClassification({ surface, ref, kind: 'unknown-ref', reason: 'malformed-ref' });
    return { kind: 'unknown-ref', detail: null };
  }
  const base = ledger.get(baseId);
  if (!base) {
    logRefClassification({ surface, ref, kind: 'unknown-ref', reason: 'id-not-in-ledger' });
    return { kind: 'unknown-ref', detail: null };
  }

  const view = resolveLineView(ledger, base);
  const availability = describeAvailability(view);
  const start = Number(match[2]);
  const end = match[3] === undefined ? null : Number(match[3]);
  // 判定顺序：先语法（空格 / 单行号 / 颠倒），再起点 0；同时命中时按语法报，语法文案已含 1≤start 的约束
  let syntaxReason: string | null = null;
  if (/\s/.test(ref.trim())) {
    syntaxReason = 'malformed-subrange-whitespace';
  } else if (end === null) {
    syntaxReason = 'malformed-subrange-single-line';
  } else if (end < start) {
    syntaxReason = 'malformed-subrange-reversed';
  } else if (start >= 1) {
    // Core 现行规则下不可达（非空格、两端齐全、不颠倒、起点≥1 必能解析）；Core 规则若收紧，
    // 仍按语法错误给出合法写法，并在 reason 上标明未识别的拒绝原因以便复核
    syntaxReason = 'malformed-subrange-unrecognized';
  }

  if (syntaxReason) {
    logRefClassification({ surface, ref, kind: 'subrange-malformed', reason: syntaxReason, view });
    return {
      kind: 'subrange-malformed',
      detail: `子区间语法错误: "${ref}" 不是合法的子区间写法，需写成 ${view.id}@start-end（数字间不含空格，且 1≤start≤end）。可用区间 ${availability}。子区间坐标: ${EVIDENCE_SUBRANGE_COORDINATE_NOTE}。`,
    };
  }
  logRefClassification({
    surface,
    ref,
    kind: 'subrange-out-of-range',
    reason: 'malformed-subrange-start-zero',
    view,
  });
  return {
    kind: 'subrange-out-of-range',
    detail: outOfRangeDetail(ref, view, availability, '（行号从 1 起，不存在第 0 行）'),
  };
}

/**
 * 对 `ledger.get(ref)` 已返回 null 的引用做失败归类（evidence.get / note_finding / knowledge.submit 共用）。
 *
 * 只在失败路径调用：基础 id 存在时说明子区间为何取不到并给出可用区间；基础 id 不存在或格式非法时
 * 返回 unknown-ref，由调用方保留各自的“无法解析”文案。每次归类都输出一条诊断日志。
 */
export function classifyUnresolvedEvidenceRef(
  ledger: EvidenceLedgerLike,
  ref: string,
  surface: string
): EvidenceRefFailure {
  const parsed = parseEvidenceRef(ref);
  if (!parsed) {
    return classifyMalformedRef(ledger, ref, surface);
  }
  const requested = parsed.range;
  const base = ledger.get(parsed.id);
  if (!base || !requested) {
    // 无子区间的整条引用失败只可能是 id 不在台账；base 在场却无子区间说明台账在两次读取间变化
    logRefClassification({
      surface,
      ref,
      kind: 'unknown-ref',
      reason: base ? 'whole-ref-unresolved' : 'id-not-in-ledger',
    });
    return { kind: 'unknown-ref', detail: null };
  }

  const view = resolveLineView(ledger, base);
  const outside = requested.start < view.declared.start || requested.end > view.declared.end;
  if (!outside && view.available && requested.end <= view.available.end) {
    // 区间在声明范围内、探测也显示可取，台账却拒绝——说明台账实现与本归类的假设不一致。
    // 不编造原因：降级为 unknown-ref 文案，并以 warn 留下可复核的输入。
    observeSafely(
      () =>
        Logger.getInstance().warn(
          `[evidence] sub-range rejected by ledger but probed as available; falling back to unknown-ref wording surface=${surface} ref=${JSON.stringify(ref)} declared=${formatInterval(view.declared)} available=${formatInterval(view.available)}`
        ),
      () => undefined
    );
    return { kind: 'unknown-ref', detail: null };
  }

  const availability = describeAvailability(view);
  if (outside) {
    logRefClassification({
      surface,
      ref,
      kind: 'subrange-out-of-range',
      reason: 'outside-declared-lines',
      view,
    });
    return {
      kind: 'subrange-out-of-range',
      detail: outOfRangeDetail(ref, view, availability),
    };
  }
  logRefClassification({
    surface,
    ref,
    kind: 'subrange-truncated-tail',
    reason: 'beyond-captured-lines',
    view,
  });
  return {
    kind: 'subrange-truncated-tail',
    detail: `子区间位于截断尾部: "${ref}" 落在条目 ${view.id} 被台账单条上限截断后的不可取部分。可用区间 ${availability}。`,
  };
}

/**
 * 超行数预算提示：按条目坐标系写明已展示的行区间，并给出紧接其后的、可直接使用的子区间示例。
 * range 条目（含其子区间副本）以 entry.range.start 为首行；无 range 条目以请求子区间起点
 * （整条取回时为 1）为首行。整条取回的末行要扣除截断尾部（问台账），子区间切片本身全部可取。
 */
function cappedNotice(
  ledger: EvidenceLedgerLike,
  entry: EvidenceEntryLike,
  requested: LineInterval | undefined
): string {
  const shownCount = EVIDENCE_GET_MAX_LINES - 1;
  const firstLine = entry.range?.start ?? requested?.start ?? 1;
  const shownEnd = firstLine + shownCount - 1;
  const coordinate = entry.range
    ? `file line numbers${entry.file ? ` of ${entry.file}` : ''}`
    : '1-based line numbers within the entry';
  const head = `…[capped at ${EVIDENCE_GET_MAX_LINES} lines — showing ${firstLine}-${shownEnd} (${coordinate}); narrow with "${entry.id}@start-end"`;
  const lastAvailable = requested
    ? requested.end
    : (resolveLineView(ledger, entry).available?.end ?? null);
  if (lastAvailable === null) {
    // 探测不到可取区间（非常规台账实现）：只给通用提示，不编造示例区间。
    observeSafely(
      () =>
        Logger.getInstance().debug(
          `[evidence] capped notice without example: no available sub-range probed id=${entry.id} firstLine=${firstLine}`
        ),
      () => undefined
    );
    return `${head}]`;
  }
  if (lastAvailable <= shownEnd) {
    return `${head}; the remaining lines are the truncated tail and cannot be retrieved]`;
  }
  const nextStart = shownEnd + 1;
  const nextEnd = Math.min(lastAvailable, nextStart + EVIDENCE_GET_MAX_LINES - 1);
  return `${head}, e.g. "${entry.id}@${nextStart}-${nextEnd}"]`;
}

/**
 * 台账脱敏标记的封闭词表（设计 4.6：标记文字不换）：`[redacted]`、`[redacted-private-key]`、
 * `[redacted-api-key]`、`[redacted-google-api-key]`、`[redacted-token]`、`[redacted-nested-value]`、
 * 阶段 1 的 `[redacted-unaligned]`。tools 层不能依赖 agent/utils/Redaction，这里按词表形态识别；
 * 文件原文里本来就有的同形字面量也会被计入，只用于标注与诊断，不参与任何放行判定。
 */
const REDACTION_MARKER_SOURCE = String.raw`\[(redacted(?:-[a-z]+)*)\]`;
/** 标注里最多列出的行号个数；markers 仍是全量计数 */
const REDACTION_MARKER_LINES_MAX = 50;

export interface RedactionMarkerSummary {
  /** 标记总数 */
  readonly markers: number;
  /** 含标记的行号（按 firstLine 起算的坐标系），最多 REDACTION_MARKER_LINES_MAX 个 */
  readonly lines: readonly number[];
  /** 按标记种类计数，例如 { redacted: 2, 'redacted-private-key': 1 }；只含词表名，不含正文 */
  readonly kinds: Readonly<Record<string, number>>;
}

/**
 * 统计文本里的脱敏标记。evidence.get 的 redaction 标注、recipeProductionAdapter 的
 * copied-redacted-evidence 诊断与循环台账的变换诊断共用这一份识别规则。
 */
export function summarizeRedactionMarkers(text: string, firstLine = 1): RedactionMarkerSummary {
  const lines: number[] = [];
  const kinds: Record<string, number> = {};
  let markers = 0;
  text.split('\n').forEach((line, index) => {
    // 每行新建正则：全局正则带 lastIndex 状态，不能做成模块级共享对象
    const found = [...line.matchAll(new RegExp(REDACTION_MARKER_SOURCE, 'g'))];
    if (found.length === 0) {
      return;
    }
    markers += found.length;
    for (const match of found) {
      const kind = match[1] ?? 'redacted';
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    if (lines.length < REDACTION_MARKER_LINES_MAX) {
      lines.push(firstLine + index);
    }
  });
  return { markers, lines, kinds };
}

/**
 * 台账的可选来源分类能力。分类表在 agent 层（src/agent/evidence/evidenceFileClass.ts），tools 层按
 * config/layer-contract.json 不能运行时依赖 agent，公开端口 EvidenceLedgerLike 也不加字段，所以
 * 由台账实现（EvidenceLedgerStore.classifyEvidenceSource）代答。不提供该能力的台账一律不回读原文。
 */
interface EvidenceSourceClassifier {
  classifyEvidenceSource(source: { readonly tool?: string; readonly file?: string }): unknown;
}

function hasSourceClassifier(
  ledger: EvidenceLedgerLike
): ledger is EvidenceLedgerLike & EvidenceSourceClassifier {
  return typeof Reflect.get(ledger, 'classifyEvidenceSource') === 'function';
}

/**
 * 允许回读原文的来源类别（白名单）。secret-bearing、terminal、无法识别的返回值一律不回读：
 * 分类表改名或扩展时宁可少回读，也不能静默放行。
 */
function isReadbackSourceClass(value: unknown): boolean {
  return value === 'source' || value === 'config';
}

/** 回读没有发生（返回存储内容）的原因；进入诊断日志并决定提示文案。 */
type ReadbackFallbackReason =
  | 'ledger-cannot-classify'
  | 'secret-bearing'
  | 'source-class-not-readable'
  | 'no-project-root'
  | 'outside-project-root'
  | 'unreadable'
  | 'stale'
  | 'freshness-unknown';

type VerbatimReadback =
  /** 条目不在回读范围内（非 code.read、无 file 或无 range）：返回形状与阶段 2 之前完全相同 */
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'verbatim'; readonly content: string }
  | { readonly kind: 'stored'; readonly reason: ReadbackFallbackReason };

type EntryWithRange = EvidenceEntryLike & {
  readonly file: string;
  readonly range: { readonly start: number; readonly end: number };
};

function isAccessDenied(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Access denied');
}

function describeReadError(err: unknown): string {
  if (err instanceof Error) {
    return 'code' in err && typeof err.code === 'string' ? err.code : err.name;
  }
  return typeof err;
}

/**
 * 回读决策诊断：verbatim 记 debug；降级为存储内容时记 info（缺项目根是测试/非宿主上下文，记 debug）。
 * 只记条目坐标、请求区间、原因与错误码，绝不记原文或存储内容。
 */
function logReadback(
  entry: EntryWithRange,
  outcome: 'verbatim' | 'stored',
  reason: string,
  detail = ''
): void {
  const message = `[evidence] verbatim readback ${outcome} entry=${entry.id} requested=${entry.range.start}-${entry.range.end} file=${JSON.stringify(entry.file)} reason=${reason}${detail ? ` ${detail}` : ''}`;
  observeSafely(
    () => {
      const logger = Logger.getInstance();
      if (outcome === 'verbatim' || reason === 'no-project-root') {
        logger.debug(message);
      } else {
        logger.info(message);
      }
    },
    () => undefined
  );
}

/**
 * 方案 C 的原文回读。顺序固定为：来源分类（声明路径）→ 项目根内解析（越界拒绝）→ 来源分类
 * （解析后的真实路径，挡住指向凭据文件的 symlink）→ 只读一次文件缓冲区 → 在同一份解码文本上
 * 判 freshness 并切片。前三步都不读文件内容；判定与返回用的是同一份字节，读取前后的并发改写
 * 只会让结论变成 stale，不会把两份字节混在一起。
 */
function resolveVerbatimReadback(
  ledger: EvidenceLedgerLike,
  ref: string,
  entry: EvidenceEntryLike,
  projectRoot: unknown
): VerbatimReadback {
  if (entry.tool !== 'code.read' || !entry.file || !entry.range) {
    return { kind: 'not-applicable' };
  }
  const target: EntryWithRange = { ...entry, file: entry.file, range: entry.range };
  const fallback = (reason: ReadbackFallbackReason, detail = ''): VerbatimReadback => {
    logReadback(target, 'stored', reason, detail);
    return { kind: 'stored', reason };
  };
  if (!hasSourceClassifier(ledger)) {
    return fallback('ledger-cannot-classify');
  }
  const declaredClass = ledger.classifyEvidenceSource({ tool: entry.tool, file: target.file });
  if (!isReadbackSourceClass(declaredClass)) {
    return fallback(
      declaredClass === 'secret-bearing' ? 'secret-bearing' : 'source-class-not-readable',
      `class=${String(declaredClass)} path=declared`
    );
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return fallback('no-project-root');
  }
  let resolved: { absolute: string; relative: string };
  try {
    resolved = resolveProjectPath(projectRoot, target.file);
  } catch (err: unknown) {
    return isAccessDenied(err)
      ? fallback('outside-project-root')
      : fallback('unreadable', `step=resolve error=${describeReadError(err)}`);
  }
  const resolvedClass = ledger.classifyEvidenceSource({
    tool: entry.tool,
    file: resolved.relative,
  });
  if (!isReadbackSourceClass(resolvedClass)) {
    return fallback(
      resolvedClass === 'secret-bearing' ? 'secret-bearing' : 'source-class-not-readable',
      `class=${String(resolvedClass)} path=resolved`
    );
  }
  let text: string;
  try {
    // 唯一一次读取：freshness 判定与返回切片都基于这份缓冲区解码出的同一个字符串
    text = readFileSync(resolved.absolute).toString('utf8');
  } catch (err: unknown) {
    return fallback('unreadable', `step=read error=${describeReadError(err)}`);
  }
  const freshness = ledger.checkFreshness(ref, text);
  if (freshness !== 'fresh') {
    return fallback(freshness === 'stale' ? 'stale' : 'freshness-unknown');
  }
  const lines = text.split('\n');
  if (target.range.start < 1 || target.range.end > lines.length) {
    // 台账判 fresh 时基础区间必在文件内；子区间又落在基础区间内。走到这里说明台账实现与本假设不一致。
    return fallback('stale', 'detail=range-outside-buffer');
  }
  logReadback(target, 'verbatim', 'fresh');
  return {
    kind: 'verbatim',
    content: lines.slice(target.range.start - 1, target.range.end).join('\n'),
  };
}

/** 未回读时给模型的提示：说明返回的是存储内容，以及如何拿到逐字代码。 */
function readbackHint(entry: EntryWithRange, reason: ReadbackFallbackReason): string {
  const location = `${entry.file}:${entry.range.start}-${entry.range.end}`;
  switch (reason) {
    case 'secret-bearing':
      return `${entry.file} 属于凭据类文件，evidence.get 不回读原文；这里是脱敏后的台账存储内容，不能当作逐字代码使用。`;
    case 'stale':
      return `条目采集后 ${entry.file} 已变更，这里是采集时的台账存储内容（可能含脱敏标记），不是当前源码；需要逐字代码请对 ${location} 调用 code.read。`;
    default:
      return `这里是台账存储内容（可能含脱敏标记），未能回读 ${entry.file} 原文；需要逐字代码请对 ${location} 调用 code.read。`;
  }
}

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const ledger = ctx.runtime?.evidenceLedger;
  if (!ledger) {
    return fail('evidence 工具仅在维度运行（证据台账在场）时可用');
  }

  if (action === 'get') {
    const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
    if (!ref) {
      return fail('evidence.get requires "ref" param, e.g. "E-3" or "E-3@5-12"');
    }
    const entry = ledger.get(ref);
    if (!entry) {
      const failure = classifyUnresolvedEvidenceRef(ledger, ref, 'evidence.get');
      if (failure.detail) {
        return fail(`evidence.get ${failure.detail}`);
      }
      const recent = ledger
        .listRecent(3)
        .map((item) => (item.file ? `${item.id}=${item.file}` : item.id))
        .join('; ');
      return fail(
        `evidence.get 无法解析 "${ref}"（只能引用 [evidence] 标注过的条目 id）。近期条目: ${recent || '(台账为空)'}`
      );
    }
    const readback = resolveVerbatimReadback(ledger, ref, entry, ctx.projectRoot);
    const shown = readback.kind === 'verbatim' ? readback.content : entry.content;
    const lines = shown.split('\n');
    const capped = lines.length > EVIDENCE_GET_MAX_LINES;
    const content = capped
      ? `${lines.slice(0, EVIDENCE_GET_MAX_LINES - 1).join('\n')}\n${cappedNotice(ledger, entry, parseEvidenceRef(ref)?.range)}`
      : shown;
    let readbackFields: Record<string, unknown> = {};
    if (readback.kind === 'verbatim') {
      readbackFields = { verbatim: true };
    } else if (readback.kind === 'stored' && entry.file && entry.range) {
      // 标注按条目坐标（文件行号）列出含标记的行，统计完整条目内容而不只是截到预算内的部分
      const summary = summarizeRedactionMarkers(entry.content, entry.range.start);
      readbackFields = {
        verbatim: false,
        redaction: { markers: summary.markers, lines: summary.lines },
        hint: readbackHint({ ...entry, file: entry.file, range: entry.range }, readback.reason),
      };
    }
    return ok({
      id: entry.id,
      ...(entry.file ? { file: entry.file } : {}),
      ...(entry.range ? { range: entry.range } : {}),
      lineCount: lines.length,
      capped,
      content,
      ...readbackFields,
    });
  }

  if (action === 'search') {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return fail('evidence.search requires "query" param (path fragment or content keyword)');
    }
    const rawLimit = typeof params.limit === 'number' ? params.limit : SEARCH_LIMIT_MAX;
    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(rawLimit)));
    const items = ledger.search(query, limit).map((entry) => {
      const firstLine = entry.content.split('\n', 1)[0] ?? '';
      return {
        id: entry.id,
        ...(entry.file ? { file: entry.file } : {}),
        ...(entry.range ? { range: entry.range } : {}),
        preview: firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine,
      };
    });
    return ok({ count: items.length, items });
  }

  return fail(`unknown evidence action: ${action}`);
}
