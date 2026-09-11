# Agent Template System

状态：`DESIGN-BOOTSTRAP / TEMPLATE-CONTRACT-DRAFT`  
日期：2026-09-11  
适用范围：Agent 角色定义、技能/工具装配、任务定制和 Agent Runtime 启动

本文定义 HumanAgent 如何为不同 agent 装载不同的 system prompt、skills 和 tools，并把统一模板绑定到可替换的 Agent Driver。它与 [`agent-flows.md`](agent-flows.md) 的角色责任相对应，与 [`host-and-cordis.md`](host-and-cordis.md) 的 Cordis 宿主/插件生命周期相对应。

## 1. 结论

每个 agent 都由同一个标准模板协议创建，但每个角色的内容和能力是隔离、显式、版本化的：

```text
Role Template（静态角色定义）
        +
Task Customization（任务/阶段定制）
        +
Harness Runtime Context（运行时绑定和恢复状态）
        ↓
Validated Agent Runtime Manifest
        ↓
Agent Runtime
```

模板只规定 agent 应该如何工作；Harness 才真正控制权限、队列、checkpoint、health、steer 和 plugin loading。system prompt 不能成为控制面的替代品，agent 不能通过提示词自行扩大权限。

模板、Driver 和 Runtime 不混为一层：模板是配置，Driver 是执行适配器，Runtime 是本次绑定的实例。相同模板可以由 deterministic、DSH、native 或 remote Driver 执行；Driver 不能改变固定 Harness 节点协议。

## 2. 三层配置模型

### 2.1 Role Template

Role Template 是仓库内或已安装模板包中的静态、版本化、不可变定义。它定义：

- `roleId`、`templateVersion`、兼容的 `templateApiVersion`；
- system prompt 和禁止事项；
- 角色允许引用的 skill allowlist；
- 角色允许请求的 tool capability allowlist；
- input/output schema；
- 角色级权限策略和证据要求；
- 正常工作流的 observation projection；
- review fixture 和负向测试样例。

Role Template 不包含当前 Task 的目标、用户文本、checkpoint 内容或运行时 secret。

### 2.2 Task Agent Customization

任务定制由 Harness 根据 `WorkAssignment` 生成，不由 agent 自己改写。它定义：

- `taskId`、`phaseId`、`assignmentId`；
- 本次工作的 objective；
- 输入引用、上下文引用和证据范围；
- deliverables、success criteria、failure criteria；
- `incomplete`、`blocked`、`cancelled` 的返回条件；
- 本任务的约束、时间/资源上限和 memory scope。

任务定制可以缩小模板能力，不能提升角色权限、增加 tool、改变控制通道或跳过 review/settle 门。

### 2.3 Agent Runtime Instance

Agent Runtime Instance 是一次实际启动的、可回收的运行容器配置：

```ts
type AgentRuntimeManifest = {
  runtimeId: string
  agentInstanceId: string
  roleId: string
  templateVersion: string
  binding:
    | {
        kind: 'interaction'
        interactionScopeId: string
      }
    | {
        kind: 'task'
        taskId: string
        phaseId?: string
        assignmentId?: string
      }
  executionEpoch: number
  resourceLeaseRef: string
  contextRefs: string[]
  checkpointRef?: string
  allowedSkillRefs: string[]
  allowedToolCapabilityRefs: string[]
  templateDigest: string
  skillDigest: string
  toolCapabilityDigest: string
  policyDigest: string
}
```

它记录“这次实际加载了什么”，用于恢复、审计和排查版本漂移；它不是 Task 状态真源，也不能被 DSH Session 替代。

## 3. 目录隔离

目标目录如下。它是设计目标，不代表当前阶段已经创建运行时代码：

```text
agent-templates/
  _base/
    manifest.json
    system.md
    policies/
    schemas/
    tests/

  interaction/
    manifest.json
    system.md
    skills/
    tools/
    policies/
    schemas/
    tests/

  orchestration/
    manifest.json
    system.md
    skills/
    tools/
    policies/
    schemas/
    tests/

  execution/
    search/
    coding/
    test/
    build/

  review/
    architecture/
    baseline/
    quality/
    security/
    delivery/

  memory/
    manifest.json
    system.md
    skills/
    tools/
    policies/
    schemas/
    tests/
```

