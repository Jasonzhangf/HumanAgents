# 原生推理逐工具语义规则设计

状态：DESIGN-RULES / D0-A-SOURCE-INVENTORY-COMPLETE / PENDING-TOOL-OWNER-REVIEW。独立 planner 与 D0-A source inventory 已交叉核对主要注册/执行边界；尚未实施提取器、执行语义测试或取得工具 owner 的独立 review PASS。

递进实施步骤与验收以主编排单独维护的实施计划为准；该计划不属于本 docs-only 候选，本文件不复制它。D0-A inventory：`/Volumes/Intel/playground/humanagent/.worker-runs/native-reasoning-d0-20261008/d0-a/tool-inventory.md`。本表是 D0/F-H 的审查输入，不能把列出工具解释成实际可用。

工具身份按 `(surface, tool ID, binding, route)` 识别。同名工具不得跨 Responses Provider、Explicit Brain catalog、Gateway route 和 role template 合并；只有 inventory 标记为当前注册且执行端已接线的具体实例才可清理 raw。Inventory 中的 `exposure-unverified`、`declared-only`、`unsupported-tool` 与 `not-found-within-audited-scope` 各有不同含义，实施时保留原状态，不折叠成成功/失败布尔值。

## 每个实际工具的语义提取规则

实施前生成绑定候选、角色、配置与 capability digest 的实际工具 inventory。区分“注册”“对角色可见”“通过准入”“执行端已接线”。缺 port 的工具保持 unavailable，不能只因模板列出名称就宣称可用。

所有规则共同保存：工具身份与完整执行绑定、原始证据引用/digest、提取器版本、决定性事实、结论范围、失败/unknown、截断或遗漏原因。提取器不能再执行工具、批准状态、提交 checkpoint 或触发控制命令。

以下是已核对工具的逐项规则。未实际暴露的工具按 inventory 标记，不能假定上线。

