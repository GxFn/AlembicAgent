/**
 * @module tools/runtime/compressor/OutputCompressor
 *
 * 终端输出压缩器 — 根据命令模式匹配专用解析器，
 * 将原始 stdout/stderr 转换为 LLM 友好的紧凑结构化文本。
 *
 * 流水线: ANSI strip → 专用解析器；不确定格式走 generic 路径，再按总预算截断。
 *
 * 预算策略（不在预算内改写事实）：
 * - generic 路径预算内只去 ANSI，原文逐行保留；超预算才折叠连续重复行，仍超再截断。
 *   重复行折叠插入的 '(repeated N times)' 与原文无法区分，预算内折叠会让模型看到文件里不存在的行。
 * - 会丢掉正文的解析器（目前只有 git-diff，见 keepRawWithinBudget）预算内直接返回原文，超预算才摘要。
 * - 任何解析器摘要首行都带 '[summarized by <parser>; raw <N> chars]'，让模型知道看到的是摘要而非原文，
 *   N 是被摘要的 stdout 字符数（stderr 不参与摘要，原样附在后面）。
 *
 * 诊断级别：parser-error 与解析器加载失败记 warn；格式不认识、复合命令、全部条目被过滤是预期路径记 info；
 * 空输出跳过解析器、预算内保留原文、generic 超预算压缩记 debug。诊断只写解析器名、原因、计数与错误类名，
 * 不写命令或输出原文。
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { CompressOpts } from '#tools/kernel/registry.js';
import { cleanOutput, stripAnsi, truncateOutput } from './strip.js';

type Parser = (raw: string) => string | null;

/**
 * 需要命令上下文的解析结果（目前只有 tree）：除文本外带回有意跳过的条目统计，
 * 由压缩器统一记录诊断；解析器模块按分层契约不能自己打日志。
 */
interface ContextualParseResult {
  text: string | null;
  omittedEntries: number;
  omittedNames: readonly string[];
  filterDisabled: boolean;
}

type ContextualParser = (raw: string, command: string) => ContextualParseResult;

/** 命令到解析器的静态匹配表；compressSync 在解析器未加载时也要据此判断是否错过了专用解析。 */
interface ParserSpec {
  pattern: RegExp;
  name: string;
  /**
   * 内部策略字段（不公开）：stdout+stderr 去 ANSI 后未超预算时直接返回原文，不调用解析器。
   * 只给摘要会丢掉正文的解析器打开（目前只有 git-diff：计数摘要看不到改了什么）；
   * test/lint 等长输出的摘要保留了关键事实，仍按原策略摘要。
   */
  keepRawWithinBudget: boolean;
}

interface ParserEntry extends ParserSpec {
  /** 严格入口：格式不符返回 null，解析器缺陷抛出异常，由 compressSync 归类为 parser-error。 */
  parse: Parser;
  parseInContext?: ContextualParser;
}

