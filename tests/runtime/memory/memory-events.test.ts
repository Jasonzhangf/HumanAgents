import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertBusinessPayload,
  id,
  type CanonicalMemoryScope,
  type EvidenceRef,
  type MemoryActorContext,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  consumeEvents,
  EventConsumerError,
  eventIdentityKey,
  publishEvent,
  type AppendEventRequest,
  type ConsumerCommitRequest,
  type EventBusPorts,
  type EventConsumerBinding,
  type EventConsumerReceipt,
  type EventDlqRecord,
  type EventEnvelope,
  type EventExternalOperation,
  type EventExternalOperationPort,
  type EventHandlerCommit,
  type EventJournalPort,
  type EventRecord,
  type EventRetryObligation,
  type TrustedEventPublisher,
} from '../../../packages/runtime/src/events/index.js';
import {
  createMemoryAnalysisEventHandler,
  createMemoryAnalysisRequestedEvent,
  createMemoryCurationFeedbackEvent,
  createMemoryProjectSourceUpdatedEvent,
  createMemoryTaskAnalysisEventHandler,
  MEMORY_ANALYSIS_REQUESTED_KIND,
  MEMORY_ATTENTION_KIND,
  MEMORY_CANDIDATE_REVIEW_REQUIRED_KIND,
  MEMORY_FEEDBACK_KIND,
  MEMORY_PROJECT_SOURCE_UPDATED_KIND,
  memoryAnalysisRequestFromEvent,
  memoryAnalysisBarrierDriver,
  memoryTaskAnalysisRequestFromEvent,
  type MemoryAnalysisAdmissionPort,
  type MemoryAnalysisWakeBinding,
  type MemoryTaskAnalysisWakeBinding,
} from '../../../packages/runtime/src/memory/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: ScopeRef = { organId: organ, taskId: task };
const memoryScope: CanonicalMemoryScope = {
  namespace: 'project',
  projectKey: 'project-a',
  organId: organ,
  taskId: task,
};
const actor: MemoryActorContext = {
  actorId: 'memory-agent-a',
  roleId: 'memory',
  permissions: ['memory.read', 'memory.propose'],
  projectKey: 'project-a',
};
const binding: MemoryAnalysisWakeBinding = {
  bindingRef: 'memory-binding:task-a',
  projectKey: 'project-a',
  executionEpoch: 2,
  scope: memoryScope,
  taskId: task,
  mainAgentId: 'main-agent-a',
  actor,
};
const taskBinding: MemoryTaskAnalysisWakeBinding = {
  bindingRef: 'memory-binding:task-a:task',
  projectKey: 'project-a',
  executionEpoch: 2,
  scope: {
    namespace: 'project',
    projectKey: 'project-a',
    organId: organ,
    taskId: task,
  },
  taskId: task,
  mainAgentId: 'main-agent-a',
  actor,
};
const streamId = 'memory-boundaries';
const occurredAt = '2026-09-17T00:00:00.000Z';

const publisher: TrustedEventPublisher = {
  publisherId: 'publisher-harness',
  kind: 'harness',
  ownerId: 'runtime-owner',
  scope,
  allowedClasses: ['data'],
  capabilities: [],
};

const consumer: EventConsumerBinding = {
  consumerKey: binding.bindingRef,
  consumerOwner: 'memory-agent',
  scopeRef: 'scope:organ-a/task-a',
  contractVersion: 'memory-analysis-v1',
  scope,
  streamIds: [streamId],
  allowedClasses: ['data'],
  retryLimit: 2,
  currentEpoch: 2,
};

function evidence(label: string, digest = `sha256:${label}`): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'test',
    locator: `journal://project-a/${label}`,
    digest,
    scope,
  };
}

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return createMemoryAnalysisRequestedEvent({
    messageId: 'message-a',
    streamId,
    scope,
    occurredAt,
    summary: 'checkpoint completed with a new source',
    evidenceRefs: [evidence('checkpoint-a')],
    executionEpoch: 2,
    trigger: 'completion',
    candidateCategory: 'project-fact',
    ...overrides,
  });
}

class FakeJournal implements EventJournalPort, EventExternalOperationPort {
  events: EventRecord[] = [];
  receipts = new Map<string, EventConsumerReceipt>();
  cursors = new Map<string, { streamId: string; consumerKey: string; lastHandledSequence: number; updatedAt: string }>();
  retries = new Map<string, EventRetryObligation>();
  dlq = new Map<string, EventDlqRecord>();
  barrierIntents = new Map<string, {
    consumerKey: string;
    messageId: string;
    streamId: string;
    handledSequence: number;
    intent: Extract<EventHandlerCommit, { completionMode: 'operation-barrier' }>;
  }>();
  failAfterCommit = false;
  externalOperations = new Map<string, EventExternalOperation>();

  async appendEvent(input: AppendEventRequest): Promise<EventRecord> {
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
    return this.cursors.get(`${input.streamId}:${input.consumerKey}`) ?? null;
  }

  async commitConsumerCommit(input: ConsumerCommitRequest) {
    const key = `${input.receipt.consumerKey}:${input.receipt.messageId}`;
    const cursorKey = `${input.cursor.streamId}:${input.cursor.consumerKey}`;
    const existing = this.receipts.get(key);
    if (existing) {
      const cursor = this.cursors.get(cursorKey);
      if (cursor && cursor.lastHandledSequence >= input.cursor.lastHandledSequence) {
        return { receipt: existing, cursor };
      }
      this.cursors.set(cursorKey, input.cursor);
      if (this.failAfterCommit) throw new Error('ack lost after durable commit');
      return { receipt: existing, cursor: cursor ?? input.cursor };
    }
    this.receipts.set(key, input.receipt);
    this.cursors.set(cursorKey, input.cursor);
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
    const operation = this.externalOperations.get(input.operationRef);
    return operation?.consumerKey === input.consumerKey && operation.messageId === input.messageId
      ? operation
      : null;
  }

