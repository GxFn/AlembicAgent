/**
 * @module tools/runtime/compressor/parsers/TreeParser
 * 解析 ls -R / find / tree 命令输出为紧凑缩进目录树格式。
 *
 * - 依赖、构建、编辑器目录（node_modules、dist、.vscode 等）默认过滤以压掉噪声，
 *   但被过滤的条目数必须在结尾给出提示，不能让调用方误以为它们不存在；
 *   命令参数显式指向这些名字时（如 `find dist`）调用方就是要看它们，本次不过滤。
 * - ls 长格式（权限列、'total N'、符号链接 'a -> b'）不是路径列表，按 '/' 切分会打乱行序并伪造子节点，
 *   遇到即整体交回原文。
 */

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.DS_Store',
  '.next',
  '.nuxt',
  'dist',
  'coverage',
  '.cache',
  '.turbo',
  'bower_components',
  '.idea',
  '.vscode',
]);

/** ls -l 的权限列（含 macOS 扩展属性 '@'、ACL '+'、SELinux '.' 标记）。 */
const LS_LONG_FORMAT_RE = /^[-dlcbpsD][rwxsStT-]{9}[@+.]?\s/;
const LS_TOTAL_RE = /^total \d+$/;

interface TreeNode {
  name: string;
  /** 条目自带目录标记（ls -p/-F、tree -F 的结尾 '/'，或 ls -R 的目录标题）；空目录没有子项也按目录渲染。 */
  isDir: boolean;
  children: Map<string, TreeNode>;
}

/** 一次解析的树与过滤统计；filter=false 表示命令显式指向被忽略名，本次不过滤。 */
interface ListingState {
  root: TreeNode;
  filter: boolean;
  omittedEntries: number;
  /** 触发过滤的忽略名，按首次出现顺序；只含 IGNORED_DIRS 中的固定名字，不含用户路径。 */
  omittedNames: string[];
}

/** 带命令上下文的解析结果；OutputCompressor 据此记录过滤与回退诊断。 */
export interface TreeListingResult {
  /** 压缩文本；null 表示交回 generic 原文路径。 */
  text: string | null;
  omittedEntries: number;
  omittedNames: string[];
  /** 命令显式指向被忽略名，本次关闭了过滤。 */
  filterDisabled: boolean;
}

function createState(filter: boolean): ListingState {
  return {
    root: { name: '.', isDir: true, children: new Map() },
    filter,
    omittedEntries: 0,
    omittedNames: [],
  };
}

function isLsLongFormatLine(trimmed: string): boolean {
  return LS_LONG_FORMAT_RE.test(trimmed) || LS_TOTAL_RE.test(trimmed) || trimmed.includes(' -> ');
}

/**
 * 命令参数里显式出现被忽略名（`find dist`、`-path '*\/.vscode/*'`、`tree node_modules/x`）时关闭过滤。
 * 按空白切参数、去掉引号，再按路径与列表分隔符切段比对；误判只会多显示条目，不会丢信息。
 */
