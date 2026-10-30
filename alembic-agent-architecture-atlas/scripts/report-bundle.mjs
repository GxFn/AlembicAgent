import fs from 'node:fs';
import path from 'node:path';
import { atlasRoot } from './atlas-lib.mjs';

const root = path.join(atlasRoot, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.vite/manifest.json'), 'utf8'));
const visited = new Set();
function visit(key) {
  if (visited.has(key)) {
    return;
  }
  const item = manifest[key];
  if (!item) {
    throw new Error(`Missing static build entry: ${key}`);
  }
  visited.add(key);
  for (const imported of item.imports ?? []) {
    visit(imported);
  }
}
for (const [key, item] of Object.entries(manifest)) {
  if (item.isEntry) {
    visit(key);
  }
}
const staticFiles = [...visited]
  .map((key) => manifest[key].file)
  .filter((file) => file.endsWith('.js'));
const initialJavaScriptBytes = staticFiles.reduce(
  (n, file) => n + fs.statSync(path.join(root, file)).size,
  0,
);
const bootstrap = JSON.parse(
  fs.readFileSync(path.join(atlasRoot, 'evidence/live/bootstrap.json'), 'utf8'),
);
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      initialJavaScriptBytes,
      staticFiles,
      bootstrapBytes: Buffer.byteLength(JSON.stringify(bootstrap)),
      currentDataBytes: bootstrap.currentAsset.bytes,
      historyAssets: bootstrap.history.map((s) => ({ id: s.id, bytes: s.asset.bytes })),
      meaning:
        'Static JS closure from Vite manifest. Current JSON is fetched once; historical JSON and graph engines are loaded on demand. This is an artifact-size report, not a network timing claim.',
    },
    null,
    2,
  ),
);
