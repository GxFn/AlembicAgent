import { createLimit } from '../../shared/concurrency.js';
import type {
  AgentConcurrencyPlan,
  AgentProfileOverride,
  AgentProfileRef,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  CompiledAgentProfile,
} from '../service/AgentRunContracts.js';

type ChildRunner = (input: AgentRunInput) => Promise<AgentRunResult>;
type Partitioner = (input: AgentRunInput, profile: CompiledAgentProfile) => AgentRunInput[];
type Merger = (
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile
) => AgentRunResult;
type ChildRunRecord = { childInput: AgentRunInput; result: AgentRunResult };

export class AgentRunCoordinator {
  #partitioners = new Map<string, Partitioner>();
  #mergers = new Map<string, Merger>();

  constructor() {
    this.registerPartitioner('generateSessionDimensions', partitionBootstrapSessionDimensions);
    this.registerMerger('generateSessionResults', mergeBootstrapSessionResults);
    this.registerPartitioner('projectContextModules', partitionProjectIndexScopedModules);
    this.registerMerger('moduleMiningResults', mergeProjectIndexScopedModuleResults);
  }

  registerPartitioner(name: string, partitioner: Partitioner) {
    this.#partitioners.set(name, partitioner);
    return this;
  }

  registerMerger(name: string, merger: Merger) {
    this.#mergers.set(name, merger);
    return this;
  }

  canCoordinate(profile: CompiledAgentProfile) {
    return !!profile.concurrency && profile.concurrency.mode !== 'none';
  }

  async run(input: AgentRunInput, profile: CompiledAgentProfile, runChild: ChildRunner) {
    if (!profile.concurrency || profile.concurrency.mode === 'none') {
      return null;
    }
    const partitionerName = profile.concurrency.partitioner;
    if (!partitionerName) {
      throw new Error(`Agent profile "${profile.id}" concurrency plan requires partitioner`);
    }
    const partitioner = this.#partitioners.get(partitionerName);
    if (!partitioner) {
      throw new Error(`Unknown agent run partitioner: "${partitionerName}"`);
    }
    const mergeName = profile.concurrency.merge;
    const merger = mergeName ? this.#mergers.get(mergeName) : null;
    if (mergeName && !merger) {
      throw new Error(`Unknown agent run merger: "${mergeName}"`);
    }
    const childInputs = partitioner(input, profile);
    const childResults = await runChildren(
      childInputs,
      profile.concurrency,
      runChild,
      input,
      profile
    );

    return merger ? merger(childResults, input, profile) : defaultMerge(childResults, profile);
  }
}

