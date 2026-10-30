---
schemaVersion: 1
diagramId: source-rebase
topic: "00"
title: v5基线复核与退役去向
viewType: guide
truthKind: in-progress-worktree
reviewDepth: L1
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

# v5基线复核与退役去向

v5轮次复核了114个变化／新增源码，176 个源码按相同字节继承 v4；4 个旧源码已删除。每个对象的 SHA、审阅方法、精确旧 blob（可恢复时）、职责、调用链、风险与测试定位保存在 [结构化复核记录](../evidence/reviews/source-rebase-v5.json)。

## 阅读深度与证据边界

v5封存时阅读深度为237 full、53 partial；这是历史审阅口径。当前53项已在后续全文复核中补齐，见[文件索引](file-index.md)。full 中包含精确旧全文＋完整变化累计审阅；partial 完成全部差异与当前受影响边界，不代表重新通读所有未变行。测试标题已定位不代表执行；当前实际通过以运行回执及各页关联为准。

## 退役对象与保留能力

- src/agent/strategies/FanOutStrategy.ts 已删除；AgentRunCoordinator 的 child Service 调度仍保留。
- src/tools/kernel/handler.ts 与 src/tools/kernel/routing.ts 已删除；kernel 中仍有请求、回执、router contract；runtime registry 和 action handlers 继续负责执行。
- src/tools/runtime/toolsets/System.ts 已删除；能力清单以 CapabilityCatalog 与 TOOL_REGISTRY 的当前职责为准。
- replyFn、消息 transport 工厂、checkpoint 便利链已退役；宿主消费 AgentResult.reply，并负责保存 SessionStore 的序列化快照。
- AgentState 作为独立公开类保留；Runtime 只持最小私有 phase，不再消费该类实例。

退役文件使用历史快照查阅；不把删除路径继续作为当前调用边。

## 逐文件复核决定

