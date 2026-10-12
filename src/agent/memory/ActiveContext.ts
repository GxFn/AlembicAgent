/**
 * ActiveContext — 合并 WorkingMemory + ReasoningTrace 为统一的会话工作记忆
 *
 * 三个内部子区:
 *   1. Scratchpad   — Agent 通过 note_finding 主动标记的发现 (不可压缩)
 *   2. ObservationLog — 每轮 ReAct 记录 (合并原 RT.rounds + WM.observations，滑动窗口压缩)
 *   3. Plan          — 从 ReasoningTrace 继承的规划追踪
 *
 * 替代关系:
 *   WorkingMemory.js  → Scratchpad + 工具压缩策略 + buildContext + distill
 *   ReasoningTrace.js → rounds + plan + thoughts + extractAndSetPlan + observations
 *
 * 兼容性:
 *   - 提供所有 ReasoningTrace 和 WorkingMemory 的公共方法
 *   - ExplorationTracker 可直接使用 ActiveContext 作为 trace 参数 (L5 缓解)
 *   - MemoryCoordinator 通过 createDimensionScope 创建实例
 *
 * 生命周期: 单次 execute() 调用 (由 MemoryCoordinator 管理创建/蒸馏/销毁)
 *
 * @module ActiveContext
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { estimateTokens } from '#shared/tokenUtils.js';
import { isToolResultEnvelope, type ToolResultEnvelope } from '#tools/kernel/index.js';
import {
  createStrictAnalysisContextProjectionV1,
  type StrictAnalysisContextProjectionV1,
} from '../production/StrictProductionPipeline.js';
import {
  failedReadPaths,
  readToolObservation,
  successfulReadPaths,
} from '../utils/toolOutcomes.js';
import type { DistilledContext } from './MemoryFlushContract.js';

// ═══════════════════════════════════════════════════════════
// §1: 工具压缩策略 (从 WorkingMemory 迁入)
// ═══════════════════════════════════════════════════════════

/**
 * 压缩策略看到的调用上下文：params 已把 { action, params: {...} } 嵌套形态与扁平形态归一，
 * ok 是信封的执行真值（非信封结果视为成功）。单文件读取的载荷只有源码字符串，路径只能从这里取。
 */
interface CompressCall {
  params: Record<string, unknown>;
  ok: boolean;
}

/**
 * DeltaCache（src/tools/runtime/cache/DeltaCache.ts）对“内容未变且此前全文可见”的重读返回的占位文本。
 * 它不是一行源码：按行计数会把重读误报成“1 行”的文件。
 */
const DELTA_UNCHANGED_PLACEHOLDER = '[unchanged since last read]';

/** DeltaCache 指纹变化但逐行比较没有差异时的占位文本（computeSimpleDiff 的空 diff）。 */
const DELTA_NO_VISIBLE_CHANGES = '[no visible changes]';

/**
 * 以下标记全部来自 code.read 的展示态模板（src/tools/runtime/handlers/code.ts 与 router.ts），
 * 单文件读取的载荷只剩这个字符串，模式与文件总行数只能从这些标记里读，展示行数绝不是文件行数：
 *   - DeltaCache 增量重读：首行 `[delta: K hunk(s)]`，其后是 @@ 变更块，不是源码；
 *   - >500 行无范围读取：AST 大纲以 `File has N lines. Showing outline. …` 结尾，
 *     无 AST 时退回头尾预览，首行 `// <path> — N lines (showing head + tail)`；
 *   - maxLines 范围读：末尾 `... [N lines omitted; …]`，N 是展示末行之后的行数，标记行本身不是源码；
 *   - Router 按 maxOutputTokens 的头尾截断：中间插入 `... [N chars truncated, exceeded M token limit] ...`，
 *     标记前后的内容不连续，标记之后的首行可能只是半行。
 */
const READ_DELTA_HEADER_RE = /^\[delta: (\d+) hunk\(s\)\]/;
const READ_HEAD_TAIL_HEADER_RE = /^\/\/ .+ — (\d+) lines \(showing head \+ tail\)/;
const READ_OUTLINE_FOOTER_RE =
  /\nFile has (\d+) lines\. Showing outline\. Use startLine\/endLine to read specific sections\.\s*$/;
const READ_OMITTED_SUFFIX_RE =
  /\n?\.\.\. \[(\d+) lines omitted; use startLine\/endLine for more\]\s*$/;
const READ_ROUTER_TRUNCATION_RE =
  /\n\n\.\.\. \[\d+ chars truncated, exceeded \d+ token limit\] \.\.\.\n\n/;
/** handler 给每个源码行加的行号前缀 `42|`；全文读与范围读的每一行都带它。 */
const READ_LINE_PREFIX_RE = /^(\d+)\|/;

/** graph 查询里描述实体本身的类型；其余 type（callers/callees/impact/search/hierarchy…）是列表型回答。 */
const GRAPH_ENTITY_QUERY_TYPES = new Set(['class', 'protocol']);

/** graph 回答对象里不是查询结果的数组字段：图引用与未解析候选只是辅助信息，不计入结果条数。 */
const GRAPH_AUXILIARY_LIST_KEYS = new Set(['graphRefs', 'candidates']);

/** 列表型 graph 摘要展示的前几项；蒸馏行还会截到 150 字符，多列无益。 */
const GRAPH_LEADING_ITEMS = 3;

/**
 * 工具特化压缩策略 — 不同工具返回不同结构，压缩时保留最有价值的部分。
 *
 * 策略收到的是业务载荷（unwrapObservedResult 已拆开 ToolResultEnvelope：structuredContent
 * 优先，其次模型可见 text），不是信封本身；纯文本形态（如 "N matches (showing M)…"）按字符串截断，
 * 首行即匹配计数会落在摘要前 150 字符内。第二个参数是归一后的调用参数与执行真值。
 */
