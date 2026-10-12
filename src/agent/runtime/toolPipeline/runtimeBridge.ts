/** 唯一宿主路由边界：装配请求、保留共享对象身份、归一化 envelope 和异常。 */
import {
  mergeTerminalIntents,
  projectToolResultOrdinaryOutput,
  type ToolCallRequest,
  type ToolResultEnvelope,
  type ToolResultStatus,
  type ToolRuntimeCallContext,
  toolResultInternals,
} from '#tools/kernel/index.js';
import { SafetyPolicy } from '../../policies/index.js';
import { toExecutableToolCall } from './callNormalization.js';
import type {
  ToolCall,
  ToolPipelineContext as ToolExecContext,
  ToolLoopPort,
  ToolMetadata,
} from './contracts.js';

const BLOCKING_ENVELOPE_STATUSES = new Set<ToolResultStatus>([
  'blocked',
  'needs-confirmation',
  'aborted',
  'timeout',
]);

/**
 * 返回值投影。传入的必须是已经过 redactModelBoundEnvelope 的信封：structuredContent 已删除
 * D23 秘密/私有字段（任意深度），业务字段（含根 message）原样保留；纯文本信封再走默认
 * 普通输出投影（秘密字段任意深度 + 旧信封字段只在根路径）。
 */
function projectPipelineToolResult(envelope: ToolResultEnvelope): unknown {
  if (envelope.structuredContent !== undefined) {
    return envelope.structuredContent;
  }
  return projectToolResultOrdinaryOutput(envelope);
}

/** 诊断里最多列出的私有字段路径数与单条长度；路径只含键名，不含任何值。 */
const MAX_REPORTED_PRIVATE_FIELD_PATHS = 10;
const MAX_REPORTED_PRIVATE_FIELD_PATH_LENGTH = 120;

/**
 * D23 真实出口（L3-C02/L3-P07）。模型历史读 metadata.envelope.text（projectToolReceipt），
 * 记忆、证据、观察者与 PCV 读返回值和 envelope.structuredContent，所以必须在写入 metadata
 * 之前清理整份信封，只清理返回值挡不住私有字段。宿主 /agent/tool 不经过本函数，规范信封
 * 原样保留在 ToolRouterAdapter 的响应里（宿主 HTTP 出口不执行 D23）。
 *
 * 没有私有字段时返回同一信封对象；有改写时写诊断（无诊断收集器时降级到 runtime.logger），
 * 只记字段路径与警告码，不记字段值。
 */
function redactModelBoundEnvelope(
  call: ToolCall,
  context: ToolExecContext,
  envelope: ToolResultEnvelope
): ToolResultEnvelope {
  const redaction = toolResultInternals.redactPrivateFields(envelope);
  if (redaction.envelope === envelope) {
    return envelope;
  }
  const { redactedFields, warningCodes } = redaction;
  const shownPaths = redactedFields
    .slice(0, MAX_REPORTED_PRIVATE_FIELD_PATHS)
    .map((path) => path.slice(0, MAX_REPORTED_PRIVATE_FIELD_PATH_LENGTH));
  const morePaths = redactedFields.length - shownPaths.length;
  const warning =
    redactedFields.length > 0
      ? {
          code: 'TOOL_RESULT_PRIVATE_FIELDS_REDACTED',
          tool: call.name,
          message:
            `Removed ${redactedFields.length} private field(s) from the ${call.name} result before it reached the model: ` +
            `${shownPaths.join(', ')}${morePaths > 0 ? ` (+${morePaths} more)` : ''}` +
            `${warningCodes.length > 0 ? `; normalization: ${warningCodes.join(', ')}` : ''}.`,
        }
      : {
          // 没有命中私有键名，但结果含 toJSON/accessor/非普通原型/超深容器：原对象在下游
          // JSON.stringify 时可能重新带出私有字段，因此改用 JSON 安全副本。
          code: 'TOOL_RESULT_PRIVATE_FIELD_SCAN_NORMALIZED',
          tool: call.name,
          message: `Replaced the ${call.name} result with a JSON-safe copy before it reached the model (${warningCodes.join(', ')}).`,
        };
  if (context.loopCtx.diagnostics) {
    context.loopCtx.diagnostics.warn(warning);
  } else {
    try {
      const pending: unknown = context.runtime.logger?.warn(
        `[ToolPipeline] ${warning.code}: ${warning.message}`
      );
      if (pending && typeof (pending as { then?: unknown }).then === 'function') {
        // 异步日志器的拒绝同样不能升级为未处理拒绝。
        void Promise.resolve(pending).catch(() => undefined);
      }
    } catch (err: unknown) {
      // 宿主日志器失败不能让已确认的工具结果变成执行失败；清理本身已经完成。
      void err;
    }
  }
  return redaction.envelope;
}

