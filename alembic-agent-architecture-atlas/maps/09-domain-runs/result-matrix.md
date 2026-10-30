---
schemaVersion: 1
diagramId: 09-result-matrix
topic: "09"
title: 六类run的权限与结果
viewType: guide
truthKind: in-progress-worktree
reviewDepth: L3
verifiedAt: 2026-10-23
baselineCommit: 37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0
documentationOwner: AlembicAgent 架构文档维护者
sourcePaths:
  - src/agent/coordination/AgentRunCoordinator.ts
  - src/agent/evaluation/stageBuilders.ts
  - src/agent/production/StrictProductionStages.ts
  - src/agent/profiles/AgentStageFactoryRegistry.ts
  - src/agent/profiles/definitions/evolution.profile.ts
  - src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.ts
  - src/agent/profiles/definitions/plan.profile.ts
  - src/agent/profiles/definitions/relation.profile.ts
  - src/agent/profiles/definitions/scan.profile.ts
  - src/agent/profiles/definitions/translation.profile.ts
  - src/agent/profiles/presets/evolutionPreset.ts
  - src/agent/runs/evolution/EvolutionAgentRun.ts
  - src/agent/runs/module-mining/ScopedModuleMiningAgentRun.ts
  - src/agent/runs/plan/PlanAgentRun.ts
  - src/agent/runs/relation/RelationAgentRun.ts
  - src/agent/runs/result.ts
  - src/agent/runs/scan/ScanAgentRun.ts
  - src/agent/runs/scan/ScanRunProjection.ts
  - src/agent/runs/systemTaskRunInput.ts
  - src/agent/runs/translation/TranslationAgentRun.ts
  - src/agent/runtime/AgentRuntime.ts
  - src/agent/runtime/toolPipeline/phaseGates.ts
  - src/agent/service/AgentService.ts
  - src/agent/strategies/PipelineStrategy.ts
  - src/agent/utils/toolOutcomes.ts
  - src/tools/kernel/toolSelection.ts
  - src/tools/runtime/handlers/terminalSafety.ts
  - src/tools/runtime/toolsets/Evolution.ts
  - src/tools/runtime/toolsets/GenerateAnalyze.ts
  - src/tools/runtime/toolsets/GenerateProduce.ts
  - src/tools/runtime/toolsets/RelationExploration.ts
  - src/tools/runtime/toolsets/ScanProduce.ts
testPaths:
  - test/agent-surface-floor.test.ts
  - test/gate-evaluators-scan-stage-narrowing.test.ts
  - test/mining-e2e-pipeline.test.ts
  - test/module-mining-agent-run.test.ts
  - test/plan-agent-run.test.ts
  - test/scan-run-projection.test.ts
  - test/stage-builders-relations-explore-readonly.test.ts
  - test/tool-pipeline-manage-operation-allowlist.test.ts
contractPaths:
  - vitest.config.ts
refreshTriggers:
  - package.json
  - tsconfig.json
sourceFingerprint: sha256:bc8c62137ce7873f4e69e2f16f7173b7e74246f2467f88fe4cfbacc67e5518d9
testEvidence: anchored
externalContracts:
  - Core 仅以公开包合同或宿主注入端口出现；此页不复制、审阅或验收 Core 内部实现。
reviewRecord: evidence/scoped-execution.json
generatedBy: mixed
---

# 六类领域 run：权限与结果矩阵

六类 helper 复用 AgentService，但结果不能用同一条 success 分支解释。下表保留用例身份、实际断言与替身边界；断言已定位，实际执行见页面证据。[执行记录](../../evidence/scoped-execution.json)按当前输入摘要判断是否仍适用，历史 21 个领域用例和 6 个挖掘用例的通过次数不自动继承为当前通过。

[领域职责](overview.md) · [知识生产纵切](../13-end-to-end/knowledge-production.md) · [Service状态](../03-runtime-lifecycle/state-and-recovery.md)

## 先看共同服务边界

validateRunInput→compileProfile→若concurrency非none则Coordinator；否则preflight取消/shouldAbort→build→execute→状态投影。

输入/compile/build/setFileCache/message组装错误reject；它们不是一个返回status=error的已开工run。协调器消费错误也可能reject并携partialResult。

信号：buildSystemTaskRunInput只透传已提供的abortSignal/shouldAbort/timeoutMs。非fan-out的shouldAbort是开工预检，不增加运行中轮询；Runtime运行中消费abortSignal。fan-out父透传给child，timeoutMs是每child期限，不是整次fan-out总期限。

`src/agent/service/AgentService.ts#AgentService.run`；`src/agent/service/AgentService.ts#inferRunStatus`；`src/agent/service/AgentService.ts#resolveTimeoutRecovery`；`src/agent/service/AgentService.ts#classifyRunError`；`src/agent/runs/systemTaskRunInput.ts#buildSystemTaskRunInput`；`src/agent/runs/result.ts#runFailure`。

## 六类结果速查

