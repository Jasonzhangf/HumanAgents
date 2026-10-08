# 语义层只读审计结果：context-events → 运行态 → UI

- Owner: independent read-only auditor（向父编排者回报，不是 Collab master）
- Baseline: `9d1f39c53f09e31a4636fa75f97042c18e8bb114`（worktree clean at start; 见 §9）
- Worktree: `/Volumes/Intel/playground/humanagent/semantic-observation-20261007`
- 边界：产品代码只读；未 build、未跑测试、未启动服务、未改 daemon/RCC、未 Git mutation。
- 结论一句话：`packages/context-events` 已实现并有单测，但**没有任何生产消费者**。运行态 → UI 仍走 `RuntimeTaskEvent` raw 词表，语义层到 UI 的边是断的。**不得据此判 PASS。**

## 1. 状态分类（已实现 / 已接线 / 已验证 / 缺失）

| 能力 | 状态 | 证据 |
|---|---|---|
| context-events 类型/normalize/pairing/narrative/compact | 已实现 | `packages/context-events/src/index.ts:15-22` 导出面；各文件见 §3 |
| context-events 模块单测 | 已验证（模块内） | `tests/context-events/context-events.test.ts`；契约 §14 记 143/143 |
| context-events 被生产代码导入 | 缺失 | §4 全仓检索：`packages/**` 生产代码 0 命中 |
| 运行态事件 → 语义 canonical | 缺失 | 无 `normalize*`/`applyPairingOutcome` 生产调用 |
| `toUserNarrative` → UI | 缺失 | 无生产消费者；仅 `docs/ui/semantic-observation-audit-2026-10-07.md:46` 记为 OPEN |
| 运行态 → observation API → UI | 已接线（raw 词表） | §5 调用链；UI 渲染 `event.kind/state/summary` |
| unmapped 错误可见性 | 缺失 | `unmapped` 只在 `NormalizeResult` 返回，无 HTTP/日志/UI 出口 |
| stable/live 独立 owner | 缺失 | live = `RuntimeTaskEvent`；stable 语义流不存在 |
| 历史/实时语义水位 | 缺失 | `compact.sourceWatermark`（`compact.ts:27,86`）无生产消费者 |
| scope：agent / project | 缺失 | `packages/contracts/src/index.ts:1,18` 只有 organ/task/cycle/operation |
| build / live API / 浏览器 | 未验证 | 本审计边界内未执行 |

## 2. 真实调用链（现状）

```
Provider binding ──ProviderEvent──▶ coordinator.recordProviderEvent (runtime/src/ui-runtime/coordinator.ts:2412)
   → pushEvent(:2672) → TaskRecord.events (RuntimeTaskEvent)
   → coordinator.snapshot(:2940) → RuntimeTaskSnapshot.events/recentEvents
   → UiRuntimeService.observation (app/src/ui-runtime/service.ts:2199)
        · 根 scope = nodeRegistry() 13 节点（:2218）
        · provider 子 scope = task.events.map(...)（:2225）
   → projectPipelineObservation (ui/projection/index.ts:947)
   → HTTP GET /api/tasks/:id/observation (app/src/ui-runtime/server.ts:983-988)
   → docs/ui/observation.js（只读渲染）

同源 raw 渲染旁路：
   taskDetail (service.ts:2144) → GET /api/tasks/:id/dashboard (server.ts:978-981)
     → docs/ui/task-dashboard.js:388-389 渲染 `${event.kind} · ${event.state}` + `event.summary`
   taskDetail → GET /api/tasks/:id (interaction) → docs/ui/interaction.js:350 渲染 `event.kind` + `event.summary`

context-events（另一条，未接线的边）：
   normalize* → applyPairingOutcome → toUserNarrative / toMemoryDigest / compactContextEvents
   ↑ 无生产调用者
```

## 3. context-events 自身（已实现部分，供对照）

- 导出面：`packages/context-events/src/index.ts:15-22`。
- 四个 normalize 输入形状（结构化接口，不 import runtime）：
  `EventRecordLike` `normalize.ts:90`、`AgentEventLike` `:115`、`AgentSemanticEventLike` `:126`、`ProviderEventLike` `:142`。
