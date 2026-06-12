// Space allowed-edge gate, AlembicAgent consumer side (P2 AD1 pA3).
//
// Loads the canonical space DAG config OWNED BY AlembicCore strictly read-only
// through the existing file: dependency link
// (node_modules/@alembic/core/config/space-allowed-edges.json), falling back to
// the sibling checkout path; the config is never copied or forked. Verifies
// AlembicAgent's OWN entry only, per the config consumerContract:
//  1. Manifest edges — the space-package set declared across dependencies/
//     devDependencies/optionalDependencies (including file:.. sibling links)
//     equals exactly allowedDependencies plus alembicAgent-scoped allowlist
//     entries.
//  2. Source edges — no import statement in src/test/scripts resolves to a
//     space package outside allowedDependencies. Specifier-level facade depth
//     stays with lint:core-import-boundary; this gate asserts the SPACE-level
//     edge set. Self-name references are data, not edges.
//  3. Exact-edge allowlist integrity for entries scoped to alembicAgent.
//  4. Toolchain floor — the running node plus installed tsc/biome/vitest meet
//     the recorded space floor, and the manifest engines.node states the floor
//     fact. Floors record current facts; the drift rule lives in the config.
//
// Choice note: this is a new dedicated gate mirroring AlembicCore's
// scripts/check-space-edges.mjs instead of an extension of
// lint-agent-import-boundary.mjs — that lint owns hardcoded Plugin/MCP/Codex
// hygiene rules, while this gate must stay a pure projection of the canonical
// config. The import-statement pattern is reused from that lint so config and
// test data strings cannot false-positive as edges.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_REPO_KEY = 'alembicAgent';
const SOURCE_SCAN_ROOTS = ['src', 'test', 'scripts'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
// Same statement shapes as lint-agent-import-boundary.mjs: static import/export
// ... from, side-effect import, and dynamic import(); multi-line imports are
// covered because the specifier always sits on the from-line.
const IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function loadCanonicalConfig() {
  const candidates = [
    path.join(repoRoot, 'node_modules/@alembic/core/config/space-allowed-edges.json'),
    path.join(repoRoot, '../AlembicCore/config/space-allowed-edges.json'),
  ];
  for (const candidate of candidates) {
    try {
      return { config: readJson(candidate), configPath: candidate };
    } catch {
      // try the next access route from the consumerContract
    }
  }
  process.stderr.write(
    'Space-edge gate: canonical config space-allowed-edges.json is unreachable through the Core link or sibling path.\n'
  );
  process.exit(1);
}

const { config, configPath } = loadCanonicalConfig();
const pkg = readJson(path.join(repoRoot, 'package.json'));
const failures = [];

const selfEntry = config.repos?.[SELF_REPO_KEY];
if (!selfEntry) {
  process.stderr.write(`Space-edge gate: config has no ${SELF_REPO_KEY} entry.\n`);
  process.exit(1);
}
if (pkg.name !== selfEntry.packageName) {
  failures.push(
    `package.json name '${pkg.name}' does not match the config's ${SELF_REPO_KEY}.packageName '${selfEntry.packageName}'`
  );
}

// 3. allowlist integrity (validated first so edge checks can consult it)
const allowlist = Array.isArray(config.exactEdgeAllowlist) ? config.exactEdgeAllowlist : [];
for (const entry of allowlist) {
  for (const field of ['repo', 'dependency', 'owner', 'reason', 'cleanupTrigger']) {
    if (!entry?.[field]) {
      failures.push(
        `exactEdgeAllowlist entry ${JSON.stringify(entry)} is missing required field '${field}'`
      );
    }
  }
}
const selfAllowlisted = new Set(
  allowlist.filter((entry) => entry.repo === SELF_REPO_KEY).map((entry) => entry.dependency)
);

const allowed = new Set(selfEntry.allowedDependencies ?? []);
const spacePackageNames = new Set(
  Object.values(config.repos ?? {})
    .map((repo) => repo?.packageName)
    .filter((name) => typeof name === 'string')
);

// 1. manifest edges — exact equality in both directions
const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
const declaredSpaceEdges = new Set();
for (const [name, version] of Object.entries(declared)) {
  const isSpacePackage = spacePackageNames.has(name) || name.startsWith('@alembic/');
  const isSiblingLink = typeof version === 'string' && version.startsWith('file:..');
  if (isSpacePackage || isSiblingLink) {
    declaredSpaceEdges.add(name);
    if (!allowed.has(name) && !selfAllowlisted.has(name)) {
      failures.push(
        `package.json declares space edge '${name}: ${version}' but ${SELF_REPO_KEY}.allowedDependencies is [${[...allowed].join(', ')}]`
      );
    }
  }
}
for (const name of allowed) {
  if (!declaredSpaceEdges.has(name)) {
    failures.push(
      `allowedDependencies lists '${name}' but package.json declares no such space edge — the manifest edge set must equal the config exactly`
    );
  }
}

// 2. source edges (space-level; depth-level stays with lint:core-import-boundary)
function collectFiles(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
        continue;
      }
      collectFiles(absolute, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function packageNameOf(specifier) {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

let scannedFiles = 0;
for (const scanRoot of SOURCE_SCAN_ROOTS) {
  for (const file of collectFiles(path.join(repoRoot, scanRoot))) {
    scannedFiles += 1;
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      const packageName = packageNameOf(specifier);
      const isSpacePackage =
        spacePackageNames.has(packageName) || packageName.startsWith('@alembic/');
      const isSelf = packageName === selfEntry.packageName;
      if (
        isSpacePackage &&
        !isSelf &&
        !allowed.has(packageName) &&
        !selfAllowlisted.has(packageName)
      ) {
        const line = content.slice(0, match.index).split('\n').length;
        failures.push(
          `${path.relative(repoRoot, file)}:${line} imports space package '${specifier}' outside the allowed edge set [${[...allowed].join(', ')}]`
        );
      }
    }
  }
}

// 4. toolchain floor
const floor = config.toolchainFloor ?? {};
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeFloorMajor = Number((floor.node ?? '>=0').replace(/[^0-9.]/g, '').split('.')[0]);
if (nodeMajor < nodeFloorMajor) {
  failures.push(
    `toolchain floor: node ${process.versions.node} is below the space floor ${floor.node} — see the toolchainFloor drift rule`
  );
}
if (pkg.engines?.node !== floor.node) {
  failures.push(
    `toolchain floor: manifest engines.node '${pkg.engines?.node ?? 'MISSING'}' does not state the space floor fact '${floor.node}'`
  );
}
function installedVersion(name) {
  try {
    return readJson(path.join(repoRoot, 'node_modules', name, 'package.json')).version;
  } catch {
    return null;
  }
}
const tsVersion = installedVersion('typescript');
if (!tsVersion || !tsVersion.startsWith('5.9.')) {
  failures.push(
    `toolchain floor: typescript ${tsVersion ?? 'MISSING'} does not satisfy the space floor ${floor.typescript}`
  );
}
const biomeVersion = installedVersion('@biomejs/biome');
if (!biomeVersion || biomeVersion !== floor.biome) {
  failures.push(
    `toolchain floor: biome ${biomeVersion ?? 'MISSING'} does not match the pinned space floor ${floor.biome}`
  );
}
const vitestVersion = installedVersion('vitest');
if (!vitestVersion || Number(vitestVersion.split('.')[0]) < 4) {
  failures.push(
    `toolchain floor: vitest ${vitestVersion ?? 'MISSING'} is below the space floor ${floor.vitest}`
  );
}

if (failures.length > 0) {
  process.stderr.write(`Space-edge gate failed: ${failures.length} issue(s).\n`);
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `Space-edge gate OK: ${pkg.name} space edges equal [${[...allowed].join(', ')}] (config: ${path.relative(repoRoot, configPath)}), source scan clean across ${SOURCE_SCAN_ROOTS.join('/')} (${scannedFiles} files), toolchain floor met (node ${process.versions.node}, tsc ${tsVersion}, biome ${biomeVersion}, vitest ${vitestVersion}).\n`
);
