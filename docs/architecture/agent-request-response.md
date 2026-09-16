# Agent Request / Response Contract

状态：`DESIGN-CANDIDATE / AGENT-IO-CONTRACT-V1`

本文在 [`context-contract.md`](context-contract.md) 通过 Astra 设计复审后，定义 Agent 的请求、响应、事件、流式结果、Tool 协同和错误闭环。

本文只定义 HumanAgent 的 Provider-neutral Agent I/O。Responses、Anthropic、DSH、MCPX 和其他执行后端必须通过 Adapter/Renderer 接入，不能把其 Session、Event 或消息类型提升为高层身份。

## 1. 核心边界

```text
HumanAgent Runtime
  ├── Agent Request Compiler
  ├── Agent Driver Port
  ├── Agent Response Decoder
  ├── Agent Result Mapper
  └── Journal / Context Committer
        │
        ├── DSH Adapter
        ├── Responses Adapter
        ├── Anthropic Adapter
        └── Fake / Replay Adapter
```

Agent 请求和响应不是 Session：

| 对象 | 责任 | 是否是高层事实 |
|---|---|---|
| `RequestId` | 标识一次逻辑 Agent 工作请求 | 是 |
| `AttemptId` | 标识一次请求尝试 | 是 |
| `OperationId` | 标识一次 Tool/外部副作用操作 | 是 |
| `ContextViewRef` | 标识发送时使用的上下文视图 | 是 |
| `SessionId` | Provider/Driver 的传输或会话标识 | 仅是 Evidence Ref |
| Event Bus Event | 推动状态和数据变化 | 是，需进入 Journal 或可重建投影 |

同一个 Agent Request 可以跨多个 Provider Session 恢复。Provider Session 不能替代 Request、Task、Assignment 或 Checkpoint。

## 2. 控制面与数据面

每个 Envelope 分成两块：

```text
control
  生命周期、Binding、权限版本、相关性、幂等和恢复信息

data
  用户输入、Agent 输出、Tool 结果、证据和业务交付引用
```

控制字段不得写入业务 payload、Prompt metadata、模型文本或 Tool 业务 JSON 后再重建。业务结果也不能伪装成控制成功。

### 2.1 共享请求头

```ts
type AgentBinding =
  | {
      kind: 'interaction'
      interactionScopeId: string
      bindingFingerprint: string
    }
  | {
      kind: 'task'
      taskId: string
      assignmentId: string
      executionEpoch: number
      bindingFingerprint: string
    }

type AgentProviderBinding = {
  bindingId: string
  providerId: string
  protocol: string
  endpointRef: string
  modelRef: string
  configDigest: string
  capabilityDigest: string
  owner: string
}

type AgentRequestControl = {
  protocolVersion: 1
  requestId: string
  attemptId: string
  binding: AgentBinding
  providerBinding: AgentProviderBinding
  contextViewRef: string
  permissionRevision: string
  idempotencyKey: string
  replyMode: 'terminal' | 'stream'
}
```

`bindingFingerprint` 必须来自可信 Runtime Binding，不能由 Agent 或 Provider 自己生成。`providerBinding` 是准入后锁定的控制字段，不是业务 payload；它必须属于当前 Agent Runtime，且在同一 execution epoch 内保持不变。`contextViewRef` 必须是已经提交且授权可读的 Context View。

Provider/model 的选择由 Harness/config owner 在 admission 时完成。切换必须创建新的 `bindingId`、重新验证 capability/permission/readiness，并进入新的 execution epoch；响应、prompt、Tool Result 和 ACP update 都不能覆盖 `providerBinding`。`endpointRef` 只引用外部配置，HumanAgent 不复制 endpoint secret 或修改外部配置。

请求不重复保存 `taskId`、`assignmentId`、`executionEpoch` 到每一个 input slot；它们只在 Control Header 出现一次。

模型产生的 Control Block 也不是 Harness 已接受的控制状态。它是模型根据请求中注入的 Control Contract 返回的控制提案，必须经过 Decoder、Control Gate 和现有 Core/Runtime owner 判定后，才能推动生命周期。

## 3. Control Contract 和 Control Block

### 3.1 请求注入的 Control Contract

Harness 在每次 Agent Request 的系统指令层注入一个版本化的 Control Contract。它描述模型在什么控制探针点返回什么内容，但不绑定某个 Provider 的 `response_format`、message block 或 tool-call 类型。普通推理响应可以没有 Control Block；控制探针点才要求控制语义。

```ts
type ControlProbePoint =
  | 'request-start'
  | 'after-tool-result'
  | 'before-wait'
  | 'before-checkpoint'
  | 'before-completion'
  | 'after-n-turns'
  | 'on-no-progress'

type ControlProbePolicy = {
  probeOn: readonly ControlProbePoint[]
  maxTurnsBetweenProbes: number
  maxControlRepairAttempts: number
}

type ControlContract = {
  schemaVersion: 1
  probePolicy: ControlProbePolicy
  requiredAtEndTurn: readonly ['summary']
  requiredAtProbe: readonly ['summary']
  requiredWhen: {
    blocked: readonly string[]
    waiting: readonly string[]
    checkpoint: readonly string[]
    completion: readonly string[]
  }
  optional: readonly [
    'turnRef',
    'phase',
    'goal',
    'next',
    'checkpoint',
    'completion',
    'memory',
    'skillCandidate'
  ]
}
```

系统指令只要求模型遵守高层语义：

```text
普通推理可以先返回业务结果、Tool 请求或阶段进展；不在 end-turn/stop 边界时可以不返回 Control Block。
每个 end-turn/stop 必须返回一个 summary；到达控制探针点时，在 summary 中尽量返回当前阶段、目标状态、阻塞情况和建议的下一步。
缺少必要信息时声明 missing，不得假装完成。
需要用户选择时声明 waiting-user，并给出选项。
准备结束时声明 completion-proposed，不得把提案写成已接受完成。
EOF 只表示本次 Provider 输出结束，不表示 Agent 或 Task 完成。
```

Provider Adapter 再把这个 Contract 渲染成它支持的形式：

```text
ControlContract
  → Prompt Renderer
  → Provider-specific instruction / structured-output hint / tagged text
```

