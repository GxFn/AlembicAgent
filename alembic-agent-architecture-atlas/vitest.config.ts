import path from 'node:path';
import { defineConfig } from 'vitest/config';

const productRoot = path.resolve(import.meta.dirname, '..');
export default defineConfig({
  resolve: {
    conditions: ['alembic-dev'],
    alias: [
      { find: /^#agent\/(.*)$/u, replacement: `${productRoot}/src/agent/$1` },
      { find: /^#ai\/(.*)$/u, replacement: `${productRoot}/src/ai/$1` },
      { find: /^#tools\/(.*)$/u, replacement: `${productRoot}/src/tools/$1` },
      { find: /^#shared\/(.*)$/u, replacement: `${productRoot}/src/shared/$1` },
    ],
  },
  test: {
    include: ['test/pilot.test.ts', 'test/reader.test.ts', 'test/loader.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
    reporters: ['default'],
  },
});
