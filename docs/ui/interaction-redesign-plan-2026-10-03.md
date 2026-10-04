# HumanAgent 交互重设计候选（2026-10-03）

状态：**DESIGN-CANDIDATE**。这是 docs/graph 设计产物，不是实现或验收通过；parent 独立设计 review 通过前不得据此派发编码或宣称能力可用。

本稿已把 review 反馈 1–7 落进真实字段、owner、公开 API、图和派单合同；不再输出另一层计划。产品代码、测试、脚本、配置未改。

R5 恢复补充：2026-10-04 的独立 review 已终止为 `code_failure`，并确认两个 P1 缺口。当前调度 source candidate `9260f27a91e91a1cc115f2f7f9521fea96a91a52` 不获准进入组合。具体 RED 证据、唯一 owner、恢复状态机和 future source/test 合同见 [`scheduler-recovery-design-2026-10-04.md`](scheduler-recovery-design-2026-10-04.md)。该补充仍只改 docs/graph，不代表实现完成。

候选身份：

- worktree：`/Volumes/Intel/playground/humanagent/interaction-redesign-design-20261003`
- branch：`codex/interaction-redesign-design-20261003`
- base/HEAD：`0020ab4f4442ea59bf4b9fc02416a8a77c6c68ed`
- 本文件：`docs/ui/interaction-redesign-plan-2026-10-03.md`
- 审计原件已原样保全：`docs/ui/interaction-audit-2026-10-02.md`，与主树 SHA-256 一致。

## 1. 范围与边界

本候选覆盖：真实草稿进展/turn、统一状态栏+对话/轨迹、完整工具/history/可读输出、revision/edit/reject/最新确认幂等、单次/定时/周期真实调度、状态同步/停止收拢/allowedActions、drawer focus/reduced motion，以及由此影响的现有项目 DAG 修正。

不改产品代码、测试、脚本、配置、lock、DSH/RCC、共享主树或他人资源；不安装/重启/commit/merge/push。MCPX registry 不可用，本轮只记录 project CLI 证据。

## 2. Owner、共享 contract 先行与对象流

**共享 contract 先于实现**：W1 只改 `packages/contracts/src/explicit-brain.ts`、`framework.ts`、`index.ts`、`tool-execution.ts`，先把输入、调度、执行、工具投影、typed control 和 serve-task 终态 receipt 的共享导出定稿；W1b 再以 W1 为前置实现 draft-domain/intake；W2 的调度 core export 只能在 W1b 完成后串行交接。调度与 serve 必须复用 `tool-execution.ts` 的 operation result/cancel 身份，调度执行只消费 `humanagent-serve-task@2` 的验证后 terminal/settlement receipt，不另造第二套执行或验证。

唯一 owner 边界（AGENTS 不变，本稿只落实实现拆分）：

| 责任 | owner | 现有/public 文件 |
| --- | --- | --- |
| 领域状态、生命周期、错误策略、fencing、checkpoint 不变量 | `packages/core` | 现有 `packages/core/src/lifecycle.ts`、`epoch.ts`、`checkpoint.ts`；W1b 新增 `packages/core/src/draft-revision.ts`，W2 在 W1b 交接后新增 `packages/core/src/subscription.ts`，两者都从 `packages/core/src/index.ts` 暴露 |
| 草稿会话编排、显式整理、隐式准入、订阅控制编排、调度巡逻、UI runtime 编排 | `packages/runtime` | `packages/runtime/src/intake/explicit-intake.ts`、`explicit-brain/router.ts`、`explicit-brain/scheduler-patrol.ts`、W2 新增 `subscriptions/`、`admission/implicit-admission.ts`、`ui-runtime/coordinator.ts` |
| 权威追加式持久化 | `packages/adapters/jsonl` | `packages/adapters/jsonl/src/index.ts`（`JsonlOrganJournal` / `append` / `transaction`） |
| HTTP/SSE/tool 报告公开入口与组装 | `packages/app` | `packages/app/src/ui-runtime/service.ts`、`server.ts`、`provider-tool-execution.ts` |
| 投影/渲染产品壳 | `packages/ui` + `docs/ui` | `packages/ui/projection/runtime.ts`、`packages/ui/contracts/runtime.ts`、`docs/ui/observation.js` |

`packages/app`/`packages/ui` 只做组装/投影，不拥有领域 lifecycle 或调度真源；`packages/runtime` 不拥有权威 journal。W1 共享 contract 是共同前置；W1b 消费 W1，新增 core draft invariant，并在 `explicit-intake.ts`、`router.ts` 调用 core 与既有 journal port；W2 的调度 core export 从 W1b 串行接管。W3 projection 可先开发，但调度公开 API、task verification 和持久化重启收拢依赖 W1b/W2；W4 依赖 W1/W3。网络 worker 先独占 `server.ts` 与 `runtime-api.js`，交接后分别交给 W3/W4，任何时刻不得两个活 writer 同写。

五条独立对象流分别建/校正 SESE Graph：

1. `humanagent-explicit-requirement@2`：新任务从用户输入到可审阅草稿、修订、单次最终提交、执行策略编译/持久化。
2. `humanagent-subscription-control@1`：公开订阅控制请求从 typed intent、JSONL 事务临界区、core 领域裁决、原子提交到 durable control receipt。
3. `humanagent-scheduled-occurrence@1`：周期任务单个到期 occurrence 从已提交订阅状态读取、原子认领、准入、执行、收拢到结果投影。
4. `humanagent-serve-task@2`：已授权执行计划从恢复/认领、准入、真实轮次执行、停止/收拢、检查点提交到任务终态与恢复责任。
5. `humanagent-observation-read@2`：浏览器只读请求从真实任务状态、完整历史、工具生命周期关联、人类对话/轨迹投影、状态新鲜度与合法动作到渲染。

