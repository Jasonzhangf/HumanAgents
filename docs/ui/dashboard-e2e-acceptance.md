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
2. **本地只读搜索**：在隔离 workspace 中先执行真实的文件搜索动作（如项目已接线的搜索工具，或明确只读的搜索命令），再读取命中的文件；不能从预先知道的路径直接 `file.read` 冒充搜索。任务详情和 receipt 须包含搜索 query、搜索调用及其匹配路径/摘要、后续读取的真实路径与内容证据，并确认 workspace 未被修改。
3. **AItest task**：先核实 AItest 仓库、目标 task、输入/输出及适用 checker；使用本轮专属隔离目录执行真实任务；运行 task 指定 checker，并按 task 的人工观察要求检查产物语义/视觉结果；记录观察截图与结论，确认既有任务数据未被覆盖。仅检查 HTML/SVG/动画标签存在不能证明 task 完成。

每类只可由一次完整任务成功计数；错误尝试、单轮调用、API-only、mock、旧候选收据都不计入成功次数。Retry-10 是独立能力验证，不计入上述三项。

## 候选证据

每个成功任务的 receipt 必须绑定同一候选 SHA 和 tree，并包含：task/run ID、候选 SHA/tree、输入与确认阶段证据、关键 API/journal 事件、每个 turn 的请求/调用/结果/输出、任务终态、相关 checker（AItest）、浏览器截图，以及真实文件或搜索来源等业务结果证据。本地搜索 receipt 还须分别证明搜索 query/结果和随后读取的内容；只有 `file.read` 事件的 receipt 不满足本地搜索验收。AItest receipt 须附 checker 原始结果及 task 要求的人工观察记录/截图。Receipt 与截图写到该候选的 `dist/receipts/dashboard-e2e/`；路径不得指向另一候选或旧 run。

候选含未提交改动时，身份须同时记录 HEAD SHA、HEAD tree、`git diff --binary HEAD` 的 SHA-256、tracked/untracked 状态和 harness digest；所有会影响运行或测试的 untracked 输入须逐项列出并 hash。源码、测试或 harness 任一变动都会使旧 receipt 失效，必须从该状态重跑受影响的真实 E2E。

真实浏览器验收必须显式设定 receipt 与截图目录，例如：

```sh
mkdir -p dist/receipts/dashboard-e2e
HUMANAGENT_BROWSER_RECEIPT_PATH=dist/receipts/dashboard-e2e/local-file.json \
HUMANAGENT_BROWSER_SHOT_DIR=dist/receipts/dashboard-e2e/local-file-shots \
node tests/app/real-browser-explicit-implicit-e2e.mjs
```

此兼容脚本只覆盖本地文件读取；即使运行成功，也不证明本地搜索、网络搜索或 AItest。

## 标准浏览器入口合同

三类场景必须使用同一受版本控制的真实浏览器 runner，并各自以独立命令启动，产生新的 task/run 和独立 receipt：

```sh
pnpm e2e:dashboard:web-search
pnpm e2e:dashboard:local-file-search
pnpm e2e:dashboard:aitest
```

每条命令必须从真实 Dashboard 建立隔离 runtime/workspace，执行真实业务能力并验证成功终态；不得调用 API 代替浏览器用户流程。本次修复的成功、失败和取消断言必须分别由 runner 执行。命令缺失、runner 不支持对应场景或 capability 未接线时，该类为 `INCOMPLETE`，不能退回使用本地文件读取脚本、mock、checker-only 或一次 Provider 调用计数。

当前 `package.json` 尚未提供这三个命令，当前 browser harness 也只执行 `file.read`，不执行搜索动作、不验证匹配路径，AItest checker 也不验证 task 语义/视觉结果。因此 runner 和三个命令仍是实现 gate；完成实现并通过这些命令前，三类浏览器 E2E 均不得标记通过。

AItest 的 checker 成功不能代替 task 语义验收：必须保存 checker 原始 stdout/exit code 和人工观察记录。用户取消或 checker/结果验证失败时，Dashboard 必须有明确非成功终态；网络搜索失败时须展示真实 Provider 错误，不得伪造空结果成功。本地搜索结果为零时须显示真实的零命中结果，不能把搜索未执行表现成零命中。

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
pnpm typecheck
pnpm test:provider
pnpm test:app
pnpm test:ui
pnpm test:runtime
pnpm test:hand
node tests/app/real-browser-explicit-implicit-e2e.mjs
```

候选验证必须在同一个精确候选树中按顺序执行。`provider`、`app`、`ui`、`runtime` 和 `hand` gate 的原始退出码与日志路径都要绑定到候选 SHA/tree；修复后只重跑受影响 gate，但最终候选仍须包含完整的适用结果。上面的浏览器脚本只证明其实际覆盖的本地文件读取路径；网络搜索和 AItest 必须各有独立的真实 Dashboard 流程与 receipt，不能因为该命令通过而略过。

`real-explicit-implicit-e2e.mjs` 和 `real-failure-cleanup-proof.mjs` 是真实 Runtime/API 证明，不是这三类浏览器任务的替代品。runner 的每个场景都必须在 `finally` 关闭本轮 browser context，停止精确归属本轮的服务 PID，核验 PID 退出、端口关闭和临时路径删除；不得设置保留临时 root 的开关。失败、超时和取消同样写带清理核验的 `INCOMPLETE` receipt。`pnpm e2e:dashboard:*` 命令及三类场景目前尚未落地，故本规则目前定义了放行合同，不代表验收已通过。

正式安装验证顺序：在已 review 且 clean 的候选执行 `pnpm build:release`、`pnpm release:check`、`pnpm run install:global`；随后从任意非仓库目录执行 `humanagent --version`，再以 `humanagent --workspace <本轮专属 workspace> --port <空闲 loopback 端口>` 启动正式 WebUI，并用新浏览器页面复核输入、确认、turn、工具结果和最终输出。receipt 记录候选 SHA/tree、release manifest 中的 artifact 路径与 SHA-256、安装命令结果、`command -v humanagent` 的实际路径与 binary SHA-256、版本响应、服务 PID/端口/health、页面截图及清理证据。实际 binary 必须来自已验候选 release artifact；不得用候选源码版本或 `connected` 状态替代安装与运行态证据。

**放行条件：** 三类浏览器 E2E 全部成功、Retry-10（若在候选范围内）独立验收通过、适用定向测试和独立 review 通过、正式安装启动后运行产物与候选一致、真实页面复核通过，且本轮资源清理核对通过。任一项缺证据即不得称为交付完成。
