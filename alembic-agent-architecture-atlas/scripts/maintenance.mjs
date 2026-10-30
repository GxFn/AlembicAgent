import { createHash } from 'node:crypto';

const text = (value) => typeof value === 'string' && value.length > 0;
const sha = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const relative = (value) =>
  text(value) &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.split('/').includes('..');
const date = (value) => text(value) && Number.isFinite(Date.parse(value));
function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}
export const digestEvidence = (value) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;

/** 新回执对采集集合内的精确身份负责；同名参数案例可以不同，重复序号不能伪增通过数。 */
export function validateExecutionV2(value) {
  if (value?.schemaVersion !== 2 || !Array.isArray(value.groups) || !value.groups.length) {
    return ['Invalid v2 execution report'];
  }
  const ids = new Set();
  for (const g of value.groups) {
    if (
      !g ||
      !text(g.id) ||
      ids.has(g.id) ||
      !relative(g.file) ||
      !Array.isArray(g.sourcePatterns) ||
      !g.sourcePatterns.length ||
      !g.sourcePatterns.every(relative) ||
      !Array.isArray(g.sourceFiles) ||
      !g.sourceFiles.length ||
      !g.sourceFiles.every(relative) ||
      !sha(g.sourceFingerprint) ||
      !sha(g.beforeFingerprint) ||
      (!sha(g.afterFingerprint) &&
        !(
          g.status !== 'pass' &&
          g.afterFingerprint === null &&
          g.afterInputStatus === 'unavailable'
        )) ||
      !sha(g.harnessFingerprint) ||
      !Array.isArray(g.command) ||
      !g.command.length ||
      !g.command.every(text) ||
      !date(g.startedAt) ||
      !date(g.finishedAt) ||
      Date.parse(g.finishedAt) < Date.parse(g.startedAt) ||
      !text(g.environment?.node) ||
      !text(g.environment?.runner) ||
      !text(g.environment?.runnerVersion) ||
      !['pass', 'fail', 'aborted', 'running'].includes(g.status) ||
      !Array.isArray(g.collection) ||
      !Array.isArray(g.cases)
    ) {
      return [`Invalid execution identity: ${g?.id ?? 'unknown'}`];
    }
    ids.add(g.id);
    if (
      g.collection.some(
        (c, i) =>
          !c ||
          c.index !== i ||
          !text(c.title) ||
          !text(c.fullName) ||
          !Array.isArray(c.ancestorTitles) ||
          !c.ancestorTitles.every(text),
      ) ||
      digestEvidence(g.collection) !== g.collectionDigest
    ) {
      return [`Invalid test collection: ${g.id}`];
    }
    const seen = new Set();
    for (const c of g.cases) {
      const original = g.collection[c?.fileCaseIndex];
      if (
        !c ||
        !Number.isSafeInteger(c.fileCaseIndex) ||
        c.fileCaseIndex < 0 ||
        !original ||
        seen.has(c.fileCaseIndex) ||
        c.caseId !== digestEvidence([g.collectionDigest, c.fileCaseIndex]) ||
        c.title !== original.title ||
        c.fullName !== original.fullName ||
        JSON.stringify(c.ancestorTitles) !== JSON.stringify(original.ancestorTitles) ||
        !['passed', 'failed'].includes(c.status)
      ) {
        return [`Duplicated or mismatched case: ${g.id}`];
      }
      seen.add(c.fileCaseIndex);
    }
    if (
      !['passed', 'failed', 'skipped'].every(
        (key) => Number.isSafeInteger(g[key]) && g[key] >= 0,
      ) ||
      g.passed !== g.cases.filter((c) => c.status === 'passed').length ||
      g.failed !== g.cases.filter((c) => c.status === 'failed').length ||
      g.skipped !== g.collection.length - g.cases.length ||
      digestEvidence({ cases: g.cases, exitCode: g.exitCode }) !== g.resultDigest
    ) {
      return [`Execution result digest/count mismatch: ${g.id}`];
    }
    if (
      g.status === 'pass' &&
      (g.exitCode !== 0 ||
        !g.passed ||
        g.failed ||
        !g.inputStableDuringRun ||
        g.beforeFingerprint !== g.afterFingerprint ||
        g.sourceFingerprint !== g.beforeFingerprint)
    ) {
      return [`Passing execution has unbound inputs: ${g.id}`];
    }
    if (g.status !== 'running') {
      const artifactErrors = executionArtifactErrors(g);
      if (artifactErrors.length) {
        return artifactErrors;
      }
    }
  }
  return [];
}

