const text = (value) => typeof value === 'string' && value.trim().length > 0;
const relative = (value) =>
  text(value) &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.split('/').includes('..');

/** 完整分段与来源身份是可检查的下限，不把机械行覆盖当作人类语义审阅或测试覆盖率。 */
export function validateFullReview(record, targets, currentFiles) {
  if (
    record?.schemaVersion !== 1 ||
    !text(record.baselineSnapshot) ||
    !Array.isArray(record.files)
  ) {
    return ['Invalid full review record'];
  }
  const errors = [];
  const expected = new Map(targets.map((f) => [f.path, f]));
  const current = new Map(currentFiles.map((f) => [f.path, f]));
  const seen = new Set();
  for (const file of record.files) {
    const source = current.get(file?.path);
    if (!file || seen.has(file.path) || !expected.has(file.path) || !source) {
      errors.push(`Unexpected, missing or duplicate file: ${file?.path}`);
      continue;
    }
    seen.add(file.path);
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(file.sha256) ||
      file.sha256 !== source.sha256 ||
      file.lineCount !== source.lines ||
      file.readingDepth !== 'full' ||
      file.reviewMethod !== 'current-full-text' ||
      !text(file.role) ||
      !text(file.flow) ||
      !relative(file.reviewPage)
    ) {
      errors.push(`Full review identity/depth mismatch: ${file.path}`);
    }
    let next = 1;
    if (!Array.isArray(file.segments) || !file.segments.length) {
      errors.push(`Missing source segments: ${file.path}`);
    } else {
      for (const segment of file.segments) {
        if (
          !segment ||
          segment.start !== next ||
          !Number.isSafeInteger(segment.end) ||
          segment.end < next ||
          segment.end > file.lineCount ||
          !text(segment.summary)
        ) {
          errors.push(`Gap, overlap or empty source segment: ${file.path}:${next}`);
          break;
        }
        next = segment.end + 1;
      }
      if (next !== file.lineCount + 1) {
        errors.push(`Incomplete source coverage: ${file.path}`);
      }
    }
    if (!Array.isArray(file.branches)) {
      errors.push(`Missing branch review: ${file.path}`);
      continue;
    }
    const branchIds = new Set();
    for (const branch of file.branches) {
      if (
        !branch ||
        !text(branch.id) ||
        branchIds.has(branch.id) ||
        !['condition', 'behavior', 'sideEffects', 'recovery'].every((k) => text(branch[k])) ||
        !relative(branch.codeRef) ||
        !branch.codeRef.startsWith('src/') ||
        !branch.codeRef.includes('#') ||
        !Array.isArray(branch.testRefs) ||
        !['located', 'uncovered'].includes(branch.verification)
      ) {
        errors.push(`Invalid branch review: ${file.path}/${branch?.id}`);
        continue;
      }
      branchIds.add(branch.id);
      if (branch.verification === 'uncovered' && !text(branch.gap)) {
        errors.push(`Uncovered branch needs a reason: ${branch.id}`);
      }
      if (branch.verification === 'located' && !branch.testRefs.length) {
        errors.push(`Located branch lacks an assertion: ${branch.id}`);
      }
      for (const test of branch.testRefs) {
        if (
          !test ||
          !relative(test.ref) ||
          !test.ref.includes('#case:') ||
          !['title', 'assertion', 'boundary'].every((k) => text(test[k]))
        ) {
          errors.push(`Invalid assertion locator: ${branch.id}`);
        }
      }
    }
  }
  for (const file of expected.keys()) {
    if (!seen.has(file)) {
      errors.push(`Full review missing: ${file}`);
    }
  }
  return errors;
}
