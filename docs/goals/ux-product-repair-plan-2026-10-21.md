日期：2026-10-21。状态：PLAN_READY，实施未启动。独立 Planner 初稿已接收；负责人仅将共享壳与页面写权拆开，消除可避免的接线串行。来源补录位置、部分板块的可枚举事实，以及真实审批继续行为仍有具体未知；这些未知只阻断相关下游，不阻断其他 ready 任务。

本轮仅完成规划与文档交付。未修改产品、运行测试、安装、重启、执行业务任务、新建开发工作树或清理他人资源。执行提示词唯一维护于同目录 `ux-product-repair-execution-prompt-2026-10-21.md`。独立规划原始输出和路由回执保留于 `/Volumes/Intel/playground/humanagent/.worker-runs/ux-repair-plan-20261021/`。

## 1. 总目标与交付基础

完成用户已明确的整套 UX：

- 左侧为交互、编排、巡检、执行、记忆五板块。每张卡可显示多条真实 Live 任务；板块 dashboard 上方 Live，下方历史。
- 选中任务后，中心显示当前 focus 的 agent/session。消息按实际 actor、source、发生时间、内容和已提交结果呈现。
- 右侧显示当前任务有依据的完整关联链。节点可切换 focus，可跳转上下游；层级返回、浏览器前后和刷新保持选择及读取范围。
- 桌面关联层可关闭。手机导航和关系共用既有单一底抽屉，输入留在主区。
- 交互 agent 日常面向人。其他 agent 日常面向编排 agent。Live session 保留明确人类身份的主动介入入口；普通执行不等待人。
- 权限来自正式 principal 与 task-scoped 授权。需要审批时直接弹窗，执行等待批准或拒绝；批准后实际继续。关闭、收起和导航离开均不等于拒绝。
- 已提交结果在各入口一致。没有结果时不画空结果块。配置轻量贴边；机械字段、正常连接、读取完整性和重复说明退出主层，真实错误和恢复入口保留。

已完成基础直接继承：

| 基础 | 已交付事实 | 本计划中的处理 |
|---|---|---|
| 三类排版模板 | `collection/work/standalone`、显式 root、具名 slots、共享详情及焦点返回 | 复用，不重建 |
| 八页接线 | entry、dashboard、tasks、task、task-dashboard、observation、memory、login 已迁移 | 只改受影响接线，不重做迁移 |
| 生命周期 | BFCache 保留、真实退出清理、详情晚响应及手机列布局已有修复 | 保留不变量，变更触及后才补验证 |
| 产品交付 | 前轮记录证明 main 合入、全局安装、正式 restart、安装后浏览器读取、push 和自有资源清理 | 计为已交付基础，不归零 |
| 可复用能力 | task inventory、agent activity、interaction/turn history、typed lineage、公开提交结果、task grant、GET/SSE、共享 carrier | 以原 owner 为事实源，补组合与缺失事实 |

基线依据为当前仓库 `AGENTS.md`、需求文件、`note.md` 顶部实际交付记录，以及：

- `docs/ui/shared-layout-and-features-2026-10-20.md`
- `docs/ui/design-review-2026-10-19/implementation-gap-2026-10-20.md`
- 同目录 `index.html` 的五板块、关系、focus、审批和移动布局设计片段
- `/Volumes/Intel/playground/humanagent/.worker-runs/ui-layout-modules-20261020/` 下的 `delivery.md`、`acceptance-summary.md`、`cleanup.md`、`review-findings-final.json`

这些安装与运行结论属于前轮历史证据。本轮没有重新观察当前运行实例。旧 gap 报告早于共享模板最终交付，其关于旧壳和布局基础的描述不能直接当作当前缺陷。

## 2. 已确认事实、假设与待验证项

| 类型 | 本轮结论 | 后续动作及影响范围 |
|---|---|---|
| 已确认源码事实 | `service.ts` 的 `dashboardFromSnapshots()` 仍将所有非空 `task.input` 投影为 `source: 'human'`，并用 task 更新时间作为输入接收时间 | 修真实来源链；不得只换标签或从 input 内容猜人类 |
| 已确认源码事实 | `taskDetail()` 仍从 `task.output` 构造 investigation/output，且 `requiredDecisions: []` | 统一公开结果读路径；核实决策来源和消费者。不能据此断言 runtime 审批必坏 |
| 已确认架构事实 | 三模板、静态 ESM、页面 controller、共享 carrier 已存在 | 局部增加组合模块，不建设新框架 |
| 历史有效证据 | 前轮已证明模板接线、部分公开消费者、安装后原结果可读及资源收口 | 复用未受影响结论；不重复整个八页验收 |
| 待验证 | 五板块分别能否枚举到真实 interaction/session/instance，哪些历史来源可读 | O1 逐板块定位来源及缺失，不能将 role 直接当 runtime 身份 |
| 待验证 | 来源事实是否已在既有记录中完整保存，或需要在正式入口补录 | O1 给出最早缺失点；只补唯一 domain/runtime/journal owner |
| 待验证 | grant、Attention、TaskInputRequest 等既有控制事实如何形成可展示问题及恢复入口 | O2 逐一对应实际控制对象，不能把不同等待合并 |
| 待验证 | 真实批准后是否沿既有 release/恢复路径继续，关闭是否误写决定 | 后续受控公开行为验证；观察阶段不提交控制 |
| 假设，尚未成立 | 空决策投影可能只是展示缺口，也可能与恢复链缺边并存 | O2 区分。展示修复不得掩盖实际恢复失败 |
| 待验证 | 各入口是否已出现用户可见的错误结果、串身份或错误关系 | 使用精确目标的现有记录核对；未观察到不能写成已发生事故 |

