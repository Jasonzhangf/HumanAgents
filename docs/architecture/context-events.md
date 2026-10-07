# Context Events：发生事件的统一领域抽象

状态：`IMPLEMENTATION-BASELINE / CONTEXT-EVENTS-V2`（详细设计已冻结并由 `packages/context-events` 落地）
日期：2026-10-07
适用阶段：MVP → Milestone 1/2
基线：`11dc1e30a40c232d959ccc121d00a56735faa061`（本实现所组合的 `origin/main`）
实现：`packages/context-events/src/`（10 个文件，见 §5）；测试 `tests/context-events/context-events.test.ts`；gate 见 §14

本文定义 HumanAgent 内部“发生的事件”的统一领域抽象：UI 只告诉用户正在发生什么、发生了什么，Memory Agent 只梳理发生过什么、踩过什么坑、需要做什么总结。它是 UI narrative、Memory digest 和 Context Compaction 的共同事实层，独立于 Provider、Journal 存储、UI 渲染和 Memory 存储。

本文是**实现契约**：第 6–12 节的类型、表格和校验规则是冻结接口，供多个 worker 并发实现。任何偏离都必须先改本文再改代码。

## 1. 设计输入与声明假设

DSH Context 层提供了一个有价值的抽象（约 40 种事件类型，结构含 `type / category / data / priority / bytes_avoided / bytes_retrieved / token 用量`），其中三个设计要点值得借鉴：

1. **错误是成对记的**：`error_tool` + `error_resolved` 分开存，恢复时模型直接看到“之前踩过什么坑、怎么修好的”，不用重新试错。
2. **计划有完整生命周期**：`plan_enter → plan_approved / plan_rejected → plan_exit`，连“被拒的方案”都记下来，避免恢复后模型又提同一个被否掉的方案。
3. **连“重试循环”都单独成事件**：`retry_detected` 说明它在检测模型是不是在原地打转——这通常是 context 烧掉的前兆。

> **声明假设**：当前 DSH checkout（`/Volumes/extension/code/dsh`，HEAD `639ed01539`）中未找到 `src/session/extract.ts`；该路径存在 `packages/session/`、`packages/compaction/`。上述 40 类事件与三个要点是**设计输入假设**，不是已核实的源码事实。实现不得声称已核对 DSH 源码；若后续要以 DSH 为参考，必须先核对对应版本并记录 SHA。

## 2. 现有实现基线（复用，不重复造）

| 机制 | 位置 | 职责 |
|---|---|---|
| Absolute Journal / Context Contract | [`context-contract.md`](context-contract.md) | Journal 是真源，Context View 是视图，Projection 做 `audit / effective-path / compact-effective` |
| Agent Loop primitive | `packages/runtime/src/agent-loop/runtime.ts` | `ObservationBatch`、`ObservationDelta`、`ContextView`、`ContextReplacement`、checkpoint 水位 |
| Agent Semantic Event | `packages/contracts/src/index.ts` `AgentSemanticEvent` | provider-neutral 生命周期事件 |
| Runtime Event Envelope | `packages/runtime/src/events/types.ts` `EventEnvelope` / `EventRecord` | 传输/消费层 |
| Provider Event | `packages/contracts/src/index.ts` `ProviderEvent` | 真实执行事件，含 `toolCall` / `toolResult` / `error` |

## 3. 缺口

1. **缺 typed event taxonomy**：`AgentEvent.kind` 与 `EventEnvelope.kind` 都是自由字符串，没有领域分类。
2. **缺优先级与压缩预算**：只有 `ObservationBatchPriority = 'normal' | 'deferred'`，粒度太粗，无法按 `priority 1..5` 压缩。
3. **缺事件配对模型**：错误 → 修复、计划 → 采纳/否决、blocker → 解除、重试 → 恢复 都只能靠 `summary` 或 UI correlation 推断。
4. **缺 UI/Memory 共用的事实层**：UI 从 `ObservationNodeSource` 等投影拼装，Memory 读历史与 evidence，两者没有共享的 canonical 事件流。
5. **缺独立 owner**：taxonomy 没有归属模块。

## 4. 模块边界

`packages/context-events` 只做四件事：

1. 定义事件 schema（taxonomy / category / priority / status / pairing）。
2. 把原始事件 normalize 成 canonical event。
3. 生成投影：UI narrative、Memory digest、Compact snapshot。
4. 校验自身产物（canonical event、pairing 一致性、compact snapshot、memory digest）。

**非目标（显式不做，含消融决定）**：

- 不写 Journal；不提交 checkpoint；不决定 task 完成；不渲染 UI；不调用 provider；不读 DSH session log 当事实。
- **不实现 `audit` / `effective-path`**：该能力由 `context-contract.md` §11 的 Journal Projector 独占 owner。本模块不复制第二套路径投影（消融要求：同一语义只能有一个 owner）。
- **不含 `constraints` digest 字段**：v1 的 18 个 canonical 类型没有任何一个产生该数据（`constraint_discovered` 属声明扩展）。等扩展类型落地再新增，避免永久空字段。
- **不做 provider 语义推断**：未知 raw kind 不猜测，显式返回 `unmapped`。
- **只读控制面信号，不重建控制状态**：§9.2 的映射表从 `operation.status` / `terminalState` 等控制面信号派生业务标签。这是单向只读路径——本模块不写回、不缓存、不重建任何控制真相。控制面语义变化（如 `OperationStatus` 新增枚举值）必须同步更新 §9.2 的表，否则新值会落入 `unmapped`。

**依赖方向（硬约束）**：

```text
packages/contracts  ←  packages/context-events  ←  packages/ui
                                                ←  packages/runtime
```

`packages/context-events` 只能依赖 `packages/contracts`。它**不得**导入 `packages/runtime`（`packages/ui` 不导入 runtime；一旦 context-events 依赖 runtime，UI 就无法消费它）。因此所有 normalize 输入用结构化接口描述，不从 runtime 取 `EventRecord` 类型。

`packages/context-events` 不新建 `package.json`；与 `packages/core` 一致，用相对路径导入，由根 `tsconfig.json` 的 `include: ["packages/**/*.ts", "tests/**/*.ts"]` 覆盖。

## 5. 模块结构

```text
packages/context-events/src/
  types.ts        # 冻结类型（第 6 节）
  taxonomy.ts     # §7 派生表：categoryOf/priorityOf/narrativeOf/defaultStatusOf/labelOf/allowedStatusOf（6）
                  # + §8.1 配对查表：openTypeOf/closeTypeOf/pairRoleOf/isOpenerType/isCloserType/closedStatusOf（6）
                  # 共 12 个导出纯函数
  errors.ts       # ContextEventError
  node-modules.d.ts  # `node:crypto` 的最小类型声明（与 packages/core 同构）
  validation.ts   # 正向与负向校验（第 11 节）
  normalize.ts    # createContextEvent + 4 个适配器 + unmapped（第 9 节）
  pairing.ts      # 配对索引 + 冲突检测（第 8 节）
  projector.ts    # UI narrative + Memory digest（第 10.1–10.2 节）
  compact.ts      # priority/预算压缩（第 10.3 节）
  index.ts        # 唯一导出面（Lead 所有）
tests/context-events/
  tsconfig.json
  context-events.test.ts
```

## 6. 冻结类型（`types.ts`）

```ts
export const CONTEXT_EVENT_CATEGORIES = [
  'task', 'plan', 'error', 'blocker',
] as const;                                  // v1 实际承载 18 个 type 的 4 个类目（见 §7 类目归属说明）
export type ContextEventCategory = (typeof CONTEXT_EVENT_CATEGORIES)[number];

export const CONTEXT_EVENT_TYPES = [
  'task.created', 'task.confirmed',
  'operation.started', 'operation.completed', 'operation.failed',
  'error.detected', 'error.resolved',
  'blocker.detected', 'blocker.resolved',
  'checkpoint.committed', 'checkpoint.reentered',
  'context.compacted',
  'plan.proposed', 'plan.accepted', 'plan.rejected',
  'retry.detected', 'retry.recovered', 'retry.exhausted',
] as const;                                  // 18 个，顺序即声明顺序
export type ContextEventType = (typeof CONTEXT_EVENT_TYPES)[number];

export type ContextEventPriority = 1 | 2 | 3 | 4 | 5;
export type ContextEventStatus =
  | 'active' | 'completed' | 'failed' | 'resolved' | 'superseded' | 'rejected';
export type ContextEventNarrative =
  | 'progress' | 'decision' | 'failure' | 'recovery' | 'checkpoint' | 'attention';
export type ContextEventPairRole = 'opened' | 'resolved' | 'rejected';

export interface ContextEventCost {
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly bytesAvoided?: number;
  readonly bytesRetrieved?: number;
}

export interface ContextEventPairing {
  readonly pairId: string;
  readonly role: ContextEventPairRole;
  readonly relatedEventId?: string;
}

export interface CanonicalContextEvent {
  readonly eventId: string;
  readonly sourceId: string;
  readonly type: ContextEventType;
  readonly scope: ScopeRef;
  readonly occurredAt: string;
  readonly status: ContextEventStatus;
  readonly summary: string;
  readonly payloadRef: string;
  readonly dataDigest: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly cost?: ContextEventCost;
  readonly pairing?: ContextEventPairing;
  readonly supersededByEventId?: string;
}

export interface OmittedReason {
  readonly eventId: string;
  readonly reason: 'budget' | 'pair' | 'superseded';
}

export interface UserNarrativeEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly state: 'happening' | 'happened' | 'failed' | 'resolved' | 'needs-user';
  readonly title: string;
  readonly detail?: string;
  readonly nextAction?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface DecisionDigest {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly outcome: 'accepted' | 'rejected' | 'confirmed';
}

export interface FailureRepairDigest {
  readonly failureEventId: string;
  readonly resolutionEventId?: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly resolutionSummary?: string;
}

export interface RejectedPlanDigest {
  readonly proposalEventId: string;
  readonly rejectionEventId?: string;
  readonly occurredAt: string;
  readonly summary: string;
}

export interface BlockerDigest {
  readonly blockerEventId: string;
  readonly resolutionEventId?: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly resolutionSummary?: string;
}

export interface MemoryContextDigest {
  readonly summary: string;
  readonly decisions: readonly DecisionDigest[];
  readonly failures: readonly FailureRepairDigest[];
  readonly rejectedPlans: readonly RejectedPlanDigest[];
  readonly blockers: readonly BlockerDigest[];
  readonly omitted: readonly OmittedReason[];
}

export interface CompactSnapshot {
  readonly snapshotId: string;
  readonly sourceWatermark: number;
  readonly retained: readonly CanonicalContextEvent[];
  readonly omitted: readonly OmittedReason[];
  readonly budgetBytes: number;
  readonly usedBytes: number;
}
```

`eventId` 与 `sourceId` 都是普通字符串，不是 `ScopedId`。`payloadRef + dataDigest` 代替内嵌 `data`，与「控制面与业务 payload 物理隔离」一致；`dataDigest` 格式为 `sha256:<64 位小写十六进制>`。

## 7. Taxonomy 表（`taxonomy.ts`）

`category` / `priority` / `narrative` / `defaultStatus` / `label` 全部由 `type` 派生，调用方不得覆盖。`label` 是中文短标签，用于 UI 标题。`taxonomy.ts` 共导出 **12 个**纯函数：`categoryOf`、`priorityOf`、`narrativeOf`、`defaultStatusOf`、`labelOf`、`allowedStatusOf` 六个派生函数，以及 §8.1 的 `openTypeOf` / `closeTypeOf` / `pairRoleOf` / `isOpenerType` / `isCloserType` / `closedStatusOf` 六个配对查表函数；`CanonicalContextEvent` **不存储** `category` / `priority` / `narrative`——三者都由 `type` 即时派生，避免第二真源。

