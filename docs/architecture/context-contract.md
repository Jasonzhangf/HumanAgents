# Agent Context Contract

> 本次 Brain 上下文与调用/turn 边界以[双大脑语义上下文设计](dual-brain-semantic-context-design-2026-10-11.md)为准；绑定项目需求库 v11。旧活动窗口与 fork 描述不得覆盖该用户决定。

状态：`DESIGN-CANDIDATE / CONTEXT-CONTRACT-V1`

本文定义 HumanAgent 如何从不可变事实、记忆索引、Agent Profile 和当前执行状态装配 Agent Context。本文是 Context Slot、Journal Projection、缓存边界、Tool Result 映射和统一 Context Builder 的共同契约。

本文不定义 Provider 的具体请求格式，也不把 DSH 或 MCPX 类型提升为 HumanAgent 领域类型。Provider/DSH 请求格式由 Prompt Renderer 适配器负责；Tool 调用由 Tool Runtime Adapter 负责。

## 1. 不可变原则

### 1.1 Absolute Journal 是事实真源

Absolute Journal 追加保存所有事实：

- 用户输入、Agent 请求和输出；
- Tool Call、Tool Result、Operation 状态和错误；
- 用户修正、权限确认和 Attention；
- Context View、Path Resolution、Compact 和 Checkpoint；
- 外部执行证据、原始资产引用及其 digest。

Journal Slot 一旦提交不能删除或改写。Index、Cache、Context View 和 Projection 都可以重建或替换，但必须继续引用可读取的 Journal 内容。

```text
A000100  用户输入
A000101  错误 Tool Call
A000102  Tool 失败
A000103  修正 Tool Call
A000104  Tool 成功
A000105  Review 通过
A000106  Checkpoint 完成
```

Journal 的追加只有一个跨进程 owner：`Journal Owner`。Checkpoint、EventBus、scheduler、Operation 和 Context Committer 都只能提交 typed `JournalCommitIntent`，不能直接写 JSONL 或自行分配 `seq`。Journal Owner 在真实追加临界区内重新读取尾部 `seq/previousDigest`，按 `commitId` 去重，追加并 flush 一条完整记录后才返回 receipt；返回前不得把记录视为 durable。

```text
accept commitId + scope + fact
  → serialize at Journal Owner
  → verify tail seq/previousDigest
  → append fact + commitId
  → flush durable record
  → record/replay existing receipt by commitId
  → publish only after durable commit
```

进程在 append 前或 receipt 返回前退出时，重试同一 `commitId` 必须查询并返回已有事实，不能产生第二个 `seq`；同一 `commitId` 携带不同 fact digest 时显式返回 `commit-conflict`。尾部校验失败进入 `journal-corrupt`/Attention，禁止由 Index、EventBus 或日志猜测缺失事实。多 writer、receipt 丢失、重启和冲突都属于 Journal Owner 的最小验证面。

### 1.2 Context 是视图，不是事实库

Agent 看到的是 Harness 根据当前 Binding、权限、Task、Memory Policy 和 Journal 水位生成的 Context View。它可以非连续：

```text
Context View:
  C100 → A000100
  C103 → A000103
  C104 → A000104
  C105 → A000105
  C106 → A000106
```

`A000101` 和 `A000102` 可以不进入当前 Context，但仍必须能通过 Absolute Journal 查询。

### 1.3 “有效”必须有依据

`effective-path` 只消费已经由领域 owner 接受的替代关系。它不能从“最后一个调用成功”推断“任务正确完成”。有效性至少需要：

- 同一 Task 和 Assignment；
- 匹配的 Directive Revision 和 Execution Epoch；
- 明确的验收结果或 Review Evidence；
- 没有被后续事实失效；
- 当前权限仍允许读取和发送。

Checkpoint 处于 `waiting`、`failed` 或 `unknown` 时，不能作为成功依据。

### 1.4 Control Fields 不进入 Context

模型在 end-turn/stop 返回的 `summary`、`goal`、`blocked`、`next`、`checkpoint proposal`、`completion proposal` 和 `memory.learned` 都属于控制面。它们被 Decoder 解析后发布事件，不直接成为 Context Slot，也不自动拼回下一轮 Prompt。例外是已准入 standard turn 的 `humanagent_turn_end` 四段语义：它仍是模型 authored 的语义材料，只有 Checkpoint/Control Owner 校验 admitted turn、scope 和 evidence refs 并 durable commit 后，才作为 prior-turn semantic history 投影。Tool `reason` 同样属于控制面，但 Tool Owner 可以把它转换成专门的紧凑 `ToolReasonProjection`，供下一轮推理参考。

```text
模型响应
  → Control Decoder
  → control / memory-candidate / tool-intent / checkpoint event
  → 对应 owner 建立自己的状态、index、Operation 或 Attention
```

业务输出、Tool Result、`ToolReasonProjection` 和经 owner 授权的 Memory Recall 才能通过独立的 `outputRefs`、`toolReasonRefs`、`memoryRecallRefs` 或 Projection 进入 Context。这样原始控制字段可以兼容演进，同时只把明确需要的短 reason 放入下一轮推理。

