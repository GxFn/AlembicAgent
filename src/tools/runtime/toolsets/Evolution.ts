/**
 * 知识进化 — Agent 验证现有 Recipe 准确性并提出进化/废弃。
 */

import type { TerminalCommandAllowlist } from '#tools/kernel/registry.js';
import { RuntimeCapability } from './RuntimeCapability.js';

/**
 * Evolution 取证用的终端 allowlist。Agent 侧执行的是 bins：agent 层 accessGates 用
 * checkTerminalCommandAllowlist 检查（含写类参数与子命令约束）；router 把 capability 的
 * commandAllowlist 注入 ToolContext 时，terminal handler 再用同一函数查一次。
 *
 * intent 经执行端口透传给宿主（L4-P38）：生产宿主的 ToolRouterAdapter 不带 capability，本能力只在
 * loopCtx.capabilities 上，由 runtimeBridge 把这里的 intent 投影成 terminal 调用的
 * request.runtime.terminalIntent；terminal.exec 再把 { network:'none', filesystem:'read-only' } 作为
 * sandboxExecutor.exec 的 opts.intent 交给宿主（带 capability 的 ToolRouter 经 commandAllowlist 得到
 * 同一结果）。生效取决于宿主是否读取 opts.intent：当前 Alembic SandboxExecutorBridge 尚未读取，
 * 仍按固定的可写项目目录 profile 执行。命令没有进沙箱时结果带 terminal_intent_not_enforced 诊断。
 *
 * 代码执行暂停（L4-P7d，用户决定 2026-10-18）：在宿主按 intent 为 Evolution 启用只读文件系统并验收通过之前，
 * terminalSafety 的 EVOLUTION_CODE_EXECUTION_ENABLED 关闭，node、npm/pnpm/yarn、npx、vitest、jest、eslint
 * 的任何命令都以 allowlist-code-execution-disabled 拒绝（它们会执行被分析仓库的代码）。这些 bin 仍留在下表里，
 * 开关恢复后不必再改能力声明；当前实际可运行的只有 git 只读子命令（只在项目根，allowlist-git-cwd）、
 * rg/grep、ls/cat/head/tail/wc/find、tsc --noEmit 与 biome check/ci。promptFragment 同步告诉模型不要尝试
 * 被禁用的命令、git 不要传 cwd。
 */
const EVOLUTION_READONLY_TERMINAL_ALLOWLIST: TerminalCommandAllowlist = {
  bins: [
    'git',
    'npm',
    'pnpm',
    'yarn',
    'tsc',
    'node',
    'eslint',
    'biome',
    'grep',
    'rg',
    'cat',
    'ls',
    'find',
    'vitest',
    'jest',
    'head',
    'tail',
    'wc',
  ],
  intent: { network: 'none', filesystem: 'read-only' },
};

/**
 * knowledge.manage 的 operation 级权限（L4-P29）：本能力只开放 evolve/deprecate/skip_evolution。
 * 约束由 tools/kernel/toolSelection.ts 的 CAPABILITY_PARAMETER_ALLOWLISTS 按能力名
 * 'evolution_analysis' 登记，ToolRouter.explain 与 agent 层 runtimeSafetyGate 两处执行；
 * 公开的 parameterAllowlist 字段获批后再迁到这里声明。改能力名时必须同步那张表。
 */
export class Evolution extends RuntimeCapability {
  get name() {
    return 'evolution_analysis';
  }
  get description() {
    return 'Knowledge evolution: verify, evolve, deprecate recipes with read-only evidence (no test/lint runs)';
  }

  get allowedTools() {
    return {
      code: ['search', 'read'],
      terminal: ['exec'],
      knowledge: ['search', 'detail', 'manage'],
      graph: ['query'],
    };
  }

  get commandAllowlist() {
    return EVOLUTION_READONLY_TERMINAL_ALLOWLIST;
  }

  get promptFragment() {
    return `## 知识进化能力
你是知识进化专家，负责验证现有 Recipe 真实性并推动知识演化。

工作流:
1. knowledge.search / knowledge.detail 获取旧知识上下文
2. code.search / code.read / graph.query 验证代码事实
3. 证据明确时: knowledge({ action: "manage", params: { operation: "evolve"|"deprecate", id } })
4. 无法确定时: knowledge({ action: "manage", params: { operation: "skip_evolution", id } })

关键规则:
- 优先 skip_evolution，只有证据明确时才 evolve 或 deprecate
- terminal.exec 只能运行只读取证命令：git log/blame/diff/show/status、rg/grep、ls/cat/head/tail/wc/find、tsc --noEmit、biome check
- git 只在项目根运行：不要给 terminal.exec 传 cwd，用路径参数限定范围（如 git log -- src/module），否则会被拒绝（allowlist-git-cwd）
- 宿主只读沙箱启用前，Evolution 不运行会执行仓库代码的命令：当前不能运行测试或 lint 脚本，npm test、npm run、pnpm/yarn、npx、node（含 node --test）、vitest、jest、eslint 都会被拒绝（allowlist-code-execution-disabled）；不要尝试，也不要换参数或写法重试
- 需要行为证据时，用 code.search / code.read / graph.query 阅读相关测试与实现代码，或用 git log/blame/diff 查看近期变更
- 使用终端证据时先验证 Recipe 是否仍符合代码与近期历史，再决定 evolve / deprecate / skip_evolution
- knowledge.manage 对本能力只开放 evolve / deprecate / skip_evolution；approve/publish/update/reject/review 等其它 operation 会被拒绝，不要调用
- 不提交新知识

${super.promptFragment}`;
  }
}
