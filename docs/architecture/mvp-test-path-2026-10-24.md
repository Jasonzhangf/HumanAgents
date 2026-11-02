# HumanAgent 分层 MVP 测试路径与架构缺口

日期：2026-10-24（America/Los_Angeles）。状态：审计与执行方案；不代表产品验收通过。

用户目标：先让每个部分形成可单独测试的最小 MVP，再逐层组合，最后通过真实交互测试。本文不重新实现已有能力，不缩减已批准的长程器官式 Harness 要求。

关联产物：

- [DAG 缺口图与验收依赖](../dagpipe/mvp-test-path-2026-10-24/README.md)
- [机器可读验收依赖图](../dagpipe/mvp-test-path-2026-10-24/acceptance.graph.json)
- [独立执行计划](../goals/mvp-test-execution-plan-2026-10-24.md)

## 1. 结论与证据边界

已有架构足以开展分层验收。当前问题不是所有模块都缺实现，而是图、代码、测试入口与交付证据没有统一闭合。最短主线是：基础契约与存储 → 模块公开接口 → 确定性组合 → 真实 Provider → 浏览器单任务 → 停止恢复与动态长程组合。

本次读取的本地 main 最新自然 Git 回执为 `8a6fe5dea`，产品版本为 `0.1.40 / 0.1.0040`；开始时文件无未提交修改。本地分支相对缓存的 origin/main 超前 12 个提交，未 fetch，因此这不是远端实时状态。最近 note 明确存在尚待 milestone review 的其他工作。本次只写本文及关联审计产物，不替其他工作提交、推送或放行。

本次完成：读取有效需求、当前 DAG、关键 owner 源码、测试入口与近期证据；执行既有 DAG 校验。30 张现有业务图通过拓扑、中文标签及文件绑定检查。没有运行产品测试、调用 RCC、创建业务任务、操作浏览器产品页或重启实例。所有下文“待验收”均保持 UNVERIFIED；历史通过或失败均注明来源。

`scripts/dagpipe-bind-graphs.mjs::validateBinding` 检查节点/边、单源单汇、可达性、owner 文件存在与 operator 名称。它不证明真实调用边、异常收尾、跨图接口版本或浏览器行为。静态图通过不能关闭本报告缺口。

## 2. 有效需求与最小范围

需求真源为 `.appsdk/requirements.json` version 19。文件的 changes 是事件历史；按 requirement_id 取最新 result 后有 17 项有效需求。不能把旧版本的布尔 control block 恢复为新设计。

| 需求组 | 有效 ID（均以 humanagent- 开头） | 对最小 MVP 的约束 |
|---|---|---|
| 双大脑 | explicit-brain-semantic-turn-context；implicit-brain-budgeted-independent-orchestration；explicit-brain-simple-answer-or-standard-task-routing；explicit-brain-task-kind-inference | 简单回答不建 Task；复杂任务由显式 Brain 推断类型并派单；预算内独立 runtime；保留最新完整 turn |
| 动态编排 | dynamic-orchestrator-choice-and-agent-termination；orchestrator-delegation-and-refined-result-context | 子角色按需调用、可重复；不固定 observation→plan→execute→review；编排者消费精炼结果 |
| turn 与恢复 | turn-checkpoint-four-part-summary-and-planner-iteration；standard-turn-closure-forced-reasoning-and-same-turn-recovery | 标准结束形成目标/行动/结果/下一步 checkpoint；随后 Planner 对齐；finish_reason 不等于结束；恢复继续同一 turn |
| 续推 | transient-goal-oriented-continuation-prompt；generic-reorientation-prompt-and-boolean-stop-control v2；continuation-oriented-by-explicit-dispatch-template | 通用临时续推提示使用显式派单模板；不污染下一轮上下文；不再要求模型布尔 control block |
| 产品阅读 | human-readable-semantic-layered-ux-and-necessary-display v2；responsive-ux-bottom-sheet-and-four-corner-configuration；task-list-truthful-result-and-action-boundary | 同一任务关联准确；状态、结果和可执行动作一致；桌面与手机分层阅读 |
| 启动 | launch-cwd-independent-declared-workspace；pairing-cwd-and-startup-order-independent | cwd 不改产品 workspace；配对不依赖启动顺序；多终端不相互注销 |
| 修改顺序 | provider-work-order-ablate-graph-governance-code | 先校正图，再修受影响 gate、红测、实现和黑盒 |

