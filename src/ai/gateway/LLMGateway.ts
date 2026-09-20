/**
 * LLMGateway — 统一 LLM 调用网关
 *
 * 职责链: resolve model → guard params → delegate to transport → normalize response
 *
 * 消费方只需:
 *   gateway.chatWithTools({ modelRef: 'deepseek:deepseek-v4-flash', ... })
 *
 * Gateway 内部自动完成:
 *   1. ModelRegistry.resolveOrCreate() → ModelDef
 *   2. ParameterGuard.guard() → 安全参数
 *   3. Transport.chatWithTools() → 厂商 API 调用
 *   4. 响应归一化 → ChatWithToolsResult
 */

import Logger from '@alembic/core/logging';
import type {
  ChatWithToolsResult,
  FunctionCallResult,
  LlmCallOptions,
  TokenUsage,
  ToolSchema,
  UnifiedMessage,
} from '../contracts.js';
import { LlmResponseError, throwIfLlmCancelled } from '../errors.js';
import { ParameterGuard } from '../guard/ParameterGuard.js';
import type { ModelDef, ProviderId } from '../registry/ModelDefs.js';
import { getModelRegistry } from '../registry/ModelRegistry.js';
import { ReliabilityController } from '../shared/reliability.js';
import { parseSchemaOutput, prepareStructuredValidation } from '../shared/schemaValidation.js';
import { extractJSON } from '../shared/structuredOutput.js';
import { ClaudeTransport } from '../transport/ClaudeTransport.js';
import { DeepSeekTransport } from '../transport/DeepSeekTransport.js';
import { GoogleTransport } from '../transport/GoogleTransport.js';
import type {
  LLMTransport,
  TransportConfig,
  TransportRequest,
  TransportResponse,
} from '../transport/LLMTransport.js';
import { OpenAiTransport } from '../transport/OpenAiTransport.js';

// AD4: lazy logger accessor — the Core logger singleton materializes on first
// use instead of at module import (no import-time work; same singleton).
const logger = () => Logger.getInstance();

// ─── Gateway Request ────────────────────────────────────

export interface GatewayRequest {
  /** 模型引用: 'provider:model' 或 纯 model id */
  modelRef: string;
  messages: UnifiedMessage[];
  systemPrompt?: string;

  tools?: ToolSchema[];
  toolChoice?: string;

  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;

  responseFormat?: 'text' | 'json';
  schema?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /** 用量上报来源标签（用于成本归类）。 */
  usageSource?: string;
}

export interface GatewayChatRequest {
  modelRef: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  /** JSON Schema — 供原生结构化输出（如 Gemini responseSchema）。 */
  schema?: Record<string, unknown>;
  /** chatStructured 容错提取的边界起始符，默认 '{'。 */
  openChar?: string;
  /** chatStructured 容错提取的边界终止符，默认 '}'。 */
  closeChar?: string;
  abortSignal?: AbortSignal;
  /** 用量上报来源标签（用于成本归类）。 */
  usageSource?: string;
}

// ─── Gateway Config ─────────────────────────────────────

export interface GatewayConfig {
  /** Provider API keys and base URLs */
  providers?: Partial<Record<ProviderId, TransportConfig>>;
  /** Global timeout override */
  timeout?: number;
  /** 每个 provider 的最大重试次数（默认 3），由 ReliabilityController 消费。 */
  maxRetries?: number;
  /** 触发熔断的连续服务端失败次数（默认 5）。 */
  circuitThreshold?: number;
  /** 并发上限（默认 ALEMBIC_AI_MAX_CONCURRENCY 或 4）。 */
  maxConcurrency?: number | string;
  /**
   * Token 用量回调 — 每次成功调用后触发，驱动全局预算 / 成本统计。
   * 与 AiProvider._onTokenUsage 对齐，由外部（如 DI 容器）注入。
   */
  onUsage?: (usage: TokenUsage & { provider?: string; model?: string; source?: string }) => void;
}

// ─── LLMGateway ─────────────────────────────────────────

export class LLMGateway {
  #transports = new Map<ProviderId, LLMTransport>();
  #controllers = new Map<ProviderId, ReliabilityController>();
  #config: GatewayConfig;

