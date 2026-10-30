import fs from 'node:fs';
import path from 'node:path';
import { atlasRoot, loadAtlas, safeFile, validateRenderReceipt } from './atlas-lib.mjs';
import { scopedExecutionCurrentErrors } from './evidence.mjs';
import { sealSnapshot } from './maintenance.mjs';
import { latestRenderErrors } from './render-state.mjs';
import { snapshotExists, storeSnapshot } from './snapshot-store.mjs';

const i = process.argv.indexOf('--id');
const id = process.argv[i + 1];
if (i < 0 || !/^[a-z0-9][a-z0-9-]{2,60}$/u.test(id ?? '')) {
  throw new Error('Use --id <unique-lowercase-snapshot> after reviewing the source.');
}
const storeRoot = safeFile(atlasRoot, 'evidence/snapshots');
if (snapshotExists(storeRoot, id)) {
  throw new Error('Immutable snapshot already exists; choose a new reviewed snapshot id.');
}
const catalog = loadAtlas();
if (!catalog.documents.length || catalog.documents.some((d) => d.errors.length)) {
  throw new Error('Review document errors and source drift before taking a snapshot.');
}
const renderErrors = validateRenderReceipt(
  catalog.renderReceipt,
  catalog.documents.flatMap((d) => d.diagrams),
  catalog.rendererVersion,
);
renderErrors.push(
  ...latestRenderErrors(
    catalog.renderAttempt,
    catalog.documents.flatMap((d) => d.diagrams),
    catalog.rendererVersion,
  ),
);
if (
  catalog.evidenceDiagnostics.length ||
  scopedExecutionCurrentErrors(catalog.scopedRuns).length ||
  renderErrors.length ||
  catalog.pilotFreshness !== 'matched'
) {
  throw new Error(
    'Current render, pilot and any recorded scoped execution are required before snapshot.',
  );
}
const snapshot = sealSnapshot({
  schemaVersion: 2,
  id,
  capturedAt: new Date().toISOString(),
  baselineCommit: catalog.git.commit,
  sourceFingerprint: catalog.inventory.fingerprint,
  sourceFiles: catalog.inventory.files.filter((f) => f.kind === 'source').length,
  documents: catalog.documents,
  inventory: catalog.inventory,
  readings: catalog.readings,
  readingSchemaVersion: catalog.readingSchemaVersion,
  reviewRecords: catalog.reviewRecords,
  readingOrigins: catalog.history
    .filter((s) => catalog.readings.some((r) => r.provenance?.snapshotId === s.id))
    .map((s) => ({
      id: s.id,
      readings: s.readings.map((r) => ({ path: r.path, sha256: r.sha256, reading: r.reading })),
    })),
  config: catalog.config,
  publicApi: catalog.publicApi,
  scopedRuns: catalog.scopedRuns,
  health: catalog.health,
  relations: catalog.relations,
  rendererVersion: catalog.rendererVersion,
  renderAttempt: catalog.renderAttempt,
  renderReceipt: catalog.renderReceipt,
  pilot: catalog.pilot,
  note: 'A reading snapshot, not product acceptance. Tests and render results retain their own scope.',
});
storeSnapshot(storeRoot, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`));
fs.writeFileSync(
  path.join(atlasRoot, 'evidence/current.json'),
  `${JSON.stringify(
    { schemaVersion: 1, id, baselineCommit: catalog.git.commit, capturedAt: snapshot.capturedAt },
    null,
    2,
  )}\n`,
);
console.log(`Saved immutable reading snapshot ${id}`);
