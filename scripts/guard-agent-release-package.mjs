import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageLockPath = path.join(repoRoot, 'package-lock.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));

const dependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

function collectLocalWorkspaceDependencies(manifest, label) {
  const findings = [];
  for (const section of dependencySections) {
    const entries = manifest?.[section];
    if (!entries || typeof entries !== 'object') {
      continue;
    }
    for (const [name, specifier] of Object.entries(entries)) {
      if (typeof specifier === 'string' && specifier.startsWith('file:../')) {
        findings.push(`${label}:${section}.${name}=${specifier}`);
      }
    }
  }
  return findings;
}

const localDependencies = [
  ...collectLocalWorkspaceDependencies(packageJson, 'package.json'),
  ...collectLocalWorkspaceDependencies(packageLock.packages?.[''], 'package-lock.json root'),
];

if (localDependencies.length === 0) {
  process.stdout.write('AlembicAgent release package guard OK: no file:../ dependencies found.\n');
} else {
  process.stderr.write('AlembicAgent release package guard blocked pack/publish.\n');
  process.stderr.write(
    'The root package is local-source-first for development, but publishable packages must not leak file:../ workspace dependencies.\n'
  );
  process.stderr.write(
    'Create a staged publish manifest with registry dependencies and record the Core source commit before releasing.\n'
  );
  for (const finding of localDependencies) {
    process.stderr.write(`- ${finding}\n`);
  }
  process.exitCode = 1;
}
