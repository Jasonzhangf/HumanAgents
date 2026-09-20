import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type BusinessPayload, type EvidenceRef, type ScopeRef } from '../../../packages/contracts/src/index.js';
import {
  consumeEvents,
  EventConsumerError,
  OperationEventPublicationError,
  EventPublisherError,
  publishOperationEvent,
  publishEvent,
  type EventBusPorts,
  type ConsumerCommitRequest,
  type EventConsumerBinding,
  type EventConsumerReceipt,
  type EventDlqRecord,
  type EventEnvelope,
  type EventExternalOperation,
  type EventHandlerCommit,
  type EventRetryObligation,
  type EventRecord,
  type OperationEventNotificationAck,
  type OperationEventNotificationPort,
  type TrustedEventPublisher,
} from '../../../packages/runtime/src/events/index.js';
import type {
  AppendEventRequest,
  EventConsumerRegistryPort,
  EventExternalOperationPort,
  EventJournalPort,
  EventPublisherRegistryPort,
} from '../../../packages/runtime/src/events/ports.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const taskB = id('task', 'task-b');
const scope: ScopeRef = { organId: organ, taskId: task };
const otherScope: ScopeRef = { organId: organ, taskId: taskB };
const organScope: ScopeRef = { organId: organ };
const streamId = 'stream-a';
const streamB = 'stream-b';
const occurredAt = '2026-09-16T00:00:00.000Z';

const harnessPublisher: TrustedEventPublisher = {
  publisherId: 'publisher-harness',
  kind: 'harness',
  ownerId: 'harness-owner',
  scope,
  allowedClasses: ['control', 'data', 'observation'],
  capabilities: ['event.publish.control'],
};

const externalPublisher: TrustedEventPublisher = {
  publisherId: 'publisher-external',
  kind: 'external',
  ownerId: 'external-owner',
  scope,
  allowedClasses: ['data', 'observation'],
  capabilities: [],
};

const organHarnessPublisher: TrustedEventPublisher = {
  publisherId: 'publisher-organ-harness',
  kind: 'harness',
  ownerId: 'harness-owner',
  scope: organScope,
  allowedClasses: ['control', 'data', 'observation'],
  capabilities: ['event.publish.control'],
};

const consumerKey = 'owner-a|scope:organ-a/task-a|contract-v1';

function eventIdentityKey(streamIdValue: string, consumerKeyValue: string, messageIdValue: string): string {
  return `${streamIdValue.length}:${streamIdValue}${consumerKeyValue.length}:${consumerKeyValue}${messageIdValue.length}:${messageIdValue}`;
}

function consumer(overrides: Partial<EventConsumerBinding> = {}): EventConsumerBinding {
  return {
    consumerKey,
    consumerOwner: 'owner-a',
    scopeRef: 'scope:organ-a/task-a',
    contractVersion: 'contract-v1',
    scope,
    streamIds: [streamId],
    allowedClasses: ['control', 'data', 'observation'],
    retryLimit: 2,
    ...overrides,
  };
}

function evidence(label: string, evidenceScope: ScopeRef = scope): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: `records/${label}`,
    scope: evidenceScope,
  };
}

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    messageId: 'message-1',
    streamId,
    class: 'data',
    scope,
    occurredAt,
    summary: 'event message',
    evidenceRefs: [],
    ...overrides,
  };
}

class FakeJournal implements EventJournalPort, EventExternalOperationPort {
  events: EventRecord[] = [];
  receipts = new Map<string, EventConsumerReceipt>();
  cursors = new Map<string, NonNullable<Awaited<ReturnType<EventJournalPort['readCursor']>>>>();
  retries = new Map<string, EventRetryObligation>();
  dlq = new Map<string, EventDlqRecord>();
  externalOperations = new Map<string, EventExternalOperation>();
  barrierIntents = new Map<string, {
    consumerKey: string;
    messageId: string;
    streamId: string;
    handledSequence: number;
    intent: Extract<EventHandlerCommit, { completionMode: 'operation-barrier' }>;
  }>();
  externalOperationReads: string[] = [];
  appendCalls = 0;
  commitCalls = 0;
  failBeforeCommit = false;
  failAfterCommit = false;
  failRead = false;
  beforeCommit?: (input: ConsumerCommitRequest) => void;

  private cursorKey(streamId: string, consumerKeyValue: string): string {
    return `${streamId}:${consumerKeyValue}`;
  }

  async appendEvent(input: AppendEventRequest): Promise<EventRecord> {
    this.appendCalls += 1;
    if (this.failBeforeCommit) throw new Error('append failed');
    const sequence = this.events.filter((candidate) => candidate.streamId === input.event.streamId).length + 1;
    const record: EventRecord = {
      ...input.event,
      publisherId: input.publisherId,
      sequence,
      committedAt: occurredAt,
    };
    this.events.push(record);
    return record;
  }

