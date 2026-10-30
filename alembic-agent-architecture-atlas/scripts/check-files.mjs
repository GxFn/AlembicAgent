/** 提交边界单源：分类源码、正典证据与本地派生物，不判断事实新鲜度或测试是否通过。 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFiles = [
  '.gitignore',
  'AGENTS.md',
  'README.md',
  'atlas.config.json',
  'biome.json',
  'index.html',
  'metadata.schema.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
];
const readerFiles = [
  'src/main.ts',
  'src/loader.ts',
  'src/model.ts',
  'src/sections.ts',
  'src/diagrams.ts',
  'src/styles.css',
];
const currentEvidence = [
  'evidence/readings.json',
  'evidence/scenarios.json',
  'evidence/execution-plan.json',
  'evidence/scoped-execution.json',
  'evidence/pilot.json',
  'evidence/scope.json',
];
export const REQUIRED_ATLAS_FILES = Object.freeze([
  ...rootFiles,
  ...readerFiles,
  ...currentEvidence,
  'docs/architecture.md',
  'docs/maintenance.md',
  'maps/README.md',
  'maps/file-index.md',
  'maps/00-diagram-standard.md',
  'scripts/atlas-lib.mjs',
  'scripts/browser-data.mjs',
  'scripts/collect.mjs',
  'scripts/evidence.mjs',
  'scripts/maintenance.mjs',
  'scripts/execution-results.mjs',
  'scripts/relations.mjs',
  'scripts/render-contract.mjs',
  'scripts/render-state.mjs',
  'scripts/snapshot-store.mjs',
  'scripts/snapshot-storage.mjs',
  'scripts/snapshot.mjs',
  'scripts/check-atlas.mjs',
  'scripts/check-files.mjs',
  'scripts/run-scoped.mjs',
  'test/file-policy.test.mjs',
  'evidence/render/current.json',
  'evidence/render/latest-attempt.json',
]);

const excludedDirectories = [
  'node_modules',
  'dist',
  '.cache',
  '.sites-runtime',
  'coverage',
  'evidence/live',
  'evidence/executions/results',
  'evidence/executions/history',
  'evidence/executions/plans',
  'evidence/ui',
];
const excludedFiles = new Set([
  'evidence/public-entrypoints.json',
  'evidence/bundle-report.json',
  'evidence/validation.json',
  'evidence/iterations/v5-v7-scope.json',
  'evidence/iterations/v6-full-scope.json',
]);
const meaning = '仅检查 Git 候选的提交边界；不证明文档事实新鲜、证据内容有效或测试已经通过。';
const validRelative = (file) =>
  typeof file === 'string' &&
  Boolean(file) &&
  !path.isAbsolute(file) &&
  !file.includes('\\') &&
  !file.includes('\0') &&
  !file.split('/').some((part) => !part || part === '.' || part === '..');

export function classifyAtlasFile(file) {
  const result = (decision, category, reason) => ({ decision, category, reason });
  if (!validRelative(file)) {
    return result('unknown', 'unknown', '路径必须是 Atlas 内的规范相对路径。');
  }
  if (
    file === 'evidence/current.json' ||
    file === 'evidence/snapshots' ||
    file.startsWith('evidence/snapshots/')
  ) {
    return result(
      'exclude',
      'local-history',
      '本地历史快照与其指针，不随 Git 提交；不删除或转换本地内容。',
    );
  }
  if (
    excludedDirectories.some((dir) => file === dir || file.startsWith(`${dir}/`)) ||
    excludedFiles.has(file) ||
    file.endsWith('.log') ||
    path.posix.basename(file) === '.DS_Store' ||
    /^evidence\/reviews\/(?:atlas-maintenance-review-|full-corrections-).+\.json$/u.test(file)
  ) {
    return result(
      'exclude',
      'local-derived',
      '本地生成物、重复导出或已合并的过程材料，不应进入提交。',
    );
  }
  if (rootFiles.includes(file)) {
    return result('keep', 'configuration', '独立包入口、依赖锁定、配置或操作规范。');
  }
  if (readerFiles.includes(file)) {
    return result('keep', 'reader', '手写阅读器源码与样式。');
  }
  if (/^scripts\/[^/]+(?:\.mjs|\.d\.mts)$/u.test(file)) {
    return result('keep', 'maintenance', '采样、校验、存储或维护命令及其类型声明。');
  }
  if (/^test\/(?:[^/]+\/)*[^/]+\.test\.(?:mjs|ts)$/u.test(file)) {
    return result('keep', 'tests', '维护行为与边界的测试源码。');
  }
  if (/^(?:maps|docs)\/(?:[^/]+\/)*[^/]+\.md$/u.test(file)) {
    return result(
      'keep',
      file.startsWith('maps/') ? 'maps' : 'documentation',
      '架构说明、图源或维护文档。',
    );
  }
  if (
    /^planning\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/u.test(file) ||
    file === 'planning/2026-10-23-assessment.json'
  ) {
    return result('keep', 'decision-history', '有日期的设计、审阅或历史评估资料。');
  }
  if (currentEvidence.includes(file)) {
    return result('keep', 'canonical-evidence', '当前阅读、执行、来源或场景的正典记录。');
  }
  if (/^evidence\/reviews\/source-[a-z0-9-]+\.json$/u.test(file)) {
    return result('keep', 'source-review', '逐文件源码审阅依据。');
  }
  if (['evidence/render/current.json', 'evidence/render/latest-attempt.json'].includes(file)) {
    return result('keep', 'render-evidence', '最近成功渲染与最近尝试分别留证。');
  }
  if (/^evidence\/iterations\/v\d+(?:-[a-z0-9]+)*-(?:scope|validation)\.json$/u.test(file)) {
    return result('keep', 'validation-history', '版本化的验证或范围记录，保留当时事实。');
  }
  if (file === 'evidence/executions/archive-index.json') {
    return result('keep', 'validation-history', '已迁出过程材料的摘要与替代证据索引。');
  }
  return result('unknown', 'unknown', '尚无提交用途声明，需审阅后明确规则。');
}

/** 纯审计可用于 fixture；缺少核心文件也失败，避免空集或误忽略变成“通过”。 */
export function auditAtlasFiles(entries, { details = false } = {}) {
  const errors = [];
  const seen = new Set();
  const present = new Set();
  const categories = new Map();
  const summary = {
    candidates: entries.length,
    bytes: 0,
    keep: 0,
    exclude: 0,
    unknown: 0,
    symlinks: 0,
  };
  const files = entries.map((entry, index) => {
    const file = entry?.path;
    const classification = classifyAtlasFile(file);
    const label = typeof file === 'string' ? file : `candidate[${index}]`;
    if (seen.has(file)) {
      errors.push(`重复候选路径: ${label}`);
    }
    seen.add(file);
    summary[classification.decision] += 1;
    if (classification.decision !== 'keep') {
      errors.push(
        `${classification.decision === 'exclude' ? '应排除' : '未声明'}: ${label} — ${classification.reason}`,
      );
    }
    const bytesValid = Number.isSafeInteger(entry?.bytes) && entry.bytes >= 0;
    if (!bytesValid) {
      errors.push(`文件字节数无效: ${label}`);
    }
    if (entry?.type === 'symlink') {
      summary.symlinks += 1;
      errors.push(`候选文件或祖先目录含 symlink: ${label}`);
    } else if (entry?.type !== 'file') {
      errors.push(`候选文件不可读取或不是普通文件: ${label} (${entry?.type ?? 'unknown'})`);
    }
    const bytes = bytesValid && entry?.type === 'file' ? entry.bytes : 0;
    if (entry?.type === 'file' && classification.decision === 'keep' && bytesValid) {
      present.add(file);
    }
    summary.bytes += bytes;
    const category = categories.get(classification.category) ?? {
      category: classification.category,
      files: 0,
      bytes: 0,
    };
    category.files += 1;
    category.bytes += bytes;
    categories.set(classification.category, category);
    return { path: file, type: entry?.type, bytes, ...classification };
  });
  for (const file of REQUIRED_ATLAS_FILES) {
    if (!present.has(file)) {
      errors.push(`核心文件缺失或未进入可提交候选: ${file}`);
    }
  }
  return {
    schemaVersion: 1,
    kind: 'atlas-commit-boundary',
    ok: errors.length === 0,
    meaning,
    summary,
    categories: [...categories.values()].sort((a, b) => a.category.localeCompare(b.category, 'en')),
    errors,
    ...(details ? { files } : {}),
  };
}

