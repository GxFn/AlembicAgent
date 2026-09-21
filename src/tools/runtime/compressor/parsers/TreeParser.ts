/**
 * @module tools/runtime/compressor/parsers/TreeParser
 * 解析 ls -R / find / tree 命令输出为紧凑缩进目录树格式。
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

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
}

function shouldIgnore(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function insertPath(root: TreeNode, parts: string[]): void {
  let node = root;
  for (const part of parts) {
    if (!part || shouldIgnore(part)) {
      return;
    }
    if (!node.children.has(part)) {
      node.children.set(part, { name: part, children: new Map() });
    }
    const child = node.children.get(part);
    if (!child) {
      return;
    }
    node = child;
  }
}

function renderTree(node: TreeNode, indent: number): string[] {
  const lines: string[] = [];
  const sortedChildren = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [, child] of sortedChildren) {
    const prefix = '  '.repeat(indent);
    const isDir = child.children.size > 0;
    lines.push(`${prefix}${child.name}${isDir ? '/' : ''}`);
    if (isDir) {
      lines.push(...renderTree(child, indent + 1));
    }
  }

  return lines;
}

function tryTreeCommand(raw: string): TreeNode | null {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const treeLineRe = /^((?:│ {3}| {4})*)(?:├── |└── )(.+)$/;
  let matched = 0;
  const root: TreeNode = { name: '.', children: new Map() };
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
    insertPath(root, pathStack);
  }

  return matched > 0 ? root : null;
}

function tryFindOutput(raw: string): TreeNode | null {
  const root: TreeNode = { name: '.', children: new Map() };
  let matched = 0;

  if (!raw.includes('/')) {
    return null;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed !== line || /^(?:find|tree|ls):|^\//.test(trimmed) || /[│├└]/.test(trimmed)) {
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

    if (parts.some((p) => shouldIgnore(p))) {
      continue;
    }

    matched++;
    insertPath(root, parts);
  }

  return matched > 0 ? root : null;
}

function tryLsR(raw: string): TreeNode | null {
  const root: TreeNode = { name: '.', children: new Map() };
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
      continue;
    }

    if (trimmed.startsWith('total ')) {
      continue;
    }
    if (!hasHeader || /^(?:find|tree|ls):/.test(trimmed)) {
      return null;
    }

    const parts = currentDir ? [...currentDir.split('/'), trimmed] : [trimmed];

    if (parts.some((p) => shouldIgnore(p))) {
      continue;
    }
    matched++;
    insertPath(root, parts.filter(Boolean));
  }

  return matched > 1 ? root : null;
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    // 先按真实格式分派；宽泛的“树行”正则曾把 find 路径和 tree footer 当成文件。
    const root = /[│├└]/.test(raw)
      ? tryTreeCommand(raw)
      : /^(?:\.|\.\/.*|.*\/.*):$/m.test(raw)
        ? tryLsR(raw)
        : tryFindOutput(raw);

    if (!root || root.children.size === 0) {
      return null;
    }

    const lines = renderTree(root, 0);
    if (lines.length === 0) {
      return null;
    }

    return lines.join('\n');
  } catch (err: unknown) {
    void err;
    return null;
  }
}