/** 顺序必须与 loadParsers 中的 import 列表一致：按下标对应模块。 */
const PARSER_SPECS: readonly ParserSpec[] = [
  { pattern: /^git\s+status/, name: 'git-status', keepRawWithinBudget: false },
  { pattern: /^git\s+diff/, name: 'git-diff', keepRawWithinBudget: true },
  { pattern: /^git\s+log/, name: 'git-log', keepRawWithinBudget: false },
  {
    pattern: /^(vitest|jest|mocha|pytest|npx\s+vitest|npx\s+jest|npm\s+test|pnpm\s+test)\b/,
    name: 'test-output',
    keepRawWithinBudget: false,
  },
  // biome 不在此列：真实 pretty 诊断写在 stderr、严重级别在框线块内，由 generic 路径保留原文。
  { pattern: /^(eslint|tsc|npx\s+tsc)\b/, name: 'lint-output', keepRawWithinBudget: false },
  { pattern: /^(rg|grep|ag|ack)\b/, name: 'grep', keepRawWithinBudget: false },
  { pattern: /^(ls|find|tree)\b/, name: 'tree', keepRawWithinBudget: false },
  {
    pattern: /^(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/,
    name: 'package',
    keepRawWithinBudget: false,
  },
];

/** terminal 对空输出写入的占位文本（handlers/terminal.ts combineOutput）；没有可解析的 stdout。 */
const NO_OUTPUT_PLACEHOLDER = '[no output]';

let parserLoading: Promise<void> | null = null;
/**
 * 延迟加载的解析器表（null 槽位）：loadParsers 全部结束后一次性赋值，null 表示尚未加载完成。
 * 不在加载过程中逐个 push，避免同步入口看到“加载了一半”的表。
 */
let loadedParsers: readonly ParserEntry[] | null = null;

type FallbackLevel = 'warn' | 'info';

/** 只记录解析路径，不把可能含凭据的命令或进程原文写入诊断旁路。 */
function reportFallback(parser: string, reason: string, level: FallbackLevel): void {
  const message = `[OutputCompressor] parser=${parser}; fallback=generic; reason=${reason}`;
  observeSafely(
    () =>
      level === 'warn' ? Logger.getInstance().warn(message) : Logger.getInstance().info(message),
    () => undefined
  );
}

/** 只取错误类名（受限字符集），不取异常消息——消息可能拼进了输出原文或命令。 */
function errorNameOf(err: unknown): string {
  const rawName = err instanceof Error ? err.name : typeof err;
  return /^[\w$.-]{1,64}$/u.test(rawName) ? rawName : 'unnamed';
}

/** 解析器自身缺陷：解析器的严格入口抛出异常时调用，回退 generic 并记 warn。 */
function reportParserError(parser: string, err: unknown): void {
  reportFallback(parser, `parser-error; error=${errorNameOf(err)}`, 'warn');
}

/** 记录解析器有意跳过/关闭过滤的路径；只写解析器名、固定忽略名与计数，不写命令或输出原文。 */
function reportParserNote(parser: string, note: string): void {
  observeSafely(
    () => Logger.getInstance().info(`[OutputCompressor] parser=${parser}; ${note}`),
    () => undefined
  );
}

/** 高频的正常分支（空输出跳过、预算内保留原文、generic 超预算压缩）只记 debug，避免掩盖真故障。 */
function reportDebugNote(note: string): void {
  observeSafely(
    () => Logger.getInstance().debug(`[OutputCompressor] ${note}`),
    () => undefined
  );
}

/**
 * 延迟加载所有解析器（避免启动时 import 全部模块）。
 * 幂等 — 多次调用只执行一次。
 */
function ensureParsers(): Promise<void> {
  // 同一次初始化 Promise 供所有并发首调等待，避免只设置 loaded 标志却尚未完成导入。
  parserLoading ??= loadParsers();
  return parserLoading;
}

async function loadParsers(): Promise<void> {
  const modules = await Promise.allSettled([
    import('./parsers/GitStatusParser.js'),
    import('./parsers/GitDiffParser.js'),
    import('./parsers/GitLogParser.js'),
    import('./parsers/TestOutputParser.js'),
    import('./parsers/LintOutputParser.js'),
    import('./parsers/GrepParser.js'),
    import('./parsers/TreeParser.js'),
    import('./parsers/PackageParser.js'),
  ]);

  const entries: ParserEntry[] = [];
  PARSER_SPECS.forEach((spec, idx) => {
    const m = modules[idx];
    // 只接受带严格入口的模块：公开 parse 会吞掉异常，用它就无法区分解析器缺陷与格式不符。
    if (m?.status === 'fulfilled' && typeof m.value?.parseStrict === 'function') {
      const parseInContext =
        'parseInContext' in m.value && typeof m.value.parseInContext === 'function'
          ? m.value.parseInContext
          : undefined;
      entries.push({ ...spec, parse: m.value.parseStrict, parseInContext });
    } else {
      reportFallback(spec.name, 'parser-load-unavailable', 'warn');
    }
  });
  loadedParsers = entries;
}

/** stdout 为空、只有空白或只是 terminal 的空输出占位时，没有任何可解析内容。 */
function hasParsableStdout(stdout: string): boolean {
  // 用正则而不是 trim()：判断不需要构造新字符串。
  return stdout !== NO_OUTPUT_PLACEHOLDER && /\S/u.test(stdout);
}

export class OutputCompressor {
  /**
   * 压缩终端输出。
   *
   * @param raw - 原始 stdout + stderr
   * @param opts - 压缩选项
   * @returns 压缩后的文本
   */
  async compress(raw: string, opts: CompressOpts = {}): Promise<string> {
    if (!raw || raw.length === 0) {
      return raw;
    }

    await ensureParsers();

    return this.compressSync(raw, opts);
  }

  /**
   * 同步版本 — 假设解析器已加载。
   * 适用于确定已调用过 compress() 之后的场景。未加载时本次只能走 generic 路径：命令本该命中专用解析器时
   * 记一条 parsers-not-loaded（warn），并顺带启动加载，加载完成后的同步调用即可恢复专用解析。
   */
  compressSync(raw: string, opts: CompressOpts = {}): string {
    if (!raw || raw.length === 0) {
      return raw;
    }

    // 先解析完整行集合；提前折叠重复行会让 lint/test 计数失真。
    const plain = stripAnsi(raw);
    const command = opts.command ?? '';
    const tokenBudget = opts.tokenBudget ?? 4000;
    const maxChars = tokenBudget * 4;

    const parsers = loadedParsers;
    if (parsers === null) {
      const missed = PARSER_SPECS.find((spec) => spec.pattern.test(command));
      if (missed) {
        // 调用方在 compress() 之前直接用同步入口：本次错过专用解析。记 warn 并启动幂等加载，
        // 只有加载完成前的调用会走到这里，不会每次都刷屏。
        reportFallback(missed.name, 'parsers-not-loaded', 'warn');
        ensureParsers().catch((err: unknown) => {
          // loadParsers 用 allSettled 收集模块，正常不会 reject；万一 reject 也只记录，不让同步入口抛出未处理的 Promise。
          reportFallback(missed.name, `parser-load-failed; error=${errorNameOf(err)}`, 'warn');
        });
      }
    }

    for (const entry of parsers ?? []) {
      if (entry.pattern.test(command)) {
        // 无需另建 shell parser：不确定的复合命令保留原文，不能只概括第一段。
        if (/[;&|`<>\n\r]|\$\(/u.test(command)) {
          reportFallback(entry.name, 'compound-command', 'info');
          break;
        }
        // terminal 将两条流用该标记装配；专用解析器只压 stdout，stderr 继续参与总配额。
        const separator = plain.indexOf('\n\n[stderr]\n');
        const stderrOnly = plain.startsWith('[stderr]\n');
        const stdout = stderrOnly ? '' : separator >= 0 ? plain.slice(0, separator) : plain;
        const stderr = stderrOnly ? plain : separator >= 0 ? plain.slice(separator + 2) : '';
        // 空 stdout（干净仓库的 git diff、只有 stderr 的失败）不是“格式不认识”，跳过解析器且不记回退。
        if (!hasParsableStdout(stdout)) {
          reportDebugNote(`parser=${entry.name}; parser-skipped=empty-stdout`);
          break;
        }
        // 丢正文类解析器：预算放得下原文就不摘要，模型才能看到具体改动。
        if (entry.keepRawWithinBudget && plain.length <= maxChars) {
          reportDebugNote(
            `parser=${entry.name}; raw-kept=within-budget; chars=${plain.length}; budget=${maxChars}`
          );
          return plain;
        }
        try {
          const outcome = entry.parseInContext
            ? entry.parseInContext(stdout, command)
            : {
                text: entry.parse(stdout),
                omittedEntries: 0,
                omittedNames: [],
                filterDisabled: false,
              };
          if (outcome.filterDisabled) {
            reportParserNote(
              entry.name,
              'ignored-name-filter=off; reason=command-targets-ignored-name'
            );
          }
          const result = outcome.text;
          if (result !== null) {
            if (outcome.omittedEntries > 0) {
              reportParserNote(
                entry.name,
                `omitted=${outcome.omittedEntries}; names=${outcome.omittedNames.join(',')}`
              );
            }
            // 摘要标记放在首行：截断保留头部，标记不会被截掉。
            const marked = `[summarized by ${entry.name}; raw ${stdout.length} chars]\n${result}`;
            const combined = stderr ? `${marked}\n\n${stderr}` : marked;
            if (combined.length <= maxChars) {
              return combined;
            }
            return truncateOutput(combined, maxChars);
          }
          // 条目全被忽略名过滤时没有可展示的树，原因与“格式无法识别”不同，分开记录；两者都是预期路径。
          reportFallback(
            entry.name,
            outcome.omittedEntries > 0 ? 'all-entries-ignored' : 'unrecognized-output',
            'info'
          );
        } catch (err: unknown) {
          reportParserError(entry.name, err);
        }
        break;
      }
    }

    // generic 路径预算内只去 ANSI：重复行折叠会插入与原文无法区分的标记行，只在超预算时才值得付出这个代价。
    if (plain.length <= maxChars) {
      return plain;
    }
    const cleaned = cleanOutput(plain);
    const fits = cleaned.length <= maxChars;
    reportDebugNote(
      `generic=over-budget; chars=${plain.length}; collapsed=${cleaned.length}; budget=${maxChars}; result=${fits ? 'collapsed' : 'truncated'}`
    );
    if (fits) {
      return cleaned;
    }
    return truncateOutput(cleaned, maxChars);
  }
}