`status` 是唯一保留的状态字段。它的初始值取自 `defaultStatusOf(type)`，但有两种改写来源，owner 不重叠（详见 §9.3）：构造期的 `supersededByEventId`（→ `'superseded'`）与配对期的 `applyPairingOutcome`（改写表见 §8.2）。

`allowedStatusOf(type)` = `{defaultStatusOf(type)}` ∪ `{'superseded'}` ∪ `{§8.2 改写表中该 type 的全部改写目标}`，是 §11 第 3 项的判据。`'superseded'` 对**所有** type 合法（任何事件都可被新事件取代），因此它必须计入 `allowedStatusOf`，否则 §11 第 3 项会拒绝 superseded 事件、而第 15 项又要求它存在，两条判据互斥。

| type | category | priority | narrative | defaultStatus | label |
|---|---|---|---|---|---|
| `task.created` | `task` | 2 | `progress` | `completed` | 任务已创建 |
| `task.confirmed` | `task` | 1 | `decision` | `completed` | 任务已确认 |
| `operation.started` | `task` | 4 | `progress` | `active` | 操作开始 |
| `operation.completed` | `task` | 3 | `progress` | `completed` | 操作完成 |
| `operation.failed` | `task` | 2 | `failure` | `failed` | 操作失败 |
| `error.detected` | `error` | 1 | `failure` | `active` | 发现问题 |
| `error.resolved` | `error` | 2 | `recovery` | `resolved` | 问题已修复 |
| `blocker.detected` | `blocker` | 1 | `attention` | `active` | 遇到阻塞 |
| `blocker.resolved` | `blocker` | 2 | `recovery` | `resolved` | 阻塞已解除 |
| `checkpoint.committed` | `task` | 1 | `checkpoint` | `completed` | 检查点已提交 |
| `checkpoint.reentered` | `task` | 2 | `checkpoint` | `completed` | 检查点已重入 |
| `context.compacted` | `task` | 4 | `checkpoint` | `completed` | 上下文已压缩 |
| `plan.proposed` | `plan` | 3 | `decision` | `active` | 提出方案 |
| `plan.accepted` | `plan` | 3 | `decision` | `completed` | 方案已采纳 |
| `plan.rejected` | `plan` | 2 | `decision` | `rejected` | 方案已否决 |
| `retry.detected` | `error` | 3 | `attention` | `active` | 检测到重试 |
| `retry.recovered` | `error` | 2 | `recovery` | `resolved` | 重试已恢复 |
| `retry.exhausted` | `error` | 2 | `failure` | `failed` | 重试已耗尽 |

类目归属说明：v1 只声明 4 个 category（`task` / `plan` / `error` / `blocker`），全部有 type 使用，无空枚举。`checkpoint.*` 与 `context.compacted` 归 `task`（checkpoint 身份已由 type + scope 承载）；`retry.*` 归 `error`（重试是错误邻近信号）。新增 category 必须同时新增使用它的 type。

## 8. 配对契约（`pairing.ts`）

配对是一等模型，不从 `summary` 或 UI correlation 推断。

| 打开事件 | 允许的关闭事件 | 关闭事件 role |
|---|---|---|
| `error.detected` | `error.resolved` | `resolved` |
| `blocker.detected` | `blocker.resolved` | `resolved` |
| `plan.proposed` | `plan.accepted` | `resolved` |
| `plan.proposed` | `plan.rejected` | `rejected` |
| `retry.detected` | `retry.recovered` | `resolved` |
| `retry.detected` | `retry.exhausted` | `rejected` |
| `operation.failed` | `checkpoint.committed` | `resolved` |
| `operation.failed` | `checkpoint.reentered` | `resolved` |

`retry.exhausted` 的 `role` 是 `rejected`（关闭但未恢复），其 `defaultStatus` 是 `failed`。`pairing.role` 描述“在配对中的角色”，`status` 描述“事件自身生命周期”，两者是不同维度。

`superseded`：当事件被新事件取代时，`status = 'superseded'` 且必须给出 `supersededByEventId`。取代**不是**配对关系：`ContextEventPairRole` 因此只含 `'opened' | 'resolved' | 'rejected'`，不含 `'superseded'`。取代事实只有一个真源（`status` + `supersededByEventId`），不重复表达为 pairing role。

### 8.1 配对查表（`taxonomy.ts`，阶段 0）

六个查表函数是**纯表**，下沉到阶段 0 的 `taxonomy.ts`：

```ts
export function closeTypeOf(type: ContextEventType): readonly ContextEventType[];      // 打开事件 → 允许的关闭事件；关闭事件 → []
export function openTypeOf(type: ContextEventType): ContextEventType | undefined;      // 关闭事件 → 其打开事件；打开事件 → undefined
export function pairRoleOf(type: ContextEventType): ContextEventPairRole | undefined;  // 关闭事件 → 其 role；打开事件 → undefined
export function isOpenerType(type: ContextEventType): boolean;   // = openTypeOf(type) === undefined && closeTypeOf(type).length > 0
export function isCloserType(type: ContextEventType): boolean;   // = pairRoleOf(type) !== undefined
export function closedStatusOf(closeType: ContextEventType): ContextEventStatus | undefined;  // §8.2 改写表：关闭事件 → 打开事件应改写的终态
```

`closedStatusOf` 与 `PAIRING_RULES` 同表，是 §8.2 改写关系的**唯一真源**：`pairing.ts` 必须 import 它，**不得**自带第二张 closed-status 表。每个关闭类型在 §8 配对表中恰好出现一次，因此改写目标只是关闭类型的函数（`checkpoint.committed` → `resolved`，与其自身 `defaultStatus` 为 `completed` 不同，不能由 `defaultStatusOf` 推导）。

放在阶段 0 而不是 `pairing.ts`，是因为 `validation.ts`（W1）与 `projector.ts`（W3）都要用它们。若放在 `pairing.ts`，W1/W3 会编译依赖 W2，阶段 1 并发不成立。

`isOpenerType` / `isCloserType` 是 §11 第 12/13 项的判据来源；`isOpenerType` 的谓词必须非空，否则校验项恒不触发（见 §11）。

### 8.2 配对索引与 status 改写（`pairing.ts`，W2）

```ts
export interface PairingIndex {
  readonly openedByEventId: ReadonlyMap<string, CanonicalContextEvent>;
  readonly closedByOpenedEventId: ReadonlyMap<string, CanonicalContextEvent[]>;
  readonly unpairedOpen: readonly CanonicalContextEvent[];
}

export function buildPairingIndex(events: readonly CanonicalContextEvent[]): PairingIndex;
export function applyPairingOutcome(events: readonly CanonicalContextEvent[]): readonly CanonicalContextEvent[];
export function assertPairingConsistent(events: readonly CanonicalContextEvent[]): void;
```

`buildPairingIndex` 要求输入已按第 12 节去重且 `eventId` 唯一；遇到重复 `eventId` 抛 `ContextEventError`。

`applyPairingOutcome` 是 **`status` 改写的唯一 owner**。第 7 节说 `status` 会被配对结果改写；本函数就是那个改写者，任何其它位置不得改写 `status`。它按 `buildPairingIndex` 的结果返回**新数组**（不改输入）：为每个**已配对**的关闭事件补 `pairing.relatedEventId`，并按下面的改写表把已闭合的打开事件从 `defaultStatus` 改写为终态。**未配对的关闭事件不分配 `pairing`**（§9.3、§10.3、§11 第 11 项一致）。

**不变量：`status === 'superseded'` 的事件不携带 `pairing`。** `buildPairingIndex` / `applyPairingOutcome` 一律跳过 superseded 事件，因此本模块产出的 canonical 事件永不出现该组合。这条是下游投影的前提，不是可选的：`compactContextEvents` 对 superseded 走 `reason: 'superseded'` 的丢弃分支（§10.3），而配对分组走整组同进同出；若某个 superseded 事件仍带 `pairing`，同一 `eventId` 会同时进入 `retained` 与 `omitted`，破坏 §10.3 的划分。§10.3 已要求输入必须是本函数的输出，故该组合属契约外输入；此处**显式**声明，以免被误读为未定义行为。本模块**不**为它增加运行时校验层（与「不为不可达场景增加校验层」一致）。

| 打开事件 | 默认 status | 关闭事件 | 改写后 status |
|---|---|---|---|
| `error.detected` | `active` | `error.resolved` | `resolved` |
| `blocker.detected` | `active` | `blocker.resolved` | `resolved` |
| `plan.proposed` | `active` | `plan.accepted` | `completed` |
| `plan.proposed` | `active` | `plan.rejected` | `rejected` |
| `retry.detected` | `active` | `retry.recovered` | `resolved` |
| `retry.detected` | `active` | `retry.exhausted` | `failed` |
| `operation.failed` | `failed` | `checkpoint.committed` | `resolved` |
| `operation.failed` | `failed` | `checkpoint.reentered` | `resolved` |

`allowedStatusOf(type)` 由 `taxonomy.ts` 导出，等于「`defaultStatusOf(type)` ∪ `{'superseded'}` ∪ 上表该 type 的全部改写目标」。它是 §11 第 3 项的可判定判据。`'superseded'` 计入所有 type（取代不是配对关系，见 §8.1 上方说明与 §9.3）。

`applyPairingOutcome` **不触碰** `status === 'superseded'` 的事件，也不为它们分配 `pairing`：被取代的事件不参与配对，其唯一真源是 `status` + `supersededByEventId`。

`pairId` 派生规则（确定性，满足第 12 节）：`applyPairingOutcome` 为每个「打开事件 + 其全部关闭事件」分配同一个 `pairId`，取值 `` `pair:${openedEventId}` ``（打开事件的 `eventId`）。打开事件与每个关闭事件共享该 `pairId`；关闭事件的 `relatedEventId` 指向打开事件的 `eventId`。未配对的打开事件不分配 `pairId`。因此 `pairId` 完全由输入决定，不含时钟、随机数或序号。`compactContextEvents` 用 `event.pairing.pairId` 分组实现成对保留（§10.3）。

**消费顺序（唯一合法顺序）**：`applyPairingOutcome` → 投影 / compact。`toUserNarrative`、`toMemoryDigest`、`compactContextEvents` 只读 `event.status` 与 `event.pairing`，**不 import `pairing.ts`**；因此 W3 与 W2 之间只有运行期顺序，没有编译期依赖，阶段 1 并发成立。

## 9. Normalize 契约（`normalize.ts`）

4 个适配器把原始事件转成 `CanonicalContextEvent`。原始事件类型用**结构化接口**声明，不从 runtime 导入。

```ts
export interface NormalizeContext {
  /** 权威 scope；organId 必填。来源自带 scope 时以来源为准，否则用它。 */
  readonly scope?: ScopeRef;
  /** 来源无稳定身份时必须提供。 */
  readonly sourceId?: string;
  /** 来源无时间戳时必须提供。 */
  readonly occurredAt?: string;
}

export interface UnmappedSource {
  readonly sourceKind: NormalizeSourceKind;
  readonly sourceId: string;
  readonly rawKind: string;
  readonly reason: 'unknown-kind' | 'waiting-is-not-terminal' | 'indistinguishable-tool-phase';
}

export interface NormalizeResult {
  readonly events: readonly CanonicalContextEvent[];
  readonly unmapped: readonly UnmappedSource[];
}

export type NormalizeSourceKind =
  | 'event-record' | 'agent-event' | 'agent-semantic-event' | 'provider-event';

export function normalizeEventRecord(input: EventRecordLike, context?: NormalizeContext): NormalizeResult;
export function normalizeAgentEvent(input: AgentEventLike, context: NormalizeContext): NormalizeResult;
export function normalizeAgentSemanticEvent(input: AgentSemanticEventLike, context: NormalizeContext): NormalizeResult;
export function normalizeProviderEvent(input: ProviderEventLike, context: NormalizeContext): NormalizeResult;
```