| run | 进入的profile | 是否写领域对象 | 成功之后还必须看 |
| --- | --- | --- | --- |
| Plan | plan-selection | 无工具，仅计划认知 | 阶段/形状校验；strict另需宿主validateReceipt。 |
| Scan | scan-extract / scan-summarize | 通过knowledge.submit端口 | 真实created回执、lifecycle/readiness及fallback/error。 |
| Evolution | evolution-audit | 通过受限manage操作 | 每个唯一Recipe ID是否都有成功决策，不只看回复文本。 |
| Relation | relation-discovery | 本helper只读，不写图 | 解析/过滤结果与diagnostics；空关系不代表项目没有关系。 |
| Translation | translation-json | 无工具 | error与逐字段原文回退；字符串类型不证明翻译质量。 |
| Module mining | module-mining-session + child profile | child调用工具端口 | childResults/moduleResults/abandonedModules及候选readiness。 |

## 权限的共同读法

- 表内allowedActions是内置阶段capability声明的上界，不是实际宿主可用性或已执行事实。
- actionSpace:none只是不额外开放工具，不会把capability.allowedTools清空。运行中按capability+additionalTools收集，再经schema availability、Policy、安全/阶段门、Router参数/可用性校验。
- memory.enabled=false、serviceKind、projection、lifecycle（除deprecated编译告警）是描述字段，不靠它们决定工具、关闭注入记忆或自动业务投影。
- Scan helper 实际使用 GenerateAnalyze(code_analysis)；旧 ScanAnalyze(scan_analyze) 已退役，不作为另一可用工具集。
- record_repair/Analyst RECORD只放memory.note_finding/recall/get_previous_evidence与evidence.get/search；广告面可更窄。VERIFY 只允许 read/outline、graph.query 的 class/protocol/hierarchy/callers/callees/impact 及已有证据/记忆；summary_rewrite无工具。
- GenerateProduce没有code.read；ScanProduce有code.read证据自救。二者不能合为同一生产权限表。

`src/agent/runtime/AgentRuntime.ts#AgentRuntime.collectToolContract`；`src/agent/runtime/AgentRuntime.ts#AgentRuntime.initLoop`；`src/agent/runtime/toolPipeline/phaseGates.ts#recordRepairOnlyGate`；`src/agent/runtime/toolPipeline/phaseGates.ts#analystVerifyOnlyGate`；`src/agent/strategies/PipelineStrategy.ts#PipelineStrategy.runRecordRepairStage`；`src/agent/strategies/PipelineStrategy.ts#PipelineStrategy.runSummaryRewriteStage`；`src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.ts#SCOPED_MODULE_MINING_PROFILES`。

## Plan（普通选择 + 严格Plan认知）

| 维度 | 当前行为 |
| --- | --- |
| 输入 | 普通：generationStage、projectContextFacts；严格：冻结contextProjection（facts/catalog/source/model/prompt哈希、capability/query白名单、repair cap）与宿主validateReceipt；均可传abortSignal/shouldAbort/timeoutMs。 |
| Profile与策略 | plan-selection → chat basePreset → SingleStrategy；普通/严格helper都显式toolChoiceOverride=none。 |
| 工具权限 | skills=[]、actionSpace=none，没有工具；严格路径额外检查result.toolCalls.length>0并抛PLAN_TOOL_FORBIDDEN。 |
| Service状态 | Service非success时两helper都抛runFailure并保留partialResult/cause；Service success后仍进入领域解析/校验，success不是计划有效的证明。 |
| 业务结果 | 普通返回通过Core assertPlanSelectionStageRequirements的PlanSelection；deepMining/moduleMining要求moduleBindings。严格返回有lineage（initial、repairs、transportRetryCount）、冻结hash与宿主validateReceipt已接受的PlanCognitionReceiptV1。 |
| 失败与恢复 | 普通success后的解析/形状错误直接抛出，不自动重试，也未用runFailure补partialResult。严格结构拒绝和模型可修复PLAN_*共用0..2修复预算，每次携带父输出/hash；宿主事实/政策等非白名单拒绝、非success或工具违规不重采样。 |

阶段声明的工具上界：

| 阶段 | capability | 动作／参数约束 |
| --- | --- | --- |
| single | 无 | 无；内置profile无工具；不等价所有自定义profile无工具。 |

定位：`src/agent/runs/plan/PlanAgentRun.ts#runPlanAgent`；`src/agent/runs/plan/PlanAgentRun.ts#parsePlanSelection`；`src/agent/runs/plan/PlanAgentRun.ts#runStrictPlanAgent`；`src/agent/profiles/definitions/plan.profile.ts#PLAN_PROFILES`；`src/agent/runs/result.ts#runFailure`。