  async readEvents(input: {
    readonly streamId: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<readonly EventRecord[]> {
    if (this.failRead) throw new Error('read failed');
    return this.events
      .filter((candidate) => candidate.streamId === input.streamId && candidate.sequence > input.afterSequence)
      .slice(0, input.limit);
  }

  async readEvent(input: {
    readonly streamId: string;
    readonly messageId: string;
  }): Promise<EventRecord | null> {
    return this.events.find(
      (candidate) => candidate.streamId === input.streamId && candidate.messageId === input.messageId,
    ) ?? null;
  }

  async readCursor(input: {
    readonly streamId: string;
    readonly consumerKey: string;
  }) {
    return this.cursors.get(this.cursorKey(input.streamId, input.consumerKey)) ?? null;
  }

  async commitConsumerCommit(input: ConsumerCommitRequest) {
    if (this.failBeforeCommit) throw new Error('commit failed');
    this.beforeCommit?.(input);
    const receiptKey = `${input.receipt.consumerKey}:${input.receipt.messageId}`;
    const existing = this.receipts.get(receiptKey);
    if (existing) {
      this.commitCalls += 1;
      const cursorKey = this.cursorKey(input.cursor.streamId, input.cursor.consumerKey);
      const existingCursor = this.cursors.get(cursorKey);
      if (existingCursor && existingCursor.lastHandledSequence >= input.cursor.lastHandledSequence) {
        return { receipt: existing, cursor: existingCursor };
      }
      this.cursors.set(cursorKey, input.cursor);
      if (this.failAfterCommit) throw new Error('ack lost after durable commit');
      return { receipt: existing, cursor: existingCursor ?? input.cursor };
    }
    const cursorKey = this.cursorKey(input.receipt.streamId, input.receipt.consumerKey);
    const existingCursor = this.cursors.get(cursorKey);
    if (existingCursor && existingCursor.lastHandledSequence >= input.receipt.handledSequence) {
      throw new Error('cursor already advanced');
    }
    this.receipts.set(receiptKey, input.receipt);
    this.cursors.set(cursorKey, input.cursor);
    this.commitCalls += 1;
    if (this.failAfterCommit) throw new Error('ack lost after durable commit');
    return { receipt: input.receipt, cursor: input.cursor };
  }

  async readReceipt(input: {
    readonly consumerKey: string;
    readonly messageId: string;
  }): Promise<EventConsumerReceipt | null> {
    return this.receipts.get(`${input.consumerKey}:${input.messageId}`) ?? null;
  }

  async commitRetryObligation(obligation: EventRetryObligation): Promise<EventRetryObligation> {
    if (this.failBeforeCommit) throw new Error('retry commit failed');
    this.retries.set(obligation.retryKey, obligation);
    return obligation;
  }

  async readRetryObligation(input: {
    readonly streamId: string;
    readonly consumerKey: string;
    readonly messageId: string;
  }): Promise<EventRetryObligation | null> {
    return [...this.retries.values()].find(
      (obligation) =>
        obligation.streamId === input.streamId
        && obligation.consumerKey === input.consumerKey
        && obligation.messageId === input.messageId,
    ) ?? null;
  }

  async listPendingRetryObligations(input: {
    readonly streamId: string;
    readonly consumerKey: string;
    readonly limit: number;
  }): Promise<readonly EventRetryObligation[]> {
    return [...this.retries.values()]
      .filter(
        (obligation) =>
          obligation.streamId === input.streamId
          && obligation.consumerKey === input.consumerKey
          && obligation.state === 'pending',
      )
      .slice(0, input.limit);
  }

  async commitDlq(record: EventDlqRecord): Promise<EventDlqRecord> {
    this.dlq.set(record.retryKey, record);
    return record;
  }

  async readDlq(input: {
    readonly streamId: string;
    readonly consumerKey: string;
    readonly messageId: string;
  }): Promise<EventDlqRecord | null> {
    return [...this.dlq.values()].find(
      (record) =>
        record.streamId === input.streamId
        && record.consumerKey === input.consumerKey
        && record.messageId === input.messageId,
    ) ?? null;
  }

  async readExternalOperation(input: {
    readonly operationRef: string;
    readonly consumerKey: string;
    readonly messageId: string;
  }): Promise<EventExternalOperation | null> {
    this.externalOperationReads.push(input.operationRef);
    return this.externalOperations.get(input.operationRef) ?? null;
  }

  async commitBarrierIntent(input: {
    consumerKey: string;
    messageId: string;
    streamId: string;
    handledSequence: number;
    intent: Extract<EventHandlerCommit, { completionMode: 'operation-barrier' }>;
  }) {
    const key = eventIdentityKey(input.streamId, input.consumerKey, input.messageId);
    const existing = this.barrierIntents.get(key);
    if (existing) return existing;
    this.barrierIntents.set(key, input);
    return input;
  }

  async readBarrierIntent(input: {
    consumerKey: string;
    messageId: string;
    streamId: string;
  }) {
    return this.barrierIntents.get(eventIdentityKey(input.streamId, input.consumerKey, input.messageId)) ?? null;
  }
}

class FakeRegistry implements EventPublisherRegistryPort, EventConsumerRegistryPort {
  publishers = new Map<string, TrustedEventPublisher>();
  consumers = new Map<string, EventConsumerBinding>();

  async resolvePublisher(publisherId: string): Promise<TrustedEventPublisher | null> {
    return this.publishers.get(publisherId) ?? null;
  }

  async resolveConsumer(consumerKeyValue: string): Promise<EventConsumerBinding | null> {
    return this.consumers.get(consumerKeyValue) ?? null;
  }
}

function ports(journal: FakeJournal, registry: FakeRegistry): EventBusPorts {
  return {
    journal,
    publishers: registry,
    consumers: registry,
    externalOperations: journal,
    barrierIntents: journal,
  };
}

function applied(messageId = 'message-1', effectRefs: readonly string[] = []): EventHandlerCommit {
  return {
    consumerKey,
    messageId,
    disposition: 'applied',
    completionMode: 'journal-atomic',
    internalEffectFacts: effectRefs,
    externalOperationRefs: [],
  };
}

function retryFailure(
  messageId: string,
  eventRecord: EventRecord,
  attempt: number,
  nextAttemptAt: string,
): EventHandlerCommit {
  return {
    consumerKey,
    messageId,
    retryObligation: {
      retryKey: eventIdentityKey(eventRecord.streamId, consumerKey, messageId),
      consumerKey,
      messageId,
      streamId: eventRecord.streamId,
      failedSequence: eventRecord.sequence,
      attempt,
      nextAttemptAt,
      ownerRef: 'owner-a',
      failureRef: 'retryable-failure',
      state: 'pending',
    },
  };
}

test('trusted harness publisher commits control before delivery; external and cross-scope publish rejected', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.publishers.set(externalPublisher.publisherId, externalPublisher);
  registry.consumers.set(consumerKey, consumer());

  const published = await publishEvent(ports(journal, registry), {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'control-1', class: 'control' }),
  });
  assert.equal(published.event.sequence, 1);
  assert.equal(published.event.publisherId, 'publisher-harness');
  assert.equal(journal.appendCalls, 1);

  const calls: string[] = [];
  const result = await consumeEvents(ports(journal, registry), { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    calls.push(event.messageId);
    return applied(event.messageId, ['effect:control-1']);
  });
  assert.deepEqual(calls, ['control-1']);
  assert.equal(result.committed[0]?.disposition, 'applied');
  assert.deepEqual(result.committed[0]?.effectRefs, ['effect:control-1']);

  await assert.rejects(
    () => publishEvent(ports(journal, registry), {
      publisherId: externalPublisher.publisherId,
      event: event({ messageId: 'external-control', class: 'control' }),
    }),
    EventPublisherError,
  );
  await assert.rejects(
    () => publishEvent(ports(journal, registry), {
      publisherId: externalPublisher.publisherId,
      event: event({ messageId: 'external-cross-scope', scope: otherScope }),
    }),
    EventPublisherError,
  );
});

test('untrusted publisher and out-of-scope evidence are rejected before append', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  const bus = ports(journal, registry);

  await assert.rejects(
    () => publishEvent(bus, {
      publisherId: 'publisher-not-trusted',
      event: event({ messageId: 'untrusted' }),
    }),
    EventPublisherError,
  );
  assert.equal(journal.appendCalls, 0);

  await assert.rejects(
    () => publishEvent(bus, {
      publisherId: harnessPublisher.publisherId,
      event: event({
        messageId: 'evidence-escape',
        evidenceRefs: [evidence('escape', otherScope)],
      }),
    }),
    /evidence scope exceeds event scope/,
  );
  assert.equal(journal.appendCalls, 0);
});

