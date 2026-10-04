# 持久 occurrence consumer 前置设计（ServeTaskConsumerPort）

状态：**PRE-CODE DESIGN CANDIDATE / BLOCKED capability**。本文是 docs-only 设计产物，
不是 source PASS、不是独立 review、也不是已实现能力。R2 修正关闭两个 R1 P1：
durable verification/receipt 的权威读写与恢复责任，以及跨进程 live-owner / interrupted-owner
判定。真实 `ServeTaskConsumerPort` 仍不存在；本文只给出最小可实现 owner、typed 记录、
崩溃窗口、公开验证和解除路径。

## 1. 目标与范围

关闭 `interaction-verification-producer`（W3 保留树）到 scheduler 之间的上游能力缺口：

- 选定**唯一 durable execution owner**，用现有权威 Journal/checkpoint 原语实现真实
  `ServeTaskConsumerPort`，不新增第二 execution registry 或第二 terminal truth。
- 规定**dispatch 之前的原子持久准入**、terminal checkpoint 与 typed verification/receipt
  的成对持久化，以及 execute-returned / settle-pending 重启后的 replay 规则。
- 用现有 claim/lease 真源区分跨进程 live owner 与 confirmed interrupted owner；不能仅凭
  terminal 缺失或 lease timeout 写 recovery。
- 逐条说明崩溃窗口与 forward recovery 结果；Provider 自动 resume 当前不支持，本文不把它
  承诺成已存在能力。
- 给出最小 future source allowlist、依赖顺序、三个互不重叠 owner 的 typed handoff，
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
- 现有 `OccurrenceClaim` 已有 `claimedBy`、`leaseId`、`schedulerInstanceId`、`generation`、
  `executionEpoch`、`acquiredAt`、`expiresAt`，并且 claim 通过同一 Journal 持久化；但当前
  类型与检查没有 process-start token、owner-death proof 或 recovery fence，读取时也只校验
  lease。因此现有 claim/lease 不能单独证明“owner 已中断”，也不能授权另一进程写恢复终态。
- 现有 `consumeExecution` 只在 `settlement` 已存在时重放 terminal，否则直接调用
  `ServeTaskConsumerPort.executeOccurrence`。接口没有声明 durable idempotent/recovery
  guarantee。诊断 counter `dispatchCount=3` 只是 RED 派发证据。
- `UiRuntimeJournal` / `RuntimeTaskCoordinator.replayJournal()` 只恢复 projection/correlation
  事实；随后把任务置为 `unknown` / `需要恢复确认`，由 `hydrate()` 从权威 checkpoint journal
  重新确认生命周期。它是 correlation evidence，不是 durable dispatch/lifecycle truth。
- `FileOperationJournal` 只追加 `OperationEvent`；`ToolExecutionGateway` 的 operation state、
  idempotency 与 execution single-flight 都在内存 `Map` 中，当前不重放该文件。
- `FileCheckpointStore` 包装权威 `JsonlOrganJournal`；`hydrate()` 可恢复已提交的 terminal
  checkpoint。`FileCheckpointStore.commit()` 只写 `kind: 'checkpoint'`，checkpoint
  contract 没有 `TaskVerificationResult`，所以 checkpoint 本身不能证明 verification 成功，
  也不能恢复 execute 已返回、settle 尚未提交的 verified receipt。
- W3 `packages/runtime/src/ui-runtime/task-verification.ts` 产出 `TaskVerificationResult`，
  只在内存 `Map` 中 single-flight 每个 check；它不产出 `ServeTaskTerminalReceipt`，也不是
  durable execution owner。该文件当前 candidate 缺失。
- `ProviderAgentDriver.resume` 与 RCC v3 transport resume 显式返回 `resume.unsupported`；
  不能当作 durable execution recovery。
- 文本检索未发现真实 `ServeTaskConsumerPort` 实现。当前没有可演示的 durable consumer
  重放保证；真实实现前该能力标为 `BLOCKED`。

