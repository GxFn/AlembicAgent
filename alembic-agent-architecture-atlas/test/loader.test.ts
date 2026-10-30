import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AtlasAssetLoader, LatestSelection } from '../src/loader';
import type { AssetRef, Bootstrap, PilotReceipt } from '../src/model';
import { pilotEvidence, readingFreshness } from '../src/model';

const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const content = (kind: string, data: unknown) => JSON.stringify({ schemaVersion: 1, kind, data });
const data = {
  schemaVersion: 1,
  documents: [],
  inventory: { files: [], edges: [], externalEdges: [], unresolved: [], fingerprint: 'x' },
  readings: [],
};
const current = content('current', data),
  old = content('snapshot', { ...data, id: 'old', capturedAt: 'then' });
const ref = (text: string, name: string): AssetRef => ({
  url: `atlas-data/${name}-${sha(text).slice(7)}.json`,
  sha256: sha(text),
  bytes: Buffer.byteLength(text),
});
const bootstrap = {
  schemaVersion: 2,
  kind: 'alembic-atlas-bootstrap',
  currentAsset: ref(current, 'current'),
  history: [
    { id: 'old', capturedAt: 'then', baselineCommit: 'a'.repeat(40), asset: ref(old, 'snapshot') },
  ],
} as Bootstrap;
describe('按需数据加载', () => {
  it('loads only current on entry and fetches just the selected history once', async () => {
    const read = vi.fn(async (url: string) => (url === bootstrap.currentAsset.url ? current : old));
    const loader = new AtlasAssetLoader(bootstrap, read, async (text) => sha(text));
    await loader.current();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalledWith(bootstrap.history[0].asset.url);
    await loader.snapshot('old');
    await loader.snapshot('old');
    expect(read).toHaveBeenCalledTimes(2);
    await expect(loader.snapshot('missing')).rejects.toThrow(/快照/);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects changed bytes, unsafe URLs and identity mismatch; failed loads can retry', async () => {
    const read = vi.fn().mockResolvedValueOnce('corrupt').mockResolvedValue(old);
    const loader = new AtlasAssetLoader(bootstrap, read, async (text) => sha(text));
    await expect(loader.snapshot('old')).rejects.toThrow(/摘要/);
    await expect(loader.snapshot('old')).resolves.toMatchObject({ id: 'old' });
    const unsafe = {
      ...bootstrap,
      currentAsset: { ...bootstrap.currentAsset, url: 'https://example.com/data.json' },
    };
    await expect(
      new AtlasAssetLoader(unsafe, read, async (text) => sha(text)).current(),
    ).rejects.toThrow(/路径/);
    const mismatch = content('snapshot', { ...data, id: 'wrong' });
    const b = {
      ...bootstrap,
      history: [{ ...bootstrap.history[0], asset: ref(mismatch, 'snapshot') }],
    };
    await expect(
      new AtlasAssetLoader(
        b,
        async () => mismatch,
        async (text) => sha(text),
      ).snapshot('old'),
    ).rejects.toThrow(/身份/);
  });
  it('a late old success or failure cannot replace the most recent selection', async () => {
    const gate = new LatestSelection();
    let resolveOld: (value: string) => void = () => {};
    let rejectOld: (error: Error) => void = () => {};
    const seen: string[] = [];
    const first = gate.run(
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve;
        }),
      (v) => seen.push(v),
      () => seen.push('error'),
    );
    await gate.run(
      async () => 'new',
      (v) => seen.push(v),
      () => seen.push('error'),
    );
    resolveOld('old');
    await first;
    expect(seen).toEqual(['new']);
    const failed = gate.run(
      () =>
        new Promise<string>((_, reject) => {
          rejectOld = reject;
        }),
      (v) => seen.push(v),
      () => seen.push('late-error'),
    );
    gate.cancel();
    rejectOld(new Error('old failed'));
    await failed;
    expect(seen).toEqual(['new']);
  });
});
describe('证据状态展示', () => {
  it('no evidence, empty pass, failed and stale attempts cannot claim six passes', () => {
    expect(pilotEvidence(null, 'matched', false).count).toBe(0);
    expect(
      pilotEvidence({ status: 'pass', scenarios: [] } as PilotReceipt, 'matched', false).tone,
    ).not.toBe('good');
    const p = { status: 'pass', scenarios: [{ id: 'a', status: 'pass' }] } as PilotReceipt;
    expect(pilotEvidence(p, 'stale', false).tone).toBe('warning');
    expect(pilotEvidence({ ...p, status: 'fail' }, 'matched', false).label).toContain('失败');
    expect(pilotEvidence(p, 'matched', true).tone).toBe('neutral');
    expect(readingFreshness({ sha256: 'new' }, { sha256: 'old', freshness: 'fresh' })).toBe(
      'stale',
    );
  });
});
