# HumanAgent 项目状态汇总（2026-10-17）

## UX 最新可用行为与未完成项（2026-10-15）

- checkpoint 查询与实际浏览器已组合到候选 `276d57ed`。生产 dispatcher、真实认证、Journal 和实际前端证明 current/viewed 独立、筛空保留、刷新/前进/后退、桌面侧栏、手机底抽屉、语义/Context/恢复描述及引用返回。正常 App build0，原 HTTP consumer1/1；浏览前后六个持久化文件、完整执行位置不变，effects0。证据：`/private/tmp/humanagent-ux-remaining-20261015/checkpoint-compose-c6-r2/parent-receive.md`。这不证明真实 RCC 输入执行、正式 daemon 或完整 G14。
- **F13 仍有已复现的生产缺口。** 活动子进程42804在真实本地 HTTP 请求及非空 dispatching 义务下被 SIGKILL；确认死亡后，新进程43040读到同一 Task/turn/checkpoint/Context，原 effect 的一次 intent、一次 completion 和字节不变。公共 `resumeExecution` 在 `cold-execution-source.ts` 读取活动 tail 的 capture receipt 时返回 `cold-execution.source-unavailable`，没有建立后续执行实例。旧 v1 返回向 v2 的实际重投已拒绝；被杀 v2 到后续 v3 的 fencing 尚未验证。原正常退出 cold2/2 不能代替该缺口。
- 崩溃探针的原始 RED、生命周期和 source 补丁保留在 `/private/tmp/humanagent-ux-remaining-20261015/cold-crash-c8-r2`；两个子进程和自有 listener 已关闭，含未决义务的专属 fixture 保留。探针还把“控制状态和请求数不推进”无条件用于未来成功恢复，这与恢复需要新 epoch 相冲突，因此未加入正式回归集。其临时源码和 helper 改动已撤出；必要的恢复验收没有取消，须在正确恢复合同确定后补齐。
- **G14 资产正文未接通。** 完整 RawAsset 已到达 UI 回调，但 TaskDashboard 的引用层只展示 evidenceId/view.kind，未使用已有 scope/digest 校验的 RawContentReadPort；现有 tool-output 路由不是 checkpoint capture 的读取入口。需要正确的任务内公共读取边，不能把文件 locator 直接变成 URL。只读源链记录：`/private/tmp/humanagent-ux-remaining-20261015/checkpoint-asset-read-observe-r1/observation.md`。
- 显式交互的伪造 Task/Operation 身份及确认后提前显示 running 已修复并进入唯一候选：来源 `676f78d` → `0875478c`，11 个路径与来源一致，卡片浏览器 39 项、Task 页面 4 项作者验收通过。来源工作树已正常关闭，证据归档 `/Volumes/Intel/playground/humanagent/.worker-runs/ux-card-identity-20261015/`。原 8 个旧 UI 失败及默认 page 旧 selector 失败仍开放，由 UX peer 继续最小审计/消融。C4/C7 后续 Context、公共控制和崩溃恢复仍未完整交付；整体 I1 Review/main/restart/push 未完成，不用该内部切片代替整体验收。
- C4 冻结八文件已通过标准 Git 合流为 `d1c1d2b0`，保留 C3 语义只读工厂。当前组合的正常 App build0、原 C4 focused compile0、原 C4 公共 consumer1/1、原 checkpoint HTTP consumer1/1 均通过。只证明已挂基础与读边的组合，不能替代尚未接线的后续 Context、HTTP 控制和崩溃恢复。证据：`/private/tmp/humanagent-ux-remaining-20261015/c4-composition-r1/receipt.md`。

- **当前阶段**：`MVP-IMPLEMENTATION`（`I1–I5` / `G1–G14` / `F01–F20` 纵切片合流收口中，状态 `ACTIVE / INCOMPLETE`）。
- **权威需求与进度入口**：
  - 用户需求真源：[`.appsdk/requirements.json`](.appsdk/requirements.json)（`version: 14`，按当前有效条目执行）。
  - 长期执行计划：[整体执行计划](docs/goals/ux-interaction-long-horizon-plan-2026-10-11.md)、[Provider 缺口计划](docs/goals/native-provider-gap-plan-2026-10-11.md)。
  - 进度汇总：[Native Reasoning & UX 进度摘要](docs/goals/native-reasoning-progress-2026-10-08.md)（历史完整流水账已归档至 `/Volumes/Intel/playground/humanagent/.worker-runs/archived-progress-logs-20261015/`）。

