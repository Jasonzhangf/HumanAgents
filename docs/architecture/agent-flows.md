# Agent 流程与入口设计

状态：`NEXT-DESIGN / UI-BASELINE-FROZEN`  
日期：2026-09-11  
适用阶段：`DESIGN-BOOTSTRAP` → MVP 设计收口

本文是 HumanAgent 各 agent 的流程、输入输出、入口和反馈边界的详细设计。它依赖 [`organ-runtime.md`](organ-runtime.md) 的领域状态、生命周期和端口边界；不替代 `core` 的状态机，也不把 UI 变成运行时真源。

## 1. 当前冻结的设计框架

本阶段固定以下产品框架。后续 agent 设计只能填充流程和接口，不能重新混合页面责任：

| 入口 | 唯一任务 | 默认呈现 | 可进入的下一层 |
|---|---|---|---|
| `dashboard.html` | 全局状态入口 | 待处理、正在处理、最近输入、历史任务 | 任务列表或具体任务 |
| `tasks.html` | 任务索引 | 当前运行、需要你决策、历史任务 | 运行任务看板或任务处理页 |
| `task.html` | 显式交互和任务 I/O | 当前状态、输入/调查、建议、需要你决定、输出 | 只读任务观测 |
| `task-dashboard.html` | 单个运行任务看板 | 任务摘要、各 agent 输入/输出预览、是否需要用户处理 | agent 动态过程、递归观测 |
| `observation.html` | 后台只读观测 | 节点树、状态、输入/输出引用、证据 | 子 scope、节点 drawer |
| `interaction.html` | 运行控制 | Attention、checkpoint、停止/收拢、运行控制 | 诊断特殊入口 |

固定的两条人机边界：

1. `task.html` 是显式交互 agent 与人沟通的地方。只有这里可以形成用户选择、调整和确认。
2. `task-dashboard.html` 是运行看板。它展示 agent 正在做什么，不把运行状态转换成决策表单。

后台层可以被完整观测，但默认不直接让人消费：`observation.html` 只读；控制动作只能从 `interaction.html` 进入；用户决策只能从 `task.html` 进入。

## 2. Runtime 与 Agent 的分类

两者必须分开：

| 层级 | 是什么 | 唯一责任 | 是否绑定任务 |
|---|---|---|---|
| Harness Runtime | HumanAgent 的运行时控制面 | 队列、资源、生命周期、checkpoint、监督、健康探针、事件和恢复 | 管理多个任务和 agent runtime |
| Agent Runtime | 一个可运行的 agent 实例容器 | 装载 agent 能力、建立任务绑定、接收 assignment、回传 result、释放资源 | 一次绑定一个任务上下文；默认不 fork |
| Agent | 在 Agent Runtime 中承担一个明确角色的工作单元 | 交互、编排、执行、review 或记忆中的一种职责 | 通过 binding 绑定到 task/phase |
| Worker Operation | agent 发起的一次具体外部工作 | 搜索、读取、修改、测试、构建等有限操作 | 绑定到一个 assignment/node |

一个 Task 可以绑定多个不同类型的 agent；Task 不是一个 agent，也不是一个 Agent Runtime。Task 由编排 agent 管理阶段，由 Harness Runtime 管理生命周期。

### 2.1 Runtime 类别

#### Harness Runtime

Harness Runtime 是唯一的总控制面，负责：

- 接收交互 agent 已确认的需求队列；
- 管理编排 agent queue、agent runtime pool 和资源 lease；
- 选择复用 idle 编排 agent runtime，或在资源允许时 spawn 新 runtime；
- 管理所有 agent runtime 的启动、绑定、释放、超时、停止和恢复；
- 执行 checkpoint recall/completion、错误升级和控制通道；
- 执行健康诊断，不让 agent 自己声明健康；
- 把 agent 结果投影为任务状态、Attention、review 请求和 UI projection。

Harness Runtime 不代替编排 agent 设计任务步骤，也不把业务决策塞进 runtime metadata 或 agent prompt。

#### Agent Runtime

Agent Runtime 是角色的运行容器。它拥有运行代次、资源 lease、输入窗口、输出通道和生命周期，但不拥有 Task 真相。

