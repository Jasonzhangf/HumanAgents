# 原生推理逐工具语义规则设计

状态：DESIGN-RULES / NATIVE-SURFACE-17 / INCREMENT-1-DOCS / PARTIAL-WIRE-EVIDENCE。独立 planner 已确认 12 个基础 Responses 工具、标准 turn close、三个条件 parent child 控制和一个 child delivery 的语义边界。此文档主体对齐设计、规则和 DAG 元数据；后续状态记录受控 v1 outbound wire evidence。它仍不证明 v2/child runtime、live exposure 或真实模型语义质量。

递进实施步骤与验收以主编排单独维护的实施计划为准；该计划不属于本 docs-only 候选，本文件不复制它。D0-A inventory：`/Volumes/Intel/playground/humanagent/.worker-runs/native-reasoning-d0-20261008/d0-a/tool-inventory.md`。本表不能把列出工具解释成每个请求都已启用。

工具身份按 `(surface, tool ID, binding, route)` 识别。同名工具不得跨 Responses Provider、Explicit Brain catalog、Gateway route 和 role template 合并。只有 inventory 标记为当前注册且执行端已接线的具体实例才可清理 raw。`exposure-unverified`、`declared-only`、`unsupported-tool` 与 `not-found-within-audited-scope` 保持不同含义，不折叠成成功或失败布尔值。

## 当前 native 工具联合面

当前 native 语义审查的联合面是 17 个工具：

1. 12 个基础 Responses 工具：`file.read`、`file.list`、`file.search`、`file.write`、`file.edit`、`bash`、`todo_write`、`get_goal`、`create_goal`、`update_goal`、`present`、`web.search`。
2. 标准 turn close：`humanagent_turn_end`。
3. 条件 parent child 控制：`child.call`、`child.adopt`、`child.not_select`。
4. child 精炼 delivery：`humanagent_child_deliver`。

这是工具联合面，不是单次请求的启用清单。基础工具受实际 route、workspace 和 capability 约束；parent child 控制只在 roster 绑定时进入 parent 请求；`humanagent_child_deliver` 只在 child run 中进入；`humanagent_turn_end` 只在已准入的 standard closure 路径中进入。任何请求只应看到其 binding 和 admission 允许的子集。

## Native 语义提取边界

语义提取发生在两个模型 authored 边界：

1. child 边界：`humanagent_child_deliver` 将 child 自己的原始工具观察提炼为独立结果；随后 child 的 `humanagent_turn_end` 收拢这个 child turn。
2. parent 边界：parent 对每个 returned child 使用 `child.adopt` 或 `child.not_select` 作出显式决定，再用 `humanagent_turn_end` 的 `goal`、`actions`、`result`、`expectedNextStep` 四段语义收拢直接工具事实和 adopted child 结果。

两个边界只能引用本次已接受工具结果或 adopted child delivery 的 `[HumanAgent evidence refs]`。Runtime 校验 scope 和引用，不重新执行工具。Checkpoint/Control Owner 是 checkpoint 与 closure 的写入 owner；模型 authored close 不是 completion authority。

所有语义保留完整工具身份、执行 scope、原始证据引用或 digest、失败与 unresolved 状态、完整或截断边界，以及“执行了动作”与“有证据验证结果”的区别。新增逐工具运行时 parser、强制 `SemanticClaim[]`、强制 `SemanticConstraint[]` 或内部目录迁移不是本增量的要求。

当前 turn 可以保留 raw tool calls 和 results。prior turn 只保留已提交四段语义、可信 checkpoint metadata、verified evidence refs 和 adopted child refined deliveries；不得带入 prior raw tool bodies、call IDs 或 child transcripts。Wire 状态为部分成立：三处现有 App semantic-checkpoint encoders 已投影既有 `checkpointId`、`committedAt`、summary-as-`description` 与顶层 `evidenceRefs`；实际 captured two-turn/three-turn POST 在 v1 上由缺少 `checkpointId` 的 RED 2/2 转为 GREEN 2/2。v2 和 child-run encoder 只完成源码修复，运行仍为 `UNVERIFIED`。adopted-child 投影的 `evidenceRefs` 仍是历史类型 gap：`AdoptedChildSemanticContext`/`AdoptedChildSemanticDelivery` 没有该字段，含该字段的 `RefinedChildSemanticDelivery` 是不同既有类型；本增量未新增 child 字段，也未删除该 gap。refined child body/ref 仍走既有 accepted path。现有受控 fixture 的 inspect、two-turn、three-turn public consumers 为 3/3 PASS；现有 two-turn case 验证 direct `file.read` 的 bounded conclusion、exact accepted ref、prior raw call/result exclusion 和完整 `EXACT_BODY` exclusion 可跨压缩保留。该证据不证明真实模型自动提炼质量，也不验证 v2/child encoder 运行路径。

