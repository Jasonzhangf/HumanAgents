# HumanAgent 最终交付：真实前端复杂任务验收计划

Status: ACTIVE（计划）
Date: 2026-11-04
Owner（计划）：Jenny（humanagent master）
Executor（真实验收）：测试工程师（David 或获授权测试 peer）
Reviewer（结果）：Emma（项目经理 / 质检消融架构师）

权威需求：

- `humanagent-final-delivery-real-frontend-complex-tasks`（version 1）
- `humanagent-final-delivery-stage-status-tracking`（version 1）

本计划把上述两条需求转成可执行、可核验的最终交付验收。它不替代
[`docs/ui/dashboard-e2e-acceptance.md`](../ui/dashboard-e2e-acceptance.md)
的通用验收契约；两者同时适用。

## 1. 放行目标与不可替代边界

最终交付只有满足以下条件才可宣称完成：

1. 由测试工程师本人从真实前端页面输入不同的复杂任务，不是只读脚本断言、不是直接调 API、不是单测替身。
2. 每个任务在真实运行时中实际执行并到达终态；终态结果可被独立复核。
3. 每个任务在实际阶段与等待过程中，状态更新都来自真实来源，并能核对阶段转换；不得用静态文案、虚假心跳或单次渲染冒充进展。
4. 单测、模型响应、任务启动、Provider connected、页面可打开、脚本 exit 0，任一项单独出现都不能代替最终完成。
5. 不满足上述条件的 attempt 记为 `INCOMPLETE`/`UNVERIFIED`，保留首次偏离、原始错误和恢复责任，不得改写为通过。

## 2. 真实入口与运行环境

- 前端服务：候选构建后的 `humanagent serve --mode rcc`，页面为真实 Dashboard/新建任务表单。
- Provider：真实 RCC `127.0.0.1:4444`（只读使用 `~/.rcc` 非敏感配置，不修改 RCC 配置）。
- 浏览器：真实 headless Chromium（Playwright），通过页面 DOM 操作完成输入、确认、等待、结果读取和会话观测。
- 数据根：`~/.humanagent` 派生的隔离 `controlRoot`/`runNotesRoot`；不写项目 workspace 的持久化数据。
- 资源登记：本轮 serve PID、端口、浏览器上下文、临时 control root、Task/operation ID 全部登记，按第 8 节收口。
- 禁止：修改 RCC 配置、重启生产 10086、批量 kill、`tmux kill-server`、daemon/tmux 生命周期操作。

页面入口与选择器复用既有 `tests/app/dashboard-e2e/lib/browser.mjs` 与真实浏览器 runner，
不为记录证据另造一套执行框架。runner 或页面无法承载某场景时，由测试工程师报告具体缺口，
不降低验收标准。

## 3. 代表性复杂任务与可核验终态

每个场景必须同时记录：输入原文、提交确认、Task/operation/interaction 关联、执行阶段状态、
工具调用与结果、终态、结果正文、截图和 journal 证据路径。场景之间使用独立 Task/attempt。

| 场景 | 复杂度类型 | 真实前端输入要求 | 终态与可核验断言 |
|---|---|---|---|
| A 本地资料检索与事实合成 | 多工具检索 + 内容归纳 | 在新建任务表单输入：检索工作区内指定文件中的事实，并给出原文依据 | Task `succeeded`；`file.search`/`file.read` 至少各 1 次成功；最终回答包含指定文件中真实存在的事实文本且与原文一致；journal 有对应 `provider.tool`/结果且 `outputDigest` 可解析 |
| B 网络研究并给出可核验来源 | 外部 Provider 工具 + 引用 | 输入：检索指定主题的当前信息，报告标题、URL 和页数 | Task `succeeded`；`web.search` 至少 1 次成功；最终回答包含真实 http(s) URL、标题；工具输出报告与页面 URL 对应且非空 |
| C 多步文件生成/改写 | 读 + 写 + 读回验证 | 输入：读取指定文件，提取内容并生成/改写一个派生文件，最后回报结果 | Task `succeeded`；`file.read` + `file.write`/`file.edit` + 读回一致；磁盘派生文件内容可独立读取并匹配终态声明；无越权路径写入 |
| D 长程多轮编排与等待推进 | 多轮 checkpoint + 动态编排 | 输入：一个需要至少 2 次执行轮次或真实等待的长程任务 | Task `succeeded`；至少 2 个 execution epoch 或明确 checkpoint 序号递增；执行轮次间有真实收口→checkpoint→下一轮关系；最终输出满足任务约定 |

场景选取原则：A/C 证明本地工具与副作用可核验，B 证明外部 Provider 链路，D 证明长程动态编排。
允许按当前产品能力对场景做等价替换，但每项必须有对应的成功终态断言和独立可复核证据；
替换不得削弱“真实前端 + 实际完成”的要求。

## 4. 阶段真实状态观测（强制）

对每个复杂任务，测试工程师须在实际阶段与等待过程中观察并核对状态更新。

### 4.1 需观察的阶段

按当前真实页面与 journal 实际暴露的阶段记录，不虚构产品未产生的阶段。至少核对：

