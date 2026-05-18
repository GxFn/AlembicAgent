import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspaceRoot = path.dirname(repoRoot);
const coreRoot = path.join(workspaceRoot, 'AlembicCore');
const stagingDir = path.join(repoRoot, 'tmp', 'release', '@alembic-agent');
const packageJsonPath = path.join(repoRoot, 'package.json');
const corePackageJsonPath = path.join(coreRoot, 'package.json');
const readmePath = path.join(repoRoot, 'README.md');
const distPath = path.join(repoRoot, 'dist');

const dependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

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

function requireDirectory(directory, hint) {
  if (!existsSync(directory)) {
    fail(`${hint} Missing directory: ${path.relative(repoRoot, directory)}`);
  }
}

function requireFile(filePath, hint) {
  if (!existsSync(filePath)) {
    fail(`${hint} Missing file: ${path.relative(repoRoot, filePath)}`);
  }
}

function withoutLifecycleHardGate(scripts) {
  if (!scripts || typeof scripts !== 'object') {
    return undefined;
  }
  const stagedScripts = { ...scripts };
  delete stagedScripts.prepack;
  return stagedScripts;
}

function uniqueFiles(files) {
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

function createStagedManifest(agentPackageJson, corePackageJson, sourceMetadata) {
  const stagedPackageJson = structuredClone(agentPackageJson);
  const coreVersion = corePackageJson.version;

  stagedPackageJson.dependencies = {
    ...(agentPackageJson.dependencies ?? {}),
    '@alembic/core': coreVersion,
  };
  stagedPackageJson.files = uniqueFiles([
    ...(Array.isArray(agentPackageJson.files) ? agentPackageJson.files : []),
    '.alembic-source.json',
    'README.md',
    'dist',
  ]);
  stagedPackageJson.scripts = withoutLifecycleHardGate(agentPackageJson.scripts);
  stagedPackageJson.alembicRelease = {
    schemaVersion: 1,
    packageRole: 'agent-publish-staging',
    localDevelopmentDependency: {
      '@alembic/core': 'file:../AlembicCore',
    },
    registryDependencies: {
      '@alembic/core': coreVersion,
    },
    sources: sourceMetadata.sources,
  };

  return stagedPackageJson;
}

const agentPackageJson = readJson(packageJsonPath);
const corePackageJson = readJson(corePackageJsonPath);

if (agentPackageJson.name !== '@alembic/agent') {
  fail(`Unexpected Agent package name: ${agentPackageJson.name ?? '<missing>'}`);
}

if (corePackageJson.name !== '@alembic/core') {
  fail(`Unexpected Core package name: ${corePackageJson.name ?? '<missing>'}`);
}

if (agentPackageJson.dependencies?.['@alembic/core'] !== 'file:../AlembicCore') {
  fail('AlembicAgent dev manifest must keep @alembic/core as file:../AlembicCore before staging.');
}

requireFile(readmePath, 'Run from the AlembicAgent package root.');
requireDirectory(distPath, 'Run `npm run build` before staging.');

const coreSourceCommit = git(coreRoot, ['rev-parse', 'HEAD']);
const coreStatus = git(coreRoot, ['status', '--short']);
if (coreStatus.length > 0) {
  fail(
    'AlembicCore working tree is dirty; publish staging cannot record a precise Core source commit.'
  );
}

const agentSourceCommit = git(repoRoot, ['rev-parse', 'HEAD']);
const agentWorkingTreeDirty = git(repoRoot, ['status', '--short']).length > 0;
const sourceMetadata = {
  schemaVersion: 1,
  package: {
    name: agentPackageJson.name,
    version: agentPackageJson.version,
  },
  staging: {
    kind: 'npm-publish-preview',
    packageRole: 'agent-runtime',
    dependencyPolicy: 'registry-core-dependency',
  },
  sources: {
    '@alembic/agent': {
      repository: 'AlembicAgent',
      sourceCommit: agentSourceCommit,
      workingTreeDirty: agentWorkingTreeDirty,
    },
    '@alembic/core': {
      repository: 'AlembicCore',
      packageName: corePackageJson.name,
      packageVersion: corePackageJson.version,
      registrySpecifier: corePackageJson.version,
      sourceCommit: coreSourceCommit,
      workingTreeDirty: false,
    },
  },
  localDevelopmentDependencies: {
    '@alembic/core': 'file:../AlembicCore',
  },
};
const stagedPackageJson = createStagedManifest(agentPackageJson, corePackageJson, sourceMetadata);
const localDependencies = collectLocalWorkspaceDependencies(
  stagedPackageJson,
  'staging package.json'
);

if (localDependencies.length > 0) {
  fail(
    `Staged publish manifest still contains local workspace dependencies:\n- ${localDependencies.join(
      '\n- '
    )}`
  );
}

rmSync(stagingDir, { force: true, recursive: true });
mkdirSync(stagingDir, { recursive: true });
writeJson(path.join(stagingDir, 'package.json'), stagedPackageJson);
writeJson(path.join(stagingDir, '.alembic-source.json'), sourceMetadata);
cpSync(readmePath, path.join(stagingDir, 'README.md'));
cpSync(distPath, path.join(stagingDir, 'dist'), { recursive: true });

process.stdout.write(
  `${JSON.stringify(
    {
      stagingDir: path.relative(repoRoot, stagingDir),
      packageName: stagedPackageJson.name,
      packageVersion: stagedPackageJson.version,
      coreDependency: stagedPackageJson.dependencies['@alembic/core'],
      coreSourceCommit,
      agentSourceCommit,
      agentWorkingTreeDirty,
    },
    null,
    2
  )}\n`
);
