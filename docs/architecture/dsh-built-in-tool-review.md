# DSH Built-in Tool Review

状态：`READ-ONLY-REVIEW / ASTRA-REMEDIATION / IMPLEMENTATION-BLOCKED`

本文只做 DSH 内置能力的设计审查，不实现 DSH adapter，不修改 DSH，不提交、merge、push，也不启动 worker。

审查基线：

```text
DSH worktree: /Volumes/extension/code/dsh
审查参考 checkout: dsh-memory/alpha5
审查参考 HEAD: d557713eff
正式锁定适配基线: 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720（见 dsh-baseline.md）
HumanAgent candidate: playground/context-contract
HumanAgent base: aace125b3d1381ea05f74d332908af06aa7839e8
```

DSH worktree 当前有大量未跟踪构建产物。本审查只读取源码、package composition 和测试；不清理、不回滚、不把构建产物当成源码证据。本文中基于 `d557713eff` 的 API/行为只作为设计参考；Milestone 1 适配必须在正式锁定 commit 上重新复核并绑定证据，不能把本文件直接当作当前 DSH API 合同。

## 1. 审查结论

HumanAgent 不应把 DSH 的工具集合整体搬进高层。正确边界是：

```text
HumanAgent Harness 真源
  Task / Assignment / Agent Runtime / Operation / Checkpoint
  Journal / EventBus / Permission / Resource / Health / Review
           │ typed adapter
           ▼
DSH 工具与运行能力
  filesystem / shell / web / jobs / schedule / goal / subagent / session query
```

分类：

| 分类 | 结论 | 处理方式 |
|---|---|---|
| 可直接作为执行能力接入 | `read`、`write`、`edit`、`read_image`、`glob`、`grep`、`str_replace_editor`、`bash`、`pwsh`、`terminal_*`、`lsp`、`web_fetch`、`web_search` | 只挂到执行/审查 Agent 的 capability allowlist；通过 DSH adapter 映射为 HumanAgent Operation 和 Evidence |
| 直接参考并做薄适配 | ToolRuntime hooks、canonical output、presentation、memory projection、`ask_user_question`、Goal revision/CAS、Job wait/kill/settle、Session Query trace、Skill catalog/load | 复用行为和验证思想；HumanAgent 重新定义 ID、权限、Journal 和事件 |
| 必须由 HumanAgent 自有 | checkpoint、task/assignment、subscription、reminder、memory index、EventBus cursor/ACK、provider/model binding、health、review gate、operation reconcile、agent status | DSH 没有与 HumanAgent 契约等价的真源，不能用 DSH 工具替代 |
| 只能是可选 adapter 能力 | DSH `goal`、`schedule_*`、`job_*`、`subagent*`、session log/query、DSH provider/model/session | 可映射能力或读取证据；不可上提为 HumanAgent 的 Task、Checkpoint、Agent Runtime 或 Memory |
| 不进入 MVP | `workflow`、`ralph`、`cordis_*`、experimental agent-team、DSH WebUI | 可作为后续插件或参考，不进入固定 Harness 主路径 |

核心判断：**工具可以复用；控制事实不能复用。**

## 2. DSH 工具 inventory

### 2.1 文件、搜索、执行和观测工具

当前 DSH CLI 与可选 tool bundles 提供：

```text
read                 读取文件
write                创建/覆盖文件
edit                 局部编辑
read_image           读取图片输入
glob                 文件路径搜索
grep                 内容搜索
str_replace_editor   view/create/str_replace/insert
bash                 一次性 shell 执行，可选 background job
pwsh                 PowerShell 执行，可选 background job
terminal_open        创建持久 terminal
terminal_send        向持久 terminal 写入
terminal_read        读取有界输出
terminal_signal      向前台进程组发信号
terminal_close       关闭 terminal 并等待进程树结束
terminal_list        查询当前 Agent 拥有的 terminal
lsp                  goToDefinition/findReferences/goToImplementation/hover
web_fetch            获取网页
web_search           搜索网页
```

这些能力可作为 HumanAgent 的 execution adapter，但必须遵守以下映射：

```text
DSH tool call/result
  → OperationStarted / OperationSettled
  → evidence/artifact refs
  → UI observation projection
  → 可选 Context Slot 映射
```

要求：