结构化输入接口。字段与真实类型结构兼容，但**只声明实际存在的字段**：

```ts
/** `EventEnvelope` (runtime/src/events/types.ts) 无 `payloadRef` 字段。
 *  `operation.status` 的真实类型是 contracts 的 `OperationStatus`（12 值 union），不是 string。 */
export interface EventRecordLike {
  readonly messageId: string;
  readonly streamId: string;
  readonly kind?: string;
  readonly class: 'control' | 'data' | 'observation';
  readonly scope: ScopeRef;
  readonly occurredAt: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly sequence: number;
  readonly operation?: {
    readonly status: OperationStatus;
    readonly resultRef?: string;
    readonly outputDigest?: string;
  };
}
export interface AgentEventLike {
  readonly kind: string;                    // 真实 `AgentEvent.kind` 是自由 string（两种方言，见 §9.2），此处不收紧
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly summary?: string;
  readonly terminalState?: ProviderTerminalState;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  /** `ProviderAgentEvent extends AgentEvent` 携带的原始 provider 事件；
   *  `provider.tool-result` 的成败判据取自 `providerEvent.toolResult.status`（§9.2）。 */
  readonly providerEvent?: ProviderEventLike;
}
export interface AgentSemanticEventLike {
  readonly seq: number;
  readonly kind: AgentSemanticEventKind;
  readonly state: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly terminalState?: ProviderTerminalState;
}
/** `ProviderEvent` (contracts/src/index.ts) 继承 `ProviderExecutionIdentityRef`，
 *  **无 `scope` 也无 `occurredAt`** 字段。这两个值必须由 `NormalizeContext` 提供。
 *  闭合 union 一律保留真源类型，不放宽成 string（放宽会掩盖 kind 词汇不匹配）。 */
export interface ProviderEventLike {
  readonly eventId: string;
  readonly kind: ProviderEventKind;
  readonly toolPhase?: 'invoke' | 'result';
  readonly terminalState?: ProviderTerminalState;
  readonly summary?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: { readonly message: string };
  readonly toolResult?: { readonly status: ProviderToolStatus; readonly outputRef?: string; readonly outputDigest?: string };
}
```

从 `packages/contracts` 导入的真源类型：`OperationStatus`（`export * from './tool-execution.js'` 已 re-export）、`ProviderEventKind`、`ProviderTerminalState`、`ProviderToolStatus`、`AgentSemanticEventKind`。

`AgentEventLike.kind` 是唯一保留 `string` 的 kind 字段，因为真实 `AgentEvent.kind` 就是自由 `string`（两种方言，见 §9.2）。

### 9.1 身份与时间戳派生

| 来源 | `sourceId` 派生 | `occurredAt` 派生 |
|---|---|---|
| `event-record` | `` `${streamId}#${sequence}` `` | 来源自带 |
| `agent-semantic-event` | `` `seq#${seq}` `` | 必须由 `context.occurredAt` 提供 |
| `agent-event` | 必须由 `context.sourceId` 提供 | 必须由 `context.occurredAt` 提供 |
| `provider-event` | 来源 `eventId` | 必须由 `context.occurredAt` 提供 |

`eventId` 一律为 `` `context-event:${sourceId}` ``。`occurredAt` 缺失且未提供时抛 `ContextEventError`。所有适配器都是纯函数：不读时钟、不取随机数、不读环境。

`scope` 派生规则：`EventRecordLike` 自带 `scope`，直接使用；`AgentEventLike` 从 `taskId` + `context.scope` 合成；`AgentSemanticEventLike` 和 `ProviderEventLike` 无 scope 字段，**必须**从 `context.scope` 提供，缺失时抛 `ContextEventError`。

`createContextEvent`（§9.3）不走派生：`sourceId` / `occurredAt` / `scope` 全部由调用方显式提供，缺失即抛 `ContextEventError`（`scope` 的精确行为见下段）。它是这些派生规则的唯一实现者，四个适配器只负责把各自输入折算成 `ContextEventInput` 后调用它。

**该承诺的精确边界**：`sourceId`、`occurredAt` 缺失或非法时由 §11 校验抛出 `ContextEventError`。`scope` / `evidenceRefs` / `cost` 的错误则分两类。**判据**（不是形状清单）：摘要规范化若要**解引用一个 `null` / `undefined`（或非对象）**，或把一个**非数组当数组**，就抛原生 `TypeError`；否则由 §11 校验抛 `ContextEventError`。原因是 §9.5 要求重建嵌套对象，摘要必然读取 `scope.organId`、`evidenceRef.evidenceId`、`evidenceRef.scope` 与 `cost` 的键，而摘要计算在校验运行**之前**（`normalize.ts` 的摘要早于其后的 `validateCanonicalContextEvent`）。

- **解引用失败 → 原生 `TypeError`**。典型形状：`scope` 为 `undefined` / `null` / `{}` / 非对象；`scope.organId` 为 `null`；`scope.taskId` / `cycleId` / `operationId` 为 `null`；`evidenceRefs` 非数组；元素为 `null` / 数字 / 非对象；元素缺 `evidenceId` 或 `evidenceId` 为 `null`；元素 `scope` 缺 `organId`、为 `null` 或 `scope.organId` 为 `null`；`cost` 为 `null`。**此列举不完备**——归一化网格（路径 × 值类别）实测有数十种形状落入该类，例如 `scope.cycleId = null`、`scope = 5`、元素为 `undefined`、元素 `scope = 5`。本条给的是判据，不是穷尽清单。
- **取值非法但结构存在 → 仍抛 `ContextEventError`**（由 §11 第 1–15 项判定）：`evidenceRefs[].kind` 取值不在闭合 union 内、`source` / `locator` 为空串、`digest` 非字符串、`evidenceId.scope` 取值错、`scope.organId` 缺 `value`、`scope.organId.scope` 取值错等。
- **`evidenceRefs` 与 `cost` 整体缺失或为 `null` 不会进入上面两类**：`evidenceRefs` 由 `?? []` 兜底，故缺失 / `undefined` / `null` 在构造入口都**不抛错**，摘要与空数组完全相同；`cost` 缺失也不抛错。只有 `scope` 缺失会抛 `TypeError`（它没有兜底）。

两种终止都是显式 fail-fast，不是静默成功，都不产出任何事件。本模块**不**为这些形状增加前置校验层：它们违反 `ContextEventInput` 的类型，类型正确的调用方无法构造，加校验层会违反「不为不可达场景增加校验层」。

**§11 绑定的校验入口**：`validateCanonicalContextEvent` 覆盖上述第一类的**大部分**形状（第 5 项覆盖 `scope`，第 7 项覆盖 `evidenceRefs` 元素），而不是全部。两个已知缺口：

1. **`cost === null`**：`validation.ts` 的 `cost` 检查只放过 `undefined`，随后读取 `cost.tokensInput`，故它也抛原生 `TypeError`。这是唯一一个**该入口**也抛 `TypeError` 的形状。
2. **元素的嵌套 scope 槽位**：`evidenceRefs[].scope.taskId` / `cycleId` / `operationId` 为 `null`（或 `""` / `0` / `false`）时，构造入口抛 `TypeError`，而 `validateCanonicalContextEvent` **不拦**——contracts 的 `assertEvidenceRef` 对这些槽位用真值判断，会放过它们。

**本变更未改动 `validation.ts`，上述两个缺口在本变更之前就存在，属既有行为。** 它们只影响违反 `ContextEventInput` 类型的输入，类型正确的调用方无法构造。

**`validateCanonicalContextEvent` 不是类型外输入的可靠兜底**：它对第一类的多数形状会抛 `ContextEventError`，但有上述两个缺口。构造入口的自检 `assertConstructionInvariants` 也不覆盖这些形状——它只判 `pairing === undefined` 与 `eventId` / `payloadRef` 的派生一致。因此类型外输入的错误类型由**摘要规范化与 §11 校验中的先到者**决定，这正是本段要精确说明的边界。

另需注意 `cost` 传非对象（如 `5`）**不抛错**——这在两个 SHA 上相同，属既有行为；但它的摘要表示由 `"cost":5` 变为 `{}`，**这一项是本变更新引入的**（本变更把 `cost` 改为按固定字段序重建），不是既有行为。

### 9.2 raw kind → canonical type 映射

`event-record` 优先按 `operation.status` 映射，其次按 `kind`：

`OperationStatus` 真源是 `packages/contracts/src/tool-execution.ts` 的 12 个值：`accepted | queued | leased | running | settling | verifying | succeeded | failed | blocked | cancel_requested | cancelled | reconcile_required`。判据按下表**完全覆盖**，不得只写部分分支：

| 判据 | canonical type |
|---|---|
| `operation.status === 'succeeded'` | `operation.completed` |
| `operation.status === 'failed' \| 'blocked' \| 'reconcile_required'` | `operation.failed` |
| `operation.status === 'accepted' \| 'queued' \| 'leased' \| 'running' \| 'settling' \| 'verifying' \| 'cancel_requested'` | `operation.started` |
| `operation.status === 'cancelled'` | `operation.failed` |
| 无 `operation` 且 `kind === 'checkpoint.committed'` | `checkpoint.committed` |
| 无 `operation` 且其它 `kind` | `unmapped` |

`cancelled` 归 `operation.failed`（取消是未成功的终态，不得伪装成 `completed`）；`blocked` 归 `operation.failed`（受阻不是完成）。`EventOperationMetadata.status` 的类型是 `OperationStatus`，故上表必须覆盖全部 12 个值。

`agent-semantic-event` 的 `kind` 是**闭合 union** `AgentSemanticEventKind`（`packages/contracts/src/index.ts`）：`execution.started | provider.model | provider.output | provider.tool | provider.error | execution.settling | checkpoint.committed | execution.terminal`。下表覆盖全部 8 个值：

| raw kind | canonical type |
|---|---|
| `execution.started` | `operation.started` |
| `provider.tool` | `operation.started` |
| `provider.error` | `error.detected` |
| `checkpoint.committed` | `checkpoint.committed` |
| `execution.terminal` + `terminalState === 'succeeded'` | `operation.completed` |
| `execution.terminal` + `terminalState === 'waiting'` | `unmapped`（reason `waiting-is-not-terminal`） |
| `execution.terminal` + 其它 / 缺失 | `operation.failed` |
| `provider.model` / `provider.output` / `execution.settling` | `unmapped`（reason `unknown-kind`，高噪声显式列出） |

`agent-event` 的 `kind` 是**自由 `string`**，且有**两种真实方言**，词汇表与可判定信息都不同。两种方言必须分别映射，**不得**归一成一张 base kind 表：同一个 base kind 在两方言里可读到的字段不同。

**provider 方言**（`packages/adapters/provider/src/agent-driver.ts:343-350`）：`provider.<kind>`，`<kind> ∈ {model, output, tool, error, terminal, attention, transport}`，另加 `provider.tool-result`（`providerEvent.kind === 'tool' && toolPhase === 'result'` 时）。`ProviderAgentEvent extends AgentEvent` 且带 `providerEvent: ProviderEvent`（`agent-driver.ts:67-70,353`），因此该方言**能**读到 `toolPhase` 与 `toolResult.status`。