  async commitExternalOperation(operation: EventExternalOperation): Promise<EventExternalOperation> {
    this.externalOperations.set(operation.operationRef, operation);
    return operation;
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

class FakeRegistry {
  publishers = new Map<string, TrustedEventPublisher>([[publisher.publisherId, publisher]]);
  consumers = new Map<string, EventConsumerBinding>([[consumer.consumerKey, consumer]]);

  async resolvePublisher(publisherId: string): Promise<TrustedEventPublisher | null> {
    return this.publishers.get(publisherId) ?? null;
  }

  async resolveConsumer(consumerKey: string): Promise<EventConsumerBinding | null> {
    return this.consumers.get(consumerKey) ?? null;
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

test('memory analysis event maps committed evidence into a typed request', async () => {
  const record: EventRecord = {
    ...event(),
    publisherId: publisher.publisherId,
    sequence: 1,
    committedAt: occurredAt,
  };
  const handler = createMemoryAnalysisEventHandler({
    binding,
    admission: {
      admit: async ({ request, event: delivered }) => {
        assert.ok(request.operationId.value.startsWith('memory-analysis-'));
        assert.equal(request.bindingRef, binding.bindingRef);
        assert.equal(request.projectKey, 'project-a');
        assert.equal(request.trigger, 'completion');
        assert.equal(request.requestedKind, 'semantic');
        assert.equal(request.executionEpoch, 2);
        assert.deepEqual(request.sourceRefs, ['journal://project-a/checkpoint-a']);
        assert.deepEqual(request.sourceDigests, ['sha256:checkpoint-a']);
        assert.equal(delivered.messageId, 'message-a');
        return { status: 'ready', value: { admissionRef: 'memory-admission:message-a' } };
      },
    },
    now: () => occurredAt,
  });
  const commit = await handler({ event: record, attempt: 1 });
  assert.equal('retryObligation' in commit, false);
  if ('retryObligation' in commit) throw new Error('expected commit');
  assert.equal(commit.disposition, 'applied');
  assert.equal(commit.completionMode, 'journal-atomic');
  assert.deepEqual(commit.internalEffectFacts, ['memory-admission:message-a']);
});

test('memory analysis consumer commits one receipt and does not redeliver after ACK loss', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });

  let admissions = 0;
  const admission: MemoryAnalysisAdmissionPort = {
    admit: async () => {
      admissions += 1;
      return { status: 'ready', value: { admissionRef: 'memory-admission:message-a' } };
    },
  };
  const handler = createMemoryAnalysisEventHandler({ binding, admission, now: () => occurredAt });

  journal.failAfterCommit = true;
  await assert.rejects(
    consumeEvents(bus, { consumerKey: binding.bindingRef, limit: 10, now: occurredAt }, handler),
    /ack lost/,
  );
  assert.equal(admissions, 1);
  assert.equal(journal.receipts.size, 1);
  assert.equal(journal.cursors.size, 1);

  journal.failAfterCommit = false;
  const replay = await consumeEvents(bus, { consumerKey: binding.bindingRef, limit: 10, now: occurredAt }, handler);
  assert.equal(admissions, 1);
  assert.equal(replay.committed.length, 0);
});

test('memory analysis operation ids distinguish the same message id on different streams', async () => {
  const operationIds: string[] = [];
  for (const stream of ['stream-a', 'stream-b']) {
    const journal = new FakeJournal();
    const registry = new FakeRegistry();
    registry.consumers.set(binding.bindingRef, {
      ...consumer,
      streamIds: [stream],
    });
    const bus = ports(journal, registry);
    await publishEvent(bus, {
      publisherId: publisher.publisherId,
      event: event({ messageId: 'shared-message', streamId: stream }),
    });
    await consumeEvents(
      bus,
      { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
      createMemoryAnalysisEventHandler({
        binding,
        admission: {
          admit: async ({ request }) => {
            operationIds.push(request.operationId.value);
            return { status: 'ready', value: { admissionRef: `admission-${stream}` } };
          },
        },
        now: () => occurredAt,
      }),
    );
  }
  assert.equal(new Set(operationIds).size, 2);
});

test('memory analysis operation ids distinguish colliding short-hash message ids', async () => {
  const operationIds: string[] = [];
  for (const messageId of ['d-xj', 'xFla']) {
    const journal = new FakeJournal();
    const registry = new FakeRegistry();
    const bus = ports(journal, registry);
    await publishEvent(bus, {
      publisherId: publisher.publisherId,
      event: event({ messageId, streamId: streamId }),
    });
    await consumeEvents(
      bus,
      { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
      createMemoryAnalysisEventHandler({
        binding,
        admission: {
          admit: async ({ request }) => {
            operationIds.push(request.operationId.value);
            return { status: 'ready', value: { admissionRef: `admission-${messageId}` } };
          },
        },
        now: () => occurredAt,
      }),
    );
  }
  assert.equal(new Set(operationIds).size, 2);
});

test('memory analysis operation ids stay valid for contract-valid stream ids', async () => {
  const stream = `stream:${'a'.repeat(120)}`;
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.consumers.set(binding.bindingRef, {
    ...consumer,
    streamIds: [stream],
  });
  const bus = ports(journal, registry);
  await publishEvent(bus, {
    publisherId: publisher.publisherId,
    event: event({ messageId: 'message-a', streamId: stream }),
  });
  let operationId: string | undefined;
  await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: {
        admit: async ({ request }) => {
          operationId = request.operationId.value;
          return { status: 'ready', value: { admissionRef: 'admission-valid-stream' } };
        },
      },
      now: () => occurredAt,
    }),
  );
  assert.ok(operationId);
  if (operationId === undefined) throw new Error('missing operation id');
  assert.equal(operationId.length, 80);
  assert.ok(operationId.startsWith('memory-analysis-'));
});