结论：**当前不存在可演示的 durable `ServeTaskConsumerPort`，且跨进程 owner-death /
recovery-fence primitive 当前缺失**。contract promise、内存标志、lease 耗尽或诊断 counter
都不能替代真实 consumer 与真实 owner 证据。

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
  recoveryResponsibility: RecoveryResponsibilityRecord   // 初始 possible，保证 crash 前责任可重建
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

### 4.2 Durable verification / receipt fact

checkpoint 决定 lifecycle outcome；它不包含 `TaskVerificationResult`，且 `FileCheckpointStore.commit()` 只提交 `Checkpoint`。因此 durable consumer 必须额外提交一个**typed receipt fact**，使 restart 能从权威 Journal 读取完整 `ServeTaskTerminalReceipt`，而不能在内存里重算。

```text
OccurrenceTerminalReceiptRecord {
  kind: 'occurrence-terminal-receipt'
  version: 1
  binding: OccurrenceTaskBinding                 // 必须等于 admission
  terminalCheckpointRef: string                  // 必须等于已提交 terminal checkpoint 身份
  terminalOutcome: Checkpoint['outcome']
  verification: TaskVerificationResult
  recoveryResponsibility?: RecoveryResponsibilityRecord
  settlementReceiptRef: string                   // 确定性 scheduler settlement 身份
}

RecoveryResponsibilityRecord {
  providerEffectState: 'confirmed-released' | 'possible' | 'confirmed-present'
  resourceInventory: readonly EvidenceRef[]      // provider/tool/browser/port 等真实证据
  releaseProofs: readonly EvidenceRef[]
}
```

执行顺序：

1. execute 返回 executionEvidence；W3 bridge 产出 `TaskVerificationResult`；consumer 构造 canonical receipt。
2. `checkpointCommitId(checkpoint)` 与 `occurrenceReceiptCommitId(binding)` 均确定性。receipt 查找键只允许使用固定常量 `occurrence-terminal-receipt/v1` 与下列不可变 `OccurrenceTaskBinding` 字段：
   `occurrenceId, subscriptionId, scheduleRevision, occurrenceOrdinal, taskId, operationId, executionEpoch, inputArtifactDigest`。所有参与字段必须使用同一 canonical JSON（UTF-8、对象键字典序、无空白、数值/字符串保留 typed 值）后作为固定 record kind/domain 下的同一确定性哈希输入。
3. `terminalCheckpointRef`、`terminalOutcome`、`verification`、`recoveryResponsibility`、`releaseProofs`、资源 inventory 与 canonical receipt 的其余内容必须只进入 receipt record 的 `commitFactDigest`；它们不得影响查找键。写 receipt、重放 receipt、restart lookup 必须调用同一 derivation。新进程先依据 binding 与已验证的 terminal checkpoint 计算 commitId，再读取 receipt。读出后必须验证完整 binding、已提交的 terminal checkpoint reference 和完整 receipt/evidence。
4. `FileCheckpointStore.commit(checkpoint)` 先提交 terminal checkpoint；`Checkpoint` 是 lifecycle truth。
5. 再 append receipt event：同 commitId、同 digest -> 返回既有记录；同 commitId、不同 digest -> 抛 `JournalCommitConflictError`，保留原始权威 receipt。不存在第二键、第二 store 或 fallback consumer。
6. 只有 checkpoint record 与 receipt record **都在已验证 Journal 中**，consumer 才返回 `ServeTaskTerminalReceipt`。不得把 checkpoint outcome 解读为 verification success，也不得在 checkpoint-only 窗口伪造 receipt。

实际 read path：按 scope 重放 Journal；读取 terminal checkpoint，用仅由 binding 派生的同一 commitId 查找 receipt event。存在 checkpoint 但缺 receipt，结果是 `durable-unverified-recovery-pending`；verification returned before settlement 的重启证明已持久 receipt，而不是重新执行或验证业务工作。

