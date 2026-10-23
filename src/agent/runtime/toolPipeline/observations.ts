/**
 * 执行结果的观察链：证据先落账，再供 tracker、trace 消费。
 * 旧的 observationRecord（把结果交给 MemoryCoordinator.recordObservation 写 SessionStore 工具缓存）
 * 先于 L5-P47 / I45 移出默认装配，又随缓存层删除（W1-04，决定①）连同实现与公开导出一起删除。
 * 可选的 progressEmitter、eventBusPublisher 从未进入默认装配、宿主零引用，且与 Runtime 自发的
 * tool_end / TOOL_CALL_* 事件形状已漂移，按决定②随 W2a-01 删除；工具事件只由 Runtime 自身路径发送。
 */
import {
  appendEvidenceAnnotation,
  captureEvidenceFromEnvelope,
  EvidenceCaptureError,
} from '../../evidence/EvidenceCapture.js';
import { readToolObservation } from '../../utils/toolOutcomes.js';
import type {
  ToolCall,
  ToolPipelineContext as ToolExecContext,
  ToolMetadata,
} from './contracts.js';

/** 业务 payload 可保留部分读回信息；tracker 使用完整观察的失败优先级（blocked 优先于 payload）。 */
function isSuccessfulToolObservation(call: ToolCall, result: unknown, meta: ToolMetadata): boolean {
  return !meta.blocked && readToolObservation({ ...call, result, envelope: meta.envelope }).ok;
}

/**
 * EvidenceCapture — 证据台账采集（Wave A E2）
 *
 * after（必须排在 trackerSignal/traceRecord 之前）：
 * 证据类工具成功返回时自动落台账，并把 `[evidence] E-x=file:range` 标注追加进 envelope.text——
 * 模型看到的文本与推理链留痕一致，模型从第一眼即以条目 ID 认知证据。
 * loopCtx.evidenceLedger 缺席（非维度场景）时零行为；采集部分失败保留已确认标注，不能宣称零落账。
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
      // append-only 的前项不会随后项失败回滚；先回传已确认部分，再报告剩余采集失败。
      const entries = err instanceof EvidenceCaptureError ? err.entries : [];
      if (entries.length > 0) {
        envelope.text = appendEvidenceAnnotation(envelope.text, [...entries]);
        ctx.loopCtx.tracker?.noteLedgerStats(ledger.stats());
      }
      ctx.loopCtx.diagnostics?.warn({
        code: 'EVIDENCE_CAPTURE_FAILED',
        message: `${call.name}: persisted=${entries.length}; ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