test('memory analysis consumer rejects malformed events without invoking admission', async () => {
  const wrongKind: EventEnvelope = {
    ...event({ messageId: 'wrong-kind' }),
    kind: 'memory.other',
  };
  const unsafeMessageId: EventEnvelope = {
    ...event({ messageId: 'unsafe-message-id' }),
    messageId: 'message:a',
  };
  const cases: readonly EventEnvelope[] = [
    wrongKind,
    unsafeMessageId,
    event({ executionEpoch: 3, messageId: 'wrong-epoch' }),
  ];

  for (const envelope of cases) {
    const journal = new FakeJournal();
    const registry = new FakeRegistry();
    const bus = ports(journal, registry);
    await publishEvent(bus, { publisherId: publisher.publisherId, event: envelope });
    let admissions = 0;
    const result = await consumeEvents(
      bus,
      { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
      createMemoryAnalysisEventHandler({
        binding,
        admission: {
          admit: async () => {
            admissions += 1;
            return { status: 'ready', value: { admissionRef: 'must-not-admit' } };
          },
        },
        now: () => occurredAt,
      }),
    );
    assert.equal(admissions, 0);
    assert.equal(result.committed.length, 1);
    assert.equal(result.committed[0]?.disposition, envelope.executionEpoch === 3 ? 'stale' : 'rejected');
  }

  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, {
    publisherId: publisher.publisherId,
    event: {
      ...event({ messageId: 'missing-evidence' }),
      evidenceRefs: [],
    },
  });
  let admissions = 0;
  const result = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: {
        admit: async () => {
          admissions += 1;
          return { status: 'ready', value: { admissionRef: 'must-not-admit' } };
        },
      },
      now: () => occurredAt,
    }),
  );
  assert.equal(admissions, 0);
  assert.equal(result.committed[0]?.disposition, 'rejected');
  assert.equal(result.committed[0]?.failureRef, 'memory-agent-event-evidence-missing');
});

test('memory analysis consumer rejects stale and future epochs even without a consumer epoch fence', async () => {
  for (const executionEpoch of [1, 3]) {
    const journal = new FakeJournal();
    const registry = new FakeRegistry();
    registry.consumers.set(binding.bindingRef, {
      ...consumer,
      currentEpoch: undefined,
    });
    const bus = ports(journal, registry);
    await publishEvent(bus, {
      publisherId: publisher.publisherId,
      event: event({ messageId: `wrong-binding-epoch-${executionEpoch}`, executionEpoch }),
    });
    let admissions = 0;
    const result = await consumeEvents(
      bus,
      { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
      createMemoryAnalysisEventHandler({
        binding,
        admission: {
          admit: async () => {
            admissions += 1;
            return { status: 'ready', value: { admissionRef: 'must-not-admit' } };
          },
        },
        now: () => occurredAt,
      }),
    );
    assert.equal(admissions, 0);
    assert.equal(result.committed[0]?.disposition, 'rejected');
    assert.equal(result.committed[0]?.failureRef, 'memory-agent-event-invalid');
  }
});

test('memory analysis consumer preserves a waiting admission as a durable retry obligation', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });

  const result = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: {
        admit: async () => ({
          status: 'waiting',
          issue: {
            code: 'memory-agent-analysis-unavailable',
            state: 'waiting',
            ownerId: 'memory-agent',
            message: 'backend unavailable',
            nextAction: { kind: 'wait', ref: 'memory-operations-ready' },
          },
        }),
      },
      now: () => occurredAt,
    }),
  );

  assert.equal(result.retries.length, 1);
  assert.equal(result.retries[0]?.attempt, 1);
  assert.equal(result.retries[0]?.ownerRef, 'memory-agent');
  assert.equal(result.committed.length, 0);
  assert.equal(result.cursors.length, 0);
  assert.equal(journal.cursors.size, 0);
  assert.equal(journal.receipts.size, 0);
});

test('memory analysis consumer rejects an interaction-bound provider-unsupported admission without retry', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });

  const result = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: {
        admit: async () => ({
          status: 'attention',
          issue: {
            code: 'memory-agent-analysis-provider-unsupported',
            state: 'attention',
            ownerId: 'memory-agent',
            message: 'memory analysis provider requires a task-bound request',
            nextAction: { kind: 'recover', ref: 'memory-analysis-provider' },
          },
        }),
      },
      now: () => occurredAt,
    }),
  );

  assert.equal(result.retries.length, 0);
  assert.equal(result.committed.length, 1);
  assert.equal(result.committed[0]?.disposition, 'rejected');
  assert.equal(result.committed[0]?.failureRef, 'memory-agent-analysis-provider-unsupported');
  assert.equal(journal.retries.size, 0);
  assert.equal(journal.receipts.size, 1);
  assert.equal(journal.receipts.get(`${binding.bindingRef}:message-a`)?.disposition, 'rejected');
  assert.equal(journal.receipts.get(`${binding.bindingRef}:message-a`)?.failureRef, 'memory-agent-analysis-provider-unsupported');
  assert.equal(journal.cursors.size, 1);
});

