/**
 * L4 memory package builder.
 *
 * L4 compaction should summarize a structured runtime memory package, not a
 * raw Chat Completions transcript. Raw messages may be used only after they are
 * projected into plain text fields.
 */

import path from 'node:path';
import { readToolObservation, successfulReadPaths } from '../utils/toolOutcomes.js';

type UnknownRecord = Record<string, unknown>;

interface DistilledFindingLike {
  finding?: unknown;
  evidence?: unknown;
  importance?: unknown;
}

interface DistilledContextLike {
  keyFindings?: unknown;
  toolCallSummary?: unknown;
  stats?: unknown;
  plan?: unknown;
  totalObservations?: unknown;
  compressedCount?: unknown;
}

interface DistillableContext {
  distill?: () => DistilledContextLike;
}

interface EvidenceMapEntryLike {
  filePath?: unknown;
  summary?: unknown;
  role?: unknown;
  codeSnippets?: unknown;
}

interface EvidenceCollectorResultLike {
  evidenceMap?: Map<string, EvidenceMapEntryLike> | Record<string, EvidenceMapEntryLike>;
  explorationLog?: unknown;
  negativeSignals?: unknown;
}

interface L4MessageLike {
  role?: unknown;
  content?: unknown;
  toolCalls?: unknown;
  tool_calls?: unknown;
  toolCallId?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

interface ToolCallLike {
  tool?: unknown;
  name?: unknown;
  args?: unknown;
  params?: unknown;
  result?: unknown;
  envelope?: unknown;
}

interface DiagnosticsLike {
  degraded?: unknown;
  timedOutStages?: unknown;
  gateFailures?: unknown;
  warnings?: unknown;
  efficiency?: {
    cancelReason?: unknown;
    tokenUsage?: unknown;
  };
}

export interface L4MemoryFinding {
  id: string;
  finding: string;
  evidence: string;
  importance: number;
}

export interface L4EvidenceRef {
  path: string;
  line?: number;
  summary?: string;
  source: 'finding' | 'evidence-map' | 'tool-call';
}

export interface L4MemoryPackage {
  kind: 'l4_memory_package';
  version: 1;
  goal: string;
  phase: string;
  stageStatus: string;
  keyFindings: L4MemoryFinding[];
  evidenceRefs: L4EvidenceRef[];
  toolResultSummary: string[];
  unresolvedQuestions: string[];
  recentConversation: string[];
  failureState: string[];
  stats: {
    totalObservations: number;
    compressedCount: number;
  };
  plan: string[];
}

export interface L4MemoryPackageInput {
  goal?: unknown;
  phase?: unknown;
  stageStatus?: unknown;
  activeContext?: DistillableContext | null;
  distilledContext?: DistilledContextLike | null;
  evidence?: EvidenceCollectorResultLike | null;
  diagnostics?: DiagnosticsLike | null;
  recentMessages?: readonly L4MessageLike[];
  toolCalls?: readonly ToolCallLike[];
  unresolvedQuestions?: readonly unknown[];
  failureState?: readonly unknown[];
}

export interface L4SummaryValidationResult {
  ok: boolean;
  missing: string[];
}

const MAX_RECENT_MESSAGES = 8;
const MAX_TOOL_SUMMARIES = 12;
/**
 * 有蒸馏摘要时失败回执的固定配额。蒸馏摘要与 toolCalls 描述的是同一批调用，
 * 其余槽位（至少 8 条）留给蒸馏摘要与探索日志，避免原始回执把蒸馏摘要挤出窗口。
 */
const MAX_FAILED_RECEIPTS_WITH_DISTILLED = 4;
const MAX_EVIDENCE_REFS = 12;
const MAX_FINDINGS = 8;
/** 未决问题现在会进入渲染文本与 L4 替换消息，必须有上限，避免调用方传入的长列表撑爆摘要输入。 */
const MAX_UNRESOLVED_QUESTIONS = 8;
const MAX_UNRESOLVED_QUESTION_CHARS = 240;

/**
 * ActiveContext.distill() 抛错时写入 failureState 的键（格式 `distill_failed=<原因>`）。
 * 本模块没有 logger，ContextWindow.compactL4 按这个键识别降级并打 warn。
 * 只在模块内部共享，不经 context/index.ts 对外导出。
 */
export const L4_DISTILL_FAILED_STATE_KEY = 'distill_failed';

// ── 摘要覆盖判定参数（validateL4Summary） ──────────────────────────────
// 中文没有空格分词：连续汉字按字符二元组判断覆盖，忠实的中文改写会保留大部分关键词组，
// 笼统摘要只会碰巧命中个别常见词组。任一 4 字窗口原样出现时直接视为覆盖。
const CJK_RUN_RE = /[㐀-䶿一-鿿]+/g;
const CJK_CHAR_RE = /[㐀-䶿一-鿿]/;
const LATIN_TOKEN_RE = /[A-Za-z0-9_]+/g;
const CJK_EXACT_WINDOW = 4;
const CJK_BIGRAM_COVERAGE_RATIO = 0.3;
const CJK_MIN_BIGRAM_HITS = 2;
const MIN_LATIN_TOKEN_LENGTH = 4;
const MAX_LATIN_TOKENS = 4;
/** 英文停用词（只列长度 ≥ 4 的，更短的 token 已被长度下限过滤）：它们出现在任何摘要里都不代表覆盖了发现。 */
const ENGLISH_STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'because',
  'been',
  'before',
  'being',
  'both',
  'could',
  'does',
  'done',
  'each',
  'false',
  'from',
  'have',
  'here',
  'into',
  'just',
  'make',
  'made',
  'more',
  'most',
  'must',
  'none',
  'null',
  'only',
  'onto',
  'other',
  'over',
  'same',
  'shall',
  'should',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'true',
  'under',
  'undefined',
  'very',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'without',
  'would',
]);
/** 失败针里的平凡末段：布尔、空值和纯数字在任何摘要里都可能出现，不能证明保留了失败状态。 */
const TRIVIAL_FAILURE_NEEDLES = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'none',
  'yes',
  'no',
  'unknown',
]);
/** 失败状态键对应的中文同义词：摘要按提示用中文改写时，用它们判断是否保留了失败语义。 */
const FAILURE_KEY_SYNONYMS = new Map<string, readonly string[]>([
  ['degraded', ['降级']],
  ['cancelReason', ['取消', '中止']],
  ['timedOutStage', ['超时']],
  ['gateFailure', ['门禁']],
  [L4_DISTILL_FAILED_STATE_KEY, ['蒸馏失败']],
]);

