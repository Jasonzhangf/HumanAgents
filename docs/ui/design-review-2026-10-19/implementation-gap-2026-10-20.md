# 最新设计稿与实际产品的 UX 差距

日期：2026-10-20。范围：差距审计，不实施产品修改。

## 结论与基线

最新静态稿已经表达五板块、多 Live 任务卡片、中心 session、完整任务关联链和人类最高权限介入。实际产品仍以项目、任务和分散页面为入口。现有任务、语义记录、agent activity、checkpoint、已提交结果和 task-scoped 控制可以复用；产品壳及跨板块组合尚未完成。

本报告使用包含最新设计的交付源码树 `/Volumes/Intel/playground/humanagent/native-delivery-control-20261015`，审计开始时为 main `a22cbddf`。已正常 fetch；工作副本 `/Volumes/extension/code/humanagent` 停在更早的 2026-10-17 版本，不将其当作最新实现。未修改任一产品代码或运行状态。

设计基准为本目录 `index.html`、`audit.md` 和用户在本轮确认的语义：

- 左侧五类板块：交互 agent、编排 agent、巡检 agent、执行 agent、记忆 agent。卡片显示同一板块多条 Live 任务；板块标题与任务分别可进入。
- 板块 dashboard 上方 Live、下方历史。选中任务后，中心为当前 focus 的 agent/session；不再叠放整张 dashboard。
- 右侧呈现当前任务关联的整条链，节点可切换 focus。历史链与当前链独立，无依据不补边。
- 交互 agent 负责日常人类聊天。其他 agent 常规接口面向编排 agent。Live session 底部保留人类指令，标明身份和最高控制权限；普通运行不等待人工介入。
- 配置入口轻量贴边，桌面关联层在右侧，手机使用单一底部抽屉。历史归档只读。

静态稿中的 BOARDS、RELATIONS、消息和状态切换均为示例。它们不能计为真实五 agent、真实会话索引或命令能力。

## 本轮实际观察与限制

浏览器打开 `http://127.0.0.1:53007/dashboard.html` 成功。实际顶部仍为 `Dashboard / Task List / 新建 Task / Memory`，角落入口仍为工作范围、查看方式、显示设置、输入设置。页面显示当前审计浏览器尚未配对，并提供配对入口。

因此，本轮直接确认了未配对产品壳与源码差距。未配对后的真实任务列表、审批恢复、关联跳转、指令执行和移动端动态行为均为 UNVERIFIED。本轮不调用真实任务、不申请或撤销 grant、不重启服务。静态稿原有浏览器证据只证明设计行为，不替代产品验收。

## 12 项实际差距

“部分”表示已有可复用实现，但尚未满足本轮完整交互；“语义冲突”表示已经定位到与设计不一致的源码组合。优先级只用于后续实施排序，不是本轮新增 gate。

