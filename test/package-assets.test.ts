import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findAlembicPackageRoot, PACKAGE_ROOT } from '../src/shared/packageAssets.js';

/**
 * 包根定位的错误原因钉子（L1-I8）。
 *
 * 背景：向上查找 @alembic/agent 包根时，损坏或无权限的祖先 package.json 曾被裸 catch 吞掉，
 * 最终只抛一句「找不到包根」，丢失是哪一层、因为什么失败。这里锁定：失败时最终 Error
 * 带 cause，并在消息中点名最后一个无法解析的 package.json；成功路径不变。
 */
describe('package asset root lookup', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function tempRoot(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-package-assets-')));
    roots.push(root);
    return root;
  }

  it('resolves the @alembic/agent package root from its own module location', () => {
    expect(findAlembicPackageRoot()).toBe(PACKAGE_ROOT);
  });

  it('keeps the unreadable ancestor package.json as the cause of the final error', async () => {
    const root = await tempRoot();
    const nested = join(root, 'nested', 'deeper');
    await mkdir(nested, { recursive: true });
    const broken = join(root, 'package.json');
    await writeFile(broken, '{ not json', 'utf-8');

    let caught: unknown;
    try {
      findAlembicPackageRoot(nested);
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain('Could not locate package root for @alembic/agent');
    expect(error.message).toContain(broken);
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it('throws without a cause when no ancestor package.json failed to parse', async () => {
    const root = await tempRoot();
    const nested = join(root, 'plain');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'unrelated' }), 'utf-8');

    let caught: unknown;
    try {
      findAlembicPackageRoot(nested);
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBeUndefined();
  });
});
