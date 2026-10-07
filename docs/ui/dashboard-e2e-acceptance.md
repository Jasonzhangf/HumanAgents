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

1. **网络搜索**：通过 Agent Reach TinyFish `/search` 完成真实搜索；任务详情能看到实际工具调用、结果来源和正常完成状态。只可按 `docs/architecture/hand-search-websearch-plan.md` 中明确覆盖 Agent Reach/Monid TinyFish、Dashboard 工具注册和调用/取消/result/report/cleanup 路径的版本实施；该 SESE DAG 须经独立 review PASS 后才能编码。若引用版本仍标为未审 design candidate、排除外部 provider 或只描述 Hand service 而无 Dashboard 到 TinyFish 的可执行边，则本类保持 `INCOMPLETE`。不得改用内置搜索、mock、模型知识或付费 provider。
2. **本地只读搜索**：Dashboard 的真实 Responses 工具循环先调用 `file.search`，再读取搜索命中的文件；不能从预先知道的路径直接 `file.read`、用 Explicit Brain intent 或只读代码检查代替 Provider 搜索工具。`ProviderEvent.toolCall` 是调用 ID、toolId 和 arguments 的唯一真源。Provider contract 须扩展 `ProviderEvent`，让 `toolPhase='result'` 携带合法、经 validator 校验的 typed `ProviderToolResult`（task/operation/epoch、callId、toolId、status、evidenceRefs、error）；调用失败或取消也必须产生同 callId 的失败/取消结果，不能只向上抛异常。成功结果须包含唯一 typed immutable output descriptor `{ outputRef, outputDigest }`，其中 `outputDigest` 为 `sha256:<64 lowercase hex>`；`packages/app/src/provider-tool-execution.ts` 是报告持久化与摘要生成唯一 owner，写入 `ImmutableAssetStore` 后将 descriptor 附入结果，validator 检查格式，读取时重算 SHA-256。不得在 result event 伪造 `toolCall` 或违反 event validator。`packages/adapters/provider/src/agent-driver.ts` 从原调用上下文关联结果，`packages/runtime/src/ui-runtime/coordinator.ts` 唯一负责将调用与结果投影到 `RuntimeTaskEvent`/Journal。`packages/ui/contracts/runtime.ts` 须声明 `RuntimeTaskEventProjection` 和 `RuntimeSseEvent` 的类型字段；`packages/app/src/ui-runtime/service.ts`、`server.ts` 与 Dashboard renderer 按契约提供 GET/SSE/DOM 投影。不得从 summary、eventId、evidence locator、operationId 或最终回答推导调用 ID、query、result。事件与公开投影须保留 taskId、operationId、executionEpoch、seq、callId、toolId、arguments、结果状态/错误及该 immutable descriptor。UI server 须提供 task-scoped `GET /api/tasks/{taskId}/operations/{operationId}/executions/{executionEpoch}/events/{seq}/tool-output`，由 `UiRuntimeService` 校验 task/operation/epoch/seq 对应的成功 `file.search` 结果及 descriptor digest 后返回报告；不能用 task 范围内未经保证唯一的 callId 单独查找，也不能暴露 artifact 文件路径。未实现该读取入口前，本地搜索 E2E 不得通过。真实 runner 通过 Dashboard 页面、页面实际使用的 `GET /api/tasks/{taskId}/dashboard` 和 SSE 验证同一 `file.search` invoke/result 的 callId、toolId 以及 taskId、operationId、epoch、seq 关联一致，通过上述读取入口断言报告包含 query、匹配路径及行/摘要；之后 `file.read` 必须读取搜索命中的同一路径，并将真实路径与内容写入 receipt。执行前后 receipt 都保存按相对路径排序的 workspace 文件清单及每个文件的 SHA-256，且断言两份清单完全相同。上述投影、搜索报告、读取入口或清单证据缺失时，本类为 `INCOMPLETE`。
3. **AItest task**：先核实 AItest 仓库、目标 task、输入/输出及适用 checker；使用本轮专属隔离目录执行真实任务；运行 task 指定 checker，并按 task 的人工观察要求检查产物语义/视觉结果；记录观察截图与结论，确认既有任务数据未被覆盖。仅检查 HTML/SVG/动画标签存在不能证明 task 完成。

每类只可由一次完整任务成功计数；错误尝试、单轮调用、API-only、mock、旧候选收据都不计入成功次数。Retry-10 是独立能力验证，不计入上述三项。

## 候选证据

