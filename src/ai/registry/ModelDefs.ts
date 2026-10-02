/**
 * ModelDef — LLM 模型能力声明式定义
 *
 * 所有模型的能力、约束、容量信息集中在此接口描述。
 * 消费方（ContextWindow、ParameterGuard、Gateway、Host UI / Routes）
 * 统一从 ModelRegistry 查询，而非各自硬编码。
 *
 * 执行语义边界：真正改写请求的只有 maxOutputTokens、parameterConstraints 与
 * reasoning.defaultEffort（经 ParameterGuard）。capabilities、deprecated、
 * reasoning.effortLevels、reasoning.requiresContentPassback 是描述性元数据：
 * LLMGateway 不据此迁移模型、拒绝请求或剥离 tools，最多输出诊断告警。
 */

export type ProviderId = 'openai' | 'deepseek' | 'claude' | 'google' | 'ollama';

export interface ModelDef {
  /** 唯一标识: provider:apiModelId */
  id: string;
  displayName: string;
  provider: ProviderId;
  /** 实际 API 调用使用的模型 ID */
  apiModelId: string;

  // ── 容量 ──
  contextWindow: number;
  maxOutputTokens: number;

  // ── 能力标记 ──
  /**
   * 描述性能力声明，供列表过滤与诊断使用。Gateway 不据此门控请求：
   * 例如 toolCalling=false 时 tools 仍照常下发，只输出一次 tool_calling_unsupported 告警。
   */
  capabilities: ModelCapabilities;

  // ── 推理/思维 ──
  reasoning: ReasoningSpec;

  // ── 参数约束 ──
  parameterConstraints: ParameterConstraints;

  /**
   * 废弃标记（描述性元数据）。ModelRegistry 的列表方法据此隐藏模型；Gateway 命中时只按
   * retireDate 是否已过输出一次 deprecated_model_retired / deprecated_model_scheduled 告警，
   * 请求仍按原模型发出，不会自动迁移到 migrateToId。
   */
  deprecated?: { retireDate: string; migrateToId: string };
}

export interface ModelCapabilities {
  toolCalling: boolean;
  vision: boolean;
  embedding: boolean;
  jsonMode: boolean;
  streaming: boolean;
}

export interface ReasoningSpec {
  supported: boolean;
  /** thinking: DeepSeek/Claude extended, adaptive: Opus 4.7, reasoning_effort: OpenAI */
  mode?: 'thinking' | 'adaptive' | 'reasoning_effort';
  /**
   * 多轮对话需要回传 reasoning_content (DeepSeek V4)。
   * 描述性元数据，当前不参与执行：回传与否由各 Transport 的实现决定。
   */
  requiresContentPassback?: boolean;
  /** ParameterGuard 在 reasoningEffort 取值非法时用它作为替换值。 */
  defaultEffort?: string;
  /**
   * 描述性元数据，当前不参与执行：effort 是否被接受以 parameterConstraints.reasoningEffort 为准。
   */
  effortLevels?: string[];
}

export interface ParameterConstraints {
  temperature?: ParameterRule<number>;
  topP?: ParameterRule<number>;
  topK?: ParameterRule<number>;
  toolChoice?: ParameterRule<string>;
  reasoningEffort?: ParameterRule<string>;
}

export interface ParameterRule<T> {
  allowed: boolean;
  /** 过滤该参数时写入诊断日志的具体原因 */
  reason?: string;
  /** 条件禁用 (如 'thinking' = thinking 模式下不允许) */
  disabledWhen?: string;
  defaultValue?: T;
  min?: T;
  max?: T;
  allowedValues?: T[];
}

/** Provider 配置 */
export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  /** 默认模型的 ModelDef.id */
  defaultModelId: string;
  keyEnvVar: string;
  baseUrlEnvVar?: string;
  baseUrl: string;
}
