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
 * 仍按固定的可写项目目录 profile 执行，npm test、vitest run 等允许的命令那时仍可能写缓存/快照。
 * 命令没有进沙箱时结果带 terminal_intent_not_enforced 诊断。
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
    return 'Knowledge evolution: verify, evolve, deprecate recipes';
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
- 允许使用 terminal.exec 的只读 allowlist 命令取证，例如 git log/blame/diff/status、grep/rg、npm test、vitest run、tsc --noEmit、eslint/biome check
- 使用终端证据时先验证 Recipe 是否仍符合代码与近期历史，再决定 evolve / deprecate / skip_evolution
- knowledge.manage 对本能力只开放 evolve / deprecate / skip_evolution；approve/publish/update/reject/review 等其它 operation 会被拒绝，不要调用
- 不提交新知识

${super.promptFragment}`;
  }
}
