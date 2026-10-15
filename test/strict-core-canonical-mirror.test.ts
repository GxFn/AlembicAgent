import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { describe, expect, it } from 'vitest';
import { hashCoreCanonical } from '../src/agent/production/strict/primitives.js';

/**
 * hashCoreCanonical 是 Core `hashCanonicalJson` 的镜像（C30）：它校验 Core 生成的 fixpointHash，
 * 并生成由 Core 复算的 authoredFingerprint，两侧必须逐字节一致。这里直接拿 Core 稳定公开子路径
 * `@alembic/core/project-context-foundation` 的实现做对照，Core 调整规范规则时本测试先失败，
 * 而不是在跨仓复核时静默分叉。
 *
 * 已知差异只有输入不是合法 JSON 值的情形（非有限数）：镜像经 JSON.stringify 写成 null，
 * Core 抛 TypeError。strict 载荷在进入哈希前已校验，正常不会出现；改为委托 Core 时这里的
 * 差异断言需要随之改成“两侧都拒绝”，属于有意的 fail-closed 行为变化。
 */

describe('hashCoreCanonical stays byte-identical to Core hashCanonicalJson', () => {
  const representativePayloads: Array<[string, unknown]> = [
    [
      'authored fingerprint projection',
      {
        schemaVersion: 1,
        authored: {
          title: '缓存失效顺序',
          kind: 'pattern',
          refs: ['src/cache.ts:12-20'],
          refSet: { primary: 'src/cache.ts' },
          body: { claims: ['先删后写', 'invalidate before write'], weight: 0.5 },
          Zeta: null,
          _internal: true,
        },
      },
    ],
    [
      'fixpoint semantic projection',
      {
        schemaVersion: 1,
        epochHash: `sha256:${'a'.repeat(64)}`,
        populationHashes: ['sha256:p2', 'sha256:p1'],
        clusters: [{ clusterSetHash: 'h2', clusters: ['b', 'a'] }],
        stable: { rounds: 2, converged: true },
      },
    ],
    [
      'undefined members, negative zero and reserved keys',
      Object.assign(JSON.parse('{"__proto__":{"b":1}}') as Record<string, unknown>, {
        skipped: undefined,
        zero: -0,
        list: [undefined, 1, { z: 1, a: [2, 1] }],
      }),
    ],
  ];

  it.each(representativePayloads)('%s', (_label, payload) => {
    expect(hashCoreCanonical(payload)).toBe(hashCanonicalJson(payload));
  });

  it('documents the non-finite number divergence recorded in the mirror comment', () => {
    const payload = { schemaVersion: 1, score: Number.NaN, limit: Number.POSITIVE_INFINITY };
    // 镜像：JSON.stringify 把非有限数写成 null，因此与显式 null 的载荷同哈希。
    expect(hashCoreCanonical(payload)).toBe(
      hashCoreCanonical({ schemaVersion: 1, score: null, limit: null })
    );
    // Core：规范 JSON 拒绝非有限数。
    expect(() => hashCanonicalJson(payload)).toThrow(TypeError);
  });
});