| 工具 | 历史语义保留与证明边界 |
|---|---|
| Responses `file.read` | workspace/path、读取内容及 receipt 的 output digest/evidence refs；只证明本次读取，不证明之后未变 |
| Explicit Brain `file.read` | 已授权 scope/pathRef 与返回内容；只证明读取注册 workspace 路径，不证明之后未变 |
| Gateway `file.read` | workspaceRef/path、经过 route verifier 的读取 report/output digest 与 evidence refs；不能与 Explicit Brain 或 Responses executor 的 admission/receipt 合并 |
| `file.list` | 查询范围、规则、决定性路径、完整/截断状态；不把限量列表当全集 |
| Responses `file.search` | queryKind、path、query、搜索/发现文件数、命中、`resultsTruncated`、`searchComplete`、unresolved paths 及报告引用；未设置 `requireComplete` 时 `succeeded` 仍可能是部分结果 |
| Explicit Brain `file.search` | query、授权 scope 与返回 matches/complete；当前 port 只做最多 100 个已发现文件的 literal search，不等于 Responses regex/symbol 搜索 |
| Gateway `code.search` | 保留搜索范围、命中、截断、完整度、未解析路径与报告引用；`succeeded` 不自动证明搜索完整。生产 app 暴露未找到；它与 Responses `file.search` 是不同工具实例 |
| `deterministic.inspect` | 保留 operation ID、输入 digest、revision、scope 与 receipt；它只生成确定性检查记录，不读取输入内容或验证外部现实状态。Gateway 注册不等于角色可见或 Provider 可调用 |
| Responses `file.write` | 目标、变更意图、实际结果与返回的 before/after 文本；当前 receipt 不提供 digest。写成功不等于验收成功 |
| Responses `file.edit` | 匹配与替换范围、实际 before/after 文本；当前 receipt 不提供 digest。不能只保存“已编辑” |
| Responses `bash` | 命令意图、cwd、退出/信号、超时/取消、截断输出；继承环境，receipt 不证明子进程/副作用已 settle |
| `todo_write` | 接受的列表修订及变化；模型标 completed 不证明完成 |
| `get_goal` | 实际读取的目标身份、revision 与业务目标；控制状态不从文本推断 |
| `create_goal` | 已接纳/拒绝的操作与目标引用；不能旁路创建 HumanAgent 业务 Task |
| `update_goal` | 修订请求、实际接纳状态与引用；权限及生命周期仍由 owner 决定 |
| Responses `present` | 声明的文件路径/描述与存在性；不提供内容 digest 或 review 状态，声明不等于验收 PASS |
| Responses `web.search` | query、来源、页面范围、完整 report 引用和模型收到的 summary/top-5；snippet 不证明完整页面 |
| Gateway `web.search` | query、来源、页面范围、完整度、unresolved sources 与 report reference；生产 app 暴露未找到 |
| `checkpoint.inspect` | 当前只返回 latest checkpoint（至多一个候选）的时间、description/引用和不可用原因；不能据此宣称支持多点选择或回退 |
| `checkpoint.recall` | 读取及完整性结果、恢复引用；不向模型展开旧 raw，不改变执行位置 |
| `checkpoint.save` | 接纳/拒绝、提交引用及语义材料；summary 不替代 receipt |
| `checkpoint.record-dead-end` | 已否定假设、结论范围、证据、候选替代路径；不删除失败分支 |
| `checkpoint.reenter` | 若未来接线，保留目标、准入结果、新分支/epoch 与证据；当前仅在 built-in 名称集合中，未分配给 role，也未在 Responses Provider 注册，不能称为可用 |
| `task.query` | 查询时点、范围、权威状态引用；不提升为新状态真源 |
| `task.match` | 匹配依据、候选和歧义；不自动变更任务 |
| `runtime.status` | 观察时点与状态来源；快照不等于未来健康 |
| `queue.inspect` | 队列水位、类别与范围；不消费或重排 |
| `resource.query` | 能力/占用快照及限制；不等于准入 grant |
| `workspace.list` | workspace 范围、路径、遗漏条件；不推断不存在 |
| `agent.query` | 获准对象的状态/结果引用；不读取其他 agent 的隐式会话 |
| `agent.message` | 收件对象、消息类别与投递 receipt；送达不等于执行完成 |
| `bug.query` | 查询条件和候选引用；无结果不证明没有 bug |
| `bug.inspect` | 身份、revision、事实与缺证据项；描述不等于复现 |
| `channel.query` | 受权频道、时点、读取水位；不扩大访问范围 |
| Explicit Brain `memory.search` | scope、query、来源与匹配边界；当前 executor 有 port，但 app explicit runtime 未装配，不能当作已准入/可调用 |
| Explicit Brain `memory.inspect` | source/digest/批准状态及适用范围；当前 app explicit runtime 未装配，不能据声明复活已失效结论 |
| Explicit Brain `memory.compare` | 比较对象、重复/冲突依据和 unknown；当前 app explicit runtime 未装配，不静默覆盖 |
| Explicit Brain `memory.save_candidate` | candidate 引用与 intake 结果；当前 app explicit runtime 未装配，不宣称已发布 |
| Explicit Brain `memory.operation.status` | 当前显式 memory executor 没有此 case；保持 `declared-only`/`unsupported-tool`，不从 summary 推断完成 |
| `interaction.ask` | 问题、待确认事项与请求引用；无回复不是同意 |
| `interaction.propose` | 提案及 input revision；提案不是确认 |
| `interaction.approve` | 对应输入版本和实际确认 receipt；不得代人批准 |
| `channel.reply` | 内容引用、目标与投递结果；不证明对方已读 |
| `channel.notify` | 通知目标及投递结果；不证明问题解决 |
| `requirement.submit` | envelope、确认版本、FIFO receipt；不能直接派业务 child |
| `trigger.submit` | trigger 准入与目标绑定；不代替需求确认 |
| `route.submit` | 已接受的路由引用及范围；不授予目标权限 |
| `resource.request` | grant/deny/wait receipt；不把申请当准入 |
| `subscription.request` | 实际订阅结果与 owner；不推断执行发生 |
| `attention.list` | 查询范围、未完成项及来源 |
| `attention.inspect` | 问题、证据、owner、下一动作引用 |
| `attention.triage` | 被接受的分类决定与理由；模型建议不是权威决定 |
| `attention.ack` | 已确认接收；不等于解决 |
| `attention.defer` | 被接受的延后条件；不隐藏恢复责任 |
| `attention.notify` | 通知 receipt；不等于被处理 |
| `attention.resolve` | 实际解决依据与 owner 接纳；无证据不能关闭 |
| `bug.report` | intake/去重结果与事实引用；不冒充已定位根因 |
| `bug.propose-update` | 提案、目标 revision 与证据；不冒充已应用 |
| `bug.resolve` | 实际解决状态和验证来源；不以文字关闭 |
| `bug.reopen` | 重开依据与版本；不改写历史事实 |

