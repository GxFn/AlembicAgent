/**
 * @module tools/runtime/router
 *
 * ToolRouter — 工具调用的统一入口。
 *
 * 流程: 参数解析 → Schema 校验 → Capability 权限检查 → 并发控制 → Handler 分发 → 输出截断
 */

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
  ToolResult,
  ToolSpec,
} from '#tools/kernel/registry.js';
import { estimateTokens, fail } from '#tools/kernel/registry.js';
import type { ToolActionAllowlist } from '#tools/kernel/toolSchema.js';
import {
  intersectToolActions,
  isToolActionAllowed,
  isToolActionAllowlist,
} from '#tools/kernel/toolSelection.js';
import { toolAdmissionFailure } from './admission.js';
import { describeToolAvailability } from './availability.js';
import { generateLightweightSchemas, TOOL_REGISTRY } from './registry.js';
import { createToolRegistryView, toolAvailabilityError } from './selection.js';

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
    const paramError = validateParams(call, spec.actions[call.action]);
    if (paramError) {
      return { allowed: false, stage: 'discover', reason: paramError };
    }
    const capability = this.#config.capability;
    if (capability && !isToolActionAllowed(capability.allowedTools, call.tool, call.action)) {
      return {
        allowed: false,
        stage: 'approve',
        resultStatus: 'blocked',
        reason: isToolActionAllowlist(capability.allowedTools)
          ? `Permission denied: Action "${call.tool}.${call.action}" not allowed in capability "${capability.name}"`
          : 'Permission denied: invalid capability action allowlist',
      };
    }
    if (
      ctx.runtime?.allowedTools !== undefined &&
      !isToolActionAllowed(ctx.runtime.allowedTools, call.tool, call.action)
    ) {
      return {
        allowed: false,
        stage: 'approve',
        resultStatus: 'blocked',
        reason: isToolActionAllowlist(ctx.runtime.allowedTools)
          ? `Permission denied: Action "${call.tool}.${call.action}" not allowed in the current stage`
          : 'Permission denied: invalid stage action allowlist',
      };
    }
    const availability = ctx.toolAvailability;
    const availabilityError = toolAvailabilityError(availability);
    if (availabilityError) {
      return {
        allowed: false,
        stage: 'execute',
        resultStatus: 'blocked',
        reason: availabilityError,
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
    const configured = this.#config.capability?.allowedTools;
    const stage = ctx.runtime?.allowedTools;
    // 完整授权合同不采用 selection 顶层 null 的“不限制”语义。
    if (
      (this.#config.capability && !isToolActionAllowlist(configured)) ||
      (stage !== undefined && !isToolActionAllowlist(stage))
    ) {
      throw new Error('Invalid tool action allowlist');
    }
    return configured && stage ? intersectToolActions(configured, stage) : (stage ?? configured);
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

    try {
      if (ctx.abortSignal?.aborted) {
        return fail('Tool execution aborted before scheduling');
      }
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
        const currentCtx = options.getAvailability
          ? { ...ctx, toolAvailability: options.getAvailability() }
          : ctx;
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
        const result = await action.handler(call.params, handlerCtx);

        if (result._meta) {
          result._meta.durationMs = Date.now() - startMs;
        }

        if (action.maxOutputTokens && result.ok) {
          enforceOutputLimit(result, action.maxOutputTokens);
        }

        return result;
      } finally {
        release();
      }
    } catch (err: unknown) {
      return fail(
        `Tool execution error (${call.tool}.${call.action}): ${err instanceof Error ? err.message : String(err)}`
      );
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

/* ------------------------------------------------------------------ */
/*  参数 Schema 校验 — 轻量内联，不依赖 ajv                             */
/* ------------------------------------------------------------------ */

function validateParams(call: ParsedToolCall, action: ToolAction): string | null {
  if (!isParamObject(call.params)) {
    return `Invalid params for ${call.tool}.${call.action}: expected object`;
  }
  const schema = action.params as {
    required?: string[];
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
  };

  if (schema.required) {
    for (const field of schema.required) {
      if (call.params[field] === undefined || call.params[field] === null) {
        return `Missing required param "${field}" for ${call.tool}.${call.action}`;
      }
    }
  }

  if (schema.properties) {
    for (const [key, val] of Object.entries(call.params)) {
      const prop = schema.properties[key];
      if (!prop) {
        continue;
      }
      if (prop.type && !matchesParamType(val, prop.type)) {
        return `Invalid type for ${call.tool}.${call.action}.${key}: expected ${String(prop.type)}`;
      }
      if (prop.enum && !prop.enum.includes(val)) {
        return (
          `Invalid value "${String(val)}" for ${call.tool}.${call.action}.${key}. ` +
          `Expected: ${prop.enum.join(', ')}`
        );
      }
    }
  }

  return null;
}

function isParamObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesParamType(value: unknown, type: string | string[]): boolean {
  if (Array.isArray(type)) {
    return type.some((candidate) => matchesParamType(value, candidate));
  }
  switch (type) {
    case 'object':
      return isParamObject(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      return typeof value === type;
  }
}

/* ------------------------------------------------------------------ */
/*  输出 token 截断 — 按 action.maxOutputTokens 强制执行                */
/* ------------------------------------------------------------------ */

function enforceOutputLimit(result: ToolResult, maxTokens: number): void {
  if (typeof result.data !== 'string') {
    return;
  }
  const tokens = estimateTokens(result.data);
  if (tokens <= maxTokens) {
    return;
  }
  const maxChars = maxTokens * 4;
  const headChars = Math.floor(maxChars * 0.8);
  const tailChars = Math.floor(maxChars * 0.15);
  const head = result.data.slice(0, headChars);
  const tail = result.data.slice(-tailChars);
  const omitted = result.data.length - headChars - tailChars;
  result.data = `${head}\n\n... [${omitted} chars truncated, exceeded ${maxTokens} token limit] ...\n\n${tail}`;
  if (result._meta) {
    result._meta.tokensEstimate = estimateTokens(result.data as string);
  }
}
