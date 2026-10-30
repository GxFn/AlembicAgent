import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindAssertion,
  buildRelations,
  docRoute,
  documentSections,
  embeddedEvidenceKey,
  relationErrors,
  stableSectionId,
} from '../scripts/relations.mjs';

test('logical evidence links name embedded data without requiring duplicate JSON exports', () => {
  assert.equal(embeddedEvidenceKey('evidence/public-entrypoints.json'), 'publicApi');
  assert.equal(embeddedEvidenceKey('evidence/scoped-execution.json'), 'scopedRuns');
  for (const target of [
    '../evidence/public-entrypoints.json',
    'constructor',
    'evidence/private.json',
  ]) {
    assert.equal(embeddedEvidenceKey(target), null);
  }
});

test('section identities survive inserted headings and cross-page fragments retain their target', () => {
  const a = documentSections('## 第一个\n内容\n## 失败与恢复\n取消');
  const b = documentSections('## 新增\n无关\n## 第一个\n内容\n## 失败与恢复\n取消');
  assert.equal(a[1].id, b[2].id);
  assert.equal(a[1].id, stableSectionId('失败与恢复'));
  assert.equal(
    docRoute('13-sequence', 'scenario-cancel'),
    '#/doc/13-sequence?section=scenario-cancel',
  );
  assert.equal(documentSections('```md\n## 假标题\n```\n## 真标题')[0].title, '真标题');
});

test('literal assertions require unique declarations; templates bind only to collected source location', () => {
  const file = {
    path: 'test/a.test.ts',
    testDefinitions: [
      { title: 'case %s', line: 20 },
      { title: 'same', line: 30 },
      { title: 'same', line: 40 },
      { title: 'literal', line: 50 },
    ],
  };
  const group = {
    id: 'g',
    file: file.path,
    status: 'pass',
    inputFreshness: 'matched',
    collection: [
      { index: 0, title: 'case one', location: { line: 20 } },
      { index: 1, title: 'case two', location: { line: 20 } },
      { index: 2, title: 'literal' },
    ],
    cases: [0, 1, 2].map((i) => ({
      fileCaseIndex: i,
      caseId: `c${i}`,
      status: 'passed',
      title: ['case one', 'case two', 'literal'][i],
    })),
  };
  const ref = (t) => `${file.path}#case:${encodeURIComponent(t)}`;
  assert.equal(
    bindAssertion(ref('case %s'), [file], { schemaVersion: 2, groups: [group] }).executions.length,
    2,
  );
  assert.equal(
    bindAssertion(ref('literal'), [file], { schemaVersion: 2, groups: [group] }).executions.length,
    1,
  );
  assert.equal(
    bindAssertion(ref('same'), [file], { schemaVersion: 2, groups: [group] }).state,
    'ambiguous',
  );
  assert.equal(
    bindAssertion(ref('case %s'), [file], { schemaVersion: 1, groups: [group] }).state,
    'located',
  );
  group.inputFreshness = 'stale';
  assert.equal(
    bindAssertion(ref('case %s'), [file], { schemaVersion: 2, groups: [group] }).executions.length,
    0,
  );
  group.inputFreshness = 'matched';
  group.collection[0].location.line = 21;
  group.collection[1].location.line = 21;
  assert.equal(
    bindAssertion(ref('case %s'), [file], { schemaVersion: 2, groups: [group] }).executions.length,
    0,
  );
});

test('relations stay local to each claim and reject broken scenarios without borrowing global passes', () => {
  const doc = {
    id: 'd',
    body: '<a id="scenario-a"></a>\n## 标题\n解释',
    metadata: { viewType: 'call-flow' },
    rows: [
      {
        id: 'E-A-01',
        code: '`src/a.ts#Run`',
        test: '`test/a.test.ts#case:literal`',
        claim: 'call',
      },
    ],
  };
  const data = buildRelations(
    {
      documents: [doc],
      inventory: {
        files: [{ path: 'test/a.test.ts', testDefinitions: [{ title: 'literal', line: 2 }] }],
      },
      scopedRuns: { schemaVersion: 2, groups: [] },
    },
    [{ id: 's', docId: 'd', anchor: 'scenario-a', title: '失败', edgeIds: ['E-A-01'] }],
  );
  assert.equal(data.claims[0].assertions[0].state, 'located');
  assert.deepEqual(relationErrors(data, [doc]), []);
  data.scenarios[0].anchor = 'missing';
  assert.match(relationErrors(data, [doc]).join(' '), /anchor/u);
});

test('pilot linkage requires an actual full test identity and matching inputs, never a guessed legacy scenario', () => {
  const ref = 'alembic-agent-architecture-atlas/test/pilot.test.ts#case:success%3A%20done';
  const catalog = {
    documents: [
      {
        id: 'd',
        body: `\`${ref}\``,
        metadata: {},
        rows: [{ id: 'E-P-01', code: '`src/a.ts`', test: `\`${ref}\`` }],
      },
    ],
    inventory: { files: [] },
    pilot: {
      status: 'pass',
      checkedAt: 'now',
      scenarios: [{ id: 'success', status: 'pass', fullName: 'suite success: done' }],
    },
    pilotFreshness: 'matched',
  };
  const assertion = () => buildRelations(catalog).claims[0].assertions[0];
  assert.equal(assertion().pilotScenario.id, 'success');
  catalog.pilotFreshness = 'stale';
  assert.equal(assertion().pilotScenario, undefined);
  catalog.pilotFreshness = 'matched';
  delete catalog.pilot.scenarios[0].fullName;
  assert.equal(assertion().pilotScenario, undefined);
});

test('two declarations on one line cannot lend one passing result to the other', () => {
  const file = {
    path: 'test/a.test.ts',
    testDefinitions: [
      { title: 'A', line: 20, column: 1, parameterized: false },
      { title: 'B', line: 20, column: 30, parameterized: false },
    ],
  };
  const g = {
    id: 'g',
    file: file.path,
    status: 'pass',
    inputFreshness: 'matched',
    collection: [{ index: 0, title: 'A', location: { line: 20, column: 1 } }],
    cases: [{ fileCaseIndex: 0, caseId: 'a', title: 'A', status: 'passed' }],
  };
  assert.equal(
    bindAssertion('test/a.test.ts#case:B', [file], { schemaVersion: 2, groups: [g] }).executions
      .length,
    0,
  );
  assert.equal(
    bindAssertion('test/a.test.ts#case:A', [file], { schemaVersion: 2, groups: [g] }).executions
      .length,
    1,
  );
});

test('parameterized cases use the real registration call site, not the each table start', async () => {
  const { parseCode } = await import('../scripts/atlas-lib.mjs');
  const parsed = parseCode("it.each([\n  'one', 'two'\n])('case %s', () => {});", 'test/a.test.ts');
  assert.deepEqual(parsed.testDefinitions[0].callLocation, { line: 3, column: 2 });
  const f = { path: 'test/a.test.ts', testDefinitions: parsed.testDefinitions };
  const group = {
    id: 'g',
    file: f.path,
    inputFreshness: 'matched',
    status: 'pass',
    collection: [{ index: 0, title: 'case one', location: { line: 3, column: 2 } }],
    cases: [{ fileCaseIndex: 0, caseId: 'c', title: 'case one', status: 'passed' }],
  };
  assert.equal(
    bindAssertion('test/a.test.ts#case:case%20%25s', [f], { schemaVersion: 2, groups: [group] })
      .executions.length,
    1,
  );
});
