import path from 'node:path';
import { Policy, type PolicyContext } from './Policy.js';

export interface SafetyPolicyOptions {
  /**
   * 允许 Agent 文件类工具访问的目录（含子目录）。覆盖范围见 SafetyPolicy 类注释：只约束 code 工具，
   * 不约束 terminal。
   */
  fileScope?: string;
  allowedSenders?: string[];
  commandBlacklist?: RegExp[];
  requireApprovalFor?: string[];
}

/**
 * 运行时安全策略：发送者白名单、终端命令黑名单、文件范围（fileScope）与人工确认工具。
 *
 * fileScope 的覆盖边界（L5-P18 / I17）：
 * - 覆盖 code 工具的全部路径类参数：path、filePaths 每一项、structure 的 directory（缺省或空串时
 *   handler 列出项目根，按项目根检查），以及历史写法 filePath；参数放在 params 内或平铺在顶层都检查。
 * - code.search 没有路径参数，handler 恒以项目根为搜索根：项目根不在 fileScope 内（fileScope 窄于
 *   项目根）时直接拒绝，拒绝原因带规则码 SAFETY_FILE_SCOPE_SEARCH；不会把搜索根收窄到 fileScope。
 * - 不覆盖 terminal：命令文本与 cwd 都不做 fileScope 检查（例如 `cat secrets/key.txt` 不会因 fileScope
 *   被拦）。终端只受 commandBlacklist 与能力级 commandAllowlist 约束；需要文件隔离时不要开放 terminal。
 * - 不覆盖其它工具（如 graph、knowledge、evidence）的参数。
 * - 包含判断是词法比较：相对路径按进程 cwd 解析，不解析 symlink。生产调用方 runtimeSafetyGate 先把
 *   code 的路径按项目根解析成绝对路径再交给 PolicyEngine。
 */
export class SafetyPolicy extends Policy {
  static DANGEROUS_COMMANDS = Object.freeze([
    /\brm\s+-rf\s+[/~]/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\b(shutdown|reboot|halt)\b/,
    />\s*\/dev\//,
    /\bcurl\b.*\|\s*(bash|sh)/,
    /\bchmod\s+777/,
    /\bpasswd\b/,
    /\bkillall\b/,
  ]);

  static SAFE_COMMANDS = Object.freeze([
    'ls',
    'cat',
    'head',
    'tail',
    'grep',
    'find',
    'wc',
    'echo',
    'pwd',
    'date',
    'which',
    'file',
    'stat',
    'git log',
    'git status',
    'git diff',
    'git branch',
    'npm list',
    'npm outdated',
    'node -v',
    'npm -v',
  ]);

  #fileScope;
  #allowedSenders;
  #commandBlacklist;
  #requireApprovalFor;

  constructor({
    fileScope,
    allowedSenders = [],
    commandBlacklist = [],
    requireApprovalFor = [],
  }: SafetyPolicyOptions = {}) {
    super();
    this.#fileScope = fileScope || null;
    this.#allowedSenders = allowedSenders;
    this.#commandBlacklist = [...SafetyPolicy.DANGEROUS_COMMANDS, ...commandBlacklist];
    this.#requireApprovalFor = requireApprovalFor;
  }

  get name() {
    return 'safety';
  }

  validateBefore(context: PolicyContext) {
    if (this.#allowedSenders.length > 0) {
      const senderId = context.message?.sender?.id;
      if (!senderId || !this.#allowedSenders.includes(senderId)) {
        return { ok: false, reason: `Safety: sender "${senderId}" not in allowlist` };
      }
    }
    return { ok: true };
  }

  checkCommand(command: string) {
    for (const pattern of this.#commandBlacklist) {
      // /g 与 /y 会修改 lastIndex；每次检查用独立 matcher，避免同一命令交替放行。
      if (new RegExp(pattern.source, pattern.flags).test(command)) {
        return { safe: false, reason: `Blocked: matches dangerous pattern ${pattern}` };
      }
    }
    return { safe: true };
  }

  checkFilePath(filePath: string) {
    if (!this.#fileScope) {
      return { safe: true };
    }
    if (!isWithinPathScope(filePath, this.#fileScope)) {
      return {
        safe: false,
        reason: `File path "${filePath}" outside allowed scope "${this.#fileScope}"`,
      };
    }
    return { safe: true };
  }

  needsApproval(toolName: string) {
    return this.#requireApprovalFor.includes(toolName);
  }

  applyToConfig(config: Record<string, unknown>): Record<string, unknown> {
    return {
      ...config,
      safetyPolicy: this,
    };
  }
}

function isWithinPathScope(filePath: string, scopePath: string) {
  const resolved = path.resolve(filePath);
  const scope = path.resolve(scopePath);
  const relative = path.relative(scope, resolved);
  return (
    relative === '' ||
    (!!relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
