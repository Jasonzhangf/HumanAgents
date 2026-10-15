# 身份与范围 UX 设计

> 当前展示层级与必要性以[面向人的语义分层展示设计](human-readable-layered-ux-design-2026-10-11.md)为准，绑定需求库 v13。字段存在不代表默认要显示；失败、未知、决定与结果的必要内容保持可见。

状态：DESIGN-CANDIDATE（对当前源码做过核对；不是功能验收或实现承诺）
日期：2026-10-11

本文统一 Task、Organ、Agent、Project、System 视角中的用户可读身份、导航边界和状态表达。它只规定 UI 如何表达权威投影已经提供的事实；不创建新的领域身份、授权模型、生命周期状态或跨项目聚合。

## 1. 设计边界

- 领域身份与生命周期由对应 owner 产生：Task/Organ 等高层状态归 `packages/core`；调度、checkpoint 与恢复归 `packages/runtime`；配置及 project 路径派生归 `packages/config`；UI 只消费投影并提供产品壳。具体 owner 见 [`AGENTS.md`](../../AGENTS.md) 的「唯一 owner」和「硬约束」。
- Organ Journal 是任务状态和恢复责任的真源；Provider/DSH 执行记录只能作为执行证据。浏览器不能以 provider session、route、model 或日志推导 Task/Agent 身份。
- 区分“当前选择的视角”与运行时 current 状态。打开历史 Task、assignment 或 checkpoint 不得让旧对象看起来仍在运行。
- 未由权威 projection 提供的名字、关系、权限、计数和状态都显示为“未提供 / 未知”，不能从目录名、role、URL 参数或邻近事件补猜。
- 本文中的示例文案与导航目标是设计约定；“现有支持”仅按列出的 contracts、API 和页面代码判断。静态类型、demo/mock 和存在的函数本身不证明端到端生产接线。

## 2. 身份词汇与显示策略

| 词汇 | 用户看到的名称 | 语义 / 权威来源 | 默认显示 | 不得混为 |
| --- | --- | --- | --- | --- |
| System | HumanAgent 运行实例 | 当前服务的 runtime status、模式与可见能力；不是某个 task 或 provider | 系统状态与更新时间；需要区分运行实例时用用户可读实例标签 | 全部安装、所有 project 或所有 Organ 的汇总（当前没有这种聚合 projection） |
| Project | 项目工作区 | `packages/config` 派生的 `projectKey`、canonical workspace 与 project manifest；这是配置身份，不是 `ScopeKind` 中的领域 ID | 若提供人类可读名称则用名称；否则显示经处理的 workspace 名称。完整路径仅在用户主动查看诊断时展示 | Task/Organ；工作目录 basename 自身；memory namespace；机器绝对路径 |
| Organ | Organ 名称 | `Organ.id` / `Organ.name`，以及 Organ lifecycle/health 投影 | 名称、生命周期；健康另列并带检查时间/过期提示 | Agent role、provider、某个运行进程或 Task |
| Task | Task 标题 | `Task.id`、所属 `organId`、directive revision 和生命周期；状态真源为 Journal | 标题、状态、当前 Organ 面包屑；无标题时使用通用标签并可在诊断中查看 ID | 一次执行、Provider conversation/session、assignment 或 requirement draft |
| Agent（定义） | Agent 模板或职责标签 | `AgentDefinition.agentId`、`roleId`、template/capability refs；模板名/role 是描述标签，不是这次运行身份 | role/职责优先；未给定时“Agent 身份未提供” | runtime instance、provider model、项目名 |
| Agent runtime | 执行实例 | runtime pool projection 的 `runtimeId`、可选 `agentId`、实际运行状态和 execution epoch | 运行中优先显示职责 + 状态；实例 ID 默认折叠，仅在多个同职责实例难以区分、用户查找或诊断时展开 | Agent 定义/role；execution epoch；外部 Provider session |
| Assignment | 工作分派 | `WorkAssignment` / `AssignmentProjection`：assignment、task、pipeline node、attempt、epoch、input revision 等的绑定关系 | 以“分派到 <职责> / 节点”呈现；多个并发工作需区分时显示分派序号或短引用 | Task 本身、Agent 定义或执行轮次 |
| Attempt | 某次分派尝试 | `WorkAssignment.attempt` 与相配 `WorkResult.attempt`；每次重试是单独尝试 | “第 N 次尝试”；历史尝试保留结果与时间 | `executionEpoch`、checkpoint 序号或 UI 的查看选择 |
| Lease | 暂时持有执行/调度权的 fencing 事实 | runtime pool / occurrence claim 等 owner 的 lease 与代际字段 | 普通 Task 页面不展示机器 lease ID；确有等待或争用时说明“正在占用 / 等待释放”；诊断展开显示来源与 generation | Agent assignment、Provider binding、永久权限 |
| Provider binding | 当前 Harness 到外部 Provider 的配置连接 | `ProviderBinding` 的 provider、binding、protocol、endpoint/model 引用及 capability/config digest；读取配置、readiness 归 adapter/config owner | 面向用户显示“执行后端：RCC / 当前不可用”等经投影的安全摘要；binding/provider 的原始 ID、endpoint、model 和 digest 默认折叠 | Task、Agent、Project 或用户授权 |
| 外部 execution/session | Provider 或可替换执行后端里的执行句柄 | Provider/DSH adapter 的外部引用，只能作为证据/诊断辅助 | 默认隐藏；用户主动展开执行诊断时注明“外部执行引用，不是 HumanAgent Task 身份” | HumanAgent runtime、Task、checkpoint、恢复责任 |

