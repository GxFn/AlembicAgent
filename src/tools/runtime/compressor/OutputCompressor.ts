/**
 * @module tools/runtime/compressor/OutputCompressor
 *
 * 终端输出压缩器 — 根据命令模式匹配专用解析器，
 * 将原始 stdout/stderr 转换为 LLM 友好的紧凑结构化文本。
 *
 * 流水线: ANSI strip → 专用解析器；不确定格式走重复行折叠，再按总预算截断。
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

interface ParserEntry {
  pattern: RegExp;
  name: string;
  parse: Parser;
  parseInContext?: ContextualParser;
}

const parsers: ParserEntry[] = [];
let parserLoading: Promise<void> | null = null;

/** 只记录解析路径，不把可能含凭据的命令或进程原文写入诊断旁路。 */
function reportFallback(parser: string, reason: string): void {
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[OutputCompressor] parser=${parser}; fallback=generic; reason=${reason}`
      ),
    () => undefined
  );
}

/** 记录解析器有意跳过/关闭过滤的路径；只写解析器名、固定忽略名与计数，不写命令或输出原文。 */
function reportParserNote(parser: string, note: string): void {
  observeSafely(
    () => Logger.getInstance().info(`[OutputCompressor] parser=${parser}; ${note}`),
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

  const PARSER_PATTERNS: Array<[RegExp, string, number]> = [
    [/^git\s+status/, 'git-status', 0],
    [/^git\s+diff/, 'git-diff', 1],
    [/^git\s+log/, 'git-log', 2],
    [
      /^(vitest|jest|mocha|pytest|npx\s+vitest|npx\s+jest|npm\s+test|pnpm\s+test)\b/,
      'test-output',
      3,
    ],
    // biome 不在此列：真实 pretty 诊断写在 stderr、严重级别在框线块内，由 generic 路径保留原文。
    [/^(eslint|tsc|npx\s+tsc)\b/, 'lint-output', 4],
    [/^(rg|grep|ag|ack)\b/, 'grep', 5],
    [/^(ls|find|tree)\b/, 'tree', 6],
    [/^(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/, 'package', 7],
  ];

  for (const [pattern, name, idx] of PARSER_PATTERNS) {
    const m = modules[idx];
    if (m.status === 'fulfilled' && typeof m.value?.parse === 'function') {
      const parseInContext =
        'parseInContext' in m.value && typeof m.value.parseInContext === 'function'
          ? m.value.parseInContext
          : undefined;
      parsers.push({ pattern, name, parse: m.value.parse, parseInContext });
    } else {
      reportFallback(name, 'parser-load-unavailable');
    }
  }
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
   * 适用于确定已调用过 compress() 之后的场景。
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

    for (const entry of parsers) {
      if (entry.pattern.test(command)) {
        // 无需另建 shell parser：不确定的复合命令保留原文，不能只概括第一段。
        if (/[;&|`<>\n\r]|\$\(/u.test(command)) {
          reportFallback(entry.name, 'compound-command');
          break;
        }
        // terminal 将两条流用该标记装配；专用解析器只压 stdout，stderr 继续参与总配额。
        const separator = plain.indexOf('\n\n[stderr]\n');
        const stderrOnly = plain.startsWith('[stderr]\n');
        const stdout = stderrOnly ? '' : separator >= 0 ? plain.slice(0, separator) : plain;
        const stderr = stderrOnly ? plain : separator >= 0 ? plain.slice(separator + 2) : '';
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
            const combined = stderr ? `${result}\n\n${stderr}` : result;
            if (combined.length <= maxChars) {
              return combined;
            }
            return truncateOutput(combined, maxChars);
          }
          // 条目全被忽略名过滤时没有可展示的树，原因与“格式无法识别”不同，分开记录。
          reportFallback(
            entry.name,
            outcome.omittedEntries > 0 ? 'all-entries-ignored' : 'unrecognized-output'
          );
        } catch (err: unknown) {
          void err;
          reportFallback(entry.name, 'parser-error');
          break;
        }
        break;
      }
    }

    const cleaned = cleanOutput(plain);
    if (cleaned.length <= maxChars) {
      return cleaned;
    }
    return truncateOutput(cleaned, maxChars);
  }
}