这里的 schema 是对模型的输出要求和解析提示，不是把模型当成可靠协议端点的拦截器。模型返回不完整时，Decoder 尽量提取可用字段并标记 `partial`；只有缺少 end-turn/stop 的 `summary` 或触发安全/权限 Gate 时，才进入对应的修复或拒绝路径。

高层 Request 不包含 Provider-specific 的 `response_format`、`tool_choice`、Anthropic content block 或 DSH event 类型。

### 3.2 模型返回的 Control Block

```ts
type ControlDisposition =
  | 'continue'
  | 'checkpoint-proposed'
  | 'waiting-user'
  | 'waiting-operation'
  | 'blocked'
  | 'failed'
  | 'completion-proposed'
  | 'stop-ack'

type AgentControlBlock = {
  // end-turn / stop 的唯一硬性语义字段
  summary: string
  schemaVersion?: 1
  turnRef?: string
  phase?: string
  disposition?: ControlDisposition
  goal?: {
    status: 'in-progress' | 'complete' | 'blocked' | 'unknown'
    evidenceRefs?: string[]
    missing?: string[]
  }
  blocked?: {
    reason: string
    owner?: string
    resumeCondition?: string
  }
  next?: {
    kind: 'reason' | 'tool' | 'wait' | 'ask-user' | 'review' | 'stop' | 'close'
    objective: string
  }
  checkpoint?: {
    disposition: 'none' | 'propose' | 'waiting' | 'blocked'
    checkpointRef?: string
    evidenceRefs?: string[]
  }
  completion?: {
    deliverableRefs: string[]
    evidenceRefs: string[]
    acceptanceRefs?: string[]
  }
  memory?: {
    learned: Array<{
      kind: 'fact' | 'lesson' | 'dead-end' | 'preference' | 'skill-candidate'
      title: string
      summary: string
      sourceRefs?: string[]
      tags?: string[]
    }>
  }
  repair?: {
    target: string
    reason: string
    requestedFields: string[]
  }
}
```

Control Block 是模型的语义声明，不是模型直接写入的 Runtime 状态。Harness 只接受通过 schema、引用、Binding、权限和阶段规则的部分。

兼容性规则是：`summary` 在 end-turn/stop 时必需；其余控制字段允许缺省、未知或仅部分返回。缺省字段必须在 Decode 结果中显式标记为 `absent`/`unknown`，不能静默补成成功、继续或无阻塞。

这些字段属于控制面，不直接进入 Agent Context：

```text
Provider response
  → ControlBlockCodec 解析
  → 发布 control / summary / memory-candidate / tool-intent event
  → 各自 owner 建立状态、Memory index、Operation 或 Attention
```

Control Block、summary 和 memory candidate 不作为 Context Slot，也不自动拼回下一轮 Prompt。Tool reason 是唯一的专门例外：Tool Owner 可以把它转换成短的 `ToolReasonProjection`，作为下一轮推理的紧凑参考；原始控制块仍不进入 Context。UI 和 Memory Owner 同时通过事件读取同一 reason，不各自猜测或复制。

其中 `goal.status = complete` 只是模型提案；只有 `TaskCompletionGate` 通过后才能产生 Runtime 的完成事实。`goal.status = blocked` 也不等于错误终态，必须尽量保留 owner 和可恢复条件。

## 4. Provider-neutral Control Codec

Control Block 通过独立 Codec 插件在模型响应和高层类型之间转换：

```ts
interface ControlBlockCodec {
  decode(input: ProviderResponseEvidence): ControlDecodeResult
}

type ControlDecodeResult =
  | {
      status: 'valid'
      block: AgentControlBlock
      sourceRef: string
      completeness: 'complete' | 'partial'
      absentFields: string[]
    }
  | {
      status: 'missing' | 'malformed' | 'multiple-conflicting'
      sourceRef: string
      diagnostics: string[]
    }
```

Codec 可以支持不同 Provider 的输出方式：

```text
Provider native structured output
  → ControlBlockCodec

Strict tagged JSON/text block
  → ControlBlockCodec

DSH session event
  → DSH Response Decoder
  → ControlBlockCodec
```

高层只接收 `AgentControlBlock` 或明确的 decode failure。它不读取 Provider 原生 block 类型。

一个响应轮次默认只接受一个最终 Control Block。流式过程可以有多个 progress 片段，但最终片段必须能归并成一个无冲突的 Control Block；冲突时进入协议修复，不由最后一个片段静默覆盖前一个。

## 5. Control Cadence 和退出机制

Control Contract 规定模型在控制探针点应反馈的内容；Harness 通过独立 Watchdog 规定它最多运行多久、多少轮和多少次修复。模型不反馈不能让 Runtime 无限等待，也不能因为普通响应没有 Control Block 就立刻判定协议失败。

```ts
type ControlWatchdogPolicy = {
  maxSilentDurationMs: number
  maxTurnDurationMs: number
  maxTotalTurns: number
  maxTurnsBetweenProbes: number
  maxNoProgressTurns: number
  maxControlRepairAttempts: number
}
```

Watchdog 属于控制面，不注入业务 payload，也不依赖模型自报时间。每个逻辑响应的 `end-turn`/`stop` 都必须有 summary；控制探针再要求更具体的控制语义。至少有以下反馈边界：

| 边界 | 必须反馈 | 用途 |
|---|---|---|
| 普通推理轮结束 | `summary`；其他 Control 字段可缺失 | 允许继续，不判定完成 |
| Tool Result 收到后 | 当前阶段、结果处理方式、下一步 | 控制探针，防止结果被遗忘 |
| 进入等待前 | 等待条件、owner、恢复事件 | 控制探针，形成可恢复等待 |
| 提议 Checkpoint 前 | 目标状态、下一步、恢复状态、证据引用 | 机械检查和提交 |
| 提议完成前 | 目标状态、交付引用、证据引用、验收引用 | 进入完成 Gate |
| 失败或阻塞时 | 影响、缺失项、owner、下一动作 | 控制探针，保留恢复责任 |

控制探针的 `probeRef`、触发原因和当前 `turnRef` 由 Runtime 保存。模型不能通过文本自行声明“本轮是探针”来降低或绕过探针策略。

### 5.1 Control Block 缺失和修复

先区分“普通响应缺少控制字段”和“end-turn/stop 缺少 summary”。普通响应在探针之外允许没有完整 Control Block，但 end-turn/stop 仍必须有 summary：

