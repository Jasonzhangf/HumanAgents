# Agent Communication and Feedback Contract

状态：`ASTRA-REMEDIATION / DESIGN-REVISION / IMPLEMENTATION-BLOCKED`

本文是 HumanAgent 多 Agent 通信、反馈投递和消费确认的唯一设计 owner。它定义消息如何产生、谁可以发布、谁可以读取、谁负责处理、如何确认和如何恢复；具体 Agent 的职责仍由 `agent-flows.md`、模板文档和 Task/Assignment owner 定义。

本文不把 Agent 私有 Session 当成通信协议，也不把 UI、Provider、DSH Session 或模型文本当成状态真源。

## 1. 两条通信路径

Agent 之间只有两种正式路径：

```text
Capability Call
  Agent A
    → 已注册、已授权的 Agent B capability
    → Operation receipt
    → typed result / typed error

Internal EventBus
  Harness owner
    → durable event
    → scope-filtered delivery
    → consumer handler
    → durable handler receipt + cursor/ACK
```

### Capability Call

Capability Call 用于主动查询或请求处理：

- Agent 只能调用对方已注册的 capability；
- capability 的输入、输出、scope、权限、版本和 owner 必须已锁定；
- 调用先产生 `Operation` 和 `dispatch receipt`，结果再通过 typed result 查询或投递；
- 调用方不能读取被调用 Agent 的私有 Session、Context、Journal 或 runtime 内存；
- 记忆查询、任务状态查询、结果读取、资源申请和 Memory save 都走 capability，而不是 Agent 间自然语言私聊。

### Internal EventBus

EventBus 用于 Harness 产生的通知和异步反馈：

- Task/Assignment 状态变化；
- Worker result ready、progress、blocked、failure；
- Bug、Attention、resource availability；
- Review request/result；
- Memory candidate/accepted/rejected；
- checkpoint、stop、settle、reconcile 和 lifecycle；
- Schedule 到期产生的 Reminder。

EventBus 不判定 Task 成功，不替代 typed capability，不允许普通 Agent 直接发布 Harness control fact。

## 2. Runtime Binding 与可信发布

所有 Agent-to-Agent 请求和事件都必须绑定到当前的 `RuntimeBinding`：

```ts
type RuntimeBinding = {
  runtimeId: string
  agentInstanceId: string
  roleId: string
  taskId?: string
  assignmentId?: string
  interactionScopeId?: string
  executionEpoch: number
  scopeRef: string
  permissionRevision: string
  capabilityDigest: string
  bindingDigest: string
}
```

规则：

- task-bound runtime 必须同时有 `taskId`、`assignmentId` 和 `executionEpoch`；
- interaction-bound runtime 只能有 `interactionScopeId`，不能伪造 Task/Assignment；
- 发布者身份来自 Harness 维护的 Binding Registry，不接受 payload 中自报的 `sourceRef`；
- 发布前验证 runtime、assignment、epoch、permission revision 和 capability digest；
- 消费、重放、引用展开时重新执行 scope/ACL 和 epoch 校验；
- 旧 epoch 的事件只能被记录为 `stale`，不能推进新 epoch；
- 事件发布者、事件 owner、业务结果 owner 和 UI projection owner 可以不同，但每个事实只能有一个写 owner。

## 3. 消息 envelope

```ts
type AgentMessageClass = 'control' | 'data' | 'observation'

type AgentMessageEnvelope = {
  schemaVersion: 1
  messageId: string
  streamId: string
  sequence: number
  class: AgentMessageClass
  kind: string
  publisherBindingRef: string
  scopeRef: string
  targetRef?: string
  correlation: {
    taskId?: string
    assignmentId?: string
    requestId?: string
    operationId?: string
    parentMessageId?: string
    inputRevision?: string
  }
  payloadRef: string
  sourceFactRef: string
  capabilityRef?: string
  emittedAt: string
}
```

`payloadRef` 只引用业务或观测数据；控制事实保存在 Journal 的 control fact 中。消息 envelope 不复制完整业务 payload，也不把 retry、provider、health、checkpoint 或权限控制塞进业务数据。

### 消息类别

| 类别 | 可发布者 | 是否可改变状态 | 示例 |
|---|---|---:|---|
| `control` | 对应 Harness owner 或被证明的 delegated owner | 是 | stop、permission revoke、checkpoint committed、assignment accepted |
| `data` | 具有 Assignment 的 Agent/Operation owner | 不能直接改变高层状态 | WorkResult、ReviewResult、MemoryCandidate、tool result |
| `observation` | Runtime/adapter/UI projection owner | 否 | progress、health、trace、presentation、统计 |

模型的 `completion-proposal`、`checkpoint-proposal` 和 `memory.learned` 只能作为 `observation` 或候选 `data` 事件；必须经过对应 owner 的工具/准入流程后，才可产生 `control` 事实。

## 4. 协同与反馈矩阵

