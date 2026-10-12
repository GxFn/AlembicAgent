/** 通用访问边界：capability、参数大小和运行时安全策略；权限判断先于缓存和宿主调用。 */
import path from 'node:path';
import { stableStringify } from '#shared/serialization.js';
import type { TerminalCommandAllowlist } from '#tools/kernel/registry.js';
import {
  describeToolParameterDenial,
  findDeniedToolParameter,
  isToolActionAllowed,
} from '#tools/kernel/toolSelection.js';
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

const TOOL_PARAMETER_DENIED_CODE = 'TOOL_PARAMETER_DENIED';

const TOOL_POLICY_DENIED_CODE = 'TOOL_POLICY_DENIED';

/** code 工具里按文件系统路径解释的参数键；与 PolicyEngine 的 fileScope 检查收集的键一致。 */
const CODE_PATH_KEYS = ['path', 'filePath', 'directory'] as const;

/** 诊断里序列化错误原文的展示上限。 */
const MAX_SERIALIZATION_ERROR_CHARS = 200;

function measureToolArgBytes(
  call: ToolCall
): { ok: true; bytes: number } | { ok: false; reason: string } {
  try {
    const serialized = String(stableStringify(call.args) ?? '');
    return { ok: true, bytes: new TextEncoder().encode(serialized).length };
  } catch (err: unknown) {
    // BigInt、循环引用（栈溢出）、toJSON 抛错等都会落到这里；原因随诊断带出，便于区分模型参数缺陷与宿主注入问题。
    return { ok: false, reason: describeSerializationError(err) };
  }
}

