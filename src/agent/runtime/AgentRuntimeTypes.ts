/**
 * AgentRuntimeTypes — AgentRuntime 共享类型定义
 *
 * 从 AgentRuntime.ts 提取的接口和类型，
 * 供 AgentRuntime、ToolExecutionPipeline 及测试文件独立消费。
 *
 * @module AgentRuntimeTypes
 */

import type { ToolResultEnvelope, ToolRouterContract } from '#tools/kernel/index.js';

/** Tool call entry recorded during execution */
export interface ToolCallEntry {
  tool: string;
  name?: string;
  args: Record<string, unknown>;
  result: unknown;
  envelope?: ToolResultEnvelope;
  durationMs: number;
}

/** LLM function call descriptor */
export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Gemini 3+ thought signature — 必须原样回传 */
  thoughtSignature?: string;
}

/** chatWithTools result from the AI provider */
export interface LLMResult {
  type?: string;
  text?: string | null;
  functionCalls?: FunctionCall[] | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheHitTokens?: number;
  };
  /** DeepSeek V4 thinking 推理内容，需原样回传 */
  reasoningContent?: string | null;
  /** Provider stop reason，例如 DeepSeek/OpenAI finish_reason */
  finishReason?: string | null;
}

export type AgentProgressProcessEventKind = 'llm.input' | 'llm.reflection' | 'llm.output' | 'tool';

export type AgentProgressProcessEventSourceClass =
  | 'developer-facing'
  | 'machine-only'
  | 'raw-provider'
  | 'secret'
  | 'hidden-reasoning';

export type AgentProgressProcessEventDisplayPolicy = 'full' | 'summary-only' | 'hidden';

export type AgentProgressProcessEventRetention = 'transient' | 'job-retained' | 'artifact-retained';

export type AgentProgressProcessEventSeverity = 'info' | 'success' | 'warning' | 'error';

export type AgentProgressProcessEventContentRole =
  | 'system'
  | 'developer'
  | 'user'
  | 'assistant'
  | 'tool';

export interface AgentProgressProcessEventContent {
  data?: unknown;
  language?: string | null;
  mimeType?: string | null;
  role?: AgentProgressProcessEventContentRole | null;
  text: string | null;
}

/**
 * Developer-safe Agent progress payload that hosts can map to Core JobProcessEvent.
 * The Agent supplies semantic content; the host recorder owns jobId, sequence and storage.
 */
export interface AgentProgressProcessEvent {
  content?: AgentProgressProcessEventContent | null;
  correlationId?: string | null;
  createdAt: string;
  dimensionId?: string | null;
  displayPolicy: AgentProgressProcessEventDisplayPolicy;
  kind: AgentProgressProcessEventKind;
  metadata?: Record<string, unknown>;
  phase?: string | null;
  retention: AgentProgressProcessEventRetention;
  severity: AgentProgressProcessEventSeverity;
  sourceClass: AgentProgressProcessEventSourceClass;
  summary?: string | null;
  targetName?: string | null;
  title: string;
}

/** AI error with optional circuit breaker code */
export interface AiError extends Error {
  code?: string;
}

/** Progress event emitted to listeners */
export interface ProgressEvent {
  type: string;
  agentId: string;
  preset: string;
  timestamp: number;
  processEvent?: AgentProgressProcessEvent;
  [key: string]: unknown;
}

export interface AgentDiagnosticWarning {
  code: string;
  message: string;
  stage?: string;
  tool?: string;
}

export interface ToolCallDiagnostic {
  tool: string;
  callId: string;
  parentCallId?: string;
  status: string;
  ok: boolean;
  surface?: string;
  source?: string;
  kind?: string;
  startedAt: string;
  durationMs: number;
}

export interface StageToolsetDiagnostic {
  stage: string;
  capabilities: string[];
  allowedToolIds: string[];
  allowedToolActions?: Record<string, string[]>;
  toolSchemaCount: number;
  source?: string;
}

