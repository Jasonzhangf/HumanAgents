# HumanAgent 偏好与跨表面体验设计

状态：`DESIGN-CANDIDATE`。这是后续 UI/config 与共享 UI owner 的设计合同；不表示生产偏好存储、跨表面引用共享或无障碍行为已经实现或验收。

## 目标与边界

Dashboard、Task Detail、Organ Console、Pipeline Observation 应让用户在不同入口看到同一份已发布事实，并保持一致的查看模式、可恢复的导航和键盘体验。偏好只影响呈现；任何浏览、筛选、切换、刷新或恢复都不能改变 task、checkpoint、Journal、runtime current refs 或副作用。

本设计补足 [`ux-core-framework`](./ux-core-framework-2026-10-10.md) §1.2–1.4 中明确留待后续展开的展示偏好与共享引用合同。展示模式和只读边界以 [`semantic-observation-audit`](./semantic-observation-audit-2026-10-07.md) §1、§2、§8 为准；人类可读、阅读位置、焦点、减少动态效果及尺寸验证以 [`interaction-audit`](./interaction-audit-2026-10-02.md) F09/F10、§4.1、§8 为准；模块 owner 和持久化 root 以 [`AGENTS.md`](../../AGENTS.md) 为准。

## 偏好与查看状态

### 持久偏好

用户主动保存的偏好是有版本号的、范围有限的展示配置。建议首版只保存：

| 字段 | 内容 | 冷启动值 |
| --- | --- | --- |
| `observation.defaultMode` | `current`、`semantic`、`actions`、`raw` 或 `follow-last` | `current` |
| `taskList.defaultScope` | 列表展示类别 `current`、`decision`、`history` 或 `all` | `current` |
| `filters` | 仅经 UI/config 明确登记的枚举型、纯展示筛选值；每个筛选带稳定字段名和 schema 版本 | 各筛选器的中性值（不过滤） |

上述字段只作为拟议 allowlist，不预设未定义的筛选维度。自由文本搜索、临时排序、当前打开的 drawer、滚动位置及任何业务对象选择都不进入持久偏好。只有用户显式保存默认模式/列表范围时写入设置；筛选控件是否即时应用不等同于保存默认值。`follow-last` 仅在用户直接手动选中四种模式之一且呈现切换成功后更新；页面初始化、SSE 更新、Tour、程序导航、显式链接回放、历史证据跳转不得更新。

偏好存放在 `~/.humanagent` 管理的用户级设置中，由 `packages/config` 提供 typed 合同及路径派生；UI 不读写 project workspace，不自行解析 TOML，也不直接拥有存储格式。浏览器 `localStorage` 只能用于隔离原型，不能证明生产交付。存储读取/解析失败时本次会话使用冷启动值并显示局部状态；保存/删除失败应保留当前视图、报告未保存，不能显示成功。未知版本或字段不能被静默覆盖；Reset 只删除本功能声明的偏好记录。

偏好中禁止出现 task、project、organ/agent/instance、scopeRef/路径、revision、checkpoint、cycle、occurrence、action/raw 记录、projection/payload、URL/route、凭据或控制状态。Task List 的 `current|decision|history|all` 是有限的列表展示范围；Pipeline 内的 project/task/organ/agent/scope 是业务身份与导航目标，不是可保存偏好。

### 默认解析与瞬时选择

视图初始化按以下顺序解析：

1. **有效显式链接**决定本次要看的模式与合法历史选择，并保持 URL 所表达的 scope。它优先于偏好，但不得回写偏好。
2. **保存的偏好**只决定没有明确指定的展示默认值；`follow-last` 使用最近一次成功的直接手动模式选择。偏好不能补全或覆盖 URL 中的 task、scope、revision 或 checkpoint。
3. **冷启动默认**是 `current`、Task List 的 `current` 范围、无额外过滤。`current` 指只呈现最新权威编排视图；它绝不改写 runtime current 游标，也不把旧 revision 冒充为当前。

无模式的有效历史深链可按既有合同解析到对应历史视图（例如历史 revision 使用语义视图），并同时标明 current 与 viewed 的差别。显式 `current` 与旧 revision/checkpoint 冲突时，保留链接选择并显示 mismatch；未知、未发布、未提交或跨 scope 目标显示可理解的失败，不悄悄跳到另一个对象。Tour、浏览器返回/前进、面包屑、drawer、节点证据链接均属于一次性导航，不更改保存的默认值。

