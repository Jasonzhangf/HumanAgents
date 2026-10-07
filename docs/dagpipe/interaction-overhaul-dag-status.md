# HumanAgent 交互改造 — DAG 现状与目标状态（`25d656c` 时点快照）

本文件是 `25d656c`（worktree `interaction-ui-finalize-20261006`）时点的**历史快照**，不是当前图清单。
下文所有「现状」均指该时点。当前图集合与合法性以 `pnpm dagpipe:validate` 的输出为唯一真源，
本文件不再复述图数量：写作时为 12 张，`793b5b9` 时已为 16 张。

证据根：`docs/dagpipe/`
候选 SHA：`25d656c`（worktree `interaction-ui-finalize-20261006`）

---

## 1. 图的现状（12 张，均合法）

| 图 | 版本 | 节点 | 入口 ARC | 覆盖的交接目标 |
|---|---|---|---|---|
| `explicit-requirement` | v2 | 9 | `user_task_input` | F01 草稿生成、F03 修改/重新整理/放弃、F04 单次/定时/周期编译 |
| `serve-task` | v3 | 14 | `persisted_execution_plan` | F04 准入/执行/收拢、F02 轨迹、校验绑定 |
| `scheduled-occurrence` | v1 | 9 | `due_occurrence` | F04 定时/周期触发与 occurrence 收拢 |
| `subscription-control` | v1 | 5 | `subscription_control_request` | F04 计划的暂停/恢复/取消 |
| `observation-read` | v2 | 7 | `browser_request` | F02 对话 + 轨迹 + 调用/返回关联 |
| `dashboard-e2e-{web-search,local-file-search,aitest}` | v1 | 11–16 | `candidate_revision` | 验收门禁绑定 |
| `ci-checkpoint` / `hand-search-websearch` / `headless-session` / `memory-curation` | v1 | 4–14 | — | 既有能力，与本轮无关 |

**关键事实：semantic labels 只覆盖 8 张图，且没有一张图覆盖 F01–F05 的「卡片呈现层」。**
`observation-read` 覆盖到 `project_status_and_actions` → `browser_view`，但它的
status 是**观测节点状态**，不是任务实时性。

---

## 2. 缺口（缺口 1 是本轮唯一阻断项）

### 缺口 1：无图覆盖「任务实时性事实 → 工作卡片」这条边【阻断】

F01 要求卡片区分「失败 / 断线 / 无进展 / 待回答」，不用假进度。
后端已交付（`6b151ef`）：

- `service.ts:762` `runtimeLivenessInput()` — 从真实信号推导，`record.updatedAt`
  被显式排除（否则浏览器刷新会重置真实的静默计时）。
- `contracts/runtime.ts:221` `RuntimeLivenessInput` + `:242`
  `RuntimeLivenessState = working | no-activity | waiting-for-answer | failed | idle | unknown`
- `contracts/runtime.ts:216` 契约注释明确写了：**事件传输事实故意不放在 liveness 里**，
  因为「唯一能读到传输丢失的观察者就是持有那条流的页面」。传输事实走卡片自己的
  `transport` 字段。

但 `docs/ui` 里 `liveness` 出现 **0 次**：

| 位置 | 现状 |
|---|---|
| `docs/ui/interaction-card-page.js:95` `projectInteractionCard` | 无 `liveness` 入参，`cardMetadata` 无该字段 |
| `docs/ui/task.js:391` `load()` | 一次性 `api.taskDetail()`，**无轮询、无 EventSource** |
| `docs/ui/interaction-work-card.js:926` | 已渲染 `metadata.transport?.connected`，但无人填充 |
| `docs/ui/task-dashboard.js` | 已渲染 `dashboard.plan`，但**不渲染 liveness** |
| `docs/ui/interaction-work-card.js:904` | 渲染 `已收拢` 的分支存在，但 `taskState === undefined` 时走不到 |

结论：后端契约、投影、渲染分支都在，缺的是一条**页面侧数据源边**——
卡片不知道自己在运行，所以永远不会显示「工作中 / 无活动」。

