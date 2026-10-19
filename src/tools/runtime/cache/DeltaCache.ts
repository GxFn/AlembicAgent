/**
 * @module tools/runtime/cache/DeltaCache
 *
 * 文件读取增量缓存。同一会话中再次读取已读文件时:
 *   - 内容未变且此前完整可见 → 返回 "[unchanged since last read]"
 *   - 内容有变且此前完整可见 → 返回行级紧凑 diff；拼好的 diff 文本不小于全文（字符数或共同 token
 *     估算）、或变更行数不少于全文行数时回退 full 并刷新可见基线
 *   - 首次读取或此前只登记了指纹 → 返回 full 并成为可见基线
 *
 * 指纹（md5 hex）只在本模块计算：check() 自算，set() 可省略 hash 由缓存自算，写前新鲜度门
 * 经 isFresh() 比较，调用方不再各自实现一份指纹算法。
 *
 * 使用 LRU 策略控制内存（默认缓存 200 个文件）；只有可见基线保存全文，仅指纹条目 content 为 ''。
 */

import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { estimateTokens } from '#shared/tokenUtils.js';

export interface DeltaCacheEntry {
  hash: string;
  /**
   * 可见基线的全文，仅 visible 条目保存；仅指纹条目（范围读、提纲、写后登记、截断降级）为 ''，
   * 这些条目只服务写前新鲜度门，不参与 delta 计算。
   */
  content: string;
  lineCount: number;
  lastAccess: number;
  /** 指纹用于写前新鲜度，只有完整返回的内容才能成为 delta 基线。 */
  visible?: boolean;
}

export interface DeltaReadResult {
  mode: 'unchanged' | 'delta' | 'full';
  content: string;
  lineCount: number;
}

/**
 * 中段 LCS 表的单元格上限。code.read 只对 ≤500 行的全文读调用 check()，新旧中段最多
 * 501×501 个单元格，512² 足以覆盖；超出（公开 API 的直接调用方传入更大文件）时降级为逐位置
 * 配对，避免为一次 diff 分配随行数平方增长的内存。
 */
const MAX_LCS_CELLS = 512 * 512;

export class DeltaCache {
  readonly #cache = new Map<string, DeltaCacheEntry>();
  readonly #maxEntries: number;

  constructor(maxEntries = 200) {
    // 0保留每次全文读取的禁用语义；负数/非整数会破坏驱逐边界，不能延至写入时才失败。
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError('DeltaCache maxEntries must be a non-negative safe integer');
    }
    this.#maxEntries = maxEntries;
  }

  /** 获取缓存条目（同时更新 LRU 时间）；仅指纹条目的 content 为 ''。 */
  get(path: string): DeltaCacheEntry | undefined {
    const entry = this.#cache.get(path);
    if (entry) {
      entry.lastAccess = Date.now();
    }
    return entry;
  }

  /**
   * 记录文件版本，不宣称模型看过全文；范围读、提纲、写入、截断降级均使用此入口。
   * hash 传 undefined 时由缓存按本模块指纹算法自算（单源）；显式传入时沿用调用方给的版本指纹
   * （截断降级只持有旧条目的指纹，content 可能已是 ''）。条目只保存指纹与行数，content 存 ''。
   */
  set(path: string, hash: string | undefined, content: string): void {
    const fingerprint = hash ?? contentFingerprint(content);
    const previous = this.#cache.get(path);
    // 只带指纹降级（content 为空且指纹未变）时沿用同一版本已知的行数，不能把行数记成 1。
    const lineCount =
      content === '' && previous?.hash === fingerprint ? previous.lineCount : countLines(content);
    this.#cache.set(path, {
      hash: fingerprint,
      content: '',
      lineCount,
      lastAccess: Date.now(),
      visible: false,
    });
    this.#evictLRU();
  }

  /**
   * 写前新鲜度判定：磁盘当前内容的指纹是否等于本缓存登记的版本指纹。
   * 未登记的路径返回 false；“未读即拒”的分支由调用方先用 get() 区分。
   */
  isFresh(path: string, content: string): boolean {
    const entry = this.get(path);
    return entry !== undefined && entry.hash === contentFingerprint(content);
  }

  /**
   * 智能读取: 根据缓存状态决定返回全文 / unchanged / diff
   * 缓存未命中或旧内容不可见时返回 full；不以指纹存在推断全文已被展示。
   * 返回的 delta 文本（含 hunk 头、-/+ 前缀与换行）按字符数或共同 token 估算不比全文小、或变更行数
   * 不少于全文行数时回退 full：调用方 full 分支自带行号，模型可直接定位。
   */
  check(path: string, currentContent: string): DeltaReadResult {
    const currentHash = contentFingerprint(currentContent);
    const cached = this.#cache.get(path);
    const lineCount = countLines(currentContent);

    if (cached?.visible) {
      cached.lastAccess = Date.now();

      if (cached.hash === currentHash) {
        return { mode: 'unchanged', content: '[unchanged since last read]', lineCount };
      }

      const plan = planLineDelta(cached.content, currentContent);
      // 无论回退与否，本次返回的都是当前完整版本：直接写可见基线，下一次以它为比较起点。
      this.#rememberVisible(path, currentHash, currentContent, lineCount);
      if (plan.selected === 'full' || plan.algorithm === 'positional') {
        reportDeltaPlan(path, plan, lineCount);
      }
      if (plan.selected === 'full') {
        return { mode: 'full', content: currentContent, lineCount };
      }
      return { mode: 'delta', content: plan.text, lineCount };
    }

    this.#rememberVisible(path, currentHash, currentContent, lineCount);
    return { mode: 'full', content: currentContent, lineCount };
  }

  /** 清除所有缓存 */
  clear(): void {
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }

  /** 登记完整返回给模型的版本：只有这里写入全文并标记 visible。容量 0 时随即被驱逐。 */
  #rememberVisible(path: string, hash: string, content: string, lineCount: number): void {
    this.#cache.set(path, {
      hash,
      content,
      lineCount,
      lastAccess: Date.now(),
      visible: true,
    });
    this.#evictLRU();
  }

  #evictLRU(): void {
    if (this.#cache.size <= this.#maxEntries) {
      return;
    }

    const entries = [...this.#cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const toRemove = entries.length - this.#maxEntries;
    for (let i = 0; i < toRemove; i++) {
      this.#cache.delete(entries[i][0]);
    }
  }
}

