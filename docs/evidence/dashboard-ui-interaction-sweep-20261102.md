# Dashboard 前端功能与交互巡检：证据与改进建议

结论：PASS（巡检本身完成）。四项发现中 2 项为新登记依据，另 2 项经核对为既有开放 bug 的重复观察，不重复登记。本文为独立巡检回执，不是本候选的提交或交付依据。

## 与既有 bug 的去重核对

| 巡检项 | 既有 bug | 处理 |
| --- | --- | --- |
| P1-a 状态枚举裸露 | 无精确对应（`ee0a4e0` 为同族但不同字段：taskTitle 暴露 subscription 标识） | 已登记 `1a6fee2` |
| P1-b 失败信息英文原样暴露 | 无对应（`8000805` 针对 entry 页功能文案，`486ddd4` 针对步骤摘要，均非 board failure） | 已登记 `3577e65` |
| P2-a 移动端悬浮按钮压输入框 | `28c9738`（P1，open） | 已补证据评论（#2），不重复登记 |
| P2-b interaction 停在 matching | `6a11c8d`（P1，open） | 已补证据评论（#1），不重复登记 |

P2-a 的核对值得展开：main 当前 `docs/ui/runtime.css:717` 在 `@media (max-width: 780px)` 下仍是 `padding: 72px 0 88px`，无水平内边，与 bug `28c9738` 描述一致。候选分支 `codex/p1-ui-copy-corner-20261102` 的 `5c74d0d47` 已改为 `padding: 72px 72px 88px`，即 72px 水平安全内边以避开 70px 宽的四角控件，但该候选尚未合并，所以本轮仍能复现。这说明修复已存在，缺的是合并，不需要新的修复工作。

巡检对象是 main `6aa7d0b5b` 构建产物（`dist/app/app/src/cli.js` + `dist/app/ui/`）经真实入口提供的页面。未修改任何产品源码、测试或 `.appsdk`；未新建 worktree。

## 入口与资源

- 真实入口：`node dist/app/app/src/cli.js serve --mode rcc --protocol responses --provider rcc --model gpt-5.5 --rcc-base-url http://127.0.0.1:4444 --binding ui-qa-190847 --workspace <ws> --control-root <ctl> --port 0`。
- 服务返回 URL `http://127.0.0.1:60605`，`uiRoot` 为 `/Volumes/extension/code/humanagent/dist/app/ui`，`composition.complete` 为 true，三阶段 `cordis-host` / `serve-runtime` / `ui-runtime` 就绪。
- 外部 Provider：真实 RCC 4444，`/health` 返回 `{"status":"ok","build_version":"0.90.4940","server_id":"routecodex_v3_4444"}`。
- 独占 control root 与 workspace 均为本次临时目录，巡检后已删除。
- 浏览器：Playwright chromium 无头，视口 1280x720 与 390x844。9 个页面 × 2 视口，加 14 项交互断言。

## 已通过的行为

- 导航四条链全部可达并正确切换：Dashboard、Task List、新建 Task、Memory。逐条点击后 URL 与正文均更新，无死链。
- 键盘焦点环：连续 Tab 探测 8 个可聚焦元素，8/8 显示可见焦点指示。
- 空表单提交：`提交任务` 按钮保持可用，提交后给出中文反馈，不静默失败。
- 显示设置抽屉：桌面为右侧 500x688 展开，手机为底部 390x658 抽屉，Escape 均可关闭。抽屉文案说明「调整显示只改变这一层怎么展开，不会停止、重试或改变任何任务」，符合只读要求。
- 真实提交链路 HTTP 通路正确且零控制台错误：`POST /api/explicit/inputs` → `GET /api/explicit/interactions/<id>` → `POST .../interpret` → SSE `GET .../events`。事件流按序输出 `explicit.step`（`request.dispatching` → `request.dispatched` → `response.reasoning`）。
- 两档视口全部 9 个页面均无横向溢出（`scrollWidth <= innerWidth + 2`）。
- `GET /api/runtime/status` 返回 `state: ready`、`connected: true`、`providerState: ready`，`mode: rcc`。