缺失的来源和关系显示为明确 unknown/unavailable。它们不能冒充 Live、人类消息或关系边，也不能成为永久取消完整目标的理由。每个缺口须有补录 owner、公开验收和恢复条件。

## 3. 既有 DAG 检查与最小修订范围

本轮已读取下列图的输入、节点、边、输出及相关 binding。以下是只读结构检查，不是运行 gate 或行为通过证明。

| 图 | 现有闭合与 SESE | 当前目标的具体缺口 | 未来最小修订及唯一职责 |
|---|---|---|---|
| `human-readable-ux-reading` | `view_request → truth → semantic → purpose → necessary → present → present_result`，单入口、单出口，路径闭合 | 未明确五板块/session 组合、消息来源和统一结果在各层的输入输出；binding 部分状态仍是设计记录 | 在现有节点契约中补 source、scope、session、publication 和必要展示条件；不把普通函数展开成节点 |
| `observation-read` | HTTP 入口经任务事实与历史分支，在语义投影处汇合，最终到 `rendered_view`；无孤立分支 | 已覆盖 task 级读取，尚不等于跨板块索引与产品关系；内部 actual execution graph 不能直接充当产品链 | App 组合既有 owner 已读事实；Runtime 保留事实选择；UI 保留投影。新增读接口时才补对应入口契约 |
| `task-grant-control-entry` | 正式导航 → 验证目标 → scoped 提交 → 回执与读回收敛，单入口、单出口 | 声明范围主要是 grant/revoke；没有完整表达“问题呈现、用户决定、执行继续”的产品终点 | 补正式决策目标、决定回执与执行读回契约。等待期间不造回边；后续读取作为新请求 |
| `task-liveness-display` | 打开页面 → dashboard 读取 → liveness → 页面传输事实 → 卡片，终点闭合 | task 级 liveness 不等于板块 Live；审批等待、系统 blocked、failed 与 transport 状态需保持分离 | 补精确 session 归属和真实等待事实；保留页面本地 transport owner |
| `explicit-requirement` | 单入口，两支在 requirement result 汇合，结构闭合 | 图中的 draft/confirm 阶段不能被新 UI 接成第二次新任务确认；本轮不据图名判断现实现是否违规 | 仅在主动介入复用该入口时核对适用契约。新建提交仍一次确认；已有任务变更单独确认 |
| `context-events` | 来源 → normalize → pairing → projector → consume，线性闭合 | 不能为新界面另写逐页 actor 分类器，也不能从 raw 日志重建控制决定 | 复用归一与配对；必需来源先由上游 owner 提供 |
| `memory-curation` | settled checkpoint 到 memory audit result，单入口、单出口 | 记忆候选不是记忆 agent session，不能将候选列表伪装为执行索引 | 读取真实运行来源；不足时补最小 owner 事实，不改记忆业务流程 |

未来先由 G 更新受影响设计、binding 和 gate，再由各任务保留红测，最后实施。图未改变的部分复用，不重建全部 DAG。本轮纯规划不创建业务图，不运行图校验。

## 4. 用户可用增量

不设固定总轮数。每个增量必须形成“真实入口 → 真实读模型或控制路径 → 人可见结果”，并完成标准交付。

| 增量 | 用户能做什么 | 包含的主要 gap | 交付边界 |
|---|---|---|---|
| 首个增量：可信工作入口与阅读 | 从五板块进入真实 Live/历史集合，选择精确 session，阅读真实来源消息和一致的已提交结果；桌面/手机可返回、刷新和继续阅读 | UX01–03、UX05–07、UX10–12 的阅读主线 | 必须接真实数据。空 renderer、fixture 和静态设计均不算交付；来源不足的板块明确未完成，不能宣称五板块能力全齐 |
| 后续增量：关联链与主动介入 | 查看当前任务完整有据链，切换上下游 focus；向当前 Live 目标主动介入，看到正式回执和实际处理结果 | UX04、UX08，补齐 UX05–07、UX11 | 关系与命令分别依赖真实 owner。读取不推进任务；历史不可写 |
| 后续增量：审批恢复与完整收口 | 看到准确审批问题，批准后实际继续；拒绝、关闭、收起和错误恢复语义正确；完整 UX 在各入口一致 | UX09，并关闭前述增量保留项 | 审批链可在首个增量开发期间并行推进，依赖满足即接入，不为阶段名称等待 |