| 测试定位与执行证据 | 实际断言 | 替身／范围 |
| --- | --- | --- |
| `test/plan-agent-run.test.ts#case:performs%20one%20real%20no-tool%20LLM%20call%20before%20returning%20PlanSelection%20JSON`；断言已定位，实际执行见页面证据 | 返回dimensions=['api']；provider一次；prompt含generationStage=coldStart；provider选项toolSchemas/toolChoice均undefined，因为没有可见工具。 | 真实AgentService/Builder/Runtime，脚本化provider；不证明真实远程模型。 |
| `test/plan-agent-run.test.ts#case:rejects%20deepMining%20and%20moduleMining%20selections%20without%20module%20bindings`；断言已定位，实际执行见页面证据 | service替身返回success与deepMining JSON但moduleBindings为空，runPlanAgent拒绝deepMining requires moduleBindings；另直接parse验证moduleMining同类拒绝。 | 真实helper/Core公开阶段校验，service为替身；显式证明Service success仍可被领域解析拒绝。 |
| `test/plan-agent-run.test.ts#case:does%20not%20call%20the%20provider%20and%20fails%20as%20aborted%20when%20the%20plan%20signal%20is%20already%20aborted`；断言已定位，实际执行见页面证据 | 预先取消signal，runPlanAgent抛Error且partialResult.status=aborted，provider零调用。 | 真实Service，配置真实Builder；预检返回，Runtime未创建；provider mock未被调用。 |
| `test/plan-agent-run.test.ts#case:forwards%20the%20same%20signals%20to%20every%20strict%20plan%20attempt%20including%20causal%20repairs`；断言已定位，实际执行见页面证据 | validateReceipt首轮抛PLAN_REQUIRED_LENS_UNSCHEDULED，第二轮通过；run共2次，每次execution为none+同一signal/shouldAbort/15000ms。 | service及宿主validateReceipt为受控替身；只证明因果修复与信号透传。 |
| `test/plan-agent-run.test.ts#case:stops%20a%20structural%20repair%20that%20is%20aborted%20mid-flight%20as%20STRICT_PLAN_RUN_FAILED`；断言已定位，实际执行见页面证据 | 结构修复途中出现aborted结果，抛STRICT_PLAN_RUN_FAILED，不把失败当作修复成功。 | 定向helper夹具；不证明真实provider取消或宿主封印。 |

- 普通Plan没有证明语义计划一定适合真实项目；代码保证形状/阶段要求。
- 严格validateReceipt是外部宿主端口，本次不确认真实执行/封印/后续G1/G2闭环。
- 严格每次修复携带同一timeoutMs，它是每次Service run期限，不是本helper所有修复共享总期限。

## Scan（extract / summarize）

| 维度 | 当前行为 |
| --- | --- |
| 输入 | files（name/relativePath/content/language）、task=extract\|summarize、label、comprehensive、lang、source（默认system-workflow）；宿主signals及可选onParseError。 |
| Profile与策略 | scan-extract或scan-summarize → insight → scanPipeline：analyze→quality_gate→produce→rejection_gate；SystemRunContextFactory创建独立memory scope、window和analyst tracker。 |
| 工具权限 | analyze 使用 code_analysis（GenerateAnalyze）；旧 scan_analyze 已退役；produce用scan_production，允许已定位code.read证据修复与knowledge.submit。门控/微阶段进一步收窄。 |
| Service状态 | 非success不必抛错：projectScanRunResult给error并保留已有created回执；success也可能零created，只返回task fallback和diagnostics。 |
| 业务结果 | 只将knowledge.submit且observation.ok、status=created、非空id、lifecycle=pending\|staging的回执投影为Recipe。extract返回recipes/extracted；summarize用首条持久化Recipe的摘要字段并保留recipes。 |
| 失败与恢复 | 无created时fallback并安全通知onParseError一次，记录no-submit-attempt或submit-without-created-recipe；绝不从provider文本制造ID。超时/取消后已有created仍返回且带error；重启/重复提交由宿主依据回执决定，不自动回滚。 |

阶段声明的工具上界：

| 阶段 | capability | 动作／参数约束 |
| --- | --- | --- |
| analyze | code_analysis | code.{search,read,outline,structure}；terminal.{exec}；graph.{overview,query}；memory.{save,recall,note_finding,get_previous_evidence}；evidence.{get,search}；meta.{plan} |
| produce | scan_production | code.{read}；knowledge.{submit}；memory.{recall}；evidence.{get,search} |
| quality_gate/rejection_gate | 无 | 无；确定性gate，不独立向模型开放工具；可调度repair微阶段，见共用权限说明。 |

定位：`src/agent/runs/scan/ScanAgentRun.ts#runScanAgentTask`；`src/agent/runs/scan/ScanRunProjection.ts#projectScanRunResult`；`src/agent/runs/scan/ScanRunProjection.ts#extractCreatedRecipes`；`src/agent/utils/toolOutcomes.ts#hasPersistedCandidate`；`src/agent/profiles/definitions/scan.profile.ts#SCAN_PROFILES`；`src/agent/profiles/AgentStageFactoryRegistry.ts#AgentStageFactoryRegistry`；`src/agent/evaluation/stageBuilders.ts#buildScanPipelineStages`；`src/tools/runtime/toolsets/GenerateAnalyze.ts#GenerateAnalyze.allowedTools`；`src/tools/runtime/toolsets/ScanProduce.ts#ScanProduce.allowedTools`。

