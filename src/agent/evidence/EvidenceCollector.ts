/**
 * EvidenceCollector.js — 从 Analyst 工具调用中收集结构化证据
 *
 * Bootstrap 质量门控核心组件: 将 Analyst 阶段的 toolCall 序列转化为
 * 类型化的证据地图、探索日志和负空间信号，供 Producer 阶段直接引用。
 *
 * 被 evaluation 质量门(原 insightGate) (buildAnalysisArtifact) 调用。
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

// ── 读取内容净化（证据保真核心） ─────────────────────────────────
//
// evidenceMap 的片段会被 Producer 渲染成「可逐字复制的 coreCode」，其内容必须与源文件的
// 引用行范围逐字对照（Core snippet-match 门禁判据 = 去空白子串包含）。而 code.read 的返回
// 是「给模型看的展示态」，含三类非源码杂质，直接入库会毒化整条照抄链路：
//   1. 范围读每行带 `42|` 行号前缀（code.ts readSingleFile 的 slice 渲染）；
//   2. 范围读省略后缀 `... [N lines omitted; use startLine/endLine for more]`；
//   3. batch clamp 截断标记 batch/router 的显式截断标记，且标记后
//      的 tail 与 head 不连续，绝不能拼进同一片段。
// 这里在采集端一次性还原为纯源码，并用行号前缀校准 startLine（范围读的返回体不带
// startLine 字段，前缀是唯一可靠行号来源）。

/** 范围读行号前缀：`42|code` */
const READ_LINE_PREFIX_RE = /^(\d+)\|/;

/** 范围读省略后缀标记行 */
const READ_OMITTED_SUFFIX_RE =
  /\n?\.\.\. \[\d+ lines omitted; use startLine\/endLine for more\]\s*$/;

/** batch clamp 截断标记（其后的 tail 与 head 不连续，只保留 head） */
const READ_CLAMP_MARKER_RE =
  /\n*\.\.\. \[\d+ chars truncated(?: for batch read budget|, exceeded \d+ token limit)\] \.\.\.[\s\S]*$/;

/** 净化结果：纯源码内容 + 从行号前缀校准出的起始行（无前缀时为 null） */
interface SanitizedReadSnippet {
  content: string;
  startLineFromPrefix: number | null;
}

/**
 * 把 code.read 的展示态内容还原为可与源文件逐字对照的纯代码。
 * 返回 null 表示内容不可保真采集（净化后为空）。
 */
function sanitizeReadSnippet(raw: string): SanitizedReadSnippet | null {
  let text = String(raw);
  // 单 path 的旧返回口是纯字符串，mode 已丢失；识别宿主自身的 outline/头尾预览模板。
  // 这些显示内容不是连续源码，即使夹有 N| 行也不能整体重新认证为 source snippet。
  if (
    /^\/\/ .+ — \d+ lines \(showing head \+ tail\)/.test(text) ||
    /File has \d+ lines\. Showing outline\. Use startLine\/endLine to read specific sections\.\s*$/.test(
      text
    )
  ) {
    return null;
  }
  // clamp 头尾拼接：只保留 head（源文件逐字前缀），丢弃标记与不连续的 tail。
  text = text.replace(READ_CLAMP_MARKER_RE, '');
  // 范围读省略后缀：剔除标记行本身。
  text = text.replace(READ_OMITTED_SUFFIX_RE, '');
  if (!text.trim()) {
    return null;
  }

  const lines = text.split('\n');
  const firstMatch = lines[0]?.match(READ_LINE_PREFIX_RE);
  if (!firstMatch) {
    return { content: text, startLineFromPrefix: null };
  }
  // 首行带行号前缀 → 视为范围读渲染，逐行剥前缀并用首行行号校准 startLine。
  // 个别行（空行等）可能无前缀，原样保留。
  const stripped = lines.map((line) => line.replace(READ_LINE_PREFIX_RE, ''));
  return {
    content: stripped.join('\n'),
    startLineFromPrefix: Number(firstMatch[1]),
  };
}

/** code.search 字符串输出的匹配行：`path:42: content`（formatSearchOutput 契约） */
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
 * 收缩），路径越界 / 文件缺失 / 空范围返回 null。由调用方（insightGate）注入 fs 实现。
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
 * 解析 code.search 的字符串输出（`N matches (showing M)\n\npath:line: content`...）。
 * search handler 最终 ok() 的 data 就是这个格式化字符串（不是 {matches} 对象），
 * 不解析它 search 证据就 100% 进不了 evidenceMap。契约由 evidence-collector 测试钉住。
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

/** 工具结果对象 (所有可能的结果属性联合) */
interface ToolResultObject {
  files?: Array<{
    path?: string;
    filePath?: string;
    content?: string;
    startLine?: number;
    mode?: string;
  }>;
  path?: string;
  filePath?: string;
  content?: string;
  startLine?: number;
  mode?: string;
  matches?: SearchMatch[];
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
    let extractionFailed = false;

