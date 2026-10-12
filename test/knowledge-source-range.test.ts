/**
 * L4-P22 / I25：readBoundedSourceRange 是门禁 resolver、production adapter 与 F4b 修复提示
 * 共用的“读取项目内 path:start-end 来源”单源实现。这里钉住三处共享的语义：
 * - 统一用 resolveProjectPath 判定（词法越界 + 符号链接越界）；
 * - 统一按 /\r?\n/ 切行，以换行结尾的文件不产生额外空行（path:N+1 越界）；
 * - 每种拒绝都返回可读原因与细节，由调用方各自记录诊断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parseBoundedSourceRef,
  readBoundedSourceRange,
  readProjectSourceFile,
  readSourceRange,
  splitLogicalLines,
} from '../src/tools/runtime/handlers/knowledge/sourceRange.js';
import { createTempProject } from './helpers/tempProject.js';

function project(files: Record<string, string>): string {
  const root = createTempProject('source-range-');
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content, 'utf8');
  }
  return root;
}

describe('splitLogicalLines', () => {
  test.each([
    ['', []],
    ['a', ['a']],
    ['a\n', ['a']],
    ['a\nb', ['a', 'b']],
    ['a\r\nb\r\n', ['a', 'b']],
    ['a\n\n', ['a', '']],
    ['\n', ['']],
  ])('%j -> %j', (content, expected) => {
    expect(splitLogicalLines(content)).toEqual(expected);
  });
});

describe('parseBoundedSourceRef', () => {
  test('parses single-line and ranged refs and keeps the declared path text', () => {
    expect(parseBoundedSourceRef(' ./src/a.ts:2 ')).toEqual({
      path: './src/a.ts',
      start: 2,
      end: 2,
      explicitEnd: false,
    });
    expect(parseBoundedSourceRef('src\\a.ts:2-3')).toEqual({
      path: 'src\\a.ts',
      start: 2,
      end: 3,
      explicitEnd: true,
    });
  });

  test.each(['src/a.ts', 'src/a.ts:', ':3', 'src/a.ts:x-3', ''])('rejects %j', (ref) => {
    expect(parseBoundedSourceRef(ref)).toBeNull();
  });
});

describe('readBoundedSourceRange', () => {
  test('reads a CRLF range without carriage returns and reports file line count', () => {
    const root = project({ 'src/a.ts': 'L1\r\nconst a = 1;\r\nconst b = 2;\r\n' });
    const result = readBoundedSourceRange(root, './src/a.ts:2-3');
    expect(result).toMatchObject({
      ok: true,
      relative: 'src/a.ts',
      realRelative: 'src/a.ts',
      start: 2,
      end: 3,
      lineCount: 3,
      lines: ['const a = 1;', 'const b = 2;'],
    });
  });

  test('normalizes backslash paths and resolves single-line refs to N-N', () => {
    const root = project({ 'src/a.ts': 'one\ntwo\n' });
    expect(readBoundedSourceRange(root, 'src\\a.ts:2')).toMatchObject({
      ok: true,
      relative: 'src/a.ts',
      start: 2,
      end: 2,
      lines: ['two'],
    });
  });

  test('treats path:N+1 of a newline-terminated file as out of range', () => {
    const root = project({ 'src/a.ts': 'one\ntwo\n' });
    expect(readBoundedSourceRange(root, 'src/a.ts:3')).toMatchObject({
      ok: false,
      reason: 'line-out-of-range',
      relative: 'src/a.ts',
      lineCount: 2,
    });
    expect(readBoundedSourceRange(root, 'src/a.ts:2-3')).toMatchObject({
      ok: false,
      reason: 'line-out-of-range',
      lineCount: 2,
    });
  });

  test.each([
    ['src/a.ts', 'format'],
    ['/etc/hosts:1', 'path-invalid'],
    ['../outside.ts:1', 'path-invalid'],
    ['src/missing.ts:1', 'not-found'],
    ['src:1', 'not-found'],
    ['src/a.ts:0-1', 'line-out-of-range'],
    ['src/a.ts:2-1', 'line-out-of-range'],
  ])('rejects %s with reason %s', (ref, reason) => {
    const root = project({ 'src/a.ts': 'one\ntwo\n' });
    const result = readBoundedSourceRange(root, ref);
    expect(result).toMatchObject({ ok: false, reason });
    if (!result.ok) {
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  test('rejects a symlink that escapes the project root with the resolveProjectPath reason', () => {
    const root = project({ 'src/a.ts': 'one\n' });
    const outside = createTempProject('source-range-outside-');
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1;\n');
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src/escape.ts'));
    const result = readBoundedSourceRange(root, 'src/escape.ts:1');
    expect(result).toMatchObject({
      ok: false,
      reason: 'symlink-escape',
      relative: 'src/escape.ts',
    });
    if (!result.ok) {
      expect(result.detail).toContain('Access denied');
    }
  });

  test('classifies the real file of an in-project symlink by its real path', () => {
    const root = project({ 'docs/design.md': '# Design\nbody\n' });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.symlinkSync('../docs/design.md', path.join(root, 'src/alias.ts'));
    expect(readBoundedSourceRange(root, 'src/alias.ts:1-2')).toMatchObject({
      ok: true,
      relative: 'src/alias.ts',
      realRelative: 'docs/design.md',
    });
  });

  test('reports a read failure as read-error with the fs error code', () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const root = project({ 'src/locked.ts': 'one\ntwo\n' });
    const locked = path.join(root, 'src/locked.ts');
    fs.chmodSync(locked, 0o000);
    try {
      const result = readBoundedSourceRange(root, 'src/locked.ts:1');
      expect(result).toMatchObject({ ok: false, reason: 'read-error', relative: 'src/locked.ts' });
      if (!result.ok) {
        expect(result.detail).toContain('EACCES');
      }
    } finally {
      fs.chmodSync(locked, 0o644);
    }
  });

  test('readSourceRange and readProjectSourceFile share the same resolution', () => {
    const root = project({ 'src/a.ts': 'one\ntwo\nthree' });
    expect(readProjectSourceFile(root, './src//a.ts')).toMatchObject({
      ok: true,
      relative: 'src/a.ts',
      fileLines: ['one', 'two', 'three'],
    });
    expect(readSourceRange(root, { path: 'src/a.ts', start: 3, end: 3 })).toMatchObject({
      ok: true,
      lines: ['three'],
      lineCount: 3,
    });
  });
});
