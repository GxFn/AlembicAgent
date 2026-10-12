/**
 * @module tools/runtime/handlers/terminal
 *
 * 终端执行工具 — 在 Seatbelt 沙箱中执行命令，返回结构化压缩输出。
 * Actions: exec
 *
 * 执行流程: cwd 校验 → timeout 归一 → 危险命令预检 → capability allowlist（注入时）
 *           → 执行器 fail-closed 判定 → Seatbelt 沙箱执行（执行器结果归一）→ OutputCompressor 压缩
 *
 * 输出预算（L4-P12 / I11）: 交给 compressor 的预算是 min(ctx.tokenBudget, exec.maxOutputTokens)
 *           再扣除 '[exit N]' 前缀与 '[unsandboxed:...]' 诊断后缀的估算 token，让压缩器成为实际生效的
 *           那次截断（尾部的测试摘要与 [stderr] 段由它的头尾策略保留）。按 action.maxOutputTokens 的
 *           router.enforceOutputLimit 在本 handler 返回后仍会执行，但只是兜底：压缩器缺失或抛错、
 *           或非 ASCII 输出按字符预算压缩后估算 token 仍超限时才会再截一次。
 *
 * 审计（L4-P12 / I35）: 每条路径都以稳定分类码写入审计 error（invalid:/blocked:/blocked-allowlist:/
 *           exit:/interrupted:/executor-threw:），只含规则 id 与状态码，不含命令原文或拦截原因文本。
 *
 * 沙箱集成: 通过 ToolContext.sandboxExecutor 注入 SandboxExecutor。
 *           未注入或注入对象没有可调用的 exec 时默认拒绝执行（fail-closed）：宿主漏接线不应
 *           悄悄变成继承宿主环境变量的无沙箱执行。只有 ToolContext.allowUnsandboxedTerminal
 *           === true 时才降级为 plain exec，并在结果里标注 unsandboxed。
 *           可用性快照（availability.ts）按同一条件隐藏 terminal.exec，两处判定必须保持一致。
 *
 * 隔离意图（L4-P38 / I47）: 当前能力声明的 intent（例如 Evolution 的 network:'none' /
 *           filesystem:'read-only'）经归一化后作为 exec opts 的可选字段 intent 交给宿主执行端口。
 *           生产链路上宿主的 ToolRouterAdapter 不带 capability，intent 来自 ctx.runtime.terminalIntent
 *           （runtimeBridge 按 loopCtx.capabilities 投影）；带 capability 的 ToolRouter 另经
 *           ctx.commandAllowlist.intent 提供，两者按最严格取值合并（见 resolveTerminalIntent）。
 *           Agent 侧只负责透传，真正的隔离由宿主执行；当前 Alembic SandboxExecutorBridge 尚未读取
 *           opts.intent，仍按固定 profile 执行。没有声明 intent 时 opts 与旧版完全相同；宿主不读
 *           该字段时行为不变。命令最终没有进沙箱（宿主报告降级或走 plain exec）时，声明的 intent
 *           必然没生效，结果里追加 terminal_intent_not_enforced 诊断。
 *
 * 搜索缓存失效（L4-P15 / I05）: 执行器一旦被调用（Seatbelt 执行器或显式许可的 plain exec），在它 settle
 *           之后推进 code.search 的缓存代数（./searchCacheGeneration.ts，与 code.write 共用），并记
 *           search cache invalidated 日志。成功、非零退出、137 强杀、超时、执行器抛错一律推进：进程可能
 *           已经（部分）写盘，allowlist 里的 npm/vitest/eslint 也会写格式化结果、产物或缓存文件，按命令
 *           判断“只读”不可靠。参数无效、安全规则、allowlist、缺沙箱、cwd 越界在调用执行器之前就返回，
 *           不推进。不做 mtime/TTL 失效（待决事项①）。
 */

import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { isDeadlineAbort } from '#shared/operation.js';
import { resolveProjectPath } from '#shared/projectPath.js';
import {
  estimateTokens,
  fail,
  mergeTerminalIntents,
  ok,
  type TerminalCommandAllowlist,
  type ToolAuditEntry,
  type ToolContext,
  type ToolDiagnosticWarning,
  type ToolResult,
  type ToolResultMeta,
} from '#tools/kernel/registry.js';
import { stripAnsi } from '../compressor/strip.js';
import { invalidateSearchCache } from './searchCacheGeneration.js';
import { checkTerminalCommandAllowlist, checkTerminalCommandSafety } from './terminalSafety.js';

const execAsync = promisify(exec);
const SANDBOX_FALLBACK_REASON = 'missing_sandbox_executor';
/** 宿主注入了 sandboxExecutor 但它没有可调用的 exec：与“未注入”区分，便于定位接线错误。 */
const SANDBOX_INVALID_REASON = 'sandbox_executor_missing_exec';
const SANDBOX_REQUIRED_MESSAGE =
  'Terminal execution unavailable: no sandbox executor is configured for this host. ' +
  'Continue with code/graph/knowledge tools instead.';