```text
保存普通业务输出/Tool Intent/证据
  → 若 summary 存在，记录缺失的可选字段为 control.field-absent
  → 若仍在响应中间，允许继续
  → 若已到 end-turn/stop 但 summary 缺失，记录 control.summary-missing 并进入有限修复
  → 无论哪种情况，都不把普通文本的完成措辞当作完成
```

控制探针点没有可用 summary、无法解析或出现互相冲突的多个 Block 时：

```text
保存原始响应
  → response.control-missing / malformed / conflicting
  → 生成结构化修复请求
  → 保持同一逻辑 Request，增加 controlRepairOrdinal
  → 要求只补齐 summary 和探针所需字段，不重复执行已完成 Tool
```

修复请求必须明确：

```text
缺少哪些字段
当前已保存哪些业务结果
哪些 Operation 已完成或未知
  本轮允许补什么
```

修复只允许在当前探针上进行，不能借修复请求无限延长推理。修复次数达到 `maxControlRepairAttempts` 后：

- 没有未收拢副作用：写入 `protocol-noncompliant`，提交不完整 Checkpoint，停止该请求；
- 有未知副作用：写入 `unknown`，由 Operation Owner reconcile，再执行标准停止/等待操作；
- 有必要的用户决策：生成 Attention，进入 `waiting-user`；
- 不得不断追加修复 Prompt 形成隐式循环。

### 5.2 没有响应或没有进展

以下情况由 Harness 判断，不依赖模型 Control Block：

```text
超过 maxSilentDurationMs 没有事件
  → requestStop
  → settle/reconcile
  → stopped / unknown Checkpoint

超过 maxTurnDurationMs
  → 同上

超过 maxTotalTurns
  → 不再创建新推理轮

连续 maxNoProgressTurns 没有新的可验证输出、Tool Result 或阶段变化
  → 生成 Attention
  → 修复一次或停止

超过 maxTurnsBetweenProbes
  → 触发控制探针
  → 要求 summary，并尽量补齐 goal / blocked / next
  → 仍不遵从则进入 protocol-noncompliant

Provider EOF
  → 仅记录 response.transport-ended
  → 按当前是否处于控制探针、输出是否已持久化、Operation 是否未知继续判定
  → 不能直接产生 Agent completed、Task completed 或 Checkpoint committed
```

“没有进展”只能根据可观察事实判断：新 Journal/Artifact/Operation Result、阶段变化、有效 Context View 或已确认的外部状态。Harness 不对自然语言质量做语义猜测。

### 5.3 Optional 和 Required

end-turn / stop 强制项：

```text
summary
```

控制探针建议项（兼容性宽松，不因缺失直接判定失败）：

```text
turnRef
phase
goal.status
next.kind
next.objective
```

模型显式返回某个状态时，按状态校验相关字段；没有返回该状态时，不要求模型补一个无意义的状态：

```text
blocked             → reason、owner（如已知）、resumeCondition
waiting-user        → 问题、选项、等待 owner
waiting-operation   → operationRef、恢复条件
checkpoint.propose  → checkpointRef（如已有）、evidenceRefs
completion-proposed → deliverableRefs、evidenceRefs
failed              → 影响、缺失项或 errorRef、owner、next
```

普通响应中 Control Block 可以完全缺失，但在 end-turn/stop 必须有 `summary`。summary 内的自然语言说明是必需的；详细推理说明、指标和 `memory.learned` 可选。探针建议项缺失只记录 warning/unknown；summary 缺失才进入协议修复。

## 6. Checkpoint 和 Task Completion Gate

Checkpoint 是可重入的执行入口，不是普通状态快照，也不是任务完成标记。它表示：当前状态已经持久化，有可确认进度，恢复状态可读取，且存在明确的下一步入口。Checkpoint 的规则、读写、回退和重入必须由 HumanAgent 内置工具完成；模型只能调用工具并提供语义材料，不能靠 Control Block、普通文本或 Provider 私有接口伪造 Checkpoint。模型负责提出语义判断，Harness 负责机械验证和生命周期收口。两者不能混成一个 Gate。

```ts
type ReentryCheckpoint = {
  checkpointId: string
  taskRef: string
  assignmentRef: string
  directiveRevision: number
  executionEpoch: number
  validProgressRefs: string[]
  recoveryStateRef: string
  contextViewRef: string
  openConditions: string[]
  pendingOperations: string[]
  unknownOperations: string[]
  reentry: {
    allowed: boolean
    entryPhase: string
    nextAction: string
  }
  memoryRefs: string[]
  evidenceRefs: string[]
}
```

### 6.0 内置 Checkpoint 工具

所有可执行 Agent 都由 Harness 注入同一组内置工具；工具是否可见、可调用由 Agent Profile 和当前权限决定，但不能被外部 Provider 替换成另一套 checkpoint 语义。

```ts
type BuiltInCheckpointTools = {
  'checkpoint.inspect': (input: {
    taskRef: string
    assignmentRef?: string
    includeInvalid?: boolean
  }) => Promise<{
    candidates: string[]
    currentCheckpointRef?: string
  }>

  'checkpoint.recall': (input: {
    checkpointRef: string
    reason?: string
  }) => Promise<{
    recoveryStateRef: string
    contextViewRef: string
    entryPhase: string
    nextAction: string
  }>

  'checkpoint.save': (input: {
    progressRefs: string[]
    nextAction: string
    openConditions?: string[]
  }) => Promise<{
    checkpointRef: string
    outcome: 'committed' | 'waiting' | 'blocked' | 'rejected'
  }>

  'checkpoint.record-dead-end': (input: {
    conclusion: string
    invalidatedAssumptions: string[]
    evidenceRefs: string[]
    suggestedAlternatives?: string[]
  }) => Promise<{
    deadEndRef: string
    memoryEventRef: string
  }>

  'checkpoint.reenter': (input: {
    checkpointRef: string
    deadEndRef?: string
    memoryRefs?: string[]
  }) => Promise<{
    executionEpoch: number
    contextViewRef: string
    reentryRef: string
  }>
}
```

工具调用的实际闭环是：

```text
Agent Tool Intent
  → built-in capability admission
  → Operation started
  → Core/Runtime Checkpoint Owner 校验
  → Journal / recovery state / Context View 持久化
  → Operation Result
  → checkpoint event
```