function describeSerializationError(err: unknown): string {
  let text: string;
  if (err instanceof Error) {
    text = `${err.name}: ${err.message}`;
  } else {
    try {
      text = String(err);
    } catch (stringifyErr: unknown) {
      text =
        stringifyErr instanceof Error
          ? `unprintable ${typeof err} (${stringifyErr.message})`
          : `unprintable ${typeof err}`;
    }
  }
  return text.length > MAX_SERIALIZATION_ERROR_CHARS
    ? `${text.slice(0, MAX_SERIALIZATION_ERROR_CHARS)}…`
    : text;
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
    const schema = ctx.loopCtx.toolSchemas?.find((item) => item.name === call.name);
    const parameters = schema?.parameters as { required?: unknown } | undefined;
    const requiresAction =
      Array.isArray(parameters?.required) && parameters.required.includes('action');
    // 只有实际schema要求action时才拒绝省略；泛型flat工具不能被强加内置envelope语法。
    if (
      (requiresAction && !action) ||
      (action && !isActionAllowed(ctx.loopCtx, call.name, action))
    ) {
      const allowedActions = ctx.loopCtx.allowedToolActions?.[call.name] || [];
      return {
        blocked: true,
        result: {
          error: `Action "${call.name}.${action || '(missing)'}" is not available in the current stage. Allowed actions for "${call.name}": ${allowedActions.join(', ')}`,
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
        tool: call.name,
        message: `Tool ${call.name} arguments could not be serialized for validation (${measurement.reason}); the call was blocked before execution.`,
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
    const action = getToolAction(executable);
    const policy = ctx.runtime.policies.validateToolCall?.(
      executable.name,
      buildPolicyArgs(executable, params, action, ctx.runtime.projectRoot)
    );
    if (policy && !policy.ok) {
      // 运行时策略拒绝发生在宿主调度之前：日志与诊断记下工具、动作和策略原因（SafetyPolicy 的
      // 原因带规则码，如 SAFETY_FILE_SCOPE_PATH / SAFETY_FILE_SCOPE_SEARCH），端口零调用。
      const reason = policy.reason || 'Tool call denied by runtime policy';
      const label = `${executable.name}.${action || '(no action)'}`;
      ctx.runtime.logger?.warn(
        `[ToolPipeline] ⛔ ${label} denied by runtime policy — blocked before host dispatch: ${reason}`
      );
      ctx.loopCtx.diagnostics?.warn({
        code: TOOL_POLICY_DENIED_CODE,
        tool: executable.name,
        message: `Runtime policy denied ${label} before host dispatch: ${reason}`,
      });
      return {
        blocked: true,
        result: { error: reason },
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
    // 能力级参数 allowlist（L4-P29）：生产宿主构造 ToolRouterAdapter 时不传 capability，
    // router.explain 的同一检查覆盖不到生产路径，所以这里按 loopCtx.capabilities 的能力名再执行
    // 一次内部常量表（evolution_analysis 的 knowledge.manage 只开放 evolve/deprecate/skip_evolution）。
    // 拒绝发生在宿主调度之前：端口零调用，并留下含 capability/operation/id 的日志与诊断。
    for (const capability of ctx.loopCtx.capabilities ?? []) {
      const capabilityName = (capability as { name?: unknown }).name;
      if (typeof capabilityName !== 'string') {
        continue;
      }
      const denial = findDeniedToolParameter(capabilityName, executable.name, action, params);
      if (!denial) {
        continue;
      }
      const reason = describeToolParameterDenial(denial, params);
      ctx.runtime.logger.warn(`[ToolPipeline] ⛔ ${reason} — blocked before host dispatch`);
      ctx.loopCtx.diagnostics?.warn({
        code: TOOL_PARAMETER_DENIED_CODE,
        message: reason,
        tool: executable.name,
      });
      return {
        blocked: true,
        result: {
          error: reason,
          code: TOOL_PARAMETER_DENIED_CODE,
          status: 'blocked',
          capability: denial.capability,
          tool: denial.tool,
          action: denial.action,
          parameter: denial.parameter,
          value: denial.value,
          allowed: [...denial.allowed],
        },
      };
    }
    return undefined;
  },
};

/**
 * 组装交给运行时策略（PolicyEngine.validateToolCall）的参数（L5-P18 / I17）。
 *
 * 非 code 工具保持原样：params 取 getToolParams 视角。
 *
 * code 工具按 handler 真正会访问的路径构造：
 * - router.parseToolCall 只把 args.params（缺省 {}）交给 handler，平铺在顶层的键到不了 handler，
 *   所以 params 只取 args.params 对象；顶层平铺的路径键也按项目根解析后保留，策略层两处都检查，
 *   任一写法越界都拒绝（只会多拒绝，不会放过）。
 * - path / filePath / directory / filePaths 按 projectRoot 解析；`..`、`./`、尾斜杠、绝对路径都在
 *   这里规范成同一个绝对路径，再由 SafetyPolicy 做包含判断。
 * - code.structure 的 directory 缺省或为空串时 handler 列出项目根，这里把项目根写进 directory。
 * - code.search 没有路径参数，handler 恒以项目根为搜索根：directory 一律覆盖为项目根，模型自带的
 *   directory 不能把搜索根“说”进 fileScope。
 * 没有 projectRoot 时不做解析，缺省目录写成 '.'，由策略按进程 cwd 解析（与直接调用引擎一致）。
 */
function buildPolicyArgs(
  executable: ToolCall,
  params: Record<string, unknown>,
  action: string,
  projectRoot: string | undefined
): Record<string, unknown> {
  if (executable.name !== 'code') {
    return { ...executable.args, params: { ...params } };
  }
  const rawParams = executable.args.params;
  const handlerParams: Record<string, unknown> =
    rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? { ...(rawParams as Record<string, unknown>) }
      : {};
  const policyParams = resolveCodePathParams(handlerParams, projectRoot);
  const root = projectRoot ? path.resolve(projectRoot) : '.';
  const directory = handlerParams.directory;
  if (action === 'structure' && (typeof directory !== 'string' || directory.length === 0)) {
    policyParams.directory = root;
  }
  if (action === 'search') {
    policyParams.directory = root;
  }
  return { ...resolveCodePathParams(executable.args, projectRoot), params: policyParams };
}

function resolveCodePathParams(
  source: Record<string, unknown>,
  projectRoot: string | undefined
): Record<string, unknown> {
  const resolved = { ...source };
  if (!projectRoot) {
    return resolved;
  }
  for (const key of CODE_PATH_KEYS) {
    const value = resolved[key];
    if (typeof value === 'string') {
      resolved[key] = path.resolve(projectRoot, value);
    }
  }
  if (Array.isArray(resolved.filePaths)) {
    resolved.filePaths = resolved.filePaths.map((file: unknown) =>
      typeof file === 'string' ? path.resolve(projectRoot, file) : file
    );
  }
  return resolved;
}

function isActionAllowed(loopCtx: ToolLoopPort, toolName: string, actionName: string): boolean {
  const allowedNames = new Set(loopCtx?.allowedToolIds || []);
  if (!allowedNames.has(toolName)) {
    return false;
  }
  const allowedActions = Object.hasOwn(loopCtx.allowedToolActions ?? {}, toolName)
    ? loopCtx.allowedToolActions[toolName]
    : null;
  return isToolActionAllowed({ [toolName]: allowedActions }, toolName, actionName);
}
