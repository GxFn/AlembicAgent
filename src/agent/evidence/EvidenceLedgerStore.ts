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
 *   seq 续接最大序号不重号；contentHash 只认 canonical `sha256:<hex>`，历史 domain-separated
 *   裸 hex 与任意错哈希同样按 authority 污染丢弃（生产打开即 fail closed，不存在兼容保留）；
 * - 追加前若文件末字节不是换行（上次短写留下残行），先补一个换行再写，新条目自成一行，
 *   残行仍由 hydrate 记为 line-N:json 供 strict/生产闸门 fail closed。
 * - 进程内原文摘要（脱敏阶段 2 方案 C）：带 file+range 的条目在 append 时额外记录
 *   HMAC-SHA256(实例密钥, 原文切片)。密钥由 crypto.randomBytes 生成，只活在本实例内存，不落盘、
 *   不进模块级状态；checkFreshness 有摘要时按原文比对（消除脱敏造成的假 fresh 盲区，规则变化也
 *   不再让同一进程内的条目误判 stale），没有摘要（seed、跨进程续跑、其它实例写入）时退回脱敏哈希。
 * - 静态加固（D7）：台账目录 0700、文件 0600，evidence-ledger/ 下写内容为 `*` 的自忽略 .gitignore；
 *   打开已有旧台账时尝试把权限收紧到同一标准。加固失败只记 warn，不阻断读写。
 * - 内容 profile（脱敏阶段 3，L7-P11 方案 b）：缺省 redacted-evidence 即上面的全部现状；
 *   verbatim-witness 是宿主严格链的逐字节见证通道，落在独立根目录
 *   <dataRoot>/.asd/evidence-witness/<jobId>/<dimensionId>.jsonl（宿主以 runId 作 jobId），
 *   不调用 redactor、不截断，contentHash = sha256(原文)；写盘前经 witnessGate 判定
 *   （1 MiB 上限、UTF-8 往返、T1 子集闸门），不通过就抛错且不建目录、不写行、不消耗序号。
 *   见证根目录沿用同一套 0700/0600 与自忽略 .gitignore。两个 profile 的文件互不读取。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import {
  classifyEvidenceSource as classifyEvidenceSourceByTable,
  type EvidenceSourceClass,
} from './evidenceFileClass.js';
import {
  describeWitnessRejection,
  inspectWitnessContent,
  WITNESS_GATE_POLICY_ID,
  WITNESS_MAX_CONTENT_BYTES,
} from './witnessGate.js';

/**
 * 台账内容 profile。
 * - redacted-evidence（缺省）：循环证据与默认 capture 的现状——脱敏→8000 字符截断，
 *   落在 .asd/evidence-ledger/；
 * - verbatim-witness：宿主严格链的逐字节见证——不脱敏、不截断，落在 .asd/evidence-witness/，
 *   写盘前由 witnessGate 判定是否允许写入（只拒绝，不改写）。
 */
export type EvidenceLedgerContentProfile = 'redacted-evidence' | 'verbatim-witness';

/** 各 profile 在 <dataRoot>/.asd/ 下的根目录；见证与默认台账物理隔离，互不 hydrate。 */
const LEDGER_DIRECTORY_BY_PROFILE: Readonly<Record<EvidenceLedgerContentProfile, string>> =
  Object.freeze({
    'redacted-evidence': 'evidence-ledger',
    'verbatim-witness': 'evidence-witness',
  });

/**
 * 传给 redactor 的条目来源上下文（取自草稿或条目自身的可信元数据）。
 *
 * 阶段 2 只透传；阶段 4e 起默认 profile 的生产 redactor（ProductionEvidenceLedgerAuthority 注入的
 * redactLedgerContent → redactDeveloperTextInContext）据此按来源追加 T3：terminal、secret-bearing 有追加规则，
 * source、config、no-file 与缺省上下文等同未知来源（与 redactDeveloperText 逐字相同）。上下文只能让遮蔽更多，
 * 不能用来放行（不变量 A）。append、checkFreshness 的脱敏哈希重算与 describeContentTransformation 必须传
 * 同一份上下文，否则同一条目会按不同的尺计算。
 */
export interface EvidenceRedactionContext {
  readonly tool?: EvidenceToolId;
  readonly file?: string;
  readonly range?: EvidenceRange;
}

/** 单参的旧 redactor `(text) => string` 仍可直接赋值。 */
export type EvidenceRedactor = (text: string, context?: EvidenceRedactionContext) => string;

export interface EvidenceLedgerStoreOptions {
  dataRoot: string;
  jobId: string;
  sessionId: string;
  dimensionId: string;
  /**
   * 落盘前脱敏；缺省恒等（生产接线必须注入 redactDeveloperText）。
   * verbatim-witness profile 不允许注入：见证通道上任何字节变换都会让宿主逐字节比对失败。
   */
  redactor?: EvidenceRedactor;
  /** 内容 profile，缺省 redacted-evidence（现状）。 */
  contentProfile?: EvidenceLedgerContentProfile;
}