```text
available
  → starting
  → idle
  → bound(task, agent)
  → executing
  → settling
  → idle / stopped / failed
```

Agent Runtime 释放后可以被同类 agent 复用。复用时必须重新从 Task/Checkpoint 装配任务上下文，不能带入上一个任务的隐式状态。

### 2.2 Agent 角色总览

这里的 agent 是功能责任和执行边界，不是页面中的器官类比。一个实现可以由多个模型、规则模块或外部执行器共同完成一个 agent，只要唯一 owner 不变。

| Agent | 角色类别 | 唯一责任 | 输入 | 输出 | 默认 UI 入口 |
|---|---|---|---|---|---|
| 交互 agent | 前台 agent | 检查输入、提取任务意图、与人确认，确认后投递编排队列 | 原始输入、匹配结果、状态证据、人类选择 | `RequirementDraft`、`RequirementEnvelope`、用户反馈 | Dashboard、Task Detail |
| 编排 agent | manager agent | 阶段计划、任务分解、资源安排、派发 worker、检查交付、推进和 merge | FIFO `RequirementEnvelope`、任务状态、Harness 资源摘要 | `WorkAssignment`、阶段计划、推进/等待/review/整改决定 | Task Dashboard、Observation |
| 执行 agent | worker agent | 完成一个有限、可验收的工作单元 | `WorkAssignment`、能力、权限、工具输入 | `WorkResult`、输出引用、证据引用 | Task Dashboard、Observation |
| review agent | worker agent | 执行架构、基础、质量或安全审计，报告问题，不直接整改 | review assignment、目标交付物、验收标准 | `ReviewResult`、问题清单、通过/不通过 | Task Dashboard、Observation |
| 记忆 agent | supporting agent | 从结果和记录中提取 skill 候选，不自动入库 | 输出、异常、checkpoint、重复模式 | `SkillCandidate`、review 请求 | Task Dashboard；需要 review 时回到 Task Detail |

健康诊断和监督/恢复不属于 agent 类别：它们是 Harness Runtime 的内建能力。Harness 负责探针、健康快照、生命周期和控制；agent 只能接收这些结果，不能自行发布健康真相、steer 或 checkpoint。

## 3. 总体流程

```text
人类 / notification / 外部输入
              │
              ▼
      交互 agent（显式）
              │
       draft → status → intent
              │
        人类确认/调整
              │
              ▼
     RequirementEnvelope FIFO
              │
              ▼
     编排需求 FIFO（Harness）
              │
              ▼
    编排 agent runtime pool
       ┌──────┴───────────┐
       │                  │
   复用 idle runtime   资源允许则 spawn
       └──────┬───────────┘
              ▼
      编排 agent（manager）
       ┌──────┼──────────────┐
       ▼      ▼              ▼
    阶段计划  资源安排     review/merge gate
              │
              ▼
       WorkAssignment
       ┌──────┼──────────────┐
       ▼      ▼              ▼
    执行 agent review agent  记忆 agent
       │      │              │
       └──result/审计结果─────┘
              │
              ▼
     编排推进 / 整改 / review
              │
              ▼
     输出 / Attention / task result
              │
              ▼
        交互 agent 呈现

Harness health probes 在上述流程旁路运行：它们为准入和监督提供事实，不作为 agent 被派发。
```

这条流程有三个不能绕过的门：

- 用户确认门：没有确认不能形成可派发的 `RequirementEnvelope`。
- 资源准入门：没有完整输入、权限或可恢复条件不能绑定编排 agent runtime，也不能创建执行流水线。
- 输出交付门：没有实际 operation/节点结果和证据引用不能呈现任务完成。

## 4. 交互 agent：从输入到确认派发

### 4.1 职责边界

交互 agent 只做表层输入理解和人机确认，不做深层执行调度。它可以查询已有任务和状态，用于帮助人判断，但在确认前不能：

- 创建后台 pipeline；
- 写入业务需求 FIFO；
- 修改运行任务状态；
- 代表用户确认目标、范围或发布动作。

### 4.2 流程状态

