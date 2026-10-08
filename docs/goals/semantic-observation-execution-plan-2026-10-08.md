# 语义观测生产实现：差距评估与执行计划

评估日期：2026-10-08。源码基线：`b8db9028df74fc4579e2b3f106b31bd448923523`。静态设计已交付；生产功能尚未接线。本文件是执行候选计划，不代表生产编码准入、设计审查或运行验收 PASS。

权威需求与完整差距：[语义观测审计](../ui/semantic-observation-audit-2026-10-07.md) 第1/1.1节，G1–G14 / F01–F20。当前源码与原审计 packages 一致；本次只核对首条生产边，复用仍有效的历史证据。

编排者裁决：采用持久 RuntimeTaskEvent → context-events → typed UI projection → 公开 API/事件 → 共享控件的单一派生链。已有 Harness、Journal、动态 assignment 图、checkpoint/context 基础继续复用。不得增加全量 ProviderEvent 副本或 semantic 状态真源。原始业务结果与控制状态保持各自 owner。

## 生效的执行边界补充

下述独立计划已接收。执行时以本节的准入与依赖限制为准；它修正计划中的阶段表述，不改变用户需求。

1. 独立计划 D 的编码前阶段只允许编写文档合同和修订 observation-read 三份现有图文件。不得在未知能力/编码前设计审查通过前写 packages 中的 TypeScript 合同或测试。字段形状先写入设计文档。能力核对和图/合同文档任务可以并行。
2. 编码前独立 review PASS 后，增加 C 合同实现节点。C 独占 `packages/contracts` 导出与 `packages/ui/contracts/runtime.ts` 等共享 schema 和对应测试。C 交付后，S/R/U 才启动产品实现；A 等 S/R，E 在组合候选上验收。先合同、再消费者，不并发写共享文件。
3. I4 可以交付多视角与偏好，但 F11 的完整关闭依赖 I5 的 F20 checkpoint/history 查询。I4 时 F11 只能标部分完成。F13 也须等适用的计划、checkpoint、在途义务和恢复验证全部齐备后关闭。五个可用增量不等于所有差距在对应轮自动关闭。
4. 本轮未验证当前鉴权、真实 Runtime/Provider 或 E2E 可用性。历史 auth.session.missing 不能当成当前阻塞。源码风险尚未经公开测试复现时，按风险/待验证记录，不宣称已经修复。
5. 本轮只完成评估与独立计划。下一执行入口是窄能力核对 + 文档合同/图修订；通过编码前独立审查后才进入产品代码派发。标准实现后的测试、真实浏览器验收、review、集成、安装/restart和资源回收仍适用。

过程证据真源：`/Volumes/Intel/playground/humanagent/.worker-runs/semantic-production-evaluation-20261008/`，包含 observation.md、note.md、planner-task.md、planner-events.jsonl 和独立输出 plan.md。planner 为 fresh OAuth gpt-6.1-sol，exit0。现有图已重新执行 `dagpipe graph validate`：8 nodes / 7 edges / 8 waves，exit0；只证明拓扑，不证明生产接线。

## 独立规划结果

**READY：可进入能力核对、设计图修订和独立编码前审查。产品编码须等这些前置项通过。**

输入绑定：`main@b8db9028df74fc4579e2b3f106b31bd448923523`。已读本轮 `observation.md`、`note.md`、项目 `AGENTS.md`、需求审计 §1/1.1、G1–G14/F01–F20，以及 observation-read 三份图文件。源码事实复用原审计；本轮仅核对首个生产边界。现有图重新验证：**8 nodes / 7 edges，exit 0**。这只证明拓扑合法。

当前主缺口是 **持久运行事实 → context-events → 公开语义投影 → 共享 UI** 未接通。已有 Harness、Journal、assignment 图和 checkpoint 基础可复用。无需重建 Harness，也无需重写全部页面。

本计划不改变用户需求，不代表设计 review PASS，也不代表生产验收通过。

### 1. 优先差距与唯一 owner

