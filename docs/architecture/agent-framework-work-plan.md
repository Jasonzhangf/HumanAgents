# Agent Framework Work Plan

状态：`ASTRA-REVIEW-PASS / DESIGN-FROZEN / READY-FOR-IMPLEMENTATION-PLANNING / IMPLEMENTATION-NOT-STARTED`

基线：`aace125b3d1381ea05f74d332908af06aa7839e8`

候选工作树：`playground/context-contract`（`codex/context-contract`）

## 1. Astra 结论

首次完整审查（历史、修复前候选）的结论是：`FAIL`。

没有发现 P0；该轮记录为 7 个 P1、2 个 P2。设计方向可以保留，但在该轮 P1 关闭前不能冻结为实现前置契约，也不能让多个 worker 按旧接口同时开始实现。

P1（以下为合并后的主要问题摘要，不是原始 finding 的逐项清单；原始总数以轮次记录为准）：

1. Checkpoint 不能只允许模型工具推进。模型失联、修复耗尽、权限撤销、进程重启和 interaction 取消，必须由同一个 Checkpoint Owner 通过 `agent-tool | harness-control | recovery` 三类来源提交；`committed` 和 `reentryAllowed` 分开，interaction 使用独立 closure。
2. `AgentDriver` 新旧生命周期接口冲突。必须冻结 provider-neutral API，分清 runtime、request dispatch、observe、stop receipt、reconcile、settle 和 transport close；旧接口声明迁移关系。
3. EventBus 还缺可信发布主体、scope ACL、durable cursor、ACK 提交点、重复投递去重和撤权重放规则。控制事实必须先 durable commit，再发布；观察事件可以丢弃，控制事件不能丢。
4. ACP Server/Driver 的执行信任边界未闭合。必须有独立 binding、能力协商、工具委托/准入证明，并区分 interaction 与 task 的 cancel/load/close。
5. long-horizon 订阅缺少 Goal、Subscription、Occurrence、Reminder 和 scheduler lease 契约，不能把现有 UI SSE subscription 当成定时调度。
6. 现有 JSONL Journal 的并发追加可复现重复 seq。多 Agent、EventBus 和 scheduler 共用前必须由 Journal Owner 做跨进程串行追加和 commit 去重。

P2：

- Skill/MCP lock 需要定义内容闭包、canonical identity 和冲突规则。
- 旧架构文档需要引用新 retention 契约，避免历史清理规则和 Absolute Journal 分裂。

审查边界：Astra 只读检查了候选设计、现有架构、代码和测试；没有声称 DSH、ACP、真实 daemon 或 Provider 已完成验收。

## 2. Astra remediation map

Astra remediation map（历史 finding）：本节保留修订轨迹；设计门已通过，后续只按本计划派发实现任务。

上一轮第三轮 review（候选 `aace125b3d1381ea05f74d332908af06aa7839e8`，修复前）结论：`FAIL`，`P0=0 / P1=2 / P2=2`。该轮未关闭项是 EventBus retry obligation、EventBus operation-barrier、ACP 阶段归属、review 轮次记录；本候选已完成修订。

最终 Astra review：native Astra `Anscombe` 对同一未提交候选、基线 `origin/main` 复审，结论 `PASS`，`P0=0 / P1=0 / P2=0`。复审只覆盖设计合同和文档一致性；没有运行实现测试、真实 DSH/ACP/provider、daemon 或崩溃恢复验收，因此这些仍是后续 milestone 的交付门。

历史轮次仅作审计记录：第一轮 `P0=0 / P1=7 / P2=2`；第二轮 `P0=0 / P1=4 / P2=2`。历史统计不代表当前未关闭数量。