每个成功任务的 receipt 必须绑定同一候选 SHA 和 tree，并包含：task/run ID、候选 SHA/tree、输入与确认阶段证据、关键 API/journal 事件、每个 turn 的请求/调用/结果/输出、任务终态、相关 checker（AItest）、浏览器截图，以及真实文件或搜索来源等业务结果证据。本地搜索 receipt 还须分别证明搜索 query/结果和随后读取的内容；只有 `file.read` 事件的 receipt 不满足本地搜索验收。AItest receipt 须附 checker 原始结果及 task 要求的人工观察记录/截图。Receipt 与截图写到该候选的 `dist/receipts/dashboard-e2e/`；路径不得指向另一候选或旧 run。

候选含未提交改动时，身份须同时记录 HEAD SHA、HEAD tree、`git diff --binary HEAD` 的 SHA-256、tracked/untracked 状态和 harness digest；所有会影响运行或测试的 untracked 输入须逐项列出并 hash。源码、测试或 harness 任一变动都会使旧 receipt 失效，必须从该状态重跑受影响的真实 E2E。

真实浏览器验收必须由受版本控制的 runner 显式设定 receipt 与截图目录，命令自身即入口：

```sh
pnpm e2e:dashboard:local-file-search
```

runner 把 `receipt.md`、`evidence.json` 与截图写到该候选的
`dist/receipts/dashboard-e2e/<scenario>/`；命令未产出 receipt 或 receipt 的 `result`
不是 `SUCCESS` 时，该场景为 `INCOMPLETE`。不要再用已退役的独立兼容脚本充当浏览器验收。

## 标准浏览器入口合同

三类场景必须使用同一受版本控制的真实浏览器 runner，并各自以独立命令启动，产生新的 task/run 和独立 receipt：

```sh
pnpm e2e:dashboard:web-search
pnpm e2e:dashboard:local-file-search
pnpm e2e:dashboard:aitest
```

每条命令必须从真实 Dashboard 建立隔离 runtime/workspace，执行真实业务能力并验证成功终态；不得调用 API 代替浏览器用户流程。本次修复的成功、失败和取消断言必须分别由 runner 执行。命令缺失、runner 不支持对应场景或 capability 未接线时，该类为 `INCOMPLETE`，不能退回使用 mock、checker-only 或一次 Provider 调用计数。

三条命令已在 `package.json` 落地，runner 与三个场景模块位于 `tests/app/dashboard-e2e/`。
命令存在不等于场景已通过：`web-search` 受
[`docs/architecture/hand-search-websearch-plan.md`](../architecture/hand-search-websearch-plan.md)
的门禁约束，`aitest` 受 checker 与人工观察记录约束；只有各自 receipt 绑定当前候选且
`result: SUCCESS` 时该场景才可标记通过。

AItest 的 checker 成功不能代替 task 语义验收：必须保存 checker 原始 stdout/exit code 和人工观察记录。用户取消或 checker/结果验证失败时，Dashboard 必须有明确非成功终态；网络搜索失败时须展示真实 Provider 错误，不得伪造空结果成功。本地搜索结果为零时须显示真实的零命中结果，不能把搜索未执行表现成零命中。

失败尝试另记 `INCOMPLETE` receipt，包含首次偏离、原始错误、关联 task/operation/tool-call ID 和必要截图。失败 receipt 用于修复与复现，不可充当成功证据。

## 固定清理闭环

每次 attempt 启动前先登记：owner、唯一 run ID、候选 SHA/tree、workspace、control root、启动的服务 PID 与端口、浏览器/本轮 profile、临时文件和日志路径。只登记本轮创建或明确归本轮所有的资源。

无论成功、失败、超时或取消，都必须在 `finally` 中：

1. 若用户取消或 runner 超时且任务仍在运行，通过 `POST /api/tasks/{taskId}/stop` 发起 task-scoped stop；轮询 Dashboard 与 Journal，直到 stop/checkpoint 已 settled 并且任务到达明确终态。不能证明 settle/终态时，先落 `INCOMPLETE` receipt，保留该 task 的 control root/workspace 和恢复所需证据；不得停服务或删除这些资源。
2. 保存最终必要截图并关闭本轮浏览器上下文；若使用共享浏览器 daemon，只关闭本轮创建的 profile/target，不关闭共享 daemon。
3. 只有任务已 settled 到明确终态时，才通过服务接口或本轮启动所得的精确 PID 停止本轮服务；禁止 `pkill`、`killall`、`kill $(...)`、`xargs kill` 或端口扫描后批量终止。若 task 未 settled，保留该 task 恢复所需的服务及精确 PID，并在 receipt 指定唯一 recovery owner；这属于 `INCOMPLETE` 的未收口恢复资源，不得标记清理成功。
4. 只有任务已 settled 到明确终态时，才在 receipt 记下终态、stop/checkpoint settle、错误和当前清理状态后，删除本轮创建且不再需要的 workspace、control root、临时日志和运行目录；不得删除他人资源、共享状态、既有 AItest 数据或候选 worktree。若未 settled，只保留恢复所必需资源并记录路径、owner 和下一步。
5. 复核本轮 PID、端口和临时路径：已 settled 的任务必须证明本轮 PID 已退出、端口已关闭、清理路径不存在；未 settled 的任务必须列出仍存活 PID/端口/路径及 recovery owner，标记 `INCOMPLETE`。将命令、退出码及核验结果写入 receipt。