当前 AGENTS 另要求：新建表单提交即确认；已有任务改目标/范围须另行确认；数据持久化在配置 owner 从 `~/.humanagent` 派生的 root；控制与 payload 分离；停止须有实际 settle 与 checkpoint；RCC 配置只读。

DSH、ACP、SQLite 重建索引、vector/RAG 与生产部署另列扩展。仓库中有 DSH/ACP 代码和测试，不等于本轮需验证或宣称这些路径已交付。`packages/adapters/sqlite` 当前未发现实现；这不阻断 Provider MVP。已有本地 supervisor 用于必要启动/恢复验证，不扩大为生产 daemon 部署工程。

## 3. 当前架构与独立测试单元

公开入口是 CLI/HTTP/库导出接口。外部系统可用 fixture，但不能 mock 被验收 owner 的内部决策。每单元只取能抓错的最小成功、失败和副作用反例；先跑已有用例，缺行为时才新增。

当前 CLI 仍有两条组装入口：`run/resume` 调用 runAgentOperation/resumeAgentOperation；`serve` 调用 startUiRuntime。二者共享领域与 adapter，不代表共享了全部 Brain、队列和 UI 行为。以下主线选择 serve/HTTP/浏览器；headless 用其自己的公开入口回归，不能用 headless 成功替代 UI 交互成功。Agent templates 作为 U02/U07 的角色输入，复用 `test:agent-templates`；context-events 作为 U09/U11 的上下文事件契约，复用 `test:context-events` 及 semantic-public-consumer。