`checkpoint.save` 返回 `rejected` 时不能把模型声明当作 Checkpoint；`checkpoint.reenter` 必须创建新的执行分支或 Epoch，不能删除旧探索路径。工具不可用、权限不足或模型不知道如何调用时，必须产生明确的 Tool/Capability/Attention 错误，不得退化成“只在 Prompt 里记得 checkpoint”。

上述工具只代表 `agent-tool` 来源。Watchdog、权限撤销、stop/cancel 和宿主恢复分别使用同一 Checkpoint/Control Owner 的 `harness-control` 或 `recovery` 入口；它们不得直接追加 checkpoint 记录。五个工具与两类控制入口共享同一 scope/epoch/permission 校验、`checkpointCommitId` 幂等键和 commit-before-publish 顺序，详见 [`context-contract.md`](context-contract.md) §1.5。

模型失联、修复耗尽、权限撤销、重启和 interaction cancel 的 closure 由该统一入口决定：停止或未知副作用先由 Operation Owner settle/reconcile，interaction 只提交 `InteractionClosure`，不补造 Task checkpoint；`committed` 也不等于 `reentryAllowed`。

Checkpoint 的提交条件必须拆成“事实收拢条件”和“可重入条件”。失败、撤权和未知副作用可以提交准确的 closure fact，即使当前不能重入。

事实收拢条件：

```text
状态已经持久化
  + recoveryState 和必要引用可读取
  + closure reason / next action 已明确
  + 未完成/未知副作用已显式登记
  + 若为 task-bound，Task / Assignment / Directive / Epoch 可校验
```

候选 Checkpoint 的可用条件是：

```text
recoveryState 和 Context View 可读取
  + 当前 binding / permission / resource admission 仍有效
  + 没有未收拢的 unknown operation
  + 下一入口允许从该阶段开始
```

`Checkpoint committed` 只表示事实已收拢并持久化，不表示可重入，也不表示完成。`waiting`、`blocked`、`stopped` 和 `unknown` 可以提交不可重入的 closure。候选通过上述条件后，唯一 Checkpoint Owner 执行 `reenter`：创建新 execution epoch、fence 旧 epoch、提交 reentry fact；只有该提交成功后，新的 branch 才拥有 `reentryAllowed=true`。权限撤销和未知副作用必须能够提交 `reentryAllowed=false` 的准确记录。

### 6.1 Checkpoint Proposal

模型可以在 summary 中返回一个可选的语义提示：

```text
checkpoint.disposition = none | propose | waiting | blocked
```

这个字段只用于 UI/Memory/Runtime 的事件参考，不能创建 Checkpoint，也不能触发提交。真正的 checkpoint proposal 必须来自内置工具：

```text
Agent
  → checkpoint.save / checkpoint.record-dead-end / checkpoint.reenter
  → built-in Checkpoint Owner
  → CheckpointGate
```

`checkpoint.save` 的输入和工具结果才是 `CheckpointGate` 的检查对象，至少检查：

```text
Control Block schema 合法
Binding / Epoch 仍匹配
required refs 存在且当前授权可读
相关 Tool/Operation 已完成，或已明确标为 unknown
recoveryState 满足当前阶段要求
没有未处理的强制 missing 项
```

通过后才执行：

```text
checkpoint.save Operation accepted
  → append checkpoint.proposed/accepted
  → persist recovery state
  → append checkpoint.committed
```

### 6.2 死路记录和 Checkpoint 回退

探索路径被确认是死路时，不删除或覆盖原分支，也不把整段失败上下文带回新一轮。固定顺序是：

```text
当前探索
  → 追加全部可审计事实到 Absolute Journal
  → 调用内置 `checkpoint.record-dead-end`
  → 由工具创建 DeadEndRecord 并发布 memory-candidate event
  → 枚举同一 Task/Assignment 下可用 Checkpoint
  → 过滤已失效、无权限、不可读取或不满足候选条件的候选
  → 选择最佳 Checkpoint
  → Checkpoint Owner 创建新的 branch / execution epoch 并 fence 旧 epoch
  → 提交 reentry fact（失败则保持 committed + reentryAllowed=false）
  → 装配 Checkpoint Reentry Context
  → 注入 dead-end memory summary/index
  → 重新进入推理
```

```ts
type DeadEndRecord = {
  taskRef: string
  assignmentRef: string
  sourceBranchRef: string
  failedPathRefs: string[]
  conclusion: string
  invalidatedAssumptions: string[]
  evidenceRefs: string[]
  memoryRef?: string
  suggestedAlternatives?: string[]
}
```

Memory 和 Journal 是两个不同职责：Journal 保留完整事实，Memory 保存可召回的死路结论、失效假设和替代方向。Checkpoint 回退后的 Context 只带：

```text
Checkpoint recovery state
  + reentry entry / next action
  + dead-end memory summary/index
  + 当前控制探针要求
```

不重新加载完整失败 transcript；需要细节时，通过已授权的 Journal/Memory index 查询。任何已有副作用在重新进入前必须由 Operation Owner settle 或 reconcile，不能因为回退而重做未知操作。

最佳 Checkpoint 不是简单取最新一个。候选必须属于同一 Task/Assignment、Directive Revision 兼容、权限有效、Recovery State 可读、允许重入且没有被后续事实失效；排序为：

```text
1. 位于死路之前且距离最近
2. 已确认有效进度最多
3. 未解决条件最少
4. 没有 unknown Operation
5. Directive / Epoch 兼容
6. 下一步入口最明确
```

Runtime/Checkpoint Owner 最终选择候选；模型只能建议，不能自行决定回退点。

### 6.3 Task Completion Proposal

模型返回：

```text
disposition = completion-proposed
```

`TaskCompletionGate` 只做可验证的机械判定：

```text
deliverableRefs 存在且可读
evidenceRefs 存在且与当前 Binding/Assignment 相关
required Operations 已 settle 或按策略明确结束
必要的可重入 Checkpoint 已 committed
没有未处理的强制 Attention
Assignment 的 review/user approval policy 已满足
```

如果项目策略要求 Review 或用户批准：

```text
completion-proposed
  → completion-pending-review / completion-pending-user
  → review/approval
  → task.completed
```

如果策略不要求额外批准且机械 Gate 通过，Runtime 可以提交 `task.completed`。这仍然表示“模型提出的语义结果通过当前策略和证据门”，不是 Harness 自己证明了自然语言内容正确。

