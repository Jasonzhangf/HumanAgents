# HumanAgent MVP → Milestone 1/2/3 计划

状态：`MVP-IMPLEMENTATION / M1-PREPARATION`
日期：2026-09-13
前置状态：`MVP-IMPLEMENTATION`
唯一目标：先交付一个可独立验证的器官式运行时最小闭环，再按证据逐层扩大到真实 DSH、长程耐久和可交付运行时。

## 1. 规划结论

MVP 不接 DSH provider，但必须先建立最小 HumanAgent Cordis Host 和固定 Harness plugin tree；用 deterministic/fake provider 验证插件 seam 和生命周期。

MVP 使用确定性的 fake Agent Driver，证明 HumanAgent 自己拥有并正确执行：

```text
start
  → checkpoint recall
  → bounded working window
  → one cycle
  → foreground/background error policy
  → checkpoint completion
  → continue / wait / steer
```

DSH 从 Milestone 1 开始接入。原因：如果 MVP 直接依赖 DSH，生命周期、持久化、停止和错误策略无法区分是 HumanAgent 真实能力还是 DSH 偶然行为；先用 fake backend 收口高层协议，才能独立验收 adapter。

## 2. 范围总览

| 阶段 | 交付主题 | 运行形态 | 核心新增证据 | 明确不做 |
|---|---|---|---|---|
| MVP | 单器官最小纵切面 + 显式 Brain 交互与任务 I/O | HumanAgent Cordis Host + fixed Harness Kernel + fake Agent Driver + Agent Template Loader + deterministic Memory Operations Backend + Task List/Dashboard/Task Detail/Task Dashboard + Operator Console | Journal replay、checkpoint recall/completion、steer 收拢、错误策略、输入理解确认、任务输入输出、WorkResult、skill review、基础自诊断、模板/插件校验、Memory context injection 和阶段故障闭环 | DSH provider、远端 provider、向量/RAG、并发多器官、SQLite、完整产品 UI、生产插件签名 |
| Milestone 1 | 真实执行后端、RCC Provider adapter 和 DSH Cordis bridge | standalone HumanAgent Cordis Host + 独立 DSH profile + `cc`/`goaichat` protocol adapters + DSH Agent Driver | clean DSH 版本绑定、RCC v3 `4444` readiness、Responses/Anthropic 分离、专用 profile/plugin 安装、真实同入口 start/resume/stop、Session Log 证据分离、provider 意外闭环、每个小阶段 Astra receipt | 长程压缩策略、生产部署、多租户、多 provider 路由 |
| Milestone 2 | 长程耐久、恢复和插件状态持久化 | daemon/worker 可重启运行 | 崩溃恢复、Index 重建、历史压缩/归档、监督恢复、有限重试、template/plugin snapshot 恢复 | 多节点调度、完整产品 UI、跨租户治理 |
| Milestone 3 | 可交付运行时 | 可部署、多任务、多器官、多 profile | 真实入口、并发/背压、安全、可观测、插件发布/签名/回滚证据 | 未经验证的跨节点一致性和无限规模承诺 |

## 3. MVP 收口计划

### 3.1 MVP 目标

MVP 完成 iff 一个全新的本地实例可以在不依赖 DSH 的情况下：

