import type { AssetRef, Bootstrap, Catalog, Snapshot } from './model';

type ReadAsset = (url: string) => Promise<string>;
type Digest = (text: string) => Promise<string>;
export async function digestText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}
const readAsset: ReadAsset = async (url) => {
  const response = await fetch(new URL(url, document.baseURI));
  if (!response.ok) {
    throw new Error(`读取图谱数据失败（HTTP ${response.status}），可重试或重新 collect。`);
  }
  return response.text();
};
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
/** 内容摘要绑定静态资产；错误不缓存，重试不会回退到别的快照。 */
export class AtlasAssetLoader {
  private cache = new Map<string, Promise<unknown>>();
  constructor(
    private bootstrap: Bootstrap,
    private read: ReadAsset = readAsset,
    private digest: Digest = digestText,
  ) {}
  private async load(
    ref: AssetRef,
    kind: 'current' | 'snapshot',
  ): Promise<Record<string, unknown>> {
    if (
      !/^atlas-data\/(current|snapshot)-[a-f0-9]{64}\.json$/u.test(ref.url) ||
      !/^sha256:[a-f0-9]{64}$/u.test(ref.sha256)
    ) {
      throw new Error('图谱资产路径或摘要格式无效。');
    }
    const cached = this.cache.get(ref.url);
    if (cached) {
      return cached as Promise<Record<string, unknown>>;
    }
    const pending = (async () => {
      const text = await this.read(ref.url);
      if ((await this.digest(text)) !== ref.sha256) {
        throw new Error('图谱数据摘要不匹配，请重新采样后重试。');
      }
      if (new TextEncoder().encode(text).byteLength !== ref.bytes) {
        throw new Error('图谱资产大小与目录不匹配。');
      }
      const payload: unknown = JSON.parse(text);
      if (
        !record(payload) ||
        payload.schemaVersion !== 1 ||
        payload.kind !== kind ||
        !record(payload.data) ||
        !Array.isArray(payload.data.documents) ||
        !record(payload.data.inventory) ||
        !Array.isArray(payload.data.inventory.files) ||
        !Array.isArray(payload.data.inventory.edges)
      ) {
        throw new Error('图谱数据合同无效，不能展示为当前事实。');
      }
      return payload.data;
    })();
    this.cache.set(ref.url, pending);
    try {
      return await pending;
    } catch (error: unknown) {
      this.cache.delete(ref.url);
      throw error;
    }
  }
  async current(): Promise<Catalog> {
    const value = await this.load(this.bootstrap.currentAsset, 'current');
    return { ...value, history: this.bootstrap.history } as unknown as Catalog;
  }
  async snapshot(id: string): Promise<Snapshot> {
    const matches = this.bootstrap.history.filter((s) => s.id === id);
    if (matches.length !== 1) {
      throw new Error('没有唯一匹配的历史快照；不会改用当前工作树。');
    }
    const value = await this.load(matches[0].asset, 'snapshot');
    if (value.id !== id || value.capturedAt !== matches[0].capturedAt) {
      throw new Error('历史数据身份与目录不一致。');
    }
    return value as unknown as Snapshot;
  }
}
/** 连续选择时只接纳最后一次请求；旧请求的成功和失败都不能覆盖新界面。 */
export class LatestSelection {
  private revision = 0;
  cancel() {
    this.revision++;
  }
  async run<T>(
    load: () => Promise<T>,
    commit: (value: T) => void,
    reject: (error: unknown) => void,
  ) {
    const revision = ++this.revision;
    try {
      const result = await load();
      if (revision === this.revision) {
        commit(result);
      }
    } catch (error: unknown) {
      if (revision === this.revision) {
        reject(error);
      }
    }
  }
}
