# UX 修复接口与测试映射（G，2026-10-21）

状态：`DESIGN-READY`。本文件只落实计划 §5 的最小接口语义、禁止推断和 §8 的测试映射，不实现产品代码、不修改需求。基线为 `origin/main e4575a10`；受影响图的设计记录同日更新，并通过 `pnpm dagpipe:validate`。

本文件是 C、A1、A2、R、I、S、H、U1、U2、W0–W6 的直接输入。名称是拟定契约名；实施时优先复用“复用类型”列中的既有符号，只有无法表达精确语义时才增加“新增最小面”列中的类型。

## 1. 使用规则

1. 事实只能来自声明 owner。读取组合层（App/UI）不生成第二事实源，不从标题、时间邻近、角色顺序、`task.input`、`task.updatedAt`、`record.output` 或页面本地连接状态猜业务事实。
2. 缺失、不可用、未记录和未知保持显式。空集合只表示 owner 确认没有条目，不表示读取失败或尚未实现。
3. 精确引用贯穿 board、session、关系、控制与 URL。展示分类不等于运行身份；board 只用于分组，不能作为权限、读取范围或 instance 身份。
4. 读取不触发控制。刷新、Back/Forward、关闭抽屉、收起详情和导航离开都只形成新读请求，不提交批准、拒绝、steer、stop 或新建任务。
5. 本文件中的“待 O1”“待 O2”表示来源或控制对象的精确 owner 尚未由观察结论确认。相关接口可以先形成为最小结构，但不得把候选 owner 写成已证实事实。

## 2. 八个最小接口

### 2.1 精确引用（`ProductTargetRef`）

| 项目 | 内容 |
|---|---|
| 必需语义 | 判别 `interaction`、`session`、`execution-instance`；携带 owner 已给出的真实 ID、必要 task 关联和 `projectKey`/`mode` 读取范围。 |
| 禁止推断 | 不把 `taskId`、`sessionId`、`instanceId` 合成一个字符串；不从 role、标题、展示 label 或 board 生成身份；不把 `controlTarget` 当读取范围或权限。 |
| 复用类型 | `TaskId`、`ScopeRef`、`TaskIdentityScope`（`packages/contracts/src/index.ts`、`task-identity.ts`）；`RuntimeReadScope` 的 task 分支（`packages/ui/contracts/runtime.ts:393`）；`TaskExecutionInstanceIdentity`（`packages/contracts/src/agent-activity.ts:24`）；`RuntimeAgentActivityInstanceProjection`（`packages/ui/contracts/runtime.ts:557`）。 |
| 新增最小面 | 一个 discriminated union：`{ kind: 'interaction', taskRef, scope }`、`{ kind: 'session', sessionRef, taskRef?, scope }`、`{ kind: 'execution-instance', instance: TaskExecutionInstanceIdentity, taskRef, scope }`。session ref 的权威词汇待 O1；不得先造统一 session ID。 |
| 图节点 | `human-readable-ux-reading.truth/semantic`；`observation-read.load_task_truth/project_semantic_views`；`task-liveness-display.read_task_dashboard/forward_to_work_card`；`task-grant-control-entry.verify_controllable_task_target`。 |
| T 映射 | T2（同名任务/跨 scope 隔离）、T3（关系节点去重）、T4（URL 恢复）、T7（精确目标介入）。 |
| 后续消费者 | C 定义；A1 组合；U1 写入位置；U2 进入 session；R 连接关系；I/H 提交动作。 |

### 2.2 板块索引（`ProductBoardIndex`）

