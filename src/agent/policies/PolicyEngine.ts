import { BudgetPolicy } from './BudgetPolicy.js';
import type { Policy, PolicyContext, PolicyResult, StepState } from './Policy.js';
import { SafetyPolicy } from './SafetyPolicy.js';

export class PolicyEngine {
  #policies;

  constructor(policies: Policy[] = []) {
    this.#policies = policies;
  }

  get policies() {
    return [...this.#policies];
  }

  get<T extends Policy>(PolicyClass: abstract new (...args: never[]) => T): T | null {
    return this.#policies.find((p): p is T => p instanceof PolicyClass) ?? null;
  }

  validateBefore(context: PolicyContext) {
    for (const policy of this.#policies) {
      const result = policy.validateBefore(context);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }

  validateDuring(stepState: StepState) {
    for (const policy of this.#policies) {
      const result = policy.validateDuring(stepState);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true, action: 'continue' };
  }

  validateAfter(result: PolicyResult) {
    for (const policy of this.#policies) {
      const val = policy.validateAfter(result);
      if (!val.ok) {
        return val;
      }
    }
    return { ok: true };
  }

  applyToConfig(config: Record<string, unknown>) {
    let result = config;
    for (const policy of this.#policies) {
      result = policy.applyToConfig(result);
    }
    return result;
  }

  getBudget() {
    const bp = this.get(BudgetPolicy);
    return bp
      ? {
          maxIterations: bp.maxIterations,
          maxTokens: bp.maxTokens,
          timeoutMs: bp.timeoutMs,
          temperature: bp.temperature,
          maxSessionInputTokens: bp.maxSessionInputTokens,
          maxSessionTokens: bp.maxSessionTokens,
        }
      : null;
  }

  validateToolCall(toolName: string, args: Record<string, unknown>) {
    // 声明式 profile 可叠加多条安全策略；每条都必须同意，不能只取第一条。
    for (const policy of this.#policies) {
      if (policy instanceof SafetyPolicy) {
        const result = validateSafetyToolCall(policy, toolName, args);
        if (!result.ok) {
          return result;
        }
      }
    }
    return { ok: true };
  }
}

/**
 * code 工具里按文件系统路径解释的参数键（与 runtimeSafetyGate 解析的键一致）。
 * handler 实际读取 path / filePaths / directory；filePath 不是 code handler 的参数，
 * 但它表达的仍是路径，保留检查只会多拒绝、不会放过越界路径。
 */
const CODE_PATH_KEYS = ['path', 'filePath', 'directory'] as const;

/**
 * fileScope 拒绝原因里的规则码：只写进 reason 文本（不新增返回字段），
 * 供日志检索与模型区分“路径越界”和“code.search 不可用”。
 */
const FILE_SCOPE_PATH_RULE = 'SAFETY_FILE_SCOPE_PATH';
const FILE_SCOPE_SEARCH_RULE = 'SAFETY_FILE_SCOPE_SEARCH';

function validateSafetyToolCall(
  safety: SafetyPolicy,
  toolName: string,
  args: Record<string, unknown>
) {
  if (toolName === 'terminal') {
    // 生产 terminal 只有 {action:'exec', params:{command}}；没有 params 对象时按平铺参数保守检查。
    // fileScope 不覆盖 terminal（见 SafetyPolicy 注释），这里只执行命令黑名单。
    const terminalParams =
      args?.params && typeof args.params === 'object'
        ? (args.params as Record<string, unknown>)
        : (args ?? {});
    if (typeof terminalParams.command === 'string') {
      const check = safety.checkCommand(terminalParams.command);
      if (!check.safe) {
        return { ok: false, reason: `[SafetyPolicy] 命令拦截: ${check.reason}` };
      }
    }
  }

  if (toolName === 'code') {
    const denial = checkCodeFileScope(safety, args ?? {});
    if (denial) {
      return denial;
    }
  }

  if (safety.needsApproval(toolName)) {
    return { ok: false, reason: `[SafetyPolicy] 工具 "${toolName}" 需要人工确认` };
  }

  return { ok: true };
}

/**
 * code 工具的 fileScope 检查（L5-P18 / I17）。
 *
 * 路径约定：调用方先把路径类参数按项目根解析成绝对路径（生产由 runtimeSafetyGate 完成，并把
 * structure 的缺省目录和 search 的搜索根写进 params.directory）；直接调用本引擎时，相对路径按
 * 进程 cwd 解析，与 SafetyPolicy.checkFilePath 一致。
 *
 * 等价写法全部检查：args.params（router 实际交给 handler 的参数）与顶层平铺键（router 会丢弃，
 * 但任一处越界都拒绝），path / filePath / directory 以及 filePaths 的每一项。
 */
function checkCodeFileScope(
  safety: SafetyPolicy,
  args: Record<string, unknown>
): { ok: boolean; reason: string } | null {
  const params = isPlainRecord(args.params) ? args.params : {};
  const action = String(args.action ?? params.action ?? params.operation ?? '');
  const handlerDirectory = nonEmptyString(params.directory);

  if (action === 'search') {
    // code.search 没有路径参数，handler 恒以项目根为搜索根。按 L5-P18 决策：项目根不在 fileScope
    // 内（fileScope 窄于项目根）时直接拒绝，不收窄搜索根；模型给的 directory/glob 不改变搜索根，
    // 生产路径上 params.directory 由 runtimeSafetyGate 覆盖为项目根。
    const searchRoot = handlerDirectory ?? '.';
    const check = safety.checkFilePath(searchRoot);
    if (!check.safe) {
      return {
        ok: false,
        reason:
          `[SafetyPolicy] 搜索拦截 [${FILE_SCOPE_SEARCH_RULE}]: code.search 只能从项目根 "${searchRoot}" 开始搜索，` +
          `fileScope 窄于项目根时不可用（${check.reason}）；请改用 code.structure / code.read 访问 fileScope 内的路径`,
      };
    }
  }

  const candidates = [...collectCodePaths(params, 'params.'), ...collectCodePaths(args, '')];
  if (action === 'structure' && handlerDirectory === null) {
    // handler 对缺省或空串 directory 列出项目根（'.'），缺省值同样要在 scope 内。
    candidates.push({ param: 'params.directory (default ".")', value: '.' });
  }
  for (const candidate of candidates) {
    const check = safety.checkFilePath(candidate.value);
    if (!check.safe) {
      return {
        ok: false,
        reason: `[SafetyPolicy] 路径拦截 [${FILE_SCOPE_PATH_RULE}]: ${candidate.param}: ${check.reason}`,
      };
    }
  }
  return null;
}

function collectCodePaths(
  source: Record<string, unknown>,
  prefix: string
): Array<{ param: string; value: string }> {
  const found: Array<{ param: string; value: string }> = [];
  for (const key of CODE_PATH_KEYS) {
    const value = source[key];
    if (typeof value === 'string') {
      found.push({ param: `${prefix}${key}`, value });
    }
  }
  if (Array.isArray(source.filePaths)) {
    source.filePaths.forEach((filePath: unknown, index: number) => {
      if (typeof filePath === 'string') {
        found.push({ param: `${prefix}filePaths[${index}]`, value: filePath });
      }
    });
  }
  return found;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
