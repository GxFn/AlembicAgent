/**
 * AiProvider — 公开 Provider 门面及宿主用量通知。
 * 具体 Provider 固定身份/配置，并将生成协议与可靠性委托给 Gateway/Transport。
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type {
  AiLogger,
  AiProviderConfig,
  ChatContext,
  ChatWithToolsOptions,
  ChatWithToolsResult,
  EmbeddingCapacityHint,
  EmbeddingCapacityHintSource,
  LlmCallOptions,
  StructuredOutputOptions,
  TokenUsagePayload,
  UnifiedMessage,
} from './contracts.js';
import { throwIfLlmCancelled } from './errors.js';
import type { GatewayConfig, LLMGateway } from './gateway/LLMGateway.js';
import { getProviderConfig } from './registry/ProviderConfig.js';
import { resolveConcurrency } from './shared/concurrency.js';
import { parseSchemaOutput, prepareStructuredValidation } from './shared/schemaValidation.js';
import { extractJSON as sharedExtractJSON } from './shared/structuredOutput.js';

// 保留原公共入口：外部消费者无需随内部依赖分层更换导入路径。
export type * from './contracts.js';
export { createMissingApiKeyError, type MissingApiKeyError } from './errors.js';

/**
 * probe 的独立期限（毫秒）。宿主“测试连接”不传 abortSignal，若继承 provider 的 300s 超时与 3 次重试，
 * 黑洞代理下约 20 分钟才返回。取 30s 而非 15s：给 Ollama 冷加载模型和 thinking 模型的首个 token 留余量。
 */
const PROBE_TIMEOUT_MS = 30_000;

/** probe 专用 Gateway 的重试上限：探测只回答“此刻能否连通”，失败应立即带原因返回而不是退避重放。 */
const PROBE_MAX_RETRIES = 0;

/**
 * probe 的输出预算（token）。判定不依赖可见文本（见 probeResponseEvidence），因此不为 thinking 模型放大预算，
 * 也不在探针里关闭思考：各厂商关闭思考的参数不一（Gemini 3 只能降到最低档、不能完全关闭），
 * 引入厂商特化参数只会让探针与业务请求的参数口径分叉；16 token 让探测成本保持最低。
 */
const PROBE_MAX_TOKENS = 16;

/**
 * finishReason 中表示“因输出预算截断”的厂商取值（小写比较）：
 * Gemini MAX_TOKENS、Claude max_tokens、OpenAI/DeepSeek/Ollama length、Responses incomplete。
 */
const PROBE_TRUNCATION_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'incomplete',
]);

/**
 * 基类 chatWithTools 拒绝时附带的错误码（W2a-11r1）。
 * 字面量与 AgentRuntime 的分类常量必须一致；本仓不从这里导出常量（AiProvider.ts 经 `./ai` 整体再导出，
 * 新增导出会改变冻结的公开签名），与 Gateway 的 'CIRCUIT_OPEN' 一样按字面量契约对齐。
 */
const PROVIDER_CONTRACT_VIOLATION_CODE = 'PROVIDER_CONTRACT_VIOLATION';

/** 取消类错误（本仓 AbortError 归一化结果，或不合作子类原样抛出的 TimeoutError）。 */
function isCancellationError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * probe 应答证据（W2a-11r1）：一次成功返回的调用里能证明“模型确实应答过”的事实。
 * probe 回答的是“此刻能否连通并通过鉴权”，不以可见文本是否为空判定——thinking/reasoning 模型在
 * PROBE_MAX_TOKENS 内常常只产出推理（Gemini finishReason=MAX_TOKENS 且只有 thoughtsTokenCount，
 * OpenAI/DeepSeek/Ollama 空 content 加 reasoning，Claude 只有 thinking 块），这些都是已计费的健康调用。
 * 证据任一成立即判可用：可见文本、工具调用、推理内容、已上报的计费用量、因预算截断结束。
 * 全部缺失（2xx 但无文本、无用量、非截断结束）时无法证明模型应答，probe 返回 false。
 */