默认使用结构化结果的纯提取器。开放文本允许模型提炼，但必须绑定 source，并保留 unknown。语义质量在模块测试与增量 review 检查，不为每次工具调用默认启动 reviewer。未知工具显式报告 `semantic-extractor-unavailable`；不能清除 raw 后假装已有可恢复语义。

### D0-A 实际接线边界

- Responses UI Runtime 源码组装了 12 个 Provider tool 定义和对应 executor；当前真实 outbound exposure 仍 `exposure-unverified`。CLI/RCC binding 条件是实现层的 source fact，不是 live readiness。
- Explicit Brain catalog 有 39 个名称。当前 app binding 授予 5 个 operational port（`workspace.list`、`file.read`、`file.search`、`agent.query`、`agent.message`）；其余 34 个在当前 binding 被拒，若其他 binding 准入则 generic handler 返回 `unsupported-tool`。Memory executor 另外存在，但当前没有装配进 `createExplicitBrainRuntime`；其 4 个能力及 `memory.operation.status` 不可据声明认作运行可用。
- Gateway `deterministic.inspect` 默认注册，但没有角色/template/Responses tool exposure；`code.search`、`web.search` route 是条件注册，目前 inventory 未在生产 app 组合中找到它们。Gateway `file.read` 有 Responses app injection，但仍没有 live Provider receipt。
- Role template 校验只验证声明名属于 allowlist/registry，不代表执行 port 已注册。`checkpoint.reenter` 位于 built-in 名称集合但未分配给任何 role；checkpoint 工具均未在 Responses Provider executor 注册。Memory path comparison 是 Runtime agent 内部能力，不是 Provider/tool surface。

## D0-A 独立源码复核（2026-10-08）

- 独立 provider-audit peer 对 `code.search`、`deterministic.inspect` 和 Provider 工具装配边界做了源码复核。它确认 `code.search` 有独立 Gateway route、报告 artifact 与 verifier；Responses Provider 当前映射清单含 `file.search`，由本地 `CodeSearchService` 执行。现有证据未证明生产 app 装配 `codeSearchRoute`，也未证明 Provider 可调用 `code.search`。
- `code.search` 报告包含 scope、命中、truncation、completeness 与 unresolved paths。未要求完整搜索时 unresolved path 仍可导致 `succeeded`；verifier 检查 `searchComplete`，不检查 `resultsTruncated`。抽取器需逐字段保存这几类状态，不能用单一 succeeded 推断完整。
- `deterministic.inspect` 在 Gateway assembly 默认注册，但没有 role/template 或 Provider 工具入口。它按 operation ID、input digest、revision、scope 产生确定性 receipt；不读取输入内容，也不检查外部真实状态。
- 以上均是 source evidence，不是生产 Provider 暴露或运行证据。D0-A 的 tool inventory 已完成并经主编排抽样复核；其中 Explicit Brain catalog 数量误写为 40，主编排按源码更正为 39。Inventory 还保留 live exposure 未知和 audited-scope 的限定；执行层仍需测试与真实入口验证。

## F1-H 语义校准（2026-10-09；source-only）

此处把“工具可用”拆成四个独立事实：**source-wired**（源码存在接线）、**declared**（模板或 catalog 声明）、**admitted**（本次调用通过绑定/权限准入）、**executed**（本次工具 executor 返回执行事实）。`live-exposed` 只可由真实 Provider 请求/回执证明。前四项不能推导最后一项；catalog、模板、app 工厂条件或 fake test 都不证明 live exposure。

下列两个矩阵逐项绑定已审查的 12 个 Responses tool ID 和 5 个 Explicit Brain app operational tool。H-O1 source/public-consumer observation 已完成：`/Volumes/Intel/playground/humanagent/.worker-runs/native-reasoning-d0-20261008/f1-h-o1/observation.md`（SHA-256 `eb3bea8e61eb7a5a0deceb07cd0bae4fc177fb1671389efebecf56f013e9fab9`）与 `result.md`（SHA-256 `c10d74ef80e99dff7977da1ef7817985a162f1e037801f14910601cd7fc58a1f`）。授权的 app TypeScript 检查通过；在冻结安装后两个 public-consumer 测试文件为 15/15。来源和 consumer 证明：三个工具 `file.read`、`file.search`、`web.search` 有 report ref/digest 和 digest-checked readback；另九个工具没有本观察 readback 路径可用的 durable report descriptor；所有 inline output body 在 persisted Provider tool event 投影时被移除。它们不证明 live Provider 曾暴露或调用这些工具，也不证明 live receipt。故 `live-exposed` 与 live execution 对所有工具仍 `UNKNOWN`；另外，app composition 中没有生产 Explicit agent callback producer，外部 injection 与回调阶段仍未知。语义规则只允许从实际、可读、scope/digest 相符的证据作结论。`certainty` 是提取器对每项 claim 的允许标签，不是静态目录赋予工具的可信等级：来源缺失或行为未观察时只能为 `unknown`；receipt 直接支持且范围明确时为 `confirmed`；截断/局部来源为 `partial`；有新证据推翻旧 claim 时为 `corrected`，同时保留旧 claim 的引用，不覆写历史。