| 测试定位与执行证据 | 实际断言 | 替身／范围 |
| --- | --- | --- |
| `test/scan-run-projection.test.ts#case:projects%20a%20knowledge.submit%20created%20envelope%20as%20an%20existing%20staging%20Recipe`；断言已定位，实际执行见页面证据 | created回执id=recipe-persisted-1/lifecycle=staging、readiness.ready=false进入recipes；candidateId等于id，readiness原样保留，extracted=1。 | 纯投影fixture，不真实写入Core数据库；created在此是给定的已确认回执。 |
| `test/scan-run-projection.test.ts#case:returns%20no%20Recipes%20when%20the%20production%20scan%20never%20submits%20provider%20output`；断言已定位，实际执行见页面证据 | success result.reply含声称1条Recipe的JSON但toolCalls=[]，断言extracted=0、recipes=[]、no-submit-attempt、ignoredUnpersistedOutput=true、usedFallback=true。 | 纯投影；明确证明不能以provider文字制造Recipe。 |
| `test/scan-run-projection.test.ts#case:does%20not%20manufacture%20a%20Recipe%20from%20provider%20text%20after%20rejected%20or%20failed%20submits`；断言已定位，实际执行见页面证据 | submit被拒或失败即使reply含Recipe，仍无recipes；persistenceOutcome=submit-without-created-recipe。 | 纯投影fixture。 |
| `test/scan-run-projection.test.ts#case:does%20not%20hide%20scan%20timeout%20while%20preserving%20confirmed%20partial%20receipts%3D%25s`；断言已定位，实际执行见页面证据（参数化展开 2 例） | withCreated=false/true两例：Service结果给定timeout，投影error为真，extracted分别为0/1。 | 纯投影；既不丢已确认写入，也不把超时包装为无错误成功。 |

- created/readiness/publication不是同一状态；projection保留readiness而不要求ready=true，不会publish。
- onParseError名称沿用兼容，这里不是JSON解析通知，而是没有可投影持久化Recipe的回退通知。
- 输入files预加载不是对整个用户仓库完成扫描的证明；terminal实际执行取决于安全策略与宿主sandbox接线。

## Evolution审计

| 维度 | 当前行为 |
| --- | --- |
| 输入 | recipes、projectOverview，默认dimensionId=all/dimensionLabel=全量进化审计，proposalSource及三种signals；recipes=[]直接返回零计数且不run。 |
| Profile与策略 | evolution-audit → evolution → evolutionAuditPipeline：evolve→evolution_gate；规模预算按recipeCount确定，gate最多2次补写重试。 |
| 工具权限 | evolution_analysis开放code search/read、terminal exec、knowledge search/detail/manage、graph query；manage operation仅evolve/deprecate/skip_evolution；decision-only补写只可knowledge.manage这三种operation。 |
| Service状态 | Service非success抛runFailure；success后仍按唯一expected Recipe ID核对成功决策，任何pending都抛Evolution audit incomplete，并保留原result。 |
| 业务结果 | 返回proposed/deprecated/skipped、iterations、toolCalls、reply；计数按工具回执次数/结果，而完整性按去重ID。提案不等于发布新知识或已完成替换。 |
| 失败与恢复 | evolution_gate用累计成功决策补缺失ID；默认首轮+最多2个decision-only补写。helper不再自行发第二轮run；若最终不全则交宿主带partialResult的错误。 |

阶段声明的工具上界：

| 阶段 | capability | 动作／参数约束 |
| --- | --- | --- |
| evolve | evolution_analysis | code.{search,read}；terminal.{exec}；knowledge.{search,detail,manage}；graph.{query}；{"knowledge.manage.operation":["evolve","deprecate","skip_evolution"]} |
| decision-only retry | evolution_analysis | knowledge.{manage}；{"knowledge.manage.operation":["evolve","deprecate","skip_evolution"]}；_evolutionDecisionOnly门要求id，拦search/detail/code/graph等。 |

定位：`src/agent/runs/evolution/EvolutionAgentRun.ts#runEvolutionAudit`；`src/agent/runs/evolution/EvolutionAgentRun.ts#projectEvolutionAuditResult`；`src/agent/runs/evolution/EvolutionAgentRun.ts#collectEvolutionDecisionIds`；`src/agent/utils/toolOutcomes.ts#collectEvolutionDecisions`；`src/agent/profiles/definitions/evolution.profile.ts#resolveEvolutionAuditScaleBudget`；`src/agent/profiles/presets/evolutionPreset.ts#EVOLUTION_PRESET`；`src/tools/runtime/toolsets/Evolution.ts#Evolution.allowedTools`；`src/tools/kernel/toolSelection.ts#CAPABILITY_PARAMETER_ALLOWLISTS`；`src/agent/runtime/toolPipeline/phaseGates.ts#evolutionDecisionGate`；`src/tools/runtime/handlers/terminalSafety.ts#EVOLUTION_CODE_EXECUTION_ENABLED`。