1. 输入已提交/已确认（input accepted）。
2. 显式整理与投递（explicit normalization / queue）。
3. 执行开始（task running / dispatch）。
4. Provider 请求轮次（request/response round 或 tool call）。
5. 工具执行与结果（tool call / tool result）。
6. checkpoint 提交或轮次收口。
7. 终态（succeeded/failed/cancelled）与结果正文。

每个阶段须记录：页面可见状态文案、对应的权威 journal/事件或公开投影 id、时间顺序、
该阶段的实际等待对象（如有）。

### 4.2 真实来源绑定

- 页面状态必须能对应到同一 Task/operation/interaction 的权威记录（journal、task 投影或 SSE 事件）。
- 阶段转换须有前后状态证据，不能只截一张最终成品图。
- 工具进度须与真实 `provider.tool`/`provider.tool-result` 或公开工具结果对应，不能只靠 UI 文案。
- 等待状态须有真实等待对象或原因；不得用静态“处理中”文案或虚假心跳冒充进展。

### 4.3 无更新 / 失败判定

- 超过声明等待窗口仍无阶段更新，且无对应 journal/事件推进：该阶段记 `STALLED`，
  记录首次无更新时刻、最后状态、等待对象、相关日志，attempt 记 `INCOMPLETE`。
- 页面显示成功但 journal/终态不一致：记 `FAIL`，以权威终态为准，不采信 UI 单方。
- 页面显示失败但 journal 已成功：同样记 `FAIL`，保留首次偏离，交由产品 owner 判定。
- 等待或阶段状态被静态伪造（文案不变、无时间/事件、无来源）：记 `FAIL`，不进入最终通过。

## 5. 测试工程师执行合同

测试工程师（David 或获授权测试 peer）须：

1. 独立按真实前端操作，不读候选实现来推断预期，不直接注入 Task/事件。
2. 每个场景独立 attempt，记录输入、执行、结果和阶段状态证据。
3. 只用真实浏览器入口；不使用 API-only、单测或模型响应替代。
4. 运行环境与资源沿用本计划第 2 节；不触碰生产 10086、RCC 配置、daemon/tmux。
5. 对每个断言给出可复核路径；失败时保留原始错误、首次偏离和恢复责任。
6. 完成后交 Emma review；review 通过前不得宣称最终交付通过。

允许的辅助：浏览器截图、journal 只读导出、公开工具结果读取、receipt 写入。
禁止：伪造 receipt、修改业务终态、绕过 UI 直接改 journal、改写需求或断言。

## 6. 证据与回执格式

每个 attempt 至少包含：

- 候选 / 运行实例：serve 命令、mode、control root、端口、PID（自然 Git 提交标识）。
- 输入：用户原文、提交与确认动作、interaction/Task/operation ID。
- 阶段轨迹：按第 4 节记录的阶段、时间、状态来源、等待对象、转换前后证据。
- 执行：Provider 轮次、工具调用与结果、checkpoint、副作用（文件路径与内容摘要）。
- 终态：权威状态、结果正文、公开读取入口、页面与 journal 一致性断言。
- 截图：输入、执行中、等待/阶段状态、结果各至少 1 张（真实视口）。
- 失败/无更新：原错、首次偏离、STALLED 或 FAIL 判定、恢复责任。
- 收口：第 8 节资源核对结果。

receipt 落在配置派生的 `runNotesRoot/<attemptId>/`，截图在 `shots/`；不使用 `dist/` 冒充持久 receipt。

## 7. 失败、阻塞与停止

- 任一场景失败先停受影响场景，保留证据；不阻断仍可执行的独立场景。
- 真实环境缺失（RCC 4444 不可用、浏览器不可用、serve 无法启动）时，记录原错和缺失能力，
  停受影响场景并报告具体解除条件；不得用 fake/录制替代真实交付通过。
- 三次实质攻关仍未解除同一技术阻塞，升级到 owner/CEO 决策。

## 8. 资源收口

每轮 attempt 结束后：

1. 对本轮创建的测试 Task 走正式 task-scoped stop 通道并核对实际终态、checkpoint 与副作用。
2. 保存必要 receipt 与截图；只关闭本轮独有浏览器上下文与服务。
3. 只通过正式服务入口或本轮记录的精确 PID 停止临时 serve；禁止批量 kill、按端口扫描终止、停止他人服务。
4. 删除本轮创建且证据已保存的专属临时数据；未 settled 的 Task 保留恢复资源与 owner。
5. 逐项核对：临时 PID 已退出、端口关闭、删除路径不存在；保留资源列用途/owner/关闭条件。

## 9. 放行条件

最终交付通过须同时满足：

- 场景 A/B/C/D（或经批准的等价替代）全部在真实前端、真实 RCC、真实执行下到达可核验终态。
- 每个场景的阶段状态有真实来源、阶段转换和等待对象证据；无静态/虚假心跳冒充。
- 独立测试工程师执行并交 Emma review 通过；review 指出问题时先修复再复验。
- 第 8 节资源收口核对通过，残留资源有明确 owner 与关闭条件。
- 任一适用项缺证据时，结论保持 `INCOMPLETE`/`UNVERIFIED`，不进入最终交付通过。