export async function executeRuntimeToolCall(
  call: ToolCall,
  context: ToolExecContext,
  metadata: ToolMetadata
): Promise<unknown> {
  // 单调时钟：墙钟回拨不能让 metadata.durationMs 变负（L3-C03）；取整保持整数毫秒。
  const t0 = performance.now();
  try {
    // 请求装配（policies.get / SafetyPolicy / allowedToolActions 投影等）是 Agent 侧逻辑，
    // 与宿主路由执行分开捕获：装配失败归类为 TOOL_REQUEST_ASSEMBLY_FAILED，宿主根本没有被调用；
    // 混在一起时运维只能看到“宿主执行失败”，无法区分 Agent 装配缺陷与宿主路由故障。
    let request: ToolCallRequest;
    try {
      request = buildRuntimeToolCallRequest(call, context);
    } catch (err: unknown) {
      const error = describeBridgeError(err);
      reportBridgeFailure(context, {
        code: TOOL_REQUEST_ASSEMBLY_FAILED_CODE,
        tool: call.name,
        message: `Agent-side request assembly for ${call.name} failed before host dispatch: ${truncateBridgeError(error)}`,
      });
      return { error };
    }
    // SafetyPolicy及请求装配可能执行宿主代码；最后一道取消检查必须位于真实路由入口前。
    if (request.abortSignal?.aborted) {
      metadata.blocked = true;
      context.loopCtx.diagnostics?.recordCancelReason('abort_signal');
      context.loopCtx.diagnostics?.warn({
        code: 'TOOL_HOST_DISPATCH_CANCELLED',
        message: `Host dispatch of ${call.name} was cancelled before execution.`,
      });
      return { status: 'aborted', error: 'Tool call cancelled before host dispatch' };
    }
    try {
      const routed = await context.runtime.toolRouter.execute(request);
      const envelope = redactModelBoundEnvelope(call, context, routed);
      recordExecutedEnvelope(call, context, metadata, envelope);
      return projectPipelineToolResult(envelope);
    } catch (err: unknown) {
      const error = describeBridgeError(err);
      reportBridgeFailure(context, {
        code: TOOL_HOST_EXECUTION_FAILED_CODE,
        tool: call.name,
        message: `Host execution of ${call.name} failed before returning an envelope: ${truncateBridgeError(error)}`,
      });
      return { error };
    }
  } finally {
    metadata.durationMs = Math.round(performance.now() - t0);
  }
}

const TOOL_REQUEST_ASSEMBLY_FAILED_CODE = 'TOOL_REQUEST_ASSEMBLY_FAILED';
const TOOL_HOST_EXECUTION_FAILED_CODE = 'TOOL_HOST_EXECUTION_FAILED';
/** 诊断里错误原文的展示上限；返回给模型的 error 不截断（保持原返回值）。 */
const MAX_REPORTED_BRIDGE_ERROR_CHARS = 300;

/** 模型可见的错误文本（与旧实现同源同规则）：Error.message → 非空字符串 → 固定兜底。 */
function describeBridgeError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err) {
    return err;
  }
  return 'Tool execution failed';
}

function truncateBridgeError(error: string): string {
  return error.length > MAX_REPORTED_BRIDGE_ERROR_CHARS
    ? `${error.slice(0, MAX_REPORTED_BRIDGE_ERROR_CHARS)}…`
    : error;
}