实现阶段建议将这些目录放在 HumanAgent 自己的 template registry 中；外部 template pack 必须通过显式 manifest 注册。不能通过扫描目录、文件名猜测角色，也不能把一个角色目录下的 system prompt 或 tools 自动带入另一个角色。

## 4. Manifest 契约

每个模板目录必须有一个 manifest，所有其他文件只能由 manifest 的显式引用加载：

```ts
type AgentTemplateManifest = {
  kind: 'humanagent.agent-template'
  templateApiVersion: number
  roleId: 'interaction' | 'orchestration' | 'execution' | 'review' | 'memory'
  templateVersion: string
  extends?: { roleId: '_base'; version: string }
  systemPromptRef: string
  skillRefs: string[]
  toolCapabilityRefs: string[]
  inputSchemaRef: string
  outputSchemaRef: string
  policyRef: string
  observationProjectionRef: string
  testFixtureRefs: string[]
  digest: string
}
```

`extends` 只能继承 `_base` 的公共格式和安全约束，不能形成任意多层继承链。角色之间不能互相继承，避免交互 agent 意外获得执行 agent 的能力。

推荐的编译结果：

```ts
type CompiledAgentTemplate = {
  roleId: string
  version: string
  systemPromptDigest: string
  skillRefs: string[]
  toolCapabilityRefs: string[]
  inputSchemaRef: string
  outputSchemaRef: string
  policyRef: string
  observationProjectionRef: string
  manifestDigest: string
}
```

编译结果只包含已验证引用和 digest，不把完整 prompt、secret 或外部服务凭据复制到业务 payload、metadata 或 debug log。

## 5. 统一 system prompt 结构

每个 `system.md` 使用同一结构，角色差异体现在内容和引用，而不是结构漂移：

1. Role identity；
2. Mission；
3. In-scope responsibilities；
4. Explicit non-responsibilities；
5. Input contract；
6. Output contract；
7. Assignment completion rules；
8. Failure/incomplete/blocked reporting；
9. Allowed skills/tools 的引用；
10. Evidence requirements；
11. Communication protocol；
12. Prohibited actions。

其中的控制规则必须同时由 Harness typed port 和权限层执行。prompt 中写“不能搜索”不能代替工具权限拒绝；prompt 中写“需要 review”不能代替编排状态机门禁。

## 6. 角色模板和能力边界

| 角色 | 默认 skills | 默认 tools | 明确禁止 |
|---|---|---|---|
| interaction | 输入归一化、任务匹配、状态解释、确认表达 | 输入接收、任务查询、proposal 渲染 | 搜索、coding、直接 dispatch、直接改 Task state |
| orchestration | 阶段计划、资源安排、结果核对、review 编排 | Task/queue/resource 查询、assignment 创建、结果提交 | 搜索、coding、直接执行 worker operation |
| execution worker | 由 worker kind 指定的单一能力 | assignment 指定的搜索/coding/test/build 工具 | 改目标、扩大权限、安排 agent、修改控制面 |
| review worker | 对应审计标准和证据核对 | 只读代码/配置/结果/测试审计工具 | 写代码、整改、直接 merge |
| memory | 历史检索、重复性/价值判断、skill candidate 形成 | RAG search、memory ask、Task history、绑定 session history | 改 Task、直接入库 skill、steer、健康声明 |

编排 agent 的固定流程仍由 `core/runtime` 拥有：交互确认 → FIFO → 分类/准入 → 编排 → assignment → 结果核对 → review/整改 → memory review → settle。模板插件只能提供其中某个角色的实现，不能替换这条流程或移除门。

## 7. 加载生命周期

模板加载必须是确定性的四段流程：

```text
authoring
  → validate
  → compile
  → load
```

### 7.1 authoring

开发者在隔离目录中维护 manifest、prompt、skills、tools capability 引用、schema 和 fixtures。每个引用都必须是包内相对路径或已注册的稳定 ID。

### 7.2 validate

Harness 在启动或安装时验证：

- manifest schema 和 `templateApiVersion`；
- roleId 与目录一致；
- 所有引用存在且没有路径逃逸；
- skill/tool allowlist 没有超出角色上限；
- input/output schema 能闭合 assignment/result 契约；
- policy 没有覆盖核心安全约束；
- digest 与锁文件一致；
- fixture 包含越权、缺证据、错误返回和跨任务污染的负向样例。

验证失败就拒绝加载并进入显式 `template-invalid`，不能加载部分内容或静默回退到另一个角色。

