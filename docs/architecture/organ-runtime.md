# Organ Runtime 架构设计

状态：`MVP-IMPLEMENTATION / M1-PREPARATION`
日期：2026-09-11
高层原则：HumanAgent 拥有领域状态；DSH 是可替换执行后端。

当前冻结的 UI 责任和各 agent 的详细流程、入口、反馈边界见 [`agent-flows.md`](agent-flows.md)。Agent 的 prompt/skills/tools 装载见 [`agent-templates.md`](agent-templates.md)；宿主启动、Cordis 第一层插件宿主和 Agent Driver 边界见 [`host-and-cordis.md`](host-and-cordis.md)；Memory 的交互面、Operations Backend、Index 和 Agent Context Injection 见 [`memory-system.md`](memory-system.md)；阶段闭环和故障 owner 见 [`lifecycle-and-failure-ownership.md`](lifecycle-and-failure-ownership.md)。本文件继续作为领域状态、生命周期、模块 owner 和 DSH 解耦边界的上层真源。

## 1. 问题定义

长程运行不是让一次模型推理无限延长，而是由可恢复的执行轮次组成：

```text
checkpoint recall
        ↓
装配有限工作窗口
        ↓
执行一个 cycle
        ↓
发布前台事件/处理后台故障
        ↓
checkpoint completion
        ↓
继续、等待、steer 收尾或交接
```

系统必须同时支持两种责任：器官在局部错误后继续承担恢复责任；显意识在影响用户承诺的错误发生时立即反馈。

## 2. 设计边界

### 2.1 HumanAgent 拥有

- `OrganId`、`TaskId`、`DirectiveId`、`CycleId`、`OperationId`、`CheckpointId`。
- 任务目标、当前指令版本、执行代次、状态迁移、等待条件和下次允许动作。
- checkpoint 的提交顺序、恢复内容、窗口策略和高层错误等级。
- steer 的权限判断、停止 operation、收拢 checkpoint 和对外结果。
- 后台/前台错误策略及 attention 事件。

### 2.2 DSH 只提供

- 一个具体执行后端：模型请求、工具调用、会话执行、原生取消和原生 session 证据。
- adapter 所需的 provider/model/agent/session 能力。
- 可选的 DSH session log 读取或事件订阅。

DSH 不决定 HumanAgent 任务是否完成、是否等待、是否 stopped，也不拥有 HumanAgent checkpoint。

### 2.3 真源分离

| 事实 | 唯一来源 | 不能由什么重建 |
|---|---|---|
| 当前任务/器官状态 | Organ Journal 的已提交 checkpoint | DSH 日志、debug 输出、模型摘要 |
| 历史执行细节 | DSH Session Log 和资产引用 | 高层摘要 |
| 可检索历史 | Index projection | Index 自身不能产生新状态 |
| 当前窗口 | Runtime 按 checkpoint + query 装配 | 不能回写为隐式状态 |
| 前台告警 | Organ Journal 的 attention 记录与 `AttentionPort` 投递结果 | 不能只存在 DSH 日志或 debug 输出中 |

## 3. 包和模块

```text
packages/
  contracts/
    ids.ts                 高层身份类型
    domain-events.ts       Organ Journal 事件
    checkpoint.ts          恢复状态和提交记录
    health.ts              器官基础功能、探针和健康诊断结果
    requirement.ts         显式 Brain 确认后的 FIFO 需求信封
    pipeline-observation.ts 潜意识流水线节点和只读观测投影
    task-interaction.ts    任务输入、输出和交互请求
    ports.ts               端口接口
    errors.ts              可观测错误分类

  agent-templates/         角色模板 registry、manifest 校验和 compiled snapshot

  core/
    lifecycle.ts           纯状态迁移
    permissions.ts         steer/操作权限
    error-policy.ts        后台分层与前台即时反馈策略
    checkpoint-rules.ts    seq、前继、提交和收拢不变量
    windows.ts             工作/汇报窗口规则
    health-policy.ts       健康状态分类和诊断不变量

  runtime/
    coordinator.ts         cycle 编排
    recall.ts              checkpoint 恢复
    completion.ts          cycle 结束收拢
    steering.ts            steer 到停止 operation
    supervision.ts         器官级恢复和升级
    attention.ts           前台反馈
    diagnosis.ts           探针调度、测量汇总和自诊断快照
    explicit-intake.ts     感知输入获取、归并和 FIFO 投递
    implicit-orchestrator.ts 分类队列、任务关联、资源准入和流水线创建
    agent-runtime.ts       Agent Runtime 启动、绑定、释放和 execution epoch
    orchestration-pool.ts  编排 agent runtime pool、idle 复用和资源准入
    node-runtime.ts        固定节点生命周期和策略 dispatch
    node-strategies.ts     serial/parallel/review/wait/reconcile 策略注册
    agent-template-loader.ts 将已校验的模板 snapshot 装配到 Agent Runtime，不拥有模板 authoring/校验真相
    agent-driver.ts        统一 Agent Driver 启动、观测、停止和收拢
    review-coordinator.ts  review、整改、复审和 merge gate
    memory-coordinator.ts  memory agent binding、查询和 skill review 接缝
    memory-context.ts      Agent Context Injection 的 scope、层级和 evidence 装配
    observation.ts          递归节点观测 projection 编排
    task-interaction.ts    任务输入收集和输出交付编排

  adapters/
    jsonl/                  Organ Journal 追加存储
    sqlite/                 可重建 Index
    filesystem/             大对象、工具结果和不可变资产
    operations/             进程/文件/远端副作用
    dsh/                    DSH ExecutionRuntimePort 实现
    cordis/                 Cordis provider bridge；只存在于 app/adapter 边界
    memory/                 deterministic、full-text、vector/RAG、Memmy-like backend adapters
    testing/                fake、故障注入和 replay backend

  ui/
    contracts/              Task List、Dashboard/Task Detail/Task Dashboard 和 Organ Console view model/command
    projection/             Runtime snapshot/event → UI projection
    surfaces/               target/planned 产品 surface 实现；当前仅含静态 replay fixture
    shell/                  target/planned HumanAgent 产品壳和导航；当前产品 UI 位于 docs/ui
    kit/                    target/planned HumanAgent semantic UI primitives facade

  app/
    src/                    当前可执行组装入口
      cli.ts                当前 CLI；serve --mode fake 启动本地 Runtime/UI
      cordis-host.ts        当前 Cordis Host、固定 kernel 和 plugin registry
      entry-composition.ts  当前 serve plugin composition 和 manifest 校验
      supervisor/           当前 Host 启动、关闭、plugin lock 和 provider 监督
      ui-runtime/           当前 Runtime API、SSE 和 UI server
    standalone/             target/planned（Milestone 1）；当前不存在
    cordis-host/            target/planned（仅在需要目录拆分时）；当前实现是 src/cordis-host.ts
    dsh-plugin/             target/planned（Milestone 1）
    configuration/          target/planned（当前配置 owner 是 packages/config）
```

