/**
 * ModelRegistry — 模型能力注册中心
 *
 * 集中保存各 LLM 模型的能力声明、参数约束与容量信息（内置表 + 运行时 register）。
 * 它还没有成为唯一事实源：ContextWindow 在注册表未命中时仍回退自有 MODEL_CONTEXT_WINDOWS
 * 正则表，ParameterGuard 只接收 Gateway 解析好的 ModelDef、不自己查询注册表。
 *
 * 当前真实消费方（按调用的 API 列出）:
 *   - LLMGateway: get / findByApiModelId / resolveOrCreate —— 把 modelRef 解析成 ModelDef，
 *     交给 ParameterGuard 与 Transport。
 *   - ContextWindow.resolveTokenBudget: resolve（有具体 provider 提示时）/ findByApiModelId
 *     （无提示或 'auto' 时）—— 取 contextWindow 计算 token 预算，未命中才回退正则表。
 *   - ModelQuirks: get / findByApiModelId —— DeepSeek V4 家族等模型特性判定。
 *   - 宿主 Alembic lib/http/routes/ai.ts（/api/v1/ai/providers）: listByProvider —— 列出可选模型。
 *   - listActive / findByCapability / getContextWindow / register / size 没有生产调用方，
 *     宿主单测（test/unit/LlmRegistryAndGuard.test.ts）直接断言它们，作为公开查询 API 保留。
 *
 * provider 入口口径：resolve / resolveOrCreate（及经 resolve 的 getContextWindow）先用
 * configuration.canonicalProvider 归一别名与大小写（gemini → google、anthropic → claude），
 * 与 AiFactory、LLMGateway 的 provider 身份一致。未知值（包括部署选择 'auto'）：resolve 返回
 * undefined 并打 debug 诊断；resolveOrCreate 打 warn 后抛 code=LLM_INVALID_REQUEST，
 * 不再为非法 provider 造出动态定义。
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { canonicalProvider } from '../configuration.js';
import type { ModelDef, ProviderId } from './ModelDefs.js';
import { CLAUDE_MODELS } from './models/claude.js';
import { DEEPSEEK_MODELS } from './models/deepseek.js';
import { GOOGLE_MODELS } from './models/google.js';
import { OLLAMA_MODELS } from './models/ollama.js';
import { OPENAI_MODELS } from './models/openai.js';

const ALL_BUILTIN_MODELS: ModelDef[] = [
  ...OPENAI_MODELS,
  ...CLAUDE_MODELS,
  ...DEEPSEEK_MODELS,
  ...GOOGLE_MODELS,
  ...OLLAMA_MODELS,
];

// 惰性取 Core logger 单例，避免模块导入期副作用（与 LLMGateway 一致）。
const logger = () => Logger.getInstance();

/** 未知 provider 诊断最多保留的前缀长度（与 configuration 的 unknown_provider 诊断同一口径）。 */
const UNKNOWN_PROVIDER_LOG_LIMIT = 16;

/**
 * 诊断与错误消息只写截断、去控制字符后的前缀：provider 值可能来自环境变量、被误填成凭据，
 * 也不能借换行伪造日志行。非字符串（JS 调用方）只写类型说明。
 */
function providerLogValue(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '(invalid type)';
  }
  const safe = raw.slice(0, UNKNOWN_PROVIDER_LOG_LIMIT).replace(/[^\w.:-]/g, '?');
  return raw.length > UNKNOWN_PROVIDER_LOG_LIMIT ? `${safe}…(len=${raw.length})` : safe;
}

/**
 * provider 入口归一：别名与大小写差异按 configuration.canonicalProvider 归一（与 AiFactory、
 * LLMGateway 同一口径）。非字符串入参（JS 调用方）视为未知，避免 canonicalProvider 内部 trim 抛 TypeError。
 */
function toProviderId(provider: unknown): ProviderId | undefined {
  return typeof provider === 'string' ? canonicalProvider(provider) : undefined;
}

export class ModelRegistry {
  #models = new Map<string, ModelDef>();
  /**
   * 已告警过的动态兜底模型 id。按实例去重：生产路径经 getModelRegistry() 单例访问，
   * 因此同一未登记模型在进程内只告警一次；独立 new 出来的注册表各自计数。
   */
  #warnedDynamicIds = new Set<string>();
  /**
   * resolve 遇到未知 provider 时已输出过 debug 诊断的值（按截断后的诊断值去重）。
   * 查询 API 的“查不到”是正常合同，只记一次，避免 ContextWindow 等高频调用方刷屏。
   */
  #notedUnknownProviders = new Set<string>();

  constructor() {
    for (const def of ALL_BUILTIN_MODELS) {
      this.#models.set(def.id, def);
    }
  }

  /** 精确查找: 'openai:gpt-5.5' */
  get(modelRef: string): ModelDef | undefined {
    return this.#models.get(modelRef);
  }

  /** 裸 apiModelId 查找(P1-B-3 quirk 解析用): 'deepseek-reasoner' → 首个匹配的 ModelDef。 */
  findByApiModelId(apiModelId: string): ModelDef | undefined {
    for (const m of this.#models.values()) {
      if (m.apiModelId === apiModelId) {
        return m;
      }
    }
    return undefined;
  }