### 7.3 compile

编译器生成 `CompiledAgentTemplate` 和不可变 manifest snapshot。它把模板引用解析成实际版本，但不执行模型、不启动工具、不创建 Task。

### 7.4 load

对于 task-bound runtime，只有 Harness Runtime 在完成资源准入、Task binding、execution epoch 和 checkpoint recall 后，才把编译结果装配成 Agent Runtime Context。交互 agent 使用独立的 `interactionScopeId`，它接收原始输入、任务查询和确认请求，不要求预先存在 Task 或 checkpoint；一旦用户确认，Harness 才创建 Task binding 并重新装配后台 agent。运行时不重新扫描目录，不读取未锁定的新文件。

## 8. 端口和启动接口

高层只依赖自己的端口：

```ts
interface AgentTemplateLoader {
  resolve(input: {
    roleId: string
    templateVersion?: string
    capabilityProfile?: string
  }): Promise<CompiledAgentTemplate>
}

interface AgentRuntimeSpawner {
  spawn(input: {
    template: CompiledAgentTemplate
    binding:
      | { kind: 'interaction'; interactionScopeId: string }
      | {
          kind: 'task'
          taskId: string
          phaseId?: string
          assignmentId?: string
        }
    resourceLeaseRef: string
    contextRefs: string[]
    checkpointRef?: string
  }): Promise<{ runtimeId: string; executionEpoch: number }>
}
```

`AgentRuntimeSpawner` 必须由 Harness 调用。agent 不能自己 spawn 平级 agent、加载新模板或追加 tool capability。

Runtime 通过统一的 `AgentDriver` port 启动、恢复、提交输入、观测、停止、reconcile 和 settle；Driver 类型不进入模板的业务 payload。Agent Context Injection 由 Harness 额外调用 [`memory-system.md`](memory-system.md) 定义的接口，按层级注入可追溯引用，不把完整 Index 或 RAG 数据库暴露给 agent。

## 9. 与 plugin 的关系

模板、skill、tool 和 plugin 不是同一个层次：

| 类型 | 内容 | 变化方式 | 能否改变固定编排 |
|---|---|---|---|
| Template | prompt、schema、策略引用、角色边界 | 版本化配置 | 不能 |
| Skill | 可复用工作方法和知识 | 显式 allowlist | 不能 |
| Tool capability | 可执行的外部能力 | Harness/adapter 注册 | 不能；只能被 assignment 授权 |
| Plugin | 提供 port、adapter、probe 或 UI projection 的代码包 | manifest + lock + restart | 不能越过 core gate |

需要代码才能完成的 skill 必须落为受控 tool capability 或 plugin，不能把任意代码藏在 Markdown skill 中。反过来，纯 prompt/知识不应为了插件化而引入可执行包。

## 10. 验收证据

模板系统完成 iff：

- 五类 agent 都能通过同一模板协议启动，角色目录和能力引用物理隔离；
- 每次 Agent Runtime 启动都记录模板、skill、tool 和 policy digest；
- 未确认任务不会因为模板加载而进入后台 pipeline；
- 任何角色不能通过 prompt、skill 或 task customization 扩大工具权限；
- 目录扫描、隐式继承、未锁定文件和缺失引用都会显式失败；
- 复用 idle runtime 时不会携带上一个 Task 的模板定制、上下文或隐式状态；
- Milestone 2 以后，模板版本改变后旧 runtime 才能按持久化 manifest snapshot 回放；MVP/Milestone 1 只允许当前已锁定 snapshot，活动绑定阻止更新或保留旧 profile，不以 digest 代替 snapshot 内容；
- fake backend 能验证每个角色的成功、失败、blocked、cancelled 和越权负向路径；
- DSH/Cordis 不出现在 `contracts/core` 的领域类型中。

## 11. 阶段安排

- MVP：在最小 HumanAgent Cordis Host 中实现本地模板 registry、manifest 校验、digest 记录和 deterministic/fake Agent Driver；不接 DSH provider。
- Milestone 1：将 DSH adapter/Driver 的执行 profile、tool capability 和 session 证据接到模板编译结果之后；验证插件安装和重启加载。
- Milestone 2：持久化 template snapshot、runtime 恢复和历史查询；模板更新不得污染既有 Task 的恢复上下文。
- Milestone 3：模板/skill/plugin 包的签名、兼容矩阵、发布、回滚和多 profile 管理。
