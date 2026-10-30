# AlembicAgent Architecture Atlas

AlembicAgent 的独立源码图谱与本地阅读器，收录 **13 个专题、63 篇地图与指南、103 张图、290 个源码文件**。内容以所读源码和采样工作树为准，不表示发布包或生产环境已经验收。

从[一次请求到工具回执](maps/13-end-to-end/complete-sequence.md)或[分析发现到知识候选回执](maps/13-end-to-end/knowledge-production.md)开始。也可按[专题](maps/README.md)、[源码文件](maps/file-index.md)、[宿主接入](maps/01-overall-architecture/public-api-and-hosts.md)阅读。

维护本子项目请读 [Atlas 自身架构与逐文件职责](docs/architecture.md)和[提交边界与维护方法](docs/maintenance.md)。

## 本地阅读

需要 Node.js 22.12+，本子包独立安装，不加入产品 workspace、构建或发布包。

```sh
cd alembic-agent-architecture-atlas
npm ci
npm run dev
```

打开终端打印的本地地址。阅读器提供：

- **从故障出发**：六个稳定入口覆盖观察回程失败、取消与超时、HOST 分类、创建后未就绪、scope 释放和 T3 来源差异。入口只索引原文，不复制故障事实。
- **来源与维护**：列出相对 v4 的新改删输入、正文引用与输入闭包、受影响执行组、主要及连带诊断。来源、阅读、执行、图形四种状态分别展示。
- **按页／按边证据**：只关联当前页面或选中 E 边的断言与实际回执；不能用其他页的全局通过数替代本页证据。
- **文件与依赖**：静态一跳导入、消费者、职责、行为链、失败边界、测试定位及复核来源。正文明确提及的页面优先。
- **搜索与版本**：诊断码、路径、符号和全文片段搜索；稳定段落定位；旧快照按需读取，缺少新索引时明确显示未记录。

图支持拖动、缩放、全屏、节点及边选择，图下保留可键盘操作的列表。窄屏证据栏在正文后。代码位置以仓库相对路径和符号提供；未配置托管或编辑器协议时不虚构跳转。

## 审阅记录与验证口径

2026-10-23 的 v6 审阅基线中，290 个源码有全文或累计全文记录：其中 53 个局部复核文件重新通读，33,370 库存行、323 连续语义段、209 条分支，其余 237 个按字节一致从 v5 继承。详见[逐文件索引](maps/file-index.md)与[完整复核证据](evidence/reviews/source-full-v6.json)。这不保证后续源码仍匹配；2026-10-29 的整理基线已有 9 篇来源过期和 1 个失效符号锚点，见[维护说明](docs/maintenance.md)。全文阅读不等于全部分支已测试，indexed 记录也不自动升级。

| 依据 | 可证明范围 | 边界 |
| --- | --- | --- |
| 文档检查 | 路径、符号、测试声明、直接导入、证据表与来源摘要 | AST 不证明调用已经发生，输入闭包不等于正文审阅 |
| 浏览器渲染 | 图源、Mermaid 版本及实际 SVG 尺寸 | 不提升行为验证等级 |
| 六场景样板 | 真实 Service/Builder/Runtime/Pipeline/Adapter/Router/code.read；成功、拒绝、两种取消、超时、partial | 脚本 provider、临时文件与受控宿主端口 |
| 定向执行 | [执行计划](evidence/execution-plan.json)中的当前 Agent 断言；[实际结果](evidence/scoped-execution.json)绑定精确采集身份 | 跳过项不算通过，未验真实 AI、生产宿主或 Core 内部 |

样板断言第二轮 role=tool、toolCallId=pilot-read 真实包含成功读取及失败项。Service success、工具信封、领域 outcome、created、readiness 与发布是不同事实；取消不表示副作用回滚。

## 维护命令

```sh
npm run collect                    # 采样产品，输出本子包 ignored evidence/live
npm run status                     # 只读状态与增量影响报告，默认比较 v4
npm run status -- --baseline <id>   # 指定已有历史版本作比较
npm run check:current               # 文档、输入、证据与范围隔离检查
npm run check:files -- --details    # 逐文件核对提交边界，不等于来源已更新
npm run execution:verify            # 内嵌执行记录自一致性，不运行产品测试
node scripts/check-full-review.mjs  # 53个全文记录的哈希、连续分段、源码和断言定位
npm run test                       # 解析/校验反例、阅读逻辑、六场景样板
npm run test:scoped -- --resume     # 仅执行计划中输入变化或未通过的组
npm run test:scoped -- --group <id> # 重跑一个已审阅计划组
npm run render:verify              # 浏览器逐图生成真实回执
npm run check:render               # 仅核对已有渲染回执
npm run check                     # test/typecheck/lint/files/current/render/build
npm run report:bundle             # 先build再统计；不是实测加载时间
npm run snapshot -- --id <new-id>  # 检查通过后追加不可覆盖版本
npm run snapshot:verify            # 校验所有历史的块、原始字节摘要与语义，显示实际占用
npm run snapshot:migrate           # 将已有旧格式迁移到共享存储，可中断后重跑
npm run snapshot:restore -- --id <id> # 导出原始 JSON 到 ignored .cache/snapshot-exports/
npm run execution:export -- --source current --group <group-id> # 显式恢复单组结果到 .cache/
```

执行计划先核对测试源码摘要；每组保存命令、时间、Node/Vitest 环境、采集序号、完整名称、祖先套件、位置、实际结果及前后输入。case ID 由集合摘要和序号共同确定，同名参数实例不会合并；旧 schema 1 不自动升级。完整结果已经内嵌在总报告和历史快照，不再提交或默认生成 `evidence/executions/results/` 的重复文件。校验时核对原存摘要，需要文件时显式选择来源和组进行导出。还原相等只证明记录自一致，不是重新执行或独立见证。旧 267 次记录仍完整保存在 v4 快照的 `scopedRuns` 中，过程材料见[归档索引](evidence/executions/archive-index.json)。