async function runChildren(
  childInputs: AgentRunInput[],
  concurrencyPlan: AgentConcurrencyPlan,
  runChild: ChildRunner,
  parentInput: AgentRunInput,
  profile: CompiledAgentProfile
) {
  const limit = createLimit(resolveConcurrency(concurrencyPlan.concurrency));
  const records: ChildRunRecord[] = [];
  const failures: Array<{ hook: string; childId?: string; tierIndex?: number; message: string }> =
    [];
  let firstError: unknown;
  const fail = (
    hook: string,
    err: unknown,
    details: { childId?: string; tierIndex?: number } = {}
  ) => {
    if (failures.length === 0) {
      firstError = err;
    }
    failures.push({ hook, ...details, message: err instanceof Error ? err.message : String(err) });
  };
  const runOneChild = async (index: number, forceAbort = false): Promise<ChildRunRecord> => {
    const planned = childInputs[index];
    let childInput = planned;
    let result: AgentRunResult;
    let started = false;
    // 回调可能保存检查点，失败后不能重试它或继续派发尚未开始的子任务。
    if (forceAbort || failures.length > 0) {
      result = createChildAbortedResult(childInput);
    } else {
      try {
        if ((await shouldAbort(parentInput)) || failures.length > 0) {
          result = createChildAbortedResult(childInput);
        } else {
          childInput = await resolveLazyChildInput(planned, parentInput);
          const aborted = await shouldAbort(parentInput);
          // shouldAbort/懒构造均可挂起；恢复后必须重新读取停止事实，不能用 await 前的值。
          if (aborted || failures.length > 0) {
            result = createChildAbortedResult(childInput);
          } else {
            started = true;
            result = await runChild(childInput);
          }
        }
      } catch (err: unknown) {
        result = createChildErrorResult(childInput, err);
      }
    }
    const record = { childInput, result };
    records[index] = record;
    if (failures.length === 0 || started) {
      try {
        await parentInput.context.coordination?.onChildResult?.({ childInput, result, profile });
      } catch (err: unknown) {
        fail('onChildResult', err, { childId: resolveDimensionId(childInput) || undefined });
      }
    }
    return record;
  };
  const tiers =
    concurrencyPlan.mode === 'tiered'
      ? groupByTier(childInputs)
      : [childInputs.map((_, index) => index)];
  for (const [tierIndex, tier] of tiers.entries()) {
    if (concurrencyPlan.mode === 'tiered') {
      let cancelled = failures.length > 0;
      if (!cancelled) {
        try {
          cancelled = await shouldAbort(parentInput);
        } catch (err: unknown) {
          fail('shouldAbort', err, { tierIndex });
          cancelled = true;
        }
      }
      if (cancelled) {
        await Promise.all(
          tiers
            .slice(tierIndex)
            .flat()
            .map((index) => runOneChild(index, true))
        );
        break;
      }
    }
    // 单个 callback 的拒绝不会让 Promise.all 早退；已开始的 child 仍需结算真实回执。
    const runs = await Promise.all(tier.map((child) => limit(() => runOneChild(child))));
    if (concurrencyPlan.mode === 'tiered' && failures.length === 0) {
      try {
        await parentInput.context.coordination?.onTierComplete?.({
          tierIndex,
          childInputs: runs.map((run) => run.childInput),
          results: runs.map((run) => run.result),
          profile,
        });
      } catch (err: unknown) {
        fail('onTierComplete', err, { tierIndex });
      }
    }
  }
  const results = childInputs.map((_, index) => {
    const record = records[index];
    if (!record) {
      throw new Error('Coordinated child result is missing');
    }
    return record.result;
  });
  if (failures.length > 0) {
    // 保持父 run 抛错（宿主据此停止 finalize）；附带原始 child 状态供恢复/读回，不能冒充成功。
    const partialResult = { ...defaultMerge(results, profile), status: 'error' as const };
    throw Object.assign(
      new Error(`Agent coordination consumption failed: ${failures[0].message}`, {
        cause: firstError,
      }),
      {
        partialResult,
        coordinationFailures: failures,
      }
    );
  }
  return results;
}

async function shouldAbort(input: AgentRunInput) {
  if (input.execution?.abortSignal?.aborted) {
    return true;
  }
  const requested = await input.execution?.shouldAbort?.();
  return input.execution?.abortSignal?.aborted === true || requested === true;
}

function createChildErrorResult(input: AgentRunInput, err: unknown): AgentRunResult {
  const message = err instanceof Error ? err.message : String(err);
  const dimId = resolveDimensionId(input);
  return {
    runId: `${dimId || 'child'}:error`,
    profileId: profileIdForResult(input),
    reply: message,
    status: 'error',
    phases: {
      error: message,
      ...(dimId ? { dimId } : {}),
    },
    toolCalls: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      iterations: 0,
      durationMs: 0,
    },
    diagnostics: null,
  };
}

function createChildAbortedResult(input: AgentRunInput): AgentRunResult {
  const dimId = resolveDimensionId(input);
  return {
    runId: `${dimId || 'child'}:aborted`,
    profileId: profileIdForResult(input),
    reply: 'child-run-aborted',
    status: 'aborted',
    phases: {
      aborted: true,
      ...(dimId ? { dimId } : {}),
    },
    toolCalls: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      iterations: 0,
      durationMs: 0,
    },
    diagnostics: null,
  };
}