| Finding | 唯一修订 owner | 设计修订 | 实现前证据 |
|---|---|---|---|
| F1 EventBus consumer commit | Event delivery | `agent-communication-and-feedback.md` §5：consumerKey、receipt、cursor/ACK、幂等、重试/DLQ、重启恢复 | 丢 ACK、重复投递、消费失败、离线恢复测试合同 |
| F2 publisher/scope/class | Contracts/Core | 通信文档 §2–3：RuntimeBinding、trusted publisher、control/data/observation、scope/ACL、epoch fencing | 跨 scope、撤权、旧 epoch、伪造 publisher 负测 |
| F3 ACP binding | ACP adapter | `agent-request-response.md` §10.2：ServerBinding、DriverBinding、delegation proof、interaction/task 分流 | 无 proof unavailable、interaction cancel/load、task stop/reconcile 负测 |
| F4 checkpoint closure | Checkpoint/Control | `agent-request-response.md` §6：事实收拢条件与 reentry 条件分离 | 撤权、unknown operation、无进度 watchdog 仍可提交不可重入 closure |
| F5 runtime/assignment binding | Agent Template/Assignment | `agent-templates.md` §2.3/§8：task-bound `assignmentId` 必填，绑定准入点唯一 | 未绑定 runtime 不能发送 task Request |
| F6 Driver migration | Agent I/O | `agent-request-response.md` §10、`organ-runtime.md` §3.3：dispatch/result/observation 分离 | 旧 submit 兼容、result read、stream cursor/EOF replay |
| F7 MVP/M2 UI split | UI projection | U 拆为 MVP task projection 和 M2 schedule projection | MVP 不依赖 S；M2 再增加 Reminder projection |

当前未关闭项：

| Finding | 唯一修订 owner | 当前修复要求 |
|---|---|---|
| R1 retryable failure | Event delivery | `CLOSED`：retry obligation durable commit；不提交最终 receipt/cursor；重启从原消息重投；obligation 从 pending 转 exhausted 后才提交 terminal-failure receipt |
| R2 mixed effects/operations | Event delivery | `CLOSED`：`journal-atomic` 禁止外部 Operation；`operation-barrier` 在 settle/reconcile 前不提交最终 receipt/cursor |
| R3 ACP 阶段归属 | ACP adapter / plan owner | `CLOSED`：MVP 固定 binding、capability negotiation、delegated proof、interaction/task 分流；M3 只保留广泛兼容、多 transport、生产 peer |
| R4 review 记录 | Plan owner | `CLOSED`：历史轮次、当前候选和复审结果分开记录 |

P2 同步收口：`organ-runtime.md`/`memory-system.md` 引用 Absolute Journal 保留根；DSH tool review 标记为旧版本参考，M1 只能使用锁定 DSH baseline 复核结果。

## 3. 两类 Goal 与 Long-horizon 固定最小契约

HumanAgent 固定区分两类 Goal：

```text
单任务 Goal
  → bounded Cycle / Request
  → checkpoint / review / CompletionGate
  → complete | blocked | cancelled | reenter

Long-horizon 巡检 Goal
  → Goal Markdown / accepted revision
  → Subscription / Occurrence / Reminder
  → checkpoint recall
  → new Request / Cycle
  → inspect / report
  → complete | continue | reschedule
```

单任务 Goal 负责一次有边界的任务执行；巡检 Goal 负责持久目标和按时间触发的多次执行。巡检的每次触发可以产生一个单任务 Cycle，但 Subscription、Occurrence、Reminder 和 SchedulerLease 不属于单任务 Goal 的普通状态，也不能由 Agent 自己维护。

这是内置 Harness 能力，不是 Agent 自己维护的循环。

```text
Goal Markdown / accepted revision
  → Subscription Coordinator
  → due Occurrence
  → durable Reminder（幂等）
  → permission + busy/resource admission
  → checkpoint recall + Goal revision
  → Request/Cycle
  → bounded watchdog
  → settle/checkpoint
  → CompletionGate
  → consume / invalidate reminder
```

唯一 owner：

| 对象 | Owner | 不能负责什么 |
|---|---|---|
| Goal/Task 状态 | `core` 规则 + Runtime Task owner | 不能从 Markdown 或模型文本猜完成 |
| Subscription/Occurrence | Runtime Subscription Coordinator | 不直接启动 Agent、不绕过 admission |
| Reminder/消费 | Reminder owner（与 Subscription Coordinator 同一提交责任） | 不重复创建 Request |
| Agent busy/epoch | Agent Runtime Manager | 不从 health snapshot 猜 busy |
| daemon lease/时钟/唤醒 | Host Supervisor | 不决定 Task 完成 |
| 事实和资产 | Journal/Filesystem adapter | 不做调度决定 |

内置工具：

