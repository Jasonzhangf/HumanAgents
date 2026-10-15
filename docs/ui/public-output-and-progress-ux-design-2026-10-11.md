# 用户可见输出与进度反馈 UX 设计

> 当前展示层级与必要性以[面向人的语义分层展示设计](human-readable-layered-ux-design-2026-10-11.md)为准，绑定需求库 v13。字段存在不代表默认要显示；失败、未知、决定与结果的必要内容保持可见。

状态：`DESIGN-CANDIDATE`（2026-10-11）  
范围：定义任务执行期间用户看得到的模型/Agent 输出、计划、活动、结果和停止反馈；不实现 UI 或 Runtime。  
基线：当前工作树只读观察；工作树另有未归属变更，本文件不把它们视为已合并或已验收。

本设计遵守 [`AGENTS.md`](../../AGENTS.md) 的状态与唯一 owner 约束，并沿用 [`ux-core-framework-2026-10-10.md`](ux-core-framework-2026-10-10.md) 和 [`semantic-observation-audit-2026-10-07.md`](semantic-observation-audit-2026-10-07.md) 的只读语义投影模型。此文定义面向用户的呈现契约，不新增运行时状态、事件 taxonomy 或完成判定器。

## 1. 用户需要得到的答案

任务进行中时，界面应直接回答：**当前正在做什么、已经得到什么可验证结果、还缺什么、是否需要用户决定、用户现在能做什么**。任务结束后，应清楚说明结果是否完成、依据是什么、是否仍有未收拢操作，以及可执行的下一步。

“进度”由有来源的阶段、活动和已提交事实构成。除非 Runtime 提供可验证的总量与完成量，界面不显示百分比、倒计时、剩余时长或按动画估算的进度。更新时间、连接心跳和收到 ACK 只说明信号发生，不代表工作取得进展或成功。

## 2. 不同输出和状态的事实 owner

下列事实彼此相关但不可互相替代。UI 可并列呈现，经由稳定身份关联；不得将低层事实升级成高层成功。

| 事实 | 说明 | 可支持的用户表述 | 不能据此表述 |
| --- | --- | --- | --- |
| Provider completed response | 某次 Provider 请求返回了终止响应或内容；来源是 Provider binding/runtime 事件 | “模型已返回一段内容”“本轮 Provider 请求已结束” | “任务已完成”“产物已验收”“所有副作用已停止” |
| Runtime task result | Runtime 按 task/operation/execution epoch 归属并验证执行输出；有对应产物或检查结果 | “任务结果已通过/未通过检查”，并链接结果和检查证据 | 未有终态 receipt、生命周期提交时宣称 Journal 已完成 |
| Organ Journal truth | Journal Owner durable commit 的 task、checkpoint、closure 等事实及 receipt | 展示已提交的任务状态、恢复责任与提交证据 | 用 UI 缓存、Provider session、Index 或摘要重建/覆盖 Journal 状态 |
| Operation effects | Operation Owner 报告的实际副作用及 settle/reconcile 结果 | “此操作已完成/失败/仍未知”，列出受影响范围 | 仅因请求已取消、Provider EOF 或调用方 ACK 宣称效果已撤销/停止 |
| UI narrative | `context-events` 根据 canonical event 产生的用户叙事 | 以简洁文字解释已发生、正在发生、失败或待处理事实 | 作为领域事实来源，或从 narrative 文案反向推断完成、控制状态 |

关系顺序不是固定的“Provider 结束 → 任务成功”：最终结果要由对应 Runtime task verification、生命周期终态和所需副作用收拢证据共同决定。Checkpoint durable 也只证明 checkpoint 已提交；它不单独证明 task closure、操作收拢或下一轮可运行。

## 3. 输出区域的信息层级

默认界面分为四个相互关联的部分：