    // 按工具类型提取证据
    if (hasResult) {
      const action = (args.action as string) || '';
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
        // 采集降级必须留在探索日志，不能把有返回体等同于成功证据。
        extractionFailed = true;
        void err;
      }
    }

    // 所有工具调用都记入探索日志
    this.#explorationLog.push({
      round,
      tool,
      intent: this.#inferIntent(tool, args),
      resultSummary: `${!hasResult ? '[unconfirmed result; evidence skipped] ' : extractionFailed ? '[evidence extraction failed] ' : ''}${this.#summarizeResult(tool, result)}`,
      effective: hasResult && !extractionFailed && this.#isEffective(tool, result),
    });
  }

  /**
   * 构建收集结果
   *
   * @returns {{
   *   evidenceMap: Map<string, EvidenceEntry>,
   *   explorationLog: ExplorationEntry[],
   *   negativeSignals: NegativeSignal[]
   * }}
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
   * 锚点驱动证据补齐：把 findings 引用的 `path:line` 锚点补成可照抄的精确片段。
   *
   * 对每条 finding.evidence 中的锚点引用，若 evidenceMap 尚无覆盖该行的片段，经注入的
   * 只读端口从磁盘读取该范围的逐字源码入库（行号与内容天然对齐）。端口返回 null（路径
   * 越界 / 文件缺失 / 行号超界）时静默跳过——绝不编造证据；预算与每文件片段数沿用
   * #addCodeSnippet 的既有约束。
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
          continue;
        }
        // 文档锚点不补：md 行不是代码证据，补了只会诱导 Producer 引用二手描述。
        if (isDocEvidencePath(filePath)) {
          continue;
        }
        // 带范围的锚点用原范围（cap 单片段行数上限）；单行锚点向下扩展少量上下文，
        // 让「可复制 coreCode」不至于薄到一行。
        const requestedEnd = match[3]
          ? Math.min(Number(match[3]), startLine + MAX_SNIPPET_LINES - 1)
          : startLine + ANCHOR_CONTEXT_LINES - 1;
        if (requestedEnd < startLine) {
          continue;
        }
        if (this.#hasSnippetCovering(filePath, startLine)) {
          continue;
        }
        const range = readRange(filePath, startLine, requestedEnd);
        if (!range?.content?.trim()) {
          continue;
        }
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

  /** code.read — 提取代码片段（批量 result.files / 单文件 result.content），入库前统一净化保真 */
  #extractFileEvidence(args: ToolCallArgs, result: ToolResult) {
    const argPath = args.path || args.filePath;

    // 字符串结果 — 可能是错误消息或直接内容
    if (typeof result === 'string') {
      if (this.#isErrorString(result)) {
        return;
      }
      if (argPath) {
        this.#addSanitizedSnippet(argPath, result, args.startLine || 1);
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
          !this.#isNonSourceReadMode(f.mode)
        ) {
          this.#addSanitizedSnippet(filePath, f.content, f.startLine || 1);
        }
      }
      return;
    }

    // 单文件: result.content。deltaCache 的 unchanged/delta 模式返回占位/差分文本而非
    // 完整源码，行号也无从对齐，跳过采集（该文件首次全文读时已采）。
    if (this.#isNonSourceReadMode(result.mode)) {
      return;
    }
    const filePath = result.path || result.filePath || argPath;
    if (filePath && result.content) {
      this.#addSanitizedSnippet(filePath, result.content, result.startLine || args.startLine || 1);
    }
  }

  /** deltaCache 命中的读取模式：内容不是完整源码，不可作照抄证据 */
  #isNonSourceReadMode(mode: unknown): boolean {
    return mode === 'unchanged' || mode === 'delta' || mode === 'outline';
  }

  /** 净化 code.read 展示态内容后入库；行号前缀存在时以前缀校准 startLine（比参数更可靠） */
  #addSanitizedSnippet(filePath: string, rawContent: string, fallbackStartLine: number) {
    const sanitized = sanitizeReadSnippet(rawContent);
    if (!sanitized) {
      return;
    }
    this.#addCodeSnippet(
      filePath,
      sanitized.content,
      sanitized.startLineFromPrefix ?? fallbackStartLine
    );
  }

  /** code.search — 提取匹配 + 负空间信号（字符串输出 / 批量 batchResults / 单模式 matches） */
  #extractSearchEvidence(args: ToolCallArgs, result: ToolResult, complete = true) {
    const patterns = this.#extractSearchPatterns(args);

    if (typeof result === 'string') {
      const parsed = parseSearchOutputText(result);
      if (parsed.length === 0) {
        // 只有明确完成的零命中回执才是负证据；错误、预算省略和未知文本都不是“没找到”。
        if (complete && /^\s*0 matches \(showing 0\)\s*$/.test(result)) {
          for (const pattern of patterns) {
            this.#addNegativeSignal(pattern);
          }
        }
        return;
      }
      const searchNote = patterns[0] || '?';
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

    // 批量搜索
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

    // 单模式搜索
    if (matches.length === 0) {
      if (complete && this.#isCompleteEmptySearch(result)) {
        for (const p of patterns) {
          this.#addNegativeSignal(p);
        }
      }
    } else {
      const searchNote = patterns[0] || '?';
      for (const m of matches.slice(0, MAX_SEARCH_MATCHES)) {
        this.#addSearchMatch(m, searchNote);
      }
    }
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
   */
  #extractGraphEvidence(args: ToolCallArgs, result: ToolResult) {
    const payload = unwrapGraphResult(result);
    if (!payload || payload.resolved === false) {
      return;
    }
    const isProtocol = Boolean(
      args.protocolName || args.type === 'protocol' || payload.protocolName
    );
    const summaryRef = isProtocol
      ? this.#extractProtocolEvidence(args, payload)
      : this.#extractClassEvidence(args, payload);
    const hostRefs = hostGraphRefs(payload);
    if (hostRefs) {
      this.#recordGraphEvidence(hostRefs);
    } else if (summaryRef) {
      this.#recordGraphEvidence([summaryRef]);
    }
  }

  /** 类结构 → evidenceMap；返回按结构结论拼出的 graph 引用（旧形态的宿主用它） */
  #extractClassEvidence(args: ToolCallArgs, result: ToolResultObject): string | undefined {
    const filePath = result.filePath;
    // 说图引用写法的宿主，调用方 / 影响面等回执里也可能带 filePath；只有带类名的才是类结构。
    if (!filePath || (Array.isArray(result.graphRefs) && !result.className)) {
      return undefined;
    }
    const className = result.className || args.className || args.entity;

    const entry = this.#getOrCreateEntry(filePath);
    entry.role = entry.role || 'class-definition';

    const parts = [`Class: ${className}`];
    if (result.superClass) {
      parts.push(`Extends: ${result.superClass}`);
    }
    if (result.protocols?.length) {
      parts.push(`Implements: ${result.protocols.join(', ')}`);
    }
    if (result.methods?.length) {
      const names = result.methods
        .slice(0, 5)
        .map((m) => (typeof m === 'string' ? m : m.name || m.selector || '?'));
      parts.push(`Methods(${result.methods.length}): ${names.join(', ')}`);
    }
    if (result.properties?.length) {
      parts.push(`Props: ${result.properties.length}`);
    }

    const classSummary = parts.join(' | ');
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

    const entry = this.#getOrCreateEntry(filePath);
    entry.role = entry.role || 'protocol-definition';

    const parts = [`Protocol: ${protocolName}`];
    if (result.methods?.length) {
      parts.push(`Methods: ${result.methods.length}`);
    }
    if (result.conformers?.length) {
      parts.push(`Conformers: ${result.conformers.slice(0, 5).join(', ')}`);
    }

    const summary = parts.join(' | ');
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

  /** 向 evidenceMap 添加代码片段 (带预算控制) */
  #addCodeSnippet(filePath: string, content: string, startLine = 1, analystNote?: string) {
    if (!filePath || !content) {
      return;
    }
    if (this.#snippetCharsUsed >= this.#snippetBudget) {
      return;
    }

    const entry = this.#evidenceMap.get(filePath);
    if ((entry?.codeSnippets.length ?? 0) >= MAX_SNIPPETS_PER_FILE) {
      return;
    }

    const lines = String(content).split('\n');
    const trimmed = lines.slice(0, MAX_SNIPPET_LINES);
    const snippetContent = trimmed.join('\n');
    if (!snippetContent) {
      return;
    }

    // 预算检查
    if (this.#snippetCharsUsed + snippetContent.length > this.#snippetBudget) {
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

  /** 向 evidenceMap 添加搜索匹配 */
  #addSearchMatch(match: SearchMatch, searchNote: string) {
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
    this.#addCodeSnippet(match.file, singleLine, match.line, `search: "${searchNote}"`);
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
          return `class ${graph.className}${graph.superClass ? ` < ${graph.superClass}` : ''}, ${graph.methods?.length || 0} methods`;
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
  #isEffective(tool: string | undefined, result: ToolResult) {
    if (!result) {
      return false;
    }
    if (typeof result === 'string') {
      return !this.#isErrorString(result) && result.length > 10;
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

// ──────────────────────────────────────────────────────────────────
// 类型定义 (JSDoc)
// ──────────────────────────────────────────────────────────────────

export default EvidenceCollector;