- 四个适配器：`normalizeEventRecord` `:566`、`normalizeAgentEvent` `:584`、`normalizeAgentSemanticEvent` `:604`、`normalizeProviderEvent` `:626`；直接构造 `createContextEvent` `:173`。
- raw→canonical 映射表：`mapEventRecord` `:372`、`mapAgentSemanticEvent` `:388`、`mapProviderDialectAgentEvent` `:407`、`mapDshDialectAgentEvent` `:444`、`mapProviderEvent` `:488`。
- `unmapped` 形状与 3 值 reason：`normalize.ts:72-82`（`unknown-kind` | `waiting-is-not-terminal` | `indistinguishable-tool-phase`）。
- pairing 唯一状态改写：`applyPairingOutcome` `pairing.ts:131`；索引 `buildPairingIndex` `:70`；一致性校验 `assertPairingConsistent` `:185`。
- UI narrative：`toUserNarrative` `projector.ts:101`（输出 `state/title/detail/nextAction/evidenceRefs`）。
- Memory digest：`toMemoryDigest` `projector.ts:155`。
- compact：`compactContextEvents` `compact.ts:72`，水位字段 `sourceWatermark` `:27,86`。

## 4. 可复现的公开 consumer 检查（本审计实际执行）

在 worktree 根目录：

```zsh
# 1) 全仓生产消费者检索（排除包自身与包测试）
rg -n "normalizeEventRecord|normalizeAgentSemanticEvent|normalizeProviderEvent|applyPairingOutcome|toUserNarrative|toMemoryDigest|compactContextEvents|buildPairingIndex|createContextEvent|CanonicalContextEvent" . \
  --glob '!dist/**' --glob '!node_modules/**' \
  --glob '!packages/context-events/**' --glob '!tests/context-events/**'
# 期望：只命中 docs/architecture/context-events.md 与 docs/ui/semantic-observation-audit-2026-10-07.md

# 2) 生产包内是否 import context-events
rg -n "context-events|ContextEvent|toUserNarrative|normalizeProvider" \
  packages/ui packages/app packages/runtime packages/adapters packages/core packages/config
# 期望：无输出（0 命中）

# 3) EventBus 生产 owner 是否发布 observation 语义
rg -n "publishEvent|EventBusPorts|eventBus" packages/app/src packages/runtime/src

# 4) 运行态事件词表（UI 实际渲染的 kind）
rg -n "RuntimeTaskEventKind|recordProviderEvent|mapProviderEventKind" packages/runtime/src/ui-runtime/coordinator.ts

# 5) UI 是否直接渲染 raw kind
rg -n "event.kind|event.state|event.summary" docs/ui/task-dashboard.js docs/ui/interaction.js
```

如需 live API（本审计**未执行**，需父编排者授权服务/auth）：`GET /api/tasks`、`GET /api/tasks/:id/observation`、`GET /api/tasks/:id/dashboard`、`GET /api/tasks/:id/history`。基线安装实例 `10086` 曾返回 `auth.session.missing`，未取得任务数据。

## 5. 现有公开 API（供修复切片对接）

| 方法 | 入口 | 位置 |
|---|---|---|
| GET | `/api/tasks` | `server.ts:753` |
| POST | `/api/tasks` | `server.ts:757` |
| GET | `/api/tasks/:id/dashboard` | `server.ts:978-981` |
| GET | `/api/tasks/:id/observation?node=&scope=` | `server.ts:983-988` |
| GET | `/api/tasks/:id/history` | `server.ts:990-1006` |
| POST | `/api/tasks/:id/executions`、`/stop` | `server.ts`（executions 段） |
| SSE | `/api/executions/:operationId/events` | `server.ts:593` 区段 |

服务方法：`UiRuntimeService.observation` `service.ts:2199`、`taskDetail` `:2144`、`history` `:2299`、`taskDashboardWithPlan`（dashboard 段）。投影 owner：`projectPipelineObservation` `ui/projection/index.ts:947`（输入类型 `PipelineObservationProjectionInput` `:408`）。

## 6. 缺边（按检查项逐条）