| 顺序 | 差距组 | 对应差距 | 精确 owner 与改动方向 |
|---|---|---|---|
| P0 | 语义生产链与关联正确性 | F01–F03；F07/F08 的前置部分 | `packages/runtime/src/ui-runtime/coordinator.ts` 保留运行事实；`packages/context-events/src/normalize.ts` 适配结构化输入；`pairing.ts` 按权威关联配对；`packages/ui/projection/runtime.ts` 只投影语义；app 仅组装。 |
| P0 | UI 事件、共享引用和复用边界 | F15–F18；F12/F14 的首轮部分 | `packages/ui/contracts/runtime.ts` 声明展示合同；`docs/ui/runtime-shell.js` 和既有工作卡扩展共享 owner；三个页面只接线。UI 不解释 raw，不复制 taxonomy。 |
| P1 | 任务模板、动态图与修订历史 | F04–F06、F08；F13 | `packages/contracts` 定义身份与合同；`packages/core` 定义许可和生命周期；`packages/runtime/src/admission/implicit-orchestrator.ts`、`orchestration/assignment-graph.ts` 复用编排能力；Journal 保存追加事实。 |
| P1 | Agent、项目与多视角观测 | F09–F12；F11 的完整闭环 | runtime 输出真实 lease/assignment 绑定；config 输出已校验项目身份；app 按授权范围聚合；UI 负责导航与展示。角色 frame、目录名都不能成为身份。 |
| P1→P2 | 上下文修正、checkpoint 与恢复 | F07 完整边界、F13、F19–F20 | core 保留恢复义务；runtime 复用 `ContextView`、`ContextReplacement` 和两类 checkpoint；Journal/不可变资产保留历史；app 提供合法只读查询。 |

**首个已确认的错误边界：**

- `pairing.ts` 当前按“最近的同类型 opener”配对。交错调用不能直接使用此算法。
- `service.ts:702` 的工具历史只按 `callId` 建表。跨 operation、epoch 或 request 重用 call ID 时，可能发生混配。该路径须改为消费语义 owner 的配对结果。
- `service.ts:2199` 的 observation 仍用固定 registry 和 raw `kind/state` 建节点。
- `task-dashboard.js`、`interaction.js` 仍展示 raw 词表。
- `model/output` 在现有 normalize 中返回 unmapped。直接调用现有函数，仍不能完成可用语义任务路径。

### 2. 选定事实链；实际损失与限制

选用单链：

```text
既有 Runtime Journal
  → RuntimeTaskEvent + 合法任务/operation scope
  → context-events 结构化适配、权威关联、pairing、narrative
  → typed UI projection
  → app HTTP / typed 更新通知
  → 浏览器解码一次、发布不可变共享引用
  → 共享控件
```

**不新增 originalProviderEvent 全量副本，不新增 semantic Journal/store。** canonical 是可重建的只读派生结果。运行态、恢复责任仍由原 owner 决定。

源码已证明 `recordProviderEvent → pushEvent → Journal operation.event → replayJournal` 保留：

- task、operation、execution epoch、事件顺序和时间；
- Provider 报告的 turn/request/parentRequest；
- callId、toolId、arguments；
- 工具 status、error、outputRef/outputDigest 和 evidence refs。

因此，“运行态已经丢失全部工具关联和输出”应撤销。首轮不需要双份持久事件来补这些字段。

**确实存在的损失或未承载字段：**

| 边界 | 已确认事实 | 处理 |
|---|---|---|
| Provider → RuntimeTaskEvent | 原 Provider `eventId` 未保留；runtime 生成自己的事件 ID。`externalResponseId/responseModel` 未进入该事件。 | canonical 使用 durable runtime source ID。需要 Provider 来源追溯时，仅追加原始来源引用；诊断字段不参与控制判断。 |
| Provider → RuntimeTaskEvent | `transport` 被归到 `provider.error`；原 terminal 值被放入通用 `state`。 | 新事件保留必要的 typed source facets。旧事件缺失这些字段时明确标记 unavailable，不能从 summary 重建。 |
| Provider → RuntimeTaskEvent | Provider `outputRefs`、ToolResult 的复数 `outputRefs` 未完整进入该事件；部分 error 结构已投影。 | 先核对现有 evidence/资产查询是否足够。缺少首轮所需来源引用时，在 runtime 单一记录链增加最小字段。不能复制整个 Provider 对象。 |
| Provider codec →公开输出 | reasoning 相关事件已有摘要/证据处理；当前公开合同未明确片段与稳定提交边界。 | 完整 F07 仍 OPEN。原 ProviderEvent 全量捕获也不能自动生成正确提交语义。需由 Provider/runtime 明确公开片段与 commit 事实。 |