如果 Control Block 缺失、证据缺失或 Gate 不通过：

```text
completion-proposed
  → completion-repair-required
  → 下一轮只补缺失内容
```

不允许把 Agent 普通文本中的“完成了”当作 Task Completion。

## 7. Agent Request

```ts
type AgentRequestEnvelope = {
  version: 1
  control: AgentRequestControl
  data: {
    inputRefs: string[]
    outputContractRef: string
    capabilitySetRef: string
    memoryRecallRefs?: string[]
  }
}
```

`inputRefs` 指向已经提交的 Journal/Artifact/Context Slot。小型、非敏感、不会成为事实的协议参数可以由 Renderer 内联；需要审计的输入必须先落 Journal，再只传引用。

Agent Request 不包含：

- Provider Session ID；
- 当前模型名称作为业务身份；
- retry/degrade/steer 控制字段；
- 未验证的权限声明；
- Tool 的私有传输格式；
- 另一个 Agent 的完整 Session transcript；
- 未授权的全局 Memory。

### 7.1 请求准入

Runtime 在发给 Driver 前按固定顺序执行：

```text
resolve Request
  → validate Binding / Epoch
  → validate Context View / permission
  → validate Profile / capability set
  → validate Input refs / output contract
  → reserve resource lease
  → append request.admitted
  → dispatch to Agent Driver
```

任何准入失败都不调用 Provider，并产生带 owner 的显式错误：

```text
request.invalid
request.binding-revoked
request.context-unavailable
request.capability-denied
request.resource-unavailable
```

## 8. Agent Response

Agent Response 是 Provider-neutral 的处理结果，不直接代表 Task 完成。

```ts
type AgentResponseStatus =
  | 'accepted'
  | 'running'
  | 'waiting-confirmation'
  | 'waiting-input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'

type AgentResponseEnvelope = {
  version: 1
  control: {
    requestId: string
    attemptId: string
    status: AgentResponseStatus
    sequence?: number
    cursor?: string
    operationRefs?: string[]
    nextAction?: 'observe' | 'confirm' | 'resume' | 'reconcile' | 'settle'
  }
  proposal?: {
    controlBlock: AgentControlBlock
    sourceRef: string
  }
  data: {
    outputRefs?: string[]
    evidenceRefs?: string[]
    toolIntentRefs?: string[]
    attentionDraftRefs?: string[]
    contextProjectionRef?: string
  }
}
```

约束：

- `completed` 表示本次 Agent 请求已经产生并保存可消费的输出，不代表整个 Task 完成；
- 没有 end-turn/stop `summary` 时，Response 不能按正常完成收口；只能进入 summary 修复、Watchdog 停止或 unknown/reconcile；
- Task 是否完成由 Core/Runtime 根据交付要求和 Checkpoint 判定；
- `failed` 必须保留原始错误引用和 owner；
- `unknown` 表示结果或副作用尚未确认，不能被转换成 `failed` 或 `completed`；
- `waiting-confirmation` 只能表示已生成等待确认的 Operation/Attention，不等于用户已批准；
- `contextProjectionRef` 只能引用 Mapper 已生成的 Projection，不能绕过 Committer；
- `toolIntentRefs` 是请求 Tool 的数据引用，不能直接执行 Tool。

## 9. 请求和响应生命周期

### 9.1 正常请求

```text
request.created
  → request.admitted
  → request.dispatched
  → agent.started
  → agent.output.received
  → response.decoded
  → result.mapped
  → context.intent.persisted
  → context.view.committed
  → response.delivered
  → request.settled
```

每一步都可以被恢复。`request.settled` 只能在响应数据、Context View 和必要的 Operation 结果已达到各自提交条件后产生。

### 9.2 流式请求

流式输出分为临时 Delta 和可提交结果：

```text
agent.delta.received
  → agent.delta.projected (optional, ephemeral)
  → agent.output.received
  → response.decoded
```

Delta 默认不逐 token 写入 Absolute Journal。需要审计的阶段性输出由 Adapter/Runtime 按策略合并为可重放的 Artifact 或 Journal Slot。不能把未完成 Delta 当成最终 Agent Result。

流式事件必须包含：

```text
requestId
attemptId
sequence or cursor
source revision
```

重复事件按 `requestId + attemptId + sequence/cursor` 去重；缺口进入 `stream-gap`，不能静默拼接。

## 9.3 Request/Response 生命周期 Hook

Request 和 Response 的每个关键阶段都进入统一 Hook 链。Hook 有两个用途：

1. 产出 Event Bus 事件，让 UI 显示真实阶段进度；
2. 在阶段入口和出口对已拥有的数据做校验、派生、映射和处理。

Hook 不是第二套生命周期，也不能直接提交 Task、Checkpoint、权限或成功状态。它只能通过所属 Owner 的 typed port 返回派生结果或明确错误。

```ts
type AgentHookStage =
  | 'request.created'
  | 'request.admitted'
  | 'request.before-dispatch'
  | 'request.dispatched'
  | 'attempt.started'
  | 'prompt.rendered'
  | 'response.received'
  | 'response.decoded'
  | 'control.decoded'
  | 'tool-intent.decoded'
  | 'result.mapped'
  | 'context.committed'
  | 'checkpoint.recalled'
  | 'checkpoint.proposed'
  | 'checkpoint.committed'
  | 'request.settled'

type AgentHookResult = {
  status: 'observed' | 'derived' | 'waiting' | 'failed'
  outputRefs?: string[]
  eventRefs?: string[]
  diagnostics?: string[]
  ownerId?: string
}

interface AgentLifecycleHook {
  hookId: string
  version: string
  stages: readonly AgentHookStage[]
  onEnter(input: AgentHookInput): Promise<AgentHookResult>
  onExit(input: AgentHookOutput): Promise<AgentHookResult>
}
```

固定调用形态：

```text
stage entered
  → hook.started
  → hook.onEnter
  → stage operation
  → hook.onExit
  → hook.completed / hook.failed
  → stage event published
```

每个 Hook Event 至少带有 `requestId`、`attemptId`、`stage`、`hookId`、`sourceRef`、`sequence`、`correlation` 和 `payloadRef`。UI 只消费这些事件或其 Journal Projection，不直接读取 Driver、Provider Session 或 Hook 内存。

