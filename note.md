# HumanAgent 项目状态汇总（2026-10-15）

## UX 最新可用行为与未完成项（2026-10-15）

- checkpoint 查询与实际浏览器已组合到候选 `276d57ed`。生产 dispatcher、真实认证、Journal 和实际前端证明 current/viewed 独立、筛空保留、刷新/前进/后退、桌面侧栏、手机底抽屉、语义/Context/恢复描述及引用返回。正常 App build0，原 HTTP consumer1/1；浏览前后六个持久化文件、完整执行位置不变，effects0。证据：`/private/tmp/humanagent-ux-remaining-20261015/checkpoint-compose-c6-r2/parent-receive.md`。这不证明真实 RCC 输入执行、正式 daemon 或完整 G14。
- **F13 仍有已复现的生产缺口。** 活动子进程42804在真实本地 HTTP 请求及非空 dispatching 义务下被 SIGKILL；确认死亡后，新进程43040读到同一 Task/turn/checkpoint/Context，原 effect 的一次 intent、一次 completion 和字节不变。公共 `resumeExecution` 在 `cold-execution-source.ts` 读取活动 tail 的 capture receipt 时返回 `cold-execution.source-unavailable`，没有建立后续执行实例。旧 v1 返回向 v2 的实际重投已拒绝；被杀 v2 到后续 v3 的 fencing 尚未验证。原正常退出 cold2/2 不能代替该缺口。
- 崩溃探针的原始 RED、生命周期和 source 补丁保留在 `/private/tmp/humanagent-ux-remaining-20261015/cold-crash-c8-r2`；两个子进程和自有 listener 已关闭，含未决义务的专属 fixture 保留。探针还把“控制状态和请求数不推进”无条件用于未来成功恢复，这与恢复需要新 epoch 相冲突，因此未加入正式回归集。其临时源码和 helper 改动已撤出；必要的恢复验收没有取消，须在正确恢复合同确定后补齐。
- **G14 资产正文未接通。** 完整 RawAsset 已到达 UI 回调，但 TaskDashboard 的引用层只展示 evidenceId/view.kind，未使用已有 scope/digest 校验的 RawContentReadPort；现有 tool-output 路由不是 checkpoint capture 的读取入口。需要正确的任务内公共读取边，不能把文件 locator 直接变成 URL。只读源链记录：`/private/tmp/humanagent-ux-remaining-20261015/checkpoint-asset-read-observe-r1/observation.md`。
- 显式交互的伪造 Task/Operation 身份及确认后提前显示 running 已修复并进入唯一候选：来源 `676f78d` → `0875478c`，11 个路径与来源一致，卡片浏览器 39 项、Task 页面 4 项作者验收通过。来源工作树已正常关闭，证据归档 `/Volumes/Intel/playground/humanagent/.worker-runs/ux-card-identity-20261015/`。原 8 个旧 UI 失败及默认 page 旧 selector 失败仍开放，由 UX peer 继续最小审计/消融。C4/C7 后续 Context、公共控制和崩溃恢复仍未完整交付；整体 I1 Review/main/restart/push 未完成，不用该内部切片代替整体验收。
- C4 冻结八文件已通过标准 Git 合流为 `d1c1d2b0`，保留 C3 语义只读工厂。当前组合的正常 App build0、原 C4 focused compile0、原 C4 公共 consumer1/1、原 checkpoint HTTP consumer1/1 均通过。只证明已挂基础与读边的组合，不能替代尚未接线的后续 Context、HTTP 控制和崩溃恢复。证据：`/private/tmp/humanagent-ux-remaining-20261015/c4-composition-r1/receipt.md`。

- **当前阶段**：`MVP-IMPLEMENTATION`（`I1–I5` / `G1–G14` / `F01–F20` 纵切片合流收口中，状态 `ACTIVE / INCOMPLETE`）。
- **权威需求与进度入口**：
  - 用户需求真源：[`.appsdk/requirements.json`](.appsdk/requirements.json)（`version: 14`，共 10 条核心需求）。
  - 长期执行计划：[整体执行计划](docs/goals/ux-interaction-long-horizon-plan-2026-10-11.md)、[Provider 缺口计划](docs/goals/native-provider-gap-plan-2026-10-11.md)。
  - 进度汇总：[Native Reasoning & UX 进度摘要](docs/goals/native-reasoning-progress-2026-10-08.md)（历史完整流水账已归档至 `/Volumes/Intel/playground/humanagent/.worker-runs/archived-progress-logs-20261015/`）。

