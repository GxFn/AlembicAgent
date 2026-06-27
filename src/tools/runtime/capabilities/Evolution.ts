/**
 * 知识进化 — Agent 验证现有 Recipe 准确性并提出进化/废弃。
 */

import type { TerminalCommandAllowlist } from '#tools/kernel/registry.js';
import { RuntimeCapability } from './RuntimeCapability.js';

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
- 不提交新知识

${super.promptFragment}`;
  }
}
