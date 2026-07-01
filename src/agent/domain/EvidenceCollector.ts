/**
 * EvidenceCollector.js — 从 Analyst 工具调用中收集结构化证据
 *
 * Bootstrap 质量门控核心组件: 将 Analyst 阶段的 toolCall 序列转化为
 * 类型化的证据地图、探索日志和负空间信号，供 Producer 阶段直接引用。
 *
 * 被 bootstrap-gate.js (buildAnalysisArtifact) 调用。
 *
 * 设计原则:
 * - 不保留原始工具返回值 (体积过大)
 * - 按工具类型萃取关键信息 (代码片段、搜索命中、类结构)
 * - 记录负空间: 搜索但未找到的模式 → 告知 Producer "这不存在"
 * - 预算控制: 代码片段总量 ≤ 32KB (Layer 2 Detail)
 *
 * @module EvidenceCollector
 */

// ── 常量 ──────────────────────────────────────────────────────────

/** 单个代码片段最大行数 */
const MAX_SNIPPET_LINES = 30;

/** 每个文件最多保留的代码片段数 */
const MAX_SNIPPETS_PER_FILE = 3;

/** 每个搜索模式最多保留的匹配条目 */
const MAX_SEARCH_MATCHES = 5;

/** 默认代码片段总字符预算 */
const DEFAULT_SNIPPET_BUDGET = 32_000;

// ── 读取内容净化（证据保真核心） ─────────────────────────────────
//
// evidenceMap 的片段会被 Producer 渲染成「可逐字复制的 coreCode」，其内容必须与源文件的
// 引用行范围逐字对照（Core snippet-match 门禁判据 = 去空白子串包含）。而 code.read 的返回
// 是「给模型看的展示态」，含三类非源码杂质，直接入库会毒化整条照抄链路：
//   1. 范围读每行带 `42|` 行号前缀（code.ts readSingleFile 的 slice 渲染）；
//   2. 范围读省略后缀 `... [N lines omitted; use startLine/endLine for more]`；
//   3. batch clamp 截断标记 `... [N chars truncated for batch read budget] ...`，且标记后
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
  /\n*\.\.\. \[\d+ chars truncated for batch read budget\] \.\.\.[\s\S]*$/;

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
  [key: string]: unknown;
}

/** 工具结果类型 */
type ToolResult = string | ToolResultObject | null | undefined;

// ── 主类 ──────────────────────────────────────────────────────────

export class EvidenceCollector {
  /** 文件 → 证据条目 */
  #evidenceMap = new Map<string, EvidenceEntry>();

  /** 探索日志 */
  #explorationLog: ExplorationEntry[] = [];

  /** 负空间信号 */
  #negativeSignals: NegativeSignal[] = [];

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
    const tool = toolCall.tool || toolCall.name || 'unknown';
    const rawArgs = toolCall.params || toolCall.args || {};
    // V2 tool calls nest real params under args.params — flatten for uniform access
    const nested =
      rawArgs.params && typeof rawArgs.params === 'object' ? (rawArgs.params as ToolCallArgs) : {};
    const args: ToolCallArgs = { ...nested, ...rawArgs };
    const result = toolCall.result;
    const hasResult = result != null && result !== '';

    // 按工具类型提取证据
    if (hasResult) {
      const action = (args.action as string) || '';
      try {
        switch (tool) {
          case 'code':
            if (action === 'read') {
              this.#extractFileEvidence(args, result);
            } else if (action === 'search') {
              this.#extractSearchEvidence(args, result);
            }
            break;
          case 'graph':
            if (args.protocolName || (action === 'query' && args.type === 'protocol')) {
              this.#extractProtocolEvidence(args, result);
            } else {
              this.#extractClassEvidence(args, result);
            }
            break;
          // note_finding → WorkingMemory 已处理，不在此重复采集
        }
      } catch {
        // 证据提取失败不影响整体流程，仅记入探索日志
      }
    }