```text
received
  → matching
  → status-checking
  → awaiting-intent
  → awaiting-confirmation
  ├── confirmed → dispatched
  ├── status-only → feedback-complete
  └── rejected → closed
```

`awaiting-intent` 用于询问“这是追加、变更、新建，还是只查询”；`awaiting-confirmation` 用于展示整理后的任务、建议和影响，让人确认具体方案。

### 4.3 输入输出

输入来源：

- 用户在 Task Detail 输入的文本；
- notification、外部事件和感知输入；
- 当前任务、相关任务和历史状态的只读查询结果。

输出分两层：

```ts
type RequirementDraft = {
  draftId: string
  sourceRef: string
  normalizedInput: string
  matchedTasks: Array<{ taskId: string; relation: 'current' | 'related' | 'historical'; status: string }>
  knownFacts: string[]
  proposedIntent: 'append' | 'change' | 'create' | 'status'
  proposal: string
  decisionRefs: string[]
  state: 'awaiting-intent' | 'awaiting-confirmation' | 'rejected'
}

type RequirementEnvelope = {
  requirementId: string
  draftId: string
  inputRevision: number
  intent: 'append' | 'change' | 'create'
  taskRef?: string
  normalizedInput: string
  confirmedBy: string
  confirmedAt: string
  fifoSeq: number
  payloadRef: string
}
```

`status` 不生成 `RequirementEnvelope`。它只返回状态投影，并在交互记录中保存“只查询”的结果。

### 4.4 UI 入口映射

| 用户动作 | 页面 | 交互 agent 行为 | 后续 |
|---|---|---|---|
| 输入新内容 | `task.html` | 接收、归一化、匹配任务 | 显示调查结果和意图问题 |
| 点击待处理任务 | `tasks.html → task.html` | 恢复 draft 和已知状态 | 直接进入确认/调整 |
| 选择按建议执行 | `task.html` | 固化确认记录 | 生成 `RequirementEnvelope` |
| 调整目标/范围 | `task.html` | 更新 draft，重新说明影响 | 再次等待确认 |
| 另建任务 | `task.html` | 清除旧任务派发关系但保留引用 | 生成新任务意图 |
| 只查看状态 | `task.html` | 返回状态投影，不派发 | 交互完成 |
| 自定义 | `task.html` | 重新整理自定义输入 | 需要确认时再次询问 |

## 5. 任务编排 agent：manager 与 runtime pool

### 5.1 manager 边界

编排 agent 是 manager，不是 worker。它负责项目导向的执行管理：阶段计划、任务分解、资源安排、agent 分配、结果检查、流程推进、整改安排和 merge 管理。

编排 agent 明确不能自己完成 worker 工作：

- 不能自己搜索；
- 不能自己写代码；
- 不能把未验证的推断当成 worker 交付；
- 不能绕过 assignment 直接操作外部资源。

它可以检查输入、过程状态、结果和证据，判断是否达到交付要求，并决定下一步交给哪个 worker。

### 5.2 编排 agent runtime pool

Runtime Coordinator 负责消费确认后的 `RequirementEnvelope` 并维护 FIFO。它在完成分类、冲突处理和资源准入后，向 `OrchestrationRuntimeManager` 发出编排 runtime 绑定请求；pool manager 根据负荷、能力和资源状态选择运行容器：

```text
RequirementInbox（Runtime Coordinator 消费）
        │
        ▼
admitted orchestration binding request
        │
        ▼
OrchestrationRuntimeManager
        │
        ├── 找到匹配能力且 idle 的编排 agent runtime
        │       → acquire lease → bind task → 继续编排
        │
        └── 没有可用 idle runtime，但资源允许
                → spawn 编排 agent runtime
                → 从 task/checkpoint 装配上下文
                → bind task → 开始编排
```

选择条件：

1. 当前 runtime 必须是 `idle`，且能力版本、权限范围和任务类型匹配；
2. 当前 Harness 负荷、并发额度、内存、provider/tool 能力和任务优先级允许绑定；
3. 复用失败或没有合适 idle runtime 时，只有资源准入成功才能 spawn；
4. 没有资源时进入带条件的 waiting，不创建半成品 runtime 或假运行状态。

