/**
 * C28(L7-P2)：src/agent/production/index.ts 曾是一个无任何导入方的 `export *` barrel，
 * 会把未冻结的严格生产提示词与阶段工厂聚合成一个看似可用的入口。
 * 包出口 @alembic/agent/production 指向根层显式 facade(src/production.ts → dist/production.js)，
 * package.json 没有通配 exports，该目录 barrel 从包外不可达，属于死代码，已删除。
 *
 * 这里锁住：barrel 不再存在；源码/测试/脚本里没有任何对该目录 barrel 的导入；
 * 公开出口仍指向显式 facade，不依赖目录 barrel。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const BARREL = 'src/agent/production/index.ts';

/** 递归收集 ts/mts/js/mjs 源文件；跳过构建产物、依赖与严格生产的项目副本夹具。 */
function collectSources(relativeDir: string): string[] {
  const absoluteDir = path.join(ROOT, relativeDir);
  if (!existsSync(absoluteDir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    const relativePath = path.join(relativeDir, entry);
    if (
      entry === 'node_modules' ||
      entry === 'dist' ||
      relativePath.startsWith(path.join('test', 'fixtures', 'strict-production', 'projects'))
    ) {
      continue;
    }
    if (statSync(path.join(ROOT, relativePath)).isDirectory()) {
      files.push(...collectSources(relativePath));
    } else if (/\.(?:ts|mts|js|mjs)$/.test(entry)) {
      files.push(relativePath);
    }
  }
  return files;
}

// 目录 barrel 的三种可达写法：显式 index 路径、相对目录导入(`'../production'`、`'./agent/production'`)。
const BARREL_IMPORT = [
  /agent\/production\/index(?:\.[cm]?[jt]s)?['"]/,
  /from\s+['"](?:\.\.?\/)+(?:agent\/)?production['"]/,
  /from\s+['"](?:\.\.?\/)+(?:agent\/)?production\/index(?:\.[cm]?[jt]s)?['"]/,
];

describe('production directory barrel is retired (C28)', () => {
  it('src/agent/production/index.ts no longer exists', () => {
    expect(existsSync(path.join(ROOT, BARREL))).toBe(false);
  });

  it('no source, test, or script imports the production directory barrel', () => {
    const offenders: string[] = [];
    for (const relativePath of [
      ...collectSources('src'),
      ...collectSources('test'),
      ...collectSources('scripts'),
    ]) {
      if (relativePath === path.join('test', 'production-dead-barrel.test.ts')) {
        continue;
      }
      const source = readFileSync(path.join(ROOT, relativePath), 'utf8');
      for (const pattern of BARREL_IMPORT) {
        if (pattern.test(source)) {
          offenders.push(`${relativePath} ~ ${pattern.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the public ./production export still resolves to the explicit root facade', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, { types?: string; import?: string }>;
    };
    expect(pkg.exports?.['./production']).toEqual({
      types: './dist/production.d.ts',
      import: './dist/production.js',
    });
    expect(existsSync(path.join(ROOT, 'src/production.ts'))).toBe(true);
    // 没有通配出口时，目录 barrel 无法从包外到达。
    expect(Object.keys(pkg.exports ?? {}).some((key) => key.includes('*'))).toBe(false);
  });
});
