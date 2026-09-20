import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 只清理本仓生成目录，避免已退役源码的旧 JS/d.ts 被再次打包发布。
const root = fileURLToPath(new URL('..', import.meta.url));
// 尾斜杠会让部分 Node/fs 路径跟随目录符号链接；无尾斜杠只删除链接本身。
rmSync(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    '-p',
    'tsconfig.json',
  ],
  { cwd: root, stdio: 'inherit' }
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