/** 未提供或非法 timeout 时的默认值，以及 schema 描述里写明的上限（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
/** ctx.tokenBudget 缺失/非法时交给压缩器的默认预算，沿用旧的 `|| 4000` 口径。 */
const DEFAULT_COMPRESSOR_TOKEN_BUDGET = 4000;
/** OutputCompressor 的预算口径：maxChars = tokenBudget * 4（ASCII 下与 shared token 估算一致）。 */
const COMPRESSOR_CHARS_PER_TOKEN = 4;
/** 审计分类码与日志里只允许出现的受限字符集（规则 id、状态码、错误类名）。 */
const SAFE_TOKEN_RE = /^[\w.-]{1,64}$/u;

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (action !== 'exec') {
    return fail(`Unknown terminal action: ${action}`);
  }
  return handleExec(params, ctx);
}

async function handleExec(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = typeof params.command === 'string' ? params.command : '';

  const startMs = Date.now();
  const commandHash = hashCommand(command);
  const finish = async (result: ToolResult, audit: TerminalAuditOutcome) => {
    await recordTerminalAudit(
      ctx,
      buildTerminalAuditEntry(ctx, {
        ...audit,
        duration: result._meta?.durationMs ?? Date.now() - startMs,
        commandHash,
      })
    );
    return result;
  };

  if (!command) {
    return finish(
      fail('terminal.exec requires command'),
      auditFailure('invalid', 'missing_command')
    );
  }

  const cwdResult = resolveTerminalCwd(params.cwd, ctx.projectRoot);
  if (!cwdResult.ok) {
    return finish(fail(cwdResult.error), auditFailure('blocked', 'cwd_outside_root'));
  }
  const cwd = cwdResult.cwd;

  // timeout 来自模型参数：schema 只约束 type:number，负数/小数/非有限值必须在这里归一（I19），
  // 否则宿主 setTimeout 会在约 1ms 后强杀命令并报成来源不明的中断。
  const { timeout, warning: timeoutWarning } = normalizeTerminalTimeout(params.timeout);

  const securityCheck = checkTerminalCommandSafety(command);
  if (!securityCheck.safe) {
    return finish(
      fail(`Command blocked: ${securityCheck.block.reason} (${securityCheck.block.rule})`),
      auditFailure('blocked', securityCheck.block.rule)
    );
  }

  const allowlistCheck = ctx.commandAllowlist
    ? checkTerminalCommandAllowlist(command, ctx.commandAllowlist.bins)
    : { safe: true as const };
  if (!allowlistCheck.safe) {
    return finish(
      fail(
        `Command blocked by allowlist: ${allowlistCheck.block.reason} (${allowlistCheck.block.rule})`
      ),
      auditFailure('blocked-allowlist', allowlistCheck.block.rule)
    );
  }

  // 执行器缺失（或注入对象没有可调用的 exec）且宿主没有显式许可：在启动任何进程之前拒绝。
  // 判定按 exec 方法存在性而非对象真值，与可用性快照的 terminal.exec 检查同一事实。blocked 状态
  // 让 adapter 把它记入 blockedTools，诊断里写明触发条件，宿主能据此发现接线缺口。
  if (!isSandboxExecutor(ctx.sandboxExecutor) && ctx.allowUnsandboxedTerminal !== true) {
    const executorState =
      // 假值（未注入/null/false）沿用旧的“缺失”口径；其余是注入了却没有可调用 exec 的接线错误。
      !ctx.sandboxExecutor ? 'sandboxExecutor missing' : 'sandboxExecutor has no exec method';
    return finish(
      {
        ok: false,
        data: null,
        error: SANDBOX_REQUIRED_MESSAGE,
        _meta: {
          cached: false,
          tokensEstimate: 0,
          durationMs: Date.now() - startMs,
          resultStatus: 'blocked',
          diagnosticWarnings: [
            {
              code: 'terminal_sandbox_required',
              message: `${executorState} and allowUnsandboxedTerminal is not true; command was not started`,
              stage: 'terminal.exec',
              tool: 'terminal',
            },
          ],
        },
      },
      auditFailure('blocked', 'terminal_sandbox_required')
    );
  }

  // 只在命令已通过安全与 allowlist 检查、确定要交给执行器时才归一化 intent：被拒绝的命令
  // 不会触达宿主，也就不需要为它的 intent 打日志。
  const intent = resolveTerminalIntent(ctx);
  // 执行阶段之前就确定的附属诊断（timeout 归一），所有执行结局都要带上。
  const inputWarnings: ToolDiagnosticWarning[] = timeoutWarning ? [timeoutWarning] : [];

  try {
    const { stdout, stderr, exitCode, diagnostics, warnings } = await execAndInvalidateSearchCache(
      command,
      cwd,
      timeout,
      ctx,
      intent
    );
    const sideWarnings = [...inputWarnings, ...warnings];

    if (exitCode === 137) {
      // 旧宿主用 137 同时表示超时、取消和输出配额强杀；没有信号事实时不能猜成超时。
      // 保留已执行得到的输出和兼容 ok，明确终态供 adapter/观察器判断；不再等待无用的压缩。
      const resultStatus = terminalFailureStatus(ctx.abortSignal);
      const reason = ctx.abortSignal?.aborted ? 'abort-signal' : 'unknown-termination';
      const label = resultStatus === 'error' ? 'interrupted' : resultStatus;
      const partialStdout = stripAnsi(stdout);
      const partialStderr = stripAnsi(stderr);
      // 强制终止前 stderr 也可能已有有效诊断；保留它，不改既有 137 原因/状态映射。
      const partial = partialStderr.trim()
        ? combineOutput(partialStdout, partialStderr)
        : partialStdout;
      const text = withTerminalDiagnostics(
        partial ? `[${label}] partial output:\n${partial}` : `[command ${label}]`,
        diagnostics
      );
      return finish(
        ok(
          text,
          terminalMeta(
            {
              durationMs: Date.now() - startMs,
              tokensEstimate: estimateTokens(text),
              degraded: true,
              resultStatus,
              diagnosticWarnings: [
                {
                  code: 'terminal_execution_interrupted',
                  // 带上生效 timeout：模型把秒当毫秒（如 timeout:60）时能从诊断里认出是自己的参数。
                  message: `exitCode=137; status=${resultStatus}; reason=${reason}; output=partial; timeoutMs=${timeout}`,
                  stage: 'terminal.exec',
                  tool: 'terminal',
                },
                ...sideWarnings,
              ],
            },
            diagnostics,
            intent
          )
        ),
        auditFailure('interrupted', resultStatus)
      );
    }

    // 前缀与诊断后缀先定下来，压缩预算才能为它们预留余量（I11）。
    const prefix = exitCode === 0 ? '' : `[exit ${exitCode}]\n`;
    const suffix = terminalDiagnosticSuffix(diagnostics);
    const compression = await compressOutput(
      combineOutput(stdout, stderr),
      command,
      ctx,
      resolveCompressorBudget(ctx, `${prefix}${suffix}`)
    );
    const durationMs = Date.now() - startMs;
    const text = `${prefix}${compression.text}${suffix}`;
    const warningsForResult = [...compression.warnings, ...sideWarnings];
    return finish(
      ok(
        text,
        terminalMeta(
          {
            tokensEstimate: estimateTokens(text),
            durationMs,
            ...(exitCode !== 0 ? { resultStatus: 'error' } : {}),
            ...(compression.degraded ? { degraded: true } : {}),
            ...(compression.fallbackUsed ? { fallbackUsed: true } : {}),
            ...(warningsForResult.length > 0 ? { diagnosticWarnings: warningsForResult } : {}),
          },
          diagnostics,
          intent
        )
      ),
      exitCode === 0 ? AUDIT_SUCCESS : auditFailure('exit', exitCode)
    );
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : 'Command failed';
    const resultStatus = terminalFailureStatus(ctx.abortSignal);
    const failure = isRecord(err) ? err : {};
    const stdout = typeof failure.stdout === 'string' ? stripAnsi(failure.stdout) : '';
    const stderr = typeof failure.stderr === 'string' ? stripAnsi(failure.stderr) : '';
    const partial = stdout.trim() || stderr.trim() ? `\n\n${combineOutput(stdout, stderr)}` : '';
    const text = `[${resultStatus === 'error' ? 'exit 1' : resultStatus}]\n${msg}${partial}`;
    // executor 已被调用：保留旧 ok 和已观察输出，由明确终态阻止观察层把失败计为成功。
    return finish(
      ok(text, {
        tokensEstimate: estimateTokens(text),
        durationMs,
        resultStatus,
        degraded: true,
        diagnosticWarnings: [
          {
            code: 'terminal_execution_failed',
            message: `Executor threw after invocation; status=${resultStatus}; captured output retained.`,
            stage: 'terminal.exec',
            tool: 'terminal',
          },
          ...inputWarnings,
        ],
      }),
      auditFailure('executor-threw', resultStatus)
    );
  }
}

