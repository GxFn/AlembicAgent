/**
 * 工具管道的兼容入口与默认装配。职责实现位于 toolPipeline/，公开符号保持稳定，
 * 默认顺序以 createToolPipeline 及其注释为准。
 * 这里拥有中间件注册表；engine 只运行生命周期，不反向依赖本入口。
 *
 * 公开导出收窄说明（L5-P47 / I45，待决事项②未答复前只登记、不删除）：
 *   - 下面再导出的单个中间件不是完整集合（runtimeSafetyGate 不在其中；runtime 子路径还缺
 *     toolArgumentBoundsGate、producerSubmitOnlyGate、evidenceCapture），用它们自行组装的管道
 *     比默认管道宽松。需要同等安全的管道时只用 createToolPipeline()。
 *   - observationRecord、progressEmitter、eventBusPublisher 不在默认装配中，宿主零引用；
 *     ②确认收窄后与签名清单一起撤回，②决定保留则需补齐缺失的门并修正两个事件中间件的漂移。
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
 * 控制门先于缓存；缓存快照先于证据标注；证据→tracker→trace→提交登记正序执行。
 * observationRecord 不在默认装配（L5-P47 / I45）：宿主路由总带信封，它以 cacheHit=true 调用
 * MemoryCoordinator.recordObservation，不写 SessionStore；无信封路径（门拦截、宿主抛错、
 * 发起前取消）都带 error，SessionStore 拒收。每次调用都执行却从不产生效果，所以移出默认链；
 * 导出本身与 SessionStore 工具缓存的去留随待决事项②①处理。
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
    .use(trackerSignal)
    .use(traceRecord)
    .use(submitDedup);
}
