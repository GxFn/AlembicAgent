import { isPersistedSubmission } from '../utils/toolOutcomes.js';
import { Policy, type PolicyResult } from './Policy.js';

export interface QualityGatePolicyOptions {
  minEvidenceLength?: number;
  minFileRefs?: number;
  minToolCalls?: number;
  customValidator?: (result: PolicyResult) => { ok: boolean; reason?: string };
}

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

  toGateConfig() {
    const customValidator = this.#customValidator;
    return {
      minEvidenceLength: this.#minEvidenceLength,
      minFileRefs: this.#minFileRefs,
      minToolCalls: this.#minToolCalls,
      // Policy 使用 ok；Pipeline gate 使用 pass。此处是两份现有公开合同的唯一翻译点。
      custom: customValidator
        ? (result: PolicyResult) => {
            const decision = customValidator(result);
            return { pass: decision.ok, reason: decision.reason };
          }
        : null,
    };
  }
}
