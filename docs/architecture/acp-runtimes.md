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
open / submit / cancel / close
```

- `open` 建立会话。direct runtime 在这里初始化真实 ACP 会话；shim 只登记关联标识。
- `submit` 跑一轮并返回 `outputText` 与 `stopReason`。
- `cancel` 请求取消。取消被接受不等于已停止。
- `close` 收拢会话，是停止完成的判定点。它等到进程真正退出后才返回；只发出信号
  不算已停止。`closed` 报告进程的真实状态：进程未退出时返回 `false`，会话条目保留，
  后续 `close` 可以重试。
- 恢复不由接缝提供。三个 runtime 都无法重开已持久化的会话，`AgentDriver.resume`
  因此直接以 `capability-unavailable` 失败，恢复走新 operation。

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
只有 `close` 完成后，driver 才把闭包状态判为 `stopped`。三个 runtime 的 `close`
都等到进程真正退出：opencode 经 `AcpStdioBackend`，两个 shim 经
`terminateProcess`，两者都在宽限期后升级为 `SIGKILL`。对一次性 CLI，`cancel`
的实际动作是结束在飞进程，其拒绝结果由 `submit` 显式抛出，不被吞掉。

`stopRequested` 只增不减。一次被接受的停止之后，后续被拒绝的停止请求不得把它
抹掉，否则 `settle` 会把一次真的停止报成 `failed`。停止请求的收据仍按本次尝试的
真实结果报告 `requested`。

ACP 是双工协议：`session/cancel` 是停止在飞轮次的唯一手段，所以它必须能超过仍未
应答的 `session/prompt`。`AcpStdioBackend` 的写锁因此只覆盖“写一帧”，不覆盖等待
应答。锁跨越等待会让 cancel 排在请求之后，在飞轮次只有等该请求超时才能停止。

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
- 端到端复跑：`pnpm proof:acp-runtimes` 走真实配置与组合入口，三个 runtime 都通过。
  receipt 还记录被执行的 `dist/app` 产物摘要与每个 runtime 的 `command`，所以证据
  能归因到该次构建与那些引擎。harness 要求三个 runtime 全部实际跑完；子集运行或
  空选择不能报 PASS。

focused tests 证据（`pnpm test:acp` / `test:config` / `test:agent-templates` /
`test:app`）：

- ACP 50、config 32、agent-templates 17，全部通过。
- 失败可见性：dsh 无凭据时 `submit` 以 `transport-failure` 抛出后端的
  `MISSING_CREDENTIAL` 原文。
- 失败关闭：缺少 `[execution.opencode]` 段时 `acp-config-missing`；缺少
  `command` 时 `config-invalid`；未知 `driverRef` 时 `config-capability`；任何
  runtime 的 `resume` 报 `capability-unavailable`。
- 回归用例：空转轮次不得判为 `succeeded`；被拒绝的空答案必须落为 `failed`；
  `close()` 之后不得残留 SIGKILL 宽限计时器把事件循环拖住；一次被接受的停止
  不得被后续被拒绝的停止抹掉；`session/cancel` 必须能在 `session/prompt` 仍未
  应答时送达，服务端收到 cancel 后应答该请求即为送达证据。
- 真实入口停止证据：`test:app` 用真实配置与真实组合入口启动 opencode，让引擎把
  `session/prompt` 保持在飞（stub 以 `hold` 模式运行，并在挂起时写出标记文件），
  再调用真实停止入口。断言 journal 出现 `"outcome":"stopped"`，且同一 operation
  不出现 `"outcome":"unknown"` 或 `"outcome":"succeeded"`。

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

停止控制面从图外进入 `settle_acp_session`：它不经过
`run_*_adaptor` 与 `observe_driver_events`，所以本图保持单源单汇。进入的前提是
该 operation 已有一次被接受的停止请求；`settle_acp_session` 只有在
`close.closed === true` 且已请求停止时，才把闭包判为 `stopped`，否则失败关闭并
由控制面显式报错。

用 `pnpm dagpipe:validate` 与 `pnpm dagpipe:bind` 校验。