View state（当前模式、临时过滤、展开项、drawer、scope 栈、阅读锚点）由正在使用的 surface 会话持有。刷新后仅从有效显式 URL 恢复 URL 中的目标；非显式冷启动回到上述默认展示与自然根 scope，不从存储的 task/scope 选择隐式跳入旧工作。刷新期间保留的旧画面必须标成旧数据，直到新响应确认其 scope 与版本；读取失败时保留旧画面并明确标记 stale/error。

## 投影引用、更新与 scope 隔离

同一语义发布进入浏览器后只解码一次。UI 共享 owner 持有只读 projection reference（身份至少区分数据 scope 与 projection version）；Dashboard、Task Detail、Organ Console、Pipeline Observation 的消费者对同一发布共享该引用。surface-specific view model 可引用共享事实并表达布局，但不能复制后再各自重建事实或状态。事件通知引用及必要关联信息；不把完整 payload 填进事件、偏好或 runtime 控制/业务字段。

新发布创建新引用，已有旧引用内容不可变；相同发布中未变部分可复用。消费者只更新自己的呈现与临时 view state，不得改写投影、在 surface 间传递可变对象，或因一个 surface 的过滤而修改其他 surface 的投影。观察旧版本期间收到新引用时，保留用户选择和阅读锚点：若该目标仍存在，定位到同一身份；若已消失，显示“该选择在新版本中不可用”，提供返回当前/父 scope 的显式入口，不猜测替代目标。

每个订阅与事件都绑定真实 scope 身份和 projection version/sequence。离开 scope 或卸载 consumer 时退订；切换 scope 后拒绝前一 scope 的迟到事件，即使其到达时间更晚。刷新或重连时先确认响应 scope 与请求一致，再替换当前引用；失败保留同 scope 的最后有效引用并标 stale。不可用的新 scope 不得借用其他任务/项目缓存作为成功态。共享缓存可以复用已验证的不可变引用，但 cache key、授权与 scope 匹配由唯一 owner 管理，页面不得自行拼造身份。

四个表面通过同一导航选择在需要时互相跳转，并携带合法显式目标（真实 task/project/organ/instance/scope 及查看模式/历史 ref）；只传递已由 projection 暴露且仍有效的身份，不从标题、相邻行或目录名推断身份。跳转不会重新提交需求、变更领域 current 或触发运行操作。Dashboard 与 Task Detail 显示用户任务状态；Organ Console 聚合真实 Organ 投影；Pipeline Observation 递归展示节点和证据，只接受只读导航/抽屉操作。

## 一致的键盘、阅读与布局体验

- **键盘和焦点**：所有主要导航、模式、筛选、面包屑及 drawer 控件都有可见名称和原生键盘行为；焦点顺序跟随屏幕阅读顺序。Drawer 打开后聚焦其标题或首个有意义控件，并限制模态交互；Escape 和关闭按钮关闭后，将焦点返回稳定触发元素。若新 projection 已移除触发元素，则回到同 scope 的稳定父级/列表标题并给出状态提示，不落到 `body`。面包屑返回与重新投影也按稳定业务身份恢复焦点。Observation 保持只读 modal drawer 语义。
- **返回/前进和 drawer**：浏览器返回/前进只恢复 URL 已表达的浏览选择；它不回滚 checkpoint、执行历史或副作用。递归 scope 用面包屑返回明确层级；drawer 的关闭只清除选择，不改变 scope。键盘 Escape 与可见关闭入口结果一致；drawer 中的证据深链保留来源 scope，回退后恢复打开前的节点与焦点。
- **阅读位置与新数据**：对话和轨迹各自保留阅读位置；列表/节点细节以稳定条目身份或事件序号作为锚点，不把像素偏移当作身份。重新投影若锚点仍存在则恢复该锚点。用户读历史时不自动滚到底、不抢焦点；有新数据时显示可操作的“有新更新/回到最新”入口。接近末尾的自动跟随只适用于用户正在读最新内容的情形。过滤结果为空、锚点被筛掉或版本中移除时说明原因，提供清除过滤/返回当前位置的操作。
- **Reduced motion**：尊重系统 reduced-motion 设置。关闭非必要循环动画、平滑滚动和位置过渡；用稳定图标、文字状态、时间/序号保留信息。动画不得充当运行活性的证明，也不能成为获取更新的唯一方式。
- **缩放与响应式**：浏览器 200% 缩放及窄视口下，优先保留标题、当前/查看差异、错误/新鲜度、主要导航和当前决定；次要筛选可以折叠但保持可发现。Pipeline 节点/详情在窄屏按单列顺序展示，drawer 不遮断返回路径；不要求桌面密集视图硬塞进窄屏。短屏和长内容允许自然滚动，键盘焦点不被固定栏遮挡。四个 surface 使用同一语义标签与响应顺序，不以横向滚动作为唯一筛选发现方式。