## 2026-10-17 共享读取保护与旧治理消融

本轮源提交为 `49daab38` 和 `30ed5852`，已通过标准 Git 合流进入 main，集成提交 `bf4fface`。完整 I1–I5 / G1–G14 / F01–F20 仍 ACTIVE；本轮关闭浏览器共享读取边界的缺陷和项目选中的旧 Guidance，不宣称跨任务 live、Provider 或完整恢复写链完成。

成功的 scoped publication 和 semantic GET/SSE 在接收时递归冻结同一个 JSON 对象。消费者继续共享引用，新版本不改写旧对象。失败、stale、HTTP/SSE 解码和控制语义保持原契约。Node 公开 consumer 4/4、真实生产面板浏览器 consumer 69/69 通过。分别移除 GET 或 SSE 保护时，各自只触发对应攻击断言失败；恢复后 69/69 通过。没有新增测试框架、publisher、缓存或逐消费者复制。

实际删除项目配置中的旧 `guidance` 选择、仅运行 typecheck 并复制配置的 `humanagent-governance` 占位 module，以及 953 行派生 `.appsdk/guidance/compiled.json`。观测图的 `meta.baseline` 也已删除，拓扑未变。保留 app module、需求、goal、历史记录、事务、控制状态、受管 Skill 正文、SDK lock/pin 和业务数据完整性机制。Schema 与解析对象保留比较均通过；真实 `appsdk guide status` 返回 `guide_flow_required: false`、`first_failing_gate: null`、保留的 app module，不再加载旧 Guidance。未跟随初始化提示，也未运行 reset/fresh、SDK 刷新或摘要包装。

组合候选经一次整体独立 Gemini 4 medium review，原始结构化结果由既有裁决器判为 PASS，findings 为空。本次 Opus 配额错误保留，未当作代码失败。源码 contracts、config、App、package 与正式安装完成；额外误选的 `build:contracts` alias 因两处旧测试 fixture 字段编译失败，原错保留，不报该 alias 通过。该 fixture 迁移已在 peer 的 native 候选内，本轮未重复修复或放宽断言。

正式 restart 将原 53007 实例从 generation 20 更新到 21。真实页面的共享 publication 保持同一引用，嵌套写入被阻止，另一个读者和当前 publication 都保留“已完成 · 结果可用”。Task 仍 succeeded，结果和计划可读，偏好 current/null，桌面无横向溢出，抽屉关闭，Journal 保持 640 行。此前补齐的实例详情/引用返回、未知项目错误、独立 Observation 和偏好保存/深链/重置证据继续有效。

证据位于 `/Volumes/Intel/playground/humanagent/.worker-runs/ux-shared-payload-delivery-20261017/`、`ux-payload-mutability-20261017/` 和 `ux-canonical-remaining-read-acceptance-20261017/`。两棵子任务源树已合流后正常移除。剩余整体目标继续按既有计划执行，native 与 Provider 的未完成项不从本轮 PASS 推导为完成。

## 2026-10-17 首个生产 UX 读取切片交付

完整 I1–I5 / G1–G14 / F01–F20 继续 ACTIVE；本节只关闭已有真实任务的这批读取与交互子能力，不宣称新 Task 执行、跨项目隔离或 checkpoint 修正／恢复写链全部完成。

实现已通过标准合并进入 main，集成提交 `5ab51a09`。本轮包括 durable task inventory、当前状态冷读、checkpoint／Context／计划历史与捕获正文、七源 Agent 目录及精确选择、共享四种阅读模式、四角配置、桌面侧面板／手机底部抽屉，以及原实例正式 restart 恢复。当前层保留真实任务和计划语义，完整说明、计划证据和轨迹通过共享抽屉查看。原始 Journal 的 initialOpen／interrupted／receipt 三分合同完整读取；已结束动作不再虚假显示活动，历史失败和未知不被改写为成功。

