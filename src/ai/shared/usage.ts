/**
 * usage — 厂商 token 用量字段归一（纯函数）
 *
 * 背景：各厂商原始响应的 usage 字段命名不一致：
 *   - OpenAI Chat Completions / DeepSeek：prompt_tokens / completion_tokens / total_tokens
 *   - OpenAI Responses：input_tokens / output_tokens / total_tokens
 *   - Anthropic：input_tokens / output_tokens
 *   - Google：promptTokenCount / candidatesTokenCount / totalTokenCount
 * 各 Provider / Transport 各自手写映射，重复且易漏字段。
 *
 * 本模块把映射抽成厂商无关的纯函数，输出统一的 TokenUsage 形状，供 Provider 与
 * Gateway / Transport 共用。
 */

import type { TokenUsage } from '../AiProvider.js';

/** 厂商原始 usage 对象（字段并集，全部可选）。 */
export interface RawUsage {
  // OpenAI Chat Completions / DeepSeek 风格
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // OpenAI Responses / Anthropic 风格
  input_tokens?: number;
  output_tokens?: number;
  // Google Gemini 风格
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  // 扩展：推理 / 缓存命中
  reasoning_tokens?: number;
  reasoningTokens?: number;
  prompt_cache_hit_tokens?: number;
  cacheHitTokens?: number;
  [key: string]: unknown;
}

/** 安全转数字：非有限数字一律归 0。 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把任意厂商原始 usage 归一为统一 TokenUsage。
 * 多命名风格按优先级取第一个出现的字段，不累加，避免重复计数。
 *
 * @param raw 厂商原始 usage（缺失或非对象时返回 null）
 * @returns 统一 TokenUsage；输入为空返回 null
 */
export function normalizeRawUsage(raw: RawUsage | null | undefined): TokenUsage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const inputTokens =
    raw.prompt_tokens !== undefined
      ? num(raw.prompt_tokens)
      : raw.input_tokens !== undefined
        ? num(raw.input_tokens)
        : num(raw.promptTokenCount);

  const outputTokens =
    raw.completion_tokens !== undefined
      ? num(raw.completion_tokens)
      : raw.output_tokens !== undefined
        ? num(raw.output_tokens)
        : num(raw.candidatesTokenCount);

  const totalTokens =
    raw.total_tokens !== undefined
      ? num(raw.total_tokens)
      : raw.totalTokenCount !== undefined
        ? num(raw.totalTokenCount)
        : inputTokens + outputTokens;

  const usage: TokenUsage = { inputTokens, outputTokens, totalTokens };

  const reasoningTokens =
    raw.reasoningTokens !== undefined ? num(raw.reasoningTokens) : num(raw.reasoning_tokens);
  if (reasoningTokens > 0) {
    usage.reasoningTokens = reasoningTokens;
  }

  const cacheHitTokens =
    raw.cacheHitTokens !== undefined ? num(raw.cacheHitTokens) : num(raw.prompt_cache_hit_tokens);
  if (cacheHitTokens > 0) {
    usage.cacheHitTokens = cacheHitTokens;
  }

  return usage;
}