test('control, data, observation, and external observation all commit under their class gates', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.publishers.set(externalPublisher.publisherId, externalPublisher);
  registry.consumers.set(consumerKey, consumer());
  const bus = ports(journal, registry);

  for (const [messageId, eventClass] of [
    ['control-1', 'control'],
    ['data-1', 'data'],
    ['observation-1', 'observation'],
  ] as const) {
    await publishEvent(bus, {
      publisherId: harnessPublisher.publisherId,
      event: event({ messageId, class: eventClass }),
    });
  }
  await publishEvent(bus, {
    publisherId: externalPublisher.publisherId,
    event: event({ messageId: 'observation-external', class: 'observation' }),
  });

  const delivered: string[] = [];
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    delivered.push(event.class);
    return applied(event.messageId);
  });
  assert.deepEqual(delivered, ['control', 'data', 'observation', 'observation']);
  assert.equal(result.committed.length, 4);

  const replay = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    throw new Error('should not replay committed events');
  });
  assert.equal(replay.committed.length, 0);
  assert.equal(replay.retries.length, 0);
});

test('durable consumer commit is idempotent when ACK is lost after commit', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer());
  const bus = ports(journal, registry);

  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId: 'ack-lost' }) });

  let calls = 0;
  journal.failAfterCommit = true;
  await assert.rejects(
    () => consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
      calls += 1;
      return applied(event.messageId, ['effect:ack-lost']);
    }),
  );
  assert.equal(calls, 1);
  assert.equal(journal.commitCalls, 1);
  assert.equal(journal.receipts.size, 1);
  assert.equal(journal.cursors.size, 1);

  journal.failAfterCommit = false;
  calls = 0;
  const replay = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    calls += 1;
    return applied(event.messageId);
  });
  assert.equal(calls, 0);
  assert.equal(replay.committed.length, 0);
  assert.equal(replay.retries.length, 0);
});

test('offline replay reprocesses an uncommitted event and then resumes from a durable cursor', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer());
  const bus = ports(journal, registry);

  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId: 'offline-1' }) });
  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId: 'offline-2' }) });

  const firstCalls: string[] = [];
  const replayCalls: string[] = [];
  journal.failBeforeCommit = true;
  await assert.rejects(
    () => consumeEvents(bus, { consumerKey, limit: 1, now: occurredAt }, async ({ event }) => {
      firstCalls.push(event.messageId);
      return applied(event.messageId);
    }),
    /commit failed/,
  );
  assert.deepEqual(firstCalls, ['offline-1']);
  assert.equal(journal.receipts.size, 0);
  assert.equal(journal.cursors.size, 0);

  journal.failBeforeCommit = false;
  const replay = await consumeEvents(bus, { consumerKey, limit: 2, now: occurredAt }, async ({ event }) => {
    replayCalls.push(event.messageId);
    return applied(event.messageId);
  });
  assert.deepEqual(replayCalls, ['offline-1', 'offline-2']);
  assert.equal(replay.committed.length, 2);
  assert.equal(replay.cursors[1]?.lastHandledSequence, 2);

  const settled = await consumeEvents(bus, { consumerKey, limit: 2, now: occurredAt }, async () => {
    throw new Error('should not replay durable cursor');
  });
  assert.equal(settled.committed.length, 0);
  assert.equal(settled.retries.length, 0);
});

test('message id and consumer key form one receipt identity across streams', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ streamIds: [streamId, streamB] }));
  const bus = ports(journal, registry);

  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'collision', streamId }),
  });
  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'collision', streamId: streamB }),
  });

  const delivered: string[] = [];
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    delivered.push(event.streamId);
    return applied(event.messageId);
  });
  assert.deepEqual(delivered, [streamId]);
  assert.deepEqual(result.committed.map((receipt) => receipt.disposition), ['applied', 'duplicate']);

  const replay = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    throw new Error('should not replay a committed message identity');
  });
  assert.equal(replay.committed.length, 0);
  assert.equal(replay.retries.length, 0);
});

test('cross-stream duplicate advances the second cursor without replacing the canonical receipt', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ streamIds: [streamId, streamB] }));
  const bus = ports(journal, registry);

  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'canonical-collision', streamId }),
  });
  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'canonical-collision', streamId: streamB }),
  });

  let calls = 0;
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    calls += 1;
    return applied(event.messageId);
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.committed.map((receipt) => [receipt.streamId, receipt.disposition]), [
    [streamId, 'applied'],
    [streamB, 'duplicate'],
  ]);
  assert.equal(journal.receipts.size, 1);
  assert.equal((await journal.readReceipt({ consumerKey, messageId: 'canonical-collision' }))?.streamId, streamId);
  assert.equal((await journal.readCursor({ streamId, consumerKey }))?.lastHandledSequence, 1);
  assert.equal((await journal.readCursor({ streamId: streamB, consumerKey }))?.lastHandledSequence, 1);
});

test('already-receipted message ids cannot bypass ACL on colliding streams', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.publishers.set(organHarnessPublisher.publisherId, organHarnessPublisher);
  registry.consumers.set(consumerKey, consumer({
    currentEpoch: 2,
    streamIds: [streamId, streamB, 'stream-c'],
  }));
  const bus = ports(journal, registry);

  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'acl-collision', streamId, executionEpoch: 2 }),
  });
  await publishEvent(bus, {
    publisherId: organHarnessPublisher.publisherId,
    event: event({ messageId: 'acl-collision', streamId: streamB, scope: otherScope, executionEpoch: 2 }),
  });
  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'acl-collision', streamId: 'stream-c', executionEpoch: 1 }),
  });

  const delivered: string[] = [];
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    delivered.push(event.streamId);
    return applied(event.messageId);
  });

  assert.deepEqual(delivered, [streamId]);
  assert.deepEqual(result.committed.map((receipt) => [receipt.streamId, receipt.disposition]), [
    [streamId, 'applied'],
    [streamB, 'rejected'],
    ['stream-c', 'stale'],
  ]);
  assert.equal(journal.receipts.size, 1);
  assert.deepEqual(
    await journal.readReceipt({ consumerKey, messageId: 'acl-collision' }),
    {
      consumerKey,
      messageId: 'acl-collision',
      streamId,
      handledSequence: 1,
      disposition: 'applied',
      effectRefs: [],
      failureRef: undefined,
    },
  );
  assert.equal((await journal.readCursor({ streamId, consumerKey }))?.lastHandledSequence, 1);
  assert.equal((await journal.readCursor({ streamId: streamB, consumerKey }))?.lastHandledSequence, 1);
  assert.equal((await journal.readCursor({ streamId: 'stream-c', consumerKey }))?.lastHandledSequence, 1);
});

