/**
 * @module tools/runtime/handlers/terminal
 *
 * 终端执行工具 — 在 Seatbelt 沙箱中执行命令，返回结构化压缩输出。
 * Actions: exec
 *
 * 执行流程: cwd 校验 → 危险命令预检 → capability allowlist（注入时）→ 执行器 fail-closed 判定
 *           → Seatbelt 沙箱执行 → OutputCompressor 压缩
 *           ctx.tokenBudget 只作为压缩器自身的预算交给 compressor；按 action.maxOutputTokens 的最终
 *           截断由 router.enforceOutputLimit 在本 handler 返回后执行，不属于本流程。
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
 */

import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import Logger from '@alembic/core/logging';
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
  type ToolResult,
  type ToolResultMeta,
} from '#tools/kernel/registry.js';
import { stripAnsi } from '../compressor/strip.js';
import { checkTerminalCommandAllowlist, checkTerminalCommandSafety } from './terminalSafety.js';

const execAsync = promisify(exec);
const SANDBOX_FALLBACK_REASON = 'missing_sandbox_executor';
/** 宿主注入了 sandboxExecutor 但它没有可调用的 exec：与“未注入”区分，便于定位接线错误。 */
const SANDBOX_INVALID_REASON = 'sandbox_executor_missing_exec';
const SANDBOX_REQUIRED_MESSAGE =
  'Terminal execution unavailable: no sandbox executor is configured for this host. ' +
  'Continue with code/graph/knowledge tools instead.';

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
  const finish = async (result: ToolResult, auditResult: ToolAuditEntry['result']) => {
    await recordTerminalAudit(
      ctx,
      buildTerminalAuditEntry(ctx, {
        result: auditResult,
        duration: result._meta?.durationMs ?? Date.now() - startMs,
        commandHash,
      })
    );
    return result;
  };

  if (!command) {
    return finish(fail('terminal.exec requires command'), 'failure');
  }

  const cwdResult = resolveTerminalCwd(params.cwd, ctx.projectRoot);
  if (!cwdResult.ok) {
    return finish(fail(cwdResult.error), 'failure');
  }
  const cwd = cwdResult.cwd;

  const timeout = Math.min((params.timeout as number) || 30000, 120000);

  const securityCheck = checkTerminalCommandSafety(command);
  if (!securityCheck.safe) {
    return finish(
      fail(`Command blocked: ${securityCheck.block.reason} (${securityCheck.block.rule})`),
      'failure'
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
      'failure'
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
      'failure'
    );
  }

  // 只在命令已通过安全与 allowlist 检查、确定要交给执行器时才归一化 intent：被拒绝的命令
  // 不会触达宿主，也就不需要为它的 intent 打日志。
  const intent = resolveTerminalIntent(ctx);

  try {
    const { stdout, stderr, exitCode, diagnostics } = await execInSandboxOrDirect(
      command,
      cwd,
      timeout,
      ctx,
      intent
    );

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
                  message: `exitCode=137; status=${resultStatus}; reason=${reason}; output=partial`,
                  stage: 'terminal.exec',
                  tool: 'terminal',
                },
              ],
            },
            diagnostics,
            intent
          )
        ),
        'failure'
      );
    }

    const compressed = await compressOutput(combineOutput(stdout, stderr), command, ctx);
    const durationMs = Date.now() - startMs;
    const text = withTerminalDiagnostics(
      exitCode === 0 ? compressed : `[exit ${exitCode}]\n${compressed}`,
      diagnostics
    );
    return finish(
      ok(
        text,
        terminalMeta(
          {
            tokensEstimate: estimateTokens(text),
            durationMs,
            ...(exitCode !== 0 ? { resultStatus: 'error' } : {}),
          },
          diagnostics,
          intent
        )
      ),
      exitCode === 0 ? 'success' : 'failure'
    );
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : 'Command failed';
    const resultStatus = terminalFailureStatus(ctx.abortSignal);
    const failure = err !== null && typeof err === 'object' ? err : {};
    const stdout =
      'stdout' in failure && typeof failure.stdout === 'string' ? stripAnsi(failure.stdout) : '';
    const stderr =
      'stderr' in failure && typeof failure.stderr === 'string' ? stripAnsi(failure.stderr) : '';
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
        ],
      }),
      'failure'
    );
  }
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
 * 优先使用 Seatbelt 沙箱执行；没有可调用的 exec 时只有调用方已通过显式许可检查才会走到 plain exec。
 *
 * ctx.sandboxExecutor 由 ToolContextFactory 从 DI 容器注入，
 * 类型为 { exec(cmd, opts): Promise<{stdout,stderr,exitCode}> }；opts 带 cwd/projectRoot/timeout/signal，
 * 当前能力声明了隔离意图时再带可选的 intent（来源与合并规则见 resolveTerminalIntent）。
 * plain exec 降级路径没有沙箱可以承接 intent，由 terminalMeta 报 terminal_intent_not_enforced。
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
    const result = await executor.exec(command, {
      cwd,
      projectRoot: ctx.projectRoot,
      timeout,
      signal: ctx.abortSignal,
      ...(intent ? { intent } : {}),
    });
    return {
      ...result,
      diagnostics: normalizeTerminalDiagnostics(result.diagnostics, {
        sandboxed: true,
        fallbackUsed: false,
      }),
    };
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
    return { stdout, stderr, exitCode: 0, diagnostics };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed || ctx.abortSignal?.aborted) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: 137, diagnostics };
    }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1, diagnostics };
  }
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
  if (!diagnostics.fallbackUsed && diagnostics.sandboxed) {
    return text;
  }
  const reason = diagnostics.degradeReason ?? 'unknown';
  return `${text}\n\n[unsandboxed:${reason}] ${formatTerminalDiagnostic(diagnostics)}`;
}

function normalizeTerminalDiagnostics(
  diagnostics: Partial<TerminalExecutionDiagnostics> | undefined,
  fallback: TerminalExecutionDiagnostics
): TerminalExecutionDiagnostics {
  if (!diagnostics) {
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
  input: Pick<ToolAuditEntry, 'result' | 'duration'> & { commandHash: string }
): ToolAuditEntry {
  return {
    actor: typeof ctx.runtime?.agentId === 'string' ? ctx.runtime.agentId : 'alembic-agent',
    action: 'terminal.exec',
    resource: 'terminal.exec',
    result: input.result,
    ...(input.result === 'failure' ? { error: 'terminal.exec failed' } : {}),
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

async function recordTerminalAudit(ctx: ToolContext, entry: ToolAuditEntry): Promise<void> {
  const sink = ctx.auditSink;
  if (!sink || typeof sink.log !== 'function') {
    return;
  }
  try {
    await Promise.resolve(sink.log(entry));
  } catch {
    // Audit failures must not alter the terminal tool result.
  }
}

function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

async function compressOutput(raw: string, command: string, ctx: ToolContext): Promise<string> {
  if (!raw) {
    return raw;
  }

  if (ctx.compressor) {
    try {
      const result = await Promise.resolve(
        ctx.compressor.compress(raw, { command, tokenBudget: ctx.tokenBudget || 4000 })
      );
      return result;
    } catch {
      // compressor 失败，返回清理后的原始输出
    }
  }

  return stripAnsi(raw);
}
