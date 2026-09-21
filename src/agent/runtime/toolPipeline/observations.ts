/** 执行结果的观察链：证据先落账，再供 memory、tracker、trace 消费；可选事件保持独立。 */
import {
  appendEvidenceAnnotation,
  captureEvidenceFromEnvelope,
} from '../../evidence/EvidenceCapture.js';
import { readToolObservation } from '../../utils/toolOutcomes.js';
import type {
  ToolCall,
  ToolPipelineContext as ToolExecContext,
  ToolMetadata,
} from './contracts.js';

/** 业务 payload 可保留部分读回信息；通知与 tracker 共用完整观察的失败优先级。 */
function isSuccessfulToolObservation(call: ToolCall, result: unknown, meta: ToolMetadata): boolean {
  return !meta.blocked && readToolObservation({ ...call, result, envelope: meta.envelope }).ok;
}

/**
 * EvidenceCapture — 证据台账采集（Wave A E2）
 *
 * after（必须排在 observationRecord/traceRecord 之前）：证据类工具成功返回时自动落台账，
 * 并把 `[evidence] E-x=file:range` 标注追加进 envelope.text——模型看到的文本、记忆观察、
 * 推理链留痕三者一致，模型从第一眼即以条目 ID 认知证据。
 * loopCtx.evidenceLedger 缺席（非维度场景）或采集失败时零行为——采集是旁路，绝不阻断工具链。
 */
export const evidenceCapture = {
  name: 'evidenceCapture',
  after(call: ToolCall, _result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    const ledger = ctx.loopCtx.evidenceLedger;
    const envelope = meta.envelope;
    if (!ledger || !envelope || !envelope.ok) {
      return;
    }
    try {
      const entries = captureEvidenceFromEnvelope(ledger, call, envelope);
      if (entries.length > 0) {
        envelope.text = appendEvidenceAnnotation(envelope.text, entries);
        // E4：刷新 tracker 的台账统计——RECORD 配额受真实证据支撑量钳制（P4 收口）
        ctx.loopCtx.tracker?.noteLedgerStats(ledger.stats());
      }
    } catch (err: unknown) {
      // 采集异常降级为不落账（等价改造前行为），但降级必须可观测
      ctx.loopCtx.diagnostics?.warn({
        code: 'EVIDENCE_CAPTURE_FAILED',
        message: `${call.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
};

/**
 * ObservationRecord — MemoryCoordinator 观察记录
 *
 * after: 记录工具执行观察
 */
export const observationRecord = {
  name: 'observationRecord',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    ctx.loopCtx.memoryCoordinator?.recordObservation?.(
      call.name,
      call.args,
      meta.envelope || result,
      ctx.iteration,
      meta.envelope ? true : meta.cacheHit
    );
  },
};

/**
 * TrackerSignal — ExplorationTracker 信号收集
 *
 * after: 记录工具调用信号，更新 isNew 标记
 */
export const trackerSignal = {
  name: 'trackerSignal',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (ctx.loopCtx.tracker) {
      const r = ctx.loopCtx.tracker.recordToolCall(
        call.name,
        call.args,
        // 失败状态优先于内层业务 payload；成功时仍给信号检测器原始结果。
        !isSuccessfulToolObservation(call, result, meta)
          ? { ok: false, status: meta.envelope?.status || 'blocked', data: result }
          : result
      );
      meta.isNew = r.isNew;
    }
  },
};

/**
 * TraceRecord — ActiveContext 推理链记录
 *
 * after: 记录 Action + Observation 到推理链
 */
export const traceRecord = {
  name: 'traceRecord',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    ctx.loopCtx.trace?.recordToolCall(call.name, call.args, meta.envelope || result, meta.isNew);
  },
};

/**
 * ProgressEmitter — 进度回调 (可选，需 runtime.emitProgress 为 public)
 *
 * NOTE: 默认管道不包含此中间件，因为 tool_end 事件需要 resultStr.length，
 * 而 resultStr 在管道外部计算。由 #processToolCalls 直接处理。
 */
export const progressEmitter = {
  name: 'progressEmitter',
  before(call: ToolCall, ctx: ToolExecContext) {
    ctx.runtime.emitProgress?.('tool_call', { tool: call.name, args: call.args });
  },
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    const success = isSuccessfulToolObservation(call, result, meta);
    const resultObj = result as Record<string, unknown> | null;
    ctx.runtime.emitProgress?.('tool_end', {
      tool: call.name,
      duration: meta.durationMs,
      status: success ? 'ok' : 'error',
      error: success
        ? undefined
        : meta.envelope?.text || (resultObj?.error as string | undefined) || undefined,
    });
  },
};

/**
 * EventBusPublisher — EventBus 事件发布 (可选)
 *
 * NOTE: 默认管道不包含此中间件。由 #processToolCalls 直接处理，
 * 与原始 reactLoop 保持完全一致的事件顺序。
 */
export const eventBusPublisher = {
  name: 'eventBusPublisher',
  before(call: ToolCall, ctx: ToolExecContext) {
    if (ctx.runtime.bus?.publish) {
      ctx.runtime.bus.publish(
        'tool:call:start',
        {
          agentId: ctx.runtime.id,
          tool: call.name,
        },
        { source: ctx.runtime.id }
      );
    }
  },
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (ctx.runtime.bus?.publish) {
      ctx.runtime.bus.publish(
        'tool:call:end',
        {
          agentId: ctx.runtime.id,
          tool: call.name,
          durationMs: meta.durationMs,
          success: isSuccessfulToolObservation(call, result, meta),
        },
        { source: ctx.runtime.id }
      );
    }
  },
};
