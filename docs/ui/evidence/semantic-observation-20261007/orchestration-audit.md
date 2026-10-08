# 任务编排只读审计结果

- 身份：独立审计执行者（非 Collab master，未启动 child/reviewer）。
- Worktree：`/Volumes/Intel/playground/humanagent/semantic-observation-20261007`
- Baseline：`9d1f39c53f09e31a4636fa75f97042c18e8bb114`（审计时 HEAD 与之一致）
- 方法：只读源码/契约/测试/声明 graph 交叉核对；未运行 build、test、daemon、install；未改产品代码、未做 Git mutation。
- 结果分级：`IMPLEMENTED`（代码+测试证据齐全）/ `PARTIAL`（主链存在但有已声明缺口）/ `UNIMPLEMENTED`（领域概念缺失）。凡无当前实测证据的能力标 `UNVERIFIED`，不得当作完成。

## 1. 结论摘要

1. **“任务模板/任务类型/计划版本”不是当前领域概念。** `Task`、`RequirementEnvelope`、`WorkAssignment` 都没有 task-type、workflow-template、plan-version 字段（`packages/contracts/src/index.ts:48-56`、`:97-109`、`:729-733`）。仓库里的 “template” 只指 **agent 角色模板**（interaction/orchestration/execution/review/memory），不是巡检/长程/单次的任务阶段模板（`packages/agent-templates/src/types.ts:11`、`:41-45`；`packages/agent-templates/src/template.ts:296-303`）。
2. **触发策略与任务类型是两套独立概念。** `once | scheduled | recurring` 是执行触发策略，已实现且生产接线；它不选择阶段模板，也不携带任务类型（`packages/contracts/src/explicit-brain.ts:288-329`；`packages/app/src/ui-runtime/scheduler.ts:124-273`）。
3. **存在两套图，且二者未接线。** 固定 13 节点“系统流水线”是只读展示模型（`packages/runtime/src/nodes/node-registry.ts:64-257`）；动态 “assignment 图” 是真正执行编排（`packages/runtime/src/orchestration/assignment-graph.ts:201-684`）。UI 观测只消费固定 registry，未消费动态 assignment 快照（`packages/app/src/ui-runtime/service.ts:2199-2291`）。
4. **执行 agent 的 assignment scope 与 fencing 强，且可核。** lease 带 runtimeId/generation/executionEpoch/ownerId/assignmentId，acceptResult 逐项校验；review/merge 不可用即 blocked（`packages/runtime/src/orchestration/types.ts:37-45`、`assignment-graph.ts:397-541`、`manager.ts:537-912`）。
5. **stable+live 推理当前是 task/operation/epoch 级，缺节点/轮次/assignment 身份。** `RuntimeSseEvent` 无 `nodeId`/`attempt`/`assignmentId`（`packages/ui/contracts/runtime.ts:267-303`）；且固定节点迭代取 `executionEpoch`，与 registry 头注声明的 `attempt` 语义冲突（`packages/app/src/ui-runtime/service.ts:476`、`packages/runtime/src/nodes/node-registry.ts:7-23`）。
6. **统一语义投影 owner 未接生产路径。** `context-events` 的 `toUserNarrative` 只在包内与测试中使用，packages 其他模块无消费者；app 观测自行配对 raw event kind（`packages/context-events/src/projector.ts:101`；`packages/app/src/ui-runtime/service.ts:701-720`）。

## 2. 实际领域类型 / 模板 / 计划版本 owner 与调用链

### 2.1 领域类型

| 概念 | 现状 | owner / 证据 |
|---|---|---|
| Task | 仅 `id/organId/title/directive/directiveRevision/state/memoryScope`；无 task-type/template/plan-version | `packages/contracts/src/index.ts:48-56` |
| RequirementEnvelope | 仅 `requirementId/draftId/inputRevision/intent/taskRef/normalizedInput/confirmed*/fifoSeq/payloadRef`；无 policy/类型 | `packages/contracts/src/index.ts:97-109` |
| WorkAssignment | 有 `pipelineNodeId/attempt/executionEpoch/inputRevision` 与 criteria/capabilities/mergeGate；无 task-template 或 plan-version 身份 | `packages/contracts/src/index.ts:729-733` |
| PipelineNodeId（13 节点） | `PIPELINE_NODE_IDS`/`PIPELINE_ROWS` 唯一真源 | `packages/contracts/src/index.ts:1613-1682` |