依赖只能向下：`contracts ← core ← runtime ← app`。adapter 实现 ports，不向 `core` 导入；DSH 类型只能出现在 `adapters/dsh` 和其测试中。

UI 是独立的呈现边界：当前 `runtime → ui/projection → docs/ui`，由
`packages/app/src/ui-runtime` 提供 Runtime API 和静态 UI server；target/planned
的 `ui/surfaces` 与 `ui/kit` 仍需保持同一 typed view model/command 边界。UI
只能接收 typed view model 和 command port；不能直接读取 Journal、调用 DSH
Session、从 debug 日志重建状态，或把 React store 当作运行时真源。

## 3.1 Brain 分层与任务流

HumanAgent 的“Brain”是两个不同责任的逻辑层，不是两个互相复制状态的模型实例：

```text
感知器官 / 人类输入 / 外部通知
              │
              ▼
显式 Brain：获取、去噪、整理、匹配、确认后形成需求
              │  FIFO Requirement Inbox
              ▼
隐式 Brain：分类、更新运行任务、资源准入、创建执行流水线
              │
              ▼
Organ / Task Pipeline / Operations
              │
              ├── Task List：当前运行、需要人决策、历史任务索引
              ├── Dashboard / Task Detail：总览、输入理解、确认、输出、artifact
              ├── Organ Console：状态、Attention、steer
              └── Observation：只读递归观测链
```

### 显式 Brain：把感知变成可处理的需求

显式 Brain 控制眼、耳、喉、鼻等感知和输入器官的接入，但不在感知入口执行深层任务推理。它承担输入理解和确认前的交互编排；它不在用户确认前向后台派发。流程固定为：

```text
input.received
  → task.match
  → status.lookup
  → intent.query
  → explicit.brain.feedback
  → user.confirm
  → requirement.dispatch
  → FIFO RequirementInbox
```

它承担以下职责：

1. 获取通知、人类输入、外部事件和感知器官结果。
2. 对原始输入做去重、归并、基本清洗和来源标注。
3. 根据在线/历史任务、当前状态、最近节点和相关 Organ 摘要，形成待确认的意图草稿。
4. 向人反馈匹配依据、状态影响和整理结果，询问“追加、变更、新建，还是只查询状态”。
5. 只有用户确认后，才把草稿固化为可派发的 `RequirementEnvelope`，按到达顺序写入 FIFO `RequirementInbox`。

显式 Brain 的整理是表层需求整理，不等于任务分类完成，也不等于已经创建执行任务。确认前只能存在显式层的草稿和交互状态；它可以发现已有任务关联线索，但不能绕过用户确认、潜意识的分类和资源准入。

`RequirementDraft` 和 `RequirementEnvelope` 的规范字段定义见 [`agent-flows.md`](agent-flows.md)；本节只规定它们的领域不变量：Envelope 只能由确认结果产生，FIFO 只接收 Envelope，控制命令不能混入业务需求队列。

`RequirementInbox` 是业务需求的 FIFO 输入队列，只接收已确认的 `RequirementEnvelope`。状态查询意图不形成 `RequirementEnvelope`，只返回状态投影。`steer`、停止、权限撤销、健康升级等控制命令不塞入业务需求队列，而走独立的控制通道；控制优先级不能通过伪造需求类型获得。

显式 Brain 的交互状态不是后台任务状态，至少要能区分：`received`、`matching`、`status-checking`、`awaiting-intent`、`awaiting-confirmation`、`confirmed`、`dispatched`、`status-only` 和 `rejected`。未进入 `confirmed` 前，`ImplicitSchedulingPort` 不得收到可创建流水线的输入。

### 隐式 Brain：分类、调度和准入

隐式 Brain 是由 Runtime Coordinator 和编排 agent 组成的分层责任，不是第二个拥有全部状态的模型。Runtime Coordinator 消费 `RequirementInbox` 并负责分类、关联和准入；编排 agent 只接收准入后的需求，负责计划、派发和推进：

1. **分类检查**：依据需求契约、关联线索、权限和当前状态，把需求路由到独立工作队列。MVP 先保留最小分类集合，队列类型必须是显式注册的，不能靠字符串临时创建。
2. **运行任务更新**：如果需求带有有效 `TaskId`、correlation key 或已确认的关联关系，则追加为该任务的输入/更新事件；不得通过覆盖旧状态或直接插入执行器上下文来更新任务。
3. **资源准入**：检查所需 Organ 能力、健康摘要、权限、并发额度、依赖、输入完整性和 checkpoint 可恢复性。
4. **流水线创建**：只有准入通过后，才创建新的 Task Pipeline；资源不足、输入不完整或依赖不可用时进入明确的 waiting/blocked 路径，并保留下一次检查条件。

