---
schemaVersion: 1
diagramId: file-index
topic: "00"
title: 文件阅读索引
viewType: guide
truthKind: in-progress-worktree
reviewDepth: L0
verifiedAt: 2026-10-23
baselineCommit: 37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0
documentationOwner: AlembicAgent 架构文档维护者
sourcePaths:
  - src/**/*.ts
  - scripts/**/*.mjs
testPaths:
  - test/**/*
contractPaths:
  - package.json
  - package-lock.json
  - config/**/*.json
  - tsconfig.json
  - vitest.config.ts
refreshTriggers: []
sourceFingerprint: sha256:1c04ca6854357bb861000df283c5344b99265566c328e44d3dc8c864286b77de
testEvidence: anchored
externalContracts:
  - "@alembic/core：公开包端口，本图不递归扫描其实现；宿主装配只核对本仓契约。"
reviewRecord: evidence/readings.json
generatedBy: mixed
---

# 文件阅读索引

当前290个源码均有与当前字节匹配的全文或累计全文记录。本轮逐个重新通读原53个局部复核文件，共33,370个库存行（含末尾空行），补入323个连续语义段和209条分支说明；其余237个按v5相同字节继承原阅读，未声称本轮重读。全文阅读不等于全部分支已测试。

新增深读入口：[Profile与宿主装配](02-service-orchestration/full-profile-review.md) · [策略、预算与诊断](03-runtime-lifecycle/full-policy-review.md) · [Runtime与PCV](03-runtime-lifecycle/full-source-review.md) · [工具处理器](06-tool-execution/full-source-review.md) · [记忆与上下文](07-memory-context/full-source-review.md)。测试和配置仍保留真实partial/indexed状态，执行证据另行绑定。