| 项目 | 内容 |
|---|---|
| 必需语义 | 一个 owner 事实集合同时驱动左侧五板块卡片和板块 dashboard。`board` 只取 `interaction`、`orchestration`、`inspection`、`execution`、`memory` 展示分类。每个条目按权威状态进入 Live、历史或未知；未知不得被算入 Live。 |
| 禁止推断 | 不用 `updatedAt`、role 名、是否存在 EventSource、页面是否打开或 `task.output` 判断 Live；不用 board 分类代替 session/instance 身份；不因条目为空就伪造“无 Live”结论，读取失败必须保留 unknown/failure。 |
| 复用类型 | `RuntimeTaskListProjection` 的 running/waiting/completed/stopped/draft/failed 分组（`packages/ui/contracts/runtime.ts:298`）；`RuntimeTaskRowProjection`（`:234`）；`RuntimeProjectTaskReadRow` 的 `basis: live-runtime | durable-history`（`:403`）；`RuntimeReadResult`（`:389`）；`RuntimeLivenessProjection`（`:941`）；`MemorySessionEvidence`（`packages/contracts/src/index.ts:516`）仅用于确认记忆 session 不能由候选补造。 |
| 新增最小面 | `ProductBoardIndex { scope, observedAt, boards: ProductBoardSection[] }`；`ProductBoardSection { board, live: ProductBoardItem[], history: ProductBoardItem[], unknown: ProductBoardItem[], failures?: RuntimeReadFailure[] }`；`ProductBoardItem { ref: ProductTargetRef, title, displayState, liveness?, publicResult?, evidenceRefs }`。Item 不接受以 `updatedAt` 作为 Live 依据。 |
| 图节点 | `human-readable-ux-reading.truth/purpose/necessary`；`observation-read.load_task_truth/project_semantic_views`；`task-liveness-display.derive_liveness_facts/project_liveness_state`；`memory-curation.wake_memory_agent/read_task_evidence`。 |
| T 映射 | T2（多 Live/身份隔离）、T10（空数据/正常数据不伪装）、T11（来源缺失时持久未知）。 |
| 后续消费者 | A1 产出唯一集合；S 薄接线；U1 渲染；W1/W5 使用；H 只暴露读取入口。 |
| 待观察 | O1 必须给出五板块各自的真实来源、Live/历史分类依据和最早缺失点。未给出前，board section 不能宣称完整。 |

### 2.3 消息（`ProductMessage`）

| 项目 | 内容 |
|---|---|
| 必需语义 | 携带已有 event ref（或 owner 原始引用）、actor/source、原发生时间、正文、适用目标 ref 和证据引用。actor/source 使用 owner 已解码值；时间使用 event/provider 报告时间；缺少字段保持缺失或显式 unknown。 |
| 禁止推断 | 不用 `task.input` 推断 human；不用 `task.updatedAt` 代替消息时间；不因 role、board、标题或显示顺序推断 actor；不把 provider 私有推理或未提交文本变成公开消息；不从 raw 日志重建控制决定。 |
| 复用类型 | `InteractionTraceEntry` / `InteractionTraceKind`（`packages/contracts/src/tool-execution.ts:622,632`）；`RuntimeTaskEventProjection`（`packages/ui/contracts/runtime.ts:318`）；`SemanticEventRef`（`packages/contracts/src/semantic-observation.ts:52`）；`CanonicalContextEvent`（`packages/context-events/src/types.ts:109`）；`TaskInput.source` 只在确实是 TaskInput 时使用。 |
| 新增最小面 | `ProductMessage { ref, targetRef, actor: { kind: 'human' | 'agent' | 'system' | 'unknown', sourceKind, sourceRef? }, occurredAt?: string, occurredAtUnavailableReason?, text, evidenceRefs }`。actor 的精确来源词汇待 O1；没有 O1 证据时只能使用 `unknown` 并保留 sourceRef，不得猜测 human。 |
| 图节点 | `human-readable-ux-reading.truth/semantic/necessary`；`observation-read.load_event_history/normalize_context_events/pair_context_events/browser_view`；`context-events.event_source/normalize/consume`。 |
| T 映射 | T1（来源真实性/时间）、T2（跨 session 不串消息）、T11（冷恢复保留 actor/目标）。 |
| 后续消费者 | O1 给来源；D 在最早正式输入/运行入口补录；A1 组合；U2 渲染；S 删除错误 human 投影。 |

### 2.4 关系（`ProductRelation`）

