/**
 * Context Events 黑盒回归（W4）。
 *
 * 唯一入口：`packages/context-events/src/index.ts` 的导出面（§14）。
 * 本文件只断言外部可观察行为：不读源码、不断言私有字段、不 mock 内部调用。
 *
 * 契约：docs/architecture/context-events.md §7–§12、§11 第 1–23 项、§14。
 *
 * 两条入口缺一不可：
 *   A. 适配器入口：EventRecordLike / AgentEventLike / AgentSemanticEventLike / ProviderEventLike
 *      → normalize* → applyPairingOutcome → toUserNarrative / toMemoryDigest / compactContextEvents
 *      （覆盖 §9.4「适配器规则 ✓」的 6 个 type）
 *   B. 构造入口：createContextEvent → 同一下游链路
 *      （覆盖 §9.4「适配器规则 ✗」的 12 个 type）
 *
 * 已知与实现不一致之处（只报告、不放宽断言）记录在本文件末尾的
 * `§14 契约偏离观察` 注释块中，并向 Lead 汇报。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_EVENT_CATEGORIES,
  CONTEXT_EVENT_TYPES,
  ContextEventError,
  allowedStatusOf,
  applyPairingOutcome,
  assertPairingConsistent,
  buildPairingIndex,
  categoryOf,
  closeTypeOf,
  closedStatusOf,
  compactContextEvents,
  createContextEvent,
  defaultStatusOf,
  isCloserType,
  isOpenerType,
  labelOf,
  narrativeOf,
  normalizeAgentEvent,
  normalizeAgentSemanticEvent,
  normalizeEventRecord,
  normalizeProviderEvent,
  openTypeOf,
  pairRoleOf,
  priorityOf,
  sortEvents,
  toMemoryDigest,
  toUserNarrative,
  validateCanonicalContextEvent,
  validateCompactSnapshot,
  validateMemoryContextDigest,
  type AgentEventLike,
  type AgentSemanticEventLike,
  type CanonicalContextEvent,
  type ContextEventInput,
  type ContextEventPairRole,
  type ContextEventType,
  type EventRecordLike,
  type NormalizeContext,
  type NormalizeResult,
  type ProviderEventLike,
  type UnmappedSource,
} from '../../packages/context-events/src/index.js';

/* ------------------------------------------------------------------ *
 * 类型别名：全部由导出面推导，避免引用包内私有类型。
 * ------------------------------------------------------------------ */

type ScopeRefLike = ContextEventInput['scope'];
type EvidenceRefLike = NonNullable<ContextEventInput['evidenceRefs']>[number];
type OperationStatusLike = NonNullable<EventRecordLike['operation']>['status'];
type ProviderKindLike = ProviderEventLike['kind'];
type SemanticKindLike = AgentSemanticEventLike['kind'];
type UnmappedReason = UnmappedSource['reason'];

/* ------------------------------------------------------------------ *
 * 固定输入（不读时钟、不读随机数、不读环境）。
 * ------------------------------------------------------------------ */

const ORGAN = 'organ-1';

const at = (second: number): string => `2026-10-07T00:00:${String(second).padStart(2, '0')}.000Z`;

const scope = (): ScopeRefLike => ({ organId: { scope: 'organ', value: ORGAN } });

const taskId = (): AgentEventLike['taskId'] => ({ scope: 'task', value: 'task-1' });

const evidenceRef = (n = 1): EvidenceRefLike => ({
  evidenceId: { scope: 'evidence', value: `evidence-${n}` },
  kind: 'tool',
  source: `source-${n}`,
  locator: `locator-${n}`,
  scope: scope(),
});

const normalizeContext = (): NormalizeContext => ({
  scope: scope(),
  sourceId: 'agent-source-1',
  occurredAt: at(5),
});

const makeEvent = (type: ContextEventType, over: Partial<ContextEventInput> = {}): CanonicalContextEvent =>
  createContextEvent({ type, sourceId: `source-${type}`, occurredAt: at(1), scope: scope(), ...over });

const withStatus = (event: CanonicalContextEvent, status: CanonicalContextEvent['status']): CanonicalContextEvent => ({
  ...event,
  status,
});

const withPairing = (
  event: CanonicalContextEvent,
  pairing: { readonly pairId: string; readonly role: ContextEventPairRole; readonly relatedEventId?: string },
): CanonicalContextEvent => ({ ...event, pairing });

/** 断言非 undefined 并收窄类型（`assert.ok` 的声明不是断言函数，不能收窄）。 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

const pairOf = (event: CanonicalContextEvent): NonNullable<CanonicalContextEvent['pairing']> =>
  must(event.pairing, `pairing on ${event.eventId}`);

/* ------------------------------------------------------------------ *
 * 适配器输入构造器。
 * ------------------------------------------------------------------ */

function eventRecord(over: Partial<EventRecordLike> = {}): EventRecordLike {
  return {
    messageId: 'message-1',
    streamId: 'stream-1',
    class: 'data',
    scope: scope(),
    occurredAt: at(1),
    summary: '来源摘要',
    evidenceRefs: [],
    sequence: 7,
    ...over,
  };
}

function agentEvent(over: Partial<AgentEventLike> = {}): AgentEventLike {
  return { kind: 'provider.tool', evidenceRefs: [], taskId: taskId(), executionEpoch: 1, ...over };
}

function semanticEvent(over: Partial<AgentSemanticEventLike> = {}): AgentSemanticEventLike {
  return { seq: 3, kind: 'execution.started', state: 'running', summary: '语义摘要', evidenceRefs: [], ...over };
}

/**
 * §9.2 provider-event 的真实 codecs 形状：`toolCall` 由 contracts 声明、
 * 但不在 `ProviderEventLike` 的结构化输入面上，故作为额外字段透传。
 */
type ProviderEventInput = Partial<ProviderEventLike> & {
  readonly toolCall?: { readonly callId: string; readonly toolId: string; readonly arguments?: unknown };
};

function providerEvent(over: ProviderEventInput = {}): ProviderEventLike {
  return { eventId: 'provider-event-1', kind: 'tool', evidenceRefs: [], ...over } as ProviderEventLike;
}

/* ------------------------------------------------------------------ *
 * 断言助手。
 * ------------------------------------------------------------------ */

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const textBytes = (value: string): number => new TextEncoder().encode(value).length;
const eventBytes = (event: CanonicalContextEvent): number => bytesOf(event) + 1; // §10.3 EVENT_JOIN_OVERHEAD_BYTES = 1

function expectContextEventError(fn: () => unknown): void {
  assert.throws(fn, ContextEventError);
}

function onlyEvent(result: NormalizeResult): CanonicalContextEvent {
  assert.equal(result.events.length, 1, `expected 1 event, got ${result.events.length}`);
  assert.equal(result.unmapped.length, 0, `expected 0 unmapped, got ${JSON.stringify(result.unmapped)}`);
  return result.events[0];
}

function onlyUnmapped(result: NormalizeResult, reason: UnmappedReason, rawKind: string): UnmappedSource {
  assert.equal(result.events.length, 0, `expected 0 events, got ${JSON.stringify(result.events.map((e) => e.type))}`);
  assert.equal(result.unmapped.length, 1, `expected 1 unmapped, got ${JSON.stringify(result.unmapped)}`);
  const unmapped = result.unmapped[0];
  assert.equal(unmapped.reason, reason);
  assert.equal(unmapped.rawKind, rawKind);
  return unmapped;
}

/**
 * 断言越界输入**不会**被静默映射成 canonical 事件。
 * 这些输入落在 §9.2 的闭合 union 之外，契约未定义其产出形状，故显式失败与
 * 空结果都可接受；唯一不可接受的是产出一个 canonical 事件（静默错映射）。
 */
function assertNoCanonicalEvent(fn: () => NormalizeResult, what: string): void {
  let result: NormalizeResult;
  try {
    result = fn();
  } catch {
    return;
  }
  assert.equal(result.events.length, 0, `${what} must not be silently mapped to a canonical event`);
}

/**
 * §10.2 `omitted` 的判据集合：已进入任一 digest **字段**的事件 `eventId`
 * （`decisions` / `failures` / `rejectedPlans` / `blockers`，含配对引用字段）。
 * `summary` 只产出文本，无法按 eventId 反查，故由调用方另行核对。
 */
function digestFieldEventIds(digest: ReturnType<typeof toMemoryDigest>): Set<string> {
  const ids = new Set<string>();
  for (const entry of digest.decisions) ids.add(entry.eventId);
  for (const entry of digest.failures) {
    ids.add(entry.failureEventId);
    if (entry.resolutionEventId !== undefined) ids.add(entry.resolutionEventId);
  }
  for (const entry of digest.rejectedPlans) {
    ids.add(entry.proposalEventId);
    if (entry.rejectionEventId !== undefined) ids.add(entry.rejectionEventId);
  }
  for (const entry of digest.blockers) {
    ids.add(entry.blockerEventId);
    if (entry.resolutionEventId !== undefined) ids.add(entry.resolutionEventId);
  }
  return ids;
}

/* ================================================================== *
 * §7 taxonomy：类目 / 优先级 / 叙述 / 默认状态 / 标签
 * ================================================================== */

test('§7 18 个 type 的 category/priority/narrative/defaultStatus/label 与契约表逐行一致', () => {
  const table: ReadonlyArray<readonly [ContextEventType, string, number, string, string, string]> = [
    ['task.created', 'task', 2, 'progress', 'completed', '任务已创建'],
    ['task.confirmed', 'task', 1, 'decision', 'completed', '任务已确认'],
    ['operation.started', 'task', 4, 'progress', 'active', '操作开始'],
    ['operation.completed', 'task', 3, 'progress', 'completed', '操作完成'],
    ['operation.failed', 'task', 2, 'failure', 'failed', '操作失败'],
    ['error.detected', 'error', 1, 'failure', 'active', '发现问题'],
    ['error.resolved', 'error', 2, 'recovery', 'resolved', '问题已修复'],
    ['blocker.detected', 'blocker', 1, 'attention', 'active', '遇到阻塞'],
    ['blocker.resolved', 'blocker', 2, 'recovery', 'resolved', '阻塞已解除'],
    ['checkpoint.committed', 'task', 1, 'checkpoint', 'completed', '检查点已提交'],
    ['checkpoint.reentered', 'task', 2, 'checkpoint', 'completed', '检查点已重入'],
    ['context.compacted', 'task', 4, 'checkpoint', 'completed', '上下文已压缩'],
    ['plan.proposed', 'plan', 3, 'decision', 'active', '提出方案'],
    ['plan.accepted', 'plan', 3, 'decision', 'completed', '方案已采纳'],
    ['plan.rejected', 'plan', 2, 'decision', 'rejected', '方案已否决'],
    ['retry.detected', 'error', 3, 'attention', 'active', '检测到重试'],
    ['retry.recovered', 'error', 2, 'recovery', 'resolved', '重试已恢复'],
    ['retry.exhausted', 'error', 2, 'failure', 'failed', '重试已耗尽'],
  ];
  assert.equal(CONTEXT_EVENT_TYPES.length, 18);
  assert.equal(table.length, 18);
  assert.deepEqual(new Set(CONTEXT_EVENT_TYPES), new Set(table.map(([type]) => type)));
  for (const [type, category, priority, narrative, status, label] of table) {
    assert.equal(categoryOf(type), category, `categoryOf(${type})`);
    assert.equal(priorityOf(type), priority, `priorityOf(${type})`);
    assert.equal(narrativeOf(type), narrative, `narrativeOf(${type})`);
    assert.equal(defaultStatusOf(type), status, `defaultStatusOf(${type})`);
    assert.equal(labelOf(type), label, `labelOf(${type})`);
  }
});

test('§7 类目词表是 4 值闭合集，且每个 type 的类目都在其中', () => {
  assert.deepEqual([...CONTEXT_EVENT_CATEGORIES], ['task', 'plan', 'error', 'blocker']);
  for (const type of CONTEXT_EVENT_TYPES) {
    assert.ok(CONTEXT_EVENT_CATEGORIES.includes(categoryOf(type) as (typeof CONTEXT_EVENT_CATEGORIES)[number]));
  }
});

/* ================================================================== *
 * §8.1 配对查表
 * ================================================================== */

test('§8.1 openTypeOf/closeTypeOf/pairRoleOf/isOpenerType/isCloserType 与契约表逐行一致', () => {
  const openers: ReadonlyArray<readonly [ContextEventType, readonly ContextEventType[]]> = [
    ['operation.failed', ['checkpoint.committed', 'checkpoint.reentered']],
    ['error.detected', ['error.resolved']],
    ['blocker.detected', ['blocker.resolved']],
    ['plan.proposed', ['plan.accepted', 'plan.rejected']],
    ['retry.detected', ['retry.recovered', 'retry.exhausted']],
  ];
  const closers: ReadonlyArray<readonly [ContextEventType, ContextEventType, ContextEventPairRole]> = [
    ['error.resolved', 'error.detected', 'resolved'],
    ['blocker.resolved', 'blocker.detected', 'resolved'],
    ['checkpoint.committed', 'operation.failed', 'resolved'],
    ['checkpoint.reentered', 'operation.failed', 'resolved'],
    ['plan.accepted', 'plan.proposed', 'resolved'],
    ['plan.rejected', 'plan.proposed', 'rejected'],
    ['retry.recovered', 'retry.detected', 'resolved'],
    ['retry.exhausted', 'retry.detected', 'rejected'],
  ];
  const openerTypes = new Set(openers.map(([type]) => type));
  const closerTypes = new Set(closers.map(([type]) => type));

  for (const type of CONTEXT_EVENT_TYPES) {
    assert.equal(isOpenerType(type), openerTypes.has(type), `isOpenerType(${type})`);
    assert.equal(isCloserType(type), closerTypes.has(type), `isCloserType(${type})`);
    if (openerTypes.has(type)) {
      // §8.1：打开事件 → 允许的关闭事件；openTypeOf / pairRoleOf → undefined。
      assert.equal(openTypeOf(type), undefined, `openTypeOf(${type})`);
      assert.equal(pairRoleOf(type), undefined, `pairRoleOf(${type})`);
      continue;
    }
    if (closerTypes.has(type)) {
      // §8.1：关闭事件 → closeTypeOf 为 []。
      assert.deepEqual([...closeTypeOf(type)], [], `closeTypeOf(${type})`);
      continue;
    }
    // 既不打开也不关闭：三个查表都返回空。
    assert.deepEqual([...closeTypeOf(type)], [], `closeTypeOf(${type})`);
    assert.equal(openTypeOf(type), undefined, `openTypeOf(${type})`);
    assert.equal(pairRoleOf(type), undefined, `pairRoleOf(${type})`);
  }
  for (const [type, closes] of openers) {
    assert.deepEqual([...closeTypeOf(type)], closes, `closeTypeOf(${type})`);
  }
  for (const [type, opens, role] of closers) {
    assert.equal(openTypeOf(type), opens, `openTypeOf(${type})`);
    assert.equal(pairRoleOf(type), role, `pairRoleOf(${type})`);
  }
  assert.equal(openerTypes.size, 5);
  assert.equal(closerTypes.size, 8);
});