| 文件 | 职责 | 阅读 / 来源 |
| --- | --- | --- |
| `scripts/build-agent.mjs` | 清理本仓 dist 后执行 TypeScript NodeNext 构建 | full / inherited |
| `scripts/check-agent-space-edges.mjs` | 只读 Core canonical 空间 DAG；校验 manifest/source 依赖与工具链底线 | full / inherited |
| `scripts/codemod-rename.mjs` | 默认 dry-run；规划相对 import 与路径字符串更新，--apply 后 git mv + 改文件 | full / inherited |
| `scripts/eval-judge-calibration.mjs` | 人工标签校准 judge，冻结模型load receipt与源码hash，输出统计报告 | full / inherited |
| `scripts/eval-mining.mjs` | tooling 输入，仅索引；不宣称语义阅读。 | indexed / unreviewed |
| `scripts/eval-strict-production.mjs` | tooling 输入，仅索引；不宣称语义阅读。 | indexed / unreviewed |
| `scripts/fixtures/strict-public-connected-probe.mjs` | 公共facade真实Core fact executor→分析→生产terminal→durable V5连接证明与11负例 | full / inherited |
| `scripts/guard-agent-release-package.mjs` | 阻止含file:../依赖的开发根直接pack/publish | full / inherited |
| `scripts/lib/mining-eval-core.mjs` | 无IO评分/观测聚合/Markdown报告纯函数 | full / inherited |
| `scripts/lib/mining-eval-runtime.mjs` | 内存生产网关、source hash receipt和judge诊断格式化 | full / inherited |
| `scripts/lint-agent-import-boundary.mjs` | 禁止Plugin/Codex/MCP/Skill交付实现进入Agent | full / inherited |
| `scripts/lint-agent-public-api-boundary.mjs` | exact export分类、dist/types目标、contract matrix及禁用样例完整性 | full / inherited |
| `scripts/lint-doctrine.mjs` | tooling 输入，仅索引；不宣称语义阅读。 | indexed / unreviewed |
| `scripts/lint-implicit-keys.mjs` | AST识别_通道/字段/动态前缀，核对登记与读写方 | full / inherited |
| `scripts/lint-layer-contract.mjs` | AST依赖图、type-only豁免、cross-area与文件级精确runtime import门 | full / inherited |
| `scripts/lint-naming.mjs` | 按artifact类型检查文件命名/例外 | full / inherited |
| `scripts/lint-provider-neutral-kernel.mjs` | 运行时/策略/评估层provider名字正则门与显式豁免标记 | full / inherited |
| `scripts/probe-agent-public-strict-consumer.mjs` | 在Main消费环境fresh process跑连接probe，并用虚拟source做TS public consumer检查 | full / inherited |
| `scripts/probe-embedding-capacity-hint.mjs` | dist AI provider嵌入并发hint配置/env/default投影probe | full / inherited |
| `scripts/smoke-agent-public-imports.mjs` | tooling 输入，仅索引；不宣称语义阅读。 | indexed / unreviewed |
| `scripts/smoke-agent-public-signatures.mjs` | 逐出口runtime名字/种类/hash精确冻结 | full / inherited |
| `scripts/stage-agent-publish-package.mjs` | 生成发布暂存manifest、registry Core依赖与source commit元数据 | full / inherited |
| `scripts/verify-agent-validation-floor.mjs` | 测试文件/AST声明数底线、公开出口数/Core引用基线/pack条目数与suite名字 | full / inherited |
| `src/agent/context/ContextWindow.ts` | Provider历史、投影视图与L1–L4压缩；工具展示结果限制器 | full / fresh |
| `src/agent/context/ConversationStore.ts` | JSONL对话与100条LRU索引；只读兼容旧摘要 | full / fresh |
| `src/agent/context/ExplorationTracker.ts` | 探索阶段机与真实回执计数、nudge、grace exit编排 | full / fresh |
| `src/agent/context/exploration/ExplorationStrategies.ts` | 探索预算/trace合同与bootstrap、analyst、producer规则声明 | full / fresh |
| `src/agent/context/exploration/NudgeGenerator.ts` | 探索收敛、反思和结束提示 | full / inherited |
| `src/agent/context/exploration/PlanTracker.ts` | 建议性计划匹配、偏离统计与受限重规划 | full / fresh |
| `src/agent/context/exploration/SignalDetector.ts` | 成功工具观察的新信息去重与精确搜索action判定 | full / fresh |
| `src/agent/context/index.ts` | context公开具名barrel | full / fresh |
| `src/agent/context/l4MemoryPackage.ts` | L4结构化记忆包、渲染和摘要覆盖校验 | full / inherited |
| `src/agent/coordination/AgentRunCoordinator.ts` | 跨维度/模块 child 调度、stop-new 取消与结果聚合 | full / inherited |
| `src/agent/domain/index.ts` | 显式聚合/兼容出口；转出本层已有实现，未创建第二条运行链。 | full / inherited |
| `src/agent/evaluation/DurableSemanticReviewRuntime.ts` | 可信 ledger/signing/model bootstrap，Core V5 durable gateway、harvest/物理见证绑定、隔离 provider 调用、取消超时与不可重用回执。 | full / inherited |
| `src/agent/evaluation/IndependentValueReviewer.ts` | 冻结证据六轴独立价值评审，引用和轴配对校验、narrow/pass/reject，保留现有身份/跨仓G2兼容缺口。 | full / inherited |
| `src/agent/evaluation/InvestigatedEmptyReviewer.ts` | 零产出终态委托 Core execution-denominator + KnowledgeDispositionReview，构造身份仅兼容不授 authority。 | full / inherited |
| `src/agent/evaluation/MiningJudge.ts` | 离线四轴 refute-first judge，项目内声明范围重切、citation校验、30样本/负例/覆盖率/kappa校准和模型加载回执。 | full / inherited |
| `src/agent/evaluation/StrictProductionFixtureEvaluation.ts` | 无网络 frozen-fixture 源字节/hash 驱动评估链；明确冻结输出来测 wiring，不证明真实模型质量。 | full / inherited |
| `src/agent/evaluation/analysisArtifact.ts` | legacy 分析正文清理、证据/真实 memory finding 合并、受限根内锚点补读、质量分与 PCV 的上游工件。 | full / inherited |
| `src/agent/evaluation/gateEvaluators.ts` | 分析/进化/producer 的确定性门判断 | full / inherited |
| `src/agent/evaluation/index.ts` | 显式聚合/兼容出口；转出本层已有实现，未创建第二条运行链。 | full / inherited |
| `src/agent/evaluation/qualityGates.ts` | 四维分数与候选/分析阈值、Core findings 底线、record_repair/summary_rewrite/analysis_retry/degrade 路由及深度接地。 | full / inherited |
| `src/agent/evaluation/stageBuilders.ts` | Scan/Relation 管线阶段装配与阶段提示 | full / inherited |
| `src/agent/evidence/EvidenceCapture.ts` | 证据类工具回执落账及 E-n 标注；连续 N／ 解析、partial 搜索命中保留、空证据跳过、secret-bearing 丢 range。 | full / inherited |
| `src/agent/evidence/EvidenceCollector.ts` | legacy Analyst 工具轨迹萃取：32k字符片段预算、每文件3片、30行，准确负空间、graph引用、按 finding 锚点补读。 | full / inherited |
| `src/agent/evidence/EvidenceLedgerStore.ts` | JSONL 证据、profile、原文freshness摘要与完整性门 | full / inherited |
| `src/agent/evidence/ProductionEvidenceLedgerAuthority.ts` | 可信坐标生产台账authority与固定profile接线 | full / inherited |
| `src/agent/evidence/evidenceFileClass.ts` | secret-bearing/source/config 来源分类数据表；只用于回读资格，不替代路径安全或内容脱敏。 | full / inherited |
| `src/agent/evidence/loopLedger.ts` | 每reactLoop按job/dimension打开生产证据并按需seed | full / inherited |
| `src/agent/evidence/witnessGate.ts` | 逐字见证写盘前拒绝策略：1MiB、UTF-8往返/U+FFFD、固定高置信 token/JWT/PEM 子集，不改写内容。 | full / inherited |
| `src/agent/index.ts` | Agent公共聚合入口 | full / inherited |
| `src/agent/memory/ActiveContext.ts` | scope工作记忆、观察台账、scratchpad及一次性计划授权 | full / fresh |
| `src/agent/memory/EpisodicConsolidator.ts` | 会话报告/反思到持久候选的提取 | full / inherited |
| `src/agent/memory/MemoryConsolidator.ts` | SQLite记忆固化事务、词法冲突判别与来源合并 | full / fresh |
| `src/agent/memory/MemoryCoordinator.ts` | scope管理、请求私有预算、动态prompt及会话证据代理 | full / fresh |
| `src/agent/memory/MemoryEmbeddingStore.ts` | 带profile/contentHash的向量sidecar | full / inherited |
| `src/agent/memory/MemoryFlushContract.ts` | ActiveContext.distill返回的可序列化DTO | full / fresh |
| `src/agent/memory/MemoryPrompt.ts` | 三类模式预算与持久读取边界 | full / inherited |
| `src/agent/memory/MemoryReadPolicy.ts` | 5秒默认记忆读取deadline/降级诊断 | full / inherited |
| `src/agent/memory/MemoryRetriever.ts` | 混合检索、prompt投影与向量回填 | full / inherited |
| `src/agent/memory/MemoryStore.ts` | Core semantic schema上的SQL CRUD及相似度 | full / inherited |
| `src/agent/memory/PersistentMemory.ts` | MemoryStore/Retriever/Consolidator门面与Core公开数据库端口 | full / fresh |
| `src/agent/memory/SessionStore.ts` | 会话报告、派生证据/交叉引用、digest/反思与快照 | full / fresh |
| `src/agent/memory/SessionStoreSchema.ts` | 快照严格验证与AI单项宽容归一的共同shape边界 | full / fresh |
| `src/agent/memory/index.ts` | memory公开具名barrel | full / fresh |
| `src/agent/policies/BudgetPolicy.ts` | 运行级轮次、时长和累计input策略 | full / fresh |
| `src/agent/policies/Policy.ts` | 同步三阶段策略合同与默认放行基类 | full / fresh |
| `src/agent/policies/PolicyEngine.ts` | 同步策略顺序与工具安全组合 | full / fresh |
| `src/agent/policies/QualityGatePolicy.ts` | 显式注入时的运行级阈值质量提示 | full / fresh |
| `src/agent/policies/SafetyPolicy.ts` | 发送者、命令、词法路径与审批配置 | full / fresh |
| `src/agent/policies/index.ts` | 策略公开转发 | full / inherited |
| `src/agent/production/StrictProductionPipeline.ts` | strict 私有聚合入口，重导出 analysisLoop/analyst/expressions/gates/lineage，未复制 Core 实现。 | full / inherited |
| `src/agent/production/StrictProductionPrompts.ts` | 严格 Analyst/Producer JSON 输出契约单源：模型提案、host-owned、host-sealed、neverEmit；仅当前 population 全量内联。 | full / inherited |
| `src/agent/production/StrictProductionStages.ts` | strict analyze→G1→produce→G2，无工具；有界 epoch 端口、扩展登记差集校验、pass 后 seal、异常分类拒绝。 | full / inherited |
| `src/agent/production/strict/analysisLoop.ts` | 不可变上下文和 epoch/snapshot/outcome 哈希；append-only retry 进展守恒；Core expansion receipt 登记与最终日程封口。 | full / inherited |
| `src/agent/production/strict/analyst.ts` | 宿主事实/执行 authority+模型提案+独立审查合并，交 Core canonical population/cluster/induction/falsification，生成可复核 epoch/fixpoint。 | full / inherited |
| `src/agent/production/strict/expressions.ts` | strict表达式提案归一、哈希、证据与作者指纹 | full / inherited |
| `src/agent/production/strict/gates.ts` | Core typed gate return 适配与 strict Analyst/Producer 工具回执禁权校验。 | full / inherited |
| `src/agent/production/strict/lineage.ts` | epoch/fixpoint/frozen evidence 对账派生 knowledgeRootId/lineage；因果修复节点与跨进程完整性重建。 | full / inherited |
| `src/agent/production/strict/primitives.ts` | 严格链 ID集合、必填文本/hash、错误、递归冻结与两种历史兼容 canonical hash。 | full / inherited |
| `src/agent/profiles/AgentProfileCompiler.ts` | 声明引用/override到运行装配配置的编译器 | full / fresh |
| `src/agent/profiles/AgentProfileRegistry.ts` | 持有声明快照；拒绝函数、Set/Map、RegExp、Date、非有限数等非 JSON 声明，读写不共享可变对象。 | full / inherited |
| `src/agent/profiles/AgentStageFactoryRegistry.ts` | 命名stage工厂与独立数据副本 | full / fresh |
| `src/agent/profiles/definitions/evolution.profile.ts` | evolution-audit 声明与 recipe 数驱动预算单源；首轮加两次重试总期限覆盖 stage 窗口。 | full / inherited |
| `src/agent/profiles/definitions/generate.profile.ts` | generate父子声明 | full / fresh |
| `src/agent/profiles/definitions/index.ts` | 把8组 profile 声明组合为 BUILTIN_PROFILES，含待退役 signal 和实验性扇出。 | full / inherited |
| `src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.ts` | 模块挖掘父子声明 | full / fresh |
| `src/agent/profiles/definitions/plan.profile.ts` | plan-selection 的无能力 single profile；persona 由 Core renderPlanPersonaDescription 单源生成。 | full / inherited |
| `src/agent/profiles/definitions/relation.profile.ts` | 只读 relation_exploration profile；两阶段预算总期限 540s。 | full / inherited |
| `src/agent/profiles/definitions/scan.profile.ts` | scan-extract/scan-summarize 声明；共同 analyze 运行默认值与 scanPipeline 工厂。 | full / inherited |
| `src/agent/profiles/definitions/signal.profile.ts` | 保留 signal-analysis 公开兼容声明；目前无生产入口、auto 模式关联未注册工具。 | full / inherited |
| `src/agent/profiles/definitions/translation.profile.ts` | translation-json 无能力 single profile；一轮 JSON 翻译与英文目标 persona。 | full / inherited |
| `src/agent/profiles/index.ts` | 显式聚合/兼容出口；转出本层已有实现，未创建第二条运行链。 | full / inherited |
| `src/agent/profiles/presets/chatPreset.ts` | chat运行基块 | full / fresh |
| `src/agent/profiles/presets/evolutionPreset.ts` | evolve→evolution_gate 默认块；补写重试仅 knowledge.manage 决策，不重做探索。 | full / inherited |
| `src/agent/profiles/presets/index.ts` | 冻结preset目录与独立装配副本 | full / fresh |
| `src/agent/profiles/presets/insightPreset.ts` | 分析→质量门→生产→拒绝门运行基块 | full / fresh |
| `src/agent/profiles/presets/types.ts` | preset与运行策略类型边界 | full / fresh |
| `src/agent/prompts/index.ts` | 提示/门函数公开barrel | full / inherited |
| `src/agent/prompts/insightAnalyst.ts` | 分析系统提示、项目/模块预算估算与记忆背景装配 | full / inherited |
| `src/agent/prompts/insightEvolver.ts` | 现有Recipe进化核验prompt | full / inherited |
| `src/agent/prompts/insightGate.ts` | 质量门失败后的定向修复prompt | full / inherited |
| `src/agent/prompts/insightProducer.ts` | 生产系统提示、artifact→候选提示和修复提示 | full / inherited |
| `src/agent/prompts/producerFindings.ts` | 结构化finding展示 | full / inherited |
| `src/agent/prompts/producerRetry.ts` | 提交字段合同与硬门/风格建议单源 | full / inherited |
| `src/agent/prompts/scanPrompts.ts` | extract/summarize扫描生产策略prompt | full / inherited |
| `src/agent/runs/evolution/EvolutionAgentRun.ts` | 对非空待审 recipe 集运行 evolution-audit，按唯一期望 ID 校验每条成功决策，统计 proposal/deprecated/verified。 | full / inherited |
| `src/agent/runs/index.ts` | 显式聚合/兼容出口；转出本层已有实现，未创建第二条运行链。 | full / inherited |
| `src/agent/runs/module-mining/ModuleContextAssembler.ts` | 纯函数模块导航图谱、共同父目录分组、40 文件展示上限与超过60文件的目录贪心分箱。 | full / inherited |
| `src/agent/runs/module-mining/ScopedModuleMiningAgentRun.ts` | 选模块、规模封顶、超大模块拆分、contextMap 与动态 analyst 预算附着，交 coordinator，失败保留子结果。 | full / inherited |
| `src/agent/runs/plan/PlanAgentRun.ts` | legacy PlanSelection 解析验证与 strict Plan 冻结上下文/0..2 次因果修复；只修模型可修复结构/语义，Core 决定计划是否合法。 | full / inherited |
| `src/agent/runs/relation/RelationAgentRun.ts` | 两阶段只读关系发现后解析 JSON；非成功抛 partialResult，解析失败按既有决定回退零关系。 | full / inherited |
| `src/agent/runs/result.ts` | runFailure 构造带原始结果 cause/partialResult 的 Error，失败不抹掉已确认副作用。 | full / inherited |
| `src/agent/runs/scan/ScanAgentRun.ts` | 校验 extract/summarize，预装 fileCache 与系统 scope，运行服务后转扫描业务结果。 | full / inherited |
| `src/agent/runs/scan/ScanRunProjection.ts` | 只从已持久化 knowledge.submit created 回执抽取 Recipe；零持久化返回任务 fallback 和明确诊断。 | full / inherited |
| `src/agent/runs/systemTaskRunInput.ts` | 六类系统 run 共用 Input 装配；信号按需透传，未传信号保持历史键形状，fanout 期限为每 child。 | full / inherited |
| `src/agent/runs/translation/TranslationAgentRun.ts` | 无工具翻译运行；非成功返回原文/error；JSON 解析恢复、缺字段回退与旁路诊断。 | full / inherited |
| `src/agent/runtime/AgentEventBus.ts` | 单向带元信息广播；不拥有请求/应答或执行状态 | full / fresh |
| `src/agent/runtime/AgentExecutionTimeoutError.ts` | 运行超时错误与 owner 绑定的失败快照 | full / inherited |
| `src/agent/runtime/AgentInterfaceContract.ts` | 冻结的分支/普通输出/失败分类 manifest | full / inherited |
| `src/agent/runtime/AgentMessage.ts` | 宿主已鉴权输入的消息信封；无渠道工厂或replyFn | full / fresh |
| `src/agent/runtime/AgentRuntime.ts` | ReAct编排主体，拥有执行边界、私有阶段、预算/工具/证据接线 | full / fresh |
| `src/agent/runtime/AgentRuntimeBoundary.ts` | Agent/Core/Host 所有权与不支持路由 | full / inherited |
| `src/agent/runtime/AgentRuntimeResponsibility.ts` | 可检索的职责/语义/环境变量清单，不执行策略 | full / fresh |
| `src/agent/runtime/AgentRuntimeTypes.ts` | Runtime输入/结果、事件、诊断及工具元数据合同单源 | full / fresh |
| `src/agent/runtime/AgentState.ts` | 独立保留的同步状态机（不是Runtime当前phase实现） | full / fresh |
| `src/agent/runtime/AnalyzeGroundingGuard.ts` | 可选 analyze 文本 grounding 阻断 | full / inherited |
| `src/agent/runtime/BudgetController.ts` | 每reactLoop的阶段input压力、压缩和工具展示配额 | full / fresh |
| `src/agent/runtime/DiagnosticsCollector.ts` | 可合并的诊断/效率副本 | full / fresh |
| `src/agent/runtime/ExitController.ts` | 三个已接线检查点与保留的独立公开判定 | full / fresh |
| `src/agent/runtime/HookSystem.ts` | 按优先级顺序执行可阻断钩子；仅before的false阻断 | full / fresh |
| `src/agent/runtime/LLMInputAssembly.ts` | 六节输入装配和阶段投影 | full / inherited |
| `src/agent/runtime/LLMInputMeasurement.ts` | 完整请求的本地 token/重复块估算 | full / inherited |
| `src/agent/runtime/LLMResultType.ts` | LLM循环控制标识 | full / inherited |
| `src/agent/runtime/LoopContext.ts` | 一次reactLoop的可变状态与注入依赖；只管理loop级账本 | full / fresh |
| `src/agent/runtime/MessageAdapter.ts` | ContextWindow/简单数组两种历史接口 | full / inherited |
| `src/agent/runtime/PcvNodeEvidenceRecorder.ts` | 节点证据归因与可序列化观察摘要；不拥有质量决策或独立持久化 | full / fresh |
| `src/agent/runtime/ProviderToolChoicePolicy.ts` | provider差异下的工具可见性决策 | full / inherited |
| `src/agent/runtime/SystemPromptBuilder.ts` | 稳定系统提示与宿主可用工具说明 | full / fresh |
| `src/agent/runtime/SystemRunContext.ts` | 系统运行资源的共同投影 | full / inherited |
| `src/agent/runtime/ToolExecutionPipeline.ts` | 默认中间件组合根与可手工use的执行类 | full / fresh |
| `src/agent/runtime/finalAnswer.ts` | 清除已登记nudge回显 | full / inherited |
| `src/agent/runtime/forcedSummary.ts` | 统一有界回执摘要 | full / inherited |
| `src/agent/runtime/index.ts` | runtime包公开聚合入口；保留的独立合同不等于当前运行依赖 | full / fresh |
| `src/agent/runtime/llmInput.ts` | 工具策略与provider输入预算 | full / inherited |
| `src/agent/runtime/processEvents.ts` | 开发者可见过程事件纯投影 | full / inherited |
| `src/agent/runtime/toolPipeline/accessGates.ts` | 动作白名单、参数大小与安全策略 | full / inherited |
| `src/agent/runtime/toolPipeline/callNormalization.ts` | 工具字段与note_finding兼容翻译 | full / inherited |
| `src/agent/runtime/toolPipeline/contracts.ts` | 中间件前置判定、元数据与执行端口类型边界 | full / fresh |
| `src/agent/runtime/toolPipeline/duplicateCache.ts` | 在真实项目快照与策略上下文内复用合格只读工具结果；是默认管道的确定性重复短路，不是SessionStore工具缓存或通用文件缓存。 | full / inherited |
| `src/agent/runtime/toolPipeline/engine.ts` | 正序before/executor/after及失败回执按身份保管 | full / fresh |
| `src/agent/runtime/toolPipeline/observations.ts` | 工具返回后的证据采集、tracker信号与trace记录 | full / fresh |
| `src/agent/runtime/toolPipeline/phaseGates.ts` | Evolution/record-only/VERIFY/Producer动作级准入 | full / fresh |
| `src/agent/runtime/toolPipeline/runtimeBridge.ts` | 模型工具到宿主ToolRouterContract的请求/结果唯一投影 | full / fresh |
| `src/agent/runtime/toolPipeline/submissionLedger.ts` | 已持久化提交的去重与Producer台账 | full / inherited |
| `src/agent/runtime/toolReceipt.ts` | 回执身份保存与模型显示配额 | full / inherited |
| `src/agent/service/AgentRunContracts.ts` | Service/Compiler/Builder/Runtime间的公开数据合同 | full / fresh |
| `src/agent/service/AgentRuntimeBuilder.ts` | 每次构建新Capability/Strategy/Runtime的宿主装配 | full / fresh |
| `src/agent/service/AgentService.ts` | 校验与编译入口，选择协调或单 Runtime；有界取消预检、剩余期限、消息投影、结果状态归类及恢复超时诊断投影。 | full / inherited |
| `src/agent/service/SystemRunContextFactory.ts` | 系统运行独立上下文资源工厂 | full / fresh |
| `src/agent/service/index.ts` | 显式聚合/兼容出口；转出本层已有实现，未创建第二条运行链。 | full / inherited |
| `src/agent/strategies/PipelineStrategy.ts` | 阶段执行、门重试/补写、strict transition与结果投影 | full / inherited |
| `src/agent/strategies/SingleStrategy.ts` | 把消息、history、metadata context 与显式 options 委托 reactLoop。 | full / inherited |
| `src/agent/strategies/Strategy.ts` | 单Runtime策略最小契约 | full / inherited |
| `src/agent/strategies/index.ts` | 内部策略barrel | full / inherited |
| `src/agent/strategies/pipeline/attempt.ts` | 阶段准备和 reactLoop 共享截止时间；记录实际工具开始/完成，保留部分回执并标注 requiresReadback，关闭迟到观察入口。 | full / inherited |
| `src/agent/strategies/pipeline/contracts.ts` | PipelineRuntime 可选观察面与 StageResult 部分执行证据；未知 startedToolCalls 用 null 表示。 | full / inherited |
| `src/agent/tasks/AgentTaskHandlers.ts` | 待退役 ./tasks 的5个 DAG 包装器，工具 envelope 白名单与私有字段清理；4类工具不存在，关系发现有替代 run。 | full / inherited |
| `src/agent/tasks/index.ts` | 显式聚合/兼容出口；转出本层已有实现，未创建第二条运行链。 | full / inherited |
| `src/agent/utils/Redaction.ts` | 开发者未知来源与台账带来源的纯函数门面 | full / inherited |
| `src/agent/utils/jsonReply.ts` | 模型JSON对象回复级联解析 | full / inherited |
| `src/agent/utils/redaction/detectors.ts` | 14条T1凭据格式检测与本次调用的扫描索引 | full / inherited |
| `src/agent/utils/redaction/frozenBaselines.ts` | 四代历史规则冻结实现 | full / inherited |
| `src/agent/utils/redaction/hiddenSpans.ts` | 黑盒历史规则对齐与保守遮蔽集合oracle | full / inherited |
| `src/agent/utils/redaction/legacyFloor.ts` | 四冻结版本遮蔽并集、T1/T3挂点、不动点与fail-closed | full / inherited |
| `src/agent/utils/redaction/render.ts` | 按位置渲染遮蔽区间与结构/marker保真 | full / inherited |
| `src/agent/utils/redaction/sourcePolicy.ts` | 默认台账的来源感知T3增量遮蔽 | full / inherited |
| `src/agent/utils/redaction/trackedReplay.ts` | 冻结规则的带来源重放与结构字符定位 | full / inherited |
| `src/agent/utils/toolOutcomes.ts` | 工具业务回执语义单源 | full / inherited |
| `src/ai/AiFactory.ts` | Provider身份工厂与唯一provider fallback链 | full / inherited |
| `src/ai/AiProvider.ts` | 公开Provider门面与用量通知、私有业务/探针Gateway | full / inherited |
| `src/ai/AiProviderManager.ts` | 生成模型路由同步、补偿与用量绑定 | full / inherited |
| `src/ai/configuration.ts` | 统一环境、别名、模型与连接解析 | full / inherited |
| `src/ai/contracts.ts` | Provider/Gateway/Transport共用AI DTO | full / inherited |
| `src/ai/deepseekToolCallCompat.ts` | DeepSeek 显式 XML 工具声明兼容解析 | full / inherited |
| `src/ai/errors.ts` | 缺 key、HTTP、取消和非法模型输出错误 | full / inherited |
| `src/ai/gateway/LLMGateway.ts` | 模型解析、参数guard与每provider可靠性网关 | full / inherited |
| `src/ai/gateway/index.ts` | Gateway公开再导出 | full / inherited |
| `src/ai/guard/ParameterGuard.ts` | 模型参数 allow/deny 与数值钳制 | full / inherited |
| `src/ai/index.ts` | AI 包子路径出口 | full / inherited |
| `src/ai/management/ProviderUsageTracker.ts` | 请求级用量归属和单回调槽订阅 | full / inherited |
| `src/ai/management/contracts.ts` | Manager路由与计量的最小结构合同 | full / inherited |
| `src/ai/providers/ClaudeProvider.ts` | 固定Provider身份/配置、协议与可靠性委托门面 | full / inherited |
| `src/ai/providers/DeepSeekProvider.ts` | 固定Provider身份/配置、协议与可靠性委托门面 | full / inherited |
| `src/ai/providers/GoogleGeminiProvider.ts` | 固定Provider身份/配置、协议与可靠性委托门面 | full / inherited |
| `src/ai/providers/OllamaProvider.ts` | 固定Provider身份/配置、协议与可靠性委托门面 | full / inherited |
| `src/ai/providers/OpenAiProvider.ts` | 固定Provider身份/配置、协议与可靠性委托门面 | full / inherited |
| `src/ai/registry/ModelDefs.ts` | 模型能力和参数限制声明类型 | full / inherited |
| `src/ai/registry/ModelQuirks.ts` | 模型兼容策略查询 | full / inherited |
| `src/ai/registry/ModelRegistry.ts` | 模型能力与参数约束数据注册表 | full / inherited |
| `src/ai/registry/ProviderConfig.ts` | Provider 默认模型/endpoint/环境变量表 | full / inherited |
| `src/ai/registry/models/claude.ts` | claude模型声明数据 | full / inherited |
| `src/ai/registry/models/deepseek.ts` | deepseek模型声明数据 | full / inherited |
| `src/ai/registry/models/google.ts` | google模型声明数据 | full / inherited |
| `src/ai/registry/models/ollama.ts` | ollama模型声明数据 | full / inherited |
| `src/ai/registry/models/openai.ts` | openai模型声明数据 | full / inherited |
| `src/ai/shared/concurrency.ts` | 并发容量统一解析 | full / inherited |
| `src/ai/shared/errorClassify.ts` | 纯错误分类 | full / inherited |
| `src/ai/shared/reliability.ts` | provider并发、退避、限流和熔断 | full / inherited |
| `src/ai/shared/schemaValidation.ts` | Ajv方言编译缓存和严格结构化校验 | full / inherited |
| `src/ai/shared/structuredOutput.ts` | 结构化提取兼容出口 | full / inherited |
| `src/ai/toolTranscript.ts` | 工具历史闭环归一 | full / inherited |
| `src/ai/transport/ClaudeTransport.ts` | 单次厂商协议转换与回执归一 | full / inherited |
| `src/ai/transport/DeepSeekTransport.ts` | 单次厂商协议转换与回执归一 | full / inherited |
| `src/ai/transport/GoogleTransport.ts` | 单次厂商协议转换与回执归一 | full / inherited |
| `src/ai/transport/LLMTransport.ts` | 单次请求期限/取消、代理与底层HTTP生命周期 | full / inherited |
| `src/ai/transport/OpenAiTransport.ts` | 单次厂商协议转换与回执归一 | full / inherited |
| `src/ai/transport/index.ts` | Transport公开出口 | full / inherited |
| `src/ai/transport/sdkContext.ts` | 连接身份及消息投影哈希 | full / inherited |
| `src/ai/transport/sdkContinuation.ts` | 原生reasoning/签名捕获与回放 | full / inherited |
| `src/ai/transport/sdkErrors.ts` | SDK错误安全投影 | full / inherited |
| `src/ai/transport/sdkProtocol.ts` | SDK协议输入输出归一 | full / inherited |
| `src/evaluation.ts` | 独立reviewer与冻结证据投影公开子路径 | full / inherited |
| `src/index.ts` | 显式聚合/兼容出口；转出本层已有实现，未创建第二条运行链。 | full / inherited |
| `src/production.ts` | 公开 production facade：durable review、真实 ledger factory、严格认知与表达合同。 | full / inherited |
| `src/runs.ts` | 公开 strict Plan 专用 facade，避免依赖内部 runs 目录。 | full / inherited |
| `src/shared/concurrency.ts` | 通用有限并发FIFO | full / inherited |
| `src/shared/observers.ts` | 同步/异步观察者隔离 | full / inherited |
| `src/shared/operation.ts` | 单次异步操作deadline/取消终态 | full / inherited |
| `src/shared/packageAssets.ts` | 按需定位Agent包根 | full / inherited |
| `src/shared/projectPath.ts` | 文件端口词法+真实路径双重约束 | full / inherited |
| `src/shared/serialization.ts` | 会话缓存稳定序列化 | full / inherited |
| `src/shared/structuredOutput.ts` | 无schema JSON提取/数组恢复 | full / inherited |
| `src/shared/tokenUtils.ts` | 共享粗略token估算和Unicode安全截断 | full / inherited |
| `src/tools/catalog/CapabilityCatalog.ts` | manifest存储及通用flat schema投影 | full / inherited |
| `src/tools/catalog/CapabilityManifest.ts` | kernel manifest 的旧路径类型转发 | full / inherited |
| `src/tools/catalog/UnifiedToolCatalog.ts` | 继承CapabilityCatalog的manifest存储名 | full / inherited |
| `src/tools/catalog/schemaQuery.ts` | 现代/旧 schema 查询入口与 fail-closed 输出收窄 | full / inherited |
| `src/tools/index.ts` | 工具聚合barrel | full / inherited |
| `src/tools/kernel/availability.ts` | 宿主动作/参数可用性快照合同 | full / inherited |
| `src/tools/kernel/context.ts` | 工具调用身份、活动资源和宿主服务定位合同 | full / inherited |
| `src/tools/kernel/decision.ts` | 工具准入决策类型 | full / inherited |
| `src/tools/kernel/index.ts` | 包内kernel单源barrel | full / inherited |
| `src/tools/kernel/knowledge.ts` | 知识读取、检索 DTO、管理端口 | full / inherited |
| `src/tools/kernel/manifest.ts` | 可序列化能力描述而非执行器 | full / inherited |
| `src/tools/kernel/presenter.ts` | 普通输出 text 投影与信封数据形状守卫 | full / inherited |
| `src/tools/kernel/registry.ts` | ToolAction/ToolContext与graph宿主读取映射 | full / inherited |
| `src/tools/kernel/request.ts` | ToolCallRequest与最小router contract | full / inherited |
| `src/tools/kernel/result.ts` | 稳定结果信封、JSON 安全化、D23 字段清理与显示预算 | full / inherited |
| `src/tools/kernel/toolSchema.ts` | schema 查询、selection 与 action allowlist 合同 | full / inherited |
| `src/tools/kernel/toolSelection.ts` | 快照、归一、交集、动作/参数权限单一算法 | full / inherited |
| `src/tools/runtime/adapter/RuntimeCapabilityCatalog.ts` | 基于当前接线与选择集查询 schema 和 allowedTools | full / inherited |
| `src/tools/runtime/adapter/ToolRouterAdapter.ts` | ToolRouterContract 实现、context factory、稳定信封与 trust 派生 | full / inherited |
| `src/tools/runtime/adapter/index.ts` | adapter 公开转发 | full / inherited |
| `src/tools/runtime/admission.ts` | 准入拒绝的标准 data/状态/诊断 | full / inherited |
| `src/tools/runtime/availability.ts` | 无副作用宿主接线事实投影 | full / inherited |
| `src/tools/runtime/cache/DeltaCache.ts` | 完整可见基线/指纹分离、行 LCS delta、写前 freshness 与容量控制 | full / inherited |
| `src/tools/runtime/cache/SearchCache.ts` | 有界LRU搜索缓存 | full / inherited |
| `src/tools/runtime/cache/index.ts` | 缓存公开转发 | full / inherited |
| `src/tools/runtime/compressor/OutputCompressor.ts` | 按命令加载 strict parser；stderr 保留；泛型回退/预算裁剪 | full / inherited |
| `src/tools/runtime/compressor/index.ts` | 压缩器公开转发 | full / inherited |
| `src/tools/runtime/compressor/parsers/GitDiffParser.ts` | 完整 hunk 完整性校验与 diff/stat 概要 | full / inherited |
| `src/tools/runtime/compressor/parsers/GitLogParser.ts` | 完整/单行提交日志归一及20条上限 | full / inherited |
| `src/tools/runtime/compressor/parsers/GitStatusParser.ts` | porcelain/human 状态分类与冲突保护 | full / inherited |
| `src/tools/runtime/compressor/parsers/GrepParser.ts` | rg JSON/普通匹配输出解析、去重、30条展示 | full / inherited |
| `src/tools/runtime/compressor/parsers/LintOutputParser.ts` | ESLint/tsc 诊断摘要、10条上限与数量一致性 | full / inherited |
| `src/tools/runtime/compressor/parsers/PackageParser.ts` | npm/pnpm 安装摘要、警告/漏洞保留与失败回退 | full / inherited |
| `src/tools/runtime/compressor/parsers/TestOutputParser.ts` | Vitest/Jest/Pytest/Mocha 汇总及失败详情完整性检查 | full / inherited |
| `src/tools/runtime/compressor/parsers/TreeParser.ts` | tree/find/ls-R 转树；显式目标禁用忽略过滤 | full / inherited |
| `src/tools/runtime/compressor/parsers/index.ts` | 8 个 parser 的兼容入口 | full / inherited |
| `src/tools/runtime/compressor/strip.ts` | ANSI 清除、重复行压缩与 Unicode 边界头尾截断 | full / inherited |
| `src/tools/runtime/handlers/code.ts` | 代码搜索、版本视图读取、宿主大纲适配、目录树及受保护写入真实handler | full / fresh |
| `src/tools/runtime/handlers/evidence.ts` | 证据 ref/子区间判错、台账检索及 fresh 源码逐字回读 | full / inherited |
| `src/tools/runtime/handlers/graph.ts` | 按单一宿主方法编排graph只读查询 | full / inherited |
| `src/tools/runtime/handlers/knowledge.ts` | knowledge 动作分发与入口取消门 | full / inherited |
| `src/tools/runtime/handlers/knowledge/authoring.ts` | submit前证据/权威门禁/有限风格修复 | full / inherited |
| `src/tools/runtime/handlers/knowledge/contracts.ts` | Core RecipeProductionPort 别名及来源/维度合同 | full / inherited |
| `src/tools/runtime/handlers/knowledge/input.ts` | 提交和管理参数验证、维度注入、review queue limit 策略 | full / inherited |
| `src/tools/runtime/handlers/knowledge/management.ts` | Core 发布/复核/普通管理/进化提案与不确定写回执 | full / inherited |
| `src/tools/runtime/handlers/knowledge/operation.ts` | 写前取消、已确认写后取消诊断与安全观察日志 | full / inherited |
| `src/tools/runtime/handlers/knowledge/queries.ts` | 知识search/prime/detail有界投影 | full / inherited |
| `src/tools/runtime/handlers/knowledge/sessionState.ts` | 跨阶段共享submit计数盒 | full / inherited |
| `src/tools/runtime/handlers/knowledge/sourceRange.ts` | 统一本项目有界源文件/行区间解析，拒绝 symlink 越界 | full / inherited |
| `src/tools/runtime/handlers/knowledge/sources.ts` | bare refs 接地、snippet 修复提示与 prepared item gate | full / inherited |
| `src/tools/runtime/handlers/knowledge/submission.ts` | 完整提交编排到 Core createOrStage 单入口 | full / inherited |
| `src/tools/runtime/handlers/knowledge/submissionResult.ts` | Core outcome 分类、提交已持久化回执与后置降级保护 | full / inherited |
| `src/tools/runtime/handlers/memory.ts` | session save/recall、台账引用校验后 note_finding、前序证据 | full / inherited |
| `src/tools/runtime/handlers/meta.ts` | 受限 schema 自省、计划存储、提交摘要复核 | full / inherited |
| `src/tools/runtime/handlers/recipeAuthoringGate.ts` | Agent 文件范围解析适配 Core authoring gate | full / inherited |
| `src/tools/runtime/handlers/recipeProductionAdapter.ts` | Agent稿件到Core公开production DTO准备 | full / inherited |
| `src/tools/runtime/handlers/searchCacheGeneration.ts` | 按SearchCache对象身份记录弱引用失效代数；无mtime/TTL与clear接口 | full / inherited |
| `src/tools/runtime/handlers/submitEvidenceExpansion.ts` | 证据展开/新鲜度/来源修正/风格 repair 及候选提示 | full / inherited |
| `src/tools/runtime/handlers/terminal.ts` | terminal.exec的Agent侧准入、宿主执行适配、回执归一和审计；不是实际sandbox实现 | full / inherited |
| `src/tools/runtime/handlers/terminalSafety.ts` | 终端黑名单、保守shell词法与归属/输出流判定、Evolution只读allowlist | full / fresh |
| `src/tools/runtime/index.ts` | runtime公开聚合出口 | full / inherited |
| `src/tools/runtime/parameters.ts` | Ajv 执行参数校验、64 项 schema 缓存和维度变体 | full / inherited |
| `src/tools/runtime/recipeProductionContract.ts` | 知识生产检索 profile 与 bounded coreCode 提示合同 | full / inherited |
| `src/tools/runtime/registry.ts` | 七类工具动作schema/handler/cache/risk单源声明 | full / inherited |
| `src/tools/runtime/router.ts` | 准入、排队重检、真实handler分发与输出约束 | full / inherited |
| `src/tools/runtime/selection.ts` | 宿主 availability 校验及不可变 registry 视图 | full / inherited |
| `src/tools/runtime/toolsets/Capability.ts` | 能力扩展基类及上下文/步骤钩子 | full / inherited |
| `src/tools/runtime/toolsets/CapabilityRegistry.ts` | 私有按名能力构造表 | full / inherited |
| `src/tools/runtime/toolsets/Conversation.ts` | Conversation capability提供静态生产契约、可选宿主人格SOUL与项目简报，以及对话工具动作集合；不拥有运行级记忆协调器。 | full / inherited |
| `src/tools/runtime/toolsets/Evolution.ts` | 进化工具/operation 收窄、只读取证终端意图 | full / inherited |
| `src/tools/runtime/toolsets/GenerateAnalyze.ts` | 分析阶段探索/证据记录能力与提示 | full / inherited |
| `src/tools/runtime/toolsets/GenerateProduce.ts` | 基于 findings 的只生产能力与证据硬要求 | full / inherited |
| `src/tools/runtime/toolsets/RelationExploration.ts` | 知识关系只读探索能力 | full / inherited |
| `src/tools/runtime/toolsets/RuntimeCapability.ts` | 能力到 kernel Def 与注册表权限摘要转译 | full / inherited |
| `src/tools/runtime/toolsets/ScanAnalyze.ts` | 增量扫描分析与 note_finding 要求 | full / inherited |
| `src/tools/runtime/toolsets/ScanProduce.ts` | 增量生产及证据自救读取通道 | full / inherited |
| `src/tools/runtime/toolsets/index.ts` | 公开能力类barrel | full / inherited |
| `src/tools/workflow/WorkflowRegistry.ts` | workflow 定义注册表；不执行工作流 | full / inherited |