function asString(value: unknown, fallback = '') {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value == null) {
    return fallback;
  }
  return String(value).trim();
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeJson(value: unknown, maxChars = 600) {
  if (typeof value === 'string') {
    return truncate(value, maxChars);
  }
  try {
    return truncate(JSON.stringify(value), maxChars);
  } catch {
    return truncate(String(value), maxChars);
  }
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

interface DistilledReadResult {
  distilled: DistilledContextLike;
  /** distill() 抛错时的失败状态行（`distill_failed=<原因>`）；成功或未提供 activeContext 时缺省。 */
  failure?: string;
}

function readDistilled(input: L4MemoryPackageInput): DistilledReadResult {
  if (input.distilledContext) {
    return { distilled: input.distilledContext };
  }
  try {
    return { distilled: input.activeContext?.distill?.() || {} };
  } catch (err: unknown) {
    // 降级为空蒸馏结果：keyFindings、plan、stats 和蒸馏工具摘要都会缺失。
    // 原因写进包的 failureState，摘要模型与 validateL4Summary 都能看到这次降级，
    // 不会把只基于近期消息的摘要当成完整记忆；warn 日志由 ContextWindow.compactL4 打。
    const reason = (err instanceof Error ? err.message || err.name : String(err)).trim();
    return {
      distilled: {},
      failure: `${L4_DISTILL_FAILED_STATE_KEY}=${truncate(reason || 'unknown', 200)}`,
    };
  }
}

function normalizeFindings(value: unknown): L4MemoryFinding[] {
  return toArray(value)
    .map((item, index) => {
      if (typeof item === 'string') {
        return {
          id: `finding-${index + 1}`,
          finding: item,
          evidence: '',
          importance: 5,
        };
      }
      const record = item && typeof item === 'object' ? (item as DistilledFindingLike) : {};
      return {
        id: `finding-${index + 1}`,
        finding: asString(record.finding),
        evidence: asString(record.evidence),
        importance:
          typeof record.importance === 'number' ? Math.min(10, Math.max(1, record.importance)) : 5,
      };
    })
    .filter((finding) => finding.finding)
    .slice(0, MAX_FINDINGS);
}

function extractPathAndLine(text: string): { path: string; line?: number } | null {
  const match = text.match(/([A-Za-z0-9_./@-]+\.[A-Za-z0-9]+)(?::(?:L)?(\d+))?/);
  if (!match?.[1]) {
    return null;
  }
  return {
    path: match[1],
    ...(match[2] ? { line: Number.parseInt(match[2], 10) } : {}),
  };
}

function pushUniqueEvidence(refs: L4EvidenceRef[], ref: L4EvidenceRef | null | undefined): void {
  if (!ref?.path) {
    return;
  }
  const key = `${ref.path}:${ref.line ?? ''}`;
  if (!refs.some((existing) => `${existing.path}:${existing.line ?? ''}` === key)) {
    refs.push(ref);
  }
}

function evidenceFromFindings(findings: L4MemoryFinding[]): L4EvidenceRef[] {
  const refs: L4EvidenceRef[] = [];
  for (const finding of findings) {
    const extracted = extractPathAndLine(finding.evidence);
    if (extracted) {
      pushUniqueEvidence(refs, {
        ...extracted,
        summary: truncate(finding.finding, 160),
        source: 'finding',
      });
    }
  }
  return refs;
}

function evidenceFromMap(
  evidence: EvidenceCollectorResultLike | null | undefined
): L4EvidenceRef[] {
  const refs: L4EvidenceRef[] = [];
  const map = evidence?.evidenceMap;
  if (!map) {
    return refs;
  }

  const entries =
    map instanceof Map
      ? [...map.entries()]
      : Object.entries(map as Record<string, EvidenceMapEntryLike>);
  for (const [key, value] of entries) {
    const filePath = asString(value?.filePath || key);
    const snippets = toArray(value?.codeSnippets);
    const firstSnippet = snippets[0] as UnknownRecord | undefined;
    pushUniqueEvidence(refs, {
      path: filePath,
      ...(typeof firstSnippet?.startLine === 'number' ? { line: firstSnippet.startLine } : {}),
      summary: truncate(asString(value?.summary || value?.role), 180),
      source: 'evidence-map',
    });
  }
  return refs;
}

function evidenceFromToolCalls(toolCalls: readonly ToolCallLike[] = []): L4EvidenceRef[] {
  const refs: L4EvidenceRef[] = [];
  for (const call of toolCalls) {
    const observation = readToolObservation(call);
    if (!observation.ok) {
      continue;
    }
    const args = observation.params;
    const result = observation.result;
    const files =
      observation.tool === 'code' && observation.action === 'read'
        ? successfulReadPaths(call)
        : [asString(args.path || args.filePath || result.path || result.filePath)];
    for (const filePath of files) {
      if (!filePath) {
        continue;
      }
      pushUniqueEvidence(refs, {
        path: filePath,
        ...(typeof args.startLine === 'number' ? { line: args.startLine } : {}),
        summary: `${observation.tool} ${safeJson(args, 180)}`,
        source: 'tool-call',
      });
    }
  }
  return refs;
}

function normalizeToolSummary(distilled: DistilledContextLike, input: L4MemoryPackageInput) {
  const distilledSummaries = toArray(distilled.toolCallSummary)
    .map((item) => asString(item))
    .filter(Boolean);
  const explorationSummaries: string[] = [];
  for (const item of toArray(input.evidence?.explorationLog)) {
    const record = item && typeof item === 'object' ? (item as UnknownRecord) : {};
    const tool = asString(record.tool, 'tool');
    const result = asString(record.resultSummary || record.intent);
    if (result) {
      explorationSummaries.push(`[${tool}] ${result}`);
    }
  }
  const receipts: Array<{ ok: boolean; line: string }> = [];
  for (const call of input.toolCalls || []) {
    const observation = readToolObservation(call);
    const envelope =
      call.envelope && typeof call.envelope === 'object' ? (call.envelope as UnknownRecord) : {};
    const body =
      envelope.text ?? (typeof call.result === 'string' ? call.result : observation.result);
    receipts.push({
      ok: observation.ok,
      line: `[${observation.tool || 'tool'}${observation.ok ? '' : ' failed'}] ${safeJson(body, 220)}`,
    });
  }

  if (distilledSummaries.length === 0) {
    // 没有蒸馏摘要（未传 activeContext、distill 失败或尚无观察）：原始回执是唯一的工具来源，
    // 按调用顺序保留最近的条目；distill 失败本身已记入 failureState。
    return [...explorationSummaries, ...receipts.map((receipt) => receipt.line)]
      .filter(Boolean)
      .slice(-MAX_TOOL_SUMMARIES);
  }

  // 有蒸馏摘要：它与 toolCalls 覆盖同一批调用（生产 provider 同时传 ctx.trace 与 ctx.toolCalls），
  // 成功回执的原始 body 只是重复，还会把整理过的全程摘要挤出最近 12 条窗口。
  // 因此只追加失败回执（蒸馏摘要可能不保留失败原因），并按固定配额组合：
  // 失败回执至多 MAX_FAILED_RECEIPTS_WITH_DISTILLED 条，其余槽位给蒸馏摘要与探索日志。
  const failedReceipts = receipts
    .filter((receipt) => !receipt.ok)
    .map((receipt) => receipt.line)
    .slice(-MAX_FAILED_RECEIPTS_WITH_DISTILLED);
  const primary = [...distilledSummaries, ...explorationSummaries].slice(
    -(MAX_TOOL_SUMMARIES - failedReceipts.length)
  );
  return [...primary, ...failedReceipts];
}

function normalizePlan(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') {
    return [];
  }
  const record = plan as UnknownRecord;
  const lines: string[] = [];
  const text = asString(record.text);
  if (text) {
    lines.push(truncate(text, 240));
  }
  for (const step of toArray(record.steps).slice(0, 8)) {
    const s = step && typeof step === 'object' ? (step as UnknownRecord) : {};
    const description = asString(s.description);
    const status = asString(s.status);
    if (description) {
      lines.push(`${status ? `[${status}] ` : ''}${description}`);
    }
  }
  return lines;
}

