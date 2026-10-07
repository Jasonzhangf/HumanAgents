/**
 * Context Events —— 投影：UI Narrative（§10.1）与 Memory Digest（§10.2）。
 *
 * 设计契约：docs/architecture/context-events.md §10.1 / §10.2 / §12。
 *
 * 消费顺序（唯一合法，§8.2）：`applyPairingOutcome` → 投影。本模块**只读**
 * `event.status` 与 `event.pairing`，**不 import `pairing.ts`**：W3 与 W2 之间只有
 * 运行期顺序，没有编译期依赖，阶段 1 并发因此成立。
 *
 * `pairing` 由 `applyPairingOutcome` 独占赋值（§9.3）。未配对事件（含未配对的关闭事件）
 * 与 `status === 'superseded'` 的事件**没有** `pairing`，所有读取都先判 `undefined`。
 *
 * 纯函数（§12）：不读时钟、不取随机数、不读环境变量、不读文件系统。
 */

import {
  closeTypeOf,
  isOpenerType,
  labelOf,
  narrativeOf,
  priorityOf,
} from './taxonomy.js';
import type {
  BlockerDigest,
  CanonicalContextEvent,
  ContextEventStatus,
  DecisionDigest,
  FailureRepairDigest,
  MemoryContextDigest,
  OmittedReason,
  RejectedPlanDigest,
  UserNarrativeEvent,
} from './types.js';

/** §10.2 `summaryBudgetBytes` 默认值。 */
const DEFAULT_SUMMARY_BUDGET_BYTES = 2048;

/** §10.2 summary 的事件连接符。 */
const SUMMARY_SEPARATOR = ' / ';

/**
 * §10.1 `nextAction` 在多个关闭类型时的连接符。设计稿只写「连接」未写符号；
 * 这里复用 §10.2 的 `SUMMARY_SEPARATOR`，避免引入第二套约定。
 */
const NEXT_ACTION_SEPARATOR = SUMMARY_SEPARATOR;

/** §10.2 summary 预算按 UTF-8 字节度量。 */
const UTF8_ENCODER = new TextEncoder();

function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

type NarrativeState = UserNarrativeEvent['state'];

/**
 * §10.1 state 映射。`superseded` 不输出，故不在表内；`needs-user` 由 attention 覆盖规则给出。
 */
const STATE_BY_STATUS: Readonly<
  Record<Exclude<ContextEventStatus, 'superseded'>, NarrativeState>
> = {
  active: 'happening',
  completed: 'happened',
  failed: 'failed',
  resolved: 'resolved',
  rejected: 'happened',
};

/**
 * §12 规范输入排序键：`occurredAt` 升序 → `priorityOf(type)` 升序 → `eventId` 升序。
 *
 * `priority` 由 `type` 派生（`CanonicalContextEvent` 没有 `priority` 字段）。
 * 返回新数组，不改输入。
 */
export function sortEvents(events: readonly CanonicalContextEvent[]): CanonicalContextEvent[] {
  return [...events].sort(compareCanonicalEvents);
}

