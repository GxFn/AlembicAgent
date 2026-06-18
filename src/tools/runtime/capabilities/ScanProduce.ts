/**
 * 增量扫描.生产 — Agent 将扫描发现转化为知识候选。
 */

import { RuntimeCapability } from './RuntimeCapability.js';

export class ScanProduce extends RuntimeCapability {
  get name() {
    return 'scan_production';
  }
  get description() {
    return 'Knowledge production for incremental scan';
  }

  get allowedTools() {
    return {
      code: ['read'],
      knowledge: ['submit'],
      memory: ['recall'],
    };
  }
}
