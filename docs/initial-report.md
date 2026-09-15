# HumanAgent 开案初始报告

> 历史快照说明：本文记录的是 2026-09-11 的开案事实，不能被解释为当前 DSH
> 接入状态。后续真实单 DSH Agent candidate、验证证据和当前收口以
> [`README.md`](../README.md) 与
> [`docs/goals/real-single-dsh-agent-plan.md`](goals/real-single-dsh-agent-plan.md)
> 为准。

日期：2026-09-11  
阶段：`MVP-IMPLEMENTATION / WAVE-2-CLOSED`
报告范围：项目初始化档案、固定 Harness、Cordis 第一层插件宿主、Agent Driver、Agent 模板、Memory 双层系统、DSH 解耦边界，以及已批准 MVP 实现阶段状态

## 1. 结论

项目已进入用户批准的 MVP 实现阶段：Wave 0/1/2 fixed Harness Runtime 已完成并进入 main，Wave 2 通过 commit-bound Astra gate 收口。本文档保留初始开案档案，同时把实现边界和当前证据收敛为“已批准 MVP implementation”，不声称 DSH 已接入。高层采用独立 Organ Runtime，Cordis 是 HumanAgent 的第一层插件宿主，固定 Harness 是不可绕过的编排内核，DSH 只是可替换的 Agent/Execution provider。Memory 由用户交互面、后台 Operations Backend 和受 Harness 控制的 Agent Context Injection 接缝组成。

当前 UI 责任基线已经冻结。Agent 流程、模板/skills/tools、宿主启动、Cordis plugin tree、Memory 分层和生命周期/故障 owner 已分别收口到 [`docs/architecture/agent-flows.md`](architecture/agent-flows.md)、[`docs/architecture/agent-templates.md`](architecture/agent-templates.md)、[`docs/architecture/host-and-cordis.md`](architecture/host-and-cordis.md)、[`docs/architecture/memory-system.md`](architecture/memory-system.md) 和 [`docs/architecture/lifecycle-and-failure-ownership.md`](architecture/lifecycle-and-failure-ownership.md)。

## 2. 目标

构建可长程运行的器官式 Harness：

- 每轮开始执行 checkpoint recall，恢复准确的任务和执行状态。
- 每轮结束执行 checkpoint completion，把状态收拢到可继续、可等待或可交接的位置。
- 后台器官对错误进行分层、局部恢复和受控降级；严重影响即时报告显意识。
- 显意识错误立即反馈，不等后台收尾完成后才暴露。
- `steer` 立即撤销旧执行的继续许可，并执行标准停止 operation；以实际收尾证据判断是否停止完成。
- 历史持续追加，工作上下文和汇报窗口有界，Index 支持按条件检索。
- 每个 Organ 声明基础功能并执行确定性自诊断；健康状态与任务生命周期分离，健康摘要可影响 Attention/降级，原始探针证据只在诊断入口展开。
- Task 必须有独立的输入输出界面：Task List/Dashboard/Task Detail 分别处理任务索引、简洁状态入口、具体任务处理和任务观测；Organ Console 处理运行观察、steer 和后台控制。
- Harness 由固定节点协议组成；节点内部可以替换 serial、parallel、review、wait、reconcile 等编排策略，但不能改变生命周期、权限、checkpoint、review、stop/settle 和错误 owner。
- Agent 通过统一 Template + Agent Driver + Runtime 抽象执行；DSH、native、remote、fake 都是 provider，不上提为领域状态。
- Memory 交互面与 Operations Backend 分离；Index 只做可重建投影；Agent Context Injection 按 L0–L4 分层暴露，基础检索和 inspect 不依赖 AI。

## 3. 非目标

