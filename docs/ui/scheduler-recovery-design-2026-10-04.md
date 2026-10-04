# Scheduler R5 recovery design 2026-10-04

状态：**PRE-CODE DESIGN CANDIDATE**。本文件是 R5 两个 P1 缺口的恢复设计，不是 source 修复，也不授予 source PASS。Source R5 已达 skill 的五轮上限，本轮不启动 R6，也不替代独立 source review。

## 1. 输入、候选与结论

- UTC：`2026-10-04T17:10:35Z`
- Worktree：`/Volumes/Intel/playground/humanagent/interaction-scheduler-implementation-20261003`
- Branch：`codex/interaction-scheduler-implementation-20261003`
- Candidate HEAD：`9260f27a91e91a1cc115f2f7f9521fea96a91a52`
- Candidate tree：`da39af5778cedfe695599852136ee795d25a2fe6`
- Candidate parent：`249e39ae0896053846e67a33405c0788a8fea4f5`
- 当前 `origin/main`：`0020ab4f4442ea59bf4b9fc02416a8a77c6c68ed`
- 输入 worktree clean；当前只有 docs/graph 变化，产品源码、测试、脚本、package、lock、config、version 均未改。
- R5 review 真源：`E/reviews/scheduler-implementation-r5/{status.json,review.final.md,review.exit}`
- R5 结果：`state=failed`、`failureClass=code_failure`、`outcomeReason=blocking_findings`、exit `0`；两个 P1 未通过，source 不获准进入组合。

结论：

1. Busy reminder 无公开恢复出口，已用真实 `JsonlOrganJournal` 通过公开 `SubscriptionControlPort.schedule`/`claim` 复现。
2. 未结算执行重复派发，已用真实 `JsonlOrganJournal` 和同一/重启公开 port 复现。
3. 两个缺口的最小恢复必须落在唯一 runtime scheduler owner，并复用现有 Journal、core 校验和 W3 真实 serve-task 消费边界。
4. 执行幂等恢复要求真实 durable consumer；当前 W3 保留树没有可证明的 `ServeTaskConsumerPort` 实现，该项必须显式标为 `BLOCKED` 前置，不能由 scheduler 内存标志或诊断 counter 冒充。

## 2. RED 证据

诊断根目录：

```text
E=/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run
```

### 2.1 Busy reminder RED

- 脚本：`E/scheduler-r5-recovery-design/diagnostic/probe-busy-reminder.mjs`
- 脚本 SHA-256：`e5d23a4adfa24b7f346b747547c70088475156e4fc5080dcaca229caf01d8f76`
- 日志：`E/scheduler-r5-recovery-design/raw/probe-busy-reminder.log`
- exit：`0`

输出摘要：

```json
{
  "red": true,
  "busyState": "reminder-pending",
  "idleState": "reminder-pending",
  "reminder": { "state": "pending" },
  "claimError": { "code": "invalid-occurrence", "message": "occurrence state reminder-pending is not claimable" }
}
```

`schedule({busy:true})` 后 journal 持久化 `occurrence=reminder-pending` 和 `reminder=pending`；随后 `schedule({busy:false})` 走 existing 分支直接返回，未收拢 reminder。`claim` 调 core `assertOccurrenceClaimable`，只接受 `due`，返回 `invalid-occurrence`。

### 2.2 Execution replay RED

- 脚本：`E/scheduler-r5-recovery-design/diagnostic/probe-execution-replay.mjs`
- 脚本 SHA-256：`1ac0b8e2bbf5648c28abefecc5511284da8bf16ed4a98da3ab93b0f818821745`
- 日志：`E/scheduler-r5-recovery-design/raw/probe-execution-replay.log`
- exit：`0`

输出摘要：

```json
{
  "red": true,
  "dispatchCount": 3,
  "afterSettleDispatchCount": 3,
  "settledReplayReturnsCommittedWithoutDispatch": true
}
```

有效 claim 的 `consumeExecution` 在 settle 提交前被调用三次：同一 port 一次、重启 port 一次，另一次由同 port 直接第二次调用。三次均派发注入 counter consumer。settle 后重放返回已提交 terminal，不再派发。当前 `consumeExecution` 只在 `snapshot.settlements` 已存在时重放，执行与结算之间的窗口无 durable 判定。

诊断 counter consumer 只是 RED 派发证据，不能作为 real Provider/business GREEN 接受。