const TOOL_COMPRESS_STRATEGIES = {
  code(result: unknown, call: CompressCall) {
    if (typeof result !== 'object' || result === null) {
      // 单文件 code.read 成功时 handler 返回 ok(result.content)：载荷就是源码字符串，没有 path 字段。
      // 只有执行成功且确为 read 时才按文件事实摘要；失败回执的载荷是错误文本，必须原样保留。
      if (typeof result === 'string' && call.ok && stringFrom(call.params.action) === 'read') {
        return summarizeSingleFileRead(result, call.params);
      }
      return String(result).substring(0, 600);
    }
    const r = result as Record<string, unknown>;
    const matches = (Array.isArray(r.matches) ? r.matches : []) as Array<{
      file: string;
      line: number;
    }>;
    const batchResults = (r.batchResults || {}) as Record<string, Record<string, unknown>>;
    // 适配器的搜索投影恒为 { total, shown, matches }：零命中 { total:0, matches:[] } 与预算耗尽
    // { total:N, shown:0, matches:[] } 也是搜索事实（零命中能避免模型重复搜索），不能落到原始 JSON。
    const isSearchProjection =
      typeof r.total === 'number' && Number.isFinite(r.total) && Array.isArray(r.matches);

    // search action: 有 matches、batchResults 或计数投影；total 是观察到的总命中数，
    // matches 可能因预算只展示一部分（shown）。
    if (matches.length > 0 || isSearchProjection || Object.keys(batchResults).length > 0) {
      const lines: string[] = [];
      if (matches.length > 0 || isSearchProjection) {
        const total = typeof r.total === 'number' ? r.total : matches.length;
        const shown =
          typeof r.shown === 'number' && Number.isFinite(r.shown) ? r.shown : matches.length;
        lines.push(
          total > shown ? `搜索到 ${total} 个匹配（显示 ${shown}）` : `搜索到 ${total} 个匹配`
        );
        const fileGroups: Record<string, number[]> = {};
        for (const m of matches) {
          if (!fileGroups[m.file]) {
            fileGroups[m.file] = [];
          }
          fileGroups[m.file].push(m.line);
        }
        for (const [file, lineNums] of Object.entries(fileGroups).slice(0, 8)) {
          lines.push(`  ${file}: L${lineNums.slice(0, 3).join(',')}`);
        }
      }
      for (const [pattern, sub] of Object.entries(batchResults).slice(0, 5)) {
        const subMatches = (Array.isArray(sub.matches) ? sub.matches : []) as Array<{
          file: string;
          line: number;
        }>;
        lines.push(`  [${pattern}] ${subMatches.length} 个匹配`);
        for (const m of subMatches.slice(0, 3)) {
          lines.push(`    ${m.file}:${m.line}`);
        }
      }
      return lines.join('\n');
    }

    // read action: 有 files 数组或 content 字段。批量成员各自带 ok/error：
    // 失败成员必须在摘要里点名，否则整体 ok 的部分失败会被当成全部读到。
    if (Array.isArray(r.files)) {
      const files = r.files as Array<{
        ok?: boolean;
        content?: string;
        path?: string;
        error?: string;
        lineCount?: number;
      }>;
      const lines = [`读取 ${files.length} 个文件`];
      for (const f of files.slice(0, 5)) {
        if (f && typeof f === 'object' && f.ok === false) {
          lines.push(`  ${f.path ?? '?'} (失败: ${f.error || 'read failed'})`);
          continue;
        }
        lines.push(`  ${f?.path ?? '?'} (${countReadLines(f) ?? '?'} 行)`);
      }
      return lines.join('\n');
    }
    if (r.content) {
      return `文件 ${(r.path as string) || '?'} (${countReadLines(r) ?? '?'} 行)`;
    }

    // structure/outline action: 有 entries/children
    const entries = r.entries || r.children || [];
    if (Array.isArray(entries) && entries.length > 0) {
      return `目录结构: ${entries.length} 个条目`;
    }

    return defaultCompress(result);
  },

  graph(result: unknown) {
    if (typeof result !== 'object' || result === null) {
      return String(result).substring(0, 600);
    }
    const outer = result as Record<string, unknown>;
    // graph handler 的投影是 { type, entity, result } 或 { type, entity, message }：
    // 宿主查询体在 result 里，实体名在外层 entity；裸结果（旧形态）则直接是查询体。
    const body = outer.result;
    const entity = stringFrom(outer.entity);
    const type = stringFrom(outer.type);
    if (body == null && typeof outer.message === 'string' && entity) {
      return `图谱 ${type || 'query'} ${entity}: ${outer.message}`;
    }
    const label = `图谱 ${type || 'query'} ${entity || '?'}`;

    // 宿主没能把实体落到声明上（not-found/ambiguous）是回答不是故障，但也不是“类 <entity>”。
    const answer = objectFrom(body);
    if (answer && !Array.isArray(answer) && answer.resolved === false) {
      const candidates = Array.isArray(answer.candidates) ? answer.candidates.length : 0;
      return [
        `${label}: 未解析 (${stringFrom(answer.reason) || 'unresolved'})`,
        ...(stringFrom(answer.message)
          ? [`  ${limitLedgerText(stringFrom(answer.message), 200)}`]
          : []),
        ...(candidates > 0 ? [`  候选 ${candidates} 个`] : []),
      ].join('\n');
    }

    // callers/callees/impact/search 等是列表型回答：裸数组直接计数，宿主对象则按其中的结果数组计数，
    // 不能套用类查询模板（那会给出误导性的“类 <entity>”并丢掉全部结果）。
    const list = Array.isArray(body) ? body : Array.isArray(result) ? result : null;
    if (list) {
      return summarizeGraphLists(label, [['', list]]);
    }
    if (answer && type && !GRAPH_ENTITY_QUERY_TYPES.has(type)) {
      const lists = Object.entries(answer).filter(
        (entry): entry is [string, unknown[]] =>
          Array.isArray(entry[1]) && !GRAPH_AUXILIARY_LIST_KEYS.has(entry[0])
      );
      if (lists.length > 0) {
        return summarizeGraphLists(label, lists);
      }
    }
    if (body != null && typeof body !== 'object') {
      return `${label}: ${String(body).substring(0, 300)}`;
    }

    const r = answer ?? outer;
    // hierarchy query: 有 classes 或 hierarchy 数组
    const classes = r.classes || r.hierarchy;
    if (Array.isArray(classes)) {
      return `类层级: ${classes.length} 个类`;
    }

    // class/protocol query: 有 className 等
    const lines = [`类 ${(r.className as string) || (r.protocolName as string) || entity || '?'}`];
    if (r.superClass) {
      lines.push(`  继承: ${r.superClass}`);
    }
    if (Array.isArray(r.protocols) && r.protocols.length) {
      lines.push(`  协议: ${(r.protocols as string[]).join(', ')}`);
    }
    if (Array.isArray(r.methods) && r.methods.length) {
      lines.push(`  方法数: ${r.methods.length}`);
    }
    if (Array.isArray(r.properties) && r.properties.length) {
      lines.push(`  属性数: ${r.properties.length}`);
    }
    if (Array.isArray(r.calls) && r.calls.length) {
      lines.push(`  调用关系: ${r.calls.length} 条`);
    }
    return lines.join('\n');
  },
};

/**
 * 单文件读取摘要：路径来自调用参数（载荷里没有）。“(N 行)”只用于确知是文件总行数的情形，
 * 与 batch 分支的 lineCount 同义；其余读取模式按 handler 自己的标记标注视图：
 *   - DeltaCache 未变化/增量重读 → 标注重读结论，不按占位或 diff 文本计行；
 *   - 大纲/头尾预览 → 总行数取自 handler 标记（共 N 行），并写明视图；
 *   - 范围/maxLines 读取 → 写明展示区间 L<首>-<末> 与展示行数，省略后缀不计入；
 *   - Router 截断 → 只报告能从可见内容确证的事实，并标注“输出超限截断”。
 */
