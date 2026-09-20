/** 通用访问边界：capability、参数大小和运行时安全策略；权限判断先于缓存和宿主调用。 */
import path from 'node:path';
import { stableStringify } from '#shared/serialization.js';
import type { TerminalCommandAllowlist } from '#tools/kernel/registry.js';
import { checkTerminalCommandAllowlist } from '#tools/runtime/handlers/terminalSafety.js';
import {
  getToolAction,
  getToolParams,
  isDirectNoteFindingCall,
  toExecutableToolCall,
} from './callNormalization.js';
import type {
  BeforeVerdict,
  ToolCall,
  ToolPipelineContext as ToolExecContext,
  ToolLoopPort,
  ToolMiddleware,
} from './contracts.js';

const MAX_TOOL_ARG_BYTES = 256_000;

const TOOL_ARGS_INVALID_CODE = 'TOOL_ARGS_INVALID';

const TOOL_ARGS_TOO_LARGE_CODE = 'TOOL_ARGS_TOO_LARGE';

function measureToolArgBytes(call: ToolCall): { ok: true; bytes: number } | { ok: false } {
  try {
    const serialized = String(stableStringify(call.args) ?? '');
    return { ok: true, bytes: new TextEncoder().encode(serialized).length };
  } catch {
    return { ok: false };
  }
}

// ─────────────────────────────────────────────
//  预置中间件
// ─────────────────────────────────────────────

/**
 * AllowlistGate — 工具白名单守卫
 *
 * 防止 LLM hallucinate 不在当前 capability 允许列表中的工具调用。
 * 从 LoopContext.allowedToolIds 中提取允许的工具名列表，
 * 拒绝不在列表中的调用（返回 error 提示）。空数组表示严格禁用所有 capability 工具。
 *
 * before: 如果工具不在白名单中则短路返回 error
 */
export const allowlistGate = {
  name: 'allowlistGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const allowedNames = new Set(ctx.loopCtx?.allowedToolIds || []);
    if (isDirectNoteFindingCall(call) && isActionAllowed(ctx.loopCtx, 'memory', 'note_finding')) {
      return undefined;
    }
    if (!allowedNames.has(call.name)) {
      ctx.runtime.logger.warn(
        `[ToolPipeline] ⛔ Tool "${call.name}" not in allowlist — blocked (hallucinated call)`
      );
      const availableTools = [...allowedNames].slice(0, 5).join(', ');
      return {
        blocked: true,
        result: {
          error:
            allowedNames.size === 0
              ? `工具 "${call.name}" 不可用。当前阶段未开放任何工具。`
              : `工具 "${call.name}" 不可用。当前可用工具: ${availableTools}${allowedNames.size > 5 ? '...' : ''}`,
        },
      };
    }
    const action = getToolAction(call);
    if (action && !isActionAllowed(ctx.loopCtx, call.name, action)) {
      const allowedActions = ctx.loopCtx.allowedToolActions?.[call.name] || [];
      return {
        blocked: true,
        result: {
          error: `Action "${call.name}.${action}" is not available in the current stage. Allowed actions for "${call.name}": ${allowedActions.join(', ')}`,
        },
      };
    }
    return undefined;
  },
};

/** ToolArgumentBoundsGate — reject oversized or unserializable model-provided tool args. */
export const toolArgumentBoundsGate = {
  name: 'toolArgumentBoundsGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const measurement = measureToolArgBytes(call);
    if (!measurement.ok) {
      ctx.loopCtx.diagnostics?.warn({
        code: TOOL_ARGS_INVALID_CODE,
        message: `Tool ${call.name} arguments could not be serialized for validation`,
      });
      return {
        blocked: true,
        result: {
          error: 'Tool arguments could not be serialized',
          code: TOOL_ARGS_INVALID_CODE,
          maxBytes: MAX_TOOL_ARG_BYTES,
        },
      };
    }
    if (measurement.bytes <= MAX_TOOL_ARG_BYTES) {
      return undefined;
    }
    ctx.loopCtx.diagnostics?.warn({
      code: TOOL_ARGS_TOO_LARGE_CODE,
      message: `Tool ${call.name} arguments exceed ${MAX_TOOL_ARG_BYTES} bytes`,
    });
    return {
      blocked: true,
      result: {
        error: `Tool arguments exceed ${MAX_TOOL_ARG_BYTES} bytes`,
        code: TOOL_ARGS_TOO_LARGE_CODE,
        sizeBytes: measurement.bytes,
        maxBytes: MAX_TOOL_ARG_BYTES,
      },
    };
  },
};

/** 宿主 router 不一定实现运行时策略；在调用宿主前执行当前 profile 的完整安全约束。 */
export const runtimeSafetyGate: ToolMiddleware<ToolExecContext> = {
  name: 'runtimeSafetyGate',
  before(call, ctx) {
    const executable = toExecutableToolCall(call);
    const params = getToolParams(executable);
    const policyParams = { ...params };
    if (executable.name === 'code' && ctx.runtime.projectRoot) {
      for (const key of ['path', 'filePath']) {
        if (typeof policyParams[key] === 'string') {
          policyParams[key] = path.resolve(ctx.runtime.projectRoot, policyParams[key]);
        }
      }
      if (Array.isArray(policyParams.filePaths)) {
        policyParams.filePaths = policyParams.filePaths.map((file) =>
          typeof file === 'string' ? path.resolve(ctx.runtime.projectRoot, file) : file
        );
      }
    }
    const policy = ctx.runtime.policies.validateToolCall?.(executable.name, {
      ...executable.args,
      params: policyParams,
    });
    if (policy && !policy.ok) {
      return {
        blocked: true,
        result: { error: policy.reason || 'Tool call denied by runtime policy' },
      };
    }
    if (executable.name === 'terminal' && typeof params.command === 'string') {
      for (const capability of ctx.loopCtx.capabilities ?? []) {
        const allowlist = (capability as { commandAllowlist?: TerminalCommandAllowlist })
          .commandAllowlist;
        if (allowlist) {
          const check = checkTerminalCommandAllowlist(params.command, allowlist.bins);
          if (!check.safe) {
            return { blocked: true, result: { error: `Command blocked: ${check.block.reason}` } };
          }
        }
      }
    }
    return undefined;
  },
};

function isActionAllowed(loopCtx: ToolLoopPort, toolName: string, actionName: string): boolean {
  const allowedNames = new Set(loopCtx?.allowedToolIds || []);
  if (!allowedNames.has(toolName)) {
    return false;
  }
  const allowedActions = loopCtx.allowedToolActions?.[toolName];
  return !allowedActions || allowedActions.includes(actionName);
}