Hook 失败必须有 owner 和处理策略：核心准入、权限、Journal、Checkpoint 和安全 Hook 失败时阻断当前阶段；UI/统计等观察 Hook 失败时不能阻断业务，但必须发布显式的 `hook.failed`，不能伪装成已渲染或已处理。Hook 不能通过修改事件 payload 绕过控制面和业务面的边界。

## 10. Agent Driver Port

Driver 只负责执行适配，不拥有高层生命周期。以下是冻结的 provider-neutral API；Runtime/Checkpoint/Operation owner 仍负责高层状态、Journal、checkpoint 和 completion：

```ts
interface AgentDriver {
  start(input: AgentDriverStart): Promise<AgentDriverReceipt>
  send(input: AgentRequestEnvelope): Promise<AgentDispatchReceipt>
  observe(input: AgentObserveRequest): AsyncIterable<AgentObservationEvent>
  readResult(input: AgentResultRequest): Promise<AgentResult>
  requestStop(input: AgentStopRequest): Promise<AgentStopReceipt>
  reconcile(input: AgentReconcileRequest): Promise<AgentReconcileResult>
  settle(input: AgentSettleRequest): Promise<AgentSettleReceipt>
  close(input: AgentCloseRequest): Promise<AgentCloseReceipt>
}
```

方法关系固定为：`start` 建立一次已准入的 driver runtime；`send` 只提交一个已锁定 binding 的 Request，并只返回 dispatch receipt；`observe` 是有 cursor 的临时/持续证据流，不提交高层状态；`readResult` 从已持久化的 attempt/result ref 读取最终执行结果；`requestStop` 只请求停止并返回 receipt；`reconcile` 在 receipt/transport 不确定时查询真实副作用；`settle` 让 Driver 报告其执行层已停止、仍未知或已收拢的事实；`close` 只关闭 transport/session 资源。`close` 不能隐含 `requestStop`、`reconcile`、`settle`、Checkpoint 或 Task completion；close 失败或提前 close 只留下可重入的 unknown/reconcile 事实。

旧端口迁移关系：

| 旧接口 | 冻结接口 | 语义 |
|---|---|---|
| `submit` | `send` + `readResult` | 旧 `submit` 的“受理”和“结果”拆成 dispatch receipt 与显式 result read；不能把 receipt 当结果 |
| `observe` | `observe` | 保留为有 cursor 的 `AsyncIterable<AgentObservationEvent>`；观察不提交高层状态 |
| `requestStop` | `requestStop` | 保留；accepted 不等于 stopped |
| `settle` | `settle` | 保留为执行层收拢 receipt，不等于 `close` 或 checkpoint |
| `resume` | `start({ mode: 'resume', checkpointRef })` + `readResult`/`observe` | 只能在新 admission/epoch 后从 HumanAgent checkpoint 重入；恢复后的结果和观察仍分别读取，不能从 provider transcript 猜恢复 |
| 新 `reconcile` | `reconcile` | 为未知副作用/丢回执提供事实查询；不能被 `close` 代替 |
| 新 `close` | `close` | 释放 transport/session；不能伪造 settle、stop 或完成 |

适配器可以在兼容层暂时暴露 `submit`/`resume`，但内部必须立即映射到上述方法，并保留原始 dispatch receipt、result ref、observation cursor 和 EOF；公共领域类型只暴露冻结接口。旧端口返回 `AgentOutput` 时，兼容层必须先落原始结果，再返回 `readResult` 语义，不能将受理回执包装成成功输出。

Driver 不得：

- 自己创建 Task 或 Assignment；
- 自己提交 Journal Checkpoint；
- 自己决定 Agent/Task 成功；
- 自己创建平级 Agent；
- 自己扩大 Tool capability；
- 用 Provider Session ID 代替 HumanAgent 身份；
- 通过 prompt metadata 传输 Harness 控制状态。

### 10.1 Driver Receipt

```ts
type AgentDriverReceipt = {
  requestId: string
  attemptId: string
  driverRef: string
  providerSessionRef?: string
  operationRef?: string
  status: 'accepted' | 'rejected' | 'unknown'
  evidenceRefs: string[]
}
```

`providerSessionRef` 只能作为执行证据定位。若 Driver 返回 `unknown`，Runtime 必须走 reconcile，不得按 `accepted` 或 `failed` 继续推进。

### 10.2 ACP Agent Surface

整个 Agent Runtime 对外提供 ACP 适配层。ACP 只负责 Agent Client 与 Agent Runtime 的会话、输入、流式更新和取消通信；它不是 HumanAgent 的 Task、Checkpoint、Journal 或 Agent 身份模型。高层仍然只使用本文件定义的 Request/Response/Event/Hook。

```text
ACP Client
  ↕ ACP Adapter
HumanAgent Agent Runtime
  → Request Gate / Hook chain / Event Bus / Checkpoint tools
  → Agent Driver
```

ACP Adapter 至少支持：

| ACP 语义 | HumanAgent 映射 | 约束 |
|---|---|---|
| `initialize` | ACP capability/readiness | 不创建 Task，不宣称业务完成 |
| `session/new` | 创建受权限约束的 ACP session binding | ACP session id 只是 transport identity |
| `session/load`（支持时） | 从已授权的 session/Task projection 恢复 | interaction 走 `InteractionClosure`/interaction recovery；task 才走 checkpoint recall，不能读 Provider transcript 作为真相 |
| `session/prompt` | 创建 Agent Request，经 Request Gate 和 Hook 链 | 不能绕过显式输入整理、权限和资源准入 |
| `session/update` | 将 Event Bus 的公开进度 projection 推给 ACP client | 不直接暴露内部 Control Block 或未授权 Memory |
| `session/cancel` | 按 session binding 分流：interaction 关闭输入并提交 `InteractionClosure`；task 发起 steer/stop operation | 两者都要求 cancel accepted 不等于 completed；interaction 等待 operation 收拢，task 还必须等 stopped checkpoint |
| `session/close`（支持时） | 关闭 ACP transport/session binding | 不删除 Task、Journal、Checkpoint 或 Memory |

ACP 的传输和版本由 `AcpAdapter` 锁定；MVP 可使用 JSON-RPC/stdio，未来可替换 transport，但不能改变上述映射。ACP `sessionId`、ACP message id 和 ACP update cursor 只保存为 evidence/correlation，不得冒充 `TaskId`、`RequestId`、`OperationId` 或 `CheckpointId`。

