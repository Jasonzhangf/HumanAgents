import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumeEvents,
  publishEvent,
  type EventBusPorts,
  type EventConsumerBinding,
  type ConsumerCommitRequest,
  type TrustedEventPublisher,
} from '../../packages/runtime/src/events/index.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import { id, type EvidenceRef, type ScopeRef } from '../../packages/contracts/src/index.js';
import { UiRuntimeJournal } from '../../packages/app/src/ui-runtime/journal.js';
import type { RuntimeTaskEvent } from '../../packages/runtime/src/ui-runtime/coordinator.js';

const occurredAt = '2026-09-17T00:00:00.000Z';
type RuntimeTaskEventWithFacets = RuntimeTaskEvent & {
  readonly externalResponseId?: string;
  readonly responseModel?: string;
  readonly outputRefs?: readonly string[];
};
const scope: ScopeRef = {
  organId: id('organ', 'organ-a'),
  taskId: id('task', 'task-a'),
};
const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'checkpoint-a'),
  kind: 'operation',
  source: 'test',
  locator: 'journal://project-a/checkpoint-a',
  digest: 'sha256:checkpoint-a',
  scope,
};
const publisher: TrustedEventPublisher = {
  publisherId: 'publisher-harness',
  kind: 'harness',
  ownerId: 'runtime-owner',
  scope,
  allowedClasses: ['data'],
  capabilities: [],
};
const consumer: EventConsumerBinding = {
  consumerKey: 'memory-binding:task-a',
  consumerOwner: 'memory-agent',
  scopeRef: 'scope:organ-a/task-a',
  contractVersion: 'memory-analysis-v1',
  scope,
  streamIds: ['memory-boundaries'],
  allowedClasses: ['data'],
  retryLimit: 2,
  currentEpoch: 1,
};

function event(messageId: string) {
  return {
    messageId,
    streamId: 'memory-boundaries',
    kind: 'memory.analysis.requested',
    class: 'data' as const,
    scope,
    occurredAt,
    summary: 'checkpoint completed',
    payload: { trigger: 'completion' },
    evidenceRefs: [evidence],
    executionEpoch: 1,
  };
}

const childCode = [
  "const url = process.argv[1];",
  "const file = process.argv[2];",
  "const messageId = process.argv[3];",
  "const scope = JSON.parse(process.argv[4]);",
  "const { createJsonlEventJournal } = await import(url);",
  "const journal = createJsonlEventJournal({ filePath: file });",
  "await journal.appendEvent({ publisherId: 'publisher-harness', event: { messageId, streamId: 'memory-boundaries', kind: 'memory.analysis.requested', class: 'data', scope, occurredAt: '2026-09-17T00:00:00.000Z', summary: 'checkpoint completed', payload: { trigger: 'completion' }, evidenceRefs: [{ evidenceId: { scope: 'evidence', value: 'checkpoint-a' }, kind: 'operation', source: 'test', locator: 'journal://project-a/checkpoint-a', digest: 'sha256:checkpoint-a', scope }], executionEpoch: 1 } });",
].join('\n');

function appendInChild(url: string, file: string, messageId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, url, file, messageId, JSON.stringify(scope)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `child exited with ${code ?? 'unknown status'}`));
    });
  });
}

function registry(journal: ReturnType<typeof createJsonlEventJournal>) {
  return {
    resolvePublisher: async (publisherId: string) => publisherId === publisher.publisherId ? publisher : null,
    resolveConsumer: async (consumerKey: string) => consumerKey === consumer.consumerKey ? consumer : null,
    journal,
  };
}

function ports(journal: ReturnType<typeof createJsonlEventJournal>): EventBusPorts {
  return {
    journal,
    publishers: registry(journal),
    consumers: registry(journal),
    externalOperations: journal,
    barrierIntents: journal,
  };
}

