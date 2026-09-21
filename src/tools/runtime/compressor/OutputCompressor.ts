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

interface ParserEntry {
  pattern: RegExp;
  name: string;
  parse: Parser;
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
    [/^(eslint|biome|tsc|npx\s+tsc)\b/, 'lint-output', 4],
    [/^(rg|grep|ag|ack)\b/, 'grep', 5],
    [/^(ls|find|tree)\b/, 'tree', 6],
    [/^(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/, 'package', 7],
  ];

  for (const [pattern, name, idx] of PARSER_PATTERNS) {
    const m = modules[idx];
    if (m.status === 'fulfilled' && typeof m.value?.parse === 'function') {
      parsers.push({ pattern, name, parse: m.value.parse });
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
          const result = entry.parse(stdout);
          if (result !== null) {
            const combined = stderr ? `${result}\n\n${stderr}` : result;
            if (combined.length <= maxChars) {
              return combined;
            }
            return truncateOutput(combined, maxChars);
          }
          reportFallback(entry.name, 'unrecognized-output');
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