### Responses Provider：12 个 source-wired 工具

来源绑定：`packages/app/src/provider-tool-execution.ts:38-229,511-593`；app 注入 `packages/app/src/ui-runtime/index.ts:294-340`；driver 转发 `packages/adapters/provider/src/agent-driver.ts:190-200,247-309`。静态接线需同时满足 `mode=rcc`、`protocol=responses`、`workspaceRoot` 和 `projectKey`；这不是 live 可见性证明。下表的纠正规则对每次提取通用：保留原 raw/evidence ref；更正必须引用新 receipt/owner evidence 与适用范围，不允许因工具名或成功 status 推定旧结论。

| 工具 | 输入边界 | 源码可见结果字段 | 可支持的关键语义 / 条件 | certainty 与纠正 | 未知与证据源 | 禁止推论 |
|---|---|---|---|---|---|---|
| `file.read` | workspace scope、规范化 path；由 app executor 经 Hand / Gateway FileReadRoute | content；成功时 outputRef、outputDigest、evidenceRefs；错误为 typed error 路径 | 本次指定 workspace/path 在本次执行返回了该内容；只对实际读回的 ref/digest 成立 | 可读、digest-checked report 可对该次读取 `confirmed`；内容后续变化须新读取并以新 ref `corrected` | H-O1 确认 source/public-consumer readback；live call/body 仍 `UNKNOWN`，失败时是否有 report 取决于保存阶段 | 文件以后未变化；内容就是业务真相；Provider 已 live 暴露该工具 |
| `file.list` | workspace/path scope 与 `maxFiles` 上限 | `{workspaceRef, path, entries[{path, kind}], truncated, unresolvedPaths}`；当前报告未回显 maxFiles，须与原调用绑定 | 仅声明范围内已发现的路径集合；完整性需同时有原始输入上限与完整 discovery receipt | 截断或未解析时 `partial`；补齐同 scope discovery 后新证据可纠正，不能删除原部分结果 | 无 durable report descriptor，inline body 被 persisted event 投影移除；实际 live invocation `UNKNOWN`；H-O1 public consumer/source review | 范围外路径不存在；限量结果是全集 |
| `file.search` | workspace/path scope、query 与 queryKind、结果/上下文限制 | matches/hits、files discovered/searched、resultsTruncated、searchComplete、unresolved paths、report ref/digest | 命中只适用于此 query/scope 与实际 scanned paths；`succeeded` 可为部分结果，`requireComplete` 未在 Provider schema 暴露 | digest-checked report 可按记录的覆盖范围确认；截断为 `partial`；补证据后以新报告纠正 | H-O1 确认 report descriptor/readback 的 source/public-consumer 边界；live call/output `UNKNOWN` | succeeded 等于完整搜索；无命中等于不存在 |
| `file.write` | workspace scope、目标 path、create/update 意图与正文 | 成功返回 before/after 文本及 evidence；当前无 immutable outputRef/digest | 仅说明该次写入 executor 返回了哪些前后内容；必须保留本次路径和 call identity | 无不可变 ref 时最多 `partial`；后续 workspace readback 可用新证据纠正；不反向改写写入结果 | H-O1 确认无 durable report descriptor，inline body 不在 persisted Provider event；live call 与后续 readback `UNKNOWN` | 写入正确、验收通过、内容已 review 或可复现 |
| `file.edit` | workspace scope、目标 path、literal old/new、replace_all 参数 | 成功返回 before/after 文本及 evidence；当前无 immutable outputRef/digest | 仅支持本次匹配/替换结果；必须记录 replace_all 与实际 before/after | 有后续 readback 才确认该时点文件观察；否则 `partial`；readback 冲突时追加 `corrected` claim | H-O1 确认无 durable report descriptor，inline body 不在 persisted Provider event；live call 与 readback `UNKNOWN` | 意图正确、所有预期内容均被修改、review/验收通过 |
| `bash` | 精确 command、description、cwd；进程通过 `spawn('bash',['-c',...])` 执行并继承环境 | exitCode、signal、timeout/abort、stdout/stderr（有上限及截断标记） | 仅支持 shell 进程层的观察；exit/signal 与输出范围、timeout/截断须同时保留 | 完整未截断输出按实际范围 `confirmed`；受限输出或 timeout 为 `partial`；后来核验副作用应另建 claim | H-O1 确认无 durable report descriptor，inline body 不在 persisted Provider event；后代进程、具体副作用及 live invocation `UNKNOWN` | 环境被 sandbox；shell close 证明所有子进程/副作用 settle；exit 0 代表业务成功 |
| `todo_write` | 输入中的 replacement list | 接受/拒绝结果及列表变化/count；当前没有 revision、digest、artifact ref | 只支持 executor 接受了本次 todo 列表更新 | 只有持久读回才能确认当前状态；否则 `partial`；读回不符后以新 revision 纠正 | H-O1 确认无 durable report descriptor，inline body 不在 persisted Provider event；具体 readback/live invocation `UNKNOWN` | 模型标注 completed 证明任务完成 |
| `get_goal` | app 本地 goal store 查询 | `{goal: null}` 或 goal object（id, revision, objective, phase, roundsStarted, optional maxGoalRounds/blockedReason） | 只描述该本地读取时点的 goal 状态 | 直接带身份/revision 的读回可确认该时点；时间变化后重新读并追加修正 | H-O1 确认无 durable report descriptor，inline body 不在 persisted Provider event；额外 report ref/digest 与 live invocation `UNKNOWN` | goal 是 HumanAgent Task 或业务 task lifecycle 权威 |
| `create_goal` | goal objective 与可选 budget | 创建后的本地 goal id/revision/objective/phase/budget 或明确失败 | 只支持本地 goal store 接纳的创建结果；需保留返回 id/revision | 成功 receipt 仅确认创建本地 goal；若无持久读回为 `partial`；读回矛盾时纠正 | H-O1 确认无 durable report descriptor，inline body 不在 persisted Provider event；外部派发/Task receipt 与 live invocation `UNKNOWN` | 创建了业务 Task、已派发、已有执行者 |
| `update_goal` | goal id、revision 及请求的 action/update | 请求 action 与 app 接受的 goal revision transition 或失败 | 只支持 owner 接受的本地状态转换及其 revision | 有新 revision 的读回才确认当前状态；拒绝/冲突须保留为原事实，不改写旧状态 | H-O1 确认无 durable report descriptor，inline body 不在 persisted Provider event；额外 report ref/digest 与 live invocation `UNKNOWN` | goal 已对应完成/阻塞/暂停 HumanAgent Task |
| `present` | 声明的文件 paths/descriptions | `{turn: executionEpoch, files:[{path, optional description}]}`，仅在每个 path 是 regular file 时返回 | 只支持本次存在性检查的 path/time 观察；`turn` 不是独立 turn id | 当前检查可 `confirmed`；过期后须重查并追加纠正 | H-O1 确认无 durable report descriptor，inline body 不在 persisted Provider event；内容 digest、review receipt 与 live invocation `UNKNOWN` | 存在即内容正确、review 通过；`turn` 是真实 turn identity |
| `web.search` | query 与 filters；backend 为 optional injection | status、result count、pages fetched、result scope/completeness、unresolved sources、full report ref/digest；模型侧只收到 top-five summary | 只能按报告实际来源/页数/完整度作结论；model-side top-five 与完整报告是不同来源 | H-O1 确认 success 和 service-reported failure report 都产生 ref/digest；public readback 仅接受 `succeeded` event，故失败 event 不符合该 API 的 readback 前提 | success report 的 source/public-consumer readback 已观察；live backend/call 仍 `UNKNOWN`，保存失败可无 descriptor | snippet/top-five 等于完整页面或穷尽检索；配置存在即 backend ready |

