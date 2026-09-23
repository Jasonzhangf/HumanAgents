# 任务流转透明化 — 实现文档与派单权限

状态：`PARTIALLY-IMPLEMENTED`（2026-09-23 按 `main` @ `a2e9e96` 只读复核更新）
日期：2026-09-21（原始设计）；2026-09-23（状态复核）
实现基线：`main` @ `a2e9e96`
原始设计基线：`main` @ `f2a4531`（`chore(release): bump version to 0.1.0007`）
设计基线：`/tmp/humanagent-flow-demo.html`（用户已审核通过的可交互 demo）
主脑：用户。本文的编排负责人（master）按本文派单与收口，不直接写实现代码。

### 状态复核（2026-09-23，对 `main` @ `a2e9e96` 的只读核对）

下表按本文第 3 节的 T1–T7 逐项标注**已落 main** 与**仍未实现**，不再沿用本文初稿的
`NOT-IMPLEMENTED` 结论。每项结论均由对应 commit / 源码路径核实。

| T | 状态 | 证据 / 缺口 |
|---|---|---|
| T1 节点身份与轮次定源 | **部分落 main** | 13 节点注册表已落：`packages/runtime/src/nodes/node-registry.ts` + `PIPELINE_NODE_IDS`（`packages/contracts/src/index.ts`，`57d6e8a`），单测 `tests/runtime/nodes/node-registry.test.ts`。**缺口**：`packages/runtime/src/ui-runtime/coordinator.ts` 仍有裸露 `currentNode` 字面量（至少 9 处赋值：`input.received`/`provider.execute`/`provider.tool`/`provider.model`/`orchestration.plan`/`checkpoint.commit`），未改为注册表引用；轮次真源在实现中取 `executionEpoch`（`service.ts:336`），与注册表头注声明的 `AssignmentProjection.attempt` 不一致。 |
| T2 SSE 节点维度 + 节点级工具历史 | **未实现** | `packages/ui/contracts/runtime.ts:216` 的 `RuntimeSseEvent` 仍无 `nodeId` / 轮次字段；节点级工具历史目前由 `provider.tool` 事件在 app 侧聚合，不是 SSE 契约维度。 |
| T3 交接事实与 payload 语义 | **未实现** | `packages/runtime/src` 与 `packages/contracts/src` 均无 `handoff`；现有 `AgentHandoffProjection` 仅由 `packages/app/src/ui-runtime/service.ts:504` 从节点事实**派生**，不是运行时产生的交接事实。 |
| T4 UI 契约与投影 | **大部分落 main** | `PipelineNodeProjection` / `AgentOwnershipFrameProjection` / `AgentHandoffProjection` 已在 `packages/ui/contracts/models.ts`，`projectPipelineObservation` 已扩展（`56b1cd6`、`80aaa42`、`655a34e`）；`service.ts` 已改由注册表驱动（`:1333`）。**缺口**：交接投影依赖 T3；`tests/ui/runtime-projection.test.ts` 仅 6 个用例。 |
| T5 三处界面落盘 | **部分落 main** | `docs/ui/observation.js` 已实现竖向 DAG、agent 归属框、底部抽屉、交接页（`56b1cd6`、`80aaa42`）；`docs/ui/tasks.js` 已渲染「当前节点 / 正在处理 / 第几轮 / 负责 agent」。**缺口**：`docs/ui/task-dashboard.html` 的 agent 卡片仍是静态原型数据（`data-agent="input"` 等硬编码），未消费投影。 |
| T6 记忆 agent 状态面 | **部分落 main** | 记忆审核面已接线（`b854410`，`memory.html`/`memory.js`/`projection/index.ts`）。**缺口**：DAG 中记忆 agent 归属框的 typed 状态未单独验收。 |
| T7 端到端验收 | **无证据** | 仓内无 T7 验收记录；`tests/release/` 无对应用例。 |

