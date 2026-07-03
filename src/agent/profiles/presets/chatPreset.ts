/**
 * chat preset —— 通用对话的运行时基块(W6-e 自 presets.ts 拆出,内容原样)。
 * 主体 HTTP 面消费:ai.ts profile:{preset:'chat'} 与 PRESETS 投影。
 */
import { BudgetPolicy } from '../../policies/index.js';
import type { PolicyFactoryConfig } from './types.js';

export const CHAT_PRESET = {
  name: '对话',
  description: '多轮对话、知识检索、代码问答。适用于 Dashboard 和 HTTP/API 的常规对话。',
  capabilities: ['conversation', 'code_analysis'],
  strategy: { type: 'single' },
  policies: [
    (config?: PolicyFactoryConfig) =>
      new BudgetPolicy({
        maxIterations: config?.maxIterations ?? 8,
        maxTokens: config?.maxTokens ?? 4096,
        temperature: config?.temperature ?? 0.7,
        timeoutMs: config?.timeoutMs ?? 120_000,
      }),
  ],
  persona: {
    role: 'assistant',
    description: 'Alembic 知识管理助手',
  },
  memory: {
    enabled: true,
    mode: 'user',
    tiers: ['working', 'episodic', 'semantic'],
  },
};
