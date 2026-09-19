# Agent Context Contract

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

模型在 end-turn/stop 返回的 `summary`、`goal`、`blocked`、`next`、`checkpoint proposal`、`completion proposal` 和 `memory.learned` 都属于控制面。它们被 Decoder 解析后发布事件，不直接成为 Context Slot，也不自动拼回下一轮 Prompt。Tool `reason` 同样属于控制面，但 Tool Owner 可以把它转换成专门的紧凑 `ToolReasonProjection`，供下一轮推理参考。

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

Tool 结果进入 Context 的固定顺序是：

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
| Tool Mapper | Tool Result 到数据 Projection 的纯映射 |
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
12. end-turn/stop 的 Control summary 被解析并发事件，但不生成 Context Slot。
13. `memory.learned` 只由 Memory Owner 建立 index；Tool `reason` 由 Tool Owner 生成紧凑 `ToolReasonProjection` 后才可进入下一轮 Context，原始控制字段不进入。

## 13. 进入下一阶段的条件

本契约通过独立 Astra review 后，才开始 Agent 基础框架设计。下一阶段的输入/输出设计必须复用本文的：

- ContextBinding；
- Tool Call/Result 消息组；
- Result Mapper → Committer → View 的顺序；
- Stable Prefix/Repair/Tail 缓存边界；
- Journal Projection 和 source refs；
- 统一 ContextBuilder；
- Plugin Host 的版本和权限边界。