/** 有诊断收集器时写诊断；没有时降级到 runtime.logger（宿主日志器失败不影响返回值）。 */
function reportBridgeFailure(
  context: ToolExecContext,
  warning: { code: string; tool: string; message: string }
): void {
  if (context.loopCtx.diagnostics) {
    context.loopCtx.diagnostics.warn(warning);
    return;
  }
  warnSafely(context.runtime, `[ToolPipeline] ${warning.code}: ${warning.message}`);
}

/**
 * 宿主请求投影。只投影有读取者的字段（L5-P47 / I45）：policyValidator（权限校验由 Agent 侧
 * runtimeSafetyGate 完成）、sessionToolCalls（每次调用对全部历史做 O(n) 重映射）与 currentRound
 * （与 iteration 重复）在 src/tools、宿主与 Core 中都没有读取者，已不再投影；
 * ToolRuntimeCallContext 上对应的可选字段是否收窄依赖待决事项②，这里不改类型。
 */
function buildRuntimeToolCallRequest(call: ToolCall, context: ToolExecContext): ToolCallRequest {
  const { runtime, loopCtx } = context;
  const executableCall = toExecutableToolCall(call);
  const safetyPolicy = runtime.policies.get?.(SafetyPolicy) || null;
  const terminalIntent = resolveLoopTerminalIntent(executableCall.name, context);

  return {
    toolId: executableCall.name,
    args: executableCall.args,
    surface: 'runtime',
    actor: { role: 'developer', user: runtime.id },
    source: {
      kind: 'runtime',
      name: resolvePipelineSourceName(context),
    },
    abortSignal: loopCtx.abortSignal || null,
    runtime: {
      allowedTools: Object.fromEntries(
        loopCtx.allowedToolIds.map((tool) => [
          tool,
          Object.hasOwn(loopCtx.allowedToolActions ?? {}, tool)
            ? [...loopCtx.allowedToolActions[tool]]
            : null,
        ])
      ),
      agentId: runtime.id,
      resourceScope: loopCtx.resourceScope,
      presetName: runtime.presetName,
      iteration: loopCtx.iteration || 0,
      // 当前无消费者：src/tools、宿主与 Core 都不读取 runtime.cache，宿主侧没有第二层结果缓存；
      // 把 memoryCoordinator 放在这里只是旧投影的残留。字段去留随待决事项①（SessionStore
      // 工具缓存去留）一起决定，决定前保持原样投影，不改变宿主收到的请求形状。
      cache: loopCtx.memoryCoordinator || null,
      diagnostics: loopCtx.diagnostics || null,
      safetyPolicy,
      fileCache: runtime.fileCache,
      dataRoot: runtime.dataRoot,
      lang: runtime.lang,
      logger: runtime.logger || null,
      aiProvider: runtime.aiProvider || null,
      sharedState: loopCtx.sharedState || null,
      dimensionMeta: loopCtx.sharedState?._dimensionMeta || null,
      projectLanguage: resolveProjectLanguage(loopCtx),
      submittedTitles: loopCtx.sharedState?.submittedTitles || null,
      submittedPatterns: loopCtx.sharedState?.submittedPatterns || null,
      submittedTriggers: loopCtx.sharedState?.submittedTriggers || null,
      bootstrapDedup: loopCtx.sharedState?._bootstrapDedup || null,
      memoryCoordinator: loopCtx.memoryCoordinator || null,
      evidenceLedger: loopCtx.evidenceLedger || null,
      dimensionScopeId: resolveDimensionScopeId(loopCtx),
      // 未声明时不出现该键：没有隔离意图的运行，请求形状与旧版完全一致。
      ...(terminalIntent ? { terminalIntent } : {}),
    },
  };
}

const TERMINAL_INTENT_VALUE_IGNORED_CODE = 'TERMINAL_INTENT_VALUE_IGNORED';