| raw kind | canonical type |
|---|---|
| `provider.tool` | `operation.started` |
| `provider.tool-result` + `providerEvent.toolResult.status === 'succeeded'` | `operation.completed` |
| `provider.tool-result` + `providerEvent.toolResult.status !== 'succeeded'` | `operation.failed` |
| `provider.tool-result` + 无 `providerEvent.toolResult` | `unmapped`（reason `unknown-kind`） |
| `provider.error` / `provider.transport` | `error.detected` |
| `provider.attention` | `blocker.detected` |
| `provider.terminal` + `terminalState === 'succeeded'` | `operation.completed` |
| `provider.terminal` + `terminalState === 'waiting'` | `unmapped`（reason `waiting-is-not-terminal`） |
| `provider.terminal` + 其它 / 缺失 | `operation.failed` |
| `provider.model` / `provider.output` | `unmapped`（reason `unknown-kind`，高噪声显式列出） |
| 其它任意值 | `unmapped`（reason `unknown-kind`） |

**dsh 方言**（`packages/adapters/dsh/src/driver.ts:62-70`）：裸 `<kind>`，同一 7 值集合。该方言**只复制 `kind`**（不含 `providerEvent`），因此读不到 `toolPhase` / `toolResult`。

| raw kind | canonical type |
|---|---|
| `tool` | `unmapped`（reason `indistinguishable-tool-phase`） |
| `error` / `transport` | `error.detected` |
| `attention` | `blocker.detected` |
| `terminal` + `terminalState === 'succeeded'` | `operation.completed` |
| `terminal` + `terminalState === 'waiting'` | `unmapped`（reason `waiting-is-not-terminal`） |
| `terminal` + 其它 / 缺失 | `operation.failed` |
| `model` / `output` | `unmapped`（reason `unknown-kind`，高噪声显式列出） |
| 其它任意值 | `unmapped`（reason `unknown-kind`） |

dsh 方言的 `tool` **必须**映射为 `unmapped`，不得映射成 `operation.started`：真源 `packages/adapters/dsh/src/real-transport.ts:559-578` 对 `tool/call` 与 `tool/result` **都**产出 `kind: 'tool'`，且都不设 `toolPhase` / `toolResult`（`grep toolPhase packages/adapters/dsh/src/` 无命中）。若把 `tool` 当作调用，DSH 的每次工具完成都会产出 `operation.started`，永不产出 `operation.completed` / `operation.failed`——静默错映射比 `unmapped` 更糟。

**登记接入点**：dsh 适配器补上 `toolPhase`（或让 `AgentEvent` 携带 `providerEvent`）后，dsh 方言即可按 provider 方言同形映射。本轮不改 dsh 适配器（§9.4 范围取舍）。

`execution.started` 的真实语义是操作开始（`coordinator.ts` 以 `state: 'running'` 发出），映射到 `operation.started`，**不是** `task.confirmed`。`terminal + waiting` 表示等待，映射到 `unmapped` 并携带 `reason: 'waiting-is-not-terminal'`，绝不伪装成 `operation.completed`。

`provider-event`：

| 判据 | canonical type |
|---|---|
| `kind === 'tool' && toolPhase !== 'result'` | `operation.started` |
| `kind === 'tool' && toolPhase === 'result' && toolResult.status === 'succeeded'` | `operation.completed` |
| `kind === 'tool' && toolPhase === 'result' && toolResult.status !== 'succeeded'` | `operation.failed` |
| `kind === 'error' \| 'transport'` | `error.detected` |
| `kind === 'attention'` | `blocker.detected` |
| `kind === 'terminal' && terminalState === 'succeeded'` | `operation.completed` |
| `kind === 'terminal' && terminalState === 'waiting'` | `unmapped`（reason `waiting-is-not-terminal`） |
| `kind === 'terminal' && 其它` | `operation.failed` |
| `kind === 'model' \| 'output'` | `unmapped`（reason `unknown-kind`，高噪声显式列出） |

本表 `terminal` 行只写「其它」而**不**写「其它 / 缺失」，与其他三张表的「其它 / 缺失」不同，这是真源差异而非笔误：`ProviderEvent.terminalState` 由 contracts 强制——`contracts/src/index.ts` 规定 `kind === 'terminal' && !terminalState` 直接抛错，因此在 provider-event 输入里 `terminalState` 不可能缺失；而 `AgentEvent.terminalState` 是可选的，`agent-semantic` / `agent-event` 两张表必须显式覆盖缺失情形。实现时 `terminal` 的缺失分支在 provider-event 表上是死代码，**不要**为它加额外校验层。

未命中任一规则的 raw kind 进入 `unmapped`，`reason: 'unknown-kind'`，不得静默丢弃。**已知 kind 但缺判据所需字段**时（如 `kind === 'tool' && toolPhase === 'result'` 却无 `toolResult`），同样进 `unmapped` 且 reason 仍用 `'unknown-kind'`（reason 词表本轮只有 3 值，不扩）；`rawKind` 必须回填原始 kind，不得吞掉来源信息。

**本条的适用范围是 `kind` 为自由 `string` 的方言**，即 `event-record`（`kind?: string`）与 `agent-event`（`kind: string`）：只有它们能承载「未命中任一规则的 raw kind」，也只有它们需要运行时兜底。`agent-semantic-event` 与 `provider-event` 的 `kind` 是**闭合 union**（8 值 / 7 值），§9.2 的三张表已逐值覆盖全部取值，因此类型安全的调用方**不可能**传入未命中规则的 kind；这两个适配器**不**加「未知 kind → `unmapped`」的运行时兜底，也不加防御层（与「不为不可达场景增加校验层」一致）。同理，`event-record` 的 `operation.status` 是闭合 12 值 union，无 `'pending'`，故 `typeForOperationStatus` 的 `switch` 覆盖全部取值、无 default 分支。

**为什么工具调用的判据是 `toolPhase !== 'result'` 而不是 `toolPhase === 'invoke'`**（真源核对，勿改回）：

- 真实 provider 工具调用**不带** `toolPhase`：`packages/adapters/provider/src/codecs.ts:692-702` 产出 `kind:'tool'` + `toolCall: { callId, toolId, arguments, continuationRef }`，**无** `toolPhase`。这是**合法**形状——`packages/contracts/src/index.ts:1346-1347` 只在「有 `toolCall` 且 `toolPhase === 'result'`」或「无 `toolCall` 且无 `toolPhase`」时抛错。
- 全仓**没有** `'invoke'` 生产者：真实 provider 侧唯一产出 `toolPhase` 的代码是 `packages/adapters/provider/src/agent-driver.ts:366` 的 `'result'`（`app/src/ui-runtime/fake-port.ts:257` 只是透传调用方注入的 replay 值，测试注入的也全是 `'result'`）。
- 若写成 `toolPhase === 'invoke'`，该规则**永不命中**，真实工具调用会落到 `unmapped` 且 reason 写 `unknown-kind`（`'tool'` 明明是已知 kind，reason 事实错误）；而同一底层事实经 agent-event provider 方言（`agent-driver.ts:347-349` → `provider.tool` → 本节上方 provider 方言表的 `provider.tool` 行）却映射为 `operation.started`。同一模块对同一真源事实给出互相矛盾的结论。
- `kind === 'tool'` 且既无 `toolCall` 又无 `toolPhase` 的事件**不会**误命中本行：它被 `contracts/src/index.ts:1347` 挡在适配器之外。

### 9.3 直接构造入口（`createContextEvent`）

适配器只能覆盖**外部流已经携带**的事实。18 个 canonical type 中有一部分是领域 owner 自己知道、而当前四个适配器不承载的事实（计划生命周期、retry 决策、任务创建、上下文压缩）。若没有构造入口，这些类型就没有任何合法存在方式，§8 配对表与 §10.2 digest 的一半分支即不可达。

因此 `normalize.ts` 导出**唯一**的 canonical 事件构造函数，四个适配器都是它的薄包装：

```ts
export interface ContextEventInput {
  readonly type: ContextEventType;
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly scope: ScopeRef;
  readonly summary?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  /** 取代关系。提供即产出 status='superseded'；不提供即 defaultStatusOf(type)。 */
  readonly supersededByEventId?: string;
  readonly cost?: ContextEventCost;
}

export function createContextEvent(input: ContextEventInput): CanonicalContextEvent;
```

`createContextEvent` 是 `eventId` / `payloadRef` / `dataDigest` / `scope` 校验 / `status` **初值**派生的唯一 owner；适配器不得各自重复实现（§12 确定性由此单点保证）。它按 §9.1 的身份与时间戳规则和 §9.5 的载荷与摘要规则产出事件，并调用 `validateCanonicalContextEvent` 自检。

`status` 只有两个来源，owner 不重叠：

| 阶段 | owner | 规则 |
|---|---|---|
| 构造期初值 | `createContextEvent` | `supersededByEventId` 存在 → `'superseded'`；否则 `defaultStatusOf(type)`。**不接受调用方直接指定 `status`** |
| 配对期改写 | `applyPairingOutcome` | 按 §8.2 改写表；**不触碰** `status === 'superseded'` 的事件 |

构造期不接受自由 `status` 入参：若允许调用方直接写入改写目标值（如构造 `operation.failed` 时直接给 `status: 'resolved'`），同一语义就有两条表达路径，§8.2「`applyPairingOutcome` 是配对改写唯一 owner」即不成立。`supersededByEventId` 是取代事实的唯一入口，与配对无关。

**`pairing` 不由 `createContextEvent` 产出。** `pairing` 是**派生关系**，由 `applyPairingOutcome`（§8.2）独占赋值。因此：

- `createContextEvent` 产出的事件**没有** `pairing` 字段；
- `validateCanonicalContextEvent` 对**两种状态都合法**：无 `pairing` 时 §11 第 9–14 项 vacuous；有 `pairing` 时第 9–14 项生效；
- 关闭事件（`isCloserType(type)`）**不要求**在构造期带 `pairing`——「一个 `error.resolved` 的配对 `error.detected` 不在同一窗口内」是合法输入，它表现为未配对关闭事件（§10.3 按单条处理）。

### 9.4 类型可达性矩阵

下表有三列，各自独立、都必须如实：

- **适配器规则**：§9.2 是否存在把某 raw kind 映射到该 type 的规则（能否产出，是契约能力）；
- **构造入口**：是否可经 `createContextEvent` 产出；
- **上游生产者**：该规则依赖的 raw kind 在**当前**真实仓库里是否真有生产者（是既有事实，不是契约能力）。

两列「能力」与「当前上游是否真有生产者」必须分开看：规则存在但上游暂无生产者，仍是合法契约，只是当下不会触发。本模块是**事实层定义**，不是既有事件的改名。