function probeResponseEvidence(result: ChatWithToolsResult): string[] {
  const evidence: string[] = [];
  if (typeof result.text === 'string' && result.text.length > 0) {
    evidence.push('visible_text');
  }
  if (Array.isArray(result.functionCalls) && result.functionCalls.length > 0) {
    evidence.push('tool_calls');
  }
  if (typeof result.reasoningContent === 'string' && result.reasoningContent.length > 0) {
    evidence.push('reasoning');
  }
  const usage = result.usage;
  if (usage && (usage.inputTokens || 0) + (usage.outputTokens || 0) > 0) {
    evidence.push('billed_usage');
  }
  const finishReason =
    typeof result.finishReason === 'string' ? result.finishReason.toLowerCase() : '';
  if (PROBE_TRUNCATION_FINISH_REASONS.has(finishReason)) {
    evidence.push('truncated_finish');
  }
  return evidence;
}

export class AiProvider {
  _circuitThreshold: number;
  _maxConcurrency: number;
  _maxConcurrencySource: EmbeddingCapacityHintSource;
  apiKey: string;
  baseUrl: string;
  logger: AiLogger | null = null;
  maxRetries: number;
  model: string;
  name: string;
  timeout: number;

  /**
   * Token 用量回调 — 每次 API 调用后触发（包括 chat / chatWithStructuredOutput / chatWithTools）
   * 由外部（如 DI 容器）注入以实现全局 token 计量。
   */
  _onTokenUsage: ((usage: TokenUsagePayload) => void) | null = null;

  /** 协议下沉 transport 后，本 provider 专属的 LLMGateway 实例（lazy 构造）。 */
  #gateway: LLMGateway | null = null;

  /**
   * 只供 probe 使用的私有 LLMGateway（lazy 构造）：连接配置与主 Gateway 相同，但 maxRetries=0。
   * 熔断、并发闸门与主 Gateway 互相独立——探测失败不计入业务请求的熔断，也不占业务并发槽。
   */
  #probeGateway: LLMGateway | null = null;

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
    this.maxRetries = config.maxRetries ?? 3;
    this.name = 'abstract';

    // 熔断/重试/并发都在 Gateway 的 ReliabilityController 里生效；这里只转发配置。
    // 与直接构造 Gateway 同口径用 `??`：0、NaN 等非法值不再被 `||` 静默改成 5，
    // 而是交给控制器统一校验，在首个请求、任何 HTTP 发出前以 LLM_INVALID_REQUEST 拒绝。
    this._circuitThreshold = config.circuitThreshold ?? 5;

    const concurrency = resolveConcurrency(config.maxConcurrency);
    this._maxConcurrency = concurrency.value;
    this._maxConcurrencySource = concurrency.source;
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
  _emitTokenUsage(usage: TokenUsagePayload | null | undefined, source?: string) {
    const observer = this._onTokenUsage;
    if (!usage || !observer) {
      return;
    }
    const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    if (total === 0) {
      return;
    }
    // 直接使用 Provider 的宿主也可能返回 Promise；计量观察失败不能重发已完成的请求。
    observeSafely(
      () => observer.call(this, { ...usage, source }),
      () =>
        this._log('warn', `[${this.name}] usage_observer_failed; response and known usage retained`)
    );
  }

  /** 向量嵌入 - 返回浮点数组 */
  async embed(text: string | string[], opts: LlmCallOptions = {}): Promise<number[] | number[][]> {
    throwIfLlmCancelled(opts.abortSignal);
    throw new Error(`${this.name}.embed() not implemented`);
  }