- DSH tool name 不是 HumanAgent `OperationKind` 的唯一身份；adapter 必须携带 `operationId`、`assignmentId`、`executionEpoch` 和 capability digest。
- DSH 的 `terminal session id`、`job id`、tool call id 只能是外部证据引用，不能直接成为 `OperationId`。
- shell、文件写入、信号、网页内容按不同 capability 和 permission 处理，不能只按“有 bash 工具”授权。
- web 内容是不可信数据；不能把网页返回的指令直接当作 Agent 指令。
- 工具成功不等于 Task 成功；Task 是否完成由 HumanAgent CompletionGate 和验收证据决定。

### 2.2 用户交互

`ask_user_question` 支持多个问题、稳定 question id、header、选项、多选、自定义回答和取消信号。这是显式 Brain 的交互原语，尤其适合：

- 输入意图不明确时询问用户；
- proposal 的选择确认；
- 计划审批；
- 权限或高风险操作确认。

但它不能直接成为 HumanAgent 的交互真源。HumanAgent 必须在外面包一层：

```text
InteractionRequest
  → interactionScope / task / owner / permission
  → ask_user adapter
  → InteractionAnswer
  → Journal + EventBus
  → RequirementEnvelope 或 approval decision
```

DSH 的用户问题回答只能证明“用户回答了一个 DSH 问题”，不能直接证明“用户批准了某个 HumanAgent Task”。审批必须绑定 `interactionId`、`proposalRevision` 和 owner。

### 2.3 Goal

DSH `get_goal`、`create_goal`、`update_goal` 背后是一个持久化 same-session goal domain。已确认的设计特征：

- `goal/change` 保存完整快照；
- `id + revision` 做 compare-and-set，拒绝 stale revision；
- phase 有 `active`、`paused`、`blocked`、`complete`；
- `maxGoalRounds` 限制自动 continuation；
- `activation` 是进程态，和 durable phase 分离；
- fork/resume 后 active goal 可处于 disarmed；
- blocked 有稳定 code 和 message；
- clear 保留 tombstone，禁止历史 ID 无条件复用；
- direct human authority 控制 create/edit/pause/resume；自动 continuation 才能在相应条件下 complete/blocked。

可参考这些原则，但不能直接复用 DSH Goal：

```text
DSH Goal ≠ HumanAgent Task
DSH goal revision ≠ HumanAgent Task revision
DSH goal round ≠ HumanAgent Cycle
DSH activation ≠ Checkpoint reentryAllowed
```

HumanAgent 必须补：Task/Assignment 关系、proposal/approval、checkpoint、dead-end/reentry、review gate、CompletionGate、跨 Agent owner、memory scope、provider/model binding 和 daemon restart fencing。

DSH goal 的“模型调用工具更新状态”也不能代替 Harness control。模型失联、超时、权限撤销和宿主重启时，HumanAgent 仍要由 `harness-control` 或 `recovery` owner 提交 closure/checkpoint。

HumanAgent 固定提供两种 Goal，不把它们压成同一套无限 continuation 状态机：

### 单任务 Goal

单任务 Goal 是一次有边界的任务执行：

```text
Task Goal
  → bounded Cycle / Request
  → checkpoint / review / CompletionGate
  → complete | blocked | cancelled | reenter
```

它负责当前任务的目标、Assignment、进度、阻塞、取消、验收和 checkpoint 重入。它可以有多个执行轮次，但每一轮都必须有边界、watchdog 和可重入状态。

### Long-horizon 巡检 Goal

巡检 Goal 是一个持久目标和多个有边界的触发执行，不是常驻 Agent，也不是一次请求无限续推：

```text
Patrol Goal Markdown / accepted revision
  → HumanAgent Subscription
  → due Occurrence / Reminder
  → checkpoint recall
  → new Request / Cycle
  → inspect / report
  → complete | continue | reschedule
```

每次触发都创建新的 Request/Cycle，并重新进行 permission、resource、provider/model 和 execution epoch admission。Goal 完成、取消或撤权后，后续 Schedule/Reminder 必须幂等失效。

两者的关系是：巡检 Goal 的每次触发可以产生一个单任务 Cycle；但 Subscription、Occurrence、Reminder 和 SchedulerLease 不属于单任务 Goal 的状态字段，也不能由模型文本自行维护。

### 2.4 Schedule

DSH `schedule_create`、`schedule_list`、`schedule_delete` 具有以下真实语义：

