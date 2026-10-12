/**
 * 增量扫描.生产 — Agent 将扫描发现转化为知识候选。
 */

import { RuntimeCapability } from './RuntimeCapability.js';

/**
 * 扫描 Produce 的证据自救说明（L4-P30 / I44）。
 *
 * 扫描运行经 SystemRunContext._dimensionScopeId 打开维度证据台账；knowledge.submit 在
 * EVIDENCE_REFS_REQUIRED / INSUFFICIENT_EVIDENCE / SOURCE_REF_NOT_FOUND / EVIDENCE_STALE
 * 拒绝里会要求模型用 memory.recall、evidence.search 或 code.read 修正引用。这段说明与
 * allowedTools 必须指向同一组可调用动作；test/tool-runtime-contract.test.ts 的 L4-P30
 * 守护用例会从真实拒绝文本中提取 tool.action 并逐一核对本能力的 allowlist。
 */
const SCAN_EVIDENCE_RESCUE_PROMPT = `## 扫描生产证据自救通道
- 提交被拒（EVIDENCE_REFS_REQUIRED / INSUFFICIENT_EVIDENCE / SOURCE_REF_NOT_FOUND）时：先 memory.recall 查看 findings 携带的 [E-x]，或用 evidence.search 按文件路径片段/关键词查已采条目 id，再以 reasoning.evidenceRefs 引用后重提；需要 verbatim 原文时用 evidence.get 取回（支持 "E-3@start-end" 子区间）。
- EVIDENCE_STALE（引用条目采集后文件已变更）：对该已定位文件用 code.read 重读生成新条目，或用 evidence.search 找到更新的条目，再以新条目 id 提交。
- evidence.get/search 只读已采证据台账，不算新探索，也不访问文件系统；不要借它们新增 findings 之外的主题。
- 台账不在场（非维度运行）时 evidence 动作不可用，按 reasoning.sources 提交真实 file:line。`;

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
      // L4-P30（I44）：证据台账只读取回——与 GenerateProduce 一致的自救通道。submit 拒绝提示要求
      // evidence.search 查条目 id、EVIDENCE_STALE 要求重采；此前未开放时会被 accessGates 判为
      // 不允许，在只有 12-24 轮、10 次提交的扫描 Produce 里白耗一轮。台账缺席的运行由可用性快照
      // （availability.ts 按 runtime.evidenceLedger）收窄掉这两个动作，不会广告必然失败的调用。
      evidence: ['get', 'search'],
    };
  }

  get promptFragment() {
    return this.#strictColdStart
      ? '## Strict scan proposal authoring\nAuthor typed proposals only; no tools, persistence, fact queries, or self-review.'
      : `${SCAN_EVIDENCE_RESCUE_PROMPT}\n\n${super.promptFragment}`;
  }
}