  /**
   * 探测 provider 是否可用（轻量级 API 调用验证连接性）。子类可覆盖实现更具体的探测逻辑。
   *
   * - 期限：调用方 abortSignal 与 AbortSignal.timeout(PROBE_TIMEOUT_MS) 经 AbortSignal.any 合成。
   *   期限触发抛 code=PROBE_DEADLINE_EXCEEDED（消息含期限毫秒数）并 warn `probe_deadline_exceeded`；
   *   调用方主动取消优先，仍抛 AbortError，不归为期限失败。
   * - 内置 provider（name 是已登记的 ProviderId）走私有 probe Gateway：零重试、用量来源记为 'probe'。
   *   Transport 的 runOperation 在信号触发时先确定终态，即使 fetch 不响应 abort 也按期返回。
   * - 直接继承基类、只实现 chat() 的自定义子类没有 Gateway 路由，仍走它自己的 chat()：
   *   重试与用量归子类自己管，期限只能经合成信号协作生效（子类忽略信号时无法强制中断）。
   * - 判定口径（W2a-11r1）：probe 回答“此刻能否连通并通过鉴权”。内置 provider 经 probe Gateway 的
   *   chatWithTools 拿到完整应答，只要带任一应答证据（见 probeResponseEvidence：可见文本、工具调用、推理、
   *   已计费用量、预算截断）即判可用——thinking 模型在探针预算内只产出推理时不再被判为不可用；
   *   可用但无可见文本时记 info `probe_reachable_without_visible_text`（只含证据名与计数，不含应答内容）。
   *   成功返回却没有任何证据时记 warn `probe_no_response_evidence` 并返回 false。
   *   自定义子类的 chat() 只暴露文本、没有用量与 finishReason，仍以非空文本为唯一证据，空文本返回 false
   *   并记 warn `probe_empty_text`。
   * - 失败一律带原因抛出（鉴权、网络、期限等；宿主会把 message 展示给用户），不吞成 false；
   *   AiFactory.getProviderWithFallback 在 false 或 provider 级限制时改用已配置的 fallback provider。
   */
  async probe(opts: LlmCallOptions = {}) {
    const callerSignal = opts.abortSignal;
    // 已取消的调用不武装期限、不发请求。
    throwIfLlmCancelled(callerSignal);
    const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    const viaGateway = getProviderConfig(this.name) !== undefined;
    if (!viaGateway) {
      this._log(
        'debug',
        `[${this.name}] probe_path=subclass_chat reason=provider_not_gateway_routed deadlineMs=${PROBE_TIMEOUT_MS}; retries and usage source governed by subclass chat()`
      );
    }
    try {
      if (!viaGateway) {
        const text = await this.chat('ping', {
          maxTokens: PROBE_MAX_TOKENS,
          temperature: 0,
          abortSignal: signal,
        });
        if (text) {
          return true;
        }
        this._log(
          'warn',
          `[${this.name}] probe_empty_text path=subclass_chat; subclass chat() exposes only text (no usage or finishReason evidence), probe resolved false`
        );
        return false;
      }
      // 直接取 Gateway.chatWithTools 的完整应答（Gateway.chat 只回文本，会丢掉用量与 finishReason 证据）；
      // 请求形态与原 Gateway.chat('ping') 相同：单条 user 消息、不带工具、零重试、用量来源 probe。
      const result = await (await this.#getProbeGateway()).chatWithTools({
        modelRef: this._modelRef,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: PROBE_MAX_TOKENS,
        temperature: 0,
        usageSource: 'probe',
        abortSignal: signal,
      });
      const evidence = probeResponseEvidence(result);
      const usageState = result.usage
        ? `inputTokens=${result.usage.inputTokens ?? 0} outputTokens=${result.usage.outputTokens ?? 0} reasoningTokens=${result.usage.reasoningTokens ?? 0}`
        : 'usage=unreported';
      const finishReason = result.finishReason ?? 'unknown';
      if (evidence.length === 0) {
        this._log(
          'warn',
          `[${this.name}] probe_no_response_evidence finishReason=${finishReason} ${usageState}; successful call carried no text, tool call, reasoning, billed usage or truncated finish, probe resolved false`
        );
        return false;
      }
      if (!evidence.includes('visible_text')) {
        this._log(
          'info',
          `[${this.name}] probe_reachable_without_visible_text evidence=${evidence.join(',')} finishReason=${finishReason} ${usageState}; judged available by connectivity, visible text not required`
        );
      }
      return true;
    } catch (err: unknown) {
      // 只有“期限已到、调用方未取消、且失败本身是取消类错误”才归为期限失败；
      // 与期限竞速先到的真实错误（HTTP 状态、缺 key 等）原样抛出，保留更具体的原因。
      if (deadline.aborted && !callerSignal?.aborted && isCancellationError(err)) {
        this._log(
          'warn',
          `[${this.name}] probe_deadline_exceeded deadlineMs=${PROBE_TIMEOUT_MS} path=${viaGateway ? 'probe_gateway' : 'subclass_chat'} retries=${viaGateway ? PROBE_MAX_RETRIES : 'subclass'}; probe rejected with PROBE_DEADLINE_EXCEEDED`
        );
        throw Object.assign(
          new Error(
            `${this.name} probe did not complete within the ${PROBE_TIMEOUT_MS}ms deadline`
          ),
          { code: 'PROBE_DEADLINE_EXCEEDED' }
        );
      }
      throw err;
    }
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
   * 带工具声明的结构化对话 — 原生函数调用 API
   *
   * 5 个内置 Provider 全部覆写此方法，经 _gatewayChatWithTools → LLMGateway → *Transport
   * 返回结构化 functionCalls。AgentRuntime 无条件调用本方法，不做文本工具调用解析
   * （文本工具调用兼容只存在于 DeepSeekTransport）。
   *
   * AiProvider 不支持只实现 chat() 的外部子类（L2-P21，用户 2026-10-20 按推荐批准事项②）：
   * 基类默认实现不再降级为纯文本 chat()——旧降级会静默丢弃 toolSchemas、toolChoice 与 role='tool'
   * 消息，调用方拿到“模型没有调用工具”的假结果。现在每次调用都先记 warn 诊断
   * `chatWithTools_not_overridden`（只含工具数与消息数，不含工具名、消息正文或 prompt），
   * 再抛 `Error('<name> must override chatWithTools')`（附 code=PROVIDER_CONTRACT_VIOLATION），且绝不调用 chat()。
   * 该错误在任何 Gateway 之前抛出，不经过 ReliabilityController，因此不计入熔断，也不会被网关重试；
   * AgentRuntime 按该 code 把它归为运行时缺陷（W2a-11r1）：一次即终止、不进入 2-strike 重试与 2000ms 等待、
   * cancelReason=runtime_defect，回复写明是 provider 集成缺陷而不是“AI 服务暂时不可用”。
   *
   * 统一消息格式 (Provider-Agnostic):
   *   - { role: 'user', content: 'text' }
   *   - { role: 'assistant', content: 'text or null', toolCalls: [{id, name, args}] }
   *   - { role: 'tool', toolCallId: 'id', name: 'tool_name', content: 'result string' }
   *
   * @param prompt 用户消息（内置 Provider 仅在 messages 为空时使用）
   * @param opts.messages 统一格式消息历史
   * @param opts.toolSchemas [{name, description, parameters}]
   * @param opts.toolChoice 'auto' | 'required' | 'none'
   * @param [opts.systemPrompt] 系统指令
   * @returns ChatWithToolsResult：{ text, functionCalls, usage? }（由子类覆写实现返回）
   */
  async chatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    // prompt 只为保持公开签名：默认实现不读取任何内容，诊断只计数。
    void prompt;
    const toolCount = Array.isArray(opts.toolSchemas) ? opts.toolSchemas.length : 0;
    const messageCount = Array.isArray(opts.messages) ? opts.messages.length : 0;
    this._log(
      'warn',
      `[${this.name}] chatWithTools_not_overridden tools=${toolCount} messages=${messageCount}; rejected without calling chat()`
    );
    // 永久性集成缺陷：code 让调用方按类型（而非消息文本）归类为不可重试的运行时缺陷。
    throw Object.assign(new Error(`${this.name} must override chatWithTools`), {
      code: PROVIDER_CONTRACT_VIOLATION_CODE,
    });
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
    throwIfLlmCancelled(opts.abortSignal);
    const validate = prepareStructuredValidation(opts.schema, (level, message) =>
      this._log(level, message)
    );
    if (!validate) {
      return null;
    }
    const response = await this.chat(prompt, {
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 32768,
      systemPrompt: opts.systemPrompt,
      abortSignal: opts.abortSignal,
    });
    if (!response || response.trim().length === 0) {
      return null;
    }
    if (opts.schema !== undefined) {
      return parseSchemaOutput(response, validate, (level, message) => this._log(level, message));
    }
    const openChar = opts.openChar || '{';
    const closeChar = opts.closeChar || '}';
    const value = this.extractJSON(response, openChar, closeChar);
    return validate(value) ? value : null;
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
    // DTO/错误已经叶子化；仍按需加载 Gateway，避免只读 Provider 合同时加载全部 SDK。
    const { LLMGateway } = await import('./gateway/LLMGateway.js');
    // 首次并发请求可能一起等待动态加载；恢复后再次检查，确保所有请求共享同一个闸门。
    if (this.#gateway) {
      return this.#gateway;
    }
    this.#gateway = new LLMGateway(this.#gatewayConfig(this.maxRetries));
    return this.#gateway;
  }

  /**
   * lazy 构造只供 probe 使用的私有 Gateway：连接与主 Gateway 相同，重试固定为 PROBE_MAX_RETRIES。
   * 不复用主 Gateway，也不给 GatewayRequest 增加公开的单次重试字段。
   */
  async #getProbeGateway(): Promise<LLMGateway> {
    if (this.#probeGateway) {
      return this.#probeGateway;
    }
    const { LLMGateway } = await import('./gateway/LLMGateway.js');
    // 与 _getGateway 相同：并发首次探测等待动态加载后再核对，保证共享同一实例。
    if (this.#probeGateway) {
      return this.#probeGateway;
    }
    this.#probeGateway = new LLMGateway(this.#gatewayConfig(PROBE_MAX_RETRIES));
    return this.#probeGateway;
  }

  /** 主 Gateway 与 probe Gateway 共用的配置；只有重试上限由调用方决定。 */
  #gatewayConfig(maxRetries: number): GatewayConfig {
    // this.name 即 ProviderId（openai/claude/deepseek/google/ollama）。
    const providers = {
      [this.name]: {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        timeout: this.timeout,
        ...this._transportExtras,
      },
    } as GatewayConfig['providers'];
    return {
      providers,
      timeout: this.timeout,
      maxRetries,
      circuitThreshold: this._circuitThreshold,
      maxConcurrency: this._maxConcurrency,
      onUsage: (usage) => this._emitTokenUsage(usage, usage.source),
    };
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
      abortSignal: context.abortSignal,
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
      abortSignal: opts.abortSignal,
    });
  }

  /** 委托 gateway 的向量嵌入；transport 依据 _transportExtras.embedModel 选择 embed 模型。 */
  async _gatewayEmbed(
    text: string | string[],
    opts: LlmCallOptions = {}
  ): Promise<number[] | number[][]> {
    const isArray = Array.isArray(text);
    const texts = isArray ? (text as string[]) : [text as string];
    try {
      const embeddings = await (await this._getGateway()).embed(this._modelRef, texts, opts);
      return isArray ? embeddings : embeddings[0] || [];
    } catch (err: unknown) {
      throwIfLlmCancelled(opts.abortSignal, err);
      // embed 失败不应中断主流程：返回空向量，由上层决定降级策略（与原 Provider 行为一致）。
      this._log(
        'warn',
        `[${this.name}] embed failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  /** 内部日志辅助（子类可通过 this.logger 覆盖） */
  _log(level: string, message: string) {
    try {
      // 内置 Provider 在构造器里注入 Core Logger；直接继承基类的自定义 Provider 默认 logger 为 null，
      // 此时回落到 Core Logger，避免 embed 失败、schema 编译失败、用量观察者失败等降级告警被静默吞掉。
      const target = this.logger ?? (Logger.getInstance() as unknown as AiLogger);
      const method = target[level];
      if (typeof method === 'function') {
        method.call(target, message);
      }
    } catch (err: unknown) {
      // 日志本身失败不能影响已完成的降级结果；这里只能尽力而为，无法再记录到同一个 logger。
      void err;
    }
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
}

export default AiProvider;