### 2.1 标识符暴露规则

1. 标题、Organ 名称和 role 等可读标签用于日常识别。普通页面不把 `taskId`、`organId`、`runtimeId`、`assignmentId`、`bindingId`、lease 或 provider 外部 ID 当作主标题。
2. 当同名实体并存或用户需要复制查找时，提供显式“复制引用 / 查看身份”区域，展示稳定的 HumanAgent 域 ID 和必要的父 scope。短 ID 只作辅助；不可将截断值作为 API 定位或授权依据。
3. Provider 配置摘要不包含凭据、token、私有 endpoint；日志/原始记录里的外部 ID 也不进入普通对话、卡片标题或 URL。
4. `attempt` 是对用户有意义的历史区别；`executionEpoch`、generation、digest、operation ID 属于执行诊断字段，除非解释恢复/隔离问题，否则默认收起。
5. URL 必须为重新载入所需的最小稳定引用；不得携带 payload、凭据、token 或完整机器路径。分享链接前仍须通过当前浏览器 session 与运行时 scope 查询，不代表授权。

## 3. 五类视角

| 视角 | 进入方式与范围提示 | 页面核心信息 | 面包屑 / 返回 | 当前支持与差距 |
| --- | --- | --- | --- | --- |
| System | 导航壳的“系统”；提示当前连接到哪个 HumanAgent runtime。不能暗示覆盖多实例。 | runtime mode/state、连接状态、最近同步；可读的健康/容量摘要仅在 projection 提供时显示。健康过期须标 stale。 | `HumanAgent` → 当前页面；切 runtime 是显式动作并重新加载身份上下文。 | 有 `/api/runtime/status`、`/api/dashboard` 与 Organ health 投影；尚无跨 Organ/Project/多服务的 System 汇总 projection。`fake/rcc/dsh` mode enum 不等于 provider 已配置或可用。 |
| Project | 从配置的 workspace 入口进入；提示这是哪个配置派生 project identity，当前页面不自动切换 project。 | 项目可读标签、配置状态和该 project 下明确有证据的数据。未有 scope 聚合时不展示项目任务总数或“全部 Agent”。 | `System` → `Project` → `Task` → 下钻对象。Project 根 crumb 只能返回到实际可解析的当前项目入口。 | `projectKey` 和 workspace 由 config/manifest 派生，UI memory projection 也携带 projectKey；当前 UI 没有通用 Project dashboard 或可浏览的 Project scope 深链。不要把 memory namespace 伪装成项目总览。 |
| Organ | 从 Organ 列表或 Task 的所属 Organ 进入；提示 Organ 是任务/能力的领域 owner，不等于后端 Provider。 | 名称、生命周期；若有 `OrganHealthProjection`，按维度显示健康、检查时间和 `stale`。健康未知与未检查/不可用分开。 | `System` → `Project`（若该入口确有项目上下文）→ `Organ` → `Task`。不得凭空补项目祖先。 | 合同有 `Organ`、`OrganHealthSnapshot` 与 `OrganHealthProjection`；当前静态页面/API 中没有通用 Organ 浏览器或 Organ detail 路由，健康 projection 也只证明已检查的 Organ。 |
| Task | 从 task list/dashboard、明确的输入/通知链接进入；页首始终显示 Task 标题与父 Organ。 | HumanAgent lifecycle、当前执行/settling/等待/恢复义务、更新时间、可用动作。Assignment 与 attempt 作为执行分解区，展示其各自状态。 | `Task 列表` → `Task`；`Task` → `观测`；观测内再按真实 projection scope 下钻。返回不应丢失同一 Task。 | 当前有任务列表、task-detail/task-dashboard projection 与页面；task dashboard 有 Agent cards、runtime pool、assignments、attempt、epoch、checkpoint、stop recovery 字段。真实显示细节取决于具体 projection 是否提供。 |
| Agent | 从某 Task 的 assignment/Agent 卡片进入，显示父 Task 和 assignment；Agent 是任务内分派/运行视角，不是跨项目的“全局人”。 | 角色/职责、assignment 当前状态、attempt 历史、runtime 活性事实与对应证据。没有 assignment 时不能把 role card 当作活动实例。 | `Task` → `Assignment` → `Agent runtime`。由 runtime 返回时回到发起的 assignment；不要返回到同角色的另一个运行实例。 | task-dashboard 有 Agent cards/runtime pool/assignment projection；观测 scope 可显示 owner frame。没有独立 Agent detail/history API，也不能据此提供跨 Task 的全局 Agent 页面。 |

