# HumanAgent Provider Adapter 边界

状态：`M1-2 / RCC-ROUTER-ADAPTER-VERIFIED`
日期：2026-09-14

本文是 Provider 协议适配的唯一设计记录。它定义 HumanAgent 如何使用本机
RCC v3 作为 Milestone 1 的临时执行入口，以及 HumanAgent 负责的入口协议边界。
RCC 是透明代理，其上游 Provider 选择不属于 HumanAgent 的验收对象；本文记录
当前 RCC adapter 的实现边界，DSH adapter 仍是后续独立阶段。

## 1. 当前临时 Provider 基线

已只读核对到的非敏感事实：

| 项目 | 当前事实 | 证据边界 |
|---|---|---|
| 配置路径 | `~/.rcc` 是 `/Volumes/extension/.rcc` 的符号链接 | 只读路径检查 |
| v3 入口 | `rccv3` 当前监听 `*:4444` | `lsof` 进程/监听检查 |
| v3 传输声明 | `routecodex_v3_4444.execution.allowed_transports = ["json", "sse"]` | `~/.rcc/config.toml` 非敏感字段 |
| 路由 | v3 listener `routecodex_v3_4444` 暴露 `default` 等入口 | `~/.rcc/config.toml` route 名称 |
| 入口协议 | HumanAgent 显式选择 `responses` 或 `openai` | HumanAgent binding / 同入口验收 |

RCC 是透明路由入口：它可以按模型选择上游、重试并过滤不稳定 Provider。因此
`/v1/models` 为空、请求模型未出现在发现列表，或响应里的最终 `model` 与请求
不同，都不能单独阻断 HumanAgent 请求。HumanAgent 只把 `/health` 作为入口
readiness，把模型发现作为可选 evidence，并以实际协议响应和生命周期闭环确认
可用性。

这些事实只证明本机配置和 listener 的存在，不能证明 HumanAgent 的 Provider
请求、流式解码、工具调用或停止闭环已经成功。适配验证必须分别完成：

1. listener/config readiness；
2. `responses` codec readiness；
3. `openai` codec readiness；
4. 同一 HumanAgent 入口的请求、事件、错误和 stop/settle replay。

`~/.rcc` 是外部 Provider 的配置真源，不是 HumanAgent 的配置真源。HumanAgent
只读取、校验和记录必要的 capability/lock 摘要；不得写入、迁移、重启或替换
RCC 配置，也不得把 token、auth handle 或完整配置写入 Journal、仓库或 goal
prompt。

## 2. 依赖方向和身份边界

```text
HumanAgent core/runtime
        ↓ ExecutionRuntimePort
Provider-neutral binding
        ↓ ProviderAdapterPort
RCC transport adapter / DSH bridge
        ↓
RCC v3 :4444 或其他明确授权的 Provider endpoint
```

DSH 和 RCC 是两个不同的边界：

- `ExecutionRuntimePort` 由 HumanAgent 拥有，决定 Task、Operation、epoch、
  checkpoint、Attention 和 stop/settle 语义。
- DSH adapter 负责 DSH session、Agent、tool 和原生执行事件。
- Provider adapter 负责协议请求/响应、流、工具调用表示、错误和取消语义。
- RCC 只提供受控的本地 Provider 入口；其 route、model、auth alias、session
  和 request id 都是外部证据，不是 HumanAgent 的 `TaskId`、`AgentRuntimeId`
  或 `CheckpointId`。

HumanAgent 不能因为所有请求都经过 `127.0.0.1:4444` 就认为协议相同。4444
是透明路由 listener，不是最终 Provider 身份；协议选择仍必须来自锁定的
Provider binding。`routeRef` / `--route` 只表示 HumanAgent 本地入口标签，用于
binding、evidence 和审计关联；它不是 RCC 请求体或 header 中可由客户端选择的
上游 route。RCC 4444 的上游路由由它自己的 typed request facts 分类决定，
所以该标签也不得用来校验最终上游 Provider。
`/health` 失败才阻断入口 readiness；模型发现失败、空列表或模型未列出时保留
evidence，仍允许实际请求验证 RCC 的路由能力。不能猜测协议，也不能静默改用
另一条协议。

## 3. Provider-neutral contract