| ID / 优先级 | 设计要求 | 实际状态与证据 | 需要补齐的最小行为与 owner |
|---|---|---|---|
| UX01 / P1 | 五板块共享产品壳，配置轻量贴边 | 新产品入口缺失。`docs/ui/runtime-shell.js:123` 仍生成旧四项导航；`:150` 仍以四角菜单承担配置。真实未配对入口与其一致。 | `packages/ui` 的产品壳及 `docs/ui/runtime-shell.js` 改为五板块导航与共享中心区域；新建任务归入对应任务操作，不再单列顶级导航。复用现有配置与展开机制。 |
| UX02 / P1 | 同一 agent 卡片展示多条 Live 任务，任务行直达自己的 session | 部分。现有 `docs/ui/agent-activity.js:172`、`docs/ui/task-dashboard.js:1779` 是一个 task 内的当前/历史执行实例；不是按板块聚合的跨任务列表。角色集合还含 review，巡检在 `packages/contracts/src/task-flow.ts:3` 是 task flow 种类，不能直接视为同一种 agent 身份。 | 先明确板块分组与实例身份的关系。App 组合既有 task/instance 事实，UI 投影板块中的多 Live session。板块不是新 runtime 身份；不能靠标题猜分组或把巡检当 reviewer。 |
| UX03 / P1 | 每板块都有 Live/历史 dashboard，进入 session 后不叠加列表 | 部分。`docs/ui/dashboard.js:63` 与 `docs/ui/runtime-shell.js:627` 仍按项目展开任务；已有 live-runtime/durable-history basis，但没有五板块 session 索引。显式交互也只有按 ID inspect 的入口。 | App 基于已有任务行、显式交互与 agent activity 组合可枚举的板块读模型。保留 session 与 task/instance 的区别，支持一个任务关联多个执行实例及历史记录。UI 使用同一集合驱动卡片与 dashboard。 |
| UX04 / P1 | 完整需求→编排→执行关联链，可点击节点，节点不重复 | 关系事实部分已有，产品链投影缺失。`packages/contracts/src/task-identity.ts:10` 保存 requirement/confirmation 等来源；`packages/ui/contracts/runtime.ts:287` 有 parentTask/subscription/occurrence lineage。内部 `actual-execution-graph.ts:309` 不是五板块产品关系链。 | 由 App 从现有 owner 记录组合稳定 source/target refs 与边含义，经 UI 投影渲染整条产品链。不得用静态 RELATIONS、标题、时间邻近或内部执行图猜出业务边。来源缺失保持可见，不造边。 |
| UX05 / P1 | focus 同步中心与右侧；层级返回、浏览器后退和刷新恢复位置 | 部分。已有 project/mode/task 查询范围、面包屑和 checkpoint pushState/popstate：`docs/ui/runtime-shell.js:208`、`docs/ui/task-dashboard.js:735`、`:2806`。没有 board/live-or-history/session 的统一选择。 | UI 壳负责唯一位置状态，将板块、当前/历史、session ref 与原授权 scope 绑定。层级返回到所属板块；浏览器后退恢复访问顺序。不可通过导航推进任务或重开已关闭的审批。 |
| UX06 / P1 | 中心为人读 session，消息显示真实说话者、时间、执行内容和已确认结果 | 部分。已有 conversation/trace：`docs/ui/interaction-work-card.js:491`；provider/runtime history：`packages/contracts/src/tool-execution.ts:632`、`packages/app/src/ui-runtime/turn-history.ts:20`。当前交互卡常用“用户/助手”标签，执行历史与显式输入未形成五板块统一 session。 | 复用消息和事件归一能力，App 组合真实 actor/source/time/content，UI 按语义呈现；有无输入框不决定 session 是否可显示。无需公开私有推理或把 raw trace 直接当对话。 |
| UX07 / P0 | 人类消息与普通 agent 流量身份清楚，最高权限来自真实身份 | 语义冲突。`packages/app/src/ui-runtime/service.ts:3454` 的 recentInputs 将所有非空 task.input 统一写成 `source: 'human'`。已有 server principal/grant 绑定，但该输入投影不能证明来源是人类。 | App 在输入/命令入口保留真实来源，再组合到 UI。普通编排安排与人类介入分别显示；不能从 sourceRef 文案或 task.input 推断 human 身份，也不能靠 UI 的“最高权限”标签授予控制权。 |
| UX08 / P1 | 所有 Live session 保留人类指令入口，普通流程不依赖人工回复 | 部分。新任务输入、澄清输入和 task 控制已经存在；没有任意当前 agent/session 的统一指令入口及对应可读记录。`docs/ui/entry.js:725`、`docs/ui/task.js:460`、`docs/ui/runtime-api.js:427` 分属不同用途。 | UI 增加绑定当前 session 的人类指令区；App 按正式控制/需求入口区分派发。常规 agent 接口仍面向编排 agent。需要补齐目标、来源、操作语义和回执；不能把任意文本当 steer，也不能把输入一律重新新建任务。历史只读。 |
| UX09 / P0 | 需要批准时明确显示问题与可选动作；批准后继续；等待不冒充失败 | 语义冲突，控制基础已有。`service.ts:3775` 将 blocked/failed 一并映射为 error，`:3810` 附近固定 `requiredDecisions: []`；`packages/ui/projection/runtime.ts:349` 合并 waiting/blocked 分组。已有 grant/read/revoke 与 release 路径：`server.ts:916`、`:953`。 | App 组合明确的待批准/待决策记录，给出问题、选项、目标控制、状态与后续恢复动作。UI 直接呈现审批，不通过“失败原因”绕行。复用 task grant 真源；必须再验实际批准后继续，不能从 route 存在推断此闭环已通过。 |
| UX10 / P0 | 各入口显示一致的已提交结果，未产生结果不画空块，完成状态不悬空 | 读路径不一致。`service.ts:3486` 的 task dashboard 使用 committed publication；`:3811` 的 task detail 仍从 `task.output` 构造调查内容与结果。已有 pending/committed/unavailable/unknown 和提交引用：`packages/ui/contracts/runtime.ts:352`。 | App 统一结果读取到既有公开提交事实；UI 不把未提交文本当交付。已有正文继续可读，空/未知/失败按实际区别显示。是否有用户可见的具体错结果，仍需真实样本验证。 |
| UX11 / P1 | 桌面右侧关系层；手机板块导航与关系共用一个底部抽屉，输入保留在主区 | 部分，布局机制可复用。`docs/ui/runtime-shell.js:1378`、`docs/ui/runtime.css:1013`、`:1217` 已有桌面右层、手机 bottom drawer、关闭与焦点处理；目前主要承载技术详情、配置和 task 内观测。 | 将五板块导航与完整关系链接入既有共享层，保留一层 overlay。导航抽屉点任务后进入 session，关系抽屉点节点时保留链路并切 focus。不要重写两套桌面/手机业务状态。 |
| UX12 / P1 | 主层只显示必要人读内容，内部字段进入按需详情 | 部分。现有技术详情层可复用，但 `docs/ui/entry.js:232`、`:305` 仍直接展示 FIFO/requirementId/state/code；`docs/ui/memory.js:49` 直接展示 digest/sourceRef；正常连接提示也常驻在 `runtime-shell.js:67`。 | UI 以任务名、角色、状态、结果和必要动作替换机械字段。正常连接、读取完整、无内容占位及重复摘要从主层删除；保留有用的结果/资料入口，原始诊断按需查看。 |

