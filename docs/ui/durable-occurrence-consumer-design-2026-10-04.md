# 持久 occurrence consumer 前置设计（ServeTaskConsumerPort）

状态：**PRE-CODE DESIGN CANDIDATE / BLOCKED capability**。本文是 docs-only 设计产物，
不是 source PASS、不是独立 review、也不是已实现能力。真实 `ServeTaskConsumerPort`
当前不存在；本文只给出最小可实现的 owner、typed 记录、崩溃窗口、公开验证和解除路径。

## 1. 目标与范围

关闭 `interaction-verification-producer`（W3 保留树）到 scheduler 之间的上游能力缺口：

- 选定**唯一 durable execution owner**，用现有权威 Journal/checkpoint 原语实现真实
  `ServeTaskConsumerPort`，不新增第二 execution registry 或第二 terminal truth。
- 规定**dispatch 之前的原子持久准入**、terminal/verification receipt 持久化，以及
  execute-returned / settle-pending 重启后的 replay 规则。
- 逐条说明崩溃窗口与 forward recovery 结果；Provider 自动 resume 当前不支持，本文不把它
  承诺成已存在能力。
- 给出最小 future source allowlist、依赖顺序、两个互不重叠 owner 的 typed handoff，
  以及真实公开入口的候选测试与 consumer harness。

范围外（明确不做）：

- 不改 scheduler 的 late-skip / reminder 关闭逻辑（独立 scheduler corrective docs owner）。
- 不改 installed/package/restart 设计（独立 installed amendment owner）。
- 不实现任何 `packages/`、`tests/`、`scripts/`、package/lock/config/version 代码。
- 不组合已知 FAIL 的 W2 scheduler candidate，也不复制 W3 已验收字节进本 candidate。
- 不新增 scheduler、治理框架、generic execution registry、第二 terminal store。

## 2. 已确认事实（复用，不重复诊断）

以下事实来自已归档的 W3 保留树、scheduler 交付 handoff 与不可变 Git 版本，不在本轮重跑诊断。

- 稳定契约已存在：`OccurrenceTaskBinding`、`ServeTaskTerminalReceipt`、
  `OccurrenceSettlementInput`、`OccurrenceResult` 定义于 W3 保留树的
  `packages/contracts/src/tool-execution.ts`。
  `OccurrenceTaskBinding = { occurrenceId, subscriptionId, scheduleRevision,
  occurrenceOrdinal, taskId, operationId, executionEpoch, inputArtifactDigest }`。
- 现有 `consumeExecution` 只在 `settlement` 已存在时重放 terminal，否则直接调用
  `ServeTaskConsumerPort.executeOccurrence`。接口没有声明 durable idempotent/recovery
  guarantee。诊断 counter `dispatchCount=3` 只是 RED 派发证据。
- `UiRuntimeJournal` / `RuntimeTaskCoordinator.replayJournal()` 只恢复 projection/correlation
  事实；随后把任务置为 `unknown` / `需要恢复确认`，由 `hydrate()` 从权威 checkpoint journal
  重新确认生命周期。它是 correlation evidence，不是 durable dispatch/lifecycle truth。
- `FileOperationJournal` 只追加 `OperationEvent`；`ToolExecutionGateway` 的 operation state、
  idempotency 与 execution single-flight 都在内存 `Map` 中，当前不重放该文件。
- `FileCheckpointStore` 包装权威 `JsonlOrganJournal`；`hydrate()` 可恢复已提交的 terminal
  checkpoint，但仅凭它不能恢复 execute 已返回、settle 尚未提交的 in-flight execution。
- W3 `packages/runtime/src/ui-runtime/task-verification.ts` 产出 `TaskVerificationResult`，
  只在内存 `Map` 中 single-flight 每个 check；它不产出 `ServeTaskTerminalReceipt`，也不是
  durable execution owner。该文件当前 candidate 缺失。
- `ProviderAgentDriver.resume` 与 RCC v3 transport resume 显式返回 `resume.unsupported`；
  不能当作 durable execution recovery。
- 文本检索未发现真实 `ServeTaskConsumerPort` 实现。当前没有可演示的 durable consumer
  重放保证；真实实现前该能力标为 `BLOCKED`。

结论：**当前不存在可演示的 durable `ServeTaskConsumerPort`**。contract promise、内存标志或
诊断 counter 都不能替代真实 consumer 证据。

## 3. 唯一 durable owner 与真实原语

### 3.1 Owner

