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

const FEATURE_FLAGS = [
  {
    name: 'ALEMBIC_AI_PROVIDER',
    owner: 'agent-ai-boundary',
    defaultValue: 'auto',
    productionRelevant: true,
    sourceRefs: ['src/ai/AiFactory.ts'],
  },
  {
    name: 'ALEMBIC_AI_MODEL',
    owner: 'agent-ai-boundary',
    defaultValue: 'provider-default',
    productionRelevant: true,
    sourceRefs: ['src/ai/AiFactory.ts'],
  },
  {
    name: 'ALEMBIC_AI_MAX_CONCURRENCY',
    owner: 'agent-ai-boundary',
    defaultValue: '4',
    productionRelevant: true,
    sourceRefs: ['src/ai/AiProvider.ts', 'src/ai/shared/reliability.ts'],
  },
  {
    name: 'ALEMBIC_EMBED_PROVIDER',
    owner: 'agent-ai-boundary',
    defaultValue: 'unset',
    productionRelevant: false,
    sourceRefs: ['src/ai/AiFactory.ts'],
  },
  {
    name: 'ALEMBIC_DEEPSEEK_REASONING_EFFORT', // provider-name-ok: env manifest record, owner=provider-adapter
    owner: 'provider-adapter',
    defaultValue: 'high',
    productionRelevant: true,
    allowedValues: ['low', 'medium', 'high'],
    sourceRefs: ['src/ai/providers/DeepSeekProvider.ts'], // provider-name-ok: env manifest record, owner=provider-adapter
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
