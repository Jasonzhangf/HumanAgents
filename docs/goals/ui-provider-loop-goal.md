# HumanAgent UI Provider Loop 实现计划与 Goal 提示词

状态：`PLAN-READY`
日期：2026-09-14
基线：`origin/main @ 36528f4e7d05932d63ddd7a4308c8863be424138`
Provider 边界：`docs/architecture/provider-adapters.md`
UI 边界：`docs/ui/README.md`

本文只定义 UI 第一阶段接入已打通 Provider/Harness 能力的实现计划和可直接执行的
goal 提示词。本文不启动实现，也不把 DSH、多 Agent 编排或完整 Agent 产品带入本阶段。

## 1. 决策结论

UI 第一阶段的目标不是做完整 Agent 产品，而是让用户在浏览器中验证当前已经接通的
Harness 与 Provider 能力：

```text
Browser UI
  -> HumanAgent Runtime API
  -> packages/runtime lifecycle / stop / checkpoint
  -> ExecutionRuntimePort
  -> ProviderAdapter
  -> RccV3ProviderTransport
  -> RCC v3 127.0.0.1:4444
```

固定边界：

- UI 不直接读取 Organ Journal、DSH Session、RCC 原始返回、debug log 或 transport frame。
- UI 只消费 typed projection，只通过 Runtime command port 发出操作。
- Provider 直连链路使用真实 RCC 4444；`fake` 模式使用固定 replay，必须显式标注。
- `rcc` 模式失败必须显式失败，不允许静默回退到 `fake`。
- `dsh` 模式在本阶段保持关闭；DSH 接入完成后再开放。
- `stop` 必须走标准停止 operation；只有 settle、资源释放结果和 stopped checkpoint
  都成立时，UI 才能显示 `stopped`。

当前代码事实：

| 能力 | 当前状态 | 本阶段动作 |
|---|---|---|
| `ProviderAdapter`、Responses/OpenAI codec、RCC v3 transport | 已有实现；文档记录真实 RCC 4444 probe/start/observe/settle/close 证据 | 复用，不重写协议层 |
| `packages/runtime` 的 AgentRuntime、stop control、checkpoint coordinator | 已有实现和 focused tests | 接入执行编排与 API 投影 |
| `packages/app` | 只有 runtime open/resume、session store 和 CLI skeleton | 新增 Runtime API、mode 装配、SSE 和投影适配 |
| `packages/ui` | 已有 projection 和 command 契约 | 补 Dashboard 最近输出/失败、Task Dashboard 执行详情和动作 |
| `docs/ui` | 静态原型，按钮不连接 runtime | 改为消费 Runtime API，移除写死成功状态 |
| Provider 到 AgentDriver 的桥 | 缺失 | 在 provider owner 内新增 `ProviderAgentDriver` |
| HTTP/SSE server | 缺失 | 在 app owner 内新增本地 UI runtime server |

## 2. 唯一 owner 与写入边界

### 2.1 Owner

| 范围 | 唯一 owner | 责任 |
|---|---|---|
| Runtime API、mode 装配、SSE、Journal 到 projection 输入适配 | `packages/app` | 只组装和投影，不拥有领域状态 |
| Provider 到 AgentDriver 的桥 | `packages/adapters/provider` | 协议事件、submit、stop、settle 映射 |
| Task、Operation、epoch、stop、checkpoint、恢复 | `packages/runtime` | 高层生命周期和错误闭环 |
| UI projection 与 command 契约 | `packages/ui` | 只定义 UI 可消费视图和命令 |
| UI 页面和 API 客户端 | `docs/ui` | 浏览器交互和状态展示 |
| 测试 | `tests/app`、`tests/ui`、`tests/adapters/provider`、必要的 `tests/runtime` | focused validation |

### 2.2 允许路径

