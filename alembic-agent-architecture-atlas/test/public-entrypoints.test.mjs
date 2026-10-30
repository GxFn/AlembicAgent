import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectPublicEntrypoints } from '../scripts/public-entrypoints.mjs';

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-atlas-'));
  const write = (p, data) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), typeof data === 'string' ? data : JSON.stringify(data));
  };
  try {
    write('package.json', {
      name: '@fixture/agent',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './runs': { types: './dist/runs.d.ts', import: './dist/runs.js' },
      },
    });
    write('tsconfig.json', { compilerOptions: { rootDir: 'src', outDir: 'dist' } });
    write('src/index.ts', 'export {run} from "./runs.js";');
    write('src/runs.ts', 'export const run=()=>42;');
    write('config/agent-public-api-boundary.json', {
      stablePublicExports: ['.', './runs'],
      provisionalPublicExports: [],
      transitionalInternalExports: [],
      publicContractMatrix: [
        {
          export: '.',
          specifier: '@fixture/agent',
          contract: 'entry',
          agentOwned: ['entry'],
          hostOwnedAdapterBoundary: 'Host owns runtime',
        },
        {
          export: './runs',
          specifier: '@fixture/agent/runs',
          contract: 'runs',
          agentOwned: ['run'],
          hostOwnedAdapterBoundary: 'Host owns service',
        },
      ],
      forbiddenConsumerSpecifiers: ['@fixture/agent/src/*'],
    });
    write('config/agent-public-api-signatures.json', {
      stableExportSignatures: {
        '.': { exportCount: 1, entries: [{ name: 'run', kind: 'function' }] },
        './runs': { exportCount: 1, entries: [{ name: 'run', kind: 'function' }] },
      },
    });
    return run(root, write);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const inventory = {
  files: [
    { path: 'src/index.ts', kind: 'source' },
    { path: 'src/runs.ts', kind: 'source' },
    { path: 'test/t.test.ts', kind: 'test' },
  ],
  edges: [{ from: 'src/index.ts', to: 'src/runs.ts', kind: 're-export', typeOnly: false }],
  externalEdges: [
    { from: 'src/runs.ts', to: '@alembic/core/knowledge', kind: 'import', typeOnly: true, line: 1 },
    {
      from: 'test/t.test.ts',
      to: '@alembic/core/testing',
      kind: 'import',
      typeOnly: false,
      line: 1,
    },
  ],
};
test('public entries come only from exact exports; source mapping follows rootDir/outDir and Core stays external', () =>
  fixture((root) => {
    const report = collectPublicEntrypoints(root, inventory);
    assert.deepEqual(report.errors, []);
    assert.equal(report.entries.length, 2);
    assert.equal(report.entries[1].sourcePath, 'src/runs.ts');
    assert.equal(report.entries[0].reexports[0].to, 'src/runs.ts');
    assert.equal(report.entries[1].declaredRuntimeBindings, 1);
    assert.equal(report.runtimeImportExecuted, false);
    assert.equal(report.coreImports.length, 1);
    assert.equal(report.coreImports[0].typeOnly, true);
  }));
test('unknown/unclassified exports and escaping build targets produce explicit errors, not guessed API routes', () =>
  fixture((root, write) => {
    write('package.json', {
      name: '@fixture/agent',
      exports: {
        '.': { types: './dist/index.d.ts', import: '../outside.js' },
        './*': { import: './dist/*.js' },
        './new': { import: './dist/new.js' },
      },
    });
    const report = collectPublicEntrypoints(root, inventory);
    assert.ok(report.errors.some((e) => /outside|root|target/i.test(e)));
    assert.ok(report.errors.some((e) => /wildcard/i.test(e)));
    assert.ok(report.errors.some((e) => /unclassified/i.test(e)));
    assert.ok(!report.entries.some((e) => e.sourcePath?.includes('..')));
  }));

test('invalid target values and escaping source roots never become source links', () =>
  fixture((root, write) => {
    write('package.json', {
      name: '@fixture/agent',
      exports: { '.': null, './runs': { import: './dist/runs.js', types: './dist/runs.d.ts' } },
    });
    write('tsconfig.json', { compilerOptions: { rootDir: '../outside', outDir: 'dist' } });
    const report = collectPublicEntrypoints(root, inventory);
    assert.ok(report.errors.length);
    assert.ok(report.entries.every((e) => e.sourcePath === null));
  }));
