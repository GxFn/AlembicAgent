import fs from 'node:fs';
import path from 'node:path';
import { atlasRoot, loadAtlas, validateRenderReceipt } from './atlas-lib.mjs';
import { latestRenderErrors } from './render-state.mjs';

const catalog = loadAtlas();
const expected = catalog.documents.flatMap((d) => d.diagrams);
let receipt;
try {
  receipt = JSON.parse(
    fs.readFileSync(path.join(atlasRoot, 'evidence/render/current.json'), 'utf8'),
  );
} catch {
  /* 缺回执保持未验证，不伪造渲染。 */
}
const errors = [
  ...validateRenderReceipt(receipt, expected, catalog.rendererVersion),
  ...latestRenderErrors(catalog.renderAttempt, expected, catalog.rendererVersion),
];
console.log(
  JSON.stringify(
    {
      ok: errors.length === 0,
      mode: 'browser-receipt-revalidation',
      rendererVersion: catalog.rendererVersion,
      diagrams: expected.length,
      checkedAt: receipt?.checkedAt ?? null,
      errors,
    },
    null,
    2,
  ),
);
if (errors.length) {
  process.exitCode = 1;
}
