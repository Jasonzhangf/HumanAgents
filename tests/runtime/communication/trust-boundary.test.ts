import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type BusinessPayload,
  type EvidenceRef,
} from '../../../packages/contracts/src/index.js';
import {
  CapabilityRegistry,
  CapabilityRegistryError,
  FeedbackHub,
  FeedbackPublicationError,
  type CapabilityRegistration,
} from '../../../packages/runtime/src/communication/index.js';
import type {
  EventEnvelope,
  EventRecord,
  TrustedEventPublisher,
} from '../../../packages/runtime/src/events/types.js';
import type {
  AppendEventRequest,
  EventJournalPort,
  EventPublisherRegistryPort,
} from '../../../packages/runtime/src/events/ports.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope = { organId: organ, taskId: task };
const now = '2026-09-17T00:00:00.000Z';

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: `records/${label}`,
    scope,
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

class FakeJournal implements EventJournalPort {
  appendCalls = 0;

  async appendEvent(input: AppendEventRequest): Promise<EventRecord> {
    this.appendCalls += 1;
    return {
      ...input.event,
      publisherId: input.publisherId,
      sequence: 1,
      committedAt: now,
    };
  }

  async readEvents(): Promise<readonly EventRecord[]> {
    return [];
  }

  async readEvent(): Promise<EventRecord | null> {
    return null;
  }

  async readCursor(): Promise<null> {
    return null;
  }

  async commitConsumerCommit(): Promise<never> {
    throw new Error('not used');
  }

  async readReceipt(): Promise<null> {
    return null;
  }

  async commitRetryObligation(obligation: never): Promise<never> {
    return obligation;
  }

  async readRetryObligation(): Promise<null> {
    return null;
  }

  async listPendingRetryObligations(): Promise<readonly never[]> {
    return [];
  }

  async commitDlq(record: never): Promise<never> {
    return record;
  }

  async readDlq(): Promise<null> {
    return null;
  }
}

class FakePublishers implements EventPublisherRegistryPort {
  readonly publishers = new Map<string, TrustedEventPublisher>();

  async resolvePublisher(publisherId: string): Promise<TrustedEventPublisher | null> {
    return this.publishers.get(publisherId) ?? null;
  }
}

test('registry wraps invalid execution epochs as typed registration failures', () => {
  const registry = new CapabilityRegistry();

  assert.throws(
    () => registry.register(registration({ executionEpoch: 0 })),
    (error: unknown) => {
      assert.ok(error instanceof CapabilityRegistryError);
      assert.equal(error.reason, 'registration-invalid');
      assert.equal(error.ownerRef, 'owner-worker');
      assert.deepEqual(error.nextAction, {
        kind: 'stop',
        ref: 'invalid-capability-registration',
      });
      assert.equal(error.evidenceRefs[0]?.evidenceId.value, 'evidence-registration');
      assert.ok(error.cause);
      return true;
    },
  );
});

test('feedback wraps invalid evidence as a typed publication failure', async () => {
  const journal = new FakeJournal();
  const publishers = new FakePublishers();
  publishers.publishers.set(harnessPublisher.publisherId, harnessPublisher);
  const hub = new FeedbackHub({ journal, publishers });
  const invalidEvidence = {
    ...evidence('invalid'),
    kind: 'invalid',
  } as unknown as EvidenceRef;

  await assert.rejects(
    hub.publish({
      kind: 'work-result',
      publisherId: harnessPublisher.publisherId,
      event: event({ evidenceRefs: [invalidEvidence] }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof FeedbackPublicationError);
      assert.equal(error.reason, 'event-envelope-invalid');
      assert.equal(error.ownerRef, 'runtime.agent-communication');
      assert.deepEqual(error.nextAction, {
        kind: 'stop',
        ref: 'invalid-feedback-event-envelope',
      });
      assert.equal(error.evidenceRefs[0]?.evidenceId.value, 'evidence-invalid');
      assert.ok(error.cause);
      return true;
    },
  );
  assert.equal(journal.appendCalls, 0);
});