## 4. 入口、深链与面包屑

### 4.1 已存在的路径形态

- 任务列表由 `/api/tasks` 投影；任务详情与 dashboard 使用 `/api/tasks/:taskId` 和 `/api/tasks/:taskId/dashboard`。
- 浏览器 Task 页面读取 `?task=<taskId>`；观测读取 `/api/tasks/:taskId/observation?scope=<scopeRef>&node=<nodeId>`。query 中的 scope/node 是选择器，不是授权证明。
- `PipelineObservationProjection.scope` 带当前 `scopeRef`、面包屑和 `canReturn`；`enterObservationScope` 对未知 scope 明确失败；UI breadcrumb 根据投影引用重新读取目标 scope。当前生产服务只组装任务根 scope 与 provider/execution 子 scope，不等于任意 Project/Organ/Agent 层级遍历。
- `UiCommand` 有 navigate/open drawer/enter-scope/return-scope/focus-node 命令；Observation command 被验证为只读，不能在观测页消费需求、重试 operation 或 steer。

对应入口：[`runtime-api.js`](runtime-api.js)、[`observation.js`](observation.js)、[`packages/ui/contracts/commands.ts`](../../packages/ui/contracts/commands.ts)、[`packages/ui/contracts/models.ts`](../../packages/ui/contracts/models.ts)、[`packages/app/src/ui-runtime/service.ts`](../../packages/app/src/ui-runtime/service.ts)。

### 4.2 目标导航规则

- 每一页先说明“我在看什么”和“它属于哪个可确认的父 scope”。只有 projection 提供父引用时才显示该父级 crumb。
- 点击 breadcrumb 是**查看选择**：返回该投影范围，不修改运行状态。当前的查看 revision/checkpoint 与 runtime 的 current 游标应并列说明，不把查看旧历史误标为 current。
- 深链重开时必须以该页面真实入口重新查询权威 projection，再确认 task/scope/node 仍存在。不能只靠客户端缓存接受 URL 对象。
- 无效下钻保留用户上下文并显示失败原因，提供返回最近可确认父级的操作；不把无效 scope 静默替换成默认/根 scope，也不把默认页包装成成功命中。
- 若未来增加 Project、Organ 或独立 Agent detail URL，需先有对应 API/projection 的唯一 owner 与可查询引用；本设计不预设路径，也不以拼 URL 代替能力。

## 5. 状态在不同 scope 的呈现