1. 创建一个 Organ 和一个 Task。
2. 由显式 Brain 接收一条 notification/人类输入，先完成任务匹配、状态查询、意图询问和整理反馈。
3. 在用户确认前只保存显式层交互草稿，不创建后台流水线；确认后才形成 `RequirementEnvelope` 并按 FIFO 写入 `RequirementInbox`。
4. 支持追加已有任务、变更已有任务、创建新任务和只查询状态四种意图；只查询状态不形成后台需求。
5. 由隐式 Brain 将已确认需求分类到至少两个独立工作队列，能够关联并更新一个运行中 Task。
6. 在资源完整时创建 Task Pipeline；资源不足时进入带条件的 waiting，而不是创建半成品执行链。
7. 从无历史进入第一个 cycle。
8. 写入可校验的 JSONL Organ Journal。
9. 在 cycle 开始执行 checkpoint recall，生成有界 Working Window。
10. 驱动一次成功的 fake execution。
11. 在 cycle 结束执行 checkpoint completion。
12. 重启 runtime 后从最新 checkpoint 恢复，而不是从内存猜测状态。
13. 处理一次后台 operation failure：保留责任、记录影响、给出下一动作或等待条件。
14. 处理一次显意识错误：先发布 Attention，再收拢当前 cycle。
15. 处理一次 steer race：关闭新操作入口、请求停止、完成 settle、提交 `stopped checkpoint`，拒绝旧 epoch 迟到事件。
16. 通过 replay 复现上述成功和失败路径。
17. 为 Organ 执行确定性的基础健康探针，产出带证据引用和有效期的健康快照；健康判断不读取 debug log 猜测控制状态。
18. 通过显式 Brain Task Detail 提交一次输入、展示匹配/状态/意图/整理反馈，确认后接收一次任务输出和 artifact 引用。
19. 通过 Task List 按“当前运行 / 需要你决策 / 历史任务”高密度展示任务状态；通过 Dashboard 展示状态统计和阶段化总体进度，不用假百分比表达后台完成度。
20. 通过只读 Pipeline Observation 展示节点流水；节点可打开详情、进入子 scope、沿面包屑返回，不能直接消费或修改潜意识。
21. 通过最小 Operator Console 呈现当前状态、checkpoint、Attention、操作结果和 stopped/waiting/blocked，不把错误隐藏成 loading 或成功。
22. 通过标准 Agent Template Loader 为 interaction、orchestration、execution、review、memory 五类 agent 生成隔离的 system prompt、skill/tool allowlist 和 runtime manifest；模板错误、能力越权和版本漂移都显式失败。
23. 每个 MVP 阶段都有 owner、成功出口、waiting/blocked/failed/cancelled 出口、checkpoint/evidence 和下一动作；runtime 意外不会留下无 owner 的 open issue。
24. 通过固定的 Agent Driver 和 Node Orchestrator 协议执行 deterministic/fake agent；模板、Driver、Runtime 和 Harness gate 可分别替换且不会互相冒充。
25. 每个 Task 绑定 memory scope；deterministic Memory Operations Backend 可从 Journal/asset 引用执行 exact/full-text search、inspect、基础 recurrence/novelty 和分层 Agent Context Injection；没有 AI 也能完成基础记忆操作。
26. Memory Interaction Surface 可以查看摘要、按需展开来源、比较记录并 review SkillCandidate；Index 只做可重建投影，候选 Skill 不会绕过用户批准自动入库。

### 3.2 MVP 允许的最小模块

```text
packages/contracts/
packages/core/
packages/runtime/
packages/adapters/jsonl/
packages/adapters/filesystem/
packages/adapters/testing/
packages/agent-templates/
packages/adapters/memory/
packages/app/standalone/
packages/app/cordis-host/
packages/ui/contracts/
packages/ui/projection/
packages/ui/shell/
packages/ui/surfaces/
packages/ui/kit/
```

MVP 不创建 DSH provider、DSH-specific adapter、`adapters/sqlite`、远端 transport、daemon、DSH WebUI 依赖或 DSH-specific 目录；但必须创建最小 `app/cordis-host`，由 Cordis Host 装载固定 Harness Kernel、fake Agent Driver、节点策略、模板、Memory 和 UI plugins。`packages/agent-templates` 只负责本地模板 registry/校验，不加载 DSH plugin。

### 3.3 MVP 实现顺序

| 顺序 | 唯一 owner | 交付条件 | 测试条件 |
|---|---|---|---|
| M0.1 | `contracts` | 固定高层 ID、事件、Operation、Checkpoint、Attention、Window、Health、Task Interaction、Node、Plugin、Agent Driver、Memory Operations 和 Context Injection Port 类型；不引用 DSH/Cordis 类型 | 类型检查；非法版本、错误 ID 作用域、缺失前继关系、无效输入输出契约、未声明 capability 和越权 context 被拒绝 |
| M0.2 | `core` + `agent-templates` | 固定生命周期、epoch fence、steer 权限、错误策略、checkpoint 不变量、健康分类、模板 manifest 校验和能力上限 | 纯函数 focused tests；成功/失败/迟到事件、健康维度聚合、过期快照、模板越权/缺引用/版本漂移正反断言 |
| M0.3 | `adapters/jsonl` | Journal 支持 append、latest、replay、verify；重复提交可判定；不完整尾记录不伪造成功 | 正常写入、重复 seq、断链、尾记录损坏、重启 replay |
| M0.4 | `runtime` | 实现显式输入 → 任务匹配 → 状态查询 → 意图确认 → 整理反馈 → FIFO RequirementInbox → 隐式分类/运行任务更新/资源准入 → fixed Harness nodes，再执行 recall → template-bound Agent Runtime → Agent Driver work → completion、Task 输入输出、Memory context injection 和基础诊断 | 未确认不派发；四种意图；确认后 FIFO；分类队列、运行任务更新、资源不足等待、serial/parallel/review/wait 节点、单 cycle、后台/前台故障、steer race、输入请求、输出交付、Memory unavailable、探针失败、runtime 意外接管 |
| M0.5 | `adapters/testing` + `adapters/memory` | fake Agent Driver 和 deterministic Memory Operations Backend 可确定性地产生 success/tool/error/cancel/late-event/crash、exact/full-text search、inspect、recurrence 和 context attach，并提供可观测 pipeline 节点和各角色 template fixture | 同一输入 replay 结果一致；不得生成“真实 DSH”或虚假 RAG 证据；节点树、template/tool/context digest、issue owner 和 evidence ref 可追溯 |
| M0.6 | `packages/ui` | Task List 驱动任务索引；Dashboard 驱动简洁状态入口；Task Detail 驱动任务输入、调查结果、建议方案、用户选择、skill review 和任务输出；Task Dashboard 驱动各 agent 输入/输出预览和动态摘要入口；`OrganUiProjectionPort` 驱动运行控制，`PipelineObservationProjectionPort` 驱动只读递归观测；内部健康和节点细节走特殊入口 | 实际入口验证三组任务列表、搜索/状态筛选、Dashboard 待处理/正在处理/最近输入/历史、任务详情导航、无须批准时直接继续、需要选择时固定选项+自定义、skill review、Task Dashboard agent cards/drawer、任务观测入口、节点 drawer、递归进入/返回、键盘/焦点、错误可见性、窄宽度和断线状态 |
| M0.7 | `app/cordis-host` + `app/standalone` | Cordis Host 装载 fixed Kernel 和显式列出的 fake/template/memory/ui plugins；本地入口可启动、推进、steer、重启恢复和 replay，并挂载最小 UI | 使用实际入口运行全部 MVP 场景；验证注册顺序、重复 owner/未声明 capability 失败；记录 Journal、checkpoint、attention、context injection 和 UI 状态证据 |
| M0.8 | owner + reviewer | 删除未使用抽象；文档、测试、实现 owner 一致 | 只读 review；无 P0/P1；重跑受影响验证 |

