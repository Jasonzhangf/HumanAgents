# ACP Runtime 适配

状态：`IMPLEMENTED / VERIFIED-ON-REAL-ENTRY`
日期：2026-10-06
证据：`pnpm proof:acp-runtimes` 的真实入口 receipt 在
`dist/receipts/acp-runtimes-proof.json`（不在版本库内，需重新生成）。该 receipt
记录产生它的 `candidateRevision` 与 `worktreeDirty`，因此可以核对它属于哪个候选。
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

| runtime | 协议声明 | 真实接口 | 会话模型 |
| --- | --- | --- | --- |
| opencode | `acp.direct` | `opencode acp --pure`，stdio 上的 ACP v1 NDJSON | 常驻进程，支持多轮 |
| antigravity | `acp.shim` | `agy -p "<prompt>" --output-format json` | 一次性进程，每轮一个 |
| dsh | `acp.shim` | `dsh --profile headless --json <task>` | 一次性进程，每轮一个 |

两个 shim 的关键事实：antigravity 和 dsh 都**不是**常驻 stdin 服务。dsh
headless 会一直读 stdin 直到 EOF，然后跑一轮并退出。因此 adaptor 必须每轮起一个
进程，不能把 prompt 写进一个长驻进程而不关闭 stdin；否则第一轮就会永久阻塞。

opencode 是真实 ACP v1 server，因此声明 `acp.direct` 能力；两个 shim 声明
`acp.shim`，不冒充 ACP v1。协议变体只在这一处声明，由 driver 的 `capabilities()`
上抛给 HumanAgent；adaptor 不再另设一个无人读取的 `kind` 字段。

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

真实入口证据（`pnpm proof:acp-runtimes`，receipt 记录 `candidateRevision`）：

- 组合链路：真实用户配置 → `validateUserConfig` → `composeAgentDriver` →
  `AcpClientDriver` → adaptor → 真实引擎进程。三个 runtime 都返回 `POGS`，
  闭包状态为 `succeeded`，checkpoint 与 run manifest 的 scope 一致。
- 答案投递：driver 返回的答案与 `provider.output` 事件拼出的答案相同。两者都由
  同一次 submit 产生，因此这证明答案确实到了下游角色读取的事件流，不证明引擎
  原始字节与最终字节的关系；harness 不断言固定令牌，因为上游对“原样复述”这类
  prompt 的返回并不稳定。
- 失败可见性：dsh 无凭据时 `submit` 以 `transport-failure` 抛出后端的
  `MISSING_CREDENTIAL` 原文；`load` 在两个 shim 上返回 `capability-unavailable`。
- 端到端复跑：`pnpm proof:acp-runtimes` 走真实配置与组合入口，三个 runtime 都通过。

focused tests 证据（`pnpm test:acp` / `test:config` / `test:agent-templates` /
`test:app`）：

- ACP 45、config 32、agent-templates 17，全部通过。
- 失败关闭：缺少 `[execution.opencode]` 段时 `acp-config-missing`；缺少
  `command` 时 `config-invalid`；未知 `driverRef` 时 `config-capability`。
- 回归用例：空转轮次不得判为 `succeeded`；被拒绝的空答案必须落为 `failed`；
  `close()` 之后不得残留 SIGKILL 宽限计时器把事件循环拖住。

## 8. 设计 DAG

本接线的设计图产物是 `docs/dagpipe/acp-runtime-wiring.graph.json`，语义标签在
`...graph.semantic.json`，owner 绑定在 `...graph.binding.json`。图形为单源单汇：

```text
user_configuration → resolve_agent_config → compose_acp_driver → open_acp_session
   → { run_opencode_adaptor | run_antigravity_shim | run_dsh_shim }
   → observe_driver_events → settle_acp_session → commit_acp_checkpoint
   → write_run_manifest
```

三个 adaptor 节点互斥：一次运行按 `driverRef` 只走其中一个。`write_run_manifest`
是唯一汇点，成功、失败与停止三种终态都汇入它。语义事件投影
（`projectExecutionSemanticEvents`）发生在 manifest 之后，属于运行结果投影而不在
本图声明的 `run_manifest` 输出内，因此不进入本图。

用 `pnpm dagpipe:validate` 与 `pnpm dagpipe:bind` 校验。
