# Checkpoint 恢复与导航 UX 设计（2026-10-11）

状态：**目标设计，尚非生产 UI/API 验收**。本文定义任务详情中的 checkpoint 历史导航、查看历史快照、选择恢复点与纠正 Context 的用户体验。现有 Runtime 有 checkpoint 链、closure/reentry admission 和 task dashboard 的最新 checkpoint 投影；当前 UI 没有 checkpoint 历史列表、历史过滤或用户发起的 checkpoint reentry 页面/API。静态语义观测 Tour 中的回退控件是本地 Mock，不代表真实恢复。

## 1. 用户目标与边界

用户要能回答三个问题：

1. 现在任务的权威执行位置在哪里？
2. 我查看的历史 checkpoint 与现在差在哪里，是否值得从那里重新开始？
3. 选择它之后，哪些外部副作用仍存在、哪些恢复条件或权限阻止继续？

导航与执行恢复是两种不同动作。选择旧 checkpoint 先只切换查看位置；“从此处恢复”必须通过 Runtime admission，在允许时创建新 execution epoch/branch。它不改写旧 checkpoint、不删除后续历史，也不撤销已发生的外部副作用。若目标是修正当前任务的目标、范围或处理方式，必须先提交明确的用户修正；不能把“查看/恢复到旧点”解释成修改任务目标。

此界面是 HumanAgent 自身的任务/恢复面，不嵌入 DSH Session 历史。UI 仅消费 Runtime 投影并提交类型化命令，不直接读取 Journal、Index 或 DSH Session。

## 2. 页面结构与双游标

任务详情增加“执行历史与恢复”面板，顶部固定显示两个并列但语义分明的位置：

| 游标 | 含义 | 变化时的效果 |
|---|---|---|
| **当前执行** (`current`) | Runtime 报告的最新权威 checkpoint/执行 epoch，以及当前恢复责任 | 只由 Runtime 新事实推进；用户不能拖动或用 URL 覆写 |
| **正在查看** (`viewed`) | 当前选中的 checkpoint，用来浏览其 description、Context 快照和证据 | 用户可选择历史点；只改变查看，不改变执行 |

默认打开时两游标指向同一 checkpoint。选择历史项后，顶栏显示“正在查看 CP…；当前执行仍为 CP…”，并提供“回到当前”操作。浏览器前进/后退及复制链接应恢复**查看**位置，不改变 `current`。

目标 URL 在现有 `?task=` 深链上增加 checkpoint 导航参数，例如：

```text
task.html?task=<task-id>&checkpoint=<checkpoint-id>&cycle=<cycle-id>&revision=<directive-revision>&attempt=<execution-epoch>
```

`task` 仍是必需的真实 Task 身份。`checkpoint` 必须由服务端校验属于该 Task；cycle、revision、attempt 是列表过滤/定位提示，不能作为身份或权限证明。未知、跨 Task、已不可读的 ref 显示本地错误状态与回到任务当前视图的链接，不能静默退回到另一个 checkpoint。没有筛选命中时保留筛选并显示空结果及清除入口。

## 3. 历史列表与可独立选择的 description

列表默认按 checkpoint 链逆序，当前执行点固定标识；每一行使用足以判断是否值得打开的纯文字 description，不要求用户先展开 raw event 或 evidence。沿用 `Checkpoint.summary` 作为人读 description，不增加重复字段。它至少交代：已确认的进展、仍有限制/未决问题、下一项需要用户作出的判断，以及该点是否显示有未收拢副作用。

行内摘要信息：

- checkpoint 顺序与 ID；保存时间（经 Runtime 可信来源确认后才显示为“保存于”）；结果状态；
- 所属 cycle、directive revision、execution epoch（界面标签为“执行尝试”）；
- 当前点/正在查看标记；父 checkpoint 链接；
- 简短 description；恢复准入状态及一条明确下一步。

筛选和定位支持 cycle、revision 与 attempt/epoch 的独立过滤及组合过滤。默认不混合不同任务；可查看其他 cycle/revision/attempt，但列表需在行上保留各自身份，不能将 sequence 相同解释为同一版本。筛选只是缩小可见集合，不删除或更改事实。输入筛选后深链也应可复现相同列表范围。

### Description 的信任边界