- MVP 当前不实现真实模型调用、DSH plugin、SQLite、vector/RAG 或生产部署能力；确定性 fake/测试执行不属于跳过边界的 DSH 接入。
- 当前不安装、升级或启动真实 DSH；只保留独立安装、专用 profile、Cordis bridge 和失败闭环作为后续 Milestone 边界。
- 不把 DSH SessionEvent、SessionId 或 DSH on-disk format 作为高层领域模型。
- 不为“永不停歇”实现无上限重试；必须有局部上限、换层/等待条件和升级责任。
- 不把降级实现为静默成功、证据缺失的成功或绕过权限/验收。
- 不在 DSH 当前脏 checkout 上开发或清理其未跟踪文件。

## 4. 当前证据

| 项目 | 证据 | 结论 |
|---|---|---|
| 新项目目录 | 初始空目录，已演进为 Git worktree 管理 | 项目已从设计开案进入已批准 MVP 实现 |
| 项目规则 | 本次新增 `AGENTS.md` | 已锁定 owner、边界和首轮门禁 |
| 架构设计 | `docs/architecture/organ-runtime.md` | 高层领域模型、模块和 ports 已整理为设计契约 |
| Agent 模板设计 | `docs/architecture/agent-templates.md` | system prompt、skills、tools、模板版本和 runtime manifest 已分层隔离 |
| 宿主/插件设计 | `docs/architecture/host-and-cordis.md` | HumanAgent Cordis Host、固定 Kernel、可替换 plugin seam、独立启动、DSH provider 和 bridge 边界已定义 |
| Memory 设计 | `docs/architecture/memory-system.md` | Interaction Surface、Operations Backend、可重建 Index、分层 Context Injection 和无 AI 基线已定义 |
| 生命周期/故障设计 | `docs/architecture/lifecycle-and-failure-ownership.md` | 阶段终态、故障 owner、Attention、恢复和提交闸门已定义 |
| 静态界面定义 | `docs/ui/tasks.html`、`dashboard.html`、`task.html`、`task-dashboard.html`、`interaction.html`、`observation.html` | 已分离任务列表、简洁状态入口、显式交互、运行任务看板、运行控制和只读观测；当前 UI 责任基线已冻结 |
| DSH checkout | `/Volumes/extension/code/dsh` 当前 checkout 仍有大量未跟踪生成物；另以 detached worktree 复核上游 `master` | 原 checkout 不作为基线；clean 基线记录在 [`dsh-baseline.md`](architecture/dsh-baseline.md) |
| DSH 基线 | 上游 `master@c291e7961a515f6d7af9304e7fd1d257929aef26`，tree `e482b49bef64726be8f79380bb35bae569dc3c48`，describe `dsh-v0.1.5-rc.2-139-gc291e7961a` | 开案时已锁定源码基线；当时 adapter 和真实入口尚未实现 |
| 实现/测试 | Wave 0/1/2 runtime 代码/测试已存在于 `packages/`、`tests/`；开案时 main 为 `9c2a94364e6e4a86539df38622847f0211909bdb` | 本文只记录开案时 main；DSH candidate 的后续状态见本轮真实单 DSH Agent 计划 |

## 5. 架构收敛

```text
HumanAgent domain
  contracts → core → runtime
       ↑         ↑       ↑
       └── adapters: jsonl / sqlite / filesystem / operations / dsh
                                      ↑
                                    app
```

高层唯一状态链：

```text
directive → task → cycle → operation → checkpoint
                                      ├─ working window
                                      ├─ reporting window
                                      └─ index query
```

DSH 链：

```text
ExecutionRuntimePort
        ↓
DSH adapter
        ↓
DSH agent/session/tool/model APIs
        ↓
DSH Session Log（执行证据，不是高层状态）
```

插件和 Agent 链：

```text
Cordis Host
  → fixed Harness Kernel
  → Node Strategy / Agent Template / Agent Driver plugins
  → Task-scoped Agent Runtime
  → WorkResult / Memory Context / evidence
```

## 6. 首批任务

