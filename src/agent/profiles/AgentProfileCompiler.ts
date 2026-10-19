import Logger from '@alembic/core/logging';
import { BudgetPolicy, Policy, SafetyPolicy } from '../policies/index.js';
import type {
  AgentActionSpace,
  AgentConcurrencyPlan,
  AgentProfileDefinition,
  AgentProfileOverride,
  AgentProfileRef,
  AgentRunContext,
  AgentStrategyTemplate,
  CompiledAgentProfile,
} from '../service/AgentRunContracts.js';
import { AgentProfileRegistry } from './AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from './AgentStageFactoryRegistry.js';
import { evolutionAuditPolicyDeclarations } from './definitions/evolution.profile.js';
import { PRESETS } from './presets/index.js';

interface AgentProfileCompilerOptions {
  profileRegistry: AgentProfileRegistry;
  stageFactoryRegistry: AgentStageFactoryRegistry;
}

interface CompileOptions {
  params?: Record<string, unknown>;
  context?: AgentRunContext;
}

export class AgentProfileCompiler {
  #profileRegistry: AgentProfileRegistry;
  #stageFactoryRegistry: AgentStageFactoryRegistry;

  constructor({ profileRegistry, stageFactoryRegistry }: AgentProfileCompilerOptions) {
    this.#profileRegistry = profileRegistry;
    this.#stageFactoryRegistry = stageFactoryRegistry;
  }

  compile(
    profileInput: AgentProfileRef | AgentProfileOverride | CompiledAgentProfile,
    options: CompileOptions = {}
  ): CompiledAgentProfile {
    if (isCompiledProfile(profileInput)) {
      return profileInput;
    }
    if ('basePreset' in profileInput) {
      return this.#compileOverride(profileInput, options);
    }
    return this.#compileRef(profileInput, options);
  }

