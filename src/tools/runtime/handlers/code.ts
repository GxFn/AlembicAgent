/**
 * @module tools/runtime/handlers/code
 *
 * 代码智能工具 — Agent 与项目源码交互的统一入口。
 * Actions: search, read, outline, structure, write
 *
 * 引擎: ripgrep (搜索), Tree-sitter via AstAnalyzer (骨架), fs (读写)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import Logger from '@alembic/core/logging';
import { isThenable, observeSafely } from '#shared/observers.js';
import { isDeadlineAbort } from '#shared/operation.js';
import { resolveProjectPath } from '#shared/projectPath.js';
import {
  estimateTokens,
  fail,
  ok,
  type ToolContext,
  type ToolDiagnosticWarning,
  type ToolResult,
} from '#tools/kernel/registry.js';

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (action) {
    case 'search':
      return handleSearch(params, ctx);
    case 'read':
      return handleRead(params, ctx);
    case 'outline':
      return handleOutline(params, ctx);
    case 'structure':
      return handleStructure(params, ctx);
    case 'write':
      return handleWrite(params, ctx);
    default:
      return fail(`Unknown code action: ${action}`);
  }
}

/* ================================================================== */
/*  code.search                                                        */
/* ================================================================== */

interface SearchMatch {
  file: string;
  line: number;
  content: string;
  context?: string[];
}

// 缓存实例由宿主按读取视图复用；旧 get/set-only 端口也能逻辑失效，无需新增 clear 合同。
// generation 只进入本工具的缓存 key；旧条目的容量/TTL 仍由宿主管理。
const searchCacheGenerations = new WeakMap<NonNullable<ToolContext['searchCache']>, number>();

/** 单个 pattern 的搜索结果；matches 保持引擎的遍历顺序，total 是该 pattern 的观察下界。 */
interface PatternSearchOutcome {
  pattern: string;
  matches: SearchMatch[];
  total: number;
}

/** timeout/aborted 中断点：哪个 pattern 被打断、哪些 pattern 根本没有执行。 */
interface SearchHalt {
  status: 'timeout' | 'aborted';
  reason: string;
  pattern?: string;
  skipped: string[];
}

async function handleSearch(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  // 只读 patterns[]：schema 把 patterns 列为 required，router 的 Ajv 阶段已拒绝只带单数 pattern
  // 的调用，所以这里不保留单数回退。缺失或非数组（只可能来自绕过 router 的直调）与空数组一样
  // 返回明确的 fail，不会把字符串逐字符当成多个 pattern 搜索。
  const patterns = Array.isArray(params.patterns) ? (params.patterns as string[]) : [];
  if (patterns.length === 0) {
    return fail('code.search requires patterns[]');
  }
  if (patterns.length > 10) {
    return fail('code.search: max 10 patterns per call');
  }

  const glob = params.glob as string | undefined;
  const maxResults = Math.min((params.maxResults as number) || 10, 50);
  const contextLines = (params.contextLines as number) ?? 2;
  const regex = (params.regex as boolean) ?? false;

  const outcomes: PatternSearchOutcome[] = [];
  const startMs = Date.now();
  let fellBack = false;
  let rejectedPaths = 0;
  // I13：输出超限 / rg 非零退出只影响单个 pattern（affected），引擎异常且无命中记为 failures；
  // 两者都继续执行后续 pattern。只有 timeout/aborted（halted）才中断循环，并记下未执行的 pattern。
  const affected: Array<{ pattern: string; reason: string }> = [];
  const failures: Array<{ pattern: string; reason: string }> = [];
  let halted: SearchHalt | undefined;
  const warnings: ToolDiagnosticWarning[] = [];

  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (ctx.abortSignal?.aborted) {
      halted = {
        status: searchAbortStatus(ctx.abortSignal),
        reason: 'Search cancelled before the next pattern.',
        skipped: patterns.slice(index),
      };
      break;
    }

    const cacheKey = JSON.stringify([
      ctx.projectRoot,
      ctx.searchCache ? (searchCacheGenerations.get(ctx.searchCache) ?? 0) : 0,
      pattern,
      glob ?? null,
      regex,
      maxResults,
      contextLines,
    ]);
    const cached = ctx.searchCache?.get(cacheKey);
    if (cached) {
      const cachedResult = cached as { matches: SearchMatch[]; total: number };
      outcomes.push({ pattern, matches: cachedResult.matches, total: cachedResult.total });
      continue;
    }

    const opts = { glob, maxResults, contextLines, regex, signal: ctx.abortSignal };
    try {
      let result: RipgrepResult;
      let fallback = false;
      try {
        result = await ripgrepSearch(pattern, ctx.projectRoot, opts);
      } catch (err: unknown) {
        // 只有明确的可执行文件缺席才切 JS fallback；语法/权限/终止错误不能换引擎伪装成功。
        if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
          throw err;
        }
        fallback = true;
        fellBack = true;
        warnings.push({
          code: 'code_search_fallback',
          message: 'ripgrep is unavailable (ENOENT); using the in-process search fallback.',
          stage: 'code.search',
          tool: 'code',
        });
        result = await fallbackRegexSearch(pattern, ctx.projectRoot, opts);
      }
      outcomes.push({ pattern, matches: result.matches, total: result.total });
      rejectedPaths += result.rejectedPaths ?? 0;
      if (result.incomplete) {
        if (result.incomplete.status === 'partial') {
          // 部分结果只属于这个 pattern：记录名字后继续，不写缓存（下次仍需重跑）。
          affected.push({ pattern, reason: result.incomplete.reason });
          continue;
        }
        halted = {
          status: result.incomplete.status,
          reason: result.incomplete.reason,
          pattern,
          skipped: patterns.slice(index + 1),
        };
        break;
      }
      if (!fallback) {
        ctx.searchCache?.set(cacheKey, { matches: result.matches, total: result.total });
      }
    } catch (err: unknown) {
      // 引擎对这个 pattern 失败（非法正则、rg 无命中即非零退出）：记录后继续后续 pattern；
      // 全局零命中时整体失败，非法 pattern 不能伪装成“没找到”。
      failures.push({ pattern, reason: err instanceof Error ? err.message : 'Search failed' });
    }
  }

  const deduped = mergeRoundRobin(outcomes, maxResults);
  const totalCount = outcomes.reduce((sum, outcome) => sum + outcome.total, 0);
  if (deduped.length === 0 && failures.length > 0 && !halted) {
    return fail(`code.search failed: ${describePatternIssues(failures)}`);
  }
  const incomplete = describeIncompleteSearch(halted, affected, failures, maxResults);

  // M2/P1a（挖掘产出升级）：结构化返回 matches——EvidenceCapture 的 per-file 分组分支
  // 读 structuredContent.matches（EvidenceCapture.ts:138-154），此前只返回格式化字符串导致
  // 分支永不触发、search 证据全部落成无 file 台账条目（run-6 误杀链的采集端根因）。
  // 模型可见文本随 adapter 约定变为 JSON（与 code.read batch 同一约定，字段本就更可解析）。
  const actionBudget = ctx.toolRegistry?.code?.actions.search?.maxOutputTokens;
  const budget = Math.min(ctx.tokenBudget, actionBudget ?? Number.POSITIVE_INFINITY);
  const data = projectSearchResults(deduped, totalCount, budget, incomplete !== undefined);
  if (!data) {
    return fail('code.search output budget is too small to represent result counts');
  }
  if (incomplete) {
    warnings.push({
      code: 'code_search_incomplete',
      message: `${incomplete.reason} total represents observed matches only.`,
      stage: 'code.search',
      tool: 'code',
    });
  }
  if (rejectedPaths > 0) {
    warnings.push({
      code: 'code_search_path_rejected',
      message: `Skipped ${rejectedPaths} fallback search candidate(s) that failed project path validation.`,
      stage: 'code.search',
      tool: 'code',
    });
  }
  if (data.truncated) {
    warnings.push({
      code: 'code_search_output_truncated',
      message: `Omitted ${data.omittedCount} complete match(es) to fit ${budget} tokens; use code.read for source content.`,
      stage: 'code.search',
      tool: 'code',
    });
  }
  const result = ok(data, {
    // Adapter 的真实展示为缩进 JSON，预算必须使用同一序列化格式。
    tokensEstimate: estimateTokens(JSON.stringify(data, null, 2)),
    durationMs: Date.now() - startMs,
    ...(incomplete || data.truncated
      ? { degraded: true, resultStatus: incomplete?.status ?? 'partial' }
      : {}),
    ...(fellBack ? { fallbackUsed: true } : {}),
    ...(warnings.length > 0 ? { diagnosticWarnings: warnings } : {}),
  });
  return incomplete && deduped.length === 0
    ? { ...result, ok: false, error: `code.search ${incomplete.status}: ${incomplete.reason}` }
    : result;
}

