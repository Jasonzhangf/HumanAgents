# HumanAgent 交互与前端审计、改造计划

日期：2026-10-02，America/Los_Angeles。状态：**审计与方案已落盘；产品改造尚未实施，未取得实现验收或架构 review PASS。**

## 1. 结论与范围

当前主线没有满足「人类可读、过程可追溯、状态不用猜」的要求。审计发现 8 项 P1、2 项 P2；交互质量判定为 **Block**。这是现有产品审计，不是某个提交的增量 review；不据此声称新引入或回归。

问题贯穿输入、草稿、执行、结果与观测：三个新建入口行为不同；草稿生成缺实时轮次；人类信息混入内部引用；工具调用被投影成工具返回；旧队列分类被画成串行流程；执行类型尚未贯穿正式入口；成功、失败、连接与收拢的说明互相混淆。

本次覆盖真实页面 `/`、`dashboard.html`、`task.html?task=new`、`tasks.html`、成功/受阻任务的 `task-dashboard.html`、`observation.html` 的节点与 drawer、`memory.html` 的当前失败/空态；对照用户提供的 DSH 两张截图及本地源码。未操作已有任务的停止、重试、删除或记忆审批；未创建执行任务，未重启服务。定时/周期触发、在途断线恢复、屏幕阅读器、全部尺寸/主题尚无本轮行为验收。

## 2. 证据基线

- HumanAgent 工作树：`/Volumes/extension/code/humanagent`，`main@0020ab4f4442ea59bf4b9fc02416a8a77c6c68ed`。已有未跟踪 `.claude/`、`.codex/`、`.mcp.json`、`.pi/`；本轮保留。
- 真实入口：`http://127.0.0.1:10086/`；`/api/runtime/status` 返回 `mode=rcc`、`state=ready`、`connected=true`、`providerState=ready`。这些值只证明连接/就绪，不能证明具体任务正常。
- 已核对在线 `entry.js` 与 `task-dashboard.js` 的 SHA-256 和本工作树一致，分别为 `0060a2bf10a47a52c4e3a378df8eb1631edc78351ea9c5ebb4102597f0181b7a`、`8edc8a7e9c501f7328bfb6ab46fad1b7964348312133f31c16e37085de494fee`。其他在线资产、运行 binary 与源码 SHA 的等价性未逐项证明。
- DSH 源码：`/Volumes/extension/code/dsh@639ed015397290b3745d163aafe02ffee4aa3f84`；已安装入口 `/opt/homebrew/bin/dsh`。本轮未启动或修改 DSH；参考 UI 行为来自用户截图，源码用于核对实现责任。
- 草稿实测：`interaction-43` / `draft-36`。通过首页输入「只读列出根目录 Markdown 文件，仅生成草稿、不确认、不执行」；真实 interpret 请求耗时 **18496.2ms**。2026-10-02 17:28:53 PDT 在途采样：`document.getAnimations()` 为空、无 `aria-busy`、仅禁用原按钮、无轮次/时间/等待对象，顶部仍显示 Provider connected。
- 草稿生成后显示 `create`、规范化输入、事实、决策引用 `sourceRef:ui:entry interactionId:interaction-43`；只有「确认并进入队列」，没有修改或取消。未点击确认。
- 历史受阻样本：`ui-task-implicit-draft-35`。错误包括 `provider tool round limit was exceeded` 和 `provider close is pending`；界面显示「受阻」「失败收拢未完成」。这两项故障本轮未修复。
- 历史成功样本：`ui-task-implicit-draft-33`。结果含 `# HumanAgent` 和 `COMPLETE`，同时混入 function-call arguments 的内部引用；完成页仍说「任务尚未提交给后台」。读取既有成功记录不等于本轮新 E2E。
- 桌面观察尺寸：2674×1842；移动列表尺寸：390×844，页面宽度 390，无页面级横向溢出。两项文本对比度抽样为 4.79:1、5.59:1，达到普通文本 AA；不代表全站对比度检查完成。

本轮证据目录：`/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/humanagent-ui-audit/`。目录日期为 UTC 路径，不改变报告的用户时区日期。主要文件：