作者完成 scoped tests、真实公开入口和双端验收后，独立 Gemini 4 medium 完成一次完整 milestone Review；正式结构化结果由现有 classifier 判为 PASS，findings 为空。首选 Opus 本次配额错误保留，不当代码 FAIL；未为本 milestone 的内部节点分别派审。测试仅按受影响行为选取，移除了本轮误增的 Fake DOM harness，未引入 SHA、候选身份包装或冻结校验。UX 核心框架中遗留的基线 SHA 行已删除。

main 上 contracts 源码、config、App 和 package 构建全部通过；正式安装与 `humanagent restart` 成功，原 53007 实例 generation 19 → 20，旧实例 clean 收拢。原任务 `ui-task-implicit-draft-2` dashboard／checkpoint 均为 200，Task 仍 succeeded，历史检查点仍为 seq 1、epoch 3、blocked；Agent 目录可读。捕获正文实际加载 165,887 字符；完整说明及输出保持原文；轨迹 67 → 66 → 67 页切换和焦点返回正确。语义区域保持未知 8 项、已提交事实 22 项，无 live 区域。只读验收未新增业务事件，原 Journal 仍 640 条记录、637 条 operation.event。

同一真实配置的系统 → 项目 → 原任务下钻已在桌面和手机通过，scope、四角入口及无横向溢出正确。该现场只有一个项目和一个任务，因此不作为多项目隔离证明。当前计划详情 → 精确证据 → 返回／关闭及正常刷新后的焦点归还均已通过；最终截图已查看。全部行为证据、Review 原始结果与裁决保存在 `/Volumes/Intel/playground/humanagent/.worker-runs/ux-first-slice-review-20261017/` 和 `ux-original-browser-20261017/`；执行流水继续在 `i1-read-delivery-save-20261016/note.md`。

后续仍按完整计划推进 I2–I5 和 G/F 剩余验收。peer 的预算、Provider 停止及新任务执行候选不在本次集成范围。外部 4444 当前连接失败会影响真实生成和 GCM，不影响这批已验证的只读入口；没有为此修改或重启外部服务。资源只回收我方来源树和集成树，保留原任务及 peer 资源。

## 1. Worktree SESE 治理与存量核销回执（2026-10-15）

本节数量和路径为清理任务结束时的历史快照，不是后续恢复与正常派发后的实时存量。当前候选及本侧资源回执以唯一进度记录为准。

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

## 2026-10-17 Pool 并发占槽独立增量

- 完整修复 source `4990a696` 已集成至 main `13dab3ac`：复用 idle 实例前同步占位，失败时只恢复仍属自己的未持 lease 预占，防止同 tick 两次 acquire 返回同一实例。仅 runtime-pool 与原 consumer 两文件。
- 原两 idle 公开反例 RED 已复用；当前 main 派生候选同编译选项定向编译成功，相关 consumer 9/9，main 组合 distinct-idle 原用例 1/1。原目录级 retry fixture 类型错误保留，未改无关 fixture 或断言。独立 Opus 本次 quota 错误后，Gemini 4 medium SUCCESS/exit0；现有 controller 裁决 pass、findings[]。
- main source contracts/config/App build、package、global install 均成功。自有 canonical 隔离实例正式 restart generation1/PID12468→generation2/PID17889，官方重新配对后公开 runtime status HTTP200，模型请求0；正式 SIGINT→dispose 后 PID absent、lease disposedAt2026-10-17T14:46:08.691Z。原 gen21/p3 未动。初次诊断误用 `/api/status` 的404保留，实际公开入口为 `/api/runtime/status`。
- 来源树 clean/无活动进程后正常 remove/prune/path absent；证据在外置 `provider-pool-delivery-review-gemini-r124-20261017/` 的 classification、main-build/package/install、restart 与 runtime-read 回执。本增量不证明完整 native 目标或真实 RCC App Task 已完成。