首个增量不替代完整目标。审批若已具备事实及恢复基础，应随最早完整可交付增量交付。若审批存在 runtime 缺口，只停审批下游，可信阅读仍可交付。

## 5. 最小接口与状态边界

沿用三模板、静态 ESM 和现有组件。允许少量职责明确的普通模块，不增加 registry、eventbus、全局 store、平行持久库、兼容 fallback 或身份包装。

C 负责将下表落实为最小类型。表中名称是拟定接口语义，须优先复用仓库同义类型，不能机械新增全部类型。

| 契约 | 必需语义 | 禁止推断 |
|---|---|---|
| 精确引用 | 判别 interaction/session/execution instance；携带已有真实 ID、必要 task 关联和 project/mode 读取范围。board 只是展示分类 | 不把 taskId、sessionId、instanceId 混成一个字符串身份 |
| 板块索引 | 一个真实条目集合供左卡和 board dashboard 共用；Live、历史和未知按既有权威状态分类 | 不用 updatedAt、role 名或是否存在流连接判断 Live |
| 消息 | 已有 event ref、actor/source、原发生时间、正文、适用目标及证据引用；缺少字段保持缺失或显式未知 | 不用 `task.input` 推断 human，不用 task 更新时间代替消息时间 |
| 关系 | 精确 source/target refs、关系种类、对应权威来源；节点按精确引用去重 | 不用标题、邻近时间、固定角色顺序或成员关系补边 |
| 公开结果 | 复用公开提交 projection 的 state、commits、正文和引用；保留 pending/unknown 时已有确认内容 | 不以 provider 文本、`task.output` 或最新任意 checkpoint 代替已提交结果 |
| 待决定事项 | 精确 decision/control target、问题、允许动作、当前状态、revision、适用授权和恢复责任 | 不将 blocked 自动变成等待人，不为没有 question/options 的对象伪造审批 |
| 主动介入 | 精确目标和语义动作；principal 由 server 解析，权限由正式控制 owner 判断；返回既有 typed receipt | 不接受 UI 自报最高权限，不把所有文本当 steer 或新建任务 |
| 位置选择 | board、Live/历史、精确 focus ref、读取 scope；沿 URL/history 保存 | 不保存或恢复授权状态，不因刷新重提决定或重启任务 |

App 只组合既有事实。若来源缺失，D 在最早正式输入/运行入口及其既有持久 owner 补录；App 不建来源数据库。旧记录不得回填成已确认 human。

`runtime-shell.js` 只拥有布局和共享 carrier。产品位置逻辑放普通静态模块，由页面 controller 使用。它不是新全局状态库。

## 6. 可直接派发的任务合同

S 表示局部单一机制；M 表示若干明确接口的组合；L 表示跨 owner 的语义或真实行为闭环。它们表示相对复杂度，不表示完成比例。

所有执行任务共同禁止：修改需求、无关 Provider/DSH、RCC 配置、用户数据和他人资源；新增状态库或绕正式权限。表中未列入 allowed 的文件均禁止写入。测试文件同样实行唯一 writer。