| 单元 | 唯一 owner 与当前入口 | 最小输入 → 可观察结果 | 必须抓住的失败/副作用 | 复用入口与证据缺口 |
|---|---|---|---|---|
| U01 契约与领域 | packages/contracts、packages/core | 合法身份/Task/turn/grant → 合法状态迁移 | 跨 scope、旧 epoch、非法终态被拒；拒绝不写状态 | test:contracts、test:core；补选 task-grants、task-flow、turn-closure public consumer，G03 |
| U02 配置与产品身份 | packages/config；CLI product/pair/serve | 任意 cwd + 显式 workspace/产品 root → 同一产品路径 | 缺 workspace、错误声明明确失败；配对不创建项目；不读取凭据到报告 | test:config；启动配对公开消费者与 proof:auth-login；图说明过期 G01 |
| U03 Journal 与资产 | adapters/jsonl、filesystem；checkpoint ports | append/read/reopen + asset put/read → 同一事实与字节 | 部分写入/缺资产/重复提交不伪造成功；恢复仍有 owner | test:journal；assets、native-save-progress、active-turn-segments public tests；G03/G06 |
| U04 Provider | adapters/provider；ProviderAdapter/ProviderAgentDriver | 一条请求 + 工具往返 → typed events、settlement | Responses/Anthropic 语义分别保留；断流/取消/未知终态诚实；不重放已执行副作用 | test:provider + request-context/current-turn-continuation；G03/G05/G07 |
| U05 显式 Brain | runtime/explicit-brain、intake；app explicit-brain-runtime | 简单问答→回答+ProviderSettlement；复杂提交→一个已确认 Requirement | 简单问答零 Task；同次提交无第二确认；失败释放本次 scope；既有任务变更须确认 | test:explicit-brain、explicit-brain-runtime、new-task-identity public consumer；G04/G08 |
| U06 FIFO、准入和 Task 身份 | core 规则、runtime/intake/admission；app service wiring | 两条需求、预算/授权 → FIFO、唯一 Task 与 execution binding | 重放不重复创建；预算满等待；缺 grant 不执行工具；控制命令不进需求队列 | test:runtime + new-task-identity、task-grant HTTP public consumers；G03/G08 |
| U07 动态编排与 child | runtime/orchestration、agent-loop；app child-producer/turn-planner 组装 | 一个父 turn、两个独立 child → 独立 context、精炼交付、选择/不选择记录 | 重复回传不重复采纳；未完成 child 不被父任务伪造成功；预算归还 | test:agent-loop + active-turn-child-lifecycle、cold-incarnation；G09 |
| U08 Hand、Gateway 与副作用 | runtime/hand、gateway；adapters/operations | 一个任务内读/写专属文件 → tool result 与真实内容一致 | 越权路径/工具失败不写文件、不冒充交付；stop 后副作用按契约收拢 | test:hand、test:gateway、test:operations；native-file-search consumer；G07/G08 |
| U09 上下文与标准 turn | runtime/context/checkpoints/control；app standard-turn-* 组装 | 当前完整 turn + 历史 checkpoint → 四段总结、交付、Planner 下一步 | finish_reason 无标准收口须续推；临时提示不进入下轮；坏 deliveryRef 可纠正且不产生成功 checkpoint | test:context、test:checkpoint；standard-turn-control、provider-current-turn-continuation；G03/G09 |
| U10 停止、冷恢复与 Attention | runtime/control/agent-loop；jsonl；app supervisor/explicit bridge | stop 或重开真实 consumer → exact checkpoint、settlement、同 turn 恢复 | 无终止证据保留责任；跨多代不丢收据；Attention 重开可见；不重复 child/工具 | test:supervisor、control、cold-execution-resume、recovery-assets；G04/G06/G10 |
| U11 Memory、事件与健康 | runtime/memory/events/health；adapter/memory | 已提交 checkpoint 事件 → 一次消费、同 scope recall、健康原因 | 重复事件不重复写；可选能力错误隔离；健康 snapshot 不作调度真源 | test:memory、test:events、memory-coordinator/health；G11 |
| U12 调度与 occurrence | core 规则、runtime/subscriptions；app scheduler | 一次/定时 policy → 到期 claim、Task、terminal receipt | pause 不生成新执行；cancel-future 不冒充停止当前 Task；重启不重复 occurrence | subscriptions public consumer、scheduler-production-wiring、durable-occurrence；proof:plan-control；G01/G12 |
| U13 UI 与公开读取 | packages/ui projection；docs/ui 实际页面；app 只组装 HTTP | 同一 Task 的列表→详情→观测→结果正文 | root/child 身份不串；blocked≠人工决策；点击批准须实际推进；读取/返回不执行 Provider | test:ui + product-output/read/relations consumers；page-wiring、liveness、work-card；G08/G13 |

依赖图见关联图文档。U01/U02/U03 是组合底座；U04–U13 的测试可使用已验证的底座，但每项须独立提供输入与可读终点，不能依靠另一测试留下的 Task 或服务。

扩展部分也保留独立测试切片，但不放进当前 MVP 放行链：

| 扩展 | 独立最小切片 | 已有入口 / 未交付部分 |
|---|---|---|
| headless CLI | fake run→持久 checkpoint→resume；失败保留责任，恢复不重放副作用 | tests/app/app.test.ts 中的 CLI/session 消费者；真实后端证据需独立确认 |
| DSH adapter | provider-neutral 请求→事件→stop/settle；真实 DSH 崩溃后回到 Harness checkpoint | `pnpm exec tsc -p tests/adapters/dsh/tsconfig.json` 后运行 dist/tests/adapters/dsh 下 dsh-adapter、dsh-driver、dsh-replay、dsh-real-transport 测试；proof:dsh-entry/lifecycle/cli 须先核对当前规则和 DSH 源码，不原样放行 |
| ACP adapter | 客户端发起→事件映射→取消→settlement；不向 core 泄漏后端身份 | `pnpm test:acp`；proof:acp-runtimes 属于独立 live 验收，本次未运行 |
| SQLite 索引 | 从 Journal 构建→查询→仅删索引后重建一致 | 当前无 implementation；以后实施用真实 consumer；Journal 保持唯一真源 |
| vector/RAG、生产部署 | 按独立需求定义输入、可用结果、失败与恢复边界 | 本次不建立虚构测试或放行状态 |