/**
 * 终端隔离意图的生产投影（L4-P38 / I47）。生产宿主构造 ToolRouterAdapter 时不带 capability，
 * router 不会把 capability 的 commandAllowlist 注入 handler ctx，当前能力只在 loopCtx.capabilities 上；
 * 所以由这里读取每个能力的 commandAllowlist.intent，按 mergeTerminalIntents 的规则（按维度取最严格值，
 * 与 accessGates 对多个能力的 bins 逐个检查一致）合并成一份，经 request.runtime.terminalIntent 交给
 * 路由，terminal handler 再作为 sandboxExecutor.exec 的 opts.intent 交给宿主。
 *
 * 只为 terminal 调用投影：其它工具不消费该字段，不扩大请求面。无法识别的取值被丢弃（不能放宽其它
 * 能力的声明），并同时写 runtime.logger 与诊断，记录能力名、字段与取值。
 */
function resolveLoopTerminalIntent(
  toolName: string,
  { runtime, loopCtx }: ToolExecContext
): ToolRuntimeCallContext['terminalIntent'] {
  if (toolName !== 'terminal') {
    return undefined;
  }
  const declarations = (loopCtx.capabilities ?? []).map((capability, index) => {
    const declared = capability as { name?: unknown; commandAllowlist?: { intent?: unknown } };
    const name = typeof declared?.name === 'string' ? declared.name : `#${index}`;
    return { source: `capability=${name}`, intent: declared?.commandAllowlist?.intent };
  });
  const { intent, ignored } = mergeTerminalIntents(declarations);
  for (const entry of ignored) {
    const message =
      `Ignored terminal intent value ${entry}; only network:'none' and filesystem:'read-only' ` +
      'are forwarded to the sandbox executor.';
    loopCtx.diagnostics?.warn({
      code: TERMINAL_INTENT_VALUE_IGNORED_CODE,
      message,
      tool: 'terminal',
    });
    warnSafely(runtime, `[ToolPipeline] ${TERMINAL_INTENT_VALUE_IGNORED_CODE}: ${message}`);
  }
  return intent;
}

/** 宿主日志器失败（同步抛错或异步拒绝）不能让工具请求装配失败；诊断已另行记录。 */
function warnSafely(runtime: ToolExecContext['runtime'], message: string): void {
  try {
    const pending: unknown = runtime.logger?.warn(message);
    if (pending && typeof (pending as { then?: unknown }).then === 'function') {
      void Promise.resolve(pending).catch(() => undefined);
    }
  } catch (err: unknown) {
    void err;
  }
}

function resolvePipelineSourceName({ runtime, loopCtx }: ToolExecContext): string {
  if (typeof loopCtx.context?.pipelinePhase === 'string') {
    return loopCtx.context.pipelinePhase;
  }
  return loopCtx.source || runtime.presetName;
}

function resolveProjectLanguage(loopCtx: ToolLoopPort): string | null {
  const language = loopCtx.sharedState?._projectLanguage;
  return typeof language === 'string' ? language : null;
}

function resolveDimensionScopeId(loopCtx: ToolLoopPort): string | null {
  const scopeId = loopCtx.sharedState?._dimensionScopeId;
  return typeof scopeId === 'string' ? scopeId : null;
}

function recordExecutedEnvelope(
  call: ToolCall,
  context: ToolExecContext,
  metadata: ToolMetadata,
  envelope: ToolResultEnvelope
): void {
  metadata.envelope = envelope;
  // 逐调用轨迹（L3-C05）：只有拿到路由信封才有 callId/status/durationMs 可记录；
  // 发起前取消与路由抛错两条无信封路径不记条目，由各自的 TOOL_HOST_* warning 定位。
  // 所有状态（含 error/blocked/timeout）都按信封原样记录；collector 按 callId 去重，
  // 父子运行合并诊断时不会重复。缺省 diagnostics（宿主未注入收集器）时静默跳过。
  context.loopCtx.diagnostics?.recordToolCallEnvelope(envelope, {
    surface: 'runtime',
    source: resolvePipelineSourceName(context),
  });
  metadata.cacheHit = envelope.cache?.hit === true;
  if (envelope.cache && envelope.cache.policy !== 'none' && envelope.cache.hit !== true) {
    metadata.cacheMiss = true;
  }
  if (!envelope.ok && BLOCKING_ENVELOPE_STATUSES.has(envelope.status)) {
    metadata.blocked = true;
    context.loopCtx.diagnostics?.recordBlockedTool(call.name, envelope.text);
  }
}
