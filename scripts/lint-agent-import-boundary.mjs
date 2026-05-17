import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const scanRoots = ['src', 'lib', 'bin', 'config', 'scripts', 'test'];
const fileExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

const bannedImportRules = [
  {
    reason: 'Plugin implementation is read-only reference material for AlembicAgent',
    test: (specifier) =>
      specifier === '@alembic/plugin' ||
      specifier.startsWith('@alembic/plugin/') ||
      specifier.includes('AlembicPlugin'),
  },
  {
    reason: 'Codex delivery stays in AlembicPlugin',
    test: (specifier) =>
      specifier.startsWith('#codex/') ||
      specifier.includes('/codex/') ||
      specifier.includes('\\codex\\'),
  },
  {
    reason: 'MCP handlers and schemas stay in host/plugin adapters',
    test: (specifier) =>
      specifier.startsWith('#external/mcp') ||
      specifier.includes('/external/mcp') ||
      specifier.includes('\\external\\mcp'),
  },
  {
    reason: 'Plugin channels and marketplace delivery stay outside AlembicAgent',
    test: (specifier) =>
      specifier.includes('/channels/') ||
      specifier.includes('\\channels\\') ||
      specifier.includes('/plugins/') ||
      specifier.includes('\\plugins\\') ||
      specifier.includes('/marketplace/') ||
      specifier.includes('\\marketplace\\'),
  },
  {
    reason: 'Codex Skill delivery text stays in AlembicPlugin',
    test: (specifier) =>
      specifier.includes('/skills/') ||
      specifier.includes('\\skills\\') ||
      specifier.includes('/injectable-skills/') ||
      specifier.includes('\\injectable-skills\\'),
  },
];

const bannedPathRules = [
  {
    reason: 'Codex implementation directories belong to AlembicPlugin',
    test: (relativePath) => /(^|\/)(codex|channels|plugins|marketplace)(\/|$)/u.test(relativePath),
  },
  {
    reason: 'MCP delivery directories belong to host/plugin adapters',
    test: (relativePath) => /(^|\/)external\/mcp(\/|$)/u.test(relativePath),
  },
  {
    reason: 'Skill delivery directories belong to AlembicPlugin',
    test: (relativePath) => /(^|\/)(skills|injectable-skills)(\/|$)/u.test(relativePath),
  },
];

const importPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu;

async function exists(directory) {
  try {
    await stat(directory);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

async function collectFiles(directory) {
  if (!(await exists(directory))) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
        continue;
      }
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && fileExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function findImportViolations(relativePath, sourceText) {
  const violations = [];
  let match;

  while ((match = importPattern.exec(sourceText))) {
    const specifier = match[1] ?? match[2];

    for (const rule of bannedImportRules) {
      if (rule.test(specifier)) {
        violations.push({
          file: relativePath,
          specifier,
          reason: rule.reason,
        });
      }
    }
  }

  return violations;
}

const files = (
  await Promise.all(scanRoots.map((root) => collectFiles(path.join(repoRoot, root))))
).flat();

const violations = [];

for (const file of files) {
  const relativePath = normalizePath(file);

  for (const rule of bannedPathRules) {
    if (rule.test(relativePath)) {
      violations.push({
        file: relativePath,
        specifier: '<file path>',
        reason: rule.reason,
      });
    }
  }

  const sourceText = await readFile(file, 'utf8');
  violations.push(...findImportViolations(relativePath, sourceText));
}

if (violations.length > 0) {
  console.error('AlembicAgent import boundary violations found:');
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.specifier} (${violation.reason})`);
  }
  process.exitCode = 1;
} else {
  console.warn('AlembicAgent import boundary check passed.');
}