admission 先写入初始 `recoveryResponsibility`，所以即使 crash 发生在 dispatch 之前或 verification 之前，恢复责任的权威来源仍然存在。receipt 提交时以实际 `releaseProofs` 更新它。terminal checkpoint 保留 lifecycle evidence，但不提供第二 terminal。scheduler 仍只在 settlement 中保存已返回的 receipt。

### 4.3 Replay 规则（execute-returned / settle-pending 重启）

consumer 从权威 journal 派生五态，再决定动作：

| 持久状态 | 判定 | 动作 |
| --- | --- | --- |
| settlement 已存在 | 已完成 | 返回同一 `ServeTaskTerminalReceipt`，不 dispatch |
| terminal checkpoint + receipt 均已提交 | 已完成执行 | 从 Journal 读取同一 receipt 返回；由 scheduler settle |
| terminal checkpoint 存在，receipt 缺失 | terminal durable 但 verification 未收口 | `durable-unverified-recovery-pending`；不 dispatch、不伪造 receipt |
| admission 存在，terminal 缺失 | live / interrupted / unrecoverable 未定 | 按第 6 节 claim/fence 判定；不得仅凭 terminal 缺失 recovery |
| 无 admission | 可准入 | 原子 admission 后唯一 dispatch |

## 5. 崩溃窗口与 forward recovery

每个窗口的 durable 状态、可证明性与结果：

| 崩溃窗口 | 重启时持久状态 | Forward recovery |
| --- | --- | --- |
| admission 提交前 | 无记录 | 安全：admission + 唯一 dispatch |
| admission 提交后、dispatch 调用前 | admission，无 terminal | 不能证明 Provider 未启动 → 判不确定，blocked/recovery，不自动重派 |
| dispatch 进行中（Provider 已启动） | admission，无 terminal | 外部副作用不确定 → blocked/recovery，不自动重派 |
| execute 返回后、terminal checkpoint 提交前 | admission，无 terminal | 同上 → blocked/recovery，不自动重派 |
| settlement 已提交 | settlement 记录 | 完成重放，返回已提交 terminal |
| terminal checkpoint 已提交、receipt 未提交 | admission + terminal checkpoint | `durable-unverified-recovery-pending`；不重新 verify/dispatch，不调用 scheduler settle |
| receipt 已提交、scheduler settle 前 | admission + terminal checkpoint + receipt | 从 receipt commitId 读取同一 receipt；scheduler settle 幂等 |

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

## 6. 跨进程 live-owner 与 interrupted-owner

唯一 claim/lease authority 仍是 scheduler candidate 的持久 `OccurrenceClaimRecord`，经现有
`claim()` / `claimRecord()` 读写。consumer 不新建 execution registry、不解析日志，也不用
lease timeout 推断 owner 死亡。

判定必须同时满足：

- **live / current**：当前 claim 的 occurrence、generation、executionEpoch、leaseId、
  schedulerInstanceId 与 caller claim 完全相等，且 `assertOccurrenceClaimLease()` 通过。
  该 caller 可以等待当前 promise 或返回 typed `in-progress`；不得写 recovery checkpoint、
  不得写 terminal、不得再次 dispatch。
- **unchanged but unowned / uncertain**：当前 claim 仍为同 identity 且 lease 未过期，但当前
  caller 无法证明自己是 owner。现有 claim 没有跨进程 process-start / liveness proof，因此
  只能返回 `owner-live-unproven` 或 `in-progress`，不能 recovery。
- **confirmed interrupted / fenced**：必须由一个最小 typed control extension 提供
  owner-death proof 与 monotonic recovery fence。候选字段为 `processStartToken` 与
  `recoveryFence`，owner 与 claim/fence 校验仍归 scheduler/core contract。只有 confirmed
  dead 或 confirmed fenced 后，新的 recovery generation 才取得写恢复终态的 authority。
