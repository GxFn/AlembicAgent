/**
 * EvidenceLedgerStore.describeContentTransformation 测试（C03 诊断段）。
 *
 * 该方法只复算落盘管线并报告「脱敏 / 截断」事实，是 production capture facet 发 warn 诊断
 * 的数据来源。这里钉住三件事：与 append 同一把尺（storedLength 必须等于实际落盘长度）、
 * 不写盘不消耗 E-n、以及四种组合（原样 / 仅截断 / 仅脱敏 / 两者）各自的归类。
 */
import { existsSync } from 'node:fs';
import { EVIDENCE_ENTRY_MAX_CHARS } from '@alembic/core/knowledge';
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_TRUNCATION_MARKER,
  EvidenceLedgerStore,
} from '../src/agent/evidence/EvidenceLedgerStore.js';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';
import { createTempProject } from './helpers/tempProject.js';

function makeStore(redactor?: (text: string) => string): EvidenceLedgerStore {
  return new EvidenceLedgerStore({
    dataRoot: createTempProject('evidence-ledger-transformation-'),
    jobId: 'job:transformation',
    sessionId: 'session:transformation',
    dimensionId: 'dimension:transformation',
    redactor,
  });
}

// 不含任何敏感模式的超长内容：只能触发上限截断，不能触发脱敏。
const oversizedPlain = Array.from(
  { length: 400 },
  (_, index) => `export const plainLine${index} = ${index};`
).join('\n');
const secretOnly = 'const api_key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";\n';

describe('EvidenceLedgerStore.describeContentTransformation', () => {
  it('describes verbatim content as neither redacted nor truncated with equal lengths', () => {
    const store = makeStore(redactDeveloperText);
    const content = 'export const fact = true;\n';

    const description = store.describeContentTransformation(content);

    expect(description).toEqual({
      redacted: false,
      truncated: false,
      originalLength: content.length,
      storedLength: content.length,
    });
    expect(Object.isFrozen(description)).toBe(true);
  });

  it('reports truncation only for oversized content and uses the same ruler as append', () => {
    expect(oversizedPlain.length).toBeGreaterThan(EVIDENCE_ENTRY_MAX_CHARS);
    const store = makeStore(redactDeveloperText);

    const description = store.describeContentTransformation(oversizedPlain);
    const appended = store.append({
      tool: 'code.read',
      callId: 'call:oversized',
      file: 'src/oversized.ts',
      content: oversizedPlain,
    });

    expect(description.redacted).toBe(false);
    expect(description.truncated).toBe(true);
    expect(description.originalLength).toBe(oversizedPlain.length);
    expect(description.storedLength).toBe(EVIDENCE_ENTRY_MAX_CHARS);
    // 同一把尺：描述给出的落盘长度必须等于 append 实际写入的内容长度。
    expect(description.storedLength).toBe(appended.content.length);
    expect(appended.content.endsWith(`\n${EVIDENCE_TRUNCATION_MARKER}`)).toBe(true);
  });

  it('reports redaction only when the injected redactor rewrites credential literals', () => {
    const store = makeStore(redactDeveloperText);

    const description = store.describeContentTransformation(secretOnly);
    const appended = store.append({
      tool: 'code.read',
      callId: 'call:secret',
      file: 'src/config.ts',
      content: secretOnly,
    });

    expect(description.redacted).toBe(true);
    expect(description.truncated).toBe(false);
    expect(description.originalLength).toBe(secretOnly.length);
    expect(description.storedLength).toBe(appended.content.length);
    expect(appended.content).not.toContain('sk-proj-');
  });

  it('reports both redaction and truncation when redacted content still exceeds the entry cap', () => {
    const store = makeStore(redactDeveloperText);
    const content = `${secretOnly}${oversizedPlain}`;

    const description = store.describeContentTransformation(content);
    const appended = store.append({
      tool: 'code.read',
      callId: 'call:both',
      file: 'src/both.ts',
      content,
    });

    expect(description.redacted).toBe(true);
    expect(description.truncated).toBe(true);
    expect(description.originalLength).toBe(content.length);
    expect(description.storedLength).toBe(EVIDENCE_ENTRY_MAX_CHARS);
    expect(description.storedLength).toBe(appended.content.length);
  });

  it('treats the identity redactor as no redaction even for credential-shaped content', () => {
    // 缺省恒等 redactor（非生产接线）下，只有上限截断能改变内容；secret 形态原样保留。
    const store = makeStore();

    const description = store.describeContentTransformation(secretOnly);

    expect(description).toEqual({
      redacted: false,
      truncated: false,
      originalLength: secretOnly.length,
      storedLength: secretOnly.length,
    });
  });

  it('neither writes to disk nor consumes an evidence id', () => {
    const store = makeStore(redactDeveloperText);

    store.describeContentTransformation(oversizedPlain);
    store.describeContentTransformation(secretOnly);

    expect(existsSync(store.filePath)).toBe(false);
    expect(store.stats()).toEqual({ entries: 0, distinctFiles: 0 });
    const first = store.append({
      tool: 'code.read',
      callId: 'call:first',
      content: 'export const first = 1;\n',
    });
    expect(first.id).toBe('E-1');
  });
});
