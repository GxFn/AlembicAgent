import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  analyzeRepository,
  documentParts,
  fingerprint,
  validateDocument,
  validateRenderReceipt,
} from '../scripts/atlas-lib.mjs';

function fixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-atlas-test-'));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  try {
    write(
      'package.json',
      JSON.stringify({
        type: 'module',
        imports: { '#unit/*': { types: './src/*', default: './dist/*' } },
      }),
    );
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          rootDir: 'src',
          outDir: 'dist',
        },
        include: ['src'],
      }),
    );
    write(
      'src/a.ts',
      "import { B } from '#unit/b.js'; import type { T } from './b.js'; export function A(){ return new B(); } import('./late.js'); import(name);\n",
    );
    write('src/b.ts', 'export class B { run() { return 1; } } export type T = string;');
    write('src/late.ts', 'export const ready = true;');
    write(
      'test/a.test.ts',
      "import { A } from '../src/a.js'; import { B } from '../src/b.js'; A(); // B.run(); fakeOnly\n",
    );
    return run(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('source analysis resolves package aliases and distinguishes types, dynamic loads and test usage', () =>
  fixture((root) => {
    const result = analyzeRepository(root, {
      sourceRoots: ['src'],
      testRoots: ['test'],
      supportPaths: ['package.json', 'tsconfig.json'],
    });
    assert.equal(result.files.filter((f) => f.kind === 'source').length, 3);
    assert.ok(
      result.edges.some(
        (e) =>
          e.from === 'src/a.ts' &&
          e.to === 'src/b.ts' &&
          e.specifier === '#unit/b.js' &&
          !e.typeOnly,
      ),
    );
    assert.ok(result.edges.some((e) => e.typeOnly && e.to === 'src/b.ts'));
    assert.ok(result.edges.some((e) => e.kind === 'dynamic-import' && e.to === 'src/late.ts'));
    assert.equal(result.unresolved.length, 1);
    assert.ok(result.files.find((f) => f.path === 'src/b.ts').symbols.includes('B.run'));
    assert.ok(result.files.find((f) => f.path === 'test/a.test.ts').references.includes('A'));
    assert.ok(!result.files.find((f) => f.path === 'test/a.test.ts').references.includes('B'));
    assert.ok(
      !result.files.find((f) => f.path === 'test/a.test.ts').references.includes('fakeOnly'),
    );
  }));

test('fingerprints bind sorted paths and exact bytes, detect additions and reject escape/missing inputs', () =>
  fixture((root, write) => {
    const a = fingerprint(root, ['src/*.ts']);
    assert.equal(a.digest, fingerprint(root, ['src/b.ts', 'src/a.ts', 'src/late.ts']).digest);
    write('src/new.ts', 'export const n=1;');
    assert.notEqual(a.digest, fingerprint(root, ['src/*.ts']).digest);
    assert.throws(() => fingerprint(root, ['../secret']), /relative|escape/i);
    assert.throws(() => fingerprint(root, ['src/missing.ts']), /missing|unmatched/i);
  }));

test('document checks require every edge, real anchors and fingerprint closure', () =>
  fixture((root) => {
    const model = analyzeRepository(root, {
      sourceRoots: ['src'],
      testRoots: ['test'],
      supportPaths: ['package.json', 'tsconfig.json'],
    });
    const metadata = {
      schemaVersion: 1,
      diagramId: 'sample',
      topic: '01',
      title: '样板',
      viewType: 'call-flow',
      truthKind: 'in-progress-worktree',
      reviewDepth: 'L4',
      verifiedAt: '2026-10-22',
      baselineCommit: 'a'.repeat(40),
      documentationOwner: 'Agent',
      sourcePaths: ['src/a.ts', 'src/b.ts'],
      testPaths: ['test/a.test.ts'],
      contractPaths: [],
      refreshTriggers: [],
      sourceFingerprint: fingerprint(root, ['src/a.ts', 'src/b.ts', 'test/a.test.ts']).digest,
      testEvidence: 'anchored',
    };
    const body =
      '```mermaid\nflowchart LR\n accTitle: 真实调用\n accDescr: 样板调用与回执\n a["A"] -->|"E-PILOT-01 调用"| b["B"]\n```\n\n### 本图术语说明\nA是入口，B是返回对象。\n\n| 编号 | 代码依据 | 测试依据 | 关系说明 |\n| --- | --- | --- | --- |\n| E-PILOT-01 | `src/a.ts#A` → `src/b.ts#B` | `test/a.test.ts#A` | 构造真实B；用例调用A。 |\n';
    assert.deepEqual(
      validateDocument({ metadata, body, path: 'maps/sample.md' }, root, model).errors,
      [],
    );
    assert.ok(
      validateDocument(
        {
          metadata,
          body: body.replace('| E-PILOT-01 |', '| E-PILOT-02 |'),
          path: 'maps/sample.md',
        },
        root,
        model,
      ).errors.some((x) => x.includes('E-PILOT-01')),
    );
    assert.ok(
      validateDocument(
        {
          metadata,
          body: body.replace('test/a.test.ts#A', 'test/a.test.ts#B'),
          path: 'maps/sample.md',
        },
        root,
        model,
      ).errors.some((x) => x.includes('test anchor')),
    );
    const excluded = {
      ...metadata,
      sourcePaths: ['src/a.ts'],
      sourceFingerprint: fingerprint(root, ['src/a.ts', 'test/a.test.ts']).digest,
    };
    assert.ok(
      validateDocument(
        { metadata: excluded, body, path: 'maps/sample.md' },
        root,
        model,
      ).errors.some((x) => x.includes('fingerprint inputs')),
    );
  }));

test('render receipts reject duplicate, old, failed and zero-sized graph observations', () => {
  const expected = [{ id: 'x#1', digest: 'sha256:a' }];
  const receipt = {
    renderer: 'mermaid',
    rendererVersion: '11',
    checkedAt: '2026-10-22T00:00:00Z',
    results: [{ id: 'x#1', digest: 'sha256:a', status: 'pass', width: 200, height: 100 }],
  };
  assert.deepEqual(validateRenderReceipt(receipt, expected, '11'), []);
  for (const bad of [
    { ...receipt, rendererVersion: '10' },
    { ...receipt, results: [...receipt.results, ...receipt.results] },
    { ...receipt, results: [{ ...receipt.results[0], digest: 'sha256:old' }] },
    { ...receipt, results: [{ ...receipt.results[0], width: 0 }] },
  ]) {
    assert.ok(validateRenderReceipt(bad, expected, '11').length);
  }
});

test('frontmatter is required and malformed metadata does not masquerade as a current document', () => {
  assert.throws(() => documentParts('# no metadata'), /frontmatter/i);
  assert.throws(() => documentParts('---\n[bad]\n---\nbody'), /metadata/i);
});

test('public collect CLI accepts a repository fixture without writing product inputs', () =>
  fixture((root) => {
    const result = spawnSync(
      process.execPath,
      ['scripts/collect.mjs', '--root', root, '--stdout'],
      { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.ok(data.inventory.files.some((f) => f.path === 'src/a.ts'));
  }));

test('unsupported arrows, implicit unknown nodes, duplicate declarations and invalid dates fail closed', () =>
  fixture((root) => {
    const inventory = analyzeRepository(root, {
      sourceRoots: ['src'],
      testRoots: ['test'],
      supportPaths: [],
    });
    const metadata = {
      schemaVersion: 1,
      diagramId: 'grammar',
      topic: '01',
      title: '语法',
      viewType: 'call-flow',
      truthKind: 'in-progress-worktree',
      reviewDepth: 'L2',
      verifiedAt: '2026-10-22',
      baselineCommit: 'a'.repeat(40),
      documentationOwner: 'Agent',
      sourcePaths: ['src/a.ts', 'src/b.ts'],
      testPaths: ['test/a.test.ts'],
      contractPaths: [],
      refreshTriggers: [],
      sourceFingerprint: fingerprint(root, ['src/a.ts', 'src/b.ts', 'test/a.test.ts']).digest,
      testEvidence: 'anchored',
    };
    const body =
      '```mermaid\nflowchart LR\naccTitle: 调用\naccDescr: 关系\na["入口"]\nb["目标"]\na -->|"E-X-01 调用"| b\n```\n\n### 本图术语说明\n入口和目标。\n\n| 编号 | 代码 | 测试 | 说明 |\n| --- | --- | --- | --- |\n| E-X-01 | `src/a.ts#A` → `src/b.ts#B` | `test/a.test.ts#A` | 实例化 |\n';
    assert.deepEqual(validateDocument({ metadata, body }, root, inventory).errors, []);
    for (const invalid of [
      body.replace('a -->|', 'a ==>|'),
      body.replace('b["目标"]\n', ''),
      body.replace('b["目标"]', 'b["目标"]\nb["再声明"]'),
    ]) {
      assert.ok(
        validateDocument({ metadata, body: invalid }, root, inventory).errors.length,
        'unsupported or unknown relation must fail',
      );
    }
    assert.ok(
      validateDocument(
        { metadata: { ...metadata, verifiedAt: '2026-02-30' }, body },
        root,
        inventory,
      ).errors.some((e) => e.includes('verifiedAt')),
    );
  }));

test('exact test-title anchors distinguish removed, imported-only and type-only evidence', () =>
  fixture((root, write) => {
    write(
      'test/a.test.ts',
      "import { A as renamed } from '../src/a.js'; import type { B } from '../src/b.js'; it('calls real A',()=>{ expect(renamed()).toBeDefined(); }); type Only = B;",
    );
    const model = analyzeRepository(root, {
      sourceRoots: ['src'],
      testRoots: ['test'],
      supportPaths: [],
    });
    const entry = model.files.find((f) => f.path === 'test/a.test.ts');
    assert.ok(entry.references.includes('A'));
    assert.ok(!entry.references.includes('B'));
    assert.ok(entry.typeReferences.includes('B'));
    assert.deepEqual(entry.testCases, ['calls real A']);
  }));

test('NodeNext inventory keeps mixed imports, type queries, re-exports, self exports and module suffixes', () =>
  fixture((root, write) => {
    write(
      'package.json',
      JSON.stringify({
        name: '@fixture/agent',
        type: 'module',
        exports: { '.': { types: './src/b.ts', default: './dist/b.js' } },
      }),
    );
    write('src/mode.mts', 'export const esm = 1;');
    write('src/common.cts', 'export const common = 1;');
    write(
      'src/consumer.ts',
      "import { B, type T } from './b.js'; export { B } from './b.js'; type Q = import('./b.js').T; import('@fixture/agent'); import('./mode.mjs'); import('./common.cjs'); import('node:fs'); export const x = B;",
    );
    const inv = analyzeRepository(root, {
      sourceRoots: ['src'],
      testRoots: ['test'],
      supportPaths: ['package.json', 'tsconfig.json'],
    });
    const edges = inv.edges.filter((e) => e.from === 'src/consumer.ts');
    assert.ok(edges.some((e) => e.kind === 'import' && !e.typeOnly && e.to === 'src/b.ts'));
    assert.ok(edges.some((e) => e.kind === 'type-query' && e.typeOnly));
    assert.ok(edges.some((e) => e.kind === 're-export'));
    assert.ok(edges.some((e) => e.specifier === '@fixture/agent' && e.to === 'src/b.ts'));
    assert.ok(edges.some((e) => e.to === 'src/mode.mts'));
    assert.ok(edges.some((e) => e.to === 'src/common.cts'));
    assert.ok(inv.externalEdges.some((e) => e.to === 'node:fs'));
    const initial = fingerprint(root, ['src/*.ts']).digest;
    write('src/a.ts', 'export const moved = 2;');
    assert.notEqual(initial, fingerprint(root, ['src/*.ts']).digest);
  }));

test('a missing declared source preserves other resolved inputs and reports its primary cause', () =>
  fixture((root) => {
    const result = fingerprint(root, ['src/a.ts', 'src/retired.ts'], { allowMissing: true });
    assert.ok(result.files.includes('src/a.ts'));
    assert.deepEqual(result.missing, ['src/retired.ts']);
    assert.throws(
      () => fingerprint(root, ['../outside'], { allowMissing: true }),
      /relative|escape/i,
    );
  }));