| 测试定位与执行证据 | 实际断言 | 替身／范围 |
| --- | --- | --- |
| `test/agent-surface-floor.test.ts#case:keeps%20the%20scaled%20budget%20on%20the%20decision-only%20retry%20that%20completes%20a%20partial%20first%20attempt`；断言已定位，实际执行见页面证据 | 5条recipes先决定3条后补2条，audit.skipped=5；evolve两次，各阶段budget包含30轮/230000ms。 | 真实Service/Compiler/Builder/Runtime执行边界/PipelineStrategy，AgentRuntime.prototype.reactLoop被spy替换为受控回执；不执行真实provider或工具/Core写入。 |
| `test/agent-surface-floor.test.ts#case:throws%20runFailure%20with%20the%20pending%20ids%20and%20the%20partial%20result%20when%20decisions%20are%20missing`；断言已定位，实际执行见页面证据 | success服务结果给r1/r2成功skip，输入r1/r2/r3；抛decisions2/3 pending=r3，partialResult和cause均为原result；evolutionGateEvaluator也给pendingIds=['r3']。 | service替身+真实helper/gate；不是Service执行失败。 |
| `test/agent-surface-floor.test.ts#case:accepts%20duplicated%20recipe%20ids%20once%20every%20unique%20id%20is%20decided%2C%20as%20the%20gate%20does`；断言已定位，实际执行见页面证据 | 输入两次r1，只有一次成功skip，audit.skipped=1且gate pass；记录duplicate IDs诊断。 | service替身；证明完整性按唯一ID，不按输入行数。 |
| `test/tool-pipeline-manage-operation-allowlist.test.ts#case:blocks%20knowledge.manage(%25s)%20when%20the%20loop%20carries%20evolution_analysis`；断言已定位，实际执行见页面证据 | approve/publish/update/reject/score/validate/review/review-queue八种operation由runtimeSafetyGate返回blocked及TOOL_PARAMETER_DENIED，诊断注明能力/操作。 | 真实gate+Evolution capability，构造loop上下文；不调用外部权限服务。 |
| `test/tool-pipeline-manage-operation-allowlist.test.ts#case:admits%20knowledge.manage(%25s)%20under%20evolution_analysis`；断言已定位，实际执行见页面证据 | evolve/deprecate/skip_evolution三种operation不被该参数gate拦截，warn和diagnostics为空。 | 只证明此门允许，不证明后续宿主准入或Core动作成功。 |

- terminal capability声明保留一些bin，但当前terminalSafety的EVOLUTION_CODE_EXECUTION_ENABLED=false，会拒绝执行仓库代码的node/npm/pnpm/yarn/npx/vitest/jest/eslint；不能把声明bin当实际允许。
- terminal isolation intent需宿主执行器落实，Agent的白名单与请求投影不等于OS隔离。
- audit proposed/deprecated/skipped计数不是去重后的完成计数，完整性应读collectEvolutionDecisions/expected IDs。

- evolution_gate 只读 existingRecipes；旧 decayedRecipes 被忽略。producer rejection_gate 只统计 knowledge.submit；旧 submitToolNames 不再改变计数。`test/gate-evaluators-scan-stage-narrowing.test.ts#case:keeps%20existingRecipes%20as%20the%20only%20expectation%20source`和`test/gate-evaluators-scan-stage-narrowing.test.ts#case:keeps%20counting%20rejected%20knowledge.submit%20even%20when%20submitToolNames%20excludes%20knowledge`定位相应收窄；断言已定位，实际执行见页面证据。

## Relation Discovery

| 维度 | 当前行为 |
| --- | --- |
| 输入 | batchSize默认20和三种signals；message要求只读探索知识关系；helper不接受/分配数据库写入。 |
| Profile与策略 | relation-discovery → insight → relationsPipeline：explore（20轮/300s）→synthesize（4轮/60s）；profile运行期限540s覆盖阶段窗口。 |
| 工具权限 | explore专用relation_exploration：knowledge.search/detail、code.read/search/outline、graph.query；没有submit/manage/terminal/memory/evidence/meta。synthesize capabilities=[]，只生成文本JSON。 |
| Service状态 | 非success无论文本是否含有效关系都抛runFailure；success只允许进入投影，不保证发现有效/非空关系。 |
| 业务结果 | 优先phases.synthesize.reply，其次run.reply；parseJsonObjectWithDiagnostics，规范analyzed为非负安全整数，过滤不满足from/to/type非空字符串的条目；返回relations与diagnostics。 |
| 失败与恢复 | 解析完全失败时返回analyzed=0/relations=[]、usedFallback=true、parseError并warn，而不是抛错/再run。级联解析恢复可保留关系并info。投影不实际写图。 |

阶段声明的工具上界：

| 阶段 | capability | 动作／参数约束 |
| --- | --- | --- |
| explore | relation_exploration | knowledge.{search,detail}；code.{read,search,outline}；graph.{query} |
| synthesize | 无 | 无 |

定位：`src/agent/runs/relation/RelationAgentRun.ts#runRelationDiscovery`；`src/agent/runs/relation/RelationAgentRun.ts#projectRelationDiscoveryResult`；`src/agent/runs/relation/RelationAgentRun.ts#isRelation`；`src/agent/profiles/definitions/relation.profile.ts#RELATION_PROFILES`；`src/agent/evaluation/stageBuilders.ts#buildRelationsPipelineStages`；`src/tools/runtime/toolsets/RelationExploration.ts#RelationExploration.allowedTools`。