轮次、修订循环和周期 recurrence 都发生在唯一 owner 节点内部；跨对象流不回边，每次调度触发启动独立 execution/attempt identity。

## 3. 字段级共享契约

以下字段是 B1/B2/C 实现和 UI 投影必须遵守的公共契约。缺失或迁移字段不得用 summary/display 顺序/eventId/locator 重建。

### 3.1 草稿、preview 与最终提交

| 对象 | 字段 | 唯一 owner | 禁止 |
| --- | --- | --- | --- |
| Interaction | `interactionId`、`inputRevision`、`sourceRef`、`channelId`、`rawInputRef`、`occurredAt`、`idempotencyKey`、`requestKind` | explicit intake | 把 interactionId 作为 UI 面向用户的唯一标题 |
| Preview receipt | `previewId`、`interactionId`、`draftId`、`revisionVersion`、`revisionHash`、`createdAt`、`authorized: false` | explicit intake | preview 带授权、自动 confirm、直接写需求队列 |
| Draft revision | `draftId`、`revisionVersion`、`inputRevision`、`goal`、`scope`、`constraints`、`deliverables`、`normalizedInput`、`proposedIntent`、`proposal`、`matchedTasks`、`knownFacts`、`executionControlRef`、`decisionRefs`、`supersededBy`、`staleReason`、`state`、`history`、`revisionHash`、`immutableOriginalRef`、`previousRevisionRef` | explicit intake + core 不变量 | 只改 `proposal` 而不同步 goal/scope/constraints/deliverables；用 rename 当目标修改；把 execution policy 塞进 RequirementEnvelope |
| Typed edit/refinement | `requestedRevisionHash`、`baseRevisionVersion`、`fields`、`instructionRef`、`idempotencyKey` | explicit intake | 无 base hash 的盲改；用任意自由文本静默覆盖结构化字段 |
| Confirm | `confirmationRef`、`confirmedBy`、`confirmedAt`、`payloadRef`、`draftId`、`draftRevisionVersion`、`draftRevisionHash`、`interactionId` | service + intake 同一提交责任 | 旧 revision、重复点击、auto-confirm 偷渡授权、只校验 inputRevision 不校验 draft revision/hash |
| Final submit | `authorized_requirement`、`requirementId`、`draftId`、`inputRevision`、`draftRevisionVersion`、`draftRevisionHash`、`confirmationRef`、`fifoSeq`、`payloadRef` | service | 未收拢 `closure receipt` 前宣称已提交/已停止 |
| Reject closure | `rejectionId`、`reason`、`closedAt`、`durable` | service + intake | 丢弃用户编辑、无回执、把 reject 当 dispatch |

`requestKind` 必须显式区分 `new-task-create`、`new-task-preview`、`existing-task-change`、`status-query`、`clarification`、`refinement`。

- `new-task-preview` 生成可编辑 preview，无授权、不提交、不写执行计划；`new-task-create` 的最终 Create-and-execute 确认才是新任务唯一授权点。
- 已有任务的目标/范围/方式变更使用 `existing-task-change`，必须单独确认并绑定精确 draft revision/hash。
- 旧 revision/hash、旧确认、重复提交返回 typed stale/duplicate receipt，保留原差异；放弃草稿走正式 reject/closure 回执。
- `completeStatusOnly` 只是当前实现的可观察分支，不是已证明根因。新任务 preview 必须携带 creation/preview context，通用 status-query 不得吞掉它；合法 status 查询继续走自己的入口。
- `executionControlRef` 只引用独立 typed execution policy；policy 不复制进 `RequirementEnvelope.payload` 或 `metadata`。

W1 先只定义并导出下列共享结构，不实现 runtime 行为：

```ts
interface DraftRevisionInput {
  draftId: string;
  baseRevisionVersion: number;
  requestedRevisionHash: string;
  fields: Record<string, unknown>;
  instructionRef: string;
  idempotencyKey: string;
}

interface DraftRevision {
  draftId: string;
  revisionVersion: number;
  inputRevision: number;
  goal: string;
  scope: string;
  constraints: readonly string[];
  deliverables: readonly string[];
  normalizedInput: string;
  revisionHash: string;
  immutableOriginalRef: string;
  previousRevisionRef?: string;
  executionControlRef?: string;
}

interface FinalSubmit {
  interactionId: string;
  draftId: string;
  inputRevision: number;
  draftRevisionVersion: number;
  draftRevisionHash: string;
  confirmationRef: string;
  idempotencyKey: string;
}

interface TaskVerificationResult {
  taskId: string;
  operationId: string;
  executionEpoch: number;
  inputArtifactDigest: string;
  status: "success" | "failed" | "rejected" | "missing" | "blocked" | "cancelled";
  rejectionCode?: "identity-mismatch" | "stale-epoch" | "checker-rejected";
  checkerStdout?: string;
  checkerExitCode?: number | null;
  evidenceRefs: readonly string[];
}

interface ServeTaskTerminalReceipt {
  taskId: string;
  operationId: string;
  executionEpoch: number;
  inputArtifactDigest: string;
  verification: TaskVerificationResult;
  terminalCheckpointRef: string;
  settlementReceiptRef: string;
  recoveryResponsibility?: string;
}
```

W1 在 `packages/contracts/src/tool-execution.ts` 导出 `TaskVerificationResult` 与 `ServeTaskTerminalReceipt`；W3 只能实现该公开 bridge，不得把调度证据直接提升为 task success。W1b 在 `packages/core/src/draft-revision.ts` 实现 revision/hash、supersede 和 exact-submit 不变量，并由 `packages/core/src/index.ts` 导出；`explicit-intake.ts` 负责 preview/edit/refine 会话状态，`router.ts` 负责 confirmation ledger、single submit 和 execution policy 编译。intake 调用 core 不变量与现有 journal port，不自行复制哈希、版本或确认规则。W4 UI 共享卡片只有在 W1 导出确定后才能消费这些字段。

