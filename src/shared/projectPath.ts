import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const OUTSIDE_PROJECT_ROOT_MESSAGE = 'Access denied: path is outside project root';

/**
 * Agent 文件端口的根目录约束：同时检查请求路径和 symlink 解析后的实际位置。
 * 新文件检查最近已存在祖先；悬空 symlink 不作为可创建的新路径放行。
 *
 * 两段检查（L1-P7 / L1-I5）：
 * 1. 词法预检查（双根）：请求路径落在 lexicalRoot 或 realpath(root) 任一之内才继续。成功时返回的
 *    absolute 是 realpath，projectRoot 自身是 symlink（macOS /var→/private/var、/tmp→/private/tmp）时，
 *    调用方或模型原样回传这个 absolute 不能再被单根词法检查误拒。预检查不能整体删除：否则根外
 *    symlink 指向根内（outer/alias→root）的路径会经 realpath 落在根内而被放行。
 * 2. realRoot 包含检查：对请求路径（或最近已存在祖先）取 realpath 后必须落在 realRoot 内，这是唯一
 *    放行权威；预检查只负责拒绝，从不单独放行。根内 symlink 指向根外、悬空 symlink 都在这一段被拒。
 */
export function resolveProjectPath(
  projectRoot: string,
  filePath: string,
  allowMissing = false
): { absolute: string; relative: string } {
  const lexicalRoot = path.resolve(projectRoot);
  const requested = path.resolve(lexicalRoot, filePath);
  const realRoot = resolveRootForLexicalRequest(lexicalRoot, requested);
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

/**
 * 双根词法预检查，返回之后权威检查要用的 realRoot。
 * - 请求在 lexicalRoot 内：与旧实现相同，直接取 realpath(root)；根不存在时原样抛出 ENOENT。
 * - 请求不在 lexicalRoot 内：只有落在 realpath(root) 内才继续（典型来源是本函数上一次返回的 absolute）。
 *   根无法 realpath 时第二个根无从确立，仍按越界拒绝（与旧实现同一错误文本，调用方展示的 message
 *   不变），原始 realpath 错误挂在 cause 上，排查时可据此区分“越界”与“根不可解析”。
 */
function resolveRootForLexicalRequest(lexicalRoot: string, requested: string): string {
  if (isContained(lexicalRoot, requested)) {
    return realpathSync(lexicalRoot);
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(lexicalRoot);
  } catch (err: unknown) {
    throw new Error(OUTSIDE_PROJECT_ROOT_MESSAGE, { cause: err });
  }
  if (!isContained(realRoot, requested)) {
    throw new Error(OUTSIDE_PROJECT_ROOT_MESSAGE);
  }
  return realRoot;
}

function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) {
    throw new Error(OUTSIDE_PROJECT_ROOT_MESSAGE);
  }
}

/** 按路径段判断包含关系：`..foo` 这类以两点开头的普通目录名不算越界，同前缀兄弟目录算越界。 */
function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