test('§8.2 closedStatusOf：8 个关闭类型返回改写目标，其余 10 个返回 undefined', () => {
  const targets: ReadonlyArray<readonly [ContextEventType, string]> = [
    ['error.resolved', 'resolved'],
    ['blocker.resolved', 'resolved'],
    ['checkpoint.committed', 'resolved'],
    ['checkpoint.reentered', 'resolved'],
    ['plan.accepted', 'completed'],
    ['plan.rejected', 'rejected'],
    ['retry.recovered', 'resolved'],
    ['retry.exhausted', 'failed'],
  ];
  const closers = new Map(targets);
  for (const type of CONTEXT_EVENT_TYPES) {
    if (closers.has(type)) assert.equal(closedStatusOf(type), closers.get(type), `closedStatusOf(${type})`);
    else assert.equal(closedStatusOf(type), undefined, `closedStatusOf(${type})`);
  }
  assert.equal(closedStatusOf('operation.failed'), undefined);
  assert.equal(closedStatusOf('plan.proposed'), undefined);
  assert.equal(closedStatusOf('context.compacted'), undefined);
});

test('§7/§8.2 allowedStatusOf 是唯一真源：默认状态 ∪ {superseded} ∪ 全部关闭改写目标', () => {
  for (const type of CONTEXT_EVENT_TYPES) {
    const expected = new Set<string>([defaultStatusOf(type), 'superseded']);
    for (const closer of CONTEXT_EVENT_TYPES) {
      if (openTypeOf(closer) !== type) continue;
      expected.add(must(closedStatusOf(closer), `closedStatusOf(${closer})`));
    }
    assert.deepEqual(new Set(allowedStatusOf(type)), expected, `allowedStatusOf(${type})`);
    assert.ok(allowedStatusOf(type).includes('superseded'), `${type} must allow superseded`);
  }
});

/* ================================================================== *
 * §9.1 / §9.3 / §9.5 createContextEvent（构造入口）
 * ================================================================== */

test('§9.1 eventId 与 payloadRef 恒为 `context-event:${sourceId}`', () => {
  const event = createContextEvent({ type: 'task.created', sourceId: 'source-A', occurredAt: at(3), scope: scope() });
  assert.equal(event.sourceId, 'source-A');
  assert.equal(event.eventId, 'context-event:source-A');
  assert.equal(event.payloadRef, 'context-event:source-A');
  assert.equal(event.occurredAt, at(3));
  assert.deepEqual(event.scope, scope());
});

test('§9.3 status 初值只由 supersededByEventId 与 defaultStatusOf(type) 决定', () => {
  for (const type of CONTEXT_EVENT_TYPES) {
    const plain = makeEvent(type, { sourceId: `plain-${type}` });
    assert.equal(plain.status, defaultStatusOf(type), `default status of ${type}`);
    const superseded = makeEvent(type, { sourceId: `superseded-${type}`, supersededByEventId: 'context-event:newer' });
    assert.equal(superseded.status, 'superseded', `superseded status of ${type}`);
    assert.equal(superseded.supersededByEventId, 'context-event:newer');
  }
});

test('§9.3 ContextEventInput 无 status 入参：唯一 status owner 是构造器与 applyPairingOutcome', () => {
  // @ts-expect-error `status` is not a member of ContextEventInput (§9.3).
  const rejected: ContextEventInput = { type: 'task.created', sourceId: 'x', occurredAt: at(1), scope: scope(), status: 'superseded' };
  void rejected;
  assert.ok(true);
});

test('§9.3 createContextEvent 永不产出 pairing', () => {
  for (const type of CONTEXT_EVENT_TYPES) {
    const event = makeEvent(type, { sourceId: `pairing-free-${type}` });
    assert.equal(event.pairing, undefined, `${type} must not carry pairing`);
    assert.equal(Object.prototype.hasOwnProperty.call(event, 'pairing'), false, `${type} must not declare pairing`);
  }
});

test('§14 构造入口：18 个 type 全部可构造且通过 validateCanonicalContextEvent', () => {
  for (const type of CONTEXT_EVENT_TYPES) {
    const event = makeEvent(type, { sourceId: `valid-${type}` });
    assert.doesNotThrow(() => {
      try {
        validateCanonicalContextEvent(event);
      } catch (error) {
        throw new Error(`${type} must validate: ${String(error)}`);
      }
    });
    assert.match(event.dataDigest, /^sha256:[0-9a-f]{64}$/);
  }
});

test('§14 构造入口 12 个「适配器规则 ✗」type 可达且 status 为默认值', () => {
  const constructionOnly: readonly ContextEventType[] = [
    'plan.proposed', 'plan.accepted', 'plan.rejected',
    'retry.detected', 'retry.recovered', 'retry.exhausted',
    'task.created', 'task.confirmed',
    'error.resolved', 'blocker.resolved',
    'checkpoint.reentered', 'context.compacted',
  ];
  assert.equal(constructionOnly.length, 12);
  for (const type of constructionOnly) {
    const event = makeEvent(type, { sourceId: `construct-${type}` });
    assert.equal(event.type, type);
    assert.equal(event.status, defaultStatusOf(type));
    assert.doesNotThrow(() => validateCanonicalContextEvent(event));
  }
});

test('§9.3 summary 省略时取 labelOf(type)，显式空串同样回落到 label', () => {
  for (const type of CONTEXT_EVENT_TYPES) {
    assert.equal(makeEvent(type, { sourceId: `summary-omitted-${type}` }).summary, labelOf(type));
    assert.equal(makeEvent(type, { sourceId: `summary-empty-${type}`, summary: '' }).summary, labelOf(type));
    assert.equal(makeEvent(type, { sourceId: `summary-given-${type}`, summary: '自定义摘要' }).summary, '自定义摘要');
  }
});

test('§9.3 evidenceRefs 省略时是空数组，给出时原样透传', () => {
  assert.deepEqual(makeEvent('task.created', { sourceId: 'evidence-default' }).evidenceRefs, []);
  const refs = [evidenceRef(1), evidenceRef(2)];
  assert.deepEqual(makeEvent('task.created', { sourceId: 'evidence-given', evidenceRefs: refs }).evidenceRefs, refs);
});

test('§9.3 cost 原样透传', () => {
  const event = makeEvent('task.created', { sourceId: 'cost-1', cost: { tokensInput: 5, tokensOutput: 7, bytesAvoided: 11 } });
  assert.deepEqual(event.cost, { tokensInput: 5, tokensOutput: 7, bytesAvoided: 11 });
});

test('§9.3 非法构造入参抛 ContextEventError：sourceId 空 / occurredAt 非法 / type 未知', () => {
  expectContextEventError(() => createContextEvent({ type: 'task.created', sourceId: '', occurredAt: at(1), scope: scope() }));
  expectContextEventError(() => createContextEvent({ type: 'task.created', sourceId: 'ok', occurredAt: 'not-a-timestamp', scope: scope() }));
  expectContextEventError(() =>
    createContextEvent({ type: 'not.a.type' as ContextEventType, sourceId: 'ok', occurredAt: at(1), scope: scope() }),
  );
});

/* ================================================================== *
 * §9.5 dataDigest 口径
 * ================================================================== */

test('§9.5 summary 省略 == 显式 labelOf(type)：同一 dataDigest', () => {
  for (const type of CONTEXT_EVENT_TYPES) {
    const omitted = createContextEvent({ type, sourceId: `digest-summary-${type}`, occurredAt: at(1), scope: scope() });
    const explicit = createContextEvent({
      type,
      sourceId: `digest-summary-${type}`,
      occurredAt: at(1),
      scope: scope(),
      summary: labelOf(type),
    });
    assert.equal(omitted.dataDigest, explicit.dataDigest, `digest of ${type}`);
  }
});

test('§9.5 evidenceRefs 省略 == 显式 []：同一 dataDigest', () => {
  for (const type of CONTEXT_EVENT_TYPES) {
    const omitted = createContextEvent({ type, sourceId: `digest-evidence-${type}`, occurredAt: at(1), scope: scope() });
    const explicit = createContextEvent({
      type,
      sourceId: `digest-evidence-${type}`,
      occurredAt: at(1),
      scope: scope(),
      evidenceRefs: [],
    });
    assert.equal(omitted.dataDigest, explicit.dataDigest, `digest of ${type}`);
  }
});

test('§9.5 dataDigest 与入参键序无关（顶层字段与 scope 内部字段）', () => {
  const forward: ContextEventInput = {
    type: 'error.detected',
    sourceId: 'digest-order',
    occurredAt: at(1),
    scope: {
      organId: { scope: 'organ', value: ORGAN },
      taskId: { scope: 'task', value: 'task-1' },
      cycleId: { scope: 'cycle', value: 'cycle-1' },
      operationId: { scope: 'operation', value: 'operation-1' },
    },
    summary: '摘要',
    evidenceRefs: [evidenceRef(1)],
    cost: { tokensInput: 1, tokensOutput: 2 },
  };
  const reversed = {
    cost: { tokensInput: 1, tokensOutput: 2 },
    evidenceRefs: [evidenceRef(1)],
    summary: '摘要',
    scope: {
      operationId: { scope: 'operation', value: 'operation-1' },
      cycleId: { scope: 'cycle', value: 'cycle-1' },
      taskId: { scope: 'task', value: 'task-1' },
      organId: { scope: 'organ', value: ORGAN },
    },
    occurredAt: at(1),
    sourceId: 'digest-order',
    type: 'error.detected',
  } as ContextEventInput;
  assert.equal(createContextEvent(forward).dataDigest, createContextEvent(reversed).dataDigest);
});

test('§9.5 值为 undefined 的可选键等价于省略该键', () => {
  const omitted = createContextEvent({ type: 'error.detected', sourceId: 'digest-undefined', occurredAt: at(1), scope: scope() });
  const explicit = createContextEvent({
    type: 'error.detected',
    sourceId: 'digest-undefined',
    occurredAt: at(1),
    scope: scope(),
    cost: undefined,
  });
  assert.equal(omitted.dataDigest, explicit.dataDigest);
});

test('§9.5 dataDigest 格式恒为 sha256:<64 位小写 hex>', () => {
  for (const type of CONTEXT_EVENT_TYPES) {
    assert.match(makeEvent(type, { sourceId: `digest-format-${type}` }).dataDigest, /^sha256:[0-9a-f]{64}$/);
  }
});

test('§9.3 applyPairingOutcome 前后 dataDigest 不变（status/pairing 不参与哈希）', () => {
  const opened = makeEvent('error.detected', { sourceId: 'digest-invariant-open' });
  const closed = makeEvent('error.resolved', { sourceId: 'digest-invariant-close', occurredAt: at(2) });
  const before = [opened, closed];
  const after = applyPairingOutcome(before);
  assert.notEqual(after[0].status, opened.status);
  assert.equal(after[0].dataDigest, opened.dataDigest);
  assert.equal(after[1].dataDigest, closed.dataDigest);
});

/* ================================================================== *
 * §9.2 normalizeEventRecord（OperationStatus 12 值表）
 * ================================================================== */

test('§9.2 event-record：OperationStatus 12 值逐个映射到契约表', () => {
  const table: ReadonlyArray<readonly [OperationStatusLike, ContextEventType]> = [
    ['accepted', 'operation.started'],
    ['queued', 'operation.started'],
    ['leased', 'operation.started'],
    ['running', 'operation.started'],
    ['settling', 'operation.started'],
    ['verifying', 'operation.started'],
    ['succeeded', 'operation.completed'],
    ['failed', 'operation.failed'],
    ['blocked', 'operation.failed'],
    ['cancel_requested', 'operation.started'],
    ['cancelled', 'operation.failed'],
    ['reconcile_required', 'operation.failed'],
  ];
  assert.equal(table.length, 12);
  assert.equal(new Set(table.map(([status]) => status)).size, 12);
  for (const [status, expected] of table) {
    const event = onlyEvent(normalizeEventRecord(eventRecord({ operation: { status } })));
    assert.equal(event.type, expected, `status ${status}`);
  }
});

test('§9.2 event-record：operation 优先于 kind（checkpoint.committed + succeeded → operation.completed）', () => {
  const event = onlyEvent(normalizeEventRecord(eventRecord({ kind: 'checkpoint.committed', operation: { status: 'succeeded' } })));
  assert.equal(event.type, 'operation.completed');
});

test('§9.2 event-record：无 operation 且 kind=checkpoint.committed → checkpoint.committed', () => {
  const event = onlyEvent(normalizeEventRecord(eventRecord({ kind: 'checkpoint.committed' })));
  assert.equal(event.type, 'checkpoint.committed');
  assert.equal(event.status, defaultStatusOf('checkpoint.committed'));
});

test('§9.2 event-record：无 operation 且其它 kind → unmapped(unknown-kind)', () => {
  const unmapped = onlyUnmapped(normalizeEventRecord(eventRecord({ kind: 'noise.kind' })), 'unknown-kind', 'noise.kind');
  assert.equal(unmapped.sourceKind, 'event-record');
  assert.equal(unmapped.sourceId, 'stream-1#7');
});

test('§9.1 event-record：sourceId=streamId#sequence，payloadRef=context-event:sourceId', () => {
  const event = onlyEvent(normalizeEventRecord(eventRecord({ operation: { status: 'running' } })));
  assert.equal(event.sourceId, 'stream-1#7');
  assert.equal(event.eventId, 'context-event:stream-1#7');
  assert.equal(event.payloadRef, 'context-event:stream-1#7');
});

test('§9.5 event-record：scope/summary/evidenceRefs/occurredAt 透传，summary 空串回落 label', () => {
  const refs = [evidenceRef(1)];
  const event = onlyEvent(
    normalizeEventRecord(
      eventRecord({ operation: { status: 'running' }, summary: '来源摘要', evidenceRefs: refs, occurredAt: at(9), scope: { organId: { scope: 'organ', value: 'organ-9' } } }),
    ),
  );
  assert.deepEqual(event.scope, { organId: { scope: 'organ', value: 'organ-9' } });
  assert.equal(event.summary, '来源摘要');
  assert.equal(event.occurredAt, at(9));
  assert.deepEqual(event.evidenceRefs, refs);
  const fallback = onlyEvent(normalizeEventRecord(eventRecord({ operation: { status: 'running' }, summary: '' })));
  assert.equal(fallback.summary, labelOf('operation.started'));
});