function serializeRecentMessages(messages: readonly L4MessageLike[] = []): string[] {
  return messages
    .map((message) => {
      const role = asString(message.role, 'message');
      if (role === 'tool') {
        const name = asString(message.name, 'tool');
        const id = asString(message.toolCallId ?? message.tool_call_id);
        return `[tool-result-as-text ${name}${id ? `/${id}` : ''}] ${truncate(asString(message.content), 500)}`;
      }
      const calls = toArray(message.toolCalls ?? message.tool_calls);
      const callText =
        calls.length > 0
          ? ` tool_calls=${calls
              .map((call) => asString((call as UnknownRecord).name || (call as UnknownRecord).id))
              .filter(Boolean)
              .join(',')}`
          : '';
      return `[${role}${callText}] ${truncate(asString(message.content), 500)}`;
    })
    .filter(Boolean)
    .slice(-MAX_RECENT_MESSAGES);
}

function normalizeFailureState(input: L4MemoryPackageInput, distillFailure?: string): string[] {
  // distill 失败排在最前：它意味着发现、计划和统计全部缺失，是摘要最需要保留的降级事实，
  // 也保证它落在 validateL4Summary 检查的前 4 条失败状态里。
  const states = [
    ...(distillFailure ? [distillFailure] : []),
    ...(input.failureState || []).map((item) => asString(item)).filter(Boolean),
  ];
  const diagnostics = input.diagnostics;
  const cancelReason = asString(diagnostics?.efficiency?.cancelReason);
  if (cancelReason) {
    states.push(`cancelReason=${cancelReason}`);
  }
  for (const stage of toArray(diagnostics?.timedOutStages)) {
    states.push(`timedOutStage=${asString(stage)}`);
  }
  for (const gate of toArray(diagnostics?.gateFailures)) {
    const record = gate && typeof gate === 'object' ? (gate as UnknownRecord) : {};
    states.push(
      `gateFailure=${asString(record.stage, 'stage')}:${asString(record.action, 'action')}${
        record.reason ? `:${asString(record.reason)}` : ''
      }`
    );
  }
  if (diagnostics?.degraded) {
    states.push('degraded=true');
  }
  return [...new Set(states)].slice(0, 12);
}

