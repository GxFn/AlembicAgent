/**
 * @module tools/runtime/compressor/parsers/GitDiffParser
 * 解析 git diff 命令输出为紧凑结构化格式。
 */

interface FileStat {
  file: string;
  added: number;
  removed: number;
  hunks: number;
}

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)$/;
const STAT_LINE_RE =
  /^\s*(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?[^,]*)?(?:,\s+(\d+)\s+deletions?.*)?$/;

function parseDiffContent(raw: string): FileStat[] | null {
  const files: FileStat[] = [];
  let current: FileStat | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of raw.split('\n')) {
    const headerMatch = DIFF_HEADER_RE.exec(line);
    if (headerMatch) {
      if (current) {
        if (!current.hunks || oldRemaining !== 0 || newRemaining !== 0) {
          return null;
        }
        files.push(current);
      }
      current = { file: headerMatch[2], added: 0, removed: 0, hunks: 0 };
      continue;
    }

    if (!current) {
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      if (oldRemaining !== 0 || newRemaining !== 0) {
        return null;
      }
      oldRemaining = Number(hunkMatch[1] ?? 1);
      newRemaining = Number(hunkMatch[2] ?? 1);
      if (![oldRemaining, newRemaining].every(Number.isSafeInteger)) {
        return null;
      }
      current.hunks++;
      continue;
    }

    if (current.hunks > 0 && line === '\\ No newline at end of file') {
      continue;
    }
    if (oldRemaining > 0 || newRemaining > 0) {
      // 只有 hunk 外的 +++/--- 才是文件标题；hunk 内其首字符仍是增删标记。
      if (line.startsWith('+')) {
        current.added++;
        newRemaining--;
      } else if (line.startsWith('-')) {
        current.removed++;
        oldRemaining--;
      } else if (line.startsWith(' ')) {
        oldRemaining--;
        newRemaining--;
      } else {
        return null;
      }
      if (oldRemaining < 0 || newRemaining < 0) {
        return null;
      }
    } else if (
      line !== '' &&
      (current.hunks > 0 ||
        !/^(?:index |--- |\+\+\+ |(?:new file|deleted file|old|new) mode |similarity index |(?:rename|copy) (?:from|to) )/.test(
          line
        ))
    ) {
      return null;
    }
  }

  if (current) {
    if (!current.hunks || oldRemaining !== 0 || newRemaining !== 0) {
      return null;
    }
    files.push(current);
  }
  return files.length > 0 ? files : null;
}

/** --stat 逐文件行 '<path> | <stat>' 中 stat 部分的全部合法形态：行数+图形条、二进制、未合并。 */
const STAT_FILE_VALUE_RE = /^(?:\d+(?:\s+[+-]+)?|Bin(?:\s+\d+\s+->\s+\d+\s+bytes)?|Unmerged)$/;

/**
 * stat-only 输出（--stat / --shortstat）：逐文件行全部保留，汇总行置顶。
 * 只接受“若干逐文件行 + 最后一行汇总”的完整形态，且逐文件行数必须等于汇总里的文件数；
 * 出现省略号（--stat-count）、--summary 附加行、被截断的输出等无法完整表达的情况返回 null，
 * 由 OutputCompressor 记录 unrecognized-output 并回退原文。超预算部分交给 truncateOutput。
 */
function parseDiffStat(raw: string): string | null {
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const summaryLine = lines.pop()?.trim();
  const summary = summaryLine === undefined ? null : STAT_LINE_RE.exec(summaryLine);
  if (!summaryLine || !summary) {
    return null;
  }
  // --shortstat 只有汇总行，原样保留。
  if (lines.length === 0) {
    return summaryLine;
  }

  const fileLines: string[] = [];
  for (const line of lines) {
    // 路径本身可能含 '|'，stat 部分不会；按最后一个 '|' 切分，避免回溯型正则。
    const pipe = line.lastIndexOf('|');
    const file = pipe > 0 ? line.slice(0, pipe).trim() : '';
    const stat = pipe > 0 ? line.slice(pipe + 1).trim() : '';
    if (!file || !STAT_FILE_VALUE_RE.test(stat)) {
      return null;
    }
    fileLines.push(`${file} | ${stat}`);
  }
  if (fileLines.length !== Number(summary[1])) {
    return null;
  }
  return [summaryLine, '', ...fileLines].join('\n');
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    const files = parseDiffContent(raw);
    if (!files) {
      if (/^diff --git /m.test(raw)) {
        return null;
      }
      return parseDiffStat(raw);
    }

    const totalAdded = files.reduce((s, f) => s + f.added, 0);
    const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

    const parts: string[] = [
      `${files.length} files changed, +${totalAdded}/-${totalRemoved} lines`,
      '',
    ];

    for (const f of files) {
      parts.push(`${f.file}: +${f.added}/-${f.removed}`);
    }

    return parts.join('\n');
  } catch (err: unknown) {
    void err;
    return null;
  }
}