test('memory analysis consumer rejects deterministic admission attention without retry', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });

  const result = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: {
        admit: async () => ({
          status: 'attention',
          issue: {
            code: 'memory-agent-source-invalid',
            state: 'attention',
            ownerId: 'memory-agent',
            message: 'source needs recovery',
            nextAction: { kind: 'recover', ref: 'memory-source-integrity' },
          },
        }),
      },
      now: () => occurredAt,
    }),
  );

  assert.equal(result.retries.length, 0);
  assert.equal(result.committed.length, 1);
  assert.equal(result.committed[0]?.disposition, 'rejected');
  assert.equal(result.committed[0]?.failureRef, 'memory-agent-source-invalid');
  assert.equal(journal.retries.size, 0);
  assert.equal(result.cursors.length, 1);
  assert.equal(journal.cursors.size, 1);
  assert.equal(journal.receipts.size, 1);
});

test('memory analysis consumer rejects permanent admission scope denial without retry', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });

  const result = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: {
        admit: async () => ({
          status: 'attention',
          issue: {
            code: 'memory-agent-source-scope-denied',
            state: 'attention',
            ownerId: 'memory-agent',
            message: 'memory source scope denied',
            nextAction: { kind: 'recover', ref: 'memory-source-scope' },
          },
        }),
      },
      now: () => occurredAt,
    }),
  );

  assert.equal(result.retries.length, 0);
  assert.equal(result.committed.length, 1);
  assert.equal(result.committed[0]?.disposition, 'rejected');
  assert.equal(result.committed[0]?.failureRef, 'memory-agent-source-scope-denied');
  assert.equal(journal.retries.size, 0);
  assert.equal(result.cursors.length, 1);
  assert.equal(journal.cursors.size, 1);
  assert.equal(journal.receipts.size, 1);
});

test('memory analysis consumer retries transient admission attention without terminal receipt', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });

  const result = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: {
        admit: async () => ({
          status: 'attention',
          issue: {
            code: 'memory-agent-source-unavailable',
            state: 'attention',
            ownerId: 'memory-agent',
            message: 'evidence reader is temporarily unavailable',
            nextAction: { kind: 'wait', ref: 'memory-evidence-ready' },
          },
        }),
      },
      now: () => occurredAt,
    }),
  );

  assert.equal(result.retries.length, 1);
  assert.equal(result.retries[0]?.attempt, 1);
  assert.equal(result.retries[0]?.ownerRef, 'memory-agent');
  assert.equal(result.retries[0]?.failureRef, 'memory-agent-source-unavailable');
  assert.equal(result.committed.length, 0);
  assert.equal(result.cursors.length, 0);
  assert.equal(journal.cursors.size, 0);
  assert.equal(journal.receipts.size, 0);
});

test('memory analysis consumer retries unavailable prompt attention without terminal receipt', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });

  const result = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: {
        admit: async () => ({
          status: 'attention',
          issue: {
            code: 'memory-agent-prompt-unavailable',
            state: 'attention',
            ownerId: 'memory-agent',
            message: 'memory audit prompt is temporarily unavailable',
            nextAction: { kind: 'recover', ref: 'memory-audit-prompt' },
          },
        }),
      },
      now: () => occurredAt,
    }),
  );

  assert.equal(result.retries.length, 1);
  assert.equal(result.retries[0]?.attempt, 1);
  assert.equal(result.retries[0]?.ownerRef, 'memory-agent');
  assert.equal(result.retries[0]?.failureRef, 'memory-agent-prompt-unavailable');
  assert.equal(result.committed.length, 0);
  assert.equal(result.cursors.length, 0);
  assert.equal(journal.cursors.size, 0);
  assert.equal(journal.receipts.size, 0);
});

test('memory analysis barrier recovers a persisted pending operation after interrupted execution', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });
  let admissions = 0;
  const driver = memoryAnalysisBarrierDriver({
    binding,
    admission: {
      admit: async () => {
        admissions += 1;
        return { status: 'ready', value: { admissionRef: 'memory-admission:message-a' } };
      },
    },
    externalOperations: journal,
    now: () => occurredAt,
  });
  await assert.rejects(
    consumeEvents(
      bus,
      { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
      createMemoryAnalysisEventHandler({
        binding,
        admission: { admit: async () => { throw new Error('unused'); } },
      }),
      {
        ...driver,
        execute: async () => { throw new Error('interrupted after barrier intent'); },
      },
    ),
    /interrupted after barrier intent/,
  );
  assert.equal(admissions, 0);
  assert.equal(journal.barrierIntents.size, 1);
  assert.equal([...journal.externalOperations.values()][0]?.state, 'pending');

  const recovered = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: { admit: async () => { throw new Error('unused'); } },
    }),
    driver,
  );
  assert.equal(admissions, 1);
  assert.equal(recovered.committed.length, 1);
  assert.equal(recovered.committed[0]?.disposition, 'applied');
  assert.equal([...journal.externalOperations.values()][0]?.state, 'reconciled');
});

test('memory analysis barrier preserves transient retry and terminal rejection policy', async () => {
  for (const admission of [
    {
      expected: 'retry',
      outcome: {
        status: 'attention',
        issue: {
          code: 'memory-agent-source-unavailable',
          state: 'attention',
          ownerId: 'memory-agent',
          message: 'source unavailable',
          nextAction: { kind: 'wait', ref: 'memory-source-ready' },
        },
      },
    },
    {
      expected: 'reject',
      outcome: {
        status: 'attention',
        issue: {
          code: 'memory-agent-source-invalid',
          state: 'attention',
          ownerId: 'memory-agent',
          message: 'source invalid',
          nextAction: { kind: 'recover', ref: 'memory-source-integrity' },
        },
      },
    },
  ] as const) {
    const journal = new FakeJournal();
    const registry = new FakeRegistry();
    const bus = ports(journal, registry);
    await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });
    const result = await consumeEvents(
      bus,
      { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
      createMemoryAnalysisEventHandler({
        binding,
        admission: { admit: async () => { throw new Error('unused'); } },
      }),
      memoryAnalysisBarrierDriver({
        binding,
        admission: { admit: async () => admission.outcome },
        externalOperations: journal,
        now: () => occurredAt,
      }),
    );
    if (admission.expected === 'retry') {
      assert.equal(result.retries.length, 1);
      assert.equal(result.committed.length, 0);
      assert.equal([...journal.externalOperations.values()][0]?.state, 'pending');
    } else {
      assert.equal(result.retries.length, 0);
      assert.equal(result.committed[0]?.disposition, 'rejected');
      assert.equal(result.committed[0]?.failureRef, 'memory-agent-source-invalid');
      assert.equal([...journal.externalOperations.values()][0]?.state, 'failed');
    }
  }
});

