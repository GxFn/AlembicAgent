import { createHash } from 'node:crypto';

/** CLI正典保留完整AST证据；网页只得到其实际读取的字段，历史正文独立按需加载。 */
function browserInventory(inventory) {
  return {
    ...inventory,
    files: inventory.files.map(({ path, kind, sha256, lines, symbols }) => ({
      path,
      kind,
      sha256,
      lines,
      symbols,
    })),
  };
}
function browserReading(reading) {
  return {
    path: reading.path,
    sha256: reading.sha256,
    reading: reading.reading,
    freshness: reading.freshness,
    role: reading.role,
    basis: reading.basis,
    flow: reading.flow,
    tests: reading.tests,
    reviewPage: reading.reviewPage,
    provenance: reading.provenance,
    risks: reading.risks,
  };
}
export function buildBrowserAssets(catalog) {
  const assets = new Map();
  function asset(kind, data) {
    const text = JSON.stringify({ schemaVersion: 1, kind, data });
    const digest = createHash('sha256').update(text).digest('hex');
    const url = `atlas-data/${kind}-${digest}.json`;
    assets.set(url, text);
    return { url, sha256: `sha256:${digest}`, bytes: Buffer.byteLength(text) };
  }
  const { history, reviewRecords: _currentReview, ...current } = catalog;
  const currentAsset = asset('current', {
    ...current,
    inventory: browserInventory(current.inventory),
    readings: current.readings.map(browserReading),
  });
  const ids = new Set();
  const summaries = history.map((s) => {
    if (!/^[a-z0-9][a-z0-9-]{2,60}$/u.test(s.id ?? '')) {
      throw new Error('Invalid snapshot identity');
    }
    if (ids.has(s.id)) {
      throw new Error('Duplicate snapshot identity');
    }
    ids.add(s.id);
    const { reviewRecords: _review, readingOrigins: _origins, integrity, ...view } = s;
    return {
      id: s.id,
      capturedAt: s.capturedAt,
      baselineCommit: s.baselineCommit,
      sourceFiles: s.sourceFiles,
      documents: s.documents.length,
      diagrams: s.documents.flatMap((d) => d.diagrams).length,
      asset: asset('snapshot', {
        ...view,
        ...(integrity
          ? {
              canonicalIntegrity: integrity,
              projectionNote:
                'Browser projection uses its own bootstrap asset digest; canonicalIntegrity identifies the full repository snapshot.',
            }
          : {}),
        inventory: browserInventory(s.inventory),
        readings: s.readings?.map(browserReading),
      }),
    };
  });
  return {
    bootstrap: {
      schemaVersion: 2,
      kind: 'alembic-atlas-bootstrap',
      checkedAt: catalog.checkedAt,
      currentAsset,
      history: summaries,
    },
    assets,
  };
}
