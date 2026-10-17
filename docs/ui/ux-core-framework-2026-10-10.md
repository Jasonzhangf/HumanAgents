# HumanAgent UX 核心框架

状态：DESIGN-CANDIDATE
注意：本文件仅为设计约束，不代表实现或验收通过。

## 1. 分层模型

本框架将 UX 与交互划分为以下六层（自下而上）：

1. **事实层 (`packages/context-events`)**
   - **输入**：Runtime 原生事件的只读 `Like` 结构化输入（如 `EventRecordLike` 等，见 `docs/architecture/context-events.md` §4 L58–65 的依赖硬约束）。
   - **输出**：Canonical Context Event、配对结果（Pairing），以及冻结投影产物 UI narrative、Memory digest、Compact snapshot。这三类投影产物的语义 owner 是 context-events，见 `context-events.md` §4（L43–48，四件事含“生成投影：UI narrative、Memory digest、Compact snapshot”）、§10.1（L637–649）、§10.2（L651–668）。
   - **唯一 Owner**：Context Events 模块（模块边界与职责见 `context-events.md` §4 L41–48；`AGENTS.md` L22–24 限定 UI/组装侧 owner、L31 限定 Journal 与 DSH Session Log 不得互相冒充）。
   - **禁止事项**：不写 Journal，不提交 checkpoint，不决定 task 完成，不调用 provider（`context-events.md` §4 L50–56）。narrative / digest 的语义只由本层定义，任何下游不得重新生成或重新定义。
2. **投影层 (`packages/ui/projection` + `packages/ui/contracts`)**
   - **输入**：语义 owner（context-events）输出的 typed 结果。
   - **输出**：**消费语义 owner 结果后的展示结构/视角分组**，即视角、排序与展示分组；本层不再次生成或定义 narrative / digest 语义。
   - **唯一 Owner**：UI Projection 模块。narrative / digest 的生成 owner 是 context-events；**Memory digest 不是 UI 独占职责**。
   - **禁止事项**：禁止处理原始 Provider 日志或猜测缺失的关联关系；不拥有运行时状态；不得把本层写成第二个语义 owner（`docs/ui/semantic-observation-audit-2026-10-07.md` L171–173 把 UI projection 限定为语义集合的视角、排序与展示分组）。
3. **组装/API 层 (`packages/app`)**
   - **输入**：投影数据、任务控制请求。
   - **输出**：向前端提供 HTTP/SSE API 组装数据。
   - **唯一 Owner**：App Server (Service/Server 组装)（`AGENTS.md` L23）。
   - **禁止事项**：不拥有领域生命周期状态或调度真源，不包含第二套映射表或投影逻辑。
4. **浏览器壳与共享控件 (`docs/ui/*.js|css`)**
   - **输入**：API 层 HTTP/SSE 载荷数据。
   - **输出**：DOM 渲染、CSS 动画及统一共享的工作卡片界面；数据/事件边与公共保障见 §1.3、§1.4。
   - **唯一 Owner**：前端产品层。
   - **禁止事项**：禁止从 UI 组件自发业务逻辑轮询或猜测；不可读取原始底层事件格式或 DSH 会话。
5. **展示/控制层（4 模式：`current` / `semantic` / `actions` / `raw`）**
   - **输入**：用户的 UI 操作（模式切换）。
   - **输出**：不同粒度和维度的前端视图更新；模式职责见 §1.1。
   - **唯一 Owner**：UI 组件展示逻辑。
   - **禁止事项**：只改变查看选择，绝对不改变底层领域引用、执行状态或产生副作用。
6. **视角层（任务 / 功能实例(agent) / 项目 / 系统概要）**
   - **输入**：同源数据在不同粒度的聚合关联。
   - **输出**：多维度的前端视图切换与下钻呈现；选择与深链边界见 §1.2。
   - **唯一 Owner**：视角视图组件。
   - **禁止事项**：跨视角间禁止状态混淆。角色 frame、目录名等绝不能作为运行时的业务身份。

