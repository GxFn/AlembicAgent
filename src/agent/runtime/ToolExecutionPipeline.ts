/**
 * 工具管道的兼容入口与默认装配。职责实现位于 toolPipeline/，公开符号和默认顺序保持稳定。
 * 这里拥有中间件注册表；engine 只运行生命周期，不反向依赖本入口。
 */
import {
  allowlistGate,
  runtimeSafetyGate,
  toolArgumentBoundsGate,
} from './toolPipeline/accessGates.js';
import type { ToolCall, ToolExecContext, ToolMiddleware } from './toolPipeline/contracts.js';
import { deterministicDuplicateGuard } from './toolPipeline/duplicateCache.js';
import { executeToolPipeline } from './toolPipeline/engine.js';
import {
  eventBusPublisher,
  evidenceCapture,
  observationRecord,
  progressEmitter,
  traceRecord,
  trackerSignal,
} from './toolPipeline/observations.js';
import {
  analystVerifyOnlyGate,
  evolutionDecisionGate,
  producerSubmitOnlyGate,
  recordRepairOnlyGate,
} from './toolPipeline/phaseGates.js';
import { executeRuntimeToolCall } from './toolPipeline/runtimeBridge.js';
import { submitDedup } from './toolPipeline/submissionLedger.js';

export {
  allowlistGate,
  toolArgumentBoundsGate,
  evolutionDecisionGate,
  recordRepairOnlyGate,
  analystVerifyOnlyGate,
  producerSubmitOnlyGate,
  deterministicDuplicateGuard,
  evidenceCapture,
  observationRecord,
  trackerSignal,
  traceRecord,
  submitDedup,
  progressEmitter,
  eventBusPublisher,
};

export class ToolExecutionPipeline {
  #middlewares: ToolMiddleware[] = [];
  use(middleware: ToolMiddleware) {
    this.#middlewares.push(middleware);
    return this;
  }
  async execute(call: ToolCall, context: ToolExecContext) {
    return executeToolPipeline(this.#middlewares, call, context, executeRuntimeToolCall);
  }
}

/**
 * 控制门先于缓存；缓存快照先于证据标注；证据→memory→tracker→trace→提交登记正序执行。
 * progressEmitter/eventBusPublisher 仍为可选：Runtime 在结果格式化后负责默认事件，避免重复。
 */
export function createToolPipeline() {
  return new ToolExecutionPipeline()
    .use(allowlistGate)
    .use(toolArgumentBoundsGate)
    .use(runtimeSafetyGate)
    .use(evolutionDecisionGate)
    .use(recordRepairOnlyGate)
    .use(analystVerifyOnlyGate)
    .use(producerSubmitOnlyGate)
    .use(deterministicDuplicateGuard)
    .use(evidenceCapture)
    .use(observationRecord)
    .use(trackerSignal)
    .use(traceRecord)
    .use(submitDedup);
}
