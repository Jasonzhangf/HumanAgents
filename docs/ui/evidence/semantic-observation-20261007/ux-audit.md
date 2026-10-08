# 多视角只读 UX 审计结果

- Worker: independent UX audit worker, `ux-audit`.
- Worktree: `/Volumes/Intel/playground/humanagent/semantic-observation-20261007`.
- Baseline/HEAD: `9d1f39c53f09e31a4636fa75f97042c18e8bb114`.
- Result: 三种目标视角在当前真实 UI/API 中**不存在完整支持**。任务切换和实时/复盘任务的部分能力已接线；按真实 agent/当前执行视角和系统概要 → 项目 → 任务 → 节点下钻均未实现。
- Live 证据状态：本审计只读，未探测或启动正式实例，未取得正式任务数据；全部结论为候选源码与公开契约证据。不得据此宣称 live 验收。

## 1. 目标 → 已有 → 差距

### 视角 A：任务切换 / live 任务 / 完成复盘

| 目标 | 已有 | 差距 | 证据 |
|---|---|---|---|
| 任务列表、切换任务 | 有 `tasks.html`，按生命周期分组，行内链接用 `?task=` 进入 task-dashboard/task detail；Dashboard 也渲染任务小节 | 无项目维度；切换只靠 `?task=` 查询，选择不持久化到 URL 的 project/agent 层 | `docs/ui/tasks.js:142-151`（分组定义）; `docs/ui/tasks.js:211-215`（行链接）; `docs/ui/tasks.js:308-348`（读取 /api/tasks）; `docs/ui/runtime-shell.js:136-152`（href/query）; `packages/app/src/ui-runtime/server.ts:753-755`（/api/tasks GET）; `packages/app/src/ui-runtime/server.ts:978-988`（task dashboard/observation 路由）; `packages/ui/projection/runtime.ts:186-212`（task list 投影，无 project 字段） |
| live 任务实时更新 | 有 task-dashboard：SSE 订阅 `?operationId`、轮询、状态/连接/liveness 分层、当前节点、allowedActions | live 语义仍绑定 raw runtime event kind/summary；`historyChunks` 用 `kind === 'provider.model' && summary === 'provider requested model work'` 推断模型轮次，不符合“语义/原始流水解耦”目标 | `docs/ui/task-dashboard.js:22-44`（query 与刷新）; `docs/ui/task-dashboard.js:79-119`（可见事件/轮次投影）; `docs/ui/task-dashboard.js:424-447`（轮询/SSE 选择）; `docs/ui/task-dashboard.js:479-530`（EventSource 订阅）; `packages/ui/contracts/runtime.ts:151-209`（事件/看板契约）; 原始语义断链见第 4 节 |
| 已完成任务复盘 | 有 task detail 与 task-dashboard：输入/调查/建议/输出/checkpoint/历史事件，均从 Runtime API 读 | 复盘仍呈现 raw trace 事件列表，没有 canonical narrative/live 与 stable 分离；无任务终态语义复盘视图 | `docs/ui/task.js:588-655`（detail + observation 链接）; `docs/ui/task-dashboard.js:335-422`（执行轨迹/事件渲染）; `packages/app/src/ui-runtime/service.ts:2144-2197`（taskDetail 投影）; `packages/app/src/ui-runtime/service.ts:1989-2008`（dashboard 投影）；raw 依赖见第 4 节 |

### 视角 B：功能视角，某 agent 在某任务中的执行 / 当前执行状态