export function validateReadings(value) {
  if (![1, 2].includes(value?.schemaVersion) || !Array.isArray(value.files)) {
    return ['Invalid reading record'];
  }
  const seen = new Set();
  for (const f of value.files) {
    if (!f || !relative(f.path) || !sha(f.sha256) || seen.has(f.path)) {
      return ['Invalid or duplicated reading path/hash'];
    }
    seen.add(f.path);
    if (value.schemaVersion === 1) {
      continue;
    }
    if (
      !['full', 'partial', 'indexed'].includes(f.reading) ||
      !['fresh', 'inherited', 'unreviewed'].includes(f.freshness) ||
      !text(f.role) ||
      !text(f.basis)
    ) {
      return [`Invalid reading depth: ${f.path}`];
    }
    const p = f.provenance;
    if (!p || !['retained', 'reviewed', 'delta', 'indexed'].includes(p.kind)) {
      return [`Missing reading provenance: ${f.path}`];
    }
    if (['retained', 'delta'].includes(p.kind) && (!text(p.snapshotId) || !sha(p.previousSha256))) {
      return [`Invalid inherited reading: ${f.path}`];
    }
    if (
      ['reviewed', 'delta'].includes(p.kind) &&
      (!relative(f.reviewRecord) || !relative(f.reviewPage))
    ) {
      return [`Reading review links missing: ${f.path}`];
    }
    if (p.kind === 'indexed' && (f.reading !== 'indexed' || f.freshness !== 'unreviewed')) {
      return [`Index cannot claim semantic reading: ${f.path}`];
    }
  }
  return [];
}

export function sealSnapshot(value) {
  const { integrity: _old, ...body } = value;
  return {
    ...body,
    integrity: { algorithm: 'sha256-canonical-json-v1', digest: digestEvidence(body) },
  };
}
export function verifySnapshotIntegrity(value) {
  if (value?.schemaVersion === 1) {
    return [];
  }
  const { integrity, ...body } = value ?? {};
  return integrity?.algorithm === 'sha256-canonical-json-v1' &&
    integrity.digest === digestEvidence(body)
    ? []
    : ['Snapshot integrity mismatch or missing manifest'];
}

function matches(pattern, file) {
  if (pattern === file) {
    return true;
  }
  if (!pattern.includes('*')) {
    return false;
  }
  const expression = pattern
    .split('**/')
    .map((part) =>
      part
        .split('*')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('[^/]*'),
    )
    .join('(?:.*/)?');
  return new RegExp(`^${expression}$`, 'u').test(file);
}
/** 影响报告是基于声明输入与直接引用的保守候选，不冒充动态调用或精确覆盖率。 */
export function buildHealth(catalog, baseline) {
  const old = new Map((baseline?.inventory?.files ?? []).map((f) => [f.path, f]));
  const current = new Map(catalog.inventory.files.map((f) => [f.path, f]));
  const changes = [];
  for (const f of current.values()) {
    const before = old.get(f.path);
    if (!before || before.sha256 !== f.sha256) {
      changes.push({
        path: f.path,
        kind: f.kind,
        status: before ? 'changed' : 'added',
        before: before?.sha256 ?? null,
        after: f.sha256,
      });
    }
  }
  for (const f of old.values()) {
    if (!current.has(f.path)) {
      changes.push({
        path: f.path,
        kind: f.kind,
        status: 'removed',
        before: f.sha256,
        after: null,
      });
    }
  }
  const readings = { matched: 0, stale: 0, missing: 0 };
  const byPath = new Map(catalog.readings.map((r) => [r.path, r]));
  for (const f of current.values()) {
    if (f.kind === 'source') {
      readings[
        !byPath.has(f.path)
          ? 'missing'
          : byPath.get(f.path).sha256 === f.sha256
            ? 'matched'
            : 'stale'
      ]++;
    }
  }
  const impacts = changes.map((change) => ({
    ...change,
    documents: catalog.documents
      .filter(
        (d) =>
          d.inputFiles.includes(change.path) ||
          [
            ...(d.metadata.sourcePaths ?? []),
            ...(d.metadata.testPaths ?? []),
            ...(d.metadata.contractPaths ?? []),
            ...(d.metadata.refreshTriggers ?? []),
          ].some((p) => matches(p, change.path)),
      )
      .map((d) => ({
        id: d.id,
        title: d.metadata.title,
        semantic: d.body.includes(change.path),
        errors: d.errors.length,
      })),
    executionGroups: (catalog.scopedRuns?.groups ?? [])
      .filter(
        (g) =>
          (g.sourceFiles ?? []).includes(change.path) ||
          (g.sourcePatterns ?? []).some((p) => matches(p, change.path)),
      )
      .map((g) => g.id),
  }));
  const oldGraphs = new Map(
    (baseline?.documents ?? []).flatMap((d) => d.diagrams).map((g) => [g.id, g.digest]),
  );
  return {
    schemaVersion: 1,
    sampledAt: catalog.checkedAt,
    commit: catalog.git.commit,
    baseline: baseline?.id ?? null,
    sourceCount: [...current.values()].filter((f) => f.kind === 'source').length,
    readings,
    documents: {
      total: catalog.documents.length,
      matched: catalog.documents.filter((d) => d.freshness === 'matched' && !d.errors.length)
        .length,
      needsReview: catalog.documents.filter((d) => d.freshness !== 'matched' || d.errors.length)
        .length,
    },
    pilot: catalog.pilotFreshness,
    render: catalog.renderFreshness,
    executionGroups: (catalog.scopedRuns?.groups ?? []).map((g) => ({
      id: g.id,
      file: g.file,
      status: g.status,
      freshness: g.inputFreshness,
      scope: g.dependencyMode ?? 'conservative-manifest',
    })),
    changes,
    impacts,
    renderNeeds: catalog.documents
      .flatMap((d) => d.diagrams)
      .filter((g) => oldGraphs.get(g.id) !== g.digest)
      .map((g) => g.id),
    diagnostics: catalog.documents
      .filter((d) => d.errors.length)
      .map((d) => ({
        id: d.id,
        path: d.path,
        title: d.metadata.title,
        primary: [
          ...new Set(
            d.errors.filter(
              (e) => !/(mentioned path|reference) not in fingerprint inputs/u.test(e),
            ),
          ),
        ],
        secondaryCount: d.errors.filter((e) =>
          /(mentioned path|reference) not in fingerprint inputs/u.test(e),
        ).length,
      })),
    meaning:
      'Sampling-time identities and conservative declared-input impacts. Rendering, reading and execution remain separate.',
  };
}