### 2.3 输入、输出与 fixture closure

两个 probe 都从本 candidate 的公开编译入口加载：

- source `packages/runtime/src/subscriptions/index.ts` SHA-256：`3e91ab18e1a7b2945519e42c93139d15a30980cdb8df12519ed5818edc1f34ae`
- source `packages/core/src/subscription.ts` SHA-256：`788a973ac4415199dcf708ca30148965156cc40871a36519b2d5082472d9e898`
- emitted runtime SHA-256：`e363a4a171b8b78ebf58a6902795ea50daedab533df00f9de9eb0a33204ca827`
- emitted core SHA-256：`08539d07c8ebc5f2c5ef654cca40d3b8118fbbc8ee252be2eb2fbc71f655c4a0`
- emitted JSONL adapter SHA-256：`3a312cd2cf9e7aa75afa7b79438f33843d3fcb4b80d9914c444e5ac5611d76db`

原始日志时间为 `2026-10-04T09:37:19Z`。两个脚本都在 `E/scheduler-r5-recovery-design/diagnostic/fixtures/` 下创建 `mkdtemp` root，并在 `finally` 中删除该 root；复跑后的目录保持为空。诊断只关闭本轮创建的 fixture root，不清理其他临时目录或共享资源。

## 3. Owner 与 capability 事实

唯一 owner：

| 责任 | owner 文件 |
| --- | --- |
| 调度、busy admission、claim、execute/settle 编排 | `packages/runtime/src/subscriptions/index.ts`、`packages/runtime/src/explicit-brain/scheduler-patrol.ts` |
| core claim/fence/terminal identity 校验 | `packages/core/src/subscription.ts` |
| Journal 真源与事务 | `packages/adapters/jsonl/src/index.ts` |
| serve-task 公开执行、验证、settlement receipt | 未来 adapter 的候选组装 owner 为 `packages/app/src/ui-runtime/service.ts`、`packages/runtime/src/ui-runtime/coordinator.ts`；验证契约 owner 为 W3 保留树的 `packages/runtime/src/ui-runtime/task-verification.ts`。当前 candidate 不存在该 W3 文件，也没有 `ServeTaskConsumerPort` 实现 |
| W3 已验收 app 组装 owner（只读复用） | `packages/app/src/serve-runtime.ts`、`packages/app/src/serve-orchestration.ts`、`packages/app/src/tool-execution-gateway.ts`；当前均未实现 `ServeTaskConsumerPort`，只可作为真实 consumer 适配的既有边界 |

W3 保留树 `/Volumes/Intel/playground/humanagent/interaction-verification-producer-20261003` 的 HEAD 为 `3a3dbcd5a35dbde4f8928305238f874fcf7cf1cf`。实际事实：

- `packages/app/src/tool-execution-gateway.ts` 组装真实 operation gateway；`packages/app/src/provider-tool-execution.ts` 有 `FileOperationJournal`，只追加 `OperationEvent` JSONL。
- `packages/app/src/serve-runtime.ts` 与 `packages/app/src/serve-orchestration.ts` 是 W3 app 层已验收的 M3/orchestration/Provider assembly owner；`packages/runtime/src/ui-runtime/task-verification.ts` 只存在于 W3 保留树，负责产出 `TaskVerificationResult`，不产出 `ServeTaskTerminalReceipt` 本身。当前 candidate 缺少该文件，实际 W3 bytes 必须先按依赖顺序集成后才能测试。
- `packages/runtime/src/gateway/gateway.ts` 的 operation 状态、幂等记录和执行 single-flight 只在内存 `Map` 内，未从 `operation-journal.jsonl` 重放。
- 文本搜索未发现实际 `ServeTaskConsumerPort` 实现。没有 symbol 不算证明不存在兼容边界，但当前没有可演示的 consumer 重放保证。
- `RuntimeTaskCoordinator.replayJournal()` 可从 `UiRuntimeJournal` 的 `operation.started`/`operation.event` 恢复 operation identity/event projection。源码明确说明该 replay 只恢复 disposable projection facts；随后把任务置为 `unknown`/`需要恢复确认`，由 `hydrate()` 从权威 checkpoint journal 重新确认生命周期。因此它可用于关联和诊断，不能单独作为 durable dispatch/lifecycle truth。
- `ProviderAgentDriver.resume` 当前直接抛出 `resume.unsupported`。

因此执行幂等恢复能力存在真实前置缺口。设计不得声称 stub 已闭合 W2。