| ID / 工作量 | 依赖、并发组 | 唯一 owner 与 allowed paths | 明确 forbidden paths | 具体交付物与公开入口验收 | 停止与恢复条件 |
|---|---|---|---|---|---|
| O1 / M 来源观察 | 首发，观察组 | 只读 `service.ts` 的 inventory/recentInputs、`agent-activity-read.ts`、`turn-history.ts`，及它们直接引用的 intake/runtime/journal 来源 | 所有产品写入、测试执行、业务调用 | 五板块来源矩阵；actor/time 最早缺失点；精确 refs、已有公开读取入口、D 所需文件清单。只查这些未知 | 找到来源或最早缺失点即返回；不可枚举项列具体缺口，不继续整仓搜索 |
| O2 / M 审批观察 | 首发，观察组，与 O1 并行 | 只读 server grant/release 路径、service 控制目标与恢复方法、其直接关联的 Attention/input-request/grant owner 及现有消费者 | 同 O1；不得批准、拒绝或恢复用户任务 | 控制对象分类、正式接口、receipt/readback/继续执行链、真实验证方案；区分已证实与假设 | 来源断边时报告首个断点及 D/C 所需字段；不凭空判 runtime 故障 |
| G / M 图与接口设计落地 | 首发，设计组 | 本计划涉及的 `docs/dagpipe/` 图及对应 semantic/binding；本次 run 的接口与测试映射文档；确需修改时仅相应 gate 文件 | 产品实现、需求文件、无关图/gate | 落实第3、5节；受影响图设计及校验回执；细化观测返回的 owner 文件清单 | 语义未知只留相关字段待定；其余接口可先交。不得为未知制造来源 |
| C / M 类型唯一 writer | G；接口组 | `packages/contracts/src/` 中本次最小契约文件及 `index.ts`；`packages/ui/contracts/runtime.ts`；其对应 contracts 测试 | runtime、App、UI renderer、共享样式 | 可被后续任务导入的类型和负向断言；不新增可选框架。首批 refs/索引/消息/结果先交，决策字段待 O2 后补 | 新事实来源未定时不定义伪字段；只停相关契约，其他契约先完成 |
| D / L 权威事实与恢复 | O1/O2、G、C 对应契约；事实组 | runtime/core/jsonl 中经 O1/O2 列明的最早来源和现有持久 owner 文件；对应新小模块及 focused tests。由 D 独占该文件清单 | App 拼装、UI、contracts；无关 runtime | 补必需 actor/来源/目标关联；审批若确有 runtime 缺边则修正式继续路径。真实 owner 重读可得到同一事实 | 若已有事实足够，只交证据、不改代码；新增范围先交 owner 清单供编排者确认，不扩成架构重写 |
| A1 / M 板块与 session 组合 | C 阅读契约、O1；App 模块组 | 新 `packages/app/src/ui-runtime/product-session-read.ts` 及专属消费者测试；只从既有 decoder/reader 接收事实 | `service.ts`、`server.ts`、contracts、runtime | 可枚举板块/Live/历史，精确 session 与消息组合；同一读结果驱动卡片和集合，跨 scope 不串 | 某来源缺失只停该类事实接入，保留明确缺口与 D 依赖 |
| A2 / M 公开结果统一 | G、C 结果契约；App 模块组，与 A1 并行 | 新 `packages/app/src/ui-runtime/product-output-read.ts` 及专属消费者测试；复用既有 publication reader | `service.ts`、`server.ts`、runtime、contracts | 结果选择纯组合；task detail/dashboard/semantic/observation 对同一 binding 保持提交正文与引用一致 | 绑定无法确认时显式 unknown，不读取另一任务或未提交文本 |
| S / L App 统一接线 writer | C；按 A1/A2/D 交付分批接入 | 仅 `packages/app/src/ui-runtime/service.ts`；该文件本次接线的单一测试文件 | `server.ts`、contracts、UI、domain 持久化 | 挂接真实板块、session、来源、结果、决策组合；移除错误 human 投影和 detail 结果旁路；公开 service consumer 可读 | 缺上游方法时只停对应接线；不能自建第二事实源。不得接管 A1/A2 代码 |
| H / M HTTP 与正式动作 writer | C、O2；HTTP组，可与 S 的非依赖工作并行 | `packages/app/src/ui-runtime/server.ts`、`docs/ui/runtime-api.js`、本次 HTTP 消费者测试 | `service.ts`、runtime、contracts、页面 | 最少公开读取入口；正式 principal/target/scope 校验；复用 grant/release 与正式决定/介入接口。UI 无法自报 authority | 不存在正式运行接口时依赖 D；不加前端捷径。server 最终行为测试须等 S 对应接线 |
| U1 / M 集合与位置模块 | G、C 阅读契约；UI模块组 | 新 `docs/ui/product-board-view.js`、`docs/ui/product-location.js`，专属模块消费者 | shell、CSS、页面 controller、API、其他 renderer | 五板块与 Live/历史 renderer；URL 编解码、层级返回、popstate；精确引用贯穿 | 可先局部开发；fixture 只算模块证据，接入 S/H 前不可报产品完成 |
| U2 / M 人读 session 模块 | G、C 消息/结果契约；UI模块组，与 U1 并行 | 新 `docs/ui/product-session-view.js`，专属模块消费者；复用现有交互正文能力 | shell、CSS、controller、API、其他现有组件 | actor/source/time/content/已提交结果阅读；无结果不画空块；诊断按需 | 缺来源不显示 human；缺私有推理不阻断公开消息阅读 |
| W0 / M 共享壳唯一 writer | G、C位置/阅读接口；与页面组并行准备 | 仅 `docs/ui/runtime-shell.js`、`docs/ui/runtime.css` 及共享壳专属消费者；首批先交模板扩展公共接口和样式约定 | 页面controller、API、App、contracts、新renderer内部 | 在既有三模板中组合板块/中心/关联层、贴边配置及单抽屉；稳定接口交出即允许页面并发，不等待W0全部结束 | 只串行真正共享文件；不得接管页面业务或新建全局store |
| W1 / M 板块首页接线 | W0首批公共接口、U1/U2；S/H对应真实读取 | 仅 `docs/ui/dashboard.js`、`docs/ui/dashboard.html` 及该页专属消费者 | W0共享文件、其他页面、App、API、renderer内部 | 五板块同集合卡片与Live/历史首页，进入精确session；删除重复顶级新建导航和内部说明的页面接线 | 只等待对应读取接口；其他页面不等W1。无真实数据不可报产品完成 |
| W2 / M 任务focus接线 | W0首批公共接口、U1/U2；S/H对应读取；R/I按各自交付补入 | 仅 `docs/ui/task-dashboard.js`、`docs/ui/task-dashboard.html` 及该页专属消费者 | 同W1 | 真实focus中心、关联跳转、已提交结果与原checkpoint/历史/授权整合；保留精确scope与关闭时序 | 关系/控制未ready不阻止已有阅读接线；不得伪造边或决定 |
| W3 / M 交互任务页接线 | W0首批公共接口、U2；S/H对应能力 | 仅 `docs/ui/task.js`、`docs/ui/task.html` 及该页专属消费者 | 同W1 | 当前交互session与人读来源消息；一次确认、澄清、错误保输入和结果一致 | 现有身份与FIFO行为必须保留；所需字段缺失交S/D |
| W4 / M 新建与交互入口接线 | W0首批公共接口、U1/U2；S/H对应能力 | 仅 `docs/ui/entry.js`、`docs/ui/index.html` 及该页专属消费者 | 同W1 | 新任务操作归入交互主线，保留原一次提交和草稿/回退；已有任务不因导航重新创建 | 不将执行调度选项误当用户选择的任务语义类型；缺真实控制接口只停对应动作 |
| W5 / M 记忆板块接线 | W0首批公共接口、U1/U2；A1/S/H对应记忆事实 | 仅 `docs/ui/memory.js`、`docs/ui/memory.html` 及该页专属消费者 | 同W1；记忆业务owner | 真实记忆agent session与候选审核分层；namespace、正式review、理由/失败保留不变 | 候选不是session；未有运行来源不得用候选列表冒充索引 |
| W6 / M 任务集合与只读入口衔接 | W0首批公共接口、U1；S/H对应读取 | 仅 `docs/ui/tasks.js`、`docs/ui/tasks.html`、`docs/ui/observation.js`、`docs/ui/observation.html` 及对应专属消费者 | W0共享文件、其他页面、API、App；观测写动作 | 旧项目/任务深链可进入新focus并保留范围；观测继续只读且可返回，无第二套导航状态 | 两页可在分派前按文件拆成两单；一旦派出不得再交重复writer；不扩为重做观测组件 |
| R / M 产品关联链 | C 关系契约、O1、A1；关系组 | 新 `packages/app/src/ui-runtime/product-relations.ts`、`docs/ui/product-relation-view.js` 及专属消费者 | service/server/shell/CSS/controller/contracts | 精确 refs 与有据边投影；链内切 focus、上下游、去重、无依据不补边 | 缺边先分清事实不存在与未记录；需补事实交 D，禁止按标题补齐 |
| I / L 介入与审批 UI | O2、C 决策契约、D/H 对应能力；动作组 | 新 `docs/ui/product-control-view.js` 及专属消费者；对应W页面owner负责挂载，H负责API | shell/CSS/controller/API、App、runtime/contracts | Live 人类介入；直接审批弹窗；批准/拒绝为正式动作，关闭不写决定；可读回执 | 没有精确 target、principal 或正式入口时禁提交，明确依赖；不影响阅读 |
| V / L 作者公开行为验收 | 对应完整增量接线完成；验收组 | 仅本次专属验收文件和 run evidence；可复用既有 runner | 产品源文件、旧断言放宽、用户业务操作 | 按第8节完成真实入口、receipt、双端及负例；发现问题交唯一 owner | 任一关键断言失败保留原错，停止相关验收；不得用 review 调试 |
| J / M 集成与交付 | 作者验收、一次整体 Review PASS | 唯一集成分支、标准构建/安装/正式 restart/推送及自有资源记录 | 他人资源、生产无关 daemon、reset/fresh/清控制面、绕 hook | main、安装后公开行为、远端、清理全链回执 | 冲突、push拒绝、CI或安装验收失败停相关交付，保留恢复资源和 owner |