/**
 * 审计结局：成功不带 error；失败带稳定分类码（L4-P12 / I35）。
 * 分类码 = 固定前缀 + 规则 id / 状态码 / 退出码，宿主 AuditStore 的 error_message 可按前缀统计，
 * 区分参数无效、安全拦截、allowlist 拦截、缺沙箱、非零退出、强杀中断与执行器抛错。
 */
type TerminalAuditOutcome = { result: 'success' } | { result: 'failure'; error: string };

type TerminalAuditKind =
  | 'invalid'
  | 'blocked'
  | 'blocked-allowlist'
  | 'exit'
  | 'interrupted'
  | 'executor-threw';

const AUDIT_SUCCESS: TerminalAuditOutcome = { result: 'success' };

/**
 * 只接受受限字符集的细节（规则 id、状态码、整数退出码）：规则 id 来自 terminalSafety 的静态常量，
 * 这里再守一道，任何不符合的取值记为 unknown，保证审计里永远不会出现命令片段或拦截原因文本。
 */
function auditFailure(kind: TerminalAuditKind, detail: string | number): TerminalAuditOutcome {
  const text = String(detail);
  return { result: 'failure', error: `${kind}:${SAFE_TOKEN_RE.test(text) ? text : 'unknown'}` };
}

/**
 * 归一模型传入的 timeout（L4-P12 / I19）。
 * - 未提供：默认 30000，不报诊断；
 * - 有限且 >= 1 的数：向下取整（plain exec 的 Node 校验只接受整数），超过 120000 时夹到上限并记 debug；
 * - 其他（负数、0、小于 1ms 的小数、NaN、Infinity、绕过 schema 的非数值）：回落 30000，返回
 *   terminal_timeout_normalized 诊断并记 warn。数值原样写进诊断；非数值只写类型，不回显模型文本。
 * 本次不在 registry schema 上加 minimum/maximum（决策：handler 归一比 Ajv 拒绝少耗一轮）。
 */