### Explicit Brain：5 个当前 app-bound operational tools

绑定来源：catalog `packages/contracts/src/explicit-brain.ts:18-82`；准入 `packages/runtime/src/explicit-brain/tool-registry.ts:130-192,425-529`；当前 app binding `packages/app/src/explicit-brain-runtime.ts:445-489`；执行端 `packages/runtime/src/explicit-brain/operational-tools.ts:55-121`。当前 binding 只授予下列五个；catalog 中其余 34 项仍为未授予/未接线，不纳入这份“已执行工具”清单。Provider Explicit Brain interpreter 未传 `tools`/`executeTool`，所以也不能把以下 app operational ports 当成 Provider-live tool call。

| 工具 | 输入边界 | 源码可见结果字段 | 可支持的关键语义 / 条件 | certainty 与纠正 | 未知与证据源 | 禁止推论 |
|---|---|---|---|---|---|---|
| `workspace.list` | 固定 `scope:workspace:<projectKey>`，经过当前 binding/scope admission | discovered paths、discovery complete/unresolved fields | 仅限注册 workspace 和本次发现边界；complete 必须由完整 discovery receipt 支持 | 有完整同 scope receipt 才可确认；unresolved/truncated 为 `partial`，后续发现以新证据纠正 | explicit app binding/workspace source 已审；typed result/ref/digest 与 live provider invocation `UNKNOWN`；H-O1 public consumer 不将其变成 Provider tool | workspace 外不存在；超 traversal limit 后仍完整 |
| `file.read` | 相同固定 workspace scope、已准入 pathRef | requested path 与返回 content | 只证明本次读取 scope/path 内容 | 可读且 identity 相符时确认本次读取；文件后续变更需新读取并追加纠正 | 真实 result envelope/ref/digest `UNKNOWN`；explicit runtime/workspace port/H-O1 | 内容持久不变、内容是业务真相 |
| `file.search` | 固定 workspace scope，literal substring query，匹配文件 `limit`；当前最多扫描 100 个已发现路径 | query、matches（path/line numbers，不含 line text）、`complete: files.complete` | 必须同时保留发现完整度与已检查候选数/limit 停止原因；当前 `complete` 会在 loop 因匹配 limit 提前停止时错误反映 discovery complete | 当前结果不得据 `complete=true` 判完整；最多 `partial`/`unknown`，直到 H-A1 修复并有回归证据；更正只追加新版本事实 | live output/ref/digest 与完整 receipt `UNKNOWN`；`explicit-brain-runtime.ts`、`operational-tools.ts`、workspace search 源；H-A1 红绿测试 | complete=true 即所有候选均搜索；matches 包含行文本；等同 Responses regex/symbol search |
| `agent.query` | 精确登记 target、`queryable` ACL、configured query port | 当前返回类型为 `unknown`，executor 原样转发 port result | 只可表达从已授权 target/port 收到的具体内容；不得扩成 target session/history 以外的结论 | 未有 typed receipt 映射前 certainty=unknown；收到可核验带 identity 的结果后按其证据范围确认/部分确认 | inspected app composition 没有生产 callback producer；若未外部注入会显式失败；外部 injection、返回字段/阶段、时间、ref/digest `UNKNOWN`；H-O1 source observation | 隐式 session 可访问；未知 result 是完整状态或已验收 |
| `agent.message` | 精确登记 recipient、allowed message class、message ref 和 configured send port | 当前返回类型为 `unknown`，executor 原样转发 port result | 只表达调用的 send port 返回了什么阶段；accepted/queued/delivered/read/executed/completed 必须各有真实 receipt 支持 | 阶段未知时 certainty=unknown；若后续 receipt 证明阶段，以新证据追加/纠正，不升格为 child completion | inspected app composition 没有生产 callback producer；若未外部注入会显式失败；外部 injection、各阶段字段、result ref/digest `UNKNOWN`；H-O1 source observation | ACK=已读/执行/完成；send 返回=owner 接受子任务 |

这些矩阵是工具 owner 的 source-bound 语义审查，不是 F-S mapper 实现。H-O1 证明 persisted Provider tool event 投影丢失成功 body；只有 `file.read`、`file.search`、`web.search` 有 durable report ref/digest/readback，其余九项没有该 report descriptor。工具 owner 保存必要的原始输出及可读引用；唯一纯提取与历史组装位置是 `packages/runtime/src/context/`（F-S / Context owner），不得在 templates 或 app 复制 mapper。需要从 executor 边界保留 body 或建立 descriptor 时，由 contracts/app 对应 owner 规划 typed receipt；本文件不新增 public field，也不把 local source/public-consumer evidence 声称为 live Provider 证据。
