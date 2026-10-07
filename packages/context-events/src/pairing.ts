/**
 * Context Events —— 配对：索引、`status` 改写、配对结果一致性校验（§8.2）。
 *
 * 设计契约：docs/architecture/context-events.md §8 / §8.2 / §11 第 16–20 项 / §12。
 *
 * 职责边界：
 * - `applyPairingOutcome` 是 **`status` 改写的唯一 owner**（§8.2）。构造期初值归
 *   `normalize.ts` 的 `createContextEvent`，两者 owner 不重叠。
 * - 配对**查表**（`closeTypeOf` / `openTypeOf` / `pairRoleOf` / `isOpenerType` /
 *   `isCloserType` / `closedStatusOf` / `allowedStatusOf`）归阶段 0 的 `taxonomy.ts`，
 *   本文件只 import，不重写、不维护第二张表。
 * - 纯函数（§12）：不读时钟、不取随机数、不读环境变量、不读文件系统。
 *
 * 消费顺序（唯一合法，§8.2）：`applyPairingOutcome` → 投影 / compact。投影与 compact
 * 只读 `event.status` 与 `event.pairing`，不 import 本文件，因此两者与 W2 之间只有运行期顺序。
 */

import { ContextEventError } from './errors.js';
import {
  closedStatusOf,
  isCloserType,
  isOpenerType,
  openTypeOf,
  pairRoleOf,
} from './taxonomy.js';
import type {
  CanonicalContextEvent,
  ContextEventStatus,
  ContextEventType,
} from './types.js';

export interface PairingIndex {
  /** 参与配对的打开事件，按 `eventId` 索引（关闭事件的 `relatedEventId` 在这里解析）。 */
  readonly openedByEventId: ReadonlyMap<string, CanonicalContextEvent>;
  /** 打开事件 `eventId` → 引用它的关闭事件（输入顺序）。 */
  readonly closedByOpenedEventId: ReadonlyMap<string, CanonicalContextEvent[]>;
  /** 没有任何关闭事件引用的打开事件（输入顺序）。 */
  readonly unpairedOpen: readonly CanonicalContextEvent[];
}

/** §8.2：`pairId` 由打开事件的 `eventId` 确定性派生，不含时钟、随机数或序号。 */
function pairIdOf(openedEventId: string): string {
  return `pair:${openedEventId}`;
}

/**
 * §8.2 改写表在 `taxonomy.ts`（`closedStatusOf`，与 `PAIRING_RULES` 同表）。
 *
 * 每个关闭类型在 §8 配对表中恰好出现一次，因此该查表对已配对关闭事件**必然有值**；
 * `undefined` 只表示「该类型不是关闭类型」，在 `applyPairingOutcome` 里已被
 * `isCloserType` 前置排除。
 */
function requiredClosedStatus(closeType: ContextEventType): ContextEventStatus {
  const status = closedStatusOf(closeType);
  if (status === undefined) {
    throw new ContextEventError(`context event type ${closeType} is not a closing type`);
  }
  return status;
}

/**
 * §8.2 配对索引。
 *
 * - 输入必须已按 §12 去重且 `eventId` 唯一；重复 `eventId` 抛 `ContextEventError`。
 * - `status === 'superseded'` 的事件**不参与配对**（§8.2）：既不作为打开事件，也不作为关闭事件。
 * - 关闭事件按类型绑定到它**之前最近**的一个同类型打开事件（输入顺序即 §12 规范顺序）。
 *   绑定不消费打开事件：两个关闭事件可以引用同一个打开事件，这正是 §11 第 16/20 项要检出的
 *   不一致；`applyPairingOutcome` 不负责检出它，`assertPairingConsistent` 负责。
 */
export function buildPairingIndex(events: readonly CanonicalContextEvent[]): PairingIndex {
  const seenEventIds = new Set<string>();
  for (const event of events) {
    if (seenEventIds.has(event.eventId)) {
      throw new ContextEventError(`duplicate context event eventId: ${event.eventId}`);
    }
    seenEventIds.add(event.eventId);
  }

  const openedByEventId = new Map<string, CanonicalContextEvent>();
  const closedByOpenedEventId = new Map<string, CanonicalContextEvent[]>();
  const unpairedOpen: CanonicalContextEvent[] = [];
  const precedingOpen: CanonicalContextEvent[] = [];
  const pairedOpenEventIds = new Set<string>();

  for (const event of events) {
    if (event.status === 'superseded') continue;

    if (isOpenerType(event.type)) {
      openedByEventId.set(event.eventId, event);
      precedingOpen.push(event);
      continue;
    }
    if (!isCloserType(event.type)) continue;

    const expectedOpenType = openTypeOf(event.type);
    let opened: CanonicalContextEvent | undefined;
    for (let i = precedingOpen.length - 1; i >= 0; i -= 1) {
      const candidate = precedingOpen[i];
      if (candidate.type === expectedOpenType) {
        opened = candidate;
        break;
      }
    }
    if (opened === undefined) continue;

    pairedOpenEventIds.add(opened.eventId);
    const closers = closedByOpenedEventId.get(opened.eventId);
    if (closers === undefined) closedByOpenedEventId.set(opened.eventId, [event]);
    else closers.push(event);
  }

  for (const opened of precedingOpen) {
    if (!pairedOpenEventIds.has(opened.eventId)) unpairedOpen.push(opened);
  }

  return { openedByEventId, closedByOpenedEventId, unpairedOpen };
}

