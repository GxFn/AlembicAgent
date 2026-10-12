export type AgentRuntimeSeamId =
  | 'event-bus'
  | 'diagnostics'
  | 'budget'
  | 'llm-input-assembly'
  | 'tool-execution'
  | 'memory-context'
  | 'phase-state';

export interface AgentRuntimeDecompositionSeam {
  readonly id: AgentRuntimeSeamId;
  readonly owner: 'agent-runtime' | 'runtime-helper' | 'tool-boundary' | 'ai-boundary';
  readonly implementationRefs: readonly string[];
  readonly behaviorChangeAllowed: false;
  readonly summary: string;
}

export type AgentSemanticTerm = 'agent' | 'tool' | 'session' | 'memory';

export interface AgentSemanticGlossaryEntry {
  readonly term: AgentSemanticTerm;
  readonly owner: 'agent-runtime' | 'tool-system' | 'memory-system' | 'host';
  readonly definition: string;
  readonly nonGoals: readonly string[];
  readonly sourceRefs: readonly string[];
}

export interface AgentRuntimeFeatureFlag {
  readonly name: string;
  readonly owner: 'agent-ai-boundary' | 'agent-runtime' | 'provider-adapter';
  readonly defaultValue: string;
  readonly productionRelevant: boolean;
  readonly allowedValues?: readonly string[];
  readonly sourceRefs: readonly string[];
}

export interface AgentRuntimeBoundaryRoute {
  readonly owner: 'agent-ai-boundary' | 'transport-private';
  readonly allowedAccessRefs: readonly string[];
  readonly forbiddenOwner: 'agent-runtime' | 'tool-system' | 'host';
  readonly summary: string;
}

export interface AgentRuntimeResponsibilityManifest {
  readonly version: 1;
  readonly decompositionSeams: readonly AgentRuntimeDecompositionSeam[];
  readonly semanticGlossary: readonly AgentSemanticGlossaryEntry[];
  readonly featureFlags: readonly AgentRuntimeFeatureFlag[];
  readonly modelRegistryBoundary: AgentRuntimeBoundaryRoute;
  readonly apiResponseBoundary: AgentRuntimeBoundaryRoute;
}

const DECOMPOSITION_SEAMS = [
  {
    id: 'event-bus',
    owner: 'runtime-helper',
    implementationRefs: ['src/agent/runtime/AgentEventBus.ts', 'src/agent/runtime/HookSystem.ts'],
    behaviorChangeAllowed: false,
    summary: 'Runtime emits semantic events; observers and hooks do not own orchestration state.',
  },
  {
    id: 'diagnostics',
    owner: 'runtime-helper',
    implementationRefs: ['src/agent/runtime/DiagnosticsCollector.ts'],
    behaviorChangeAllowed: false,
    summary: 'Diagnostics aggregation is separated from loop decisions and tool execution.',
  },
  {
    id: 'budget',
    owner: 'runtime-helper',
    implementationRefs: ['src/agent/runtime/BudgetController.ts'],
    behaviorChangeAllowed: false,
    summary: 'Token and turn budget accounting stays in BudgetController.',
  },
  {
    id: 'llm-input-assembly',
    owner: 'ai-boundary',
    implementationRefs: [
      'src/agent/runtime/LLMInputAssembly.ts',
      'src/agent/runtime/LLMInputMeasurement.ts',
    ],
    behaviorChangeAllowed: false,
    summary: 'Provider-visible input assembly is isolated from the orchestration loop.',
  },
  {
    id: 'tool-execution',
    owner: 'tool-boundary',
    implementationRefs: ['src/agent/runtime/ToolExecutionPipeline.ts', 'src/tools/kernel/index.ts'],
    behaviorChangeAllowed: false,
    summary:
      'Tool calls cross the unified kernel contract and pipeline; the single tool contract lives in src/tools/kernel.',
  },
  {
    id: 'memory-context',
    owner: 'runtime-helper',
    implementationRefs: [
      'src/agent/memory/MemoryCoordinator.ts',
      'src/agent/memory/MemoryStore.ts',
      'src/agent/context/ContextWindow.ts',
    ],
    behaviorChangeAllowed: false,
    summary: 'Context assembly and memory persistence are runtime services, not Core migrations.',
  },
  {
    id: 'phase-state',
    owner: 'agent-runtime',
    implementationRefs: ['src/agent/runtime/AgentRuntime.ts', 'src/agent/runtime/LoopContext.ts'],
    behaviorChangeAllowed: false,
    summary: 'The orchestration loop retains phase and transition ownership.',
  },
] as const satisfies readonly AgentRuntimeDecompositionSeam[];