以上为一致性合同，沿用 audit 对窄屏、短屏、长内容、reduced-motion、200% 缩放及键盘的待验证范围；本文件不声明浏览器通过，也不增加全站点击数或装饰性视觉门禁。

## Owner 与边界

`packages/ui` 拥有 UI view model、投影展示和产品壳；`packages/ui/projection` 与 `packages/contracts` 拥有共享 typed projection/command 边界；`packages/config` 拥有用户设置解析、验证、编译和 `~/.humanagent` 路径派生；`packages/app` 组装公开读取与配置能力。Runtime、core 和 Organ Journal 继续拥有运行状态与恢复责任。共享引用的持有/分发只能有一个 UI owner；各 surface 仅订阅与渲染。

Observation 仅允许读取、展开证据、筛选与导航。偏好操作不得消费需求、改变队列、重试 operation、执行 steer/stop、修改 checkpoint 或把 retry/degrade/health 等控制状态编码进业务 payload。错误、未知目标、过期投影和保存失败都应局部可见并保留恢复方式。

## 现状证据与未验收设计

| 领域 | 已有证据 | 状态边界 |
| --- | --- | --- |
| 产品与安全约束 | `AGENTS.md` 唯一 owner/硬约束；`interaction-audit` F09/F10、§4.1/§8；`semantic-observation-audit` §1、G5/G8/G10–G12、§8 | 文档目标与验收合同，不表示生产闭环 |
| typed Observation scope | [`models.ts`](../../packages/ui/contracts/models.ts#L390) 有 `scopeRef`、`projectionSeq`、nodes、breadcrumbs、`canReturn`；[`projection/index.ts`](../../packages/ui/projection/index.ts#L947) 按当前 stack 投影 scope，进入/返回 scope 与打开/关闭 drawer 产生新输入值 | 已有类型与纯投影函数；跨表面共享引用、订阅隔离及真实 UI 生命周期仍待验收 |
| command 边界 | [`commands.ts`](../../packages/ui/contracts/commands.ts#L77) 将 Observation 限定为 drawer/scope/focus 命令；校验器拒绝非只读 Observation 命令 | 命令类型/校验存在；不能据此声称所有浏览器入口的实际调用均已通过 |
| 真实 UI 读取 | [`runtime-shell.js`](../../docs/ui/runtime-shell.js#L660) 的语义面板持有 envelope、mode、scope selection；注释明确仅读，GET/SSE 新 revision 更新本地投影，断连/读取错误标 stale/error | 单面板路径有源码依据；不是四表面共享同一引用或持久偏好的证明 |
| 持久偏好 | semantic audit §1 已规定模式优先级、follow-last、只保存版本化展示字段；§8.2 提出只读共享引用 | 本文细化默认、过滤与跨表面行为；生产 typed config、读写/错误恢复、跨页面消费和数据不变性仍未验收。Tour/localStorage 只算 mock |
| 无障碍与响应式 | interaction audit F09/F10、§8 明确焦点丢失、spinner reduced-motion 缺口和尚未完成的窄屏/短屏/长轨迹/200% 缩放范围 | 设计要求不等于修复完成；需要在受影响真实表面验证 |

## 后续验证入口

实现者按受影响范围，从真实 Dashboard、Task Detail、Organ Console、Pipeline Observation 入口验证：偏好保存/重置与失败；显式链接→偏好→冷启动 `current` 优先级；同一投影版本的引用身份与旧版本不变；scope 切换拒绝迟到事件；刷新/断连后同 scope 恢复；导航/偏好前后 runtime current、Journal 与 checkpoint 不变；抽屉键盘关闭后焦点归还；阅读历史时收到新数据不抢位置；reduced-motion、200% 缩放、窄屏与短屏可用。只执行与该实现候选直接相关的检查，真实浏览器范围按项目已有验收合同记录。缺行为证据的部分标为 `UNVERIFIED`，不以 mock、静态类型或界面存在代替。
