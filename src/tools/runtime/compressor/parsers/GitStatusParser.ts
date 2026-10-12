/**
 * @module tools/runtime/compressor/parsers/GitStatusParser
 * 解析 git status 命令输出为紧凑结构化格式。
 *
 * porcelain（--short/--porcelain）与默认人类可读格式共用同一套分桶语义（bucketFor），
 * 并共用“无法完整表达就返回 null”的守卫：任一行无法归入桶、或最终没有任何文件条目时，
 * 解析器返回 null，由 OutputCompressor 记录 unrecognized-output 并回退原文，
 * 避免把删除报成修改、把 intent-to-add 静默丢掉或产出空摘要。
 */

const PORCELAIN_RE = /^([MADRCTU?! ]{2})\s+(.+)$/;
const PORCELAIN_CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const HUMAN_ENTRY_RE = /^(new file|modified|deleted|renamed|copied|typechange):\s*(.+)$/;
/** 'Your branch and X have diverged,' 的第二行是不缩进的续行，属于同一条分支信息。 */
const DIVERGED_CONTINUATION_RE = /^and have \d+ and \d+ different commits? each, respectively\.$/;

interface StatusBuckets {
  conflicted: string[];
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
  renamed: string[];
  copied: string[];
  typechanged: string[];
  intentToAdd: string[];
  ignored: string[];
}

/** 一次解析的结果：文件桶加上原样保留的分支信息片段。 */
interface StatusSummary {
  buckets: StatusBuckets;
  branch: string[];
}

/** 变更类型；porcelain 的 X/Y 字符与人类可读格式的关键字都先归一到这里。 */
type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechanged';
/** index 对应 porcelain X 列与 'Changes to be committed'；worktree 对应 Y 列与 'Changes not staged'。 */
type ChangeArea = 'index' | 'worktree';
type FileBucket = Exclude<keyof StatusBuckets, 'conflicted' | 'untracked' | 'ignored'>;

const PORCELAIN_KINDS: Readonly<Record<string, ChangeKind>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechanged',
};

const HUMAN_KINDS: Readonly<Record<string, ChangeKind>> = {
  'new file': 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  typechange: 'typechanged',
};

function createBuckets(): StatusBuckets {
  return {
    conflicted: [],
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    renamed: [],
    copied: [],
    typechanged: [],
    intentToAdd: [],
    ignored: [],
  };
}

/**
 * 两种格式共用的分桶规则。
 * - index 区：新增与修改都只是“已暂存”，删除/重命名/复制/类型变更进各自的桶。
 * - worktree 区：修改进 modified；新增只可能是 `git add -N` 的 intent-to-add
 *   （porcelain ' A'，人类格式在 'Changes not staged' 下显示为 'new file:'），单独成桶，
 *   不能混入 staged（并未真正暂存内容）或 untracked（已在索引中占位）。
 */
function bucketFor(kind: ChangeKind, area: ChangeArea): FileBucket {
  if (kind === 'added') {
    return area === 'index' ? 'staged' : 'intentToAdd';
  }
  if (kind === 'modified') {
    return area === 'index' ? 'staged' : 'modified';
  }
  return kind;
}

/** porcelain 分支头 '## <branch>...<upstream> [ahead N]' 原样保留在 branch 行。 */
function parsePorcelain(lines: string[]): StatusSummary | null {
  const buckets = createBuckets();
  const branch: string[] = [];
  let matched = 0;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch.push(line.slice(3).trim());
      continue;
    }
    const m = PORCELAIN_RE.exec(line);
    if (!m || m[1] === '  ') {
      return null;
    }
    matched++;
    const [idx, wt] = [m[1][0], m[1][1]];
    const file = m[2].trim();

    if (PORCELAIN_CONFLICTS.has(m[1])) {
      buckets.conflicted.push(file);
    } else if (m[1] === '??') {
      buckets.untracked.push(file);
    } else if (m[1] === '!!') {
      buckets.ignored.push(file);
    } else if (/[?!U]/.test(m[1])) {
      return null;
    } else {
      let placed = false;
      for (const [code, area] of [
        [idx, 'index'],
        [wt, 'worktree'],
      ] as const) {
        if (code === ' ') {
          continue;
        }
        const kind = PORCELAIN_KINDS[code];
        if (!kind) {
          // 字符集已由 PORCELAIN_RE 限定；这里仍兜底，未知列值不能被静默丢弃。
          return null;
        }
        buckets[bucketFor(kind, area)].push(file);
        placed = true;
      }
      if (!placed) {
        return null;
      }
    }
  }

  return matched > 0 ? { buckets, branch } : null;
}