结论：本文第 3 节的 DAG 主链（节点身份 → 投影 → 观测界面）已在 `main` 上部分可用，但 T2、T3
与 T7 仍未闭合，T1/T4/T5/T6 仍有上述缺口。后续派单应以本复核表为准，不再从「未实现」起点重做。

## 0. 这份文档解决什么

用户已审核通过 demo 的四条产品要求：

1. 任务列表每行显示当前节点、正在干什么、第几轮。
2. 点击任务打开抽屉，里面是竖向 DAG。
3. DAG 节点按归属 agent 分组进框，同 agent 的节点在同一个框内。
4. 点节点从底部抽屉弹出内容：左侧 = 该节点的工具调用历史，右侧 = summary；另有一页显示跨 agent 交接内容。

本文把这四条要求翻译成**可在当前仓库落地的工程任务图**，并明确每项的 owner、缺口和验收证据。

## 1. 实现差距（已核实，非推断）

以下结论来自对 `main` @ `f2a4531` 的只读核对。demo 是原型，不是真源。

### 差距 1：文档里的完整节点链在代码里不存在

`docs/architecture/organ-runtime.md:221` 定义了 13 个节点：

```text
sensory.inbox → explicit.normalize → implicit.classify
  ├── interactive.queue ├── execution.queue ├── research.queue └── maintenance.queue
  → task.correlate-or-create → resource.admission → pipeline.execute → settle → task.output
```

代码里没有任何一处使用这些标识：

- `packages/runtime/src/ui-runtime/coordinator.ts` 实际产生的 `currentNode` 只有 7 个值：
  `orchestration.plan`(1309)、`provider.execute`(825)、`provider.tool`(1624)、`provider.model`(1625)、
  `checkpoint.commit`(1721, 1802, 2027)，以及任务级 `task.currentNode` 的 `provider.tool`/`provider.model`。
- `packages/app/src/ui-runtime/service.ts:888,899,911` 的 observation 节点是三个手写占位：
  `input.received` / `provider.execute` / `checkpoint.commit`，中文字面量"输入""Provider 执行""Checkpoint"，
  与 `organ-runtime.md` 的节点标识不对应。
- 节点分组所需的 agent 归属，代码里没有任何映射表。

结论：**节点身份必须先有一个唯一真源**，否则 UI 只能继续手写占位。

### 差距 2：事件流没有节点维度，live 更新做不到

`packages/ui/contracts/runtime.ts:214` 的 `RuntimeSseEvent` 字段是
`eventId / seq / occurredAt / taskId / operationId / executionEpoch / kind / state / summary / evidenceRefs / ownerId?...`。

**没有 `nodeId`，也没有轮次字段。** 十种 `RuntimeSseEventKind` 全是任务级的。
用户要求的"每个相关 agent 的 live event 更新""卡片是 live 状态"在当前契约下无法实现。

### 差距 3：没有交接（handoff）契约

`packages/runtime/src/communication/types.ts` 的 `M3_FEEDBACK_KINDS` 是反馈与能力注册，不是交接记录。
全仓 `grep -i handoff` 在 `packages/runtime/src` 下无命中。
demo 里那 4 条交接边（envelope / 准入结论 / 执行结果 / 验收结论+checkpoint）是**原型数据**。
交接要么是节点，要么是带 payload 的事件，必须先定 owner。

### 差距 4：轮次语义未定义

`AssignmentProjection` 有 `attempt` 和 `executionEpoch`（`packages/ui/contracts/models.ts:203`），
但没有任何地方把它投影成"第 N 轮"，也没有说明"轮次"到底指 assignment attempt 还是
`implicit.classify` 的重新分类次数。不定义就会出现第二套计数器。

### 差距 5：`reasoning` 与呈现边界冲突

`docs/ui/README.md` 明确："不暴露或伪造私有 chain-of-thought"，
"动态过程：点击卡片后打开详情，展示过程摘要和当前输出；不暴露私有思维链"。