## 17 工具提取规则

| 工具（wire name） | 当前 turn 原始事实 | 四段 close / child delivery 提取边界 | 禁止推论 |
|---|---|---|---|
| `file.read` (`file_read`) | target path、read range、content digest/output ref、`[HumanAgent evidence refs]` | 记录 target path、实际读取范围和范围内观察到的事实，并引用 tool-result evidence；只证明本次读取 | 文件以后未变；内容就是业务真值 |
| `file.list` (`file_list`) | path、entries、`truncated`、`unresolvedPaths`、evidence refs | 记录查询目录、相关 present/absent entry 和完整或截断边界，并引用 tool-result evidence | 限量列表是全集；范围外路径不存在；未列出内容可递归推断 |
| `file.search` (`file_search`) | path、query、queryKind、matchesFound、key matched paths/lines、`searchComplete`、`resultsTruncated`、unresolvedPaths、report ref/digest、evidence refs | 记录实际 query/scope、命中位置和完整度，并引用 report 或 tool-result evidence；零命中只覆盖已搜索范围 | `succeeded` 等于完整搜索；无命中等于不存在 |
| `file.write` (`file_write`) | target path、bytesWritten/create/update、before/after、output ref/digest、evidence refs | 记录 target path、写入 side effect、预期改动摘要和字节 readback，并引用 evidence；区分写入动作与后续测试/验收 | 写入成功等于测试通过、review 通过或需求完成 |
| `file.edit` (`file_edit`) | target path、old/new、replace_all、match/replacement count、before/after、evidence refs | 记录实际 edit、匹配范围和 replacement count，并引用 evidence；oldText 未匹配时保留 exact failure | 只写“已编辑”；编辑成功等于验证通过 |
| `bash` (`bash`) | command、cwd、exitCode/signal、timeout/abort、stdout/stderr 及截断、evidence refs | 记录 command、cwd、exit code、关键失败行或 assertion line、输出范围和 side effect，并引用 evidence | exit 0 等于业务成功；shell close 等于所有子进程和副作用已 settle |
| `todo_write` (`todo_write`) | 接受或拒绝的 full replacement list、counts、evidence refs | 在 `actions` 或 `expectedNextStep` 记录 checklist transition 和 evidence | 模型标 completed 等于工作完成 |
| `get_goal` (`get_goal`) | goal 或 null、id、revision、phase、evidence refs | 记录读取时点的 local goal identity/revision/phase 和 evidence | local goal 是 HumanAgent Task 生命周期真相 |
| `create_goal` (`create_goal`) | 接纳或拒绝的 local goal、id、revision、phase、evidence refs | 记录创建动作、返回身份和 evidence | 创建了业务 Task、已派发或已执行 |
| `update_goal` (`update_goal`) | 请求 action、接受或拒绝的 revision transition、new state、evidence refs | 记录实际状态转换、new revision 和 evidence；拒绝/冲突保留为原事实 | goal 状态自动等于 Task 完成、阻塞或暂停 |
| `present` (`present`) | paths/descriptions、regular-file 检查、title/content、artifacts、immutable artifact refs/digests、evidence refs | 记录 presented title、artifact path/ref 和 evidence；presentation 只是存在性/交付动作 | 出现即内容正确；presentation 等于 review PASS |
| `web.search` (`web_search`) | query/filters、status、来源与页数、truncated、unresolved sources、report ref/digest、top-five summary、evidence refs | 记录 query、实际 source/title/URL、范围和 bounded factual takeaway，并引用 evidence；外部结果仍是未验证观察 | snippet 或 top-five 等于完整页面或穷尽检索；外部来源天然可信 |
| `child.call` (`child_call`) | returned/blocked、invocationId、childTurnId、summary、refinedDeliveryRef、evidence refs | 每个 returned child 在同一 parent turn 必须由 `child.adopt` 或 `child.not_select` 作出显式决定，并引用 decision evidence | returned 等于已采纳；parent 可以携带 child raw transcript |
| `child.adopt` (`child_adopt`) | adopted、invocationId、childTurnId、refinedDeliveryRef、retained assignment、refined asset、evidence refs | 被选 refined delivery 进入 parent `adoptedChildren`；parent close 引用 child refined evidence | 模型可替换 child body；adoption 代表 owner 完成验收 |
| `child.not_select` (`child_not_select`) | not-selected、invocationId、immutable delivery、reason、evidence refs | 不写入 `adoptedChildren`；若 reason 影响下一步，在 close 中简短记录并引用 decision evidence | not-selected 删除历史证据；未选择等于 child 失败 |
| `humanagent_child_deliver` (`humanagent.child.deliver`) | 独立 body、judgment/findings、body asset ref/digest、own evidence refs | 独立提炼 child 观察，包含结论、scope、完整或截断、副作用与验证、失败和剩余风险，并引用 own evidence | parent 会收到 child raw output；summary 或 ref 可替代 body |
| `humanagent_turn_end` (`humanagent.turn.end`) | 四段 summary（`goal`/`actions`/`result`/`expectedNextStep`）各含 text 与 evidenceRefs、delivery text/refs | 模型 authored 四段语义收拢当前 turn 的直接工具事实和 adopted child 结果；Runtime 校验 admitted turn、accepted tool-result/base refs、adoption 与 delivery refs | 每工具强制 claim array；turn end 直接完成 Task；summary 代替 checkpoint receipt |