| canonical type | 适配器规则 | 构造入口 | 上游生产者 | 真实来源 |
|---|---|---|---|---|
| `operation.started` | ✓ | ✓ | 有 | `OperationEvent.status='running'`（`gateway.ts:597`）；agent-event provider 方言 `provider.tool`（`agent-driver.ts:347-349`）；provider-event `kind='tool' && toolPhase !== 'result'`（`codecs.ts:692-702`，无 `toolPhase` + 有 `toolCall`）；agent-semantic `execution.started` |
| `operation.completed` | ✓ | ✓ | 有 | `hand-runtime.ts:237`（`status='succeeded'`）；`provider.tool-result` succeeded；`terminal + succeeded` |
| `operation.failed` | ✓ | ✓ | 有 | `hand-runtime.ts:226,269,286`、`gateway.ts:354,413,574`；`terminal + 非 succeeded/waiting` |
| `error.detected` | ✓ | ✓ | 有 | `ProviderEventKind 'error'`（`codecs.ts:814,827,1050,1084,1298`、`real-transport.ts:618,693`）；agent-semantic `provider.error` |
| `blocker.detected` | ✓ | ✓ | **无** | 规则映射 `provider.attention`（§9.2），但 `ProviderEventKind 'attention'` 有定义**无生产者**。最接近的真实事实是 `Attention{severity:'blocker',state:'open'}`（`attention-journal.ts:26-35`）与 `RuntimeTaskEvent 'attention.opened'`（`coordinator.ts:1258,1344,1444`） |
| `checkpoint.committed` | ✓ | ✓ | 有 | agent-semantic `checkpoint.committed`（`fake-execution.ts:180`）；`RuntimeTaskEventKind 'checkpoint.committed'`（`coordinator.ts:1249,1335,2358,2515`） |
| `task.created` | ✗ | ✓ | 有（非适配器流） | `RuntimeTaskJournalRecord.kind === 'task.created'`（`coordinator.ts:249` 定义、`:896` 唯一生产点） |
| `blocker.resolved` | ✗ | ✓ | **无** | 真实事实是 `Attention.state === 'resolved'`（`control/attention.ts:34`，`runtime-stop.ts:146,216`）。`RuntimeTaskEvent 'attention.resolved'` 有定义**无生产者** |
| `checkpoint.reentered` | ✗ | ✓ | **无** | 真实事实是 `ReentryRecord{closureKind:'reentry'}`（`checkpoints/closure.ts:54`，`submission.ts:506` → `checkpoint-journal.ts:395-400`） |
| `retry.exhausted` | ✗ | ✓ | **无**（非事件 kind） | 真实事实是 `RetryCycleIssue.code='retry.exhausted'`（`retry-cycle.ts:283,379,394,480`），经 `publishRetryAttention`（`coordinator.ts:1414`）升级为 Attention(blocker)，见 §9.4.1 |
| `error.resolved` | ✗ | ✓ | **无** | 领域 owner（错误策略）尚未发出 |
| `task.confirmed` | ✗ | ✓ | **无** | 最接近的真实事实是 `ExplicitInteractionState 'confirmed'`（`intake/explicit-intake.ts:15`，非事件） |
| `context.compacted` | ✗ | ✓ | **无** | 最接近的真实事实是 `ContextReplacementReason 'compaction'`（`contracts/src/agent-loop.ts:11`，非事件） |
| `plan.proposed` / `plan.accepted` / `plan.rejected` | ✗ | ✓ | **无** | DSH session 的 `plan/mode` 在 `real-transport.ts:627-628` 被 `default: return []` 丢弃 |
| `retry.detected` / `retry.recovered` | ✗ | ✓ | **无**（且无等价物） | 见 §9.4.1：这两个是本模块为 retry 领域**新定义**的规范事实 |

计数：适配器规则可达恰 **6** 个，仅有构造入口的恰 **12** 个，合计 18（`plan.*` 与 `retry.*` 各按 3 个计）。每个 type 至少有**一条**合法路径。当前上游真有生产者的只有 **5** 个（第 1–4 行与第 6 行）；第 5 行 `blocker.detected` 的上游为「无」；`task.created`（第 7 行）的生产者在非适配器流中。

#### 9.4.1 retry 事实的真实落点

`retry.*` 在真实仓库不是事件 kind，而是三个互不相同的落点，容易误判，故单列：

| 落点 | 载体 | 内容 |
|---|---|---|
| ① retry-cycle 控制记录 | `retry-cycle.jsonl`，payload `kind:'retry-cycle'`（`retry-cycle-journal.ts:92-101`） | `RetryCycleControlRecord.state ∈ admitted\|running\|settling\|retry-safe\|exhausted\|blocked-attention`；`RetryCycleIssue.code` 目前有 **6** 个取值：`retry.exhausted` / `retry.no-candidate` / `retry.candidate.unavailable` / `retry.unsettled` / `retry.unknown` / `retry.cancelled`（后两个来自 `retry-cycle.ts:449` 的模板 `` `retry.${input.settleState}` ``）。其余 `retry.*` 字符串是 `reason` / `nextAction.ref`，不是 issue code |
| ② 耗尽/无候选升级 | `Attention{severity:'blocker', state:'open'}` + `RuntimeTaskEvent 'attention.opened'` | `publishRetryAttention`（`coordinator.ts:1414`） |
| ③ orchestration feedback | `OrchestrationFeedbackEvent{kind:'retry'}`（`manager.ts:409,922`）→ M3 `assignment-feedback` → EventBus | 该 EventBus 记录 **`envelope.kind === undefined`**（`m3-assembly.ts:110-121`） |

因此：`retry.exhausted` 有等价控制事实（落点 ①②）；`retry.detected` / `retry.recovered` **没有任何等价物**——它们是本模块为 retry 领域**新定义**的规范事实，由 retry owner 经 `createContextEvent` 发出。

**v1 的明确取舍**：先冻结类型与投影契约，领域 owner 的接线在后续轮次按需完成。v1 不新增适配器（如 `RuntimeTaskEvent`、`RuntimeTaskJournalRecord`、Attention 流），因为那会扩大本轮范围；它们的自然接入点在「真实来源」列已登记。表中「✗ / ✓」的行**不是**死类型：它们的配对、digest、投影、校验分支都由 §14 的 `createContextEvent` 路径覆盖。**已知产品后果**：v1 不会从既有真实流产出 `task.created`、`blocker.detected`、`blocker.resolved`，尽管相应事实已存在于 `RuntimeTaskJournalRecord` 与 `attention.jsonl`。

**同名不同流的告警**：`operation.started`、`checkpoint.committed` 各自横跨至少 **2 条**真实流（例：`operation.started` 既是 `OperationEvent.status='running'`（`gateway.ts:597`），也是 `RuntimeTaskJournalRecord.kind`（`coordinator.ts:271` 定义、`:1016` 生产））。`task.created` 只有**一个**生产者流（`coordinator.ts:249` 定义、`:896` 唯一生产点，UI runtime journal），但被 journal 校验面（`app/src/ui-runtime/journal.ts:119`）与 memory 读取面（`app/src/memory-runtime.ts:144`）两处消费——这是「一写多读」，**不是**多流。归一化不得只按 kind 字符串聚合；`sourceId`（§9.1）必须携带流身份。

### 9.5 载荷与摘要

- `payloadRef`：一律为 `` `context-event:${sourceId}` ``。`EventRecordLike` / `ProviderEventLike` 都不含 `payloadRef` 字段（`EventEnvelope` 只有 `payload?: BusinessPayload`），无来源可透传。
- `dataDigest`：`sha256:<64 位小写十六进制>`，被哈希的是**按固定字段序重建的规范化对象**，不是调用方传入的对象（§12 禁止直接哈希来源对象）。**「重建」递归适用于所有嵌套对象**：`evidenceRefs` 的元素与 `cost` 也是嵌套对象，若按引用参与哈希，同一事实在不同键序下会得到不同摘要。固定字段序（`JSON.stringify` 的键序即此序）：
  顶层 `type` → `sourceId` → `occurredAt` → `scope` → `summary` → `evidenceRefs` → `supersededByEventId` → `cost`。
  嵌套层同样按固定键序重建：
  - `scope`（含 `evidenceRefs[].scope`）：`organId` → `taskId` → `cycleId` → `operationId`；
  - `ScopedId` 叶子统一按 `scope` → `value` 重建。`ScopedId` 在摘要里出现两处——`ScopeRef` 的四个槽位与 `evidenceRefs[].evidenceId`——**两处必须走同一个规范化函数**，否则漏掉任一处，该处的键序就会泄进 `dataDigest`；
  - `evidenceRefs[]`：`evidenceId` → `kind` → `source` → `locator` → `digest` → `scope`；
  - `cost`：`tokensInput` → `tokensOutput` → `bytesAvoided` → `bytesRetrieved`。
  规则：
  1. **哈希的是最终写入事件的取值**，不是原始入参：`summary` 缺省时先补 `labelOf(type)` 再参与哈希，`evidenceRefs` 缺省时按 `[]` 参与哈希。因此摘要覆盖 canonical 事件上所有**原样存储**的数据字段。
  2. **`status` / `pairing` / `eventId` / `payloadRef` / `dataDigest` 一律不参与哈希**：`status` 与 `pairing` 会被 `applyPairingOutcome` 改写（§8.2），若纳入摘要，同一个事件在配对前后会得到不同摘要；`eventId` / `payloadRef` 由 `sourceId` 派生，已在摘要内。
  3. **值为 `undefined` 的可选字段省略该键**（不写 `null`）；数组保持输入顺序不重排（元素内部键序按上表规范化，数组顺序不重排）。

  由此得到一条不变量：`dataDigest` 在 `applyPairingOutcome` 前后**保持不变**。W4 必须锁死字段序与这条不变量。
- `summary`：来源 `summary` 非空时透传；否则用 taxonomy `label`。

## 10. 投影契约

### 10.1 UI Narrative（`projector.ts`）

```ts
export function toUserNarrative(events: readonly CanonicalContextEvent[]): UserNarrativeEvent[];
```

- `status === 'superseded'` 的事件不输出。
- `state` 映射：`active` → `happening`；`completed` → `happened`；`failed` → `failed`；`resolved` → `resolved`；`rejected` → `happened`。
- `narrativeOf(event.type) === 'attention' && status === 'active'` 时 `state = 'needs-user'`。
- `title` = taxonomy `label`；`detail` = 事件 `summary`。
- `nextAction`：仅当 `isOpenerType(event.type) && status === 'active'` 时给出，取 `closeTypeOf(event.type)` 各关闭类型 `label` 的连接（如 `error.detected` 未闭合 → `问题已修复`）。其它情况 `undefined`。**连接符固定为 `' / '`**（与 §10.2 的 `summary` 一致），因此 `plan.proposed` 的 `nextAction` 为 `方案已采纳 / 方案已否决`。注意判据是「`status` 仍为 `active` 的打开类型」，**不是**「已打开且未被配对闭合」：`operation.failed` 的默认 status 是 `failed`，它即使未配对也**不**给出 `nextAction`。
- 输出顺序与输入顺序一致（输入须已按第 12 节排序）。
- 输入必须是 `applyPairingOutcome` 的输出（§8.2）；本函数只读 `event.status` 与 `event.pairing`，不 import `pairing.ts`。

### 10.2 Memory Digest（`projector.ts`）

```ts
export interface MemoryDigestOptions { readonly summaryBudgetBytes?: number } // 默认 2048
export function toMemoryDigest(
  events: readonly CanonicalContextEvent[],
  options?: MemoryDigestOptions,
): MemoryContextDigest;
```

- `decisions`：`task.confirmed`（`outcome: 'confirmed'`）、`plan.accepted`（`'accepted'`）、`plan.rejected`（`'rejected'`）。
- `failures`：每个 `error.detected` 输出一条，`resolutionEventId` 取其配对 `error.resolved`（可能缺失）。
- `rejectedPlans`：每个**被否决的** `plan.proposed` 输出一条——即该提案的配对关闭事件为 `plan.rejected`。anchor 是**提案**，与 `failures` / `blockers` 对称：必填的 `proposalEventId` 是提案自身的 `eventId`，`occurredAt` / `summary` 取提案；可选的 `rejectionEventId` 取其配对的 `plan.rejected`（可能缺失）。未配对的 `plan.proposed` 不输出（没有否决事实），进 `omitted`。`plan.accepted` 只进 `decisions`，不进 `rejectedPlans`。
  未配对的 `plan.rejected` 也**不**进 `rejectedPlans`（没有可指认的提案），但它已由上一条无条件进入 `decisions`，因此**不**进 `omitted`：`omitted` 的定义是「未进入上述任一 digest 字段的事件」，而它已进入 `decisions`。若把它也塞进 `omitted`，同一 `eventId` 会同时出现在两个字段里，且 `omitted` 的语义会被破坏。
