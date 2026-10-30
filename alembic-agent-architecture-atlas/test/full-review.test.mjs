import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFullReview } from '../scripts/full-review.mjs';

const sha = `sha256:${'a'.repeat(64)}`;
const target = { path: 'src/a.ts', sha256: sha, lines: 8 };
const file = {
  path: target.path,
  sha256: sha,
  lineCount: 8,
  readingDepth: 'full',
  reviewMethod: 'current-full-text',
  role: '公开入口',
  flow: '输入验证后返回结果',
  reviewPage: 'maps/a.md',
  segments: [
    { start: 1, end: 4, summary: '输入合同与归一化' },
    { start: 5, end: 8, summary: '拒绝路径和结果返回' },
  ],
  branches: [
    {
      id: 'A-1',
      condition: '输入缺失',
      behavior: '返回拒绝',
      sideEffects: '无执行',
      recovery: '补齐输入',
      codeRef: 'src/a.ts#run',
      verification: 'uncovered',
      gap: '没有定位到对应断言',
      testRefs: [],
    },
  ],
};
const record = (files) => ({ schemaVersion: 1, baselineSnapshot: 'v5', files });
test('a full review requires exact target identities and continuous meaningful source sections', () => {
  assert.deepEqual(validateFullReview(record([file]), [target], [target]), []);
  for (const bad of [
    {
      ...file,
      segments: [
        { start: 1, end: 3, summary: '头部' },
        { start: 5, end: 8, summary: '尾部' },
      ],
    },
    {
      ...file,
      segments: [
        { start: 1, end: 5, summary: '头部' },
        { start: 5, end: 8, summary: '尾部' },
      ],
    },
    { ...file, segments: [{ start: 1, end: 8, summary: '' }] },
    { ...file, readingDepth: 'partial' },
    { ...file, reviewMethod: 'delta-only' },
    { ...file, sha256: `sha256:${'b'.repeat(64)}` },
    { ...file, lineCount: 7 },
  ]) {
    assert.ok(validateFullReview(record([bad]), [target], [target]).length);
  }
  assert.ok(validateFullReview(record([]), [target], [target]).length);
  assert.ok(validateFullReview(record([file, file]), [target], [target]).length);
});
test('branch evidence cannot pretend a missing assertion was located or hide an uncovered reason', () => {
  const branch = file.branches[0];
  for (const bad of [
    { ...branch, verification: 'located' },
    { ...branch, gap: '' },
    { ...branch, recovery: '' },
    { ...branch, codeRef: '../other.ts#run' },
  ]) {
    assert.ok(
      validateFullReview(record([{ ...file, branches: [bad] }]), [target], [target]).length,
    );
  }
  const located = {
    ...branch,
    verification: 'located',
    testRefs: [
      {
        ref: 'test/a.test.ts#case:rejects',
        title: 'rejects',
        assertion: '缺输入返回拒绝',
        boundary: '直接公开入口，受控输入',
      },
    ],
  };
  assert.deepEqual(
    validateFullReview(record([{ ...file, branches: [located] }]), [target], [target]),
    [],
  );
});