| 项目 | 内容 |
|---|---|
| 必需语义 | 精确 `source`/`target` ref、关系种类、权威来源 owner 和证据引用。节点按精确引用去重；关系种类只使用 owner 已有 typed lineage。 |
| 禁止推断 | 不按标题、邻近时间、固定角色顺序、成员关系、board 分类或 ID 前缀补边；不把 actual execution graph 的内部节点顺序当产品关系；不把没有提交的 checkpoint 或任意最新 checkpoint 当已提交关系。 |
| 复用类型 | `RuntimeTaskExecutionLineage`（parentTaskId/subscriptionId/occurrenceId，`packages/ui/contracts/runtime.ts:287`）；`TaskIdentitySource`（`requirementId` 等，`packages/contracts/src/task-identity.ts:10`）；`PairedExecutionGroup`（`packages/contracts/src/semantic-observation.ts:79`）；`TaskActualExecutionContainingLocation` / actual-execution-graph 的 typed 引用（`packages/contracts/src/actual-execution-graph.ts`）。 |
| 新增最小面 | `ProductRelation { source: ProductTargetRef, target: ProductTargetRef, kind, sourceOwner, evidenceRefs }`。`kind` 首批只允许 `requirement`、`subscription`、`occurrence`、`child-execution`、`checkpoint`、`review`、`planner`、`tool-pair`、`unknown`；新增种类须有 owner 证据。 |
| 图节点 | `human-readable-ux-reading.semantic/purpose`；`observation-read.project_semantic_views/project_status_and_actions`；`context-events.pairing`；`task-liveness-display.forward_to_work_card`。 |
| T 映射 | T3（同名无关记录不补边）、T7（关系目标与权限分离）、T11（冷恢复保留关系来源）。 |
| 后续消费者 | O1 给已有 refs；A1/A2 提供事实；R 纯投影；U1/W2 渲染与切 focus。 |

### 2.5 公开结果（复用 `PublicOutputPublicationProjection`）

| 项目 | 内容 |
|---|---|
| 必需语义 | 复用公开提交 projection 的 `state`、`commits` 和 `publicCommitWatermark`；每条 commit 保留 `commitId`、`journalSeq`、`recordDigest`、`text`；pending/unavailable/unknown 保留已有确认 commits 和边界。无提交时不画空结果块。 |
| 禁止推断 | 不以 provider 文本、`task.output`、`record.output` 或最新任意 checkpoint 代替已提交结果；不从空 commits 推断 succeeded；不截断、重排或改写 commit 文本；不因待定状态清空已确认结果。 |
| 复用类型 | `PublicOutputPublicationProjection`（`packages/ui/contracts/runtime.ts:359`）、`PublicOutputCommitProjection`（`:352`）、contracts 的 `PublicOutputPublication` / `PublicOutputCommit`（`packages/contracts/src/semantic-observation.ts:164,178`）；`TaskOutputProjection` 只在 TaskDetail 既有边界使用，不得作为公开结果真源。 |
| 新增最小面 | 不新增结果类型。A2 只返回所选 binding 的现有 `PublicOutputPublicationProjection`；若需要携带 binding，只能在 App 组合层引用已有 binding，不复制 commit 字段。 |
| 图节点 | `human-readable-ux-reading.necessary/present`；`observation-read.load_task_truth/project_status_and_actions/browser_view`；`task-liveness-display.forward_to_work_card/render_work_card_truth`。 |
| T 映射 | T8（detail/dashboard/semantic/observation 一致）、T10（无结果不画空块）、T11（冷恢复保留提交正文与引用）。 |
| 后续消费者 | A2 选择；S 统一接线；U2/W2 展示；V 做跨入口一致性验收。 |

### 2.6 待决定事项（`ProductPendingDecision`）