function summarizeSingleFileRead(content: string, params: Record<string, unknown>): string {
  const filePath = stringFrom(params.path) || stringFrom(params.filePath) || '?';
  const label = `文件 ${filePath}`;
  const trimmed = content.trim();
  if (trimmed === DELTA_UNCHANGED_PLACEHOLDER) {
    return `${label} (自上次读取未变化)`;
  }
  if (trimmed === DELTA_NO_VISIBLE_CHANGES) {
    return `${label} (自上次读取有变更，无可见行差异)`;
  }

  // 模板首行/结尾标记在 Router 头尾截断后仍保留，截断只追加标注。
  const truncation = READ_ROUTER_TRUNCATION_RE.exec(content);
  const truncatedNote = truncation ? '，输出超限截断' : '';
  const delta = READ_DELTA_HEADER_RE.exec(content);
  if (delta) {
    return `${label} (自上次读取有变更，增量 ${delta[1]} 处${truncatedNote})`;
  }
  const preview = READ_HEAD_TAIL_HEADER_RE.exec(content);
  if (preview) {
    return `${label} (共 ${preview[1]} 行，头尾预览${truncatedNote})`;
  }
  const outline = READ_OUTLINE_FOOTER_RE.exec(content);
  if (outline) {
    return `${label} (共 ${outline[1]} 行，大纲${truncatedNote})`;
  }

  // 剩下的是带行号前缀的源码：全文读（≤500 行且不带范围）或范围/maxLines 读。
  const view = readNumberedView(content, truncation);
  const isRange = isRangeReadParams(params) || view.omittedAfter !== null;
  if (!isRange && view.first === 1) {
    // 全文读的内容从第 1 行连续写到文件末行：未截断时展示行数即文件行数（与 handler 的 lineCount 一致）；
    // 截断后末行仍在尾部，末行号就是总行数。末行号与计数对不上说明形状漂移，交给下面的区间描述。
    if (!view.truncated && view.last !== null && view.shown === view.last) {
      return `${label} (${view.shown} 行)`;
    }
    if (view.truncated) {
      return view.last !== null
        ? `${label} (共 ${view.last} 行，输出超限截断，仅展示头尾)`
        : `${label} (输出超限截断，仅展示头尾)`;
    }
  }
  if (view.first !== null) {
    if (!isRange) {
      // 不带范围参数却不是从第 1 行连续到末行：与 handler 全文模板不符，降级为只描述展示区间。
      observeSafely(
        () =>
          Logger.getInstance().warn(
            `[ActiveContext] single-file read summary fell back to displayed range: full-read template mismatch; path=${filePath} first=${view.first} last=${view.last} shown=${view.shown} truncated=${view.truncated}`
          ),
        () => undefined
      );
    }
    return summarizeDisplayedRange(label, view, isRange);
  }
  if (!view.truncated && trimmed === '') {
    // 起始行超出文件末尾的范围读：handler 返回空串，这同样是事实（该区间无内容）。
    return isRange
      ? `${label} (范围读取 ${describeRequestedRange(params)}，无内容)`
      : `${label} (无内容)`;
  }

  // 没有任何行号前缀也不匹配任何模板：载荷不是 code.read 的已知展示态（宿主直连或模板漂移）。
  // 只能如实写“展示 N 行”，并留下诊断以便对齐 handler 模板。
  const displayed = content.split('\n').length;
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[ActiveContext] single-file read summary fell back to displayed lines: no line-number prefix or read template marker; path=${filePath} displayedLines=${displayed} truncated=${view.truncated}`
      ),
    () => undefined
  );
  return `${label} (展示 ${displayed} 行)`;
}

/** 带行号前缀的读取内容拆解：首/末行号、展示行数（截断时未知）、maxLines 省略的后续行数。 */
interface NumberedReadView {
  first: number | null;
  last: number | null;
  shown: number | null;
  omittedAfter: number | null;
  truncated: boolean;
}

/**
 * 只信任“真正的行首”：内容开头一定是行首；Router 截断标记之后的第一段可能是半行，
 * 所以尾部只看其后的完整行。省略后缀单独解析，不计入展示行。
 */
function readNumberedView(content: string, truncation: RegExpExecArray | null): NumberedReadView {
  let head = truncation ? content.slice(0, truncation.index) : content;
  let tail = truncation ? content.slice(truncation.index + truncation[0].length) : null;
  let omittedAfter: number | null = null;
  const lastPart = tail ?? head;
  const omitted = READ_OMITTED_SUFFIX_RE.exec(lastPart);
  if (omitted) {
    omittedAfter = Number(omitted[1]);
    const stripped = lastPart.slice(0, omitted.index);
    if (tail !== null) {
      tail = stripped;
    } else {
      head = stripped;
    }
  }

  const headLines = head.split('\n');
  const first = lineNumberOf(headLines[0]);
  if (tail === null) {
    const numbered = headLines.filter((line) => READ_LINE_PREFIX_RE.test(line)).length;
    return {
      first,
      last: lineNumberOf(headLines[headLines.length - 1]),
      shown: numbered,
      omittedAfter,
      truncated: false,
    };
  }
  const tailLines = tail.split('\n');
  return {
    first,
    last: tailLines.length >= 2 ? lineNumberOf(tailLines[tailLines.length - 1]) : null,
    shown: null,
    omittedAfter,
    truncated: true,
  };
}

function lineNumberOf(line: string | undefined): number | null {
  const matched = line === undefined ? null : READ_LINE_PREFIX_RE.exec(line);
  return matched ? Number(matched[1]) : null;
}

/**
 * 范围/展示区间摘要：区间取自内容里的行号（handler 已把 endLine 夹到文件末尾，比调用参数更真）；
 * maxLines 省略后缀给出末行之后还有多少行，文件总行数 = 末行号 + 省略行数。
 */
function summarizeDisplayedRange(label: string, view: NumberedReadView, isRange: boolean): string {
  const span = view.last !== null ? `L${view.first}-${view.last}` : `L${view.first} 起`;
  const kind = isRange ? '范围读取' : '展示区间';
  const shown = view.truncated ? '输出超限截断，仅展示头尾' : `展示 ${view.shown} 行`;
  const total =
    view.omittedAfter !== null && view.last !== null
      ? `，文件共 ${view.last + view.omittedAfter} 行`
      : '';
  return `${label} ${span} (${kind}，${shown}${total})`;
}

/** 与 readSingleFile 同口径：startLine/endLine 为真值或 maxLines 是正数时走范围分支。 */
function isRangeReadParams(params: Record<string, unknown>): boolean {
  return (
    Boolean(params.startLine) ||
    Boolean(params.endLine) ||
    positiveLineCount(params.maxLines) !== null
  );
}

/** 空结果时只能复述请求区间：start 缺省为 1；endLine 优先，其次 maxLines 推出的末行。 */
function describeRequestedRange(params: Record<string, unknown>): string {
  const start = positiveLineCount(params.startLine) ?? 1;
  const end = positiveLineCount(params.endLine);
  const maxLines = positiveLineCount(params.maxLines);
  if (end !== null) {
    return `L${start}-${end}`;
  }
  return maxLines !== null ? `L${start}-${start + maxLines - 1}` : `L${start} 起`;
}

function positiveLineCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const count = Math.floor(value);
  return count > 0 ? count : null;
}

/**
 * 列表型 graph 回答：单个结果数组写“N 条结果”；宿主对象带多个结果数组（impact 的文件/符号/测试，
 * hierarchy 的父/子类型）时逐个计数。前几项取自第一个非空数组。
 */
function summarizeGraphLists(label: string, lists: Array<[string, unknown[]]>): string {
  const header =
    lists.length === 1
      ? `${label}: ${lists[0][1].length} 条结果`
      : `${label}: ${lists.map(([key, items]) => `${key} ${items.length} 条`).join('、')}`;
  const leading = lists.find(([, items]) => items.length > 0)?.[1] ?? [];
  return [
    header,
    ...leading.slice(0, GRAPH_LEADING_ITEMS).map((item) => `  ${describeGraphItem(item)}`),
  ].join('\n');
}

/** graph 列表项的一行描述：优先名字与位置（宿主事实为 name + location 或 file + line），否则截断 JSON。 */
function describeGraphItem(item: unknown): string {
  const entry = objectFrom(item);
  if (!entry || Array.isArray(entry)) {
    return limitLedgerText(String(item), 120);
  }
  const name =
    stringFrom(entry.name) ||
    stringFrom(entry.qualifiedName) ||
    stringFrom(entry.symbol) ||
    stringFrom(entry.className) ||
    stringFrom(entry.caller) ||
    stringFrom(entry.callee) ||
    stringFrom(entry.entity) ||
    stringFrom(entry.id);
  const file = stringFrom(entry.file) || stringFrom(entry.filePath);
  const location =
    stringFrom(entry.location) ||
    (file && typeof entry.line === 'number' ? `${file}:${entry.line}` : file);
  if (name) {
    return limitLedgerText(location ? `${name} (${location})` : name, 120);
  }
  if (location) {
    return limitLedgerText(location, 120);
  }
  return limitLedgerText(JSON.stringify(entry) ?? String(item), 120);
}

/** 默认压缩 — 截断到 maxChars；undefined/函数等 stringify 不出字符串时退回 String()。 */
function defaultCompress(result: unknown, maxChars = 600) {
  const str =
    typeof result === 'string' ? result : (JSON.stringify(result) ?? String(result ?? ''));
  if (str.length <= maxChars) {
    return str;
  }
  return `${str.substring(0, maxChars)}…(truncated)`;
}

/**
 * 最后一层兜底：JSON 序列化已失败。对象只读自有键名（Object.keys 不触发 getter）并附上失败原因，
 * 原始值走 String()；任何一步再抛错都退回固定占位文本，保证绝不抛出。
 */
function lastResortCompress(payload: unknown, reason: string, maxChars = 600): string {
  const brief = limitLedgerText(reason.replace(/\s+/g, ' ').trim(), 120);
  let text: string;
  if (payload !== null && (typeof payload === 'object' || typeof payload === 'function')) {
    let keys: string;
    try {
      keys = Object.keys(payload).slice(0, 8).join(',');
    } catch (err: unknown) {
      keys = `?(${err instanceof Error ? err.message : 'keys unavailable'})`;
    }
    text = `[unserializable ${typeof payload} keys=${keys}: ${brief}]`;
  } else {
    try {
      text = String(payload);
    } catch (err: unknown) {
      text = `[unserializable ${typeof payload}: ${err instanceof Error ? err.message : brief}]`;
    }
  }
  return text.length <= maxChars ? text : `${text.substring(0, maxChars)}…(truncated)`;
}

/** 诊断用的错误原因；非 Error 的抛出值也可能 String() 失败，此时给固定描述。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return String(err);
  } catch (stringifyErr: unknown) {
    return stringifyErr instanceof Error
      ? `unprintable error (${stringifyErr.message})`
      : 'unprintable error';
  }
}

/** 调用参数归一：模型调用形如 { action, params: {...} }，宿主直连可能是扁平参数；嵌套字段优先。 */
function flattenCallParams(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const outer = objectFrom(args);
  if (!outer || Array.isArray(outer)) {
    return {};
  }
  const { params: nested, ...rest } = outer;
  const inner = objectFrom(nested);
  return inner && !Array.isArray(inner) ? { ...rest, ...inner } : rest;
}

/** 读取结果的行数：handler 已给 lineCount 时直接用，否则按 content 换行计数；都没有则 null。 */
function countReadLines(entry: unknown): number | null {
  const r = objectFrom(entry);
  if (!r) {
    return null;
  }
  if (typeof r.lineCount === 'number' && Number.isFinite(r.lineCount)) {
    return r.lineCount;
  }
  return typeof r.content === 'string' ? r.content.split('\n').length : null;
}

interface UnwrappedObservation {
  /** 通过 kernel 严格守卫的真实信封；业务对象恰好带 toolId/callId/status 字符串也不会被误判。 */
  envelope: ToolResultEnvelope | null;
  /** 交给压缩策略/元数据的业务载荷：信封的 structuredContent，其次模型可见 text；非信封则原结果。 */
  payload: unknown;
}

/**
 * 拆开 ToolResultEnvelope：runtimeBridge 总把 metadata.envelope 交给 recordToolCall，
 * 压缩策略、Observation Ledger 与观察元数据必须看到同一份业务载荷，而不是信封元数据。
 */
function unwrapObservedResult(result: unknown): UnwrappedObservation {
  if (!isToolResultEnvelope(result)) {
    return { envelope: null, payload: result };
  }
  return { envelope: result, payload: result.structuredContent ?? result.text };
}

/** search 结果的匹配数：结构化投影读 total，纯文本读首行 "N matches"，都没有则 null。 */
function readSearchMatchCount(payload: unknown): number | null {
  const structured = objectFrom(payload);
  if (structured && typeof structured.total === 'number' && Number.isFinite(structured.total)) {
    return structured.total;
  }
  if (typeof payload === 'string') {
    const firstLine = payload.split('\n').find((line) => line.trim());
    const matched = firstLine?.trim().match(/^(\d+) matches\b/);
    if (matched) {
      return Number(matched[1]);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// §2: 类型定义 + ActiveContext 类
// ═══════════════════════════════════════════════════════════

interface ActiveContextOptions {
  maxRecentRounds?: number;
  lightweight?: boolean;
}

interface ScratchpadEntry {
  finding: string;
  evidence: string;
  importance: number;
  round: number;
  /** 证据台账条目 id（Wave A E3）——E5 producer 机械展开的程序化消费面 */
  evidenceRefs?: string[];
}

interface RoundAction {
  /** 旧 addAction 无回执，保持 undefined；真实工具回执明确记录成功/失败。 */
  ok?: boolean;
  successfulReadPaths?: string[];
  tool: string;
  params: Record<string, unknown>;
}

interface RoundObservation {
  tool: string;
  gotNewInfo?: boolean;
  resultType?: string;
  keyFacts?: string[];
  resultSize?: number;
  [key: string]: unknown;
}

interface RoundSummary {
  newInfoCount?: number;
  totalCalls?: number;
  submits?: number;
  cumulativeFiles?: number;
  cumulativePatterns?: number;
  [key: string]: unknown;
}

interface Round {
  iteration: number;
  thought: string | null;
  actions: RoundAction[];
  observations: RoundObservation[];
  reflection: string | null;
  roundSummary: RoundSummary | null;
  startTime: number;
  endTime: number | null;
}

interface PlanStep {
  description: string;
  status: string;
  keywords: string[];
}

interface Plan {
  text: string;
  steps: PlanStep[];
  createdAtIteration: number;
  lastUpdatedAtIteration: number;
}

interface Observation {
  toolName: string;
  args?: Record<string, unknown>;
  result: unknown;
  round: number;
  timestamp: number;
}

type ObservationLedgerCategory = 'evidence' | 'readSet' | 'searchSet' | 'failureSet' | 'nextHints';

interface ObservationLedgerItem {
  category: ObservationLedgerCategory;
  key: string;
  text: string;
  round: number;
  toolName: string;
}

interface CompressedObservation {
  toolName: string;
  round: number;
  summary: string;
  ledgerItems: ObservationLedgerItem[];
}

interface ActiveContextJSON {
  rounds?: Round[];
  scratchpad?: ScratchpadEntry[];
  totalObservations?: number;
  plan?: Plan;
  strictAnalysisContext?: StrictAnalysisContextProjectionV1;
}

const OBSERVATION_LEDGER_CATEGORIES: ObservationLedgerCategory[] = [
  'evidence',
  'readSet',
  'searchSet',
  'failureSet',
  'nextHints',
];

const OBSERVATION_LEDGER_LIMITS: Record<ObservationLedgerCategory, number> = {
  evidence: 8,
  readSet: 10,
  searchSet: 8,
  failureSet: 6,
  nextHints: 6,
};

const PROVIDER_DEBUG_KEYS = new Set([
  'callId',
  'parentCallId',
  'startedAt',
  'durationMs',
  'timestamp',
  'diagnostics',
  'structuredContent',
  '_meta',
]);

export class ActiveContext {
  // ── 子区 1: Scratchpad (从 WorkingMemory 继承, 不可压缩) ──
  #scratchpad: ScratchpadEntry[] = [];

  // ── 子区 2: ObservationLog (合并 RT.rounds + WM.observations) ──
  #rounds: Round[] = [];
  #currentRound: Round | null = null;

  // ── WM 滑动窗口 (保留最近 N 轮原始结果，旧的压缩) ──
  #recentObservations: Observation[] = [];
  #compressedObservations: CompressedObservation[] = [];

  // ── 子区 3: Plan (从 ReasoningTrace 继承) ──
  #plan: Plan | null = null;
  #planHistory: Plan[] = [];
  /** 是否期待下一次响应包含计划 (由 ExplorationTracker 设置) */
  #expectingPlan = false;

  // ── 严格生产链：只保存 Core 证据台账/PC-F 收据的不可变语义投影 ──
  #strictAnalysisContext: StrictAnalysisContextProjectionV1 | null = null;

  // ── 配置 ──
  /** 保留最近 N 轮原始观察 */
  #maxRecentRounds: number;
  /** 轻量模式 (User Chat: 仅 RT 功能，禁用 WM 压缩/Scratchpad) */
  #lightweight: boolean;
  /** 总观察计数 */
  #totalObservations = 0;

  #logger: ReturnType<typeof Logger.getInstance>;

  /**
   * @param [options.maxRecentRounds=3] 保留最近 N 轮原始结果 (WM 滑动窗口)
   * @param [options.lightweight=false] 轻量模式: 跳过 WM 的压缩/Scratchpad 逻辑 (D5)
   */
  constructor(options: ActiveContextOptions = {}) {
    const maxRecentRounds = options.maxRecentRounds ?? 3;
    // 0 表示立即压缩；负数会使队列清空后仍进入 while，必须在记录观察前拒绝。
    if (!Number.isInteger(maxRecentRounds) || maxRecentRounds < 0) {
      throw new RangeError('ActiveContext maxRecentRounds must be a non-negative integer');
    }
    this.#maxRecentRounds = maxRecentRounds;
    this.#lightweight = options.lightweight ?? false;
    this.#logger = Logger.getInstance();
  }

  // ═══════════════════════════════════════════════════════
  // §2.1: 轮次管理 (合并 RT.startRound/endRound)
  // ═══════════════════════════════════════════════════════

  /**
   * 开始新一轮推理
   * @param iteration 轮次编号
   */
  startRound(iteration: number) {
    if (this.#currentRound) {
      this.endRound(); // 安全关闭上一轮
    }
    this.#currentRound = {
      iteration,
      thought: null,
      actions: [],
      observations: [],
      reflection: null,
      roundSummary: null,
      startTime: Date.now(),
      endTime: null,
    };
  }

  /** 结束当前轮次 */
  endRound() {
    if (this.#currentRound) {
      this.#currentRound.endTime = Date.now();
      this.#rounds.push(this.#currentRound);
      this.#currentRound = null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §2.2: 记录 (合并 WM.observe + RT.addAction/addObservation)
  // ═══════════════════════════════════════════════════════

  /** 记录 AI 的推理文本（从 aiResult.text 提取） */
  setThought(text: string) {
    if (this.#currentRound && text) {
      this.#currentRound.thought = text;
    }
  }

  /**
   * 统一记录一次工具调用 — 合并原 WM.observe() + RT.addAction() + RT.addObservation()
   *
   * @param toolName 工具名称
   * @param args 工具参数
   * @param result 工具返回的原始结果
   * @param isNew 是否发现新信息 (由 ExplorationTracker.recordToolCall 提供)
   */
  recordToolCall(toolName: string, args: Record<string, unknown>, result: unknown, isNew: boolean) {
    const round = this.#currentRound?.iteration || 0;

    // ── RT 部分: Action + Observation ──
    const observedCall = {
      tool: toolName,
      args,
      result,
      ...(isToolResultEnvelope(result) ? { envelope: result } : {}),
    };
    this.#currentRound?.actions.push({
      tool: toolName,
      params: args,
      ok: readToolObservation(observedCall).ok,
      ...(toolName === 'code' && args.action === 'read'
        ? { successfulReadPaths: successfulReadPaths(observedCall) }
        : {}),
    });
    const observationMeta = ActiveContext.buildObservationMeta(toolName, args, result, isNew);
    this.#currentRound?.observations.push({ tool: toolName, ...observationMeta });

    // ── WM 部分: 滑动窗口压缩 (非轻量模式) ──
    if (!this.#lightweight) {
      this.#totalObservations++;
      this.#recentObservations.push({
        toolName,
        args,
        result,
        round,
        timestamp: Date.now(),
      });

      while (this.#recentObservations.length > this.#maxRecentRounds) {
        const oldest = this.#recentObservations.shift();
        if (oldest) {
          const summary = this.#compressObservation(oldest);
          this.#compressedObservations.push(summary);
        }
      }
    }
  }

  /** 兼容旧 RT API: 记录一次工具调用 (Action only) */
  addAction(toolName: string, params: Record<string, unknown>) {
    this.#currentRound?.actions.push({ tool: toolName, params });
  }

  /** 兼容旧 RT API: 记录一次工具结果的结构化观察 */
  addObservation(toolName: string, meta: Record<string, unknown>) {
    this.#currentRound?.observations.push({ tool: toolName, ...meta });
  }

  /** 兼容旧 WM API: 记录工具调用结果 (Observe, 仅 WM 滑动窗口) */
  observe(toolName: string, result: unknown, round: number) {
    if (this.#lightweight) {
      return;
    }
    this.#totalObservations++;
    this.#recentObservations.push({ toolName, result, round, timestamp: Date.now() });
    while (this.#recentObservations.length > this.#maxRecentRounds) {
      const oldest = this.#recentObservations.shift();
      if (oldest) {
        const summary = this.#compressObservation(oldest);
        this.#compressedObservations.push(summary);
      }
    }
  }

  /** 记录反思内容 (ExplorationTracker 使用, L5 修复) */
  setReflection(text: string) {
    if (this.#currentRound && text) {
      this.#currentRound.reflection = text;
    }
  }

  /**
   * 记录轮次摘要
   * @param summary { newInfoCount, totalCalls, submits, cumulativeFiles, cumulativePatterns }
   */
  setRoundSummary(summary: RoundSummary) {
    if (this.#currentRound) {
      this.#currentRound.roundSummary = summary;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §2.3: Scratchpad (从 WorkingMemory 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * Agent 主动记录关键发现 (note_finding 工具入口)
   *
   * @param finding 关键发现描述
   * @param [evidence] 证据 (文件路径:行号)
   * @param [importance=5] 重要性 1-10
   * @param [round=0] 当前轮次
   */
  noteKeyFinding(
    finding: string,
    evidence: unknown = '',
    importance = 5,
    round = 0,
    evidenceRefs?: string[]
  ) {
    // P0 Fix: 防御性保证 evidence 是 string (AI 可能传入 array/object)
    const safeEvidence =
      typeof evidence === 'string'
        ? evidence
        : Array.isArray(evidence)
          ? evidence.join(', ')
          : evidence
            ? String(evidence)
            : '';
    this.#scratchpad.push({
      finding,
      evidence: safeEvidence,
      importance: Math.min(10, Math.max(1, importance)),
      round,
      ...(evidenceRefs?.length ? { evidenceRefs: [...evidenceRefs] } : {}),
    });

    observeSafely(
      () =>
        this.#logger.debug(
          `[ActiveContext] 📌 noted finding (${importance}/10): ${finding.substring(0, 80)}`
        ),
      () => undefined
    );
  }

  // ═══════════════════════════════════════════════════════
  // §2.4: Plan (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * 从 AI 响应文本中提取计划，自动调用 setPlan/updatePlan
   *
   * 防御措施: 已存在计划时，仅在 #expectingPlan 为 true 时才覆盖。
   * 这防止 reflection 回复中的编号列表（非计划的回应文本）污染已有计划。
   * ExplorationTracker 在发送 plan elicitation / replan 时调用 expectPlan() 授权更新。
   *
   * @param text AI 完整响应文本
   * @param iteration 当前轮次
   * @returns 是否成功提取到计划
   */
  extractAndSetPlan(text: string, iteration: number) {
    const planText = this.#extractPlanFromText(text);
    if (!planText) {
      return false;
    }

    // Guard: 已有计划时，仅在 expectPlan 授权下才覆盖
    // 防止 reflection/convergence 回复中的编号列表被误捕获为 plan
    if (this.#plan && !this.#expectingPlan) {
      return false;
    }

    this.#expectingPlan = false;
    if (this.#plan) {
      this.#updatePlan(planText, iteration);
    } else {
      this.#setPlan(planText, iteration);
    }
    return true;
  }

  /**
   * 标记「下一次响应可能包含计划」— 授权 extractAndSetPlan 覆盖已有计划
   * 由 ExplorationTracker 在发送 plan elicitation / replan nudge 时调用。
   */
  expectPlan() {
    this.#expectingPlan = true;
  }

  /** 直接设置计划 (公开接口，供 ExplorationTracker 和测试使用) */
  setPlan(planText: string, iteration: number) {
    this.#setPlan(planText, iteration);
  }

  /** 更新计划 (保留旧 plan 到 history) */
  updatePlan(replanText: string, iteration: number) {
    this.#updatePlan(replanText, iteration);
  }

  /** 获取当前计划 (只读副本) */
  getPlan() {
    if (!this.#plan) {
      return null;
    }
    return {
      ...this.#plan,
      steps: structuredClone(this.#plan.steps),
    };
  }

  /** 获取计划步骤的可变引用 (ExplorationTracker.updatePlanProgress 使用) */
  getPlanStepsMutable() {
    return this.#plan?.steps || [];
  }

  /** 获取计划历史 (F7) */
  getPlanHistory() {
    return structuredClone(this.#planHistory);
  }

  /**
   * 获取当前轮次的 actions (ExplorationTracker.updatePlanProgress 使用, L5 修复)
   * @returns >}
   */
  getCurrentRoundActions() {
    return structuredClone(this.#currentRound?.actions || []);
  }

  /** 获取当前轮次的 iteration 编号 (F8) */
  getCurrentIteration() {
    return this.#currentRound?.iteration || null;
  }

  // ═══════════════════════════════════════════════════════
  // §2.5: 上下文构建 (合并 WM.buildContext, 增加预算控制)
  // ═══════════════════════════════════════════════════════

  /**
   * 构建当前工作记忆的上下文快照
   * 用于注入到 system prompt 或 user nudge 中
   *
   * @param [tokenBudget=Infinity] token 预算 (新增: 预算控制)
   * @returns Markdown 格式的上下文块，空字符串表示无内容
   */
  buildContext(tokenBudget = Infinity) {
    if (this.#lightweight) {
      return '';
    }

    const parts: string[] = [];
    let remaining = tokenBudget;

    // §1: Scratchpad (最高优先级 — 不会被压缩)
    if (this.#scratchpad.length > 0) {
      const sorted = [...this.#scratchpad].sort((a, b) => b.importance - a.importance);
      const scratchLines = ['## 📌 已确认的关键发现'];
      let scratchTokens = estimateTokens(scratchLines[0]);
      let omitted = 0;
      for (const f of sorted) {
        const badge = f.importance >= 8 ? '⚠️' : f.importance >= 5 ? '📋' : '💡';
        let line = `- ${badge} [${f.importance}/10] ${f.finding}`;
        if (f.evidence) {
          line += ` (${f.evidence})`;
        }
        const tokens = estimateTokens(`\n${line}`);
        if (scratchTokens + tokens <= remaining) {
          scratchLines.push(line);
          scratchTokens += tokens;
        } else {
          omitted++;
        }
      }
      const scratchSection = scratchLines.join('\n');
      if (scratchLines.length > 1) {
        parts.push(scratchSection);
        remaining -= scratchTokens;
      }
      if (omitted > 0) {
        observeSafely(
          () =>
            this.#logger.info(
              `[ActiveContext] context budget retained ${scratchLines.length - 1} findings and omitted ${omitted}`
            ),
          () => undefined
        );
      }
    }

    // §2: Observation Ledger (中等优先级)
    if (this.#compressedObservations.length > 0) {
      if (remaining > 100) {
        const ledgerSection = this.#buildObservationLedgerSection(
          Math.max(0, remaining - (parts.length ? estimateTokens('\n') : 0))
        );
        if (ledgerSection) {
          parts.push(ledgerSection);
        } else {
          this.#logLedgerSkipped('no_item_fits', remaining);
        }
      } else {
        // 剩余预算不足以放下台账标题+一条记录：整段跳过，模型本轮看不到失败/已读记录。
        this.#logLedgerSkipped('budget_exhausted', remaining);
      }
    }

    return parts.join('\n');
  }

  // ═══════════════════════════════════════════════════════
  // §2.6: 蒸馏 (合并 WM.distill, 增强版 — 含 plan + stats)
  // ═══════════════════════════════════════════════════════

  /**
   * 蒸馏 ActiveContext 为结构化报告
   * 在 Agent execute 结束时调用，结果写入 SessionStore
   */
  distill(): DistilledContext {
    return {
      keyFindings: this.#scratchpad.map((f) => ({
        finding: f.finding,
        evidence: f.evidence,
        importance: f.importance,
        ...(f.evidenceRefs?.length ? { evidenceRefs: [...f.evidenceRefs] } : {}),
      })),
      // 蒸馏是退出时的完整观察摘要，滑动窗口中尚未压缩的最后几条也必须带出。
      toolCallSummary: [
        ...this.#compressedObservations,
        ...this.#recentObservations.map((observation) => this.#compressObservation(observation)),
      ].map((s) => `[${s.toolName}] ${s.summary.substring(0, 150)}`),
      stats: this.getStats(),
      plan: this.getPlan(),
      totalObservations: this.#totalObservations,
      compressedCount: this.#compressedObservations.length,
      ...(this.#strictAnalysisContext
        ? { strictAnalysisContext: this.#strictAnalysisContext }
        : {}),
    };
  }

  /** 绑定并重新校验严格上下文，防止序列化恢复时注入未哈希字段。 */
  bindStrictAnalysisContext(context: StrictAnalysisContextProjectionV1): void {
    const { schemaVersion, contextHash, ...input } = context;
    if (schemaVersion !== 1) {
      throw new Error('STRICT_CONTEXT_SCHEMA_UNSUPPORTED');
    }
    const normalized = createStrictAnalysisContextProjectionV1(input);
    if (normalized.contextHash !== contextHash) {
      throw new Error('STRICT_CONTEXT_HASH_MISMATCH');
    }
    this.#strictAnalysisContext = normalized;
  }

  // ═══════════════════════════════════════════════════════
  // §2.7: 分析方法 (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * 获取所有有 Thought 的轮次
   * @returns >}
   */
  getThoughts() {
    return this.#rounds
      .filter((r) => r.thought)
      .map((r) => ({ iteration: r.iteration, thought: r.thought }));
  }

  /**
   * 获取最近 N 轮的紧凑摘要 (ExplorationTracker.#checkReflection 使用)
   * @param [n=3] 回看轮数
   */
  getRecentSummary(n = 3) {
    const recent = this.#rounds.slice(-n);
    if (recent.length === 0) {
      return null;
    }

    const thoughts = recent
      .filter((r): r is Round & { thought: string } => r.thought !== null)
      .map((r) => (r.thought.length > 100 ? `${r.thought.substring(0, 100)}…` : r.thought));

    const tools = recent.flatMap((r) => r.actions.map((a) => a.tool));

    const newInfoCount = recent.reduce(
      (c, r) => c + r.observations.filter((o) => o.gotNewInfo).length,
      0
    );
    const totalObs = recent.reduce((c, r) => c + r.observations.length, 0);

    return {
      roundCount: recent.length,
      thoughts,
      toolCalls: tools,
      newInfoRatio: totalObs > 0 ? newInfoCount / totalObs : 0,
      lastIteration: recent[recent.length - 1].iteration,
    };
  }

  /** 统计指标 (ExplorationTracker.getQualityMetrics 使用) */
  getStats() {
    return {
      totalRounds: this.#rounds.length,
      thoughtCount: this.#rounds.filter((r) => r.thought).length,
      totalActions: this.#rounds.reduce((c, r) => c + r.actions.length, 0),
      totalObservations: this.#rounds.reduce((c, r) => c + r.observations.length, 0),
      reflectionCount: this.#rounds.filter((r) => r.reflection).length,
      totalDurationMs: this.#rounds.reduce(
        (d, r) => d + ((r.endTime || Date.now()) - r.startTime),
        0
      ),
    };
  }

  // ═══════════════════════════════════════════════════════
  // §2.8: Scratchpad 查询 (从 WorkingMemory 继承)
  // ═══════════════════════════════════════════════════════

  /** 获取 scratchpad 中的关键发现数量 */
  get scratchpadSize() {
    return this.#scratchpad.length;
  }

  /** 获取总观察数 */
  get totalObservations() {
    return this.#totalObservations;
  }

  /**
   * 获取 scratchpad 中的高重要性发现
   * @returns >}
   */
  getHighPriorityFindings(minImportance = 7) {
    return this.#scratchpad
      .filter((f) => f.importance >= minImportance)
      .sort((a, b) => b.importance - a.importance)
      .map((finding) => structuredClone(finding));
  }

  // ═══════════════════════════════════════════════════════
  // §2.9: 序列化 (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /** 可序列化输出 */
  toJSON() {
    return {
      rounds: structuredClone(this.#rounds),
      stats: this.getStats(),
      scratchpad: structuredClone(this.#scratchpad),
      compressedObservations: this.#compressedObservations.length,
      totalObservations: this.#totalObservations,
      ...(this.#strictAnalysisContext
        ? { strictAnalysisContext: this.#strictAnalysisContext }
        : {}),
      ...(this.#plan
        ? {
            plan: {
              text: this.#plan.text,
              steps: structuredClone(this.#plan.steps),
              createdAtIteration: this.#plan.createdAtIteration,
              lastUpdatedAtIteration: this.#plan.lastUpdatedAtIteration,
            },
            planHistory: this.#planHistory.length,
          }
        : {}),
    };
  }

  /**
   * 从 JSON 恢复 ActiveContext (断点续传)
   * @param json toJSON() 的输出
   */
  static fromJSON(json: ActiveContextJSON) {
    const ctx = new ActiveContext();
    if (json.rounds) {
      ctx.#rounds = structuredClone(json.rounds);
    }
    if (json.scratchpad) {
      ctx.#scratchpad = structuredClone(json.scratchpad);
    }
    if (json.totalObservations) {
      ctx.#totalObservations = json.totalObservations;
    }
    if (json.plan) {
      ctx.#plan = {
        text: json.plan.text,
        steps: structuredClone(json.plan.steps),
        createdAtIteration: json.plan.createdAtIteration,
        lastUpdatedAtIteration: json.plan.lastUpdatedAtIteration,
      };
    }
    if (json.strictAnalysisContext) {
      ctx.bindStrictAnalysisContext(json.strictAnalysisContext);
    }
    return ctx;
  }

  /** 清空 ActiveContext — 释放内存 */
  clear() {
    this.#scratchpad.length = 0;
    this.#rounds.length = 0;
    this.#currentRound = null;
    this.#recentObservations.length = 0;
    this.#compressedObservations.length = 0;
    this.#plan = null;
    this.#planHistory.length = 0;
    this.#totalObservations = 0;
    this.#strictAnalysisContext = null;
  }

  // ═══════════════════════════════════════════════════════
  // §2.10: 静态工具 (从 ReasoningTrace 迁入)
  // ═══════════════════════════════════════════════════════

  /**
   * 从工具执行结果构建结构化观察元数据
   * 不改变工具结果传给 AI 的内容，只影响推理链记录
   *
   * @param isNew 由 ExplorationTracker.recordToolCall 提供
   * @returns }
   */
  static buildObservationMeta(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    isNew: boolean
  ) {
    const meta = {
      gotNewInfo: isNew,
      resultType: 'unknown',
      keyFacts: [] as string[],
      resultSize: 0,
    };

    const { envelope, payload } = unwrapObservedResult(result);
    // 观察元数据只有 gotNewInfo 被消费：不再为 resultSize 对整个结果（批量读取全文）做一次
    // JSON.stringify——既省掉随结果体积线性增长的开销，也避免不可序列化结果让 traceRecord 抛错。
    // 只对已是字符串的结果取长度；信封取模型可见 text 的长度；其余对象记 0。
    meta.resultSize =
      typeof result === 'string' ? result.length : envelope ? envelope.text.length : 0;

    switch (toolName) {
      case 'code': {
        const action = (args?.action as string) || '';
        if (action === 'search') {
          meta.resultType = 'search';
          // 适配器投影为 { total, shown, matches }；旧纯文本形态首行是 "N matches (showing M)"。
          meta.keyFacts.push(`${readSearchMatchCount(payload) ?? '?'} matches found`);
          if (isNew) {
            meta.keyFacts.push('new files discovered');
          }
        } else if (action === 'read' || action === 'outline') {
          meta.resultType = action === 'read' ? 'file_content' : 'outline';
          const fp = (args?.path as string) || '';
          if (fp) {
            meta.keyFacts.push(`${action} ${fp}`);
          }
        } else if (action === 'write') {
          meta.resultType = 'write';
          const fp = (args?.path as string) || '';
          if (fp) {
            meta.keyFacts.push(`write ${fp}`);
          }
        } else if (action === 'structure') {
          meta.resultType = 'structure';
          meta.keyFacts.push(`list ${(args?.directory as string) || '/'}`);
        } else {
          meta.resultType = action || 'code';
          meta.keyFacts.push(`code.${action}`);
        }
        break;
      }
      case 'knowledge': {
        const action = (args?.action as string) || '';
        if (action === 'submit' || action === 'submit_batch') {
          meta.resultType = 'submit';
          meta.gotNewInfo = true;
          const title = (args?.title as string) || '(untitled)';
          meta.keyFacts.push(`submit "${title}"`);
        } else {
          meta.resultType = 'query';
          meta.keyFacts.push(`knowledge.${action}`);
        }
        break;
      }
      case 'graph': {
        meta.resultType = 'ast_query';
        const action = (args?.action as string) || '';
        const type = (args?.type as string) || '';
        const entity = (args?.entity as string) || '';
        meta.keyFacts.push(`graph.${action}(${type}${entity ? `:${entity}` : ''})`);
        break;
      }
      case 'terminal': {
        meta.resultType = 'terminal';
        const cmd = (args?.command as string) || '';
        meta.keyFacts.push(`exec: ${cmd.substring(0, 60)}`);
        break;
      }
      case 'memory': {
        meta.resultType = 'memory';
        meta.keyFacts.push(`memory.${(args?.action as string) || ''}`);
        break;
      }
      case 'meta': {
        meta.resultType = 'meta';
        meta.keyFacts.push(`meta.${(args?.action as string) || ''}`);
        break;
      }
      default: {
        meta.resultType = 'other';
        meta.keyFacts.push(toolName);
      }
    }

    if (envelope) {
      meta.resultType = envelope.status;
      meta.keyFacts.push(
        envelope.parentCallId
          ? `${toolName} ${envelope.status} (${envelope.callId} child of ${envelope.parentCallId})`
          : `${toolName} ${envelope.status} (${envelope.callId})`
      );
      Object.assign(meta, {
        toolCall: {
          callId: envelope.callId,
          ...(envelope.parentCallId ? { parentCallId: envelope.parentCallId } : {}),
          status: envelope.status,
          ok: envelope.ok,
          durationMs: envelope.durationMs,
        },
      });
    }

    return meta;
  }

  // ═══════════════════════════════════════════════════════
  // §3: 私有方法
  // ═══════════════════════════════════════════════════════

  /**
   * 工具结果压缩 — 使用特化策略 (从 WorkingMemory 迁入)
   * @param observation
   * @returns }
   */
  #compressObservation(observation: Observation): CompressedObservation {
    // 先拆信封再压缩：策略按业务载荷编写，生产传入的却总是 ToolResultEnvelope。
    const { envelope, payload } = unwrapObservedResult(observation.result);
    const call: CompressCall = {
      params: flattenCallParams(observation.args),
      ok: envelope ? envelope.ok : true,
    };
    let summary = this.#summarizePayload(observation, payload, call);
    if (envelope && !envelope.ok) {
      // 失败回执的载荷通常只是错误文本；状态前缀让蒸馏摘要与宿主拼接的文本能分辨失败/阻断/超时。
      summary = `[${envelope.status}] ${summary}`;
    }
    return {
      toolName: observation.toolName,
      round: observation.round,
      summary,
      ledgerItems: this.#extractLedgerItemsSafely(observation, summary),
    };
  }

  /**
   * 摘要三层降级，任何一层都不能让 recordToolCall/observe/distill 抛错：
   *   1. 工具特化策略（只认识已知业务形状）；
   *   2. defaultCompress 通用 JSON 截断（无策略的工具从这里开始）；
   *   3. lastResortCompress：JSON 也失败（BigInt、循环引用、抛错 getter）时只读自有键名生成占位文本。
   * 每次降级都留下可定位的 warn：工具、轮次、失败原因与选择的下一层。
   */
  #summarizePayload(observation: Observation, payload: unknown, call: CompressCall): string {
    const strategy = (
      TOOL_COMPRESS_STRATEGIES as Record<string, (result: unknown, call: CompressCall) => string>
    )[observation.toolName];
    if (strategy) {
      try {
        return strategy(payload, call);
      } catch (err: unknown) {
        // 策略只认识已知业务形状；形状漂移时退回通用截断，并留下可定位的降级记录。
        const reason = describeError(err);
        observeSafely(
          () =>
            this.#logger.warn(
              `[ActiveContext] compress strategy failed tool=${observation.toolName} round=${observation.round} reason=${reason}; fallback=defaultCompress`
            ),
          () => undefined
        );
      }
    }
    try {
      return defaultCompress(payload);
    } catch (err: unknown) {
      // 只有绕过适配器直连 recordToolCall/observe 的宿主才会交来不可序列化的值（适配器已替换为占位符）。
      const reason = describeError(err);
      observeSafely(
        () =>
          this.#logger.warn(
            `[ActiveContext] default compress failed tool=${observation.toolName} round=${observation.round} payloadType=${typeof payload} reason=${reason}; fallback=string`
          ),
        () => undefined
      );
      return lastResortCompress(payload, reason);
    }
  }

  /** 台账提取读取载荷字段（ok/error/status/files…）；抛错 getter 不能让整个观察记录失败。 */
  #extractLedgerItemsSafely(observation: Observation, summary: string): ObservationLedgerItem[] {
    try {
      return this.#extractObservationLedgerItems(observation, summary);
    } catch (err: unknown) {
      const reason = describeError(err);
      observeSafely(
        () =>
          this.#logger.warn(
            `[ActiveContext] observation ledger extraction failed tool=${observation.toolName} round=${observation.round} reason=${reason}; fallback=summary-only`
          ),
        () => undefined
      );
      // 空条目让 #buildObservationLedgerSection 退回按摘要生成的 evidence 条目。
      return [];
    }
  }

  #buildObservationLedgerSection(tokenBudget: number): string | null {
    const ledger = new Map<ObservationLedgerCategory, ObservationLedgerItem[]>();
    for (const observation of this.#compressedObservations) {
      const items =
        observation.ledgerItems.length > 0
          ? observation.ledgerItems
          : [
              {
                category: 'evidence' as const,
                key: `${observation.toolName}:${normalizeLedgerKey(observation.summary)}`,
                text: `${observation.toolName} observed ${sanitizeLedgerText(observation.summary, 180)}`,
                round: observation.round,
                toolName: observation.toolName,
              },
            ];
      for (const item of items) {
        const bucket = ledger.get(item.category) || [];
        if (!bucket.some((existing) => existing.key === item.key)) {
          bucket.push(item);
          ledger.set(item.category, bucket);
        }
      }
    }

    const lines = ['## Observation Ledger'];
    const omitted: string[] = [];
    let retained = 0;
    for (const category of OBSERVATION_LEDGER_CATEGORIES) {
      const items = (ledger.get(category) || []).slice(-OBSERVATION_LEDGER_LIMITS[category]);
      const categoryLines = [`### ${category}`];
      let index = 0;
      for (; index < items.length; index++) {
        const item = items[index];
        const line = `- [R${item.round}|${item.toolName}] ${item.text}`;
        // 标题、换行和中日韩正文与外层使用同一估算，不把超额尾部留给外层硬截断。
        const candidate = [...lines, [...categoryLines, line].join('\n')].join('\n');
        if (estimateTokens(candidate) > tokenBudget) {
          break;
        }
        categoryLines.push(line);
      }
      retained += categoryLines.length - 1;
      if (index < items.length) {
        omitted.push(`${category}=${items.length - index}`);
      }
      if (categoryLines.length > 1) {
        lines.push(categoryLines.join('\n'));
      }
    }
    if (omitted.length > 0) {
      // 预算截断是降级：记录每类被省略的条数，排查“模型为何看不到失败记录/重复读文件”时可定位。
      observeSafely(
        () =>
          this.#logger.info(
            `[ActiveContext] observation ledger truncated by budget=${tokenBudget}: retained ${retained} item(s), omitted ${omitted.join(', ')}`
          ),
        () => undefined
      );
    }

    return lines.length > 1 ? lines.join('\n') : null;
  }

  /** 台账整段跳过的降级记录：触发条件、剩余预算与被跳过的压缩观察数。 */
  #logLedgerSkipped(reason: 'budget_exhausted' | 'no_item_fits', remaining: number) {
    observeSafely(
      () =>
        this.#logger.info(
          `[ActiveContext] observation ledger skipped reason=${reason} remaining=${remaining} compressed=${this.#compressedObservations.length}`
        ),
      () => undefined
    );
  }

  #extractObservationLedgerItems(
    observation: Observation,
    summary: string
  ): ObservationLedgerItem[] {
    const { envelope } = unwrapObservedResult(observation.result);
    const structured = envelope?.structuredContent ?? observation.result;
    const observedCall = {
      tool: observation.toolName,
      args: observation.args,
      result: observation.result,
      ...(envelope ? { envelope } : {}),
    };
    const normalized = readToolObservation(observedCall);
    const args = normalized.params;
    const action = normalized.action;
    const items: ObservationLedgerItem[] = [];
    const ok = normalized.ok;

    if (!ok) {
      const failureText = sanitizeLedgerText(envelope?.text || summary || 'tool call failed', 180);
      items.push(
        this.#ledgerItem(
          'failureSet',
          `${observation.toolName}:${action}:${failureText}`,
          `${formatToolAction(observation.toolName, action)} failed: ${failureText}`,
          observation
        )
      );
    }

    if (envelope?.nextActionHint) {
      items.push(
        this.#ledgerItem(
          'nextHints',
          `${observation.toolName}:${action}:${envelope.nextActionHint}`,
          sanitizeLedgerText(envelope.nextActionHint, 180),
          observation
        )
      );
    } else if (!ok) {
      items.push(
        this.#ledgerItem(
          'nextHints',
          `${observation.toolName}:${action}:retry`,
          `Retry or verify ${formatToolAction(observation.toolName, action)} with narrower inputs.`,
          observation
        )
      );
    }

    if (observation.toolName === 'code') {
      if (action === 'read') {
        // successfulReadPaths 在调用失败时恒为空，这里只会是真正读到的文件。
        for (const filePath of successfulReadPaths(observedCall)) {
          items.push(
            this.#ledgerItem('readSet', `read:${filePath}`, filePath, observation),
            this.#ledgerItem('evidence', `read:${filePath}`, `Read ${filePath}`, observation)
          );
        }
        // 批量读取整体 ok 时单个失败成员不会走上面的 !ok 分支：必须单独进入 failureSet，
        // 否则窗口滑出后模型会反复请求同一缺失文件。整体失败时成员级条目补充具体文件名。
        for (const failure of failedReadPaths(observedCall)) {
          items.push(
            this.#ledgerItem(
              'failureSet',
              `read:${failure.path}:${failure.reason}`,
              `code.read failed: ${failure.path} (${failure.reason})`,
              observation
            )
          );
          if (ok && !envelope?.nextActionHint) {
            items.push(
              this.#ledgerItem(
                'nextHints',
                `read:${failure.path}:retry`,
                `Verify the path before re-reading ${failure.path}.`,
                observation
              )
            );
          }
        }
      } else if (action === 'search') {
        const searches = extractSearches(args, structured, envelope?.text);
        for (const search of searches) {
          items.push(
            this.#ledgerItem('searchSet', `search:${search}`, search, observation),
            this.#ledgerItem('evidence', `search:${search}`, `Searched ${search}`, observation)
          );
        }
      } else if (action) {
        const target = sanitizeLedgerText(
          stringFrom(args.path) || stringFrom(args.directory) || action,
          120
        );
        items.push(
          this.#ledgerItem(
            ok ? 'evidence' : 'failureSet',
            `code:${action}:${target}`,
            `${ok ? 'Ran' : 'Failed'} code.${action} ${target}`,
            observation
          )
        );
      }
    } else if (observation.toolName === 'graph') {
      const graphTarget = [
        action || 'query',
        stringFrom(args.type),
        stringFrom(args.entity) || stringFrom(args.className) || stringFrom(args.protocolName),
      ]
        .filter(Boolean)
        .join(':');
      items.push(
        this.#ledgerItem(
          ok ? 'evidence' : 'failureSet',
          `graph:${graphTarget || summary}`,
          `${ok ? 'Queried' : 'Failed'} graph ${sanitizeLedgerText(graphTarget || summary, 160)}`,
          observation
        )
      );
    } else if (observation.toolName === 'terminal') {
      const command = sanitizeLedgerText(stringFrom(args.command) || summary, 160);
      items.push(
        this.#ledgerItem(
          ok ? 'evidence' : 'failureSet',
          `terminal:${command}`,
          `${ok ? 'Ran' : 'Failed'} terminal command: ${command}`,
          observation
        )
      );
    } else if (observation.toolName !== 'memory' && observation.toolName !== 'note_finding') {
      items.push(
        this.#ledgerItem(
          ok ? 'evidence' : 'failureSet',
          `${observation.toolName}:${action}:${summary}`,
          `${ok ? 'Observed' : 'Failed'} ${formatToolAction(observation.toolName, action)}: ${sanitizeLedgerText(summary, 180)}`,
          observation
        )
      );
    }

    return items;
  }

  #ledgerItem(
    category: ObservationLedgerCategory,
    key: string,
    text: string,
    observation: Observation
  ): ObservationLedgerItem {
    return {
      category,
      key: normalizeLedgerKey(key),
      text: sanitizeLedgerText(text, 220),
      round: observation.round,
      toolName: observation.toolName,
    };
  }

  // ── Plan 内部方法 (从 ReasoningTrace 迁入) ──

  #setPlan(planText: string, iteration: number) {
    this.#plan = {
      text: planText,
      steps: this.#parsePlanSteps(planText),
      createdAtIteration: iteration,
      lastUpdatedAtIteration: iteration,
    };
  }

  #updatePlan(replanText: string, iteration: number) {
    if (!this.#plan) {
      this.#setPlan(replanText, iteration);
      return;
    }
    this.#planHistory.push({ ...this.#plan, steps: structuredClone(this.#plan.steps) });
    this.#plan.text = replanText;
    this.#plan.steps = this.#parsePlanSteps(replanText);
    this.#plan.lastUpdatedAtIteration = iteration;
  }

  /** 从 AI 文本中解析计划步骤 */
  #parsePlanSteps(text: string): PlanStep[] {
    if (!text) {
      return [];
    }
    const lines = text.split('\n');
    const steps: PlanStep[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*(?:\d+[.)]\s*|[-*]\s+)(.+)/);
      if (m && m[1].trim().length > 5) {
        steps.push({
          description: m[1].trim(),
          status: 'pending',
          keywords: this.#extractKeywords(m[1]),
        });
      }
    }
    return steps;
  }

  /** 从步骤描述中提取关键词 */
  #extractKeywords(text: string): string[] {
    const quoted = [...text.matchAll(/[`"']([A-Za-z_]\w{2,})[`"']/g)].map((m) => m[1]);
    const camelCase = [...text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)].map((m) => m[0]);
    const acronyms = [...text.matchAll(/\b([A-Z]{2,}[a-z]\w+)\b/g)].map((m) => m[0]);
    return [...new Set([...quoted, ...camelCase, ...acronyms])];
  }

  /** 从 AI 响应文本中提取"计划"部分 */
  #extractPlanFromText(text: string): string | null {
    if (!text || text.length < 30) {
      return null;
    }

    const searchArea = text.substring(0, 2000);

    const planMarkers = [
      /(?:探索|分析)?计划[:：\s]/i,
      /(?:my\s+)?plan[:：\s]/i,
      /步骤[:：\s]/i,
      /以下是.*(?:计划|步骤)/i,
    ];

    let planStart = -1;
    for (const marker of planMarkers) {
      const match = searchArea.match(marker);
      if (match && match.index !== undefined) {
        planStart = match.index + match[0].length;
        break;
      }
    }

    if (planStart === -1) {
      const listMatch = searchArea.match(/\n\s*1[.)]\s+/);
      if (listMatch && listMatch.index !== undefined) {
        planStart = listMatch.index;
      }
    }

    if (planStart === -1) {
      return null;
    }

    const remaining = searchArea.substring(planStart);
    const lines = remaining.split('\n');
    const planLines: string[] = [];
    let inList = false;

    for (const line of lines) {
      if (/^\s*(?:\d+[.)]\s+|[-*]\s+)/.test(line)) {
        inList = true;
        planLines.push(line);
      } else if (inList && line.trim() === '') {
        break;
      } else if (inList) {
        break;
      }
    }

    if (planLines.length < 2) {
      return null;
    }

    // 防御: 拒绝 "大部分是疑问句" 的编号列表
    // reflection nudge 的 "请评估: 1. ...是什么？ 2. ...？" 会被 LLM 回显，
    // 不是真正的探索计划，不能捕获为 plan steps
    const questionCount = planLines.filter((l) => /[？?]\s*$/.test(l.trim())).length;
    if (questionCount > planLines.length * 0.5) {
      return null;
    }

    return planLines.join('\n').trim();
  }
}