### 3.4 MVP 必须保留的最小数据

MVP 只保留满足恢复和审计的字段：

- `organId`、`taskId`、`cycleId`、`operationId`、`checkpointId`。
- `directiveRevision`、`executionEpoch`、`seq`、`previousCheckpointId`。
- 当前 outcome、恢复状态引用、证据引用、下一动作。
- Operation 的开始/结束/失败/取消结果。
- Attention 的产生、更新、解除状态。
- `RequirementEnvelope` 的来源、归一化结果、FIFO seq、关联线索和 payload 引用。
- 分类队列、资源准入决定、waiting 条件和 Task Pipeline 节点树的状态/证据引用。
- `OrganHealthSnapshot` 的维度状态、测量、`checkedAt`、有效期和 evidence refs。
- Task 输入请求、输入回执、输出状态、结构化结果和 artifact 引用。

原始模型输出和工具大对象写入 filesystem asset，Journal 只保存不可变引用；MVP 不做历史物理压缩，只做有界 Working/Reporting Window。

### 3.5 MVP 关闭门禁

以下条件全部满足才关闭 MVP：

- [ ] `contracts` 与 `core` 完全不依赖 DSH。
- [ ] 显式 Brain 的需求整理和 FIFO 输入有可重放证据；控制命令未混入业务需求队列。
- [ ] 显式 Brain 有任务匹配、状态查询、意图询问和整理反馈；未确认前没有 `RequirementEnvelope`、FIFO 回执或后台 pipeline。
- [ ] 四种意图可区分：追加、变更、新建、只查询；只查询状态不创建后台需求。
- [ ] 隐式 Brain 的分类、运行任务更新和资源准入有独立测试；资源不足进入明确等待条件，不创建半成品 pipeline。
- [ ] Journal 是唯一高层状态真源；runtime 不以内存快照作为恢复依据。
- [ ] 重启后读取最新 checkpoint，能继续或进入明确 waiting/stopped/blocked 状态。
- [ ] steer 完成证据包含 stop operation、资源结果和 stopped checkpoint。
- [ ] 旧 epoch 迟到事件不会推进新 cycle。
- [ ] 后台错误没有造成静默成功或无限重试。
- [ ] 显意识错误在收尾完成前已产生 Attention。
- [ ] 每个 Organ 的基础功能都有确定性 probe；健康快照有 `checkedAt`、有效期和证据引用，不能从 debug log 重建控制状态。
- [ ] 健康状态与运行生命周期状态分离；`waiting + healthy`、`running + degraded` 等组合不会互相覆盖。
- [ ] Task List 能按“当前运行 / 需要你决策 / 历史任务”高密度展示任务；当前运行与决策入口不共用字段；Dashboard 只展示待处理事项、正在处理的任务、最近输入（来自你/来自任务）和历史任务；Task Detail 能展示输入、调查结果、建议方案、用户选择、skill review、输出、artifact 和任务观测入口；Task Dashboard 能展示各 agent 的输入/输出预览和动态过程摘要；不把 task payload 当作控制面。
- [ ] Pipeline Observation 能完整展示每层节点、状态、输入/输出引用和 evidence；drawer/递归返回只读，不提供隐式消费或控制动作。
- [ ] Operator Console 能显示 running、waiting、error、stopped、stale、disconnected；不使用假进度掩盖未知状态。
- [ ] UI 只通过各自的 typed projection/command ports 消费状态或发出命令（Organ、Task Interaction、Pipeline Observation），不直接依赖 Journal、DSH Session 或 DSH WebUI shell。
- [ ] fake replay 与实际 standalone 入口结果一致。
- [ ] 五类 agent 均由标准模板协议启动；模板、skill、tool capability、policy digest 可追溯，不能通过 prompt 或 task customization 越权。
- [ ] Agent Template、Agent Driver、Agent Runtime 和 Harness Node Orchestrator 的 owner/替换边界明确；fake Driver 不伪装成 DSH，策略不能绕过固定 gate。
- [ ] Cordis Host 能按 manifest/依赖装载 fixed Kernel 和 extension plugins；重复 owner、未声明 capability、错误 dispose 和 provider readiness 失败均可见。
- [ ] Memory Operations Backend 可从 Journal/asset 重建基础 Index；Index 删除后可恢复，查询结果带 sourceRef/seq/digest，不能向 Journal 反写状态。
- [ ] Agent Context Injection 只按 scope、role、layer 和 budget 提供可追溯引用；L4 原始详情不自动注入，越权和旧 epoch context 会被拒绝。
- [ ] Memory Interaction Surface 与 Operations Backend 分离；无 AI 时 exact/full-text/inspect/基础比较仍可用，SkillCandidate 必须经过显式 review。
- [ ] 每个阶段和 operation 都有唯一 owner、正常/等待/阻塞/失败/取消收口；每个 open issue 都有下一动作、条件或升级目标。
- [ ] runtime 崩溃、模板失效、资源不足、worker 不完整、review 失败、memory unavailable 和迟到事件都有可重放的闭环证据。
- [ ] Journal 损坏、重复提交和未完成尾记录均显式失败或可安全恢复。
- [ ] 文档、测试和代码的唯一 owner 一致；无未声明 fallback。