Checkpoint 不由 ContextBuilder、Prompt Renderer 或模型输出直接生成。只有 Checkpoint/Control Owner 通过统一提交入口接受三类来源：`agent-tool`（模型调用内置工具）、`harness-control`（watchdog、权限、取消等控制命令）和 `recovery`（重启后的重入/收拢）。内置 `checkpoint.inspect`、`checkpoint.recall`、`checkpoint.save`、`checkpoint.record-dead-end` 和 `checkpoint.reenter` 只是这些来源的 typed facade；Context 层只消费已提交的 recovery state 和 Context View。

### 1.5 Checkpoint 单一提交入口与 closure

Checkpoint 的唯一写 owner 是 Runtime 的 `Checkpoint/Control Owner`，唯一提交入口是 `submitCheckpoint(input)`。三个来源不能分别写 Journal、修改 Task 状态或发布“已完成”事件：

```text
validate scope + permission + source epoch
  → settle/reconcile affected operations
  → persist recovery state and referenced assets
  → Journal Owner.commit(checkpointCommitId, checkpoint fact)
  → Journal Owner.commit(closure/reentry fact when applicable)
  → publish projection after durable commit
```

`committed` 只表示 checkpoint fact 已 durable；`reentryAllowed` 是独立字段，表示当前权限、资源、未收拢副作用和恢复条件允许再次进入，不能由 `committed` 推导。`checkpoint.reenter` 必须创建新的 execution epoch/branch，并重新做 binding、permission 和 admission；旧 epoch 的迟到结果只能成为 `stale`。

统一 closure 语义如下：

| 触发 | 提交来源 | 必须先做 | closure / reentry 结果 |
|---|---|---|---|
| 模型失联、EOF 或无进展 | `harness-control` | 关闭新工作入口；未知 Operation 先交 Operation Owner reconcile | `stopped` 或 `unknown/waiting-reconcile` checkpoint；不得当作完成 |
| 修复耗尽 | `harness-control` | 保存原始响应和已完成/未知 Operation | `protocol-noncompliant` closure；无副作用可停止，有未知副作用必须 `reconcile` |
| 权限撤销 | `harness-control` | 递增 permission epoch，fence 新发送，收拢在途 Operation | `blocked`/`stopped` checkpoint；`reentryAllowed=false` 直到重新 admission |
| 宿主重启 | `recovery` | 取得 host/Journal lease，恢复 pending intent 和未知 Operation | 重放同一 commit；重入时新 epoch，不能恢复旧 session 为高层真相 |
| interaction cancel | `harness-control` | 关闭 interaction 输入入口并处理在途 operation | `InteractionClosure(cancelled)`；不创建伪 Task checkpoint |

Checkpoint 只记录恢复入口和事实引用；Task/interaction 的最终状态仍由各自 lifecycle owner 按 closure 证据提交。`close` transport、Provider EOF 或模型文本本身都不能代替上述 closure。

Checkpoint/Control Owner also owns closure identity compatibility. The current
v2 identity is `checkpoint-closure:<checkpointCommitId>` with
`checkpoint-commit-id` scope. A read-only v1 compatibility exception may read
`checkpoint-closure:<checkpointId>` with `checkpoint-id` scope for records
written before scoped commit identities existed. Every persisted
`CheckpointClosureRecord` carries its compatibility version; the reader must validate the
checkpoint, outcome, next action, evidence scope and evidence membership before
reuse. A v1 record with mismatched content or an unsupported compatibility
version is an explicit error and cannot fall through to a new canonical
commit. Remove the v1 reader after every supported closure store contains no
legacy checkpoint-id records; until then, this is the sole declared
compatibility boundary and not a second submission owner.

### 1.6 Native Turn 的语义历史与保存描述

显式/隐式大脑的跨 turn Context 只装配固定身份与规则、当前目标/约束，以及合法 scope 下已提交 Checkpoint 的可信时间、可决策 `summary` 和语义证据引用。跨 turn 历史不装配旧 turn 的原始模型消息、完整推理内容、工具结果正文或隐藏 Provider continuation/session 链。当前仍未收拢的 turn 可以保留完整当前消息和 raw tool evidence；保存边界返回完整 durable turn receipt 后，这些 raw 才能退出 active Context。Absolute Journal 与不可变 evidence asset 仍保留且可授权读取。

沿用现有 Checkpoint `summary` 字段作为人可读的 description，不增加同义的 `description` 字段。它必须说明当前可证实的进展、限制/未决问题，以及可用于判断是否选择该恢复点的下一项决策；用户应能仅凭 description 选择回退点，无需先查询或展开 raw 历史。description 是语义摘要，不代替 recovery state、未决 Operation 状态或证据。