| 文件 | 证明内容 |
| --- | --- |
| `draft-generating.png` | 真实生成请求在途时无过程反馈 |
| `draft-result.png`、`draft-result.txt` | 草稿只有确认路径、内部编号外露 |
| `failed-dashboard.png`、`failed-dashboard.txt` | 受阻样本、原始事件与结果污染 |
| `completed-dashboard.txt` | 已完成状态与「尚未提交」文案矛盾 |
| `observation-flow.png` | 十三节点与旧队列串行链 |
| `observation-drawer.png`、`observation-drawer.txt` | 调用误作返回、未知工具状态、summary 污染 |
| `mobile-tasks.png`、`mobile-tasks-measurement.json` | 390px 列表布局抽查 |
| `keyboard-drawer.json` | 首次 Escape 关闭 drawer 后焦点落 BODY；随后纯键盘复测得到相同结果 |
| `contrast-sample.json` | 两项真实颜色对比度抽样 |
| `memory.txt` | 记忆失败页只有 failure ref，缺人类解释与恢复入口 |
| `draft-rejection.json` | 本轮草稿经正式 reject 接口收口 |
| `browser-cleanup.json` | 审计 TaskSpace 30 与本轮创建的 p1 已关闭，无保留或未知页 |

## 3. 发现与修复方向

证据标记：`M-浏览器` 为本轮真实操作或测量；`M-源码` 为当前代码直接读得的事实；未跑对应故障分支的部分明确标为待行为验收。