MVP 关闭后仍不得宣称 DSH 接通、真实模型可用或生产可部署。

### 3.6 MVP UI brief

- Surface/mode：`operate + read`；不是营销页，不是完整聊天产品。
- Audience：需要观察并控制长程器官的 operator/显意识。
- Primary task：Task List 负责快速回答“当前运行什么、状态如何、哪些需要我决策、历史有哪些”；Dashboard 负责提供简洁状态入口；Task Detail 负责处理具体任务并进入该任务的后台观测；Operator Console 负责运行控制。
- Information hierarchy：Task List 为当前运行 → 需要你决策 → 历史任务；Dashboard 为待处理 → 正在处理 → 最近输入 → 历史任务；Task Detail 为当前状态 → 输入和调查结果 → 建议方案 → 需要你决定 → 任务观测；Operator Console 为运行状态 → Attention/错误 → checkpoint/操作结果。
- Product truth：所有状态来自 `OrganUiProjectionPort`；loading、stale、disconnected、unknown 和 error 必须可见，不得用 shimmer、假进度或折叠摘要掩盖。
- Required states：empty、ready、running、partial、waiting、degraded、error、permission、cancelled、stopped、stale、disconnected；健康摘要另有 healthy/degraded/attention/unhealthy/unknown，不和任务生命周期合并。
- Supported widths：至少验证常规桌面宽度和窄窗口；窄窗口优先保留状态、主动作和错误，不保证所有 inspector 同时展开。
- Incumbent stack：当前未定；MVP 不引入 DSH WebUI shell、第二套 router 或第二套 design system。先使用语义 HTML/CSS 和 `packages/ui/kit` 的最小 owner。
- Evidence：实际 standalone route + 真实 Journal/replay 内容；截图/录屏仅作视觉证据，必须同时保留 command、projection、Journal 和操作结果证据；验证键盘焦点、缩放/重排、暗色模式、错误态、断线态和文案扩展。

### 3.6.1 UI 开案顺序

UI 必须分两道门：

1. **静态交互定义**：先用语义 HTML/CSS/少量 JS 固定区域、阅读顺序、显式/隐式边界、状态、动作、特殊入口和桌面/手机版行为。当前入口包括 [`docs/ui/tasks.html`](../ui/tasks.html)（任务列表第一入口）、[`docs/ui/dashboard.html`](../ui/dashboard.html)（简洁状态入口）、[`docs/ui/task.html`](../ui/task.html)（显式交互与任务输入输出）、[`docs/ui/task-dashboard.html`](../ui/task-dashboard.html)（单任务运行看板）、[`docs/ui/interaction.html`](../ui/interaction.html)（运行控制）和 [`docs/ui/observation.html`](../ui/observation.html)（只读观测）。
2. **视觉设计**：只有交互定义评审通过后，才继续 [`docs/ui/index.html`](../ui/index.html) 的视觉 tokens、排版、色彩、组件和动效；视觉稿不得改变已确认的状态语义和操作权限。