ACP binding 必须在 `initialize`/`session/new` 前由 Harness 建立：

```ts
type AcpServerBinding = {
  bindingRef: string
  principalRef: string
  scopeRef: string
  allowedSessionKinds: Array<'interaction' | 'task'>
  allowedCapabilities: string[]
  permissionRevision: string
  bindingDigest: string
}

type AcpDriverBinding = {
  bindingRef: string
  externalPeerRef: string
  taskId?: string
  assignmentId?: string
  executionEpoch: number
  delegatedCapabilities: string[]
  delegationProofRef: string
  permissionRevision: string
}
```

Server 只接受能证明 `principalRef`、scope 和 capability 的 peer；Driver 只委托 `delegatedCapabilities`，不能接受外部 peer 自报工具权限。权限撤销后，binding 立即失效，未完成请求进入 stop/reconcile。无法验证 binding、delegation proof、scope 或 capability 时返回 `capability-unavailable`，不得降级为默认权限。

HumanAgent 同时预留 ACP Driver，使一个外部 ACP Agent 能作为可替换执行后端：

```text
HumanAgent Request
  → ACP Driver
  → external ACP Agent
  → ACP updates
  → Response Decoder / Control Decoder / Hooks
```

无论是 ACP Server 还是 ACP Driver，真实完成、Checkpoint、Memory 和错误状态都必须回到 HumanAgent 的 Core/Runtime Owner，不能由 ACP peer 的 session/update 文本直接推进。

## 11. Event Bus 与 Agent 协同

通信 envelope、发布者证明、三类消息、consumer receipt、cursor/ACK、重试、旧 epoch 和 scope ACL 的唯一合同见 [`agent-communication-and-feedback.md`](agent-communication-and-feedback.md)。本节只保留 Agent 协同在 request/response 文档中的映射。

Agent 之间不通过私有 Session 互相聊天。协同分成两种：

```text
Tool Call
  Agent 通过对方注册的 capability 请求授权数据或操作

Internal Event
  Harness 通过 Event Bus 通知状态、资源、Bug、Attention 和协同事件
```

### 11.1 Agent Event

Canonical event envelope 由 [`agent-communication-and-feedback.md`](agent-communication-and-feedback.md) §3 定义。本节不再维护第二份字段合同；EventBus 适配层使用同一 envelope。

```ts
type AgentEvent = AgentMessageEnvelope
```

Event Bus 负责按 scope 投递；consumer 处理结果必须通过 Journal Owner 提交 `EventConsumerReceipt`，再推进 durable cursor/ACK。它不负责判定业务成功。控制事件和业务 payload 必须保持独立引用。

### 11.2 Agent Bug 和资源协同

Agent 间的 Bug 通知必须是结构化协同数据：

```text
bugId
reportedBy
owner
reproductionRefs
observedResultRef
expectedResultRef
nextAction
resourceImpact
correlation
```

这不是普通 Agent Response，也不是把错误埋入下一轮 Prompt。Bug 的状态由 Bug Owner 管理；Agent 只能报告、确认、修复或验证自己被分配的范围。

## 12. Tool Intent 和 Result 的闭环

Agent Response 里的 `toolIntentRefs` 只是 Tool 请求建议：

```ts
type ToolIntent = {
  toolRef: string
  inputRef: string
  reason?: {
    title: string
  }
}

type ToolReasonProjection = {
  toolRef: string
  title: string
  sourceIntentRef: string
  operationRef?: string
}
```

模型被要求按这个 schema 输出 Tool Intent。`reason.title` 是给人和观测面使用的短标题，也是下一轮推理和 Memory 分析的短参考；存在时由 Tool Owner 生成 `ToolReasonProjection`，不存在就忽略。缺失或格式不完整不能拦截 Tool 调用。Tool 是否能执行只由 capability、权限、参数和 Operation Gate 决定。

```text
Agent Response
  → Tool Intent Decoder
  → capability / permission admission
  → ToolReasonProjection（如有 reason）
  → control/tool-intent event（供 UI、Memory 和 Operation Owner）
  → Operation started
  → Tool Invoker
  → raw result persisted
  → Result Codec
  → ToolResultContextMapper
  → Context Committer
```

Agent 不能把文本形式的“请执行某命令”当作已经执行。只有 Harness 的 Tool Invoker 返回 Operation Receipt，才表示调用已被接受；只有原始结果持久化并通过对应闭环，才可以进入 Context。

Tool Result 映射失败：

```text
保留 rawResultRef
  → 写入 mapping failure
  → 修复 Mapper
  → 从相同 rawResultRef 重放
  → 不重新执行 Tool
```

模型返回的 `memory.learned` 也只是一组可选控制字段：

```text
ControlBlockCodec
  → memory-candidate event
  → Memory Owner 校验、去重、归档和更新 index
```

没有 `memory.learned` 就不产生候选；有候选也不进入 Context。Memory Owner 是否形成长期记忆由其自身策略决定，Agent Response 不直接写 Context 或替代 Memory Owner。

## 13. 错误、取消和 Steer

### 13.1 错误归属

| 错误 | Owner | 默认动作 |
|---|---|---|
| Request 结构错误 | Request Gate | 拒绝发送，记录原因 |
| Binding/权限错误 | Core/Permission Owner | 拒绝或等待授权 |
| Driver/Provider 错误 | Agent Driver Adapter | 保留原错，决定可否 reconcile |
| Response decode 错误 | Response Decoder | 保存原始响应，禁止伪造成功 |
| Result mapping 错误 | Result Mapper | 重放映射，不重做 Tool |
| Context commit 错误 | Context Committer | 幂等重试或交 Runtime |
| Task 交付失败 | Task/Assignment Owner | 重新编排、Attention 或失败收口 |

### 13.2 Steer 不是 Response

Steer 是控制命令，不进入 `AgentRequest.data`，也不作为普通 Agent Response：

```text
steer command
  → 权限和目标 Epoch 校验
  → fence 新请求
  → Driver.requestStop
  → Operation settle/reconcile
  → stopped Context View / Checkpoint
  → stop response
```

Driver 返回“cancel accepted”不等于停止完成。只有实际停止、外部副作用收拢和停止 Checkpoint 都达到条件，Runtime 才能返回终态。