### 1.1 四模式职责（每模式一句话）

- `current`：只显示当前最新权威编排与有效上下文；旧图不得标为 current，也不隐藏未解决义务。
- `semantic`：显示完整有序的已发布修订演变（why/what、节点/边/阶段增删改、前后关系与 checkpoint/已接受结果证据）；不从当前 overlay 重建旧图，不从 raw 猜修订。
- `actions`：显示实际发生的按时间排序动作（错误、修正、checkpoint 提交、回退、前进及结果）；计划节点不冒充执行，多 attempt 独立。
- `raw`：显示多条原始记录的身份、顺序、scope 与 semantic/action/checkpoint 关联及双向只读链接；仅显式 `raw` 模式或主动证据操作读取，不作语义 fallback。

合同指针：`docs/ui/semantic-observation-audit-2026-10-07.md` §1.1（R1–R1.4，L49–59）与 §8 模式合同表（L259–264）。

### 1.2 视角选择与游标边界

- 导航只拥有 **viewed** mode / revision / checkpoint / cycle / occurrence 等查看选择；runtime **current** refs（执行与上下文当前游标）属于 runtime，两者必须分离显示（`semantic-observation-audit` §8 L266）。
- 历史、未知与矛盾选择必须显式可见：显式 current 与旧 revision 不兼容时显示 mismatch，不把旧图标 current；未知、跨任务、未发布/未提交目标显式失败（同文件 L268、§7 L231）。
- 视角保留真实 scope 与合法深链：semantic node→action→raw 及反向链接保持 project/task/instance/scope，不自行拼接假身份（同文件 §8 L266、F11 L129）。
- 展示偏好只引用既有合同「**有效显式链接 → 保存偏好 → 冷启动 current**」（同文件 L59、L268）；偏好实现属后续 G5–G7，本框架不在此扩做功能设计。

### 1.3 浏览器层最小数据/事件边

单一职责链，合同出处：`docs/goals/semantic-observation-execution-plan-2026-10-08.md` §4 L130–132、§5 L187–190；`semantic-observation-audit` §8.1 L290、§8.2 L300–308。

- **transport 只解码一次**；同一 projection version 的消费者共享同一不可变对象。
- **immutable payload/version 有唯一 owner**；更新产生新引用并保留旧版本内容，未变内容复用既有引用。
- **事件只通知引用**（携必要关联字段），不按页面复制 payload；控件不得根据事件名字猜业务状态。
- **scope 切换隔离旧事件**并拒绝旧订阅；组件卸载必须退订。
- **JS 引用保证与 native Arc 分别适用**：浏览器用只读 JS 共享引用表达该合同；Rust `Arc<T>` 只在真实存在的 native 边界另行验收。**本框架不声称 native 已实现**（`execution-plan` L132）。

### 1.4 共享控件公共保障

- **稳定焦点归还**：drawer 关闭、Escape、重新投影与面包屑返回后，焦点回到稳定的触发节点身份（`docs/ui/interaction-audit-2026-10-02.md` F09 L56）。
- **阅读位置保持**：对话/轨迹切换与重新投影保留各自阅读位置；读历史不抢滚动或焦点，新更新走显式入口（同文件 §4.1 L88）。
- **reduced-motion 静态可读**：减少动态效果下保留可读的静态状态与时间说明，不依赖无限动画（同文件 F10 L57）。
- 验收指针：同文件 §8 验收矩阵 L180–181。

## 2. owner 映射

全局及具体模块的 Owner 边界仅做指针式引用（禁止在此重复复制词汇表、状态枚举、配对表，出现第二真源即属违规）：