高层只依赖协议无关的端口。名称为设计契约，具体 TypeScript 类型在 M1-1
通过负向测试锁定：

```text
ProviderBinding
  bindingId
  providerId
  protocol: responses | openai | anthropic | other-explicit
  endpointRef
  modelRef
  configDigest
  capabilityDigest

ProviderAdapterPort
  probe(binding) -> ProviderReadiness
  start(operation, request) -> ProviderStartReceipt
  observe(operation) -> ProviderEvent stream
  requestStop(operation, reason) -> ProviderStopReceipt
  settle(operation) -> ProviderSettleReceipt
  close(binding) -> ProviderCloseReceipt
```

端口必须满足：

- `providerId`、`protocol`、`modelRef` 和 `endpointRef` 为显式绑定，不能由
  response body、debug log 或 prompt 反推；
- 外部 request/session id 只能进入 `EvidenceRef` 或显式 `ExecutionBinding`；
- `requestStop` 只表示停止请求已发出或被拒绝，不能直接产生高层 `stopped`；
- 只有 settle 结果、资源释放结果和 HumanAgent stopped checkpoint 一起成立，
  才能关闭 stop operation；
- Provider error 必须带原始协议分类、可重试性、影响范围和 owner，不能把
  HTTP/stream error 包装成普通 `WorkResult`；
- adapter 关闭、transport 断开、进程崩溃和 readiness 失败都必须有下一动作，
  不得留下无 owner 的 open operation。

## 4. 协议适配链

本阶段 RCC 入口验收只覆盖 `responses` 和 `openai`。`anthropic` 保留为既有
独立 adapter 边界，不属于本阶段 UI Provider Loop 的 RCC 验收路径。

### 4.1 Responses adapter

`responses`入口使用独立 Responses codec，入口路径为 `/v1/responses`。
`providerId`只表示本地 binding 标签，不参与最终上游 Provider 校验。

Responses adapter 独立拥有：

- request body 到 Responses schema 的编码；
- response item、reasoning、text、tool call 和 usage 的事件投影；
- response stream 的 completed/incomplete/error 终态；
- Responses 特有的 continuation、previous response 或 tool result 语义；
- Responses 特有的 cancel/close/settle 映射。

### 4.2 OpenAI Chat adapter

`openai`入口使用独立 OpenAI Chat codec，入口路径为 `/v1/chat/completions`。
不得把 Responses 或 Anthropic 的字段拼接后当作兼容层。

OpenAI Chat adapter 独立拥有：

- chat messages 和 function tools 的编码；
- `chat.completion.chunk`、content delta、tool_calls 和 finish_reason 的事件
  解码；
- `[DONE]`、provider error 和停止后的终态映射；
- OpenAI Chat 特有的 cancel/close/settle 映射。

### 4.3 Anthropic adapter

`anthropic`入口使用独立 Anthropic codec，入口路径为 `/v1/messages`。
不得把 Responses 的字段拼接后当作兼容层。

Anthropic adapter 独立拥有：

- messages/content block 的编码；
- text、thinking、signature、input-json、tool-use 和 tool-result 的事件
  解码；
- message_start、content_block、message_delta 和 message_stop 的终态映射；
- Anthropic 特有的 max tokens、system、stop reason 和 usage 语义；
- Anthropic 特有的 cancel/close/settle 映射。

各 adapter 共享的只有：

- `ProviderAdapterPort`；
- binding/capability/readiness 结构；
- evidence、error owner、epoch fence 和 stop/settle 结果格式；
- fake provider contract tests 的协议无关部分。

不得共享的内容：

- request/response codec；
- stream event union 的协议假设；
- tool-call 字段形状；
- provider error 分类；
- continuation、cancel 和 close 的语义；
- route/model/auth alias 的默认值。

## 5. RCC 4444 与 DSH 的组合方式

M1 允许两种实际绑定，但必须在 manifest 中显式选择，不得隐式切换：

```text
HumanAgent → ProviderAdapter → RCC v3 :4444
HumanAgent → DSH Adapter → DSH profile → DSH provider binding → RCC v3 :4444
```

