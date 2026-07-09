# AlembicAgent Agent Instructions

<!-- wakeflow:scope:start -->
## Workspace Access Card

This section is maintained by the Wakeflow runtime installer. It records this window access coordinates and the minimum automation gate. Hard rules come from the parent AGENTS and this file; do not duplicate repository-specific rules here.

### Coordinates

- Wakeflow runtime: `..`
- Window name: `AlembicAgent`
- Parent workspace AGENTS: `../CLAUDE.md`
- Active workspace index: `../.wakeflow-active/index.md`
- Active workspace status: `../.wakeflow-active/current/workspace-current-status.md`
- Current plan directory: `../.wakeflow-active/current`
- Window ledger: `../wakeflow-ledger/AlembicAgent`

### When claiming workspace work

1. Read this file first.
2. Then read parent `../CLAUDE.md`.
3. Then read `../.wakeflow-active/index.md` and `../.wakeflow-active/current/workspace-current-status.md`.
4. If there is a current plan, task package, or direct-thread delivery, execute only the content under `../.wakeflow-active/current` explicitly assigned to `AlembicAgent`.
5. Goals, scope, forbidden actions, validation commands, and backfill fields come from the current plan, task package, and repository rules. Prompts are only wakeup entrypoints, not the full task specification.
6. If a keyword, familiar command, script hint, or urgency is pulling you into action before a safe operation, recovery boundary, and one-sentence plan are clear, stop and report the blocker.

### Direct Thread Dispatch Minimum Gate

- Direct-thread delivery is the normal work transport. It does not change this window responsibility or expand task scope. Specific work comes from the dispatch packet, current plan, and repository rules.
- Delivery prompts carry only a few dynamic variables and a skill pointer. Do not treat the prompt as a full command manual. State-machine routes need only visible `currentWindow` / `taskId` / `stateRoot` / optional `dispatchGroup`. Machine fields such as `controllerWindow`, `returnPolicy`, `humanContextRef`, and `stateRevision` are read from the state root, dispatch group, and delivery envelope. Stop and report if `stateRoot` is missing or variables conflict.
- This window only handles dispatch packets for `AlembicAgent` and returns `TargetResultEnvelope`. Do not claim, accept, or process other window tasks.
- Child windows do not create target-to-target next-hop delivery by default. Evidence repair, redispatch, and next phases are decided by controller review. If delivery has `returnRoute=controller` and `review-results` shows that `DispatchGroup.returnPolicy` allows a callback, create exactly one controller-return envelope with `build-controller-return`, returning by default to the original controller named by `DispatchGroup.controllerWindow`. Then complete the real direct-thread send, readback, and `record-delivery-run`. A controller return is complete only when a `DirectThreadDeliveryRun` exists with `status=sent` and `readback.ok=true`. The full group snapshot stays in the controller-return envelope; the visible prompt shows only non-empty exceptional targets and must not treat one target backfill as whole-group completion.
- Non-Test windows must not create, process, or verify Test delivery unless both the current plan and delivery envelope explicitly authorize it.
- Thread ids may only be written to Wakeflow local runtime. Do not write them to tracked documents, backfill text, or GitHub.

### Skill Assistance

- Claude Code subagents (the Task/Agent tool) are recommended for bounded parallel assistance such as code search, log triage, test localization, and evidence summarization. Treat subagent output as evidence or advice only; it must not accept work, dispatch another window, write controller state, or expand repository boundaries.
- Development work uses the plugin execution-craft skill `wakeflow-target-craft` (test-first, systematic debugging, self-review by severity, scope discipline, verify-before-done) so it earns the machine-checkable evidence the controller acceptance gate requires. It loads via the Wakeflow plugin alongside `wakeflow-target`; this window does NOT use the Design or Test windows' built-in skills.

### Functional Completeness Self-Check

Before returning a `TargetResultEnvelope` or handoff, this child window must self-check the assigned feature or evidence path for functional completeness. Do not rely on the controller to discover obvious gaps.

