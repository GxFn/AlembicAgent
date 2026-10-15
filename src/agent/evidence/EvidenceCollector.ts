/**
 * EvidenceCollector.ts — 从 Analyst 工具调用中收集结构化证据
 *
 * Bootstrap 质量门控核心组件: 将 Analyst 阶段的 toolCall 序列转化为
 * 类型化的证据地图、探索日志、负空间信号和可复制 graph 引用，供 Producer 阶段直接引用。
 *
 * 由 evaluation/analysisArtifact.ts 的 buildAnalysisArtifact / buildAnalysisReport 调用
 * （质量门 insightGateEvaluator 经它们取得证据）。
 *
 * 设计原则:
 * - 不保留原始工具返回值 (体积过大)
 * - 按工具类型萃取关键信息 (代码片段、搜索命中、类结构)
 * - 记录负空间: 搜索但未找到的模式 → 告知 Producer "这不存在"
 * - 预算控制: 代码片段总量 ≤ 32KB (Layer 2 Detail)
 *
 * @module EvidenceCollector
 */

import { readToolObservation } from '../utils/toolOutcomes.js';

// ── 常量 ──────────────────────────────────────────────────────────

/** 单个代码片段最大行数 */
const MAX_SNIPPET_LINES = 30;

/** 每个文件最多保留的代码片段数 */
const MAX_SNIPPETS_PER_FILE = 3;

/** 每个搜索模式最多保留的匹配条目 */
const MAX_SEARCH_MATCHES = 5;

/** 默认代码片段总字符预算 */
const DEFAULT_SNIPPET_BUDGET = 32_000;

/** 可复制 graph 引用的总量上限（防 prompt 膨胀） */
const MAX_GRAPH_EVIDENCE = 8;

// ── 读取展示态解析（证据保真核心；EvidenceCollector 与 EvidenceCapture 共用） ─────────
//
// evidenceMap 的片段会被 Producer 渲染成「可逐字复制的 coreCode」，其内容必须与源文件的
// 引用行范围逐字对照（Core snippet-match 门禁判据 = 去空白子串包含）；证据台账（EvidenceCapture）
// 存的原文还要参与 freshness 重切比哈希。而 code.read 的返回是「给模型看的展示态」：
//   1. 全文读 / 范围读每一行（包括空行）都带 `42|` 行号前缀（code.ts readSingleFile 渲染）；
//   2. 范围读可能带省略尾行 `... [N lines omitted; use startLine/endLine for more]`；
//   3. batch clamp / 路由截断按字符切出 head + 说明 + tail，tail 与 head 不连续，head 的最后
//      一段可能是残行，甚至是下一行的行号残片（如 `17`）；
//   4. 单 path 回执是纯字符串，mode 已丢失：DeltaCache 重读的 `[unchanged since last read]`、
//      `[delta: N hunk(s)]` 差分、AST 大纲与头尾预览都只能从内容形态上识别为“不是源码切片”。
// 因此只认一种形态：去掉截断说明及其后的 tail（并丢弃 head 可能残缺的末行）、去掉省略尾行后，
// 剩余每一行都是行号连续的 `N|` 前缀。不满足即整体返回 null（不做“首行无前缀就原样收下”的宽松兜底）。

/** 行号前缀：`42|code`。只匹配前缀，行体按原样切出（CRLF 文件行尾的 `\r` 也是源码的一部分）。 */
const READ_LINE_PREFIX_RE = /^(\d+)\|/;

