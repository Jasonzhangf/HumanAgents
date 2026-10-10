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
import { normalizeRuntimeTaskEvents } from './normalize.js';
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
  RuntimeNormalizeContext,
  RuntimeTaskEventLike,
  SemanticObservation,
  SemanticObservationInput,
  SemanticPairingResult,
} from './types.js';
import type { CoverageIssue, PairedExecutionGroup, SemanticEventRef } from '../../contracts/src/semantic-observation.js';
import type { ScopeRef } from '../../contracts/src/index.js';
import { validateSemanticObservationEnvelope } from '../../contracts/src/semantic-observation.js';
import { validateCanonicalContextEvent } from './validation.js';

/** Reduce durable runtime facts into operation/request/invocation views. */
export function pairRuntimeSemantics(
  events: readonly CanonicalContextEvent[],
  sources: readonly RuntimeTaskEventLike[],
  context?: RuntimeNormalizeContext,
  priorCoverage: readonly CoverageIssue[] = [],
  conflictedSourceIds: readonly string[] = [],
): SemanticPairingResult {
  if (context === undefined) return { events: applyPairingOutcome(events), pairing: [], coverageIssues: [] };
  const sourceById = new Map(sources.map((source) => [source.eventId, source]));
  const conflicts = new Set([
    ...conflictedSourceIds,
    ...priorCoverage.filter((issue) => issue.reason === 'duplicate-conflict')
      .map((issue) => issue.eventRef?.sourceId).filter((id): id is string => id !== undefined),
  ]);
  const toolIdsByCall = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!isToolSource(source) || !validOperationIdentity(source) || !validIdentity(source.requestId) || !validIdentity(source.callId) || !validIdentity(source.toolId)) continue;
    const key = JSON.stringify([source.taskId.value, source.operationId, source.executionEpoch, source.requestId, source.callId]);
    const ids = toolIdsByCall.get(key) ?? new Set<string>();
    ids.add(source.toolId);
    toolIdsByCall.set(key, ids);
  }
  const toolConflictSources = new Set(sources.filter((source) => {
    if (!validOperationIdentity(source) || !validIdentity(source.requestId) || !validIdentity(source.callId) || !validIdentity(source.toolId)) return false;
    const key = JSON.stringify([source.taskId.value, source.operationId, source.executionEpoch, source.requestId, source.callId]);
    return (toolIdsByCall.get(key)?.size ?? 0) > 1;
  }).map((source) => source.eventId));
  const groupBuckets = new Map<string, { kind: PairedExecutionGroup['kind']; scope: ScopeRef; epoch: number; requestId?: string; callId?: string; toolId?: string; members: RuntimeTaskEventLike[] }>();
  const getBucket = (kind: PairedExecutionGroup['kind'], source: RuntimeTaskEventLike, requestId?: string, callId?: string, toolId?: string) => {
    const scope = runtimeScopeForPairing(context?.scope, source);
    const key = JSON.stringify([kind, scope.organId.value, scope.taskId?.value, scope.operationId?.value, source.executionEpoch, requestId, callId, toolId]);
    let bucket = groupBuckets.get(key);
    if (bucket === undefined) {
      bucket = { kind, scope, epoch: source.executionEpoch, ...(requestId === undefined ? {} : { requestId }), ...(callId === undefined ? {} : { callId }), ...(toolId === undefined ? {} : { toolId }), members: [] };
      groupBuckets.set(key, bucket);
    }
    bucket.members.push(source);
    return bucket;
  };
  for (const source of sources) {
    if (!validOperationIdentity(source)) continue;
    getBucket('operation', source);
    if (validIdentity(source.requestId)) getBucket('request', source, source.requestId);
    if (isToolSource(source)) {
      if (!validIdentity(source.requestId) || !validIdentity(source.callId) || !validIdentity(source.toolId)) continue;
      getBucket('invocation', source, source.requestId, source.callId, source.toolId);
    }
  }
  const coverageIssues: CoverageIssue[] = [];
  const groups: PairedExecutionGroup[] = [];
  const eligible = (source: RuntimeTaskEventLike, kind: PairedExecutionGroup['kind']) => {
    if (kind === 'operation') return true;
    if (kind === 'request') return validIdentity(source.requestId)
      && (source.kind === 'execution.terminal' ? source.terminalPhase === 'provider' : REQUEST_KINDS.has(source.kind));
    return isToolSource(source) && validIdentity(source.requestId) && validIdentity(source.callId) && validIdentity(source.toolId);
  };
  for (const [key, bucket] of groupBuckets) {
    const { kind, members } = bucket;
    const memberConflicted = members.some((source) => conflicts.has(source.eventId)
      || (kind === 'invocation' && toolConflictSources.has(source.eventId)));
    const legalStateSources = members.filter((source) => kind === 'operation'
      ? source.kind === 'execution.terminal' && source.terminalPhase === 'final'
      : kind === 'request'
        ? source.kind === 'execution.terminal' && source.terminalPhase === 'provider'
        : source.kind === 'provider.tool' || source.kind === 'provider.tool-result');
    const state = memberConflicted ? 'unknown' : reduceState(kind, legalStateSources);
    const eventRefs: SemanticEventRef[] = [];
    for (const source of members) {
      if (!eligible(source, kind)) continue;
      const event = events.find((candidate) => candidate.sourceId === source.eventId);
      if (event !== undefined) eventRefs.push({ eventId: event.eventId, sourceId: source.eventId, scope: event.scope });
    }
    groups.push({
      groupId: `${kind}:${key}`,
      kind,
      scope: bucket.scope,
      executionEpoch: bucket.epoch,
      ...(bucket.requestId === undefined ? {} : { requestId: bucket.requestId }),
      ...(bucket.callId === undefined ? {} : { callId: bucket.callId }),
      ...(bucket.toolId === undefined ? {} : { toolId: bucket.toolId }),
      state,
      eventRefs,
    });
    if (kind === 'invocation' && members.some((source) => toolConflictSources.has(source.eventId))) {
      const source = members.find((member) => toolConflictSources.has(member.eventId))!;
      coverageIssues.push(issueFor('duplicate-conflict', bucket.scope, source, events));
    }
    if (memberConflicted) continue;
    if (kind === 'operation' && legalStateSources.length > 1) coverageIssues.push(issueFor('closer-conflict', bucket.scope, members[0], events));
    if (kind === 'request' && legalStateSources.length > 1) coverageIssues.push(issueFor('closer-conflict', bucket.scope, members[0], events));
    if (kind === 'invocation') {
      const openers = legalStateSources.filter((source) => source.kind === 'provider.tool');
      const results = legalStateSources.filter((source) => source.kind === 'provider.tool-result');
      if (openers.length > 1) coverageIssues.push(issueFor('multi-opener', bucket.scope, openers[0], events));
      if (openers.length === 0 && results.length > 0) coverageIssues.push(issueFor('opener-missing', bucket.scope, results[0], events));
      if (results.length > 1) coverageIssues.push(issueFor('closer-conflict', bucket.scope, results[0], events));
    }
  }
  for (const source of sources) {
    if (isToolSource(source) && (!validIdentity(source.requestId) || !validIdentity(source.callId) || !validIdentity(source.toolId))) {
      coverageIssues.push(issueFor('correlation-unavailable', runtimeScopeForPairing(context?.scope, source), source, events));
    }
  }
  const canonicalBuckets = new Map<string, CanonicalContextEvent[]>();
  for (const event of events) {
    const source = sourceById.get(event.sourceId);
    if (source === undefined) continue;
    const scopeKey = JSON.stringify([event.scope.organId.value, event.scope.taskId?.value, event.scope.operationId?.value, source.executionEpoch]);
    let key = scopeKey;
    if (isToolSource(source)) {
      key = validIdentity(source.requestId) && validIdentity(source.callId) && validIdentity(source.toolId)
        ? JSON.stringify(['tool', scopeKey, source.requestId, source.callId, source.toolId])
        : JSON.stringify(['unmatched', source.eventId]);
    }
    else if (source.kind === 'execution.terminal' && source.terminalPhase === 'provider') key = JSON.stringify(['provider-terminal', source.eventId]);
    const bucket = canonicalBuckets.get(key);
    if (bucket === undefined) canonicalBuckets.set(key, [event]);
    else bucket.push(event);
  }
  const pairedById = new Map<string, CanonicalContextEvent>();
  for (const bucket of canonicalBuckets.values()) {
    for (const event of applyPairingOutcome(bucket)) pairedById.set(event.eventId, event);
  }
  const pairedEvents = events.map((event) => pairedById.get(event.eventId) ?? event);
  return { events: pairedEvents, pairing: groups, coverageIssues };
}

