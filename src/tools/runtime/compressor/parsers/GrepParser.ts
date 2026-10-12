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
      // 逐行格式探测：JSON.parse 失败或解析出 null 等非对象值（读 .type 抛 TypeError）都属于“格式不符”，
      // 按 null 交回原文由压缩器记 unrecognized-output；本循环之外的异常经 parseStrict 抛给压缩器记 parser-error。
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

/**
 * 严格入口：格式不符返回 null，解析器自身缺陷（异常）直接抛出。
 * 只供 OutputCompressor 使用（不经 parsers/index.ts 公开），由压缩器经 reportParserError 归类为 parser-error；
 * 解析器模块按分层契约没有运行时依赖、不能自己写日志，所以异常必须交给压缩器记录。
 */
export function parseStrict(raw: string): string | null {
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
}

/**
 * 尝试解析 raw 输出，失败返回 null。
 * 公开契约：从不抛错，内部异常同样返回 null；需要区分“格式不符”与“解析器缺陷”的调用方使用 parseStrict。
 */
export function parse(raw: string): string | null {
  try {
    return parseStrict(raw);
  } catch (err: unknown) {
    // 公开 parse* 没有诊断通道（解析器不能依赖日志模块）；经 OutputCompressor 调用时走 parseStrict，异常会被记录为 parser-error。
    void err;
    return null;
  }
}
