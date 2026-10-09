import { describe, expect, it } from 'vitest';
import { failedReadPaths, successfulReadPaths } from '../src/agent/utils/toolOutcomes.js';

/** L6-P10 / C23：code.read 的失败成员必须与成功成员对称地可读出，部分失败不能被整体 ok 吞掉。 */
describe('failedReadPaths', () => {
  const batchCall = {
    tool: 'code',
    args: { action: 'read', filePaths: ['src/a.ts', 'src/missing.ts', 'src/denied.ts'] },
    envelope: {
      ok: true,
      status: 'success',
      structuredContent: {
        mode: 'batch',
        files: [
          { ok: true, path: 'src/a.ts', content: '1|a', lineCount: 1 },
          { ok: false, path: 'src/missing.ts', error: 'Cannot read file: ENOENT' },
          { ok: false, path: 'src/denied.ts', error: 'Permission denied' },
          { ok: false, path: 'src/denied.ts', error: 'duplicate entry' },
        ],
      },
    },
  };

  it('lists failed batch members with their reasons and keeps them out of the success set', () => {
    expect(failedReadPaths(batchCall)).toEqual([
      { path: 'src/missing.ts', reason: 'Cannot read file: ENOENT' },
      { path: 'src/denied.ts', reason: 'Permission denied' },
    ]);
    expect(successfulReadPaths(batchCall)).toEqual(['src/a.ts']);
  });

  it('reads legacy batchResults maps symmetrically', () => {
    const call = {
      tool: 'code',
      args: { action: 'read', filePaths: ['src/a.ts', 'src/b.ts'] },
      result: {
        batchResults: {
          'src/a.ts': { ok: true, content: 'a' },
          'src/b.ts': { ok: false, error: 'Cannot read file: EACCES' },
        },
      },
    };
    expect(failedReadPaths(call)).toEqual([
      { path: 'src/b.ts', reason: 'Cannot read file: EACCES' },
    ]);
    expect(successfulReadPaths(call)).toEqual(['src/a.ts']);
  });

  it('still names the failed members when the whole batch failed', () => {
    const call = {
      tool: 'code',
      args: { action: 'read', filePaths: ['src/x.ts'] },
      envelope: {
        ok: false,
        status: 'error',
        text: 'code.read batch failed: 1/1 files failed',
        structuredContent: {
          mode: 'batch',
          files: [{ ok: false, path: 'src/x.ts', error: 'Cannot read file: ENOENT' }],
        },
      },
    };
    expect(failedReadPaths(call)).toEqual([
      { path: 'src/x.ts', reason: 'Cannot read file: ENOENT' },
    ]);
    expect(successfulReadPaths(call)).toEqual([]);
  });

  it('returns nothing for non-read calls, single reads, and malformed members', () => {
    expect(
      failedReadPaths({
        tool: 'code',
        args: { action: 'search', pattern: 'x' },
        result: { files: [{ ok: false, path: 'src/a.ts', error: 'nope' }] },
      })
    ).toEqual([]);
    expect(
      failedReadPaths({
        tool: 'code',
        args: { action: 'read', path: 'src/missing.ts' },
        envelope: { ok: false, status: 'error', text: 'Cannot read file: ENOENT' },
      })
    ).toEqual([]);
    expect(
      failedReadPaths({
        tool: 'code',
        args: { action: 'read', filePaths: ['src/a.ts'] },
        result: { files: [null, 'text', { ok: false, error: 'no path' }, { ok: false, path: '' }] },
      })
    ).toEqual([]);
  });

  it('falls back to a generic reason when the member carries no error text', () => {
    expect(
      failedReadPaths({
        tool: 'code',
        args: { action: 'read', filePaths: ['src/a.ts'] },
        result: { files: [{ ok: false, path: 'src/a.ts' }] },
      })
    ).toEqual([{ path: 'src/a.ts', reason: 'read failed' }]);
  });
});