结论：**任务类型/阶段模板/计划版本在领域层 UNIMPLEMENTED**，只能在 agent 角色层与触发策略层分别近似表达。

### 2.2 “模板”真实含义

`packages/agent-templates` 定义的是 agent 角色模板：`AgentTemplateManifest.kind='humanagent.agent-template'`、`templateApiVersion`、`templateVersion`（`packages/agent-templates/src/types.ts:41-45`），按角色（`AGENT_ROLE_IDS`）编译 capabilities/skills/tools（`packages/agent-templates/src/template.ts:281-303`）。它不含任务阶段/巡检流程/长程计划结构。

### 2.3 计划与触发 owner

- 触发策略类型 `ExecutionMode='once'|'scheduled'|'recurring'` 与 `ExecutionPolicyDefinition`：`packages/contracts/src/explicit-brain.ts:288-329`；校验器 `:834-913`。
- 目标/订阅/occurrence/reminder/lease 契约：`packages/contracts/src/framework.ts:752-827`；校验器 `:1272-1375`。
- 控制与认领 fencing（core）：`packages/core/src/subscription.ts:262-537`；`once` 上限 1（`:400-403`）。
- 运行期调度端口与槽位生成：`packages/runtime/src/subscriptions/index.ts:657-1049`（控制端口 `:367`）。
- app 侧巡检实现：`packages/app/src/ui-runtime/scheduler.ts:124-273`；仅当存在 supervisor lease 时才创建调度器（`packages/app/src/ui-runtime/index.ts:354-386`）。
- 计划持久化与真实 linkage：`packages/app/src/ui-runtime/service.ts:3257-3303`。

## 3. 动态任务图 vs 固定系统图

### 3.1 固定系统图（13 节点 registry）

- 定义与上游边：`packages/runtime/src/nodes/node-registry.ts:64-257`（含 `memory.agent` 的 `upstream:['settle']` 事实边）。
- 头注声明轮次真源 = `AssignmentProjection.attempt`，并明确拒绝用 `executionEpoch` 作轮次：`packages/runtime/src/nodes/node-registry.ts:7-23`。
- 运行期节点标记 `RUNTIME_NODE_MARKERS`（`input.received`/`orchestration.plan`/`provider.*`/`checkpoint.commit`）是子步标记，不是 13 节点 id：`packages/runtime/src/nodes/node-registry.ts:236-247`。

### 3.2 动态任务图（assignment 图）

- 状态与转移：`packages/runtime/src/orchestration/assignment-graph.ts:201-684`；快照 `:645`。
- 状态/记录类型：`packages/runtime/src/orchestration/types.ts:16-272`。
- 调用链：`planStage` 加 stage（`manager.ts:227`）→ `dispatch`（`:235`）→ `executeWithLease`（`:370`）→ `acceptResult`（`:440`）→ `reviewAndMerge`（`:537-912`）。
- 生产 app 路径通过 `taskAssembly(...).orchestration.graph.snapshot()` 读取动态图：`tests/app/serve-runtime.test.ts:468`、`:554`。

### 3.3 两图差异与断边（关键缺口）

- UI 观测按固定 registry 建节点，事实由固定 nodeId `switch` 派生：`packages/app/src/ui-runtime/service.ts:2199-2291`、`:463-604`。
- 根 scope 明确写“十三个流水线节点”，provider 子 scope 用 **event kind + seq** 建节点，不是 assignment 节点：`service.ts:2240-2248`、`:2225-2257`。
- 投影函数本身可接受任意节点集合，但 app 未把动态 stage/assignment 喂进去：`packages/ui/projection/index.ts:947-999`。

