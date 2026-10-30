import { describe, expect, it } from 'vitest';
import {
  type AtlasDocument,
  type Inventory,
  parseRoute,
  renderMatches,
  scopedEvidence,
  searchCatalog,
  selectDependencyGraph,
} from '../src/model';

const inventory: Inventory = {
  files: [
    {
      path: 'src/a/index.ts',
      kind: 'source',
      sha256: '1',
      lines: 1,
      symbols: ['Run'],
      references: [],
      typeReferences: [],
      testCases: [],
    },
    {
      path: 'src/b/index.ts',
      kind: 'source',
      sha256: '2',
      lines: 1,
      symbols: ['Stop'],
      references: [],
      typeReferences: [],
      testCases: [],
    },
  ],
  edges: [
    {
      from: 'src/a/index.ts',
      to: 'src/b/index.ts',
      typeOnly: true,
      kind: 'import',
      specifier: '../b/index.js',
      line: 1,
    },
  ],
  externalEdges: [
    {
      from: 'src/a/index.ts',
      to: '@alembic/core',
      typeOnly: false,
      kind: 'import',
      specifier: '@alembic/core',
      line: 2,
    },
  ],
  unresolved: [],
  fingerprint: 'sample',
};
describe('读者状态保持证据边界', () => {
  it('decodes full-path routes, rejects malformed routes, and preserves duplicate basenames', () => {
    expect(parseRoute('#/files/src%2Fa%2Findex.ts')).toEqual({
      kind: 'files',
      id: 'src/a/index.ts',
    });
    expect(parseRoute('#/files/%zz').kind).toBe('missing');
    expect(parseRoute('#/unknown').kind).toBe('missing');
    expect(selectDependencyGraph(inventory, 'src/a/index.ts', 'both', true, false).nodes).toEqual([
      'src/a/index.ts',
      'src/b/index.ts',
    ]);
  });
  it('direction, type bridges, external boundaries and explicit truncation use raw import data', () => {
    expect(
      selectDependencyGraph(inventory, 'src/a/index.ts', 'out', false, false).edges,
    ).toHaveLength(0);
    expect(
      selectDependencyGraph(inventory, 'src/b/index.ts', 'in', true, false).edges,
    ).toHaveLength(1);
    expect(selectDependencyGraph(inventory, 'src/a/index.ts', 'out', true, true, 2)).toMatchObject({
      omittedNodes: 1,
      omittedEdges: 1,
    });
    expect(
      selectDependencyGraph(inventory, 'src/b/index.ts', 'out', true, true).edges,
    ).toHaveLength(0);
  });
  it('missing, zero-sized, duplicate or stale renderer observations never become current pass', () => {
    const d = { id: 'sample#1', source: 'graph', digest: 'sha256:new', title: '图' };
    const receipt = {
      renderer: 'mermaid',
      rendererVersion: '1',
      checkedAt: '2026-10-22T00:00:00Z',
      results: [{ id: d.id, digest: d.digest, status: 'pass', width: 2, height: 3 }],
    };
    expect(renderMatches(receipt, d, '1')).toBe(true);
    expect(renderMatches(null, d, '1')).toBe(false);
    expect(renderMatches(receipt, d, '2')).toBe(false);
    expect(
      renderMatches({ ...receipt, results: [...receipt.results, ...receipt.results] }, d, '1'),
    ).toBe(false);
    expect(
      renderMatches({ ...receipt, results: [{ ...receipt.results[0], width: 0 }] }, d, '1'),
    ).toBe(false);
  });
  it('search finds symbols without collapsing same-name files and has an honest empty state', () => {
    expect(
      searchCatalog([] as AtlasDocument[], inventory.files, 'Run').files.map((f) => f.path),
    ).toEqual(['src/a/index.ts']);
    expect(searchCatalog([], inventory.files, 'index.ts').files).toHaveLength(2);
    expect(searchCatalog([], inventory.files, 'no-such-symbol').files).toHaveLength(0);
  });
});

it('scoped execution summaries keep stale current inputs and absent historical evidence visible', () => {
  const report = {
    schemaVersion: 1,
    checkedAt: '2026-10-22',
    groups: [
      {
        id: 'domain',
        file: 'test/domain.test.ts',
        status: 'pass',
        passed: 3,
        failed: 0,
        skipped: 20,
        inputFreshness: 'matched',
        cases: [],
      },
    ],
  } as const;
  const mutable = JSON.parse(JSON.stringify(report));
  const frozen = JSON.parse(JSON.stringify(report));
  expect(scopedEvidence(mutable, false)).toMatchObject({ passed: 3, tone: 'good' });
  mutable.groups[0].inputFreshness = 'stale';
  expect(scopedEvidence(mutable, false).tone).toBe('warning');
  expect(scopedEvidence(mutable, true).tone).toBe('warning');
  expect(scopedEvidence(frozen, true).tone).toBe('neutral');
  expect(scopedEvidence(null, true)).toMatchObject({ passed: 0, tone: 'neutral' });
});

it('preserves stable section and edge routes and returns search snippets with honest limits', () => {
  expect(parseRoute('#/doc/topic?section=scenario-a&edge=E-A-01')).toEqual({
    kind: 'doc',
    id: 'topic',
    section: 'scenario-a',
    edge: 'E-A-01',
  });
  expect(parseRoute('#/health')).toEqual({ kind: 'health', id: '' });
  const docs = Array.from(
    { length: 14 },
    (_, i) =>
      ({
        id: `d${i}`,
        metadata: { title: `Doc ${i}` },
        body: '## 恢复责任\n已确认回执；取消不能回滚。',
      }) as AtlasDocument,
  );
  const result = searchCatalog(docs, [], '取消');
  expect(result.totalDocuments).toBe(14);
  expect(result.documents).toHaveLength(12);
  expect(result.documents[0].snippet).toContain('取消');
  expect(result.documents[0].section).toMatch(/^s-/);
});

it('duplicate subheadings resolve under their own parent and diagnostic underscores survive snippets', async () => {
  const { readerSections } = await import('../src/sections');
  const body =
    '## 第一张图\n### 本图术语说明\n旧内容\n## 第二张图\n### 本图术语说明\nTOOL_HOST_EXECUTION_FAILED 表示需要按阶段检查。';
  const sections = readerSections(body);
  expect(sections[1].id).not.toBe(sections[3].id);
  const doc = { id: 'd', metadata: { title: 'runtime' }, body } as AtlasDocument;
  const found = searchCatalog([doc], [], 'TOOL_HOST_EXECUTION_FAILED').documents[0];
  expect(found.section).toBe(sections[3].id);
  expect(found.snippet).toContain('TOOL_HOST_EXECUTION_FAILED');
});