静态交互定义的验收证据：Dashboard 和 Task Detail 的桌面可访问性树、窄窗口布局、卡片和抽屉的键盘 focus、当前路径节点 focus、关闭抽屉后的焦点回收、四段阅读顺序、匹配/状态/意图/整理反馈、未确认不派发、确认后才进入 FIFO、任务输入/输出结果、健康摘要与诊断特殊入口、隐式入口默认收起、停止请求保持 `stopping` 直到后端投影 `stopped`。视觉截图不能单独替代这些证据。

## 4. Milestone 1：真实 DSH 执行后端

### 4.1 目标

在不改变 HumanAgent 既有领域语义、生命周期 owner 和控制真相的前提下，接入一个真实 DSH adapter；允许 M1-1 在 `packages/contracts` 补充协议无关的 Provider-neutral contract，但不得引入 DSH/RCC 类型，完成一条真实执行链：

```text
HumanAgent standalone
  → ExecutionRuntimePort
  → DSH adapter
  → DSH session/agent/tool/model
  → adapter event mapping
  → HumanAgent Journal/checkpoint
```

### 4.2 范围

- 取得可读取的 clean DSH commit 或发布包，锁定最小支持版本。
- 使用方独立安装 DSH；HumanAgent 只执行版本/能力检查，不静默下载、升级或替换 DSH。
- 创建专用 DSH profile，使用 DSH 官方 `dsh plugin --profile <name> add <package>` 流程安装经批准的 HumanAgent execution bundle；不修改用户默认 profile。
- 复核 DSH public entrypoints、session 创建/恢复、事件、工具、取消和 session log。
- 实现 `packages/adapters/provider` 的 binding、协议 codec、provider readiness 和外部 stop/settle 映射；实现 `packages/adapters/dsh` + Cordis bridge 的 session mapping、event mapping、DSH stop controller、evidence reader 和 DSH capability mapping。DSH bridge 消费 Provider readiness，不重复拥有它。
- 将 DSH capability probe 接入 `OrganHealthProbePort`；只报告真实可证明的 session/model/tool/取消能力，不把 DSH debug 状态当健康真相。
- 评估 `dsh-client-ui-primitives`；只有公开版本、MIT license、token 兼容和实际 bundle 证据齐备后，才允许作为 `packages/ui/kit` 的实现依赖。
- 只支持一个 DSH execution profile、两种协议、三个独立且受限的 ProviderBinding（Responses 的 `cc`、`cc-sol` 与 Anthropic 的 `goaichat`）和一个代表性工具。
- 保留 DSH Session Log 为执行证据；不让 DSH session ID 替代高层 ID。
- 真实同入口验证 start、resume、tool result、error、requestStop、settle。
- 关闭和 plugin/profile 变更采用 restart-only 生命周期，不在 active execution 中热换 provider。

### 4.2.1 RCC Provider 适配策略

M1 暂时使用本机 `~/.rcc` 的 RCC v3 `4444` listener，但 RCC 只是一层外部
Provider 入口，不能成为 HumanAgent 的高层状态或配置真源。当前非敏感基线、
协议差异和配置边界见 [`../architecture/provider-adapters.md`](../architecture/provider-adapters.md)。

M1 的最小协议范围是：

| binding | codec | 说明 |
|---|---|---|
| `cc` / `cc-sol` | `responses` | 可以复用 codec；provider/route identity 仍分开锁定 |
| `goaichat` | `anthropic` | 独立 request、stream、tool、error、cancel/settle codec |

适配顺序固定为：

```text
RCC listener/readiness
  → protocol-neutral ProviderAdapterPort
  → Responses / Anthropic codec fixtures
  → fake contract
  → recorded replay
  → real RCC same-entry request
  → DSH profile binding and same-entry execution
```

4444 可连接不等于 Provider 适配完成。无法证明协议、模型绑定、错误语义或
stop/settle 的阶段必须停在 `capability-unavailable`、`health-blocked` 或
`dependency-missing`，不准使用另一个协议或 fake backend 静默替代。

### 4.3 退出条件