function normalizeTerminalTimeout(raw: unknown): {
  timeout: number;
  warning?: ToolDiagnosticWarning;
} {
  if (raw === undefined) {
    return { timeout: DEFAULT_TIMEOUT_MS };
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
    const requested = Math.floor(raw);
    if (requested > MAX_TIMEOUT_MS) {
      observeSafely(
        () =>
          Logger.getInstance().debug(
            `[terminal.exec] timeout=${requested} exceeds max ${MAX_TIMEOUT_MS}; path=clamped`
          ),
        () => undefined
      );
      return { timeout: MAX_TIMEOUT_MS };
    }
    return { timeout: requested };
  }
  const shown = typeof raw === 'number' ? `${String(raw)} (number)` : `<${describeType(raw)}>`;
  const message = `timeout=${shown} is not a finite number of milliseconds >= 1; using default ${DEFAULT_TIMEOUT_MS}`;
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[terminal.exec] terminal_timeout_normalized ${message}; path=default-timeout`
      ),
    () => undefined
  );
  return {
    timeout: DEFAULT_TIMEOUT_MS,
    warning: {
      code: 'terminal_timeout_normalized',
      message,
      stage: 'terminal.exec',
      tool: 'terminal',
    },
  };
}

/**
 * 执行器失败/137 强杀后的终态归类：signal 未中止 → error（真实失败或来源不明的强杀）；
 * 已中止时按 isDeadlineAbort 区分期限（runOperation 运行/阶段期限或 AbortSignal.timeout → timeout）
 * 与用户/宿主取消（→ aborted）。归类结果写入回执 resultStatus 与输出标签，137 与执行器抛错两条路径共用。
 */
function terminalFailureStatus(signal?: AbortSignal): 'error' | 'aborted' | 'timeout' {
  if (!signal?.aborted) {
    return 'error';
  }
  return isDeadlineAbort(signal) ? 'timeout' : 'aborted';
}

/**
 * 调用执行器，并在它 settle 之后（finally）推进 code.search 的缓存代数（L4-P15 / I05）。
 * 放在 settle 之后而不是调用之前：执行期间并发的 code.search 以旧代数写入的条目，也会在这里一并失效。
 * outcome 只记退出码或抛错的错误类名，不含命令原文、路径或输出；失效日志由 invalidateSearchCache 输出，
 * 日志失败不影响执行结果。
 */
async function execAndInvalidateSearchCache(
  command: string,
  cwd: string,
  timeout: number,
  ctx: ToolContext,
  intent: TerminalExecIntent | undefined
): Promise<TerminalExecutionResult> {
  // 默认值只在 finally 前既没返回也没进 catch 时生效（理论上不可达），仍保证日志有确定取值。
  let outcome = 'unknown';
  try {
    const result = await execInSandboxOrDirect(command, cwd, timeout, ctx, intent);
    outcome = `exit=${result.exitCode}`;
    return result;
  } catch (err: unknown) {
    outcome = `executor-threw:${errorNameOf(err)}`;
    throw err;
  } finally {
    invalidateSearchCache(ctx.searchCache, 'terminal.exec', outcome);
  }
}

/**
 * 优先使用 Seatbelt 沙箱执行；没有可调用的 exec 时只有调用方已通过显式许可检查才会走到 plain exec。
 *
 * ctx.sandboxExecutor 由 ToolContextFactory 从 DI 容器注入，
 * 类型为 { exec(cmd, opts): Promise<{stdout,stderr,exitCode}> }；opts 带 cwd/projectRoot/timeout/signal，
 * 当前能力声明了隔离意图时再带可选的 intent（来源与合并规则见 resolveTerminalIntent）。
 * plain exec 降级路径没有沙箱可以承接 intent，由 terminalMeta 报 terminal_intent_not_enforced。
 *
 * 两条路径的产出都先归一再进入核心流程（L4-P12 / I35）：宿主执行器可能是 JS 接线、返回值不保证符合
 * 类型声明；plain exec 的子进程错误 code 可能是字符串（ENOENT、ERR_CHILD_PROCESS_STDIO_MAXBUFFER）。
 * 归一发生时在 warnings 里带诊断并记 warn，exitCode 永远是整数。
 */
async function execInSandboxOrDirect(
  command: string,
  cwd: string,
  timeout: number,
  ctx: ToolContext,
  intent: TerminalExecIntent | undefined
): Promise<TerminalExecutionResult> {
  const executor = ctx.sandboxExecutor;
  if (isSandboxExecutor(executor)) {
    // intent 只在有可识别取值时出现：没有声明时 opts 与旧版完全一致，旧宿主不读它时行为也不变。
    const raw: unknown = await executor.exec(command, {
      cwd,
      projectRoot: ctx.projectRoot,
      timeout,
      signal: ctx.abortSignal,
      ...(intent ? { intent } : {}),
    });
    return normalizeExecutorResult(raw);
  }

  // 降级: plain exec（没有可调用的 sandboxExecutor.exec，且调用方已确认 allowUnsandboxedTerminal === true）。
  // degradeReason 区分“未注入”和“注入了但没有 exec”，结果文本与 terminal_sandbox_fallback 诊断都会带出它。
  const diagnostics = {
    sandboxed: false,
    fallbackUsed: true,
    degradeReason: executor ? SANDBOX_INVALID_REASON : SANDBOX_FALLBACK_REASON,
  };
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      signal: ctx.abortSignal,
    });
    return { stdout, stderr, exitCode: 0, diagnostics, warnings: [] };
  } catch (err: unknown) {
    const failure = isRecord(err) ? err : {};
    const stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    if (failure.killed === true || ctx.abortSignal?.aborted) {
      return { stdout, stderr, exitCode: 137, diagnostics, warnings: [] };
    }
    if (typeof failure.code === 'number' && Number.isInteger(failure.code)) {
      return { stdout, stderr, exitCode: failure.code, diagnostics, warnings: [] };
    }
    // 没有数值退出码：字符串 code 是 Node 的错误类别（maxBuffer 超限、cwd 不存在、参数越界），
    // null 通常意味着进程被外部信号结束。都不是进程退出码，报告为 1 并把真实 code/signal 写进诊断。
    const code =
      typeof failure.code === 'string' ? safeToken(failure.code) : describeType(failure.code);
    const signal =
      typeof failure.signal === 'string' ? `; signal=${safeToken(failure.signal)}` : '';
    const message = `plain exec failed without a numeric exit code (code=${code}${signal}); reported exitCode=1`;
    observeSafely(
      () =>
        Logger.getInstance().warn(
          `[terminal.exec] terminal_exit_code_normalized ${message}; path=exit-1`
        ),
      () => undefined
    );
    return {
      stdout,
      stderr,
      exitCode: 1,
      diagnostics,
      warnings: [
        {
          code: 'terminal_exit_code_normalized',
          message,
          stage: 'terminal.exec',
          tool: 'terminal',
        },
      ],
    };
  }
}

/**
 * 归一宿主执行器的返回值：stdout/stderr 不是字符串时按空输出处理，exitCode 不是整数时按 1（失败）处理，
 * 返回值本身不是对象时三者都取兜底值。不把可疑的 '0' 之类取值猜成成功：执行结果无法确认时宁可报失败。
 * diagnostics 交给 normalizeTerminalDiagnostics 逐字段校验。任一字段被归一都追加
 * terminal_executor_result_normalized（只含字段名与类型），并记 warn。
 */
function normalizeExecutorResult(raw: unknown): TerminalExecutionResult {
  const sandboxFallback: TerminalExecutionDiagnostics = { sandboxed: true, fallbackUsed: false };
  const issues: string[] = [];
  let stdout = '';
  let stderr = '';
  let exitCode = 1;
  let diagnostics = sandboxFallback;
  if (isRecord(raw)) {
    if (typeof raw.stdout === 'string') {
      stdout = raw.stdout;
    } else {
      issues.push(`stdout=${describeType(raw.stdout)}`);
    }
    if (typeof raw.stderr === 'string') {
      stderr = raw.stderr;
    } else {
      issues.push(`stderr=${describeType(raw.stderr)}`);
    }
    if (typeof raw.exitCode === 'number' && Number.isInteger(raw.exitCode)) {
      exitCode = raw.exitCode;
    } else {
      issues.push(`exitCode=${describeType(raw.exitCode)}`);
    }
    diagnostics = normalizeTerminalDiagnostics(raw.diagnostics, sandboxFallback);
  } else {
    issues.push(`result=${describeType(raw)}`);
  }
  if (issues.length === 0) {
    return { stdout, stderr, exitCode, diagnostics, warnings: [] };
  }
  const message =
    `sandbox executor returned malformed fields: ${issues.join(' ')}; ` +
    'missing output treated as empty, non-integer exitCode treated as 1';
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[terminal.exec] terminal_executor_result_normalized ${message}; exitCode=${exitCode}`
      ),
    () => undefined
  );
  return {
    stdout,
    stderr,
    exitCode,
    diagnostics,
    warnings: [
      {
        code: 'terminal_executor_result_normalized',
        message,
        stage: 'terminal.exec',
        tool: 'terminal',
      },
    ],
  };
}

