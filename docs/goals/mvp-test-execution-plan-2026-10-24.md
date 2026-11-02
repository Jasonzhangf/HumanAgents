# HumanAgent 分层 MVP 独立执行计划

日期：2026-10-24（America/Los_Angeles）。状态：可执行计划，不代表产品已通过验收。
关联基准：[架构与缺口报告](../architecture/mvp-test-path-2026-10-24.md)、[DAG 缺口图说明](../dagpipe/mvp-test-path-2026-10-24/README.md)、[机器验收图](../dagpipe/mvp-test-path-2026-10-24/acceptance.graph.json)。本文沿用报告中的 `U01–U13`、`G01–G15` 与 `M0–M6` 编号，不重复需求与缺口全文。

来源：独立 Gemini 4 medium Planner 修订稿，宿主接受并校准交付顺序、停止/恢复语义和测试场景表达。8 个模块工作项（W0、W1-Base、五个 W1 分支、M2–M6 集成验收工作项），本轮只完成规划，未开始产品验收。每项只授予表列 owner 与其对应 tests 目录的写权限；未列共享文件由集成 owner 调整分工后再改，不直接跨 owner 修改。全部工作项禁止修改 RCC 配置、他人 worktree 或共享运行实例。

## 1. 准入状态、阻塞边界与第一批立即动作

- `READY`（可立即并行启动，互不等待）：
  1. 接收活跃 peer 已产出的 `G04`、`G05` 有效结果，核对现有工作树归属，不重复派写同一文件。
  2. 启动 `W0` 校准 `G01/G02/G03/G14` 图说明、跨图版本与测试入口；图与 gate 修正只阻断受该边影响的正式代码修改，不阻断无关模块只读采证。
  3. 并行在独占候选树运行 `U01–U03` 既有底座消费者采证，建立 `M1` 基础证据。
- 需先复现采证再定改法的阻塞项（`HOLD-FOR-EVIDENCE`）：
  1. `G05`：[`packages/runtime/src/agent-io/budget.ts`](../../packages/runtime/src/agent-io/budget.ts) 已有 `noProgress` 预算。须先用录制流从公开入口复现同一 `contentUnitId` 连续 `function_call_arguments.delta` 无进展场景，核实实际接线缺口并唯一定位根因 owner，禁止无证据预设跨 `provider`/`context`/`jsonl` 三处同改。
  2. `G06`：`InMemoryAttentionPort` 与双 Journal 静态差异不直接证明业务丢失。须先通过公开入口重开验证待处理 `Attention` 与恢复责任，按首个失败断言决定最小接线，不预定存储迁移，不改需求。
  3. `G10`：`test:compiled:services` 与 `ui-runtime.test.ts` 为历史报告失败。日常迭代复用有效基线与受影响聚焦测试；进入重大 milestone 或 release 边界前必须在组合候选上完整复核清零。
- 范围与分支保护：本地 `main`（`8a6fe5dea`）相对缓存 `origin/main` 超前 12 个提交且含他人待审工作。本轮只落盘审计与计划文档，不替其他工作提交、推送或触发服务重启。`G15`（DSH/ACP/SQLite）保持范围外，不阻断 Provider 主线。

## 2. 分批工作项与唯一 Writer 合同

所有代码与测试执行均在 `/Volumes/Intel/playground/humanagent/<task-slug>` 外置独占 worktree 进行，遵循先关旧树再开新树（SESE Close-Before-Open）。涉及代码修改的节点依次执行：图校准 → 受影响 gate → 红测失败证据 → 唯一 owner 修改 → 真实入口黑盒回归。完整模块命令表见[架构报告第 6 节](../architecture/mvp-test-path-2026-10-24.md)。

