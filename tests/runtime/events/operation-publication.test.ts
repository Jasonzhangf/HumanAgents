import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  validateOperationEvent,
  type EvidenceRef,
  type OperationEvent,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  OperationEventPublicationError,
  publishOperationEvent,
  queryOperationEvents,
  replayOperationEventNotifications,
  type EventPublishPorts,
  type EventRecord,
  type OperationEventNotificationAck,
  type OperationEventNotificationPort,
  type TrustedEventPublisher,
} from '../../../packages/runtime/src/events/index.js';
import type {
  AppendEventRequest,
  EventJournalPort,
  EventPublisherRegistryPort,
} from '../../../packages/runtime/src/events/ports.js';

const organ = id('organ', 'organ-g2');
const task = id('task', 'task-g2');
const cycle = id('cycle', 'cycle-g2');
const operation = id('operation', 'operation-g2');
const scope: ScopeRef = { organId: organ, taskId: task, cycleId: cycle, operationId: operation };
const streamId = 'operation-events:task-g2';
const occurredAt = '2026-09-20T12:00:00.000Z';
const publisherId = 'gateway-operation-publisher';

const publisher: TrustedEventPublisher = {
  publisherId,
  kind: 'harness',
  ownerId: 'gateway-owner',
  scope: { organId: organ },
  allowedClasses: ['control'],
  capabilities: ['event.publish.control'],
};

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'operation-publication-test',
    locator: `operation/${operation.value}/${label}`,
    scope,
  };
}

function operationEvent(overrides: Partial<OperationEvent> = {}): OperationEvent {
  const value: OperationEvent = {
    eventId: 'operation-g2-event-1',
    schemaVersion: 1,
    kind: 'operation.started',
    operationId: operation,
    taskId: task,
    executionEpoch: 2,
    status: 'running',
    occurredAt,
    evidenceRefs: [evidence('started')],
    ...overrides,
  };
  validateOperationEvent(value);
  return value;
}

class FakePublisherRegistry implements EventPublisherRegistryPort {
  fail = false;

  async resolvePublisher(publisherIdValue: string): Promise<TrustedEventPublisher | null> {
    if (this.fail) throw new Error('publisher lookup failed');
    return publisherIdValue === publisher.publisherId ? publisher : null;
  }
}

class FakeEventJournal implements EventJournalPort {
  records: EventRecord[] = [];
  failRead = false;
  failAppend = false;
  appendCalls = 0;

  async appendEvent(input: AppendEventRequest): Promise<EventRecord> {
    this.appendCalls += 1;
    if (this.failAppend) throw new Error('journal append failed');
    const existing = this.records.find((record) =>
      record.streamId === input.event.streamId && record.messageId === input.event.messageId);
    if (existing) {
      const canonical = {
        ...input.event,
        publisherId: input.publisherId,
        sequence: existing.sequence,
        committedAt: existing.committedAt,
      };
      if (JSON.stringify(existing) !== JSON.stringify(canonical)) throw new Error('journal identity conflict');
      return existing;
    }
    const record: EventRecord = {
      ...input.event,
      publisherId: input.publisherId,
      sequence: this.records.filter((candidate) => candidate.streamId === input.event.streamId).length + 1,
      committedAt: occurredAt,
    };
    this.records.push(record);
    return record;
  }

