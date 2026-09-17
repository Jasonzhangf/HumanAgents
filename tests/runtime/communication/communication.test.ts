import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type BusinessPayload,
  type EvidenceRef,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  CapabilityCallError,
  CapabilityRegistry,
  CapabilityRegistryError,
  FeedbackHub,
  FeedbackPublicationError,
  type CapabilityCallRequest,
  type CapabilityRegistration,
} from '../../../packages/runtime/src/communication/index.js';
import type {
  ConsumerCommitRequest,
  ConsumerCommitResult,
  ConsumerCursor,
  EventConsumerReceipt,
  EventDlqRecord,
  EventEnvelope,
  EventRecord,
  EventRetryObligation,
  TrustedEventPublisher,
} from '../../../packages/runtime/src/events/types.js';
import type {
  AppendEventRequest,
  EventJournalPort,
  EventPublisherRegistryPort,
  ReadCursorInput,
  ReadEventInput,
  ReadEventsInput,
  ReadExternalOperationInput,
  ReadReceiptInput,
  ReadRetryObligationInput,
} from '../../../packages/runtime/src/events/ports.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const taskB = id('task', 'task-b');
const scope: ScopeRef = { organId: organ, taskId: task };
const otherScope: ScopeRef = { organId: organ, taskId: taskB };
const now = '2026-09-17T00:00:00.000Z';

function evidence(label: string, evidenceScope: ScopeRef = scope): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: `records/${label}`,
    scope: evidenceScope,
  };
}

function registration(overrides: Partial<CapabilityRegistration> = {}): CapabilityRegistration {
  return {
    capabilityId: 'capability-worker-status',
    capabilityRef: 'task.status.read',
    ownerRef: 'owner-worker',
    scopeRef: 'organ-a::task-a',
    permissionRevision: 'permission-1',
    executionEpoch: 1,
    allowedCallerRefs: ['agent-caller'],
    evidenceRefs: [evidence('registration')],
    ...overrides,
  };
}

function call(overrides: Partial<CapabilityCallRequest> = {}): CapabilityCallRequest {
  return {
    requestId: 'request-1',
    capabilityId: 'capability-worker-status',
    capabilityRef: 'task.status.read',
    callerRef: 'agent-caller',
    scopeRef: 'organ-a::task-a',
    permissionRevision: 'permission-1',
    executionEpoch: 1,
    assignmentId: 'assignment-caller',
    inputRefs: ['asset://request-input'],
    evidenceRefs: [evidence('call')],
    requestedAt: now,
    ...overrides,
  };
}

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    messageId: 'message-1',
    streamId: 'stream-a',
    class: 'data',
    scope,
    occurredAt: now,
    summary: 'feedback',
    payload: { result: 'ready' } as BusinessPayload,
    evidenceRefs: [evidence('feedback')],
    ...overrides,
  };
}

const harnessPublisher: TrustedEventPublisher = {
  publisherId: 'publisher-harness',
  kind: 'harness',
  ownerId: 'harness-owner',
  scope,
  allowedClasses: ['control', 'data', 'observation'],
  capabilities: ['event.publish.control'],
};

const agentPublisher: TrustedEventPublisher = {
  publisherId: 'publisher-agent',
  kind: 'agent',
  ownerId: 'agent-owner',
  scope,
  allowedClasses: ['data', 'observation'],
  capabilities: [],
};

class FakeJournal implements EventJournalPort {
  readonly events: EventRecord[] = [];
  appendCalls = 0;
  failAppend = false;
  identityMismatch = false;

  async appendEvent(input: AppendEventRequest): Promise<EventRecord> {
    this.appendCalls += 1;
    if (this.failAppend) throw new Error('journal unavailable');
    const record: EventRecord = {
      ...input.event,
      messageId: this.identityMismatch ? `${input.event.messageId}-wrong` : input.event.messageId,
      streamId: input.event.streamId,
      publisherId: input.publisherId,
      sequence: this.events.filter((event) => event.streamId === input.event.streamId).length + 1,
      committedAt: now,
    };
    this.events.push(record);
    return record;
  }

  async readEvents(_input: ReadEventsInput): Promise<readonly EventRecord[]> {
    return this.events;
  }

  async readEvent(_input: ReadEventInput): Promise<EventRecord | null> {
    return null;
  }

  async readCursor(_input: ReadCursorInput): Promise<ConsumerCursor | null> {
    return null;
  }