Checkpoint 的保存时间由 Runtime/Checkpoint 提交 owner 在首次 durable commit 时赋可信 UTC 时间及 Harness 来源；不能采信模型时间。相同 commit identity 的重试返回首次提交的事实与时间。Journal seq 和提交关系拥有逻辑顺序；不通过篡改时间掩盖时钟回拨。三处现有 App semantic-checkpoint encoders 已投影 Runtime entry 已有的 `checkpointId`、`committedAt`、`description`（checkpoint summary）和顶层 `evidenceRefs`。r208 的实际 captured POST 在成功 CLI 后因缺少 `checkpointId` 为 RED 2/2，修复后同例为 GREEN 2/2；实际运行覆盖 v1 主路径。v2（`checkpoint-journal.ts`）与 child-run encoder 仅完成源码修复，运行仍为 `UNVERIFIED`。adopted child 现有投影没有 `evidenceRefs` 字段：`AdoptedChildSemanticContext`/`AdoptedChildSemanticDelivery` 不含该字段，含该字段的 `RefinedChildSemanticDelivery` 是不同既有类型；本增量未新增 child 字段，也没有静默消除这个历史类型 gap。refined child body/ref 仍走既有 accepted path。

保存边界按独立 receipt 记录 recovery asset、checkpoint、closure、Context View 和合格 history publication 阶段。Checkpoint committed 不等于 turn closed；history publication 也不等于 turn closure 或 next-turn eligibility。只有完整 durable turn receipt 才允许把 raw 从 active Context 移出；若任何阶段失败或结果 unknown，则保留 raw、原错、commit identity、已提交阶段及恢复责任。副作用不得因 Context 回退而被假定已撤销。

### 1.6.1 Native turn 的逻辑 receipt

以下是 native turn 与 checkpoint 边界的逻辑 discriminated union，供后续 `contracts` / Runtime 实现使用；它不是当前 TypeScript validator 或 JSON Schema，也不表示运行时已实现。每个阶段都显式返回结果；先前事实不能因后续失败而丢失，因前置阶段失败而未运行的阶段必须标记 `not-executed`。

```ts
type StageResult<T> =
  | { stageId: string; state: 'succeeded'; value: T; evidenceRefs: string[] }
  | { stageId: string; state: 'failed'; error: TypedError; recoveryRef: string; evidenceRefs: string[] }
  | { stageId: string; state: 'not-executed'; blockedByStage: string; causeRef: string; firstErrorRef?: string; recoveryRef: string }

type EffectState = 'not-started' | 'accepted' | 'running' | 'succeeded'
  | 'failed' | 'blocked' | 'cancelled' | 'unknown' | 'stale'

type AdmittedTurn = {
  turnId: string; workAssignmentRef: string; taskRef: string; scopeRef: string
  cycleRef: string; inputRevision: number; directiveRevision: number
  executionEpoch: number; runtimeBindingRef: string; permissionRevision: string
  admissionEvidenceRefs: string[]; currentTurnRef: string; recoveryStateRef: string
}

type ToolExecutionFact = {
  identity: { surface: string; toolId: string; bindingRef: string; route: string }
  requestRef: string; callRef?: string; operationRef?: string; state: EffectState
  rawEvidenceRefs: string[]; resultRef?: string; resultDigest?: string; errorRef?: string
}

type TurnExecutionFacts = {
  turnId: string
  dispatchState: 'not-dispatched' | 'accepted' | 'running' | 'returned' | 'failed' | 'unknown' | 'cancelled'
  assignmentRef: string; childResultRef?: string
  workResultState?: 'reported' | 'accepted' | 'rejected' | 'incomplete' | 'unknown'
  toolFacts: ToolExecutionFact[]; operationRefs: string[]; acceptanceEvidenceRefs: string[]
  firstErrorRef?: string; unresolvedOperationRefs: string[]; rawTurnRefs: string[]
}

type SemanticClaim = { fact: string; certainty: 'confirmed' | 'partial' | 'unknown' | 'corrected'; sourceRefs: string[] }

type SemanticClosureCandidate = {
  turnId: string; checkpointSummary: string; ruleVersion: string
  claims: SemanticClaim[]; constraints: SemanticClaim[]; unresolvedQuestions: string[]
  semanticArtifactRefs: string[]; rawTurnRefs: string[]
  requestedOutcome: 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'stopped' | 'unknown'
}

type DurablePhase = 'recovery-assets' | 'checkpoint' | 'closure' | 'context-view' | 'history-publication'
type DurableCheckpointReceipt = {
  commitIdentity: string
  checkpointRef: string
  journalReceiptRef: string
  committedAt: string // RFC 3339 UTC instant, assigned at first durable commit
  timeAuthority: {
    source: 'harness'
    owner: 'runtime-checkpoint-control-owner'
    authorityRef: string
  }
}

type CheckpointBoundaryOutcome = {
  commitIdentity: string; stages: StageResult<unknown>[]
  durablePhases: Array<{ phase: DurablePhase; state: 'committed' | 'failed' | 'unknown' | 'not-executed'; receiptRef?: string }>
  checkpointReceipt?: DurableCheckpointReceipt; closureReceiptRef?: string; contextViewReceiptRef?: string
  historyReceiptRef?: string; firstErrorRef?: string; laterErrorRefs: string[]
  unresolvedOperationRefs: string[]; rawTurnRefs: string[]; recoveryRef?: string
}

type RecoveryHoldFacts = {
  commitIdentity: string; firstErrorRef?: string; laterErrorRefs: string[]
  rawTurnRefs: string[]; unresolvedOperationRefs: string[]
  stages: StageResult<unknown>[]; durablePhases: CheckpointBoundaryOutcome['durablePhases']
  durableReceiptRefs: string[]; recoveryResponsibilityRef: string
}

type SuccessPathProjection =
  | { path: 'success'; active: true; durableTurnReceiptRef: string; checkpointReceiptRef: string; historyReceiptRef: string }
  | { path: 'success'; active: false; reasonRef: string }

type RecoveryHoldProjection =
  | { path: 'recovery-hold'; active: true; facts: RecoveryHoldFacts }
  | { path: 'recovery-hold'; active: false; reasonRef: string }

type TurnDisposition =
  | { state: 'ready-next'; durableTurnReceiptRef: string; checkpointReceiptRef: string; historyReceiptRef: string; nextActionRef: string }
  | { state: 'waiting-recovery'; recoveryRef: string; firstErrorRef?: string }
  | { state: 'waiting-reconcile'; operationRefs: string[]; recoveryRef: string }
  | { state: 'waiting-correction'; rawTurnRefs: string[]; correctionRef: string }
  | { state: 'stopped'; stopOperationRef: string; settleEvidenceRefs: string[]; checkpointReceiptRef: string }
  | { state: 'save-incomplete'; commitIdentity: string; durablePhases: CheckpointBoundaryOutcome['durablePhases']; recoveryRef: string; firstErrorRef?: string }
  | { state: 'stale'; evidenceRef: string; currentEpoch: number }
```