- Re-read the state root, task package, current plan, repository rules, and acceptance/evidence requirements.
- Verify the implementation or evidence covers the requested behavior end to end, including edge cases, integration boundaries, docs/config/API surfaces, and tests that the target window can reasonably run.
- Compare the final diff/evidence against the original user goal and explicit non-goals; do not downgrade a complete capability into a thin adapter, placeholder, mock-only flow, or partial scaffold.
- When recommending follow-up work, label whether it is authorized by the original requirement or only discovered by code/test inspection. Residual implementation fields, existing tests, old adapters, and target observations do not become new requirements unless the original plan, requirement design, or a user/controller decision allows them.
- If completeness cannot be proven inside this window boundary, return `blocked` or `needs-review` with the missing evidence and next recommendation instead of reporting `completed`.

### Document Destinations

- Long-term cross-repository collaboration docs, plans, acceptance records, scans, and boundary records go to `../wakeflow-ledger/AlembicAgent`. This repository `docs/` is only for product, release, or user docs maintained with the source.
<!-- wakeflow:scope:end -->

## 本窗口最高停止卡

本仓库是 Alembic 的独立 Agent / AI / Tool 仓库，不是用户项目环境，也不是 Core、Dashboard、Codex 插件或本地 CLI/daemon 交付壳。本节是仓库级执行前停止卡。

### 先停下

- 如果当前任务没有明确分配给 `AlembicAgent`，或当前目录不是本仓库，停止并回报总控。
- 如果准备把 Agent runtime、tool system、AI provider、策略、上下文、memory、prompt 或执行循环改成空壳接口，停止。
- 如果准备把 Core deterministic 能力、Dashboard UI、Codex MCP/marketplace/channel、CLI/daemon/native/IDE 交付壳搬进本仓库，停止。
- 如果 tool schema、permission、execution loop、provider adapter 或 host adapter 没有真实调用链、错误路径和验证证据，停止。
- 如果要依赖真实 API key 才能让 AI provider 测试通过，停止并改用 mock provider 或可控 fixture。
- 如果要修改相邻仓库，当前计划没有明确授权时停止。
- 如果删除旧 tool、adapter 或 contract 前没有扫描结果、替代入口、迁移说明和测试证据，停止。
- 如果没有提交 hash 或明确 no-commit 理由、验证命令、验证结果、遗留风险和下一步建议，不能回填为完成。

### 正确顺序

1. 先确认 Core contract、宿主边界和真实调用链。
2. 再实现 Agent/tool/provider/host adapter 范围内的能力。
3. 覆盖成功、失败、取消、超时、权限拒绝和部分结果场景。
4. 最后回填证据、风险和下游接入建议。

## 操作范围

- 本仓库任务只修改当前 `AlembicAgent` 仓库内的文件，并只在该仓库内提交。
- 不要主动修改、整理、格式化、提交或回退 `AlembicCore`、`AlembicDashboard`、`AlembicPlugin`、`Alembic` 或其他相邻项目。
- 其他 Alembic 仓库只可作为只读背景参考；如果 Agent 功能必须依赖其他仓库变更，先说明边界和所需接口，再等待用户明确授权。

## 仓库定位

- `AlembicAgent` 是 Alembic internal Agent runtime、AI 编排和 tool system 的独立仓库，负责工具注册与执行、工具策略、AI provider adapter、任务计划、执行循环、上下文装配、宿主注入 adapter contract 和可观测事件。
- 本仓库不承载 Core 的确定性内核实现，不承载 Dashboard UI，不承载 Codex MCP、Codex plugin marketplace/channel，也不承载 CLI/daemon/native/IDE 的具体交付壳；Codex host agent 路由和插件交付链路属于 `AlembicPlugin`。
- Core 负责可复用、确定性、可测试的 workflow/session/briefing/persistence/contract、repository、service、search/vector、AST/grammar、Guard 和 Project Intelligence 内核能力。
- Agent 负责使用 AI provider、宿主注入的工具服务和明确 contract 去完成非确定性分析、代码扫描、知识挖掘、工具调用、任务分解、执行监控和结果归档。
- 插件依赖 Codex host agent 的场景，不要求本仓库重新实现 Codex Agent；本仓库只沉淀可被宿主消费的 Agent/tool contract、adapter 边界和可复用执行逻辑。