- **stale / new port / concurrent caller**：generation、executionEpoch、leaseId 或 instance 不匹配时拒绝 mutation；不接管、不恢复、不 dispatch。

因此，缺少 terminal 只能说明执行未收口。它不能说明 A 已中断，也不能授权 B 写 terminal。现有 claim/lease 只证明 claim identity 与未过期 lease；进程死亡与 recovery fence 是 **BLOCKED primitive**，必须按第 9 节最小扩展后实现，不能用新 lease、timeout、PID probe、log parse 或本地 in-flight map 替代。

## 7. 稳定终态身份与验证权威

- terminal 身份必须匹配 `OccurrenceTaskBinding`：`taskId`、`operationId`、`executionEpoch`、
  `inputArtifactDigest` 全部相等；receipt 与 `receipt.verification` 同样校验上述身份。
- 一个 `OccurrenceTaskBinding` 只对应一次业务执行。admission commitId 只授权一次 dispatch；
  winner / replay 由 claim claim-identity check + Journal `commitFactDigest` 区分。
- `ServeTaskTerminalReceipt.verification.status` 覆盖
  `success | failed | rejected | missing | blocked | cancelled`。
  Core `assertVerifiedTerminalReceipt` 当前只接受 `success`；非成功终点需要**扩展 settle
  终点判定**（按 outcome 分别处理），但不得扩大为接受伪造成功。
- verification 不成为独立 lifecycle truth；checkpoint 是 lifecycle truth，receipt fact 只提供
  durable verification/evidence，scheduler settlement 保存 forward result。

## 8. 终点区分

| 终点 | 判据 | 结果 |
| --- | --- | --- |
| completed replay | settlement 存在 | 返回已提交 terminal，不 dispatch |
| live concurrent wait | 当前 live claim 未过期 | 等待同一 promise 或 typed `in-progress`，不第二次 dispatch、不写 recovery |
| current owner unproven | 当前 claim 存在且未过期，但 caller 无 owner identity | typed `owner-live-unproven` / `in-progress`；现有 primitive 下不得 recovery |
| interrupted / fenced | confirmed dead 或 confirmed fence + 新 recovery authority | 才允许 blocked/recovery terminal；不重派，不伪造 success |
| verification failure | 验证 status ≠ success | 非成功 terminal，保留原始 evidence |
| reject / missing / blocked / cancelled | 验证对应 status | 对应 typed 非成功 outcome；blocked 不伪装成功；cancelled 只在 stop settle 后收口 |
| durable receipt pending | checkpoint 存在、receipt 缺失 | `durable-unverified-recovery-pending`；不宣称 verified terminal |
| persistence failure | journal append/commit 抛错 | fail closed：admission 失败则不 dispatch；terminal/receipt 未成对提交则不宣称成功 |
| actual side-effect release | 执行/tool/browser/port 资源已释放 | 释放证据入 receipt；未释放必须显式 recovery inventory |
| cleanup | consumer 释放自有资源，scheduler 保留 receipt | 未 release 显式进入 recovery inventory，不静默丢弃 |

## 9. 最小 future source allowlist 与依赖顺序

前置：当前 candidate 不含 W3 `packages/runtime/src/ui-runtime/task-verification.ts`，也没有真实
`ServeTaskConsumerPort`。若必须复用 W3 已验收字节，parent 必须先完成最小组合；不得用 stub
跳过。core 契约变更必须先于依赖它的实现。

依赖顺序：

```text
W3 actual verification bytes composition
  -> minimal claim process-start / recovery-fence contract
  -> durable consumer owner (ServeTaskConsumerPort adapter + admission/receipt/replay)
  -> scheduler recovery/call contract (consumeExecution 调用 + 非成功 settle 终点)
  -> public E2E
```

允许路径（parent 独立 review 通过后再派发）：

