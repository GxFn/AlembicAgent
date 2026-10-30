# Atlas 自身的架构与文件职责

本文说明阅读器和证据工具的实现。AlembicAgent 的产品架构仍从 [maps 索引](../maps/README.md)阅读。Atlas 是仓库内的独立私有子包，产品源码只读，不接入根 workspace、构建、发布或 CI。

## 数据从哪里来

1. **人工事实**：`maps/` 的 Markdown、Mermaid、E 边表，以及 `evidence/readings.json`、逐文件审阅记录。它们描述读过什么、如何理解、哪些分支仍缺证据。
2. **实际观察**：样板、定向执行和浏览器渲染分别写入各自回执。执行计划只定义要运行的选择器，不能证明已经通过。
3. **当前采样**：`atlas-lib.mjs` 只读扫描 Agent 源码，解析文档，装配公开入口、关系索引、来源与维护状态。它会检查来源变化，不自动重写审阅摘要。
4. **阅读投影**：`collect.mjs` 和 `browser-data.mjs` 生成 ignored `evidence/live/`。启动清单只包含资产身份；当前目录和每个历史版本分别加载。
5. **浏览器展示**：`loader.ts` 验证 URL、长度、摘要与版本身份，`model.ts` 解释状态，`main.ts` 组装页面，`diagrams.ts` 渲染可交互的矢量图。浏览器不承担源码重审或重新执行测试。

`evidence/current.json` 是**最近封存版本的指针**。阅读器中的“当前采样”来自 `collect`，二者不是同一个概念。

该指针与 `evidence/snapshots/` 是本地历史资料，按当前提交策略不进入 Git。以下存储说明描述已有实现；本地文件是否压缩不决定 Git 收录范围。新检出需要另行补回历史资料，才能使用依赖它的历史阅读和来源核验。

## 六份阅读器源码

| 文件 | 职责与边界 |
| --- | --- |
| [main.ts](../src/main.ts) | 启动、路由、版本选择、首页/文档/文件/故障/维护页面、搜索与证据弹窗；组织 DOM，不持有另一份事实库。 |
| [loader.ts](../src/loader.ts) | 校验并按需加载资产；缓存成功载荷，拒绝迟到选择覆盖较新的页面。 |
| [model.ts](../src/model.ts) | 浏览器数据类型、路由、搜索和证据资格判断；区分当前、过期、历史及未记录。 |
| [sections.ts](../src/sections.ts) | 稳定标题定位、同名段落处理与搜索片段。 |
| [diagrams.ts](../src/diagrams.ts) | Mermaid/Cytoscape/ELK 按需加载、布局与画布生命周期、图节点/边交互、实际渲染验证。 |
| [styles.css](../src/styles.css) | 页面、正文、图形和窄屏布局；图谱不依赖 PNG 素材。 |

`main.ts` 同时承担多个页面的组装，是当前最集中的实现文件。其事实解析、状态判断、资产加载和图形生命周期已有独立边界；本轮没有为目录整齐而重写页面结构。

## 脚本逐文件职责