/**
 * 按 pattern 轮转取名额合并：每轮依次从每个 pattern 取一条未见过的命中，直到收满 maxResults。
 * 只要 maxResults 不少于有命中的 pattern 数，每个有命中的 pattern 至少出现一次；同一 file:line
 * 被多个 pattern 命中时只保留第一次出现。此前按 pattern 顺序拼接后 slice(0, maxResults)，
 * 第一个常见词就把靠后 pattern 的命中静默挤掉（I13）。
 */
function mergeRoundRobin(outcomes: PatternSearchOutcome[], maxResults: number): SearchMatch[] {
  const seen = new Set<string>();
  const merged: SearchMatch[] = [];
  const cursors = outcomes.map(() => 0);
  let progressed = true;
  while (merged.length < maxResults && progressed) {
    progressed = false;
    for (let index = 0; index < outcomes.length && merged.length < maxResults; index++) {
      const { matches } = outcomes[index];
      while (cursors[index] < matches.length) {
        const match = matches[cursors[index]++];
        const key = `${match.file}:${match.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(match);
          progressed = true;
          break;
        }
      }
    }
  }
  return merged;
}

function quotePatterns(patterns: string[]): string {
  return patterns.map((pattern) => JSON.stringify(pattern)).join(', ');
}

function describePatternIssues(issues: Array<{ pattern: string; reason: string }>): string {
  return issues.map((issue) => `${JSON.stringify(issue.pattern)} (${issue.reason})`).join('; ');
}

/**
 * 把本次搜索的不完整原因写成可定位的诊断：受影响（partial）的 pattern、失败的 pattern、
 * 中断点与被跳过的 pattern 都逐个点名——模型和证据采集端必须能分辨“没搜到”与“没搜”。
 */
function describeIncompleteSearch(
  halted: SearchHalt | undefined,
  affected: Array<{ pattern: string; reason: string }>,
  failures: Array<{ pattern: string; reason: string }>,
  maxResults: number
): { status: 'partial' | 'timeout' | 'aborted'; reason: string } | undefined {
  const parts: string[] = [];
  if (affected.length > 0) {
    parts.push(
      `Partial results (fewer than ${maxResults} matches collected) for pattern(s) ${describePatternIssues(affected)}.`
    );
  }
  if (failures.length > 0) {
    parts.push(`No results for failed pattern(s) ${describePatternIssues(failures)}.`);
  }
  if (halted) {
    parts.push(
      halted.pattern !== undefined
        ? `Search ${halted.status} while running pattern ${JSON.stringify(halted.pattern)}: ${halted.reason}`
        : `Search ${halted.status}: ${halted.reason}`
    );
    if (halted.skipped.length > 0) {
      parts.push(`Skipped pattern(s) ${quotePatterns(halted.skipped)}.`);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return { status: halted?.status ?? 'partial', reason: parts.join(' ') };
}

interface SearchProjection {
  /**
   * 已观察到的命中行数下界，不是全仓精确总数：rg 按文件 --max-count 截断且收满 maxResults 即收尾，
   * fallback 收满即停止扫描；多 pattern 时为各 pattern 下界之和（跨 pattern 命中同一行会重复计入）。
   */
  total: number;
  shown: number;
  matches: SearchMatch[];
  truncated?: true;
  omittedCount?: number;
  omittedLocations?: Array<{ file: string; line: number }>;
  guidance?: string;
  /**
   * 本次搜索有 pattern 未完整执行（输出超限、引擎失败、timeout/aborted 跳过）；具体名单见
   * code_search_incomplete 诊断。缺席的 pattern 不能被当作“没找到”。
   */
  incomplete?: true;
}

/**
 * 只投影模型可见结果，不改原 cache；证据采集会把 matches.content 当原文，所以只能整条取舍。
 * 超长命中保留真实定位供 code.read，定位也整条取舍，不能截出一个并不存在的文件路径。
 */
function projectSearchResults(
  matches: SearchMatch[],
  total: number,
  budget: number,
  incomplete: boolean
): SearchProjection | null {
  const copies = matches.map((match) => ({
    ...match,
    ...(match.context ? { context: [...match.context] } : {}),
  }));
  const complete: SearchProjection = {
    total,
    shown: copies.length,
    matches: copies,
    ...(incomplete ? { incomplete: true } : {}),
  };
  const fits = (value: SearchProjection) =>
    estimateTokens(JSON.stringify(value, null, 2)) <= budget;
  if (fits(complete)) {
    return complete;
  }
  const projected: SearchProjection = {
    total,
    shown: 0,
    matches: [],
    truncated: true,
    omittedCount: copies.length,
    ...(incomplete ? { incomplete: true } : {}),
  };
  if (!fits(projected)) {
    return null;
  }
  projected.guidance = 'Use code.read to inspect omitted matches.';
  if (!fits(projected)) {
    delete projected.guidance;
  }
  const omitted: SearchMatch[] = [];
  for (const match of copies) {
    projected.matches.push(match);
    projected.shown++;
    projected.omittedCount = copies.length - projected.shown;
    if (!fits(projected)) {
      projected.matches.pop();
      projected.shown--;
      projected.omittedCount = copies.length - projected.shown;
      omitted.push(match);
    }
  }
  for (const match of omitted) {
    const locations = projected.omittedLocations ?? [];
    projected.omittedLocations = [...locations, { file: match.file, line: match.line }];
    if (!fits(projected)) {
      if (locations.length > 0) {
        projected.omittedLocations = locations;
      } else {
        delete projected.omittedLocations;
      }
    }
  }
  return projected;
}

interface RipgrepResult {
  matches: SearchMatch[];
  /** 已观察到的命中行数下界（语义见 SearchProjection.total）。 */
  total: number;
  rejectedPaths?: number;
  /**
   * partial：这个 pattern 的输出超限（命中尚不足 maxResults）或 rg 非零退出，只影响本 pattern；
   * timeout/aborted：整次搜索被取消，调用方据此中断后续 pattern。
   */
  incomplete?: { status: 'partial' | 'timeout' | 'aborted'; reason: string };
}

interface SearchOptions {
  glob?: string;
  maxResults: number;
  contextLines: number;
  regex: boolean;
  signal?: AbortSignal;
}

/**
 * 搜索被取消时的终态归类，与 terminal 共用 isDeadlineAbort：期限（runOperation 运行/阶段期限或
 * AbortSignal.timeout）→ timeout，其余取消原因（用户/宿主停止）→ aborted。
 * 归类结果进入 halted.status，并由 code_search_incomplete 诊断点名中断点与被跳过的 pattern。
 */
function searchAbortStatus(signal: AbortSignal): 'timeout' | 'aborted' {
  return isDeadlineAbort(signal) ? 'timeout' : 'aborted';
}

/** ripgrep 排除的噪音目录 — 与 IGNORED_DIRS 对齐 */
const RG_EXCLUDE_GLOBS = [
  '!.git',
  '!node_modules',
  '!.build',
  '!dist',
  '!build',
  '!.next',
  '!__pycache__',
  '!.venv',
  '!venv',
  '!Pods',
  '!Carthage',
  '!.gradle',
  '!DerivedData',
  '!coverage',
  '!.turbo',
];

async function ripgrepSearch(
  pattern: string,
  cwd: string,
  opts: SearchOptions
): Promise<RipgrepResult> {
  const args = [
    '--json',
    '--max-count',
    String(opts.maxResults),
    ...(opts.contextLines > 0 ? ['--context', String(opts.contextLines)] : []),
    '--no-heading',
    '--color',
    'never',
  ];
  for (const excl of RG_EXCLUDE_GLOBS) {
    args.push('--glob', excl);
  }
  if (opts.glob) {
    args.push('--glob', opts.glob);
  }
  if (!opts.regex) {
    args.push('--fixed-strings');
  }
  args.push('--', pattern, './');

  return spawnRg(args, cwd, 15000, {
    pattern,
    maxResults: opts.maxResults,
    contextLines: opts.contextLines,
    signal: opts.signal,
  });
}

interface RgSpawnOptions {
  /** 只用于诊断日志，不参与 rg 参数。 */
  pattern: string;
  maxResults: number;
  contextLines: number;
  signal?: AbortSignal;
}

/**
 * 通过 spawn 调用 ripgrep，关闭 stdin 防止 rg 等待输入。
 *
 * 关键：ripgrep 检测到 stdin 可读时会从 stdin 读取（而不是搜索目录），
 * Node.js exec/execFile 默认保持 stdin 打开 → rg 永远挂起。
 * 解决方案：stdio: ['ignore', 'pipe', 'pipe'] + 显式传入 './' 搜索路径。
 * see: https://github.com/BurntSushi/ripgrep/issues/2056
 *
 * 结束方式有三类，必须分开（I13）：
 * - 请求已满足：流式解析收满 maxResults 条命中且当前文件已结束（或此后输出才超限），提前 kill rg，
 *   结果与自然结束同样完整（不设 incomplete，可缓存），total 只是观察下界；
 * - partial：命中不足 maxResults 时输出就超过缓冲上限，或 rg 非零退出——只影响这个 pattern；
 * - timeout/aborted：整次搜索被取消，调用方中断后续 pattern。
 */
function spawnRg(
  args: string[],
  cwd: string,
  timeout: number,
  opts: RgSpawnOptions
): Promise<RipgrepResult> {
  return new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      resolve({
        matches: [],
        total: 0,
        incomplete: {
          status: searchAbortStatus(signal),
          reason: 'Search cancelled before spawning ripgrep.',
        },
      });
      return;
    }
    const child = spawn('rg', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    });

    const stream = new RipgrepJsonStream(opts.maxResults, opts.contextLines);
    const decoder = new StringDecoder('utf-8');
    let totalBytes = 0;
    const MAX_BUFFER = 2 * 1024 * 1024;
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (result: RipgrepResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const terminate = (status: 'partial' | 'timeout' | 'aborted', reason: string) => {
      if (settled) {
        return;
      }
      // 先封闭回执，再停止只读 child；迟到 data/close/error 不能改变结果或启动 fallback。
      settle({ ...stream.finish(), incomplete: { status, reason } });
      child.kill('SIGKILL');
    };
    const finishSatisfied = (trigger: string) => {
      if (settled) {
        return;
      }
      Logger.getInstance().debug(
        `[code.search] ripgrep stopped early for pattern ${JSON.stringify(opts.pattern)}: ${trigger}; ${opts.maxResults} matches collected, total is an observed lower bound.`
      );
      settle(stream.finish());
      child.kill('SIGKILL');
    };
    const onAbort = () => {
      if (signal) {
        terminate(searchAbortStatus(signal), 'Search cancelled while ripgrep was running.');
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      const remaining = Math.max(0, MAX_BUFFER - totalBytes);
      totalBytes += chunk.length;
      if (stream.feed(decoder.write(chunk.subarray(0, remaining)))) {
        finishSatisfied('maxResults reached and the current file ended');
        return;
      }
      if (totalBytes > MAX_BUFFER) {
        if (stream.collected >= opts.maxResults) {
          // 命中已够，只是尾部上下文/后续文件把输出撑过上限：按请求已满足收尾，不是 partial。
          finishSatisfied(`output exceeded ${MAX_BUFFER} bytes after maxResults was reached`);
        } else {
          terminate(
            'partial',
            `ripgrep output exceeded ${MAX_BUFFER} bytes before ${opts.maxResults} matches were collected.`
          );
        }
      }
    });
    // 始终消费 stderr 避免 pipe 反压；诊断存储有界，不因错误噪声放大内存。
    child.stderr.on('data', (chunk: Buffer) => {
      if (!settled && stderr.length < 4096) {
        stderr += chunk.toString('utf-8').slice(0, 4096 - stderr.length);
      }
    });

    timer = setTimeout(
      () => terminate('timeout', `ripgrep exceeded its ${timeout}ms search deadline.`),
      timeout
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      stream.feed(decoder.end());
      const result = stream.finish();
      if (code === 0) {
        resolve(result);
      } else if (code === 1) {
        // rg exit code 1 = no matches
        resolve({ matches: [], total: 0 });
      } else {
        const reason = `ripgrep exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`;
        if (result.matches.length > 0) {
          resolve({ ...result, incomplete: { status: 'partial', reason } });
        } else {
          reject(new Error(reason));
        }
      }
    });

    child.on('error', (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

interface RgJsonEvent {
  type?: unknown;
  data?: {
    path?: { text?: unknown };
    line_number?: unknown;
    lines?: { text?: unknown };
    stats?: { matched_lines?: unknown };
  };
}

/**
 * rg --json 的流式解析器：按行累积事件，命中与上下文行同时登记。
 * 命中只保留前 maxResults 条，之后的 match 事件仍计入 total 下界并作为邻近行参与上下文；
 * 收满后遇到当前文件的 end 事件即判定“请求已满足”，调用方据此提前终止 rg（尾部上下文完整）。
 */
class RipgrepJsonStream {
  readonly #maxResults: number;
  readonly #contextLines: number;
  readonly #matches: SearchMatch[] = [];
  readonly #observedLines = new Map<string, Map<number, string>>();
  #pending = '';
  #observedMatchLines = 0;
  #summaryMatchedLines: number | undefined;

  constructor(maxResults: number, contextLines: number) {
    this.#maxResults = maxResults;
    this.#contextLines = contextLines;
  }

  /** 已登记的命中数（不超过 maxResults）。 */
  get collected(): number {
    return this.#matches.length;
  }

  /** 喂入一段文本；返回 true 表示已收满 maxResults 且当前文件已结束（请求已满足）。 */
  feed(text: string): boolean {
    if (!text) {
      return false;
    }
    const lines = (this.#pending + text).split('\n');
    this.#pending = lines.pop() ?? '';
    for (const line of lines) {
      if (this.#consume(line)) {
        // 同一块里后面的事件属于下一个文件，不再属于本次请求。
        this.#pending = '';
        return true;
      }
    }
    return false;
  }

  /** 消费一行事件；返回 true 表示请求已满足。无法解析（被截断/非 JSON）的行跳过。 */
  #consume(line: string): boolean {
    if (!line.trim()) {
      return false;
    }
    let event: RgJsonEvent;
    try {
      event = JSON.parse(line) as RgJsonEvent;
    } catch (err: unknown) {
      void err;
      return false;
    }
    if (!event || typeof event !== 'object') {
      return false;
    }
    if (event.type === 'match' || event.type === 'context') {
      const data = event.data ?? {};
      const rawPath = typeof data.path?.text === 'string' ? data.path.text : '';
      const relPath = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
      const lineNumber = typeof data.line_number === 'number' ? data.line_number : 0;
      // rg 的行终止符不属于源码行；其余空白必须保真，不能 trimEnd 改证据原文。
      const content = String(data.lines?.text ?? '').replace(/\r?\n$/, '');
      let fileLines = this.#observedLines.get(relPath);
      if (!fileLines) {
        fileLines = new Map();
        this.#observedLines.set(relPath, fileLines);
      }
      fileLines.set(lineNumber, content);
      if (event.type === 'match') {
        this.#observedMatchLines++;
        if (this.#matches.length < this.#maxResults) {
          this.#matches.push({ file: relPath, line: lineNumber, content });
        }
      }
      return false;
    }
    if (event.type === 'end') {
      return this.#matches.length >= this.#maxResults;
    }
    if (event.type === 'summary') {
      const matchedLines = event.data?.stats?.matched_lines;
      if (typeof matchedLines === 'number') {
        this.#summaryMatchedLines = matchedLines;
      }
    }
    return false;
  }

  finish(): RipgrepResult {
    if (this.#pending) {
      this.#consume(this.#pending);
      this.#pending = '';
    }
    if (this.#contextLines > 0) {
      for (const match of this.#matches) {
        const lines = this.#observedLines.get(match.file);
        match.context = Array.from(lines ?? [])
          .filter(
            ([line]) => line !== match.line && Math.abs(line - match.line) <= this.#contextLines
          )
          .sort(([left], [right]) => left - right)
          .map(([, content]) => content);
      }
    }
    // rg 的 stats.matched_lines 与 match 事件同为行粒度（都受 --max-count 逐文件截断），自然结束时
    // 以它为准；提前收尾/中断时只有已观察的 match 事件。两者都是下界，不用 stats.matches（子匹配计数）。
    const total = Math.max(this.#observedMatchLines, this.#summaryMatchedLines ?? 0);
    return { matches: this.#matches, total };
  }
}

async function fallbackRegexSearch(
  pattern: string,
  cwd: string,
  opts: SearchOptions
): Promise<RipgrepResult> {
  const matches: SearchMatch[] = [];
  let searchRe: RegExp;
  try {
    // 与 rg 默认大小写敏感行为一致；fallback 方言仍是 JavaScript RegExp，诊断明确标识。
    searchRe = opts.regex ? new RegExp(pattern, 'g') : new RegExp(escapeRegex(pattern), 'g');
  } catch (err: unknown) {
    throw new Error(
      `Invalid fallback regex: ${err instanceof Error ? err.message : 'pattern rejected'}`
    );
  }

  const files = await collectFiles(cwd, opts.glob, opts.signal);
  let total = 0;
  let rejectedPaths = 0;

  for (const file of files) {
    if (opts.signal?.aborted) {
      break;
    }
    if (matches.length >= opts.maxResults) {
      break;
    }
    let absolute: string;
    try {
      // fallback 与 code.read 使用同一实际路径约束，不能通过文件 symlink 读取仓外内容。
      absolute = resolveProjectPath(cwd, file).absolute;
    } catch (err: unknown) {
      void err;
      rejectedPaths++;
      continue;
    }
    try {
      const content = await fs.readFile(absolute, 'utf-8');
      if (opts.signal?.aborted) {
        break;
      }
      const lines = content.split(/\r?\n/);
      if (content.endsWith('\n')) {
        lines.pop();
      }
      for (let i = 0; i < lines.length; i++) {
        searchRe.lastIndex = 0;
        if (searchRe.test(lines[i])) {
          total++;
          if (matches.length < opts.maxResults) {
            matches.push({
              file,
              line: i + 1,
              content: lines[i],
              ...(opts.contextLines > 0
                ? {
                    context: lines
                      .slice(Math.max(0, i - opts.contextLines), i)
                      .concat(lines.slice(i + 1, i + 1 + opts.contextLines)),
                  }
                : {}),
            });
          }
        }
      }
    } catch {
      // 读取失败跳过
    }
  }

  return {
    matches,
    total,
    ...(rejectedPaths > 0 ? { rejectedPaths } : {}),
    ...(opts.signal?.aborted
      ? {
          incomplete: {
            status: searchAbortStatus(opts.signal),
            reason: 'Search cancelled during the in-process fallback.',
          },
        }
      : {}),
  };
}

/* ================================================================== */
/*  code.read                                                          */
/* ================================================================== */

const MAX_BATCH_READ_FILES = 5;

async function handleRead(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = normalizeOptionalString(params.path);
  const filePathsResult = normalizeFilePaths(params.filePaths);
  if (!filePathsResult.ok) {
    return fail(filePathsResult.error);
  }
  const filePaths = filePathsResult.value;

  if (filePath && filePaths.length > 0) {
    return fail('code.read accepts either path or filePaths, not both');
  }

  if (filePaths.length > 0) {
    return handleBatchRead(filePaths, params, ctx);
  }

  if (!filePath) {
    return fail('code.read requires path or filePaths[]');
  }

  const result = await readSingleFile(filePath, params, ctx);
  if (!result.ok) {
    return fail(result.error);
  }
  const outputLimit = ctx.toolRegistry?.code?.actions.read?.maxOutputTokens;
  const willTruncate = Boolean(outputLimit && result.tokensEstimate > outputLimit);
  if (willTruncate) {
    // Router 的 action 配额也是有损边界；采用它注入的单源规格，避免第二次读取只剩 unchanged。
    forgetFullRead(result.path, ctx);
  }
  return ok(result.content, {
    tokensEstimate: result.tokensEstimate,
    ...(willTruncate
      ? {
          diagnosticWarnings: [
            {
              code: 'code_read_partial_view',
              message:
                'Read output exceeds the action limit; only the file-version fingerprint is retained. Use a line range to retrieve omitted content.',
              tool: 'code',
            },
          ],
        }
      : {}),
  });
}

function forgetFullRead(filePath: string, ctx: ToolContext): void {
  const observed = ctx.deltaCache?.get(filePath);
  if (observed) {
    // 显式沿用已登记的版本指纹：降级后的条目不再保存全文（content 可能已是 ''），指纹不能重算。
    ctx.deltaCache?.set(filePath, observed.hash, observed.content);
  }
}

interface ReadSingleSuccess {
  ok: true;
  path: string;
  content: string;
  lineCount: number;
  tokensEstimate: number;
  startLine?: number;
  endLine?: number;
  mode: 'full' | 'range' | 'outline' | 'delta' | 'unchanged';
}

interface ReadSingleFailure {
  ok: false;
  path: string;
  error: string;
}

type ReadSingleResult = ReadSingleSuccess | ReadSingleFailure;

async function handleBatchRead(
  filePaths: string[],
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (filePaths.length > MAX_BATCH_READ_FILES) {
    return fail(`code.read filePaths supports at most ${MAX_BATCH_READ_FILES} files per call`);
  }

  const maxOutputTokens = Math.max(1000, Math.min(ctx.tokenBudget || 5000, 5000));
  const perFileTokenBudget = Math.max(200, Math.floor((maxOutputTokens - 250) / filePaths.length));
  const files: Array<
    | (ReadSingleSuccess & { truncated?: boolean; originalTokensEstimate?: number })
    | ReadSingleFailure
  > = [];

  for (const batchPath of filePaths) {
    if (ctx.abortSignal?.aborted) {
      files.push({ ok: false, path: batchPath, error: 'Read aborted' });
      continue;
    }
    const result = await readSingleFile(batchPath, params, ctx);
    if (!result.ok) {
      files.push(result);
      continue;
    }
    const rendered = clampReadResult(result, perFileTokenBudget);
    if (rendered.truncated && ctx.deltaCache) {
      // batch 配额隐藏了部分内容：保留版本指纹，但撤销全文已展示的断言。
      forgetFullRead(result.path, ctx);
    }
    files.push(rendered);
  }

  const succeeded = files.filter((file) => file.ok).length;
  const failed = files.length - succeeded;
  const data = {
    mode: 'batch',
    files,
    summary: {
      requested: filePaths.length,
      succeeded,
      failed,
      partialFailure: succeeded > 0 && failed > 0,
      maxFiles: MAX_BATCH_READ_FILES,
      maxOutputTokens,
      perFileTokenBudget,
    },
  };
  const tokensEstimate = estimateTokens(JSON.stringify(data));

  if (succeeded === 0) {
    return {
      ok: false,
      data,
      error: `code.read batch failed: ${failed}/${filePaths.length} files failed`,
      _meta: { cached: false, durationMs: 0, tokensEstimate },
    };
  }

  return ok(data, { tokensEstimate });
}

async function readSingleFile(
  filePath: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ReadSingleResult> {
  const startLine = params.startLine as number | undefined;
  const endLine = params.endLine as number | undefined;
  const maxLines = normalizePositiveInteger(params.maxLines);

  const resolved = resolveProjectFilePath(filePath, ctx.projectRoot);
  if (!resolved.ok) {
    return { ok: false, path: filePath, error: resolved.error };
  }

  let content: string;
  try {
    content = await fs.readFile(resolved.absPath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: resolved.relPath, error: `Cannot read file: ${msg}` };
  }

  const lines = content.split('\n');
  const lineCount = lines.length;

  const isFullRead = !startLine && !endLine && !maxLines && lineCount <= 500;
  if (ctx.deltaCache && isFullRead) {
    const delta = ctx.deltaCache.check(resolved.relPath, content);
    // 文件指纹相同不代表该区间已展示；范围补读必须返回真实源码。
    if (delta.mode === 'unchanged') {
      return {
        ok: true,
        path: resolved.relPath,
        content: delta.content,
        lineCount,
        tokensEstimate: 5,
        mode: 'unchanged',
      };
    }
    if (delta.mode === 'delta') {
      return {
        ok: true,
        path: resolved.relPath,
        content: delta.content,
        lineCount,
        tokensEstimate: estimateTokens(delta.content),
        mode: 'delta',
      };
    }
  } else {
    // 读到磁盘版本不等于把全文交给当前视图；写前门仍可使用这个版本指纹（由缓存自算，单源）。
    ctx.deltaCache?.set(resolved.relPath, undefined, content);
  }

  if (startLine || endLine || maxLines) {
    const start = Math.max(1, startLine ?? 1);
    const maxLineEnd = maxLines ? start + maxLines - 1 : lineCount;
    const end = Math.min(lineCount, endLine ?? maxLineEnd);
    const slice = lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}|${l}`)
      .join('\n');
    const suffix =
      end < lineCount && maxLines && !endLine
        ? `\n... [${lineCount - end} lines omitted; use startLine/endLine for more]`
        : '';
    const contentSlice = `${slice}${suffix}`;
    return {
      ok: true,
      path: resolved.relPath,
      content: contentSlice,
      lineCount,
      tokensEstimate: estimateTokens(contentSlice),
      startLine: start,
      endLine: end,
      mode: 'range',
    };
  }

  if (lineCount <= 500) {
    const numbered = lines.map((l, i) => `${i + 1}|${l}`).join('\n');
    return {
      ok: true,
      path: resolved.relPath,
      content: numbered,
      lineCount,
      tokensEstimate: estimateTokens(numbered),
      mode: 'full',
    };
  }

  const outline = await generateOutlineForRead(resolved.absPath, resolved.relPath, lineCount, ctx);
  return {
    ok: true,
    path: resolved.relPath,
    content: outline,
    lineCount,
    tokensEstimate: estimateTokens(outline),
    mode: 'outline',
  };
}

async function generateOutlineForRead(
  absPath: string,
  relPath: string,
  lineCount: number,
  ctx: ToolContext
): Promise<string> {
  try {
    const outline = await buildAstOutline(absPath, relPath, ctx);
    if (outline) {
      return `${outline}\n\nFile has ${lineCount} lines. Showing outline. Use startLine/endLine to read specific sections.`;
    }
  } catch {
    // AST 不可用，使用头尾预览
  }

  const content = await fs.readFile(absPath, 'utf-8');
  const lines = content.split('\n');
  const headCount = 30;
  const tailCount = 15;

  const head = lines
    .slice(0, headCount)
    .map((l, i) => `${i + 1}|${l}`)
    .join('\n');
  const tail = lines
    .slice(-tailCount)
    .map((l, i) => `${lineCount - tailCount + i + 1}|${l}`)
    .join('\n');

  return [
    `// ${relPath} — ${lineCount} lines (showing head + tail)`,
    '',
    head,
    '',
    `  ... [${lineCount - headCount - tailCount} lines omitted] ...`,
    '',
    tail,
    '',
    'Use startLine/endLine to read specific sections.',
  ].join('\n');
}

/* ================================================================== */
/*  code.outline                                                       */
/* ================================================================== */

async function handleOutline(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const filePath = params.path as string;
  if (!filePath) {
    return fail('code.outline requires path');
  }

  const resolved = resolveProjectFilePath(filePath, ctx.projectRoot);
  if (!resolved.ok) {
    return fail(resolved.error);
  }

  try {
    await fs.access(resolved.absPath);
  } catch {
    return fail(`File not found: ${filePath}`);
  }

  const outline = await buildAstOutline(resolved.absPath, resolved.relPath, ctx);
  if (outline) {
    return ok(outline, { tokensEstimate: estimateTokens(outline) });
  }

  return fail(
    `Cannot generate outline for ${filePath} — AST analyzer not available or language not supported`
  );
}

/**
 * 通过 AstAnalyzer 生成文件骨架。
 * AstAnalyzer 接口来自 lib/core/AstAnalyzer.ts。
 */
async function buildAstOutline(
  absPath: string,
  relPath: string,
  ctx: ToolContext
): Promise<string | null> {
  const analyzer = ctx.astAnalyzer as
    | {
        analyzeFile?: (filePath: string) => Promise<AstFileResult | null>;
      }
    | undefined;

  if (!analyzer?.analyzeFile) {
    return null;
  }

  try {
    const result = await analyzer.analyzeFile(absPath);
    if (!result || !result.definitions || result.definitions.length === 0) {
      return null;
    }

    const content = await fs.readFile(absPath, 'utf-8');
    const lineCount = content.split('\n').length;
    const lang = detectLanguage(relPath);

    const outlineLines = [`// ${lineCount} lines, ${lang}, Tree-sitter AST`, ''];

    for (const def of result.definitions) {
      const indent = '  '.repeat(def.depth ?? 0);
      const lineRange = def.endLine ? `[${def.startLine}-${def.endLine}]` : `[${def.startLine}]`;
      const signature = def.signature ?? def.name;
      outlineLines.push(`${indent}${signature} ${lineRange}`);
    }

    return outlineLines.join('\n');
  } catch {
    return null;
  }
}

interface AstFileResult {
  definitions: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine?: number;
    signature?: string;
    depth?: number;
  }>;
}