## 1. Worktree SESE 治理与存量核销回执（2026-10-15）

本节数量和路径为清理任务结束时的历史快照，不是后续恢复与正常派发后的实时存量。当前候选及本侧资源回执以唯一进度记录为准。

- **全局 SESE 规则已生效**：新建或续派 worktree 严格执行「先关旧树再开新树（Close-Before-Open）」，多子任务合流统一通过标准 Git 分支合并，禁止跨树文件级手工拼装。
- **存量清理结果**：
  - 清理前：`git worktree list` **798 个**，`/Volumes/Intel/playground/humanagent` **1,081 个**条目，仓库内 `playground/` **7 个**旧目录。
  - 本轮核销：共归档并移除 **791 个**非活动工作树（438 个 clean 树 + 281 个历史未提交树快照归档至 `refs/archive/wt-dirty/*` + 72 个已完成 `20261014/15` 候选树直接提交至各自 `codex/<name>` 分支后移除），并移出 290 个未注册孤儿条目与仓库内 `playground/` 目录。
  - 当前保留：仅 **6 个**注册工作树（主树 `main` + 5 个当前有活动进程占用的 `PROTECTED_HOLD` 工作树：`provider-context-correction-r1-20261015`、`provider-native-public-composition-r1-20261014`、`provider-production-task-identity-r1-20261014`、`provider-ux-served-composition-r1-20261014`、`runtime-reload-r1-20261015`）。

## 2026-10-17 旧治理消融补漏

本节更新日常开发与本地安装入口；下方旧候选记录只作历史，不作为当前检查要求。

本轮续查读取了当前全局治理 Skill 与 bootstrap-migration 的消融章节、有效需求、项目 AGENTS、日常 build/CI/package/install/restart 入口及现有审查回执。当前仓库未配置 core.hooksPath，`.git/hooks` 只有未启用的 sample；没有 `.github` CI 工作流。现有三节点 CI 图与 `typecheck → build:raw → test:compiled:services` 调用一致，拓扑未变，不重复跑图校验或行为测试。

续查发现三份旧计划会重新引入治理：`human-visible-integration-plan.md`、`live-composition-closeout-plan.md` 与 `native-provider-gap-plan-2026-10-11.md`。已从正文删除输入/产物哈希、候选 SHA/tree 绑定、候选 digest 重算、identity 复用门槛、独立 reuse/rerun 账本及 AGY+Codex+Astra 多轮审查要求。Provider 旧状态明确为历史，未把旧结果升级为当前 PASS。保留三脑功能、公开入口、任务隔离、恢复、真实模型、数据正确性和一次完整 milestone review。此批只改文档，不改变程序入口，无新增测试、构建或服务重启。

- 已交付的日常 build/CI 消融继续复用。它们直接运行类型检查、编译及适用服务回归，不建立哈希检查点、冻结材料或候选身份清单。本批不重跑全仓 CI。
- 本地 package assembly 删除两次目录摘要与比较、`artifactDigest` 返回。普通 `package` 改走 `package:candidate`。本地 installer 直接选择当前版本 tgz 或显式路径，不再依赖 release manifest。保留真实文件复制、contracts、模板、UI 资产、CLI 封装和 npm 失败传播。
- restart 删除入口文件摘要计算、lease/transition 摘要必填项和交接摘要比较。保留 lease/generation/processStartToken、路径、子进程 PID、ready、request 关联、旧进程退出、错误与资源收口。原公开 restart consumer 保留任务数据断言；UX 候选测试通过正式 grant API 获权，main 使用其原有执行准入。
- 有效作者证据：真实 tgz 安装/CLI consumer 与 installer 成功失败两项通过；正常主机 supervisor 原 24 项通过，删除新增重复 codec 用例后原 23 项通过；UX 候选原公开 restart consumer 1 项通过。后续主干组合仅重跑输入实质改变的用例，不为记笔记重复检查。隔离 modern-to-modern fixture 不证明已安装旧 owner 的兼容。
- 主干组合的无摘要 lease 反例：原 main 公开 decoder 实际报 `daemon-lease-corrupt`；消融后同一输入成功，无摘要计算。主干 supervisor 23 项通过。首次主干 public consumer 在新增 grant helper 收到 404，因为 main 尚无该路由；只对主干移除这段候选专属前置，保留原 main 的执行准入，未修改产品授权。该失败不能伪报为 restart 失败或通过。
- 本批独立交付树从最新 `origin/main` 开始，只合治理消融，不合尚未完成验收的 UX、Provider 或 Memory 候选。
- SDK 受管副本仍有旧规则。外置树正常 `appsdk init .` 返回 `INIT_REQUIRES_CANONICAL_PROJECT_MAIN_TREE:.`；项目正式主树同一入口返回 `SDK_VERSION_MIGRATION_REQUIRED:0.1.0014:0.1.0015:run=appsdk pin-lock <project> --binary <path>`。未刷新，未伪报通过。按治理 Skill 停止这一受影响链；不手写 pin/lock/摘要，不执行 fresh/reset，不重启 daemon。该兼容缺口属于 AppSDK owner，受管副本未完成不能宣称整体治理消融完成。

