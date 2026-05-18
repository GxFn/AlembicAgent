import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const policyPath = path.join(repoRoot, 'config', 'agent-public-api-boundary.json');
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

const publicExports = [
  ...(Array.isArray(policy.stablePublicExports) ? policy.stablePublicExports : []),
  ...(Array.isArray(policy.provisionalPublicExports) ? policy.provisionalPublicExports : []),
].sort();
const forbiddenSamples = Array.isArray(policy.forbiddenConsumerSpecifierSamples)
  ? policy.forbiddenConsumerSpecifierSamples.filter(
      (sample) => sample && typeof sample.specifier === 'string'
    )
  : [];

function specifierForExport(exportPath) {
  return exportPath === '.' ? '@alembic/agent' : `@alembic/agent/${exportPath.slice(2)}`;
}

const failures = [];

for (const exportPath of publicExports) {
  const specifier = specifierForExport(exportPath);
  try {
    const imported = await import(specifier);
    if (!imported || typeof imported !== 'object') {
      failures.push(`${specifier}: import returned ${typeof imported}`);
    }
  } catch (error) {
    failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const sample of forbiddenSamples) {
  try {
    await import(sample.specifier);
    failures.push(`${sample.specifier}: forbidden public import unexpectedly succeeded`);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) {
      failures.push(`${sample.specifier}: unexpected error shape ${String(error)}`);
      continue;
    }

    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      failures.push(
        `${sample.specifier}: expected ERR_PACKAGE_PATH_NOT_EXPORTED, got ${error.code}`
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write('AlembicAgent public import smoke failed:\n');
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `AlembicAgent public import smoke OK: ${publicExports.length} subpaths imported, ${forbiddenSamples.length} forbidden subpaths rejected.\n`
  );
}
