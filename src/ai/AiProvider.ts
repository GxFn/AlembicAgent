/**
 * AiProvider - AI 提供商抽象基类
 * 所有具体 Provider 必须实现这3个方法
 */

import { LanguageService } from '@alembic/core/shared';
import type { GatewayConfig, LLMGateway } from './gateway/LLMGateway.js';
import { classifyLlmError } from './shared/errorClassify.js';
import { extractJSON as sharedExtractJSON } from './shared/structuredOutput.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Loose JSON record for external API responses (inherently untyped) */
// biome-ignore lint: API responses are dynamic JSON
export type ApiResponse = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** AI provider 构造配置 */
export interface AiProviderConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  circuitThreshold?: number;
  maxConcurrency?: number | string;
  name?: string;
  embedModel?: string;
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

function isProviderCircuitOpen(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): boolean {
  return state === 'OPEN';
}

/** Provider 缺 key 统一错误；只给 host-neutral 元数据，具体 UI 指引由宿主渲染。 */
export interface MissingApiKeyError extends Error {
  code: 'API_KEY_MISSING';
  provider: string;
  envVar: string;
  hostAction: 'configure-provider-credential';
}

export function createMissingApiKeyError(
  label: string,
  envVar: string,
  provider: string
): MissingApiKeyError {
  const err = new Error(
    `${label} API Key 未配置。请在宿主环境或 Alembic 运行配置中设置 ${envVar}。`
  ) as MissingApiKeyError;
  err.code = 'API_KEY_MISSING';
  err.provider = provider;
  err.envVar = envVar;
  err.hostAction = 'configure-provider-credential';
  return err;
}

/** 对话历史条目 */
export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/** 对话上下文选项 */
export interface ChatContext {
  history?: ChatHistoryEntry[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** 统一消息格式 */
export interface UnifiedMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  /** DeepSeek V4 thinking / 推理内容，多轮对话需原样回传 */
  reasoningContent?: string | null;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    thoughtSignature?: string;
  }>;
  toolCallId?: string;
  name?: string;
}

/** 工具 schema */
export interface ToolSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** chatWithTools 选项 */
export interface ChatWithToolsOptions {
  messages?: UnifiedMessage[];
  toolSchemas?: ToolSchema[];
  toolChoice?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** 外部中止信号 — hard timeout 时取消进行中的 LLM 请求 */
  abortSignal?: AbortSignal;
}

/** 函数调用结果 */
export interface FunctionCallResult {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

/** chatWithTools 返回值 */
export interface ChatWithToolsResult {
  text: string | null;
  functionCalls: FunctionCallResult[] | null;
  usage?: TokenUsage | null;
  /** DeepSeek V4 thinking 模式返回的推理内容 */
  reasoningContent?: string | null;
  /** Provider stop reason，例如 DeepSeek/OpenAI finish_reason */
  finishReason?: string | null;
}

/** Token 用量 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** V4 thinking 模式消耗的推理 token (包含在 outputTokens 内) */
  reasoningTokens?: number;
  /** V4 prompt 缓存命中 token 数 */
  cacheHitTokens?: number;
}

/** chatWithStructuredOutput 选项 */
export interface StructuredOutputOptions {
  schema?: Record<string, unknown>;
  openChar?: string;
  closeChar?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** AD5 embedding 容量提示的取值来源 */
export type EmbeddingCapacityHintSource =
  | 'provider-config'
  | 'environment'
  | 'conservative-default';

/**
 * AD5 embedding 容量提示（只读）。
 * Agent transport 层向外部批处理消费者（Core BatchEmbedder 经注入的
 * provider 对象读取）暴露本 provider 实例的真实请求闸门；
 * 只暴露信息，不改变任何节流行为。
 */
export interface EmbeddingCapacityHint {
  /** Provider 名称（如 'openai' / 'google'） */
  provider: string;
  /** 建议的最大并发 embedding 请求数 = 本实例的并发闸门值 */
  maxInFlightEmbeddings: number;
  /** 取值来源 */
  source: EmbeddingCapacityHintSource;
}

// AiProvider.enrichCandidates (with its EnrichOptions/EnrichCandidate types and
// prompt builders) was deleted under the Train B DCR default-delete lineage: its
// last caller, the Alembic resident alembic_enrich_candidates surface, was
// removed in the pB1 DCR commit and a fresh five-repo scan found zero consumers.

/** 文件内容条目（用于语言检测） */
export interface FileContentEntry {
  name?: string;
  [key: string]: unknown;
}

/** 语言 profile */
export interface LanguageProfile {
  primaryLanguage: string;
  role: string;
  patternExamples: string;
  extractionExamples: string;
  categories: string;
}

/** Logger 接口 — 兼容 winston.Logger 实例 */
export interface AiLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  [key: string]: unknown;
}

