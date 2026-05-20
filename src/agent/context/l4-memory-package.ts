/**
 * L4 memory package builder.
 *
 * L4 compaction should summarize a structured runtime memory package, not a
 * raw Chat Completions transcript. Raw messages may be used only after they are
 * projected into plain text fields.
 */

import path from 'node:path';

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
const MAX_EVIDENCE_REFS = 12;
const MAX_FINDINGS = 8;

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

function readDistilled(input: L4MemoryPackageInput): DistilledContextLike {
  if (input.distilledContext) {
    return input.distilledContext;
  }
  try {
    return input.activeContext?.distill?.() || {};
  } catch {
    return {};
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
    const args =
      call.args && typeof call.args === 'object'
        ? (call.args as UnknownRecord)
        : call.params && typeof call.params === 'object'
          ? (call.params as UnknownRecord)
          : {};
    const result =
      call.result && typeof call.result === 'object' ? (call.result as UnknownRecord) : {};
    const filePath = asString(
      args.path ||
        args.filePath ||
        result.path ||
        result.filePath ||
        (Array.isArray(result.files) && (result.files[0] as UnknownRecord | undefined)?.path)
    );
    if (filePath) {
      pushUniqueEvidence(refs, {
        path: filePath,
        ...(typeof args.startLine === 'number' ? { line: args.startLine } : {}),
        summary: `${asString(call.tool || call.name, 'tool')} ${safeJson(args, 180)}`,
        source: 'tool-call',
      });
    }
  }
  return refs;
}

function normalizeToolSummary(distilled: DistilledContextLike, input: L4MemoryPackageInput) {
  const summaries = toArray(distilled.toolCallSummary).map((item) => asString(item));
  for (const item of toArray(input.evidence?.explorationLog)) {
    const record = item && typeof item === 'object' ? (item as UnknownRecord) : {};
    const tool = asString(record.tool, 'tool');
    const result = asString(record.resultSummary || record.intent);
    if (result) {
      summaries.push(`[${tool}] ${result}`);
    }
  }
  for (const call of input.toolCalls || []) {
    const tool = asString(call.tool || call.name, 'tool');
    summaries.push(`[${tool}] ${safeJson(call.result ?? call.args ?? call.params, 220)}`);
  }
  return summaries.filter(Boolean).slice(-MAX_TOOL_SUMMARIES);
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

function normalizeFailureState(input: L4MemoryPackageInput): string[] {
  const states = [...(input.failureState || []).map((item) => asString(item)).filter(Boolean)];
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

export function buildL4MemoryPackage(input: L4MemoryPackageInput = {}): L4MemoryPackage {
  const distilled = readDistilled(input);
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
    unresolvedQuestions: (input.unresolvedQuestions || [])
      .map((item) => asString(item))
      .filter(Boolean),
    recentConversation: serializeRecentMessages(input.recentMessages),
    failureState: normalizeFailureState(input),
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

function findingTokens(finding: L4MemoryFinding): string[] {
  return finding.finding
    .split(/[^A-Za-z0-9_\u4e00-\u9fff]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .slice(0, 4);
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
    const findingCovered = pkg.keyFindings
      .slice(0, 3)
      .some((finding) => hasAnyText(summary, [finding.id, ...findingTokens(finding)]));
    if (!findingCovered) {
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

  const failureNeedles = pkg.failureState
    .slice(0, 4)
    .flatMap((state) => [state, state.split('=').at(-1) || '', state.split(':').at(-1) || ''])
    .filter(Boolean);
  if (pkg.failureState.length > 0 && !hasAnyText(summary, failureNeedles)) {
    missing.push('failure_state');
  }

  return { ok: missing.length === 0, missing };
}

export function formatL4MemorySummary(summaryText: string, pkg: L4MemoryPackage): string {
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
    '',
    summaryText.trim(),
  ].join('\n');
}