- fake backend 和 DSH adapter 共用同一组高层 runtime tests。
- clean DSH 版本证据包含 commit、公开 API、依赖版本和工作树状态。
- 真实入口产生可追溯的高层 checkpoint 与 DSH Session Log 引用。
- DSH cancel 返回不被当作 stopped；实际 settle + stopped checkpoint 成为停止证据。
- DSH 失败向前台显式暴露，后台恢复策略不读取 DSH debug 日志作为控制真相。
- DSH execution detail 可以作为可选 UI panel；HumanAgent Organ Console 仍由 `packages/ui` 拥有。
- Dashboard / Task Detail 可以展示 DSH 执行产生的任务输出，但不能暴露 DSH Session 作为任务身份或控制入口。
- DSH provider 崩溃、plugin 不兼容、transport close 和 stop timeout 都有明确 owner、Attention、settle 和 checkpoint 证据。
- `cc`/`cc-sol` 的 Responses 和 `goaichat` 的 Anthropic 分别有 codec、stream、tool、error、cancel/settle 证据；不得以共用 4444 listener 代替协议验证。
- RCC v3 `4444` 的 listener、协议 readiness、同入口请求和 DSH 绑定分别有证据；配置路径和凭据没有被复制进仓库或 HumanAgent Journal。
- M1-0 至 M1-5 每个小阶段都有独立 Astra PASS receipt；review 失败会回到对应 owner 修复并重验，不跨阶段带病前进。
- 不存在 checkout-relative `src/*` 依赖、静默 fake fallback 或控制字段写入业务 payload。

### 4.4 Milestone 1 不做

不做多 provider 路由策略、多 DSH profile、长程历史压缩、跨进程高可用、额外的 DSH WebUI 产品范围和生产发布；不修改 `~/.rcc`；继承 MVP HumanAgent UI，并只验证一个专用 DSH profile、一个 Cordis bridge、两种协议和三个独立 ProviderBinding（Responses 的 `cc`、`cc-sol` 与 Anthropic 的 `goaichat`）。

### 4.5 Milestone 1 小阶段与 Astra gates

| 阶段 | 唯一 owner 与范围 | 完成 iff | 最小验证/证据 | Astra gate |
|---|---|---|---|---|
| M1-0 | adapter owner；只读 DSH/RCC 能力复核 | public entrypoint、DSH profile、RCC 4444、两种协议和失败矩阵已锁定 | clean DSH commit/tree、listener、非敏感配置摘要、未验证项清单 | `Astra-M1-0` PASS |
| M1-1 | contracts/adapter owner；Provider-neutral port | fake 与未来 DSH/协议 adapter 共享 port；外部身份不泄漏 | 类型检查、identity/protocol 负向测试、binding digest | `Astra-M1-1` PASS |
| M1-2 | `packages/adapters/provider`：Responses/Anthropic codec；`packages/adapters/dsh`：DSH profile/bridge；`packages/app`：组装 | `cc`、`cc-sol`、`goaichat` 三个 ProviderBinding 只能按显式 protocol 加载，DSH bridge 只消费 Provider readiness | codec fixture、readiness、tool/error/cancel contract、profile lock | `Astra-M1-2` PASS |
| M1-3 | DSH mapping owner；session/event/evidence/stop | DSH 事件、Provider 事件、HumanAgent operation/epoch/attention 可追溯 | recorded replay、late-event、cancel≠stopped、settle/checkpoint 测试 | `Astra-M1-3` PASS |
| M1-4 | validation owner；真实同入口 | RCC 4444 直连和 DSH profile 路径均覆盖允许的 start/resume/stop/recovery | fake、recorded、real RCC、real DSH 四层证据；tool/error、transport close、crash/stop timeout、Journal/Session Log 分离 | `Astra-M1-4` PASS |
| M1-5 | integration/release owner；只做收口 | lock、限制、receipt、clean tree 和用户批准的交付范围完整 | 候选复核、文档范围检查、Astra receipt 汇总 | `Astra-M1-5` PASS |

每个阶段都是可重入的：恢复时从最近一个未通过 gate 的阶段继续，已通过且
输入版本未变化的阶段可复用 receipt；源、配置、环境、候选或协议事实变化
时，必须从第一个受影响阶段重新验证，不强制无关阶段全量重跑。

## 5. Milestone 2：长程耐久和恢复

### 5.1 目标

把 MVP/Milestone 1 的单轮闭环扩展为可连续运行、可重启、可压缩、可观察的长程 runtime。

### 5.2 范围