test('duplicate message identity in the same batch executes the handler once', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ streamIds: [streamId, streamB] }));
  const bus = ports(journal, registry);

  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'same-batch', streamId }),
  });
  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'same-batch', streamId: streamB }),
  });

  let calls = 0;
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    calls += 1;
    return applied(event.messageId);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.committed.map((receipt) => receipt.disposition), ['applied', 'duplicate']);
  assert.deepEqual(result.cursors.map((cursor) => cursor.streamId), [streamId, streamB]);
});

test('same-batch duplicate reauthorizes revoked and stale delivery before exposing canonical effects', async () => {
  for (const change of ['revoke', 'epoch'] as const) {
    const journal = new FakeJournal();
    const registry = new FakeRegistry();
    registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
    registry.consumers.set(consumerKey, consumer({ streamIds: [streamId, streamB], currentEpoch: 2 }));
    const bus = ports(journal, registry);
    const messageId = `same-batch-${change}`;

    await publishEvent(bus, {
      publisherId: harnessPublisher.publisherId,
      event: event({ messageId, streamId, executionEpoch: 2 }),
    });
    await publishEvent(bus, {
      publisherId: harnessPublisher.publisherId,
      event: event({ messageId, streamId: streamB, executionEpoch: 2 }),
    });

    journal.beforeCommit = (input) => {
      if (input.receipt.messageId !== messageId || input.receipt.streamId !== streamId) return;
      journal.beforeCommit = undefined;
      registry.consumers.set(
        consumerKey,
        consumer({
          streamIds: [streamId, streamB],
          currentEpoch: change === 'epoch' ? 3 : 2,
          revoked: change === 'revoke',
        }),
      );
    };

    const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event: delivery }) =>
      applied(delivery.messageId, [`effect:${change}`]));

    assert.deepEqual(result.committed.map((receipt) => [receipt.streamId, receipt.disposition, receipt.effectRefs]), [
      [streamId, 'applied', [`effect:${change}`]],
      [streamB, change === 'epoch' ? 'stale' : 'rejected', []],
    ]);
    assert.deepEqual(await journal.readReceipt({ consumerKey, messageId }), {
      consumerKey,
      messageId,
      streamId,
      handledSequence: 1,
      disposition: 'applied',
      effectRefs: [`effect:${change}`],
      failureRef: undefined,
    });
    assert.equal((await journal.readCursor({ streamId: streamB, consumerKey }))?.lastHandledSequence, 1);
  }
});

test('retry attempt is coordinator-owned and cannot be forged by the handler', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ retryLimit: 2 }));
  const bus = ports(journal, registry);

  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId: 'retry-forged' }) });

  await assert.rejects(
    () => consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
      return retryFailure(event.messageId, event, 2, '2026-09-16T00:00:10.000Z');
    }),
    /attempt is not coordinator-owned/,
  );
  assert.equal(journal.retries.size, 0);
  assert.equal(journal.receipts.size, 0);
  assert.equal(journal.cursors.size, 0);
});

test('handler cannot force retry exhaustion before the coordinator reaches the limit', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ retryLimit: 3 }));
  const bus = ports(journal, registry);

  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId: 'retry-early-exhaust' }) });

  await assert.rejects(
    () => consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
      return retryFailure(event.messageId, event, 3, '2026-09-16T00:00:10.000Z');
    }),
    /attempt is not coordinator-owned/,
  );
  assert.equal(journal.retries.size, 0);
  assert.equal(journal.receipts.size, 0);
  assert.equal(journal.dlq.size, 0);
  assert.equal(journal.cursors.size, 0);
});

test('retry obligation survives restart and bounded failure advances to terminal failure and DLQ', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ retryLimit: 2 }));
  const firstBus = ports(journal, registry);

  const published = await publishEvent(firstBus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'retry-1' }),
  });

  const firstResult = await consumeEvents(firstBus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    return retryFailure(event.messageId, event, 1, '2026-09-16T00:00:10.000Z');
  });
  assert.equal(firstResult.retries.length, 1);
  assert.equal(firstResult.retries[0]?.attempt, 1);
  assert.equal(firstResult.committed.length, 0);
  assert.equal(journal.cursors.size, 0);

  const secondBus = ports(journal, registry);
  const handlerCalls: string[] = [];
  const secondResult = await consumeEvents(
    secondBus,
    { consumerKey, limit: 10, now: '2026-09-16T00:00:20.000Z' },
    async ({ event, attempt }) => {
      handlerCalls.push(`${event.messageId}:${attempt}`);
      return retryFailure(event.messageId, event, 2, '2026-09-16T00:00:30.000Z');
    },
  );

  assert.deepEqual(handlerCalls, ['retry-1:2']);
  assert.equal(secondResult.committed[0]?.disposition, 'terminal-failure');
  assert.equal(secondResult.committed[0]?.failureRef, 'retryable-failure');
  assert.equal(secondResult.dlq.length, 1);
  assert.equal(secondResult.dlq[0]?.ownerRef, 'owner-a');
  assert.equal(secondResult.retries.length, 0);
  assert.equal(secondResult.cursors[0]?.lastHandledSequence, published.event.sequence);

  const afterTerminal = await consumeEvents(secondBus, { consumerKey, limit: 10, now: '2026-09-16T00:00:40.000Z' }, async () => {
    throw new Error('should not deliver after terminal failure');
  });
  assert.equal(afterTerminal.committed.length, 0);
  assert.equal(afterTerminal.dlq.length, 0);
});

test('cancelled retry obligations are terminal and never redelivered', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ retryLimit: 2 }));
  const bus = ports(journal, registry);
  const published = await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'retry-cancelled' }),
  });
  const retryKey = eventIdentityKey(published.event.streamId, consumerKey, published.event.messageId);
  await journal.commitRetryObligation({
    retryKey,
    consumerKey,
    messageId: published.event.messageId,
    streamId: published.event.streamId,
    failedSequence: published.event.sequence,
    attempt: 1,
    nextAttemptAt: '2026-09-16T00:00:00.000Z',
    ownerRef: 'owner-a',
    failureRef: 'cancelled-retry',
    state: 'cancelled',
  });
  let handlerCalls = 0;
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    handlerCalls += 1;
    return applied('retry-cancelled', ['asset://unexpected']);
  });

  assert.equal(handlerCalls, 0);
  assert.equal(result.committed[0]?.disposition, 'rejected');
  assert.equal(result.retries.length, 0);
});