/**
 * §8.2：按配对索引返回**新数组**（不改输入）。
 *
 * - 为每个**已配对**的关闭事件补 `pairing.relatedEventId`（指向打开事件）与其 `pairId`。
 * - 把已闭合的打开事件从 `defaultStatus` 改写为 §8.2 改写表的终态，并补 `pairing`（`role: 'opened'`）。
 * - **未配对的关闭事件不分配 `pairing`**；**未配对的打开事件不分配 `pairId`**。
 * - **不触碰** `status === 'superseded'` 的事件，也不为它们分配 `pairing`。
 *
 * 一个打开事件被多个关闭事件引用是不一致输入（§11 第 16/20 项），本函数不抛错，
 * 只按输入顺序取**第一个**关闭事件的改写目标，保持确定性；一致性由
 * `assertPairingConsistent` 判定。
 */
export function applyPairingOutcome(
  events: readonly CanonicalContextEvent[],
): readonly CanonicalContextEvent[] {
  const index = buildPairingIndex(events);

  const openedByCloserEventId = new Map<string, CanonicalContextEvent>();
  for (const [openedEventId, closers] of index.closedByOpenedEventId) {
    const opened = index.openedByEventId.get(openedEventId);
    if (opened === undefined) continue;
    for (const closer of closers) {
      if (!openedByCloserEventId.has(closer.eventId)) openedByCloserEventId.set(closer.eventId, opened);
    }
  }

  return events.map((event) => {
    if (event.status === 'superseded') return event;

    if (isCloserType(event.type)) {
      const opened = openedByCloserEventId.get(event.eventId);
      if (opened === undefined) return event;
      const role = pairRoleOf(event.type);
      if (role === undefined) return event;
      return {
        ...event,
        pairing: { pairId: pairIdOf(opened.eventId), role, relatedEventId: opened.eventId },
      };
    }

    if (isOpenerType(event.type)) {
      const closers = index.closedByOpenedEventId.get(event.eventId);
      if (closers === undefined || closers.length === 0) return event;
      return {
        ...event,
        status: requiredClosedStatus(closers[0].type),
        pairing: { pairId: pairIdOf(event.eventId), role: 'opened' },
      };
    }

    return event;
  });
}

/**
 * §11 第 16–20 项：校验**配对结果**（不是单事件），全部抛 `ContextEventError`。
 *
 * 16. 同一打开事件被两个关闭事件引用（第 20 项是它的实例：`plan.accepted` 与 `plan.rejected`
 *     同时引用同一个 `plan.proposed`，不另立判据）。
 * 17. 关闭事件的 `relatedEventId` 指向不存在的打开事件。
 * 18. 关闭事件指向类型不兼容的打开事件（如 `error.resolved` 指向 `blocker.detected`）。
 * 19. `relatedEventId` 指向自身。
 *
 * 单事件形状（§11 第 9–15 项）归 `validation.ts`（W1），本函数不重复判定。
 * `status === 'superseded'` 的事件不参与配对，因此也不进入本判定（§8.2）。
 */
export function assertPairingConsistent(events: readonly CanonicalContextEvent[]): void {
  const eventsByEventId = new Map<string, CanonicalContextEvent>();
  for (const event of events) {
    if (eventsByEventId.has(event.eventId)) {
      throw new ContextEventError(`duplicate context event eventId: ${event.eventId}`);
    }
    eventsByEventId.set(event.eventId, event);
  }

  const closerEventIdsByOpenedEventId = new Map<string, string[]>();

  for (const event of events) {
    if (event.status === 'superseded') continue;

    const pairing = event.pairing;
    if (pairing === undefined || pairing.role === 'opened') continue;
    const relatedEventId = pairing.relatedEventId;
    if (relatedEventId === undefined) continue;

    if (relatedEventId === event.eventId) {
      throw new ContextEventError(`context event ${event.eventId} references itself as its opened event`);
    }

    const opened = eventsByEventId.get(relatedEventId);
    if (opened === undefined || opened.status === 'superseded' || !isOpenerType(opened.type)) {
      throw new ContextEventError(
        `context event ${event.eventId} references missing opened event ${relatedEventId}`,
      );
    }

    if (openTypeOf(event.type) !== opened.type) {
      throw new ContextEventError(
        `context event ${event.eventId} (${event.type}) cannot close ${opened.type} (${relatedEventId})`,
      );
    }

    const closerEventIds = closerEventIdsByOpenedEventId.get(relatedEventId);
    if (closerEventIds === undefined) closerEventIdsByOpenedEventId.set(relatedEventId, [event.eventId]);
    else closerEventIds.push(event.eventId);
  }

  for (const [openedEventId, closerEventIds] of closerEventIdsByOpenedEventId) {
    if (closerEventIds.length > 1) {
      throw new ContextEventError(
        `opened event ${openedEventId} is referenced by multiple closing events: ${closerEventIds.join(', ')}`,
      );
    }
  }
}