| 需求 | 发送路径 | 接收 owner | 最终事实 |
|---|---|---|---|
| Interaction 提交需求 | `requirement.submit` capability | Interaction/Task owner | accepted RequirementEnvelope |
| 编排派发 Worker | assignment capability + control event | Orchestration owner | Assignment committed |
| Worker 交付结果 | typed `WorkResult` + data event | Assignment owner | result accepted/rejected |
| Worker 报进度 | observation event | Projection/Orchestration owner | progress projection，不推进完成 |
| Worker 阻塞/失败 | `attention`/`blocked` data event | Assignment owner | Attention/重新编排决定 |
| Bug 报告 | `bug.report` capability + data event | Bug owner | Bug record |
| 资源请求/释放 | `resource.acquire/release` capability | Resource owner | lease fact |
| Review 请求/结果 | review capability + data event | Review coordinator | review admission/result |
| Cancel/steer | control command port | Operation/Checkpoint owner | stop receipt/settle/checkpoint |
| Memory 查询 | `memory.search/inspect/compare` capability | Memory owner | scoped result refs |
| Memory 候选 | `memory.save_candidate` capability + data event | Memory owner | accepted/rejected candidate |
| Schedule 提醒 | Schedule → Reminder event | Subscription owner | consumed/skipped reminder |

消息到达不等于交付成功。接收 owner 必须校验 `assignmentId`、attempt、epoch、input revision、source fact 和 evidence refs；无效结果只能进入 rejected/stale，不得推进 Task。

## 5. Durable EventBus 消费协议

EventBus 使用 Journal Owner 作为控制事实和消费回执的持久化 owner。发布与消费采用以下协议：

```text
1. Domain owner commit source fact / event intent
2. Journal Owner commit event envelope
3. EventBus deliver by scope-filtered stream cursor
4. Consumer validates binding, ACL, epoch and schema
5. Consumer returns a typed `EventHandlerCommit` result; it does not commit domain facts directly
6. For a retryable failure, Journal Owner commits a `RetryObligation` only; it does not commit a final receipt or advance the cursor
7. For a final result in `journal-atomic` mode, Journal Owner atomically commits internal effect facts + handler receipt + next cursor
8. For `operation-barrier`, persist the external Operation intent/idempotency key before execution; after settle/reconcile, commit handler receipt + effect refs + next cursor
9. Projection/notification is published after durable consumer commit
```

### Consumer receipt

```ts
type EventConsumerReceipt = {
  consumerKey: string
  messageId: string
  streamId: string
  handledSequence: number
  disposition:
    | 'applied'
    | 'duplicate'
    | 'stale'
    | 'rejected'
    | 'terminal-failure'
  effectRefs: string[]
  failureRef?: string
}
```

```ts
type EventHandlerCommitIntent = {
  consumerKey: string
  messageId: string
  disposition: Exclude<EventConsumerReceipt['disposition'], 'retryable-failure'>
  completionMode: 'journal-atomic' | 'operation-barrier'
  internalEffectFacts: string[]
  externalOperationRefs: string[]
  failureRef?: string
}

type EventRetryObligation = {
  retryKey: string
  consumerKey: string
  messageId: string
  streamId: string
  failedSequence: number
  attempt: number
  nextAttemptAt: string
  ownerRef: string
  failureRef: string
  state: 'pending' | 'exhausted' | 'cancelled'
}

type EventHandlerRetryIntent = {
  consumerKey: string
  messageId: string
  retryObligation: EventRetryObligation
}

type EventHandlerCommit = EventHandlerCommitIntent | EventHandlerRetryIntent
```

`consumerKey` 由 `consumerOwner + scopeRef + contractVersion` 组成。`messageId` 和 `consumerKey` 的组合是幂等键。

固定语义：

- ACK 不是网络返回值；只有最终 `EventConsumerReceipt` 和 effect refs 已 durable commit，才推进 cursor；
- Consumer 不直接推进 Assignment、Task 或其他领域状态；Journal Owner 只接受 `EventHandlerCommit`；
- `EventHandlerRetryIntent` 只提交 `RetryObligation`，不产生最终 receipt、不推进 cursor。重启后按同一 `messageId`/`consumerKey` 重投原消息；达到有界上限后，将 obligation 从 `pending` 转为 `exhausted`，再提交 `terminal-failure` disposition 的最终 receipt/cursor；
- `journal-atomic` 要求 `externalOperationRefs` 为空；内部 effect facts、最终 receipt 和 cursor 放入同一个 `JournalCommitIntent`；
- `operation-barrier` 用于同时需要内部 effect 和外部 Operation 的 handler：先持久化与 `consumerKey + messageId` 绑定的 Operation intent/idempotency key，可提交 pending/progress fact，但不能提交最终 receipt 或推进 cursor；外部 Operation settle/reconcile 后，再提交 internal effect refs、最终 receipt 和 cursor；
- 外部副作用若在最终 receipt 提交前崩溃，恢复流程先查询/settle/reconcile 已存在的 Operation，再提交同一回执，禁止直接重做；
- ACK 丢失时允许重投，消费者通过 `messageId`/`consumerKey` 去重，不重复执行副作用；
- 每个 stream 只保证单 stream 顺序，不承诺跨 stream 全局顺序；
- retryable failure 必须由 `RetryObligation` 持久化后才允许离开当前消费步骤；consumer owner 按有界次数重试，超过上限转为 terminal failure 并写入 Attention/DLQ，由 owner 决定恢复、人工处理或终止；
- terminal failure 不得伪造 ACK 成功，必须持久化失败回执和下一动作；
- Agent 离线时事件留在 Journal，恢复后从 durable cursor 继续；观察事件可按 retention 丢弃，control/data 事件不能静默丢失；
- 权限撤销后，未消费事件在重放时重新校验，越权事件进入 rejected/stale，不交给 Agent；
- EventBus transport close、进程崩溃或 daemon 重启不改变 Journal 事实；新 daemon 必须先取得 lease，再从 cursor 恢复；
- 未知副作用不得通过重投事件盲目重做，必须进入 Operation reconcile。

