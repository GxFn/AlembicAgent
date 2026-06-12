// Side-effect doctrine lint (P2 AD6, AlembicAgent leg): blocks the two
// machine-checkable AD0 doctrine pattern classes over src/, consuming
// config/side-effect-doctrine.json (the AD4 exhaustive exception set) —
// method precedent: the accepted Core leg (9d6abf9) and Alembic leg (c8aaefa).
//
//  A. module-scope mutable `let` bindings, EXCEPT null-initialized lazy
//     slots (`let _x: T | null = null` — the blessed lazy-singleton idiom
//     used by ModelRegistry and LLMGateway);
//  B. module-scope EMPTY `new Map()` / `new Set()` accumulators (literal-
//     seeded const lookups are immutable and unmatched by construction).
//
// Exemptions come ONLY from lintExemptions rows in the doctrine config,
// each tied to a blessedSingletons/managedModuleState entry name or an
// explicit constantClass reason — nothing implicit.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'config/side-effect-doctrine.json'), 'utf8')
);
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx']);

const LET_BINDING_RE = /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)[^\n;]*;?\s*$/gm;
const NULL_SLOT_RE = /=\s*null;?\s*$/;
const EMPTY_COLLECTION_RE =
  /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)(\s*:\s*[^=\n]+)?\s*=\s*new\s+(Map|Set)\s*(?:<[^>]*>)?\s*\(\s*\)/gm;

const exemptions = config.lintExemptions ?? [];
const knownEntryNames = new Set(
  [...(config.blessedSingletons ?? []), ...(config.managedModuleState ?? [])].map(
    (entry) => entry.name
  )
);
for (const row of exemptions) {
  for (const field of ['file', 'binding', 'reason']) {
    if (!row?.[field]) {
      process.stderr.write(
        `Doctrine lint: lintExemptions row ${JSON.stringify(row)} missing '${field}'.\n`
      );
      process.exit(1);
    }
  }
  if (!row.entry && row.constantClass !== true) {
    process.stderr.write(
      `Doctrine lint: lintExemptions row ${row.file}::${row.binding} must reference a blessed/managed entry name or declare constantClass:true.\n`
    );
    process.exit(1);
  }
  if (row.entry && !knownEntryNames.has(row.entry)) {
    process.stderr.write(
      `Doctrine lint: lintExemptions row ${row.file}::${row.binding} references unknown entry '${row.entry}'.\n`
    );
    process.exit(1);
  }
}
const exempt = new Set(exemptions.map((row) => `${row.file}::${row.binding}`));

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(absolute, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

const violations = [];
let scanned = 0;
for (const absolute of collectFiles(path.join(REPO_ROOT, 'src'))) {
  const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
  const content = readFileSync(absolute, 'utf8');
  scanned += 1;

  for (const match of content.matchAll(LET_BINDING_RE)) {
    const binding = match[1];
    if (NULL_SLOT_RE.test(match[0].trimEnd())) {
      continue; // null-initialized lazy slot (blessed lazy-singleton idiom)
    }
    if (exempt.has(`${relative}::${binding}`)) {
      continue;
    }
    violations.push(
      `${relative}:${lineAt(content, match.index)} module-scope mutable 'let ${binding}' outside the null-slot idiom — use a managed lifecycle or add a lintExemptions row tied to a blessed/managed entry`
    );
  }

  for (const match of content.matchAll(EMPTY_COLLECTION_RE)) {
    const binding = match[1];
    if (exempt.has(`${relative}::${binding}`)) {
      continue;
    }
    violations.push(
      `${relative}:${lineAt(content, match.index)} module-scope empty new ${match[3]}() accumulator '${binding}' — bounded blessed caches need a lintExemptions row; everything else needs a managed lifecycle`
    );
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Doctrine lint failed: ${violations.length} violation(s) across ${scanned} files.\n`
  );
  for (const violation of violations) {
    process.stderr.write(`- ${violation}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `Doctrine lint OK: ${scanned} src files clean (null-slot idiom honored; ${exempt.size} exemptions consumed from config/side-effect-doctrine.json).\n`
);