  constructor(config: GatewayConfig = {}) {
    this.#config = config;
  }

  /**
   * 统一工具调用入口
   *
   * Gateway 自动完成: modelRef 解析 → ParameterGuard → Transport → 响应归一化
   */
  async chatWithTools(request: GatewayRequest): Promise<ChatWithToolsResult> {
    const { modelDef, providerId, apiModelId } = this.#resolveModel(request.modelRef);

    const guarded = ParameterGuard.guard(modelDef, {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      toolChoice: request.toolChoice,
      reasoningEffort: request.reasoningEffort,
    });

    if (guarded.filtered.length > 0) {
      logger().debug(
        `[LLMGateway] ${modelDef.displayName} filtered params: ${guarded.filtered.map((f) => `${f.param}(${f.reason})`).join(', ')}`
      );
    }

    const transport = this.#getTransport(providerId);
    const wasFiltered = (param: string) => guarded.filtered.some((f) => f.param === param);

    const transportReq: TransportRequest = {
      model: apiModelId,
      messages: request.messages,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      toolChoice: wasFiltered('toolChoice')
        ? undefined
        : (guarded.toolChoice ?? request.toolChoice),
      temperature: wasFiltered('temperature')
        ? undefined
        : (guarded.temperature ?? request.temperature),
      maxTokens: guarded.maxTokens ?? request.maxTokens,
      reasoningEffort: wasFiltered('reasoningEffort')
        ? undefined
        : (guarded.reasoningEffort ?? request.reasoningEffort),
      abortSignal: request.abortSignal,
      responseFormat: request.responseFormat,
      schema: request.schema,
    };

    let response: TransportResponse;
    try {
      response = await this.#runWithReliability(
        providerId,
        () => transport.chatWithTools(transportReq),
        request.abortSignal
      );
    } catch (err: unknown) {
      // 输出被拒绝不等于模型未执行：只记录 adapter 确认过的用量，不推测失败请求的成本。
      if (err instanceof LlmResponseError) {
        this.#emitUsage(err.usage, providerId, apiModelId, request.usageSource ?? 'chatWithTools');
      }
      throw err;
    }
    this.#emitUsage(response.usage, providerId, apiModelId, request.usageSource ?? 'chatWithTools');
    return this.#normalizeResponse(response);
  }

  /**
   * 简单 chat — 单轮对话，不含工具
   */
  async chat(request: GatewayChatRequest): Promise<string> {
    // 文本与结构化对话复用同一完整响应通道，避免丢失用量和可靠性行为。
    const response = await this.chatWithTools({
      ...request,
      messages: [{ role: 'user', content: request.prompt }],
      usageSource: request.usageSource ?? 'chat',
    });
    return response.text || '';
  }

  /**
   * Structured JSON output
   *
   * 稳健解析：复用 shared/extractJSON（去 markdown 围栏 + 容错 + 截断修复），
   * 替代原先脆弱的 JSON.parse(text)，与 Provider 层 chatWithStructuredOutput 一致。
   */
  async chatStructured(request: GatewayChatRequest): Promise<unknown> {
    throwIfLlmCancelled(request.abortSignal);
    const validate = prepareStructuredValidation(request.schema, (level, message) =>
      this.#log(level, message)
    );
    if (!validate) {
      return null;
    }
    const text = await this.chat({ ...request, responseFormat: 'json' });
    if (!text || text.trim().length === 0) {
      return null;
    }
    if (request.schema !== undefined) {
      return parseSchemaOutput(text, validate, (level, message) => this.#log(level, message));
    }
    const value = extractJSON(
      text,
      request.openChar ?? '{',
      request.closeChar ?? '}',
      (level, message) => this.#log(level, message)
    );
    return validate(value) ? value : null;
  }

  /**
   * Embedding
   */
  async embed(modelRef: string, texts: string[], opts: LlmCallOptions = {}): Promise<number[][]> {
    const { providerId } = this.#resolveModel(modelRef);
    const transport = this.#getTransport(providerId);
    return this.#runWithReliability(
      providerId,
      () => transport.embed(texts, opts),
      opts.abortSignal
    );
  }

  /**
   * 获取模型定义（供外部查询能力）
   */
  getModelDef(modelRef: string): ModelDef {
    return this.#resolveModel(modelRef).modelDef;
  }

  /**
   * 探测某模型是否可用（轻量 chat），用于 fallback 决策。
   * 普通失败返回 false；取消必须终止探活链，不能继续请求下一模型。
   */
  async probe(modelRef: string, opts: LlmCallOptions = {}): Promise<boolean> {
    try {
      const text = await this.chat({
        modelRef,
        prompt: 'ping',
        maxTokens: 16,
        temperature: 0,
        usageSource: 'probe',
        abortSignal: opts.abortSignal,
      });
      return Boolean(text);
    } catch (err: unknown) {
      throwIfLlmCancelled(opts.abortSignal, err);
      this.#log('warn', `[LLMGateway] probe(${modelRef}) failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 按候选模型链探活降级：返回第一个可用的 modelRef。
   * 与 Provider 层 getProviderWithFallback 思路一致，但统一在网关侧完成。
   */
  async resolveWithFallback(
    candidates: string[],
    opts: LlmCallOptions = {}
  ): Promise<string | null> {
    for (const modelRef of candidates) {
      if (await this.probe(modelRef, opts)) {
        return modelRef;
      }
    }
    return null;
  }

  // ─── Model Resolution ─────────────────────────────────

  #resolveModel(modelRef: string): {
    modelDef: ModelDef;
    providerId: ProviderId;
    apiModelId: string;
  } {
    const registry = getModelRegistry();

    const providerSeparator = modelRef.indexOf(':');
    if (providerSeparator > 0) {
      const provider = modelRef.slice(0, providerSeparator);
      const model = modelRef.slice(providerSeparator + 1);
      const modelDef = registry.resolveOrCreate(provider as ProviderId, model);
      return {
        modelDef,
        providerId: modelDef.provider,
        apiModelId: modelDef.apiModelId,
      };
    }

    const modelDef = registry.get(modelRef);
    if (modelDef) {
      return {
        modelDef,
        providerId: modelDef.provider,
        apiModelId: modelDef.apiModelId,
      };
    }

    const guessed = this.#guessProvider(modelRef);
    const resolved = registry.resolveOrCreate(guessed, modelRef);
    return {
      modelDef: resolved,
      providerId: resolved.provider,
      apiModelId: resolved.apiModelId,
    };
  }

  #guessProvider(model: string): ProviderId {
    if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
      return 'openai';
    }
    if (model.startsWith('claude-')) {
      return 'claude';
    }
    if (model.startsWith('deepseek-')) {
      return 'deepseek';
    }
    if (model.startsWith('gemini-')) {
      return 'google';
    }
    return 'openai';
  }

  // ─── Reliability & Observability ──────────────────────

  /** 桥接 core Logger（控制器 / 结构化提取的日志回调）。 */
  #log(level: string, message: string): void {
    const fn = (logger() as unknown as Record<string, (msg: string) => void>)[level];
    if (typeof fn === 'function') {
      fn.call(logger(), message);
    }
  }

  /** 每个 provider 独立的可靠性控制器（熔断 / 并发 / 限流隔离）。 */
  #getController(providerId: ProviderId): ReliabilityController {
    let controller = this.#controllers.get(providerId);
    if (controller) {
      return controller;
    }
    controller = new ReliabilityController({
      maxRetries: this.#config.maxRetries,
      circuitThreshold: this.#config.circuitThreshold,
      maxConcurrency: this.#config.maxConcurrency,
      label: providerId,
      onLog: (level, message) => this.#log(level, message),
    });
    this.#controllers.set(providerId, controller);
    return controller;
  }

  /** 在 provider 级可靠性包裹（重试 / 熔断 / 并发 / 限流）下执行 Transport 调用。 */
  #runWithReliability<T>(
    providerId: ProviderId,
    fn: () => Promise<T>,
    abortSignal?: AbortSignal | null
  ): Promise<T> {
    return this.#getController(providerId).run(fn, undefined, undefined, { abortSignal });
  }

  /** 触发 token 用量回调，驱动全局预算 / 成本统计。回调异常不影响主流程。 */
  #emitUsage(
    usage: TokenUsage | null | undefined,
    provider: string,
    model: string,
    source: string
  ): void {
    if (!usage || !this.#config.onUsage) {
      return;
    }
    const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (total === 0) {
      return;
    }
    try {
      this.#config.onUsage({ ...usage, provider, model, source });
    } catch {
      /* token tracking should never break execution */
    }
  }

  // ─── Transport Lifecycle ──────────────────────────────

  #getTransport(providerId: ProviderId): LLMTransport {
    let transport = this.#transports.get(providerId);
    if (transport) {
      return transport;
    }

    const config = this.#resolveTransportConfig(providerId);
    transport = this.#createTransport(providerId, config);
    this.#transports.set(providerId, transport);
    return transport;
  }

  #createTransport(providerId: ProviderId, config: TransportConfig): LLMTransport {
    switch (providerId) {
      case 'openai':
        return new OpenAiTransport(config);
      case 'claude':
        return new ClaudeTransport(config);
      case 'deepseek':
        return new DeepSeekTransport(config);
      case 'google':
        return new GoogleTransport(config);
      case 'ollama':
        return new OpenAiTransport(
          {
            ...config,
            apiKey: config.apiKey || 'ollama',
            baseUrl: config.baseUrl || 'http://127.0.0.1:11434/v1',
          },
          'ollama'
        );
      default:
        logger().warn(
          `[LLMGateway] Unknown provider '${providerId}', falling back to OpenAI transport`
        );
        return new OpenAiTransport(config);
    }
  }

  #resolveTransportConfig(providerId: ProviderId): TransportConfig {
    const explicit = this.#config.providers?.[providerId];
    if (explicit?.apiKey) {
      return { ...explicit, timeout: this.#config.timeout ?? explicit.timeout };
    }

    const envMap: Record<string, { key: string; base?: string }> = {
      openai: { key: 'ALEMBIC_OPENAI_API_KEY', base: 'ALEMBIC_OPENAI_BASE_URL' },
      claude: { key: 'ALEMBIC_CLAUDE_API_KEY', base: 'ALEMBIC_CLAUDE_BASE_URL' },
      deepseek: { key: 'ALEMBIC_DEEPSEEK_API_KEY', base: 'ALEMBIC_DEEPSEEK_BASE_URL' },
      google: { key: 'ALEMBIC_GOOGLE_API_KEY', base: 'ALEMBIC_GOOGLE_BASE_URL' },
      ollama: { key: '', base: 'ALEMBIC_OLLAMA_BASE_URL' },
    };

    const env = envMap[providerId] || { key: '' };
    const { apiKey: _discardedKey, ...explicitRest } = explicit || ({} as TransportConfig);
    return {
      ...explicitRest,
      apiKey: (env.key ? process.env[env.key] : undefined) || '',
      baseUrl: (env.base ? process.env[env.base] : undefined) || explicit?.baseUrl,
      timeout: this.#config.timeout ?? explicit?.timeout,
    };
  }

  // ─── Response Normalization ───────────────────────────

  #normalizeResponse(response: TransportResponse): ChatWithToolsResult {
    const functionCalls: FunctionCallResult[] | null = response.functionCalls
      ? response.functionCalls.map((fc) => ({
          id: fc.id,
          name: fc.name,
          args: fc.args,
          thoughtSignature: fc.thoughtSignature,
        }))
      : null;

    const usage: TokenUsage | null = response.usage;

    return {
      text: response.text,
      functionCalls,
      usage,
      reasoningContent: response.reasoningContent ?? undefined,
      continuation: response.continuation,
      finishReason: response.finishReason ?? undefined,
    };
  }
}

// ─── Singleton ──────────────────────────────────────────

let _gateway: LLMGateway | null = null;

/**
 * 获取共享 LLMGateway 单例。
 *
 * 修复历史 bug：旧实现只在首次调用时应用 config，后续传入的 config 被静默忽略。
 * 现在只要显式传入 config，就重建实例以应用最新配置；不传则复用既有单例。
 */
export function getLLMGateway(config?: GatewayConfig): LLMGateway {
  if (config) {
    _gateway = new LLMGateway(config);
  } else if (!_gateway) {
    _gateway = new LLMGateway();
  }
  return _gateway;
}

export function resetLLMGateway(): void {
  _gateway = null;
}