function commandTargetsIgnoredName(command: string): boolean {
  const args = command.trim().split(/\s+/).slice(1);
  return args.some((arg) =>
    arg
      .replace(/["']/g, '')
      .split(/[\\/|,=]/)
      .some((segment) => IGNORED_DIRS.has(segment))
  );
}

/** 返回 parts 中第一个应被过滤的名字；过滤关闭时始终返回 undefined。 */
function ignoredNameIn(state: ListingState, parts: string[]): string | undefined {
  return state.filter ? parts.find((part) => IGNORED_DIRS.has(part)) : undefined;
}

function insertPath(root: TreeNode, parts: string[], isDir: boolean): void {
  let node = root;
  for (const part of parts) {
    if (!part) {
      return;
    }
    let child = node.children.get(part);
    if (!child) {
      child = { name: part, isDir: false, children: new Map() };
      node.children.set(part, child);
    }
    node = child;
  }
  if (isDir) {
    node.isDir = true;
  }
}

/** 记录一个条目：命中忽略名时只计数不入树，否则插入树。 */
function addEntry(state: ListingState, parts: string[], isDir: boolean): void {
  const ignored = ignoredNameIn(state, parts);
  if (ignored !== undefined) {
    state.omittedEntries++;
    if (!state.omittedNames.includes(ignored)) {
      state.omittedNames.push(ignored);
    }
    return;
  }
  insertPath(state.root, parts, isDir);
}

function renderTree(node: TreeNode, indent: number): string[] {
  const lines: string[] = [];
  const sortedChildren = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [, child] of sortedChildren) {
    const prefix = '  '.repeat(indent);
    const isDir = child.isDir || child.children.size > 0;
    lines.push(`${prefix}${child.name}${isDir ? '/' : ''}`);
    if (child.children.size > 0) {
      lines.push(...renderTree(child, indent + 1));
    }
  }

  return lines;
}

function tryTreeCommand(raw: string, filter: boolean): ListingState | null {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const treeLineRe = /^((?:│ {3}| {4})*)(?:├── |└── )(.+)$/;
  let matched = 0;
  const state = createState(filter);
  const rootName = lines[0];
  if (treeLineRe.test(rootName) || /[│├└]/.test(rootName)) {
    return null;
  }
  const pathStack: string[] = rootName === '.' ? [] : [rootName];
  const rootDepth = pathStack.length;

  for (const line of lines.slice(1)) {
    if (/^\d+ director(?:y|ies)(?:, \d+ files?)?$/.test(line.trim())) {
      continue;
    }
    const m = treeLineRe.exec(line);
    if (!m) {
      return null;
    }

    const name = m[2].trim();
    const depth = m[1].length / 4;
    if (!name || depth > pathStack.length - rootDepth) {
      return null;
    }

    matched++;

    pathStack.length = rootDepth + depth;
    pathStack.push(name.replace(/\/$/, ''));
    addEntry(state, [...pathStack], name.endsWith('/'));
  }

  return matched > 0 ? state : null;
}

function tryFindOutput(raw: string, filter: boolean): ListingState | null {
  const state = createState(filter);
  let matched = 0;

  if (!raw.includes('/')) {
    return null;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (
      trimmed !== line ||
      /^(?:find|tree|ls):|^\//.test(trimmed) ||
      /[│├└]/.test(trimmed) ||
      isLsLongFormatLine(trimmed)
    ) {
      return null;
    }

    const cleaned = trimmed.replace(/^\.\//, '');
    if (!cleaned || cleaned === '.') {
      continue;
    }

    const parts = cleaned.split('/').filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    matched++;
    addEntry(state, parts, cleaned.endsWith('/'));
  }

  return matched > 0 ? state : null;
}

function tryLsR(raw: string, filter: boolean): ListingState | null {
  const state = createState(filter);
  let currentDir = '';
  let matched = 0;

  // 单列 ls -R 的明确目录标题；普通文件名末尾的冒号不能被猜成另一层目录。
  const dirHeaderRe = /^(\.|\.\/.*|.*\/.*):$/;
  let hasHeader = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const dirMatch = dirHeaderRe.exec(trimmed);
    if (dirMatch) {
      currentDir = dirMatch[1] === '.' ? '' : dirMatch[1].replace(/^\.\//, '');
      hasHeader = true;
      matched++;
      // 目录标题是“这是目录”的事实：空目录没有子项也要保留 '/'。标题在父目录列表里已作为条目出现
      // （并已计入过滤统计），这里只标记目录、不重复计数。
      const headerParts = currentDir.split('/').filter(Boolean);
      if (headerParts.length > 0 && ignoredNameIn(state, headerParts) === undefined) {
        insertPath(state.root, headerParts, true);
      }
      continue;
    }

    if (trimmed.startsWith('total ')) {
      continue;
    }
    if (!hasHeader || /^(?:find|tree|ls):/.test(trimmed) || isLsLongFormatLine(trimmed)) {
      return null;
    }

    const parts = [...currentDir.split('/'), trimmed.replace(/\/$/, '')].filter(Boolean);
    matched++;
    addEntry(state, parts, trimmed.endsWith('/'));
  }

  return matched > 1 ? state : null;
}

function omissionNotice(state: ListingState): string {
  const noun = state.omittedEntries === 1 ? 'entry' : 'entries';
  return `(${state.omittedEntries} ${noun} under ${state.omittedNames.join(', ')} omitted)`;
}

/**
 * 按命令上下文解析目录列表：命令显式指向被忽略名时关闭过滤，被过滤条目在结尾给计数提示。
 * 供 OutputCompressor 使用；公开的 parse 等价于不带命令上下文（始终过滤）的调用。
 */
export function parseInContext(raw: string, command: string): TreeListingResult {
  const filterDisabled = commandTargetsIgnoredName(command);
  const unrecognized: TreeListingResult = {
    text: null,
    omittedEntries: 0,
    omittedNames: [],
    filterDisabled,
  };
  try {
    if (!raw || raw.trim().length === 0) {
      return unrecognized;
    }

    // 先按真实格式分派；宽泛的“树行”正则曾把 find 路径和 tree footer 当成文件。
    const filter = !filterDisabled;
    const state = /[│├└]/.test(raw)
      ? tryTreeCommand(raw, filter)
      : /^(?:\.|\.\/.*|.*\/.*):$/m.test(raw)
        ? tryLsR(raw, filter)
        : tryFindOutput(raw, filter);
    if (!state) {
      return unrecognized;
    }

    const omitted = {
      omittedEntries: state.omittedEntries,
      omittedNames: state.omittedNames,
      filterDisabled,
    };
    // 全部条目都被过滤时没有可展示的树，交回原文（统计仍返回，供调用方记录准确的回退原因）。
    const lines = state.root.children.size > 0 ? renderTree(state.root, 0) : [];
    if (lines.length === 0) {
      return { text: null, ...omitted };
    }
    if (state.omittedEntries > 0) {
      lines.push(omissionNotice(state));
    }
    return { text: lines.join('\n'), ...omitted };
  } catch (err: unknown) {
    void err;
    return unrecognized;
  }
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  return parseInContext(raw, '').text;
}