export class AiProvider {
  _activeRequests: number;
  _circuitCooldownMs: number;
  _circuitFailures: number;
  _circuitOpenedAt: number;
  _circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  _circuitThreshold: number;
  _maxConcurrency: number;
  _maxConcurrencySource: EmbeddingCapacityHintSource;
  _rateLimitedUntil: number;
  _requestQueue: Array<(value?: unknown) => void>;
  apiKey: string;
  baseUrl: string;
  logger: AiLogger | null = null;
  maxRetries: number;
  model: string;
  name: string;
  timeout: number;
  _fallbackFrom?: string;

  /**
   * Token 用量回调 — 每次 API 调用后触发（包括 chat / chatWithStructuredOutput / chatWithTools）
   * 由外部（如 DI 容器）注入以实现全局 token 计量。
   */
  _onTokenUsage: ((usage: TokenUsage & { source?: string }) => void) | null = null;

  /** 协议下沉 transport 后，本 provider 专属的 LLMGateway 实例（lazy 构造）。 */
  #gateway: LLMGateway | null = null;

  /**
   * Provider 特有的 transport 扩展配置（如 apiStyle / reasoningEffort / embedModel）。
   * 子类在 super() 之后设置，透传给 gateway → transport，供下沉后的协议层消费。
   */
  _transportExtras: Record<string, unknown> = {};

  constructor(config: AiProviderConfig = {}) {
    this.model = config.model || '';
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || '';
    this.timeout = config.timeout || 300_000; // 5min
    this.maxRetries = config.maxRetries || 3;
    this.name = 'abstract';

    // ── CircuitBreaker 状态 ──
    this._circuitState = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    this._circuitFailures = 0; // 连续失败计数
    this._circuitThreshold = config.circuitThreshold || 5; // 触发熔断的连续失败次数
    this._circuitOpenedAt = 0; // 熔断打开时间
    this._circuitCooldownMs = 30_000; // 初始冷却 30 秒

    // ── Provider 级全局并发闸门 + 429 冷却窗 ──
    this._maxConcurrency = Math.max(
      1,
      Number(config.maxConcurrency || process.env.ALEMBIC_AI_MAX_CONCURRENCY || 4)
    );
    // AD5: 与上面的取值链并行记录来源（不改变取值计算本身），供容量提示溯源。
    this._maxConcurrencySource = config.maxConcurrency
      ? 'provider-config'
      : process.env.ALEMBIC_AI_MAX_CONCURRENCY
        ? 'environment'
        : 'conservative-default';
    this._activeRequests = 0;
    this._requestQueue = [];
    this._rateLimitedUntil = 0;
  }