```text
packages/app/
packages/adapters/provider/
packages/runtime/
packages/ui/
packages/contracts/        # 仅必要 typed contract
docs/ui/
tests/app/
tests/ui/
tests/adapters/provider/
tests/runtime/             # 仅受影响 lifecycle / stop / checkpoint 边
package.json               # 仅新增或复用必要 scripts
README.md
docs/goals/ui-provider-loop-goal.md
```

### 2.3 禁止路径

```text
packages/adapters/dsh/     # DSH 本阶段不接
~/.rcc/                    # 只读 readiness，不修改配置
project workspace 持久化路径
任何 RCC secret、token、auth handle
```

实现必须在 `origin/main` 的独立 clean worktree 中进行，建议路径：

```text
playground/ui-provider-loop
```

保留当前 main 上已有 dirty 文档和未跟踪文件，不得覆盖、回滚或整理无关变更。

## 3. Runtime API 契约

### 3.1 HTTP 端点

| Method | Path | 作用 | Owner |
|---|---|---|---|
| `GET` | `/api/runtime/status` | mode、provider readiness、disconnect/error、可用动作 | app |
| `GET` | `/api/dashboard` | Dashboard projection | app + ui |
| `GET` | `/api/tasks` | Task List projection | app + ui |
| `POST` | `/api/tasks` | 创建或选择 Task | app + runtime |
| `GET` | `/api/tasks/:taskId` | Task Detail projection | app + ui |
| `GET` | `/api/tasks/:taskId/dashboard` | Task Dashboard projection | app + ui |
| `GET` | `/api/tasks/:taskId/observation` | 只读 Pipeline Observation projection | app + ui |
| `POST` | `/api/tasks/:taskId/executions` | 发起一次 Provider 执行 | app + runtime + provider |
| `GET` | `/api/executions/:operationId/events` | SSE 规范化事件流 | app |
| `POST` | `/api/tasks/:taskId/stop` | 发起标准 stop operation | app + runtime |
| `POST` | `/api/tasks/:taskId/continue` | 只有底层真实 continue operation 存在时才暴露 | app + runtime |
| `POST` | `/api/tasks/:taskId/retry` | 只有 changed condition 和正式 retry operation 存在时才暴露 | app + runtime |

约束：

- 所有错误响应必须包含 `code`、`ownerId`、`message`、`nextAction` 和可选
  `evidenceRefs`。
- `continue`、`retry` 不得由 UI 自行模拟；后端能力未实现时，projection 返回
  `allowedActions` 中不带该动作，或返回明确不可用原因。
- `POST /api/tasks/:taskId/executions` 必须显式选择 `fake` 或 `rcc`；禁止请求体
  缺省时隐式选择真实 Provider。

### 3.2 SSE 事件

SSE 只发送规范化领域事件：

```text
execution.started
provider.model
provider.output
provider.tool
provider.error
execution.settling
checkpoint.committed
execution.terminal
attention.opened
attention.resolved
```

每个事件必须携带：

- `eventId`、`seq`、`occurredAt`；
- `taskId`、`operationId`、`executionEpoch`；
- 规范化 `kind`、`state`、`summary`；
- `evidenceRefs`；
- 错误事件额外包含 `ownerId`、`retryable`、`nextAction`。

禁止在 SSE 中透传：

- RCC 原始 request/response frame；
- 完整 provider payload；
- token、auth alias、secret；
- Journal 原始记录；
- DSH session 类型或事件。

断线重连必须支持 `Last-Event-ID`，并从可重放投影恢复；不能靠内存猜测状态。

### 3.3 Projection 增补

Dashboard：

- 当前是否有运行中的任务；
- 当前任务数量；
- 等待用户决策的任务；
- 最近用户输入；
- 最近任务输出；
- 最近失败。

Task List：

- 运行中、等待决策、已完成、失败任务；
- 最近更新时间、当前状态、当前下一步。

Task Dashboard：