/** 范围读省略尾行（只可能是最后一行；带行号前缀的源码行不会以 `... [` 开头）。 */
const READ_OMITTED_SUFFIX_LINE_RE = /^\.\.\. \[\d+ lines omitted\b/;

/**
 * batch clamp（code.ts batchReadClampNotice）与路由截断（router.ts truncationNotice）的说明，两者都以
 * 固定的 `\n\n` 开头。带行号前缀的展示里不会出现连续两个换行，所以首个匹配就是真正的截断点。
 */
const READ_CLAMP_MARKER_RE =
  /\n\n\.\.\. \[\d+ chars truncated(?: for batch read budget|, exceeded \d+ token limit)\] \.\.\./;

/** 严格解析出的连续源码切片（行号闭区间 + 剥掉前缀后的逐字原文）。 */
export interface NumberedReadDisplay {
  /** 剥掉 `N|` 前缀后的逐字源码（行间以 `\n` 连接）。 */
  content: string;
  startLine: number;
  endLine: number;
  /**
   * 原展示带截断说明：已丢弃说明之后的 tail 与 head 的最后一段（可能残缺）。Collector 取剩下的完整行；
   * Capture 据此整体降级 file-only（被截掉的部分无法由台账原文重切核对）。
   */
  truncated: boolean;
}

/**
 * 把 code.read 的展示态严格解析成连续源码切片；不是行号连续的 `N|` 源码展示时返回 null。
 *
 * 规则（L7-P13 / C10，Collector 与 Capture 同口径）：
 * - 有截断说明：只保留说明之前的 head，并丢弃 head 按 `\n` 切分后的最后一段——head 以换行结尾时
 *   这一段是空串，否则它可能是残行或行号残片，宁可少一行也不收残片；
 * - 无截断说明：最后一行是省略尾行时剔除；
 * - 剩余每一行都必须是 `N|` 前缀且行号从首行起逐行 +1，否则返回 null（派生视图、差分、大纲、
 *   头尾预览与无前缀文本都在这里被拒绝）。
 * 纯函数、无日志：调用方按各自语义决定拒绝时的诊断与降级路径。
 */
export function parseNumberedReadDisplay(display: string): NumberedReadDisplay | null {
  let body = String(display);
  const clamp = READ_CLAMP_MARKER_RE.exec(body);
  const truncated = clamp !== null;
  if (clamp) {
    body = body.slice(0, clamp.index);
  }
  const lines = body.split('\n');
  if (truncated) {
    lines.pop();
  } else if (READ_OMITTED_SUFFIX_LINE_RE.test(lines[lines.length - 1] ?? '')) {
    lines.pop();
  }
  if (lines.length === 0) {
    return null;
  }
  const stripped: string[] = [];
  let startLine = 0;
  for (const line of lines) {
    const prefix = READ_LINE_PREFIX_RE.exec(line);
    const lineNumber = prefix ? Number(prefix[1]) : 0;
    if (!prefix || !Number.isSafeInteger(lineNumber) || lineNumber < 1) {
      return null;
    }
    if (stripped.length === 0) {
      startLine = lineNumber;
    } else if (lineNumber !== startLine + stripped.length) {
      return null;
    }
    stripped.push(line.slice(prefix[0].length));
  }
  return {
    content: stripped.join('\n'),
    startLine,
    endLine: startLine + stripped.length - 1,
    truncated,
  };
}

/**
 * 展示被 parseNumberedReadDisplay 拒绝时，给探索日志一个可读的原因（只按形态归类，不影响判定）。
 * 单 path 回执的 mode 已丢失，这里按 DeltaCache / 大纲 / 头尾预览的固定文案识别常见派生视图。
 */
function describeRejectedReadDisplay(display: string): string {
  const head = display.trimStart();
  if (head.startsWith('[unchanged since last read]')) {
    return 'delta-cache unchanged placeholder';
  }
  if (/^\[delta: \d+ hunk\(s\)\]/.test(head)) {
    return 'delta-cache diff view';
  }
  if (
    /^\/\/ .+ — \d+ lines \(showing head \+ tail\)/.test(head) ||
    /File has \d+ lines\. Showing outline\./.test(display)
  ) {
    return 'outline view';
  }
  if (READ_CLAMP_MARKER_RE.test(display)) {
    return 'truncated display without a complete numbered line';
  }
  return 'not consecutive N| numbered source lines';
}

/** 一次工具调用写进探索日志的采集说明最多列几条（batch 读取可能涉及很多文件）。 */
const MAX_CALL_NOTES_IN_LOG = 3;

/** 提取异常写进探索日志与诊断的消息最多保留的字符数（防止宿主异常文本撑大 Producer 提示）。 */
const MAX_EXTRACTION_ERROR_CHARS = 160;

/**
 * 把提取阶段吞掉的异常压成一行可定位的说明：`<类型>: <消息>`（非 Error 值按 String 转写）。
 * 只用于诊断展示，不参与任何判定；转写本身失败时退回固定文案，不让诊断通道再抛错。
 */
function describeExtractionError(err: unknown): string {
  let text: string;
  try {
    text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } catch (stringifyErr: unknown) {
    void stringifyErr;
    text = 'unprintable thrown value';
  }
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > MAX_EXTRACTION_ERROR_CHARS
    ? `${singleLine.slice(0, MAX_EXTRACTION_ERROR_CHARS)}…`
    : singleLine;
}

/** 旧版 code.search 字符串回执的匹配行 `path:42: content`（兼容登记见 parseSearchOutputText） */
const SEARCH_OUTPUT_LINE_RE = /^(.+?):(\d+): (.*)$/;

// ── 锚点驱动证据补齐（groundFindingRefs） ────────────────────────
//
// 真机根因（2026-07-02 architecture 维度 10 提交 9 拒，SNIPPET_MISMATCH ×26）：全文读只在
// evidenceMap 留下「头 MAX_SNIPPET_LINES 行」窗口片段，而 note_finding 的锚点（如
// package.json 的 exports、layer-contract.json 的 layers 数组）常在窗口之外——Producer 的
// 「可复制 coreCode」覆盖不到锚点行，模型只能凭记忆重构代码，重试也无解。这里按 findings
// 实际引用的 path:line 锚点，经注入的只读端口从磁盘补读精确片段，让每条发现都有可照抄的
// 逐字证据。端口注入保持本模块零 node:fs（与 Core §C.11 resolver 端口同风格）。

/** finding.evidence 里的 `path:start(-end)` 锚点引用（路径需带扩展名，避免误抓散文） */
const FINDING_REF_RE = /([\w@][\w@\-./]*\.[A-Za-z][\w]*):(\d+)(?:-(\d+))?/g;

/**
 * 文档类扩展名：协作/设计/总结 markdown 是二手描述，不算代码接地——锚点补齐跳过它们
 * （真机上 Analyst 曾把 wakeflow-ledger 的 *.md 当证据主源，候选全被 SNIPPET/GRAPH 拒）。
 * Producer 渲染端同样把 md 条目降级为背景文件，两端一致收紧。
 */
const DOC_FILE_RE = /\.(?:md|markdown|rst|txt)$/i;

/** 是否为文档类路径（不可作代码证据的照抄来源） */
export function isDocEvidencePath(filePath: string): boolean {
  return DOC_FILE_RE.test(filePath);
}

/** 单行锚点补读时向下扩展的行数（含锚点行；给 coreCode 留可复制的上下文） */
const ANCHOR_CONTEXT_LINES = 8;

/**
 * 只读行范围端口：返回 [startLine, endLine] 的逐字源码与实际截止行（endLine 超文件末尾时
 * 收缩），路径越界 / 文件缺失 / 空范围返回 null。由调用方（analysisArtifact 的
 * createFsSnippetRangeReader）注入 fs 实现。
 */
export type SnippetRangeReader = (
  filePath: string,
  startLine: number,
  endLine: number
) => { content: string; endLine: number } | null;

/** groundFindingRefs 的输入形状（与 AnalysisArtifact.findings 对齐） */
export interface FindingRefLike {
  finding: string;
  evidence?: string;
  importance?: number;
}

/**
 * 旧轨迹 / 旧宿主字符串回执的兼容解析：`N matches (showing M)\n\npath:line: content`...。
 *
 * 现状：code.search handler 自 Wave M2（b87e784）起返回结构化 `{ total, shown, matches }`
 * （模型可见文本随 adapter 约定变为 JSON），formatSearchOutput 已退役；processToolCall 优先读
 * envelope.structuredContent，现行回执走 #extractSearchEvidence 的对象分支。只有 structuredContent
 * 与 result 都缺失、退到 envelope.text（现为 JSON）时才会进到这里，此时通常解析不出命中，
 * 也不会记负空间信号（不会把它误判成“没找到”）。
 *
 * 兼容登记（仓库规则：兼容代码须写明消费方、原因与移除条件）：
 * - 消费方：M2 之前录制的旧轨迹 / 回放，以及仍以纯文本回执 search 的旧宿主；
 *   test/evidence-collector-fidelity.test.ts 的字符串回执用例钉住这一形态。
 * - 原因：这类回执里 search 命中只以 `path:line: content` 文本存在，不解析就进不了 evidenceMap。
 * - 移除条件：决定③确认只支持当前单宿主、且不再回放 M2 之前的轨迹后，删除本函数、
 *   #extractSearchEvidence 的字符串分支与零命中文本负信号，并把相应测试改为结构化回执。
 */
function parseSearchOutputText(text: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(SEARCH_OUTPUT_LINE_RE);
    if (m?.[1] && m[2]) {
      matches.push({ file: m[1], line: Number(m[2]), content: m[3] ?? '' });
    }
  }
  return matches;
}

// ── 类型定义 ──────────────────────────────────────────────────────

/** 代码片段 */
export interface CodeSnippet {
  startLine: number;
  endLine: number;
  content: string;
  analystNote?: string;
}

/** 文件证据条目 */
export interface EvidenceEntry {
  filePath: string;
  codeSnippets: CodeSnippet[];
  summary: string;
  role?: string;
}

/** 探索日志条目 */
export interface ExplorationEntry {
  round: number;
  tool: string;
  intent: string;
  resultSummary: string;
  effective: boolean;
}

