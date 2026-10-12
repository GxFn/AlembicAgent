/**
 * @module tools/runtime/handlers/code
 *
 * 代码智能工具 — Agent 与项目源码交互的统一入口。
 * Actions: search, read, outline, structure, write
 *
 * 引擎: ripgrep (搜索), Tree-sitter via AstAnalyzer (骨架), fs (读写)
 */

import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
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
import { currentSearchCacheGeneration, invalidateSearchCache } from './searchCacheGeneration.js';

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

// 缓存实例由宿主按读取视图复用；失效代数与推进逻辑在 ./searchCacheGeneration.ts，code.write 与
// terminal.exec 共用（L4-P15 / I05）。generation 只进入本工具的缓存 key；旧条目的容量仍由宿主管理。

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
  // I14：fallback 文件清单在本次调用的所有 pattern 间共享（只遍历一次，上限与忽略规则一致）；
  // 读失败的文件按路径去重，循环结束后统一写入诊断。
  let fallbackScan: Promise<FallbackScan> | undefined;
  let scanned: FallbackScan | undefined;
  const unreadableFiles = new Set<string>();
  let rejectedPaths = 0;
  // I13：输出超限 / rg 非零退出只影响单个 pattern（affected），引擎异常且无命中记为 failures；
  // 两者都继续执行后续 pattern。只有 timeout/aborted（halted）才中断循环，并记下未执行的 pattern。
  const affected: Array<{ pattern: string; reason: string }> = [];
  const failures: Array<{ pattern: string; reason: string }> = [];
  let halted: SearchHalt | undefined;
  const warnings: ToolDiagnosticWarning[] = [];
  // L4-P15 / I05：直接由 SearchCache 提供结果的 pattern 数。全部命中才把整次调用标成 cached，
  // 部分命中只附 code_search_cache_hit 诊断——宿主据 _meta.cached 填 envelope.cache.hit，
  // runtimeBridge 据此区分 cacheHit / cacheMiss，不能把一次真实搜索算成命中。
  let cacheHits = 0;

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

    // 每个 pattern 查缓存时读取当时的代数：调用进行中有写盘失效时，后续 pattern 不再命中旧条目。
    const cacheKey = JSON.stringify([
      ctx.projectRoot,
      currentSearchCacheGeneration(ctx.searchCache),
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
      cacheHits++;
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
        if (!fallbackScan) {
          // 首个回退的 pattern 才遍历文件并报告 fallback；后续 pattern 复用同一清单，不重复诊断。
          warnings.push({
            code: 'code_search_fallback',
            message: FALLBACK_NOTICE,
            stage: 'code.search',
            tool: 'code',
          });
          fallbackScan = scanFallbackFiles(ctx.projectRoot, glob, ctx.abortSignal);
        }
        // 根目录不可读时这里抛错，由外层 catch 记为该 pattern 失败。
        scanned = await fallbackScan;
        result = await fallbackRegexSearch(
          pattern,
          ctx.projectRoot,
          opts,
          scanned,
          unreadableFiles
        );
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

  if (scanned) {
    pushFallbackScanWarnings(warnings, scanned, unreadableFiles, glob);
  }
  const allCached = reportSearchCacheHits(
    cacheHits,
    patterns.length,
    // 诊断里的代数便于对照 code.write / terminal.exec 的 search cache invalidated 日志。
    currentSearchCacheGeneration(ctx.searchCache),
    warnings
  );
  const deduped = mergeRoundRobin(outcomes, maxResults);
  const totalCount = outcomes.reduce((sum, outcome) => sum + outcome.total, 0);
  if (deduped.length === 0 && failures.length > 0 && !halted) {
    const failed = fail(`code.search failed: ${describePatternIssues(failures)}`);
    if (!fellBack && warnings.length === 0) {
      return failed;
    }
    // 失败也要带上 fallback 诊断（例如 glob 超出 fallback 能力），宿主才能分辨是哪条路径拒绝的。
    return {
      ...failed,
      _meta: {
        cached: false,
        tokensEstimate: 0,
        durationMs: Date.now() - startMs,
        ...(fellBack ? { fallbackUsed: true } : {}),
        ...(warnings.length > 0 ? { diagnosticWarnings: warnings } : {}),
      },
    };
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
    // 全部 pattern 都由缓存提供才算整次命中；部分命中已在 warnings 里带 code_search_cache_hit。
    ...(allCached ? { cached: true } : {}),
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
 * 搜索缓存命中的可观测输出（L4-P15 / I05）。返回是否整次命中（全部 pattern 都由缓存提供）。
 * - 全部命中：由调用方设 _meta.cached=true，这里只记 debug；
 * - 部分命中：追加 code_search_cache_hit 诊断（命中数/总数与代数），整次调用仍按未命中报告；
 * - 无命中：不输出任何东西。
 * 诊断只含计数与代数，不回显 pattern（pattern 已在请求参数里，宿主可自行对照）。
 */
function reportSearchCacheHits(
  hits: number,
  total: number,
  generation: number,
  warnings: ToolDiagnosticWarning[]
): boolean {
  if (hits === 0) {
    return false;
  }
  const allCached = hits === total;
  const summary = `Served ${hits} of ${total} pattern(s) from the search cache (generation ${generation})`;
  observeSafely(
    () =>
      Logger.getInstance().debug(
        `[code.search] cache hit; hits=${hits}; patterns=${total}; generation=${generation}; path=${allCached ? 'whole-hit' : 'partial-hit'}`
      ),
    () => undefined
  );
  if (!allCached) {
    warnings.push({
      code: 'code_search_cache_hit',
      message: `${summary}; the remaining pattern(s) ran a fresh search, so the call is not reported as cached.`,
      stage: 'code.search',
      tool: 'code',
    });
  }
  return allCached;
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

/**
 * code.search 的单一忽略集，rg 与 in-process fallback 共用：按名字在任意层级排除的噪音目录。
 * rg 侧由它生成 `--glob !<name>`；fallback 把同一串 --glob 当作 override 规则求值（见
 * buildFallbackOverrides），两个引擎不再各维护一份名单（I14：旧 fallback 用的 IGNORED_DIRS 多出
 * Packages/.idea/.vscode 等，与 rg 不一致）。
 * 隐藏项（名字以 . 开头）不靠这里排除：rg 默认跳过隐藏项，fallback 复刻同一条内建规则。
 * 刻意不含 Packages：本地 Swift Package（Packages/<Name>/Sources/...）是真实源码，rg 一直搜索它；
 * code.structure 的展示名单 STRUCTURE_IGNORED_DIRS 另行隐藏它。
 */
const SEARCH_IGNORED_NAMES = [
  '.git',
  'node_modules',
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
  'coverage',
  '.turbo',
] as const;

/** ripgrep 的排除参数：由 SEARCH_IGNORED_NAMES 生成，顺序与内容和旧的手写列表完全一致。 */
const RG_EXCLUDE_GLOBS: readonly string[] = SEARCH_IGNORED_NAMES.map((name) => `!${name}`);

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

/**
 * 在共享的 fallback 文件清单上执行一个 pattern。完整性与 rg 对齐：
 * - 收满 maxResults 即请求已满足（与 rg 提前收尾同义），清单之外的文件本就不会再读，不标 partial；
 * - 没收满时，清单被全局上限截断、有子目录读不了或本 pattern 有文件读失败，都意味着有内容没搜，
 *   标 partial（rg 在同样情况下非零退出，spawnRg 也按 partial/失败处理），不能当作完整的“没找到”；
 * - glob 超出 fallback 能力时直接抛错，由调用方记为失败，而不是报告 0 命中。
 */
async function fallbackRegexSearch(
  pattern: string,
  cwd: string,
  opts: SearchOptions,
  scan: FallbackScan,
  unreadableFiles: Set<string>
): Promise<RipgrepResult> {
  if (scan.globUnsupported !== undefined) {
    throw new Error(
      `In-process fallback cannot evaluate glob ${JSON.stringify(opts.glob)}: ${scan.globUnsupported}`
    );
  }
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

  let total = 0;
  let rejectedPaths = 0;
  let unreadable = 0;

  for (const file of scan.files) {
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
    } catch (err: unknown) {
      if (hasErrorCode(err, 'EISDIR')) {
        // 指向目录的符号链接：rg 默认不跟随目录链接，这里同样不展开，不算读失败。
        const message = `[code.search] fallback skipped symlinked directory ${JSON.stringify(file)} (not followed, as with ripgrep).`;
        observeSafely(
          () => Logger.getInstance().debug(message),
          () => undefined
        );
        continue;
      }
      // 读失败计数：没收满时本 pattern 标 partial，路径在循环后统一点名（同一文件跨 pattern 去重）。
      unreadable++;
      unreadableFiles.add(file);
    }
  }

  return {
    matches,
    total,
    ...(rejectedPaths > 0 ? { rejectedPaths } : {}),
    ...fallbackIncomplete(opts, matches.length, scan, unreadable),
  };
}

/** fallback 单个 pattern 的完整性判定（规则见 fallbackRegexSearch 注释）。 */
function fallbackIncomplete(
  opts: SearchOptions,
  collected: number,
  scan: FallbackScan,
  unreadableFiles: number
): Pick<RipgrepResult, 'incomplete'> {
  if (opts.signal?.aborted) {
    return {
      incomplete: {
        status: searchAbortStatus(opts.signal),
        reason: 'Search cancelled during the in-process fallback.',
      },
    };
  }
  if (collected >= opts.maxResults) {
    return {};
  }
  const gaps: string[] = [];
  if (scan.capped) {
    gaps.push(
      `fallback file cap: listing stopped at ${FALLBACK_FILE_CAP} candidate files, so later files were not searched`
    );
  }
  if (scan.unreadableDirs.length > 0 || unreadableFiles > 0) {
    gaps.push(
      `fallback could not read ${plural(scan.unreadableDirs.length, 'directory', 'directories')} and ${plural(unreadableFiles, 'file', 'files')}`
    );
  }
  return gaps.length > 0 ? { incomplete: { status: 'partial', reason: gaps.join('; ') } } : {};
}

/* ================================================================== */
/*  code.read                                                          */
/* ================================================================== */

const MAX_BATCH_READ_FILES = 5;

/** 不带区间时整读的行数上限；超过时返回 AST 大纲（可用时）或头尾预览。 */
const FULL_READ_MAX_LINES = 500;

/** 头尾预览保留的头部/尾部行数（预览模板被 EvidenceCollector 按固定文案识别，格式变更需同步）。 */
const HEAD_TAIL_PREVIEW_HEAD = 30;
const HEAD_TAIL_PREVIEW_TAIL = 15;

/**
 * batch 中因取消而未读取的文件的固定错误文案；状态归类与诊断都按它识别。
 * 期限到达与宿主/用户取消共用同一文案（data 形状与取值不变），两者只在 resultStatus、
 * code_read_batch_partial 诊断与汇总日志里区分（见 cancellationStatus）。
 */
const BATCH_READ_ABORTED = 'Read aborted';

/** 取消归类：期限 → timeout，其余取消原因（宿主/用户停止）→ aborted。 */
type CancellationStatus = 'timeout' | 'aborted';

/**
 * code.read batch 与 code.structure 的取消归类，与 code.search（searchAbortStatus）和 terminal 同一
 * 口径（L1-P2 / isDeadlineAbort）：runOperation 运行/阶段期限或 AbortSignal.timeout 触发的取消
 * 回执 timeout，宿主或用户主动取消回执 aborted。只在 signal 已中止后调用。
 */
function cancellationStatus(signal: AbortSignal | undefined): CancellationStatus {
  return isDeadlineAbort(signal) ? 'timeout' : 'aborted';
}

/** 诊断里最多点名的文件数；其余只计数，避免诊断随批量规模膨胀。 */
const READ_DIAGNOSTIC_PATH_SAMPLE = 5;

/**
 * 按源码行切分（I18）：只以 LF 为行界，内容以换行结尾时去掉 split 产生的末尾空串。
 *
 * - 恰好 500 行且以换行结尾的文件计为 500 行（旧实现 split('\n') 计成 501 行，被降级为头尾预览，
 *   整读还会多出一个空的 `501|` 行）；
 * - CRLF 文件只去掉“结尾换行产生的空行”，每行保留 CR 字节：Core EvidenceLedger 约定 code.read
 *   行段“以 LF 分行、保留 CR 字节”（StrictFactExecution.selectFrozenEvidenceBytes），Agent 的
 *   EvidenceLedgerStore.checkFreshness 也按 split('\n') 重切原文；展示内容一旦去掉 CR，带 range
 *   的证据就会与冻结字节和新鲜度切片不一致。
 * - deltaCache 与写前新鲜度指纹仍对原始 content 计算，不经过本函数。
 */
function splitSourceLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 1 && content.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

/** 经校验的行区间参数；undefined 表示调用方未给出该参数。 */
interface ReadRange {
  startLine?: number;
  endLine?: number;
  maxLines?: number;
}

/**
 * 显式 startLine/endLine 必须是正整数（I19）。schema 只声明 type:'number'，Ajv 放行负数与小数：
 * endLine:-1 曾经变成 slice(start-1, -1) 的反向切片，startLine:1.5 会产生 `1.5|` 这种不存在的行号。
 * startLine > endLine 明确报错，不再静默返回空串；maxLines 沿用原有的宽松归一化。
 */
function normalizeReadRange(
  params: Record<string, unknown>
): { ok: true; value: ReadRange } | { ok: false; error: string } {
  const range: ReadRange = {};
  for (const name of ['startLine', 'endLine'] as const) {
    const value = params[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      const shown = typeof value === 'number' ? String(value) : typeof value;
      return {
        ok: false,
        error: `code.read ${name} must be a positive integer (1-based line number); got ${shown}`,
      };
    }
    range[name] = value;
  }
  if (
    range.startLine !== undefined &&
    range.endLine !== undefined &&
    range.startLine > range.endLine
  ) {
    return {
      ok: false,
      error: `code.read startLine (${range.startLine}) must not exceed endLine (${range.endLine})`,
    };
  }
  const maxLines = normalizePositiveInteger(params.maxLines);
  if (maxLines !== undefined) {
    range.maxLines = maxLines;
  }
  return { ok: true, value: range };
}

function hasReadRange(range: ReadRange): boolean {
  return (
    range.startLine !== undefined || range.endLine !== undefined || range.maxLines !== undefined
  );
}

/**
 * >500 行文件 AST 大纲不可用的原因（I17）：
 * - analyzer-missing：宿主没有注入 astAnalyzer（当前生产宿主的主路径）；
 * - no-definitions：analyzer 返回空结果（语言不支持或文件没有可列出的声明）；
 * - analyzer-error：analyzer 抛错，错误类名与消息进入诊断与日志，不再被吞成“不可用”。
 */
type OutlineFallbackReason = 'analyzer-missing' | 'no-definitions' | 'analyzer-error';

const OUTLINE_FALLBACK_DESCRIPTIONS: Readonly<Record<OutlineFallbackReason, string>> = {
  'analyzer-missing': 'no AST analyzer is bound',
  'no-definitions':
    'the AST analyzer returned no definitions (unsupported language or no declarations)',
  'analyzer-error': 'the AST analyzer threw',
};

/** 一次头尾预览降级的事实，只进诊断与日志，不进模型可见的 data。 */
interface OutlineFallbackRecord {
  path: string;
  lineCount: number;
  reason: OutlineFallbackReason;
  errorName?: string;
}

/** 单次 code.read 调用（单读或 batch）收集的诊断事实，由调用方转成 diagnosticWarnings。 */
interface ReadDiagnosticsSink {
  outlineFallbacks: OutlineFallbackRecord[];
}

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

  if (!filePath && filePaths.length === 0) {
    return fail('code.read requires path or filePaths[]');
  }

  // 区间在分派前只校验一次：batch 里所有文件共用同一区间，非法区间不应变成逐文件的重复失败。
  const rangeResult = normalizeReadRange(params);
  if (!rangeResult.ok) {
    return fail(rangeResult.error);
  }
  const range = rangeResult.value;

  // 走到这里时 path 与 filePaths 恰有一个：没有 path 就一定是 batch。
  if (!filePath) {
    return handleBatchRead(filePaths, range, ctx);
  }

  const sink: ReadDiagnosticsSink = { outlineFallbacks: [] };
  const result = await readSingleFile(filePath, range, ctx, sink);
  if (!result.ok) {
    return fail(result.error);
  }
  const outputLimit = ctx.toolRegistry?.code?.actions.read?.maxOutputTokens;
  const willTruncate = Boolean(outputLimit && result.tokensEstimate > outputLimit);
  if (willTruncate) {
    // Router 的 action 配额也是有损边界；采用它注入的单源规格，避免第二次读取只剩 unchanged。
    forgetFullRead(result.path, ctx);
  }
  const warnings: ToolDiagnosticWarning[] = [];
  if (willTruncate) {
    warnings.push({
      code: 'code_read_partial_view',
      message:
        'Read output exceeds the action limit; only the file-version fingerprint is retained. Use a line range to retrieve omitted content.',
      tool: 'code',
    });
  }
  pushOutlineFallbackWarning(warnings, sink.outlineFallbacks);
  pushRangeBeyondEofWarning(warnings, [result]);
  // 头尾预览是有意的降级视图：标 degraded/fallbackUsed 让 trace 与诊断汇总看得见，
  // 但不把单读改成 partial（预览已明确说明只展示头尾），resultStatus 仍由 router 截断决定。
  const outlineFallback = sink.outlineFallbacks.length > 0;
  return ok(result.content, {
    // L4-P15 / I05：只有 unchanged（内容来自 DeltaCache 的已展示版本）算缓存命中；delta 模式重新读盘
    // 并比对了内容，不算命中。
    ...(result.mode === 'unchanged' ? { cached: true } : {}),
    tokensEstimate: result.tokensEstimate,
    ...(outlineFallback ? { degraded: true, fallbackUsed: true } : {}),
    ...(warnings.length > 0 ? { diagnosticWarnings: warnings } : {}),
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
  /**
   * mode==='outline' 时骨架的真实来源（I17 决策：保持 mode 取值不变，另加字段区分）：
   * 'ast' 是 Tree-sitter 大纲，'head-tail' 是 analyzer 不可用时的头尾预览。
   */
  outlineSource?: 'ast' | 'head-tail';
  /** outlineSource==='head-tail' 时 AST 大纲不可用的原因。 */
  outlineReason?: OutlineFallbackReason;
}

interface ReadSingleFailure {
  ok: false;
  path: string;
  error: string;
}

type ReadSingleResult = ReadSingleSuccess | ReadSingleFailure;

type BatchReadFile =
  | (ReadSingleSuccess & { truncated?: boolean; originalTokensEstimate?: number })
  | ReadSingleFailure;

async function handleBatchRead(
  filePaths: string[],
  range: ReadRange,
  ctx: ToolContext
): Promise<ToolResult> {
  if (filePaths.length > MAX_BATCH_READ_FILES) {
    return fail(`code.read filePaths supports at most ${MAX_BATCH_READ_FILES} files per call`);
  }

  const maxOutputTokens = Math.max(1000, Math.min(ctx.tokenBudget || 5000, 5000));
  const perFileTokenBudget = Math.max(200, Math.floor((maxOutputTokens - 250) / filePaths.length));
  const files: BatchReadFile[] = [];
  const sink: ReadDiagnosticsSink = { outlineFallbacks: [] };
  // 第一次观察到取消时按原因归类一次（signal 的 reason 中止后不再变化）。
  let cancelled: CancellationStatus | undefined;

  for (const batchPath of filePaths) {
    if (ctx.abortSignal?.aborted) {
      // 取消后不再发起新的读取：剩余文件逐个写成 Read aborted，结束后按取消原因统一归类为
      // timeout（期限）或 aborted（宿主/用户取消）并点名。
      cancelled ??= cancellationStatus(ctx.abortSignal);
      files.push({ ok: false, path: batchPath, error: BATCH_READ_ABORTED });
      continue;
    }
    const result = await readSingleFile(batchPath, range, ctx, sink);
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
  const completeness = describeBatchCompleteness(files, sink, perFileTokenBudget, cancelled);

  if (succeeded === 0) {
    // 全部失败仍是 ok:false；若是取消造成的，显式声明 timeout/aborted 并带上点名诊断。
    const cancelledStatus = completeness.cancelled > 0 ? completeness.resultStatus : undefined;
    reportBatchReadStatus(cancelledStatus ?? 'error', completeness.counts);
    return {
      ok: false,
      data,
      error: `code.read batch failed: ${failed}/${filePaths.length} files failed`,
      _meta: {
        cached: false,
        durationMs: 0,
        tokensEstimate,
        ...(cancelledStatus
          ? { resultStatus: cancelledStatus, diagnosticWarnings: completeness.warnings }
          : {}),
      },
    };
  }

  // 与 code.search 的“全部 pattern 命中”同一口径：每个请求的文件都返回 unchanged 才算整次命中；
  // 任何失败、full、range、delta 都意味着本次真的读取并交付了新内容。
  const allUnchanged = files.every((file) => file.ok && file.mode === 'unchanged');
  // I17：部分失败、取消、截断不再报成完整成功；ok 与 data 形状保持不变（部分成功仍可用）。
  if (completeness.resultStatus) {
    reportBatchReadStatus(completeness.resultStatus, completeness.counts);
  }
  return ok(data, {
    tokensEstimate,
    ...(allUnchanged ? { cached: true } : {}),
    ...(completeness.degraded ? { degraded: true } : {}),
    ...(completeness.resultStatus ? { resultStatus: completeness.resultStatus } : {}),
    ...(sink.outlineFallbacks.length > 0 ? { fallbackUsed: true } : {}),
    ...(completeness.warnings.length > 0 ? { diagnosticWarnings: completeness.warnings } : {}),
  });
}

/**
 * batch 结果的完整性归类（I17）：
 * - 任一文件因取消写成 Read aborted → 按取消原因归类：期限 → timeout，宿主/用户取消 → aborted；
 * - 否则有失败文件或被单文件预算截断的文件 → partial；
 * - 头尾预览只标 degraded/fallbackUsed，不改变状态（与单读一致）。
 * 诊断只含项目相对路径与计数，不含文件原文或宿主绝对路径（逐文件错误仍在 data 里）。
 */
function describeBatchCompleteness(
  files: readonly BatchReadFile[],
  sink: ReadDiagnosticsSink,
  perFileTokenBudget: number,
  observedCancel: CancellationStatus | undefined
): {
  resultStatus?: 'partial' | CancellationStatus;
  degraded: boolean;
  cancelled: number;
  warnings: ToolDiagnosticWarning[];
  counts: BatchReadCounts;
} {
  // Read aborted 只由取消分支写入，observedCancel 此时必然已归类；缺席时按宿主取消兜底。
  const cancelStatus: CancellationStatus = observedCancel ?? 'aborted';
  const abortedPaths: string[] = [];
  const failedPaths: string[] = [];
  const truncatedPaths: string[] = [];
  for (const file of files) {
    if (!file.ok) {
      (file.error === BATCH_READ_ABORTED ? abortedPaths : failedPaths).push(file.path);
    } else if (file.truncated) {
      truncatedPaths.push(file.path);
    }
  }
  const warnings: ToolDiagnosticWarning[] = [];
  const succeeded = files.length - abortedPaths.length - failedPaths.length;
  if (abortedPaths.length > 0 || failedPaths.length > 0) {
    const parts = [`code.read batch returned ${succeeded}/${files.length} files.`];
    if (failedPaths.length > 0) {
      parts.push(`Failed (see files[].error): ${samplePaths(failedPaths)}.`);
    }
    if (abortedPaths.length > 0) {
      const cause =
        cancelStatus === 'timeout' ? 'Deadline reached before reading' : 'Cancelled before reading';
      parts.push(
        `${cause} ${abortedPaths.length} file(s): ${samplePaths(abortedPaths)}; they were not read, not found missing.`
      );
    }
    warnings.push({
      code: 'code_read_batch_partial',
      message: parts.join(' '),
      stage: 'code.read',
      tool: 'code',
    });
  }
  if (truncatedPaths.length > 0) {
    warnings.push({
      code: 'code_read_partial_view',
      message: `Batch per-file budget (${perFileTokenBudget} tokens) truncated ${truncatedPaths.length} file(s): ${samplePaths(truncatedPaths)}. Use startLine/endLine to retrieve omitted content.`,
      stage: 'code.read',
      tool: 'code',
    });
  }
  pushOutlineFallbackWarning(warnings, sink.outlineFallbacks);
  pushRangeBeyondEofWarning(warnings, files);

  const resultStatus =
    abortedPaths.length > 0
      ? cancelStatus
      : failedPaths.length > 0 || truncatedPaths.length > 0
        ? 'partial'
        : undefined;
  const degraded = resultStatus !== undefined || sink.outlineFallbacks.length > 0;
  return {
    resultStatus,
    degraded,
    cancelled: abortedPaths.length,
    warnings,
    counts: {
      requested: files.length,
      succeeded,
      failed: failedPaths.length,
      cancelled: abortedPaths.length,
      truncated: truncatedPaths.length,
      outlineFallbacks: sink.outlineFallbacks.length,
    },
  };
}

interface BatchReadCounts {
  requested: number;
  succeeded: number;
  failed: number;
  /** 因取消（期限或宿主/用户停止）而未读取的文件数；归类见汇总日志的 status。 */
  cancelled: number;
  truncated: number;
  outlineFallbacks: number;
}

/** batch 非完整结局（partial/timeout/aborted/全部失败）的汇总日志：只含状态与计数，不含路径或原文。 */
function reportBatchReadStatus(
  status: 'partial' | CancellationStatus | 'error',
  counts: BatchReadCounts
): void {
  const message =
    `[code.read] batch status=${status} requested=${counts.requested} succeeded=${counts.succeeded} ` +
    `failed=${counts.failed} cancelled=${counts.cancelled} truncated=${counts.truncated} ` +
    `outlineFallbacks=${counts.outlineFallbacks}`;
  observeSafely(
    () => Logger.getInstance().info(message),
    () => undefined
  );
}

function samplePaths(paths: readonly string[]): string {
  const sample = paths.slice(0, READ_DIAGNOSTIC_PATH_SAMPLE).join(', ');
  const more =
    paths.length > READ_DIAGNOSTIC_PATH_SAMPLE
      ? ` and ${paths.length - READ_DIAGNOSTIC_PATH_SAMPLE} more`
      : '';
  return `${sample}${more}`;
}

/** 头尾预览降级的诊断（I17）：点名文件、原因与（analyzer 抛错时的）错误类名。 */
function pushOutlineFallbackWarning(
  warnings: ToolDiagnosticWarning[],
  fallbacks: readonly OutlineFallbackRecord[]
): void {
  if (fallbacks.length === 0) {
    return;
  }
  const described = fallbacks
    .slice(0, READ_DIAGNOSTIC_PATH_SAMPLE)
    .map(
      (fallback) =>
        `${fallback.path} (${fallback.lineCount} lines, reason=${fallback.reason}: ${OUTLINE_FALLBACK_DESCRIPTIONS[fallback.reason]}${fallback.errorName ? ` ${fallback.errorName}` : ''})`
    )
    .join('; ');
  const more =
    fallbacks.length > READ_DIAGNOSTIC_PATH_SAMPLE
      ? `; and ${fallbacks.length - READ_DIAGNOSTIC_PATH_SAMPLE} more`
      : '';
  warnings.push({
    code: 'code_read_outline_fallback',
    message: `AST outline unavailable; returned a head/tail preview (first ${HEAD_TAIL_PREVIEW_HEAD} and last ${HEAD_TAIL_PREVIEW_TAIL} lines) instead: ${described}${more}. Use startLine/endLine to read specific sections.`,
    stage: 'code.read',
    tool: 'code',
  });
}

/** startLine 超过文件行数时返回空区间（I19），用警告说明“文件没有这么多行”，而不是静默空串。 */
function pushRangeBeyondEofWarning(
  warnings: ToolDiagnosticWarning[],
  files: readonly (BatchReadFile | ReadSingleResult)[]
): void {
  const beyond = files.filter(
    (file): file is ReadSingleSuccess =>
      file.ok &&
      file.mode === 'range' &&
      file.startLine !== undefined &&
      file.startLine > file.lineCount
  );
  if (beyond.length === 0) {
    return;
  }
  const described = beyond
    .slice(0, READ_DIAGNOSTIC_PATH_SAMPLE)
    .map((file) => `${file.path} (startLine ${file.startLine}, file has ${file.lineCount} lines)`)
    .join('; ');
  warnings.push({
    code: 'code_read_range_beyond_eof',
    message: `Requested startLine is past the end of file; returned an empty range: ${described}.`,
    stage: 'code.read',
    tool: 'code',
  });
}

async function readSingleFile(
  filePath: string,
  range: ReadRange,
  ctx: ToolContext,
  sink: ReadDiagnosticsSink
): Promise<ReadSingleResult> {
  const { startLine, endLine, maxLines } = range;

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

  const lines = splitSourceLines(content);
  const lineCount = lines.length;

  const ranged = hasReadRange(range);
  const isFullRead = !ranged && lineCount <= FULL_READ_MAX_LINES;
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

  if (ranged) {
    const start = startLine ?? 1;
    const maxLineEnd = maxLines ? start + maxLines - 1 : lineCount;
    const end = Math.min(lineCount, endLine ?? maxLineEnd);
    // start > lineCount 时切片为空：返回空区间，由调用方附 code_read_range_beyond_eof 警告。
    const slice = lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}|${l}`)
      .join('\n');
    const suffix =
      end < lineCount && maxLines && endLine === undefined
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

  if (lineCount <= FULL_READ_MAX_LINES) {
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

  const outline = await generateOutlineForRead(resolved.absPath, resolved.relPath, lines, ctx);
  if (outline.source === 'head-tail') {
    sink.outlineFallbacks.push({
      path: resolved.relPath,
      lineCount,
      reason: outline.reason,
      ...(outline.errorName ? { errorName: outline.errorName } : {}),
    });
  }
  return {
    ok: true,
    path: resolved.relPath,
    content: outline.content,
    lineCount,
    tokensEstimate: estimateTokens(outline.content),
    mode: 'outline',
    outlineSource: outline.source,
    ...(outline.source === 'head-tail' ? { outlineReason: outline.reason } : {}),
  };
}

type ReadOutline =
  | { source: 'ast'; content: string }
  | { source: 'head-tail'; content: string; reason: OutlineFallbackReason; errorName?: string };

/**
 * >500 行文件的展示：优先 AST 大纲；analyzer 缺席、无定义或抛错时退回头尾预览（I17）。
 * 预览直接使用 readSingleFile 已读到的行，不再二次读盘（避免与 deltaCache 登记的版本不一致）。
 * 每次退回都记日志：analyzer 抛错是需要排查的异常，记 warn 并带错误类名与消息；
 * 缺席/无定义是已知能力边界（当前生产宿主未注入 analyzer），记 debug 避免刷屏。
 */
async function generateOutlineForRead(
  absPath: string,
  relPath: string,
  lines: readonly string[],
  ctx: ToolContext
): Promise<ReadOutline> {
  const lineCount = lines.length;
  const ast = await buildAstOutline(absPath, relPath, ctx, lineCount);
  if (ast.kind === 'outline') {
    return {
      source: 'ast',
      content: `${ast.text}\n\nFile has ${lineCount} lines. Showing outline. Use startLine/endLine to read specific sections.`,
    };
  }

  const errorName = ast.kind === 'error' ? ast.errorName : undefined;
  const logLine =
    `[code.read] path=${relPath}; outline_fallback reason=${ast.reason} lineCount=${lineCount} ` +
    `selected=head-tail${ast.kind === 'error' ? ` error=${ast.errorName}: ${ast.errorMessage}` : ''}`;
  observeSafely(
    () =>
      ast.kind === 'error'
        ? Logger.getInstance().warn(logLine)
        : Logger.getInstance().debug(logLine),
    () => undefined
  );

  const head = lines
    .slice(0, HEAD_TAIL_PREVIEW_HEAD)
    .map((l, i) => `${i + 1}|${l}`)
    .join('\n');
  const tail = lines
    .slice(-HEAD_TAIL_PREVIEW_TAIL)
    .map((l, i) => `${lineCount - HEAD_TAIL_PREVIEW_TAIL + i + 1}|${l}`)
    .join('\n');

  const content = [
    `// ${relPath} — ${lineCount} lines (showing head + tail)`,
    '',
    head,
    '',
    `  ... [${lineCount - HEAD_TAIL_PREVIEW_HEAD - HEAD_TAIL_PREVIEW_TAIL} lines omitted] ...`,
    '',
    tail,
    '',
    'Use startLine/endLine to read specific sections.',
  ].join('\n');
  return {
    source: 'head-tail',
    content,
    reason: ast.reason,
    ...(errorName ? { errorName } : {}),
  };
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
  if (outline.kind === 'outline') {
    return ok(outline.text, { tokensEstimate: estimateTokens(outline.text) });
  }

  // I17：analyzer 抛错与“不可用/不支持”分开报告，抛错带错误类名与消息并记 warn，便于定位。
  if (outline.kind === 'error') {
    const message = `[code.outline] path=${resolved.relPath}; reason=${outline.reason} error=${outline.errorName}: ${outline.errorMessage}`;
    observeSafely(
      () => Logger.getInstance().warn(message),
      () => undefined
    );
    return fail(
      `Cannot generate outline for ${filePath} — AST analyzer threw ${outline.errorName}: ${outline.errorMessage}`
    );
  }
  return fail(
    outline.reason === 'analyzer-missing'
      ? `Cannot generate outline for ${filePath} — AST analyzer not available`
      : `Cannot generate outline for ${filePath} — AST analyzer returned no definitions (language not supported or no declarations)`
  );
}

/**
 * AST 大纲的三种结局（I17）：成功、能力边界内的“不可用”（未注入 analyzer / 无定义）、
 * analyzer 抛错。旧实现用裸 catch 把抛错吞成 null，与“不可用”无法区分。
 */
type AstOutlineOutcome =
  | { kind: 'outline'; text: string }
  | { kind: 'unavailable'; reason: 'analyzer-missing' | 'no-definitions' }
  | { kind: 'error'; reason: 'analyzer-error'; errorName: string; errorMessage: string };

/**
 * 通过 AstAnalyzer 生成文件骨架。
 * AstAnalyzer 接口来自 lib/core/AstAnalyzer.ts。
 * lineCount 由 code.read 传入（已按 splitSourceLines 计数）；code.outline 不传时按需读取一次。
 */
async function buildAstOutline(
  absPath: string,
  relPath: string,
  ctx: ToolContext,
  knownLineCount?: number
): Promise<AstOutlineOutcome> {
  const analyzer = ctx.astAnalyzer as
    | {
        analyzeFile?: (filePath: string) => Promise<AstFileResult | null>;
      }
    | undefined;

  if (!analyzer?.analyzeFile) {
    return { kind: 'unavailable', reason: 'analyzer-missing' };
  }

  let result: AstFileResult | null;
  try {
    result = await analyzer.analyzeFile(absPath);
  } catch (err: unknown) {
    // analyzer 抛错：保留错误类名与消息，由调用方写进诊断并记 warn，不再伪装成“不可用”。
    return {
      kind: 'error',
      reason: 'analyzer-error',
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: errorMessage(err, String(err)),
    };
  }
  if (!result || !Array.isArray(result.definitions) || result.definitions.length === 0) {
    return { kind: 'unavailable', reason: 'no-definitions' };
  }

  let lineCount = knownLineCount;
  if (lineCount === undefined) {
    try {
      lineCount = splitSourceLines(await fs.readFile(absPath, 'utf-8')).length;
    } catch (err: unknown) {
      // 计行读盘失败不是 analyzer 的错：大纲已生成，只是头部行数未知；记 debug 后照常返回大纲。
      const message = `[code.outline] path=${relPath}; line count unavailable (${errorMessage(err, 'read failed')}); outline header omits it`;
      observeSafely(
        () => Logger.getInstance().debug(message),
        () => undefined
      );
    }
  }

  const lang = detectLanguage(relPath);
  const outlineLines = [
    lineCount === undefined
      ? `// ${lang}, Tree-sitter AST`
      : `// ${lineCount} lines, ${lang}, Tree-sitter AST`,
    '',
  ];

  for (const def of result.definitions) {
    const indent = '  '.repeat(def.depth ?? 0);
    const lineRange = def.endLine ? `[${def.startLine}-${def.endLine}]` : `[${def.startLine}]`;
    const signature = def.signature ?? def.name;
    outlineLines.push(`${indent}${signature} ${lineRange}`);
  }

  return { kind: 'outline', text: outlineLines.join('\n') };
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

/**
 * code.structure 输出的条目上限（含根行，I20）：router 对 structure 的展示配额是 2000 token，
 * 约合 400 行紧凑树；收满即停止遍历（不再发起新的 readdir），不必遍历完整个大仓库再被截断。
 */
const STRUCTURE_MAX_ENTRIES = 400;

/**
 * 一次 code.structure 遍历的共享状态（I20）：取消信号、条目计数与上限、不可读子目录。
 * 取消与上限都只在“发起下一次 readdir / 追加下一行”前检查，已构造的部分树原样返回。
 */
interface StructureWalk {
  readonly signal?: AbortSignal;
  readonly maxEntries: number;
  entries: number;
  truncated: boolean;
  /**
   * 遍历被取消时的归类（与 code.search / terminal 同一口径）：期限 → timeout，宿主/用户取消 → aborted；
   * 未取消为 undefined。第一次观察到取消时写入，之后不再变化。
   */
  cancelled?: CancellationStatus;
  /** readdir 失败的子目录（项目相对路径）；根目录失败直接抛错，整次调用失败。 */
  unreadableDirs: string[];
}

async function handleStructure(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const directory = (params.directory as string) || '.';
  const depth = Math.min((params.depth as number) || 3, 5);
  const walk: StructureWalk = {
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    maxEntries: STRUCTURE_MAX_ENTRIES,
    entries: 0,
    truncated: false,
    unreadableDirs: [],
  };

  let lines: string[];
  try {
    const absDir = resolveProjectPath(ctx.projectRoot, directory).absolute;
    const canonicalRoot = resolveProjectPath(ctx.projectRoot, '.').absolute;
    lines = await buildDirectoryTree(absDir, canonicalRoot, depth, 0, walk);
  } catch (err: unknown) {
    return fail(`Cannot list structure: ${err instanceof Error ? err.message : String(err)}`);
  }

  reportStructureWalk(directory, walk);
  if (walk.cancelled && lines.length === 0) {
    // 根目录都还没列出就被取消：没有可返回的部分树，按失败报告并显式声明 timeout/aborted。
    const reason =
      walk.cancelled === 'timeout'
        ? 'reached its deadline before listing'
        : 'aborted before listing';
    return {
      ...fail(`code.structure ${reason} ${directory}`),
      _meta: { cached: false, tokensEstimate: 0, durationMs: 0, resultStatus: walk.cancelled },
    };
  }

  // 模型看不到信封诊断：截断与取消在树尾追加一行标记，说明下面缺了什么。
  if (walk.truncated) {
    lines.push(
      `... [structure truncated at ${walk.maxEntries} entries; list a narrower directory or a smaller depth for the rest]`
    );
  }
  if (walk.cancelled === 'timeout') {
    lines.push(
      '... [structure listing reached its deadline before completion; the tree above is partial]'
    );
  } else if (walk.cancelled === 'aborted') {
    lines.push('... [structure listing aborted before completion; the tree above is partial]');
  }
  const tree = lines.join('\n');
  const warnings = structureWarnings(walk);
  const resultStatus =
    walk.cancelled ??
    (walk.truncated || walk.unreadableDirs.length > 0 ? ('partial' as const) : undefined);
  return ok(tree, {
    tokensEstimate: estimateTokens(tree),
    ...(resultStatus ? { degraded: true, resultStatus } : {}),
    ...(warnings.length > 0 ? { diagnosticWarnings: warnings } : {}),
  });
}

function structureWarnings(walk: StructureWalk): ToolDiagnosticWarning[] {
  const warnings: ToolDiagnosticWarning[] = [];
  if (walk.cancelled) {
    const cause = walk.cancelled === 'timeout' ? 'reached its deadline' : 'aborted';
    warnings.push({
      code: 'code_structure_incomplete',
      message: `Directory listing ${cause} before completion after ${walk.entries} entries; directories not yet visited are missing from the tree.`,
      stage: 'code.structure',
      tool: 'code',
    });
  }
  if (walk.truncated) {
    warnings.push({
      code: 'code_structure_truncated',
      message: `Directory listing stopped at ${walk.maxEntries} entries; later entries were not listed. Use a narrower directory or a smaller depth.`,
      stage: 'code.structure',
      tool: 'code',
    });
  }
  if (walk.unreadableDirs.length > 0) {
    warnings.push({
      code: 'code_structure_unreadable',
      message: `Could not read ${plural(walk.unreadableDirs.length, 'subdirectory', 'subdirectories')} (shown as <unreadable>): ${samplePaths(walk.unreadableDirs)}.`,
      stage: 'code.structure',
      tool: 'code',
    });
  }
  return warnings;
}

/** 遍历降级（取消、截断、不可读子目录）记一条汇总日志；完整遍历不打日志。 */
function reportStructureWalk(directory: string, walk: StructureWalk): void {
  if (!walk.cancelled && !walk.truncated && walk.unreadableDirs.length === 0) {
    return;
  }
  const message =
    `[code.structure] directory=${JSON.stringify(directory)} entries=${walk.entries} ` +
    `cap=${walk.maxEntries} truncated=${walk.truncated} cancelled=${walk.cancelled ?? 'none'} ` +
    `unreadableDirs=${walk.unreadableDirs.length}`;
  observeSafely(
    () =>
      walk.unreadableDirs.length > 0
        ? Logger.getInstance().warn(message)
        : Logger.getInstance().info(message),
    () => undefined
  );
}

/**
 * code.structure 展示目录树时隐藏的目录：以 code.search 的单一忽略集为底，再加只为展示降噪的名字。
 * 成员与旧 IGNORED_DIRS 完全相同（结构展示行为不变）；Packages 等只在这里隐藏，不进入搜索忽略集，
 * 因为本地 Swift Package 是真实源码，搜索必须覆盖。
 */
const STRUCTURE_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ...SEARCH_IGNORED_NAMES,
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  'Packages',
  '.swiftpm',
]);

/** 占用一个输出条目名额；名额用尽时标记截断并返回 false（调用方停止追加与遍历）。 */
function takeStructureEntry(walk: StructureWalk): boolean {
  if (walk.entries >= walk.maxEntries) {
    walk.truncated = true;
    return false;
  }
  walk.entries++;
  return true;
}

/** 已取消或已截断：不再发起新的 readdir，也不再追加条目。取消原因在第一次观察到时归类。 */
function structureWalkStopped(walk: StructureWalk): boolean {
  if (walk.cancelled === undefined && walk.signal?.aborted) {
    walk.cancelled = cancellationStatus(walk.signal);
  }
  return walk.cancelled !== undefined || walk.truncated;
}

async function buildDirectoryTree(
  absDir: string,
  projectRoot: string,
  maxDepth: number,
  currentDepth: number,
  walk: StructureWalk
): Promise<string[]> {
  const relDir = path.relative(projectRoot, absDir) || '.';
  const indent = '  '.repeat(currentDepth + (currentDepth === 0 ? 0 : 1));
  if (structureWalkStopped(walk)) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err: unknown) {
    if (currentDepth === 0) {
      // 请求的目录本身读不了：没有可展示的树，交给外层按失败处理。
      throw err instanceof Error ? err : new Error(String(err));
    }
    // 子目录读不了（如 EACCES）：只把该节点标成 <unreadable>，兄弟目录照常列出，诊断点名。
    walk.unreadableDirs.push(relDir);
    return takeStructureEntry(walk) ? [`${indent}<unreadable>`] : [];
  }

  const lines: string[] = [];
  if (currentDepth === 0) {
    if (!takeStructureEntry(walk)) {
      return lines;
    }
    lines.push(`${relDir}/`);
  }

  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      continue;
    }
    if (entry.isDirectory()) {
      if (!STRUCTURE_IGNORED_DIRS.has(entry.name)) {
        dirs.push(entry.name);
      }
    } else {
      files.push(entry.name);
    }
  }

  dirs.sort();
  files.sort();

  for (const dir of dirs) {
    if (structureWalkStopped(walk) || !takeStructureEntry(walk)) {
      return lines;
    }
    lines.push(`${indent}${dir}/`);
    if (currentDepth < maxDepth - 1) {
      lines.push(
        ...(await buildDirectoryTree(
          path.join(absDir, dir),
          projectRoot,
          maxDepth,
          currentDepth + 1,
          walk
        ))
      );
    }
  }

  for (const file of files) {
    if (structureWalkStopped(walk) || !takeStructureEntry(walk)) {
      return lines;
    }
    lines.push(`${indent}${file}`);
  }

  return lines;
}