- **全局唯一 owner 与硬约束**：参见 [`AGENTS.md`](file:///Volumes/extension/code/humanagent/AGENTS.md) 的「唯一 owner」（L9–24）与「硬约束」（L26–40）。
- **领域事实分类、状态枚举、配对表**：参见 [`context-events.md`](file:///Volumes/extension/code/humanagent/docs/architecture/context-events.md) 的 §6 冻结类型（L90）、§7 Taxonomy 表（L212）、§8 配对契约（L243）、§9 Normalize 契约（L320）。
- **语义投影产物 owner**：UI narrative 见 `context-events.md` §10.1（L637–649）；Memory digest 见 §10.2（L651–668）。UI 侧只做展示结构/视角分组。
- **依赖方向硬约束**：`context-events.md` §4 L58–65（context-events 只依赖 `packages/contracts`；`packages/ui` 不导入 runtime）。

## 3. 状态语义表

状态栏、对话、轨迹的展现内容**只能**由 typed projection（事实投影层）提供的事实构成。

**正向最低内容**（出处：`docs/ui/interaction-audit-2026-10-02.md` F07/F08 L54–55、§4.2 原则 L92–105、§8 验收矩阵 L178–179）：

- **任务业务状态**：与领域生命周期一致的业务状态，不与其他层状态混写。
- **等待对象与等待起点**：等待的是资源、前序任务、定时触发还是人类决定，以及进入该等待的时间。
- **最近业务事件**：最近一次真实业务事件（不以后端连接事件冒充）。
- **同步时间与数据新鲜度**：最近同步时间、`stale`/过期标记。
- **stop settlement**：是否已收拢、是否已有实际副作用结果（`AGENTS.md` L33）。
- **allowedActions**：合法动作只消费原 lifecycle 与 allowedActions 投影，不由 UI 推断或自造。
- **断线/过期**：保留旧内容并显式可见，不显示空列表成功；连接中断不等于任务失败。
- **未知、空态与失败必须区分**；缺数据逐项标「未提供」。
- **Provider terminal/abort 不等于 Harness stop 完成**（`execution-plan` L152）。
- **不复制状态枚举**；枚举真源见 §2 指针。

**禁止项**（保留）：

- 禁止前端自造计数器、虚假百分比、推算时间或随意猜测状态。
- 动画只能表达当前有“活动”（Activity），绝不证明“活性”（Liveness/Connectedness）。
- 绝对不设「超过 N 秒就失败」的假超时判断。

### 3.1 共享卡片最低合同

每个显式大脑/执行/审核/记忆卡片共用状态栏、对话、轨迹与底部操作；最低合同如下（指针式，不在此重定义领域字段）：

- 默认回答四件事：**正在做什么 / 目前得到什么 / 是否需要我决定 / 我能做什么**（`interaction-audit` §4.1 L65）。
- **对话**只含可公开人类内容（用户消息、可公开助手输出、语义进展、决策卡）；技术详情主动展开，不挤占对话（同文件 L80；`interaction-redesign-plan-2026-10-03.md` §3.5 L326）。
- **轨迹** request/result 分开，并消费权威关联（如 `callId`）而非显示顺序或组件嵌套；错误是对应条目的状态（`interaction-audit` F03 L50、L82–84；`redesign-plan` §3.4 L311）。
- **最近摘要不能代替完整分页账本**；分页显示 `hasMore` 与明确缺口（`interaction-audit` F04 L51）。
- **保留阅读位置与新更新入口**；接近末尾才自动跟随（同文件 §4.1 L88）。
- 字段与 producer 真源：`redesign-plan` §3.4 L288–322、§3.5 L324–326。

## 4. 控制层归属

- **观测的只读性**：观测功能仅限只读操作，不消费任务需求，不修改队列，不触发重试（retry）或干预（steer）（`AGENTS.md` L37）。
- **控制命令的 owner**：各类控制命令仍归原 owner 管辖（`packages/core` 及 `packages/runtime` 等权责划分，`AGENTS.md` L11–13）；控制面与业务 payload 分离（`AGENTS.md` L32）。
- **四模式切换**：对 `current` / `semantic` / `actions` / `raw` 的模式切换，只改变前端查看层面的选择，不改动领域引用或改变任何执行状态（职责见 §1.1，合同见 `semantic-observation-audit` §8 L259–266）。

## 5. re-baseline 章节

对照对象：`docs/ui/interaction-redesign-plan-2026-10-03.md` 的 §2（L23–47）、§3.1–§3.5（L53–326）、§5（L375–388）与 main@`300e710` 现状。

**证据类型**：每项给「基线文件路径:行号 + 该行证明的行为」，或绑定基线的只读命令与输出。**结论分类**：`可复用（类型/接口）`、`已过期`、`待重新验证`。**接口存在不证明真实消费边已接通**；消费/行为证据不足的一律标 `待重新验证`。

### 5.1 §2 Owner、共享 contract 先行与对象流（原 L23–47）

| 对照项（原行） | 基线证据（路径:行 + 行为） | 结论 |
| --- | --- | --- |
| 共享 contract 先行：W1 四文件先定稿共享导出（L25） | `packages/contracts/src/explicit-brain.ts:310` 定义 `ExecutionPolicyDefinition`、`:360` 定义 `SubscriptionControlRequest` 判别联合、`:387`/`:395`/`:420`/`:439`/`:461` 定义草稿修订、输入、preview receipt 与 final submit；`packages/contracts/src/tool-execution.ts:465` 定义 `TaskVerificationResult`、`:479` 定义 `ServeTaskTerminalReceipt`；`packages/contracts/src/framework.ts:217` 定义 `AgentMessageEnvelope`（关联 envelope）；共享导出面见 `packages/contracts/src/index.ts:1655` `export * from './framework.js'`、`:1656` `export * from './explicit-brain.js'`、`:1658` `export * from './tool-execution.js'`（W1 四文件中 `index.ts` 的真实再导出行） | 可复用（类型/接口）；真实消费待重新验证 |
| core 新增 draft invariant 与 subscription，并由 `packages/core/src/index.ts` 暴露（L31） | `packages/core/src/draft-revision.ts:144` `createDraftRevision`、`:229` `refineDraftRevision`、`:330` `assertDraftRevisionCurrent`；`packages/core/src/subscription.ts:262` `decideSubscriptionControl`；`packages/core/src/index.ts:14` 与 `:15` 分别 `export * from './draft-revision.js'` 与 `'./subscription.js'` | 可复用（类型/接口） |
| runtime 新增 `packages/runtime/src/explicit-brain/scheduler-patrol.ts`（L32、L351、L398） | 基线 `ls packages/runtime/src/explicit-brain/scheduler-patrol.ts` → `No such file or directory`；`docs/dagpipe/scheduled-occurrence.graph.binding.json` 的 `scheduler_patrol.ablationFollowUp` 记录该重复实现已在 validation-ablation 轮物理删除，唯一 owner 为 `packages/app/src/ui-runtime/scheduler.ts` 的 `UiRuntimeScheduler` | **已过期**，以基线 owner 为准 |
| runtime 消费：intake / router（L32、L37） | `packages/runtime/src/intake/explicit-intake.ts:821` `refineDraft`、`:888` `confirmDraftRevision`；`packages/runtime/src/explicit-brain/router.ts:186` `export class ChannelRouter`、`:651` `export class RequirementSubmissionOwner`、`:1077` `export class ExecutionPolicyCompiler`（文件存在并含路由/提交/策略编译实现） | 可复用（接口）；端到端消费待重新验证 |
| 投影/渲染产品壳（L35） | `packages/ui/projection/runtime.ts:224` `projectRuntimeSemanticObservation`；`packages/ui/contracts/runtime.ts:14` `RuntimeSemanticObservationEnvelope`；`docs/ui/observation.js:12` `import { mountInteractionWorkCard } from './interaction-work-card.js'`、`:364` `document.body.append(drawer)`（浏览器产品壳存在并挂载共享控件） | 可复用（接口）；行为待重新验证 |
| 五条独立对象流与 DAG 绑定（L39–45、§4.1–4.5 L332–373） | `docs/dagpipe/explicit-requirement.graph.binding.json:2` `"graph": "humanagent-explicit-requirement"`、`:32`/`:62` `"productionWiringStatus": "wired"`；`subscription-control.graph.binding.json:2` `"graph": "humanagent-subscription-control"`、`:13` `"implementationStatus": "implemented"`、`:14` `"productionWiringStatus": "wired"`；`scheduled-occurrence.graph.binding.json:2` `"graph": "humanagent-scheduled-occurrence"`、`:73` `publish_occurrence_result` 的 `"implementationStatus": "partial"`；`serve-task.graph.binding.json:2` `"graph": "humanagent-serve-task"`、`:29` `"implementationStatus": "implemented"`；`observation-read.graph.binding.json:2` `"graph": "humanagent-observation-read"`、`:37`/`:38` `"ownerPath"/"ownerRel": "docs/ui/observation.js"`。绑定内的 `implementationStatus`/`productionWiringStatus` 是设计自报 | 可复用（文件存在，已给路径:行定位）；绑定自报状态不等于行为验收 → 待重新验证 |

### 5.2 §3 字段级共享契约（原 §3.1 L53–134 / §3.2 L136–270 / §3.3 L272–284 / §3.4 L286–322 / §3.5 L324–326）

| 子节 | 基线证据（路径:行 + 行为） | 结论 |
| --- | --- | --- |
| §3.1 草稿、preview 与最终提交 | `explicit-brain.ts:387` `DraftRevisionState`、`:389` `DraftRevisionRef`、`:395` `DraftRevision`、`:420` `DraftRevisionInput`、`:439` `DraftPreviewReceipt`、`:461` `FinalSubmit`；`packages/core/src/draft-revision.ts:144`/`:229`/`:303`/`:319`/`:330`/`:356`/`:383` 实现 revision/hash、supersede、exact-submit 与确认不变量；`explicit-intake.ts:821`/`:888` 为会话与确认入口 | 类型/接口可复用；preview→edit/refine→exact submit→persisted plan 的真实消费待重新验证 |
| §3.2 执行策略与 typed control | `explicit-brain.ts:310`/`:340`/`:360` 定义 policy 与按 `action` 区分的 control union、`:899` `validateSubscriptionControlRequest`、`:926` `subscriptionControlRequestFingerprint`；`packages/runtime/src/subscriptions/index.ts:367` `SubscriptionControlPort`；`packages/adapters/jsonl/src/index.ts:431` `transaction` | 类型/接口可复用；控制/claim 线性顺序与「无到期槽位 pause/resume/cancel 立即 durable 生效」待重新验证 |
| §3.3 Occurrence、lease、fencing 与重启 | `packages/core/src/subscription.ts:412` `assertPendingReminderRecoverable`、`:446` `assertOccurrenceClaimFence`、`:460` `assertOccurrenceClaimLease`、`:732`/`:770` 终态 receipt 断言；`packages/runtime/src/subscriptions/index.ts:1049` `schedulerPatrolFromSubscription` | 接口可复用；重启 replay 返回已有 receipt、不重复派发的行为待重新验证 |
| §3.4 Turn、工具、历史、状态与依赖 | `packages/ui/contracts/runtime.ts:161` `RuntimeTaskEventProjection`（含 `seq`/`kind`/`state`/`summary`/`callId`/`toolId`/`arguments`/`evidenceRefs`）；`packages/app/src/ui-runtime/service.ts:708` `observationToolSteps` | 接口可复用；**原 §7 L410「`observationToolSteps()` 仍只筛 `provider.tool`」已过期**：基线 `service.ts:710` 筛 `provider.tool`，且 `:715–718` 同时消费 `provider.tool-result` 并按 `callId` 关联。分页 cursor/replay、秒级时间与「UI 不得重建 call ID」的消费行为待重新验证 |
| §3.5 共享卡片与可访问性 | `docs/ui/interaction-work-card.js:862` `projectObservationWorkCard`、`:1138` `mountInteractionWorkCard` | 接口可复用；drawer 焦点归还、阅读位置与 reduced-motion 行为待重新验证 |

### 5.3 §5 验证消费与验收（checker 真结果，原 L375–388）

| 条款 | 基线证据 | 结论 |
| --- | --- | --- |
| checker 真结果消费顺序 `execute→verify→settle/checkpoint→terminal`（L379–381） | `packages/runtime/src/ui-runtime/task-verification.ts:115` `TaskVerificationBridge`；`packages/runtime/src/gateway/ports.ts:104` `OperationVerifierDecision`、`:120` `OperationVerifierPort`、`:140` `TaskVerificationPort`；`tool-execution.ts:465`/`:479` | 接口可复用；消费边待重新验证 |
| L383 要求「由 `packages/app/src/ui-runtime/index.ts` 组装进 coordinator」 | 基线只读命令 `grep -rn 'new TaskVerificationBridge' packages --include=*.ts` **无命中**（exit 1）；全仓唯一命中在测试 `tests/runtime/ui-runtime/task-verification-identity.test.ts:358` | **消费边 UNVERIFIED**（生产未组装） |
| L383–384 公开 consumer 列表 | `tests/app/ui-runtime.test.ts:734` 首个 `test('ui runtime …')` 用例（`:8`–`:28` 从 `packages/contracts/src/index.js` 导入）；`tests/app/dashboard-e2e/scenarios/aitest.mjs:26` `export const SCENARIO = 'aitest'`、`:39` `export async function runAitestScenario(binding)`；`tests/app/subscription-api.test.ts` **不存在**（`ls` → `No such file or directory`） | 部分已过期/未交付 → 待重新验证 |
| L385 runner cleanup、L386 三类真实命令、L387 AItest receipt | 本任务不执行任何命令 | 待重新验证（不得据设计宣称通过） |
| L388 baseline 不冒充三类 browser 最终验收 | 保留 | 保留 |

### 5.4 R5 补充的 P1（scheduler-recovery）

真源：`docs/ui/scheduler-recovery-design-2026-10-04.md`。

- **busy reminder 无公开恢复出口：OPEN**。指针：同文件 `:20`（结论 1，已用真实 `JsonlOrganJournal` 通过公开 `SubscriptionControlPort.schedule`/`claim` 复现）；owner：唯一 runtime scheduler owner（同文件 `:22`）。
- **未结算执行重复派发：OPEN**。指针：同文件 `:21`（结论 2）；owner 同上（`:22`）。
- R5 source 整体状态：同文件 `:16` 记录 `state=failed`、`failureClass=code_failure`、两个 P1 未通过、source 不获准进入组合。
- 设计记录的 RED 证据绑定候选 `9260f27a91e91a1cc115f2f7f9521fea96a91a52`（同文件 `:10`），**不是** main@`300e710`。
- 同文件 `:23` 记录一个显式 `BLOCKED` 前置（缺可证明的 `ServeTaskConsumerPort` 实现）。基线只读核对显示 `packages/runtime/src/subscriptions/ports.ts:29` 已声明 `ServeTaskConsumerPort`；该前置在当前基线是否解除**未判定**。
- **本轮不宣称这两项已在当前基线复现或已关闭。**

### 5.5 排除项

**AItest / Panda 相关验收：不在本目标验收与 review 范围。**

## 6. UNVERIFIED 章节

基于 `docs/goals/semantic-observation-execution-plan-2026-10-08.md` §7（L234–245）的能力核对现状。§7 实际是六行能力检查，再加一段「不阻断 I1 的后续工作」（L245）；下列第 7 项即该延期段。

1. **当前 authenticated 用户入口**：still-UNVERIFIED（§7 L238）
   - 重新核对方法：验收 owner 通过正式登录/配对入口核对读取权限；历史 `auth.session.missing` 不代表当前状态；不得猜凭据、清权限或重启探测。
2. **Journal 来源与资产可读性**：部分已源码确认；覆盖仍 UNVERIFIED（L239）
   - 重新核对方法：读取现有非敏感 fixture/录制样本，对照 Provider→runtime→replay 字段；核对 output refs 是否可解析。
3. **request/call 唯一性与 late event**：still-UNVERIFIED（L240）
   - 重新核对方法：对照 Responses、Anthropic 录制 replay 与 runtime validator，证明可用关联 key；不能证明则保留 unknown。
4. **可公开的 model/output 边界**：still-UNVERIFIED（L241）
   - 重新核对方法：核对已有 codec、公开输出与 evidence 查询，区分活动提示、公开文本与 commit。
5. **JS/native ARC 边界**：JS 合同可定义；native 适用性 still-UNVERIFIED（L242）
   - 重新核对方法：明确当前进程和语言边界。**若本轮没有 Rust payload 边，标不适用（N/A）并保留后续 native 验收；若涉及 native 边而合同不明，阻断该边**（同 L242）。JS 侧合同见 §1.3。
6. **既有真实 E2E 能力**：runner 与入口存在；当前成功率 still-UNVERIFIED（L243）
   - 重新核对方法：读取场景与 cleanup 合同，确认真实成功/失败/取消断言可执行；实际执行留到组合候选，不在规划阶段发 live Provider 请求。
7. **I1 后续扩展 / 延期项**（项目聚合、Agent 历史、published revision 历史、三模板完整循环、上下文修正 UI、调度漏槽/复杂度风险复现，以及未批准的 DSH/SQLite/RAG/daemon 能力）：**总验收 OPEN；本轮不适用；不阻断 I1 后续工作**（L245）
   - 逐项保留原 owner 与验收指针；不给整组虚构「解除前置阻塞」门槛（原计划未规定这些项必须等 I1 完成才可开展所有工作）。
   - 重新核对方法：按各项原 owner 的公开事实与验收条件逐项核对；无证据保持 UNVERIFIED。

*(无证据必须保持 UNVERIFIED，禁止用旧记忆判定)*

## 7. 缺口与阻塞链

当前挡住下一层功能设计（I2 执行类型/模板、I3 修订与恢复、G5–G7 多视角与偏好）的具体缺口如下。每条只限定其真实影响范围，**不作全局阻塞**：

1. **核心框架层本身仍未完全闭环验证**：阻塞后续功能设计层（I2、I3、G5–G7 均需要该框架层作为共同前提）。
2. **`redesign-plan` 未全量 re-baseline（R5 两项 P1 仍 OPEN）**：影响范围限定为——真实入口：调度公开 consumer 与 occurrence 结果投影；关联：reminder/lease/fencing 与未结算执行；公开输出：occurrence result 投影与恢复态映射；native 适用边按 §6 第 5 项单独判定。只阻塞涉及定时/周期调度与恢复态映射的 UI 控制层设计（`scheduler-recovery-design` L20–23）。
3. **七类 UNVERIFIED 能力**：按 §6 逐项限定——第 1/2/3/4 项阻塞其对应真实入口或公开输出边；第 5 项在无 native 边时判 N/A、涉及 native 且合同不明才阻断该边；第 6 项阻塞真实 E2E 成功率结论；第 7 项保留总验收 OPEN 且**不阻断 I1 后续工作**（`execution-plan` L245）。不得把它们统一成「阻塞端到端验收与验证」的全局结论。
4. **U/N 候选未验收**（`U-shared-observation-300e710-20261010` 与 `N-submit-confirm-300e710-20261010` 两个工作区已建立但尚未完成组合交付与 review 验收）：阻塞统一前端共享观察模块以及任务新提交流的接入与复用。该状态是派单记录的候选状态，不是本文件的验收结论。
