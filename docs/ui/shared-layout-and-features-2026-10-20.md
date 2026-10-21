# 共享排版模板与页面功能配置

状态：机制与八页矩阵已确定，产品迁移进行中。本文说明本轮装配方式，不代表新 UX、八页迁移或真实运行验收已经完成。

## 三层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| 排版 template | 显式页面 root、具名功能区、响应式布局、唯一详情载体、进入和返回焦点、退出清理 | 业务请求、任务状态推断、授权决定、命令派发 |
| 功能插件 | 已有组件的正文与局部交互，沿既有 render 或 mount/update/dispose 接口组合 | 再创建页面壳、再开一套全局抽屉、重建任务状态 |
| 页面 controller／配置 | 选择模板与插件，提供真实读结果、scope、选择位置、正式动作回调和页面生命周期 | 复制共享排版或把样例当真实能力 |

这里的插件是项目已有的可组合 UI 模块。首版使用静态 ESM 直接导入和每页小配置对象，不建设 registry、动态加载器、事件总线或新状态库。任务提示词模板 `agent-templates` 与排版模板分开。

## 统一模板入口

接口契约为 `mountPageTemplate(root, config)`，由 `docs/ui/runtime-shell.js` 提供。显式 root 的子内容归模板；root 之外的元素不由模板清空或扫描。页面在替换前保留有效挂载点或创建显式 host。

布局有三类，复用同一套槽位与详情实现：

- `collection`：任务集合、总览、记忆候选列表。
- `work`：交互、任务处理、执行和只读观测。
- `standalone`：配对与认证恢复。没有业务导航、配置菜单、业务读取或订阅。

共享功能区为 `heading/status`、`primary`、按需使用的 `support` 和 `composer`。没有内容的辅助区或输入区不占位。`detail.open/close/dispose` 提供唯一详情入口；新详情替换旧详情，不叠加第二个产品弹窗。手机沿同一载体呈现底部抽屉。

页面继续持有自己的 task/project/mode/instance 与 URL 选择。semantic GET/SSE 继续归 `mountSemanticObservationPanel`，不能为了插件化再订阅一份。退出顺序为：停止 controller 资源，释放功能组件，最后释放模板。

## 已找到的共享插件

| 共享模块 | 用途与接法 |
|---|---|
| `interaction-work-card.js` | 交互正文、对话、轨迹；直接复用 `mountInteractionWorkCard` 的 update/dispose。 |
| `agent-activity.js` | 当前／历史执行实例及其详情；复用 renderer，页面提供选择和详情回调。 |
| `semantic-observation.js` 与 shell panel | 语义观测及证据正文；panel 保留读取与流生命周期，详情进入共享载体。 |
| `checkpoint-history.js` | checkpoint 列表、详情与资产正文；页面注入正式读取、选择、纠正与恢复回调。 |
| `plan-control.js` | 已有计划与可用控制展示；操作与控制真相仍归原 owner。 |
| `memory-actions.js` | 候选审核动作、原因、刷新与错误；不新增另一套审核状态。 |
| `runtime-shell.js` 的范围、列表、技术详情与显示偏好能力 | 接入模板的公共能力；配置只决定展示位置，不改变读取或权限语义。 |

不强迫纯 renderer 新增统一包装类。只有缺少且实际需要的清理能力才补 disposer。局部 tab/checkpoint 焦点仍归原组件或 controller；共享详情的焦点归模板。

## 八个真实页面的配置

| 页面 | 模板 | 主要功能配置 | 页面保留的职责 |
|---|---|---|---|
| `index.html / entry.js` | work | primary 交互卡，composer 原新任务输入 | 一次提交确认、澄清、策略与精确任务身份匹配；有效卡片挂载点必须保留。 |
| `dashboard.html / dashboard.js` | collection | primary 系统／任务列表，support 计划与管理 | system 读取、scheduler、正式计划控制及任务管理；清理原刷新 timer。 |
| `tasks.html / tasks.js` | collection | primary project/system 任务列表 | 精确 project scope、刷新、面包屑、任务链接及配对恢复。 |
| `task.html / task.js` | work | primary 交互卡与任务正文，composer 适用澄清或确认 | task/interaction 身份、原 reads/writes、EventSource、polling、项目范围转发和退出收口。 |
| `task-dashboard.html / task-dashboard.js` | work | primary 任务与语义视图，support 执行实例／计划／checkpoint，共享 detail | 精确 task/project/mode、实例与历史选择、正式控制、回执、浏览器位置和原流生命周期。 |
| `observation.html / observation.js` | work | primary 节点与语义，detail 节点或证据 | observation 读取、子树／节点选择，全部界面只读。 |
| `memory.html / memory.js` | collection | primary 摘要／候选，support 审核原因 | 原 namespace、candidate/decision/reason、审核、刷新和失败反馈。 |
| `login.html / login.js` | standalone | primary 原配对表单，status/error 与按需技术详情 | 正式 auth/session/pair、safe next、保留输入、重试、退出和焦点。 |

历史 `interaction.html`、tour 和本轮静态设计稿不作为新产品页面迁移。确认已被 shell 替换的旧 HTML 占位可以删除；仍有效的 index 卡片 marker 和 login 表单不能当作无效占位清除。

## 实施与交付边界

共享模板、样式、详情及其契约由一个执行者负责。页面分为集合、输入／任务、总览、执行／观测、配对五组，按文件归属并行。先组合真实 tasks 与 memory 页面，再完成全部八页。全部页面的受影响行为验收后，在正式集成边界审查一次整体增量。

本轮迁移不自动解决五板块真实索引、跨板块关系事实、人类来源、完整批准恢复和统一提交结果等底层缺口。详细差距见 `design-review-2026-10-19/implementation-gap-2026-10-20.md`。不能用空槽位、前端样例、标题匹配或静态关系填补缺失事实。

已接受的独立计划及模块/页面事实表保留在 `/Volumes/Intel/playground/humanagent/.worker-runs/ui-layout-modules-20261020/`。最终交付须另外记录实际页面配置、公开行为证据、安装后结果和资源收口；本文自身不是运行通过证明。