## 4. 设计目标与非目标

目标：

- 为 busy reminder 增加唯一 runtime admission/recovery 路径，使 `reminder-pending -> due` 可原子恢复并收拢 reminder。
- 为 occurrence 执行定义 durable execute-or-resume 契约，按 `OccurrenceTaskBinding` 恢复同一执行，不重复业务派发。
- 保持现有 SESE graph、唯一 owner、Journal 真源和 typed receipt 权威。

非目标：

- 不实现产品 source、tests、scripts 或 package 变更。
- 不新建第二 scheduler、generic execution registry、duplicate terminal truth、业务 metadata/log-derived control state。
- 不把诊断 counter 当作 real consumer 证据。
- 不启动 source review、R6、merge、push、install、restart、browser/auth/network 变更。

## 5. Busy reminder 恢复设计

### 5.1 状态与入口

现有公开入口保持为 `SubscriptionControlPort.schedule(input: ScheduledOccurrenceInput)`。`input.busy` 保留为本次调度的忙闲判定；不新增 browser timer、不新增独立 claim 入口、不重建 slot。

状态真源沿用现有 `Occurrence.state` 和 `Reminder.state`：

```text
OccurrenceState: due | skipped-busy | reminder-pending | claimed | consumed | invalidated
ReminderState:   pending | consumed | invalidated
```

### 5.2 `schedule({busy:true})`

- 当策略 `busyPolicy=idle-reminder` 且 late 未触发 skip 时，在同一个 Journal 事务内写入：
  - `occurrence.state = reminder-pending`
  - `reminder.state = pending`
- 若同 slot 已存在 `reminder-pending`，只返回现有 occurrence，不重复创建 reminder，不静默覆盖其他字段。
- `latePolicy=skip` 的过期 slot 保持为 `skipped-busy`，不进入 reminder。
- 若 slot 已 `due`、`claimed`、`consumed`、`invalidated`，返回现有状态或 typed 错误，不改写。

### 5.3 `schedule({busy:false})` 的空闲恢复

这是新增的唯一 recovery 路径，放在 `schedule` 的 existing 分支之前，仍处于同一个 JSONL 事务。

前置条件全部满足才恢复：

- 输入 occurrence 与已提交 slot 完全匹配：`subscriptionId`、`scheduleRevision`、`occurrenceOrdinal`、`dueAt`。
- `snapshot.subscription.state = active`。
- 现有 `occurrence.state = reminder-pending`。
- 存在匹配 `reminder`：`reminder.subscriptionId`、`scheduleRevision`、`occurrenceOrdinal`、`dueAt` 一致且 `reminder.state = pending`。
- `occurrenceOrdinal` 仍在 `currentOccurrenceOrdinal` 之后且不超过 `maxOccurrences`；非 once 时 `dueAt < endAt`。
- 现有 `latePolicy` 允许该槽位继续执行：尚未过期，或 `latePolicy=run-once`。`latePolicy=skip` 且 `nowAt > dueAt` 时不恢复为 `due`，进入 5.4 的原子收口。

恢复在同一事务内原子更新：

```text
occurrence.state: reminder-pending -> due
reminder.state:   pending           -> consumed
```

保留原 slot 身份：`occurrenceId`、`subscriptionId`、`scheduleRevision`、`occurrenceOrdinal`、`dueAt` 不变。不得重建 occurrence、不得直接调用 claim 绕过 pending、不得由 future timer 或 UI 直接改写。

恢复后公开行为：

- `schedule({busy:false})` 返回 `due`。
- `claim` 走现有 core `assertOccurrenceClaimable`，正常认领。
- 认领、执行、settle 后 occurrence 变为 `consumed`。

### 5.4 忙时重试、late、revision、cancel 与 limits

| 场景 | 行为 |
| --- | --- |
| `schedule({busy:true})` 遇到已有 `reminder-pending` | 返回现有，不增加第二个 reminder |
| `schedule({busy:true})` 遇到已有 `due` | 返回现有 `due`，不改成 reminder |
| 空闲恢复时 `latePolicy=skip` 已禁止本次执行 | 不恢复为 `due`；同一事务把 occurrence 标 `skipped-busy`、匹配 reminder 标 `invalidated`，返回该 closed occurrence；不得保留 pending |
| control `modify`/`pause`/`cancel-future` 已使旧 revision 失效 | `schedule` 返回 `stale-revision`/`superseded`；已失效 occurrence/reminder 不恢复 |
| subscription 非 active | 返回 typed `invalid-state`，不恢复 |
| `maxOccurrences`/`endAt` 禁止执行 | 不恢复为 `due`；`maxOccurrences` 已达上限时按下方同一原子收口，`endAt` 仍按 committed slot 的 `dueAt < endAt` 判断，不新增第二条恢复路径 |

