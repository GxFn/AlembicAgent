import fs from 'node:fs';
import path from 'node:path';
import { atlasRoot, loadAtlas, repositoryRoot, validateDocument } from './atlas-lib.mjs';
import { scopedExecutionCurrentErrors } from './evidence.mjs';
import { embeddedEvidenceKey } from './relations.mjs';

const index = process.argv.indexOf('--topic');
const selected = index >= 0 ? process.argv[index + 1] : null;
const catalog = loadAtlas();
const docs = selected
  ? catalog.documents.filter((d) => d.metadata.topic === selected)
  : catalog.documents;
const errors = [...catalog.evidenceDiagnostics];
if (process.argv.includes('--require-current') && catalog.pilotFreshness !== 'matched') {
  errors.push(`Pilot evidence is not current: ${catalog.pilotFreshness}`);
}
if (!docs.length) {
  errors.push('No documents in validation scope');
}
if (process.argv.includes('--require-current')) {
  errors.push(...scopedExecutionCurrentErrors(catalog.scopedRuns));
}
const ids = new Set();
for (const doc of docs) {
  if (ids.has(doc.id)) {
    errors.push(`Duplicate document id: ${doc.id}`);
  }
  ids.add(doc.id);
  const result = validateDocument(doc, repositoryRoot, catalog.inventory, {
    requireCurrent: process.argv.includes('--require-current'),
    dirtyPaths: catalog.git.dirtyPaths,
  });
  for (const error of result.errors) {
    errors.push(`${doc.path}: ${error}`);
  }
  for (const match of doc.body.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0];
    if (!target || /^https?:/u.test(target)) {
      continue;
    }
    if (/^[a-z]+:/iu.test(target)) {
      errors.push(`${doc.path}: unsupported link scheme`);
      continue;
    }
    const resolved = path.resolve(atlasRoot, path.dirname(doc.path), target);
    if (!resolved.startsWith(atlasRoot + path.sep)) {
      errors.push(`${doc.path}: missing/outside-atlas link ${target}`);
      continue;
    }
    const embedded = embeddedEvidenceKey(
      path.relative(atlasRoot, resolved).split(path.sep).join('/'),
    );
    if (embedded) {
      if (catalog[embedded] == null) {
        errors.push(`${doc.path}: embedded evidence unavailable ${target}`);
      }
    } else if (!fs.existsSync(resolved)) {
      errors.push(`${doc.path}: missing/outside-atlas link ${target}`);
    }
  }
}
for (const topic of catalog.config.topics.filter((t) => !selected || t.id === selected)) {
  const types = new Set(
    docs.filter((d) => d.metadata.topic === topic.id).map((d) => d.metadata.viewType),
  );
  for (const kind of ['architecture', 'file-dependency', 'call-flow']) {
    if (!types.has(kind)) {
      errors.push(`Topic ${topic.id} missing ${kind}`);
    }
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const tsConfig = fs.readFileSync(path.join(repositoryRoot, 'tsconfig.json'), 'utf8');
const atlasName = path.basename(atlasRoot);
if (
  JSON.stringify(pkg.workspaces ?? []).includes(atlasName) ||
  JSON.stringify(pkg.scripts ?? {}).includes(atlasName) ||
  tsConfig.includes(atlasName)
) {
  errors.push('Atlas must remain outside root runtime/workspaces/scripts/references');
}
const ignored = fs.readFileSync(path.join(atlasRoot, '.gitignore'), 'utf8');
if (
  !Array.isArray(pkg.files) ||
  pkg.files.some((p) => p === '.' || p === '*' || p === '**/*' || p.includes(atlasName))
) {
  errors.push('Root package.files must explicitly exclude the independent atlas');
}
if (
  catalog.current &&
  !catalog.history.some(
    (s) =>
      s.id === catalog.current.id &&
      s.baselineCommit === catalog.current.baselineCommit &&
      s.capturedAt === catalog.current.capturedAt,
  )
) {
  errors.push('Current snapshot pointer does not identify a stored reading snapshot');
}
for (const required of ['dist/', 'node_modules/', 'evidence/live/']) {
  if (!ignored.split('\n').includes(required)) {
    errors.push(`Missing ignore: ${required}`);
  }
}
const render = docs.flatMap((d) => d.diagrams);
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  ok: errors.length === 0,
  scope: selected ?? 'all',
  documents: docs.length,
  diagrams: render.length,
  topics: new Set(
    docs
      .map((d) => d.metadata.topic)
      .filter((t) => catalog.config.topics.some((topic) => topic.id === t)),
  ).size,
  sourceFiles: catalog.inventory.files.filter((f) => f.kind === 'source').length,
  importEdges: catalog.inventory.edges.length,
  unresolved: catalog.inventory.unresolved,
  meaning:
    'Paths, anchors, direct imports and fingerprints checked; runtime semantics require the documented human review.',
  errors,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) {
  process.exitCode = 1;
}