test('memory analysis barrier fails explicitly when the external operation owner is read-only', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });

  const driver = memoryAnalysisBarrierDriver({
    binding,
    admission: {
      admit: async () => ({ status: 'ready', value: { admissionRef: 'memory-admission:read-only' } }),
    },
    externalOperations: {
      readExternalOperation: async () => null,
    },
    now: () => occurredAt,
  });

  await assert.rejects(
    consumeEvents(
      bus,
      { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
      createMemoryAnalysisEventHandler({
        binding,
        admission: { admit: async () => { throw new Error('unused'); } },
      }),
      driver,
    ),
    /memory analysis external operation owner is not writable/,
  );
});

test('memory analysis consumer rejects a binding mismatch before admission', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });
  let admissions = 0;
  const result = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding: {
        ...binding,
        scope: { namespace: 'project', projectKey: 'project-a', organId: organ, taskId: id('task', 'task-b') },
        taskId: id('task', 'task-b'),
      },
      admission: {
        admit: async () => {
          admissions += 1;
          return { status: 'ready', value: { admissionRef: 'must-not-admit' } };
        },
      },
    }),
  );
  assert.equal(admissions, 0);
  assert.equal(result.committed[0]?.disposition, 'rejected');
  assert.equal(result.committed[0]?.failureRef, 'memory-agent-event-scope-mismatch');
});

test('memory analysis consumer rejects an empty interaction scope before admission', async () => {
  const record: EventRecord = {
    ...event(),
    publisherId: publisher.publisherId,
    sequence: 1,
    committedAt: occurredAt,
  };
  let admissions = 0;
  const handler = createMemoryAnalysisEventHandler({
    binding: {
      ...binding,
      scope: { namespace: 'project', projectKey: 'project-a', organId: organ },
      taskId: undefined,
      interactionScopeId: '',
    },
    admission: {
      admit: async () => {
        admissions += 1;
        return { status: 'ready', value: { admissionRef: 'must-not-admit' } };
      },
    },
  });
  const commit = await handler({ event: record, attempt: 1 });
  assert.equal(admissions, 0);
  assert.equal('retryObligation' in commit, false);
  if ('retryObligation' in commit) throw new Error('expected rejection');
  assert.equal(commit.disposition, 'rejected');
  assert.equal(commit.failureRef, 'memory-agent-event-invalid');
});

test('memory analysis event kind is stable and data-only', () => {
  const envelope = event();
  assert.equal(envelope.kind, MEMORY_ANALYSIS_REQUESTED_KIND);
  assert.equal(envelope.class, 'data');
  assert.throws(() => createMemoryAnalysisRequestedEvent({
    messageId: 'message:a',
    streamId,
    scope,
    occurredAt,
    summary: 'invalid',
    evidenceRefs: [evidence('checkpoint-a')],
    executionEpoch: 2,
    trigger: 'completion',
    candidateCategory: 'project-fact',
  }), /cannot form a stable operation id/);
  assert.throws(() => createMemoryAnalysisRequestedEvent({
    messageId: 'missing-evidence',
    streamId,
    scope,
    occurredAt,
    summary: 'invalid',
    evidenceRefs: [],
    executionEpoch: 2,
    trigger: 'completion',
    candidateCategory: 'project-fact',
  }), /requires evidence refs/);
  assert.throws(() => createMemoryAnalysisRequestedEvent({
    messageId: 'missing-digest',
    streamId,
    scope,
    occurredAt,
    summary: 'invalid',
    evidenceRefs: [{ ...evidence('checkpoint-a'), digest: undefined }],
    executionEpoch: 2,
    trigger: 'completion',
    candidateCategory: 'project-fact',
  }), /require locators and digests/);
  assert.throws(() => createMemoryAnalysisRequestedEvent({
    messageId: 'invalid-category',
    streamId,
    scope,
    occurredAt,
    summary: 'invalid',
    evidenceRefs: [evidence('checkpoint-a')],
    executionEpoch: 2,
    trigger: 'completion',
    candidateCategory: 'invalid-category' as never,
  }), /candidate category is invalid/);
});