初始队列可以按以下职责划分；具体数量在实现前以需求样本收敛：

| 队列 | 处理内容 | 顺序规则 |
|---|---|---|
| `interactive` | 需要显式输入、回答或审批的任务 | 队列内 FIFO；等待人的请求不能伪装成运行中 |
| `execution` | 已具备输入和资源、可以创建执行流水线的任务 | 队列内 FIFO；受资源准入和背压限制 |
| `research` | 信息收集、比较、核验和分析任务 | 队列内 FIFO；外部依赖不足时等待 |
| `maintenance` | checkpoint、索引、健康诊断和恢复维护 | 队列内 FIFO；不能抢占正在收拢的 operation |
| `control` | steer、停止、权限撤销和安全升级 | 独立控制通道，不属于业务需求 payload |

“插队”不是任意改变 FIFO 顺序：对运行中任务的最新输入，先走任务关联和 mailbox 更新；对停止、权限和安全事件，走独立控制通道；普通新需求只在各自队列内 FIFO，并由明确的调度策略在队列之间仲裁。

### Pipeline 节点与完整观测

潜意识可以不直接被人消费，但不能不可观测。每条需求的处理必须形成可投影的节点链/节点树：

```text
sensory.inbox
  → explicit.normalize
  → implicit.classify
      ├── interactive.queue
      ├── execution.queue
      ├── research.queue
      └── maintenance.queue
  → task.correlate-or-create
  → resource.admission
  → pipeline.execute
  → settle
  → task.output
```

节点是观测事实，不是第二套控制状态。每个节点至少包含：

```ts
type PipelineObservationNode = {
  nodeId: string
  parentNodeId: string | null
  kind: string
  status: 'created' | 'admitted' | 'running' | 'settling' | 'waiting' | 'blocked' | 'succeeded' | 'failed' | 'cancelled' | 'stopped' | 'stale' | 'unknown'
  startedAt?: string
  endedAt?: string
  inputRefs: string[]
  outputRefs: string[]
  evidenceRefs: EvidenceRef[]
  childScopeRef?: string
  owner: string
}
```

观测 UI 使用只读 `PipelineObservationProjectionPort`：

- 当前层显示完整节点序列、节点状态、更新时间、输入/输出引用和异常标记。
- 点击节点打开详情 drawer；drawer 只读，不执行消费、重试、修改或隐式 steer。
- 节点有子节点时，可以进入下一层 scope；面包屑和返回栈保留完整路径。
- 每一层都必须有自己的完整观测摘要，不能只显示“展开后的一段日志”。
- 进入子层后，仍可返回父层；父层快照的 seq/cursor 必须保持可追溯。
- 观测详情来自 typed projection 和 evidence refs，不能从 debug log 临时拼装控制状态。

这样既保持潜意识对人的默认隐式性，又保证发生阻塞、错误、资源不足或恢复问题时，能够沿节点递归定位到具体阶段、输入、输出和证据。

## 3.2 固定 Harness 节点和可替换编排策略

Harness 不是“让一个 agent 自由决定下一步”的循环，而是一条固定的、可恢复的节点协议。节点是任务执行的最小编排单元；节点内部可以选择不同策略，但所有节点都必须经过相同的 Harness 生命周期和控制门：

```text
admit
  → plan
  → dispatch
  → observe
  → settle
  → checkpoint / next-action
```

节点本身只保存领域引用和状态，不保存一份平行的任务真相：

```ts
type HarnessNode = {
  nodeId: string
  parentNodeId: string | null
  nodeKind: string
  orchestrationPolicyRef: string
  inputRefs: string[]
  outputContractRef: string
  ownerRef: string
  executionEpoch: number
}

interface NodeOrchestrator {
  admit(input: NodeAdmission): Promise<NodeAdmissionResult>
  plan(input: NodePlanRequest): Promise<NodePlan>
  dispatch(input: NodeDispatchRequest): Promise<NodeDispatchResult>
  settle(input: NodeSettleRequest): Promise<NodeClosure>
}
```

可替换的 `orchestrationPolicyRef` 只改变节点内部的调度方式，例如：

- `serial`：单步执行后再进入下一节点；
- `parallel-join`：受资源准入约束的 fan-out/fan-in；
- `retry-with-bound`：有上限的重试，耗尽后转等待、升级或失败；
- `wait-for-condition`：等待外部条件，并留下下一次检查动作；
- `review-remediation`：审计、整改、复审闭环；
- `human-confirmation`：需要用户选择的显式门；
- `memory-analysis`：历史检索、比较和沉淀建议；
- `external-reconcile`：副作用未知时先核对，不盲目重做。

策略不能改变以下固定事实：确认门、权限门、资源准入、节点状态、Journal/checkpoint 提交、review gate、stop/settle 语义、健康 owner、错误升级和唯一 owner。策略插件返回非法状态或未声明的下一动作时，Harness 拒绝推进并把问题交给该节点 owner。

## 3.3 统一 Agent 抽象和 Driver

模板定义 agent“应当如何工作”，Driver 定义“由什么执行”，Runtime 定义“本次运行实例”，Harness 定义“何时可以启动、停止、恢复和接受结果”：

```text
Agent Template
      ↓
Agent Definition
      ↓
Agent Driver
  ├── deterministic/fake
  ├── dsh
  ├── native
  └── remote/other
      ↓
Agent Runtime Instance
```