const SEMANTIC_GLOSSARY = [
  {
    term: 'agent',
    owner: 'agent-runtime',
    definition:
      'The runtime orchestrator that plans, calls tools, tracks budgets, and reports progress.',
    nonGoals: ['Core deterministic repository', 'Codex host route', 'Dashboard UI'],
    sourceRefs: ['src/agent/runtime/AgentRuntime.ts', 'src/agent/service/AgentRuntimeBuilder.ts'],
  },
  {
    term: 'tool',
    owner: 'tool-system',
    definition: 'A typed capability invoked through Agent tool contracts and normalized envelopes.',
    nonGoals: ['Host UI action', 'Dashboard operation without Agent contract'],
    sourceRefs: ['src/tools/runtime/router.ts', 'src/tools/kernel/index.ts'],
  },
  {
    term: 'session',
    owner: 'memory-system',
    definition:
      'A persisted execution memory/checkpoint scope for dimensions, cache, and summaries.',
    nonGoals: ['Thread id storage', 'Host transport ownership'],
    sourceRefs: ['src/agent/memory/SessionStore.ts'],
  },
  {
    term: 'memory',
    owner: 'memory-system',
    definition:
      'Agent-side recall, evidence, and context persistence consumed by runtime decisions.',
    nonGoals: ['Core schema ownership', 'Silent write failure'],
    sourceRefs: ['src/agent/memory/MemoryStore.ts', 'src/agent/memory/MemoryCoordinator.ts'],
  },
] as const satisfies readonly AgentSemanticGlossaryEntry[];

/**
 * 运行时行为开关清单（公开常量的数据，签名不变）。
 *
 * - 收录 src 中实际读取的 ALEMBIC_* 环境变量开关；sourceRefs 指向真正读取该变量的源文件
 *   （process.env.X、注入的 env 参数、profile 并发声明 { env: 'X' } 或按 provider 拼装的变量名），
 *   不再指向只在注释里提到它的文件。
 * - 不收录连接配置：provider 注册表登记的凭据/端点变量（PROVIDER_CONFIGS.keyEnvVar/baseUrlEnvVar）
 *   以及 embedding 的凭据/端点变量，它们决定“连到哪里、用什么凭据”，不是行为开关。
 * - 前 5 项是既有公开名单，次序保持不变；其后为 I42 补齐的遗漏开关，只追加不重排。
 * - test/contract-surface.test.ts 校验两件事：每个 sourceRef 文件存在且确实读取该变量；
 *   src 中 ALEMBIC_* 环境变量读取集合（排除连接配置）是本清单的子集。新增开关必须同步登记。
 */