新增模块文件是普通职责拆分。若已有同义模块可直接复用，删除相应新文件安排，将唯一写权交给原 owner；不能同时保留两份实现。

D 的条件式 allowed 清单必须在实施前由 O1/O2 输出具体路径。它不是允许 D 自由修改整个 runtime/core/jsonl。除此之外，任何写权转移都须记录旧 owner 已结束写入和新 owner 接手事实。

派发前把表中的“专属消费者”落实为具体文件。既有大测试脚本若被多个任务使用，指定一个测试writer，其他owner只运行或回传所需改动；不得按测试章节并行写同一文件。D的来源补录和审批恢复若经观察证实文件互不重合，可拆成两个独占子任务；若触及同一owner文件则保持一个writer，不以并发要求强拆。S只做薄接线，复杂组合必须由A1/A2/R等模块先交付，不能再次把全部业务堆回service.ts。

## 7. 首次 dispatch 与后续补位

首次发单不等待新增业务探索，也不派整仓审计：

| 启动顺序 | 任务 | 启动方式 | 首次必须交回 |
|---|---|---|---|
| 同批 | O1 | fresh `codex exec --profile gcm`，只读任务文件输入 | 板块来源矩阵、actor/time 缺失点、精确路径 |
| 同批 | O2 | fresh `codex exec --profile gcm`，只读任务文件输入 | 决定对象与正式继续路径、待验证断言 |
| 同批 | G | fresh `codex exec --profile gcm`，仅文档/gate allowed | 既有图最小修订、可实施接口、测试映射；先交不依赖观察的部分 |
| G 对应图与 gate 完成后 | C | fresh GCM，独占契约写入树 | refs、索引、消息、结果的首批可导入类型 |
| C 首批接口到达后 | A1、A2、U1、U2 | 各自 fresh GCM，分别独占文件与工作树 | 可执行模块及对应红/绿证据 |
| O1/O2 和对应契约到达后 | D、H | 各自 fresh GCM，按具体路径清单执行 | 权威事实/正式动作与 HTTP 边界 |
| C首批接口到达后 | W0 | fresh GCM，与A1/A2/U1/U2并行，先交共享公共接口和样式约定 | 可让页面独立使用的稳定接口；只接共享职责 |
| 对应接口和renderer到达后 | S、W1–W6 | fresh GCM，S独占薄接线；页面按互不重合文件立即并发 | 每次接线的实际消费者结果；页面间不互相等待 |
| 关系、动作接口 ready 后 | R、I | 各自 fresh GCM | 有据关系和正式控制 UI |
| 完整增量可用后 | V；随后整体 Reviewer、J | 作者验证与独立审查分离 | 真实行为 → 审查 → 标准交付 |