/* ================================================================== */
/*  code.structure                                                     */
/* ================================================================== */

async function handleStructure(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const directory = (params.directory as string) || '.';
  const depth = Math.min((params.depth as number) || 3, 5);

  try {
    const absDir = resolveProjectPath(ctx.projectRoot, directory).absolute;
    const canonicalRoot = resolveProjectPath(ctx.projectRoot, '.').absolute;
    const tree = await buildDirectoryTree(absDir, canonicalRoot, depth, 0);
    return ok(tree, { tokensEstimate: estimateTokens(tree) });
  } catch (err: unknown) {
    return fail(`Cannot list structure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.build',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'Pods',
  'Carthage',
  '.gradle',
  'DerivedData',
  '.idea',
  '.vscode',
  'coverage',
  '.turbo',
  'Packages',
  '.swiftpm',
]);

async function buildDirectoryTree(
  absDir: string,
  projectRoot: string,
  maxDepth: number,
  currentDepth: number
): Promise<string> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const relDir = path.relative(projectRoot, absDir) || '.';
  const lines: string[] = currentDepth === 0 ? [`${relDir}/`] : [];
  const indent = '  '.repeat(currentDepth + (currentDepth === 0 ? 0 : 1));

  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      continue;
    }
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        dirs.push(entry.name);
      }
    } else {
      files.push(entry.name);
    }
  }

  dirs.sort();
  files.sort();

  for (const dir of dirs) {
    lines.push(`${indent}${dir}/`);
    if (currentDepth < maxDepth - 1) {
      const subTree = await buildDirectoryTree(
        path.join(absDir, dir),
        projectRoot,
        maxDepth,
        currentDepth + 1
      );
      if (subTree) {
        lines.push(subTree);
      }
    }
  }

  for (const file of files) {
    lines.push(`${indent}${file}`);
  }

  return lines.join('\n');
}

/* ================================================================== */
/*  code.write                                                         */
/* ================================================================== */

const PROTECTED_PATHS = ['.git', 'node_modules', '.env'];

// 写前新鲜度门的指纹只由 deltaCache 计算：读、写后登记都让缓存自算（set 的 hash 传 undefined），
// 写前比较走 deltaCache.isFresh()，本 handler 不再保留第二份指纹实现。

// CG-3 硬拒 + 重读引导文案，稳定可被验收 harness grep，不得随意改写。
const REREAD_GUIDANCE =
  'Re-read the file with code.read before writing, then retry code.write with content based on the current version.';

async function handleWrite(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = params.path as string;
  const content = params.content as string;
  const createDirs = (params.createDirectories as boolean) ?? false;

  if (!filePath || content === undefined) {
    return fail('code.write requires path and content');
  }

  const resolved = resolveProjectFilePath(filePath, ctx.projectRoot);
  if (!resolved.ok) {
    return fail(resolved.error);
  }

  for (const p of PROTECTED_PATHS) {
    if (resolved.relPath === p || resolved.relPath.startsWith(`${p}/`)) {
      return fail(`Write denied: ${p} is a protected path`);
    }
  }

  // ── B-1 写前新鲜度门（read-before-write, TOCTOU）──────────────────────
  // 新文件判定 key 在"写时磁盘是否存在"，非"cache 是否有记录"：磁盘已存在但本 run 未读的
  // 文件（上一轮产物或并发 host rescan/job 写的）必须走"已存在"分支，否则被当新文件放行
  // → 重开 TOCTOU 洞。deltaCache 未注入时门降级透传，由 PROTECTED_PATHS 兜底。
  const freshness = await checkWriteFreshness(resolved.absPath, resolved.relPath, ctx);
  if (!freshness.ok) {
    return fail(freshness.error);
  }
  // ────────────────────────────────────────────────────────────────────

  try {
    if (ctx.abortSignal?.aborted) {
      return fail('code.write aborted before writing file content');
    }
    if (createDirs) {
      await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
      if (ctx.abortSignal?.aborted) {
        return fail(
          'code.write aborted before writing file content; parent directories may already exist'
        );
      }
    }
    // 最后一个可取消点已过；写入开始后以真实 IO 回执为准，不用迟到取消伪造回滚。
    if (ctx.searchCache) {
      // 失败也可能已经改过磁盘；在真正尝试写入时失效，不能等成功回执后才撤销旧命中。
      searchCacheGenerations.set(
        ctx.searchCache,
        (searchCacheGenerations.get(ctx.searchCache) ?? 0) + 1
      );
    }
    await fs.writeFile(resolved.absPath, content, 'utf-8');
  } catch (err: unknown) {
    return fail(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 磁盘写入已确认；可选缓存维护不属于提交阶段，不能覆盖 written 事实或触发重写。
  let warning: ToolDiagnosticWarning | undefined;
  let asynchronous = false;
  observeSafely(
    () => {
      const result: unknown = ctx.deltaCache?.set(resolved.relPath, undefined, content);
      if (isThenable(result)) {
        asynchronous = true;
        warning = {
          code: 'code_write_cache_refresh_unconfirmed',
          message:
            'File written; asynchronous cache refresh is unconfirmed. Use code.read before a subsequent write.',
          stage: 'code.write',
          tool: 'code',
        };
      }
      return result;
    },
    () => {
      if (asynchronous) {
        // 返回之后的拒绝只作诊断，不能再修改已发布回执；不记录缓存异常中的原始内容。
        console.warn(
          '[code.write] Optional cache refresh rejected after confirmed write; use code.read before a subsequent write.'
        );
      } else {
        warning = {
          code: 'code_write_cache_refresh_failed',
          message:
            'File written; cached fingerprint refresh failed. Use code.read before a subsequent write.',
          stage: 'code.write',
          tool: 'code',
        };
      }
    }
  );
  return ok(
    {
      written: filePath,
      bytes: Buffer.byteLength(content),
      ...(warning ? { guidance: warning.message } : {}),
    },
    warning ? { resultStatus: 'success', degraded: true, diagnosticWarnings: [warning] } : undefined
  );
}

/**
 * 写前新鲜度判定（四态，CG-3 硬拒 + CG-4 复用 deltaCache 指纹）：
 *   1. 磁盘存在 ∧ 无指纹（本 run 未读）        → 拒：must read first
 *   2. 磁盘存在 ∧ 已读 ∧ 当前磁盘指纹 ≠ 读时指纹 → 拒：changed externally
 *   3. 磁盘存在 ∧ 已读 ∧ 指纹一致              → 准
 *   4. 磁盘不存在                              → 准（新文件）
 * deltaCache 未注入：透传（不误拒合法写，安全退回 PROTECTED_PATHS）。key 用 relPath（与 :459 一致）。
 * 态 2/3 的指纹比较交给 deltaCache.isFresh()（指纹单源）；缺 isFresh 的旧式实现降级为与缓存
 * 全文的精确比对：只会误拒（缓存未保存全文时），不会误放行。
 */
async function checkWriteFreshness(
  absPath: string,
  relPath: string,
  ctx: ToolContext
): Promise<{ ok: true } | { ok: false; error: string }> {
  // 态 4：以磁盘存在性为准 —— 堵 TOCTOU 洞的关键。
  let diskContent: string;
  try {
    diskContent = await fs.readFile(absPath, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { ok: true };
    }
    // 不可读的文件仍可能可写；不能把权限/IO 失败当成“新文件”绕过先读后写。
    return {
      ok: false,
      error: `code.write rejected: cannot verify the current version of ${relPath}: ${err instanceof Error ? err.message : 'file read failed'}`,
    };
  }

  if (!ctx.deltaCache) {
    return { ok: true }; // 门不可用：透传，避免误拒合法写。
  }

  const cached = ctx.deltaCache.get(relPath);
  if (!cached) {
    // 态 1：磁盘已存在但本 run 未读 → 硬拒，要求先读。
    return {
      ok: false,
      error: `code.write rejected: ${relPath} exists on disk but was not read in this run. ${REREAD_GUIDANCE}`,
    };
  }

  const fresh = ctx.deltaCache.isFresh
    ? ctx.deltaCache.isFresh(relPath, diskContent)
    : legacyContentFreshness(relPath, cached.content, diskContent);
  if (!fresh) {
    // 态 2 / CG-3：硬拒 + 重读引导，不静默覆盖、不仅记日志。
    return {
      ok: false,
      error: `code.write rejected: ${relPath} changed externally since last read. ${REREAD_GUIDANCE}`,
    };
  }
  return { ok: true }; // 态 3：一致 → 准。
}

/**
 * 降级路径：宿主注入的 DeltaCacheLike 没有 isFresh 时，本 handler 不再自带指纹算法，
 * 改为与缓存登记的全文精确比对。日志只记录路径、选择路径与比对结果，不记录文件内容。
 */
function legacyContentFreshness(
  relPath: string,
  cachedContent: string,
  diskContent: string
): boolean {
  const fresh = cachedContent === diskContent;
  const message =
    `[code.write] path=${relPath}; freshness=content-compare; ` +
    `reason=delta_cache_without_isFresh; result=${fresh ? 'fresh' : 'stale'}; ` +
    `cachedChars=${cachedContent.length}; diskChars=${diskContent.length}`;
  observeSafely(
    () => Logger.getInstance().warn(message),
    () => undefined
  );
  return fresh;
}

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const MAP: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TSX',
    '.js': 'JavaScript',
    '.jsx': 'JSX',
    '.py': 'Python',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.go': 'Go',
    '.rs': 'Rust',
    '.swift': 'Swift',
    '.m': 'Objective-C',
    '.dart': 'Dart',
    '.rb': 'Ruby',
    '.c': 'C',
    '.cpp': 'C++',
    '.cs': 'C#',
  };
  return MAP[ext] ?? ext.slice(1) ?? 'Unknown';
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeFilePaths(
  value: unknown
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: 'code.read filePaths must be an array of strings' };
  }
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { ok: false, error: 'code.read filePaths must contain only non-empty strings' };
    }
    paths.push(item.trim());
  }
  if (paths.length === 0) {
    return { ok: false, error: 'code.read filePaths must contain at least one path' };
  }
  return { ok: true, value: paths };
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

function resolveProjectFilePath(
  filePath: string,
  projectRoot: string
): { ok: true; absPath: string; relPath: string } | { ok: false; error: string } {
  try {
    const resolved = resolveProjectPath(projectRoot, filePath, true);
    return {
      ok: true,
      absPath: resolved.absolute,
      relPath: resolved.relative || path.basename(resolved.absolute),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Cannot resolve project path' };
  }
}

/** batch 单文件截断的头尾比例沿用原实现：头部 80%、尾部 15%，截断说明从剩余预算里扣。 */
const BATCH_CLAMP_HEAD_RATIO = 0.8;
const BATCH_CLAMP_TAIL_RATIO = 0.15;
/** shared 口径下每个字符至少 0.25 token：预算 B 内最多容纳 4B 个字符，用来收窄二分上界。 */
const BATCH_CLAMP_MAX_CHARS_PER_TOKEN = 4;

/**
 * batch 单文件截断说明的固定格式。EvidenceCollector 的 READ_CLAMP_MARKER_RE 用 `\d+` 识别它，
 * 省略数必须是非负整数（按 Unicode 字符计），格式变更必须同步采集端。
 */
function batchReadClampNotice(omittedChars: number): string {
  return `\n\n... [${omittedChars} chars truncated for batch read budget] ...\n\n`;
}

/**
 * 按 shared token 口径（kernel estimateTokens 委托 shared/tokenUtils）把单文件展示内容裁到
 * 单文件预算以内，与 Router 的 maxOutputTokens 截断同一把尺子。
 *
 * - 是否截断按展示内容本身的估算判断：除 unchanged 占位外 tokensEstimate 就是该估算，
 *   以内容为准才能保证下面的不重叠推导成立；
 * - 头尾按 Array.from 的 Unicode 字符切分，边界不会落在 UTF-16 代理对中间；
 * - 截断说明计入预算：头、说明、尾各自的估算之和不超过 tokenBudget（向上取整满足次可加性）；
 * - 头尾预算之和不超过 tokenBudget，而全文估算超过它，所以头尾不会重叠，省略数至少为 1。
 *   旧实现按 4 码元/token 切头尾，CJK 文件在 2B~3.8B 字符区间会重叠并写出负省略数。
 */
function clampReadResult(
  result: ReadSingleSuccess,
  tokenBudget: number
): ReadSingleSuccess & { truncated?: boolean; originalTokensEstimate?: number } {
  const contentTokens = estimateTokens(result.content);
  if (contentTokens <= tokenBudget) {
    return result;
  }
  const chars = Array.from(result.content);
  // 说明里的省略数以全文字符数作上界预留：实际省略数位数只会更少，预留的 token 一定够用。
  const noticeTokens = estimateTokens(batchReadClampNotice(chars.length));
  const contentBudget = Math.max(0, tokenBudget - noticeTokens);
  const headBudget = Math.min(Math.floor(tokenBudget * BATCH_CLAMP_HEAD_RATIO), contentBudget);
  const tailBudget = Math.min(
    Math.floor(tokenBudget * BATCH_CLAMP_TAIL_RATIO),
    contentBudget - headBudget
  );
  const headCount = countClampCharsWithinBudget(chars, headBudget, 'head');
  const tailCount = countClampCharsWithinBudget(chars, tailBudget, 'tail');
  const omittedChars = chars.length - headCount - tailCount;
  const head = chars.slice(0, headCount).join('');
  const tail = chars.slice(chars.length - tailCount).join('');
  const content = `${head}${batchReadClampNotice(omittedChars)}${tail}`;
  const tokensEstimate = estimateTokens(content);
  reportBatchReadClamp(tokensEstimate > tokenBudget ? 'warn' : 'debug', {
    path: result.path,
    tokenBudget,
    originalTokens: contentTokens,
    finalTokens: tokensEstimate,
    headCount,
    tailCount,
    omittedChars,
  });
  return {
    ...result,
    content,
    tokensEstimate,
    truncated: true,
    originalTokensEstimate: result.tokensEstimate,
  };
}

/** 二分求 budget 内能保留的最多字符数；estimateTokens 随字符数单调不减，二分结果即最大值。 */
function countClampCharsWithinBudget(
  chars: readonly string[],
  budget: number,
  side: 'head' | 'tail'
): number {
  let low = 0;
  let high = Math.min(chars.length, budget * BATCH_CLAMP_MAX_CHARS_PER_TOKEN);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = side === 'head' ? chars.slice(0, mid) : chars.slice(chars.length - mid);
    if (estimateTokens(slice.join('')) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * batch 单文件截断诊断：只记录项目相对路径与计数，不写入文件原文。常规截断记 debug；
 * 说明本身超过单文件预算（只可能出现在极小预算上，当前单文件预算下限 200）属于降级，记 warn，
 * 此时结果只含说明、仍超过预算。经 observeSafely 隔离日志异常，诊断失败不影响读取结果。
 */
function reportBatchReadClamp(
  level: 'debug' | 'warn',
  facts: {
    path: string;
    tokenBudget: number;
    originalTokens: number;
    finalTokens: number;
    headCount: number;
    tailCount: number;
    omittedChars: number;
  }
): void {
  const reason = level === 'warn' ? 'notice_exceeds_budget' : 'per_file_budget';
  const message =
    `[code.read] path=${facts.path}; batch_clamp reason=${reason} ` +
    `perFileTokenBudget=${facts.tokenBudget} originalTokens=${facts.originalTokens} ` +
    `finalTokens=${facts.finalTokens} keptHeadChars=${facts.headCount} ` +
    `keptTailChars=${facts.tailCount} omittedChars=${facts.omittedChars}`;
  observeSafely(
    () =>
      level === 'warn' ? Logger.getInstance().warn(message) : Logger.getInstance().debug(message),
    () => undefined
  );
}

async function collectFiles(cwd: string, glob?: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const extensions = glob
    ? glob
        .replace(/\*/g, '')
        .split(',')
        .map((e) => e.trim())
    : null;

  async function walk(dir: string, relDir: string): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) {
        return;
      }
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(relPath);
        if (files.length >= 5000) {
          return;
        }
      }
    }
  }

  await walk(cwd, '');
  return files;
}