- `after` 和 `at` 是 one-shot；
- `every` 是固定间隔，按创建锚点对齐；
- fixed-rate 最小间隔为 300 秒；
- 到期的 one-shot 以 durable dispatch 标记结束；
- missed fixed-rate occurrences 不逐次补发，只计算最新到期 occurrence，并推进到下一个锚点；
- active schedule 保持创建顺序，id 在同一 session 内不复用；
- `schedule_list` 返回 `scheduled` 或 `overdue`，没有 activity claim 语义；
- delivery mode 是 `session-local`，原始 session 必须仍然可用/恢复；
- runtime 在 dispatch 前后都有 persistence barrier；持久化不确定时返回显式 `persistence_uncertain`，不伪造成功；
- runtime 以精确 root Agent 为 owner，持久化事件可重放，runtime timer 是进程态；
- runtime 通过 `runMaintenance` 获取 idle admission。忙时不是显式 `skip`：它等待 idle 后重新计算；因此 DSH 没有我们需要的 `skipped-busy` 与 `idle-reminder` 两种业务策略。

这部分是 long-horizon 的重要参考，但不能直接使用。HumanAgent 的正式模型必须是：

```text
Goal
  → Subscription
  → Occurrence
  → Reminder
  → busy/resource admission
  → Request/Cycle
  → checkpoint / CompletionGate
```

HumanAgent 要补：

- Goal Markdown 与 accepted revision；
- project/global subscription scope；
- `busyPolicy = skip | idle-reminder`；
- occurrence ordinal 和幂等键；
- reminder 合并和消费；
- scheduler lease、daemon generation 和 fencing；
- daemon downtime 的 catch-up policy；
- task complete/cancel 后自动失效；
- 每个 Agent 最多三个活动订阅的产品约束；
- 跨 Agent owner 和权限。

结论：DSH schedule 可作为 `ScheduleAdapter` 或测试参考；不能直接叫 HumanAgent subscription，也不能让 UI SSE subscription 代替它。

### 2.4.1 HumanAgent `sleep` 内置工具

`sleep` 是 HumanAgent 的 provider-neutral 阻塞工具，不是 DSH `schedule_create` 的别名，也不创建 HumanAgent Schedule：

```ts
sleep({
  after_seconds: number,
  reason?: string,
})
```

调用语义：

```text
sleep request
  → permission / active-epoch 校验
  → 创建有界的 blocking Operation
  → 当前 Agent Runtime 阻塞等待
  → 到期后 Operation settled
  → 将 sleep result 返回当前 Request/turn
  → 同一 execution epoch 继续推理
```

固定规则：

- `after_seconds` 必须是正的、受策略上限约束的整数；`reason` 只用于展示和后续分析，不是控制真源。
- `sleep` 不表示 Task 完成，也不创建 checkpoint、Subscription、Occurrence、Reminder 或新的 Request/Cycle。
- `sleep` 是当前 Agent 没有其他并行任务时使用的同步等待；到期后返回当前请求，继续同一条推理链。
- `sleep` 必须有最大时长和可取消句柄；`steer`、Task cancel、权限撤销、宿主 shutdown 会请求停止，实际结果仍需经过 Operation settle/reconcile。
- 当前 Agent 如果有其他并行工作，不得用 `sleep` 占住运行资源等待后台事件；应使用 HumanAgent `schedule`/Subscription 产生非阻塞 Reminder。
- 控制返回不进入业务 Context；`sleepId`、`wakeAt`、`operationId` 通过 control event 和 projection 提供给 UI。

因此，`sleep` 定义“当前执行阻塞到指定时间后返回”的 Harness 语义；`schedule` 定义“后台并行提醒”的 Harness 语义。两者不能互相替代。

这里的 `schedule` 是 HumanAgent 的非阻塞定时语义：它创建或推进 Occurrence/Reminder，不占住当前 Agent 的执行。长期巡检对外使用 `subscription.create/list/cancel` 管理 Goal 与订阅，内部由 `schedule` 产生触发；这不改变 `sleep` 的同步阻塞语义。

### 2.5 Background Jobs

DSH `job_output`、`job_list`、`job_kill` 提供：

- running/stopping/completed/killed/failed 状态；
- bounded output retention；
- `wait` 和有上限的 timeout；
- kill 是请求，真实停止后才 settle 为 killed；
- owner 隔离；
- job 完成通知可注入 busy owner，或唤醒 idle owner；
- wakeup 有 `maxConsecutiveWakes`，避免 job 自激循环。