- `adapters/sqlite` Index：从 Journal 投影、分页查询、删除后重建。
- Memory Operations Backend：exact/full-text/vector 分层 Index、source digest 校验、Agent Context Injection 的分页/预算和层级召回。
- Journal segment、资产 digest、引用检查、归档和清理记录。
- checkpoint compaction：保留准确 recovery state，压缩历史细节，不压缩控制真相。
- 进程重启和 crash recovery：未完成 operation、损坏尾记录、重复提交、旧 epoch 事件。
- supervision：operation 级失败、执行实例重建、器官级 attention、有限重试和等待条件。
- plugin/template snapshot：重启后恢复实际加载的版本/digest，不让新插件污染旧 Task 上下文。
- Working/Reporting Window 的容量策略、淘汰、按需 index recall。
- memory context snapshot：记录每次 Agent 注入的 layer、scope、indexVersion、source digest 和省略原因，重启后可复核。
- attention delivery 的持久化状态、重复告警合并和恢复解除。
- 健康快照历史、探针测量窗口、过期处理和基线对比；允许形成 degraded/attention 的可解释原因，但不做无证据的预测性分数。

### 5.3 退出条件

- 删除 Index 后可以仅凭 Journal 重建，查询结果带 seq/asset 引用。
- 删除或升级 Memory Index 后，exact/full-text/可选 vector projection 可重建；历史 context receipt 仍能追溯到 source seq/digest。
- 在写入、提交、停止、压缩和重启边界注入故障，恢复后不伪造完成。
- 历史压缩后 recovery state 可独立读取，引用资产未被提前删除。
- 同一故障达到局部重试上限后进入明确的 recover/wait/blocked/attention 路径，不空转。
- 长程 replay 覆盖多个 cycle、steer、后台故障、前台错误和恢复解除。
- 真实 DSH 入口与 fake replay 保持相同的高层 lifecycle semantics。
- 健康趋势能关联到 operation、checkpoint 和 Attention 证据；诊断历史压缩后仍能重建当前健康结论。
- plugin/profile/template 的更新、移除、依赖失败和 rollback 边界可重放；active runtime 不在半途切换配置。
- memory backend、RAG provider、context layer 策略变更可重放；active Agent 不在半途接收未锁定的 context policy。

### 5.4 Milestone 2 不做

不做跨节点一致性、无限扩展、多租户权限模型、复杂 UI 工作台和未验证的自动迁移。

### 5.5 Milestone 2 小阶段与 Astra gates

| 阶段 | 交付 | 最小验证/证据 | Astra gate |
|---|---|---|---|
| M2-0 | 长程输入、恢复和故障矩阵 | 受影响的 MVP/M1 receipt、输入版本和 owner map | `Astra-M2-0` PASS |
| M2-1 | Index、Journal segment、资产引用和重建 | 删除 Index 后仅凭 Journal 重建、digest/seq 引用校验 | `Astra-M2-1` PASS |
| M2-2 | checkpoint compaction、Working/Reporting Window | recovery state 独立准确、历史压缩不改变控制真相 | `Astra-M2-2` PASS |
| M2-3 | crash recovery、supervision、有限重试和等待 | 写入/提交/停止/重启故障注入、无空转、每个异常有 owner | `Astra-M2-3` PASS |
| M2-4 | template/plugin/memory context snapshot | 版本/digest/context receipt 可重放，旧 Task 不被新配置污染 | `Astra-M2-4` PASS |
| M2-5 | Milestone 2 closeout | 多 cycle replay、真实 DSH/fake 语义一致、clean candidate | `Astra-M2-5` PASS |

## 6. Milestone 3：可交付运行时

### 6.1 目标

形成可部署、可运维、可审计的 HumanAgent runtime；扩展吞吐和任务数量，但不改变高层唯一真源。

### 6.2 范围

- 多 Task/多 Organ 调度；每个任务保留独立 scope、epoch、Journal 和恢复责任。
- 并发限制、背压、资源配额和 operation cancellation；控制面不进入业务 payload。
- standalone/daemon/worker 的正式组装入口和配置 schema。
- HumanAgent/DSH 的独立安装、专用 profile、lock、兼容矩阵和 staged plugin update。
- 安全边界：身份、授权、文件/进程/远端 operation 权限、敏感资产访问。
- 结构化日志、metrics、trace、Attention UI/通知接缝；观测不成为控制真源。
- 多 Organ 健康聚合、能力矩阵、诊断权限和运维告警；聚合层不能替代各 Organ 的自诊断真源。
- 发布包、版本迁移、回滚边界、健康检查和实际安装/启动验证。
- 真实 DSH profile 的能力声明、缺失能力显式失败和兼容矩阵。
- 插件签名/来源、权限范围、依赖 license、安装前校验和失败回滚。

### 6.3 退出条件

- 多任务并发下 Journal scope、operation、epoch 和 checkpoint 不串线。
- 背压和取消在实际入口生效；停止、资源释放和 stopped checkpoint 可追踪。
- 配置错误、能力缺失、权限失败、依赖失败均显式失败，不静默降级。
- 从安装包启动真实入口，完成 start → run → error/attention → steer/stop → restart/replay。
- 发布候选拥有绑定的源版本、依赖、配置、产物、环境和验证报告。
- 从安装包启动 Host，独立连接已安装的 DSH profile，完成 plugin load → ready → run → error/attention → stop → restart/replay。
- 独立 review 通过；未验证能力仍明确列为限制，不升级为产品承诺。