唯一 durable execution owner 是未来的**真实 `ServeTaskConsumerPort` adapter**，归属
app/ui-runtime 组装边界：

- 组装 owner：`packages/app/src/ui-runtime/service.ts`（app/ui-runtime assembly）。
  adapter 可在同一 owner 边界内拆成 sibling module，但 owner 不变。
- 权威持久化 owner（复用，不改真源语义）：`packages/adapters/jsonl/src/index.ts`
  的 `JsonlOrganJournal`，经 `packages/app/src/ui-runtime/journal.ts` 的
  `FileCheckpointStore` 绑定到 per-task-cycle journal 文件。
- 执行/checkpoint 编排 owner（复用）：`packages/runtime/src/ui-runtime/coordinator.ts`。
- 验证 owner（W3 保留树，待组合）：`packages/runtime/src/ui-runtime/task-verification.ts`。

该 owner 拥有 execute-or-resume 与 admission/replay 决策；它**不**拥有 terminal truth
（归已提交 checkpoint / Organ Journal），**不**拥有调度（归 scheduler）。

### 3.2 复用的真实原语

- `JsonlOrganJournal.transaction(read, apply)`：先 `acquireLock`，再 `readVerifiedJournal`，
  再执行 `apply` 内的 `appendLocked`。同一文件路径的并发事务串行化。
- `JsonlOrganJournal.appendLocked` 的 `commitId` 幂等：同 `commitId` 且同 commit-fact digest
  返回已存在记录；同 `commitId` 不同 digest 抛 `JournalCommitConflictError`。
- `FileCheckpointStore.commit(checkpoint)`：以 `checkpointCommitId(checkpoint)` 作 commitId
  写入权威 checkpoint；`readLatest(scope)` 只读 `kind: 'checkpoint'` 记录。
- `JsonlOrganJournal` 的 `kind: 'event'` 记录携带 typed `payload`；`readLatest` 忽略 event
  记录，所以新增 admission event 不会污染 checkpoint 读取。scheduler candidate 已用
  同一机制持久化自身状态（`payload.type === 'subscription-state'`）。
- Core `assertVerifiedTerminalReceipt`（scheduler candidate `packages/core/src/subscription.ts`）
  校验 terminal 身份与 `verification.status === 'success'`。

## 4. 具体 typed 记录与事务

### 4.1 Durable admission 记录（dispatch 之前）

写入**同一权威 per-task-cycle `JsonlOrganJournal`**，不新建文件、不新建 registry：

```text
OccurrenceExecutionAdmissionRecord {
  kind: 'occurrence-execution-admission'
  version: 1
  binding: OccurrenceTaskBinding
  dispatchRef: string        // 由 operationId + executionEpoch 派生的确定性 dispatch 身份
  admittedAt: string         // ISO-8601
}
```

事务：

```text
commitId = occurrenceExecutionAdmissionCommitId(binding)   // 确定性，来自 binding 全部字段
scope    = { organId, taskId, cycleId, operationId }        // 与 binding/operation 一致
journal.transaction(
  read  = verify() -> 取最后一条匹配 commitId 的 admission 记录
  apply = 无匹配时 appendLocked({ kind:'event', commitId, scope,
                                  payload:{ type:'occurrence-execution-admission', ... } })
)
```

因为 commitId 确定性且 `appendLocked` 在锁内幂等，两个进程/两个 port 竞争同一 binding 时
只有一个能首次写入；其余读到已存在记录。admission 提交返回之后才允许 dispatch。

### 4.2 Terminal / verification receipt 持久化

dispatch 返回并完成验证后：

1. 由现有 checkpoint 编排提交 terminal `Checkpoint`（`Checkpoint.outcome` 覆盖
   `succeeded|failed|blocked|cancelled|stopped`，`Checkpoint.recoveryStateRef` 与
   `evidenceRefs` 承载证据），commitId = 现有 `checkpointCommitId(checkpoint)`。
2. 由 W3 验证 bridge 产出 `TaskVerificationResult`。
3. 组合 `ServeTaskTerminalReceipt`：

```text
ServeTaskTerminalReceipt {
  taskId, operationId, executionEpoch, inputArtifactDigest   // 必须等于 binding
  verification: TaskVerificationResult                        // 验证权威
  terminalCheckpointRef                                        // 已提交 checkpoint 身份
  settlementReceiptRef                                         // 确定性 settlement 身份
  recoveryResponsibility?                                      // 未释放资源时必须填写
}
```