用户要求左栏是"推理的工具调用历史"。这两条不矛盾，但**必须先把"推理"降级为可呈现的语义**：
可呈现的是 agent 收到的指令、工具调用与返回、以及 agent 自己写进 summary 的结论；
不可呈现的是模型私有思维链原文。demo 里 `think` 类型的条目是原型措辞，落盘时不能直接沿用。

### 差距 6：交接与工具返回的脱敏边界未定义

交接 payload 会包含 envelope、准入结论、执行结果。必须明确禁止出现在 typed projection 里的内容：
凭据、RCC route/token、原始 provider transport frame、Journal 原始记录、DSH 类型。
`packages/ui/contracts/runtime.ts` 顶部注释已有这条边界，实现时按它执行，不新增第二套规则。

## 2. 已存在、必须复用的能力

不要重新发明这些东西，它们已经是真源：

| 能力 | 位置 | 用途 |
|---|---|---|
| 5 个 agent 角色 | `packages/ui/contracts/models.ts:130` `AgentRoleDisplay` = `interaction / orchestration / execution / review / memory` | 分组框的身份，UI 不得自造角色 |
| 角色中文标签 | `packages/ui/projection/index.ts:67` `AGENT_ROLE_LABELS`、:75 `AGENT_ROLE_TITLES` | 框头与卡片文案 |
| 节点 stage 状态机 | `packages/runtime/src/nodes/node-types.ts:13` `NODE_STAGES` = `created → admitted → planned → dispatched → observed → settled` | 节点生命周期，UI 不得自造阶段 |
| 节点契约 | 同上 `NodeAdmission` / `NodeClosure` / `NodeObservation`，已含 `nodeId` / `parentNodeId` / `nodeKind` / `ownerRef` / `scope` | 节点树与 owner 的既有表达 |
| assignment 带节点 | `packages/ui/contracts/models.ts:207` `pipelineNodeId`、`:208` `agentId`、`:210` `attempt` | 真正的节点级真实数据入口 |
| 观察投影 | `packages/ui/projection/index.ts:708` `projectPipelineObservation` | 现有投影出口，扩展它 |
| 观察页面 | `docs/ui/observation.html` + `observation.js` + `observation.css` | 现有 DAG/drawer 宿主 |
| 任务看板 | `docs/ui/task-dashboard.html` + `task-dashboard.js` | 每行"正在处理"的宿主 |
| 任务列表 | `docs/ui/tasks.html` + `tasks.js` | 行内节点/轮次的宿主 |
| 现有 SSE | `packages/app/src/ui-runtime/server.ts:527` `streamEvents`、`service.ts` `subscribeReplay` | live 通道，扩展不重建 |
| UI 静态产物 | `scripts/copy-ui-assets.mjs`（`docs/ui` → `dist/app/ui`） | 改 `docs/ui` 后必须重新构建才会生效 |

`docs/ui/*.html` 是**被真正服务**的产品界面（`serveStatic(response, uiRoot, path)`），
不是原型。改写在 `docs/ui`，不要另建目录。

## 3. 任务图（按依赖排序，DAG）

链路是**串行的缺链补齐**，不是并行铺开。T1 未闭合前禁止开始 T2 之后的任何实现。

```text
T1 节点身份与轮次定源                       [runtime/core 侧]
    └── T2 SSE 节点维度 + 节点级工具历史      [runtime + ui/contracts]
            └── T3 交接事实与 payload 语义     [runtime + contracts]
                    ├── T4 UI 契约与投影      [ui/contracts + ui/projection]
                    │       └── T5 三处界面落盘 [docs/ui]
                    └── T6 记忆 agent 状态面   [runtime/memory + ui]
                                    └── T7 端到端验收 [tests + 真机入口]
```

### T1 节点身份与轮次定源

- **owner**：`packages/runtime`（节点身份的产生者）；`packages/contracts`（如需新类型）。
- **要闭合的链**：让 `organ-runtime.md` 的 13 个节点标识成为运行时会实际产生的值，
  或者——如果当前 MVP 只实现其中一条子链——把**实际存在的节点集合**作为唯一真源定义下来，
  并让文档与代码一致。二者选一，不允许代码一套、文档一套。