补位规则：

1. 每次结果到达，先验收产物，再更新依赖。ready 且有可用执行资源就发，不为填满而制造任务。
2. 先派阻断交付链的下一动作，再派同层独立任务。局部来源或审批阻塞只停真实下游。
3. C可分批交契约，但始终只有一个writer。S、W0各自独占共享文件并及时交首批接口；W1–W6按文件并行，不能把页面工作重新集中到S/W0。页面所需的单个接口已ready即可开工，不等待某组全部完成。
4. 每份派单附本表对应行、接口、具体文件、测试入口、禁止项和停止条件。不能只写“修 UX07”。
5. 观察者找到首个缺失点即返回。执行者须改代码并交可用结果，不能以 READ、探索笔记或“完成”面板计数。
6. 工具参数或 `apply_patch` 格式错误先修任务模板与调用入口。无产物的重复派发不计推进；确认无生产力后收拢该自有 worker，保存证据，以更窄合同续派。
7. GCM 只有本次实际不可用时才按当前 Skill 后备。前轮 AGY 配额错误不构成本轮默认不可用。
8. Planner、Reviewer 沿当前 `codex-orchestrator`：Planner 和 milestone 整体 Review 首选 Gemini 4 medium，实际不可用后用独立 OAuth `gpt-6.1-sol` medium；finding 局部复核按普通 Reviewer 路由。不得用 GCM 代替独立 Review。
9. 不用内置 `spawn_agent`，不继承实现会话，不将 Collab 注册作为执行前置。

## 8. 最小充分验证合同

下表均为未来验证安排。本轮没有执行这些反例，因此新能力的红测和产品行为均为 UNVERIFIED。已有前轮证据只在未受影响范围内复用。