/* ================================================================== */
/*  code.write                                                         */
/* ================================================================== */

/**
 * code.write 受保护路径规则（L4-P16 / I15）。
 *
 * 旧实现只认根目录、区分大小写、按 '/' 前缀匹配 ['.git','node_modules','.env']，
 * `.env.local`、子目录 `.env`、嵌套 node_modules、macOS 上 `.GIT/config` 都能写穿。
 * 现在改为按路径段判定：路径按 '/' 与平台分隔符拆段，每段统一小写后比较，任一段命中即拒绝：
 *   - git-metadata：段等于 `.git`（含子目录里的 .git，如子模块/嵌套仓库）；
 *   - dependency-directory：段等于 `node_modules`（含 monorepo 子包里的依赖目录）；
 *   - env-file：段匹配 /^\.env(\..+)?$/（`.env`、`.env.local`、`.env.production.local` 等）。
 * `.env.example` 与 `.env.sample` 是约定入库、不含密钥的模板名，按决策显式放行。
 * 统一小写是为了覆盖 macOS/Windows 默认大小写不敏感的文件系统：`.GIT/config` 实际写的就是
 * `.git/config`；在大小写敏感的文件系统上这只会多拒一个同名异写路径，属于偏严的安全取舍。
 */
type ProtectedPathRule = 'git-metadata' | 'dependency-directory' | 'env-file';