永久 late-skip 的原子收口（owner：`packages/runtime/src/subscriptions/index.ts`，事务：`JsonlOrganJournal.transaction`）：

- 同一事务原子更新 `occurrence.state: reminder-pending -> skipped-busy` 与匹配 `reminder.state: pending -> invalidated`。
- 复用现有 `skipped-busy` accounting：`currentOccurrenceOrdinal = max(currentOccurrenceOrdinal, occurrenceOrdinal)`；若 `maxOccurrences` 已定义且 `currentOccurrenceOrdinal >= maxOccurrences`，`subscription.state = exhausted`；否则保持原 active 状态。
- 保留原 slot 身份：`occurrenceId`、`subscriptionId`、`scheduleRevision`、`occurrenceOrdinal`、`dueAt` 不变；不创建 `due`、不 claim、不执行、不新增第二套 ordinal counter。
- `endAt` 不是 `nowAt` 的截止条件。它继续按 committed policy 的 `dueAt < endAt` 判断；若 slot 不属于 committed policy，既有 `policySlotOrdinal`/core `exhausted`/`invalid-occurrence` 路径拥有拒绝，不伪造 pending closure。
- 后续同 slot `schedule` 返回同一 `skipped-busy` occurrence；restart 从同一 Journal 恢复 closed 状态；不会恢复 pending 或触发 dispatch。

`commit_subscription_control` 必须同步失效匹配 pending reminder。core `supersedeUnclaimed` 已把 `due`/`reminder-pending` occurrence 标记 `invalidated`；source 修复时同一事务也把匹配 `reminder.state` 改为 `invalidated`。

### 5.5 重启闭环

`pending -> restart -> idle -> claim -> reminder closure`：

1. `schedule({busy:true})` 写入 `reminder-pending` + `pending`。
2. 进程重启；`SubscriptionControlPort` 从同一个 `JsonlOrganJournal` 恢复快照。
3. 同一 slot 调用 `schedule({busy:false})` 触发恢复，occurrence 变 `due`，reminder 变 `consumed`。
4. `claim` 成功。
5. 最终 settle 后 occurrence 变 `consumed`；若后续发生 cancel/supersede，reminder 和未恢复 occurrence 一起 `invalidated`。

## 6. Execution-before-settlement 恢复设计

### 6.1 当前缺口

`consumeExecution` 在 `settlement` 存在时重放 terminal，否则直接调 `ServeTaskConsumerPort.executeOccurrence`。接口没有声明 durable idempotent/recovery guarantee。进程内标志不跨 restart；`FileOperationJournal` 只追加事件，gateway 不重放。真实 `ServeTaskConsumerPort` 缺失。

### 6.2 契约

`ServeTaskConsumerPort` 必须表达 execute-or-resume 语义：

```text
OccurrenceExecutionRequest = OccurrenceTaskBinding + policy + claim
OccurrenceTaskBinding = { occurrenceId, subscriptionId, scheduleRevision,
                           occurrenceOrdinal, taskId, operationId,
                           executionEpoch, inputArtifactDigest }
```

`OccurrenceTaskBinding` 已存在于 `packages/contracts/src/tool-execution.ts` 并有 `validateOccurrenceTaskBinding`。`ServeTaskTerminalReceipt` 已存在并有身份校验。

contract promise：

- 同一 `OccurrenceTaskBinding` 只对应一次业务执行。
- 重复调用、并发调用、execute 返回后 settle 前重启，都必须返回或恢复同一 execution 的 `ServeTaskTerminalReceipt`，不得启动第二次 Provider/serve dispatch。
- terminal receipt 身份必须等于 binding：`taskId`、`operationId`、`executionEpoch`、`inputArtifactDigest`。
- verification 与 settlement 是权威 receipt；scheduler 不建立第二 terminal truth。

### 6.3 真实 durable 机制与前置

现有能力必须按以下边界复用：

