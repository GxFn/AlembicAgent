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
  },
});
