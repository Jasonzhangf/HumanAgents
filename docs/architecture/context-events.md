# Context Events：发生事件的统一领域抽象

状态：`DESIGN-CANDIDATE / CONTEXT-EVENTS-V1`
日期：2026-10-07
适用阶段：MVP → Milestone 1/2

本文定义 HumanAgent 内部“发生的事件”的统一领域抽象：UI 只告诉用户正在发生什么、发生了什么，Memory Agent 只梳理发生过什么、踩过什么坑、需要做什么总结。它是 UI narrative、Memory digest、Context Compaction 和 Checkpoint Recovery 的共同事实层，独立于 Provider、Journal 存储、UI 渲染和 Memory 存储。

本文是设计输入，不声称已实现。`packages/context-events` 是计划新增模块，当前仓库中不存在；本文先落类型、分类、优先级、配对、投影和模块边界，供独立校验和后续实现。

## 1. 设计动机

DSH Context 层提供了一个有价值的抽象（用户引用的 `src/session/extract.ts` 描述：约 40 种事件类型，结构含 `type / category / data / priority / bytes_avoided / bytes_retrieved / token 用量`），其中三个设计要点值得借鉴：

1. **错误是成对记的**：`error_tool` + `error_resolved` 分开存，恢复时模型直接看到“之前踩过什么坑、怎么修好的”，不用重新试错。
2. **计划有完整生命周期**：`plan_enter → plan_approved / plan_rejected → plan_exit`，连“被拒的方案”都记下来，避免恢复后模型又提同一个被否掉的方案。
3. **连“重试循环”都单独成事件**：`retry_detected` 说明它在检测模型是不是在原地打转——这通常是 context 烧掉的前兆。

> 注：当前 DSH checkout（`/Volumes/extension/code/dsh`，HEAD `639ed01539`）中未找到 `src/session/extract.ts` 原文；该路径存在 `packages/session/`、`packages/compaction/`，playground 有 `session-query/src/extraction.ts`。上述 40 类事件与三个要点是**设计输入假设**，不是已核实的源码事实。实现时若要以 DSH 为参考，必须先核对对应版本源码并记录 SHA。

HumanAgent 当前没有这个抽象：`AgentEvent` 的 `kind` 是自由字符串，`EventEnvelope` 只有通用 `kind/class/summary/payload`，缺少领域分类、优先级、成本、状态和生命周期配对。本文补齐这一层，作为 UI、Memory、Compaction、Recovery 的公共契约。

## 2. 当前实现基线与缺口

### 2.1 已有机制（复用，不重复造）

| 机制 | 位置 | 职责 |
|---|---|---|
| Absolute Journal / Context Contract | [`context-contract.md`](context-contract.md) | Journal 是真源，Context View 是视图，Projection 做 `audit / effective-path / compact-effective` |
| Agent Loop primitive | `packages/runtime/src/agent-loop/runtime.ts` | `ObservationBatch`、`ObservationDelta`、`ContextView`、`ContextReplacement`、checkpoint 水位 |
| Agent Semantic Event | `packages/contracts/src/index.ts` `AgentSemanticEvent` | provider-neutral 生命周期事件，`execution.started / provider.model / provider.tool / provider.error / checkpoint.committed / execution.terminal` 等 |
| Runtime Event Envelope | `packages/runtime/src/events/types.ts` `EventEnvelope` | 传输/消费层：`messageId / streamId / kind / class / summary / payload / evidenceRefs` |

### 2.2 缺口（本文补齐）