1. **当前状态**：领域状态的用户文案；有活动时显示具体活动及其更新时间。无可信活动来源则显示“状态未知/正在同步”，不显示旋转动画来暗示工作仍在推进。
2. **计划**：显示 Runtime 已接受或已提交的当前计划节点、顺序、依赖与必要决策。未接受的候选明确标为“提议”；计划修订保留先后关系。计划节点不是已执行事实，不能用打勾样式暗示完成。
3. **对话与公开输出**：显示用户输入、可公开的 Agent 输出、阶段性结论和决策请求。流式文本若被当前实现可靠提供，可标“正在生成”；只有 Runtime 接受并关联到对应 task/epoch 后才进入稳定历史。阶段性输出保留“暂定/部分”标签，不能覆盖已提交结果。
4. **活动与证据**：按真实调用身份显示工具请求及匹配的返回、状态、错误和可授权查看的证据。请求与返回分开；未配对返回显示为未知或待关联，不能按时间相邻猜测。原始技术详情按需展开，不泄露隐藏推理、凭据、Provider transport frame 或 Journal 原始记录。

隐藏推理（chain-of-thought）不展示、不模拟、不从工具序列或摘要补写。可以展示的是 Agent 明确输出的公开解释、计划、决策请求、工具调用及结果、Runtime 观察到的事实和验证结果。工具 `reason` 等控制数据按各自 owner 定义的安全投影处理，不直接当作对话内容。

## 4. 稳定语义与更新规则

- **活动中**：仅在存在当前 task/operation/epoch 关联的活动事实时显示活动。展示“正在调用 X”“正在检查产物”等具体动作；活动只证明当前已观察到该动作，不证明继续活着。保留最后一次真实活动时间与来源。
- **稳定输出**：已关联的 Provider 文本先标“本轮返回”；Runtime 接受并持久化为 task output 后可作为任务输出候选。验证与 lifecycle terminal 未齐时仍显示“结果待确认”。
- **结果**：只显示 Runtime/Journal 已提交的终态及其必要 receipt / evidence 引用。用户可读摘要和恢复说明服务决策，但不能替代验证数据、Operation 状态或 checkpoint recovery state。
- **时间顺序**：优先用有序事件/Journal seq 和真实 call/operation 身份；时间戳用于阅读，不修补缺失顺序，不将 UI 收到顺序当执行顺序。
- **范围隔离**：不同 task、operation、execution epoch、attempt 的输出不能互相接续。重试开始新执行段，旧执行事实保留并标明，不回写成当前成功。
- **过期或断线**：保留最后可信内容并显示“连接中断/数据可能过期”及最后同步时间。断线不等于 task failed；重连按稳定 cursor 补读，若存在缺口须明确提示。

## 5. 状态文案与用户动作

文案只表达当前证据；“未知”是显式结果，不自动降级成成功或失败。

| 观测情形 | 用户看到 | 建议恢复动作 |
| --- | --- | --- |
| 公开文本输出 | “Agent 回复”或“本轮回复”；只有显式公开内容可见 | 若运行仍继续，显示“仍在执行”；提供查看活动/等待选项 |
| 工具调用已发出、结果未到 | “正在等待工具结果”；调用状态 `unknown/pending`，显示调用身份和开始时间 | 查询/刷新该 operation 的状态；若超出 Runtime 的处理预算，转 Attention/reconcile，不由 UI 宣判失败 |
| 工具成功返回 | “工具已返回结果”；结果可打开且证据身份匹配 | 继续展示后续真实阶段；不要把单个工具成功当任务成功 |
| 未知事件类型或无法识别输出 | “收到暂不支持展示的事件”；保留 scope、顺序、来源和证据引用 | 更新后重读同一历史；在可授权诊断视图查看来源，不猜事件语义 |
| 部分输出或检查不完整 | “已生成部分结果，尚未完成验证”；逐项列通过、失败、缺失、未执行 | 补齐受影响检查或交由 Runtime 恢复；保留已产出内容，不标为成功 |
| Provider/工具/验证错误 | 指明哪个阶段失败、影响范围、原错误摘要、当前恢复责任和可用动作 | 允许的重试/修复通过既有控制 owner 发起；保留输入、之前输出和失败证据 |
| 用户请求取消，stop 尚未 settle | “正在停止；尚未确认副作用已收拢”；展示 stop operation 与未决 effects | 只等待或查询标准 stop/reconcile operation；禁止提示“已取消完成”或允许依赖结果继续 |
| Stop 已 settle | 依据 Runtime closure + 实际副作用结果显示“已停止”，同时保留已发生效果 | 提供 checkpoint/operation evidence 与恢复入口；不得声称已撤销已经发生的外部效果 |
| Journal/commit 结果未知 | “保存状态待确认；请勿重复提交”；显示已有 commit identity 和恢复状态 | 按同一 commit identity 读回/重试查询，保留恢复责任；不可新建伪终态 |