| 顺序 | 文件 | Owner | 内容 |
| --- | --- | --- | --- |
| 0 | `packages/contracts/src/tool-execution.ts` | 契约 owner（先于实现） | 新增 admission、`OccurrenceTerminalReceiptRecord`、`RecoveryResponsibilityRecord`、receipt validator |
| 0a | `packages/contracts/src/framework.ts` | scheduler contract owner | 最小扩展 `OccurrenceClaim` 的 process-start token 与 recovery-fence identity；不得改称第二 lease |
| 1 | W3 `packages/runtime/src/ui-runtime/task-verification.ts` | W3 bytes 组合 owner | 组合实际 W3 验证 bridge；不得以 stub 代替 |
| 2 | `packages/app/src/ui-runtime/service.ts`（及同 owner sibling module） | 持久 consumer owner | 实现真实 `ServeTaskConsumerPort`：admission、live-owner guard、execute、terminal/receipt 提交 |
| 3 | `packages/app/src/ui-runtime/journal.ts` | 持久 consumer owner | 补最小 admission/receipt event 读写；不新增 generic registry |
| 4 | `packages/runtime/src/ui-runtime/coordinator.ts` | 持久 consumer owner | 仅当需要暴露 execute/settle seam 时最小改动 |
| 5 | `packages/core/src/subscription.ts` | scheduler/core owner | 非成功 settle 终点判定扩展；保持 core 唯一 owner |
| 6 | `packages/runtime/src/subscriptions/index.ts` | scheduler owner | `consumeExecution` 调用 execute-or-resume consumer 与错误码处理 |

三个独立任务、互不重叠的写入范围：

- **Task A（durable consumer owner）**：`packages/contracts/src/tool-execution.ts`、
  `packages/runtime/src/ui-runtime/task-verification.ts`、`packages/app/src/ui-runtime/*`、
  `packages/runtime/src/ui-runtime/coordinator.ts`。
- **Task B（scheduler owner authority）**：`packages/contracts/src/framework.ts`、
  `packages/core/src/subscription.ts`、`packages/runtime/src/subscriptions/index.ts`。
- Typed handoff（A→B，不重叠）：`ServeTaskConsumerPort` 接口签名 + `OccurrenceTaskBinding`
  + `ServeTaskTerminalReceipt` + claim/fence identity。B 只按契约调用，不改 A 的文件；A 不改 scheduler 文件。

真实 consumer 不实现前，`due -> execute -> settle` 不能验收；fake counter 不能作为 GREEN。

## 10. 公开候选测试与 consumer harness

真实入口：真实 `ServeTaskConsumerPort`（由 Task A 提供）+ 公开
`SubscriptionControlPort.claim/consumeExecution/settleOccurrence` + 真实
`JsonlOrganJournal`/`FileCheckpointStore` + 真实业务/Provider seam
（`packages/app/src/serve-runtime.ts`、`packages/app/src/serve-orchestration.ts`、
`packages/app/src/tool-execution-gateway.ts`）。

必须断言的场景：

1. 同一 occurrence/task/operation/executionEpoch/inputArtifactDigest 只启动一次业务执行。
2. execute 返回后、settle 前**同一 port** 重复调用，不第二次 dispatch。
3. execute 返回后、settle 前**重启 port**（新进程/新 port/新端口），读取同一持久 receipt，不第二次 dispatch。
4. **两个真实 consumer process**：A 有 live current claim 且仍在执行时，B 只能等待或返回 typed `in-progress`；不得 dispatch、不得写 recovery/terminal。A terminal 后 B 得到 byte/equality 相同的 receipt。
5. stale claim、new port、unchanged live owner、concurrent caller 均不得写 terminal；只有 confirmed owner failure + recovery fence 才能写恢复终态，且无 phantom stop/success。
6. **admission 后崩溃**（模拟 admission 提交后进程中断）在重启后返回 blocked/recovery，
   不重新 dispatch，且用户可见结果与原始 error/receipt 身份一致。