  async readEvents(input: {
    readonly streamId: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<readonly EventRecord[]> {
    return this.records
      .filter((record) => record.streamId === input.streamId && record.sequence > input.afterSequence)
      .slice(0, input.limit);
  }

  async readEvent(input: {
    readonly streamId: string;
    readonly messageId: string;
  }): Promise<EventRecord | null> {
    if (this.failRead) throw new Error('journal read failed');
    return this.records.find((record) =>
      record.streamId === input.streamId && record.messageId === input.messageId) ?? null;
  }

  async readCursor(): Promise<never> { throw new Error('not implemented'); }
  async commitConsumerCommit(): Promise<never> { throw new Error('not implemented'); }
  async readReceipt(): Promise<never> { throw new Error('not implemented'); }
  async commitRetryObligation(): Promise<never> { throw new Error('not implemented'); }
  async readRetryObligation(): Promise<never> { throw new Error('not implemented'); }
  async listPendingRetryObligations(): Promise<never> { throw new Error('not implemented'); }
  async commitDlq(): Promise<never> { throw new Error('not implemented'); }
  async readDlq(): Promise<never> { throw new Error('not implemented'); }
}

class RecordingNotification implements OperationEventNotificationPort {
  readonly calls: Array<{ readonly messageId: string; readonly sequence: number }> = [];
  fail = false;

  async notify(input: { readonly event: EventRecord }): Promise<OperationEventNotificationAck> {
    this.calls.push({ messageId: input.event.messageId, sequence: input.event.sequence });
    if (this.fail) throw new Error('notification transport failed');
    return {
      ackRef: `ack:${input.event.messageId}`,
      acknowledgedAt: occurredAt,
    };
  }
}

function ports(journal: EventJournalPort, registry = new FakePublisherRegistry()): EventPublishPorts {
  return { journal, publishers: registry };
}

test('operation event is durably committed before notification and returns cursor/ack receipt', async () => {
  const journal = new FakeEventJournal();
  const notification = new RecordingNotification();
  const order: string[] = [];
  const originalAppend = journal.appendEvent.bind(journal);
  journal.appendEvent = async (input) => {
    const record = await originalAppend(input);
    order.push(`commit:${record.messageId}`);
    return record;
  };
  notification.notify = async (input) => {
    order.push(`publish:${input.event.messageId}`);
    return { ackRef: `ack:${input.event.messageId}`, acknowledgedAt: occurredAt };
  };

  const receipt = await publishOperationEvent(ports(journal), notification, {
    publisherId,
    streamId,
    scope,
    event: operationEvent(),
    currentEpoch: 2,
  });

  assert.deepEqual(order, ['commit:operation-g2-event-1', 'publish:operation-g2-event-1']);
  assert.equal(receipt.eventId, 'operation-g2-event-1');
  assert.equal(receipt.event.eventId, 'operation-g2-event-1');
  assert.equal(receipt.event.schemaVersion, 1);
  assert.equal(receipt.event.sequence, 1);
  assert.equal(receipt.cursor.sequence, 1);
  assert.equal(receipt.ack.ackRef, 'ack:operation-g2-event-1');
  assert.equal(receipt.duplicate, false);
  assert.equal(journal.records.length, 1);
});

test('journal commit failure is explicit and never notifies', async () => {
  const journal = new FakeEventJournal();
  journal.failAppend = true;
  const notification = new RecordingNotification();

  await assert.rejects(
    () => publishOperationEvent(ports(journal), notification, {
      publisherId,
      streamId,
      scope,
      event: operationEvent(),
      currentEpoch: 2,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationEventPublicationError);
      assert.equal(error.code, 'journal-commit-failed');
      assert.equal(error.committed, false);
      return true;
    },
  );
  assert.equal(notification.calls.length, 0);
  assert.equal(journal.records.length, 0);
});

test('duplicate operation event identity reuses the committed event and republishes idempotently', async () => {
  const journal = new FakeEventJournal();
  const notification = new RecordingNotification();
  const bus = ports(journal);
  const input = {
    publisherId,
    streamId,
    scope,
    event: operationEvent(),
    currentEpoch: 2,
  };

  const first = await publishOperationEvent(bus, notification, input);
  const duplicate = await publishOperationEvent(bus, notification, input);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.sequence, first.event.sequence);
  assert.deepEqual(notification.calls, [
    { messageId: 'operation-g2-event-1', sequence: 1 },
    { messageId: 'operation-g2-event-1', sequence: 1 },
  ]);
  assert.equal(journal.records.length, 1);
});

test('notification failure leaves the durable event queryable and restart replay backfills it', async () => {
  const journal = new FakeEventJournal();
  const notification = new RecordingNotification();
  notification.fail = true;
  const bus = ports(journal);

  await assert.rejects(
    () => publishOperationEvent(bus, notification, {
      publisherId,
      streamId,
      scope,
      event: operationEvent(),
      currentEpoch: 2,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationEventPublicationError);
      assert.equal(error.code, 'notification-failed');
      assert.equal(error.committed, true);
      assert.equal(error.cursor?.sequence, 1);
      return true;
    },
  );

  const queried = await queryOperationEvents({ journal }, {
    streamId,
    operationId: operation,
    limit: 10,
  });
  assert.equal(queried.length, 1);
  assert.equal(queried[0]?.messageId, 'operation-g2-event-1');

  notification.fail = false;
  notification.calls.length = 0;
  const replayed = await replayOperationEventNotifications(
    bus,
    notification,
    { streamId, operationId: operation, limit: 10, currentEpoch: 2 },
  );
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]?.duplicate, true);
  assert.deepEqual(notification.calls, [{ messageId: 'operation-g2-event-1', sequence: 1 }]);
});