- **必须做的事**：一个显式的节点注册表（nodeId → nodeKind → 归属 agent 角色 → 上游节点），
  由 runtime 侧拥有，`currentNode` 的取值必须来自该注册表而不是散落的字符串字面量。
- **轮次定义**：明确"第 N 轮"的语义。候选来源是 `AssignmentProjection.attempt` 与
  `executionEpoch`。**禁止**新造独立计数器。在文档里写死它的定义。
- **验收**：单测覆盖注册表完整性（每个节点有唯一 kind 与归属角色、上游可达）；
  `coordinator.ts` 中每一处 `record.currentNode = '...'` 的字面量都替换为注册表引用。

### T2 SSE 节点维度 + 节点级工具历史

- **owner**：`packages/runtime`（事件产生）；`packages/ui/contracts/runtime.ts`（契约）。
- **要闭合的链**：`RuntimeSseEvent` 增加节点维度（如 `nodeId`、`iteration`），
  以及节点级的工具调用/返回事件可被投影。
- **约束**：只加领域生命周期字段，不加原始 provider payload、不加重试/降级控制字段。
  事件类必须遵守 `packages/runtime/src/events/types.ts` 的 control/data/observation 分类。
- **验收**：SSE 契约测试断言新字段存在且类型正确；事件在 replay 后顺序与 `seq` 一致；
  控制真相没有被写进业务 payload。

### T3 交接事实与 payload 语义

- **owner**：`packages/runtime`（交接产生者）；`packages/contracts`（类型）。
- **要闭合的链**：跨 agent 移交是一个可观测事实。必须明确它是**节点**还是**事件**，
  并给出：`from` agent 角色、`to` agent 角色、上游节点、下游节点、携带产物摘要、
  实际 payload 引用、发生时间、以及**不回传内容**的边界。
- **边界**：payload 引用必须能被受控读取，不得内联凭据、token、route 或 transport frame。
- **验收**：至少一条交接的 focused 测试，断言交接内容与"不回传"字段；
  负向测试断言受禁内容不会被投影出去。

### T4 UI 契约与投影

- **owner**：`packages/ui/contracts` + `packages/ui/projection`。
- **要闭合的链**：把 T1/T2/T3 的事实投影成界面需要的最小结构：

```ts
// 方向性说明，不是最终签名；实现者按既有命名风格落定
interface TaskFlowNodeProjection {
  nodeId: string; title: string; kindDisplay: string;
  ownerAgentRole: AgentRoleDisplay;   // 复用既有类型，不自造
  stateDisplay: string; iteration: number;
  activity: string; summary: string;
  toolSteps: readonly NodeToolStepProjection[];   // 左栏
  updatedAt?: string;
}
interface AgentFrameProjection {
  agentId: string; role: AgentRoleDisplay; roleDisplay: string;
  stateDisplay: string; iteration: number;
  nodeIds: readonly string[];         // 同 agent 的节点在同一框内
}
interface HandoffProjection {
  handoffId: string; fromRole: AgentRoleDisplay; toRole: AgentRoleDisplay;
  fromNodeId: string; toNodeId: string;
  carrySummary: string; payloadPreview: string;
  notCarried: string; occurredAt: string;
}
```

- **约束**：投影是纯函数，禁止在投影里读 Journal/DSH/RCC；
  禁止 fallback 数据；数据缺失必须是 `empty`/`unknown` 而不是编造。
- **验收**：`tests/ui/runtime-projection.test.ts` 增加正反用例；
  `packages/ui/contracts/models.ts` 的新增类型有负向测试（缺字段不得静默通过）。

### T5 三处界面落盘

- **owner**：`docs/ui`（由 `scripts/copy-ui-assets.mjs` 复制到 `dist/app/ui`）。
- **宿主**：任务列表行 → `docs/ui/tasks.html`；节点 DAG 与底部抽屉 → `docs/ui/observation.html`；
  agent 工作卡片 → `docs/ui/task-dashboard.html`。