### 3.2 执行策略与周期规则

| 字段 | 说明 | owner |
| --- | --- | --- |
| `policyId`、`policyRevision` | 执行计划稳定身份和版本 | contracts + runtime |
| `executionMode: once \| scheduled \| recurring` | 单次、定时、周期 | contracts/runtime |
| `timezone` | IANA 时区；`dueAt` 按该时区计算 | scheduler |
| `canonicalInstant` | 规范化 UTC/时区确定的发生时间 | scheduler |
| `frequency: interval \| daily \| weekly` | 用户普通周期最小完整合同 | scheduler |
| `intervalMinutes`、`timeOfDay`、`weekDays` | 周期字段；按频率必填并校验 | scheduler |
| `startAt`、`endAt`、`maxOccurrences` | 开始、结束、最大次数；终态后不再触发 | scheduler |
| `dstMode: wall \| absolute` | DST 确定性处理；`wall` 按本地钟点，`absolute` 按 UTC | scheduler |
| `dstMissedPolicy: shift-forward` | `wall` 缺失时间前移到 gap 后第一个合法 instant，journal 记录 `originalLocalAt`/`resolvedAt` | scheduler |
| `dstAmbiguousPolicy: earlier-offset` | `wall` 重复时间固定选较早 offset 的第一个 instant，journal 写两份候选供审计 | scheduler |
| `latePolicy: run-once \| skip` | 重启/失联后过期 occurrence 只决定是否补最近一次；不重复产生同一 occurrence | scheduler + jsonl |
| `busyPolicy: skip \| idle-reminder` | 忙时跳过或等待提醒；不能静默补跑 | scheduler + admission |
| `Subscription.state` | 唯一真源用现有 `active \| completed \| exhausted \| cancelled \| suspended`；暂停即 `suspended`，不另存 paused boolean | contracts |
| `cancelFutureRef` | 取消未来触发，与在途 stop 分开 | scheduler + control |

`maxOccurrences` 按 `occurrenceOrdinal` 计；每个实际到期槽位（含 `skipped-busy`）消耗一次计数，`state=exhausted` 后不再触发。`maxOccurrences=0` 非法。

W1 的最小 typed control 结构如下；字段名是后续 W2/W3 验收的稳定契约。`SubscriptionControlRequest` 是按 `action` 区分的 union，`modify` 必须携带完整新策略，两个不同时间修改请求不能拥有相同 typed payload：

```ts
interface ExecutionPolicyBase {
  policyId: string;
  policyRevision: number;
  timezone: string;
  dstMode: 'wall' | 'absolute';
  dstMissedPolicy: 'shift-forward';
  dstAmbiguousPolicy: 'earlier-offset';
  latePolicy: 'run-once' | 'skip';
  busyPolicy: 'skip' | 'idle-reminder';
}

type ExecutionPolicyDefinition =
  | (ExecutionPolicyBase & {
      executionMode: 'once';
      dueAt: string;
    })
  | (ExecutionPolicyBase & {
      executionMode: 'scheduled';
      startAt: string;
      endAt?: string;
      maxOccurrences?: number;
    })
  | (ExecutionPolicyBase & {
      executionMode: 'recurring';
      startAt: string;
      endAt?: string;
      maxOccurrences?: number;
      frequency: 'interval' | 'daily' | 'weekly';
      intervalMinutes?: number;
      timeOfDay?: string;
      weekDays?: readonly number[];
    });

interface SubscriptionControlBase {
  subscriptionId: string;
  expectedPolicyRevision: number;
  expectedScheduleRevision?: number;
  idempotencyKey: string;
  requestedAt: string;
}

interface ModifySubscriptionControlRequest extends SubscriptionControlBase {
  action: 'modify';
  expectedScheduleRevision: number;
  newPolicy: ExecutionPolicyDefinition;
  newPolicyHash: string;
  confirmationRef: string;
}

interface PauseSubscriptionControlRequest extends SubscriptionControlBase {
  action: 'pause';
}

interface ResumeSubscriptionControlRequest extends SubscriptionControlBase {
  action: 'resume';
}

interface CancelFutureSubscriptionControlRequest extends SubscriptionControlBase {
  action: 'cancel-future';
}

type SubscriptionControlRequest =
  | ModifySubscriptionControlRequest
  | PauseSubscriptionControlRequest
  | ResumeSubscriptionControlRequest
  | CancelFutureSubscriptionControlRequest;

interface SubscriptionControlReceipt {
  subscriptionId: string;
  action: SubscriptionControlRequest['action'];
  status: 'applied' | 'duplicate' | 'stale' | 'conflict';
  policyRevision: number;
  scheduleRevision: number;
  idempotencyKey: string;
  requestHash: string;
  supersededUnclaimedOccurrences: readonly string[];
  controlRef: string;
}
```

解析与持久化责任固定：W1 导出上述类型与 canonical JSON 规则；W2 的 runtime typed port 解析/校验 union，计算 `newPolicyHash` 与 `requestHash`；core 只裁决状态、版本和合法转移；JSONL 的同一个 `transaction` 持久化 typed request、policy snapshot、状态与 receipt。`modify` 的 `newPolicyHash` 绑定用户确认的新策略版本/hash，`confirmationRef` 必须指向该确认；execution policy 不得混入业务 `RequirementEnvelope.payload` 或 `metadata`。

