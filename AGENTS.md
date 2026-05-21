# AlembicAgent Agent Instructions

**重要**：本项目是 Alembic 的独立 Agent / AI / Tool 仓库，不是用户项目环境，也不是 Core、Dashboard 或 Codex 插件仓库。

Agent 可以制定目标和计划，但目标和计划必须服务于用户提出的真实任务，不能被 Agent 自己偏好的“干净”“薄”“轻量”“空壳”“先搭框架”等路线替换。

Agent 不得把完整实现改成薄实现，不得把成熟能力改成空壳接口，不得把迁移、整理、重构、优化或拆仓解释成削减功能。

当 Agent 的计划涉及删减、替换、降级、延期、只做部分、只搭框架、只保留接口、暂不接入或改变完整范围时，必须先向用户确认。

不要在旧工作区或旧克隆路径下工作；当前统一以本 workspace 内的 Alembic 系列仓库为准。

## 文档存储提示

- 新建长期迁移、计划、验收、扫描、边界和跨仓库任务文档时，统一写到 workspace 根目录的 `docs/AlembicAgent/`，不要散落到各子仓库或 workspace `docs/` 根层级。
- AlembicCore 迁移手册、公开 API 边界、阶段验收、外层接入和删除任务统一写到 `docs/AlembicCore/`；本仓库只执行其中分配给 `AlembicAgent` 窗口的任务。
- 仓库内 `docs/` 只放随源码长期维护的产品文档、发布文档或用户文档；不要放跨仓库协作临时文档。
- 长期文档不得写入用户本机绝对路径、API key、token 或其它私密信息。

## 操作范围

- 本仓库任务只修改当前 `AlembicAgent` 仓库内的文件，并只在该仓库内提交。
- 不要主动修改、整理、格式化、提交或回退 `AlembicCore`、`AlembicDashboard`、`AlembicPlugin`、`Alembic` 或其他相邻项目。
- 其他 Alembic 仓库只可作为只读背景参考；如果 Agent 功能必须依赖其他仓库变更，先说明边界和所需接口，再等待用户明确授权。

## 仓库定位

- `AlembicAgent` 是 Alembic Agent、AI 编排和 tool system 的独立仓库，负责宿主 Agent 能力、工具注册与执行、工具策略、AI provider adapter、任务计划、执行循环、上下文装配和可观测事件。
- 本仓库不承载 Core 的确定性内核实现，不承载 Dashboard UI，不承载 Codex plugin marketplace/channel，也不承载 CLI/daemon/native/IDE 的具体交付壳，除非这些内容是 Agent runtime 的必要 adapter。
- Core 负责可复用、确定性、可测试的 workflow/session/briefing/persistence/contract、repository、service、search/vector、AST/grammar、Guard 和 Project Intelligence 内核能力。
- Agent 负责使用宿主 Agent 或 AI provider 去完成非确定性分析、代码扫描、知识挖掘、工具调用、任务分解、执行监控和结果归档。
- 插件依赖 Codex 宿主 Agent 的场景，不要求本仓库重新实现 Codex Agent；本仓库应沉淀通用 Agent/tool contract、adapter 和可复用执行逻辑。

## Core 接入规则

- 共享确定性能力通过 `AlembicCore` 和 `@alembic/core` 包入口接入。
- 在 AlembicWorkspace 本地开发和总控验收中，本仓库是 local-source-first 基线：`@alembic/core` 依赖必须保持为 `file:../AlembicCore`，安装后的 `node_modules/@alembic/core` 应解析到 workspace 内相邻的 `AlembicCore` 源仓库。
- 本仓库的 Core import boundary scanner 必须使用相邻源码仓库脚本：`node ../AlembicCore/scripts/lint-consumer-core-imports.mjs . --config config/core-import-boundary.json`，并通过 `npm run lint:core-import-boundary` 纳入验证。
- 不要绕过 `@alembic/core` 包入口直接引用 Core 源码内部路径。
- 需要修改 Core 能力时，先在 `AlembicCore` 仓库完成、验证、提交，再更新本仓库接入。
- vendor、submodule、远程 npm 包或 portable snapshot 指针不是本仓库日常开发入口；只有 release、离线安装、portable runtime 或 workspace 外独立运行场景需要时，才另行记录源 commit 和快照来源。
- 不要把 Core 已有的 repository、SQLite/Drizzle、workflow contract、Guard、search/vector、AST/grammar 复制成第二套实现。
- Agent 侧只保留 AI/tool/host adapter、orchestration、policy、runtime wiring 和非确定性执行边界。

## 本仓库必须保留的边界

