/**
 * Alembic package asset paths.
 *
 * Core owns generic package-root primitives. AlembicAgent currently only needs
 * its own package root for local prompt/persona assets such as SOUL.md.
 *
 * 本模块刻意不在加载期求包根：SOUL.md 这类资源是可选的，包根定位失败不能让
 * Conversation → CapabilityRegistry → tools/runtime 的导入链在 import 期抛错。
 * 调用方在真正需要资源时调用 findAlembicPackageRoot，并自行决定失败时的降级与诊断。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;

/**
 * 从 startDir 向上查找 name 为 @alembic/agent 的 package.json 所在目录。
 *
 * 损坏或无权限（如 EACCES）的祖先 package.json 不会中断查找，而是被跳过继续向上；
 * 但最后一次失败的路径与错误会保留下来，在最终找不到包根时作为 cause 抛出，
 * 便于定位是哪一层、因为什么失败。本函数保持纯函数、不依赖 logger，诊断信息完全
 * 经由抛出的 Error 传递，由调用方捕获后记录诊断（见 Conversation 的 SOUL 加载）。
 */
export function findAlembicPackageRoot(startDir: string = __dirname): string {
  let dir = startDir;
  let lastFailure: { candidate: string; error: unknown } | null = null;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg.name === '@alembic/agent') {
          return dir;
        }
      } catch (err: unknown) {
        // 跳过该层继续向上，只记住最后一次失败，供最终错误携带原因。
        lastFailure = { candidate, error: err };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  const baseMessage = '[AlembicAgent] Could not locate package root for @alembic/agent.';
  if (lastFailure) {
    // 消息只写错误类别（errno code 或错误类名）；JSON.parse 的原始消息会回显文件片段，
    // 完整错误保留在 cause 中供调试。
    const reason = describeErrorKind(lastFailure.error);
    throw new Error(
      `${baseMessage} Last unreadable package.json: ${lastFailure.candidate} (${reason})`,
      { cause: lastFailure.error }
    );
  }
  throw new Error(baseMessage);
}

function describeErrorKind(err: unknown): string {
  if (err instanceof Error) {
    return 'code' in err && typeof err.code === 'string' ? err.code : err.name;
  }
  return typeof err;
}
