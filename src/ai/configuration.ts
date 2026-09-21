/** AI 配置装配叶子：计算有效值，不创建 Provider、Gateway 或 SDK，也不执行请求。 */
import Logger from '@alembic/core/logging';
import type { AiLogger, AiProviderConfig } from './contracts.js';
import type { ProviderConfig, ProviderId } from './registry/ModelDefs.js';
import { getProviderConfig, PROVIDER_CONFIGS } from './registry/ProviderConfig.js';
import { resolveConcurrency } from './shared/concurrency.js';

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export interface ConnectionConfig {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface ResolvedConnection extends ConnectionConfig {
  apiKey: string;
  baseUrl: string;
  embedModel: string;
  apiStyle: 'chat' | 'responses';
  reasoningEffort: 'high' | 'max';
}

const ALIASES: Readonly<Record<string, ProviderId>> = {
  'google-gemini': 'google',
  gemini: 'google',
  anthropic: 'claude',
};

// 保留既有发现顺序；地理限制后的 fallback 仍按 PROVIDER_CONFIGS 顺序枚举。
const AUTO_DETECT_ORDER: readonly ProviderId[] = ['google', 'openai', 'claude', 'deepseek'];

const EMBEDDING_MODELS: Record<ProviderId, string> = {
  google: 'gemini-embedding-001',
  openai: 'text-embedding-3-small',
  deepseek: 'deepseek-embedding',
  claude: '', // 没有 embedding API；不因配置收敛捏造能力。
  ollama: 'qwen3-embedding:0.6b',
};

export function canonicalProvider(value: string): ProviderId | undefined {
  const name = value.trim().toLowerCase();
  return Object.hasOwn(ALIASES, name)
    ? ALIASES[name]
    : PROVIDER_CONFIGS.find(({ id }) => id === name)?.id;
}

function providerConfig(providerId: ProviderId): ProviderConfig {
  const descriptor = getProviderConfig(providerId);
  if (!descriptor) {
    throw new Error(`Unknown AI provider: ${providerId}`);
  }
  return descriptor;
}

/** Factory 接收宿主 JSON；在进入 SDK 前校验已知字段，错误中不携带原值。 */
function configString(value: unknown, field: string): string | undefined {
  if (value == null || typeof value === 'string') {
    return value ?? undefined;
  }
  Logger.getInstance().warn(`[ai-config] invalid_field_type field=${field}; construction rejected`);
  throw Object.assign(new Error(`${field} must be a string`), { code: 'LLM_INVALID_REQUEST' });
}

export function defaultModel(providerId: ProviderId): string {
  const modelRef = providerConfig(providerId).defaultModelId;
  return modelRef.slice(modelRef.indexOf(':') + 1);
}

/** 缺凭据错误与发现逻辑共用字段目录；Ollama 仅保留旧错误提示名，不读取该变量。 */
export function providerKeyEnv(providerId: ProviderId): string {
  return providerConfig(providerId).keyEnvVar || `ALEMBIC_${providerId.toUpperCase()}_API_KEY`;
}

function normalizeApiRoot(
  rawUrl: string,
  suffix: string,
  provider: string,
  logger?: AiLogger
): string {
  try {
    const url = new URL(rawUrl);
    if (!url.pathname.replace(/\/+$/, '')) {
      url.pathname = suffix;
      // 不记录原 URL：代理地址可能含认证信息或租户标识。
      logger?.info?.(
        `[ai-config] endpoint_root_normalized provider=${provider} suffix=${suffix}; explicit API paths preserved`
      );
      return url.toString().replace(/\/+$/, '');
    }
    return rawUrl.replace(/\/+$/, '');
  } catch (err: unknown) {
    logger?.warn?.(
      `[ai-config] invalid_endpoint provider=${provider} kind=${err instanceof TypeError ? 'invalid_url' : 'normalization_error'}; request layer will reject`
    );
    return rawUrl;
  }
}

/** 保留公开 helper 的调用合同；裸根补 /v1，显式代理路径不改写。 */
export function normalizeOllamaBaseUrl(rawUrl: string, logger?: AiLogger): string {
  return normalizeApiRoot(rawUrl, '/v1', 'ollama', logger);
}

/** 独立 embedding 配置不污染另一家 provider；未指定归属时保留全局模型配置。 */
function scopedModel(
  env: ConfigEnvironment,
  owner: 'AI' | 'EMBED',
  providerId: ProviderId
): string | undefined {
  const selected = env[`ALEMBIC_${owner}_PROVIDER`];
  if (
    selected &&
    selected.trim().toLowerCase() !== 'auto' &&
    canonicalProvider(selected) !== providerId
  ) {
    if (env[`ALEMBIC_${owner}_MODEL`]) {
      Logger.getInstance().debug(
        `[ai-config] foreign_model_ignored scope=${owner} provider=${providerId}; use provider default`
      );
    }
    return undefined;
  }
  return env[`ALEMBIC_${owner}_MODEL`] || undefined;
}

/** endpoint 与 key 独立取值；是否显式传 key 不能改变 endpoint 的优先级。 */
export function resolveConnection(
  providerId: ProviderId,
  config: ConnectionConfig = {},
  env: ConfigEnvironment = process.env
): ResolvedConnection {
  const defaults = providerConfig(providerId);
  const logger = Logger.getInstance() as unknown as AiLogger;
  const rawUrl =
    configString(config.baseUrl, 'baseUrl') ||
    (defaults.baseUrlEnvVar ? env[defaults.baseUrlEnvVar] : '') ||
    defaults.baseUrl;
  const baseUrl =
    providerId === 'ollama'
      ? normalizeOllamaBaseUrl(rawUrl, logger)
      : providerId === 'google'
        ? normalizeApiRoot(rawUrl, '/v1beta', providerId, logger)
        : // 宿主严格回执读取公开 baseUrl 原字符串；SDK 自行规范化 API 拼接。
          rawUrl;
  const style = String(
    configString(config.apiStyle, 'apiStyle') ||
      (providerId === 'openai' ? env.ALEMBIC_OPENAI_API_STYLE : '') ||
      'chat'
  ).toLowerCase();
  const effort =
    configString(config.reasoningEffort, 'reasoningEffort') ||
    (providerId === 'deepseek' ? env.ALEMBIC_DEEPSEEK_REASONING_EFFORT : '') ||
    'high';
  if (style !== 'chat' && style !== 'responses') {
    logger.warn?.(`[ai-config] invalid_api_style provider=${providerId}; using chat`);
  }
  if (providerId === 'deepseek' && effort !== 'high' && effort !== 'max') {
    logger.warn?.('[ai-config] invalid_reasoning_effort provider=deepseek; using high');
  }
  return {
    ...config,
    // undefined 继承环境；空 key 是显式禁用，不能重新吸入进程凭据。
    apiKey:
      configString(config.apiKey, 'apiKey') ??
      (defaults.keyEnvVar ? env[defaults.keyEnvVar] : undefined) ??
      (providerId === 'ollama' ? 'ollama' : ''),
    baseUrl,
    embedModel:
      configString(config.embedModel, 'embedModel') ||
      scopedModel(env, 'EMBED', providerId) ||
      EMBEDDING_MODELS[providerId],
    apiStyle: style === 'responses' ? 'responses' : 'chat',
    reasoningEffort: effort === 'max' ? 'max' : 'high',
  };
}

/** Facade 有独立的 5 分钟超时与 Claude 零重试默认；连接配置与直接 Gateway 共用。 */
export function resolveProviderSettings(
  providerId: ProviderId,
  config: AiProviderConfig = {},
  env: ConfigEnvironment = process.env
) {
  const connection = resolveConnection(providerId, config, env);
  const concurrency = resolveConcurrency(config.maxConcurrency, providerId, env);
  return {
    ...config,
    ...connection,
    model:
      configString(config.model, 'model') ||
      scopedModel(env, 'AI', providerId) ||
      defaultModel(providerId),
    // 保留既有 facade 的 localhost 默认；直接 Gateway 的 registry 默认仍为 127.0.0.1。
    baseUrl:
      providerId === 'ollama' && !config.baseUrl && !env.ALEMBIC_OLLAMA_BASE_URL
        ? 'http://localhost:11434/v1'
        : connection.baseUrl,
    timeout: config.timeout || 300_000,
    maxRetries: config.maxRetries ?? (providerId === 'claude' ? 0 : 3),
    maxConcurrency: concurrency.value,
    concurrencySource: concurrency.source,
    transportExtras: {
      ...(providerId !== 'claude' ? { embedModel: connection.embedModel } : {}),
      ...(providerId === 'openai' || providerId === 'ollama'
        ? { apiStyle: connection.apiStyle }
        : {}),
      // 宿主回执读取该字段；其他协议不能挂上并未实际使用的推理策略。
      ...(providerId === 'deepseek' ? { reasoningEffort: connection.reasoningEffort } : {}),
    },
  };
}

export function configuredProvider(
  value: unknown,
  env: ConfigEnvironment = process.env
): ProviderId {
  const raw = value || env.ALEMBIC_AI_PROVIDER || 'google';
  const id = typeof raw === 'string' ? canonicalProvider(raw) : undefined;
  if (!id) {
    throw new Error(`Unknown AI provider: ${typeof raw === 'string' ? raw : '(invalid type)'}`);
  }
  return id;
}

export function detectProvider(
  env: ConfigEnvironment = process.env
): { provider: ProviderId; model?: string } | null {
  const requested = env.ALEMBIC_AI_PROVIDER;
  let missingPrimary = false;
  if (requested && requested.trim().toLowerCase() !== 'auto') {
    const id = configuredProvider(requested, env);
    const descriptor = providerConfig(id);
    if (!descriptor.keyEnvVar || env[descriptor.keyEnvVar]?.trim()) {
      return { provider: id };
    }
    missingPrimary = true;
    Logger.getInstance().warn(
      `[ai-config] missing_primary_key provider=${id}; detecting another configured provider`
    );
  }
  for (const id of AUTO_DETECT_ORDER) {
    const keyEnv = providerConfig(id).keyEnvVar;
    if (env[keyEnv]?.trim()) {
      Logger.getInstance().debug(
        `[ai-config] provider_detected provider=${id} fallback=${missingPrimary}`
      );
      return { provider: id, ...(missingPrimary ? { model: defaultModel(id) } : {}) };
    }
  }
  Logger.getInstance().info(
    '[ai-config] no_provider_key; AI disabled until the host configures credentials'
  );
  return null;
}

export function availableFallbacks(
  currentProvider: string,
  env: ConfigEnvironment = process.env
): ProviderId[] {
  const current = canonicalProvider(currentProvider);
  return PROVIDER_CONFIGS.filter(
    ({ id, keyEnvVar }) => id !== current && keyEnvVar && env[keyEnvVar]?.trim()
  ).map(({ id }) => id);
}

export function embedProviderOptions(env: ConfigEnvironment = process.env) {
  if (!env.ALEMBIC_EMBED_PROVIDER) {
    return null;
  }
  const provider = configuredProvider(env.ALEMBIC_EMBED_PROVIDER, env);
  const model = env.ALEMBIC_EMBED_MODEL || EMBEDDING_MODELS[provider];
  return {
    provider,
    // Main 的 embedding 回执读取 model；它必须与实际 embedding 模型相同。
    model,
    embedModel: model,
    baseUrl: env.ALEMBIC_EMBED_BASE_URL || undefined,
    apiKey: env.ALEMBIC_EMBED_API_KEY || undefined,
  };
}

/** 保留同步 UI 配置投影，返回声明值与 key 存在性，不返回任何凭据。 */
export function aiConfigInfo(env: ConfigEnvironment = process.env) {
  const hasKey = (id: ProviderId) => !!env[providerConfig(id).keyEnvVar]?.trim();
  const keys = {
    google: hasKey('google'),
    openai: hasKey('openai'),
    claude: hasKey('claude'),
    deepseek: hasKey('deepseek'),
  };
  return {
    provider: env.ALEMBIC_AI_PROVIDER || 'auto',
    model: env.ALEMBIC_AI_MODEL || '',
    embedProvider: env.ALEMBIC_EMBED_PROVIDER || '',
    embedModel: env.ALEMBIC_EMBED_MODEL || '',
    hasKey: Object.values(keys).some(Boolean),
    keys,
  };
}