  /**
   * 解析 { id?, preset?, params? } 引用（L8-C02）：
   *   - 显式 id 命中注册表：编译该声明，preset 字段不参与；
   *   - 显式 id 未注册：fail-fast 抛 Unknown agent profile，不再静默换成 preset 默认管线——拼错的 id
   *     （如 generate-dimesion）原来会拖到 runtime build 才以误导性的 Unknown preset 报错，
   *     { 未知 id, preset } 会被静默换成裸 preset 跑完整管线；
   *   - 兼容写法（事项③未决，暂保留）：id 恰好是内置 preset 名（如 { id: 'chat' }）且没有给出不同的
   *     preset 时，按该 preset 编译并记 warn，调用方应改用 { preset }；
   *   - 只给 preset：先按注册表查同名声明，未命中再按 preset 编译（原有行为）。
   */
  #compileRef(profileRef: AgentProfileRef, options: CompileOptions): CompiledAgentProfile {
    const params = mergeParams(options.params, profileRef.params);
    const explicitId = profileRef.id;
    if (explicitId) {
      const definition = this.#profileRegistry.get(explicitId);
      if (definition) {
        return this.#compileDefinition(definition, params, options.context);
      }
      const requestedPreset = profileRef.preset ? String(profileRef.preset) : null;
      if (
        Object.hasOwn(PRESETS, explicitId) &&
        (!requestedPreset || requestedPreset === explicitId)
      ) {
        Logger.getInstance().warn(
          `[AgentProfileCompiler] profile_id_preset_fallback: profile id "${explicitId}" is not a registered agent profile; ` +
            `compiling it as the built-in preset "${explicitId}". Pass { preset: "${explicitId}" } instead of an id.`,
          { requestedId: explicitId, requestedPreset, resolvedPreset: explicitId }
        );
        return this.#compilePresetRef(explicitId, params);
      }
      throw new Error(
        requestedPreset
          ? `Unknown agent profile: "${explicitId}" (preset "${requestedPreset}" is not used as a fallback for an explicit profile id)`
          : `Unknown agent profile: "${explicitId}"`
      );
    }
    const preset = profileRef.preset ? String(profileRef.preset) : '';
    if (!preset) {
      throw new Error('AgentProfileRef requires id or preset');
    }
    const definition = this.#profileRegistry.get(preset);
    if (definition) {
      return this.#compileDefinition(definition, params, options.context);
    }
    return this.#compilePresetRef(preset, params);
  }

  #compileOverride(
    profileOverride: AgentProfileOverride,
    options: CompileOptions
  ): CompiledAgentProfile {
    const params = mergeParams(options.params, profileOverride.params);
    const actionSpace = profileOverride.actionSpace || { mode: 'listed', toolIds: [] };
    const runtimeOverrides = stripUndefined({
      ...presetBudgetParams(params),
      capabilities: profileOverride.skills,
      strategy: profileOverride.strategy,
      policies: compilePolicyDeclarations(profileOverride.policies),
      persona: profileOverride.persona,
      memory: profileOverride.memory,
    });
    const basePreset = String(profileOverride.basePreset);
    return {
      kind: 'compiled-agent-profile',
      id: profileOverride.id || basePreset,
      title: profileOverride.id || basePreset,
      // serviceKind 只是描述性分类（运行时不消费，见 AgentRunContracts）。override 路径与 preset 引用路径
      // 共用 serviceKindForPreset（L8-C11）：此前这里写死 'system-analysis'，{ basePreset: 'chat' } 与
      // { preset: 'chat' } 会得到不同分类；id 不参与推导。
      serviceKind: serviceKindForPreset(basePreset),
      lifecycle: 'active',
      basePreset: profileOverride.basePreset,
      skills: profileOverride.skills,
      strategy: profileOverride.strategy,
      policies: runtimeOverrides.policies as unknown[] | undefined,
      persona: profileOverride.persona,
      memory: profileOverride.memory,
      actionSpace,
      additionalTools: additionalToolsFromActionSpace(actionSpace),
      params,
      runtimeOverrides,
    };
  }

  #compilePresetRef(preset: string, params: Record<string, unknown>): CompiledAgentProfile {
    return {
      kind: 'compiled-agent-profile',
      id: preset,
      title: preset,
      serviceKind: serviceKindForPreset(preset),
      lifecycle: 'active',
      basePreset: preset,
      actionSpace: { mode: 'listed', toolIds: [] },
      additionalTools: [],
      params,
      runtimeOverrides: presetBudgetParams(params),
    };
  }

  #compileDefinition(
    definition: AgentProfileDefinition,
    inputParams: Record<string, unknown>,
    context?: AgentRunContext
  ): CompiledAgentProfile {
    const params = mergeParams(defaultParamsForProfile(definition.id), inputParams);
    assertFanoutConcurrencyPlan(definition);
    warnDeprecatedLifecycle(definition);
    const actionSpace = resolveActionSpace(definition, params);
    const strategy = compileStrategy(definition.strategy, {
      params,
      context: context as unknown as Record<string, unknown>,
      stageFactoryRegistry: this.#stageFactoryRegistry,
    });
    const policies = compilePolicyDeclarations(resolvePolicyDeclarations(definition, params));
    const runtimeOverrides = stripUndefined({
      capabilities: definition.defaults?.skills,
      strategy,
      policies,
      persona: definition.defaults?.persona,
      memory: definition.defaults?.memory,
    });
    return {
      kind: 'compiled-agent-profile',
      id: definition.id,
      title: definition.title,
      // serviceKind / lifecycle / projection 原样复制，仅作描述性元数据：运行时不据此分支（L8-C11），
      // 唯一的消费是上面 deprecated 的编译告警。
      serviceKind: definition.serviceKind,
      lifecycle: definition.lifecycle,
      basePreset: definition.basePreset || definition.id,
      skills: definition.defaults?.skills,
      strategy,
      policies,
      persona: definition.defaults?.persona,
      memory: definition.defaults?.memory,
      actionSpace,
      additionalTools: additionalToolsFromActionSpace(actionSpace),
      params,
      projection: definition.projection,
      concurrency: resolveConcurrencyPlan(definition.concurrency, params),
      runtimeOverrides,
    };
  }
}