## P1-a board 首屏裸露交互状态机枚举

现象：dashboard 首屏的 `product-board-item-state` 直接渲染 `awaiting-confirmation`、`matching`、`answered`。移动端因标题与状态同处一行内联展示，读作 `只回复一个字：好matching`。

实测：`rawUnique` 为 `["awaiting-confirmation","matching","answered"]`，共 4 处。

根因链路：

- 服务端 `packages/app/src/ui-runtime/product-session-read.ts:419` 在 `interactionItem()` 中写 `displayState: fact.state`，直接把 `ProductInteractionFact.state` 原始枚举交给展示字段。
- 客户端 `docs/ui/product-board-view.js:64` 原样渲染 `item.displayState`。

这不是缺少设计，而是调用方绕过了既有函数：`docs/ui/interaction-card-page.js:88` 已有 `interactionStateLabel()`，映射 `received→已收到`、`matching→正在处理`、`awaiting-confirmation→等待确认`、`answered→已回答` 等，其上方注释明确写着原始枚举不得到达卡片。card 页在第 355、430 行正确调用。

同文件对照：`product-session-read.ts:375` 的任务行使用已本地化的 `fact.row.stateLabel`，interaction 条目是唯一漏改项。

契约不阻碍修复：`packages/contracts/src/product-read.ts:101` 将 `displayState` 定义为展示字符串，`packages/ui/contracts/runtime.ts:89` 已有 `stateLabel` 契约。

建议：在投影层为 interaction 条目输出人类可读标签，复用或提取 `interactionStateLabel()` 的映射，避免两份中文表各自漂移。

## P1-b board 失败信息英文原样暴露

现象：dashboard 底部常驻「读取失败」，其下依次渲染 `memory.session-source-unavailable · humanagent.app.ui-runtime.product`、英文说明 `no declared memory-agent session reader exists; memory review candidates are not sessions`、英文下一步 `bind a real memory session reader before enumerating the memory board`。

另一入口同样暴露：memory 页把同一段英文展示为「session 来源不可用」下的正文。

根因链路：

- `packages/app/src/ui-runtime/product-session-read.ts:664` 的 `failure('memory.session-source-unavailable', <英文说明>, <英文下一步>)`。
- 客户端 `docs/ui/product-board-view.js:95-101` 把 `failure.code`、`failure.message`、`failure.nextAction` 三者全部渲染到页面主层；第 122 行硬编码中文标题「读取失败」。

偏离项目要求「受影响主层显示人类可读语义，技术字段按需进入详情」。

建议：主层给中文说明与可操作下一步，`code`、`ownerId` 与英文原文收进技术详情。`failure()` 为所有 board 失败共用，宜在渲染层映射而非改 facade。

## P2-a 移动端悬浮按钮压住输入框（既有 bug 28c9738 的重复观察）

实测坐标（390x844）：`显示设置` 位于 (10,790) 尺寸 70x44，`输入设置` 位于 (310,790) 尺寸 70x44，文本输入框位于 (35,818) 尺寸 320x112。两个按钮与输入框的判定均为 `overlapsTextarea: true`，即存在矩形重叠。输入框首行可被按钮覆盖，用户点击可能误触发按钮。

桌面端同样漂移：两按钮悬浮在页面边缘中部，不随内容流定位。

本项与开放 bug `28c9738`（P1: corner floating buttons occlude content）为同一问题，不重复登记。main 的 `docs/ui/runtime.css:717` 仍为 `padding: 72px 0 88px`；候选 `5c74d0d47` 已改为 `padding: 72px 72px 88px`，但未合并。该 bug 第二条评论记录 master 在 P0 候选 `7c8cb154c` 上复核仍见重叠，与本次实测一致。

建议：合并候选 `5c74d0d47` 中的角落安全内边改动，不需要新的修复工作。桌面端按钮不随内容流定位的问题若未被该候选覆盖，需另行确认。

