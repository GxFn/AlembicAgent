/** P1-B-3 切片1：ModelQuirks 解析器——注册表数据优先,未注册回退旧内核同款名字正则(语义保真)。 */
import { describe, expect, it } from 'vitest';
import { isTextCompatToolCallId, resolveModelQuirks } from '../src/ai/registry/ModelQuirks.js';

describe('resolveModelQuirks', () => {
  it('V4(注册表 toolChoice.allowed=false)→ forced+guard+dropSchemas+note', () => {
    const q = resolveModelQuirks('deepseek-v4-flash');
    expect(q.forcedToolChoiceUnsupported).toBe(true);
    expect(q.analyzeGroundingGuardEligible).toBe(true);
    expect(q.dropToolSchemasWhenToolChoiceNone).toBe(true);
    expect(q.groundingPolicyProviderNote).toContain('DeepSeek V4');
    expect(q.usesTextToolCallCompat).toBe(true);
  });

  it('deepseek-chat(allowed=true)→ 全非特化(除文本兼容桥)', () => {
    const q = resolveModelQuirks('deepseek-chat');
    expect(q.forcedToolChoiceUnsupported).toBe(false);
    expect(q.analyzeGroundingGuardEligible).toBe(false);
    expect(q.groundingPolicyProviderNote).toBeNull();
    expect(q.usesTextToolCallCompat).toBe(true);
  });

  it('deepseek-reasoner：按注册表声明 forced=true(旧 V4 正则漏掉的已声明修正),但 guard 不适格', () => {
    const q = resolveModelQuirks('deepseek-reasoner');
    expect(q.forcedToolChoiceUnsupported).toBe(true);
    expect(q.analyzeGroundingGuardEligible).toBe(false);
  });

  it('gemini → dropSchemas;未注册的裸 ref 走名字回退(旧内核行为不变)', () => {
    expect(resolveModelQuirks('gemini-2.5-pro').dropToolSchemasWhenToolChoiceNone).toBe(true);
    const raw = resolveModelQuirks('custom-deepseek-v4-build');
    expect(raw.forcedToolChoiceUnsupported).toBe(true);
    expect(raw.analyzeGroundingGuardEligible).toBe(true);
    expect(resolveModelQuirks('claude-sonnet-5').forcedToolChoiceUnsupported).toBe(false);
    expect(resolveModelQuirks(null).analyzeGroundingGuardEligible).toBe(false);
  });

  it('isTextCompatToolCallId 前缀判定', () => {
    expect(isTextCompatToolCallId('call_deepseek_compat_1')).toBe(true);
    expect(isTextCompatToolCallId('call_x')).toBe(false);
    expect(isTextCompatToolCallId(null)).toBe(false);
  });
});
