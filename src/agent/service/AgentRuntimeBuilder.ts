import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { ToolRouterContract } from '#tools/kernel/index.js';
import { CapabilityRegistry } from '../../tools/runtime/toolsets/CapabilityRegistry.js';
import { type Policy, PolicyEngine } from '../policies/index.js';
import {
  type AgentProfileCompiler,
  createDefaultProfileCompiler,
} from '../profiles/AgentProfileCompiler.js';
import { getPreset } from '../profiles/presets/index.js';
import { AgentRuntime } from '../runtime/AgentRuntime.js';
import type { Strategy } from '../strategies/index.js';
import type {
  AgentProfileOverride,
  AgentProfileRef,
  AgentRuntimeBuildOptions,
  CompiledAgentProfile,
} from './AgentRunContracts.js';

/** Duck-typed tool registry — compatible with both ToolRegistry and UnifiedToolCatalog */
interface ToolRegistryLike {
  getRouter?(): ToolRouterContract | null;
}

interface AgentRuntimeBuilderOptions {
  container: Record<string, unknown>;
  toolRegistry: ToolRegistryLike;
  aiProvider: unknown;
  memoryCoordinator?: unknown;
  projectBriefing?: string | null;
  projectRoot?: string;
  dataRoot?: string;
  toolRouter?: unknown;
}

export class AgentRuntimeBuilder {
  #container: Record<string, unknown>;
  #toolRegistry: ToolRegistryLike;
  #aiProvider: unknown;
  #toolRouter: unknown;
  #logger = Logger.getInstance();
  #profileCompiler?: AgentProfileCompiler;
  #sharedOpts: {
    memoryCoordinator: unknown;
    projectBriefing: string | null;
    projectRoot: string;
    dataRoot: string;
  };

  constructor({
    container,
    toolRegistry,
    aiProvider,
    memoryCoordinator = null,
    projectBriefing = null,
    projectRoot = process.cwd(),
    dataRoot = projectRoot,
    toolRouter = null,
  }: AgentRuntimeBuilderOptions) {
    this.#container = container;
    this.#toolRegistry = toolRegistry;
    this.#aiProvider = aiProvider;
    this.#toolRouter = toolRouter;
    this.#sharedOpts = {
      memoryCoordinator,
      projectBriefing,
      projectRoot,
      dataRoot,
    };
  }

  build(
    profileRef: AgentProfileRef | AgentProfileOverride | CompiledAgentProfile,
    options: AgentRuntimeBuildOptions = {}
  ) {
    const compiled =
      'kind' in profileRef && profileRef.kind === 'compiled-agent-profile'
        ? profileRef
        : (this.#profileCompiler ??= createDefaultProfileCompiler()).compile(profileRef);
    const presetName = compiled.basePreset;
    const overrides = compiled.runtimeOverrides || {};
    const preset = getPreset(presetName, overrides as Record<string, unknown>);
    const capabilities = ((preset.capabilities as string[]) || []).map((name) =>
      CapabilityRegistry.create(name, this.#getCapabilityOpts())
    );
    const resolvedPolicies = (
      (preset.policies || []) as Array<Policy | ((input: Record<string, unknown>) => Policy)>
    ).map((policyOrFactory) =>
      typeof policyOrFactory === 'function'
        ? policyOrFactory(overrides as Record<string, unknown>)
        : policyOrFactory
    );

    observeSafely(
      () => this.#logger.debug('[AgentRuntimeBuilder] building runtime', { presetName }),
      () => undefined
    );
    return new AgentRuntime({
      presetName,
      aiProvider: this.#aiProvider as never,
      toolRegistry: this.#toolRegistry as never,
      toolRouter:
        (this.#toolRouter as ToolRouterContract) || this.#toolRegistry.getRouter?.() || null,
      container: this.#container,
      capabilities,
      strategy: preset.strategyInstance as Strategy,
      policies: new PolicyEngine(resolvedPolicies),
      persona: preset.persona as Record<string, unknown> | undefined,
      memory: preset.memory as Record<string, unknown> | undefined,
      onProgress: options.onProgress || null,
      onToolCall: options.onToolCall || null,
      lang: options.lang || null,
      additionalTools: compiled.additionalTools || [],
      projectRoot: this.#sharedOpts.projectRoot,
      dataRoot: this.#sharedOpts.dataRoot,
    });
  }

  #getCapabilityOpts() {
    return {
      container: this.#container,
      memoryCoordinator: this.#sharedOpts.memoryCoordinator,
      projectBriefing: this.#sharedOpts.projectBriefing,
      projectRoot: this.#sharedOpts.projectRoot,
    };
  }
}

export default AgentRuntimeBuilder;