| 测试定位与执行证据 | 实际断言 | 替身／范围 |
| --- | --- | --- |
| `test/agent-surface-floor.test.ts#case:extracts%20relations%20from%20the%20first%20balanced%20object%20even%20with%20trailing%20braces`；断言已定位，实际执行见页面证据 | 从前后文夹JSON中恢复A→B type=uses，analyzed=2、usedFallback=false、无parseError，记录balanced-object恢复info。 | 直接调用真实投影，输入success结果fixture；也说明投影只要求非空type，不验证提示中的关系类型枚举。 |
| `test/agent-surface-floor.test.ts#case:marks%20the%200-relation%20fallback%20for%20%24label%20and%20warns%20without%20the%20reply%20body`；断言已定位，实际执行见页面证据（参数化展开 2 例） | 非法多括号文本与截断JSON两例，success结果投影analyzed=0/relations=[]、usedFallback=true/parseError；日志不含SECRET-BODY。 | 真实投影，Service结果为fixture；不会因解析失败改成非success运行。 |
| `test/agent-surface-floor.test.ts#case:does%20not%20emit%20writable%20relations%20from%20a%20%25s%20run`；断言已定位，实际执行见页面证据 | aborted/timeout/blocked/error结果虽然reply含有效关系JSON，runRelationDiscovery仍拒绝且cause是原result。 | service替身；阻止helper把非success文本作为可写关系列表，不验证宿主写图。 |
| `test/stage-builders-relations-explore-readonly.test.ts#case:projects%20explore%20schemas%20at%20runtime%3A%20knowledge.search%20is%20offered%20and%20forwarded%2C%20submit%20is%20not`；断言已定位，实际执行见页面证据 | provider看见code/graph/knowledge schema；knowledge action只有search/detail，不含submit；模型同时请求search/submit/terminal后只有knowledge.search到router。 | 真实Runtime/reactLoop+能力/阶段schema，provider与router为mock。 |

- usedFallback只说明JSON解析失败；可解析空对象或缺relations仍可返回空数组且usedFallback=false。
- isRelation不验证relation type属于提示枚举、不验证from/to存在、不验证引用证据真实性。测试中的type='uses'可保留，不能宣传成语义关系已验收。
- 关系持久化、ID解析/去重是外部宿主消费边界，本次不作已写图声明。
- batchSize仅进入params与任务文字；当前relations阶段工厂未据它设置硬批量或迭代上限，不能画成强制每批20条的调度器。

## Translation JSON

| 维度 | 当前行为 |
| --- | --- |
| 输入 | summary/usageGuide及signals/onParseError；二者都为空直接返回空译文，不调用Service。 |
| Profile与策略 | translation-json → chat → SingleStrategy；skills=[]、actionSpace=none，maxIterations=1；context.lang=en。 |
| 工具权限 | 没有工具；翻译只消费文本，不触发knowledge/file/terminal动作。 |
| Service状态 | 非success返回原文填到summaryEn/usageGuideEn并带error，不抛runFailure；success后再按字段解析，仍可部分或全部回退。 |
| 业务结果 | 每个原文非空的字段必须拿到字符串值才没有missing error；缺/非字符串字段回原文，已译字段保留；全部不可解析则全部原文+translation_fallback error。 |
| 失败与恢复 | 不自动再次调用模型。JSON解析失败或字段缺失安全通知onParseError一次并warn；观察者/日志异常隔离。非success分支沿用错误文本，不调用parse observer。 |

阶段声明的工具上界：

| 阶段 | capability | 动作／参数约束 |
| --- | --- | --- |
| single | 无 | 无 |

定位：`src/agent/runs/translation/TranslationAgentRun.ts#runTranslationJson`；`src/agent/runs/translation/TranslationAgentRun.ts#parseTranslationJson`；`src/agent/runs/translation/TranslationAgentRun.ts#reportTranslationFallback`；`src/agent/profiles/definitions/translation.profile.ts#TRANSLATION_PROFILES`。

| 测试定位与执行证据 | 实际断言 | 替身／范围 |
| --- | --- | --- |
| `test/agent-surface-floor.test.ts#case:keeps%20the%20translated%20field%20and%20reports%20only%20the%20missing%20one`；断言已定位，实际执行见页面证据 | success服务结果仅有summaryEn=Summary，原文两个字段均非空；保留Summary、usageGuideEn回原文，error只标missing usageGuideEn，onParseError一次。 | service替身+真实helper/解析；证明执行success不等于两个字段翻译齐全。 |
| `test/agent-surface-floor.test.ts#case:falls%20back%20as%20a%20whole%20for%20the%20reply%20%24reply`；断言已定位，实际执行见页面证据 | 空回复与字符串null两例，返回原文两字段+translation_fallback:unparseable reply，onParseError一次。 | service替身显式返回success，包括空reply夹具；真实Service一般会把空reply归error，所以空串例只证明投影防御。 |
| `test/agent-surface-floor.test.ts#case:forwards%20signals%20from%20runTranslationJson%20and%20keeps%20the%20original%20text%20on%20an%20aborted%20run`；断言已定位，实际执行见页面证据 | aborted结果返回summaryEn=原文/usageGuideEn=用法及原停止文本error；execution保留signal和timeout，未传signals时不加execution键。 | service替身；helper返回警告式对象，不抛runFailure。 |

