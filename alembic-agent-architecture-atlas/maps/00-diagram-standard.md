---
schemaVersion: 1
diagramId: 00-diagram-standard
topic: "00"
title: 图谱阅读与维护规范
viewType: guide
truthKind: in-progress-worktree
reviewDepth: L0
verifiedAt: 2026-10-23
baselineCommit: 37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0
documentationOwner: AlembicAgent 架构文档维护者
sourcePaths: []
testPaths: []
contractPaths:
  - config/layer-contract.json
  - package.json
refreshTriggers:
  - package.json
  - tsconfig.json
sourceFingerprint: sha256:1af8ed977b20aad853ac5489a59f9ba66e7e11104e2c2916feea0f4b975a89a9
testEvidence: anchored
externalContracts:
  - "@alembic/core：公开包端口，本图不递归扫描其实现；宿主装配只核对本仓契约。"
reviewRecord: evidence/readings.json
generatedBy: mixed
---

# 如何阅读与维护这份图谱

先读[一次请求到工具回执](13-end-to-end/overview.md)，再按职责进入专题；修改代码时用文件与依赖页寻找真实消费者。

## 三类事实分开

| 事实 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| AST 直接依赖 | 当前解析配置下的 import、re-export、type-only、动态字面加载 | 函数一定被调用、宿主一定接线 |
| 源码调用说明 | 人工阅读当前实现与装配前提 | 当前进程已经成功执行 |
| 测试／渲染回执 | 明确输入范围、命令和 renderer 下的观察结果 | 真实网络、全部宿主、生产验收 |

图内每条边有稳定 E- 编号；选择边或编号跳到紧邻的证据表。路径／符号可以复制，未配置代码托管地址时不生成虚假的编辑器链接。测试 case 锚点保存精确标题的 URI 编码；定位通过不代表本轮运行通过。

## 元数据与审阅层级

L0=路径库存；L1=结构/直接导入；L2=有界实现与调用；L3=失败/状态/恢复语义；L4=可控组合执行；L5=实际宿主与持久化边界闭环。受控组合样板与知识纵切最高到 L4；逐文件失败／恢复页按 L3 标注，结构和调用专题按实际证据使用 L1／L2。全文阅读 full 是另一维度，不等于分支覆盖率。

truthKind=in-progress-worktree 表示来源包含当前工作树，不等于已提交或已发布。源码新鲜度在 collect/check 时按路径集合与精确字节计算，浏览器展示的是该检查时点；页面不会实时监视仓库。渲染依据只验证 Mermaid 输入摘要与版本；样板另验执行输入与测试摘要。

## 维护步骤

1. 在独立子包运行 collect/check:current，列出漂移文档和输入变化。
2. 重读实现、调用与测试断言，先改正文与边表，再更新该文档输入摘要；没有无条件批量刷新摘要的命令。
3. 浏览器 render:verify 逐图生成 SVG；check:render 只复验已经存在的回执。
4. 运行 test/typecheck/lint/check:current/build，审阅结果。snapshot --id 新名称创建不可覆盖的阅读快照并更新 current.json。
5. 不修改产品运行时代码，不把图谱加入根 workspace、根脚本、发布 files 或产品 CI。

历史快照保留原始日期、来源、图源、读者库存和独立验证回执；历史来源一致不等于今日代码一致。依赖图解析失败、布局失败和不支持的语法必须明确显示，不猜补调用边。


## 精确断言与来源继承

当前定向回执采用 schema 2：命令、采集集合摘要、完整名称／祖先套件、注册位置、集合内序号共同限定证据；同名参数实例有独立身份。AST区分 each 数据表起点和实际测试注册点。同一行的不同声明、过期输入以及同标题多个声明不能互借通过结果；存在歧义时保留“已定位／未绑定”。样板另保存真实测试全名与六场景身份。

当前页面只汇总自身明确引用的断言，选中 E 边后进一步缩小范围；未执行、歧义、来源变化与已通过分别解释。全局通过总数仅用于总览。关系索引给两条纵切显式区分 call、data-flow 与 ownership，静态依赖使用 import，状态视图使用 state-transition；未细分的旧关系仍标为 documented-relation，不推断动态调用。

阅读 schema 2 要求路径唯一、当前哈希、真实深度、继承版本及审阅材料相符；partial 不能通过修改一个字段升级为 full。精确旧字节可支持累计阅读，但必须注明未重新通读的部分。见[当前复核与退役去向](source-rebase.md)。

快照同时保存读取依据、关系和执行的自一致清单。浏览器投影有独立资产摘要；canonicalIntegrity只指向完整仓库快照的摘要，不冒称是裁剪后浏览器JSON的摘要。旧版不补造新身份或继承今天的执行状态。
