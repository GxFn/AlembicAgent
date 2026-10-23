/**
 * 工具管道的入口与默认装配。职责实现位于 toolPipeline/，默认顺序以 createToolPipeline 及其注释为准。
 * 这里拥有中间件注册表；engine 只运行生命周期，不反向依赖本入口。
 *
 * 公开面：./runtime 只导出 createToolPipeline 与 ToolExecutionPipeline 类（W2a-01，决定②）。
 * 下面的具名中间件再导出只供仓库内测试取实现，不属于包的公开面；单个控制门不能拼出与默认链
 * 同等安全的管道，需要仓库默认控制门和观察链时只用 createToolPipeline()。
 */
import {
  allowlistGate,
  runtimeSafetyGate,
  toolArgumentBoundsGate,
} from './toolPipeline/accessGates.js';
import type { ToolCall, ToolExecContext, ToolMiddleware } from './toolPipeline/contracts.js';
import { deterministicDuplicateGuard } from './toolPipeline/duplicateCache.js';
import { executeToolPipeline } from './toolPipeline/engine.js';
import { evidenceCapture, traceRecord, trackerSignal } from './toolPipeline/observations.js';
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
  trackerSignal,
  traceRecord,
  submitDedup,
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
 * 控制门先于缓存；缓存快照先于证据标注；证据→tracker→trace→提交登记正序执行。
 * 默认链没有 memory 观察者：旧 observationRecord 每次调用都执行却从不写 SessionStore（L5-P47 / I45），
 * 已随缓存层删除（W1-04，决定①）。重复调用复用只由 deterministicDuplicateGuard 承担，且由它自行
 * 声明 cacheHit/duplicateShortCircuit（L5-P19）。工具事件由 Runtime 在结果格式化后发送，管道不再
 * 提供可选的通知中间件（W2a-01）。
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
    .use(trackerSignal)
    .use(traceRecord)
    .use(submitDedup);
}