`OrchestrationRuntimeManager` 只负责池管理和绑定，不替代编排 agent 的阶段计划。编排 agent runtime 只承载一个当前 task binding；若未来允许并行任务，也必须显式增加独立 binding/lease，不默认为隐式复用。

### 5.3 上下文策略：默认不 fork

一般情况下不 fork 上下文。无论复用 idle runtime 还是 spawn 新 runtime，都从任务真相重新装配：

```text
Task + latest checkpoint + current directive
  + relevant evidence refs
  + current phase assignment
  + bounded working window
  → new agent runtime context
```

不复制另一个 agent 的完整上下文，不把父 agent 的聊天记录、隐式 prompt 或未提交推理带入子 agent。只有以下情况可以显式 fork，并且必须记录原因、父子关系和隔离边界：

- 需要并行比较且结果必须相互独立；
- 需要故障隔离或权限隔离；
- review 需要不受原编排结论影响的独立上下文；
- 用户或任务策略明确要求保留独立实验分支。

fork 是 runtime control 事实，不写入业务 payload，也不能作为普通调度捷径。

### 5.4 需求消费与阶段推进

Runtime Coordinator 是需求 FIFO 的消费 owner；任务编排 agent 是任务阶段计划和推进的 owner。编排 agent 只接收已经确认、分类、关联并通过准入的 `RequirementEnvelope`，不能消费未确认 draft，也不能从 UI、debug log 或 DSH session 猜测控制状态。

它每次消费一个 `RequirementEnvelope`，依次完成：

1. Runtime Coordinator 分类：选择已注册的工作队列。
2. Runtime Coordinator 关联：追加到已有任务，或创建新任务。
3. Runtime Coordinator 更新：把新输入写成任务事件，不覆盖旧状态。
4. Runtime Coordinator 准入：提供输入、权限、健康、并发、依赖和恢复事实。
5. 编排 agent 计划：生成阶段计划、pipeline 节点树和每个 worker assignment。
6. 编排 agent 派发：将 assignment 交给执行或 review agent，并等待 typed result。
7. 编排 agent 检查交付：核对固定目标、交付物、证据和验收条件。
8. 编排 agent 推进：继续下一阶段、安排整改、安排 review、执行适用的 merge，或进入等待。

### 5.5 分类与队列

MVP 只固定以下队列，队列必须在注册表中存在：

| 队列 | 内容 | 特殊规则 |
|---|---|---|
| `interactive` | 需要用户补充、选择或确认 | 等待用户时不得标记为运行中 |
| `execution` | 已具备输入和资源的执行任务 | 受资源准入和背压限制 |
| `research` | 收集、比较、核验和分析 | 外部依赖不足进入条件等待 |
| `maintenance` | checkpoint、索引、诊断和恢复维护 | 不能抢占正在收拢的 operation |

steer、停止、权限撤销和安全升级走独立 control channel，不进入上述业务队列。

### 5.6 运行中任务的最新输入

“插队”按来源和风险分成三种，不以任意优先级改变 FIFO：

- 普通追加：写入任务 mailbox，按任务自身的输入序列等待处理；
- 运行中任务更新：由任务关联 owner 合并到当前任务，保留旧输入和新 revision；
- 停止/权限/安全事件：通过控制通道立即撤销继续许可，不等待业务队列。

### 5.7 任务编排 agent 的反馈

执行 agent 返回的是一次已经可判定的工作结果，不能只返回自然语言反馈：

```ts
type WorkAssignment = {
  assignmentId: string
  taskId: string
  pipelineNodeId: string
  attempt: number
  executionEpoch: number
  inputRevision: number
  objective: string
  targetRefs: string[]
  expectedOutputRefs: string[]
  expectedArtifactDigests?: string[]
  acceptanceCriteriaDigest: string
  successCriteria: string[]
  failureCriteria: string[]
  incompleteCriteria: string[]
  mergeGate: 'required' | 'not-required'
}

type WorkResult = {
  taskId: string
  pipelineNodeId: string
  agentId: string
  assignmentId: string
  attempt: number
  executionEpoch: number
  inputRevision: number
  producedArtifactRefs: string[]
  producedArtifactDigests: string[]
  status: 'succeeded' | 'failed' | 'incomplete' | 'blocked' | 'cancelled'
  summary: string
  outputRefs: string[]
  evidenceRefs: string[]
  nextAction: 'continue' | 'wait' | 'attention' | 'review' | 'settle' | 'remediate'
  conditionRef?: string
  failureRef?: string
}
```

