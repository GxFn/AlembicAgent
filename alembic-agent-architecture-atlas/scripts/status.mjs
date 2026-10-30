import { loadAtlas } from './atlas-lib.mjs';

const catalog = loadAtlas();
const i = process.argv.indexOf('--baseline');
if (i >= 0) {
  const { buildHealth } = await import('./maintenance.mjs');
  const baseline = catalog.history.find((s) => s.id === process.argv[i + 1]);
  if (!baseline) {
    throw new Error('Unknown baseline snapshot');
  }
  catalog.health = buildHealth(catalog, baseline);
}
console.log(JSON.stringify(catalog.health, null, 2));
