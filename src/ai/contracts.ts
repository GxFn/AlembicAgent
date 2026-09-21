/** AI 输入/输出的底层合同；不依赖 Provider、Gateway 或 Transport。 */

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
  apiStyle?: string;
  reasoningEffort?: string;
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 对话历史条目 */
export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/** 单次调用的活跃资源选项。 */
export interface LlmCallOptions {
  /** 活跃调用的取消资源；不写入可回放的消息或持久化合同。 */
  abortSignal?: AbortSignal;
}

/** 对话上下文选项 */
export interface ChatContext extends LlmCallOptions {
  history?: ChatHistoryEntry[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** 原生内容次序；可见文本用范围引用，工具用 id 引用，避免复制另一份业务历史。 */
export type LlmReplayPart =
  | { type: 'text'; start: number; end: number; thoughtSignature?: string }
  | { type: 'tool-call'; id: string }
  | {
      type: 'reasoning';
      text: string;
      signature?: string;
      redactedData?: string;
      thoughtSignature?: string;
    };

interface LlmContinuationScope {
  provider: string;
  model: string;
  /** 连接身份摘要；不携带原始 endpoint 或凭据，防止跨连接复用服务端 item。 */
  connection: string;
}

/** 仅为模型协议回传提示，不代表 Agent 运行状态或工具执行授权。 */
export type LlmContinuation = LlmContinuationScope &
  (
    | { kind: 'stored-reasoning-v1'; reasoningItemIds: string[] }
    | { kind: 'content-replay-v1'; parts: LlmReplayPart[] }
  );

/** 统一消息格式 */
export interface UnifiedMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  /** DeepSeek V4 thinking / 推理内容，多轮对话需原样回传 */
  reasoningContent?: string | null;
  continuation?: LlmContinuation;
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
export interface ChatWithToolsOptions extends LlmCallOptions {
  messages?: UnifiedMessage[];
  toolSchemas?: ToolSchema[];
  toolChoice?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
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
  continuation?: LlmContinuation;
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
  /** Provider 报告的缓存创建输入 token；已计入 inputTokens。 */
  cacheWriteTokens?: number;
}

/** chatWithStructuredOutput 选项 */
export interface StructuredOutputOptions extends LlmCallOptions {
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
