/**
 * §11.3 H3: MemoryFlushContract — 层级数据流转规约
 *
 * 定义 ActiveContext.distill() 的显式返回类型 DistilledContext。生产读取方是 buildAnalysisArtifact
 * （分析产物的发现与工具摘要）与 ContextWindow 的 L4 记忆包；原先“维度完成时先蒸馏写入 SessionStore、
 * 再 clear() 释放”的 MemoryCoordinator.completeDimension 无调用方，已随 W2a-10（审阅包 L6-P25）删除，
 * 维度报告由宿主直接写入 SessionStore。
 * （W2a-09 / L6-P25 删除了无消费者的 DimensionFlushManifest 清单类型与 extractHighPriorityFindings
 * 投影——后者会丢掉 evidenceRefs，且 src 与宿主都不调用。）
 */

// ──────────────────────────────────────────────────────────────────
// DistilledContext — distill() 的显式返回类型
// ──────────────────────────────────────────────────────────────────

/** ActiveContext.distill() 的结构化返回类型 */
export interface DistilledContext {
  keyFindings: Array<{
    finding: string;
    evidence: string;
    importance: number;
    /** 证据台账条目 id（Wave A E3）——随发现流向 Producer/评估器的程序化引用 */
    evidenceRefs?: string[];
  }>;
  /**
   * 每项是一条人类可读的工具摘要 `[tool] 摘要`（失败项为 `[tool] [status] 原因`），
   * 由 ActiveContext 先拆开 ToolResultEnvelope 再压缩业务载荷得到；不是信封元数据
   * （callId/startedAt/durationMs 等）。宿主会把它原样拼进 analysisText 与 SessionStore.toolCallLog。
   */
  toolCallSummary: string[];
  stats: {
    totalRounds: number;
    thoughtCount: number;
    totalActions: number;
    totalObservations: number;
    reflectionCount: number;
    totalDurationMs: number;
  };
  plan: {
    text: string;
    steps: Array<{ description: string; status: string; keywords: string[] }>;
    createdAtIteration: number;
    lastUpdatedAtIteration: number;
  } | null;
  totalObservations: number;
  compressedCount: number;
  // 严格冷启动的分析上下文投影不属于 distill 结果（审阅包 L6-P27）：严格链由宿主编排、由阶段配置
  // 表达，memory 层不再承载严格投影，也不再反向依赖 production 层的类型。
}