高层只依赖统一的 driver port：

```ts
type AgentDefinition = {
  agentId: string
  roleId: string
  templateRef: string
  capabilityRefs: string[]
  inputSchemaRef: string
  outputSchemaRef: string
}

interface AgentDriver {
  kind: string
  capabilities(): Promise<AgentCapabilities>
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

该接口的完整语义、旧 `submit/resume` 兼容映射和结果/流的分离以 [`agent-request-response.md`](agent-request-response.md) §10 为唯一真源。`send` 只返回 dispatch receipt；最终结果必须由 `readResult` 读取，`observe` 只提供有 cursor 的证据流。

Driver 不拥有 Task、Journal、checkpoint 或 Harness gate；它不能自己创建平级 agent，也不能把 provider session 当作高层身份。DSH driver 是一个可选插件，未来 native/remote driver 使用完全相同的高层 contracts、节点协议和错误闭环。Driver 的输入输出必须经过模板 schema、assignment contract、epoch fence 和 evidence policy 校验。

## 3.4 WebUI 复用策略

结论：**自己拥有 HumanAgent 产品 UI；选择性复用 DSH 的纯视觉 primitives；不复用 DSH 整套 WebUI。**

| DSH 部分 | 当前源码事实 | HumanAgent 决定 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-primitives` | 纯 React atoms；README 声明 zero Cordis；覆盖 Button、Modal、Toast、Markdown、Terminal、Diff、Search、JSON 等 | 作为 Milestone 1 的可选视觉依赖候选；必须先锁定公开版本、license、tokens 和 bundle 证据 |
| `@deepseek-ai/dsh-client-ui-slots` | React-free/Cordis-free 的 slot contract，但属于 DSH client composition model | 只借鉴 slot 组合思想；不把 DSH SlotMap 作为 HumanAgent runtime contract |
| `ui-conversation` | 绑定 Session Controller、`SessionEventLikeEntry`、`ctx.uiConversation`、`ctx.uiSession` 和 DSH session attachment | 不直接复用；其 Conversation shell 不能代表 Organ/Task/Checkpoint 语义 |
| `ui-session` | DSH Session Controller 的 React/Slot adapter，向组件提供 `SessionSnapshot`/`SessionId` | 不直接复用；HumanAgent 需要自己的 `OrganUiProjectionPort` |
| `ui-renderer` / `client-web` | DSH 浏览器启动、Cordis roster、slot renderer 和 assembled application root | 不复用为产品壳；否则高层被 DSH boot/roster/lifecycle 绑定 |
| `web-app` | 聚合大量 DSH client/UI/remote/session 包的完整 browser-surface bundle | 不作为 HumanAgent 依赖；它是 DSH 应用组装包，不是可嵌入的中立 UI |

HumanAgent UI 的最小接口：

```ts
interface OrganUiProjectionPort {
  snapshot(scope: OrganUiScope): Promise<OrganConsoleSnapshot>
  observe(scope: OrganUiScope): AsyncIterable<OrganConsoleEvent>
}

interface OrganUiCommandPort {
  dispatch(command: OrganUiCommand): Promise<UiCommandReceipt>
}
```

`OrganConsoleSnapshot` 只包含 Organ、Task、Cycle、Operation、Checkpoint、Attention、Window 和 capability 状态；`OrganUiCommand` 通过 runtime command owner 执行 `continue`、`steer`、`inspect`、`acknowledge` 等动作。UI 不直接调用 DSH 的 stop/cancel API。

HumanAgent 需要五类不同的人类界面：

| 界面 | 人看到什么 | 允许做什么 | 默认是否暴露器官内部细节 |
|---|---|---|---|
| **Task List** | 当前运行、任务状态、需要人决策、历史任务和下一步 | 搜索、筛选、进入任务详情 | 否；不展开显式决策流或器官内部细节 |
| **Dashboard** | 待处理事项、正在处理的任务、最近输入和历史任务 | 进入任务、进入列表、提交新的输入 | 否；只显示简洁状态 |
| **Task Detail** | 具体任务的输入、调查结果、建议方案、选择、输出和任务观测入口 | 处理任务、选择方案、查看任务后台记录 | 只显示与任务有关的能力摘要；详细内部状态走任务观测 |
| **Task Dashboard** | 单个运行任务中的 agent、输入/输出预览、当前进度和用户反馈需求 | 打开 agent 动态摘要、进入任务观测或需要决策的 Task Detail | 不直接改变队列、重试、steer 或入库 skill |
| **Organ Console** | 任务/器官状态、Attention、checkpoint、可执行控制 | continue、steer、inspect、acknowledge | 否；诊断是特殊入口 |

Organ Diagnostics 是两个界面都可以链接到的只读特殊入口，用于查看基础功能、探针结果、测量、证据引用和恢复建议。它不应成为正常任务输入输出路径，也不能让人通过修改诊断字段直接改变控制状态。

UI 分阶段处理：

- MVP：自己实现最小 Task List + Dashboard + Task Detail + Task Dashboard + Operator Console，使用语义 HTML/CSS 和少量 `kit`；证明任务索引、输入理解确认门禁、任务输入输出、agent 输入/输出预览、状态呈现、错误可见、steer 结果可见、断线/过期状态不伪装；为一个 Organ 提供确定性基础自诊断摘要。
- Milestone 1：评估 DSH `ui-primitives` 作为视觉积木；即使采用，也只能在 target/planned `ui/kit` facade 后，不让 DSH Session/renderer 类型进入 `ui/contracts`。
- Milestone 2：实现长程专属的 history/checkpoint/attention/operation inspector、健康趋势和诊断历史；UI 订阅 projection，不读取 Journal 文件。
- Milestone 3：完善多任务、多器官、权限、背压、部署和可观测界面；保留 DSH-specific execution detail 为可选面板，不让它取代 HumanAgent 产品壳。