- 当前任务、当前状态、当前执行节点；
- 输入、输出、最近事件、checkpoint；
- 错误与 owner、下一步；
- `stop`、`continue`、`retry` 等明确操作，但只展示后端真实允许的动作。

Observation：

- 节点树、当前节点、节点输入、节点输出；
- evidence、operation、checkpoint；
- drawer 详情、递归进入和返回。
- UI 只读，不提供 retry operation、修改队列、steer、改写 checkpoint 或 Journal。

## 4. 阶段计划

### MUI-0：基线与契约锁定

Owner：app + ui。

交付：

- 从 `origin/main` 创建 clean worktree。
- 记录 baseline commit/tree、dirty main 状态、RCC readiness 和现有测试结果。
- 冻结 Runtime API、SSE 事件和 projection 增补契约。
- 明确 `fake`、`rcc`、`dsh` 三模式的行为和不可用出口。

完成 iff：

- 文档列出每个端点的 owner、输入、输出、错误出口和 evidence。
- `dsh` 模式明确返回 `capability-unavailable` 或 `disabled`，不进入执行链。
- 未修改禁止路径。

测试证据：

- `pnpm typecheck`
- 基线 `pnpm test`
- RCC 只读 readiness 证据

### MUI-1：fake 模式 Runtime API

Owner：app + ui。

交付：

- 本地 HTTP server 和静态 UI 挂载。
- `GET /api/runtime/status`、Dashboard、Task List、Task Detail、Task Dashboard、
  Observation 和 SSE 端点。
- `fake` 模式使用固定 replay，经同一 `ExecutionRuntimePort` 和 projection 路径。
- UI 明确显示 `mode=fake`。

完成 iff：

- 浏览器可完成创建/选择 Task -> 发起 fake 执行 -> 看到 SSE -> 最终输出 ->
  settle/checkpoint -> close。
- fake 执行不访问 RCC，也不生成真实 Provider 证据。
- API 状态、错误和断线状态可见。

测试证据：

- 新增 app API focused tests。
- 新增 UI projection/API contract tests。
- `pnpm typecheck`、`pnpm test:app`、`pnpm test:ui`。

### MUI-2：ProviderAgentDriver 与 rcc 模式

Owner：provider + app。

交付：

- 在 `packages/adapters/provider` 新增 Provider 到 AgentDriver 的桥。
- 复用 `ProviderAdapter`、Responses/OpenAI codec 和
  `RccV3ProviderTransport`。
- `rcc` 模式使用显式入口 protocol、route、model 和 endpoint；默认不启用。
- RCC 是透明代理，本阶段 MVP验收锁定 `responses`（`/v1/responses`）和
  `openai`（`/v1/chat/completions`）两个入口协议；`anthropic`
  （`/v1/messages`）保留既有入口能力，但不纳入本阶段 UI Provider Loop
  验收，也不得被 UI/Runtime 禁用；`providerId` 只是本地入口标签，不代表
  上游 Provider 身份。`routeRef` / `--route` 同样只是本地入口标签，用于
  binding、evidence 和审计关联，不作为 RCC 请求体中的上游 route selector。
- `probe`、`start`、`observe`、`submit`、`requestStop`、`settle`、`close` 映射到
  HumanAgent operation 和 evidence。

完成 iff：

- 同一 Runtime API 在 `rcc` 模式通过真实 `127.0.0.1:4444` 分别完成
  `responses` 和 `openai` 两个入口的 probe、执行、stop、settle、
  checkpoint 和 close。
- 最终 provider model 与请求 model 不同时仍按 RCC 透明路由语义处理，不作为
  binding mismatch。
- 4444 不可用、协议不可用或请求失败时显式返回 owner 和 next action。
- `rcc` 失败不静默回退 `fake`。

测试证据：

- provider focused tests 覆盖 bridge 的正常、错误、epoch、stop、settle。
- 真实 RCC 两个入口的 probe/request/stream/stop/settle/checkpoint/close
  evidence。