function profileIdForResult(input: AgentRunInput) {
  if (input.profile.id) {
    return input.profile.id;
  }
  if ('preset' in input.profile && input.profile.preset) {
    return input.profile.preset;
  }
  if ('basePreset' in input.profile && input.profile.basePreset) {
    return input.profile.basePreset;
  }
  return 'unknown';
}

async function resolveLazyChildInput(plannedInput: AgentRunInput, parentInput: AgentRunInput) {
  const dimId = resolveDimensionId(plannedInput);
  const factory = dimId ? parentInput.context.childInputFactories?.[dimId] : undefined;
  if (!factory) {
    return plannedInput;
  }
  return factory({ plannedInput, parentInput });
}

function resolveConcurrency(concurrency: AgentConcurrencyPlan['concurrency']) {
  if (typeof concurrency === 'number') {
    return concurrency;
  }
  if (concurrency?.env) {
    const parsed = Number.parseInt(process.env[concurrency.env] || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : concurrency.default;
  }
  return 1;
}

function groupByTier(childInputs: AgentRunInput[]) {
  const groups = new Map<number, number[]>();
  for (const [index, child] of childInputs.entries()) {
    const tier = resolveTier(child);
    groups.set(tier, [...(groups.get(tier) || []), index]);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([, inputs]) => inputs);
}

function resolveTier(input: AgentRunInput) {
  const paramTier = input.params?.tier;
  if (typeof paramTier === 'number' && Number.isFinite(paramTier)) {
    return paramTier;
  }
  const metadataTier = input.message.metadata?.tier;
  if (typeof metadataTier === 'number' && Number.isFinite(metadataTier)) {
    return metadataTier;
  }
  return 0;
}

function resolveDimensionId(input: AgentRunInput) {
  const paramDimId = input.params?.dimId;
  if (typeof paramDimId === 'string' && paramDimId.trim()) {
    return paramDimId;
  }
  const metadataDimension = input.message.metadata?.dimension;
  if (typeof metadataDimension === 'string' && metadataDimension.trim()) {
    return metadataDimension;
  }
  return undefined;
}

function defaultMerge(results: AgentRunResult[], profile: CompiledAgentProfile): AgentRunResult {
  const status =
    (['error', 'aborted', 'timeout', 'blocked'] as const).find((candidate) =>
      results.some((result) => result.status === candidate)
    ) ?? 'success';
  return {
    runId: `${profile.id}:parent`,
    profileId: profile.id,
    reply: results
      .map((result) => result.reply)
      .filter(Boolean)
      .join('\n\n'),
    status,
    phases: { childResults: results },
    toolCalls: results.flatMap((result) => result.toolCalls),
    usage: {
      inputTokens: results.reduce((sum, result) => sum + result.usage.inputTokens, 0),
      outputTokens: results.reduce((sum, result) => sum + result.usage.outputTokens, 0),
      iterations: results.reduce((sum, result) => sum + result.usage.iterations, 0),
      durationMs: results.reduce((sum, result) => sum + result.usage.durationMs, 0),
    },
    diagnostics: null,
  };
}

function partitionBootstrapSessionDimensions(
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunInput[] {
  const dimensions = Array.isArray(input.params?.dimensions) ? input.params.dimensions : [];
  const baseParams = omitKeys(input.params || {}, ['dimensions', 'children']);
  const childProfileId = profile.concurrency?.childProfile || 'generate-dimension';
  return dimensions.map((rawDimension, index) => {
    const dimension = toRecord(rawDimension);
    const dimId = stringValue(dimension.dimId) || stringValue(dimension.id) || `dimension-${index}`;
    const label = stringValue(dimension.label) || dimId;
    const childContext = input.context.childContexts?.[dimId] || {};
    const childMessage = toRecord(dimension.message);
    const childMetadata = toRecord(dimension.metadata);
    const childParams = toRecord(dimension.params);
    const tier = numberValue(dimension.tier);
    const profileRef = toProfileRef(dimension.profile) || { id: childProfileId };
    const promptContext = {
      ...(input.context.promptContext || {}),
      ...(childContext.promptContext || {}),
      ...toRecord(dimension.promptContext),
      dimId,
      dimensionId: dimId,
    };
    return {
      profile: profileRef,
      params: stripUndefined({
        ...baseParams,
        ...childParams,
        dimId,
        ...(tier !== undefined ? { tier } : {}),
      }),
      message: {
        role: (childMessage.role as AgentRunInput['message']['role']) || 'internal',
        content:
          stringValue(childMessage.content) ||
          stringValue(dimension.prompt) ||
          `Bootstrap dimension: ${label}`,
        history: Array.isArray(childMessage.history) ? childMessage.history : input.message.history,
        metadata: stripUndefined({
          ...(input.message.metadata || {}),
          ...childMetadata,
          ...(tier !== undefined ? { tier } : {}),
          dimension: dimId,
          phase: 'bootstrap-session-child',
        }),
        sessionId: stringValue(childMessage.sessionId) || input.message.sessionId,
      },
      context: stripUndefined({
        ...input.context,
        ...childContext,
        childContexts: undefined,
        childInputFactories: undefined,
        promptContext,
      }) as unknown as AgentRunContext,
      execution: input.execution,
      presentation: input.presentation,
    };
  });
}

function partitionProjectIndexScopedModules(
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunInput[] {
  const modules = Array.isArray(input.params?.modules) ? input.params.modules : [];
  if (modules.length === 0) {
    throw new Error('moduleMining fan-out requires non-empty params.modules');
  }
  const baseParams = omitKeys(input.params || {}, [
    'modules',
    'dimensions',
    'children',
    'moduleSeeds',
  ]);
  const basePromptContext = omitKeys(input.context.promptContext || {}, [
    'dimensions',
    'dimensionId',
    'dimId',
  ]);
  const baseMetadata = omitKeys(input.message.metadata || {}, [
    'dimension',
    'dimensionId',
    'dimId',
  ]);
  const childProfileId = profile.concurrency?.childProfile || 'module-mining-dimension';
  return modules.map((rawModule, index) => {
    const moduleRecord = toRecord(rawModule);
    const moduleId =
      stringValue(moduleRecord.moduleId) ||
      stringValue(moduleRecord.id) ||
      stringValue(moduleRecord.modulePath) ||
      stringValue(moduleRecord.path) ||
      `module-${index}`;
    const moduleName =
      stringValue(moduleRecord.moduleName) ||
      stringValue(moduleRecord.name) ||
      stringValue(moduleRecord.label) ||
      moduleId;
    const modulePath = stringValue(moduleRecord.modulePath) || stringValue(moduleRecord.path);
    const ownedFiles =
      stringArrayValue(moduleRecord.ownedFiles) ||
      stringArrayValue(moduleRecord.files) ||
      stringArrayValue(moduleRecord.paths) ||
      [];
    const childContext = input.context.childContexts?.[moduleId] || {};
    const childMessage = toRecord(moduleRecord.message);
    const childMetadata = toRecord(moduleRecord.metadata);
    const childParams = toRecord(moduleRecord.params);
    const tier = numberValue(moduleRecord.tier);
    const profileRef = toProfileRef(moduleRecord.profile) || { id: childProfileId };
    const projectInfo = buildProjectIndexModuleInfo(input.params?.projectFacts, ownedFiles);
    const dimConfig = buildScopedIndexModuleDimConfig(moduleRecord, {
      moduleId,
      moduleName,
      modulePath,
      ownedFiles,
    });
    const strategyContext = stripUndefined({
      ...toRecord(input.context.strategyContext),
      ...toRecord(childContext.strategyContext),
      ...toRecord(moduleRecord.strategyContext),
      projectFacts: input.params?.projectFacts,
      projectInfo,
      dimConfig,
      moduleContext: stripUndefined({
        moduleId,
        moduleName,
        modulePath,
        ownedFiles,
        module: moduleRecord,
      }),
    });
    const promptContext = {
      ...basePromptContext,
      ...(childContext.promptContext || {}),
      ...toRecord(moduleRecord.promptContext),
      moduleId,
      moduleName,
      ...(modulePath ? { modulePath } : {}),
      ownedFiles,
      projectInfo,
      dimConfig,
    };
    return {
      profile: profileRef,
      params: stripUndefined({
        ...baseParams,
        ...childParams,
        moduleId,
        moduleName,
        modulePath,
        ownedFiles,
        ...(tier !== undefined ? { tier } : {}),
      }),
      message: {
        role: (childMessage.role as AgentRunInput['message']['role']) || 'internal',
        content:
          stringValue(childMessage.content) ||
          stringValue(moduleRecord.prompt) ||
          `Module mining: ${moduleName}`,
        history: Array.isArray(childMessage.history) ? childMessage.history : input.message.history,
        metadata: stripUndefined({
          ...baseMetadata,
          ...childMetadata,
          ...(tier !== undefined ? { tier } : {}),
          moduleId,
          moduleName,
          phase: 'module-mining-child',
        }),
        sessionId: stringValue(childMessage.sessionId) || input.message.sessionId,
      },
      context: stripUndefined({
        ...input.context,
        ...childContext,
        childContexts: undefined,
        childInputFactories: undefined,
        promptContext,
        strategyContext,
      }) as unknown as AgentRunContext,
      execution: input.execution,
      presentation: input.presentation,
    };
  });
}

/**
 * P0-4(挖掘质量升级)：从 child 结果里收集被质量门放弃(degrade)的单元。
 * 读取面是 PipelineStrategy 投影的 phases._pipelineOutcome(outcome==='abandoned')——
 * 此前弱维度 degrade 后静默产 0 候选、只留日志；聚合成一等字段后，父 run 的消费方
 * (module-mining 回填、评估 harness 的 abandonment rate)能直接看到"哪个单元、哪个门、
 * 什么原因被放弃"。error/aborted 不在此列(它们已由 child status 表达)。
 */
function collectAbandonedUnits(
  results: AgentRunResult[],
  unitIds: string[]
): Array<{ unitId: string; stage: string; action: string; reason: string }> {
  const abandoned: Array<{ unitId: string; stage: string; action: string; reason: string }> = [];
  results.forEach((result, index) => {
    const outcome = toRecord(toRecord(result.phases)._pipelineOutcome);
    if (stringValue(outcome.outcome) !== 'abandoned') {
      return;
    }
    abandoned.push({
      unitId: unitIds[index] || `unit-${index}`,
      stage: stringValue(outcome.stage) || 'unknown',
      action: stringValue(outcome.action) || 'degrade',
      reason: stringValue(outcome.reason) || '',
    });
  });
  return abandoned;
}

function mergeBootstrapSessionResults(
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunResult {
  const dimensions = Array.isArray(input.params?.dimensions) ? input.params.dimensions : [];
  const dimensionIds = dimensions.map((dimension, index) => {
    const record = toRecord(dimension);
    return stringValue(record.dimId) || stringValue(record.id) || `dimension-${index}`;
  });
  const abandonedDimensions = collectAbandonedUnits(results, dimensionIds);
  return {
    ...defaultMerge(results, profile),
    phases: {
      childResults: results,
      dimensionResults: Object.fromEntries(
        results.map((result, index) => [dimensionIds[index] || `dimension-${index}`, result])
      ),
      ...(abandonedDimensions.length > 0 ? { abandonedDimensions } : {}),
    },
  };
}

function mergeProjectIndexScopedModuleResults(
  results: AgentRunResult[],
  input: AgentRunInput,
  profile: CompiledAgentProfile
): AgentRunResult {
  const modules = Array.isArray(input.params?.modules) ? input.params.modules : [];
  const moduleIds = modules.map((moduleInput, index) => {
    const moduleRecord = toRecord(moduleInput);
    return (
      stringValue(moduleRecord.moduleId) ||
      stringValue(moduleRecord.id) ||
      stringValue(moduleRecord.modulePath) ||
      stringValue(moduleRecord.path) ||
      `module-${index}`
    );
  });
  const abandonedModules = collectAbandonedUnits(results, moduleIds);
  return {
    ...defaultMerge(results, profile),
    phases: {
      childResults: results,
      moduleResults: Object.fromEntries(
        results.map((result, index) => [moduleIds[index] || `module-${index}`, result])
      ),
      ...(abandonedModules.length > 0 ? { abandonedModules } : {}),
    },
  };
}

function buildProjectIndexModuleInfo(projectFacts: unknown, ownedFiles: string[]) {
  const facts = toRecord(projectFacts);
  const explicitProjectInfo = toRecord(facts.projectInfo);
  const name =
    stringValue(explicitProjectInfo.name) ||
    stringValue(facts.project) ||
    stringValue(facts.name) ||
    stringValue(facts.projectName) ||
    'ProjectContext';
  const lang =
    stringValue(explicitProjectInfo.lang) ||
    stringValue(explicitProjectInfo.language) ||
    stringValue(facts.lang) ||
    stringValue(facts.language) ||
    'unknown';
  const fileCount =
    numberValue(explicitProjectInfo.fileCount) ?? numberValue(facts.fileCount) ?? ownedFiles.length;

  return {
    ...explicitProjectInfo,
    name,
    lang,
    fileCount,
  };
}

function buildScopedIndexModuleDimConfig(
  moduleRecord: Record<string, unknown>,
  {
    moduleId,
    moduleName,
    modulePath,
    ownedFiles,
  }: {
    moduleId: string;
    moduleName: string;
    modulePath?: string;
    ownedFiles: string[];
  }
) {
  const dimensions =
    stringArrayValue(moduleRecord.dimensions) || stringArrayValue(moduleRecord.dimensionIds) || [];
  const id =
    stringValue(moduleRecord.dimensionId) ||
    stringValue(moduleRecord.dimId) ||
    dimensions[0] ||
    `module:${moduleId}`;
  const focusKeywords = [moduleName, modulePath, ...dimensions, ...ownedFiles.slice(0, 8)].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  const guideParts = [
    `只分析 ProjectContext module "${moduleName}"。`,
    `moduleId: ${moduleId}`,
    modulePath ? `modulePath: ${modulePath}` : '',
    ownedFiles.length > 0 ? `ownedFiles:\n${ownedFiles.map((file) => `- ${file}`).join('\n')}` : '',
    // P1-B-1：run 入口静态装配的模块图谱(ModuleContextAssembler)——Analyst 首轮即见
    // 目录骨架/兄弟模块/可选依赖,graph 调用退为精化手段(不再是骨架的唯一来源)。
    stringValue(moduleRecord.contextMap) || '',
  ].filter(Boolean);

  return stripUndefined({
    id,
    label: `模块 ${moduleName}`,
    guide: guideParts.join('\n'),
    focusKeywords,
    outputType: stringValue(moduleRecord.outputType) || 'dual',
    allowedKnowledgeTypes: stringArrayValue(moduleRecord.allowedKnowledgeTypes) || [
      'rule',
      'pattern',
      'fact',
    ],
  });
}

function toProfileRef(value: unknown): AgentProfileRef | AgentProfileOverride | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id === 'string' ||
    typeof value.preset === 'string' ||
    typeof value.basePreset === 'string'
  ) {
    return value as AgentProfileRef | AgentProfileOverride;
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
}

function omitKeys(input: Record<string, unknown>, keys: string[]) {
  const skipped = new Set(keys);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !skipped.has(key)));
}

function stripUndefined<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export default AgentRunCoordinator;
