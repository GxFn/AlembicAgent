/**
 * 证据台账存储 — session 级 JSONL，append-only（Wave A E1）。
 *
 * 职责：把证据类工具返回落成可寻址条目（E2 在工具结果收口处调 append），并向
 * note_finding 录入校验（E3）、evidence.get/search 工具（E4）、producer 机械展开（E5）
 * 提供只读查询。文件本身就是可人工直接查看的非压缩临时证据文件：
 *   <dataRoot>/.asd/evidence-ledger/<jobId>/<dimensionId>.jsonl
 *
 * 纪律：
 * - append-only + 确定性序列化（顶层 key 排序、单行 JSON）——可重放、可审计、可字节比对；
 * - 落盘前经 redactor 脱敏（与 LLM 工件同一把尺，生产接线注入 utils/Redaction）；
 * - 单条 content 超 EVIDENCE_ENTRY_MAX_CHARS 保头截断并附显式标记；contentHash 按
 *   「落盘后内容」计算——E5 新鲜度终检重切同范围、同截断策略后比对，保证同一把尺；
 * - 构造时文件已存在则回读（run 中断重建/断点续跑场景），不合法行整条丢弃（宽进严出），
 *   seq 续接最大序号不重号。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EVIDENCE_ENTRY_MAX_CHARS,
  type EvidenceEntry,
  type EvidenceRange,
  type EvidenceToolId,
  isValidEvidenceEntry,
  makeEvidenceId,
  parseEvidenceRef,
} from '@alembic/core/knowledge';

export interface EvidenceLedgerStoreOptions {
  dataRoot: string;
  jobId: string;
  sessionId: string;
  dimensionId: string;
  /** 落盘前脱敏；缺省恒等（生产接线必须注入 redactDeveloperText） */
  redactor?: (text: string) => string;
}

export interface EvidenceEntryDraft {
  tool: EvidenceToolId;
  callId: string;
  file?: string;
  range?: EvidenceRange;
  content: string;
}

export const EVIDENCE_TRUNCATION_MARKER = '…[evidence truncated at entry cap]';

/** 域标签内容哈希——条目完整性与 E5 新鲜度终检共用一把尺 */
export function hashEvidenceContent(content: string): string {
  return createHash('sha256').update(`evidence-ledger:v1:${content}`).digest('hex');
}

/** 确定性序列化：顶层 key 字母序 + 单行——保证 JSONL 可重放与字节级比对 */
function stableStringifyEntry(entry: EvidenceEntry): string {
  const ordered: Record<string, unknown> = {};
  const source = entry as unknown as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) {
      ordered[key] = source[key];
    }
  }
  return JSON.stringify(ordered);
}

/**
 * 子区间切片：条目带 range 时请求区间按「文件绝对行号」判定并切片；
 * 条目无 range（search 分组/terminal 等）时按 content 内 1-indexed 行号切片。
 * 越界返回 null（不静默钳制——引用越界本身是需要暴露的信号）。
 */
function sliceEntry(entry: EvidenceEntry, requested: EvidenceRange): EvidenceEntry | null {
  const lines = entry.content.split('\n');
  let startIdx: number;
  let endIdx: number;
  if (entry.range) {
    if (requested.start < entry.range.start || requested.end > entry.range.end) {
      return null;
    }
    startIdx = requested.start - entry.range.start;
    endIdx = requested.end - entry.range.start;
  } else {
    if (requested.start < 1 || requested.end > lines.length) {
      return null;
    }
    startIdx = requested.start - 1;
    endIdx = requested.end - 1;
  }
  if (startIdx >= lines.length) {
    // 条目内容被截断上限裁短时，尾部行不可达——按不可解析处理
    return null;
  }
  const content = lines.slice(startIdx, Math.min(endIdx, lines.length - 1) + 1).join('\n');
  return { ...entry, range: requested, content, contentHash: hashEvidenceContent(content) };
}

export class EvidenceLedgerStore {
  readonly filePath: string;
  readonly #sessionId: string;
  readonly #dimensionId: string;
  readonly #redactor: (text: string) => string;
  readonly #entries = new Map<string, EvidenceEntry>();
  #seq = 0;
  #dirReady = false;

  constructor(options: EvidenceLedgerStoreOptions) {
    this.#sessionId = options.sessionId;
    this.#dimensionId = options.dimensionId;
    this.#redactor = options.redactor ?? ((text) => text);
    this.filePath = join(
      options.dataRoot,
      '.asd',
      'evidence-ledger',
      options.jobId,
      `${options.dimensionId}.jsonl`
    );
    this.#hydrate();
  }

