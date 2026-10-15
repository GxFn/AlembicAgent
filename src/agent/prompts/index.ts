// W6-d(A1):以下 10 个符号已段级迁往 ../evaluation/,此处按名 re-export——
// @alembic/agent/prompts 的 30 名集与 signatureHash 必须恒等(公共 wire 冻结)。
// 刻意不用 `export *`:evaluation 新导出的路由常量(DEPTH_GAP_REASON 等)与跨文件
// helper(buildQualityScores/getArtifactMemoryFindingCount)不得漏上 ./prompts
// 公共面(名集膨胀=签名门红);它们只经 evaluation/ 内部 barrel 面世。
export {
  analysisQualityGate,
  applyDepthRetryGate,
  buildAnalysisArtifact,
  buildAnalysisReport,
  buildRelationsPipelineStages,
  buildScanPipelineStages,
  evolutionGateEvaluator,
  insightGateEvaluator,
  producerRejectionGateEvaluator,
  sanitizeAnalysisText,
} from '../evaluation/index.js';
export * from './insightAnalyst.js';
export * from './insightEvolver.js';
// L6-P25 / 待决事项②：EVOLVER_TOOLS 只在公开入口上标废弃（显式按名转出覆盖上一行 `export *` 的同名绑定，
// 运行时名字与种类不变）。ANALYST_TOOLS / PRODUCER_TOOLS / buildProducerPrompt 的废弃标注在各自源文件。
export {
  /**
   * @deprecated 无生产消费者且与真实工具面漂移（evolve 阶段另经 getGenerateStageTerminalTools 追加 terminal）；
   *   宿主只在测试中引用。随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
   */
  EVOLVER_TOOLS,
} from './insightEvolver.js';
// C53: insightGate 按名 re-export 冻结的三个修复类提示构建器；同文件的内部 helper
// (buildAnalyzeRetryPrompt，供 scan 管线与 insight 预设共用)不得经 `export *` 漏上公开名集。
export {
  buildRecordRepairPrompt,
  buildRetryPrompt,
  buildSummaryRewritePrompt,
} from './insightGate.js';
export * from './insightProducer.js';
export * from './scanPrompts.js';
