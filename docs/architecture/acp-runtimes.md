# ACP Runtime 适配

状态：`IMPLEMENTED / VERIFIED-ON-REAL-ENTRY`
日期：2026-10-06
适用范围：应用层到推理层的接线，以及 opencode / antigravity / dsh 三个执行后端的适配

本文说明 HumanAgent 如何用一个 ACP 客户端驱动（client driver）加三个 runtime
adaptor 接入三个外部执行后端。它回答“应用层和底层推理层是通过 adapter 接线吗”
以及“acp 的推理层能不能接受”两个问题。

## 1. 结论

HumanAgent 的应用层不直接调用任何模型。应用层通过一个共享的 ACP 客户端驱动，
把 `AgentDriver` 契约映射到 ACP 会话操作。三个 runtime adaptor 各自负责把外部
后端接到同一个 ACP 会话接缝上：

```text
应用层（packages/app 组合）
        ↓  AgentDriver
AcpClientDriver（唯一 owner：会话记账 + AgentDriver 映射）
        ↓  AcpRuntimeAdaptor
opencode adaptor（direct）  antigravity adaptor（shim）  dsh adaptor（shim）
        ↓                        ↓                          ↓
opencode ACP v1 server      agy 一次性 CLI              dsh headless 一次性 CLI
```

只有 opencode 真正实现 ACP v1。antigravity 和 dsh 的原生协议不是 ACP，因此由
adaptor 充当协议 shim，把一次性 CLI 的输入输出映射到 ACP 会话语义。三者共用
同一套适配，运行时差异只在 adaptor 内部。

## 2. 三个 runtime 的真实协议面

| runtime | kind | 真实接口 | 会话模型 |
| --- | --- | --- | --- |
| opencode | `direct` | `opencode acp --pure`，stdio 上的 ACP v1 NDJSON | 常驻进程，支持多轮 |
| antigravity | `shim` | `agy -p "<prompt>" --output-format json` | 一次性进程，每轮一个 |
| dsh | `shim` | `dsh --profile headless --json <task>` | 一次性进程，每轮一个 |

两个 shim 的关键事实：antigravity 和 dsh 都**不是**常驻 stdin 服务。dsh
headless 会一直读 stdin 直到 EOF，然后跑一轮并退出。因此 adaptor 必须每轮起一个
进程，不能把 prompt 写进一个长驻进程而不关闭 stdin；否则第一轮就会永久阻塞。

opencode 是真实 ACP v1 server，所以 `kind` 为 `direct`，`protocol` 为 `acp`；
两个 shim 的 `protocol` 为 `shim`，adaptor 不冒充 ACP v1 能力。

## 3. 接缝

`AcpRuntimeAdaptor` 是唯一接缝，方法固定为：

```text
open / load / submit / cancel / close
```

- `open` 建立会话。direct runtime 在这里初始化真实 ACP 会话；shim 只登记关联标识。
- `submit` 跑一轮并返回 `outputText` 与 `stopReason`。
- `cancel` 请求取消。取消被接受不等于已停止。
- `close` 收拢会话，是停止完成的判定点。
- `load` 对两个 shim 返回 `capability-unavailable`；一次性 CLI 没有可恢复的 ACP 会话。

ACP 的 `sessionId`、`messageId` 只作为关联证据，不成为 HumanAgent 的 `TaskId`、
`OperationId` 或 `CheckpointId`。

## 4. 配置

三个 runtime 通过 `driverRef` 选择，各自有独立的 execution 配置段：

```toml
[execution.opencode]
command = "/opt/opencode/bin/opencode"
args = ["acp", "--pure"]
timeoutMs = 120000

[execution.antigravity]
command = "/opt/agy/bin/agy"

[execution.dshAcp]
command = "/opt/dsh/bin/dsh"
args = ["--profile", "headless", "--json"]
```

`command` 是必填项。宿主不猜测 runtime 二进制的位置，也不写入某个用户的家目录
路径。缺少该段或缺少 `command` 时，组合阶段以 `acp-config-missing` /
`config-invalid` 失败，不会静默回退到别的 driver。

`driverRef` 的可接受集合由 `packages/agent-templates` 的
`ENABLED_AGENT_DRIVER_REFS` 唯一拥有，`packages/config` 从它派生。

## 5. 取消与停止

`cancel accepted != stopped`。adaptor 的 `cancel` 只报告“取消请求是否被接受”；
只有 `close` 完成后，driver 才把闭包状态判为 `stopped`。对一次性 CLI，
`cancel` 的实际动作是结束在飞进程，其拒绝结果由 `submit` 显式抛出，不被吞掉。

## 6. 证据边界

- opencode 走真实 ACP v1：`initialize` / `session/new` / `session/prompt` 与
  `session/update` 通知都由真实 server 产生。
- 两个 shim 的最终答案来自各自 CLI 的原生输出：antigravity 取
  `--output-format json` 的 `response` 字段，dsh 取 `final` 事件的 `text`。
- dsh 的多轮只做到会话记录复用：第二轮带 `--session-id` 采用第一轮持久化的
  Session。该 build 不会因此把历史轮次回放进模型上下文，所以 adaptor 只声明
  “采用同一 Session”，不声明对话记忆。
- 后端失败必须可见。例如 dsh 缺少凭据时，`turn_end.reason.kind` 为 `error`，
  adaptor 以 `transport-failure` 抛出并带上后端原始错误，不伪造成功。
- ACP 会话标识只用于关联，不改变 HumanAgent 的 Journal / checkpoint 真源。

## 7. 验证结果

以下证据来自真实入口，不是 mock：

- 组合链路：真实用户配置 → `validateUserConfig` → `composeAgentDriver` →
  `AcpClientDriver` → adaptor → 真实引擎进程。三个 runtime 都返回 `POGS`，
  `stopReason` 为 `end_turn`，闭包状态为 `succeeded`。
- 失败可见性：dsh 无凭据时 `submit` 以 `transport-failure` 抛出后端的
  `MISSING_CREDENTIAL` 原文；`load` 在两个 shim 上返回 `capability-unavailable`。
- 失败关闭：缺少 execution 段或 `command` 时组合/校验阶段报错，未知 `driverRef`
  报 `agent-driver-unsupported`。
- focused tests：ACP 39、config 32、agent-templates 17，全部通过。
- 端到端复跑：`pnpm proof:acp-runtimes` 走真实配置与组合入口，三个 runtime 都通过。
