/**
 * 系统交互 — Agent 的全功能模式（代码探索 + 终端 + 写入）。
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