const PROTECTED_ENV_FILE_PATTERN = /^\.env(\..+)?$/;
const PROTECTED_ENV_TEMPLATE_NAMES: ReadonlySet<string> = new Set(['.env.example', '.env.sample']);

/** 命中详情：path 是命中视图下相对项目根的路径，segment 保留原始大小写便于排查。 */
interface ProtectedPathHit {
  rule: ProtectedPathRule;
  segment: string;
  path: string;
  /** requested：模型请求的词法路径；resolved：symlink 解析后的真实落盘路径。 */
  view: 'requested' | 'resolved';
}

function protectedSegmentRule(segment: string): ProtectedPathRule | undefined {
  const normalized = segment.toLowerCase();
  if (normalized === '.git') {
    return 'git-metadata';
  }
  if (normalized === 'node_modules') {
    return 'dependency-directory';
  }
  if (
    PROTECTED_ENV_FILE_PATTERN.test(normalized) &&
    !PROTECTED_ENV_TEMPLATE_NAMES.has(normalized)
  ) {
    return 'env-file';
  }
  return undefined;
}

function findProtectedSegment(
  relPath: string,
  view: ProtectedPathHit['view']
): ProtectedPathHit | undefined {
  // 同时按 '/' 与 path.sep 拆段：POSIX 上两者相同；Windows 上模型可能混用两种分隔符。
  const segments = relPath.split('/').flatMap((part) => part.split(path.sep));
  for (const segment of segments) {
    const rule = protectedSegmentRule(segment);
    if (rule) {
      return { rule, segment, path: relPath, view };
    }
  }
  return undefined;
}