| 文件 | 输入与输出 |
| --- | --- |
| [atlas-lib.mjs](../scripts/atlas-lib.mjs) | AST 库存、来源摘要、文档元数据/锚点/边表校验及完整 catalog 装配。元数据规则从根 `metadata.schema.json` 读取。 |
| [public-entrypoints.mjs](../scripts/public-entrypoints.mjs) | 根据产品 package exports 和源码生成公开入口清单；不执行包导入 smoke。 |
| [relations.mjs](../scripts/relations.mjs) | 段落、断言、E 边、故障入口关联及内嵌证据链接；CLI 与浏览器共用纯逻辑。 |
| [relations.d.mts](../scripts/relations.d.mts) | 共享关系模块的 TypeScript 声明。 |
| [maintenance.mjs](../scripts/maintenance.mjs) | 阅读来源、执行集合/结果摘要、计数与继承校验；维护影响分析和快照语义摘要。 |
| [evidence.mjs](../scripts/evidence.mjs) | 证据 JSON 读取、schema 分级、历史加载诊断及当前验收资格。 |
| [full-review.mjs](../scripts/full-review.mjs) | 全文记录、连续分段、分支和断言证明的纯校验。 |
| [check-full-review.mjs](../scripts/check-full-review.mjs) | 结合 v5 基线和当前源码执行 53 文件全文记录检查；存储正确不等于这些来源仍新鲜。 |
| [check-atlas.mjs](../scripts/check-atlas.mjs) | 文档、来源、逻辑/文件链接、专题完整性及与产品包隔离的检查入口。 |
| [check-files.mjs](../scripts/check-files.mjs) | Git 提交候选的分类单源；排除派生物、拒绝未知文件和缺失核心材料，不评价源码事实新鲜度。 |
| [collect.mjs](../scripts/collect.mjs) | 写入 ignored live 目录；采样有诊断时仍能生成可查看诊断的阅读数据。 |
| [browser-data.mjs](../scripts/browser-data.mjs) | 将完整 catalog 投影成浏览器真正使用的字段，为每份资产计算摘要。 |
| [status.mjs](../scripts/status.mjs) | 当前状态与相对指定历史基线的影响报告，只读。 |
| [run-scoped.mjs](../scripts/run-scoped.mjs) | 执行已审阅测试选择器，记录身份和前后输入；复用前验证旧记录，原子保存总报告，不再写逐组结果文件。 |
| [execution-results.mjs](../scripts/execution-results.mjs) | 核验内嵌结果、按明确来源导出单组 JSON，以及总报告的原子写入；不运行测试或刷新来源。 |
| [render-contract.mjs](../scripts/render-contract.mjs) | 图源身份及渲染回执约束。 |
| [render-contract.d.mts](../scripts/render-contract.d.mts) | 上述共享模块的类型声明。 |
| [render-state.mjs](../scripts/render-state.mjs) | 渲染尝试状态、完成资格与最近一次尝试的有效性。 |
| [render-state.d.mts](../scripts/render-state.d.mts) | 渲染状态模块的类型声明。 |
| [check-render.mjs](../scripts/check-render.mjs) | 核对已有回执与图源/渲染器一致；不会冒充新一次浏览器渲染。 |
| [report-bundle.mjs](../scripts/report-bundle.mjs) | 读取构建和 live 清单，报告资产体积。应先 build；体积不是实测网络加载时间。 |
| [snapshot.mjs](../scripts/snapshot.mjs) | 通过来源、执行和渲染门后创建新的不可覆盖版本，最后更新最近封存指针。 |
| [snapshot-store.mjs](../scripts/snapshot-store.mjs) | 原始字节分块、共享压缩存储、完整性与路径/大小保护；不改变快照语义。 |
| [snapshot-storage.mjs](../scripts/snapshot-storage.mjs) | 物理存储 verify/migrate/restore，先预检和备份再迁移，支持中断后重跑。 |

## 执行证据只有一份数据来源

完整的 `collection`、`cases`、`exitCode` 已保存在 `scoped-execution.json` 的组记录中，历史版本也保存了当时的组。原先逐组写出的 JSON 只是这些字段的固定投影：`schemaVersion`、`groupId`、`collection`、`cases`、`exitCode`。

现在采集器、检查器与显式导出共用 `normalizedExecutionArtifact`。读取时对照**原存** `resultArtifactDigest`、`collectionDigest` 和 `resultDigest`，不会重算后覆盖声称摘要。旧 `resultArtifact` 字符串保留为历史导出标识，不再要求该路径存在实体文件。耗时等观察字段仍完整保留。

这证明记录自一致，不是独立原始输出、外部签名或重新执行。原 Vitest 临时输出本来就在采集后删除；重复保存两个相同投影并不会增加独立证明。`running` 不能当通过，失败/取消结果仍保留，schema 1 不升级成 schema 2。

## 历史存储与阅读投影