主干组合最终结果：package 两项通过；supervisor 原 23 项通过；无摘要 lease 反例由失败转成功；正式 public restart consumer 1 项通过，真实交接/任务数据/退出和资源断言完整。GCM执行者完成重复测试删除后出现network error，owner接收并跑组合测试；适配main测试前置由已授权AGY Flash后备完成。只读观察者同样断流，没有完整报告，不算已完成独立审计。

正式交付结果：本批 11 文件消融经独立 Gemini 4 medium 整体审查，controller 裁决 PASS，无 P0/P1；一处 README 旧 checkpoint 描述 P2 已删除，文档针对性核对。已正常集成 main，未合其他 UX/Memory 候选。main contracts 源码编译和 App 构建成功，普通 `pnpm package`、`pnpm install:global` 成功，正式 `/opt/homebrew/bin/humanagent` 版本 `0.1.0031`；隔离现场通过同一个真实 public restart consumer（1/1），进程交接、任务输出和资源收口通过。原 Task/A0 未重启、重试或重新派单。

剩余缺口除上述 SDK 兼容阻塞外，main 的 `pnpm build:contracts` 会额外编译全量 contracts 测试；其既有 `tests/contracts/contracts.test.ts:836,1074` 使用旧 `executionEpoch`，实际 TS2561 失败。该文件未被本批修改，未伪报通过、放宽断言或扩改 fixture；contracts 源码编译与本批适用行为验收已通过。

详细原始日志复用 `/Volumes/Intel/playground/humanagent/.worker-runs/ux-local-package-ablation-execute-20261017/`、`/Volumes/Intel/playground/humanagent/.worker-runs/ux-restart-ablation-acceptance-20261017/` 和 `/Volumes/Intel/playground/humanagent/.worker-runs/governance-delivery-review-20261017/`。main 推送与自有资源清理按正常交付回执执行。

## 2. 历史候选基线与待交付切片

下列基线保留用于追溯，不作为续派入口。最新唯一候选、远端交付与活动任务见上述 Native Reasoning 进度记录顶部。

- **主干与候选基线**：
  - `origin/main` (`db915e7a`)：含 `task-flow` 与 `task-plan-revision` 契约/Core/JSONL 实现。
  - 后端集成基线：`codex/provider-d-backend-compose-r1-20261014` (`8d2946a1`) 及全部分支化固化后的 `20261014/15` 模块提交。
  - 前端集成基线：`codex/ux-frontend-agent-glue-20261015` (`53abe04b`) 及 `codex/ux-frontend-composition-20261015` (`5d258ac0`)。
- **下一步动作**：
  1. 在唯一集成候选工作树合流后端与前端候选分支，跑通 `pnpm dagpipe:validate`、`pnpm typecheck`、`pnpm build:app` 与受影响聚焦测试。
  2. 完成垂直切片 1（`M0 + M1 + M2`：真实 RCC 4444 + Ego14 浏览器首屏/新建任务/Checkpoint 验收）与 1 次独立 Milestone Review 后合入 `main`。
  3. 推进垂直切片 2（`M3 + M4 + M5`：子 Agent 动态调用与审查闭环 + 偏好/响应式抽屉验收）。