receipt 是已提交 checkpoint + 验证结果的投影；scheduler 用现有
`assertVerifiedTerminalReceipt` 校验身份后 `settleOccurrence` 原子提交。**checkpoint/Organ
Journal 是 terminal 权威**；verification 不是独立 lifecycle truth，scheduler settlement
引用一个已提交的 verified terminal。

### 4.3 Replay 规则（execute-returned / settle-pending 重启）

consumer 从权威 journal 派生三态，再决定动作：

| 持久状态 | 判定 | 动作 |
| --- | --- | --- |
| settlement 已存在 | 已完成 | 返回同一 `ServeTaskTerminalReceipt`，不 dispatch |
| terminal checkpoint 已提交，settlement 未提交 | 已完成执行 | 重建 receipt 返回；由 scheduler settle |
| admission 已存在，terminal 未提交 | 中断/不确定 | 标 blocked/recovery，**不重新 dispatch** |
| 无 admission | 可准入 | 原子 admission 后唯一 dispatch |

## 5. 崩溃窗口与 forward recovery

每个窗口的 durable 状态、可证明性与结果：

| 崩溃窗口 | 重启时持久状态 | Forward recovery |
| --- | --- | --- |
| admission 提交前 | 无记录 | 安全：admission + 唯一 dispatch |
| admission 提交后、dispatch 调用前 | admission，无 terminal | 不能证明 Provider 未启动 → 判不确定，blocked/recovery，不自动重派 |
| dispatch 进行中（Provider 已启动） | admission，无 terminal | 外部副作用不确定 → blocked/recovery，不自动重派 |
| execute 返回后、terminal checkpoint 提交前 | admission，无 terminal | 同上 → blocked/recovery，不自动重派 |
| terminal checkpoint 已提交、settlement 前 | admission + terminal checkpoint | 重建 receipt 返回；scheduler settle（settle 以 commitId 幂等） |
| settlement 已提交 | settlement 记录 | 完成重放，返回已提交 terminal |

关键规则：**admission 提交之后不再自动重派**。`ProviderAgentDriver.resume` 与 RCC v3
transport resume 返回 `resume.unsupported`，所以无法区分"dispatch 未发出"与"dispatch 已发出
但无回执"。自动重派会重复外部副作用；本文选择诚实且安全的 blocked/recovery，而不是
promise 一个不存在的 resume。

blocked/recovery 必须绑定**真实 core error/checkpoint/stop settlement 语义**：

- 用现有 `Checkpoint.outcome = blocked`（或 `failed`）与 `recoveryStateRef`/`evidenceRefs`
  记录未收口事实，`NextAction.kind = 'recover' | 'stop'`。
- 用现有 `RuntimeTaskCoordinator.markRecoveryRequired` 的投影语义
  （`state = blocked`，`currentState = 进程已重启或缺少终态 checkpoint`，
  `nextStep = 确认 Provider 资源已释放后再发起新执行`）呈现用户可见结果。
- 需要取消时只走标准 stop operation（`AgentDriver.requestStop` → `settle`，收拢
  `AgentClosure`）；取消模型请求不等于 stop 完成。
- 不伪造 success、不伪造 cancellation、不丢弃 recovery 资源、不降低验收标准。

## 6. 稳定终态身份与验证权威

- terminal 身份必须匹配 `OccurrenceTaskBinding`：`taskId`、`operationId`、`executionEpoch`、
  `inputArtifactDigest` 全部相等；`terminal.verification` 同样校验上述身份。
- 一个 `OccurrenceTaskBinding` 只对应一次业务执行。并发进程/端口、stale claim generation
  和 crash/restart 都由 admission commitId 幂等 + claim/lease 校验保证。
- `ServeTaskTerminalReceipt.verification.status` 覆盖
  `success | failed | rejected | missing | blocked | cancelled`。
  Core `assertVerifiedTerminalReceipt` 当前只接受 `success`；非成功终点需要**扩展 settle
  终点判定**（按 outcome 分别处理），但不得扩大为接受伪造成功。
- verification 不成为独立 lifecycle truth；它只作为 terminal receipt 的字段。

## 7. 终点区分

