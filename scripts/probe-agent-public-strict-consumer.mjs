#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const mainRoot = path.resolve(repoRoot, '..', 'Alembic');
const linkedAgentRoot = fs.realpathSync(path.join(mainRoot, 'node_modules', '@alembic', 'agent'));

if (linkedAgentRoot !== repoRoot) {
  throw new Error(`ALEMBIC_AGENT_LINK_MISMATCH: expected ${repoRoot}, got ${linkedAgentRoot}`);
}

const runtimeProbe = `
import { runStrictPlanAgent } from '@alembic/agent/runs';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisExpansionPortV1,
  validateStrictAnalystEpochV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerLineageReceiptV1,
  createStrictProducerExpressionSetV1,
} from '@alembic/agent/production';
import {
  createFrozenEvidenceProjection,
  IndependentValueReviewer,
  InvestigatedEmptyReviewer,
} from '@alembic/agent/evaluation';

const bindings = {
  runStrictPlanAgent,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisExpansionPortV1,
  validateStrictAnalystEpochV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerLineageReceiptV1,
  createStrictProducerExpressionSetV1,
  createFrozenEvidenceProjection,
  IndependentValueReviewer,
  InvestigatedEmptyReviewer,
};
for (const [name, value] of Object.entries(bindings)) {
  if (typeof value !== 'function') {
    throw new Error('STRICT_PUBLIC_BINDING_INVALID: ' + name + '=' + typeof value);
  }
}

for (const specifier of [
  '@alembic/agent',
  '@alembic/agent/service',
  '@alembic/agent/runtime',
  '@alembic/agent/prompts',
]) {
  const imported = await import(specifier);
  if (!imported || typeof imported !== 'object') {
    throw new Error('LEGACY_PUBLIC_IMPORT_INVALID: ' + specifier);
  }
}

const forbidden = [
  '@alembic/agent/src/index.js',
  '@alembic/agent/dist/index.js',
  '@alembic/agent/runs/plan/PlanAgentRun.js',
  '@alembic/agent/production/StrictProductionPipeline.js',
  '@alembic/agent/production/internal/escape.js',
  '@alembic/agent/evaluation/MiningJudge.js',
  '@alembic/agent/evaluation/StrictProductionFixtureEvaluation.js',
];
for (const specifier of forbidden) {
  try {
    await import(specifier);
    throw new Error('FORBIDDEN_IMPORT_SUCCEEDED: ' + specifier);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error;
    }
  }
}

console.log(JSON.stringify({ runtimeBindingCount: Object.keys(bindings).length, forbiddenCount: forbidden.length }));
`;

const runtime = spawnSync(process.execPath, ['--input-type=module', '--eval', runtimeProbe], {
  cwd: mainRoot,
  encoding: 'utf8',
});
if (runtime.status !== 0) {
  process.stderr.write(runtime.stderr || runtime.stdout);
  process.exit(runtime.status ?? 1);
}

const fixturePath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'public-strict-consumer',
  'strict-facades.ts'
);
const virtualFile = path.join(mainRoot, '__agent-public-strict-consumer__.mts');
const fixtureSource = fs.readFileSync(fixturePath, 'utf8');
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: ['node'],
};
const host = ts.createCompilerHost(compilerOptions);
const originalFileExists = host.fileExists.bind(host);
const originalReadFile = host.readFile.bind(host);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.fileExists = (fileName) => fileName === virtualFile || originalFileExists(fileName);
host.readFile = (fileName) =>
  fileName === virtualFile ? fixtureSource : originalReadFile(fileName);
host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
  if (fileName === virtualFile) {
    return ts.createSourceFile(fileName, fixtureSource, languageVersion, true, ts.ScriptKind.TS);
  }
  return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
};

const program = ts.createProgram({ rootNames: [virtualFile], options: compilerOptions, host });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => mainRoot,
      getNewLine: () => '\n',
    })
  );
  process.exit(1);
}

const runtimeReceipt = JSON.parse(runtime.stdout.trim());
process.stdout.write(
  `Alembic strict facade consumer probe OK: runtimeBindings=${runtimeReceipt.runtimeBindingCount} forbidden=${runtimeReceipt.forbiddenCount} types=resolved\n`
);