这是 HumanAgent `Operation` 的好参考。映射时必须保留：

```text
DSH job id  → evidenceRef / adapterHandle
HumanAgent OperationId → 自有稳定身份
job_kill    → stop request
settled     → OperationSettled evidence
```

不能把 `job_kill` 的即时返回当成停止完成，也不能把 DSH job 的 completed 当成 Assignment 已验收。未知副作用必须进入 reconcile，而不是被包装为 failed 或 success。

### 2.6 Subagent 与协同

DSH subagent tools 提供：

```text
subagent
send_message
interrupt_agent
list_agents
list_subagent_models
```

DSH 支持 foreground、one-shot background、continuable child，以及：

- child depth limit；
- provider capability negotiation；
- child provider/model selection；
- tool allow/deny filter；
- persona；
- background job notification；
- direct parent/child communication；
- interrupt current turn；
- descendants listing。

可复用的设计点：provider capability preflight、显式 child route allowlist、tool filter、depth bound、continuable/one-shot 分离、结果与中间过程分离。

禁止直接把它当作 HumanAgent 编排：

```text
DSH subagent id ≠ AgentRuntimeId
DSH parent/child ≠ WorkAssignment graph
DSH child result ≠ Operation delivery
DSH interrupt ≠ HumanAgent steer/standard stop operation
```

HumanAgent Orchestration Runtime 必须拥有 Agent Runtime pool、Assignment、stage、resource lease、provider/model binding、checkpoint、review 和 merge。DSH subagent 只能是其中一种 delegation/execution adapter；编排 Agent 不能因拥有 DSH `subagent` 就获得搜索、coding 或任意 spawn 权限。

DSH 的 `list_subagent_models` 也只能作为 capability discovery 参考。HumanAgent 的 provider/model 必须在 Agent Runtime admission 时锁定，在同一 execution epoch 内不可静默切换。

### 2.7 Session Query

DSH `session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read` 提供一套成熟的查询分层：

- full-text search 与 exact event read 分开；
- 支持 event seq/time/type/surface filter；
- 支持 session lineage、ancestor、descendant trace；
- 支持 live/persisted availability；
- 搜索分页和结果 cap；
- current session 查询排除当前调用 step；
- target session、parent、descendant 按 caller workspace 授权；
- 服务错误转为 model-safe error，内部诊断留在日志；
- raw event read 与 presentation text 分开。

这非常适合参考 HumanAgent 的 Absolute Journal 查询，但 DSH session query 不能直接充当 Memory Agent：

- DSH SessionId 不是 TaskId、AgentRuntimeId 或 OrganId；
- workspace scope 不是 HumanAgent task/project/global memory scope；
- DSH event surface 不是 HumanAgent control/data/observation ACL；
- DSH 返回的字符串不是 memory index slot；
- Memory Agent 还要做相似性、重复性、价值、policy memory 和 skill candidate 分析。

HumanAgent 应建立自己的 typed `JournalQueryPort` 和 Memory Agent tools，并可以在 DSH adapter 中把 Session Query 映射为受限 evidence reader。

### 2.8 Skill

DSH `skill` 的设计值得直接参考：

- 先发布 catalog 摘要；
- 按 exact name 显式 load；
- source/digest 可追踪；
- 不把全部 skill 正文塞进每轮 prompt；
- 支持 references/assets 等内容闭包；
- 不同 invocation policy 可以隐藏或禁止调用。

HumanAgent 需要保持对 Codex、`.agent`、`.agents` 和 MCPX 的兼容，但 registry owner 应是 HumanAgent 的 Skill Source Adapter/Lock，而不是 DSH Skill registry。必须补齐 Astra 指出的内容闭包、canonical MCP identity、symlink 和 direct/MCPX 冲突规则。

### 2.9 Plan、Todo、Workflow、Ralph 和 Cordis 动态工具