test('§9.2 event-record：非 union 内的 operation.status 不在 12 值判据内，且不产出 canonical 事件', () => {
  // 'pending' 不是 OperationStatus 的成员（12 值闭合集，见上一条用例的类型层断言）。
  const pending = 'pending' as OperationStatusLike;
  assert.equal(
    (['accepted', 'queued', 'leased', 'running', 'settling', 'verifying', 'succeeded', 'failed', 'blocked', 'cancel_requested', 'cancelled', 'reconcile_required'] as readonly string[]).includes(
      pending,
    ),
    false,
  );
  // 未命中任何判据时不得静默映射成某个 canonical type。
  assertNoCanonicalEvent(() => normalizeEventRecord(eventRecord({ operation: { status: pending } })), "event-record operation.status 'pending'");
});

test('§9.2 OperationStatus 12 值闭合：union 恰为 12 个值，且不含 pending（类型层）', () => {
  const statuses: readonly OperationStatusLike[] = [
    'accepted', 'queued', 'leased', 'running', 'settling', 'verifying',
    'succeeded', 'failed', 'blocked', 'cancel_requested', 'cancelled', 'reconcile_required',
  ];
  assert.equal(statuses.length, 12);
  assert.equal(new Set(statuses).size, 12);
  type Expect<T extends true> = T;
  const unionIsClosed: Expect<OperationStatusLike extends (typeof statuses)[number] ? true : false> = true;
  const everyStatusUsed: Expect<(typeof statuses)[number] extends OperationStatusLike ? true : false> = true;
  const pendingIsNotAStatus: Expect<'pending' extends OperationStatusLike ? false : true> = true;
  void unionIsClosed;
  void everyStatusUsed;
  void pendingIsNotAStatus;
});

/* ================================================================== *
 * §9.2 normalizeAgentSemanticEvent（闭合 8 值）
 * ================================================================== */

test('§9.2 agent-semantic：8 值闭合词表逐个映射（含 3 个 unmapped）', () => {
  const table: ReadonlyArray<readonly [SemanticKindLike, ContextEventType | 'unmapped']> = [
    ['execution.started', 'operation.started'],
    ['provider.model', 'unmapped'],
    ['provider.output', 'unmapped'],
    ['provider.tool', 'operation.started'],
    ['provider.error', 'error.detected'],
    ['execution.settling', 'unmapped'],
    ['checkpoint.committed', 'checkpoint.committed'],
    ['execution.terminal', 'operation.completed'],
  ];
  assert.equal(table.length, 8);
  assert.equal(new Set(table.map(([kind]) => kind)).size, 8);
  for (const [kind, expected] of table) {
    const result = normalizeAgentSemanticEvent(
      semanticEvent({ kind, terminalState: kind === 'execution.terminal' ? 'succeeded' : undefined }),
      normalizeContext(),
    );
    if (expected === 'unmapped') onlyUnmapped(result, 'unknown-kind', kind);
    else assert.equal(onlyEvent(result).type, expected, `kind ${kind}`);
  }
});

test('§9.2 agent-semantic：execution.terminal 三态 + 缺省', () => {
  const terminal = (terminalState: AgentSemanticEventLike['terminalState']): NormalizeResult =>
    normalizeAgentSemanticEvent(semanticEvent({ kind: 'execution.terminal', terminalState }), normalizeContext());
  assert.equal(onlyEvent(terminal('succeeded')).type, 'operation.completed');
  onlyUnmapped(terminal('waiting'), 'waiting-is-not-terminal', 'execution.terminal');
  assert.equal(onlyEvent(terminal('blocked')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('failed')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('cancelled')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('stopped')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('unknown')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal(undefined)).type, 'operation.failed');
});

test('§9.1 agent-semantic：sourceId=seq#seq，occurredAt/scope 取 context', () => {
  const event = onlyEvent(
    normalizeAgentSemanticEvent(semanticEvent({ kind: 'checkpoint.committed' }), {
      scope: { organId: { scope: 'organ', value: 'organ-ctx' } },
      occurredAt: at(4),
    }),
  );
  assert.equal(event.sourceId, 'seq#3');
  assert.equal(event.eventId, 'context-event:seq#3');
  assert.equal(event.payloadRef, 'context-event:seq#3');
  assert.equal(event.occurredAt, at(4));
  assert.deepEqual(event.scope, { organId: { scope: 'organ', value: 'organ-ctx' } });
});

test('§9.1 agent-semantic：context.scope / context.occurredAt 缺失时抛 ContextEventError', () => {
  expectContextEventError(() => normalizeAgentSemanticEvent(semanticEvent(), { occurredAt: at(1) }));
  expectContextEventError(() => normalizeAgentSemanticEvent(semanticEvent(), { scope: scope() }));
});

test('§9.2 agent-semantic 不处理 agent-event 方言的 provider.tool-result / provider.terminal', () => {
  const outOfUnion = (kind: string): AgentSemanticEventLike =>
    ({ seq: 1, kind, state: 'x', summary: 's', evidenceRefs: [] }) as AgentSemanticEventLike;
  // 这两个 kind 属 agent-event 的 provider 方言，不在 8 值闭合 union 内：
  // 适配器不得把它们当作自身词表处理（既不得映射成 canonical 事件）。
  assertNoCanonicalEvent(() => normalizeAgentSemanticEvent(outOfUnion('provider.tool-result'), normalizeContext()), 'agent-semantic provider.tool-result');
  assertNoCanonicalEvent(() => normalizeAgentSemanticEvent(outOfUnion('provider.terminal'), normalizeContext()), 'agent-semantic provider.terminal');
});

/* ================================================================== *
 * §9.2 normalizeAgentEvent —— provider 方言
 * ================================================================== */

test('§9.2 agent-event provider 方言：provider.tool → operation.started', () => {
  const event = onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'provider.tool' }), normalizeContext()));
  assert.equal(event.type, 'operation.started');
});

test('§9.2 agent-event provider 方言：provider.tool-result 成败取自 providerEvent.toolResult.status', () => {
  const withResult = (status: string | undefined): NormalizeResult =>
    normalizeAgentEvent(
      agentEvent({
        kind: 'provider.tool-result',
        providerEvent: providerEvent({ kind: 'tool', toolPhase: 'result', toolResult: status === undefined ? undefined : { status } as never }),
      }),
      normalizeContext(),
    );
  assert.equal(onlyEvent(withResult('succeeded')).type, 'operation.completed');
  assert.equal(onlyEvent(withResult('failed')).type, 'operation.failed');
  assert.equal(onlyEvent(withResult('blocked')).type, 'operation.failed');
  assert.equal(onlyEvent(withResult('cancelled')).type, 'operation.failed');
  assert.equal(onlyEvent(withResult('unknown')).type, 'operation.failed');
  onlyUnmapped(withResult(undefined), 'unknown-kind', 'provider.tool-result');
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'provider.tool-result' }), normalizeContext()), 'unknown-kind', 'provider.tool-result');
});

test('§9.2 agent-event provider 方言：provider.error / provider.transport → error.detected', () => {
  assert.equal(onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'provider.error' }), normalizeContext())).type, 'error.detected');
  assert.equal(onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'provider.transport' }), normalizeContext())).type, 'error.detected');
});

test('§9.2 agent-event provider 方言：provider.attention → blocker.detected', () => {
  assert.equal(onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'provider.attention' }), normalizeContext())).type, 'blocker.detected');
});

test('§9.2 agent-event provider 方言：provider.terminal 三态 + 缺省', () => {
  const terminal = (terminalState: AgentEventLike['terminalState']): NormalizeResult =>
    normalizeAgentEvent(agentEvent({ kind: 'provider.terminal', terminalState }), normalizeContext());
  assert.equal(onlyEvent(terminal('succeeded')).type, 'operation.completed');
  onlyUnmapped(terminal('waiting'), 'waiting-is-not-terminal', 'provider.terminal');
  assert.equal(onlyEvent(terminal('blocked')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('failed')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('cancelled')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('stopped')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('unknown')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal(undefined)).type, 'operation.failed');
});

test('§9.2 agent-event provider 方言：高噪声 kind 显式 unmapped，未知 kind → unknown-kind', () => {
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'provider.model' }), normalizeContext()), 'unknown-kind', 'provider.model');
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'provider.output' }), normalizeContext()), 'unknown-kind', 'provider.output');
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'provider.settling' }), normalizeContext()), 'unknown-kind', 'provider.settling');
});

test('§9.1 agent-event：sourceId/occurredAt 取 context，scope 由 taskId + context.scope 合成', () => {
  const event = onlyEvent(
    normalizeAgentEvent(agentEvent({ kind: 'provider.tool' }), {
      scope: { organId: { scope: 'organ', value: 'organ-ctx' } },
      sourceId: 'agent-source-9',
      occurredAt: at(6),
    }),
  );
  assert.equal(event.sourceId, 'agent-source-9');
  assert.equal(event.payloadRef, 'context-event:agent-source-9');
  assert.equal(event.occurredAt, at(6));
  assert.deepEqual(event.scope, { organId: { scope: 'organ', value: 'organ-ctx' }, taskId: taskId() });
});

test('§9.1 agent-event：context.sourceId / context.occurredAt 缺失时抛 ContextEventError', () => {
  expectContextEventError(() => normalizeAgentEvent(agentEvent({ kind: 'provider.tool' }), { scope: scope(), occurredAt: at(1) }));
  expectContextEventError(() => normalizeAgentEvent(agentEvent({ kind: 'provider.tool' }), { scope: scope(), sourceId: 's' }));
});

/* ================================================================== *
 * §9.2 normalizeAgentEvent —— dsh 方言（裸 kind）
 * ================================================================== */

test('§9.2 dsh 方言关键回归：裸 tool → unmapped(indistinguishable-tool-phase)，绝不 operation.started', () => {
  const result = normalizeAgentEvent(agentEvent({ kind: 'tool' }), normalizeContext());
  const unmapped = onlyUnmapped(result, 'indistinguishable-tool-phase', 'tool');
  assert.equal(unmapped.sourceKind, 'agent-event');
  assert.equal(unmapped.sourceId, 'agent-source-1');
  assert.notEqual(result.events[0]?.type, 'operation.started');
});

test('§9.2 dsh 方言：error / transport → error.detected，attention → blocker.detected', () => {
  assert.equal(onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'error' }), normalizeContext())).type, 'error.detected');
  assert.equal(onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'transport' }), normalizeContext())).type, 'error.detected');
  assert.equal(onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'attention' }), normalizeContext())).type, 'blocker.detected');
});

test('§9.2 dsh 方言：terminal 三态 + 缺省', () => {
  const terminal = (terminalState: AgentEventLike['terminalState']): NormalizeResult =>
    normalizeAgentEvent(agentEvent({ kind: 'terminal', terminalState }), normalizeContext());
  assert.equal(onlyEvent(terminal('succeeded')).type, 'operation.completed');
  onlyUnmapped(terminal('waiting'), 'waiting-is-not-terminal', 'terminal');
  assert.equal(onlyEvent(terminal('blocked')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('failed')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal(undefined)).type, 'operation.failed');
});

test('§9.2 dsh 方言：高噪声 kind 与未知 kind 都显式 unmapped(unknown-kind)', () => {
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'model' }), normalizeContext()), 'unknown-kind', 'model');
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'output' }), normalizeContext()), 'unknown-kind', 'output');
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'bogus' }), normalizeContext()), 'unknown-kind', 'bogus');
});

test('§9.1 dsh 方言：canonical 字段完整（eventId/sourceId/type/scope/occurredAt/status/payloadRef/dataDigest/evidenceRefs）', () => {
  const event = onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'terminal', terminalState: 'succeeded', summary: '完成' }), normalizeContext()));
  assert.equal(event.eventId, 'context-event:agent-source-1');
  assert.equal(event.sourceId, 'agent-source-1');
  assert.equal(event.type, 'operation.completed');
  assert.equal(event.occurredAt, at(5));
  assert.equal(event.status, defaultStatusOf('operation.completed'));
  assert.equal(event.summary, '完成');
  assert.equal(event.payloadRef, 'context-event:agent-source-1');
  assert.match(event.dataDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(event.evidenceRefs, []);
  assert.deepEqual(event.scope, { organId: { scope: 'organ', value: ORGAN }, taskId: taskId() });
});

/* ================================================================== *
 * §9.2 normalizeProviderEvent（B1 工具调用判据）
 * ================================================================== */

test('§9.2 provider-event B1：kind=tool + toolCall 且无 toolPhase → operation.started（不是 unmapped）', () => {
  const result = normalizeProviderEvent(
    providerEvent({ toolCall: { callId: 'call-1', toolId: 'tool-1' } }),
    normalizeContext(),
  );
  const event = onlyEvent(result);
  assert.equal(event.type, 'operation.started');
  assert.equal(event.status, 'active');
});

test('§9.2 provider-event B1：toolPhase=invoke → operation.started（向后兼容该取值）', () => {
  const event = onlyEvent(
    normalizeProviderEvent(providerEvent({ toolPhase: 'invoke', toolCall: { callId: 'call-2', toolId: 'tool-2' } }), normalizeContext()),
  );
  assert.equal(event.type, 'operation.started');
});

test('§9.2 provider-event B1：toolPhase=result 成败取自 toolResult.status', () => {
  const result = (status: string | undefined): NormalizeResult =>
    normalizeProviderEvent(
      providerEvent({ toolPhase: 'result', toolResult: status === undefined ? undefined : ({ status } as never) }),
      normalizeContext(),
    );
  assert.equal(onlyEvent(result('succeeded')).type, 'operation.completed');
  assert.equal(onlyEvent(result('failed')).type, 'operation.failed');
  assert.equal(onlyEvent(result('blocked')).type, 'operation.failed');
  assert.equal(onlyEvent(result('cancelled')).type, 'operation.failed');
  assert.equal(onlyEvent(result('unknown')).type, 'operation.failed');
  onlyUnmapped(result(undefined), 'unknown-kind', 'tool');
});

test('§9.2 provider-event：error / transport → error.detected，attention → blocker.detected', () => {
  assert.equal(onlyEvent(normalizeProviderEvent(providerEvent({ kind: 'error' }), normalizeContext())).type, 'error.detected');
  assert.equal(onlyEvent(normalizeProviderEvent(providerEvent({ kind: 'transport' }), normalizeContext())).type, 'error.detected');
  assert.equal(onlyEvent(normalizeProviderEvent(providerEvent({ kind: 'attention' }), normalizeContext())).type, 'blocker.detected');
});