| 项目 | 内容 |
|---|---|
| 必需语义 | 只表达真实需要人或正式控制目标处理的对象。携带精确 decision/control target、问题、允许动作、当前状态、revision（有正式控制时）、适用授权和恢复责任。必须区分 TaskGrant 等待、TaskInputRequest、Attention 和系统 blocked。 |
| 禁止推断 | 不将 blocked 自动变成等待人；不为没有 question/options 的对象伪造审批；不把缺 exact TaskGrant 合并成 waiting-for-answer；不把普通 Attention 当批准；不从 `current.nextStep` 文案生成 action；不在 unknown readback 时自动重提。 |
| 复用类型 | `Attention`（`packages/contracts/src/index.ts:754`）；`TaskInputRequest`（`:755`）；`DecisionProjection` / `TaskDetailDecisionProjection`（`packages/ui/contracts/models.ts:46,95`）；`CheckpointControlGrant` / `CheckpointControlGrantRequest` / `CheckpointControlRevokeRequest`（`packages/contracts/src/checkpoint-controls.ts`）；`TaskGrantReadback` / `TaskGrantAuthority`（`packages/runtime/src/admission/task-grant.ts:27,32`）；`TaskGrantControlRead` / `TaskGrantControlReceipt`（`packages/app/src/ui-runtime/task-control.ts:38,46`）。 |
| 新增最小面 | `ProductPendingDecision` 为 discriminated union：`task-grant`（携带 `TaskGrantReadback` 与精确 target，是唯一已证实可继续的批准对象）、`task-input-request`（携带 `TaskInputRequest`，但 O2 已确认该类型无 producer/route/consumer，是死类型）、`attention-decision`（携带 `Attention` 且有真实 decision 依据，但 O2 已确认无公开处置接口）。每支必须有 `question`、`actions`、`state`、`recoveryOwner`；`revision` 只在 owner 提供时出现。 |
| 图节点 | `task-grant-control-entry.verify_controllable_task_target/submit_scoped_task_control/converge_control_receipt_and_readback`；`task-liveness-display.project_liveness_state/forward_to_work_card`；`human-readable-ux-reading.necessary`。 |
| T 映射 | T5（批准后实际继续）、T6（拒绝与关闭分离）、T7（目标/权限）、T10（真实错误与恢复）。 |
| 后续消费者 | O2 确认控制对象分类；C 定义 union；D 补最早控制事实；H/I 接线；S 投影；V 做真实验收。 |
| 待观察 | O2 已确认：`task grant` 有完整正式接口与继续链（grant POST → release → Provider 执行，revoke 走 stop）；`Attention` 有事实但无公开列表/处置路由；`TaskInputRequest` 是死类型；`requiredDecisions` 固定 `[]`、无 question/options 来源。非 grant 对象不得伪造为批准。真实安装后审批闭环 T5/T6/T7 仍 UNVERIFIED。 |

### 2.7 主动介入（`ProductInterventionRequest` / 既有 typed receipt）

| 项目 | 内容 |
|---|---|
| 必需语义 | 精确 target ref 加语义动作。principal 由 server 从正式认证/产品上下文解析；权限由正式控制 owner 判断；返回既有 typed receipt（不回 bool success，不伪造 receipt）。动作只允许正式入口支持的种类。 |
| 禁止推断 | 不接受 UI 自报最高权限、owner、confirmedBy 或 expectedRevision 以外的授权字段；不把所有文本当 steer；不把交互消息当新建任务；不写历史；不在没有 exact target 或正式入口时提交。 |
| 复用类型 | `TaskGrantControlReceipt` / `TaskGrantControlRead`（`packages/app/src/ui-runtime/task-control.ts`）；`CheckpointControlGrantRequest` / `RevokeRequest`（`packages/contracts/src/checkpoint-controls.ts`）；`InteractionDecision.selectedAction` 只作显式 Brain 既有语义，不代替控制 receipt；`UiRuntimeApiError` 为拒绝/失败类型。 |
| 新增最小面 | `ProductInterventionRequest { target: ProductTargetRef, action: 'grant' | 'revoke' | 'stop', payload?, expectedRevision? }`。动作只允许已有正式路径：grant/revoke 走 `/api/tasks/:id/control/grant|revoke`；stop 沿 revoke 的既有 stop/steer 语义。`approve`/`reject` 只作 UI 文案映射到 grant/revoke，不作独立 server 动作。正式 principal 不进入请求体。receipt 直接使用 `TaskGrantControlReceipt` 或对应 owner 的既有 typed result。 |
| 图节点 | `task-grant-control-entry.open_formal_task_navigation/verify_controllable_task_target/submit_scoped_task_control/converge_control_receipt_and_readback`；`explicit-requirement.submit_single_authorization` 仅在新建任务时使用。 |
| T 映射 | T5（批准实际继续）、T6（关闭不误拒）、T7（A/B 精确目标与 server principal）。 |
| 后续消费者 | O2 给正式控制接口；C 定义请求；H 实现 HTTP/principal/target 校验；I 做 UI；V 用受控任务验收。 |