interface TerminalExecutionDiagnostics {
  sandboxed: boolean;
  fallbackUsed: boolean;
  degradeReason?: string;
}

interface TerminalExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  diagnostics: TerminalExecutionDiagnostics;
  /** 执行阶段产生的归一诊断（执行器返回值、plain exec 非数值 code）；没有时为空数组。 */
  warnings: ToolDiagnosticWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** 诊断里描述取值类型：null 单列，其余用 typeof；不输出取值本身，避免回显宿主或模型给出的文本。 */
function describeType(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

/** 受限字符集之外的取值（可能夹带命令或输出片段）一律写成 unknown。 */
function safeToken(value: string): string {
  return SAFE_TOKEN_RE.test(value) ? value : 'unknown';
}

/** 只取错误类名（受限字符集），不取异常消息——消息可能拼进了命令或输出原文。 */
function errorNameOf(err: unknown): string {
  return safeToken(err instanceof Error ? err.name : describeType(err));
}

/** 只按 exec 方法存在性认定执行器；与 availability.ts 的 hasMethod(sandboxExecutor, 'exec') 对齐。 */
function isSandboxExecutor(value: unknown): value is SandboxExecutorLike {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { exec?: unknown }).exec === 'function'
  );
}

/**
 * 交给宿主执行端口的隔离意图，取值集合与 kernel TerminalCommandAllowlist.intent 相同。
 * 宿主可读取它来选择沙箱 profile；读不读、怎么落地归宿主（当前 Alembic SandboxExecutorBridge
 * 尚未读取，仍固定可写项目目录 profile，跨仓改造待派发）。
 */
type TerminalExecIntent = NonNullable<TerminalCommandAllowlist['intent']>;