`core` 负责 `expectedPolicyRevision` / `expectedScheduleRevision` 的状态转换不变量、pause/cancel/resume 的合法状态，以及 resume 后槽位的确定性。JSONL 的同一个 `transaction` 必须原子比较 subscription 状态、两个 revision 和 claim 状态，再用 `idempotencyKey` + `requestHash` 返回已有 receipt 或 typed conflict，不能在事务外先写日志再补状态。独立控制图不等待 `due_occurrence`：没有任何到期槽位时，pause/resume/cancel-future 也必须在同一事务提交 durable receipt 后立即生效。

控制与 claim 的线性顺序固定如下：

1. 控制先提交：以旧 `scheduleRevision` 生成的尚未认领 occurrence 变为 `superseded`，不可再 claim，并写入 `supersededUnclaimedOccurrences`；此后 claim 返回 typed stale/conflict，不启动新执行。
2. claim 先提交：该 `executionEpoch` 保持原已授权 policy 快照与 `controlRef`；未来 pause/cancel-future 只阻止后续槽位，不偷偷 stop 在途执行；在途停止仍走 task-scoped stop/settlement。
3. 两个 `modify` 同 base：JSONL 原子比较只允许第一个成功，后续返回 typed `stale`/`conflict`，不得静默覆盖。
4. 重复 `idempotencyKey`：相同 `requestHash` 返回已有 receipt；不同内容返回 typed `conflict`，不得伪成功。
5. `resume` 从下一条合法槽位重新生成确定的 occurrence ordinal，不补回已 superseded 的槽位，不产生重复 due。
6. 修改 `scheduleRevision` 后，旧 unclaimed 槽位必须显式标记 `superseded`；已 claimed 的保持 immutable policy snapshot 和原 `controlRef`。
7. journal 重启 replay 后，已提交 subscription 状态、policy snapshot 和 receipt 必须可独立读取恢复。

W2 提供 runtime typed control port 与 JSONL 持久化；W3 独占 HTTP/SSE 组装并依赖 W2：

```text
GET /api/subscriptions
GET /api/subscriptions/:id
POST /api/subscriptions/:id                     modify (once/scheduled/recurring + schedule fields)
POST /api/subscriptions/:id/pause
POST /api/subscriptions/:id/resume
POST /api/subscriptions/:id/cancel-future
POST /api/occurrences/:occurrenceId/claim
POST /api/occurrences/:occurrenceId/result
POST /api/tasks/:taskId/stop
```

HTTP body 与新 control 图使用同一 discriminated union：`POST /api/subscriptions/:id` 的 body 必须是 `ModifySubscriptionControlRequest`，携带 `newPolicy`、`newPolicyHash`、`confirmationRef`、`expectedPolicyRevision`、`expectedScheduleRevision`、`idempotencyKey`；pause/resume/cancel-future 只允许最小 common 字段。W3 不得用不同 HTTP 字段另造修改语义。

Future-cancel 只写 `cancelFutureRef` 和 Journal，不隐式取消在途执行；在途停止必须通过 task-scoped stop/settlement receipt 闭环。

### 3.3 Occurrence、lease、fencing 与重启

| 对象 | 字段 | 语义 |
| --- | --- | --- |
| Occurrence | `occurrenceId`、`subscriptionId`、`scheduleRevision`、`occurrenceOrdinal`、`state`、`dueAt` | 幂等键：`subscriptionId::scheduleRevision::occurrenceOrdinal` |
| Claim | `claimedBy`、`leaseId`、`schedulerInstanceId`、`generation`、`acquiredAt`、`expiresAt` | 认领必须通过 JSONL 事务取得唯一 lease |
| Fencing | `generation`/`executionEpoch` | 旧 generation 不能提交；重启先恢复未收拢 operation 再恢复 trigger；replay 返回已有 receipt 不重复派发 |
| Busy | `skipped-busy` / `reminder-pending` | busyPolicy 决定本次消耗或积压一个 Reminder |
| Cancel | `cancelFuture` vs `stopInFlight` | 取消未来唤醒不隐式取消在途执行；在途停止走标准 stop/settle |

同一次 due 不重复执行；重启后的 replay 必须返回已有 receipt，不能重复派发。

失败、取消、blocked、cleanup 都必须通过 typed occurrence result / operation result / checkpoint receipt 流到同一 JSONL + projection sink，不能只在 `graph.meta` 里写一句。

### 3.4 Turn、工具、历史、状态与依赖

每个公开轨迹条目必须携带：

```text
turnId
requestId
parentRequestId?
seq
occurredAt (秒级，含精确时间)
kind: user | assistant | tool-call | tool-result | status | decision | failure | cancel
modelRef?
tool: { callId, toolId, argumentsRef?, status, outputRef?, outputDigest?, error?, startedAt?, durationMs? }
authorization: { scope, taskId, operationId, executionEpoch, requestedCapabilities, permissionRefs, toolOutputRef }
dependencyEdge: { source, target, ref?, reason? }
evidenceRefs[]
state
allowedActions[]
provider: { state, lastEventAt }
transport: { connected, lastSyncedAt, stale?, replayed?, cursor? }
settlement: { providerStopped, checkpointCommitted, stoppedAt?, resultRef? }
lastBusiness: { kind, at, ref }
history: { cursor?, hasMore, items[], filter?, replay? }
```

`callId` 是工具调用/结果关联唯一真源；`toolId` 是工具名；`outputRef/outputDigest` 是成功结果的可验证描述符。UI 不得从 `summary`、`eventId`、`operationId` 或最终回答重建调用 ID/query/result。最近事件只作摘要，正式轨迹必须分页读取真实历史。

stable history cursor/filter/replay：cursor 由 journal `seq` + operation/execution identity 组成；重连按 cursor 重放并去重，断线只能显示 `stale/disconnected`，不能伪装任务失败或继续宣称 live。`tool-output` 读取必须 task/operation/executionEpoch/seq scoped，并返回原始授权范围和原始错误/耗时；不能只按 task 范围非唯一 `callId` 查找。