- `sleep`：当前 Agent 没有其他并行任务时使用的有界阻塞 Operation；时间到期后返回同一 Request，继续当前执行，不创建 Schedule。
- `schedule`：并行执行时使用的非阻塞定时语义；到期只产生 Occurrence/Reminder，不占住当前 Agent。长期巡检通过 `subscription.*` 管理其持久化 Schedule。
- `subscription.create`：单次、有限次数循环、直到 Task 进入接受终态；创建 Goal revision 引用和 schedule revision。
- `subscription.list`：稳定排序、权限过滤、单次最多返回 3 项并带 opaque cursor/`hasMore`；不静默截断。是否限制活动订阅总数另设 quota，不能混同。
- `subscription.cancel`：取消未来唤醒，不隐式取消在途 Task。
- `task.cancel`：只能提交标准 stop operation；Agent 不能冒充 `harness-control`。

固定状态：

```text
Subscription: active → completed | exhausted | cancelled | suspended
Occurrence: due → skipped-busy | reminder-pending → claimed → consumed | invalidated
Task cancel: cancel-requested → stopping → cancelled | unknown/waiting-reconcile
```

固定语义：

- `busyPolicy=skip`：提交 `skipped-busy`，本次 occurrence 消耗，不自动重放。
- `busyPolicy=idle-reminder`：每个 Subscription 最多一个待消费 Reminder；后续到期合并，不无限积压。
- 幂等键：`subscriptionId + scheduleRevision + occurrenceOrdinal`；Reminder 用稳定 `reminderId`，不能把 daemon generation 放进幂等键。
- 忙闲检查与 claim 必须在同一 admission 边界完成；daemon 不在线不是 idle。
- 重启先取得唯一 scheduler lease、校验 Journal、恢复未收拢 operation，再恢复 trigger；旧 generation 不能提交。
- 完成、取消、撤权和 Reminder 消费按 owner 接受的 revision/事务顺序裁决。
- UI 只读展示下次触发、跳过/积压原因、关联 Request 和消费结果；取消走 command port。

目标文件建议：

```text
~/.humanagent/project/<project-key>/goals/<goalId>/goal.md
```

Markdown 是人可读目标载体，不是状态真源；Journal 保存 accepted revision、digest、subscription、occurrence、reminder 和完成事实。

## 4. Agent 独立 Provider/Model Binding

Provider 和 model 是每个 Agent Runtime 的显式绑定，不是一个全局默认值。角色模板只声明允许的 provider/model capability；Task/Assignment 在准入时选择具体 binding；Runtime Manifest 锁定本次实际使用的 binding。一个任务中的 interaction、orchestration、execution、review、memory agent 可以使用不同的 provider、model、protocol 和资源等级。

```text
Role Template allowlist
  + Agent/Task profile selection
  + permission/resource admission
        ↓
AgentProviderBinding（immutable for execution epoch）
        ↓
Provider-neutral AgentDriver / ProviderAdapter
        ↓
DSH / RCC / native / remote adapter
```

每个 binding 至少保存：

```text
bindingId
providerId
protocol
endpointRef（非敏感引用）
modelRef
configDigest
capabilityDigest
selectionReason / owner
```

固定规则：

- 选择由 Harness/config owner 完成，Agent 不能从 prompt、工具结果或 provider response 自选或切换。
- binding 在一个 execution epoch 内不可静默切换；切换必须新建 binding、重新做 capability/permission/readiness admission，并按 checkpoint 规则进入新 epoch。
- Provider adapter 只消费 provider-neutral binding；DSH 只在 DSH adapter 内解释 DSH profile，不能把 DSH session/model 类型上提为领域身份。
- `~/.rcc`、`~/.agent`、`~/.agents`、`$CODEX_HOME` 等外部配置只读；HumanAgent 保存非敏感引用和 digest，不复制 secret。
- Provider/model 不进入业务 payload；高层只持久化 binding ref/digest 和 execution evidence。
- 当前 adapter 不支持某 binding 时显式返回 `capability-unavailable`，不得静默回退到另一个 Agent 的 provider/model。
- 运行时重启必须按锁定的 binding 恢复或明确进入 reconcile；旧 binding 的结果不能推进新 epoch。

## 5. 依赖图