function compileStrategy(
  strategy: AgentProfileDefinition['strategy'],
  {
    params,
    context,
    stageFactoryRegistry,
  }: {
    params: Record<string, unknown>;
    context?: Record<string, unknown>;
    stageFactoryRegistry: AgentStageFactoryRegistry;
  }
) {
  if (!strategy || (isStrategyTemplate(strategy) && strategy.type === 'preset')) {
    return undefined;
  }
  if (isStrategyTemplate(strategy) && strategy.type === 'pipeline') {
    return {
      type: 'pipeline',
      maxRetries: 1,
      stages: stageFactoryRegistry.build(strategy.factory, { params, context }),
    };
  }
  if (isStrategyTemplate(strategy) && strategy.type === 'single') {
    return { type: 'single' };
  }
  if (isStrategyTemplate(strategy) && strategy.type === 'fanout') {
    // 扇出由 AgentRunCoordinator 按 concurrency 计划执行（AgentService.canCoordinate 只看 concurrency），
    // 父 profile 自身不需要运行时策略，所以这里置空。计划是否完整、与模板是否一致已在
    // assertFanoutConcurrencyPlan 中校验，走到这里的 fanout 一定能进入协调分支。
    return undefined;
  }
  return strategy as Record<string, unknown>;
}

/** fanout 模板与 concurrency 计划必须逐项一致的字段；协调器只读 concurrency 侧。 */
const FANOUT_PLAN_FIELDS = ['childProfile', 'partitioner', 'merge'] as const;

/**
 * fanout 声明的编译期校验（L8-C02）。fanout 模板本身被编译成 undefined，真正的扇出只由 concurrency 计划驱动：
 *   - 缺 concurrency 或 mode 为 none 时，AgentService 不进协调分支，父 profile 会静默按 basePreset
 *     的默认完整管线执行（没有维度上下文、没有日志），所以必须在编译期抛错；
 *   - 模板与计划的 childProfile / partitioner / merge 不一致时，协调器以计划为准，模板字段成了误导性的
 *     死数据（计划缺字段时协调器还会回退到内置 child 或默认 merge），同样抛错，消息带 profile id 与字段名。
 */
function assertFanoutConcurrencyPlan(definition: AgentProfileDefinition) {
  const strategy = definition.strategy;
  if (!isStrategyTemplate(strategy) || strategy.type !== 'fanout') {
    return;
  }
  const plan = definition.concurrency;
  if (!plan) {
    throw new Error(
      `Agent profile "${definition.id}" declares a fanout strategy but no concurrency plan; ` +
        'fanout runs only through the concurrency plan'
    );
  }
  if (plan.mode === 'none') {
    throw new Error(
      `Agent profile "${definition.id}" declares a fanout strategy with concurrency mode "none"; ` +
        'use mode "tiered" or "parallel"'
    );
  }
  const template = strategy as Record<string, unknown>;
  for (const field of FANOUT_PLAN_FIELDS) {
    if (template[field] !== plan[field]) {
      throw new Error(
        `Agent profile "${definition.id}" fanout ${field} mismatch: strategy declares ` +
          `${JSON.stringify(template[field] ?? null)} but concurrency plan declares ${JSON.stringify(plan[field] ?? null)}`
      );
    }
  }
}

/**
 * 编译声明式 policy 列表（L8-C02）。只接受四种元素：
 *   - Policy 实例：原样透传（override 路径可直接注入实例；注册表路径的快照已拒绝类实例）；
 *   - 策略工厂函数：原样透传，由 AgentRuntimeBuilder 以 runtimeOverrides 调用生成 Policy；
 *   - { type: 'budget', ... }：构造 BudgetPolicy（带会话字段时告警，见 warnPolicySessionFields）；
 *   - { type: 'safety', ... }：构造 SafetyPolicy。
 * 其余声明（未知 type、缺 type 的对象、null/原始值）此前会被强转成 Policy 透传，整组替换 preset 默认
 * 策略后在运行时以 'policy.validateBefore is not a function' 失败且不指向声明来源；现在编译期抛
 * Unsupported agent policy declaration at index <i>: <type|missing>。不在这里新增 quality 等映射。
 */
