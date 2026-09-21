/**
 * @module tools/runtime/compressor/parsers/GrepParser
 * 解析 rg/grep 输出为紧凑结构化格式。
 */

const MAX_MATCHES = 30;

const GREP_LINE_RE = /^(.+?):(\d+):(.*)$/;

interface GrepMatch {
  file: string;
  line: string;
  content: string;
}

function tryJsonFormat(raw: string): GrepMatch[] | null {
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const matches: GrepMatch[] = [];
  let matchedLines: number | undefined;

  for (const [index, line] of lines.entries()) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'match' && obj.data) {
        const d = obj.data;
        if (
          typeof d.path?.text !== 'string' ||
          !d.path.text ||
          typeof d.lines?.text !== 'string' ||
          !Number.isSafeInteger(d.line_number) ||
          d.line_number < 1
        ) {
          return null;
        }
        const text = d.lines.text.replace(/\r?\n$/, '');
        if (text.includes('\n')) {
          return null;
        }
        matches.push({ file: d.path.text, line: String(d.line_number), content: text });
      } else if (obj.type === 'summary') {
        const count = obj.data?.stats?.matched_lines;
        if (index !== lines.length - 1 || !Number.isSafeInteger(count) || count < 0) {
          return null;
        }
        matchedLines = count;
      } else if (obj.type === 'begin' || obj.type === 'end' || obj.type === 'context') {
      } else {
        return null;
      }
    } catch (err: unknown) {
      void err;
      return null;
    }
  }

  // rg JSON 的最终 summary 才能证明流完整；坏行或缺尾部不能被转换成“全部匹配”。
  return matchedLines === dedup(matches).length ? matches : null;
}

function tryPlainFormat(raw: string): GrepMatch[] | null {
  const matches: GrepMatch[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '--') {
      continue;
    }

    const m = GREP_LINE_RE.exec(trimmed);
    if (m) {
      matches.push({
        file: m[1],
        line: m[2],
        content: m[3].trim(),
      });
    } else {
      return null;
    }
  }

  return matches;
}

function dedup(matches: GrepMatch[]): GrepMatch[] {
  const seen = new Set<string>();
  const result: GrepMatch[] = [];

  for (const m of matches) {
    const key = `${m.file}:${m.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(m);
  }

  return result;
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    // 已识别为JSON的流不能在解析失败后被另一种行正则部分接管。
    let matches = raw.trimStart().startsWith('{') ? tryJsonFormat(raw) : tryPlainFormat(raw);
    if (!matches || (matches.length === 0 && !raw.trimStart().startsWith('{'))) {
      return null;
    }

    matches = dedup(matches);
    const totalCount = matches.length;
    const files = new Set(matches.map((m) => m.file));
    const shown = Math.min(totalCount, MAX_MATCHES);
    const displayed = matches.slice(0, MAX_MATCHES);

    const parts: string[] = [`${totalCount} matches in ${files.size} files (showing ${shown})`, ''];

    for (const m of displayed) {
      parts.push(`${m.file}:${m.line}: ${m.content}`);
    }

    return parts.join('\n');
  } catch (err: unknown) {
    void err;
    return null;
  }
}