| 工作项 / 阶段 | 目标与覆盖范围 | 唯一 Owner 与 Allowed / Forbidden Paths | 输入、交付物与代表性验收命令 |
|---|---|---|---|
| `W0`（`M0`）图、跨图门禁与测试入口校准 | 校准 `G01/G14` 过期图说明；修复 `G02` `scheduled-occurrence` → `serve-task@3` 及绑定检查；将 `G03` 漏挂的公共消费者接入脚本 | Owner：集成与图治理。<br/>Allowed：[`docs/dagpipe`](../dagpipe)、[`scripts/dagpipe-bind-graphs.mjs`](../../scripts/dagpipe-bind-graphs.mjs)、[`tests/release/dagpipe-binding.test.mjs`](../../tests/release/dagpipe-binding.test.mjs)、[`package.json`](../../package.json)（唯一 writer）。<br/>Forbidden：`packages/**` 业务源码。 | 输入：30 张现有业务图与 `tests/**` 清单。<br/>交付：图与代码现状一致，跨图旧版本反例报错，测试入口可解析。<br/>命令：`pnpm dagpipe:validate && node --test tests/release/dagpipe-binding.test.mjs` |
| `W1-Base`（`M1` 底座）契约、配置、Journal 与资产 | 独立验证 `U01`、`U02`、`U03` 成功、越界拒绝与落盘一致性（可与 `W0` 并行采证） | Owner：`contracts`/`core`/`config`/`jsonl`/`filesystem`。<br/>Allowed：各自對應 `packages/*` 与 `tests/*`。<br/>Forbidden：跨包修改 `packages/app/**`。 | 输入：合法/非法契约对象、workspace/pair 参数、Journal 事务与大对象。<br/>交付：`U01–U03` 独立通过回执。<br/>命令：`pnpm test:contracts && pnpm test:core && pnpm test:config && pnpm test:journal`；补充消费者：`pnpm exec tsc -p tests/contracts/tsconfig.json && node --test dist/tests/tests/contracts/task-grants.test.js dist/tests/tests/contracts/task-flow-public-consumer.test.js dist/tests/tests/contracts/turn-closure-public-consumer.test.js` |
| `W1-Provider`（`M1` 分支 A）Provider 双协议与 `G05/G07` | 验证 `U04`；复现 `G05` delta 无进展流并修唯一根因 owner；修正 `G07` live proof 脚本路径与冗余摘要 | Owner：`adapters/provider` 与 live proof 脚本 owner。<br/>Allowed：[`packages/adapters/provider/src`](../../packages/adapters/provider/src)、[`tests/adapters/provider`](../../tests/adapters/provider)、[`tests/app/real-ui-provider-loop.mjs`](../../tests/app/real-ui-provider-loop.mjs)（若复现定位到 `agent-io` 或 `jsonl` 再按证据单开对应 owner）。<br/>Forbidden：`packages/app/src/ui-runtime/**`。 | 输入：Responses/Anthropic 录制流、同一 `contentUnitId` 连续 delta 样本。<br/>交付：无进展流按预算终止并保留恢复责任；proof 脚本使用配置派生 root 且移除源码哈希步骤。<br/>命令：`pnpm test:provider` 及 `provider-current-turn-continuation-public`（见报告第 6 节） |
| `W1-Brain`（`M1` 分支 B）显式分流、FIFO 与 `G04` 跨代收据 | 验证 `U05`、`U06`；接收已有 peer 成果或闭环 `G04` 跨多代（A→B→C）接管终止收据与旧 turn 释放 | Owner：[`packages/app/src/supervisor/supervisor.ts`](../../packages/app/src/supervisor/supervisor.ts)、[`packages/app/src/explicit-brain-runtime.ts`](../../packages/app/src/explicit-brain-runtime.ts)、`runtime/explicit-brain`、`runtime/intake`。<br/>Forbidden：`docs/ui/**`、`packages/ui/**`。 | 输入：简单问答、复杂表单提交、A→B→C 连续接管后遗留的显式 turn。<br/>交付：简单问答零 Task；复杂提交唯一 Task；有终止收据可释放、无收据保留责任、活 owner 永不释放。<br/>命令：`pnpm test:explicit-brain && pnpm test:supervisor` 及 `new-task-identity-public-consumer` |
| `W1-Runtime`（`M1` 分支 C）动态编排、收口与 `G06` 恢复核验 | 验证 `U07`、`U09`、`U10`；先用公开消费者重开验证 `G06` Attention 与恢复责任，按实测偏离做最小接线 | Owner：`runtime/orchestration`、`runtime/agent-loop`、`runtime/context`、`runtime/checkpoints`、`runtime/control`；共享文件 [`packages/app/src/ui-runtime/index.ts`](../../packages/app/src/ui-runtime/index.ts) 与 [`packages/app/src/ui-runtime/service.ts`](../../packages/app/src/ui-runtime/service.ts) 唯一 writer。<br/>Forbidden：`docs/ui/**`。 | 输入：父轮+2 独立 child、无收口动作的 `finish_reason=stop`、进程重开与待决 Attention。<br/>交付：不继承父全文、强制临时续推、四段总结+Planner 迭代、重开后 Attention 可读可完成且不重复派单。<br/>命令：`pnpm test:agent-loop && pnpm test:context && pnpm test:checkpoint` 及 `cold-execution-resume-public-consumer` |
| `W1-Services`（`M1` 分支 D）工具、记忆事件与调度 | 验证 `U08`、`U11`、`U12`（单次策略先验，定时/周期完整组合归入 `M5`） | Owner：`runtime/hand`、`runtime/gateway`、`adapters/operations`、`runtime/memory`、`runtime/events`、`runtime/subscriptions`。<br/>Forbidden：`packages/app/src/ui-runtime/service.ts`。 | 输入：受控文件读写、已提交 checkpoint 事件、单次与定时订阅控制。<br/>交付：越权拒绝且零副作用；事件去重消费与可选故障隔离；`cancel-future` 不误停当前执行。<br/>命令：`pnpm test:hand && pnpm test:gateway && pnpm test:operations && pnpm test:memory && pnpm test:events` |
| `W1-UI`（`M1` 分支 E）UI 投影、公开结果与动作边界 | 验证 `U13` 与 `G13`：列表/详情/观测/结果正文同源、等待授权与人工决策区分、完成态不显示无效停止 | Owner：[`packages/ui`](../../packages/ui) 与 [`docs/ui`](../../docs/ui) 唯一 writer。<br/>Forbidden：`packages/app/src/ui-runtime/service.ts`、`packages/runtime/**`。 | 输入：同一 Task 的快照、公开交付 publication、SSE 正常收拢与断流事件。<br/>交付：五处视图身份一致，手机抽屉可进退，只读页面零控制副作用。<br/>命令：`pnpm test:ui && pnpm proof:work-card && node tests/ui/interaction-liveness-browser.mjs` |