- `blockers`：每个 `blocker.detected` 输出一条，`resolutionEventId` 取其配对 `blocker.resolved`（可能缺失）。
- `summary`：按第 12 节顺序取 `priorityOf(event.type) <= 2` 的事件 `summary`，用 `' / '` 连接，按 `summaryBudgetBytes` 截断；截断发生在事件边界（不切半个事件）。**截断语义是前缀截断**：按第 12 节顺序累加，遇到第一个装不下的事件即停止，**不**跳过它去塞入更小的后续事件。因此 `summary` 覆盖的永远是第 12 节顺序的一个前缀。
- `omitted`：**未进入上述任一 digest 字段**（`decisions` / `failures` / `rejectedPlans` / `blockers` / `summary`）的事件。`reason` 只能是 `'superseded'`（被取代）或 `'budget'`；`'budget'` 是该 union 中唯一的「非取代」取值，涵盖所有未被任一 digest 字段收纳的情形（含 `summary` 预算不足、`priorityOf > 2` 因而不参与 `summary`、以及类型不在任何 digest 分支内），**不是**仅指 `summary` 预算不足。`'pair'` 只属 compact（§10.3），memory digest 永不产出。
- 输入必须是 `applyPairingOutcome` 的输出（§8.2）；配对信息只从 `event.pairing.relatedEventId` 读取，不 import `pairing.ts`。

### 10.3 Compact Snapshot（`compact.ts`）

```ts
export interface CompactOptions {
  readonly budgetBytes: number;             // 必填，正整数
  readonly snapshotId: string;              // 必填，非空
  readonly sourceWatermark?: number;        // 默认 0
}
export function compactContextEvents(
  events: readonly CanonicalContextEvent[],
  options: CompactOptions,
): CompactSnapshot;
```

- 字节度量统一用 `new TextEncoder().encode(JSON.stringify(event)).length`；每条事件的占用含尾部连接开销常量 **`EVENT_JOIN_OVERHEAD_BYTES = 1`**（实现须在注释中固定该常量，测试锁死）。因此 `usedBytes` = Σ(每条保留事件的 `JSON.stringify` 字节 + 1)。
- 候选顺序：`priorityOf(event.type)` 升序 → `occurredAt` 升序 → `eventId` 升序。这与第 12 节的**输入**排序键（`occurredAt` 优先）刻意不同：第 12 节定义规范输入顺序，本条定义压缩时的丢弃优先级。两者不是同一件事，调用方不必为 compact 重排输入。
- **成对保留**：打开事件与其关闭事件同进同出。配对分组用 `event.pairing.pairId`（派生规则见 §8.2）。若两者都在候选中，只在预算能容纳两者时一起保留；否则都不保留，`reason: 'pair'`。只有关闭事件命中候选而打开事件不在输入中时，按单条处理。
- **已知 trade-off（明示接受）**：`priorityOf(type)` 升序会让 `error.detected`（priority 1）与其 `error.resolved`（priority 2）被其它 priority 1 事件隔开。若预算恰在两者之间耗尽，整对丢弃，可能出现「低优先级事件保留、高优先级事件的配对整对丢弃」的非单调结果。这是「成对完整性优先于单条优先级」的显式取舍：宁可整对丢弃，也不让 UI 看到没有修复记录的错误。
- `superseded` 事件不参与保留，`reason: 'superseded'`。
- 预算耗尽后剩余候选 `reason: 'budget'`。
- `usedBytes` 为实际保留的字节数，必须 `<= budgetBytes`。
- `retained` 保持候选顺序。
- 输入必须是 `applyPairingOutcome` 的输出（§8.2）；本函数只读 `event.status` 与 `event.pairing`，不 import `pairing.ts`。

## 11. 校验契约

三个校验函数归 `validation.ts`（W1）：

```ts
export function validateCanonicalContextEvent(input: CanonicalContextEvent): void;
export function validateCompactSnapshot(input: CompactSnapshot): void;
export function validateMemoryContextDigest(input: MemoryContextDigest): void;
```

本节还列出另两个产物的负向用例，但实现 owner **不是** `validation.ts`：`assertPairingConsistent` 归 `pairing.ts`（W2），`compactContextEvents` 归 `compact.ts`（W3）。W1 只写 `validation.ts`，不得实现这两者；W2 / W3 也不得把校验逻辑搬进 `validation.ts`。

`validateCanonicalContextEvent` 的负向用例（全部抛 `ContextEventError`）：

1. `eventId` / `sourceId` / `summary` / `payloadRef` 为空。
2. `type` 不在 `CONTEXT_EVENT_TYPES`。
3. `status` 不在 `allowedStatusOf(type)` 内（`allowedStatusOf` 定义见 §7 / §8.2；**含 `'superseded'`**）。
4. `occurredAt` 不是合法时间戳。
5. `scope.organId.scope !== 'organ'` 或为空。可选 id（`taskId` / `cycleId` / `operationId`）**存在时**也按 `ScopeRef` 声明的 kind 逐项校验（复用于此的 `assertScope`），kind 不符即抛错。
6. `dataDigest` 不匹配 `/^sha256:[0-9a-f]{64}$/`。
7. `evidenceRefs` 中任一项不满足 `assertEvidenceRef`（复用 contracts 校验）。
8. `cost` 任一字段存在但不是非负安全整数。

以下第 9–14 项**只在 `pairing` 存在时适用**。`pairing` 是派生关系，由 `applyPairingOutcome` 独占赋值（§9.3）；`createContextEvent` 不产出 `pairing`，因此未配对事件（含未配对关闭事件）在第 9–14 项上 vacuous，不是错误。

9. `pairing` 存在且 `pairing.pairId` 为空，或 `pairing.role` 不在 `ContextEventPairRole`（3 值）内。
10. `pairing` 存在且 `pairing.role === 'opened'`，但带 `pairing.relatedEventId`。
11. `pairing` 存在且 `pairing.role !== 'opened'`，但缺 `pairing.relatedEventId`。
12. `pairing` 存在且 `pairing.role !== 'opened'`，但 `isCloserType(type)` 为假（非关闭类型不得带关闭角色）。
13. `pairing` 存在且 `pairing.role === 'opened'`，但 `isOpenerType(type)` 为假（非打开类型不得带打开角色）。
14. `pairing` 存在且 `isCloserType(type)` 为真，但 `pairing.role !== pairRoleOf(type)`。
15. `status === 'superseded'` ⟺ `supersededByEventId` 存在（双向：缺一即抛错）。`status === 'superseded'` 一侧额外要求该引用**非空**（`''` 视为缺失，抛错）。

第 12/13/14 项对「`pairing` 存在」的情形**穷尽**：`isOpenerType` 与 `isCloserType` 不可能同时为真；两者皆为假时由第 12/13 项覆盖（该 type 不参与配对，不得带任何角色）。注意第 13 与第 14 项**并非互斥**：关闭类型携带 `pairing.role === 'opened'` 时（如 `error.resolved` 带 `role: 'opened'`）两项同时成立——结论相同（都抛错），行为无歧义，但实现不得假设二者只命中一个。`isOpenerType` 的谓词 `openTypeOf(type) === undefined && closeTypeOf(type).length > 0` 对 5 个打开类型为真（`operation.failed`、`error.detected`、`blocker.detected`、`plan.proposed`、`retry.detected`），`isCloserType` 对 8 个关闭类型为真，谓词均非空，因此第 12/13/14 项不是死代码。第 13 项封住「打开事件伪装成关闭角色」的绕过路径（例如 `error.detected` 带 `pairing.role: 'resolved'`）。

`assertPairingConsistent` 的负向用例（校验**配对结果**，不是单事件）：

16. 同一打开事件被两个关闭事件引用。
17. 关闭事件的 `relatedEventId` 指向不存在的打开事件。
18. 关闭事件指向类型不兼容的打开事件（如 `error.resolved` 指向 `blocker.detected`）。
19. `relatedEventId` 指向自身。
20. （**第 16 项的具体实例，不另立判据**）`plan.accepted` 与 `plan.rejected` 同时引用同一个 `plan.proposed`。

21. `budgetBytes` 不是正整数 → 抛 `ContextEventError`；`snapshotId` 为空串 → 抛 `ContextEventError`（两者都是入参校验，属抛错用例；`snapshotId` 的「必填、非空」见 §10.3）。

`compactContextEvents` 的**输出不变量**（第 22/23 项不是「抛错」用例，而是断言函数输出必须满足的性质；违反即为实现缺陷，测试直接断言不成立）：

22. 输出必须满足 `usedBytes <= budgetBytes`（不变量，非抛错）。
23. 输出中不得出现「成对事件之一被保留、另一个被丢弃」（不变量，非抛错）。

`validateCompactSnapshot` / `validateMemoryContextDigest` 的判据（§11 只详列了 canonical 的 15 项，这里补齐另两个校验器的边界，避免实现各自发明）：

- `validateCompactSnapshot`：`budgetBytes` 非正整数、`usedBytes > budgetBytes`、`usedBytes` 非非负安全整数、`sourceWatermark` 非非负安全整数、`retained` 中任一项不满足 `validateCanonicalContextEvent`、`omitted` 中 `reason` 不在 `OmittedReason` 的 3 值内、`omitted` 中 `eventId` 为空（`OmittedReason.eventId` 是必填字段）→ 抛 `ContextEventError`。
- `validateMemoryContextDigest`：**各 digest 条目的** `summary` 为空、各 digest 条目的必填 id 为空、`occurredAt` 非法时间戳、`decisions[].outcome` 不在 3 值内、**`omitted` 中出现 `reason: 'pair'`** → 抛 `ContextEventError`。最后一条依据 §10.2「`'pair'` 只属 compact，memory digest 永不产出」：接受它会放过一个不可能由本模块产出的形状。
  **顶层 `summary` 允许为空串**：§10.2 的 `summary` 是「`priorityOf <= 2` 的事件 summary 用 `' / '` 连接」，当输入中没有这类事件时（例如只有 `context.compacted`，priority 4）连接结果就是 `''`，是合法产物。要求顶层非空会把合法输出判为非法。

## 12. 确定性要求

- 所有函数纯函数：不读时钟、不用随机数、不读环境变量、不读文件系统。
- 输入排序键固定：`occurredAt` 升序 → `priorityOf(type)` 升序 → `eventId` 升序。`sortEvents` 由 `projector.ts` 导出，供调用方与测试复用。
- `eventId` 由 `sourceId` 确定性派生，因此同一来源重复 normalize 得到相同 `eventId`；`createContextEvent` 走同一条派生规则，因此同一 `ContextEventInput` 重复构造得到相同 `eventId`。
- `pairId` 由 `pair:${openedEventId}` 派生（§8.2），不含时钟、随机数或序号。
- `dataDigest` 对规范化输入稳定；`JSON.stringify` 的键序由结构化输入构造顺序决定，实现必须显式按固定字段序构造待哈希对象，不得直接哈希来源对象。

## 13. 文件所有权与执行阶段

真实依赖拓扑决定执行**必须分三段**：W1 / W2 / W3 都要 import 阶段 0 的类型与查表，W4 要 import Lead 的 `index.ts`。因此不存在「W1–W4 同时开工」。

**阶段 0（Lead，前置 scaffold）**：落地并冻结 `src/types.ts`、`src/taxonomy.ts`、`src/errors.ts`；不写 `validation.ts`。`taxonomy.ts` **必须包含 §8.1 的六个配对查表函数**（`closeTypeOf` / `openTypeOf` / `pairRoleOf` / `isOpenerType` / `isCloserType` / `closedStatusOf`）与 `allowedStatusOf`。这是 W1 与 W3 能只依赖阶段 0 的前提，缺一即并发不成立。