| DSH 能力 | 可参考之处 | HumanAgent 决定 |
|---|---|---|
| `exit_plan_mode` / `/plan` | 提案展示、用户批准/继续规划、pending→committed 的边界 | 只作为显式 Brain proposal/approval UX 参考；审批绑定自己的 `InteractionId` 和 `proposalRevision` |
| `todo_write` | 小型上下文进度投影；全量替换；parallel in-progress policy | 只能做 Agent 内部 projection；不能驱动 Task、Checkpoint 或 CompletionGate |
| `workflow` | 分阶段脚本、阶段性 provider/model hints、结构化 handoff | 不进入固定 Harness；编排由 HumanAgent 节点和 Assignment 控制 |
| `ralph` | fresh child、bounded rounds、structured report | 不作为通用 long-horizon；其“worker report”不能代替独立 CompletionGate |
| `cordis_inspect_*` / `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` | 动态插件的 inspect、immutable package、run/update/stop/undefine | 仅保留在 DSH 自己的扩展面；不能让模型动态改写 HumanAgent fixed Harness |
| experimental agent-team | 多 Agent UI/实验协同 | 不进入 MVP；以后按独立 adapter review |

### 2.10 ToolRuntime 基础设施

DSH `packages/core/tools` 是最值得借鉴的基础层。它把以下职责分开：

```text
ToolDefinition
  parameters schema
  execute()
  output.schema
  output.render()
  output.presentationMeta()
  output.memory()
  finalizeContent()
  presentCall()/presentResult()

ToolRuntime pipeline
  pre-execute → guard → execute/around → post-execute → normalize → tools/result
```

确认的设计点：

- 参数和成功输出做 schema 校验；
- `execute` 返回 canonical JSON value；
- render 是模型/Native 内容映射，不等于 canonical value；
- presentation metadata 独立于模型内容；
- memory projection 独立于 presentation；
- cooperative AbortSignal 贯穿 pre/execute/post；
- post hook 可以 accept、replace projection、attach additional context 或 block；
- `concludeTurn` 是明确的成功终止标记；
- tool error 不伪装成成功；
- tool registration 变化有 `tools/change` 事件；
- scope-aware listeners 和 tool restrictions 可用于权限层。

HumanAgent 应采用同样的分层，但把 DSH event/hook 类型改写为自己的 provider-neutral contract。特别是：

```text
Tool result mapping ≠ Context append
Tool presentation ≠ business payload
Tool memory projection ≠ automatic memory acceptance
Tool concludeTurn ≠ Task completion
```

## 3. HumanAgent 必须补的内置工具

### 3.1 MVP 必需

MVP 只做固定 Harness 的最小控制面，不要求一次接入全部 DSH 功能：

```text
checkpoint.inspect
checkpoint.recall
checkpoint.save
checkpoint.record_dead_end
checkpoint.reenter

operation.inspect
operation.reconcile
task.inspect
task.cancel
agent.inspect
agent.list
```

这些工具必须是 Harness-owned typed facade。模型只能请求允许的操作；`harness-control` 和 `recovery` 仍可以在模型不响应时提交 closure。

### 3.2 显式 Brain 与 Memory Agent

```text
memory.search
memory.inspect
memory.compare
memory.save_candidate

interaction.ask
interaction.propose
interaction.approve
requirement.submit
task.match
```

`memory.save_candidate` 只保存候选和 evidence，不直接入库为全局记忆或 skill。入库需要 Memory Agent policy/review；显式 Brain 只通过工具调用 Memory Agent，不能用内部对话替代查询或提交。

### 3.3 Long-horizon

```text
sleep
schedule
subscription.create
subscription.list
subscription.cancel
```

`sleep` 用于当前 Request 内的阻塞等待，不绑定 Subscription，也不使用 busy policy；`schedule` 用于并行场景下的非阻塞定时提醒；`subscription.create` 用于持久化巡检 Goal。Subscription 必须绑定 Goal revision、Task owner、memory scope、provider/model policy 和 busy policy；list 最多返回三个活动订阅并明确 `hasMore`/quota；cancel 只取消未来触发，不隐式取消在途 Operation。CompletionGate 进入接受终态时必须使相关订阅幂等失效。

### 3.4 内部而非模型工具

以下是内部 port/event，不应默认暴露给普通 Agent：

```text
event.publish / event.subscribe / event.ack
journal.commit
resource.acquire / resource.release
permission.grant / permission.revoke
provider.bind / provider.revoke
health.probe
review.admit / review.submit
```

它们由 Runtime、Supervisor、Journal Owner、Memory backend 和 UI projection 使用。需要给 Agent 查询时，提供只读、scope-filtered 的 domain facade，不暴露通用总线写入口。

## 4. 按 Agent 角色的 DSH capability allowlist