| 优先级 | 任务 | 完成条件 | 测试/证据 |
|---|---|---|---|
| P0 | 建立 `contracts` 类型和版本策略 | 所有高层 ID、事件、operation、checkpoint、port 类型独立于 DSH | 类型检查；错误版本、重复 seq、非法前继关系负向测试 |
| P0 | 实现 `core` 不变量 | READY、steer、停止收拢、错误升级和 checkpoint 提交规则为纯逻辑 | focused unit tests；每个非法迁移有失败断言 |
| P0 | 定义 Journal 提交协议 | 追加记录、链校验、幂等提交、崩溃后尾记录处理规则明确 | 临时写入中断/重复提交/断链 replay 测试 |
| P1 | 实现 Index projection | Index 只从 Journal 重建，查询结果可追溯到 seq 和资产引用 | 删除 Index 后重建；分页和窗口查询测试 |
| P1 | 实现 fake Agent Driver + deterministic Memory backend | 可驱动 ready、tool、error、cancel、settle、crash；支持 exact/full-text、inspect、recurrence 和 context attach | 全生命周期 replay；不能伪造真实 DSH/RAG 证据；Index 可重建 |
| P1 | 定义 Organ 基础自诊断 | 声明基础功能、typed probe、健康快照和有效期 | healthy/degraded/attention/unhealthy/unknown 聚合；过期、探针失败和证据缺失显式可见 |
| P1 | 定义显式 Brain Task List/Dashboard/Task Detail | 静态 HTML 固定任务索引、总览、阶段进度、任务匹配、状态查询、意图确认、输出、artifact 和任务相关健康摘要 | 桌面/手机版语义树、三组任务列表、搜索/状态筛选、键盘焦点、确认前不派发、确认后进入 FIFO、输出状态切换 |
| P1 | 实现 Agent Template Loader | 五类角色隔离加载 system prompt、skills、tools 和 policy；实例记录 digest | manifest 负向测试；越权、缺引用、版本漂移和跨任务污染被拒绝 |
| P1 | 复核 DSH public entrypoints | 记录 adapter 依赖的实际包、类型、取消和持久化能力 | clean DSH commit + API/source evidence |
| P2 | 实现 DSH adapter | 仅 adapter 依赖 DSH；session ID 映射不越界；失败可见 | fake + recorded replay + 真实同入口验证 |
| P2 | 长程恢复与真实 steer | 重启后 recall，steer 后标准 operation 完成并产生收拢证据 | 进程重启、队列压缩、停止竞态、历史 replay |

## 7. 当前阻塞与开放决定

