/**
 * shared — Provider 层与 Gateway 层共用的厂商无关横切能力。
 *
 * 「横切能力只实现一次」的基础：结构化输出提取、错误分类、用量归一（纯函数），
 * 以及可靠性控制器（有状态：重试 / 熔断 / 并发 / 限流）。
 * 既被生产中的 Provider 层复用，也供 Gateway + Transport 层在补齐时直接消费，
 * 避免两套实现继续漂移。
 */

export {
  type ClassifiableError,
  classifyLlmError,
  type ErrorClassification,
} from './error-classify.js';
export {
  ReliabilityController,
  type ReliabilityLogFn,
  type ReliabilityOptions,
} from './reliability.js';
export {
  extractJSON,
  repairTruncatedArray,
  type StructuredLogFn,
} from './structured-output.js';
export { normalizeRawUsage, type RawUsage } from './usage.js';