- `pnpm test:app`、provider tests、`pnpm typecheck`。

### MUI-3：生命周期、SSE 与 stop 收拢

Owner：runtime + app。

交付：

- 执行编排：start -> observe -> submit/output -> settle -> checkpoint。
- `stop` 接入 `executeStopControl`，不使用 UI 本地状态模拟。
- SSE 发送 `execution.settling`、`checkpoint.committed`、`execution.terminal` 和
  `attention.*`。
- 错误事件带 owner、retryable 和 next action。
- 重连通过 Journal/checkpoint projection 恢复。

完成 iff：

- stop 请求后 UI 先显示 `stopping`，只有 stopped checkpoint 提交后显示 `stopped`。
- cancel receipt 不等于 stopped。
- late event 不推进新 cycle。
- checkpoint 提交失败进入 `blocked` 或明确恢复路径。
- 运行状态与健康/错误状态分离。

测试证据：

- stop race、late event、settle/checkpoint 失败 focused tests。
- SSE reconnect 和 Last-Event-ID tests。
- `pnpm test:runtime`、`pnpm test:app`。

### MUI-4：UI 接入

Owner：ui + docs/ui。

交付：

- 静态页面改为消费 Runtime API。
- Dashboard 增补最近输出、最近失败。
- Task Dashboard 增补当前节点、输入、输出、最近事件、checkpoint、错误与 owner、
  下一步和 allowed actions。
- Observation 保持只读，支持 drawer、递归进入和返回。
- 所有按钮状态来自 projection；错误、stale、disconnected、unknown 必须可见。

完成 iff：

- 浏览器完成完整验收流。
- 按钮不再写死成功；未实现动作不显示或明确不可用。
- Observation 不出现 retry、steer、改队列或改 checkpoint。
- 桌面和窄窗口均无文字溢出或控件重叠。
- 键盘焦点、drawer 打开/关闭焦点回收和面包屑返回通过验证。

测试证据：

- UI focused tests。
- 浏览器入口截图和可访问性树仅作为视觉证据，不能替代 API、SSE、Journal 和
  operation evidence。

### MUI-5：验收、review 与交接

Owner：integration/review owner。

交付：

- fake 与 rcc 两模式同 UI 验收报告。
- 真实 RCC 执行证据：probe、start、SSE、output、settle、checkpoint、close。
- stop 验收：stop request、settling、settle、stopped checkpoint。
- 错误验收：provider error、owner、next action、UI 可见。
- 独立 review receipt。
- 未完成项、限制、剩余风险和下一动作。

完成 iff：

- 验收流全部通过。
- P0/P1 = 0；发现问题先修复再重跑受影响验证。
- fake 与 rcc 模式在 UI 中来源可区分。
- 没有 DSH、多 Agent、生产部署或完整 Agent 产品的越界声明。

测试证据：

- `pnpm typecheck`
- `pnpm test`
- 新增 API、SSE、UI focused tests
- 真实 RCC 同入口验收记录
- 浏览器入口验证记录

## 5. 最终验收流

用户必须可以在浏览器中完成：

```text
打开 Dashboard
  -> 创建或选择 Task
  -> 选择 fake 或 rcc 模式
  -> 发起一次 Provider 执行
  -> 看到运行状态
  -> 看到 SSE 事件
  -> 看到最终结果
  -> 看到 settle / checkpoint / close
  -> 看到错误 owner 和 next action
  -> 执行 stop
  -> 看到 stopping
  -> 看到 stopped checkpoint 后的 stopped 收拢状态
```

`fake` 与 `rcc` 必须满足同一 UI 生命周期语义，但证据来源不同：

| 模式 | 数据来源 | 必须证明 | 禁止 |
|---|---|---|---|
| `fake` | 固定 replay | UI 状态、交互、错误展示、SSE 路径 | 伪装成真实 Provider 执行 |
| `rcc` | RCC 4444 真实 Provider | probe、request、stream、settle、checkpoint、stop | 静默回退 fake |
| `dsh` | 未开放 | 明确 disabled / capability-unavailable | 本阶段接入 |