test('retry obligations remain stream-scoped when message ids collide', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ streamIds: [streamId, streamB], retryLimit: 2 }));
  const bus = ports(journal, registry);

  const first = await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'retry-collision', streamId }),
  });
  const second = await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'retry-collision', streamId: streamB }),
  });
  const pending: EventRetryObligation = {
    retryKey: eventIdentityKey(first.event.streamId, consumerKey, first.event.messageId),
    consumerKey,
    messageId: first.event.messageId,
    streamId: first.event.streamId,
    failedSequence: first.event.sequence,
    attempt: 1,
    nextAttemptAt: '2026-09-16T00:00:30.000Z',
    ownerRef: 'owner-a',
    failureRef: 'retryable-failure',
    state: 'pending',
  };
  const exhausted: EventRetryObligation = {
    retryKey: eventIdentityKey(second.event.streamId, consumerKey, second.event.messageId),
    consumerKey,
    messageId: second.event.messageId,
    streamId: second.event.streamId,
    failedSequence: second.event.sequence,
    attempt: 2,
    nextAttemptAt: '2026-09-16T00:00:10.000Z',
    ownerRef: 'owner-a',
    failureRef: 'retryable-failure',
    state: 'exhausted',
  };
  journal.retries.set(pending.retryKey, pending);
  journal.retries.set(exhausted.retryKey, exhausted);

  let calls = 0;
  const result = await consumeEvents(
    bus,
    { consumerKey, limit: 10, now: '2026-09-16T00:00:20.000Z' },
    async () => {
      calls += 1;
      throw new Error('exhausted retry obligation should not invoke the handler');
    },
  );
  assert.equal(calls, 0);
  assert.deepEqual(result.retries.map((retry) => [retry.streamId, retry.state]), [[streamId, 'pending']]);
  assert.deepEqual(result.committed.map((receipt) => [receipt.streamId, receipt.disposition]), [
    [streamB, 'terminal-failure'],
  ]);
  assert.deepEqual(result.cursors.map((cursor) => cursor.streamId), [streamB]);
  assert.equal(await journal.readCursor({ streamId, consumerKey }), null);
  assert.equal((await journal.readCursor({ streamId: streamB, consumerKey }))?.lastHandledSequence, 1);
});

test('retry key encoding is unambiguous when identifiers contain delimiters', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  const collidingConsumerKey = 'owner-b:consumer';
  registry.consumers.set(collidingConsumerKey, consumer({
    consumerKey: collidingConsumerKey,
    streamIds: ['a', 'a:b'],
    retryLimit: 2,
  }));
  const bus = ports(journal, registry);

  const first = await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'd', streamId: 'a:b' }),
  });
  const second = await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'd', streamId: 'a' }),
  });
  assert.equal(
    eventIdentityKey(first.event.streamId, collidingConsumerKey, first.event.messageId)
      === eventIdentityKey(second.event.streamId, collidingConsumerKey, second.event.messageId),
    false,
  );
});

test('operation-barrier refuses final receipt without settled external operation refs', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer());
  const bus = ports(journal, registry);

  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId: 'op-barrier' }) });

  let handlerCalls = 0;
  await assert.rejects(
    () => consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
      handlerCalls += 1;
      return {
        consumerKey,
        messageId: event.messageId,
        disposition: 'applied',
        completionMode: 'operation-barrier',
        internalEffectFacts: ['effect:internal'],
        externalOperationRefs: [],
      };
    }),
    EventConsumerError,
  );
  assert.equal(handlerCalls, 1);
  assert.equal(journal.commitCalls, 0);
  assert.equal(journal.receipts.size, 0);

  await assert.rejects(
    () => consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
      handlerCalls += 1;
      return {
        consumerKey,
        messageId: event.messageId,
        disposition: 'applied',
        completionMode: 'journal-atomic',
        internalEffectFacts: ['effect:internal'],
        externalOperationRefs: ['operation:op-1'],
      };
    }),
    EventConsumerError,
  );
  assert.equal(handlerCalls, 2);
  assert.equal(journal.commitCalls, 0);
  assert.equal(journal.receipts.size, 0);

  journal.externalOperations.set('operation:op-1', {
    operationRef: 'operation:op-1',
    consumerKey,
    messageId: 'op-barrier',
    state: 'pending',
  });
  await assert.rejects(
    () => consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
      handlerCalls += 1;
      return {
        consumerKey,
        messageId: event.messageId,
        disposition: 'applied',
        completionMode: 'operation-barrier',
        internalEffectFacts: ['effect:internal'],
        externalOperationRefs: ['operation:op-1'],
      };
    }),
    /external operation is not settled or reconciled/,
  );
  assert.equal(handlerCalls, 3);
  assert.equal(journal.commitCalls, 0);
  assert.equal(journal.receipts.size, 0);

  journal.externalOperations.set('operation:op-1', {
    operationRef: 'operation:op-1',
    consumerKey,
    messageId: 'op-barrier',
    state: 'unknown',
  });
  const unknown = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    handlerCalls += 1;
    return {
      consumerKey,
      messageId: event.messageId,
      disposition: 'applied',
      completionMode: 'operation-barrier',
      internalEffectFacts: ['effect:internal'],
      externalOperationRefs: ['operation:op-1'],
    };
  });
  assert.equal(handlerCalls, 3);
  assert.deepEqual(unknown.blocked, [{
    consumerKey,
    messageId: 'op-barrier',
    streamId,
    operationRef: 'operation:op-1',
    reason: 'unknown-side-effect',
    action: 'reconcile',
  }]);
  assert.equal(unknown.committed.length, 0);
  assert.equal(unknown.cursors.length, 0);
  assert.equal(journal.commitCalls, 0);
  assert.equal(journal.receipts.size, 0);

  journal.externalOperations.set('operation:op-1', {
    operationRef: 'operation:op-1',
    consumerKey: 'other-consumer',
    messageId: 'op-barrier',
    state: 'settled',
  });
  await assert.rejects(
    () => consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
      handlerCalls += 1;
      return {
        consumerKey,
        messageId: event.messageId,
        disposition: 'applied',
        completionMode: 'operation-barrier',
        internalEffectFacts: ['effect:internal'],
        externalOperationRefs: ['operation:op-1'],
      };
    }),
    /external operation consumer key mismatch/,
  );
  assert.equal(handlerCalls, 3);
  assert.equal(journal.commitCalls, 0);
  assert.equal(journal.receipts.size, 0);

  journal.externalOperations.set('operation:op-1', {
    operationRef: 'operation:op-1',
    consumerKey,
    messageId: 'op-barrier',
    state: 'settled',
  });
  handlerCalls = 0;
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    handlerCalls += 1;
    return {
      consumerKey,
      messageId: event.messageId,
      disposition: 'applied',
      completionMode: 'operation-barrier',
      internalEffectFacts: ['effect:internal'],
      externalOperationRefs: ['operation:op-1'],
    };
  });
  assert.equal(handlerCalls, 0);
  assert.equal(result.committed[0]?.disposition, 'applied');
  assert.deepEqual(result.committed[0]?.effectRefs, ['effect:internal', 'operation:op-1']);

  const replay = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    throw new Error('should not deliver after committed barrier');
  });
  assert.equal(replay.committed.length, 0);
});