/**
 * 两个视图都要查：
 * - requested（词法路径）：`.env -> config/secrets.txt` 这类 symlink 的真实目标是普通文件名，
 *   只查真实路径会放行对 `.env` 的写入；
 * - resolved（realpath 后的路径）：`alias -> packages/x/.env.local` 这类别名的请求名无害，
 *   只查词法路径会写穿受保护文件。
 * resolveProjectFilePath 已保证两者都在项目根内，这里只做段匹配，不重复包含校验。
 */
function checkProtectedWritePath(
  filePath: string,
  projectRoot: string,
  resolvedRelPath: string
): ProtectedPathHit | undefined {
  const lexicalRoot = path.resolve(projectRoot);
  const requestedRelPath = path.relative(lexicalRoot, path.resolve(lexicalRoot, filePath));
  return (
    findProtectedSegment(requestedRelPath, 'requested') ??
    findProtectedSegment(resolvedRelPath, 'resolved')
  );
}

/**
 * 受保护路径拒绝回执：blocked 状态让 adapter 记入 blockedTools，诊断与日志写明命中视图、
 * 路径、原始段与规则，不记录待写内容；写入从未开始。
 */
function protectedPathDenial(hit: ProtectedPathHit): ToolResult {
  const detail = `path=${hit.path}; view=${hit.view}; segment=${hit.segment}; rule=${hit.rule}`;
  observeSafely(
    () => Logger.getInstance().warn(`[code.write] ${detail}; result=denied; write=not-started`),
    () => undefined
  );
  return {
    ok: false,
    data: null,
    error: `Write denied: ${hit.path} is a protected path (segment "${hit.segment}" matched rule ${hit.rule})`,
    _meta: {
      cached: false,
      tokensEstimate: 0,
      durationMs: 0,
      resultStatus: 'blocked',
      diagnosticWarnings: [
        {
          code: 'code_write_protected_path',
          message: `${detail}; write was not attempted`,
          stage: 'code.write',
          tool: 'code',
        },
      ],
    },
  };
}

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

  // 受保护路径先于新鲜度门判定：拒绝不读盘、不建目录、不写盘。
  const protectedHit = checkProtectedWritePath(filePath, ctx.projectRoot, resolved.relPath);
  if (protectedHit) {
    return protectedPathDenial(protectedHit);
  }

  // ── B-1 写前新鲜度门（read-before-write, TOCTOU）──────────────────────
  // 新文件判定 key 在"写时磁盘是否存在"，非"cache 是否有记录"：磁盘已存在但本 run 未读的
  // 文件（上一轮产物或并发 host rescan/job 写的）必须走"已存在"分支，否则被当新文件放行
  // → 重开 TOCTOU 洞。deltaCache 未注入时门降级透传，由受保护路径段规则兜底。
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
      invalidateSearchCache(ctx.searchCache, 'code.write', 'write-started');
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
 * deltaCache 未注入：透传（不误拒合法写，安全退回受保护路径段规则）。key 用 relPath（与 :459 一致）。
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