## 职责边界

- 本仓库保留 Agent planning、task loop、execution state、context assembly、memory handoff。
- 本仓库保留 Tool registry、tool schema、tool permission、tool execution 和 tool result normalization。
- 本仓库保留 AI provider adapter、model routing、prompt/template、token/budget、retry、rate-limit 和错误分类。
- 本仓库保留宿主接入 adapter contract，例如 CLI agent、local daemon agent 或后续宿主需要注入的 Agent/tool/context 边界。
- 本仓库保留代码扫描和知识挖掘的 Agent 侧 orchestration、可观测事件、trace、diagnostics、audit log 和安全策略。
- 这些能力不能因为 Core 存在而被移动、空壳化或删除。

## Core 接入规则

- 共享确定性能力通过 `AlembicCore` 和 `@alembic/core` 包入口接入。
- 在 AlembicWorkspace 本地开发和总控验收中，本仓库是 local-source-first 基线：`@alembic/core` 依赖必须保持为 `file:../AlembicCore`，安装后的 `node_modules/@alembic/core` 应解析到 workspace 内相邻的 `AlembicCore` 源仓库。
- 本仓库的 Core import boundary scanner 必须使用相邻源码仓库脚本：`node ../AlembicCore/scripts/lint-consumer-core-imports.mjs . --config config/core-import-boundary.json`，并通过 `npm run lint:core-import-boundary` 纳入验证。
- 不要绕过 `@alembic/core` 包入口直接引用 Core 源码内部路径。
- 需要修改 Core 能力时，先在 `AlembicCore` 仓库完成、验证、提交，再更新本仓库接入。
- vendor、submodule、远程 npm 包或 portable snapshot 指针不是本仓库日常开发入口；只有 release、离线安装、portable runtime 或 workspace 外独立运行场景需要时，才另行记录源 commit 和快照来源。
- 不要把 Core 已有的 repository、SQLite/Drizzle、workflow contract、Guard、search/vector、AST/grammar 复制成第二套实现。
- Agent 侧只保留 AI/tool/host adapter、orchestration、policy、runtime wiring 和非确定性执行边界。

## 不属于本仓库的内容

- Dashboard 页面、组件、前端状态和可视化属于 `AlembicDashboard`。
- Core 确定性内核、repository、SQLite/Drizzle migration、AST/grammar、Guard 和 search/vector 基础能力属于 `AlembicCore`。
- Codex MCP server、Codex marketplace/channel、Codex Skill 文案和插件发布链路属于 `AlembicPlugin`。
- 主仓库或产品仓库的 CLI/daemon/native/IDE 交付壳，只在需要接入 Agent runtime 时提供 adapter，不在本仓库重新实现完整产品壳。

## 验证与回填

- 新建项目后，应在 `package.json` 中提供清晰脚本，例如 `npm run build`、`npm run lint`、`npm run test`、`npm run typecheck`。
- Tool registry、permission、schema、adapter 和 execution loop 改动必须有单元测试。
- AI provider adapter 改动需要 mock provider 测试，不能依赖真实 API key 才能通过。
- 与 Core contract 交互的改动需要类型检查和边界测试。
- 涉及实际工具执行、文件系统、shell、网络或宿主 Agent 的能力，必须覆盖成功、失败、取消、超时、权限拒绝和部分结果场景。
- 回填必须写清完成范围、提交 hash、验证命令、验证结果、遗留风险和下一步建议。

## 文件地图

- 正式源码优先放在 `src/`。
- Agent runtime 放在 `src/agent/`。
- Tool system 放在 `src/tools/`。
- AI provider adapter 放在 `src/providers/` 或 `src/ai/`。
- Host adapter 放在 `src/hosts/`。
- Policy、permission、budget 和 diagnostics 放在 `src/policy/`、`src/security/`、`src/diagnostics/` 或本项目约定目录。
- 测试放在 `test/` 或与源码同目录的 `*.test.ts`。
- 构建产物如 `dist/` 必须保持 ignored，不提交。
- workspace 级长期协作文档按 Workspace 接入卡中的 `Window ledger` 归档。