结论：**动态图→UI 的观测边 UNIMPLEMENTED**；固定图是展示真源，动态图是执行真源，二者当前只在测试里各自可读，未在 UI 汇合。

## 4. 执行 agent task assignment scope 与 fencing

- lease 身份：`RuntimePoolLease{runtimeId,generation,executionEpoch,ownerId,assignmentId}`（`packages/runtime/src/orchestration/types.ts:37-45`）。
- runtime 单绑定：每 runtime 至多一个 lease（`packages/runtime/src/orchestration/runtime-pool.ts:202-211`）；获取/释放 fencing `:441-486`（release `:458`）。
- manager 在执行前绑定 agent 与 lease：`packages/runtime/src/orchestration/manager.ts:370-385`。
- `acceptResult` 校验 running 状态、executionEpoch、runtime/generation/lease/assignment/epoch、expectedAgent 与结果 agent、契约与 criteria：`packages/runtime/src/orchestration/assignment-graph.ts:397-541`（epoch `:439`，agent `:469`）。
- agent 一旦绑定不可改：`assignment-graph.ts:301-347`。
- review/merge 只在结果被接受后发生；不可用即 blocked：`manager.ts:526-912`。
- 生产执行：为每个 assignment 建 provider driver，runtimeId/operationId 由 assignment/attempt/epoch 派生，并按 assignment 字段回传 WorkResult：`packages/app/src/ui-runtime/service.ts:1599-1724`。

结论：**assignment scope 与 fencing 为 IMPLEMENTED**，证据充分（源码 + 下列测试）。

## 5. 触发策略：once / scheduled / recurring

- `once` 至多 1 个 occurrence：`packages/core/src/subscription.ts:400-403`。
- late/busy 策略（`run-once`/`skip`、`skip`/`idle-reminder`）在槽位与认领路径：`packages/runtime/src/subscriptions/index.ts:694-768`、`:819-830`。
- app 巡检：`scheduler.ts:124-273`（lease 缺失即 typed fail-closed，不伪造调度）。
- 生产入口与终态超时：`packages/app/src/ui-runtime/service.ts:2339-2484`。
- 公开 plan 控制只支持 `pause`/`resume`/`cancel-future`，**不支持 modify**：`service.ts:2019-2080`；测试明确拒绝 `execution-plan.action-unsupported`（`tests/app/plan-control.test.ts:148-155`）。

结论：**触发策略 PARTIAL 且已生产接线**（explicit-requirement、scheduled-occurrence 两图 `capabilityStatus=partial` 且 production wiring `WIRED`）。触发策略**不承载任务模板**。

## 6. stable + live 推理实际能力

- SSE 事件仅 `taskId/operationId/executionEpoch/kind/state/summary/evidenceRefs/...`，**无 nodeId/attempt/assignmentId**：`packages/ui/contracts/runtime.ts:267-303`。
- 运行期任务事件同样缺节点/assignment 身份：`packages/runtime/src/ui-runtime/coordinator.ts:85-129`。
- SSE 路由按 task/operation 限定，writer 直序列化 typed event：`packages/app/src/ui-runtime/server.ts:1068-1079`、`:302-306`。
- Dashboard 只带 `executionEpoch`，无 assignment round/plan revision：`packages/ui/contracts/runtime.ts:189-214`。
- UI 观测迭代取 `task.executionEpoch ?? 1`：`service.ts:476`、`:2246`、`:2255`；与 registry 头注的 `attempt` 语义冲突（`node-registry.ts:7-23`）。

结论：**live/stable 推理当前是 task/operation/epoch 级，节点级 live（节点身份+轮次）UNIMPLEMENTED**，与 `docs/ui/task-flow-transparency-implementation.md` 的 T2/T3/T7 缺口一致。

## 7. 公开 API