```text
D 设计修订 / 契约冻结
└── C 公共 contracts + core 规则
    ├── J Journal / filesystem 持久化
    ├── X Context / projection / cache
    ├── Q Agent request / response / watchdog
    ├── K Checkpoint / stop / reentry
    ├── E EventBus / delivery
    ├── H Host supervisor / lease
    ├── A1 ACP adapter
    └── A2 Skill / MCP / MCPX adapters

J + E + K + H
    └── S Long-horizon subscription / reminder（Milestone 2）

Q + K + E
    └── U UI projections / observation（MVP task projection）

MVP 节点：C + J + X + Q + K + E + H + A1 + A2 + U
    └── I App/Cordis composition + MVP integration gate

Milestone 2：S + U schedule projection
    └── I App/Cordis composition + long-horizon integration gate
```

`D` 完成前不派发依赖 `C` 的实现。`C` 是 `packages/contracts` 与 `packages/core` 的唯一 owner；其他 worker 不直接修改共享类型或公共 export。

## 6. 并行任务合同

所有任务都必须从最新 `origin/main` 建立 `playground/<task-name>` 独立 clean worktree。候选 worker 不能覆盖其他 worktree、main、RCC/DSH 配置或用户数据。每个 worker 必须回报：候选 SHA、修改文件、测试命令/结果、未完成项、清理结果。

### D — Design remediation（已完成的设计门，不是实现任务）

- Owner：架构/契约 owner。
- 允许写入：`docs/architecture/context-contract.md`、`agent-communication-and-feedback.md`、`agent-request-response.md`、`agent-templates.md`、`host-and-cordis.md`、`host-install-release-session.md`、`lifecycle-and-failure-ownership.md`、`organ-runtime.md`、`memory-system.md`、`dsh-built-in-tool-review.md`、本计划文档。
- 禁止写入：`packages/`、`tests/`、其他 worker worktree、项目 main。
- 必须关闭：D1–D5；补单任务 Goal 与 Patrol Goal 的边界、Goal/Subscription/Occurrence/Reminder/SchedulerLease；定义 provider-neutral blocking `sleep` 与非阻塞 Schedule/Reminder 的差异；落盘 Agent communication/feedback contract；统一 Driver API；定义 durable EventBus；定义 ACP binding/capability；定义 Harness-control Checkpoint 入口；补 Agent 独立 Provider/Model Binding、选择 owner、epoch 切换和外部配置只读边界。
- 完成 iff：逐条给出 state、owner、持久化顺序、失败出口、权限和重启语义；旧文档只引用新真源；新增内容可按稳定内容 hash 绑定。
- 验证：`git diff --check`；文档交叉检查；D1–D5 场景矩阵全部有唯一答案。
- 状态：已完成；最终 Astra review `PASS` 后，C 可以由用户另行派发。

### C — Public contracts and core rules（P1，MVP）

- Owner：Contracts/Core。
- 允许写入：`packages/contracts/src/`、`packages/core/src/`、`tests/contracts/`、`tests/core/`、本任务目录下的 tsconfig。
- 禁止写入：`packages/runtime/`、`packages/app/`、`packages/adapters/`、`packages/ui/`、根 `package.json`、其他 worker 的测试入口。
- 交付：`AgentBinding`、版本化 Driver API、`AgentProviderBinding`、`RuntimeBinding`、`AgentMessageEnvelope`、Control/Probe/Watchdog、Checkpoint source/closure/reentry、Event identity/delivery/ACL、ConsumerReceipt/cursor、Goal/Subscription/Occurrence/Reminder/Lease、ACP binding、negative validators。
- 完成 iff：所有类型能表达 interaction 无 Task、task assignment/epoch、Harness stop/recovery、scope 权限、幂等键和每个 Agent 的独立 provider/model binding；没有从业务 payload 重建控制事实。
- 验证：`pnpm test:contracts`；`pnpm exec tsc -p tests/core/tsconfig.json`；运行编译后的 core tests；覆盖负向矩阵。
- 依赖：D。

### J — Journal and filesystem persistence（P1，MVP）