真实 dependency edges 来自 runtime projection；UI 不得用显示顺序、行相邻关系或组件嵌套造边。brain/execution/review/memory/node 观测都只读同一 typed source；node drawer 只读，不消费需求、不修改队列、不重试 operation、不执行 steer。

卡片字段必须来自真实 producer：

- 阶段：`currentNode` / `input.received` / `provider.execute` / `provider.tool` / `checkpoint.commit` 等真实节点事实。
- 当前工作/等待对象/起点/turn 来源：`ownerId`、`nextStep`、`nextAction`、`waitingOn`、`startedAt`、`turnId`。
- provider/transport/settlement：`provider.state`、`transport.connected`、`providerStopped`、`checkpointCommitted`。
- last business/sync：`lastBusiness`、`lastSyncedAt`、`settlement`。

### 3.5 共享卡片与可访问性

每个显式大脑/执行/审核/记忆卡片共用：状态栏、对话、轨迹、底部操作、drawer focus/reduced motion。人类对话只展示用户消息、可公开助手输出、语义进展和决策；技术细节进轨迹/详情。缺少公开轮次数据时明确显示「未提供」，不能自造计数器或百分比。轨迹读历史不抢滚动；新更新用显式入口。

## 4. Graph 候选与终点

全部候选图已通过 `dagpipe graph validate`，并经 `pnpm dagpipe:validate` 验证当前全部图。图是设计候选，`capabilityStatus` 仍为 `pending`，不代表能力已实现。

### 4.1 explicit-requirement

入口：`user_task_input`；出口：`persisted_execution_plan`。

| 语义节点 | owner | 终点 |
| --- | --- | --- |
| 接收用户任务 | `packages/app/src/ui-runtime/service.ts` | 成功进入整理；失败保留原输入 |
| 显式整理需求 | `packages/runtime/src/intake/explicit-intake.ts` | 输出可整理意图 |
| 生成可读任务草稿 | 同上 | 输出 preview/revision；preview 无授权 |
| 审阅并修订任务草稿 | 同上（会话编排） | 输出最新 revision；旧确认显式拒绝 |
| 校验草稿 revision/hash 不变量 | `packages/core/src/draft-revision.ts`，由 `packages/core/src/index.ts` 导出 | 通过进入确认/提交；不通过返回 typed stale/refinement |
| 单次最终提交授权 | `packages/app/src/ui-runtime/service.ts` | 输出授权需求；重复提交幂等 |
| 编译执行策略 | `packages/runtime/src/explicit-brain/router.ts` | 输出单次/定时/周期策略 |
| 追加执行计划到权威 journal | `packages/adapters/jsonl/src/index.ts` | 出口 `persisted_execution_plan`；未持久化不得进入 serve |

### 4.2 subscription-control

入口：`SubscriptionControlRequest`；出口：`durable_control_receipt`。

这是独立于到期触发的 SESE 功能。公开请求先解析 typed intent，再通过 JSONL 事务资源进入临界区；core 在同一临界区裁决 pause/resume/cancel-future/modify 的状态、revision 和 occurrence supersede 规则；JSONL 原子提交订阅状态、typed policy snapshot、superseded occurrence 和唯一 control receipt。runtime 只做编排，不复制 core 规则，也不把控制命令塞进 `due_occurrence` 队列。无到期槽位时，pause/resume/cancel-future 仍能立即提交并返回 receipt；modify 必须绑定已确认的新 policy hash。新增图 `plannedOwnerPath` 指向尚不存在的 `packages/runtime/src/subscriptions/`、`packages/core/src/subscription.ts`，当前 capability `pending`，不声称已运行。

### 4.3 scheduled-occurrence

入口：`due_occurrence`；出口：`occurrence_result_projection`。

每个 occurrence 独立执行一次。图不再承担 `apply_subscription_control` 的修改职责；`claim_due_occurrence` 先读取已提交 subscription 状态，并在同一 JSONL 事务中用 `state` + `revision` 再次原子比较后再 claim。控制先提交则旧 unclaimed slot 不可 claim；claim 先提交则保留该 executionEpoch 的 immutable policy snapshot，后续 pause/cancel-future 不偷停执行。core 只校验 occurrence 状态、maxOccurrences/DST/late 规则；busy skip、reminder、lease、restart recovery 属于节点内部；未接通前能力保持 `pending`，不宣称准入 PASS。

`execute_occurrence_task` 不直接执行 provider/tool，也不把执行证据当成功；它必须通过 typed public input 调用 `humanagent-serve-task@2` 的唯一执行、`verify_task_result`、stop/settlement 路径，并只返回 `ServeTaskTerminalReceipt`。该 receipt 必须携带 `taskId`、`operationId`、`executionEpoch`、`inputArtifactDigest`、验证状态、终态 checkpoint、settlement receipt 和恢复责任；identity/fencing 由 core 校验，JSONL 原子提交 occurrence settle 与 receipt。`settle_occurrence` 只消费验证后的 terminal/settlement receipt：required checker 的 failed/missing/rejected、identity mismatch、stale executionEpoch 或 pending verification 均不得投影 occurrence 成功；取消必须先完成 stop settlement。这里复用 W3 的 task-verification bridge，不新增 scheduler verifier。

两张订阅图通过同一个 JSONL 事务资源线和 typed control receipt 数据边表达竞争：control 图的提交结果可被 claim 读取并重新比较，claim 的已提交 lease/policy snapshot 可被 control 识别为 in-flight；不造跨图循环、第二真源或 due timer 控制队列。scheduled-occurrence 与 serve-task 保持两个独立 SESE 图，只通过 `persisted_execution_plan` / `ServeTaskTerminalReceipt` 的 typed 输入输出调用边界连接，不跨节点回边或共享生命周期真源。

### 4.4 serve-task