7. **verification returned before settle restart**：A 在 `settleOccurrence` 前退出；重启后 consumer 仅凭 binding 与 checkpoint 定位同一 durable receipt，不构造 verification、不 dispatch、不重新验证业务工作。scheduler 首次 settle，第二次 replay 相同 terminal/settlement。
8. Journal write failure：terminal 成功、receipt append 失败必须暴露 `durable-unverified-recovery-pending`，不得返回 verified terminal。
9. `success`、`failed`、`rejected`、`missing`、`blocked`、`cancelled` 和 cleanup 终点均有可断言
   receipt；未释放 provider/tool/browser/port 资源进入 recovery inventory，且有实际 release/closure inventory。
10. fixture root 必须放在本任务自有目录下，测试后只删除本轮创建的资源，核对物理 absence。
11. **receipt key uniqueness**：两个只相差 `verification` 或 `releaseProofs` 的 receipt，若 `OccurrenceTaskBinding` 完全相同，必须生成同一 commitId，并以 `JournalCommitConflictError` 拒绝第二个 receipt；不得创建第二条 receipt。相同 receipt 的 replay 必须返回第一条记录。
12. **restarted public consumer lookup**：从真实公开 consumer 入口重启新进程时，只给出 binding 与 authoritative terminal checkpoint 即可定位第一条 durable receipt。断言没有构造 verification、没有 dispatch、没有重新验证业务工作。该条与第 11 条是 future source acceptance gate，不是本轮已执行测试。

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
# 新增 public consumer harness（真实 JsonlOrganJournal + 真实 Provider seam + 两进程 claim/fence）
pnpm exec tsc -p tests/runtime/tsconfig.json
node --test dist/tests-runtime/tests/runtime/checkpoints/public-consumer-recovery.test.js
```

## 11. Graph 变更

本轮只改现有 `humanagent-serve-task` 的 docs/dagpipe 文件：

- 新增 `durable_consume` 节点，位于 `correlate_task` 与 `provider_execution` 之间，语义为
  "持久准入、判定 owner 并执行或恢复"。
- 新增 `receipt_commit` 节点，位于 `provider_execution` 与 `task_terminal` 之间，语义为
  "提交可重放的持久验证 receipt"。
- meta 补 `durableConsumerCapability = BLOCKED`、`durableConsumerOwner`、
  `recoveryContract`、`stableBindingIdentity`、`replayRule`、`capabilityResolution` 与
  `designBaseline`。

图仍为 SESE：单 source（`fifo_peek`）、单 sink（`task_terminal`）、每节点单入单出。
新节点 binding 指向现有 `packages/app/src/ui-runtime/service.ts`，
`implementationStatus = pending`，不声称实现完成。已有 checkpoint 边保持准确（不新增/删除）。

## 12. 本轮验证记录

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

## 13. 未完成与 blocker

- **BLOCKED**：真实 durable `ServeTaskConsumerPort` 不存在。最小解除方式是按第 9 节顺序派发
  Task A（持久 consumer owner）与 Task B（scheduler recovery/call contract），并先完成
  W3 验证字节组合与必要的 core 契约扩展。
- **BLOCKED**：现有 claim/lease 没有跨进程 liveness 或 owner-death proof，也没有 recovery
  fence。最小解除方式是扩展现有 `OccurrenceClaim` / scheduler fence contract，并提供真实
  两进程证明；不得使用第二 lease、timeout、PID/log parse 或本地 map。
- 非成功 settle 终点当前被 `assertVerifiedTerminalReceipt`（仅 `success`）阻断，需在
  Task B 扩展，且不得放宽为接受伪造成功。
- 本设计不是 source review，也不替代 parent 独立 pre-code design review。
- F01-F10、formal API/UI、三条 business browser E2E、installed `10086` LAN+Tailscale、
  main remote、goal cleanup 仍为 ACTIVE/INCOMPLETE。
- Source scheduler R5 达到五轮上限；本设计不解除该 cap，也不启动 source R6。