| Agent | 可加载的 DSH/adapter 能力 | 明确禁止 |
|---|---|---|
| Interaction Agent | `ask_user` 的包装；memory query；task match/status；proposal/approval | shell、web、coding、任意 spawn、直接 submit 后台任务 |
| Orchestration Agent | task/assignment、agent/resource/status、checkpoint inspect/recall、review request、operation reconcile | `read/write/edit/bash/web/lsp`；自己执行 worker 任务 |
| Execution Agent | 按 assignment 最小化加载 fs/search/shell/web/lsp/terminal/job | 改 Task/Assignment/Checkpoint 真源；越权访问其他 Agent 数据 |
| Review Agent | 只读 fs/search/lsp/test evidence；必要时读取 Operation/Journal projection | 未授权写入、替代 CompletionGate、直接改任务状态 |
| Memory Agent | session/journal query、memory backend、skill candidate analysis | 执行业务代码、直接替用户审批、未经 review 写全局记忆 |
| Harness Supervisor | 内部 control ports、health、reconcile、scheduler lease | 通过模型文本猜状态；把 health snapshot 当控制真源 |

## 5. DSH 能力到 HumanAgent 领域对象的映射

| DSH 对象 | HumanAgent 映射 | 允许读取 | 禁止替代 |
|---|---|---|---|
| tool call/result | `Operation` + evidence | call/result、reason、presentation | Task 完成、Checkpoint 提交 |
| DSH Session | adapter evidence ref | 原生请求、工具、会话 lineage | Task、AgentRuntime、Journal |
| DSH Goal | adapter goal evidence | revision、phase、round facts | Task/CompletionGate/Checkpoint |
| DSH Schedule | adapter schedule evidence | target、dispatch、overdue | Subscription/Occurrence/Reminder |
| DSH Job | Operation handle | status、bounded output、settle | OperationId、cancel settled |
| DSH Subagent | delegation evidence | child result/status、provider capability | AgentRuntime/Assignment graph |
| DSH Skill | Skill source evidence | catalog、digest、loaded body | HumanAgent Skill lock/source authority |
| DSH tool presentation | UI projection input | pending/result metadata | 业务 payload、control state |

## 6. Provider/Model 独立配置影响

DSH 已证明 child provider/model 可以通过 allowlist、preflight 和 provider capability 检查进行配置化，但 HumanAgent 要更严格：

```text
Role Template allowlist
  → Assignment policy
  → Agent Runtime admission
  → immutable AgentProviderBinding
  → execution epoch
  → DSH/Responses/Anthropic/native adapter
```

固定规则：

- interaction、orchestration、execution、review、memory Agent 可以各自使用不同 provider/model；
- binding 必须进入 runtime manifest 和 Journal control fact，不进入业务 prompt/payload；
- 同一 execution epoch 内不能静默切换；
- 切换必须新建 binding、重新做 capability/permission/readiness admission，并进入新 epoch；
- DSH 的 `provider/model/session` 只能是 adapter 层；
- 不支持某 binding 时显式 `capability-unavailable`，禁止静默 fallback。

## 7. MVP 到 Milestone 的接入建议

### MVP：固定 Harness，不接 DSH 控制面

只实现/验证：

- provider-neutral Tool/Operation/Result/Hook contract；
- fake/replay execution adapter；
- checkpoint inspect/recall/save/dead-end/reenter；
- task cancel、operation reconcile；
- minimal provider/model binding；
- 单任务 Goal facade；
- provider-neutral blocking `sleep` contract 与 fake-clock/blocking-settle contract；
- Journal/EventBus owner 和 scope 基础；
- Interaction/Memory tools 的 typed facade；
- ACP MVP seam：Server/Driver binding、capability negotiation、delegated tool proof 与 interaction/task 分流；仅验证 HumanAgent typed seam，不宣称广泛第三方兼容。

MVP 不放行：DSH Goal、DSH Schedule、DSH Subagent、DSH Session Query 作为高层控制实现；不放行真实巡检 daemon 作为完成证据。

### Milestone 1：DSH execution adapter

接入顺序：

1. filesystem/search/shell/web/lsp 的最小 capability mapping；
2. DSH ToolRuntime hooks → HumanAgent request/response hooks；
3. DSH tool result/presentation/memory projection → adapter projection；
4. DSH job/terminal stop/settle → Operation reconcile；
5. fake/replay 与真实 DSH 同入口对照；
6. provider/model binding、DSH session evidence 和旧 epoch fencing。

