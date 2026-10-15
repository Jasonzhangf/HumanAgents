# HumanAgent 项目状态汇总（2026-10-15）

## UX 最新可用行为与未完成项（2026-10-15）

- checkpoint 查询与实际浏览器已组合到候选 `276d57ed`。生产 dispatcher、真实认证、Journal 和实际前端证明 current/viewed 独立、筛空保留、刷新/前进/后退、桌面侧栏、手机底抽屉、语义/Context/恢复描述及引用返回。正常 App build0，原 HTTP consumer1/1；浏览前后六个持久化文件、完整执行位置不变，effects0。证据：`/private/tmp/humanagent-ux-remaining-20261015/checkpoint-compose-c6-r2/parent-receive.md`。这不证明真实 RCC 输入执行、正式 daemon 或完整 G14。
- **F13 仍有已复现的生产缺口。** 活动子进程42804在真实本地 HTTP 请求及非空 dispatching 义务下被 SIGKILL；确认死亡后，新进程43040读到同一 Task/turn/checkpoint/Context，原 effect 的一次 intent、一次 completion 和字节不变。公共 `resumeExecution` 在 `cold-execution-source.ts` 读取活动 tail 的 capture receipt 时返回 `cold-execution.source-unavailable`，没有建立后续执行实例。旧 v1 返回向 v2 的实际重投已拒绝；被杀 v2 到后续 v3 的 fencing 尚未验证。原正常退出 cold2/2 不能代替该缺口。
- 崩溃探针的原始 RED、生命周期和 source 补丁保留在 `/private/tmp/humanagent-ux-remaining-20261015/cold-crash-c8-r2`；两个子进程和自有 listener 已关闭，含未决义务的专属 fixture 保留。探针还把“控制状态和请求数不推进”无条件用于未来成功恢复，这与恢复需要新 epoch 相冲突，因此未加入正式回归集。其临时源码和 helper 改动已撤出；必要的恢复验收没有取消，须在正确恢复合同确定后补齐。
- **G14 资产正文未接通。** 完整 RawAsset 已到达 UI 回调，但 TaskDashboard 的引用层只展示 evidenceId/view.kind，未使用已有 scope/digest 校验的 RawContentReadPort；现有 tool-output 路由不是 checkpoint capture 的读取入口。需要正确的任务内公共读取边，不能把文件 locator 直接变成 URL。只读源链记录：`/private/tmp/humanagent-ux-remaining-20261015/checkpoint-asset-read-observe-r1/observation.md`。
- 显式交互尚无 Task 时，页面伪造 task/operation 身份的合成反例已执行；该显示缺陷仍未修复。C4 Runtime/Journal 基础有冻结来源 `faa6a131`，完整 Context 排除挂载、C7 可信确认/公共控制入口和上述恢复缺口仍未交付。未取得本增量整体 Review PASS，未 merge main、restart 或 push。

- **当前阶段**：`MVP-IMPLEMENTATION`（`I1–I5` / `G1–G14` / `F01–F20` 纵切片合流收口中，状态 `ACTIVE / INCOMPLETE`）。
- **权威需求与进度入口**：
  - 用户需求真源：[`.appsdk/requirements.json`](.appsdk/requirements.json)（`version: 14`，共 10 条核心需求）。
  - 长期执行计划：[整体执行计划](docs/goals/ux-interaction-long-horizon-plan-2026-10-11.md)、[Provider 缺口计划](docs/goals/native-provider-gap-plan-2026-10-11.md)。
  - 进度汇总：[Native Reasoning & UX 进度摘要](docs/goals/native-reasoning-progress-2026-10-08.md)（历史完整流水账已归档至 `/Volumes/Intel/playground/humanagent/.worker-runs/archived-progress-logs-20261015/`）。

## 1. Worktree SESE 治理与存量核销回执（2026-10-15）

- **全局 SESE 规则已生效**：新建或续派 worktree 严格执行「先关旧树再开新树（Close-Before-Open）」，多子任务合流统一通过标准 Git 分支合并，禁止跨树文件级手工拼装。
- **存量清理结果**：
  - 清理前：`git worktree list` **798 个**，`/Volumes/Intel/playground/humanagent` **1,081 个**条目，仓库内 `playground/` **7 个**旧目录。
  - 本轮核销：共归档并移除 **791 个**非活动工作树（438 个 clean 树 + 281 个历史未提交树快照归档至 `refs/archive/wt-dirty/*` + 72 个已完成 `20261014/15` 候选树直接提交至各自 `codex/<name>` 分支后移除），并移出 290 个未注册孤儿条目与仓库内 `playground/` 目录。
  - 当前保留：仅 **6 个**注册工作树（主树 `main` + 5 个当前有活动进程占用的 `PROTECTED_HOLD` 工作树：`provider-context-correction-r1-20261015`、`provider-native-public-composition-r1-20261014`、`provider-production-task-identity-r1-20261014`、`provider-ux-served-composition-r1-20261014`、`runtime-reload-r1-20261015`）。

## 2. 当前候选分支与待交付切片

- **主干与候选基线**：
  - `origin/main` (`db915e7a`)：含 `task-flow` 与 `task-plan-revision` 契约/Core/JSONL 实现。
  - 后端集成基线：`codex/provider-d-backend-compose-r1-20261014` (`8d2946a1`) 及全部分支化固化后的 `20261014/15` 模块提交。
  - 前端集成基线：`codex/ux-frontend-agent-glue-20261015` (`53abe04b`) 及 `codex/ux-frontend-composition-20261015` (`5d258ac0`)。
- **下一步动作**：
  1. 在唯一集成候选工作树合流后端与前端候选分支，跑通 `pnpm dagpipe:validate`、`pnpm typecheck`、`pnpm build:app` 与受影响聚焦测试。
  2. 完成垂直切片 1（`M0 + M1 + M2`：真实 RCC 4444 + Ego14 浏览器首屏/新建任务/Checkpoint 验收）与 1 次独立 Milestone Review 后合入 `main`。
  3. 推进垂直切片 2（`M3 + M4 + M5`：子 Agent 动态调用与审查闭环 + 偏好/响应式抽屉验收）。