- Owner：Persistence。
- 允许写入：`packages/adapters/jsonl/`、`packages/adapters/filesystem/`、对应 `tests/adapters/jsonl/`、`tests/adapters/filesystem/`、任务内 tsconfig。
- 禁止写入：`packages/contracts/`、`packages/core/`、`packages/runtime/`、`packages/app/`、根脚本。
- 交付：跨进程 Journal append owner、seq/previous 校验、commit identity、receipt lost 查询去重、Goal/Context asset 原子恢复。
- 完成 iff：并发 writer 不再产生重复 seq；commit 前后崩溃可恢复；事件/资产引用完整；不得删除保留根。
- 验证：现有 JSONL/filesystem tsconfig 与对应 node tests；新增多 writer、回执丢失、重启恢复测试。
- 依赖：C。

### X — Context / projection / cache（P1，MVP）

- Owner：Context。
- 允许写入：新 `packages/runtime/src/context/`、`tests/runtime/context/`、任务内 tsconfig。
- 禁止写入：`packages/contracts/`、`packages/runtime/src/checkpoints/`、`packages/runtime/src/control/`、`packages/app/`、`packages/ui/`。
- 交付：MessageGroup、effective path、Builder/Mapper/CommitIntent/Committer/Renderer、binding/permission cache namespace、stable prefix/repair/tail、ToolReasonProjection。
- 完成 iff：原生 Tool Call/Result 不孤立；控制字段不进入 Context；权限撤销不能发送旧 View；提交前后崩溃不重做副作用。
- 验证：新增 context tsconfig + node tests；并行 Tool、不同 binding 缓存隔离、CAS 冲突、commit crash、绝对历史保留样例。
- 依赖：C；持久化集成依赖 J，但可先用明确 fake port。

### Q — Agent request/response and watchdog（P1，MVP）

- Owner：Agent I/O。
- 允许写入：新 `packages/runtime/src/agent-io/`、`packages/runtime/src/hooks/`、`tests/runtime/agent-io/`、`tests/runtime/hooks/`；仅可最小改动 `packages/runtime/src/nodes/agent-runtime.ts` 以接入稳定接口。
- 禁止写入：`packages/contracts/`、checkpoint owner 文件、EventBus owner 文件、Provider adapter、app composition。
- 交付：Request/Attempt 状态、partial decoder、end-turn summary、EOF、bounded repair、watchdog、阶段 hook、Control/Tool/Memory events；请求只能使用 Runtime 已锁定的 AgentProviderBinding。
- 完成 iff：缺 optional 不失败；缺 end-turn summary 只进入有限修复；EOF 不等于完成；修复不产生新副作用；计数重启后不重置；核心 hook 阻断、观察 hook 可见不阻断；provider/model 只能来自 binding，不能由响应覆盖。
- 验证：runtime 相关现有测试 + 新 agent-io/hooks tsconfig；假时钟、EOF、repair exhausted、restart budget 测试。
- 依赖：C；Checkpoint/Event 只依赖 typed port。

### K — Checkpoint, stop and reentry（P1，MVP）

- Owner：Checkpoint/Control。
- 允许写入：`packages/runtime/src/checkpoints/`、`packages/runtime/src/control/`、新 `packages/runtime/src/checkpoint-tools/`、对应 runtime tests。
- 禁止写入：`packages/contracts/`、`agent-io/`、EventBus、Subscription、Provider adapter。
- 交付：五个内置 checkpoint tools；`agent-tool | harness-control | recovery` 统一提交入口；dead-end/reentry；unknown operation reconcile；stopped/unknown closure；interaction closure。
- 完成 iff：模型失联、零进展、权限撤销、进程重启可收拢；Control disposition 不能单独提交；旧 epoch 不推进；未知副作用不盲重做。
- 验证：`pnpm test:runtime` 相关套件；补工具拒绝、Harness stop、dead-end、reentry、进程重建测试。
- 依赖：C；Journal 集成依赖 J。

### E — Durable EventBus and delivery（P1，MVP）

- Owner：Event delivery。
- 允许写入：新 `packages/runtime/src/events/`、`tests/runtime/events/`、任务内 tsconfig。
- 禁止写入：Journal adapter、contracts、control/checkpoints、UI、app。
- 交付：可信 publisher、scope ACL、control/data/observation 三类事件、durable cursor、ACK/consumer receipt 幂等、commit-before-delivery、handler effect 与 cursor 原子提交、有限重试/DLQ、撤权后重放拒绝。
- 完成 iff：控制事实先持久化再发布；事件重投不重做 Operation；离线/ACK 丢失可恢复；外部 Agent 默认不能发布控制事件或跨 scope 订阅。
- 验证：events tsconfig + node tests；重投、ACK 丢失、旧 epoch、跨 scope、撤权、离线恢复。
- 依赖：C；持久化集成依赖 J。

