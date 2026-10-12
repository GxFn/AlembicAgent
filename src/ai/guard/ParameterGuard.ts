/**
 * ParameterGuard — 参数约束执行器
 *
 * 在 API 调用之前，根据 ModelDef.parameterConstraints 自动过滤/修正参数。
 * 只执行注册表上的静态声明(例如 Claude Opus 4.7 不允许 temperature、DeepSeek V4 不允许 tool_choice)。
 *
 * 不覆盖的部分：DeepSeekTransport 仍按请求持有 thinking 相关调整——有工具时开启 thinking、
 * 丢弃 temperature、抬高 maxTokens 下限，并再次确保 V4 不发 tool_choice；这些按请求变化的调整
 * 不进入本类的 filtered 审计，而由 transport 的 v4_param_policy 诊断日志记录。
 * V4 家族身份由 registry/ModelQuirks 的 resolveDeepSeekV4Family 单源判定。
 *
 * 钳制（temperature/topP/topK 夹到区间、maxTokens 截到 model.maxOutputTokens）是合法修正，
 * 不写入 filtered（filtered 只表示“被丢弃或被替换”）；钳制诊断由 LLMGateway.chatWithTools
 * 比较请求值与本类输出后打出（maxTokens 为 info，其余数值为 debug）。
 */

import type { ModelDef, ParameterConstraints } from '../registry/ModelDefs.js';

export interface GuardedParams {
  temperature?: number;
  /**
   * topP / topK 目前在生产路径不可达：GatewayRequest 与 TransportRequest 都没有这两个字段，
   * LLMGateway 调用 guard() 时也不传入，因此注册表里的 topP/topK 声明（如 Claude Opus 4.7）
   * 当前不生效。保留它们是因为 ParameterGuard 是公开类，宿主单测与直接调用方仍按此合同使用。
   */
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

function invalidParam(param: string, requirement: string): Error {
  return Object.assign(new Error(`${param} must be ${requirement}`), {
    code: 'LLM_INVALID_REQUEST',
  });
}

/** 仅校验模型允许的输入；不做隐式数字转换，也不把原值带进错误诊断。 */
function finiteNumericParam(param: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidParam(param, 'a finite number');
  }
  return value;
}

/**
 * 字符串参数与数值参数同一口径：只校验模型允许、即将透传给 transport 的值。
 * 公开类型已是 string，这里拦的是 JS 调用方传入的对象（如 Anthropic 风格 {type,name}）、
 * 数字或空白串——它们原本会被 as string 透传成厂商请求错误并进入重试/熔断。
 * 不 trim、不改写合法值；错误信息不带原值，避免把调用方输入写进诊断。
 */
function nonBlankStringParam(param: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParam(param, 'a non-empty string');
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
    // topP/topK 只服务直接调用 guard() 的调用方；Gateway 请求没有这两个入口（见 GuardedParams 注释）。
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
      // 注册表声明了具体原因（如推理模型由 SDK 剥离）时优先写入审计，便于网关 debug 日志定位。
      out.filtered.push({
        param: 'temperature',
        reason: rule?.reason ?? `${model.displayName} 禁止设置 temperature`,
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
        reason: rule?.reason ?? '该模型不支持 topP',
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
    // disabledWhen 只按模型的静态推理模式判断（reasoning.mode==='thinking'），不感知单次请求是否
    // 真的开启 thinking：DeepSeek/Claude 按请求切换 thinking 的行为由各 Transport 处理，不在这里。
    // 当前内置模型表没有任何 disabledWhen 声明（只有测试夹具使用），生产路径不会进入此分支；
    // 字段作为公开 ParameterRule 合同保留，供运行时 register() 的自定义模型声明。
    const isThinking = model.reasoning.supported && model.reasoning.mode === 'thinking';
    if (rule.disabledWhen === 'thinking' && isThinking) {
      out.filtered.push({
        param: 'toolChoice',
        reason: rule.reason ?? `${model.displayName} thinking 模式下不支持 tool_choice`,
        originalValue: raw.toolChoice,
      });
      return;
    }
    // 两个过滤分支之后才校验：不支持的 toolChoice 本就不会发出，保持“被过滤”审计而不是报错。
    out.toolChoice = nonBlankStringParam('toolChoice', raw.toolChoice);
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
    // 先校验类型再比对 allowedValues：合法字符串但不在白名单时仍按原语义替换为模型默认值。
    const val = nonBlankStringParam('reasoningEffort', raw.reasoningEffort);
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
      throw invalidParam('maxTokens', 'a positive safe integer');
    }
    out.maxTokens = Math.min(val, model.maxOutputTokens);
  }
}