function extractSearches(
  args: Record<string, unknown>,
  structured: unknown,
  text?: string
): string[] {
  const searches = new Set<string>();
  const glob = stringFrom(args.glob);
  const patterns = stringListFrom(args.patterns);
  const pattern = stringFrom(args.pattern);
  for (const p of patterns.length > 0 ? patterns : [pattern].filter(Boolean)) {
    searches.add(`${p}${glob ? ` in ${glob}` : ''}`);
  }

  const structuredObj = objectFrom(structured);
  const total = typeof structuredObj?.total === 'number' ? structuredObj.total : null;
  const matches = Array.isArray(structuredObj?.matches) ? structuredObj.matches : [];
  for (const match of matches.slice(0, 5)) {
    const matchObj = objectFrom(match);
    const file = stringFrom(matchObj?.file);
    const line = typeof matchObj?.line === 'number' ? matchObj.line : null;
    if (file) {
      searches.add(`${file}${line ? `:${line}` : ''}`);
    }
  }
  if (total === 0 && searches.size > 0) {
    searches.add('no matches returned');
  }

  const firstLine = text?.split('\n').find((line) => line.trim());
  if (firstLine && /^\d+ matches\b/.test(firstLine.trim())) {
    searches.add(firstLine.trim());
  }

  return [...searches].map((entry) => sanitizeLedgerText(entry, 180)).filter(Boolean);
}