1. **缺 typed event taxonomy**：`kind: string`，没有 `file_read`、`error_tool`、`error_resolved`、`plan_enter`、`retry_detected` 的领域分类。
2. **缺优先级与压缩预算**：DSH 的 `priority: 1..5`、`bytes_avoided`、`bytes_retrieved`、token 用量，对 compact / memory agent 很关键；现在只有 `ObservationBatchPriority = 'normal' | 'deferred'`，粒度太粗。
3. **缺“事件配对”模型**：错误 → 修复、计划进入 → 批准/拒绝、blocker → resolved、retry loop → recovered 都需要一等关系；现在只能用 `summary`、`evidenceRefs` 或 UI correlation 推断，恢复时不稳定。
4. **缺 UI/Memory 共用的事实层**：UI 现在从 `ObservationNodeSource`、`AgentFeedbackSource`、`ExecutionStepSource` 等投影拼出来；Memory agent 也读历史和 evidence。但它们没有共享的“发生过什么、踩过什么坑、下一步注意什么”的 canonical 事件流。
5. **缺独立 owner**：上下文契约写在文档里，agent-loop 在 runtime 里，projection 在 UI 里，events 在 runtime events 里。没有一个明确的模块负责事件类型、优先级、配对、compact projection、UI narrative projection、memory summary projection。

## 3. 模块边界：`packages/context-events`

`packages/context-events` 是独立模块，职责三件事：

1. 定义事件 schema（taxonomy / category / priority / status / pairing）。
2. 把原始事件（`EventRecord`、`AgentEvent`、`AgentSemanticEvent`、`ProviderEvent`）normalize 成 canonical observation event。
3. 根据用途生成投影：
   - UI narrative：正在发生什么、发生了什么、下一步是什么。
   - Memory digest：发生过什么、踩过什么坑、需要避免什么。
   - Compact snapshot：按 priority / token budget 保留最关键事实。
   - Audit / effective path：保留可追溯但不压缩的恢复路径。

它**不做**：

- 不写 Journal；
- 不提交 checkpoint；
- 不决定 task 完成；
- 不渲染 UI；
- 不调用 provider；
- 不读取 DSH session log 当事实。

Journal 是事实真源；`context-events` 只消费已经由 Journal / EventBus 提交的事实，输出投影。

## 4. 核心类型

### 4.1 Category

```ts
type ContextEventCategory =
  | 'file' | 'plan' | 'git' | 'error' | 'decision' | 'blocker'
  | 'env' | 'rule' | 'intent' | 'goal' | 'tool' | 'agent' | 'task';
```

### 4.2 Priority

```ts
type ContextEventPriority = 1 | 2 | 3 | 4 | 5;
// 1 = 关键（必须保留），5 = 低（压缩时先丢）
```

### 4.3 Status

```ts
type ContextEventStatus =
  | 'active'    // 正在发生
  | 'completed' // 已完成
  | 'failed'    // 已失败
  | 'resolved'  // 已修复 / 已恢复
  | 'superseded' // 被新事件取代
  | 'rejected'; // 被拒绝（如 plan 被否）
```

### 4.4 Cost

```ts
interface ContextEventCost {
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly bytesAvoided?: number;   // compact 时避免读取的字节
  readonly bytesRetrieved?: number; // 检索返回的字节
}
```

### 4.5 Pairing

```ts
interface ContextEventPairing {
  readonly pairId: string;
  readonly role: 'opened' | 'resolved' | 'rejected' | 'superseded';
  readonly relatedEventId?: string;
}
```

配对是一等模型，至少支持：

- `error.detected → error.resolved`
- `blocker.detected → blocker.resolved`
- `plan.proposed → plan.accepted | plan.rejected`
- `retry.detected → retry.recovered | retry.exhausted`
- `operation.failed → checkpoint.committed | checkpoint.reentered`

### 4.6 Canonical Context Event

```ts
interface CanonicalContextEvent {
  readonly eventId: string;
  readonly type: ContextEventType;
  readonly category: ContextEventCategory;
  readonly scope: ScopeRef;
  readonly occurredAt: string;
  readonly priority: ContextEventPriority;
  readonly status: ContextEventStatus;
  readonly summary: string;
  readonly narrative:
    | 'progress' | 'decision' | 'failure' | 'recovery'
    | 'checkpoint' | 'attention';
  readonly payloadRef: string;      // 完整载荷引用（artifact / filesystem adapter）
  readonly dataDigest: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly cost?: ContextEventCost;
  readonly pairing?: ContextEventPairing;
  readonly supersededByEventId?: string;
}
```

