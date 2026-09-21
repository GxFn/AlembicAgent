/**
 * @module tools/runtime/compressor/parsers/GitLogParser
 * 解析 git log 命令输出为紧凑结构化格式。
 */

interface LogEntry {
  hash: string;
  date: string;
  author: string;
  message: string;
}

const COMMIT_RE = /^commit\s+([0-9a-f]{7,40})$/;
const AUTHOR_RE = /^Author:\s+(.+?)(?:\s+<.*>)?$/;
const DATE_RE = /^Date:\s+(.+)$/;

const ONELINE_RE = /^([0-9a-f]{7,40})\s+(.+)$/;

const FORMAT_RE =
  /^([0-9a-f]{7,40})\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:\s*[+-]\d{4})?)\s+(.+?):\s+(.+)$/;

const MAX_ENTRIES = 20;

function parseFullFormat(raw: string): LogEntry[] | null {
  const entries: LogEntry[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const commitMatch = COMMIT_RE.exec(lines[i] ?? '');
    if (!commitMatch) {
      if (lines[i]?.trim()) {
        return null;
      }
      i++;
      continue;
    }

    const hash = commitMatch[1].slice(0, 7);
    let author = '';
    let date = '';
    let message = '';
    i++;

    while (i < lines.length) {
      const line = lines[i] ?? '';
      const authorMatch = AUTHOR_RE.exec(line);
      if (authorMatch) {
        author = authorMatch[1];
        i++;
        continue;
      }
      const dateMatch = DATE_RE.exec(line);
      if (dateMatch) {
        date = dateMatch[1].trim();
        i++;
        continue;
      }
      if (line.trim() === '' || /^Merge: [0-9a-f ]+$/.test(line)) {
        i++;
        continue;
      }
      if (COMMIT_RE.test(line)) {
        break;
      }

      // full-format 的正文固定缩进；正文里的 commit/Author/Date 只是消息，不能改写元信息。
      if (!line.startsWith('    ')) {
        return null;
      }
      if (!message) {
        message = line.slice(4).trim();
      }
      i++;
    }

    if (!author || !date || !message) {
      return null;
    }
    entries.push({ hash, date, author, message });
  }

  return entries;
}

function parseOneline(raw: string): LogEntry[] | null {
  const entries: LogEntry[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      continue;
    }

    const fmtMatch = FORMAT_RE.exec(trimmed);
    if (fmtMatch) {
      entries.push({
        hash: fmtMatch[1].slice(0, 7),
        date: fmtMatch[2],
        author: fmtMatch[3],
        message: fmtMatch[4],
      });
      continue;
    }

    const oneMatch = ONELINE_RE.exec(trimmed);
    if (oneMatch) {
      entries.push({
        hash: oneMatch[1].slice(0, 7),
        date: '',
        author: '',
        message: oneMatch[2],
      });
    } else {
      return null;
    }
  }

  return entries;
}

function formatEntries(entries: LogEntry[]): string {
  const rendered = entries
    .slice(0, MAX_ENTRIES)
    .map((e) => {
      const parts = [e.hash];
      if (e.date) {
        parts.push(e.date);
      }
      if (e.author) {
        parts.push(`${e.author}:`);
      }
      parts.push(e.message);
      return parts.join(' ');
    })
    .join('\n');
  const omitted = entries.length - MAX_ENTRIES;
  return omitted > 0
    ? `${rendered}\n... (${omitted} commit${omitted === 1 ? '' : 's'} omitted)`
    : rendered;
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    // 已出现完整格式的标题时，失败不能再由oneline正则部分接管。
    const entries = /^commit\s/m.test(raw) ? parseFullFormat(raw) : parseOneline(raw);
    if (entries && entries.length > 0) {
      return formatEntries(entries);
    }

    return null;
  } catch (err: unknown) {
    void err;
    return null;
  }
}