/** 仅校验声明关联；历史读法不回查今天的文件，当前读法必须对上当前库存。 */
export function readingLinkErrors(readings, inventory, documents, history, records) {
  const errors = [];
  const files = new Map(inventory.files.map((f) => [f.path, f]));
  const pages = new Set(documents.map((d) => d.path));
  for (const f of readings) {
    if (!files.has(f.path)) {
      errors.push(`Reading source missing: ${f.path}`);
      continue;
    }
    if (files.get(f.path).sha256 !== f.sha256) {
      errors.push(`Reading source changed: ${f.path}`);
    }
    const p = f.provenance;
    if (!p) {
      continue;
    }
    if (['retained', 'delta'].includes(p.kind)) {
      const previous = history
        .find((s) => s.id === p.snapshotId)
        ?.readings?.find((r) => r.path === f.path);
      if (
        !previous ||
        previous.sha256 !== p.previousSha256 ||
        (p.kind === 'retained' &&
          (f.sha256 !== previous.sha256 ||
            ['indexed', 'partial', 'full'].indexOf(f.reading) >
              ['indexed', 'partial', 'full'].indexOf(previous.reading)))
      ) {
        errors.push(`Reading inheritance mismatch: ${f.path}`);
      }
    }
    if (['reviewed', 'delta'].includes(p.kind)) {
      const proof = records[f.reviewRecord]?.files?.find((r) => r.path === f.path);
      const proofDepth =
        proof?.readingDepth === 'full'
          ? 'full'
          : ['partial', 'verified-delta-with-current-boundaries'].includes(proof?.readingDepth)
            ? 'partial'
            : proof?.readingDepth === 'indexed'
              ? 'indexed'
              : null;
      if (
        !proofDepth ||
        ['indexed', 'partial', 'full'].indexOf(f.reading) >
          ['indexed', 'partial', 'full'].indexOf(proofDepth)
      ) {
        errors.push(`Reading depth exceeds review proof: ${f.path}`);
      }
      if (
        p.kind === 'delta' &&
        (proof?.reviewMethod?.baselineSha256 ??
          proof?.priorSha256 ??
          proof?.priorReading?.sha256) !== p.previousSha256
      ) {
        errors.push(`Reading delta baseline mismatch: ${f.path}`);
      }
      if (!proof || proof.sha256 !== f.sha256 || !pages.has(f.reviewPage)) {
        errors.push(`Reading evidence unavailable: ${f.path}`);
      }
    }
  }
  for (const f of inventory.files) {
    if (!readings.some((r) => r.path === f.path)) {
      errors.push(`Reading record missing: ${f.path}`);
    }
  }
  return errors;
}

/** 这是已记录字段的规范化投影，不是独立原始输出，也不会刷新执行或来源声明。 */
export function normalizedExecutionArtifact(group) {
  return {
    schemaVersion: 2,
    groupId: group?.id,
    collection: structuredClone(group?.collection),
    cases: structuredClone(group?.cases),
    exitCode: group?.exitCode,
  };
}

export function executionArtifactErrors(group, artifact) {
  // 执行器先保存 running，再保存终态。没有终态摘要的运行中组保持未完成，验收门仍拒绝它。
  if (
    artifact === undefined &&
    group?.status === 'running' &&
    group.resultArtifactDigest === undefined
  ) {
    return [];
  }
  try {
    const value = artifact === undefined ? normalizedExecutionArtifact(group) : artifact;
    const expectedLocator = sha(group?.resultArtifactDigest)
      ? `evidence/executions/results/${group.resultArtifactDigest.slice(7)}.json`
      : null;
    if (
      group &&
      value &&
      value.schemaVersion === 2 &&
      value.groupId === group.id &&
      sha(group.resultArtifactDigest) &&
      (group.resultArtifact === undefined || group.resultArtifact === expectedLocator) &&
      digestEvidence(value) === group.resultArtifactDigest &&
      digestEvidence(value.collection) === group.collectionDigest &&
      digestEvidence({ cases: value.cases, exitCode: value.exitCode }) === group.resultDigest
    ) {
      return [];
    }
  } catch {
    // 无法规范化的输入同样是坏证据，不得降级为忽略摘要或信任外部导出。
  }
  return [`Execution artifact mismatch: ${group?.id ?? 'unknown'}`];
}