## 4. 领域对象

### Organ

长期承担任务责任的运行单元。它可以有故障实例，但器官责任不会因一次错误自动终止。

### Task / Directive

`Task` 是目标和生命周期身份；`Directive` 是可版本化的当前指示。checkpoint 必须记录 `directiveRevision`，恢复时不得默默使用旧指令。

### Cycle

一次 recall → work → completion 的有限执行轮次。没有新条件时，cycle 应进入 wait，而不是无限空转。

### Operation

可审计、可取消或需收拢的副作用动作，例如模型执行、工具调用、停止、保存、归档和恢复。Operation 有独立状态和结果引用。

### Checkpoint

一次已提交的高层恢复状态。它是链式历史记录，不是覆盖式快照。每条记录应至少包含：

```ts
type CheckpointRecord = {
  type: 'checkpoint.committed'
  schemaVersion: number
  checkpointId: CheckpointId
  organId: OrganId
  taskId: TaskId
  cycleId: CycleId
  seq: number
  previousCheckpointId: CheckpointId | null
  directiveRevision: number
  executionEpoch: number
  outcome: 'succeeded' | 'partial' | 'waiting' | 'stopped' | 'blocked' | 'failed' | 'cancelled' | 'unknown'
  summary: string
  recoveryStateRef: AssetRef
  evidenceRefs: EvidenceRef[]
  next: NextAction
}
```

`recoveryStateRef` 指向准确、尽量小且可独立读取的恢复状态；详细工具输出通过 `evidenceRefs` 和不可变资产引用关联。

### Attention

面向显意识的即时错误/状态事件。重复的同一故障更新同一 attention；影响扩大提升等级；恢复发送解除事件。Attention 不转移器官恢复责任。

### Organ Capability / Self-Diagnosis

每个 Organ 必须声明一组最小基础功能。基础功能不是 DSH 工具清单，而是这个器官对自身责任的可验证承诺，例如：

- 能否读取并恢复自己的 checkpoint。
- 能否启动、收拢和报告 operation。
- 能否接收当前 directive，并在正确的 execution epoch 下继续工作。
- 能否保存 Journal/asset 引用，且不产生不可验证的完成状态。
- 能否发布 Attention，并在故障解除后发布恢复事件。
- 能否访问自身声明的依赖、资源和权限边界。

每项基础功能由一个或多个 typed health probe 判断。Probe 只能读取声明过的状态、operation 结果、资源测量和依赖能力；不能从 debug log 猜测控制状态，也不能为了“通过健康检查”修改业务状态。

健康判断至少分成以下维度：

| 维度 | 说明 | 典型证据 |
|---|---|---|
| `liveness` | 器官监督循环仍能运行 | heartbeat、诊断 cycle 完成 |
| `readiness` | 当前具备接收下一项工作的条件 | 依赖、权限、窗口、资源检查 |
| `correctness` | 最近结果和 checkpoint 链仍满足不变量 | replay、digest、前继和 epoch 校验 |
| `continuity` | 出错或重启后仍有明确恢复路径 | recovery state、未完成 operation、下一动作 |
| `capacity` | 当前资源和背压没有超出声明边界 | 队列、并发、存储、超时测量 |
| `dependency` | 必需外部能力是否可用 | typed capability probe、版本/连接结果 |

健康状态与生命周期状态必须分开：`running`、`waiting`、`stopped` 描述任务/执行状态；`healthy`、`degraded`、`attention`、`unhealthy`、`unknown` 描述器官基础能力。一个 Organ 可以处于 `waiting + healthy`，也可以处于 `running + degraded`，不能用一个字段覆盖两种事实。

自诊断输出的是带时间、证据引用和有效期的 `OrganHealthSnapshot`，而不是新的控制真相。只有 core 的健康策略可以将诊断结果映射为降级、等待或 Attention；UI 只接收投影后的摘要和按需诊断详情。

建议的最小模型：

```ts
type OrganHealthSnapshot = {
  organId: OrganId
  checkedAt: string
  expiresAt: string
  overall: 'healthy' | 'degraded' | 'attention' | 'unhealthy' | 'unknown'
  functions: Array<{
    functionId: string
    status: 'healthy' | 'degraded' | 'failed' | 'unknown'
    measurements: Array<{ name: string; value: string | number; unit?: string }>
    evidenceRefs: EvidenceRef[]
    nextCheckAt?: string
  }>
}
```

MVP 只要求确定性的基础探针和一次诊断快照，不做预测性健康评分。长期趋势、基线和异常检测属于 Milestone 2；多器官聚合和运维告警属于 Milestone 3。

### Task Interaction

Task 不只是一个后台执行身份，还必须有明确的输入输出契约。正常人类交互使用独立的 Task List / Dashboard / Task Detail / Task Dashboard：

- 输入：初始指令、参数、补充回答、审批决定和附件引用。
- 输出：可读摘要、结构化结果、不可变 artifact 引用、当前结果状态和下一步。
- 交互请求：器官无法在不猜测的情况下继续时，发布带 schema、原因、影响和有效期的 `TaskInputRequest`。
- 任务控制：`steer`、停止收拢和后台诊断仍归 Organ Console/控制端口，不由任务 payload 冒充。

Dashboard / Task Detail 只消费 typed projection 和 command port，不直接读取 Journal、DSH Session 或健康探针原始输出。健康只以“可继续/受限/需要处理”等与任务相关的摘要出现在正常界面；原始测量、探针证据和恢复建议属于特殊的 Organ Diagnostics 入口。

