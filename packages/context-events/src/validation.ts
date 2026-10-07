/**
 * Context Events —— 校验契约（阶段 1，W1）。
 *
 * 设计契约：docs/architecture/context-events.md §11（校验契约）、§5（模块结构）、
 * §8.1/§8.2（配对判据来源）、§9.3（`pairing` 缺失时第 9–14 项 vacuous）、§14（gate）。
 *
 * 本文件只导出三个校验函数，全部失败路径抛 `ContextEventError`：
 *
 * - `validateCanonicalContextEvent`  —— §11 第 1–15 项，逐项独立判定。
 * - `validateCompactSnapshot`         —— §10.3 快照形状 + §11 第 21/22 项。
 * - `validateMemoryContextDigest`     —— §10.2 digest 形状。
 *
 * 边界（§11 末段、§13）：
 * - `assertPairingConsistent`（§11 第 16–20 项）归 `pairing.ts`（W2）；
 * - `compactContextEvents`（§11 第 22/23 项的输出不变量）归 `compact.ts`（W3）；
 * - 本文件不实现它们，也不重复实现阶段 0 已冻结的 taxonomy 表与配对查表。
 *
 * §11 第 1–15 项 → 实现分支映射（每项一条独立分支，`throw` 前均有编号注释）：
 *
 * | 项 | 判据 | 分支 |
 * |---|---|---|
 * | 1  | `eventId`/`sourceId`/`summary`/`payloadRef` 为空 | `assertNonEmptyReference` ×4 |
 * | 2  | `type` 不在 `CONTEXT_EVENT_TYPES` | `CONTEXT_EVENT_TYPES.includes` |
 * | 3  | `status` 不在 `allowedStatusOf(type)` | `allowedStatusOf(type).includes` |
 * | 4  | `occurredAt` 不是合法时间戳 | `assertValidTime` |
 * | 5  | `scope.organId.scope !== 'organ'` 或为空 | `assertCanonicalScope` |
 * | 6  | `dataDigest` 不匹配 `sha256:<64 位小写十六进制>` | `DATA_DIGEST_PATTERN` |
 * | 7  | `evidenceRefs` 任一项不满足 `assertEvidenceRef` | `assertEvidenceRefs` |
 * | 8  | `cost` 任一存在字段不是非负安全整数 | `assertCost` |
 * | 9  | `pairing.pairId` 为空 / `pairing.role` 非法 | `assertPairing`（前两段） |
 * | 10 | `role === 'opened'` 却带 `relatedEventId` | `assertPairing` |
 * | 11 | `role !== 'opened'` 却缺 `relatedEventId` | `assertPairing` |
 * | 12 | `role !== 'opened'` 却非关闭类型 | `assertPairing` + `isCloserType` |
 * | 13 | `role === 'opened'` 却非打开类型 | `assertPairing` + `isOpenerType` |
 * | 14 | 关闭类型但 `role !== pairRoleOf(type)` | `assertPairing` + `pairRoleOf` |
 * | 15 | `status === 'superseded'` ⟺ `supersededByEventId` | `assertSupersedeConsistency` |
 *
 * 第 9–14 项**只在 `pairing !== undefined` 时求值**：`pairing` 是派生关系，由
 * `applyPairingOutcome` 独占赋值；`createContextEvent` 不产出 `pairing`，未配对事件
 * （含未配对关闭事件）在这六项上 vacuous，不抛错（§9.3、§11）。
 */

import { assertEvidenceRef, assertScope } from '../../contracts/src/index.js';
import type { EvidenceRef, ScopeKind, ScopeRef, ScopedId } from '../../contracts/src/index.js';
import { ContextEventError } from './errors.js';
import { allowedStatusOf, isCloserType, isOpenerType, pairRoleOf } from './taxonomy.js';
import {
  CONTEXT_EVENT_TYPES,
  type CanonicalContextEvent,
  type CompactSnapshot,
  type ContextEventCost,
  type ContextEventPairRole,
  type ContextEventPairing,
  type ContextEventStatus,
  type ContextEventType,
  type DecisionDigest,
  type MemoryContextDigest,
  type OmittedReason,
} from './types.js';

/** §11 第 6 项：`dataDigest` 的唯一合法形状。 */
const DATA_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** §6 冻结的 3 个配对角色；不含 `'superseded'`（取代不是配对关系）。 */
const PAIR_ROLES: readonly ContextEventPairRole[] = ['opened', 'resolved', 'rejected'];