1. **normalize 输入类型支持哪些源**：只有 4 个结构化形状（`EventRecordLike`/`AgentEventLike`/`AgentSemanticEventLike`/`ProviderEventLike`）。**没有** `RuntimeTaskEvent` 适配器——契约 §9.4 明确将 `RuntimeTaskEvent`、`RuntimeTaskJournalRecord`、Attention 流列为后续轮次。当前 UI live 流正是 `RuntimeTaskEvent`，故不能直接喂入。
2. **pairing apply 顺序**：`applyPairingOutcome` 是 `status` 改写唯一 owner（契约 §8.2，`pairing.ts:131`）；合法顺序为 `normalize* → applyPairingOutcome → 投影/compact`（契约 §8.2 末）。生产端**完全没有**这一调用，因此 error↔resolved、plan↔accepted/rejected、retry↔recovered/exhausted、operation.failed↔checkpoint 配对都不会进入 UI。
3. **scope task/agent/project**：`ScopeRef`（`contracts/src/index.ts:18`）只有 organ/task/cycle/operation；`ScopeKind`（`:1`）无 `agent`/`project`。agent 展示目前是 `agentIdForRole`（`service.ts:606`，形如 `agent-<role>`）与 `agentFrames`（`:615`），是**显示 frame**，不是 durable agent 身份；project 身份来自 `UiRuntimeServiceOptions.projectKey/workspaceRoot`（`service.ts:300-301`）。agent/project scope 需要 contracts owner 决策，context-events 不能私自编码。
4. **`toUserNarrative` 实际消费者**：无。见 §4 命令 1/2。UI 直接读 `event.kind`/`event.state`/`event.summary`。
5. **unmapped 错误可见性**：`UnmappedSource`（`normalize.ts:72`）只在 `NormalizeResult.unmapped` 返回；无 HTTP 字段、无 metric、无日志、无 UI 计数。未知 raw kind 会被静默丢弃在模块边界内。
6. **stable/live 是否有真实 owner**：live 事实 owner 是 `RuntimeTaskEvent`（runtime coordinator）；stable 语义流**不存在**独立 owner。契约 §5 要求 stable/live 由公开生产者提交；当前无生产者。
7. **历史与实时水位**：`compact.sourceWatermark`（`compact.ts:27,86`）无生产消费者。UI history（`service.history` → `projectRuntimeTaskHistory`）直接分页 `task.recentEvents`，与语义水位无关。`observation` 的 `projectionSeq = String(task.events.length)`（`service.ts:2244,2254`）是事件条数，不是语义水位。

## 7. 最小 owner-correct 修复切片（建议，未实施）

原则：**不复制 taxonomy，不加第二套解释器**；`context-events` 仍是唯一语义 owner；UI 只做视角/排序/分组。`context-events` 依赖上限为 `packages/contracts`，不得 import `packages/runtime`。

切片 A（语义生产边，owner: runtime，改 `packages/runtime/src/ui-runtime/coordinator.ts`）：

- 在 `recordProviderEvent`（`:2412`）已有真实 `ProviderEvent` 的落点，生成 canonical 语义事件。选择：
  - A1（推荐）：在 coordinator 内用 `context-events` 的 `normalizeProviderEvent`（`normalize.ts:626`）把**原始 `ProviderEvent`** 归一化——此处不丢失 `toolCall`/`toolResult`/`terminalState`。runtime 已依赖 contracts；是否允许 runtime→context-events 需按依赖图确认（contracts ← context-events ← runtime 是契约 §4 声明的方向，允许）。
  - A2：新增 `RuntimeTaskEvent` 适配器到 `context-events`（owner: context-events）。但 `RuntimeTaskEvent` 缺 provider tool/terminal 细节，会丢语义，故不推荐作为唯一路径。
- 关键易错点：`normalizeProviderEvent` 需要 `NormalizeContext`（`sourceId`/`occurredAt`/`scope`，`normalize.ts:52`）；`ProviderEvent` 无 `scope`/`occurredAt`，必须由 coordinator 用真实 `operation.executionEpoch` + task/operation scope 提供。**不得**用时间邻近当调用身份（契约 §4）。

切片 B（pairing + narrative 边，owner: app/ui-runtime，改 `packages/app/src/ui-runtime/service.ts`）：

- 在 `observation`（`:2199`）与 `taskDetail`（`:2144`）组装前，对切片 A 产出的 canonical 数组按真实关联身份（task/operation/epoch/callId）分组，再调 `applyPairingOutcome`（`pairing.ts:131`），再 `toUserNarrative`（`projector.ts:101`）。
- 传给投影的是语义集合；投影只做视角、排序、分组（owner: `packages/ui/projection`）。需要 `packages/ui/contracts` 增加语义 view-model 类型（title/state/detail/nextAction/evidenceRefs + scope + agent/project 归属），供 UI 渲染。