| 编号/级别 | 触发、证据与用户后果 | 最小修复及唯一责任 |
| --- | --- | --- |
| F01 / P1 | **草稿生成不可见。** `M-浏览器` 首页真实等待 18.5 秒，仅按钮禁用；`M-源码` `entry.js`、`task.js` 没有运行轮次面，`dashboard.js` 独有 progress spinner/timer。三个入口都没有草稿生成 turn 历史。用户无法分辨正在处理、等待模型还是请求失联。 | 将新建交互收敛到同一流程 owner；显式整理提供 typed 进度/请求/轮次投影；所有入口复用同一状态栏与对话/轨迹组件。阶段由真实事件推进，计时器只表示已等待时间。 |
| F02 / P1 | **人类信息混入技术引用。** `M-浏览器` 草稿显示内部 interaction/source 编号；看板输出与节点 summary 包含 `response.function_call_arguments.done`、call ID、digest；Memory 显示 `failed`、`memory-agent-source-invalid`。成功结果中的 Markdown 作为普通文本显示。`M-源码` coordinator 的 `recordProviderEvent()` 把 output refs 合并进 task output。 | runtime/adapter 保持文本输出、工具事件、证据引用的 typed 区分；UI projection 提供人类摘要与技术详情。结果渲染受支持的 Markdown；原错误语义与完整证据在详情保留。不得在页面用正则删编号或从日志重建状态。 |
| F03 / P1 | **轨迹把调用当成返回。** `M-浏览器` drawer 每条显示 adapter 名、未知状态、「工具返回：调用工具 bash」。`M-源码` `service.ts::observationToolSteps()` 只筛 `provider.tool`，以 owner/source 作工具名、以 call summary 作 returned，未关联 `provider.tool-result`。 | 修 service/projection 的事件关联：以 `callId` 关联 request/result，以 `toolId` 作工具名，以独立结果状态和 output reference 作返回；展示完整参数、返回、错误与耗时。不能只改标签掩盖语义错误。 |
| F04 / P1 | **最近事件无法承担完整轨迹。** `M-源码` coordinator dashboard 与 UI projection 均只取最后 20 条；看板无历史加载、检索、turn 分组和条目展开；格式化时间精确到分钟。`M-浏览器` 同一分钟多条 model/tool 事件无法区分请求和轮次，drawer 仅摘要/引用。未认定底层历史已经丢失。 | 保留最近事件作为摘要；正式轨迹从既有 typed 历史/事件查询公开边界分页，显示 `hasMore` 和明确缺口；按真实轮次组织，时间到秒、详情保留精确时间与 seq；输入、调用、返回、最终输出可回溯。 |
| F05 / P1 | **草稿没有修改闭环；取消也未接后端。** `M-浏览器` 首页仅确认；`M-源码` Dashboard 只有确认/取消，取消只清本地变量；Task confirmation 只有继续。后台有 reject 和 proposal，`ExplicitIntake.revise()` 只改 proposal，未解决原输入/规范化目标的修订及旧确认失效。任务列表「编辑」仅改标题。 | 草稿提供「修改任务 / 按此草稿提交 / 放弃」。结构字段与补充要求都进入同一 revision owner，确认绑定最新 revision，旧提交显式拒绝；保留旧草稿和差异。放弃调用正式 reject 并等待 closure receipt；列表改名与目标修改分开命名。 |
| F06 / P1 | **旧分类与错误拓扑仍在产品主线。** `M-浏览器` observation 固定十三节点，未选 interactive/research/maintenance 分支显示「已创建」，并连成串行链。`M-源码` admission 有四类队列，当前 `classifyConfirmedRequirement()` 实际只按 taskRef 选 interactive/execution；`observation.js::buildFlow()` 按 row 相邻连接，没有真实依赖边。正式任务入口没有单次/定时/周期选择。 | 产品改为执行类型选择与实际运行流程；真实依赖来自 runtime projection，UI 不用显示排序推断拓扑。先审计队列的真实调用与必要性，修改唯一 owner；确认失效实现后移除。内部资源准入与任务关联按实际职责保留，不再作为用户必走的四种分类。 |
| F07 / P1 | **同步与新鲜度未闭环。** `M-源码` 看板 SSE 监听缺 `provider.tool-result`；有 operationId 后停止观察计时；onerror 只声明「将使用 projection 恢复」，没有相应重新读取动作；refresh 错误被空 catch 吞掉。任务列表和 Memory 初始加载后没有持续状态订阅/观察。未在本轮中断真实执行来证明所有故障结果。 | 在现有观察 owner 中定义连接、重放和重新读取规则，补结果事件及错误可见性；页面显示最近业务事件、最近同步时间和数据新鲜度。以 event identity/seq 去重并处理重放；连接中断不能伪装任务失败，也不能继续宣称实时。不得用多处轮询/第二事件真源补偿。 |
| F08 / P1 | **状态、结束与下一步语义不一致。** `M-浏览器` 已完成任务仍说「尚未提交」；受阻页给技术 ref 与 Retry Stop，未解释「执行失败、仍在释放资源」及其影响；Provider ready 与 task blocked 同时出现却没有明确作用域；Memory 失败无可理解原因/恢复动作。 | 状态栏分别呈现任务业务状态、等待对象/收拢状态、连接新鲜度；action copy 由 lifecycle 与 allowedActions 的唯一投影生成。成功、失败、受阻、暂停、停止、取消与结果是否可用各有明确说明。只有收拢 receipt/checkpoint 才显示已停止；没有合法动作时直说需要何种处理。 |
| F09 / P2 | **drawer 关闭后键盘焦点丢失。** `M-浏览器` 鼠标打开/Escape 关闭及 focus→Enter→Escape 复测均落到 BODY；源码虽有 lastTrigger.focus，实际仍不满足返回触发节点要求。根因本轮未完成干预证明。 | 由 drawer owner 保留稳定触发节点身份，在当前有效 DOM 中恢复焦点；查清重绘与 close 的顺序后修复。覆盖关闭按钮、Escape、重新投影、面包屑返回。 |
| F10 / P2 | **减少动态效果没有覆盖 progress spinner。** `M-源码` runtime.css 的 reduce media rule 只缩短 transition，后定义的无限 spinner animation 不受影响；Observation 有自身 motion guard。 | 同一动效 owner 补动画的 reduced-motion 规则，保留静态状态与时间说明；计时不进入每 100ms 播报的 live region。待真实 reduced-motion 浏览器验收。 |

本轮通过的局部检查：390px 任务列表无页面级溢出；两项对比度抽样达 AA；drawer 可用 Escape 关闭。不能把这些局部通过扩大成整站无障碍 PASS。移动列表筛选横向滚动的发现性、200% 缩放、短屏 drawer、长轨迹性能须进入改造验收。

## 4. 两条产品设计原则

### 4.1 人类可读，轨迹完整

默认回答四件事：**正在做什么、目前得到什么、是否需要我决定、我能做什么。** 一条更新只承载一个变化；明确限制、错误、交付物与决策不能为了简短而省略。

每个显式大脑/执行/审核/记忆的真实工作卡片，复用同一个结构：