## 5. 生命周期和错误策略

Host/Organ runtime 的启动状态是 `starting → ready → stopping → stopped|failed`；Task/Cycle 的工作状态是 `created → admitted → running → settling → succeeded|waiting|blocked|failed|cancelled|stopped|unknown`。`degraded` 只表示能力受限，不表示任务责任结束；`faulted` 只允许作为具体 operation/执行实例的结果，不作为器官终态。每次从 `running` 离开都必须有 settle 证据，不能直接跳到成功或停止。

### 后台器官错误

```text
operation error
  → 保留错误和状态
  → 在安全且有上限时重试/修正
  → 切换已授权的替代步骤或降级能力
  → 需要时从 checkpoint 重建执行实例
  → 影响扩大/长期不可恢复时发布 attention
  → 留下下一动作、恢复条件和负责者
```

禁止无条件重复同一失败操作。禁止把证据不足的降级结果标为成功。

### 显意识错误

先发布可见错误事件，再执行恢复或收尾；错误反馈不能被 checkpoint completion 阻塞。若显意识模型不可用，宿主直接发布结构化错误，不再次调用同一个失败模型解释。

### steer

```text
steer command
  → 权限和目标 executionEpoch 检查
  → 关闭旧执行的新操作入口
  → 请求取消可取消 operation
  → 等待/观察不可取消 operation 的安全边界
  → 执行标准 settle operation
  → 提交 stopped checkpoint
  → 对外报告实际停止结果
```

取消请求返回只证明“已请求取消”；只有 operation 结果、资源状态和 stopped checkpoint 共同证明停止完成。

## 6. Ports

以下是高层最小接口草案；名称和具体语言待实现阶段锁定。

### 6.1 跨 adapter 的基础类型

这些类型属于 `contracts`，不能携带 DSH 类型：

```ts
type AssetRef = {
  assetId: string
  digest: string
  mediaType: string
  byteLength: number
}

type EvidenceRef = {
  kind: 'execution' | 'tool' | 'operation' | 'external'
  source: string
  locator: string
  digest?: string
}

type NextAction =
  | { kind: 'continue' }
  | { kind: 'wait'; conditionRef: string }
  | { kind: 'stop'; reason: string }
  | { kind: 'recover'; recoveryRef: AssetRef }

type ExecutionEvent = {
  executionEpoch: number
  operationId: OperationId
  kind: 'started' | 'output' | 'tool' | 'failed' | 'cancelled' | 'settled'
  evidenceRefs: EvidenceRef[]
}
```

`source` 和 `locator` 只定位证据，不承载高层控制状态。DSH session ID 可以出现在 adapter 生成的 `EvidenceRef.locator`，但不能替代高层 ID。

### 6.2 ExecutionRuntimePort

```ts
interface ExecutionRuntimePort {
  start(input: StartExecution): Promise<ExecutionHandle>
  resume(input: ResumeExecution): Promise<ExecutionHandle>
  reconcile(input: ReconcileExecution): Promise<ExecutionReconciliation>
  requestStop(input: StopExecution): Promise<StopRequestReceipt>
  settle(input: SettleExecution): Promise<SettledExecution>
  observe(input: ObserveExecution): AsyncIterable<ExecutionEvent>
}

interface OrganJournalPort {
  append(record: JournalRecord): Promise<AppendReceipt>
  readCheckpoint(id: CheckpointId): Promise<CheckpointRecord>
  readLatest(scope: JournalScope): Promise<CheckpointRecord | null>
  replay(scope: JournalScope, fromSeq?: number): AsyncIterable<JournalRecord>
  verify(scope: JournalScope): Promise<JournalVerification>
}

interface IndexPort {
  query(input: HistoryQuery): Promise<HistoryPage>
  rebuild(scope: JournalScope): Promise<RebuildReceipt>
}

interface AssetStorePort {
  put(input: ImmutableAsset): Promise<AssetRef>
  get(ref: AssetRef): Promise<ReadableAsset>
  verify(ref: AssetRef): Promise<AssetVerification>
}

interface OperationPort {
  execute(input: OperationRequest): Promise<OperationResult>
  cancel(id: OperationId): Promise<CancelReceipt>
  inspect(id: OperationId): Promise<OperationStatus>
}

interface AttentionPort {
  publish(input: AttentionEvent): Promise<AttentionReceipt>
  resolve(input: AttentionResolution): Promise<AttentionReceipt>
}

interface OrganHealthProbePort {
  list(organId: OrganId): Promise<HealthProbeDescriptor[]>
  run(input: RunHealthProbe): Promise<HealthProbeResult>
}

interface OrganHealthProjectionPort {
  snapshot(organId: OrganId): Promise<OrganHealthSnapshot>
  observe(organId: OrganId): AsyncIterable<OrganHealthSnapshot>
}

interface RequirementInboxPort {
  append(input: RequirementEnvelope): Promise<InboxReceipt>
  readNext(input: ReadInbox): Promise<RequirementEnvelope | null>
  acknowledge(input: AcknowledgeRequirement): Promise<InboxReceipt>
  defer(input: DeferRequirement): Promise<InboxReceipt>
}

interface ExplicitBrainInteractionPort {
  receive(input: ExplicitInput): Promise<InteractionId>
  inspect(input: InteractionId): Promise<ExplicitInteractionSnapshot>
  confirm(input: ConfirmRequirementDraft): Promise<RequirementEnvelope | StatusQueryReceipt>
  revise(input: ReviseRequirementDraft): Promise<InteractionId>
}

interface ImplicitSchedulingPort {
  classify(input: RequirementEnvelope): Promise<ClassificationReceipt>
  updateRunningTask(input: UpdateRunningTask): Promise<TaskUpdateReceipt>
  admit(input: AdmissionRequest): Promise<AdmissionDecision>
  createPipeline(input: PipelineCreationRequest): Promise<PipelineHandle>
}

interface PipelineObservationProjectionPort {
  snapshot(input: ObservationScope): Promise<PipelineObservationSnapshot>
  observe(input: ObservationScope): AsyncIterable<PipelineObservationEvent>
}

interface TaskInteractionProjectionPort {
  snapshot(taskId: TaskId): Promise<TaskWorkspaceSnapshot>
  observe(taskId: TaskId): AsyncIterable<TaskWorkspaceEvent>
}

interface TaskInteractionCommandPort {
  submit(input: SubmitTaskInput): Promise<TaskInputReceipt>
  answer(input: AnswerTaskInputRequest): Promise<TaskInputReceipt>
  attach(input: AttachTaskAsset): Promise<TaskInputReceipt>
  acknowledge(input: AcknowledgeTaskOutput): Promise<TaskInputReceipt>
}
```