### H — Host supervisor and resource lease（P1，MVP）

- Owner：Host lifecycle。
- 允许写入：新 `packages/app/src/supervisor/`、必要的 `packages/app/src/session-store.ts`、对应 `tests/app/`；任务内 tsconfig。
- 禁止写入：runtime domain owner、Journal adapter、Provider protocol、UI domain model。
- 交付：唯一 daemon lease、generation fencing、startup/dispose closure、部分启动逆序释放、崩溃接管和 readiness。
- 完成 iff：旧 owner 不能提交；daemon 重启先取得 lease 再恢复；失败阶段有 owner/next action；不把 health snapshot 当 busy 真相。
- 验证：`pnpm test:app`；真实子进程中断/重启、旧 generation、部分启动失败、释放顺序测试。
- 依赖：C；持久化恢复依赖 J。

### A1 — ACP Server/Driver（P1，接缝闭合；广泛兼容可延期）

- Owner：ACP adapter。
- 允许写入：`packages/adapters/acp/`、`packages/app/src/acp/`、`tests/adapters/acp/`、`tests/app/acp/`。
- 禁止写入：contracts、runtime control/checkpoint、Provider adapter、UI。
- 交付：ServerBinding/DriverBinding、能力协商、interaction/task 分流、权限/工具委托证明、cancel/load/close 语义。
- 完成 iff：外部 peer 不能绕过 admission；cancel accepted≠stopped；无证明能力显式 unavailable；ACP id 不替代 HumanAgent id。
- 验证：fake/replay ACP tests；真实 peer 之前不得宣称广泛 ACP 兼容。
- 依赖：C、Q、E、K 的 typed seams。

ACP 的 MVP 接缝包含 binding、能力协商、delegated tool proof 和 interaction/task 分流；Milestone 3 只扩展广泛第三方兼容、多 transport 与生产级 peer 集成。

### A2 — Skill/MCP/MCPX sources（P1 接缝；P2 细化可延期）

- Owner：Capability source adapters。
- 允许写入：`packages/adapters/skills/`、`packages/adapters/mcp/`、对应 tests；必要时只增补 `packages/agent-templates/src/` 的 loader seam。
- 禁止写入：contracts、runtime lifecycle、MCP 原配置、`~/.agent`、`~/.agents`、`$CODEX_HOME`、MCPX workspace 数据。
- 交付：只读 source、显式 allowlist、digest/conflict、canonical MCP identity、MCPX duplicate prevention、permission binding、动态变更 revalidation。
- 完成 iff：发现不授予权限；外部配置不复制 secrets；活动 Task 不自动换 binding；schema/digest 漂移显式失败。
- 验证：source fixture、冲突/漂移/未 allowlist/重复注册负测；真实 MCPX 只做适用入口证据。
- 依赖：C；Q/E 接缝只接 typed port。

### S — Long-horizon subscription/reminder（P1，Milestone 2）

- Owner：Subscription Coordinator。
- 允许写入：新 `packages/runtime/src/subscriptions/`、`tests/runtime/subscriptions/`、任务内 tsconfig；Goal asset 通过 J 的 port。
- 禁止写入：Journal adapter、Host supervisor、Checkpoint owner、Agent I/O、UI、用户全局配置。
- 交付：Patrol Goal Markdown/revision、single/finite/until-complete、Schedule 到期提醒、Reminder admission、checkpoint recall、新 Request/Cycle、busy skip/reminder、最多 3 项 list+cursor、cancel、occurrence/reminder 幂等、重启/fencing。`sleep` 阻塞语义不属于本任务的 Schedule 实现。
- 完成 iff：忙时不强插；提醒不无限积压；取消只影响未来唤醒；完成使订阅和积压提醒失效；旧 daemon 不能派发；不产生第二套任务循环。
- 验证：重复 trigger、次数耗尽、连续 busy、idle race、重启、ACK 丢失、取消/完成/撤权竞态、时钟回拨、列表分页、越权取消。
- 依赖：J、E、K、H。

### U — UI projection / observation（P1 接入；分阶段交付，不拥有控制）