| 阶段 | owner | 文件 | 依赖 |
|---|---|---|---|
| 0 scaffold | Lead | `src/types.ts`、`src/taxonomy.ts`（含 §8.1 查表与 `allowedStatusOf`）、`src/errors.ts` | 无 |
| 1 并发 | W1 `rules` | `src/validation.ts` | 阶段 0 |
| 1 并发 | W2 `transform` | `src/normalize.ts`（含 `createContextEvent` + 4 适配器）、`src/pairing.ts`、`src/node-modules.d.ts` | 阶段 0 |
| 1 并发 | W3 `project` | `src/projector.ts`、`src/compact.ts` | 阶段 0 |
| 2 wire | Lead | `src/index.ts`、`tests/context-events/tsconfig.json`、根 `package.json`、本 doc、`docs/dagpipe/context-events.graph*.json` | 阶段 1 |
| 3 tests | W4 `tests` | `tests/context-events/context-events.test.ts` | 阶段 2（需 `index.ts` 导出面） |

阶段 1 的三个 worker 写入范围互不重叠，且各自只依赖阶段 0，**可真正并发**。关键前提是配对查表在阶段 0：若把它留在 `pairing.ts`，W1 的 §11 第 12/13 项与 W3 的 §10.1 `nextAction` 都必须 import W2，并发立即不成立。投影与 compact 只读 `event.status` / `event.pairing`，不 import `pairing.ts`（§8.2）。

W4 必须等阶段 2 完成（`index.ts` 是它的唯一入口），因此串行。

任何 worker 不得修改他人文件。接口改动必须先改本 doc 并通知 Lead。W1 只写 `validation.ts`，不重复实现阶段 0 已冻结的表。

## 14. 测试与 gate

```sh
# 定向
tsc -p tests/context-events/tsconfig.json
node --test dist/tests/tests/context-events/context-events.test.js

# 类型与治理
pnpm typecheck
pnpm dagpipe:validate
```

`tests/context-events/tsconfig.json` 与 `tests/core/tsconfig.json` 同构：`rootDir: "../.."`、`outDir: "../../dist/tests"`、`include` 覆盖 `**/*.ts`、`../../packages/context-events/src/**/*.ts`、`../../packages/contracts/src/**/*.ts`。测试用相对路径导入（`../../packages/context-events/src/index.js`），不使用路径别名。

`include` **不覆盖 `packages/runtime`**，因此测试不得 `import` runtime 的 `EventRecord` / `EventEnvelope` 类型（那会同时违反本模块「不依赖 runtime」的硬约束）。测试的输入用 `index.ts` 导出的 `EventRecordLike` / `AgentEventLike` / `AgentSemanticEventLike` / `ProviderEventLike` **结构化构造**，其字段与真实类型逐字段兼容（§9），这已足以构成「真实结构输入」的黑盒边界。

根 `package.json` 增加：

```json
"test:context-events": "tsc -p tests/context-events/tsconfig.json && node --test dist/tests/tests/context-events/context-events.test.js"
```

并把它加入聚合 `test` 脚本链。

黑盒验收边界：本模块是库，无独立 UI。真实 consumer 用最小 harness 贯穿公开边界（`index.ts` 导出面）。验收**必须走两条真实入口**，缺一不可：

1. **适配器入口**：用 §9 的结构化接口构造输入 → `normalize*` → `applyPairingOutcome` → 投影 / compact，断言 canonical 事件、pairing 索引、UI narrative、memory digest、compact snapshot 的外部可观察输出。覆盖 §9.4 表中「适配器规则 ✓」的 **6 个**类型。测试**自行供给**结构化输入，因此不依赖上游当前是否真有生产者（例：`blocker.detected` 的规则由 `provider.attention` 输入触发，即使 `ProviderEventKind 'attention'` 当下无生产者）。
2. **构造入口**：用 `createContextEvent` 直接构造 §9.4 表中「适配器规则 ✗」的类型（`plan.*`、`retry.*`、`task.created`、`task.confirmed`、`error.resolved`、`blocker.resolved`、`checkpoint.reentered`、`context.compacted`），再走同一 `applyPairingOutcome` → 投影 / compact 链路，断言配对闭合、`status` 改写、digest 分支与 compact 成对保留。

两条入口都必须被覆盖，因为 §9.4 已声明 **12** 个类型的合法产生路径只有构造入口；只测适配器入口会留下未验证的契约分支。

第 11 节的用例分两类，都属本模块的黑盒断言面：第 1–21 项是**抛错用例**（调用 `index.ts` 导出的校验函数并断言抛 `ContextEventError`）；第 22–23 项是**输出不变量**（断言产物性质，不期望抛错）。本条禁止的是断言内部实现结构、私有字段或源码文本。

**测试有效性要求（不是「全绿」就算通过）**：`pnpm test:context-events` 全绿只说明当前实现不被测试否决。gate 还要求测试对**关键映射与不变量**具备检出能力，即改坏一处实现要让对应用例变红。Lead 在候选上用人工变异抽查了关键分支（记录见 §16.1）；只增不减地保留这些断言，不得为让实现通过而放宽。其中一条**必须**覆盖：`toMemoryDigest` 的 digest 分支归属要在**受限 `summaryBudgetBytes`** 下断言，否则「事件被 summary 顺带消费」会掩盖「事件未被任一 digest 字段收录」的真实缺陷（`plan.rejected` 的 `priority` 为 2，默认预算下两者不可区分）。

## 15. DAG 与 owner 迁移

`docs/dagpipe/context-events.graph.json` 保持 5 节点 SESE 拓扑（`event_source → normalize → pairing → projector → consume`），输出 id 为 `user_view_and_memory_digest`。实现落地后，binding 的 `ownerPath` 从设计文档迁移到真实模块文件：

`graph.json` 与 `graph.binding.json` 分工不同：前者承载拓扑（设计产物，本次**未修改**），后者承载 `ownerPath` 绑定（本次**已迁移**）。`graph.json` 的 `meta.baseline` 是设计成文时的基线记录，不是 gate——`dagpipe graph validate` 不校验它，全仓十余个 graph 的 `baseline` 均为各自成文时的提交（多数早于当前 HEAD），保留原值即可，不得把它当作完整性门禁逐轮刷新（见「校验消融」）。

| node | 实现后 ownerPath |
|---|---|
| `event_source` | `packages/context-events/src/normalize.ts` |
| `normalize` | `packages/context-events/src/normalize.ts` |
| `pairing` | `packages/context-events/src/pairing.ts` |
| `projector` | `packages/context-events/src/projector.ts`（同节点责任含 `packages/context-events/src/compact.ts`） |
| `consume` | `packages/context-events/src/index.ts` |

四处刻意的图-文件对应关系，避免误读：

1. **`event_source` 与 `normalize` 同 owner**：`event_source` 表达输入边界（接收已提交的原始事件流**以及领域 owner 的显式构造**），`normalize` 表达逻辑（`createContextEvent` + 四个适配器）。两者都是 `normalize.ts` 的职责面，不是重复节点。
2. **`compact` 折入 `projector` 节点**：`compact.ts` 与 `projector.ts` 同属「生成投影」这一节点职责，是同一 SESE 节点内的两种投影输出。图不单列 `compact`，以保持单源单汇；`compact.ts` 仍是独立文件（§5），并与 `projector.ts` 同属 `projector` 节点的责任范围。
3. **`consume` 是模块的导出边界**：`consume` 节点的 ownerPath 是 `packages/context-events/src/index.ts`——本模块的唯一公开导出面，与输出 id `user_view_and_memory_digest` 一致。两类消费者都经它消费：UI narrative（§10.1）给 UI 渲染层，memory digest（§10.2）给 memory agent。本图的终点到此为止；UI 渲染与 memory agent 内部的下游链路不属本图，各自另有 owner。
4. **compact 的消费者在图外**：`CompactSnapshot`（§10.3）的消费者是 Context Compaction，它消费 `consume` 节点的产物但不改变本图拓扑；与第 3 条同理，图只到事实层边界。

## 16. 下一步

| 步骤 | 状态 |
|---|---|
| 1. 本文独立 review PASS | 已完成（5 轮，末轮 PASS） |
| 2. 阶段 0：Lead 落地并冻结 `types.ts` / `taxonomy.ts` / `errors.ts` | 已完成 |
| 3. 阶段 1：W1 / W2 / W3 并发实现（第 13 节隔离，写入范围互不重叠） | 已完成（含 W2 第二轮消融：`node:crypto`、`closedStatusOf` 单一真源、`dataDigest` 口径、删除就地自检） |
| 4. 阶段 2：Lead 完成 `index.ts`、tsconfig、`package.json`、dagpipe binding 迁移 | 已完成 |
| 5. 阶段 3：W4 写测试并通过第 14 节 gate | 已完成（**143** 例，`pnpm test:context-events` exit 0；Lead 做过变异测试验收，见 §16.1） |
| 6. 独立架构 review 绑定候选 SHA | 已完成（task-12 在 `80b0bd7` 上 **PASS**；task-15 在 `55eb847` 上增量复审 **PASS**；task-16 在 `3479df4` 上文档增量确认 **PASS**；task-17 在 `2d48844` 上复核 FAIL→修复后复核。四轮均零 BLOCKER。**finding 计数以 §16.2 表格行数为唯一真源：17 条 ISSUE（A–Q）+ 3 条 ADVISORY，另加 W4 补测发现的 O2**） |
| 7. 按 review 结论修复并补测试 | 已完成（ISSUE-A / B / E / F / G / H 已处置，ISSUE-C / D 补测试；W4 在补测中追加发现的 O2 同属 ISSUE-E 类，已修并锁死） |
| 8. 集成、候选自检与交付收口 | 进行中（组合最新 `origin/main`、最终 gate、merge 与 push） |

### 16.2 独立架构 review 结论与处置（跨 task-12 / 15 / 16 / 17 四轮）

reviewer-design 在候选 `80b0bd7` 上给出 **PASS**（零 BLOCKER）。它同时复跑了 gate、逐文件 blob 核对了候选迁移，并做了自己的差分与变异探针。逐项处置：