/* ================================================================== */
/*  code.search in-process fallback（rg 缺席时）                        */
/* ================================================================== */

/**
 * fallback 候选文件的全局上限：遍历收集到这么多候选文件后整体硬停（旧实现只退出当前递归层，
 * 其他层继续收集且从不标 incomplete）。没收满 maxResults 的 pattern 据此标 partial。
 */
const FALLBACK_FILE_CAP = 5000;

/** 诊断里最多点名的不可读路径数；其余只计数，避免诊断随大仓库膨胀。 */
const FALLBACK_UNREADABLE_SAMPLE = 5;

/** rg 缺席时给模型和宿主的说明：fallback 的方言与能力边界都在这里写明。 */
const FALLBACK_NOTICE =
  'ripgrep is unavailable (ENOENT); using the in-process search fallback ' +
  '(JavaScript RegExp dialect, ripgrep-style globs via path.matchesGlob, ' +
  `project-root .gitignore only, at most ${FALLBACK_FILE_CAP} candidate files).`;

/**
 * 一条 gitignore 风格的 glob 规则。rg 的 --glob 与 .gitignore 用同一套写法：
 * - 以 ! 开头：在 override（--glob）里表示排除，在 .gitignore 里表示重新纳入；
 * - 以 / 结尾：只匹配目录；
 * - 开头或中间含 /：相对项目根匹配完整相对路径；否则匹配任意层级的名字（basename）。
 */