入口：`persisted_execution_plan`；出口：`task_terminal_projection`。

recover/claim 后先做 core lifecycle/fencing 校验，再准入；执行真实轮次；`verify_task_result` 消费 task/operation/executionEpoch/immutable digest 与 checker 原始 stdout/exit/evidence 后，才进入 stop/settle 并提交 checkpoint；JSONL 追加 terminal checkpoint receipt；UI 只投影。成功、失败、取消、阻塞、清理各有明确 typed receipt：`missing` 与 `rejected` 均为非成功终态且必须清理/recovery；provider close 未闭合不能宣称已停止；原错误和恢复责任保留。

### 4.5 observation-read

入口：`browser_request`；出口：`rendered_view`。

读路径从真实任务状态/历史开始，经 `callId` 关联工具生命周期，再投影人类对话与轨迹、状态新鲜度与合法动作。实际 served 浏览器壳是 `docs/ui/observation.js`（server `serveStatic` 服务 `docs/ui/*`），binding 已改；不在图内用相邻显示顺序造业务依赖。

## 5. 验证消费与验收（checker 真结果）

必须 checker 的任务，只有在真实验证结果回来后才有对应成功/非成功 outcome；外部 runner 或 checker 失败时 Dashboard 不得仍显示成功，也不得用任意 test data 改终态。铁律：

- `execute_task_turns -> checker_result/verification -> settlement/checkpoint -> terminal projection`；只在该 task 自己的 checker stdout/exit code、evidence 和 immutable digest 回来后才写 `succeeded`/`failed`。
- task verification 必须成为真实节点：`execute_task_turns` 产出 `TaskExecutionEvidence` 后先进入 `verify_task_result`，再由 `stop_or_settle` 收拢。该节点消费 `taskId`、`operationId`、`executionEpoch`、immutable input artifact digest 与 `stdout` / `exitCode` / evidence；成功、失败、rejected、missing、blocked、cancelled 都必须形成 typed verification result 才可提交 checkpoint。`missing` 是非成功结果且必须进入清理/recovery，checker 失败时原 stdout/exit 原样保留，外部 runner 不能事后改已写 succeeded 的 task。
- scheduled/recurring occurrence 必须消费同一 `humanagent-serve-task@2` 公共流程的 `ServeTaskTerminalReceipt` 后才能 settle；调度不得直接读 provider/tool 证据判成功，也不得另建 verifier。required checker failed/missing/rejected、identity mismatch、stale executionEpoch 或验证未决时必须保持非成功且保留恢复责任；cancelled 只有在 stop settlement 完成后才能收口。
- 复用现有 `packages/runtime/src/gateway/ports.ts` 的 `OperationVerifierPort` / `OperationVerifierDecision` 于 operation 级验证；task-level checker 结果如果复用该决策，必须在 W3 的 runtime bridge 再包一层 `TaskVerificationResult` 并明确 task/operation/executionEpoch/digest 关联，不冒充已有 operation 能力。复用 `packages/runtime/src/review` 的 review result 和 `packages/runtime/src/orchestration/review-material.ts` 的 material validation；不新增通用治理 framework。
- 最小 producer/consumer 端口放在 `packages/runtime/src/gateway/ports.ts` + W3 新增的 `packages/runtime/src/ui-runtime/task-verification.ts`（具体 runtime verifier bridge），由 `packages/app/src/ui-runtime/index.ts` 组装进 coordinator；公开 consumer 走 `tests/app/ui-runtime.test.ts`、新增 `tests/app/subscription-api.test.ts`、以及 `tests/app/dashboard-e2e/scenarios/aitest.mjs` 的真实 checker 调用。控制策略来自 typed control，不从业务 payload、`metadata` 或日志推断。
- 订阅控制公开 consumer 必须覆盖：无任何到期槽位时 pause/resume/cancel-future 立即 durable 生效；claim 后取消未来不 stop 在途；两个不同 `newPolicy` 同 base 只允许一个 applied、另一个 typed stale/conflict；重复 idempotency 但不同内容不得伪成功而应 conflict，相同内容重放已有 receipt；控制先提交与 claim 先提交两种线性顺序；journal 重启 replay 后状态与 receipt 可恢复。core 决定语义，JSONL 事务原子比较并持久化，runtime 只编排。
- runner `cleanup=null` 是已确认的序列化/收口 bug；W5 必须修复为结构化 cleanup receipt，未 settle 分支也必须写 recovery inventory。
- 原三类命令严格保留：`pnpm e2e:dashboard:web-search`、`pnpm e2e:dashboard:local-file-search`、`pnpm e2e:dashboard:aitest`。
- AItest receipt 必须同时含 checker 原始 stdout/exit code 和人工语义/motion 证据（如两时间点 `getComputedStyle` 采样、结果截图）；只有 Dashboard 四张截图不算最终验收。
- baseline / `real-explicit-implicit-e2e.mjs` 不冒充三类 browser 最终验收。

## 6. GCM 派单合同

共享文件唯一 owner；实现与独立 review 分给不同 agent；每个 worker 从最新 `origin/main` 外置 clean worktree 执行，回传候选 SHA、changed files、测试数、真实入口/E2E、review PASS 与清理核对。