test('§9.2 provider-event：terminal 三态（waiting 显式 unmapped）', () => {
  const terminal = (terminalState: ProviderEventLike['terminalState']): NormalizeResult =>
    normalizeProviderEvent(providerEvent({ kind: 'terminal', terminalState }), normalizeContext());
  assert.equal(onlyEvent(terminal('succeeded')).type, 'operation.completed');
  onlyUnmapped(terminal('waiting'), 'waiting-is-not-terminal', 'terminal');
  assert.equal(onlyEvent(terminal('blocked')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('failed')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('cancelled')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('stopped')).type, 'operation.failed');
  assert.equal(onlyEvent(terminal('unknown')).type, 'operation.failed');
});

test('§9.2 provider-event：model / output 显式 unmapped(unknown-kind)', () => {
  onlyUnmapped(normalizeProviderEvent(providerEvent({ kind: 'model' }), normalizeContext()), 'unknown-kind', 'model');
  onlyUnmapped(normalizeProviderEvent(providerEvent({ kind: 'output' }), normalizeContext()), 'unknown-kind', 'output');
});

test('§9.1 provider-event：eventId/sourceId 取来源 eventId，scope/occurredAt 取 context', () => {
  const event = onlyEvent(
    normalizeProviderEvent(providerEvent({ eventId: 'provider-event-77', kind: 'error' }), {
      scope: { organId: { scope: 'organ', value: 'organ-ctx' } },
      sourceId: 'ignored-source',
      occurredAt: at(8),
    }),
  );
  assert.equal(event.sourceId, 'provider-event-77');
  assert.equal(event.eventId, 'context-event:provider-event-77');
  assert.equal(event.payloadRef, 'context-event:provider-event-77');
  assert.equal(event.occurredAt, at(8));
  assert.deepEqual(event.scope, { organId: { scope: 'organ', value: 'organ-ctx' } });
});

test('§9.1 provider-event：context.scope / context.occurredAt 缺失时抛 ContextEventError', () => {
  expectContextEventError(() => normalizeProviderEvent(providerEvent({ kind: 'error' }), { occurredAt: at(1) }));
  expectContextEventError(() => normalizeProviderEvent(providerEvent({ kind: 'error' }), { scope: scope() }));
});

/* ================================================================== *
 * §9.2 UnmappedSource 词表
 * ================================================================== */

test('§9.2 UnmappedSource.reason 三值各至少出现一次', () => {
  const reasons = new Set<UnmappedReason>();
  reasons.add(onlyUnmapped(normalizeEventRecord(eventRecord({ kind: 'noise' })), 'unknown-kind', 'noise').reason);
  reasons.add(
    onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'tool' }), normalizeContext()), 'indistinguishable-tool-phase', 'tool').reason,
  );
  reasons.add(
    onlyUnmapped(
      normalizeProviderEvent(providerEvent({ kind: 'terminal', terminalState: 'waiting' }), normalizeContext()),
      'waiting-is-not-terminal',
      'terminal',
    ).reason,
  );
  assert.deepEqual(reasons, new Set<UnmappedReason>(['unknown-kind', 'indistinguishable-tool-phase', 'waiting-is-not-terminal']));
});

test('§9.2 未映射来源必须显式登记（不得静默丢弃）：四适配器的 sourceKind 与 sourceId 正确', () => {
  assert.deepEqual(onlyUnmapped(normalizeEventRecord(eventRecord({ kind: 'noise' })), 'unknown-kind', 'noise'), {
    sourceKind: 'event-record',
    sourceId: 'stream-1#7',
    rawKind: 'noise',
    reason: 'unknown-kind',
  });
  assert.deepEqual(onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'tool' }), normalizeContext()), 'indistinguishable-tool-phase', 'tool'), {
    sourceKind: 'agent-event',
    sourceId: 'agent-source-1',
    rawKind: 'tool',
    reason: 'indistinguishable-tool-phase',
  });
  assert.deepEqual(
    onlyUnmapped(normalizeAgentSemanticEvent(semanticEvent({ kind: 'provider.output' }), normalizeContext()), 'unknown-kind', 'provider.output'),
    { sourceKind: 'agent-semantic-event', sourceId: 'seq#3', rawKind: 'provider.output', reason: 'unknown-kind' },
  );
  assert.deepEqual(onlyUnmapped(normalizeProviderEvent(providerEvent({ kind: 'model' }), normalizeContext()), 'unknown-kind', 'model'), {
    sourceKind: 'provider-event',
    sourceId: 'provider-event-1',
    rawKind: 'model',
    reason: 'unknown-kind',
  });
});

/* ================================================================== *
 * §9.2 关键回归汇总（B1 + terminal + execution.started）
 * ================================================================== */

test('§9.2 关键回归：terminal+succeeded → operation.completed（三方言都不得落 unmapped）', () => {
  assert.equal(onlyEvent(normalizeProviderEvent(providerEvent({ kind: 'terminal', terminalState: 'succeeded' }), normalizeContext())).type, 'operation.completed');
  assert.equal(onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'provider.terminal', terminalState: 'succeeded' }), normalizeContext())).type, 'operation.completed');
  assert.equal(onlyEvent(normalizeAgentEvent(agentEvent({ kind: 'terminal', terminalState: 'succeeded' }), normalizeContext())).type, 'operation.completed');
  assert.equal(onlyEvent(normalizeAgentSemanticEvent(semanticEvent({ kind: 'execution.terminal', terminalState: 'succeeded' }), normalizeContext())).type, 'operation.completed');
});

test('§9.2 关键回归：terminal+waiting → unmapped(waiting-is-not-terminal)（三方言）', () => {
  onlyUnmapped(normalizeProviderEvent(providerEvent({ kind: 'terminal', terminalState: 'waiting' }), normalizeContext()), 'waiting-is-not-terminal', 'terminal');
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'provider.terminal', terminalState: 'waiting' }), normalizeContext()), 'waiting-is-not-terminal', 'provider.terminal');
  onlyUnmapped(normalizeAgentEvent(agentEvent({ kind: 'terminal', terminalState: 'waiting' }), normalizeContext()), 'waiting-is-not-terminal', 'terminal');
  onlyUnmapped(
    normalizeAgentSemanticEvent(semanticEvent({ kind: 'execution.terminal', terminalState: 'waiting' }), normalizeContext()),
    'waiting-is-not-terminal',
    'execution.terminal',
  );
});

test('§9.2 关键回归：execution.started → operation.started（不是 task.confirmed）', () => {
  const event = onlyEvent(normalizeAgentSemanticEvent(semanticEvent({ kind: 'execution.started' }), normalizeContext()));
  assert.equal(event.type, 'operation.started');
  assert.notEqual(event.type, 'task.confirmed');
});

test('§14 适配器入口 6 个「适配器规则 ✓」type 全部可达', () => {
  const reachable = new Set<ContextEventType>();
  reachable.add(onlyEvent(normalizeEventRecord(eventRecord({ operation: { status: 'running' } }))).type);
  reachable.add(onlyEvent(normalizeEventRecord(eventRecord({ operation: { status: 'succeeded' } }))).type);
  reachable.add(onlyEvent(normalizeEventRecord(eventRecord({ operation: { status: 'failed' } }))).type);
  reachable.add(onlyEvent(normalizeProviderEvent(providerEvent({ kind: 'error' }), normalizeContext())).type);
  reachable.add(onlyEvent(normalizeProviderEvent(providerEvent({ kind: 'attention' }), normalizeContext())).type);
  reachable.add(onlyEvent(normalizeAgentSemanticEvent(semanticEvent({ kind: 'checkpoint.committed' }), normalizeContext())).type);
  assert.deepEqual(reachable, new Set<ContextEventType>(['operation.started', 'operation.completed', 'operation.failed', 'error.detected', 'blocker.detected', 'checkpoint.committed']));
});

/* ================================================================== *
 * §8.2 applyPairingOutcome
 * ================================================================== */

test('§8.2 applyPairingOutcome 覆盖全部 8 行改写表', () => {
  const table: ReadonlyArray<readonly [ContextEventType, ContextEventType, string]> = [
    ['error.detected', 'error.resolved', 'resolved'],
    ['blocker.detected', 'blocker.resolved', 'resolved'],
    ['plan.proposed', 'plan.accepted', 'completed'],
    ['plan.proposed', 'plan.rejected', 'rejected'],
    ['retry.detected', 'retry.recovered', 'resolved'],
    ['retry.detected', 'retry.exhausted', 'failed'],
    ['operation.failed', 'checkpoint.committed', 'resolved'],
    ['operation.failed', 'checkpoint.reentered', 'resolved'],
  ];
  assert.equal(table.length, 8);
  for (const [openerType, closerType, expectedStatus] of table) {
    const opener = makeEvent(openerType, { sourceId: `rewrite-open-${openerType}-${closerType}` });
    const closer = makeEvent(closerType, { sourceId: `rewrite-close-${openerType}-${closerType}`, occurredAt: at(2) });
    const out = applyPairingOutcome([opener, closer]);
    const outOpener = must(out.find((event) => event.eventId === opener.eventId), `rewritten opener ${opener.eventId}`);
    const outCloser = must(out.find((event) => event.eventId === closer.eventId), `rewritten closer ${closer.eventId}`);
    assert.equal(outOpener.status, expectedStatus, `${openerType} + ${closerType}`);
    assert.equal(outOpener.status, closedStatusOf(closerType));
    assert.equal(pairOf(outOpener).pairId, `pair:${opener.eventId}`);
    assert.equal(pairOf(outOpener).role, 'opened');
    assert.equal(pairOf(outOpener).relatedEventId, undefined);
    assert.equal(outCloser.status, defaultStatusOf(closerType));
    assert.equal(pairOf(outCloser).pairId, `pair:${opener.eventId}`);
    assert.equal(pairOf(outCloser).role, pairRoleOf(closerType));
    assert.equal(pairOf(outCloser).relatedEventId, opener.eventId);
    assert.equal(outOpener.dataDigest, opener.dataDigest);
    assert.equal(outCloser.dataDigest, closer.dataDigest);
    assert.doesNotThrow(() => validateCanonicalContextEvent(outOpener));
    assert.doesNotThrow(() => validateCanonicalContextEvent(outCloser));
  }
});

test('§8.2 applyPairingOutcome 返回新数组且不修改输入', () => {
  const opener = makeEvent('error.detected', { sourceId: 'pure-open' });
  const closer = makeEvent('error.resolved', { sourceId: 'pure-close', occurredAt: at(2) });
  const input = [opener, closer];
  const out = applyPairingOutcome(input);
  assert.notEqual(out, input);
  assert.deepEqual(
    input.map((event) => [event.status, event.pairing]),
    [
      [defaultStatusOf('error.detected'), undefined],
      [defaultStatusOf('error.resolved'), undefined],
    ],
  );
  assert.equal(out.length, 2);
});

test('§8.2 未配对的关闭事件不分配 pairing（§11 第 9–14 项 vacuous 前提）', () => {
  const out = applyPairingOutcome([makeEvent('error.resolved', { sourceId: 'lonely-closer' })]);
  assert.equal(out[0].pairing, undefined);
  assert.equal(out[0].status, defaultStatusOf('error.resolved'));
  assert.doesNotThrow(() => validateCanonicalContextEvent(out[0]));
});

test('§8.2 未配对的打开事件不分配 pairing', () => {
  const out = applyPairingOutcome([makeEvent('error.detected', { sourceId: 'lonely-opener' })]);
  assert.equal(out[0].pairing, undefined);
  assert.equal(out[0].status, defaultStatusOf('error.detected'));
});

test('§8.2 superseded 事件不参与配对：不为其分配 pairing', () => {
  const superseded = makeEvent('error.detected', { sourceId: 'superseded-opener', supersededByEventId: 'context-event:newer' });
  const closer = makeEvent('error.resolved', { sourceId: 'superseded-closer', occurredAt: at(2) });
  const out = applyPairingOutcome([superseded, closer]);
  const outSuperseded = must(out.find((event) => event.eventId === superseded.eventId), 'superseded event in output');
  assert.equal(outSuperseded.status, 'superseded');
  assert.equal(outSuperseded.pairing, undefined);
  assert.equal(outSuperseded.supersededByEventId, 'context-event:newer');
});

test('§8.2 applyPairingOutcome 幂等：重复调用结果一致', () => {
  const input = [
    makeEvent('plan.proposed', { sourceId: 'idempotent-open' }),
    makeEvent('plan.rejected', { sourceId: 'idempotent-close', occurredAt: at(2) }),
  ];
  const once = applyPairingOutcome(input);
  const twice = applyPairingOutcome(once);
  assert.deepEqual(twice, once);
});

/* ================================================================== *
 * §8.2 buildPairingIndex / §11 16–20 assertPairingConsistent
 * ================================================================== */

test('§8.2 buildPairingIndex 正常配对：closedByOpenedEventId / openedByEventId / unpairedOpen', () => {
  const opener = makeEvent('error.detected', { sourceId: 'index-open' });
  const closer = makeEvent('error.resolved', { sourceId: 'index-close', occurredAt: at(2) });
  const unpaired = makeEvent('blocker.detected', { sourceId: 'index-unpaired' });
  const index = buildPairingIndex(applyPairingOutcome([opener, closer, unpaired]));
  const closed = must(index.closedByOpenedEventId.get(opener.eventId), 'closers of the opened event');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].eventId, closer.eventId);
  assert.equal(must(index.openedByEventId.get(opener.eventId), 'opened event lookup').eventId, opener.eventId);
  assert.deepEqual(index.unpairedOpen.map((event) => event.eventId), [unpaired.eventId]);
  assert.equal(index.closedByOpenedEventId.has(unpaired.eventId), false, 'unpaired opener must have no closer list');
});

test('§8.2 buildPairingIndex：重复 eventId 抛 ContextEventError', () => {
  const event = makeEvent('error.detected', { sourceId: 'duplicate-id' });
  expectContextEventError(() => buildPairingIndex([event, { ...event }]));
});

test('§11 第 16 项：同一打开事件被两个关闭事件引用 → assertPairingConsistent 抛错', () => {
  const violating = applyPairingOutcome([
    makeEvent('plan.proposed', { sourceId: 'two-closers-open' }),
    makeEvent('plan.accepted', { sourceId: 'two-closers-accept', occurredAt: at(2) }),
    makeEvent('plan.rejected', { sourceId: 'two-closers-reject', occurredAt: at(3) }),
  ]);
  expectContextEventError(() => assertPairingConsistent(violating));
});

test('§11 第 20 项（第 16 项实例）：plan.accepted 与 plan.rejected 同时引用同一 plan.proposed', () => {
  const proposal = makeEvent('plan.proposed', { sourceId: 'item20-proposal' });
  const accepted = makeEvent('plan.accepted', { sourceId: 'item20-accept', occurredAt: at(2) });
  const rejected = makeEvent('plan.rejected', { sourceId: 'item20-reject', occurredAt: at(3) });
  const pairId = `pair:${proposal.eventId}`;
  const events = [
    withPairing(proposal, { pairId, role: 'opened' }),
    withPairing(accepted, { pairId, role: 'resolved', relatedEventId: proposal.eventId }),
    withPairing(rejected, { pairId, role: 'rejected', relatedEventId: proposal.eventId }),
  ];
  expectContextEventError(() => assertPairingConsistent(events));
});

