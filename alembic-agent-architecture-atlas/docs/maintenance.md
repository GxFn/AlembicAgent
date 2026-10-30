# 提交边界与维护方法

本说明区分需要版本控制的材料和可再生输出。可执行规则位于 [check-files.mjs](../scripts/check-files.mjs)；`npm run check:files -- --details` 可逐文件查看分类原因。它只检查提交结构，不代表源码事实已更新或产品已通过验收。

## 哪些内容提交

| 范围 | 提交理由 |
| --- | --- |
| 根配置、README、AGENTS、锁文件 | 能独立安装、启动、校验和明确边界；元数据 schema 为唯一声明。 |
| `src/`、`scripts/`、`test/` | 手写阅读器、采集与维护能力、可重复验证的回归检查。测试源码与测试执行产物应分开。 |
| `maps/` | 人工架构说明、图源、E 边表和来源声明，是阅读内容正典。 |
| `docs/` | Atlas 自身的架构及维护约定。 |
| `evidence/readings.json`、`reviews/source-*.json` | 逐文件审阅深度、来源、分段、分支、断言与缺口；无法从 AST 自动重造人工阅读结论。 |
| `evidence/scenarios.json` | 人工维护的故障阅读入口，只索引正文而不复制事实。 |
| `evidence/execution-plan.json` | 当前已审阅选择器和输入约束，是重新运行的说明，不是执行通过证据。 |
| `evidence/scoped-execution.json`、`pilot.json` | 实际执行记录及其输入绑定；最新失败或未完成状态不能删掉以恢复旧绿色状态。 |
| `evidence/render/current.json`、`latest-attempt.json` | 最近成功 SVG 回执与最近尝试分别保存，防止旧成功掩盖新失败。 |
| `evidence/iterations/`、`scope.json`、`executions/archive-index.json` | 压缩后的历史验证、范围与归档说明；只说明记录时点。 |
| `planning/` 中保留的五份日期材料 | 历史批准方案、其原始评估依据、实施/全文审阅/存储迁移结果。它们解释设计来源，不能当当前任务、状态或新的授权。 |

`planning/2026-10-23-assessment.json` 保留是因为历史批准方案直接引用其量化依据，不是因为 JSON 或报告天然必须入库。以后的一次性计划检查输出应放 `.cache/`，不继续积累过程副本。

## 哪些内容排除

| 范围 | 处理方式 |
| --- | --- |
| `evidence/snapshots/`、`evidence/current.json` | 完整本地历史及其指针只保留本机，不提交；JSON、清单和 gzip 块统一按目录排除，不因 Git 清理而转换格式。 |
| `node_modules/`、`dist/`、`coverage/` | 分别由安装、构建和测试生成。 |
| `.cache/`、`.sites-runtime/`、日志、截图 | 本地检查、恢复和临时输出，不提交。 |
| `evidence/live/` | `collect` 生成的完整 catalog、启动清单与网页资产。 |
| `evidence/executions/results/` | 逐组规范化结果已经完整内嵌在总报告/快照，248 份独立 JSON 是重复导出；默认不再生成。 |
| `evidence/executions/history/`、`plans/` | 已替代中间复跑、重复旧报告与旧计划过程备份；归档索引保留其摘要、失效原因与正式历史来源。 |
| `evidence/public-entrypoints.json` | 当前由采集器推导，历史已保存在快照；阅读器使用内嵌数据。 |
| `evidence/bundle-report.json`、`validation.json` | 可再生的体积报告，以及版本化验证报告的重复导出。 |
| `evidence/ui/` | UI 文字观察已完整并入对应迭代验证记录，旧截图已清理。 |
| `v5-v7-scope.json`、`v6-full-scope.json` | 与相应 validation 中的 `scopePreservation` 完全相同。 |
| `reviews/atlas-maintenance-review-*`、`full-corrections-*` | 实现审查及修订过程记录已完整并入相关迭代验证报告；逐文件 source review 仍单独保留。 |

不要用“有引用”直接推导“必须另存一个文件”。应核对内容是否已在正典中完整保存、调用方是否只因旧实现要求文件存在，以及移除后能否核验或恢复。也不能只凭“由工具生成”就删除实际观察证据。

这里的历史排除是用户明确选择的交付范围：本机历史保持，其他机器需另行导入。本轮只调整 Git 规则，没有添加来源索引、改写存储或消除读取器对历史的依赖；新检出使用历史阅读和相关来源校验前，需要补回本地历史目录及指针。

## 日常命令

在本目录运行：

```sh
npm ci
npm run dev
npm run collect
npm run check:files -- --details
npm run execution:verify
npm run snapshot:verify
npm run check
```