    // 所有工具调用都记入探索日志
    this.#explorationLog.push({
      round,
      tool,
      intent: this.#inferIntent(tool, args),
      resultSummary: this.#summarizeResult(tool, result),
      effective: hasResult && this.#isEffective(tool, result),
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
    };
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
        if (filePath && f.content && !this.#isNonSourceReadMode(f.mode)) {
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
    return mode === 'unchanged' || mode === 'delta';
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
  #extractSearchEvidence(args: ToolCallArgs, result: ToolResult) {
    const patterns = this.#extractSearchPatterns(args);

    if (typeof result === 'string') {
      if (this.#isErrorString(result) || result.length < 10) {
        for (const p of patterns) {
          this.#addNegativeSignal(p);
        }
        return;
      }
      // search handler 的 data 是 formatSearchOutput 字符串（`path:line: content` 行）——
      // 旧实现对正常字符串直接 return，search 命中的行号证据从不进 evidenceMap，是
      // 冷启动候选 INSUFFICIENT_EVIDENCE / 裸路径 sourceRefs 的采集端根因。
      const parsed = parseSearchOutputText(result);
      if (parsed.length === 0) {
        for (const p of patterns) {
          this.#addNegativeSignal(p);
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
        if (subMatches.length === 0) {
          this.#addNegativeSignal(pattern);
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
      for (const p of patterns) {
        this.#addNegativeSignal(p);
      }
    } else {
      const searchNote = patterns[0] || '?';
      for (const m of matches.slice(0, MAX_SEARCH_MATCHES)) {
        this.#addSearchMatch(m, searchNote);
      }
    }
  }

  /** get_class_info — 提取类结构 → evidenceMap */
  #extractClassEvidence(args: ToolCallArgs, result: ToolResult) {
    if (typeof result !== 'object' || !result) {
      return;
    }

    const className = result.className || args.className || args.entity;
    const filePath = result.filePath;
    if (!filePath) {
      return;
    }

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
  }

  /** get_protocol_info — 提取协议结构 → evidenceMap */
  #extractProtocolEvidence(args: ToolCallArgs, result: ToolResult) {
    if (typeof result !== 'object' || !result) {
      return;
    }

    const protocolName = result.protocolName || args.protocolName;
    const filePath = result.filePath;
    if (!filePath) {
      return;
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
  }

  // ─── 内部辅助 ─────────────────────────────────────────

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
  #addCodeSnippet(filePath: string, content: string, startLine = 1) {
    if (!filePath || !content) {
      return;
    }
    if (this.#snippetCharsUsed >= this.#snippetBudget) {
      return;
    }

    const entry = this.#getOrCreateEntry(filePath);
    if (entry.codeSnippets.length >= MAX_SNIPPETS_PER_FILE) {
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

    entry.codeSnippets.push({
      startLine,
      endLine: startLine + trimmed.length - 1,
      content: snippetContent,
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

    const entry = this.#getOrCreateEntry(match.file);
    if (entry.codeSnippets.length >= MAX_SNIPPETS_PER_FILE) {
      return;
    }

    // 去重: 同一行不重复添加
    if (entry.codeSnippets.some((s) => s.startLine === match.line)) {
      return;
    }

    // 单行语义：match.line 精确对应匹配行本身，startLine=endLine 保证行号与内容逐字对齐
    // （旧实现用 context 行数外推 endLine，多行上下文与起始行错位会毒化照抄链）。
    // cap 500 字符仍是该行的逐字前缀，snippet-match（去空白子串包含）依然成立。
    const singleLine = String(matchText).split('\n')[0]?.substring(0, 500) ?? '';
    if (!singleLine.trim()) {
      return;
    }
    entry.codeSnippets.push({
      startLine: match.line,
      endLine: match.line,
      content: singleLine,
      analystNote: `search: "${searchNote}"`,
    });
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
    return /not found|error|不存在|无法|failed/i.test(str);
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
          return `${result.matches.length} matches`;
        }
        if (result.entries || result.children) {
          return `${(result.entries || result.children || []).length} entries`;
        }
        return JSON.stringify(result).substring(0, 100);
      }
      case 'graph':
        if (result.classes || result.hierarchy) {
          return `${(result.classes || result.hierarchy || []).length} classes`;
        }
        return `class ${result.className || '?'}${result.superClass ? ` < ${result.superClass}` : ''}, ${result.methods?.length || 0} methods`;
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
      case 'graph':
        return !!(result.className || result.classes || result.hierarchy);
      default:
        return true;
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// 类型定义 (JSDoc)
// ──────────────────────────────────────────────────────────────────

export default EvidenceCollector;
