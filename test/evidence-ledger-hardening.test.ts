/**
 * 证据台账静态加固（D7，脱敏阶段 2 测试要求 5）与进程内原文摘要的存放边界。
 *
 * 覆盖：
 * - 新建台账：目录 0700、文件 0600，evidence-ledger/ 下写内容为 `*` 的自忽略 .gitignore；
 * - 已存在的 .gitignore 不覆盖；
 * - 打开旧台账（0644/0755、无 .gitignore）时收紧权限并补 .gitignore，记诊断；
 * - chmod / .gitignore 写入失败只记 warn，不中断打开与追加；
 * - HMAC 原文摘要不落盘（JSONL 只有规范字段、目录里没有多余文件），也不是模块级状态
 *   （同一进程的两个实例互不共享摘要）。
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { createProductionEvidenceLedgerAuthority } from '../src/agent/evidence/ProductionEvidenceLedgerAuthority.js';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';
import { createTempProject } from './helpers/tempProject.js';

const COORDINATES = {
  jobId: 'job_hardening',
  sessionId: 'sess_hardening',
  dimensionId: 'ts-js-module',
} as const;

const posixOnly = test.skipIf(process.platform === 'win32');

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

function layout(dataRoot: string) {
  const ledgerRoot = path.join(dataRoot, '.asd', 'evidence-ledger');
  const jobDir = path.join(ledgerRoot, COORDINATES.jobId);
  return {
    ledgerRoot,
    jobDir,
    file: path.join(jobDir, `${COORDINATES.dimensionId}.jsonl`),
    gitignore: path.join(ledgerRoot, '.gitignore'),
  };
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function openStore(dataRoot: string): EvidenceLedgerStore {
  return new EvidenceLedgerStore({ dataRoot, ...COORDINATES, redactor: redactDeveloperText });
}

function listTree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listTree(path.join(dir, entry.name), relative));
    } else {
      out.push(relative);
    }
  }
  return out.sort();
}

describe('D7：新建台账的权限与自忽略 .gitignore', () => {
  posixOnly('循环台账首次追加：目录 0700、文件 0600、.gitignore 内容为 *', () => {
    const dataRoot = createTempProject('ledger-hardening-new-');
    const store = openStore(dataRoot);
    const paths = layout(dataRoot);
    expect(fs.existsSync(paths.ledgerRoot)).toBe(false);

    store.append({ tool: 'code.read', callId: 'c1', file: 'src/a.ts', content: 'const a = 1;' });

    expect(store.filePath).toBe(paths.file);
    expect(modeOf(paths.ledgerRoot)).toBe(0o700);
    expect(modeOf(paths.jobDir)).toBe(0o700);
    expect(modeOf(paths.file)).toBe(0o600);
    expect(fs.readFileSync(paths.gitignore, 'utf8').trim()).toBe('*');
    expect(modeOf(paths.gitignore)).toBe(0o600);
  });

  posixOnly('宿主 capture facet 打开的台账同样加固（写入内容不变）', () => {
    const dataRoot = createTempProject('ledger-hardening-facet-');
    const authority = createProductionEvidenceLedgerAuthority({ dataRoot, ...COORDINATES });
    const entry = authority.capture.capture({
      tool: 'code.read',
      callId: 'facet',
      file: 'src/a.ts',
      content: 'const a = 1;',
    });
    const paths = layout(dataRoot);
    expect(entry.content).toBe('const a = 1;');
    expect(modeOf(paths.file)).toBe(0o600);
    expect(modeOf(paths.jobDir)).toBe(0o700);
    expect(fs.readFileSync(paths.gitignore, 'utf8').trim()).toBe('*');
  });

  test('已存在的 .gitignore 不覆盖', () => {
    const dataRoot = createTempProject('ledger-hardening-keep-gitignore-');
    const paths = layout(dataRoot);
    fs.mkdirSync(paths.ledgerRoot, { recursive: true });
    fs.writeFileSync(paths.gitignore, '# operator managed\n*.jsonl\n', 'utf8');
    openStore(dataRoot).append({ tool: 'code.read', callId: 'c1', content: 'x' });
    expect(fs.readFileSync(paths.gitignore, 'utf8')).toBe('# operator managed\n*.jsonl\n');
  });
});

describe('D7：打开旧台账时收紧权限', () => {
  posixOnly('0644 文件、0755 目录、缺 .gitignore 的旧台账在打开时收紧并补齐，并记诊断', () => {
    const dataRoot = createTempProject('ledger-hardening-legacy-');
    const paths = layout(dataRoot);
    openStore(dataRoot).append({ tool: 'code.read', callId: 'c1', content: 'legacy entry' });
    // 模拟加固之前写下的台账
    fs.chmodSync(paths.file, 0o644);
    fs.chmodSync(paths.jobDir, 0o755);
    fs.chmodSync(paths.ledgerRoot, 0o755);
    fs.rmSync(paths.gitignore);
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);

    const reopened = openStore(dataRoot);

    expect(reopened.get('E-1')?.content).toBe('legacy entry');
    expect(modeOf(paths.file)).toBe(0o600);
    expect(modeOf(paths.jobDir)).toBe(0o700);
    expect(modeOf(paths.ledgerRoot)).toBe(0o700);
    expect(fs.readFileSync(paths.gitignore, 'utf8').trim()).toBe('*');
    const logged = info.mock.calls.map((call) => JSON.stringify(call));
    expect(logged.some((line) => line.includes('tightened') && line.includes('"0644"'))).toBe(true);
  });

  posixOnly('已经收紧的台账再次打开时不重复 chmod', () => {
    const dataRoot = createTempProject('ledger-hardening-idempotent-');
    openStore(dataRoot).append({ tool: 'code.read', callId: 'c1', content: 'x' });
    const chmod = vi.spyOn(fs, 'chmodSync');
    syncBuiltinESMExports();
    openStore(dataRoot);
    expect(chmod).not.toHaveBeenCalled();
  });

  posixOnly('chmod 失败只记 warn，不中断打开与后续追加', () => {
    const dataRoot = createTempProject('ledger-hardening-chmod-fail-');
    const paths = layout(dataRoot);
    openStore(dataRoot).append({ tool: 'code.read', callId: 'c1', content: 'first' });
    fs.chmodSync(paths.file, 0o644);
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    syncBuiltinESMExports();

    const reopened = openStore(dataRoot);
    const second = reopened.append({ tool: 'code.read', callId: 'c2', content: 'second' });

    expect(second.id).toBe('E-2');
    expect(reopened.get('E-1')?.content).toBe('first');
    const logged = warn.mock.calls.map((call) => JSON.stringify(call));
    expect(
      logged.some((line) => line.includes('could not tighten') && line.includes('EPERM'))
    ).toBe(true);
  });

  test('.gitignore 写入失败只记 warn，追加照常完成', () => {
    const dataRoot = createTempProject('ledger-hardening-gitignore-fail-');
    const paths = layout(dataRoot);
    const writeFile = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest) => {
      if (String(file) === paths.gitignore) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return Reflect.apply(writeFile, fs, [file, ...rest]);
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    const entry = openStore(dataRoot).append({ tool: 'code.read', callId: 'c1', content: 'x' });

    expect(entry.id).toBe('E-1');
    expect(fs.existsSync(paths.gitignore)).toBe(false);
    const logged = warn.mock.calls.map((call) => JSON.stringify(call));
    expect(logged.some((line) => line.includes('.gitignore') && line.includes('EACCES'))).toBe(
      true
    );
  });
});

describe('原文摘要不落盘、不进模块级状态', () => {
  test('JSONL 只有规范字段，台账目录里没有摘要或密钥文件', () => {
    const dataRoot = createTempProject('ledger-digest-not-persisted-');
    const store = openStore(dataRoot);
    store.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'src/a.ts',
      range: { start: 1, end: 2 },
      content: 'const a = 1;\nconst b = 2;',
    });
    const paths = layout(dataRoot);
    const persisted = JSON.parse(fs.readFileSync(paths.file, 'utf8').trim());
    expect(Object.keys(persisted).sort()).toEqual([
      'callId',
      'capturedAt',
      'content',
      'contentHash',
      'dimensionId',
      'file',
      'id',
      'range',
      'sessionId',
      'tool',
    ]);
    expect(listTree(paths.ledgerRoot)).toEqual([
      '.gitignore',
      `${COORDINATES.jobId}/${COORDINATES.dimensionId}.jsonl`,
    ]);
  });

  test('同一进程的两个实例不共享摘要：只有追加该条目的实例按原文判定', () => {
    const dataRoot = createTempProject('ledger-digest-instance-');
    // 确定性 redactor：改动落在被遮区间里，脱敏哈希路径必然看不见（假 fresh），与生产规则版本无关
    const maskSynthetic = (text: string) => text.replace(/SYNTHETIC\w+/g, '[redacted]');
    const openMasked = () =>
      new EvidenceLedgerStore({ dataRoot, ...COORDINATES, redactor: maskSynthetic });
    const before = 'const key = SYNTHETICbefore0123;';
    const after = 'const key = SYNTHETICafter0123;';
    const writer = openMasked();
    const entry = writer.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'src/key.ts',
      range: { start: 1, end: 1 },
      content: before,
    });
    const reader = openMasked();

    expect(writer.checkFreshness(entry.id, before)).toBe('fresh');
    expect(writer.checkFreshness(entry.id, after)).toBe('stale');
    // 另一个实例没有摘要，退回脱敏哈希（与现状相同，含已知盲区）
    expect(reader.checkFreshness(entry.id, after)).toBe('fresh');

    const second = reader.append({
      tool: 'code.read',
      callId: 'c2',
      file: 'src/key.ts',
      range: { start: 1, end: 1 },
      content: before,
    });
    expect(reader.checkFreshness(second.id, after)).toBe('stale');
    expect(writer.checkFreshness(second.id, after)).toBe('fresh');
  });
});