/**
 * append 的内部选项。刻意不放进 EvidenceEntryDraft：草稿经 capture facet 公开，
 * CAPTURE_ALLOWED_FIELDS 白名单会拒绝多余字段，Core EvidenceEntry 也不加字段。
 */
export interface EvidenceAppendOptions {
  /**
   * draft.content 是否就是文件原文切片（默认 true）。seed 复制的是兄弟台账已落盘的脱敏/截断内容，
   * 不是原文，必须传 false：否则原文摘要会记成“脱敏文本的摘要”，checkFreshness 会把未改动的
   * 文件永久判 stale。
   */
  readonly contentIsSourceSlice?: boolean;
}

/** checkFreshness 采用的比对依据，进入诊断日志。 */
type FreshnessBasis = 'source-digest' | 'redacted-hash';

/** 进程内原文摘要记录：绑定条目的落盘身份，条目被外部改写后摘要自动作废（退回脱敏哈希）。 */
interface SourceDigestRecord {
  readonly digest: string;
  readonly contentHash: string;
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

/** D7：台账目录与文件的目标权限（只收紧 group/other 位，不放宽）。 */
const LEDGER_DIRECTORY_MODE = 0o700;
const LEDGER_FILE_MODE = 0o600;
/** 自忽略 .gitignore：`*` 同时忽略目录内全部内容和它自己，应对 `.asd/` 未必被 gitignore 的项目。 */
const LEDGER_GITIGNORE_NAME = '.gitignore';
const LEDGER_GITIGNORE_CONTENT = '*\n';

export interface EvidenceEntryDraft {
  tool: EvidenceToolId;
  callId: string;
  file?: string;
  range?: EvidenceRange;
  content: string;
}

export const EVIDENCE_TRUNCATION_MARKER = '…[evidence truncated at entry cap]';

/**
 * 落盘管线对单条 content 的变换事实（脱敏 / 上限截断）。
 *
 * 只描述、不改变管线：production capture facet 用它向宿主发出“落盘内容不等于原文”的
 * warn 诊断；循环路径（EvidenceCapture 直接 append）把脱敏与截断视为设计内行为，用它发出
 * 限流的 info 诊断（条目 id、file、tool、长度与标记种类，不含正文）。
 */
export interface EvidenceContentTransformation {
  /** redactor 改写了内容（凭据形态字面量被替换） */
  readonly redacted: boolean;
  /** 脱敏后长度超过 EVIDENCE_ENTRY_MAX_CHARS，保头截断并附标记 */
  readonly truncated: boolean;
  readonly originalLength: number;
  readonly storedLength: number;
}

/**
 * EvidenceEntry 的 canonical 内容哈希。
 *
 * Core strict fact / semantic-review authority 对 EvidenceEntry 使用原始 UTF-8 bytes 的
 * `sha256:<hex>`；这里必须与它保持同一把尺，不能再使用历史 domain-separated 裸 hex，
 * 否则真实 ledger 条目无法进入冻结 snapshot / direct-witness authority。
 */
export function hashEvidenceContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** 确定性序列化：顶层 key 字母序 + 单行——保证 JSONL 可重放与字节级比对 */
function stableStringifyEntry(entry: EvidenceEntry): string {
  const ordered: Record<string, unknown> = {};
  const source: Record<string, unknown> = {
    ...entry,
    ...(entry.range ? { range: { start: entry.range.start, end: entry.range.end } } : {}),
  };
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
 *
 * 派生副本的 range 只在原条目带 range 时写入：EvidenceEntry.range 的契约是「文件行区间」，
 * 无 range 条目的请求区间只是条目内容的行号，写进 range 会被下游当成 file:start-end
 * 渲染成错误的源码引用。无 range 条目的切片保持无 range，由下游按内容里的真实行号展开。
 */
function sliceEntry(entry: EvidenceEntry, requested: EvidenceRange): EvidenceEntry | null {
  const lines = entry.content.split('\n');
  // cap 标记前最后一行可能只剩前半段；只有更早的完整行能声明精确子区间。
  const capturedLineCount = entry.content.endsWith(`\n${EVIDENCE_TRUNCATION_MARKER}`)
    ? Math.max(0, lines.length - 2)
    : lines.length;
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
  if (startIdx >= capturedLineCount || endIdx >= capturedLineCount) {
    // 条目内容被截断上限裁短时，尾部行不可达——按不可解析处理
    return null;
  }
  const content = lines.slice(startIdx, endIdx + 1).join('\n');
  return {
    ...entry,
    ...(entry.range ? { range: requested } : {}),
    content,
    contentHash: hashEvidenceContent(content),
  };
}

export class EvidenceLedgerStore {
  readonly filePath: string;
  readonly #ledgerRoot: string;
  readonly #sessionId: string;
  readonly #dimensionId: string;
  readonly #redactor: EvidenceRedactor;
  readonly #contentProfile: EvidenceLedgerContentProfile;
  readonly #entries = new Map<string, EvidenceEntry>();
  readonly #hydrateIntegrityIssues: string[] = [];
  /**
   * 原文摘要的 HMAC 密钥：实例状态，构造时随机生成，永不写盘、不出实例。随机密钥让摘要即使
   * 出现在内存转储里也无法离线比对猜测原文，也保证不同实例（不同进程）的摘要互不通用。
   */
  readonly #sourceDigestKey = randomBytes(32);
  /** 条目 id → 原文摘要；只记录本实例 append 的带 file+range 条目 */
  readonly #sourceDigests = new Map<string, SourceDigestRecord>();
  #seq = 0;
  #dirReady = false;
  #diskRevision = 'missing';
  #historyChanged = false;

  constructor(options: EvidenceLedgerStoreOptions) {
    const contentProfile = options.contentProfile ?? 'redacted-evidence';
    if (!Object.hasOwn(LEDGER_DIRECTORY_BY_PROFILE, contentProfile)) {
      throw new Error('EVIDENCE_LEDGER_CONTENT_PROFILE_INVALID');
    }
    if (contentProfile === 'verbatim-witness' && options.redactor !== undefined) {
      // 构造期失败即关：见证通道不能有任何脱敏入口，连“恒等 redactor”也不接受，避免接线漂移。
      throw new Error('EVIDENCE_LEDGER_WITNESS_REDACTOR_FORBIDDEN');
    }
    this.#contentProfile = contentProfile;
    this.#sessionId = options.sessionId;
    this.#dimensionId = options.dimensionId;
    this.#redactor = options.redactor ?? ((text) => text);
    this.#ledgerRoot = join(options.dataRoot, '.asd', LEDGER_DIRECTORY_BY_PROFILE[contentProfile]);
    this.filePath = join(this.#ledgerRoot, options.jobId, `${options.dimensionId}.jsonl`);
    this.#hydrate();
    if (this.#diskRevision !== 'missing') {
      // D7：打开加固之前写下的旧台账时把权限收紧到新标准并补 .gitignore；失败只记 warn。
      this.#hardenStorage('opened');
    }
  }

  /** 采集侧唯一写入口（E2 在工具结果收口处调用）；返回带 id 的完整条目 */
  append(draft: EvidenceEntryDraft, options: EvidenceAppendOptions = {}): EvidenceEntry {
    if (this.#contentProfile === 'verbatim-witness') {
      // 见证闸门在一切 I/O 之前：被拒绝的内容不建目录、不写行、不分配 E-n。
      this.#assertWitnessAdmissible(draft);
    }
    this.#refresh();
    const capped = this.#redactAndCap(draft.content, redactionContextOf(draft));
    const entry: EvidenceEntry = {
      id: makeEvidenceId(this.#seq + 1),
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
    const frozen = freezeEvidenceEntry(entry);
    this.#writeLine(frozen);
    // durable append 成功后才消耗 ID；写失败的下次调用先刷新磁盘以发现残行。
    this.#seq += 1;
    this.#entries.set(frozen.id, frozen);
    this.#recordSourceDigest(frozen, draft, options);
    this.#diskRevision = 'refresh-required';
    try {
      this.#diskRevision = this.#readDiskRevision();
    } catch (err: unknown) {
      // append 已确认，stat 只是缓存元数据；保留回执，下次访问必须重读，不能误报写入失败。
      observeSafely(
        () =>
          Logger.getInstance().warn(
            '[EvidenceLedger] post-append metadata unavailable; refresh required',
            {
              evidenceId: frozen.id,
              error: err instanceof Error ? err.message : String(err),
            }
          ),
        () => undefined
      );
    }
    return cloneEvidenceEntry(frozen);
  }

  /** 只读取回：接受 `E-12` 或 `E-12@5-20`；子区间返回派生副本（content 为切片） */
  get(ref: string): EvidenceEntry | null {
    this.#refresh();
    const parsed = parseEvidenceRef(ref);
    if (!parsed) {
      return null;
    }
    const entry = this.#entries.get(parsed.id) ?? null;
    if (!entry || !parsed.range) {
      return entry ? cloneEvidenceEntry(entry) : null;
    }
    return sliceEntry(entry, parsed.range);
  }

  has(id: string): boolean {
    this.#refresh();
    return this.#entries.has(id);
  }

  /**
   * E5 新鲜度终检。只有 file+range 条目可复核（read 类采集）；search 分组/terminal 等无法重构切片 →
   * 'unknown'（提交侧放行，最终仍由门禁的 fs verbatim 校验兜底）。区间越界（文件变短）直接 'stale'。
   *
   * 比对依据分两条路径，每次都记 debug 诊断说明走了哪条：
   * - source-digest：本实例 append 时记录了原文摘要 → HMAC(当前原文切片) 与摘要比对。被脱敏改写
   *   的字节对这条路径可见，不再有假 fresh；脱敏规则变化也不影响结论。
   * - redacted-hash：没有摘要（seed 进来的条目、跨进程续跑 hydrate 的条目、其它实例写入的条目）
   *   → 沿用现有「同区间重切 + 同截断 + 同脱敏」重算哈希与采集时比对，行为与阶段 2 之前相同。
   */
  checkFreshness(ref: string, currentFileContent: string): 'fresh' | 'stale' | 'unknown' {
    this.#refresh();
    const parsed = parseEvidenceRef(ref);
    if (!parsed) {
      return 'unknown';
    }
    const entry = this.#entries.get(parsed.id);
    if (!entry || !entry.file || !entry.range) {
      return 'unknown';
    }
    const digest = this.#usableSourceDigest(entry);
    const basis: FreshnessBasis = digest.record ? 'source-digest' : 'redacted-hash';
    const lines = currentFileContent.split('\n');
    if (entry.range.end > lines.length) {
      this.#logFreshness(entry, basis, 'stale', 'range-beyond-current-file');
      return 'stale';
    }
    const slice = lines.slice(entry.range.start - 1, entry.range.end).join('\n');
    let verdict: 'fresh' | 'stale';
    if (digest.record) {
      verdict = this.#sourceDigest(slice) === digest.record.digest ? 'fresh' : 'stale';
    } else {
      const recomputed = hashEvidenceContent(this.#redactAndCap(slice, redactionContextOf(entry)));
      verdict = recomputed === entry.contentHash ? 'fresh' : 'stale';
    }
    this.#logFreshness(entry, basis, verdict, digest.reason);
    return verdict;
  }

  /**
   * 条目来源分类（方案 C 的回读闸门）：terminal / no-file / secret-bearing / source / config。
   *
   * 分类表在 agent 层（evidenceFileClass.ts），tools 层的 evidence.get 按 config/layer-contract.json
   * 不能运行时依赖 agent，公开端口 EvidenceLedgerLike 也不新增字段，所以由台账实例代为回答：
   * handler 在读文件之前分别用条目声明的路径和项目根内解析后的真实路径询问，secret-bearing 一律
   * 不回读；不提供本方法的台账实现由 handler 按失败即关处理。纯函数委托，不读文件、不改状态。
   */
  classifyEvidenceSource(source: {
    readonly tool?: string;
    readonly file?: string;
  }): EvidenceSourceClass {
    return classifyEvidenceSourceByTable(source);
  }

  /**
   * 复算落盘管线并报告变换事实，不写盘、不分配 ID。
   *
   * 与 append 使用同一把尺（同一 redactor、同一上限），所以对同一 content 的结论与
   * 实际落盘一致；调用方应只在 append 返回内容不等于原文时调用，避免对未变换内容重复
   * 跑一遍脱敏正则。context 应与 append 时的草稿元数据一致（缺省等同未知来源）。
   */
  describeContentTransformation(
    content: string,
    context?: EvidenceRedactionContext
  ): EvidenceContentTransformation {
    const transformed = this.#transform(content, context);
    return Object.freeze({
      redacted: transformed.redacted,
      truncated: transformed.truncated,
      originalLength: content.length,
      storedLength: transformed.stored.length,
    });
  }

  /** 落盘内容统一管线：脱敏→上限截断（append 与 checkFreshness 的脱敏哈希路径共用同一把尺） */
  #redactAndCap(content: string, context?: EvidenceRedactionContext): string {
    return this.#transform(content, context).stored;
  }

  /**
   * 管线单源：脱敏后若超上限则保头截断并附显式标记。redacted/truncated 两个事实与
   * stored 一起返回，保证 describeContentTransformation 与实际写入不会各算各的。
   * verbatim-witness profile 是恒等管线：不调用 redactor、不截断（大小由写盘前闸门把关），
   * 所以 append、checkFreshness 的同尺重算与 describeContentTransformation 都按原文计算。
   */
  #transform(
    content: string,
    context?: EvidenceRedactionContext
  ): {
    readonly stored: string;
    readonly redacted: boolean;
    readonly truncated: boolean;
  } {
    if (this.#contentProfile === 'verbatim-witness') {
      return { stored: content, redacted: false, truncated: false };
    }
    const redacted = this.#redactor(content, context);
    const truncated = redacted.length > EVIDENCE_ENTRY_MAX_CHARS;
    const stored = truncated
      ? `${redacted.slice(0, EVIDENCE_ENTRY_MAX_CHARS - EVIDENCE_TRUNCATION_MARKER.length - 1)}\n${EVIDENCE_TRUNCATION_MARKER}`
      : redacted;
    return { stored, redacted: redacted !== content, truncated };
  }

  /**
   * 见证 profile 的写盘前判定（D5）：超过 1 MiB、UTF-8 往返不一致或有损解码痕迹、命中 T1 子集
   * 闸门时抛带理由的 Error。理由与诊断只含原因、规则种类、规则 id、文件路径和字节数，不含正文。
   * 只拒绝、不降级：见证通道没有“改成脱敏再写”的退路，否则宿主拿到的就不是原文。
   */
  #assertWitnessAdmissible(draft: EvidenceEntryDraft): void {
    const rejection = inspectWitnessContent(draft.content);
    if (!rejection) {
      return;
    }
    observeSafely(
      () =>
        Logger.getInstance().warn(
          '[EvidenceLedger] verbatim witness capture rejected before write; ledger unchanged',
          {
            tool: draft.tool,
            callId: draft.callId,
            ...(draft.file ? { file: draft.file } : {}),
            reason: rejection.reason,
            kind: rejection.kind,
            ...(rejection.reason === 'SECRET_DETECTED' ? { ruleId: rejection.ruleId } : {}),
            contentBytes: Buffer.byteLength(draft.content, 'utf8'),
            maxContentBytes: WITNESS_MAX_CONTENT_BYTES,
            witnessGatePolicyId: WITNESS_GATE_POLICY_ID,
          }
        ),
      () => undefined
    );
    throw new Error(describeWitnessRejection(rejection, draft.file));
  }

  /** 按文件路径片段检索（E3 近似候选提示 / E5 producer 展开用），按采集序返回 */
  searchByFile(fragment: string, limit = 20): EvidenceEntry[] {
    this.#refresh();
    const needle = fragment.toLowerCase();
    const hits: EvidenceEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.file?.toLowerCase().includes(needle)) {
        hits.push(cloneEvidenceEntry(entry));
        if (hits.length >= limit) {
          break;
        }
      }
    }
    return hits;
  }

  stats(): { entries: number; distinctFiles: number } {
    this.#refresh();
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
    this.#refresh();
    const all = [...this.#entries.values()];
    return all.slice(Math.max(0, all.length - limit)).map(cloneEvidenceEntry);
  }

  /**
   * Strict production 的全量 frozen snapshot 输入。
   *
   * 普通 get/search 可容忍历史 JSONL 中坏行并继续提供剩余证据；durable semantic review
   * 不能把这种部分 hydrate 宣称为 complete snapshot，所以任何坏行、旧 hash、重复 ID 或
   * foreign session/dimension 都会在这里 fail closed。
   */
  listStrictSnapshotEntries(): readonly EvidenceEntry[] {
    this.#refresh();
    if (this.#hydrateIntegrityIssues.length > 0) {
      throw new Error(
        `EVIDENCE_LEDGER_STRICT_SNAPSHOT_INVALID:${this.#hydrateIntegrityIssues.join(',')}`
      );
    }
    if (this.#entries.size === 0) {
      throw new Error('EVIDENCE_LEDGER_STRICT_SNAPSHOT_EMPTY');
    }
    return Object.freeze([...this.#entries.values()].map(freezeEvidenceEntry));
  }

  /**
   * production authority 打开阶段的 fail-closed 闸门。新建空台账合法，但已有 JSONL 的任何
   * hydrate 污染都必须在交给 capture/read facet 或 AgentRuntime 前失败。
   */
  assertProductionAuthorityHealthy(): void {
    this.#refresh();
    if (this.#hydrateIntegrityIssues.length > 0) {
      throw new Error(
        `EVIDENCE_LEDGER_PRODUCTION_AUTHORITY_INVALID:${this.#hydrateIntegrityIssues.join(',')}`
      );
    }
  }

  /** 台账内检索（E4 evidence.search）：路径片段或内容关键词，大小写不敏感，按采集序返回 */
  search(query: string, limit = 8): EvidenceEntry[] {
    this.#refresh();
    const needle = query.toLowerCase();
    const hits: EvidenceEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (
        entry.file?.toLowerCase().includes(needle) ||
        entry.content.toLowerCase().includes(needle)
      ) {
        hits.push(cloneEvidenceEntry(entry));
        if (hits.length >= limit) {
          break;
        }
      }
    }
    return hits;
  }

  // 同进程的同步 store 操作可重开同一台账；检测磁盘版本后再分配 ID/读取 snapshot。
  // 这不是跨进程写锁：宿主仍须让每个台账只有一个进程负责写入。
  #refresh(): void {
    if (this.#readDiskRevision() !== this.#diskRevision) {
      this.#hydrate();
    }
  }

  #readDiskRevision(): string {
    if (!existsSync(this.filePath)) {
      return 'missing';
    }
    const stat = statSync(this.filePath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  #hydrate(): void {
    // 先完成可能失败的 I/O，再替换缓存；读取异常不能把当前磁盘版本误记为已加载。
    const revision = this.#readDiskRevision();
    const lines = revision === 'missing' ? [] : readFileSync(this.filePath, 'utf8').split('\n');
    const previous = new Map(this.#entries);
    const previousSequence = this.#seq;
    this.#entries.clear();
    this.#hydrateIntegrityIssues.length = 0;
    this.#seq = 0;
    this.#dirReady = revision !== 'missing';
    for (const [lineIndex, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.#hydrateIntegrityIssues.push(`line-${lineIndex + 1}:json`);
        continue;
      }
      if (!isValidEvidenceEntry(parsed)) {
        this.#hydrateIntegrityIssues.push(`line-${lineIndex + 1}:shape`);
        continue;
      }
      // 即便该条记录随后因 authority/hash 污染被 strict 路径拒绝，也必须保留磁盘已占用的
      // 最大序号；否则普通兼容读回后继续 append 会复用已有 E-n，制造第二个歧义 authority。
      const seq = Number(parsed.id.slice(2));
      if (Number.isFinite(seq) && seq > this.#seq) {
        this.#seq = seq;
      }
      if (parsed.sessionId !== this.#sessionId || parsed.dimensionId !== this.#dimensionId) {
        this.#hydrateIntegrityIssues.push(`line-${lineIndex + 1}:authority`);
        continue;
      }
      if (parsed.contentHash !== hashEvidenceContent(parsed.content)) {
        // 任何非 canonical 哈希（含历史 domain-separated 裸 hex）都按 authority 污染整行丢弃。
        // 两处生产构造点（production authority 打开、兄弟台账 seed）都会对该问题 fail closed，
        // 旧哈希“记问题但保留在宽松视图”的兼容分支从未在生产生效，因此不再保留。
        this.#hydrateIntegrityIssues.push(`line-${lineIndex + 1}:authority`);
        continue;
      }
      if (this.#entries.has(parsed.id)) {
        this.#hydrateIntegrityIssues.push(`line-${lineIndex + 1}:duplicate-id`);
        continue;
      }
      this.#entries.set(parsed.id, freezeEvidenceEntry(parsed));
    }
    // append-only authority 的 id 必须从 E-1 连续到磁盘最大序号；中间行被删除时不能把剩余
    // 条目误报成 complete snapshot。尾部截断若留下半行则由上面的 JSON 校验拒绝。
    const ids = [...this.#entries.keys()].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    if (ids.length !== this.#seq || ids.some((id, index) => id !== makeEvidenceId(index + 1))) {
      // O(实际条目数)，同时保留 canonical E-n 校验，E-01 不能伪装成 E-1。
      this.#hydrateIntegrityIssues.push('missing-id:non-contiguous');
    }
    for (const [id, entry] of previous) {
      const current = this.#entries.get(id);
      if (!current || stableStringifyEntry(current) !== stableStringifyEntry(entry)) {
        this.#historyChanged = true;
      }
    }
    if (this.#historyChanged) {
      // 已见过的历史分叉不能被后续替代行洗白；恢复磁盘后需重新打开 authority。
      this.#hydrateIntegrityIssues.push('history-changed');
    }
    // 已确认的历史即使被外部删除也不能复用编号；严格路径必须报告历史已改变。
    this.#seq = Math.max(previousSequence, this.#seq);
    this.#diskRevision = revision;
  }

  #writeLine(entry: EvidenceEntry): void {
    if (!this.#dirReady) {
      // .asd 由宿主与 Agent 多方共用，这里只保证存在、不改它的权限；evidence-ledger 及以下目录
      // 新建即 0700（mode 受 umask 只减不增）。已存在的旧目录由 #hardenStorage 收紧。
      mkdirSync(dirname(this.#ledgerRoot), { recursive: true });
      mkdirSync(dirname(this.filePath), { recursive: true, mode: LEDGER_DIRECTORY_MODE });
      this.#hardenStorage('created');
      this.#dirReady = true;
    }
    this.#terminatePartialTail(entry.id);
    // mode 只在文件新建时生效；已存在的旧文件在打开时已尝试收紧。
    appendFileSync(this.filePath, `${stableStringifyEntry(entry)}\n`, {
      encoding: 'utf8',
      mode: LEDGER_FILE_MODE,
    });
  }

  /**
   * 记录原文摘要。只对本实例 append、带 file+range、且草稿内容就是原文切片的条目记录；
   * seed（contentIsSourceSlice=false）跳过，checkFreshness 对它退回脱敏哈希。摘要只在内存里。
   */
  #recordSourceDigest(
    entry: EvidenceEntry,
    draft: EvidenceEntryDraft,
    options: EvidenceAppendOptions
  ): void {
    if (!entry.file || !entry.range || options.contentIsSourceSlice === false) {
      return;
    }
    this.#sourceDigests.set(entry.id, {
      digest: this.#sourceDigest(draft.content),
      contentHash: entry.contentHash,
      file: entry.file,
      start: entry.range.start,
      end: entry.range.end,
    });
  }

  /**
   * 取可用的原文摘要。摘要绑定条目的落盘身份（contentHash、file、range）：同一 id 的磁盘行若被
   * 外部改写（hydrate 会另记 history-changed），旧摘要不再代表该条目，按没有摘要处理。
   */
  #usableSourceDigest(entry: EvidenceEntry): {
    readonly record: SourceDigestRecord | null;
    readonly reason: string;
  } {
    const record = this.#sourceDigests.get(entry.id);
    if (!record) {
      // seed 条目、跨进程 hydrate 的条目、其它实例写入的条目都没有本实例的摘要
      return { record: null, reason: 'no-source-digest' };
    }
    if (
      record.contentHash !== entry.contentHash ||
      record.file !== entry.file ||
      record.start !== entry.range?.start ||
      record.end !== entry.range?.end
    ) {
      return { record: null, reason: 'source-digest-entry-mismatch' };
    }
    return { record, reason: 'source-digest-recorded' };
  }

