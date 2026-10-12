/**
 * 系统交互 — Agent 的全功能模式（代码探索 + 终端 + 写入）。
 *
 * 不在 CapabilityRegistry 中注册（L4-P33 / I06）：它开放 code.write 与没有 commandAllowlist
 * 的 terminal.exec，profile 的 skills 写上 'system_interaction' 会被 CapabilityRegistry.create
 * 拒绝。类本身与 barrel 导出暂时保留，是否删除随待决事项②（公开面收窄）一起决定。
 */

import { RuntimeCapability } from './RuntimeCapability.js';

export class System extends RuntimeCapability {
  get name() {
    return 'system_interaction';
  }
  get description() {
    return 'Full system interaction: code, terminal, write';
  }

  get allowedTools() {
    return {
      code: ['search', 'read', 'outline', 'structure', 'write'],
      terminal: ['exec'],
      graph: ['overview'],
      meta: ['tools'],
    };
  }
}