  async _acquireRequestSlot() {
    if (this._activeRequests < this._maxConcurrency) {
      this._activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve) => this._requestQueue.push(() => resolve()));
  }

  _releaseRequestSlot() {
    const next = this._requestQueue.shift();
    if (next) {
      next();
      return;
    }
    this._activeRequests = Math.max(0, this._activeRequests - 1);
  }

  async _waitForRateLimitWindow() {
    const waitMs = (this._rateLimitedUntil || 0) - Date.now();
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  _setRateLimitWindow(waitMs: number) {
    const safeWait = Math.max(0, Number(waitMs) || 0);
    if (safeWait <= 0) {
      return;
    }
    const until = Date.now() + safeWait;
    if (until > (this._rateLimitedUntil || 0)) {
      this._rateLimitedUntil = until;
      this._log?.(
        'warn',
        `[RateLimit] ${this.name} enters cooldown ${Math.round(safeWait / 1000)}s (global)`
      );
    }
  }

  /**
   * 对话 - 发送 prompt + context，返回文本响应
   * @param context {history: [], temperature, maxTokens}
   */
  async chat(prompt: string, context: ChatContext = {}): Promise<string> {
    throw new Error(`${this.name}.chat() not implemented`);
  }

  /**
   * 从 API 原始响应中提取 token 用量并触发回调。
   * 子类在 chat() / chatWithStructuredOutput() 中调用。
   */
  _emitTokenUsage(usage: TokenUsage | null | undefined, source?: string) {
    if (!usage || !this._onTokenUsage) {
      return;
    }
    const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (total === 0) {
      return;
    }
    try {
      this._onTokenUsage({ ...usage, source });
    } catch {
      /* token tracking should never break execution */
    }
  }

  /** 摘要 - 对代码/文档生成结构化摘要 */
  async summarize(code: string): Promise<unknown> {
    throw new Error(`${this.name}.summarize() not implemented`);
  }

  /** 向量嵌入 - 返回浮点数组 */
  async embed(text: string | string[]): Promise<number[] | number[][]> {
    throw new Error(`${this.name}.embed() not implemented`);
  }

  /**
   * 探测 provider 是否可用（轻量级 API 调用验证连接性）
   * 子类可覆盖实现更具体的探测逻辑
   */
  async probe() {
    const result = await this.chat('ping', { maxTokens: 16, temperature: 0 });
    return !!result;
  }

  /** 检查是否支持 embedding */
  supportsEmbedding(): boolean {
    return true;
  }

  /**
   * AD5 embedding 容量提示（只读）— 暴露本实例的真实请求闸门，供 Core
   * BatchEmbedder 等外部批处理消费者替代硬编码并发值；不改变节流行为。
   * 各 provider 提示值与来源：基类链 config.maxConcurrency（provider-config）
   * → ALEMBIC_AI_MAX_CONCURRENCY（environment）→ 保守默认 4
   * （conservative-default）；GoogleGeminiProvider 默认 2（规避 Google 配额，
   * 见其构造器注释），可被 ALEMBIC_GEMINI_MAX_CONCURRENCY 或显式配置覆盖。
   */
  getEmbeddingCapacityHint(): EmbeddingCapacityHint {
    return Object.freeze({
      provider: this.name,
      maxInFlightEmbeddings: this._maxConcurrency,
      source: this._maxConcurrencySource,
    });
  }

  /**
   * 是否支持原生结构化函数调用（非文本解析）
   * 子类（如 GoogleGeminiProvider）覆盖返回 true
   */
  get supportsNativeToolCalling(): boolean {
    return false;
  }

  /**
   * 带工具声明的结构化对话 — 原生函数调用 API
   *
   * 支持原生函数调用的 Provider（Gemini / OpenAI / Claude）覆盖此方法,
   * 返回结构化 functionCall 而非文本，AgentRuntime 据此跳过正则解析。
   *
   * 默认实现降级为 chat()，由 AgentRuntime 进行文本解析。
   *
   * 统一消息格式 (Provider-Agnostic):
   *   - { role: 'user', content: 'text' }
   *   - { role: 'assistant', content: 'text or null', toolCalls: [{id, name, args}] }
   *   - { role: 'tool', toolCallId: 'id', name: 'tool_name', content: 'result string' }
   *
   * @param prompt 用户消息（仅在 messages 为空时使用）
   * @param opts.messages 统一格式消息历史
   * @param opts.toolSchemas [{name, description, parameters}]
   * @param opts.toolChoice 'auto' | 'required' | 'none'
   * @param [opts.systemPrompt] 系统指令
   * @returns >|null}>}
   */
  async chatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    // 默认降级: 忽略 tools/toolChoice，走纯文本 chat()
    const messages = (opts.messages || []) as UnifiedMessage[];
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content || '',
      }));
    const text = await this.chat(prompt, {
      history,
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    return { text, functionCalls: null };
  }

  /**
   * Structured Output — 请求 AI 返回严格 JSON 格式响应
   *
   * 子类覆盖以利用原生 JSON mode:
   *   - Gemini: responseMimeType: 'application/json' + responseSchema
   *   - OpenAI: response_format: { type: 'json_object' }
   *   - Claude: 无原生支持，使用默认实现 (chat + extractJSON)
   *
   * @param prompt 完整提示词（应包含返回 JSON 的指令）
   * @param [opts.schema] JSON Schema（Gemini/OpenAI 的 structured output 用）
   * @param [opts.openChar='{'] extractJSON 边界起始符（fallback 用）
   * @param [opts.closeChar='}'] extractJSON 边界终止符
   * @param [opts.systemPrompt] 可选系统指令
   * @returns 解析后的 JSON 对象/数组，解析失败返回 null
   */
  async chatWithStructuredOutput(
    prompt: string,
    opts: StructuredOutputOptions = {}
  ): Promise<unknown> {
    const response = await this.chat(prompt, {
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 32768,
      systemPrompt: opts.systemPrompt,
    });
    if (!response || response.trim().length === 0) {
      return null;
    }
    const openChar = opts.openChar || '{';
    const closeChar = opts.closeChar || '}';
    return this.extractJSON(response, openChar, closeChar);
  }

  // ─── Gateway 委托（方案①：协议下沉 transport，横切收敛 gateway）─────────────

  /** provider 级 modelRef（'name:model'），用于 gateway 路由。 */
  get _modelRef(): string {
    return `${this.name}:${this.model}`;
  }

  /**
   * lazy 构造 provider 专属 LLMGateway。
   *
   * 方案①核心：HTTP body 拼装与响应解析只保留在 transport 层；重试 / 熔断 / 并发闸门 /
   * 用量上报等横切能力由 gateway 的 ReliabilityController 统一提供，不再在各 Provider 重复实现。
   * onUsage 桥接回 this._emitTokenUsage，保持原 token 计量链路（DI 注入的 _onTokenUsage）不变。
   */
  async _getGateway(): Promise<LLMGateway> {
    if (this.#gateway) {
      return this.#gateway;
    }
    // 动态 import 打破 AiProvider ↔ LLMGateway/transport 的模块循环依赖（顶层仅保留 type import）。
    // 首次 chat 时所有模块已加载完毕，动态加载不会触发初始化死锁。
    const { LLMGateway } = await import('./gateway/LLMGateway.js');
    // this.name 即 ProviderId（openai/claude/deepseek/google/ollama）。
    const providers = {
      [this.name]: {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        timeout: this.timeout,
        ...this._transportExtras,
      },
    } as GatewayConfig['providers'];
    this.#gateway = new LLMGateway({
      providers,
      timeout: this.timeout,
      maxRetries: this.maxRetries,
      circuitThreshold: this._circuitThreshold,
      maxConcurrency: this._maxConcurrency,
      onUsage: (usage) => this._emitTokenUsage(usage, usage.source),
    });
    return this.#gateway;
  }

  /** 委托 gateway 的文本对话（支持历史消息）；横切能力由 gateway 统一处理。 */
  async _gatewayChat(prompt: string, context: ChatContext = {}): Promise<string> {
    const history = (context.history || []).map((h) => ({
      role: h.role,
      content: h.content || '',
    })) as UnifiedMessage[];
    const messages: UnifiedMessage[] = [...history, { role: 'user', content: prompt }];
    // gateway.chat 仅接受单 prompt，故经 chatWithTools（无 tools）以承载历史消息，再取 text。
    const result = await (await this._getGateway()).chatWithTools({
      modelRef: this._modelRef,
      messages,
      systemPrompt: context.systemPrompt,
      temperature: context.temperature ?? 0.7,
      maxTokens: context.maxTokens ?? 4096,
      usageSource: 'chat',
    });
    return result.text || '';
  }

  /** 委托 gateway 的工具调用对话（原生 functionCall）。 */
  async _gatewayChatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    const messages: UnifiedMessage[] =
      opts.messages && opts.messages.length > 0
        ? opts.messages
        : [{ role: 'user', content: prompt }];
    return (await this._getGateway()).chatWithTools({
      modelRef: this._modelRef,
      messages,
      tools: opts.toolSchemas,
      // 默认 'auto' 与各 Provider 原实现一致；DeepSeek 文本工具调用兼容解析依赖该值非空非 'none'。
      toolChoice: opts.toolChoice ?? 'auto',
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 4096,
      abortSignal: opts.abortSignal,
      usageSource: 'tools',
    });
  }

  /** 委托 gateway 的结构化 JSON 输出（gateway 内部 chat(json)+extractJSON，支持原生 schema）。 */
  async _gatewayChatWithStructuredOutput(
    prompt: string,
    opts: StructuredOutputOptions = {}
  ): Promise<unknown> {
    return (await this._getGateway()).chatStructured({
      modelRef: this._modelRef,
      prompt,
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 32768,
      schema: opts.schema,
      openChar: opts.openChar,
      closeChar: opts.closeChar,
      usageSource: 'structured',
    });
  }

  /** 委托 gateway 的向量嵌入；transport 依据 _transportExtras.embedModel 选择 embed 模型。 */
  async _gatewayEmbed(text: string | string[]): Promise<number[] | number[][]> {
    const isArray = Array.isArray(text);
    const texts = isArray ? (text as string[]) : [text as string];
    try {
      const embeddings = await (await this._getGateway()).embed(this._modelRef, texts);
      return isArray ? embeddings : embeddings[0] || [];
    } catch (err) {
      // embed 失败不应中断主流程：返回空向量，由上层决定降级策略（与原 Provider 行为一致）。
      this._log('warn', `[${this.name}] embed failed: ${(err as Error).message}`);
      return isArray ? [] : [];
    }
  }

  /** 内部日志辅助（子类可通过 this.logger 覆盖） */
  _log(level: string, message: string) {
    try {
      if (this.logger && typeof this.logger[level] === 'function') {
        this.logger[level](message);
      } else {
      }
    } catch {
      /* best effort */
    }
  }

  /** 根据文件扩展名检测语言特征，返回提示词适配参数 */
  _detectLanguageProfile(filesContent: FileContentEntry[]): LanguageProfile {
    const extCounts: Record<string, number> = {};
    for (const f of filesContent) {
      const ext = (f.name || '').split('.').pop()?.toLowerCase() || '';
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    }

    // 使用 LanguageService 推断主语言
    const primaryLang = LanguageService.detectPrimary(extCounts);
    const dominant =
      Object.entries(extCounts).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] || '';

    // iOS/macOS (Swift / Objective-C)
    if (primaryLang === 'swift' || primaryLang === 'objectivec') {
      return {
        primaryLanguage: primaryLang,
        role: 'Senior iOS/macOS Architect',
        patternExamples:
          'how to set up a ViewController, configure a TableView with delegate/datasource, build a login UI, handle network responses',
        extractionExamples: `Examples of good extractions:
- Complete \`init\` method with all tabBarItem/navigationItem configuration
- Complete \`viewDidLoad\` with all setup calls
- Complete \`setupUI\` method with subview creation and layout
- Complete UITableViewDataSource implementation
- Complete action handler method (e.g. loginButtonTapped)`,
        categories: 'View | Service | Tool | Model | Network | Storage | UI | Utility',
      };
    }

    // JavaScript / TypeScript
    if (primaryLang === 'javascript' || primaryLang === 'typescript') {
      return {
        primaryLanguage: primaryLang,
        role: 'Senior Software Engineer',
        patternExamples:
          'Express/Koa middleware, React component patterns, service class with dependency injection, data processing pipeline, error handling wrapper, factory/strategy patterns',
        extractionExamples: `Examples of good extractions:
- Complete class with constructor and key methods
- Express route handler with validation and error handling
- Utility function with edge case handling
- React component with hooks and event handlers
- Service method with retries and fallback logic`,
        categories: 'Service | Utility | Middleware | Component | Model | Config | Handler | Route',
      };
    }

    // Python
    if (primaryLang === 'python') {
      return {
        primaryLanguage: 'python',
        role: 'Senior Python Engineer',
        patternExamples:
          'Django/Flask views, data processing with pandas, async handlers, decorator patterns, class-based services',
        extractionExamples: `Examples of good extractions:
- Complete class with __init__ and key methods
- Decorator factory function
- API endpoint handler with request validation
- Data processing pipeline function
- Context manager implementation`,
        categories: 'Service | Utility | Model | View | Handler | Middleware | Config | Pipeline',
      };
    }

    // Go
    if (primaryLang === 'go') {
      return {
        primaryLanguage: 'go',
        role: 'Senior Go Engineer',
        patternExamples:
          'HTTP handler with middleware, goroutine patterns, interface implementations, struct methods with error handling',
        extractionExamples: `Examples of good extractions:
- Complete struct with constructor and methods
- HTTP handler function with error propagation
- Middleware function with context usage
- Interface implementation with all required methods`,
        categories: 'Service | Handler | Middleware | Model | Utility | Repository | Config',
      };
    }

    // Kotlin / Java
    if (primaryLang === 'kotlin' || primaryLang === 'java') {
      return {
        primaryLanguage: primaryLang,
        role: 'Senior Android/Backend Engineer',
        patternExamples:
          'Activity/Fragment lifecycle, repository pattern, ViewModel with LiveData, Retrofit service, dependency injection setup',
        extractionExamples: `Examples of good extractions:
- Complete class with constructor and key methods
- Repository with CRUD operations
- ViewModel with state management
- API service interface definition
- Custom view with measurement and drawing`,
        categories: 'View | Service | Repository | Model | Network | Storage | UI | Utility',
      };
    }

    // Rust
    if (primaryLang === 'rust') {
      return {
        primaryLanguage: 'rust',
        role: 'Senior Rust Engineer',
        patternExamples:
          'trait implementations, error handling with Result, async functions, builder patterns, iterator chains',
        extractionExamples: `Examples of good extractions:
- Complete impl block with key methods
- Trait implementation with all required methods
- Error type definition with From implementations
- Builder pattern struct and methods
- Async function with proper error handling`,
        categories: 'Service | Trait | Model | Handler | Utility | Config | Error | Pipeline',
      };
    }

    // Vue
    if (dominant === 'vue') {
      return {
        primaryLanguage: 'vue',
        role: 'Senior Frontend Engineer',
        patternExamples:
          'Vue component with composition API, composable functions, Vuex/Pinia store modules, router guards',
        extractionExamples: `Examples of good extractions:
- Complete Vue component with setup/template
- Composable function with reactive state
- Store module with actions and getters
- Custom directive implementation`,
        categories: 'Component | Composable | Store | Directive | Service | Utility | Config',
      };
    }

    // Ruby
    if (primaryLang === 'ruby') {
      return {
        primaryLanguage: 'ruby',
        role: 'Senior Ruby Engineer',
        patternExamples:
          'Rails controller actions, model concerns, service objects, background jobs, API serializers',
        extractionExamples: `Examples of good extractions:
- Complete controller with CRUD actions
- Service object with call method
- Model with validations and scopes
- Concern module with included block`,
        categories: 'Controller | Service | Model | Concern | Job | Serializer | Utility | Config',
      };
    }

    // Default / mixed
    return {
      primaryLanguage: dominant || 'unknown',
      role: 'Senior Software Engineer',
      patternExamples:
        'design patterns, service abstractions, data flow handling, error management, configuration setup',
      extractionExamples: `Examples of good extractions:
- Complete class/function with full implementation
- Service method with error handling and retries
- Configuration setup with all options
- Data processing pipeline`,
      categories: 'Service | Utility | Model | Handler | Config | Component | Pipeline',
    };
  }

  // ─── 工具方法 ─────────────────────────────

  /**
   * 从 LLM 响应提取 JSON。
   * 实现已抽到厂商无关的 shared/structuredOutput（供 Provider 与 Gateway 共用），
   * 这里仅委派并桥接实例 logger，保持既有调用方行为不变。
   */
  extractJSON(text: string, openChar = '{', closeChar = '}') {
    return sharedExtractJSON(text, openChar, closeChar, (level, message) =>
      this._log(level, message)
    );
  }

  /**
   * 指数退避重试 + 熔断器（受 Cline 三级错误恢复启发）
   *
   * 熔断器三态:
   *   CLOSED  — 正常工作，计数连续失败
   *   OPEN    — 连续 N 次失败，直接拒绝请求（快速失败），持续 cooldownMs
   *   HALF_OPEN — 冷却期后尝试一次，成功则恢复，失败则重新 OPEN
   *
   * 这避免了 AI 服务宕机时无意义的重试风暴。
   */
  async _withRetry<T>(
    fn: () => Promise<T>,
    retries = this.maxRetries,
    baseDelay = 2000
  ): Promise<T> {
    // ── 熔断器检查 ──
    if (this._circuitState === 'OPEN') {
      const elapsed = Date.now() - (this._circuitOpenedAt || 0);
      if (elapsed < (this._circuitCooldownMs || 30000)) {
        const err = new Error(
          `AI 服务熔断中 (连续 ${this._circuitFailures} 次失败)，${Math.ceil(((this._circuitCooldownMs || 30000) - elapsed) / 1000)}s 后恢复`
        ) as Error & { code: string };
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
      // 冷却期结束 → HALF_OPEN
      this._circuitState = 'HALF_OPEN';
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      let slotAcquired = false;
      try {
        await this._waitForRateLimitWindow();
        await this._acquireRequestSlot();
        slotAcquired = true;

        const result = await fn();
        // 成功 → 完全重置熔断器（包括冷却时间）
        this._circuitFailures = 0;
        this._circuitState = 'CLOSED';
        this._circuitCooldownMs = 30_000; // 重置冷却时间
        return result;
      } catch (err: unknown) {
        const e = err as Error & {
          status?: number;
          code?: string;
          retryAfterMs?: number;
          cause?: { code?: string; message?: string; name?: string };
        };

        // 错误分类已抽到 shared/errorClassify（供 Provider 与 Gateway 共用），
        // 这里只消费分类结果做重试 / 熔断决策，避免两套实现漂移。
        const { isAbort, isNetworkError, isRetryable, isServerError, causeCode } =
          classifyLlmError(e);

        // AbortError — 外部主动中止（如 PipelineStrategy hard timeout），不重试直接抛出
        if (isAbort) {
          throw e;
        }

        // 429：触发 provider 级冷却窗，抑制并发重试风暴
        if (e.status === 429) {
          const retryAfterMs = Number(e.retryAfterMs || 0);
          const adaptiveCooldown = Math.max(
            retryAfterMs,
            Math.round(baseDelay * 2 ** attempt * 1.5 + Math.random() * 1000)
          );
          this._setRateLimitWindow(adaptiveCooldown);
        }

        // 首次失败记录详细诊断（含 cause）
        if (attempt === 0 && (isNetworkError || e.cause)) {
          this._log?.(
            'warn',
            `[_withRetry] ${e.message} — cause: ${e.cause?.message || causeCode || 'unknown'}`
          );
        }

        if (attempt >= retries || !isRetryable) {
          // 只有服务端错误 / 网络错误才累计熔断计数
          // 客户端错误 (4xx 非 429) 不应触发熔断 — 那是请求本身的问题
          if (isServerError) {
            this._circuitFailures = (this._circuitFailures || 0) + 1;
            if (
              this._circuitFailures >= (this._circuitThreshold || 5) &&
              !isProviderCircuitOpen(this._circuitState)
            ) {
              this._circuitState = 'OPEN';
              this._circuitOpenedAt = Date.now();
              // 先用当前冷却值，再递增给下次: 30s → 60s → 120s（最大 5 分钟）
              const cooldown = this._circuitCooldownMs || 30_000;
              this._log?.(
                'warn',
                `[CircuitBreaker] OPEN — ${this._circuitFailures} consecutive failures, cooldown ${cooldown / 1000}s`
              );
              this._circuitCooldownMs = Math.min(cooldown * 2, 300_000);
            }
          }
          throw e;
        }
        const delay = baseDelay * 2 ** attempt + Math.random() * 1000;
        this._log?.(
          'info',
          `[_withRetry] attempt ${attempt + 1} failed (${e.message}), retrying in ${Math.round(delay / 1000)}s…`
        );
        await new Promise((r) => setTimeout(r, delay));
      } finally {
        if (slotAcquired) {
          this._releaseRequestSlot();
        }
      }
    }
    // Should never reach here — last iteration either returns or throws
    throw new Error('_withRetry: unexpected exhaustion');
  }
}

export default AiProvider;
