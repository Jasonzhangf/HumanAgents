import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type BusinessPayload, type EvidenceRef, type ScopeRef } from '../../../packages/contracts/src/index.js';
import {
  consumeEvents,
  EventConsumerError,
  EventPublisherError,
  publishEvent,
  type EventBusPorts,
  type ConsumerCommitRequest,
  type EventConsumerBinding,
  type EventConsumerReceipt,
  type EventDlqRecord,
  type EventEnvelope,
  type EventHandlerCommit,
  type EventRetryObligation,
  type EventRecord,
  type TrustedEventPublisher,
} from '../../../packages/runtime/src/events/index.js';
import type {
  AppendEventRequest,
  EventConsumerRegistryPort,
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

class FakeJournal implements EventJournalPort {
  events: EventRecord[] = [];
  receipts = new Map<string, EventConsumerReceipt>();
  cursors = new Map<string, NonNullable<Awaited<ReturnType<EventJournalPort['readCursor']>>>>();
  retries = new Map<string, EventRetryObligation>();
  dlq = new Map<string, EventDlqRecord>();
  appendCalls = 0;
  commitCalls = 0;
  failBeforeCommit = false;
  failAfterCommit = false;

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
    const receiptKey = `${input.receipt.streamId}:${input.receipt.consumerKey}:${input.receipt.messageId}`;
    const existing = this.receipts.get(receiptKey);
    if (existing) {
      this.commitCalls += 1;
      return { receipt: existing, cursor: input.cursor };
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
    readonly streamId: string;
    readonly consumerKey: string;
    readonly messageId: string;
  }): Promise<EventConsumerReceipt | null> {
    return this.receipts.get(`${input.streamId}:${input.consumerKey}:${input.messageId}`) ?? null;
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
    return this.retries.get(`${input.streamId}:${input.consumerKey}:${input.messageId}`) ?? null;
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
    return this.dlq.get(`${input.streamId}:${input.consumerKey}:${input.messageId}`) ?? null;
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
  return { journal, publishers: registry, consumers: registry };
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
      retryKey: `${eventRecord.streamId}:${consumerKey}:${messageId}`,
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

test('idempotent receipts remain scoped when message ids collide across streams', async () => {
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
  assert.deepEqual(delivered, [streamId, streamB]);
  assert.equal(result.committed.length, 2);

  const replay = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    throw new Error('should not replay committed event in another stream');
  });
  assert.equal(replay.committed.length, 0);
  assert.equal(replay.retries.length, 0);
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
  assert.equal(handlerCalls, 1);
  assert.equal(result.committed[0]?.disposition, 'applied');
  assert.deepEqual(result.committed[0]?.effectRefs, ['effect:internal', 'operation:op-1']);

  const replay = await consumeEvents(bus, { consumerKey, limit: 10, now: occurredAt }, async () => {
    throw new Error('should not deliver after committed barrier');
  });
  assert.equal(replay.committed.length, 0);
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