状态必须保留其维度。一个 Task 可处于 `running`，其中一个 assignment 可能 `waiting`，某个 runtime pool 可能 `unavailable`，Provider readiness 可能 `degraded`；UI 不能压成一个未经定义的“Agent 状态”。

| scope | 主状态 | 辅助状态 / 新鲜度 | 缺失时 |
| --- | --- | --- | --- |
| System | runtime surface/mode 与连接状态 | Provider state/error、各 mode enabled/state、同步时间 | 系统状态不可用、连接断开、未知；不要声称业务 Task 失败 |
| Project | 当前 project identity 配置是否与 workspace 匹配（仅在配置真源提供时） | project 索引/数据源的新鲜度仅按其自己的 projection | “项目汇总未提供”；不能从局部 Task 样本推总数或整体健康 |
| Organ | lifecycle state | Organ health dimensions、checkedAt/expiresAt/stale | 未检查、未知、过期分别说明；health snapshot 不是控制真源 |
| Task | HumanAgent Task lifecycle | current node、checkpoint、输入输出、等待人类决定、stop/recovery obligation、最后更新时间 | unknown / stale / unavailable / empty 区分；不能用 Provider terminal 推断 Task terminal |
| Agent runtime | pool state（available/starting/idle/bound/executing/settling/stopped/failed） | assignment、attempt、epoch、真实 liveness 与更新时间 | 没有 runtime 事实时说“未分配/未观测”，不要由 role/template 推断正在运行 |
| Assignment / attempt | assignment status 与 attempt 序号 | operation/checkpoint/evidence/ref、reconcile 状态 | attempt/result 不匹配时明确关联缺失，保留原记录；不得把 epoch 当 attempt |
| Provider | readiness/settlement/resource release 等 adapter 投影 | checkedAt/expiresAt、错误 owner/nextAction | Provider 未连接不代表 Task 不存在；外部 session 不证明 Harness 恢复完成 |

## 6. 跨 scope 的未知、拒绝、过期与访问限制

这些是不同结果，文案与后续操作不可合并成笼统的“找不到”：

| 情况 | 用户看到 | 交互规则 | 不可做 |
| --- | --- | --- | --- |
| scope 未知 / 引用不存在 | “当前运行时没有提供这个范围”或 projection 的 typed not-found 文案；保留收到的父 Task/链接来源 | 可返回最后一次确认的父级或重试读取；刷新前保留 URL/原始引用供诊断 | 自动换到另一个同名对象；隐藏为默认 root；推断用户输错或对象已删除 |
| scope 已知但查询拒绝 | 显示实际 typed 错误及 `nextAction`；如果是认证错误，转到 session pairing/login 并在返回后恢复同源路径 | 使用后端真实拒绝类型；只在服务确认拒绝时使用“无权访问” | 从 404、空 projection、浏览器异常推断权限不足；暴露拒绝对象的私有身份 |
| 数据过期 / stale | 保留最后一份已知数据并标“数据已过期”，显示 checked/updated 时间；当前动作能力按当前服务投影处理 | 用户显式刷新；刷新失败继续保留旧值并附失败状态 | 让旧状态继续使用“当前”；仅因经过某个前端秒数就推导失败或超时 |
| 数据源不可用 / 断连 | 显示最后可确认内容 + 来源不可用；若没有缓存则显示 unavailable，不显示空列表成功 | 恢复连接后由 API 新 projection 替换旧引用 | 把 transport 错当 Task failure；把没有数据当成“无任务” |
| 对象存在性未知 | “是否存在尚无法确认” | 不泄露跨 scope 查询结果；保留用户当前范围 | 以“无权”或“不存在”代替缺失/错误证据 |
| 无权访问 | 只有服务提供明确权限拒绝时才显示；说明受限 scope（不回显未经授权的名称）和由服务提供的下一步 | 不尝试切换凭据、猜其它 project key 或复用别的 scope 的数据 | 由 UI 自行执行授权；把登录 session 当成对象级 ACL |
| scope 已变更/链接过期 | “链接引用的范围已变化或不再可用”，指出可返回的确认上下文 | 保留失败目标引用供用户复制；要求用户从当前 parent 重新选择 | 将旧引用重定向到新 runtime、同名 task 或新的 attempt |

### 6.1 当前授权边界

