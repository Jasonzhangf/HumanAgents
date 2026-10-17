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

## 2026-10-17 旧治理消融补漏

本节更新日常开发与本地安装入口；下方旧候选记录只作历史，不作为当前检查要求。

本轮补查（用户再次要求按 bootstrap-migration 执行）：两个独立 GCM 观察者分别检查程序入口和活动规则。日常 build/ci/test/package/install 未再发现 SHA 调用，三节点 CI 图保持闭合；不重跑已有有效验收。正文继续删除 M1/M2/M3 每小阶段 Astra 门、派单 SHA、配置摘要、冻结后才释放依赖及旧脚手架对 checkpoint-runner 的日常调用要求。README 将 release 命令移出日常启动示例。纯文档批次提交 `bcacc988`；随后正常合流 peer 已推送的 Provider 增量，不改其候选或运行现场。

程序补查发现的 `proof:cordis-host-closeout` 与 Dashboard E2E 候选 commit/tree/source/artifact 摘要、运行前后稳定性包装已物理删除。独立小计划后，由 GCM 在唯一外置 `governance-entry-ablation-20261017` 完成 13 文件修改，提交 `ba310b1d`，净删 541 行。同步清理两处浏览器脚本调用、receipt/sidecar/专属测试及 release 测试中的文案匹配和固定配置断言；没有 no-op 兼容层。保留 Task/operation/epoch、授权、settlement、业务 Journal/asset 完整性和资源收口。release 专属程序未扩改。

本批作者验收：普通非 Git 临时目录建立 attempt 的公开反例由 `not a git repository` RED 转 GREEN；runner 51 项、existing-task-change 20 项公开 consumer 通过。contracts 源码、config、App 构建成功；两份受影响 DAG/binding 各校验一次。续派两处直接 caller 及 closeout 语法检查通过。有效 51+20 结果未重复执行。Opus 整体审查因配额 429 退出 3，按规则改用独立 Gemini 4 Argon medium，整体审查 PASS，无 P0/P1/P2。正式集成前仅合入 peer 进度文档与本任务笔记，不改变已验收程序输入。

真实 Cordis consumer 首次因旧 fixture 无配对返回 401；已复用正式 CLI pair 和既有 auth helper，未关闭鉴权或落盘配对码。配对后同公开 HTTP/SSE 返回 `execution.terminal / blocked`，原因 `execution admission source is not bound`，原成功序列断言仍失败。该产品准入缺口已交另一 peer 的 App owner，本轮不改 packages、不造 grant、不放宽断言。因此 Cordis 成功路径仍 INCOMPLETE；真实浏览器/RCC 本轮未执行，标 UNVERIFIED。自有隔离进程/临时 root 已收拢，不动原 Task/A0、53007 或 canonical 安装。

完整证据复用 `/Volumes/Intel/playground/humanagent/.worker-runs/governance-residual-20261017/` 的计划、两路观察、RED、执行日志、owner 接收及整体 review。本批只改规则与验收 harness，无产品安装产物变更，故不重建安装或重启运行实例。main 推送与唯一任务树清理沿正常 Git 交付；SDK 受管副本缺口仍未解决，不能据本批 PASS 宣称整体旧治理消融全部完成。

SDK 缺口未解除：只读源码确认 `pin-lock` 仍计算并比较运行 binary 摘要，并写迁移材料。本轮不执行该包装命令，不重复 init，不手改受管 Skills、pin 或 lock。受管 Skills/maps 仍有旧治理，因此不能报告整体消融全部完成；唯一修复 owner 为 AppSDK 的正常资源升级入口。

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

## 2. 当前候选分支与待交付切片

- **主干与候选基线**：
  - `origin/main` (`db915e7a`)：含 `task-flow` 与 `task-plan-revision` 契约/Core/JSONL 实现。
  - 后端集成基线：`codex/provider-d-backend-compose-r1-20261014` (`8d2946a1`) 及全部分支化固化后的 `20261014/15` 模块提交。
  - 前端集成基线：`codex/ux-frontend-agent-glue-20261015` (`53abe04b`) 及 `codex/ux-frontend-composition-20261015` (`5d258ac0`)。
- **下一步动作**：
  1. 在唯一集成候选工作树合流后端与前端候选分支，跑通 `pnpm dagpipe:validate`、`pnpm typecheck`、`pnpm build:app` 与受影响聚焦测试。
  2. 完成垂直切片 1（`M0 + M1 + M2`：真实 RCC 4444 + Ego14 浏览器首屏/新建任务/Checkpoint 验收）与 1 次独立 Milestone Review 后合入 `main`。
  3. 推进垂直切片 2（`M3 + M4 + M5`：子 Agent 动态调用与审查闭环 + 偏好/响应式抽屉验收）。