编排 agent 只接受与当前 `taskId`、`pipelineNodeId`、`assignmentId`、`attempt`、`executionEpoch` 和 `inputRevision` 全部匹配的结果。旧 epoch、旧 attempt、旧输入 revision 或不匹配 artifact digest 的结果只能记录为 stale evidence，不能推进任务。

任务编排 agent 根据 `nextAction` 做唯一处理：

| 反馈 | 编排处理 | 是否反馈交互 agent |
|---|---|---|
| `continue` | 提交节点结果并派发下一节点 | 否，除非影响用户承诺 |
| `wait` | 保存等待条件和 checkpoint | 只有等待用户时反馈 |
| `attention` | 保留恢复责任并发布 Attention | 是，立即反馈影响 |
| `review` | 创建 review 请求 | 是，进入 Task Detail 决策入口 |
| `settle` | 收拢 cycle，交付结果 | 是，更新任务输出 |

## 6. 记忆流程：每个任务的必备绑定

### 6.1 角色定位

每个 Task 必须绑定 memory scope 和 memory runtime/supporting-agent 接口，不是任务完成后可选的附加步骤。这里的“记忆 agent”是流程角色，不强制意味着每次都启动一个 AI 对话进程：确定性的 Memory Operations Backend 可以完成 ingest、Index、查询、比较和上下文装配；需要语义分析时才启动可选的 memory analysis agent。它不替代编排 agent 做执行管理，也不替代 Harness 做健康诊断；它负责维护任务经验和长期 skill 的判断链。

它拥有独立的记忆交互接口，可以：

1. 阅读本 Task 的编排历史、阶段结果、失败/恢复记录和 checkpoint；
2. 对已有记忆进行匹配，检查当前做法的独特性、重复性、适用范围和复用价值；
3. 判断任务流程是否反复出现，是否值得沉淀为特殊 skill；
4. 接收编排 agent 的搜索和询问；
5. 读取本 Task 绑定的 agent runtime session 历史，但只能通过 typed memory interface，不直接读取临时文件或 UI 日志。

### 6.2 每个 Task 的绑定关系

```text
Task
 ├── interaction agent binding
 ├── orchestration agent binding
 ├── memory scope/runtime binding 必须存在
 │    └── optional memory analysis agent
 ├── execution agent bindings   按阶段创建/释放
 └── review agent bindings      完成前按计划创建
```

任务创建或被编排 agent 接受时，Harness 必须建立 memory binding，并记录 Operations Backend、Index version 和 scope。没有可用 memory binding 的任务可以进入显式 `memory-unavailable` 阻塞，但不能把它当作正常完成，也不能静默跳过记忆检查；没有 AI memory agent 本身不构成失败，只要确定性基础操作仍可用。

### 6.3 记忆交互接口

记忆 agent 通过三个逻辑端口工作；具体 memmy 类服务只能在 adapter 后面出现：

```ts
interface TaskMemoryQueryPort {
  search(input: {
    taskId: string
    query: string
    scopes: Array<'task-history' | 'skills' | 'prior-tasks' | 'runtime-sessions'>
    limit: number
  }): Promise<MemorySearchResult>

  ask(input: {
    taskId: string
    question: string
    contextRefs: string[]
  }): Promise<MemoryAnswer>
}

interface BoundRuntimeHistoryPort {
  list(taskId: string): Promise<Array<{ runtimeId: string; agentId: string; sessionRef: string }>>
  read(input: { taskId: string; runtimeId: string; cursor?: string; limit: number }): Promise<MemoryHistoryPage>
}

interface SkillCandidatePort {
  propose(candidate: SkillCandidate): Promise<{ candidateId: string; state: 'candidate' }>
  requestReview(candidateId: string): Promise<{ reviewId: string }>
}
```

