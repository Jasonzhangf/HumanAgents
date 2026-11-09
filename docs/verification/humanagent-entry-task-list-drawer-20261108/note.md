# Entry Task-List Drawer — Task Note

- Task id: `humanagent-entry-task-list-drawer-20261108`
- Parent task: `humanagent-mvp-delivery-20261106`
- Canonical requirements: `/Volumes/extension/code/humanagent/.appsdk/requirements.json`, version 35.
- Requirement id: `humanagent-entry-task-list-in-drawer` ("入口页的任务列表可放在抽屉中，可以隐藏").
- Contract: `docs/goals/humanagent-entry-task-list-drawer-20261108.md`; copied from
  `/Volumes/extension/code/humanagent/docs/goals/humanagent-entry-task-list-drawer-20261108.md`.

## 长期目标

入口页的任务列表不占用入口主区、不与 Task List 页重复；用户需要时通过抽屉
打开任务列表，不需要时不显示完整列表。生产冷启动路径不受影响。

## 本轮目的

把入口页内联的任务列表移入可开合抽屉，保留既有入口导航与提交路径，并用真实
浏览器入口路径取证。

## 受影响的 DAG 与检查

- 入口提交链路：`docs/dagpipe/explicit-requirement.graph.json` 的
  `stay_on_single_entry_surface` 节点。单次提交仍停在入口表层，本变更未改图。
- 任务列表读取/呈现：`docs/dagpipe/human-readable-ux-reading.graph.json` 的
  `present` 阶段。列表仍显示真实 title/状态/时间与精确 taskId 链接，未隐藏
  真实失败/unknown/恢复责任；本变更属呈现层重排，未改图拓扑。
- `node scripts/dagpipe-validate-graphs.mjs` 通过（31 张图全部 valid）。

## 改动

- `docs/ui/entry.js`
  - `renderStatus` 只保留紧凑摘要（队列位次、任务数量）与一个「任务列表」触发器；
    不再在主区内联渲染完整列表。
  - 新增 `taskListEntries` / `openTaskListDrawer`，复用既有共享 shell-layer
    抽屉（`openTechnicalDetail`，桌面侧栏 / 移动底部抽屉），行渲染沿用既有
    `task-row-link`（title、状态、时间、精确 taskId 链接、执行记录）。
- `docs/ui/runtime.css`
  - 抽屉内任务行改为单列堆叠、行内容顶端对齐、状态 chip 自适应宽度，避免窄抽屉
    内标题被挤压。
- `tests/ui/entry-flow-browser.mjs`
  - 提交后断言从主区内联行改为「打开抽屉后读取行」；行为变化的对应更新。
- `tests/ui/entry-task-list-drawer-browser.mjs`（新增）
  - 抽屉行为红测与真实浏览器验收。

## 红测（改动前）

`ENTRY_DRAWER_UI_ROOT=<canonical>/docs/ui node tests/ui/entry-task-list-drawer-browser.mjs`
在未改动 UI 上失败 1/5：主区仍内联 2 行任务、无触发器。证明该测试能抓到缺失的抽屉。

## 真实前端浏览器验收（改动后）

被测 UI：本 worktree 的 `docs/ui`。测试脚本在同一进程启动一个本地静态服务器，监听
系统分配的空闲端口，静态服务该目录，并把 `/api/*` 代理到真实 runtime
`http://127.0.0.1:10086`。浏览器不再拦截或伪造 `/api/tasks`。

```
cd <worktree>
ENTRY_DRAWER_UI_ROOT="$PWD/docs/ui" \
ENTRY_DRAWER_EVIDENCE="$PWD/docs/verification/humanagent-entry-task-list-drawer-20261108" \
ENTRY_DRAWER_RUNTIME="http://127.0.0.1:10086" \
node tests/ui/entry-task-list-drawer-browser.mjs
```

- 本轮实际入口 URL：`http://127.0.0.1:56869/index.html`（空闲端口每次动态分配，
  实际值同时记录在 `checks.json` 的 `evidence.entryUrl`）。
- 真实 `/api/tasks` 观察：HTTP 200，`mode=rcc`，7 项任务；task IDs 为
  `scheduled-task-b258bd97ecc762223c7a`、`ui-task-implicit-draft-172`、
  `ui-task-implicit-draft-246`、`ui-task-implicit-draft-253`、
  `ui-task-implicit-draft-248`、`ui-task-implicit-draft-251`、
  `ui-task-implicit-draft-257`。原始响应保留在 `real-api-tasks.json`。
- 结果：39/39 通过（desktop 1440x1000 与 mobile 390x844 各一轮）。
- 覆盖：主区无内联列表；存在 aria-haspopup=dialog 的「任务列表」触发器；点击打开
  抽屉后，浏览器断言直接从上述真实 `/api/tasks` 响应生成，逐项核对 taskId、状态和
  semantic title；抽屉无横向溢出；关闭/再次打开/Esc 关闭；关闭后入口表单仍可用且
  未跳转；无页面错误。
- 关闭后的表单路径：提交纯空白输入，页面显示「请先填写任务输入。」，HTTP 调用中没有
  POST/PUT/PATCH/DELETE，证明没有触达任务创建或修改。
- 复现证据：`checks.json`、`real-api-tasks.json` 与
  `entry-task-list-drawer-open-{desktop-1440,mobile-390}.png`、
  `entry-task-list-drawer-closed-{desktop-1440,mobile-390}.png`、
  `entry-task-list-drawer-form-validation-{desktop-1440,mobile-390}.png`。

既有证明回归（同一被测 UI）：

- `T22C_SKIP_RCC=1 T22C_UI_ROOT="$PWD/dist/app/ui" node tests/ui/entry-flow-browser.mjs` → 62/62。
- `T22C_UI_ROOT="$PWD/dist/app/ui" node tests/ui/new-task-landing-dashboard-browser.mjs` → failures: 0。
- `node --test tests/ui/entry-product-consumer.test.mjs` → 11/11。

## 未校验 / 剩余缺口

- 契约文字提到任务行含 "task id, status, priority, owner"。现有任务源
  `/api/tasks`（`RuntimeTaskRowProjection`）不携带 priority/owner 字段；为不改
  第二份任务数据，抽屉只呈现源实际携带的 taskId 链接、状态、语义 title、时间与
  任务类型。priority/owner 需先由领域/投影 owner 提供，才能如实展示。
- 角色/巡检收口与最终独立 Review 未执行（本任务不合并、不推送、不关闭）。