任一清理动作失败时，attempt 必须标记 `INCOMPLETE`，receipt 记录 owner、精确路径或 PID、失败原因和所需后续动作；不得把“已发出停止命令”当作资源已释放。Receipt 与必要截图是交付证据，保留到候选收口；其他临时数据不得因失败重试而累积。

清理 receipt 至少记录服务地址与端口、精确 PID、服务停止接口/命令及其结果和所有临时路径。若 task 已 settled，receipt 须附进程退出、端口关闭、每个清理路径不存在的核验命令及原始退出码/等价结构化结果；若 task 未 settled，receipt 须附仍存活 PID/端口/保留路径、recovery owner、stop/settle 的已知结果和下一步，不得要求这些恢复资源不存在，也不得标记 cleanup complete。只记 `cleanup: done` 不算证据。

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
pnpm e2e:dashboard:local-file-search
```

`pnpm e2e:dashboard:local-file-search` 是三类浏览器 E2E 中已被实际观测到成功的一条：
它以 exit 0 结束并把 `SUCCESS` receipt 写到
`dist/receipts/dashboard-e2e/local-file-search/`。`pnpm e2e:dashboard:web-search` 与
`pnpm e2e:dashboard:aitest` 同样已在 `package.json` 落地，但各自仍受其门禁约束（见
§三类真实任务）；它们未产出绑定当前候选的 `SUCCESS` receipt 前不得计为通过。

Retry-10 coordinator tests are not run by `pnpm test:runtime` today. When
Retry-10 is in scope, the same candidate must also run this explicit gate and
retain its raw output/exit status in the candidate-bound receipt:

```sh
pnpm exec tsc -p tests/runtime/orchestration/tsconfig.json \
  && node --test \
  dist/tests/tests/runtime/orchestration/retry-cycle.test.js \
  dist/tests/tests/runtime/orchestration/retry-cycle-coordinator.test.js
```

候选验证必须在同一个精确候选树中按顺序执行。`provider`、`app`、`ui`、`runtime` 和 `hand` gate 的原始退出码与日志路径都要绑定到候选 SHA/tree；修复后只重跑受影响 gate，但最终候选仍须包含完整的适用结果。上面的 `pnpm e2e:dashboard:local-file-search` 只证明它实际覆盖的本地搜索路径；网络搜索和 AItest 必须各有独立的真实 Dashboard 流程与 receipt，不能因为该命令通过而略过。

`real-explicit-implicit-e2e.mjs` 和 `real-failure-cleanup-proof.mjs` 是真实 Runtime/API 证明，不是这三类浏览器任务的替代品。runner 的每个场景都必须在 `finally` 按上面的 settled/未 settled 两分支完成收口。已 settled 的 task 必须关闭本轮 browser context、停止精确归属本轮的服务 PID，并核验 PID 退出、端口关闭和临时路径删除；未 settled 的 task 必须保留并记录恢复所需的服务 PID/端口/路径、recovery owner 和下一步，标 `INCOMPLETE`，不得宣称清理完成。正常成功路径不得设置保留临时 root 的开关。失败、超时和取消都须写 `INCOMPLETE` receipt，且报告真实清理或恢复资源状态。三个 `pnpm e2e:dashboard:*` 命令与三类场景均已落地；本规则定义放行合同，具体场景是否通过只由绑定当前候选的 receipt 证明。

正式安装验证顺序：在已 review 且 clean 的候选执行 `pnpm build:release`、`pnpm release:check`、`pnpm run install:global`；随后从任意非仓库目录执行 `humanagent --version`，再以 `humanagent --workspace <本轮专属 workspace> --port <空闲 loopback 端口>` 启动正式 WebUI，并用新浏览器页面复核输入、确认、turn、工具结果和最终输出。receipt 记录候选 SHA/tree、release manifest 中的 artifact 路径与 SHA-256、安装命令结果、`command -v humanagent` 的实际路径与 binary SHA-256、版本响应、服务 PID/端口/health、页面截图及清理证据。实际 binary 必须来自已验候选 release artifact；不得用候选源码版本或 `connected` 状态替代安装与运行态证据。

**放行条件：** 三类浏览器 E2E 全部成功、Retry-10（若在候选范围内）独立验收通过、适用定向测试和独立 review 通过、正式安装启动后运行产物与候选一致、真实页面复核通过，且本轮资源清理核对通过。任一项缺证据即不得称为交付完成。