- Owner：UI projection。
- 允许写入：`packages/ui/`、`tests/ui/`；必要的只读 app projection port。
- 禁止写入：Journal、runtime state、checkpoint、queue、retry/steer operation、DSH Session。
- MVP 交付：request/response stage、checkpoint/reentry、WorkResult/Attention、EventBus delivery、ToolReason 的只读 task projection；过期/断线状态可见。
- Milestone 2 增量：Schedule/Occurrence/Reminder、busy skip/idle-reminder、long-horizon projection；不改变 MVP task projection owner。
- 完成 iff：普通 UI 不展示 raw Control Block；操作经 command port；Observation 不能修改状态或重试；MVP task projection 不依赖 S。
- 验证：MVP 先运行 `pnpm test:ui` 的 task projection 子集；M2 再运行 schedule/reminder 子集；覆盖事件顺序、断线、stale projection、权限过滤、只读命令边界。
- 依赖：MVP 为 C、Q、E、K；M2 增量增加 S。

### I — App/Cordis composition and integration gate（P1，每个 Milestone 的最后集成）

- Owner：Integration。
- 允许写入：`packages/app/src/` 组装入口、`packages/config/src/`、`packages/agent-templates/src/`、公共 export、根 `package.json`、`tests/app/`、`tests/release/`；只合并其他任务已通过 review 的候选。
- 禁止写入：替代其他模块 owner 的实现；不修改 DSH/RCC 源码和用户配置。
- 交付：固定插件装载、内置 tools/hooks、每个 Agent 的 Provider/Model binding 装配、Driver/ACP/Skill/MCP source 绑定、Agent communication channel 装配、startup/readiness/dispose、真实入口集成。
- 完成 iff：MVP 至少能从 create → request → checkpoint → cancel/complete 的同入口闭环可回放；Milestone 2 再扩展到 trigger → busy → idle reminder → recover。配置、版本、证据绑定最终 main SHA；未实现 adapter 明确 unavailable。
- 验证：`pnpm run ci:check`、release gate、适用的 DSH/RCC/daemon replay；按 gate checkpoint 从首个失效阶段重跑，不全量重复。
- 依赖：MVP gate 依赖 C、J、X、Q、K、E、H、A1、A2、U；Milestone 2 gate 在此基础上增加 S。

## 7.1 MVP 与延期边界

本计划中的 MVP 是“可恢复、可审计的单任务 Harness 基线”，不是把旧 Wave 0/1/2 重新判为未完成。Long-horizon 的真实 Schedule daemon 放在 Milestone 2；MVP 只冻结 `sleep` 的 provider-neutral blocking contract 和 fake-clock/blocking-settle contract。

必须进入本轮 MVP：

- C/J/Q/K/E/H/I；
- X 的最小 Context/缓存/ToolReason 闭环；
- 单任务 Goal facade；
- provider-neutral blocking `sleep({ after_seconds, reason? })`、Operation settle/cancel 和同一 Request 返回的 typed contract；
- 每个 Agent 独立 Provider/Model binding、锁定和 capability/readiness admission；
- A1/A2 的显式能力边界和 fake/replay 接缝；
- U 的只读观察 projection；
- Journal 并发修复、权限和幂等测试；
- 不包含真实 long-horizon daemon、Patrol Subscription 和 Schedule persistence。

可以延期：

- Patrol Goal Markdown、Subscription/Occurrence/Reminder/SchedulerLease（进入 Milestone 2）；
- Schedule 的真实 daemon timer、busy admission 和 restart/fencing（进入 Milestone 2）；`sleep` 的阻塞 timer 属于 MVP，但不承担后台提醒。
- ACP 的广泛第三方兼容；
- 多种 MCP transport、vector/RAG/Memmy 后端；
- 多节点 scheduler、热替换、生产部署；
- 跨 Agent 缓存共享和自动压缩优化；
- Skill/MCP 的 P2 内容闭包细化（但不能延期 source digest、allowlist 和权限边界）。

设计门已完成。实现按 `C → MVP 并行波次 → MVP I → M1 DSH → M1 I → M2 S/Memory → M2 I → M3 Orchestration/ACP → M3 I` 派发；每个阶段独立 review、写回 gate checkpoint，只从首个失效节点重跑。用户负责创建和分配 worker，本计划不自动启动 worker。