- **视觉真源**：沿用 `docs/ui/runtime.css` 的既有 token（`--ink` / `--muted` / `--line` /
  `--accent` / 语义状态色）与 radius 区间，不引入第二套视觉语言。
- **必须做的**：
  1. 列表行显示当前节点、正在处理、第几轮、归属 agent。
  2. DAG 竖向；同 agent 节点在同一个归属框内；每个 agent 都出现，包括记忆 agent。
  3. 已完成的边用静态线、箭头在中点；运行中的边用动效线、箭头在终点。
  4. 点节点从底部抽屉打开；左栏工具调用历史，右栏 summary；另有一页交接内容。
  5. 顶部显示 agent 链路，显式"上游 agent → 下游 agent"的先后关系。
- **可访问性**：抽屉焦点陷阱与返回（`docs/ui/README.md` 已定：关闭后焦点回到原卡片入口）；
  触控目标 ≥44px；`prefers-reduced-motion` 下动效退化为状态切换。
- **验收**：桌面与手机视口下 0 处连线穿过节点框、无横向滚动、无节点重叠；
  窄屏抽屉为单列堆叠；`0` 个运行时报错。

### T6 记忆 agent 状态面

- **owner**：`packages/runtime/src/memory` + `packages/ui`。
- **要闭合的链**：记忆 agent 的当前状态（等待收口 / 沉淀中 / 已沉淀 / 拒绝沉淀）必须来自
  `memory` 侧已有的 typed 状态，不得由 UI 从别处推断。
- **约束**：`packages/runtime/src/memory/agent.ts` 与 `memory/events.ts` 已有的失败状态分类
  （`waiting` / `attention`）是唯一真源，UI 只做展示。
- **验收**：记忆 agent 在 DAG 中有独立归属框；其状态与运行时一致；
  未收口时不得显示为"已沉淀"。

### T7 端到端验收

- **owner**：主脑指定，实现者与验证者必须不同人。
- **证据**（缺一即 `UNVERIFIED`）：
  1. `pnpm build` 通过；
  2. `pnpm test:ui`、`pnpm test:runtime` 通过；
  3. 从 `main` 重建产物（`pnpm build:app` 会执行 `copy-ui-assets`）后，
     真实 Runtime 实例上打开入口，确认页面消费的是新产物而不是旧 `dist` 缓存；
  4. 在真实运行任务上观察到节点级 live 更新；
  5. 桌面 + 手机两个入口各截一次实测结果。

## 4. 派单：worker 提示词

主脑（用户）把下面这段直接交给一个编码 agent。派单权限由 master 决定，**一次只派一个 T**，
前一个 T 的验收证据回来之前不派下一个。

### 4.1 总则（每个 worker 都适用）

```text
你是 HumanAgent 仓库的实现 worker，不是 master。你只执行下面这一个 T 的获批范围。

工作树：必须从最新 origin/main 新建独立 worktree
        /Volumes/extension/code/humanagent/playground/<task>-<日期>
        禁止在 dirty main、旧 worktree 或他人变更上开发。
        禁止 pkill / killall / kill $(...)。
        禁止 --no-verify 或任何绕过 hook 的做法。
        禁止 Python/Node/Perl/sed/awk 做语义批量替换；逐文件用 apply_patch。

证据纪律：
- 没有工具结果就不要声称读过、改过、跑过、通过。
- 候选通过不等于已 merge；本地测试绿不等于真实入口验收。
- 缺验收证据只能报 INCOMPLETE 或 UNVERIFIED，不得用"理论上应该没问题"补齐。

控制真相纪律：
- 节点身份、轮次、状态、交接都是控制面事实，只能来自 typed control resource、
  error chain 或项目声明的配置源；不得写进请求/响应业务字段、metadata 或日志后再重建。
- 不得新增 fallback、降级、双路径补偿或 mock 成功。

报告格式：what changed（文件+行） / evidence（命令+exit code+关键输出） /
          unverified（明确列出） / blockers（根因+拟改+所需授权）。
```