/** 版本指纹的唯一实现（md5 hex，与写前门历史指纹一致）。 */
function contentFingerprint(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

function countLines(content: string): number {
  return content.split('\n').length;
}

type LineOp = { kind: 'equal' | 'delete' | 'insert'; line: string };

/**
 * 回退 full 的触发条件，可同时成立：
 *   - lines：变更行数不少于全文行数，逐行 -/+ 不如带行号的全文好定位；
 *   - chars：拼好的 delta 文本字符数不小于全文；
 *   - tokens：delta 文本按共同 token 估算（shared/tokenUtils，Router 的 maxOutputTokens 截断也用它）
 *     不小于全文。中文行每字 0.5、ASCII 每字 0.25，删掉长中文行时字符更少的 delta 也可能更贵。
 */
type DeltaFallbackTrigger = 'lines' | 'chars' | 'tokens';

interface LineDeltaPlan {
  selected: 'delta' | 'full';
  /** lcs：前后缀裁剪后对中段求最长公共子序列；positional：中段超出 LCS 预算时逐位置配对。 */
  algorithm: 'lcs' | 'positional';
  /** selected=delta 时是要返回的 delta 文本；回退 full 时为 ''。 */
  text: string;
  hunks: number;
  changedLines: number;
  /** 回退触发条件；为空表示 delta 在行数、字符、token 三把尺子上都严格小于全文。 */
  triggers: DeltaFallbackTrigger[];
  /** 拼好的完整 delta 文本（首行 + 全部 hunk）的字符数与 token 估算，回退时也照实记录。 */
  deltaChars: number;
  deltaTokens: number;
  fullChars: number;
  fullTokens: number;
  lcsCells: number;
}

/**
 * 行级 diff 计划。先裁掉公共前后缀（单处插入/删除/修改在这里就收敛为最小中段），
 * 中段在预算内用 LCS 求真实增删，超出预算降级为逐位置配对。
 * 回退判据量的是真正会返回的 delta 文本：'[delta: K hunk(s)]' 首行、每个 hunk 的 '@@ line N @@' 头、
 * 每行 '- '/'+ ' 前缀与换行、hunk 间空行全部计入；只比变更行原始字符会漏掉这些格式开销，
 * 零散单行编辑的 delta 比全文还长仍被当作 delta 返回（审计 L4-P6c）。
 */
function planLineDelta(oldContent: string, newContent: string): LineDeltaPlan {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const shorter = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < shorter && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const lcsCells = (oldMiddle.length + 1) * (newMiddle.length + 1);
  const algorithm = lcsCells <= MAX_LCS_CELLS ? 'lcs' : 'positional';
  const ops =
    algorithm === 'lcs'
      ? lcsEditScript(oldMiddle, newMiddle)
      : positionalEditScript(oldMiddle, newMiddle);

  const hunks: string[] = [];
  const deleted: string[] = [];
  const inserted: string[] = [];
  let changedLines = 0;
  // hunk 头沿用 "@@ line N @@"，N 是变更在当前文件中的起始行号（1 基）。
  let newIndex = prefix;
  let hunkStart = -1;
  const closeHunk = () => {
    if (hunkStart < 0) {
      return;
    }
    const body = [...deleted.map((line) => `- ${line}`), ...inserted.map((line) => `+ ${line}`)];
    hunks.push(`@@ line ${hunkStart} @@\n${body.join('\n')}`);
    deleted.length = 0;
    inserted.length = 0;
    hunkStart = -1;
  };
  for (const op of ops) {
    if (op.kind === 'equal') {
      closeHunk();
      newIndex++;
      continue;
    }
    if (hunkStart < 0) {
      hunkStart = newIndex + 1;
    }
    changedLines++;
    if (op.kind === 'delete') {
      deleted.push(op.line);
    } else {
      inserted.push(op.line);
      newIndex++;
    }
  }
  closeHunk();

  // 先拼出完整 delta 文本再量：判据与模型实际收到的内容是同一个字符串。
  const text = `[delta: ${hunks.length} hunk(s)]\n${hunks.join('\n\n')}`;
  const deltaTokens = estimateTokens(text);
  const fullTokens = estimateTokens(newContent);
  const triggers: DeltaFallbackTrigger[] = [];
  if (changedLines >= newLines.length) {
    triggers.push('lines');
  }
  if (text.length >= newContent.length) {
    triggers.push('chars');
  }
  if (deltaTokens >= fullTokens) {
    triggers.push('tokens');
  }
  const selected = triggers.length > 0 ? 'full' : 'delta';
  return {
    selected,
    algorithm,
    text: selected === 'full' ? '' : text,
    hunks: hunks.length,
    changedLines,
    triggers,
    deltaChars: text.length,
    deltaTokens,
    fullChars: newContent.length,
    fullTokens,
    lcsCells,
  };
}

/** 以后缀 LCS 表回溯出编辑脚本；平局时先删后增，同一 hunk 内输出顺序稳定。 */
function lcsEditScript(oldLines: string[], newLines: string[]): LineOp[] {
  const rows = oldLines.length;
  const cols = newLines.length;
  const width = cols + 1;
  // table[i * width + j] = LCS(oldLines[i..], newLines[j..])；单元格数已由 MAX_LCS_CELLS 约束。
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'equal', line: newLines[j] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: 'delete', line: oldLines[i] });
      i++;
    } else {
      ops.push({ kind: 'insert', line: newLines[j] });
      j++;
    }
  }
  for (; i < rows; i++) {
    ops.push({ kind: 'delete', line: oldLines[i] });
  }
  for (; j < cols; j++) {
    ops.push({ kind: 'insert', line: newLines[j] });
  }
  return ops;
}

