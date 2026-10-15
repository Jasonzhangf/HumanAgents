# UX 核心框架修订提案（2026-10-11）

> 当前展示层级与必要性以[面向人的语义分层展示设计](human-readable-layered-ux-design-2026-10-11.md)为准，绑定需求库 v13。字段存在不代表默认要显示；失败、未知、决定与结果的必要内容保持可见。

状态：`AMENDMENT-CANDIDATE`  
适用对象：[`ux-core-framework-2026-10-10.md`](ux-core-framework-2026-10-10.md)  
边界：本文件是独立修订提案；不修改或替代原框架，也不表示 UI 行为已实现或生产验收通过。

## 核对结论

核心原则总体与项目合同一致：UI 消费 typed projection；运行状态和恢复责任归领域/runtime；查看选择不改变执行状态；Context Events 为 UI narrative 与 Memory digest 提供共享语义；观测面只读；状态和动作不由 UI 猜测；设计候选与生产证据需要分开。

需要修订的是框架结构和证据表达，而不是再定义一套领域模型。原框架的前四层描述事实到浏览器的流转，后两“层”却是查看模式和业务视角，它们是作用于投影结果的正交选择，不是后续数据处理层。另需明确事实权威不等于 Context Events：后者归一化事件并产生语义投影，但不拥有 Journal、任务生命周期或恢复真相。

## 可确认的修订

| 项 | 现状核对 | 最小修改建议 |
| --- | --- | --- |
| 分层、重复与遗漏 | 原 §1 把四段数据流与 `current/semantic/actions/raw`、任务/项目/系统视角排成六层。后两组不产生新事实，也不拥有运行状态；分层容易造成“视角再加工一遍事实”的歧义。 | 将主体收敛为四段单向链：权威领域/历史事实 → canonical event 与语义产物 → UI projection/contracts → App 组装/API → 浏览器呈现（即五个节点、四条边）。将模式和 scope/视角移出层级，定义为正交查看选择。领域事实权威及 Journal owner 仍引用项目规则，不把 Context Events 叫作事实真源。 |
| 输入/输出与唯一 owner | 原 §1 已给各层输入输出与 owner，但第一层把事实输入、规范化和产物生成合并描述，容易把历史真源与语义派生混同；第二层对 Memory digest 的边界方向正确。 | 逐边写明 producer/consumer：Journal 与领域/runtime 提供其拥有的事实；`packages/context-events` 只消费结构化输入并生产 canonical event、pairing、UI narrative、Memory digest、compact snapshot；`packages/ui/projection` 消费 typed 结果并形成展示结构；`packages/app` 组装公开 API；浏览器只呈现/发起正式操作。各模块唯一 owner 依赖 [`AGENTS.md`](../../AGENTS.md) 和 [`context-events.md`](../architecture/context-events.md)，不在 UX 文档重列字段或枚举。 |
| `current` / `viewed` 与控制 | 原 §1.2 与 §4 已明确 current refs 属 runtime、viewed 游标属导航，模式切换只影响查看；方向正确，但原 §1.1 将 `current` 称为模式，可能与 runtime current 混淆。 | 明确区分 `runtime current`（权威当前游标）与 `viewed selection`（用户正在查看的 scope/mode/revision/checkpoint/cycle/occurrence）。把 `current` 解释为“查看当前权威版本的展示模式”，不让它成为第二个状态变量。查看导航与正式控制操作分开；控制只按领域生命周期及 `allowedActions` 投影调用正式 Runtime operation。 |
| Narrative 与 Memory digest | 原文已正确指出两者的语义 owner 是 Context Events，UI 不可重造 narrative 或 digest。Context Events 合同还明确不写 Journal、不决定完成、不渲染 UI；digest 的消费/保存不因此转移其语义 owner。 | 保留并收紧为：语义生成在 Context Events；UI 只排列、分组和渲染；Memory 使用者按其 owner 消费 digest；任何消费者不得以 UI 文案、raw 或自己的摘要替代语义投影。 |
| Raw 按需与事件边 | 原 §1.1/§1.3 已限定 raw 显式读取、不作 fallback，事件通知引用且 scope 切换隔离旧订阅。README 进一步规定正常页面不读 Journal、DSH Session、RCC raw frame 或 debug log。 | 合并表述为默认路径只消费 typed projection；raw 仅在明确证据请求/查看时，通过获准的只读查询边按需获取。raw 不参与语义补全、状态重建或成功回退。事件通知不复制 payload；每条投影/事件保留真实身份、scope、版本/顺序关联，订阅按 scope 退订。 |
| 用户任务、失败与恢复 | README 将 Operator Console 的主任务定为快速回答“现在发生什么、是否需要我决定、我能做什么”；交互审计要求状态分别解释等待对象、失败原因、结果、恢复责任及下一步。原 §3 已列多数字段，但没有把这条用户任务和失败恢复路径设为统一验收目标。 | 在框架原则中补入面向人的完整循环：看到任务/目标与状态 → 理解事实及新鲜度 → 判断是否需要自己决定 → 执行当前合法动作或查看证据 → 明白失败影响和恢复责任 → 看到收拢/结果。每一步只展示 owner 投影提供的事实；断线/过期不等同任务失败，取消请求不等同 stop settled，未知/缺失不伪装成功。 |
| 状态与允许动作 | 原 §3 正确要求不复制枚举、只消费 lifecycle 和 `allowedActions`；AGENTS 将生命周期、错误策略、steer 与恢复归 core/runtime，控制真相与业务 payload 分离。 | 保留指针式合同；统一规定状态标签、等待对象、settlement、Attention、恢复义务及动作可用性来自相应 typed projection/正式控制结果。界面不按连接状态、计时器、动画、节点文案自行推导任务状态或生成动作。 |
| 可访问性 | 原 §1.4 已列焦点归还、阅读位置、reduced motion；README 另规定 drawer 焦点落点、递归 scope/面包屑。交互审计明确屏幕阅读器、全部尺寸/主题等仍未验收，局部 AA 不能外推整站 PASS。 | 将其作为跨入口公共验收，不局限共享控件：键盘可达与焦点闭环/恢复、语义与状态可读、窄屏/放大布局、阅读位置、静态 reduced-motion 状态。每项分别记录设计要求与实际验收证据；单页/单尺寸通过不代表整体无障碍完成。 |
| 设计状态与生产证据 | 原文顶部标为 `DESIGN-CANDIDATE` 且多处保留待重验；相邻审计也声明静态原型不证明生产能力。需要防止将“设计链完整”读成“生产链已接通”。 | 给每项能力明确标记 `DESIGN`、`SOURCE-CONTRACT`、`TESTED`、`REAL-ENTRY-VERIFIED` 中实际证据层级。接口/源码存在只证明合同或实现片段；只有绑定候选 SHA 的真实入口/浏览器证据才证明对应生产行为。未有证据即 `UNVERIFIED`，不以设计自报状态、mock、API 200 或连接就绪替代。 |