目前浏览器运行时的业务读取以全局 HumanAgent session 为门槛；auth contract 能区分 session missing、expired、invalid。当前实现没有按 Project/Organ/Task/Agent 划分的对象级 ACL projection。因此：

- 普通用户文案可以说明“当前浏览器需要配对 / session 已过期”，但不可声称现有系统已经判定用户有权或无权访问某个业务 scope。
- URL、`taskId`、`scopeRef`、cookie/session 只能用于定位或认证既有入口；它们不是额外授权票据。
- 若后端返回未知/错误/不可用，UI 应忠实呈现该结果；不能为避免泄露而伪造具体的 403，也不能为了帮助用户而旁路权限。
- 未经权限 owner 定义独立 ACL 与可见性投影之前，Project 跨域浏览、System 多实例汇总以及“我的所有 Agent”都属于未支持能力。

## 7. 当前代码与设计差距

### 已有且可直接复用

- `packages/contracts/src/index.ts` 有 `ScopedId`、`ScopeRef`、Organ、Task、Cycle、Operation、Checkpoint、AgentDefinition/Handle，以及有 assignment/attempt/epoch 的 WorkAssignment/WorkResult。
- `packages/ui/contracts/models.ts` 有 runtime pool、assignment/attempt、Agent feedback、task dashboard 与 observation scope/breadcrumb projection。
- `packages/ui/contracts/runtime.ts` 有 Organ health、runtime/system status、Task 列表与详情状态投影；这些是当前服务视角数据，不是任意多服务系统的聚合。
- `/api/runtime/status`、`/api/dashboard`、`/api/tasks`、task detail/dashboard/observation API 提供当前 UI 可用的真实入口；task observation 以 typed projection 生成 scope crumbs。
- config 的 runtime paths 有 `projectKey`/`workspaceCwd`/`projectManifest` 派生；project manifest 对 key 与 canonical workspace 做匹配校验。project identity 不由 UI 路径字符串自由拼接。
- `ProviderBinding` 明确分开 `bindingId`、`providerId`、protocol、endpoint/model ref 与 digest；这些是 provider adapter/config identity，不是 Task 或 Agent ID。`AGENTS.md` 指出 RCC 配置是外部真源，HumanAgent 只可读取非敏感 capability/lock 信息；MVP 未接 DSH provider。

### 未支持、不可宣称已完成

- 当前主 UI 没有独立 Project/Organ/Agent detail 的浏览、搜索、深链和父级导航闭环；文档或静态演示中出现的 project/agent 标签不能证明生产 projection/API 已提供。
- Project 没有领域 `ProjectId` 加入 `ScopeKind`；当前 project key 是 config 派生身份，并在 memory/project 数据路径中使用。不能据此推导 project-wide task/organ/activity aggregate。
- Agent 汇总页、跨 task 历史、跨 project scope 授权、对象级 ACL 和多实例 System status 均缺少对应合同/API。
- UI 合同对 runtime、assignment、attempt 有字段，但不同页面是否显示所有字段取决于服务 projection 的来源与实接线；不能把内部 fencing identity 当成已面向用户提供的状态。
- 存在 `dsh` mode 标记或外部 DSH 证据，不等于 MVP 已接 DSH Provider，也不等于可用 DSH runtime identity。

## 8. 验收设计原则（后续实现时适用）

1. 对每个页面，能从真实入口说清当前实体、父 scope、查看中的历史选择、runtime current 状态各自是什么；未知字段保持未知。
2. 切换 Task/Organ/Project/runtime 后，前一 scope 的事件、订阅与缓存不得跨域污染新 scope；URL 重新打开必须经过服务重新解析。
3. 观测页继续只读；导航动作不改变业务生命周期，runtime 控制仍由 Task 显式交互面和原 owner 处理。
4. 正常文案不暴露内部 ID；诊断展开能复制所需引用，并标出它是 Harness identity 还是外部 Provider reference。
5. 用实际 API 的已知/未知/错误/过期样本分别确认 UI 不把 empty、unavailable、stale、unknown 和 denied 混成一个状态；只验证本 UX 变更实际涉及的路径。

验收时遵守 [`dashboard-e2e-acceptance.md`](dashboard-e2e-acceptance.md) 适用部分；当前本文不声称已做浏览器验收。