interface SandboxExecutorLike {
  exec(
    command: string,
    opts: {
      cwd: string;
      projectRoot: string;
      timeout: number;
      signal?: AbortSignal;
      /** 可选：capability 声明的隔离意图；未声明时不出现该键。 */
      intent?: TerminalExecIntent;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    diagnostics?: Partial<TerminalExecutionDiagnostics>;
  }>;
}

function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout?.trim()) {
    // Git porcelain 等协议把前导空格作为字段；只清理展示尾部，不破坏首行列位。
    parts.push(stdout.trimEnd());
  }
  if (stderr?.trim()) {
    parts.push(`[stderr]\n${stderr.trimEnd()}`);
  }
  return parts.join('\n\n') || '[no output]';
}

/**
 * cwd 根约束只委托 resolveProjectPath（L1-P7 / L1-I5）：它先做双根词法预检查（项目根或其 realpath），
 * 再以 realpath 包含检查为唯一放行权威。这里不再保留单根词法检查：返回给执行端口的 cwd 是 realpath，
 * 项目根是 symlink 时模型原样回传该 cwd 会被单根检查误判越界并反复重试。
 * 越界、根外 symlink、悬空 symlink 的拒绝原因都来自 resolveProjectPath 的错误文本，统一拼在
 * `cwd must be within project root: <root>; ` 之后，经 handleExec 的 finish(..., 'failure') 进入审计。
 */