## P2-b interaction 静默停在 matching 且无恢复入口（既有 bug 6a11c8d 的重复观察）

实测：`interaction-2` 提交后停在 `state: matching`、`owner: explicit-intake`、`nextAction: inspect-candidates`，`history` 为 `['received','matching']`。

无法推进：`POST /api/explicit/interactions/interaction-2/matching` 返回 409，`{"code":"ExplicitIntakeError","ownerId":"explicit-intake","message":"begin matching: cannot begin matching from matching","nextAction":"inspect-interaction-state"}`。

恢复路径存在但 UI 不自动使用：对另一条 interaction 重新 `POST .../interpret` 后其状态成功推进到 `awaiting-confirmation`。`docs/ui/explicit-interaction-flow.js:6` 的 `advanceExplicitInteraction()` 只在 `received` 与 `matching` 两态调用 interpret，失败后没有重试循环。

期间观测到 `POST .../interpret` 返回 500（浏览器 `response` 事件捕获 `status 500`），与该次提交失败对应。

5 次真实提交中 1 次确认卡死。另一次提交 UI 显示「输入已接收，本次处理未完成」并出现「重试本次提交」按钮，说明部分失败路径有恢复入口，但卡死路径没有。

本项与开放 bug `6a11c8d`（P1: default explicit intake returns multiple decisions and interpret 500）为同一根因，不重复登记。该 bug 的验收条件为「default-model real RCC local-file-search creates the task and reaches execution without HTTP 500」，与本次观测到的 500 及后续卡死一致。

本次新增的可复现细节，可作为该 bug 的补充证据：卡死并非仅 500 本身，interpret 失败后 interaction 会停在 `matching` 且无自动恢复；`POST .../matching` 返回 409 `cannot begin matching from matching`；对另一条 interaction 重新 interpret 可成功推进，说明恢复通道存在但 UI 不使用。UI 侧 `docs/ui/explicit-interaction-flow.js:6` 只在 `received` 与 `matching` 两态调用 interpret，无重试循环。

建议：按该 bug 原有验收条件修复 interpret 收敛；同时补 UI 侧失败重试，避免任务静默停在中间态。

## 测试覆盖缺口

`tests/ui/dashboard-product-consumer.test.mjs:112`、`124` 与 `tests/ui/product-board-location-consumer.test.mjs` 等用例只断言 `displayState` 等于 `'running'`、`'recorded'`、`'unknown'` 这类内部值，没有断言面向用户的文案形态，因此 P1-a 的状态枚举泄露不会被现有测试抓到。

建议补一条断言：board 投影中 interaction 条目的 `displayState` 不得等于 `ProductInteractionFact.state` 的原始枚举串。

## 更正记录

- `GET /api/explicit/interactions/<id>/events` 单次读取 20 秒未返回，曾初判为挂起。复核确认它是 SSE 长连接，正常持续输出 `explicit.step`，非缺陷，撤回该判断。
- `login.html` 截图与 `dashboard.html` 完全一致，因 serve 在已配对浏览器会话下将登录页重定向至 dashboard，属设计行为，非渲染错误。
- 初稿称「5 次提交中 2 次命中卡死」，核对后不成立：`interaction-4` 只是观察时刻处于 `matching`，其后自行推进；确认卡死仅 `interaction-2` 一条。

## 资源收口

自有 serve PID 40100 已退出，端口 60605 已释放，无残留进程。本次临时 control root、workspace、探针脚本与 serve 日志已删除。证据保留于本目录 `docs/evidence/dashboard-ui-interaction-sweep-20261102/`：`scan-report.json`、`interaction-report.json` 及 6 张截图（`dashboard-raw-states.png`、`mobile-dashboard-raw-states.png`、`mobile-index.html.png`、`drawer-display-settings.png`、`mobile-drawer.png`、`memory-detail.png`）。

未触发产品修复：上述修改涉及 `packages/app` 与 `docs/ui`，超出本次巡检授权范围。其他 worktree 与其他 agent 在 main 的未提交改动均未触碰。