`TaskMemoryQueryPort` 是编排 agent 搜索和询问记忆的接口；`BoundRuntimeHistoryPort` 只允许读取当前 Task 绑定的 agent runtime session 历史；`SkillCandidatePort` 负责候选和 review 请求。记忆 agent 不直接写 Skill Registry。

这些任务级接口由 [`memory-system.md`](memory-system.md) 的 `MemoryOperationsPort` 和 `AgentMemoryContextInjectionPort` 实现；UI 另外使用 `MemoryInteractionPort`。索引查询先返回来源引用和分层摘要，完整历史通过 inspect 按需读取，不能把 Index 或 RAG 数据库直接注入 agent。

### 6.4 后台 RAG 连接

Memory Operations Backend 可以连接类似 memmy 的后台 RAG service，但高层不依赖 memmy 的类型、数据库或 session 格式；该服务不是记忆系统的必要条件：

```text
Memory Operations Backend / optional Memory Agent
    ↓ TaskMemoryQueryPort / BoundRuntimeHistoryPort / Context Injection
Memory adapter
    ↓
RAG service（memmy-like） + durable memory index
```

RAG service 提供检索能力，不拥有 HumanAgent Task、Checkpoint 或 agent runtime 真相。检索结果必须带 `memoryRef`、来源范围、相关 Task/Session 引用和可信度/覆盖范围；不能只返回一段无法追溯的摘要。

### 6.5 贯穿任务的流程

```text
Task binding 创建
        ↓
记忆 agent 建立接口和历史范围
        ↓
每个阶段完成后阅读：
  - 编排历史
  - 执行/审计结果
  - 当前 Task 绑定的 agent runtime session
  - 已有 skill 和历史任务
        ↓
独特性 / 重复性 / 价值判断
        ↓
继续询问或生成 SkillCandidate
        ↓
任务完成前给编排 agent 返回 memory review result
        ↓
需要入库时交给交互 agent + 用户 review
```

编排 agent 可以在计划阶段和每个阶段收尾时调用记忆 agent，例如询问“是否存在相同处理路径”“这个结果是否已有对应 skill”“当前失败是否是已知模式”。记忆 agent 返回事实和候选，不替编排 agent 改变阶段计划。

候选至少包含：

```ts
type SkillCandidate = {
  candidateId: string
  sourceTaskId: string
  pattern: string
  proposedRule: string
  evidenceRefs: string[]
  memoryRefs: string[]
  runtimeSessionRefs: string[]
  uniqueness: 'unique' | 'variant' | 'duplicate' | 'unknown'
  repeatability: 'one-off' | 'observed' | 'recurring' | 'unknown'
  value: 'low' | 'review' | 'high' | 'unknown'
  state: 'candidate' | 'reviewing' | 'approved' | 'rejected' | 'superseded'
}
```

### 6.6 入口与权限

- Task Dashboard 的 memory agent 卡片展示当前读取范围、比对状态、候选状态和下一步。
- 需要查看历史时进入独立 Memory Inspector/记忆交互面；它只能查询，不直接改变任务或 skill。
- 有候选时，Task Detail 出现“需要 review”的交互项；用户可以批准、修改、拒绝或延后。
- `Skill Registry` 的写入只能由明确的 review command 完成。
- 没有足够证据时，记忆 agent 只能输出“暂不沉淀”，不能生成看似确定的 skill。

## 7. Review agent：完成前的独立审计

review agent 是 worker，不负责整改。编排 agent 在任务完成前必须按照任务类型安排必要的 review：

- 架构审计：边界、依赖方向、接口和状态所有权；
- 基础审计：功能、错误、权限、数据完整性和基础测试；
- 质量/安全审计：按任务风险选择；
- 交付审计：交付物、证据、结果和验收条件是否齐全。

```text
阶段执行完成
      ↓
编排 agent 生成 review assignment
      ↓
review agent 独立检查
      ├── pass → 编排 agent 进入 merge/settle
      └── fail → 返回 findings
                    ↓
              编排 agent 生成整改 assignment
                    ↓
              执行 agent 修复
                    ↓
              review agent 复审
```

