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
import { createMissingApiKeyError } from './errors.js';
import { ClaudeProvider } from './providers/ClaudeProvider.js';
import { DeepSeekProvider } from './providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from './providers/GoogleGeminiProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { OpenAiProvider } from './providers/OpenAiProvider.js';
import type { ProviderId } from './registry/ModelDefs.js';
import { PROVIDER_CONFIGS } from './registry/ProviderConfig.js';
import { classifyLlmError } from './shared/errorClassify.js';

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
  const requested = process.env.ALEMBIC_AI_PROVIDER;
  // 'auto' 在发现与 UI 投影中都表示“未指定”；未显式传 provider 时与 detectProvider 得出同一身份，
  // 而不是把它当作未知 provider 拒绝。显式 provider 始终优先，configuredProvider 保持严格。
  if (!options.provider && requested?.trim().toLowerCase() === 'auto') {
    const selected = detectProvider();
    if (!selected) {
      const keyEnvVars = PROVIDER_CONFIGS.filter(({ keyEnvVar }) => keyEnvVar).map(
        ({ keyEnvVar }) => keyEnvVar
      );
      Logger.getInstance().warn(
        `[AiFactory] auto_provider_unconfigured entry=createProvider candidates=${keyEnvVars.length}; rejecting with API_KEY_MISSING`
      );
      // 复用统一缺 key 错误：宿主已按 code=API_KEY_MISSING 渲染配置指引，不走未知身份分支。
      throw createMissingApiKeyError(
        'AI Provider（auto 自动发现）',
        keyEnvVars.join(' / '),
        'auto'
      );
    }
    Logger.getInstance().debug(
      `[AiFactory] auto_provider_resolved entry=createProvider provider=${selected.provider}`
    );
    return new PROVIDER_MAP[selected.provider]({ ...options });
  }
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
  const details = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const msg = typeof details.message === 'string' ? details.message.toLowerCase() : '';
  const status =
    typeof details.status === 'number' &&
    Number.isInteger(details.status) &&
    details.status >= 100 &&
    details.status <= 599
      ? details.status
      : undefined;
  const classification = classifyLlmError({
    name: details.name,
    message: msg,
    status,
    code: details.code,
    cause: details.cause,
  });
  // 先用真实状态/网络事实排除暂时故障和取消，不能被错误正文中的 blocked/forbidden 覆盖。
  // 暂时故障（429 / 408 / 5xx / 网络错误）的唯一口径在 classifyLlmError.isRetryable，
  // 这里不再单列状态码；408（代理/网关请求超时）因此同样不触发 provider fallback。
  if (classification.isAbort || classification.isRetryable) {
    return false;
  }
  // SDK 会脱敏原厂错误正文；已知 403 仍是权限/地区限制，不依赖保留下来的文案。
  if (status === 403) {
    return true;
  }
  // 旧宿主无状态码时保留文本兼容；quota + 长期 blocked 不等于临时 429 限流。
  if (/rate.?limit|\b429\b/i.test(msg)) {
    return false;
  }
  return (
    /user location is not supported|failed_precondition|unsupported.*(region|country|location)|geo|blocked/i.test(
      msg
    ) ||
    (/permission.*denied|forbidden/i.test(msg) && !/quota/i.test(msg))
  );
}

/**
 * 获取 AI Provider，带自动 fallback（唯一的 provider 级 fallback 入口；Gateway 侧的探活与候选链已删除）：
 * - 主 provider 的 probe() 解析为 true：保留主 provider；
 * - probe() 解析为 false（例如空文本应答）：视为主 provider 此刻不可用，进入已配置的 fallback 链；
 * - probe() 抛出 provider 级限制（地理限制、403 等，见 isGeoOrProviderError）：同样进入 fallback 链；
 * - probe() 抛出暂时故障、取消或未分类错误：保留主 provider（不因节流或网络抖动切换厂商）。
 * fallback 来源只经诊断日志记录（fallback_selected），不再写入 provider 实例字段。
 */
export async function getProviderWithFallback() {
  const logger = Logger.getInstance();
  const primary = autoDetectProvider();
  if (!primary) {
    return null;
  }

  const currentProvider = primary.name;
  let fallbackReason: 'probe_unavailable' | 'provider_restriction';

  try {
    if (await primary.probe()) {
      return primary;
    }
    // 旧实现忽略 probe 的布尔结果，探测“连通但不可用”时仍返回主 provider（L2-P21 W1 修正）。
    fallbackReason = 'probe_unavailable';
    logger.warn(
      `[AiFactory] primary_probe_unavailable provider=${currentProvider} result=false; selecting configured fallback`
    );
  } catch (probeErr: unknown) {
    if (!isGeoOrProviderError(probeErr)) {
      logger.debug(
        `[AiFactory] Primary provider "${currentProvider}" probe failed without a provider restriction; retaining primary`
      );
      return primary;
    }
    fallbackReason = 'provider_restriction';
    logger.warn(
      `[AiFactory] Primary provider "${currentProvider}" has a provider restriction; selecting configured fallback`
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
      // fallback 候选按配置顺序只构造、不再探活；选择结果与触发原因留在诊断里供宿主定位。
      logger.info(
        `[AiFactory] fallback_selected provider=${fbProvider.name} fallbackFrom=${currentProvider} reason=${fallbackReason}`
      );
      return fbProvider;
    } catch (e: unknown) {
      logger.warn(
        `[AiFactory] Fallback "${fbName}" creation failed (${e instanceof Error ? e.name : 'unknown'}); trying next configured provider`
      );
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

/**
 * 同步 UI 投影不暴露 key 或 endpoint；返回 process.env 的声明投影（见 configuration.ts 的
 * aiConfigInfo），只用于展示声明值，不代表就绪。
 * - provider 原样回显 ALEMBIC_AI_PROVIDER（未声明为 'auto'），`provider && provider !== 'none'`
 *   只在恰好声明 ALEMBIC_AI_PROVIDER=none 时为假，其余声明（含 'auto'、缺 key）都为真，
 *   不能当作“AI 已配置”；hasKey 也不覆盖 ollama 这类无需 key 的 provider。
 * - 就绪结论与运行时同源：已初始化容器读 getAiRuntimeStatus；没有容器时调用本模块的
 *   autoDetectProvider()，返回 null 或抛错都视为未就绪。
 * - 不要用 Core isAiEnvReady(collectAiEnv(env)) 判定就绪：它不做自动发现、别名归一和 trim，
 *   与 autoDetectProvider 结论不等价（auto/none/gemini 无 key 时报就绪，只设 key 时报未就绪）。
 */
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