### 2.8 位置选择（`ProductLocation`）

| 项目 | 内容 |
|---|---|
| 必需语义 | 保存 `board`、Live/历史 lane、精确 focus ref 和读取 scope；沿 URL/history 保存，Back/Forward/刷新读取同一位置。位置只描述读视图。 |
| 禁止推断 | 不保存或恢复授权状态；不因刷新重提决定、重启任务或重新执行 steer；不把 `controlTarget` 当读取 scope；不在 URL 中保存 principal 或秘密；不把晚到响应应用到新 focus。 |
| 复用类型 | `RuntimeReadScope`（system/project/task，`packages/ui/contracts/runtime.ts:393`）；现有 URLSearchParams 页面接线（W0/U1 负责统一）；`RuntimeTaskControlTarget` 仅作独立导航范围，不与读 scope 混用。 |
| 新增最小面 | `ProductLocation { board: ProductBoardKind, lane: 'live' | 'history', focus?: ProductTargetRef, scope: RuntimeReadScope }`。URL 编解码必须保留精确 ref 与 scope；无效位置显式未知，不猜 fallback。 |
| 图节点 | `human-readable-ux-reading.truth`；`observation-read.http_api/load_task_truth`；`task-liveness-display.open_task_surface/read_task_dashboard`；`task-grant-control-entry.open_formal_task_navigation`；`explicit-requirement.sensory_inbox`。 |
| T 映射 | T4（位置/scope/BFCache/刷新）、T6（刷新不重提决定）、T7（目标不串）、T9（手机单抽屉与焦点返回）。 |
| 后续消费者 | U1 实现位置；W0 提供共享入口；S/H 提供读取；W1–W6 接线；V 做浏览器验收。 |

## 3. 图设计落点

本次只补节点契约输入输出和设计记录，不新增业务节点，不改任何图的拓扑。七张图仍保持单入口、单出口、全部节点可达、终点闭合。

| 图 | 本次最小修订 |
|---|---|
| `human-readable-ux-reading` | 在 `truth/semantic/purpose/necessary/present` 增加 source、scope、session、publication 和最小展示契约；明确五板块与 session 组合、消息来源和公开结果。 |
| `observation-read` | 保留 task 级 observation truth；增加“产品板块/session 组合由 App 纯组合既有 owner 事实”的边界；明确内部 actual execution graph 不是产品关系链，新增读取入口时才补入口契约。 |
| `task-grant-control-entry` | 在现有四节点上补正式 decision target、decision receipt 和继续执行读回契约；等待期间不造回边，后续读取是新请求。 |
| `task-liveness-display` | 补精确 session/task 归属、真实等待事实和 board-Live 分离；保留页面本地 transport owner。 |
| `explicit-requirement` | 明确新建任务一次确认；已有任务目标/范围/处理方式变更单独确认；steer/stop/权限撤销不进需求队列或 task payload。 |
| `context-events` | 明确事件来源必须由上游 owner 提供；复用归一并配对；不新增逐页 actor 分类器，不从 raw 日志重建控制决定。 |
| `memory-curation` | 明确记忆候选不是记忆 agent session；候选列表不能伪装执行索引；session 读取须有真实 owner 来源。 |

## 4. T1–T11 测试映射

以下映射直接引用计划 §8。测试由后续 C/A/U/W/R/I/S/H/V 任务实施；G 不新增业务测试。每项测试必须对应具体失败模式和可执行反例，未验证时标 `UNVERIFIED`。

