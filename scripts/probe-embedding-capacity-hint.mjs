// AD5 measurement probe (Agent half): demonstrates that the embedding
// capacity hint is readable through the built package surface and reflects
// provider configuration. BEFORE this leg, Core BatchEmbedder had no
// provider-aware signal (hardcoded p-limit(2)); AFTER, the injected provider
// object itself carries getEmbeddingCapacityHint(). Run after `npm run build`:
//   node scripts/probe-embedding-capacity-hint.mjs
// Expose-only: the probe constructs providers locally and never performs
// network calls or changes throttling behavior.

import process from 'node:process';

const { GoogleGeminiProvider, OpenAiProvider } = await import('../dist/ai/index.js');

delete process.env.ALEMBIC_AI_MAX_CONCURRENCY;
delete process.env.ALEMBIC_GEMINI_MAX_CONCURRENCY;

const failures = [];
const rows = [];

function probe(label, hint, expected) {
  rows.push({ label, hint });
  for (const [key, value] of Object.entries(expected)) {
    if (hint[key] !== value) {
      failures.push(`${label}: expected ${key}=${value}, got ${hint[key]}`);
    }
  }
}

probe(
  'openai default (no config, no env)',
  new OpenAiProvider({ apiKey: 'probe' }).getEmbeddingCapacityHint(),
  { provider: 'openai', maxInFlightEmbeddings: 4, source: 'conservative-default' }
);
probe(
  'gemini default (provider-level conservative 2)',
  new GoogleGeminiProvider({ apiKey: 'probe' }).getEmbeddingCapacityHint(),
  { provider: 'google', maxInFlightEmbeddings: 2, source: 'conservative-default' }
);
probe(
  'openai explicit config maxConcurrency=7',
  new OpenAiProvider({ apiKey: 'probe', maxConcurrency: 7 }).getEmbeddingCapacityHint(),
  { maxInFlightEmbeddings: 7, source: 'provider-config' }
);

process.env.ALEMBIC_AI_MAX_CONCURRENCY = '3';
probe(
  'openai with ALEMBIC_AI_MAX_CONCURRENCY=3 (construction-time read)',
  new OpenAiProvider({ apiKey: 'probe' }).getEmbeddingCapacityHint(),
  { maxInFlightEmbeddings: 3, source: 'environment' }
);
process.env.ALEMBIC_GEMINI_MAX_CONCURRENCY = '6';
probe(
  'gemini with ALEMBIC_GEMINI_MAX_CONCURRENCY=6 winning over global=3',
  new GoogleGeminiProvider({ apiKey: 'probe' }).getEmbeddingCapacityHint(),
  { maxInFlightEmbeddings: 6, source: 'environment' }
);
delete process.env.ALEMBIC_AI_MAX_CONCURRENCY;
delete process.env.ALEMBIC_GEMINI_MAX_CONCURRENCY;

for (const row of rows) {
  process.stdout.write(`${row.label}: ${JSON.stringify(row.hint)}\n`);
}

if (failures.length > 0) {
  process.stderr.write(`Embedding capacity hint probe failed: ${failures.length} issue(s).\n`);
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `Embedding capacity hint probe OK: ${rows.length} probes readable through dist/ai, values reflect provider config; no throttling behavior touched.\n`
);