## 6. 非目标

- 不接 DSH provider、DSH session、DSH tool 或 DSH WebUI。
- 不做完整显式 Brain、隐式 Brain 或 RequirementEnvelope 产品交互。
- 不做多 Agent 编排、Memory/RAG 或 SQLite Index。
- 不做多 Provider 路由、生产部署、多租户或历史压缩。
- 不让 UI 直接读取 Journal、DSH Session、RCC 原始返回或 debug log。
- 不在 Observation 中提供 retry operation、修改队列、steer 或改写 checkpoint。

## 7. Goal 提示词

```text
/goal
目标：
按 `docs/goals/ui-provider-loop-goal.md` 完成 HumanAgent UI Provider Loop。
从最新 `origin/main` 创建独立 clean worktree `playground/ui-provider-loop`，严格按该
计划实现 MUI-0 至 MUI-5，并保持其中声明的 owner、允许/禁止路径、API/SSE 契约、
fake/rcc/dsh 边界、stop/checkpoint 语义和非目标。

项目与基线：
- 项目：/Volumes/extension/code/humanagent
- 当前 main 基线：36528f4e7d05932d63ddd7a4308c8863be424138
- 实现必须从最新 origin/main 创建独立 clean worktree：playground/ui-provider-loop
- 计划真源：docs/goals/ui-provider-loop-goal.md
- Provider 边界：docs/architecture/provider-adapters.md
- UI 边界：docs/ui/README.md
- 当前 main 存在用户已有 dirty 文档和未跟踪文件；不得覆盖、回滚或整理无关变更。

范围与约束：
- 允许修改：packages/app、packages/adapters/provider、packages/runtime、
  packages/ui、packages/contracts（仅必要 typed contract）、docs/ui、tests/app、
  tests/ui、tests/adapters/provider、受影响的 tests/runtime、package.json、
  README.md。
- 禁止修改：packages/adapters/dsh 的真实适配、~/.rcc 配置或 secret、project
  workspace 持久化路径、生产部署、多 Agent 编排、Memory/RAG 和 DSH WebUI。
- packages/app 拥有 Runtime API、mode 装配、SSE 和 projection 输入适配；不拥有
  Task、Operation、epoch、stop、checkpoint 或恢复语义。
- packages/adapters/provider 拥有 ProviderAgentDriver，只做协议事件、submit、
  stop、settle 映射；不得把 Provider 类型提升为高层领域类型。
- packages/runtime 拥有生命周期、stop、settle、checkpoint 和错误闭环。
- packages/ui 拥有 projection/command 契约；UI 不拥有运行时状态。
- docs/ui 只消费 typed API，不直接读取 Journal、DSH Session、RCC 原始返回或
  debug log。
- fake 模式使用固定 replay，必须显式标注 mode=fake，不访问 RCC，不生成真实
  Provider 证据；rcc 模式必须显式选择 binding，失败时显式失败，禁止静默回退。
- dsh 模式必须明确 disabled 或 capability-unavailable，不进入执行链。
- stop 必须调用正式 stop operation；cancel receipt 不等于 stopped，只有 settle、
  资源释放结果和 stopped checkpoint 成立后才能显示 stopped。
- continue/retry 只有在底层真实 operation 和 changed condition 存在时才暴露；
  UI 不得模拟操作，也不得把控制字段写入业务 payload、metadata 或日志。

固定阶段：
- MUI-0：锁定 baseline、clean worktree、Runtime API、SSE、projection 契约和三模式
  行为；记录 RCC 只读 readiness。
- MUI-1：实现本地 HTTP server、fake 模式和全部 projection/SSE 端点；浏览器完成
  fake 全流程。
- MUI-2：实现 ProviderAgentDriver，接 ProviderAdapter、Responses/OpenAI codec
  和 RccV3ProviderTransport；同一 Runtime API 在 rcc 模式完成真实 4444 的
  responses 与 openai 双入口执行。
- MUI-3：接入执行编排、SSE、stop control、settle 和 checkpoint；覆盖 late event、
  stop race、checkpoint 失败、重连恢复和错误 owner。
- MUI-4：把 docs/ui 静态页面接入 Runtime API；补 Dashboard 最近输出/失败、Task
  Dashboard 执行详情和动作；Observation 保持只读。
- MUI-5：完成 fake/rcc 双模式验收、独立 review、文档和交接；P0/P1 = 0。

固定 API：
- GET /api/runtime/status
- GET /api/dashboard
- GET /api/tasks
- POST /api/tasks
- GET /api/tasks/:taskId
- GET /api/tasks/:taskId/dashboard
- GET /api/tasks/:taskId/observation
- POST /api/tasks/:taskId/executions
- GET /api/executions/:operationId/events
- POST /api/tasks/:taskId/stop
- POST /api/tasks/:taskId/continue，仅在底层 operation 存在时暴露
- POST /api/tasks/:taskId/retry，仅在正式 retry operation 和 changed condition 存在时暴露

固定 SSE 事件：
- execution.started
- provider.model
- provider.output
- provider.tool
- provider.error
- execution.settling
- checkpoint.committed
- execution.terminal
- attention.opened
- attention.resolved

SSE 必须携带 eventId、seq、occurredAt、taskId、operationId、executionEpoch、
规范化 kind/state/summary、evidenceRefs；错误事件额外携带 ownerId、retryable 和
nextAction。禁止透传 RCC 原始 frame、完整 provider payload、secret、Journal 原始
记录或 DSH 类型。断线重连必须支持 Last-Event-ID，并从可重放投影恢复。

验收：
- 浏览器完成：Dashboard -> 创建或选择 Task -> 选择 fake/rcc -> 发起 Provider
  执行 -> 看到运行状态 -> 看到 SSE -> 看到最终结果 -> 看到 settle/checkpoint/
  close -> 看到错误 owner -> 分别对 `responses` 和 `openai` 执行 stop ->
  看到 stopping -> 看到 stopped checkpoint 后的 stopped 收拢。
- fake 模式证明 UI 交互、SSE 路径和错误展示，且不伪装成真实执行。
- rcc 模式证明 `responses` 与 `openai` 两个入口的 probe、request、stream、
  stop、settle、checkpoint、close 均通过真实 RCC 4444 同入口；RCC 不可用或
  协议失败时显式失败。
- stop 只有 stopped checkpoint 后才能显示 stopped；late event 不推进新 cycle；
  checkpoint 失败进入 blocked 或明确恢复路径。
- UI 不出现 Observation 控制动作；不直接读取 Journal、DSH Session、RCC 原始
  返回或 debug log；不把 fake 数据伪装成真实运行结果。
- 桌面和窄窗口无文字溢出或控件重叠；键盘焦点、drawer 焦点回收和面包屑返回
  通过验证。
- `pnpm typecheck`、`pnpm test` 和新增 focused tests 通过。
- 独立 review PASS，P0/P1 = 0；review 只检查本目标范围，发现问题先修复再重跑
  受影响验证。
- 报告区分 source、candidate、commit、push、merge、安装、重启和 live replay；
  未完成 DSH、多 Agent 或生产部署时不得宣称完成。

完成信号：
输出 `UI_PROVIDER_LOOP_COMPLETE`，并附上：变更文件、命令及退出码、fake/rcc
验收记录、RCC 同入口证据、SSE/stop/checkpoint evidence、review receipt、commit
和远端同步结果。

依据：
docs/goals/ui-provider-loop-goal.md
docs/architecture/provider-adapters.md
docs/ui/README.md
AGENTS.md

直接执行本任务，不再为它生成一层提示词。
```