## 4. 具体缺口清单

等级：P0 阻断正确性或整体验收；P1 阻断对应模块/交互闭合；P2 文档或扩展缺口。类型为静态确认、历史失败待复核、证据缺失或范围外。静态确认不等于已完成动态复现。

| ID / 等级 | 缺口与证据 | owner / 影响 | 最小关闭条件 |
|---|---|---|---|
| G01 / P1 | 图与代码不一致。serve-task 标订阅未接，service.ts::persistAuthorizedExecutionPlan 已调用 port.create；default-product-adoption 标方法不存在，config 已导出 readDefaultProductSelection/declareDefaultProduct/resolveProductPaths；checkpoint-path-reentry 标缺路由，server.ts 与 runtime-api.js 已有双入口；subagent/serve-task 标 inspection owner 未实现，InspectionTurnBoundary 已实现并被 inspection-composition 引用。静态确认。 | 各图 owner；误导修复范围 | 逐项追踪实际 caller、测试和已存回执后更新对应说明；保留未验收状态，不能全改为 DONE |
| G02 / P1 | scheduled-occurrence.executionContract.callee 仍为 serve-task@2，当前 serve-task version 为 3。现有 gate 不校验跨图版本和业务输入输出兼容。静态确认。 | 调度与 serve 图 owner | 对照两个边界的实际 binding/receipt，校正引用及适用 gate；旧引用反例应失败。只补这条受影响边，不造通用框架 |
| G03 / P0 | 常用测试/release 链漏列关键 public consumers。158 个 .test.ts 中 89 个文件名未显式出现在 package scripts（仅静态筛选，不等于 89 个全部漏跑）。已核实 new-task-identity、cold-execution-resume、provider-current-turn-continuation、native-save-progress、filesystem/assets 未被 package/scripts/release 显式调用；tsc 编译不执行测试。 | scripts/package owner + 对应测试 owner | 明确选择这些失败模式的命令并接入应属的批次；证明一次执行记录。逐项查其他 runner，禁止靠总数量补测试 |
| G04 / P0 | 跨多代显式 turn 终止证据缺失。supervisor.ts 的 Lease 只保留 takeover；新 lease 写入最近一次 takeover。explicit-brain-runtime.ts 只比对 current.takeover 与 committedOwner。note 报 task-8 跨代锁死。当前机制静态确认；事故本次未重放。 | app supervisor 持久生命周期 owner；显式 Brain 仅消费收据 | 受控公开入口重放 A→B→C 后 A 遗留 turn；有证据可释放，无证据保留责任，活 owner 永不释放；不重复 Provider。修复已有 peer 结果先接收，避免另开 writer |
| G05 / P0 | tool arguments delta 长期无进展。note 最新事故报告任务 26 分钟 running、同一 contentUnitId 堆积。agent-io 有 noProgress budget，但本次未证明 Provider/native 实际链受该预算约束。不能直接断言完全无 watchdog。 | provider 流 owner + runtime 请求生命周期 | 录制流同入口复现、定位何种事件算进展；上限到达后明确状态、typed error、settle/恢复责任，资源有界；正常长任务不按总时长误杀 |
| G06 / P1 | UI Attention 使用 index.ts::InMemoryAttentionPort，headless 用 createJsonlAttentionPort。进程重开后的 UI attention 交付/resolve 未见同入口证据。UiRuntimeJournal 还持久化 inbox/confirmationLedger/dispatchLedger，不能把它当可删缓存。静态差异确认，丢失影响待测。 | runtime Attention/恢复语义；app 接线；jsonl 存储 | 触发一条待处理 Attention，重开后可读且可完成一次；列清 interaction journal 与 task-control Journal 的不同责任，用 crash 窗口验证不重复派单。无证据不先做存储迁移 |
| G07 / P0 | 旧 proof:ui-provider-loop 只跑 responses/openai，缺 Anthropic；默认把 control root 放 tmp、receipt 放 dist，并主动做源码摘要。这与当前路径/验收约束不一致，不能原样列为 MVP 放行命令。Provider replay 已有 Responses/Anthropic 样本。 | tests/app live proof owner；provider 协议 owner | 复用并最小修正现有 proof，或用已有合规 runner；RCC 当前非敏感配置选型，分别完成 Responses/Anthropic 请求→工具→标准收口→真实 receipt；删除范围内无行为保证的源码摘要步骤 |
| G08 / P1 | 新建表单、Task 身份、结果/状态、真实动作必须作为一条浏览器链验收。note 报近期已修身份及导航；不再记为缺实现。但没有本次同版本的完整组合回执。 | app 入站接线、UI 交互各自单 writer | 简单回答零 Task；复杂表单仅提交一次，只有一个业务 root；列表/详情/结果正文对应同一权威身份；确有 decision 才给批准入口，批准后实际推进 |
| G09 / P1 | 动态独立 child、标准 turn end、checkpoint、Planner、下一 turn 的局部代码与 public consumers 已存在；未找到足以直接认定当前整体长程交互已验收的证据。 | runtime 编排；app Provider/Planner 组装 | 两独立 child 的可区分输入证明不继承父全文，返回精炼交付；至少一次非终态标准 turn→四段 checkpoint→独立 Planner→下一 turn；一次完成任务不强制多 turn |
| G10 / P0 | note 10/23 报 test:compiled:services 14 项既有失败，10/24 报 ui-runtime 整文件从 test 33 cancelled。属于历史原错，不是本次测试结果；源码/安装/version 不能豁免 release gate。 | 对应失败测试的功能 owner；集成 owner 汇总 | 开始实施时在最新候选复核原错并按失败模式分组；修复适用失败；完整 milestone/release 边界再跑所需完整 gate，不沿用跳过该阶段的产物作 PASS |
| G11 / P1 | Memory/EventBus/health 有模块、consumer 与 CLI 接线；旧 9/20 审计说 coordinator eventBus unavailable，当前不能直接沿用。需要实际 composition 的事件消费、隔离与冷读证据。 | runtime events/memory/health；app wiring | checkpoint 提交→持久事件→消费/recall；重复投递一次效果；可选故障显式降级而主 Task 按契约继续；关键持久化失败不吞错 |
| G12 / P1 | scheduler/occurrence 有生产接线测试与历史 plan-control 28/28 记录。仍需把单次主链与定时/周期增量分开，并核验跨图终态/恢复边。 | runtime subscription 语义；app scheduler 接线 | 单次任务先过；随后一个到期 occurrence、pause/resume/cancel-future、一次冷重开，无重复副作用；保留当前 Task 与未来计划的区别 |
| G13 / P1 | UI 已有共享模板与多页接线；note 明确五板块 live/history、统一 session、关系、人类来源、完整批准恢复仍有差距。本次不将全部旧清单直接认定为现存缺代码。 | packages/ui projection 与 docs/ui renderer | 按同一真实 Task 贯穿受影响列表/详情/观测/结果/决策；桌面与手机单抽屉可返回；读取零控制副作用。逐条把旧项分为已修、未接线、待 live 证明 |
| G14 / P2 | 设计文档仍有旧状态：native-brain 入口绑定 requirements v7；实际有效文件 v19。AGENTS 阶段说明也不能代替扩展路径现状。 | 设计文档 owner | 本报告使用最新有效需求；实施影响相关文档时按真实证据更新，不批量重写所有历史文档 |
| G15 / 扩展 | SQLite 未实现；DSH/ACP 有代码但不属于本次 Provider 最小验收主链。 | 对应 adapter owner | 不阻断主线；只有独立批准/声称该路径交付时才执行对应真实停止、恢复、consumer 和组合门禁 |

