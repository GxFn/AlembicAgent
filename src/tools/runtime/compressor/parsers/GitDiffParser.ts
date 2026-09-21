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

function parseDiffStat(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const m = STAT_LINE_RE.exec(line.trim());
    if (m) {
      return line.trim();
    }
  }
  return null;
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
      const statLine = parseDiffStat(raw);
      return statLine ?? null;
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