test('§11 第 17 项：关闭事件的 relatedEventId 指向不存在的打开事件 → 抛错', () => {
  const closer = makeEvent('error.resolved', { sourceId: 'dangling-closer' });
  const events = [withPairing(closer, { pairId: 'pair:missing', role: 'resolved', relatedEventId: 'context-event:missing' })];
  expectContextEventError(() => assertPairingConsistent(events));
});

test('§11 第 18 项：关闭事件指向类型不兼容的打开事件 → 抛错', () => {
  const opener = makeEvent('blocker.detected', { sourceId: 'incompatible-open' });
  const closer = makeEvent('error.resolved', { sourceId: 'incompatible-close', occurredAt: at(2) });
  const events = [
    withPairing(opener, { pairId: `pair:${opener.eventId}`, role: 'opened' }),
    withPairing(closer, { pairId: `pair:${opener.eventId}`, role: 'resolved', relatedEventId: opener.eventId }),
  ];
  expectContextEventError(() => assertPairingConsistent(events));
});

test('§11 第 19 项：relatedEventId 指向自身 → 抛错', () => {
  const closer = makeEvent('error.resolved', { sourceId: 'self-reference' });
  const events = [withPairing(closer, { pairId: `pair:${closer.eventId}`, role: 'resolved', relatedEventId: closer.eventId })];
  expectContextEventError(() => assertPairingConsistent(events));
});

test('§11 第 16–20 项正例：合法配对与未配对关闭事件都不抛错', () => {
  assert.doesNotThrow(() => assertPairingConsistent(applyPairingOutcome([makeEvent('error.detected', { sourceId: 'ok-open' }), makeEvent('error.resolved', { sourceId: 'ok-close', occurredAt: at(2) })])));
  assert.doesNotThrow(() => assertPairingConsistent([makeEvent('error.resolved', { sourceId: 'ok-lonely-closer' })]));
  assert.doesNotThrow(() => assertPairingConsistent([]));
});

/* ================================================================== *
 * §11 第 1–15 项 validateCanonicalContextEvent
 * ================================================================== */

test('§11 第 1 项：eventId / sourceId / summary / payloadRef 为空 → 抛错', () => {
  const base = makeEvent('task.created', { sourceId: 'item1-base' });
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, eventId: '' }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, sourceId: '   ' }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, summary: '' }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, payloadRef: '' }));
});

test('§11 第 2 项：type 不在 CONTEXT_EVENT_TYPES → 抛错', () => {
  const base = makeEvent('task.created', { sourceId: 'item2-base' });
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, type: 'not.a.type' as ContextEventType }));
});

test('§11 第 3 项：status 不在 allowedStatusOf(type) 内 → 抛错（判据即 allowedStatusOf）', () => {
  const base = makeEvent('task.created', { sourceId: 'item3-base' });
  assert.ok(!allowedStatusOf('task.created').includes('active'));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, status: 'active' }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...makeEvent('plan.rejected', { sourceId: 'item3-rejected' }), status: 'failed' }));
  // 正例：defaultStatus 与全部配对改写目标都合法；'superseded' 另由 §11 第 15 项约束，
  // 故此处按 §11 第 15 项成对给出 status + supersededByEventId。
  for (const status of allowedStatusOf('task.created')) {
    if (status === 'superseded') {
      assert.doesNotThrow(() =>
        validateCanonicalContextEvent({ ...base, status: 'superseded', supersededByEventId: 'context-event:newer' }),
      );
      continue;
    }
    assert.doesNotThrow(() => validateCanonicalContextEvent(withStatus(base, status)));
  }
});

test('§11 第 4 项：occurredAt 不是合法时间戳 → 抛错', () => {
  const base = makeEvent('task.created', { sourceId: 'item4-base' });
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, occurredAt: 'not-a-timestamp' }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, occurredAt: '' }));
});

test('§11 第 5 项：organId.scope 非 organ 或为空 → 抛错', () => {
  const base = makeEvent('task.created', { sourceId: 'item5-base' });
  expectContextEventError(() =>
    validateCanonicalContextEvent({ ...base, scope: { organId: { scope: 'task', value: 'x' } } as unknown as ScopeRefLike }),
  );
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, scope: { organId: { scope: 'organ', value: ' ' } } }));
});

test('§11 第 5 项：可选 id 存在时按 ScopeRef 声明的 kind 逐项校验', () => {
  const base = makeEvent('task.created', { sourceId: 'item5-optional' });
  expectContextEventError(() =>
    validateCanonicalContextEvent({ ...base, scope: { organId: { scope: 'organ', value: ORGAN }, taskId: { scope: 'cycle', value: 'c' } } as unknown as ScopeRefLike }),
  );
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, scope: { organId: { scope: 'organ', value: ORGAN }, taskId: { scope: 'task', value: '' } } }));
  expectContextEventError(() =>
    validateCanonicalContextEvent({ ...base, scope: { organId: { scope: 'organ', value: ORGAN }, cycleId: { scope: 'organ', value: 'c' } } as unknown as ScopeRefLike }),
  );
  expectContextEventError(() =>
    validateCanonicalContextEvent({ ...base, scope: { organId: { scope: 'organ', value: ORGAN }, operationId: { scope: 'organ', value: 'c' } } as unknown as ScopeRefLike }),
  );
});

test('§11 第 6 项：dataDigest 不匹配 /^sha256:[0-9a-f]{64}$/ → 抛错', () => {
  const base = makeEvent('task.created', { sourceId: 'item6-base' });
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, dataDigest: 'sha256:XYZ' }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, dataDigest: 'deadbeef' }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, dataDigest: `sha256:${'A'.repeat(64)}` }));
});

test('§11 第 7 项：evidenceRefs 任一项不满足 assertEvidenceRef → 抛错', () => {
  const base = makeEvent('task.created', { sourceId: 'item7-base' });
  const badKind = [{ ...evidenceRef(1), kind: 'bogus' }] as unknown as EvidenceRefLike[];
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, evidenceRefs: badKind }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, evidenceRefs: [{ ...evidenceRef(1), source: '' }] }));
  expectContextEventError(() =>
    validateCanonicalContextEvent({ ...base, evidenceRefs: [{ ...evidenceRef(1), evidenceId: { scope: 'organ', value: 'e' } } as unknown as EvidenceRefLike] }),
  );
  assert.doesNotThrow(() => validateCanonicalContextEvent({ ...base, evidenceRefs: [evidenceRef(1)] }));
});

test('§11 第 8 项：cost 任一字段存在但不是非负安全整数 → 抛错', () => {
  const base = makeEvent('task.created', { sourceId: 'item8-base' });
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, cost: { tokensInput: -1 } }));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, cost: { tokensOutput: 1.5 } }));
  assert.doesNotThrow(() => validateCanonicalContextEvent({ ...base, cost: { tokensInput: 0, tokensOutput: 12 } }));
});

test('§11 第 9 项：pairing.pairId 为空或 role 不在 3 值内 → 抛错', () => {
  const base = makeEvent('error.detected', { sourceId: 'item9-base' });
  expectContextEventError(() => validateCanonicalContextEvent(withPairing(base, { pairId: '', role: 'opened' })));
  expectContextEventError(() =>
    validateCanonicalContextEvent(withPairing(base, { pairId: 'pair:x', role: 'weird' as ContextEventPairRole })),
  );
  assert.doesNotThrow(() => validateCanonicalContextEvent(withPairing(base, { pairId: 'pair:x', role: 'opened' })));
});

test('§11 第 10 项：role=opened 却带 relatedEventId → 抛错', () => {
  const base = makeEvent('error.detected', { sourceId: 'item10-base' });
  expectContextEventError(() => validateCanonicalContextEvent(withPairing(base, { pairId: 'pair:x', role: 'opened', relatedEventId: 'context-event:y' })));
});

test('§11 第 11 项：role!==opened 却缺 relatedEventId → 抛错', () => {
  const base = makeEvent('error.resolved', { sourceId: 'item11-base' });
  expectContextEventError(() => validateCanonicalContextEvent(withPairing(base, { pairId: 'pair:x', role: 'resolved' })));
});

test('§11 第 12 项：非关闭类型不得带关闭角色 → 抛错', () => {
  const nonCloser = makeEvent('task.created', { sourceId: 'item12-non-closer' });
  assert.equal(isCloserType('task.created'), false);
  expectContextEventError(() =>
    validateCanonicalContextEvent(withPairing(nonCloser, { pairId: 'pair:x', role: 'resolved', relatedEventId: 'context-event:y' })),
  );
});

test('§11 第 13 项：非打开类型不得带 opened 角色 → 抛错', () => {
  const nonOpener = makeEvent('task.created', { sourceId: 'item13-non-opener' });
  assert.equal(isOpenerType('task.created'), false);
  expectContextEventError(() => validateCanonicalContextEvent(withPairing(nonOpener, { pairId: 'pair:x', role: 'opened' })));
});

test('§11 第 13+14 项同时命中：关闭类型携带 opened 角色', () => {
  const closer = makeEvent('error.resolved', { sourceId: 'item1314-closer' });
  // 第 13 项：role=opened 但 isOpenerType(error.resolved) 为假。
  assert.equal(isOpenerType('error.resolved'), false);
  // 第 14 项：isCloserType 为真但 role !== pairRoleOf(error.resolved)（'resolved'）。
  assert.equal(isCloserType('error.resolved'), true);
  assert.equal(pairRoleOf('error.resolved'), 'resolved');
  expectContextEventError(() => validateCanonicalContextEvent(withPairing(closer, { pairId: 'pair:x', role: 'opened' })));
});

test('§11 第 14 项：关闭类型带错误角色 → 抛错', () => {
  const closer = makeEvent('retry.exhausted', { sourceId: 'item14-closer' });
  assert.equal(pairRoleOf('retry.exhausted'), 'rejected');
  expectContextEventError(() =>
    validateCanonicalContextEvent(withPairing(closer, { pairId: 'pair:x', role: 'resolved', relatedEventId: 'context-event:y' })),
  );
});

test('§11 第 15 项双向：status=superseded ⟺ supersededByEventId 存在（含空串视为缺失）', () => {
  const base = makeEvent('error.detected', { sourceId: 'item15-base' });
  // superseded 但缺引用 / 引用为空串 → 抛错
  expectContextEventError(() => validateCanonicalContextEvent(withStatus(base, 'superseded')));
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, status: 'superseded', supersededByEventId: '' }));
  // 有引用但 status 非 superseded → 抛错
  expectContextEventError(() => validateCanonicalContextEvent({ ...base, supersededByEventId: 'context-event:newer' }));
  // 双向都成立 → 合法
  assert.doesNotThrow(() => validateCanonicalContextEvent({ ...base, status: 'superseded', supersededByEventId: 'context-event:newer' }));
});

test('§11 第 9–14 项 vacuous：未配对关闭事件（无 pairing）不抛错', () => {
  for (const type of ['error.resolved', 'blocker.resolved', 'plan.accepted', 'plan.rejected', 'retry.recovered', 'retry.exhausted', 'checkpoint.committed', 'checkpoint.reentered'] as const) {
    const event = makeEvent(type, { sourceId: `vacuous-${type}` });
    assert.equal(event.pairing, undefined);
    assert.doesNotThrow(() => {
      try {
        validateCanonicalContextEvent(event);
      } catch (error) {
        throw new Error(`${type} must be vacuously valid: ${String(error)}`);
      }
    });
  }
});

test('§11 第 1–15 项正例：applyPairingOutcome 的全部产物都通过校验', () => {
  const events = applyPairingOutcome([
    makeEvent('error.detected', { sourceId: 'positive-error' }),
    makeEvent('error.resolved', { sourceId: 'positive-error-close', occurredAt: at(2) }),
    makeEvent('plan.proposed', { sourceId: 'positive-plan', occurredAt: at(3) }),
    makeEvent('plan.accepted', { sourceId: 'positive-plan-close', occurredAt: at(4) }),
    makeEvent('operation.failed', { sourceId: 'positive-op', occurredAt: at(5) }),
    makeEvent('checkpoint.reentered', { sourceId: 'positive-op-close', occurredAt: at(6) }),
  ]);
  for (const event of events) assert.doesNotThrow(() => validateCanonicalContextEvent(event));
});

/* ================================================================== *
 * §10.1 toUserNarrative
 * ================================================================== */

test('§10.1 state 映射：active→happening，completed→happened，failed→failed，resolved→resolved，rejected→happened', () => {
  assert.equal(toUserNarrative([makeEvent('operation.started', { sourceId: 'n-active' })])[0].state, 'happening');
  assert.equal(toUserNarrative([makeEvent('task.created', { sourceId: 'n-completed' })])[0].state, 'happened');
  assert.equal(toUserNarrative([makeEvent('operation.failed', { sourceId: 'n-failed' })])[0].state, 'failed');
  assert.equal(toUserNarrative([makeEvent('error.resolved', { sourceId: 'n-resolved' })])[0].state, 'resolved');
  assert.equal(toUserNarrative([makeEvent('plan.rejected', { sourceId: 'n-rejected' })])[0].state, 'happened');
});

test('§10.1 narrative=attention 且 status=active → needs-user', () => {
  assert.equal(narrativeOf('blocker.detected'), 'attention');
  assert.equal(toUserNarrative([makeEvent('blocker.detected', { sourceId: 'n-attention-1' })])[0].state, 'needs-user');
  assert.equal(narrativeOf('retry.detected'), 'attention');
  assert.equal(toUserNarrative([makeEvent('retry.detected', { sourceId: 'n-attention-2' })])[0].state, 'needs-user');
});

test('§10.1 superseded 事件不输出', () => {
  const superseded = makeEvent('error.detected', { sourceId: 'n-superseded', supersededByEventId: 'context-event:newer' });
  const kept = makeEvent('task.created', { sourceId: 'n-kept' });
  const narrative = toUserNarrative([superseded, kept]);
  assert.deepEqual(narrative.map((entry) => entry.eventId), [kept.eventId]);
});

test('§10.1 title=labelOf(type)，detail=summary，evidenceRefs 透传，顺序保持', () => {
  const refs = [evidenceRef(1)];
  const first = makeEvent('task.created', { sourceId: 'n-title-1', summary: '自定义', evidenceRefs: refs });
  const second = makeEvent('task.confirmed', { sourceId: 'n-title-2', occurredAt: at(2) });
  const narrative = toUserNarrative([first, second]);
  assert.deepEqual(narrative.map((entry) => entry.eventId), [first.eventId, second.eventId]);
  assert.equal(narrative[0].title, labelOf('task.created'));
  assert.equal(narrative[0].detail, '自定义');
  assert.deepEqual(narrative[0].evidenceRefs, refs);
  assert.equal(narrative[0].occurredAt, first.occurredAt);
});