Runtime 生成 identity、binding、epoch 和准入证据；模型只能提出语义候选，不能设置提交完成、权限、下一 turn 资格或可信保存时间。Tool identity 是完整的 `(surface, tool id, binding, route)`，相同名称不代表同一能力。ACK、reported WorkResult、acceptance、Operation settle 和业务验收是不同事实。`accepted`/`running` 不代表效果完成；`unknown` 保留原 operation 身份并要求 reconcile；旧 epoch 的 `stale` 结果不能推进当前路径。无 Tool 的 turn 用空 `toolFacts`，不伪造调用或 receipt。

Runtime Checkpoint/Control Owner 提交 typed intent，JSONL Journal Owner 仍是唯一追加和 receipt owner。`DurableCheckpointReceipt` 将 `committedAt`、明确的 Harness source/authority、checkpoint fact 和 Journal receipt 绑定到同一 `commitIdentity`。`committedAt` 必须表示首次 durable commit 的 UTC 时间；字段格式校验只证明字符串形状，不证明时间由可信 Harness owner 赋值。结果未知时必须按同一 `commitIdentity` 查询；若已 durable，重试必须返回首次事实、原时间和原 receipt，不能另造时间或身份。五个 durable phase 各自可见，后续成功不能覆盖前序失败。`ready-next` 只表示本 turn 有完整 durable receipt；它本身不派发下一 turn，后续仍要重新检查 permission、resource、health 和未收拢 effects。

静态 admitted-turn 和 checkpoint 图均以无条件 ARC dependency 表达拓扑。成功投影 `S`、恢复保持 `R` 都是纯 envelope projection，静态图中两者都会运行并汇入唯一 `Z`；投影里的 `active` 判别式要求恰好一个路径 active。图不声称 DAGpipe 存在互斥条件边，也不构成 Runtime 条件路由证据。会产生副作用的只有对应的业务阶段节点：它们必须验证入站 envelope 的所需前置阶段为 `succeeded`、commit identity 未变、当前权限与 epoch 有效后才可执行；否则不执行副作用，输出 `not-executed`，携带原 `firstErrorRef`/cause 和恢复引用。预期失败、unknown 与 stale 必须作为 typed envelope 值返回，而非令 Operator transport 失败，以便其后节点无副作用收拢。只有五阶段都有合格 receipt 且没有错误、unknown、stale 或未决 operation 时，`S` 可 active；其余情况由 `R` active，并收集首错、后续 reconcile/save 错误、raw refs、未决 operation、各阶段状态/receipt 与恢复责任。唯一 `Z` 校验两投影恰好一个 active，再返回 disposition/boundary outcome。

### 1.6.2 Native turn 语义检查样例

以下是设计检查，不是运行时测试结果；实现审查需对照 admitted-turn 与 checkpoint-save 两个图和上述 unions 逐项复核。

