/**
 * @module tools/runtime/handlers/evidence
 *
 * evidence 工具（Wave A E4）——证据台账只读查询。
 * Actions: get, search
 *
 * 查已采证据不是探索：RECORD/VERIFY/produce 相均可用，为引用修正与 verbatim 取回
 * 提供自救通道（真机事故的结构性缺口之一：producer 被拒后无粮草可修）。
 * 只读、零文件系统访问；台账缺席（非维度运行）时显式失败而非静默空结果。
 *
 * 子区间坐标（I21）：`E-n@start-end` 的行号随条目而定——带 range 的条目（code.read 等
 * 文件区间采集）用文件行号，必须落在 range 内；无 range 的条目（search 分组、terminal 等）
 * 用条目内容内 1 起行号。台账对“id 存在但子区间取不到”和“id 不存在”都返回 null，
 * 这里在失败路径上再做一次归类，避免模型把有效证据当成无效 id 放弃。
 */

import { parseEvidenceRef } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
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
 * - unknown-ref：格式不合法或基础 id 不在台账（调用方沿用各自的“无法解析”文案与近期条目提示）；
 * - subrange-out-of-range：基础 id 存在，但子区间超出条目的行区间（常见于 range 条目误用相对行号）；
 * - subrange-truncated-tail：子区间在条目行区间内，但落在台账单条上限截断后的不可取尾部。
 */
export type EvidenceRefFailureKind =
  | 'unknown-ref'
  | 'subrange-out-of-range'
  | 'subrange-truncated-tail';

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
    logRefClassification({ surface, ref, kind: 'unknown-ref', reason: 'malformed-ref' });
    return { kind: 'unknown-ref', detail: null };
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
      detail: `子区间越界: "${ref}" 超出条目 ${view.id} 的行区间 ${formatInterval(view.declared)}。可用区间 ${availability}。子区间坐标: ${EVIDENCE_SUBRANGE_COORDINATE_NOTE}。`,
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
    const lines = entry.content.split('\n');
    const capped = lines.length > EVIDENCE_GET_MAX_LINES;
    const content = capped
      ? `${lines.slice(0, EVIDENCE_GET_MAX_LINES - 1).join('\n')}\n${cappedNotice(ledger, entry, parseEvidenceRef(ref)?.range)}`
      : entry.content;
    return ok({
      id: entry.id,
      ...(entry.file ? { file: entry.file } : {}),
      ...(entry.range ? { range: entry.range } : {}),
      lineCount: lines.length,
      capped,
      content,
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