function compilePolicyDeclarations(policies: unknown[] | undefined) {
  if (!policies) {
    return undefined;
  }
  return policies.map((policy, index) => {
    if (policy instanceof Policy || typeof policy === 'function') {
      return policy;
    }
    if (isRecord(policy) && policy.type === 'budget') {
      const { type: _type, ...config } = policy;
      warnPolicySessionFields(config);
      return new BudgetPolicy(config);
    }
    if (isRecord(policy) && policy.type === 'safety') {
      const { type: _type, ...config } = policy;
      return new SafetyPolicy(config);
    }
    const declaredType =
      isRecord(policy) && typeof policy.type === 'string' && policy.type ? policy.type : 'missing';
    throw new Error(`Unsupported agent policy declaration at index ${index}: ${declaredType}`);
  });
}

/** 策略层会话字段：会话预算归阶段预算 + BudgetController，这两个字段待公开面收窄（事项②）时删除。 */
const POLICY_SESSION_FIELDS = ['maxSessionTokens', 'maxSessionInputTokens'] as const;

/**
 * 声明式 budget 策略带会话字段时编译期告警（I03）。字段与运行行为保持不变（删除属于事项②），
 * 告警只让调用方看见口径差异：
 *   - 两个字段都按整次运行累计判定，而 BudgetController 执行的阶段会话预算按阶段内消耗；
 *   - maxSessionInputTokens 的拒绝在阶段预算未声明 maxSessionInputTokens 的循环里被屏蔽
 *     （运行时写 policy_session_limit_bypassed 诊断）；
 *   - BudgetController 不执行 maxSessionTokens，策略层配置时由 BudgetPolicy 照常按运行累计停止。
 * 每个 budget 声明告警一次，不抛错、不改写配置。
 */
function warnPolicySessionFields(config: Record<string, unknown>) {
  const present = POLICY_SESSION_FIELDS.filter((field) => config[field] !== undefined);
  if (present.length === 0) {
    return;
  }
  const declared = present.map((field) => `${field}=${String(config[field])}`).join(', ');
  Logger.getInstance().warn(
    `[AgentProfileCompiler] policy_session_fields_deprecated: budget policy declares ${declared}. ` +
      'Session budgets belong to stage budgets executed by BudgetController (in-stage consumption); ' +
      'policy-level session fields are checked against run-level cumulative usage and are scheduled for removal. ' +
      'maxSessionInputTokens rejections are bypassed in loops whose stage budget declares no maxSessionInputTokens ' +
      '(diagnostic policy_session_limit_bypassed); maxSessionTokens is not executed by BudgetController and stays ' +
      'enforced by BudgetPolicy at run level until removal.'
  );
}

function additionalToolsFromActionSpace(actionSpace: AgentActionSpace) {
  if (actionSpace.mode !== 'listed') {
    return [];
  }
  return [...actionSpace.toolIds];
}

/** signal-analysis auto 特判授予的工具；两者在工具目录与宿主中都没有注册（L8-C12）。 */
const SIGNAL_ANALYSIS_AUTO_TOOL_IDS = ['suggest_skills', 'create_skill'] as const;

function resolveActionSpace(definition: AgentProfileDefinition, params: Record<string, unknown>) {
  if (definition.id === 'signal-analysis' && params.mode === 'auto') {
    // 按 id 硬编码的提权分支（L8-C12）：授予的两个工具不存在，仓内与宿主生产代码也没有运行 signal-analysis
    // 的入口。它本应删除，但宿主测试仍断言 auto 模式得到这组 toolIds（宿主仍引用的项不在本仓单方面删除，
    // 删除随事项②走宿主配合的退役包）。删除前保持取值不变，只在命中时告警，让调用方看见这是一次无效授权。
    Logger.getInstance().warn(
      `[AgentProfileCompiler] signal_analysis_auto_tools_unregistered: profile "${definition.id}" mode=auto ` +
        `grants ${SIGNAL_ANALYSIS_AUTO_TOOL_IDS.join(', ')}, which are not registered tools; ` +
        'the grant is kept unchanged until the signal-analysis profile is retired.',
      {
        profileId: definition.id,
        mode: params.mode,
        grantedToolIds: [...SIGNAL_ANALYSIS_AUTO_TOOL_IDS],
      }
    );
    return { mode: 'listed' as const, toolIds: [...SIGNAL_ANALYSIS_AUTO_TOOL_IDS] };
  }
  return definition.defaults?.actionSpace || { mode: 'listed' as const, toolIds: [] };
}