## 可以直接复用的已开发能力

| 已有能力 | 复用边界 |
|---|---|
| TaskIdentity、requirement/confirmation、subscription/occurrence 来源 | 用于建立真实任务归属及产品关联，不能改用标题或静态 ID 匹配。 |
| task list、project/system read、live/durable basis | 提供板块索引的基础；补齐 session 与 agent 归属，不重复维护第二份任务状态。 |
| task-scoped agent activity 与 current/historical/unknown 分类 | 提供执行实例事实；不把功能角色名当实例身份，也不把未知状态伪装成 Live。 |
| Interaction Work Card、history trace、context-event 归一与配对 | 提供 session 的正文和记录基础；仍需真实 actor 与当前 session 成员关系。 |
| committed public output、checkpoint/history、GET/SSE | 复用已确认输出与刷新机制；保留缺失、stale 和断连语义。 |
| task grant、server-resolved principal、正式控制/恢复入口 | 复用身份和执行授权；人类主动介入要通过正式入口，不把控制混进业务消息。 |
| shared shell-layer、技术详情、手机 bottom drawer、焦点恢复 | 改承载内容并补统一位置状态，不重新造 overlay 框架。 |

## 后续实施顺序

1. 先交共享壳、位置选择和五板块结构。复用已有任务/消息/抽屉，建立可用主界面。没有接数据的部分明确其范围。
2. 在底层同步处理 UX07、UX09、UX10 的真实来源、决策和结果组合问题。随后接真实多任务索引、session 与关联链。
3. 完成人类指令到正式目标的控制路径，再组合桌面/手机和 Live/历史。只验证本次受影响的真实用户路径。
4. 将内部说明消融纳入对应页面迁移，一并删除，不建立单独清理框架。产品实现仍等待用户审定设计及后续推进指令。

实施时沿现有 task/source/observation/control DAG 补受影响的读模型与入口。当前观察图已闭合到 task 级读取和渲染，但不覆盖五板块 session 索引与产品关联链。图中 task grant 也不能替代“用户看到明确问题并批准后继续”的完整产品路径。本轮只读现图，不为审计新建业务图、不跑无关 graph/test gate。

## 验收缺口与交付边界

需要未来真实入口证据的重点是：板块卡片与中心同集合、多个 session 不串任务、关联节点切换与返回、普通编排消息不冒充人类、主动人类指令准确到达目标、授权等待不显示失败且批准后继续、各入口已提交结果一致，以及手机单抽屉和输入可用。

这些是待实施的行为验收目标，不代表本轮新增了测试或已经执行。本轮没有测试、构建、安装、重启或真实任务副作用。

本轮一次性 GCM 观察分为前端与数据契约两项；负责人结合真实入口和关键源代码复核后整理本报告。观察证据保留在 `/Volumes/Intel/playground/humanagent/.worker-runs/ux-gap-20261020/`，其中 `frontend/evidence-table.md`、`contracts/evidence-table.md` 为详细定位；不将观察者建议的新增类型或接口直接视为已批准方案。