const REQUEST_KINDS = new Set(['provider.tool', 'provider.tool-result', 'provider.error']);
function validIdentity(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function validOperationIdentity(source: RuntimeTaskEventLike): boolean {
  return validIdentity(source.eventId) && validIdentity(source.taskId?.value) && validIdentity(source.operationId)
    && Number.isSafeInteger(source.executionEpoch) && source.executionEpoch > 0;
}
function isToolSource(source: RuntimeTaskEventLike): boolean { return source.kind === 'provider.tool' || source.kind === 'provider.tool-result'; }
function runtimeScopeForPairing(root: ScopeRef | undefined, source: RuntimeTaskEventLike): ScopeRef {
  if (root === undefined) throw new ContextEventError('runtime semantic pairing requires an authoritative organ scope');
  return { organId: root.organId, taskId: source.taskId, operationId: { scope: 'operation', value: source.operationId } };
}
function reduceState(kind: PairedExecutionGroup['kind'], sources: readonly RuntimeTaskEventLike[]): PairedExecutionGroup['state'] {
  if (kind === 'invocation') {
    const openers = sources.filter((source) => source.kind === 'provider.tool');
    const results = sources.filter((source) => source.kind === 'provider.tool-result');
    if (openers.length !== 1 || results.length > 1) return openers.length === 0 && results.length === 0 ? 'open' : 'unknown';
    if (results.length === 0) return 'open';
    return invocationResultState(results[0]);
  }
  if (sources.length === 0) return 'open';
  if (sources.length > 1) return 'unknown';
  const source = sources[0];
  return terminalGroupState(source);
}
function terminalGroupState(source: RuntimeTaskEventLike): PairedExecutionGroup['state'] {
  switch (source.state) {
    case 'succeeded': case 'failed': return 'closed';
    case 'cancelled': case 'stopped': return 'cancelled';
    case 'blocked': return 'blocked';
    case 'waiting': return 'waiting';
    default: return 'unknown';
  }
}
function invocationResultState(source: RuntimeTaskEventLike): PairedExecutionGroup['state'] {
  switch (source.status) {
    case 'succeeded': case 'failed': return 'closed';
    case 'cancelled': return 'cancelled';
    case 'blocked': return 'blocked';
    case 'unknown': return 'unknown';
    default: return 'unknown';
  }
}
function issueFor(reason: CoverageIssue['reason'], scope: ScopeRef, source: RuntimeTaskEventLike, events: readonly CanonicalContextEvent[]): CoverageIssue {
  const event = events.find((candidate) => candidate.sourceId === source.eventId);
  const evidence = source.evidenceRefs[0] ?? { evidenceId: { scope: 'evidence' as const, value: `runtime-${source.eventId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}` }, kind: 'execution' as const, source: 'context-events:runtime-task-event', locator: source.eventId, scope };
  return { reason, scope, sourceRef: evidence, ...(event === undefined ? {} : { eventRef: { eventId: event.eventId, sourceId: source.eventId, scope: event.scope } }) };
}

export function buildSemanticObservation(input: SemanticObservationInput): SemanticObservation {
  const normalized = normalizeRuntimeTaskEvents(input.events, { scope: input.scope });
  const paired = pairRuntimeSemantics(normalized.events, normalized.sources, { scope: input.scope }, normalized.coverageIssues, normalized.conflictedSourceIds);
  const envelope: SemanticObservation = {
    scope: input.scope,
    projectionVersion: input.projectionVersion,
    sourceWatermark: input.sourceWatermark,
    ...(input.publicCommitWatermark === undefined ? {} : { publicCommitWatermark: input.publicCommitWatermark }),
    events: paired.events,
    coverageIssues: [...normalized.coverageIssues, ...paired.coverageIssues],
    pairing: paired.pairing,
    capabilities: input.capabilities ?? [],
  };
  validateSemanticObservationEnvelope(envelope, validateCanonicalContextEvent);
  return envelope;
}

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