| 验证 | 需求与具体失败模式 | 可执行反例及必须失败的断言 | 失败可能性依据、影响、成本 | 入口与证据 |
|---|---|---|---|---|
| T1 来源真实性 | UX06/07；编排流量被标成人类，消息时间被任务刷新覆盖 | 输入一条真实 agent 来源和一条已认证人类来源；若两者都为 human、actor错配或事件时间变成 updatedAt，断言必须失败 | 硬编码已有源码依据；影响身份与审计正确性；复用输入/history consumer，维护成本中 | 正式输入/派单 owner → 公共 session read → 浏览器消息 |
| T2 板块与身份隔离 | UX02/03；多条 Live 丢失，role混成实例，跨scope串任务 | 两个同名任务、不同 scope/session，以及同任务多个实例；若卡片与 dashboard 集合不一致、串正文或未知被算 Live，必须失败 | 来源组合尚未完成，概率未知；影响选错目标；读模型消费者成本中 | 公共板块/session读取与真实浏览器选择 |
| T3 精确关系 | UX04；按标题、时间或角色伪造边 | 同名无关记录与一组有 typed lineage 的记录并存；若前者出现边，或后者丢失/重复节点，必须失败 | 现有产品链缺口；影响错误理解和控制目标；纯投影成本低，真实来源核对中 | 已有 owner refs → App关系投影 → 链节点切换 |
| T4 导航恢复 | UX05；focus/scope丢失、BFCache空白、读取触发写入 | board→session→关联节点→层级返回→Back/Forward→刷新；若位置/范围错误、正文空白或出现写请求，必须失败 | 历史 BFCache 和晚响应有已记录红测；影响核心阅读；复用浏览器消费者成本中 | 真实页面 URL、网络请求与可见正文；保留既有关闭后晚响应反例 |
| T5 审批实际继续 | UX09；批准仅改UI、等待映射失败、错误目标被release | 受控真实任务进入精确审批点；批准后必须有匹配决定/grant receipt及同目标实际执行进展；无进展、错误scope或直接failed必须失败 | runtime当前是否有缺陷未知；影响任务无法完成和错误授权；需真实受控行为，成本较高但必要 | 正式审批弹窗→接口→权威读回→继续执行→可见结果 |
| T6 拒绝与关闭分离 | UX09；关闭、收起、刷新误拒绝，重复提交 | 关闭/收起后决定写请求必须为零，等待事实不变；明确拒绝才有对应receipt；晚到批准回执不能作用于新focus | 新审批接线的实际风险；影响误控；复用同一审批消费者，增量成本低 | 手机/桌面共享动作组件与正式接口 |
| T7 介入目标和权限 | UX08；UI标签授予权限、指令误建任务或误steer | A/B同时Live，向A介入；B无动作；伪造UI actor不改变server principal；历史不可写；语义动作与receipt一致，否则失败 | 统一入口尚缺；影响错误副作用；复用task授权及动作消费者，成本中 | 已认证页面→正式目标动作→权威receipt与处理结果 |
| T8 结果一致 | UX10；detail展示未提交文本、跨binding取结果、空块 | 同一任务保留“未提交文本≠已提交正文”；比较各入口的commits正文/refs；pending/unknown保留既有提交；无提交不画结果块，否则失败 | 读路径差异已确认；影响交付真实性；复用publication消费者成本中 | task detail/dashboard/semantic/observation及实际产品页面 |
| T9 手机可操作 | UX11；抽屉叠加、输入被遮挡、焦点丢失 | 390×844进入板块、选任务、开关系、换focus、关闭、输入及审批；若双carrier、输入不可达或焦点回错，必须失败 | 历史手机列规则已有红测；影响手机主路径；复用共享carrier消费者成本中 | 真实手机尺寸浏览器及桌面对应路径 |
| T10 主层最小充分 | UX12；删除错误恢复或继续堆机械字段 | 正常/空数据不出现连接、完整性、空块；真实失败主层有原因与有效恢复入口，原code/owner在按需详情保留；任一相反行为失败 | 旧主层文案仍有残留；影响理解与恢复；沿实际页面检查成本低 | 本次改变的页面，不扩成全站文案审计 |
| T11 来源持久性 | D有来源补录时适用；进程内正确但重读丢失 | 正式owner提交后，从既有journal恢复并读取；若actor/目标丢失或旧记录被伪装成人类，必须失败 | 是否需新增持久字段待O1；影响恢复正确性；现有journal consumer增量成本中 | 原持久owner consumer；不建设新存储 |

执行入口按现有项目命令选最小集合：

- 类型：`pnpm build:contracts`，以及 C 受影响的 contracts consumer。
- App/UI：`pnpm build:app`；`pnpm exec tsc -p tests/ui/tsconfig.json` 后执行受影响的编译消费者。
- 任务 inventory：`pnpm exec tsc -p tests/runtime/ui-runtime/task-inventory.tsconfig.json`，再执行 `dist/task-inventory/tests/runtime/ui-runtime/task-inventory-public-consumer.test.js`。
- 浏览器优先复用 `tests/ui/entry-flow-browser.mjs`、`interaction-page-wiring-browser.mjs`、`agent-activity-navigation-consumer.test.mjs`、`checkpoint-dashboard-navigation-consumer.test.mjs` 等受影响消费者。各 worker 从脚本现有参数读取实际调用方法，不猜参数。
- 授权优先复用 `tests/app/task-grant-http-public-consumer.test.ts` 及其已有编译入口。
- 图改变后按项目现有 DAG gate 校验一次；不因写笔记或接收产物反复运行。
- D 只有实际修改 core/journal/runtime 时才运行对应 focused consumer。未改 Provider/DSH 不扩跑其完整套件。

新增测试前在任务记录写明上表对应项、具体反例、失败依据、影响及成本。先保留能抓错的 RED，再修唯一 owner。证据充分即停止，不按用例数量扩面。旧通用观测脚本的历史失败不得冒充本轮全通过。

