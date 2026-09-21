/**
 * AiFactory - AI 提供商工厂
 *
 * 根据配置/环境变量创建对应的 AI Provider 实例。
 * 每个 AI 厂商都有独立的 Provider 类，互不继承。
 *
 * 支持: google-gemini, openai, deepseek, claude, ollama
 */

import Logger from '@alembic/core/logging';
import {
  aiConfigInfo,
  availableFallbacks,
  configuredProvider,
  defaultModel,
  detectProvider,
  embedProviderOptions,
} from './configuration.js';
import { ClaudeProvider } from './providers/ClaudeProvider.js';
import { DeepSeekProvider } from './providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from './providers/GoogleGeminiProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { OpenAiProvider } from './providers/OpenAiProvider.js';
import type { ProviderId } from './registry/ModelDefs.js';

const PROVIDER_MAP: Record<ProviderId, ProviderClass> = {
  google: GoogleGeminiProvider,
  openai: OpenAiProvider,
  deepseek: DeepSeekProvider,
  claude: ClaudeProvider,
  ollama: OllamaProvider,
};

type ProviderClass =
  | typeof GoogleGeminiProvider
  | typeof OpenAiProvider
  | typeof DeepSeekProvider
  | typeof ClaudeProvider
  | typeof OllamaProvider;

/**
 * 创建 AI Provider 实例
 * @param options {provider, model, apiKey, baseUrl}
 */
export function createProvider(options: Record<string, unknown> = {}) {
  const id = configuredProvider(options.provider);
  return new PROVIDER_MAP[id]({ ...options });
}

/** 自动发现只决定身份；模型/连接统一在 Provider 构造边界解析。 */
export function autoDetectProvider() {
  const selected = detectProvider();
  return selected ? createProvider(selected) : null;
}

/** 保留独立的 fallback 顺序，别名先归一，避免重复尝试主 provider。 */
export function getAvailableFallbacks(currentProvider: string) {
  return availableFallbacks(currentProvider);
}

/** 判断是否为地理限制 / 不可恢复的 provider 级错误（应触发 fallback） */
export function isGeoOrProviderError(err: unknown) {
  const msg = ((err as Error).message || '').toLowerCase();
  return (
    /user location is not supported|failed_precondition|unsupported.*(region|country|location)|geo|blocked/i.test(
      msg
    ) ||
    (/permission.*denied|forbidden/i.test(msg) && !/rate.?limit|quota|429/i.test(msg))
  );
}

/**
 * 获取 AI Provider，带自动 fallback：
 * 当主 provider 调用失败（地理限制等）时自动切换到备选 provider
 */
export async function getProviderWithFallback() {
  const logger = Logger.getInstance();
  const primary = autoDetectProvider();
  if (!primary) {
    return null;
  }

  const currentProvider = primary.name;

  try {
    if (typeof primary.probe === 'function') {
      await primary.probe();
    }
    return primary;
  } catch (probeErr: unknown) {
    if (!isGeoOrProviderError(probeErr)) {
      return primary;
    }
    logger.warn(
      `[AiFactory] Primary provider "${currentProvider}" failed: ${(probeErr as Error).message}`
    );
  }

  const fallbacks = getAvailableFallbacks(currentProvider);
  if (fallbacks.length === 0) {
    logger.warn(`[AiFactory] No fallback providers available. Primary: ${currentProvider}`);
    return primary;
  }

  for (const fbName of fallbacks) {
    try {
      logger.info(`[AiFactory] Trying fallback provider: ${fbName}`);
      const fbProvider = createProvider({ provider: fbName, model: defaultModel(fbName) });
      fbProvider._fallbackFrom = currentProvider;
      return fbProvider;
    } catch (e: unknown) {
      logger.warn(`[AiFactory] Fallback "${fbName}" creation failed: ${(e as Error).message}`);
    }
  }

  return primary;
}

/**
 * 创建独立的 Embedding Provider（旧显式 SDK 调用兼容入口）
 * @deprecated 产品向量装配使用 Core EmbeddingPort；不要从 LLM 选择或热切换触发此入口。
 *
 * 当 ALEMBIC_EMBED_PROVIDER 被设置时，创建一个专用于 embedding 的 provider 实例，
 * 使 embedding 和 LLM 生成可以使用不同的提供商/模型。
 *
 * @returns 独立的 embed provider，或 null（未配置时）
 */
export function createEmbedProvider(): ReturnType<typeof createProvider> | null {
  const options = embedProviderOptions();
  if (!options) {
    return null;
  }
  Logger.getInstance().info(`[AiFactory] Creating dedicated embed provider: ${options.provider}`);
  return createProvider(options);
}

/** 同步 UI 投影不暴露 key 或 endpoint。 */
export function getAiConfigInfo() {
  return aiConfigInfo();
}

// 所有提供商的集中导出
export { AiProvider } from './AiProvider.js';
export { ClaudeProvider } from './providers/ClaudeProvider.js';
export { DeepSeekProvider } from './providers/DeepSeekProvider.js';
export { GoogleGeminiProvider } from './providers/GoogleGeminiProvider.js';
export { OllamaProvider } from './providers/OllamaProvider.js';
export { OpenAiProvider } from './providers/OpenAiProvider.js';

export default {
  createProvider,
  createEmbedProvider,
  autoDetectProvider,
  getAiConfigInfo,
  getProviderWithFallback,
  getAvailableFallbacks,
  isGeoOrProviderError,
};