切片 C（UI 消费边，owner: docs/ui + ui projection）：

- `docs/ui/task-dashboard.js:388-389`、`docs/ui/interaction.js:350` 改为渲染语义 view-model（title/state/detail），不再读 raw `event.kind`。
- raw kind 仅在“主动证据查看”时按需读取（契约 G8：观测与控制分离，raw 只在证据面）。

切片 D（unmapped 可见性，owner: app/ui-runtime）：

- `NormalizeResult.unmapped`（`normalize.ts:79`）作为显式字段进入 observation/dashboard 响应，带 `sourceKind/rawKind/reason` 与证据入口。不得静默丢弃。

切片 E（scope 扩展，owner: contracts，跨 owner）：

- agent/project scope 需在 `packages/contracts` 增加 `ScopeKind`/`ScopeRef` 槽位或独立 `AgentRef`/`ProjectRef`；这是 contracts owner 决策，`context-events` 与 UI 不得自行拼假身份。在此之前 agent/project 视角保留 OPEN。

切片 F（水位，owner: runtime/context-events）：

- stable/live 水位需要 runtime 提交语义水位（对应 `compact.sourceWatermark`）；无生产事实前不得由 UI 计时器或摘要推断任务是否运行。

## 8. allowed files 与需要其他 owner 的接口

本审计（只读）allowed files：仅记录目录内 `notes.md`、`result.md`。以下为**修复**轮次的建议归属：

| 切片 | allowed files（建议） | 需要其他 owner |
|---|---|---|
| A 语义生产 | `packages/runtime/src/ui-runtime/coordinator.ts` | 依赖方向确认（runtime→context-events 是否纳入既有图） |
| B pairing/narrative 组装 | `packages/app/src/ui-runtime/service.ts` | `packages/ui/contracts`（新增语义 view-model 类型） |
| C UI 消费 | `docs/ui/task-dashboard.js`、`docs/ui/interaction.js`、`packages/ui/projection/index.ts` | ui projection owner |
| D unmapped | `packages/app/src/ui-runtime/service.ts` + response 类型 | ui/contracts owner |
| E agent/project scope | 无（只读审计不改） | **contracts owner**（`packages/contracts/src/index.ts:1,18`） |
| F 水位 | `packages/runtime/src/ui-runtime/coordinator.ts`、`packages/context-events/src/compact.ts` 消费 | runtime owner |

接口（必须由对应 owner 提供，不得越界实现）：

- `packages/contracts`：agent/project scope 身份（E）。
- `packages/runtime`：从真实 `ProviderEvent` 落点提交 canonical 语义事件与语义水位（A/F）。
- `packages/ui/contracts` + `packages/ui/projection`：语义 view-model 类型与只读投影（B/C）。
- `packages/context-events`：仅在需要 `RuntimeTaskEvent` 适配器时新增（A2），且不得 import runtime。

## 9. 验证边界与未验证项

- 已执行：只读检索（§4 命令 1-5）、源码逐行核对。
- 未执行：`pnpm build`（禁共享 dist）、`pnpm test`、服务启动、live HTTP、浏览器。
- 因此：**未验证**运行态到浏览器的实际渲染、未验证 unmapped 在生产中的表现、未验证 agent/project scope 的真实数据。以上均为 MISSING/UNVERIFIED，不得声称 PASS。
- 未触碰 `docs/dagpipe/observation-read.graph*.json` 与 `docs/ui/semantic-observation-audit-2026-10-07.md` 的既有 staged 改动（他人/父编排者改动）。本审计只写本目录 `notes.md`、`result.md`。

## 10. 一句话给父编排者

`context-events` 是已完成、已单测的语义 owner，但它到运行态和 UI 的**所有生产边都缺失**；现有 observation API 与 UI 走的是 `RuntimeTaskEvent` raw 词表。修复主线是 A→B→C→D（生产语义事件 → pairing/narrative 组装 → UI 消费语义 view-model → unmapped 可见），E/F 依赖 contracts/runtime owner 决策。