review agent 不搜索、不写代码、不直接修改目标，只返回固定格式：

```ts
type ReviewResult = {
  reviewId: string
  taskId: string
  assignmentId: string
  attempt: number
  executionEpoch: number
  inputRevision: number
  subjectRefs: string[]
  subjectDigests: string[]
  acceptanceCriteriaDigest: string
  reviewKind: 'architecture' | 'baseline' | 'quality' | 'security' | 'delivery'
  status: 'passed' | 'failed' | 'inconclusive'
  findings: Array<{
    findingId: string
    severity: 'blocker' | 'important' | 'advisory'
    locationRef: string
    problem: string
    expected: string
    evidenceRefs: string[]
  }>
  evidenceRefs: string[]
}
```

review 结果只对当前 `assignmentId`、`attempt`、`executionEpoch`、`inputRevision`、`acceptanceCriteriaDigest`、`subjectRefs` 和 `subjectDigests` 有效；其中任一变化都必须重新 review，旧 PASS 只能保留为历史证据。Review Coordinator 只负责 finding、复审有效性和 gate 判定；整改计划和整改 `WorkAssignment` 仍由编排 agent 创建并由其拥有 assignment 状态。编排 agent 只有在适用的 review 通过、整改闭环和交付证据齐全时，才能把成功的 Task 送入 settle。代码/资产任务如果声明了 merge gate，必须有 merge operation；非代码任务没有 merge 要求。失败、blocked、waiting 和 cancelled 任务也必须执行收拢，但其终态不能伪装为成功，也不要求不存在的 merge。

## 8. 执行 agent：每个能力的输入输出

执行 agent 是 pipeline 中的能力执行者。每个执行 agent 必须声明：

- `agentId` 和能力版本；
- 接受的输入 schema；
- 产生的输出 schema；
- 所需权限和外部依赖；
- Harness 提供的能力要求和健康摘要；
- 可取消 operation 和 settle 规则；
- 输入、输出和证据引用的保存方式。

### 8.1 统一执行流程

```text
等待节点准入
  → 接收节点输入
  → 执行 operation
  → 发布阶段性输出
  → 完成 / 等待 / 失败 / 取消
  → 提交 evidence refs
  → 返回 WorkResult
```

agent 卡片只展示：当前状态、输入摘要、输出摘要、最近更新时间和是否需要处理。动态过程抽屉展示过程摘要、工具/操作结果引用和当前输出；原始大对象进入证据入口。

### 8.2 推理状态的呈现规则

运行中可以呈现：

- “正在检查目录”；
- “正在合并结果”；
- “等待上游输出”；
- “已完成 2/4 个分片”；
- “下一步将校验索引”。

不呈现：

- 私有 chain-of-thought；
- 没有证据的假进度百分比；
- 把模型内部 token 或 DSH session 当作任务状态；
- 把 debug 日志直接当作用户可读结论。

## 9. Harness 健康诊断：能力自检入口

健康诊断不是任务完成状态，也不是一个 agent。每个 Organ/执行能力声明基础功能，由 Harness Runtime 的 health probe manager 定期或按需执行 typed probe：

```text
能力声明
  → probe 选择
  → 受控测量
  → 维度聚合
  → 健康快照
  → 影响任务准入/Attention
```

最小维度：

- 可启动；
- 可接受输入；
- 可产生输出；
- 可保存证据；
- 可停止并收拢；
- 依赖可用。

健康快照只影响准入、降级和 Attention，不重写 Task lifecycle。原始 probe 证据从 `interaction.html` 的诊断入口查看，任务页面只显示“可继续 / 受限 / 需要处理”等摘要。

## 10. 反馈、错误和控制路径

### 10.1 后台错误

执行/review/memory agent 或执行 adapter 出错时：

```text
局部错误
  → 保存输入/输出/影响
  → 重试或替代路径（受局部上限约束）
  → waiting / degraded / failed
  → 保留恢复责任
  → 影响用户承诺时发布 Attention
```