## 7. Milestone delivery map

### MVP — 固定 Harness 单任务基线

范围：C、J、X、Q、K、E、H、A1、A2、U，最后由 I 组装。目标是单任务可恢复、可审计、可回放；不接 DSH 控制面，不放行真实 long-horizon daemon。

并行方式：先派发 C；C 通过后并行 J/X/Q/K/E/H/A1/A2/U。J、E、K、H 的持久化和控制接缝按依赖等待，不共享写入范围。最后只由 I 合并已 review 的候选并跑 MVP gate。

MVP 完成 iff：同一入口可回放 `create → request → control/tool hook → checkpoint/reentry → cancel/complete`；故障、无进展、权限撤销、重启和 ACK 丢失都有明确 owner、持久化事实和恢复出口。`sleep` 是同步阻塞 Operation；Schedule、Patrol Goal 和真实 Reminder daemon 不在 MVP。

### Milestone 1 — DSH execution adapter

Owner：DSH adapter。允许写入 `packages/adapters/dsh/`、对应测试和最小 app composition；禁止把 DSH Goal/Task/Schedule/Subagent/Session 提升为 HumanAgent 高层身份。

交付：锁定 DSH baseline；filesystem/search/shell/web/lsp 最小 capability mapping；ToolRuntime 与 HumanAgent request/response hooks；tool result/presentation/memory projection；job/terminal stop、settle、reconcile；provider/model binding、session evidence 和旧 epoch fencing；fake/replay 与真实 DSH 同入口对照。

完成 iff：一个 HumanAgent Agent Runtime 可以通过 DSH adapter 完成工具调用、持续推理、固定 control block 解析、checkpoint 收拢和实际 stop/settle；失败显式可见，未知 Operation 只走 reconcile，不盲目重做。真实 DSH 同入口证据齐全后才报告 M1 完成。

### Milestone 2 — Long-horizon 与 Memory

Owner：Subscription Coordinator + Memory adapter。交付 Patrol Goal Markdown/revision、Subscription/Occurrence/Reminder/SchedulerLease、busy skip/idle reminder、checkpoint recall、restart/fencing、最多三项订阅列表，以及 Memory Agent 的 index/search/compare/save-candidate、受限 session evidence、Skill source lock。

完成 iff：定时触发幂等；忙时不强插；取消只影响未来唤醒；完成使订阅和积压提醒失效；Memory 只向上下文注入 scoped index，不把全局记忆混入 task-bound Agent；Schedule 与 `sleep` 的阻塞/提醒语义不混淆。

### Milestone 3 — 多 Agent 编排与广泛 ACP

Owner：Orchestration Runtime + ACP adapter + UI observation projection。交付 Agent Runtime pool、Assignment graph、interaction/orchestration/execution/review/memory templates、独立 provider/model binding、EventBus feedback/capability channel、review/merge/settle/steer 全链路、广泛 ACP peer、多 transport 和生产级 peer 集成。

编排 Agent 只负责计划、资源、派发、结果检查和 merge；执行 Agent 负责搜索、coding 等具体工作；Memory Agent 负责 scoped 查询、比较、候选沉淀。所有 Agent 仍通过 capability/event contract 协同，不读彼此私有 Context/Session。

完成 iff：一个任务可从交互输入经 Assignment graph 分派到多个 Agent，结果、失败、资源、review、memory feedback 可闭环回到唯一 owner；旧 epoch、越权、重复 delivery、外部 Operation 未 settle 和 peer cancel 均不能伪造完成。`workflow`、`ralph`、动态 Cordis 仍不进入当前计划。

## 8. Goal 与 DSH 边界固定项

- HumanAgent 对外只暴露自己的 Goal、Task、Cycle、Schedule、Subscription、Occurrence 和 Reminder 定义。
- DSH 的 Goal、Schedule、Subagent、Session 和 provider/model 只在 adapter 内部存在，不能直接进入 HumanAgent Journal、业务 payload 或 UI domain model。
- `sleep` 只是一项 Harness blocking control tool；它不能调用 DSH 高层 Goal/Schedule 作为控制真源。并行提醒必须走 HumanAgent Schedule/Subscription。
- `workflow`、`ralph`、动态 Cordis 不进入 MVP，也不作为固定 Harness 的隐式 fallback。
