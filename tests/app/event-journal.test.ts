import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
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

const occurredAt = '2026-09-17T00:00:00.000Z';
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