test('operation-barrier accepts a reconciled external operation', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer());
  const bus = ports(journal, registry);

  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId: 'op-reconciled' }) });
  journal.externalOperations.set('operation:op-reconciled', {
    operationRef: 'operation:op-reconciled',
    consumerKey,
    messageId: 'op-reconciled',
    state: 'reconciled',
  });

  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    return {
      consumerKey,
      messageId: event.messageId,
      disposition: 'applied',
      completionMode: 'operation-barrier',
      internalEffectFacts: ['effect:reconciled'],
      externalOperationRefs: ['operation:op-reconciled'],
    };
  });

  assert.equal(result.committed[0]?.disposition, 'applied');
  assert.deepEqual(result.committed[0]?.effectRefs, ['effect:reconciled', 'operation:op-reconciled']);
  assert.equal(result.blocked.length, 0);
  assert.equal(journal.receipts.size, 1);
  assert.equal(journal.cursors.size, 1);
});

test('operation-barrier driver persists intent before effects and recovers without replaying effects', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer());
  const bus = ports(journal, registry);
  const messageId = 'op-barrier-driver';
  const operationRef = 'operation:op-barrier-driver';
  const order: string[] = [];

  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId }) });
  await assert.rejects(
    () => consumeEvents(
      bus,
      { consumerKey, limit: 10, now: occurredAt },
      async () => { throw new Error('driver mode must not invoke the legacy handler'); },
      {
        async prepare({ event: delivery }) {
          order.push('prepare');
          return {
            consumerKey,
            messageId: delivery.messageId,
            disposition: 'applied',
            completionMode: 'operation-barrier',
            internalEffectFacts: ['effect:driver'],
            externalOperationRefs: [operationRef],
          };
        },
        async execute() {
          order.push('execute');
          throw new Error('interrupted after intent persistence');
        },
        async recover() {
          order.push('recover');
          throw new Error('still unknown');
        },
      },
    ),
    /interrupted after intent persistence/,
  );
  assert.deepEqual(order, ['prepare', 'execute']);
  assert.equal(journal.barrierIntents.size, 1);
  assert.equal(journal.receipts.size, 0);

  journal.externalOperations.set(operationRef, {
    operationRef,
    consumerKey,
    messageId,
    state: 'unknown',
  });
  const blocked = await consumeEvents(
    bus,
    { consumerKey, limit: 10, now: occurredAt },
    async () => { throw new Error('driver mode must not invoke the legacy handler'); },
    {
      async prepare() { throw new Error('persisted intent must not be prepared twice'); },
      async execute() { throw new Error('persisted intent must not execute twice'); },
      async recover() { order.push('recover-unknown'); },
    },
  );
  assert.deepEqual(order, ['prepare', 'execute', 'recover-unknown']);
  assert.deepEqual(blocked.blocked, [{
    consumerKey,
    messageId,
    streamId,
    operationRef,
    reason: 'unknown-side-effect',
    action: 'reconcile',
  }]);
  assert.equal(journal.receipts.size, 0);

  journal.externalOperations.set(operationRef, {
    operationRef,
    consumerKey,
    messageId,
    state: 'reconciled',
  });
  const recovered = await consumeEvents(
    bus,
    { consumerKey, limit: 10, now: occurredAt },
    async () => { throw new Error('driver mode must not invoke the legacy handler'); },
    {
      async prepare() { throw new Error('persisted intent must not be prepared twice'); },
      async execute() { throw new Error('persisted intent must not execute twice'); },
      async recover() { order.push('recover-reconciled'); },
    },
  );
  assert.deepEqual(order, ['prepare', 'execute', 'recover-unknown', 'recover-reconciled']);
  assert.equal(recovered.committed[0]?.disposition, 'applied');
  assert.deepEqual(recovered.committed[0]?.effectRefs, ['effect:driver', operationRef]);
  assert.equal(journal.receipts.size, 1);
  assert.equal(journal.cursors.size, 1);
});

test('operation-barrier driver can reject journal-atomically without executing effects', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer());
  const bus = ports(journal, registry);
  let executeCalls = 0;

  await publishEvent(bus, { publisherId: harnessPublisher.publisherId, event: event({ messageId: 'driver-rejected' }) });
  const result = await consumeEvents(
    bus,
    { consumerKey, limit: 10, now: occurredAt },
    async () => { throw new Error('driver mode must not invoke the legacy handler'); },
    {
      async prepare({ event: delivery }) {
        return {
          consumerKey,
          messageId: delivery.messageId,
          disposition: 'rejected',
          completionMode: 'journal-atomic',
          internalEffectFacts: [],
          externalOperationRefs: [],
          failureRef: 'bug-report-payload-missing',
        };
      },
      async execute() {
        executeCalls += 1;
      },
    },
  );

  assert.equal(executeCalls, 0);
  assert.equal(result.committed[0]?.disposition, 'rejected');
  assert.equal(result.committed[0]?.failureRef, 'bug-report-payload-missing');
  assert.equal(result.cursors[0]?.lastHandledSequence, 1);
  assert.equal(journal.receipts.size, 1);
  assert.equal(journal.cursors.size, 1);
});

test('operation-barrier checks unknown external operation before terminalizing after authorization changes', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ currentEpoch: 2 }));
  const bus = ports(journal, registry);
  const messageId = 'op-barrier-auth-change';
  const operationRef = 'operation:unknown-after-auth-change';

  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId, executionEpoch: 2 }),
  });
  journal.externalOperations.set(operationRef, {
    operationRef,
    consumerKey,
    messageId,
    state: 'unknown',
  });

  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event: delivery }) => {
    registry.consumers.set(consumerKey, consumer({ currentEpoch: 3 }));
    return {
      consumerKey,
      messageId: delivery.messageId,
      disposition: 'applied',
      completionMode: 'operation-barrier',
      internalEffectFacts: ['effect:unknown'],
      externalOperationRefs: [operationRef],
    };
  });

  assert.deepEqual(journal.externalOperationReads, [operationRef]);
  assert.deepEqual(result.blocked, [{
    consumerKey,
    messageId,
    streamId,
    operationRef,
    reason: 'unknown-side-effect',
    action: 'reconcile',
  }]);
  assert.equal(result.committed.length, 0);
  assert.equal(result.cursors.length, 0);
  assert.equal(journal.receipts.size, 0);
  assert.equal(journal.cursors.size, 0);
});