首轮可以稳定展示已提交的工具结果、失败和 checkpoint；可以展示真实在途活动。公开输出未达到提交边界时须标为“生成中”。**不能把“已写 Journal”与“公开文本已完成”混为同一稳定水位。**

### 3. 五个可用增量；总验收不缩水

| 增量 | 可用结果与终验条件 | 覆盖范围 |
|---|---|---|
| **I1：任务语义纵切片** | 从真实任务入口看到语义进度、工具调用/结果、失败、等待、最终业务结果；刷新后可重放。四模式存在；缺失的 revision/Agent/project 历史明确 unavailable。共享事件/ref 边界已用真实消费者验证。 | 关闭 F01–F03；完成 F07/F08/F11/F12/F14–F18 的首轮部分。G3/G4/G8 与 G9–G12 建立生产基础。 |
| **I2：三模板与实际动态图** | typed 单次/巡检/长程绑定；模板骨架与实际 assignment 图分开。单次完成规定阶段；两次兼容巡检可比较；长程两轮有界 cycle 经 review 更新全程编排。 | F04、F06、F08；G1、G9。不得用 trigger mode 推断类型。 |
| **I3：修订、公开片段与恢复** | Journal 追加 published revision、why/what、差异与前后关系。current 仅最新；semantic 展示完整有序历史。公开 stable/live 提交边界成立。崩溃后图、事实、在途责任和 fencing 可恢复。 | F05、F07、F13；G2/G3。保留已执行事实；目标/范围变化仍走原确认 owner。 |
| **I4：多视角与展示偏好** | 真 Agent 绑定、真实项目归属；系统→项目→任务→实例可下钻。两项目/两任务/同角色多实例隔离。四模式深链及偏好优先级正确。整个相关 UI 使用统一事件和共享控件。 | F09–F12、F15–F18 完整关闭；G5–G12。偏好只保存版本化展示字段。 |
| **I5：修正、checkpoint 与全量收口** | wrong refs 仅从后续有效上下文排除；旧历史、动作/raw、义务保留。两类 checkpoint 的当前/查看游标与 revision/cycle/occurrence 独立。回退/前进追加历史。全量真实入口与清理验收完成。 | F19–F20；F14 最终关闭；G13/G14，以及 G1–G14 全量回归。 |

每轮只关闭已有当前候选证据的条目。F14 是每轮门禁，也是最后的全量门禁。I1 成功不代表全部二十项已完成。

### 4. I1 可派发合同

**目标：**接通一个真实任务的语义成功、失败、取消与复盘路径。保留现有输入/确认流程和控制 owner。计划 revision、Agent/project 历史可延期，但 UI 必须显示其能力状态。

**统一禁止范围：**

- 所有 peer 不改 RCC、auth/secrets、DSH、daemon/lifecycle、长期 memory/Skills。
- 不改任务调度、retry/steer/恢复策略，不借观测实现控制。
- 不新增事件真源、semantic store、逐页 taxonomy 或 UI raw 匹配。
- 不覆盖主树 dirty；代码仅在 root 创建的最新 `origin/main` clean worktree。
- 除各自精确 allowlist 外，产品文件全部禁止写。新增路径若无法满足合同，先回报 owner；不得自行扩范围。

下列新文件是**本计划建议路径**，当前尚不存在。

