/**
 * 证据采集（Wave A E2）——工具结果收口处的台账写入与标注。
 *
 * 只认证据类工具（Core 契约 EVIDENCE_TOOL_IDS；memory/meta/knowledge 不落账）。
 * normalize 优先取结构化数据（read: files[{path,content}]；search: matches[{file,line,content}]），
 * 结构缺席时回退 envelope 文本——那仍是模型所见的 verbatim，不发明内容。
 * 标注格式 `[evidence] E-1=lib/a.ts:10-14; E-2=package.json` 追加于模型可见文本尾部，
 * 模型从第一眼即以条目 ID 认知证据（E3 的 evidenceRefs 引用契约由此闭环）。
 */
import {
  type EvidenceEntry,
  type EvidenceRange,
  type EvidenceToolId,
  isEvidenceToolId,
} from '@alembic/core/knowledge';
import type { EvidenceEntryDraft, EvidenceLedgerStore } from './EvidenceLedgerStore.js';

/** 管道 ToolCall 的采集视图（name 是工具族名如 'code'，action 在 args 里） */
export interface EvidenceCaptureCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** envelope 的采集视图（模型可见文本 + 可选结构化结果） */
export interface EvidenceCaptureEnvelope {
  ok: boolean;
  text: string;
  structuredContent?: unknown;
}

/** 工具族名+args.action 合成证据工具 id；非证据类返回 null（不落账） */
export function resolveEvidenceAction(call: EvidenceCaptureCall): EvidenceToolId | null {
  const action = typeof call.args?.action === 'string' ? call.args.action : '';
  const composite = `${call.name}.${action}`;
  return isEvidenceToolId(composite) ? composite : null;
}

function firstFiniteInt(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** read 调用的请求区间（startLine/endLine 或 start/end）；无合法区间返回 undefined */
function extractRequestedRange(args: Record<string, unknown>): EvidenceRange | undefined {
  const start = firstFiniteInt(args.startLine, args.start);
  const end = firstFiniteInt(args.endLine, args.end);
  if (start !== null && end !== null && start >= 1 && end >= start) {
    return { start, end };
  }
  return undefined;
}

interface FileItem {
  path: string;
  content: string;
  mode?: string;
  startLine?: number;
  endLine?: number;
  lineCount?: number;
}

function asFileList(value: unknown): FileItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const files: FileItem[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as FileItem).path === 'string' &&
      typeof (item as FileItem).content === 'string'
    ) {
      files.push(item as FileItem);
    }
  }
  return files;
}

/**
 * read 工具 content 是模型显示形态（`N|` 行号前缀，range 模式还带 '... [omitted]' 尾行）。
 * 台账存 verbatim 原文——freshness 重切用原文切片比哈希，存显示形态会天生 stale
 * （run-13 EVIDENCE_STALE ×11 事故根因）。仅当每个非空行都带前缀才剥（防误伤原文里的竖线）。
 */
function stripReadDisplayDecorations(content: string): string | null {
  const lines = content.split('\n');
  const body =
    lines.length > 0 && /^\.\.\. \[\d+ lines omitted/.test(lines[lines.length - 1] ?? '')
      ? lines.slice(0, -1)
      : lines;
  if (body.length === 0) {
    return null;
  }
  const stripped: string[] = [];
  for (const line of body) {
    const m = /^(\d+)\|(.*)$/.exec(line);
    if (!m) {
      return null;
    }
    stripped.push(m[2]);
  }
  return stripped.join('\n');
}

interface MatchItem {
  file: string;
  line: number;
  content: string;
}

function asMatchList(value: unknown): MatchItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const matches: MatchItem[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as MatchItem).file === 'string' &&
      typeof (item as MatchItem).line === 'number' &&
      typeof (item as MatchItem).content === 'string'
    ) {
      matches.push(item as MatchItem);
    }
  }
  return matches;
}

/**
 * 把一次成功的证据类工具返回归一化为台账草稿：
 * - code.read：每文件一条，range 取请求区间（content 行号语义与之对齐）；
 * - code.search：按文件分组每组一条，行号内嵌 `<line>: <content>` 自描述——命中非连续，
 *   刻意不设 range（range 语义是连续区间，误设会让子区间切片错位）；
 * - 其它证据工具（outline/structure/graph/terminal）：单条，结构化结果确定性序列化，
 *   结构缺席回退模型可见文本。
 */
