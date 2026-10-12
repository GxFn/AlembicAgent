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
  projectBriefing?: string | null;
  projectRoot?: string;
  dataRoot?: string;
  toolRouter?: unknown;
  /**
   * 宿主产品人格资源 SOUL.md 的路径（可选）。
   *
   * SOUL.md 是 Alembic 产品人格，归宿主所有、不随 Agent 包发布；宿主应传入自己包根下的
   * SOUL.md。未传时 Conversation 回落到 Agent 包根默认路径（当前不存在，只记 info 诊断，
   * 人格段为空）。Agent 只负责透传与加载，不读取或校验其内容。
   */
  soulPath?: string;
}

export class AgentRuntimeBuilder {
  #container: Record<string, unknown>;
  #toolRegistry: ToolRegistryLike;
  #aiProvider: unknown;
  #toolRouter: unknown;
  #logger = Logger.getInstance();
  #profileCompiler?: AgentProfileCompiler;
  #sharedOpts: {
    projectBriefing: string | null;
    projectRoot: string;
    dataRoot: string;
    soulPath: string | null;
  };

  constructor({
    container,
    toolRegistry,
    aiProvider,
    projectBriefing = null,
    projectRoot = process.cwd(),
    dataRoot = projectRoot,
    toolRouter = null,
    soulPath,
  }: AgentRuntimeBuilderOptions) {
    this.#container = container;
    this.#toolRegistry = toolRegistry;
    this.#aiProvider = aiProvider;
    this.#toolRouter = toolRouter;
    this.#sharedOpts = {
      projectBriefing,
      projectRoot,
      dataRoot,
      // 空串与未传等价（与 Conversation 的归一化一致），统一记为 null 表示「宿主未接线」。
      soulPath: typeof soulPath === 'string' && soulPath.length > 0 ? soulPath : null,
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

  // 能力实例跨运行复用，这里只传与运行无关的配置；记忆协调器按每次运行经上下文进入循环。
  // soulPath 只有 Conversation 消费，其他能力忽略该键；为 null 时 Conversation 走默认路径并留诊断。
  #getCapabilityOpts() {
    return {
      container: this.#container,
      projectBriefing: this.#sharedOpts.projectBriefing,
      projectRoot: this.#sharedOpts.projectRoot,
      soulPath: this.#sharedOpts.soulPath,
    };
  }
}

export default AgentRuntimeBuilder;