## 技术与代码规则

- 默认技术栈：TypeScript、Node.js >= 22、ESM；如果项目初始化时选择其他技术栈，必须在本文档同步更新。
- import 路径按当前 TypeScript/NodeNext 约定保持可构建；如果使用 ESM 编译到 Node，源码相对 import 通常需要 `.js` 后缀。
- Lint / Format 优先与 Alembic 系列仓库保持一致，使用 Biome；不要无必要引入第二套格式化体系。
- Tool schema 和 Agent contract 必须类型明确、版本清楚、可序列化、可回放。
- 必须尽量多地在代码旁补充简体中文说明，优先解释 Agent 边界、工具权限、安全策略、复杂状态机、分叉原因、降级原因、兼容路径、宿主差异和后续校验方式。
- 任何运行时分叉、fallback、降级、兼容转译、跳过、短路、重试、取消或错误归类，都必须打印足够明确的日志或诊断事件，日志要能看出触发条件、选择路径、关键输入、结果状态和后续校验依据；尤其要区分 native tool call、兼容转译、parser fallback 和 degraded path。
- 外部输入、AI 输出、tool result 和宿主事件都必须先验证或归一化，再进入核心执行流。
- `catch` 块使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`。
- 避免 `as any`；不得已时在附近说明真实边界原因。
- `throw` 只能抛出 `Error` 实例。
- if/else/for/while 必须使用花括号。
- 不要把 API key、token、用户路径或本机绝对路径写入长期文档、fixture 或提交。
- 不要回退其他窗口或用户已有改动；如果工作区已有无关变更，只处理当前任务需要的文件。

## 工具系统 V1 退役登记（2026-06-11）

本节是退役意向登记，不是删除授权；登记本身不改变任何代码。

- V2（`src/tools/v2/`）是本仓库的主工具系统（primary tool system）。
- V1 表面（`src/tools/core/`：InternalToolHandler、LightweightRouter、ToolCallContext、
  ToolContracts、ToolDecision、ToolResultEnvelope、ToolResultPresenter、
  ToolRoutingServices）与 `V2ToolRouterAdapter`（`src/tools/v2/adapter/`）仅作
  兼容层保留（compatibility-only），不得在其上扩展新能力。
- 当前消费方（2026-06-11 扫描）：
  - `src/tools/v2/adapter/V2ToolRouterAdapter.ts` 通过 V1 `ToolRouterContract` /
    `ToolDecision` / `ToolResultEnvelope` 适配 V2 路由；
  - `src/agent/runtime/AgentRuntimeBoundary.ts` 在 runtime boundary manifest 中
    引用 `V2ToolRouterAdapter`；
  - 此外 V1 的 contract 类型（`ToolContracts` / `ToolResultEnvelope` /
    `ToolCallContext` / `InternalToolHandler`）仍是 runtime、catalog、terminal、
    workflow、forge、tasks 等模块共享的类型词汇（约 15 个 src 文件 type-import）。
- 退役条件：V1 表面与 adapter 的删除/结构收敛属于 RC6 SD-3 决策
  （demand 序列 `alembic-redundancy-stale-logic-cleanup`）；在 SD-3 决策落地并给出
  替代 contract 入口、消费方迁移路径和验证证据之前，不得删除 V1 或合并两套系统。
- 登记 owner：AlembicAgent 窗口；触发复查时机：RC6 SD-3 决策记录产生时。

## 长期维护规则

- 改 Agent/tool 前先确认 Core contract、宿主边界和真实调用链。
- 删除旧 tool 或 adapter 前必须有扫描结果、替代入口、迁移说明和测试证据。
- Agent 能力要保持可观察、可取消、可恢复；长任务必须能报告进度和失败原因。
- AI 行为必须有 deterministic shell：输入 contract、输出 schema、预算、错误分类和持久化边界要清楚。
- 如果某个能力属于 Core、Agent、Dashboard、插件还是主仓库不确定，先做边界判断并记录理由；不要为了拆仓好看裁掉真实链路。