- `check:files` 审计 Git 候选，包含已被 Git 跟踪但后来加入忽略规则的文件。未知材料、派生物或核心文件缺失会失败。
- `execution:verify` 只核对所存执行记录的身份、计数、摘要和可还原性，不运行测试，也不检查当前源码新鲜度。
- `snapshot:verify` 核对物理块、原文摘要和历史语义，不把历史结论升级为当前结论。
- `dev`、`build`、`typecheck` 会先采样生成所需 live 数据；新检出不需要提交或复制已有缓存才能运行。
- `check:current` 严格检查当下来源及执行资格；`check` 不会绕过这一门。源码过期时可以构建阅读器查看诊断，不能据此封存新的“已通过”版本。
- `test:scoped -- --resume` 必须先确认计划的测试来源和选择器仍有效；采集器复用前校验旧记录，不能仅因状态写着 pass 就信任它。
- 若总报告自身已损坏，应先保留副本并从核对过的备份/历史来源恢复，或明确隔离旧报告后重新采集；执行器不会自动清空坏记录或跳过摘要错误。
- 先 `npm run build` 再 `npm run report:bundle`，避免混用不同生成时点的数据清单和构建清单。

需要恢复单组规范化 JSON 时，明确选择来源和组：

```sh
npm run execution:export -- --source current --group full-depth-code-search-deadline
npm run execution:export -- --source agent-atlas-2026-10-23-v6 --group full-depth-code-search-deadline
npm run snapshot:restore -- --id agent-atlas-2026-10-23-v6
```

输出只进入 ignored `.cache/`。同名组可能存在于不同版本，不能自动猜来源；目标已有不同内容时拒绝覆盖。旧 schema 1 不支持冒充 schema 2 的精确结果导出。

## 本次整理的已知来源边界

2026-10-29 开始梳理时，产品基线已是 `a2edf10bff82d4ee36109dc7a394881e858cdcb4`。63 篇地图中 54 篇输入匹配，9 篇已有来源变化；其中 `terminalSafety.ts#classifyRawChunk` 已无法定位。三条阅读记录的来源变化分别是 `terminalSafety.ts`、`runtime-terminal-safety.test.ts` 和 `terminal-safety-path-escape-wrappers.test.ts`。

本轮整理不重新审阅这些产品实现，也不更新它们的旧摘要。改了 Atlas 采集/校验代码以后，旧执行记录还会因 harness 变化而过期；这与产品来源变化是两件事。历史回执和七个版本原样保留，文件收敛不等于重新执行或重新审阅。

后续要恢复 `check:current`，应先重读变化的源码与断言，修订受影响正文/锚点、阅读记录和测试选择，再执行获审阅的计划。不能把本轮发现直接扩展为产品运行时修复需求。

## 文件审阅阶段结果（2026-10-29）

- 提交候选从 486 个、26.95 MB 收敛为 233 个、约 18.2 MB。248 份结果逐字节恢复一致后移出；其余 11 份重复导出/过程副本完整合并或带摘要归档。新增的六份文件是两份维护说明、两份维护脚本和对应两份回归测试。
- `check:files`、`execution:verify`、`snapshot:verify`、类型、lint、渲染回执检查及构建通过；104 项 Atlas 测试通过，其中包括六个真实受控组合场景及假 runner 的采集器入口回归。
- `npm run check` 在严格的 `check:current` 步骤拒绝通过：既有 9 篇来源过期及失效锚点保留，旧 112 组记录因来源或本轮 harness 变化待复核。本轮没有重跑该产品计划，没有刷新旧执行摘要。
- 569 个产品文件、83 个历史存储文件、当前执行总报告、阅读记录和最近封存指针保持原字节。五篇样板引用页仅因已核对的 harness 依赖列表调整而更新输入摘要，断言及产品源码未改。
- 当前与历史的内嵌入口数据、历史执行详情可在浏览器打开；过期页面仍明确提示复核。未新增截图文件。
- 本轮未提交或推送，因为请求范围是审阅与整理。过程日志和可恢复副本只留在 ignored `.cache/atlas-file-review-2026-10-29/`。

随后用户明确要求仅规划 Git 提交、历史只保留本机：已将 76 个 gzip 块、7 份清单及 1 个指针从提交候选中排除。本地 84 个文件未修改，不再为清理重新打包、压缩或改造存储。

再按明确的解包要求，本机七个版本恢复为各自目录中的 `snapshot.json`，原文 SHA 与历史阅读内容一致；压缩块和清单移至 ignored `.cache/history-unpack-2026-10-29/packed-originals/`。已有记录中的旧 `manifestPath` 表示原压缩形式，可按 `snapshotId` 找到同目录的普通 JSON。此次只恢复数据并更新说明，没有修改存储或产品运行时代码。
