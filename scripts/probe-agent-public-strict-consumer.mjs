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
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  createStrictHypothesisExpressionSetReceiptV1,
  validateStrictAnalysisEpochTransitionV1,
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
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  createStrictHypothesisExpressionSetReceiptV1,
  validateStrictAnalysisEpochTransitionV1,
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

// 复用 Core 自己的 public-facade real-executor probe；它从临时 project.json 经过真实
// fact executor/canonical constructors 生成 authority JSON，避免 Agent probe 手工拼 hash 自证。
const coreProbePath = path.resolve(
  repoRoot,
  '..',
  'AlembicCore',
  'scripts',
  'strict-production-authority-probe.mjs'
);
const coreRuntime = spawnSync(process.execPath, [coreProbePath], {
  cwd: mainRoot,
  encoding: 'utf8',
});
if (coreRuntime.status !== 0) {
  process.stderr.write(coreRuntime.stderr || coreRuntime.stdout);
  process.exit(coreRuntime.status ?? 1);
}
const coreAuthorityProof = JSON.parse(coreRuntime.stdout);
if (
  coreAuthorityProof?.executor?.realExecutor !== true ||
  coreAuthorityProof?.publicSubpaths?.includes('@alembic/core/production') !== true ||
  !coreAuthorityProof?.authorityHash ||
  !coreAuthorityProof?.analysisReviewContextHash ||
  coreAuthorityProof?.faults?.some((fault) => fault.rejected !== true)
) {
  throw new Error('STRICT_CORE_PUBLIC_AUTHORITY_PROOF_INVALID');
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
  `${JSON.stringify({
    schemaVersion: 1,
    probe: 'alembic-agent-strict-public-facade-fresh-process',
    runtimeBindings: runtimeReceipt.runtimeBindingCount,
    forbiddenImportsRejected: runtimeReceipt.forbiddenCount,
    types: 'resolved',
    publicSubpaths: ['@alembic/agent/production', '@alembic/core/production'],
    coreSemanticAuthority: {
      realExecutor: coreAuthorityProof.executor.realExecutor,
      executionReceiptHash: coreAuthorityProof.executor.receiptHash,
      executionOutputHash: coreAuthorityProof.executor.outputHash,
      analysisReviewContextHash: coreAuthorityProof.analysisReviewContextHash,
      authorityHash: coreAuthorityProof.authorityHash,
      resourceConservation: coreAuthorityProof.resourceConservation,
      faultCount: coreAuthorityProof.faults.length,
      reportHash: coreAuthorityProof.reportHash,
    },
  })}\n`
);
