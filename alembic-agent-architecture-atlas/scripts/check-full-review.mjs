import fs from 'node:fs';
import path from 'node:path';
import { analyzeRepository, atlasRoot, repositoryRoot, safeFile } from './atlas-lib.mjs';
import { validateFullReview } from './full-review.mjs';
import { readSnapshot } from './snapshot-store.mjs';

const record = JSON.parse(
  fs.readFileSync(path.join(atlasRoot, 'evidence/reviews/source-full-v6.json'), 'utf8'),
);
if (!/^[a-z0-9-]+$/u.test(record.baselineSnapshot ?? '')) {
  throw new Error('Invalid baseline snapshot identity');
}
const baseline = readSnapshot(safeFile(atlasRoot, 'evidence/snapshots'), record.baselineSnapshot);
const targets = baseline.readings.filter(
  (f) => f.path.startsWith('src/') && f.reading === 'partial',
);
const inventory = analyzeRepository(repositoryRoot);
const errors = validateFullReview(record, targets, inventory.files);
for (const file of record.files) {
  try {
    safeFile(atlasRoot, file.reviewPage);
  } catch {
    errors.push(`Missing review page: ${file.path}`);
  }
  for (const branch of file.branches ?? []) {
    const [codePath, symbol] = String(branch.codeRef).split('#');
    if (!inventory.files.find((f) => f.path === codePath)?.symbols.includes(symbol)) {
      errors.push(`Missing branch symbol: ${branch.codeRef}`);
    }
    for (const test of branch.testRefs ?? []) {
      const [testPath, encoded] = String(test.ref).split('#case:');
      let title;
      try {
        title = decodeURIComponent(encoded);
      } catch {
        errors.push(`Bad test locator: ${test.ref}`);
        continue;
      }
      if (
        title !== test.title ||
        !inventory.files.find((f) => f.path === testPath)?.testCases.includes(title)
      ) {
        errors.push(`Missing/mismatched assertion: ${test.ref}`);
      }
    }
  }
}
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  ok: errors.length === 0,
  baselineSnapshot: record.baselineSnapshot,
  files: record.files.length,
  lines: record.files.reduce((n, f) => n + f.lineCount, 0),
  segments: record.files.reduce((n, f) => n + f.segments.length, 0),
  branches: record.files.reduce((n, f) => n + f.branches.length, 0),
  meaning:
    'Current hashes, contiguous semantic-section records, symbols and assertion identities checked. Full reading is not branch test coverage.',
  errors,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) {
  process.exitCode = 1;
}