| 编号 | 类别 | 结论 | 处置 |
|---|---|---|---|
| — | 依赖上限 / 唯一 owner / `index.ts` 导出面 / 文档一致性 / 测试黑盒性 | PASS | 无需改动 |
| ISSUE-A | 文档 | provider-event 表的 `kind === 'model' \| 'output'` 行被一段正文与表格隔开，渲染时丢行 | 已修：该行移回表内 |
| ISSUE-B | 文档 | §16 记 124 例，实际 130 | 已修 |
| ISSUE-C | 测试有效性 | `compact.ts` 的 `retained.sort(compareCandidates)` 零覆盖；变异 `sort(() => 0)` 存活，且合法输入上顺序真的会变 | 已补 3 例（priority / occurredAt / eventId 三级排序键各一，用 `deepEqual` 断言精确 `eventId` 序列）。Lead 独立复验：该变异现在被 3 例杀死 |
| ISSUE-D | 测试有效性 | §9.5 的 digest 字段集合与字段序未锁死（去掉 `cost` / `evidenceRefs` / `supersededByEventId`、把 `status` 加进哈希均存活） | 已补 golden digest 用例（期望值用 `node:crypto` 按文档字段序独立重建）。Lead 独立复验：去掉 `cost` 现在被 3 例杀死 |
| ISSUE-E | **代码** | §9.5 要求被哈希的是**重建**后的规范化对象、§12 禁止直接哈希来源对象，但实现只重建了 `scope`，`evidenceRefs` 与 `cost` 按引用参与哈希 → 同一事实在不同嵌套键序下得到不同 `dataDigest` | 已修：`evidenceRefs` 元素、`cost` 均按固定字段序重建；§9.5 写明「重建递归适用于所有嵌套对象」及三层嵌套键序 |
| O2（W4 补测中发现） | **代码** | 同类的最后一处：`evidenceRefs[].evidenceId` 是 `ScopedId` 对象，仍按引用哈希 | 已修：`ScopedId` 的两个出现位置（`ScopeRef` 四槽位、`evidenceRefs[].evidenceId`）统一走同一个 `scopedIdForDigest`，使「漏掉任一位置」在结构上不可能；§9.5 写明该统一要求。已补用例逐个锁死两处 |
| ISSUE-F | 契约边界 | `status === 'superseded'` 且带 `pairing` 的事件能通过 `validateCanonicalContextEvent`，此时 compact 会让同一 `eventId` 同时进 `retained` 与 `omitted` | 已按「不为不可达场景增加校验层」处置：**不改代码**，在 §8.2 显式声明「superseded 事件不携带 `pairing`」为下游投影的前提，并说明 §10.3 已要求输入是本函数输出、故该组合属契约外输入 |
| ISSUE-G | 错误类型（task-15 发现） | 摘要规范化（§9.5 要求重建嵌套对象，必然读取 `scope.organId` / `evidenceRef.evidenceId`）在校验**之前**运行，因此解引用失败的畸形 `scope` / `evidenceRefs` / `cost` 由原生 `TypeError` 而非 `ContextEventError` 终止 | 已按「不为不可达场景增加校验层」处置：**不改代码**，在 §9.1 写明该承诺的精确边界与判据（`sourceId` / `occurredAt` 抛 `ContextEventError`；解引用失败者抛原生 `TypeError`，仍是显式 fail-fast）。§11 入口的覆盖范围与两个已知缺口（`cost === null`、元素嵌套 scope 槽位）也一并写明 |
| ISSUE-H | 文档 | §16 第 6 行的 finding 计数与 §16.2 表格不符 | 已修：改为与表格一致的计数。原数字来自 task-12 报告表头的笔误，被原样继承 |
| ISSUE-I | 文档（task-16 发现） | §9.1 的主词「`scope` 与 `evidenceRefs` 的类型外形状」比实现**宽**：字段级类型外取值（`evidenceRefs[].kind` / `source` / `locator` / `digest` 非法、`scope.organId` 缺 `value`）仍抛 `ContextEventError`；且括号列举不完备 | 已修：§9.1 改为先给**判据**，再列举典型形状并**明确标注列举不完备**，且单列「取值非法但结构存在 → 仍抛 `ContextEventError`」一类。Lead 已独立复验 |
| ISSUE-J | 文档（task-16 发现） | §9.1 完全没提 `cost`。`cost === null` 在 `createContextEvent` **和** `validateCanonicalContextEvent` 上都抛原生 `TypeError`，是**唯一**一个 §11 入口不抛 `ContextEventError` 的形状（既有行为，非本次引入）；而 `cost` 非对象（`5`）不抛错 | 已修：§9.1 明确 `cost === null` 是该唯一例外并标注为既有行为；`cost` 非对象不抛错、摘要表示为 `{}` 也一并记录 |
| ISSUE-K | 文档（task-16 发现） | §16 第 6 行与 ISSUE-H 处置行都写「1 条 ADVISORY」，而 §16.2 表格有 2 条 ADVISORY 行 | 已修 |
| ISSUE-L | 文档（task-17 发现） | §9.1 用「同样是既有行为」同时指代两件事：`cost` 非对象**不抛错**（既有）与摘要表示为 `{}`（**本变更新引入**） | 已修：§9.1 把两者分开表述，明确只有「不抛错」是既有行为，摘要表示变化由本变更新引入 |
| ISSUE-M | 文档（task-17 发现） | §9.1 的「共 14 种」被读作穷尽清单，而判据本身是通用的；归一化网格实测有数十种形状落入该类 | 已修：§9.1 改为**判据优先**，形状列举标注为「典型形状……**此列举不完备**」并给出网格反例 |
| ISSUE-N | 文档（task-17 发现） | §9.1 小标题「结构缺失或为 `null` → 原生 `TypeError`」过宽：`evidenceRefs` 缺失 / `undefined` / `null` 由 `?? []` 兜底**不抛错**，`cost` 缺失也不抛错 | 已修：§9.1 单列一条说明这两个字段整体缺失/为 `null` 不进入该类，只有 `scope` 因无兜底而抛 `TypeError` |
| ISSUE-O | 文档（task-17 发现） | §9.1 称 §11 入口「未受影响」易被读作可靠兜底，但 `evidenceRefs[].scope.{taskId,cycleId,operationId}` 为 `null`（或 `""` / `0` / `false`）时构造入口抛 `TypeError` 而 `validateCanonicalContextEvent` **不拦**（contracts `assertEvidenceRef` 用真值判断） | 已修：§9.1 明确该入口覆盖第一类的**大部分**而非全部，并列出两个已知缺口（`cost === null`、元素嵌套 scope 槽位），同时说明二者均为**既有行为**、本变更未改 `validation.ts`，且明确「该入口不是类型外输入的可靠兜底」 |
| ISSUE-P | 文档（task-17 发现，**构成 FAIL**） | §16 第 6 行写「2 条 ADVISORY」，而 §16.2 实有 3 条；ISSUE-K 刚声明「计数与表格一致」后同一提交内再次失效（同类缺陷第三次复发） | 已修：§16 第 6 行改为与表格一致，并改为**按 §16.2 表格行数核对**后再写 |
| ISSUE-Q | 文档（task-17 发现） | §16.2 标题仍写「（task-12）」，而该表已跨三轮；ISSUE-G 行仍保留修正前的宽口径 | 已修：标题改为跨三轮；ISSUE-G 行改写为与 §9.1 修正后的边界一致 |
| ADVISORY | 透明性（task-16 建议） | §16.3 记「变异回放 20 条，`survived = 0`」，但该轮 `PC-2`（`allowedStatusOf` 丢掉 `SUPERSEDED_STATUS`）首轮为 **SKIP**（变异串与编译产物不匹配），改用真实编译文本重放后才 KILLED | 已补记于 §16.3，避免读者误以为 20 条在同一轮被评估 |
| ADVISORY | 消融 | `projector.ts` 的 `case 'plan.proposed'` 中 `consumed.add(rejection.eventId)` 是否属重复登记 | review 独立差分（312 个合法场景，0 差异）后裁定**保留**：它与 `case 'plan.rejected'` 的登记语义不同（前者是「本分支产出的引用必须被消费」，后者是「本事件进入 decisions」），使 `plan.proposed` 分支局部自洽，不是同一语义的双路径 |
| ADVISORY | 类型外输入 | `cost` 传非对象（如 `5`）不抛错，其摘要表示由 `"cost":5` 变为 `"cost":{}` | 类型外输入，合法域无影响；不增加校验层（理由同 ISSUE-G）。已随 ISSUE-G 的边界说明一并记录 |

### 16.3 第二轮（task-15）增量复审的关键证据

reviewer-design 在 `55eb847` 上复跑 gate（`pnpm typecheck` / `pnpm test:context-events` **143/143** / `pnpm dagpipe:validate` 16 graphs，全部 exit 0），并做了**独立于 Lead 的**验证：

- **修复完整性**：对重建后的哈希对象做结构遍历，出现的对象形状只有 6 类（顶层、`scope`、`ScopedId`、`EvidenceRef`、`EvidenceRef.scope`、`cost`），**无未归类对象**；深层与逐层反键序摘要全部不变，逐叶子取值扰动摘要全变。
- **变异回放 20 条，`survived = 0`**：`evidenceRefs` / `cost` / `evidenceId` / `evidenceRefs[].scope` / 四个 `scope` 槽位各自改回按引用 —— 全部 KILLED；`D-2`…`D-8`（去 `evidenceRefs`、去 `supersededByEventId`、加 `status`、顶层重排、`cost` 提前、`cost` 内部键序、`evidenceRef` 字段序）全部 KILLED。还原后逐文件字节核对一致。**注**：20 条中的 `PC-2`（`allowedStatusOf` 丢掉 `SUPERSEDED_STATUS`）首轮为 **SKIP** —— 变异串与编译产物不匹配（`occurrence = 0`），并非「存活」；改用真实编译文本重放后 KILLED（134/9）。`survived = 0` 对全部 20 条成立。
- **取值变化的精确界定**：**规范键序输入在 `80b0bd7` 与 `55eb847` 上摘要完全相同**；只有非规范嵌套键序的输入摘要才改变。即「摘要值变化」只落在修复目标本身，不是面扩散。
- **无回归**：126 个合法场景 `onlyDigestChanged = 0`；公开面 30 个导出与函数 arity 无变化；仓库内无 `packages/context-events` 外部导入者、无 `dataDigest` 消费者。
- **O2 复现**：用「只把 `evidenceId` 改回按引用、其余保持修复后」的中间态代码**精确复现**了 O2 记录的两个修复前摘要，并以 `shasum -a 256` 对该 fixture 的规范 JSON 做第三次独立复核。

**关于 ISSUE-E / O2 的意义**：这两条不是「测试没覆盖」而是**实现确实不符合 §9.5/§12**。若只按 §12 字面核对 `scope` 一处就收口，`dataDigest` 会在嵌套键序变化时漂移，而 `dataDigest` 是「同一事实的稳定身份」——配对前后不变这条不变量正是建立在它稳定之上的。修复后该不变量对**任意键序写法**成立。

### 16.1 Lead 的变异测试验收（测试有效性证据）

`pnpm test:context-events` 全绿只证明「当前实现不被测试否决」，不证明「测试能发现缺陷」。Lead 因此在候选上做了 9 次人工变异（mutation），每次只改一处实现、其余不动，重编译后跑测试，再逐字还原（已用 `cmp` 核对 10 个源文件与变异前逐字节一致）：

| # | 变异（`packages/context-events/src/`） | 被杀死 | 杀死的用例 |
|---|---|---|---|
| 1 | dsh 方言裸 `tool` 改为 `mapped('operation.started')` | ✅ 3 | §9.2 dsh 关键回归、UnmappedSource 三值、未映射显式登记 |
| 2 | `terminalOutcome` 删掉 `succeeded → operation.completed` | ✅ 7 | 四条终态路径的 terminal 用例、关键回归 |
| 3 | §8.2 `retry.exhausted` 改写目标改为 `resolved` | ✅ 2 | `closedStatusOf` 逐行、`applyPairingOutcome` 8 行改写表 |
| 4 | `digestOfConstructedEvent` 用原始 `input.summary` 而非解析后值 | ✅ 1 | §9.5「`summary` 省略 == 显式 `labelOf`」 |
| 5 | compact 成对分组改为逐条 `keepSingle`（拆散配对） | ✅ 1 | §10.3 成对保留/成对丢弃不变量 |
| 6 | `DIGEST_OMIT_REASONS` 加入 `'pair'` | ✅ 1 | §11 `validateMemoryContextDigest` 拒绝 `'pair'` |
| 7 | **删掉 `projector.ts` `case 'plan.rejected'` 的 `consumed.add`** | ❌ **存活（已修）** | — |
| 8 | `nextAction` 去掉 `status === 'active'` 前置 | ✅ 2 | §10.1 未配对 `operation.failed` / 已配对打开事件 |
| 9 | compact 中 superseded 的 `reason` 改为 `'budget'` | ✅ 1 | §10.3 superseded 不参与保留 |

**第 7 项是真实覆盖漏洞，已修复**：`plan.rejected` 的 `priority` 为 2，天然参与 `summary`；在默认 `summaryBudgetBytes = 2048` 下，summary 循环恰好把它消费掉，于是 `omitted` 自然为空 —— 原测试无法区分「靠 summary 顺带消费」与「靠 switch 分支显式消费」。实测在 `summaryBudgetBytes: 0` 时该变异使同一 `eventId` **同时出现在 `decisions` 与 `omitted`**，正是 §10.2 `omitted` 定义（「未进入上述任一 digest **字段**的事件」）所禁止的。修复方式是在测试中补入**受限 summary 预算**下的断言，使「删掉任一 digest 分支的 `consumed.add`」可被杀死；实现本身无缺陷，改动只在测试侧。