function sanitizeLedgerText(value: unknown, maxChars = 220): string {
  const raw = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const jsonLike = compactJsonForLedger(raw);
  if (jsonLike) {
    return limitLedgerText(jsonLike, maxChars);
  }
  const withoutJsonDebugFields = raw.replace(
    /"?(?:callId|parentCallId|startedAt|durationMs|timestamp|diagnostics|structuredContent|_meta)"?\s*:\s*(?:"[^"]*"|[\d.]+|true|false|null|\{[^}]*\}|\[[^\]]*\]),?/gi,
    ''
  );
  const withoutDebugWords = withoutJsonDebugFields.replace(
    /\b(callId|parentCallId|startedAt|durationMs|timestamp|diagnostics|structuredContent|_meta)\b/gi,
    'metadata'
  );
  const compact = withoutDebugWords.replace(/\s+/g, ' ').trim();
  return limitLedgerText(compact, maxChars);
}

function compactJsonForLedger(raw: string): string | null {
  if (!raw.startsWith('{') && !raw.startsWith('[')) {
    return null;
  }
  try {
    return compactLedgerValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function compactLedgerValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .slice(0, 6)
      .map((item) => compactLedgerValue(item))
      .filter(Boolean)
      .join('; ');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PROVIDER_DEBUG_KEYS.has(key))
      .map(([key, item]) => `${key}: ${compactLedgerValue(item)}`)
      .filter((entry) => entry.trim() !== '')
      .join('; ');
  }
  return String(value ?? '').trim();
}

function limitLedgerText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…`;
}

function normalizeLedgerKey(value: unknown): string {
  return sanitizeLedgerText(value, 260).toLowerCase();
}

function formatToolAction(toolName: string, action: string): string {
  return action ? `${toolName}.${action}` : toolName;
}

function objectFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function stringListFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringFrom(item)).filter(Boolean);
}

export default ActiveContext;