- Task dashboard：`GET /api/tasks/:id/dashboard`（`packages/app/src/ui-runtime/server.ts:978-981`）。
- Observation：`GET /api/tasks/:id/observation?node=&scope=`（`server.ts:982-988`；实现 `service.ts:2199`）。
- 执行事件 SSE：`GET /api/executions/:op/events`（`server.ts:1068-1079`）。
- Plan 控制：`service.ts:2032-2080`；路由/行为测试 `tests/app/plan-control.test.ts:65-213`。
- 调度状态：`packages/app/src/ui-runtime/index.ts:354-386`；生产测试 `tests/app/scheduler-production-wiring.test.ts:50-78`。

## 8. 现有成功 / 失败测试矩阵（仅静态引用，本次未运行）

| 领域 | 证据位置 |
|---|---|
| orchestration 成功/幂等 | `tests/runtime/orchestration/orchestration.test.ts:569-608` |
| 旧 epoch / 错 agent / 重复冲突 | `:610-652` |
| 重试与预算耗尽升级 | `:654-716` |
| review 失败与 merge 顺序 | `:718-822` |
| pending 执行/审查/合并重复派发 | `:824-999` |
| 终态幂等 | `:1160-1227` |
| review 冲突/持久真源 | `:1229-1277` |
| merge blocked | `:1299-1336` |
| 隐式默认任务 / override/fallback | `:1639-1760` |
| admission 队列/准入/控制字段泄漏 | `tests/runtime/admission/admission.test.ts:77-284` |
| UI 观测投影 正/反例 | `tests/ui/runtime-projection.test.ts:174-340` |
| app 观测 13 节点固定归属 | `tests/app/ui-runtime.test.ts:2125-2156` |
| stable/live 类用例 | `tests/app/ui-runtime.test.ts:1931-1992` |
| 生产调度 成功/失败/重启/循环/无 lease/忙跳过/取消 | `tests/app/scheduler-production-wiring.test.ts:40-271` |
| agent-role 模板 | `tests/agent-templates/template.test.ts:160-420` |
| plan 控制 | `tests/app/plan-control.test.ts:65-213` |
| 动态图生产路径 | `tests/app/serve-runtime.test.ts:468`、`:554` |

测试命令入口：`package.json:33`（test:contracts）、`:38`（test:app）、`:39`（test:provider）、`:40`（test:ui）、`:67`（test:runtime）、`:75`（test）。

## 9. 声明 graph 状态

- `docs/dagpipe/observation-read.graph.json`：`version=3`、`capabilityStatus=pending`、`designStatus=candidate`（`:4-8`）。模型为 read→normalize→pair→project→browser（8 节点/7 边），**未建模 task template / 动态 assignment**。
- `docs/dagpipe/explicit-requirement.graph.json`：`version=2`、`capabilityStatus=partial`，ownershipContract 明确 W1/W1b/W2/W4 分工（`:8-14`）。
- `docs/dagpipe/scheduled-occurrence.graph.json`：`version=1`、`capabilityStatus=partial`（`:8-9`），含 control/linearization 契约。
- 已声明缺口（源自 graph meta，非本次实测）：scheduled 的 unknown/in-progress 结果不能自愈；`latePolicy=skip` 在巡检间隔过大时可能漏槽；due-slot 计算为 O(total slots)。

## 10. 必需能力是否可用

| 能力 | 状态 | 依据 |
|---|---|---|
| 固定 13 节点系统图 | IMPLEMENTED | `node-registry.ts:64-257`；`tests/app/ui-runtime.test.ts:2125-2156` |
| 动态 assignment 图 + fencing | IMPLEMENTED | `assignment-graph.ts:201-684`；`orchestration.test.ts:569-1336` |
| once/scheduled/recurring 触发调度 | PARTIAL（已接线，含声明缺口） | `subscriptions/index.ts:657-1049`；`scheduler.ts:124-273`；`scheduler-production-wiring.test.ts:40-271` |
| 任务类型 / 阶段模板 | UNIMPLEMENTED | `contracts/src/index.ts:48-56`、`:97-109`；agent-templates 仅角色模板 `types.ts:41-45` |
| 计划版本 / 修订历史（durable plan-version） | UNIMPLEMENTED | `WorkAssignment` 无 plan-version `contracts/src/index.ts:729-733`；plan control 仅 pause/resume/cancel-future `service.ts:2019-2080` |
| 动态图持久化 / 崩溃恢复 | UNVERIFIED | 动态图在 runtime 实例内内存态；无 durable snapshot 证据 |
| 动态图 → UI 观测 | UNIMPLEMENTED | `service.ts:2199-2291`；`ui/projection/index.ts:947-999` |
| 节点/轮次/assignment 身份进入 live SSE | UNIMPLEMENTED | `ui/contracts/runtime.ts:267-303`；`coordinator.ts:85-129` |
| context-events 统一语义投影接生产 UI | UNIMPLEMENTED | `context-events/src/projector.ts:101`；无 packages 消费者（`rg toUserNarrative` 仅 context-events+测试） |