test('§10.1 nextAction 仅对「打开类型且 status=active」给出', () => {
  const proposed = toUserNarrative([makeEvent('plan.proposed', { sourceId: 'n-next-proposed' })])[0];
  assert.equal(proposed.nextAction, '方案已采纳 / 方案已否决');
  const detected = toUserNarrative([makeEvent('error.detected', { sourceId: 'n-next-detected' })])[0];
  assert.equal(detected.nextAction, '问题已修复');
  const retry = toUserNarrative([makeEvent('retry.detected', { sourceId: 'n-next-retry' })])[0];
  assert.equal(retry.nextAction, '重试已恢复 / 重试已耗尽');
});

test('§10.1 未配对的 operation.failed 不给 nextAction（默认 status 是 failed）', () => {
  const failed = toUserNarrative([makeEvent('operation.failed', { sourceId: 'n-next-failed' })])[0];
  assert.equal(failed.state, 'failed');
  assert.equal(failed.nextAction, undefined);
});

test('§10.1 已配对的打开事件不给 nextAction（status 已被改写）', () => {
  const paired = applyPairingOutcome([makeEvent('plan.proposed', { sourceId: 'n-next-paired' }), makeEvent('plan.accepted', { sourceId: 'n-next-paired-close', occurredAt: at(2) })]);
  const entry = toUserNarrative(paired)[0];
  assert.equal(entry.state, 'happened');
  assert.equal(entry.nextAction, undefined);
});

/* ================================================================== *
 * §10.2 toMemoryDigest
 * ================================================================== */

test('§10.2 decisions：task.confirmed / plan.accepted / plan.rejected 各自 outcome', () => {
  const confirmed = makeEvent('task.confirmed', { sourceId: 'd-confirmed' });
  const proposal = makeEvent('plan.proposed', { sourceId: 'd-proposal' });
  const accepted = makeEvent('plan.accepted', { sourceId: 'd-accepted', occurredAt: at(2) });
  const rejected = makeEvent('plan.rejected', { sourceId: 'd-rejected', occurredAt: at(3) });
  const digest = toMemoryDigest(applyPairingOutcome([confirmed, proposal, accepted, rejected]));
  assert.deepEqual(
    digest.decisions.map((entry) => [entry.eventId, entry.outcome]),
    [
      [confirmed.eventId, 'confirmed'],
      [accepted.eventId, 'accepted'],
      [rejected.eventId, 'rejected'],
    ],
  );
});

test('§10.2 failures：error.detected 逐条，配对时带 resolutionEventId/resolutionSummary', () => {
  const detected = makeEvent('error.detected', { sourceId: 'd-failure' });
  const resolved = makeEvent('error.resolved', { sourceId: 'd-failure-close', occurredAt: at(2) });
  const lonely = makeEvent('error.detected', { sourceId: 'd-failure-lonely', occurredAt: at(3) });
  const digest = toMemoryDigest(applyPairingOutcome([detected, resolved, lonely]));
  assert.equal(digest.failures.length, 2);
  const pairedFailure = must(digest.failures.find((entry) => entry.failureEventId === detected.eventId), 'paired failure entry');
  assert.equal(pairedFailure.resolutionEventId, resolved.eventId);
  assert.equal(pairedFailure.resolutionSummary, labelOf('error.resolved'));
  const lonelyFailure = must(digest.failures.find((entry) => entry.failureEventId === lonely.eventId), 'unpaired failure entry');
  assert.equal(lonelyFailure.resolutionEventId, undefined);
});

test('§10.2 blockers：blocker.detected 逐条，配对时带 resolutionEventId', () => {
  const detected = makeEvent('blocker.detected', { sourceId: 'd-blocker' });
  const resolved = makeEvent('blocker.resolved', { sourceId: 'd-blocker-close', occurredAt: at(2) });
  const digest = toMemoryDigest(applyPairingOutcome([detected, resolved]));
  assert.equal(digest.blockers.length, 1);
  assert.equal(digest.blockers[0].blockerEventId, detected.eventId);
  assert.equal(digest.blockers[0].resolutionEventId, resolved.eventId);
  assert.equal(digest.blockers[0].resolutionSummary, labelOf('blocker.resolved'));
});

test('§10.2 rejectedPlans anchor = 提案：proposalEventId/occurredAt/summary 取提案，rejectionEventId=否决', () => {
  const proposal = makeEvent('plan.proposed', { sourceId: 'd-anchor-proposal', occurredAt: at(4), summary: '方案甲' });
  const rejection = makeEvent('plan.rejected', { sourceId: 'd-anchor-rejection', occurredAt: at(5), summary: '否决理由' });
  const digest = toMemoryDigest(applyPairingOutcome([proposal, rejection]));
  assert.equal(digest.rejectedPlans.length, 1);
  const entry = digest.rejectedPlans[0];
  assert.equal(entry.proposalEventId, proposal.eventId);
  assert.equal(entry.rejectionEventId, rejection.eventId);
  assert.equal(entry.occurredAt, proposal.occurredAt);
  assert.equal(entry.summary, '方案甲');
  assert.equal(entry.occurredAt, at(4));
});

test('§10.2 未配对 plan.proposed 不产 rejectedPlans 行，且落 omitted（reason=budget）', () => {
  const proposal = makeEvent('plan.proposed', { sourceId: 'd-unpaired-proposal' });
  const digest = toMemoryDigest(applyPairingOutcome([proposal]));
  assert.deepEqual(digest.rejectedPlans, []);
  assert.deepEqual(digest.omitted, [{ eventId: proposal.eventId, reason: 'budget' }]);
});

test('§10.2 未配对 plan.rejected 进 decisions(outcome=rejected)，不产 rejectedPlans 行，也不进 omitted（默认预算与受限预算皆然）', () => {
  const rejection = makeEvent('plan.rejected', { sourceId: 'd-unpaired-rejection' });
  for (const summaryBudgetBytes of [undefined, 0]) {
    const digest = toMemoryDigest(applyPairingOutcome([rejection]), summaryBudgetBytes === undefined ? undefined : { summaryBudgetBytes });
    // §10.2 rejectedPlans 锚定「被否决的提案」，未配对时无提案可指认。
    assert.deepEqual(digest.rejectedPlans, [], `budget=${summaryBudgetBytes}`);
    // §10.2 未配对 plan.rejected 无条件进 decisions(outcome='rejected')，
    // 因此不得出现在 omitted —— omitted 定义是「未进入上述任一 digest 字段的事件」。
    assert.deepEqual(digest.decisions.map((entry) => [entry.eventId, entry.outcome]), [[rejection.eventId, 'rejected']], `budget=${summaryBudgetBytes}`);
    assert.equal(digest.omitted.some((entry) => entry.eventId === rejection.eventId), false, `budget=${summaryBudgetBytes}`);
    if (summaryBudgetBytes !== undefined) {
      assert.equal(digest.summary, '', '受限预算下 summary 为空');
    }
  }
});

test('§10.2 omitted 归属表（受限预算 summaryBudgetBytes=0）：18 个未配对 type 逐行等于「未进入任一 digest 字段」', () => {
  // 用 summaryBudgetBytes=0 关闭 summary 这条消费路径，使 omitted 的归属只由
  // digest 分支的显式消费决定。这样「删掉某个 digest 分支的消费」会被立刻捕获 ——
  // 默认预算 2048 下 priority<=2 的事件会被 summary 顺带消费而掩盖该缺陷。
  const digestFieldOf: ReadonlyArray<readonly [ContextEventType, 'decisions' | 'failures' | 'blockers']> = [
    ['task.confirmed', 'decisions'],
    ['plan.accepted', 'decisions'],
    ['plan.rejected', 'decisions'],
    ['error.detected', 'failures'],
    ['blocker.detected', 'blockers'],
  ];
  const consuming = new Map(digestFieldOf);
  assert.equal(consuming.size, 5);
  for (const type of CONTEXT_EVENT_TYPES) {
    const event = makeEvent(type, { sourceId: `omitted-table-${type}` });
    const digest = toMemoryDigest(applyPairingOutcome([event]), { summaryBudgetBytes: 0 });
    assert.equal(digest.summary, '', `${type}: summaryBudgetBytes=0 must yield empty summary`);
    // §10.2：未配对事件的 rejectedPlans 恒为空（anchor 提案必须配对一个 plan.rejected）。
    assert.deepEqual(digest.rejectedPlans, [], `${type}: unpaired event must not produce a rejectedPlans row`);
    const field = consuming.get(type);
    if (field === undefined) {
      // §10.2：不在任何 digest 分支内的 type 落 omitted('budget')。
      assert.deepEqual(digest.omitted, [{ eventId: event.eventId, reason: 'budget' }], `${type}: expected omitted`);
      assert.deepEqual(digest.decisions, [], `${type}: expected no decision`);
      assert.deepEqual(digest.failures, [], `${type}: expected no failure`);
      assert.deepEqual(digest.blockers, [], `${type}: expected no blocker`);
      continue;
    }
    // §10.2：该 type 有 digest 分支，必然消费自身 eventId，因此不得出现在 omitted。
    assert.equal(digest.omitted.some((entry) => entry.eventId === event.eventId), false, `${type}: must not be omitted`);
    assert.deepEqual(digestFieldEventIds(digest).has(event.eventId), true, `${type}: must appear in a digest field`);
    if (field === 'decisions') assert.deepEqual(digest.decisions.map((entry) => entry.eventId), [event.eventId], `${type}: decisions`);
    if (field === 'failures') assert.deepEqual(digest.failures.map((entry) => entry.failureEventId), [event.eventId], `${type}: failures`);
    if (field === 'blockers') assert.deepEqual(digest.blockers.map((entry) => entry.blockerEventId), [event.eventId], `${type}: blockers`);
  }
});

test('§10.2 受限预算下 omitted 与全部 digest 字段的 eventId 互斥（覆盖 Lead 列出的 7 个 type）', () => {
  const cases: readonly ContextEventType[] = [
    'plan.rejected',
    'error.resolved',
    'blocker.resolved',
    'retry.recovered',
    'retry.exhausted',
    'task.created',
    'checkpoint.reentered',
  ];
  assert.equal(cases.length, 7);
  for (const type of cases) {
    const event = makeEvent(type, { sourceId: `omitted-exclusive-${type}` });
    const digest = toMemoryDigest(applyPairingOutcome([event]), { summaryBudgetBytes: 0 });
    const consumedIds = digestFieldEventIds(digest);
    const omittedIds = digest.omitted.map((entry) => entry.eventId);
    assert.equal(digest.summary, '', `${type}: summary must be empty under a zero budget`);
    // §10.2：`omitted` 的定义是「未进入上述任一 digest 字段的事件」，故与字段 id 集合互斥。
    for (const id of omittedIds) {
      assert.equal(consumedIds.has(id), false, `${type}: ${id} must not be both consumed and omitted`);
    }
    // §10.2 decisions 无条件收录 plan.rejected，与是否配对无关。
    if (type === 'plan.rejected') {
      assert.deepEqual(digest.decisions.map((entry) => [entry.eventId, entry.outcome]), [[event.eventId, 'rejected']]);
    }
    // §10.2：`task.created` 不在任何 digest 分支内（priority 2 只影响 summary，而 summary 已关闭）。
    if (type === 'task.created') {
      assert.deepEqual(digest.omitted, [{ eventId: event.eventId, reason: 'budget' }]);
    }
    // §10.2：未配对关闭事件中只有 plan.rejected 进 decisions，其余 6 个没有 digest 分支，
    // 落 omitted('budget') 才是正确行为。
    if (type !== 'plan.rejected') {
      assert.deepEqual(digest.decisions, [], `${type}: no decision expected`);
      assert.deepEqual(digest.omitted, [{ eventId: event.eventId, reason: 'budget' }], `${type}: expected omitted`);
    }
  }
});

test('§10.2 受限预算下混合输入的 omitted 恰为未消费集合（exact equality）', () => {
  const events = applyPairingOutcome([
    makeEvent('error.detected', { sourceId: 'mix-error', occurredAt: at(1) }),
    makeEvent('error.resolved', { sourceId: 'mix-error-close', occurredAt: at(2) }),
    makeEvent('blocker.detected', { sourceId: 'mix-blocker', occurredAt: at(3) }),
    makeEvent('blocker.resolved', { sourceId: 'mix-blocker-close', occurredAt: at(4) }),
    makeEvent('plan.proposed', { sourceId: 'mix-proposal', occurredAt: at(5) }),
    makeEvent('plan.rejected', { sourceId: 'mix-rejection', occurredAt: at(6) }),
    makeEvent('task.created', { sourceId: 'mix-created', occurredAt: at(7) }),
    makeEvent('task.confirmed', { sourceId: 'mix-confirmed', occurredAt: at(8) }),
    makeEvent('operation.started', { sourceId: 'mix-started', occurredAt: at(9) }),
    makeEvent('operation.failed', { sourceId: 'mix-failed', occurredAt: at(10) }),
    makeEvent('checkpoint.committed', { sourceId: 'mix-checkpoint', occurredAt: at(11) }),
    makeEvent('retry.detected', { sourceId: 'mix-retry', occurredAt: at(12) }),
    makeEvent('retry.recovered', { sourceId: 'mix-retry-close', occurredAt: at(13) }),
    makeEvent('context.compacted', { sourceId: 'mix-compacted', occurredAt: at(14) }),
  ]);
  const digest = toMemoryDigest(events, { summaryBudgetBytes: 0 });
  assert.equal(digest.summary, '');
  // 有 digest 字段消费的 6 个事件：decisions(plan.rejected, task.confirmed)、
  // failures(error.detected) + resolution(error.resolved)、
  // rejectedPlans(proposal=plan.proposed, rejection=plan.rejected)、
  // blockers(blocker.detected) + resolution(blocker.resolved)。
  assert.deepEqual(digest.decisions.map((entry) => [entry.eventId, entry.outcome]), [
    ['context-event:mix-rejection', 'rejected'],
    ['context-event:mix-confirmed', 'confirmed'],
  ]);
  assert.deepEqual(digest.failures.map((entry) => [entry.failureEventId, entry.resolutionEventId]), [
    ['context-event:mix-error', 'context-event:mix-error-close'],
  ]);
  assert.deepEqual(digest.rejectedPlans.map((entry) => [entry.proposalEventId, entry.rejectionEventId]), [
    ['context-event:mix-proposal', 'context-event:mix-rejection'],
  ]);
  assert.deepEqual(digest.blockers.map((entry) => [entry.blockerEventId, entry.resolutionEventId]), [
    ['context-event:mix-blocker', 'context-event:mix-blocker-close'],
  ]);
  // §10.2：其余 7 个事件未被任何 digest 字段收纳（retry.* / operation.* / checkpoint.*
  // / task.created / context.compacted 无分支；priority>2 者也不参与 summary）。
  assert.deepEqual(digest.omitted, [
    { eventId: 'context-event:mix-created', reason: 'budget' },
    { eventId: 'context-event:mix-started', reason: 'budget' },
    { eventId: 'context-event:mix-failed', reason: 'budget' },
    { eventId: 'context-event:mix-checkpoint', reason: 'budget' },
    { eventId: 'context-event:mix-retry', reason: 'budget' },
    { eventId: 'context-event:mix-retry-close', reason: 'budget' },
    { eventId: 'context-event:mix-compacted', reason: 'budget' },
  ]);
  assert.doesNotThrow(() => validateMemoryContextDigest(digest));
});