```text
显式大脑     正在生成草稿 · 第 1 轮 · 等待模型返回 · 已等待 18 秒
对话 | 轨迹                                      最近同步：刚刚
─────────────────────────────────────────────────────────────
对话：你的输入、助手可公开更新、澄清问题、草稿/结果、需要你做的决定
轨迹：按真实轮次排列的输入、助手输出、工具调用、工具返回、状态事件
底部：与当前状态相符的输入或操作；阅读历史时显示“有新更新”
```

以上是目标结构示例，示例轮次和时间不是 runtime 事实。没有公开轮次数据就明确未提供，不能让前端自造计数器。

**对话**只展示用户消息、可公开助手输出、语义明确的进展和决策卡。重复的「prepared model output」等技术通知归入轨迹；需要输入的问题保持可操作并说明为何阻塞。完整结果支持 Markdown、代码复制和交付物链接。内部编号、raw transport、长 JSON、digest 默认在详情，不挤占对话。

**轨迹**默认按时间顺序展示紧凑行，分类为用户输入、助手输出、工具调用、工具返回、状态事件；错误是对应条目的状态，不混淆其类型。内部上下文事件只有真实且可公开时才在详情中显示。

推荐行格式：`17:28:53 · 第 1 轮 · 工具调用 · file.read · README.md · 执行中`。对应结果独立保留时间、状态与摘要，并关联同一 callId。展开后查看完整参数、授权范围内的返回、原错误、开始/结束/耗时、来源与证据。缺失字段显示「未记录」；不能显示推算时间或伪结果。

支持按轮次/工具/状态筛选、搜索、加载更早历史、复制与跳转证据；顶部时间概览可随后加入，不阻断完整事件账本。长内容可折叠和分页，不能永久裁剪。敏感值遵守既有边界，真实工具内容与 transport 凭据不能混为一谈。无需制造或公开私有思维链。

对话与轨迹共享事件来源、状态栏和定位身份；切换标签保留各自阅读位置。接近末尾才自动跟随，阅读历史时不抢滚动或焦点，显示新更新入口。

### 4.2 状态可见，不靠动效猜测

动画只表达活动，不能证明活性。状态栏至少包含真实阶段、当前动作/等待对象、进入该等待的时间、最新事件与同步时间；这些事实由 typed runtime projection 提供。

| 场景 | 人类说明 | 动效与合法操作 |
| --- | --- | --- |
| 生成草稿、执行工具、生成结果 | 正在做的事、请求/轮次、已用时间 | 局部活动提示；只提供正式支持的取消/停止 |
| 排队/资源等待 | 在等资源或前序任务；有真实位置才显示位置 | 排队状态，不伪装模型正在思考 |
| 需要补充/确认 | 明确问题、建议、影响和用户选择 | 停止活动提示；输入/修改/提交 |
| 等待定时/下一周期 | 下次日期、时间、时区、规则 | 静态等待；修改时间/暂停后续触发 |
| 长时间没有新业务事件 | 无新进展的时长；最近一次成功同步 | 仍保持当前状态；查看详情/合法停止，不自行判定死锁 |
| 连接中断/数据过期 | 已保存进度与最后同步；当前状态尚未刷新 | 显式重新连接/刷新；不重复创建执行 |
| 执行失败、收拢中 | 做到哪里、原失败原因、资源是否释放 | 收拢状态与合法重试收拢；不先写“已停止” |
| 成功、已停止、取消、受阻 | 结果与恢复责任，下一步是否可用 | 停止活动提示；按真实 allowedActions 展示动作 |

不设置「超过十秒就失败」等模型调用的假超时。只有正式 runtime 超时/错误事件改变任务终态；界面可以报告无进展或数据过期，不能自作业务裁决。未知进度不显示伪百分比。记录任务总耗时与当前等待耗时，避免换阶段重置后误导。

## 5. 草稿修改与执行类型

### 5.1 草稿评阅是完整交互节点

流程：`输入 → 生成草稿 → 阅读/修改 → 最终提交 → 队列/任务 → 执行状态与结果`。

草稿固定呈现目标、范围/限制、交付物/验收、执行类型、所需权限；无需用户理解 normalizedInput、intent 或 decisionRefs。缺少必要内容时明确提问，不把缺项藏在技术字段。