| 目标 | 已有 | 差距 | 证据 |
|---|---|---|---|
| 按功能（agent）查看任务内执行 | Observation 有 agent lane/chain，节点带 `ownerAgentRole`/`owner` | agent lane 是静态角色 frame：`agentId = agent-${role}`，`stateDisplay='归属来自流水线注册表'`；没有真实 agent 实例 ID、durable binding、运行实例/任务绑定 | `packages/app/src/ui-runtime/service.ts:606-622`（agentIdForRole/agentFrames）; `docs/ui/observation.js:61-74`、`100-127`（lane/chain 渲染）; `packages/ui/contracts/models.ts:370-388`（owner 字段）; `packages/ui/projection/index.ts:757-799`、`864-907`（frame 校验/投影，仍以声明 role 为准） |
| 查看某 agent 当前执行状态 | task-dashboard 显示 `currentNode` 与 allowedActions；Observation 有 `currentNodeId` | `currentNodeOfPipeline` 是硬编码字符串 switch；不能表示 task/operation/epoch/agent 维度的“某 agent 正在某任务中执行”；未识别当前节点返回 undefined | `packages/app/src/ui-runtime/service.ts:624-642`; `docs/ui/task-dashboard.js:287-303`（currentNode 只是文本事实）; `packages/ui/projection/index.ts:958-962`（currentNode 查找/404）; `packages/app/src/ui-runtime/server.ts:983-988`（API 无 agent/project 参数） |
| 功能角色与运行实例不混同 | 投影校验 agent/owner 一致性 | 没有真实运行实例层；同一角色在不同任务/epoch 显示同一个 `agent-${role}`；无法按实例查询 | `packages/ui/projection/index.ts:757-769`、`885-906`; `packages/app/src/ui-runtime/service.ts:606-622`；ScopeRef 无 agent/instance 身份，`packages/contracts/src/index.ts:18-23` |

### 视角 C：后台总体概要 → 项目 → 任务 → 节点详情

| 目标 | 已有 | 差距 | 证据 |
|---|---|---|---|
| 后台总概要 | 有 `/api/dashboard`：hasRunning、taskCount、waitingDecisionCount、recent inputs/outputs/failures | 仅单实例聚合 flat 列表，无项目分组、无跨项目总数 | `packages/app/src/ui-runtime/server.ts:749-751`; `packages/ui/projection/runtime.ts:150-184`; `docs/ui/dashboard.js:789-801`、`909-935` |
| 项目层 | 无项目导航/路由；task/observation URL 只有 `?task=`；Observation scope 只有 task 根 + provider 子 scope | 项目维度在当前 UI/API 不是真实存在；`projectKey` 只出现在 memory/workspace 组装与 memory candidate 投影，不进入 task/observation 投影 | `packages/app/src/ui-runtime/index.ts:296-320`（workspace/projectKey 组装）; `packages/config/src/index.ts:771-812`（projectKey/workspaceCwd 真源）; `packages/config/src/index.ts:815-828`、`830-877`（manifest 校验）; `packages/ui/projection/index.ts:433-435`、`1050-1066`（仅 memory candidate projectKey）; `packages/app/src/ui-runtime/service.ts:1117-1129`、`1200-1209`、`1385-1471`、`3905-4034`（memory/workspace 内部 projectKey，不入任务/观测投影） |
| 任务层 | 有 task list/detail/dashboard/observation | 任务不声明项目归属；list rows 无 projectKey；Observation 根 scope 是 `task://${taskId}/observation` | `packages/ui/contracts/runtime.ts:117-149`（row 无 project）; `packages/app/src/ui-runtime/service.ts:2202-2213`（scope 白名单）; `packages/app/src/ui-runtime/service.ts:2144-2193`（taskDetail）; `docs/ui/runtime-shell.js:136-152` |
| 节点详情 | 有只读 drawer：输入/输出/evidence、跨 agent handoff、childScopeRef 下钻 | 下钻只有一层 provider 子 scope，节点是 raw `event.kind`；handoffs 是固定 node-id 对与生成文本，不是真实语义交接 | `docs/ui/observation.js:352-569`（drawer/handoff/refs）; `docs/ui/observation.js:541-549`（childScope 入口）; `packages/app/src/ui-runtime/service.ts:644-683`（handoffs 硬编码）; `packages/app/src/ui-runtime/service.ts:2225-2238`（provider 子节点 raw kind）; `packages/ui/projection/index.ts:947-1037`（scope/drawer 投影） |