| 输入情况 | 必须保留的事实 | 结果与禁止推断 |
|---|---|---|
| 派发前拒绝 | dispatch failed；后续未运行阶段为 `not-executed` | `waiting-recovery`；不能伪装为 child result 或 checkpoint 成功 |
| 收到 dispatch ACK 但没有 WorkResult | accepted 与 unknown 分开，保留原 operation identity | `waiting-reconcile`；不能把 ACK 当完成或换新 identity 盲重试 |
| Tool 失败且已知无副作用 | call/result/error refs 与该 Tool 的规则版本 | 可描述有界失败；不能据此断言整项任务失败或可安全重试 |
| Tool/WorkResult 部分返回 | partial、完整性信息、未决 refs 和来源证据 | 等待纠正或恢复；不能升格为完整验收 |
| 已请求取消但效果未 settle | stop request 与 open operation | `waiting-reconcile`；不能当作 stopped 或跳过 closure |
| recovery asset 已保存、checkpoint 失败 | asset receipt、失败阶段、raw 和原 commit identity | `save-incomplete`；不得换身份重做或丢弃 raw |
| checkpoint receipt 丢失或结果 unknown | 用同一 commit identity 查询，保留首次 trusted time | 未验证前 `save-incomplete`；不能猜测或重复追加 |
| checkpoint durable、closure/Context View 未完成 | 每阶段独立状态与 receipt | `save-incomplete`；checkpoint 不等于 turn closed |
| Context View durable、history publication 失败 | 可重建的 durable facts 与 publication 恢复责任 | 只恢复 publication；不能重跑 child/tool |
| Recovery asset 持久化失败 | 已收集的 recovery intent、首错、raw 与未提交阶段 | `save-incomplete`；checkpoint/closure/view/publication 全部 `not-executed` |
| Closure 提交失败或结果 unknown | checkpoint receipt、closure error/unknown、同一 commit identity | `save-incomplete`；不能假设 turn closed，也不能发布 history |
| Context View 提交失败或结果 unknown | checkpoint 与 closure receipt、view 阶段状态 | `save-incomplete`；不能宣称跨 turn history 已发布 |
| History publication 阶段未执行 | 前序阶段的精确 receipt/失败状态 | `save-incomplete`；不能把未执行写成 publication 成功 |
| 旧 epoch 迟到结果 | source epoch 和 stale evidence | `stale`；不能覆盖当前 turn/checkpoint |
| 全部副作用已 reconcile、保存完整 | 各阶段 receipt、合格 publication receipt | 可返回 `ready-next`；之后仍需 admission recheck |
| 完整 receipt 已返回 | recovery assets、checkpoint、closure、Context View、history publication 各有 receipt；raw 可退出 active Context，Journal/assets 仍可引用 | 不能删除 Journal 或 evidence assets |

图拓扑为显式 SESE fan-out/fan-in：admitted-turn 的保存结果分到成功投影和 `recovery_hold`，再汇入唯一 disposition；checkpoint 图的五个 durable phase 顺序执行后分到成功投影和 `recovery_hold`，再汇入唯一 `checkpoint_boundary_outcome`。DAGpipe grammar 不声明条件边，因此两投影节点都在静态 DAG 计划中执行，只能按入站 envelope 产出 active/inactive 的纯投影。上游预期失败不得令 Operator transport 失败或跳过节点；后续效果阶段收到 failed/unknown/not-executed envelope 时必须不执行副作用，输出带原错和恢复引用的 `not-executed`，供末端 `recovery_hold` 聚合。checkpoint 图每个 durable phase 都有独立 receipt；边界结果保留所有已提交 receipts、首错、后续错误和恢复责任。静态 DAG 验证只证明拓扑，不验证这些 envelope、条件激活或副作用门控行为；后者仍须由 Runtime contract/E2E 证明。

Agent-to-Agent 的发布者证明、消息类别、scope/ACL、durable cursor、consumer receipt、ACK、重试和离线恢复以 [`agent-communication-and-feedback.md`](agent-communication-and-feedback.md) 为唯一真源；Context 只消费已经通过通信 owner 提交的事实和 projection，不自行确认消息或推进 Agent 状态。

## 2. 紧凑结构

字段只保存不能从父级、Journal 或配置推导的内容。每个 Slot 不重复保存 task、session、scope、permission、state、digest 或时间。

```ts
type ContextSlot = {
  id: ContextSlotId
  refs: AbsoluteSlotId[]
  payloadRef?: ContentRef
}

type ContextManifest = {
  version: 1
  prefixRef: PrefixRef
  activeSlots: ContextSlotId[]
  repairSlots?: ContextSlotId[]
  tail?: {
    data?: AbsoluteSlotId[]
    control?: AbsoluteSlotId[]
    memory?: AbsoluteSlotId[]
    toolReason?: AbsoluteSlotId[]
  }
  viewRevision: string
}
```

`ContextManifest` 不复制 Task/Session/Agent 身份。它由带有可信 Binding 的 Context Build Record 持有；`viewRevision` 指向已提交的 Context View，而不是任意客户端生成的字符串。

Context Slot 的状态由 View membership 推导：

```text
active      = 在当前 View 中
omitted     = 不在当前 View 中
superseded  = 被已接受的替代关系排除
compacted   = 被新的派生 View 合并
```

## 3. 消息组完整性

原生 Tool Call 和 Tool Result 必须保持协议完整。一个可重排的最小单元不是单个文本，而是消息组：