function resolveTerminalCwd(
  rawCwd: unknown,
  projectRoot: string
): { ok: true; cwd: string } | { ok: false; error: string } {
  const root = path.resolve(projectRoot);
  // 未提供 cwd 时解析项目根自身；相对 cwd 按项目根解析、绝对 cwd 原样参与检查，与旧实现一致。
  const requested = typeof rawCwd === 'string' && rawCwd.length > 0 ? rawCwd : '.';
  try {
    return { ok: true, cwd: resolveProjectPath(root, requested).absolute };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `cwd must be within project root: ${root}; ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 把执行诊断并入结果元信息。
 * - fallbackUsed：追加 terminal_sandbox_fallback（既有行为）。
 * - 声明了 intent 但命令没有进沙箱（sandboxed=false，宿主降级或 plain exec）：追加
 *   terminal_intent_not_enforced，写明声明的取值与降级原因。沙箱内执行时 Agent 无法得知宿主
 *   是否按 intent 选了 profile，不追加任何诊断，保持“宿主不读 intent 时行为不变”。
 */
function terminalMeta(
  base: Partial<ToolResultMeta>,
  diagnostics: TerminalExecutionDiagnostics,
  intent?: TerminalExecIntent
): Partial<ToolResultMeta> {
  // 命令没有进沙箱时声明的 intent 必然没有生效；sandboxed=true 时无从得知宿主是否采用，不报。
  const unenforcedIntent = intent !== undefined && !diagnostics.sandboxed ? intent : undefined;
  if (!diagnostics.fallbackUsed && unenforcedIntent === undefined) {
    return base;
  }
  return {
    ...base,
    ...(diagnostics.fallbackUsed ? { fallbackUsed: true } : {}),
    diagnosticWarnings: [
      ...(base.diagnosticWarnings ?? []),
      ...(diagnostics.fallbackUsed
        ? [
            {
              code: 'terminal_sandbox_fallback',
              message: formatTerminalDiagnostic(diagnostics),
              stage: 'terminal.exec',
              tool: 'terminal',
            },
          ]
        : []),
      ...(unenforcedIntent !== undefined
        ? [
            {
              code: 'terminal_intent_not_enforced',
              message:
                `declared intent ${formatTerminalIntent(unenforcedIntent)} was not applied: ` +
                `command ran unsandboxed (degradeReason=${diagnostics.degradeReason ?? 'unknown'})`,
              stage: 'terminal.exec',
              tool: 'terminal',
            },
          ]
        : []),
    ],
  };
}

/**
 * 把当前能力声明的隔离意图归一化成交给宿主的 exec opts.intent（L4-P38 / I47）。
 * 两个来源按 kernel mergeTerminalIntents 的同一规则合并（按维度取最严格值，任何来源都不能放宽另一个）：
 * - ctx.runtime.terminalIntent：生产链路。宿主构造的 ToolRouterAdapter 不带 capability，由
 *   runtimeBridge 从 loopCtx.capabilities 投影到 request.runtime，adapter 再把 runtime 并入 ctx。
 * - ctx.commandAllowlist.intent：带 capability 的 ToolRouter 注入的 allowlist。
 * 两者都可能来自用 JS 接线的宿主：无法识别的字段或取值一律丢弃并打 warn（含来源、字段、取值），
 * 不把它猜成更宽或更严的 profile。合并结果每次都是新对象，宿主改动它不会回写能力常量；没有任何
 * 可识别取值时返回 undefined，exec opts 不出现 intent 键，与旧版一致。
 * 这里只做透传前的校验；网络与文件系统隔离是否生效由宿主沙箱决定。
 */
function resolveTerminalIntent(ctx: ToolContext): TerminalExecIntent | undefined {
  const { intent, ignored } = mergeTerminalIntents([
    { source: 'runtime.terminalIntent', intent: ctx.runtime?.terminalIntent },
    { source: 'commandAllowlist', intent: ctx.commandAllowlist?.intent },
  ]);
  for (const entry of ignored) {
    Logger.getInstance().warn(
      `[terminal.exec] terminal intent value ignored: ${entry}; only network:'none' and filesystem:'read-only' are forwarded to the sandbox executor`
    );
  }
  return intent;
}

function formatTerminalIntent(intent: TerminalExecIntent): string {
  return [
    ...(intent.network !== undefined ? [`network=${intent.network}`] : []),
    ...(intent.filesystem !== undefined ? [`filesystem=${intent.filesystem}`] : []),
  ].join(' ');
}

function withTerminalDiagnostics(text: string, diagnostics: TerminalExecutionDiagnostics): string {
  return `${text}${terminalDiagnosticSuffix(diagnostics)}`;
}

/**
 * 命令没有在沙箱内执行时追加到模型可见文本末尾的说明；沙箱内执行时为空串。
 * 单独抽出是为了在压缩前就知道后缀长度，为它预留压缩预算（见 resolveCompressorBudget）。
 */
function terminalDiagnosticSuffix(diagnostics: TerminalExecutionDiagnostics): string {
  if (!diagnostics.fallbackUsed && diagnostics.sandboxed) {
    return '';
  }
  const reason = diagnostics.degradeReason ?? 'unknown';
  return `\n\n[unsandboxed:${reason}] ${formatTerminalDiagnostic(diagnostics)}`;
}

/** 宿主执行器回报的 diagnostics 逐字段校验；不是对象或字段类型不符时取 fallback 的对应值。 */
function normalizeTerminalDiagnostics(
  diagnostics: unknown,
  fallback: TerminalExecutionDiagnostics
): TerminalExecutionDiagnostics {
  if (!isRecord(diagnostics)) {
    return fallback;
  }
  return {
    sandboxed:
      typeof diagnostics.sandboxed === 'boolean' ? diagnostics.sandboxed : fallback.sandboxed,
    fallbackUsed:
      typeof diagnostics.fallbackUsed === 'boolean'
        ? diagnostics.fallbackUsed
        : fallback.fallbackUsed,
    ...(typeof diagnostics.degradeReason === 'string'
      ? { degradeReason: diagnostics.degradeReason }
      : fallback.degradeReason
        ? { degradeReason: fallback.degradeReason }
        : {}),
  };
}

function formatTerminalDiagnostic(diagnostics: TerminalExecutionDiagnostics): string {
  return [
    `sandboxed=${String(diagnostics.sandboxed)}`,
    `fallbackUsed=${String(diagnostics.fallbackUsed)}`,
    `degradeReason=${diagnostics.degradeReason ?? 'none'}`,
  ].join(' ');
}

function buildTerminalAuditEntry(
  ctx: ToolContext,
  input: TerminalAuditOutcome & { duration: number; commandHash: string }
): ToolAuditEntry {
  return {
    actor: typeof ctx.runtime?.agentId === 'string' ? ctx.runtime.agentId : 'alembic-agent',
    action: 'terminal.exec',
    resource: 'terminal.exec',
    result: input.result,
    // 稳定分类码而非固定的 'terminal.exec failed'：只含规则 id / 状态码，见 auditFailure。
    ...(input.result === 'failure' ? { error: input.error } : {}),
    duration: input.duration,
    data: { commandHash: input.commandHash },
    context: {
      surface: 'runtime',
      source: 'alembic-agent',
      ...(typeof ctx.runtime?.presetName === 'string'
        ? { presetName: ctx.runtime.presetName }
        : {}),
      ...(typeof ctx.runtime?.iteration === 'number' ? { iteration: ctx.runtime.iteration } : {}),
    },
  };
}

/**
 * 审计写入失败不能改变终端工具结果，但也不能静默丢条目：记一条 warn，只带命令哈希、结果、
 * 分类码与错误类名（错误消息可能拼进了命令原文，不记）。
 */
async function recordTerminalAudit(ctx: ToolContext, entry: ToolAuditEntry): Promise<void> {
  const sink = ctx.auditSink;
  if (!sink || typeof sink.log !== 'function') {
    return;
  }
  try {
    await Promise.resolve(sink.log(entry));
  } catch (err: unknown) {
    observeSafely(
      () =>
        Logger.getInstance().warn(
          `[terminal.exec] audit sink failed; commandHash=${entry.data.commandHash}; ` +
            `result=${entry.result}; auditError=${entry.error ?? 'none'}; error=${errorNameOf(err)}; ` +
            'path=entry-dropped'
        ),
      () => undefined
    );
  }
}

function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

/**
 * 交给压缩器的预算拆解，写进 terminal_output_compressed 诊断，便于核对是哪一项决定了截断位置。
 * - hostBudget：宿主给本次调用的 ctx.tokenBudget（生产默认 8000）；
 * - actionLimit：当前 registry 视图里 terminal.exec 的 maxOutputTokens（router 最终按它兜底截断）；
 * - reserve：'[exit N]' 前缀与 unsandboxed 诊断后缀按 shared 口径估算的 token；
 * - tokens：min(hostBudget, actionLimit) - reserve，至少为 1。
 */
interface CompressorBudget {
  tokens: number;
  hostBudget: number;
  actionLimit: number | undefined;
  reserve: number;
}

/**
 * 计算压缩器预算（L4-P12 / I11），与 code.search 的 min(ctx.tokenBudget, action.maxOutputTokens) 同一写法。
 * 旧实现只把 ctx.tokenBudget 交给压缩器：宿主 8000 时压缩器按 32000 字符截断，router 再按 4000 token
 * 截一次，压缩器保留的尾部（测试摘要、[stderr] 段）大多被切掉。前缀/后缀按 shared 估算向上取整，
 * 各段估算之和不小于整体估算，所以压缩结果只要不超过 tokens，拼上前后缀后 ASCII 输出不会触发 router。
 * handler 被直接调用（没有 registry 视图）时 actionLimit 缺失，只按宿主预算压缩，与旧行为一致。
 */
function resolveCompressorBudget(ctx: ToolContext, framing: string): CompressorBudget {
  const hostBudget = resolveHostTokenBudget(ctx.tokenBudget);
  const rawLimit = ctx.toolRegistry?.terminal?.actions.exec?.maxOutputTokens;
  const actionLimit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.floor(rawLimit)
      : undefined;
  const cap = Math.min(hostBudget, actionLimit ?? Number.POSITIVE_INFINITY);
  const reserve = estimateTokens(framing);
  const available = cap - reserve;
  if (available < 1) {
    // 前后缀本身就占满了预算（只会出现在极小预算上）：压缩器拿最小预算，超出部分由 router 兜底截断。
    observeSafely(
      () =>
        Logger.getInstance().warn(
          `[terminal.exec] compressor budget exhausted by framing; cap=${cap}; reserve=${reserve}; ` +
            'path=minimal-budget; router enforces the action limit'
        ),
      () => undefined
    );
  }
  return { tokens: Math.max(1, available), hostBudget, actionLimit, reserve };
}

/**
 * 宿主预算归一：沿用旧的 `ctx.tokenBudget || 4000` 口径，并补上负数、NaN、小于 1 的值——
 * 这些取值进入 min/减法后会变成非法预算。Infinity 视为“不限”，保留原样。
 */
function resolveHostTokenBudget(value: unknown): number {
  if (typeof value === 'number' && value >= 1) {
    return Math.floor(value);
  }
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[terminal.exec] ctx.tokenBudget=${typeof value === 'number' ? String(value) : `<${describeType(value)}>`} ` +
          `is not a usable token budget; path=default-budget; budget=${DEFAULT_COMPRESSOR_TOKEN_BUDGET}`
      ),
    () => undefined
  );
  return DEFAULT_COMPRESSOR_TOKEN_BUDGET;
}