Memory 的两个用户/后台入口和 Agent 上下文插入协议见 [`memory-system.md`](memory-system.md)。`runtime/memory-context.ts` 只负责按 Harness scope、role、layer 和 budget 调用该协议；它不直接读取 Index 或 RAG 数据库。

`ExecutionRuntimePort` 是所有外部执行后端的唯一高层接缝；DSH 是其中一个实现。
Provider-neutral binding/codec 属于 adapter 边界，不能把 DSH 或 RCC 类型上提到
该端口。它的事件必须携带 HumanAgent `executionEpoch`/`operationId`，不能仅返回
DSH session ID 或 RCC request/session ID。RCC `responses`/`anthropic` 协议适配
的独立边界见 [`provider-adapters.md`](provider-adapters.md)。

`OrganHealthProbePort` 负责执行可声明的基础探针；`OrganHealthProjectionPort` 只读返回带有效期的诊断快照。它们不能直接改变生命周期状态。健康策略由 core/runtime 统一决定是否产生 `degraded`、等待或 Attention。

`ExplicitBrainInteractionPort` 是显式 Brain 的输入理解和确认接缝；它负责任务匹配、状态查询、意图询问和确认结果，不直接创建执行流水线。`RequirementInboxPort` 只接收用户确认后生成的需求信封，并保持 FIFO 读取；`ImplicitSchedulingPort` 是潜意识的唯一分类、运行任务更新、资源准入和流水线创建接缝。控制命令不通过这三个业务 port 伪装成需求。

`PipelineObservationProjectionPort` 只读提供节点树和 scope 递归观测。它不提供消费、重试、修改节点或直接控制 operation 的方法；所有控制仍回到 Organ/Task command owner。

`TaskInteractionProjectionPort` 和 `TaskInteractionCommandPort` 是正常人类输入输出的唯一接缝。Dashboard / Task Detail 不通过 `OrganUiCommandPort` 伪造业务输入，也不通过任务 payload 传递 `steer`、retry 或 health 控制字段。

## 7. Journal、窗口和 Index

### Journal

JSONL 适合追加，但 JSONL 本身不提供提交协议。实现必须定义：记录序列、前继关系、segment 边界、写入确认、崩溃尾行处理、重复提交判定、资产 digest 和恢复读取。

一条提交记录应可独立验证；恢复不应依赖从第一条历史重新推导全部增量。原始历史可以分段归档，但归档动作本身也写入 Journal。

### Operation 与 checkpoint 的提交顺序

外部副作用不能在 checkpoint 之前变成“无主成功”。最小顺序是：

```text
append operation.started
  → execute with operationId/idempotency key
  → record result/evidence or explicit unknown
  → append checkpoint.completion / waiting / failed / stopped
```

如果进程在副作用发生后、checkpoint 提交前崩溃，重启时由 Runtime Operation Owner 先按 `operationId` 请求 adapter/外部系统核对结果：

- 已确认成功：追加 reconciliation result，再提交对应 checkpoint；
- 已确认失败：追加失败结果和下一动作；
- 仍未知：保持 `unknown`/`waiting`，创建 Attention 或 operator 请求，禁止盲目重做；
- 外部系统不支持核对或幂等：将 operation 标为不可自动重试，要求明确人工/策略决策。

Supervisor 只负责恢复 Host 进程和重新绑定 runtime；Journal owner 只负责记录完整性；两者都不能把未核对的副作用改写为成功。

### 三种窗口

- `Working Window`：当前推理所需的恢复状态、近期证据和明确查询结果；有界。
- `Reporting Window`：显意识需要看到的最新状态、重要变化、待决策事项；重复普通进度合并。
- `History`：完整/分级保存的 Journal 和资产引用；可以压缩或清理，但不能破坏仍被恢复状态引用的资产。

队列超限首先淘汰窗口内容，不等于立即删除权威历史。清理前必须检查引用，清理后必须保留可查询的覆盖范围和清理记录。Absolute Journal 的保留根、原始资产和可清理派生物以 [`context-contract.md`](context-contract.md) §10 为唯一真源；本节不另定义 retention 规则。

### Index

SQLite 或其他查询存储只保存从 Journal 投影的 `seq`、范围、标签、摘要、引用和位置。Index 损坏或删除后，必须从 Journal 重建；Index 不能向 Journal 反写状态。

## 8. DSH Adapter 接口

### 8.1 适配原则