```text
Assistant Tool Call Group
  ├── Tool Call(callId=call-1)
  ├── Tool Call(callId=call-2)
  ├── Tool Result(callId=call-1)
  └── Tool Result(callId=call-2)
```

过滤失败分支时：

- 不能保留 Tool Result 而删除对应 Tool Call；
- 不能删除并行组中的一个结果后伪造原生消息序列；
- 不能把摘要 Slot 当作原生 Tool Result；
- 可以生成带 `sourceRefs` 的历史摘要 Slot；
- 最终 Prompt Renderer 必须校验 Call/Result 配对、消息顺序和工具 schema。

如果一个并行组无法安全拆分，则保留完整消息组，或生成明确标记为历史摘要的替代 Slot。

## 4. Path Resolution 和 Journal Projection

错误分支的替代关系通过独立 Journal Fact 保存，不给每个 Slot 添加反向状态字段。

```ts
type PathResolutionFact = {
  type: 'journal.path.resolved'
  pathId: string
  taskRef: string
  assignmentRef: string
  directiveRevision: number
  executionEpoch: number
  replaced: Array<{
    old: AbsoluteSlotId[]
    by: AbsoluteSlotId
  }>
  basis: 'accepted-result' | 'review' | 'user-confirmation'
  evidenceRefs: string[]
  owner: string
}
```

只保存不可推导的 `replaced` 关系。`effective` 集合由 Projector 根据 Journal 水位、替代关系、权限和当前约束推导，不同时保存 `effective`、`retained`、`superseded` 三组重复集合。

### 4.1 三种查询模式

```text
audit
  完整事实和分支，适合诊断、审计和 replay

effective-path
  当前有效的最短充分路径，过滤已被接受结果替代的噪声分支

compact-effective
  effective-path 的压缩结果，适合有限 Context 预算
```

`effective-path` 保留：

- 用户输入和当前有效约束；
- 成功路径所需的修正；
- 成功结果和验收证据；
- 仍然有效的失败、限制和 Attention。

它过滤：

- 已被同一 Assignment 的成功结果替代的失败调用；
- 已被新参数替代的错误请求；
- 不再影响任务的重复重试；
- 被新结果完全替代的中间输出。

### 4.2 Projection 只读且不改变 Journal

```ts
type JournalProjectionInput = {
  rootRef: string
  bindingRef: string
  bindingFingerprint: string
  mode: 'audit' | 'effective-path' | 'compact-effective'
  journalRevision: string
  detail: 'refs' | 'structured' | 'summary'
}

type JournalProjection = {
  viewRef: string
  sourceJournalRevision: string
  entries: ContextSlotId[]
  completeness: 'complete' | 'partial' | 'blocked'
  projectorVersion: string
}

interface JournalProjectionPlugin {
  select(input: JournalProjectionInput): ProjectionSelection
  order(selection: ProjectionSelection): OrderedJournalPath
  compact(path: OrderedJournalPath): CompactJournalPath
}
```

Projection 的顺序是：

```text
读取固定 Journal 水位
  → 消费已接受的替代关系
  → 保留必要因果祖先和有效约束
  → 删除已解决分支
  → 拓扑排序
  → 同层按 Absolute Slot 顺序排列
```

Projection 不写 Journal、不发 Attention、不创建 Checkpoint、不改变权限。只读查询不会因为查询本身产生新的 Journal Revision。只有 Context View 被实际采用并提交时，Committer 才记录构建事实。

`bindingRef` 由可信 Runtime Binding 解析；它不是可变路径，也不能直接作为缓存隔离依据。`bindingFingerprint` 是由领域 owner 生成的不可变指纹，覆盖 interaction/task 身份、Assignment、Directive Revision、Execution Epoch 以及影响路径选择的 Binding Revision。相同 Root、角色和权限但 Binding 不同，必须产生不同的 Projection Cache 命名空间。

## 5. Stable Prefix 和缓存边界

最终发送给模型的请求必须保持固定的字节顺序：

```text
Stable Prefix
  → Frozen History Slots
  → Repair Window
  → Current Tail
```

Stable Prefix 可以包含：

```text
Harness Contract
Agent Role
Prompt Template
Skill Bundle
Tool Schema Bundle
Permission Scope Version
Project Static Context
Task Static Context
Static Memory Index
Output Contract
Renderer Version
```

Stable Prefix 不得包含：

- 当前输入；
- 当前时间、turn、token 使用量；
- 当前 Tool Result；
- 动态 Memory Head；
- 当前 retry 次数；
- 当前 Operation 状态；
- 变化中的权限说明；
- 未冻结的 Repair 内容。

`prefixRef` 只能由规范化后的不可变内容生成。Renderer 必须以最终 messages、content blocks、tool definitions 的规范化结果作为缓存验证对象，不能只验证 Manifest digest。

### 5.1 缓存失效规则

```text
修改 Repair Window
  → 从首次修改位置开始使后缀失效

追加新的 Current Tail
  → 只使 Tail 失效

Tool Schema / Renderer Version 变化
  → 新建 Prefix Version

权限撤销
  → 旧授权命名空间不可继续发送

effective-path 重排
  → 只生成新的 View/Compact 版本
  → 不回写已经冻结的历史前缀
```