- 「修改任务」原地打开目标、范围、交付物和执行类型；也支持一句话补充/纠正并重新整理。
- 保留原输入、当前草稿和修改差异；生成中不覆盖用户正在输入的补充；失败保留输入与上一版可读草稿。
- 取消编辑返回当前草稿，不取消任务；「放弃草稿」走正式拒绝/closure 边，失败可见且可继续处理同一请求。
- 修改由 intake/revision owner 管理，确认绑定当前 draft/revision；旧按钮、并发提交、重复点击不能执行旧目标或产生重复任务。现有 revise 只变 proposal，不足以声称目标/范围已经一致修订。
- 任务已运行后改变目标/范围/方式，走已有显式需求变更及确认路径；改名是另一个轻操作，不能冒充目标修改。

**确认口径**：本轮用户要求可修改草稿，目标界面将「生成草稿」明确限定为预览，将「创建并执行」或「保存执行安排」作为新任务的最终表单提交/唯一授权点。现行 AGENTS 要求新建表单提交本身即确认、不再第二次确认；实施时须同步唯一产品入口与对应契约，保证真正提交一次即可排队。不能靠 auto-confirm 偷渡授权，也不能自动执行后再显示“待修改草稿”。已有任务的目标/范围变更仍独立确认。

### 5.2 用执行类型决定触发，业务任务继续正常编排

| 执行类型 | 必要配置/人类预览 | 实际行为与操作 |
| --- | --- | --- |
| 单次执行 | 「提交后执行一次」 | 正常排队、准入、执行、收拢、结果 |
| 定时执行 | 一次性日期/时间、明确时区；显示完整触发时间 | 到时产生一次真实执行；修改/取消安排与停止在途执行区分 |
| 周期执行 | 周期规则、时区、开始时间、结束条件；预览接下来 3 次触发 | 每次 occurrence 有独立运行记录与结果；显示本次/下次；暂停或取消未来触发不自动停止在途执行 |

周期结束条件按真实支持能力提供次数、截止时间或直到目标完成；不要提前暴露未接通选项。忙时策略使用既有 typed busy policy，并向用户解释本次跳过/等待及下一次，不静默补跑。重启、错过触发、夏令时、修改规则的语义须由调度 owner 给出，前端只展示和提交。

已发现 `Subscription/Occurrence/Reminder/SchedulerLease` 契约与 `SchedulerPatrol` 类。**这不证明正式 WebUI 已具备持久化定时/周期调度。** 编码前必须核实实际计划保存、触发、准入、唯一 lease/fencing、重启恢复、取消和结果查询的完整路径。能力缺失停在补链；不能用浏览器 setInterval、sleep、SSE subscription 或 DSH schedule 替代 HumanAgent 的正式调度。

旧队列分类与执行频率不是同一概念。先按本轮产品要求校正真实模型，再核实旧分类中哪些有当前业务职责、哪些已失效；只删已确认失效的真源实现与引用。不能将四个 queue 名改成三种时间模式而保留错误分支。

## 6. DSH 参考与项目 owner

采用用户截图中「稳定状态区 + 对话/轨迹分离 + turn 组织 + 工具 lifecycle + 局部活动提示」的交互，不以同色或同布局作为完成。

| DSH 本地参考 | 可复用的交互责任 | HumanAgent 落点 |
| --- | --- | --- |
| `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx` | 共享会话外壳与 tab 语义 | UI 工作卡片/节点 drawer 的共享外壳 |
| `packages/client/ui-chat/src/client/chat/RunningStatus.tsx` | 真实运行时长、局部活动提示，时间 tick 不反复播报 | 新建草稿和每个实际工作节点的状态栏 |
| `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`、`trajectory-record.ts` | 按 turn 组织、工具 request/result、展开完整内容、滚动跟随、早期历史 | 正式 typed 轨迹投影与 UI 账本 |
| `packages/client/ui-trajectory/src/client/trajectory-tool-definition.ts` | callId 关联真实调用与结果 | HumanAgent service 的工具 lifecycle 投影 |
| `packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx` | 时间范围与类别概览，只有真实时间才显示 | 轨迹增强；不先于完整账本 |

`TrajectoryCell.tsx` 已标 legacy，不能把其保留外形当成当前主实现。HumanAgent 保持现有原生 JS/CSS 产品栈；不因参考采用 React 就迁移框架或引入第二套组件/状态系统。