| 文件 | 本轮方法 | 变更与判断 |
| --- | --- | --- |
| `src/agent/context/ContextWindow.ts` | 完整差异＋当前受影响边界 | CompactionConfig.enableL4LLM 删除，窗口初始关闭，syncL4CompactionSwitch 是唯一设置入口。；MODEL_CONTEXT_WINDOWS 从公开 static 变模块私有 readonly 常量；表内容、顺序和降级算法未变。 |
| `src/agent/context/ConversationStore.ts` | 完整差异＋当前受影响边界 | 删除 list/delete/cleanup/estimateTokens/summarize 与只为摘要服务的 AI 端口及选窗函数。；旧 [对话摘要] 仍可由 load 保留，append 重登记会读取历史推断 hasSummary；现在不会调用模型生成新摘要。 |
| `src/agent/context/ExplorationTracker.ts` | 完整差异＋当前受影响边界 | BudgetInput.signalBus、字段与phase/exit信号发送删除；阶段日志和退出事实仍保留。；getQualityMetrics删除；探索规划进度/指标接口保留。 |
| `src/agent/context/exploration/ExplorationStrategies.ts` | 完整差异＋当前受影响边界 | createGenerateStrategy 源码函数保留供 Tracker.resolve 内部fallback，但已撤出 context/根出口。；ExplorationTrace.ok缺省仍按成功，ActiveContext现有recordToolCall始终写真实回执；外部trace端口仍需保证失败状态。 |
| `src/agent/context/exploration/PlanTracker.ts` | 完整差异＋当前受影响边界 | getQualityMetrics整体删除，原比例加权分数不再可查询；progress/checkPlanning/updatePlanProgress保留。 |
| `src/agent/context/exploration/SignalDetector.ts` | 完整差异＋当前受影响边界 | SEARCH_TOOLS静态粗粒度白名单删除；isSearchAction仍只认code.search/graph.query。 |
| `src/agent/context/index.ts` | 完整差异＋当前受影响边界 | ExplorationStrategies通配重导出改具名列表。；撤出createGenerateStrategy与SEARCH_TOOLS，其他探索类型和isSearchAction保留。 |
| `src/agent/memory/ActiveContext.ts` | 完整差异＋当前受影响边界 | 删除addAction/addObservation/observe；recordToolCall统一写动作、观察与窗口。；删除setPlan/updatePlan等便利读取与静态fromJSON；已有计划更新仍需expectPlan授权及extractAndSetPlan。；lightweight配置/分支删除；每个recordToolCall均计观察并受maxRecentRounds窗口约束。；计划历史只通过toJSON().planHistory数量公开；宿主恢复用SessionStore，scope按维度重建。 |
| `src/agent/memory/MemoryConsolidator.ts` | 完整差异＋当前受影响边界 | 删除migrateFromLegacy、旧JSONL读/rename链和旧类型mapper；保留consolidate与现有事务语义。 |
| `src/agent/memory/MemoryCoordinator.ts` | 完整差异＋当前受影响边界 | 删除extractFromConversation及规则匹配写入PersistentMemory路径；getDiagnostics.writeFailures当前无写入者，恒空。；删除completeDimension/completeSession/checkpoint/restore/dispose/getPersistentMemory；scope随coordinator对象生命周期回收，SessionStore由宿主显式管理。；DimensionScopeConfig.lightweight删除，只剩maxRecentRounds。；buildStaticMemoryPrompt/buildMemoryPrompt及conversationLog/getConversationLog/onConversationUpdated仍保留但非默认消费链；不可一并标已删除。 |
| `src/agent/memory/MemoryFlushContract.ts` | 完整差异＋当前受影响边界 | 仅保留DistilledContext；DimensionFlushManifest与extractHighPriorityFindings删除。；不再有Coordinator.completeDimension的“蒸馏后flush/clear”链。 |
| `src/agent/memory/PersistentMemory.ts` | 完整差异＋当前受影响边界 | 删除migrateFromLegacy转发；其他add/update/append/consolidate/retrieve/embedding入口保留。 |
| `src/agent/memory/SessionStore.ts` | 完整差异＋当前受影响边界 | 删除saveCheckpoint/loadCheckpoint及文件IO、临时写rename链。；删除addEvidence/getEvidenceForFile/buildContextSnapshot/getDistilledForProducer；新证据随storeDimensionReport产生，旧独立证据仍可从快照恢复。；fromJSON验证后新建实例；restoreSnapshot唯一由它调用，不再在已有实例上load恢复。；dispose仍保留；ttlMs/cleanupIntervalMs只告一次debug且不注册timer，getStats.cache仍全零兼容形状。 |
| `src/agent/memory/SessionStoreSchema.ts` | 完整差异＋当前受影响边界 | 实现未变，仅修正注释：loadCheckpoint已删除；宿主快照恢复通过fromJSON。 |
| `src/agent/memory/index.ts` | 完整差异＋当前受影响边界 | 删除DimensionFlushManifest类型和extractHighPriorityFindings值导出；DistilledContext保留为type-only。 |
| `src/agent/policies/BudgetPolicy.ts` | 完整差异＋当前受影响边界 | 删除maxSessionTokens配置/getter/总量校验与budget_session_tokens code。；保留maxSessionInputTokens运行累计校验；阶段未声明该字段的loop会被ExitController屏蔽。；删除applyToConfig。 |
| `src/agent/policies/Policy.ts` | 完整差异＋当前受影响边界 | 删除无消费者applyToConfig配置改写链；before/during/after契约保留。 |
| `src/agent/policies/PolicyEngine.ts` | 完整差异＋当前受影响边界 | PolicyEngine.applyToConfig删除；getBudget不再投影maxSessionTokens。；终端检查文案改为同源规则+custom blacklist，删除旧表叠加说明。 |
| `src/agent/policies/QualityGatePolicy.ts` | 完整差异＋当前受影响边界 | 删除toGateConfig转换入口；类与validateAfter阈值保留。；内置insight仍用Pipeline quality_gate；需要门配置应直接声明GateConfig。 |
| `src/agent/policies/SafetyPolicy.ts` | 完整差异＋当前受影响边界 | 删除公开DANGEROUS_COMMANDS/SAFE_COMMANDS静态表与applyToConfig。；默认不再用位置无关regex误拦rg sudo等；chmod777/dev重定向只由旧表提供的策略层限制删除。 |
| `src/agent/profiles/AgentProfileCompiler.ts` | 完整差异＋当前受影响边界 | 未注册显式id一律拒绝，id恰好等于preset也不回退；调用方必须用{preset}。；fanout模板只剩标记；concurrency必须有非空childProfile/partitioner/merge，旧模板多字段被warn忽略。；maxSessionTokens编译warn说明已删除/忽略，不再建议阶段input压缩阈值等价替代；保留input字段口径说明。 |
| `src/agent/profiles/AgentStageFactoryRegistry.ts` | 完整差异＋当前受影响边界 | _computedBudget合并键由四个改三个：maxIterations/timeoutMs/maxSessionInputTokens；残余maxSessionTokens不读。 |
| `src/agent/profiles/definitions/generate.profile.ts` | 完整差异＋当前受影响边界 | fanout模板仅{type:fanout}；child/partitioner/merge只声明在concurrency。；删除abortPolicy字段，固定stop-new语义：未派发取消，运行中child自行signal收尾。 |
| `src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.ts` | 完整差异＋当前受影响边界 | 同样收敛marker-only fanout与唯一concurrency计划；删除abortPolicy声明。；memory描述块仍保留，enabled:false本来不控制运行记忆。 |
| `src/agent/profiles/presets/chatPreset.ts` | 完整差异＋当前受影响边界 | 仅注释变化：memory.enabled/tiers/mode都无读取者，且memoryMode空传递已删；不再声称mode传给能力。 |
| `src/agent/profiles/presets/index.ts` | 完整差异＋当前受影响边界 | 删除FanOutStrategy import和fan_out分支，未知词汇（含fan_out）构建抛错。；跨维度扇出只经profile.concurrency+Coordinator。 |
| `src/agent/profiles/presets/insightPreset.ts` | 完整差异＋当前受影响边界 | 删除analyze预算maxSessionTokens；input预算仍是阶段内压缩触发。；策略层仍不安装会话input上限，真实终止依maxIterations/timeout与其它门。 |
| `src/agent/profiles/presets/types.ts` | 完整差异＋当前受影响边界 | 删除StrategyMergeResult、itemStrategy/tiers/merge、single/pipeline/fanOut影子字段；fan_out不再合法实现。 |
| `src/agent/runtime/AgentEventBus.ts` | 完整差异＋当前受影响边界 | 删除subscribe/request与pending应答表；target/correlationId仅信封标签，不再驱动定向/RPC。；删除8个从未发布事件常量；getStats只剩totalEvents。；resetInstance移除监听并换单例，不再取消pending RPC。 |
| `src/agent/runtime/AgentMessage.ts` | 完整差异＋当前受影响边界 | 删除fromHttp/fromCli/fromMcp与request DTO、replyFn、reply方法。；internal metadata显式字段优先合并保留，Channel全部键保留。；Runtime不回写transport，宿主自行投递结果。 |
| `src/agent/runtime/AgentRuntime.ts` | 完整差异＋当前受影响边界 | Runtime不再import/持有AgentState；私有phase idle/executing/completed/failed/aborted，返回state只含phase；重复execute重置idle。；router仅显式toolRouter或container.get(toolRouter)，不调用registry.getRouter。；memoryConfig与replyFn回写链删除；系统提示不传memoryMode，回复由宿主投递。；PROVIDER_CONTRACT_VIOLATION非取消时单次runtime_defect、degraded、无ai_error/重试/强制摘要；取消优先。；每Runtime持有EvidenceSourceDigestTable供各reactLoop store共享原文摘要；跨Runtime/进程不共享。 |
| `src/agent/runtime/AgentRuntimeResponsibility.ts` | 完整差异＋当前受影响边界 | apiResponseBoundary.allowedAccessRefs从AiProvider切到LLMTransport/sdkProtocol；未归一厂商响应仅transport-private。 |
| `src/agent/runtime/AgentRuntimeTypes.ts` | 完整差异＋当前受影响边界 | RuntimeConfig.toolRegistry收窄Pick<CapabilityCatalog,has／getManifest>；仍必填但不供schema/router。；删除RuntimeConfig.memory；AgentResult.state从宽Record收窄只含phase联合。 |
| `src/agent/runtime/AgentState.ts` | 完整差异＋当前受影响边界 | 实现未改，仅toJSON注释修正与Runtime解耦；文件和公开AgentPhase/AgentState导出仍存在。 |
| `src/agent/runtime/BudgetController.ts` | 完整差异＋当前受影响边界 | 删除maxSessionTokens配置声明；无总量停止上限。；L4初值只由sync同步，显式enableL4Compaction优先于env。；tracker配置未消费与forcedSummarize恒false仍保留，不能扩大退役范围。 |
| `src/agent/runtime/DiagnosticsCollector.ts` | 完整差异＋当前受影响边界 | 删除implements ToolDiagnosticsRecorder（该跨宿主端口已撤）；recordToolCallEnvelope与AgentDiagnostics.toolCalls保留真实写链。 |
| `src/agent/runtime/ExitController.ts` | 完整差异＋当前受影响边界 | ExitSignal.needsSummary删除；是否强制摘要只由Runtime.finalize抑制清单与summaryMode决定。；token代码集合只剩budget_session_input_tokens；旧budget_session_tokens成为policy_stop。；未接线checkAfterAiError/checkAfterTextResponse/checkToolChoiceViolation及nudge/graceful_exit仍保留。 |
| `src/agent/runtime/HookSystem.ts` | 完整差异＋当前受影响边界 | 删除5个从未派发的HookEvent/payload与agent:exit→STEP_COMPLETED桥；默认只剩两个llm桥。；HookSystem观察失败与tool before false阻断语义不变。 |
| `src/agent/runtime/LoopContext.ts` | 完整差异＋当前受影响边界 | BudgetConfig删除maxSessionTokens声明；索引签名可能收旧键但无消费者。 |
| `src/agent/runtime/PcvNodeEvidenceRecorder.ts` | 完整差异＋当前受影响边界 | qualifiedPath从最后覆盖Map变按不同身份分桶：多身份共享路径=ambiguous-path；basename也按身份判歧义。；唯一absolute若对应冲突qualifiedPath则原样保留absolute及行号，记info去重；不写缺链诊断。；无absolute用folderId+relativePath识别重复/冲突；同一absolute登记多个qualified仍歧义。 |
| `src/agent/runtime/SystemPromptBuilder.ts` | 完整差异＋当前受影响边界 | 删除memoryConfig配置与memoryMode向能力空传递；真正记忆提示仍由loop.memoryCoordinator装配。 |
| `src/agent/runtime/ToolExecutionPipeline.ts` | 完整差异＋当前受影响边界 | 包runtime仅公开createToolPipeline和ToolExecutionPipeline；单个middleware实现仍供内部直接测试使用。；progressEmitter/eventBusPublisher实现及门面导出删除，工具事件只在Runtime路径发布。 |
| `src/agent/runtime/index.ts` | 完整差异＋当前受影响边界 | 撤十个pipeline构件绑定，runtime签名登记68→58；工厂与类保留。；AgentState/AgentPhase仍被显式导出，不能与Runtime字段删除混淆。 |
| `src/agent/runtime/toolPipeline/contracts.ts` | 完整差异＋当前受影响边界 | ToolRuntimePort撤dataRoot/fileCache/toolRegistry/emitProgress/bus；ToolLoopPort撤toolCalls。；非blocked且result!==undefined只跳过executor，不隐式cacheHit；null/0/false/空串均合法短路。 |
| `src/agent/runtime/toolPipeline/engine.ts` | 完整差异＋当前受影响边界 | 非blocked短路不再强制cacheHit=true；未声明时记录TOOL_SHORT_CIRCUIT_NOT_COUNTED_AS_CACHE_HIT。；日志失败被隔离；结果身份和after执行规则保留。 |
| `src/agent/runtime/toolPipeline/observations.ts` | 完整差异＋当前受影响边界 | 只删可选progressEmitter/eventBusPublisher；默认三个观察者保留。；EVIDENCE_CAPTURE_FAILED部分entries仍返回标注；trace抛错仍由engine留下确认回执。 |
| `src/agent/runtime/toolPipeline/phaseGates.ts` | 完整差异＋当前受影响边界 | VERIFY聚焦graph.query枚举去overrides/extensions，剩class/protocol/hierarchy/callers/callees/impact；同步拒绝提示。 |
| `src/agent/runtime/toolPipeline/runtimeBridge.ts` | 完整差异＋当前受影响边界 | 宿主runtime请求不再含diagnostics/fileCache/dataRoot/logger；先前已不投影的policyValidator/sessionToolCalls/currentRound类型也删除。；memoryCoordinator、evidenceLedger、sharedState和scope仍按原身份传递；逐调用diagnostics直接留在loop。 |
| `src/agent/service/AgentRunContracts.ts` | 完整差异＋当前受影响边界 | 删除未用AgentProfile类型；fanout模板只剩type；concurrency.abortPolicy删除。；运行时词汇只single/pipeline；描述性memory留在preset快照，不再传Runtime。 |
| `src/agent/service/AgentRuntimeBuilder.ts` | 完整差异＋当前受影响边界 | toolRegistry选项同RuntimeConfig最小query端口，getRouter-only duck type与断言删除。；router只显式option或后续Runtime容器来源；memory preset不再传Runtime。；aiProvider仍为unknown宿主边界断言，本处不作新的运行校验。 |
| `src/agent/service/SystemRunContextFactory.ts` | 完整差异＋当前受影响边界 | 删除无调用project包装，调用者直接用runtime projectSystemRunContext。；createSystemContext默认仍不注入SessionStore/PersistentMemory；每次建独立对象。 |
| `src/ai/AiFactory.ts` | 全文／累计全文 | probe返回false不再被忽略；fallback来源不写实例字段；新增fallback_exhausted汇总，日志仅错误类名；429/408/5xx/网络/取消不触发切厂商 |
| `src/ai/AiProvider.ts` | 全文／累计全文 | 移除summarize/summarizeMaxTokens/_detectLanguageProfile/supportsNativeToolCalling/_fallbackFrom；chatWithTools默认不再丢工具降级，抛PROVIDER_CONTRACT_VIOLATION；probe用文本/工具/推理/计费用量/预算截断任一应答证据，30s期限16token；空证据false |
| `src/ai/AiProviderManager.ts` | 全文／累计全文 | 删除embedding兼容槽及embedProvider/rawEmbedProvider/setEmbedProvider；DI同步回调收为单provider参数，usage tracker仅绑定路由provider |
| `src/ai/contracts.ts` | 全文／累计全文 | 移除宽松ApiResponse与语言检测FileContentEntry/LanguageProfile；仍保留明确消息与回执DTO |
| `src/ai/gateway/LLMGateway.ts` | 全文／累计全文 | 删除getModelDef/probe/resolveWithFallback；删除共享单例getLLMGateway/resetLLMGateway；Provider自己持有Gateway或调用方new；结构化JSON本地schema校验仍在Gateway，不随Transport快捷入口删除 |
| `src/ai/gateway/index.ts` | 全文／累计全文 | 移除共享单例两个函数再导出 |
| `src/ai/management/contracts.ts` | 全文／累计全文 | ManagedAiProvider删除apiKey和_fallbackFrom；管理端口不暴露凭据或fallback来源 |
| `src/ai/providers/ClaudeProvider.ts` | 全文／累计全文 | 删除supportsNativeToolCalling getter；五个内置类仍各自override chatWithTools；Claude仍supportsEmbedding=false；embed预取消拒绝，否则每实例首次warn并[] |
| `src/ai/providers/DeepSeekProvider.ts` | 全文／累计全文 | 删除supportsNativeToolCalling getter；五个内置类仍各自override chatWithTools；supportsEmbedding保留true表示兼容endpoint路径，不代表官方模型支持 |
| `src/ai/providers/GoogleGeminiProvider.ts` | 全文／累计全文 | 删除supportsNativeToolCalling getter；五个内置类仍各自override chatWithTools；删除summarizeMaxTokens；chat默认8192仍保留 |
| `src/ai/providers/OllamaProvider.ts` | 全文／累计全文 | 删除supportsNativeToolCalling getter；五个内置类仍各自override chatWithTools；保留OpenAiTransport路由、无需真实key的本地配置和embedModel字段 |
| `src/ai/providers/OpenAiProvider.ts` | 全文／累计全文 | 删除supportsNativeToolCalling getter；五个内置类仍各自override chatWithTools；保留apiStyle配置经Transport选择Chat/Responses与embedModel公共字段 |
| `src/ai/registry/ModelRegistry.ts` | 全文／累计全文 | 本次仅注释校准：ContextWindow未命中回落的MODEL_CONTEXT_WINDOWS已模块私有；实现未变 |
| `src/ai/transport/ClaudeTransport.ts` | 全文／累计全文 | 删除Transport级chat快捷入口，唯一生成入口chatWithTools保留 |
| `src/ai/transport/DeepSeekTransport.ts` | 全文／累计全文 | 删除Transport级chat快捷入口，唯一生成入口chatWithTools保留 |
| `src/ai/transport/GoogleTransport.ts` | 全文／累计全文 | 删除Transport级chat快捷入口，唯一生成入口chatWithTools保留 |
| `src/ai/transport/LLMTransport.ts` | 全文／累计全文 | 删除abstract chat与chatStructured实现；本地schema校验上移/保留Gateway单源；代理/取消/嵌入基类默认[]语义未因删快捷入口改变 |
| `src/ai/transport/OpenAiTransport.ts` | 全文／累计全文 | 删除Transport级chat快捷入口，唯一生成入口chatWithTools保留 |
| `src/tools/catalog/CapabilityCatalog.ts` | 全文／累计全文 | 本次说明Unified子类不再维护lazy展开；mixed/full都完整schema，只有explicit lightweight简化 |
| `src/tools/catalog/UnifiedToolCatalog.ts` | 全文／累计全文 | 删除ToolDefinition/ToolHandler、router绑定、handler存取、modelOverrides、lazy展开全部旧层；JS旧构造参数忽略并warn；TS never[]拒绝有参构造 |
| `src/tools/index.ts` | 全文／累计全文 | 停止再导出kernel handler与routing |
| `src/tools/kernel/context.ts` | 全文／累计全文 | 当前无ToolCallContext.serviceContracts及旧六ServiceContract；ToolRuntimeCallContext无cache/diagnostics/policyValidator/sessionToolCalls/currentRound/validator/fileCache/dataRoot/logger；ToolPolicyValidator/ToolPolicyDecision类型仍保留；顶层dataRoot与真实宿主字段保留 |
| `src/tools/kernel/decision.ts` | 全文／累计全文 | 删除allowToolDecision/denyToolDecision无调用辅助函数，类型保留 |
| `src/tools/kernel/index.ts` | 全文／累计全文 | handler/routing再导出删除；当前barrel不在公开出口链，公开tools逐文件再导出 |
| `src/tools/kernel/manifest.ts` | 全文／累计全文 | 当前execution所有字段描述性；runtime动作并发/cache准入/输出预算读ToolAction；ToolDefinition推导与旧handler metadata复制删除，governance等不应画成权限门 |
| `src/tools/kernel/registry.ts` | 全文／累计全文 | ToolResultMeta.compression删除，degraded/fallbackUsed/diagnosticWarnings保留；graph每type一条reader，overrides/extensions及legacy标记删除；outlineFile唯一端口，astAnalyzer只留类型不再读取；prime拒绝repo-only但detail/manage仍可回落 |
| `src/tools/kernel/request.ts` | 全文／累计全文 | 删除request.governance、ToolExecutionAdapter与ToolExecutionPreviewRequest；ToolExecutionRequest仍保留供宿主形状，不能随旧adapter一起视为退役 |
| `src/tools/runtime/availability.ts` | 全文／累计全文 | graph按单reader表判断，旧方法不广告；code.outline只检查outlineFile；prime只认knowledgeRead或明确两reader均缺的search-only |
| `src/tools/runtime/cache/SearchCache.ts` | 全文／累计全文 | 删除static makeKey、has、createdAt；key由code.search包含项目/代数/查询维度编码，淘汰不按时间 |
| `src/tools/runtime/handlers/code.ts` | 完整差异＋当前受影响边界 | 删除resolveOutlinePort和legacy astAnalyzer调用；只注入旧分析器不再生效；缺端口/analyzer-error/no-definitions仍分别诊断；成功大纲过滤与头尾预览保持 |
| `src/tools/runtime/handlers/graph.ts` | 全文／累计全文 | 不再尝试备用读取器；删除GRAPH_QUERY_LEGACY_READER/FALLBACK诊断；读空就是No results found；取消仅结束等待，实际已invoke才附path；无法stringify拒绝值给占位文案+GRAPH_QUERY_UNPRINTABLE_ERROR |
| `src/tools/runtime/handlers/knowledge/authoring.ts` | 全文／累计全文 | 同标题attempt仅读写_sessionCounters盒；删除顶层别名收养/回写/兼容日志；其余止损3/12与修复每题2次、软advisory路径保持 |
| `src/tools/runtime/handlers/knowledge/queries.ts` | 全文／累计全文 | prime删除knowledgeRepo读取回落；repo-only直接port unavailable并不调用repo；两reader均缺仍search-only降级；detail的旧repo回落继续保留 |
| `src/tools/runtime/handlers/knowledge/sessionState.ts` | 全文／累计全文 | 注释确认title尝试不再有sharedState顶层别名；盒内计数接口不变 |
| `src/tools/runtime/handlers/recipeProductionAdapter.ts` | 全文／累计全文 | 本轮仅排序决策注释：en collation保持，不改码元序、不迁移既存hash |
| `src/tools/runtime/handlers/terminalSafety.ts` | 完整差异＋当前受影响边界 | 未提交W-SEC1改进：词边界正则改为raw切块、去引号/转义/ANSI-C、basename/大小写/提权名字族归一；增加doas/pkexec/run0、提权族变体；man只在安全页名/选项时给取证例外；日志只含规范名/写法类别，不含命令原文 |
| `src/tools/runtime/index.ts` | 全文／累计全文 | 去除System和ScanAnalyze公开类；ScanAnalyze内部按scan_analyze仍可解析 |
| `src/tools/runtime/registry.ts` | 全文／累计全文 | graph.query枚举收为七type，overrides/extensions旧回放参数会拒绝；evidence.get描述纠正：code.read有界条目会只读当前文件做freshness并可能返回verbatim；不再称never touches filesystem |
| `src/tools/runtime/router.ts` | 全文／累计全文 | 只删除getSchemas，模型schema仍由RuntimeCapabilityCatalog.querySchemas统一给出；execute/explain/concurrency/failure诊断逻辑未变 |
| `src/tools/runtime/toolsets/CapabilityRegistry.ts` | 全文／累计全文 | System类已删；system_interaction保留拒绝原因；删除可变_registry/register公共入口；create/names不依赖this |
| `src/tools/runtime/toolsets/index.ts` | 全文／累计全文 | 删除System与ScanAnalyze再导出；ScanAnalyze/RelationExploration内部按名构造 |
| `src/agent/coordination/AgentRunCoordinator.ts` | 全文／累计全文 | 删 logUnimplementedAbortPolicy 与 describeDeclaredAbortPolicy；旧非 stop-new 字段不再读取或告警。；真实调度固定 stop-new：取消阻止排队/后续tier派发，已运行 child 按透传 abortSignal 自行收尾。；scoped module 分区、identity 来自 planned childInput、懒构造、失败 partialResult 与父墙钟语义未由此差异改变。 |
| `src/agent/evaluation/gateEvaluators.ts` | 全文／累计全文 | 进化门只读 existingRecipes；删 decayedRecipes 别名/兼容日志。；producer gate 不读取 submitToolNames，固定统计 knowledge.submit。；重试轮仍读取 _priorAttempts_<stage>；累计有已持久化候选则pass；坏prior结构告警后只看本轮。 |
| `src/agent/evaluation/stageBuilders.ts` | 全文／累计全文 | buildScanPipelineStages(opts) 编译期必填；运行期 opts/task/producePrompt 校验保留。；rejection_gate.evaluator 直接引用共享 producerRejectionGateEvaluator；不再包覆盖 submitToolNames 的闭包。 |
| `src/agent/evidence/EvidenceLedgerStore.ts` | 全文／累计全文 | 新增 EvidenceSourceDigestTable，HMAC密钥与摘要仅在内存；按 ledgerFile/E-id 分区。；摘要绑定 callId/capturedAt/contentHash/file/range；重建/seed/外部改写后旧摘要不可借用。；无注入时自建 instance 表；Runtime注入时 shared；freshness诊断增加 sourceDigestScope。；redactor 上下文覆盖 append、describeContentTransformation 与 fallback重算。 |
| `src/agent/evidence/ProductionEvidenceLedgerAuthority.ts` | 全文／累计全文 | 新增 openProductionEvidenceLedgerAuthority 私有打开入口与内部 sourceDigests 选项。；默认redacted-evidence 固定 redactLedgerContent→redactDeveloperTextInContextWithReport，按来源追加T3。；T3 merged 或 skips非空时 debug仅计数与坐标；观察失败不影响文本结果。；verbatim-witness 不注入任何redactor；独立gate/上限不改写。 |
| `src/agent/evidence/loopLedger.ts` | 全文／累计全文 | 公开工厂改为内部open入口，必传 sourceDigests；本函数不创建模块级缓存。；无维度坐标返回null；coordinate/persistence/seed真实错误抛出，旁路日志失败隔离。 |
| `src/agent/index.ts` | 全文／累计全文 | 移除 FanOutStrategy 再导出；SingleStrategy/Strategy 保留。 |
| `src/agent/production/strict/expressions.ts` | 全文／累计全文 | 注释说明事项⑥已决定本轮只收敛副本；码元序迁移另行决定。；固定en的历史兼容断言仅针对ASCII expressionId；非ASCII旧zh默认顺序不能从原输出复现，但存储顺序完整性重算保持。 |
| `src/agent/prompts/index.ts` | 全文／累计全文 | 删除工具常量的注释更新；源删除使prompts名集收窄。 |
| `src/agent/prompts/insightAnalyst.ts` | 全文／累计全文 | 删除 ANALYST_TOOLS。；删除无执行者 maxSessionTokens 和×1.35总量公式；保留 maxSessionInputTokens=maxIter×ceil(contextWindowBudget_or_15000×0.6)。；24轮静态216000 input；record_repair/summary_rewrite也只保留阶段input预算。；graph端口说明明确仅impactAnalysis工具消费；本函数继续忽略占位参数。 |
| `src/agent/prompts/insightProducer.ts` | 全文／累计全文 | 删除 PRODUCER_TOOLS；开头改说GenerateProduce.allowedTools负责工具面。；v1 buildProducerPrompt仍deprecated保留，本轮不删除/不恢复。 |
| `src/agent/strategies/PipelineStrategy.ts` | 全文／累计全文 | record_repair去掉maxSessionTokens:16000，保留input12000。；summary_rewrite去掉maxSessionTokens:30000，保留input24000。；exact历史diff只有这两行；取消、partial/fast retry/gate/outcome既有语义未变。 |
| `src/agent/strategies/Strategy.ts` | 全文／累计全文 | 删 FanOutItem 与 ItemResult；StrategyResult/StrategyRuntime/Strategy 保留。 |
| `src/agent/strategies/index.ts` | 全文／累计全文 | 删除 FanOutStrategy/FanOutItem/ItemResult 再导出。 |
| `src/agent/utils/Redaction.ts` | 全文／累计全文 | 新增redactDeveloperTextInContext/WithReport/WithProvenance与共同unknownSourceFloorOptions。；开发者原门面签名和调用点不变；来源入口内部使用不由index导出。 |
| `src/agent/utils/redaction/detectors.ts` | 全文／累计全文 | 当前已跟踪（e6ce049），旧图谱“未跟踪”失效。；当前BraceResolver采用typed arrays结论编码；authority continuation、quote/JWT字节解析、截断/SAS索引均调用私有。；现行边界完整保留：T1不检测无关键字高熵；JWT两段JSON对象；Set-Cookie只第一对值；URL过长scheme/quoted窗口有明确skip/fallback。 |
| `src/agent/utils/redaction/hiddenSpans.ts` | 全文／累计全文 | 导入structurePositions；仅JSON载体内转义换行可作结构修剪。；吸收引号按整段反斜杠奇偶，偶数反斜杠是内容；supersetFromAlignment共享惰性structure。 |
| `src/agent/utils/redaction/legacyFloor.ts` | 全文／累计全文 | 新增createFloorReplayShare/RevisionReplay/FloorRoundBase，复用同原文首轮版本重放/结构；replayOverride不读写share。；sourceDetectors 不保留普通detector的级联trigger；T3未知来源最终hidden seed保证superset。；applyDetectors按keepTriggers分开；默认T1优先级和四历史版本不替换。 |
| `src/agent/utils/redaction/render.ts` | 全文／累计全文 | 新增expandEscapedQuotes将部分遮住的末反斜杠+引号扩完整。；missingTokens按level+newline分槽，裸换行不会抵消深层转义。；lexQuoteTokens识别奇偶和引号簇；被同历史版本两侧遮住的内层引号作内容；只有值边界引号可保留。 |
| `src/agent/utils/redaction/trackedReplay.ts` | 全文／累计全文 | StructureToken新增level；递归结构标记记录载体深度。；jsonDocumentRanges整体JSON优先，否则逐整行对象/数组；纯文本shell/source字符串的字面\n为内容。 |
| `src/evaluation.ts` | 全文／累计全文 | 撤回createDurableSemanticReviewRuntime、DurableSemanticReviewRuntimeError及9个类型重复导出；当前运行时binding数3。 |
| `src/agent/utils/redaction/sourcePolicy.ts` | 全文／累计全文 | 1753行全文已读；5规则：secret-bearing-every-value、terminal-env-sensitive-key、terminal-curl-verbose-auth-header、terminal-kubectl-secret-data、netrc-password。；terminal优先（file命令token不可信）；secret-bearing名称优先；source/config/no-file/unknown不追加规则。；unknown/no-source-rules直接原门面；no-span/covered要求未知floor收敛且输出T3只命中marker；否则merged。；merged把未知floor最终hidden位置第一轮整段seed并入，T3每轮在本轮原文算span而非串接，replayShare复用首轮。；secret-bearing支持嵌套/块标量/序列/多行引号/一行JSON；code.search保留NN前缀。terminal env敏感词子串、auth头、Secret data、netrc有明确门槛。 |

## 复核之后的维护

来源与维护入口按变动输入列出正文提及、输入闭包与执行组。输入匹配不意味着所有断言覆盖；动态依赖与公共外部依赖仍明确保守边界。旧快照原样保留，新快照只追加。
