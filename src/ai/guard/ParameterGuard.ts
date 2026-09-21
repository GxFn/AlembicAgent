/**
 * ParameterGuard — 参数约束执行器
 *
 * 在 API 调用之前，根据 ModelDef.parameterConstraints 自动过滤/修正参数。
 * 替代各 Provider 中分散的 if 判断:
 *   - ClaudeProvider: if (isOpus47) 不传 temperature
 *   - DeepSeekProvider: if (v4Thinking) 不传 tool_choice
 */

import type { ModelDef, ParameterConstraints } from '../registry/ModelDefs.js';

export interface GuardedParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  toolChoice?: string;
  reasoningEffort?: string;
  /** 被过滤的参数及原因 */
  filtered: FilteredParam[];
}

export interface FilteredParam {
  param: string;
  reason: string;
  originalValue: unknown;
}

function invalidNumericParam(param: string, requirement: string): Error {
  return Object.assign(new Error(`${param} must be ${requirement}`), {
    code: 'LLM_INVALID_REQUEST',
  });
}

/** 仅校验模型允许的输入；不做隐式数字转换，也不把原值带进错误诊断。 */
function finiteNumericParam(param: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidNumericParam(param, 'a finite number');
  }
  return value;
}

export class ParameterGuard {
  /**
   * 根据 ModelDef 过滤并修正请求参数
   *
   * @returns 安全的参数集 + 被过滤项的审计日志
   */
  static guard(model: ModelDef, rawParams: Record<string, unknown>): GuardedParams {
    const result: GuardedParams = { filtered: [] };
    const c = model.parameterConstraints;

    ParameterGuard.#guardTemperature(model, c, rawParams, result);
    ParameterGuard.#guardTopP(c, rawParams, result);
    ParameterGuard.#guardTopK(c, rawParams, result);
    ParameterGuard.#guardToolChoice(model, c, rawParams, result);
    ParameterGuard.#guardReasoningEffort(model, c, rawParams, result);
    ParameterGuard.#guardMaxTokens(model, rawParams, result);

    return result;
  }

  static #guardTemperature(
    model: ModelDef,
    c: ParameterConstraints,
    raw: Record<string, unknown>,
    out: GuardedParams
  ): void {
    if (!('temperature' in raw) || raw.temperature == null) {
      return;
    }
    const rule = c.temperature;
    if (!rule?.allowed) {
      out.filtered.push({
        param: 'temperature',
        reason: `${model.displayName} 禁止设置 temperature`,
        originalValue: raw.temperature,
      });
      return;
    }
    const val = finiteNumericParam('temperature', raw.temperature);
    out.temperature = Math.max(rule.min ?? 0, Math.min(rule.max ?? 2, val));
  }

  static #guardTopP(
    c: ParameterConstraints,
    raw: Record<string, unknown>,
    out: GuardedParams
  ): void {
    if (!('topP' in raw) || raw.topP == null) {
      return;
    }
    const rule = c.topP;
    if (!rule?.allowed) {
      out.filtered.push({
        param: 'topP',
        reason: '该模型不支持 topP',
        originalValue: raw.topP,
      });
      return;
    }
    const val = finiteNumericParam('topP', raw.topP);
    out.topP = Math.max(rule.min ?? 0, Math.min(rule.max ?? 1, val));
  }

  static #guardTopK(
    c: ParameterConstraints,
    raw: Record<string, unknown>,
    out: GuardedParams
  ): void {
    if (!('topK' in raw) || raw.topK == null) {
      return;
    }
    const rule = c.topK;
    if (!rule?.allowed) {
      out.filtered.push({
        param: 'topK',
        reason: '该模型不支持 topK',
        originalValue: raw.topK,
      });
      return;
    }
    const val = finiteNumericParam('topK', raw.topK);
    out.topK = Math.max(rule.min ?? 0, Math.min(rule.max ?? 100, val));
  }

  static #guardToolChoice(
    model: ModelDef,
    c: ParameterConstraints,
    raw: Record<string, unknown>,
    out: GuardedParams
  ): void {
    if (!('toolChoice' in raw) || raw.toolChoice == null) {
      return;
    }
    const rule = c.toolChoice;
    if (!rule?.allowed) {
      out.filtered.push({
        param: 'toolChoice',
        reason: rule?.reason ?? `${model.displayName} 不支持 tool_choice`,
        originalValue: raw.toolChoice,
      });
      return;
    }
    const isThinking = model.reasoning.supported && model.reasoning.mode === 'thinking';
    if (rule.disabledWhen === 'thinking' && isThinking) {
      out.filtered.push({
        param: 'toolChoice',
        reason: rule.reason ?? `${model.displayName} thinking 模式下不支持 tool_choice`,
        originalValue: raw.toolChoice,
      });
      return;
    }
    out.toolChoice = raw.toolChoice as string;
  }

  static #guardReasoningEffort(
    model: ModelDef,
    c: ParameterConstraints,
    raw: Record<string, unknown>,
    out: GuardedParams
  ): void {
    if (!('reasoningEffort' in raw) || raw.reasoningEffort == null) {
      return;
    }
    const rule = c.reasoningEffort;
    if (!rule?.allowed) {
      out.filtered.push({
        param: 'reasoningEffort',
        reason: `${model.displayName} 不支持 reasoningEffort`,
        originalValue: raw.reasoningEffort,
      });
      return;
    }
    const val = raw.reasoningEffort as string;
    if (rule.allowedValues && !rule.allowedValues.includes(val)) {
      out.filtered.push({
        param: 'reasoningEffort',
        reason: `${model.displayName} 不支持 effort=${val}, 允许: ${rule.allowedValues.join(',')}`,
        originalValue: val,
      });
      out.reasoningEffort = model.reasoning.defaultEffort;
    } else {
      out.reasoningEffort = val;
    }
  }

  static #guardMaxTokens(model: ModelDef, raw: Record<string, unknown>, out: GuardedParams): void {
    if (!('maxTokens' in raw) || raw.maxTokens == null) {
      return;
    }
    const val = finiteNumericParam('maxTokens', raw.maxTokens);
    if (!Number.isSafeInteger(val) || val <= 0) {
      throw invalidNumericParam('maxTokens', 'a positive safe integer');
    }
    out.maxTokens = Math.min(val, model.maxOutputTokens);
  }
}