interface CompressionOutcome {
  text: string;
  /** 原始输出超出压缩预算：模型看到的是摘要/折叠/截断后的有损视图。 */
  degraded: boolean;
  /** 压缩器抛错或返回非字符串，退回了去 ANSI 的原始输出。 */
  fallbackUsed: boolean;
  warnings: ToolDiagnosticWarning[];
}

/**
 * 压缩终端输出。三条路径：
 * - 压缩器正常返回：原始输出（去 ANSI 后）超出字符预算时，结果必然是有损视图，标 degraded 并追加
 *   terminal_output_compressed（只含计数与预算拆解），替代原本由 router 截断给出的 degraded 信号；
 * - 压缩器抛错或返回非字符串：退回去 ANSI 的原始输出，标 fallbackUsed、追加 terminal_compressor_failed
 *   并记 warn（只含错误类名，不含消息与输出原文）；超限部分由 router 兜底截断；
 * - 没有注入压缩器：直接去 ANSI，超限部分由 router 兜底截断（旧行为）。
 */
async function compressOutput(
  raw: string,
  command: string,
  ctx: ToolContext,
  budget: CompressorBudget
): Promise<CompressionOutcome> {
  const plain = stripAnsi(raw);
  if (!raw || !ctx.compressor) {
    return { text: plain, degraded: false, fallbackUsed: false, warnings: [] };
  }

  let failure: string;
  try {
    const result: unknown = await Promise.resolve(
      ctx.compressor.compress(raw, { command, tokenBudget: budget.tokens })
    );
    if (typeof result === 'string') {
      const budgetChars = budget.tokens * COMPRESSOR_CHARS_PER_TOKEN;
      if (plain.length <= budgetChars) {
        return { text: result, degraded: false, fallbackUsed: false, warnings: [] };
      }
      return {
        text: result,
        degraded: true,
        fallbackUsed: false,
        warnings: [
          {
            code: 'terminal_output_compressed',
            message:
              `rawChars=${plain.length} exceeded compressor budget ${budgetChars} chars ` +
              `(tokenBudget=${budget.tokens}: hostBudget=${budget.hostBudget} ` +
              `actionLimit=${budget.actionLimit ?? 'none'} reserve=${budget.reserve}); ` +
              `compressedChars=${result.length}`,
            stage: 'terminal.exec',
            tool: 'terminal',
          },
        ],
      };
    }
    failure = `compressor returned ${describeType(result)}`;
  } catch (err: unknown) {
    failure = `compressor threw ${errorNameOf(err)}`;
  }

  const message = `${failure}; returned ANSI-stripped raw output`;
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[terminal.exec] terminal_compressor_failed ${message}; rawChars=${plain.length}; ` +
          `tokenBudget=${budget.tokens}; path=raw-output`
      ),
    () => undefined
  );
  return {
    text: plain,
    degraded: false,
    fallbackUsed: true,
    warnings: [
      { code: 'terminal_compressor_failed', message, stage: 'terminal.exec', tool: 'terminal' },
    ],
  };
}
