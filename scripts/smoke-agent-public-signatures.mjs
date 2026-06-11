#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function fail(message) {
  failures.push(message);
}

function stableSpecifier(exportPath) {
  return exportPath === '.' ? '@alembic/agent' : `@alembic/agent/${exportPath.slice(2)}`;
}

function signatureKind(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'function') {
    const source = Function.prototype.toString.call(value);
    return /^class\s/u.test(source) ? 'class' : 'function';
  }
  return typeof value;
}

function signatureHash(entries) {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function compareEntries(exportPath, expected, actual) {
  const expectedByName = new Map(expected.entries.map((entry) => [entry.name, entry]));
  const actualByName = new Map(actual.entries.map((entry) => [entry.name, entry]));
  const missing = [...expectedByName.keys()].filter((name) => !actualByName.has(name));
  const unexpected = [...actualByName.keys()].filter((name) => !expectedByName.has(name));
  const changedKinds = [];

  for (const [name, expectedEntry] of expectedByName) {
    const actualEntry = actualByName.get(name);
    if (actualEntry && actualEntry.kind !== expectedEntry.kind) {
      changedKinds.push(`${name}: ${expectedEntry.kind} -> ${actualEntry.kind}`);
    }
  }

  if (missing.length > 0 || unexpected.length > 0 || changedKinds.length > 0) {
    fail(
      [
        `${exportPath} signature drift`,
        missing.length > 0 ? `missing=[${missing.join(', ')}]` : '',
        unexpected.length > 0 ? `unexpected=[${unexpected.join(', ')}]` : '',
        changedKinds.length > 0 ? `kindChanged=[${changedKinds.join(', ')}]` : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
  }

  if (actual.exportCount !== expected.exportCount) {
    fail(`${exportPath} exportCount ${actual.exportCount} does not match ${expected.exportCount}`);
  }
  if (actual.signatureHash !== expected.signatureHash) {
    fail(
      `${exportPath} signatureHash ${actual.signatureHash} does not match ${expected.signatureHash}`
    );
  }
}

function sameMembers(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

const packageJson = readJson('package.json');
const boundary = readJson('config/agent-public-api-boundary.json');
const signatureConfig = readJson('config/agent-public-api-signatures.json');
const stableExports = boundary.stablePublicExports ?? [];
const packageExports = Object.keys(packageJson.exports ?? {});

if (signatureConfig.schemaVersion !== 1) {
  fail('config/agent-public-api-signatures.json schemaVersion must be 1');
}
if (JSON.stringify(signatureConfig.stablePublicExports) !== JSON.stringify(stableExports)) {
  fail('signature stablePublicExports must match agent-public-api-boundary.json');
}
if (!sameMembers(stableExports, packageExports)) {
  fail('stablePublicExports must match package.json export members');
}
if (
  JSON.stringify(signatureConfig.provisionalPublicExports) !==
  JSON.stringify(boundary.provisionalPublicExports ?? [])
) {
  fail('signature provisionalPublicExports must match public boundary config');
}
if (
  !signatureConfig.provisionalTierPolicy ||
  typeof signatureConfig.provisionalTierPolicy.description !== 'string' ||
  !signatureConfig.provisionalTierPolicy.description.includes('provisional')
) {
  fail('provisionalTierPolicy.description must document provisional public export rules');
}

let checkedExports = 0;
let checkedBindings = 0;

for (const exportPath of stableExports) {
  const expected = signatureConfig.stableExportSignatures?.[exportPath];
  if (!expected) {
    fail(`${exportPath} missing from stableExportSignatures`);
    continue;
  }

  const moduleExports = await import(stableSpecifier(exportPath));
  const entries = Object.keys(moduleExports)
    .sort()
    .map((name) => ({ name, kind: signatureKind(moduleExports[name]) }));
  const actual = {
    exportPath,
    exportCount: entries.length,
    signatureHash: signatureHash(entries),
    entries,
  };

  compareEntries(exportPath, expected, actual);
  checkedExports++;
  checkedBindings += entries.length;
}

if (failures.length > 0) {
  console.error('Agent public signature smoke failed:');
  for (const message of failures) {
    console.error(`- ${message}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Agent public signature smoke OK: ${checkedExports} exports, ${checkedBindings} bindings`
  );
}
