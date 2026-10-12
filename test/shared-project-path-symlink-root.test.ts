import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectPath } from '../src/shared/projectPath.js';

// L1-P7 / L1-I5：项目根本身是 symlink（root=link→real，macOS 的 /var→/private/var、/tmp→/private/tmp
// 是现实场景）时，resolveProjectPath 成功返回的是 realpath 后的 absolute。旧实现只按词法根做预检查，
// 调用方（或模型）把这个 realpath 原样传回会被误判越界。修复后词法预检查同时接受 lexicalRoot 与
// realpath(root)，realRoot 包含检查仍是唯一放行权威；下面的安全回归锁定“放宽的只是预检查”。
const OUTSIDE = 'Access denied: path is outside project root';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * outer/real          真实项目目录（含 src/a.ts）
 * outer/link -> real  作为 projectRoot 传入的 symlink 根
 * outer/secret.txt    根外文件
 */
function createSymlinkedRoot(): { outer: string; real: string; link: string } {
  const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'alembic-project-path-root-')));
  temporaryRoots.push(outer);
  const real = path.join(outer, 'real');
  mkdirSync(path.join(real, 'src'), { recursive: true });
  writeFileSync(path.join(real, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(outer, 'secret.txt'), 'secret\n');
  const link = path.join(outer, 'link');
  symlinkSync(real, link);
  return { outer, real, link };
}

describe.skipIf(process.platform === 'win32')('shared/projectPath symlinked project root', () => {
  it('accepts the real absolute path of a file under a symlinked root', () => {
    const { real, link } = createSymlinkedRoot();

    expect(resolveProjectPath(link, path.join(real, 'src', 'a.ts'))).toEqual({
      absolute: path.join(real, 'src', 'a.ts'),
      relative: path.join('src', 'a.ts'),
    });
  });

  it('accepts its own returned absolute path when it is passed back', () => {
    const { real, link } = createSymlinkedRoot();
    const first = resolveProjectPath(link, 'src');

    expect(first.absolute).toBe(path.join(real, 'src'));
    expect(resolveProjectPath(link, first.absolute)).toEqual(first);
    expect(resolveProjectPath(link, '.')).toEqual({ absolute: real, relative: '' });
  });

  it('accepts a missing real absolute path under a symlinked root when missing paths are allowed', () => {
    const { real, link } = createSymlinkedRoot();

    expect(resolveProjectPath(link, path.join(real, 'src', 'new', 'b.ts'), true)).toEqual({
      absolute: path.join(real, 'src', 'new', 'b.ts'),
      relative: path.join('src', 'new', 'b.ts'),
    });
  });

  it('keeps resolving relative paths through the symlinked root to the real location', () => {
    const { real, link } = createSymlinkedRoot();

    expect(resolveProjectPath(link, 'src/a.ts').absolute).toBe(path.join(real, 'src', 'a.ts'));
    expect(resolveProjectPath(link, path.join(link, 'src', 'a.ts')).absolute).toBe(
      path.join(real, 'src', 'a.ts')
    );
  });

  // ─── 安全回归：放宽的只是预检查，越界仍被拒 ─────────────────────────────

  it('rejects ../ escapes from a symlinked root, existing or missing', () => {
    const { outer, link } = createSymlinkedRoot();

    expect(() => resolveProjectPath(link, '../secret.txt')).toThrow(OUTSIDE);
    expect(() => resolveProjectPath(link, path.join(outer, 'secret.txt'))).toThrow(OUTSIDE);
    expect(() => resolveProjectPath(link, '../missing/new.txt', true)).toThrow(OUTSIDE);
    expect(() => resolveProjectPath(link, path.join(outer, 'missing', 'new.txt'), true)).toThrow(
      OUTSIDE
    );
  });

  it('rejects sibling directories that only share a string prefix with the real root', () => {
    const { outer, link } = createSymlinkedRoot();
    mkdirSync(path.join(outer, 'real-sibling'));
    writeFileSync(path.join(outer, 'real-sibling', 'x.ts'), 'x\n');

    expect(() => resolveProjectPath(link, path.join(outer, 'real-sibling', 'x.ts'))).toThrow(
      OUTSIDE
    );
    expect(() =>
      resolveProjectPath(link, path.join(outer, 'real-sibling', 'new.ts'), true)
    ).toThrow(OUTSIDE);
  });

  it('rejects an outside symlink that points into the project (lexical bypass)', () => {
    const { outer, real, link } = createSymlinkedRoot();
    // 根外别名 outer/alias -> real：realpath 落在根内，但请求路径既不在 link 也不在 real 词法范围内。
    // 双根词法预检查必须拒绝它，否则任意根外 symlink 都能当作进入项目的旁路。
    symlinkSync(real, path.join(outer, 'alias'));

    for (const root of [link, real]) {
      expect(() => resolveProjectPath(root, path.join(outer, 'alias', 'src', 'a.ts'))).toThrow(
        OUTSIDE
      );
      expect(() =>
        resolveProjectPath(root, path.join(outer, 'alias', 'src', 'new.ts'), true)
      ).toThrow(OUTSIDE);
    }
  });

  it('still rejects an in-project symlink that resolves outside, via the real absolute path', () => {
    const { outer, real, link } = createSymlinkedRoot();
    mkdirSync(path.join(outer, 'outside-dir'));
    writeFileSync(path.join(outer, 'outside-dir', 'leak.txt'), 'leak\n');
    symlinkSync(path.join(outer, 'outside-dir'), path.join(real, 'out'));

    // 真实绝对路径能通过双根预检查，realRoot 包含检查必须继续拦住指向根外的 symlink。
    for (const request of ['out/leak.txt', path.join(real, 'out', 'leak.txt')]) {
      expect(() => resolveProjectPath(link, request)).toThrow(OUTSIDE);
      expect(() => resolveProjectPath(link, request, true)).toThrow(OUTSIDE);
    }
    expect(() => resolveProjectPath(link, path.join(real, 'out', 'new', 'x.txt'), true)).toThrow(
      OUTSIDE
    );
  });

  it('still rejects a dangling symlink reached through the real absolute path', () => {
    const { outer, real, link } = createSymlinkedRoot();
    symlinkSync(path.join(outer, 'nowhere'), path.join(real, 'dangling'));

    expect(() => resolveProjectPath(link, path.join(real, 'dangling'), true)).toThrow(
      'Access denied: unresolved symbolic link'
    );
    expect(() => resolveProjectPath(link, path.join(real, 'dangling', 'child.txt'), true)).toThrow(
      'Access denied: unresolved symbolic link'
    );
    expect(() => resolveProjectPath(link, path.join(real, 'dangling'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
  });

  it('classifies a lexically outside request as outside even when the root cannot be resolved', () => {
    const { outer } = createSymlinkedRoot();
    const missingRoot = path.join(outer, 'missing-root');

    // 根不存在时第二个根无从确立：仍归为越界（与旧实现相同的错误文本），原始 ENOENT 挂在 cause 上。
    let caught: unknown;
    try {
      resolveProjectPath(missingRoot, path.join(outer, 'secret.txt'));
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : '').toBe(OUTSIDE);
    // 根不存在而请求在词法根内时，沿用旧行为直接暴露 realpath(root) 的 ENOENT。
    expect(() => resolveProjectPath(missingRoot, 'src/a.ts')).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
  });
});