| 终点 | 判据 | 结果 |
| --- | --- | --- |
| completed replay | settlement 存在 | 返回已提交 terminal，不 dispatch |
| live concurrent wait | 同 binding 在本进程 in-flight | 等待同一 promise，不第二次 dispatch |
| interrupted / uncertain | admission 存在、terminal 缺失 | blocked/recovery，用户可见，不重派 |
| verification failure | 验证 status ≠ success | 非成功 terminal，保留原始 evidence |
| reject / missing / blocked / cancelled | 验证对应 status | 对应 typed 非成功 outcome；blocked 不伪装成功；cancelled 只在 stop settle 后收口 |
| persistence failure | journal append/commit 抛错 | fail closed：admission 失败则不 dispatch；terminal 失败则不宣称成功 |
| actual side-effect release | 执行/tool/browser/port 资源已释放 | 释放证据入 receipt；未释放必须显式 recovery inventory |
| cleanup | consumer 释放自有资源，scheduler 保留 receipt | 未 release 显式进入 recovery inventory，不静默丢弃 |

## 8. 最小 future source allowlist 与依赖顺序

前置：当前 candidate 不含 W3 `packages/runtime/src/ui-runtime/task-verification.ts`，也没有真实
`ServeTaskConsumerPort`。若必须复用 W3 已验收字节，parent 必须先完成最小组合；不得用 stub
跳过。core 契约变更必须先于依赖它的实现。

依赖顺序：

```text
W3 actual verification bytes composition
  -> durable consumer owner (ServeTaskConsumerPort adapter + admission/replay)
  -> scheduler recovery/call contract (consumeExecution 调用 + 非成功 settle 终点)
  -> public E2E
```

允许路径（parent 独立 review 通过后再派发）：

| 顺序 | 文件 | Owner | 内容 |
| --- | --- | --- | --- |
| 0 | `packages/contracts/src/tool-execution.ts` | 契约 owner（先于实现） | 仅在需要时新增 `OccurrenceExecutionAdmissionRecord` typed 形状与 validator |
| 1 | W3 `packages/runtime/src/ui-runtime/task-verification.ts` | W3 bytes 组合 owner | 组合实际 W3 验证 bridge；不得以 stub 代替 |
| 2 | `packages/app/src/ui-runtime/service.ts`（及同 owner sibling module） | 持久 consumer owner | 实现真实 `ServeTaskConsumerPort` adapter：原子 admission、execute-or-resume、terminal receipt 组合 |
| 3 | `packages/app/src/ui-runtime/journal.ts` | 持久 consumer owner | 仅当现有 record 类型不足时补最小 admission 读写；不新增 generic registry |
| 4 | `packages/runtime/src/ui-runtime/coordinator.ts` | 持久 consumer owner | 仅当需要暴露 execute/settle seam 时最小改动 |
| 5 | `packages/core/src/subscription.ts` | scheduler/core owner | 非成功 settle 终点判定扩展；保持 core 唯一 owner |
| 6 | `packages/runtime/src/subscriptions/index.ts` | scheduler owner | `consumeExecution` 调用 execute-or-resume consumer 与错误码处理 |

两个独立任务、互不重叠的写入范围：

- **Task A（持久 consumer owner）**：`packages/contracts/src/tool-execution.ts`、
  `packages/runtime/src/ui-runtime/task-verification.ts`、`packages/app/src/ui-runtime/*`、
  `packages/runtime/src/ui-runtime/coordinator.ts`。
- **Task B（scheduler recovery/call contract）**：`packages/core/src/subscription.ts`、
  `packages/runtime/src/subscriptions/index.ts`。
- Typed handoff（A→B，不重叠）：`ServeTaskConsumerPort` 接口签名 + `OccurrenceTaskBinding`
  + `ServeTaskTerminalReceipt`。B 只按契约调用，不改 A 的文件；A 不改 scheduler 文件。

真实 consumer 不实现前，`due -> execute -> settle` 不能验收；fake counter 不能作为 GREEN。

## 9. 公开候选测试与 consumer harness

真实入口：真实 `ServeTaskConsumerPort`（由 Task A 提供）+ 公开
`SubscriptionControlPort.claim/consumeExecution/settleOccurrence` + 真实
`JsonlOrganJournal`/`FileCheckpointStore` + 真实业务/Provider seam
（`packages/app/src/serve-runtime.ts`、`packages/app/src/serve-orchestration.ts`、
`packages/app/src/tool-execution-gateway.ts`）。

必须断言的场景：

