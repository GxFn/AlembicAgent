import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['alembic-dev'],
    alias: [
      { find: /^#agent\/(.*)$/u, replacement: `${projectRoot}src/agent/$1` },
      { find: /^#ai\/(.*)$/u, replacement: `${projectRoot}src/ai/$1` },
      { find: /^#shared\/(.*)$/u, replacement: `${projectRoot}src/shared/$1` },
      { find: /^#tools\/(.*)$/u, replacement: `${projectRoot}src/tools/$1` },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 10000,
    coverage: {
      provider: 'v8',
      // Ratchet floor, pinned just below the 2026-06-19 baseline measured over the
      // files the suite imports (statements 52.89 / branches 43.21 / functions 57.3
      // / lines 52.94). Coverage may only climb from here: raise these as suites are
      // added, and never lower a threshold without a recorded reason. Enable with
      // `vitest run --coverage` (requires the @vitest/coverage-v8 devDep).
      thresholds: {
        statements: 52,
        branches: 42,
        functions: 56,
        lines: 52,
      },
    },
  },
});
