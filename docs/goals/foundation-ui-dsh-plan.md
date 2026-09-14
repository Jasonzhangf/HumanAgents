# HumanAgent 推进计划：开发脚手架、UI 接入、单 DSH Agent

## 1. 目标

将当前已进入 main 的 Harness Runtime 和已有 Provider adapter 证据推进为三个可独立验收的阶段。Provider 当前只以已记录的证据层作为输入，不把未验证的 DSH 能力提前算入。

1. 开发与运行脚手架：编译、回归、配置、启动、release 和可重入 checkpoint。
2. UI 接入：用户可以通过 UI 测试已经打通的 Harness/Provider 能力。
3. 单 DSH Agent：真实 DSH session、tool 和持续推理在 HumanAgent 生命周期内闭环。

多 Agent 编排、Memory Agent 和完整显式 Brain 交互暂不进入这三个阶段的实现主线；它们保留设计，不提前伪装成已接通能力。

当前基线交接：`docs/architecture/provider-adapters.md#8-m1-2-验证结果` 记录了
RCC 4444 同一 ProviderAdapter 入口的 probe/start/observe/settle/close 证据、
49 项 focused provider/replay/RCC tests 和 TypeScript 检查。该记录只证明 Provider
adapter 的当前证据层；Responses/Anthropic 的 replay 与 RCC 直连仍须按当前候选重验，
真实 DSH session/tool/stop/recovery 尚未完成，不能从这份记录推导 DSH 已接通。

## 2. 固定边界

```text
HumanAgent Task/Operation/Checkpoint
    → Runtime Projection / Command Port
    → Provider 或 DSH Adapter
    → RCC 4444 / DSH
```

- `packages/core` 继续拥有高层状态、生命周期、错误 owner、steer 和恢复责任。
- `packages/runtime` 继续拥有启动编排、checkpoint、恢复和运行流水。
- `packages/config` 继续拥有 TOML 解析、校验、配置合并和 `~/.humanagent` 路径派生。
- `packages/ui` 只消费 typed projection，不直接读取 Journal、DSH Session 或 RCC 原始数据。
- `packages/adapters/provider` 拥有 Provider binding、codec、readiness 和 stop/settle 映射。
- `packages/adapters/dsh` 拥有 DSH session/agent/tool/事件/停止适配；不得把 DSH 类型提升为领域类型。
- `~/.humanagent` 是唯一持久化 root；project workspace 只作为执行上下文。
- `~/.rcc` 是 RCC 外部配置真源；HumanAgent 不修改 RCC 配置和 secret。

## 3. 阶段一：基础开发与运行脚手架

### 目标

让开发者和用户可以在任意 project workspace 启动 HumanAgent，并用统一入口执行编译、回归、release 和 smoke；失败后从第一个失效 checkpoint 重入。

### 范围

- 统一 `typecheck`、build、unit、runtime、provider、release、package、smoke 和 CI 入口。
- 固定 `~/.humanagent`、project key、session、checkpoint、artifact、memory 和 profile 路径。
- 完成 `internal.toml` 与用户 `config.toml` 的加载、校验和最小默认值。
- 完成 plan/profile 选择、启动前 doctor、provider readiness 和明确错误出口。
- 复用现有 `scripts/checkpoint-runner.mjs`，不新增第二个 checkpoint 实现。
- 统一 release manifest、阶段 owner、输入/输出 digest、复用证据和失败续跑。
- 提供开发模式和 release 模式的明确区别。

### 非目标

- 不在该阶段实现 DSH adapter。
- 不实现多 Agent spawn、编排队列或 Memory/RAG。
- 不在 project workspace 写 session、Journal、checkpoint、index 或 artifact。
- 不把 RCC route/model/session 当作 HumanAgent 身份。

### 退出条件

```bash
humanagent doctor
humanagent ci
humanagent run --plan provider-smoke
```

必须能够报告：配置来源、project ID、持久化路径、provider、当前 gate、失败 owner 和下次恢复阶段。

## 4. 阶段二：UI 接入已完成能力

### 目标