function normalizeDrafts(
  tool: EvidenceToolId,
  call: EvidenceCaptureCall,
  envelope: EvidenceCaptureEnvelope
): EvidenceEntryDraft[] {
  const data =
    envelope.structuredContent && typeof envelope.structuredContent === 'object'
      ? (envelope.structuredContent as Record<string, unknown>)
      : undefined;

  if (tool === 'code.read') {
    const files = asFileList(data?.files);
    if (files.length > 0) {
      const requestedRange = extractRequestedRange(call.args);
      return files.map((file) => {
        // run-13 EVIDENCE_STALE 事故根修：台账存 verbatim 原文（剥 `N|` 显示前缀与 omitted
        // 尾行），range 取工具项自带坐标（range 模式 startLine/endLine；full 模式 1..lineCount）
        // ——freshness 原文重切与存储哈希由此同尺。outline/delta/unchanged 是派生视图非切片，
        // 诚实降级 file-only（不参与 freshness，verified 判据按 file 在场已放行）。
        const raw = stripReadDisplayDecorations(file.content);
        const mode = file.mode ?? '';
        if (raw !== null && (mode === 'range' || mode === 'full' || mode === '')) {
          const range =
            mode === 'range' && file.startLine && file.endLine
              ? { start: file.startLine, end: file.endLine }
              : mode === 'full' && file.lineCount
                ? { start: 1, end: file.lineCount }
                : (requestedRange ?? { start: 1, end: raw.split('\n').length });
          return { tool, callId: call.id, file: file.path, range, content: raw };
        }
        return {
          tool,
          callId: call.id,
          file: file.path,
          ...(requestedRange ? { range: requestedRange } : {}),
          content: file.content,
        };
      });
    }
    // P1-A F3：单 path read 返回纯文本(无 structuredContent.files)——此前落入通用兜底，
    // 而兜底只查 call.args.path(真实调用形态是 args.params.path)→ 落成无 file 条目 →
    // note_finding 判 unverified、不计配额,产出被无声折价。这里按批量同规格处理：
    // 剥显示前缀存 verbatim(freshness 同尺)、file 取请求 path、range 取请求区间或全文行数。
    const singleParams = (call.args?.params ?? call.args) as Record<string, unknown> | undefined;
    const singlePath = typeof singleParams?.path === 'string' ? singleParams.path : undefined;
    if (singlePath) {
      const requestedRange = extractRequestedRange(call.args);
      const textContent = typeof envelope.text === 'string' ? envelope.text : '';
      // 尾随换行会产生空末行、让全行 N| 校验失败——剥掉再判(不影响 verbatim 语义)。
      const raw = textContent ? stripReadDisplayDecorations(textContent.replace(/\n+$/, '')) : null;
      if (raw !== null && raw.length > 0) {
        const range = requestedRange ?? { start: 1, end: raw.split('\n').length };
        return [{ tool, callId: call.id, file: singlePath, range, content: raw }];
      }
      if (textContent) {
        // outline/delta 等派生视图：诚实降级 file-only(不参与 freshness，verified 按 file 在场放行)。
        return [
          {
            tool,
            callId: call.id,
            file: singlePath,
            ...(requestedRange ? { range: requestedRange } : {}),
            content: textContent,
          },
        ];
      }
    }
  }

  if (tool === 'code.search') {
    const matches = asMatchList(data?.matches);
    if (matches.length > 0) {
      const byFile = new Map<string, MatchItem[]>();
      for (const match of matches) {
        const bucket = byFile.get(match.file) ?? [];
        bucket.push(match);
        byFile.set(match.file, bucket);
      }
      return [...byFile.entries()].map(([file, group]) => ({
        tool,
        callId: call.id,
        file,
        content: group.map((m) => `${m.line}: ${m.content}`).join('\n'),
      }));
    }
  }

  // P1-A F3 附带修：运行时调用形态是 args.params.{path,file}(kernel parseToolCall 规格)，
  // 兜底此前只查 args 顶层——嵌套形态全部落空。params 优先，顶层作兼容保留。
  const fallbackParams = (call.args?.params ?? null) as Record<string, unknown> | null;
  let file =
    typeof fallbackParams?.path === 'string'
      ? fallbackParams.path
      : typeof fallbackParams?.file === 'string'
        ? fallbackParams.file
        : typeof call.args?.path === 'string'
          ? call.args.path
          : typeof call.args?.file === 'string'
            ? call.args.file
            : undefined;
  // M2/P1c：terminal.exec 归属——命令 argv 里首个"看起来是仓内相对路径"的 token 作为 file
  // （cat/head/sed/ls 目标）。只做词法判定不触磁盘（capture 在热路径）；错误归属由提交侧
  // fs 校验兜底。绝对路径/URL/选项不取。
  // 同 F3：command 也补 params 嵌套形态(运行时 terminal.exec 的 command 在 args.params 下)。
  const commandRaw =
    typeof fallbackParams?.command === 'string'
      ? fallbackParams.command
      : typeof call.args?.command === 'string'
        ? call.args.command
        : undefined;
  if (!file && commandRaw) {
    for (const token of commandRaw.split(/\s+/).slice(1)) {
      if (
        /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]+$/.test(token) &&
        !token.startsWith('/') &&
        !token.includes('://')
      ) {
        file = token;
        break;
      }
    }
  }
  const content =
    envelope.text ||
    (envelope.structuredContent !== undefined
      ? JSON.stringify(data ?? envelope.structuredContent)
      : '');
  if (!content) {
    return [];
  }
  return [{ tool, callId: call.id, ...(file ? { file } : {}), content }];
}

/** 采集入口：非证据工具/失败返回→空数组（零行为）；成功→逐条落账并返回条目 */
export function captureEvidenceFromEnvelope(
  ledger: EvidenceLedgerStore,
  call: EvidenceCaptureCall,
  envelope: EvidenceCaptureEnvelope
): EvidenceEntry[] {
  if (!envelope.ok) {
    return [];
  }
  const tool = resolveEvidenceAction(call);
  if (!tool) {
    return [];
  }
  return normalizeDrafts(tool, call, envelope).map((draft) => ledger.append(draft));
}

/** 模型可见标注：`[evidence] E-1=lib/a.ts:10-14; E-2=package.json`，追加于文本尾 */
export function appendEvidenceAnnotation(text: string, entries: EvidenceEntry[]): string {
  if (entries.length === 0) {
    return text;
  }
  const labels = entries.map((entry) => {
    if (!entry.file) {
      return entry.id;
    }
    return entry.range
      ? `${entry.id}=${entry.file}:${entry.range.start}-${entry.range.end}`
      : `${entry.id}=${entry.file}`;
  });
  const annotation = `[evidence] ${labels.join('; ')}`;
  return text ? `${text}\n\n${annotation}` : annotation;
}