### 4.2 T1 派单

```text
task_id: flow-transparency-t1-node-identity
范围：packages/runtime/src/ui-runtime/coordinator.ts、packages/runtime/src/nodes/、
      packages/contracts/src/index.ts（仅在需要新类型时）
允许：上述路径 + 对应 tests/runtime/**
禁止：packages/ui/**、docs/ui/**、adapters/**、note.md

目标：让节点身份有唯一真源，并定义"轮次"。

必须完成：
1. 建立显式节点注册表：nodeId → nodeKind → 归属 AgentRoleDisplay → 上游节点。
   归属角色取值只能来自 interaction / orchestration / execution / review / memory。
2. coordinator.ts 中每一处 `record.currentNode = '<字面量>'` 改为引用注册表。
   当前字面量清单（main @ f2a4531）：orchestration.plan(1309)、provider.execute(825)、
   provider.tool(1624)、provider.model(1625)、checkpoint.commit(1721/1802/2027)。
3. 对齐 docs/architecture/organ-runtime.md:221 的 13 节点链：要么让运行时真正产生这些标识，
   要么把实际节点集合定义为唯一真源并同步修正文档中不一致的部分。
   二选一并在报告里说明选了哪个、为什么。
4. 定义"第几轮"：写进文档，来源限定为 AssignmentProjection.attempt 或 executionEpoch。
   禁止新增独立计数器。

完成 iff：
- 注册表被单测覆盖：每个节点有唯一 kind、唯一归属角色、上游可达、无环。
- coordinator.ts 中不再有裸露的 currentNode 字符串字面量。
- 轮次定义写进 docs 且与代码一致。
- `pnpm build && pnpm test:runtime` 通过，报告 exit code。

禁止：不要顺手改 UI，不要顺手改 observation 的三个占位节点（那是 T4/T5 的范围）。
```

### 4.3 T2 派单

```text
task_id: flow-transparency-t2-sse-node-dimension
前置：T1 已通过独立 review 并 merge 到 clean main（提供 main merge SHA）
范围：packages/ui/contracts/runtime.ts、packages/runtime/src/ui-runtime/、
      packages/app/src/ui-runtime/server.ts + service.ts
允许：上述路径 + tests/ui/runtime-projection.test.ts、tests/app/ui-runtime.test.ts
禁止：docs/ui/**、adapters/**

目标：让 SSE 事件带节点维度，使 UI 能按节点实时更新。

必须完成：
1. RuntimeSseEvent 增加节点维度字段（nodeId、轮次）。字段名与 T1 的注册表对齐。
2. 按 packages/runtime/src/events/types.ts 的事件分类，确认新增事件属于
   control / data / observation 中的哪一类，并在报告里说明理由。
3. 节点级工具调用与返回可被投影（左侧工具调用历史的数据来源）。
4. 保留既有 10 种 kind 的语义，不重命名、不删除。

完成 iff：
- 契约测试断言新字段存在、类型正确、缺失时显式失败而不是静默。
- replay 后事件顺序与 seq 一致。
- 事件流中不出现凭据、token、RCC route、原始 transport frame、Journal 原始记录、DSH 类型。
- `pnpm build && pnpm test:app && pnpm test:ui` 通过。

禁止：不要改 docs/ui 的任何页面。不要为了让测试通过而放宽契约。
```

### 4.4 T3 派单

```text
task_id: flow-transparency-t3-handoff-fact
前置：T2 已 merge（提供 main merge SHA）
范围：packages/runtime/src/communication/、packages/runtime/src/orchestration/（如交接产生于此）、
      packages/contracts/src/index.ts
允许：上述路径 + 对应 tests/runtime/**
禁止：packages/ui/**、docs/ui/**

目标：把跨 agent 移交变成可观测事实。

必须完成：
1. 决策并说明：交接是节点还是事件。二者选一，给出理由。
2. 交接事实至少含：from 角色、to 角色、上游节点、下游节点、携带摘要、
   payload 引用、发生时间、不回传内容。
3. payload 引用走受控读取，不内联凭据/route/token/transport frame。

完成 iff：
- 至少一条交接的正向测试：断言交接内容与"不回传"字段。
- 至少一条负向测试：断言受禁内容不会出现在投影/事件里。
- `pnpm build && pnpm test:runtime` 通过。

禁止：不要为了 demo 里那 4 条交接边去硬编码数据。demo 是需求示意，不是真源。
```