动态 Runtime 和读取仓库的测试采用保守源码／测试／helper／fixture／脚本／文档／配置闭包；五个明确核实的脱敏组使用较窄输入。Core只记录已安装公共依赖的观察身份，其内部字节未由本图谱冻结。输入一致是Agent侧采样判断。

来源变化后先复核实现与断言，再改正文、边表和输入摘要。本目录没有自动无条件刷新文档指纹的命令。只改Atlas正文不会令产品测试失效；改图源需重新渲染。修改采集器或其依赖会让执行回执失效。

新快照的规范化内容摘要检查清单自一致，不是外部签名或不可篡改保证，也不备份所有未提交源文件。旧版保留原证据等级。网页只承诺采样时点，重新 collect 才获取新状态。

## 本地历史资料（不提交）

`evidence/snapshots/` 和 `evidence/current.json` 仅保留在本机，由 Git 忽略。提交规划只决定收录范围，不要求把本地文件打包或压缩；存储格式与 Git 收录范围分开管理。下面记录已有实现，不代表必须采用压缩格式。

按后续解包要求，2026-10-29 已将本机 7 个版本恢复为 `evidence/snapshots/<id>/snapshot.json`，日常读取直接使用普通 JSON。旧压缩表示移至 ignored `.cache/history-unpack-2026-10-29/packed-originals/`，不再参与读取；原文摘要与历史网页内容保持一致。

新检出不会携带这些本地资料。历史阅读，以及目前依赖历史基线的来源追溯和完整校验，需要另行补回该目录及指针；此次没有改造读取流程来消除这些本地依赖。

此前的压缩实现使用 `evidence/snapshots/<id>/snapshot.store.json` 清单与 `objects/*.json.gz` 共享块，曾将占用从 76,619,313 B 降至 6,567,659 B。它只按 JSON 顶层属性边界切原 UTF-8 字节，不重新序列化；空白、键顺序、来源和已有 integrity 均能逐字节还原。清单绑定每块及整份原文的长度与 SHA-256，块地址按解压后的字节计算。

每个版本独立引用所需块，不依赖另一个历史版本作为父版本。读取时先检查存储，再沿用原 schema 的语义校验；旧 schema 1 不因迁移而升级。新快照也复用同一存储层。源码审阅、v4 维护比较与 v5 全文审阅基线均通过统一读取入口访问，网页内容与历史证据等级保持。

旧 `snapshot.json` 仍可读取；迁移中两种格式并存时必须字节相同，否则明确报错。迁移先完成全量预检和原文备份，再发布并核对清单，最后移除活动目录中的旧文件。恢复副本在 ignored `.cache/snapshot-storage-migration/originals/`；正常导出使用 `snapshot:restore`，遇到已有不同内容会拒绝覆盖。命令支持中断后重跑，不承诺多文件断电事务。

历史报告中旧 `snapshot.json` 路径表示该 ID 的完整逻辑快照，可用恢复命令导出原字节。不要直接编辑清单或共享块，也不要随一个版本删除其引用块；本轮没有自动垃圾回收。缺块、损坏、非法大小或丢失正文会产生诊断，不会悄悄改用另一版。迁移说明与验证见[存储迁移记录](planning/2026-10-23-snapshot-storage.md)。

## 边界与留档

`maps/` 的 Markdown/Mermaid 是说明正典；AST、关系索引和构建资产是派生物，阅读器源码则是需要维护的程序。本目录没有真实模型、产品写接口或发布入口。本地渲染端点只接受同源固定操作，不能指定任意文件路径。

保留的实现边界包括：scope释放可能永久等待；HOST诊断覆盖执行后的部分处理；终端本地超时可能折叠为137；T1/T3有明确语法窗口与跳过；跨Runtime原文摘要不共享；见证通道另有准入规则。这些记录不构成产品修复授权。

提交内容包括手写源码、地图、维护约定、执行计划、人工审阅与实际观察记录。本地历史快照、重复导出、缓存和临时材料排除；完整分类由 `check:files` 与[维护说明](docs/maintenance.md)共同说明。Git 排除不等于删除本地资料，也无需为减少待提交文件而重新打包压缩。

视觉复核截图是临时附件，不参与页面渲染或来源校验。旧 PNG 已清理，UI 文字观察已完整并入对应版本化验证报告，`evidence/ui/` 不再提交。历史截图路径只记录当时采集位置；后续临时材料统一写入 ignored `.cache/`，历史通过数不表示当前结果。

`node_modules/`、`dist/`、`.cache/` 和 `evidence/live/` 均不提交。`evidence/bundle-report.json` 可由 `npm run report:bundle` 重新生成，默认命令只输出报告。验证结果统一保存在 `evidence/iterations/`，不再提交重复的 `evidence/validation.json`。早期实施草案、一次性计划检查输出、已完整嵌入版本化报告的重复记录，以及失效的中间复跑原始材料，均不需要重复提交；本地恢复副本暂存于 ignored `.cache/`，新检出不含这些副本。历次报告中的旧 `executions/history/` 路径按上述归档索引追溯。

历史设计与实施见[当时的批准方案](planning/2026-10-23-status-and-roadmap.md)、[v5结果](planning/2026-10-23-implementation.md)和[53文件全文审阅](planning/2026-10-23-full-source-review.md)。这些材料不是当前状态或新的任务授权。图谱独立维护，不接入产品构建、发布或运行时代码。