| T | 接口 | 具体失败模式 | 必须失败的断言 | 主要图节点 |
|---|---|---|---|---|
| T1 | 消息、精确引用 | 编排流量被标成 human；消息时间被 task 刷新覆盖 | 真实 agent 来源与已认证 human 来源同时输入时，两者不得都为 human；actor 错配或事件时间变成 `updatedAt` 必须失败 | `human-readable-ux-reading.truth/semantic`；`context-events.normalize` |
| T2 | 板块索引、精确引用、消息 | 多条 Live 丢失；role 混成实例；跨 scope 串任务/正文 | 同名不同 scope、同任务多实例场景中，卡片集合与 dashboard 集合不一致、跨 scope 正文串、未知被算 Live 必须失败 | `observation-read.load_task_truth`；`task-liveness-display.read_task_dashboard/project_liveness_state` |
| T3 | 关系、精确引用 | 按标题/时间/角色伪造边；有 typed lineage 却丢边或重复节点 | 同名无关记录不得出现边；typed lineage 记录不得丢失或重复节点 | `human-readable-ux-reading.semantic`；`observation-read.project_semantic_views`；`context-events.pairing` |
| T4 | 位置选择、精确引用 | focus/scope 丢失；BFCache 空白；读取触发写入 | board→session→关联节点→层级返回→Back/Forward→刷新后位置/范围错误、正文空白或出现写请求必须失败 | `human-readable-ux-reading.truth`；`task-liveness-display.open_task_surface/read_task_dashboard` |
| T5 | 待决定事项、主动介入 | 批准只改 UI；等待映射失败；错误目标被 release | 批准后必须有匹配决定/grant receipt 及同目标实际执行进展；无进展、错误 scope 或直接 failed 必须失败 | `task-grant-control-entry.verify_controllable_task_target/submit_scoped_task_control/converge_control_receipt_and_readback` |
| T6 | 待决定事项、主动介入、位置选择 | 关闭/收起/刷新误拒绝；重复提交 | 关闭/收起后决定写请求必须为零且等待事实不变；明确拒绝才有 receipt；晚到批准回执不得作用于新 focus | `task-grant-control-entry.open_formal_task_navigation/converge_control_receipt_and_readback` |
| T7 | 主动介入、关系、精确引用 | UI 标签授予权限；指令误建任务或误 steer；B 被 A 的动作影响 | A/B 同时 Live 时向 A 介入，B 无动作；伪造 UI actor 不改变 server principal；历史不可写；动作与 receipt 一致，否则失败 | `task-grant-control-entry.verify_controllable_task_target/submit_scoped_task_control` |
| T8 | 公开结果 | detail 展示未提交文本；跨 binding 取结果；空结果块 | 保留“未提交文本≠已提交正文”；各入口 commit 正文/refs 一致；pending/unknown 保留已有提交；无提交不画结果块 | `human-readable-ux-reading.necessary/present`；`observation-read.project_status_and_actions` |
| T9 | 位置选择、主动介入 | 抽屉叠加、输入被遮挡、焦点丢失 | 390×844 进入板块、选任务、开关系、换 focus、关闭、输入及审批时，双 carrier、输入不可达或焦点回错必须失败 | `task-liveness-display.open_task_surface/forward_to_work_card`；U1/U2/I 消费页面 |
| T10 | 板块索引、公开结果、待决定事项 | 删除错误恢复；正常数据堆机械字段或空块 | 正常/空数据不出现连接、完整性、空块；真实失败主层有原因与有效恢复入口；按需详情保留原 code/owner；任一相反行为失败 | `human-readable-ux-reading.necessary/present`；`task-liveness-display.render_work_card_truth` |
| T11 | 消息、关系、公开结果、板块索引 | 进程内正确但冷恢复丢失 actor/目标/关系/提交 | 正式 owner 提交后从既有 journal 恢复；actor/目标/关系/已确认提交丢失，或旧记录被伪装成人类，必须失败 | `context-events.event_source/normalize`；`observation-read.load_task_truth`；`memory-curation.read_task_evidence` |

## 5. Owner 文件清单（G 可直接细化的部分）

