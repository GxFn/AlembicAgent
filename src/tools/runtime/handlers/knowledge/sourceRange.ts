/**
 * 读取项目内有界来源引用（`path:N` / `path:N-M`）的单一实现。
 *
 * knowledge.submit 链路上有三个消费方需要同一份“引用 → 真实行”的结论：
 *   - recipeAuthoringGate 的 in-process sourceRefResolver（映射为 Core 违规码与文案）；
 *   - recipeProductionAdapter 的 profile/code 证据读取（另加 160 行上限与空内容拒绝）；
 *   - knowledge/sources 的 F4b 修复提示（另加 12 行截断）。
 * 此前三处各自实现，越界判定与换行语义不一致：CRLF 文件在 adapter 中残留 '\r' 导致合法多行
 * coreCode 被清空；以换行结尾的文件 `path:N+1` 在门禁里有效、在 adapter 中被丢弃。
 *
 * 本模块只负责“能否读、读到什么、为什么不能读”，不打日志、不决定策略：每种拒绝都带
 * reason + detail 返回，由调用方按各自语境记录诊断（门禁保持 Core 违规码、adapter 回传
 * rejected 列表并 warn、修复提示 debug）。统一语义：
 *   - 路径：反斜杠转 '/' 后 posix 规范化；绝对路径或以 '..' 开头直接拒绝；词法越界拒绝；
 *     文件存在后再经 resolveProjectPath 做符号链接越界判定（真实文件必须仍在真实项目根内）。
 *   - 行：按 /\r?\n/ 切分，以换行结尾的文件不产生额外空行；空文件没有行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath } from '#shared/projectPath.js';

/** 与 Core 门禁 SOURCE_REF_RE 同形：`path:N` 或 `path:N-M`。 */
const SOURCE_REF_RE = /^(.+?):(\d+)(?:-(\d+))?$/;

/** 解析后的有界引用；`path` 保留声明中的路径原文，规范化在读取时进行。 */
export interface ParsedSourceRef {
  path: string;
  start: number;
  end: number;
  /** 声明里是否写了 `-M`；单行引用 `path:N` 为 false，end 等于 start。 */
  explicitEnd: boolean;
}

/**
 * 拒绝原因：
 * - format：不是 `path:N` / `path:N-M`；
 * - path-invalid：规范化后是绝对路径或以 '..' 开头；
 * - outside-root：词法解析后落在项目根之外；
 * - not-found：文件不存在或不是普通文件；
 * - symlink-escape：resolveProjectPath 拒绝（符号链接解析到项目根外，或解析期间的 fs 异常）；
 * - line-out-of-range：start < 1、end < start 或 end 超过文件逻辑行数；
 * - read-error：读取文件内容时的 fs 异常（如 EACCES、竞态删除）。
 */
export type SourceRangeFailureReason =
  | 'format'
  | 'path-invalid'
  | 'outside-root'
  | 'not-found'
  | 'symlink-escape'
  | 'line-out-of-range'
  | 'read-error';

export interface SourceRangeFailure<R extends SourceRangeFailureReason = SourceRangeFailureReason> {
  ok: false;
  reason: R;
  /** 人可读细节（含 fs 错误码/消息），不含文件内容。 */
  detail: string;
  /** 规范化后的仓库相对路径；format 失败时缺省。 */
  relative?: string;
  /** 文件逻辑行数；仅在文件已读到时给出（line-out-of-range），供修复提示说明真实行数。 */
  lineCount?: number;
}

export interface ProjectSourceFile {
  ok: true;
  /** 规范化后的仓库相对路径（posix，保留模型引用的词法路径，不展开符号链接）。 */
  relative: string;
  /** realpath 后的真实文件绝对路径。 */
  realFile: string;
  /** 真实文件相对真实项目根的路径（posix）；文档/代码分类依据它，符号链接不能改变类别。 */
  realRelative: string;
  /** 整个文件的逻辑行（不含 '\r'，末尾换行不产生空行）。 */
  fileLines: string[];
}

export interface SourceRange extends Omit<ProjectSourceFile, 'ok'> {
  ok: true;
  start: number;
  end: number;
  lineCount: number;
  /** start..end（含）的逻辑行。 */
  lines: string[];
}

/** 读取文件阶段可能的拒绝：不含 format 与 line-out-of-range。 */
export type ProjectSourceFileResult =
  | ProjectSourceFile
  | SourceRangeFailure<Exclude<SourceRangeFailureReason, 'format' | 'line-out-of-range'>>;
/** 已解析范围的读取结果：不含 format（引用已由调用方或 Core 解析）。 */
export type ResolvedSourceRangeResult =
  | SourceRange
  | SourceRangeFailure<Exclude<SourceRangeFailureReason, 'format'>>;
export type SourceRangeResult = SourceRange | SourceRangeFailure;

