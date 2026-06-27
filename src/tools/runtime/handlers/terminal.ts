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
import { checkTerminalCommandSafety } from './terminalSafety.js';

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

  try {
    const { stdout, stderr, exitCode, diagnostics } = await execInSandboxOrDirect(
      command,
      cwd,
      timeout,
      ctx
    );

    const rawOutput = combineOutput(stdout, stderr);
    const compressed = await compressOutput(rawOutput, command, ctx);
    const durationMs = Date.now() - startMs;

    if (exitCode === 137) {
      const partial = stripAnsi(stdout);
      const text = withTerminalDiagnostics(
        partial ? `[timeout] partial output:\n${partial}` : '[command timed out or aborted]',
        diagnostics
      );
      // SIGKILL/timeout — the command was cut off, so this output is partial.
      return finish(
        ok(
          text,
          terminalMeta(
            { durationMs, tokensEstimate: estimateTokens(text), degraded: true },
            diagnostics
          )
        ),
        'failure'
      );
    }

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
          },
          diagnostics
        )
      ),
      exitCode === 0 ? 'success' : 'failure'
    );
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : 'Command failed';
    const text = `[exit 1]\n${msg}`;
    return finish(ok(text, { tokensEstimate: estimateTokens(text), durationMs }), 'failure');
  }
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
      diagnostics: { sandboxed: true, fallbackUsed: false },
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
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout?.trim()) {
    parts.push(stdout.trim());
  }
  if (stderr?.trim()) {
    parts.push(`[stderr]\n${stderr.trim()}`);
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
  return { ok: true, cwd };
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
  return `${text}\n\n[terminal diagnostic] ${formatTerminalDiagnostic(diagnostics)}`;
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
