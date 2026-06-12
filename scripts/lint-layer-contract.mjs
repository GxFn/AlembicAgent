// Dependency-direction lint (P2 AD3, AlembicAgent leg): enforces the internal
// layer contract over src/ top-level areas via config/layer-contract.json as
// a blocking step in `npm run check` — the Core CO2 pattern, following the
// accepted Alembic-leg method (as-is graph derived FIRST via --report, then
// codified; redesigns go through controller-decided waves).
//
// Agent delta vs the Core script: src/ files import each other through BOTH
// relative specifiers and the package.json '#alias/*' subpath imports
// (#agent/#ai/#shared/#tools, 78 alias edges in the as-is census); the lint
// resolves both, otherwise alias edges would be invisible and the contract
// dishonest. `--report` prints the observed cross-area runtime edge matrix
// (the as-is graph the contract was derived from) and exits 0.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config/layer-contract.json');
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx']);

// Statement-level matchers (kept aligned with the Core CO2 lint).
const FROM_IMPORT_RE = /\b(import|export)\s+(type\s+)?[^;'"]*?from\s*['"]([.#][^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([.#][^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+['"]([.#][^'"]+)['"]/g;

// '#alias/*' → src/<area>/* per package.json imports (alembic-dev condition).
const ALIAS_TO_AREA = {
  '#agent': 'agent',
  '#ai': 'ai',
  '#shared': 'shared',
  '#tools': 'tools',
};

function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (config.schemaVersion !== 1 || !config.allowedRuntimeImports) {
    throw new Error(
      'config/layer-contract.json must have schemaVersion 1 and allowedRuntimeImports'
    );
  }
  return config;
}

function areaOf(relativePath) {
  const segments = relativePath.split('/');
  if (segments[0] !== 'src') {
    return undefined;
  }
  return segments.length === 2 ? 'root' : segments[1];
}

function areaOfSpecifier(specifier, fromRelativeFile) {
  if (specifier.startsWith('#')) {
    const aliasRoot = specifier.split('/')[0];
    return ALIAS_TO_AREA[aliasRoot];
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromRelativeFile), specifier)
  );
  return areaOf(resolved);
}

function collectSourceFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolute, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function collectImports(content) {
  const imports = [];
  for (const match of content.matchAll(FROM_IMPORT_RE)) {
    imports.push({ index: match.index, specifier: match[3], typeOnly: Boolean(match[2]) });
  }
  for (const match of content.matchAll(DYNAMIC_IMPORT_RE)) {
    imports.push({ index: match.index, specifier: match[1], typeOnly: false });
  }
  for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    imports.push({ index: match.index, specifier: match[1], typeOnly: false });
  }
  return imports;
}

function main() {
  const reportMode = process.argv.includes('--report');
  // Report mode derives the as-is graph and must work before the contract
  // file exists (it is how the contract gets authored in the first place).
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!reportMode) {
      throw error;
    }
    config = { allowedRuntimeImports: {}, typeOnlyImportsExempt: true };
  }
  const blessedByFile = new Map(
    (config.blessedImports ?? []).map((entry) => [`${entry.file}->${entry.to}`, entry])
  );
  const violations = [];
  const edgeCounts = new Map();
  let runtimeEdges = 0;
  let typeOnlyEdges = 0;

  for (const absolute of collectSourceFiles(path.join(REPO_ROOT, 'src'))) {
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    const fromArea = areaOf(relative);
    if (!fromArea) {
      continue;
    }
    if (!reportMode && !(fromArea in config.allowedRuntimeImports)) {
      violations.push({
        file: relative,
        line: 1,
        message: `area "${fromArea}" is not declared in config/layer-contract.json`,
      });
      continue;
    }

    const content = readFileSync(absolute, 'utf8');
    for (const found of collectImports(content)) {
      const toArea = areaOfSpecifier(found.specifier, relative);
      if (!toArea || toArea === fromArea) {
        continue;
      }
      // A resolved target outside the declared area census can only come from
      // a docblock/string artifact the statement regexes matched (e.g. an
      // example import path in a comment) — real new areas are caught on the
      // FROM side by the area-declaration check above.
      if (
        Array.isArray(config.areas) &&
        config.areas.length > 0 &&
        !config.areas.includes(toArea)
      ) {
        continue;
      }

      if (found.typeOnly && config.typeOnlyImportsExempt) {
        typeOnlyEdges += 1;
        continue;
      }
      runtimeEdges += 1;
      const key = `${fromArea} -> ${toArea}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);

      if (reportMode) {
        continue;
      }
      const allowed = config.allowedRuntimeImports[fromArea];
      if (allowed.includes('*') || allowed.includes(toArea)) {
        continue;
      }
      if (blessedByFile.has(`${relative}->${toArea}`)) {
        continue;
      }
      violations.push({
        file: relative,
        line: lineAt(content, found.index),
        message: `runtime import ${fromArea} -> ${toArea} (${found.specifier}) violates the layer contract`,
      });
    }
  }

  if (reportMode) {
    process.stdout.write('Observed cross-area runtime edges (as-is graph):\n');
    for (const [edge, count] of [...edgeCounts.entries()].sort()) {
      process.stdout.write(`  ${edge}: ${count}\n`);
    }
    process.stdout.write(
      `Total: ${runtimeEdges} runtime edges, ${typeOnlyEdges} type-only bridges.\n`
    );
    return;
  }

  if (violations.length > 0) {
    process.stderr.write(`Layer contract failed: ${violations.length} violation(s).\n`);
    for (const violation of violations) {
      process.stderr.write(`- ${violation.file}:${violation.line} ${violation.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Layer contract OK: ${runtimeEdges} cross-area runtime imports within the allowed matrix; ${typeOnlyEdges} type-only bridges exempt.\n`
  );
}

main();