## 2. 真实入口、导航状态与查询 scope

| 页面/API | 入口 | 导航状态/query | 参考 |
|---|---|---|---|
| `dashboard.html` | `makePageShell` 后渲染输入/概要/列表/计划 | 无 query；确认后跳到 `task-dashboard.html?task=` | `docs/ui/dashboard.js:28-54`、`513-542`、`941-969` |
| `tasks.html` | `/api/tasks`（浏览器会话保护） | `?task=` 行链接; 无 project/agent query | `packages/app/src/ui-runtime/server.ts:590-598`; `docs/ui/tasks.js:211-215`、`308-348` |
| `task.html` | `/api/tasks/:id` | `?task=`（required）；`?interaction=`/`#task-interaction`; 无 project | `docs/ui/runtime-shell.js:136-152`（query 强制）; `packages/app/src/ui-runtime/server.ts:1041-1066` |
| `task-dashboard.html` | `/api/tasks/:id/dashboard` + `/api/executions/:operationId/events` | `?task=`；SSE 按 operationId 订阅；无 project/agent | `packages/app/src/ui-runtime/server.ts:978-988`、`1068-1080`; `docs/ui/task-dashboard.js:22-44`、`424-447`、`479-530` |
| `observation.html` | `/api/tasks/:id/observation?scope=&node=` | `?task=`；scope 白名单恰为 task 根 + pipeline.execute 子 scope；node 打开 drawer | `packages/app/src/ui-runtime/server.ts:983-988`; `packages/app/src/ui-runtime/service.ts:2202-2213`; `docs/ui/observation.js:30-46`、`669-685` |

## 3. 当前数据来源与语义/原始流水耦合

- Observation 根节点：`registry.map` + `observationNodeFacts()` 按固定 nodeId switch，从 `RuntimeTaskSnapshot` 取 input/directive/admission/operation/output/checkpoint；无事件时可出现明确“未投影”节点。
  - `packages/app/src/ui-runtime/service.ts:458-604`
- Observation provider 子节点：直接把 `task.events` 映射为节点，`title = ${event.kind} #${seq}`、`summary = event.summary`、`kind='provider.event'`。此为 raw runtime 流水，不是 canonical narrative。
  - `packages/app/src/ui-runtime/service.ts:2225-2238`
- task-dashboard 同样渲染 `kind + state + summary` 的 raw 事件行；轮次用 `kind/summary` 字符串推断。
  - `docs/ui/task-dashboard.js:79-119`、`374-415`；`packages/ui/contracts/runtime.ts:151-169`
- `packages/context-events` 已提供 `toUserNarrative` 等项目，但仓库内没有其他 package 导入它；它只被自身测试/文档引用。
  - `packages/context-events/src/index.ts:1-22`；`packages/context-events/src/projector.ts:87-124`
- 结论：UI 到 context-events 语义链是断的，当前 UX 仍依赖 raw kind/name/summary。
  - `docs/ui/task-dashboard.js:79-119` 与 `docs/ui/observation.js:148-158`（只显示 projection 字段，但 projection 字段本身由 raw 事件生成，见 service.ts:2225-2238）

## 4. 权限与错误可见性

- 业务 API 统一在 entry 先 `requireSession`；mutation 另 `requireOrigin`。session 缺失/过期/无效返回 typed `auth.session.*`，附 owner/nextAction。
  - `packages/app/src/ui-runtime/server.ts:125-140`（sessionError/requireSession）; `packages/app/src/ui-runtime/server.ts:590-598`（业务 API session 门）
- 浏览器侧把 typed error 渲染成 `message · owner=… · next=…`，并提供真实 login pairing 链接。
  - `docs/ui/runtime-api.js:14-25`、`70-97`; `docs/ui/runtime-shell.js:20-33`、`110-134`
- Observation 加载失败只渲染页级 banner；节点/scope 的未授权、未知 node、未知 scope 由 404 typed error 呈现，但无节点本地权限/错误状态。
  - `docs/ui/observation.js:669-685`; `packages/app/src/ui-runtime/service.ts:2204-2212`、`2278-2289`