  /** 采集侧唯一写入口（E2 在工具结果收口处调用）；返回带 id 的完整条目 */
  append(draft: EvidenceEntryDraft): EvidenceEntry {
    const capped = this.#redactAndCap(draft.content);
    const entry: EvidenceEntry = {
      id: makeEvidenceId(++this.#seq),
      sessionId: this.#sessionId,
      dimensionId: this.#dimensionId,
      tool: draft.tool,
      callId: draft.callId,
      ...(draft.file ? { file: draft.file } : {}),
      ...(draft.range ? { range: draft.range } : {}),
      content: capped,
      contentHash: hashEvidenceContent(capped),
      capturedAt: Date.now(),
    };
    this.#writeLine(entry);
    this.#entries.set(entry.id, entry);
    return entry;
  }

  /** 只读取回：接受 `E-12` 或 `E-12@5-20`；子区间返回派生副本（content 为切片） */
  get(ref: string): EvidenceEntry | null {
    const parsed = parseEvidenceRef(ref);
    if (!parsed) {
      return null;
    }
    const entry = this.#entries.get(parsed.id) ?? null;
    if (!entry || !parsed.range) {
      return entry;
    }
    return sliceEntry(entry, parsed.range);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /**
   * E5 新鲜度终检：对底层条目按「同区间重切 + 同截断 + 同脱敏」重算哈希与采集时比对。
   * 只有 file+range 条目可复核（read 类采集）；search 分组/terminal 等无法重构切片 →
   * 'unknown'（提交侧放行，最终仍由门禁的 fs verbatim 校验兜底）。区间越界（文件变短）
   * 直接 'stale'。
   */
  checkFreshness(ref: string, currentFileContent: string): 'fresh' | 'stale' | 'unknown' {
    const parsed = parseEvidenceRef(ref);
    if (!parsed) {
      return 'unknown';
    }
    const entry = this.#entries.get(parsed.id);
    if (!entry || !entry.file || !entry.range) {
      return 'unknown';
    }
    const lines = currentFileContent.split('\n');
    if (entry.range.end > lines.length) {
      return 'stale';
    }
    const slice = lines.slice(entry.range.start - 1, entry.range.end).join('\n');
    return hashEvidenceContent(this.#redactAndCap(slice)) === entry.contentHash ? 'fresh' : 'stale';
  }

  /** 落盘内容统一管线：脱敏→上限截断（append 与 checkFreshness 共用同一把尺） */
  #redactAndCap(content: string): string {
    const redacted = this.#redactor(content);
    return redacted.length > EVIDENCE_ENTRY_MAX_CHARS
      ? `${redacted.slice(0, EVIDENCE_ENTRY_MAX_CHARS - EVIDENCE_TRUNCATION_MARKER.length - 1)}\n${EVIDENCE_TRUNCATION_MARKER}`
      : redacted;
  }

  /** 按文件路径片段检索（E3 近似候选提示 / E5 producer 展开用），按采集序返回 */
  searchByFile(fragment: string, limit = 20): EvidenceEntry[] {
    const needle = fragment.toLowerCase();
    const hits: EvidenceEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.file?.toLowerCase().includes(needle)) {
        hits.push(entry);
        if (hits.length >= limit) {
          break;
        }
      }
    }
    return hits;
  }

  stats(): { entries: number; distinctFiles: number } {
    const files = new Set<string>();
    for (const entry of this.#entries.values()) {
      if (entry.file) {
        files.add(entry.file);
      }
    }
    return { entries: this.#entries.size, distinctFiles: files.size };
  }

  /** 近期条目（按采集序尾部）——note_finding 引用解析失败时的真实候选提示（E3） */
  listRecent(limit = 5): EvidenceEntry[] {
    const all = [...this.#entries.values()];
    return all.slice(Math.max(0, all.length - limit));
  }

  /** 台账内检索（E4 evidence.search）：路径片段或内容关键词，大小写不敏感，按采集序返回 */
  search(query: string, limit = 8): EvidenceEntry[] {
    const needle = query.toLowerCase();
    const hits: EvidenceEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (
        entry.file?.toLowerCase().includes(needle) ||
        entry.content.toLowerCase().includes(needle)
      ) {
        hits.push(entry);
        if (hits.length >= limit) {
          break;
        }
      }
    }
    return hits;
  }

  #hydrate(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isValidEvidenceEntry(parsed)) {
        continue;
      }
      this.#entries.set(parsed.id, parsed);
      const seq = Number(parsed.id.slice(2));
      if (Number.isFinite(seq) && seq > this.#seq) {
        this.#seq = seq;
      }
    }
    this.#dirReady = true;
  }

  #writeLine(entry: EvidenceEntry): void {
    if (!this.#dirReady) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.#dirReady = true;
    }
    appendFileSync(this.filePath, `${stableStringifyEntry(entry)}\n`, 'utf8');
  }
}
