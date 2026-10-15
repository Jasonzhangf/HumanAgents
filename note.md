# HumanAgent 项目状态汇总（2026-10-15）

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