建议把原 §1 改为如下最小概念图，详细 owner 继续链接现有合同：

```text
领域与持久化真相（按 AGENTS.md 各自唯一 owner）
  → Context Events 规范化与语义产物
  → UI Projection / UI contracts
  → App API 组装
  → 浏览器呈现与正式操作入口

正交选择：viewed scope × 展示 mode
正式控制：通过 Runtime operation，独立于 viewed selection
按需证据：显式 raw 查询，不回流为语义真相
```

## 待定问题

以下项目在现有设计/源码合同中不能据此文档核实为完整生产能力，应保留 OPEN；其存在不妨碍先合入上述概念修订。

1. **Raw 的实际公开查询边和准入规则**：设计规定显式查看与只读关联，但当前合同引用不足以证明所有 raw 记录类型都有可用、受控的公开读取入口。需由对应查询/API owner 定义，不得由 UX 或组件自行直读存储。
2. **事件语义产物的生产接线覆盖**：Context Events 已定义并实现产物合同；它们分别在哪些真实 Runtime 入口持续产生并被 UI/Memory 正式消费者使用，应按具体消费边的源码与运行证据判断，不能从模块存在推断。
3. **各入口失败恢复与可访问性覆盖**：现有交互审计列出未验证范围；需要候选变更对应的键盘/读屏/响应式以及真实失败、断线恢复证据。此提案不宣称这些体验已达标。

## 真源与证据指针

- Owner、Journal/Index 真源、控制/业务隔离、恢复及只读观测边界：[`AGENTS.md`](../../AGENTS.md)。
- Context Events 的职责/非目标/依赖方向及 UI narrative、Memory digest 语义：[`context-events.md`](../architecture/context-events.md) §4、§10.1、§10.2。
- 产品入口、主用户任务、正常页面数据边界和后台观测只读合同：[`README.md`](README.md) 的 UI brief 与入口职责。
- current/viewed、四种展示模式、scope 与 raw 关联的需求合同：[`semantic-observation-audit-2026-10-07.md`](semantic-observation-audit-2026-10-07.md) §1.1、§8。
- 状态/等待/失败/恢复/动作及已知无障碍验收范围：[`interaction-audit-2026-10-02.md`](interaction-audit-2026-10-02.md) §3、§4.2、§8。
- Dashboard 浏览器证据和资源清理：[`dashboard-e2e-acceptance.md`](dashboard-e2e-acceptance.md)。

本 amendment 仅完成文档一致性核对与候选建议；没有执行测试、Review、浏览器验收，也没有更改生产实现。