function normalizeStats(distilled: DistilledContextLike) {
  return {
    totalObservations:
      typeof distilled.totalObservations === 'number' ? distilled.totalObservations : 0,
    compressedCount: typeof distilled.compressedCount === 'number' ? distilled.compressedCount : 0,
  };
}

function normalizeUnresolvedQuestions(value: readonly unknown[] | undefined): string[] {
  // 保留调用方给出的顺序（视为优先级），去重后取前 MAX_UNRESOLVED_QUESTIONS 条。
  const questions = (value || [])
    .map((item) => truncate(asString(item), MAX_UNRESOLVED_QUESTION_CHARS))
    .filter(Boolean);
  return [...new Set(questions)].slice(0, MAX_UNRESOLVED_QUESTIONS);
}

/** 预构建的包可能来自未经 buildL4MemoryPackage 的 JS 调用方；缺字段时按空列表处理，不让渲染抛错。 */
function unresolvedQuestionsOf(pkg: L4MemoryPackage): string[] {
  return Array.isArray(pkg.unresolvedQuestions) ? pkg.unresolvedQuestions : [];
}

export function buildL4MemoryPackage(input: L4MemoryPackageInput = {}): L4MemoryPackage {
  const { distilled, failure: distillFailure } = readDistilled(input);
  const findings = normalizeFindings(distilled.keyFindings);
  const evidenceRefs: L4EvidenceRef[] = [];
  for (const ref of evidenceFromFindings(findings)) {
    pushUniqueEvidence(evidenceRefs, ref);
  }
  for (const ref of evidenceFromMap(input.evidence)) {
    pushUniqueEvidence(evidenceRefs, ref);
  }
  for (const ref of evidenceFromToolCalls(input.toolCalls)) {
    pushUniqueEvidence(evidenceRefs, ref);
  }

  return {
    kind: 'l4_memory_package',
    version: 1,
    goal: asString(input.goal, 'unknown'),
    phase: asString(input.phase, 'unknown'),
    stageStatus: asString(input.stageStatus, 'running'),
    keyFindings: findings,
    evidenceRefs: evidenceRefs.slice(0, MAX_EVIDENCE_REFS),
    toolResultSummary: normalizeToolSummary(distilled, input),
    unresolvedQuestions: normalizeUnresolvedQuestions(input.unresolvedQuestions),
    recentConversation: serializeRecentMessages(input.recentMessages),
    failureState: normalizeFailureState(input, distillFailure),
    stats: normalizeStats(distilled),
    plan: normalizePlan(distilled.plan),
  };
}

