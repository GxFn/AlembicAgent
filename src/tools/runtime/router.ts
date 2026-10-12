/**
 * @module tools/runtime/router
 *
 * ToolRouter — 工具调用的统一入口。
 *
 * 流程: 参数解析 → Schema 校验 → Capability 权限检查 → 并发控制 → Handler 分发 → 输出截断
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type {
  ToolAvailabilityContext,
  ToolAvailabilitySnapshot,
} from '#tools/kernel/availability.js';
import type { ToolDecision } from '#tools/kernel/decision.js';
import type {
  CapabilityDef,
  ParsedToolCall,
  ToolAction,
  ToolContext,
  ToolDiagnosticWarning,
  ToolResult,
  ToolSpec,
} from '#tools/kernel/registry.js';
import { estimateTokens, fail } from '#tools/kernel/registry.js';
import type { ToolActionAllowlist } from '#tools/kernel/toolSchema.js';
import {
  describeToolParameterDenial,
  findDeniedToolParameter,
  intersectToolActions,
  isToolActionAllowed,
  snapshotToolActionAllowlist,
} from '#tools/kernel/toolSelection.js';
import { toolAdmissionFailure } from './admission.js';
import { describeToolAvailability } from './availability.js';
import { type ToolParameterSchemaFailureSink, validateToolParameters } from './parameters.js';
import { generateLightweightSchemas, TOOL_REGISTRY } from './registry.js';
import { createToolRegistryView, readToolAvailability } from './selection.js';

export interface RouterConfig {
  capability?: CapabilityDef;
}

type ConcurrencyMode = NonNullable<ToolAction['concurrency']>;
interface ScheduledCall {
  tool: string;
  mode: ConcurrencyMode;
  signal?: AbortSignal;
  resolve: (release: (() => void) | null) => void;
  onAbort: () => void;
}

export class ToolRouter {
  readonly #config: RouterConfig;
  readonly #waiting: ScheduledCall[] = [];
  readonly #activeTools = new Map<string, number>();
  readonly #singleTools = new Set<string>();
  #activeCount = 0;
  #exclusive = false;

  constructor(config: RouterConfig = {}) {
    this.#config = config;
  }

  static describeAvailability(context: ToolAvailabilityContext): ToolAvailabilitySnapshot {
    return describeToolAvailability(context);
  }

  /** execute 共用的静态准入；发现不代替宿主权限/业务校验，不调用任何 handler。 */
  explain(
    call: ParsedToolCall,
    ctx: Pick<ToolContext, 'runtime' | 'toolAvailability'> = {}
  ): ToolDecision {
    const spec = this.getToolSpec(call.tool);
    if (!spec || !Object.hasOwn(spec.actions, call.action)) {
      return {
        allowed: false,
        stage: 'discover',
        reason: `Unknown tool action: ${call.tool}.${call.action}`,
      };
    }
    const paramRejection = validateToolParameters(
      call,
      spec.actions[call.action],
      ctx.runtime,
      reportParameterSchemaFailure
    );
    if (paramRejection) {
      // schema 编译失败是注册表/宿主缺陷而非模型参数错误：按“工具不可用”拒绝（execute/blocked →
      // TOOL_UNAVAILABLE），避免模型把它当成自己的参数问题反复改参重试；参数不符才是 discover。
      return paramRejection.source === 'schema'
        ? {
            allowed: false,
            stage: 'execute',
            resultStatus: 'blocked',
            reason: paramRejection.reason,
          }
        : { allowed: false, stage: 'discover', reason: paramRejection.reason };
    }
    const capability = this.#config.capability;
    const capabilityActions = capability
      ? snapshotToolActionAllowlist(capability.allowedTools, 'own')
      : undefined;
    if (
      capability &&
      (!capabilityActions || !isToolActionAllowed(capabilityActions, call.tool, call.action))
    ) {
      return {
        allowed: false,
        stage: 'approve',
        resultStatus: 'blocked',
        reason: capabilityActions
          ? `Permission denied: Action "${call.tool}.${call.action}" not allowed in capability "${capability.name}"`
          : 'Permission denied: invalid capability action allowlist',
      };
    }
    // action 通过后再按能力名查内部参数 allowlist（L4-P29）：例如 evolution_analysis 的
    // knowledge.manage 只开放 evolve/deprecate/skip_evolution。拒绝仍是 approve 阶段的 blocked，
    // 原因带 capability/operation/id，经 toolAdmissionFailure 落到 tool_preflight_rejected 诊断。
    // 宿主构造 Adapter 时通常不传 capability，这条检查只覆盖带能力的路由；生产路径由
    // agent 层 runtimeSafetyGate 按 loopCtx.capabilities 执行同一张表。
    if (capability) {
      const denial = findDeniedToolParameter(
        capability.name,
        call.tool,
        call.action,
        call.params,
        spec.actions[call.action].params.properties as
          | Record<string, { default?: unknown }>
          | undefined
      );
      if (denial) {
        return {
          allowed: false,
          stage: 'approve',
          resultStatus: 'blocked',
          reason: describeToolParameterDenial(denial, call.params),
        };
      }
    }
    const stageActions = ctx.runtime?.allowedTools;
    const stageSnapshot =
      stageActions === undefined ? undefined : snapshotToolActionAllowlist(stageActions, 'own');
    if (
      stageActions !== undefined &&
      (!stageSnapshot || !isToolActionAllowed(stageSnapshot, call.tool, call.action))
    ) {
      return {
        allowed: false,
        stage: 'approve',
        resultStatus: 'blocked',
        reason: stageSnapshot
          ? `Permission denied: Action "${call.tool}.${call.action}" not allowed in the current stage`
          : 'Permission denied: invalid stage action allowlist',
      };
    }
    const availability = readToolAvailability(ctx.toolAvailability);
    if (typeof availability === 'string') {
      return {
        allowed: false,
        stage: 'execute',
        resultStatus: 'blocked',
        reason: availability,
      };
    }
    if (
      availability &&
      Object.hasOwn(availability.actions, call.tool) &&
      !isToolActionAllowed(availability.actions, call.tool, call.action)
    ) {
      const unavailable = availability.unavailable?.find(
        (entry) =>
          entry.tool === call.tool &&
          (entry.action === undefined || entry.action === call.action) &&
          entry.operation === undefined
      );
      return {
        allowed: false,
        stage: 'execute',
        resultStatus: 'blocked',
        reason: `Tool unavailable: ${call.tool}.${call.action}${unavailable ? ` — ${unavailable.reason}` : ''}`,
      };
    }
    const constraints = availability?.parameters?.[call.tool]?.[call.action];
    for (const [parameter, values] of Object.entries(constraints ?? {})) {
      const properties = spec.actions[call.action].params.properties as
        | Record<string, { default?: unknown }>
        | undefined;
      const value =
        call.params[parameter] === undefined
          ? properties?.[parameter]?.default
          : call.params[parameter];
      // 缺省分支也按同一 action schema 的真实默认值检查，不能省略参数绕过宿主约束。
      if (values.length === 0 || (value !== undefined && !values.includes(String(value)))) {
        return {
          allowed: false,
          stage: 'execute',
          resultStatus: 'blocked',
          reason: `Tool unavailable: ${call.tool}.${call.action} ${parameter}=${String(value)}. Available: ${values.join(', ')}`,
        };
      }
    }
    return { allowed: true, stage: 'execute' };
  }

  #selection(ctx: Pick<ToolContext, 'runtime'>): ToolActionAllowlist | undefined {
    const capability = this.#config.capability;
    const stage = ctx.runtime?.allowedTools;
    const configured = capability
      ? snapshotToolActionAllowlist(capability.allowedTools, 'own')
      : undefined;
    const currentStage =
      stage === undefined ? undefined : snapshotToolActionAllowlist(stage, 'own');
    // 完整授权合同不采用 selection 顶层 null 的“不限制”语义；后续只消费已验证值。
    if (configured === null || currentStage === null) {
      throw new Error('Invalid tool action allowlist');
    }
    return configured && currentStage
      ? intersectToolActions(configured, currentStage)
      : (currentStage ?? configured);
  }

  /**
   * 执行工具调用。
   *
   * 完整流程: 参数校验 → Capability 检查 → 并发控制 → handler → 输出截断
   */
  async execute(
    call: ParsedToolCall,
    ctx: ToolContext,
    options: {
      getAvailability?: () => ToolAvailabilitySnapshot;
    } = {}
  ): Promise<ToolResult> {
    const startMs = Date.now();
    // 记录异常发生在哪一段，catch 据此区分 handler 崩溃、宿主可用性回调失败与路由自身失败。
    let phase: RouterFailurePhase = 'router';

    try {
      if (ctx.abortSignal?.aborted) {
        return fail('Tool execution aborted before scheduling');
      }
      // 调用声明属于本次执行：等待 slot 时外部不能改目标或嵌套参数，让已选 handler
      // 借另一个 action 的权限执行。ctx/capability 保持 live，排队撤权仍在下方重检。
      call = { tool: call.tool, action: call.action, params: structuredClone(call.params) };
      const spec = this.getToolSpec(call.tool);
      const action =
        spec && Object.hasOwn(spec.actions, call.action) ? spec.actions[call.action] : undefined;
      if (!spec || !action) {
        return fail(
          `Invalid call: ${call.tool}.${call.action} — use parseToolCall() first to validate`
        );
      }

      const decision = this.explain(call, ctx);
      if (!decision.allowed) {
        return toolAdmissionFailure(call, decision);
      }

      const mode = action.concurrency ?? 'parallel';
      const release = await this.#schedule(call.tool, mode, ctx.abortSignal);
      if (!release) {
        return fail('Tool execution aborted while waiting');
      }

      try {
        if (ctx.abortSignal?.aborted) {
          return fail('Tool execution aborted before handler');
        }
        // single/exclusive排队后重读宿主事实；入队时可用不代表获得slot时仍可用。
        phase = 'availability';
        const currentCtx = options.getAvailability
          ? { ...ctx, toolAvailability: options.getAvailability() }
          : ctx;
        phase = 'router';
        const currentDecision = this.explain(call, currentCtx);
        if (!currentDecision.allowed) {
          return toolAdmissionFailure(call, currentDecision);
        }
        const handlerCtx: ToolContext = {
          ...currentCtx,
          toolRegistry: createToolRegistryView(
            TOOL_REGISTRY,
            this.#selection(currentCtx),
            currentCtx.toolAvailability
          ),
          ...(this.#config.capability
            ? { commandAllowlist: this.#config.capability.commandAllowlist }
            : {}),
        };
        // 宿主可用性/上下文回调可能同步取消；最终副作用入口必须重新检查。
        if (ctx.abortSignal?.aborted) {
          return fail('Tool execution aborted before handler');
        }
        phase = 'handler';
        const result = await action.handler(call.params, handlerCtx);
        phase = 'router';

        // 先截断再记耗时：截断可能为没有 _meta 的 handler 结果补建元信息，耗时要落在同一份元信息上。
        if (action.maxOutputTokens && result.ok) {
          enforceOutputLimit(result, action.maxOutputTokens, call);
        }

        if (result._meta) {
          result._meta.durationMs = Date.now() - startMs;
        }

        return result;
      } finally {
        release();
      }
    } catch (err: unknown) {
      return routerExecutionFailure(call, phase, err, Date.now() - startMs);
    }
  }

  /**
   * 并行执行多个工具调用，按均分策略分配 token budget。
   */
  async executeParallel(calls: ParsedToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    if (calls.length === 0) {
      return [];
    }
    const perCallBudget = Math.floor(ctx.tokenBudget / calls.length);
    return Promise.all(
      calls.map((call) => {
        const callCtx = { ...ctx, tokenBudget: Math.max(perCallBudget, 1000) };
        return this.execute(call, callCtx);
      })
    );
  }

  /**
   * 从 LLM 的原始 function call 参数解析 ParsedToolCall。
   *
   * LLM 返回: { name: "code", arguments: '{"action":"search","params":{...}}' }
   * 解析为:  { tool: "code", action: "search", params: {...} }
   *
   * 验证层级: 解析 → action 存在性检查 → 返回强类型 ParsedToolCall
   */
  parseToolCall(
    name: string,
    rawArguments: string | Record<string, unknown>
  ): ParsedToolCall | { error: string } {
    try {
      const args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
      if (!isParamObject(args)) {
        return { error: 'Tool arguments must be an object' };
      }
      const action = args.action;
      const params = (args.params ?? {}) as Record<string, unknown>;

      if (typeof action !== 'string' || !action) {
        return { error: `Missing "action" in tool call for ${name}` };
      }

      const spec = this.getToolSpec(name);
      if (!spec) {
        return {
          error: `Unknown tool: ${name}. Available: ${Object.keys(TOOL_REGISTRY).join(', ')}`,
        };
      }
      if (!Object.hasOwn(spec.actions, action)) {
        return {
          error: `Unknown action: ${name}.${action}. Available: ${Object.keys(spec.actions).join(', ')}`,
        };
      }

      return { tool: name, action, params };
    } catch (err: unknown) {
      return {
        error: `Failed to parse tool arguments: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 生成当前 capability 允许的轻量 schema 列表。
   */
  getSchemas(
    ctx: Pick<ToolContext, 'runtime' | 'toolAvailability'> = {}
  ): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return generateLightweightSchemas(this.#selection(ctx), ctx.toolAvailability);
  }

  /**
   * 获取单个工具的完整 spec（用于 meta.tools）。
   */
  getToolSpec(name: string): ToolSpec | undefined {
    return Object.hasOwn(TOOL_REGISTRY, name) ? TOOL_REGISTRY[name] : undefined;
  }

  /* ------------------------------------------------------------------ */
  /*  Capability 权限检查                                                */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /*  并发控制 — single (同工具互斥) / exclusive (全局独占)               */
  /* ------------------------------------------------------------------ */

  #schedule(
    tool: string,
    mode: ConcurrencyMode,
    signal?: AbortSignal
  ): Promise<(() => void) | null> {
    if (signal?.aborted) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const entry: ScheduledCall = {
        tool,
        mode,
        signal,
        resolve,
        onAbort: () => {
          const index = this.#waiting.indexOf(entry);
          if (index >= 0) {
            this.#waiting.splice(index, 1);
            resolve(null);
            this.#drain();
          }
        },
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.#waiting.push(entry);
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#exclusive) {
      return;
    }
    for (let index = 0; index < this.#waiting.length; ) {
      const entry = this.#waiting[index];
      // 已排队的独占调用形成屏障，后来的读不能越过它；其他工具仍可在屏障前并发。
      if (entry.mode === 'exclusive' && this.#activeCount > 0) {
        return;
      }
      if (
        this.#singleTools.has(entry.tool) ||
        (entry.mode === 'single' && this.#activeTools.has(entry.tool))
      ) {
        index++;
        continue;
      }
      this.#waiting.splice(index, 1);
      entry.signal?.removeEventListener('abort', entry.onAbort);
      this.#activeCount++;
      this.#activeTools.set(entry.tool, (this.#activeTools.get(entry.tool) ?? 0) + 1);
      if (entry.mode === 'single') {
        this.#singleTools.add(entry.tool);
      }
      this.#exclusive = entry.mode === 'exclusive';
      entry.resolve(() => {
        this.#activeCount--;
        const count = (this.#activeTools.get(entry.tool) ?? 1) - 1;
        if (count === 0) {
          this.#activeTools.delete(entry.tool);
        } else {
          this.#activeTools.set(entry.tool, count);
        }
        if (entry.mode === 'single') {
          this.#singleTools.delete(entry.tool);
        }
        if (entry.mode === 'exclusive') {
          this.#exclusive = false;
        }
        this.#drain();
      });
      if (this.#exclusive) {
        return;
      }
    }
  }
}

function isParamObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/*  输出 token 截断 — 按 action.maxOutputTokens 强制执行                */
/* ------------------------------------------------------------------ */

/**
 * 头尾保留比例沿用原实现：头部 80%、尾部 15%，其余 5% 原本就是给截断说明的余量。
 * ASCII 在新旧口径下都是每字 0.25 token，所以常规上限下 ASCII 输出的截断位置保持不变；
 * 统一口径后只有 CJK、emoji 等字符的输出会截得更短，这正是 maxOutputTokens 的字面含义。
 */
const OUTPUT_HEAD_RATIO = 0.8;
const OUTPUT_TAIL_RATIO = 0.15;
/** shared 口径下每个字符至少 0.25 token：预算 B 内最多容纳 4B 个字符，用来收窄二分上界。 */
const MAX_CHARS_PER_TOKEN = 4;

/**
 * 截断说明的固定格式。ActiveContext 与 EvidenceCollector 用正则识别这段说明来判断输出被
 * 路由层截断，格式变更必须同步两处；省略数按 Unicode 字符计。
 */
function truncationNotice(omittedChars: number, maxTokens: number): string {
  return `\n\n... [${omittedChars} chars truncated, exceeded ${maxTokens} token limit] ...\n\n`;
}

/**
 * 按 shared token 口径（经 kernel estimateTokens 委托）把字符串结果裁到 maxTokens 以内。
 *
 * - 按 Array.from 的 Unicode 字符切分头尾，边界不会落在 UTF-16 代理对中间；
 * - 截断说明自身计入预算：头 + 说明 + 尾的估算不超过 maxTokens（估算向上取整满足次可加性，
 *   各段预算之和不超限即整体不超限）；
 * - 说明本身就超过上限时（只会出现在配置了极小 maxOutputTokens 的 action 上）不再附带原文，
 *   只保留说明，让下游仍能识别截断，并经 Logger.warn 报告该降级。
 * 非字符串结果（如 code.search 的结构化 matches）由 handler 自行按同一口径投影，这里不处理。
 */
function enforceOutputLimit(result: ToolResult, maxTokens: number, call: ParsedToolCall): void {
  if (typeof result.data !== 'string') {
    return;
  }
  const text = result.data;
  const originalTokens = estimateTokens(text);
  if (originalTokens <= maxTokens) {
    return;
  }
  const chars = Array.from(text);
  // 说明里的省略数用全文字符数作上界预留：实际省略数的位数只会更少，预留的 token 一定够用。
  const noticeTokens = estimateTokens(truncationNotice(chars.length, maxTokens));
  const contentBudget = Math.max(0, maxTokens - noticeTokens);
  // 常规上限下 5% 余量足以容纳说明；上限很小时先保头部，再把剩余预算给尾部。
  const headBudget = Math.min(Math.floor(maxTokens * OUTPUT_HEAD_RATIO), contentBudget);
  const tailBudget = Math.min(
    Math.floor(maxTokens * OUTPUT_TAIL_RATIO),
    contentBudget - headBudget
  );
  const headCount = countCharsWithinBudget(chars, headBudget, 'head');
  const tailCount = countCharsWithinBudget(chars, tailBudget, 'tail');
  // 头尾预算之和不超过 maxTokens，而全文估算超过它，所以头尾不会重叠，省略数至少为 1。
  const omittedChars = chars.length - headCount - tailCount;
  const head = chars.slice(0, headCount).join('');
  const tail = chars.slice(chars.length - tailCount).join('');
  const truncated = `${head}${truncationNotice(omittedChars, maxTokens)}${tail}`;
  result.data = truncated;
  const finalTokens = estimateTokens(truncated);
  // 只有说明本身超限时结果才会仍超过 maxTokens（见上方预算推导），据此区分常规截断与降级。
  const noticeOnly = finalTokens > maxTokens;
  markOutputTruncated(result, call, {
    maxTokens,
    originalTokens,
    finalTokens,
    omittedChars,
    noticeOnly,
  });
  reportOutputTruncation(noticeOnly ? 'warn' : 'debug', {
    toolLabel: `${call.tool}.${call.action}`,
    maxTokens,
    originalTokens,
    finalTokens,
    headCount,
    tailCount,
    omittedChars,
  });
}

/**
 * 把路由层截断写进结果元信息，让信封诊断能区分完整输出与被截断输出（L4-P04 / I02）。
 *
 * - degraded=true：输出是有损视图；adapter 把它提升到 envelope.diagnostics.degraded；
 * - resultStatus 只在 handler 未声明时置为 'partial'：handler 的显式状态是执行真值，例如 terminal
 *   非零退出码的 'error'、超时的 'timeout' 都不能被截断覆盖成 partial；
 * - 追加 tool_output_truncated 警告（只含计数，不含输出原文）；handler 已给出同义警告
 *   （code.read 的 code_read_partial_view）时不重复追加；
 * - handler 返回的结果没有 _meta 时补建最小元信息，否则截断无法进入信封诊断。
 * 警告数组整体替换而不原地 push：handler 可能复用常量数组。
 */
function markOutputTruncated(
  result: ToolResult,
  call: ParsedToolCall,
  facts: {
    maxTokens: number;
    originalTokens: number;
    finalTokens: number;
    omittedChars: number;
    noticeOnly: boolean;
  }
): void {
  const meta = result._meta ?? { cached: false, durationMs: 0, tokensEstimate: facts.finalTokens };
  result._meta = meta;
  meta.tokensEstimate = facts.finalTokens;
  meta.degraded = true;
  if (meta.resultStatus === undefined) {
    meta.resultStatus = 'partial';
  }
  const warnings = meta.diagnosticWarnings ?? [];
  if (warnings.some((warning) => TRUNCATION_WARNING_CODES.has(warning.code))) {
    return;
  }
  const truncation: ToolDiagnosticWarning = {
    code: 'tool_output_truncated',
    message:
      `${facts.omittedChars} chars truncated to fit maxOutputTokens=${facts.maxTokens} ` +
      `(originalTokens=${facts.originalTokens}, finalTokens=${facts.finalTokens}` +
      `${facts.noticeOnly ? ', notice only: the limit cannot hold any output' : ''})`,
    stage: `${call.tool}.${call.action}`,
    tool: call.tool,
  };
  meta.diagnosticWarnings = [...warnings, truncation];
}

/**
 * 已表达“输出被截断”的警告码：handler 自行声明的同义码（code.read 的 code_read_partial_view），
 * 以及本函数自己的码（宿主复用同一结果对象时防重复）。出现任一时不再追加 tool_output_truncated。
 */
const TRUNCATION_WARNING_CODES: ReadonlySet<string> = new Set([
  'code_read_partial_view',
  'tool_output_truncated',
]);

/** 二分求在 budget 内能保留的最多字符数；estimateTokens 随字符数单调不减，二分结果即最大值。 */
function countCharsWithinBudget(
  chars: readonly string[],
  budget: number,
  side: 'head' | 'tail'
): number {
  let low = 0;
  let high = Math.min(chars.length, budget * MAX_CHARS_PER_TOKEN);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = side === 'head' ? chars.slice(0, mid) : chars.slice(chars.length - mid);
    if (estimateTokens(slice.join('')) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * 截断诊断只记录计数，不写入输出原文（可能含源码、命令输出或凭据）。常规截断记 debug；
 * 说明本身超过上限属于配置降级，记 warn（reason=notice_exceeds_limit），结果仍超过 maxTokens。
 * 经 observeSafely 隔离日志异常，诊断失败不能把一次成功的工具调用变成失败。
 */
function reportOutputTruncation(
  level: 'debug' | 'warn',
  facts: {
    toolLabel: string;
    maxTokens: number;
    originalTokens: number;
    finalTokens: number;
    headCount: number;
    tailCount: number;
    omittedChars: number;
  }
): void {
  const reason = level === 'warn' ? 'notice_exceeds_limit' : 'output_exceeds_limit';
  const path = level === 'warn' ? 'notice_only' : 'head_tail';
  const message =
    `[ToolRouter] tool=${facts.toolLabel}; output_truncated reason=${reason} path=${path} ` +
    `maxOutputTokens=${facts.maxTokens} originalTokens=${facts.originalTokens} ` +
    `finalTokens=${facts.finalTokens} keptHeadChars=${facts.headCount} ` +
    `keptTailChars=${facts.tailCount} omittedChars=${facts.omittedChars}`;
  observeSafely(
    () =>
      level === 'warn' ? Logger.getInstance().warn(message) : Logger.getInstance().debug(message),
    () => undefined
  );
}

/* ------------------------------------------------------------------ */
/*  执行异常归类 — handler 崩溃 / 宿主可用性回调失败 / 路由自身失败      */
/* ------------------------------------------------------------------ */

/**
 * execute 抛错时所处的阶段：
 * - handler：handler 自身抛错（崩溃），区别于 handler 正常返回的业务失败（fail(...)，不带此诊断）；
 * - availability：排队后重读宿主可用性快照的回调抛错，属于宿主上下文失败；
 * - router：路由自身步骤（参数快照、准入、registry 视图、输出截断等）抛错。
 */
type RouterFailurePhase = 'handler' | 'availability' | 'router';

/**
 * 把 execute 中的异常归一为带诊断码的失败结果（L4-P04 / I02）。返回值仍是 ok:false 的普通失败，
 * error 文案保持“Tool execution error (tool.action): ...”不变；新增的 _meta.diagnosticWarnings
 * 让信封与过程诊断能把“处理器崩溃/宿主接线错误”与业务失败分开计数，并同步写一条 warn 日志。
 */
function routerExecutionFailure(
  call: ParsedToolCall,
  phase: RouterFailurePhase,
  err: unknown,
  durationMs: number
): ToolResult {
  const label = `${call.tool}.${call.action}`;
  const message = err instanceof Error ? err.message : String(err);
  const errorName = err instanceof Error ? err.name : typeof err;
  const warning: ToolDiagnosticWarning =
    phase === 'handler'
      ? {
          code: 'tool_handler_threw',
          message: `Handler threw ${errorName}: ${message}`,
          stage: label,
          tool: call.tool,
        }
      : phase === 'availability'
        ? {
            code: 'tool_host_context_failed',
            message: `Host availability lookup threw ${errorName} after scheduling: ${message}`,
            stage: 'availability',
            tool: call.tool,
          }
        : {
            code: 'tool_router_failed',
            message: `Router step threw ${errorName}: ${message}`,
            stage: label,
            tool: call.tool,
          };
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[ToolRouter] tool=${label}; ${warning.code} phase=${phase} path=fail ` +
          `error=${errorName}: ${message}`
      ),
    () => undefined
  );
  return {
    ...fail(`Tool execution error (${label}): ${message}`),
    _meta: {
      cached: false,
      durationMs,
      tokensEstimate: 0,
      diagnosticWarnings: [warning],
    },
  };
}

/**
 * 参数 schema 编译失败的一次性诊断（tool_parameter_schema_invalid）。parameters.ts 在失败首次
 * 编译并缓存时调用，缓存命中不再调用；只记录 schema 关键字/路径说明，不记录调用参数。
 */
const reportParameterSchemaFailure: ToolParameterSchemaFailureSink = ({
  label,
  variant,
  reason,
}) => {
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[ToolRouter] tool=${label}; tool_parameter_schema_invalid variant=${variant} ` +
          `path=blocked code=TOOL_UNAVAILABLE reason=${reason}`
      ),
    () => undefined
  );
};