test('memory analysis event round-trips typed analysis inputs', () => {
  const analysisInputs = {
    corrections: [{
      sourceRef: 'journal://project-a/correction',
      sourceDigest: 'sha256:correction',
      fingerprint: 'correction-fingerprint',
    }],
    errors: [{
      sourceRef: 'journal://project-a/error',
      sourceDigest: 'sha256:error',
      fingerprint: 'error-fingerprint',
    }],
    rewindChains: [{
      failedBranchRef: 'journal://project-a/failed',
      rewindCheckpointRef: 'journal://project-a/rewind',
      recoveryCheckpointRef: 'journal://project-a/recovery',
      reentryFactRef: 'journal://project-a/reentry',
      successfulBranchRefs: ['journal://project-a/success'],
      successEvidenceRefs: ['journal://project-a/success-evidence'],
      absoluteJournalRefs: ['journal://project-a/journal'],
    }],
    actualPathRefs: ['journal://project-a/actual-path'],
    declaredPathRefs: ['project://project-a/AGENTS.md'],
  };
  const envelope = createMemoryAnalysisRequestedEvent({
    messageId: 'message-with-analysis-inputs',
    streamId,
    scope,
    occurredAt,
    summary: 'rewind with typed evidence',
    evidenceRefs: [
      evidence('failed'),
      evidence('rewind'),
      evidence('recovery'),
      evidence('reentry'),
      evidence('success'),
      evidence('success-evidence'),
      evidence('journal'),
      evidence('actual-path'),
      evidence('declared-path'),
    ],
    executionEpoch: 2,
    trigger: 'rewind',
    candidateCategory: 'project-experience',
    analysisInputs,
  });
  assert.deepEqual(envelope.payload?.analysisInputs, analysisInputs);

  const record: EventRecord = {
    ...envelope,
    publisherId: publisher.publisherId,
    sequence: 1,
    committedAt: occurredAt,
  };
  const request = memoryAnalysisRequestFromEvent(record, binding);
  assert.equal(request.status, 'ready');
  if (request.status !== 'ready') throw new Error(request.issue.message);
  assert.deepEqual(request.value.analysisInputs, analysisInputs);

  assert.throws(() => createMemoryAnalysisRequestedEvent({
    messageId: 'message-with-invalid-analysis-inputs',
    streamId,
    scope,
    occurredAt,
    summary: 'invalid analysis inputs',
    evidenceRefs: [evidence('invalid')],
    executionEpoch: 2,
    trigger: 'rewind',
    candidateCategory: 'project-experience',
    analysisInputs: {
      ...analysisInputs,
      rewindChains: [],
      actualPathRefs: [],
      declaredPathRefs: ['project://project-a/AGENTS.md'],
    },
  }), /actualPathRefs are required/);

  const invalidRecord: EventRecord = {
    ...record,
    payload: {
      ...record.payload,
      analysisInputs: {
        ...analysisInputs,
        rewindChains: [],
        actualPathRefs: [],
        declaredPathRefs: ['project://project-a/AGENTS.md'],
      },
    } as unknown as EventRecord['payload'],
  };
  const rejected = memoryAnalysisRequestFromEvent(invalidRecord, binding);
  assert.equal(rejected.status, 'attention');
  if (rejected.status !== 'attention') throw new Error('expected invalid analysis inputs');
  assert.equal(rejected.issue.code, 'memory-agent-event-invalid');
});

test('memory analysis inputs reject unknown fields at every object boundary', () => {
  const analysisInputs = {
    corrections: [{
      sourceRef: 'journal://project-a/correction',
      sourceDigest: 'sha256:correction',
      fingerprint: 'correction-fingerprint',
    }],
    errors: [{
      sourceRef: 'journal://project-a/error',
      sourceDigest: 'sha256:error',
      fingerprint: 'error-fingerprint',
    }],
    rewindChains: [{
      failedBranchRef: 'journal://project-a/failed',
      rewindCheckpointRef: 'journal://project-a/rewind',
      recoveryCheckpointRef: 'journal://project-a/recovery',
      reentryFactRef: 'journal://project-a/reentry',
      successfulBranchRefs: ['journal://project-a/success'],
      successEvidenceRefs: ['journal://project-a/success-evidence'],
      absoluteJournalRefs: ['journal://project-a/journal'],
    }],
    actualPathRefs: ['journal://project-a/actual-path'],
    declaredPathRefs: ['project://project-a/AGENTS.md'],
  };
  const invalidInputs = [
    { ...analysisInputs, forgedControlField: true },
    {
      ...analysisInputs,
      corrections: [{ ...analysisInputs.corrections[0], forgedControlField: true }],
    },
    {
      ...analysisInputs,
      errors: [{ ...analysisInputs.errors[0], forgedControlField: true }],
    },
    {
      ...analysisInputs,
      rewindChains: [{ ...analysisInputs.rewindChains[0], forgedControlField: true }],
    },
  ];

  for (const invalidInputsEntry of invalidInputs) {
    assert.throws(() => createMemoryAnalysisRequestedEvent({
      messageId: 'message-with-unknown-analysis-field',
      streamId,
      scope,
      occurredAt,
      summary: 'unknown analysis field',
      evidenceRefs: [evidence('checkpoint-a')],
      executionEpoch: 2,
      trigger: 'rewind',
      candidateCategory: 'project-experience',
      analysisInputs: invalidInputsEntry,
    }), /unsupported key/);

    const record: EventRecord = {
      messageId: 'message-with-unknown-analysis-field',
      streamId,
      kind: MEMORY_ANALYSIS_REQUESTED_KIND,
      class: 'data',
      scope,
      occurredAt,
      summary: 'unknown analysis field',
      payload: {
        trigger: 'rewind',
        requestedKind: 'procedural',
        candidateCategory: 'project-experience',
        analysisInputs: invalidInputsEntry,
      } as unknown as EventRecord['payload'],
      evidenceRefs: [evidence('checkpoint-a')],
      executionEpoch: 2,
      publisherId: publisher.publisherId,
      sequence: 1,
      committedAt: occurredAt,
    };
    const rejected = memoryAnalysisRequestFromEvent(record, binding);
    assert.equal(rejected.status, 'attention');
    if (rejected.status !== 'attention') throw new Error('expected unknown analysis field rejection');
    assert.equal(rejected.issue.code, 'memory-agent-event-invalid');
  }
});