function inspectEntry(root, relative) {
  if (!validRelative(relative)) {
    return { path: relative, type: 'unavailable', bytes: 0 };
  }
  let current = root;
  const segments = relative.split('/');
  try {
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink()) {
        return { path: relative, type: 'symlink', bytes: 0 };
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        return { path: relative, type: 'other', bytes: 0 };
      }
      if (index === segments.length - 1) {
        return {
          path: relative,
          type: info.isFile() ? 'file' : 'other',
          bytes: info.isFile() ? info.size : 0,
        };
      }
    }
  } catch (error) {
    return { path: relative, type: error?.code === 'ENOENT' ? 'missing' : 'unavailable', bytes: 0 };
  }
}

export function inspectAtlasFiles(
  atlasDirectory = path.resolve(import.meta.dirname, '..'),
  options = {},
) {
  const rootInfo = fs.lstatSync(atlasDirectory);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('Atlas 根必须是普通目录，不能是 symlink。');
  }
  const atlas = fs.realpathSync(atlasDirectory);
  const git = (args, cwd) => {
    try {
      return execFileSync('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (error) {
      throw new Error('无法只读枚举 Atlas 的 Git 候选文件。', { cause: error });
    }
  };
  const repository = fs.realpathSync(git(['rev-parse', '--show-toplevel'], atlas).trim());
  const scope = path.relative(repository, atlas).split(path.sep).join('/');
  if (scope && !validRelative(scope)) {
    throw new Error('Atlas 不在所识别的 Git 根内。');
  }
  const prefix = scope ? `${scope}/` : '';
  // --cached 不能省略：已被跟踪的派生物不会因新增 .gitignore 而自行退出提交。
  const paths = git(
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--full-name',
      '-z',
      '--',
      `:(literal)${scope || '.'}`,
    ],
    repository,
  )
    .split('\0')
    .filter(Boolean);
  const relatives = [...new Set(paths)]
    .map((file) => {
      if (!file.startsWith(prefix)) {
        throw new Error('Git 返回了 Atlas 范围以外的候选。');
      }
      return file.slice(prefix.length);
    })
    .sort((a, b) => a.localeCompare(b, 'en'));
  return auditAtlasFiles(
    relatives.map((file) => inspectEntry(atlas, file)),
    options,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--details')) {
      throw new Error('Usage: node scripts/check-files.mjs [--details]；不接受其他参数。');
    }
    const report = inspectAtlasFiles(undefined, { details: args.includes('--details') });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Atlas 文件提交边界检查失败。');
    process.exitCode = 1;
  }
}