佐证：`tests/ui/interaction-liveness-browser.mjs` 4 个场景全部失败，
`timed out after 60000 ms waiting for the card to report working; last=null`。
该 harness **不在任何 gate script 里**（`package.json` 无引用），且自带一个从未被发现
的 launch bug（见缺口 2）——所以它从未跑过，从未失败过。

### 缺口 2：liveness harness 从未被执行过【已修】

`tests/ui/interaction-liveness-browser.mjs:438` 把 `playwright.chromium`
（BrowserType）传给 `runScenario`，而 `openPage` 需要 `browser.newContext()`
（Browser）。正确写法是 `await playwright.chromium.launch()`。
已修：每场景 launch 一次，`finally` 里 close（原写法还会泄漏浏览器进程）。
修复后 harness 才第一次真正运行，暴露了缺口 1。

### 缺口 3：plan-less 断言的真实运行时版本是伪需求【已处理】

`25d656c` 已把「真实运行时 plan-less 任务不渲染计划区」删掉。
理由：该断言需要一个**没有计划的任务**，而真实环境里只有两种来源——
等 Provider 执行完一次 occurrence（把计划控制证明绑到 Provider 延迟），
或者依赖一个「确认过需求但 dispatch ledger 没写」的可疑链路。
确定性 section A 已经用同一契约覆盖了，所以留在 A 里。

### 缺口 4：交付收口 DAG 未完成【阻断 release】

`dagpipe-runtime` 要求的单源单汇：
`代码完成 → 交付生成物 → runtime 重建/重启 → worktree 回收 → playground 清理 → tmp 移除`

| 终点 | 状态 |
|---|---|
| `origin/main` | `22d8268`，**整个集成分支未合并**（约 130 个提交，含 durable-consumer 线 `b257c05`→`4214262`→`5d17031`） |
| 独立架构 review PASS | 未做 |
| `review:record` / release build | 未做 |
| 安装 / 重启（本机 `0.1.0014` → `0.1.15`） | 未做 |
| worktree / playground / tmp 回收 | 未做 |

### 缺口 5：RCC 模型侧不可用（环境，非代码）

`goaichat.glm-5.3` 对 `/v1/responses` 返回空响应（curl rc=52）且**立即失败**
（t≈0.002s），而 `/health` 与 `/v1/models` 正常。换 `gpt-5.5` 在**同一条**
`rcc/plan-control` 路由上 1.9s 返回 200。变量是模型，不是路由，也不是 load。
已把 plan-control proof 默认模型从 `goaichat.glm-5.3` 改为 `gpt-5.5`，
与已合并的 RCC scheduler acceptance 默认值一致。

---

## 3. 目标状态

### 3.1 新增一张图：`task-liveness-display`（单源单汇）

这是 F01/F05 缺的唯一一条边。建议节点：

```
真实运行任务快照 (source: task_runtime_snapshot)
  → 从真实信号推导实时性     [RuntimeLivenessInput，排除 updatedAt]
  → 卡片读取实时性与传输状态  [poll /api/tasks/{id}/dashboard 或 SSE]
  → 渲染顶部状态栏           [工作中 / 无活动 / 待回答 / 已失败 / 已收拢]
  → 渲染传输事实（页面本地）  [已连接 / 实时连接已断开；服务端不下发]
  → 卡片呈现真实事实，不显示假进度   (terminal: rendered_liveness_truth)
```

设计要点（来自已交付契约，不可改）：

1. `silentForMs` 来自 `observedAt - lastActivityAt` 与 `silenceBudgetMs` 的对比；
   UI 不自建计时器，`silenceBudgetMs` 只用于显示。
2. `active` 取自 lifecycle state（`running` 或 `settling`），不是内部 running flag。
   「lifecycle 仍说 running 但很久没活动」正是必须暴露的卡死场景。
3. 传输事实**只能**页面本地持有。服务端值在断线时取不到。
4. settled-stream 规则：执行终态时服务端主动关流，这次预期关闭不得渲染成
   「实时连接已断开」（`7b51080` 已加了红绿断言，但只在未运行的 harness 里）。
