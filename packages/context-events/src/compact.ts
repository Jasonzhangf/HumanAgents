/**
 * Context Events —— Compact Snapshot（§10.3）。
 *
 * 设计契约：docs/architecture/context-events.md §10.3 / §11 第 21–23 项 / §12。
 *
 * 消费顺序（唯一合法，§8.2）：`applyPairingOutcome` → compact。本模块**只读**
 * `event.status` 与 `event.pairing`，**不 import `pairing.ts`**：W3 与 W2 之间只有
 * 运行期顺序，没有编译期依赖，阶段 1 并发因此成立。
 *
 * `pairing` 由 `applyPairingOutcome` 独占赋值（§9.3）。未配对事件（含未配对的关闭事件）
 * 与 `status === 'superseded'` 的事件**没有** `pairing`，所有读取都先判 `undefined`。
 *
 * 纯函数（§12）：不读时钟、不取随机数、不读环境变量、不读文件系统。
 */

import { ContextEventError } from './errors.js';
import { isOpenerType, priorityOf } from './taxonomy.js';
import type { CanonicalContextEvent, CompactSnapshot, OmittedReason } from './types.js';

/** §10.3 compact 选项。 */
export interface CompactOptions {
  /** 必填，正整数（§11 第 21 项：非正整数抛 `ContextEventError`）。 */
  readonly budgetBytes: number;
  /** 必填，非空。 */
  readonly snapshotId: string;
  /** 默认 0；由调用方给定，不由本模块读取时钟或环境。 */
  readonly sourceWatermark?: number;
}

/**
 * §10.3 每条事件的尾部连接开销（字节）。
 *
 * 字节度量统一为 `new TextEncoder().encode(JSON.stringify(event)).length`；保留事件序列化
 * 成数组时每个元素后还有一个连接分隔符，故每条事件的实际占用再加此常量。
 * **固定为 1，测试锁死**；不得随输入、环境或时间变化。
 */
const EVENT_JOIN_OVERHEAD_BYTES = 1;

const UTF8_ENCODER = new TextEncoder();

function encodedBytes(event: CanonicalContextEvent): number {
  return UTF8_ENCODER.encode(JSON.stringify(event)).length + EVENT_JOIN_OVERHEAD_BYTES;
}

/**
 * §10.3 候选顺序：`priorityOf(type)` 升序 → `occurredAt` 升序 → `eventId` 升序。
 *
 * 与 §12 的**输入**排序键（`occurredAt` 优先）刻意不同：§12 定义规范输入顺序，
 * 本条定义压缩时的丢弃优先级，调用方不必为 compact 重排输入。
 */
function compareCandidates(a: CanonicalContextEvent, b: CanonicalContextEvent): number {
  const byPriority = priorityOf(a.type) - priorityOf(b.type);
  if (byPriority !== 0) return byPriority;
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

/**
 * §10.3 Compact Snapshot。
 *
 * - 候选顺序见 `compareCandidates`。
 * - **成对保留**：用 `event.pairing.pairId` 分组，打开事件与其关闭事件同进同出；
 *   预算容不下整组就整组不保留，`reason: 'pair'`。只有关闭事件命中候选、打开事件不在
 *   输入中时，该分组没有打开事件，按单条处理。
 * - 无 `pairing` 的事件按单条参与预算。
 * - `superseded` 不参与保留，`reason: 'superseded'`；预算装不下的单条 `reason: 'budget'`。
 * - `usedBytes` 为实际保留字节数，恒 `<= budgetBytes`（§11 第 22 项）。
 * - `retained` 保持候选顺序。
 * - 已知非单调取舍（§10.3 明示接受）：宁可整对丢弃，也不让 UI 看到没有修复记录的错误。
 */
export function compactContextEvents(
  events: readonly CanonicalContextEvent[],
  options: CompactOptions,
): CompactSnapshot {
  const budgetBytes = options.budgetBytes;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new ContextEventError(
      `compact budgetBytes must be a positive integer, got ${String(budgetBytes)}`,
    );
  }
  const snapshotId = options.snapshotId;
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    throw new ContextEventError('compact snapshotId must be a non-empty string');
  }
  const sourceWatermark = options.sourceWatermark ?? 0;

  const candidates = [...events].sort(compareCandidates);

  // pairId → 该配对分组的全部成员（只含带 `pairing` 的事件）。
  const pairMembers = new Map<string, CanonicalContextEvent[]>();
  for (const event of candidates) {
    const pairing = event.pairing;
    if (pairing === undefined) continue;
    const members = pairMembers.get(pairing.pairId);
    if (members === undefined) pairMembers.set(pairing.pairId, [event]);
    else members.push(event);
  }

  const retained: CanonicalContextEvent[] = [];
  const omitted: OmittedReason[] = [];
  const decidedPairIds = new Set<string>();
  let usedBytes = 0;

  // 单条参与预算：装得下就保留，否则 `reason: 'budget'`。
  const keepSingle = (event: CanonicalContextEvent): void => {
    const bytes = encodedBytes(event);
    if (usedBytes + bytes <= budgetBytes) {
      retained.push(event);
      usedBytes += bytes;
    } else {
      omitted.push({ eventId: event.eventId, reason: 'budget' });
    }
  };

  for (const event of candidates) {
    if (event.status === 'superseded') {
      omitted.push({ eventId: event.eventId, reason: 'superseded' });
      continue;
    }

    const pairing = event.pairing;
    if (pairing === undefined) {
      // 无 `pairing`：按单条参与预算。
      keepSingle(event);
      continue;
    }

    const group = pairMembers.get(pairing.pairId);
    if (group === undefined || !group.some((member) => isOpenerType(member.type))) {
      // 该 pairId 分组内没有打开事件（打开事件不在输入中）：按单条处理。
      keepSingle(event);
      continue;
    }

    // 成对保留：整组同进同出，且只在首个成员出现的位置决策一次。
    if (decidedPairIds.has(pairing.pairId)) continue;
    decidedPairIds.add(pairing.pairId);

    let groupBytes = 0;
    for (const member of group) groupBytes += encodedBytes(member);
    if (usedBytes + groupBytes <= budgetBytes) {
      for (const member of group) {
        retained.push(member);
        usedBytes += encodedBytes(member);
      }
    } else {
      for (const member of group) {
        omitted.push({ eventId: member.eventId, reason: 'pair' });
      }
    }
  }

  // `retained` 保持候选顺序：配对分组在其首个成员的位置整组保留，因此需要重排。
  retained.sort(compareCandidates);

  return { snapshotId, sourceWatermark, retained, omitted, budgetBytes, usedBytes };
}