function compareCanonicalEvents(a: CanonicalContextEvent, b: CanonicalContextEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  const byPriority = priorityOf(a.type) - priorityOf(b.type);
  if (byPriority !== 0) return byPriority;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

/**
 * §10.1 UI Narrative。
 *
 * - `status === 'superseded'` 的事件不输出。
 * - `state`：`active`→`happening`、`completed`→`happened`、`failed`→`failed`、
 *   `resolved`→`resolved`、`rejected`→`happened`；
 *   `narrativeOf(type) === 'attention' && status === 'active'` 时覆盖为 `needs-user`。
 * - `title` = taxonomy `label`；`detail` = 事件 `summary`。
 * - `nextAction`：仅当 `isOpenerType(type) && status === 'active'` 时给出，
 *   取 `closeTypeOf(type)` 各关闭类型的 `label` 连接。判据是「status 仍为 `active` 的
 *   打开类型」，不是「已打开且未被配对闭合」：`operation.failed` 的默认 status 是
 *   `failed`，它即使未配对也不给出 `nextAction`。
 * - 输出顺序与输入顺序一致（输入须已按 §12 排序）。
 */
export function toUserNarrative(events: readonly CanonicalContextEvent[]): UserNarrativeEvent[] {
  const narrative: UserNarrativeEvent[] = [];
  for (const event of events) {
    if (event.status === 'superseded') continue;
    const state: NarrativeState =
      narrativeOf(event.type) === 'attention' && event.status === 'active'
        ? 'needs-user'
        : STATE_BY_STATUS[event.status];
    const nextAction =
      isOpenerType(event.type) && event.status === 'active'
        ? closeTypeOf(event.type).map(labelOf).join(NEXT_ACTION_SEPARATOR)
        : undefined;
    narrative.push({
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      state,
      title: labelOf(event.type),
      detail: event.summary,
      ...(nextAction === undefined ? {} : { nextAction }),
      evidenceRefs: event.evidenceRefs,
    });
  }
  return narrative;
}

/** §10.2 Memory Digest 选项。 */
export interface MemoryDigestOptions {
  readonly summaryBudgetBytes?: number;
}

/**
 * §10.2 Memory Digest。
 *
 * - `decisions`：`task.confirmed`（`confirmed`）、`plan.accepted`（`accepted`）、
 *   `plan.rejected`（`rejected`）。
 * - `failures`：每个 `error.detected` 一条，`resolutionEventId` 取其配对的 `error.resolved`。
 * - `rejectedPlans`：每个**被否决的** `plan.proposed` 一条（anchor 是提案，与
 *   `failures` / `blockers` 对称）：`proposalEventId` = 提案 `eventId`，`occurredAt` /
 *   `summary` 取提案，`rejectionEventId` 取其配对的 `plan.rejected`。未配对的
 *   `plan.proposed` 与未配对的 `plan.rejected` 都不输出该行：前者因未进任何 digest
 *   字段而落 `omitted`（`reason: 'budget'`；其 `priority` 为 3，本就不参与 `summary`），
 *   后者已进 `decisions`，故不进 `omitted`（见下）。
 * - `blockers`：每个 `blocker.detected` 一条，`resolutionEventId` 取其配对的 `blocker.resolved`。
 * - `summary`：按 §12 顺序取 `priorityOf(type) <= 2` 的 `summary`，用 `' / '` 连接，
 *   按 `summaryBudgetBytes` 在事件边界截断（不切半个事件）。
 * - `omitted`：**未进入上述任一 digest 字段**（`decisions` / `failures` / `rejectedPlans` /
 *   `blockers` / `summary`）的事件。`reason` 只能是 `'superseded'`（被取代）或
 *   `'budget'`；`'budget'` 是该 union 中唯一的「非取代」取值，涵盖所有未被任一 digest
 *   字段收纳的情形（含 summary 预算不足、`priorityOf > 2` 不参与 summary、类型不在任何
 *   digest 分支内），**不是**仅指 summary 预算不足。
 *   因此未配对的 `plan.rejected` 已进 `decisions`，**不**进 `omitted`。
 *   **`'pair'` 只属 compact（§10.3），本函数永不产出。**
 * - `status === 'superseded'` 的事件不进入任何 digest 分支。
 */
export function toMemoryDigest(
  events: readonly CanonicalContextEvent[],
  options?: MemoryDigestOptions,
): MemoryContextDigest {
  const summaryBudgetBytes = options?.summaryBudgetBytes ?? DEFAULT_SUMMARY_BUDGET_BYTES;
  const ordered = sortEvents(events);

  // 配对反查：打开事件的 `pairing` 只有 `pairId`（§11 第 10 项禁止 `role === 'opened'`
  // 带 `relatedEventId`），因此只能从关闭事件侧建立 openedEventId → 关闭事件 的索引。
  // 同一打开事件被多个关闭事件引用是 §11 第 16 项的非法输入（owner 是
  // `assertPairingConsistent`，W2）；此处按首个确定性取值，不重复实现该校验。
  const closerByOpenedEventId = new Map<string, CanonicalContextEvent>();
  for (const event of ordered) {
    const pairing = event.pairing;
    if (pairing === undefined) continue;
    if (pairing.role === 'opened') continue;
    const relatedEventId = pairing.relatedEventId;
    if (relatedEventId === undefined) continue;
    if (!closerByOpenedEventId.has(relatedEventId)) {
      closerByOpenedEventId.set(relatedEventId, event);
    }
  }

  const decisions: DecisionDigest[] = [];
  const failures: FailureRepairDigest[] = [];
  const rejectedPlans: RejectedPlanDigest[] = [];
  const blockers: BlockerDigest[] = [];
  const consumed = new Set<string>();

  for (const event of ordered) {
    if (event.status === 'superseded') continue;
    switch (event.type) {
      case 'task.confirmed':
        decisions.push({
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          summary: event.summary,
          outcome: 'confirmed',
        });
        consumed.add(event.eventId);
        break;
      case 'plan.accepted':
        decisions.push({
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          summary: event.summary,
          outcome: 'accepted',
        });
        consumed.add(event.eventId);
        break;
      case 'plan.proposed': {
        // §10.2：`rejectedPlans` 的 anchor 是**提案**（与 `failures` / `blockers` 对称）。
        // 只有「配对关闭事件为 `plan.rejected`」的被否决提案输出一条；`plan.accepted`
        // 不是否决事实，因此配对为采纳的提案不产出该行。
        const rejection = closerByOpenedEventId.get(event.eventId);
        if (rejection !== undefined && rejection.type === 'plan.rejected') {
          rejectedPlans.push({
            proposalEventId: event.eventId,
            rejectionEventId: rejection.eventId,
            occurredAt: event.occurredAt,
            summary: event.summary,
          });
          consumed.add(event.eventId);
          consumed.add(rejection.eventId);
        }
        break;
      }
      case 'plan.rejected': {
        // §10.2：`plan.rejected` 进 `decisions`（outcome `'rejected'`），不受 anchor 迁移影响。
        decisions.push({
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          summary: event.summary,
          outcome: 'rejected',
        });
        // 它**已经进入** `decisions` 这个 digest 字段，因此按 §10.2 的 `omitted` 定义
        // （「未进入上述任一 digest 字段的事件」）不属于 `omitted`。已配对的否决另由
        // `plan.proposed` 分支引用为 `rejectionEventId`。
        // 未配对的 `plan.rejected` 没有可指认的提案（§8.2：未配对的关闭事件不分配
        // `pairing`），故不产出 `rejectedPlans` 行，也不出现在 `omitted` 里。
        consumed.add(event.eventId);
        break;
      }
      case 'error.detected': {
        const resolution = closerByOpenedEventId.get(event.eventId);
        failures.push({
          failureEventId: event.eventId,
          occurredAt: event.occurredAt,
          summary: event.summary,
          ...(resolution === undefined
            ? {}
            : {
                resolutionEventId: resolution.eventId,
                resolutionSummary: resolution.summary,
              }),
        });
        consumed.add(event.eventId);
        if (resolution !== undefined) consumed.add(resolution.eventId);
        break;
      }
      case 'blocker.detected': {
        const resolution = closerByOpenedEventId.get(event.eventId);
        blockers.push({
          blockerEventId: event.eventId,
          occurredAt: event.occurredAt,
          summary: event.summary,
          ...(resolution === undefined
            ? {}
            : {
                resolutionEventId: resolution.eventId,
                resolutionSummary: resolution.summary,
              }),
        });
        consumed.add(event.eventId);
        if (resolution !== undefined) consumed.add(resolution.eventId);
        break;
      }
      default:
        break;
    }
  }

  // summary 按 §12 顺序累积，超预算即截断（截断发生在事件边界）。
  let summary = '';
  for (const event of ordered) {
    if (event.status === 'superseded') continue;
    if (priorityOf(event.type) > 2) continue;
    const candidate =
      summary === '' ? event.summary : `${summary}${SUMMARY_SEPARATOR}${event.summary}`;
    if (utf8Bytes(candidate) > summaryBudgetBytes) break;
    summary = candidate;
    consumed.add(event.eventId);
  }

  const omitted: OmittedReason[] = [];
  for (const event of ordered) {
    if (consumed.has(event.eventId)) continue;
    omitted.push({
      eventId: event.eventId,
      reason: event.status === 'superseded' ? 'superseded' : 'budget',
    });
  }

  return { summary, decisions, failures, rejectedPlans, blockers, omitted };
}
