#!/usr/bin/env node
// Implicit-key lint (AlembicAgent): every underscore-prefixed property key used in
// src/ must be registered in config/implicit-keys.json.
//
// Why: sharedState / strategyContext / phaseResults are untyped bags that several
// modules (and the host) read and write through `_xxx` keys. Each module declares
// its own local view of the bag, so a typo, a renamed key, or a new hidden channel
// compiles fine and fails silently at runtime. This lint gives those keys one
// owner: a registry that says which bag a key lives in and who writes it, checked
// against the source on every run.
//
// What is checked (syntax only, via the TypeScript parser — no type information):
//   1. every `_xxx` property key found in src/ is registered (exact key or prefix);
//   2. every registered key or prefix still occurs in src/ (no stale rows);
//   3. for `channel` keys, "agent" is listed in `writers` exactly when src/ contains
//      a write site (assignment target or object-literal key). Host writers cannot
//      be verified from this repository and are recorded as declared facts.
//
// Channels with an empty `writers` list are read here but written by nobody. A dead
// read path may only stay when the row records why (`unwiredReason`): wire it, delete
// the read, or acknowledge the gap. Acknowledged gaps are reported on every run so they
// stay visible, and the acknowledgment must be removed once a writer appears.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = 'config/implicit-keys.json';
const SOURCE_ROOT = 'src';
const KEY_RE = /^_[A-Za-z]/u;
const CONTAINERS = new Set([
  'sharedState',
  'strategyContext',
  'phaseResults',
  'toolCallContext',
  'hostContainer',
]);
const WRITERS = new Set(['agent', 'host']);
const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function fail(messages) {
  process.stderr.write('Implicit-key lint failed:\n');
  for (const message of messages) {
    process.stderr.write(`- ${message}\n`);
  }
  process.exit(1);
}

function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(relative));
    } else if (relative.endsWith('.ts') && !relative.endsWith('.d.ts')) {
      files.push(relative);
    }
  }
  return files.sort();
}

/** `x._k = v`, `x._k ??= v`, `x['_k'] += 1`: the access is the assignment target. */
function isAssignmentTarget(node) {
  let current = node;
  let parent = current.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent))
  ) {
    current = parent;
    parent = current.parent;
  }
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind)
  );
}

function keyName(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null;
}

function templateHead(node) {
  return node && ts.isTemplateExpression(node) ? node.head.text : null;
}