test('operation-barrier recovers the persisted intent across ACL/epoch changes and replay', async () => {
  for (const change of ['revoke', 'epoch'] as const) {
    for (const finalState of ['settled', 'reconciled'] as const) {
      const journal = new FakeJournal();
      const registry = new FakeRegistry();
      registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
      registry.consumers.set(consumerKey, consumer({ currentEpoch: 2 }));
      const bus = ports(journal, registry);
      const messageId = `op-barrier-recovery-${change}-${finalState}`;
      const operationRef = `operation:${messageId}`;

      await publishEvent(bus, {
        publisherId: harnessPublisher.publisherId,
        event: event({ messageId, executionEpoch: 2 }),
      });
      journal.externalOperations.set(operationRef, {
        operationRef,
        consumerKey,
        messageId,
        state: 'unknown',
      });

      let handlerCalls = 0;
      const first = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event: delivery }) => {
        handlerCalls += 1;
        return {
          consumerKey,
          messageId: delivery.messageId,
          disposition: 'applied',
          completionMode: 'operation-barrier',
          internalEffectFacts: [`effect:${change}:${finalState}`],
          externalOperationRefs: [operationRef],
        };
      });
      assert.equal(handlerCalls, 1);
      assert.equal(first.blocked.length, 1);
      assert.equal(first.committed.length, 0);
      assert.equal(first.cursors.length, 0);
      assert.equal(journal.barrierIntents.size, 1);
      assert.equal(journal.receipts.size, 0);
      assert.equal(journal.cursors.size, 0);

      registry.consumers.set(
        consumerKey,
        consumer({ currentEpoch: change === 'epoch' ? 3 : 2, revoked: change === 'revoke' }),
      );
      const second = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
        throw new Error('recovery must not invoke a new handler after authorization changes');
      });
      assert.equal(handlerCalls, 1);
      assert.equal(second.blocked.length, 1);
      assert.equal(second.committed.length, 0);
      assert.equal(second.cursors.length, 0);
      assert.deepEqual(journal.externalOperationReads, [operationRef, operationRef]);
      assert.equal(journal.receipts.size, 0);
      assert.equal(journal.cursors.size, 0);

      journal.externalOperations.set(operationRef, {
        operationRef,
        consumerKey,
        messageId,
        state: finalState,
      });
      const unauthorizedRecovery = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
        throw new Error('settled barrier recovery must not invoke a new handler');
      });
      assert.equal(unauthorizedRecovery.committed.length, 0);
      assert.equal(unauthorizedRecovery.cursors.length, 0);
      assert.equal(handlerCalls, 1);
      assert.equal(journal.commitCalls, 0);
      assert.equal(journal.receipts.size, 0);
      assert.equal(journal.cursors.size, 0);

      registry.consumers.set(consumerKey, consumer({ currentEpoch: 2 }));
      const recovered = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
        throw new Error('settled barrier recovery must not invoke a new handler');
      });
      assert.equal(recovered.committed.length, 1);
      assert.equal(recovered.committed[0]?.disposition, 'applied');
      assert.equal(recovered.cursors.length, 1);
      assert.equal(journal.commitCalls, 1);
      assert.equal(journal.receipts.size, 1);
      assert.equal(journal.cursors.size, 1);
      assert.deepEqual(journal.externalOperationReads, [operationRef, operationRef, operationRef, operationRef]);

      const replayJournal = new FakeJournal();
      replayJournal.events = [...journal.events];
      replayJournal.externalOperations = new Map(journal.externalOperations);
      replayJournal.barrierIntents = new Map(journal.barrierIntents);
      const replayBus = ports(replayJournal, registry);
      const replay = await consumeEvents(replayBus, { consumerKey, limit: 10, now: occurredAt }, async () => {
        throw new Error('rebuild/replay must recover the persisted barrier intent');
      });
      assert.equal(replay.committed.length, 1);
      assert.equal(replay.committed[0]?.disposition, 'applied');
      assert.equal(replay.cursors.length, 1);
      assert.equal(replayJournal.receipts.size, 1);
      assert.equal(replayJournal.cursors.size, 1);
      assert.deepEqual(replayJournal.externalOperationReads, [operationRef]);
    }
  }
});

test('scope ACL, epoch staleness, and permission revocation are rejected without handler delivery', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.publishers.set(organHarnessPublisher.publisherId, organHarnessPublisher);
  registry.consumers.set(consumerKey, consumer({ currentEpoch: 2 }));
  const bus = ports(journal, registry);

  await publishEvent(bus, {
    publisherId: organHarnessPublisher.publisherId,
    event: event({ messageId: 'cross-scope', class: 'data', scope: otherScope }),
  });
  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'stale-epoch', class: 'data', executionEpoch: 1 }),
  });

  let calls = 0;
  const first = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    calls += 1;
    return applied();
  });
  assert.equal(calls, 0);
  assert.deepEqual(first.committed.map((receipt) => [receipt.messageId, receipt.disposition]), [
    ['cross-scope', 'rejected'],
    ['stale-epoch', 'stale'],
  ]);

  registry.consumers.set(consumerKey, consumer({ currentEpoch: 2, revoked: true }));
  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'revoked-after-append', class: 'data' }),
  });
  const revoked = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    calls += 1;
    return applied();
  });
  assert.equal(calls, 0);
  assert.equal(revoked.committed[0]?.disposition, 'rejected');
  assert.equal(revoked.committed[0]?.failureRef, 'consumer-permission-revoked');
});

test('batch rechecks ACL after awaited handler revokes consumer before later delivery', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ currentEpoch: 2 }));
  const bus = ports(journal, registry);

  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'revoke-first', executionEpoch: 2 }),
  });
  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'revoke-second', executionEpoch: 2 }),
  });

  const handlerCalls: string[] = [];
  let secondExternalOperations = 0;
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    handlerCalls.push(event.messageId);
    if (event.messageId === 'revoke-first') {
      registry.consumers.set(consumerKey, consumer({ currentEpoch: 2, revoked: true }));
      return applied(event.messageId);
    }
    secondExternalOperations += 1;
    return applied(event.messageId, [`operation:${event.messageId}`]);
  });

  assert.deepEqual(handlerCalls, ['revoke-first']);
  assert.equal(secondExternalOperations, 0);
  assert.deepEqual(result.committed.map((receipt) => [receipt.messageId, receipt.disposition]), [
    ['revoke-first', 'rejected'],
    ['revoke-second', 'rejected'],
  ]);
  assert.equal((await journal.readReceipt({ consumerKey, messageId: 'revoke-first' }))?.disposition, 'rejected');
  assert.equal((await journal.readReceipt({ consumerKey, messageId: 'revoke-second' }))?.disposition, 'rejected');

  const replayCalls: string[] = [];
  const replay = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    replayCalls.push(event.messageId);
    return applied(event.messageId);
  });
  assert.deepEqual(replayCalls, []);
  assert.equal(replay.committed.length, 0);
});

