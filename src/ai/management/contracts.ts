/** Provider 路由与计量合同；只依赖 AI DTO，不引入具体 Provider 或宿主。 */
import type { TokenUsagePayload } from '../contracts.js';

export type { TokenUsagePayload } from '../contracts.js';

/** AI Provider 最小接口（避免引入 AiProvider 具体类的循环依赖） */
export interface ManagedAiProvider {
  name: string;
  model: string;
  apiKey?: string;
  _onTokenUsage?: ((usage: TokenUsagePayload) => void) | null;
  supportsEmbedding?: () => boolean;
  _fallbackFrom?: string;
}

/** Token 记录器最小接口（对应 TokenUsageStore.record） */
export interface TokenRecorder {
  record(r: {
    source: string;
    provider?: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
  }): void;
}

/** Provider 信息快照 */
export interface ProviderInfo {
  name: string;
  model: string;
  isMock: boolean;
  supportsEmbedding: boolean;
}

/** 切换结果 */
export interface SwitchResult {
  previous: ProviderInfo;
  current: ProviderInfo;
  clearedSingletons: string[];
}

/** 切换监听器 */
export type SwitchListener = (result: SwitchResult) => void;