/** 降级路径：逐位置配对（旧实现的语义），插删行会让其后各行全部成对变更，交给“不比全文小”判定兜底。 */
function positionalEditScript(oldLines: string[], newLines: string[]): LineOp[] {
  const ops: LineOp[] = [];
  const longer = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < longer; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    if (oldLine !== undefined && oldLine === newLine) {
      ops.push({ kind: 'equal', line: oldLine });
      continue;
    }
    if (oldLine !== undefined) {
      ops.push({ kind: 'delete', line: oldLine });
    }
    if (newLine !== undefined) {
      ops.push({ kind: 'insert', line: newLine });
    }
  }
  return ops;
}

/**
 * 回退 full 与逐位置降级都要可观测：只记录路径、选择、原因、触发条件与计数，不记录文件内容。
 * trigger 列出决定回退的条件（lines/chars/tokens，逗号分隔），delta 被选中时为 none。
 * 日志失败不能影响读取结果。
 */
function reportDeltaPlan(path: string, plan: LineDeltaPlan, fullLines: number): void {
  const reason = plan.selected === 'full' ? 'delta_not_smaller' : 'lcs_budget_exceeded';
  const trigger = plan.triggers.length > 0 ? plan.triggers.join(',') : 'none';
  const message =
    `[DeltaCache] path=${path}; selected=${plan.selected}; reason=${reason}; ` +
    `trigger=${trigger}; diff=${plan.algorithm}; hunks=${plan.hunks}; ` +
    `changedLines=${plan.changedLines}; fullLines=${fullLines}; ` +
    `deltaChars=${plan.deltaChars}; fullChars=${plan.fullChars}; ` +
    `deltaTokens=${plan.deltaTokens}; fullTokens=${plan.fullTokens}; ` +
    `lcsCells=${plan.lcsCells}; lcsBudget=${MAX_LCS_CELLS}`;
  observeSafely(
    () => Logger.getInstance().info(message),
    () => undefined
  );
}