这里的“全部缺口”指上述当前架构、有效需求和可见验收路径内的已识别差距。没有运行的行为不能靠静态审计证明无缺陷。首次实施必须将 G04/G05/G10 的原样本和最新候选对齐；不重复修已合流的工作。

## 5. 逐层整体 MVP 路径

| 层 | 最小可用结果 | 前置 | 放行条件 / 出错时停止范围 |
|---|---|---|---|
| M0 可相信的验收入口 | 图和代码状态一致；所选测试确实执行 | G01/G02/G03；确认已有 peer 的写入边界 | 需求→owner→公开入口→结果的映射可查；只停缺关键边的单元 |
| M1 单元独立 MVP | U01–U13 分别通过最小 consumer | 按依赖复用 U01/U02/U03；无需真实 RCC | 每单元成功/必要失败/副作用有断言，独立重开不依赖前序测试残留 |
| M2 确定性组合 MVP | fake/replay HTTP 任务从一次提交到真实持久结果；另含失败/取消组合 | 核心 U01–U10、U13 | 真实 app/runtime/storage，外部 Provider fixture；唯一 Task、grant、工具、标准 turn、checkpoint、结果读取及 cleanup 一致 |
| M3 Provider MVP | Responses 与 Anthropic 各走同一真实 app 入口 | M2；G04/G05/G07 对应关键缺口关闭 | 当前 RCC 4444 同入口 receipt；不改 RCC；协议不互代；不把 connected 当完成 |
| M4 单任务交互 MVP | 浏览器简单问答及一次复杂文件任务，手机/桌面可读结果 | M3；G08 | 简单回答 ProviderSettlement；复杂任务一次表单提交、唯一 root、真实副作用、公开正文与页面一致；受控失败可解释 |
| M5 长程交互 MVP | 动态 child、一次非终态 turn、Planner 续接；stop/冷恢复；Memory/事件；计划增量 | M4；G06/G09/G11/G12/G13 | 同 turn 精确恢复，不重复工具；Attention 不丢；定时/周期增量单独验收；不把角色链写死 |
| M6 交付 | 当前范围整体证据、review 与集成一致 | M1–M5 对应必需项，G10 | 完整 milestone 自检和一次整体独立 review；标准 main 交付；运行变化才正式 restart；测试资源收口 |