- 字符串类型检查不验证翻译质量或非空；给空字符串也属于已提供字段，不能将无error等同语义翻译正确。
- 输出英文命名字段可能保留中文原文；消费者必须读取error。
- 执行status未原样作为字段返回给Translation调用方，只保留reply/失败文案于error。

## Scoped Module Mining

| 维度 | 当前行为 |
| --- | --- |
| 输入 | 真实ProjectContext modules+projectFacts；可选budget/scaleCap/concurrency/signals。先scaleCap再按超大模块拆分，附contextMap与动态_computedBudget；空输入/零选中在开run前拒绝。 |
| Profile与策略 | module-mining-session 的 marker-only fanout 模板 → Coordinator（唯一 concurrency 计划：projectContextModules/moduleMiningResults、tiered、默认并发2）→ 每 child module-mining-dimension → generateDimensionPipeline。取消固定 stop-new；不是已退役的 fan_out Runtime 策略。 |
| 工具权限 | 父run不调用模型/工具。普通child analyze用code_analysis，produce用knowledge_production；可能有前置evolve，record_repair与summary_rewrite微阶段另限。若child.strategyContext.strictProduction.enabled=true，工厂改走无工具严格阶段。 |
| Service状态 | 父aggregateStatus按error→aborted→timeout→blocked优先级取child非success，否则success。helper只对父status!=success抛runFailure；它不会把abandonedModules重新分类为error。 |
| 业务结果 | 返回AgentRunResult，phases.childResults/moduleResults保留单元事实，abandonedModules列出业务放弃；usage.durationMs为墙钟，childDurationMsTotal单列。成功创建候选与ready/published另看回执。 |
| 失败与恢复 | stop-new不启动排队/后续tier；开始的child按各自signal收尾。兄弟成功回执保留在错误partialResult，onChildResult消费失败后等待已开工child再停止。宿主budget仅提示，不是child硬预算。 |

阶段声明的工具上界：

| 阶段 | capability | 动作／参数约束 |
| --- | --- | --- |
| parent | 无 | 无；协调器拆分/合并，不运行模型。 |
| analyze (ordinary) | code_analysis | code.{search,read,outline,structure}；terminal.{exec}；graph.{overview,query}；memory.{save,recall,note_finding,get_previous_evidence}；evidence.{get,search}；meta.{plan} |
| produce (ordinary) | knowledge_production | knowledge.{submit}；memory.{recall}；evidence.{get,search}；meta.{review} |
| optional evolve | evolution_analysis | code.{search,read}；terminal.{exec}；knowledge.{search,detail,manage}；graph.{query}；{"knowledge.manage.operation":["evolve","deprecate","skip_evolution"]} |
| strict alternate analyst/producer | 无 | 无；仅当explicit strictProduction.enabled切换工厂；需宿主strict ports，不能从module profile名推定。 |

定位：`src/agent/runs/module-mining/ScopedModuleMiningAgentRun.ts#runScopedModuleMining`；`src/agent/runs/module-mining/ScopedModuleMiningAgentRun.ts#selectScopedIndexModulesForRun`；`src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.ts#SCOPED_MODULE_MINING_PROFILES`；`src/agent/coordination/AgentRunCoordinator.ts#partitionProjectIndexScopedModules`；`src/agent/coordination/AgentRunCoordinator.ts#mergeProjectIndexScopedModuleResults`；`src/agent/coordination/AgentRunCoordinator.ts#aggregateStatus`；`src/agent/coordination/AgentRunCoordinator.ts#collectAbandonedUnits`；`src/agent/profiles/AgentStageFactoryRegistry.ts#AgentStageFactoryRegistry`；`src/tools/runtime/toolsets/GenerateAnalyze.ts#GenerateAnalyze.allowedTools`；`src/tools/runtime/toolsets/GenerateProduce.ts#GenerateProduce.allowedTools`；`src/agent/production/StrictProductionStages.ts#buildStrictProductionPipelineStagesV1`。

