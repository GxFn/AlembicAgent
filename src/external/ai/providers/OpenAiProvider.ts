/**
 * OpenAiProvider - OpenAI 提供商
 *
 * 纯 OpenAI Chat Completions API 实现，不兼容其他厂商。
 * 支持原生 Function Calling（结构化工具调用）。
 */

import Logger from '@alembic/core/logging';
import {
  AiProvider,
  type AiProviderConfig,
  type ApiResponse,
  type ChatContext,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  createMissingApiKeyError,
  type StructuredOutputOptions,
  type ToolSchema,
  type UnifiedMessage,
} from '../AiProvider.js';
import { ParameterGuard } from '../guard/ParameterGuard.js';
import { getModelRegistry } from '../registry/ModelRegistry.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

export class OpenAiProvider extends AiProvider {
  embedModel: string;
  /**
   * API 协议风格：
   *   - 'chat'      → 经典 Chat Completions API（POST /chat/completions）
   *   - 'responses' → 新版 Responses API（POST /responses）
   * 部分中转站 / 代理网关只暴露其中一种端点（例如本仓库实测的中转站对 gpt
   * 系列只开放 /responses，没有 /chat/completions），因此通过配置或环境变量
   * ALEMBIC_OPENAI_API_STYLE 显式切换协议，避免 404。
   */
  #apiStyle: 'chat' | 'responses';

  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'openai';
    this.model = config.model || process.env.ALEMBIC_AI_MODEL || 'gpt-5.5';
    this.apiKey = config.apiKey || process.env.ALEMBIC_OPENAI_API_KEY || '';
    // 支持通过环境变量覆盖 baseUrl，用于接入 OpenAI 兼容的中转站/代理网关；
    // 与 DeepSeek / Claude provider 的 ALEMBIC_*_BASE_URL 约定保持一致。
    this.baseUrl = config.baseUrl || process.env.ALEMBIC_OPENAI_BASE_URL || OPENAI_BASE;
    this.embedModel =
      config.embedModel || process.env.ALEMBIC_EMBED_MODEL || 'text-embedding-3-small';
    const styleRaw = (
      (config.apiStyle as string) ||
      process.env.ALEMBIC_OPENAI_API_STYLE ||
      'chat'
    ).toLowerCase();
    this.#apiStyle = styleRaw === 'responses' ? 'responses' : 'chat';
    this.logger = Logger.getInstance() as unknown as import('../AiProvider.js').AiLogger;
  }

  #getModelDef() {
    return getModelRegistry().resolveOrCreate('openai', this.model);
  }

  get supportsNativeToolCalling() {
    return true;
  }

  async chat(prompt: string, context: ChatContext = {}) {
    if (this.#apiStyle === 'responses') {
      return this.#responsesChat(prompt, context);
    }
    return this._withRetry(async () => {
      const { history = [], temperature = 0.7, maxTokens = 4096 } = context;
      const messages: Array<{ role: string; content: string }> = [];

      for (const h of history) {
        messages.push({ role: h.role, content: h.content });
      }
      messages.push({ role: 'user', content: prompt });

      const modelDef = this.#getModelDef();
      const guarded = ParameterGuard.guard(modelDef, { temperature, maxTokens });

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        max_tokens: guarded.maxTokens ?? maxTokens,
      };

      if (guarded.temperature !== undefined) {
        body.temperature = guarded.temperature;
      }

      const data = await this.#post(`${this.baseUrl}/chat/completions`, body);
      this.#emitUsage(data);
      return data?.choices?.[0]?.message?.content || '';
    });
  }

  async chatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    if (this.#apiStyle === 'responses') {
      return this.#responsesChatWithTools(prompt, opts);
    }
    return this._withRetry(async () => {
      const {
        messages: rawMessages,
        toolSchemas: rawToolSchemas,
        toolChoice = 'auto',
        systemPrompt,
        temperature = 0.7,
        maxTokens = 4096,
      } = opts;
      const unifiedMessages = rawMessages;
      const toolSchemas = rawToolSchemas;

      const messages: Array<Record<string, unknown>> = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      const srcMessages: UnifiedMessage[] =
        unifiedMessages && unifiedMessages.length > 0
          ? unifiedMessages
          : [{ role: 'user' as const, content: prompt }];

      for (const msg of srcMessages) {
        if (msg.role === 'user') {
          messages.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant') {
          const m: Record<string, unknown> = { role: 'assistant', content: msg.content || null };
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            m.tool_calls = msg.toolCalls.map(
              (tc: { id: string; name: string; args: Record<string, unknown> }) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
              })
            );
          }
          messages.push(m);
        } else if (msg.role === 'tool') {
          messages.push({
            role: 'tool',
            tool_call_id: msg.toolCallId,
            content: msg.content || '',
          });
        }
      }

      const modelDef = this.#getModelDef();
      const guarded = ParameterGuard.guard(modelDef, { temperature, maxTokens, toolChoice });

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        max_tokens: guarded.maxTokens ?? maxTokens,
      };

      if (guarded.temperature !== undefined) {
        body.temperature = guarded.temperature;
      }

      if (toolSchemas && toolSchemas.length > 0) {
        body.tools = toolSchemas.map((s: ToolSchema) => ({
          type: 'function',
          function: {
            name: s.name,
            description: s.description || '',
            parameters: s.parameters || { type: 'object', properties: {} },
          },
        }));
      }

      if (guarded.toolChoice) {
        body.tool_choice = guarded.toolChoice;
      } else if (toolChoice === 'required') {
        body.tool_choice = 'required';
      } else if (toolChoice === 'none') {
        body.tool_choice = 'none';
      } else {
        body.tool_choice = 'auto';
      }

      const data = await this.#post(`${this.baseUrl}/chat/completions`, body, opts.abortSignal);
      return this.#parseToolResponse(data);
    });
  }

  async summarize(code: string) {
    const prompt = `请对以下代码生成结构化摘要，返回 JSON 格式 {title, description, language, patterns: [], keyAPIs: []}:\n\n${code}`;
    return (
      (await this.chatWithStructuredOutput(prompt, { temperature: 0.3, maxTokens: 4096 })) || {
        title: '',
        description: '',
      }
    );
  }

  async chatWithStructuredOutput(prompt: string, opts: StructuredOutputOptions = {}) {
    if (this.#apiStyle === 'responses') {
      return this.#responsesChatWithStructuredOutput(prompt, opts);
    }
    return this._withRetry(async () => {
      const { temperature = 0.3, maxTokens = 32768, systemPrompt } = opts;

      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      };

      const data = await this.#post(`${this.baseUrl}/chat/completions`, body);
      this.#emitUsage(data);

      const text = data?.choices?.[0]?.message?.content || '';
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        const openChar = opts.openChar || '{';
        const closeChar = opts.closeChar || '}';
        return this.extractJSON(text, openChar, closeChar);
      }
    });
  }

  async embed(text: string | string[]) {
    const texts = Array.isArray(text) ? text : [text];
    try {
      const body = {
        model: this.embedModel,
        input: texts.map((t) => t.slice(0, 8000)),
      };
      const data = await this.#post(`${this.baseUrl}/embeddings`, body);
      const embeddings = (data?.data || [])
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        .map((d: { embedding: number[] }) => d.embedding);

      if (embeddings.length === 0) {
        return Array.isArray(text) ? [] : [];
      }
      return Array.isArray(text) ? embeddings : embeddings[0];
    } catch (err: unknown) {
      this.logger?.warn(`OpenAI embed failed, returning empty`, {
        error: (err as Error).message,
      });
      return Array.isArray(text) ? texts.map(() => []) : [];
    }
  }

  // ─── Responses API（POST /responses）────────────────────
  //
  // 数据挖掘主链路依赖 chatWithTools（ReAct 循环 + 原生工具调用）与
  // chatWithStructuredOutput（结构化抽取）。Responses API 与 Chat Completions
  // 在请求体、工具格式、多轮工具回传和响应解析上都不同，这里单独实现，
  // 不污染经典 Chat Completions 路径。

  /**
   * 把统一消息数组转换为 Responses API 的 input 项。
   *   - user      → { role:'user', content:[{type:'input_text', text}] }
   *   - assistant → 文本作为 message，tool_calls 拆为独立 function_call 项
   *   - tool      → { type:'function_call_output', call_id, output }
   * call_id 在 function_call 与 function_call_output 间原样回传，保证 ReAct 多轮闭合。
   */
  #buildResponsesInput(messages: UnifiedMessage[]): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        input.push({
          role: 'user',
          content: [{ type: 'input_text', text: msg.content || '' }],
        });
      } else if (msg.role === 'assistant') {
        if (msg.content) {
          input.push({
            role: 'assistant',
            content: [{ type: 'output_text', text: msg.content }],
          });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.args || {}),
            });
          }
        }
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.toolCallId,
          output: msg.content || '',
        });
      }
    }
    return input;
  }

  /** 解析 Responses API 输出：聚合文本、提取 function_call、归一化 usage。 */
  #parseResponsesOutput(data: ApiResponse): ChatWithToolsResult {
    const usage = data?.usage
      ? {
          inputTokens: data.usage.input_tokens || 0,
          outputTokens: data.usage.output_tokens || 0,
          totalTokens:
            data.usage.total_tokens ||
            (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        }
      : null;

    const output: Array<Record<string, unknown>> = Array.isArray(data?.output) ? data.output : [];

    // 文本：优先用顶层便捷字段 output_text，否则从 message 项的 output_text 聚合。
    let text: string | null =
      typeof data?.output_text === 'string' && data.output_text.length > 0
        ? data.output_text
        : null;
    if (text === null) {
      const parts: string[] = [];
      for (const item of output) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content as Array<Record<string, unknown>>) {
            if (c?.type === 'output_text' && typeof c.text === 'string') {
              parts.push(c.text);
            }
          }
        }
      }
      text = parts.length > 0 ? parts.join('') : null;
    }

    const functionCalls = output
      .filter((item) => item?.type === 'function_call')
      .map((item) => ({
        id: (item.call_id || item.id) as string,
        name: item.name as string,
        args: (() => {
          try {
            return JSON.parse((item.arguments as string) || '{}');
          } catch {
            return {};
          }
        })(),
      }));

    const finishReason = (data?.status as string) || null;

    if (functionCalls.length > 0) {
      this.logger?.debug(
        `[OpenAI/responses] native function calls: ${functionCalls.map((fc) => fc.name).join(', ')}`
      );
      return { text, functionCalls, usage, finishReason };
    }
    return { text, functionCalls: null, usage, finishReason };
  }

  #emitResponsesUsage(data: ApiResponse) {
    if (data?.usage) {
      this._emitTokenUsage({
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
        totalTokens:
          data.usage.total_tokens ||
          (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      });
    }
  }

  async #responsesChat(prompt: string, context: ChatContext = {}): Promise<string> {
    return this._withRetry(async () => {
      const { history = [], temperature = 0.7, maxTokens = 4096, systemPrompt } = context;
      const messages: UnifiedMessage[] = [];
      for (const h of history) {
        messages.push({ role: h.role, content: h.content });
      }
      messages.push({ role: 'user', content: prompt });

      const modelDef = this.#getModelDef();
      const guarded = ParameterGuard.guard(modelDef, { temperature, maxTokens });

      const body: Record<string, unknown> = {
        model: this.model,
        input: this.#buildResponsesInput(messages),
        max_output_tokens: guarded.maxTokens ?? maxTokens,
      };
      if (systemPrompt) {
        body.instructions = systemPrompt;
      }
      if (guarded.temperature !== undefined) {
        body.temperature = guarded.temperature;
      }

      const data = await this.#post(`${this.baseUrl}/responses`, body);
      this.#emitResponsesUsage(data);
      return this.#parseResponsesOutput(data).text || '';
    });
  }

  async #responsesChatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    return this._withRetry(async () => {
      const {
        messages: rawMessages,
        toolSchemas,
        toolChoice = 'auto',
        systemPrompt,
        temperature = 0.7,
        maxTokens = 4096,
      } = opts;

      const srcMessages: UnifiedMessage[] =
        rawMessages && rawMessages.length > 0
          ? rawMessages
          : [{ role: 'user' as const, content: prompt }];

      const modelDef = this.#getModelDef();
      const guarded = ParameterGuard.guard(modelDef, { temperature, maxTokens, toolChoice });

      const body: Record<string, unknown> = {
        model: this.model,
        input: this.#buildResponsesInput(srcMessages),
        max_output_tokens: guarded.maxTokens ?? maxTokens,
      };
      if (systemPrompt) {
        body.instructions = systemPrompt;
      }
      if (guarded.temperature !== undefined) {
        body.temperature = guarded.temperature;
      }

      // Responses API 的工具是扁平结构（name/description/parameters 直接在 function 项上），
      // 区别于 Chat Completions 的 { type:'function', function:{...} } 嵌套结构。
      if (toolSchemas && toolSchemas.length > 0) {
        body.tools = toolSchemas.map((s: ToolSchema) => ({
          type: 'function',
          name: s.name,
          description: s.description || '',
          parameters: s.parameters || { type: 'object', properties: {} },
        }));
        body.tool_choice = guarded.toolChoice || toolChoice || 'auto';
      }

      const data = await this.#post(`${this.baseUrl}/responses`, body, opts.abortSignal);
      this.#emitResponsesUsage(data);
      return this.#parseResponsesOutput(data);
    });
  }

  async #responsesChatWithStructuredOutput(
    prompt: string,
    opts: StructuredOutputOptions = {}
  ): Promise<unknown> {
    return this._withRetry(async () => {
      const { temperature = 0.3, maxTokens = 32768, systemPrompt } = opts;
      const messages: UnifiedMessage[] = [{ role: 'user', content: prompt }];

      const modelDef = this.#getModelDef();
      const guarded = ParameterGuard.guard(modelDef, { temperature, maxTokens });

      const body: Record<string, unknown> = {
        model: this.model,
        input: this.#buildResponsesInput(messages),
        max_output_tokens: guarded.maxTokens ?? maxTokens,
        // Responses API 用 text.format 声明 JSON 输出，对应 Chat Completions 的 response_format。
        text: { format: { type: 'json_object' } },
      };
      if (systemPrompt) {
        body.instructions = systemPrompt;
      }
      if (guarded.temperature !== undefined) {
        body.temperature = guarded.temperature;
      }

      const data = await this.#post(`${this.baseUrl}/responses`, body);
      this.#emitResponsesUsage(data);

      const text = this.#parseResponsesOutput(data).text || '';
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        const openChar = opts.openChar || '{';
        const closeChar = opts.closeChar || '}';
        return this.extractJSON(text, openChar, closeChar);
      }
    });
  }

  // ─── 响应解析 ──────────────────────────────────────────

  #parseToolResponse(data: ApiResponse) {
    const choice = data?.choices?.[0];

    const usage = data?.usage
      ? {
          inputTokens: data.usage.prompt_tokens || 0,
          outputTokens: data.usage.completion_tokens || 0,
          totalTokens: data.usage.total_tokens || 0,
        }
      : null;

    if (!choice) {
      return { text: '', functionCalls: null, usage };
    }

    const message = choice.message;
    const text = message?.content || null;

    if (message?.tool_calls?.length > 0) {
      const functionCalls = message.tool_calls
        .filter((tc: Record<string, unknown>) => tc.type === 'function')
        .map((tc: Record<string, unknown>) => ({
          id: tc.id as string,
          name: (tc.function as Record<string, unknown>).name as string,
          args: (() => {
            try {
              return JSON.parse(
                ((tc.function as Record<string, unknown>).arguments as string) || '{}'
              );
            } catch {
              return {};
            }
          })(),
        }));

      if (functionCalls.length > 0) {
        this.logger?.debug(
          `[OpenAI] native function calls: ${functionCalls.map((fc: { name: string }) => fc.name).join(', ')}`
        );
        return { text, functionCalls, usage };
      }
    }

    return { text, functionCalls: null, usage };
  }

  #emitUsage(data: ApiResponse) {
    if (data?.usage) {
      this._emitTokenUsage({
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0,
      });
    }
  }

  // ─── HTTP ──────────────────────────────────────────────

  async #post(
    url: string,
    body: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<ApiResponse> {
    if (!this.apiKey) {
      throw createMissingApiKeyError('OpenAI', 'ALEMBIC_OPENAI_API_KEY', 'openai');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await this._fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.text();
          const parsed = JSON.parse(errBody);
          detail = parsed?.error?.message || errBody.slice(0, 300);
        } catch {
          /* best effort */
        }
        const err = new Error(
          `OpenAI API error: ${res.status}${detail ? ` — ${detail}` : ''}`
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as ApiResponse;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

export default OpenAiProvider;