Provider 的真实缓存命中必须通过最终请求验证；本地 `prefixRef` 命中不能替代 Provider 证据。

## 6. Projection Cache 的授权隔离

Projection 和展开的 `sourceRef` 都必须检查当前授权。缓存键至少绑定：

```text
rootRef
bindingFingerprint
authorizedScope
permissionRevision
roleBinding
journalRevision
projectorVersion
mode
detail
```

权限撤销后，旧 Projection 不再具有发送资格，即使它仍然存在于缓存中。`sourceRef` 只负责定位，不自动授予读取权限。

## 7. Tool Result、Context Mapper 和 Committer

通用结构化 Tool Result 进入 Context 的顺序是：

```text
Operation started
  → Tool 执行
  → 原始 Result/Error 持久化并关联 Operation
  → Result Codec 校验
  → ToolResultContextMapper 生成 Projection
  → 持久化派生内容和 Context Commit Intent
  → 提交 Context View revision 到 Journal
  → 从已提交事实发布可用 View
```

```ts
interface ToolResultContextMapper {
  id: string
  version: string
  supports(input: ToolMappingInput): boolean
  map(input: ToolMappingInput): ToolContextProjection
}
```

Mapper 只返回数据 Projection 和映射诊断，不得：

- 重新调用 Tool；
- 直接写 Journal；
- 直接提交 Context View；
- 决定 Task 完成；
- 创建 Checkpoint；
- 发送 Attention；
- 修改权限或触发 steer。

Native turn 语义历史不要求为每个工具建立 `ToolResultContextMapper`，也不强制生成 `SemanticClaim[]` 或 `SemanticConstraint[]`。其唯一路径是当前 turn raw tool results 和 child decisions → 模型 authored `humanagent_turn_end` 四段 close 或 `humanagent_child_deliver` 精炼 child body → Runtime 校验 admitted scope、accepted evidence refs 与 adoption → Checkpoint/Control Owner 提交。prior turn 只投影已提交四段语义、可信 metadata、verified refs 和 adopted child deliveries；不得投影 prior raw body、call ID 或 child transcript。

ContextCommitter 只提交已经由 core/runtime 接受的 View revision，并绑定：

```text
operationRef
resultRevision
mapperVersion
expectedViewRevision
```

Commit Intent 必须先持久化，之后才进入“只重放 Commit”的恢复点。Intent 至少包含：

```text
commitId
operationRef
resultRevision
mapperVersion
bindingFingerprint
expectedViewRevision
projectionRefs
```

Context View 的可见性以已提交的 Journal View Fact 为准；内存中的“发布”只是可重建的派生动作：

```text
prepared
  → committed (Journal durable)
  → published (rebuildable notification/cache)
```

同一个 `commitId` 重试时，Committer 必须识别并返回已经提交的 View revision。真正的 `expectedViewRevision` 冲突交回 Runtime，不得把它当成新的 View。进程在 committed 和 published 之间崩溃时，恢复流程从已提交 View Fact 重新发布，并重新检查当前 Binding 和权限；权限已撤销时不得发送该 View。

### 7.1 崩溃重入

```text
Tool 成功，Mapper 失败
  → 保留 Tool 成功事实
  → 记录 context.mapping.failed
  → 修复 Mapper
  → 用同一 rawResultRef 重放 Mapper
  → 不重新执行 Tool

Mapper 完成，View 提交前崩溃
  → 若 Commit Intent 尚未持久化：用同一 rawResultRef 重跑纯 Mapper
  → 若 Commit Intent 已持久化：只幂等重试 Context View commit

View commit 完成，发布前崩溃
  → 读取已提交 View Fact
  → 重新检查 Binding/权限
  → 重建并发布 View，或记录不可发布状态

副作用是否发生未知
  → 交给 Operation Owner reconcile
  → 禁止盲目重新执行
```

## 8. 统一 Context Builder

Agent 不实现自己的 Context 结构。Host 锁定一个 Builder 版本，Agent Profile 只提供配置：

```ts
type AgentProfileConfig = {
  profileVersion: string
  roleRef: string
  promptRef: string
  skillBundleRef: string
  toolBundleRef: string
  scopeRef: string
  memoryPolicyRef: string
  contextPolicyRef: string
  outputContractRef: string
}
```

固定 Builder 阶段：

```text
resolveProfile
→ validateProfile
→ resolveVersionedRefs
→ resolvePermissionScope
→ buildStablePrefix
→ resolveStaticMemoryIndex
→ selectContextSlots
→ applyRepairWindow
→ resolveDynamicMemoryHead
→ appendCurrentTail
→ enforceBudgetAndOrdering
→ compilePrompt
→ persistContextBuildEvidence
```

Agent 只能配置 Role、Prompt、Skill、Tool、Scope、Memory Policy、Context Policy 和 Output Contract，不能替换阶段、跳过权限、改变 Slot 结构或选择另一个 Builder。