### 6.4 Milestone 3 不做

不默认承诺跨地域高可用、跨节点强一致 Journal、无限吞吐、自动模型切换或未经真实证据支持的自治恢复。

### 6.5 Milestone 3 小阶段与 Astra gates

| 阶段 | 交付 | 最小验证/证据 | Astra gate |
|---|---|---|---|
| M3-0 | 多 Task/多 Organ scope、资源和权限模型 | scope/epoch/Journal 隔离、资源拒绝和控制/业务隔离 | `Astra-M3-0` PASS |
| M3-1 | 并发、背压、取消和正式 Host 入口 | 实际入口下并发限制、背压、释放和 stopped checkpoint | `Astra-M3-1` PASS |
| M3-2 | 安全、插件来源、依赖和配置迁移 | 权限失败、签名/来源、license、安装前校验和回滚 | `Astra-M3-2` PASS |
| M3-3 | metrics、trace、Attention 运维投影 | 观测可追溯但不能成为控制真源，告警 owner 闭环 | `Astra-M3-3` PASS |
| M3-4 | 发布包、安装、启动、升级和回滚 | 从安装包完成 start→run→attention→stop→restart/replay | `Astra-M3-4` PASS |
| M3-5 | Milestone 3 closeout | 兼容矩阵、源/依赖/产物/环境绑定、独立 review 和限制清单 | `Astra-M3-5` PASS |

## 7. 依赖和闸门顺序

### 7.0 子阶段 gate 规则

每个 Milestone 的每个小阶段都必须有独立 owner、输入版本、allowed paths、
正常/等待/阻塞/失败/取消出口、下一动作、focused validation 和 Astra review。
Astra review 必须审查当前候选，不审查口头计划；无 PASS receipt 不得进入下
一小阶段。PASS 不授予 Git、发布或生产权限。

小阶段 gate 是可重入的：阶段完成后保存 receipt、候选 SHA、配置/环境摘要和
验证结果；下一轮先比较这些输入，未变化则复用，变化则从最早受影响阶段
重跑。失败必须保留原始错误和 owner，不能用更晚阶段的绿色结果覆盖。

```text
设计锁定
  ↓
Git/语言/包管理器基线
  ↓
MVP contracts → core → Journal → runtime → fake/memory → Cordis Host → ui projection/shell → standalone
  ↓
MVP closeout review
  ↓
DSH clean baseline + adapter
  ↓
Milestone 1 real replay/stop
  ↓
Index/asset/compaction/restart/supervision
  ↓
Milestone 2 durability review
  ↓
multi-task/resource/security/deployment
  ↓
Milestone 3 delivery review
```

不得跳过前一闸门：

- 没有 MVP Journal/checkpoint 证据，不进入 DSH adapter。
- 没有 clean DSH 基线和真实 stop/resume 证据，不进入长程耐久扩展。
- 没有恢复、压缩、引用完整性证据，不进入多任务和部署。
- review PASS 只说明当前变更通过 review，不自动授权 commit、merge、push、发布或生产变更。

## 8. 当前推进动作

MVP 基线已经进入 `origin/main`；当前只推进 DSH 基线复核和 Milestone 1 准备：

1. 以 [`dsh-baseline.md`](architecture/dsh-baseline.md) 的精确 commit 作为 M1-0 输入。
2. 只读复核 DSH public entrypoints、依赖、Cordis profile、session、工具、取消和持久化能力。
3. 在 adapter 实现前提交 capability matrix、profile/lock 方案和验证用例；任何不确定能力都进入 `capability-unavailable`，不静默 fallback。
4. 未完成 M1-0 和用户批准前，不开始 `packages/adapters/dsh`、Cordis bridge 或真实 provider 运行。

## 9. 计划之外的风险

- DSH clean baseline 已确认；Milestone 1 仍不能提前声称 adapter 或真实执行链已完成。
- 首个语言/包管理器未定；这会影响类型、JSONL、进程和测试入口，但不改变高层分层。
- Journal 的 durability 语义未定；MVP 可先限定本地单进程，但必须把限制写进验收证据。
- 首批 queue taxonomy、Task 关联/更新冲突规则、Pipeline Observation 的节点持久化粒度和 health probe TTL 尚未锁定。
- Host Plugin API、Cordis bridge 的 IPC/同进程形态、DSH profile 目录和 plugin lock/signature 方案尚未锁定。
- “永不停歇”必须保持为责任持续，不是无限重试；每个恢复路径必须有条件、上限和升级目标。