function uiRuntimeRecords(input: {
  readonly taskId: ReturnType<typeof id<'task'>>;
  readonly operationId: ReturnType<typeof id<'operation'>>;
  readonly executionEpoch?: number;
  readonly eventId?: string;
  readonly outputRefs?: readonly string[];
  readonly externalResponseId?: string;
}) {
  const cycleId = id('cycle', `cycle-${input.operationId.value}`);
  const executionEpoch = input.executionEpoch ?? 1;
  return {
    started: {
      kind: 'operation.started' as const,
      operationId: input.operationId,
      taskId: input.taskId,
      cycleId,
      scope: { organId: scope.organId, taskId: input.taskId, cycleId, operationId: input.operationId },
      executionEpoch,
      operationCounter: 1,
      cycleCounter: 1,
      startedAt: occurredAt,
      input: 'ui runtime facet',
    },
    event: {
      kind: 'operation.event' as const,
      operationId: input.operationId,
      event: {
        eventId: input.eventId ?? `${input.operationId.value}-1`,
        seq: 1,
        occurredAt: occurredAt,
        taskId: input.taskId,
        operationId: input.operationId.value,
        executionEpoch,
        kind: 'provider.output' as const,
        state: 'output',
        summary: 'provider output',
        evidenceRefs: [],
        ...(input.outputRefs === undefined ? {} : { outputRefs: input.outputRefs }),
        ...(input.externalResponseId === undefined ? {} : { externalResponseId: input.externalResponseId }),
      } as RuntimeTaskEventWithFacets,
    },
  };
}