## 9. Interaction Binding 和 Task Binding

Context 构建必须支持用户确认前的交互 Agent：

```ts
type ContextBinding =
  | {
      kind: 'interaction'
      interactionScopeId: string
    }
  | {
      kind: 'task'
      taskId: string
      assignmentId: string
      executionEpoch: number
    }
```

交互 Agent 不得为了满足 Memory API 强制创建伪 Task。用户确认后，Harness 创建 Task Binding，并以新的 Context View 装配后台 Agent。

现有只接受 `taskId` 的 Agent Start、Agent Input 和 Memory Context 接口必须迁移到这个判别式 Binding；task-bound 路径继续要求 Assignment 和 Execution Epoch，interaction-bound 路径不得补造 Task。迁移完成前，旧接口不能被宣称为完整支持 interaction Agent。

## 10. 保留和清理

Absolute Journal 的事实及其原始内容引用构成保留根：

```text
Journal Fact
  → Artifact Ref
  → 原始内容或可验证归档
```

允许清理：

- 可重建 Index；
- Cache；
- 已被新 View 替代的 Context Slot；
- 无引用的派生 Projection；
- 可从 Journal 重建的窗口数据。

允许无损归档或迁移 Journal 和原始资产，但必须保持 Absolute Slot 和原始内容可解析。不能出现“Journal ID 仍在、事实内容已经不可读取”的状态。

## 11. 唯一 Owner

| 模块 | 唯一责任 |
|---|---|
| Journal Adapter | 追加、顺序、链校验、资产引用完整性 |
| Core/Runtime | 接受结果、替代证据、权限、Epoch、Operation、Attention、Checkpoint |
| Journal Projector | 按固定水位选择和排序只读 View |
| Memory Backend | 授权范围内的索引、召回和比较 |
| ContextBuilder | 统一预算、Slot 选择和上下文装配 |
| ContextCommitter | 幂等提交已批准的 Context View |
| Native Turn Semantic Projection | `packages/runtime/src/context/`：投影当前 turn 装配、四段 checkpoint 历史、verified refs 与 adopted child refined deliveries；不执行工具 |
| Explicit Brain Interaction Turn Checkpoint | `packages/runtime/src/explicit-brain/interaction-turn-session.ts`：构造 Explicit Brain interaction turn checkpoint；不建立第二套 native semantic-history owner |
| Structured Tool Projection | 仅在具体 adapter/runtime owner 声明的结构化数据场景执行 Tool Result 到 Projection 的纯映射；不是 native 四段语义的必需通用层 |
| Prompt Renderer | Provider/DSH 请求格式编码和最终消息校验 |
| Plugin Host | 版本锁定、唯一绑定、加载、启动和释放 |

可替换插件不能通过替换实现扩大端口职责。

## 12. 固定审查样例

Context Contract 必须能回答以下样例：

1. 并行 Tool 一成功一失败：不能产生孤立 Call 或 Result。
2. 旧 Execution Epoch 成功：不能替代当前 Epoch 的失败。
3. Mapper 完成但 View 提交前崩溃：Intent 未持久化时只重跑纯 Mapper；Intent 已持久化时只重放 Commit；两种情况都不重做 Tool。
4. 同 Root、同权限、同角色但不同 Binding：不得错误复用 Projection Cache。
5. 权限撤销后命中 Projection Cache：旧内容不得发送。
6. Repair 修改 Stable Prefix：从首次修改处开始后缀失效，前缀保持可复用。
7. Compact 后查询 Absolute Slot：完整原始事实仍可读取。
8. `waiting`/`failed` Checkpoint：不能被标记为有效完成路径。
9. 交互 Agent 尚无 Task：使用 `interaction` Binding，不创建伪 Task。
10. Commit Intent 已持久化但进程崩溃：恢复只提交同一 View，不重新执行 Tool。
11. View 已提交但未发布：恢复可重新发布，并重新检查权限。
12. `humanagent_turn_end` 的四段 summary 是模型 authored 语义材料；只有 standard turn 与 Checkpoint/Control Owner 校验并 durable commit 后，才进入 prior-turn semantic history。普通 end-turn/stop control summary 不自动生成 Context Slot。
13. `memory.learned` 只由 Memory Owner 建立 index；Tool `reason` 由 Tool Owner 生成紧凑 `ToolReasonProjection` 后才可进入下一轮 Context，原始控制字段不进入。
14. 当前 turn 可保留 raw tool calls/results；prior turn 只保留四段语义、trusted checkpoint metadata、verified evidence refs 和 adopted child refined deliveries，不保留 prior raw body、call ID 或 child transcript。

## 13. 进入下一阶段的条件

本契约通过独立 Astra review 后，才开始 Agent 基础框架设计。下一阶段的输入/输出设计必须复用本文的：

- ContextBinding；
- Tool Call/Result 消息组；
- Result Mapper → Committer → View 的顺序；
- Stable Prefix/Repair/Tail 缓存边界；
- Journal Projection 和 source refs；
- 统一 ContextBuilder；
- Plugin Host 的版本和权限边界。
