/**
 * ModelRegistry — 模型能力注册中心
 *
 * 统一管理所有 LLM 模型的能力声明、约束条件和容量信息。
 * 替代 ContextWindow.MODEL_CONTEXT_WINDOWS 正则表和各 Provider 中的硬编码判断。
 *
 * 消费方:
 *   - ContextWindow: 查询上下文窗口
 *   - ParameterGuard: 查询参数约束
 *   - Host UI / Routes: 查询可用模型列表
 *   - Provider: 查询模型推理能力
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
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

export class ModelRegistry {
  #models = new Map<string, ModelDef>();
  /**
   * 已告警过的动态兜底模型 id。按实例去重：生产路径经 getModelRegistry() 单例访问，
   * 因此同一未登记模型在进程内只告警一次；独立 new 出来的注册表各自计数。
   */
  #warnedDynamicIds = new Set<string>();

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

  /** 模糊查找: (provider='openai', apiModelId='gpt-5.5') → ModelDef */
  resolve(provider: string, apiModelId: string): ModelDef | undefined {
    // 先尝试直接组合
    const direct = this.#models.get(`${provider}:${apiModelId}`);
    if (direct) {
      return direct;
    }
    // 回退到遍历匹配
    for (const m of this.#models.values()) {
      if (m.provider === provider && m.apiModelId === apiModelId) {
        return m;
      }
    }
    return undefined;
  }

  /**
   * 智能解析 — 兼容旧配置
   *
   * 优先级: 精确匹配 → provider+model 组合 → 动态定义
   */
  resolveOrCreate(provider: string, apiModelId: string): ModelDef {
    const registered = this.resolve(provider, apiModelId);
    if (registered) {
      return registered;
    }
    // 降级路径：未登记模型拿到保守默认（固定 contextWindow / maxOutputTokens），
    // 调用方请求的 maxTokens 会被 ParameterGuard 截到该上限。按 id 去重 warn 一次，
    // 让“输出被截断 → JSON 解析失败”能追溯到“模型未登记”这一根因。
    const def = this.createDynamicDef(provider as ProviderId, apiModelId);
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

  /** 获取上下文窗口 (替代 ContextWindow.MODEL_CONTEXT_WINDOWS) */
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