test('project source update facts use a dedicated data event contract', () => {
  const envelope = createMemoryProjectSourceUpdatedEvent({
    messageId: 'project-source-update-a',
    streamId: 'memory-project-source-updates:project-a',
    scope,
    occurredAt,
    executionEpoch: 2,
    target: 'project-agents',
    sourceRef: 'project://project-a/AGENTS.md',
    previousRevision: 'sha256:previous-revision',
    previousDigest: 'sha256:previous-digest',
    nextRevision: 'sha256:next-revision',
    nextDigest: 'sha256:next-digest',
    patchRef: 'project-agents-next',
    patchDigest: `sha256:${'a'.repeat(64)}`,
    sourceEvidenceRefs: ['journal://project-a/evidence'],
  });
  assert.equal(envelope.kind, MEMORY_PROJECT_SOURCE_UPDATED_KIND);
  assert.equal(envelope.class, 'data');
  assert.equal(envelope.streamId, 'memory-project-source-updates:project-a');
  assert.deepEqual(envelope.evidenceRefs, []);
  assert.deepEqual(envelope.payload?.sourceEvidenceRefs, ['journal://project-a/evidence']);
});

test('memory curation results map to typed durable feedback events', () => {
  const prompt = {
    promptRef: 'project-memory-audit',
    canonicalRef: 'prompt://project-a/project-memory-audit',
    revision: 'sha256:prompt-revision',
    digest: 'sha256:prompt-digest',
    loadedAt: occurredAt,
  };
  const candidate = createMemoryCurationFeedbackEvent({
    messageId: 'feedback-candidate',
    streamId: 'memory-feedback:task-a',
    scope,
    occurredAt,
    executionEpoch: 2,
    result: {
      curation: {
        operationId: id('operation', 'analysis-a'),
        auditPrompt: prompt,
        sourceRefs: ['journal://project-a/checkpoint-a'],
        outcome: 'candidate',
        candidateId: 'candidate-a',
        matchedMemoryIds: [],
        conflictRefs: [],
        explanation: 'new project fact',
        nextAction: 'review',
      },
      submission: {
        submissionId: 'submission-a',
        status: 'accepted',
        candidateId: 'candidate-a',
        operationId: id('operation', 'analysis-a'),
        nextAction: 'review-required',
      },
      projectSources: [],
      liveContextMutated: false,
      promptSnapshot: prompt,
    },
  });
  assert.equal(candidate.kind, MEMORY_CANDIDATE_REVIEW_REQUIRED_KIND);
  assert.equal(candidate.class, 'data');
  assert.doesNotThrow(() => assertBusinessPayload(candidate.payload!));
  assert.equal(candidate.payload?.candidateId, 'candidate-a');
  assert.equal(candidate.payload?.submissionId, 'submission-a');
  assert.equal(candidate.payload?.analysisRef, 'analysis-a');
  assert.equal('operationId' in (candidate.payload ?? {}), false);
  assert.equal('nextAction' in (candidate.payload ?? {}), false);

  const supersede = createMemoryCurationFeedbackEvent({
    messageId: 'feedback-supersede',
    streamId: 'memory-feedback:task-a',
    scope,
    occurredAt,
    executionEpoch: 2,
    result: {
      curation: {
        operationId: id('operation', 'analysis-supersede'),
        auditPrompt: prompt,
        sourceRefs: ['journal://project-a/checkpoint-supersede'],
        outcome: 'candidate',
        candidateId: 'candidate-supersede',
        matchedMemoryIds: [],
        conflictRefs: [],
        explanation: 'candidate supersedes an existing memory',
        nextAction: 'supersede-review',
      },
      projectSources: [],
      liveContextMutated: false,
      promptSnapshot: prompt,
    },
  });
  assert.equal(supersede.kind, MEMORY_CANDIDATE_REVIEW_REQUIRED_KIND);

  const duplicate = createMemoryCurationFeedbackEvent({
    messageId: 'feedback-duplicate',
    streamId: 'memory-feedback:task-a',
    scope,
    occurredAt,
    executionEpoch: 2,
    result: {
      curation: {
        operationId: id('operation', 'analysis-b'),
        auditPrompt: prompt,
        sourceRefs: ['journal://project-a/checkpoint-b'],
        outcome: 'duplicate',
        matchedMemoryIds: ['memory://known'],
        conflictRefs: [],
        explanation: 'already known',
        nextAction: 'none',
      },
      projectSources: [],
      liveContextMutated: false,
      promptSnapshot: prompt,
    },
  });
  assert.equal(duplicate.kind, MEMORY_FEEDBACK_KIND);
  assert.deepEqual(duplicate.payload?.matchedMemoryIds, ['memory://known']);

  const attention = createMemoryCurationFeedbackEvent({
    messageId: 'feedback-attention',
    streamId: 'memory-feedback:task-a',
    scope,
    occurredAt,
    executionEpoch: 2,
    result: {
      curation: {
        operationId: id('operation', 'analysis-c'),
        auditPrompt: prompt,
        sourceRefs: ['journal://project-a/checkpoint-c'],
        outcome: 'attention',
        matchedMemoryIds: [],
        conflictRefs: [],
        explanation: 'source needs recovery',
        nextAction: 'attention',
      },
      projectSources: [],
      liveContextMutated: false,
      promptSnapshot: prompt,
    },
  });
  assert.equal(attention.kind, MEMORY_ATTENTION_KIND);
});