并发与单 Writer 约束：`W1` 的五个分支在 `W1-Base` 就绪后可并行，但 [`package.json`](../../package.json) 归 `W0` 单写，[`packages/app/src/ui-runtime/service.ts`](../../packages/app/src/ui-runtime/service.ts) 与 [`packages/app/src/ui-runtime/index.ts`](../../packages/app/src/ui-runtime/index.ts) 归 `W1-Runtime` 单写，[`docs/ui`](../../docs/ui) 与 [`packages/ui`](../../packages/ui) 归 `W1-UI` 单写。同一工作树内禁止并发运行多个写入同一 `dist/` 的 `tsc`。

## 3. M2–M5 逐层真实入口集成与验收断言

验收依赖遵循 [`acceptance.graph.json`](../dagpipe/mvp-test-path-2026-10-24/acceptance.graph.json)。前置层失败时，仅阻断其真实下游并将该节点记为 `failed`/`unverified` 与恢复责任保留，不进入 `M6` 正式交付。

| 层级 | 真实入口与输入 | 必须同时满足的成功、失败与副作用断言 |
|---|---|---|
| `M2` 确定性组合 MVP | 启动本地 `UiRuntimeServer`，注入 Responses/Anthropic 录制流，依次通过 HTTP 提交简单问答、新建复杂任务、越权工具反例与取消请求；同时在集成候选复核 `G10`。 | 1. 简单问答写 `InteractionProviderSettlementReceipt`，Task 数保持 0。<br/>2. 复杂表单一次提交即产生唯一 root Task，经 `TaskGrant` 准入、工具执行、无收口时临时续推、四段 checkpoint 到公开结果正文可读。<br/>3. 持久化仅落在配置派生的测试 `controlRoot`；`G10` 受影响编译服务套件复核通过。 |
| `M3` Provider 双协议 MVP | 只读使用 `~/.rcc` 当前非敏感配置（4444 同入口），分别驱动 Responses 与 Anthropic 真实路由各完成一次含工具往返的轮次。 | 1. 两条协议各自独立完成请求编码、流式事件、受控文件/只读工具调用、标准轮次收口与 `ProviderSettlement` 落盘。<br/>2. 零 `~/.rcc` 修改；断流或上游错误诚实暴露，不以连接成功代替轮次完成。 |
| `M4` 浏览器单任务交互 MVP | 按 [浏览器验收规范](../ui/dashboard-e2e-acceptance.md) 启动受管实例，在桌面与手机视口操作真实页面：1 次简单问答 + 1 次成功的复杂本地文件任务；另用最小失败/取消反例和既有任务变更确认验证各自边界，不要求一条任务同时成功与失败。 | 1. 简单问答页面直出人类可读回答，主列表零新增 Task。<br/>2. 每次复杂任务提交只新增 1 个业务 root（合法 child 另保留身份）；存在真实 `question/options` 时才展示决策批准并点击生效；完成后展示公开交付正文，无“下一步：可停止”；手机底部抽屉正常开合返回。<br/>3. 产出合规 `receipt.json` 与截图，页面零 `pageerror`；`U12` 定时/周期不阻断本层放行。 |
| `M5` 长程交互增量 MVP | 在 `M4` 基础上提交多步长程任务；分别验证运行中标准 `stop` 和可恢复中断后的冷重开；验证定时/周期计划 `pause/resume/cancel-future`。 | 1. 编排者按需动态调用至少 2 个独立 child（独立 context，返回精炼结果），不固定 `observe-plan-execute-review` 顺序。<br/>2. 至少经历 1 次非终态标准收口 → 四段总结 checkpoint → 独立 Planner 评估 → 开启下一轮，不凭 `finish_reason` 提前结束。<br/>3. 标准停止取得 settle 与 checkpoint；可恢复中断按 typed 恢复入口继续同一 turn，不擅自重开已完成或不可恢复终态；已完成工具与 child 零重放，待决 Attention 重开可读可解；到期 occurrence 精确执行一次。 |