- `UiRuntimeJournal` / `RuntimeTaskJournalPort`（`packages/app/src/ui-runtime/journal.ts`）保存 operation identity 和 event projection。`RuntimeTaskCoordinator.replayJournal()` 只恢复可丢弃的 projection facts；它随后把任务置为 `unknown`/`需要恢复确认`，并由 `hydrate()` 从权威 checkpoint journal 重新确认生命周期。该 journal 因此是 correlation/projection evidence，不是 durable execution/dispatch truth。
- `FileOperationJournal`（W3 `packages/app/src/provider-tool-execution.ts`）只向 `operation-journal.jsonl` 追加 `OperationEvent`。`ToolExecutionGateway` 的 operation state、idempotency 和 execution single-flight 都在内存 `Map` 中，当前不重放该文件，所以不能单独证明重启后的 terminal 或 execute-or-resume。
- `FileCheckpointStore`（`packages/app/src/ui-runtime/journal.ts`）包 `JsonlOrganJournal`，是 checkpoint 的权威持久化 owner。`hydrate()` 可以恢复已提交的 terminal checkpoint，但仅凭它不能恢复 `execute` 已返回、`settle` 尚未提交的 in-flight execution。
- W3 保留树的 `packages/runtime/src/ui-runtime/task-verification.ts` 能产出 `TaskVerificationResult`，并在内存中 single-flight 每个 check。它不是 durable execution owner，也不产出 `ServeTaskTerminalReceipt`。当前 candidate 缺少该文件；实际 W3 bytes 必须先集成，不能假设它已在本 candidate 中。
- W1/W3 的 `TaskVerificationResult` 和 `ServeTaskTerminalReceipt` 是 verification/settlement 权威。当前没有任何公开 adapter 把结果组合成 `ServeTaskTerminalReceipt`，并按 `OccurrenceTaskBinding` 恢复同一执行。
- `ProviderAgentDriver.resume` 和 RCC v3 transport resume 当前显式返回 `resume.unsupported`；不能把它们当作 durable execution recovery。

文本搜索未发现实际 `ServeTaskConsumerPort` 实现。没有 symbol 不等于不存在兼容边界，但当前没有可演示的 durable consumer 重放保证。真实 consumer 实现前，能力标为 `BLOCKED`。不得以 contract promise、内存标志或 diagnostic counter 代替真实 consumer 证据。

### 6.4 Scheduler 行为

`consumeExecution` 的最小行为：

1. 读取 claim 并校验 lease/generation，与当前实现一致。
2. 若 settlement 已存在，返回同一 `ServeTaskTerminalReceipt`，不调 consumer。
3. 若 settlement 不存在，把 `OccurrenceTaskBinding` 作为 stable typed input 调 `serveTask.executeOccurrence`。
4. consumer 内部负责 execute-or-resume：若没有执行，启动唯一执行；若已有执行，恢复或等待同一 terminal。
5. consumer 返回 terminal 后，scheduler 用现有 core `assertVerifiedTerminalReceipt` 校验身份。
6. `settleOccurrence` 原子提交 occurrence settlement；terminal checkpoint/settlement receipt 仍是权威。

不新增 scheduler 端 execution registry、不新增进程内 flag 作为恢复真源、不把执行回执写进业务 payload/metadata 后再重建。

### 6.5 终点覆盖

`ServeTaskTerminalReceipt.verification.status` 覆盖 `success | failed | rejected | missing | blocked | cancelled`。设计要求 settle 和 projection 必须覆盖这些终点：

- `success`：只能由成功验证 + settlement receipt 投影成功。
- `failed`/`rejected`/`missing`：非成功 occurrence outcome，保留原始 evidence 和 recovery responsibility。
- `blocked`：attention/waiting 明确，不伪装成功。
- `cancelled`：只有 stop settlement 完成后才收口。
- `cleanup`：consumer 释放 execution/tool/browser/port 等自有资源，scheduler 保留 receipt；未 release 必须显式 recovery inventory。

当前 `assertVerifiedTerminalReceipt` 只接受 `verification.status=success`，后续 source 修复需按上述终点扩展 settle 判定，不扩大为接受伪造成功。

## 7. Graph 修正

本轮只改现有 `scheduled-occurrence` 和 `subscription-control` 两套 docs/dagpipe 文件。

