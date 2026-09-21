/**
 * @module tools/runtime/compressor/parsers/GitStatusParser
 * 解析 git status 命令输出为紧凑结构化格式。
 */

const PORCELAIN_RE = /^([MADRCTU?! ]{2})\s+(.+)$/;

interface StatusBuckets {
  conflicted: string[];
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
  renamed: string[];
  copied: string[];
  typechanged: string[];
  ignored: string[];
}

function parsePorcelain(lines: string[]): StatusBuckets | null {
  const buckets: StatusBuckets = {
    conflicted: [],
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    renamed: [],
    copied: [],
    typechanged: [],
    ignored: [],
  };
  let matched = 0;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      continue;
    }
    const m = PORCELAIN_RE.exec(line);
    if (!m || m[1] === '  ') {
      return null;
    }
    matched++;
    const [idx, wt] = [m[1][0], m[1][1]];
    const file = m[2].trim();

    if (new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(m[1])) {
      buckets.conflicted.push(file);
    } else if (m[1] === '??') {
      buckets.untracked.push(file);
    } else if (m[1] === '!!') {
      buckets.ignored.push(file);
    } else if (/[?!U]/.test(m[1])) {
      return null;
    } else {
      if (idx === 'A') {
        buckets.staged.push(file);
      } else if (idx === 'D') {
        buckets.deleted.push(file);
      } else if (idx === 'R') {
        buckets.renamed.push(file);
      } else if (idx === 'M') {
        buckets.staged.push(file);
      } else if (idx === 'C') {
        buckets.copied.push(file);
      } else if (idx === 'T') {
        buckets.typechanged.push(file);
      }

      if (wt === 'M') {
        buckets.modified.push(file);
      } else if (wt === 'D') {
        buckets.deleted.push(file);
      } else if (wt === 'T') {
        buckets.typechanged.push(file);
      } else if (wt === 'C') {
        buckets.copied.push(file);
      } else if (wt === 'R') {
        buckets.renamed.push(file);
      }
    }
  }

  return matched > 0 ? buckets : null;
}

function parseHumanReadable(raw: string): StatusBuckets | null {
  const buckets: StatusBuckets = {
    conflicted: [],
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    renamed: [],
    copied: [],
    typechanged: [],
    ignored: [],
  };

  let section: 'staged' | 'modified' | 'untracked' | 'ignored' | null = null;
  let matched = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Changes to be committed')) {
      section = 'staged';
    } else if (trimmed.startsWith('Changes not staged')) {
      section = 'modified';
    } else if (trimmed.startsWith('Untracked files')) {
      section = 'untracked';
    } else if (trimmed.startsWith('Ignored files')) {
      section = 'ignored';
    } else if (trimmed === '' || trimmed.startsWith('(use ')) {
    } else if (!/^\s/.test(line)) {
      // footer/branch 文本不是文件；不认识的整行不能从部分摘要中静默消失。
      if (
        !/^(?:On branch |Your branch |nothing |no changes added |Changes not staged)/.test(trimmed)
      ) {
        return null;
      }
      section = null;
    } else if (section) {
      const fileMatch =
        section === 'untracked' || section === 'ignored'
          ? [trimmed, trimmed]
          : trimmed.match(/^(?:new file|modified|deleted|renamed|copied|typechange):\s*(.+)$/);
      if (fileMatch) {
        matched++;
        const file = fileMatch[1].trim();
        if (section === 'staged') {
          buckets.staged.push(file);
        } else if (section === 'modified') {
          buckets.modified.push(file);
        } else if (section === 'untracked') {
          buckets.untracked.push(file);
        } else {
          buckets.ignored.push(file);
        }
      } else {
        return null;
      }
    }
  }

  return matched > 0 ? buckets : null;
}

function formatBuckets(buckets: StatusBuckets): string {
  const parts: string[] = [];
  const entries: [string, string[]][] = [
    ['conflicted', buckets.conflicted],
    ['staged', buckets.staged],
    ['modified', buckets.modified],
    ['deleted', buckets.deleted],
    ['renamed', buckets.renamed],
    ['untracked', buckets.untracked],
    ['copied', buckets.copied],
    ['typechanged', buckets.typechanged],
    ['ignored', buckets.ignored],
  ];

  for (const [label, files] of entries) {
    if (files.length > 0) {
      const distinct = [...new Set(files)];
      parts.push(`${label}(${distinct.length}): ${distinct.join(', ')}`);
    }
  }

  return parts.join('\n');
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }
    if (raw.includes('\0')) {
      return null;
    }

    const lines = raw.split('\n').filter((l) => l.length > 0);

    const porcelain = parsePorcelain(lines);
    if (porcelain) {
      return formatBuckets(porcelain);
    }

    const human = parseHumanReadable(raw);
    if (human) {
      return formatBuckets(human);
    }

    return null;
  } catch (err: unknown) {
    void err;
    return null;
  }
}
