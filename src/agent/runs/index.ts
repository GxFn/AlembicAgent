export { projectEvolutionAuditResult, runEvolutionAudit } from './evolution/EvolutionAgentRun.js';
export { runModuleMining } from './module-mining/ScopedModuleMiningAgentRun.js';
// 严格 Plan 入口（runStrictPlanAgent / PlanContextProjectionV1）只经公开 ./runs 子路径（src/runs.ts）
// 直接从 PlanAgentRun 导出；这里不再冗余再导出，本文件只服务 ./service 的 run helper 再导出（L8-C13）。
export { runPlanAgent } from './plan/PlanAgentRun.js';
export {
  projectRelationDiscoveryResult,
  runRelationDiscovery,
} from './relation/RelationAgentRun.js';
export { runScanAgentTask, toScanFileCache } from './scan/ScanAgentRun.js';
export { projectScanRunResult } from './scan/ScanRunProjection.js';
export { runTranslationJson } from './translation/TranslationAgentRun.js';