- `humanagent-subscription-control`：`commit_subscription_control` 语义补为原子提交状态、失效槽位与匹配 reminder；控制契约补 reminder invalidation 规则。
- `humanagent-scheduled-occurrence`：
  - 新增 `recover_pending_reminder` 节点，位于 `read_committed_subscription_state` 和 `claim_due_occurrence` 之间。
  - `execute_occurrence_task` 语义改为按 `OccurrenceTaskBinding` 启动或恢复唯一 serve-task 执行，并返回验证终态。
  - meta 补 `recoveryContract`，记录 busy reminder 原子恢复、execution execute-or-resume、settlement/verification 权威和 restart replay。

图仍为 SESE：单 source、单 sink、每节点单入单出。新节点 binding 指向现有 `packages/runtime/src/subscriptions/index.ts`，`implementationStatus=pending`，不声称实现完成。

## 8. 最小 future source allowlist 与依赖顺序

后续 source 实现允许路径（parent 独立 review 通过后再派发）：

前置：当前 scheduler candidate 不包含 W3 的 `packages/runtime/src/ui-runtime/task-verification.ts`，也没有真实 `ServeTaskConsumerPort`。若执行恢复必须复用 W3 已验收字节，parent 必须先确定并完成 W3 → candidate 的最小组合；不得在 scheduler 侧新增 stub、generic execution registry 或第二 terminal truth 来跳过该前置。

| 顺序 | 文件 | 内容 |
| --- | --- | --- |
| 1 | `packages/runtime/src/subscriptions/index.ts` | `schedule` 内空闲 reminder 恢复；`consumeExecution` 调用 execute-or-resume consumer；错误码/状态处理 |
| 2 | `packages/core/src/subscription.ts` | 如需扩展 settle 终点判定和 reminder invalidation 辅助，保持 core 唯一 owner |
| 3 | W3 retained bytes for `packages/runtime/src/ui-runtime/task-verification.ts` | 先组合实际 W3 验证 bridge；当前 candidate 缺少该文件，不能以 stub 代替 |
| 4 | `packages/app/src/ui-runtime/service.ts`、`packages/runtime/src/ui-runtime/coordinator.ts`（以及 `serve-runtime.ts`/`serve-orchestration.ts` 既存 app seam，具体归属由 parent 在独立 pre-code review 中锁定） | 实现真实 `ServeTaskConsumerPort` adapter；用现有 operation identity、checkpoint 和验证 receipt 恢复/等待同一执行 |
| 5 | `packages/app/src/ui-runtime/journal.ts` | 仅在现有 journal 记录类型不足时补最小 record kind；避免 generic registry |

依赖顺序：

```text
W3 actual verification/consumer bytes composition (if required) -> scheduler recovery runtime -> core settle endpoint contract -> real ServeTaskConsumerPort adapter -> public tests
```

真实 consumer 不实现前，`due -> execute -> settle` 不能验收；fake counter 不能作为 GREEN。

## 9. 公开 test 合同

### 9.1 Busy reminder GREEN

真实入口：公开 `SubscriptionControlPort.schedule/claim/settleOccurrence` + 真实 `JsonlOrganJournal`。

断言：

1. `schedule({busy:true})` 返回 `reminder-pending`，journal 有 `reminder=pending`。
2. 重启 `SubscriptionControlPort`。
3. `schedule({busy:false})` 返回 `due`，journal 有 `reminder=consumed`。
4. `claim` 成功；`consumeExecution` 只调 consumer 一次；`settleOccurrence` 提交后 occurrence 为 `consumed`。
5. `schedule({busy:true})` 重复调用不增加 reminder。
6. `latePolicy=skip`、`maxOccurrences`/`endAt` 禁止、superseded/cancelled 场景不恢复为 `due`，不留下 pending 死边。

#### 9.1.1 `latePolicy=skip` busy-pending closure

独立 planned GREEN case：recurring policy 使用 `busyPolicy=idle-reminder`、`latePolicy=skip`、`maxOccurrences=2`、60 分钟 interval。