因此，“effect 已发生、receipt 尚未提交”的窗口有唯一恢复路径：从持久化的 effect fact 或 Operation intent 查询结果，再提交同一消费回执；不能依据内存状态猜测，也不能新建第二个 Operation。

## 6. 错误和反馈闭环

每个 Agent 都维护自己的 Bug/Attention 记录，但不能自行关闭由其他 owner 创建的问题：

```text
发现问题
  → report capability / attention event
  → owner 接收并提交 receipt
  → owner 分配 next action / resource / decision
  → Agent 反馈 result 或 failure
  → owner 验证 evidence
  → accepted / rejected / retry / blocked / escalated
```

以下情况必须产生结构化反馈，而不是只写入下一轮 prompt：

- capability 不存在或授权过期；
- Agent 无法继续、目标条件不满足或结果不完整；
- 资源不足、lease 即将过期或需要调整优先级；
- 发现 Bug、重复执行、输入 revision 过期；
- Review 不通过，需要整改；
- Memory 发现候选，但尚未批准入库；
- Provider/Driver 返回 unknown 或 transport 断开。

反馈的 `nextAction` 必须由 owner 接受后才具有控制意义。Agent 自报的建议只能是 data/observation，不能绕过 owner 修改 Assignment、Checkpoint、Permission 或 Task 状态。

## 7. 访问边界

- Agent 不能直接读其他 Agent 的 session、Context、Journal 或内存；必须调用对方注册的、scope-filtered typed capability。
- Memory Agent 可通过受限 session/history query 读取授权 evidence，但不能把原始 Session Log 变成 Task 真源。
- Orchestration Agent 可读取 Worker 的 WorkResult、progress 和 Attention projection，但不能直接写 Worker 的 Context。
- Review Agent 可读取指定 Assignment 的证据范围，不能替代 Task/Checkpoint owner。
- UI/ACP client 只能读取 observation projection；所有动作通过 command/capability port。
- EventBus subscriber 的 scope 不能扩大 publisher 的 capability；订阅成功不授予数据读取权限。

## 8. 验证矩阵

实现前必须有以下 focused tests：

| 场景 | 必须证明 |
|---|---|
| Journal 已提交、发布前崩溃 | 重启后仍能发布一次，不能丢 control/data event |
| handler 成功、ACK 丢失 | 重投只产生 duplicate receipt，不重复副作用 |
| consumer 连续失败 | 有界重试、Attention/DLQ、明确 owner 和 next action |
| retry obligation 已提交、真正重试前崩溃 | 重启后仍从同一 message 重投，不推进旧 cursor，不丢失重试责任 |
| 内部 effect + 外部 Operation | operation-barrier 不提前提交最终 receipt/cursor；settle/reconcile 后只提交一次 |
| 跨 Task/Assignment 订阅 | scope/ACL 拒绝，不能读取或消费 |
| 旧 epoch 迟到 | 标为 stale，不推进新 epoch |
| 权限撤销后重放 | 重新校验并拒绝越权事件 |
| Agent 离线后恢复 | 从 durable cursor 继续，不依赖内存状态 |
| WorkResult 重复或 input revision 过期 | 幂等或 rejected，不重复推进 |
| Unknown Operation 反馈 | 进入 reconcile，不盲目重做 |
| UI 断线/重连 | 只补读 projection，不改变业务状态 |

## 9. Owner

| 责任 | 唯一 owner |
|---|---|
| 消息 schema、publisher proof、scope ACL | `packages/contracts` / `packages/core` |
| EventBus delivery、cursor、consumer receipt | `packages/runtime/events` |
| Journal append 和 receipt 原子提交 | `packages/adapters/jsonl` |
| Assignment/WorkResult acceptance | Orchestration/Assignment owner |
| Operation stop/reconcile/settle | Operation owner |
| Checkpoint/closure/reentry | Checkpoint/Control owner |
| UI/ACP projection | UI/ACP adapter owner |

在上述合同冻结并通过复审前，多 Agent 实现保持 `IMPLEMENTATION-BLOCKED`。