### 4.5 T4 派单

```text
task_id: flow-transparency-t4-ui-projection
前置：T1、T2、T3 已 merge
范围：packages/ui/contracts/models.ts、packages/ui/contracts/runtime.ts、
      packages/ui/projection/index.ts
允许：上述路径 + tests/ui/**
禁止：docs/ui/** 的实现（页面是 T5 的范围）

目标：把节点/分组/轮次/交接投影成界面需要的最小结构。

必须完成：
1. 新增节点投影、agent 归属框投影、交接投影。
   归属角色复用既有 AgentRoleDisplay，禁止自造角色枚举。
2. 扩展现有 projectPipelineObservation，不新建第二套观察投影。
3. 移除 packages/app/src/ui-runtime/service.ts:888/899/911 的手写占位节点语义，
   改由 T1 注册表驱动（若该改动落在 app 侧，与 master 确认后扩大允许范围）。

完成 iff：
- tests/ui/runtime-projection.test.ts 增加正反用例。
- 缺字段/未知节点必须显式失败或显式 unknown，禁止静默 fallback。
- 投影是纯函数，不读 Journal、DSH、RCC。
- `pnpm build && pnpm test:ui` 通过。

交付条件：给出新增契约的最终 TypeScript 签名；master 审过签名后才派 T5。
```

### 4.6 T5 派单

```text
task_id: flow-transparency-t5-surfaces
前置：T4 已 merge，契约签名已冻结
范围：docs/ui/tasks.html、docs/ui/tasks.js、docs/ui/tasks.css、
      docs/ui/observation.html、docs/ui/observation.js、docs/ui/observation.css、
      docs/ui/task-dashboard.html、docs/ui/task-dashboard.js、docs/ui/task-dashboard.css、
      docs/ui/runtime.css（仅在必须新增共享 token 时）
禁止：packages/**、tests/**、任何 mock 真实运行状态的做法

目标：把 demo 的四条要求落到真实页面，消费 T4 的投影。

必须完成：
1. 列表行：当前节点、正在处理、第几轮、归属 agent。
2. 竖向 DAG：同 agent 节点在同一归属框内；5 个 agent 全部出现，含记忆 agent；
   显式呈现 agent 链路先后关系（上游 → 下游）。
3. 边：已完成 = 静态线 + 中点箭头；运行中 = 动效线 + 终点箭头。
4. 点节点从底部抽屉打开：左栏工具调用历史，右栏 summary；另有一页交接内容。
5. 记忆 agent 状态来自 T6 尚未落地时，显示 unknown/等待，不得编造已沉淀。

口径（必须遵守，不要自行放宽）：
- docs/ui/README.md 规定"不暴露或伪造私有 chain-of-thought"。
  左栏呈现的是工具调用、工具返回、agent 写入 summary 的结论。
  禁止把模型私有思维链原文渲染进去。
- 不使用"大脑""器官"作为界面标题。用 交互/任务编排/执行/审核/经验整理 这套既有角色标签。

完成 iff：
- 桌面 + 手机视口：0 处连线穿过节点框、无横向滚动、无节点重叠、0 运行时报错。
- 窄屏单列堆叠；抽屉焦点陷阱与关闭后焦点返回正确。
- prefers-reduced-motion 下动效退化。
- 不出现任何伪造的运行状态；mode 非真实时必须按要求标注。
- `pnpm build`（含 copy-ui-assets）通过，并在真实 Runtime 实例上打开入口确认新产物生效。
```