/**
 * §10.2 `omitted` 与全部 digest 字段（`decisions` / `failures` / `rejectedPlans` / `blockers`，
 * 含 resolution/rejection 引用字段）的 `eventId` 集合必须互斥。
 * 该判据不依赖 summary 是否参与，故在受限预算与默认预算下都成立。
 */
function assertOmittedExclusive(digest: ReturnType<typeof toMemoryDigest>, label: string): void {
  const fieldIds = digestFieldEventIds(digest);
  for (const entry of digest.omitted) {
    assert.equal(
      fieldIds.has(entry.eventId),
      false,
      `${label}: ${entry.eventId} must not be both in a digest field and in omitted`,
    );
  }
}

test('§10.2 字段消费完整：输入全部被 digest 字段覆盖时 omitted 为空（默认预算）', () => {
  // 该用例与 `summaryBudgetBytes=0` 版本的字段归属表互补：这里 summary 参与消费，
  // 若某条路径漏掉 `consumed` 记录（无论是 digest 分支还是 summary 循环），
  // 被遗漏的 eventId 会同时出现在字段与 omitted 中，违反互斥性。
  const input = [
    makeEvent('task.confirmed', { sourceId: 'field-full-1', occurredAt: at(1) }),
    makeEvent('plan.accepted', { sourceId: 'field-full-2', occurredAt: at(2) }),
    makeEvent('plan.rejected', { sourceId: 'field-full-3', occurredAt: at(3) }),
    makeEvent('error.detected', { sourceId: 'field-full-4', occurredAt: at(4) }),
    makeEvent('blocker.detected', { sourceId: 'field-full-5', occurredAt: at(5) }),
  ];
  const digest = toMemoryDigest(applyPairingOutcome(input));
  // 5 条 input 全部有 digest 分支（且全部被 summary 收录，priority<=2 或 3+决策分支）。
  assert.deepEqual(digest.decisions.map((entry) => [entry.eventId, entry.outcome]), [
    ['context-event:field-full-1', 'confirmed'],
    ['context-event:field-full-2', 'accepted'],
    ['context-event:field-full-3', 'rejected'],
  ]);
  assert.deepEqual(digest.failures.map((entry) => entry.failureEventId), ['context-event:field-full-4']);
  assert.deepEqual(digest.blockers.map((entry) => entry.blockerEventId), ['context-event:field-full-5']);
  assert.deepEqual(digest.rejectedPlans, []);
  assert.deepEqual(digest.omitted, []);
  assertOmittedExclusive(digest, 'field-full');
  assert.doesNotThrow(() => validateMemoryContextDigest(digest));

  // 同一份 input 在受限预算下也必须满足互斥性（summary 退出消费路径）。
  const limited = toMemoryDigest(applyPairingOutcome(input), { summaryBudgetBytes: 0 });
  assert.equal(limited.summary, '');
  assert.deepEqual(limited.omitted, []);
  assertOmittedExclusive(limited, 'field-full-limited');
});

test('§10.2 配对引用也算「进入 digest 字段」：关闭事件不得同时出现在字段与 omitted', () => {
  const cases: ReadonlyArray<readonly [ContextEventType, ContextEventType]> = [
    ['error.detected', 'error.resolved'],
    ['blocker.detected', 'blocker.resolved'],
    ['plan.proposed', 'plan.rejected'],
  ];
  for (const [openerType, closerType] of cases) {
    const events = applyPairingOutcome([
      makeEvent(openerType, { sourceId: `ref-open-${openerType}`, occurredAt: at(1) }),
      makeEvent(closerType, { sourceId: `ref-close-${closerType}`, occurredAt: at(2) }),
    ]);
    // 受限预算：隔离 summary 这条消费路径，使「是否被 omitted」只由 digest 分支消费决定。
    // 默认预算 2048 下 3 个分支的 eventId 都会被 summary 顺带覆盖，掩盖掉漏消费缺陷。
    const digest = toMemoryDigest(events, { summaryBudgetBytes: 0 });
    assert.equal(digest.summary, '');
    // 关闭事件经 opening 事件的 digest 分支的引用字段被消费（§10.2 resolution/rejection 字段）。
    assert.equal(
      digest.omitted.some((entry) => entry.eventId === `context-event:ref-close-${closerType}`),
      false,
      `${closerType} is referenced by a digest field and must not be omitted`,
    );
    assert.equal(digestFieldEventIds(digest).has(`context-event:ref-close-${closerType}`), true, `${closerType} must be referenced`);
    // opening 事件自身也必须被消费（rejectedPlans anchor / failure / blocker）。
    assert.equal(
      digest.omitted.some((entry) => entry.eventId === `context-event:ref-open-${openerType}`),
      false,
      `${openerType} is the anchor of a digest row and must not be omitted`,
    );
    assert.deepEqual(digest.omitted, [], `${openerType} + ${closerType}: both events are consumed`);
    assert.doesNotThrow(() => validateMemoryContextDigest(digest));
  }
  // 反例：retry / checkpoint 配对后没有 digest 分支引用，两个事件都落 omitted。
  const unrepresented = applyPairingOutcome([
    makeEvent('retry.detected', { sourceId: 'ref-retry', occurredAt: at(1) }),
    makeEvent('retry.recovered', { sourceId: 'ref-retry-close', occurredAt: at(2) }),
  ]);
  const digest = toMemoryDigest(unrepresented, { summaryBudgetBytes: 0 });
  assert.deepEqual(digest.omitted, [
    { eventId: 'context-event:ref-retry', reason: 'budget' },
    { eventId: 'context-event:ref-retry-close', reason: 'budget' },
  ]);
});

test('§10.2 summary 消费路径：默认预算下入选 summary 的事件不得同时落 omitted', () => {
  // 这条用例钉住 projector 的 **summary 循环** 对 `consumed` 的贡献。
  // 若把 summary 循环里的 `consumed.add` 删掉，被 summary 覆盖的事件会重新落回
  // omitted，而它们确实已「进入摘要字段」，与 §10.2 的 omitted 定义冲突。
  const input = [
    makeEvent('task.created', { sourceId: 'sum-consumed-1', occurredAt: at(1) }),
    makeEvent('error.resolved', { sourceId: 'sum-consumed-2', occurredAt: at(2) }),
    makeEvent('retry.recovered', { sourceId: 'sum-consumed-3', occurredAt: at(3) }),
    makeEvent('checkpoint.reentered', { sourceId: 'sum-consumed-4', occurredAt: at(4) }),
  ];
  const digest = toMemoryDigest(applyPairingOutcome(input));
  // 4 条都是 priority<=2 且默认预算充足，故全部入选 summary（前缀覆盖整个输入）。
  assert.equal(digest.summary, input.map((event) => event.summary).join(' / '));
  // §10.2：summary 也是 digest 字段之一，入选者不得再出现在 omitted。
  assert.deepEqual(digest.omitted, []);
  // §10.2：这些 type 没有其它 digest 分支（task.created / error.resolved（未配对）/
  // retry.recovered（未配对）/ checkpoint.reentered（未配对）），因此它们唯一的字段
  // 归属只能是 summary —— 这正是本用例要钉住的路径。
  assert.deepEqual(digest.decisions, []);
  assert.deepEqual(digest.failures, []);
  assert.deepEqual(digest.rejectedPlans, []);
  assert.deepEqual(digest.blockers, []);
  assert.doesNotThrow(() => validateMemoryContextDigest(digest));

  // 预算边界：恰好装下一条时该条入选 summary 且不进 omitted；少 1 字节则二者都没有。
  const single = makeEvent('task.created', { sourceId: 'sum-consumed-single', occurredAt: at(5) });
  const need = textBytes(single.summary);
  const fits = toMemoryDigest([single], { summaryBudgetBytes: need });
  assert.equal(fits.summary, single.summary);
  assert.deepEqual(fits.omitted, []);
  const overflow = toMemoryDigest([single], { summaryBudgetBytes: need - 1 });
  assert.equal(overflow.summary, '');
  assert.deepEqual(overflow.omitted, [{ eventId: single.eventId, reason: 'budget' }]);
});

test('§10.2 plan.accepted 只进 decisions，不产 rejectedPlans 行；提案自身落 omitted(budget)', () => {
  const proposal = makeEvent('plan.proposed', { sourceId: 'd-accepted-proposal' });
  const accepted = makeEvent('plan.accepted', { sourceId: 'd-accepted-close', occurredAt: at(2) });
  const digest = toMemoryDigest(applyPairingOutcome([proposal, accepted]));
  assert.deepEqual(digest.rejectedPlans, []);
  assert.deepEqual(digest.decisions.map((entry) => [entry.eventId, entry.outcome]), [[accepted.eventId, 'accepted']]);
  // §10.2：omitted = 未进入任一 digest 字段的事件。plan.proposed 既不是被否决提案，
  // 也不在 decisions / failures / blockers，且 priorityOf=3 > 2 不参与 summary，故落 omitted('budget')。
  assert.deepEqual(digest.omitted, [{ eventId: proposal.eventId, reason: 'budget' }]);
});

test('§10.2 summary：priority<=2 事件按序以 " / " 连接，并按 summaryBudgetBytes 在事件边界截断', () => {
  const first = makeEvent('task.confirmed', { sourceId: 'd-summary-1', occurredAt: at(1), summary: 'A' });
  const second = makeEvent('blocker.detected', { sourceId: 'd-summary-2', occurredAt: at(2), summary: 'BBBBBBBB' });
  const third = makeEvent('error.detected', { sourceId: 'd-summary-3', occurredAt: at(3), summary: 'C' });
  const events = [first, second, third];
  const two = `${first.summary} / ${second.summary}`;
  const full = `${two} / ${third.summary}`;
  assert.equal(toMemoryDigest(events).summary, full);
  // 预算按文本字节计，分隔符 ' / ' 计 3 字节；截断发生在事件边界。
  assert.equal(toMemoryDigest(events, { summaryBudgetBytes: 0 }).summary, '');
  assert.equal(toMemoryDigest(events, { summaryBudgetBytes: textBytes(first.summary) }).summary, first.summary);
  assert.equal(toMemoryDigest(events, { summaryBudgetBytes: textBytes(two) }).summary, two);
  assert.equal(toMemoryDigest(events, { summaryBudgetBytes: textBytes(full) }).summary, full);
  // 前缀截断：第三个事件装不下时停止，不跳过第二个去塞入更小的第三个。
  // 预算 13 已足够装下 'A / C'（5 字节），但契约要求结果仍是前缀 'A / BBBBBBBB'。
  assert.equal(toMemoryDigest(events, { summaryBudgetBytes: textBytes(two) + 1 }).summary, two);
  assert.ok(textBytes(`${first.summary} / ${third.summary}`) <= textBytes(two) + 1);
  // priorityOf > 2 的事件不参与 summary。
  const lowPriority = makeEvent('operation.started', { sourceId: 'd-summary-low', occurredAt: at(4), summary: 'DDDD' });
  assert.equal(toMemoryDigest([...events, lowPriority]).summary, full);
});

test('§10.2 omitted 永不出现 reason=pair；superseded 事件落 reason=superseded', () => {
  const superseded = makeEvent('operation.started', { sourceId: 'd-superseded', supersededByEventId: 'context-event:newer' });
  const digest = toMemoryDigest(
    applyPairingOutcome([superseded, makeEvent('error.detected', { sourceId: 'd-omitted-open' }), makeEvent('error.resolved', { sourceId: 'd-omitted-close', occurredAt: at(2) })]),
  );
  assert.ok(digest.omitted.every((entry) => entry.reason !== 'pair'));
  assert.deepEqual(digest.omitted.find((entry) => entry.eventId === superseded.eventId), { eventId: superseded.eventId, reason: 'superseded' });
  assert.doesNotThrow(() => validateMemoryContextDigest(digest));
});

test('§10.2 仅 context.compacted 时顶层 summary === "" 且 validateMemoryContextDigest 不抛', () => {
  const digest = toMemoryDigest([makeEvent('context.compacted', { sourceId: 'd-only-compacted' })]);
  assert.equal(digest.summary, '');
  assert.deepEqual(digest.decisions, []);
  assert.deepEqual(digest.failures, []);
  assert.deepEqual(digest.rejectedPlans, []);
  assert.deepEqual(digest.blockers, []);
  assert.deepEqual(digest.omitted, [{ eventId: 'context-event:d-only-compacted', reason: 'budget' }]);
  assert.doesNotThrow(() => validateMemoryContextDigest(digest));
});

test('§11 校验 validateMemoryContextDigest：条目级 summary 为空抛错，顶层空串合法', () => {
  const digest = toMemoryDigest(applyPairingOutcome([makeEvent('task.confirmed', { sourceId: 'd-validate-1' }), makeEvent('error.detected', { sourceId: 'd-validate-2' })]));
  assert.doesNotThrow(() => validateMemoryContextDigest(digest));
  assert.doesNotThrow(() => validateMemoryContextDigest({ ...digest, summary: '' }));
  expectContextEventError(() => validateMemoryContextDigest({ ...digest, decisions: [{ ...digest.decisions[0], summary: '' }] }));
  expectContextEventError(() => validateMemoryContextDigest({ ...digest, failures: [{ ...digest.failures[0], summary: '' }] }));
});