以下路径是任务合同中已声明的唯一 writer，或其现有 owner。D 的 earliest-source/control 文件清单必须等待 O1/O2 证据，不在此冒充确认。

| 接口/产物 | 预期 writer | 文件 |
|---|---|---|
| 类型与负向断言 | C | `packages/contracts/src/` 中新增的最小 product-read 契约文件、`packages/contracts/src/index.ts`、`packages/ui/contracts/runtime.ts` 及其 contracts 测试 |
| 板块/session 组合 | A1 | 新 `packages/app/src/ui-runtime/product-session-read.ts` 及专属消费者测试 |
| 公开结果选择 | A2 | 新 `packages/app/src/ui-runtime/product-output-read.ts` 及专属消费者测试 |
| 关系投影 | R | 新 `packages/app/src/ui-runtime/product-relations.ts`、`docs/ui/product-relation-view.js` 及专属消费者 |
| 板块与位置模块 | U1 | 新 `docs/ui/product-board-view.js`、`docs/ui/product-location.js` 及专属模块消费者 |
| 人读 session | U2 | 新 `docs/ui/product-session-view.js` 及专属模块消费者 |
| 介入/审批 UI | I | 新 `docs/ui/product-control-view.js` 及专属消费者；页面 owner 负责挂载 |
| App 薄接线 | S | 仅 `packages/app/src/ui-runtime/service.ts` 及该文件本次接线的单一测试文件 |
| HTTP 与正式动作 | H | `packages/app/src/ui-runtime/server.ts`、`docs/ui/runtime-api.js` 及本次 HTTP 消费者测试 |
| 共享壳首批接口 | W0 | `docs/ui/runtime-shell.js`、`docs/ui/runtime.css` 及共享壳专属消费者 |

### D 的待细化 owner 清单

O1/O2 返回后，只把“最早正式输入/运行入口及其既有持久 owner”的具体文件填入本表。当前候选只作核对线索，不构成确认：

| 依赖 | 候选核对位置 | 状态 |
|---|---|---|
| 消息 actor/source/time | `packages/app/src/ui-runtime/service.ts`（inventory/recentInputs）、`agent-activity-read.ts`、`turn-history.ts` 及其直接 intake/journal 来源 | 待 O1 |
| 五板块真实来源 | `service.ts` inventory、`agent-activity-read.ts`、`turn-history.ts` 及记忆 session 来源 | 待 O1 |
| task grant 决策链（已证实） | `packages/app/src/ui-runtime/server.ts`（`/api/tasks/:id/control/grant|revoke`）、`packages/app/src/ui-runtime/task-control.ts`、`packages/app/src/ui-runtime/service.ts`（`verifyControllableTaskTarget`、`releaseGrantedTaskExecution`、`releaseExecution`）、`packages/runtime/src/admission/task-grant.ts`、`packages/adapters/jsonl/src/task-grants.ts`、`packages/contracts/src/checkpoint-controls.ts` | 已由 O2 确认 |
| Attention 事实与处置缺口 | `packages/app/src/attention-journal.ts`、`packages/runtime/src/control/attention.ts`、`packages/contracts/src/index.ts:754` | 已由 O2 确认：有事实、无公开列表/处置路由 |
| TaskInputRequest | `packages/contracts/src/index.ts:755` | 已由 O2 确认：死类型，无 producer/route/consumer |
| requiredDecisions | `packages/app/src/ui-runtime/service.ts`（`taskDetail` 固定 `[]`）、`packages/ui/contracts/models.ts`、`packages/ui/projection` | 已由 O2 确认：展示缺口，无 question/options 来源 |

## 6. 未完成项

- O2 已返回，控制对象分类与正式接口已进入 §2.6/§2.7 和 §5；O1 仍在进行，D 的“最早消息来源/五板块来源/补录 owner”清单保持 `PENDING`，不得用候选路径替代证据。
- 本文件不声称任何产品行为已实现或已验收。T1–T11 的证据、C/A/U/W/R/I/S/H 的实现、真实浏览器验收和安装交付均未完成。
- 图校验只证明受影响图的拓扑、语义标签和 binding 结构合法，不证明运行时行为。