- Agent planning、task loop、execution state、context assembly、memory handoff。
- Tool registry、tool schema、tool permission、tool execution、tool result normalization。
- AI provider adapter、model routing、prompt/template、token/budget、retry、rate-limit 和错误分类。
- 宿主 Agent 接入 adapter，例如 Codex、CLI agent、local daemon agent 或后续宿主。
- 代码扫描和知识挖掘的 Agent 侧 orchestration：由 Agent 驱动分析、调用 Core contract 和持久化结果。
- 可观测事件、trace、diagnostics、audit log 和安全策略。

这些能力不能因为 Core 存在而被移动、空壳化或删除。

## 不属于本仓库的内容

- Dashboard 页面、组件、前端状态和可视化属于 `AlembicDashboard`。
- Core 确定性内核、repository、SQLite/Drizzle migration、AST/grammar、Guard 和 search/vector 基础能力属于 `AlembicCore`。
- Codex marketplace/channel、Codex Skill 文案和插件发布链路属于插件交付仓库。
- 主仓库或产品仓库的 CLI/daemon/native/IDE 交付壳，只在需要接入 Agent runtime 时提供 adapter，不在本仓库重新实现完整产品壳。

## 需要测试时

- 新建项目后，应在 `package.json` 中提供清晰脚本，例如 `npm run build`、`npm run lint`、`npm run test`、`npm run typecheck`。
- Tool registry、permission、schema、adapter 和 execution loop 改动必须有单元测试。
- AI provider adapter 改动需要 mock provider 测试，不能依赖真实 API key 才能通过。
- 与 Core contract 交互的改动需要类型检查和边界测试。
- 涉及实际工具执行、文件系统、shell、网络或宿主 Agent 的能力，必须覆盖成功、失败、取消、超时、权限拒绝和部分结果场景。

## 文件存放约定

- 正式源码优先放在 `src/`。
- Agent runtime 放在 `src/agent/`。
- Tool system 放在 `src/tools/`。
- AI provider adapter 放在 `src/providers/` 或 `src/ai/`。
- Host adapter 放在 `src/hosts/`。
- Policy、permission、budget 和 diagnostics 放在 `src/policy/`、`src/security/`、`src/diagnostics/` 或本项目约定目录。
- 测试放在 `test/` 或与源码同目录的 `*.test.ts`。
- 构建产物如 `dist/` 必须保持 ignored，不提交。
- workspace 级长期协作文档按上方 `文档存储提示` 归档。

## 技术栈与编码约定

- 默认技术栈：TypeScript、Node.js >= 22、ESM；如果项目初始化时选择其他技术栈，必须在本文档同步更新。
- import 路径按当前 TypeScript/NodeNext 约定保持可构建；如果使用 ESM 编译到 Node，源码相对 import 通常需要 `.js` 后缀。
- Lint / Format 优先与 Alembic 系列仓库保持一致，使用 Biome；不要无必要引入第二套格式化体系。
- Tool schema 和 Agent contract 必须类型明确、版本清楚、可序列化、可回放。
- 必须尽量多地在代码旁补充简体中文说明，优先解释 Agent 边界、工具权限、安全策略、复杂状态机、分叉原因、降级原因、兼容路径、宿主差异和后续校验方式。
- 任何运行时分叉、fallback、降级、兼容转译、跳过、短路、重试、取消或错误归类，都必须打印足够明确的日志或诊断事件，日志要能看出触发条件、选择路径、关键输入、结果状态和后续校验依据；尤其要区分 native tool call、兼容转译、parser fallback 和 degraded path。

## 类型安全与代码规则

- 外部输入、AI 输出、tool result 和宿主事件都必须先验证或归一化，再进入核心执行流。
- `catch` 块使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`。
- 避免 `as any`；不得已时在附近说明真实边界原因。
- `throw` 只能抛出 `Error` 实例。
- if/else/for/while 必须使用花括号。
- 不要把 API key、token、用户路径或本机绝对路径写入长期文档、fixture 或提交。
- 不要回退其他窗口或用户已有改动；如果工作区已有无关变更，只处理当前任务需要的文件。

## 长期维护规则

- 改 Agent/tool 前先确认 Core contract、宿主边界和真实调用链。
- 删除旧 tool 或 adapter 前必须有扫描结果、替代入口、迁移说明和测试证据。
- Agent 能力要保持可观察、可取消、可恢复；长任务必须能报告进度和失败原因。
- AI 行为必须有 deterministic shell：输入 contract、输出 schema、预算、错误分类和持久化边界要清楚。
- 如果某个能力属于 Core、Agent、Dashboard、插件还是主仓库不确定，先做边界判断并记录理由；不要为了拆仓好看裁掉真实链路。