后台不会因为一次失败自动结束任务，也不会无限重复同一失败操作。

### 10.2 前台反馈

以下事件必须进入交互 agent 的用户反馈入口：

- 当前任务目标受到影响；
- 需要改变范围、权限或发布选择；
- 需要用户补充输入；
- 产生 skill review 候选；
- 后台长期等待且没有可继续的工作；
- 错误影响了当前用户承诺。

反馈先到 `task.html` 的 Task Detail；任务看板只显示“需要你处理”和摘要，不在 agent 卡片中直接完成决策。

### 10.3 steer 和停止

steer 不进入交互 agent 的业务需求队列。它的入口只有 `interaction.html` 的控制区域或明确的 `OrganUiCommandPort`：

```text
steer command
  → 权限检查
  → 关闭旧执行的新操作入口
  → 请求取消可取消 operation
  → 等待实际 settle
  → 提交 stopped checkpoint
  → 更新任务看板和 Task List
```

取消请求返回不等于停止完成。看板在实际收拢前显示 `stopping`，不能假装 `stopped`。

## 11. UI 入口到 agent 流程的映射

| UI 入口 | 读到的 projection | 可发出的 command | 不允许做的事 |
|---|---|---|---|
| Dashboard | 全局任务摘要、待处理和最近输入 | 导航到任务/新建任务 | 不显示 agent 内部流程，不直接派发 |
| Task List | 任务索引和分组状态 | 打开运行看板或 Task Detail | 不在列表中选择方案，不展开推理过程 |
| Task Detail | draft、调查结果、建议、review、任务输出 | 确认、调整、拒绝、补充输入、review | 不直接写 Journal，不调用 DSH，不绕过确认门 |
| Task Dashboard | 任务摘要、agent preview、反馈摘要 | 打开 agent 过程、进入 Observation 或 Task Detail | 不改变队列、不重试、不 steer、不入库 skill |
| Observation | 节点树、节点详情、输入/输出/evidence refs | 进入/返回子 scope、打开 drawer | 不消费队列、不修改任务、不执行控制 |
| Operator Console | Attention、health、checkpoint、operation 状态 | continue、steer、stop、诊断 | 不把业务输入塞入控制 payload |

## 12. MVP 实现切片

本设计完成后的下一步不是直接接 DSH，而是按以下顺序实现高层闭环：

1. `contracts`：固定 `RequirementDraft`、`RequirementEnvelope`、`WorkResult`、`SkillCandidate`、agent observation 和 command 类型。
2. `core`：固定确认门、FIFO 序列、队列注册、反馈状态迁移、review 状态和控制/业务隔离不变量。
3. `runtime`：实现交互 agent → FIFO → 任务编排 agent → fake execution agent → feedback → output/review。
4. `adapters/testing`：提供可重复的执行 agent、失败、等待、取消、迟到反馈和 skill candidate fixture。
5. `packages/ui/projection`：把上述 typed state 映射为现有六个入口，不再新增页面类型。
6. `packages/ui`：实现 Task Detail 的 review/确认状态、Task Dashboard 的 agent preview/drawer、Observation 的递归只读路径。
7. `app/standalone`：用一个实际入口运行成功、等待、Attention、review 和 steer 样本。

### MVP 不做

- 不连接真实 DSH；
- 不允许 agent 通过聊天文本改变控制状态；
- 不自动发布 skill；
- 不把动态摘要当作私有思维链；
- 不增加第二套 UI shell、第二个任务列表或第二条状态真源。

## 13. 验收证据

完成本轮 agent flow 设计的证据：

- 每个 agent 有唯一 owner、输入、输出、入口和禁止动作；
- 交互确认、FIFO、编排准入、执行反馈、记忆 review、健康诊断和 steer 分属不同路径；
- UI 入口能映射到 projection/command port，页面不承担 runtime 状态；
- 用户决策和运行观测没有共用组件责任；
- 动态过程是证据摘要，不伪造私有推理；
- 后续 MVP 实现顺序与 `mvp-to-milestones.md` 一致；
- DSH 仍处于 adapter 以后阶段，本文没有宣称 DSH 接入完成。