function scanFile(relative, occurrences) {
  const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.ES2022, true);
  const record = (key, role, node, prefix = false) => {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    occurrences.push({ key, role, prefix, location: `${relative}:${line + 1}` });
  };

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      // `this._x` is a class member convention, not a key on a shared bag.
      if (KEY_RE.test(node.name.text) && node.expression.kind !== ts.SyntaxKind.ThisKeyword) {
        record(node.name.text, isAssignmentTarget(node) ? 'write' : 'read', node.name);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteralLike(argument) && KEY_RE.test(argument.text)) {
        record(argument.text, isAssignmentTarget(node) ? 'write' : 'read', argument);
      }
    } else if (ts.isTemplateExpression(node)) {
      // `_retries_${stage}`: a key family. Wherever the template is built, the head is the prefix.
      if (KEY_RE.test(node.head.text)) {
        record(node.head.text, 'read', node, true);
      }
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const computedHead = ts.isComputedPropertyName(node.name)
        ? templateHead(node.name.expression)
        : null;
      const name = keyName(node.name);
      if (name && KEY_RE.test(name)) {
        record(name, 'write', node.name);
      } else if (computedHead && KEY_RE.test(computedHead)) {
        record(computedHead, 'write', node.name, true);
      }
    } else if (ts.isPropertySignature(node)) {
      // Interface / type-literal members only. Class members (`this._x`) are a private-field
      // convention and are covered when someone reaches them through another receiver.
      const name = keyName(node.name);
      if (name && KEY_RE.test(name)) {
        record(name, 'declare', node.name);
      }
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = keyName(node.propertyName ?? node.name);
      if (name && KEY_RE.test(name)) {
        record(name, 'read', node);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      ts.isStringLiteralLike(node.left) &&
      KEY_RE.test(node.left.text)
    ) {
      record(node.left.text, 'read', node.left);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'hasOwn' &&
      node.arguments.length === 2 &&
      ts.isStringLiteralLike(node.arguments[1]) &&
      KEY_RE.test(node.arguments[1].text)
    ) {
      record(node.arguments[1].text, 'read', node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

if (!existsSync(path.join(REPO_ROOT, CONFIG_PATH))) {
  fail([`${CONFIG_PATH} is missing`]);
}
const config = JSON.parse(readFileSync(path.join(REPO_ROOT, CONFIG_PATH), 'utf8'));
const failures = [];
if (config.schemaVersion !== 1) {
  failures.push(`${CONFIG_PATH} schemaVersion must be 1`);
}
const channels = config.channels ?? {};
const prefixes = config.prefixes ?? {};
const fields = config.fields ?? {};

for (const [key, entry] of [...Object.entries(channels), ...Object.entries(prefixes)]) {
  if (!KEY_RE.test(key)) {
    failures.push(`registry key '${key}' must start with an underscore followed by a letter`);
  }
  if (!CONTAINERS.has(entry?.container)) {
    failures.push(`'${key}' container must be one of ${[...CONTAINERS].join(', ')}`);
  }
  if (!Array.isArray(entry?.writers) || entry.writers.some((writer) => !WRITERS.has(writer))) {
    failures.push(`'${key}' writers must be an array drawn from ${[...WRITERS].join(', ')}`);
  }
  if (typeof entry?.purpose !== 'string' || entry.purpose.trim().length === 0) {
    failures.push(`'${key}' needs a non-empty purpose`);
  }
  const acknowledged =
    typeof entry?.unwiredReason === 'string' && entry.unwiredReason.trim().length > 0;
  if (Array.isArray(entry?.writers) && Object.hasOwn(channels, key)) {
    if (entry.writers.length === 0 && !acknowledged) {
      failures.push(
        `channel '${key}' has no writer — wire it, delete the read, or record an unwiredReason`
      );
    }
    if (entry.writers.length > 0 && entry.unwiredReason !== undefined) {
      failures.push(`channel '${key}' has writers but still carries an unwiredReason`);
    }
  }
}
for (const [key, entry] of Object.entries(fields)) {
  if (Object.hasOwn(channels, key)) {
    failures.push(`'${key}' is registered both as a channel and as a field`);
  }
  if (typeof entry?.owner !== 'string' || !existsSync(path.join(REPO_ROOT, entry.owner))) {
    failures.push(`field '${key}' owner must be an existing source file`);
  }
  if (typeof entry?.purpose !== 'string' || entry.purpose.trim().length === 0) {
    failures.push(`field '${key}' needs a non-empty purpose`);
  }
}
if (failures.length > 0) {
  fail(failures);
}

const occurrences = [];
const sourceFiles = listSourceFiles(SOURCE_ROOT);
for (const file of sourceFiles) {
  scanFile(file, occurrences);
}

// `--report`: print what the scan sees, one key per line, to help fill in the registry.
if (process.argv.includes('--report')) {
  const table = new Map();
  for (const { key, role, prefix, location } of occurrences) {
    const name = prefix ? `${key}*` : key;
    const row = table.get(name) ?? { read: 0, write: 0, declare: 0, files: new Set() };
    row[role] += 1;
    row.files.add(location.slice(0, location.lastIndexOf(':')));
    table.set(name, row);
  }
  for (const [name, row] of [...table.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    process.stdout.write(
      `${name}\tread=${row.read} write=${row.write} declare=${row.declare}\t${[...row.files].join(' ')}\n`
    );
  }
  process.exit(0);
}

const prefixNames = Object.keys(prefixes);
const matchingPrefix = (key) => prefixNames.find((prefix) => key.startsWith(prefix));
const seen = new Map();
const note = (name, occurrence) => {
  const entry = seen.get(name) ?? { writes: 0, locations: [] };
  entry.writes += occurrence.role === 'write' ? 1 : 0;
  entry.locations.push(occurrence.location);
  seen.set(name, entry);
};

for (const occurrence of occurrences) {
  if (occurrence.prefix) {
    const prefix = matchingPrefix(occurrence.key);
    if (prefix) {
      note(prefix, occurrence);
    } else {
      failures.push(
        `${occurrence.location} builds key family '${occurrence.key}…' that is not registered under prefixes`
      );
    }
    continue;
  }
  if (Object.hasOwn(channels, occurrence.key) || Object.hasOwn(fields, occurrence.key)) {
    note(occurrence.key, occurrence);
    continue;
  }
  const prefix = matchingPrefix(occurrence.key);
  if (prefix) {
    note(prefix, occurrence);
    continue;
  }
  failures.push(
    `${occurrence.location} uses unregistered key '${occurrence.key}' — add it to ${CONFIG_PATH} (channel with container/writers, or typed field with owner)`
  );
}

for (const key of [...Object.keys(channels), ...prefixNames, ...Object.keys(fields)]) {
  if (!seen.has(key)) {
    failures.push(
      `registered key '${key}' no longer occurs in ${SOURCE_ROOT}/ — remove the stale row`
    );
  }
}

for (const [key, entry] of Object.entries(channels)) {
  const usage = seen.get(key);
  if (!usage) {
    continue;
  }
  const declaresAgentWriter = entry.writers.includes('agent');
  if (declaresAgentWriter && usage.writes === 0) {
    failures.push(
      `channel '${key}' lists "agent" as a writer but ${SOURCE_ROOT}/ has no write site (seen at ${usage.locations[0]})`
    );
  }
  if (!declaresAgentWriter && usage.writes > 0) {
    failures.push(
      `channel '${key}' is written in ${SOURCE_ROOT}/ but "agent" is not in its writers`
    );
  }
}

if (failures.length > 0) {
  fail(failures);
}

const unwired = Object.entries(channels)
  .filter(([, entry]) => entry.writers.length === 0)
  .map(([key]) => key)
  .sort();
process.stdout.write(
  `Implicit-key lint OK: ${sourceFiles.length} src files, ${Object.keys(channels).length} channels, ` +
    `${prefixNames.length} key families, ${Object.keys(fields).length} typed fields registered.\n`
);
if (unwired.length > 0) {
  process.stdout.write(
    `  unwired channels (read here, written by nobody): ${unwired.join(', ')}\n`
  );
}