| Peer | 依赖与唯一责任 | 精确 allowed files |
|---|---|---|
| **D：合同与图** | 首先完成；只定义字段和边界，不实现语义算法 | `packages/ui/contracts/runtime.ts`；新 `packages/contracts/src/semantic-observation.ts`；`packages/contracts/src/index.ts` 仅导出；`tests/contracts/contracts.test.ts`；`docs/dagpipe/observation-read.graph.json`、`.semantic.json`、`.binding.json`；`docs/architecture/context-events.md`；需求审计仅追加实施状态，不改 §1/1.1 |
| **S：语义 owner** | D 和编码前 review PASS 后；适配、关联、pairing、narrative | `packages/context-events/src/normalize.ts`、`pairing.ts`、`projector.ts`、`types.ts`、`validation.ts`、`index.ts`；`taxonomy.ts` 仅限已审合同确需新增的语义；`tests/context-events/context-events.test.ts` |
| **R：durable 来源** | D 后，与 S 同层；仅补必要来源字段和重放 | `packages/runtime/src/ui-runtime/coordinator.ts`；`tests/runtime/ui-runtime/task-verification-identity.test.ts`；`tests/app/event-journal.test.ts`。不得改 Provider codec 或调用/停止策略 |
| **A：公开投影与服务** | S、R 接口完成后；接通 API，删除被替代的 app 配对解释 | `packages/ui/projection/runtime.ts`；`packages/app/src/ui-runtime/service.ts`、`server.ts`；`tests/ui/runtime-projection.test.ts`；`tests/app/ui-runtime.test.ts` |
| **U：共享 UI** | D 后可写组件；A 完成后真实接线 | `docs/ui/runtime-shell.js`、`interaction-work-card.js`、`observation.js`、`task-dashboard.js`、`interaction.js`；对应 `observation.css`、`task-dashboard.css`；新 `docs/ui/semantic-observation.js`；`tests/ui/interaction-observation-drawer-browser.mjs`；新 `tests/ui/semantic-observation-browser.mjs` |
| **E：公开验收** | D 后建立断言；组合候选后执行 | `tests/app/dashboard-e2e/runner.mjs`；`scenarios/local-file-search.mjs`；`lib/receipt.mjs`、`lib/journal.mjs`；新 `tests/app/semantic-observation-public.test.ts`；`tests/app/tsconfig.json` 仅注册新测试 |

D 拥有共享 schema 文件。其他 peer 通过请求修改合同，不能同时写。E 复用既有 auth/cleanup helper；发现这些 owner 有缺陷则停止对应验收，不临时修改或绕过。

**入口、依赖和数据边界**

- 复用 `GET /api/tasks/:id/dashboard`、`GET /api/tasks/:id/observation`。
- 复用 execution SSE 生命周期。新增 typed 语义更新通知；通知携 scope、projection version/watermark 和 ref。UX 不读 raw 事件内容来判断是否完成。
- observation 读取 coordinator 的合法 snapshot/replayed events。UI 不读 Journal。
- canonical 归类与关联算法都在 context-events。该包接收结构化 `Like` 输入，不 import runtime。
- app 传入事实、调用唯一语义链并组装响应。app 不拥有第二张映射表。
- UI projection 接收 typed 语义结果，整理展示结构。控件只消费投影。
- 网络传输会编码/解码。浏览器输入模块解码一次；同一 projection version 的消费者共享同一不可变对象。
- 更新产生新引用，旧引用保持不变。事件携引用及关联字段，不复制页面 payload。
- Rust `Arc<T>` 仅在实际存在的 Rust 边界验收。当前 JS 共享引用不能证明 native Arc；禁止为此改写语言。

**source/order/correlation/pairing 合同**

1. source ID 使用 durable runtime `eventId`，并以已验证的 organ/task/operation 命名空间保证唯一。canonical ID 仍由现有 constructor 派生。
2. 单 operation 内按 durable `seq` 排序。跨 operation 保留 Journal 顺序；Provider 时间仅展示，不用于重新排序因果。
3. 关联 envelope 与业务 payload 分离。至少包含 task、operation、epoch、request、call 以及来源引用；不把这些塞进工具 arguments 或文本。
4. 工具配对按 task+operation+epoch+request+callId 隔离，并核对 toolId。request 缺失时，只有来源合同证明 operation/epoch 内 call 唯一才允许较窄 key；否则 `correlation-unavailable`。
5. request、task operation、tool invocation 使用不同关联种类。Provider terminal 不能关闭工具调用，也不能当作 Harness 最终收拢。
6. 修正 `pairing.ts` 的唯一算法；不在 app 分组后继续依赖最近同类型 opener 来掩盖缺失关联。
7. 晚到结果只能关闭其原 invocation。旧 epoch 结果不能关闭新 epoch 活动。旧结果仍保留在原历史中。
8. 相同 durable event 重放须幂等；相同 source ID 内容冲突须显式失败。缺 opener、缺身份、多 opener 或矛盾 closer 均输出 typed coverage issue。
9. unsupported kind、缺关联、旧记录缺 source facet、等待非终态分别保留明确原因与来源引用。事件不得静默丢弃，也不得通过 raw fallback 猜语义。
10. 工具 `cancelled/blocked/unknown` 不合并成普通 failed。semantic owner 须保留这些真实结果，必要的类型增补先经过 D 和设计审查。

**成功、失败、取消、清理终点**