真实行为按 `docs/ui/dashboard-e2e-acceptance.md` 保存 receipt。只读展示优先复用现有真实任务；输入、审批和控制变更必须有本次受控操作与实际结果，fixture不能代替。不得为展示而重跑用户原任务。

## 9. Review、交付与资源终点

一个完整且重大可交付增量完成作者自检、focused tests和适用黑盒后，正式集成前做一次整体独立 Review。范围覆盖该增量完整功能与架构。页面、模块、节点和内部小修不单独触发 Review。finding修复后只补受影响验证和该finding复核。

每个实质增量沿项目已授权流程收口：

1. fetch最新 `origin/main`，组合到唯一集成分支，补受影响验证。
2. 作者公开行为通过，完成整体独立 Review。
3. 正常候选提交并合入main。
4. canonical main重建、打包和全局安装。
5. 只用正式 `humanagent restart`。保留原control root、workspace、配对和用户任务。
6. 验证安装后的真实入口、结果及本增量控制行为。
7. push `origin/main`，核对远端回执。
8. 保存证据，清理本任务自有工作树和临时资源。

未来代码树只放 `/Volumes/Intel/playground/humanagent/<task>`。每个写任务独占clean worktree，所有变更经唯一集成分支用标准Git合流。同任务域续派先复用原树；需换树时先提取有效改动和证据，再remove/prune并确认旧路径不存在，随后开新树。不得手工跨树拷贝产品文件。

开工前只做必要存量分类：`MISSING_DIR`、`RECYCLABLE_CLEAN`、`EXTRACT_THEN_CLOSE`、`PROTECTED_HOLD`。保护 `navigation-authorization-20261019`、历史未知owner目录和已有run evidence。dirty、活动或归属不明资源保留并说明；不清他人目录或共享base。

不reset/fresh、不清控制面、不绕hook、不动生产无关daemon。需要结束自有进程时只用正式服务入口或已记录的精确PID。不得执行批量进程终止或tmux server终止。

冲突、push拒绝、CI失败或安装后行为失败，停止受影响交付。记录首次偏离、恢复owner及保留资源。已合入的本地回归按项目正式revert流程处理，不改写main。清理缺失、真实receipt缺失或恢复责任未settled时标记INCOMPLETE，不能以分支提交或Review PASS结束。

## 10. 进度与未知收口

以用户能力为主账，以实际工作量为辅助。每项分别记录：

| 能力 | 语义设计/契约 | 实现 | 公开行为 | 安装交付 | 剩余缺口及owner |
|---|---|---|---|---|---|
| 共享模板和八页基础 | 已有 | 已有 | 前轮有效证据 | 前轮已交付 | 仅记录本次触及部分 |
| 五板块、多Live、历史 | 本计划定义；C/G待落地 | 待执行 | UNVERIFIED | 未交付 | O1/A1/S/U1/W |
| 精确session、人读消息、真实来源 | 已确认错误投影；补录点待查 | 待执行 | UNVERIFIED | 未交付 | O1/C/D/A1/S/U2 |
| 有据关系及导航恢复 | 最小契约已定，来源待核对 | 待执行 | UNVERIFIED | 未交付 | R/U1/W |
| 统一已提交结果 | 读路径差异已确认 | 待执行 | UNVERIFIED | 未交付 | A2/S/U2 |
| 主动人类介入 | 正式动作映射待O2 | 待执行 | UNVERIFIED | 未交付 | D/H/I/W |
| 审批与实际继续 | 展示缺口已确认；runtime行为待验证 | 待执行 | UNVERIFIED | 未交付 | O2/D/S/H/I/V |
| 双端与主层消融 | 共享机制已交付，产品内容待接 | 待执行 | UNVERIFIED | 未交付 | U1/U2/W/I |

不输出无依据总百分比。报告已完成的用户行为、已验收的工作量和剩余关键路径；不能将“类型已写”“fixture通过”或“代码已合”当成用户能力完成。

未知项的终点：

- O1/O2返回来源证据或最早缺失点。
- C/G明确最小必需接口及影响范围。
- D补唯一owner，或以现有事实证明无需改动。
- 下游接线并通过公开行为。
- 仍缺来源的历史记录保留未知；新记录须满足正式来源契约。不能篡改历史来取得通过。

最终必须关闭全部目标：五板块真实索引、多Live/历史、精确session、人读来源消息、完整有据关联链、导航恢复、主动人类介入、审批后继续、结果一致、手机可操作和主层消融。任何保留项列能力、原因、owner和恢复条件，不能被首个增量覆盖。

## 11. 执行入口

执行提示词唯一正文：`ux-product-repair-execution-prompt-2026-10-21.md`。后续编排者读取该提示词和本文后直接执行；本轮不启动产品实施。独立Planner原始建议已保存在上述run目录，不在本文维护第二份执行提示词。


