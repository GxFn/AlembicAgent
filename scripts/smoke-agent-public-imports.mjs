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

if (failures.length > 0) {
  process.stderr.write('AlembicAgent public import smoke failed:\n');
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `AlembicAgent public import smoke OK: ${publicExports.length} subpaths imported.\n`
  );
}