- 成功：API 与浏览器显示同一语义版本；工具 invoke/result 可追溯；业务结果与 Harness 成功终态分别可核验；终态无伪 live。
- 失败：原错误语义、来源、收拢/恢复状态和下一步可读。读取失败保留旧内容并标 stale；不能显示空列表成功。
- 取消观测：取消请求/退订只停止读取；任务继续。
- 取消任务：仍通过原 task-scoped stop；UI 在 stop/checkpoint settled 前显示收拢中。Provider abort 不等于停止完成。
- 清理：卸载组件退订；关闭本轮浏览器/profile。已 settled 才清理自有服务和临时数据。未 settled 保留必要恢复资源、精确 PID/path 与 recovery owner，标 `INCOMPLETE`。

### 5. I1 验证与真实入口验收

所有命令在**同一个组合候选 worktree**执行。共用 `dist` 的 build/test 串行。新增测试命令属于待交付物，当前不能当作已有证据。

作者验证至少执行：

```sh
pnpm typecheck
pnpm test:contracts
pnpm test:context-events
pnpm test:app
pnpm test:ui
pnpm test:provider
pnpm test:runtime
pnpm test:release
```

新增公开 consumer：

```sh
pnpm exec tsc -p tests/app/tsconfig.json
node --test dist/tests/tests/app/semantic-observation-public.test.js
node tests/ui/semantic-observation-browser.mjs
```

公开 consumer 须经真实 HTTP/SSE 接口，不能只调用内部 projector。覆盖：

- A/B 同类型调用交错：`A invoke → B invoke → A result → B result`。
- 不同 task、operation、request、epoch 重用 callId。
- 晚到结果、缺 opener、重复重放、矛盾 source、未知 kind。
- 工具成功/失败/blocked/cancelled/unknown；Provider terminal 与 final terminal。
- 重建服务后，同一 Journal 得到同一 canonical 身份、配对及有序历史。
- 两个 UI 消费者共享同一对象/版本；旧对象不会被更新改写。
- scope 切换拒绝旧订阅事件；卸载退订；断连、读取失败和空态不同。
- current/semantic/actions/raw 只改变查看选择。raw 仅显式模式或主动证据操作读取。
- GET、模式切换和导航不追加领域记录、不改变 task/checkpoint refs。任务运行时采用带水位的因果核对；不能把自然推进误判为 UI 副作用。

**首轮真实用户入口：**

```sh
pnpm e2e:dashboard:local-file-search
```

E 扩展既有 runner，以独立 task/run 记录成功、受影响失败和取消分支。输入仍走真实浏览器表单→现有确认合同→运行队列→真实工具循环→终态。至少证明 `file.search` 后读取命中文件、实际 call/result 来源、semantic API/UI 一致，以及语义失败可见。失败测试必须触发真实失败路径；不能用伪错误覆盖 UI。

receipt 保存在候选 `dist/receipts/dashboard-e2e/local-file-search/`。记录精确候选 SHA/tree、task/operation/request/call、projection 水位、截图、原始退出码及清理核对。

I1 可报告“本地搜索语义纵切片已验”。**不能报告完整 Dashboard 放行。**网络搜索、AItest 和其既有门禁继续 OPEN；最终增量按 `dashboard-e2e-acceptance.md` 完成三类真实任务。Retry-10 算法不在 I1 范围；若实现触及该算法，立即停止并重新界定验收。

### 6. 现有图修订与编码前审查

保留 observation-read 的八节点主链和现有三文件。无需第二套治理框架。

D 的最小修订：

- 更新 baseline；继续区分 candidate、capability 与 production 状态。
- `load_task_truth` 的事实生产绑定应指向 coordinator；现有 UI projection 绑定不能被解释成任务真源。UI 仍拥有后续展示投影。
- `load_event_history` 声明从 replayed RuntimeTaskEvent 读取，携 source/order/correlation envelope。
- normalize 输出 canonical、coverage issues 和来源关联。
- pairing 声明按权威关联闭合；缺关联显式 unknown。
- semantic projection 声明 stable/live 水位、typed 结果与 unavailable capabilities。
- browser 节点声明 decode-once、immutable shared ref、typed events、scope 隔离与退订。
- 在同一终点合同中明确 success/failure/cancel/blocked/cleanup。raw 为主动证据读取；不作为语义 fallback。
- 后续 I2–I5 更新既有对应业务图。不能把多个独立来源硬接成多入口图。