## 4. 失败停止、整体 Review 与资源收口终点（M6）

- 失败停止与恢复责任：任一节点失败时立即在最小 owner 边界停住真实下游，保留现场 Journal、资产引用与 `receipt.json`（标记保留原因与恢复 owner），直接汇入审计报告终点；禁止伪造通过或带着 `INCOMPLETE`/`UNVERIFIED` 进入正式合并。
- 一次整体独立 Review 与标准交付：先 fetch 并把候选组合到最新 origin/main，按实际变化补受影响验收。仅当 `M1–M5` 必需证据与 `G10` 门禁全部通过后，启动一次覆盖完整 milestone 的独立架构 Review。Review PASS 后候选提交并 merge 到 main；运行行为改变时再重建、安装、正式 restart 并验证受影响的真实行为，随后 push origin/main、接收远端回执并清理自有资源。health 仅作存活证据，不代替行为验收。纯文档变化不安装或重启。
- 资源核销：测试回执统一落盘在配置派生的 `~/.humanagent` 下 `runNotesRoot/<attemptId>`。每轮真实验收后按 `stop → settle → checkpoint` 终止测试任务，关闭自有浏览器与受管服务进程，移除本任务已合流的独占 worktree；历史存量中属他人或仍有活动进程的目录显式登记为 `PROTECTED_HOLD` 并注明 owner，不跨界清理他人资源。
