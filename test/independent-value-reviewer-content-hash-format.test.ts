import { createHash } from 'node:crypto';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFrozenEvidenceProjection,
  type FrozenEvidenceEntryV1,
} from '../src/agent/evaluation/IndependentValueReviewer.js';

// 背景（module-review L7 / P27，问题 C40）：FrozenEvidenceEntryV1.contentHash 的契约是裸 64 位
// 小写 hex，而 Core EvidenceEntry 台账使用 `sha256:<hex>` 前缀格式。宿主目前先校验前缀再
// slice(7) 手工剥离；下一个直接把台账条目传进来的调用方只会得到误导性的
// CONTENT_HASH_MISMATCH（内容其实没变）。用户决定不放宽输入：带 sha256: 前缀的输入改报专用
// 格式错误码，并打出可定位的诊断；裸 hex 的既有行为（包括哈希不一致的错误码）保持不变。

const FORMAT_LOG_MESSAGE = '[IndependentValueReviewer] frozen evidence contentHash format invalid';
const content = '1|export function handler() {\n2|  return wrapResult(run);\n3|}';
const bareHex = createHash('sha256').update(content).digest('hex');

function entry(overrides: Partial<FrozenEvidenceEntryV1> = {}): FrozenEvidenceEntryV1 {
  return {
    evidenceEntryId: 'E-1',
    relativePath: 'src/handler.ts',
    blobHash: 'blob-1',
    contentHash: bareHex,
    startLine: 1,
    endLine: 3,
    content,
    ...overrides,
  };
}

function spyWarn() {
  // winston 的 warn 返回 Logger 本身；mock 返回同一实例以满足签名，不触发真实输出。
  return vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => Logger.getInstance());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFrozenEvidenceProjection contentHash format (C40)', () => {
  it('rejects a Core ledger style sha256: prefixed hash with a dedicated format code', () => {
    const warn = spyWarn();
    let thrown: unknown;
    try {
      createFrozenEvidenceProjection({
        sourceRevisionVectorHash: 'vector-1',
        entries: [entry({ contentHash: `sha256:${bareHex}` })],
      });
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toMatch(/^STRICT_REVIEW_EVIDENCE_CONTENT_HASH_FORMAT_INVALID: E-1/u);
    // 专用码必须替代误导性的内容不一致码，而不是与其并存。
    expect(message).not.toContain('CONTENT_HASH_MISMATCH');
    expect(message).toContain('sha256:');

    const formatLogs = warn.mock.calls.filter(([msg]) => msg === FORMAT_LOG_MESSAGE);
    expect(formatLogs).toHaveLength(1);
    expect(formatLogs[0]?.[1]).toMatchObject({
      reasonCode: 'STRICT_REVIEW_EVIDENCE_CONTENT_HASH_FORMAT_INVALID',
      evidenceEntryId: 'E-1',
      observedPrefix: 'sha256:',
      expectedFormat: 'bare-64-lowercase-hex',
      resolution: 'reject',
    });
  });

  it('treats the prefix case-insensitively and names the offending entry', () => {
    spyWarn();
    const secondContent = 'export const answer = 42;';
    const secondHex = createHash('sha256').update(secondContent).digest('hex');
    expect(() =>
      createFrozenEvidenceProjection({
        sourceRevisionVectorHash: 'vector-1',
        entries: [
          entry(),
          entry({
            evidenceEntryId: 'E-2',
            relativePath: 'src/answer.ts',
            contentHash: `SHA256:${secondHex}`,
            startLine: 7,
            endLine: 7,
            content: secondContent,
          }),
        ],
      })
    ).toThrow(/^STRICT_REVIEW_EVIDENCE_CONTENT_HASH_FORMAT_INVALID: E-2/u);
  });

  it('leaves an entry without a usable id to the existing required-field code', () => {
    const warn = spyWarn();
    expect(() =>
      createFrozenEvidenceProjection({
        sourceRevisionVectorHash: 'vector-1',
        entries: [entry({ evidenceEntryId: ' ', contentHash: `sha256:${bareHex}` })],
      })
    ).toThrow(/^STRICT_REVIEW_EVIDENCEENTRYID_REQUIRED$/u);
    expect(warn.mock.calls.filter(([msg]) => msg === FORMAT_LOG_MESSAGE)).toHaveLength(0);
  });

  it('keeps the existing bare-hex contract: valid input freezes, wrong hex stays a mismatch', () => {
    const warn = spyWarn();
    const projection = createFrozenEvidenceProjection({
      sourceRevisionVectorHash: 'vector-1',
      entries: [entry()],
    });
    expect(projection.entries[0]?.contentHash).toBe(bareHex);
    expect(projection.projectionHash).toMatch(/^[0-9a-f]{64}$/u);

    expect(() =>
      createFrozenEvidenceProjection({
        sourceRevisionVectorHash: 'vector-1',
        entries: [entry({ contentHash: 'f'.repeat(64) })],
      })
    ).toThrow(/^STRICT_REVIEW_EVIDENCE_CONTENT_HASH_MISMATCH: E-1$/u);
    expect(warn.mock.calls.filter(([msg]) => msg === FORMAT_LOG_MESSAGE)).toHaveLength(0);
  });
});