test('memory analysis barrier publishes feedback before settling and retries without duplicate effects', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  const bus = ports(journal, registry);
  await publishEvent(bus, { publisherId: publisher.publisherId, event: event() });
  const published: EventEnvelope[] = [];
  let failPublication = true;
  const driver = memoryAnalysisBarrierDriver({
    binding,
    admission: {
      admit: async () => ({
        status: 'ready',
        value: {
          admissionRef: 'memory-admission:message-a',
          result: {
            curation: {
              operationId: id('operation', 'analysis-a'),
              auditPrompt: {
                promptRef: 'project-memory-audit',
                canonicalRef: 'prompt://project-a/project-memory-audit',
                revision: 'sha256:prompt-revision',
                digest: 'sha256:prompt-digest',
                loadedAt: occurredAt,
              },
              sourceRefs: ['journal://project-a/checkpoint-a'],
              outcome: 'candidate',
              candidateId: 'candidate-a',
              matchedMemoryIds: [],
              conflictRefs: [],
              explanation: 'candidate requires review',
              nextAction: 'review',
            },
            projectSources: [],
            liveContextMutated: false,
            promptSnapshot: {
              promptRef: 'project-memory-audit',
              canonicalRef: 'prompt://project-a/project-memory-audit',
              revision: 'sha256:prompt-revision',
              digest: 'sha256:prompt-digest',
              loadedAt: occurredAt,
            },
          },
        },
      }),
    },
    externalOperations: journal,
    publishFeedback: async (candidate) => {
      if (failPublication) throw new Error('feedback journal unavailable');
      published.push(candidate);
    },
    now: () => occurredAt,
  });

  await assert.rejects(
    consumeEvents(
      bus,
      { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
      createMemoryAnalysisEventHandler({
        binding,
        admission: { admit: async () => { throw new Error('unused'); } },
      }),
      driver,
    ),
    /feedback journal unavailable/,
  );
  assert.equal(journal.receipts.size, 0);
  assert.equal([...journal.externalOperations.values()][0]?.state, 'pending');

  failPublication = false;
  const recovered = await consumeEvents(
    bus,
    { consumerKey: binding.bindingRef, limit: 10, now: occurredAt },
    createMemoryAnalysisEventHandler({
      binding,
      admission: { admit: async () => { throw new Error('unused'); } },
    }),
    driver,
  );
  assert.equal(published.length, 1);
  assert.equal(
    published[0]?.messageId,
    `memory-feedback-${createHash('sha256')
      .update(`${streamId.length}:${streamId}${event().messageId.length}:${event().messageId}`)
      .digest('hex')}`,
  );
  assert.equal(published[0]?.occurredAt, occurredAt);
  assert.equal(published[0]?.streamId, `memory-feedback:${task.value}`);
  assert.equal(published[0]?.kind, MEMORY_CANDIDATE_REVIEW_REQUIRED_KIND);
  assert.equal(recovered.committed[0]?.disposition, 'applied');
  assert.equal([...journal.externalOperations.values()][0]?.state, 'reconciled');
});

test('consumer errors remain explicit for an unregistered memory consumer', async () => {
  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.consumers.clear();
  await assert.rejects(
    consumeEvents(ports(journal, registry), { consumerKey: binding.bindingRef, limit: 1 }, async () => ({
      consumerKey: binding.bindingRef,
      messageId: 'unused',
      disposition: 'applied',
      completionMode: 'journal-atomic',
      internalEffectFacts: [],
      externalOperationRefs: [],
    })),
    EventConsumerError,
  );
});

test('task-bound memory analysis keeps the admitted task identity and rejects cross-task events', async () => {
  const record: EventRecord = {
    ...event(),
    publisherId: publisher.publisherId,
    sequence: 1,
    committedAt: occurredAt,
  };
  const admitted = await memoryTaskAnalysisRequestFromEvent(record, taskBinding);
  assert.equal(admitted.status, 'ready');
  if (admitted.status !== 'ready') throw new Error('expected task-bound request');
  assert.equal(admitted.value.taskId?.value, task.value);
  assert.equal(admitted.value.interactionScopeId, undefined);
  assert.equal(admitted.value.bindingRef, taskBinding.bindingRef);
  assert.equal(admitted.value.sessionRef, undefined);

  const otherTask = id('task', 'task-b');
  const otherScope: ScopeRef = { organId: organ, taskId: otherTask };
  const crossTask = await memoryTaskAnalysisRequestFromEvent({
    ...record,
    scope: otherScope,
    evidenceRefs: [{ ...record.evidenceRefs[0]!, scope: otherScope }],
  }, taskBinding);
  assert.equal(crossTask.status, 'attention');
  if (crossTask.status !== 'attention') throw new Error('expected cross-task rejection');
  assert.equal(crossTask.issue.code, 'memory-agent-event-scope-mismatch');

  const journal = new FakeJournal();
  const registry = new FakeRegistry();
  registry.consumers.set(taskBinding.bindingRef, {
    consumerKey: taskBinding.bindingRef,
    consumerOwner: 'memory-agent',
    scopeRef: `memory:project-a:${organ.value}:${task.value}`,
    contractVersion: 'memory-analysis-v1',
    scope: { organId: organ, taskId: task },
    streamIds: [`memory-boundaries:task:${task.value}`],
    allowedClasses: ['data'],
    retryLimit: 3,
    currentEpoch: 2,
  });
  await publishEvent(ports(journal, registry), {
    publisherId: publisher.publisherId,
    event: event({ streamId: `memory-boundaries:task:${task.value}` }),
  });
  const result = await consumeEvents(
    ports(journal, registry),
    { consumerKey: taskBinding.bindingRef, limit: 10, now: occurredAt },
    createMemoryTaskAnalysisEventHandler({
      binding: taskBinding,
      admission: {
        admit: async ({ request }) => {
          assert.equal(request.taskId?.value, task.value);
          return { status: 'ready', value: { admissionRef: `memory-task:${task.value}` } };
        },
      },
      now: () => occurredAt,
    }),
  );
  assert.equal(result.committed.length, 1);
  assert.equal(result.committed[0]?.disposition, 'applied');
});