读取器同时支持普通 `snapshot.json` 和压缩格式。本机七个版本已按后续要求解包，直接读取普通 JSON。压缩格式中，每个 `snapshot.store.json` 独立引用 `objects/*.json.gz`；块按原 UTF-8 顶层属性边界切分，解压后核对块及整份原文的长度/SHA。两种格式都没有依赖前一版本的父链，读取后继续原有 schema 和 integrity 校验。当前实现不能从今天的产品源码重造过去的阅读状态。

共享块不可随意删除。丢失/损坏的版本会报错，不能被当作空 ID 重占，也不能悄悄回退到另一版。新目录认领后的同步失败只回收本次创建的空目录，不删除竞争者的目录。存储不承诺多文件断电事务；原始恢复副本和导出放在 ignored `.cache/`。

网页仍使用完整逻辑快照的投影，不直接理解分块格式。`evidence/public-entrypoints.json` 和 `evidence/scoped-execution.json` 在阅读器正文中是内嵌证据引用：分别指向所选版本的 `publicApi`、`scopedRuns`。其中公开入口无须另存独立 JSON；静态 Markdown 阅读时应把该链接理解为阅读器功能。

## 五种结论不能互相替代

| 依据 | 能说明什么 | 不能推出什么 |
| --- | --- | --- |
| 人工全文审阅 | 已检查的职责、流程、分支、疑点 | 全部分支都被测试 |
| AST/路径/符号校验 | 声明、直接导入和引用定位 | 动态调用确实发生 |
| 实际执行回执 | 对应采集身份的断言结果 | 真实 AI、生产宿主或 Core 内部验收 |
| 来源与 harness 摘要 | 所声明输入是否仍一致 | 内容语义已重新审阅 |
| 浏览器渲染回执 | 图源在所记录渲染器中生成有效 SVG | 产品行为正确 |

来源变化必须保持可见。文件整理、存储迁移或摘要还原都不能把旧结论改为当前通过。

## 配置和测试

根配置分工：`package.json`/锁文件定义独立依赖与命令；`atlas.config.json` 定义专题、扫描范围和 v4 比较基线；`metadata.schema.json` 是文档契约单源；`index.html` 是浏览器入口；`vite.config.ts` 管理本地服务与固定同源渲染端点；`tsconfig.json`、`vitest.config.ts`、`biome.json` 分别限定类型、测试和代码规范。根 AGENTS 与本目录 AGENTS 共同限定写入范围。

| 测试文件 | 核对的边界 |
| --- | --- |
| `atlas.test.mjs` | AST、元数据、证据引用与图规则 |
| `browser-data.test.mjs` | 浏览器投影、独立资产身份及历史分离 |
| `evidence.test.mjs` | 缺失/无效证据、旧 schema 和验收资格 |
| `full-review.test.mjs` | 全文记录、连续分段、分支及错误升级 |
| `maintenance.test.mjs` | 采集身份、计数、原摘要、来源继承及未完成状态 |
| `public-entrypoints.test.mjs` | 公开出口的静态解析与边界 |
| `relations.test.mjs` | 稳定定位、精确断言关联及逻辑证据链接 |
| `render-state.test.mjs` | 最近尝试、并发和失败后的资格 |
| `snapshot-store.test.mjs` | 字节还原、共享、损坏、限额、路径、并发与认领失败恢复 |
| `snapshot-storage-command.test.mjs` | 迁移预检、备份、恢复、覆盖拒绝与命令边界 |
| `snapshot-history.test.mjs` | 缺失版本诊断、原 schema 与浏览器资产保持 |
| `execution-results.test.mjs` | 单源核验、显式导出和报告原子写入 |
| `file-policy.test.mjs` | 提交分类、被跟踪的忽略文件、未知/缺失/链接路径 |
| `loader.test.ts` | 资产损坏、版本身份、快速切换与迟到响应 |
| `reader.test.ts` | 当前/历史/过期展示资格及阅读定位 |
| `pilot.test.ts` | 真实 Agent 组合链的六个受控场景 |

类型检查覆盖阅读器和 Vite/Vitest 配置；测试 TS 还由 Vitest 转换执行。DOM 和图形交互仍需实际浏览器核对，不能只用纯逻辑单测代替。