| 包 | allowed paths（互斥） | 交付 iff 与真实 public 路径 | focused 命令、成功/失败路径 | 独立 review 与 cleanup iff | 依赖 |
| --- | --- | --- | --- | --- | --- |
| W1 contracts-only shared exports | `packages/contracts/src/explicit-brain.ts`、`framework.ts`、`tool-execution.ts`、`index.ts`、`tests/contracts/contracts.test.ts` | 只定义/导出 draft revision、exact submit、action-discriminated typed subscription control、operation result 身份，以及 `TaskVerificationResult` / `ServeTaskTerminalReceipt`；不实现 core invariant 或 runtime；成功/失败 consumer 覆盖字段完备与非法输入 typed 拒绝 | `pnpm test:contracts`；consumer 断言 contract 字段、导出和负向 rejected 类型 | 不同 agent 独立 review contract/导出；PASS 后只移除本 worker worktree、dist/tmp 和日志 | 无 |
| W1b draft-domain/intake | `packages/core/src/draft-revision.ts`、`packages/core/src/index.ts`、`packages/runtime/src/intake/explicit-intake.ts`、`packages/runtime/src/explicit-brain/router.ts`、`tests/core/core.test.ts`、`tests/runtime/intake/intake.test.ts`、`tests/runtime/intake/tsconfig.json`、`tests/runtime/explicit-brain/explicit-brain.test.ts`、`tests/runtime/explicit-brain/tsconfig.json` | 新 core draft invariant + core export；W1b 消费 W1，并只调用 existing journal port；成功走 preview → edit/refine → exact revision submit → 真实 normalizedInput 与 persisted plan；失败走 stale hash、旧确认、重复提交、journal 未持久化 | `pnpm test:explicit-brain && pnpm exec tsc -p tests/runtime/intake/tsconfig.json && node --test dist/tests-runtime-intake/tests/runtime/intake/intake.test.js && pnpm exec tsc -p tests/core/tsconfig.json && node --test dist/tests/tests/core/core.test.js`；公开 consumer 不 mock core 或 journal 内部调用 | 不同 agent 独立 review invariant、journal 边界和公开 consumer；PASS 后只回收本 worker worktree、dist/tmp 和日志 | W1 |
| W2 scheduler runtime + JSONL | W1b 交接后的 `packages/core/src/index.ts`、新 `packages/core/src/subscription.ts`、`packages/runtime/src/explicit-brain/scheduler-patrol.ts`、新 `packages/runtime/src/subscriptions/`、`packages/adapters/jsonl/src/index.ts`、`docs/dagpipe/scheduled-occurrence.graph.binding.json`、新 `tests/runtime/subscriptions/tsconfig.json`、`tests/runtime/subscriptions/subscriptions.test.ts`、`tests/runtime/subscriptions/public-consumer.test.ts`、`tests/adapters/jsonl/journal.test.ts` | W2 先交付 domain/Journal/claim/control 骨架；`execute_occurrence_task` 只能调用 W3 提供的公开 `humanagent-serve-task@2` consumer port，并只接受验证后 terminal/settlement receipt，不得用 provider/tool 证据或调度私验器判定 occurrence 成功；最终 `due -> execute -> settle` 成功验收依赖 W3 task-verification bridge；失败覆盖重复 claim、stale generation、busy/late/DST、restart replay、control 与 claim 竞争、stale/conflict/duplicate modify；实现后将 scheduled-occurrence binding 同步到新真实 owner，并把 subscription-control 的真实 owner 证据交给 W3 | `pnpm exec tsc -p tests/runtime/subscriptions/tsconfig.json && node --test dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js && pnpm test:journal`；必须含无到期槽位 pause/resume/cancel、控制先提交、claim 先提交、两个 modify 同 base、重复 idempotency 同/异内容与重启 journal replay；执行成功用例在 W3 交接后走真实公开 consumer | 不同 agent 独立 review 状态/lease/fencing/控制线性顺序/重启收拢；PASS 并核对 JSONL 证据后，只移除本 worker worktree、构建产物、临时 journal 与自身进程 | W1b 完成骨架；W3 完成后做 execute/settle 终验收 |
| W3 projection/service/SSE + task verification | `packages/app/src/ui-runtime/service.ts`、`server.ts`（network 交接后）、`packages/app/src/provider-tool-execution.ts`、`packages/app/src/ui-runtime/index.ts`、`packages/runtime/src/gateway/ports.ts`、新 `packages/runtime/src/ui-runtime/task-verification.ts`、`packages/runtime/src/ui-runtime/coordinator.ts`、`packages/ui/projection/runtime.ts`、`packages/ui/contracts/runtime.ts`、`docs/dagpipe/subscription-control.graph.binding.json`、`docs/dagpipe/serve-task.graph.binding.json`、`tests/ui/runtime-projection.test.ts`、`tests/app/ui-runtime.test.ts`、新 `tests/app/subscription-api.test.ts`、`tests/adapters/provider/` | app 从 W2 typed port 组装订阅 HTTP/SSE；task verification 接在 `execute_task_turns` 与 `stop_or_settle` 之间，关联 task/operation/executionEpoch/immutable digest 与 stdout/exit/evidence；`gateway/ports.ts` 明确归 W3；实现 `task-verification.ts` 后同步 serve-task binding 到该真实文件；W2 交接后同步 subscription-control binding 到新真实 owner；public consumer 在 port 0 的 `server.ts` 调真实 HTTP/SSE；成功串起 scheduled/recurring checker/result/history/replay，失败证明 checker failed/missing/rejected/identity mismatch/stale epoch 非成功且保留恢复责任，不伪造 Dashboard success | `pnpm test:provider && pnpm test:ui && pnpm build:app && pnpm exec tsc -p tests/app/tsconfig.json && node --test dist/tests/tests/app/ui-runtime.test.js dist/tests/tests/app/subscription-api.test.js`；公开 consumer 覆盖 scheduled/recurring checker 成功、失败、缺结果、rejected、identity mismatch、stale epoch 与恢复责任，以及 HTTP `modify/pause/resume/cancel-future/stop` 竞争与非法 revision；不只跑单次任务 | 不同 agent 独立 review app 只组装、runtime 只编排、JSONL 仍唯一持久化、typed control 不回流业务 payload；PASS 并核对 HTTP/SSE 与 checker 证据后，关闭本 worker 的 port-0 server 与临时 root/worktree | W1、W1b、W2、network 交接；既有 `OperationVerifierDecision` 只覆盖 operation，不冒充 task verification |
| W4 UI product | 网络交接后的 `docs/ui/runtime-shell.js`、`runtime.css`、`runtime-api.js`；`docs/ui/observation.html`、`observation.js`、`observation.css`、`interaction.*`、`task-dashboard.*`、`dashboard.*`、`tasks.*`、`task.*`、`tasks.html`、`memory.*`、`docs/ui/entry.js`、`tests/ui/ui.test.ts`、新 `tests/ui/interaction-browser.mjs` | 真实 served `docs/ui/runtime-shell.js`/`runtime.css`/`runtime-api.js` 供 observation、entry、task、task-dashboard、dashboard、tasks、interaction、memory 消费者复用状态栏/对话/轨迹；成功覆盖 draft edit、execution type、Markdown、390/768/1440/200%、键盘与 reduced-motion；失败覆盖 stale/disconnected、缺历史、无权限动作和不可读 tool output 的显式状态 | `pnpm test:ui && node tests/ui/interaction-browser.mjs`；browser harness 从真实 server URL 逐一断言实际 entry/task/review/memory 消费者成功与失败视图 | 不同 agent 独立 UI/a11y review；PASS 并保存真实 served 证据后，关闭本 worker browser/server 与临时截图目录 | W1、W3、network→frontend 交接 |
| W5 acceptance/verification closure | `tests/app/dashboard-e2e/**`、`docs/ui/dashboard-e2e-acceptance.md` | 原三条真实 browser E2E 全部保留；成功要求三类 receipt 均绑定 candidate SHA/tree 和 checker 真结果，AItest 含人工语义/motion；失败要求无 checker 结果、runner/checker 非零或 local-file-search 未完成时标非成功/INCOMPLETE；`cleanup` 必须为结构化 receipt，`no-task` 分支仍记录 `taskId: null` 与本轮 owned PID/port/temp-root inventory | `pnpm e2e:dashboard:web-search && pnpm e2e:dashboard:local-file-search && pnpm e2e:dashboard:aitest`；三条命令的 success/failure/no-task 分支均核对 `cleanup != null`、settled 资源释放或 unsettled recovery inventory | 不同 agent 独立 review 三类 receipt、checker 消费和 cleanup；PASS 后只回收本任务 browser、serve PID、port、temp root 和 worktree，未 settled/no-task 则保留并标 INCOMPLETE | W2、W4（含 W3 public API） |