1. DSH clean 源码 commit 已锁定；仍需在 Milestone 1 复核 public entrypoints、依赖、profile/plugin、取消和持久化能力。
2. 首个实现语言/包管理器已进入 TypeScript + pnpm；runtime 骨架已建立。
3. 需要确定 Journal 记录的校验策略（链 hash、文件 segment、资产 digest 的组合）和 fsync/rename 提交语义。
4. 需要确定 checkpoint 历史保留政策：哪些恢复字段永久保留，哪些原始工具输出可归档或清理。
5. 需要确定第一种 DSH 接入形态：优先评估子进程/IPC，再与同进程 plugin、独立服务比较；这只影响 adapter，不改变高层 port。
6. 远端仓库 [`Jasonzhangf/HumanAgents`](https://github.com/Jasonzhangf/HumanAgents) 已收到当前 main 基线；DSH 适配仍须按 [`dsh-baseline.md`](architecture/dsh-baseline.md) 的 M1 门禁推进。

## 8. MVP 路线

MVP 不接 DSH provider，先用最小 HumanAgent Cordis Host + fixed Harness Kernel + fake Agent Driver + deterministic Memory Operations Backend + 标准 Agent Template Loader + 静态显式 Brain Task List/Dashboard/Task Detail 验证高层生命周期、固定节点、输入理解、任务匹配、意图确认、任务输入输出、分层 Memory Context Injection、基础自诊断、插件/模板校验和状态可见性；页面先完成静态 HTML 交互定义，再进入视觉设计。Milestone 1 接真实 DSH Agent Driver 和 Cordis bridge；Milestone 2 做长程耐久、恢复、可重建 Index、context snapshot、插件/template snapshot 和健康趋势；Milestone 3 做多任务、多器官、资源、安全、远端 Memory provider、插件发布和部署交付。每个阶段都必须有成功/等待/阻塞/失败/取消的闭环和唯一 owner，完整计划见 [`docs/goals/mvp-to-milestones.md`](goals/mvp-to-milestones.md)。

## 9. 当前验收边界

本轮完成 iff：

- 已批准 MVP 的阶段、唯一 owner 和禁止边界已写入项目真源；Wave 2 已通过既有 review、集成到 main 并推送，不能把该事实扩展为 DSH 已接入。
- 高层模块图、生命周期、错误策略、checkpoint/Index 关系和 ports 已写入设计文档。
- 高层领域模型不携带 DSH 类型；所有 DSH 具体依赖集中在 adapter 边界，并明确当前未验证事实。
- 显式 Brain → FIFO 需求入口 → 隐式 Brain 分类/准入 → Pipeline 节点观测链、Organ 自诊断和 Task List/Dashboard/Task Detail 的责任边界已写入设计真源。
- Task List 首页已按“当前运行 / 需要你决策 / 历史任务”收敛为高密度索引；详情页继续负责单任务理解、确认、输出和节点抽屉。
- 输入处理已固定为：先整理输入和调查状态，再形成建议；无需批准的事项直接继续，需要选择时提供固定选项和自定义；Dashboard 不展示内部处理链，Task Detail 提供具体任务处理和任务观测入口。
- Task Detail 主面已收敛为“当前状态 → 输入和调查结果 → 建议方案 → 需要你决定”；任务内部路径、历史和 evidence 通过任务观测/只读抽屉查看。
- `task-dashboard.html` 已固定为单个运行任务的 agent 看板：展示各 agent 输入/输出预览，点击进入动态过程摘要；运行看板不承担用户决策。
- agent 流程已独立收口：交互 agent 负责确认前输入整理和确认后派发，Runtime Coordinator 负责 FIFO 分类/关联/准入，任务编排 agent 负责阶段计划/assignment/推进，执行 agent 负责节点输出，记忆 agent 负责 skill candidate，健康诊断和 steer 走独立控制路径。
- 五类 agent 已收口为统一模板协议：system prompt、skills、tools、policy、input/output schema 分目录隔离，Harness 负责 validate → compile → load，运行实例记录实际 digest。
- 宿主/插件边界已收口：固定编排由 HumanAgent core/runtime 拥有，MVP 使用 fake backend，Milestone 1 计划通过专用 DSH profile + Cordis bridge 接入；插件不能跳过确认、准入、review、memory、health 或 stop gate。
- Cordis 定位已纠正：它是 HumanAgent 第一层插件宿主；固定 Harness Kernel、节点策略、Agent Driver、Memory UI/Backend、Journal/Index 和 UI projection 都通过受控 seam 组装，DSH 只是一个 provider。
- Memory 定位已纠正：交互面和后台操作端分离；Index 可重建；Agent context 通过分层接口注入；无 AI 时基础记忆操作仍可运行。
- 生命周期/故障已收口：每阶段拥有 owner、正常/等待/阻塞/失败/取消出口、证据和下一动作；runtime 意外进入 ManagedIssue/Attention，不留无 owner 的悬挂状态。
- 首批任务拥有可判定的完成条件和证据条件。

本轮不声称：DSH adapter 已接入、真实工具停止完成、崩溃恢复完成、Memory RAG 已接通，或 DSH 的真实 start/resume/stop/replay 已完成；Wave 2 的既有 main、review 和远端推送事实不属于本轮未完成项。