  /**
   * 模糊查找: (provider='openai', apiModelId='gpt-5.5') → ModelDef
   *
   * provider 先归一（'gemini' → 'google'、'Anthropic' → 'claude'）。未知值（包括部署选择 'auto'）
   * 短路返回 undefined 并输出一次 debug 诊断：调用方据此改走 findByApiModelId 或自己的兜底。
   */
  resolve(provider: string, apiModelId: string): ModelDef | undefined {
    const providerId = toProviderId(provider);
    if (!providerId) {
      const value = providerLogValue(provider);
      if (!this.#notedUnknownProviders.has(value)) {
        this.#notedUnknownProviders.add(value);
        observeSafely(
          () =>
            logger().debug(
              `[ModelRegistry] unknown_provider op=resolve value=${value}; lookup short-circuited, returns undefined`
            ),
          () => undefined
        );
      }
      return undefined;
    }
    return this.#lookup(providerId, apiModelId);
  }

  /**
   * 智能解析 — 兼容旧配置
   *
   * 优先级: provider 归一 → 精确 id → provider+model 遍历匹配 → 动态定义。
   * 未知 provider 直接拒绝（code=LLM_INVALID_REQUEST，不重试、不计熔断）：
   * 旧实现会用 as 强转拼出 provider 非法的动态定义，下游再按该 provider 取 Transport 时才失败。
   */
  resolveOrCreate(provider: string, apiModelId: string): ModelDef {
    const providerId = toProviderId(provider);
    if (!providerId) {
      const value = providerLogValue(provider);
      observeSafely(
        () =>
          logger().warn(
            `[ModelRegistry] unknown_provider op=resolveOrCreate value=${value}; rejected, no dynamic definition created`
          ),
        () => undefined
      );
      throw Object.assign(new Error(`Unknown AI provider: ${value}`), {
        code: 'LLM_INVALID_REQUEST',
      });
    }
    const registered = this.#lookup(providerId, apiModelId);
    if (registered) {
      return registered;
    }
    // 降级路径：未登记模型拿到保守默认（固定 contextWindow / maxOutputTokens），
    // 调用方请求的 maxTokens 会被 ParameterGuard 截到该上限。按 id 去重 warn 一次，
    // 让“输出被截断 → JSON 解析失败”能追溯到“模型未登记”这一根因。
    const def = this.createDynamicDef(providerId, apiModelId);
    if (!this.#warnedDynamicIds.has(def.id)) {
      this.#warnedDynamicIds.add(def.id);
      const message = `[ModelRegistry] dynamic_model_def model=${def.id} contextWindow=${def.contextWindow} maxOutputTokens=${def.maxOutputTokens}; path=conservative_defaults (model not registered)`;
      observeSafely(
        () => logger().warn(message),
        () => undefined
      );
    }
    return def;
  }

  /** 已归一 provider 下的查找：先按 'provider:apiModelId' 直取，再遍历兼容 id 形状不同的运行时注册。 */
  #lookup(providerId: ProviderId, apiModelId: string): ModelDef | undefined {
    const direct = this.#models.get(`${providerId}:${apiModelId}`);
    if (direct) {
      return direct;
    }
    for (const m of this.#models.values()) {
      if (m.provider === providerId && m.apiModelId === apiModelId) {
        return m;
      }
    }
    return undefined;
  }

  /** 列出指定 provider 的所有模型 */
  listByProvider(provider: string): ModelDef[] {
    return [...this.#models.values()].filter((m) => m.provider === provider && !m.deprecated);
  }

  /** 列出所有非废弃模型 */
  listActive(): ModelDef[] {
    return [...this.#models.values()].filter((m) => !m.deprecated);
  }

  /** 按能力查询 */
  findByCapability(cap: keyof ModelDef['capabilities']): ModelDef[] {
    return [...this.#models.values()].filter((m) => m.capabilities[cap] && !m.deprecated);
  }

  /** 获取上下文窗口（经 resolve，provider 同样先归一；ContextWindow 未命中注册表时仍回退其正则表）。 */
  getContextWindow(provider: string, apiModelId: string): number | undefined {
    return this.resolve(provider, apiModelId)?.contextWindow;
  }

  /** 运行时注册自定义模型 */
  register(def: ModelDef): void {
    this.#models.set(def.id, def);
  }

  /** 注册数量 */
  get size(): number {
    return this.#models.size;
  }

  /** 为未注册模型创建保守的默认定义 */
  createDynamicDef(provider: ProviderId, apiModelId: string): ModelDef {
    return {
      id: `${provider}:${apiModelId}`,
      displayName: apiModelId,
      provider,
      apiModelId,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: {
        toolCalling: true,
        vision: false,
        embedding: false,
        jsonMode: false,
        streaming: true,
      },
      reasoning: { supported: false },
      parameterConstraints: {
        temperature: { allowed: true, min: 0, max: 2 },
        toolChoice: { allowed: true },
      },
    };
  }
}

/** 全局单例 */
let _instance: ModelRegistry | null = null;

export function getModelRegistry(): ModelRegistry {
  if (!_instance) {
    _instance = new ModelRegistry();
  }
  return _instance;
}