/** §10.3 快照的 `omitted.reason` 取值（`'pair'` 只属 compact）。 */
const COMPACT_OMIT_REASONS: readonly OmittedReason['reason'][] = ['budget', 'pair', 'superseded'];

/** §10.2：memory digest 永不产出 `'pair'`（那只是 compact 的丢弃原因）。 */
const DIGEST_OMIT_REASONS: readonly OmittedReason['reason'][] = ['budget', 'superseded'];

/** §10.2 `decisions[].outcome` 取值。 */
const DECISION_OUTCOMES: readonly DecisionDigest['outcome'][] = ['accepted', 'rejected', 'confirmed'];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyReference(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** contracts 的 `assertNonEmptyReference` 是私有函数，此处按同一判据自行实现。 */
function assertNonEmptyReference(value: unknown, label: string): void {
  if (!isNonEmptyReference(value)) throw new ContextEventError(`${label} must be a non-empty reference`);
}

/** contracts 的 `assertValidTime` 是私有函数，此处按同一判据自行实现。 */
function assertValidTime(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ContextEventError(`${label} must be a valid timestamp`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ContextEventError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ContextEventError(`${label} must be a positive safe integer`);
  }
}

/** §11 第 8 项：字段存在时才判定，缺省合法。 */
function assertOptionalNonNegativeSafeInteger(value: unknown, label: string): void {
  if (value === undefined) return;
  assertNonNegativeSafeInteger(value, label);
}

/** §10.2：可选引用字段存在时必须是非空引用。 */
function assertOptionalReference(value: unknown, label: string): void {
  if (value === undefined) return;
  assertNonEmptyReference(value, label);
}

function eachEntry<T>(entries: readonly T[], label: string, check: (entry: T, entryLabel: string) => void): void {
  if (!Array.isArray(entries)) throw new ContextEventError(`${label} must be an array`);
  for (let index = 0; index < entries.length; index += 1) check(entries[index], `${label}[${index}]`);
}

/**
 * §11 第 5 项：`scope.organId` 必须是 organ scope 且值非空。
 *
 * 复用的 `assertScope` 只判 scope kind（且抛 `ContractError`），因此这里翻译成
 * `ContextEventError` 并补上「非空」判据。可选的 `taskId`/`cycleId`/`operationId`
 * 若存在，也按 `ScopeRef` 声明的 kind 逐 id 校验。
 */
function assertCanonicalScope(scope: ScopeRef): void {
  const organId: ScopedId | undefined = (scope as ScopeRef | undefined)?.organId;
  if (organId === undefined) throw new ContextEventError('scope.organId is required');
  assertScopedId(organId, 'organ', 'scope.organId');
  assertScopedId(scope.taskId, 'task', 'scope.taskId');
  assertScopedId(scope.cycleId, 'cycle', 'scope.cycleId');
  assertScopedId(scope.operationId, 'operation', 'scope.operationId');
}

function assertScopedId(id: ScopedId | undefined, expected: ScopeKind, label: string): void {
  if (id === undefined) return;
  try {
    assertScope(id, expected);
  } catch (error) {
    throw new ContextEventError(`${label} must be a ${expected} scope: ${describeError(error)}`);
  }
  assertNonEmptyReference(id.value, `${label}.value`);
}

/** §11 第 7 项：复用 contracts 导出的 `assertEvidenceRef`，错误类型翻译为 `ContextEventError`。 */
function assertEvidenceRefs(refs: readonly EvidenceRef[]): void {
  if (!Array.isArray(refs)) throw new ContextEventError('evidenceRefs must be an array');
  for (let index = 0; index < refs.length; index += 1) {
    try {
      assertEvidenceRef(refs[index]);
    } catch (error) {
      throw new ContextEventError(`evidenceRefs[${index}] is invalid: ${describeError(error)}`);
    }
  }
}

/** §11 第 8 项：`cost` 任一存在字段必须是非负安全整数。 */
function assertCost(cost: ContextEventCost | undefined): void {
  if (cost === undefined) return;
  assertOptionalNonNegativeSafeInteger(cost.tokensInput, 'cost.tokensInput');
  assertOptionalNonNegativeSafeInteger(cost.tokensOutput, 'cost.tokensOutput');
  assertOptionalNonNegativeSafeInteger(cost.bytesAvoided, 'cost.bytesAvoided');
  assertOptionalNonNegativeSafeInteger(cost.bytesRetrieved, 'cost.bytesRetrieved');
}

/**
 * §11 第 9–14 项。仅在 `pairing !== undefined` 时调用。
 *
 * 第 12/13/14 项**不互斥**（关闭类型带 `role: 'opened'` 时第 13 与第 14 项同时成立），
 * 因此写成三个独立 `if`，不写 `else if`。
 */
function assertPairing(type: ContextEventType, pairing: ContextEventPairing): void {
  // §11 第 9 项：pairId 非空，role 属于 3 值枚举。
  assertNonEmptyReference(pairing.pairId, 'pairing.pairId');
  if (!PAIR_ROLES.includes(pairing.role)) {
    throw new ContextEventError(`pairing.role ${String(pairing.role)} is not a context event pair role`);
  }

  if (pairing.role === 'opened') {
    // §11 第 10 项：打开角色不得携带 relatedEventId。
    if (pairing.relatedEventId !== undefined) {
      throw new ContextEventError('pairing.role opened must not carry relatedEventId');
    }
  } else {
    // §11 第 11 项：非打开角色必须给出可用的 relatedEventId。
    if (!isNonEmptyReference(pairing.relatedEventId)) {
      throw new ContextEventError(`pairing.role ${pairing.role} requires relatedEventId`);
    }
  }

  // §11 第 12 项：非关闭类型不得带关闭角色。
  if (pairing.role !== 'opened' && !isCloserType(type)) {
    throw new ContextEventError(`pairing.role ${pairing.role} requires a closer type, got ${type}`);
  }

  // §11 第 13 项：非打开类型不得带打开角色。
  if (pairing.role === 'opened' && !isOpenerType(type)) {
    throw new ContextEventError(`pairing.role opened requires an opener type, got ${type}`);
  }

  // §11 第 14 项：关闭类型必须携带该 type 的配对角色。
  if (isCloserType(type) && pairing.role !== pairRoleOf(type)) {
    throw new ContextEventError(`closer type ${type} requires pairing.role ${String(pairRoleOf(type))}, got ${pairing.role}`);
  }
}

/**
 * §11 第 15 项：`status === 'superseded'` ⟺ `supersededByEventId` 存在（双向）。
 *
 * 「存在」按字段是否给出判定；`'superseded'` 一侧额外要求引用非空，否则取代事实
 * 没有可解析的目标（与第 1 项「引用必须非空」同一判据）。
 */
function assertSupersedeConsistency(status: ContextEventStatus, supersededByEventId: string | undefined): void {
  if (status === 'superseded') {
    if (!isNonEmptyReference(supersededByEventId)) {
      throw new ContextEventError('status superseded requires a non-empty supersededByEventId');
    }
    return;
  }
  if (supersededByEventId !== undefined) {
    throw new ContextEventError(`supersededByEventId requires status superseded, got ${String(status)}`);
  }
}

/** §11 第 1–15 项。任何一项不满足即抛 `ContextEventError`。 */
export function validateCanonicalContextEvent(input: CanonicalContextEvent): void {
  // §11 第 1 项：四个必填引用非空。
  assertNonEmptyReference(input.eventId, 'eventId');
  assertNonEmptyReference(input.sourceId, 'sourceId');
  assertNonEmptyReference(input.summary, 'summary');
  assertNonEmptyReference(input.payloadRef, 'payloadRef');

  // §11 第 2 项：type 必须是 18 个 canonical type 之一（先于第 3 项，保证查表输入合法）。
  if (!(CONTEXT_EVENT_TYPES as readonly string[]).includes(input.type)) {
    throw new ContextEventError(`unknown context event type: ${String(input.type)}`);
  }

  // §11 第 3 项：status 必须在 allowedStatusOf(type) 内（含 'superseded'，不另立状态表）。
  if (!allowedStatusOf(input.type).includes(input.status)) {
    throw new ContextEventError(`status ${String(input.status)} is not allowed for ${input.type}`);
  }

  // §11 第 4 项：occurredAt 必须是合法时间戳。
  assertValidTime(input.occurredAt, 'occurredAt');

  // §11 第 5 项：scope.organId 必须是 organ scope 且非空。
  assertCanonicalScope(input.scope);

  // §11 第 6 项：dataDigest 形状固定。
  if (typeof input.dataDigest !== 'string' || !DATA_DIGEST_PATTERN.test(input.dataDigest)) {
    throw new ContextEventError('dataDigest must match sha256:<64 lowercase hex>');
  }

  // §11 第 7 项：evidenceRefs 每项满足 contracts 的 assertEvidenceRef。
  assertEvidenceRefs(input.evidenceRefs);

  // §11 第 8 项：cost 存在字段必须是非负安全整数。
  assertCost(input.cost);

  // §11 第 9–14 项：仅当 pairing 存在时适用；缺失即 vacuous（未配对事件合法）。
  if (input.pairing !== undefined) assertPairing(input.type, input.pairing);

  // §11 第 15 项：取代事实双向一致。
  assertSupersedeConsistency(input.status, input.supersededByEventId);
}

/**
 * §10.3 快照形状校验。
 *
 * 判据来源：`snapshotId` 非空、`sourceWatermark` 非负整数、`budgetBytes` 正整数
 * （§11 第 21 项）、`usedBytes <= budgetBytes`（§10.3 / §11 第 22 项）、
 * `retained` 每项是合法 canonical 事件、`omitted` 每项 reason 属于 3 值。
 */
export function validateCompactSnapshot(input: CompactSnapshot): void {
  assertNonEmptyReference(input.snapshotId, 'snapshotId');
  assertNonNegativeSafeInteger(input.sourceWatermark, 'sourceWatermark');
  assertPositiveSafeInteger(input.budgetBytes, 'budgetBytes');
  assertNonNegativeSafeInteger(input.usedBytes, 'usedBytes');
  if (input.usedBytes > input.budgetBytes) {
    throw new ContextEventError('usedBytes must not exceed budgetBytes');
  }
  eachEntry(input.retained, 'retained', (event) => validateCanonicalContextEvent(event));
  eachEntry(input.omitted, 'omitted', (entry, label) => {
    assertNonEmptyReference(entry.eventId, `${label}.eventId`);
    if (!COMPACT_OMIT_REASONS.includes(entry.reason)) {
      throw new ContextEventError(`${label}.reason must be one of budget|pair|superseded`);
    }
  });
}

/**
 * §10.2 memory digest 形状校验。
 *
 * `summary` 允许为空（无 priority ≤ 2 事件时由空连接得到），故只判类型。
 * 其余字段是 canonical 字段的搬运：id 非空、`occurredAt` 合法、summary 非空、
 * 枚举取值受限；`omitted.reason` 只能是 `'superseded' | 'budget'`（§10.2）。
 */
export function validateMemoryContextDigest(input: MemoryContextDigest): void {
  if (typeof input.summary !== 'string') throw new ContextEventError('summary must be a string');

  eachEntry(input.decisions, 'decisions', (entry, label) => {
    assertNonEmptyReference(entry.eventId, `${label}.eventId`);
    assertValidTime(entry.occurredAt, `${label}.occurredAt`);
    assertNonEmptyReference(entry.summary, `${label}.summary`);
    if (!DECISION_OUTCOMES.includes(entry.outcome)) {
      throw new ContextEventError(`${label}.outcome must be one of accepted|rejected|confirmed`);
    }
  });

  eachEntry(input.failures, 'failures', (entry, label) => {
    assertNonEmptyReference(entry.failureEventId, `${label}.failureEventId`);
    assertOptionalReference(entry.resolutionEventId, `${label}.resolutionEventId`);
    assertValidTime(entry.occurredAt, `${label}.occurredAt`);
    assertNonEmptyReference(entry.summary, `${label}.summary`);
    assertOptionalReference(entry.resolutionSummary, `${label}.resolutionSummary`);
  });

  eachEntry(input.rejectedPlans, 'rejectedPlans', (entry, label) => {
    assertNonEmptyReference(entry.proposalEventId, `${label}.proposalEventId`);
    assertOptionalReference(entry.rejectionEventId, `${label}.rejectionEventId`);
    assertValidTime(entry.occurredAt, `${label}.occurredAt`);
    assertNonEmptyReference(entry.summary, `${label}.summary`);
  });

  eachEntry(input.blockers, 'blockers', (entry, label) => {
    assertNonEmptyReference(entry.blockerEventId, `${label}.blockerEventId`);
    assertOptionalReference(entry.resolutionEventId, `${label}.resolutionEventId`);
    assertValidTime(entry.occurredAt, `${label}.occurredAt`);
    assertNonEmptyReference(entry.summary, `${label}.summary`);
    assertOptionalReference(entry.resolutionSummary, `${label}.resolutionSummary`);
  });

  eachEntry(input.omitted, 'omitted', (entry, label) => {
    assertNonEmptyReference(entry.eventId, `${label}.eventId`);
    if (!DIGEST_OMIT_REASONS.includes(entry.reason)) {
      throw new ContextEventError(`${label}.reason must be one of budget|superseded for a memory digest`);
    }
  });
}