interface FallbackGlobRule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  /** 去掉 !、首尾 / 之后的 pattern。 */
  pattern: string;
  /** 不含通配元字符：按字符串精确比较（大小写敏感，与 rg 一致），不经 matchesGlob。 */
  literal: boolean;
}

/** 一次 fallback 搜索的筛选规则：override 与根 .gitignore 都已编译。 */
interface FallbackFilter {
  /** rg 的 --glob 序列：单一忽略集生成的排除项 + 用户 glob（排在最后，最后命中者生效）。 */
  overrides: FallbackGlobRule[];
  /** override 中存在白名单（非 ! 开头）glob：没命中任何 override 的文件一律跳过。 */
  hasWhitelist: boolean;
  gitignore: FallbackGlobRule[];
}

/**
 * 一次 code.search 调用内所有 pattern 共享的 fallback 文件清单：只遍历一次，上限、不可读目录与
 * 忽略规则对每个 pattern 一致，诊断也只报一次。
 */
interface FallbackScan {
  /** 候选文件（项目相对 POSIX 路径），目录内按名字排序的深度优先顺序，结果可复现。 */
  files: string[];
  /** 遍历在 FALLBACK_FILE_CAP 处全局硬停：还有候选文件没有进入清单。 */
  capped: boolean;
  /** readdir 失败的子目录（项目相对路径）；根目录失败直接抛错，由调用方记为 pattern 失败。 */
  unreadableDirs: string[];
  /** 用户 glob 超出 fallback 能力时的原因；此时不遍历，调用方必须显式拒绝而不是报 0 命中。 */
  globUnsupported?: string;
}