本轮只落设计文档和图，不派发上述 worker。网络 worker 在 API/UI 前独占 `server.ts` 与 `runtime-api.js`，完成并交接后 W3 才写 `server.ts`、W4 才写 `runtime-api.js`；任何时刻只有一个活 writer。

## 7. 能力证据与未通过项

- `recon-closeout-r2.result.md` 已引用：调度无正式公开 consumer、`SchedulerPatrol` 仅内存态、UI journal 无 subscription/occurrence/reminder/lease 记录、四队列中 research/maintenance 不可达。
- `capability-r2.result.md` 已引用：`web-search` SUCCESS（`ui-task-implicit-draft-1`）、`aitest` SUCCESS（`ui-task-implicit-draft-1`）；`local-file-search` INCOMPLETE，`completeStatusOnly` 只是观察到的最终分支，不是已证明根因。
- 调度真实持久化、触发、busy admission、lease/fencing、重启恢复仍缺链；`SchedulerPatrol` 不是已交付能力。
- `provider.tool-result` 类型已存在，但观察投影/SSE 消费仍缺链；`observationToolSteps()` 仍只筛 `provider.tool`。
- 草稿 `revise()` 只改 proposal，未形成目标/范围/版本闭环；取消只在部分 UI 本地清变量。
- 三类 Dashboard E2E 中两类已有 capability worker 成功证据，但 graph/design 不授予实现 PASS；local-file-search、定时/周期、runner cleanup、AItest 人工语义/motion 仍为未通过项。

## 8. 验证记录

命令与结果（project CLI，非 MCPX）：

```text
dagpipe graph validate docs/dagpipe/scheduled-occurrence.graph.json -> valid (7 nodes, 6 edges)
dagpipe graph validate docs/dagpipe/subscription-control.graph.json -> valid (5 nodes, 4 edges)
pnpm dagpipe:validate -> validated 11 DAGpipe graph(s)
git diff HEAD --check -> clean
```

## 9. 待 review 与剩余风险

待 parent 独立设计 review：契约字段是否与实现拆包对齐、三张旧图消融是否过度、周期最小规则是否仍最小、GCM 文件边界是否互斥、checker outcome 消费是否复用现有 verifier/review。新增 `humanagent-subscription-control` 与 scheduled-occurrence 只通过同一 JSONL 事务资源和 typed receipt 竞争；新 subscriptions/core 文件尚未存在，binding 以现有 ownerPath 作 design binding 并记录 plannedOwnerPath/pending。scheduled-occurrence 与 serve-task 通过 typed public 输入输出调用连接，scheduled execute/settle 不另造执行或 verifier；W2 骨架最终 `due -> execute -> settle` 成功验收依赖 W3 交接。W2 同步 scheduled-occurrence binding，W3 在 W2 交接后同步 subscription-control binding；W3 落地 `packages/runtime/src/ui-runtime/task-verification.ts` 后同步 serve-task binding（本轮不改 serve 图）。

剩余风险：订阅控制与调度实现未存在，图绑定当前/planned owner 路径不代表节点已实现；独立 control 图的 durable receipt、JSONL 临界区与 claim 竞争仍需 W2/W3 真实 consumer 验证；AItest 人工语义/motion receipt 和 runner cleanup 修复仍需 W5 真实验证。