| 测试定位与执行证据 | 实际断言 | 替身／范围 |
| --- | --- | --- |
| `test/module-mining-agent-run.test.ts#case:fans%20out%20one%20child%20per%20ProjectContext%20module%20without%20dimension%20cross-talk`；断言已定位，实际执行见页面证据 | 3个modules产生3次module-mining-dimension执行，parent moduleResults按core/ui/cli，child无dimension串值；host budget仅在context，budgetOverride未设置。 | 真实Service/Compiler/Coordinator，Builder/Runtime执行替身。 |
| `test/module-mining-agent-run.test.ts#case:retains%20confirmed%20sibling%20results%20on%20a%20failed%20module%20run%20error`；断言已定位，实际执行见页面证据 | good/bad两个child，其中bad错误；helper抛Error，partialResult.status=error仍保留good的created回执与good success/bad error结果。 | 真实Service/Coordinator配受控Runtime；不证明真实知识写入。 |
| `test/module-mining-agent-run.test.ts#case:forwards%20the%20abort%20signal%20and%20deadline%20to%20child%20runtimes%20and%20stops%20after%20a%20mid-run%20abort`；断言已定位，实际执行见页面证据 | 并发1，第一个child执行时取消父signal；helper拒绝且partialResult.status=aborted；仅1个child启动并保留同一signal/45000ms。 | 真实Service/Coordinator，Runtime替身触发取消；证明stop-new及透传。 |
| `test/mining-e2e-pipeline.test.ts#case:%E5%BC%B1%E6%A8%A1%E5%9D%97%EF%BC%9A%E9%9B%B6%E5%8F%91%E7%8E%B0%20%E2%86%92%20record_repair%20%E6%95%91%E4%B8%8D%E5%9B%9E%20%E2%86%92%20degraded_no_findings%20%E2%86%92%20%E7%88%B6%E7%BB%93%E6%9E%9C%20abandonedModules%20%E4%B8%80%E7%AD%89%E5%8F%AF%E8%A7%81`；断言已定位，实际执行见页面证据 | 脚本provider零发现；真实组合链断言created=0、child outcome=abandoned、父abandonedModules[0].unitId/action正确。此case没有断言parent.status。 | 真实Service/Builder/Coordinator/Pipeline/Runtime/Router/handler，临时fixture文件，provider脚本化、gateway内存fake。 |

- scaleCap在拆分前应用，所以不等于拆分后的child总数上限。
- ownedFiles是任务上下文，不可单凭它宣称文件系统权限只限这些文件。
- module helper没有自动提供真实宿主memory/evidence/Core port；capability动作还会按可用性收窄。

- fanout 模板不再重复声明 partitioner/childProfile/merge；可执行信息只来自 concurrency 计划。旧 abortPolicy 键忽略，不再有“声明但未实现”的告警；仍需保留取消后的兄弟回执。
- 原文摘要表按 child Runtime 隔离：同 child analyze/produce 可共享 HMAC，跨 child 不共享；普通生产台账的 T3 与严格无工具替代路径分开解释。
- 现有弱模块E2E用例断言abandoned与零候选，但未直接断言Service success；success可与abandoned并存是当前inferRunStatus+aggregateStatus的源码结论，不伪装成该case已经断言。

## 为什么Service success仍不能当领域成功

| 场景 | 服务状态 | 领域事实 | 验证范围 |
| --- | --- | --- | --- |
| plan | success（测试service替身返回） | deepMining缺moduleBindings，runPlanAgent仍抛Core阶段校验错误 | `test/plan-agent-run.test.ts#case:rejects%20deepMining%20and%20moduleMining%20selections%20without%20module%20bindings`；断言已定位，实际执行见页面证据 |
| scan | success | 模型声称提取Recipe但零submit，extracted=0、recipes=[]、usedFallback=true，通常无顶层error | `test/scan-run-projection.test.ts#case:returns%20no%20Recipes%20when%20the%20production%20scan%20never%20submits%20provider%20output`；断言已定位，实际执行见页面证据 |
| scan | success | 只确认created+pending/staging；readiness可为false，既不是ready也不是published | `test/scan-run-projection.test.ts#case:projects%20a%20knowledge.submit%20created%20envelope%20as%20an%20existing%20staging%20Recipe`；断言已定位，实际执行见页面证据 |
| evolution | success | 输入r1/r2/r3仅r1/r2有决策，helper抛incomplete且携带原success partialResult | `test/agent-surface-floor.test.ts#case:throws%20runFailure%20with%20the%20pending%20ids%20and%20the%20partial%20result%20when%20decisions%20are%20missing`；断言已定位，实际执行见页面证据 |
| relation | success | 非法JSON回退0关系，usedFallback=true；不抛运行失败 | `test/agent-surface-floor.test.ts#case:marks%20the%200-relation%20fallback%20for%20%24label%20and%20warns%20without%20the%20reply%20body`；断言已定位，实际执行见页面证据（参数化展开 2 例） |
| translation | success | 只翻译summary；usageGuide仍原文并带missing usageGuideEn error | `test/agent-surface-floor.test.ts#case:keeps%20the%20translated%20field%20and%20reports%20only%20the%20missing%20one`；断言已定位，实际执行见页面证据 |
| module-mining | 在child无终态取消/失败诊断且reply非空时可以success | child _pipelineOutcome=abandoned与parent abandonedModules仍可非空，甚至零候选 | `test/mining-e2e-pipeline.test.ts#case:%E5%BC%B1%E6%A8%A1%E5%9D%97%EF%BC%9A%E9%9B%B6%E5%8F%91%E7%8E%B0%20%E2%86%92%20record_repair%20%E6%95%91%E4%B8%8D%E5%9B%9E%20%E2%86%92%20degraded_no_findings%20%E2%86%92%20%E7%88%B6%E7%BB%93%E6%9E%9C%20abandonedModules%20%E4%B8%80%E7%AD%89%E5%8F%AF%E8%A7%81`；断言已定位，实际执行见页面证据；此case未直接断言parent.status=success，该组合结论来自源码。 |

这些结果都不证明真实LLM质量、外部宿主部署或Core生产发布。角色、serviceKind和projection等描述性字段也不能代替实际被读取的分支。