M4 是“单任务可交互 MVP”，不是完整长程 Harness 已完成。M5 是已批准完整目标的必要下一增量。各层失败留下真实 failure/unknown 与恢复 owner，不伪造成功继续下游。

## 6. 可执行命令与选择规则

以下命令为从当前 package/tsconfig 核实的入口，本次没有执行。所有构建和产品测试在后续外置独占候选 worktree 执行。不同任务不能并发写同一个 dist。命令按单元选取，不每轮全跑。

```sh
# 基础与已有模块批次
pnpm test:contracts
pnpm test:core
pnpm test:config
pnpm test:journal
pnpm test:provider
pnpm test:explicit-brain
pnpm test:agent-loop
pnpm test:context
pnpm test:checkpoint
pnpm test:hand
pnpm test:gateway
pnpm test:operations
pnpm test:memory
pnpm test:events
pnpm test:ui
pnpm test:supervisor

# 现有关键消费者：按 G03 显式选择，编译一次后按批次运行
pnpm build:contracts
pnpm exec tsc -p tests/app/tsconfig.json
node --test dist/tests/tests/app/new-task-identity-public-consumer.test.js dist/tests/tests/app/standard-turn-control-public-consumer.test.js dist/tests/tests/app/active-turn-child-lifecycle-public-consumer.test.js
node --test dist/tests/tests/app/cold-execution-resume-public-consumer.test.js dist/tests/tests/app/recovery-assets-cold-read-public-consumer.test.js dist/tests/tests/app/segment-recovery-assets-public-consumer.test.js
node --test dist/tests/tests/app/product-output-read-consumer.test.js dist/tests/tests/app/product-service-read-consumer.test.js dist/tests/tests/app/task-grant-http-public-consumer.test.js
pnpm exec tsc -p tests/adapters/provider/tsconfig.json
node --test dist/tests-provider/tests/adapters/provider/provider-current-turn-continuation-public.test.js dist/tests-provider/tests/adapters/provider/provider-request-context-public.test.js
pnpm exec tsc -p tests/adapters/jsonl/tsconfig.json
node --test dist/tests/adapters/jsonl/native-save-progress-public-consumer.test.js dist/tests/adapters/jsonl/active-turn-segments.test.js
pnpm exec tsc -p tests/adapters/filesystem/tsconfig.json
node --test dist/tests/adapters/filesystem/assets.test.js
```

