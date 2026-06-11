#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
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

function listFiles(directory, predicate) {
  const absolute = path.join(root, directory);
  const files = [];
  if (!fs.existsSync(absolute)) {
    return files;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tmp') {
      continue;
    }
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(relative, predicate));
    } else if (predicate(relative)) {
      files.push(relative);
    }
  }
  return files.sort();
}

function countDeclaredTests(testFiles) {
  let count = 0;
  for (const file of testFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    count += source.match(/\b(?:it|test)\s*\(/gu)?.length ?? 0;
  }
  return count;
}

function countCoreReferenceLimitTotal(coreBoundary) {
  return Object.values(coreBoundary.referenceLimits ?? {})
    .filter((count) => typeof count === 'number' && count > 0)
    .reduce((sum, count) => sum + count, 0);
}

function readAllTests(testFiles) {
  return testFiles.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
}

function verifyRequiredSuites(testSource, requiredSuites) {
  for (const suite of requiredSuites) {
    if (!testSource.includes(suite.pattern)) {
      fail(`required AG4 suite missing: ${suite.name} (${suite.pattern})`);
    }
  }
}

function getPackEntryCount() {
  const output = execFileSync(
    'npm',
    ['--cache', 'tmp/npm-cache', 'pack', '--dry-run', '--json', '--ignore-scripts', '.'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    }
  );
  const pack = JSON.parse(output);
  const files = pack[0]?.files;
  if (!Array.isArray(files)) {
    throw new Error('npm pack --json did not return a files array');
  }
  return files.length;
}

function assertAtLeast(name, actual, expected) {
  if (actual < expected) {
    fail(`${name} ${actual} is below floor ${expected}`);
  }
}

function assertExact(name, actual, expected) {
  if (actual !== expected) {
    fail(`${name} ${actual} does not match snapshot ${expected}`);
  }
}

const floor = readJson('config/agent-validation-floor.json');
const publicBoundary = readJson('config/agent-public-api-boundary.json');
const coreBoundary = readJson('config/core-import-boundary.json');

if (floor.schemaVersion !== 1) {
  fail('config/agent-validation-floor.json schemaVersion must be 1');
}

const testFiles = listFiles('test', (relative) => relative.endsWith('.test.ts'));
const declaredTestCases = countDeclaredTests(testFiles);
const stablePublicExportCount = (publicBoundary.stablePublicExports ?? []).length;
const coreReferenceLimitTotal = countCoreReferenceLimitTotal(coreBoundary);
const packEntryCount = getPackEntryCount();
const testSource = readAllTests(testFiles);

assertAtLeast('testFiles', testFiles.length, floor.minimumTestFiles);
assertAtLeast('declaredTestCases', declaredTestCases, floor.minimumDeclaredTestCases);
assertExact('stablePublicExportCount', stablePublicExportCount, floor.stablePublicExportCount);
assertExact('coreReferenceLimitTotal', coreReferenceLimitTotal, floor.coreReferenceLimitTotal);
assertAtLeast('packEntryCount', packEntryCount, floor.minimumPackEntries);
verifyRequiredSuites(testSource, floor.requiredCoverageSuites ?? []);

if (failures.length > 0) {
  console.error('Agent validation floor failed:');
  for (const message of failures) {
    console.error(`- ${message}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    [
      'Agent validation floor OK:',
      `testFiles=${testFiles.length}`,
      `declaredTestCases=${declaredTestCases}`,
      `stablePublicExportCount=${stablePublicExportCount}`,
      `coreReferenceLimitTotal=${coreReferenceLimitTotal}`,
      `packEntryCount=${packEntryCount}`,
    ].join(' ')
  );
}