test('batch rechecks epoch after awaited handler advances it', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ currentEpoch: 2 }));
  const bus = ports(journal, registry);

  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'epoch-first', executionEpoch: 2 }),
  });
  await publishEvent(bus, {
    publisherId: harnessPublisher.publisherId,
    event: event({ messageId: 'epoch-second', executionEpoch: 2 }),
  });

  const handlerCalls: string[] = [];
  const result = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async ({ event }) => {
    handlerCalls.push(event.messageId);
    if (event.messageId === 'epoch-first') {
      registry.consumers.set(consumerKey, consumer({ currentEpoch: 3 }));
    }
    return applied(event.messageId);
  });

  assert.deepEqual(handlerCalls, ['epoch-first']);
  assert.deepEqual(result.committed.map((receipt) => [receipt.messageId, receipt.disposition]), [
    ['epoch-first', 'stale'],
    ['epoch-second', 'stale'],
  ]);
  assert.equal((await journal.readReceipt({ consumerKey, messageId: 'epoch-first' }))?.disposition, 'stale');
  assert.equal((await journal.readReceipt({ consumerKey, messageId: 'epoch-second' }))?.disposition, 'stale');

  const replay = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    throw new Error('should not deliver after epoch advance');
  });
  assert.equal(replay.committed.length, 0);
});

test('consumer payload must not leak control fields through business payload', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer());
  const bus = ports(journal, registry);

  const badPayload: BusinessPayload = { steer: 'blocked' };
  await assert.rejects(
    () => publishEvent(bus, {
      publisherId: harnessPublisher.publisherId,
      event: event({ messageId: 'payload-control', payload: badPayload }),
    }),
    /control field leaked/,
  );
  assert.equal(journal.appendCalls, 0);
});

test('operation publication aligns duplicate and stale events with one durable consumer receipt', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  registry.consumers.set(consumerKey, consumer({ currentEpoch: 2 }));
  const bus = ports(journal, registry);
  const operationId = id('operation', 'operation-g2-alignment');
  const operationScope: ScopeRef = { ...scope, operationId };
  const operationStream = 'operation-events:organ-a/task-a';
  registry.consumers.set(consumerKey, consumer({
    currentEpoch: 2,
    streamIds: [operationStream],
  }));
  const notification: OperationEventNotificationPort = {
    async notify(): Promise<OperationEventNotificationAck> {
      return { ackRef: 'ack:operation-g2-alignment', acknowledgedAt: occurredAt };
    },
  };
  const event = {
    eventId: 'operation-g2-alignment',
    schemaVersion: 1 as const,
    kind: 'operation.started' as const,
    operationId,
    taskId: task,
    executionEpoch: 2,
    status: 'running' as const,
    occurredAt,
    evidenceRefs: [{
      ...evidence('operation-g2-alignment'),
      scope: operationScope,
    }],
  };
  const publicationPorts = {
    journal,
    publishers: registry,
  };

  const first = await publishOperationEvent(publicationPorts, notification, {
    publisherId: harnessPublisher.publisherId,
    streamId: operationStream,
    scope: operationScope,
    event,
    currentEpoch: 2,
  });
  const duplicate = await publishOperationEvent(publicationPorts, notification, {
    publisherId: harnessPublisher.publisherId,
    streamId: operationStream,
    scope: operationScope,
    event,
    currentEpoch: 2,
  });

  assert.equal(first.event.sequence, 1);
  assert.equal(duplicate.event.sequence, first.event.sequence);
  assert.equal(journal.events.length, 1);

  let handlerCalls = 0;
  const consumed = await consumeEvents(bus, {
    consumerKey,
    limit: 10,
    now: occurredAt,
  }, async ({ event: delivered }) => {
    handlerCalls += 1;
    return applied(delivered.messageId, ['effect:operation-g2-alignment']);
  });

  assert.equal(handlerCalls, 1);
  assert.equal(consumed.committed.length, 1);
  assert.equal(consumed.committed[0]?.disposition, 'applied');
  assert.equal(consumed.committed[0]?.handledSequence, first.event.sequence);
  assert.equal(consumed.cursors[0]?.lastHandledSequence, first.event.sequence);
  assert.equal(journal.receipts.size, 1);
  assert.equal(journal.cursors.size, 1);

  registry.consumers.set(consumerKey, consumer({
    currentEpoch: 3,
    streamIds: [operationStream],
  }));
  const stale = await publishOperationEvent(publicationPorts, notification, {
    publisherId: harnessPublisher.publisherId,
    streamId: operationStream,
    scope: operationScope,
    event: {
      ...event,
      eventId: 'operation-g2-stale',
      executionEpoch: 2,
    },
    currentEpoch: 2,
  });
  assert.equal(stale.event.sequence, 2);

  const staleResult = await consumeEvents(bus, {
    consumerKey,
    limit: 10,
    now: occurredAt,
  }, async () => {
    throw new Error('stale operation event must not reach handler');
  });
  assert.equal(handlerCalls, 1);
  assert.equal(staleResult.committed[0]?.disposition, 'stale');
  assert.equal(staleResult.cursors[0]?.lastHandledSequence, stale.event.sequence);
  assert.equal((await journal.readCursor({
    streamId: operationStream,
    consumerKey,
  }))?.lastHandledSequence, stale.event.sequence);
});

test('operation publication rejects journal failure and stale epoch before notification', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  const operationId = id('operation', 'operation-g2-failure');
  const operationScope: ScopeRef = { ...scope, operationId };
  const operationStream = 'operation-events:organ-a/task-a';
  const notifications: string[] = [];
  const notification: OperationEventNotificationPort = {
    async notify(input): Promise<OperationEventNotificationAck> {
      notifications.push(input.event.messageId);
      return { ackRef: `ack:${input.event.messageId}`, acknowledgedAt: occurredAt };
    },
  };
  const publicationPorts = {
    journal,
    publishers: registry,
  };
  const event = {
    eventId: 'operation-g2-failure',
    schemaVersion: 1 as const,
    kind: 'operation.started' as const,
    operationId,
    taskId: task,
    executionEpoch: 2,
    status: 'running' as const,
    occurredAt,
    evidenceRefs: [{
      ...evidence('operation-g2-failure'),
      scope: operationScope,
    }],
  };

  journal.failBeforeCommit = true;
  await assert.rejects(
    () => publishOperationEvent(publicationPorts, notification, {
      publisherId: harnessPublisher.publisherId,
      streamId: operationStream,
      scope: operationScope,
      event,
      currentEpoch: 2,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationEventPublicationError);
      assert.equal(error.code, 'journal-commit-failed');
      assert.equal(error.committed, false);
      return true;
    },
  );
  assert.equal(notifications.length, 0);

  journal.failBeforeCommit = false;
  journal.failRead = true;
  await assert.rejects(
    () => publishOperationEvent(publicationPorts, notification, {
      publisherId: harnessPublisher.publisherId,
      streamId: operationStream,
      scope: operationScope,
      event: { ...event, executionEpoch: 1 },
      currentEpoch: 2,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationEventPublicationError);
      assert.equal(error.code, 'stale-operation-event');
      assert.equal(error.committed, false);
      return true;
    },
  );
  assert.equal(notifications.length, 0);
});