1. 同一 occurrence/task/operation/executionEpoch/inputArtifactDigest 只启动一次业务执行。
2. execute 返回后、settle 前**同一 port** 重复调用，不第二次 dispatch。
3. execute 返回后、settle 前**重启 port**（新进程/新 port/新端口），不第二次 dispatch。
4. **并发调用**返回/等待同一 terminal receipt。
5. settle 前返回的 terminal 与 settle 后重放 terminal 身份一致。
6. **admission 后崩溃**（模拟 admission 提交后进程中断）在重启后返回 blocked/recovery，
   不重新 dispatch，且用户可见结果与原始 error/receipt 身份一致。
7. `success`、`failed`、`rejected`、`missing`、`blocked`、`cancelled` 和 cleanup 终点均有可断言
   receipt；未释放资源进入 recovery inventory。
8. fixture root 必须放在本任务自有目录下，测试后只删除本轮创建的资源，核对物理 absence。

RED/control 限定：fake/diagnostic counter 只能用于隔离的确定性 RED/control 回归，不能替代
真实 consumer 证据。

真实业务证据要求：真实 RCC `4444` 同入口 + 真实 Provider/business seam 的成功与失败路径。
只有 fake counter、单测或编译通过不得宣称 consumer GREEN。

当前可执行命令（docs-only，本轮直接运行）：

```sh
dagpipe graph validate docs/dagpipe/serve-task.graph.json
node scripts/dagpipe-validate-graphs.mjs
git diff --check
```

future harness / public 边界命令（source 实现后）：

```sh
pnpm exec tsc -p tests/app/tsconfig.json
node --test dist/tests/tests/app/file-checkpoint-store.test.js
node --test dist/tests/tests/app/ui-runtime.test.js
# 新增 public consumer harness（真实 JsonlOrganJournal + 真实 Provider seam）
pnpm exec tsc -p tests/runtime/tsconfig.json
node --test dist/tests-runtime/tests/runtime/checkpoints/public-consumer-recovery.test.js
```

## 10. Graph 变更

本轮只改现有 `humanagent-serve-task` 的 docs/dagpipe 文件：

- 新增 `durable_consume` 节点，位于 `correlate_task` 与 `provider_execution` 之间，语义为
  "按绑定持久准入并执行或恢复"。
- `provider_execution` 输入改由 `durable_consume` 输出 `durable_execution_binding` 提供。
- meta 补 `durableConsumerCapability = BLOCKED`、`durableConsumerOwner`、
  `recoveryContract`、`stableBindingIdentity`、`replayRule`、`capabilityResolution` 与
  `designBaseline`。

图仍为 SESE：单 source（`fifo_peek`）、单 sink（`task_terminal`）、每节点单入单出。
新节点 binding 指向现有 `packages/app/src/ui-runtime/service.ts`，
`implementationStatus = pending`，不声称实现完成。已有 5 条实现边保持准确（不新增/删除）。

## 11. 本轮验证记录

本轮只允许 docs/graph 变化。执行并记录：

```sh
dagpipe graph validate docs/dagpipe/serve-task.graph.json
node scripts/dagpipe-validate-graphs.mjs
git diff --check
git status --short
git diff --name-only HEAD
git diff --stat
```

验证要求：

- 仅允许 `docs/ui/durable-occurrence-consumer-design-2026-10-04.md` 与
  `docs/dagpipe/serve-task.graph.json` / `.graph.semantic.json` / `.graph.binding.json` 变化。
- `packages/`、`tests/`、`scripts/`、package/lock/config/version 相对 base `0020ab4f` 不变。
- 保留 immutable predecessor 证据：原 compiled case 292 `UNCONFIRMED` 与空 pre-existing
  directory overreach 判定不覆盖、不回收。
- 这些是设计 gate，不是已执行的 runtime/product 验收。

## 12. 未完成与 blocker

- **BLOCKED**：真实 durable `ServeTaskConsumerPort` 不存在。最小解除方式是按第 8 节顺序派发
  Task A（持久 consumer owner）与 Task B（scheduler recovery/call contract），并先完成
  W3 验证字节组合与必要的 core 契约扩展。
- 非成功 settle 终点当前被 `assertVerifiedTerminalReceipt`（仅 `success`）阻断，需在
  Task B 扩展，且不得放宽为接受伪造成功。
- 本设计不是 source review，也不替代 parent 独立 pre-code design review。
- F01-F10、formal API/UI、三条 business browser E2E、installed `10086` LAN+Tailscale、
  main remote、goal cleanup 仍为 ACTIVE/INCOMPLETE。
- Source scheduler R5 达到五轮上限；本设计不解除该 cap，也不启动 source R6。