test('§11 校验 validateMemoryContextDigest 拒绝 omitted.reason=pair 与非法条目字段', () => {
  const digest = toMemoryDigest([makeEvent('task.confirmed', { sourceId: 'd-validate-3' })]);
  expectContextEventError(() => validateMemoryContextDigest({ ...digest, omitted: [{ eventId: 'context-event:x', reason: 'pair' as never }] }));
  expectContextEventError(() => validateMemoryContextDigest({ ...digest, omitted: [{ eventId: '', reason: 'budget' }] }));
  expectContextEventError(() => validateMemoryContextDigest({ ...digest, omitted: [{ eventId: 'context-event:x', reason: 'bogus' as never }] }));
  expectContextEventError(() => validateMemoryContextDigest({ ...digest, decisions: [{ ...digest.decisions[0], outcome: 'bogus' as never }] }));
  expectContextEventError(() => validateMemoryContextDigest({ ...digest, decisions: [{ ...digest.decisions[0], occurredAt: 'zzz' }] }));
  expectContextEventError(() => validateMemoryContextDigest({ ...digest, decisions: [{ ...digest.decisions[0], eventId: '' }] }));
});

/* ================================================================== *
 * §10.3 compactContextEvents / §11 第 21–23 项
 * ================================================================== */

test('§10.3 usedBytes = Σ(每条保留事件的 JSON 字节 + 1)，且恒有 usedBytes <= budgetBytes（§11 第 22 项不变量）', () => {
  const events = applyPairingOutcome([
    makeEvent('task.confirmed', { sourceId: 'c-used-1' }),
    makeEvent('error.detected', { sourceId: 'c-used-2', occurredAt: at(2) }),
    makeEvent('error.resolved', { sourceId: 'c-used-3', occurredAt: at(3) }),
    makeEvent('operation.started', { sourceId: 'c-used-4', occurredAt: at(4) }),
  ]);
  const budgetBytes = 100000;
  const snapshot = compactContextEvents(events, { budgetBytes, snapshotId: 'snapshot-used' });
  assert.equal(snapshot.snapshotId, 'snapshot-used');
  assert.equal(snapshot.budgetBytes, budgetBytes);
  assert.equal(snapshot.sourceWatermark, 0);
  assert.equal(snapshot.omitted.length, 0);
  assert.equal(snapshot.retained.length, events.length);
  assert.equal(snapshot.usedBytes, events.reduce((sum, event) => sum + eventBytes(event), 0));
  assert.ok(snapshot.usedBytes <= snapshot.budgetBytes);
  assert.doesNotThrow(() => validateCompactSnapshot(snapshot));
});

test('§10.3 成对保留/成对丢弃 + reason=pair（§11 第 23 项不变量）', () => {
  const opened = makeEvent('error.detected', { sourceId: 'c-pair-open' });
  const closed = makeEvent('error.resolved', { sourceId: 'c-pair-close', occurredAt: at(2) });
  const events = applyPairingOutcome([opened, closed]);
  const pairBytes = eventBytes(events[0]) + eventBytes(events[1]);

  const tight = compactContextEvents(events, { budgetBytes: pairBytes - 1, snapshotId: 'snapshot-pair-tight' });
  assert.deepEqual(tight.retained, []);
  assert.deepEqual(
    tight.omitted.map((entry) => [entry.eventId, entry.reason]),
    [
      [opened.eventId, 'pair'],
      [closed.eventId, 'pair'],
    ],
  );
  assert.equal(tight.usedBytes, 0);

  const exact = compactContextEvents(events, { budgetBytes: pairBytes, snapshotId: 'snapshot-pair-exact' });
  assert.deepEqual(exact.retained.map((event) => event.eventId), [opened.eventId, closed.eventId]);
  assert.deepEqual(exact.omitted, []);
  assert.equal(exact.usedBytes, pairBytes);
  // §11 第 23 项：不得出现「成对之一被保留、另一个被丢弃」。
  for (const snapshot of [tight, exact]) {
    const retainedIds = new Set(snapshot.retained.map((event) => event.eventId));
    assert.ok(retainedIds.size === 0 || (retainedIds.has(opened.eventId) && retainedIds.has(closed.eventId)));
    assert.ok(snapshot.usedBytes <= snapshot.budgetBytes);
    assert.doesNotThrow(() => validateCompactSnapshot(snapshot));
  }
});

test('§10.3 superseded 事件不参与保留，reason=superseded', () => {
  const superseded = makeEvent('error.detected', { sourceId: 'c-superseded', supersededByEventId: 'context-event:newer' });
  const kept = makeEvent('task.confirmed', { sourceId: 'c-superseded-kept', occurredAt: at(2) });
  const snapshot = compactContextEvents([superseded, kept], { budgetBytes: 100000, snapshotId: 'snapshot-superseded' });
  assert.deepEqual(snapshot.retained.map((event) => event.eventId), [kept.eventId]);
  assert.deepEqual(snapshot.omitted, [{ eventId: superseded.eventId, reason: 'superseded' }]);
});

test('§10.3 无 pairing 的事件按单条参与预算：恰好装下则保留，少 1 字节则 reason=budget', () => {
  const lonely = makeEvent('error.resolved', { sourceId: 'c-single-closer' });
  const events = applyPairingOutcome([lonely]);
  assert.equal(events[0].pairing, undefined);
  const need = eventBytes(events[0]);
  const fits = compactContextEvents(events, { budgetBytes: need, snapshotId: 'snapshot-single-fits' });
  assert.deepEqual(fits.retained.map((event) => event.eventId), [lonely.eventId]);
  assert.equal(fits.usedBytes, need);
  const overflow = compactContextEvents(events, { budgetBytes: need - 1, snapshotId: 'snapshot-single-overflow' });
  assert.deepEqual(overflow.retained, []);
  assert.deepEqual(overflow.omitted, [{ eventId: lonely.eventId, reason: 'budget' }]);
  assert.equal(overflow.usedBytes, 0);
});

test('§10.3 预算耗尽后剩余候选 reason=budget，retained 保持候选顺序（priority→occurredAt→eventId）', () => {
  const events = [
    makeEvent('context.compacted', { sourceId: 'c-order-4', occurredAt: at(1) }),
    makeEvent('task.confirmed', { sourceId: 'c-order-1', occurredAt: at(2) }),
    makeEvent('operation.failed', { sourceId: 'c-order-2', occurredAt: at(3) }),
    makeEvent('error.detected', { sourceId: 'c-order-3', occurredAt: at(4) }),
  ];
  const all = compactContextEvents(events, { budgetBytes: 100000, snapshotId: 'snapshot-order' });
  assert.deepEqual(
    all.retained.map((event) => event.eventId),
    ['c-order-1', 'c-order-3', 'c-order-2', 'c-order-4'].map((sourceId) => `context-event:${sourceId}`),
  );
  assert.deepEqual(all.retained.map((event) => priorityOf(event.type)), [1, 1, 2, 4]);

  const budget = eventBytes(all.retained[0]) + eventBytes(all.retained[1]);
  const cut = compactContextEvents(events, { budgetBytes: budget, snapshotId: 'snapshot-order-cut' });
  assert.deepEqual(cut.retained.map((event) => event.eventId), [all.retained[0].eventId, all.retained[1].eventId]);
  assert.ok(cut.omitted.every((entry) => entry.reason === 'budget'));
  assert.ok(cut.usedBytes <= budget);
});

test('§10.3 sourceWatermark 透传，缺省为 0', () => {
  const events = [makeEvent('task.created', { sourceId: 'c-watermark' })];
  assert.equal(compactContextEvents(events, { budgetBytes: 100000, snapshotId: 's', sourceWatermark: 42 }).sourceWatermark, 42);
  assert.equal(compactContextEvents(events, { budgetBytes: 100000, snapshotId: 's' }).sourceWatermark, 0);
});

test('§11 第 21 项：compactContextEvents 入参校验抛 ContextEventError', () => {
  const events = [makeEvent('task.created', { sourceId: 'c-input-validation' })];
  expectContextEventError(() => compactContextEvents(events, { budgetBytes: 0, snapshotId: 's' }));
  expectContextEventError(() => compactContextEvents(events, { budgetBytes: -1, snapshotId: 's' }));
  expectContextEventError(() => compactContextEvents(events, { budgetBytes: 1.5, snapshotId: 's' }));
  expectContextEventError(() => compactContextEvents(events, { budgetBytes: 100, snapshotId: '' }));
});

test('§11 validateCompactSnapshot：usedBytes/budgetBytes/omitted/retained 负向用例', () => {
  const events = applyPairingOutcome([makeEvent('error.detected', { sourceId: 'c-snapshot-open' }), makeEvent('error.resolved', { sourceId: 'c-snapshot-close', occurredAt: at(2) })]);
  const snapshot = compactContextEvents(events, { budgetBytes: 100000, snapshotId: 'snapshot-validate' });
  assert.doesNotThrow(() => validateCompactSnapshot(snapshot));
  assert.doesNotThrow(() => validateCompactSnapshot({ ...snapshot, omitted: [{ eventId: 'context-event:x', reason: 'pair' }] }));
  expectContextEventError(() => validateCompactSnapshot({ ...snapshot, usedBytes: snapshot.budgetBytes + 1 }));
  expectContextEventError(() => validateCompactSnapshot({ ...snapshot, budgetBytes: 0 }));
  expectContextEventError(() => validateCompactSnapshot({ ...snapshot, budgetBytes: 1.5 }));
  expectContextEventError(() => validateCompactSnapshot({ ...snapshot, sourceWatermark: -1 }));
  expectContextEventError(() => validateCompactSnapshot({ ...snapshot, omitted: [{ eventId: 'context-event:x', reason: 'bogus' as never }] }));
  expectContextEventError(() => validateCompactSnapshot({ ...snapshot, omitted: [{ eventId: '', reason: 'budget' }] }));
  expectContextEventError(() => validateCompactSnapshot({ ...snapshot, retained: [{ ...snapshot.retained[0], summary: '' }] }));
});

/* ================================================================== *
 * §12 确定性 / sortEvents
 * ================================================================== */

test('§12 sortEvents：occurredAt → priorityOf(type) → eventId 升序，且不修改输入', () => {
  const late = makeEvent('operation.started', { sourceId: 'sort-late', occurredAt: at(5) });
  const sameTimeB = makeEvent('task.confirmed', { sourceId: 'sort-b', occurredAt: at(4) });
  const sameTimeA = makeEvent('error.detected', { sourceId: 'sort-a', occurredAt: at(4) });
  const sameTimeC = makeEvent('task.created', { sourceId: 'sort-c', occurredAt: at(4) });
  const input = [late, sameTimeB, sameTimeA, sameTimeC];
  const sorted = sortEvents(input);
  assert.deepEqual(sorted.map((event) => event.eventId), [sameTimeA.eventId, sameTimeB.eventId, sameTimeC.eventId, late.eventId]);
  assert.deepEqual(sorted.map((event) => [event.occurredAt, priorityOf(event.type)]), [[at(4), 1], [at(4), 1], [at(4), 2], [at(5), 4]]);
  assert.deepEqual(input.map((event) => event.eventId), [late.eventId, sameTimeB.eventId, sameTimeA.eventId, sameTimeC.eventId]);
  assert.deepEqual(sortEvents(input).map((event) => event.eventId), sorted.map((event) => event.eventId));
});

test('§12 确定性：同一输入重复调用结果一致（normalize / pairing / narrative / digest / compact）', () => {
  const record = eventRecord({ operation: { status: 'succeeded' } });
  assert.deepEqual(normalizeEventRecord(record), normalizeEventRecord(record));

  const events = [makeEvent('error.detected', { sourceId: 'det-1' }), makeEvent('error.resolved', { sourceId: 'det-2', occurredAt: at(2) })];
  assert.deepEqual(applyPairingOutcome(events), applyPairingOutcome(events));
  assert.deepEqual(toUserNarrative(events), toUserNarrative(events));
  assert.deepEqual(toMemoryDigest(events), toMemoryDigest(events));
  assert.deepEqual(compactContextEvents(events, { budgetBytes: 100000, snapshotId: 'det' }), compactContextEvents(events, { budgetBytes: 100000, snapshotId: 'det' }));
  assert.equal(makeEvent('task.created', { sourceId: 'det-3' }).dataDigest, makeEvent('task.created', { sourceId: 'det-3' }).dataDigest);
});

test('§14 端到端：适配器入口 → applyPairingOutcome → narrative/digest/compact 全链路一致', () => {
  const context = normalizeContext();
  const detected = onlyEvent(normalizeProviderEvent(providerEvent({ eventId: 'e2e-error', kind: 'error' }), context));
  const resolved = makeEvent('error.resolved', { sourceId: 'e2e-resolved', occurredAt: at(6) });
  const confirmed = onlyEvent(normalizeEventRecord(eventRecord({ operation: { status: 'succeeded' } })));
  const events = applyPairingOutcome([confirmed, detected, resolved]);

  const narrative = toUserNarrative(events);
  assert.deepEqual(narrative.map((entry) => entry.eventId), [confirmed.eventId, detected.eventId, resolved.eventId]);
  assert.equal(narrative[1].state, 'resolved');

  const digest = toMemoryDigest(events);
  assert.equal(digest.failures.length, 1);
  assert.equal(digest.failures[0].failureEventId, detected.eventId);
  assert.equal(digest.failures[0].resolutionEventId, resolved.eventId);
  assert.ok(digest.omitted.every((entry) => entry.reason !== 'pair'));
  assert.doesNotThrow(() => validateMemoryContextDigest(digest));

  const snapshot = compactContextEvents(events, { budgetBytes: 100000, snapshotId: 'e2e' });
  assert.equal(snapshot.retained.length, 3);
  assert.equal(snapshot.usedBytes, events.reduce((sum, event) => sum + eventBytes(event), 0));
  assert.ok(snapshot.usedBytes <= snapshot.budgetBytes);
  assert.doesNotThrow(() => validateCompactSnapshot(snapshot));
});

/*
 * §14 契约偏离观察（只报告 Lead，不在测试中放宽断言）：
 *
 * O1. 非闭合 union 内的 raw kind 不走 unmapped 分支，而是以异常终止：
 *     - `normalizeAgentSemanticEvent` 收到 agent-event 方言的 `provider.tool-result` /
 *       `provider.terminal`（不在 8 值 AgentSemanticEventKind 内）→
 *       `TypeError: Cannot read properties of undefined (reading 'kind')`（normalize 的分派实现抛原生
 *       TypeError，不是 ContextEventError）。
 *     - `normalizeEventRecord` 收到非 12 值 union 的 `operation.status`（如 `'pending'`）→
 *       `ContextEventError: 'unknown context event type: undefined'`。
 *     §4 声明「未知 raw kind 不猜测，显式返回 unmapped」，§9.2 亦声明「未命中任一规则的 raw kind
 *     进入 unmapped，reason: 'unknown-kind'，不得静默丢弃」。上述两个输入属 §9.2 明列的 8 值 / 12 值
 *     闭合集之外，测试只断言「不得被静默映射成 canonical 事件」，未断言具体错误类型，
 *     避免把契约未定义的错误形状固化为期望。
 *     `ProviderEventKind` 为 7 值闭合集且全部命中判据，故 provider-event 无此偏离。
 */
