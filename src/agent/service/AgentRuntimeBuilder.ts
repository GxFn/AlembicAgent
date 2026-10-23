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
import type { RuntimeConfig } from '../runtime/AgentRuntimeTypes.js';
import type { Strategy } from '../strategies/index.js';
import type {
  AgentProfileOverride,
  AgentProfileRef,
  AgentRuntimeBuildOptions,
  CompiledAgentProfile,
} from './AgentRunContracts.js';

/**
 * AgentRuntime 构造契约里 aiProvider / toolRegistry 的类型，直接取自 RuntimeConfig，与运行时契约同源：
 * RuntimeConfig 改动时这里跟着变，不再像 `as never` 那样可以冒充任意目标类型。
 * toolRegistry 的 builder 选项与 RuntimeConfig 使用同一个最小端口（W2a-02 / L3-P09）：旧的
 * duck-typed `getRouter?()` 形状已删除，builder 不再从目录取 router，因此也不再需要断言。
 */
type RuntimeAiProvider = RuntimeConfig['aiProvider'];
type RuntimeToolRegistry = RuntimeConfig['toolRegistry'];

interface AgentRuntimeBuilderOptions {
  container: Record<string, unknown>;
  toolRegistry: RuntimeToolRegistry;
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
  #toolRegistry: RuntimeToolRegistry;
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
    // 宿主注入边界：builder 的 aiProvider 选项按宿主 DI 实际注入的形状声明（unknown，宿主传
    // `singletons.aiProvider || null`），而 RuntimeConfig 要求完整的 AiProvider 类类型。AgentRuntime 构造期
    // 只读 aiProvider.name/model（推导 modelRef），运行期再调 aiProvider.chatWithTools 等方法。收窄 builder
    // 的 aiProvider 选项属于公开面收窄，不在本处做；这里也不加运行时校验，避免改变既有错误行为，因此保留
    // aiProvider 这一处静态断言（目标类型对齐 RuntimeConfig）。toolRegistry 已与 RuntimeConfig 同型，无需断言。
    // 路由只经 toolRouter 选项（或容器里的 'toolRouter'）传入：目录上的 getRouter 兜底已删除（W2a-02），
    // 缺省时由 AgentRuntime 构造期抛 “AgentRuntime requires ToolRouter”。
    return new AgentRuntime({
      presetName,
      aiProvider: this.#aiProvider as RuntimeAiProvider,
      toolRegistry: this.#toolRegistry,
      toolRouter: (this.#toolRouter as ToolRouterContract | null) || null,
      container: this.#container,
      capabilities,
      strategy: preset.strategyInstance as Strategy,
      policies: new PolicyEngine(resolvedPolicies),
      persona: preset.persona as Record<string, unknown> | undefined,
      // preset/profile 的 memory 声明不再传给运行时（W2a-06 / L8-P17）：没有读取者；记忆由运行上下文的
      // memoryCoordinator 决定（AgentService 经 RuntimeOptions 传入，不经 builder）。
      onProgress: options.onProgress || null,
      onToolCall: options.onToolCall || null,
      lang: options.lang || null,
      additionalTools: compiled.additionalTools || [],
      projectRoot: this.#sharedOpts.projectRoot,
      dataRoot: this.#sharedOpts.dataRoot,
    });
  }

  // 每次 build 都经 CapabilityRegistry.create 新建全部 capability 实例，不跨运行复用；这里只注入与运行
  // 无关的构造配置，per-run 状态（如记忆协调器）经运行上下文进入循环，不要把 per-run 缓存放进 capability。
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