  async commitConsumerCommit(_input: ConsumerCommitRequest): Promise<ConsumerCommitResult> {
    throw new Error('not used');
  }

  async readReceipt(_input: ReadReceiptInput): Promise<EventConsumerReceipt | null> {
    return null;
  }

  async commitRetryObligation(obligation: EventRetryObligation): Promise<EventRetryObligation> {
    return obligation;
  }

  async readRetryObligation(_input: ReadRetryObligationInput): Promise<EventRetryObligation | null> {
    return null;
  }

  async listPendingRetryObligations(): Promise<readonly EventRetryObligation[]> {
    return [];
  }

  async commitDlq(record: EventDlqRecord): Promise<EventDlqRecord> {
    return record;
  }

  async readDlq(_input: ReadRetryObligationInput): Promise<EventDlqRecord | null> {
    return null;
  }
}

class FakePublishers implements EventPublisherRegistryPort {
  readonly publishers = new Map<string, TrustedEventPublisher>();

  async resolvePublisher(publisherId: string): Promise<TrustedEventPublisher | null> {
    return this.publishers.get(publisherId) ?? null;
  }
}

test('registry registers, resolves, revokes, and rejects duplicate identity', () => {
  const registry = new CapabilityRegistry();
  const registered = registry.register(registration(), now);

  assert.equal(registered.capabilityId, 'capability-worker-status');
  assert.equal(registered.revoked, false);
  assert.equal(registry.resolve(registered.capabilityId)?.capabilityRef, 'task.status.read');

  assert.throws(() => registry.register(registration(), now), (error: unknown) => {
    assert.ok(error instanceof CapabilityRegistryError);
    assert.equal(error.reason, 'duplicate-capability-id');
    assert.equal(error.ownerRef, 'owner-worker');
    assert.deepEqual(error.nextAction, { kind: 'stop', ref: 'duplicate-capability-id' });
    assert.equal(error.evidenceRefs.length, 1);
    return true;
  });
  assert.throws(
    () => registry.register(registration({ capabilityId: 'capability-worker-status-2' }), now),
    (error: unknown) => error instanceof CapabilityRegistryError
      && error.reason === 'duplicate-capability-identity',
  );

  const revoked = registry.revoke(registered.capabilityId, 'owner-worker', [evidence('revoke')]);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.evidenceRefs.length, 2);
  assert.throws(() => registry.authorize(call()), (error: unknown) => {
    assert.ok(error instanceof CapabilityRegistryError);
    assert.equal(error.reason, 'capability-revoked');
    assert.equal(error.ownerRef, 'owner-worker');
    assert.deepEqual(error.nextAction, { kind: 'recover', ref: 'owner-worker' });
    return true;
  });
});

test('capability authorization denies scope, permission, epoch, and caller drift', () => {
  const registry = new CapabilityRegistry();
  registry.register(registration(), now);

  assert.throws(
    () => registry.authorize(call({ scopeRef: 'organ-a::task-b' })),
    (error: unknown) => error instanceof CapabilityRegistryError && error.reason === 'scope-denied',
  );
  assert.throws(
    () => registry.authorize(call({ permissionRevision: 'permission-2' })),
    (error: unknown) => error instanceof CapabilityRegistryError && error.reason === 'permission-denied',
  );
  assert.throws(
    () => registry.authorize(call({ executionEpoch: 2 })),
    (error: unknown) => error instanceof CapabilityRegistryError && error.reason === 'epoch-denied',
  );
  assert.throws(
    () => registry.authorize(call({ callerRef: 'agent-other' })),
    (error: unknown) => error instanceof CapabilityRegistryError && error.reason === 'caller-denied',
  );
});

test('capability call request exposes typed result and rejects private session access', () => {
  const registry = new CapabilityRegistry();
  registry.register(registration(), now);
  const authorized = registry.authorizeCapabilityCall(call());
  assert.equal(authorized.ownerRef, 'owner-worker');

  const forged = {
    ...call(),
    sessionRef: 'private-session',
  } as CapabilityCallRequest & { readonly sessionRef: string };
  assert.throws(() => registry.authorizeCapabilityCall(forged), (error: unknown) => {
    assert.ok(error instanceof CapabilityCallError);
    assert.equal(error.reason, 'private-session-access-forbidden');
    assert.equal(error.ownerRef, 'runtime.agent-communication');
    assert.deepEqual(error.nextAction, { kind: 'stop', ref: 'private-session-access-forbidden' });
    assert.equal(error.evidenceRefs.length, 1);
    return true;
  });
});