通过 UI 测试真实 Harness/Provider 链路，不等待完整 DSH Agent，也不使用假数据冒充真实执行。UI 继续复用 MVP 已有的确定性任务准入：用户确认后的 `RequirementEnvelope`、FIFO 输入队列、资源准入和 checkpoint；本阶段不新增 AI Brain，不绕过这些固定门禁。

### 模式

- `fake`：固定 replay，验证 UI 状态、交互和错误展示。
- `rcc`：真实连接 RCC 4444，验证真实 Provider 执行。
- `dsh`：单 DSH Agent 完成后开放。

### UI 入口

- Dashboard：待处理、正在处理、最近输入、历史任务。
- Task List：当前运行、需要用户决策、历史任务。
- Task Detail：当前状态、输入、调查结果、proposal、用户选择、输出和 artifact。
- Task Dashboard：单任务运行看板，展示 agent 输入/输出预览和动态摘要。
- Observation：节点树、事件、证据、checkpoint 和只读递归 drawer。

### 退出条件

用户可以在 UI 完成一次真实 RCC Task：创建、启动、观察 SSE、看到结果、settle、checkpoint、close，并能看到错误或停止后的收拢状态。

UI 不直接操作 Journal、DSH Session 或隐式队列；所有状态和命令经过 typed projection/command port。

## 5. 阶段三：单 DSH Agent

### 目标

在不改变 HumanAgent 高层状态真源的前提下，完成一条真实 DSH 执行链：

```text
HumanAgent Task
    → DSH Adapter
    → DSH Session
    → DSH Agent
    → Tool
    → Provider/RCC
    → Tool result
    → 同一 DSH Session 继续推理
    → HumanAgent checkpoint
```

### 必须完成

- DSH 版本、公开入口和 profile 锁定。
- DSH session 创建、恢复和关闭。
- DSH agent profile：system prompt、skills、tools、provider、workspace、权限。
- 至少一个真实受限工具。
- 同一 session 的多轮模型 → tool → tool result → 继续推理。
- tool failure、provider failure、session failure 的 owner 和下一动作。
- HumanAgent stop operation、DSH stop request、settle、stopped checkpoint。
- DSH 意外退出后的 checkpoint 恢复或明确 blocked/waiting。
- DSH Session Log 作为执行证据，不能替代 Organ Journal。

### 退出条件

用户通过 UI 或 standalone 入口创建一个任务，单个 DSH Agent 使用工具完成持续推理，输出结果并提交 checkpoint；用户可以停止，停止状态有 settle 和 stopped checkpoint 证据；重启后能恢复或明确等待。

## 6. 后续阶段：显式 Brain 与多 Agent 编排

单 DSH Agent 完成后再推进 AI 驱动的显式 Brain 与多 Agent 编排；任务准入本身不是后置能力，阶段二和三继续复用既有确定性入口：

```text
确定性任务准入
    → RequirementEnvelope/FIFO/资源准入
    → 当前阶段的 fake/RCC/DSH execution

完成单 DSH Agent 后：
显式 Brain Profile
    → prompt/schema/eval
    → UI 输入、任务匹配、状态查询、proposal、确认
    → RequirementEnvelope
    → 隐式 Brain/编排队列
    → 执行、review、memory Agent
```

显式 Brain 先作为可回放的输入理解和确认 Agent，不直接执行后台任务。多 Agent 编排继续保持高层设计，直到单 DSH Agent、Runtime Projection 和启动脚手架均有真实验收证据。

## 7. 统一证据与 gate

每个阶段必须有：

- 唯一 owner；
- 正常、waiting、blocked、failed、cancelled 出口；
- checkpoint 和 evidence refs；
- focused tests；
- 适用的 Astra review；
- merge/push 前的本地和远端 Git 证据。

阶段重入规则：已通过且输入 digest 未变化的阶段复用；从第一个输入或依赖发生变化的阶段重新执行；不得用跳过掩盖失败。

## 8. 顺序

```text
基础脚手架
    ↓
确定性任务准入（既有 MVP）
    ├── UI fake/replay + RCC 接入
    └── 单 DSH Agent
          ↓
显式 Brain prompt/eval/UI
          ↓
多 Agent 编排、review、memory
```