第一种用于验证 HumanAgent Provider port 和协议 codec；第二种用于验证 DSH
session/Agent/tool 与 HumanAgent ExecutionRuntimePort 的完整边界。第二种中，
DSH 可以承担 Provider transport，但 DSH session log 仍只属于执行证据；它不
改变 HumanAgent 的 Journal/checkpoint 真源。

M1-0 必须先确认 DSH 当前版本是否公开支持把 Provider endpoint、protocol 和
model binding 以可审计方式传入专用 profile。如果只能通过隐式默认 route、
prompt 字段或不可读取的环境状态传入，阶段必须停在
`capability-unavailable`，不以“4444 可连接”代替适配完成。

## 6. 配置与锁定

HumanAgent 配置和外部 RCC 配置物理分离：

```text
~/.humanagent/
  config.toml          # 用户可配置入口
  internal.toml        # 运行时生成/锁定的内部配置
  profiles/<profile>/  # HumanAgent plugin/template/provider binding lock

~/.rcc/
  config.toml          # RCC 外部真源，不由 HumanAgent 修改
  provider/<id>/        # 外部 Provider 配置，不复制到 HumanAgent
```

HumanAgent lock 只记录：provider id、protocol、endpoint 的非敏感引用、模型
引用、RCC 配置/能力摘要 digest、adapter 版本、DSH profile/bundle digest 和
验证时间。它不保存 secret 内容。配置变化默认是 restart-only：停止接收新
任务，收拢当前 operation，提交 checkpoint，重启后重新 probe，再恢复。

## 7. 失败矩阵

| 失败点 | 高层状态 | Owner | 必须保留 |
|---|---|---|---|
| `4444` 无 listener | `dependency-missing` / `health-blocked` | Provider supervisor | probe error、下一次 probe 条件 |
| listener 存在但协议未知 | `capability-unavailable` | Provider adapter | 未选择 codec，不得发送猜测请求 |
| `responses` codec 错误 | operation `failed` + Attention | Responses adapter | 原始分类、request evidence、恢复动作 |
| `anthropic` codec 错误 | operation `failed` + Attention | Anthropic adapter | 原始分类、stream evidence、恢复动作 |
| provider transport 断开 | `degraded` / `waiting` | Provider supervisor | close/settle 结果、重连或人工处理条件 |
| DSH session 崩溃 | DSH execution failed | DSH adapter | session evidence、HumanAgent operation/checkpoint |
| cancel 已返回但未 settle | `stopping` | Stop controller | cancel receipt、settle 等待条件 |
| settle 后 checkpoint 失败 | `blocked` | Journal/runtime owner | 外部结果、未提交 checkpoint、恢复动作 |

验证按适用路径分层，而不是把每个故障机械复制到所有路径：

- 公共高层不变量（binding identity、epoch fence、operation/error owner、
  cancel≠stopped、settle/checkpoint）必须在 fake contract、recorded replay、
  real RCC 和 real DSH 四层保持一致；
- Responses 错误、stream 和 tool-call 由 `responses` 入口路径验证；
- OpenAI Chat 错误、stream 和 tool-call 由 `openai` 入口路径验证；
- Anthropic 只保留既有 codec 边界，不是本阶段 RCC 入口验收项；
- DSH session crash、plugin incompatibility 和 DSH profile dispose 只要求在
  real DSH 路径有真实证据；RCC 直连路径不伪造 DSH session；
- RCC listener/protocol readiness 和 direct request 只要求在 real RCC 路径有
 真实证据；不能用 DSH 日志替代。

## 8. M1-2 验证结果

当前 RCC `4444` 已通过同一 HumanAgent ProviderAdapter 入口：

```text
probe → ready (rcc-v3)
start → accepted
observe → 3 events
settle → succeeded / released / committed
close → closed
```

本次真实响应的最终 `model` 为 `deepseek-v4-flash-0731`，与请求模型不同，未被
HumanAgent 当作 binding mismatch 拒绝。RCC 返回的空 response/message id 和重复
`response.done` trailer 由 adapter 做协议级兼容：生成本地观测引用并忽略重复
trailer；真正缺少必需字段仍然失败。

focused provider、replay 和 RCC tests：`49 passed, 0 failed`；TypeScript
检查：通过。无证据的其他 Provider 或 DSH 兼容性仍保持未完成状态。