description 来自已提交 checkpoint 的 `summary`，用于用户决策，不是恢复状态本身，也不代替证据、Operation 状态或权限判定。UI 不从模型原始消息自行拼造“成功”结论。摘要不完整或 projection 尚未映射时显示“描述不可用/待整理”，仍可显示可验证元数据和状态。

当前 `Checkpoint` 契约没有保存时间字段。Context Contract 规定未来由 Runtime/Checkpoint owner 在首次 durable commit 赋可信 UTC 时间，并在幂等重试时保留原值；在可信时间进入公开投影前，不应把 `updatedAt` 或 UI 观察时间冒充保存时间。当前 dashboard snapshot 的 `committedAt` 可回退到 task `updatedAt`，因此不能作为跨 checkpoint 的可信保存时间依据。

## 4. 查看历史点与 Context 纠正

点击历史 checkpoint 只进入只读查看模式。主内容区域展示该点的已提交语义状态：description、outcome、next action、Context View/恢复状态引用及有权限可读的语义证据。原始 Tool/模型正文不是默认历史 Context，也不能因点击 checkpoint 自动塞进下一次执行上下文。

查看页明确显示：

- “历史查看，不会改变当前执行”；
- 该 checkpoint 的 Task/cycle/revision/epoch 身份和 predecessor；
- 当前执行点与被查看点之间是否有后续 checkpoint；
- evidence/Context 内容是已读取、被权限隐藏、缺失还是未知，且给出 owner/下一步。

若用户发现保存的 Context 有误，使用独立的“提交 Context 修正”路径，引用当前 Task 与被查看 checkpoint。确认前展示修正将影响的目标/范围/处理方式。已存在任务的这些字段变化必须单独确认；确认后以追加事实记录修正及来源，不覆写历史 checkpoint。修正是否形成新的 Context View、是否影响恢复 admission，由 Runtime/Context owner 决定。查看历史、筛选历史或复制链接本身不会提交修正。

此交互为目标设计：现有 `Checkpoint.summary` 和 `recoveryStateRef` 可供 Runtime 组装；UI 当前没有历史 checkpoint 查看 API、历史 Context View 查询命令或 Context 修正命令。不要把只存在于静态 Tour 的假数据当成可复用生产入口。

## 5. 选择恢复点与可见反馈

从历史查看模式点击“从此处恢复”后先展示确认摘要：选定 checkpoint、其结果/description、当前执行点、是否另起 epoch，以及已知副作用不会自动撤销。用户确认后，UI 发送带 Task、checkpoint、当前执行 epoch 和确认身份的类型化请求。Runtime 重验 checkpoint 链、当前权限、资源和 operation settle/reconcile 状态；只有 admission 允许时才执行 reentry，并返回新的 epoch/branch receipt。成功后 `current` 指向 Runtime 新报告的位置，`viewed` 跟随新点；旧历史保留。

按钮可用性必须来自 Runtime admission projection，不由 UI 根据 outcome 猜测。至少采用以下结果：

| Runtime 事实 | 用户看到的状态与动作 |
|---|---|
| reentry admitted | 显示“可从此处恢复”；确认后等待操作 receipt，再呈现新 epoch 与入口 |
| 权限已撤销/修订不匹配 | 禁用恢复，说明具体 owner 与重新授权/重新准入的下一步；不得暗中降低权限 |
| 有 pending/unknown Operation | 标出 Operation、效果状态与 reconcile 责任；明确“外部效果可能已发生，尚未确认”，等待 reconcile，不给出虚假的撤销或成功文案 |
| checkpoint/closure 为 `unknown`、保存阶段不完整 | 显示已持久化阶段、首个错误、恢复责任 owner 和恢复引用；保留原事实，不把 unknown 折叠成失败或成功 |
| admission 拒绝或权限 API 返回拒绝 | 原样呈现 typed 拒绝类别、owner、next action；不提交 reentry、不重试控制命令 |
| checkpoint 链损坏、目标 stale 或不存在 | 明确标为不可用并显示可获得的证据/错误引用；不跳到相邻 checkpoint |

任务状态与外部 Operation 状态分开呈现。`committed` 仅表示 checkpoint fact 已 durable；它不代表 closure、operation settle、撤销副作用或可以重入。重入必须使用新 execution epoch；旧 epoch 的迟到结果显示为 stale，不能推进当前游标。

