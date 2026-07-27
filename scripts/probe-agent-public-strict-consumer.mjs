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

// 运行体作为源码资产维护，但用 --eval 在 Main cwd 的 fresh process 中启动，确保所有
// bare specifier 都从真实公共 consumer 环境解析，而不是从 Agent 仓库内部路径解析。
const runtimeProbe = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'fixtures', 'strict-public-connected-probe.mjs'),
  'utf8'
);

const runtime = spawnSync(process.execPath, ['--input-type=module', '--eval', runtimeProbe], {
  cwd: mainRoot,
  encoding: 'utf8',
});
if (runtime.status !== 0) {
  process.stderr.write(runtime.stderr || runtime.stdout);
  process.exit(runtime.status ?? 1);
}

const runtimeReceipt = JSON.parse(runtime.stdout.trim());
if (
  runtimeReceipt?.continuityVerified !== true ||
  runtimeReceipt?.connectedChain?.executor?.realExecutor !== true ||
  runtimeReceipt?.durableSemanticReview?.serviceEntrypoint !== true ||
  runtimeReceipt?.durableSemanticReview?.providerCallCount !== 1 ||
  runtimeReceipt?.durableSemanticReview?.witnessLoadCount !== 1 ||
  runtimeReceipt?.durableSemanticReview?.exactCompiledPrompt !== true ||
  runtimeReceipt?.durableSemanticReview?.serializedAttestationVerified !== true ||
  runtimeReceipt?.durableSemanticReview?.publicConsumerFreshProcess !== true ||
  runtimeReceipt?.durableSemanticReview?.freshProcessReopenVerified !== true ||
  runtimeReceipt?.connectedChain?.population?.completion !== 'complete' ||
  runtimeReceipt?.connectedChain?.terminal?.terminalClosure !== 'expressed' ||
  runtimeReceipt?.faults?.length !== 11 ||
  runtimeReceipt.faults.some((fault) => fault.rejected !== true)
) {
  throw new Error('STRICT_AGENT_PUBLIC_CONNECTED_AUTHORITY_PROOF_INVALID');
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

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 2,
    probe: runtimeReceipt.probe,
    runtimeBindings: runtimeReceipt.runtimeBindingCount,
    forbiddenImportsRejected: runtimeReceipt.forbiddenCount,
    types: 'resolved',
    publicSubpaths: runtimeReceipt.publicSubpaths,
    continuityVerified: runtimeReceipt.continuityVerified,
    durableSemanticReview: runtimeReceipt.durableSemanticReview,
    connectedChain: runtimeReceipt.connectedChain,
    faults: runtimeReceipt.faults,
    reportHash: runtimeReceipt.reportHash,
  })}\n`
);
