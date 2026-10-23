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
  // persona 与 profile/override 浅合并；运行时只读 description（系统提示“# 角色”段），role 没有读取者。
  persona: {
    role: 'assistant',
    description: 'Alembic 知识管理助手',
  },
  // memory 块只是描述性声明（L8-C11）：enabled / tiers / mode 都没有读取者，也不再传给运行时（W2a-06 删除了
  // memoryMode 空传递）。记忆是否参与由运行上下文的 memoryCoordinator 决定，改这里的值不会开关记忆。
  // 字段形状属于宿主可见的 PRESETS 值，待宿主测试移除 memory 键后再删除。
  memory: {
    enabled: true,
    mode: 'user',
    tiers: ['working', 'episodic', 'semantic'],
  },
};