test('stale operation epoch is rejected before journal read or notification', async () => {
  const journal = new FakeEventJournal();
  journal.failRead = true;
  const notification = new RecordingNotification();

  await assert.rejects(
    () => publishOperationEvent(ports(journal), notification, {
      publisherId,
      streamId,
      scope,
      event: operationEvent({ executionEpoch: 1 }),
      currentEpoch: 2,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationEventPublicationError);
      assert.equal(error.code, 'stale-operation-event');
      assert.equal(error.committed, false);
      return true;
    },
  );
  assert.equal(notification.calls.length, 0);
});

test('operation event id cannot be reused for a different operation identity', async () => {
  const journal = new FakeEventJournal();
  const notification = new RecordingNotification();
  const bus = ports(journal);
  await publishOperationEvent(bus, notification, {
    publisherId,
    streamId,
    scope,
    event: operationEvent(),
    currentEpoch: 2,
  });
  const otherOperation = id('operation', 'operation-g2-other');
  const otherScope = { ...scope, operationId: otherOperation };

  await assert.rejects(
    () => publishOperationEvent(bus, notification, {
      publisherId,
      streamId,
      scope: otherScope,
      event: operationEvent({
        operationId: otherOperation,
        evidenceRefs: [{
          ...evidence('other'),
          scope: otherScope,
        }],
      }),
      currentEpoch: 2,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationEventPublicationError);
      assert.equal(error.code, 'identity-conflict');
      return true;
    },
  );
  assert.equal(journal.records.length, 1);
});

test('operation query filters past unrelated stream events before applying its limit', async () => {
  const journal = new FakeEventJournal();
  const notification = new RecordingNotification();
  const bus = ports(journal);
  for (const [eventId, operationId] of [
    ['unrelated-1', 'operation-unrelated-1'],
    ['unrelated-2', 'operation-unrelated-2'],
  ] as const) {
    const eventOperation = id('operation', operationId);
    const eventScope = { ...scope, operationId: eventOperation };
    await publishOperationEvent(bus, notification, {
      publisherId,
      streamId,
      scope: eventScope,
      event: operationEvent({
        eventId,
        operationId: eventOperation,
        evidenceRefs: [{ ...evidence(eventId), scope: eventScope }],
      }),
      currentEpoch: 2,
    });
  }
  await publishOperationEvent(bus, notification, {
    publisherId,
    streamId,
    scope,
    event: operationEvent(),
    currentEpoch: 2,
  });

  const queried = await queryOperationEvents({ journal }, {
    streamId,
    operationId: operation,
    limit: 1,
  });
  assert.deepEqual(queried.map((record) => record.messageId), ['operation-g2-event-1']);
});