/**
 * 人类可读格式：按 section 判断 index/worktree 区，按行内关键字判断变更类型。
 * 'On branch'/'HEAD detached'/'Your branch' 作为分支信息保留；
 * 冲突段（Unmerged paths）伴随合并/变基状态提示，直接回退原文而不是只摘文件。
 */
function parseHumanReadable(raw: string): StatusSummary | null {
  const buckets = createBuckets();
  const branch: string[] = [];

  let section: ChangeArea | 'untracked' | 'ignored' | null = null;
  let matched = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Changes to be committed')) {
      section = 'index';
    } else if (trimmed.startsWith('Changes not staged')) {
      section = 'worktree';
    } else if (trimmed.startsWith('Untracked files')) {
      section = 'untracked';
    } else if (trimmed.startsWith('Ignored files')) {
      section = 'ignored';
    } else if (trimmed.startsWith('Unmerged paths')) {
      return null;
    } else if (trimmed === '' || trimmed.startsWith('(use ')) {
      // 空行与 git 的操作提示行不携带文件或分支事实，直接跳过。
    } else if (!/^\s/.test(line)) {
      // 分支信息保留；footer 不是文件；不认识的整行不能从部分摘要中静默消失。
      const onBranch = /^On branch (.+)$/.exec(trimmed);
      if (onBranch) {
        branch.push(onBranch[1]);
      } else if (/^(?:HEAD detached (?:at|from) |Your branch )/.test(trimmed)) {
        branch.push(trimmed);
      } else if (DIVERGED_CONTINUATION_RE.test(trimmed) && branch.length > 0) {
        branch[branch.length - 1] = `${branch[branch.length - 1]} ${trimmed}`;
      } else if (!/^(?:nothing |no changes added )/.test(trimmed)) {
        return null;
      }
      section = null;
    } else if (section === 'untracked' || section === 'ignored') {
      matched++;
      buckets[section].push(trimmed);
    } else if (section) {
      const entry = HUMAN_ENTRY_RE.exec(trimmed);
      const kind = entry ? HUMAN_KINDS[entry[1]] : undefined;
      if (!entry || !kind) {
        return null;
      }
      matched++;
      buckets[bucketFor(kind, section)].push(entry[2].trim());
    } else {
      // section 之外的缩进行既不是提示也不是文件条目，无法分桶就整体回退原文。
      return null;
    }
  }

  return matched > 0 ? { buckets, branch } : null;
}

/** 没有任何文件条目时返回 null，不能把空摘要当成“工作区干净”交给模型。 */
function formatSummary({ buckets, branch }: StatusSummary): string | null {
  const parts: string[] = [];
  const entries: [string, string[]][] = [
    ['conflicted', buckets.conflicted],
    ['staged', buckets.staged],
    ['modified', buckets.modified],
    ['deleted', buckets.deleted],
    ['renamed', buckets.renamed],
    ['intent-to-add', buckets.intentToAdd],
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

  if (parts.length === 0) {
    return null;
  }
  if (branch.length > 0) {
    parts.unshift(`branch: ${branch.join('; ')}`);
  }
  return parts.join('\n');
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
  if (raw.includes('\0')) {
    return null;
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);

  const porcelain = parsePorcelain(lines);
  if (porcelain) {
    return formatSummary(porcelain);
  }

  const human = parseHumanReadable(raw);
  if (human) {
    return formatSummary(human);
  }

  return null;
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