  #sourceDigest(sourceSlice: string): string {
    return createHmac('sha256', this.#sourceDigestKey).update(sourceSlice, 'utf8').digest('hex');
  }

  /** freshness 诊断：只记条目坐标、比对依据与结论，不含原文、存储内容或摘要值。 */
  #logFreshness(
    entry: EvidenceEntry,
    basis: FreshnessBasis,
    verdict: 'fresh' | 'stale',
    reason: string
  ): void {
    observeSafely(
      () =>
        Logger.getInstance().debug(`[EvidenceLedger] freshness checked via ${basis}`, {
          evidenceId: entry.id,
          tool: entry.tool,
          file: entry.file,
          range: entry.range ? `${entry.range.start}-${entry.range.end}` : undefined,
          basis,
          reason,
          verdict,
        }),
      () => undefined
    );
  }

  /**
   * D7 静态加固：收紧台账文件与目录权限，补自忽略 .gitignore。
   *
   * origin=created：首次写入前目录刚建好（新目录已是 0700），这里补 .gitignore 并收紧可能早已
   * 存在的 evidence-ledger 根目录；origin=opened：构造时发现已有台账文件，按新标准收紧旧的
   * 0644/0755。任何失败只记 warn、不抛出：权限加固不能让已经存在的证据变得不可读或不可追加。
   */
  #hardenStorage(origin: 'created' | 'opened'): void {
    if (process.platform !== 'win32') {
      // Windows 没有 POSIX 权限位（chmod 只切换只读），跳过收紧，只写 .gitignore。
      if (origin === 'opened') {
        this.#tightenMode(this.filePath, LEDGER_FILE_MODE, 'ledger-file', origin);
      }
      this.#tightenMode(dirname(this.filePath), LEDGER_DIRECTORY_MODE, 'job-directory', origin);
      this.#tightenMode(this.#ledgerRoot, LEDGER_DIRECTORY_MODE, 'ledger-root', origin);
    }
    this.#ensureSelfIgnoringGitignore();
  }

  /** 只去掉超出目标的权限位（group/other），已经更严的权限保持不动，避免无谓 chmod。 */
  #tightenMode(target: string, mode: number, kind: string, origin: string): void {
    let current: number;
    try {
      current = statSync(target).mode & 0o777;
    } catch (err: unknown) {
      this.#warnHardening('could not tighten ledger storage permissions; continuing', {
        target,
        kind,
        origin,
        step: 'stat',
        error: describeError(err),
      });
      return;
    }
    if ((current & ~mode) === 0) {
      return;
    }
    try {
      chmodSync(target, mode);
    } catch (err: unknown) {
      this.#warnHardening('could not tighten ledger storage permissions; continuing', {
        target,
        kind,
        origin,
        step: 'chmod',
        fromMode: formatMode(current),
        toMode: formatMode(mode),
        error: describeError(err),
      });
      return;
    }
    observeSafely(
      () =>
        Logger.getInstance().info('[EvidenceLedger] tightened ledger storage permissions', {
          target,
          kind,
          origin,
          fromMode: formatMode(current),
          toMode: formatMode(mode),
        }),
      () => undefined
    );
  }

  /**
   * 台账根目录（evidence-ledger/ 或见证 profile 的 evidence-witness/）下的 .gitignore 内容为 `*`；
   * 已存在（含运维自写的内容）则不覆盖。
   */
  #ensureSelfIgnoringGitignore(): void {
    const target = join(this.#ledgerRoot, LEDGER_GITIGNORE_NAME);
    try {
      writeFileSync(target, LEDGER_GITIGNORE_CONTENT, {
        encoding: 'utf8',
        flag: 'wx',
        mode: LEDGER_FILE_MODE,
      });
    } catch (err: unknown) {
      if (hasErrorCode(err, 'EEXIST')) {
        return;
      }
      this.#warnHardening('could not write self-ignoring .gitignore; continuing', {
        target,
        error: describeError(err),
      });
      return;
    }
    observeSafely(
      () =>
        Logger.getInstance().info('[EvidenceLedger] wrote self-ignoring .gitignore', { target }),
      () => undefined
    );
  }

  #warnHardening(message: string, fields: Record<string, unknown>): void {
    observeSafely(
      () => Logger.getInstance().warn(`[EvidenceLedger] ${message}`, fields),
      () => undefined
    );
  }

  /**
   * 残行收尾：上次 append 若因 ENOSPC/EDQUOT/EIO 短写后抛错，文件尾会留下没有换行的半行。
   * 循环采集路径（EvidenceCapture → append）不经 capture facet 的健康闸门，若直接追加，
   * 新条目会被拼进半行变成一整条坏 JSON：本实例已回执给模型的 E-n 在重开后读不到。
   * 这里只在文件非空且末字节不是 '\n' 时补一个换行，让新条目独占一行；残行本身保持原样，
   * hydrate 仍把它记为 line-N:json，strict snapshot 与生产闸门照旧 fail closed。
   * 补写失败直接抛出，由 append 按写失败处理（不消耗序号，下次调用重新检查）。
   */
  #terminatePartialTail(nextEvidenceId: string): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    const fd = openSync(this.filePath, 'r');
    let size = 0;
    let endsWithNewline = true;
    try {
      size = fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        // 读不到字节（stat 后被并发截断）时视为无需补写，不凭空制造空行。
        const bytesRead = readSync(fd, last, 0, 1, size - 1);
        endsWithNewline = bytesRead === 0 || last[0] === 0x0a;
      }
    } finally {
      closeSync(fd);
    }
    if (endsWithNewline) {
      return;
    }
    const diagnostic = {
      filePath: this.filePath,
      reason: 'last-byte-not-newline',
      fileSize: size,
      evidenceId: nextEvidenceId,
    };
    try {
      appendFileSync(this.filePath, '\n', 'utf8');
    } catch (err: unknown) {
      observeSafely(
        () =>
          Logger.getInstance().warn(
            '[EvidenceLedger] partial tail line detected before append; newline padding failed',
            { ...diagnostic, error: err instanceof Error ? err.message : String(err) }
          ),
        () => undefined
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
    observeSafely(
      () =>
        Logger.getInstance().warn(
          '[EvidenceLedger] partial tail line detected before append; newline padded',
          diagnostic
        ),
      () => undefined
    );
  }
}