- 未知 scope/node 返回 `observation.scope.not-found` / `observation.node.not-found`，是可复现公开 API 错误；未知 project/agent 尚不存在对应 API。
  - `packages/app/src/ui-runtime/server.ts:983-988`; `packages/app/src/ui-runtime/service.ts:2204-2212`

## 5. 项目维度是否真实存在

**不是。** 当前 UI/API 没有项目实体、项目路由或项目 task 归属：

- `projectKey` 由 `packages/config` 从 canonical workspace 解析并持久化于 `project.json`（真实项目身份真源），也进入 UI runtime 的 memory/workspace 组装；但 `projectKey` 未进入 `RuntimeTaskListProjection`、`RuntimeTaskDashboardProjection`、`PipelineObservationProjection` 或任何公开路由参数。
  - `packages/config/src/index.ts:114-135`、`771-828`、`830-877`; `packages/app/src/ui-runtime/index.ts:296-320`; `packages/app/src/ui-runtime/service.ts:1200-1209`
- 全部任务行结构无 project 字段。
  - `packages/ui/contracts/runtime.ts:117-149`; `packages/ui/projection/runtime.ts:120-134`
- Observation scope 不包含 project；`projectKey` 只在 memory candidate 投影中出现。
  - `packages/ui/projection/index.ts:433-435`、`1050-1066`; `packages/app/src/ui-runtime/service.ts:2199-2258`
- `ScopeRef` 只允许 organ/task/cycle/operation/checkpoint/evidence，没有 project/agent 维度。
  - `packages/contracts/src/index.ts:1-33`
- 禁止从路径字符串伪造 projectId；若未来实现，项目身份必须来自 config 已校验的 `project.json`/RuntimePaths，并由公开投影与路由显式承载。

## 6. 最小多视角 UX 结构（开发目标；不是已实现能力）

所有新增视角必须先接通语义与真实身份，不新增第二套解释器：

1. 公共语义视图：由 context-events canonical → pairing → narrative 输出，UI 只读 `title/state/detail/nextAction/evidenceRefs`；`stable` 与 `live` 分离；unmapped 显式显示。
2. 任务视角（已有骨架可扩展）：保留 tasks/task-dashboard/observation；任务切换继续用 `?task=`；新增 URL 可恢复的项目/agent scope 只来自真实投影；复盘视图使用语义终态而不是 raw kind 列表。
3. 功能视角：Observation 增加真实 agent 维度节点/筛选；agent frame 必须来自真实 instance/durable binding，不再是 `agent-${role}`；当前执行查询为 task × operation/epoch × instance 的有界可见事实。
4. 总览→项目→任务→节点：新增只读总览 API（真实项目聚合）；项目层来自 config/workspace 校验身份；树路径为 `overview → projectId → taskId → nodeId`，未知 project/task/agent 有 typed 404/403 和恢复动作；Observation 递归 scope 允许逐层下钻并有 breadcrumb 返回。
5. 权限与错误：观测只读 GET 不消费队列、不 retry/steer；未授权/未知实体显式失败；页面保留错误与上次成功内容。

之后按项目 R1→R5 阶段闭合设计 DAG，再进入实现；本轮只读审计不推进实现。

## 7. 黑盒验收矩阵（现有/建议命令）

现有真实浏览器/公开 API 可复用验证：