- adapter 是唯一允许依赖 DSH 包、DSH session 类型和 DSH transport 的模块。
- 高层 `TaskId`、`OperationId`、`CheckpointId` 不与 DSH `SessionId` 建立一一映射；adapter 只维护显式的 `ExecutionBinding`，记录某次高层 operation 与零个、一个或多个外部 session/evidence 的实际关系。
- 高层状态转换只由 `core/runtime` 决定；DSH 事件只能作为输入事实，经 adapter 映射后进入高层事件。
- DSH 原生 session log 保留为执行证据；高层恢复只读取 HumanAgent 自己已提交的 checkpoint recovery state。adapter 的 `recoveryStateRef` 只能定位外部执行证据/会话细节，不能成为高层恢复真相。
- adapter 不得通过请求 metadata、prompt 隐藏字段或 debug 日志传递高层控制状态。
- DSH 不可用时，当前 `serve --mode fake` 可以用于测试；Milestone 1
  target/planned 的 standalone/fake backend 也受同一限制，生产路径不得静默
  切换到 fake 或未授权 fallback。
- Provider protocol adapter 不属于 `core/runtime`；它只把明确绑定的协议事实
  映射到 provider-neutral execution event。DSH bridge 可以消费该 port，也可以
  在经批准的 direct-provider 验证路径中由 Host 装载，但两者都不能改变高层
  lifecycle owner。

### 8.2 建议 adapter 内部结构

```text
packages/adapters/dsh/
  dsh-execution-runtime.ts   ExecutionRuntimePort 实现
  dsh-session-map.ts         高层 operation ↔ DSH session 映射
  dsh-event-map.ts           DSH 事件 → ExecutionEvent
  dsh-stop-controller.ts     DSH cancel/close → stop operation
  dsh-evidence-reader.ts     session log / tool result 引用
  dsh-capabilities.ts        启动时能力探测，失败显式暴露

packages/adapters/provider/
  provider-binding.ts        Provider-neutral binding/capability
  responses-adapter.ts       cc/cc-sol Responses codec
  anthropic-adapter.ts       goaichat Anthropic codec
  provider-readiness.ts      listener/protocol readiness
```

### 8.3 需要从 DSH 当前源码确认的接口

1. 创建/恢复 session 的公开 API 和持久化语义。
2. 模型请求、工具执行、session event 的可观察入口。
3. cancel、abort、close 的真实后置条件，以及是否能确认进程/资源退出。
4. session log 的顺序、版本、不可变性和读取 API。
5. plugin/package 的公开 entrypoint；禁止引用 checkout-relative `src/*`。
6. 同进程插件与子进程/IPC 的错误、超时和退出码边界。

clean DSH commit/tree 基线已经锁定；上述 public entrypoint、依赖、profile/plugin、取消、持久化和真实执行语义仍保持 `UNVERIFIED`，待 Milestone 1 的 M1-0 复核。基线证据见 [`dsh-baseline.md`](dsh-baseline.md)。

## 9. 关键时序

### 正常 cycle

```text
Runtime → Journal: read latest checkpoint
Runtime → Index/Assets: resolve required context/evidence
Runtime → Core: validate directive/epoch/next action
Runtime → ExecutionRuntime: start/resume
ExecutionRuntime → Runtime: execution events
Runtime → Attention: publish material foreground events
Runtime → Operation: settle side effects
Runtime → Journal: append checkpoint.committed
Runtime → Index: project asynchronously/rebuildably
```

### steer race

```text
steer → Core: verify target epoch
steer → Runtime: fence new work
steer → ExecutionRuntime: requestStop
execution event → Runtime: accept only matching epoch
Runtime → Operation: settle
Runtime → Journal: stopped checkpoint
Runtime → Attention: stop result
```

旧 epoch 的迟到事件必须被拒绝或标成 stale evidence，不能推进新 cycle。

## 10. 安全和完整性

- 所有外部输入在 parser/queue/model-tool JSON/durable file/process/wire 边界校验；同进程 typed port 不复制一套运行时 schema。
- 权限和停止目标绑定 `organId/taskId/executionEpoch`，禁止模糊停止当前“看起来最新”的执行。
- 资产删除前检查 Journal 引用；迁移采用 copy → verify → switch，失败保持旧引用有效。
- 错误必须保留原始分类、首次偏离和影响范围；不得吞错、伪造成功或用日志重建控制状态。
- checkpoint commit、Index projection、attention delivery、DSH session evidence 是不同证据层，不能互相替代。

## 11. 验证分层

1. `contracts` 类型/结构：非法事件、版本、ID 和引用关系拒绝。
2. `core` 纯规则：生命周期、steer、错误策略、checkpoint 不变量。
3. `runtime` fake replay：正常、工具失败、前台错误、后台降级、重启、重复提交、迟到事件。
4. Journal/Index/asset：崩溃尾行、重建、压缩、引用完整性。
5. DSH adapter：clean 版本 API 绑定、录制 session replay、真实同入口 stop/resume。
6. 交付：真实安装/启动入口、重启恢复和长程历史 replay。前一层通过不替代后一层。

## 12. 开放决定

- 首个实现语言和包管理器。
- Journal 的 segment/locking/fsync 策略。
- checkpoint 恢复状态 schema 与 schema migration 策略。
- 事件总线采用进程内 async iterator、IPC 还是持久化队列。
- DSH adapter 的部署形态和最小支持版本。
- Attention 的用户界面/通知宿主。
- 首批分类队列的固定集合、队列间调度公平性和控制通道优先级。
- 运行中 Task 的关联冲突规则：多个 correlation hint 命中、输入版本冲突和更新与新建的判定。
- Pipeline Observation 节点的 Journal 记录粒度、projection seq/cursor 和长程压缩策略。
- Organ health probe 的执行周期、快照 TTL、过期后的 unknown 处理和资源上限。
