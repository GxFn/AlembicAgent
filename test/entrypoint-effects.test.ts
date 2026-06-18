/**
 * P2 AD6 Agent leg — no-undeclared-effects snapshot tests.
 *
 * Declared effects live in docs/entrypoint-effects.md:
 *  - package facades: importing performs NO work (AD4);
 *  - network ONLY via injected/configured provider transports;
 *  - runtime persistence only under caller-provided roots
 *    (pathGuard-checked .asd paths);
 *  - the SD-4 MemoryStore read uses the caller-injected DB handle.
 * These snapshots prove the declarations on representative calls using temp
 * roots and a stubbed fetch — never a real provider call. The import probe
 * runs against dist/ (built earlier in the npm run check chain).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from '../src/agent/context/ConversationStore.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The 13 exact public exports (G5 boundary) as dist entry files.
const FACADE_DIST_FILES = [
  'dist/index.js',
  'dist/agent/index.js',
  'dist/agent/service/index.js',
  'dist/agent/runtime/index.js',
  'dist/agent/prompts/index.js',
  'dist/agent/domain/index.js',
  'dist/agent/tasks/index.js',
  'dist/agent/profiles/index.js',
  'dist/ai/index.js',
  'dist/tools/runtime/index.js',
  'dist/tools/terminal/index.js',
  'dist/agent/memory/index.js',
  'dist/agent/context/index.js',
];

function listTree(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) {
    return out;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    out.push(entry.name);
    if (entry.isDirectory()) {
      out.push(...listTree(path.join(root, entry.name)).map((p) => path.join(entry.name, p)));
    }
  }
  return out.sort();
}

describe('entrypoint effects (AD6 inflow/outflow audit)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('importing all 14 package facades performs zero filesystem work in cwd', () => {
    const distRoot = path.join(repoRoot, FACADE_DIST_FILES[0]);
    if (!fs.existsSync(distRoot)) {
      throw new Error('dist/ missing — run npm run build first (npm run check builds it)');
    }
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-agent-import-fx-'));
    try {
      // Import every facade in a clean child process whose cwd is an empty
      // temp dir; any import-time write lands there (or throws) and fails.
      const script = FACADE_DIST_FILES.map(
        (file) => `await import(${JSON.stringify(path.join(repoRoot, file))});`
      )
        .concat("console.log('imports-ok');")
        .join('\n');
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: tmpCwd,
        encoding: 'utf8',
      });
      expect(stdout).toContain('imports-ok');
      expect(listTree(tmpCwd)).toEqual([]);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('routes provider network calls only through the configured transport fetch', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'stubbed' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          text: async () => '',
        } as Response;
      })
    );
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-agent-net-fx-'));
    try {
      const provider = new OpenAiProvider({ apiKey: 'stub-key', baseUrl: 'https://stub.local/v1' });
      const reply = await provider.chat('declared-effects probe');

      expect(reply).toBe('stubbed');
      // The ONLY network path is the configured transport endpoint.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((url) => url.startsWith('https://stub.local/v1'))).toBe(true);
      expect(listTree(tmpCwd)).toEqual([]);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('persists conversation state only under the caller-provided project root', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-agent-store-fx-'));
    const outsideProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'ad6-agent-outside-'));
    try {
      const store = new ConversationStore(tmpRoot);
      store.append('ad6-probe', { role: 'user', content: 'declared persistence probe' });

      const written = listTree(tmpRoot);
      expect(written.length).toBeGreaterThan(0);
      expect(written.every((p) => p === '.asd' || p.startsWith('.asd'))).toBe(true);
      expect(listTree(outsideProbe)).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outsideProbe, { recursive: true, force: true });
    }
  });
});