### 13.3 Provider 响应不可解析

如果 Provider 已返回内容但 Decoder 失败：

```text
保存原始响应 Artifact
  → response.decode.failed
  → owner = Response Decoder / Adapter
  → 可重放 decode
  → 不重新发送原请求，除非 Runtime 明确创建新 Attempt
```

## 14. 幂等、重试和恢复

一次逻辑请求的幂等身份为：

```text
requestId
attemptId
bindingFingerprint
contextViewRef
inputDigest
outputContractRef
```

重试规则：

- 同一 `requestId + attemptId` 只允许恢复或补读，不能改变输入；
- 业务输入、Context View 或 Output Contract 变化，必须创建新 Attempt；
- 发生外部副作用后，先 reconcile，再决定是否创建新 Attempt；
- Provider Session 断开不自动代表 Agent 失败；
- Response 已提交但传输回执丢失时，根据 Journal 重新投递同一 Response；
- 同一请求重复到达时返回已有提交事实，不重复写业务结果。

## 15. Response Mapper 与 Prompt Renderer 插件

请求和响应各有独立插件：

```text
Context Builder
  → Prompt Renderer Plugin
  → Provider Request

Provider Response
  → Response Decoder Plugin
  → Agent Response Envelope
  → Agent Result Mapper Plugin
  → Journal / Context Projection
```

插件职责：

| 插件 | 输入 | 输出 |
|---|---|---|
| `PromptRenderer` | Provider-neutral Agent Request | Provider request |
| `ResponseDecoder` | Provider response/session event | Agent Response Envelope |
| `ResultMapper` | Agent Response data | Journal/Context Projection |
| `ToolResultMapper` | Tool Result Envelope | Context Projection |

插件必须有：

```text
pluginId
pluginVersion
inputSchemaVersion
outputSchemaVersion
capabilityRefs
determinism
```

旧版本仍被 Journal、Replay、Checkpoint 或未收拢请求引用时不能删除。

## 16. 与 Agent Profile 的关系

Agent Profile 只配置：

```toml
[agent]
id = "explicit-brain"
role = "interaction-router"
prompt = "profiles/explicit-brain/system.md"
skills = "profiles/explicit-brain/skills.toml"
tools = "profiles/explicit-brain/tools.toml"
skill_sources = ["humanagent", "agent-home", "codex-home"]
mcp_sources = ["humanagent", "project", "agent-home", "codex-home", "mcpx"]
built_in_tools = [
  "checkpoint.inspect",
  "checkpoint.recall",
  "checkpoint.save",
  "checkpoint.record-dead-end",
  "checkpoint.reenter"
]
output_contract = "contracts/requirement-envelope.toml"
context_policy = "policies/compact-default.toml"

[agent.io]
request_renderer = "responses-renderer"
response_decoder = "responses-decoder"
result_mapper = "explicit-brain-result-mapper"
```

`skill_sources` 和 `mcp_sources` 只声明允许检索的兼容来源，不等于加载全部能力。最终运行时仍必须由模板 manifest、capability allowlist、permission revision 和 lock digest 确定实际 Skill/MCP binding。Codex 与 `~/.agent` 的原始配置保持只读；MCPX 如果存在，只作为已声明的 discovery/transport adapter，不创建第二份能力真源。

Agent Profile 不能修改：

- Request Gate；
- Response 状态机；
- Journal 提交顺序；
- Steer/Stop 语义；
- Tool 权限准入；
- 内置 Checkpoint tools 的语义和提交顺序；
- Request/Response Hook stage 和 ACP 映射；
- ContextBuilder 阶段；
- Core/Runtime 的成功判定。

## 17. 验证样例

进入实现前必须固定以下正负样例：

1. 交互 Agent 在无 Task 时使用 `interaction` Binding，不伪造 Task。
2. Task Agent 使用旧 Epoch Response，必须被拒绝或标记 stale。
3. 同一 Request 重复到达，不能重复写业务结果。
4. Provider Session 断开但 Operation 未知，必须进入 reconcile，不直接失败。
5. Provider 返回不可解析响应，保存原始内容，不伪造成功。
6. 流式事件缺序号或有 gap，不能静默拼接。
7. Tool Intent 未获 capability 授权，不能调用 Tool。
8. Tool Result Mapper 失败，重放 Mapper，不重做 Tool。
9. Response 已提交但传输确认丢失，重投同一 Response，不创建新业务结果。
10. Steer 到达后，旧 Agent 迟到响应不能推进新 Epoch。
11. Agent 输出 `completed`，但 Task 验收未完成，不能提交 Task completed。
12. 普通中间响应没有 Control Block，可以继续；end-turn/stop 没有 `summary`，只能进入有限修复。
13. end-turn/stop 有 `summary` 但缺少 `goal`/`next`，按 partial 解码并记录 unknown，不伪造控制状态。
14. `memory.learned` 存在时只发布 `memory-candidate` event；它不进入 Context，也不直接成为长期记忆。
15. Tool Intent 没有可选 `reason.title`，不拦截调用；权限、参数或 capability 失败仍按对应 Gate 处理。
16. 只有 `checkpoint.save` 等内置工具的成功结果可以产生 Checkpoint；Control Block 中的 `checkpoint.disposition` 不能单独提交。
17. Hook 可以产生 UI/Event/派生输出，但不能直接推进 Task 完成、Checkpoint 或权限状态；核心 Hook 失败阻断，观察 Hook 失败显式上报。
18. ACP `session/cancel` 对 interaction 只等待 InteractionClosure 和在途 operation 收拢；对 task 才要求 settle 和 stopped checkpoint。两者都不能把 cancel accepted 直接投影为 completed。

## 18. 下一步实现顺序

本设计通过独立审查后，按以下顺序实现：

```text
contracts：Request/Response/Event/Binding 类型和负向校验
  → core：准入、Epoch、状态和 Steer 不变量
  → runtime：Driver 调度、事件关联、Commit/Replay
  → adapters：Fake/Replay，再接 Provider/DSH
  → tests：正常、失败、断线、重复、恢复和权限样例
```

先实现 Provider-neutral Fake/Replay，不先把 DSH Session 或 Provider Response 作为高层结构。真实 DSH/Provider 适配只实现 Renderer、Decoder、Driver 和证据映射。
