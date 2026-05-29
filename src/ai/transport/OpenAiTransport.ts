/**
 * OpenAiTransport — OpenAI Chat Completions / Responses API 协议转换
 *
 * 纯协议层：UnifiedMessage ↔ OpenAI 请求/响应格式
 * 不含参数校验、重试、用量上报（由 Gateway 层 ParameterGuard / ReliabilityController 负责）
 *
 * 支持两种 API 风格（apiStyle）：
 *   - 'chat'      → 经典 Chat Completions（POST /chat/completions），默认
 *   - 'responses' → 新版 Responses API（POST /responses）
 * gpt-5.x 等部分中转站 / 新模型只开放 /responses，需显式切换。
 * 风格来源：config.apiStyle ＞ 环境变量 ALEMBIC_OPENAI_API_STYLE ＞ 默认 'chat'。
 */

import type { ToolSchema, UnifiedMessage } from '../AiProvider.js';
import { normalizeRawUsage } from '../shared/usage.js';
import {
  LLMTransport,
  type TransportConfig,
  type TransportFunctionCall,
  type TransportRequest,
  type TransportResponse,
} from './LLMTransport.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

export class OpenAiTransport extends LLMTransport {
  #embedModel: string;
  #apiStyle: 'chat' | 'responses';

  constructor(config: TransportConfig) {
    super('openai', { ...config, baseUrl: config.baseUrl || OPENAI_BASE });
    this.#embedModel = (config.embedModel as string) || 'text-embedding-3-small';
    const styleRaw = String(
      (config.apiStyle as string) || process.env.ALEMBIC_OPENAI_API_STYLE || 'chat'
    ).toLowerCase();
    this.#apiStyle = styleRaw === 'responses' ? 'responses' : 'chat';
  }

  async chat(request: TransportRequest): Promise<string> {
    this.requireApiKey('OpenAI');
    if (this.#apiStyle === 'responses') {
      const data = await this.post(
        `${this.baseUrl}/responses`,
        this.#buildResponsesBody(request),
        this.#headers(),
        request.abortSignal
      );
      return this.#parseResponsesOutput(data).text || '';
    }

    const messages = this.#buildMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
    }
    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const data = await this.post(
      `${this.baseUrl}/chat/completions`,
      body,
      this.#headers(),
      request.abortSignal
    );
    const choices = (data?.choices as Array<Record<string, unknown>>) || [];
    const message = choices[0]?.message as Record<string, string> | undefined;
    return message?.content || '';
  }

  async chatWithTools(request: TransportRequest): Promise<TransportResponse> {
    this.requireApiKey('OpenAI');
    if (this.#apiStyle === 'responses') {
      const data = await this.post(
        `${this.baseUrl}/responses`,
        this.#buildResponsesBody(request),
        this.#headers(),
        request.abortSignal
      );
      return this.#parseResponsesOutput(data);
    }

    const messages = this.#buildMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((s: ToolSchema) => ({
        type: 'function',
        function: {
          name: s.name,
          description: s.description || '',
          parameters: s.parameters || { type: 'object', properties: {} },
        },
      }));
    }

    if (request.toolChoice) {
      body.tool_choice = request.toolChoice;
    }

    const data = await this.post(
      `${this.baseUrl}/chat/completions`,
      body,
      this.#headers(),
      request.abortSignal
    );

    return this.#parseResponse(data);
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.requireApiKey('OpenAI');
    const body = {
      model: this.#embedModel,
      input: texts.map((t) => t.slice(0, 8000)),
    };
    const data = await this.post(`${this.baseUrl}/embeddings`, body, this.#headers());
    const items = ((data as Record<string, unknown>)?.data || []) as Array<{
      index: number;
      embedding: number[];
    }>;
    return items.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  // ─── 消息转换 ──────────────────────────────────────

  #buildMessages(unified: UnifiedMessage[], systemPrompt?: string): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of unified) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const m: Record<string, unknown> = { role: 'assistant', content: msg.content || null };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          m.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
          }));
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

    return messages;
  }

  // ─── 响应解析 ──────────────────────────────────────

  #parseResponse(data: Record<string, unknown>): TransportResponse {
    const choices = data?.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const rawUsage = data?.usage as Record<string, number> | undefined;

    const usage = rawUsage
      ? {
          inputTokens: rawUsage.prompt_tokens || 0,
          outputTokens: rawUsage.completion_tokens || 0,
          totalTokens: rawUsage.total_tokens || 0,
        }
      : null;

    if (!choice) {
      return { text: '', functionCalls: null, usage };
    }

    const message = choice.message as Record<string, unknown>;
    const text = (message?.content as string) || null;

    const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      const functionCalls: TransportFunctionCall[] = toolCalls
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
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
        return { text, functionCalls, usage };
      }
    }

    return { text, functionCalls: null, usage };
  }

  // ─── Responses API（POST /responses）────────────────────

  /** 构造 Responses API 请求体（chat 与 chatWithTools 共用）。 */
  #buildResponsesBody(request: TransportRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: this.#buildResponsesInput(request.messages),
      max_output_tokens: request.maxTokens,
    };
    if (request.systemPrompt) {
      body.instructions = request.systemPrompt;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
    }
    // Responses API 用 text.format 声明 JSON 输出，对应 Chat Completions 的 response_format。
    if (request.responseFormat === 'json') {
      body.text = { format: { type: 'json_object' } };
    }
    // Responses API 的工具是扁平结构（name/description/parameters 直接在 function 项上），
    // 区别于 Chat Completions 的 { type:'function', function:{...} } 嵌套结构。
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((s: ToolSchema) => ({
        type: 'function',
        name: s.name,
        description: s.description || '',
        parameters: s.parameters || { type: 'object', properties: {} },
      }));
      if (request.toolChoice) {
        body.tool_choice = request.toolChoice;
      }
    }
    return body;
  }

  /**
   * 把统一消息数组转换为 Responses API 的 input 项。
   *   - user      → { role:'user', content:[{type:'input_text', text}] }
   *   - assistant → 文本作为 message，tool_calls 拆为独立 function_call 项
   *   - tool      → { type:'function_call_output', call_id, output }
   * call_id 在 function_call 与 function_call_output 间原样回传，保证 ReAct 多轮闭合。
   */
  #buildResponsesInput(unified: UnifiedMessage[]): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [];
    for (const msg of unified) {
      if (msg.role === 'user') {
        input.push({ role: 'user', content: [{ type: 'input_text', text: msg.content || '' }] });
      } else if (msg.role === 'assistant') {
        if (msg.content) {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: msg.content }] });
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
  #parseResponsesOutput(data: Record<string, unknown>): TransportResponse {
    const usage = normalizeRawUsage(data?.usage as Record<string, number> | undefined);
    const output: Array<Record<string, unknown>> = Array.isArray(data?.output)
      ? (data.output as Array<Record<string, unknown>>)
      : [];

    // 文本：优先用顶层便捷字段 output_text，否则从 message 项的 output_text 聚合。
    let text: string | null =
      typeof data?.output_text === 'string' && (data.output_text as string).length > 0
        ? (data.output_text as string)
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

    const functionCalls: TransportFunctionCall[] = output
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
    return {
      text,
      functionCalls: functionCalls.length > 0 ? functionCalls : null,
      usage,
      finishReason,
    };
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}