export function renderL4MemoryPackage(pkg: L4MemoryPackage): string {
  const sections = [
    '# L4 Memory Package v1',
    `goal: ${pkg.goal}`,
    `phase: ${pkg.phase}`,
    `stageStatus: ${pkg.stageStatus}`,
    '',
    '## Key Findings',
    pkg.keyFindings.length > 0
      ? pkg.keyFindings
          .map(
            (finding) =>
              `- ${finding.id} [${finding.importance}/10] ${finding.finding}${
                finding.evidence ? ` (${finding.evidence})` : ''
              }`
          )
          .join('\n')
      : '- none',
    '',
    '## Evidence Refs',
    pkg.evidenceRefs.length > 0
      ? pkg.evidenceRefs
          .map(
            (ref) =>
              `- ${ref.path}${ref.line ? `:${ref.line}` : ''} [${ref.source}]${
                ref.summary ? ` ${ref.summary}` : ''
              }`
          )
          .join('\n')
      : '- none',
    '',
    '## Tool Result Summary',
    pkg.toolResultSummary.length > 0
      ? pkg.toolResultSummary.map((item) => `- ${item}`).join('\n')
      : '- none',
    '',
    '## Plan / Phase State',
    pkg.plan.length > 0 ? pkg.plan.map((item) => `- ${item}`).join('\n') : '- none',
    '',
    '## Recent Conversation',
    pkg.recentConversation.length > 0
      ? pkg.recentConversation.map((item) => `- ${item}`).join('\n')
      : '- none',
    '',
    // 未决问题必须进入摘要输入：L4 成功后历史被整体替换，不在这里出现的问题会被静默丢弃。
    '## Unresolved Questions',
    unresolvedQuestionsOf(pkg).length > 0
      ? unresolvedQuestionsOf(pkg)
          .map((item) => `- ${item}`)
          .join('\n')
      : '- none',
    '',
    '## Failure / Degraded State',
    pkg.failureState.length > 0 ? pkg.failureState.map((item) => `- ${item}`).join('\n') : '- none',
    '',
    `stats: totalObservations=${pkg.stats.totalObservations}, compressedCount=${pkg.stats.compressedCount}`,
  ];
  return sections.join('\n');
}

