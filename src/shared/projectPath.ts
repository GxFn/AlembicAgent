import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Agent 文件端口的根目录约束：同时检查请求路径和 symlink 解析后的实际位置。
 * 新文件检查最近已存在祖先；悬空 symlink 不作为可创建的新路径放行。
 */
export function resolveProjectPath(
  projectRoot: string,
  filePath: string,
  allowMissing = false
): { absolute: string; relative: string } {
  const lexicalRoot = path.resolve(projectRoot);
  const requested = path.resolve(lexicalRoot, filePath);
  assertContained(lexicalRoot, requested);
  const realRoot = realpathSync(lexicalRoot);
  let ancestor = requested;
  const missing: string[] = [];
  while (true) {
    try {
      const absolute = path.join(realpathSync(ancestor), ...missing);
      assertContained(realRoot, absolute);
      return { absolute, relative: path.relative(realRoot, absolute) };
    } catch (err: unknown) {
      if (!allowMissing || !isMissing(err)) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      try {
        lstatSync(ancestor);
        throw new Error('Access denied: unresolved symbolic link');
      } catch (statError: unknown) {
        if (!isMissing(statError)) {
          throw statError instanceof Error ? statError : new Error(String(statError));
        }
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw new Error('Access denied: project path cannot be resolved');
      }
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Access denied: path is outside project root');
  }
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