function cloneEvidenceEntry(entry: EvidenceEntry): EvidenceEntry {
  return {
    ...entry,
    ...(entry.range ? { range: { ...entry.range } } : {}),
  };
}

/** 从草稿或条目取 redactor 上下文；冻结副本，redactor 不能借它改写条目元数据。 */
function redactionContextOf(source: {
  readonly tool: EvidenceToolId;
  readonly file?: string;
  readonly range?: EvidenceRange;
}): EvidenceRedactionContext {
  return Object.freeze({
    tool: source.tool,
    ...(source.file ? { file: source.file } : {}),
    ...(source.range
      ? { range: Object.freeze({ start: source.range.start, end: source.range.end }) }
      : {}),
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function freezeEvidenceEntry(entry: EvidenceEntry): EvidenceEntry {
  const frozen = cloneEvidenceEntry(entry);
  if (frozen.range) {
    Object.freeze(frozen.range);
  }
  return Object.freeze(frozen);
}

/**
 * M4（跨维综合）：把同一 job 目录下兄弟维度的台账条目 seed 进本维度 store——
 * 合成维度由此获得全部维度的证据视野（get/search/note_finding/展开全链复用，零新类）。
 * 条目经 append 重编号（E-1..E-n 连续 id 空间，parseEvidenceRef 语法不变）、重脱敏重截断
 * （内容已是脱敏后形态，二次处理幂等）；callId 带来源维度前缀保留溯源。
 * seed 内容不是原文切片，append 时不记录原文摘要，这些条目的 freshness 退回脱敏哈希（与现状相同）。
 * 任何单文件读取失败只跳过该文件（合成宁可少证据不可断跑）。
 */
export function seedLedgerFromJobSiblings(
  store: EvidenceLedgerStore,
  options: {
    dataRoot: string;
    jobId: string;
    selfDimensionId: string;
    logger?: Pick<Console, 'warn'>;
  }
): number {
  const dir = join(options.dataRoot, '.asd', 'evidence-ledger', options.jobId);
  if (!existsSync(dir)) {
    return 0;
  }
  let seeded = 0;
  // 按文件名码元序遍历：seed 依此顺序 append 分配连续 E-n，readdirSync 的目录序随文件系统
  // 而变（APFS、ext4 哈希序等），不排序会让同一组兄弟台账在不同机器上得到不同的 E-n 映射。
  for (const name of [...readdirSync(dir)].sort()) {
    if (!name.endsWith('.jsonl') || name === `${options.selfDimensionId}.jsonl`) {
      continue;
    }
    const sourceDim = name.slice(0, -'.jsonl'.length);
    try {
      // 先验证完整来源再重编号；否则重算 contentHash 会把损坏/外来条目重新认证为本轮证据。
      // 每个维度由独立 AgentRuntime 执行，来源 session 不必等于目标 session。
      // 先取来源文件自身的身份，再由 hydrate 验证该文件内所有条目的同一 session/dimension。
      const firstLine = readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .find((line) => line.trim());
      const first: unknown = firstLine ? JSON.parse(firstLine) : null;
      if (!isValidEvidenceEntry(first)) {
        throw new Error('EVIDENCE_LEDGER_SEED_SOURCE_IDENTITY_INVALID');
      }
      const source = new EvidenceLedgerStore({
        dataRoot: options.dataRoot,
        jobId: options.jobId,
        sessionId: first.sessionId,
        dimensionId: sourceDim,
      });
      const entries = source.listStrictSnapshotEntries();
      for (const entry of entries) {
        store.append(
          {
            tool: entry.tool,
            callId: `seed:${sourceDim}:${entry.id}`,
            ...(entry.file ? { file: entry.file } : {}),
            ...(entry.range ? { range: entry.range } : {}),
            content: entry.content,
          },
          { contentIsSourceSlice: false }
        );
        seeded += 1;
      }
    } catch (err: unknown) {
      observeSafely(
        () =>
          options.logger?.warn(
            `[EvidenceLedger] seed skip ${name}: ${err instanceof Error ? err.message : String(err)}`
          ),
        () => undefined
      );
    }
  }
  return seeded;
}