/**
 * lifecycle 为 deprecated 的声明在编译时告警（L8-C11）。lifecycle 本身仍是描述性元数据：不阻止编译、
 * 不改运行行为，只让调用方在日志里看见自己在跑一个已废弃的 profile。每次编译告警一次。
 */
function warnDeprecatedLifecycle(definition: AgentProfileDefinition) {
  if (definition.lifecycle !== 'deprecated') {
    return;
  }
  Logger.getInstance().warn(
    `[AgentProfileCompiler] profile_lifecycle_deprecated: agent profile "${definition.id}" is declared ` +
      'lifecycle=deprecated; it still compiles and runs unchanged, migrate callers before it is removed.',
    { profileId: definition.id, lifecycle: definition.lifecycle, basePreset: definition.basePreset }
  );
}

function resolvePolicyDeclarations(
  definition: AgentProfileDefinition,
  params: Record<string, unknown>
) {
  if (definition.id === 'evolution-audit') {
    // 规模公式不在这里重复（L8-P03）：evolutionAuditPipeline 阶段工厂与本处都从
    // resolveEvolutionAuditScaleBudget 取值，BudgetPolicy 的 maxIterations 与 evolve 阶段一致，
    // timeoutMs 覆盖首轮加全部 gate 重试的阶段窗口。
    return evolutionAuditPolicyDeclarations(params);
  }
  return definition.defaults?.policies;
}

function resolveConcurrencyPlan(
  concurrency: AgentConcurrencyPlan | undefined,
  params: Record<string, unknown>
) {
  if (!concurrency) {
    return undefined;
  }
  const paramConcurrency = params.concurrency;
  if (
    typeof paramConcurrency !== 'number' ||
    !Number.isFinite(paramConcurrency) ||
    paramConcurrency <= 0
  ) {
    return concurrency;
  }
  return {
    ...concurrency,
    concurrency: Math.max(1, Math.floor(paramConcurrency)),
  };
}

function defaultParamsForProfile(profileId: string) {
  if (profileId === 'scan-summarize') {
    return { task: 'summarize' };
  }
  if (profileId === 'scan-extract') {
    return { task: 'extract' };
  }
  return {};
}

function mergeParams(...paramsList: Array<Record<string, unknown> | undefined>) {
  return Object.assign({}, ...paramsList.filter(Boolean));
}

function stripUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isCompiledProfile(value: unknown): value is CompiledAgentProfile {
  return isRecord(value) && value.kind === 'compiled-agent-profile';
}

function isStrategyTemplate(value: unknown): value is AgentStrategyTemplate {
  return isRecord(value) && typeof value.type === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/**
 * preset 名到描述性 serviceKind 的唯一映射；preset 引用路径与 override 路径共用（L8-C11）。
 * 结果只写进 CompiledAgentProfile 供观察，运行时不据此分支。
 */
function serviceKindForPreset(preset: string): CompiledAgentProfile['serviceKind'] {
  if (preset === 'chat') {
    return 'conversation';
  }
  if (preset === 'evolution') {
    return 'system-analysis';
  }
  return 'knowledge-production';
}

export default AgentProfileCompiler;

/** Legacy preset 参数只投影已声明预算字段；业务 params 不能暗中替换权限/策略。 */
function presetBudgetParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [
      'maxIterations',
      'maxTokens',
      'temperature',
      'timeoutMs',
      'minEvidenceLength',
      'minFileRefs',
      'minToolCalls',
    ]
      .filter((key) => params[key] !== undefined)
      .map((key) => [key, params[key]])
  );
}

/** Service 与直接 Builder 共享同一声明编译入口，不各自解释 policy。 */
export function createDefaultProfileCompiler(): AgentProfileCompiler {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry(),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}
