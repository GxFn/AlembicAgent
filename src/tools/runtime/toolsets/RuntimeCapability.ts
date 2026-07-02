/**
 * @module tools/runtime/toolsets/RuntimeCapability
 *
 * Capability 基类 — 继承本地 Capability 叶子基类，声明式定义场景级工具集。
 * 每个 Capability 声明 allowedTools (tool → action[])，
 * promptFragment 从注册表自动生成。
 */

import type { CapabilityDef, TerminalCommandAllowlist } from '#tools/kernel/registry.js';
import { TOOL_REGISTRY } from '../registry.js';
import { Capability } from './Capability.js';

export abstract class RuntimeCapability extends Capability {
  abstract get description(): string;
  abstract get allowedTools(): Record<string, string[]>;

  get commandAllowlist(): TerminalCommandAllowlist | undefined {
    return undefined;
  }

  get tools(): string[] {
    return Object.keys(this.allowedTools);
  }

  get promptFragment(): string {
    return generatePromptFragment(this.allowedTools);
  }

  toDef(): CapabilityDef {
    const commandAllowlist = this.commandAllowlist;
    return {
      name: this.name,
      description: this.description,
      promptFragment: this.promptFragment,
      allowedTools: this.allowedTools,
      ...(commandAllowlist ? { commandAllowlist } : {}),
    };
  }
}

function generatePromptFragment(allowedTools: Record<string, string[]>): string {
  const lines: string[] = ['## Available Tools'];

  for (const [tool, actions] of Object.entries(allowedTools)) {
    const spec = TOOL_REGISTRY[tool];
    if (!spec) {
      continue;
    }

    const actionDescriptions = actions
      .map((a) => {
        const action = spec.actions[a];
        return action ? `${a}(${action.summary})` : a;
      })
      .join(', ');

    lines.push(`- **${tool}**: ${actionDescriptions}`);
  }

  return lines.join('\n');
}