`data` 不内嵌完整载荷。完整载荷放 `payloadRef + dataDigest + evidenceRefs`，由 artifact / filesystem adapter 保存。这与 HumanAgent「控制面与业务 payload 物理隔离」的约束一致。

### 4.7 事件类型（第一批，不全量抄 DSH 40 类）

先做 HumanAgent 当前真正需要的 16 个，文件 / git / env / rule / agent / tool 通过 category 和 provider mapper 扩展：

```ts
type ContextEventType =
  | 'task.created'
  | 'task.confirmed'
  | 'operation.started'
  | 'operation.completed'
  | 'operation.failed'
  | 'error.detected'
  | 'error.resolved'
  | 'blocker.detected'
  | 'blocker.resolved'
  | 'checkpoint.committed'
  | 'checkpoint.reentered'
  | 'context.compacted'
  | 'plan.proposed'
  | 'plan.accepted'
  | 'plan.rejected'
  | 'retry.detected';
```

后续扩展（由 provider mapper 归一化）：

- `file_read`、`file_write`、`file_edit`、`file_search`、`file_glob`、`file_read_metadata`
- `git`、`git_commit`
- `env`、`cwd`、`worktree`、`worktree_exit`
- `rule`、`rule_content`
- `intent`、`goal`、`data`、`constraint_discovered`
- `bash_outcome`、`mcp_tool_call`、`mcp`、`webfetch_metadata`、`external_ref`
- `skill`、`subagent`、`agent_finding`、`role`、`agent_usage`
- `retry_detected`、`session_settings_snapshot`、`task`

这些作为 category / type 扩展点，不进入第一批硬编码。

## 5. 投影

### 5.1 UI Narrative Projection

用户只看到“正在发生什么、发生了什么”，不看到工具流水账：

```ts
interface UserNarrativeEvent {
  readonly occurredAt: string;
  readonly state: 'happening' | 'happened' | 'failed' | 'resolved' | 'needs-user';
  readonly title: string;
  readonly detail?: string;
  readonly nextAction?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}
```

### 5.2 Memory Context Digest

Memory Agent 只消费 digest，不消费原始 chat log：

```ts
interface MemoryContextDigest {
  readonly summary: string;
  readonly decisions: readonly DecisionDigest[];
  readonly failures: readonly FailureRepairDigest[];
  readonly rejectedPlans: readonly RejectedPlanDigest[];
  readonly blockers: readonly BlockerDigest[];
  readonly constraints: readonly ConstraintDigest[];
  readonly omitted: readonly OmittedReason[];
}
```

### 5.3 Compact Snapshot

按 priority 和 token budget 保留最关键事实，合成 ≤2KB 快照：

```ts
interface CompactSnapshot {
  readonly snapshotId: string;
  readonly sourceWatermark: number;
  readonly retained: readonly CanonicalContextEvent[];
  readonly omitted: readonly OmittedReason[];
  readonly budgetBytes: number;
  readonly usedBytes: number;
}
```

压缩时：priority 1 优先保留，5 先丢；error/plan/retry 的配对事件优先成对保留。

### 5.4 Audit / Effective Path

保留可追溯但不压缩的恢复路径；复用 `context-contract.md` 的 `audit / effective-path / compact-effective` 三种模式。

## 6. 生命周期配对

配对状态由 `pairing.ts` 维护，不靠 `summary` 或 UI correlation 推断：

