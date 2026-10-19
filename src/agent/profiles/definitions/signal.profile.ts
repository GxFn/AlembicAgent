import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

/**
 * signal-analysis（L8-C12）：仓内与宿主生产代码都没有运行它的入口，经 BUILTIN_PROFILES 公开导出。
 * AgentProfileCompiler 在 params.mode === 'auto' 时按 id 授予 suggest_skills / create_skill，这两个工具
 * 并未注册，命中时编译器记 signal_analysis_auto_tools_unregistered 告警。宿主测试仍断言该 profile 与
 * auto 授权的取值，所以删除不在本仓单方面进行，随待决事项②走宿主配合的退役包。
 * memory: { enabled: false } 与 projection 等同其他 profile，都是描述性声明，运行时不读取。
 */
export const SIGNAL_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'signal-analysis',
    title: 'Signal Analysis',
    serviceKind: 'background-analysis',
    lifecycle: 'active',
    basePreset: 'chat',
    defaults: {
      skills: [],
      policies: [
        { type: 'budget', maxIterations: 8, maxTokens: 4096, temperature: 0.4, timeoutMs: 120_000 },
      ],
      memory: { enabled: false },
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'single' },
    projection: 'agent-result',
  },
];