/** 负空间信号 */
export interface NegativeSignal {
  searchPattern: string;
  result: 'not_found' | 'empty' | 'irrelevant';
  implication: string;
}

/** 收集结果 */
export interface EvidenceCollectorResult {
  evidenceMap: Map<string, EvidenceEntry>;
  explorationLog: ExplorationEntry[];
  negativeSignals: NegativeSignal[];
  graphEvidence: string[];
}

/** 工具调用参数 */
interface ToolCallArgs {
  filePath?: string;
  filePaths?: string[];
  startLine?: number;
  pattern?: string;
  patterns?: string[];
  query?: string;
  className?: string;
  protocolName?: string;
  directory?: string;
  path?: string;
  rootClass?: string;
  methodName?: string;
  finding?: string;
  dimensionId?: string;
  [key: string]: unknown;
}

/** 工具调用 */
export interface ToolCall {
  tool?: string;
  name?: string;
  params?: ToolCallArgs;
  args?: ToolCallArgs;
  result?: ToolResult;
  envelope?: { ok?: boolean; status?: string; text?: string; structuredContent?: unknown };
}

/** 搜索匹配条目（code.search 实际产出字段是 content；context 为历史别名兼容） */
interface SearchMatch {
  file?: string;
  line?: number;
  content?: string;
  context?: string;
}

/** EvidenceCollector 选项 */
interface EvidenceCollectorOptions {
  snippetBudget?: number;
}

/** processToolCall 吞掉的一次提取异常（round 为调用序号，message 已压成单行并截断）。 */
interface EvidenceExtractionError {
  round: number;
  tool: string;
  action: string;
  message: string;
}

/**
 * 采集诊断计数（L7-P14 / C13）：区分“证据为什么没落地”。只经 diagnostics() 读取，不进入 build()
 * 返回值与任何公开类型；由 analysisArtifact 并入采集日志与 anchor grounding 日志。
 * 计数按锚点 / 片段累计（一条 finding 可能带多个锚点），与 build() 的片段数是两个口径。
 */
interface EvidenceCollectorDiagnostics {
  /** processToolCall 中被捕获的提取异常（类型 + 消息），对应探索日志的 `[evidence extraction failed: …]`。 */
  extractionErrors: EvidenceExtractionError[];
  /** 片段预算已用尽后到达、直接丢弃的片段数。 */
  droppedByBudget: number;
  /** 所在文件已有 MAX_SNIPPETS_PER_FILE 个片段而丢弃的片段数。 */
  droppedByFileCap: number;
  /** 预算尚有余量但单个片段放不下剩余预算而丢弃的片段数。 */
  droppedOversize: number;
  /** groundFindingRefs：只读端口返回 null / 空内容（路径越界、文件缺失、行号超界）的锚点数。 */
  anchorReaderMiss: number;
  /** groundFindingRefs：起始行已被既有片段覆盖、未补读的锚点数。 */
  anchorAlreadyCovered: number;
  /** groundFindingRefs：文档类路径（md 等）按设计不补读的锚点数。 */
  anchorDocSkipped: number;
  /** groundFindingRefs：行号无效（< 1）或区间倒序、无法补读的锚点数。 */
  anchorInvalidRange: number;
  /** graph 宿主回执里本应是数组、实际不是而被忽略的清单字段数（protocols / methods / conformers / properties）。 */
  malformedHostFields: number;
}

/** graph 回执里按数组读取的结构清单字段。 */
type GraphListField = 'protocols' | 'methods' | 'conformers' | 'properties';

/**
 * graph 清单成员的展示名：字符串原样；对象取 name / selector；其余（null、数字等畸形成员）记为 '?'，
 * 与旧实现“取不到名字就写 ?”的口径一致，只是不再对 null 成员抛错。
 */
function graphMemberName(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const { name, selector } = value as { name?: unknown; selector?: unknown };
    if (typeof name === 'string' && name) {
      return name;
    }
    if (typeof selector === 'string' && selector) {
      return selector;
    }
  }
  return '?';
}

/** 工具结果对象 (所有可能的结果属性联合) */
interface ToolResultObject {
  files?: Array<{
    path?: string;
    filePath?: string;
    content?: string;
    startLine?: number;
    mode?: string;
    /** code.read 大纲视图来源（'ast' | 'head-tail'，L4-P17）；带它即派生视图。 */
    outlineSource?: string;
  }>;
  path?: string;
  filePath?: string;
  content?: string;
  startLine?: number;
  mode?: string;
  outlineSource?: string;
  matches?: SearchMatch[];
  /** 旧宿主 / 旧轨迹的多模式搜索回执；现行 handler 不再产出（兼容登记见 #extractSearchEvidence）。 */
  batchResults?: Record<string, { matches?: SearchMatch[] }>;
  className?: string;
  superClass?: string;
  protocols?: string[];
  methods?: Array<string | { name?: string; selector?: string }>;
  properties?: unknown[];
  protocolName?: string;
  conformers?: string[];
  summary?: string;
  entries?: unknown[];
  children?: unknown[];
  classes?: unknown[];
  hierarchy?: unknown[];
  /** graph 工具回执的包装层：{ type, entity, result } 或 { type, entity, message }。 */
  result?: unknown;
  message?: string;
  /** 宿主随关系查询给出的图引用：每条是一个关系事实的规范写法，可原样引用。 */
  graphRefs?: unknown;
  /** 宿主没能把实体名落到声明上时为 false（没找到 / 有歧义）。 */
  resolved?: boolean;
  [key: string]: unknown;
}

/** 工具结果类型 */
type ToolResult = string | ToolResultObject | null | undefined;

/**
 * graph 工具回执里的查询结果。包装形态 { type, entity, result } 取 result；
 * 没有结果的回执（{ type, entity, message }）返回 null；旧的直连形态就是结果本身。
 */
function unwrapGraphResult(result: ToolResult): ToolResultObject | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  if ('result' in result) {
    const inner = result.result;
    return inner && typeof inner === 'object' && !Array.isArray(inner)
      ? (inner as ToolResultObject)
      : null;
  }
  if (typeof result.type === 'string' && typeof result.message === 'string') {
    return null;
  }
  return result;
}

/**
 * 宿主随结果给出的图引用（去掉空串、非字符串与重复）。
 * 结果里没有 graphRefs 字段时返回 null：这个宿主不说图引用的写法。
 */
function hostGraphRefs(result: ToolResultObject): string[] | null {
  if (!Array.isArray(result.graphRefs)) {
    return null;
  }
  return [
    ...new Set(
      result.graphRefs.filter(
        (ref): ref is string => typeof ref === 'string' && ref.trim().length > 0
      )
    ),
  ];
}

// ── 主类 ──────────────────────────────────────────────────────────

export class EvidenceCollector {
  /** 文件 → 证据条目 */
  #evidenceMap = new Map<string, EvidenceEntry>();

  /** 探索日志 */
  #explorationLog: ExplorationEntry[] = [];