const FEATURE_FLAGS = [
  {
    name: 'ALEMBIC_AI_PROVIDER',
    owner: 'agent-ai-boundary',
    defaultValue: 'auto',
    productionRelevant: true,
    sourceRefs: [
      'src/ai/configuration.ts',
      'src/ai/AiFactory.ts',
      'src/agent/context/ContextWindow.ts',
    ],
  },
  {
    name: 'ALEMBIC_AI_MODEL',
    owner: 'agent-ai-boundary',
    defaultValue: 'provider-default',
    productionRelevant: true,
    sourceRefs: ['src/ai/configuration.ts'],
  },
  {
    // 非 google provider 未设置时默认 4；google 先看 ALEMBIC_GEMINI_MAX_CONCURRENCY，两者都未设置时默认 2。
    name: 'ALEMBIC_AI_MAX_CONCURRENCY',
    owner: 'agent-ai-boundary',
    defaultValue: '4',
    productionRelevant: true,
    sourceRefs: ['src/ai/shared/concurrency.ts'],
  },
  {
    name: 'ALEMBIC_EMBED_PROVIDER',
    owner: 'agent-ai-boundary',
    defaultValue: 'unset',
    productionRelevant: false,
    sourceRefs: ['src/ai/configuration.ts'],
  },
  {
    name: 'ALEMBIC_DEEPSEEK_REASONING_EFFORT', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'high',
    productionRelevant: true,
    allowedValues: ['high', 'max'],
    sourceRefs: ['src/ai/configuration.ts'],
  },
  {
    // embedding 模型；未设置时用当前 embedding provider 的默认模型。
    name: 'ALEMBIC_EMBED_MODEL',
    owner: 'agent-ai-boundary',
    defaultValue: 'provider-default',
    productionRelevant: false,
    sourceRefs: ['src/ai/configuration.ts'],
  },
  {
    // 只对该 provider 生效；非法取值告警后按 chat 处理。
    name: 'ALEMBIC_OPENAI_API_STYLE', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'chat',
    productionRelevant: true,
    allowedValues: ['chat', 'responses'],
    sourceRefs: ['src/ai/configuration.ts'],
  },
  {
    // 未设置时回落到 ALEMBIC_AI_MAX_CONCURRENCY，再回落到该 provider 的默认值 2。
    name: 'ALEMBIC_GEMINI_MAX_CONCURRENCY', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/shared/concurrency.ts'],
  },
  {
    // 通用代理：优先级低于下方按 provider 的专属代理变量，高于标准 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY。
    name: 'ALEMBIC_AI_PROXY',
    owner: 'agent-ai-boundary',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  // 按 provider 的专属代理（LLMTransport.resolveProxyUrl 以 ALEMBIC_<PROVIDER>_PROXY_HTTPS/HTTP 拼装）：
  // HTTPS 优先于 HTTP；取值 direct 表示该 provider 显式直连，不再回落到通用代理变量。
  {
    name: 'ALEMBIC_GOOGLE_PROXY_HTTPS', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_GOOGLE_PROXY_HTTP', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_OPENAI_PROXY_HTTPS', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_OPENAI_PROXY_HTTP', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_DEEPSEEK_PROXY_HTTPS', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_DEEPSEEK_PROXY_HTTP', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_CLAUDE_PROXY_HTTPS', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_CLAUDE_PROXY_HTTP', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_OLLAMA_PROXY_HTTPS', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    name: 'ALEMBIC_OLLAMA_PROXY_HTTP', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'unset',
    productionRelevant: true,
    sourceRefs: ['src/ai/transport/LLMTransport.ts'],
  },
  {
    // 只有取值 '1' 时开启 L4 压缩；BudgetControllerConfig.enableL4Compaction 显式配置优先。
    name: 'ALEMBIC_AGENT_ENABLE_L4_COMPACTION',
    owner: 'agent-runtime',
    defaultValue: 'unset',
    productionRelevant: true,
    allowedValues: ['1'],
    sourceRefs: ['src/agent/runtime/BudgetController.ts'],
  },
  {
    // 取值 '1' 时不向 stderr 回显 nudge 的开发者观察副本；不改变模型消息与执行路径。
    name: 'ALEMBIC_MCP_MODE',
    owner: 'agent-runtime',
    defaultValue: 'unset',
    productionRelevant: false,
    allowedValues: ['1'],
    sourceRefs: ['src/agent/runtime/AgentRuntime.ts'],
  },
  {
    // generate 编排的 tier 并发；由 AgentRunCoordinator 按 profile 声明读取，
    // 未设置或不是正整数时回落 profile 默认值（不是正整数时另有告警）。
    name: 'ALEMBIC_BOOTSTRAP_CONCURRENCY',
    owner: 'agent-runtime',
    defaultValue: '2',
    productionRelevant: true,
    sourceRefs: ['src/agent/profiles/definitions/generate.profile.ts'],
  },
  {
    // module-mining 编排的 tier 并发；读取与回落规则同上。
    name: 'ALEMBIC_MODULE_MINING_CONCURRENCY',
    owner: 'agent-runtime',
    defaultValue: '2',
    productionRelevant: true,
    sourceRefs: ['src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.ts'],
  },
] as const satisfies readonly AgentRuntimeFeatureFlag[];

export const ALEMBIC_AGENT_RUNTIME_RESPONSIBILITY = Object.freeze({
  version: 1,
  decompositionSeams: DECOMPOSITION_SEAMS,
  semanticGlossary: SEMANTIC_GLOSSARY,
  featureFlags: FEATURE_FLAGS,
  modelRegistryBoundary: {
    owner: 'agent-ai-boundary',
    allowedAccessRefs: ['src/ai/gateway/LLMGateway.ts', 'src/agent/context/ContextWindow.ts'],
    forbiddenOwner: 'tool-system',
    summary: 'ModelRegistry access stays behind AI gateway/context budget boundaries.',
  },
  apiResponseBoundary: {
    owner: 'transport-private',
    allowedAccessRefs: ['src/ai/AiProvider.ts'],
    forbiddenOwner: 'agent-runtime',
    summary:
      'Loose ApiResponse typing is transport/provider-private and must not leak into runtime contracts.',
  },
} as const satisfies AgentRuntimeResponsibilityManifest);
