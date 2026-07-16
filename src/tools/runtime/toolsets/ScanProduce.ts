/**
 * 增量扫描.生产 — Agent 将扫描发现转化为知识候选。
 */

import { RuntimeCapability } from './RuntimeCapability.js';

export class ScanProduce extends RuntimeCapability {
  readonly #strictColdStart: boolean;

  constructor(options: { readonly strictColdStart?: boolean } = {}) {
    super();
    this.#strictColdStart = options.strictColdStart === true;
  }

  get name() {
    return 'scan_production';
  }
  get description() {
    return 'Knowledge production for incremental scan';
  }

  get allowedTools(): Record<string, string[]> {
    if (this.#strictColdStart) {
      return {};
    }
    return {
      code: ['read'],
      knowledge: ['submit'],
      memory: ['recall'],
    };
  }

  get promptFragment() {
    return this.#strictColdStart
      ? '## Strict scan proposal authoring\nAuthor typed proposals only; no tools, persistence, fact queries, or self-review.'
      : super.promptFragment;
  }
}
