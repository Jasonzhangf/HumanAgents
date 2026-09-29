# Dashboard 真实端到端验收与清理规则

本规则是 Dashboard 输入、确认、执行进度和结果展示修复的验收入口。页面能打开、Provider 显示 `connected`、单测通过或单次 API 调用成功，都不能代替本规则要求的浏览器端到端证据。

## 必经业务链

每个 E2E 都从真实浏览器中的任务输入开始，按同一条主链完成：

```text
浏览器输入
  → 可见任务草稿
  → 用户点击确认
  → 任务进入运行队列
  → 多个有语义的执行 turn
  → 可核验的终态与结果
```

运行期间，界面须持续显示当前阶段、正在做什么、在等哪个对象及等待时长。每轮 Provider 请求、工具调用请求、工具执行结果和模型最终输出须分别呈现，工具结果不得伪装成工具调用。当前修复影响到的成功/失败分支都须检查；其他不受影响或不适用的分支在 receipt 中写明 `N/A` 和理由。失败须显示原始错误语义、settlement/retry 状态和下一步，不能静默失败或无限转圈。

## 三类真实任务

三个任务各自使用新的 task/run ID，并全部通过真实 WebUI、Runtime 和相应真实能力完成：

1. **网络搜索**：通过 Agent Reach 执行真实搜索；任务详情能看到实际搜索工具调用、工具结果、来源和正常完成状态。
2. **本地只读搜索**：通过真实文件工具搜索隔离 workspace；任务详情能看到实际工具调用、真实文件路径和匹配内容；确认 workspace 未被修改。
3. **AItest task**：先核实 AItest 仓库、目标 task、输入/输出及适用 checker；使用本轮专属隔离目录执行真实任务；确认产物存在且 checker 通过，既有任务数据未被覆盖。

每类只可由一次完整任务成功计数；错误尝试、单轮调用、API-only、mock、旧候选收据都不计入成功次数。Retry-10 是独立能力验证，不计入上述三项。

## 候选证据

每个成功任务的 receipt 必须绑定同一候选 SHA 和 tree，并包含：task/run ID、候选 SHA/tree、输入与确认阶段证据、关键 API/journal 事件、每个 turn 的请求/调用/结果/输出、任务终态、相关 checker（AItest）、浏览器截图，以及真实文件或搜索来源等业务结果证据。Receipt 与截图写到该候选的 `dist/receipts/dashboard-e2e/`；路径不得指向另一候选或旧 run。

候选含未提交改动时，身份须同时记录 HEAD SHA、HEAD tree、`git diff --binary HEAD` 的 SHA-256、tracked/untracked 状态和 harness digest；所有会影响运行或测试的 untracked 输入须逐项列出并 hash。源码、测试或 harness 任一变动都会使旧 receipt 失效，必须从该状态重跑受影响的真实 E2E。

真实浏览器验收必须显式设定 receipt 与截图目录，例如：

```sh
mkdir -p dist/receipts/dashboard-e2e
HUMANAGENT_BROWSER_RECEIPT_PATH=dist/receipts/dashboard-e2e/local-file.json \
HUMANAGENT_BROWSER_SHOT_DIR=dist/receipts/dashboard-e2e/local-file-shots \
node tests/app/real-browser-explicit-implicit-e2e.mjs
```

该脚本当前只覆盖本地文件读取；网络搜索与 AItest 需使用各自真实浏览器任务入口和独立 receipt，不能把上例重复运行三次充作三类能力。

失败尝试另记 `INCOMPLETE` receipt，包含首次偏离、原始错误、关联 task/operation/tool-call ID 和必要截图。失败 receipt 用于修复与复现，不可充当成功证据。

## 固定清理闭环

每次 attempt 启动前先登记：owner、唯一 run ID、候选 SHA/tree、workspace、control root、启动的服务 PID 与端口、浏览器/本轮 profile、临时文件和日志路径。只登记本轮创建或明确归本轮所有的资源。

无论成功、失败、超时或取消，都必须在 `finally` 中：

1. 关闭本轮浏览器上下文；若使用共享浏览器 daemon，只关闭本轮创建的 profile/target，不关闭共享 daemon。
2. 通过服务接口或本轮启动所得的精确 PID 停止本轮服务；禁止 `pkill`、`killall`、`kill $(...)`、`xargs kill` 或端口扫描后批量终止。
3. 在成功/失败 receipt 和必要截图落盘后，删除本轮创建且不再需要的 workspace、control root、临时日志和运行目录；不得删除他人资源、共享状态、既有 AItest 数据或候选 worktree。
4. 复核本轮 PID 已退出、服务端口已关闭、临时路径均不存在，并将清理结果写入 receipt。