  /** 负空间信号 */
  #negativeSignals: NegativeSignal[] = [];

  /**
   * graph 证据（R2）：Analyst 每次真实 graph 工具调用物化一条可复制 ref。门禁对关系声明
   * （依赖/调用链/上游下游等词）要求非空 graphRefs；架构维度知识本质就是关系，「规避关系词」
   * 是阉割价值。这里只物化真实发生过的 graph 查询——Producer 把它们渲染成可逐字复制的
   * graphRefs，模型没有 graph 证据时仍须改述，绝不教模型编造 ref 绕门禁。
   *
   * 按调用分组保存：一次调用方查询可能带回十几条引用，总量上限又只有几条，
   * 先到先得会让后面的查询一条也留不下。取用时各组轮流出一条（见 #selectGraphEvidence）。
   */
  #graphEvidenceByCall: string[][] = [];

  /** 代码片段总字符预算 */
  #snippetBudget;

  /** 当前已使用的片段字符数 */
  #snippetCharsUsed = 0;

  /**
   * 本次 processToolCall 的采集说明（读取展示未入片段的原因、截断时保留的完整行、被忽略的畸形
   * graph 字段），写进该调用的探索日志 resultSummary；每次调用开始时清空。
   */
  #callNotes: string[] = [];

  /** 采集诊断计数（C13），整个 Collector 生命周期累计；只经 diagnostics() 取快照。 */
  #diagnostics: EvidenceCollectorDiagnostics = {
    extractionErrors: [],
    droppedByBudget: 0,
    droppedByFileCap: 0,
    droppedOversize: 0,
    anchorReaderMiss: 0,
    anchorAlreadyCovered: 0,
    anchorDocSkipped: 0,
    anchorInvalidRange: 0,
    malformedHostFields: 0,
  };

  /** @param [options.snippetBudget=32000] 代码片段总字符预算 */
  constructor(options: EvidenceCollectorOptions = {}) {
    this.#snippetBudget = options.snippetBudget ?? DEFAULT_SNIPPET_BUDGET;
  }

  // ─── 公开 API ──────────────────────────────────────────

  /**
   * 处理单个工具调用，提取证据
   *
   * @param toolCall { tool/name, params/args, result }
   * @param [round=0] 调用序号
   */
  processToolCall(toolCall: ToolCall, round = 0) {
    const observation = readToolObservation(toolCall);
    const tool = observation.tool || 'unknown';
    const args = observation.params as ToolCallArgs;
    const raw = toolCall.envelope?.structuredContent ?? toolCall.result ?? toolCall.envelope?.text;
    const result: ToolResult =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && 'data' in raw && typeof raw.data === 'string'
          ? raw.data
          : observation.result;
    const hasResult =
      observation.ok &&
      result != null &&
      result !== '' &&
      !(typeof result === 'string' && this.#isErrorString(result));
    let extractionError: string | null = null;
    const action = (args.action as string) || '';
    this.#callNotes = [];

    // 按工具类型提取证据
    if (hasResult) {
      try {
        switch (tool) {
          case 'code':
            if (action === 'read') {
              this.#extractFileEvidence(args, result);
            } else if (action === 'search') {
              this.#extractSearchEvidence(args, result, toolCall.envelope?.status !== 'partial');
            }
            break;
          case 'graph':
            this.#extractGraphEvidence(args, result);
            break;
          // note_finding → WorkingMemory 已处理，不在此重复采集
        }
      } catch (err: unknown) {
        // 采集降级必须留在探索日志，不能把有返回体等同于成功证据。异常类型与消息一并写进
        // resultSummary 前缀并计入诊断（C13）：宿主回执畸形时据此定位字段与错误类别；
        // 已在异常前落地的片段 / 引用保留（它们各自已通过校验），本次调用整体记为无效探索。
        extractionError = describeExtractionError(err);
        this.#diagnostics.extractionErrors.push({
          round,
          tool,
          action,
          message: extractionError,
        });
      }
    }

    // 所有工具调用都记入探索日志；读取展示被拒绝或截断、graph 字段被忽略时把原因写在摘要前，便于排查证据为何缺席。
    const statusPrefix = !hasResult
      ? '[unconfirmed result; evidence skipped] '
      : extractionError !== null
        ? `[evidence extraction failed: ${extractionError}] `
        : '';
    this.#explorationLog.push({
      round,
      tool,
      intent: this.#inferIntent(tool, args),
      resultSummary: `${statusPrefix}${this.#formatCallNotes()}${this.#summarizeResult(tool, result)}`,
      effective: hasResult && extractionError === null && this.#isEffective(tool, action, result),
    });
  }

  /** 把本次调用的采集说明压成探索日志前缀（最多列 MAX_CALL_NOTES_IN_LOG 条，其余计数）。 */
  #formatCallNotes(): string {
    if (this.#callNotes.length === 0) {
      return '';
    }
    const shown = this.#callNotes.slice(0, MAX_CALL_NOTES_IN_LOG);
    const more =
      this.#callNotes.length > MAX_CALL_NOTES_IN_LOG
        ? `; +${this.#callNotes.length - MAX_CALL_NOTES_IN_LOG} more`
        : '';
    return `[${shown.join('; ')}${more}] `;
  }

  /**
   * 构建收集结果（形状与 EvidenceCollectorResult 一致）。
   *
   * @returns evidenceMap（文件 → 代码片段 / 结构摘要）、explorationLog（每次工具调用一条）、
   *   negativeSignals（确认完成的零命中搜索）与 graphEvidence（各次真实 graph 调用轮流选出的
   *   可复制引用，最多 MAX_GRAPH_EVIDENCE 条，见 #selectGraphEvidence）。
   */
  build() {
    return {
      evidenceMap: this.#evidenceMap,
      explorationLog: this.#explorationLog,
      negativeSignals: this.#negativeSignals,
      graphEvidence: this.#selectGraphEvidence(),
    };
  }

  /**
   * 采集诊断快照（L7-P14 / C13）：提取异常、预算 / 名额 / 超预算丢弃、锚点补齐各类跳过与畸形 graph
   * 字段的累计计数。刻意不并入 build() 返回值（不改证据结果形状）；每次返回独立副本，调用方可在
   * groundFindingRefs 前后各取一次求差，得到补齐阶段自己的丢弃原因。
   */
  diagnostics(): EvidenceCollectorDiagnostics {
    return {
      ...this.#diagnostics,
      extractionErrors: this.#diagnostics.extractionErrors.map((entry) => ({ ...entry })),
    };
  }

  /**
   * 锚点驱动证据补齐：把 findings 引用的 `path:line` 锚点补成可照抄的精确片段。
   *
   * 对每条 finding.evidence 中的锚点引用，若 evidenceMap 尚无覆盖该行的片段，经注入的
   * 只读端口从磁盘读取该范围的逐字源码入库（行号与内容天然对齐）。端口返回 null（路径
   * 越界 / 文件缺失 / 行号超界）时跳过——绝不编造证据；预算与每文件片段数沿用
   * #addCodeSnippet 的既有约束。每类跳过都计入 diagnostics()（anchorReaderMiss / anchorAlreadyCovered /
   * anchorDocSkipped / anchorInvalidRange / dropped*），供 anchor grounding 日志区分根因（C13）。
   */
  groundFindingRefs(findings: FindingRefLike[], readRange: SnippetRangeReader) {
    for (const finding of findings) {
      const evidence = typeof finding?.evidence === 'string' ? finding.evidence : '';
      if (!evidence) {
        continue;
      }
      for (const match of evidence.matchAll(FINDING_REF_RE)) {
        const filePath = match[1] ?? '';
        const startLine = Number(match[2]);
        if (!filePath || !Number.isFinite(startLine) || startLine < 1) {
          this.#diagnostics.anchorInvalidRange += 1;
          continue;
        }
        // 文档锚点不补：md 行不是代码证据，补了只会诱导 Producer 引用二手描述。
        if (isDocEvidencePath(filePath)) {
          this.#diagnostics.anchorDocSkipped += 1;
          continue;
        }
        // 带范围的锚点用原范围（cap 单片段行数上限）；单行锚点向下扩展少量上下文，
        // 让「可复制 coreCode」不至于薄到一行。
        const requestedEnd = match[3]
          ? Math.min(Number(match[3]), startLine + MAX_SNIPPET_LINES - 1)
          : startLine + ANCHOR_CONTEXT_LINES - 1;
        if (requestedEnd < startLine) {
          this.#diagnostics.anchorInvalidRange += 1;
          continue;
        }
        if (this.#hasSnippetCovering(filePath, startLine)) {
          this.#diagnostics.anchorAlreadyCovered += 1;
          continue;
        }
        const range = readRange(filePath, startLine, requestedEnd);
        if (!range?.content?.trim()) {
          this.#diagnostics.anchorReaderMiss += 1;
          continue;
        }
        // 预算 / 名额 / 超预算导致的丢弃由 #addCodeSnippet 计数。
        this.#addCodeSnippet(filePath, range.content, startLine);
      }
    }
  }

  /** evidenceMap 中是否已有片段覆盖该文件的指定行 */
  #hasSnippetCovering(filePath: string, line: number): boolean {
    const entry = this.#evidenceMap.get(filePath);
    if (!entry) {
      return false;
    }
    return entry.codeSnippets.some((s) => s.startLine <= line && line <= s.endLine);
  }

  // ─── 工具特化提取 ─────────────────────────────────────

  /** code.read — 提取代码片段（批量 result.files / 单文件 result.content），入库前统一严格解析保真 */
  #extractFileEvidence(args: ToolCallArgs, result: ToolResult) {
    const argPath = args.path || args.filePath;

    // 字符串结果 — 单 path 回执（mode 已丢失），可能是源码展示，也可能是 DeltaCache 占位/差分或大纲；
    // 由严格解析判定，不合格的不入片段（L7-P13 / C10）。
    if (typeof result === 'string') {
      if (this.#isErrorString(result)) {
        return;
      }
      if (argPath) {
        this.#addSanitizedSnippet(argPath, result);
      }
      return;
    }

    if (!result || typeof result !== 'object') {
      return;
    }

    // 批量读取: result.files 数组
    if (Array.isArray(result.files)) {
      for (const f of result.files) {
        const filePath = f.path || f.filePath;
        if (
          readToolObservation({ result: f }).ok &&
          filePath &&
          f.content &&
          !this.#isNonSourceReadMode(f.mode, f.outlineSource)
        ) {
          this.#addSanitizedSnippet(filePath, f.content);
        }
      }
      return;
    }

    // 单文件: result.content。deltaCache 的 unchanged/delta 模式返回占位/差分文本而非
    // 完整源码，行号也无从对齐，跳过采集（该文件首次全文读时已采）。
    if (this.#isNonSourceReadMode(result.mode, result.outlineSource)) {
      return;
    }
    const filePath = result.path || result.filePath || argPath;
    if (filePath && result.content) {
      this.#addSanitizedSnippet(filePath, result.content);
    }
  }

  /**
   * 内容不是连续源码、不可作照抄证据的读取视图：deltaCache 的 unchanged/delta 占位，以及
   * 大纲视图。大纲按 mode==='outline' 或 outlineSource（L4-P17：AST 大纲 / 头尾预览，
   * 头尾预览保持 mode:'outline'）任一识别，mode 缺席时也不会把头尾拼接当成源码片段。
   */
  #isNonSourceReadMode(mode: unknown, outlineSource?: unknown): boolean {
    return (
      mode === 'unchanged' || mode === 'delta' || mode === 'outline' || outlineSource !== undefined
    );
  }

  /**
   * 严格解析 code.read 展示态后入库；startLine 一律取行号前缀（范围读的返回体与参数都可能不可靠）。
   * 解析失败（派生视图、无前缀、行号不连续）或剥前缀后只剩空白时跳过，并在探索日志注明原因；
   * 截断展示只收 head 的完整行，同样注明保留的行区间。
   */
  #addSanitizedSnippet(filePath: string, rawContent: string) {
    const parsed = parseNumberedReadDisplay(rawContent);
    if (!parsed || !parsed.content.trim()) {
      const reason = parsed
        ? 'empty source after stripping N| prefixes'
        : describeRejectedReadDisplay(rawContent);
      this.#callNotes.push(`read display not collected: ${filePath} (${reason})`);
      return;
    }
    if (parsed.truncated) {
      this.#callNotes.push(
        `read display truncated: ${filePath} kept complete lines ${parsed.startLine}-${parsed.endLine}`
      );
    }
    this.#addCodeSnippet(filePath, parsed.content, parsed.startLine);
  }

  /**
   * code.search — 提取匹配 + 负空间信号。现行 handler 回执是结构化 `{ total, shown, matches }`，
   * 走下方单列表分支；字符串输出与批量 batchResults 两个分支只为旧轨迹 / 旧宿主保留（各自登记见分支旁）。
   */
  #extractSearchEvidence(args: ToolCallArgs, result: ToolResult, complete = true) {
    const patterns = this.#extractSearchPatterns(args);

    // 兼容分支：旧字符串回执（登记见 parseSearchOutputText）。
    if (typeof result === 'string') {
      const parsed = parseSearchOutputText(result);
      if (parsed.length === 0) {
        // 只有明确完成的零命中回执才是负证据；错误、预算省略和未知文本都不是“没找到”。
        // `0 matches (showing 0)` 是已退役 formatSearchOutput 的零命中文本，消费方与原因同
        // parseSearchOutputText；移除条件：随字符串分支一起删除（决定③）。
        if (complete && /^\s*0 matches \(showing 0\)\s*$/.test(result)) {
          for (const pattern of patterns) {
            this.#addNegativeSignal(pattern);
          }
        }
        return;
      }
      const searchNote = this.#mergedSearchNote(patterns);
      for (const m of parsed.slice(0, MAX_SEARCH_MATCHES)) {
        this.#addSearchMatch(m, searchNote);
      }
      return;
    }

    if (!result || typeof result !== 'object') {
      return;
    }

    const matches = result.matches || [];
    const batchResults = result.batchResults || {};

    // 批量搜索（兼容登记）：
    // - 消费方：旧宿主 / 旧轨迹的多模式回执 `{ batchResults: { [pattern]: { matches } } }`；本仓
    //   code.search handler 已把多个 pattern 合并为一个 matches 列表，仓内无生产来源。
    // - 原因：保留旧回执按模式记录的命中与负空间信号。
    // - 移除条件：决定③确认只支持当前单宿主、且不再回放旧轨迹后，删除本分支及
    //   #summarizeResult / #isEffective 中对 batchResults 的读取。
    if (Object.keys(batchResults).length > 0) {
      for (const [pattern, sub] of Object.entries(batchResults)) {
        const subMatches = (sub as { matches?: SearchMatch[] }).matches || [];
        if (!readToolObservation({ result: sub }).ok) {
          continue;
        }
        if (subMatches.length === 0) {
          if (complete && this.#isCompleteEmptySearch(sub)) {
            this.#addNegativeSignal(pattern);
          }
        } else {
          for (const m of subMatches.slice(0, MAX_SEARCH_MATCHES)) {
            this.#addSearchMatch(m, pattern);
          }
        }
      }
      return;
    }

    // 单列表 matches：现行结构化回执（多个 pattern 也合并在同一列表）及旧版单模式对象回执。
    if (matches.length === 0) {
      if (complete && this.#isCompleteEmptySearch(result)) {
        for (const p of patterns) {
          this.#addNegativeSignal(p);
        }
      }
    } else {
      const searchNote = this.#mergedSearchNote(patterns);
      for (const m of matches.slice(0, MAX_SEARCH_MATCHES)) {
        this.#addSearchMatch(m, searchNote);
      }
    }
  }

  /**
   * 合并命中列表的来源模式标注（L7-P14 / C57）：code.search 把多个模式的命中去重合并成一个列表、
   * 不标注每条命中来自哪个模式，所以只有单模式（或无模式参数，沿用 '?'）时才能如实标注；多模式时
   * 返回 undefined，片段不写 analystNote，而不是把所有命中都归到第一个模式。按模式分组的
   * batchResults 旧回执能准确归属，不走这里。删除 CodeSnippet.analystNote 字段属公开类型变化，随决定②。
   */
  #mergedSearchNote(patterns: string[]): string | undefined {
    if (patterns.length > 1) {
      return undefined;
    }
    return patterns[0] || '?';
  }

  /** 完整空数组是旧版已完成回执；显式部分/省略状态始终优先。 */
  #isCompleteEmptySearch(result: ToolResultObject): boolean {
    return (
      Array.isArray(result.matches) &&
      result.matches.length === 0 &&
      !result.incomplete &&
      result.truncated !== true &&
      result.status !== 'partial' &&
      (result.total === undefined || result.total === 0) &&
      (result.omittedCount === undefined || result.omittedCount === 0)
    );
  }

  /**
   * graph 工具 — 结构事实 → evidenceMap，关系事实 → 可复制 graph 引用。
   *
   * 两种回执：graph 工具的包装形态 { type, entity, result }，以及旧的直连形态（结果本身）。
   * 宿主随结果给出 graphRefs 时，那就是关系事实的规范写法，原样收下；宿主不说这种写法
   * （旧形态）时才由这里按类 / 协议的结构结论拼一条。
   *
   * 顺序（L7-P14 / C56）：graph handler 只包装、不校验字段形状，所以先记宿主 graphRefs（已逐条
   * 过滤成非空字符串），再算结构摘要——摘要阶段即使因畸形回执失败，也只丢摘要，不连带丢掉合法引用。
   */
  #extractGraphEvidence(args: ToolCallArgs, result: ToolResult) {
    const payload = unwrapGraphResult(result);
    if (!payload || payload.resolved === false) {
      return;
    }
    const hostRefs = hostGraphRefs(payload);
    if (hostRefs) {
      this.#recordGraphEvidence(hostRefs);
    }
    const isProtocol = Boolean(
      args.protocolName || args.type === 'protocol' || payload.protocolName
    );
    const summaryRef = isProtocol
      ? this.#extractProtocolEvidence(args, payload)
      : this.#extractClassEvidence(args, payload);
    // 宿主说图引用写法时（即使过滤后为空组）不再另拼结构引用，与旧行为一致。
    if (!hostRefs && summaryRef) {
      this.#recordGraphEvidence([summaryRef]);
    }
  }

  /**
   * graph 回执清单字段的形状守卫：缺席（undefined / null）视为空清单；不是数组时忽略该字段，
   * 计入 diagnostics().malformedHostFields 并在本次调用的探索日志注明字段名与实际类型——
   * 只丢这一段摘要，不让 `.join` / `.slice` 抛错把整次 graph 采集打成提取失败（C56）。
   */
  #graphListField(result: ToolResultObject, field: GraphListField): unknown[] {
    const value: unknown = result[field];
    if (value === undefined || value === null) {
      return [];
    }
    if (Array.isArray(value)) {
      return value;
    }
    this.#diagnostics.malformedHostFields += 1;
    this.#callNotes.push(`graph field ignored: ${field} (${typeof value})`);
    return [];
  }

  /** 类结构 → evidenceMap；返回按结构结论拼出的 graph 引用（旧形态的宿主用它） */
  #extractClassEvidence(args: ToolCallArgs, result: ToolResultObject): string | undefined {
    const filePath = result.filePath;
    // 说图引用写法的宿主，调用方 / 影响面等回执里也可能带 filePath；只有带类名的才是类结构。
    if (!filePath || (Array.isArray(result.graphRefs) && !result.className)) {
      return undefined;
    }
    const className = result.className || args.className || args.entity;

    // 先把摘要算完（清单字段经形状守卫）再建条目：摘要阶段失败时不会留下只有 role 的空壳条目（C56）。
    const protocols = this.#graphListField(result, 'protocols');
    const methods = this.#graphListField(result, 'methods');
    const properties = this.#graphListField(result, 'properties');
    const parts = [`Class: ${className}`];
    if (result.superClass) {
      parts.push(`Extends: ${result.superClass}`);
    }
    if (protocols.length) {
      parts.push(`Implements: ${protocols.map(graphMemberName).join(', ')}`);
    }
    if (methods.length) {
      const names = methods.slice(0, 5).map(graphMemberName);
      parts.push(`Methods(${methods.length}): ${names.join(', ')}`);
    }
    if (properties.length) {
      parts.push(`Props: ${properties.length}`);
    }
    const classSummary = parts.join(' | ');

    const entry = this.#getOrCreateEntry(filePath);
    entry.role = entry.role || 'class-definition';
    entry.summary = entry.summary ? `${entry.summary}; ${classSummary}` : classSummary;
    // 真实 graph 查询的结构结论，供关系声明引用。
    return `graph:class ${className} (${filePath}) — ${classSummary.replaceAll('|', '·')}`;
  }

  /** 协议结构 → evidenceMap；返回按结构结论拼出的 graph 引用（旧形态的宿主用它） */
  #extractProtocolEvidence(args: ToolCallArgs, result: ToolResultObject): string | undefined {
    const protocolName = result.protocolName || args.protocolName || args.entity;
    const filePath = result.filePath;
    if (!filePath) {
      return undefined;
    }

    // 与类结构同序：清单字段先过形状守卫、摘要算完再建条目（C56）。
    const methods = this.#graphListField(result, 'methods');
    const conformers = this.#graphListField(result, 'conformers');
    const parts = [`Protocol: ${protocolName}`];
    if (methods.length) {
      parts.push(`Methods: ${methods.length}`);
    }
    if (conformers.length) {
      parts.push(`Conformers: ${conformers.slice(0, 5).map(graphMemberName).join(', ')}`);
    }
    const summary = parts.join(' | ');

    const entry = this.#getOrCreateEntry(filePath);
    entry.role = entry.role || 'protocol-definition';
    entry.summary = entry.summary ? `${entry.summary}; ${summary}` : summary;
    return `graph:protocol ${protocolName} (${filePath}) — ${summary.replaceAll('|', '·')}`;
  }

  // ─── 内部辅助 ─────────────────────────────────────────

  /** 记下一次 graph 调用带回的引用（空组不记） */
  #recordGraphEvidence(refs: string[]) {
    if (refs.length > 0) {
      this.#graphEvidenceByCall.push(refs);
    }
  }

  /**
   * 取出可复制的 graph 引用：各次调用轮流出一条，直到上限。
   * 这样第一次查询带回再多引用，也不会把后面查询的引用挤掉。
   */
  #selectGraphEvidence(): string[] {
    const selected: string[] = [];
    for (let round = 0; selected.length < MAX_GRAPH_EVIDENCE; round += 1) {
      let remaining = false;
      for (const refs of this.#graphEvidenceByCall) {
        const ref = refs[round];
        if (ref === undefined) {
          continue;
        }
        remaining = true;
        if (!selected.includes(ref)) {
          selected.push(ref);
        }
        if (selected.length >= MAX_GRAPH_EVIDENCE) {
          break;
        }
      }
      if (!remaining) {
        break;
      }
    }
    return selected;
  }

  /** 获取或创建 evidence entry */
  #getOrCreateEntry(filePath: string) {
    let entry = this.#evidenceMap.get(filePath);
    if (!entry) {
      entry = { filePath, codeSnippets: [], summary: '' };
      this.#evidenceMap.set(filePath, entry);
    }
    return entry;
  }

  /**
   * 向 evidenceMap 添加代码片段 (带预算控制)。三类容量丢弃分别计入 diagnostics()（C13）：
   * 预算已用尽（droppedByBudget）、所在文件名额已满（droppedByFileCap）、单片段放不下剩余预算
   * （droppedOversize）；空路径 / 空内容不是容量问题，不计数。
   */
  #addCodeSnippet(filePath: string, content: string, startLine = 1, analystNote?: string) {
    if (!filePath || !content) {
      return;
    }
    if (this.#snippetCharsUsed >= this.#snippetBudget) {
      this.#diagnostics.droppedByBudget += 1;
      return;
    }

    const entry = this.#evidenceMap.get(filePath);
    if ((entry?.codeSnippets.length ?? 0) >= MAX_SNIPPETS_PER_FILE) {
      this.#diagnostics.droppedByFileCap += 1;
      return;
    }

    const lines = String(content).split('\n');
    const trimmed = lines.slice(0, MAX_SNIPPET_LINES);
    const snippetContent = trimmed.join('\n');
    if (!snippetContent) {
      return;
    }

    // 预算检查：剩余预算放不下这一片（预算尚未用尽）。
    if (this.#snippetCharsUsed + snippetContent.length > this.#snippetBudget) {
      this.#diagnostics.droppedOversize += 1;
      return;
    }

    this.#getOrCreateEntry(filePath).codeSnippets.push({
      startLine,
      endLine: startLine + trimmed.length - 1,
      content: snippetContent,
      ...(analystNote ? { analystNote } : {}),
    });
    this.#snippetCharsUsed += snippetContent.length;
  }

  /** 向 evidenceMap 添加搜索匹配（searchNote 缺席时片段不带 analystNote，见 #mergedSearchNote） */
  #addSearchMatch(match: SearchMatch, searchNote: string | undefined) {
    if (!match?.file) {
      return;
    }

    // 实际产出字段是 content（`path:line: content` 的匹配行文本）；context 为历史别名。
    // 注意先取内容再建 entry：内容缺失时不能留下「有 filePath 无 snippet」的空壳 entry，
    // 否则 Producer 会把它渲染成无行号的裸路径引用，误导模型触发 SOURCE_REF_LINE_MISSING。
    const matchText = match.content ?? match.context;
    if (!match.line || !matchText) {
      return;
    }

    const entry = this.#evidenceMap.get(match.file);
    // 去重: 同一行不重复添加；随后与 read 共用片段数量和字符预算。
    if (entry?.codeSnippets.some((s) => s.startLine === match.line)) {
      return;
    }

    // 单行语义：match.line 精确对应匹配行本身，startLine=endLine 保证行号与内容逐字对齐
    // （旧实现用 context 行数外推 endLine，多行上下文与起始行错位会毒化照抄链）。
    // cap 500 字符仍是该行的逐字前缀，snippet-match（去空白子串包含）依然成立。
    const singleLine = String(matchText).split('\n')[0]?.substring(0, 500) ?? '';
    if (!singleLine.trim()) {
      return;
    }
    this.#addCodeSnippet(
      match.file,
      singleLine,
      match.line,
      searchNote === undefined ? undefined : `search: "${searchNote}"`
    );
  }

  /** 添加负空间信号 (去重) */
  #addNegativeSignal(pattern: string) {
    if (!pattern) {
      return;
    }
    if (this.#negativeSignals.some((ns) => ns.searchPattern === pattern)) {
      return;
    }
    this.#negativeSignals.push({
      searchPattern: pattern,
      result: 'not_found',
      implication: `未在项目中找到 "${pattern}" 相关模式`,
    });
  }

  /** 检测错误字符串 */
  #isErrorString(str: string) {
    // 错误处理代码本身也包含 Error/failed；只识别工具错误前缀，不在源码正文找关键字。
    return /^\s*(?:error\s*:|tool execution error\b|cannot (?:read|search|list)\b|file not found\b|access denied\b|search failed\b|code\.(?:read|search) failed\b|无法读取|文件不存在)/i.test(
      str
    );
  }

  /** 从搜索参数中提取搜索模式 */
  #extractSearchPatterns(args: ToolCallArgs) {
    if (args.patterns && Array.isArray(args.patterns)) {
      return args.patterns;
    }
    if (args.pattern) {
      return [args.pattern];
    }
    if (args.query) {
      return [args.query];
    }
    return [];
  }

  /** 推断工具调用意图 — WHY */
  #inferIntent(tool: string | undefined, args: ToolCallArgs) {
    const action = (args.action as string) || '';
    switch (tool) {
      case 'code': {
        if (action === 'read') {
          if (args.filePaths?.length) {
            const preview = args.filePaths.slice(0, 3).join(', ');
            return `Read ${args.filePaths.length} files: ${preview}${args.filePaths.length > 3 ? '…' : ''}`;
          }
          return `Read ${args.path || args.filePath || '?'}`;
        }
        if (action === 'search') {
          const pats = this.#extractSearchPatterns(args);
          if (pats.length > 1) {
            return `Search ${pats.length} patterns: ${pats.slice(0, 3).join(', ')}`;
          }
          return `Search "${pats[0] || '?'}"`;
        }
        if (action === 'structure') {
          return `List ${args.directory || args.path || '/'}`;
        }
        if (action === 'outline') {
          return `Summarize ${args.path || args.filePath || '?'}`;
        }
        return `code.${action}(${JSON.stringify(args).substring(0, 50)})`;
      }
      case 'graph':
        if (args.protocolName) {
          return `Inspect protocol ${args.protocolName}`;
        }
        // 调用方、层级、影响面等查询按查询类型说明意图，不都叫"查看类"。
        if (typeof args.type === 'string' && args.type !== 'class' && args.entity) {
          return `Graph ${args.type} of ${args.entity}`;
        }
        if (args.className || args.entity) {
          return `Inspect class ${args.className || args.entity}`;
        }
        if (action === 'overview') {
          return 'Graph overview';
        }
        return `Query graph: ${(args.query || '').substring(0, 50)}`;
      case 'knowledge':
        if (action === 'search') {
          return `Search knowledge: "${args.query || '?'}"`;
        }
        return `knowledge.${action}`;
      case 'memory':
        return `memory.${action}: ${(args.finding || '').substring(0, 50)}`;
      case 'meta':
        return `meta.${action}`;
      case 'terminal':
        return `terminal exec`;
      default:
        return `${tool}(${JSON.stringify(args).substring(0, 50)})`;
    }
  }

  /** 生成工具结果摘要 — WHAT */
  #summarizeResult(tool: string | undefined, result: ToolResult) {
    if (result == null) {
      return '(no result)';
    }
    if (typeof result === 'string') {
      return result.length > 100 ? `${result.substring(0, 100)}…` : result;
    }
    if (typeof result !== 'object') {
      return String(result).substring(0, 100);
    }

    switch (tool) {
      case 'code': {
        if (result.files) {
          return `${result.files.length} files read`;
        }
        if (result.content) {
          return `${(result.content || '').split('\n').length} lines from ${result.path || '?'}`;
        }
        const batchKeys = Object.keys(result.batchResults || {});
        if (batchKeys.length > 0) {
          const total = batchKeys.reduce(
            (s, k) => s + (result.batchResults?.[k]?.matches?.length || 0),
            0
          );
          return `${total} matches across ${batchKeys.length} patterns`;
        }
        if (result.matches) {
          return `${result.matches.length} matches${result.incomplete ? '; incomplete' : ''}${result.truncated ? '; truncated' : ''}`;
        }
        if (result.entries || result.children) {
          return `${(result.entries || result.children || []).length} entries`;
        }
        return JSON.stringify(result).substring(0, 100);
      }
      case 'graph': {
        const graph = unwrapGraphResult(result);
        if (!graph) {
          return typeof result.message === 'string' ? result.message : 'no graph result';
        }
        if (graph.resolved === false) {
          return `entity not resolved (${String(graph.reason ?? 'unknown')})`;
        }
        if (graph.classes || graph.hierarchy) {
          return `${(graph.classes || graph.hierarchy || []).length} classes`;
        }
        if (graph.className) {
          // methods 与采集端同口径：不是数组（畸形宿主字段）时按 0 个方法计，不把字符串长度当方法数。
          const methodCount = Array.isArray(graph.methods) ? graph.methods.length : 0;
          return `class ${graph.className}${graph.superClass ? ` < ${graph.superClass}` : ''}, ${methodCount} methods`;
        }
        // 其余查询（调用方、层级、影响面、搜索、概览）：报出各清单的条数与图引用数。
        const counts = Object.entries(graph)
          .filter(([key, value]) => Array.isArray(value) && key !== 'graphRefs')
          .map(([key, value]) => `${key}=${(value as unknown[]).length}`);
        const refs = hostGraphRefs(graph)?.length ?? 0;
        return `${counts.join(', ') || 'graph result'}${refs > 0 ? `; ${refs} graph refs` : ''}`;
      }
      default:
        return JSON.stringify(result).substring(0, 100);
    }
  }

  /** 判断工具调用是否有效 (获取到新信息) */
  #isEffective(tool: string | undefined, action: string, result: ToolResult) {
    if (!result) {
      return false;
    }
    if (typeof result === 'string') {
      if (this.#isErrorString(result)) {
        return false;
      }
      // code.read 的字符串回执与片段采集同口径：只有能严格解析出非空源码切片才算获取到新信息；
      // DeltaCache 重读占位/差分、大纲等派生视图不再因“长度 > 10”被记为有效探索（L7-P13 / C10）。
      if (tool === 'code' && action === 'read') {
        const parsed = parseNumberedReadDisplay(result);
        return parsed !== null && parsed.content.trim().length > 0;
      }
      return result.length > 10;
    }
    if (typeof result !== 'object') {
      return true;
    }

    switch (tool) {
      case 'code':
        return (
          !!(result.content || result.files?.length) ||
          (result.matches?.length ?? 0) > 0 ||
          Object.values(result.batchResults || {}).some(
            (r: { matches?: SearchMatch[] }) => (r.matches?.length ?? 0) > 0
          )
        );
      case 'graph': {
        const graph = unwrapGraphResult(result);
        if (!graph || graph.resolved === false) {
          return false;
        }
        // 结构结论，或任何一份非空清单（调用方、层级、影响面、搜索命中、模块）。
        return (
          !!(graph.className || graph.protocolName || graph.classes || graph.hierarchy) ||
          Object.values(graph).some((value) => Array.isArray(value) && value.length > 0)
        );
      }
      default:
        return true;
    }
  }
}

export default EvidenceCollector;