1. 在 slot 1 `dueAt` 调用 `schedule({busy:true})`；断言返回 `reminder-pending`，matching reminder 为 `pending`，`currentOccurrenceOrdinal=0`。
2. 在 `dueAt+1m` 对同一 slot 调用 `schedule({busy:false})`；断言返回 `skipped-busy`，`occurrenceId`/`subscriptionId`/`scheduleRevision`/`occurrenceOrdinal`/`dueAt` 与 admission 时一致，matching reminder 为 `invalidated`，`currentOccurrenceOrdinal=1`，且没有 `due` occurrence、claim 或 consumer dispatch。
3. 重复同一 slot 的 `schedule` 调用；断言返回同一 `skipped-busy` occurrence，不新增 occurrence/reminder，ordinal 仍为 1，dispatch 仍为 0。
4. 从同一 `JsonlOrganJournal` 构造新的公开 `SubscriptionControlPort` 后重复同一 slot 调用；断言重启后仍为同一 closed occurrence，journal 中无 pending reminder，ordinal 与 exhausted 状态不变。
5. 断言 closed slot 不能被 claim 或 `consumeExecution`，consumer dispatch 仍为 0；下一个 slot 的 ordinal 为 2，而不是重试 ordinal 1。
6. 在 `maxOccurrences=2` 下对 slot 2 执行同样的 late-skip closure 后，断言 subscription 为 `exhausted`，后续 slot 被 typed `exhausted` 拒绝且无 pending dead edge；另以 `maxOccurrences=1` 覆盖首个 closure 即 exhausted。
7. 保留 active/busy/revision/cancel 路径：未过期或 `latePolicy=run-once` 的 idle recovery 仍恢复为 `due`、claim 一次并 settle 为 `consumed`；重复 busy schedule 仍只保留一个 reminder；`modify`/`pause`/`cancel-future` 仍按既有 revision/control precedence 使旧 pending 不可恢复。

命令示例：

```sh
pnpm exec tsc -p tests/runtime/subscriptions/tsconfig.json
node --test dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js
```

harness fixture 根必须放在 `E/scheduler-r5-recovery-design/diagnostic/fixtures/`，测试后只删除本轮创建的 `humanagent-subscriptions-*`/`busy-reminder-*` 等 fixture root。

### 9.2 Execution recovery GREEN

真实入口：真实 `ServeTaskConsumerPort`（必须先由 W3 组合提供）+ 公开 `SubscriptionControlPort.claim/consumeExecution/settleOccurrence` + 真实 `JsonlOrganJournal`。

断言：

1. 同一 occurrence/task/operation/executionEpoch/inputArtifactDigest 只启动一次业务执行。
2. execute 返回后、settle 前重复调用同一 port，不第二次派发。
3. execute 返回后、settle 前重启 port，不第二次派发。
4. 并发调用返回/等待同一 terminal receipt。
5. settle 前返回的 terminal 与 settle 后重放 terminal 身份一致。
6. `success`、`failed`、`rejected`、`missing`、`blocked`、`cancelled` 和 cleanup 终点均有可断言 receipt。
7. fake/diagnostic counter 只能证明 RED；真实 business/provider consumer 证据单独验收。

命令示例（W3 完成后）：

```sh
pnpm exec tsc -p tests/app/tsconfig.json
node --test dist/tests/tests/app/ui-runtime.test.js dist/tests/tests/app/subscription-api.test.js
```

## 10. 本轮验证记录

本轮只允许 docs/graph 变化。执行后将记录：

```text
dagpipe graph validate docs/dagpipe/subscription-control.graph.json
dagpipe graph validate docs/dagpipe/scheduled-occurrence.graph.json
pnpm dagpipe:validate
git diff --check
git status --short
git diff --name-only HEAD
git diff --stat
```

验证要求：

- 仅允许 `docs/ui/scheduler-recovery-design-2026-10-04.md`、`docs/ui/interaction-redesign-plan-2026-10-03.md` 和两个 graph 各自的 `.graph.json`/`.graph.semantic.json`/`.graph.binding.json` 变化。
- `packages/`、`tests/`、`scripts/`、package/lock/config/version 相对 candidate `9260f27a` 不变。
- 原 compiled case 292 `UNCONFIRMED` 保留不覆盖。
- 空 pre-existing directory overreach 判定保留不回收。

## 11. 未完成与 blocker

- F01-F10、formal API/UI、三条 business E2E、installed 10086 LAN+Tailscale、main remote、goal cleanup 均未完成。
- Source R5 达到五轮上限；本轮不启动 R6/source review。
- 真实 durable `ServeTaskConsumerPort` 是 `BLOCKED` 前置。最小解除方式是派发 W3 real consumer 实现，依赖 projection/correlation identity、权威 checkpoint、verification 合成 `ServeTaskTerminalReceipt`；不得把 `RuntimeTaskJournalPort` replay 当作 durable lifecycle truth。
- 本设计不是 source review，也不替代 parent 独立 review。
