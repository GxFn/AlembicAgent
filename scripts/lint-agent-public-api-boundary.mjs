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

function specifierForExport(exportPath) {
  return exportPath === '.' ? packageJson.name : `${packageJson.name}/${exportPath.slice(2)}`;
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
  return new RegExp(`^${escaped}$`, 'u');
}

function validatePublicContractMatrix(exportedPaths) {
  const matrix = Array.isArray(policy.publicContractMatrix) ? policy.publicContractMatrix : [];
  const matrixExports = [];
  const requiredFields = [
    'export',
    'specifier',
    'contract',
    'agentOwned',
    'hostOwnedAdapterBoundary',
  ];

  for (const [index, entry] of matrix.entries()) {
    if (!entry || typeof entry !== 'object') {
      violations.push(`publicContractMatrix[${index}] must be an object`);
      continue;
    }

    for (const field of requiredFields) {
      if (!(field in entry)) {
        violations.push(`publicContractMatrix[${index}] missing ${field}`);
      }
    }

    if (typeof entry.export !== 'string') {
      violations.push(`publicContractMatrix[${index}].export must be a string`);
      continue;
    }

    matrixExports.push(entry.export);

    if (entry.specifier !== specifierForExport(entry.export)) {
      violations.push(
        `publicContractMatrix[${index}] specifier mismatch for ${entry.export}: ${entry.specifier}`
      );
    }

    if (typeof entry.contract !== 'string' || entry.contract.trim().length === 0) {
      violations.push(`publicContractMatrix[${index}] contract must be a non-empty string`);
    }

    if (!Array.isArray(entry.agentOwned) || entry.agentOwned.length === 0) {
      violations.push(`publicContractMatrix[${index}] agentOwned must be a non-empty array`);
    } else if (entry.agentOwned.some((item) => typeof item !== 'string' || item.length === 0)) {
      violations.push(`publicContractMatrix[${index}] agentOwned entries must be strings`);
    }

    if (
      typeof entry.hostOwnedAdapterBoundary !== 'string' ||
      !entry.hostOwnedAdapterBoundary.includes('Host owns')
    ) {
      violations.push(
        `publicContractMatrix[${index}] hostOwnedAdapterBoundary must explicitly say what Host owns`
      );
    }
  }

  assertUnique('publicContractMatrix exports', matrixExports);
  compareSets('publicContractMatrix', matrixExports.sort(), exportedPaths);
}

function validateForbiddenSpecifierSamples(publicSpecifiers) {
  const forbiddenPatterns = asArray(policy.forbiddenConsumerSpecifiers);
  const sampleEntries = Array.isArray(policy.forbiddenConsumerSpecifierSamples)
    ? policy.forbiddenConsumerSpecifierSamples
    : [];
  const patternMatchers = new Map(
    forbiddenPatterns.map((pattern) => [pattern, globToRegExp(pattern)])
  );
  const coveredPatterns = new Set();

  for (const [index, sample] of sampleEntries.entries()) {
    if (!sample || typeof sample !== 'object') {
      violations.push(`forbiddenConsumerSpecifierSamples[${index}] must be an object`);
      continue;
    }

    const { specifier, matches, reason } = sample;
    if (typeof specifier !== 'string' || specifier.length === 0) {
      violations.push(`forbiddenConsumerSpecifierSamples[${index}].specifier must be a string`);
      continue;
    }
    if (publicSpecifiers.has(specifier)) {
      violations.push(`Forbidden sample is a public specifier: ${specifier}`);
    }
    if (typeof matches !== 'string' || !patternMatchers.has(matches)) {
      violations.push(
        `forbiddenConsumerSpecifierSamples[${index}].matches must reference forbiddenConsumerSpecifiers`
      );
    } else if (!patternMatchers.get(matches).test(specifier)) {
      violations.push(`forbidden sample ${specifier} does not match declared pattern ${matches}`);
    } else {
      coveredPatterns.add(matches);
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      violations.push(`forbiddenConsumerSpecifierSamples[${index}].reason must be non-empty`);
    }
  }

  for (const pattern of forbiddenPatterns) {
    if (!coveredPatterns.has(pattern)) {
      violations.push(`forbiddenConsumerSpecifiers pattern has no negative sample: ${pattern}`);
    }
  }
}

if (packageJson.name !== '@alembic/agent') {
  violations.push(`Unexpected package name: ${packageJson.name ?? '<missing>'}`);
}

const exportedPaths = Object.keys(packageJson.exports ?? {}).sort();
const publicSpecifiers = new Set(exportedPaths.map((exportPath) => specifierForExport(exportPath)));
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

validatePublicContractMatrix(exportedPaths);
validateForbiddenSpecifierSamples(publicSpecifiers);

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