5. `lastActivityAt` 的来源优先级：runtime 记录的最新事件时间 > provider 请求身份时间；
   `record.updatedAt` 永不作为来源。

### 3.2 需要补的两个文件（唯一 owner）

| 文件 | 改动 |
|---|---|
| `docs/ui/interaction-card-page.js` | `projectInteractionCard` 接受并传递 `liveness`；`cardMetadata` 增加 `liveness` |
| `docs/ui/task-dashboard.js` | 读取 `dashboard.liveness` 并透传给 work card；增加轮询 |

`docs/ui/task.js` 是第二入口（`task.html`）。它用 `projectInteractionCardFromSnapshot`
走的是**显式交互快照**，没有 provider turn，按 `interaction-card-page.js:133` 注释
应当显式报「无 turn/trace」——这条不改。真实任务卡片的 liveness 走
`task-dashboard.js`。

### 3.3 验收证据（按 F01–F05）

| 目标 | 验收证据 | 现状 |
|---|---|---|
| F01 草稿真实可见 | `dashboard-e2e` 已绿；plan-control 18/18 确定性 | 通过 |
| F02 统一工作卡片 | `observation-read` v2 + drawer proof | 通过 |
| F03 修改/重新整理/放弃闭环 | `a01ea98`、`859e885` + 45/45 真实合成运行时 | 通过 |
| F04 单次/定时/周期贯穿 | plan-control **28/28**（真实 claim、active→suspended→active→cancelled、schedule rev 1→2→3→4） | 通过（本轮达成） |
| F05 状态/同步一致 | **liveness harness 4/4 场景失败** | **未通过** |
| LAN/Tailscale 监听 | `6902a26` 已合入集成分支 | 待 release |
| 校验消融 | `validation-ablation` 系列已合入 | 通过 |

### 3.4 合并顺序（目标）

```
22d8268 (origin/main)
  └─ integration 6487192 + 25d656c (plan-control 真实证明)
       └─ [新增] task-liveness-display 图 + docs/ui liveness 接线 + harness 修复
            → 4 个 liveness 场景全绿 + 受影响 test:ui / test:app 重跑
            → 独立架构 review PASS（全部证据绑定该 SHA）
            → review:record + release build 0.1.15
            → 安装 + 重启 + health 证明新 binary
            → merge → push origin/main
            → worktree / playground / tmp 回收，逐条留证据
```

---

## 4. 下一步执行顺序

1. **写 `task-liveness-display` 图**（graph.json + semantic.json + binding.json），
   `dagpipe graph validate` 必须通过。**先修图再改码**——skill 明确要求。
2. 改 `docs/ui/interaction-card-page.js` + `docs/ui/task-dashboard.js` 接线。
3. 跑 `tests/ui/interaction-liveness-browser.mjs`，4 个场景全绿。
4. 把 liveness harness 接进 `proof:*` script（当前完全没被 gate 引用）。
5. 跑 `test:ui` / `test:app` / `typecheck` / `dagpipe:validate` / `git diff --check`。
6. 独立架构 review PASS → `review:record` → release build → 安装/重启/health。
7. merge → push → 回收 worktree、playground、tmp，逐条留证据。

---

## 5. 已完成的本轮进展（供交接核对）

- `25d656c` plan-control 真实证明修复，**28/28 通过，exit 0**。
  真实证据：独立 `serve --mode rcc`、真实配对、真实 occurrence 被 claim、
  真实持久化 `active → suspended → active → cancelled`（schedule revision
  `1 → 2 → 3 → 4`）在页面与 runtime 两侧同时观测到，零 page error。
  两张真实截图：`plan-control-real.png`、`plan-control-deterministic.png`。
- liveness harness launch bug 已修（`browser.newContext is not a function`）。
- `pnpm test:ui` 55/55 绿。
- 根因：plan-control 证明原先走浏览器 entry form，其首次提交会调真实 Provider
  `/interpret`，把 180s 超时变成「Provider 尾延迟的测量」而非「plan-control 契约」。
  改为走公共 explicit-flow 路由（`/matching` → `/match` → `/proposal` →
  `/confirmation`），与已合并的 RCC scheduler acceptance 同一入口。