任一清理动作失败时，attempt 必须标记 `INCOMPLETE`，receipt 记录 owner、精确路径或 PID、失败原因和所需后续动作；不得把“已发出停止命令”当作资源已释放。Receipt 与必要截图是交付证据，保留到候选收口；其他临时数据不得因失败重试而累积。

清理 receipt 至少记录服务地址与端口、精确 PID、服务停止接口/命令及其结果、进程不存在的核验结果、端口关闭的核验结果、每个临时路径不存在的核验结果。核验命令和原始退出码或等价结构化结果必须落盘；只记 `cleanup: done` 不算证据。

## Retry-10 独立验收

计数合同来自 `RetryCycleControlRecord.retryBudget`：`maxRetries: 10` 指初始 attempt 之外可重试 10 次，因此最多是 **11 次 Provider attempt（attempt 1 + retry 1..10）**。每次 attempt 失败并且 `settleState=retry-safe`、Provider close 已闭合时，才可进入下一候选；pending、unknown、unsettled、cancelled 或未关闭均不得增加 attempt，也不得切换 Provider。成功可在预算耗尽前结束。

Retry-10 若在本次候选范围内，必须单独使用至少 11 个可区分 Provider binding 的配置和新的 task/run ID 验证，不能计入三类浏览器 E2E。至少验证：

1. 成功路径：A 的 settled terminal failure 与 `close=closed` 后，B 以新 execution epoch 被派发并成功；journal 顺序与 UI 语义 turn 一致。
2. 耗尽路径：11 个 attempt 按 attempt 1..11 各使用不同且排好序的 binding；每次均有 settled retry-safe failure 与 `close=closed`；终态为 exhausted；没有 attempt 12 或 Provider 12 派发。
3. 不安全路径：Provider close pending/unknown、unsettled、cancelled 等情况不切换到下一 Provider，并进入明确的 attention/recovery 终态。

receipt 必须绑定候选 SHA/tree、配置 revision/digest、候选 binding 顺序、task/operation/tool-call ID，并逐 attempt 记录 attempt 序号、总 attempt 上限、binding ID、execution epoch、开始/终止事件、原始失败、close 结果和 journal settle 状态；同时包含无第 12 次派发的 journal/query 证据及 exhausted/attention 终态。一次 A→B 切换只能证明一次 retry，不能证明完整 Retry-10 预算与耗尽语义。

工具参数错误本身不能冒充 Provider A 的 settled terminal failure；若工具错误未能形成已闭合的终态，不能宣称 Retry-10 已验证。

## 当前命令与能力边界

以下命令是当前项目已有的针对性验证：

```sh
pnpm test:app
pnpm test:ui
pnpm typecheck
node tests/app/real-browser-explicit-implicit-e2e.mjs
```

浏览器脚本 `real-browser-explicit-implicit-e2e.mjs` 当前覆盖真实 UI 的本地文件读取流程，并在 `finally` 关闭 Playwright browser、停止本轮服务、默认移除临时 root；设置 `HUMANAGENT_BROWSER_KEEP_ROOT=1` 会保留该 root，正式验收不得设置。`real-explicit-implicit-e2e.mjs` 和 `real-failure-cleanup-proof.mjs` 是真实 Runtime/API 证明，不是这三类浏览器任务的替代品。当前没有一个统一命令串起网络搜索、本地搜索、AItest task 三类浏览器 E2E；在该入口补齐前，三类任务须分别运行并各自提交完整 receipt，任何一类缺失都保持 `INCOMPLETE`。

正式安装验证顺序：在已 review 且 clean 的候选执行 `pnpm build:release`、`pnpm release:check`、`pnpm run install:global`；随后从任意非仓库目录执行 `humanagent --version`，再以 `humanagent --workspace <本轮专属 workspace> --port <空闲 loopback 端口>` 启动正式 WebUI，并用新浏览器页面复核输入、确认、turn、工具结果和最终输出。receipt 记录候选 SHA/tree、release manifest 中的 artifact 路径与 SHA-256、安装命令结果、`command -v humanagent` 的实际路径与 binary SHA-256、版本响应、服务 PID/端口/health、页面截图及清理证据。实际 binary 必须来自已验候选 release artifact；不得用候选源码版本或 `connected` 状态替代安装与运行态证据。

**放行条件：** 三类浏览器 E2E 全部成功、Retry-10（若在候选范围内）独立验收通过、适用定向测试和独立 review 通过、正式安装启动后运行产物与候选一致、真实页面复核通过，且本轮资源清理核对通过。任一项缺证据即不得称为交付完成。