禁止在此阶段把 DSH Goal/Task/Schedule/Subagent identity 上提。

### Milestone 2：long-horizon 与 Memory

实现 HumanAgent 自有：

- Patrol Goal Markdown 与 accepted revision；
- Subscription/Occurrence/Reminder/SchedulerLease；
- Schedule 到期唤醒、Reminder admission、checkpoint recall、新 Request/Cycle 和 restart/fencing；
- busy skip、idle reminder、幂等消费；
- Memory Agent 的 index/search/compare/save-candidate；
- DSH session query 作为受限 evidence source；
- skill catalog/load adapter 和内容闭包 lock。

### Milestone 3：多 Agent 编排与 ACP

实现：

- Agent Runtime pool 与 Assignment graph；
- orchestration/review/execution/memory 的不同 template 和 provider/model；
- ACP 广泛第三方兼容、多 transport 和生产级 peer 集成；
- review/merge/settle/steer 全链路；
- UI observation projection，不复用 DSH WebUI 作为产品真源。

## 8. 已确认的设计决定

以下决定已确认。本文件仍然是只读设计审查，不代表实现、适配或真实运行验收已经完成：

1. 接受“DSH 工具作为可替换 execution adapter；DSH control/state 不上提”为总原则。
2. Goal 分为单任务 Goal 和 long-horizon 巡检 Goal；巡检 Goal 通过 HumanAgent 自有 Schedule/Subscription 触发新的 Request/Cycle。
3. 接受上述 HumanAgent 内置工具清单，增加 provider-neutral 阻塞 `sleep({ after_seconds, reason? })`；sleep 占住当前执行直到时间到期后返回同一 Request，不创建 Schedule、不代表任务完成。并行巡检使用独立的 `schedule`/Subscription 提醒。
4. 接受 DSH Schedule 的 busy 语义不直接复用，改为 HumanAgent 自有 `skip | idle-reminder`。
5. 接受 `workflow`、`ralph`、动态 `cordis_*` 和 experimental agent-team 不进入 MVP。

后续 contracts/runtime/adapter worker 仍需等设计修订完成并通过下一轮适用 review；本文件不授权实现启动。

## 9. 只读证据索引

主要 DSH 源码：

```text
packages/core/tools/src/index.ts
packages/core/tools/src/schema.ts
packages/core/tools/src/presentation.ts
packages/schedule/schedule/src/types.ts
packages/schedule/schedule/src/runtime.ts
packages/schedule/schedule/src/domain.ts
packages/schedule/schedule/src/tools.ts
packages/schedule/schedule/tests/runtime.spec.ts
packages/schedule/schedule/tests/recurrence.spec.ts
packages/schedule/schedule/tests/jsonl-restart.spec.ts
packages/schedule/schedule/tests/tools.spec.ts
packages/goal/goal/src/types.ts
packages/goal/goal/src/domain.ts
packages/goal/goal/src/index.ts
packages/goal/tool-goal/src/index.ts
packages/goal/goal-round-driver/src/index.ts
packages/jobs/tool-jobs/src/index.ts
packages/session-query/tool-session-query/src/{input,operations,workspace-access,service-boundary,presentation,index}.ts
packages/subagent/tool-subagent/src/{index,model-selection,model-selection-state,list-models}.ts
packages/subagent/tool-subagent-control/src/{index,list-agents}.ts
packages/plan/plan-mode/src/index.ts
packages/todo/tool-todo/src/index.ts
packages/interaction/tool-ask-user/src/index.ts
packages/fs/tool-fs/src/{read,write,edit,read-image}.ts
packages/fs/tool-fs-search/src/{glob,grep}.ts
packages/fs/tool-str-replace-editor/src/index.ts
packages/shell/tool-bash/src/index.ts
packages/shell/tool-pwsh/src/index.ts
packages/terminal/tool-terminal/src/index.ts
packages/lsp/tool-lsp/src/index.ts
packages/web/tool-web/src/{fetch,search,index}.ts
packages/skill/tool-skill/src/index.ts
packages/workflow/tool-workflow/src/index.ts
packages/workflow/tool-ralph/src/index.ts
packages/extensions/tool-cordis/src/index.ts
```

DSH composition evidence：

```text
packages/bundle/base/package.json
apps/cli/package.json
```

本文件是设计候选，不是 DSH adapter 完成声明，也不是用户批准记录。
