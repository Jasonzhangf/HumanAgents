/**
 * Context Events —— 冻结类型（阶段 0）。
 *
 * 设计契约：docs/architecture/context-events.md §6。
 *
 * 依赖上限（硬约束）：本包只允许 import packages/contracts。
 * packages/ui 只依赖 contracts，一旦本包引入 packages/runtime，UI 将无法消费。
 * 因此所有归一化输入都用结构化 *Like 接口表达（见 normalize.ts），而不是 runtime 类型。
 */

import type { EvidenceRef, ScopeRef } from '../../contracts/src/index.js';

/** v1 实际承载 18 个 type 的 4 个类目（见设计稿 §7 类目归属说明）。 */
export const CONTEXT_EVENT_CATEGORIES = ['task', 'plan', 'error', 'blocker'] as const;
export type ContextEventCategory = (typeof CONTEXT_EVENT_CATEGORIES)[number];

/** 18 个 canonical type，顺序即声明顺序。 */
export const CONTEXT_EVENT_TYPES = [
  'task.created',
  'task.confirmed',
  'operation.started',
  'operation.completed',
  'operation.failed',
  'error.detected',
  'error.resolved',
  'blocker.detected',
  'blocker.resolved',
  'checkpoint.committed',
  'checkpoint.reentered',
  'context.compacted',
  'plan.proposed',
  'plan.accepted',
  'plan.rejected',
  'retry.detected',
  'retry.recovered',
  'retry.exhausted',
] as const;
export type ContextEventType = (typeof CONTEXT_EVENT_TYPES)[number];

/** 1 = 关键，5 = 低。PreCompact 优先保留 1，优先丢弃 5。 */
export type ContextEventPriority = 1 | 2 | 3 | 4 | 5;

export type ContextEventStatus =
  | 'active'
  | 'completed'
  | 'failed'
  | 'resolved'
  | 'superseded'
  | 'rejected';

export type ContextEventNarrative =
  | 'progress'
  | 'decision'
  | 'failure'
  | 'recovery'
  | 'checkpoint'
  | 'attention';

/**
 * 配对角色。**只有 3 个值，不含 `'superseded'`**：取代不是配对关系，
 * 其唯一真源是 `status` + `supersededByEventId`（设计稿 §8）。
 */
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

/**
 * 构造入口的输入（设计稿 §9.3，冻结形状，不得增删字段）。
 *
 * **没有 `status` 字段**：构造期不接受调用方指定 status，否则 §8.2
 * 「`applyPairingOutcome` 是配对改写唯一 owner」被绕过。
 * status 初值只由 `supersededByEventId` 与 `defaultStatusOf(type)` 决定。
 */
export interface ContextEventInput {
  readonly type: ContextEventType;
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly scope: ScopeRef;
  readonly summary?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  /** 存在时 status 初值为 `'superseded'`（唯一合法取代路径）。 */
  readonly supersededByEventId?: string;
  readonly cost?: ContextEventCost;
}

/**
 * canonical 事件。**不含** `category` / `priority` / `narrative`——
 * 三者由 `type` 即时派生（taxonomy.ts），避免第二真源。
 * `status` 是唯一保留的状态字段。
 */
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
  /** 与 `status === 'superseded'` 互为充要条件（设计稿 §11 第 15 项）。 */
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