/**
 * 统一切行语义：按 /\r?\n/ 切分；以换行（LF 或 CRLF）结尾时最后的空串不算一行；空串没有行。
 * 因此 `path:N+1`（N 为最后一行）对以换行结尾的文件一律越界（L4-P22 决策）。行数与 code.read
 * 的 splitSourceLines（L4-P17b）一致：两者都不把末尾换行计为额外行；code.read 按 '\n' 切分并
 * 保留 '\r'（对齐 Core 冻结证据字节），本模块去掉 '\r' 供片段比对，行数相同、行内容差一个 '\r'。
 * 唯一差异是空文件：code.read 报 1 个空行，本模块没有行（空文件没有可引用的内容）。
 */
export function splitLogicalLines(content: string): string[] {
  if (content === '') {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (content.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

/** 解析 `path:N` / `path:N-M`；不合格式返回 null（调用方自行决定是否记为 format 拒绝）。 */
export function parseBoundedSourceRef(ref: string): ParsedSourceRef | null {
  const match = SOURCE_REF_RE.exec(ref.trim());
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return null;
  }
  return { path: match[1], start, end, explicitEnd: match[3] !== undefined };
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const code = 'code' in err && typeof err.code === 'string' ? `${err.code}: ` : '';
    return `${code}${err.message}`;
  }
  return String(err);
}

/**
 * 按词法判定 target 是否在 root 内（含 root 自身），与 AlembicPlugin recipe-evidence-gate 的
 * isInsideRoot 同实现。它不解析符号链接，符号链接越界由 resolveProjectPath 另行判定。
 */
function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 解析并读取项目内文件的全部逻辑行。分支顺序与 in-process 门禁 resolver 一致：
 * 路径形态 → 词法越界 → 存在且为普通文件 → resolveProjectPath 符号链接越界 → 读取内容。
 */
export function readProjectSourceFile(
  projectRoot: string,
  rawPath: string
): ProjectSourceFileResult {
  const relative = path.posix.normalize(rawPath.trim().replaceAll('\\', '/'));
  if (path.isAbsolute(relative) || relative.startsWith('..')) {
    return {
      ok: false,
      reason: 'path-invalid',
      relative,
      detail: 'path must be repo-relative and stay inside the project root',
    };
  }
  const lexicalAbsolute = path.resolve(projectRoot, relative);
  if (!isInsideRoot(projectRoot, lexicalAbsolute)) {
    return {
      ok: false,
      reason: 'outside-root',
      relative,
      detail: 'path resolves outside the project root',
    };
  }
  // existsSync/statSync 跟随符号链接；悬空链接与目录都按 not-found 处理，与门禁原分支一致。
  let isFile = false;
  try {
    isFile = fs.existsSync(lexicalAbsolute) && fs.statSync(lexicalAbsolute).isFile();
  } catch (err: unknown) {
    return { ok: false, reason: 'not-found', relative, detail: errorDetail(err) };
  }
  if (!isFile) {
    return {
      ok: false,
      reason: 'not-found',
      relative,
      detail: 'file does not exist or is not a regular file',
    };
  }
  let realFile: string;
  let realRelative: string;
  try {
    const resolved = resolveProjectPath(projectRoot, relative);
    realFile = resolved.absolute;
    realRelative = resolved.relative.split(path.sep).join('/');
  } catch (err: unknown) {
    return { ok: false, reason: 'symlink-escape', relative, detail: errorDetail(err) };
  }
  let content: string;
  try {
    content = fs.readFileSync(realFile, 'utf8');
  } catch (err: unknown) {
    return { ok: false, reason: 'read-error', relative, detail: errorDetail(err) };
  }
  return { ok: true, relative, realFile, realRelative, fileLines: splitLogicalLines(content) };
}

/** 读取已解析好的 `{path,start,end}`；门禁 resolver 用它（Core 已完成引用解析）。 */
export function readSourceRange(
  projectRoot: string,
  target: { path: string; start: number; end: number }
): ResolvedSourceRangeResult {
  const file = readProjectSourceFile(projectRoot, target.path);
  if (!file.ok) {
    return file;
  }
  const lineCount = file.fileLines.length;
  const { start, end } = target;
  // 越界不 clamp：start/end 必须都落在文件逻辑行内（末尾换行不计额外行）。
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > lineCount
  ) {
    return {
      ok: false,
      reason: 'line-out-of-range',
      relative: file.relative,
      lineCount,
      detail: `lines ${start}-${end} are outside the file (${lineCount} lines)`,
    };
  }
  return {
    ok: true,
    relative: file.relative,
    realFile: file.realFile,
    realRelative: file.realRelative,
    fileLines: file.fileLines,
    start,
    end,
    lineCount,
    lines: file.fileLines.slice(start - 1, end),
  };
}

/** 解析并读取一条声明的有界引用；adapter 与修复提示用它。 */
export function readBoundedSourceRange(projectRoot: string, ref: string): SourceRangeResult {
  const parsed = parseBoundedSourceRef(ref);
  if (!parsed) {
    return {
      ok: false,
      reason: 'format',
      detail: 'ref must be path:N or path:N-M',
    };
  }
  return readSourceRange(projectRoot, parsed);
}