唯一责任：`packages/core` 管 lifecycle/规则；`packages/runtime` 管 intake、编排、请求/工具事件与调度接线；`packages/contracts` 管输入/执行/调度的 typed 公共契约；`packages/app` 只组装和提供正式 API；`packages/ui/contracts`、`packages/ui/projection` 管人类/轨迹投影；当前被服务的 `docs/ui/*.js/css` 是产品壳。Provider codec 仍归 provider adapter，UI 不读原始 Journal/DSH/transport。

## 7. 实施顺序与可派发任务

依赖：`A 能力与设计闭环 → B 真源/事件/修订 → C UI 一致交互 → D 真实浏览器验收 → E 独立架构 review/交付/清理`。执行类型的真实触发与历史账本必须先具备可验证来源，UI 才能作对应承诺。

| 工作包/唯一 owner | allowed paths / 禁止范围 | 交付与完成条件 | 测试与实际入口 |
| --- | --- | --- | --- |
| A：模型/DAG owner | 既有 `docs/dagpipe/` 图及对应设计；只读能力检查。不写产品代码 | 校正执行类型、草稿修改、观察及每个终点；复用 explicit-requirement/serve-task/observation-read 和三类 Dashboard E2E graph。列出真实入口、依赖、成功/失败/阻塞/取消/清理证据；`dagpipe graph validate` 通过，未知能力先确认，独立设计 reviewer PASS | 使用项目既有 `pnpm dagpipe:validate`；核实调度公开 consumer 与实际持久化，不以契约类型当功能完成 |
| B1：intake 与执行类型 owner | `packages/contracts`、`packages/core`、intake/admission/调度相关 runtime、其对应测试；不改 UI、不改 provider 配置 | 草稿 revision 与一次最终提交一致；旧确认拒绝、重复提交幂等、正式放弃收口；三类执行策略经正式入口保存/触发，能力缺口显式暴露 | `pnpm test:contracts`、`pnpm test:explicit-brain`、受影响 runtime suites；真实公开 consumer 覆盖修改后提交、旧 revision、定时触发、周期暂停/取消、重启恢复 |
| B2：事件与投影 owner | runtime 事件、`packages/ui/contracts/projection`、`packages/app/src/ui-runtime/service.ts/server.ts` 的相关范围及测试；不修改 B1 的规则/模型区 | 显式草稿与执行都能观察真实请求/轮次；文本/工具/证据分离；call/result 关联、分页、seq/重放与同步状态完整；修误作返回的唯一函数 | `pnpm test:provider`、`pnpm test:ui`、受影响 app/runtime suites；经公开 API 串通请求→调用→返回→收拢，负向覆盖失败、缺结果、重复/乱序/断线 |
| C：产品 UI owner | `docs/ui/` 产品 JS/CSS 与 UI 测试；不改业务真源 | 三个输入入口复用同一交互；全部工作卡片状态栏/对话/轨迹一致；草稿修改、三种执行类型、合法动作、Markdown 结果、新鲜度、键盘/motion 完整 | `pnpm test:ui`；作者用重建候选的真实浏览器覆盖成功/失败/澄清/修改/取消/慢请求；检查 390/768/1440、短屏、200% 缩放、键盘/reduced-motion |
| D：验收 owner | `tests/app/dashboard-e2e/`、受影响验收文档及证据；不替作者 debug，不降低标准 | 三类真实任务均有 task/run ID、候选 SHA、截图、多个有意义 turn、独立工具请求/返回与结果；新流程分支及资源收口齐全 | 依次执行 `pnpm e2e:dashboard:web-search`、`pnpm e2e:dashboard:local-file-search`、`pnpm e2e:dashboard:aitest`；新增定时/周期真实公开入口验收，不用 fake 代替 |

派发时把文件所有权缩到具体互斥范围：B1/B2 都可能触及 contracts 或 runtime，先交付共享契约，再由其余 owner 实现消费者；不得照此表同时写同一文件。实现与独立 review 分给不同 agent；作者先 debug/测试/E2E，再启动架构 review。各 peer 从最新 origin/main 的外置 clean worktree 执行，回传精确 candidate SHA、changed files、测试数、真实入口证据、review PASS 与资源清理核对。

图的目标语义：输入/草稿节点内完成修改交互；最终提交后执行策略选择一个合法触发；触发合流到任务准入→执行→收拢→结果/责任收口。周期的每次触发启动独立 SESE occurrence，不在跨功能 DAG 中画回边。失败、取消、阻塞保留其正式责任和清理终点。本文是计划，不能替代仓内 graph 或 graph validate/review receipt。