## 6. 现有能力与设计缺口

| 范围 | 已有可复用依据 | 当前边界/缺口 |
|---|---|---|
| Checkpoint 领域字段 | `Checkpoint` 含 scoped ID、scope/cycle、seq/predecessor、directive revision、execution epoch、outcome、summary、recovery/evidence refs 与 next action；契约校验链顺序和 scope | 没有 checkpoint committed-at 字段；没有面向 UI 的完整链查询投影 |
| Closure/reentry | Runtime closure 记录 committed、reentryAllowed、pending/unknown operations、recovery ref、next action；`computeReentryDecision` 将撤权和 unresolved operations 作为阻断；reentry 校验新 epoch 大于旧 epoch | 这些是 Runtime 内部能力/契约，不是公开 UI 历史/选择/恢复 API |
| Task Dashboard | 当前 task projection 有一个最新 checkpoint 的 id、seq、outcome、summary、committedAt | 只有单个最新点；保存时间来源可能回退到 task updatedAt；不承载 revision、cycle、epoch、closure、effects 或 viewed cursor |
| 导航框架 | task 深链已有 `?task=`；Observation 有只读递归 scope、drawer 与 breadcrumb 模式 | task 页面没有 checkpoint 深链参数、跨 revision/cycle/attempt 过滤或独立双游标 |
| 静态 Tour | 展示过 checkpoint/view 游标、历史 revision 深链和“不撤销副作用”提示 | Tour 使用浏览器内 Mock，不连接 Runtime；只用于视觉概念参考，不能作为生产行为证据 |

实现前需由对应 owner 提供一套公开、只读 checkpoint-history projection 与用户确认的 reentry command/receipt。历史读取必须保持只读；恢复命令走 Runtime checkpoint/control owner。UI 不解析 TOML、不读取 Journal、不自建 checkpoint 状态、不执行 stop/retry/steer，不从事件日志推断 admission。Context Contract 中可信保存时间和 durable turn receipt 的要求仍是生产真相边界。

## 7. UX 验收目标（尚未执行）

未来验收围绕真实 Runtime 任务和 receipt，不以静态 Tour 或 mock 控件代替：

1. 从 Task 深链打开当前点；选择不同 cycle、revision、attempt 中的历史点，刷新及浏览器前进/后退仍恢复 `viewed`，且 `current` 不变。
2. 仅阅读 description，用户能辨别每个候选点的进展、限制、未决问题与下一项决策；没有 raw 展开也可做选择。
3. 正确的 checkpoint 深链打开对应历史点；未知/跨 Task/无权限 ref 显示明确错误，不静默替换。
4. 选旧点查看不触发执行；恢复需要确认并产生新 epoch/receipt，旧后续事实仍可浏览。
5. `unknown` Operation、权限撤销、链损坏、保存不完整和拒绝结果都显示 owner/next action；不显示“已撤销”或“已恢复”直到对应 receipt 证明。
6. Context 修正作为独立确认与追加事实出现；不改写 checkpoint/Journal 历史，不将 raw 历史自动加入 Context。

在这些真实入口、公开投影及恢复 receipt 接通前，本设计仍是目标稿，checkpoint 恢复 UX 状态为 **未实现/未验收**。

## 8. 参考

- [Context Contract](../architecture/context-contract.md)：checkpoint description、可信保存时间、durable phase、unknown 与恢复责任。
- [Semantic observation UX audit](evidence/semantic-observation-20261007/ux-audit.md)：UI 不读 Journal/DSH Session、只读观测面与 typed 权限/错误表达。
- [Semantic checkpoint acceptance](evidence/semantic-checkpoints-20261008/acceptance.md)：静态 Tour 中 Mock 回退不撤销副作用，且不代表 Runtime/Provider 验收。
- `packages/contracts/src/index.ts`：Checkpoint shape、checkpoint chain。
- `packages/contracts/src/framework.ts`：CheckpointClosureRecord 与 CheckpointReentryRecord。
- `packages/runtime/src/checkpoints/closure.ts`：reentry decision、unknown operations 阻断与新 epoch 校验。
- `packages/runtime/src/ui-runtime/coordinator.ts`、`packages/ui/contracts/runtime.ts`：当前单点 task dashboard checkpoint projection。
