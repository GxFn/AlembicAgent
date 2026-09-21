/**
 * @module tools/runtime/handlers/terminal
 *
 * 终端执行工具 — 在 Seatbelt 沙箱中执行命令，返回结构化压缩输出。
 * Actions: exec
 *
 * 执行流程: 安全检查 → cwd 校验 → Seatbelt 沙箱执行 → OutputCompressor 压缩 → token budget 截断
 *
 * 沙箱集成: 通过 ToolContext.sandboxExecutor 注入 SandboxExecutor，
 *           未注入时降级为 plain exec（测试/非 macOS 环境）。
 */

import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveProjectPath } from '#shared/projectPath.js';
import {
  estimateTokens,
  fail,
  ok,
  type ToolAuditEntry,
  type ToolContext,
  type ToolResult,
  type ToolResultMeta,
} from '#tools/kernel/registry.js';
import { stripAnsi } from '../compressor/strip.js';
import { checkTerminalCommandAllowlist, checkTerminalCommandSafety } from './terminalSafety.js';

const execAsync = promisify(exec);
const SANDBOX_FALLBACK_REASON = 'missing_sandbox_executor';

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

  try {
    const { stdout, stderr, exitCode, diagnostics } = await execInSandboxOrDirect(
      command,
      cwd,
      timeout,
      ctx
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
            diagnostics
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
          diagnostics
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

function terminalFailureStatus(signal?: AbortSignal): 'error' | 'aborted' | 'timeout' {
  if (!signal?.aborted) {
    return 'error';
  }
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? 'timeout'
    : 'aborted';
}

/**
 * 优先使用 Seatbelt 沙箱执行，未注入时降级为 plain exec。
 *
 * ctx.sandboxExecutor 由 ToolContextFactory 从 DI 容器注入，
 * 类型为 { exec(cmd, opts): Promise<{stdout,stderr,exitCode}> }
 */
async function execInSandboxOrDirect(
  command: string,
  cwd: string,
  timeout: number,
  ctx: ToolContext
): Promise<TerminalExecutionResult> {
  const executor = ctx.sandboxExecutor as SandboxExecutorLike | undefined;
  if (executor) {
    const result = await executor.exec(command, {
      cwd,
      projectRoot: ctx.projectRoot,
      timeout,
      signal: ctx.abortSignal,
    });
    return {
      ...result,
      diagnostics: normalizeTerminalDiagnostics(result.diagnostics, {
        sandboxed: true,
        fallbackUsed: false,
      }),
    };
  }

  // 降级: plain exec（测试环境 / sandboxExecutor 未注入）
  const diagnostics = {
    sandboxed: false,
    fallbackUsed: true,
    degradeReason: SANDBOX_FALLBACK_REASON,
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

interface SandboxExecutorLike {
  exec(
    command: string,
    opts: { cwd: string; projectRoot: string; timeout: number; signal?: AbortSignal }
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

function resolveTerminalCwd(
  rawCwd: unknown,
  projectRoot: string
): { ok: true; cwd: string } | { ok: false; error: string } {
  const root = path.resolve(projectRoot);
  const requested = typeof rawCwd === 'string' && rawCwd.length > 0 ? rawCwd : undefined;
  const cwd = requested
    ? path.resolve(path.isAbsolute(requested) ? requested : path.join(root, requested))
    : root;
  const relative = path.relative(root, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: `cwd must be within project root: ${root}` };
  }
  try {
    return { ok: true, cwd: resolveProjectPath(root, cwd).absolute };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `cwd must be within project root: ${root}; ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function terminalMeta(
  base: Partial<ToolResultMeta>,
  diagnostics: TerminalExecutionDiagnostics
): Partial<ToolResultMeta> {
  if (!diagnostics.fallbackUsed) {
    return base;
  }
  return {
    ...base,
    fallbackUsed: true,
    diagnosticWarnings: [
      ...(base.diagnosticWarnings ?? []),
      {
        code: 'terminal_sandbox_fallback',
        message: formatTerminalDiagnostic(diagnostics),
        stage: 'terminal.exec',
        tool: 'terminal',
      },
    ],
  };
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