## 8. 验收矩阵与完成判据

| 路径 | 浏览器必须见到 | 真源/清理证据 |
| --- | --- | --- |
| 生成草稿、慢首响应、多次澄清 | 点击后立即有状态；真实请求/轮次；等待对象与时长；澄清上下文保留 | interaction/revision/请求事件关联；慢请求不伪失败 |
| 修改草稿→提交、旧确认、重复点击 | 显示新目标/范围/类型与差异；只派发新版本一次 | 正式 revision 与幂等 receipt；旧提交显式拒绝 |
| 放弃草稿、生成失败后继续 | 关闭原因可见；失败保留输入和上一版；继续同一请求 | rejected/closure receipt；取消请求不冒充资源已释放 |
| 单次、定时、周期 | 真实执行类型；计划时间/时区、下次触发；每次结果可回溯 | 实际计划与 occurrence、公开 consumer、持久化/重启、pause/cancel/fencing 证据 |
| 真实模型→工具→返回→最终结果 | 人类更新克制；轨迹完整，有秒级时间和分类；工具 request/result 分开 | callId、seq、toolId、输出与 evidence；大输出分页/引用可打开 |
| 执行失败、停止与收拢失败 | 原因、完成范围、正在释放/未释放、下一步；停止后活动结束 | 正式 stop/checkpoint/settlement；在途副作用与恢复责任真实 |
| 断线、重放、刷新、列表切换 | 连接与数据新鲜度明确；不丢历史/重复条目；读历史不抢滚动 | cursor/seq/identity、projection freshness；不创建第二执行 |
| 工作节点 drawer/对话轨迹切换 | 各卡同结构；Escape/关闭/返回焦点正确；阅读位置保留 | 实际节点身份/依赖；只有投影事实才显示状态 |
| 窄屏/短屏/长内容/减少动态效果 | 主要状态、当前决定、错误始终可读；键盘/缩放可用 | 真实尺寸截图、焦点检查、对比度、reduced-motion；未测项不宣称 PASS |

三类真实 Dashboard E2E 与 cleanup 继续遵守 `docs/ui/dashboard-e2e-acceptance.md`。适用证据绑定同一候选 SHA；更新 main 后重跑受影响项；作者验证全绿后独立架构 review。图准入、源码测试、浏览器行为、候选、merge/push、安装/runtime 与资源清理分别出示证据。缺任一适用项标 `INCOMPLETE/UNVERIFIED`，不能用「组件存在」「Provider connected」「mock 成功」替代。

## 9. 本轮状态与资源收口

| 节点 | 结论 / 输入 / 证据 | 下一步 |
| --- | --- | --- |
| 基线与历史恢复 | 当前源码 SHA/已有 dirty 状态已核对；前序只有候选/单测不能证明 UI 完成的教训已复用；关键在线资产哈希一致 | 用本轮实际页面证据评估，不沿用历史修复结论 |
| 真实交互复现 | interaction-43 实测 18.5 秒无过程；草稿缺修改；已有成功/失败/观测/Memory 状态已读取，截图与文本在证据目录 | 按 F01–F10 与 owner 规划 |
| 审计与方案 | 10 项合并去重发现；两条设计原则、执行类型、责任/依赖、验收矩阵已落本文件；未改产品代码 | 下一实施轮先 A 能力/DAG 准入，再 B/C/D/E |
| 草稿测试收口 | 正式 `POST /api/explicit/interactions/interaction-43/reject` 回执 `state=closed`；随后 GET 为 `state=rejected`，history 结束于 rejected，无 confirmation/dispatched | 保留追加式历史与审计 receipt，不手删持久化真源 |

本轮没有创建 worktree、候选 binary、后台进程、forward 或 tmp 脚本；只创建审计文档、自己的浏览器页与交付证据。收尾 `task.finish({keep:[]})` 回执为 `closedSpace=true`、`closedManagedLabels=[p1]`、无保留页；任务总数仍为原有 5 项（2 waiting、3 completed），没有新增执行任务。证据目录作为本次交付保留；既有任务与既有资源未修改。实现、调度能力补链、重建/安装、全部真实 E2E、架构 review、commit/merge/push 都不是本轮完成项。