test('jsonl event journal persists publish, consume receipt and cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const bus = ports(journal);
    const published = await publishEvent(bus, { publisherId: publisher.publisherId, event: event('message-a') });
    assert.equal(published.event.sequence, 1);

    const result = await consumeEvents(
      bus,
      { consumerKey: consumer.consumerKey, limit: 10, now: occurredAt },
      async ({ event: delivered }) => ({
        consumerKey: consumer.consumerKey,
        messageId: delivered.messageId,
        disposition: 'applied',
        completionMode: 'journal-atomic',
        internalEffectFacts: ['effect-a'],
        externalOperationRefs: [],
      }),
    );
    assert.equal(result.committed.length, 1);
    assert.equal(result.committed[0]?.effectRefs[0], 'effect-a');
    assert.equal((await journal.readCursor({
      streamId: 'memory-boundaries',
      consumerKey: consumer.consumerKey,
    }))?.lastHandledSequence, 1);

    const replay = await consumeEvents(
      bus,
      { consumerKey: consumer.consumerKey, limit: 10, now: occurredAt },
      async () => {
        throw new Error('must not redeliver');
      },
    );
    assert.equal(replay.committed.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal serializes consumer cursor commits without regression', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-cursor-race-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const commit = (messageId: string, lastHandledSequence: number): ConsumerCommitRequest => ({
      receipt: {
        consumerKey: consumer.consumerKey,
        messageId,
        streamId: 'memory-boundaries',
        handledSequence: lastHandledSequence,
        disposition: 'applied',
        effectRefs: [],
      },
      cursor: {
        streamId: 'memory-boundaries',
        consumerKey: consumer.consumerKey,
        lastHandledSequence,
        updatedAt: occurredAt,
      },
      completionMode: 'journal-atomic',
      internalEffectFacts: [],
      externalOperationRefs: [],
    });

    await Promise.all([
      journal.commitConsumerCommit(commit('message-cursor-high', 8)),
      journal.commitConsumerCommit(commit('message-cursor-low', 2)),
    ]);

    assert.equal(
      (await journal.readCursor({
        streamId: 'memory-boundaries',
        consumerKey: consumer.consumerKey,
      }))?.lastHandledSequence,
      8,
    );
    assert.equal(
      (await journal.readReceipt({
        consumerKey: consumer.consumerKey,
        messageId: 'message-cursor-low',
      }))?.handledSequence,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal keeps consumer commit receipt and cursor on the same stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-stream-identity-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const commit = (streamId: string): ConsumerCommitRequest => ({
      receipt: {
        consumerKey: consumer.consumerKey,
        messageId: 'shared-message',
        streamId,
        handledSequence: 1,
        disposition: 'applied',
        effectRefs: [],
      },
      cursor: {
        streamId,
        consumerKey: consumer.consumerKey,
        lastHandledSequence: 1,
        updatedAt: occurredAt,
      },
      completionMode: 'journal-atomic',
      internalEffectFacts: [],
      externalOperationRefs: [],
    });

    await journal.commitConsumerCommit(commit('stream-a'));
    const streamB = await journal.commitConsumerCommit(commit('stream-b'));

    assert.equal(streamB.receipt.streamId, 'stream-b');
    assert.equal(streamB.cursor.streamId, 'stream-b');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal keeps stream sequence independent from control records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-sequence-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const bus = ports(journal);
    const first = (await publishEvent(bus, { publisherId: publisher.publisherId, event: event('message-a') })).event;
    await journal.commitBarrierIntent({
      consumerKey: consumer.consumerKey,
      messageId: first.messageId,
      streamId: first.streamId,
      handledSequence: first.sequence,
      intent: {
        consumerKey: consumer.consumerKey,
        messageId: first.messageId,
        disposition: 'applied',
        completionMode: 'operation-barrier',
        internalEffectFacts: [],
        externalOperationRefs: ['external:message-a'],
      },
    });
    const second = (await publishEvent(bus, { publisherId: publisher.publisherId, event: event('message-b') })).event;
    assert.equal(second.sequence, 2);
    assert.deepEqual(
      (await journal.readEvents({ streamId: 'memory-boundaries', afterSequence: 0, limit: 10 })).map((record) => record.sequence),
      [1, 2],
    );
    assert.deepEqual(
      (await journal.readEvents({ streamId: 'memory-boundaries', afterSequence: 1, limit: 10 })).map((record) => record.messageId),
      ['message-b'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal allocates unique stream sequences under concurrent publishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-concurrent-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const bus = ports(journal);
    const published = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        publishEvent(bus, {
          publisherId: publisher.publisherId,
          event: event(`message-${index}`),
        })),
    );
    assert.deepEqual(
      published.map(({ event: record }) => record.sequence).sort((left, right) => left - right),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      (await journal.readEvents({
        streamId: 'memory-boundaries',
        afterSequence: 0,
        limit: 20,
      })).map((record) => record.sequence),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal allocates unique stream sequences across processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-cross-process-'));
  try {
    const filePath = join(root, 'events.jsonl');
    const journal = createJsonlEventJournal({ filePath });
    const moduleUrl = new URL('../../packages/app/src/event-journal.js', import.meta.url).href;
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      appendInChild(moduleUrl, filePath, `child-message-${index}`)));
    const records = await journal.readEvents({
      streamId: 'memory-boundaries',
      afterSequence: 0,
      limit: 20,
    });
    assert.deepEqual(
      records.map((record) => record.sequence).sort((left, right) => left - right),
      Array.from({ length: 8 }, (_, index) => index + 1),
    );
    assert.equal(new Set(records.map((record) => record.messageId)).size, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal rejects corrupt persisted event history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-corrupt-'));
  try {
    const filePath = join(root, 'events.jsonl');
    const journal = createJsonlEventJournal({ filePath });
    await publishEvent(ports(journal), { publisherId: publisher.publisherId, event: event('message-a') });
    await appendFile(filePath, '{"broken":true}\n');
    await assert.rejects(
      () => journal.readEvents({ streamId: 'memory-boundaries', afterSequence: 0, limit: 10 }),
      (error: unknown) => (error as { readonly code?: string }).code === 'event-journal-corrupt',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal reduces retry obligations to their latest terminal state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-retry-state-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const base = {
      retryKey: 'retry-a',
      consumerKey: consumer.consumerKey,
      messageId: 'message-a',
      streamId: 'memory-boundaries',
      failedSequence: 1,
      attempt: 1,
      nextAttemptAt: occurredAt,
      ownerRef: 'memory-agent',
      failureRef: 'failure-a',
    };
    await journal.commitRetryObligation({ ...base, state: 'pending' });
    await journal.commitRetryObligation({ ...base, attempt: 2, state: 'exhausted' });
    assert.deepEqual(
      await journal.listPendingRetryObligations({
        streamId: 'memory-boundaries',
        consumerKey: consumer.consumerKey,
        limit: 10,
      }),
      [],
    );

    await journal.commitRetryObligation({ ...base, state: 'pending' });
    await journal.commitRetryObligation({ ...base, attempt: 2, state: 'cancelled' });
    assert.deepEqual(
      await journal.listPendingRetryObligations({
        streamId: 'memory-boundaries',
        consumerKey: consumer.consumerKey,
        limit: 10,
      }),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal persists memory agent state as the latest append-only snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-memory-state-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    await journal.appendMemoryAgentState({
      commitId: 'memory-agent-state:first',
      state: { version: 1, analyses: [], followUps: [] },
    });
    await journal.appendMemoryAgentState({
      commitId: 'memory-agent-state:second',
      state: { version: 1, analyses: ['analysis-a'], followUps: ['follow-up-a'] },
    });

    assert.deepEqual(await journal.readMemoryAgentState(), {
      version: 1,
      analyses: ['analysis-a'],
      followUps: ['follow-up-a'],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal validates external operation transitions atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-external-operation-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const base = {
      consumerKey: consumer.consumerKey,
      messageId: 'message-a',
      ownerRef: 'memory-agent',
      createdAt: occurredAt,
    };
    for (const state of ['reconciled', 'failed', 'unknown'] as const) {
      await assert.rejects(
        () => journal.commitExternalOperation({ ...base, operationRef: `external:fresh-${state}`, state }),
        (error: unknown) => (error as { readonly code?: string }).code === 'event-journal-conflict',
      );
    }
    await journal.commitExternalOperation({ ...base, operationRef: 'external:invalid', state: 'pending' });
    await assert.rejects(
      () => journal.commitExternalOperation({ ...base, operationRef: 'external:invalid', state: 'reconciled' }),
      (error: unknown) => (error as { readonly code?: string }).code === 'event-journal-conflict',
    );
    const settled = await journal.commitExternalOperation({ ...base, operationRef: 'external:valid', state: 'settled' });
    assert.equal(settled.state, 'settled');
    assert.equal(
      (await journal.commitExternalOperation({ ...base, operationRef: 'external:valid', state: 'reconciled' })).state,
      'reconciled',
    );
    await journal.commitExternalOperation({ ...base, operationRef: 'external:unknown', state: 'pending' });
    await journal.commitExternalOperation({ ...base, operationRef: 'external:unknown', state: 'unknown' });
    assert.equal(
      (await journal.commitExternalOperation({ ...base, operationRef: 'external:unknown', state: 'reconciled' })).state,
      'reconciled',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal serializes conflicting external operation outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-external-operation-race-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const base = {
      consumerKey: consumer.consumerKey,
      messageId: 'message-a',
      ownerRef: 'memory-agent',
      createdAt: occurredAt,
      operationRef: 'external:race',
    };
    await journal.commitExternalOperation({ ...base, state: 'pending' });
    const outcomes = await Promise.allSettled([
      journal.commitExternalOperation({ ...base, state: 'settled' }),
      journal.commitExternalOperation({ ...base, state: 'unknown' }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const committed = await journal.readExternalOperation({
      operationRef: base.operationRef,
      consumerKey: base.consumerKey,
      messageId: base.messageId,
    });
    assert.equal(committed?.state, outcomes.find((outcome) => outcome.status === 'fulfilled')?.value.state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal reads external operations by complete consumer identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-external-operation-identity-'));
  try {
    const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
    const operation = {
      operationRef: 'external:identity',
      consumerKey: consumer.consumerKey,
      messageId: 'message-a',
      state: 'settled' as const,
    };
    await journal.commitExternalOperation(operation);

    assert.deepEqual(await journal.readExternalOperation(operation), operation);
    assert.equal(await journal.readExternalOperation({
      ...operation,
      consumerKey: 'memory-binding:task-b',
    }), null);
    assert.equal(await journal.readExternalOperation({
      ...operation,
      messageId: 'message-b',
    }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl event journal rejects corrupt memory agent state history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-event-journal-memory-state-corrupt-'));
  try {
    const filePath = join(root, 'events.jsonl');
    const journal = createJsonlEventJournal({ filePath });
    await appendFile(filePath, '{"broken":true}\n');
    await assert.rejects(
      () => journal.readMemoryAgentState(),
      (error: unknown) => (error as { readonly code?: string }).code === 'event-journal-corrupt',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UI runtime journal append and replay fail closed for a malformed present execution fact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-runtime-fact-integrity-'));
  try {
    const taskId = id('task', 'task-fact-integrity');
    const operationId = id('operation', 'operation-fact-integrity');
    const cycleId = id('cycle', 'cycle-fact-integrity');
    const filePath = join(root, 'ui-runtime-journal.jsonl');
    const evidenceRef = {
      evidenceId: id('evidence', 'evidence-fact-integrity'),
      kind: 'operation',
      source: 'test',
      locator: 'journal://fact-integrity',
      scope: { organId: id('organ', 'organ-fact-integrity'), taskId },
    };
    const started = {
      kind: 'operation.started',
      operationId,
      taskId,
      cycleId,
      scope: { organId: id('organ', 'organ-fact-integrity'), taskId, cycleId, operationId },
      executionEpoch: 1,
      operationCounter: 1,
      cycleCounter: 1,
      startedAt: occurredAt,
      input: 'fact integrity',
    } as const;
    const malformedEvent = {
      kind: 'operation.event',
      operationId,
      event: {
        eventId: 'event-fact-integrity',
        seq: 1,
        occurredAt,
        taskId,
        operationId: operationId.value,
        executionEpoch: 1,
        kind: 'provider.tool-result',
        state: 'tool',
        summary: 'file.search succeeded',
        evidenceRefs: [evidenceRef],
        requestId: 'request-fact-integrity',
        callId: 'call-fact-integrity',
        toolId: 'file.search',
        status: 'succeeded',
        outputRef: 'asset://provider-tool/output/fact-integrity',
        outputDigest: `sha256:${'a'.repeat(64)}`,
        executionFact: {
          identity: { surface: 'responses', toolId: 'file.search', bindingRef: 'binding-fact-integrity', route: 'app.file-search.local' },
          requestRef: 'request-fact-integrity',
          callRef: 'call-fact-integrity',
          operationRef: operationId.value,
          state: 'succeeded',
          rawEvidenceRefs: 'not-array',
          resultRef: 'asset://provider-tool/output/fact-integrity',
          resultDigest: `sha256:${'a'.repeat(64)}`,
        },
      },
    } as const;
    await appendFile(filePath, `${[
      JSON.stringify(started),
      JSON.stringify(malformedEvent),
    ].join('\n')}\n`, 'utf8');

    assert.throws(
      () => new UiRuntimeJournal(filePath).replay(),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'tool.execution-fact.integrity',
    );

    const appendPath = join(root, 'ui-runtime-journal-append.jsonl');
    const journal = new UiRuntimeJournal(appendPath);
    journal.append(started);
    const beforeAppend = await readFile(appendPath);
    assert.throws(
      () => journal.append(malformedEvent as unknown as Parameters<UiRuntimeJournal['append']>[0]),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'tool.execution-fact.integrity',
    );
    assert.deepEqual(await readFile(appendPath), beforeAppend);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UI runtime journal persists provider facets and plural output refs and keeps absent facets absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-runtime-facets-'));
  try {
    const taskId = id('task', 'task-runtime-facets');
    const operationId = id('operation', 'operation-runtime-facets');
    const records = uiRuntimeRecords({ taskId, operationId });
    const filePath = join(root, 'ui-runtime-journal.jsonl');
    const journal = new UiRuntimeJournal(filePath);
    journal.append(records.started);
    journal.append({
      ...records.event,
      event: {
        ...records.event.event,
        externalResponseId: 'response-runtime-facets',
        responseModel: 'model-runtime-facets',
        outputRefs: ['asset://provider-tool/output/second', 'asset://provider-tool/output/first'],
      } as RuntimeTaskEventWithFacets,
    });

    const restored = new UiRuntimeJournal(filePath).replay();
    const persisted = restored.find((record): record is Extract<typeof record, { readonly kind: 'operation.event' }> => (
      record.kind === 'operation.event' && record.operationId.value === operationId.value
    ));
    const persistedEvent = persisted?.event as RuntimeTaskEventWithFacets | undefined;
    assert.equal(persistedEvent?.externalResponseId, 'response-runtime-facets');
    assert.equal(persistedEvent?.responseModel, 'model-runtime-facets');
    assert.deepEqual(persistedEvent?.outputRefs, ['asset://provider-tool/output/second', 'asset://provider-tool/output/first']);

    const oldTaskId = id('task', 'task-runtime-facets-old');
    const oldOperationId = id('operation', 'operation-runtime-facets-old');
    const oldRecords = uiRuntimeRecords({ taskId: oldTaskId, operationId: oldOperationId });
    journal.append(oldRecords.started);
    journal.append(oldRecords.event);
    const oldReplay = new UiRuntimeJournal(filePath).replay();
    const oldPersisted = oldReplay.find((record) => (
      record.kind === 'operation.event' && record.operationId.value === oldOperationId.value
    ));
    const oldPersistedEvent = oldPersisted?.kind === 'operation.event' ? oldPersisted.event as RuntimeTaskEventWithFacets : undefined;
    assert.equal(oldPersistedEvent?.externalResponseId, undefined);
    assert.equal(oldPersistedEvent?.responseModel, undefined);
    assert.equal(oldPersistedEvent?.outputRefs, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UI runtime journal makes exact duplicate append and replay idempotent and rejects content conflicts atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-runtime-duplicate-'));
  try {
    const taskId = id('task', 'task-runtime-duplicate');
    const operationId = id('operation', 'operation-runtime-duplicate');
    const records = uiRuntimeRecords({ taskId, operationId });
    const filePath = join(root, 'ui-runtime-journal.jsonl');
    const journal = new UiRuntimeJournal(filePath);
    journal.append(records.started);
    journal.append(records.event);
    journal.append(records.event);

    const fileLines = (await readFile(filePath, 'utf8')).split('\n').filter((line) => line.trim().length > 0);
    assert.equal(fileLines.length, 2);
    assert.deepEqual(
      new UiRuntimeJournal(filePath).replay().filter((record) => record.kind === 'operation.event'),
      [records.event],
    );

    const beforeConflict = await readFile(filePath, 'utf8');
    assert.throws(
      () => journal.append({ ...records.event, event: { ...records.event.event, summary: 'different output' } }),
      /conflict/i,
    );
    assert.equal(await readFile(filePath, 'utf8'), beforeConflict);

    const handwritten = join(root, 'handwritten.jsonl');
    await appendFile(handwritten, `${[
      JSON.stringify(records.started),
      JSON.stringify(records.event),
      JSON.stringify(records.event),
    ].join('\n')}\n`, 'utf8');
    assert.deepEqual(
      new UiRuntimeJournal(handwritten).replay().filter((record) => record.kind === 'operation.event'),
      [records.event],
    );

    const handwrittenConflict = join(root, 'handwritten-conflict.jsonl');
    await appendFile(handwrittenConflict, `${[
      JSON.stringify(records.started),
      JSON.stringify(records.event),
      JSON.stringify({ ...records.event, event: { ...records.event.event, summary: 'different output' } }),
    ].join('\n')}\n`, 'utf8');
    assert.throws(
      () => new UiRuntimeJournal(handwrittenConflict).replay(),
      /conflict/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UI runtime journal rejects fact-absent identity mismatches and standalone events on append and replay without writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-runtime-fact-absent-'));
  try {
    const taskId = id('task', 'task-runtime-fact-absent');
    const operationId = id('operation', 'operation-runtime-fact-absent');
    const records = uiRuntimeRecords({ taskId, operationId });
    const cases = [
      { label: 'task', event: { ...records.event.event, taskId: id('task', 'task-runtime-fact-absent-other') } },
      { label: 'operation', event: { ...records.event.event, operationId: 'operation-runtime-fact-absent-other' } },
      { label: 'epoch', event: { ...records.event.event, executionEpoch: 2 } },
    ] as const;

    for (const item of cases) {
      const filePath = join(root, `mismatch-${item.label}.jsonl`);
      const journal = new UiRuntimeJournal(filePath);
      journal.append(records.started);
      const before = await readFile(filePath, 'utf8');
      assert.throws(
        () => journal.append({ ...records.event, event: item.event }),
        /corrupt UI runtime journal|identity/i,
      );
      assert.equal(await readFile(filePath, 'utf8'), before);

      const replayPath = join(root, `replay-${item.label}.jsonl`);
      await appendFile(replayPath, `${[
        JSON.stringify(records.started),
        JSON.stringify({ ...records.event, event: item.event }),
      ].join('\n')}\n`, 'utf8');
      assert.throws(
        () => new UiRuntimeJournal(replayPath).replay(),
        /corrupt UI runtime journal|identity/i,
      );
    }

    const standalonePath = join(root, 'standalone.jsonl');
    const standaloneJournal = new UiRuntimeJournal(standalonePath);
    assert.throws(
      () => standaloneJournal.append(records.event),
      /references unknown operation/i,
    );
    await assert.rejects(
      async () => readFile(standalonePath, 'utf8'),
      (error: unknown) => (error as { readonly code?: string }).code === 'ENOENT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UI runtime journal rejects malformed facets and refs atomically and treats an empty outputRefs array as legal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-runtime-malformed-facets-'));
  try {
    const taskId = id('task', 'task-runtime-malformed-facets');
    const operationId = id('operation', 'operation-runtime-malformed-facets');
    const records = uiRuntimeRecords({ taskId, operationId });
    const filePath = join(root, 'ui-runtime-journal.jsonl');
    const journal = new UiRuntimeJournal(filePath);
    journal.append(records.started);

    const invalidCases = [
      { ...records.event, event: { ...records.event.event, outputRefs: [''] } as RuntimeTaskEventWithFacets },
      { ...records.event, event: { ...records.event.event, externalResponseId: '' } as RuntimeTaskEventWithFacets },
      { ...records.event, event: { ...records.event.event, responseModel: ' ' } as RuntimeTaskEventWithFacets },
      { ...records.event, event: { ...records.event.event, outputRefs: ['asset://ok', ''] } as RuntimeTaskEventWithFacets },
    ];
    for (const candidate of invalidCases) {
      const before = await readFile(filePath, 'utf8');
      assert.throws(
        () => journal.append(candidate),
        /corrupt UI runtime journal|non-empty string|non-empty string/i,
      );
      assert.equal(await readFile(filePath, 'utf8'), before);
    }

    journal.append({ ...records.event, event: { ...records.event.event, outputRefs: [] } as RuntimeTaskEventWithFacets });
    const replay = new UiRuntimeJournal(filePath).replay();
    const persisted = replay.filter((record): record is Extract<typeof record, { readonly kind: 'operation.event' }> => (
      record.kind === 'operation.event'
    )).at(-1);
    assert.deepEqual((persisted?.event as RuntimeTaskEventWithFacets | undefined)?.outputRefs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