## 历史 source evidence 保留

以下内容是已确认的历史证据，不能因本增量删除或改写：

- H-O1 的 source/public-consumer observation 证明当时 persisted Provider tool event projection 移除 inline body。`file.read`、`file.search` 和 `web.search` 有 durable report ref/digest/readback，其他九个当时没有同一 readback descriptor。该结果仍不证明 live Provider exposure。
- F1-H 的 12 个 Responses 工具和 5 个 Explicit Brain operational port source 审查仍是各 surface 的工具证据。它们不等同于本增量列出的 17 个 native union，也不能跨 surface 合并工具身份。
- `packages/runtime/src/context/tool-semantics.ts`、`deriveFileSearchObservation` 及其测试仍是历史 source evidence。它们在此 Increment 1 保留；删除或 API cleanup 属单独授权，不能被文档对齐顺带执行。
- 当前 source 已观察到 `file.write` 在 durable intent 后做目标字节 digest readback，`present` 写入 immutable file artifacts，但这些源码事实仍不等于 Provider live receipt 或 owner acceptance。

## Owner 边界

- 工具 executor/adapter 保存原始执行事实、错误、scope、完整度与 evidence refs；它不能把未观察的业务结果标为完成。
- `packages/runtime/src/context/` 负责 native semantic-history projection 和 checkpoint-history assembly；它投影已提交四段语义、verified refs 与 adopted child deliveries，不执行或重复工具。
- `packages/runtime/src/explicit-brain/interaction-turn-session.ts` 负责 Explicit Brain interaction turn checkpoint 构造；它仍在 `packages/runtime` owner 内，不建立第二套 native semantic-history owner。
- `packages/agent-templates` 可声明 instruction，但不能实现 extractor 或决定验收；`packages/app` 可组装 provider tools 和 semantic-checkpoint encoder，但不能复制第二套语义 checkpoint。
- Task/pipeline owner 决定 owner acceptance 和 Task completion。Checkpoint/Control Owner 决定 checkpoint、closure、recovery 与 raw-release eligibility。

本文件不新增 public field、tool、feature 或 runtime behavior；它只记录后续受控 v1 outbound wire evidence 与覆盖限制。No-Task helper、独立 typed handoff schema 和 deterministic per-tool mapper 都不是本增量的实现产物；整体目标仍未完成。
