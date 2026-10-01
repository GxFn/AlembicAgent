import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashCanonical, hashCoreCanonical } from '../src/agent/production/strict/primitives.js';

/**
 * 与 Core 交叉校验的规范哈希钉子。
 *
 * 背景：Core 的 hashCanonicalJson 按 UTF-16 码元序排键（Object.keys().sort()）。本仓用
 * hashCoreCanonical 校验 Core 生成的 fixpointHash，并生成由 Core 复算的 authoredFingerprint。
 * 它此前借用了仓内 hashCanonical 的 localeCompare 排序——两种顺序在 `refs`/`refSet` 这类
 * 键对上不同（码元序大写在前，区域排序把 `refs` 当作前缀排在前），且区域排序随运行环境
 * 的 locale/ICU 变化。当前载荷恰好没有这样的键对，一旦契约新增就会把合法回执判成哈希不符。
 */

const sha256 = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

describe('hashCoreCanonical matches the Core canonical JSON byte order', () => {
  it('orders keys by UTF-16 code units, not by locale collation', () => {
    const payload = { refs: 1, refSet: 2, alpha: 3, Zeta: 4, _under: 5, a1: 6 };
    // 码元序：大写 < 下划线 < 小写；`refSet` 在 `refs` 之前。
    const expected = '{"Zeta":4,"_under":5,"a1":6,"alpha":3,"refSet":2,"refs":1}';

    expect(hashCoreCanonical(payload)).toBe(sha256(expected));
  });

  it('applies the same order at every depth and keeps array order', () => {
    const payload = {
      schemaVersion: 1,
      rows: [
        { clusters: ['b', 'a'], clusterSetHash: 'h2' },
        { clusterSetHash: 'h1', clusters: [] },
      ],
    };
    const expected =
      '{"rows":[{"clusterSetHash":"h2","clusters":["b","a"]},{"clusterSetHash":"h1","clusters":[]}],"schemaVersion":1}';

    expect(hashCoreCanonical(payload)).toBe(sha256(expected));
  });

  it('serializes undefined, negative zero and reserved keys the way Core does', () => {
    const payload = JSON.parse('{"__proto__":{"b":1},"z":null}') as Record<string, unknown>;
    payload.skipped = undefined;
    payload.zero = -0;
    payload.list = [undefined, 1];
    const expected = '{"__proto__":{"b":1},"list":[null,1],"z":null,"zero":0}';

    expect(hashCoreCanonical(payload)).toBe(sha256(expected));
  });

  it('agrees with the internal hash whenever both orders coincide', () => {
    // 仓内自用哈希保持原算法（已有持久化数据依赖它）；常规 camelCase 载荷两者一致。
    const payload = { schemaVersion: 1, populationHashes: ['p'], clusterSetHashes: ['c'] };

    expect(hashCoreCanonical(payload)).toBe(`sha256:${hashCanonical(payload)}`);
  });
});