## 11. 最小修复切片（保持唯一 owner）

1. **契约层加任务模板/阶段计划身份**（owner：`packages/contracts`）。在 `Task` 或新的 plan 记录上加 typed `taskTemplateId`/`planRevision`，不写入 payload/metadata；配负向校验测试。
2. **durable plan-version 历史**（owner：`packages/runtime` + `packages/adapters/jsonl`）。以 append-only 记录保存 plan revision，使 `pause/resume/cancel-future` 之外可表达受控 revise；不新增第二计数器。
3. **动态 assignment 图 → UI 投影路径**（owner：`packages/app/src/ui-runtime` + `packages/ui/projection`）。把 `assignment-graph.snapshot()` 经现有 `projectPipelineObservation` 输入喂入，新增 scope，不新建治理骨架。
4. **stable/live 事件加节点身份**（owner：`packages/ui/contracts/runtime.ts` + `packages/runtime/src/ui-runtime/coordinator.ts`）。给 `RuntimeSseEvent` 增 `nodeId`/`attempt`（+可选 `assignmentId`），只加领域生命周期字段，不加 provider payload。
5. **轮次语义收敛**（owner：`packages/runtime`）。UI 迭代改用 `attempt`，删除 `service.ts:476` 的 `executionEpoch` 迭代，消除与 registry 头注的第二语义。
6. **接通 context-events 语义 owner**（owner：`packages/app/src/ui-runtime`）。用 `toUserNarrative`/`applyPairingOutcome` 替换 `service.ts:701-720` 的本地 raw 配对，复用唯一语义实现。
7. **真实入口黑盒用例**（owner：`tests/app`）。覆盖动态图→观测、节点级 live SSE、plan revise 的公开 API 成功/失败路径。

## 12. 完整后续开发目标

- G1 任务类型 + 阶段模板领域模型（contracts/core/runtime），由触发策略独立引用，不混入 payload。
- G2 durable plan-version/修订历史与受控 revise 控制面。
- G3 动态 assignment 图持久化与崩溃恢复，绑定 Journal 真源。
- G4 动态图 → Observation/Task Dashboard 的真实投影与 live 更新。
- G5 节点/轮次/assignment 身份进入 stable+live 契约与 UI。
- G6 context-events 成为唯一语义归类/配对/narrative owner，app 不再自造配对。
- G7 真实公开入口的黑盒回归（成功/失败/副作用）+ 独立 review 后再合并。

## 13. UNVERIFIED / INCOMPLETE 显式项

- 本次未运行任何 build/test/daemon/install，**无当前实测证据**；第 8 节为静态测试引用。
- `docs/dagpipe/observation-read.graph.json` 与 `.binding.json`、`.semantic.json` 处于工作树未提交修改状态（非本任务改动）；父 notes 记录的 `humanagent-observation-read@3 valid 8 nodes/7 edges/8 waves` 为父任务证据，本次未重跑校验。
- 动态图的持久化/恢复能力 `UNVERIFIED`。
- 端到端 live 节点级观测、plan revise、动态图 UI 投影均 `UNIMPLEMENTED`，不得视为完成。
- 巡检/长程/单次“任务模板”在领域层不存在；当前只能用触发策略 + agent 角色模板近似，标 `INCOMPLETE`。