### 4.7 T6 派单

```text
task_id: flow-transparency-t6-memory-surface
前置：T5 已 merge（或与 T5 并行但写入范围互不重叠，由 master 决定）
范围：packages/runtime/src/memory/、packages/ui/projection/（记忆相关部分）
禁止：docs/ui/** 的 DAG 布局代码、node_modules 生成物

目标：记忆 agent 的状态可被界面正确消费。

必须完成：
1. 记忆 agent 状态只来自 packages/runtime/src/memory/agent.ts 与 memory/events.ts
   已有的 typed 状态与失败分类（waiting / attention 等）。
2. 提供投影：当前状态、最近沉淀产物引用、被拒绝沉淀的原因。

完成 iff：
- 单测覆盖：未收口时状态不是"已沉淀"；拒绝沉淀时原因可读。
- `pnpm build && pnpm test:runtime && pnpm test:ui` 通过。

禁止：不要新增记忆 agent 的并行状态副本。
```

### 4.8 T7 验收派单

```text
task_id: flow-transparency-t7-acceptance
执行者：与 T1–T6 实现者不同的人

验收清单（逐项给证据，缺一项即 UNVERIFIED）：
1. 独立 worktree、candidate SHA、main merge SHA、main 仍 clean。
2. pnpm build 通过；pnpm test:ui / test:runtime / test:app 通过（附 exit code）。
3. 产物从 main 重建：确认 dist/app/ui 下的 html 来自 docs/ui 的本次改动
   （比对文件 hash），并重启本地运行实例后生效。
4. 真实运行任务上观察到节点级 live 更新（不是静态 mock）。
5. 桌面 + 手机入口实测截图或等价可核验记录。
6. 本轮新增的临时文件、进程、worktree 已清理；清理记录逐条给出。

判定：任一适用项缺证据 → 只能报 INCOMPLETE 或 UNVERIFIED。
```

## 5. 消融与奥卡姆约束（写进每个 T 的 review 检查项）

- 发现同一语义有第二套实现（例如两处各自算"当前节点"、两处各自算"轮次"），
  先定位唯一 owner、收敛调用、物理删除重复实现，不得只包一层。
- 不为假想的未来需求加配置项、开关或抽象层。节点注册表只登记当前真实存在的节点。
- 不新增依赖来解决已有能力能解决的问题。
- UI 不得持有一份"节点 → agent"的映射副本；该映射只能来自 T1 注册表的投影。

## 6. 明确不做（非目标）

- 不接 DSH provider，不扩 MVP 范围。
- 不新增生产部署、daemon 或 vector/RAG 能力。
- 不重写既有五个页面的责任划分（`docs/ui/README.md` 已冻结），只在其内补充流转表达。
- 不把 demo 原型文件搬进仓库；demo 只在 `/tmp`，作为需求示意与本文件的视觉参考。

## 7. 未决口径（需要用户确认后才可进入 T5）

1. **"推理"口径**：左栏是否保留模型的思考文本？
   现状建议：只保留工具调用/返回与 agent 写入 summary 的结论，去掉思考原文，
   以符合 `docs/ui/README.md` 的既有边界。需要用户确认。
2. **节点粒度**：MVP 是否要落地 `organ-runtime.md` 的完整 13 节点？
   现状建议：T1 先落实际存在节点 + 记忆 agent，13 节点链作为目标态逐步补齐。
   需要用户确认。
3. **交接载体**：交接做节点还是事件（T3 决策点）。影响 DAG 上是否多出一类节点。

## 8. 视觉参考

可交互 demo：`/tmp/humanagent-flow-demo.html`（用户已审核）。
已核实的表现：5 个 agent 归属框、13 节点、竖向排列、静态边中点箭头 / 运行边动效箭头、
底部抽屉左右两栏 + 交接页、顶部 agent 链路条。
demo 只是需求示意：其中的节点标识、交接 payload、事件数据均为原型数据，
落盘时必须换成 T1/T2/T3 提供的真实来源。