| 场景 | 命令/入口 | 断言 | 状态 |
|---|---|---|---|
| 任务输入→确认→live→终态 | `pnpm e2e:dashboard:web-search`（`tests/app/dashboard-e2e/runner.mjs --scenario web-search`） | receipt `result: SUCCESS`，绑定候选 SHA/tree，raw receipt 与截图；活任务有 live 事件，终态为真实 succeeded | 已有命令，是否通过以 receipt 为准 |
| 本地文件搜索 live/终态 | `pnpm e2e:dashboard:local-file-search` | 同一 chain + tool call/result 配对、checkpoint、终态、资源清理 | 已有命令与 receipt 合同 |
| AItest | `pnpm e2e:dashboard:aitest` | checker 原始 stdout/exit + 人工观察记录 + receipt | 已有命令，受 checker/人工观察门禁约束 |
| 通用详情/交互证明 | `pnpm proof:entry-flow`、`pnpm proof:page-wiring`、`pnpm proof:work-card`、`pnpm proof:liveness`、`pnpm proof:plan-control`、`pnpm proof:draft-lifecycle` | 各自模块真实浏览器断言 | 已有证明入口 |
| Observation drawer | `INTERACTION_OBSERVATION_UI_ROOT=... INTERACTION_OBSERVATION_EVIDENCE=... pnpm proof:observation-drawer` | drawer 只读、真实 turn 分组、focus/esc、reduced motion | 已有 harness，须提供证据目录 |
| 语义任务切换/复盘 | 无现有专门 harness | 两任务：切换 live→复盘；`?task=` 重新打开；终态无伪造 live；错误/空态可见 | **未实现** |
| 功能/agent 视角 | 无 | 同功能不同 agent 实例、不同任务隔离；未知 agent 显式错误；真实 instance ID 与状态 | **未实现** |
| 总览→项目→任务→节点 | 无 | 聚合计数一致；项目隔离；面包屑返回；未知 project/task/node typed 错误；GET 不改任何状态 | **未实现** |
| 只读观测不消费/不控制 | `GET /api/tasks/:id/observation` before/after Journal/状态对比 | 状态、Journal、resource 不变；无 retry/steer/queue 入口 | 一部分可测（现有 GET 只读），多视角未接线 |

建议落地后新增的公共验收命令（命名保留为建议，不实现不改产品）：

```sh
pnpm proof:multi-view-task-switch   # 两任务 live/复盘切换、链接恢复、终态无伪造 live
pnpm proof:multi-view-agent         # 真实 agent 实例 × task scope 查询/隔离/未知 agent
pnpm proof:multi-view-project       # overview → project → task → node、breadcrumb、项目隔离、未知错误
pnpm e2e:observation-semantic      # raw 与 canonical 分离：断言页面不显示 raw kind 推断的轮次/阶段
```

以上命令当前**不存在于 package.json**（已核实 `package.json:28-74`），只作为验收目标，不代表已接线。

## 8. Owner 与下一步

| 项 | Owner | 下一步 |
|---|---|---|
| canonical 语义归类/配对/narrative | `packages/context-events` 唯一 owner | R2：公开 typed 语义投影与 app API 接线 |
| UI 投影与多视角视图结构 | `packages/ui`（projection/models/contracts）；app 只读组装 | R1 设计通过后 R3 实现；禁止把 raw kind 推断上移 |
| 项目身份真源 | `packages/config`（RuntimePaths/project.json） | 不凭路径字符串伪造 projectId；公开 API/路由承载身份 |
| 任务/运行实例身份 | runtime 真实身份生产者（app/adapters） | 先补真实 instance 事实，再改 agent 视角 |
| 总览聚合 | `packages/app` 只读 API | 项目/任务/节点计数与隔离 |
| 浏览器验收 | `tests/app/dashboard-e2e`、`tests/ui` | 新增多视角 harness，绑定候选 SHA 与 receipt |

## 9. 限制与证据边界

- 本次只读，没有启动服务、没有 live 任务数据、没有截图/DOM 行为证明；因此“可运行但未接线”用于明确当前生产入口缺链，不把源码当作 live 验收。
- 10086 等端口在本沙箱不可达，且任务禁止生命周期操作；父笔记已有 `auth.session.missing` 观测，参见父 `notes.md`。
- 未修改产品代码、未构建/共享 dist、未触碰 runtime、未做 Git mutation。
- 建议命令只在验收时由授权执行者运行并保存 receipt，本次不执行。
