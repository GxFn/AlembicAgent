import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJsonPath = path.join(repoRoot, 'package.json');
const policyPath = path.join(repoRoot, 'config', 'agent-public-api-boundary.json');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

const statuses = [
  ['stable-public', 'stablePublicExports'],
  ['provisional-public', 'provisionalPublicExports'],
  ['transitional-internal', 'transitionalInternalExports'],
];

const violations = [];

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function assertUnique(name, values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      violations.push(`${name} contains duplicate export "${value}"`);
    }
    seen.add(value);
  }
}

function compareSets(name, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const value of expectedSet) {
    if (!actualSet.has(value)) {
      violations.push(`${name} missing expected export "${value}"`);
    }
  }
  for (const value of actualSet) {
    if (!expectedSet.has(value)) {
      violations.push(`${name} contains unclassified export "${value}"`);
    }
  }
}

function exportTargetFor(exportPath) {
  const entry = packageJson.exports?.[exportPath];
  if (typeof entry === 'string') {
    return { import: entry, types: null };
  }
  if (entry && typeof entry === 'object') {
    return {
      import: typeof entry.import === 'string' ? entry.import : null,
      types: typeof entry.types === 'string' ? entry.types : null,
    };
  }
  return { import: null, types: null };
}

if (packageJson.name !== '@alembic/agent') {
  violations.push(`Unexpected package name: ${packageJson.name ?? '<missing>'}`);
}

const exportedPaths = Object.keys(packageJson.exports ?? {}).sort();
const classifiedPaths = [];
const counts = {
  'stable-public': 0,
  'provisional-public': 0,
  'transitional-internal': 0,
  forbidden: 0,
};

for (const [status, key] of statuses) {
  const values = asArray(policy[key]);
  assertUnique(key, values);
  counts[status] = values.length;
  classifiedPaths.push(...values);
}

const expectedCounts = policy.expectedCounts ?? {};
for (const [status, count] of Object.entries(counts)) {
  if (expectedCounts[status] !== count) {
    violations.push(
      `expectedCounts["${status}"] is ${expectedCounts[status]}, actual policy count is ${count}`
    );
  }
}

compareSets('package exports', exportedPaths, classifiedPaths);

for (const exportPath of exportedPaths) {
  if (!exportPath.startsWith('.')) {
    violations.push(`Export path must start with ".": ${exportPath}`);
  }
  if (exportPath.includes('*')) {
    violations.push(`Wildcard package export is not allowed: ${exportPath}`);
  }
  const target = exportTargetFor(exportPath);
  if (!target.import?.startsWith('./dist/')) {
    violations.push(`${exportPath} import target must point at ./dist/: ${target.import}`);
  }
  if (!target.types?.startsWith('./dist/')) {
    violations.push(`${exportPath} types target must point at ./dist/: ${target.types}`);
  }
}

const forbiddenConsumerSpecifiers = asArray(policy.forbiddenConsumerSpecifiers);
counts.forbidden = forbiddenConsumerSpecifiers.length;
if (expectedCounts.forbidden !== 0) {
  violations.push(
    'expectedCounts["forbidden"] must stay 0; forbidden patterns are rules, not exports'
  );
}

if (violations.length > 0) {
  process.stderr.write('AlembicAgent public API boundary violations found:\n');
  for (const violation of violations) {
    process.stderr.write(`- ${violation}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `AlembicAgent public API boundary OK: ${exportedPaths.length} exact exports, no wildcard exports.`
  );
  process.stdout.write('\n');
}