export interface AgentEfficiencySummary {
  toolCalls: number;
  duplicateToolCalls: number;
  cacheHits: number;
  cacheMisses: number;
  tokenUsage: {
    input: number;
    output: number;
    reasoning: number;
    cacheHit: number;
  };
  maxCompactionLevel: number;
  totalCompactedItems: number;
  nudgeCount: number;
  replanCount: number;
  emptyRetries: number;
  forcedSummary: boolean;
  cancelReason?: string;
}

export interface AgentDiagnostics {
  degraded: boolean;
  fallbackUsed: boolean;
  warnings: AgentDiagnosticWarning[];
  timedOutStages: string[];
  blockedTools: Array<{ tool: string; reason: string }>;
  truncatedToolCalls: number;
  emptyResponses: number;
  aiErrorCount: number;
  gateFailures: Array<{ stage: string; action: string; reason?: string }>;
  toolCalls?: ToolCallDiagnostic[];
  stageToolsets?: StageToolsetDiagnostic[];
  efficiency?: AgentEfficiencySummary;
}

/** Tool execution pipeline metadata */
export interface ToolMetadata {
  cacheHit: boolean;
  blocked: boolean;
  isNew: boolean;
  durationMs: number;
  dedupMessage?: string;
  isSubmit?: boolean;
  envelope?: ToolResultEnvelope;
  duplicateShortCircuit?: boolean;
  cacheEligible?: boolean;
  cacheMiss?: boolean;
}

/** File cache entry */
export interface FileCacheEntry {
  relativePath: string;
  content?: string;
  name?: string;
}

export interface RuntimeConfig {
  id?: string;
  presetName?: string;
  aiProvider: import('#ai/AiProvider.js').AiProvider;
  toolRegistry: import('#tools/catalog/UnifiedToolCatalog.js').UnifiedToolCatalog;
  toolRouter?: ToolRouterContract | null;
  container?: Record<string, unknown> | null;
  capabilities?: import('../capabilities/index.js').Capability[];
  strategy: import('../strategies/index.js').Strategy;
  policies?: import('../policies/index.js').PolicyEngine;
  persona?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  onProgress?: ((event: ProgressEvent) => void) | null;
  onToolCall?: ToolCallHook | null;
  lang?: string | null;
  projectRoot?: string;
  dataRoot?: string;
  additionalTools?: string[];
  /** 模型引用 (provider:model)，用于日志 / trace / 工具裁剪；不设则从 aiProvider 推导 */
  modelRef?: string;
}

export type ToolCallHook = (
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  iteration: number
) => void;

export interface AgentResult {
  reply: string;
  toolCalls: ToolCallEntry[];
  tokenUsage: { input: number; output: number; reasoning?: number; cacheHit?: number };
  iterations: number;
  durationMs: number;
  phases?: Record<string, unknown>;
  diagnostics?: AgentDiagnostics;
  state: Record<string, unknown>;
  qualityWarning?: string;
  [key: string]: unknown;
}

export interface ReactLoopOpts {
  history?: Array<{ role: string; content: string }>;
  context?: Record<string, unknown>;
  capabilityOverride?: string[];
  additionalToolsOverride?: string[];
  budgetOverride?: Record<string, unknown>;
  systemPromptOverride?: string;
  onToolCall?: ToolCallHook | null;
  contextWindow?: import('../context/ContextWindow.js').ContextWindow;
  tracker?: Record<string, unknown>;
  trace?: Record<string, unknown>;
  memoryCoordinator?: Record<string, unknown>;
  sharedState?: Record<string, unknown>;
  source?: string;
  toolChoiceOverride?: string | null;
  /** 外部中止信号 — PipelineStrategy hard timeout 时取消进行中的 LLM 调用 */
  abortSignal?: AbortSignal;
  diagnostics?: unknown;
  [key: string]: unknown;
}

/** 单次迭代允许的最大工具调用数 */
export const MAX_TOOL_CALLS_PER_ITER = 8;
