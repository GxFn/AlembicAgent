import { isPersistedSubmission } from '../utils/toolOutcomes.js';
import { Policy, type PolicyResult } from './Policy.js';

export interface QualityGatePolicyOptions {
  minEvidenceLength?: number;
  minFileRefs?: number;
  minToolCalls?: number;
  customValidator?: (result: PolicyResult) => { ok: boolean; reason?: string };
}

/**
 * 运行级阈值质量策略：运行结束后由 AgentRuntime 调用 validateAfter，未通过只记 quality_warning，不改运行结论。
 *
 * I43(L5-P44)：内置预设不再安装本策略(insight 运行以管线 quality_gate 为唯一质量门)。②已答复：
 * 类保留导出，供调用方显式注入为运行级策略；到 Pipeline 门配置的翻译 toGateConfig 已删除(W2a-07)，
 * 需要阈值门的管线直接声明 GateConfig(minEvidenceLength / minFileRefs / minToolCalls 与返回 pass 的 custom)。
 * AgentRuntime 对取消或超时的运行跳过 validateAfter(记 quality_check_skipped 诊断)，本策略不会再对取消
 * 占位文案报质量不足。
 */
export class QualityGatePolicy extends Policy {
  #minEvidenceLength;
  #minFileRefs;
  #minToolCalls;
  #customValidator;

  constructor({
    minEvidenceLength = 500,
    minFileRefs = 3,
    minToolCalls = 2,
    customValidator,
  }: QualityGatePolicyOptions = {}) {
    super();
    this.#minEvidenceLength = minEvidenceLength;
    this.#minFileRefs = minFileRefs;
    this.#minToolCalls = minToolCalls;
    this.#customValidator = customValidator || null;
  }

  get name() {
    return 'quality_gate';
  }

  validateAfter(result: PolicyResult) {
    const reasons: string[] = [];

    const reply = result.reply || '';
    if (reply.length < this.#minEvidenceLength) {
      reasons.push(`分析长度不足: ${reply.length} < ${this.#minEvidenceLength}`);
    }

    {
      const hasSubmitCalls = (result.toolCalls || []).some(isPersistedSubmission);
      if (!hasSubmitCalls) {
        const fileRefCount = (reply.match(/[\w/-]+\.\w{1,6}/g) || []).length;
        if (fileRefCount < this.#minFileRefs) {
          reasons.push(`文件引用不足: ${fileRefCount} < ${this.#minFileRefs}`);
        }
      }
    }

    if ((result.toolCalls?.length || 0) < this.#minToolCalls) {
      reasons.push(`工具调用不足: ${result.toolCalls?.length || 0} < ${this.#minToolCalls}`);
    }

    if (this.#customValidator) {
      const custom = this.#customValidator(result);
      if (!custom.ok) {
        reasons.push(custom.reason || '自定义质量校验未通过');
      }
    }

    return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; ') };
  }
}
