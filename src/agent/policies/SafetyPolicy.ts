import path from 'node:path';
import { checkTerminalCommandSafety } from '#tools/runtime/handlers/terminalSafety.js';
import { Policy, type PolicyContext } from './Policy.js';

export interface SafetyPolicyOptions {
  /**
   * 允许 Agent 文件类工具访问的目录（含子目录）。覆盖范围见 SafetyPolicy 类注释：只约束 code 工具，
   * 不约束 terminal。
   */
  fileScope?: string;
  allowedSenders?: string[];
  /** 叠加在 terminal 同源危险规则与 DANGEROUS_COMMANDS 之上的自定义命令黑名单。 */
  commandBlacklist?: RegExp[];
  /**
   * 声明“需要人工审批”的工具名。全链路目前没有审批、挂起或重放通道（真正的审批端口需要宿主配合），
   * 所以命中即硬拒绝：PolicyEngine 返回带规则码 safety-approval-unavailable 的拒绝原因（L5-P45 / I18）。
   */
  requireApprovalFor?: string[];
}

/**
 * 运行时安全策略：发送者白名单、终端命令黑名单、文件范围（fileScope）与审批禁用工具。
 *
 * 终端命令检查（L5-P45 / I18）：checkCommand 先复用 tools 层 terminal handler 的同一条
 * checkTerminalCommandSafety（其第一步就是 detectDangerousShellPayload 正则预检，随后是命令位置上的
 * DENIED_BINS、eval 与 rm 递归强删 token 级检查），再叠加 DANGEROUS_COMMANDS 与自定义 commandBlacklist。
 * 这样策略层的结论永远不比 terminal handler 宽松，两份危险命令规则不再各自漂移。
 *
 * requireApprovalFor：没有人工审批通道，命中即硬拒绝，拒绝原因带规则码 safety-approval-unavailable。
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
  /**
   * 旧的内置命令黑名单（公开静态属性）。rm 递归强删、curl|sh 以及命令位置上的 sudo、dd、mkfs、
   * shutdown/reboot/halt、passwd、killall 已由 terminal 同源规则检查；这里的正则不区分命令位置
   * （'rg -n sudo src' 也会命中），chmod 777、重定向到 /dev/ 等条目也只由这里提供。
   * 删除或标注废弃属于公开面收窄，待决事项②决定前保留原值并继续叠加检查。
   */
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

  /**
   * 公开静态属性，src、测试与宿主中都没有读取方，也不参与任何检查；真正生效的只读白名单是
   * terminalSafety 的 checkTerminalCommandAllowlist。去留待决事项②，决定前保持原值。
   */
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
    // 第一层：与 terminal handler 完全同源的危险命令检查。拒绝原因带 terminal 规则码
    // （如 shell-rm-recursive-force），经 PolicyEngine → runtimeSafetyGate 进入日志与诊断。
    const terminalVerdict = checkTerminalCommandSafety(command);
    if (!terminalVerdict.safe) {
      return {
        safe: false,
        reason: `Blocked [${terminalVerdict.block.rule}]: ${terminalVerdict.block.reason}`,
      };
    }
    // 第二层：DANGEROUS_COMMANDS（待决事项②前保留）与自定义 commandBlacklist。
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

  /**
   * 工具是否在 requireApprovalFor 里。返回 true 时 PolicyEngine 直接硬拒绝（当前没有人工审批通道），
   * 不会挂起等待确认。
   */
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