function hasAnyText(summary: string, values: string[]) {
  const lower = summary.toLowerCase();
  return values.some((value) => value && lower.includes(value.toLowerCase()));
}

/** 发现里的英文/数字 token：过滤长度不足与停用词，避免 this/should/true 这类词让笼统摘要通过。 */
function latinFindingTokens(text: string): string[] {
  return (text.match(LATIN_TOKEN_RE) ?? [])
    .filter(
      (token) =>
        token.length >= MIN_LATIN_TOKEN_LENGTH && !ENGLISH_STOP_WORDS.has(token.toLowerCase())
    )
    .slice(0, MAX_LATIN_TOKENS);
}

/**
 * 中文发现的覆盖判定。旧实现把整段连续汉字当作一个 token，要求摘要逐字保留整句，
 * 而摘要提示要求用中文改写，忠实的改写因此被误拒（误拒累积会推高 BudgetController 的 L4 失败计数）。
 * 现在按字符窗口判断：任一 4 字窗口原样出现即覆盖；否则命中的不同二元组需达到
 * 总数的 CJK_BIGRAM_COVERAGE_RATIO 且至少 CJK_MIN_BIGRAM_HITS 个（二元组不足时按实际数量）。
 */
function cjkFindingCovered(text: string, summary: string): boolean {
  const bigrams = new Set<string>();
  for (const run of text.match(CJK_RUN_RE) ?? []) {
    const chars = [...run];
    for (let index = 0; index + CJK_EXACT_WINDOW <= chars.length; index++) {
      if (summary.includes(chars.slice(index, index + CJK_EXACT_WINDOW).join(''))) {
        return true;
      }
    }
    for (let index = 0; index + 1 < chars.length; index++) {
      bigrams.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  if (bigrams.size === 0) {
    return false;
  }
  let hits = 0;
  for (const bigram of bigrams) {
    if (summary.includes(bigram)) {
      hits++;
    }
  }
  const requiredHits = Math.max(
    Math.min(CJK_MIN_BIGRAM_HITS, bigrams.size),
    Math.ceil(bigrams.size * CJK_BIGRAM_COVERAGE_RATIO)
  );
  return hits >= requiredHits;
}

function findingCovered(summary: string, finding: L4MemoryFinding): boolean {
  return (
    hasAnyText(summary, [finding.id, ...latinFindingTokens(finding.finding)]) ||
    cjkFindingCovered(finding.finding, summary)
  );
}

function isTrivialFailureNeedle(needle: string): boolean {
  const lower = needle.trim().toLowerCase();
  if (!lower || TRIVIAL_FAILURE_NEEDLES.has(lower) || /^\d+$/.test(lower)) {
    return true;
  }
  // 不含汉字的 1-2 字符末段（如 "ok"、"x"）同样无法证明摘要保留了失败状态。
  return !CJK_CHAR_RE.test(lower) && lower.length < 3;
}

/**
 * 单条失败状态可接受的证据：整行原文、键（如 degraded/timedOutStage）、非平凡的值或末段，
 * 以及键对应的中文同义词（如“降级”“超时”）。布尔、空值、纯数字末段不再算数，
 * 否则 'degraded=true' 会被任何含 "true" 的摘要满足。所有候选都平凡时退回整行原文，
 * 保证这条失败状态仍然必须被摘要提及。
 */
function failureStateNeedles(state: string): string[] {
  const separator = state.indexOf('=');
  const key = separator > 0 ? state.slice(0, separator).trim() : '';
  const value = separator > 0 ? state.slice(separator + 1) : state;
  const lastSegment = value.split(':').at(-1) || '';
  const needles = [state, key, value, lastSegment, ...(FAILURE_KEY_SYNONYMS.get(key) ?? [])]
    .map((needle) => needle.trim())
    .filter((needle) => !isTrivialFailureNeedle(needle));
  return needles.length > 0 ? needles : [state];
}

export function validateL4Summary(
  summaryText: string | null | undefined,
  pkg: L4MemoryPackage
): L4SummaryValidationResult {
  const summary = asString(summaryText);
  const missing: string[] = [];
  if (!summary) {
    return { ok: false, missing: ['summary_text'] };
  }

  if (pkg.phase !== 'unknown' && !hasAnyText(summary, [pkg.phase])) {
    missing.push(`phase:${pkg.phase}`);
  }

  if (
    pkg.stageStatus !== 'unknown' &&
    pkg.stageStatus !== 'running' &&
    !hasAnyText(summary, [pkg.stageStatus])
  ) {
    missing.push(`stageStatus:${pkg.stageStatus}`);
  }

  if (pkg.keyFindings.length > 0) {
    const anyFindingCovered = pkg.keyFindings
      .slice(0, 3)
      .some((finding) => findingCovered(summary, finding));
    if (!anyFindingCovered) {
      missing.push('key_findings');
    }
  }

  if (pkg.evidenceRefs.length > 0) {
    const evidenceCovered = pkg.evidenceRefs
      .slice(0, 5)
      .some((ref) => hasAnyText(summary, [ref.path, path.basename(ref.path)]));
    if (!evidenceCovered) {
      missing.push('evidence_refs');
    }
  }

  const failureNeedles = pkg.failureState.slice(0, 4).flatMap(failureStateNeedles);
  if (pkg.failureState.length > 0 && !hasAnyText(summary, failureNeedles)) {
    missing.push('failure_state');
  }

  return { ok: missing.length === 0, missing };
}

export function formatL4MemorySummary(summaryText: string, pkg: L4MemoryPackage): string {
  const questions = unresolvedQuestionsOf(pkg);
  return [
    '[[L4 Memory Summary]]',
    'source: l4_memory_package/v1',
    `phase: ${pkg.phase}`,
    `stageStatus: ${pkg.stageStatus}`,
    pkg.evidenceRefs.length > 0
      ? `evidenceRefs: ${pkg.evidenceRefs
          .slice(0, 5)
          .map((ref) => `${ref.path}${ref.line ? `:${ref.line}` : ''}`)
          .join(', ')}`
      : 'evidenceRefs: none',
    // 未决问题由确定性头部原样带过 L4 替换，不依赖摘要模型是否复述，也不增加校验失败面；
    // 为空时不输出这一段，保持既有替换消息不变。
    ...(questions.length > 0
      ? ['unresolvedQuestions:', ...questions.map((question) => `- ${question}`)]
      : []),
    '',
    summaryText.trim(),
  ].join('\n');
}