| 打开 | 关闭 | 语义 |
|---|---|---|
| `error.detected` | `error.resolved` | 坑 + 修复 |
| `blocker.detected` | `blocker.resolved` | 阻塞 + 解除 |
| `plan.proposed` | `plan.accepted` / `plan.rejected` | 方案 + 采纳/否决 |
| `retry.detected` | `retry.recovered` / `retry.exhausted` | 打转 + 恢复/耗尽 |
| `operation.failed` | `checkpoint.committed` / `checkpoint.reentered` | 失败 + 收拢/重入 |

配对校验（负向用例）：

- 同一事件不能配到两个 `resolved`；
- `plan.rejected` 不能配 `plan.accepted`；
- `error.resolved` 的 `relatedEventId` 必须指向已存在的 `error.detected`；
- `superseded` 事件不能是 `active`。

## 7. 模块结构

```text
packages/context-events/
  src/
    types.ts        # canonical event / cost / pairing / projection types
    taxonomy.ts     # type/category/priority/narrative 表
    normalize.ts    # EventRecord / AgentEvent / AgentSemanticEvent / ProviderEvent 归一化
    pairing.ts      # error/blocker/plan/retry 配对状态
    projector.ts    # UI narrative / memory digest / effective path
    compact.ts      # priority + token budget 压缩
    validation.ts   # 负向校验：优先级非法、pair role 不匹配、重复 pairing、stale superseded
    index.ts
  tests/
```

## 8. 接入点

| 来源 | 归一化到 |
|---|---|
| `packages/runtime/src/events/types.ts` `EventRecord` | `CanonicalContextEvent` |
| `packages/contracts/src/index.ts` `AgentEvent` | `CanonicalContextEvent` |
| `packages/contracts/src/index.ts` `AgentSemanticEvent` | `CanonicalContextEvent` |
| `packages/adapters/provider` `ProviderEvent` | `CanonicalContextEvent` |

| 消费者 | 消费 |
|---|---|
| UI narrative（`packages/ui/projection`） | `UserNarrativeEvent` |
| Memory Agent（`packages/runtime/src/memory`） | `MemoryContextDigest` |
| Context Compaction（`context-contract.md`） | `CompactSnapshot` |
| Checkpoint Recovery | `AuditPath` / `EffectivePath` |

## 9. 唯一 Owner

| 模块 | 唯一责任 |
|---|---|
| `packages/context-events` | 事件 schema、taxonomy、归一化、配对、投影、压缩、校验 |
| Journal Adapter | 追加、顺序、链校验、资产引用完整性（事实真源，不属本模块） |
| UI | 消费 `UserNarrativeEvent`，渲染 |
| Memory | 消费 `MemoryContextDigest`，提炼候选、请求 review |
| Context Compaction | 消费 `CompactSnapshot`，替换 Context View |
| Checkpoint Recovery | 消费 `AuditPath` / `EffectivePath`，重建恢复入口 |

## 10. 独立校验条件

设计通过以下校验才算进入实现：

1. `pnpm dagpipe:validate` 通过（含新增 `humanagent-context-events` 图）。
2. 图产物三件套齐全：`.graph.json`、`.graph.binding.json`、`.graph.semantic.json`；binding 的 `ownerPath` 存在且落在 `packages/ docs/ scripts/ tests/`。
3. 设计 doc 的每个类型引用与 `context-contract.md`、`agent-loop.ts`、`events/types.ts` 一致。
4. 语义自检：把 16 个事件类型的类别、优先级、状态、配对逐一列出来，检查是否覆盖 UI narrative / memory digest / compact / recovery 四个消费者。
5. 负向校验用例在 `validation.ts` 中定义（pair role 不匹配、重复 pairing、stale superseded、priority 非法）。
6. 独立 reviewer PASS 后才进入实现。

## 11. 下一步

1. 本文合入 main 前先独立校验。
2. 实现 `packages/context-events` 的类型与校验（纯类型 + 负向测试）。
3. 接最小 mapper：`EventRecord` / `AgentEvent` / `AgentSemanticEvent`。
4. 接两个 consumer：UI narrative projection、MemoryContextDigest。
5. 再接 compact snapshot。