“完成”标签需要对应 task 的成功终态事实，并满足该任务适用的验证条件；显示证据入口。若无适用 checker，也需由 Runtime 明确的成功 closure 支持，不能依赖模型自报 `completion proposal`。失败、blocked、cancelled、stopped、unknown 各自保留其真实语义，不统称完成。

## 6. 现状与目标差距

### 当前可复用（源码/契约可见，不代表完整产品接线已验收）

- `packages/contracts/src/index.ts` 定义 `ProviderEvent`（含 model/output/tool/error/terminal 等类型）和任务、checkpoint、Operation 领域形状；`packages/ui/contracts/runtime.ts` 有 `RuntimeTaskEventProjection`、`RuntimeRecentOutputProjection`、任务列表状态与错误投影。
- `packages/app/src/ui-runtime/service.ts` 的 `observationToolSteps` 按真实 `callId` 配对 `provider.tool` 与 `provider.tool-result`，缺结果时保留 `unknown`；`projectRuntimeSemanticObservation` 提供语义观测接口。`docs/ui/task-flow-transparency-implementation.md` 和 `docs/ui/ux-core-framework-2026-10-10.md` 记录了节点、工具轨迹、状态栏与历史呈现的已有约束。
- `packages/context-events` 已实现 canonical taxonomy、normalize、pairing、`toUserNarrative`、Memory digest 和 Compact；未知输入显式 `unmapped`。这提供共同语义基础，但 [`semantic-observation-audit-2026-10-07.md`](semantic-observation-audit-2026-10-07.md) 记录 UI narrative 的生产消费接线仍为 OPEN。
- `packages/runtime/src/ui-runtime/task-verification.ts` 实现 checker 结果桥接，`packages/contracts/src/tool-execution.ts` 定义 `TaskVerificationResult` 与 `ServeTaskTerminalReceipt`。`docs/ui/ux-core-framework-2026-10-10.md` 标记生产组装/消费边未证实；类型或实现存在不能作为完整 task result 接线证据。
- [`context-contract.md`](../architecture/context-contract.md) 规定模型输出的 control fields 不进入业务 Context、checkpoint 必须经统一 owner durable commit、checkpoint 与 turn closure 分离，以及取消需要真实 Operation 收拢。它是设计合同；章节明确指出部分字段与 receipt 仍是后续 native contract 要求，并未声称当前实现齐备。

### 目标闭环

1. Provider response、Runtime event、验证结果、Operation settle 和 Journal receipt 使用同一 task/operation/epoch 身份贯通公开只读 API；各层仍由自己的 owner 产出事实。
2. Runtime/App 组合语义事件、稳定文本输出、动态计划与 recovery/terminal facts；UI 只消费 typed projection 和 context-events narrative，不从 raw kind、摘要、动画或计数器重建状态。
3. 成功结果、部分结果、失败、未知、取消与 stop settlement 均有清楚状态、证据来源、时间和下一步；刷新、断线、重试及旧 epoch 返回仍可正确阅读。
4. 所有输出经过安全投影；用户可见文字不含隐藏推理、凭据、私密 transport 内容或不受权限保护的 artifact 正文。

这些目标需要在对应真实 API/浏览器入口逐项验证；本文与类型定义不构成端到端验收证据。

## 7. 验收问题

在真实任务入口检查以下情形：普通文本回答、连续/并行工具调用、工具失败、未映射事件、部分检查、Provider 已结束但 Runtime 仍未确认、Journal commit 结果未知、stop 竞态与 settle。每种情形均核对：

- 用户能区分 Provider 返回、任务结果、Journal 提交与外部副作用；
- 状态、计划、对话和轨迹来自各自 typed owner，身份关联准确；
- 无伪百分比、虚构实时状态、隐藏推理或以摘要/ACK 冒充完成；
- 错误与未知保留原始证据、输入、恢复责任和适用操作；
- 停止只有在 Runtime stop closure 与 Operation 实际效果收拢后才呈现已完成；
- 显示/导航行为保持只读，不触发消费队列、retry、steer 或 checkpoint 改写。

