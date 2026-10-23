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
   * 解析 { id?, preset?, params? } 引用（L8-C02 / W2a-06 L8-P01）：
   *   - 显式 id 命中注册表：编译该声明，preset 字段不参与；
   *   - 显式 id 未注册：一律 fail-fast 抛 Unknown agent profile。拼错的 id（如 generate-dimesion）不会
   *     拖到 runtime build 才报错，{ 未知 id, preset } 也不会被静默换成裸 preset；内置 preset 名写成 id
   *     （如 { id: 'chat' }）同样抛错——旧的“按 preset 编译并记 warn”兼容回落已删除，调用方改用 { preset }；
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
    // 父 profile 自身不需要运行时策略，所以这里置空。fanout 模板只是标记，计划是否可执行、是否声明了
    // childProfile / partitioner / merge 已在 assertFanoutConcurrencyPlan 中校验，走到这里一定能进入协调分支。
    return undefined;
  }
  return strategy as Record<string, unknown>;
}

/** fanout 的 concurrency 计划必须声明的字段；协调器只读计划侧（fanout 模板只作标记，W2a-06 / L8-P17）。 */
const FANOUT_PLAN_FIELDS = ['childProfile', 'partitioner', 'merge'] as const;

/**
 * fanout 声明的编译期校验（L8-C02 / W2a-06 L8-P17）。fanout 模板只是标记 { type: 'fanout' }，编译成
 * undefined；真正的扇出只由 concurrency 计划驱动，所以计划本身必须完整：
 *   - 缺 concurrency 或 mode 为 none 时，AgentService 不进协调分支，父 profile 会静默按 basePreset
 *     的默认完整管线执行（没有维度上下文、没有日志），所以必须在编译期抛错；
 *   - 计划缺 childProfile / partitioner / merge（或为空串）时，协调器会静默回退到内置 child 或默认
 *     merge，同样在编译期抛错，消息带 profile id 与字段名，不能退化为静默回退。
 * 模板上已退役的 childProfile / partitioner / merge 不再有读取者：JS 调用方按旧形状写入时不抛错，
 * 但记一条 warn 写明被忽略的字段与取值，扇出照常只按计划执行（见 warnIgnoredFanoutTemplateFields）。
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
  for (const field of FANOUT_PLAN_FIELDS) {
    const value: unknown = plan[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `Agent profile "${definition.id}" fanout concurrency plan must declare ${field}; ` +
          `got ${JSON.stringify(value ?? null)}`
      );
    }
  }
  warnIgnoredFanoutTemplateFields(definition, strategy as Record<string, unknown>);
}

/**
 * 旧形状的 fanout 模板（模板上仍带 childProfile / partitioner / merge）的诊断。这些字段已从公开类型删除，
 * 协调器从不读取它们；这里不抛错（模板与计划一致的旧调用方仍可编译），但每次编译记一条 warn，
 * 写明被忽略的字段、模板取值与计划取值，避免模板与计划不一致时被静默吞掉。
 */
function warnIgnoredFanoutTemplateFields(
  definition: AgentProfileDefinition,
  template: Record<string, unknown>
) {
  const ignored = Object.keys(template).filter((key) => key !== 'type');
  if (ignored.length === 0) {
    return;
  }
  const plan = (definition.concurrency ?? {}) as Record<string, unknown>;
  Logger.getInstance().warn(
    `[AgentProfileCompiler] fanout_template_fields_ignored: agent profile "${definition.id}" fanout template ` +
      `declares ${ignored.join(', ')}; fanout templates are markers only and the concurrency plan is authoritative.`,
    {
      profileId: definition.id,
      ignoredFields: ignored,
      templateValues: Object.fromEntries(ignored.map((key) => [key, template[key]])),
      planValues: Object.fromEntries(
        FANOUT_PLAN_FIELDS.filter((key) => ignored.includes(key)).map((key) => [key, plan[key]])
      ),
    }
  );
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

/**
 * 已删除的策略层运行级总量上限字段名（W2a-07 / L5-P08）。它不再是 BudgetPolicyConfig 的成员，只在这里
 * 以字符串读取声明对象，用于编译期告警；类型与 BudgetPolicy 中都不再有同名成员。
 */
const REMOVED_POLICY_SESSION_TOTAL_FIELD = 'maxSessionTokens';

/**
 * 声明式 budget 策略带会话字段时编译期告警（I03；W2a-07 / L5-P08 按②答复收窄后的口径）。
 *   - maxSessionTokens：已删除。BudgetPolicy 不再读取它（构造器只解构已声明字段），声明了也不会按运行累计
 *     总量停止运行；告警写明“已删除、被忽略”，让仍带旧字段的声明看见这一行为变化。
 *   - maxSessionInputTokens：保留（它与屏蔽包装是阶段预算之外唯一的策略层会话配置）。告警只说明口径差异：
 *     它按整次运行累计判定，而 BudgetController 执行的阶段会话预算按阶段内消耗；阶段预算未声明
 *     maxSessionInputTokens 的循环里，其拒绝被屏蔽（运行时写 policy_session_limit_bypassed 诊断）。
 * 每个 budget 声明最多告警一次（两个字段合并为一条），不抛错、不改写配置。日志码沿用
 * policy_session_fields_deprecated，便于既有日志检索继续命中。
 */
function warnPolicySessionFields(config: Record<string, unknown>) {
  const notes: string[] = [];
  const removedTotal = config[REMOVED_POLICY_SESSION_TOTAL_FIELD];
  if (removedTotal !== undefined) {
    notes.push(
      `${REMOVED_POLICY_SESSION_TOTAL_FIELD}=${String(removedTotal)} has been removed and is ignored: ` +
        'BudgetPolicy no longer stops the run on cumulative total tokens; declare a stage budget ' +
        'maxSessionInputTokens (executed in-stage by BudgetController) instead'
    );
  }
  if (config.maxSessionInputTokens !== undefined) {
    notes.push(
      `maxSessionInputTokens=${String(config.maxSessionInputTokens)} is checked against run-level ` +
        'cumulative input usage, while stage session budgets executed by BudgetController use in-stage ' +
        'consumption; its rejections are bypassed in loops whose stage budget declares no ' +
        'maxSessionInputTokens (diagnostic policy_session_limit_bypassed)'
    );
  }
  if (notes.length === 0) {
    return;
  }
  Logger.getInstance().warn(
    `[AgentProfileCompiler] policy_session_fields_deprecated: budget policy declares session fields. ${notes.join('; ')}.`
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
