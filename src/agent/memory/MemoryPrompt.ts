import { estimateTokens, truncateToTokenBudget } from '#shared/tokenUtils.js';
import {
  type MemoryReadOptions,
  memoryReadDeadline,
  readMemoryValue,
  reportMemoryRead,
} from './MemoryReadPolicy.js';

export type MemoryMode = 'user' | 'analyst' | 'producer';
export interface MemoryBudgetAllocation {
  activeContext: number;
  sessionStore: number;
  persistentMemory: number;
  conversationLog: number;
}
export const DEFAULT_MEMORY_BUDGET = 4000;
const PROFILES: Record<MemoryMode, MemoryBudgetAllocation> = {
  user: { activeContext: 0.2, sessionStore: 0, persistentMemory: 0.6, conversationLog: 0.2 },
  analyst: {
    activeContext: 0.45,
    sessionStore: 0.35,
    persistentMemory: 0.15,
    conversationLog: 0.05,
  },
  producer: {
    activeContext: 0.25,
    sessionStore: 0.55,
    persistentMemory: 0.15,
    conversationLog: 0.05,
  },
};

/** 取整余数归工作记忆，四层之和恰好等于总预算。 */
export function allocateMemoryBudget(mode: MemoryMode, total: number): MemoryBudgetAllocation {
  const budget = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : DEFAULT_MEMORY_BUDGET;
  const profile = PROFILES[mode] || PROFILES.analyst;
  const sessionStore = Math.floor(budget * profile.sessionStore);
  const persistentMemory = Math.floor(budget * profile.persistentMemory);
  const conversationLog = Math.floor(budget * profile.conversationLog);
  return {
    activeContext: budget - sessionStore - persistentMemory - conversationLog,
    sessionStore,
    persistentMemory,
    conversationLog,
  };
}

export interface MemoryPromptOptions extends MemoryReadOptions {
  source?: string;
  query?: string;
  limit?: number;
  tokenBudget?: number;
}
export interface MemoryPromptPort {
  toPromptSection(options: MemoryPromptOptions): Promise<string | null> | string | null;
}
export interface MemoryPromptSection {
  source: 'persistent' | 'session' | 'working';
  content: string;
  usedTokens: number;
  budget: number;
}

/** 读取端口即使忽略预算，装配边界也不能把超额内容直接交给模型。 */
export function projectMemorySection(
  source: MemoryPromptSection['source'],
  text: string,
  budget: number,
  options: MemoryReadOptions = {}
): MemoryPromptSection {
  const content = truncateToTokenBudget(text, budget);
  if (content !== text) {
    reportMemoryRead(options, {
      phase: source,
      status: 'truncated',
      reason: 'section-token-budget',
      budget,
    });
  }
  return { source, content, budget, usedTokens: estimateTokens(content) };
}

export async function readPersistentMemorySection(
  port: MemoryPromptPort | null | undefined,
  options: MemoryPromptOptions
): Promise<MemoryPromptSection> {
  const budget = options.tokenBudget ?? DEFAULT_MEMORY_BUDGET;
  if (!port || budget <= 0 || options.abortSignal?.aborted) {
    return projectMemorySection('persistent', '', budget);
  }
  const deadlineAt = memoryReadDeadline(options);
  // 给内层 embedding 的词汇降级和 prompt 渲染留出收尾时间，不重复延长 deadline。
  const reserve = Math.min(50, Math.max(1, (deadlineAt - Date.now()) * 0.1));
  const result = await readMemoryValue(
    (signal) =>
      port.toPromptSection({
        ...options,
        abortSignal: signal,
        deadlineAt: deadlineAt - reserve,
        tokenBudget: budget,
      }),
    { ...options, deadlineAt }
  );
  if (result.status !== 'ok') {
    reportMemoryRead(options, {
      phase: 'persistent',
      status: result.status,
      reason: 'section-unavailable',
    });
    return projectMemorySection('persistent', '', budget);
  }
  if (result.value !== null && typeof result.value !== 'string') {
    reportMemoryRead(options, {
      phase: 'persistent',
      status: 'invalid',
      reason: 'invalid-prompt-result',
    });
    return projectMemorySection('persistent', '', budget);
  }
  return projectMemorySection('persistent', result.value || '', budget, options);
}