修订后执行：

```sh
dagpipe graph validate docs/dagpipe/observation-read.graph.json
pnpm dagpipe:validate
pnpm test:release
```

CLI 拓扑 PASS 不代表 operator/schema/effect PASS。

独立编码前 reviewer 输入须包含：本计划、修订图、字段合同、实际损失表、公开测试矩阵、能力核对结果。审查重点是唯一 owner、无双真源、权威关联、unknown/cancel 语义、共享引用边界、只读性，以及首轮延期能力是否明确。

**当前状态：审查输入方向 READY；修订图与能力证据尚未完成，不能宣称 reviewer-ready PASS。**

### 7. 编码前只做窄能力检查

| 检查 | 当前状态 | 最小动作与门禁 |
|---|---|---|
| 当前 authenticated 用户入口 | **UNVERIFIED** | 验收 owner 通过正式登录/配对入口核对读取权限。历史 `auth.session.missing` 不代表当前状态。不得猜凭据、清权限或重启探测。若无真实验收路径，先停产品编码并补能力观察。 |
| Journal 来源与资产可读性 | 部分已源码确认；覆盖仍 **UNVERIFIED** | 读取现有非敏感 fixture/录制样本，对照 Provider→runtime→replay 字段；核对 output refs 是否能解析。只补确实缺失的 typed 字段。 |
| request/call 唯一性与 late event | **UNVERIFIED** | 对照 Responses、Anthropic 录制 replay 和 runtime validator，证明可用关联 key。不能证明则保留 unknown；不得降低匹配规则。 |
| 可公开的 model/output 边界 | **UNVERIFIED** | 核对已有 codec、公开输出与 evidence 查询。区分活动提示、公开文本和 commit。I1 可不公开私有 reasoning；完整 F07 不能据此关闭。 |
| JS/native ARC 边界 | JS 合同可定义；native 适用性 **UNVERIFIED** | 明确当前进程和语言边界。若本轮没有 Rust payload 边，标不适用并保留后续 native 验收；若涉及 native 边而合同不明，阻断该边。 |
| 既有真实 E2E 能力 | runner 与入口存在；当前成功率 **UNVERIFIED** | 读取场景与 cleanup 合同，确认真实成功/失败/取消断言可执行。实际执行留到组合候选；不在规划阶段发 live Provider 请求。 |

不阻断 I1 的后续工作：项目聚合、Agent 历史、published revision 历史、三模板完整循环、上下文修正 UI、调度漏槽/复杂度风险复现，以及未批准的 DSH/SQLite/RAG/daemon 能力。延期项仍保留原总验收，不成为永久非目标。

### 8. 派发、STOP 与交付

先批量派只读 capability 核对和 D 的合同/图任务。root 验收证据后，交独立编码前 reviewer。PASS 后派 S/R/U；A 等 S/R；E 在组合候选上验收。root 只拆解、验收和集成，不实现 peer-owned 文件。

出现以下任一项，停止受影响链：

- 关联只能靠最近同类型、summary 或 UI 推断。
- 需要另存全量 ProviderEvent 或 semantic store 才能推进。
- 缺身份却生成假 request/Agent/project，或把 epoch 当 attempt。
- unknown/blocked/cancelled 被显示为成功或普通失败。
- 需要改 auth、RCC、daemon、控制策略或超出 allowlist。
- 真实入口不可用，或 stop/settle/清理无法证明。
- 新事实改变本轮范围、关键方案或验收。此时更新 observation，再独立 replan。

作者完成开发测试与公开/真实入口验收后，才启动独立实现 review。有效 PASS 后，root 按既有交付合同组合最新 main、补失效验证、集成、核对产物和运行入口。安装/restart 必须先核对正式通道；不能假设历史命令会重新加载产物，也不能自建 stop/start 替代。

peer 回传必须包括候选 SHA、changed files、测试数量/退出码、真实入口 receipt、review 结果、资源清单和剩余风险。没有 receipt 或清理未收口，状态为 `INCOMPLETE`。

经验判断：保留“组件、候选、生产接线、安装/live 分层报告”。本轮反证了“必须先保存 originalProviderEvent 才能做语义投影”的假设。该结论只适用于已保留的 RuntimeTaskEvent 字段；不能推广成所有 Provider 信息无损。本轮不修改长期 memory/Skills。