const GLOB_META_RE = /[*?[\]{}]/;
/** minimatch 会把 @(...)/!(...) 等当 extglob 解释，rg 的 globset 不支持这种写法，两边语义会分叉。 */
const EXTGLOB_RE = /[?*+@!]\(/;

function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

function errorMessage(err: unknown, fallbackText: string): string {
  return err instanceof Error ? err.message : fallbackText;
}

/**
 * 把一条 gitignore 风格 glob 编译成规则；超出 fallback 能力的形状返回原因，由调用方决定显式拒绝
 * （用户 glob）还是跳过并计数（.gitignore 行）。能力边界：
 * - 反斜杠：rg 当转义符，Node 的 matchesGlob 当路径分隔符，语义不同；
 * - extglob 组：minimatch 支持而 rg 不支持；
 * - 含通配符但运行时没有 path.matchesGlob（Node.js < 22.5）。
 */
function compileFallbackGlob(raw: string): { rule: FallbackGlobRule } | { unsupported: string } {
  let body = raw;
  const negated = body.startsWith('!');
  if (negated) {
    body = body.slice(1);
  }
  if (body.includes('\\')) {
    return { unsupported: 'backslash escapes are not supported by the in-process matcher' };
  }
  if (EXTGLOB_RE.test(body)) {
    return { unsupported: 'extglob groups such as @(...) are not ripgrep glob syntax' };
  }
  const dirOnly = body.endsWith('/');
  body = body.replace(/\/+$/, '');
  const anchored = body.includes('/');
  body = body.replace(/^\/+/, '');
  if (!body) {
    return { unsupported: 'the glob is empty after removing "!" and leading/trailing "/"' };
  }
  const literal = !GLOB_META_RE.test(body);
  if (!literal) {
    if (typeof path.posix.matchesGlob !== 'function') {
      return {
        unsupported:
          'path.matchesGlob is unavailable in this Node.js runtime (needs 22.5 or later)',
      };
    }
    try {
      path.posix.matchesGlob('probe', body);
    } catch (err: unknown) {
      return {
        unsupported: `path.matchesGlob rejected the pattern (${errorMessage(err, 'invalid pattern')})`,
      };
    }
  }
  return { rule: { negated, dirOnly, anchored, pattern: body, literal } };
}

/**
 * 规则是否命中一个目录项。无分隔符的规则只比名字：gitignore 语义下它匹配任意层级，而通配符不跨 /，
 * 比名字与比完整路径等价。注意 Node 的 matchesGlob 在 macOS/Windows 上大小写不敏感、且通配符不匹配
 * 以 . 开头的段，与 rg 略有出入；字面量规则（包括整个单一忽略集）走精确比较，与 rg 一致。
 */
function fallbackRuleMatches(
  rule: FallbackGlobRule,
  relPath: string,
  name: string,
  isDir: boolean
): boolean {
  if (rule.dirOnly && !isDir) {
    return false;
  }
  const subject = rule.anchored ? relPath : name;
  return rule.literal ? subject === rule.pattern : path.posix.matchesGlob(subject, rule.pattern);
}

/** gitignore 语义：最后一条命中的规则生效，所以从后往前找第一条命中。 */
function lastMatchingRule(
  rules: readonly FallbackGlobRule[],
  relPath: string,
  name: string,
  isDir: boolean
): FallbackGlobRule | undefined {
  for (let index = rules.length - 1; index >= 0; index--) {
    if (fallbackRuleMatches(rules[index], relPath, name, isDir)) {
      return rules[index];
    }
  }
  return undefined;
}

/**
 * 复刻 rg（ignore crate）对单个目录项的判定顺序：
 * 1. override（单一忽略集生成的排除项 + 用户 glob，最后命中者生效）：命中 `!x` 跳过，命中 `x` 纳入，
 *    并越过 .gitignore 与隐藏规则（所以 `src/**` 会纳入被 .gitignore 的 src/generated）；
 * 2. 存在白名单 glob 而文件没命中任何 override：跳过；目录仍要下钻，否则 `*.ts` 会剪掉所有目录；
 * 3. 根 .gitignore（最后命中者生效，`!x` 重新纳入）；
 * 4. 名字以 . 开头的隐藏项，未被 .gitignore 重新纳入时跳过。
 */
function fallbackEntrySelected(
  filter: FallbackFilter,
  relPath: string,
  name: string,
  isDir: boolean
): boolean {
  const override = lastMatchingRule(filter.overrides, relPath, name, isDir);
  if (override) {
    return !override.negated;
  }
  if (!isDir && filter.hasWhitelist) {
    return false;
  }
  const ignore = lastMatchingRule(filter.gitignore, relPath, name, isDir);
  if (ignore) {
    return ignore.negated;
  }
  return !name.startsWith('.');
}

/** 与 rg 一致：只有项目根或其祖先存在 .git 时才应用 .gitignore。 */
async function isInsideGitRepository(root: string): Promise<boolean> {
  let dir = path.resolve(root);
  while (true) {
    try {
      await fs.stat(path.join(dir, '.git'));
      return true;
    } catch (err: unknown) {
      // 不存在或无权限都视为此层没有 .git，继续向上找。
      void err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

interface RootGitignore {
  rules: FallbackGlobRule[];
  /** 超出 fallback 能力而没有应用的 .gitignore 行；少应用只会多搜（超集），不会漏搜。 */
  skipped: string[];
  state: 'applied' | 'absent' | 'not-a-git-repo' | 'unreadable';
}

/**
 * 读取项目根的 .gitignore（fallback 的最低能力；rg 还会读嵌套 .gitignore、.ignore、.rgignore 和
 * 全局 excludes，fallback 不读，差异写在 FALLBACK_NOTICE 里）。
 */
async function loadRootGitignore(root: string): Promise<RootGitignore> {
  if (!(await isInsideGitRepository(root))) {
    return { rules: [], skipped: [], state: 'not-a-git-repo' };
  }
  let content: string;
  try {
    content = await fs.readFile(path.join(root, '.gitignore'), 'utf-8');
  } catch (err: unknown) {
    if (hasErrorCode(err, 'ENOENT')) {
      return { rules: [], skipped: [], state: 'absent' };
    }
    // 读不到 .gitignore 只会让 fallback 多搜，不会漏搜：记日志后不带规则继续。
    const message = `[code.search] fallback could not read the project-root .gitignore; searching without it: ${errorMessage(err, 'read failed')}`;
    observeSafely(
      () => Logger.getInstance().warn(message),
      () => undefined
    );
    return { rules: [], skipped: [], state: 'unreadable' };
  }
  const rules: FallbackGlobRule[] = [];
  const skipped: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) {
      continue;
    }
    // gitignore 忽略行尾空格；被反斜杠转义的空格属于反斜杠写法，下面按不支持跳过。
    const line = raw.replace(/ +$/, '');
    if (!line) {
      continue;
    }
    const compiled = compileFallbackGlob(line);
    if ('unsupported' in compiled) {
      skipped.push(line);
      continue;
    }
    rules.push(compiled.rule);
  }
  return { rules, skipped, state: 'applied' };
}

/**
 * 编译 fallback 的 override 序列：与 rg 收到的 --glob 参数同序（单一忽略集在前，用户 glob 在后）。
 * 用户 glob 超出能力时返回原因，调用方显式拒绝。
 */
function buildFallbackOverrides(
  glob: string | undefined
): { overrides: FallbackGlobRule[]; hasWhitelist: boolean } | { unsupported: string } {
  const sources = glob ? [...RG_EXCLUDE_GLOBS, glob] : [...RG_EXCLUDE_GLOBS];
  const overrides: FallbackGlobRule[] = [];
  for (const source of sources) {
    const compiled = compileFallbackGlob(source);
    if ('unsupported' in compiled) {
      return { unsupported: compiled.unsupported };
    }
    overrides.push(compiled.rule);
  }
  return { overrides, hasWhitelist: overrides.some((rule) => !rule.negated) };
}

/**
 * 按 rg 的忽略语义列出 fallback 候选文件。符号链接沿用旧行为作为候选（读取前经 resolveProjectPath
 * 校验仍在项目内），FIFO/socket/设备文件不列入（读 FIFO 会阻塞）。
 */
async function scanFallbackFiles(
  root: string,
  glob: string | undefined,
  signal?: AbortSignal
): Promise<FallbackScan> {
  const built = buildFallbackOverrides(glob);
  if ('unsupported' in built) {
    const message = `[code.search] fallback rejected glob ${JSON.stringify(glob)}: ${built.unsupported}`;
    observeSafely(
      () => Logger.getInstance().warn(message),
      () => undefined
    );
    return { files: [], capped: false, unreadableDirs: [], globUnsupported: built.unsupported };
  }
  const gitignore = await loadRootGitignore(root);
  const filter: FallbackFilter = { ...built, gitignore: gitignore.rules };
  const files: string[] = [];
  const unreadableDirs: string[] = [];
  let capped = false;

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err: unknown) {
      if (!relDir) {
        // 项目根都读不了：整个 fallback 无法执行，交给调用方按 pattern 失败处理。
        throw err instanceof Error ? err : new Error(String(err));
      }
      // 子目录读不了：记下来继续遍历；没收满的 pattern 会标 partial，诊断点名这些目录。
      unreadableDirs.push(relDir);
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (capped || signal?.aborted) {
        return;
      }
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (!fallbackEntrySelected(filter, relPath, entry.name, isDir)) {
        continue;
      }
      if (isDir) {
        await walk(path.join(absDir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      if (files.length >= FALLBACK_FILE_CAP) {
        // 全局硬停：已经确认还有候选文件在上限之外。
        capped = true;
        return;
      }
      files.push(relPath);
    }
  }

  await walk(root, '');
  const degraded = capped || unreadableDirs.length > 0 || gitignore.skipped.length > 0;
  const summary =
    `[code.search] in-process fallback scan: candidates=${files.length} capped=${capped} ` +
    `cap=${FALLBACK_FILE_CAP} unreadableDirs=${unreadableDirs.length} gitignore=${gitignore.state} ` +
    `gitignoreRules=${gitignore.rules.length} skippedGitignoreRules=${gitignore.skipped.length} ` +
    `glob=${JSON.stringify(glob ?? null)} aborted=${signal?.aborted === true}`;
  observeSafely(
    () => (degraded ? Logger.getInstance().warn(summary) : Logger.getInstance().info(summary)),
    () => undefined
  );
  return { files, capped, unreadableDirs };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * fallback 扫描与读取的诊断（每次调用只报一次）：glob 超出能力、不可读目录与文件。
 * 不可读项是否让某个 pattern 变成 partial 由 fallbackRegexSearch 决定，这里只负责点名与计数。
 */
function pushFallbackScanWarnings(
  warnings: ToolDiagnosticWarning[],
  scan: FallbackScan,
  unreadableFiles: ReadonlySet<string>,
  glob: string | undefined
): void {
  if (scan.globUnsupported !== undefined) {
    warnings.push({
      code: 'code_search_fallback_glob_unsupported',
      message: `In-process fallback cannot evaluate glob ${JSON.stringify(glob)}: ${scan.globUnsupported}. Nothing was searched; install ripgrep or use a glob without that syntax.`,
      stage: 'code.search',
      tool: 'code',
    });
  }
  const dirs = scan.unreadableDirs.length;
  const files = unreadableFiles.size;
  if (dirs === 0 && files === 0) {
    return;
  }
  const unreadable = [...scan.unreadableDirs.map((dir) => `${dir}/`), ...unreadableFiles];
  const sample = unreadable.slice(0, FALLBACK_UNREADABLE_SAMPLE).join(', ');
  const more =
    unreadable.length > FALLBACK_UNREADABLE_SAMPLE
      ? ` and ${unreadable.length - FALLBACK_UNREADABLE_SAMPLE} more`
      : '';
  const message = `In-process fallback could not read ${plural(dirs, 'directory', 'directories')} and ${plural(files, 'file', 'files')}; their contents were not searched: ${sample}${more}.`;
  warnings.push({
    code: 'code_search_fallback_unreadable',
    message,
    stage: 'code.search',
    tool: 'code',
  });
  observeSafely(
    () => Logger.getInstance().warn(`[code.search] ${message}`),
    () => undefined
  );
}