浏览器层优先沿 `docs/ui/dashboard-e2e-acceptance.md` 与现有 `tests/app/dashboard-e2e/runner.mjs`。该 runner 的 web-search 只支持 success；local-file-search 支持 success/failure/cancel；existing-task-change 支持 success。简单问答和动态长程组合不能冒用这三种场景的通过记录。复用现有页面和手动验收，不强造新 runner。

```sh
# 合规入口先完成候选构建与配置，按当前真实 provider 选择；不得盲跑旧 proof:ui-provider-loop
pnpm e2e:dashboard:local-file-search
node tests/app/dashboard-e2e/runner.mjs --scenario local-file-search --outcome failure
node tests/app/dashboard-e2e/runner.mjs --scenario local-file-search --outcome cancel
node tests/app/dashboard-e2e/runner.mjs --scenario existing-task-change
# web-search 涉及外部搜索能力，仅对应模块需要时执行
pnpm e2e:dashboard:web-search
```

新增测试理由：G04/G05/G08 有近期真实事故依据，影响为入口锁死、资源增长和错误交付；G03/G06/G09/G11/G12 的失败概率未知，但涉及持久状态和副作用。优先在本地公开 consumer 复现，成本低于真实模型/浏览器。只为缺失断言补测试；现场未知不自动新增场景矩阵。每份执行记录写明反例、首个失败断言、实际输入、结果和清理；必要反例未执行时保持 UNVERIFIED。

## 7. 实施与资源边界

本轮审计产物共三类：架构/缺口报告、DAG 图、执行计划。产品 MVP 的 M0–M6 尚未由本轮验收，不计算完成百分比。

后续具体实现按计划派给 peer；Planner、实现与 milestone Reviewer 分离。当前共享 main 有其他待审查提交，不将它们合并为本任务范围。先接收现有问题 owner 的有效结果，再在最新 origin/main 或唯一集成分支建立外置独占 worktree；同域旧树先关闭，不清理他人保护资源。

测试 receipt 由配置 owner 派生至 `~/.humanagent` 下的 runNotesRoot/attemptId，截图放 shots；代码验证日志在自有 run 目录。每次真实测试登记 Task、路径、PID/端口和浏览器 owner。结束沿标准 stop→settle→checkpoint；未 settled 保留恢复资源和责任。只清理本轮自有资源。前台错误可见，后台局部错误隔离；RCC、共享实例和他人任务不作试验对象。

本报告的静态依据为所列源文件与本次 `node scripts/dagpipe-validate-graphs.mjs` 回执：`validated 30 DAGpipe graph(s)`。独立 Planner 的读取结论与执行依赖见执行计划；它不替代开发后的独立 Review。