test('feedback hub persists typed M3 feedback through EventJournalPort', async () => {
  const journal = new FakeJournal();
  const publishers = new FakePublishers();
  publishers.publishers.set(agentPublisher.publisherId, agentPublisher);
  const hub = new FeedbackHub({ journal, publishers });

  const published = await hub.publish({
    kind: 'work-result',
    publisherId: agentPublisher.publisherId,
    event: event({ messageId: 'work-result-1' }),
  });

  assert.equal(journal.appendCalls, 1);
  assert.equal(journal.events.length, 1);
  assert.equal(published.kind, 'work-result');
  assert.equal(published.event.publisherId, agentPublisher.publisherId);
  assert.equal(published.event.messageId, 'work-result-1');
});

test('feedback hub maps all required M3 feedback kinds and enforces class', async () => {
  const journal = new FakeJournal();
  const publishers = new FakePublishers();
  publishers.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  const hub = new FeedbackHub({ journal, publishers });

  const kinds = [
    ['assignment-feedback', 'control'],
    ['work-result', 'data'],
    ['attention', 'data'],
    ['bug-report', 'data'],
    ['resource-notification', 'observation'],
    ['review-feedback', 'data'],
    ['memory-feedback', 'data'],
    ['schedule-reminder', 'observation'],
  ] as const;

  for (const [kind, eventClass] of kinds) {
    const published = await hub.publish({
      kind,
      publisherId: harnessPublisher.publisherId,
      event: event({
        messageId: `message-${kind}`,
        class: eventClass,
        payload: { kind },
      }),
    });
    assert.equal(published.kind, kind);
  }
  assert.equal(journal.events.length, kinds.length);

  await assert.rejects(
    hub.publish({
      kind: 'work-result',
      publisherId: harnessPublisher.publisherId,
      event: event({ messageId: 'wrong-class', class: 'observation' }),
    }),
    (error: unknown) => error instanceof FeedbackPublicationError
      && error.reason === 'feedback-class-mismatch',
  );
});

test('feedback hub requires harness publisher for control and trusted publisher for all classes', async () => {
  const journal = new FakeJournal();
  const publishers = new FakePublishers();
  publishers.publishers.set(agentPublisher.publisherId, agentPublisher);
  const hub = new FeedbackHub({ journal, publishers });

  await assert.rejects(
    hub.publish({
      kind: 'assignment-feedback',
      publisherId: agentPublisher.publisherId,
      event: event({ messageId: 'control-1', class: 'control' }),
    }),
    (error: unknown) => error instanceof FeedbackPublicationError
      && error.reason === 'control-requires-harness-publisher',
  );
  await assert.rejects(
    hub.publish({
      kind: 'work-result',
      publisherId: 'publisher-missing',
      event: event({ messageId: 'missing-publisher' }),
    }),
    (error: unknown) => error instanceof FeedbackPublicationError
      && error.reason === 'publisher-not-trusted',
  );
  assert.equal(journal.appendCalls, 0);
});

test('feedback evidence-bearing failures expose owner, reason, nextAction, and evidence', async () => {
  const journal = new FakeJournal();
  const publishers = new FakePublishers();
  publishers.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  const hub = new FeedbackHub({ journal, publishers });

  await assert.rejects(
    hub.publish({
      kind: 'work-result',
      publisherId: harnessPublisher.publisherId,
      event: event({ evidenceRefs: [evidence('outside', otherScope)] }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof FeedbackPublicationError);
      assert.equal(error.reason, 'evidence-scope-denied');
      assert.equal(error.ownerRef, 'runtime.agent-communication');
      assert.deepEqual(error.nextAction, { kind: 'stop', ref: 'feedback-evidence-scope-denied' });
      assert.equal(error.evidenceRefs[0]?.evidenceId.value, 'evidence-outside');
      return true;
    },
  );
  assert.equal(journal.appendCalls, 0);
});

test('feedback publication does not reconstruct control truth from payload', async () => {
  const journal = new FakeJournal();
  const publishers = new FakePublishers();
  publishers.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  const hub = new FeedbackHub({ journal, publishers });

  await assert.rejects(
    hub.publish({
      kind: 'work-result',
      publisherId: harnessPublisher.publisherId,
      event: event({ payload: { retry: true } }),
    }),
    (error: unknown) => error instanceof FeedbackPublicationError
      && error.reason === 'control-truth-in-payload',
  );
  assert.equal(journal.appendCalls, 0);
});
